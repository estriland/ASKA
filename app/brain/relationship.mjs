import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {visibleFileMessage} from './file-attachments.mjs';
import {InteractionMemory} from './interaction-memory.mjs';
import {readInteractionCue,interactionContextForModel} from './relationship-reading.mjs';
import {InitiativeScheduler} from './initiative-scheduler.mjs';
import {followupIdentity,publishedFollowupParent} from './immediate-followup.mjs';
import {publishImmutableDialogueJson} from './dialogue-profile.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=message=>{throw Object.assign(Error(message),{code:'RELATIONSHIP_INPUT'});};
const trimmed=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max&&!v.includes('\0')?v.trim():null;
const textOf=m=>typeof m?.content==='string'?m.content:(m?.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('');
const stamp=v=>Number.isFinite(v)?Math.trunc(v):Date.parse(v)||Date.now();
const json=value=>JSON.stringify(value);

export class Relationship {
  constructor(directory,{onProjectionError=()=>{}}={}){
    fs.mkdirSync(directory,{recursive:true});
    const file=path.join(directory,'relationship.json');
    if(!fs.existsSync(file))publishImmutableDialogueJson(file,{schema:'feiniao.relationship/1',id:randomUUID()});
    const identity=JSON.parse(fs.readFileSync(file,'utf8'));
    if(identity.schema!=='feiniao.relationship/1'||!uuid.test(identity.id))fail('关系资料身份无效');
    this.id=identity.id;
    this.directory=directory;
    this.db=new DatabaseSync(path.join(directory,'timeline.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS topic_groups(id TEXT PRIMARY KEY,title TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS call_log(id TEXT PRIMARY KEY,group_id TEXT,started INTEGER NOT NULL,ended INTEGER,reason TEXT);
      CREATE TABLE IF NOT EXISTS turn_sources(request_id TEXT PRIMARY KEY,group_id TEXT,call_id TEXT,at INTEGER NOT NULL,
        user_entry TEXT,assistant_entry TEXT,result_entry TEXT,initiative INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS turn_topic ON turn_sources(group_id,at);
      CREATE INDEX IF NOT EXISTS turn_call ON turn_sources(call_id,at);
      CREATE TABLE IF NOT EXISTS call_breaks(request_id TEXT PRIMARY KEY,call_id TEXT NOT NULL,at INTEGER NOT NULL,details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS removed_turns(request_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS removed_calls(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS replay_cleanup(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS erase_job(single INTEGER PRIMARY KEY CHECK(single=1),ids TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relationship_meta(key TEXT PRIMARY KEY,value TEXT);
    `);
    if(!this.db.prepare('PRAGMA table_info(turn_sources)').all().some(column=>column.name==='origin_group_id')){
      this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE turn_sources ADD COLUMN origin_group_id TEXT;
        ALTER TABLE turn_sources ADD COLUMN group_title TEXT;
        UPDATE turn_sources SET origin_group_id=group_id,group_title=(SELECT title FROM topic_groups WHERE id=group_id);
        COMMIT`);
    }
    if(!this.db.prepare('PRAGMA table_info(call_log)').all().some(column=>column.name==='emptied'))
      this.db.exec('ALTER TABLE call_log ADD COLUMN emptied INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(turn_sources)').all().some(column=>column.name==='ask_dispatched'))
      this.db.exec('ALTER TABLE turn_sources ADD COLUMN ask_dispatched INTEGER NOT NULL DEFAULT 0');
    this.memory=new InteractionMemory(this.db,this.id,{resolveTurn:id=>this.resolveTurn(id)});
    this.scheduler=new InitiativeScheduler(this.db,this.id);
    this.sm=null;this.cursor=null;this.indexRetry=null;this.onProjectionError=onProjectionError;
  }
  groups(){return this.db.prepare('SELECT id,title,created FROM topic_groups ORDER BY created,id').all();}
  createGroup(title){
    title=trimmed(title,80);if(!title)fail('请填写 1 至 80 字的分组名');
    const group={id:randomUUID(),title,created:Date.now()};
    this.db.prepare('INSERT INTO topic_groups VALUES(?,?,?)').run(group.id,title,group.created);return group;
  }
  validGroup(id){
    if(id==null)return null;
    if(!uuid.test(id)||!this.db.prepare('SELECT 1 FROM topic_groups WHERE id=?').get(id))fail('分组不存在');
    return id;
  }
  renameGroup(id,title){
    this.validGroup(id);title=trimmed(title,80);if(!title)fail('请填写 1 至 80 字的分组名');
    this.db.prepare('UPDATE topic_groups SET title=? WHERE id=?').run(title,id);
  }
  removeGroup(id){
    if(!id)fail('请选择分组');this.validGroup(id);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare('UPDATE turn_sources SET group_id=NULL WHERE group_id=?').run(id);
      this.db.prepare('UPDATE call_log SET group_id=NULL WHERE group_id=?').run(id);
      this.db.prepare('DELETE FROM topic_groups WHERE id=?').run(id);
      this.scheduler.removeGroup(id);
      this.memory.syncTurns(this.turns());
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  source(id){return typeof id==='string'?this.db.prepare('SELECT * FROM turn_sources WHERE request_id=?').get(id):null;}
  firstAskDispatch(id){
    // A telephone's requesting event reserves its group before /ask. It does
    // not claim the model dispatch. Old published turns and retries stay closed.
    return Boolean(this.db.prepare(`UPDATE turn_sources SET ask_dispatched=1
      WHERE request_id=? AND ask_dispatched=0 AND user_entry IS NULL AND assistant_entry IS NULL`).run(id).changes);
  }
  reserve(body,at=Date.now()){
    const id=trimmed(body.request_id,96);if(!id)fail('消息缺少正式编号');
    if(this.db.prepare('SELECT 1 FROM removed_turns WHERE request_id=?').get(id))fail('这条消息已删除');
    const call=body.call_id??null;
    if(call&&this.db.prepare('SELECT 1 FROM removed_calls WHERE id=?').get(call))fail('这次通话记录已删除');
    const known=this.source(id);
    if(known){
      if(known.call_id!==call || (Object.hasOwn(body,'group_id')&&
         body.group_id!==known.origin_group_id&&body.group_id!==known.group_id))fail('消息编号已用于其他分组或通话');
      return known;
    }
    if(call&&!uuid.test(call))fail('通话编号无效');
    const savedCall=call&&this.db.prepare('SELECT * FROM call_log WHERE id=?').get(call);
    const group=savedCall?savedCall.group_id:this.validGroup(body.group_id??null);
    if(call&&!savedCall)this.db.prepare('INSERT INTO call_log(id,group_id,started) VALUES(?,?,?)').run(call,group,at);
    const title=this.db.prepare('SELECT title FROM topic_groups WHERE id=?').get(group)?.title??null;
    this.db.prepare('INSERT INTO turn_sources(request_id,group_id,origin_group_id,group_title,call_id,at) VALUES(?,?,?,?,?,?)')
      .run(id,group,group,title,call,at);
    return this.source(id);
  }
  markEntry(id,column,entry,metadata={},at=Date.now()){
    if(!id||this.db.prepare('SELECT 1 FROM removed_turns WHERE request_id=?').get(id))return;
    if(!this.source(id)){
      const group=this.db.prepare('SELECT id FROM topic_groups WHERE id=?').get(metadata.group_id??'')?.id??null;
      this.reserve({request_id:id,group_id:group,call_id:metadata.call_id},at);
      if(uuid.test(metadata.group_id))this.db.prepare('UPDATE turn_sources SET origin_group_id=?,group_title=COALESCE(?,group_title) WHERE request_id=?')
        .run(metadata.group_id,trimmed(metadata.group_title,80),id);
    }
    const columns={user:'user_entry',assistant:'assistant_entry',result:'result_entry'};
    this.db.prepare('UPDATE turn_sources SET '+columns[column]+'=? WHERE request_id=?').run(entry,id);
  }
  attach(session,generalRoot){
    this.sm=session.sessionManager;this.generalRoot=generalRoot;
    this.cursor=this.db.prepare("SELECT value FROM relationship_meta WHERE key='leaf'").get()?.value??null;
    this.sync(session);
    // Delivery and its native cue are separate durable commits. The desktop
    // may have exited between them even when Pi's last entry is unchanged.
    if(generalRoot){
      const recent=this.db.prepare(`SELECT t.request_id FROM turn_sources t JOIN interaction_turns m
        ON m.request_id=t.request_id AND m.relation=? WHERE m.cue IS NULL AND t.assistant_entry IS NOT NULL
        ORDER BY t.at DESC,t.rowid DESC LIMIT 6`).all(this.id);
      for(const {request_id} of recent){
        try{if(this.resolveTurn(request_id)?.general)this.indexTurn(request_id);}
        catch(error){this.onProjectionError(error);break;}
      }
    }
  }
  recoverCalls(){
    this.db.exec("UPDATE call_log SET ended=COALESCE((SELECT MAX(t.at) FROM turn_sources t WHERE t.call_id=call_log.id),started), reason='restart' WHERE ended IS NULL");
    for(const row of this.db.prepare('SELECT id FROM call_log WHERE emptied=1').all())this.pruneEmptyCall(row.id);
  }
  pruneEmptyCall(id){
    if(this.db.prepare('SELECT 1 FROM turn_sources WHERE call_id=? LIMIT 1').get(id))return;
    // A deletion may be confirmed as the user hangs up. Keep the active
    // session available to new speech until it actually ends.
    this.db.prepare('UPDATE call_log SET emptied=1 WHERE id=?').run(id);
    this.db.prepare('INSERT OR IGNORE INTO removed_calls SELECT id FROM call_log WHERE id=? AND ended IS NOT NULL').run(id);
    this.db.prepare('DELETE FROM call_log WHERE id=? AND ended IS NOT NULL').run(id);
  }
  sync(session){
    const sm=session.sessionManager;if(sm.getSessionId()!==this.id)fail('关系会话已改变');
    this.sm=sm;const leaf=sm.getLeafId();if(leaf===this.cursor)return;
    if(this.indexRetry?.leaf===leaf&&Date.now()<this.indexRetry.after)return;
    const tail=[];let e=sm.getLeafEntry();
    while(e&&e.id!==this.cursor){tail.push(e);e=e.parentId?sm.getEntry(e.parentId):null;}
    const rebuilt=!!this.cursor&&!e;
    if(rebuilt)this.db.exec('UPDATE turn_sources SET user_entry=NULL,assistant_entry=NULL,result_entry=NULL');
    const changed=new Set();
    let current=null;
    if(e&&!rebuilt){
      for(let p=e;p;p=p.parentId?sm.getEntry(p.parentId):null){
        if(p.customType==='asuka.request.start.v1'){current=p.data;break;}
        if(p.message?.role==='assistant'||p.message?.asukaInput||p.customType==='asuka.request.result.v1')break;
      }
    }
    for(const entry of tail.reverse()){
      const m=entry.message,at=stamp(m?.timestamp??entry.timestamp);
      if(entry.customType==='asuka.request.start.v1'){current=entry.data;continue;}
      if(entry.customType==='asuka.request.result.v1'){
        const d=entry.data;if(!d?.id)continue;
        const play=d.response?.behavior?.playback_id;
        if(typeof play==='string'&&play.startsWith(this.id+':'))this.markEntry(d.id,'assistant',play.slice(this.id.length+1),d,at);
        this.markEntry(d.id,'result',entry.id,d,at);changed.add(d.id);current=null;continue;
      }
      if(m?.role==='custom'){current=null;continue;}
      if(m?.role==='user'){
        const marker=m.asukaInput??current;
        const id=marker?.request_id??marker?.id;if(id){this.markEntry(id,'user',entry.id,marker,at);changed.add(id);}
      }else if(m?.role==='assistant'&&!['error','aborted','toolUse'].includes(m.stopReason)){
        const marker=m.asukaInitiative??m.asukaNative?.record??current;
        const id=marker?.request_id??marker?.client_request_id??marker?.id;
        if(id){
          this.markEntry(id,'assistant',entry.id,marker,at);changed.add(id);
          if(m.asukaInitiative)this.db.prepare('UPDATE turn_sources SET initiative=1 WHERE request_id=?').run(id);
        }
        current=null;
      }
    }
    try{
      if(rebuilt)this.memory.syncTurns(this.turns());
      for(const id of changed)this.indexTurn(id);
    }catch(error){
      // The Pi pointers above already support history and replay. Keep the
      // previous durable cursor so a healthy index can catch up after restart.
      if(!this.indexRetry)this.onProjectionError(error);
      this.indexRetry={leaf,after:Date.now()+5000};
      return;
    }
    this.indexRetry=null;
    this.db.prepare("INSERT OR REPLACE INTO relationship_meta VALUES('leaf',?)").run(leaf??'');this.cursor=leaf;
  }
  resolveTurn(id){
    const row=this.source(id);if(!row||!this.sm||(!row.user_entry&&!row.assistant_entry))return null;
    const user=this.sm.getEntry(row.user_entry)?.message,assistantEntry=this.sm.getEntry(row.assistant_entry),assistant=assistantEntry?.message;
    const saved=this.sm.getEntry(row.result_entry)?.data?.response?.behavior;
    let behavior=saved;
    if(!behavior&&assistant){try{behavior=JSON.parse(textOf(assistant));}catch{behavior=null;}}
    // An SDK completion awaiting format repair has not been published.
    if(assistant&&!saved&&!assistant.asukaNative&&!assistant.asukaInitiative&&!assistant.asukaPublic)behavior=null;
    const speech=typeof behavior?.speech==='string'&&!behavior.error?behavior.speech:'';
    // General appends its pair after inference. Its SDK user timestamp is the
    // save time; the reservation is the durable moment of the user's request.
    const general=assistant?.asukaNative?.record??null;
    const userAt=user?stamp(general?row.at:user.timestamp??row.at):null;
    const assistantAt=assistant?stamp(general?assistantEntry.timestamp:assistant.timestamp??row.at):null;
    return {request_id:id,group_id:row.group_id,origin_group_id:row.origin_group_id??assistant?.asukaNative?.record?.group_id??assistant?.asukaInitiative?.group_id??user?.asukaInput?.group_id??this.sm.getEntry(row.result_entry)?.data?.group_id??null,
      call_id:row.call_id,at:row.at,userAt,assistantAt,channel:row.call_id?'call':'chat',
      user:visibleFileMessage(textOf(user)),assistant:speech,translation:behavior?.translation||'',
      user_ref:id+':user',assistant_ref:id+':assistant',has_image:Array.isArray(user?.content)&&user.content.some(b=>b.type==='image'),
      playback_id:behavior?.playback_id||(assistant?this.id+':'+row.assistant_entry:null),
      parts:behavior?.parts,read:!!(saved||assistant?.asukaNative||assistant?.asukaPublic),published:!!behavior,
      initiative:!!row.initiative,general};
  }
  indexTurn(id){
    const turn=this.resolveTurn(id);if(!turn||!turn.published||(!turn.user&&!turn.assistant))return;
    if(turn.call_id)this.db.prepare('UPDATE call_log SET emptied=0 WHERE id=? AND emptied=1').run(turn.call_id);
    const cue=turn.general&&this.generalRoot?readInteractionCue(this.generalRoot,turn.general):null;
    this.memory.recordTurn({...turn,...(cue?{cue}:{})});
    if(!turn.initiative&&turn.user)this.scheduler.recordTurn({requestId:id,groupId:turn.group_id,userText:turn.user,assistantText:turn.assistant,assistantTranslation:turn.translation,
      userId:turn.user_ref,assistantId:turn.assistant_ref,userAt:turn.userAt??turn.at,at:turn.assistantAt??turn.at,engagement:cue});
    if(turn.initiative){
      const parent=publishedFollowupParent(this.id,this.sm.getEntry(this.source(id).assistant_entry)?.message);
      if(parent)this.scheduler.noteImmediatePublished(parent);
    }
    if(cue)this.scheduler.updateEngagement(id,cue);
  }
  turns(){
    return this.db.prepare('SELECT request_id FROM turn_sources WHERE user_entry IS NOT NULL OR assistant_entry IS NOT NULL ORDER BY at,rowid').all()
      .map(row=>this.resolveTurn(row.request_id)).filter(t=>t?.published);
  }
  context(body){
    if(!body.request_id)return null;
    const row=this.reserve(body);
    // The desktop may hang up the new turn before its HTTP reply starts. Look
    // at the preceding conversational turn first, then its own playback receipt.
    const heard=this.db.prepare(`WITH previous AS (
      SELECT t.request_id,t.call_id FROM turn_sources t,turn_sources current
      WHERE current.request_id=? AND (t.at,t.rowid)<(current.at,current.rowid)
      AND (t.user_entry IS NOT NULL OR t.assistant_entry IS NOT NULL OR EXISTS
        (SELECT 1 FROM call_breaks b WHERE b.request_id=t.request_id AND b.call_id=t.call_id))
      ORDER BY t.at DESC,t.rowid DESC LIMIT 1)
      SELECT b.details FROM previous p JOIN call_breaks b ON b.request_id=p.request_id AND b.call_id=p.call_id`).get(row.request_id);
    const context=row.group_title?{topic_group:row.group_title}:{};
    if(!this.indexRetry){
      try{
        const cue=this.memory.latestCue({at:row.at});
        Object.assign(context,interactionContextForModel(this.memory,{text:body.message??'',cue:cue?.cue??null,at:row.at,request_id:body.request_id}));
      }catch(error){this.onProjectionError(error);}
    }
    if(heard)context.interrupted_playback=JSON.parse(heard.details);
    if(!context.memories?.length)delete context.memories;
    if(!context.summaries?.length)delete context.summaries;
    return Object.keys(context).length?context:null;
  }
  list(){return {ok:true,id:this.id,path:this.sm?.getSessionFile()??null,groups:this.groups(),
    replay_cleanup:this.db.prepare('SELECT id FROM replay_cleanup').all().map(r=>r.id)};}
  rowsForTurn(t){
    if(!t)return [];
    const meta={request_id:t.request_id,group_id:t.group_id,at:t.at,...(t.call_id?{call_id:t.call_id,surface:'call'}:{})};
    const edge=t.call_id?this.db.prepare('SELECT details FROM call_breaks WHERE request_id=? AND call_id=?').get(t.request_id,t.call_id):null;
    return [...(t.user||t.has_image?[{...meta,role:'user',content:t.user,hasImage:t.has_image,read:t.read,source_ref:t.user_ref}]:[]),
      ...(t.assistant?[{...meta,role:'assistant',content:t.assistant,speech:t.assistant,translation:t.translation,parts:t.parts,
        playback_id:t.playback_id,source_ref:t.assistant_ref,initiative:t.initiative,...(edge?{playback_boundary:JSON.parse(edge.details)}:{})}]:[])];
  }
  history({group_id=null,call_id=null,request_id=null,before=null,limit=60}={}){
    if(group_id)this.validGroup(group_id);
    if(call_id&&!uuid.test(call_id))fail('通话编号无效');
    if(request_id){
      const turn=this.resolveTurn(request_id);
      const messages=turn&&(!group_id||turn.group_id===group_id)&&(!call_id||turn.call_id===call_id)?this.rowsForTurn(turn):[];
      return {ok:true,id:this.id,messages,more:null,completed_requests:messages.filter(m=>m.role==='assistant').map(m=>m.request_id)};
    }
    limit=Math.max(1,Math.min(150,Number.isSafeInteger(limit)?limit:60));
    if(before&&(!Number.isSafeInteger(before.at)||!trimmed(before.id,96)))fail('历史位置无效');
    const items=this.db.prepare(`WITH entries AS (SELECT request_id AS id,at,'turn' AS kind FROM turn_sources
      WHERE (user_entry IS NOT NULL OR assistant_entry IS NOT NULL) AND (? IS NULL OR group_id=?) AND
      ((? IS NULL AND call_id IS NULL) OR call_id=?)
      UNION ALL SELECT id,started AS at,'call' AS kind FROM call_log WHERE emptied=0 AND ? IS NULL AND (? IS NULL OR group_id=?))
      SELECT * FROM entries WHERE (? IS NULL OR (at,id)<(?,?)) ORDER BY at DESC,id DESC LIMIT ?`)
      .all(group_id,group_id,call_id,call_id,call_id,group_id,group_id,before?.at??null,before?.at??0,before?.id??'',limit+1);
    const selected=items.slice(0,limit),oldest=selected.at(-1);
    const messages=selected.reverse().flatMap(i=>{
      if(i.kind==='turn')return this.rowsForTurn(this.resolveTurn(i.id));
      const record=this.db.prepare('SELECT * FROM call_log WHERE id=?').get(i.id);
      return [{role:'call',content:'语音通话',call_id:i.id,at:i.at,group_id:record.group_id,started_at:i.at,ended_at:record.ended,reason:record.reason,
        count:this.db.prepare('SELECT count(*) AS n FROM turn_sources WHERE call_id=? AND (user_entry IS NOT NULL OR assistant_entry IS NOT NULL)').get(i.id).n}];
    });
    return {ok:true,id:this.id,messages,more:items.length>limit?{at:oldest.at,id:oldest.id}:null,
      completed_requests:messages.filter(m=>m.role==='assistant').map(m=>m.request_id)};
  }
  callEvent(body){
    const id=body.call_id;if(!uuid.test(id))fail('通话编号无效');
    if(!['started','ended','requesting','interrupted'].includes(body.kind))fail('通话事件无效');
    if(this.db.prepare('SELECT 1 FROM removed_calls WHERE id=?').get(id)||
       body.request_id&&this.db.prepare('SELECT 1 FROM removed_turns WHERE request_id=?').get(body.request_id))
      return {ok:true,skipped:true};
    const now=Date.now(),at=Number.isSafeInteger(body.occurred_at)&&body.occurred_at>0&&body.occurred_at<=now+60000?body.occurred_at:now;
    const saved=this.db.prepare('SELECT * FROM call_log WHERE id=?').get(id);
    if(!saved&&body.kind!=='started')fail('找不到对应的通话');
    if(!saved)this.db.prepare('INSERT INTO call_log(id,group_id,started) VALUES(?,?,?)').run(id,this.validGroup(body.group_id??null),at);
    if(body.kind==='ended'){
      this.db.prepare("UPDATE call_log SET ended=MAX(started,?),reason=? WHERE id=? AND (ended IS NULL OR reason='restart')")
        .run(at,trimmed(body.reason,48)||'hangup',id);
      if(saved.emptied)this.pruneEmptyCall(id);
    }else if(body.kind==='requesting'){
      this.reserve(body,at);
    }
    else if(body.kind==='interrupted'){
      const turn=this.source(body.request_id);
      if(!turn||turn.call_id!==id)fail('打断记录与通话不符');
      const published=this.resolveTurn(body.request_id)?.assistant??'';
      const prefix=typeof body.heard_prefix==='string'?body.heard_prefix.slice(0,4000):'';
      if(!Number.isFinite(body.played_ms)||body.played_ms<0||
         (body.onset_played_ms!=null&&(!Number.isFinite(body.onset_played_ms)||body.onset_played_ms<0))||
         (body.segment_index!=null&&(!Number.isSafeInteger(body.segment_index)||body.segment_index<0)))fail('播放位置无效');
      const details={request_id:body.request_id,source:'call_playback',heard_prefix:prefix,estimated:true,
        played_ms:Math.max(0,Math.round(Number(body.played_ms)||0)),overlap:body.overlap===true,reason:trimmed(body.reason,48)||'user_speech',
        ...(Number.isFinite(body.onset_played_ms)?{onset_played_ms:Math.max(0,Math.round(body.onset_played_ms))}:{}),
        ...(Number.isInteger(body.segment_index)?{segment_index:body.segment_index}:{})};
      if(prefix&&!published.replace(/\s/g,'').startsWith(prefix.replace(/\s/g,'')))details.heard_prefix='';
      this.db.prepare('INSERT OR IGNORE INTO call_breaks VALUES(?,?,?,?)').run(body.request_id,id,at,json(details));
    }else if(body.kind!=='started')fail('通话事件无效');
    return {ok:true};
  }
  initiativeItem(session,claim){
    this.sync(session);const turn=this.resolveTurn('initiative:'+claim.id);
    if(!turn?.initiative)return null;
    return {id:claim.id,token:claim.token,groupId:turn.group_id,call_id:turn.call_id,request_id:turn.request_id,playback_id:turn.playback_id,
      behavior:{...claim.draft,speech:turn.assistant,translation:turn.translation,playback_id:turn.playback_id,initiative:true}};
  }
  addInitiative(session,claim,behavior,{call_id=null}={}){
    const known=this.initiativeItem(session,claim);if(known)return known;
    const request_id='initiative:'+claim.id;
    if(call_id&&!this.db.prepare('SELECT id FROM call_log WHERE id=? AND ended IS NULL').get(call_id))fail('这次通话已结束');
    const row=this.reserve({request_id,group_id:claim.groupId,call_id});
    const model=session.model;
    const m={role:'assistant',content:[{type:'text',text:json(behavior)}],api:model?.api??'openai-completions',provider:model?.provider??'desktop',
      model:model?.id??'reminder',stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
      asukaInitiative:{id:claim.id,request_id,group_id:row.origin_group_id,group_title:row.group_title,call_id:row.call_id,kind:claim.kind,
        ...(claim.parentRequestId?{parent_request_id:claim.parentRequestId}:{})}};
    session.sessionManager.appendMessage(m);this.sync(session);return this.initiativeItem(session,claim);
  }
  beginErase(ids){
    if(!Array.isArray(ids)||!ids.length||ids.length>500||ids.some(id=>!trimmed(id,96)))fail('请选择要删除的消息');
    const expanded=new Set(ids),pending=this.eraseJob();
    for(const parent of ids){
      if(parent.startsWith('initiative:'))continue;
      const child='initiative:'+followupIdentity(this.id,parent).id;
      const entry=this.source(child)?.assistant_entry;
      if(pending?.includes(child)||(entry&&publishedFollowupParent(this.id,this.sm?.getEntry(entry)?.message)===parent))expanded.add(child);
    }
    const unique=[...expanded].sort();
    if(pending&&json(pending)!==json(unique))fail('请先完成上一次消息删除');
    if(unique.some(id=>!this.source(id)&&!this.db.prepare('SELECT 1 FROM removed_turns WHERE request_id=?').get(id)))fail('找不到所选消息');
    this.db.prepare('INSERT OR IGNORE INTO erase_job VALUES(1,?)').run(json(unique));
    return unique;
  }
  eraseJob(){const row=this.db.prepare('SELECT ids FROM erase_job WHERE single=1').get();return row?JSON.parse(row.ids):null;}
  cancelUnwrittenErase(ids){
    this.db.prepare('DELETE FROM erase_job WHERE single=1 AND ids=?').run(json([...new Set(ids)].sort()));
  }
  finishErase(result){
    const ids=result.requestIds;
    const refs=ids.flatMap(id=>[id+':user',id+':assistant']);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.memory.removeSources(refs);this.scheduler.removeSources(refs);
      for(const id of ids){
        this.db.prepare('INSERT OR IGNORE INTO removed_turns VALUES(?)').run(id);
        const call=this.source(id)?.call_id;
        this.db.prepare('DELETE FROM turn_sources WHERE request_id=?').run(id);
        this.db.prepare('DELETE FROM call_breaks WHERE request_id=?').run(id);
        if(call)this.pruneEmptyCall(call);
      }
      for(const playback of result.replayIds)this.db.prepare('INSERT OR IGNORE INTO replay_cleanup VALUES(?)').run(playback);
      this.db.exec("DELETE FROM relationship_meta WHERE key='leaf'; DELETE FROM erase_job; COMMIT");
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    this.cursor=null;this.indexRetry=null;this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  cleanReplay(ids){
    if(!Array.isArray(ids)||ids.length>1500||ids.some(id=>!trimmed(id,240)))fail('回放清理收据无效');
    for(const id of ids)this.db.prepare('DELETE FROM replay_cleanup WHERE id=?').run(id);
  }
  close(){this.db.close();}
}
