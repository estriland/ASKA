// Candidate-only identity allocation. The durable host owns receipt authority,
// semantic review and atomic publication; a declaration is not an event reward.
import {fingerprint} from './assembly-identity.mjs';
import {validateIdentityCatalog} from './identity-definitions.mjs';

const clone=structuredClone;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const text=x=>typeof x==='string'&&Boolean(x.trim())&&!x.includes('\0');
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const KINDS=['activity','relation','goal','means','strategy'];
const OCCURRENCES=['current','historical','mention','prospective'];
const ATTR={activity:[],relation:['other_id'],goal:['owner_id'],means:['goal_id'],strategy:[]};
const LOCAL_ATTR={activity:[],relation:['other_key'],goal:['owner_key'],means:['goal_key'],strategy:[]};
function need(ok,code,path){if(!ok)throw Object.assign(new Error(`${code}: ${path}`),{code,path});}
function fields(value,required,path,optional=[]){
  need(object(value),'IDENTITY_OBJECT_REQUIRED',path);
  need(required.every(key=>Object.hasOwn(value,key)),'IDENTITY_FIELD_REQUIRED',path);
  need(Object.keys(value).every(key=>required.includes(key)||optional.includes(key)),'IDENTITY_FIELD_UNKNOWN',path);
}
function namespace(value,path){
  fields(value,['character_version','conversation_id','world_id'],path);
  need(Object.values(value).every(text),'IDENTITY_NAMESPACE_INVALID',path);
}
function identityScope(ns,subject){namespace(ns,'namespace');need(text(subject)&&subject!=='user','IDENTITY_SUBJECT_INVALID','subject');}
function allocatedId(ns,inputId,kind,key){return `semantic-${kind}:${fingerprint({namespace:ns,input_id:inputId,kind,key})}`;}
function fixedActors(subject){return [
  {id:subject,label:'self',origin:{kind:'host',key:'self'}},
  {id:'user',label:'user',origin:{kind:'host',key:'user'}},
];}
function definitionActors(catalog){return catalog.actors.filter(row=>row.id!=='user').map(row=>({id:row.id,label:row.label,
  origin:{kind:'definition',definition_id:row.id,catalog_sha256:fingerprint(catalog)}}));}
