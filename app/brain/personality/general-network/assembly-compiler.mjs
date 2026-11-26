// Compile explicitly typed, already-admitted inputs. This module performs no
// language interpretation, state mutation, native invocation or model call.
import {PROCESSING_STAGES} from '../network/contracts.mjs';
const SCHEMA = 'asuka.general-recipes/1';
const STAGES = ['snapshot',...PROCESSING_STAGES];
const ROLES = ['level','impulse','comparison','statistic','rate'];
const own = (x,k) => Object.prototype.hasOwnProperty.call(x,k);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const equal = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const keysEqual = (a,b) => a.length === b.length && a.every(k => b.includes(k));
const nodeId = (instance,step) => `step:${JSON.stringify([instance,step])}`;
const sourceNodeId = (instance,port) => `input:${JSON.stringify([instance,port])}`;
const canonical = x => Array.isArray(x) ? x.map(canonical) : object(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k,canonical(x[k])])) : x;

export class AssemblyValidationError extends Error {
  constructor(code,path,message) { super(message); this.name='AssemblyValidationError'; this.code=code; this.path=path; }
}
const fail = (code,path,message) => { throw new AssemblyValidationError(code,path,message); };
function fields(x,required,optional,path) {
  if(!object(x)) fail('OBJECT_REQUIRED',path,'Expected an object');
  for(const k of required) if(!own(x,k)) fail('MISSING_FIELD',`${path}.${k}`,'Required field is absent');
  for(const k of Object.keys(x)) if(!required.includes(k)&&!optional.includes(k)) fail('UNKNOWN_FIELD',`${path}.${k}`,'Unexpected field');
}
function text(x,path) {
  if(typeof x!=='string'||!x.trim()||x.includes('\0')) fail('TEXT_REQUIRED',path,'Nonblank text without NUL is required');
  return x;
}
function number(x,path) {
  if(typeof x!=='number'||!Number.isFinite(x)) fail('FINITE_NUMBER_REQUIRED',path,'Expected a finite number, not boolean');
  return x;
}
function array(x,path) { if(!Array.isArray(x)) fail('ARRAY_REQUIRED',path,'Expected an array'); return x; }
function names(x,path,{nonempty=false}={}) {
  const result=array(x,path).map((v,i)=>text(v,`${path}[${i}]`));
  if(nonempty&&!result.length) fail('EMPTY_LIST',path,'At least one item is required');
  if(new Set(result).size!==result.length) fail('DUPLICATE_ID',path,'Duplicate identifiers are not allowed');
  return result;
}
function scope(x,path,expected) {
  if(!object(x)||!own(x,'subject')) fail('SCOPE_INVALID',path,'Scope must identify its subject');
  for(const [key,value] of Object.entries(x)){text(key,path);text(value,`${path}.${key}`);}
  if(expected&&!keysEqual(Object.keys(x),expected)) fail('SCOPE_KEYS',path,'Every and only declared scope key is required');
  return canonical(x);
}
function namespace(x,path) {
  fields(x,['character_version','conversation_id','world_id'],[],path);
  for(const [key,value] of Object.entries(x)) text(value,`${path}.${key}`);
  return canonical(x);
}
function sources(x,path,{nonempty=false}={}) {
  const result=[...new Set(array(x,path).map((v,i)=>text(v,`${path}[${i}]`)))];
  if(nonempty&&!result.length) fail('EVIDENCE_REQUIRED',path,'At least one source identity is required');
  return result;
}
function interval(type) { return [type.domain[0]??-Infinity,type.domain[1]??Infinity]; }
function inDomain(value,type,path) {
  number(value,path); const [lo,hi]=interval(type);
  if(value<lo||value>hi) fail('DOMAIN_VALUE',path,'Value is outside its declared type domain');
  if(type.quantity==='hard_availability'&&value!==0&&value!==1) fail('HARD_AVAILABILITY',path,'Hard availability must be exactly zero or one');
}
function signal(x,type,path) {
  if(!object(x)||typeof x.known!=='boolean') fail('SIGNAL_INVALID',path,'Signal needs a boolean known flag');
  fields(x,x.known?['known','value']:['known','reason'],['sources'],path);
  const refs=own(x,'sources')?sources(x.sources,`${path}.sources`):[];
  if(x.known){inDomain(x.value,type,`${path}.value`);return {known:true,value:x.value,sources:refs};}
  return {known:false,reason:text(x.reason,`${path}.reason`),sources:refs};
}
function validateCatalog(catalog) {
  fields(catalog,['schema','types','recipes'],['notes'],'catalog');
  if(catalog.schema!==SCHEMA) fail('CATALOG_SCHEMA','catalog.schema','Unsupported recipe catalog');
  if(!object(catalog.types)) fail('TYPES_INVALID','catalog.types','Types must be a map');
  const types=new Map();
  for(const [id,t] of Object.entries(catalog.types)){
    text(id,'catalog.types'); fields(t,['unit','quantity','temporal_role','domain'],[],`catalog.types.${id}`);
    text(t.unit,`types.${id}.unit`);text(t.quantity,`types.${id}.quantity`);
    if(!ROLES.includes(t.temporal_role)) fail('TEMPORAL_ROLE',`types.${id}.temporal_role`,'Records and unsupported roles cannot be numeric types');
    if(!Array.isArray(t.domain)||t.domain.length!==2) fail('DOMAIN_INVALID',`types.${id}.domain`,'Domain requires [minimum|null, maximum|null]');
    t.domain.forEach((v,i)=>{if(v!==null)number(v,`types.${id}.domain[${i}]`);});
    if(interval(t)[0]>interval(t)[1]) fail('DOMAIN_INVALID',`types.${id}.domain`,'Domain bounds are reversed');
    types.set(id,t);
  }
  const getType=(id,path)=>{text(id,path);if(!types.has(id))fail('TYPE_UNKNOWN',path,'Unknown type: '+id);return types.get(id);};
  const recipes=new Map();
  for(const [i,r] of array(catalog.recipes,'catalog.recipes').entries()){
    const p=`catalog.recipes[${i}]`;
    fields(r,['id','mechanism','stage','scope','inputs','parameters','parameter_constraints','steps','outputs','purpose','limitations'],['statistic_pairs','product_steps'],p);
    text(r.id,p+'.id');text(r.mechanism,p+'.mechanism');text(r.purpose,p+'.purpose');
    if(!STAGES.includes(r.stage))fail('STAGE_UNKNOWN',p+'.stage','Recipe must declare a supported execution stage');
    if(recipes.has(r.id)) fail('RECIPE_DUPLICATE',p+'.id','Duplicate recipe');
    const declared=names(r.scope,p+'.scope',{nonempty:true});
    if(!declared.includes('subject')) fail('SCOPE_INVALID',p+'.scope','Recipe scope must include subject');
    if(!object(r.inputs)||!object(r.parameters)||!object(r.outputs)) fail('RECIPE_MAP_REQUIRED',p,'Inputs, parameters and outputs must be maps');
    for(const [port,spec] of Object.entries(r.inputs)){
      text(port,p+'.inputs');fields(spec,['accepts','optional'],['allow_cross_scope'],p+'.inputs.'+port);
      names(spec.accepts,p+'.inputs.'+port+'.accepts',{nonempty:true}).forEach(id=>getType(id,p+'.inputs.'+port));
      if(typeof spec.optional!=='boolean'||(own(spec,'allow_cross_scope')&&typeof spec.allow_cross_scope!=='boolean')) fail('BOOLEAN_REQUIRED',p+'.inputs.'+port,'Input flags must be booleans');
    }
    for(const [name,spec] of Object.entries(r.parameters)){
      text(name,p+'.parameters');fields(spec,['min','max'],[],p+'.parameters.'+name);
      if(spec.min!==null)number(spec.min,p+'.parameters.'+name+'.min');
      if(spec.max!==null)number(spec.max,p+'.parameters.'+name+'.max');
      if((spec.min??-Infinity)>(spec.max??Infinity))fail('PARAMETER_RANGE',p+'.parameters.'+name,'Parameter bounds are reversed');
    }
    for(const [j,c] of array(r.parameter_constraints,p+'.parameter_constraints').entries()){
      fields(c,['kind','keys','value'],[],`${p}.parameter_constraints[${j}]`);
      if(c.kind!=='sum_max')fail('CONSTRAINT_UNKNOWN',p+'.parameter_constraints','Unsupported constraint');
      names(c.keys,p+'.parameter_constraints.keys',{nonempty:true}).forEach(k=>{if(!own(r.parameters,k))fail('PARAMETER_UNKNOWN',p+'.parameter_constraints.keys','Unknown parameter');});
      number(c.value,p+'.parameter_constraints.value');
    }
    const steps=new Map();
    for(const [j,step] of array(r.steps,p+'.steps').entries()){
      const sp=`${p}.steps[${j}]`;fields(step,['id','op','type','inputs','params'],[],sp);
      text(step.id,sp+'.id');text(step.op,sp+'.op');getType(step.type,sp+'.type');
      if(steps.has(step.id))fail('STEP_DUPLICATE',sp+'.id','Duplicate step');
      array(step.inputs,sp+'.inputs');if(!object(step.params))fail('OBJECT_REQUIRED',sp+'.params','Params must be explicit object');
      steps.set(step.id,step);
    }
    if(!steps.size)fail('EMPTY_RECIPE',p+'.steps','A numeric recipe must have a step');
    for(const step of steps.values())for(const ref of step.inputs){
      if(!object(ref))fail('STEP_INPUT_INVALID',p+'.steps','Invalid step input');
      if(own(ref,'input')){fields(ref,['input'],[],p+'.steps.input');if(!own(r.inputs,ref.input))fail('INPUT_UNKNOWN',p+'.steps.input','Unknown recipe input');}
      else if(own(ref,'step')){fields(ref,['step'],[],p+'.steps.step');if(!steps.has(ref.step))fail('STEP_UNKNOWN',p+'.steps.step','Unknown step');}
      else{fields(ref,['constant','type'],[],p+'.steps.constant');inDomain(ref.constant,getType(ref.type,p+'.steps.constant.type'),p+'.steps.constant');}
    }
    const exported=new Set();
    for(const [name,step] of Object.entries(r.outputs)){
      text(name,p+'.outputs');if(!steps.has(step))fail('OUTPUT_UNKNOWN',p+'.outputs.'+name,'Output must name a known step');
      if(exported.has(step))fail('OUTPUT_DUPLICATE',p+'.outputs.'+name,'One step cannot be exported under duplicate output names');
      exported.add(step);
    }
    if(!exported.size)fail('EMPTY_OUTPUTS',p+'.outputs','A recipe must expose a result');
    if(own(r,'product_steps'))for(const id of names(r.product_steps,p+'.product_steps'))if(!steps.has(id)||steps.get(id).op!=='product')fail('PRODUCT_DECLARATION',p+'.product_steps','Product declaration must identify a product step');
    if(own(r,'statistic_pairs'))for(const pair of array(r.statistic_pairs,p+'.statistic_pairs')){
      fields(pair,['sum','mass'],[],p+'.statistic_pairs');
      if(pair.sum===pair.mass||!own(r.inputs,pair.sum)||!own(r.inputs,pair.mass))fail('STATISTIC_PAIR_INVALID',p+'.statistic_pairs','Statistics must name separate existing sum and mass ports');
    }
    recipes.set(r.id,{definition:r,steps});
  }
  return {types,recipes,getType};
}
function resolveParams(value,parameters,path,depth=0) {
  if(depth>40)fail('PARAMETER_DEPTH',path,'Parameter nesting is excessive');
  if(Array.isArray(value))return value.map((v,i)=>resolveParams(v,parameters,`${path}[${i}]`,depth+1));
  if(object(value)){
    if(own(value,'parameter')){
      fields(value,['parameter'],[],path);const name=text(value.parameter,path+'.parameter');
      if(!own(parameters,name))fail('PARAMETER_UNKNOWN',path,'Unknown parameter reference');return parameters[name];
    }
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolveParams(v,parameters,path+'.'+k,depth+1)]));
  }
  if(typeof value==='number')number(value,path);
  return value;
}
function productRange(a,b){
  if((a[0]===0&&a[1]===0)||(b[0]===0&&b[1]===0))return [0,0];
  const corners=a.flatMap(x=>b.map(y=>x===0||y===0?0:x*y));
  return [Math.min(...corners),Math.max(...corners)];
}
function outputDomain(range,out,path){
  const [lo,hi]=interval(out),epsilon=1e-12;
  const below=Number.isFinite(lo)&&(range[0]===-Infinity||range[0]<lo-epsilon*Math.max(1,Math.abs(lo)));
  const above=Number.isFinite(hi)&&(range[1]===Infinity||range[1]>hi+epsilon*Math.max(1,Math.abs(hi)));
  if(range.some(Number.isNaN)||below||above)fail('OUTPUT_DOMAIN',path,'The declared output domain does not contain the reachable interval');
}
function primitive(step,input,out,params,recipe,path) {
  const arity=n=>{if(input.length!==n)fail('INPUT_COUNT',path,'Wrong input count for '+step.op);};
  const check=(condition,message)=>{if(!condition)fail('OPERATOR_TYPE',path,message);};
  const exact=(keys)=>fields(params,keys,[],path+'.params');
  const param=k=>number(params[k],path+'.params.'+k);
  const isRange=(t,a,b)=>interval(t)[0]>=a&&interval(t)[1]<=b;
  const sameUnitRole=()=>check(input.every(t=>t.unit===out.unit&&t.temporal_role===out.temporal_role),'Input/output units and temporal roles must match');
  const sameQuantity=()=>check(input.every(t=>t.quantity===input[0].quantity&&t.unit===input[0].unit&&t.temporal_role===input[0].temporal_role),'Inputs must represent the same quantity, unit and temporal role');
  const level=t=>t.temporal_role==='level';
  const probability=t=>t.unit==='probability'&&t.quantity==='probability'&&level(t)&&isRange(t,0,1);
  if(out.quantity==='hard_availability'&&!(step.op==='product'&&input.length===1&&input[0].quantity==='hard_availability'))
    fail('HARD_FACT_SYNTHESIS',path,'A hard availability fact cannot be manufactured from soft numeric inputs');
  if(out.quantity==='raw_novelty'&&input.some(t=>t.quantity!=='raw_novelty'))
    fail('RAW_NOVELTY_CAST',path,'A curve response or unrelated quantity cannot be relabelled as raw novelty');
  let reachable;
  if(step.op==='prior_adjustment'){
    exact(['weights']);array(params.weights,path+'.params.weights');
    if(!input.length||params.weights.length!==input.length-1)fail('WEIGHT_COUNT',path,'One explicit prior and one weight per evidence input are required');
    const owners={narrative_supported_drive:'narrative_positive',narrative_supported_guard:'narrative_guard',narrative_estimate_raw:'narrative_depth'};
    check(owners[out.quantity]===recipe.id,'Partial-evidence estimation is limited to the declared narrative recipes and distinct estimate types');
    sameUnitRole();check(input.every(t=>t.unit==='ratio'&&level(t)&&isRange(t,0,1)),'Narrative priors and evidence must be soft ratio levels in [0,1]');
    params.weights.forEach((w,i)=>number(w,`${path}.params.weights[${i}]`));
    if(interval(out)[0]>=0&&params.weights.some(w=>w<0))fail('NONNEGATIVE_WEIGHT',path,'Signed changes need an explicit intermediate signed type');
    reachable=[...interval(input[0])];input.slice(1).forEach((t,i)=>{const range=interval(t),term=productRange([Math.min(0,range[0]),Math.max(0,range[1])],[params.weights[i],params.weights[i]]);reachable=[reachable[0]+term[0],reachable[1]+term[1]];});
  }else if(step.op==='weighted_sum'){
    exact(['weights','bias']);array(params.weights,path+'.params.weights');
    if(params.weights.length!==input.length)fail('WEIGHT_COUNT',path,'Each input requires an explicit weight');
    params.weights.forEach((w,i)=>number(w,`${path}.params.weights[${i}]`));const bias=param('bias');sameUnitRole();
    if(interval(out)[0]>=0&&(bias<0||params.weights.some(w=>w<0)))fail('NONNEGATIVE_WEIGHT',path,'Negative weights/bias cannot claim a nonnegative result type');
    reachable=[bias,bias];input.forEach((t,i)=>{const term=productRange(interval(t),[params.weights[i],params.weights[i]]);reachable=[reachable[0]+term[0],reachable[1]+term[1]];});
  }else if(step.op==='product'){
    exact([]);if(!input.length)fail('INPUT_COUNT',path,'Product needs at least one input');
    if(!recipe.product_steps?.includes(step.id))fail('PRODUCT_UNDECLARED',path,'Product must be explicitly declared by the recipe');
    const carriers=input.filter(t=>t.unit!=='ratio');
    check(carriers.length<=1&&out.unit===(carriers[0]?.unit??'ratio'),'Product permits one non-ratio carrier and ratio modulation only');
    const nonlevels=input.filter(t=>t.temporal_role!=='level');
    check(nonlevels.length<=1&&out.temporal_role===(nonlevels[0]?.temporal_role??'level'),'Product cannot manufacture an impulse or combine independent temporal roles');
    reachable=input.reduce((r,t)=>productRange(r,interval(t)),[1,1]);
  }else if(step.op==='difference'||step.op==='positive_gap'){
    arity(2);exact([]);sameQuantity();check(out.unit===input[0].unit,'Comparison units must match');
    if(step.op==='difference')check(out.temporal_role==='comparison','Difference is a comparison, not an admitted state impulse');
    else check(input.every(level)&&out.temporal_role==='level','A shortfall is a level, not a state write');
    const a=interval(input[0]),b=interval(input[1]);reachable=[a[0]-b[1],a[1]-b[0]];
    if(step.op==='positive_gap')reachable=reachable.map(x=>Math.max(0,x));
  }else if(step.op==='bounded'){
    arity(1);exact(['scale']);if(param('scale')<=0)fail('PARAMETER_RANGE',path+'.params.scale','Scale must be positive');sameUnitRole();
    check(out.temporal_role!=='statistic','A statistic cannot be replaced by a bounded display value');
    if(interval(out)[0]>=0&&interval(input[0])[0]<0)fail('SIGNED_BOUNDING',path,'Signed input cannot claim a nonnegative bounded type');
    reachable=interval(input[0]).map(x=>Math.tanh(x/params.scale));
  }else if(step.op==='analytic_response'||step.op==='analytic_response_slope'){
    arity(1);exact(['family','shape']);const shape=param('shape');
    check(['linear','power','exp_saturation'].includes(params.family),'Explicit supported analytic response family required');
    if(shape<=0||params.family==='linear'&&shape!==1)fail('PARAMETER_RANGE',path+'.params.shape','Shape must be positive; linear shape equals one');
    check(input[0].unit==='ratio'&&level(input[0])&&isRange(input[0],0,1)&&
      !['hard_availability','applicability_gate'].includes(input[0].quantity),'Analytic response applies only to a soft ratio input');
    check(out.unit==='ratio'&&level(out),'Analytic output is a ratio level');
    if(step.op==='analytic_response_slope'){
      check(out.quantity==='local_response_sensitivity','Slope must be a distinct local sensitivity');reachable=[0,Infinity];
    }else{
      check(out.quantity===input[0].quantity&&out.quantity!=='raw_novelty'||out.quantity==='curve_response','Response preserves its soft quantity or is an explicit curve response');
      reachable=[0,1];
    }
  }else if(step.op==='clamp'){
    arity(1);exact(['lower','upper']);const lo=param('lower'),hi=param('upper');if(lo>=hi)fail('PARAMETER_RANGE',path,'Clamp bounds must be ordered');sameUnitRole();
    check(out.temporal_role!=='statistic','Statistics must remain uncapped in calculation');reachable=interval(input[0]).map(x=>Math.min(hi,Math.max(lo,x)));
  }else if(step.op==='novelty'){
    arity(1);exact([]);check(input[0].unit==='ratio'&&input[0].quantity==='raw_novelty'&&level(input[0])&&isRange(input[0],0,1),'Novelty input must be raw novelty in [0,1]');
    check(out.unit==='ratio'&&out.quantity==='curve_response'&&level(out),'Novelty produces curve_response, not raw novelty or complete curiosity');
    const [a,b]=interval(input[0]),ends=[4*a*(1-a),4*b*(1-b)];reachable=[Math.min(...ends),a<=.5&&b>=.5?1:Math.max(...ends)];
  }else if(step.op==='desire'){
    arity(2);exact([]);check(input[0].quantity==='attraction'&&input[1].quantity==='result_relevance'&&input.every(t=>t.unit==='ratio'&&level(t)&&isRange(t,0,1)),'Desire requires attraction and result relevance, not feasibility');
    check(out.unit==='ratio'&&out.quantity==='outcome_desire'&&level(out),'Desire output must be outcome_desire');reachable=productRange(interval(input[0]),interval(input[1]));
  }else if(step.op==='goal_value'){
    arity(4);exact([]);check([input[0],input[2],input[3]].every(t=>t.unit==='value'&&level(t))&&probability(input[1]),'Goal value requires value/support, probability/feasibility, value/benefit and value/cost');
    check(interval(input[3])[0]>=0&&out.unit==='value'&&level(out),'Cost must be nonnegative and output a value level');
    const s=interval(input[0]),v=productRange(interval(input[1]),interval(input[2])),c=interval(input[3]);reachable=[s[0]+v[0]-c[1],s[1]+v[1]-c[0]];
  }else if(step.op==='feasibility'){
    arity(3);exact([]);check(probability(input[0])&&input[1].unit==='probability'&&input[1].quantity==='probability_adjustment'&&input[1].temporal_role==='comparison'&&isRange(input[1],-1,1),'Feasibility must use probability history and an explicit probability adjustment');
    check(input[2].unit==='ratio'&&input[2].quantity==='hard_availability'&&level(input[2])&&isRange(input[2],0,1)&&probability(out),'Feasibility needs a hard availability fact and probability output');reachable=[0,1];
  }else if(step.op==='probability_mean'){
    arity(2);exact([]);check(input[0].unit==='weighted_probability'&&input[1].unit==='sample_mass'&&input.every(t=>t.temporal_role==='statistic'&&interval(t)[0]>=0)&&probability(out),'Probability mean requires uncapped probability sum/sample mass statistics');
    const [sum,mass]=step.inputs;
    if(!own(sum,'input')||!own(mass,'input')||!recipe.statistic_pairs?.some(pair=>pair.sum===sum.input&&pair.mass===mass.input))fail('STATISTIC_PAIR_REQUIRED',path,'Probability mean must consume a declared direct sum/mass input pair');
    reachable=[0,1];
  }else if(step.op==='blend'){
    arity(2);exact(['alpha']);const alpha=param('alpha');if(alpha<0||alpha>1)fail('PARAMETER_RANGE',path,'Alpha must be in [0,1]');sameQuantity();sameUnitRole();check(out.quantity===input[0].quantity,'Blend must preserve quantity');
    const a=interval(input[0]),b=interval(input[1]),left=productRange(a,[1-alpha,1-alpha]),right=productRange(b,[alpha,alpha]);reachable=[left[0]+right[0],left[1]+right[1]];
  }else if(step.op==='multiply_gate'){
    arity(2);exact([]);check(input[1].unit==='ratio'&&level(input[1])&&['applicability_gate','cue_match'].includes(input[1].quantity)&&isRange(input[1],0,1),'Only an explicit applicability gate or cue match may gate this route');
    check(out.unit===input[0].unit&&out.temporal_role===input[0].temporal_role,'Gating must preserve its carrier unit and temporal role');reachable=productRange(interval(input[0]),interval(input[1]));
  }else if(step.op==='decay'){
    arity(3);exact(['half_life']);if(param('half_life')<=0)fail('PARAMETER_RANGE',path,'Half-life must be positive');
    check(input[0].unit===input[1].unit&&input[0].quantity===input[1].quantity&&[input[0],input[1],out].every(level)&&out.unit===input[0].unit&&out.quantity===input[0].quantity,'Decay preserves a level quantity');
    check(input[2].unit==='seconds'&&input[2].temporal_role==='comparison'&&interval(input[2])[0]>=0,'Elapsed scene time must use nonnegative seconds, not turn count');
    const a=interval(input[0]),b=interval(input[1]);reachable=[Math.min(a[0],b[0]),Math.max(a[1],b[1])];
  }else fail('UNSUPPORTED_OPERATOR',path+'.op','Operator is not admitted by this recipe compiler: '+step.op);
  outputDomain(reachable,out,path+'.type');
}

