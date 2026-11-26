import {createHash, randomUUID} from 'node:crypto';
import {authoredInput} from './file-attachments.mjs';
import {choseQuiet, conversationCues} from './initiative-language.mjs';
import {oneVoicePair,SINGLE_VOICE} from './voice-turn.mjs';
import {selectLocalDelivery} from './voice/local-delivery.mjs';
import {inferenceOptions} from './inference-settings.mjs';
import {applyRequestPayload} from './request-options.mjs';
import {parseObject} from './personality/shin-dev/semantics.mjs';
import {validBriefFollowupPair} from './selected-sentence.mjs';

const spokenModes = new Set(['light','general_fast','general_quality','general_auto']);
const normalized = text => String(text || '').normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{Z}\p{S}\s]/gu,'');
const sentences = new Intl.Segmenter('ja',{granularity:'sentence'});
const copyLine = value => ({speech:value.speech,translation:value.translation || '',language:value.language});
const sameLine = (a,b) => a?.speech === b?.speech && a?.translation === (b?.translation || '') && a?.language === b?.language;
const deferOnePass = () => new Promise(resolve => setImmediate(resolve));
const providerCodes = /\b(?:invalid_request_error|invalid_api_key|authentication_error|rate_limit_exceeded|insufficient_quota|server_error|api_error|context_length_exceeded)\b/iu;

// Both primary expression routes use the active connection. Light applies a
// context-window override; General's general_reply overrides generation options.
export function followupCompletionFor({activeModel,mode,config,defaultReasoning,complete,fetcher=globalThis.fetch}) {
  const light=mode==='light'||mode==null;
  const settings=light?config.light:config.general_reply;
  const model=light&&settings.context_window
    ? {...activeModel,contextWindow:Math.min(activeModel.contextWindow,settings.context_window)} : {...activeModel};
  const samplingModel=!light&&model.compat?.thinkingFormat==='deepseek'?{...model,provider:'deepseek'}:model;
  const limit=Math.min(settings.max_tokens||1024,model.maxTokens||1024,1024);
  const sampling=inferenceOptions({...settings,max_tokens:limit,timeout_seconds:settings.timeout_seconds||30},samplingModel,{defaultReasoning});
  const requestPolicy={...config.request,web_search:false};
  return (context,signal,onWire)=>complete(model,context,{...sampling,signal,maxRetries:0,
    onPayload:payload=>applyRequestPayload(sampling.onPayload?sampling.onPayload(payload):payload,model,
      {options:requestPolicy,jsonOutput:true,allowSearch:false}),
    fetch:async(input,init)=>{signal.throwIfAborted();onWire();const res=await fetcher(input,init);onWire(res.status);return res;}});
}

