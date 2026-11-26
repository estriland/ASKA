// Immutable delayed-work descriptors, not an executor or semantic approver.
// The host's committed bundle protects these hashes; hashes alone are not an
// authorization signature. No files, models, clocks or native state are touched.
import {applyContentChanges} from './content-records.mjs';
import {fingerprint,canonical} from './assembly-identity.mjs';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const text=x=>typeof x==='string'&&Boolean(x.trim())&&!x.includes('\0');
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const copy=structuredClone;
const CLOCKS=['after_commit','next_observation','offline_review'];
const PAYLOAD=['mechanism_changes','experiences','mechanism_claims'];
const INPUT=['id','clock','source_refs','payload'];
const STORED=[...INPUT,'namespace','origin_transaction_id','payload_sha256','content_refs','source_observation_ids','source_binding_sha256'];
function need(ok,code,path){if(!ok)throw Object.assign(new Error(`${code}: ${path}`),{code,path});}
function fields(value,keys,path){need(object(value),'OBJECT_REQUIRED',path);need(keys.every(k=>Object.hasOwn(value,k)),'FIELD_REQUIRED',path);need(Object.keys(value).every(k=>keys.includes(k)),'UNEXPECTED_FIELD',path);}
function ns(value,path){fields(value,['character_version','conversation_id','world_id'],path);need(Object.values(value).every(text),'NAMESPACE_INVALID',path);}
function strings(value,path,{empty=false}={}){need(Array.isArray(value)&&(empty||value.length>0)&&value.every(text),'REFERENCES_REQUIRED',path);return value;}
function version(value,path,positive=false){need(Number.isSafeInteger(value)&&value>=0&&(!positive||value>0),'REVISION_INVALID',path);}
function ref(value,path){fields(value,['id','revision'],path);need(text(value.id),'REFERENCE_ID_REQUIRED',path);version(value.revision,path+'.revision',true);return value;}
function scope(value,path){need(object(value)&&text(value.subject)&&Object.values(value).every(text),'SCOPE_REQUIRED',path);}
function signal(value,path){
  need(object(value)&&typeof value.known==='boolean','SIGNAL_INVALID',path);
  const keys=value.known?['known','value']:['known','reason'];
  fields(value,[...keys,...(Object.hasOwn(value,'sources')?['sources']:[])],path);
  if(value.known)need(typeof value.value==='number'&&Number.isFinite(value.value),'NUMBER_REQUIRED',path);else need(text(value.reason),'REASON_REQUIRED',path);
  if(value.sources!==undefined)strings(value.sources,path+'.sources',{empty:true});
}
function mode(value,path){need(value!=='current_appraisal','FROZEN_CURRENT_APPRAISAL_FORBIDDEN',path);need(['record_only','new_occurrence_effect','replace_interpretation'].includes(value),'MODE_INVALID',path);}
function time(value,path){need(value===null||typeof value==='number'&&Number.isFinite(value),'TIME_INVALID',path);}
function checkPayload(payload,clock,path){
  fields(payload,PAYLOAD,path);for(const key of PAYLOAD)need(Array.isArray(payload[key]),'ARRAY_REQUIRED',path+'.'+key);
  if(clock==='offline_review')need(payload.experiences.length===0&&payload.mechanism_claims.length===0,'OFFLINE_DYNAMIC_WRITE_FORBIDDEN',path);
  payload.mechanism_changes.forEach((change,i)=>{
    const p=path+`.mechanism_changes[${i}]`;fields(change,['id','mechanism','scope','base_revision','roles'],p);
    need(text(change.id)&&text(change.mechanism),'MECHANISM_ID_REQUIRED',p);scope(change.scope,p+'.scope');version(change.base_revision,p+'.base_revision');
    if(clock==='offline_review')need(change.mechanism==='L.identity_proposal','OFFLINE_IDENTITY_ONLY',p);
    else need(change.mechanism!=='L.identity_proposal','IDENTITY_REQUIRES_OFFLINE',p);
    need(object(change.roles)&&Object.keys(change.roles).length>0,'ROLES_REQUIRED',p+'.roles');
    for(const [role,refs]of Object.entries(change.roles)){
      need(text(role)&&Array.isArray(refs)&&refs.length>0,'ROLE_REFERENCES_REQUIRED',p+'.roles');
      refs.forEach((value,j)=>ref(value,`${p}.roles.${role}[${j}]`));
    }
  });
  payload.experiences.forEach((experience,i)=>{
    const p=path+`.experiences[${i}]`;fields(experience,['fact_ref','pair','sample'],p);ref(experience.fact_ref,p+'.fact_ref');
    fields(experience.pair,['id','sum','mass','scope'],p+'.pair');
    need([experience.pair.id,experience.pair.sum,experience.pair.mass].every(text),'PAIR_ID_REQUIRED',p+'.pair');scope(experience.pair.scope,p+'.pair.scope');
    const s=experience.sample;fields(s,['kind','occurrence_id','meaning_id','interpretation_revision','observation_id','mode','at','outcome','weight','source_refs'],p+'.sample');
    need(s.kind==='observed_outcome_record','SAMPLE_KIND',p);need([s.occurrence_id,s.meaning_id,s.observation_id].every(text),'SAMPLE_ID_REQUIRED',p);
    version(s.interpretation_revision,p+'.sample.interpretation_revision',true);mode(s.mode,p+'.sample.mode');time(s.at,p+'.sample.at');
    signal(s.outcome,p+'.sample.outcome');signal(s.weight,p+'.sample.weight');strings(s.source_refs,p+'.sample.source_refs');
  });
  payload.mechanism_claims.forEach((claim,i)=>{
    const p=path+`.mechanism_claims[${i}]`;fields(claim,['id','channel_id','scope','fact_ref','symbol','mode','meaning_id','interpretation_revision','at'],p);
    need([claim.id,claim.channel_id,claim.meaning_id].every(text),'CLAIM_ID_REQUIRED',p);
    need(claim.symbol===null||text(claim.symbol),'CLAIM_SYMBOL_REQUIRED',p+'.symbol');
    scope(claim.scope,p+'.scope');ref(claim.fact_ref,p+'.fact_ref');mode(claim.mode,p+'.mode');version(claim.interpretation_revision,p+'.interpretation_revision',true);time(claim.at,p+'.at');
  });
}
function input(value,path){fields(value,INPUT,path);need(text(value.id),'WORK_ID_REQUIRED',path);need(CLOCKS.includes(value.clock),'WORK_CLOCK',path);strings(value.source_refs,path+'.source_refs');checkPayload(value.payload,value.clock,path+'.payload');}
const logicalInput=value=>({id:value.id,clock:value.clock,source_refs:[...new Set(value.source_refs)].sort(),payload:value.payload});
const tag=reference=>`content:${reference.id}@${reference.revision}`;
function binding(item){return {id:item.id,clock:item.clock,namespace:item.namespace,origin_transaction_id:item.origin_transaction_id,
  source_refs:item.source_refs,content_refs:item.content_refs,source_observation_ids:item.source_observation_ids,payload_sha256:item.payload_sha256};}
