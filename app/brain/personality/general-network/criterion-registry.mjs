// Pure criterion registration. Only an independently stored, host-supplied
// typed review receipt authorizes application; a proposal never approves itself.
// The durable host owns receipt authenticity, exclusive transactions and commit.
import {fingerprint} from './assembly-identity.mjs';
import {applyContentChanges} from './content-records.mjs';
import {validateOutcomeIntake} from './outcome-intake.mjs';

const clone=structuredClone,own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const fail=(code,path)=>{throw Object.assign(new Error(code),{code,path});};
const need=(ok,code,path)=>{if(!ok)fail(code,path);};
const same=(a,b)=>fingerprint(a)===fingerprint(b);
function fields(v,required,p,optional=[]){need(object(v),'OBJECT_REQUIRED',p);need(required.every(k=>own(v,k)),'FIELD_REQUIRED',p);need(Object.keys(v).every(k=>required.includes(k)||optional.includes(k)),'UNEXPECTED_FIELD',p);}
function text(v,p){need(typeof v==='string'&&v.trim()&&!v.includes('\0'),'TEXT_REQUIRED',p);return v;}
function revision(v,p,positive=false){need(Number.isSafeInteger(v)&&v>=(positive?1:0),'REVISION_INVALID',p);return v;}
function hash(v,p){need(typeof v==='string'&&v.length===64&&/^[a-f0-9]+$/.test(v),'HASH_REQUIRED',p);return v;}
function namespace(v,p){fields(v,['character_version','conversation_id','world_id'],p);Object.entries(v).forEach(([k,x])=>text(x,p+'.'+k));}
function array(v,p){need(Array.isArray(v),'ARRAY_REQUIRED',p);return v;}
function reference(v,p){fields(v,['id','revision'],p);return {id:text(v.id,p+'.id'),revision:revision(v.revision,p+'.revision',true)};}
const refKey=r=>JSON.stringify([r.id,r.revision]);

