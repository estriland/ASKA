// A small shared retrieval representation, not a psychological update or a
// classifier of named situations. Raw states/windows are never returned/stored.
import {fingerprint} from './assembly-identity.mjs';

const copy=structuredClone,own=(v,k)=>Object.hasOwn(v,k),object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error('COMPACT_'+code),{code:'COMPACT_'+code});};
const text=v=>typeof v==='string'&&Boolean(v.trim())&&!v.includes('\0')&&v.length<=512;
const familyTypes={
  positive:['positive_affect','mood_positive'],negative:['negative_affect','mood_negative'],enjoyment:['experienced_enjoyment'],
  approach:['familiar_drive','present_drive','exploration_drive','outcome_desire','affiliation_drive','care_motive'],
  avoidance:['avoidance_level','risk_salience','cost_salience'],control:['control_capacity','self_controllability'],pressure:['external_pressure'],
  support:['respect_level','cooperation_level'],friction:['friction_level'],satisfied:['need_satisfied'],wanted:['need_wanted'],
};
const families=new Map(Object.entries(familyTypes).flatMap(([name,types])=>types.map(type=>[type,name])));
const gateTypes=['hard_availability','applicability_gate'];
export const compactFeatureTypes=Object.freeze([...families.keys()]);
export const compactGateTypes=Object.freeze([...gateTypes]);
export const compactNarrativeFeatureTypes=Object.freeze(['share_drive','shame_level','exposure_discomfort','guard_level']);
export const compactFeatureTypesV3=Object.freeze([...compactFeatureTypes,...compactNarrativeFeatureTypes]);
export const COMPACT_FEATURE_VERSION='asuka.compact-features/1';
export const COMPACT_FEATURE_VERSION_V2='asuka.compact-features/2';
export const COMPACT_FEATURE_VERSION_V3='asuka.compact-features/3';
export const compactFeatureVersions=Object.freeze([COMPACT_FEATURE_VERSION,COMPACT_FEATURE_VERSION_V2,COMPACT_FEATURE_VERSION_V3]);
const sparseFamilies={positive:familyTypes.positive,negative:familyTypes.negative,enjoyment:familyTypes.enjoyment,
  approach:familyTypes.approach,avoidance:familyTypes.avoidance,controllability:['self_controllability'],capacity:['control_capacity'],
  pressure:familyTypes.pressure,respect:['respect_level'],cooperation:['cooperation_level'],friction:familyTypes.friction,
  satisfied:familyTypes.satisfied,wanted:familyTypes.wanted};
// Keep the direct subjective readouts separate, not aliases for affect or for
// the duplicated supported-* audit outputs / resident disclosure estimate.
const sparseFamiliesV3=Object.freeze({...sparseFamilies,share_drive:['share_drive'],shame:['shame_level'],
  exposure_discomfort:['exposure_discomfort'],guard:['guard_level']});
export const compactFeatureDefinition=Object.freeze({version:COMPACT_FEATURE_VERSION,window_limit:3,state_limit:32,local_direction_limit:4,
  meaning:'Typed role pooling and relational contrasts; exact state scopes align differences but are not nearest-neighbor coordinates.',
  temporal_scale_seconds:60,temporal_coordinate:'A dimensionless 60-second reference coordinate for retrieval features, not a reported per-second derivative.',stored_raw_states:false,learned:false});