function declarationOrigin(origin,path){
  fields(origin,['kind','input_id','key','source_message_id','quote','source_role','source_sha256'],path);
  need(origin.kind==='declaration','IDENTITY_ORIGIN_INVALID',path+'.kind');
  for(const key of ['input_id','key','source_message_id','quote'])need(text(origin[key]),'IDENTITY_ORIGIN_INVALID',path+'.'+key);
  need(origin.source_role===null||text(origin.source_role),'IDENTITY_ORIGIN_INVALID',path+'.source_role');
  need(hash(origin.source_sha256),'IDENTITY_ORIGIN_INVALID',path+'.source_sha256');
}
function validateStoredOrigin(record,kind,ns,path){
  need(text(record.id)&&text(record.label),'IDENTITY_RECORD_INVALID',path);
  declarationOrigin(record.origin,path+'.origin');
  need(record.id===allocatedId(ns,record.origin.input_id,kind,record.origin.key),'IDENTITY_CANONICAL_ID_MISMATCH',path+'.id');
}
function validateInternalGoal(record,ns,subject,path){
  need(record.kind==='goal'&&record.owner_id===subject,'INTERNAL_GOAL_OWNER_OR_KIND',path);
  need(text(record.id)&&text(record.label),'IDENTITY_RECORD_INVALID',path);
  const origin=record.origin;
  fields(origin,['kind','proposal_id','key','review_receipt_id','proposal_sha256'],path+'.origin');
  need(origin.kind==='internal_goal_proposal'&&[origin.proposal_id,origin.key,origin.review_receipt_id].every(text)&&hash(origin.proposal_sha256),
    'INTERNAL_GOAL_ORIGIN_INVALID',path+'.origin');
  need(record.id==='internal-goal:'+fingerprint({namespace:ns,subject,proposal_id:origin.proposal_id,key:origin.key}),
    'IDENTITY_CANONICAL_ID_MISMATCH',path+'.id');
}
function validateEventLinks(events){
  const byId=new Map(events.map(record=>[record.id,record])),done=new Set(),visiting=new Set();
  function visit(id){
    if(done.has(id))return;
    need(!visiting.has(id),'IDENTITY_EVENT_CYCLE',id);visiting.add(id);
    const event=byId.get(id);
    if(Object.hasOwn(event,'about_event')){
      need(byId.has(event.about_event),'IDENTITY_EVENT_UNKNOWN',event.id+'.about_event');visit(event.about_event);
    }
    visiting.delete(id);done.add(id);
  }
  for(const id of byId.keys())visit(id);
}
function validateRegistry(registry,ns,subject,identityCatalog=null){
  fields(registry,['schema','namespace','subject','actors','entities','events'],'registry',['definition_catalog_sha256']);
  need(registry.schema==='asuka.semantic-identities/1','IDENTITY_REGISTRY_SCHEMA','registry.schema');
  namespace(registry.namespace,'registry.namespace');
  need(same(registry.namespace,ns)&&registry.subject===subject,'IDENTITY_SCOPE_MISMATCH','registry');
  const catalog=identityCatalog==null?null:validateIdentityCatalog(identityCatalog,{namespace:ns,subject});
  if(catalog)need(registry.definition_catalog_sha256===fingerprint(catalog),'IDENTITY_DEFINITION_CATALOG_MISMATCH','registry.definition_catalog_sha256');
  else need(!Object.hasOwn(registry,'definition_catalog_sha256'),'IDENTITY_DEFINITION_CATALOG_REQUIRED','registry');
  for(const group of ['actors','entities','events'])need(Array.isArray(registry[group]),'IDENTITY_ARRAY_REQUIRED','registry.'+group);
  const allIds=new Set(),actorIds=new Set(),goalIds=new Set(),relationPairs=new Set();
  function uniqueId(record,path){need(text(record.id),'IDENTITY_ID_INVALID',path);need(!allIds.has(record.id),'IDENTITY_ID_DUPLICATE',path);allIds.add(record.id);}
  const fixed=fixedActors(subject),defined=catalog?definitionActors(catalog):[];
  for(const [index,record]of registry.actors.entries()){
    const path=`registry.actors[${index}]`;fields(record,['id','label','origin'],path);uniqueId(record,path+'.id');
    if(record.id===subject||record.id==='user')need(same(record,fixed.find(item=>item.id===record.id)),'IDENTITY_FIXED_ACTOR_CHANGED',path);
    else if(record.origin?.kind==='definition'||defined.some(expected=>expected.id===record.id))
      need(defined.some(expected=>same(record,expected)),'IDENTITY_DEFINITION_ACTOR_MISMATCH',path);
    else{validateStoredOrigin(record,'actor',ns,path);need(!['self','user'].includes(record.origin.key),'IDENTITY_RESERVED_KEY',path+'.origin.key');}
    actorIds.add(record.id);
  }
  need(fixed.every(record=>actorIds.has(record.id)),'IDENTITY_FIXED_ACTOR_MISSING','registry.actors');
  need(defined.every(record=>actorIds.has(record.id)),'IDENTITY_DEFINITION_ACTOR_MISSING','registry.actors');
  for(const [index,record]of registry.entities.entries()){
    const path=`registry.entities[${index}]`;need(KINDS.includes(record?.kind),'IDENTITY_KIND_INVALID',path+'.kind');
    fields(record,['id','kind','label','origin',...ATTR[record.kind]],path,record.kind==='activity'?['definition_id']:[]);uniqueId(record,path+'.id');
    if(record.origin?.kind==='internal_goal_proposal')validateInternalGoal(record,ns,subject,path);
    else validateStoredOrigin(record,record.kind,ns,path);
    if(Object.hasOwn(record,'definition_id'))need(catalog?.activities.some(definition=>definition.id===record.definition_id),'IDENTITY_ACTIVITY_DEFINITION_UNKNOWN',path+'.definition_id');
    if(record.kind==='relation'){
      need(actorIds.has(record.other_id),'IDENTITY_ACTOR_UNKNOWN',path+'.other_id');
      need(record.other_id!==subject,'IDENTITY_SELF_RELATION_FORBIDDEN',path+'.other_id');
      const pair=JSON.stringify([subject,record.other_id]);need(!relationPairs.has(pair),'IDENTITY_RELATION_ALREADY_EXISTS',path);relationPairs.add(pair);
    }
    if(record.kind==='goal'){need(actorIds.has(record.owner_id),'IDENTITY_ACTOR_UNKNOWN',path+'.owner_id');goalIds.add(record.id);}
  }
  for(const record of registry.entities)if(record.kind==='means')need(goalIds.has(record.goal_id),'IDENTITY_GOAL_UNKNOWN',record.id+'.goal_id');
  for(const [index,record]of registry.events.entries()){
    const path=`registry.events[${index}]`;fields(record,['id','label','origin','occurrence_kind','participants'],path,['about_event']);uniqueId(record,path+'.id');
    validateStoredOrigin(record,'event',ns,path);
    need(OCCURRENCES.includes(record.occurrence_kind),'IDENTITY_OCCURRENCE_INVALID',path+'.occurrence_kind');
    need(Array.isArray(record.participants)&&record.participants.length>0&&record.participants.every(id=>actorIds.has(id)),
      'IDENTITY_PARTICIPANTS_INVALID',path+'.participants');
    need(new Set(record.participants).size===record.participants.length,'IDENTITY_PARTICIPANTS_DUPLICATE',path+'.participants');
    if(['current','mention'].includes(record.occurrence_kind)){
      need(record.origin.source_message_id===record.origin.input_id,'IDENTITY_CURRENT_SOURCE_REQUIRED',path+'.origin');
      need(record.origin.source_role!=='reference','IDENTITY_CURRENT_REFERENCE_FORBIDDEN',path+'.origin');
    }
    if(Object.hasOwn(record,'about_event'))need(text(record.about_event),'IDENTITY_EVENT_UNKNOWN',path+'.about_event');
  }
  validateEventLinks(registry.events);
  return {allIds,actorIds,relationPairs};
}