// UUID-format identity for the existing SDK / replay route. Request IDs in
// the normal client are random; a retry of the same parent has the same draw.
export function followupIdentity(relationship, requestId) {
  const digest = createHash('sha256').update(JSON.stringify(['feiniao.followup/1',relationship,requestId])).digest();
  digest[6] = (digest[6] & 15) | 80;
  digest[8] = (digest[8] & 63) | 128;
  const hex = digest.toString('hex',0,16);
  return {id:[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-'),
    draw:digest.readUInt32BE(16)/2**32};
}

export function publishedFollowupParent(relationship, message) {
  const marker=message?.asukaInitiative;
  if (message?.role!=='assistant' || message.stopReason!=='stop' || marker?.kind!=='immediate' ||
      typeof marker.parent_request_id!=='string' || !/^[A-Za-z0-9._-]{1,96}$/.test(marker.parent_request_id)) return null;
  const id=followupIdentity(relationship,marker.parent_request_id).id;
  return marker.id===id && marker.request_id==='initiative:'+id ? marker.parent_request_id : null;
}

const leaveSpace = /(?:只(?:说|要|用|回)一(?:句|个字)|不要补充|不用补充|别(?:再)?补充|(?:等|等到)我(?:先)?(?:开口|说(?:完|话)?|回答|回复|想好)(?:了)?再(?:说|聊|继续)|(?:让我|我先)(?:先)?(?:想想|想一想|想一下|思考一下|消化一下)|先别(?:说|接话|往下说)|一言だけ|一文だけ|考えさせて|話すまで待って|返事するまで待って|just one sentence|let me think|wait (?:until|till) I (?:speak|reply|answer))/iu;

function measured(cue, field) {
  const item = cue?.components?.[field];
  return item?.known === true && Number.isFinite(item.value) && item.value >= 0 && item.value <= 1 ? item.value : null;
}

function chance(user, first, cue) {
  const cues = conversationCues(user,first);
  if (cues.quiet || cues.farewell) return 0;
  let p = 0.42;
  if (cues.expressedInterest) p += 0.14;
  if (cues.openQuestion) p -= 0.10; // The first line already left space for an answer.
  const share = measured(cue,'observed_share_drive'), guard = measured(cue,'observed_guard');
  if (share !== null) p += (share-0.5)*0.30;
  if (guard !== null) p -= 0.10*guard;
  return Math.max(0,Math.min(0.72,p));
}

function repeats(first, second) {
  for (const key of ['speech','translation']) {
    const a = normalized(first[key]), b = normalized(second[key]);
    if (!a || !b) continue;
    if (a === b) return true;
    if(Array.from(sentences.segment(second[key]),part=>normalized(part.segment)).includes(a))return true;
    const [short,long] = a.length < b.length ? [a,b] : [b,a];
    if (short.length >= 6 && long.includes(short) && long.length-short.length <= 2) return true;
  }
  return false;
}

function spokenDraft(response,language) {
  let value;
  try{value=parseObject(response.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'));}
  catch{return null;}
  if(value?.send!==true || value.language!==language || typeof value.speech!=='string')return null;
  const speech=value.speech,translation=value.translation??'';
  if(!validBriefFollowupPair(speech,translation,language))return null;
  return {speech,translation,language,parts:[{speech,translation}],initiative:true};
}

function prompt(slot) {
  const language = slot.first.language;
  const format = language === 'ja' ? 'speech 写简短的自然日语，translation 写整段对应的简体中文。'
    : language === 'en' ? 'speech 写简短自然的英语，translation 写整段对应的简体中文。' : 'speech 写简短自然的中文，translation 留空。';
  return {
    systemPrompt:slot.persona + '\n输出一个 JSON 对象。你刚说出了 first_sentence，用户还没有新的发言。听听你自己刚说的这句话：' +
      '如果当下还真有另一个意思想顺口接着说，就用一行自然短口语补上，最多两个短句。信息已经说够、在等对方回应、或只能换个说法重复时，可返回 {"send":false}。' +
      '保持当前人物和实际对话的指代与语气，不代替对方接话。决定补话时只返回 {"send":true,"speech":"第二句","translation":"译文","language":"' +
      language + '"}。' + format,
    messages:[{role:'user',timestamp:0,content:JSON.stringify({
      origin:'local_followup',new_user_message:null,earlier_dialogue:slot.history,
      topic_group:slot.groupTitle,current_user:slot.user,first_sentence:slot.first,
    })}],tools:[],
  };
}

export class ImmediateFollowups {
  constructor(store,{clock=Date.now,windowMs=30000,draw=null,onFailure=()=>{}}={}) {
    this.store = store;
    this.clock = clock;
    this.windowMs = windowMs;
    this.draw = draw;
    this.onFailure = onFailure;
    this.current = null;
  }

  // Fresh /ask only. Do the first screening while the primary is still queued.
  begin({body,origin,history,persona,complete,signal}) {
    this.cancel();
    const spoken=body.voice_enabled===true || (body.voice_enabled==null && (body.personality_mode??'light')==='light' && body.voice_turn===SINGLE_VOICE);
    if (body.immediate_followup !== true || !spoken || body.manual_retry || !spokenModes.has(body.personality_mode ?? 'light') ||
        body.session_id !== this.store.id || !body.request_id || !complete || signal?.aborted) return null;
    const user = authoredInput(body.message).trim();
    const cues = conversationCues(user,'');
    const identity = followupIdentity(this.store.id,body.request_id);
    const draw = this.draw ? this.draw() : identity.draw;
    if (!user || cues.quiet || cues.farewell || leaveSpace.test(user) || draw >= 0.72) return null;
    const decisionAt = this.clock();
    const slot = {
      id:identity.id,token:randomUUID(),parent:body.request_id,group:origin.group_id ?? null,call:origin.call_id ?? null,
      groupTitle:origin.group_title ?? null,draw,user:user.slice(0,3000),history:history().slice(-6).map(row =>
        ({role:row.role,text:(row.role==='user'?authoredInput(row.text):String(row.text ?? '')).slice(0,900)})),persona:persona(),complete,
      state:'admitted',controller:new AbortController(),timing:{decision_started_at:decisionAt},
    };
    this.current = slot;
    if (signal) {
      const stop = () => this.cancel(slot);
      signal.addEventListener('abort',stop,{once:true});
      slot.unbind = () => signal.removeEventListener('abort',stop);
    }
    return slot;
  }

  useCue(requestId, cue) {
    if (this.current?.parent === requestId && this.current.state === 'admitted') this.current.cue = cue;
  }

  cancel(slot=this.current) {
    if (!slot || slot !== this.current) return false;
    this.current = null;
    if (slot.timer) clearTimeout(slot.timer);
    slot.unbind?.();
    slot.controller.abort();
    return true;
  }

  #quiet(slot,outcome,error=null) {
    if(this.current!==slot)return;
    const reason={outcome};
    if(slot.httpStatus)reason.http_status=slot.httpStatus;
    const code=String(error?.code||error?.errorMessage||error?.message||'').match(providerCodes)?.[0];
    if(code)reason.provider_code=code.toLowerCase();
    slot.state='quiet';slot.diagnostic=reason;slot.timing.finished_at=this.clock();
    if(!['model_quiet','repeated_first'].includes(outcome))this.onFailure(reason);
  }

  // Invoked on the earliest stable spoken pair. This never waits for tokens.
  start(slot, behavior) {
    if (!slot || slot !== this.current || slot.state !== 'admitted') return;
    if (!behavior?.speech || behavior.silence || behavior.voice_error || behavior.degraded_continuity ||
        !['zh','ja','en'].includes(behavior.language) || !oneVoicePair(behavior,behavior.language,'natural') ||
        slot.draw >= chance(slot.user,behavior.speech,slot.cue)) { this.cancel(slot); return; }
    slot.first = copyLine(behavior);
    slot.state = 'pending';
    slot.timing.generation_started_at = this.clock();
    const sent = status => {
      if(this.current!==slot)return;
      if(status===undefined)slot.timing.wire_started_at??=this.clock();
      else if(Number.isInteger(status)&&status>=100&&status<=599)slot.httpStatus=status;
    };
    const finish = response => {
      if (this.current !== slot || slot.controller.signal.aborted) return;
      if(slot.httpStatus>=400||response?.stopReason==='error')return this.#quiet(slot,'provider_error',response);
      if(response?.stopReason!=='stop')return this.#quiet(slot,response?.stopReason==='length'?'truncated_reply':'incomplete_reply');
      if(choseQuiet(response))return this.#quiet(slot,'model_quiet');
      const next = spokenDraft(response,slot.first.language);
      if(!next)return this.#quiet(slot,'invalid_spoken_reply');
      if(repeats(slot.first,next))return this.#quiet(slot,'repeated_first');
      slot.draft = next;
      slot.state = 'ready';
      slot.timing.ready_at = this.clock();
    };
    try {
      Promise.resolve(slot.complete(prompt(slot),slot.controller.signal,sent)).then(finish)
        .catch(error=>this.#quiet(slot,slot.httpStatus>=400?'provider_error':'transport_error',error));
    } catch(error) { this.#quiet(slot,'transport_error',error); }
  }

  // SDK authentication and adapter setup use microtasks. Allow one event-loop
  // pass to enter fetch; never wait for a remote response or slow auth.
  async parentPublished(slot, behavior) {
    if (!slot || slot !== this.current) return null;
    this.start(slot,behavior);
    if (slot !== this.current || !sameLine(slot.first,behavior) || !behavior.playback_id || behavior.voice_error) {
      this.cancel(slot); return null;
    }
    if (!Object.hasOwn(slot.timing,'wire_started_at')) await deferOnePass();
    if (slot !== this.current) return null;
    slot.playback = behavior.playback_id;
    slot.timing.wire_observation_at_parent=Object.hasOwn(slot.timing,'wire_started_at')?'observed':'unknown';
    slot.timing.parent_published_at = this.clock();
    slot.timer = setTimeout(() => this.cancel(slot),this.windowMs);
    slot.timer.unref?.();
    return {id:slot.id,token:slot.token,parent_request_id:slot.parent,group_id:slot.group,call_id:slot.call,timing:{...slot.timing}};
  }

  #valid(slot, body) {
    if (!slot || body.relationship_id !== this.store.id || body.parent_request_id !== slot.parent ||
        body.token !== slot.token || (body.id != null && body.id !== slot.id) ||
        (body.call_id ?? null) !== slot.call || (body.group_id ?? null) !== slot.group ||
        (body.parent_playback_id!=null && body.parent_playback_id!==slot.playback) ||
        (body.request_id!=null && body.request_id!=='initiative:'+slot.id) ||
        (body.language!=null && body.language!==slot.first?.language)) return false;
    if (!slot.playback || this.store.indexRetry || this.store.eraseJob()) return false;
    if (slot.call && !this.store.db.prepare('SELECT 1 FROM call_log WHERE id=? AND ended IS NULL').get(slot.call)) return false;
    if (slot.group && !this.store.db.prepare('SELECT 1 FROM topic_groups WHERE id=?').get(slot.group)) return false;
    const latest = this.store.db.prepare('SELECT request_id FROM turn_sources WHERE user_entry IS NOT NULL OR assistant_entry IS NOT NULL ORDER BY at DESC,rowid DESC LIMIT 1').get();
    if (latest?.request_id !== slot.parent && latest?.request_id !== 'initiative:'+slot.id) return false;
    const parent = this.store.resolveTurn(slot.parent);
    return Boolean(parent?.published && parent.playback_id === slot.playback && parent.assistant === slot.first.speech &&
      parent.translation === slot.first.translation && parent.group_id === slot.group && parent.call_id === slot.call);
  }

  route(action,body,session) {
    const slot = this.current;
    const sameParent = slot && body.relationship_id === this.store.id && body.parent_request_id === slot.parent;
    const matches = sameParent && body.token === slot.token && (body.id == null || body.id === slot.id);
    if (action === 'cancel') {
      // Before the first response arrives the desktop only has its own turn
      // and original route. An explicitly supplied bad token cannot use this path.
      const beforeHandle = sameParent && !Object.hasOwn(body,'token') && !Object.hasOwn(body,'id') &&
        Object.hasOwn(body,'group_id') && body.group_id===slot.group && Object.hasOwn(body,'call_id') && body.call_id===slot.call &&
        ['admitted','pending','ready'].includes(slot.state);
      return {ok:true,cancelled:Boolean((matches || beforeHandle) && this.cancel(slot))};
    }
    if (!['prepare','deliver'].includes(action)) throw Error('不支持的即时补话操作');
    const stale = action === 'prepare' ? {ok:true,state:'expired'} : {ok:true,item:null};
    if (!matches || !this.#valid(slot,body)) return stale;
    if (action === 'prepare') {
      if (slot.state === 'published') return {ok:true,state:'expired'};
      const data = {ok:true,state:slot.state,timing:{...slot.timing}};
      if(slot.diagnostic)data.diagnostic={...slot.diagnostic};
      if (slot.state === 'ready') data.draft = this.#draft(slot);
      return data;
    }
    if (slot.state !== 'ready' && slot.state !== 'published') return stale;
    const claim = {id:slot.id,token:slot.token,groupId:slot.group,kind:'immediate',draft:slot.draft,parentRequestId:slot.parent};
    // Synchronous lookup + append; repeated delivery cannot add another row.
    const item = this.store.initiativeItem(session,claim) || this.store.addInitiative(session,claim,slot.draft,{call_id:slot.call});
    if (!item || item.call_id !== slot.call || item.groupId !== slot.group) return stale;
    slot.state = 'published';
    const voiceTag = item.behavior.language === 'ja' ? selectLocalDelivery(item.behavior.speech,[]).tag : null;
    return {ok:true,item:{...this.#draft(slot),...item,group_id:item.groupId,voice_tag:voiceTag}};
  }

  #draft(slot) {
    return {id:slot.id,token:slot.token,parent_request_id:slot.parent,request_id:'initiative:'+slot.id,group_id:slot.group,
      call_id:slot.call,behavior:{...slot.draft},voice_style:'inherit-parent'};
  }
}
