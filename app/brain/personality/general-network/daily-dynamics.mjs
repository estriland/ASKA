// Engine-only evaluation of explicitly supplied situations. No LLM, review
// queue, personality mutation, storage migration or automatic action selection.
import {compileAssembly} from './assembly-compiler.mjs';
import {assemblyIdentity,fingerprint} from './assembly-identity.mjs';
import {buildReadOnlyRequest} from './read-only-pass.mjs';

const clone=structuredClone;
const need=(yes,code)=>{if(!yes)throw Object.assign(new Error(code),{code});};
const same=(a,b)=>fingerprint(a)===fingerprint(b);

/** Merge local recipe extensions, keeping all original units and scope checks.
 * Builders return outputs as {readableKey:{instance,field}}. */
export function compileDailyDynamics(namespace,bundles,{state_fields=null}={}){
  need(Array.isArray(bundles)&&bundles.length>0,'DAILY_BUNDLES_REQUIRED');
  const catalog={schema:'asuka.general-recipes/1',types:{},recipes:[]},recipes=new Map(),outputs={},metadata=[];
  const instances=new Map(),bindings=new Map(),welfareValues=new Map();
  const request={namespace:clone(namespace),instances:[],bindings:[],state_fields:{}};
  for(const b of bundles){
    need(b?.catalog?.schema===catalog.schema&&same(b.request?.namespace,namespace),'DAILY_BUNDLE_IDENTITY');
    for(const [key,field]of Object.entries(b.request.state_fields??{})){
      need(state_fields&&same(state_fields[key],field),'DAILY_LITERAL_SNAPSHOT_ONLY');request.state_fields[key]=clone(field);
    }
    for(const [key,value]of Object.entries(b.catalog.types)){
      need(!catalog.types[key]||same(catalog.types[key],value),'DAILY_TYPE_CONFLICT');catalog.types[key]=clone(value);
    }
    for(const r of b.catalog.recipes){need(!recipes.has(r.id)||same(recipes.get(r.id),r),'DAILY_RECIPE_CONFLICT');recipes.set(r.id,clone(r));}
    const welfare=b.metadata?.shared_general_welfare;
    if(welfare){need(!welfareValues.has(welfare.subject)||same(welfareValues.get(welfare.subject),welfare.signal),'DAILY_GENERAL_VALUE_CONFLICT');welfareValues.set(welfare.subject,clone(welfare.signal));}
    for(const row of b.request.instances){need(!instances.has(row.id)||same(instances.get(row.id),row),'DAILY_INSTANCE_CONFLICT');instances.set(row.id,clone(row));}
    for(const row of b.request.bindings??[]){need(!bindings.has(row.id)||same(bindings.get(row.id),row),'DAILY_BINDING_CONFLICT');bindings.set(row.id,clone(row));}
    need(b.outputs&&typeof b.outputs==='object'&&!Array.isArray(b.outputs),'DAILY_OUTPUT_MAP_REQUIRED');
    for(const [name,ref]of Object.entries(b.outputs)){
      need(!Object.hasOwn(outputs,name)&&typeof ref?.instance==='string'&&typeof ref.field==='string','DAILY_OUTPUT_CONFLICT');outputs[name]=clone(ref);
    }
    metadata.push(clone(b.metadata??{}));
  }
  catalog.recipes=[...recipes.values()];request.instances=[...instances.values()];request.bindings=[...bindings.values()];const assembly=compileAssembly(request,catalog);
  const resolved={};for(const [name,ref]of Object.entries(outputs)){
    const rows=assembly.outputs.filter(o=>o.instance===ref.instance&&o.field===ref.field);need(rows.length===1,'DAILY_OUTPUT_MISSING');resolved[name]=clone(rows[0]);
  }
  return {assembly,catalog,outputs:resolved,metadata};
}

/** Evaluate on the caller's existing native channel. Even next-state values
 * are candidates: native committed cells, revision and time remain unchanged.
 * The caller must serialize access to the channel throughout this operation. */
export async function evaluateDailyDynamics(nativeCall,{package:pkg,snapshot,bundles,observation_id,include_assembly=false}){
  need(typeof nativeCall==='function','DAILY_NATIVE_CALL_REQUIRED');
  need(typeof observation_id==='string'&&observation_id.trim(),'DAILY_OBSERVATION_REQUIRED');
  const frozen=clone({pkg,snapshot,bundles,observation_id});
  const plan=compileDailyDynamics(frozen.pkg.namespace,frozen.bundles);
  const before=await nativeCall({op:'state'});need(same(before,frozen.snapshot),'DAILY_NATIVE_SNAPSHOT_CHANGED');
  const frame={namespace:clone(frozen.pkg.namespace),base_revision:before.revision,observation_id:frozen.observation_id,
    scene_time:null,instances:[],effects:[]};
  const request=buildReadOnlyRequest(plan.assembly,frozen.pkg,frame,before,plan.catalog);
  let prepared,result;
  try{
    prepared=await nativeCall(request);
    need(prepared.graph?.input_identity===assemblyIdentity(plan.assembly),'DAILY_NATIVE_ASSEMBLY_MISMATCH');
    const outputs={};for(const [key,o]of Object.entries(plan.outputs)){
      const signal=prepared.graph.values[o.node_id];need(signal&&typeof signal.known==='boolean','DAILY_NATIVE_OUTPUT_MISSING');
      outputs[key]={instance:o.instance,field:o.field,type:o.type,scope:clone(o.scope),signal:clone(signal)};
    }
    const rows=[...new Map(Object.values(outputs).map(({instance,field,scope,signal})=>[JSON.stringify([instance,field]),{instance,field,scope,signal}])).values()];
    result={schema:'asuka.daily-dynamics-result/1',namespace:clone(frozen.pkg.namespace),base_revision:before.revision,
      assembly_sha256:assemblyIdentity(plan.assembly),outputs,
      results:rows,metadata:plan.metadata,persisted:false,...(include_assembly?{assembly:clone(plan.assembly)}:{})};
  }finally{
    if(prepared?.ticket)await nativeCall({op:'discard',ticket:prepared.ticket});
  }
  const after=await nativeCall({op:'state'});need(same(before,after),'DAILY_READ_MUTATED_NATIVE_STATE');
  return {...result,native_state_unchanged:true};
}
