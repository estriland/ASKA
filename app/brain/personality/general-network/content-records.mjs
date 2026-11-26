// Pure, versioned content and lifecycle drafts. Source references are structural
// provenance, not proof of semantic review. No I/O or psychological effects.
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const KINDS=['fact','belief','memory'];
const FACT_FIELDS=['proposition','occurrence_id','observation_id','epistemic_status','occurrence_status','presentation','novelty'];
const FACT_ENUMS={
  epistemic_status:['observed','self_report','reported','inferred','unknown'],
  occurrence_status:['completed','ongoing','planned','conditional','unknown'],
  presentation:['current_report','recollection','quotation'],
  novelty:['new_evidence','restatement','correction'],
};
class ContentRecordError extends Error {
  constructor(code,path,message){super(message);this.name='ContentRecordError';this.code=code;this.path=path;}
}
const fail=(code,path,message)=>{throw new ContentRecordError(code,path,message);};
function fields(value,expected,path,optional=[]){
  if(!object(value))fail('OBJECT_REQUIRED',path,'Expected an object');
  for(const key of expected)if(!own(value,key))fail('MISSING_FIELD',path+'.'+key,'Required field is absent');
  for(const key of Object.keys(value))if(!expected.includes(key)&&!optional.includes(key))fail('UNKNOWN_FIELD',path+'.'+key,'Unexpected field');
}
function text(value,path){
  if(typeof value!=='string'||!value.trim()||value.includes('\0'))fail('TEXT_REQUIRED',path,'Nonblank text without NUL is required');
  return value;
}
function revision(value,path,{positive=false}={}){
  if(!Number.isSafeInteger(value)||value<0||(positive&&value===0))fail('REVISION_INVALID',path,'Revision must be a nonnegative safe integer');
  return value;
}
function list(value,path,{nonempty=true}={}){
  if(!Array.isArray(value)||(nonempty&&!value.length))fail('REFERENCES_REQUIRED',path,'Expected a nonempty reference array');
  return [...new Set(value.map((item,index)=>text(item,`${path}[${index}]`)))];
}
function namespace(value,path){
  fields(value,['character_version','conversation_id','world_id'],path);
  return Object.fromEntries(['character_version','conversation_id','world_id'].map(key=>[key,text(value[key],path+'.'+key)]));
}
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(object(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
const equal=(left,right)=>JSON.stringify(canonical(left))===JSON.stringify(canonical(right));
function contentRef(value,path){
  fields(value,['id','revision'],path);
  return {id:text(value.id,path+'.id'),revision:revision(value.revision,path+'.revision',{positive:true})};
}
function contentRefs(value,path){
  if(!Array.isArray(value)||!value.length)fail('REFERENCES_REQUIRED',path,'Expected nonempty exact content references');
  const seen=new Set(),result=[];
  value.forEach((item,index)=>{
    const ref=contentRef(item,`${path}[${index}]`),key=JSON.stringify(canonical(ref));
    if(!seen.has(key)){seen.add(key);result.push(ref);}
  });
  return result;
}
function instanceRefs(value,owner,path){
  if(!Array.isArray(value))fail('ARRAY_REQUIRED',path,'Instance references must be an array of explicit scopes');
  const seen=new Set();
  for(const [index,item]of value.entries()){
    const p=`${path}[${index}]`;
    if(!object(item)||!Object.keys(item).length)fail('INSTANCE_SCOPE_REQUIRED',p,'Every instance reference must be a nonempty scope object');
    for(const [key,v]of Object.entries(item)){text(key,p+'.<key>');text(v,p+'.'+key);}
    if(!own(item,'subject'))fail('INSTANCE_SUBJECT_REQUIRED',p,'Instance scope must explicitly name its subject');
    if(item.subject!==owner)fail('INSTANCE_OWNER_MISMATCH',p+'.subject','Instance subject must match the content owner');
    const key=JSON.stringify(canonical(item));
    if(seen.has(key))fail('INSTANCE_REFERENCE_DUPLICATE',p,'Equivalent instance scopes cannot be repeated');
    seen.add(key);
  }
}
function body(kind,value,owner,path){
  if(kind==='fact'){
    fields(value,FACT_FIELDS,path,['instance_refs']);
    for(const key of ['proposition','occurrence_id','observation_id'])text(value[key],path+'.'+key);
    for(const [key,allowed]of Object.entries(FACT_ENUMS))if(!allowed.includes(value[key]))fail('FACT_ENUM',path+'.'+key,'Unsupported fact classification');
    if(own(value,'instance_refs'))instanceRefs(value.instance_refs,owner,path+'.instance_refs');
    return structuredClone(value);
  }
  if(kind==='belief'){
    fields(value,['proposition_ref','holder_id','stance','basis_refs'],path);
    const proposition_ref=contentRef(value.proposition_ref,path+'.proposition_ref');text(value.holder_id,path+'.holder_id');text(value.stance,path+'.stance');
    if(value.holder_id!==owner)fail('HOLDER_MISMATCH',path+'.holder_id','Belief holder must match the record owner');
    return {...value,proposition_ref,basis_refs:contentRefs(value.basis_refs,path+'.basis_refs')};
  }
  fields(value,['record_refs','summary'],path);text(value.summary,path+'.summary');
  return {...value,record_refs:contentRefs(value.record_refs,path+'.record_refs')};
}
function payload(kind,sourceRefs,value,owner,path){
  return {source_refs:list(sourceRefs,path+'.source_refs'),body:body(kind,value,owner,path+'.body')};
}
function payloadKey(kind,value){
  const copy=structuredClone(value);copy.source_refs=[...new Set(copy.source_refs)].sort();
  const sortedRefs=refs=>[...new Map(refs.map(ref=>[JSON.stringify(canonical(ref)),canonical(ref)])).entries()]
    .sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,ref])=>ref);
  if(kind==='fact'&&own(copy.body,'instance_refs'))copy.body.instance_refs=sortedRefs(copy.body.instance_refs);
  if(kind==='belief')copy.body.basis_refs=sortedRefs(copy.body.basis_refs);
  if(kind==='memory')copy.body.record_refs=sortedRefs(copy.body.record_refs);
  return canonical(copy);
}
const samePayload=(kind,a,b)=>equal(payloadKey(kind,a),payloadKey(kind,b));
function identity(kind,id,owner,path){
  if(!KINDS.includes(kind))fail('CONTENT_KIND',path+'.kind','Content kind must be fact, belief or memory');
  text(id,path+'.id');text(owner,path+'.owner_id');
}
function references(kind,value,owner,records,path){
  const required=kind==='belief'?[value.proposition_ref,...value.basis_refs]:kind==='memory'?value.record_refs:[];
  for(const ref of required){
    const target=records.get(ref.id);
    if(!target)fail('CONTENT_REFERENCE_MISSING',path,'Referenced content must already exist: '+ref.id);
    if(target.owner_id!==owner)fail('CONTENT_OWNER_MISMATCH',path,'A reference cannot transfer another owner’s content');
    if(kind==='belief'&&target.kind!=='fact')fail('BELIEF_FACT_REQUIRED',path,'Belief propositions and bases must reference fact records');
    if(kind==='memory'&&!['fact','belief'].includes(target.kind))fail('MEMORY_RECORD_KIND',path,'Memory may reference facts or beliefs, not generated replies or memory chains');
    if(!target.history.some(entry=>entry.revision===ref.revision))fail('CONTENT_REVISION_MISSING',path,'Referenced content revision must already exist: '+ref.id+'@'+ref.revision);
  }
}
function currentRecords(currentArray,expectedNamespace){
  if(!Array.isArray(currentArray))fail('ARRAY_REQUIRED','currentArray','Current content must be an array');
  const records=new Map();
  for(const [index,record]of currentArray.entries()){
    const path=`currentArray[${index}]`;
    fields(record,['id','kind','owner_id','namespace','revision','source_refs','body','history'],path);
    identity(record.kind,record.id,record.owner_id,path);
    if(records.has(record.id))fail('CONTENT_ID_DUPLICATE',path+'.id','Content identities must be unique');
    if(!equal(namespace(record.namespace,path+'.namespace'),expectedNamespace))fail('NAMESPACE_MISMATCH',path+'.namespace','Content belongs to another namespace');
    const version=revision(record.revision,path+'.revision',{positive:true});
    const head=payload(record.kind,record.source_refs,record.body,record.owner_id,path);
    if(!Array.isArray(record.history)||record.history.length!==version)fail('HISTORY_INCOMPLETE',path+'.history','History must retain every version through the current revision');
    for(const [i,entry]of record.history.entries()){
      const hp=`${path}.history[${i}]`;fields(entry,['revision','base_revision','source_refs','body'],hp);
      if(revision(entry.revision,hp+'.revision',{positive:true})!==i+1||revision(entry.base_revision,hp+'.base_revision')!==i)
        fail('HISTORY_SEQUENCE',hp,'History revisions must be contiguous and preserve their base revision');
      payload(record.kind,entry.source_refs,entry.body,record.owner_id,hp);
    }
    const latest=record.history.at(-1);
    if(!samePayload(record.kind,head,{source_refs:latest.source_refs,body:latest.body}))fail('HEAD_HISTORY_MISMATCH',path,'Current content differs from the last retained version');
    records.set(record.id,structuredClone(record));
  }
  // Existing array ordering is immaterial. All historical references stay valid
  // because deletion and identity/kind/owner replacement are not supported.
  for(const record of records.values())for(const entry of record.history)
    references(record.kind,entry.body,record.owner_id,records,'currentArray.'+record.id+'.history');
  return records;
}

