// Engine-only, explicit numerical scenario. It creates a private typed catalog
// and read-only request, never a psychological write or a language admission.
import {catalog as baseCatalog} from './catalog.mjs';
import {compileAssembly} from './assembly-compiler.mjs';
import {fingerprint} from './assembly-identity.mjs';

const clone=structuredClone,object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
function exact(x,keys){need(object(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k)),'DAILY_ACTIVITY_FIELDS');}
function text(x){need(typeof x==='string'&&x.trim()&&!x.includes('\0'),'DAILY_ACTIVITY_TEXT');}
function refs(x){need(Array.isArray(x)&&x.length>0,'DAILY_ACTIVITY_SOURCES');x.forEach(text);return [...new Set(x)];}
function signal(raw,{seconds=false}={}){
  need(object(raw)&&typeof raw.known==='boolean','DAILY_ACTIVITY_SIGNAL');exact(raw,raw.known?['known','value','sources']:['known','reason','sources']);
  const sources=refs(raw.sources);
  if(raw.known){need(typeof raw.value==='number'&&Number.isFinite(raw.value)&&raw.value>=0&&(seconds||raw.value<=1),'DAILY_ACTIVITY_DOMAIN');return {known:true,value:raw.value,sources};}
  text(raw.reason);return {known:false,reason:raw.reason,sources};
}
const INPUT_TYPES={familiar_interest:'familiar_interest',present_appeal:'intrinsic_appeal',outcome_desire:'outcome_desire',
  experienced_enjoyment:'experienced_enjoyment',enacted_attention:'daily_enacted_attention',repeated_exposure:'daily_repeated_exposure',
  exertion:'daily_exertion',external_cost:'daily_external_cost'};
const STATE_TYPES={engagement:'engagement_level',satiation:'satiation_level',fatigue:'daily_task_fatigue'};
const WEIGHTS=['attraction_familiar_weight','attraction_present_weight','motivation_attraction_weight','motivation_desire_weight',
  'continue_motivation_weight','continue_engagement_weight','continue_enjoyment_weight','burden_cost_weight','burden_fatigue_weight'];
const HALVES=['engagement_half_life_seconds','satiation_half_life_seconds','fatigue_half_life_seconds'];
export const DAILY_ACTIVITY_PARAMETERS=Object.freeze([...WEIGHTS,...HALVES]);
const groups=[['attraction_familiar_weight','attraction_present_weight'],['motivation_attraction_weight','motivation_desire_weight'],
  ['continue_motivation_weight','continue_engagement_weight','continue_enjoyment_weight'],['burden_cost_weight','burden_fatigue_weight']];
export function validateDailyActivityParameters(raw){
  exact(raw,DAILY_ACTIVITY_PARAMETERS);
  for(const k of WEIGHTS)need(typeof raw[k]==='number'&&Number.isFinite(raw[k])&&raw[k]>=0&&raw[k]<=1,'DAILY_ACTIVITY_WEIGHT');
  for(const keys of groups)need(keys.reduce((sum,k)=>sum+raw[k],0)<=1+1e-12,'DAILY_ACTIVITY_WEIGHT_SUM');
  for(const k of HALVES)need(typeof raw[k]==='number'&&Number.isFinite(raw[k])&&raw[k]>0,'DAILY_ACTIVITY_HALF_LIFE');
  return clone(raw);
}
const port=t=>({accepts:[t],optional:false,allow_cross_scope:true}),input=name=>({input:name}),step=name=>({step:name}),param=name=>({parameter:name});
const weighted=(id,type,inputs,weights)=>({id,op:'weighted_sum',type,inputs,params:{weights,bias:0}});
const identity=(id,type,source)=>weighted(id,type,[source],[1]);
const recipe=(id,scope,inputs,parameters,steps,outputs,stage='dynamic_transformation',extra={})=>({id,mechanism:'M.daily_activity_candidate',scope,inputs,parameters,steps,outputs,stage,
  purpose:'显式工程活动过程候选；当前分量与区间后的候选分量分别读取。',parameter_constraints:[],product_steps:[],
  limitations:['固定区间驱动下的目标趋近，不是人物标定或心理科学定律。','输出是只读候选；不会自动参与、退出、写入状态或修改喜好。'],...extra});

