import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fingerprint} from './personality/general-network/assembly-identity.mjs';
import {textContent} from './personality/shin-dev/history.mjs';
import {publishImmutableDialogueJson} from './dialogue-profile.mjs';
import {eraseSessionRecords} from './conversation-erasure.mjs';
import {usageBeforeErasure} from '../tools/personality/chat-usage.mjs';
import {forgetGeneralInteractionCues} from './interaction-memory-general.mjs';
import {publishedFollowupParent} from './immediate-followup.mjs';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const entry = file => fs.lstatSync(file,{throwIfNoEntry:false});
const startType = 'asuka.request.start.v1', resultType = 'asuka.request.result.v1';
const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj?.[k] !== undefined).map(k => [k,obj[k]]));
const groupKeys = ['group_id','group_title','call_id','surface'];
function requireScope(value, code = 'RELATIONSHIP_ERASURE_SCOPE') {
  if (!value) throw Object.assign(new Error('回合删除所需的存档归属或版本无法核实'),{code});
}
function bounded(root,...parts) {
  const base = path.resolve(root), target = path.resolve(base,...parts), rel = path.relative(base,target);
  requireScope(rel && !path.isAbsolute(rel) && !rel.startsWith('..') && !entry(base)?.isSymbolicLink());
  let current = base;
  for (const part of rel.split(path.sep)) {
    current = path.join(current,part);
    requireScope(!entry(current)?.isSymbolicLink());
  }
  return target;
}
function planFile(root,id,name = 'pending.json') {
  requireScope(uuid.test(id));
  return bounded(root,'.relationship-turn-erasure',fingerprint(id),name);
}
function scopeHash({sessionDirectory,dialogueDirectory,generalRoot,journalRoot}) {
  return fingerprint([sessionDirectory,dialogueDirectory,generalRoot,journalRoot].map(dir => dir ? path.resolve(dir) : null));
}

export function pendingRelationshipErasure({sessionDirectory,sessionId}) {
  const file = planFile(sessionDirectory,sessionId);
  if (!entry(file)) return null;
  requireScope(entry(file).isFile());
  const plan = read(file);
  requireScope(plan.schema==='feiniao.turn-erasure/1' && plan.session_id===sessionId && Array.isArray(plan.request_ids) &&
    (plan.public_projection==null || [2,3].includes(plan.public_projection)) &&
    plan.request_ids.every(id => typeof id==='string' && id.length>0) && path.basename(plan.sdk_name)===plan.sdk_name &&
    plan.sdk_name.endsWith('.jsonl') && [plan.before,plan.after,plan.scope].every(value => /^[a-f0-9]{64}$/.test(value)));
  return plan;
}

function publicBehavior(raw) {
  if (!raw || typeof raw!=='object') return null;
  if (!raw.silence && typeof raw.speech!=='string') return null;
  const result = pick(raw,['speech','translation','language','emotion','action','tone','silence','voice_turn','voice_preset',
    'reply_saved','quality_mode','analysis_complete','degraded_continuity']);
  if (Array.isArray(raw.pauses)) result.pauses = raw.pauses.map(p => typeof p==='object' ? pick(p,['after','ms','at','duration']) : p);
  if (Array.isArray(raw.parts)) result.parts = raw.parts.map(part => pick(part,['index','speech','translation']));
  return result;
}
function published(raw) {
  const text = textContent(raw);
  try { return publicBehavior(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/giu,''))); }
  catch { return null; }
}
function usableId(value) { return typeof value==='string' && value.length>0 && value.length<=256 && !value.includes('\0'); }

