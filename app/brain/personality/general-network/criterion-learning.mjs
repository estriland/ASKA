// Opt-in, criterion-isolated learning plans. This module never executes native,
// computes a probability, commits state, or fabricates a result fact/scope.
import {catalog as baseCatalog} from './catalog.mjs';
import {compileAssembly} from './assembly-compiler.mjs';
import {fingerprint} from './assembly-identity.mjs';
import {applyContentChanges} from './content-records.mjs';
import {validateCriterionRegistry} from './criterion-registry.mjs';
import {validateOutcomeIntake} from './outcome-intake.mjs';

const clone=structuredClone,own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const need=(ok,code,path)=>{if(!ok)throw Object.assign(new Error(code),{code,path});};
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const SCOPE=['subject','goal','means','criterion','criterion_revision'];
const PAIR='experience.criterion_means',SUM=PAIR+'.sum',MASS=PAIR+'.mass';
export const CRITERION_LEARNING_POLICY_ID='unit-observed-outcome-v1';
function fields(v,required,p,optional=[]){need(object(v),'OBJECT_REQUIRED',p);need(required.every(k=>own(v,k)),'FIELD_REQUIRED',p);need(Object.keys(v).every(k=>required.includes(k)||optional.includes(k)),'UNEXPECTED_FIELD',p);}
function text(v,p){need(typeof v==='string'&&v.trim()&&!v.includes('\0'),'TEXT_REQUIRED',p);return v;}
function integer(v,p,positive=false){need(Number.isSafeInteger(v)&&v>=(positive?1:0),'REVISION_INVALID',p);return v;}
function hash(v,p){need(typeof v==='string'&&v.length===64&&/^[a-f0-9]+$/.test(v),'HASH_REQUIRED',p);return v;}
function array(v,p){need(Array.isArray(v),'ARRAY_REQUIRED',p);return v;}
function namespace(v,p){fields(v,['character_version','conversation_id','world_id'],p);Object.values(v).forEach(x=>text(x,p));}
function ref(v,p){fields(v,['id','revision'],p);text(v.id,p+'.id');integer(v.revision,p+'.revision',true);return v;}
const refKey=r=>JSON.stringify([r.id,r.revision]);
const source=r=>`content:${r.id}@${r.revision}`;

export function createCriterionLearningCatalog(input=baseCatalog){
  const result=clone(input),base=result.recipes.find(r=>r.id==='goal_experience');need(base,'BASE_EXPERIENCE_RECIPE_REQUIRED','catalog');
  const recipe={...clone(base),id:'criterion_goal_experience',scope:[...SCOPE],purpose:'同一主体、目标、手段和精确标准版本的已审经验频率及原始S/N；不代表整体目标或绝对成功保证。'};
  recipe.steps.push({id:'raw_sum',op:'weighted_sum',type:'probability_sum',inputs:[{input:'sum'}],params:{weights:[1],bias:0}},
    {id:'raw_mass',op:'weighted_sum',type:'probability_mass',inputs:[{input:'mass'}],params:{weights:[1],bias:0}});
  recipe.outputs={...recipe.outputs,sum:'raw_sum',mass:'raw_mass'};
  const previous=result.recipes.find(r=>r.id===recipe.id);
  if(previous)need(same(previous,recipe),'CRITERION_RECIPE_CONFLICT','catalog');else result.recipes.push(recipe);
  return result;
}
export function createCriterionLearningConfig(){
  const state_fields={[SUM]:{type:'probability_sum',scope:[...SCOPE],statistics_pair:PAIR},[MASS]:{type:'probability_mass',scope:[...SCOPE],statistics_pair:PAIR}};
  return {policy:{schema:'asuka.criterion-learning-policy/1',id:CRITERION_LEARNING_POLICY_ID,outcomes:{met:1,not_met:0},weight:1,
    meaning:'显式工程样本策略；不是置信度、人物参数或贝叶斯先验。'},
    definitions:[SUM,MASS].map(id=>({id,scope:[...SCOPE],initial:0,baseline:0,anchor_time:0,half_life:null,bounds:[0,1]})),state_fields};
}
export function emptyCriterionLearningState(ns,subject){namespace(ns,'namespace');text(subject,'subject');return {schema:'asuka.criterion-learning-state/1',namespace:clone(ns),subject,routes:[],reviews:[]};}

