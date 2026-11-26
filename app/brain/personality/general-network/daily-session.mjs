// Restricted opt-in assembly for the existing durable runtime. No new storage,
// scheduler, language interpretation, or arbitrary state/delta input is exposed.
import {hasPersonalCareBasis} from './personal-content-state.mjs';
import {fingerprint} from './assembly-identity.mjs';
import {createDailyRuntimeConfig,dailyRuntimePlan} from './daily-runtime.mjs';
import {createDailyRelationRuntimeConfig,buildDailyRelationRuntimeProgram} from './daily-relation-runtime.mjs';
import {buildDailyGoals,createDailyGoalsCatalog} from './daily-goals.mjs';
import {compileDailyDynamics} from './daily-dynamics.mjs';

const clone=structuredClone,object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const need=(yes,code)=>{if(!yes)throw Object.assign(new Error(code),{code});};
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const exact=(x,keys)=>need(object(x)&&keys.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>keys.includes(k)),'DAILY_SESSION_FIELDS');
export function mergeDailyCatalogs(...catalogs){
  const merged={schema:'asuka.general-recipes/1',types:{},recipes:[]},recipes=new Map();
  for(const c of catalogs){need(c?.schema===merged.schema,'DAILY_SESSION_CATALOG');
    for(const [id,t]of Object.entries(c.types)){need(!merged.types[id]||same(merged.types[id],t),'DAILY_SESSION_TYPE_CONFLICT');merged.types[id]=clone(t);}
    for(const r of c.recipes){need(!recipes.has(r.id)||same(recipes.get(r.id),r),'DAILY_SESSION_RECIPE_CONFLICT');recipes.set(r.id,clone(r));}}
  merged.recipes=[...recipes.values()];return merged;
}
export function createDailySessionConfig(raw,namespace,subject){
  exact(raw,['schema','activity','relations','goal_parameters','personal_care_priors']);need(raw.schema==='asuka.daily-session/1','DAILY_SESSION_SCHEMA');
  need(raw.activity?.subject===subject,'DAILY_SESSION_SUBJECT');
  const activity=createDailyRuntimeConfig(raw.activity),relations=createDailyRelationRuntimeConfig(raw.relations,namespace,subject);
  exact(raw.goal_parameters,['value_scale']);need(Number.isFinite(raw.goal_parameters.value_scale)&&raw.goal_parameters.value_scale>=0,'DAILY_SESSION_GOAL_SCALE');
  need(object(raw.personal_care_priors),'DAILY_SESSION_PRIORS');
  const priorSources=[];for(const [other,s]of Object.entries(raw.personal_care_priors)){
    need(other&&other!==subject&&s?.known===true&&Number.isFinite(s.value)&&s.value>=0&&s.value<=1&&Array.isArray(s.sources)&&s.sources.length>0&&s.sources.every(x=>typeof x==='string'&&x.trim()),'DAILY_SESSION_PRIOR');priorSources.push(...s.sources);
  }
  const config=clone({...raw,activity:activity.config});
  return {config,catalog:mergeDailyCatalogs(activity.catalog,relations.catalog,createDailyGoalsCatalog()),definitions:[...activity.definitions,...relations.definitions],
    state_fields:{...activity.state_fields,...relations.state_fields},configuration_sources:[...new Set([
      'configuration:daily-session:'+fingerprint(config),...activity.configuration_sources,...relations.configuration_sources,...priorSources,
      'configuration:daily-goals:'+fingerprint(config.goal_parameters)])]};
}
export function buildDailySessionPlan({config,namespace,subject,input_id,program,numeric,contents,effect_policy,personal_state_head=null}){
  const extension=createDailySessionConfig(config,namespace,subject);
  exact(program,['schema','activity','relations','goals']);need(program.schema==='asuka.daily-session-program/1','DAILY_SESSION_PROGRAM_SCHEMA');
  exact(program.relations,['views','results','selectors']);need(Array.isArray(program.goals),'DAILY_SESSION_GOALS');
  const a=dailyRuntimePlan({config:extension.config.activity,namespace,input_id,program:program.activity,numeric,...(effect_policy===undefined?{}:{effect_policy})});
  const r=buildDailyRelationRuntimeProgram({config:extension.config.relations,namespace,subject,input_id,...program.relations},
    {contents,personal_care_priors:extension.config.personal_care_priors});
  if(personal_state_head!==null){
    // Relationship feedback reads the same current care owner as ordinary
    // turns. Frozen priors cannot mask an independently established change.
    for(const node of r.request.instances.filter(node=>node.recipe==='daily_personal_care')){
      const other=node.scope.other,prior=extension.config.personal_care_priors[other];
      if(!hasPersonalCareBasis({namespace,subject,other,head:personal_state_head,prior}))continue;
      node.inputs.care={type:'care_level',state:{mechanism:'model.care',scope:clone(node.scope),view:'value'}};
      r.instances.push({mechanism:'model.care',scope:clone(node.scope)});
      extension.state_fields['model.care']={type:'care_level',scope:['subject','other']};
      r.request.state_fields['model.care']=clone(extension.state_fields['model.care']);
    }
    r.metadata.personal_care_source='current_native_state_with_explicit_basis';
  }
  const bundles=[a,r].filter(b=>b.request.instances.length>0);
  if(program.goals.length)bundles.push(buildDailyGoals({namespace,subject,goals:program.goals},extension.config.goal_parameters));
  const compiled=bundles.length?compileDailyDynamics(namespace,bundles,{state_fields:extension.state_fields}):null;
  const instances=[...new Map([...a.instances,...r.instances].map(x=>[fingerprint(x),x])).values()];
  return {assembly:compiled?.assembly??null,outputs:compiled?.outputs??{},catalog:compiled?.catalog??extension.catalog,
    instances,experiences:r.experiences,interval_transitions:a.interval_transitions,
    scene_time:program.activity.interval?.end??null,
    metadata:{schema:'asuka.daily-session-plan/1',configuration_sha256:fingerprint(extension.config),program_sha256:fingerprint(program),
      activity:a.metadata,relations:r.metadata,goals:compiled?.metadata.filter(x=>x.schema==='asuka.daily-goals/1')??[],
      note:'Known actual interval and result updates; plans and control-capacity readouts have no state effects.'},
    derived_sources:program.goals.map(g=>'goal:'+g.id)};
}
