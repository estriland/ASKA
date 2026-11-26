// Pure atomic correction plan. The host supplies authenticated committed
// snapshots; native performs record transitions and paired membership changes.
// No job, fact, acknowledgement, adoption or statistical average is produced.
import {fingerprint} from './assembly-identity.mjs';
import {applyContentChanges} from './content-records.mjs';
import {validateCriterionRegistry} from './criterion-registry.mjs';
import {validateOutcomeIntake} from './outcome-intake.mjs';
import {describeCriterionLearning,CRITERION_LEARNING_POLICY_ID} from './criterion-learning.mjs';

const clone=structuredClone,own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k),object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const same=(a,b)=>fingerprint(a)===fingerprint(b),need=(ok,code,path)=>{if(!ok)throw Object.assign(new Error(code),{code,path});};
const PAIR='experience.criterion_means',PARTS=[PAIR+'.sum',PAIR+'.mass'];
const CONTEXT=['namespace','subject','base_revision','contents','identity_registry','criterion_registry','outcome_records','learning_state','lifecycle_state','records','numeric','acknowledged_jobs','source_receipts','work_items'];
// A process-local optimization of a previously verified pure derivation only.
// Receipt/source retention and current native-state checks remain outside it.
const REPLAY_CACHE_ENTRIES=16,REPLAY_CACHE_BYTES=16*1024*1024,replayCache=new Map();
let replayBytes=0,replayHits=0,replayRecomputations=0,replayEvictions=0,replayOversizeSkips=0;
function freezePrivate(value){
  if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){
    Object.values(value).forEach(freezePrivate);Object.freeze(value);
  }
  return value;
}
function rememberReplay(key,state){
  // Measure the detached value before retaining it; both count and serialized
  // storage are bounded. No caller-owned object enters this private map.
  const bytes=Buffer.byteLength(JSON.stringify(state),'utf8');
  if(bytes>REPLAY_CACHE_BYTES){replayOversizeSkips++;return;}
  while(replayCache.size>=REPLAY_CACHE_ENTRIES||replayBytes+bytes>REPLAY_CACHE_BYTES){
    const oldest=replayCache.keys().next().value,entry=replayCache.get(oldest);
    replayCache.delete(oldest);replayBytes-=entry.bytes;replayEvictions++;
  }
  const privateState=freezePrivate(clone(state));replayCache.set(key,{state:privateState,bytes});replayBytes+=bytes;
}
/** Counters only. Never exposes cached states, source identities or receipts. */
export function outcomeCorrectionReplayCacheDiagnostics(){return Object.freeze({hits:replayHits,recomputations:replayRecomputations,
  entries:replayCache.size,serialized_bytes:replayBytes,max_entries:REPLAY_CACHE_ENTRIES,max_serialized_bytes:REPLAY_CACHE_BYTES,
  evictions:replayEvictions,oversize_skips:replayOversizeSkips});}
