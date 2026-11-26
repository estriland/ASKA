// Host-selected importance sources. This module only builds/read-projects a
// typed graph; it does not infer reasons, adopt a goal or write psychological state.
import {catalog as globalCatalog} from './catalog.mjs';
import {createDailyGoalsCatalog} from './daily-goals.mjs';
import {validateGeneralPackage} from './general-package.mjs';
import {applyContentChanges} from './content-records.mjs';
import {assemblyIdentity,fingerprint} from './assembly-identity.mjs';

const clone=structuredClone,own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o),same=(a,b)=>fingerprint(a)===fingerprint(b);
const need=(yes,code,path)=>{if(!yes)throw Object.assign(new Error('GOAL_IMPORTANCE_'+code),{code:'GOAL_IMPORTANCE_'+code,path});};
function text(v,p){need(typeof v==='string'&&Boolean(v.trim())&&!v.includes('\0'),'TEXT',p);return v;}
function array(v,p){need(Array.isArray(v),'ARRAY',p);return v;}
function exact(v,keys,p){need(object(v)&&keys.every(k=>own(v,k))&&Object.keys(v).every(k=>keys.includes(k)),'FIELDS',p);}
function ns(v,p){exact(v,['character_version','conversation_id','world_id'],p);Object.values(v).forEach(x=>text(x,p));}
function hash(v,p){need(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'HASH',p);}
function reference(v,p){exact(v,['id','revision'],p);text(v.id,p);need(Number.isSafeInteger(v.revision)&&v.revision>0,'REFERENCE',p);return clone(v);}
const node=(...parts)=>JSON.stringify(['goal-importance',...parts]);
const output=(instance,field)=>({instance,field});
const out=(instance,field)=>({output:output(instance,field)});
const types={value:'daily_value_importance',need:'need_importance',care:'care_level'};
const families={value:'values',need:'needs',care:'relations'};
const sourceScope=(subject,b)=>({subject,[{value:'value',need:'need',care:'other'}[b.type]]:b.id});

export function createGoalImportanceConfig(raw){
  exact(raw,['schema','weights'],'config');need(raw.schema==='asuka.goal-importance/1','SCHEMA','config.schema');
  exact(raw.weights,['value','need','care'],'config.weights');
  for(const [key,value]of Object.entries(raw.weights))need(typeof value==='number'&&Number.isFinite(value)&&value>=0,'WEIGHT','config.weights.'+key);
  return {config:clone(raw),configuration_sources:['configuration:goal-importance:'+fingerprint(raw)]};
}

/** A finite private catalogue. Only the existing Daily source projections and
 * empty-importance recipe are reused, plus two static aggregation recipes. */
export function createGoalImportanceCatalog(base=globalCatalog){
  need(base?.schema==='asuka.general-recipes/1'&&object(base.types)&&Array.isArray(base.recipes),'CATALOG','base');
  const result=clone(base),daily=createDailyGoalsCatalog();
  for(const id of ['daily_value_importance','daily_importance_contribution']){
    need(!own(result.types,id)||same(result.types[id],daily.types[id]),'TYPE_CONFLICT',id);result.types[id]=clone(daily.types[id]);
  }
  const port={accepts:['daily_importance_contribution'],optional:false,allow_cross_scope:true};
  const skeleton={mechanism:'G.plan',stage:'activation_field',scope:['subject','goal'],parameters:{},parameter_constraints:[],product_steps:[],
    purpose:'Aggregate explicitly associated importance sources with frozen nonnegative family weights.',
    limitations:['Read-only, unfitted engineering importance. Not utility, pressure, adoption, feasibility or an experienced result.']};
  const extra=[
    {id:'goal_importance_sum',...clone(skeleton),inputs:{left:clone(port),right:clone(port)},steps:[
      {id:'total',op:'weighted_sum',type:'daily_importance_contribution',inputs:[{input:'left'},{input:'right'}],params:{weights:[1,1],bias:0}}],outputs:{total:'total'}},
    {id:'goal_importance_finish',...clone(skeleton),inputs:{contribution:clone(port)},steps:[
      {id:'unclamped',op:'weighted_sum',type:'daily_importance_contribution',inputs:[{input:'contribution'}],params:{weights:[1],bias:0}},
      {id:'importance',op:'clamp',type:'goal_importance',inputs:[{step:'unclamped'}],params:{lower:0,upper:1}}],outputs:{unclamped:'unclamped',importance:'importance'}}
  ];
  const reused=['daily_goal_basis_value','daily_goal_basis_need','daily_goal_basis_care','daily_goal_importance_empty'];
  for(const recipe of [...daily.recipes.filter(r=>reused.includes(r.id)),...extra]){
    const prior=result.recipes.filter(r=>r.id===recipe.id);
    need(prior.length<=1&&(!prior.length||same(prior[0],recipe)),'RECIPE_CONFLICT',recipe.id);
    if(!prior.length)result.recipes.push(clone(recipe));
  }
  return result;
}

