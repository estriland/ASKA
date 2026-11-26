// Pure, independently reviewed internal-goal proposals. Source snapshots are
// retained for audit; they are never copied into current motive values or facts.
// The durable host authenticates committed sources and review receipts.
import {fingerprint} from './assembly-identity.mjs';
import {applyContentChanges} from './content-records.mjs';
import {validateGeneralPackage} from './general-package.mjs';
import {createCriterionLearningCatalog} from './criterion-learning.mjs';

const clone=structuredClone,own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o),same=(a,b)=>fingerprint(a)===fingerprint(b);
const need=(ok,code,path)=>{if(!ok)throw Object.assign(new Error(code),{code,path});};
function fields(o,required,p,optional=[]){need(object(o),'OBJECT_REQUIRED',p);need(required.every(k=>own(o,k)),'FIELD_REQUIRED',p);need(Object.keys(o).every(k=>required.includes(k)||optional.includes(k)),'UNEXPECTED_FIELD',p);}
function text(v,p){need(typeof v==='string'&&v.trim()&&!v.includes('\0'),'TEXT_REQUIRED',p);return v;}
function integer(v,p,positive=false){need(Number.isSafeInteger(v)&&v>=(positive?1:0),'REVISION_INVALID',p);return v;}
function hash(v,p){need(typeof v==='string'&&v.length===64&&/^[a-f0-9]+$/.test(v),'HASH_REQUIRED',p);return v;}
function array(v,p){need(Array.isArray(v),'ARRAY_REQUIRED',p);return v;}
function namespace(v,p){fields(v,['character_version','conversation_id','world_id'],p);Object.values(v).forEach(x=>text(x,p));}
function ref(v,p){fields(v,['id','revision'],p);text(v.id,p);integer(v.revision,p,true);return v;}
const refKey=r=>JSON.stringify([r.id,r.revision]),readoutKey=r=>JSON.stringify([r.instance,r.field]);
const semantics='declared_relevance_requires_current_recomputation';
const recipesCatalog=createCriterionLearningCatalog(),recipes=new Map(recipesCatalog.recipes.map(r=>[r.id,r]));
const supportMap={activity:{familiar:['activity_interest','familiar'],present:['activity_interest','present'],exploration:['exploration','drive'],desire:['outcome_desire','desire']},
  relation:{care:['caring_motive','urge'],affiliation:['affiliation_motive','social']},need:{need_pressure:['need_components','pressure']}};