/** Cold-start testing/measurement; no persistent state is affected. */
export function clearOutcomeCorrectionReplayCache(){replayCache.clear();replayBytes=0;replayHits=0;replayRecomputations=0;replayEvictions=0;replayOversizeSkips=0;}
function fields(v,keys,p,optional=[]){need(object(v),'OBJECT_REQUIRED',p);need(keys.every(k=>own(v,k)),'FIELD_REQUIRED',p);need(Object.keys(v).every(k=>keys.includes(k)||optional.includes(k)),'UNEXPECTED_FIELD',p);}
function text(v,p){need(typeof v==='string'&&v.trim()&&!v.includes('\0'),'TEXT_REQUIRED',p);return v;}
function integer(v,p,positive=false){need(Number.isSafeInteger(v)&&v>=(positive?1:0),'REVISION_INVALID',p);return v;}
function increment(v,p){integer(v,p,true);need(v<Number.MAX_SAFE_INTEGER,'REVISION_OVERFLOW',p);return v+1;}
function hash(v,p){need(typeof v==='string'&&v.length===64&&/^[a-f0-9]+$/.test(v),'HASH_REQUIRED',p);return v;}
function array(v,p){need(Array.isArray(v),'ARRAY_REQUIRED',p);return v;}
function ns(v,p){fields(v,['character_version','conversation_id','world_id'],p);Object.values(v).forEach(x=>text(x,p));}
function ref(v,p){fields(v,['id','revision'],p);text(v.id,p);integer(v.revision,p,true);return v;}
const tag=r=>`content:${r.id}@${r.revision}`;
function index(rows,key,p){const result=new Map();for(const row of array(rows,p)){text(row[key],p);need(!result.has(row[key]),'DUPLICATE_SOURCE',p);result.set(row[key],row);}return result;}
function signal(v,p){fields(v,['known','value'],p,['sources']);need(v.known===true&&typeof v.value==='number'&&Number.isFinite(v.value),'KNOWN_FINITE_SIGNAL_REQUIRED',p);if(v.sources!==undefined)array(v.sources,p).forEach(x=>text(x,p));}
const sourceSet=a=>[...new Set(a)].sort();
const sameSignal=(a,b)=>same({...a,sources:sourceSet(a.sources??[])},{...b,sources:sourceSet(b.sources??[])});
const membership=r=>r.membership??'active';
export function emptyOutcomeCorrections(namespace,subject){ns(namespace,'namespace');text(subject,'subject');return {schema:'asuka.outcome-corrections/1',namespace:clone(namespace),subject,routes:[],reviews:[]};}
function hostContext(raw,receipt=false){
  fields(raw,[...CONTEXT,...(receipt?['review_receipt']:[])],'context');ns(raw.namespace,'namespace');text(raw.subject,'subject');integer(raw.base_revision,'base_revision');const c=clone(raw);
  const contents=applyContentChanges(c.contents,[],c.namespace).records;
  validateCriterionRegistry(c.criterion_registry,{namespace:c.namespace,subject:c.subject,base_revision:c.base_revision,identity_registry:c.identity_registry,contents});
  need(c.learning_state?.schema==='asuka.criterion-learning-state/1'&&same(c.learning_state.namespace,c.namespace)&&c.learning_state.subject===c.subject,'LEARNING_STATE_REQUIRED','context');
  need(c.lifecycle_state?.schema==='asuka.lifecycle-state/1'&&same(c.lifecycle_state.namespace,c.namespace)&&c.lifecycle_state.subject===c.subject,'LIFECYCLE_STATE_REQUIRED','context');
  need(object(c.numeric)&&same(c.numeric.namespace,c.namespace)&&c.numeric.revision===c.base_revision&&Array.isArray(c.numeric.cells),'NUMERIC_SNAPSHOT_REQUIRED','context.numeric');
  const records=new Map();for(const wrapper of array(c.records,'records')){need(object(wrapper?.record),'RECORD_REQUIRED','records');text(wrapper.record.id,'record.id');
    need(same(wrapper.record.namespace,c.namespace)&&!records.has(wrapper.record.id),'RECORD_IDENTITY','records');integer(wrapper.record.revision,'record.revision');array(wrapper.record.applied_events,'record.history');records.set(wrapper.record.id,wrapper);}
  const receipts=new Map();for(const row of array(c.source_receipts,'source_receipts')){need(object(row?.input)&&same(row.input.namespace,c.namespace),'RECEIPT_NAMESPACE','source_receipts');
    integer(row.sequence,'receipt.sequence',true);text(row.input.id,'receipt.id');need(!receipts.has(row.input.id),'DUPLICATE_RECEIPT','source_receipts');receipts.set(row.input.id,row);}
  const outcomes=index(c.outcome_records,'transaction_id','outcome_records'),work=index(c.work_items,'id','work_items');
  const acks=array(c.acknowledged_jobs,'acknowledged_jobs');acks.forEach(x=>text(x,'acknowledged_jobs'));need(new Set(acks).size===acks.length,'ACK_DUPLICATE','acknowledged_jobs');
  return {c,contents:new Map(contents.map(r=>[r.id,r])),outcomes,outcomeOrder:new Map(c.outcome_records.map((r,i)=>[r.transaction_id,i])),records,receipts,work,acks:new Set(acks)};
}
function fact(reference,h,p){ref(reference,p);const r=h.contents.get(reference.id);need(r?.kind==='fact'&&r.owner_id===h.c.subject,'CORRECTION_FACT_OWNER_OR_KIND',p);
  const version=r.history.find(v=>v.revision===reference.revision);need(version,'CORRECTION_FACT_VERSION',p);return {id:r.id,kind:'fact',namespace:clone(r.namespace),owner_id:r.owner_id,version:clone(version)};
}
function projected(id,assessment,h){
  const record=h.outcomes.get(id);need(record?.status==='pending_semantic_review','COMMITTED_OUTCOME_REQUIRED',id);const p=record.projection;
  need(p?.schema==='asuka.outcome-projection/1'&&p.status==='projection_pending_semantic_review','OUTCOME_PROJECTION_REQUIRED',id);
  const item=p.items.find(i=>i.assessment_sha256===assessment);need(item,'OUTCOME_ASSESSMENT_MISSING',id);
  const keys=['key','goal_id','means_id','criterion_ref','actor_id','goal_owner_id','beneficiaries','attempt','result'];
  const result=validateOutcomeIntake({schema:'asuka.outcome-intake/1',items:[Object.fromEntries(keys.map(k=>[k,clone(item[k])]))]},
    {namespace:h.c.namespace,subject:h.c.subject,input_id:record.input_id,base_revision:h.c.base_revision,identity_registry:h.c.identity_registry,
      contents:[...h.contents.values()],criterion_catalog:h.c.criterion_registry.catalog,criterion_admissions:h.c.criterion_registry.admissions});
  need(same(result.items,[item]),'CORRECTION_PROJECTION_CHANGED',id);
  for(const source of result.source_facts)need(p.source_facts.some(f=>same(f,source)),'CORRECTION_SOURCE_CHANGED',id);
  return {record,item,index:h.outcomeOrder.get(id),result:fact(item.result.fact_ref,h,id+'.result'),attempt:fact(item.attempt.fact_ref,h,id+'.attempt')};
}
function learningContext(h){return {namespace:h.c.namespace,subject:h.c.subject,base_revision:h.c.base_revision,contents:h.c.contents,identity_registry:h.c.identity_registry,
  criterion_registry:h.c.criterion_registry,outcome_records:h.c.outcome_records,acknowledged_jobs:h.c.acknowledged_jobs};}
