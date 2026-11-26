// Engine-only goal importance and plan comparisons. All arithmetic is emitted
// as typed C++ operations; no facts, emotional effects or lifecycle writes occur.
import {catalog as baseCatalog} from './catalog.mjs';
import {compileAssembly} from './assembly-compiler.mjs';
import {assemblyIdentity,fingerprint} from './assembly-identity.mjs';

const clone=structuredClone,own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const need=(ok,code,path)=>{if(!ok)throw Object.assign(new Error(code),{code,path});};
const text=(v,p)=>{need(typeof v==='string'&&v.trim()&&!v.includes('\0'),'GOAL_TEXT',p);return v;};
function exact(v,keys,p){need(object(v),'GOAL_OBJECT',p);need(keys.every(k=>own(v,k))&&Object.keys(v).every(k=>keys.includes(k)),'GOAL_FIELDS',p);}
function array(v,p){need(Array.isArray(v),'GOAL_ARRAY',p);return v;}
function nonnegative(v,p){need(typeof v==='number'&&Number.isFinite(v)&&v>=0,'GOAL_PARAMETER',p);return v;}
function sources(v,p){const refs=array(v,p).map((s,i)=>text(s,p+'.'+i));need(refs.length>0&&new Set(refs).size===refs.length,'GOAL_SOURCES',p);return refs;}
function signal(v,p,lo=0,hi=1){
  need(object(v)&&typeof v.known==='boolean','GOAL_SIGNAL',p);
  exact(v,v.known?['known','value','sources']:['known','reason','sources'],p);sources(v.sources,p+'.sources');
  if(v.known)need(typeof v.value==='number'&&Number.isFinite(v.value)&&v.value>=lo&&(hi===null||v.value<=hi),'GOAL_SIGNAL_DOMAIN',p);
  else text(v.reason,p+'.reason');return clone(v);
}
const input=name=>({input:name}),step=id=>({step:id}),parameter=name=>({parameter:name});
const port=(type,cross=false)=>({accepts:[type],optional:false,allow_cross_scope:cross});
const op=(id,operator,type,inputs,params={})=>({id,op:operator,type,inputs,params});
const identity=(id,from,type)=>op(id,'weighted_sum',type,[input(from)],{weights:[1],bias:0});
function recipe(id,scope,inputs,parameters,steps,outputs,product_steps=[]){
  return {id,mechanism:'G.plan',stage:'activation_field',scope,inputs,parameters,parameter_constraints:[],steps,outputs,product_steps,
    purpose:'Explicit goal importance and read-only forecast; no outcome has occurred.',
    limitations:['Unfitted engineering comparison, not a decision policy or an experienced emotional effect.']};
}
export function createDailyGoalsCatalog(){
  const c=clone(baseCatalog),type=(id,unit,quantity,domain)=>c.types[id]={unit,quantity,temporal_role:'level',domain};
  type('daily_value_importance','ratio','daily_value_importance',[0,1]);
  type('daily_importance_contribution','ratio','daily_importance_contribution',[0,null]);
  type('daily_process_support','value','daily_process_support',[0,null]);
  type('daily_plan_probability','probability','probability',[0,1]);
  type('daily_plan_feasibility','probability','probability',[0,1]);
  type('daily_plan_attainment','ratio','daily_plan_attainment',[0,1]);
  type('daily_plan_impact','ratio','daily_plan_impact',[0,1]);
  type('daily_goal_value_scale','value','daily_goal_value_scale',[0,null]);
  type('daily_forecast_benefit','value','daily_forecast_benefit',[0,null]);
  type('daily_forecast_utility','value','daily_forecast_utility',[null,null]);
  type('daily_forecast_positive','ratio','daily_forecast_positive',[0,1]);
  type('daily_forecast_negative','ratio','daily_forecast_negative',[0,1]);
  for(const [kind,t]of Object.entries({value:'daily_value_importance',need:'need_importance',care:'care_level'}))
    c.recipes.push(recipe('daily_goal_basis_'+kind,['subject','goal','basis'],{source:port(t,true)},{weight:{min:0,max:null}},[
      identity('source','source',t),op('contribution','weighted_sum','daily_importance_contribution',[input('source')],{weights:[parameter('weight')],bias:0})
    ],{source:'source',contribution:'contribution'}));
  c.recipes.push(recipe('daily_goal_importance_empty',['subject','goal'],{importance:port('goal_importance')},{},[
    identity('importance','importance','goal_importance')],{importance:'importance'}));
  c.recipes.push(recipe('daily_goal_plan',['subject','goal','plan'],{
    importance:port('goal_importance',true),process_support:port('daily_process_support'),probability:port('daily_plan_probability'),
    adjustment:port('probability_adjustment'),available:port('hard_availability'),attainment:port('daily_plan_attainment'),cost:port('real_cost'),
    positive_impact:port('daily_plan_impact'),negative_impact:port('daily_plan_impact'),value_scale:port('daily_goal_value_scale')
  },{},[
    identity('importance','importance','goal_importance'),identity('process_support','process_support','daily_process_support'),
    identity('probability','probability','daily_plan_probability'),identity('attainment','attainment','daily_plan_attainment'),identity('cost','cost','real_cost'),
    op('available','product','hard_availability',[input('available')]),
    op('feasibility','feasibility','daily_plan_feasibility',[input('probability'),input('adjustment'),input('available')]),
    op('benefit','product','daily_forecast_benefit',[input('value_scale'),input('importance'),input('attainment')]),
    op('utility','goal_value','daily_forecast_utility',[input('process_support'),step('feasibility'),step('benefit'),input('cost')]),
    op('positive','product','daily_forecast_positive',[input('importance'),input('positive_impact')]),
    op('negative','product','daily_forecast_negative',[input('importance'),input('negative_impact')])
  ],{importance:'importance',process_support:'process_support',probability:'probability',attainment:'attainment',cost:'cost',available:'available',
    feasibility:'feasibility',benefit:'benefit',utility:'utility',positive:'positive',negative:'negative'},['available','benefit','positive','negative']));
  return c;
}
const literal=(s,type,scope)=>({signal:clone(s),type,scope:clone(scope)});
const ref=(instance,field)=>({output:{instance,field}});
const node=(...ids)=>JSON.stringify(['daily-goals',...ids]);
const key=(...ids)=>JSON.stringify(['daily-goals',...ids]);