/** Return a detached candidate content collection; caller owns persistence. */
export function applyContentChanges(currentArray,changes,namespaceValue){
  const ns=namespace(namespaceValue,'namespace'),records=currentRecords(currentArray,ns);
  if(!Array.isArray(changes))fail('ARRAY_REQUIRED','changes','Changes must be an array');
  const applied=[],unchanged=[];
  for(const [index,change]of changes.entries()){
    const path=`changes[${index}]`;fields(change,['id','kind','owner_id','base_revision','source_refs','body'],path);
    identity(change.kind,change.id,change.owner_id,path);
    const base=revision(change.base_revision,path+'.base_revision');
    const nextPayload=payload(change.kind,change.source_refs,change.body,change.owner_id,path);
    const old=records.get(change.id);
    if(old&&(old.kind!==change.kind||old.owner_id!==change.owner_id))fail('CONTENT_IDENTITY_MISMATCH',path,'Existing identity cannot change kind or owner');
    references(change.kind,nextPayload.body,change.owner_id,records,path+'.body');
    if(old&&base<old.revision){
      const previous=old.history[base];
      if(!samePayload(change.kind,nextPayload,{source_refs:previous.source_refs,body:previous.body}))
        fail('CONTENT_REVISION_CONFLICT',path+'.base_revision','This base revision was already used for a different payload');
      unchanged.push({id:old.id,revision:old.revision,replayed_revision:previous.revision});
      continue;
    }
    if(base!==(old?.revision??0))fail('CONTENT_BASE_REVISION',path+'.base_revision','Change must address the current revision, or zero for a new record');
    if(base===Number.MAX_SAFE_INTEGER)fail('REVISION_OVERFLOW',path+'.base_revision','Next revision would exceed the safe integer range');
    const next=base+1,entry={revision:next,base_revision:base,...structuredClone(nextPayload)};
    const record={id:change.id,kind:change.kind,owner_id:change.owner_id,namespace:structuredClone(ns),revision:next,
      ...structuredClone(nextPayload),history:[...(old?.history??[]),entry]};
    records.set(change.id,record);applied.push({id:record.id,revision:next});
  }
  return {records:[...records.values()],applied,unchanged,persisted:false,state_effects:[]};
}