export function compileAssembly(request,catalog) {
  const {types,recipes,getType}=validateCatalog(catalog);
  fields(request,['namespace','instances'],['bindings','state_fields'],'request');
  const ns=namespace(request.namespace,'request.namespace');
  const stateFields=own(request,'state_fields')?request.state_fields:{};
  if(!object(stateFields))fail('STATE_FIELDS_INVALID','request.state_fields','State fields must be a configured declaration map');
  for(const [id,field] of Object.entries(stateFields)){
    text(id,'state_fields');fields(field,['type','scope'],['statistics_pair'],'state_fields.'+id);getType(field.type,'state_fields.'+id+'.type');
    if(!names(field.scope,'state_fields.'+id+'.scope',{nonempty:true}).includes('subject'))fail('SCOPE_INVALID','state_fields.'+id+'.scope','State field needs subject');
    if(own(field,'statistics_pair'))text(field.statistics_pair,'state_fields.'+id+'.statistics_pair');
  }
  const instances=new Map();
  for(const [i,inst] of array(request.instances,'request.instances').entries()){
    const p=`request.instances[${i}]`;fields(inst,['id','recipe','scope','inputs','parameters'],[],p);text(inst.id,p+'.id');
    if(instances.has(inst.id))fail('INSTANCE_DUPLICATE',p+'.id','Duplicate instance ID');
    if(!recipes.has(inst.recipe))fail('RECIPE_UNKNOWN',p+'.recipe','Unknown recipe');
    const recipe=recipes.get(inst.recipe),r=recipe.definition;scope(inst.scope,p+'.scope',r.scope);
    if(!object(inst.inputs))fail('OBJECT_REQUIRED',p+'.inputs','Inputs must be a map');
    for(const port of Object.keys(inst.inputs))if(!own(r.inputs,port))fail('INPUT_UNKNOWN',p+'.inputs.'+port,'Unexpected input port');
    fields(inst.parameters,Object.keys(r.parameters),[],p+'.parameters');
    for(const [key,spec] of Object.entries(r.parameters)){
      const value=number(inst.parameters[key],p+'.parameters.'+key);
      if(value<(spec.min??-Infinity)||value>(spec.max??Infinity))fail('PARAMETER_RANGE',p+'.parameters.'+key,'Parameter is outside its configured range');
    }
    for(const c of r.parameter_constraints){const sum=c.keys.reduce((n,k)=>n+inst.parameters[k],0);if(!Number.isFinite(sum)||sum>c.value+1e-12*Math.max(1,Math.abs(c.value)))fail('PARAMETER_CONSTRAINT',p+'.parameters','Parameter sum exceeds its explicit bound');}
    instances.set(inst.id,{value:inst,recipe,path:p,ports:new Map()});
  }
  if(!instances.size)fail('EMPTY_ASSEMBLY','request.instances','At least one numeric instance is required');
  const nativeNodes=[],nativeBindings=[],usedBindings=new Set(),usedTypes=new Set(),requiredFields=Object.create(null),nodeStages=new Map();
  const bindings=array(request.bindings??[],'request.bindings'),bindingIds=new Set();
  for(const [i,b] of bindings.entries()){
    const p=`request.bindings[${i}]`;fields(b,['id','from','to','source_scope','target_scope','evidence_refs'],[],p);text(b.id,p+'.id');
    if(bindingIds.has(b.id))fail('BINDING_DUPLICATE',p+'.id','Duplicate binding');bindingIds.add(b.id);
    fields(b.to,['instance','input'],[],p+'.to');
    if(!instances.has(b.to.instance)||!own(instances.get(b.to.instance).recipe.definition.inputs,b.to.input))fail('BINDING_TARGET_UNKNOWN',p+'.to','Unknown binding target');
    if(object(b.from)&&own(b.from,'external')){fields(b.from,['external'],[],p+'.from');fields(b.from.external,['instance','input'],[],p+'.from.external');
      if(!instances.has(b.from.external.instance)||!own(instances.get(b.from.external.instance).recipe.definition.inputs,b.from.external.input))fail('BINDING_SOURCE_UNKNOWN',p+'.from','Unknown external source');
    }else{fields(b.from,['instance','output'],[],p+'.from');if(!instances.has(b.from.instance)||!own(instances.get(b.from.instance).recipe.definition.outputs,b.from.output))fail('BINDING_SOURCE_UNKNOWN',p+'.from','Unknown output source');}
    scope(b.source_scope,p+'.source_scope');scope(b.target_scope,p+'.target_scope');sources(b.evidence_refs,p+'.evidence_refs',{nonempty:true});
  }
  for(const [id,inst] of instances){
    const {value,recipe,path}=inst,r=recipe.definition;
    for(const [port,spec] of Object.entries(r.inputs)){
      const p=path+'.inputs.'+port;let typeId,srcScope,reference,from,statisticsPair,origin;
      if(!own(value.inputs,port)){
        if(!spec.optional)fail('INPUT_REQUIRED',p,'Required input is absent');
        typeId=spec.accepts[0];srcScope=canonical(value.scope);reference={literal:{known:false,reason:'optional input absent: '+port,sources:[]}};origin='missing';
      }else{
        const ref=value.inputs[port];
        if(object(ref)&&own(ref,'signal')){
          fields(ref,['signal','type','scope'],['statistics_pair'],p);typeId=ref.type;const t=getType(typeId,p+'.type');srcScope=scope(ref.scope,p+'.scope');
          reference={literal:signal(ref.signal,t,p+'.signal')};from={external:{instance:id,input:port}};origin='signal';statisticsPair=ref.statistics_pair;
        }else if(object(ref)&&own(ref,'state')){
          fields(ref,['state','type'],['statistics_pair'],p);fields(ref.state,['mechanism','scope','view'],[],p+'.state');
          const mechanism=text(ref.state.mechanism,p+'.state.mechanism');if(!own(stateFields,mechanism))fail('STATE_FIELD_UNDECLARED',p+'.state','State field must have a versioned type declaration');
          const declared=stateFields[mechanism];typeId=ref.type;
          if(typeId!==declared.type)fail('STATE_TYPE_CAST',p+'.type','A state reference cannot cast its configured type');
          const t=getType(typeId,p+'.type');srcScope=scope(ref.state.scope,p+'.state.scope',declared.scope);
          if(!['value','latent'].includes(ref.state.view))fail('STATE_VIEW',p+'.state.view','State view must be explicit value or latent');
          if(t.temporal_role==='statistic'&&ref.state.view!=='latent')fail('STATISTIC_CAPPED',p+'.state.view','Statistics require uncapped latent values');
          if(t.temporal_role!=='statistic'&&ref.state.view!=='value')fail('STATE_LATENT_ROLE',p+'.state.view','Non-statistic state types must read the bounded value; their declared domain does not prove latent bounds');
          statisticsPair=ref.statistics_pair;
          if((statisticsPair??null)!==(declared.statistics_pair??null))fail('STATISTIC_PAIR_DECLARATION',p+'.statistics_pair','Reference pair identity differs from state configuration');
          reference={cell:{mechanism,scope:srcScope},view:ref.state.view};from={external:{instance:id,input:port}};origin='state';requiredFields[mechanism]=declared;
        }else{
          fields(ref,['output'],[],p);fields(ref.output,['instance','field'],[],p+'.output');
          const other=instances.get(ref.output.instance);if(!other||!own(other.recipe.definition.outputs,ref.output.field))fail('OUTPUT_REFERENCE_UNKNOWN',p+'.output','Referenced instance/output is absent');
          if(STAGES.indexOf(other.recipe.definition.stage)>STAGES.indexOf(r.stage))fail('STAGE_REVERSED',p+'.output','An instant output reference cannot travel backward through execution stages');
          const step=other.recipe.steps.get(other.recipe.definition.outputs[ref.output.field]);typeId=step.type;srcScope=canonical(other.value.scope);reference={node:nodeId(other.value.id,step.id)};from={instance:other.value.id,output:ref.output.field};origin='output';
        }
      }
      const t=getType(typeId,p+'.type');usedTypes.add(typeId);
      if(!spec.accepts.includes(typeId))fail('INPUT_TYPE',p+'.type','Reference type is not admitted by this port');
      if(statisticsPair!==undefined)text(statisticsPair,p+'.statistics_pair');
      if(srcScope.subject!==value.scope.subject)fail('SUBJECT_MISMATCH',p,'A binding cannot transfer another subject state');
      const cross=!equal(srcScope,value.scope);
      if(cross&&spec.allow_cross_scope===false)fail('CROSS_SCOPE_FORBIDDEN',p,'This port requires the exact same quantity instance');
      const candidates=bindings.filter(b=>equal(b.to,{instance:id,input:port})&&equal(b.from,from)&&equal(b.source_scope,srcScope)&&equal(b.target_scope,value.scope));
      if(candidates.length>1)fail('BINDING_AMBIGUOUS',p,'Multiple bindings address this exact input');
      if(cross&&!candidates.length)fail('BINDING_REQUIRED',p,'Different scopes require an exact evidence-bound relationship');
      const binding=candidates[0];
      if(binding&&own(reference,'literal')){
        const sourceId=sourceNodeId(id,port);
        nativeNodes.push({id:sourceId,scope:srcScope,op:'product',inputs:[reference],params:{}});
        nodeStages.set(sourceId,r.stage);
        reference={node:sourceId};
      }
      inst.ports.set(port,{typeId,type:t,scope:srcScope,reference,binding,statisticsPair,origin});
    }
    for(const pair of r.statistic_pairs??[]){
      const sum=inst.ports.get(pair.sum),mass=inst.ports.get(pair.mass);
      if(!sum.statisticsPair||sum.statisticsPair!==mass.statisticsPair||!equal(sum.scope,mass.scope))fail('STATISTIC_PAIR_MISMATCH',path+'.inputs','Sum and mass need the same nonempty statistics pair and complete scope');
      if(sum.type.unit!=='weighted_probability'||mass.type.unit!=='sample_mass'||[sum,mass].some(v=>v.type.temporal_role!=='statistic'))fail('STATISTIC_PAIR_TYPE',path+'.inputs','Mean inputs must be probability statistics, not mean readouts');
    }
  }
  const outputs=[];
  for(const [id,inst] of instances){
    const r=inst.recipe.definition;
    for(const step of inst.recipe.steps.values()){
      const p=inst.path+'.steps.'+step.id,out=getType(step.type,p+'.type');usedTypes.add(step.type);
      const params=resolveParams(step.params,inst.value.parameters,p+'.params'),inputTypes=[],inputs=[];
      step.inputs.forEach((ref,index)=>{
        let type,reference,binding,srcScope;
        if(own(ref,'input')){const port=inst.ports.get(ref.input);type=port.type;reference=structuredClone(port.reference);binding=port.binding;srcScope=port.scope;}
        else if(own(ref,'step')){const source=inst.recipe.steps.get(ref.step);type=getType(source.type,p+'.input.type');reference={node:nodeId(id,source.id)};}
        else{type=getType(ref.type,p+'.constant.type');usedTypes.add(ref.type);reference={literal:{known:true,value:ref.constant,sources:[]}};}
        inputTypes.push(type);
        if(binding){
          usedBindings.add(binding.id);
          const nativeId=`binding:${JSON.stringify([binding.id,id,step.id,index])}`;
          nativeBindings.push({id:nativeId,from:structuredClone(reference),to:nodeId(id,step.id),input_index:index,source_scope:srcScope,target_scope:canonical(inst.value.scope),evidence_refs:sources(binding.evidence_refs,p+'.binding.evidence_refs',{nonempty:true})});
          reference.binding=nativeId;
        }
        inputs.push(reference);
      });
      primitive(step,inputTypes,out,params,r,p);
      nativeNodes.push({id:nodeId(id,step.id),mechanism_ref:r.mechanism,scope:canonical(inst.value.scope),op:step.op,inputs,params});
      nodeStages.set(nodeId(id,step.id),r.stage);
    }
    for(const [field,step] of Object.entries(r.outputs))outputs.push({instance:id,recipe:r.id,field,node_id:nodeId(id,step),type:inst.recipe.steps.get(step).type,scope:canonical(inst.value.scope),stage:r.stage});
  }
  if(usedBindings.size!==bindings.length)fail('BINDING_UNUSED','request.bindings','Unused or mismatched bindings cannot grant implicit permission');
  const ids=new Set(nativeNodes.map(n=>n.id)),indegree=new Map(nativeNodes.map(n=>[n.id,0])),outgoing=new Map(nativeNodes.map(n=>[n.id,new Set()]));
  for(const node of nativeNodes)for(const ref of node.inputs)if(own(ref,'node')){
    if(!ids.has(ref.node))fail('NODE_UNKNOWN','graph.nodes','Compiled reference does not exist');
    if(!outgoing.get(ref.node).has(node.id)){outgoing.get(ref.node).add(node.id);indegree.set(node.id,indegree.get(node.id)+1);}
  }
  const rank=(a,b)=>STAGES.indexOf(nodeStages.get(a))-STAGES.indexOf(nodeStages.get(b))||(a<b?-1:a>b?1:0);
  const ready=[...ids].filter(id=>indegree.get(id)===0).sort(rank),order=[];
  while(ready.length){const id=ready.shift();order.push(id);for(const next of outgoing.get(id)){indegree.set(next,indegree.get(next)-1);if(indegree.get(next)===0){ready.push(next);ready.sort(rank);}}}
  if(order.length!==ids.size)fail('ASSEMBLY_CYCLE','graph.nodes','Instant dependencies contain a cycle');
  return structuredClone({schema:'asuka.general-assembly/1',graph:{namespace:ns,nodes:nativeNodes,bindings:nativeBindings},outputs,
    execution_requirements:{frame_effects:'must_be_empty',derived_effects:'forbidden',timing:'read_only_instant_pass'},
    schedule:{timing:'read_only_instant_pass',order,stages:STAGES.map(stage=>({stage,nodes:order.filter(id=>nodeStages.get(id)===stage)})).filter(group=>group.nodes.length)},
    types:Object.fromEntries([...usedTypes].sort().map(id=>[id,types.get(id)])),required_state_fields:requiredFields,state_effects:[],
    coverage:{instantiated_recipes:[...new Set([...instances.values()].map(x=>x.value.recipe))].sort(),
      instantiated_mechanisms:[...new Set([...instances.values()].map(x=>x.recipe.definition.mechanism))].sort(),
      instances:instances.size,recipe_nodes:nativeNodes.filter(n=>own(n,'mechanism_ref')).length,
      transport_nodes:nativeNodes.filter(n=>!own(n,'mechanism_ref')).length,full_mechanism_execution_claim:false},
    limitations:['No effects, lifecycle changes, native execution or persistence are generated.',
      'Source IDs and type declarations do not establish the truth of natural-language evidence.',
      'Configured state declarations must be matched against the actual native package by the host.',
      'This expands numeric recipes only; records, language and storage boundaries remain separate.',
      'The host must enforce empty frame effects and forbidden derived effects; no previous_commit or next_iteration expansion is provided.']});
}

export function validateAssembly(request,catalog) {
  try { compileAssembly(request,catalog);return {ok:true,errors:[]}; }
  catch(error){if(!(error instanceof AssemblyValidationError))throw error;return {ok:false,errors:[{code:error.code,path:error.path,message:error.message}]};}
}