/** Sources must identify individual contribution leaves, not generic file names.
 * A plan is a hypothetical comparison, even when its inputs are Known values. */
export function buildDailyGoals(raw,parameters){
  exact(raw,['namespace','subject','goals'],'input');exact(raw.namespace,['character_version','conversation_id','world_id'],'namespace');
  Object.values(raw.namespace).forEach(v=>text(v,'namespace'));text(raw.subject,'subject');
  exact(parameters,['value_scale'],'parameters');nonnegative(parameters.value_scale,'parameters.value_scale');
  const catalog=createDailyGoalsCatalog(),request={namespace:clone(raw.namespace),instances:[],bindings:[],state_fields:{}},outputs={},goals=[],ids=new Set(),sharedBases=new Map();
  const parameterSource='configuration:daily-goals:'+fingerprint(parameters);
  function bind(from,to,port,source_scope,target_scope,evidence_refs){request.bindings.push({id:node('binding',to,port),from:clone(from),
    to:{instance:to,input:port},source_scope:clone(source_scope),target_scope:clone(target_scope),evidence_refs:[...new Set(evidence_refs)]});}
  for(const [gi,g]of array(raw.goals,'goals').entries()){
    const p='goals.'+gi;exact(g,['id','owner_id','importance_bases','plans'],p);text(g.id,p+'.id');
    need(g.owner_id===raw.subject,'GOAL_OWNER_MISMATCH',p);need(!ids.has(g.id),'GOAL_ID_DUPLICATE',p);ids.add(g.id);
    const scope={subject:raw.subject,goal:g.id},bases=array(g.importance_bases,p+'.importance_bases'),seenIds=new Set(),seenSources=new Set(),evidence=new Set(),parts=[];
    for(const [bi,b]of bases.entries()){
      const q=p+'.importance_bases.'+bi;exact(b,['id','type','source_id','signal','weight'],q);text(b.id,q);text(b.source_id,q);
      need(['value','need','care'].includes(b.type),'GOAL_BASIS_TYPE',q);need(!seenIds.has(b.id),'GOAL_BASIS_ID_DUPLICATE',q);seenIds.add(b.id);
      const s=signal(b.signal,q+'.signal');nonnegative(b.weight,q+'.weight');
      const sharedKey=JSON.stringify([b.type,b.source_id]),sharedSignal=fingerprint({...s,sources:[...s.sources].sort()});
      need(!sharedBases.has(sharedKey)||sharedBases.get(sharedKey)===sharedSignal,'GOAL_BASIS_SOURCE_CONFLICT',q);
      sharedBases.set(sharedKey,sharedSignal);
      // One frozen configuration can contain several independent values/needs.
      // Its provenance tag is not a contribution leaf. Keep source_id and all
      // other evidence identities guarded; the host still validates config tags.
      const leaves=[...new Set([b.source_id,...s.sources.filter(src=>!src.startsWith('configuration:'))])];need(leaves.every(v=>!seenSources.has(v)),'GOAL_BASIS_SOURCE_DUPLICATE',q);
      leaves.forEach(v=>seenSources.add(v));s.sources.forEach(v=>evidence.add(v));
      const type={value:'daily_value_importance',need:'need_importance',care:'care_level'}[b.type],source_scope={subject:raw.subject,[{value:'value',need:'need',care:'other'}[b.type]]:b.source_id};
      const target_scope={...scope,basis:b.id},instance=node(g.id,'basis',b.id);
      request.instances.push({id:instance,recipe:'daily_goal_basis_'+b.type,scope:target_scope,inputs:{source:literal(s,type,source_scope)},parameters:{weight:b.weight}});
      bind({external:{instance,input:'source'}},instance,'source',source_scope,target_scope,s.sources);
      outputs[key(g.id,'basis',b.id,'source')]={instance,field:'source'};outputs[key(g.id,'basis',b.id,'contribution')]={instance,field:'contribution'};
      parts.push({id:b.id,type:b.type,source_id:b.source_id,weight:b.weight,instance,scope:target_scope,sources:s.sources});
    }
    const importance=node(g.id,'importance');
    if(!parts.length){request.instances.push({id:importance,recipe:'daily_goal_importance_empty',scope,inputs:{importance:literal({known:false,reason:'goal_importance_basis_not_provided',sources:['goal:'+g.id]},'goal_importance',scope)},parameters:{}});}
    else{
      const recipeId='daily_goal_importance_'+parts.length,ports=parts.map((_,i)=>'basis'+i);
      if(!catalog.recipes.some(r=>r.id===recipeId))catalog.recipes.push(recipe(recipeId,['subject','goal'],Object.fromEntries(ports.map(p=>[p,port('daily_importance_contribution',true)])),{},[
        op('unclamped','weighted_sum','daily_importance_contribution',ports.map(input),{weights:ports.map(()=>1),bias:0}),
        op('importance','clamp','goal_importance',[step('unclamped')],{lower:0,upper:1})],{unclamped:'unclamped',importance:'importance'}));
      request.instances.push({id:importance,recipe:recipeId,scope,inputs:Object.fromEntries(parts.map((b,i)=>['basis'+i,ref(b.instance,'contribution')])),parameters:{}});
      parts.forEach((b,i)=>bind({instance:b.instance,output:'contribution'},importance,'basis'+i,b.scope,scope,b.sources));
      outputs[key(g.id,'importance_unclamped')]={instance:importance,field:'unclamped'};
    }
    outputs[key(g.id,'importance')]={instance:importance,field:'importance'};
    const plans=[],planIds=new Set();
    for(const [pi,m]of array(g.plans,p+'.plans').entries()){
      const q=p+'.plans.'+pi,fields=['process_support','probability','adjustment','available','attainment','cost','positive_impact','negative_impact'];
      exact(m,['id',...fields],q);text(m.id,q+'.id');need(!planIds.has(m.id),'GOAL_PLAN_DUPLICATE',q);planIds.add(m.id);
      const s=Object.fromEntries(fields.map(f=>[f,signal(m[f],q+'.'+f,f==='adjustment'?-1:0,['cost','process_support'].includes(f)?null:1)]));
      need(!s.available.known||[0,1].includes(s.available.value),'GOAL_HARD_AVAILABILITY',q+'.available');
      const outcomeSources=new Set([...seenSources,...evidence,...fields.filter(f=>f!=='process_support').flatMap(f=>s[f].sources)]);
      need(s.process_support.sources.every(src=>!outcomeSources.has(src)),'GOAL_PROCESS_OUTCOME_DOUBLE_COUNT',q+'.process_support');
      const target_scope={...scope,plan:m.id},instance=node(g.id,'plan',m.id),types={process_support:'daily_process_support',probability:'daily_plan_probability',adjustment:'probability_adjustment',available:'hard_availability',attainment:'daily_plan_attainment',cost:'real_cost',positive_impact:'daily_plan_impact',negative_impact:'daily_plan_impact'};
      request.instances.push({id:instance,recipe:'daily_goal_plan',scope:target_scope,inputs:{importance:ref(importance,'importance'),
        ...Object.fromEntries(fields.map(f=>[f,literal(s[f],types[f],target_scope)])),
        value_scale:literal({known:true,value:parameters.value_scale,sources:[parameterSource]},'daily_goal_value_scale',target_scope)},parameters:{}});
      bind({instance:importance,output:'importance'},instance,'importance',scope,target_scope,evidence.size?[...evidence]:['goal:'+g.id]);
      for(const field of Object.keys(catalog.recipes.find(r=>r.id==='daily_goal_plan').outputs))outputs[key(g.id,m.id,field)]={instance,field};
      plans.push({id:m.id,scope:target_scope,instance,kind:'hypothetical_plan',process_sources:clone(s.process_support.sources),
        result_sources:[...outcomeSources],emotional_effect:false,observed_result:false});
    }
    goals.push({id:g.id,owner_id:g.owner_id,scope,importance_bases:clone(parts),plans});
  }
  need(request.instances.length>0,'GOALS_REQUIRED','goals');
  const assembly=compileAssembly(request,catalog);
  return {catalog,request,outputs,metadata:{schema:'asuka.daily-goals/1',subject:raw.subject,goals,parameters:clone(parameters),
    parameter_status:'unfitted_engineering_candidate',weights_normalized:false,assembly_identity:assemblyIdentity(assembly),
    execution_requirements:clone(assembly.execution_requirements),persisted:false,native_executed:false,semantic_review:'not_performed',
    limitations:['Importance sources and plan assumptions are explicitly supplied; this builder does not select or infer them.',
      'Forecasts are not experienced feelings, facts, attempts, adopted goals or commitments.',
      'Source identities denote independent contribution leaves; renaming the same real evidence does not make it independent.',
      'Uncertainty propagates; hard availability only determines feasibility, never importance or personal worth.']}};
}