function hostContext(raw,receipt=false){
  fields(raw,['namespace','subject','base_revision','contents','identity_registry','criterion_registry','outcome_records','acknowledged_jobs',...(receipt?['review_receipt']:[])],'context',['corrected_first_admissions','corrected_first_deferred']);
  namespace(raw.namespace,'context.namespace');text(raw.subject,'context.subject');integer(raw.base_revision,'context.base_revision');
  const c=clone(raw),records=new Map(),contents=new Map(applyContentChanges(c.contents,[],c.namespace).records.map(r=>[r.id,r]));
  validateCriterionRegistry(c.criterion_registry,{namespace:c.namespace,subject:c.subject,base_revision:c.base_revision,contents:c.contents,identity_registry:c.identity_registry});
  for(const [i,r]of array(c.outcome_records,'context.outcome_records').entries()){
    fields(r,['transaction_id','input_id','status','projection'],`outcome_records/${i}`);text(r.transaction_id,'outcome.transaction_id');text(r.input_id,'outcome.input_id');
    need(!records.has(r.transaction_id),'OUTCOME_RECORD_DUPLICATE','outcome_records');records.set(r.transaction_id,{record:r,index:i});
  }
  const acks=array(c.acknowledged_jobs,'context.acknowledged_jobs');acks.forEach((x,i)=>text(x,'acknowledged_jobs/'+i));need(new Set(acks).size===acks.length,'ACK_DUPLICATE','acknowledged_jobs');
  const admissions=new Map();
  for(const a of array(c.corrected_first_admissions??[],'corrected_first_admissions')){
    fields(a,['schema','assessment_sha256','outcome_transaction_id','result_ref','result_status','source_observation_id','correction_state_sha256',
      'correction_current_sha256','correction_review_receipt_id','correction_review_sha256','correction_base_revision'],'corrected_first_admission');
    need(a.schema==='asuka.corrected-first-learning-admission/1','CORRECTED_FIRST_ADMISSION_SCHEMA','admission');
    for(const k of ['assessment_sha256','correction_state_sha256','correction_current_sha256','correction_review_sha256'])hash(a[k],k);
    for(const k of ['outcome_transaction_id','source_observation_id','correction_review_receipt_id'])text(a[k],k);
    ref(a.result_ref,'admission.result_ref');integer(a.correction_base_revision,'admission.base_revision');
    need(['met','not_met'].includes(a.result_status)&&c.base_revision>a.correction_base_revision,'CORRECTED_FIRST_ADMISSION_BOUNDARY','admission');
    need(!admissions.has(a.assessment_sha256),'CORRECTED_FIRST_ADMISSION_DUPLICATE','admission');admissions.set(a.assessment_sha256,a);
  }
  const deferred=new Set();for(const d of array(c.corrected_first_deferred??[],'corrected_first_deferred')){
    fields(d,['assessment_sha256','reasons'],'corrected_first_deferred');hash(d.assessment_sha256,'deferred.assessment_sha256');
    need(!deferred.has(d.assessment_sha256)&&!admissions.has(d.assessment_sha256),'CORRECTED_FIRST_ELIGIBILITY_DUPLICATE','deferred');
    need(array(d.reasons,'deferred.reasons').length>0,'CORRECTED_FIRST_DEFERRED_REASON_REQUIRED','deferred');d.reasons.forEach(r=>text(r,'deferred.reason'));deferred.add(d.assessment_sha256);
  }
  return {c,records,contents,acks:new Set(acks),admissions};
}
function snapshot(reference,host,p){
  ref(reference,p);const r=host.contents.get(reference.id);need(r?.kind==='fact'&&r.owner_id===host.c.subject,'RESULT_FACT_OWNER_OR_KIND',p);
  const version=r.history.find(v=>v.revision===reference.revision);need(version,'RESULT_FACT_VERSION',p);
  return {id:r.id,kind:'fact',namespace:clone(r.namespace),owner_id:r.owner_id,version:clone(version)};
}
function scopeFor(identity,subject){return {subject,goal:identity.goal_id,means:identity.means_id,criterion:identity.criterion_ref.id,criterion_revision:String(identity.criterion_ref.revision)};}
function identityOf(item){return {goal_id:item.goal_id,means_id:item.means_id,actor_id:item.actor_id,criterion_ref:clone(item.criterion_ref),attempt_event_id:item.attempt.event_id};}
function savedRecord(id,host){
  const found=host.records.get(id);need(found,'SAVED_OUTCOME_REQUIRED','outcome_transaction_id');const p=found.record.projection;
  need(found.record.status==='pending_semantic_review','SAVED_OUTCOME_STATUS','outcome_record.status');
  need(p?.schema==='asuka.outcome-projection/1'&&p.status==='projection_pending_semantic_review','SAVED_PROJECTION_REQUIRED','projection');
  for(const key of ['effects','samples','lifecycle_events'])need(Array.isArray(p[key])&&p[key].length===0,'PROJECTION_ALREADY_HAS_WRITES','projection.'+key);
  for(const f of array(p.source_facts,'projection.source_facts')){
    need(object(f)&&object(f.version),'SAVED_SOURCE_SHAPE','projection.source_facts');
    need(same(f,snapshot({id:f.id,revision:f.version.revision},host,'saved_source')),'SAVED_SOURCE_CHANGED','projection.source_facts');
  }
  const keys=new Set();for(const item of array(p.items,'projection.items')){
    const identity=identityOf(item);ref(identity.criterion_ref,'item.criterion_ref');
    need(same(identity,item.assessment_identity)&&fingerprint(identity)===item.assessment_sha256,'ASSESSMENT_IDENTITY_CHANGED','projection.items');
    need(!keys.has(item.assessment_sha256),'ASSESSMENT_DUPLICATE','projection.items');keys.add(item.assessment_sha256);
    const criterion=host.c.criterion_registry.catalog.find(r=>r.id===identity.criterion_ref.id&&r.revision===identity.criterion_ref.revision);
    need(criterion&&same(criterion,item.criterion)&&criterion.goal_id===item.goal_id,'LEARNING_CRITERION_CHANGED','projection.items');
    for(const r of [item.attempt.fact_ref,item.result.fact_ref]){
      const actual=snapshot(r,host,'item.fact_ref');need(p.source_facts.some(f=>same(f,actual)),'RESULT_NOT_IN_SAVED_PROJECTION','projection.items');
    }
  }
  // Recheck the saved structural projection against immutable exact versions.
  // This is not a second semantic review and does not rewrite the old result.
  const inputKeys=['key','goal_id','means_id','criterion_ref','actor_id','goal_owner_id','beneficiaries','attempt','result'];
  const reprojection=validateOutcomeIntake({schema:'asuka.outcome-intake/1',items:p.items.map(item=>
    Object.fromEntries(inputKeys.map(key=>[key,clone(item[key])])) )},{namespace:host.c.namespace,subject:host.c.subject,
    input_id:found.record.input_id,base_revision:host.c.base_revision,identity_registry:host.c.identity_registry,contents:host.c.contents,
    criterion_catalog:host.c.criterion_registry.catalog,criterion_admissions:host.c.criterion_registry.admissions});
  need(same(reprojection.items,p.items),'SAVED_PROJECTION_CHANGED','projection.items');
  need(reprojection.source_facts.every(f=>p.source_facts.some(saved=>same(saved,f))),'SAVED_CRITERION_SOURCE_MISSING','projection.source_facts');
  return found;
}
function receiptReview(receipt,ns){
  fields(receipt,['input','sequence'],'review_receipt');integer(receipt.sequence,'review_receipt.sequence',true);
  fields(receipt.input,['id','namespace','kind','payload'],'review_receipt.input');text(receipt.input.id,'review_receipt.input.id');
  need(same(receipt.input.namespace,ns),'NAMESPACE_MISMATCH','review_receipt');need(receipt.input.kind==='review_instruction','OUTCOME_REVIEW_RECEIPT_KIND','review_receipt');
  fields(receipt.input.payload,['outcome_review'],'review_receipt.payload');const r=receipt.input.payload.outcome_review;
  fields(r,['schema','decision','policy_id','outcome_transaction_id','projection_sha256','context_sha256','accepted_assessments','reviewer','notes'],'outcome_review');
  need(r.schema==='asuka.criterion-outcome-review/1'&&r.decision==='accepted_for_criterion_learning','OUTCOME_REVIEW_REQUIRED','outcome_review');
  need(r.policy_id===CRITERION_LEARNING_POLICY_ID,'LEARNING_POLICY','outcome_review.policy_id');text(r.outcome_transaction_id,'outcome_review.outcome_transaction_id');
  hash(r.projection_sha256,'outcome_review.projection_sha256');hash(r.context_sha256,'outcome_review.context_sha256');
  need(['assistant','human'].includes(r.reviewer),'OUTCOME_REVIEWER','outcome_review.reviewer');text(r.notes,'outcome_review.notes');
  const accepted=array(r.accepted_assessments,'outcome_review.accepted_assessments');accepted.forEach(x=>hash(x,'accepted_assessment'));need(new Set(accepted).size===accepted.length,'REVIEW_ASSESSMENT_DUPLICATE','accepted_assessments');return r;
}
const jobId=(ns,receipt,assessment,revision)=>'criterion-learning:'+fingerprint({namespace:ns,review_receipt_id:receipt,assessment_sha256:assessment,interpretation_revision:revision});
const meaningId=identity=>'criterion-outcome:'+fingerprint({policy_id:CRITERION_LEARNING_POLICY_ID,assessment:identity});
function validateState(state,host){
  fields(state,['schema','namespace','subject','routes','reviews'],'state');need(state.schema==='asuka.criterion-learning-state/1','LEARNING_STATE_SCHEMA','state');
  need(same(state.namespace,host.c.namespace)&&state.subject===host.c.subject,'NAMESPACE_MISMATCH','state');
  const reviews=new Map();for(const r of array(state.reviews,'state.reviews')){
    fields(r,['receipt','program','context','witness','job_ids'],'state.review');const v=receiptReview(r.receipt,host.c.namespace);
    need(!reviews.has(r.receipt.input.id),'LEARNING_REVIEW_DUPLICATE','state.reviews');reviews.set(r.receipt.input.id,r);
    need(v.context_sha256===fingerprint(r.context)&&r.witness.receipt_sha256===fingerprint(r.receipt)&&r.witness.program_sha256===fingerprint(r.program),'LEARNING_REVIEW_WITNESS','state.reviews');
  }
  const seen=new Set();for(const route of array(state.routes,'state.routes')){
    fields(route,['assessment_sha256','assessment_identity','scope','meaning_id','history','current'],'state.route');
    need(fingerprint(route.assessment_identity)===route.assessment_sha256&&!seen.has(route.assessment_sha256),'LEARNING_ROUTE_IDENTITY','state.routes');seen.add(route.assessment_sha256);
    need(same(route.scope,scopeFor(route.assessment_identity,host.c.subject))&&route.meaning_id===meaningId(route.assessment_identity),'LEARNING_ROUTE_SCOPE','state.route');
    need(Array.isArray(route.history)&&route.history.length>0&&same(route.current,route.history.at(-1)),'LEARNING_ROUTE_HISTORY','state.route');
    for(const [i,h]of route.history.entries()){
      fields(h,['interpretation_revision','outcome_transaction_id','record_index','projection_sha256','result_ref','result_status','observation_id','review_receipt_id','job_id','at'],'route.history');
      need(h.interpretation_revision===i+1&&h.at===null,'LEARNING_ROUTE_REVISION','route.history');
      const stored=savedRecord(h.outcome_transaction_id,host),item=stored.record.projection.items.find(x=>x.assessment_sha256===route.assessment_sha256),review=reviews.get(h.review_receipt_id);
      need(item&&item.actor_id===host.c.subject&&item.goal_owner_id===host.c.subject&&['met','not_met'].includes(item.result.status),'LEARNING_ROUTE_SOURCE','route.history');
      need(same(h.result_ref,item.result.fact_ref)&&h.result_status===item.result.status&&h.projection_sha256===fingerprint(stored.record.projection)&&h.record_index===stored.index,'LEARNING_ROUTE_SOURCE','route.history');
      const f=snapshot(h.result_ref,host,'route.result');need(h.observation_id===f.version.body.observation_id,'LEARNING_ROUTE_OBSERVATION','route.history');
      need(review&&review.receipt.input.payload.outcome_review.accepted_assessments.includes(route.assessment_sha256)&&
        review.receipt.input.payload.outcome_review.outcome_transaction_id===h.outcome_transaction_id&&review.receipt.input.payload.outcome_review.projection_sha256===h.projection_sha256,'LEARNING_ROUTE_REVIEW','route.history');
      need(h.job_id===jobId(host.c.namespace,h.review_receipt_id,route.assessment_sha256,h.interpretation_revision)&&review.job_ids.includes(h.job_id),'LEARNING_ROUTE_JOB','route.history');
    }
  }
  // Rebuild approved scheduling from retained reviews, rather than accepting a
  // well-shaped route as proof that the intake gates actually passed.
  let replay=emptyCriterionLearningState(host.c.namespace,host.c.subject);
  for(const r of state.reviews){
    const {review_receipt:_ignored,corrected_first_admissions:_currentAdmissions,corrected_first_deferred:_currentDeferred,...context}=host.c;
    replay=applyLearning(replay,r.program,{...context,base_revision:r.context.base_revision,
      ...(r.context.corrected_first_admissions?{corrected_first_admissions:clone(r.context.corrected_first_admissions)}:{}),
      ...(r.context.corrected_first_deferred?{corrected_first_deferred:clone(r.context.corrected_first_deferred)}:{}),
      acknowledged_jobs:r.context.acknowledged_jobs,review_receipt:r.receipt},false).state;
  }
  need(same(replay,state),'LEARNING_STATE_REPLAY_MISMATCH','state');
}
function description(state,id,host){
  const {record,index}=savedRecord(id,host),context={schema:'asuka.criterion-learning-review-context/1',namespace:clone(host.c.namespace),subject:host.c.subject,
    base_revision:host.c.base_revision,state_sha256:fingerprint(state),policy:createCriterionLearningConfig().policy,outcome_record:clone(record),record_index:index,
    acknowledged_jobs:[...host.acks].sort(),
    ...(host.admissions.size?{corrected_first_admissions:clone([...host.admissions.values()])}:{}),
    ...(host.c.corrected_first_deferred?.length?{corrected_first_deferred:clone(host.c.corrected_first_deferred)}:{})};
  need([...host.admissions.values()].every(a=>a.outcome_transaction_id===id),'CORRECTED_FIRST_ADMISSION_SOURCE','context');
  return {schema:'asuka.criterion-learning-description/1',outcome_transaction_id:id,projection_sha256:fingerprint(record.projection),context,context_sha256:fingerprint(context),semantic_review:'required_not_performed_here'};
}
export function describeCriterionLearning(state,outcome_transaction_id,context){const host=hostContext(context);validateState(state,host);return description(state,text(outcome_transaction_id,'outcome_transaction_id'),host);}