function privateCatalog(zeroElapsed,mode){
  const c=clone(baseCatalog),ratio=(quantity,role='level',domain=[0,1])=>({unit:'ratio',quantity,temporal_role:role,domain});
  Object.assign(c.types,{
    daily_enacted_attention:ratio('actual_attention_allocation'),daily_repeated_exposure:ratio('actual_activity_exposure_intensity'),
    daily_exertion:ratio('experienced_task_exertion'),daily_external_cost:ratio('external_activity_cost'),daily_task_fatigue:ratio('task_load_fatigue'),
    daily_attraction:ratio('activity_attraction'),daily_unsatiated:ratio('remaining_activity_appetite'),daily_intrinsic_motive:ratio('intrinsic_activity_motive'),
    daily_desire_component:ratio('outcome_desire_component'),daily_motivation:ratio('current_activity_motivation'),
    daily_continue_support:ratio('activity_evaluation'),daily_exit_burden:ratio('activity_evaluation'),
    daily_continue_margin:ratio('activity_evaluation','comparison',[-1,1]),
    daily_elapsed_seconds:{unit:'seconds',quantity:'elapsed_scene_time',temporal_role:'comparison',domain:[0,null]},
    daily_dose_seconds:{unit:'seconds',quantity:'full_intensity_exposure_time',temporal_role:'comparison',domain:[0,null]},
  });
  const viewInputs=Object.fromEntries(['familiar_interest','present_appeal','outcome_desire','experienced_enjoyment','external_cost'].map(k=>[k,port(INPUT_TYPES[k])]));
  for(const [key,type]of Object.entries(STATE_TYPES))viewInputs[key]=port(type);
  const weights=Object.fromEntries(WEIGHTS.map(k=>[k,{min:0,max:1}]));
  const viewSteps=[
    weighted('familiar_component','daily_attraction',[input('familiar_interest')],[param('attraction_familiar_weight')]),
    weighted('present_component','daily_attraction',[input('present_appeal')],[param('attraction_present_weight')]),
    weighted('attraction','daily_attraction',[input('familiar_interest'),input('present_appeal')],[param('attraction_familiar_weight'),param('attraction_present_weight')]),
    {id:'unsatiated',op:'positive_gap',type:'daily_unsatiated',inputs:[{constant:1,type:'satiation_level'},input('satiation')],params:{}},
    {id:'intrinsic_remaining',op:'product',type:'daily_intrinsic_motive',inputs:[step('attraction'),step('unsatiated')],params:{}},
    weighted('intrinsic_component','daily_motivation',[step('intrinsic_remaining')],[param('motivation_attraction_weight')]),
    weighted('desire_component','daily_desire_component',[input('outcome_desire')],[param('motivation_desire_weight')]),
    weighted('motivation','daily_motivation',[step('intrinsic_remaining'),input('outcome_desire')],[param('motivation_attraction_weight'),param('motivation_desire_weight')]),
    weighted('continue_support','daily_continue_support',[step('motivation'),input('engagement'),input('experienced_enjoyment')],
      [param('continue_motivation_weight'),param('continue_engagement_weight'),param('continue_enjoyment_weight')]),
    weighted('exit_burden','daily_exit_burden',[input('external_cost'),input('fatigue')],[param('burden_cost_weight'),param('burden_fatigue_weight')]),
    {id:'continue_margin',op:'difference',type:'daily_continue_margin',inputs:[step('continue_support'),step('exit_burden')],params:{}},
  ];
  const viewOutputs=Object.fromEntries(viewSteps.filter(s=>s.id!=='intrinsic_remaining').map(s=>[s.id,s.id]));
  for(const [name,stageName]of [['current','activation_field'],['after','integration_commit']])c.recipes.push(recipe('daily_activity_view_'+name,['subject','activity'],clone(viewInputs),clone(weights),clone(viewSteps),clone(viewOutputs),stageName,
    {product_steps:['intrinsic_remaining'],parameter_constraints:groups.map(keys=>({kind:'sum_max',keys:[...keys],value:1}))}));
  for(const [key,type]of Object.entries(STATE_TYPES)){
    const driver={engagement:'enacted_attention',satiation:'repeated_exposure',fatigue:'exertion'}[key];
    const accumulated=mode==='active'&&key!=='engagement',steps=[identity('target',type,accumulated?{constant:1,type}:input('driver'))];
    if(accumulated&&!zeroElapsed)steps.push({id:'dose_seconds',op:'product',type:'daily_dose_seconds',inputs:[input('elapsed'),input('driver')],params:{}});
    steps.push(zeroElapsed?identity('next',type,input('previous')):{id:'next',op:'decay',type,
      inputs:[input('previous'),step('target'),accumulated?step('dose_seconds'):input('elapsed')],params:{half_life:param('half_life_seconds')}});
    const stateInputs={previous:port(type),...(accumulated&&zeroElapsed?{}:{driver:port(INPUT_TYPES[driver])}),elapsed:port('daily_elapsed_seconds')};
    c.recipes.push(recipe('daily_activity_next_'+key+'_'+mode+(zeroElapsed?'_zero':'_advance'),key==='fatigue'?['subject']:['subject','activity'],
      stateInputs,{half_life_seconds:{min:Number.MIN_VALUE,max:null}},
      steps,{next:'next',target:'target'},'dynamic_transformation',{product_steps:accumulated&&!zeroElapsed?['dose_seconds']:[]}));
  }
  c.notes.push('daily_activity是独立数值过程候选，不接原GeneralRuntime，不声明新的角色参数或真实活动事实。');
  return c;
}
/** Detached local catalog for state-backed host composition; no formula change. */
export function createDailyActivityCatalog({zero_elapsed,mode}){
  need(typeof zero_elapsed==='boolean'&&['active','rest'].includes(mode),'DAILY_ACTIVITY_CATALOG_MODE');
  return privateCatalog(zero_elapsed,mode);
}

