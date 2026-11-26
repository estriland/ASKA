/**
 * Frozen, event-bound mechanism writers. This module never accepts a runtime delta,
 * commits native state, executes a job, changes P, or declares semantic acceptance.
 *
 * validateWriteProgram returns a detached normalized program; the host freezes it
 * together with state_fields. prepareMechanismWrites returns a detached candidate:
 * {state:{observations, routes},instances,effects,trace,...}. The host must apply
 * effects with native prepare and commit this journal in the same durable bundle.
 *
 * Observation lookup: entry.current.value is a Known/Unknown signal. The register
 * key covers namespace + mechanism + field + complete scope; revision counts
 * history entries. Receipt sequence orders observations, never measures scene time.
 */
import {assemblyIdentity,canonical,fingerprint} from './assembly-identity.mjs';

const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const copy=structuredClone;
const fail=(code,path,message=code)=>{throw Object.assign(new Error(message),{code,path});};
const need=(yes,code,path,message)=>{if(!yes)fail(code,path,message);};
function exact(x,required,path,optional=[]){
  need(object(x),'OBJECT_REQUIRED',path);
  need(required.every(k=>own(x,k)),'FIELD_REQUIRED',path);
  need(Object.keys(x).every(k=>required.includes(k)||optional.includes(k)),'UNEXPECTED_FIELD',path);
}
function text(x,path){need(typeof x==='string'&&Boolean(x.trim())&&!x.includes('\0'),'TEXT_REQUIRED',path);return x;}
function finite(x,path){need(typeof x==='number'&&Number.isFinite(x),'FINITE_NUMBER_REQUIRED',path);return x;}
function revision(x,path){need(Number.isSafeInteger(x)&&x>0,'REVISION_INVALID',path);return x;}
function refs(x,path){need(Array.isArray(x)&&x.length>0,'SOURCES_REQUIRED',path);return [...new Set(x.map((v,i)=>text(v,`${path}[${i}]`)))].sort();}
function ns(x,path){exact(x,['character_version','conversation_id','world_id'],path);Object.values(x).forEach(v=>text(v,path));return canonical(x);}
function scope(x,keys,path){
  need(object(x)&&own(x,'subject'),'SCOPE_REQUIRED',path);
  need(same(Object.keys(x).sort(),[...keys].sort()),'SCOPE_KEYS',path);
  Object.values(x).forEach(v=>text(v,path));return canonical(x);
}
function factRef(x,path){exact(x,['id','revision'],path);return {id:text(x.id,path+'.id'),revision:revision(x.revision,path+'.revision')};}
function time(x,path){return x===null?null:finite(x,path);}
function signal(x,path){
  need(object(x)&&typeof x.known==='boolean','SIGNAL_INVALID',path);
  exact(x,x.known?['known','value','sources']:['known','reason','sources'],path);
  const sources=refs(x.sources,path+'.sources');
  return x.known?{known:true,value:finite(x.value,path+'.value'),sources}
    :{known:false,reason:text(x.reason,path+'.reason'),sources};
}
function inDomain(value,type,path){
  finite(value,path);const [lo,hi]=type.domain;
  need((lo===null||value>=lo)&&(hi===null||value<=hi),'VALUE_DOMAIN',path);
}
const specs={
  'M.enjoyment.enjoyable':{type:'experienced_enjoyment',scope:['subject','event','activity'],storage:'contribution'},
  'M.continuation.engagement':{type:'engagement_level',scope:['subject','activity'],storage:'contribution'},
  'M.continuation.satiation':{type:'satiation_level',scope:['subject','activity'],storage:'contribution'},
  'R.care.care':{type:'care_level',scope:['subject','other'],storage:'contribution'},
  'R.safety.acceptance':{type:'relation_safety',scope:['subject','other'],storage:'contribution'},
  'A.emotions.positive':{type:'positive_affect',scope:['subject','event','concern'],storage:'contribution'},
  'A.emotions.negative':{type:'negative_affect',scope:['subject','event','concern'],storage:'contribution'},
  'A.mood.positive':{type:'mood_positive',scope:['subject'],storage:'contribution'},
  'A.mood.negative':{type:'mood_negative',scope:['subject'],storage:'contribution'},
  'C.resources.capacity':{type:'control_capacity',scope:['subject'],storage:'observation'},
  'M.needs.satisfaction':{type:'need_satisfied',scope:['subject','need'],storage:'observation'},
  'M.interest.familiar':{type:'familiar_interest',scope:['subject','activity'],storage:'observation'},
  'C.habit.strength':{type:'habit_strength',scope:['subject','habit'],storage:'observation'},
};
const modes=['new_occurrence_effect','current_appraisal','replace_interpretation','record_only'];
const phases=['prepared','observation','after_commit','next_observation','offline_review'];
function programShape(program,stateFields,catalog){
  exact(program,['schema','channels'],'program');need(program.schema==='asuka.mechanism-writers/1','PROGRAM_SCHEMA','program.schema');
  need(Array.isArray(program.channels),'CHANNELS_REQUIRED','program.channels');
  const ids=new Set(),targets=new Map(),observationAuthorities=new Set();
  const channels=program.channels.map((raw,i)=>{
    const p=`program.channels[${i}]`;exact(raw,['id','mechanism','field','type','scope','storage','target','input','gain'],p);
    for(const key of ['id','mechanism','field','type'])text(raw[key],p+'.'+key);
    need(!ids.has(raw.id),'CHANNEL_DUPLICATE',p+'.id');ids.add(raw.id);
    const spec=specs[`${raw.mechanism}.${raw.field}`];
    need(spec,'AUTHORITY_NOT_WRITABLE',p+'.mechanism');
    need(raw.type===spec.type&&raw.storage===spec.storage,'AUTHORITY_FIELD_MISMATCH',p);
    need(Array.isArray(raw.scope)&&same([...raw.scope].sort(),[...spec.scope].sort()),'CHANNEL_SCOPE',p+'.scope');
    need(new Set(raw.scope).size===raw.scope.length,'CHANNEL_SCOPE',p+'.scope');
    const type=catalog?.types?.[raw.type];
    need(type&&type.temporal_role==='level'&&type.unit==='ratio'&&same(type.domain,[0,1]),'CHANNEL_TYPE',p+'.type');
    finite(raw.gain,p+'.gain');
    if(raw.storage==='observation'){
      need(raw.target===null,'OBSERVATION_HAS_NATIVE_TARGET',p+'.target');
      const authority=JSON.stringify([raw.mechanism,raw.field,[...raw.scope].sort()]);
      need(!observationAuthorities.has(authority),'OBSERVATION_AUTHORITY_DUPLICATE',p);
      observationAuthorities.add(authority);
    }
    else{
      text(raw.target,p+'.target');
      if(stateFields!==null){
        const def=stateFields[raw.target];
        need(own(stateFields,raw.target)&&def?.type===raw.type&&Array.isArray(def.scope)&&same([...def.scope].sort(),[...raw.scope].sort()),'TARGET_DECLARATION',p+'.target');
        need(!own(def,'statistics_pair'),'STATISTIC_TARGET_FORBIDDEN',p+'.target');
      }
      const authority=JSON.stringify([raw.mechanism,raw.field,raw.type,[...raw.scope].sort()]);
      need(!targets.has(raw.target)||targets.get(raw.target)===authority,'TARGET_AUTHORITY_ALIAS',p+'.target');targets.set(raw.target,authority);
    }
    need(object(raw.input),'INPUT_REQUIRED',p+'.input');
    if(raw.storage==='observation')need(raw.input.kind==='symbol','OBSERVATION_REQUIRES_SYMBOLIC_EVIDENCE',p+'.input');
    if(raw.input.kind==='symbol'){
      exact(raw.input,['kind','values'],p+'.input');need(object(raw.input.values)&&Object.keys(raw.input.values).length>0,'CODEBOOK_REQUIRED',p+'.input.values');
      for(const [symbol,value]of Object.entries(raw.input.values)){text(symbol,p+'.input.values');inDomain(value,type,p+'.input.values.'+symbol);}
    }else{
      const selector=own(raw.input,'recipe')?'recipe':'instance';
      exact(raw.input,['kind',selector,'field'],p+'.input');need(raw.input.kind==='assembly','INPUT_KIND',p+'.input.kind');
      text(raw.input[selector],p+'.input.'+selector);text(raw.input.field,p+'.input.field');
      if(selector==='recipe'){
        const recipe=catalog.recipes.find(r=>r.id===raw.input.recipe),step=recipe?.steps.find(s=>s.id===recipe.outputs[raw.input.field]);
        need(recipe&&step&&step.type===raw.type&&same([...recipe.scope].sort(),[...raw.scope].sort()),'WRITER_RECIPE_TYPE_OR_SCOPE',p+'.input');
      }
    }
    return {...copy(raw),scope:[...spec.scope]};
  });
  return {schema:program.schema,channels};
}