export function emptyCriterionRegistry(ns,subject){
  namespace(ns,'namespace');text(subject,'subject');
  return {schema:'asuka.criterion-registry/1',namespace:clone(ns),subject,catalog:[],admissions:[],reviews:[]};
}
function hostContext(value,withReceipt=false){
  fields(value,['namespace','subject','base_revision','identity_registry','contents',...(withReceipt?['review_receipt']:[])],'context');
  namespace(value.namespace,'context.namespace');text(value.subject,'context.subject');revision(value.base_revision,'context.base_revision');
  const c=clone(value),r=c.identity_registry;
  need(object(r)&&r.schema==='asuka.semantic-identities/1','IDENTITY_REGISTRY_REQUIRED','context.identity_registry');
  need(same(r.namespace,c.namespace)&&r.subject===c.subject,'NAMESPACE_MISMATCH','context.identity_registry');
  const actors=new Set();for(const [i,a]of array(r.actors,'identity_registry.actors').entries()){
    need(object(a),'OBJECT_REQUIRED','actors/'+i);text(a.id,'actors/'+i+'.id');need(!actors.has(a.id),'ACTOR_DUPLICATE','actors/'+i);actors.add(a.id);
  }
  need(actors.has(c.subject),'SUBJECT_ACTOR_MISSING','context.subject');
  const goals=new Map(),ids=new Set();for(const [i,e]of array(r.entities,'identity_registry.entities').entries()){
    need(object(e),'OBJECT_REQUIRED','entities/'+i);text(e.id,'entities/'+i+'.id');need(!ids.has(e.id),'ENTITY_DUPLICATE','entities/'+i);ids.add(e.id);
    if(e.kind==='goal'){need(actors.has(e.owner_id),'GOAL_OWNER_UNKNOWN','entities/'+i);goals.set(e.id,e);}
  }
  const contents=applyContentChanges(c.contents,[],c.namespace).records;
  return {c,goals,contents,byContent:new Map(contents.map(r=>[r.id,r]))};
}
function snapshot(referenceValue,host,p){
  const r=reference(referenceValue,p),record=host.byContent.get(r.id);
  need(record?.kind==='fact','CRITERION_BASIS_FACT_REQUIRED',p);need(record.owner_id===host.c.subject,'CRITERION_BASIS_OWNER',p);
  const version=record.history.find(v=>v.revision===r.revision);need(version,'CRITERION_BASIS_VERSION_MISSING',p);
  return {id:r.id,kind:'fact',namespace:clone(record.namespace),owner_id:record.owner_id,version:clone(version)};
}
function registryShape(registry,host){
  fields(registry,['schema','namespace','subject','catalog','admissions','reviews'],'registry');
  need(registry.schema==='asuka.criterion-registry/1','CRITERION_REGISTRY_SCHEMA','registry');
  need(same(registry.namespace,host.c.namespace)&&registry.subject===host.c.subject,'NAMESPACE_MISMATCH','registry');
  for(const k of ['catalog','admissions','reviews'])array(registry[k],'registry.'+k);
}
function describe(registry,proposal,host){
  fields(proposal,['schema','changes'],'proposal');need(proposal.schema==='asuka.criterion-proposal/1','CRITERION_PROPOSAL_SCHEMA','proposal.schema');
  array(proposal.changes,'proposal.changes');need(proposal.changes.length>0,'CRITERION_CHANGES_REQUIRED','proposal.changes');
  const oldByRef=new Map(registry.catalog.map(r=>[refKey(r),r])),latest=new Map(),changed=new Set(),versions=[],facts=new Map(),goals=new Map();
  for(const r of registry.catalog)if(!latest.has(r.id)||latest.get(r.id).revision<r.revision)latest.set(r.id,r);
  for(const [i,change]of proposal.changes.entries()){
    const p=`proposal.changes/${i}`;fields(change,['id','base_revision','goal_id','scope','parent_ref','statement','basis_refs'],p);
    text(change.id,p+'.id');revision(change.base_revision,p+'.base_revision');text(change.goal_id,p+'.goal_id');text(change.statement,p+'.statement');
    need(!changed.has(change.id),'CRITERION_CHANGE_DUPLICATE',p);changed.add(change.id);
    need(['whole_goal','local'].includes(change.scope),'CRITERION_SCOPE',p+'.scope');
    if(change.scope==='whole_goal')need(change.parent_ref===null,'WHOLE_CRITERION_PARENT',p+'.parent_ref');else reference(change.parent_ref,p+'.parent_ref');
    const previous=latest.get(change.id);need(change.base_revision===(previous?.revision??0),'CRITERION_BASE_REVISION',p+'.base_revision');
    need(change.base_revision<Number.MAX_SAFE_INTEGER,'CRITERION_REVISION_OVERFLOW',p+'.base_revision');
    if(previous)need(previous.goal_id===change.goal_id&&previous.scope===change.scope,'CRITERION_IDENTITY_CHANGED',p);
    const goal=host.goals.get(change.goal_id);need(goal,'CRITERION_GOAL_UNKNOWN',p+'.goal_id');goals.set(goal.id,clone(goal));
    const refs=array(change.basis_refs,p+'.basis_refs');need(refs.length>0,'CRITERION_BASIS_REQUIRED',p+'.basis_refs');
    const seen=new Set();for(const [j,b]of refs.entries()){
      const f=snapshot(b,host,`${p}.basis_refs/${j}`),key=refKey(b);need(!seen.has(key),'CRITERION_BASIS_DUPLICATE',p);seen.add(key);
      need(f.version.body.instance_refs?.some(s=>same(s,{subject:host.c.subject,goal:goal.id})),'CRITERION_BASIS_GOAL_SCOPE',p+'.basis_refs');facts.set(key,f);
    }
    versions.push({id:change.id,revision:change.base_revision+1,namespace:clone(host.c.namespace),goal_id:change.goal_id,scope:change.scope,
      parent_ref:clone(change.parent_ref),statement:change.statement,basis_refs:clone(change.basis_refs)});
  }
  const parents=new Map(),all=new Map([...oldByRef,...versions.map(r=>[refKey(r),r])]);
  for(const r of versions)if(r.scope==='local'){
    const parent=all.get(refKey(r.parent_ref));need(parent,'CRITERION_PARENT_MISSING',r.id+'.parent_ref');
    need(parent.goal_id===r.goal_id&&parent.scope==='whole_goal'&&parent.id!==r.id,'CRITERION_PARENT_BINDING',r.id+'.parent_ref');
    parents.set(refKey(parent),clone(parent));
    for(const [i,b]of parent.basis_refs.entries()){const f=snapshot(b,host,`parent.${parent.id}.basis_refs/${i}`);facts.set(refKey(b),f);}
  }
  const reviewContext={schema:'asuka.criterion-review-context/1',namespace:clone(host.c.namespace),subject:host.c.subject,base_revision:host.c.base_revision,
    registry_sha256:fingerprint(registry),goals:[...goals.values()],source_facts:[...facts.values()],parent_criteria:[...parents.values()]};
  return {schema:'asuka.criterion-proposal-description/1',proposal:clone(proposal),proposal_sha256:fingerprint(proposal),
    context:reviewContext,context_sha256:fingerprint(reviewContext),proposed_versions:versions,semantic_review:'required_not_performed_here'};
}
function reviewReceipt(value,ns){
  fields(value,['input','sequence'],'review_receipt');revision(value.sequence,'review_receipt.sequence',true);
  fields(value.input,['id','namespace','kind','payload'],'review_receipt.input');text(value.input.id,'review_receipt.input.id');
  namespace(value.input.namespace,'review_receipt.input.namespace');need(same(value.input.namespace,ns),'NAMESPACE_MISMATCH','review_receipt');
  need(value.input.kind==='review_instruction','CRITERION_REVIEW_RECEIPT_KIND','review_receipt.input.kind');
  fields(value.input.payload,['criterion_review'],'review_receipt.input.payload');const review=value.input.payload.criterion_review;
  fields(review,['schema','decision','proposal_sha256','context_sha256','reviewer','notes'],'criterion_review');
  need(review.schema==='asuka.criterion-review/1'&&review.decision==='accepted_for_outcome_projection','CRITERION_REVIEW_REQUIRED','criterion_review');
  need(['assistant','human'].includes(review.reviewer),'CRITERION_REVIEWER','criterion_review.reviewer');text(review.notes,'criterion_review.notes');
  hash(review.proposal_sha256,'criterion_review.proposal_sha256');hash(review.context_sha256,'criterion_review.context_sha256');return review;
}
function programShape(program){
  fields(program,['schema','base_sha256','review_receipt_id','proposal'],'program');
  need(program.schema==='asuka.criterion-program/1','CRITERION_PROGRAM_SCHEMA','program.schema');hash(program.base_sha256,'program.base_sha256');text(program.review_receipt_id,'program.review_receipt_id');
}
function applyReviewed(registry,program,host,receipt,description){
  programShape(program);const review=reviewReceipt(receipt,host.c.namespace);
  need(program.review_receipt_id===receipt.input.id,'CRITERION_REVIEW_RECEIPT_ID','program.review_receipt_id');
  need(program.base_sha256===fingerprint(registry),'CRITERION_REGISTRY_BASE','program.base_sha256');
  need(review.proposal_sha256===description.proposal_sha256,'CRITERION_PROPOSAL_REVIEW_MISMATCH','criterion_review.proposal_sha256');
  need(review.context_sha256===description.context_sha256,'CRITERION_CONTEXT_REVIEW_MISMATCH','criterion_review.context_sha256');
  for(const f of description.context.source_facts)need(f.version.body.observation_id!==receipt.input.id&&!f.version.source_refs.includes(receipt.input.id),
    'CRITERION_REVIEW_IS_BASIS_SOURCE','review_receipt.input.id');
  const next=clone(registry),added=[];
  for(const version of description.proposed_versions){
    const admission_ref={id:'criterion-admission:'+fingerprint({namespace:host.c.namespace,receipt_id:receipt.input.id,criterion_id:version.id,criterion_revision:version.revision}),revision:1};
    const criterion={...clone(version),admission_ref};
    const basis=criterion.basis_refs.map((r,i)=>snapshot(r,host,`new.${criterion.id}.basis_refs/${i}`));
    next.catalog.push(criterion);next.admissions.push({...admission_ref,criterion_ref:{id:criterion.id,revision:criterion.revision},
      criterion_sha256:fingerprint(criterion),goal_id:criterion.goal_id,basis_sha256:fingerprint(basis),decision:review.decision});
    added.push({id:criterion.id,revision:criterion.revision});
  }
  const witness={receipt_id:receipt.input.id,receipt_sha256:fingerprint(receipt),program_sha256:fingerprint(program),
    proposal_sha256:description.proposal_sha256,context_sha256:description.context_sha256};
  next.reviews.push({witness,receipt:clone(receipt),program:clone(program),context:clone(description.context),criterion_refs:clone(added)});
  return {registry:next,changed:true,added,review_witness:witness,effects:[],samples:[],lifecycle_events:[],persisted:false};
}

