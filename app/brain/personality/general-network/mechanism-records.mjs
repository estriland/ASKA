import {applyContentChanges} from './content-records.mjs';

// These are versioned indexes into content, not numeric authority or copied
// narrative bodies. Structural source checks do not perform semantic review.
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const phases=['observation','next_iteration','after_commit','offline_review'];
const currentPhases=['observation','next_iteration'];
const archivalPhases=['after_commit','offline_review'];
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const role=(kinds,binding='subject_collection',scopeShapes=[])=>({kinds,binding,scope_shapes:scopeShapes});
const kind=(scope,allowed,roles)=>({scope,phases:allowed,roles});
export const mechanismRecordKinds=freeze({
  'L.episodes':kind(['subject'],archivalPhases,{episodes:role(['fact','memory'])}),
  'L.beliefs':kind(['subject'],archivalPhases,{beliefs:role(['belief'])}),
  'L.means':kind(['subject'],archivalPhases,{experiences:role(['fact'],'explicit_content_instance',[['subject','goal','means']])}),
  'L.interests':kind(['subject'],archivalPhases,{experiences:role(['fact','belief'],'explicit_content_instance',[['subject','activity']])}),
  'L.habits':kind(['subject'],archivalPhases,{experiences:role(['fact','belief'],'explicit_content_instance',[['subject','habit']])}),
  'L.relations':kind(['subject'],archivalPhases,{interactions:role(['fact'],'explicit_content_instance',[['subject','other']])}),
  'L.narrative':kind(['subject'],archivalPhases,{interpretations:role(['belief','memory'])}),
  'L.identity_proposal':kind(['subject'],['offline_review'],{proposals:role(['belief','memory'])}),
  'R.boundaries':kind(['subject','other'],currentPhases,{boundaries:role(['fact','belief'],'exact_record_scope')}),
  'G.progress':kind(['subject','goal','means'],currentPhases,{outcomes:{...role(['fact'],'exact_record_scope'),occurrence_status:['completed','ongoing']}}),
  'W.alternatives':kind(['subject'],currentPhases,{hypotheses:role(['belief'])}),
  'G.opportunity':kind(['subject','goal'],currentPhases,{conditions:role(['fact'],'exact_record_scope')}),
  'G.compatibility':kind(['subject'],currentPhases,{constraints:role(['fact','belief'])}),
  'R.roles':kind(['subject','other'],currentPhases,{roles:role(['belief'],'exact_record_scope')}),
  'C.strategy':kind(['subject'],currentPhases,{plans:role(['belief'],'explicit_content_instance',[['subject','event','strategy']])}),
  'C.switch':kind(['subject'],currentPhases,{changes:role(['fact'],'explicit_content_instance',[['subject','goal'],['subject','activity'],['subject','focus']])}),
  'M.needs':kind(['subject','need'],currentPhases,{conditions:role(['fact'],'exact_record_scope')}),
  'C.resources':kind(['subject'],currentPhases,{conditions:role(['fact'],'exact_record_scope')}),
});

