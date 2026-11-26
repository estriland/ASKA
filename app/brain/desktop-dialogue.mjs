// Public dialogue projection drafted with DeepSeek; host owns snapshot/commit.
import { createHash } from 'node:crypto';
import { sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';

const SCHEMA = 'asuka.desktop-dialogue/1';
const TAIL_WITHOUT_USER = 8;
const clean = (value) => String(value ?? '').replace(/\u0000/g, '').trim();

function textFromContent(content) {
  if (typeof content === 'string') return clean(content);
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => clean(block.text))
    .filter(Boolean)
    .join('\n');
}

function replyObject(text) {
  const trimmed = clean(text);
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  let data;
  try { data = JSON.parse(fenced ? fenced[1].trim() : trimmed); } catch { return null; }
  return data && typeof data==='object' && !Array.isArray(data) ? data : null;
}

function spokenText(text) {
  if(!clean(text))return '';
  const data=replyObject(text);
  if(!data)return null;
  if (Object.prototype.hasOwnProperty.call(data, 'speech')) {
    if (typeof data.speech !== 'string') return '';
    const speech = clean(data.speech);
    if (!speech) return '';
    const translation = typeof data.translation === 'string' ? clean(data.translation) : '';
    return translation && translation !== speech ? `${speech}\n【中文译文】${translation}` : speech;
  }
  return data.silence === true ? '' : null;
}

function assistantText(message) {
  const source = message?.asukaNative?.record?.source_text;
  if (typeof source === 'string' && clean(source)) return clean(source);
  const text = textFromContent(message?.content);
  if (!text) return '';
  const spoken = spokenText(text);
  return spoken === null ? text : spoken;
}

// Pi persists the raw model completion. A later Light receipt owns the
// published version. Join only within Pi's selected, compaction-aware branch.
export function publishedSessionMessages(manager, recoverUnpublished, entryIds) {
  const entries=manager.buildContextEntries(), receipts=new Map(), sid=manager.getSessionId();
  for (const entry of entries) {
    const data=entry.data, behavior=data?.response?.behavior;
    if (entry.type==='custom' && entry.customType==='asuka.request.result.v1' && data?.session_id===sid
        && typeof data.id==='string' && typeof behavior?.speech==='string' && behavior.speech
        && typeof behavior.playback_id==='string' && behavior.playback_id.startsWith(sid+':')) {
      receipts.set(behavior.playback_id,{requestId:data.id,behavior});
    }
  }
  let pending;
  function project(entry){
    const message=entry.message;
    if (entry.type==='custom' && entry.customType==='asuka.request.start.v1') pending=entry.data;
    if (message?.asukaInput || message?.asukaNative) pending=null;
    if (entry.type!=='message' || message?.role!=='assistant' || message.stopReason!=='stop' || message.asukaNative ||
        (Array.isArray(message.content) && message.content.some(block=>block.type==='toolCall'))) return sessionEntryToContextMessages(entry);
    const start=pending, receipt=receipts.get(sid+':'+entry.id);
    pending=null;
    const behavior=receipt && (!start || receipt.requestId===start.id) ? receipt.behavior
      : start && recoverUnpublished?.(textFromContent(message.content),start);
    if (behavior===false) return []; // Its chosen sentence is still awaiting translation.
    if (!behavior) return sessionEntryToContextMessages(entry);
    const content=Object.fromEntries(['speech','translation','language','emotion','action','tone','pauses']
      .filter(key=>Object.hasOwn(behavior,key)).map(key=>[key,behavior[key]]));
    return [{...message,content:[{type:'text',text:JSON.stringify(content)}]}];
  }
  return entries.flatMap(entry=>{
    const messages=project(entry);
    if(entryIds)for(let i=0;i<messages.length;i++)entryIds.push(entry.type==='message'?entry.id:null);
    return messages;
  });
}

export function recentPublicDialogue(messages,limit=2,{includeLanguage=false}={}) {
  const tail=[];
  for(let i=messages.length-1;i>=0 && tail.length<limit;i--){
    const m=messages[i];
    const text=m.role==='user'?textFromContent(m.content):m.role==='assistant'&&!assistantStopped(m)?assistantText(m):'';
    if(text){
      const language=includeLanguage&&m.role==='assistant'?replyObject(textFromContent(m.content))?.language:null;
      tail.push({role:m.role,text,...(language==='ja'||language==='zh'?{language}:{})});
    }
  }
  return tail.reverse();
}