function checkedItems(current,namespace){
  need(Array.isArray(current),'ARRAY_REQUIRED','items');const ids=new Set();
  return current.map((item,index)=>{
    const p=`items[${index}]`;fields(item,STORED,p);input(Object.fromEntries(INPUT.map(k=>[k,item[k]])),p);
    ns(item.namespace,p+'.namespace');need(same(item.namespace,namespace),'NAMESPACE_MISMATCH',p);need(text(item.origin_transaction_id),'TRANSACTION_ID_REQUIRED',p);
    need(!ids.has(item.id),'DUPLICATE_WORK_ITEM',p);ids.add(item.id);
    need(Array.isArray(item.content_refs)&&item.content_refs.length>0,'CONTENT_REFS_REQUIRED',p);item.content_refs.forEach((r,i)=>ref(r,`${p}.content_refs[${i}]`));
    need(new Set(item.content_refs.map(tag)).size===item.content_refs.length,'DUPLICATE_CONTENT_REF',p);
    strings(item.source_observation_ids,p+'.source_observation_ids');
    need(item.payload_sha256===fingerprint(item.payload),'PAYLOAD_CHANGED',p);
    need(item.source_binding_sha256===fingerprint(binding(item)),'SOURCE_BINDING_CHANGED',p);
    return copy(item);
  });
}
function proposal(item){return {id:item.id,clock:item.clock,source_refs:[...new Set(item.source_refs)],payload_refs:item.content_refs.map(tag)};}

