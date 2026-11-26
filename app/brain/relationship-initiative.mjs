import {choseQuiet, initiativePrompt, initiativeReply, requiredReminder} from './initiative-language.mjs';
import {detectedSpeechLanguage, explicitSpokenLanguage} from './utterance-language.mjs';
import {selectLocalDelivery} from './voice/local-delivery.mjs';

function targetLanguage(body, history) {
  if (body.call_language === 'ja' || body.call_language === 'zh') return body.call_language;
  const explicit = explicitSpokenLanguage('', history);
  if (explicit === 'zh' || explicit === 'ja') return explicit;
  const previous = history.findLast(row => row.role === 'assistant' && row.text);
  const language = previous?.language || detectedSpeechLanguage((previous?.text || '').split('\n【中文译文】',1)[0]);
  return language === 'zh' ? 'zh' : 'ja';
}

const identity = claim => ({id:claim.id, token:claim.token});
const read = (value, claim) => typeof value === 'function' ? value(claim) : value;
const emptyPoll = () => ({ok:true,claim:null});

/**
 * The SDK history store owns the outgoing message. Its synchronous lookup and
 * append use the claim ID across restarts. SQLite owns draft and acknowledgement.
 * The independent model call sees no tools and has no conversation write access.
 */
export async function initiativeDispatch({
  action, body, store, scheduler, session, busy = false, complete, persona = '', history = [], signal,
}) {
  if (body?.relationship_id !== scheduler.relation)
    return {ok:false,code:'RELATIONSHIP_CHANGED',error:'关系档已切换'};
  const available = () => !signal?.aborted && !(typeof busy === 'function' ? busy() : busy);
  if (action === 'ack') {
    const acknowledged = typeof body.id === 'string' && typeof body.token === 'string' &&
      scheduler.settle(body.id,{token:body.token,status:'delivered'});
    // An erased or already acknowledged local item has nothing left to replay.
    return {ok:true,acknowledged};
  }
  if (action === 'deliver') {
    if (!available() || typeof body.id !== 'string' || typeof body.token !== 'string') return {ok:true,item:null};
    const claim = scheduler.getClaim(body.id,body.token);
    if (!claim?.draft || !['ready','published'].includes(claim.status)) return {ok:true,item:null};
    // Do not yield here. A user turn, deletion or reschedule can revoke a
    // candidate before publication. The lookup also recovers a crash after
    // the SDK append and before the SQLite mark.
    const known = store.initiativeItem(session,claim);
    if (!known && body.call_language && claim.draft.language !== body.call_language) {
      // The user switched to a different call language while generation was
      // in flight. No public message exists yet. Wake the same opportunity
      // again with the current route and fence its obsolete draft.
      scheduler.releaseDraft(claim.id,claim.token);
      return {ok:true,item:null};
    }
    if (!scheduler.getClaim(claim.id,claim.token)) return {ok:true,item:null};
    const item = known || store.addInitiative(session,claim,claim.draft,{call_id:body.call_id ?? null});
    if (!item || typeof item.then === 'function') throw Error('主动来信缺少同步消息收据');
    const published = scheduler.markPublished(claim.id,claim.token);
    if (!published) throw Error('主动来信的投递状态已改变');
    const behavior = item.behavior ?? claim.draft;
    const voiceTag = behavior.language === 'ja' ? selectLocalDelivery(behavior.speech,[]).tag : null;
    return {ok:true,item:{...item,...identity(claim),groupId:Object.hasOwn(item,'groupId') ? item.groupId : claim.groupId,behavior,voice_tag:voiceTag}};
  }
  if (action !== 'poll') return {ok:false,code:'REQUEST_INVALID',error:'不支持的主动联系操作'};
  if (!available()) return emptyPoll();
  const claim = scheduler.claim({remindersOnly:body.reminders_only === true});
  if (!claim) return emptyPoll();
  if (claim.draft) return {ok:true,claim:identity(claim)};
  const retry = () => {
    scheduler.settle(claim.id,{token:claim.token,status:'retry'});
    return emptyPoll();
  };
  let behavior;
  if (claim.kind === 'reminder') {
    // An explicit promise stays usable when there is no configured model
    // connection. Keep the titles in the original language of the agreements.
    behavior = requiredReminder(claim,{language:body.call_language || undefined});
  } else {
    if (typeof complete !== 'function') return retry();
    try {
      const recent = read(history,claim) || [];
      const language = targetLanguage(body,recent);
      const context = initiativePrompt(claim,{persona:read(persona,claim),history:recent,language});
      const answer = await complete(context,signal);
      if (signal?.aborted) return retry();
      if (choseQuiet(answer)) {
        scheduler.settle(claim.id,{token:claim.token,status:'quiet'});
        return emptyPoll();
      }
      behavior = initiativeReply(answer,{language});
      if (!behavior) return retry();
    } catch { return retry(); }
  }
  const saved = scheduler.setDraft(claim.id,claim.token,behavior);
  return saved && available() ? {ok:true,claim:identity(saved)} : emptyPoll();
}