export function validateWriteProgram(program,stateFields,catalog){
  need(object(stateFields),'STATE_FIELDS_REQUIRED','stateFields');
  return programShape(program,stateFields,catalog);
}
function resolveFact(contents,ref,nameSpace,subject,path){
  const matches=contents.filter(c=>c.id===ref.id);need(matches.length===1,'FACT_REFERENCE_MISSING_OR_DUPLICATE',path);
  const fact=matches[0];need(fact.kind==='fact'&&fact.owner_id===subject,'FACT_OWNER_OR_KIND',path);
  need(same(ns(fact.namespace,path+'.namespace'),nameSpace),'NAMESPACE_MISMATCH',path);
  need(Array.isArray(fact.history),'FACT_HISTORY_REQUIRED',path);
  const versions=fact.history.filter(v=>v.revision===ref.revision);need(versions.length===1,'FACT_REVISION_MISSING_OR_DUPLICATE',path);
  const version=versions[0];need(object(version.body),'FACT_BODY_REQUIRED',path);
  if(fact.revision===ref.revision)need(same(version.body,fact.body)&&same([...version.source_refs].sort(),[...fact.source_refs].sort()),'FACT_HEAD_HISTORY_MISMATCH',path);
  const body=version.body;
  for(const key of ['occurrence_id','observation_id'])text(body[key],path+'.'+key);
  need(['observed','self_report','reported','inferred','unknown'].includes(body.epistemic_status),'FACT_EPISTEMIC_STATUS',path);
  need(['completed','ongoing','planned','conditional','unknown'].includes(body.occurrence_status),'FACT_OCCURRENCE_STATUS',path);
  need(['current_report','recollection','quotation'].includes(body.presentation),'FACT_PRESENTATION',path);
  need(['new_evidence','restatement','correction'].includes(body.novelty),'FACT_NOVELTY',path);
  return {ref,body:copy(body),source_refs:refs(version.source_refs,path+'.source_refs')};
}
function sequence(map,id,path){need(own(map,id),'SOURCE_OBSERVATION_SEQUENCE_MISSING',path);return revision(map[id],path);}
function eligible(channel,claim,fact,isKnown,phase){
  if(claim.mode==='record_only')return;
  need(phase!=='offline_review','OFFLINE_NUMERIC_WRITE_FORBIDDEN','phase');
  if(claim.mode==='new_occurrence_effect')need(fact.body.presentation==='current_report'&&fact.body.novelty==='new_evidence','HISTORICAL_EVENT_NOT_NEW','claim.mode');
  if(claim.mode==='replace_interpretation')need(fact.body.novelty==='correction','CORRECTION_EVIDENCE_REQUIRED','claim.fact_ref');
  if(channel.storage==='observation'){
    // Unknown is permitted for an actually current condition, not for a future
    // or hypothetical condition masquerading as a replacement of current state.
    need(fact.body.presentation==='current_report'&&['completed','ongoing'].includes(fact.body.occurrence_status),'CURRENT_CONDITION_SOURCE_REQUIRED','claim.fact_ref');
    if(!isKnown)return;
  }
  const affect=channel.mechanism==='A.emotions'||channel.mechanism==='A.mood';
  if(affect&&claim.mode==='current_appraisal')return; // Future/conditional content may matter now, without becoming an occurred fact.
  need(['completed','ongoing'].includes(fact.body.occurrence_status)&&['observed','self_report','reported'].includes(fact.body.epistemic_status),'EXPERIENCED_SOURCE_REQUIRED','claim.fact_ref');
  if(['M.enjoyment','M.continuation'].includes(channel.mechanism))need(fact.body.presentation==='current_report','HISTORICAL_EXPERIENCE_NOT_CURRENT','claim.fact_ref');
}
function assemblySignal(channel,claim,fact,assembly,evaluation,catalog){
  need(claim.symbol===null,'ASSEMBLY_SYMBOL_FORBIDDEN','claim.symbol');
  need(assembly?.schema==='asuka.general-assembly/1'&&evaluation?.graph?.schema==='asuka.general-numeric-graph-result/1','ASSEMBLY_EVALUATION_REQUIRED','evaluation');
  need(evaluation.graph_role==='read_only_evaluation_not_applied_state'&&evaluation.graph.input_identity===assemblyIdentity(assembly),'ASSEMBLY_IDENTITY_MISMATCH','evaluation');
  need(same(evaluation.namespace,assembly.graph.namespace)&&same(evaluation.graph.namespace,evaluation.namespace),'NAMESPACE_MISMATCH','evaluation');
  need(Number.isSafeInteger(evaluation.base_revision)&&evaluation.base_revision>=0&&evaluation.candidate_revision===evaluation.base_revision+1,'EVALUATION_REVISION','evaluation');
  const outputs=assembly.outputs.filter(o=>(channel.input.recipe?o.recipe===channel.input.recipe&&same(o.scope,claim.scope):o.instance===channel.input.instance)&&o.field===channel.input.field);
  need(outputs.length===1,'ASSEMBLY_OUTPUT_MISSING_OR_DUPLICATE','channel.input');const out=outputs[0];
  need(out.type===channel.type&&same(out.scope,claim.scope)&&same(assembly.types[out.type],catalog.types[channel.type]),'ASSEMBLY_OUTPUT_TYPE_OR_SCOPE','channel.input');
  need(assembly.types[out.type].temporal_role==='level','ASSEMBLY_OUTPUT_ROLE','channel.input');
  const value=signal(evaluation.graph.values[out.node_id],'evaluation.output');
  const allowed=new Set([`content:${fact.ref.id}@${fact.ref.revision}`,...fact.source_refs]);
  need(value.sources.some(r=>allowed.has(r)),'ASSEMBLY_SOURCE_MISMATCH','evaluation.output.sources');
  if(value.known)inDomain(value.value,catalog.types[channel.type],'evaluation.output.value');
  return value;
}
function registerKey(namespace,channel,claimScope){return fingerprint({namespace,mechanism:channel.mechanism,field:channel.field,scope:claimScope});}
function routeKey(namespace,channel,claimScope,occurrence){return fingerprint({namespace,mechanism:channel.mechanism,field:channel.field,scope:claimScope,occurrence_id:occurrence});}
function payload(record){return {at:record.at,value:record.value};}
function validatePrevious(previous,channels,namespace,sequenceMap,catalog){
  exact(previous,['observations','routes'],'previous');need(Array.isArray(previous.observations)&&Array.isArray(previous.routes),'JOURNAL_ARRAYS','previous');
  const seen=new Set();
  for(const [kind,entries]of Object.entries(previous))for(const entry of entries){
    const p=`previous.${kind}`;need(object(entry),'JOURNAL_RECORD',p);
    const channel=channels.get(entry.channel_id);need(channel,'JOURNAL_CHANNEL',p);
    need(channel.storage===(kind==='observations'?'observation':'contribution'),'JOURNAL_STORAGE',p);
    need(same(entry.namespace,namespace)&&entry.mechanism===channel.mechanism&&entry.field===channel.field&&entry.type===channel.type,'JOURNAL_AUTHORITY',p);
    scope(entry.scope,channel.scope,p+'.scope');
    need(Array.isArray(entry.history)&&entry.history.length>0&&same(entry.current,entry.history.at(-1)),'JOURNAL_HISTORY',p);
    revision(entry.revision,p+'.revision');need(entry.revision===entry.history.length,'JOURNAL_HISTORY',p);
    for(const record of entry.history){
      need(object(record),'JOURNAL_RECORD',p);const historic=channels.get(record.channel_id);
      need(historic&&record.channel_identity===fingerprint(historic),'JOURNAL_PROGRAM_CHANGED',p);
      need(historic.mechanism===channel.mechanism&&historic.field===channel.field&&historic.type===channel.type&&historic.storage===channel.storage,'JOURNAL_AUTHORITY',p);
      text(record.claim_id,p);factRef(record.fact_ref,p);text(record.occurrence_id,p);text(record.meaning_id,p);revision(record.interpretation_revision,p);
      need(record.source_observation_sequence===sequence(sequenceMap,record.source_observation_id,p),'JOURNAL_OBSERVATION_SEQUENCE',p);
      time(record.at,p);signal(record.value,p);
      if(kind==='observations'&&record.value.known)inDomain(record.value.value,catalog.types[channel.type],p);
    }
    const key=kind==='observations'?registerKey(namespace,channel,entry.scope):routeKey(namespace,channel,entry.scope,entry.current.occurrence_id);
    need(entry.key===key&&!seen.has(`${kind}:${key}`),'JOURNAL_IDENTITY',p);seen.add(`${kind}:${key}`);
    if(kind==='routes')need(entry.target===channel.target&&entry.current.value.known,'JOURNAL_TARGET_OR_UNKNOWN_ROUTE',p);
  }
}
function rejectAffectDoubleRoute(routes,channel,claimScope,occurrence){
  if(!['A.emotions','A.mood'].includes(channel.mechanism))return;
  for(const old of routes){
    if(!['A.emotions','A.mood'].includes(old.mechanism)||old.mechanism===channel.mechanism||old.field!==channel.field||old.current.occurrence_id!==occurrence||old.scope.subject!==claimScope.subject)continue;
    if(!own(old.scope,'concern')||!own(claimScope,'concern')||old.scope.concern===claimScope.concern)
      fail('AFFECT_DOUBLE_ROUTE','claim.channel_id','One canonical occurrence/component cannot enter both episode and background routes; residual has no writer.');
  }
}

