// Explicit delayed edges only. This pure adapter reads a prior evaluated graph,
// never executes a payload, mutates native state, or admits an event effect.
import {compileAssembly} from './assembly-compiler.mjs';
import {assemblyIdentity,canonical} from './assembly-identity.mjs';

const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const text=x=>typeof x==='string'&&Boolean(x.trim())&&!x.includes('\0');
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const clone=structuredClone;
function need(ok,code,path){if(!ok)throw Object.assign(new Error(`${code}: ${path}`),{code,path});}
function fields(value,keys,path){
  need(object(value),'OBJECT_REQUIRED',path);
  need(keys.every(key=>Object.hasOwn(value,key)),'FIELD_REQUIRED',path);
  need(Object.keys(value).every(key=>keys.includes(key)),'UNEXPECTED_FIELD',path);
}
function refs(value,path){need(Array.isArray(value)&&value.length>0&&value.every(text),'SOURCE_REFS_REQUIRED',path);return [...new Set(value)];}
function output(assembly,instance,field,path){
  const matches=assembly.outputs.filter(row=>row.instance===instance&&row.field===field);
  need(matches.length===1,'SOURCE_OUTPUT_MISSING_OR_AMBIGUOUS',path);return matches[0];
}
function signal(value,type,path){
  need(object(value)&&typeof value.known==='boolean','SIGNAL_INVALID',path);
  fields(value,value.known?['known','value','sources']:['known','reason','sources'],path);
  need(Array.isArray(value.sources)&&value.sources.every(text),'SIGNAL_SOURCES_INVALID',path+'.sources');
  if(value.known){
    need(typeof value.value==='number'&&Number.isFinite(value.value),'SIGNAL_NUMBER_REQUIRED',path+'.value');
    const [lo,hi]=type.domain;
    need((lo===null||value.value>=lo)&&(hi===null||value.value<=hi),'SIGNAL_DOMAIN',path+'.value');
  }else need(text(value.reason),'SIGNAL_REASON_REQUIRED',path+'.reason');
  return clone(value);
}
function existingInput(ref,assembly,path){
  if(ref?.signal)return {type:ref.type,scope:ref.scope};
  if(ref?.state)return {type:ref.type,scope:ref.state.scope};
  if(ref?.output){const row=output(assembly,ref.output.instance,ref.output.field,path);return {type:row.type,scope:row.scope};}
  throw Object.assign(new Error('TARGET_INPUT_REQUIRED: '+path),{code:'TARGET_INPUT_REQUIRED',path});
}

/** `request` must be the precise input used for previousAssembly. The caller owns
 * the fixed committed anchor across iterations and the final commit/discard.
 * Cross-scope delayed routing is deliberately unsupported in this version. */
export function advanceIteration(request,previousAssembly,previousEvaluation,routes,iteration,catalog){
  need(Number.isSafeInteger(iteration)&&iteration>=1&&iteration<=5,'ITERATION_RANGE','iteration');
  need(previousAssembly?.schema==='asuka.general-assembly/1','ASSEMBLY_REQUIRED','previousAssembly');
  const current=compileAssembly(request,catalog),identity=assemblyIdentity(previousAssembly);
  need(assemblyIdentity(current)===identity,'REQUEST_ASSEMBLY_MISMATCH','request');
  const evaluation=previousEvaluation;
  need(evaluation?.graph?.schema==='asuka.general-numeric-graph-result/1'
    &&evaluation.graph_role==='read_only_evaluation_not_applied_state','EVALUATION_REQUIRED','previousEvaluation');
  need(evaluation.graph.input_identity===identity,'EVALUATION_IDENTITY_MISMATCH','previousEvaluation.graph.input_identity');
  need(same(evaluation.namespace,current.graph.namespace)&&same(evaluation.graph.namespace,current.graph.namespace),
    'NAMESPACE_MISMATCH','previousEvaluation');
  need(Number.isSafeInteger(evaluation.base_revision)&&evaluation.base_revision>=0
    &&Number.isSafeInteger(evaluation.candidate_revision)&&evaluation.candidate_revision===evaluation.base_revision+1,
  'CANDIDATE_REVISION','previousEvaluation');
  need(evaluation.candidate_state?.schema==='asuka.general-kernel-state/1'
    &&evaluation.candidate_state.revision===evaluation.candidate_revision,'CANDIDATE_STATE_REVISION','previousEvaluation.candidate_state');
  need(same(evaluation.candidate_state.namespace,current.graph.namespace),'NAMESPACE_MISMATCH','previousEvaluation.candidate_state');
  need(object(evaluation.graph.values),'GRAPH_VALUES_REQUIRED','previousEvaluation.graph.values');
  need(Array.isArray(routes),'ROUTES_REQUIRED','routes');
  const instances=new Map(request.instances.map(instance=>[instance.id,instance]));
  const recipes=new Map(catalog.recipes.map(recipe=>[recipe.id,recipe]));
  const result=clone(request),resultInstances=new Map(result.instances.map(instance=>[instance.id,instance]));
  const ids=new Set(),targets=new Set(),trace=[];
  routes.forEach((route,index)=>{
    const at=`routes[${index}]`;fields(route,['id','from','to','source_refs'],at);
    need(text(route.id),'ROUTE_ID_REQUIRED',at+'.id');need(!ids.has(route.id),'DUPLICATE_ROUTE',at+'.id');ids.add(route.id);
    fields(route.from,['instance','field'],at+'.from');fields(route.to,['instance','input'],at+'.to');
    need([...Object.values(route.from),...Object.values(route.to)].every(text),'ROUTE_REFERENCE_INVALID',at);
    const sources=refs(route.source_refs,at+'.source_refs');
    const targetKey=JSON.stringify([route.to.instance,route.to.input]);
    need(!targets.has(targetKey),'DUPLICATE_TARGET',at+'.to');targets.add(targetKey);
    const source=output(current,route.from.instance,route.from.field,at+'.from');
    const target=instances.get(route.to.instance);need(target,'TARGET_INSTANCE_MISSING',at+'.to.instance');
    const recipe=recipes.get(target.recipe),port=recipe?.inputs[route.to.input];need(port,'TARGET_PORT_MISSING',at+'.to.input');
    need(Object.hasOwn(target.inputs,route.to.input),'TARGET_INPUT_REQUIRED',at+'.to.input');
    const existing=existingInput(target.inputs[route.to.input],current,at+'.to.input');
    const type=catalog.types[source.type],declared=current.types[source.type];
    need(type&&declared&&same(type,declared),'SOURCE_TYPE_MISMATCH',at+'.from');
    need(['level','comparison'].includes(type.temporal_role),'FEEDBACK_TEMPORAL_ROLE',at+'.from');
    need(port.accepts.includes(source.type)&&source.type===existing.type,'FEEDBACK_TYPE_MISMATCH',at+'.to');
    need(same(source.scope,target.scope)&&same(existing.scope,target.scope),
      'CROSS_SCOPE_FEEDBACK_UNSUPPORTED',at+'.to');
    const copied=signal(evaluation.graph.values[source.node_id],type,at+'.from.signal');
    copied.sources=[...new Set([...copied.sources,...sources])];
    resultInstances.get(target.id).inputs[route.to.input]={type:source.type,scope:clone(target.scope),signal:copied};
    trace.push({id:route.id,source:clone(route.from),target:clone(route.to),source_identity:identity,iteration});
  });
  // Delayed values enter as literals. The compiler still validates all remaining
  // instant dependencies, their stage order, bindings, parameter types and units.
  compileAssembly(result,catalog);
  return {request:result,trace};
}