/** Validate the independent review ledger against exact retained source versions.
 * Later content heads and unrelated lifecycle changes do not rewrite old reviews.
 * Stored receipt witnesses still require the durable host's authenticated journal. */
export function validateCriterionRegistry(registry,context){
  const host=hostContext(context);registryShape(registry,host);
  let rebuilt=emptyCriterionRegistry(host.c.namespace,host.c.subject);const seen=new Set();
  for(const [i,r]of registry.reviews.entries()){
    const p=`registry.reviews/${i}`;fields(r,['witness','receipt','program','context','criterion_refs'],p);
    reviewReceipt(r.receipt,host.c.namespace);programShape(r.program);need(!seen.has(r.receipt.input.id),'CRITERION_REVIEW_REUSED',p);seen.add(r.receipt.input.id);
    need(object(r.context),'CRITERION_REVIEW_CONTEXT',p+'.context');revision(r.context.base_revision,p+'.context.base_revision');
    const historicalHost={...host,c:{...host.c,base_revision:r.context.base_revision}};
    const description=describe(rebuilt,r.program.proposal,historicalHost);need(same(description.context,r.context),'CRITERION_STORED_CONTEXT_MISMATCH',p+'.context');
    const applied=applyReviewed(rebuilt,r.program,historicalHost,r.receipt,description);
    need(same(applied.registry.reviews.at(-1),r),'CRITERION_REVIEW_WITNESS_MISMATCH',p);rebuilt=applied.registry;
  }
  need(same(rebuilt,registry),'CRITERION_REGISTRY_REPLAY_MISMATCH','registry');
  validateOutcomeIntake({schema:'asuka.outcome-intake/1',items:[]},{namespace:host.c.namespace,subject:host.c.subject,input_id:'criterion-registry-validation',
    base_revision:host.c.base_revision,identity_registry:host.c.identity_registry,contents:host.contents,criterion_catalog:registry.catalog,criterion_admissions:registry.admissions});
  return clone(registry);
}
export function describeCriterionProposal(registry,proposal,context){
  const host=hostContext(context);validateCriterionRegistry(registry,context);return describe(registry,proposal,host);
}
export function applyCriterionProgram(registry,program,context){
  const host=hostContext(context,true),baseContext={...host.c};delete baseContext.review_receipt;
  validateCriterionRegistry(registry,baseContext);programShape(program);reviewReceipt(context.review_receipt,host.c.namespace);
  need(program.review_receipt_id===context.review_receipt.input.id,'CRITERION_REVIEW_RECEIPT_ID','program.review_receipt_id');
  const prior=registry.reviews.find(r=>r.receipt.input.id===program.review_receipt_id);
  if(prior){
    need(same(prior.program,program)&&same(prior.receipt,context.review_receipt),'CRITERION_REVIEW_REUSED','program.review_receipt_id');
    return {registry:clone(registry),changed:false,added:[],review_witness:clone(prior.witness),effects:[],samples:[],lifecycle_events:[],persisted:false};
  }
  return applyReviewed(registry,program,host,context.review_receipt,describe(registry,program.proposal,host));
}
