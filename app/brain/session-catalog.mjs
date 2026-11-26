// Compact sidebar metadata. Pi JSONL files remain authoritative for messages and identities.
import fs from 'node:fs';
import path from 'node:path';
import {setImmediate as yieldToServer} from 'node:timers/promises';
import {parseSessionEntries} from '@earendil-works/pi-coding-agent';
import {parseStreamingJson} from '@earendil-works/pi-ai';
import {readTitleIndex,editTitleIndex} from './session-title-index.mjs';

const HEAD_LIMIT = 16 * 1024;
const TAIL_LIMIT = 8 * 1024;
// Pi's own discovery accepts a large first header (e.g. a long imported cwd).
const HEADER_LIMIT = 1024 * 1024;
const TITLE_LIMIT = 64;

function fileStamp(file) {
  const stat = fs.lstatSync(file, {throwIfNoEntry:false});
  if (!stat?.isFile()) return null;
  return {size:stat.size, mtime:stat.mtimeMs, key:[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':')};
}

function shortTitle(value) {
  if (typeof value !== 'string') return '';
  const first = value.trimStart().split(/[\r\n]/, 1)[0];
  return Array.from(first.slice(0, TITLE_LIMIT * 2)).slice(0,TITLE_LIMIT).join('').trim();
}

function userTitle(message) {
  const content = message?.content;
  if (typeof content === 'string') return shortTitle(content);
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (block?.type === 'text') {
      const title = shortTitle(block.text);
      if (title) return title;
    }
  }
  return '';
}

// Pi owns Light message objects. Its immutable start/result entries identify the
// turn. General records both halves directly on the user/assistant messages.
export function callMessageEntries(entries) {
  const calls = new Set();
  const playback = new Set();
  let activeRequest = null, hasInput = false;
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === 'asuka.request.start.v1') {
      activeRequest = entry.data?.surface === 'call' ? entry.data.id : null;
      hasInput = false;
      continue;
    }
    if (entry.type === 'custom' && entry.customType === 'asuka.request.result.v1') {
      const id = entry.data?.response?.behavior?.playback_id;
      if (entry.data?.surface === 'call' && typeof id === 'string')
        playback.add(id.slice(id.lastIndexOf(':') + 1));
      if (activeRequest === entry.data?.id) activeRequest = null;
      continue;
    }
    if (entry.type === 'custom_message' || entry.message?.role === 'custom') {
      hasInput = true;
      continue;
    }
    const m = entry.message;
    if (entry.type !== 'message' || !m) continue;
    if (m.asukaInput || m.asukaNative) {
      activeRequest = null;
      if (m.asukaInput?.surface === 'call' || m.asukaNative?.record?.surface === 'call') calls.add(entry);
    } else if (m.role === 'user') {
      if (hasInput) activeRequest = null;
      if (activeRequest) calls.add(entry);
      hasInput = true;
    } else if (m.role === 'assistant') {
      if (activeRequest) calls.add(entry);
      if (m.stopReason !== 'toolUse') activeRequest = null;
    }
  }
  if (playback.size) for (const entry of entries) if (playback.has(entry.id)) calls.add(entry);
  return calls;
}

function firstChatTitle(entries) {
  const calls = callMessageEntries(entries);
  for (const entry of entries) {
    if (entry.message?.role === 'user' && !calls.has(entry)) {
      const title = userTitle(entry.message);
      if (title) return title;
    }
  }
  return '';
}

function describe(header, entries, stamp, complete) {
  let name = '', count = 0, activity = 0;
  const first = firstChatTitle(entries);
  for (const entry of entries) {
    if (entry?.type === 'session_info') name = shortTitle(entry.name);
    if (entry?.type !== 'message' || !entry.message) continue;
    count++;
    const {role,timestamp} = entry.message;
    if (role !== 'assistant' && role !== 'user') continue;
    const when = typeof timestamp === 'number' ? timestamp : Date.parse(entry.timestamp);
    if (Number.isFinite(when)) activity = Math.max(activity, when);
  }
  const fallback = (complete && Date.parse(header.timestamp)) || stamp.mtime;
  return {id:header.id,cwd:header.cwd,title:name || first || (complete ? (count ? '语音通话' : '新对话') : '历史对话'),
    modified:new Date(activity || fallback).toISOString(),messageCount:complete ? count : null};
}