function validateCareLedger(cell,p){
  const ledger=array(cell.ledger,p+'.ledger');
  for(const row of ledger){
    exact(row,['occurrence_id','meaning_id','interpretation_revision','delta','at'],p+'.ledger.entry');
    text(row.occurrence_id,p);text(row.meaning_id,p);
    need(Number.isSafeInteger(row.interpretation_revision)&&row.interpretation_revision>0,'CARE_LEDGER',p);
    exact(row.delta,['known','value','sources'],p+'.delta');
    need(row.delta.known===true&&typeof row.delta.value==='number'&&Number.isFinite(row.delta.value),'CARE_LEDGER',p);
    need(array(row.delta.sources,p).length>0,'CARE_LEDGER',p);row.delta.sources.forEach(s=>text(s,p));
    need(row.at===null||typeof row.at==='number'&&Number.isFinite(row.at),'CARE_LEDGER',p);
  }
  return ledger.length>0;
}

export function buildGoalImportanceSelection(selectors,context){
  exact(context,['config','model','namespace','subject','input_id','goals','contents','internal_goals','head',
    ...(own(context,'current_care_establishments')?['current_care_establishments']:[])],'context');
  const {namespace,subject,input_id,goals,internal_goals,head}=context;
  ns(namespace,'namespace');text(subject,'subject');text(input_id,'input_id');
  const model=validateGeneralPackage(context.model),modelHash=fingerprint(model),configured=createGoalImportanceConfig(context.config);
  need(model.profile.subject===subject&&model.profile.version===namespace.character_version,'MODEL_IDENTITY','model');
  need(same(head.namespace,namespace),'NAMESPACE','head');array(head.numeric?.cells,'head.numeric.cells');
  array(goals,'goals');array(internal_goals,'internal_goals');
  const contents=applyContentChanges(context.contents,[],namespace).records;
  const currentCare=new Map();
  for(const row of array(context.current_care_establishments??[],'current_care_establishments')){
    exact(row,['other_id','fact_ref'],'current_care_establishments');text(row.other_id,'current_care_establishments.other_id');
    need(row.other_id!==subject&&!currentCare.has(row.other_id),'CARE_ESTABLISHMENT_IDENTITY','current_care_establishments');
    const ref=reference(row.fact_ref,'current_care_establishments.fact_ref'),record=contents.find(c=>c.id===ref.id),version=record?.history.find(v=>v.revision===ref.revision);
    const body=version?.body,scope={subject,other:row.other_id};
    need(record?.kind==='fact'&&record.owner_id===subject&&body?.observation_id===input_id&&version.source_refs.includes(input_id)&&
      body.instance_refs?.some(s=>same(s,scope)),'CARE_ESTABLISHMENT_SOURCE','current_care_establishments');
    currentCare.set(row.other_id,{fact_ref:ref,source_refs:[`content:${ref.id}@${ref.revision}`,...version.source_refs]});
  }
  const configSource=configured.configuration_sources[0],profileSource='configuration:'+modelHash;
  const request={namespace:clone(namespace),instances:[],bindings:[],state_fields:{}},targets=new Map(),selections=[],selectedGoals=new Set();
  const literal=(type,scope,signal)=>({type,scope:clone(scope),signal:clone(signal)});
  const unknown=(reason,refs)=>({known:false,reason,sources:clone(refs)});
  const add=(id,recipe,scope,inputs,parameters={})=>{request.instances.push({id,recipe,scope:clone(scope),inputs:clone(inputs),parameters:clone(parameters)});return id;};
  function bind(from,to,input,source_scope,target_scope,evidence_refs){
    const origin=own(from,'field')?{instance:from.instance,output:from.field}:from;
    if(!same(source_scope,target_scope))request.bindings.push({id:node('binding',to,input),from:clone(origin),to:{instance:to,input},
      source_scope:clone(source_scope),target_scope:clone(target_scope),evidence_refs:[...new Set(evidence_refs)]});
  }
  for(const [i,s]of array(selectors,'selectors').entries()){
    const p=`selectors[${i}]`;exact(s,['goal_id','bases'],p);text(s.goal_id,p+'.goal_id');
    need(!selectedGoals.has(s.goal_id),'DUPLICATE',p);selectedGoals.add(s.goal_id);
    const matches=goals.filter(g=>g?.id===s.goal_id);need(matches.length===1,'GOAL_REQUIRED',p);
    const goal=matches[0],scope={subject,goal:goal.id};
    need(goal.owner_id===subject&&goal.owned_by_subject===true,'GOAL_OWNER',p);need(same(goal.scope,scope),'GOAL_SCOPE',p);
    need(!own(goal,'value_id'),'LEGACY_CONFLICT',p);
    const bases=array(s.bases,p+'.bases'),seen=new Set(),parts=[];
    for(const [bi,b]of bases.entries()){
      const q=p+`.bases[${bi}]`;need(object(b)&&['value','need','care'].includes(b.type),'SOURCE_TYPE',q);
      exact(b,own(b,'fact_ref')?['type','id','fact_ref']:['type','id','reason_key'],q);text(b.id,q+'.id');
      const leaf=JSON.stringify([b.type,b.id]);need(!seen.has(leaf),'SOURCE_DUPLICATE',q);seen.add(leaf);
      const source_scope=sourceScope(subject,b);if(b.type==='care')need(b.id!==subject,'SELF_CARE_SOURCE',q);
      else need(own(model.profile[families[b.type]],b.id),'SOURCE_UNKNOWN',q);
      let binding_basis,evidence;
      if(own(b,'fact_ref')){
        const ref=reference(b.fact_ref,q+'.fact_ref'),record=contents.find(c=>c.id===ref.id);
        need(record?.kind==='fact'&&record.owner_id===subject,'FACT_REQUIRED',q);
        const version=record.history.find(v=>v.revision===ref.revision);need(version,'FACT_REVISION',q);
        need(version.source_refs.includes(version.body.observation_id),'OBSERVATION_SOURCE_REQUIRED',q);
        need(version.body.instance_refs?.some(x=>same(x,scope))&&version.body.instance_refs.some(x=>same(x,source_scope)),'BASIS_SCOPE',q);
        binding_basis={kind:'fact',ref,owner_id:record.owner_id,version:clone(version)};
        evidence=[`content:${ref.id}@${ref.revision}`,...version.source_refs];
      }else{
        text(b.reason_key,q+'.reason_key');const rows=internal_goals.filter(g=>g?.id===goal.id);
        need(rows.length===1,'INTERNAL_GOAL_REQUIRED',q);const internal=rows[0];
        text(internal.proposal_id,q);text(internal.key,q);text(internal.review_receipt_id,q);hash(internal.proposal_sha256,q);
        need(internal.id==='internal-goal:'+fingerprint({namespace,subject,proposal_id:internal.proposal_id,key:internal.key}),'INTERNAL_GOAL_ID',q);
        const reasons=array(internal.reasons,q+'.reasons').filter(r=>r?.key===b.reason_key);need(reasons.length===1,'INTERNAL_REASON_REQUIRED',q);
        const reason=reasons[0];
        need(reason.kind==='profile'&&reason.family===families[b.type]&&reason.id===b.id,'INTERNAL_REASON_MISMATCH',q);
        const resolved=reason.resolved;
        need(own(model.profile[reason.family],b.id)&&resolved?.kind==='profile_configuration'&&resolved.model_sha256===modelHash&&
          resolved.family===reason.family&&resolved.id===b.id&&same(resolved.value,model.profile[reason.family][b.id])&&
          resolved.semantics==='stable_profile_not_current_satisfaction_or_motive','INTERNAL_REASON_MISMATCH',q);
        need(Array.isArray(internal.source_refs)&&internal.source_refs.includes(profileSource),'INTERNAL_REASON_MISMATCH',q);
        binding_basis={kind:'internal_goal_reason',goal_sha256:fingerprint(internal),reason_key:b.reason_key,proposal_sha256:internal.proposal_sha256,
          review_receipt_id:internal.review_receipt_id};
        evidence=['goal-proposal:'+goal.id,profileSource];
      }
      const refs=[...new Set([profileSource,configSource,...evidence])],weight=configured.config.weights[b.type];
      let input,authority;
      if(b.type==='care'){
        const target={mechanism:'model.care',scope:clone(source_scope)},cells=head.numeric.cells.filter(c=>same(c.target,target));
        need(cells.length<=1,'DUPLICATE_CARE_CELL',q);
        const hasHistory=cells.length?validateCareLedger(cells[0],q):false,hasPrior=own(model.profile.relations,b.id);
        const establishment=currentCare.get(b.id);
        if(hasPrior||hasHistory||establishment){input={type:'care_level',state:{...target,view:'value'}};targets.set(fingerprint(target),target);
          authority={kind:hasHistory?'committed_model_care':hasPrior?'profile_seeded_model_care':'candidate_personal_care_establishment',target:clone(target),has_history:hasHistory,has_profile_prior:hasPrior,
            ...(establishment?{establishment_fact_ref:clone(establishment.fact_ref)}:{})};
          if(establishment)refs.push(...establishment.source_refs.filter(ref=>!refs.includes(ref)));
        }else{input=literal('care_level',source_scope,unknown('no_established_personal_care_authority',refs));authority={kind:'unknown',target:clone(target),has_history:false,has_profile_prior:false};}
      }else{
        const value=b.type==='value'?model.profile.values[b.id]:model.profile.needs[b.id].importance;
        input=literal(types[b.type],source_scope,{known:true,value,sources:[profileSource]});
        authority={kind:'profile_configuration',model_sha256:modelHash,family:families[b.type],id:b.id,field:b.type==='need'?'importance':null};
      }
      parts.push({type:b.type,id:b.id,leaf,weight,source_scope,authority,binding_basis,source_refs:refs,input});
    }
    // Stable typed identities, not shared files/source strings, define leaves.
    // Ordering does not select a preferred reason or normalize the weights.
    parts.sort((a,b)=>a.leaf<b.leaf?-1:a.leaf>b.leaf?1:0);
    const metadata=[];
    for(const b of parts){
      const instance=node(goal.id,'basis',b.type,b.id),basisScope={...scope,basis:b.leaf};
      add(instance,'daily_goal_basis_'+b.type,basisScope,{source:b.input},{weight:b.weight});
      bind({external:{instance,input:'source'}},instance,'source',b.source_scope,basisScope,b.source_refs);
      metadata.push({type:b.type,id:b.id,weight:b.weight,source_scope:clone(b.source_scope),scope:basisScope,authority:clone(b.authority),
        binding_basis:clone(b.binding_basis),source_refs:clone(b.source_refs),outputs:{source:output(instance,'source'),contribution:output(instance,'contribution')}});
    }
    const importance=node(goal.id,'importance'),goalSources=[...new Set(metadata.flatMap(b=>b.source_refs))];
    let outputs;
    if(!parts.length){
      // An explicit empty choice is Unknown, not zero and not a legacy fallback.
      add(importance,'daily_goal_importance_empty',scope,{importance:literal('goal_importance',scope,
        unknown('goal_importance_basis_not_selected',[profileSource,configSource]))});outputs={importance:output(importance,'importance')};
    }else{
      let prior=out(metadata[0].outputs.contribution.instance,'contribution'),priorScope=metadata[0].scope;
      for(let bi=1;bi<metadata.length;bi++){
        const next=metadata[bi],sum=node(goal.id,'sum',bi),nextRef=out(next.outputs.contribution.instance,'contribution');
        add(sum,'goal_importance_sum',scope,{left:prior,right:nextRef});
        bind(prior.output,sum,'left',priorScope,scope,goalSources);bind(nextRef.output,sum,'right',next.scope,scope,next.source_refs);
        prior=out(sum,'total');priorScope=scope;
      }
      add(importance,'goal_importance_finish',scope,{contribution:prior});bind(prior.output,importance,'contribution',priorScope,scope,goalSources);
      outputs={importance:output(importance,'importance'),unclamped:output(importance,'unclamped')};
    }
    selections.push({goal_id:goal.id,scope,bases:metadata,outputs,source_refs:goalSources,
      meaning:'importance_not_utility_pressure_or_goal_adoption',weights_normalized:false});
  }
  return {request,instances:[...targets.values()],metadata:{schema:'asuka.goal-importance-selection/1',configuration_sha256:fingerprint(configured.config),
    source_observation_id:input_id,selections,read_only:true,persisted:false,native_executed:false,semantic_review:'not_performed',
    parameter_status:'unfitted_engineering_candidate'}};
}