class MechanismRecordError extends Error {
  constructor(code,path,message){super(message);this.name='MechanismRecordError';this.code=code;this.path=path;}
}
const fail=(code,path,message)=>{throw new MechanismRecordError(code,path,message);};
function fields(value,required,path){
  if(!object(value))fail('OBJECT_REQUIRED',path,'Expected an object');
  for(const key of required)if(!own(value,key))fail('MISSING_FIELD',path+'.'+key,'Required field is absent');
  for(const key of Object.keys(value))if(!required.includes(key))fail('UNKNOWN_FIELD',path+'.'+key,'Unexpected field');
}
function text(value,path){
  if(typeof value!=='string'||!value.trim()||value.includes('\0'))fail('TEXT_REQUIRED',path,'Nonblank text without NUL is required');return value;
}
function version(value,path,positive=false){
  if(!Number.isSafeInteger(value)||value<0||(positive&&value===0))fail('REVISION_INVALID',path,'Expected a safe nonnegative revision');return value;
}
function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(object(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
const keyOf=value=>JSON.stringify(canonical(value));
const same=(a,b)=>keyOf(a)===keyOf(b);
const sameKeys=(a,b)=>a.length===b.length&&a.every(key=>b.includes(key));
function namespace(value,path){
  fields(value,['character_version','conversation_id','world_id'],path);
  for(const [key,v]of Object.entries(value))text(v,path+'.'+key);
  return canonical(value);
}
function schemaFor(id,path){
  text(id,path);
  if(id.startsWith('P.'))fail('PROFILE_WRITE_FORBIDDEN',path,'This index cannot modify or publish a character profile');
  if(!own(mechanismRecordKinds,id))fail('MECHANISM_UNKNOWN',path,'No content-index contract is defined for this mechanism');
  return mechanismRecordKinds[id];
}
function scope(value,definition,path){
  if(!object(value)||!sameKeys(Object.keys(value),definition.scope))fail('MECHANISM_SCOPE',path,'Scope must contain exactly the declared instance keys');
  for(const [key,v]of Object.entries(value))text(v,path+'.'+key);
  return canonical(value);
}
function phase(value,definition,path){
  if(!definition.phases.includes(value))fail('MECHANISM_PHASE',path,'This mechanism cannot be maintained during this phase');
}
function reference(value,path){
  fields(value,['id','revision'],path);
  return {id:text(value.id,path+'.id'),revision:version(value.revision,path+'.revision',true)};
}
function resolve(ref,contents,owner,path){
  const record=contents.get(ref.id);
  if(!record)fail('CONTENT_REFERENCE_MISSING',path,'Referenced content does not exist: '+ref.id);
  if(record.owner_id!==owner)fail('CONTENT_OWNER_MISMATCH',path,'Reference belongs to another subject');
  const entry=record.history.find(row=>row.revision===ref.revision);
  if(!entry)fail('CONTENT_REVISION_MISSING',path,'Referenced content version does not exist');
  return {record,entry};
}
function contentDependencies(resolved){
  const {record,entry}=resolved;
  if(record.kind==='belief')return [entry.body.proposition_ref,...entry.body.basis_refs];
  if(record.kind==='memory')return entry.body.record_refs;
  return [];
}
function sourceClosure(ref,contents,owner,path,seen=new Set()){
  const key=keyOf(ref);if(seen.has(key))return [];seen.add(key);
  const resolved=resolve(ref,contents,owner,path),sources=[...resolved.entry.source_refs];
  for(const dependency of contentDependencies(resolved))sources.push(...sourceClosure(dependency,contents,owner,path,seen));
  return sources;
}
function governingFact(resolved,contents,owner,path){
  if(resolved.record.kind==='fact')return resolved.entry;
  if(resolved.record.kind==='belief'){
    const proposition=resolve(resolved.entry.body.proposition_ref,contents,owner,path+'.proposition_ref');
    if(proposition.record.kind!=='fact')fail('PROPOSITION_FACT_REQUIRED',path,'An object binding requires the belief’s proposition fact');
    return proposition.entry;
  }
  fail('INSTANCE_FACT_REQUIRED',path,'This role needs an explicitly scoped fact, not a summary');
}
function checkedRoles(value,definition,recordScope,contents,path){
  fields(value,Object.keys(definition.roles),path);
  const roles={},sourceRefs=[],seenSources=new Set();
  for(const [name,spec]of Object.entries(definition.roles)){
    const rp=path+'.'+name,raw=value[name];
    if(!Array.isArray(raw)||!raw.length)fail('ROLE_REFERENCES_REQUIRED',rp,'Each declared role needs exact content references');
    const refs=[],seen=new Set();
    for(const [index,item]of raw.entries()){
      const p=`${rp}[${index}]`,ref=reference(item,p),identity=keyOf(ref);
      if(seen.has(identity))continue;seen.add(identity);
      const resolved=resolve(ref,contents,recordScope.subject,p);
      if(!spec.kinds.includes(resolved.record.kind))fail('ROLE_CONTENT_KIND',p,'Content kind is not allowed for this mechanism role');
      if(spec.binding!=='subject_collection'||spec.occurrence_status){
        const fact=governingFact(resolved,contents,recordScope.subject,p);
        if(spec.occurrence_status&&!spec.occurrence_status.includes(fact.body.occurrence_status))
          fail('ACTUAL_PROGRESS_REQUIRED',p,'Progress may index completed or ongoing events, not plans or hypothetical outcomes');
        const explicit=fact.body.instance_refs??[];
        if(spec.binding==='exact_record_scope'&&!explicit.some(item=>same(item,recordScope)))
          fail('EXACT_INSTANCE_REFERENCE_REQUIRED',p,'Fact version does not explicitly identify this exact target scope');
        if(spec.binding==='explicit_content_instance'&&!explicit.some(item=>item.subject===recordScope.subject&&spec.scope_shapes.some(shape=>sameKeys(Object.keys(item),shape))))
          fail('CONTENT_INSTANCE_REFERENCE_REQUIRED',p,'Content collection requires a complete declared content-instance reference');
      }
      refs.push(ref);
      for(const source of sourceClosure(ref,contents,recordScope.subject,p))if(!seenSources.has(source)){seenSources.add(source);sourceRefs.push(source);}
    }
    roles[name]=refs;
  }
  return {roles,source_refs:sourceRefs};
}
function logical(payload){
  return {roles:Object.fromEntries(Object.entries(payload.roles).map(([name,refs])=>[name,[...new Map(refs.map(ref=>[keyOf(ref),ref])).entries()]
    .sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,ref])=>canonical(ref))])),source_refs:[...new Set(payload.source_refs)].sort()};
}
function checkDerivedSources(actual,expected,path){
  if(!Array.isArray(actual)||actual.some(item=>typeof item!=='string'||!item.trim()||item.includes('\0'))||
    !same([...new Set(actual)].sort(),[...new Set(expected)].sort()))fail('SOURCE_DEPENDENCY_MISMATCH',path,'Sources must be inherited from the exact referenced content versions');
}