function pairRows(scope,occurrence,meaning,h){
  return PARTS.map(mechanism=>{
    const found=h.c.numeric.cells.filter(c=>same(c.target,{mechanism,scope}));need(found.length===1,'CORRECTION_SAMPLE_CELL_MISSING','numeric');
    const cell=found[0];need(cell.anchor?.half_life===null&&Array.isArray(cell.ledger),'CORRECTION_STATISTIC_ANCHOR','numeric');
    const rows=cell.ledger.filter(r=>r.occurrence_id===occurrence&&r.meaning_id===meaning);need(rows.length===1,'CORRECTION_SAMPLE_ROW_MISSING','numeric');
    const row=rows[0];integer(row.interpretation_revision,'sample.revision',true);signal(row.delta,'sample.delta');need(row.at===null||typeof row.at==='number'&&Number.isFinite(row.at),'SAMPLE_TIME_INVALID','numeric');
    need(['active','inactive'].includes(membership(row)),'SAMPLE_MEMBERSHIP_INVALID','numeric');return row;
  });
}
function verifySample(rows,expected){
  need(rows[0].interpretation_revision===rows[1].interpretation_revision&&same(rows[0].at,rows[1].at)&&membership(rows[0])===membership(rows[1]),'CORRECTION_PAIR_INCONSISTENT','numeric');
  need(rows.every(r=>r.interpretation_revision===expected.revision&&same(r.at,expected.at)&&membership(r)===expected.state),'CORRECTION_SAMPLE_DRIFT','numeric');
  if(expected.payload)need(rows.every(r=>same(r.membership_revision_payload,expected.payload)),'CORRECTION_MEMBERSHIP_WITNESS','numeric');
  else need(rows.every(r=>!own(r,'membership_revision_payload')),'UNTRACKED_SAMPLE_CORRECTION','numeric');
  need(rows.every((r,i)=>sameSignal(r.delta,expected.deltas[i])),'CORRECTION_SAMPLE_VALUE_DRIFT','numeric');
}
function originSample(assessment,h,{allowPending=false}={}){
  const matches=h.c.learning_state.routes.filter(r=>r.assessment_sha256===assessment);need(matches.length<=1,'LEARNING_ROUTE_DUPLICATE','learning_state');if(!matches.length)return null;
  const route=matches[0];describeCriterionLearning(h.c.learning_state,route.current.outcome_transaction_id,learningContext(h));
  const pending=!h.acks.has(route.current.job_id);
  need(!pending||allowPending,'CORRECTION_LEARNING_NOT_ACKNOWLEDGED','learning_state');
  const job=h.work.get(route.current.job_id);need(job&&job.payload_sha256===fingerprint(job.payload),'CORRECTION_JOB_NOT_SEALED','work_items');
  const experiences=job.payload?.experiences?.filter(e=>e.pair?.id===PAIR&&same(e.pair.scope,route.scope)&&e.sample?.meaning_id===route.meaning_id&&e.sample.occurrence_id===route.assessment_identity.attempt_event_id);
  need(experiences?.length===1,'CORRECTION_JOB_SAMPLE_BINDING','work_items');const x=experiences[0];
  need(x.pair.sum===PARTS[0]&&x.pair.mass===PARTS[1]&&same(x.fact_ref,route.current.result_ref)&&x.sample.interpretation_revision===route.current.interpretation_revision&&
    same(x.sample.at,route.current.at)&&x.sample.observation_id===route.current.observation_id,'CORRECTION_JOB_ROUTE_BINDING','work_items');
  need(job.content_refs?.some(r=>same(r,x.fact_ref))&&job.source_observation_ids?.includes(x.sample.observation_id),'CORRECTION_JOB_FACT_BINDING','work_items');
  const sealedBinding=Object.fromEntries(['id','clock','namespace','origin_transaction_id','source_refs','content_refs','source_observation_ids','payload_sha256'].map(k=>[k,job[k]]));
  need(job.source_binding_sha256===fingerprint(sealedBinding)&&same(job.namespace,h.c.namespace),'CORRECTION_JOB_SOURCE_SEAL','work_items');
  signal(x.sample.outcome,'sample.outcome');signal(x.sample.weight,'sample.weight');
  need(x.sample.weight.value===1&&x.sample.outcome.value===(route.current.result_status==='met'?1:0)&&['met','not_met'].includes(route.current.result_status),'CORRECTION_INITIAL_POLICY','work_items');
  const result=fact(x.fact_ref,h,'learned.result');const expectedSources=sourceSet([tag(x.fact_ref),...result.version.source_refs]);
  need(same(sourceSet(x.sample.source_refs),expectedSources)&&same(sourceSet(x.sample.outcome.sources??[]),expectedSources)&&same(sourceSet(x.sample.weight.sources??[]),expectedSources),'CORRECTION_INITIAL_SOURCES','work_items');
  for(const w of h.work.values())if(w.id!==route.current.job_id&&!h.acks.has(w.id)&&w.payload?.experiences?.some(e=>e.pair?.id===PAIR&&same(e.pair.scope,route.scope)&&e.sample?.meaning_id===route.meaning_id))
    need(false,'CORRECTION_PENDING_LEARNING_WRITE','work_items');
  return {route:clone(route),sample:x,pending,expected:{revision:x.sample.interpretation_revision,state:'active',at:x.sample.at,payload:null,
    deltas:[clone(x.sample.outcome),clone(x.sample.weight)]}};
}
function correctedLearningIdentity(state,route,h){
  need(route&&route.learning_origin===null&&route.current.sample===null&&route.history.every(x=>x.sample===null),'CORRECTED_FIRST_LEARNING_NOT_EMPTY','state.route');
  const current=route.current,resolved=projected(current.outcome_transaction_id,route.assessment_sha256,h),item=resolved.item,body=resolved.result.version.body;
  need(same(route.assessment_identity,item.assessment_identity)&&same(current.result_ref,item.result.fact_ref)&&current.result_status===item.result.status,
    'CORRECTED_FIRST_RESULT_MISMATCH','state.route');
  need(item.actor_id===h.c.subject&&item.goal_owner_id===h.c.subject,'CORRECTED_FIRST_ACTOR_OR_OWNER','outcome');
  need(item.result.phase==='final'&&['met','not_met'].includes(item.result.status),'CORRECTED_FIRST_KNOWN_FINAL_REQUIRED','outcome');
  need(body.occurrence_status==='completed'&&['observed','reported','self_report'].includes(body.epistemic_status)&&
    ['completed','ongoing'].includes(resolved.attempt.version.body.occurrence_status)&&['observed','reported','self_report'].includes(resolved.attempt.version.body.epistemic_status),
    'CORRECTED_FIRST_ACTUAL_RESULT_REQUIRED','outcome');
  need(body.presentation==='current_report'&&body.observation_id===resolved.record.input_id&&body.novelty==='correction'&&resolved.result.version.source_refs.includes(body.observation_id),
    'CORRECTED_FIRST_CURRENT_SOURCE_REQUIRED','outcome');
  const receipt=h.receipts.get(body.observation_id),primary=receipt?.input,role=primary?.payload?.semantic_role??(primary?.kind==='user_input'?'user':null);
  need(primary&&(primary.kind==='user_input'&&role==='user'||primary.kind==='external_observation'&&[null,'user','tool'].includes(role)),
    'CORRECTED_FIRST_INDEPENDENT_SOURCE_REQUIRED','outcome');
  const scope={subject:h.c.subject,goal:item.goal_id,means:item.means_id,criterion:item.criterion_ref.id,criterion_revision:String(item.criterion_ref.revision)};
  need(body.instance_refs?.some(s=>same(s,scope)),'CORRECTED_FIRST_SCOPE_REQUIRED','outcome');
  need((item.record_only_reasons??[]).every(r=>r==='correction_requires_separate_review'),'CORRECTED_FIRST_RESULT_INELIGIBLE','outcome');
  const matches=state.reviews.filter(r=>r.receipt.input.id===current.review_receipt_id);
  need(matches.length===1,'CORRECTED_FIRST_REVIEW_REQUIRED','state.reviews');const review=matches[0];
  need(same(h.receipts.get(review.receipt.input.id),review.receipt),'CORRECTED_FIRST_REVIEW_CHANGED','state.review');
  need(h.c.base_revision>review.context.snapshot.base_revision,'CORRECTED_FIRST_REVIEW_NOT_COMMITTED','state.review');
  const meaning_id='criterion-outcome:'+fingerprint({policy_id:CRITERION_LEARNING_POLICY_ID,assessment:item.assessment_identity});
  return {scope,occurrence_id:item.attempt.event_id,meaning_id,review,
    admission:{schema:'asuka.corrected-first-learning-admission/1',assessment_sha256:route.assessment_sha256,outcome_transaction_id:current.outcome_transaction_id,
      result_ref:clone(current.result_ref),result_status:current.result_status,source_observation_id:body.observation_id,
      correction_state_sha256:fingerprint(state),correction_current_sha256:fingerprint(current),correction_review_receipt_id:review.receipt.input.id,
      correction_review_sha256:fingerprint(review.receipt),correction_base_revision:review.context.snapshot.base_revision}};
}
function noFirstSample(scope,occurrence,meaning,h){
  for(const c of h.c.numeric.cells)if(PARTS.includes(c.target.mechanism)&&same(c.target.scope,scope))
    need(Array.isArray(c.ledger)&&!c.ledger.some(r=>r.occurrence_id===occurrence&&r.meaning_id===meaning),'CORRECTED_FIRST_SAMPLE_ALREADY_PRESENT','numeric');
}
function lateOrigin(state,route,origin,h){
  const identity=correctedLearningIdentity(state,route,h),r=origin.route,sample=origin.sample.sample;
  need(r.history.length===1&&same(r.current,r.history[0])&&r.current.interpretation_revision===1&&sample.interpretation_revision===1&&
    sample.mode==='new_occurrence_effect'&&same(r.assessment_identity,route.assessment_identity)&&same(r.scope,identity.scope)&&r.meaning_id===identity.meaning_id,
    'CORRECTED_FIRST_ORIGIN_NOT_INITIAL','learning_state');
  need(r.current.outcome_transaction_id===route.current.outcome_transaction_id&&same(r.current.result_ref,route.current.result_ref)&&r.current.result_status===route.current.result_status,
    'CORRECTED_FIRST_ORIGIN_RESULT_MISMATCH','learning_state');
  const reviews=h.c.learning_state.reviews.filter(v=>v.receipt.input.id===r.current.review_receipt_id);
  need(reviews.length===1,'CORRECTED_FIRST_LEARNING_REVIEW_REQUIRED','learning_state');const review=reviews[0];
  need(same(h.receipts.get(review.receipt.input.id),review.receipt),'CORRECTED_FIRST_LEARNING_RECEIPT_CHANGED','learning_state');
  need(review.context.base_revision>identity.admission.correction_base_revision&&review.receipt.sequence>identity.review.receipt.sequence,
    'CORRECTED_FIRST_LEARNING_REVIEW_STALE','learning_state');
  const grants=(review.context.corrected_first_admissions??[]).filter(a=>a.assessment_sha256===route.assessment_sha256);
  need(grants.length===1,'CORRECTED_FIRST_ADMISSION_REQUIRED','learning_state');const admission=grants[0];
  fields(admission,Object.keys(identity.admission),'corrected_first_admission');
  hash(admission.correction_state_sha256,'corrected_first_admission.correction_state_sha256');
  // Other assessments may have progressed since this admission. Bind the exact
  // correction and selected current result, never the entire mutable head hash.
  for(const [key,value]of Object.entries(identity.admission))if(key!=='correction_state_sha256')
    need(same(admission[key],value),'CORRECTED_FIRST_ADMISSION_MISMATCH','corrected_first_admission.'+key);
  return {identity,admission:clone(admission)};
}
function latestClosing(wrapper){
  const record=wrapper.record;if(!['goal','commitment'].includes(record.kind))return null;let current=null;
  const close=record.kind==='goal'?'complete':'fulfill',invalidate=record.kind==='goal'?'invalidate_completion':'invalidate_fulfillment';
  for(const row of record.applied_events){const e=row.payload;need(e&&e.event_id===row.event_id&&e.record_id===record.id&&e.owner_id===record.owner_id&&same(e.namespace,record.namespace),'CLOSING_HISTORY_IDENTITY','records');
    if(e.operation===close)current={event:clone(e),judgment_revision:1};
    else if(e.operation===invalidate){need(current&&e.correction?.closing_event_id===current.event.event_id&&e.correction.base_judgment_revision===current.judgment_revision&&
      e.correction.judgment_revision===increment(current.judgment_revision,'judgment'),'CLOSING_CORRECTION_HISTORY','records');current.judgment_revision=e.correction.judgment_revision;}
    else current=null;
  }
  if(!current)return null;need([record.kind==='goal'?'completed':'fulfilled',record.kind==='goal'?'completion_review_required':'fulfillment_review_required'].includes(record.status),'CLOSING_HISTORY_STATUS','records');
  return {...current,record:clone(record)};
}
function closingSource(closing,h){
  const matches=[];
  for(const review of h.c.lifecycle_state.reviews)for(const auth of review.plan.event_authorizations)if(auth.event_id===closing.event.event_id)matches.push({review,auth});
  need(matches.length===1,'CLOSING_REVIEW_REQUIRED','lifecycle_state');const {review,auth}=matches[0];
  need(auth.kind==='outcome'&&auth.record_id===closing.record.id&&auth.outcome_ref,'CLOSING_OUTCOME_AUTHORIZATION','lifecycle_state');
  need(same(h.receipts.get(review.receipt_id),review.receipt)&&review.witness.receipt_sha256===fingerprint(review.receipt)&&review.witness.proposal_sha256===fingerprint(review.proposal)&&
    review.witness.context_sha256===fingerprint(review.context)&&review.witness.plan_sha256===fingerprint(review.plan),'CLOSING_REVIEW_WITNESS','lifecycle_state');
  const r=review.receipt.input.payload.lifecycle_review;
  need(review.receipt.input.kind==='review_instruction'&&r?.decision==='accepted_for_lifecycle'&&r.proposal_sha256===review.witness.proposal_sha256&&r.context_sha256===review.witness.context_sha256,'CLOSING_REVIEW_DECISION','lifecycle_state');
  need(review.plan.record_events.some(e=>same(e.event,closing.event)),'CLOSING_NATIVE_EVENT_CHANGED','records');
  const a=auth.outcome_ref,p=projected(a.transaction_id,a.assessment_sha256,h);
  need(a.projection_sha256===fingerprint(p.record.projection)&&same(a.criterion_ref,p.item.criterion_ref)&&same(a.result_ref,p.item.result.fact_ref)&&p.item.result.status==='met'&&p.item.result.phase==='final','CLOSING_RESULT_BINDING','lifecycle_state');
  need(closing.record.owner_id===h.c.subject&&p.item.actor_id===h.c.subject,'CLOSING_ACTOR_BINDING','records');
  if(closing.record.kind==='goal')need(closing.record.id===p.item.goal_id&&p.item.goal_owner_id===h.c.subject&&p.item.criterion.scope==='whole_goal','CLOSING_GOAL_BINDING','records');
  else{const issued=h.c.lifecycle_state.speech_acts.find(s=>s.kind==='issue'&&s.commitment_id===closing.record.id);need(issued&&issued.goal_id===p.item.goal_id&&same(issued.criterion_ref,p.item.criterion_ref),'CLOSING_COMMITMENT_BINDING','records');}
  return {...closing,authorization:clone(auth),outcome:p};
}
function actualCurrentSample(route,h,state){
  if(!route.current.sample){
    const origin=originSample(route.assessment_sha256,h,{allowPending:true});if(!origin)return;
    const {identity}=lateOrigin(state,route,origin,h);
    if(origin.pending){noFirstSample(identity.scope,identity.occurrence_id,identity.meaning_id,h);return;}
    verifySample(pairRows(identity.scope,identity.occurrence_id,identity.meaning_id,h),origin.expected);return;
  }
  const s=route.current.sample,origin=originSample(route.assessment_sha256,h);need(origin&&same(origin.route,route.learning_origin),'CORRECTION_LEARNING_ROUTE_CHANGED','state');
  const rows=pairRows(s.scope,s.occurrence_id,s.meaning_id,h);verifySample(rows,{revision:s.interpretation_revision,state:s.state,at:s.at,payload:s.payload,deltas:s.deltas});
}
function reviewContext(state,h){
  const ids=new Set();for(const record of h.c.contents)for(const version of record.history){version.source_refs.forEach(id=>ids.add(id));ids.add(version.body?.observation_id);}
  for(const r of h.c.learning_state.reviews)ids.add(r.receipt.input.id);
  for(const r of h.c.lifecycle_state.reviews)ids.add(r.receipt.input.id);
  for(const r of h.c.lifecycle_state.deliveries)ids.add(r.receipt.input.id);
  for(const r of state.reviews)ids.add(r.receipt.input.id);
  const snapshot=Object.fromEntries(CONTEXT.map(k=>[k,clone(h.c[k])]));snapshot.source_receipts=snapshot.source_receipts.filter(row=>ids.has(row.input.id));
  return {schema:'asuka.outcome-correction-context/1',state_sha256:fingerprint(state),snapshot};
}
function describe(state,proposal,h,reviewId=null){
  fields(proposal,['schema','items'],'proposal');need(proposal.schema==='asuka.outcome-correction-proposal/1','CORRECTION_PROPOSAL_SCHEMA','proposal');
  const items=array(proposal.items,'proposal.items');need(items.length>0,'CORRECTION_ITEMS_REQUIRED','proposal');
  const seen=new Set(),record_events=[],event_authorizations=[],sample_revisions=[],instances=[],updates=[],confirmation_required=[],observationIds=new Set();
  for(const [i,x]of items.entries()){
    const path='items/'+i;fields(x,['assessment_sha256','prior_outcome_transaction_id','outcome_transaction_id','reason'],path);hash(x.assessment_sha256,path);text(x.reason,path);text(x.prior_outcome_transaction_id,path);text(x.outcome_transaction_id,path);
    need(!seen.has(x.assessment_sha256),'CORRECTION_ASSESSMENT_DUPLICATE',path);seen.add(x.assessment_sha256);
    const before=projected(x.prior_outcome_transaction_id,x.assessment_sha256,h),after=projected(x.outcome_transaction_id,x.assessment_sha256,h),old=state.routes.find(r=>r.assessment_sha256===x.assessment_sha256);
    need(same(before.item.assessment_identity,after.item.assessment_identity),'CORRECTION_ASSESSMENT_CHANGED',path);
    if(old)need(old.current.outcome_transaction_id===x.prior_outcome_transaction_id&&same(old.current.result_ref,before.item.result.fact_ref),'CORRECTION_PRIOR_NOT_CURRENT',path);
    need(after.index>before.index&&!same(before.item.result.fact_ref,after.item.result.fact_ref)&&
      (before.item.result.fact_ref.id!==after.item.result.fact_ref.id||after.item.result.fact_ref.revision>before.item.result.fact_ref.revision),'CORRECTION_SOURCE_NOT_LATER',path);
    const body=after.result.version.body,primary=h.receipts.get(body.observation_id)?.input,role=primary?.payload?.semantic_role??(primary?.kind==='user_input'?'user':null);
    need(body.observation_id===after.record.input_id&&body.presentation==='current_report'&&body.novelty==='correction'&&after.result.version.source_refs.includes(body.observation_id),'CORRECTION_CURRENT_SOURCE_REQUIRED',path);
    need(primary&&(primary.kind==='user_input'&&role==='user'||primary.kind==='external_observation'&&[null,'user','tool'].includes(role)),'CORRECTION_INDEPENDENT_PRIMARY_REQUIRED',path);
    need(after.item.result.phase==='final','CORRECTION_FINAL_JUDGMENT_REQUIRED',path);
    const verdict=after.item.result.status;
    need(['met','not_met','unknown'].includes(verdict),'CORRECTION_VERDICT',path);
    if(verdict==='unknown')need(['completed','ongoing','unknown'].includes(body.occurrence_status)&&['observed','reported','self_report','unknown'].includes(body.epistemic_status),'CORRECTION_UNCERTAINTY_SOURCE',path);
    else need(body.occurrence_status==='completed'&&['observed','reported','self_report'].includes(body.epistemic_status)&&
      ['completed','ongoing'].includes(after.attempt.version.body.occurrence_status)&&['observed','reported','self_report'].includes(after.attempt.version.body.epistemic_status),'CORRECTION_ACTUAL_RESULT_REQUIRED',path);
    observationIds.add(body.observation_id);
    const scope={subject:h.c.subject,goal:after.item.goal_id,means:after.item.means_id,criterion:after.item.criterion_ref.id,criterion_revision:String(after.item.criterion_ref.revision)};
    const origin=originSample(x.assessment_sha256,h);
    if(old){
      if(old.learning_origin===null&&origin)lateOrigin(state,old,origin,h);
      else need(same(old.learning_origin,origin?.route??null),'CORRECTION_LEARNING_ROUTE_CHANGED',path);
    }
    const closings=[];for(const wrapper of h.records.values()){
      const closing=latestClosing(wrapper);if(!closing)continue;
      const source=closingSource(closing,h);if(source.outcome.item.assessment_sha256===x.assessment_sha256)closings.push(source);
    }
    need(origin||closings.length,'CORRECTION_HAS_NO_EXISTING_EFFECT',path);
    if(!old){const origins=[...(origin?[h.outcomeOrder.get(origin.route.current.outcome_transaction_id)]:[]),...closings.map(c=>c.outcome.index)];
      need(origins.includes(before.index)&&before.index===Math.max(...origins),'CORRECTION_PRIOR_NOT_CURRENT',path);}
    need(closings.every(c=>after.index>c.outcome.index),'CORRECTION_OLDER_THAN_CURRENT_CLOSING',path);
    const sources=sourceSet([tag(after.item.result.fact_ref),...after.result.version.source_refs,...(reviewId?[reviewId]:[])]);
    let sample=null;
    if(origin){
      need(after.result.version.body.instance_refs?.some(s=>same(s,scope))&&same(origin.route.scope,scope),'CORRECTION_SAMPLE_SCOPE_REQUIRED',path);
      const rows=pairRows(scope,origin.route.assessment_identity.attempt_event_id,origin.route.meaning_id,h);
      const expected=old?.current.sample?{revision:old.current.sample.interpretation_revision,state:old.current.sample.state,at:old.current.sample.at,payload:old.current.sample.payload,deltas:old.current.sample.deltas}:origin.expected;
      verifySample(rows,expected);
      const payload={pair_id:PAIR,scope,occurrence_id:rows[0].occurrence_id,meaning_id:rows[0].meaning_id,base_interpretation_revision:rows[0].interpretation_revision,
        interpretation_revision:increment(rows[0].interpretation_revision,'sample.revision'),observation_id:body.observation_id,state:verdict==='unknown'?'inactive':'active',sources,reason:x.reason,
        ...(verdict==='unknown'?{}:{outcome:{known:true,value:verdict==='met'?1:0,sources},weight:{known:true,value:1,sources}})};
      sample_revisions.push(payload);PARTS.forEach(mechanism=>instances.push({mechanism,scope:clone(scope)}));
      sample={scope,occurrence_id:rows[0].occurrence_id,meaning_id:rows[0].meaning_id,at:rows[0].at,interpretation_revision:payload.interpretation_revision,state:payload.state,payload,
        deltas:verdict==='unknown'?rows.map(r=>clone(r.delta)):[clone(payload.outcome),clone(payload.weight)]};
    }
    const events=[];
    for(const closing of closings){
      const record=closing.record;
      if(verdict==='met'){
        if(record.status.endsWith('_review_required'))confirmation_required.push({record_id:record.id,closing_event_id:closing.event.event_id,reason:'sample_or_result_recovery_does_not_reclose_record'});
        continue;
      }
      const operation=record.kind==='goal'?'invalidate_completion':'invalidate_fulfillment';
      const correction={closing_event_id:closing.event.event_id,base_judgment_revision:closing.judgment_revision,judgment_revision:increment(closing.judgment_revision,'judgment'),verdict};
      const event_id='outcome-correction:'+fingerprint({namespace:h.c.namespace,record_id:record.id,closing_event_id:closing.event.event_id,outcome_transaction_id:after.record.transaction_id,judgment_revision:correction.judgment_revision});
      const event={event_id,record_id:record.id,namespace:clone(h.c.namespace),owner_id:record.owner_id,operation,evidence_kind:'reviewed_outcome_correction',sources,correction};
      record_events.push({record_id:record.id,base_revision:record.revision,event});events.push(clone(event));
      event_authorizations.push({kind:'outcome_correction',event_id,record_id:record.id,assessment_sha256:x.assessment_sha256,closing_event_id:closing.event.event_id,
        closing_outcome_ref:clone(closing.authorization.outcome_ref),outcome_transaction_id:after.record.transaction_id,result_ref:clone(after.item.result.fact_ref),criterion_ref:clone(after.item.criterion_ref),
        ...(reviewId?{review_receipt_id:reviewId}:{})});
    }
    updates.push({assessment_sha256:x.assessment_sha256,assessment_identity:clone(after.item.assessment_identity),learning_origin:origin?.route??null,
      current:{prior_outcome_transaction_id:before.record.transaction_id,outcome_transaction_id:after.record.transaction_id,result_ref:clone(after.item.result.fact_ref),result_status:verdict,
        source_observation_id:body.observation_id,sample,record_events:events,reason:x.reason,...(reviewId?{review_receipt_id:reviewId}:{})}});
  }
  need(observationIds.size===1,'CORRECTION_MULTIPLE_OBSERVATIONS','proposal.items');
  const context=reviewContext(state,h);
  return {schema:'asuka.outcome-correction-description/1',proposal:clone(proposal),proposal_sha256:fingerprint(proposal),context,context_sha256:fingerprint(context),
    record_events,event_authorizations,sample_revisions,instances:[...new Map(instances.map(i=>[fingerprint(i),i])).values()],source_observation_id:[...observationIds][0],updates,confirmation_required,
    semantic_review:'required_not_performed_here',execution:'one_native_candidate_and_one_durable_marker_required',work_items:[],acknowledgements:[]};
}
function receiptReview(row,namespace){fields(row,['input','sequence'],'review_receipt');integer(row.sequence,'review_receipt.sequence',true);fields(row.input,['id','namespace','kind','payload'],'review.input');
  text(row.input.id,'review.id');need(row.input.kind==='review_instruction'&&same(row.input.namespace,namespace),'CORRECTION_REVIEW_RECEIPT','review');fields(row.input.payload,['correction_review'],'review.payload');const r=row.input.payload.correction_review;
  fields(r,['schema','decision','proposal_sha256','context_sha256','reviewer','notes'],'correction_review');need(r.schema==='asuka.outcome-correction-review/1'&&r.decision==='accepted_for_outcome_correction','CORRECTION_REVIEW_REQUIRED','review');
  need(['assistant','human'].includes(r.reviewer),'CORRECTION_REVIEWER','review');text(r.notes,'review.notes');hash(r.proposal_sha256,'review.proposal_sha256');hash(r.context_sha256,'review.context_sha256');return r;
}
function programShape(p){fields(p,['schema','base_sha256','review_receipt_id','proposal'],'program');need(p.schema==='asuka.outcome-correction-program/1','CORRECTION_PROGRAM_SCHEMA','program');hash(p.base_sha256,'program.base_sha256');text(p.review_receipt_id,'program.review_receipt_id');}
function applyCore(state,program,h,receipt){
  const r=receiptReview(receipt,h.c.namespace);programShape(program);need(program.review_receipt_id===receipt.input.id,'CORRECTION_REVIEW_ID','program');need(program.base_sha256===fingerprint(state),'CORRECTION_STATE_BASE','program');
  const d=describe(state,program.proposal,h,receipt.input.id);need(r.proposal_sha256===d.proposal_sha256&&r.context_sha256===d.context_sha256,'CORRECTION_REVIEW_HASH','review');
  need(receipt.input.id!==d.source_observation_id&&!d.context.snapshot.source_receipts.some(row=>row.input.id===receipt.input.id),'CORRECTION_REVIEW_IS_SOURCE','review');
  const next=clone(state);for(const update of d.updates){const old=next.routes.find(r=>r.assessment_sha256===update.assessment_sha256);
    if(old){old.history.push(clone(update.current));old.current=clone(update.current);old.learning_origin=clone(update.learning_origin);}else next.routes.push({...clone(update),history:[clone(update.current)]});}
  const plan={record_events:d.record_events,event_authorizations:d.event_authorizations,sample_revisions:d.sample_revisions,instances:d.instances,
    source_observation_id:d.source_observation_id,confirmation_required:d.confirmation_required};
  const witness={receipt_sha256:fingerprint(receipt),program_sha256:fingerprint(program),context_sha256:d.context_sha256,plan_sha256:fingerprint(plan)};
  next.reviews.push({receipt:clone(receipt),program:clone(program),context:clone(d.context),plan:clone(plan),witness});
  return {state:next,...plan,changed:true,persisted:false,review_witness:witness,work_items:[],acknowledgements:[]};
}
function retained(snapshot,h){
  need(same(snapshot.namespace,h.c.namespace)&&snapshot.subject===h.c.subject&&snapshot.base_revision<=h.c.base_revision,'CORRECTION_RETAINED_SCOPE','state');
  for(const r of snapshot.contents)for(const v of r.history){const current=h.contents.get(r.id);need(current&&current.kind===r.kind&&current.owner_id===r.owner_id&&same(current.namespace,r.namespace)&&
    same(current.history.find(x=>x.revision===v.revision),v),'CORRECTION_RETAINED_FACT_CHANGED','state');}
  for(const row of snapshot.outcome_records)need(same(h.outcomes.get(row.transaction_id),row),'CORRECTION_RETAINED_OUTCOME_CHANGED','state');
  for(const row of snapshot.source_receipts)need(same(h.receipts.get(row.input.id),row),'CORRECTION_RETAINED_RECEIPT_CHANGED','state');
  for(const family of ['actors','entities','events'])for(const row of snapshot.identity_registry[family])need(h.c.identity_registry[family].some(current=>same(current,row)),'CORRECTION_RETAINED_IDENTITY_CHANGED','state');
  for(const row of snapshot.criterion_registry.catalog)need(h.c.criterion_registry.catalog.some(current=>same(current,row)),'CORRECTION_RETAINED_CRITERION_CHANGED','state');
  for(const row of snapshot.records){const current=h.records.get(row.record.id);need(current&&same(current.record.namespace,row.record.namespace)&&current.record.kind===row.record.kind&&current.record.owner_id===row.record.owner_id&&
    same(current.record.applied_events.slice(0,row.record.applied_events.length),row.record.applied_events),'CORRECTION_RETAINED_RECORD_CHANGED','state');}
}
function validateState(state,h){
  fields(state,['schema','namespace','subject','routes','reviews'],'state');need(state.schema==='asuka.outcome-corrections/1'&&same(state.namespace,h.c.namespace)&&state.subject===h.c.subject,'CORRECTION_STATE_SCOPE','state');array(state.routes,'routes');array(state.reviews,'reviews');
  let rebuilt=emptyOutcomeCorrections(h.c.namespace,h.c.subject);const ids=new Set();
  for(const row of state.reviews){fields(row,['receipt','program','context','plan','witness'],'state.review');need(!ids.has(row.receipt.input.id),'CORRECTION_REVIEW_REUSED','state');ids.add(row.receipt.input.id);
    need(same(h.receipts.get(row.receipt.input.id),row.receipt),'CORRECTION_STORED_REVIEW_RECEIPT','state');retained(row.context.snapshot,h);
    programShape(row.program);
    const prefix=fingerprint(rebuilt);
    need(row.program.base_sha256===prefix&&row.context.state_sha256===prefix,'CORRECTION_STATE_BASE','state.review');
    const key=JSON.stringify([fingerprint({namespace:h.c.namespace,subject:h.c.subject}),fingerprint(row),prefix]),cached=replayCache.get(key);
    if(cached){
      replayHits++;replayCache.delete(key);replayCache.set(key,cached);
      // This reference stays entirely inside validation. applyCore clones its
      // input before changing it; no public return can expose the frozen value.
      rebuilt=cached.state;
    }else{
      replayRecomputations++;
      const previous=hostContext(row.context.snapshot),result=applyCore(rebuilt,row.program,previous,row.receipt);
      need(same(result.state.reviews.at(-1),row),'CORRECTION_STORED_REVIEW_CHANGED','state');
      rememberReplay(key,result.state);rebuilt=result.state;
    }
  }
  need(same(rebuilt,state),'CORRECTION_STATE_REPLAY_MISMATCH','state');
  for(const route of state.routes){actualCurrentSample(route,h,state);for(const revision of route.history)for(const event of revision.record_events){
    need(h.records.get(event.record_id)?.record.applied_events.some(e=>e.event_id===event.event_id&&same(e.payload,event)),'CORRECTION_NATIVE_EVENT_NOT_APPLIED','state');}}
}
/** Admission descriptor only. It does not authorize a model, schedule a job or
 * create an effect; the existing independent criterion review remains required. */
