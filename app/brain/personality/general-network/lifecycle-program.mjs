// Pure admission/planning boundary. Native records remain the sole lifecycle
// state machine. The durable host authenticates receipts and commits the plan;
// a reviewer label, hash, quote or structural pass is not semantic proof.
import {fingerprint} from './assembly-identity.mjs';
import {applyContentChanges,createLifecycleRecord} from './content-records.mjs';
import {validateCriterionRegistry} from './criterion-registry.mjs';
import {validateOutcomeIntake} from './outcome-intake.mjs';
import {describeRegulations} from './regulation-plan.mjs';
import {compileRegulationMonitor} from './regulation-monitor.mjs';

const clone=structuredClone,own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o),same=(a,b)=>fingerprint(a)===fingerprint(b);
const need=(ok,code,path)=>{if(!ok)throw Object.assign(new Error(code),{code,path});};
function fields(o,keys,p,optional=[]){need(object(o),'OBJECT_REQUIRED',p);need(keys.every(k=>own(o,k)),'FIELD_REQUIRED',p);need(Object.keys(o).every(k=>keys.includes(k)||optional.includes(k)),'UNEXPECTED_FIELD',p);}
function text(v,p){need(typeof v==='string'&&v.trim()&&!v.includes('\0'),'TEXT_REQUIRED',p);return v;}
function integer(v,p,positive=false){need(Number.isSafeInteger(v)&&v>=(positive?1:0),'REVISION_INVALID',p);return v;}
function hash(v,p){need(typeof v==='string'&&v.length===64&&/^[a-f0-9]+$/.test(v),'HASH_REQUIRED',p);return v;}
function array(v,p){need(Array.isArray(v),'ARRAY_REQUIRED',p);return v;}
function ns(v,p){fields(v,['character_version','conversation_id','world_id'],p);Object.values(v).forEach(x=>text(x,p));}
function ref(v,p){fields(v,['id','revision'],p);text(v.id,p);integer(v.revision,p,true);return v;}
function refs(v,p){array(v,p);need(v.length>0,'REFERENCES_REQUIRED',p);v.forEach(x=>ref(x,p));need(new Set(v.map(fingerprint)).size===v.length,'REFERENCE_DUPLICATE',p);return v;}
const tag=r=>`content:${r.id}@${r.revision}`;
const factsSources=facts=>[...new Set(facts.flatMap(f=>[tag({id:f.id,revision:f.version.revision}),...f.version.source_refs]))];
function index(rows,p,key='id'){const m=new Map();for(const x of array(rows,p)){text(x[key],p);need(!m.has(x[key]),'IDENTITY_DUPLICATE',p);m.set(x[key],x);}return m;}
function range(span,body,p){
  fields(span,['start','end'],p);integer(span.start,p);integer(span.end,p);need(span.end>span.start&&span.end<=body.length,'SPAN_RANGE',p);
  for(const n of [span.start,span.end])if(n>0&&n<body.length){const a=body.charCodeAt(n-1),b=body.charCodeAt(n);need(!(a>=0xD800&&a<=0xDBFF&&b>=0xDC00&&b<=0xDFFF),'SPAN_SURROGATE_BOUNDARY',p);}
}
export function emptyLifecycleState(namespace,subject){ns(namespace,'namespace');text(subject,'subject');return {schema:'asuka.lifecycle-state/1',namespace:clone(namespace),subject,speech_acts:[],reviews:[],deliveries:[]};}
function context(value,receipt){
  fields(value,['namespace','subject','base_revision','contents','identity_registry','records','replies','criterion_registry','outcome_records','source_receipts',...(receipt?[receipt]:[])],'context',['internal_goals','regulation_sources']);
  ns(value.namespace,'context.namespace');text(value.subject,'context.subject');integer(value.base_revision,'context.base_revision');const c=clone(value);
  const r=c.identity_registry;need(r?.schema==='asuka.semantic-identities/1'&&same(r.namespace,c.namespace)&&r.subject===c.subject,'IDENTITY_REGISTRY_REQUIRED','context');
  const actors=index(r.actors,'actors'),entities=index(r.entities,'entities'),events=index(r.events,'events');need(actors.has(c.subject),'SUBJECT_ACTOR_MISSING','context');
  const contents=applyContentChanges(c.contents,[],c.namespace).records,records=new Map();
  for(const wrapper of array(c.records,'records')){
    fields(wrapper,['record','source_refs','content_refs'],'record');const row=wrapper.record;
    fields(row,['kind','id','namespace','owner_id','status','revision','applied_events'],'record.record');text(row.id,'record.id');text(row.owner_id,'record.owner_id');
    need(same(row.namespace,c.namespace),'NAMESPACE_MISMATCH','record');integer(row.revision,'record.revision');array(row.applied_events,'record.applied_events');
    need(!records.has(row.id),'RECORD_DUPLICATE','records');records.set(row.id,wrapper);
  }
  const replies=index(c.replies,'replies'),outcomes=index(c.outcome_records,'outcome_records','transaction_id'),receipts=new Map();
  for(const row of array(c.source_receipts,'source_receipts')){
    fields(row,['input','sequence'],'source_receipt');integer(row.sequence,'source_receipt.sequence',true);need(object(row.input)&&same(row.input.namespace,c.namespace),'NAMESPACE_MISMATCH','source_receipt');
    text(row.input.id,'source_receipt.id');need(!receipts.has(row.input.id),'SOURCE_RECEIPT_DUPLICATE','source_receipts');receipts.set(row.input.id,row);
  }
  for(const row of replies.values())text(row.text,'reply.text');
  validateCriterionRegistry(c.criterion_registry,{namespace:c.namespace,subject:c.subject,base_revision:c.base_revision,identity_registry:r,contents});
  const internalGoals=new Map();
  if(c.internal_goals!==undefined){
    need(c.internal_goals?.schema==='asuka.internal-goals-state/1'&&same(c.internal_goals.namespace,c.namespace)&&c.internal_goals.subject===c.subject,'INTERNAL_GOALS_STATE_REQUIRED','context');
    for(const g of array(c.internal_goals.goals,'internal_goals.goals')){need(!internalGoals.has(g.id),'INTERNAL_GOAL_DUPLICATE','context');internalGoals.set(g.id,g);}
  }
  return {c,actors,entities,events,records,replies,outcomes,receipts,internalGoals,contents:new Map(contents.map(f=>[f.id,f]))};
}
function fact(reference,h,p){ref(reference,p);const f=h.contents.get(reference.id);need(f?.kind==='fact'&&f.owner_id===h.c.subject,'LIFECYCLE_FACT_OWNER_OR_KIND',p);
  const version=f.history.find(v=>v.revision===reference.revision);need(version,'LIFECYCLE_FACT_VERSION',p);
  return {id:f.id,kind:f.kind,namespace:clone(f.namespace),owner_id:f.owner_id,version:clone(version)};
}
function goal(id,h,p){text(id,p);const g=h.entities.get(id);need(g?.kind==='goal','LIFECYCLE_GOAL_REQUIRED',p);return g;}
function criterion(reference,goalId,h,p){ref(reference,p);const c=h.c.criterion_registry.catalog.find(v=>v.id===reference.id&&v.revision===reference.revision);
  need(c&&c.goal_id===goalId,'LIFECYCLE_CRITERION_BINDING',p);return c;
}
function reply(id,span,quote,h,p){const r=h.replies.get(text(id,p));need(r,'COMMITTED_REPLY_REQUIRED',p);range(span,r.text,p+'.span');text(quote,p+'.quote');need(r.text.slice(span.start,span.end)===quote,'REPLY_SPAN_MISMATCH',p);return r;}
function stateShape(state,h){
  fields(state,['schema','namespace','subject','speech_acts','reviews','deliveries'],'state');need(state.schema==='asuka.lifecycle-state/1','LIFECYCLE_STATE_SCHEMA','state');
  need(same(state.namespace,h.c.namespace)&&state.subject===h.c.subject,'NAMESPACE_MISMATCH','state');
  const acts=index(state.speech_acts,'speech_acts'),reviews=index(state.reviews,'reviews','receipt_id'),deliveries=index(state.deliveries,'deliveries','receipt_id');
  for(const review of reviews.values()){
    fields(review,['receipt_id','receipt','proposal','context','plan','witness'],'state.review');
    need(review.receipt_id===review.receipt.input.id&&fingerprint(review.receipt)===review.witness.receipt_sha256&&fingerprint(review.proposal)===review.witness.proposal_sha256&&
      fingerprint(review.context)===review.witness.context_sha256&&fingerprint(review.plan)===review.witness.plan_sha256,'LIFECYCLE_REVIEW_WITNESS','state.review');
    const approved=reviewReceipt(review.receipt,h.c.namespace);need(approved.proposal_sha256===review.witness.proposal_sha256&&approved.context_sha256===review.witness.context_sha256,'LIFECYCLE_REVIEW_WITNESS','state.review');
    for(const snapshot of review.context.source_facts)need(same(snapshot,fact({id:snapshot.id,revision:snapshot.version.revision},h,'stored.fact')),'LIFECYCLE_STORED_FACT_CHANGED','state.review');
    for(const row of review.context.source_receipts)need(same(row,h.receipts.get(row.input.id)),'LIFECYCLE_STORED_RECEIPT_CHANGED','state.review');
    for(const old of review.context.replies)need(same(old,h.replies.get(old.id)),'LIFECYCLE_STORED_REPLY_CHANGED','state.review');
    for(const old of review.context.goals)need(same(old,h.entities.get(old.id)),'LIFECYCLE_STORED_GOAL_CHANGED','state.review');
    for(const old of review.context.criteria)need(same(old,criterion({id:old.id,revision:old.revision},old.goal_id,h,'stored.criterion')),'LIFECYCLE_STORED_CRITERION_CHANGED','state.review');
    for(const old of review.context.internal_goals??[])need(same(old,h.internalGoals.get(old.id)),'LIFECYCLE_STORED_INTERNAL_GOAL_CHANGED','state.review');
    for(const old of review.context.regulation_sources??[])need(h.c.regulation_sources?.some(s=>s.transaction_id===old.transaction_id&&same(old,s)),
      'REGULATION_STORED_NATIVE_SOURCE_CHANGED','state.review');
  }
  for(const act of acts.values()){
    need(reviews.has(act.review_receipt_id)&&reviews.get(act.review_receipt_id).plan.speech_acts.some(a=>same(a,act)),'SPEECH_ACT_REVIEW_REQUIRED','speech_act');
    const r=reply(act.reply_id,act.span,act.quote,h,'speech_act');need(fingerprint(r)===act.reply_sha256,'SPEECH_ACT_REPLY_CHANGED','speech_act');
  }
  const applied=new Set();for(const row of deliveries.values()){
    fields(row,['receipt_id','receipt','receipt_sha256','applications','native_applications'],'state.delivery');need(row.receipt.input.id===row.receipt_id&&fingerprint(row.receipt)===row.receipt_sha256,'DELIVERY_WITNESS','state.delivery');
    deliveryReceipt(row.receipt,h);for(const a of array(row.applications,'delivery.applications')){
      need(acts.has(a.speech_act_id)&&!applied.has(a.speech_act_id),'SPEECH_ACT_APPLICATION_DUPLICATE','delivery.applications');applied.add(a.speech_act_id);
      need(a.event_id===eventId(h.c.namespace,{speech_act_id:a.speech_act_id}),'DELIVERY_EVENT_ID','delivery.applications');
    }
    for(const a of array(row.native_applications,'delivery.native_applications')){
      fields(a,['record_id','event_id','operation'],'delivery.native_application');
      need(row.receipt.input.binding.delivery_id&&a.record_id===deliveryRecordId(h.c.namespace,row.receipt.input.binding)&&
        a.event_id===eventId(h.c.namespace,{delivery_record_id:a.record_id,operation:a.operation}),'DELIVERY_EVENT_ID','delivery.native_applications');
    }
  }
  return {acts,reviews,deliveries,applied};
}
const eventId=(namespace,meaning)=>'lifecycle-event:'+fingerprint({namespace,meaning});
const actId=(namespace,reply_id,key)=>'speech-act:'+fingerprint({namespace,reply_id,key});
const commitmentId=(namespace,reply_id,key)=>'commitment:'+fingerprint({namespace,reply_id,key});
const deliveryRecordId=(namespace,binding)=>'delivery:'+fingerprint({namespace,channel:binding.channel,delivery_id:binding.delivery_id});
const speechMeaning=act=>({kind:act.kind,reply_id:act.reply_id,span:act.span,quote:act.quote,recipient_ids:[...act.recipient_ids].sort(),
  goal_id:act.goal_id,criterion_ref:act.criterion_ref,...(act.kind==='retract'?{commitment_id:act.commitment_id}:{})});
