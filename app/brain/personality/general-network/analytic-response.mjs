// Explicit soft-input calibration using a small analytic family. This helper
// changes only selected recipes, never facts/gates, persistent state or topology
// outside each local response. Runtime code supplies the frozen shape overrides.
import {catalog as baseCatalog} from './catalog.mjs';
import {fingerprint} from './assembly-identity.mjs';
const copy=structuredClone,own=(x,k)=>Object.hasOwn(x,k),object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const need=(yes,code)=>{if(!yes)throw Object.assign(new Error('ANALYTIC_'+code),{code:'ANALYTIC_'+code});};
const text=x=>typeof x==='string'&&Boolean(x.trim())&&!x.includes('\0');
function exact(x,keys){need(object(x)&&keys.every(k=>own(x,k))&&Object.keys(x).every(k=>keys.includes(k)),'FIELDS');}
const allowed={
  activity_interest:['familiar','present'],exploration:['novelty','comprehension','information'],outcome_desire:['attraction','relevance'],
  need_components:['importance'],caring_motive:['care','need'],affiliation_motive:['attraction'],avoidance:['risk','cost'],
  affect_components:['relevance','positive','negative'],habit_tendency:['strength','cue'],
  action_preparation:['positive','negative','norm_support','norm_conflict','self_control','other_responsibility','self_responsibility'],
};
export function validateAnalyticResponses(raw){
  exact(raw,['schema','routes']);need(raw.schema==='asuka.analytic-response/1'&&Array.isArray(raw.routes),'CONFIG');
  const seen=new Set();for(const row of raw.routes){
    exact(row,['recipe','input','family','shape']);need(text(row.recipe)&&text(row.input)&&allowed[row.recipe]?.includes(row.input),'SOFT_ROUTE');
    const key=JSON.stringify([row.recipe,row.input]);need(!seen.has(key),'DUPLICATE_ROUTE');seen.add(key);
    need(['linear','power','exp_saturation'].includes(row.family),'FAMILY');
    need(typeof row.shape==='number'&&Number.isFinite(row.shape)&&row.shape>0&&(row.family!=='linear'||row.shape===1),'SHAPE');
  }
  return copy(raw);
}

export function applyAnalyticResponses(catalog,raw){
  const config=validateAnalyticResponses(raw),result=copy(catalog),parameter_overrides={},routes=[];
  need(result?.schema==='asuka.general-recipes/1'&&object(result.types)&&Array.isArray(result.recipes),'CATALOG');
  if(config.routes.length){
    const sensitivity={unit:'ratio',quantity:'local_response_sensitivity',temporal_role:'level',domain:[0,null]};
    need(!own(result.types,'analytic_response_sensitivity')||fingerprint(result.types.analytic_response_sensitivity)===fingerprint(sensitivity),'SENSITIVITY_TYPE');
    result.types.analytic_response_sensitivity=sensitivity;
  }
  for(const row of config.routes){
    const original=baseCatalog.recipes.find(r=>r.id===row.recipe),recipe=result.recipes.find(r=>r.id===row.recipe);
    need(original&&recipe&&fingerprint(recipe.inputs)===fingerprint(original.inputs),'BASE_RECIPE');
    const port=recipe.inputs[row.input];need(port?.accepts.length===1,'INPUT_TYPE');const inputType=port.accepts[0],type=result.types[inputType];
    need(type?.unit==='ratio'&&type.temporal_role==='level'&&type.domain[0]===0&&type.domain[1]===1&&
      !['hard_availability','applicability_gate'].includes(type.quantity),'SOFT_TYPE');
    const parameter='analytic_shape__'+row.input,response_step='analytic_response__'+row.input,slope='analytic_slope__'+row.input,sensitivity_output='analytic_sensitivity__'+row.input;
    need(!own(recipe.parameters,parameter)&&!recipe.steps.some(s=>[response_step,slope].includes(s.id))&&!own(recipe.outputs,sensitivity_output),'ALREADY_APPLIED');
    // Raw novelty remains the input fact. Its transformed response is expressly
    // curve_response and is never relabelled as another raw novelty observation.
    const responseType=type.quantity==='raw_novelty'?'curve_response':inputType;
    recipe.parameters[parameter]={min:row.family==='linear'?1:Number.MIN_VALUE,max:row.family==='linear'?1:null};
    for(const step of recipe.steps)step.inputs=step.inputs.map(ref=>ref.input===row.input?{step:response_step}:ref);
    recipe.steps.unshift(
      {id:response_step,op:'analytic_response',type:responseType,inputs:[{input:row.input}],params:{family:row.family,shape:{parameter}}},
      {id:slope,op:'analytic_response_slope',type:'analytic_response_sensitivity',inputs:[{input:row.input}],params:{family:row.family,shape:{parameter}}});
    recipe.outputs[sensitivity_output]=slope;
    recipe.limitations.push('Only the explicitly selected soft input '+row.input+' has an analytic response; input facts remain unchanged. Local sensitivity is potential response, not a new state effect.');
    (parameter_overrides[row.recipe]??={})[parameter]=row.shape;
    routes.push({...copy(row),parameter,response_step,sensitivity_output});
  }
  return {catalog:result,config,parameter_overrides,routes,
    configuration_sources:['configuration:analytic-response:'+fingerprint(config)],required_capability:'analytic-response-v1'};
}