function correctedFirstAdmission(state,request,h){
  fields(request,['assessment_sha256','outcome_transaction_id'],'request');hash(request.assessment_sha256,'request.assessment_sha256');text(request.outcome_transaction_id,'request.outcome_transaction_id');
  const route=state.routes.find(r=>r.assessment_sha256===request.assessment_sha256);
  need(route&&route.current.outcome_transaction_id===request.outcome_transaction_id,'CORRECTED_FIRST_NOT_CURRENT','request');
  need(!h.c.learning_state.routes.some(r=>r.assessment_sha256===request.assessment_sha256),'CORRECTED_FIRST_LEARNING_ALREADY_EXISTS','learning_state');
  const {admission,scope,occurrence_id,meaning_id}=correctedLearningIdentity(state,route,h);noFirstSample(scope,occurrence_id,meaning_id,h);
  for(const work of h.work.values())need(!work.payload?.experiences?.some(e=>e.pair?.id===PAIR&&same(e.pair.scope,scope)&&e.sample?.occurrence_id===occurrence_id&&e.sample?.meaning_id===meaning_id),
    'CORRECTED_FIRST_JOB_ALREADY_EXISTS','work_items');
  return clone(admission);
}
export function validateCorrectedFirstLearning(state,request,ctx){
  const h=hostContext(ctx);validateState(state,h);return correctedFirstAdmission(state,request,h);
}
const FIRST_LEARNING_INELIGIBLE=new Set(['CORRECTED_FIRST_NOT_CURRENT','CORRECTED_FIRST_KNOWN_FINAL_REQUIRED','CORRECTED_FIRST_ACTOR_OR_OWNER',
  'CORRECTED_FIRST_ACTUAL_RESULT_REQUIRED','CORRECTED_FIRST_CURRENT_SOURCE_REQUIRED','CORRECTED_FIRST_INDEPENDENT_SOURCE_REQUIRED',
  'CORRECTED_FIRST_SCOPE_REQUIRED','CORRECTED_FIRST_RESULT_INELIGIBLE']);