// Fenced host-generated input, matched against the two complete templates
// from normalizeClientEvent. A free-form payload with the same tag is opaque.
const microphoneDigests = new Map([
  ['b91873527c41a854fb8c2ff5b89a00a3dcbb967794d413c0b1787f9711c6fa40','microphone_muted'],
  ['a7de8b3e62ac2910455e24b38b1d6af271fe8817fefbf9dd5a64f9a4c5f876b3','microphone_unmuted'],
]);
function microphone(entry) {
  const m=entry.type==='custom_message'?entry:entry.message?.role==='custom'?entry.message:null;
  if (m?.customType!=='asuka.client_event.v1' || m.display!==false) return null;
  const content=typeof m.content==='string'?m.content:Array.isArray(m.content)&&m.content.length===1&&m.content[0]?.type==='text'?m.content[0].text:null;
  if (typeof content!=='string') return null;
  const type=microphoneDigests.get(sha(content.replaceAll('\r\n','\n')));
  if (!type || (m.details?.type!=null && m.details.type!==type) ||
      (m.details?.source!=null && m.details.source!=='desktop-client') || (m.details?.version!=null && m.details.version!==1)) return null;
  const event={customType:m.customType,content:typeof m.content==='string'?content:[{type:'text',text:content}],
    display:false,details:{...pick(m.details,['type','source','version']),type}};
  return entry.type==='custom_message' ? {type:'custom_message',...event} : {type:'message',message:{role:'custom',timestamp:m.timestamp,...event}};
}

function opaqueEntry(e) {
  throw Object.assign(new Error('这个 SDK 条目的来源尚不能安全区分，已保留原始存档。'),{
    code:'RELATIONSHIP_ERASURE_UNKNOWN_ENTRY',entry_id:e.id,sdk_unchanged:true});
}

// The parent chain, not chronological proximity, binds tool transactions.
// Marked requests and actual unmarked user/event inputs are separate roots.
function sourceTree(entries,receipts) {
  const info=new Map();
  for (const e of entries) {
    requireScope(usableId(e.id) && !info.has(e.id) && (e.parentId===null||info.has(e.parentId)),'RELATIONSHIP_ERASURE_SDK_GRAPH');
    const prior=info.get(e.parentId)?.next, m=e.message, event=microphone(e);
    let owner=prior?.owner, input=prior?.input, batch=prior?.batch, answered=prior?.answered, next;
    if (e.type==='custom' && e.customType===startType) {
      owner={id:e.data?.id};input=null;batch=null;
    } else if (event) {
      owner=owner??{id:null};input=input??e.id;batch=null;
    } else if (m?.role==='user') {
      owner=m?.asukaInput?.request_id?{id:m.asukaInput.request_id}:owner&&!input?owner:{id:null};
      input=e.id;batch=null;
    } else if (m?.role==='assistant') {
      const direct=m.asukaInitiative?.request_id||m.asukaNative?.record?.client_request_id||receipts.get(e.id)?.id;
      if (direct) {
        if (owner && !owner.id) owner.id=direct;
        else if (owner?.id!==direct) owner={id:direct};
      }
      const blocks=Array.isArray(m.content)?m.content.filter(b=>b?.type==='toolCall'):[];
      if (blocks.length || m.stopReason==='toolUse') {
        batch={calls:new Map(),invalid:false};answered=new Set();
        for (const b of blocks) {
          if (!usableId(b.id) || !usableId(b.name) || !b.arguments || typeof b.arguments!=='object' || Array.isArray(b.arguments) || batch.calls.has(b.id))
            {batch.invalid=true;continue;}
          batch.calls.set(b.id,{block:pick(b,['type','id','name','arguments']),results:[]});
        }
      } else next=null;
    } else if (m?.role==='toolResult') {
      const call=batch?.calls.get(m.toolCallId);
      if (call && m.toolName===call.block.name) {
        if (answered.has(m.toolCallId)) batch.invalid=true;
        answered=new Set(answered).add(m.toolCallId);call.results.push(e);
      }
    } else if (e.type==='custom' && e.customType===resultType) {
      owner={id:e.data?.id};next=null;
    }
    info.set(e.id,{owner,input,batch,event,next:next===null?null:{owner,input,batch,answered}});
  }
  return info;
}