function readPart(fd, begin, length) {
  const buffer = Buffer.allocUnsafe(length);
  const read = fs.readSync(fd,buffer,0,length,begin);
  return buffer.subarray(0,read);
}

function legacySummary(file, stamp, headerOnly=false) {
  // Old files store the title inside messages. Read complete lines in bounded
  // windows, leave large attachment rows alone, and upgrade names on select.
  const fd = fs.openSync(file,'r');
  try {
    let head = Buffer.alloc(0), prefix = [];
    const headLimit = Math.min(HEAD_LIMIT,Math.max(1024,Math.ceil(stamp.size/4)));
    while (head.length < stamp.size) {
      const limit = prefix.length ? headLimit : HEADER_LIMIT;
      if (head.length >= limit) break;
      const length = Math.min(Math.max(1024,Math.min(head.length,16*1024)), stamp.size-head.length, limit-head.length);
      const part = readPart(fd,head.length,length);
      if (!part.length) break;
      head = Buffer.concat([head,part]);
      const end = head.length === stamp.size ? head.length : head.lastIndexOf(10)+1;
      prefix = parseSessionEntries(head.subarray(0,end).toString('utf8'));
      if (prefix.length && prefix[0]?.type !== 'session') return null;
      if (headerOnly && prefix.length) break;
      if (firstChatTitle(prefix)) break;
    }
    const header = prefix[0];
    if (header?.type !== 'session' || typeof header.id !== 'string' || !header.id) return null;
    if (headerOnly) return header;
    if (typeof header.cwd !== 'string' || !header.cwd) return null;
    if (head.length >= stamp.size) return describe(header,prefix,stamp,true);
    const tailLimit = Math.min(TAIL_LIMIT,Math.max(512,Math.ceil(stamp.size/4)));
    let begin = Math.max(head.length,stamp.size-tailLimit);
    if (begin === head.length) {
      const tail = readPart(fd,begin,stamp.size-begin);
      return describe(header,parseSessionEntries(Buffer.concat([head,tail]).toString('utf8')),stamp,true);
    }
    let tail = readPart(fd,begin-1,stamp.size-begin+1), recent;
    const earliest = Math.max(head.length,stamp.size-Math.min(64*1024,Math.ceil(stamp.size/2)));
    const chatEntry = e=>e?.type==='message' && ['user','assistant'].includes(e.message?.role);
    for (;;) {
      const newline = tail.indexOf(10);
      recent = newline < 0 ? [] : parseSessionEntries(tail.subarray(newline+1).toString('utf8'));
      if (recent.some(chatEntry) || begin <= earliest) break;
      const count = Math.min(TAIL_LIMIT,begin-earliest);
      begin -= count;
      tail = Buffer.concat([readPart(fd,begin-1,count),tail]);
    }
    // SDK user entries place text before image data. A complete text block
    // can supply a title without decoding the rest of a multi-megabyte line.
    const meta = describe(header,[...prefix,...recent],stamp,false);
    const named = [...prefix,...recent].findLast(entry=>entry?.type==='session_info');
    const first = firstChatTitle(prefix);
    meta.title = shortTitle(named?.name) || first;
    if (!meta.title) {
      const partial = parseStreamingJson(head.subarray(head.lastIndexOf(10)+1).toString('utf8'));
      const preview = partial?.type==='message' && partial.message?.role==='user' ? firstChatTitle([...prefix,partial]) : '';
      meta.title = preview || (callMessageEntries(prefix).size ? '语音通话' : '历史对话');
    }
    // If a long trailing row covers the whole window its actual activity time
    // is unavailable until this conversation is selected.
    if (!recent.some(chatEntry))
      meta.modified = new Date(stamp.mtime).toISOString();
    return meta;
  } finally {
    fs.closeSync(fd);
  }
}

export function storedSessionId(file) {
  const stamp=fileStamp(file), header=stamp && legacySummary(file,stamp,true);
  if (!header) throw Object.assign(new Error('无法核实会话文件归属'),{code:'SESSION_CHANGED'});
  return header.id;
}

export class SessionCatalog {
  constructor(directory,cwd,removalFilter) {
    this.directory=path.resolve(directory);
    this.cwd=path.resolve(cwd);
    this.removalFilter=removalFilter;
    this.memo=null;
    this.loaded=new WeakMap();
  }

