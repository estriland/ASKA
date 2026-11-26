// Private, read-only M.enjoyment -> preparation adapter. It does not create an
// A.positive copy, select an action, approve language evidence or write state.
import {catalog} from './catalog.mjs';
import {fingerprint} from './assembly-identity.mjs';

const clone=structuredClone,own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k),object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const need=(yes,code,path)=>{if(!yes)throw Object.assign(new Error(code),{code,path});};
function exact(o,keys,p){need(object(o)&&keys.every(k=>own(o,k))&&Object.keys(o).every(k=>keys.includes(k)),'POSITIVE_EXPERIENCE_FIELDS',p);}
function text(v,p){need(typeof v==='string'&&Boolean(v.trim())&&!v.includes('\0'),'POSITIVE_EXPERIENCE_TEXT',p);return v;}
function array(v,p){need(Array.isArray(v),'POSITIVE_EXPERIENCE_ARRAY',p);return v;}
function integer(v,p){need(Number.isSafeInteger(v)&&v>0,'POSITIVE_EXPERIENCE_REVISION',p);}
function sources(v,p){array(v,p).forEach(s=>text(s,p));}
function signal(v,p){need(object(v)&&typeof v.known==='boolean','POSITIVE_EXPERIENCE_SIGNAL',p);
  exact(v,v.known?['known','value','sources']:['known','reason','sources'],p);sources(v.sources,p+'.sources');
  if(v.known)need(typeof v.value==='number'&&Number.isFinite(v.value),'POSITIVE_EXPERIENCE_SIGNAL',p);else text(v.reason,p+'.reason');
}

export function createPositiveExperienceCatalog(base=catalog){
  need(base?.schema==='asuka.general-recipes/1'&&object(base.types)&&Array.isArray(base.recipes),'POSITIVE_EXPERIENCE_CATALOG','base');
  const c=clone(base),input=name=>({input:name}),parameter=name=>({parameter:name});
  const weighted=(id,type,inputs,weights)=>({id,op:'weighted_sum',type,inputs:inputs.map(input),params:{weights,bias:0}});
  const original=c.recipes.find(r=>r.id==='action_preparation');need(original,'POSITIVE_EXPERIENCE_BASE_RECIPE','base');
  const recipe={id:'experienced_action_preparation',mechanism:'A.readiness',stage:original.stage,scope:['subject','event','concern'],
    inputs:{enjoyment:{accepts:['experienced_enjoyment'],optional:false,allow_cross_scope:true},
      ...Object.fromEntries(['negative','norm_support','norm_conflict','self_control','other_responsibility','self_responsibility'].map(k=>[k,clone(original.inputs[k])]))},
    parameters:{experience_weight:{min:0,max:1},norm_weight:{min:0,max:1}},
    parameter_constraints:[{kind:'sum_max',keys:['experience_weight','norm_weight'],value:1}],
    steps:[weighted('enjoyment','experienced_enjoyment',['enjoyment'],[1]),
      weighted('experience_component','engage_readiness',['enjoyment'],[parameter('experience_weight')]),
      weighted('norm_component','engage_readiness',['norm_support'],[parameter('norm_weight')]),
      // Equivalent to experience_component + norm_component. The compiler's
      // interval analysis uses declared output types, so summing two [0,1]
      // intermediate types would lose the shared sum-of-weights constraint.
      weighted('engage','engage_readiness',['enjoyment','norm_support'],[parameter('experience_weight'),parameter('norm_weight')]),
      ...original.steps.filter(s=>['change','boundary','self_review'].includes(s.id)).map(s=>clone(s))],
    outputs:Object.fromEntries(['enjoyment','experience_component','norm_component','engage','change','boundary','self_review'].map(k=>[k,k])),
    product_steps:['change','boundary','self_review'],
    purpose:'直接读取已有M.enjoyment形成参与准备；体验与规范分量分别呈现，保留其证据所有者，不复制为A.positive。',
    limitations:['这是未标定的工程读出，不是新增体验、采用行为或语义审核。',
      'engage等于两个分量之和；总量与分量是同一来源的分解，不能再次相加或当作独立证据。',
      '规范Unknown不污染单独的体验分量；总engage仍保留其依赖的Unknown。',
      '输出均为只读level，不创建状态、情绪贡献、时间推进或TTS条件。']};
  const previous=c.recipes.filter(r=>r.id===recipe.id);
  need(previous.length<=1&&(!previous.length||same(previous[0],recipe)),'POSITIVE_EXPERIENCE_RECIPE_CONFLICT','base');
  if(!previous.length)c.recipes.push(recipe);return c;
}

/** This selector only proves that a source may be routed to a candidate graph.
 * The existing mechanism writer still performs final route/admission checks.
 * No numeric value is read from a ledger or recomputed in JavaScript. */