/** Preserve exact content versions. This operation never changes numeric state. */
export function applyMechanismRecords(current,changes,contents,namespaceValue,options){
  fields(options,['phase'],'options');
  if(!phases.includes(options.phase))fail('PHASE_UNKNOWN','options.phase','Unknown content maintenance phase');
  const ns=namespace(namespaceValue,'namespace');
  // Reuse the content contract, including all history/owner/version validation.
  const contentMap=new Map(applyContentChanges(contents,[],ns).records.map(record=>[record.id,record]));
  if(!Array.isArray(current)||!Array.isArray(changes))fail('ARRAY_REQUIRED','records','Current indexes and changes must be arrays');
  const records=new Map();
  for(const [index,record]of current.entries()){
    const path=`current[${index}]`;fields(record,['id','mechanism','scope','namespace','revision','roles','source_refs','history'],path);
    text(record.id,path+'.id');const definition=schemaFor(record.mechanism,path+'.mechanism');
    const recordScope=scope(record.scope,definition,path+'.scope');
    if(!same(namespace(record.namespace,path+'.namespace'),ns))fail('NAMESPACE_MISMATCH',path+'.namespace','Index belongs to another namespace');
    if(records.has(record.id))fail('MECHANISM_ID_DUPLICATE',path+'.id','Index IDs must be unique');
    const revision=version(record.revision,path+'.revision',true);
    if(!Array.isArray(record.history)||record.history.length!==revision)fail('HISTORY_INCOMPLETE',path+'.history','Every index revision must be retained');
    const head=checkedRoles(record.roles,definition,recordScope,contentMap,path+'.roles');
    checkDerivedSources(record.source_refs,head.source_refs,path+'.source_refs');
    for(const [i,row]of record.history.entries()){
      const hp=`${path}.history[${i}]`;fields(row,['revision','base_revision','phase','roles','source_refs'],hp);
      if(version(row.revision,hp+'.revision',true)!==i+1||version(row.base_revision,hp+'.base_revision')!==i)
        fail('HISTORY_SEQUENCE',hp,'History must be contiguous with its original base revision');
      phase(row.phase,definition,hp+'.phase');
      const derived=checkedRoles(row.roles,definition,recordScope,contentMap,hp+'.roles');
      checkDerivedSources(row.source_refs,derived.source_refs,hp+'.source_refs');
    }
    const latest=record.history.at(-1);
    if(!same(logical(head),logical(latest)))fail('HEAD_HISTORY_MISMATCH',path,'Index head differs from its last retained version');
    records.set(record.id,structuredClone(record));
  }
  const applied=[],unchanged=[];
  for(const [index,change]of changes.entries()){
    const path=`changes[${index}]`;fields(change,['id','mechanism','scope','base_revision','roles'],path);
    text(change.id,path+'.id');const definition=schemaFor(change.mechanism,path+'.mechanism');
    phase(options.phase,definition,path+'.mechanism');
    const recordScope=scope(change.scope,definition,path+'.scope'),base=version(change.base_revision,path+'.base_revision');
    const previous=records.get(change.id);
    if(previous&&(previous.mechanism!==change.mechanism||!same(previous.scope,recordScope)))
      fail('MECHANISM_IDENTITY_MISMATCH',path,'An index cannot change mechanism or target scope');
    const payload=checkedRoles(change.roles,definition,recordScope,contentMap,path+'.roles');
    if(previous&&base<previous.revision){
      const old=previous.history[base];
      if(!same(logical(old),logical(payload)))fail('MECHANISM_REVISION_CONFLICT',path+'.base_revision','The same base revision already has a different payload');
      unchanged.push({id:previous.id,revision:previous.revision,replayed_revision:old.revision});continue;
    }
    if(base!==(previous?.revision??0))fail('MECHANISM_BASE_REVISION',path+'.base_revision','Use the current base revision, or zero for a new index');
    if(base===Number.MAX_SAFE_INTEGER)fail('REVISION_OVERFLOW',path+'.base_revision','Next revision exceeds the safe integer range');
    const next=base+1;
    const row={revision:next,base_revision:base,phase:options.phase,...structuredClone(payload)};
    records.set(change.id,{id:change.id,mechanism:change.mechanism,scope:recordScope,namespace:structuredClone(ns),revision:next,
      ...structuredClone(payload),history:[...(previous?.history??[]),row]});
    applied.push({id:change.id,revision:next});
  }
  return {records:[...records.values()],applied,unchanged,persisted:false,state_effects:[],semantic_review:'not_performed_here'};
}
