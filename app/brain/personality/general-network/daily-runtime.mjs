// Pure constrained daily interval adapter. Native owns prior state and the
// interval equations; the durable host authenticates receipts and commits.
import {buildDailyActivity,createDailyActivityCatalog,validateDailyActivityParameters} from './daily-activity.mjs';
import {compileAssembly} from './assembly-compiler.mjs';
import {fingerprint} from './assembly-identity.mjs';

const clone=structuredClone,object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),same=(a,b)=>fingerprint(a)===fingerprint(b);
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const text=x=>{need(typeof x==='string'&&x.trim()&&!x.includes('\0'),'DAILY_RUNTIME_TEXT');return x;};
function exact(x,keys){need(object(x)&&keys.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>keys.includes(k)),'DAILY_RUNTIME_FIELDS');}
function array(x){need(Array.isArray(x),'DAILY_RUNTIME_ARRAY');return x;}
function sources(x){const a=array(x).map(text);need(a.length>0,'DAILY_RUNTIME_SOURCES');return [...new Set(a)];}
function signal(x){
  need(object(x)&&typeof x.known==='boolean','DAILY_RUNTIME_SIGNAL');exact(x,x.known?['known','value','sources']:['known','reason','sources']);
  const s=sources(x.sources);if(!x.known){text(x.reason);return {known:false,reason:x.reason,sources:s};}
  need(typeof x.value==='number'&&Number.isFinite(x.value)&&x.value>=0&&x.value<=1,'DAILY_RUNTIME_SIGNAL_DOMAIN');return {known:true,value:x.value,sources:s};
}
const FIELDS={engagement:{id:'daily.engagement',type:'engagement_level',scope:['subject','activity'],kind:'attention'},
 satiation:{id:'daily.satiation',type:'satiation_level',scope:['subject','activity'],kind:'exposure'},
 fatigue:{id:'daily.fatigue',type:'daily_task_fatigue',scope:['subject'],kind:'fatigue'}};
const input=name=>({input:name}),step=id=>({step:id}),constant=(value,type)=>({constant:value,type});
const port=type=>({accepts:[type],optional:false,allow_cross_scope:true});
const op=(id,operator,type,inputs,params={})=>({id,op:operator,type,inputs,params});
const identity=(id,type,from)=>op(id,'weighted_sum',type,[from],{weights:[1],bias:0});
function runtimeCatalog(){
  const c=createDailyActivityCatalog({zero_elapsed:true,mode:'active'});
  c.types.daily_control_retention={unit:'ratio',quantity:'control_retention',temporal_role:'level',domain:[0,1]};
  for(const affected of [true,false]){
    const steps=[identity('baseline','control_capacity',input('baseline')),
      affected?op('loss','weighted_sum','daily_control_retention',[input('fatigue')],{weights:[{parameter:'sensitivity'}],bias:0}):identity('loss','daily_control_retention',constant(0,'daily_control_retention')),
      op('retention','positive_gap','daily_control_retention',[constant(1,'daily_control_retention'),step('loss')]),
      affected?op('capacity','product','control_capacity',[input('baseline'),step('retention')]):identity('capacity','control_capacity',input('baseline'))];
    c.recipes.push({id:'daily_runtime_control_'+(affected?'affected':'unaffected'),mechanism:'C.resources',stage:'activation_field',scope:['subject','event','strategy'],
      inputs:{baseline:port('control_capacity'),...(affected?{fatigue:port('daily_task_fatigue')}:{})},parameters:affected?{sensitivity:{min:0,max:1}}:{},
      parameter_constraints:[],steps,outputs:{baseline:'baseline',loss:'loss',retention:'retention',capacity:'capacity'},product_steps:affected?['capacity']:[],
      purpose:'未计疲劳的特定控制基线，经过该profile显式敏感度形成只读有效容量；不覆盖当前控制观测。',
      limitations:['固定工程映射，不表示疲劳消耗所有控制资源。','不同profile不能因共用subject而共享敏感度或改写基线。']});
  }
  return c;
}