/** Fixed self/user are host identities, not model declarations or aliases for
 * named third parties. No dynamic identity exists until the host commits it. */
export function emptyIdentityRegistry(ns,subject,{identity_catalog=null}={}){
  identityScope(ns,subject);
  const catalog=identity_catalog==null?null:validateIdentityCatalog(identity_catalog,{namespace:ns,subject});
  return {schema:'asuka.semantic-identities/1',namespace:clone(ns),subject,actors:[...fixedActors(subject),...(catalog?definitionActors(catalog):[])],entities:[],events:[],
    ...(catalog?{definition_catalog_sha256:fingerprint(catalog)}:{})};
}

/** Host-only append of independently reviewed internal goal identities. This
 * consumes an admitted proposal identity, not quoted evidence or a model claim
 * of approval. The durable host must authenticate the proposal/review and
 * publish this candidate registry atomically. It does not adopt a goal. */
export function applyInternalGoalIdentities(registry,goals,context){
  fields(context,['namespace','subject'],'context',['identity_catalog']);
  const {namespace:ns,subject}=context;identityScope(ns,subject);
  validateRegistry(registry,ns,subject,context.identity_catalog);
  need(Array.isArray(goals),'IDENTITY_ARRAY_REQUIRED','goals');
  const next=clone(registry),existing=new Map([...next.actors,...next.entities,...next.events].map(row=>[row.id,row])),added=[];
  for(const [i,goal]of goals.entries()){
    const p=`goals[${i}]`;fields(goal,['id','label','owner_id','origin'],p);
    const row={id:goal.id,kind:'goal',label:goal.label,owner_id:goal.owner_id,origin:clone(goal.origin)};
    validateInternalGoal(row,ns,subject,p);
    const previous=existing.get(row.id);
    if(previous){need(same(previous,row),'INTERNAL_GOAL_ID_CONFLICT',p);continue;}
    next.entities.push(row);existing.set(row.id,row);added.push(row.id);
  }
  validateRegistry(next,ns,subject,context.identity_catalog);
  return {registry:next,added_ids:added};
}

/** Apply an append-only candidate program against an exact committed registry.
 * Source hashes retain provenance, not independent authentication: the caller
 * must supply authoritative immutable receipts and publish the returned registry
 * only with the reviewed content/state transaction. No payload is executed. */
