// Model-facing excerpts of past public speech. General's measured values,
// storage paths, token weights and reinforcement decisions stay local.
export {readInteractionCue} from './interaction-memory-general.mjs';
import {textContent} from './personality/shin-dev/history.mjs';

const recalledTurns = 3;

// Keep a recalled line's time and origin while referring to speech already
// present in this request. A missing, edited or ambiguous line keeps its excerpt.
export function referenceVisibleSpeech(context, history, entryIds, source) {
  if (!context?.memories?.length && !context?.summaries?.length) return context;
  if (!entryIds || entryIds.length!==history.length) return context;
  const refs = new Map();
  // Older excerpts remain readable even in a long chat. Only refer across as
  // many nearby exchanges as recall can return in one turn.
  for (let i=history.length-1; i>=Math.max(0,history.length-2*recalledTurns); i--) {
    const message=history[i];
    // Only this uninterrupted run of public text has predictable positions on the wire.
    const nextRole=history[i+1]?.role ?? 'user';
    if (!entryIds[i] || !['user','assistant'].includes(message.role) ||
        message.role===nextRole || history[i-1]?.role===message.role ||
        (message.role==='assistant' && message.stopReason!=='stop') ||
        (Array.isArray(message.content) && message.content.some(part=>part.type!=='text')) ||
        !textContent(message.content).trim()) break;
    refs.set(entryIds[i],{message,distance:history.length-i});
  }
  if (!refs.size) return context;
  function project(line) {
    const role=line.speaker==='用户'?'user':['ASKA','飞鸟'].includes(line.speaker)?'assistant':null;
    if (!role || !line.text || !line.source_ref?.endsWith(':'+role)) return line;
    const turn=source(line.source_ref.slice(0,-role.length-1));
    const match=refs.get(turn?.[role+'_entry']);
    if (!match || match.message.role!==role) return line;
    let original=textContent(match.message.content), translation='';
    if (role==='assistant') {
      try {
        const reply=JSON.parse(original);
        original=reply.speech; translation=reply.translation??'';
      } catch { return line; }
    }
    if (typeof original!=='string' || original.slice(line.start,line.end)!==line.text ||
        (line.translation && (typeof translation!=='string' || !translation.includes(line.translation)))) return line;
    const {source_ref,text,translation:caption,start,end,...metadata}=line;
    return {...metadata,earlier_by:match.distance,...(text!==original?{start,end}:{})};
  }
  return {...context,
    ...(context.memories?{memories:context.memories.map(row=>({...row,messages:row.messages.map(project)}))}:{}),
    ...(context.summaries?{summaries:context.summaries.map(row=>({...row,excerpts:row.excerpts.map(line=>project(line))}))}:{})};
}

function clip(text, length) {
  const chars = Array.from(text);
  return chars.length <= length ? text : chars.slice(0,length).join('');
}

function quote(line, length) {
  const text = clip(line.text,length);
  const out = {speaker:line.role === 'user' ? '用户' : 'ASKA', source_ref:line.source_ref,
    start:line.start, end:line.start+text.length, text};
  if (line.translation) out.translation = clip(line.translation,length);
  return out;
}

export function interactionContextForModel(memory, {
  text = '', cue = null, at = Date.now(), request_id = null, explicit = false, maxBytes = 4800
} = {}) {
  const packet = {memories:[],summaries:[]};
  const size = () => Buffer.byteLength(JSON.stringify(packet));
  if (!Number.isSafeInteger(maxBytes) || maxBytes < size()) throw new RangeError('Interaction context byte budget');
  const used = new Set();
  const hits = memory.recall({text,cue,at,explicit,limit:4}).filter(hit => hit.request_id !== request_id);
  for (const hit of hits) {
    if (packet.memories.length >= recalledTurns) break;
    const association = hit.routes.includes('keyword') ? '话题' : '相近的人格状态';
    const memoryRow = {at:new Date(hit.at).toISOString(),channel:hit.channel,group_id:hit.group_id,
      association,messages:[]};
    packet.memories.push(memoryRow);
    // Keep the actual lexical hit when the companion line exceeds the budget.
    const ordered = [...hit.messages].sort((a,b) =>
      Number(hit.matched_source_refs.includes(b.source_ref))-Number(hit.matched_source_refs.includes(a.source_ref)));
    for (const line of ordered) {
      memoryRow.messages.push({...quote(line,135),...(line.at!==hit.at?{at:new Date(line.at).toISOString()}:{})});
      if (size() > maxBytes) memoryRow.messages.pop();
      else used.add(line.source_ref);
    }
    if (!memoryRow.messages.length) packet.memories.pop();
    else memoryRow.messages.sort((a,b) => Number(b.speaker==='用户')-Number(a.speaker==='用户'));
  }
  if (!used.size) return packet;
  const selected = hits.filter(hit => hit.source_refs.some(ref => used.has(ref)));
  const [event] = memory.summaries({request_ids:selected.map(hit => hit.request_id),at,limit:1});
  if (!event) return packet;
  const digest = {started_at:new Date(event.started_at).toISOString(),ended_at:new Date(event.ended_at).toISOString(),
    group_id:event.group_id,excerpts:[]};
  packet.summaries.push(digest);
  for (const line of event.excerpts) {
    if (line.request_id === request_id || used.has(line.source_ref)) continue;
    digest.excerpts.push({at:new Date(line.at).toISOString(),group_id:line.group_id,channel:line.channel,...quote(line,75)});
    if (size()>maxBytes) digest.excerpts.pop();
    if (digest.excerpts.length>=4) break;
  }
  if (!digest.excerpts.length) packet.summaries.pop();
  return packet;
}