  entries() {
    if (!this.memo) {
      try { this.memo=readTitleIndex(this.directory); }
      catch { this.memo=new Map(); }
    }
    return this.memo;
  }

  persist(updates, missing=[]) {
    if (!updates.size && !missing.length) return;
    try {
      editTitleIndex(this.directory, writer=>{
        // Recheck deletion receipts under the database write lock. A late
        // discovery from another process cannot restore an erased title.
        const removed=this.removalFilter();
        for (const [name,entry] of updates) {
          if (!removed(entry.summary.id) && fileStamp(path.join(this.directory,name))?.key===entry.stamp) {
            writer.put(name,entry);
          }
        }
        for (const name of missing) {
          if (!fs.existsSync(path.join(this.directory,name))) writer.drop(name);
        }
      });
    } catch { /* A busy, corrupt or read-only cache cannot block chat. */ }
  }

  remember(manager) {
    const file=manager.getSessionFile();
    if (!file) return;
    try {
      const name=path.basename(file), stamp=fileStamp(file);
      if (!stamp) return;
      const memo=this.entries();
      if (this.loaded.get(manager)===stamp.key && memo.has(name)) return memo.get(name).summary;
      const summary=describe(manager.getHeader(),manager.getEntries(),stamp,true);
      if (this.removalFilter()(summary.id)) return;
      this.loaded.set(manager,stamp.key);
      if (path.dirname(file)===this.directory && summary.cwd && path.resolve(summary.cwd)===this.cwd) {
        const entry={stamp:stamp.key,summary};
        memo.set(name,entry);
        this.persist(new Map([[name,entry]]));
      }
      return summary;
    } catch { /* Metadata maintenance is independent of the saved reply. */ }
  }

  isLoaded(manager,file) {
    if (!file || path.resolve(manager.getSessionFile() || '.')!==file) return false;
    const stamp=fileStamp(file);
    return Boolean(stamp && this.loaded.get(manager)===stamp.key);
  }

  async list() {
    let names;
    try { names=await fs.promises.readdir(this.directory,{withFileTypes:true}); }
    catch (error) { if (error.code==='ENOENT') return []; throw error; }

    const rows=[], memo=this.entries(), present=new Set(), updates=new Map();
    const removed=this.removalFilter();
    for (const candidate of names) {
      const name=candidate.name;
      if (!candidate.isFile() || !name.endsWith('.jsonl')) continue;
      present.add(name);
      if (present.size%32===0) await yieldToServer();
      const file=path.join(this.directory,name);
      try {
        const stamp=fileStamp(file);
        if (!stamp) continue;
        const cached=memo.get(name);
        let summary=cached?.stamp===stamp.key && validSummary(cached.summary) ? cached.summary : null;
        if (!summary) {
          summary=legacySummary(file,stamp);
          if (!summary || path.resolve(summary.cwd)!==this.cwd || removed(summary.id)) continue;
          const entry={stamp:stamp.key,summary};
          memo.set(name,entry);
          updates.set(name,entry);
        } else if (path.resolve(summary.cwd)!==this.cwd || removed(summary.id)) continue;
        rows.push({id:summary.id,path:file,title:summary.title,modified:summary.modified,
          updated_ms:Date.parse(summary.modified),messageCount:summary.messageCount,cwd:summary.cwd});
      } catch { /* One damaged history does not invalidate the other titles. */ }
    }
    const missing=[];
    for (const name of memo.keys()) {
      if (!present.has(name) && !fs.existsSync(path.join(this.directory,name))) {
        memo.delete(name);
        missing.push(name);
      }
    }
    this.persist(updates,missing);
    const removedNow=this.removalFilter();
    return rows.filter(row=>!removedNow(row.id)).sort((a,b)=>b.updated_ms-a.updated_ms || b.path.localeCompare(a.path));
  }

  forget(file) {
    if (file) this.memo?.delete(path.basename(file));
  }
}

function validSummary(row) {
  return typeof row?.id==='string' && row.id && typeof row.cwd==='string' && row.cwd &&
    typeof row.title==='string' && row.title===shortTitle(row.title) && Number.isFinite(Date.parse(row.modified)) &&
    (row.messageCount===null || Number.isSafeInteger(row.messageCount) && row.messageCount>=0);
}