/** Describe each sibling independently. Invalid retained state, provenance,
 * duplicate jobs and native residues remain hard failures, never soft deferrals. */
export function describeCorrectedFirstLearningAdmissions(state,request,ctx){
  const h=hostContext(ctx);validateState(state,h);fields(request,['outcome_transaction_id'],'request');text(request.outcome_transaction_id,'request.outcome_transaction_id');
  const record=h.outcomes.get(request.outcome_transaction_id);
  need(record?.status==='pending_semantic_review'&&record.projection?.schema==='asuka.outcome-projection/1'&&record.projection.status==='projection_pending_semantic_review',
    'COMMITTED_OUTCOME_REQUIRED','request');
  const admissions=[],deferred=[],seen=new Set();
  for(const item of array(record.projection.items,'projection.items')){
    hash(item.assessment_sha256,'assessment_sha256');need(!seen.has(item.assessment_sha256),'DUPLICATE_ASSESSMENT','projection.items');seen.add(item.assessment_sha256);
    projected(request.outcome_transaction_id,item.assessment_sha256,h);
    if(!state.routes.some(r=>r.assessment_sha256===item.assessment_sha256)||h.c.learning_state.routes.some(r=>r.assessment_sha256===item.assessment_sha256))continue;
    try{admissions.push(correctedFirstAdmission(state,{assessment_sha256:item.assessment_sha256,outcome_transaction_id:request.outcome_transaction_id},h));}
    catch(error){if(!FIRST_LEARNING_INELIGIBLE.has(error.code))throw error;deferred.push({assessment_sha256:item.assessment_sha256,reasons:[error.code]});}
  }
  return {admissions,deferred};
}
/** Checks a committed pending first-sample job against its original admission.
 * No pre-learning state is fabricated and no acknowledgement is produced. */
