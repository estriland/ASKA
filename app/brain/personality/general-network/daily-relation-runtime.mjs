// Pure adapter for an opt-in engine situation. The host supplies frozen values,
// exact content versions and existing personal-care readouts. No language model,
// semantic approval, disk write, native call, time inference or care update.
import {buildDailyRelations,createDailyRelationsCatalog} from './daily-relations.mjs';
import {compileAssembly} from './assembly-compiler.mjs';
import {applyContentChanges} from './content-records.mjs';
import {fingerprint} from './assembly-identity.mjs';

const clone=structuredClone,own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const need=(yes,code,path)=>{if(!yes)throw Object.assign(new Error(code),{code,path});};
const text=(x,p)=>{need(typeof x==='string'&&x.trim()&&!x.includes('\0'),'DAILY_RELATION_TEXT',p);return x;};
function exact(x,keys,p){need(object(x),'DAILY_RELATION_OBJECT',p);need(keys.every(k=>own(x,k))&&Object.keys(x).every(k=>keys.includes(k)),'DAILY_RELATION_FIELDS',p);}
function array(x,p){need(Array.isArray(x),'DAILY_RELATION_ARRAY',p);return x;}
function ns(x){exact(x,['character_version','conversation_id','world_id'],'namespace');Object.values(x).forEach(v=>text(v,'namespace'));}
function ref(x,p){exact(x,['id','revision'],p);text(x.id,p+'.id');need(Number.isSafeInteger(x.revision)&&x.revision>0,'DAILY_RELATION_REFERENCE',p);return clone(x);}
function signal(x,p){
  need(object(x)&&typeof x.known==='boolean','DAILY_RELATION_SIGNAL',p);
  exact(x,x.known?['known','value','sources']:['known','reason','sources'],p);
  array(x.sources,p+'.sources').forEach(s=>text(s,p+'.sources'));need(new Set(x.sources).size===x.sources.length,'DAILY_RELATION_SOURCE_DUPLICATE',p);
  if(x.known){need(typeof x.value==='number'&&Number.isFinite(x.value)&&x.value>=0&&x.value<=1,'DAILY_RELATION_DOMAIN',p);need(x.sources.length>0,'DAILY_RELATION_SOURCE_REQUIRED',p);}
  else text(x.reason,p+'.reason');return clone(x);
}
const PAIR='experience.daily_relations',SUM=PAIR+'.sum',MASS=PAIR+'.mass';
const SCOPE=['subject','other','dimension','criterion','criterion_revision'];
const VIEW_FIELDS=['other_need','help_opportunity','connection_appeal','contact_opportunity','respect','cooperation','friction'];
const refId=x=>JSON.stringify([x.id,x.revision]);
const contentSource=x=>`content:${x.id}@${x.revision}`;
const unknownCare=()=>({known:false,reason:'No established host personal-care prior for this person',sources:[]});
const scopeFor=(subject,c)=>({subject,other:c.other_id,dimension:c.dimension,criterion:c.id,criterion_revision:String(c.revision)});

/** Extends only the opt-in native configuration. No native statistics_pairs
 * membership declaration is added or substituted for the existing criterion pair. */
export function createDailyRelationRuntimeConfig(config,namespace,subject){
  ns(namespace);text(subject,'subject');exact(config,['general_welfare_value','parameters','criteria'],'config');
  signal(config.general_welfare_value,'config.general_welfare_value');
  exact(config.parameters,['general_welfare_gain','affiliation_gain','reliability_sample_weight'],'config.parameters');
  for(const k of ['general_welfare_gain','affiliation_gain'])need(typeof config.parameters[k]==='number'&&Number.isFinite(config.parameters[k])&&config.parameters[k]>=0&&config.parameters[k]<=1,'DAILY_RELATION_PARAMETER','config.parameters.'+k);
  need(config.parameters.reliability_sample_weight===1,'DAILY_RELATION_SAMPLE_POLICY','config.parameters');
  const seen=new Set(),identities=new Map();
  for(const [i,c]of array(config.criteria,'config.criteria').entries()){
    const p='config.criteria.'+i;exact(c,['id','revision','other_id','dimension','statement'],p);ref({id:c.id,revision:c.revision},p);
    for(const k of ['other_id','dimension','statement'])text(c[k],p+'.'+k);need(c.other_id!==subject,'DAILY_RELATION_SELF',p);
    need(!seen.has(refId(c)),'DAILY_RELATION_CRITERION_DUPLICATE',p);seen.add(refId(c));
    const identity={other_id:c.other_id,dimension:c.dimension};
    need(!identities.has(c.id)||same(identities.get(c.id),identity),'DAILY_RELATION_CRITERION_IDENTITY',p);identities.set(c.id,identity);
  }
  const identity=fingerprint({schema:'asuka.daily-relation-runtime-config/1',namespace,subject,config});
  const state_fields={[SUM]:{type:'probability_sum',scope:[...SCOPE],statistics_pair:PAIR},[MASS]:{type:'probability_mass',scope:[...SCOPE],statistics_pair:PAIR}};
  return {schema:'asuka.daily-relation-runtime-config/1',identity,config:clone(config),namespace:clone(namespace),subject,
    catalog:createDailyRelationsCatalog(),state_fields,
    definitions:[SUM,MASS].map(id=>({id,scope:[...SCOPE],initial:0,baseline:0,anchor_time:0,half_life:null,bounds:[0,1]})),
    configuration_sources:[...new Set(['configuration:'+identity,'configuration:daily-general-welfare-context/1',...config.general_welfare_value.sources])],
    policy:{id:'unit-observed-outcome-v1',weight:1,outcomes:[0,1],new_occurrences_only:true,pair_id:PAIR,
      meaning:'Frequency for one actor/dimension/exact criterion; not personal care, agreement, intimacy or a future guarantee.'},
    persisted:false};
}