const K=value=>({known:true,value}),U=reason=>({known:false,reason});
const avg=values=>values.reduce((a,b)=>a+b,0)/values.length;
function summarize(rows){
  const grouped=new Map();for(const row of rows){const key=families.get(row.type);if(!key)continue;const g=grouped.get(key)??[];g.push(row.signal);grouped.set(key,g);}
  const output={};for(const key of Object.keys(familyTypes)){
    const values=grouped.get(key);output[key]=!values?.length?U('not_observed'):values.some(s=>!s.known)?U('partly_unknown'):K(avg(values.map(s=>s.value)));
  }return output;
}
const combine=(inputs,fn)=>inputs.every(v=>v.known)?K(fn(...inputs.map(v=>v.value))):U('required_component_unknown');
function abstraction(rows){
  const s=summarize(rows),known=rows.filter(r=>families.has(r.type)&&r.signal.known),all=rows.filter(r=>families.has(r.type));
  return {activation:!all.length?U('no_selected_state'):known.length!==all.length?U('partly_unknown'):K(Math.sqrt(avg(known.map(r=>r.signal.value**2)))),
    affect_balance:combine([s.positive,s.negative],(p,n)=>(p-n)/2),
    affect_coexistence:combine([s.positive,s.negative],Math.min),
    experienced_reward:s.enjoyment,
    motivation_balance:combine([s.approach,s.avoidance],(a,v)=>(a-v)/2),
    motivation_tension:combine([s.approach,s.avoidance],Math.min),
    agency_balance:combine([s.control,s.pressure],(c,p)=>(c-p)/2),
    social_balance:combine([s.support,s.friction],(s,f)=>(s-f)/2),
    need_congruence:combine([s.satisfied,s.wanted],(s,w)=>(s-w)/2)};
}
// The first candidate erased a known one-sided response when the counterpart
// was unknown. V2 retains observed continuous levels separately. These are
// partial observations, not estimates of the missing family members.
function sparseAbstraction(rows,groups=sparseFamilies){
  const components={},coverage={};
  for(const [family,types]of Object.entries(groups)){
    const selected=rows.filter(r=>types.includes(r.type)),known=selected.filter(r=>r.signal.known),key='observed_'+family;
    components[key]=known.length?K(avg(known.map(r=>r.signal.value))):U('no_known_observation');
    coverage[key]={known_types:[...new Set(known.map(r=>r.type))].sort(),known_count:known.length,selected_count:selected.length};
  }
  return {components,coverage};
}
function rowKey(row){return fingerprint({type:row.type,scope:row.scope});}
function checkRows(rows,owner){
  need(Array.isArray(rows)&&rows.length<=32,'STATE_LIMIT');const keys=new Set();
  for(const row of rows){
    need(object(row)&&Object.keys(row).every(k=>['type','scope','signal'].includes(k))&&text(row.type)&&object(row.scope)&&row.scope.subject===owner,'STATE');
    need(Object.values(row.scope).every(text)&&Object.keys(row.scope).length<=8,'STATE_SCOPE');
    const s=row.signal;need(object(s)&&typeof s.known==='boolean'&&Array.isArray(s.sources)&&s.sources.length<=16&&s.sources.every(text),'STATE_SIGNAL');
    if(s.known)need(Number.isFinite(s.value)&&s.value>=0&&s.value<=1,'STATE_DOMAIN');else need(text(s.reason)&&!own(s,'value'),'UNKNOWN_STATE');
    const key=rowKey(row);need(!keys.has(key),'DUPLICATE_STATE_VIEW');keys.add(key);
  }
}
function alignedDifferences(before,after,divisor){
  const previous=new Map(before.values.map(r=>[rowKey(r),r]));
  return after.values.filter(r=>previous.has(rowKey(r))).map(r=>{
    const old=previous.get(rowKey(r));return {...r,signal:old.signal.known&&r.signal.known?K((r.signal.value-old.signal.value)/divisor):U('unaligned_knownness')};
  });
}
function deltaSummary(rows,includeNarrative=false){
  const s=summarize(rows),known=rows.filter(r=>families.has(r.type)||includeNarrative&&compactNarrativeFeatureTypes.includes(r.type));
  return {change_magnitude:known.length&&known.every(r=>r.signal.known)?K(Math.tanh(Math.sqrt(avg(known.map(r=>r.signal.value**2))))):U('no_aligned_known_changes'),
    change_direction:combine([s.positive,s.negative],(p,n)=>Math.tanh((p-n)/2))};
}
/** frames are a bounded transient selection of typed native continuous values.
 * Every frame identifies a saved event/forecast, engine/character version and
 * provenance. A correction/version change breaks the difference window. */
