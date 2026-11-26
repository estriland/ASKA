import {isDeepStrictEqual} from 'node:util';
import {validatePairedStatistics} from './experience-writes.mjs';
import {assemblyIdentity,serializedAssembly} from './assembly-identity.mjs';
const canon=x=>Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
const same=(a,b)=>isDeepStrictEqual(canon(a),canon(b));
const requireThat=(yes,code)=>{if(!yes)throw Object.assign(new Error(code),{code});};

/** Enforce the assembler's timing contract at the actual native call boundary. */
export function buildReadOnlyRequest(assembly,pkg,frame,snapshot,catalog){
  requireThat(assembly?.schema==='asuka.general-assembly/1','ASSEMBLY_REQUIRED');
  requireThat(same(assembly.execution_requirements,{frame_effects:'must_be_empty',derived_effects:'forbidden',timing:'read_only_instant_pass'}),'EXECUTION_REQUIREMENTS');
  requireThat(Array.isArray(assembly.state_effects)&&assembly.state_effects.length===0,'AUTOMATIC_EFFECTS_FORBIDDEN');
  requireThat(pkg?.schema==='asuka.general-kernel/1'&&snapshot?.schema==='asuka.general-kernel-state/1','KERNEL_IDENTITY_REQUIRED');
  requireThat(same(pkg.namespace,assembly.graph.namespace)&&same(frame.namespace,pkg.namespace)&&same(snapshot.namespace,pkg.namespace),'NAMESPACE_MISMATCH');
  requireThat(snapshot.package_id===pkg.id&&snapshot.package_revision===pkg.revision,'PACKAGE_MISMATCH');
  requireThat(Number.isSafeInteger(frame.base_revision)&&frame.base_revision===snapshot.revision,'BASE_REVISION_MISMATCH');
  requireThat(Array.isArray(frame.effects)&&frame.effects.length===0&&!Object.hasOwn(frame,'derived_effects'),'READ_ONLY_EFFECTS_REQUIRED');
  requireThat(Array.isArray(frame.instances)&&Array.isArray(pkg.definitions),'INSTANCE_DEFINITIONS_REQUIRED');
  const definitions=new Map(pkg.definitions.map(x=>[x.id,x]));
  requireThat(definitions.size===pkg.definitions.length,'DUPLICATE_DEFINITION');
  const groups=new Map();
  for(const [id,field]of Object.entries(assembly.required_state_fields)){
    const def=definitions.get(id),type=catalog.types[field.type];
    requireThat(def&&type,'STATE_DEFINITION_MISSING');
    requireThat(same([...def.scope].sort(),[...field.scope].sort()),'STATE_SCOPE_DECLARATION');
    if(type.temporal_role==='statistic'){
      requireThat(def.half_life===null&&Number.isFinite(def.initial)&&def.initial>=0,'STATISTIC_DEFINITION');
      const group=groups.get(field.statistics_pair)??{};
      const part=type.unit==='weighted_probability'?'sum':type.unit==='sample_mass'?'mass':null;
      requireThat(part&&!group[part],'STATISTIC_PAIR_DECLARATION');group[part]=id;groups.set(field.statistics_pair,group);
    }else{
      const [lo,hi]=type.domain;
      requireThat(Array.isArray(def.bounds)&&def.bounds.length===2&&def.bounds.every(Number.isFinite)&&
        (lo===null||def.bounds[0]>=lo)&&(hi===null||def.bounds[1]<=hi),'STATE_DOMAIN_DECLARATION');
    }
  }
  for(const [id,g]of groups){
    requireThat(g.sum&&g.mass,'PAIRED_DEFINITION_MISSING');
    requireThat(definitions.get(g.sum).initial<=definitions.get(g.mass).initial,'STATISTIC_PRIOR');
    const scopes=new Map();
    for(const cell of snapshot.cells)if([g.sum,g.mass].includes(cell.target.mechanism))scopes.set(JSON.stringify(canon(cell.target.scope)),cell.target.scope);
    for(const instance of frame.instances)if([g.sum,g.mass].includes(instance.mechanism))scopes.set(JSON.stringify(canon(instance.scope)),instance.scope);
    for(const scope of scopes.values()){
      const present=mechanism=>snapshot.cells.some(c=>c.target.mechanism===mechanism&&same(c.target.scope,scope))||
        frame.instances.some(i=>i.mechanism===mechanism&&same(i.scope,scope));
      requireThat(present(g.sum)&&present(g.mass),'PAIRED_INSTANCE_MISSING');
      validatePairedStatistics(snapshot,{id,sum:g.sum,mass:g.mass,scope},assembly.required_state_fields,catalog);
    }
  }
  return {op:'prepare',frame:structuredClone(frame),graph:{serialized_assembly:serializedAssembly(assembly),identity:assemblyIdentity(assembly)}};
}

/** Read the already prepared native ticket. No second prepare, revision or decay. */
export function buildCandidateReadRequest(assembly,pkg,candidate,catalog){
  requireThat(typeof candidate?.ticket==='string'&&Boolean(candidate.ticket.trim())&&!candidate.ticket.includes('\0'),'CANDIDATE_TICKET_REQUIRED');
  requireThat(Number.isSafeInteger(candidate.base_revision)&&candidate.base_revision>=0&&Number.isSafeInteger(candidate.candidate_revision)&&
    candidate.candidate_revision===candidate.base_revision+1&&candidate.candidate_state?.revision===candidate.candidate_revision,'CANDIDATE_REVISION');
  const frame={namespace:candidate.namespace,base_revision:candidate.candidate_revision,
    observation_id:'candidate-read-only',scene_time:null,instances:[],effects:[]};
  const verified=buildReadOnlyRequest(assembly,pkg,frame,candidate.candidate_state,catalog);
  return {op:'evaluate_candidate',ticket:candidate.ticket,graph:verified.graph};
}