/** Stable public field order, even when persisted native JSON sorts its keys.
 * This projection is not source-language acceptance or a state update. */
export function projectGoalImportanceReadouts(selections,assembly,evaluation){
  array(selections,'selections');if(!selections.length)return [];
  need(assembly?.schema==='asuka.general-assembly/1'&&evaluation?.graph?.input_identity===assemblyIdentity(assembly)&&
    same(assembly.graph.namespace,evaluation.graph.namespace),'NATIVE_IDENTITY','evaluation');
  function read(ref,scope,type){
    const matches=assembly.outputs.filter(o=>o.instance===ref.instance&&o.field===ref.field);
    need(matches.length===1&&matches[0].type===type&&same(matches[0].scope,scope),'NATIVE_OUTPUT_REQUIRED','output');
    const signal=evaluation.graph.values[matches[0].node_id];need(typeof signal?.known==='boolean','NATIVE_OUTPUT_REQUIRED','signal');
    exact(signal,signal.known?['known','value','sources']:['known','reason','sources'],'signal');
    array(signal.sources,'signal.sources').forEach(s=>text(s,'signal.sources'));
    if(signal.known){const [lo,hi]=assembly.types[type].domain;
      need(typeof signal.value==='number'&&Number.isFinite(signal.value)&&(lo===null||signal.value>=lo)&&(hi===null||signal.value<=hi),'NATIVE_SIGNAL','signal');
      return {known:true,value:signal.value,sources:clone(signal.sources)};}
    text(signal.reason,'signal.reason');return {known:false,reason:signal.reason,sources:clone(signal.sources)};
  }
  return selections.map(s=>({...clone(s),importance:read(s.outputs.importance,s.scope,'goal_importance'),
    ...(s.outputs.unclamped?{unclamped:read(s.outputs.unclamped,s.scope,'daily_importance_contribution')}:{}),
    bases:s.bases.map(b=>({...clone(b),source:read(b.outputs.source,b.scope,types[b.type]),
      contribution:read(b.outputs.contribution,b.scope,'daily_importance_contribution')}))}));
}