/** Build one explicitly observed active/rest interval. Numerical evolution is
 * performed only by the existing C++ operators after the caller evaluates it. */
export function buildDailyActivity(raw){
  exact(raw,['namespace','subject','activity_id','interval','state','inputs','parameters']);
  const r=clone(raw);exact(r.namespace,['character_version','conversation_id','world_id']);Object.values(r.namespace).forEach(text);text(r.subject);text(r.activity_id);
  exact(r.interval,['id','mode','elapsed_seconds','source_refs']);text(r.interval.id);need(['active','rest'].includes(r.interval.mode),'DAILY_ACTIVITY_MODE');
  const evidence=refs(r.interval.source_refs),elapsed=signal(r.interval.elapsed_seconds,{seconds:true});
  exact(r.state,Object.keys(STATE_TYPES));exact(r.inputs,Object.keys(INPUT_TYPES));exact(r.parameters,DAILY_ACTIVITY_PARAMETERS);
  const states=Object.fromEntries(Object.entries(r.state).map(([k,v])=>[k,signal(v)])),inputs=Object.fromEntries(Object.entries(r.inputs).map(([k,v])=>[k,signal(v)]));
  validateDailyActivityParameters(r.parameters);
  const zero=elapsed.known&&elapsed.value===0,catalog=privateCatalog(zero,r.interval.mode),activity={subject:r.subject,activity:r.activity_id},person={subject:r.subject};
  const id=part=>JSON.stringify(['daily-activity',r.subject,r.activity_id,part]),literal=(type,scope,s)=>({type,scope:clone(scope),signal:clone(s)});
  const request={namespace:clone(r.namespace),state_fields:{},instances:[],bindings:[]};
  function bind(instance,name,sourceScope){
    if(fingerprint(sourceScope)===fingerprint(instance.scope))return;
    const ref=instance.inputs[name],from=ref.output?{instance:ref.output.instance,output:ref.output.field}:{external:{instance:instance.id,input:name}};
    request.bindings.push({id:JSON.stringify([instance.id,name,'binding']),from,to:{instance:instance.id,input:name},source_scope:clone(sourceScope),target_scope:clone(instance.scope),evidence_refs:[...evidence]});
  }
  const outputs={current:{},after:{},next_state:{},interval_targets:{}};
  for(const [key,type]of Object.entries(STATE_TYPES)){
    const scope=key==='fatigue'?person:activity,driver={engagement:'enacted_attention',satiation:'repeated_exposure',fatigue:'exertion'}[key];
    // Known rest is an explicit interval condition, not missing activity data.
    const target=r.interval.mode==='rest'?{known:true,value:0,sources:[...evidence]}:inputs[driver];
    const instance={id:id('next-'+key),recipe:'daily_activity_next_'+key+'_'+r.interval.mode+(zero?'_zero':'_advance'),scope:clone(scope),parameters:{half_life_seconds:r.parameters[key+'_half_life_seconds']},
      inputs:{previous:literal(type,scope,states[key]),...(zero&&r.interval.mode==='active'&&key!=='engagement'?{}:{driver:literal(INPUT_TYPES[driver],activity,target)}),elapsed:literal('daily_elapsed_seconds',scope,elapsed)}};
    if(Object.hasOwn(instance.inputs,'driver'))bind(instance,'driver',activity);
    request.instances.push(instance);
    outputs.next_state[key]={instance:instance.id,field:'next',type,scope:clone(scope)};
    outputs.interval_targets[key]={instance:instance.id,field:'target',type,scope:clone(scope)};
  }
  for(const phase of ['current','after']){
    const instance={id:id(phase),recipe:'daily_activity_view_'+phase,scope:clone(activity),parameters:Object.fromEntries(WEIGHTS.map(k=>[k,r.parameters[k]])),inputs:{}};
    for(const k of ['familiar_interest','present_appeal','outcome_desire','experienced_enjoyment','external_cost'])instance.inputs[k]=literal(INPUT_TYPES[k],activity,inputs[k]);
    for(const [key,type]of Object.entries(STATE_TYPES)){
      const scope=key==='fatigue'?person:activity;
      instance.inputs[key]=phase==='current'?literal(type,scope,states[key]):{output:{instance:outputs.next_state[key].instance,field:'next'}};
      bind(instance,key,scope);
    }
    request.instances.push(instance);
    const declared=catalog.recipes.find(x=>x.id===instance.recipe);for(const [field,stepId]of Object.entries(declared.outputs)){
      const type=declared.steps.find(s=>s.id===stepId).type;outputs[phase][field]={instance:instance.id,field,type,scope:clone(activity)};
    }
  }
  // Enforce the real compiler's unit, domain, binding and execution-order rules.
  const assembly=compileAssembly(request,catalog);
  const flattened=Object.fromEntries(Object.entries(outputs).flatMap(([group,fields])=>Object.entries(fields).map(([field,selector])=>[JSON.stringify([r.activity_id,group,field]),selector])));
  return {catalog,request,outputs:flattened,metadata:{schema:'asuka.daily-activity-candidate/1',namespace:clone(r.namespace),subject:r.subject,activity_id:r.activity_id,
    dynamics_version:'dose-accumulation-v2',
    output_key_format:'JSON.stringify([activity_id,group,field])',output_groups:Object.keys(outputs),
    interval:clone(r.interval),zero_elapsed_identity:zero,known_elapsed_seconds:elapsed.known,parameter_status:'explicit_unfitted_engineering_parameters',
    request_sha256:fingerprint(request),catalog_sha256:fingerprint(catalog),compiled_nodes:assembly.graph.nodes.length,state_effects:[],
    semantics:{engagement:'Actual enacted-attention persistence; wanting alone does not create participation.',satiation:'Activity-specific accumulated exposure satiation, not global need satisfaction.',
      fatigue:'Subject-scoped accumulated task-load fatigue; not measured physiology or all cognitive capacity.',attraction:'Familiar interest and present appeal are retained independently of state updates.',
      desire:'Outcome desire is not erased by activity satiation.',time:'Explicit scene interval seconds, never API latency, utterance count or iteration count.'},
    equations:{engagement:'active: decay(E, enacted_attention, elapsed; hE); rest: decay(E, 0, elapsed; hE)',
      satiation:'active: decay(S, 1, repeated_exposure * elapsed; hS); rest: decay(S, 0, elapsed; hS)',
      fatigue:'active: decay(F, 1, exertion * elapsed; hF); rest: decay(F, 0, elapsed; hF)'},
    half_life_interpretation:'E uses scene seconds; S/F use full-intensity exposure/load seconds while active, real scene seconds during explicit rest. Accumulation and recovery currently share each explicit half-life.',
    limitations:['Current and after comparisons are readouts, not action selection or permission to participate.',
      'Attention target and exposure/load intensities are fixed interval inputs. Re-estimating them between substeps defines a different experiment.',
      'Exposure/load dose arithmetic is native; zero known dose preserves S/F, positive sustained dose accumulates toward one. Unknown elapsed is never replaced with zero.',
      'This dose model supersedes the earlier target-tracking S/F candidate; earlier 75-call evidence does not validate this revision.',
      'Rest must be explicitly supplied; merely leaving this activity does not establish rest.',
      'Concurrent activities sharing one subject fatigue state require an external load allocation; this single-activity bundle does not implement it.',
      'Next states must be passed forward explicitly once after evaluation; no persistence, LLM admission, memory, voice or training is performed.']}};
}