export function applyIdentityProgram(registry,program,context){
  fields(context,['namespace','subject','input_id','sources'],'context',['identity_catalog']);
  const {namespace:ns,subject,input_id:inputId}=context;identityScope(ns,subject);
  need(text(inputId),'IDENTITY_INPUT_INVALID','context.input_id');
  const validated=validateRegistry(registry,ns,subject,context.identity_catalog);
  fields(program,['schema','base_sha256','input_id','declarations'],'program');
  need(program.schema==='asuka.identity-program/1','IDENTITY_PROGRAM_SCHEMA','program.schema');
  need(hash(program.base_sha256)&&program.base_sha256===fingerprint(registry),'IDENTITY_BASE_MISMATCH','program.base_sha256');
  need(program.input_id===inputId,'IDENTITY_INPUT_MISMATCH','program.input_id');
  fields(program.declarations,['actors','entities','events'],'program.declarations');
  need(Array.isArray(context.sources),'IDENTITY_ARRAY_REQUIRED','context.sources');
  const sources=new Map();
  for(const [index,source]of context.sources.entries()){
    const path=`context.sources[${index}]`;fields(source,['id','text'],path,['role']);
    need(text(source.id)&&typeof source.text==='string'&&!source.text.includes('\0'),'IDENTITY_SOURCE_INVALID',path);
    need(source.role==null||text(source.role),'IDENTITY_SOURCE_INVALID',path+'.role');
    need(!sources.has(source.id),'IDENTITY_SOURCE_DUPLICATE',path+'.id');
    sources.set(source.id,{id:source.id,text:source.text,role:source.role??null});
  }
  need(sources.has(inputId),'IDENTITY_SOURCE_MISSING','context.input_id');
  const next=clone(registry),actors=new Map([['self',subject],['user','user']]),entities=new Map(),events=new Map();
  const existing={actors:new Map(registry.actors.map(record=>[record.id,record])),
    entities:new Map(registry.entities.map(record=>[record.id,record])),events:new Map(registry.events.map(record=>[record.id,record]))};
  const declarations=program.declarations,seen={actors:new Set(),entities:new Set(),events:new Set()},newRecords={entities:[],events:[]};
  function bindDeclaration(row,group,index){
    const path=`program.declarations.${group}[${index}]`;
    need(object(row)&&text(row.key),'IDENTITY_KEY_INVALID',path+'.key');
    need(['existing','new'].includes(row.mode),'IDENTITY_MODE_INVALID',path+'.mode');
    if(group==='entities')need(KINDS.includes(row.kind),'IDENTITY_KIND_INVALID',path+'.kind');
    const key=group==='entities'?JSON.stringify([row.kind,row.key]):row.key;
    need(!seen[group].has(key),'IDENTITY_KEY_DUPLICATE',path+'.key');seen[group].add(key);
    const bindings=group==='actors'?actors:group==='entities'?entities:events;
    if(row.mode==='existing'){
      fields(row,group==='entities'?['key','kind','mode','id']:['key','mode','id'],path);
      need(text(row.id)&&existing[group].has(row.id),'IDENTITY_EXISTING_NOT_FOUND',path+'.id');
      const record=existing[group].get(row.id);
      if(group==='entities')need(record.kind===row.kind,'IDENTITY_KIND_MISMATCH',path+'.kind');
      if(group==='actors'&&['self','user'].includes(row.key))need(row.id===(row.key==='self'?subject:'user'),'IDENTITY_FIXED_ACTOR_CHANGED',path);
      if(group==='actors'&&[subject,'user'].includes(row.id))need(row.key===(row.id===subject?'self':'user'),'IDENTITY_FIXED_ACTOR_ALIAS',path);
      bindings.set(key,row.id);return;
    }
    const attrs=group==='entities'?LOCAL_ATTR[row.kind]:group==='events'?['occurrence_kind','participants']:[];
    fields(row,['key',...(group==='entities'?['kind']:[]),'mode','label','source_message_id','quote',...attrs],path,
      group==='events'?['about_event']:group==='entities'&&row.kind==='activity'?['definition_id']:[]);
    need(text(row.label),'IDENTITY_LABEL_INVALID',path+'.label');
    if(group==='actors')need(!['self','user'].includes(row.key),'IDENTITY_RESERVED_KEY',path+'.key');
    need(text(row.source_message_id)&&sources.has(row.source_message_id),'IDENTITY_SOURCE_MISSING',path+'.source_message_id');
    const source=sources.get(row.source_message_id);
    need(text(row.quote)&&source.text.includes(row.quote),'IDENTITY_QUOTE_MISMATCH',path+'.quote');
    const kind=group==='actors'?'actor':group==='events'?'event':row.kind,id=allocatedId(ns,inputId,kind,row.key);
    need(!validated.allIds.has(id),'IDENTITY_ID_ALREADY_EXISTS',path+'.key');validated.allIds.add(id);
    const record={id,...(group==='entities'?{kind:row.kind}:{}),label:row.label,origin:{kind:'declaration',input_id:inputId,key:row.key,
      source_message_id:source.id,quote:row.quote,source_role:source.role,source_sha256:fingerprint(source)}};
    if(Object.hasOwn(row,'definition_id')){
      need(context.identity_catalog?.activities.some(definition=>definition.id===row.definition_id),'IDENTITY_ACTIVITY_DEFINITION_UNKNOWN',path+'.definition_id');
      record.definition_id=row.definition_id;
    }
    bindings.set(key,id);next[group].push(record);
    if(group!=='actors')newRecords[group].push({record,row,path});
  }
  for(const group of ['actors','entities','events']){
    need(Array.isArray(declarations[group]),'IDENTITY_ARRAY_REQUIRED','program.declarations.'+group);
    declarations[group].forEach((row,index)=>bindDeclaration(row,group,index));
  }
  function actorId(key,path){need(text(key)&&actors.has(key),'IDENTITY_ACTOR_KEY_UNKNOWN',path);return actors.get(key);}
  for(const {record,row,path}of newRecords.entities){
    if(row.kind==='relation'){
      record.other_id=actorId(row.other_key,path+'.other_key');
      need(record.other_id!==subject,'IDENTITY_SELF_RELATION_FORBIDDEN',path+'.other_key');
      const pair=JSON.stringify([subject,record.other_id]);
      need(!validated.relationPairs.has(pair),'IDENTITY_RELATION_ALREADY_EXISTS',path);validated.relationPairs.add(pair);
    }
    if(row.kind==='goal')record.owner_id=actorId(row.owner_key,path+'.owner_key');
    if(row.kind==='means'){
      const key=JSON.stringify(['goal',row.goal_key]);
      need(text(row.goal_key)&&entities.has(key),'IDENTITY_GOAL_KEY_UNKNOWN',path+'.goal_key');record.goal_id=entities.get(key);
    }
  }
  for(const {record,row,path}of newRecords.events){
    need(OCCURRENCES.includes(row.occurrence_kind),'IDENTITY_OCCURRENCE_INVALID',path+'.occurrence_kind');
    if(['current','mention'].includes(row.occurrence_kind)){
      need(row.source_message_id===inputId,'IDENTITY_CURRENT_SOURCE_REQUIRED',path+'.source_message_id');
      need(record.origin.source_role!=='reference','IDENTITY_CURRENT_REFERENCE_FORBIDDEN',path+'.source_message_id');
    }
    record.occurrence_kind=row.occurrence_kind;
    need(Array.isArray(row.participants)&&row.participants.length>0,'IDENTITY_PARTICIPANTS_INVALID',path+'.participants');
    record.participants=row.participants.map((key,index)=>actorId(key,`${path}.participants[${index}]`));
    need(new Set(record.participants).size===record.participants.length,'IDENTITY_PARTICIPANTS_DUPLICATE',path+'.participants');
    if(Object.hasOwn(row,'about_event')){
      need(text(row.about_event)&&events.has(row.about_event),'IDENTITY_EVENT_KEY_UNKNOWN',path+'.about_event');
      record.about_event=events.get(row.about_event);
    }
  }
  validateRegistry(next,ns,subject,context.identity_catalog);
  return {registry:next,bindings:{actors:Object.fromEntries(actors),entities:Object.fromEntries(entities),events:Object.fromEntries(events)}};
}