export function validateCorrectedFirstLearningDispatch(state,request,ctx){
  const h=hostContext(ctx);validateState(state,h);fields(request,['assessment_sha256','job_id'],'request');hash(request.assessment_sha256,'request.assessment_sha256');text(request.job_id,'request.job_id');
  const route=state.routes.find(r=>r.assessment_sha256===request.assessment_sha256);need(route,'CORRECTED_FIRST_NOT_CURRENT','request');
  const origin=originSample(request.assessment_sha256,h,{allowPending:true});
  need(origin&&origin.pending&&origin.route.current.job_id===request.job_id,'CORRECTED_FIRST_DISPATCH_NOT_PENDING','request');
  const {identity,admission}=lateOrigin(state,route,origin,h);noFirstSample(identity.scope,identity.occurrence_id,identity.meaning_id,h);
  return {admission,job_id:request.job_id};
}
export function describeOutcomeCorrections(state,proposal,ctx){const h=hostContext(ctx);validateState(state,h);return describe(state,proposal,h);}
export function applyOutcomeCorrections(state,program,ctx){
  const h=hostContext(ctx,true);validateState(state,h);programShape(program);receiptReview(ctx.review_receipt,h.c.namespace);need(program.review_receipt_id===ctx.review_receipt.input.id,'CORRECTION_REVIEW_ID','program');
  const previous=state.reviews.find(r=>r.receipt.input.id===program.review_receipt_id);
  if(previous){need(same(previous.program,program)&&same(previous.receipt,ctx.review_receipt),'CORRECTION_REVIEW_REUSED','program');return {state:clone(state),record_events:[],event_authorizations:[],sample_revisions:[],instances:[],
    source_observation_id:previous.plan.source_observation_id,confirmation_required:clone(previous.plan.confirmation_required),changed:false,persisted:false,work_items:[],acknowledgements:[]};}
  return applyCore(state,program,h,ctx.review_receipt);
}