function applyLearning(state,program,context,verify=true){
  const host=hostContext(context,true);if(verify)validateState(state,host);
  fields(program,['schema','policy_id','base_sha256','outcome_transaction_id','review_receipt_id'],'program');
  need(program.schema==='asuka.criterion-learning-program/1'&&program.policy_id===CRITERION_LEARNING_POLICY_ID,'LEARNING_POLICY','program');
  hash(program.base_sha256,'program.base_sha256');text(program.outcome_transaction_id,'program.outcome_transaction_id');text(program.review_receipt_id,'program.review_receipt_id');
  const receipt=context.review_receipt,review=receiptReview(receipt,host.c.namespace);need(receipt.input.id===program.review_receipt_id,'OUTCOME_REVIEW_RECEIPT_ID','program');
  const previousReview=state.reviews.find(r=>r.receipt.input.id===receipt.input.id);
  if(previousReview){need(same(previousReview.program,program)&&same(previousReview.receipt,receipt),'LEARNING_REVIEW_REUSED','program');return {state:clone(state),work_items:[],deferred:[],changed:false,review_witness:clone(previousReview.witness),persisted:false};}
  need(program.base_sha256===fingerprint(state),'LEARNING_STATE_BASE','program.base_sha256');
  const d=description(state,program.outcome_transaction_id,host);
  need(review.outcome_transaction_id===program.outcome_transaction_id&&review.projection_sha256===d.projection_sha256,'OUTCOME_REVIEW_SOURCE','outcome_review');
  need(review.context_sha256===d.context_sha256,'OUTCOME_REVIEW_CONTEXT','outcome_review.context_sha256');
  const {record,index}=savedRecord(program.outcome_transaction_id,host),next=clone(state),work_items=[],deferred=[];
  need(record.projection.source_facts.every(f=>f.version.body.observation_id!==receipt.input.id&&!f.version.source_refs.includes(receipt.input.id)),
    'REVIEW_IS_RESULT_SOURCE','review_receipt');
  for(const accepted of review.accepted_assessments){
    const item=record.projection.items.find(x=>x.assessment_sha256===accepted);need(item,'REVIEW_ASSESSMENT_MISSING','accepted_assessments');
    const blocked=host.c.corrected_first_deferred?.find(d=>d.assessment_sha256===accepted);
    if(blocked){deferred.push(clone(blocked));continue;}
    const facts={attempt:snapshot(item.attempt.fact_ref,host,'attempt.fact_ref'),result:snapshot(item.result.fact_ref,host,'result.fact_ref')};
    const result=facts.result,body=result.version.body,scope=scopeFor(item.assessment_identity,host.c.subject),reasons=[];
    need(body.observation_id!==receipt.input.id&&!result.version.source_refs.includes(receipt.input.id),'REVIEW_IS_RESULT_SOURCE','review_receipt');
    if(item.actor_id!==host.c.subject||item.goal_owner_id!==host.c.subject)reasons.push('other_actor_or_owner');
    if(item.result.phase!=='final')reasons.push('interim_result');if(!['met','not_met'].includes(item.result.status))reasons.push('unknown_result');
    if(body.occurrence_status!=='completed'||!['completed','ongoing'].includes(facts.attempt.version.body.occurrence_status))reasons.push('actual_outcome_not_established');
    if([result,facts.attempt].some(f=>!['observed','self_report','reported'].includes(f.version.body.epistemic_status)))reasons.push('inferred_or_unknown_evidence');
    if(body.presentation!=='current_report'||body.observation_id!==record.input_id)reasons.push('historical_result');
    if([result,facts.attempt].some(f=>f.version.body.novelty==='restatement'))reasons.push('restatement');
    for(const reason of item.record_only_reasons??[])if(reason!=='correction_requires_separate_review')reasons.push('projection_'+reason);
    if(!body.instance_refs?.some(s=>same(s,scope)))reasons.push('criterion_scope_not_admitted');
    if(reasons.length){deferred.push({assessment_sha256:accepted,reasons:[...new Set(reasons)]});continue;}
    const prior=next.routes.find(r=>r.assessment_sha256===accepted);let interpretation_revision=1,mode='new_occurrence_effect';
    const admission=host.admissions.get(accepted);
    if(admission)need(!prior&&body.novelty==='correction'&&admission.outcome_transaction_id===record.transaction_id&&
      same(admission.result_ref,item.result.fact_ref)&&admission.result_status===item.result.status&&
      admission.source_observation_id===body.observation_id,'CORRECTED_FIRST_ADMISSION_SOURCE','admission');
    if(prior){
      if(same(prior.current.result_ref,item.result.fact_ref)&&prior.current.result_status===item.result.status){deferred.push({assessment_sha256:accepted,reasons:['already_scheduled_same_result']});continue;}
      if(body.novelty!=='correction'){deferred.push({assessment_sha256:accepted,reasons:['existing_assessment_requires_correction']});continue;}
      if(!host.acks.has(prior.current.job_id)){deferred.push({assessment_sha256:accepted,reasons:['prior_sample_not_acknowledged']});continue;}
      if(index<=prior.current.record_index||prior.current.result_ref.id===item.result.fact_ref.id&&item.result.fact_ref.revision<=prior.current.result_ref.revision){deferred.push({assessment_sha256:accepted,reasons:['correction_source_not_later']});continue;}
      interpretation_revision=prior.current.interpretation_revision+1;integer(interpretation_revision,'interpretation_revision',true);mode='replace_interpretation';
    }else if(!admission&&[result,facts.attempt].some(f=>f.version.body.novelty==='correction')){deferred.push({assessment_sha256:accepted,reasons:['correction_has_no_previous_route']});continue;}
    else if(!admission&&body.novelty!=='new_evidence'){deferred.push({assessment_sha256:accepted,reasons:['new_outcome_evidence_required']});continue;}
    const meaning_id=meaningId(item.assessment_identity),job_id=jobId(host.c.namespace,receipt.input.id,accepted,interpretation_revision);
    const source_refs=[...new Set([source(item.result.fact_ref),...result.version.source_refs])];
    const sample={kind:'observed_outcome_record',occurrence_id:item.attempt.event_id,meaning_id,interpretation_revision,observation_id:body.observation_id,mode,at:null,
      outcome:{known:true,value:item.result.status==='met'?1:0,sources:source_refs},weight:{known:true,value:1,sources:source_refs},source_refs};
    const experience={fact_ref:clone(item.result.fact_ref),pair:{id:PAIR,sum:SUM,mass:MASS,scope},sample};
    work_items.push({id:job_id,clock:'after_commit',source_refs:[source(item.result.fact_ref)],payload:{mechanism_changes:[],experiences:[experience],mechanism_claims:[]}});
    const current={interpretation_revision,outcome_transaction_id:record.transaction_id,record_index:index,projection_sha256:d.projection_sha256,result_ref:clone(item.result.fact_ref),
      result_status:item.result.status,observation_id:body.observation_id,review_receipt_id:receipt.input.id,job_id,at:null};
    if(prior){prior.history.push(current);prior.current=clone(current);}else next.routes.push({assessment_sha256:accepted,assessment_identity:clone(item.assessment_identity),scope,meaning_id,history:[clone(current)],current});
  }
  const witness={receipt_id:receipt.input.id,receipt_sha256:fingerprint(receipt),program_sha256:fingerprint(program),context_sha256:d.context_sha256,projection_sha256:d.projection_sha256};
  next.reviews.push({receipt:clone(receipt),program:clone(program),context:clone(d.context),witness,job_ids:work_items.map(w=>w.id)});
  return {state:next,work_items,deferred,changed:true,review_witness:witness,persisted:false,
    interpretation:'Routes record approved scheduling, not proof that after_commit work has executed.'};
}
export function applyCriterionLearning(state,program,context){return applyLearning(state,program,context);}