export function emptyInternalGoals(ns,subject){namespace(ns,'namespace');text(subject,'subject');return {schema:'asuka.internal-goals-state/1',namespace:clone(ns),subject,goals:[],reviews:[]};}
function index(rows,p){const m=new Map();for(const row of array(rows,p)){need(object(row),'OBJECT_REQUIRED',p);text(row.id,p);need(!m.has(row.id),'IDENTITY_DUPLICATE',p);m.set(row.id,row);}return m;}
function signal(v,type,p){
  need(object(v)&&typeof v.known==='boolean','SIGNAL_REQUIRED',p);fields(v,v.known?['known','value']:['known','reason'],p,['sources']);
  if(v.known){need(typeof v.value==='number'&&Number.isFinite(v.value),'FINITE_NUMBER_REQUIRED',p);const [lo,hi]=type.domain;
    need((lo===null||v.value>=lo-1e-12)&&(hi===null||v.value<=hi+1e-12),'READOUT_DOMAIN',p);
  }else text(v.reason,p+'.reason');
  if(v.sources!==undefined)array(v.sources,p+'.sources').forEach(s=>text(s,p+'.sources'));
}
function hostContext(value,withReceipt=false){
  fields(value,['namespace','subject','base_revision','model','identity_registry','contents','anchor_transaction_id','committed_sources',...(withReceipt?['review_receipt']:[])],'context');
  namespace(value.namespace,'context.namespace');text(value.subject,'context.subject');integer(value.base_revision,'context.base_revision');
  if(value.anchor_transaction_id!==null)text(value.anchor_transaction_id,'context.anchor_transaction_id');
  const c=clone(value),model=validateGeneralPackage(c.model);need(model.profile.subject===c.subject&&model.profile.version===c.namespace.character_version,'INTERNAL_GOAL_MODEL_IDENTITY','context.model');
  const r=c.identity_registry;need(r?.schema==='asuka.semantic-identities/1'&&r.subject===c.subject&&same(r.namespace,c.namespace),'IDENTITY_REGISTRY_REQUIRED','context');
  const actors=index(r.actors,'actors'),entities=index(r.entities,'entities');need(actors.has(c.subject),'SUBJECT_ACTOR_MISSING','context.subject');
  const contents=new Map(applyContentChanges(c.contents,[],c.namespace).records.map(f=>[f.id,f])),sources=new Map();
  for(const [i,source]of array(c.committed_sources,'committed_sources').entries()){
    const p='committed_sources/'+i;fields(source,['transaction_id','revision','intent_sha256','assembly_identity','input_id','scene_time','readouts'],p);
    text(source.transaction_id,p);integer(source.revision,p,true);need(source.revision<=c.base_revision,'SOURCE_NOT_COMMITTED_AT_BASE',p);
    hash(source.intent_sha256,p+'.intent_sha256');hash(source.assembly_identity,p+'.assembly_identity');text(source.input_id,p+'.input_id');
    need(source.scene_time===null||typeof source.scene_time==='number'&&Number.isFinite(source.scene_time),'SCENE_TIME_INVALID',p);
    need(!sources.has(source.transaction_id),'COMMITTED_SOURCE_DUPLICATE',p);const rows=new Map();
    for(const [j,row]of array(source.readouts,p+'.readouts').entries()){
      const q=p+'.readouts/'+j;fields(row,['instance','field','type','scope','signal','recipe'],q);for(const key of ['instance','field','type','recipe'])text(row[key],q+'.'+key);
      const recipe=recipes.get(row.recipe);need(recipe&&own(recipe.outputs,row.field),'NATIVE_RECIPE_FIELD',q);
      const step=recipe.steps.find(s=>s.id===recipe.outputs[row.field]);need(step?.type===row.type&&recipesCatalog.types[row.type],'NATIVE_READOUT_TYPE',q);
      need(object(row.scope)&&same(Object.keys(row.scope).sort(),[...recipe.scope].sort())&&row.scope.subject===c.subject,'NATIVE_READOUT_SCOPE',q);
      Object.entries(row.scope).forEach(([key,v])=>{text(key,q+'.scope');text(v,q+'.scope');});signal(row.signal,recipesCatalog.types[row.type],q+'.signal');
      const key=readoutKey(row);need(!rows.has(key),'NATIVE_READOUT_DUPLICATE',q);rows.set(key,row);
    }
    sources.set(source.transaction_id,{source,rows});
  }
  return {c,model,modelHash:fingerprint(model),actors,entities,contents,sources};
}
function entity(reference,h,p){
  fields(reference,['kind','id'],p);text(reference.id,p);need(['activity','relation','need','actor'].includes(reference.kind),'INTERNAL_GOAL_ABOUT_KIND',p);
  if(reference.kind==='actor'){need(h.actors.has(reference.id),'ABOUT_ACTOR_NOT_REGISTERED',p);return {scope:{subject:h.c.subject},identity:h.actors.get(reference.id)};}
  if(reference.kind==='need'){need(own(h.model.profile.needs,reference.id),'ABOUT_NEED_NOT_REGISTERED',p);return {scope:{subject:h.c.subject,need:reference.id},identity:{kind:'need',id:reference.id}};}
  const found=h.entities.get(reference.id);need(found?.kind===reference.kind,'ABOUT_ENTITY_NOT_REGISTERED',p);
  if(reference.kind==='relation'){need(h.actors.has(found.other_id)&&found.other_id!==h.c.subject,'RELATION_ACTOR_NOT_REGISTERED',p);return {scope:{subject:h.c.subject,other:found.other_id},identity:found};}
  return {scope:{subject:h.c.subject,activity:found.id},identity:found};
}
function fact(reference,h,p){ref(reference,p);const f=h.contents.get(reference.id);need(f?.kind==='fact'&&f.owner_id===h.c.subject,'INTERNAL_REASON_FACT_OWNER_OR_KIND',p);
  const version=f.history.find(v=>v.revision===reference.revision);need(version,'INTERNAL_REASON_FACT_VERSION',p);
  return {id:f.id,kind:f.kind,namespace:clone(f.namespace),owner_id:f.owner_id,version:clone(version)};
}
function stateShape(state,h){
  fields(state,['schema','namespace','subject','goals','reviews'],'state');need(state.schema==='asuka.internal-goals-state/1','INTERNAL_GOALS_STATE_SCHEMA','state');
  need(same(state.namespace,h.c.namespace)&&state.subject===h.c.subject,'NAMESPACE_MISMATCH','state');array(state.goals,'state.goals');array(state.reviews,'state.reviews');
}
function describe(state,proposal,h){
  fields(proposal,['schema','id','goals'],'proposal');need(proposal.schema==='asuka.internal-goals/1','INTERNAL_GOALS_SCHEMA','proposal');text(proposal.id,'proposal.id');
  const rows=array(proposal.goals,'proposal.goals');need(rows.length>0,'INTERNAL_GOALS_REQUIRED','proposal.goals');
  need(!state.reviews.some(r=>r.program.proposal.id===proposal.id),'INTERNAL_PROPOSAL_ALREADY_REVIEWED','proposal.id');
  const proposalHash=fingerprint(proposal),keys=new Set(),goals=[],profileSnapshots=new Map(),nativeSnapshots=new Map(),factSnapshots=new Map(),aboutSnapshots=new Map();
  for(const [i,g]of rows.entries()){
    const p='proposal.goals/'+i;fields(g,['key','label','description','about','reasons','supports'],p);for(const k of ['key','label','description'])text(g[k],p+'.'+k);
    need(!keys.has(g.key),'INTERNAL_GOAL_KEY_DUPLICATE',p);keys.add(g.key);const id='internal-goal:'+fingerprint({namespace:h.c.namespace,subject:h.c.subject,proposal_id:proposal.id,key:g.key});
    need(!state.goals.some(old=>old.id===id),'INTERNAL_GOAL_ALREADY_EXISTS',p);
    const about=array(g.about,p+'.about');need(about.length>0,'INTERNAL_GOAL_ABOUT_REQUIRED',p);const aboutKeys=new Set();
    for(const [j,r]of about.entries()){const resolved=entity(r,h,p+'.about/'+j),key=JSON.stringify([r.kind,r.id]);need(!aboutKeys.has(key),'INTERNAL_GOAL_ABOUT_DUPLICATE',p);aboutKeys.add(key);aboutSnapshots.set(key,clone(resolved.identity));}
    const reasons=array(g.reasons,p+'.reasons');need(reasons.length>0,'INTERNAL_GOAL_REASON_REQUIRED',p);const byKey=new Map(),resolvedReasons=[],sourceRefs=new Set(['configuration:'+h.modelHash]);
    for(const [j,r]of reasons.entries()){
      const q=p+'.reasons/'+j;need(['profile','native','fact'].includes(r?.kind),'INTERNAL_REASON_KIND',q);
      fields(r,r.kind==='profile'?['key','kind','family','id','why']:r.kind==='native'?['key','kind','transaction_id','instance','field','use','why']:['key','kind','ref','why'],q);
      text(r.key,q+'.key');text(r.why,q+'.why');need(!byKey.has(r.key),'INTERNAL_REASON_KEY_DUPLICATE',q);let resolved;
      if(r.kind==='profile'){
        need(['values','principles','needs','interests','relations'].includes(r.family),'INTERNAL_PROFILE_FAMILY',q);text(r.id,q+'.id');need(own(h.model.profile[r.family],r.id),'PROFILE_REASON_NOT_REGISTERED',q);
        resolved={kind:'profile_configuration',model_sha256:h.modelHash,family:r.family,id:r.id,value:clone(h.model.profile[r.family][r.id]),semantics:'stable_profile_not_current_satisfaction_or_motive'};
        profileSnapshots.set(JSON.stringify([r.family,r.id]),clone(resolved));
      }else if(r.kind==='native'){
        for(const k of ['transaction_id','instance','field'])text(r[k],q+'.'+k);need(['anchor','historical'].includes(r.use),'NATIVE_REASON_USE',q);
        if(r.use==='anchor')need(h.c.anchor_transaction_id!==null&&r.transaction_id===h.c.anchor_transaction_id,'NATIVE_REASON_NOT_ANCHOR',q);
        const found=h.sources.get(r.transaction_id);need(found,'COMMITTED_NATIVE_SOURCE_REQUIRED',q);need(found.source.revision<=h.c.base_revision,'SOURCE_NOT_COMMITTED_AT_BASE',q);
        const row=found.rows.get(readoutKey(r));need(row,'COMMITTED_NATIVE_READOUT_REQUIRED',q);
        const {readouts,...metadata}=found.source;resolved={kind:'committed_native_readout',...clone(metadata),readout:clone(row),
          semantics:r.use==='anchor'?'snapshot_at_proposal_anchor_not_a_current_write':'historical_snapshot_not_current_motive'};
        nativeSnapshots.set(JSON.stringify([r.transaction_id,r.instance,r.field]),clone(resolved));sourceRefs.add('committed-readout:'+r.transaction_id);
      }else{
        const snapshot=fact(r.ref,h,q);resolved={kind:'content_version',snapshot,semantics:'original_epistemic_and_time_fields_retained'};factSnapshots.set(refKey(r.ref),clone(snapshot));
        sourceRefs.add(`content:${r.ref.id}@${r.ref.revision}`);snapshot.version.source_refs.forEach(s=>sourceRefs.add(s));
      }
      const row={...clone(r),resolved};resolvedReasons.push(row);byKey.set(r.key,row);
    }
    const supports=[],fromKeys=new Set();
    for(const [j,s]of array(g.supports,p+'.supports').entries()){
      const q=p+'.supports/'+j;fields(s,['reason_key','from'],q);text(s.reason_key,q);fields(s.from,['kind','id','component'],q+'.from');text(s.from.component,q);
      const r=byKey.get(s.reason_key);need(r?.kind==='native','SUPPORT_REQUIRES_NATIVE_REASON',q);
      const expected=supportMap[s.from.kind]?.[s.from.component];need(expected,'INTERNAL_SUPPORT_COMPONENT',q);
      const identity=entity({kind:s.from.kind,id:s.from.id},h,q+'.from'),row=r.resolved.readout;
      need(row.recipe===expected[0]&&row.field===expected[1]&&same(row.scope,identity.scope),'INTERNAL_SUPPORT_READOUT_MISMATCH',q);
      const key=JSON.stringify([s.from.kind,s.from.id,s.from.component]);need(!fromKeys.has(key),'INTERNAL_SUPPORT_DUPLICATE',q);fromKeys.add(key);
      aboutSnapshots.set(JSON.stringify([s.from.kind,s.from.id]),clone(identity.identity));
      supports.push({...clone(s),resolved:{transaction_id:r.transaction_id,instance:r.instance,recipe:row.recipe,field:row.field,type:row.type,scope:clone(row.scope),semantics}});
    }
    goals.push({id,proposal_id:proposal.id,proposal_sha256:proposalHash,key:g.key,label:g.label,description:g.description,about:clone(about),reasons:resolvedReasons,supports,source_refs:[...sourceRefs]});
  }
  const reviewContext={schema:'asuka.internal-goal-review-context/1',namespace:clone(h.c.namespace),subject:h.c.subject,base_revision:h.c.base_revision,
    anchor_transaction_id:h.c.anchor_transaction_id,state_sha256:fingerprint(state),model_sha256:h.modelHash,
    profile_reasons:[...profileSnapshots.values()],native_reasons:[...nativeSnapshots.values()],source_facts:[...factSnapshots.values()],identities:[...aboutSnapshots.values()]};
  return {schema:'asuka.internal-goal-description/1',proposal:clone(proposal),proposal_sha256:proposalHash,context:reviewContext,context_sha256:fingerprint(reviewContext),
    goals,semantic_review:'required_not_performed_here',semantics,creates_facts:false,adopts_goals:false,native_execution:false};
}
function programShape(p){fields(p,['schema','base_sha256','review_receipt_id','proposal'],'program');need(p.schema==='asuka.internal-goal-program/1','INTERNAL_GOAL_PROGRAM_SCHEMA','program');hash(p.base_sha256,'program.base_sha256');text(p.review_receipt_id,'program.review_receipt_id');}
function reviewReceipt(row,ns){
  fields(row,['input','sequence'],'review_receipt');integer(row.sequence,'review_receipt.sequence',true);fields(row.input,['id','namespace','kind','payload'],'review_receipt.input');
  text(row.input.id,'review_receipt.id');need(same(row.input.namespace,ns)&&row.input.kind==='review_instruction','INTERNAL_GOAL_REVIEW_RECEIPT','review_receipt');
  fields(row.input.payload,['internal_goal_review'],'review_receipt.payload');const r=row.input.payload.internal_goal_review;
  fields(r,['schema','decision','proposal_sha256','context_sha256','reviewer','notes'],'internal_goal_review');
  need(r.schema==='asuka.internal-goal-review/1'&&r.decision==='accepted_for_internal_goals','INTERNAL_GOAL_REVIEW_REQUIRED','review');
  need(['assistant','human'].includes(r.reviewer),'INTERNAL_GOAL_REVIEWER','review');text(r.notes,'review.notes');hash(r.proposal_sha256,'review.proposal_sha256');hash(r.context_sha256,'review.context_sha256');return r;
}
function applyReviewed(state,program,h,receipt,d){
  programShape(program);const r=reviewReceipt(receipt,h.c.namespace);need(receipt.input.id===program.review_receipt_id,'INTERNAL_GOAL_REVIEW_ID','program');
  need(program.base_sha256===fingerprint(state),'INTERNAL_GOALS_STATE_BASE','program');need(r.proposal_sha256===d.proposal_sha256&&r.context_sha256===d.context_sha256,'INTERNAL_GOAL_REVIEW_HASH','review');
  need(d.context.source_facts.every(f=>f.version.body.observation_id!==receipt.input.id&&!f.version.source_refs.includes(receipt.input.id))&&
    d.context.native_reasons.every(s=>s.input_id!==receipt.input.id),'INTERNAL_GOAL_REVIEW_IS_SOURCE','review');
  const next=clone(state),added=d.goals.map(g=>({...clone(g),review_receipt_id:receipt.input.id}));next.goals.push(...added);
  const identity_goals=added.map(g=>({id:g.id,label:g.label,owner_id:h.c.subject,origin:{kind:'internal_goal_proposal',proposal_id:g.proposal_id,key:g.key,
    review_receipt_id:g.review_receipt_id,proposal_sha256:g.proposal_sha256}}));
  const witness={receipt_id:receipt.input.id,receipt_sha256:fingerprint(receipt),program_sha256:fingerprint(program),proposal_sha256:d.proposal_sha256,context_sha256:d.context_sha256};
  next.reviews.push({receipt:clone(receipt),program:clone(program),context:clone(d.context),goal_ids:added.map(g=>g.id),witness});
  return {state:next,identity_goals,changed:true,persisted:false,review_witness:witness};
}
function validateState(state,h){
  stateShape(state,h);let rebuilt=emptyInternalGoals(h.c.namespace,h.c.subject);const receipts=new Set();
  for(const [i,row]of state.reviews.entries()){
    const p='state.reviews/'+i;fields(row,['receipt','program','context','goal_ids','witness'],p);programShape(row.program);reviewReceipt(row.receipt,h.c.namespace);
    need(!receipts.has(row.receipt.input.id),'INTERNAL_GOAL_REVIEW_REUSED',p);receipts.add(row.receipt.input.id);
    integer(row.context.base_revision,p+'.context.base_revision');need(row.context.base_revision<=h.c.base_revision,'REVIEW_FROM_FUTURE',p);
    // Anchor means the anchor at proposal time. Later observations do not
    // retroactively turn that immutable reviewed source into an invalid one.
    const historical={...h,c:{...h.c,base_revision:row.context.base_revision,anchor_transaction_id:row.context.anchor_transaction_id}};
    const d=describe(rebuilt,row.program.proposal,historical);need(same(d.context,row.context),'INTERNAL_GOAL_STORED_CONTEXT_CHANGED',p);
    const result=applyReviewed(rebuilt,row.program,historical,row.receipt,d);need(same(result.state.reviews.at(-1),row),'INTERNAL_GOAL_STORED_REVIEW_CHANGED',p);rebuilt=result.state;
  }
  need(same(rebuilt,state),'INTERNAL_GOALS_STATE_REPLAY_MISMATCH','state');return clone(state);
}
export function describeInternalGoals(state,proposal,ctx){const h=hostContext(ctx);validateState(state,h);return describe(state,proposal,h);}
export function applyInternalGoals(state,program,ctx){
  const h=hostContext(ctx,true);validateState(state,h);programShape(program);reviewReceipt(ctx.review_receipt,h.c.namespace);
  need(program.review_receipt_id===ctx.review_receipt.input.id,'INTERNAL_GOAL_REVIEW_ID','program');
  const prior=state.reviews.find(r=>r.receipt.input.id===program.review_receipt_id);
  if(prior){need(same(prior.program,program)&&same(prior.receipt,ctx.review_receipt),'INTERNAL_GOAL_REVIEW_REUSED','program');return {state:clone(state),identity_goals:[],changed:false,persisted:false};}
  return applyReviewed(state,program,h,ctx.review_receipt,describe(state,program.proposal,h));
}