/** Check the canonical runtime path as well as the public hydration path. This
 * does not replace SituationFrame/content validation, profile checks, receipt
 * authentication or semantic approval. Existing content versions remain the
 * durable host's responsibility; only supplied fact changes are checked here.
 * No aliases, identities, facts or classifications are repaired or inferred. */
export function validateIdentityFrame(frame,registry,context){
  fields(context,['namespace','subject'],'context',['content_changes','identity_catalog']);
  const {namespace:ns,subject}=context;identityScope(ns,subject);validateRegistry(registry,ns,subject,context.identity_catalog);
  need(object(frame)&&frame.schema==='asuka.situation-frame/1','IDENTITY_FRAME_SCHEMA','frame.schema');
  fields(frame.identity,['character_version','conversation_id','world_id','subject','base_revision','input_id','scene_time'],'frame.identity');
  const identity=frame.identity,inputId=identity.input_id;
  need(same(Object.fromEntries(Object.keys(ns).map(key=>[key,identity[key]])),ns)&&identity.subject===subject,
    'IDENTITY_SCOPE_MISMATCH','frame.identity');
  need(text(inputId),'IDENTITY_INPUT_INVALID','frame.identity.input_id');
  need(Number.isSafeInteger(identity.base_revision)&&identity.base_revision>=0,'IDENTITY_REVISION_INVALID','frame.identity.base_revision');
  need(identity.scene_time===null||typeof identity.scene_time==='number'&&Number.isFinite(identity.scene_time),'IDENTITY_TIME_INVALID','frame.identity.scene_time');
  const entities=new Map(registry.entities.map(record=>[record.id,record]));
  const events=new Map(registry.events.map(record=>[record.id,record]));
  const actors=new Set(registry.actors.map(record=>record.id));
  const groupKinds={activities:'activity',relations:'relation',goals:'goal',means:'means',strategies:'strategy'};
  function rows(group){
    const value=Object.hasOwn(frame,group)?frame[group]:[];
    need(Array.isArray(value),'IDENTITY_ARRAY_REQUIRED','frame.'+group);return value;
  }
  function entity(kind,id,path){
    need(text(id)&&entities.has(id),'IDENTITY_ENTITY_UNREGISTERED',path);
    const record=entities.get(id);need(record.kind===kind,'IDENTITY_KIND_MISMATCH',path);return record;
  }
  function actor(id,path){need(text(id)&&actors.has(id),'IDENTITY_ACTOR_UNKNOWN',path);}
  function event(id,path){
    need(text(id)&&events.has(id),'IDENTITY_EVENT_UNKNOWN',path);
    const record=events.get(id);
    if(record.origin.source_role==='reference')need(!record.participants.includes('user'),'IDENTITY_REFERENCE_USER_FORBIDDEN',path);
    if(record.occurrence_kind==='mention')need(text(record.about_event)&&events.has(record.about_event),'IDENTITY_MENTION_TARGET_REQUIRED',path);
    return record;
  }
  function typedReference(reference,path){
    need(object(reference)&&text(reference.kind)&&text(reference.id),'IDENTITY_REFERENCE_INVALID',path);
    if(KINDS.includes(reference.kind)){
      const record=entity(reference.kind,reference.id,path+'.id');
      if(reference.kind==='means'){
        entity('goal',reference.goal_id,path+'.goal_id');
        need(record.goal_id===reference.goal_id,'IDENTITY_MEANS_GOAL_CHANGED',path+'.goal_id');
      }
    }
    // Static/profile and per-turn appraisal/focus references are validated by
    // the original frame validator, not invented as persistent identities.
  }
  for(const [group,kind]of Object.entries(groupKinds))for(const [index,row]of rows(group).entries()){
    const path=`frame.${group}[${index}]`;need(object(row),'IDENTITY_OBJECT_REQUIRED',path);
    const record=entity(kind,row.id,path+'.id');
    if(kind==='relation'){
      actor(row.other_id,path+'.other_id');need(record.other_id===row.other_id,'IDENTITY_RELATION_OTHER_CHANGED',path+'.other_id');
    }
    if(kind==='goal'){
      actor(row.owner_id,path+'.owner_id');need(record.owner_id===row.owner_id,'IDENTITY_GOAL_OWNER_CHANGED',path+'.owner_id');
    }
    if(kind==='means'){
      entity('goal',row.goal_id,path+'.goal_id');need(record.goal_id===row.goal_id,'IDENTITY_MEANS_GOAL_CHANGED',path+'.goal_id');
    }
    if(kind==='strategy')event(row.event_id,path+'.event_id');
  }
  for(const [index,row]of rows('appraisals').entries()){
    const path=`frame.appraisals[${index}]`;need(object(row),'IDENTITY_OBJECT_REQUIRED',path);
    event(row.event_id,path+'.event_id');typedReference(row.concern,path+'.concern');
    if(Object.hasOwn(row,'responsible_other_id'))actor(row.responsible_other_id,path+'.responsible_other_id');
  }
  for(const [index,row]of rows('focus').entries()){
    const path=`frame.focus[${index}]`;need(object(row),'IDENTITY_OBJECT_REQUIRED',path);typedReference(row.about,path+'.about');
  }
  for(const [index,row]of rows('narratives').entries()){
    const path=`frame.narratives[${index}]`;need(object(row),'IDENTITY_OBJECT_REQUIRED',path);actor(row.other_id,path+'.other_id');
    need(row.other_id!==subject,'IDENTITY_NARRATIVE_SELF',path+'.other_id');
    need(object(row.content_ref),'IDENTITY_REFERENCE_INVALID',path+'.content_ref');
    if(row.content_ref.kind==='event')event(row.content_ref.id,path+'.content_ref.id');
    else{need(['activity','goal'].includes(row.content_ref.kind),'IDENTITY_NARRATIVE_CONTENT',path+'.content_ref');entity(row.content_ref.kind,row.content_ref.id,path+'.content_ref.id');}
    if(Object.hasOwn(row,'interest_activity_id'))entity('activity',row.interest_activity_id,path+'.interest_activity_id');
    if(Object.hasOwn(row,'purpose_goal_id'))need(entity('goal',row.purpose_goal_id,path+'.purpose_goal_id').owner_id===subject,'IDENTITY_NARRATIVE_GOAL_OWNER',path+'.purpose_goal_id');
  }
  for(const [index,link]of rows('links').entries()){
    const path=`frame.links[${index}]`;need(object(link),'IDENTITY_OBJECT_REQUIRED',path);
    typedReference(link.from,path+'.from');typedReference(link.to,path+'.to');
    if(link.kind==='goal_support'&&link.from?.kind==='relation'&&link.from.component==='shared')entity('activity',link.from.activity_id,path+'.from.activity_id');
  }
  const changes=context.content_changes??[];need(Array.isArray(changes),'IDENTITY_ARRAY_REQUIRED','context.content_changes');
  for(const [index,change]of changes.entries()){
    const path=`context.content_changes[${index}]`;need(object(change),'IDENTITY_OBJECT_REQUIRED',path);
    if(change.kind!=='fact')continue;
    need(change.owner_id===subject,'IDENTITY_FACT_OWNER_MISMATCH',path+'.owner_id');
    const body=change.body;need(object(body),'IDENTITY_OBJECT_REQUIRED',path+'.body');
    const occurrence=event(body.occurrence_id,path+'.body.occurrence_id');
    need(text(body.observation_id),'IDENTITY_SOURCE_MISSING',path+'.body.observation_id');
    need(Array.isArray(change.source_refs)&&change.source_refs.includes(body.observation_id),'IDENTITY_FACT_SOURCE_MISMATCH',path+'.source_refs');
    if(body.presentation==='current_report')need(body.observation_id===inputId,'IDENTITY_CURRENT_SOURCE_REQUIRED',path+'.body.observation_id');
    if(body.observation_id===occurrence.origin.source_message_id&&occurrence.origin.source_role==='reference')
      need(['recollection','quotation'].includes(body.presentation),'IDENTITY_REFERENCE_PRESENTATION',path+'.body.presentation');
    if(occurrence.occurrence_kind==='historical'){
      need(['recollection','quotation'].includes(body.presentation),'IDENTITY_HISTORICAL_PRESENTATION',path+'.body.presentation');
    }else if(occurrence.occurrence_kind==='prospective'){
      need(['planned','conditional','unknown'].includes(body.occurrence_status),'IDENTITY_PROSPECTIVE_STATUS',path+'.body.occurrence_status');
    }else if(occurrence.occurrence_kind==='mention'){
      need(body.observation_id===inputId&&body.presentation==='current_report','IDENTITY_MENTION_CURRENT_SOURCE',path+'.body');
      need(['completed','ongoing'].includes(body.occurrence_status),'IDENTITY_MENTION_STATUS',path+'.body.occurrence_status');
    }else{
      need(['completed','ongoing','unknown'].includes(body.occurrence_status),'IDENTITY_CURRENT_STATUS',path+'.body.occurrence_status');
      if(occurrence.origin.input_id===inputId)need(body.presentation==='current_report','IDENTITY_NEW_CURRENT_PRESENTATION',path+'.body.presentation');
      need(['current_report','recollection','quotation'].includes(body.presentation),'IDENTITY_CURRENT_PRESENTATION',path+'.body.presentation');
    }
  }
}