export function createDailyRuntimeConfig(raw){
  exact(raw,['schema','subject','activity_parameters','control_profiles']);need(raw.schema==='asuka.daily-runtime/1','DAILY_RUNTIME_SCHEMA');text(raw.subject);
  const config={schema:raw.schema,subject:raw.subject,activity_parameters:validateDailyActivityParameters(raw.activity_parameters),control_profiles:[]},seen=new Set();
  for(const p of array(raw.control_profiles)){
    exact(p,['id','baseline_capacity','fatigue_sensitivity']);text(p.id);need(!seen.has(p.id),'DAILY_CONTROL_PROFILE_DUPLICATE');seen.add(p.id);
    need(typeof p.fatigue_sensitivity==='number'&&Number.isFinite(p.fatigue_sensitivity)&&p.fatigue_sensitivity>=0&&p.fatigue_sensitivity<=1,'DAILY_CONTROL_SENSITIVITY');
    config.control_profiles.push({id:p.id,baseline_capacity:signal(p.baseline_capacity),fatigue_sensitivity:p.fatigue_sensitivity});
  }
  const configuration_source='configuration:daily-runtime:'+fingerprint(config),definitions=[],state_fields={};
  for(const [name,f]of Object.entries(FIELDS)){
    state_fields[f.id]={type:f.type,scope:[...f.scope]};
    definitions.push({id:f.id,scope:[...f.scope],initial:0,baseline:0,anchor_time:0,half_life:null,bounds:[0,1],
      interval_dynamics:{kind:f.kind,half_life_seconds:config.activity_parameters[name+'_half_life_seconds']}});
  }
  return {config,catalog:runtimeCatalog(),definitions,state_fields,configuration_sources:[...new Set([configuration_source,...config.control_profiles.flatMap(p=>p.baseline_capacity.sources)])]};
}

/** program = {interval:null|oneActualInterval, activities:[{activity_id,inputs}],
 * controls:[{profile_id,event_id,strategy_id,cost,applicable}]}. No prior/delta.
 * numeric is used for namespace validation only; values are native state refs. */