export function buildCriterionHistoryRead(request,context){
  fields(request,['goal_id','means_id','criterion_ref'],'request');text(request.goal_id,'request.goal_id');text(request.means_id,'request.means_id');ref(request.criterion_ref,'request.criterion_ref');
  const host=hostContext(context),entities=new Map(host.c.identity_registry.entities.map(x=>[x.id,x]));
  need(entities.get(request.goal_id)?.kind==='goal','HISTORY_GOAL_UNKNOWN','request.goal_id');
  need(entities.get(request.means_id)?.kind==='means'&&entities.get(request.means_id).goal_id===request.goal_id,'HISTORY_MEANS_GOAL','request.means_id');
  const criterion=host.c.criterion_registry.catalog.find(c=>same({id:c.id,revision:c.revision},request.criterion_ref));
  need(criterion&&criterion.goal_id===request.goal_id,'HISTORY_CRITERION_GOAL','request.criterion_ref');
  const scope=scopeFor({...request,actor_id:host.c.subject},host.c.subject),config=createCriterionLearningConfig();
  const targets=[SUM,MASS].map(mechanism=>({mechanism,scope:clone(scope)}));
  const graph={namespace:clone(host.c.namespace),state_fields:config.state_fields,instances:[{id:'criterion-history:'+fingerprint(scope),recipe:'criterion_goal_experience',scope,
    inputs:{sum:{type:'probability_sum',state:{...targets[0],view:'latent'},statistics_pair:PAIR},mass:{type:'probability_mass',state:{...targets[1],view:'latent'},statistics_pair:PAIR}},parameters:{}}]};
  const assembly=compileAssembly(graph,createCriterionLearningCatalog());
  return {assembly,instances:targets,criterion_ref:clone(request.criterion_ref),scope,statistic_targets:{sum:targets[0],mass:targets[1]},
    output_meaning:'C++ latent sum/mass and observed frequency for this exact criterion version; zero mass remains Unknown. No probability is computed here.'};
}