function copyCandidates(texts) {
  const pieces=new Set();
  for (const text of texts) {
    for (const part of text.split(/[。！？!?，,；;\n]/u)) {
      const phrase=part.trim(), chars=phrase.match(/[\p{L}\p{N}]/gu)??[];
      if (chars.length>=10 || (phrase.match(/\p{Script=Han}/gu)??[]).length>=6) pieces.add(phrase);
    }
    for (const word of text.match(/[A-Za-z0-9_-]{6,}/g)??[]) if (/[a-z]/i.test(word)&&/\d/.test(word)) pieces.add(word);
  }
  return pieces;
}

function extensionProjection(entries,info,receipts,sid,wanted) {
  const replacement=new Map(), removedText=[], keptText=[], mentions=new Set(), rawIds=new Set(wanted), removedImages=new Set(),keptImages=new Set();
  const deleted=e=>wanted.has(info.get(e.id)?.owner?.id);
  if (!entries.some(deleted)) return replacement;
  for (const e of entries) {
    const m=e.message, cut=deleted(e), target=cut?removedText:keptText;
    if (cut) {rawIds.add(e.id);mentions.add(sid+':'+e.id);}
    if (m?.role==='user') {
      target.push(textContent(m.content));
      if (Array.isArray(m.content)) for (const b of m.content) if (b.type==='image'&&typeof b.data==='string') (cut?removedImages:keptImages).add(sha(b.data));
    } else if (m?.role==='assistant' && !['toolUse','error','aborted','abort'].includes(m.stopReason) &&
        !(Array.isArray(m.content)&&m.content.some(b=>b.type==='toolCall')) &&
        (cut || receipts.has(e.id) || m.asukaNative || m.asukaInitiative || m.asukaPublic || !info.get(e.parentId)?.next?.owner?.id)) {
      const b=publicBehavior(receipts.get(e.id)?.response?.behavior)??published(m.content);
      for (const s of b?[b.speech,b.translation]:[textContent(m.content)]) if (typeof s==='string') target.push(s);
    }
  }
  for (const id of wanted) {
    mentions.add(id+':user');mentions.add(id+':assistant');
    if (uuid.test(id)) mentions.add(id);
  }
  for (const image of keptImages) removedImages.delete(image);
  const qualified=[...mentions];
  const distinctive=[...copyCandidates(removedText)].filter(s=>!keptText.some(t=>t.includes(s)));
  function cites(value,field) {
    if (typeof value==='string') {
      if ((/(?:ref|source|citation|evidence|entry|request|turn|message|origin|parent|target|id)/i.test(field??'') && rawIds.has(value)) ||
          qualified.some(ref=>value.includes(ref))) return true;
      if (/^\s*[\[{]/.test(value)) { try {return cites(JSON.parse(value));} catch { /* Ordinary tool text. */ } }
      return false;
    }
    if (Array.isArray(value)) return value.some(v=>cites(v,field));
    return value!=null && typeof value==='object' && Object.entries(value).some(([k,v])=>cites(v,k));
  }
  function mixedSources(data) {
    if (!data || typeof data!=='object') return false;
    return Object.entries(data).some(([key,value])=>
      Array.isArray(value) && /^(?:source_?refs|source_?ids|sources|citations|evidence_?refs)$/i.test(key) &&
      value.some(v=>cites(v,key)) && value.some(v=>!cites(v,key)) || mixedSources(value));
  }
  const quotes=(value,after)=>after && distinctive.some(s=>value.includes(s));
  const afterCut=new Map();
  for (const e of entries) afterCut.set(e.id,deleted(e)||afterCut.get(e.parentId)===true);
  for (const e of entries) {
    if (deleted(e)) continue;
    const m=e.message, {batch,input,event}=info.get(e.id);
    if (event) {replacement.set(e.id,event);continue;}
    if (m?.role!=='assistant' || !batch || !Array.isArray(m.content) || !m.content.some(b=>b?.type==='toolCall')) continue;
    if (!input || batch.invalid) opaqueEntry(e);
    const blocks=[];
    const failed=['error','aborted','abort'].includes(m.stopReason);
    for (const call of batch.calls.values()) {
      const b=call.block;
      if (mixedSources(b.arguments)) opaqueEntry(e);
      if (cites(b.arguments) || quotes(JSON.stringify(b.arguments),afterCut.get(e.id))) continue;
      if (!call.results.length) {if (failed) continue;opaqueEntry(e);}
      const projected=[];
      for (const result of call.results) {
        const r=result.message;
        if (mixedSources(r.details)) opaqueEntry(result);
        if (cites(r.details)) break;
        const parts=typeof r.content==='string'?[{type:'text',text:r.content}]:r.content;
        if (!Array.isArray(parts)) opaqueEntry(result);
        const content=[];
        for (const part of parts) {
          if (part?.type==='text' && typeof part.text==='string') {
            if (!cites(part.text) && !quotes(part.text,afterCut.get(result.id))) content.push({type:'text',text:part.text});
          } else if (part?.type==='image' && typeof part.data==='string' && typeof part.mimeType==='string') {
            if (!afterCut.get(result.id) || !removedImages.has(sha(part.data))) content.push(pick(part,['type','data','mimeType']));
          } else opaqueEntry(result);
        }
        if (parts.length && !content.length) break;
        projected.push([result.id,{type:'message',message:{...pick(r,['role','toolCallId','toolName','isError','timestamp']),content}}]);
      }
      if (projected.length!==call.results.length) continue;
      call.retained=true;
      blocks.push(b);
      for (const [key,row] of projected) replacement.set(key,row);
    }
    if (blocks.length) replacement.set(e.id,{type:'message',message:{...assistantMetadata(m),stopReason:m.stopReason??'toolUse',content:blocks}});
  }
  const parents=new Set(entries.map(e=>e.parentId));
  function completeBatch(state,e) {
    if (state?.batch && [...state.batch.calls.values()].some(call=>call.retained&&!state.answered.has(call.block.id))) opaqueEntry(e);
  }
  for (const e of entries) {
    // A call shared above a fork must have its own matching result on each
    // preserved branch before a new turn or terminal reply can follow it.
    const before=info.get(e.parentId)?.next,after=info.get(e.id).next;
    if (before?.batch && before.batch!==after?.batch) completeBatch(before,e);
    if (!parents.has(e.id)) completeBatch(after,e);
    if (deleted(e) || replacement.has(e.id)) continue;
    const m=e.message;
    if (m?.role==='toolResult') {
      const matched=info.get(e.id).batch?.calls.get(m.toolCallId);
      if (!matched?.results.some(r=>r.id===e.id)) opaqueEntry(e);
    } else if (e.type==='custom' && ![startType,resultType,'derived.context','feiniao.public-branch.v1'].includes(e.customType) ||
        e.type==='custom_message' || m?.role==='custom' || (m&&!['user','assistant'].includes(m.role)) ||
        !['message','custom','model_change','thinking_level_change','session_info','label','compaction','branch_summary'].includes(e.type)) {
      // An opaque surviving record can cite a removed entry AND contain
      // independently authored data. The reference alone cannot erase both.
      opaqueEntry(e);
    }
  }
  return replacement;
}

function assistantMetadata(m) {
  const message=pick(m,['role','timestamp','stopReason','api','provider','model']);
  if (m.usage) message.usage={...pick(m.usage,['input','output','cacheRead','cacheWrite','cacheWrite1h','reasoning','totalTokens']),
    ...(m.usage.cost?{cost:pick(m.usage.cost,['input','output','cacheRead','cacheWrite','total'])}:{})};
  return message;
}

// Pi has no public mutation that erases bytes from the tree. Keep public
// entries and their IDs, reconnect edges through removed nodes and let Pi
// reload its normal JSONL. Replies in other retained branches stay there.
function cleanTree(raw, sid, wanted, leaf, bindFollowups=true) {
  const [header,...entries] = raw.toString('utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  requireScope(header?.type==='session' && header.id===sid);
  wanted=new Set(wanted);
  const receipts = new Map();
  for (const e of entries) {
    const parent=bindFollowups&&publishedFollowupParent(sid,e.message);
    if(parent && wanted.has(parent))wanted.add(e.message.asukaInitiative.request_id);
    const b = e.data?.response?.behavior;
    if (e.type==='custom' && e.customType===resultType && e.data?.session_id===sid && usableId(e.data.id) &&
        b?.playback_id?.startsWith(sid+':') && publicBehavior(b)) {
      const id = b.playback_id.slice(sid.length+1), old = receipts.get(id);
      requireScope(!old || (old.id===e.data.id && fingerprint(publicBehavior(old.response.behavior))===fingerprint(publicBehavior(b))),
        'RELATIONSHIP_ERASURE_PUBLICATION');
      receipts.set(id,e.data);
    }
  }
  const info=sourceTree(entries,receipts);
  const extensions=extensionProjection(entries,info,receipts,sid,wanted);
  const nextParent = new Map(), kept = new Set(), matched = new Map();
  const rows = [pick(header,['type','version','id','timestamp','cwd'])];
  for (const e of entries) {
    requireScope(usableId(e.id) && !nextParent.has(e.id) && (e.parentId===null || nextParent.has(e.parentId)),
      'RELATIONSHIP_ERASURE_SDK_GRAPH');
    const m = e.message, data = e.data, parentOwner = info.get(e.parentId)?.next?.owner, linked = receipts.get(e.id);
    const isStart = e.type==='custom' && e.customType===startType, isResult = e.type==='custom' && e.customType===resultType;
    const id = info.get(e.id).owner?.id;
    let replacement = null;
    if (isStart || isResult) {
      requireScope(usableId(id) && id===data?.id && (!data.session_id || data.session_id===sid));
      if (isStart) replacement = {type:'custom',customType:startType,data:pick(data,
        ['id','key','configuration_sha256','publication_contract','spoken_language','japanese_default',...groupKeys])};
      else {
        const behavior = publicBehavior(data.response?.behavior);
        if (behavior) {
          const playback = data.response.behavior.playback_id;
          if (typeof playback==='string' && playback.startsWith(sid+':')) behavior.playback_id = playback;
          const response = {behavior};
          if (data.response.personality) response.personality = pick(data.response.personality,['mode','actualMode','requestedMode']);
          replacement = {type:'custom',customType:resultType,data:{...pick(data,['id','session_id','key',...groupKeys]),response}};
        }
      }
    } else if (e.type==='message' && m?.role==='user') {
      const content = Array.isArray(m.content) ? m.content.filter(b => b.type==='text'||b.type==='image').map(b =>
        pick(b,b.type==='image'?['type','data','mimeType']:['type','text'])) : m.content;
      const message = {role:'user',content,timestamp:m.timestamp};
      if (m.asukaInput) message.asukaInput = pick(m.asukaInput,['schema','request_id','session_id','key','turn_id',
        'text_sha256','images_sha256','request_key',...groupKeys]);
      replacement = {type:'message',message};
    } else if (e.type==='message' && m?.role==='assistant') {
      requireScope(!linked || (!(m.asukaInput || m.asukaNative || m.asukaInitiative) && (!parentOwner?.id || linked.id===parentOwner.id)),
        'RELATIONSHIP_ERASURE_PUBLICATION');
      const terminal = !['toolUse','error','aborted','abort'].includes(m.stopReason) &&
        !(Array.isArray(m.content) && m.content.some(b => b.type==='toolCall'));
      // A marked Light draft has no publication until its result is durable.
      // A retained user's unfinished input may survive while that raw draft
      // and the request-local model context must go away.
      if (terminal && (!parentOwner?.id || linked || m.asukaNative || m.asukaInitiative || m.asukaPublic)) {
        const behavior = publicBehavior(linked?.response?.behavior) ?? published(m.content);
        const text = behavior ? JSON.stringify(behavior) : textContent(m.content);
        const message = {...assistantMetadata(m),content:[{type:'text',text}]};
        if (m.asukaNative?.key?.startsWith('general-desktop:')) {
          message.asukaNative = {key:m.asukaNative.key,record:{...pick(m.asukaNative.record,['session_id','turn_id','revision',
            'client_request_id','client_request_key','analysis_complete','degraded_continuity','state_update',...groupKeys]),
            source_text:behavior?.translation || behavior?.speech || text}};
        }
        if (m.asukaInitiative) {
          message.asukaInitiative = pick(m.asukaInitiative,['id','request_id','claim_kind','kind',...groupKeys]);
          const parent=bindFollowups&&publishedFollowupParent(sid,m);
          if(parent)message.asukaInitiative.parent_request_id=parent;
        }
        if (m.asukaPublic) message.asukaPublic = typeof m.asukaPublic==='object' ? pick(m.asukaPublic,['id','request_id',...groupKeys]) : true;
        replacement = {type:'message',message};
      }
    } else if (e.type==='model_change' || e.type==='thinking_level_change') {
      replacement = pick(e,['type','provider','modelId','thinkingLevel']);
    } else if (e.type==='session_info') {
      replacement = pick(e,['type','name']);
    } else if (e.type==='label' && kept.has(e.targetId)) {
      replacement = pick(e,['type','targetId','label']);
    }
    if (extensions.has(e.id)) replacement=extensions.get(e.id);
    if (id && wanted.has(id)) {
      if (!matched.has(id)) matched.set(id,new Set());
      if (m?.role==='assistant' && !['toolUse','error','aborted','abort'].includes(m.stopReason) &&
          !(Array.isArray(m.content)&&m.content.some(b=>b.type==='toolCall'))) matched.get(id).add(sid+':'+e.id);
      if (isResult && data.response?.behavior?.playback_id?.startsWith(sid+':'))
        matched.get(id).add(data.response.behavior.playback_id);
      replacement = null;
    }
    const parentId = e.parentId===null ? null : nextParent.get(e.parentId);
    if (replacement) {
      kept.add(e.id); rows.push({...replacement,id:e.id,parentId,timestamp:e.timestamp});
    }
    nextParent.set(e.id,replacement ? e.id : parentId);
  }
  requireScope(!leaf || nextParent.has(leaf),'RELATIONSHIP_ERASURE_SDK_GRAPH');
  const newLeaf = leaf ? nextParent.get(leaf) : null, last = rows.length>1 ? rows.at(-1).id : null;
  if (newLeaf!==last) {
    const id = fingerprint({sid,leaf,requests:[...wanted].sort(),anchor:newLeaf}).slice(0,32);
    requireScope(!nextParent.has(id));
    rows.push({type:'custom',customType:'feiniao.public-branch.v1',id,parentId:newLeaf,timestamp:header.timestamp,data:{}});
  }
  return {bytes:Buffer.from(rows.map(row => JSON.stringify(row)).join('\n')+'\n'),
    found:Object.fromEntries([...matched].map(([id,replays]) => [id,[...replays]]))};
}

function generalReceipt(root,sid) {
  const receipt = {id:sid,sdk_name:null,general_id:null,accounting:null,
    general_namespace:root ? fingerprint(path.resolve(root)) : null};
  if (!root) return receipt;
  const own = fingerprint(sid)+'.json', link = bounded(root,'desktop-links',own);
  if (!entry(link)) return receipt;
  requireScope(entry(link).isFile());
  const row = read(link), gid = row.session_id;
  requireScope(row.pi_id===sid && uuid.test(gid));
  for (const name of fs.readdirSync(path.dirname(link))) {
    if (name!==own && name.endsWith('.json')) requireScope(read(bounded(root,'desktop-links',name)).session_id!==gid);
  }
  const meta = read(bounded(root,'sessions',gid,'session.json'));
  requireScope(meta.id===gid && meta.namespace?.conversation_id===gid);
  return {...receipt,general_id:gid,accounting:usageBeforeErasure(root,gid)};
}

function stageBytes(root,sid,name,bytes) {
  const stage=planFile(root,sid,name);
  if (entry(stage)) {requireScope(entry(stage).isFile());fs.unlinkSync(stage);}
  const fd=fs.openSync(stage,'wx');
  try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  return stage;
}

function finish(options,plan) {
  const {sessionDirectory:root,dialogueDirectory,generalRoot,journalRoot} = options, sid = plan.session_id;
  const sdkFile = bounded(root,plan.sdk_name);
  requireScope(plan.scope===scopeHash(options) && entry(sdkFile)?.isFile());
  const bytes = fs.readFileSync(sdkFile), current = sha(bytes);
  if (current!==plan.after) {
    requireScope(current===plan.before,'RELATIONSHIP_ERASURE_SOURCE_CHANGED');
    let redacted;
    try {redacted=cleanTree(bytes,sid,new Set(plan.request_ids),plan.leaf,plan.public_projection!==2).bytes;}
    catch (error) {
      // A pre-upgrade intent may have admitted an opaque payload. Before the
      // atomic SDK replacement no source/sidecar has been removed. Retire that
      // exact old plan so the host can cancel its intent and reopen the chat.
      if (error.code==='RELATIONSHIP_ERASURE_UNKNOWN_ENTRY' && sha(fs.readFileSync(sdkFile))===plan.before &&
          plan.request_ids.every(id=>!entry(planFile(root,sid,'done-'+fingerprint(id)+'.json'))) &&
          fingerprint(pendingRelationshipErasure({sessionDirectory:root,sessionId:sid}))===fingerprint(plan)) {
        const stale=planFile(root,sid,'retained.tmp');
        if (entry(stale)) {requireScope(entry(stale).isFile());fs.unlinkSync(stale);}
        fs.unlinkSync(planFile(root,sid));
      }
      throw error;
    }
    const after=sha(redacted);
    if (!plan.public_projection && after!==plan.after) {
      // Upgrade only against the unchanged original. A completed old swap
      // is reconciled above using its recorded digest.
      requireScope(fingerprint(pendingRelationshipErasure({sessionDirectory:root,sessionId:sid}))===fingerprint(plan));
      plan={...plan,after,public_projection:3};
      const upgrade=stageBytes(root,sid,'projection-upgrade.tmp',Buffer.from(JSON.stringify(plan)+'\n'));
      fs.renameSync(upgrade,planFile(root,sid));
    }
    requireScope(after===plan.after,'RELATIONSHIP_ERASURE_SOURCE_CHANGED');
    const stage=stageBytes(root,sid,'retained.tmp',redacted);
    requireScope(sha(fs.readFileSync(sdkFile))===plan.before,'RELATIONSHIP_ERASURE_SOURCE_CHANGED');
    fs.renameSync(stage,sdkFile);
  }
  // The request-local Light prompts/format reports and General engine are
  // frozen snapshots that may include an earlier turn. The opening relationship
  // profile is independently authored and belongs to the surviving relationship.
  eraseSessionRecords({root,receipt:plan.general,generalRoot,dialogueRoot:dialogueDirectory,journalRoot,preserveDialogueState:true});
  forgetGeneralInteractionCues(generalRoot,plan.general.general_id);
  for (const id of plan.request_ids) {
    const done = {schema:'feiniao.erased-turn/1',session_id:sid,request_id:id,replay_ids:plan.replay_ids[id]};
    const destination = planFile(root,sid,'done-'+fingerprint(id)+'.json');
    publishImmutableDialogueJson(destination,done);
    requireScope(fingerprint(read(destination))===fingerprint(done));
  }
  fs.unlinkSync(planFile(root,sid));
}

// The caller quiesces the SDK and its General maintenance queue, tombstones
// the targets, then reopens this same SDK path after success. A pending plan
// contains IDs, hashes and usage only and can finish before new conversations.
export function eraseRelationshipTurns(options) {
  const {sessionManager:sm,sessionDirectory:root,requestIds=[]} = options, sid = sm.getSessionId();
  requireScope(uuid.test(sid) && path.resolve(root)===path.resolve(sm.getSessionDir()) && Array.isArray(requestIds) && requestIds.every(usableId));
  const file = sm.getSessionFile();
  requireScope(file && path.dirname(path.resolve(file))===path.resolve(root) && file.endsWith('.jsonl'));
  const sdkFile = bounded(root,path.basename(file));
  const prior = pendingRelationshipErasure({sessionDirectory:root,sessionId:sid});
  const replayIds = new Set(), ids = new Set(requestIds);
  let changed = false, resetGeneral = false;
  if (prior) {
    requireScope(prior.sdk_name===path.basename(sdkFile));
    finish(options,prior);
    for (const id of prior.request_ids) ids.add(id);
    changed = true; resetGeneral = Boolean(prior.general.general_id);
  }
  const remaining = new Set(), removed = new Set();
  for (const id of ids) {
    const done = planFile(root,sid,'done-'+fingerprint(id)+'.json');
    if (!entry(done)) {remaining.add(id);continue;}
    const receipt = read(done);
    requireScope(receipt.schema==='feiniao.erased-turn/1' && receipt.session_id===sid && receipt.request_id===id);
    removed.add(id);
    for (const replay of receipt.replay_ids) replayIds.add(replay);
  }
  if (remaining.size && entry(sdkFile)) {
    const bytes = fs.readFileSync(sdkFile);
    // A preceding recovered intent may already have removed this manager's
    // leaf. The durable file then owns the correct leaf for the next intent.
    const leaf = prior ? JSON.parse(bytes.toString('utf8').trimEnd().split('\n').at(-1)).id : sm.getLeafId();
    let cleaned;
    try {cleaned=cleanTree(bytes,sid,remaining,leaf===sid ? null : leaf);}
    catch (error) {if (changed && error.code==='RELATIONSHIP_ERASURE_UNKNOWN_ENTRY') error.sdk_unchanged=false; throw error;}
    const found = Object.keys(cleaned.found).sort();
    if (found.length) {
      const general = generalReceipt(options.generalRoot,sid);
      const cleanBytes = found.length===remaining.size ? cleaned.bytes : cleanTree(bytes,sid,new Set(found),leaf===sid?null:leaf).bytes;
      const plan = {schema:'feiniao.turn-erasure/1',public_projection:3,session_id:sid,sdk_name:path.basename(sdkFile),
        request_ids:found,replay_ids:cleaned.found,scope:scopeHash(options),before:sha(bytes),after:sha(cleanBytes),leaf:leaf===sid?null:leaf,general};
      publishImmutableDialogueJson(planFile(root,sid),plan);
      requireScope(fingerprint(pendingRelationshipErasure({sessionDirectory:root,sessionId:sid}))===fingerprint(plan));
      finish(options,plan);
      for (const id of found) removed.add(id);
      for (const ref of Object.values(cleaned.found).flat()) replayIds.add(ref);
      changed = true; resetGeneral ||= Boolean(general.general_id);
    }
  }
  return {sessionId:sid,sdkFile,requestIds:[...removed],notFound:[...ids].filter(id=>!removed.has(id)),replayIds:[...replayIds],resetGeneral,changed};
}