export function stageWorkItems(current,items,context){
  fields(context,['namespace','transaction_id','contents'],'context');ns(context.namespace,'context.namespace');need(text(context.transaction_id),'TRANSACTION_ID_REQUIRED','context');
  const result=checkedItems(current,context.namespace),byId=new Map(result.map(item=>[item.id,item]));
  const contents=new Map(applyContentChanges(context.contents,[],context.namespace).records.map(record=>[record.id,record]));
  need(Array.isArray(items),'ARRAY_REQUIRED','items');const proposals=[],proposed=new Set();
  items.forEach((item,index)=>{
    const p=`newItems[${index}]`;input(item,p);const previous=byId.get(item.id);
    if(previous){
      need(same(logicalInput(previous),logicalInput(item)),'WORK_ID_CONFLICT',p);
      // Do not rederive an old item's observation/version from a newer content head.
      if(!proposed.has(item.id)){proposals.push(proposal(previous));proposed.add(item.id);}return;
    }
    const pinned=[],seen=new Set(),observations=[],allowedSources=new Set();
    function resolve(reference,path){
      const record=contents.get(reference.id);need(record,'CONTENT_REFERENCE_MISSING',path);
      const entry=record.history.find(row=>row.revision===reference.revision);need(entry,'CONTENT_REVISION_MISSING',path);
      return {record,entry};
    }
    function visit(reference,path){
      const resolved=resolve(reference,path),key=JSON.stringify([reference.id,reference.revision]);
      if(seen.has(key))return resolved;seen.add(key);pinned.push(copy(reference));allowedSources.add(tag(reference));
      const {record,entry}=resolved;
      if(record.kind==='fact'){
        observations.push(entry.body.observation_id);entry.source_refs.forEach(value=>allowedSources.add(value));
      }else if(record.kind==='belief'){
        visit(entry.body.proposition_ref,path+'.proposition_ref');entry.body.basis_refs.forEach((r,i)=>visit(r,path+`.basis_refs[${i}]`));
      }else if(record.kind==='memory')entry.body.record_refs.forEach((r,i)=>visit(r,path+`.record_refs[${i}]`));
      return resolved;
    }
    item.payload.mechanism_changes.forEach((change,i)=>Object.entries(change.roles).forEach(([role,refs])=>refs.forEach((r,j)=>visit(r,`${p}.payload.mechanism_changes[${i}].roles.${role}[${j}]`))));
    item.payload.experiences.forEach((experience,i)=>{
      const ep=`${p}.payload.experiences[${i}]`,{record,entry}=visit(experience.fact_ref,ep+'.fact_ref');need(record.kind==='fact','FACT_REQUIRED',ep);
      const s=experience.sample;need(s.observation_id===entry.body.observation_id&&s.occurrence_id===entry.body.occurrence_id,'SAMPLE_FACT_IDENTITY',ep);
      const factSources=new Set([tag(experience.fact_ref),...entry.source_refs]);
      need([...s.source_refs,...(s.outcome.sources??[]),...(s.weight.sources??[])].every(value=>factSources.has(value)),'SAMPLE_SOURCE_BINDING',ep);
    });
    item.payload.mechanism_claims.forEach((claim,i)=>need(visit(claim.fact_ref,`${p}.payload.mechanism_claims[${i}].fact_ref`).record.kind==='fact','FACT_REQUIRED',p));
    need(pinned.length>0&&observations.length>0,'PAYLOAD_FACT_SOURCE_REQUIRED',p);
    need(item.source_refs.every(value=>allowedSources.has(value)),'WORK_SOURCE_BINDING',p+'.source_refs');
    const stored={...copy(item),namespace:copy(context.namespace),origin_transaction_id:context.transaction_id,
      payload_sha256:fingerprint(item.payload),content_refs:pinned,source_observation_ids:[...new Set(observations)]};
    stored.source_binding_sha256=fingerprint(binding(stored));result.push(stored);byId.set(item.id,stored);
    proposals.push(proposal(stored));proposed.add(item.id);
  });
  return {items:result,proposals};
}

/** Clock eligibility and acknowledgement remain the host scheduler's job. This
 * verifies only the exact sealed work/job pairing and returns inert payloads. */
export function selectWorkItems(items,jobs,ids,namespace){
  ns(namespace,'namespace');const checked=checkedItems(items,namespace),byId=new Map(checked.map(item=>[item.id,item]));
  need(Array.isArray(jobs),'ARRAY_REQUIRED','jobs');strings(ids,'ids',{empty:true});
  const jobMap=new Map();for(const job of jobs){need(object(job)&&text(job.id),'JOB_REQUIRED','jobs');need(!jobMap.has(job.id),'DUPLICATE_JOB','jobs');jobMap.set(job.id,job);}
  const selected=[],payload=Object.fromEntries(PAYLOAD.map(key=>[key,[]]));
  const observations=[],sources=[],payloadRefs=[];
  for(const id of new Set(ids)){
    const item=byId.get(id),job=jobMap.get(id);need(item&&job,'WORK_JOB_MISSING','ids.'+id);
    need(job.status==='pending','WORK_JOB_NOT_PENDING','ids.'+id);
    need(same(job.namespace,namespace)&&job.clock===item.clock&&job.origin?.transaction_id===item.origin_transaction_id,'WORK_JOB_IDENTITY','ids.'+id);
    need(Array.isArray(job.source_refs)&&same([...new Set(job.source_refs)].sort(),[...new Set(item.source_refs)].sort()),'WORK_JOB_SOURCES','ids.'+id);
    need(Array.isArray(job.payload_refs)&&same([...new Set(job.payload_refs)].sort(),item.content_refs.map(tag).sort()),'WORK_JOB_PAYLOAD_REFS','ids.'+id);
    selected.push(copy(item));for(const key of PAYLOAD)payload[key].push(...copy(item.payload[key]));
    observations.push(...item.source_observation_ids);sources.push(...item.source_refs);payloadRefs.push(...item.content_refs.map(tag));
  }
  return {payload,items:selected,source_observation_ids:[...new Set(observations)],source_refs:[...new Set(sources)],payload_refs:[...new Set(payloadRefs)]};
}