export function dailyRuntimePlan(raw){
  exact(raw,['config','namespace','input_id','program','numeric',...(Object.hasOwn(raw??{},'effect_policy')?['effect_policy']:[])]);
  const {config:rawConfig,namespace,input_id,program,numeric}=raw;
  let policy=null;
  if(Object.hasOwn(raw,'effect_policy')){
    exact(raw.effect_policy,['schema','fatigue','satiation','source_refs']);
    need(raw.effect_policy.schema==='asuka.daily-effect-policy/1'&&typeof raw.effect_policy.fatigue==='boolean'&&typeof raw.effect_policy.satiation==='boolean','DAILY_EFFECT_POLICY');
    policy={schema:raw.effect_policy.schema,fatigue:raw.effect_policy.fatigue,satiation:raw.effect_policy.satiation,source_refs:sources(raw.effect_policy.source_refs)};
  }
  const built=createDailyRuntimeConfig(rawConfig),config=built.config,subject=config.subject;
  exact(namespace,['character_version','conversation_id','world_id']);Object.values(namespace).forEach(text);text(input_id);
  need(numeric?.schema==='asuka.general-kernel-state/1'&&same(numeric.namespace,namespace)&&Number.isSafeInteger(numeric.revision)&&numeric.revision>=0&&Array.isArray(numeric.cells),
    'DAILY_RUNTIME_NUMERIC_SNAPSHOT');
  exact(program,['interval','activities','controls']);const p=clone(program),catalog=built.catalog;
  const request={namespace:clone(namespace),instances:[],bindings:[],state_fields:clone(built.state_fields)},targets=new Map(),outputs={},interval_transitions=[];
  const configSource=built.configuration_sources[0],id=(...parts)=>JSON.stringify(['daily-runtime',subject,...parts]);
  const disabled=name=>policy!==null&&Object.hasOwn(policy,name)&&policy[name]===false;
  const neutral=()=>({known:true,value:0,sources:[...policy.source_refs]});
  const target=(name,activity)=>({mechanism:FIELDS[name].id,scope:name==='fatigue'?{subject}:{subject,activity}});
  function state(name,activity){const t=target(name,activity);targets.set(fingerprint(t),t);return {type:FIELDS[name].type,state:{...clone(t),view:'value'}};}
  function mergeCatalog(other){
    for(const [key,value]of Object.entries(other.types)){need(!catalog.types[key]||same(catalog.types[key],value),'DAILY_RUNTIME_TYPE_CONFLICT');catalog.types[key]=clone(value);}
    for(const r of other.recipes){const before=catalog.recipes.find(x=>x.id===r.id);need(!before||same(before,r),'DAILY_RUNTIME_RECIPE_CONFLICT');if(!before)catalog.recipes.push(clone(r));}
  }
  if(p.interval!==null){
    const v=p.interval;exact(v,['interval_id','activity_id','start','end','mode','attention','exposure','exertion','source_refs']);text(v.interval_id);text(v.activity_id);
    need(typeof v.start==='number'&&Number.isFinite(v.start)&&v.start>=0&&typeof v.end==='number'&&Number.isFinite(v.end)&&v.end>=v.start,'DAILY_RUNTIME_INTERVAL_TIME');
    need(['active','rest'].includes(v.mode),'DAILY_RUNTIME_INTERVAL_MODE');const refs=sources(v.source_refs);need(refs.includes(input_id),'DAILY_RUNTIME_INTERVAL_RECEIPT');
    for(const [name,field]of [['engagement','attention'],['satiation','exposure'],['fatigue','exertion']]){
      const driver=signal(v[field]);
      need(driver.sources.every(s=>refs.includes(s)),'DAILY_RUNTIME_INTERVAL_DRIVER_SOURCE');
      if(disabled(name))continue;
      need(driver.known,'DAILY_RUNTIME_INTERVAL_DRIVER_UNKNOWN');need(v.mode!=='rest'||driver.value===0,'DAILY_RUNTIME_REST_DRIVER');
      const t=target(name,v.activity_id);targets.set(fingerprint(t),t);
      interval_transitions.push({target:clone(t),interval_id:v.interval_id,observation_id:input_id,start:v.start,end:v.end,mode:v.mode,driver,sources:[...refs]});
    }
  }
  const activityIds=new Set(),activities=[];let rawFatigueSelector=null;
  for(const view of array(p.activities)){
    exact(view,['activity_id','inputs']);text(view.activity_id);need(!activityIds.has(view.activity_id),'DAILY_RUNTIME_ACTIVITY_DUPLICATE');activityIds.add(view.activity_id);
    const zero={known:true,value:0,sources:[configSource]};
    const b=buildDailyActivity({namespace:clone(namespace),subject,activity_id:view.activity_id,
      interval:{id:'state-read:'+input_id,mode:'active',elapsed_seconds:zero,source_refs:[configSource]},
      state:{engagement:zero,satiation:zero,fatigue:zero},inputs:view.inputs,parameters:config.activity_parameters});
    mergeCatalog(b.catalog);
    for(const instance of b.request.instances){
      for(const name of Object.keys(FIELDS)){
        if(instance.id===b.outputs[JSON.stringify([view.activity_id,'next_state',name])].instance)instance.inputs.previous=state(name,view.activity_id);
        if(instance.recipe==='daily_activity_view_current')instance.inputs[name]=state(name,view.activity_id);
        if(disabled(name)&&['daily_activity_view_current','daily_activity_view_after'].includes(instance.recipe))
          instance.inputs[name]={type:FIELDS[name].type,scope:clone(target(name,view.activity_id).scope),signal:neutral()};
      }
    }
    // The disabled quantity is a policy-neutral effect, not a zero observation
    // of the stored state. Keep its explicit source binding in both views.
    if(policy)for(const binding of b.request.bindings){
      const to=b.request.instances.find(i=>i.id===binding.to.instance);
      if(disabled(binding.to.input)&&['daily_activity_view_current','daily_activity_view_after'].includes(to?.recipe)){
        binding.from={external:{instance:to.id,input:binding.to.input}};binding.evidence_refs=[...policy.source_refs];
      }
    }
    request.instances.push(...b.request.instances);request.bindings.push(...b.request.bindings);
    for(const [key,selector]of Object.entries(b.outputs)){
      const [,group,field]=JSON.parse(key);if(group==='current')outputs[key]=clone(selector);
      else if(group==='next_state')outputs[JSON.stringify([view.activity_id,'state',field])]=clone(selector);
    }
    rawFatigueSelector??=clone(b.outputs[JSON.stringify([view.activity_id,'next_state','fatigue'])]);
    if(policy)for(const name of Object.keys(FIELDS)){
      const rawSelector=b.outputs[JSON.stringify([view.activity_id,'next_state',name])];let selector=clone(rawSelector);
      if(disabled(name)){
        // Existing zero-duration identity recipe: no new catalog/config and
        // no multiplication by a possibly Unknown raw state.
        const effective=clone(b.request.instances.find(i=>i.id===rawSelector.instance));
        effective.id=id('effective-state',view.activity_id,name);effective.inputs.previous={type:FIELDS[name].type,scope:clone(target(name,view.activity_id).scope),signal:neutral()};
        request.instances.push(effective);selector.instance=effective.id;
      }
      outputs[JSON.stringify([view.activity_id,'effective_state',name])]=selector;
    }
    activities.push({activity_id:view.activity_id,state_refs:Object.fromEntries(Object.keys(FIELDS).map(k=>[k,target(k,view.activity_id)])),
      state_source:'native_candidate_snapshot',formula_version:b.metadata.dynamics_version,zero_duration_read:true});
  }
  function literal(type,scope,s){return {type,scope:clone(scope),signal:clone(s)};}
  function bindExternal(instance,input,scope,refs){if(same(scope,instance.scope))return;
    request.bindings.push({id:id('binding',instance.id,input),from:{external:{instance:instance.id,input}},to:{instance:instance.id,input},source_scope:clone(scope),target_scope:clone(instance.scope),evidence_refs:[...new Set(refs)]});}
  const controlIds=new Set(),controls=[];
  for(const view of array(p.controls)){
    exact(view,['profile_id','event_id','strategy_id','cost','applicable']);for(const key of ['profile_id','event_id','strategy_id'])text(view[key]);
    const key=JSON.stringify([view.event_id,view.strategy_id]);need(!controlIds.has(key),'DAILY_RUNTIME_CONTROL_DUPLICATE');controlIds.add(key);
    const profile=config.control_profiles.find(p=>p.id===view.profile_id);need(profile,'DAILY_RUNTIME_CONTROL_PROFILE_UNKNOWN');
    const scope={subject,event:view.event_id,strategy:view.strategy_id},profileScope={subject,control_profile:profile.id},person={subject};
    const baseline={...clone(profile.baseline_capacity),sources:[...new Set([...profile.baseline_capacity.sources,configSource])]},affected=profile.fatigue_sensitivity!==0&&!disabled('fatigue');
    const bridge={id:id('capacity',profile.id,view.event_id,view.strategy_id),recipe:'daily_runtime_control_'+(affected?'affected':'unaffected'),scope,
      inputs:{baseline:literal('control_capacity',profileScope,baseline),...(affected?{fatigue:state('fatigue')}: {})},parameters:affected?{sensitivity:profile.fatigue_sensitivity}:{}};
    bindExternal(bridge,'baseline',profileScope,baseline.sources);if(affected)bindExternal(bridge,'fatigue',person,[configSource]);request.instances.push(bridge);
    const conditions={id:id('strategy',view.event_id,view.strategy_id),recipe:'strategy_conditions',scope:clone(scope),parameters:{},
      inputs:{capacity:{output:{instance:bridge.id,field:'capacity'}},cost:literal('control_cost',scope,signal(view.cost)),applicable:literal('applicability_gate',scope,signal(view.applicable))}};
    request.instances.push(conditions);
    for(const [field,out]of [['baseline_capacity','baseline'],['fatigue_loss','loss'],['retention','retention'],['effective_capacity','capacity']])
      outputs[JSON.stringify(['control',view.profile_id,view.event_id,view.strategy_id,field])]={instance:bridge.id,field:out};
    for(const field of ['margin','fit'])outputs[JSON.stringify(['control',view.profile_id,view.event_id,view.strategy_id,field])]={instance:conditions.id,field};
    if(policy){
      if(!rawFatigueSelector){
        const rawView={id:id('raw-fatigue'),recipe:'daily_activity_next_fatigue_active_zero',scope:clone(person),
          parameters:{half_life_seconds:config.activity_parameters.fatigue_half_life_seconds},
          inputs:{previous:state('fatigue'),elapsed:literal('daily_elapsed_seconds',person,neutral())}};
        request.instances.push(rawView);rawFatigueSelector={instance:rawView.id,field:'next',type:FIELDS.fatigue.type,scope:clone(person)};
      }
      outputs[JSON.stringify(['control',view.profile_id,view.event_id,view.strategy_id,'raw_fatigue'])]=clone(rawFatigueSelector);
      let effective=clone(rawFatigueSelector);
      if(disabled('fatigue')){
        const rawView=request.instances.find(i=>i.id===rawFatigueSelector.instance),neutralView=clone(rawView);
        neutralView.id=id('effective-control-fatigue',view.profile_id,view.event_id,view.strategy_id);
        neutralView.inputs.previous=literal(FIELDS.fatigue.type,person,neutral());request.instances.push(neutralView);effective.instance=neutralView.id;
      }
      outputs[JSON.stringify(['control',view.profile_id,view.event_id,view.strategy_id,'effective_fatigue'])]=effective;
    }
    controls.push({profile_id:profile.id,scope:clone(scope),baseline_is_unfatigued_configuration:true,fatigue_sensitive:affected,
      derived_only:true,does_not_override:'model.control',does_not_add_to_activity_exit_burden:true});
  }
  const assembly=request.instances.length?compileAssembly(request,catalog):null;
  const result={catalog,request,assembly,instances:[...targets.values()],interval_transitions,outputs,metadata:{schema:'asuka.daily-runtime-plan/1',subject,namespace:clone(namespace),
    input_id,configuration_sha256:fingerprint(config),configuration_sources:clone(built.configuration_sources),configuration_sources_are_not_facts:true,
    source_base_revision:numeric.revision,interval:p.interval===null?null:{interval_id:p.interval.interval_id,activity_id:p.interval.activity_id,start:p.interval.start,end:p.interval.end,mode:p.interval.mode},
    activities,controls,persisted:false,native_executed:false,requires_atomic_host_commit:true,
    limitations:['Fresh isolated zero initialization is an engineering configuration, not observed rest or a migration of old state.',
      'Only one explicitly observed interval is accepted; no timer, gap recovery, concurrency allocator or automatic interruption exists.',
      'Caller cannot provide prior/delta; views read native state and intervals are reduced by the configured native kernel.',
      'Effective capacity is specific to the selected control profile. Current model.control observations are neither used as an unfatigued baseline nor overwritten.',
      'Fatigue loss is not added again to the existing daily exit burden; no joint decision score or emotional effect is written.']}};
  if(policy){
    result.metadata.effect_policy=clone(policy);
    result.metadata.effect_policy_sha256=fingerprint(policy);
    result.metadata.disabled_effects=['fatigue','satiation'].filter(disabled);
    result.metadata.state_output_semantics={state:'raw_native_candidate_state_for_debug',effective_state:'policy_conditioned_effect_not_a_raw_state_observation'};
    result.metadata.interval_updates_skipped=['satiation','fatigue'].filter(disabled);
    result.metadata.reenabled_policy='Only future explicit actual intervals update the retained state; disabled gaps are not reconstructed.';
    result.metadata.policy_sources_require_host_authentication=true;
  }
  return result;
}
