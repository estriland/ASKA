// Pure outcome projection. The caller supplies host-trusted admitted criteria
// and content versions. Hash agreement is not independent semantic approval.
import {fingerprint} from './assembly-identity.mjs';
import {applyContentChanges} from './content-records.mjs';

const clone=structuredClone,own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=(code,path)=>{throw Object.assign(new Error(code),{code,path});};
const need=(yes,code,path)=>{if(!yes)fail(code,path);};
const same=(a,b)=>fingerprint(a)===fingerprint(b);
function fields(value,required,path,optional=[]){
  need(object(value),'OBJECT_REQUIRED',path);need(required.every(k=>own(value,k)),'FIELD_REQUIRED',path);
  need(Object.keys(value).every(k=>required.includes(k)||optional.includes(k)),'UNEXPECTED_FIELD',path);
}
function text(value,path){need(typeof value==='string'&&value.trim()&&!value.includes('\0'),'TEXT_REQUIRED',path);return value;}
function integer(value,path,positive=false){need(Number.isSafeInteger(value)&&value>=(positive?1:0),'REVISION_INVALID',path);return value;}
function list(value,path){need(Array.isArray(value),'ARRAY_REQUIRED',path);return value;}
function namespace(value,path){fields(value,['character_version','conversation_id','world_id'],path);Object.entries(value).forEach(([k,v])=>text(v,path+'.'+k));}
function ref(value,path){fields(value,['id','revision'],path);return {id:text(value.id,path+'.id'),revision:integer(value.revision,path+'.revision',true)};}
const refKey=r=>JSON.stringify([r.id,r.revision]);
function refs(value,path){
  const out=list(value,path).map((r,i)=>ref(r,`${path}/${i}`));need(out.length>0,'REFERENCES_REQUIRED',path);
  need(new Set(out.map(refKey)).size===out.length,'REFERENCE_DUPLICATE',path);return out;
}
function digest(value,path){need(typeof value==='string'&&value.length===64&&/^[a-f0-9]+$/.test(value),'HASH_REQUIRED',path);}