function outcome(recordId,operation,source,h,state){
  const record=h.outcomes.get(source.outcome_transaction_id);need(record?.status==='pending_semantic_review','COMMITTED_OUTCOME_REQUIRED','outcomes');
  const p=record.projection;need(p?.schema==='asuka.outcome-projection/1'&&p.status==='projection_pending_semantic_review','COMMITTED_OUTCOME_REQUIRED','outcomes');
  const item=p.items.find(i=>i.assessment_sha256===source.assessment_sha256);need(item,'OUTCOME_ASSESSMENT_REQUIRED','outcomes');
  const inputKeys=['key','goal_id','means_id','criterion_ref','actor_id','goal_owner_id','beneficiaries','attempt','result'];
  const reprojection=validateOutcomeIntake({schema:'asuka.outcome-intake/1',items:[Object.fromEntries(inputKeys.map(k=>[k,clone(item[k])]))]},
    {namespace:h.c.namespace,subject:h.c.subject,input_id:record.input_id,base_revision:h.c.base_revision,identity_registry:h.c.identity_registry,contents:[...h.contents.values()],
      criterion_catalog:h.c.criterion_registry.catalog,criterion_admissions:h.c.criterion_registry.admissions});
  need(same(reprojection.items,[item]),'LIFECYCLE_OUTCOME_CHANGED','outcomes');
  for(const f of reprojection.source_facts)need(p.source_facts.some(old=>same(old,f)),'LIFECYCLE_OUTCOME_SOURCE_CHANGED','outcomes');
  const expected=operation==='complete'?recordId:state.speech_acts.find(a=>a.kind==='issue'&&a.commitment_id===recordId)?.goal_id;
  need(expected&&item.goal_id===expected,'LIFECYCLE_OUTCOME_GOAL','outcomes');
  if(operation==='fulfill'){
    const issue=state.speech_acts.find(a=>a.kind==='issue'&&a.commitment_id===recordId);
    need(issue?.criterion_ref&&same(issue.criterion_ref,item.criterion_ref),'COMMITMENT_CRITERION_REQUIRED','outcomes');
  }
  const reasons=[];
  if(operation==='complete'&&item.criterion.scope!=='whole_goal')reasons.push('local_result_does_not_complete_goal');
  if(item.actor_id!==h.c.subject||(operation==='complete'&&item.goal_owner_id!==h.c.subject))reasons.push('other_actor_or_owner');
  if(item.result.status!=='met'||item.result.phase!=='final')reasons.push('successful_final_result_not_established');
  for(const r of item.record_only_reasons)if(r!=='correction_requires_separate_review'&&!(operation==='fulfill'&&r==='other_actor_or_owner'&&item.actor_id===h.c.subject))reasons.push(r);
  const result=fact(item.result.fact_ref,h,'outcomes.result');
  // Background sources (for example the user's original request) do not turn
  // the character's later assertion into an independent outcome observation.
  const observationId=result.version.body.observation_id,observation=h.receipts.get(observationId)?.input;
  const role=observation?.payload?.semantic_role??(observation?.kind==='user_input'?'user':null);
  const independent=result.version.source_refs.includes(observationId)&&Boolean(observation)&&
    (observation.kind==='user_input'&&role==='user'||observation.kind==='external_observation'&&[null,'user','tool'].includes(role));
  if(!independent)reasons.push('independent_outcome_source_not_established');
  return {record,item,result,reasons,source_facts:reprojection.source_facts};
}
function describe(state,proposal,h){
  fields(proposal,['schema','goal_choices','speech_acts','outcomes'],'proposal',['regulations']);need(proposal.schema==='asuka.lifecycle-proposal/1','LIFECYCLE_PROPOSAL_SCHEMA','proposal');
  for(const key of ['goal_choices','speech_acts','outcomes'])array(proposal[key],'proposal.'+key);
  need(proposal.goal_choices.length+proposal.speech_acts.length+proposal.outcomes.length>0||
    Object.values(proposal.regulations??{}).some(rows=>Array.isArray(rows)&&rows.length>0),'LIFECYCLE_ACTION_REQUIRED','proposal');
  const sourceFacts=new Map(),usedReplies=new Map(),usedGoals=new Map(),usedCriteria=new Map(),usedRecords=new Map(),usedOutcomes=new Map(),usedInternal=new Map(),seen=new Set();
  const actions=[],acts=[],deferred=[];const usedFact=(r,p)=>{const f=fact(r,h,p);sourceFacts.set(fingerprint(r),f);return f;};
  const useCriterion=c=>{
    const key=fingerprint({id:c.id,revision:c.revision});if(usedCriteria.has(key))return;usedCriteria.set(key,clone(c));
    c.basis_refs.forEach(r=>usedFact(r,'criterion.basis'));
    if(c.parent_ref)useCriterion(criterion(c.parent_ref,c.goal_id,h,'criterion.parent'));
  };
  const addRecord=id=>{const r=h.records.get(id);if(r)usedRecords.set(id,clone(r));return r;};
  const unique=id=>{need(!seen.has(id),'LIFECYCLE_ACTION_DUPLICATE','proposal');seen.add(id);};
  for(const [i,c]of proposal.goal_choices.entries()){
    const p='goal_choices/'+i;fields(c,['goal_id','operation','basis_refs'],p,['internal_goal_ref']);need(['adopt','pause','resume','abandon'].includes(c.operation),'GOAL_CHOICE_OPERATION',p);
    const g=goal(c.goal_id,h,p);usedGoals.set(g.id,clone(g));unique('record:'+g.id);
    let internal;
    if(c.internal_goal_ref!==undefined){
      fields(c.internal_goal_ref,['id','sha256'],p+'.internal_goal_ref');hash(c.internal_goal_ref.sha256,p);
      internal=h.internalGoals.get(c.internal_goal_ref.id);
      need(internal&&internal.id===g.id&&fingerprint(internal)===c.internal_goal_ref.sha256&&g.origin?.kind==='internal_goal_proposal',
        'LIFECYCLE_INTERNAL_GOAL_REFERENCE',p);
      need(internal.review_receipt_id===g.origin.review_receipt_id&&internal.proposal_sha256===g.origin.proposal_sha256,'LIFECYCLE_INTERNAL_GOAL_ORIGIN',p);
      usedInternal.set(internal.id,clone(internal));
    }
    const fs=internal&&Array.isArray(c.basis_refs)&&c.basis_refs.length===0?[]:refs(c.basis_refs,p+'.basis_refs').map(r=>usedFact(r,p));
    const reasons=[];if(g.owner_id!==h.c.subject)reasons.push('not_own_goal');
    // These exact facts are reasons for a newly reviewed internal choice, not
    // observations claiming that a choice already occurred. Historical or
    // uncertain reasons retain their epistemic/time fields unchanged.
    for(const f of fs)need(f.version.body.instance_refs?.some(s=>same(s,{subject:h.c.subject,goal:g.id})),'GOAL_CHOICE_SCOPE',p);
    const wrapper=addRecord(g.id);if(wrapper)need(wrapper.record.kind==='goal'&&wrapper.record.owner_id===h.c.subject,'GOAL_RECORD_IDENTITY',p);
    if(!wrapper&&!['adopt','abandon'].includes(c.operation))reasons.push('goal_record_not_established');
    if(reasons.length){deferred.push({kind:'goal_choice',goal_id:g.id,reasons:[...new Set(reasons)]});continue;}
    const meaning={kind:'goal_choice',decision_base_revision:h.c.base_revision,goal_id:g.id,operation:c.operation,basis_refs:clone(c.basis_refs).sort((a,b)=>fingerprint(a).localeCompare(fingerprint(b))),
      ...(internal?{internal_goal_ref:clone(c.internal_goal_ref)}:{})};
    actions.push({kind:'goal_choice',record_id:g.id,record_kind:'goal',operation:c.operation,evidence_kind:c.operation==='adopt'?'accepted_goal':'explicit_goal_change',
      base_revision:wrapper?.record.revision??0,create:!wrapper,content_refs:clone(c.basis_refs),source_refs:[...factsSources(fs),...(internal?[`goal-proposal:${internal.id}`]:[])],
      ...(internal?{internal_goal_ref:clone(c.internal_goal_ref)}:{}),event_id:eventId(h.c.namespace,meaning)});
  }
  for(const [i,s]of proposal.speech_acts.entries()){
    const p='speech_acts/'+i;need(['issue','retract'].includes(s?.kind),'SPEECH_ACT_KIND',p);
    fields(s,s.kind==='issue'?['key','kind','reply_id','span','quote','content_refs','recipient_ids','goal_id','criterion_ref']:
      ['key','kind','commitment_id','reply_id','span','quote','content_refs'],p);
    text(s.key,p);const r=reply(s.reply_id,s.span,s.quote,h,p);usedReplies.set(r.id,clone(r));
    const fs=refs(s.content_refs,p+'.content_refs').map(reference=>usedFact(reference,p)),id=actId(h.c.namespace,r.id,s.key);unique('act:'+id);
    let target,recipients,goal_id,criterion_ref;
    if(s.kind==='issue'){
      recipients=array(s.recipient_ids,p+'.recipient_ids');need(recipients.length>0&&new Set(recipients).size===recipients.length,'RECIPIENTS_REQUIRED',p);
      recipients.forEach(a=>need(h.actors.has(a),'RECIPIENT_NOT_REGISTERED',p));
      target=commitmentId(h.c.namespace,r.id,s.key);goal_id=s.goal_id;criterion_ref=s.criterion_ref;
      if(goal_id!==null){const g=goal(goal_id,h,p);usedGoals.set(g.id,clone(g));}
      if(criterion_ref!==null){need(goal_id!==null,'COMMITMENT_CRITERION_GOAL_REQUIRED',p);useCriterion(criterion(criterion_ref,goal_id,h,p));}
    }else{
      target=text(s.commitment_id,p);const original=state.speech_acts.find(a=>a.kind==='issue'&&a.commitment_id===target);need(original,'COMMITMENT_PROPOSAL_REQUIRED',p);
      const record=addRecord(target);need(record?.record.kind==='commitment'&&record.record.owner_id===h.c.subject,'COMMITMENT_RECORD_REQUIRED',p);
      recipients=original.recipient_ids;goal_id=original.goal_id;criterion_ref=original.criterion_ref;
      // Multiple wordings of one withdrawal in the same reply are one semantic
      // action. Require the reviewer to choose its complete span, rather than
      // generating two native transitions against the same base revision.
      need(![...state.speech_acts,...acts].some(a=>a.kind==='retract'&&a.reply_id===r.id&&a.commitment_id===target&&a.id!==id),
        'SPEECH_ACT_TARGET_DUPLICATE',p);
    }
    const act={id,kind:s.kind,commitment_id:target,reply_id:r.id,reply_sha256:fingerprint(r),span:clone(s.span),quote:s.quote,recipient_ids:clone(recipients),
      goal_id,criterion_ref:clone(criterion_ref),content_refs:clone(s.content_refs),source_refs:[...new Set([`reply:${r.id}`,...factsSources(fs)])]};
    need(![...state.speech_acts,...acts].some(old=>old.id!==id&&same(speechMeaning(old),speechMeaning(act))),
      'SPEECH_ACT_DUPLICATE_ALIAS',p);
    const old=state.speech_acts.find(a=>a.id===id);if(old){const {review_receipt_id,...before}=old;need(same(before,act),'SPEECH_ACT_CONFLICT',p);}else acts.push(act);
  }
  for(const [i,o]of proposal.outcomes.entries()){
    const p='outcomes/'+i;fields(o,['record_id','operation','outcome_transaction_id','assessment_sha256'],p);text(o.record_id,p);text(o.outcome_transaction_id,p);hash(o.assessment_sha256,p);
    need(['complete','fulfill'].includes(o.operation),'OUTCOME_LIFECYCLE_OPERATION',p);unique('record:'+o.record_id);const record=addRecord(o.record_id);
    need(record?.record.kind===(o.operation==='complete'?'goal':'commitment')&&record.record.owner_id===h.c.subject,'OUTCOME_LIFECYCLE_RECORD',p);
    const resolved=outcome(o.record_id,o.operation,o,h,state);resolved.source_facts.forEach(f=>sourceFacts.set(fingerprint({id:f.id,revision:f.version.revision}),f));
    usedOutcomes.set(o.outcome_transaction_id,clone(resolved.record));useCriterion(resolved.item.criterion);
    if(resolved.reasons.length){deferred.push({kind:'outcome',record_id:o.record_id,reasons:[...new Set(resolved.reasons)]});continue;}
    actions.push({kind:'outcome',record_id:o.record_id,record_kind:record.record.kind,operation:o.operation,evidence_kind:'observed_outcome',base_revision:record.record.revision,
      create:false,content_refs:[clone(resolved.item.result.fact_ref)],source_refs:factsSources([resolved.result]),
      outcome_ref:{transaction_id:o.outcome_transaction_id,assessment_sha256:o.assessment_sha256,projection_sha256:fingerprint(resolved.record.projection),criterion_ref:clone(resolved.item.criterion_ref),result_ref:clone(resolved.item.result.fact_ref)},
      event_id:eventId(h.c.namespace,{kind:'outcome',record_id:o.record_id,operation:o.operation,transaction_id:o.outcome_transaction_id,assessment_sha256:o.assessment_sha256})});
  }
  let regulation=null,monitor=null;
  if(proposal.regulations!==undefined){
    regulation=describeRegulations(proposal.regulations,{namespace:h.c.namespace,subject:h.c.subject,base_revision:h.c.base_revision,
      contents:[...h.contents.values()],identity_registry:h.c.identity_registry,records:h.c.records,source_receipts:h.c.source_receipts,
      lifecycle_state:state,native_sources:h.c.regulation_sources??[]});
    for(const f of regulation.source_facts)sourceFacts.set(fingerprint({id:f.id,revision:f.version.revision}),clone(f));
    for(const a of regulation.actions){unique('record:'+a.record_id);addRecord(a.record_id);actions.push(clone(a));}
    deferred.push(...clone(regulation.deferred));monitor=compileRegulationMonitor(h.c.namespace,regulation.monitor_specs);
  }
  const reviewContext={schema:'asuka.lifecycle-review-context/1',namespace:clone(h.c.namespace),subject:h.c.subject,base_revision:h.c.base_revision,state_sha256:fingerprint(state),
    source_facts:[...sourceFacts.values()],source_receipts:[...new Set([...sourceFacts.values()].flatMap(f=>f.version.source_refs))].filter(id=>h.receipts.has(id)).map(id=>clone(h.receipts.get(id))),
    replies:[...usedReplies.values()],goals:[...usedGoals.values()],criteria:[...usedCriteria.values()],records:[...usedRecords.values()],outcomes:[...usedOutcomes.values()],
    ...(usedInternal.size?{internal_goals:[...usedInternal.values()]}:{}),
    ...(regulation?{regulation_sources:clone(regulation.native_sources)}:{})};
  return {schema:'asuka.lifecycle-description/1',proposal:clone(proposal),proposal_sha256:fingerprint(proposal),context:reviewContext,context_sha256:fingerprint(reviewContext),
    actions,speech_acts:acts,deferred,...(regulation?{regulations:clone(regulation.regulations),monitor_assembly:monitor.assembly,
      monitor_outputs:monitor.outputs,regulation_sources:clone(regulation.native_sources)}:{}),
    semantic_review:'required_not_performed_here',execution:'native_transition_required'};
}
export function describeLifecycleProposal(state,proposal,ctx){const h=context(ctx);stateShape(state,h);return describe(state,proposal,h);}
function reviewReceipt(row,namespace){
  fields(row,['input','sequence'],'review_receipt');integer(row.sequence,'review_receipt.sequence',true);fields(row.input,['id','namespace','kind','payload'],'review_receipt.input');
  text(row.input.id,'review_receipt.id');need(same(row.input.namespace,namespace)&&row.input.kind==='review_instruction','LIFECYCLE_REVIEW_RECEIPT','review_receipt');
  fields(row.input.payload,['lifecycle_review'],'review_receipt.payload');const r=row.input.payload.lifecycle_review;
  fields(r,['schema','decision','proposal_sha256','context_sha256','reviewer','notes'],'lifecycle_review');need(r.schema==='asuka.lifecycle-review/1'&&r.decision==='accepted_for_lifecycle','LIFECYCLE_REVIEW_REQUIRED','lifecycle_review');
  need(['assistant','human'].includes(r.reviewer),'LIFECYCLE_REVIEWER','lifecycle_review');text(r.notes,'lifecycle_review.notes');hash(r.proposal_sha256,'review.proposal_sha256');hash(r.context_sha256,'review.context_sha256');return r;
}
const nativeEvent=(h,record_id,operation,evidence_kind,event_id,sources)=>({event_id,record_id,namespace:clone(h.c.namespace),owner_id:h.c.subject,operation,evidence_kind,sources:[...new Set(sources)]});
export function applyLifecycleProgram(state,program,ctx){
  const h=context(ctx,'review_receipt'),old=stateShape(state,h);fields(program,['schema','base_sha256','review_receipt_id','proposal'],'program');
  need(program.schema==='asuka.lifecycle-program/1','LIFECYCLE_PROGRAM_SCHEMA','program');hash(program.base_sha256,'program.base_sha256');text(program.review_receipt_id,'program.review_receipt_id');
  const receipt=ctx.review_receipt,r=reviewReceipt(receipt,h.c.namespace);need(receipt.input.id===program.review_receipt_id,'LIFECYCLE_REVIEW_ID','program');
  const previous=old.reviews.get(receipt.input.id);
  if(previous){need(same(previous.receipt,receipt)&&same(previous.proposal,program.proposal)&&program.base_sha256===previous.context.state_sha256,'LIFECYCLE_REVIEW_REUSED','program');return {state:clone(state),record_creations:[],record_events:[],event_authorizations:[],deferred:[],changed:false,persisted:false};}
  need(program.base_sha256===fingerprint(state),'LIFECYCLE_STATE_BASE','program');const d=describe(state,program.proposal,h);
  need(r.proposal_sha256===d.proposal_sha256&&r.context_sha256===d.context_sha256,'LIFECYCLE_REVIEW_HASH','review');
  need(d.context.source_facts.every(f=>f.version.body.observation_id!==receipt.input.id&&!f.version.source_refs.includes(receipt.input.id)),'LIFECYCLE_REVIEW_IS_SOURCE','review');
  const next=clone(state),record_creations=[],record_events=[],event_authorizations=[],deferred=clone(d.deferred);
  const applied=new Set(state.reviews.flatMap(r=>r.plan.record_events.map(e=>e.event.event_id)));
  for(const a of d.actions){
    if(a.event_id!==null&&applied.has(a.event_id)){deferred.push({record_id:a.record_id,reasons:['same_decision_already_registered']});continue;}
    const sources=[...a.source_refs,receipt.input.id];
    if(a.create){const spec={kind:a.record_kind,id:a.record_id,owner_id:h.c.subject,source_refs:sources,content_refs:a.content_refs};createLifecycleRecord(spec,h.c.namespace);record_creations.push(spec);}
    if(a.operation!==null){
      record_events.push({record_id:a.record_id,base_revision:a.base_revision,event:nativeEvent(h,a.record_id,a.operation,a.evidence_kind,a.event_id,sources)});
      event_authorizations.push({event_id:a.event_id,record_id:a.record_id,kind:a.kind,review_receipt_id:receipt.input.id,
        ...(a.outcome_ref?{outcome_ref:clone(a.outcome_ref)}:{basis_refs:clone(a.content_refs),...(a.internal_goal_ref?{internal_goal_ref:clone(a.internal_goal_ref)}:{})})});
    }
  }
  const approvedActs=d.speech_acts.map(a=>({...a,review_receipt_id:receipt.input.id}));
  for(const a of approvedActs)if(a.kind==='issue'){
    need(!h.records.has(a.commitment_id),'COMMITMENT_ID_CONFLICT','speech_act');
    const spec={kind:'commitment',id:a.commitment_id,owner_id:h.c.subject,source_refs:[...a.source_refs,receipt.input.id],content_refs:a.content_refs};createLifecycleRecord(spec,h.c.namespace);record_creations.push(spec);
  }
  next.speech_acts.push(...approvedActs);
  const plan={record_creations:clone(record_creations),record_events:clone(record_events),event_authorizations:clone(event_authorizations),speech_acts:clone(approvedActs),deferred:clone(deferred),
    ...(d.regulations?{regulations:clone(d.regulations)}:{})};
  const witness={receipt_sha256:fingerprint(receipt),proposal_sha256:d.proposal_sha256,context_sha256:d.context_sha256,plan_sha256:fingerprint(plan)};
  next.reviews.push({receipt_id:receipt.input.id,receipt:clone(receipt),proposal:clone(program.proposal),context:clone(d.context),plan,witness});
  return {state:next,record_creations,record_events,event_authorizations,deferred,changed:true,persisted:false,review_witness:witness,
    ...(d.regulations?{regulations:clone(d.regulations),monitor_assembly:clone(d.monitor_assembly),monitor_outputs:clone(d.monitor_outputs),regulation_sources:clone(d.regulation_sources)}:{})};
}
function deliveryReceipt(row,h){
  fields(row,['input','sequence'],'delivery_receipt');integer(row.sequence,'delivery.sequence',true);fields(row.input,['id','namespace','kind','payload','binding'],'delivery.input');
  text(row.input.id,'delivery.id');need(row.input.kind==='delivery_receipt'&&same(row.input.namespace,h.c.namespace),'DELIVERY_RECEIPT_REQUIRED','delivery');need(object(row.input.payload),'DELIVERY_PAYLOAD','delivery');
  const b=row.input.binding;fields(b,['reply_id','reply_sha256','channel','event'],'delivery.binding',['recipient_ids','delivered_spans','delivery_id']);
  const r=h.replies.get(b.reply_id);need(r&&fingerprint(r)===b.reply_sha256,'DELIVERY_REPLY_MISSING_OR_CHANGED','delivery.binding');
  need(['text','speech'].includes(b.channel)&&(b.channel==='text'?['published','cancelled']:['started','completed','cancelled']).includes(b.event),'DELIVERY_CHANNEL_EVENT','delivery.binding');
  if(b.recipient_ids!==undefined){array(b.recipient_ids,'delivery.recipients');need(new Set(b.recipient_ids).size===b.recipient_ids.length,'DELIVERY_RECIPIENT_DUPLICATE','delivery');b.recipient_ids.forEach(id=>need(h.actors.has(id),'DELIVERY_RECIPIENT_UNKNOWN','delivery'));}
  if(b.delivered_spans!==undefined)array(b.delivered_spans,'delivery.spans').forEach(s=>range(s,r.text,'delivery.span'));
  if(b.delivery_id!==undefined)text(b.delivery_id,'delivery.delivery_id');
  return {b,r};
}
function covers(spans,span){let end=span.start;for(const s of [...(spans??[])].sort((a,b)=>a.start-b.start)){if(s.end<=end)continue;if(s.start>end)return false;end=Math.max(end,s.end);if(end>=span.end)return true;}return false;}
export function applyLifecycleDelivery(state,program,ctx){
  const h=context(ctx,'delivery_receipt'),old=stateShape(state,h);fields(program,['schema','base_sha256','delivery_receipt_id'],'program');
  need(program.schema==='asuka.lifecycle-delivery-program/1','LIFECYCLE_DELIVERY_PROGRAM_SCHEMA','program');hash(program.base_sha256,'program.base_sha256');
  const receipt=ctx.delivery_receipt,{b}=deliveryReceipt(receipt,h);need(receipt.input.id===program.delivery_receipt_id,'LIFECYCLE_DELIVERY_ID','program');
  need(program.base_sha256===fingerprint(state),'LIFECYCLE_STATE_BASE','program');
  const existing=old.deliveries.get(receipt.input.id);if(existing)need(same(existing.receipt,receipt),'DELIVERY_RECEIPT_REUSED','program');
  const next=clone(state),record_creations=[],record_events=[],event_authorizations=[],deferred=[],applications=[],native_applications=[];
  let delivered=false;
  if(!b.delivery_id)deferred.push({kind:'host_delivery',reasons:['delivery_instance_not_established']});
  else{
    const identity=b=>({channel:b.channel,delivery_id:b.delivery_id,reply_id:b.reply_id,reply_sha256:b.reply_sha256,
      recipient_ids:b.recipient_ids?[...b.recipient_ids].sort():null});
    for(const prior of [...h.receipts.values(),...state.deliveries.map(row=>row.receipt)]){
      const pb=prior.input.binding;if(prior.input.kind==='delivery_receipt'&&pb?.channel===b.channel&&pb.delivery_id===b.delivery_id)
        need(same(identity(pb),identity(b)),'DELIVERY_INSTANCE_CHANGED','delivery.binding');
    }
    const id=deliveryRecordId(h.c.namespace,b),wrapper=h.records.get(id),kind=b.channel==='text'?'text_delivery':'speech_delivery';
    if(wrapper)need(wrapper.record.kind===kind&&wrapper.record.owner_id===h.c.subject&&wrapper.source_refs.includes(`reply:${b.reply_id}`),'DELIVERY_RECORD_IDENTITY','delivery');
    else{
      const spec={kind,id,owner_id:h.c.subject,source_refs:[`reply:${b.reply_id}`,receipt.input.id],content_refs:[]};
      createLifecycleRecord(spec,h.c.namespace);record_creations.push(spec);
    }
    const operation=b.channel==='text'?(b.event==='published'?'publish':'cancel'):{started:'start',completed:'complete',cancelled:'cancel'}[b.event];
    const evidence_kind={publish:'host_text_receipt',start:'host_speech_started',complete:'host_speech_completed',cancel:'host_cancel_receipt'}[operation];
    const already=wrapper?.record.applied_events.some(e=>e.payload.operation===operation);
    const isDelivered=wrapper?.record.status===(b.channel==='text'?'published':'completed');
    if(b.channel==='speech'&&operation==='complete'&&!already&&wrapper?.record.status!=='started')
      deferred.push({kind:'host_delivery',record_id:id,reasons:['speech_start_not_committed']});
    else if(!already){
      const event_id=eventId(h.c.namespace,{delivery_record_id:id,operation});
      record_events.push({record_id:id,base_revision:wrapper?.record.revision??0,event:nativeEvent(h,id,operation,evidence_kind,event_id,[receipt.input.id,`reply:${b.reply_id}`])});
      event_authorizations.push({event_id,record_id:id,kind:'host_delivery',delivery_receipt_id:receipt.input.id,delivery_receipt_sha256:fingerprint(receipt),
        reply_id:b.reply_id,reply_sha256:b.reply_sha256,channel:b.channel,delivery_id:b.delivery_id,operation});
      native_applications.push({record_id:id,event_id,operation});
      // This plan is atomic: the host must successfully run this native event
      // before the later speech-act event, or commit neither.
      delivered=['publish','complete'].includes(operation);
    }else delivered=isDelivered;
  }
  for(const act of state.speech_acts.filter(a=>a.reply_id===b.reply_id)){
    if(old.applied.has(act.id))continue;const reasons=[];
    if(!b.delivery_id)reasons.push('delivery_instance_not_established');
    if(b.event!==(b.channel==='text'?'published':'completed'))reasons.push('speech_act_not_delivered');
    if(!delivered)reasons.push('delivery_not_committed_or_planned');
    if(!act.recipient_ids.every(id=>b.recipient_ids?.includes(id)))reasons.push('delivery_audience_not_established');
    if(!covers(b.delivered_spans,act.span))reasons.push('delivery_span_not_covered');
    const target=h.records.get(act.commitment_id);if(!target)reasons.push('commitment_record_not_committed');
    if(reasons.length){deferred.push({speech_act_id:act.id,reasons});continue;}
    need(target.record.kind==='commitment'&&target.record.owner_id===h.c.subject,'COMMITMENT_RECORD_IDENTITY','delivery');
    const event_id=eventId(h.c.namespace,{speech_act_id:act.id}),evidence=act.kind==='issue'?'delivered_speech_act':'delivered_retraction';
    const event=nativeEvent(h,act.commitment_id,act.kind,evidence,event_id,[receipt.input.id,`reply:${act.reply_id}`,act.review_receipt_id,...act.source_refs]);
    record_events.push({record_id:act.commitment_id,base_revision:target.record.revision,event});
    event_authorizations.push({event_id,record_id:act.commitment_id,kind:'delivered_speech_act',speech_act_id:act.id,reply_id:act.reply_id,reply_sha256:act.reply_sha256,
      delivery_receipt_id:receipt.input.id,delivery_receipt_sha256:fingerprint(receipt),review_receipt_id:act.review_receipt_id,span:clone(act.span),recipient_ids:clone(act.recipient_ids)});
    applications.push({speech_act_id:act.id,event_id,record_id:act.commitment_id,base_revision:target.record.revision});
  }
  let row=next.deliveries.find(r=>r.receipt_id===receipt.input.id);
  if(row){row.applications.push(...applications);row.native_applications.push(...native_applications);}else{row={receipt_id:receipt.input.id,receipt:clone(receipt),receipt_sha256:fingerprint(receipt),applications,native_applications};next.deliveries.push(row);}
  return {state:next,record_creations,record_events,event_authorizations,deferred,changed:!existing||applications.length>0||native_applications.length>0,persisted:false,
    delivery_witness:{receipt_id:receipt.input.id,receipt_sha256:fingerprint(receipt)},execution:'native_transition_required'};
}