export function selectPositiveExperience(raw){
  exact(raw,['subject','event_id','activity_id','applicability','head','claims','contents','input_id'],'request');
  const {subject,event_id,activity_id,applicability,head,claims,contents,input_id}=raw;
  for(const [k,v]of Object.entries({subject,event_id,activity_id,input_id}))text(v,k);
  exact(head?.namespace,['character_version','conversation_id','world_id'],'head.namespace');Object.values(head.namespace).forEach(v=>text(v,'head.namespace'));
  signal(applicability,'applicability');if(applicability.known)need(applicability.value>=0&&applicability.value<=1,'POSITIVE_EXPERIENCE_APPLICABILITY','applicability');
  array(claims,'claims');array(contents,'contents');array(head.numeric?.cells,'head.numeric.cells');
  const target={mechanism:'model.enjoyment',scope:{subject,event:event_id,activity:activity_id}},origin_key=fingerprint({namespace:head.namespace,target});
  const matches=head.numeric.cells.filter(cell=>same(cell.target,target));need(matches.length<=1,'POSITIVE_EXPERIENCE_DUPLICATE_CELL','head.numeric.cells');
  if(matches.length){
    const ledger=array(matches[0].ledger,'head.numeric.cells.ledger'),identities=new Set();
    for(const entry of ledger){
      exact(entry,['occurrence_id','meaning_id','interpretation_revision','delta','at'],'ledger.entry');
      text(entry.occurrence_id,'ledger.occurrence_id');text(entry.meaning_id,'ledger.meaning_id');integer(entry.interpretation_revision,'ledger.interpretation_revision');
      signal(entry.delta,'ledger.delta');need(entry.delta.known,'POSITIVE_EXPERIENCE_UNKNOWN_LEDGER','ledger.delta');
      need(entry.at===null||typeof entry.at==='number'&&Number.isFinite(entry.at),'POSITIVE_EXPERIENCE_TIME','ledger.at');
      const key=JSON.stringify([entry.occurrence_id,entry.meaning_id]);need(!identities.has(key),'POSITIVE_EXPERIENCE_DUPLICATE_LEDGER','ledger');identities.add(key);
    }
  }
  const has_history=Boolean(matches[0]?.ledger.length);
  const result=(origin,usable,candidate=null,reason=null)=>({target:clone(target),origin_key,usable,origin,has_history,
    candidate_claim_id:candidate?.id??null,fact_ref:candidate?clone(candidate.fact_ref):null,reason});
  if(applicability.known&&applicability.value===0)return result('inapplicable',false,null,'current_activity_link_not_applicable');
  const eligible=new Map();
  for(const claim of claims){
    if(claim.channel_id!=='model.enjoyment'||!same(claim.scope,target.scope)||
      !['new_occurrence_effect','replace_interpretation'].includes(claim.mode)||typeof claim.symbol!=='string'||!claim.symbol.trim())continue;
    text(claim.id,'claim.id');text(claim.symbol,'claim.symbol');
    exact(claim.fact_ref,['id','revision'],'claim.fact_ref');text(claim.fact_ref.id,'claim.fact_ref.id');integer(claim.fact_ref.revision,'claim.fact_ref.revision');
    const records=contents.filter(r=>r.id===claim.fact_ref.id);need(records.length===1,'POSITIVE_EXPERIENCE_FACT_REFERENCE','claim.fact_ref');
    const record=records[0];need(Array.isArray(record.history),'POSITIVE_EXPERIENCE_FACT_HISTORY','claim.fact_ref');
    const versions=record.history.filter(v=>v.revision===claim.fact_ref.revision);need(versions.length===1,'POSITIVE_EXPERIENCE_FACT_REFERENCE','claim.fact_ref');
    const version=versions[0];need(object(version.body),'POSITIVE_EXPERIENCE_FACT_BODY','claim.fact_ref');sources(version.source_refs,'fact.source_refs');
    need(version.source_refs.length>0,'POSITIVE_EXPERIENCE_FACT_SOURCES','claim.fact_ref');
    const b=version.body;
    if(record.kind!=='fact'||record.owner_id!==subject||!same(record.namespace,head.namespace)||
      b.presentation!=='current_report'||b.observation_id!==input_id||b.occurrence_id!==event_id||
      !['completed','ongoing'].includes(b.occurrence_status)||!['observed','self_report','reported'].includes(b.epistemic_status)||
      b.novelty!==(claim.mode==='replace_interpretation'?'correction':'new_evidence')||
      !Array.isArray(b.instance_refs)||!b.instance_refs.some(s=>same(s,target.scope)))continue;
    const prior=eligible.get(claim.id);need(!prior||same(prior,claim),'POSITIVE_EXPERIENCE_CLAIM_CONFLICT','claim');eligible.set(claim.id,claim);
  }
  need(eligible.size<=1,'POSITIVE_EXPERIENCE_AMBIGUOUS_CLAIMS','claims');
  if(eligible.size){const claim=[...eligible.values()][0];return result(claim.mode==='replace_interpretation'?'candidate_correction':'candidate_new',true,claim);}
  return has_history?result('committed_history',true):result('unknown',false,null,'no_recorded_experience');
}