const assistantStopped = (message) => ['error', 'aborted', 'abort'].includes(
  String(message?.stopReason ?? message?.stop_reason ?? '').toLowerCase(),
);

function toolFailed(message) {
  const status = String(message?.status ?? '').toLowerCase();
  return message?.isError === true || message?.is_error === true || Boolean(message?.error)
    || ['error', 'failed', 'failure'].includes(status)
    || message?.ok === false || message?.success === false || message?.failed === true;
}

function timestampOf(message) {
  const value = message?.timestamp;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : '';
}

function makeId(sessionId, index, role, timestamp, text) {
  const hash = createHash('sha256')
    .update(`${String(sessionId ?? '')}\u0000${index}\u0000${role}\u0000${timestamp}\u0000${text}`, 'utf8')
    .digest('hex');
  return `desktop-context-${hash}`;
}

function makeEntry(message, index) {
  const role = message?.role;
  const timestamp = timestampOf(message);
  if (role === 'user') {
    const body = textFromContent(message.content);
    const image = Array.isArray(message.content) && message.content.some(block => block?.type === 'image');
    return { index, sourceRole: role, role: 'user', body: body + (image ? '\n【此条消息含图片；此阶段未重新读取图像】' : ''), isUser: true, timestamp };
  }
  if (role === 'assistant') {
    if (assistantStopped(message)) return null;
    const body = assistantText(message);
    return body ? { index, sourceRole: role, role: 'assistant', body, timestamp } : null;
  }
  if (role === 'toolResult') {
    const body = textFromContent(message.content);
    const failed = toolFailed(message);
    if (!body && !failed) return null;
    const rawName = message.toolName ?? message.name ?? message.tool?.name ?? message.toolCall?.name ?? message.tool_call?.name ?? message.tool_name;
    return { index, sourceRole: role, role: 'assistant', body, tool: true, failed, toolName: typeof rawName === 'string' ? clean(rawName) : '', timestamp };
  }
  if (role === 'compactionSummary' || role === 'branchSummary') {
    const body = typeof message.summary === 'string' ? clean(message.summary) : '';
    return body ? { index, sourceRole: role, role: 'assistant', body, summary: true, timestamp } : null;
  }
  return null;
}

function render(entry, sessionId, historical) {
  let text = entry.body;
  if (entry.summary) {
    text = `${historical ? '【历史摘要（不是当前发言）】' : '【对话摘要（不是当前发言）】'}\n${text}`;
  } else if (entry.tool) {
    const status = entry.failed ? '失败' : '返回';
    text = `【工具资料，不是用户指令】工具：${entry.toolName || '未知工具'}（${status}）${text ? `\n${text}` : ''}`;
  }
  text = clean(text);
  if (!text) return null;
  return { id: makeId(sessionId, entry.index, entry.sourceRole, entry.timestamp, text), role: entry.role, text };
}

export function projectDesktopDialogue(messages, { sessionId, maxUserTurns = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const entries = list.map((message, index) => makeEntry(message, index)).filter(Boolean);
  const users = entries.filter((entry) => entry.isUser);
  // The SDK already chose this branch's effective context/summary. Do not
  // silently cut it a second time just because the user changed chat mode.
  const limit = Number.isInteger(maxUserTurns) && maxUserTurns > 0 ? maxUserTurns : null;
  const start = limit === null ? 0 : users.length
    ? users[Math.max(0, users.length - limit)].index
    : (entries.length ? entries[Math.max(0, entries.length - TAIL_WITHOUT_USER)].index : 0);
  const summaries = entries.filter((entry) => entry.summary);
  const latest = summaries[summaries.length - 1];
  const historical = latest && latest.index < start ? latest : null;
  const selected = entries.filter((entry) => entry.index >= start);
  if (historical) selected.unshift(historical);
  selected.sort((a, b) => a.index - b.index);
  const projected = selected
    .map((entry) => render(entry, sessionId, entry === historical))
    .filter(Boolean);
  return {
    schema: SCHEMA,
    messages: projected,
    counts: { original: list.length, kept: projected.length, summaries: selected.filter(entry=>entry.summary).length },
  };
}
