import {INTERACTION_FACT_RULES,recordIncident} from './event-observations.mjs';
export function parseObject(text){
  const value=String(text||"").trim(),begin=value.indexOf("{"),end=value.lastIndexOf("}");
  if(begin<0||end<begin)throw Error("模型没有返回JSON正文");
  return JSON.parse(value.slice(begin,end+1));
}
export function semanticPrompt(network,record,profile){
  const excluded=new Set(["binding.evaluate.harm","binding.evaluate.repair","binding.accountability"]);
  return [
    "你是语义记录器，不扮演角色。只记录当前输入对角色的事实作用，不决定她如何回复，不输出数值强度。",
    "当前用户是固定关系对象。用户引述的第三方言行、假设例子，不当成用户本人实施的伤害。普通技术分歧不自动等于否定存在价值。",
    "本地工具记录与文件内容是执行资料，不是用户对角色的发言；不要把其中的文字当成本轮人际刺激。",
    "signals只用下面的binding_id及supports/obstructs，evidence简述依据。不要输出情绪、策略、台词或信心分数。",
    network.semantic_bindings.filter(b=>!excluded.has(b.id)).map(b=>b.id+" ["+b.directions.join("|")+"]："+b.label).join("\n"),
    ...INTERACTION_FACT_RULES,
    "repairs必须指向已存在incident_id。承认责任用kind=acknowledgement；已实际完成补救用remedial_action，只有计划不算。重复补救使用已有evidence_id；新证据为new。一次补救不说明全部原谅。",
    "memory_ids只在用户明确询问过往经历、作品人物/事件时选择少数项；当前普通同伴的同类事件默认不加载作品记忆，不能因同名词语就把当前对话当原作重演。回忆不再次注入为新伤害。",
    "关切依据是已有关系、责任或对方实际处境；对方道歉本身不等于角色产生关切。共同任务机会需要当前双方能一起做的实际任务/资源，单方补救不自动成为合作机会。",
    "已记录事件："+JSON.stringify(record.incidents),
    "已登记修复："+JSON.stringify(record.catalog),
    record.ledger_omitted?"当前目录按相关性选取，另有"+record.ledger_omitted+"件历史未展示；缺少身份依据时写uncertainties，不把可能的旧事默认新建。":"",
    "可用经历："+JSON.stringify(profile.memories.map(m=>({id:m.id,label:m.label}))),
    '只返回JSON：{"signals":[{"binding_id":"...","direction":"supports","evidence":"...","basis":"explicit_statement或contextual_inference","source":"new或repeat或repair.0"}],"incidents":[{"reference":"new或旧ID","occurrence":"act或mention","description":"...","evidence":"..."}],"repairs":[{"incident_id":"旧ID","scope":"specific或unclear","evidence_id":"new或已有ID","kind":"acknowledgement或remedial_action","description":"...","evidence":"..."}],"memory_ids":[],"uncertainties":[]}',
  ].join("\n");
}
export function compileLiveFrame(mapping,previous,network,profile,{clientEvent=false}={}){
  const record=structuredClone(previous);record.sequence++;
  const ignored=[],applied={...structuredClone(mapping),signals:[],repairs:[],incidents:[]};
  const seq=record.sequence,signals=[],allowed=new Map(network.semantic_bindings.map(b=>[b.id,b]));
  const append=(id,direction,evidence,extra={})=>{
    if(!allowed.get(id)?.directions.includes(direction)||typeof evidence!=="string"||!evidence.trim())throw Error("语义作用字段无效："+id);
    signals.push({binding_id:id,direction,evidence,basis:"explicit_statement",event_id:"turn."+seq,...extra});
  };
  const repairSources=new Map();
  const skippedRepairs=new Set();
  if(clientEvent&&((mapping.incidents||[]).length||(mapping.repairs||[]).length))throw Error("麦克风状态不能直接登记成伤害或修复");
  for(const [i,event]of (mapping.incidents||[]).entries()){
    const {id,inject,reason='old_event_mention'}=recordIncident(event,record,seq,i);
    if(inject){
      append("binding.evaluate.harm","supports",event.evidence,{event_id:id});
      applied.incidents.push(event);
    }else{
      ignored.push({kind:'incident',index:i,reason,id});
      if(reason!=='unregistered_past_mention')applied.incidents.push(event);
    }
  }
  for(const [i,repair]of (mapping.repairs||[]).entries()){
    if(repair.scope==='unclear'){
      skippedRepairs.add('repair.'+i);ignored.push({kind:'repair',index:i,reason:'unclear_scope'});continue;
    }
    if(repair.scope!==undefined&&repair.scope!=='specific')throw Error('无效修复范围');
    if(!previous.incidents[repair.incident_id])throw Error("修复没有对应已提交旧事");
    if(!["acknowledgement","remedial_action"].includes(repair.kind))throw Error("无效修复类型");
    let id=repair.evidence_id;
    if(id==="new"){
      id=repair.kind==="acknowledgement"?"ack."+repair.incident_id:"action."+seq+"."+i;
      if(!record.catalog.some(f=>f.id===id))record.catalog.push({id,canonical_id:id,incident_id:repair.incident_id,relationship_id:"user",kind:repair.kind,content:repair.description||repair.evidence,admission:"accepted"});
    }
    const evidence=record.catalog.find(f=>f.id===id);
    if(!evidence||evidence.incident_id!==repair.incident_id||evidence.kind!==repair.kind)throw Error("修复证据身份不匹配");
    const extra={event_id:"repair."+seq+"."+i,repair_evidence_id:id,related_event_id:repair.incident_id};
    repairSources.set("repair."+i,extra);
    append("binding.evaluate.repair","supports",repair.evidence,extra);
    append("binding.accountability","supports",repair.evidence,extra);
    applied.repairs.push(repair);
  }
  for(const s of mapping.signals||[]){
    // Accept the observed Flash shorthand only when it names an exact catalog entry.
    const id=allowed.has(s.binding_id)?s.binding_id:"binding."+s.binding_id;
    if(["binding.evaluate.harm","binding.evaluate.repair","binding.accountability"].includes(id))throw Error("伤害/修复必须走事件记录");
    if(!["explicit_statement","contextual_inference"].includes(s.basis))throw Error("语义依据类型无效");
    const source=s.source||"new";
    if(source==='repeat'||skippedRepairs.has(source)){
      ignored.push({kind:'signal',binding_id:id,reason:source==='repeat'?'repeated_condition':'unconfirmed_repair_source'});continue;
    }
    if(source!=="new"&&!repairSources.has(source))throw Error("信号的修复来源无效");
    append(id,s.direction,s.evidence,{basis:s.basis,...(repairSources.get(source)||{})});
    applied.signals.push(s);
  }
  const memoryIds=new Set(mapping.memory_ids||[]);
  if([...memoryIds].some(id=>!profile.memories.some(m=>m.id===id)))throw Error("未知记忆");
  return {record,memories:profile.memories.filter(m=>memoryIds.has(m.id)),
    frame:{relationship_id:"user",signals,uncertainties:(mapping.uncertainties||[]).map(String)},
    audit:{mapping,applied_mapping:applied,ignored,protocol:'interaction-facts-v2',sequence:seq,scope:"single_current_user",note:"第三方被提及不切换当前用户关系。新补救事实身份由语义模型判断，尚非完美去重。"}};
}