/** No disk, numeric effects, samples, lifecycle actions or semantic acceptance. */
export function validateOutcomeIntake(candidate,context){
  fields(context,['namespace','subject','input_id','base_revision','identity_registry','contents','criterion_catalog','criterion_admissions'],'context');
  namespace(context.namespace,'context.namespace');text(context.subject,'context.subject');text(context.input_id,'context.input_id');integer(context.base_revision,'context.base_revision');
  const c=clone(context),registry=c.identity_registry;
  need(object(registry)&&registry.schema==='asuka.semantic-identities/1','IDENTITY_REGISTRY_REQUIRED','context.identity_registry');
  need(same(registry.namespace,c.namespace)&&registry.subject===c.subject,'NAMESPACE_MISMATCH','context.identity_registry');
  function indexed(rows,path){
    const index=new Map();for(const [i,row]of list(rows,path).entries()){
      need(object(row),'OBJECT_REQUIRED',path+'/'+i);text(row.id,path+'/'+i+'/id');need(!index.has(row.id),'IDENTITY_DUPLICATE',path+'/'+i);index.set(row.id,row);
    }return index;
  }
  const actors=indexed(registry.actors,'registry.actors'),entities=indexed(registry.entities,'registry.entities'),events=indexed(registry.events,'registry.events');
  need(actors.has(c.subject),'SUBJECT_ACTOR_MISSING','context.subject');
  const content=new Map(applyContentChanges(c.contents,[],c.namespace).records.map(record=>[record.id,record]));
  const usedFacts=new Map();
  function fact(reference,path,collect=true){
    const r=ref(reference,path),record=content.get(r.id);need(record?.kind==='fact','FACT_REFERENCE_REQUIRED',path);
    need(record.owner_id===c.subject,'FACT_CONTENT_OWNER','context.contents.'+r.id);
    const version=record.history.find(v=>v.revision===r.revision);need(version,'FACT_VERSION_MISSING',path);
    const result={id:r.id,kind:'fact',namespace:clone(record.namespace),owner_id:record.owner_id,version:clone(version)};
    if(collect)usedFacts.set(refKey(r),result);return result;
  }
  function hasScope(f,scope,path){need(f.version.body.instance_refs?.some(v=>same(v,scope)),'FACT_SCOPE_MISMATCH',path);}
  function goal(id,path){
    const g=entities.get(id);if(!g)return null;need(g.kind==='goal','GOAL_KIND_MISMATCH',path);need(actors.has(g.owner_id),'GOAL_OWNER_UNKNOWN',path);return g;
  }

  const criteria=new Map(),admissions=new Map(),series=new Map();
  for(const [i,a]of list(c.criterion_admissions,'context.criterion_admissions').entries()){
    const p=`criterion_admissions/${i}`;fields(a,['id','revision','criterion_ref','criterion_sha256','goal_id','basis_sha256','decision'],p);
    text(a.id,p+'.id');integer(a.revision,p+'.revision',true);ref(a.criterion_ref,p+'.criterion_ref');text(a.goal_id,p+'.goal_id');
    digest(a.criterion_sha256,p+'.criterion_sha256');digest(a.basis_sha256,p+'.basis_sha256');
    need(a.decision==='accepted_for_outcome_projection','CRITERION_NOT_ADMITTED',p+'.decision');
    const key=refKey(a);need(!admissions.has(key),'ADMISSION_DUPLICATE',p);admissions.set(key,a);
  }
  for(const [i,r]of list(c.criterion_catalog,'context.criterion_catalog').entries()){
    const p=`criterion_catalog/${i}`;fields(r,['id','revision','namespace','goal_id','scope','parent_ref','statement','basis_refs','admission_ref'],p);
    text(r.id,p+'.id');integer(r.revision,p+'.revision',true);namespace(r.namespace,p+'.namespace');need(same(r.namespace,c.namespace),'NAMESPACE_MISMATCH',p);
    text(r.goal_id,p+'.goal_id');need(goal(r.goal_id,p+'.goal_id'),'CRITERION_GOAL_UNKNOWN',p+'.goal_id');
    need(['whole_goal','local'].includes(r.scope),'CRITERION_SCOPE',p+'.scope');text(r.statement,p+'.statement');
    if(r.scope==='whole_goal')need(r.parent_ref===null,'WHOLE_CRITERION_PARENT',p+'.parent_ref');else ref(r.parent_ref,p+'.parent_ref');
    const basis=refs(r.basis_refs,p+'.basis_refs').map((b,j)=>fact(b,`${p}.basis_refs/${j}`,false));
    for(const f of basis)hasScope(f,{subject:c.subject,goal:r.goal_id},p+'.basis_refs');
    // A standard may describe a future requirement; it is not an outcome fact.
    const a=admissions.get(refKey(ref(r.admission_ref,p+'.admission_ref')));need(a,'CRITERION_ADMISSION_MISSING',p+'.admission_ref');
    need(same(a.criterion_ref,{id:r.id,revision:r.revision})&&a.goal_id===r.goal_id,'CRITERION_ADMISSION_BINDING',p);
    need(a.criterion_sha256===fingerprint(r),'CRITERION_CHANGED_AFTER_REVIEW',p);
    need(a.basis_sha256===fingerprint(basis),'CRITERION_BASIS_CHANGED_AFTER_REVIEW',p);
    const key=refKey(r);need(!criteria.has(key),'CRITERION_VERSION_DUPLICATE',p);criteria.set(key,r);
    const identity={goal_id:r.goal_id,scope:r.scope};if(series.has(r.id))need(same(series.get(r.id),identity),'CRITERION_IDENTITY_CHANGED',p);else series.set(r.id,identity);
  }
  for(const r of criteria.values())if(r.scope==='local'){
    const parent=criteria.get(refKey(r.parent_ref));need(parent,'CRITERION_PARENT_MISSING',r.id+'.parent_ref');
    need(parent.goal_id===r.goal_id,'CRITERION_PARENT_GOAL',r.id+'.parent_ref');need(parent.scope==='whole_goal','CRITERION_PARENT_SCOPE',r.id+'.parent_ref');
    need(parent.id!==r.id,'CRITERION_PARENT_CYCLE',r.id+'.parent_ref');
  }
  function collectCriterionSources(criterion){
    criterion.basis_refs.forEach((reference,i)=>fact(reference,`selected_criterion.${criterion.id}.basis_refs/${i}`));
    if(criterion.parent_ref)collectCriterionSources(criteria.get(refKey(criterion.parent_ref)));
  }

  fields(candidate,['schema','items'],'candidate');need(candidate.schema==='asuka.outcome-intake/1','OUTCOME_SCHEMA','candidate.schema');
  const items=[],deferred=[],keys=new Set(),assessments=new Set();
  for(const [i,item]of list(candidate.items,'candidate.items').entries()){
    const p=`candidate.items/${i}`;
    fields(item,['key','goal_id','means_id','criterion_ref','actor_id','goal_owner_id','beneficiaries','attempt','result'],p);
    text(item.key,p+'.key');need(!keys.has(item.key),'OUTCOME_KEY_DUPLICATE',p+'.key');keys.add(item.key);
    for(const name of ['goal_id','means_id','goal_owner_id'])text(item[name],p+'.'+name);
    if(item.actor_id!==null)text(item.actor_id,p+'.actor_id');if(item.criterion_ref!==null)ref(item.criterion_ref,p+'.criterion_ref');
    need(object(item.beneficiaries),'OBJECT_REQUIRED',p+'.beneficiaries');
    need(['known','unknown'].includes(item.beneficiaries.status),'BENEFICIARY_STATUS',p+'.beneficiaries');
    fields(item.beneficiaries,item.beneficiaries.status==='known'?['status','actor_ids']:['status'],p+'.beneficiaries');
    const beneficiaries=item.beneficiaries.status==='known'?list(item.beneficiaries.actor_ids,p+'.beneficiaries.actor_ids'):[];
    if(item.beneficiaries.status==='known'){
      need(beneficiaries.length>0,'BENEFICIARY_REQUIRED',p+'.beneficiaries.actor_ids');beneficiaries.forEach((a,j)=>text(a,`${p}.beneficiaries.actor_ids/${j}`));
      need(new Set(beneficiaries).size===beneficiaries.length,'BENEFICIARY_DUPLICATE',p+'.beneficiaries.actor_ids');
    }
    fields(item.attempt,['event_id','fact_ref'],p+'.attempt');text(item.attempt.event_id,p+'.attempt.event_id');
    fields(item.result,['fact_ref','phase','status'],p+'.result');
    need(['interim','final'].includes(item.result.phase),'RESULT_PHASE',p+'.result.phase');
    need(['met','not_met','unknown'].includes(item.result.status),'RESULT_STATUS',p+'.result.status');
    const attempted=fact(item.attempt.fact_ref,p+'.attempt.fact_ref'),result=fact(item.result.fact_ref,p+'.result.fact_ref');
    const g=goal(item.goal_id,p+'.goal_id'),m=entities.get(item.means_id),criterion=item.criterion_ref===null?null:criteria.get(refKey(item.criterion_ref));
    if(g)need(g.owner_id===item.goal_owner_id,'GOAL_OWNER_MISMATCH',p+'.goal_owner_id');
    if(m){need(m.kind==='means','MEANS_KIND_MISMATCH',p+'.means_id');need(m.goal_id===item.goal_id,'MEANS_GOAL_MISMATCH',p+'.means_id');}
    if(criterion)need(criterion.goal_id===item.goal_id,'CRITERION_GOAL_MISMATCH',p+'.criterion_ref');
    if(criterion)collectCriterionSources(criterion);
    const scope={subject:c.subject,goal:item.goal_id,means:item.means_id};hasScope(attempted,scope,p+'.attempt.fact_ref');hasScope(result,scope,p+'.result.fact_ref');
    need(attempted.version.body.occurrence_id===item.attempt.event_id,'ATTEMPT_EVENT_MISMATCH',p+'.attempt');
    const event=events.get(item.attempt.event_id),missing=[];
    if(!g)missing.push('goal_not_registered');if(!m)missing.push('means_not_registered');
    if(!criterion)missing.push('criterion_unknown_or_not_registered');if(item.actor_id===null||!actors.has(item.actor_id))missing.push('actor_unknown_or_not_registered');
    if(beneficiaries.some(a=>!actors.has(a)))missing.push('beneficiary_not_registered');if(!event)missing.push('attempt_event_not_registered');
    if(event){
      need(Array.isArray(event.participants)&&event.participants.every(a=>actors.has(a)),'EVENT_PARTICIPANTS_INVALID',p+'.attempt');
      if(item.actor_id!==null&&actors.has(item.actor_id)&&!event.participants.includes(item.actor_id))missing.push('actor_event_binding_not_established');
      need(['current','historical','mention','prospective'].includes(event.occurrence_kind),'EVENT_KIND',p+'.attempt');
    }
    if(result.version.body.occurrence_id!==item.attempt.event_id)missing.push('separate_result_event_requires_reviewed_binding');
    if(event?.occurrence_kind==='mention')missing.push('mention_is_not_actual_attempt');
    if(missing.length){deferred.push({key:item.key,reasons:missing,original:clone(item),fact_refs:[clone(item.attempt.fact_ref),clone(item.result.fact_ref)]});continue;}

    const reason=[];
    for(const f of [attempted,result]){
      if(event.occurrence_kind==='historical')need(['recollection','quotation'].includes(f.version.body.presentation),'HISTORICAL_PRESENTATION',p);
      if(event.occurrence_kind==='prospective')need(['planned','conditional','unknown'].includes(f.version.body.occurrence_status),'PROSPECTIVE_STATUS',p);
    }
    if(item.actor_id!==c.subject||g.owner_id!==c.subject)reason.push('other_actor_or_owner');
    if(event.occurrence_kind==='historical'||result.version.body.presentation!=='current_report'||result.version.body.observation_id!==c.input_id)reason.push('historical_reference');
    if(event.occurrence_kind==='prospective'||[attempted,result].some(f=>['planned','conditional'].includes(f.version.body.occurrence_status)))reason.push('prospective_content');
    if(item.result.phase==='interim')reason.push('interim');if(item.result.status==='unknown')reason.push('unknown_result');
    if(result.version.body.occurrence_status!=='completed'||!['completed','ongoing'].includes(attempted.version.body.occurrence_status))reason.push('actual_result_not_established');
    if([attempted,result].some(f=>!['observed','self_report','reported'].includes(f.version.body.epistemic_status)))reason.push('actual_evidence_requires_review');
    if([attempted,result].some(f=>f.version.body.novelty==='restatement'))reason.push('restatement');
    if([attempted,result].some(f=>f.version.body.novelty==='correction'))reason.push('correction_requires_separate_review');
    const identity={goal_id:g.id,means_id:m.id,actor_id:item.actor_id,criterion_ref:clone(item.criterion_ref),attempt_event_id:event.id};
    const key=fingerprint(identity);need(!assessments.has(key),'DUPLICATE_ATTEMPT_CRITERION',p);assessments.add(key);
    items.push({...clone(item),projection:reason.length?'record_only_'+reason[0]:'self_outcome_candidate',record_only_reasons:reason,
      criterion:clone(criterion),assessment_identity:identity,assessment_sha256:key,
      goal_lifecycle:'not_inferred_or_changed',semantic_status:'pending_semantic_review'});
  }
  return {schema:'asuka.outcome-projection/1',status:'projection_pending_semantic_review',candidate_sha256:fingerprint(candidate),context_sha256:fingerprint(context),
    items,deferred,source_facts:[...usedFacts.values()].map(value=>clone(value)),effects:[],samples:[],lifecycle_events:[],
    limitations:['Host-supplied criterion admissions are trusted context, not claims accepted from the candidate.',
      'Exact references, hashes and participants do not prove the actor, criterion meaning or result interpretation.',
      'No sample weight, success probability, numerical learning or lifecycle action is produced.']};
}