/** results carry trusted structured actor annotations, not inferred language.
 * selectors are exact criterion refs only. The host owns priors and contents;
 * neither history aggregates nor next_sum/next_mass are accepted from a caller. */
export function buildDailyRelationRuntimeProgram(raw,context){
  exact(raw,['namespace','subject','input_id','config','views','results','selectors'],'program');text(raw.input_id,'input_id');
  const extension=createDailyRelationRuntimeConfig(raw.config,raw.namespace,raw.subject);
  exact(context,['contents','personal_care_priors'],'context');need(object(context.personal_care_priors),'DAILY_RELATION_PRIOR_MAP','context.personal_care_priors');
  for(const [other,prior]of Object.entries(context.personal_care_priors)){text(other,'context.personal_care_priors');need(other!==raw.subject,'DAILY_RELATION_SELF','context.personal_care_priors');signal(prior,'context.personal_care_priors.'+other);}
  const contents=applyContentChanges(context.contents,[],raw.namespace).records;
  const criteria=new Map(raw.config.criteria.map(c=>[refId(c),c]));
  const getCriterion=(r,p)=>{ref(r,p);const c=criteria.get(refId(r));need(c,'DAILY_RELATION_CRITERION_UNKNOWN',p);return c;};
  const views=array(raw.views,'views').map((v,i)=>{
    const p='views.'+i;exact(v,['id','other_id',...VIEW_FIELDS],p);text(v.id,p);text(v.other_id,p);
    return {...clone(v),general_welfare_value:clone(raw.config.general_welfare_value),
      personal_care:own(context.personal_care_priors,v.other_id)?clone(context.personal_care_priors[v.other_id]):unknownCare()};
  });
  const viewBundle=views.length?buildDailyRelations({namespace:raw.namespace,subject:raw.subject,relations:views,reliability:[],parameters:raw.config.parameters}):null;
  const catalog=extension.catalog,request=viewBundle?clone(viewBundle.request):{namespace:clone(raw.namespace),instances:[],bindings:[]};
  request.state_fields=clone(extension.state_fields);
  const outputs=viewBundle?clone(viewBundle.outputs):{},nativeTargets=new Map(),experiences=[],source_records=[],selectors=[];
  const addTargets=scope=>{for(const mechanism of [SUM,MASS]){const t={mechanism,scope:clone(scope)};nativeTargets.set(fingerprint(t),t);}};
  const resultKeys=new Set();
  for(const [i,r]of array(raw.results,'results').entries()){
    const p='results.'+i;exact(r,['criterion_ref','fact_ref','actor_id','outcome'],p);const c=getCriterion(r.criterion_ref,p+'.criterion_ref');ref(r.fact_ref,p+'.fact_ref');text(r.actor_id,p+'.actor_id');
    need(r.actor_id===c.other_id,'DAILY_RELATION_ACTOR_MISMATCH',p);need(r.outcome===0||r.outcome===1,'DAILY_RELATION_BINARY_OUTCOME',p+'.outcome');
    const record=contents.find(x=>x.id===r.fact_ref.id),version=record?.history.find(x=>x.revision===r.fact_ref.revision);
    need(record?.kind==='fact'&&record.owner_id===raw.subject&&version,'DAILY_RELATION_FACT_REQUIRED',p+'.fact_ref');
    const b=version.body,scope=scopeFor(raw.subject,c),actorScope={subject:raw.subject,actor:r.actor_id,event:b.occurrence_id};
    need(b.occurrence_status==='completed'&&['observed','reported','self_report'].includes(b.epistemic_status),'DAILY_RELATION_ACTUAL_RESULT_REQUIRED',p);
    need(b.presentation==='current_report'&&b.observation_id===raw.input_id&&b.novelty==='new_evidence','DAILY_RELATION_CURRENT_NEW_RESULT_REQUIRED',p);
    need(version.source_refs.includes(raw.input_id),'DAILY_RELATION_OBSERVATION_SOURCE_REQUIRED',p);
    need(b.instance_refs?.some(x=>same(x,{subject:raw.subject,other:c.other_id}))&&b.instance_refs.some(x=>same(x,scope)),
      'DAILY_RELATION_RESULT_SCOPE',p);
    need(b.instance_refs.some(x=>same(x,actorScope)),'DAILY_RELATION_ACTOR_SCOPE',p);
    const sampleKey=fingerprint({scope,event:b.occurrence_id});need(!resultKeys.has(sampleKey),'DAILY_RELATION_RESULT_DUPLICATE',p);resultKeys.add(sampleKey);
    const source_refs=[...new Set([contentSource(r.fact_ref),...version.source_refs])];
    const sample={kind:'observed_outcome_record',occurrence_id:b.occurrence_id,meaning_id:'daily-relation-result:'+fingerprint(scope),interpretation_revision:1,
      observation_id:b.observation_id,mode:'new_occurrence_effect',at:null,outcome:{known:true,value:r.outcome,sources:clone(source_refs)},
      weight:{known:true,value:1,sources:clone(source_refs)},source_refs};
    experiences.push({fact_ref:clone(r.fact_ref),pair:{id:PAIR,sum:SUM,mass:MASS,scope:clone(scope)},sample});addTargets(scope);
    source_records.push({criterion_ref:clone(r.criterion_ref),criterion_statement:c.statement,actor_id:r.actor_id,outcome:r.outcome,scope,
      fact:{id:record.id,kind:record.kind,owner_id:record.owner_id,namespace:clone(record.namespace),version:clone(version)},
      actor_binding:'trusted_structured_annotation_not_natural_language_verification'});
  }
  const selected=new Set();
  for(const [i,r]of array(raw.selectors,'selectors').entries()){
    const c=getCriterion(r,'selectors.'+i),scope=scopeFor(raw.subject,c),key=refId(r);need(!selected.has(key),'DAILY_RELATION_SELECTOR_DUPLICATE','selectors.'+i);selected.add(key);
    const id='daily-relation-history:'+fingerprint(scope);
    const inputs=Object.fromEntries([['sum',SUM,'probability_sum'],['mass',MASS,'probability_mass']].map(([field,mechanism,type])=>[field,
      {state:{mechanism,scope:clone(scope),view:'latent'},type,statistics_pair:PAIR}]));
    request.instances.push({id,recipe:'daily_relation_frequency',scope:clone(scope),inputs,parameters:{}});addTargets(scope);
    for(const field of ['history','sum','mass'])outputs[JSON.stringify([id,field])]={instance:id,field};
    selectors.push({criterion_ref:clone(r),scope,instance:id,outputs:{history:{instance:id,field:'history'},sum:{instance:id,field:'sum'},mass:{instance:id,field:'mass'}}});
  }
  if(request.instances.length)compileAssembly(request,catalog);
  return {catalog,request,outputs,instances:[...nativeTargets.values()],experiences,
    metadata:{schema:'asuka.daily-relation-runtime-program/1',configuration_identity:extension.identity,source_observation_id:raw.input_id,
      program_sha256:fingerprint(raw),shared_general_welfare:clone(viewBundle?.metadata.shared_general_welfare??{subject:raw.subject,signal:raw.config.general_welfare_value}),
      selectors,source_records,care_learning:false,parameters:clone(raw.config.parameters),parameter_status:'unfitted_engineering_candidate',
      assembly_required:request.instances.length>0,persisted:false,native_executed:false,semantic_review:'not_performed',
      interpretation:'Apply experiences exactly once in the host candidate, then read its latent S/N. No aggregate is added a second time.',
      limitations:['Structured annotations and exact scope prove the chosen binding, not the truth of source language.',
        'Private care and general welfare are read-only; reliability changes only the declared actor/dimension/criterion frequency.',
        'No correction, membership, clock, interruption or administrative review mechanism is added.']}};
}