export function extractCompactCue({engine_ref,character_ref,owner_id,reality,owner_role,frames,local_response=[],representation_version=COMPACT_FEATURE_VERSION}){
  need(compactFeatureVersions.includes(representation_version),'FEATURE_VERSION');
  const v3=representation_version===COMPACT_FEATURE_VERSION_V3;
  const sparse=representation_version===COMPACT_FEATURE_VERSION_V2||v3;
  need([engine_ref,character_ref,owner_id].every(text)&&['actual','predicted'].includes(reality)&&['self','other','shared','unknown'].includes(owner_role),'FEATURE_IDENTITY');
  need(Array.isArray(frames)&&frames.length>0&&frames.length<=3,'WINDOW_LIMIT');
  // Explicit validation kept separate from the zero/one/two-order calculations.
  for(const f of frames){
    need(object(f)&&text(f.id)&&Number.isSafeInteger(f.sequence)&&f.sequence>=0&&(f.time===null||Number.isFinite(f.time)),'FRAME');
    need(['event','correction','parameter_change'].includes(f.transition)&&text(f.engine_ref)&&text(f.character_ref),'FRAME_VERSION');
    need(Array.isArray(f.source_refs)&&f.source_refs.length>0&&f.source_refs.length<=16&&f.source_refs.every(text),'FRAME_SOURCES');checkRows(f.values,owner_id);
  }
  const latest=frames.at(-1);need(latest.engine_ref===engine_ref&&latest.character_ref===character_ref,'CURRENT_VERSION');
  for(let i=1;i<frames.length;i++)need(frames[i].id!==frames[i-1].id&&frames[i].sequence>frames[i-1].sequence,'FRAME_ORDER');
  let start=frames.length-1;
  while(start>0){const b=frames[start-1],a=frames[start],old=new Map(b.values.map(r=>[rowKey(r),r]));
    const gateChanged=a.values.some(r=>gateTypes.includes(r.type)&&old.has(rowKey(r))&&(r.signal.known!==old.get(rowKey(r)).signal.known||r.signal.known&&r.signal.value!==old.get(rowKey(r)).signal.value));
    if(a.transition!=='event'||a.sequence!==b.sequence+1||a.engine_ref!==b.engine_ref||a.character_ref!==b.character_ref||gateChanged)break;start--;}
  const window=frames.slice(start),observed=sparse?sparseAbstraction(latest.values,v3?sparseFamiliesV3:sparseFamilies):null,components=observed?.components??abstraction(latest.values);let basis='none',duration=U('no_known_interval');
  const usable=window.length>=2,knownTimes=usable&&window.every(f=>f.time!==null)&&window.every((f,i)=>!i||f.time>window[i-1].time);
  let differences;
  if(usable){
    basis=knownTimes?'seconds':'event_steps';const a=window.at(-2),b=window.at(-1),interval=knownTimes?(b.time-a.time)/compactFeatureDefinition.temporal_scale_seconds:1;
    differences=alignedDifferences(a,b,interval);Object.assign(components,deltaSummary(differences,v3));
    if(knownTimes)duration=K(window.at(-1).time-window[0].time);
  }else Object.assign(components,{change_magnitude:U('window_discontinuity_or_first_event'),change_direction:U('window_discontinuity_or_first_event')});
  components.change_curvature=U('second_order_not_available');
  if(window.length===3){
    const equalTime=!knownTimes||Math.abs((window[1].time-window[0].time)-(window[2].time-window[1].time))<1e-9;
    if(equalTime){const d=knownTimes?(window[1].time-window[0].time)/compactFeatureDefinition.temporal_scale_seconds:1,first=alignedDifferences(window[0],window[1],d),second=alignedDifferences(window[1],window[2],d),m=new Map(first.map(r=>[rowKey(r),r]));
      const curvature=second.filter(r=>m.has(rowKey(r))).map(r=>({...r,signal:r.signal.known&&m.get(rowKey(r)).signal.known?K((r.signal.value-m.get(rowKey(r)).signal.value)/d):U('curvature_unknown')}));
      components.change_curvature=deltaSummary(curvature).change_direction;
    }else components.change_curvature=U('unequal_intervals_not_naive_acceleration');
  }
  need(Array.isArray(local_response)&&local_response.length<=4,'LOCAL_DIRECTION_LIMIT');const response={};
  for(const row of local_response){
    need(text(row.input_type)&&text(row.output_type)&&['smooth','hard_transition','unknown'].includes(row.mode),'LOCAL_DIRECTION');
    const key=row.input_type+'->'+row.output_type;need(!own(response,key),'LOCAL_DIRECTION_DUPLICATE');
    need(object(row.slope)&&typeof row.slope.known==='boolean'&&Array.isArray(row.slope.sources)&&row.slope.sources.length>0&&row.slope.sources.length<=8&&row.slope.sources.every(text),'LOCAL_SLOPE');
    if(row.mode==='smooth'&&row.slope.known){need(Number.isFinite(row.slope.value),'LOCAL_SLOPE');response[key]=K(Math.tanh(row.slope.value));}
    else response[key]=U(row.mode==='smooth'?'unknown_slope':row.mode);
  }
  const gate_modes=Object.fromEntries(gateTypes.map(type=>{const rows=latest.values.filter(r=>r.type===type);return [type,!rows.length?'not_selected':rows.some(r=>!r.signal.known)?'unknown':rows.every(r=>r.signal.value===1)?'open':rows.every(r=>r.signal.value===0)?'closed':'mixed'];}));
  return {schema:'asuka.compact-cue/1',representation_version,engine_ref,character_ref,owner_id,reality,owner_role,gate_modes,
    components,response,process_basis:basis,duration_seconds:duration,window_size:window.length,
    ...(sparse?{coverage:observed.coverage}:{}),
    source_refs:[...new Set([...window.flatMap(f=>f.source_refs),...local_response.flatMap(r=>r.slope.sources)])],frame_refs:window.map(f=>({id:f.id,sequence:f.sequence})),
    interpretation:'Retrieval-only continuous abstraction. Retains intensity, unknowns and semantic ownership; cannot reconstruct the graph or establish a new event.'};
}