export async function prepareMechanismWrites(args,nativeCall,catalog){
  exact(args,['program','claims','previous','contents','observation_id','source_observation_ids','observation_sequence_by_id','phase','namespace'], 'request',['evaluation','assembly']);
  // No caller-owned objects survive an await; native calls cannot change authority.
  const request=copy(args);need(typeof nativeCall==='function','NATIVE_CALL_REQUIRED','nativeCall');
  const program=programShape(request.program,null,catalog),channels=new Map(program.channels.map(c=>[c.id,c]));
  const nameSpace=ns(request.namespace,'namespace');text(request.observation_id,'observation_id');
  need(phases.includes(request.phase),'PHASE_INVALID','phase');
  need(Array.isArray(request.claims)&&Array.isArray(request.contents)&&Array.isArray(request.source_observation_ids),'ARRAY_REQUIRED','request');
  need(object(request.observation_sequence_by_id),'OBSERVATION_SEQUENCES_REQUIRED','request');
  const allowed=new Set([request.observation_id,...request.source_observation_ids.map(v=>text(v,'source_observation_ids'))]);
  for(const id of allowed)sequence(request.observation_sequence_by_id,id,'observation_sequence_by_id');
  validatePrevious(request.previous,channels,nameSpace,request.observation_sequence_by_id,catalog);
  const state=copy(request.previous),trace=[],effects=[],instances=new Map(),claimIds=new Set();
  for(const [i,raw]of request.claims.entries()){
    const p=`claims[${i}]`;exact(raw,['id','channel_id','scope','fact_ref','symbol','mode','meaning_id','interpretation_revision','at'],p);
    text(raw.id,p+'.id');text(raw.channel_id,p+'.channel_id');need(!claimIds.has(raw.id),'DUPLICATE_CLAIM_ID',p+'.id');claimIds.add(raw.id);
    const channel=channels.get(raw.channel_id);need(channel,'CHANNEL_UNKNOWN',p+'.channel_id');
    const claim={...raw,scope:scope(raw.scope,channel.scope,p+'.scope'),fact_ref:factRef(raw.fact_ref,p+'.fact_ref'),at:time(raw.at,p+'.at')};
    need(modes.includes(claim.mode),'MODE_INVALID',p+'.mode');text(claim.meaning_id,p+'.meaning_id');revision(claim.interpretation_revision,p+'.interpretation_revision');
    const fact=resolveFact(request.contents,claim.fact_ref,nameSpace,claim.scope.subject,p+'.fact_ref');
    need(Array.isArray(fact.body.instance_refs)&&fact.body.instance_refs.some(s=>same(s,claim.scope)),'FACT_SCOPE_BINDING',p+'.scope');
    if(own(claim.scope,'event'))need(claim.scope.event===fact.body.occurrence_id,'EVENT_SCOPE_MISMATCH',p+'.scope.event');
    const sourceObs=fact.body.observation_id;need(allowed.has(sourceObs),'SOURCE_OBSERVATION_NOT_ADMITTED',p+'.fact_ref');
    const sourceSequence=sequence(request.observation_sequence_by_id,sourceObs,p+'.fact_ref');
    let input;
    if(channel.input.kind==='symbol'){
      need(claim.symbol===null||typeof claim.symbol==='string','SYMBOL_INVALID',p+'.symbol');
      if(claim.symbol!==null)need(own(channel.input.values,claim.symbol),'SYMBOL_NOT_IN_CODEBOOK',p+'.symbol');
      const sources=[`content:${fact.ref.id}@${fact.ref.revision}`,...fact.source_refs];
      input=claim.symbol===null?{known:false,reason:'symbol_not_known',sources}:{known:true,value:channel.input.values[claim.symbol],sources};
    }else{
      need(same(request.evaluation?.namespace,nameSpace),'NAMESPACE_MISMATCH','evaluation');
      input=assemblySignal(channel,claim,fact,request.assembly,request.evaluation,catalog);
    }
    eligible(channel,claim,fact,input.known,request.phase);
    const common={claim_id:claim.id,channel_id:channel.id,channel_identity:fingerprint(channel),fact_ref:claim.fact_ref,
      source_observation_id:sourceObs,source_observation_sequence:sourceSequence,occurrence_id:fact.body.occurrence_id,
      meaning_id:claim.meaning_id,interpretation_revision:claim.interpretation_revision,mode:claim.mode,at:claim.at};
    if(claim.mode==='record_only'){trace.push({...common,status:'record_only_no_write'});continue;}
    // This is the sole numeric projection. JS performs validation, not psychological arithmetic.
    const projected=signal(await nativeCall({op:'numeric',request:{op:'weighted_sum',inputs:[input],params:{weights:[channel.gain],bias:0}}}),p+'.projection');
    need(projected.known===input.known,'NATIVE_KNOWNNESS_CHANGED',p+'.projection');
    const requiredSources=new Set(input.sources);need([...requiredSources].every(r=>projected.sources.includes(r)),'NATIVE_SOURCE_LOST',p+'.projection');
    const current={...common,value:projected};
    if(channel.storage==='observation'){
      if(projected.known)inDomain(projected.value,catalog.types[channel.type],p+'.projection.value');
      const key=registerKey(nameSpace,channel,claim.scope),old=state.observations.find(x=>x.key===key);
      if(old){
        const before=old.current;
        if(before.source_observation_id===sourceObs){
          need(before.occurrence_id===current.occurrence_id&&before.meaning_id===current.meaning_id,'OBSERVATION_AMBIGUOUS',p);
          need(current.interpretation_revision>=before.interpretation_revision,'STALE_INTERPRETATION',p);
          if(current.interpretation_revision===before.interpretation_revision){
            need(same(payload(before),payload(current)),'INTERPRETATION_CONFLICT',p);trace.push({...common,status:'duplicate_observation'});continue;
          }
          need(claim.mode==='replace_interpretation','REPLACEMENT_MODE_REQUIRED',p);
        }else{
          need(sourceSequence>before.source_observation_sequence,'STALE_OBSERVATION_SEQUENCE',p);
          if(before.at!==null&&claim.at!==null)need(claim.at>=before.at,'OBSERVATION_TIME_REVERSED',p);
          if(claim.mode==='replace_interpretation')need(before.occurrence_id===current.occurrence_id&&before.meaning_id===current.meaning_id&&current.interpretation_revision>before.interpretation_revision,'OBSERVATION_REPLACEMENT_IDENTITY',p);
        }
        old.channel_id=channel.id;old.current=current;old.history.push(current);old.revision=old.history.length;
      }else{
        need(claim.mode!=='replace_interpretation','OBSERVATION_REPLACEMENT_MISSING',p);
        state.observations.push({key,namespace:nameSpace,channel_id:channel.id,mechanism:channel.mechanism,field:channel.field,type:channel.type,scope:claim.scope,revision:1,current,history:[current]});
      }
      trace.push({...common,status:'observation_replaced',value:projected});continue;
    }
    const key=routeKey(nameSpace,channel,claim.scope,fact.body.occurrence_id),old=state.routes.find(x=>x.key===key);
    if(claim.mode==='replace_interpretation')need(old,'ROUTE_REPLACEMENT_MISSING',p);
    if(!projected.known){need(claim.mode!=='replace_interpretation','UNKNOWN_REPLACEMENT',p);trace.push({...common,status:'deferred_unknown_no_route',value:projected});continue;}
    rejectAffectDoubleRoute(state.routes,channel,claim.scope,fact.body.occurrence_id);
    if(old){
      need(old.target===channel.target&&old.current.meaning_id===claim.meaning_id,'ROUTE_ALIAS_FORBIDDEN',p);
      need(claim.interpretation_revision>=old.current.interpretation_revision,'STALE_INTERPRETATION',p);
      if(claim.interpretation_revision===old.current.interpretation_revision)need(same(payload(old.current),payload(current)),'INTERPRETATION_CONFLICT',p);
      else{need(claim.mode==='replace_interpretation','REPLACEMENT_MODE_REQUIRED',p);old.channel_id=channel.id;old.current=current;old.history.push(current);old.revision=old.history.length;}
    }else{
      state.routes.push({key,namespace:nameSpace,channel_id:channel.id,mechanism:channel.mechanism,field:channel.field,type:channel.type,scope:claim.scope,target:channel.target,revision:1,current,history:[current]});
    }
    const target={mechanism:channel.target,scope:claim.scope};instances.set(fingerprint(target),target);
    effects.push({target,occurrence_id:fact.body.occurrence_id,meaning_id:claim.meaning_id,interpretation_revision:claim.interpretation_revision,
      observation_id:request.observation_id,mode:claim.mode,at:claim.at,delta:projected});
    trace.push({...common,status:old?'existing_route_candidate':'new_route_candidate',target,value:projected});
  }
  return {schema:'asuka.mechanism-write-candidate/1',namespace:nameSpace,program_identity:fingerprint(program),state,instances:[...instances.values()],effects,trace,
    committed:false,semantic_review:'not_performed_here',limitations:['Only admitted frozen channels project event contributions.','Unknown observation replacement does not become zero.','Receipt sequence orders register updates, not psychological elapsed time.','Native prepare/commit and the host journal must commit these candidates together.']};
}