/** Build only the native initial record shape; source/content admission is external. */
export function createLifecycleRecord(spec,namespaceValue){
  fields(spec,['kind','id','owner_id','source_refs','content_refs'],'spec');
  const status={goal:'proposed',commitment:'proposed',deployment:'proposed',text_delivery:'prepared',speech_delivery:'prepared'};
  if(!own(status,spec.kind))fail('LIFECYCLE_KIND','spec.kind','Unsupported lifecycle kind');
  const record={kind:spec.kind,id:text(spec.id,'spec.id'),namespace:namespace(namespaceValue,'namespace'),
    owner_id:text(spec.owner_id,'spec.owner_id'),status:status[spec.kind],revision:0,applied_events:[]};
  // Delivery is evidence about transport of an exact reply, not a new fact
  // about the world. A greeting therefore needs no fabricated content record.
  const delivery=['text_delivery','speech_delivery'].includes(spec.kind);
  const internalGoal=spec.kind==='goal'&&spec.id.startsWith('internal-goal:')&&Array.isArray(spec.source_refs)&&spec.source_refs.includes(`goal-proposal:${spec.id}`);
  return {record,source_refs:list(spec.source_refs,'spec.source_refs'),content_refs:(delivery||internalGoal)&&Array.isArray(spec.content_refs)&&spec.content_refs.length===0?[]:contentRefs(spec.content_refs,'spec.content_refs')};
}