export function compareCompactCues(query,memory,{minimum_components}={}){
  need(query?.schema==='asuka.compact-cue/1'&&memory?.schema===query.schema,'CUE');
  need(Number.isSafeInteger(minimum_components)&&minimum_components>=1&&minimum_components<=16,'MINIMUM_COMPONENTS');
  for(const field of ['representation_version','engine_ref','character_ref','owner_id','reality','owner_role'])if(query[field]!==memory[field])return {matched:false,reason:'incompatible_'+field};
  for(const type of gateTypes){const a=query.gate_modes?.[type],b=memory.gate_modes?.[type];if(['open','closed','mixed'].includes(a)&&['open','closed','mixed'].includes(b)&&a!==b)return {matched:false,reason:'different_gate_mode_'+type};}
  const v3=query.representation_version===COMPACT_FEATURE_VERSION_V3;
  const sparse=query.representation_version===COMPACT_FEATURE_VERSION_V2||v3;
  let bothNonZero=false;const shared=[];
  for(const [key,value]of Object.entries(query.components))if(value.known&&memory.components[key]?.known){
    if(key.startsWith('change_')&&query.process_basis!==memory.process_basis)continue;
    // A mean over a different known subfamily is not the same measurement.
    // Exact actor/activity IDs do not enter the feature coordinates.
    if(sparse&&key.startsWith('observed_')&&(!query.coverage?.[key]||!memory.coverage?.[key]||fingerprint(query.coverage[key].known_types)!==fingerprint(memory.coverage[key].known_types)))continue;
    const scale=sparse&&!key.startsWith('observed_')?2:1;
    if(value.value!==0&&memory.components[key].value!==0)bothNonZero=true;
    shared.push({key,distance:Math.abs(value.value-memory.components[key].value)/scale});
  }
  if(shared.length<minimum_components)return {matched:false,reason:'insufficient_known_components',overlap:shared.length};
  for(const [key,value]of Object.entries(query.response??{}))if(value.known&&memory.response?.[key]?.known){
    if(value.value!==0&&memory.response[key].value!==0)bothNonZero=true;
    shared.push({key:'local:'+key,distance:Math.abs(value.value-memory.response[key].value)/(sparse?2:1)});
  }
  // Three identical not-applicable zeros do not describe an active common
  // pattern. A sourced, comparable local sensitivity may supply nonzero support.
  if(v3&&!bothNonZero)return {matched:false,reason:'no_shared_nonzero_coordinate',overlap:shared.length};
  const score=1-Math.sqrt(avg(shared.map(r=>r.distance**2)))/(sparse?1:2);
  return {matched:true,score,overlap:shared.length,components:shared.map(r=>r.key),meaning:'abstract_similarity_not_shared_facts_or_responsibility'};
}
