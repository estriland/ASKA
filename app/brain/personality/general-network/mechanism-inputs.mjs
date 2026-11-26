import {fingerprint} from './assembly-identity.mjs';
const need=(yes,code)=>{if(!yes)throw Object.assign(new Error(code),{code});};
/** Resolve current-condition registers as typed inputs, never as additive effects. */
export function resolveObservationInputs(request,bindings,writeState,program,catalog){
  const result=structuredClone(request),seen=new Set();
  need(Array.isArray(bindings),'OBSERVATION_BINDINGS_REQUIRED');
  for(const b of bindings){
    need(b&&Object.keys(b).sort().join(',')==='channel_id,input,instance,scope','OBSERVATION_BINDING_FIELDS');
    const channel=program.channels.find(c=>c.id===b.channel_id),instance=result.instances.find(i=>i.id===b.instance);
    need(channel?.storage==='observation'&&instance,'OBSERVATION_CHANNEL_OR_INSTANCE');
    const recipe=catalog.recipes.find(r=>r.id===instance.recipe),port=recipe?.inputs[b.input];
    need(port?.accepts.includes(channel.type),'OBSERVATION_TYPE_MISMATCH');
    need(instance.scope.subject===b.scope.subject&&
      fingerprint(Object.keys(b.scope).sort())===fingerprint([...channel.scope].sort()),'OBSERVATION_SCOPE_MISMATCH');
    if(fingerprint(instance.scope)!==fingerprint(b.scope))need(port.allow_cross_scope&&result.bindings?.some(link=>
      link.to?.instance===b.instance&&link.to?.input===b.input&&link.from?.external?.instance===b.instance&&link.from?.external?.input===b.input&&
      fingerprint(link.source_scope)===fingerprint(b.scope)&&fingerprint(link.target_scope)===fingerprint(instance.scope)),
      'OBSERVATION_EXPLICIT_BINDING_REQUIRED');
    const key=JSON.stringify([b.instance,b.input]);need(!seen.has(key),'DUPLICATE_OBSERVATION_TARGET');seen.add(key);
    const record=writeState.observations.find(r=>r.channel_id===b.channel_id&&fingerprint(r.scope)===fingerprint(b.scope));
    if(record)need(record.type===channel.type&&fingerprint(record.namespace)===fingerprint(request.namespace),'OBSERVATION_IDENTITY_MISMATCH');
    instance.inputs[b.input]={type:channel.type,scope:structuredClone(b.scope),signal:record?structuredClone(record.current.value):{known:false,reason:'condition_not_observed',sources:[]}};
  }
  return result;
}
