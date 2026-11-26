import {createHash} from 'node:crypto';
export const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const fingerprint=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
export function serializedAssembly(assembly){
  return JSON.stringify(canonical({schema:assembly.schema,graph:assembly.graph,outputs:assembly.outputs,types:assembly.types,
    required_state_fields:assembly.required_state_fields,execution_requirements:assembly.execution_requirements,schedule:assembly.schedule}));
}
export function assemblyIdentity(assembly){
  return createHash('sha256').update(serializedAssembly(assembly)).digest('hex');
}
