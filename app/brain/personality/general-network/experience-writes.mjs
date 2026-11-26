// The only write builder in this assembly stage consumes an explicit outcome record.
// It does not accept graph readouts, infer outcomes, or approve semantic evidence.
import {isDeepStrictEqual} from 'node:util';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a,b)=>isDeepStrictEqual(canonical(a),canonical(b));
function need(test,code){if(!test)throw Object.assign(new Error(code),{code});}
function text(x){return typeof x==='string'&&Boolean(x.trim());}
function fields(x,keys,optional=[]){need(object(x),'OBJECT_REQUIRED');need(keys.every(k=>Object.hasOwn(x,k)),'FIELD_REQUIRED');need(Object.keys(x).every(k=>keys.includes(k)||optional.includes(k)),'UNEXPECTED_FIELD');}
function ns(x){fields(x,['character_version','conversation_id','world_id']);need(Object.values(x).every(text),'NAMESPACE_INVALID');}
function signal(x){
  need(object(x)&&typeof x.known==='boolean','SIGNAL_INVALID');
  fields(x,x.known?['known','value']:['known','reason'],['sources']);
  if(x.known)need(typeof x.value==='number'&&Number.isFinite(x.value),'NUMBER_REQUIRED');else need(text(x.reason),'REASON_REQUIRED');
  need(x.sources===undefined||Array.isArray(x.sources)&&x.sources.every(text),'SOURCES_INVALID');
  return x;
}
function resolvePair(pair,stateFields,catalog){
  fields(pair,['id','sum','mass','scope']);need(text(pair.id)&&text(pair.sum)&&text(pair.mass)&&pair.sum!==pair.mass,'PAIR_INVALID');
  need(object(pair.scope)&&text(pair.scope.subject)&&Object.values(pair.scope).every(text),'SCOPE_INVALID');
  const s=stateFields[pair.sum],n=stateFields[pair.mass];need(s&&n,'STATE_FIELD_UNKNOWN');
  for(const def of [s,n]){
    need(def.statistics_pair===pair.id,'PAIR_ID_MISMATCH');
    need(Array.isArray(def.scope)&&same([...def.scope].sort(),Object.keys(pair.scope).sort()),'PAIR_SCOPE_MISMATCH');
  }
  need(catalog.types[s.type]?.temporal_role==='statistic'&&catalog.types[n.type]?.temporal_role==='statistic','STATISTIC_REQUIRED');
  need(catalog.types[s.type].unit==='weighted_probability'&&catalog.types[n.type].unit==='sample_mass','STATISTIC_UNIT');
  return [{mechanism:pair.sum,scope:structuredClone(pair.scope)},{mechanism:pair.mass,scope:structuredClone(pair.scope)}];
}

const memberText=value=>text(value)&&!value.includes('\0');
const sourceSet=value=>[...new Set(value)].sort();
function memberSources(value,allowEmpty=false){
  need(Array.isArray(value)&&(allowEmpty||value.length>0)&&value.every(memberText),'SAMPLE_REVISION_SOURCES');
  return [...new Set(value)];
}
function declaredPair(snapshot,pair,stateFields,catalog){
  if(!Object.hasOwn(snapshot,'statistics_pairs'))return false;
  need(Array.isArray(snapshot.statistics_pairs),'STATISTICS_PAIRS_REQUIRED');
  const ids=new Set(),mechanisms=new Set();let matched=false;
  for(const definition of snapshot.statistics_pairs){
    fields(definition,['id','sum','mass','scope']);
    need([definition.id,definition.sum,definition.mass].every(memberText)&&definition.sum!==definition.mass,'STATISTICS_PAIR_DECLARATION');
    need(!ids.has(definition.id)&&!mechanisms.has(definition.sum)&&!mechanisms.has(definition.mass),'STATISTICS_PAIR_DUPLICATE');
    ids.add(definition.id);mechanisms.add(definition.sum);mechanisms.add(definition.mass);
    need(Array.isArray(definition.scope)&&definition.scope.includes('subject')&&definition.scope.every(memberText)&&
      new Set(definition.scope).size===definition.scope.length,'STATISTICS_PAIR_SCOPE');
    const sum=stateFields[definition.sum],mass=stateFields[definition.mass];
    need(sum&&mass,'STATE_FIELD_UNKNOWN');
    for(const field of [sum,mass])need(field.statistics_pair===definition.id&&Array.isArray(field.scope)&&
      same([...field.scope].sort(),[...definition.scope].sort()),'STATISTICS_PAIR_DECLARATION');
    const s=catalog.types[sum.type],n=catalog.types[mass.type];
    need(s?.temporal_role==='statistic'&&n?.temporal_role==='statistic'&&s.unit==='weighted_probability'&&n.unit==='sample_mass','STATISTICS_PAIR_DECLARATION');
    if(definition.id===pair.id){
      need(definition.sum===pair.sum&&definition.mass===pair.mass&&same([...definition.scope].sort(),Object.keys(pair.scope).sort()),'STATISTICS_PAIR_DECLARATION');
      matched=true;
    }
  }
  return matched;
}
function membershipPayload(raw){
  fields(raw,['pair_id','scope','occurrence_id','meaning_id','base_interpretation_revision','interpretation_revision','observation_id','state','sources','reason'],['outcome','weight']);
  need(['pair_id','occurrence_id','meaning_id','observation_id','reason'].every(k=>memberText(raw[k])),'SAMPLE_REVISION_IDENTITY');
  need(object(raw.scope)&&Object.values(raw.scope).every(memberText),'SAMPLE_REVISION_SCOPE');
  need(Number.isSafeInteger(raw.base_interpretation_revision)&&raw.base_interpretation_revision>0&&
    Number.isSafeInteger(raw.interpretation_revision)&&raw.interpretation_revision===raw.base_interpretation_revision+1,'SAMPLE_REVISION_SEQUENCE');
  need(['active','inactive'].includes(raw.state),'SAMPLE_MEMBERSHIP_STATE');
  const result=structuredClone(raw);result.sources=memberSources(raw.sources);
  if(raw.state==='active'){
    need(Object.hasOwn(raw,'outcome')&&Object.hasOwn(raw,'weight'),'SAMPLE_VALUE_REQUIRED');
    for(const key of ['outcome','weight']){
      const s=signal(raw[key]);need(s.known,'UNKNOWN_SAMPLE_REVISION');
      need(key==='outcome'?s.value>=0&&s.value<=1:s.value>0,'SAMPLE_VALUE_RANGE');
      result[key]={known:true,value:s.value,sources:memberSources(s.sources??[],true)};
      for(const source of result[key].sources)if(!result.sources.includes(source))result.sources.push(source);
    }
    need(Number.isFinite(result.outcome.value*result.weight.value),'NON_FINITE_CONTRIBUTION');
  }else need(!Object.hasOwn(raw,'outcome')&&!Object.hasOwn(raw,'weight'),'INACTIVE_SAMPLE_VALUE_FORBIDDEN');
  return result;
}
function membershipComparable(payload){
  const result=structuredClone(payload);result.sources=sourceSet(result.sources);
  for(const key of ['outcome','weight'])if(result[key])result[key].sources=sourceSet(result[key].sources);
  return result;
}

export function buildExperienceWrites(request,catalog){
  fields(request,['namespace','state_fields','pair','sample']);ns(request.namespace);
  need(object(request.state_fields),'STATE_FIELDS_REQUIRED');
  const targets=resolvePair(request.pair,request.state_fields,catalog),s=request.sample;
  fields(s,['kind','occurrence_id','meaning_id','interpretation_revision','observation_id','mode','at','outcome','weight','source_refs']);
  need(s.kind==='observed_outcome_record','OUTCOME_RECORD_REQUIRED');
  need([s.occurrence_id,s.meaning_id,s.observation_id].every(text),'IDENTITY_REQUIRED');
  need(Number.isSafeInteger(s.interpretation_revision)&&s.interpretation_revision>0,'REVISION_INVALID');
  need(['new_occurrence_effect','replace_interpretation','record_only'].includes(s.mode),'NOT_AN_EXPERIENCE_SAMPLE');
  need(s.at===null||typeof s.at==='number'&&Number.isFinite(s.at),'TIME_INVALID');
  need(Array.isArray(s.source_refs)&&s.source_refs.length&&s.source_refs.every(text),'EVIDENCE_REQUIRED');
  const y=signal(s.outcome),w=signal(s.weight);
  if(y.known)need(y.value>=0&&y.value<=1,'OUTCOME_RANGE');
  if(w.known)need(w.value>=0,'WEIGHT_RANGE');
  const result={schema:'asuka.paired-experience-write/1',namespace:structuredClone(request.namespace),
    pair_id:request.pair.id,instances:targets,effects:[],semantic_review:'not_performed_here'};
  if(s.mode==='record_only')return {...result,status:'historical_record_only'};
  if(!y.known||!w.known){
    need(s.mode!=='replace_interpretation','UNKNOWN_REPLACEMENT');
    return {...result,status:'deferred_unknown_sample'};
  }
  const sources=[...new Set([...s.source_refs,...(y.sources??[]),...(w.sources??[])])];
  const sum=w.value*y.value;need(Number.isFinite(sum),'NON_FINITE_CONTRIBUTION');
  result.effects=targets.map((target,i)=>({target,occurrence_id:s.occurrence_id,meaning_id:s.meaning_id,
    interpretation_revision:s.interpretation_revision,observation_id:s.observation_id,mode:s.mode,
    at:s.at,delta:{known:true,value:i===0?sum:w.value,sources}}));
  return {...result,status:'paired_candidate_not_committed'};
}

/** Call at the typed boundary before consuming restored probability statistics. */
export function validatePairedStatistics(snapshot,pair,stateFields,catalog){
  ns(snapshot.namespace);const targets=resolvePair(pair,stateFields,catalog);
  const declared=declaredPair(snapshot,pair,stateFields,catalog);
  need(Array.isArray(snapshot.cells),'CELLS_REQUIRED');
  const cells=targets.map(t=>snapshot.cells.filter(c=>same(c.target,t)));
  need(cells.every(x=>x.length<=1),'DUPLICATE_STATISTIC_CELL');
  if(cells.every(x=>x.length===0))return {ok:true,initialized:false,...(declared?{active_samples:0,inactive_samples:0}:{})};
  need(cells.every(x=>x.length===1),'PAIRED_CELL_MISSING');
  const [sum,mass]=cells.map(x=>x[0]);
  for(const c of [sum,mass]){
    need(object(c.anchor)&&c.anchor.half_life===null,'STATISTIC_DECAY_UNSUPPORTED');
    need(typeof c.anchor.initial==='number'&&Number.isFinite(c.anchor.initial)&&c.anchor.initial>=0,'STATISTIC_PRIOR');
    need(Array.isArray(c.ledger),'LEDGER_REQUIRED');
  }
  need(sum.anchor.initial<=mass.anchor.initial,'STATISTIC_PRIOR');
  if(declared){
    need([sum,mass].every(c=>Number.isFinite(c.anchor.baseline)&&c.anchor.baseline>=0)&&sum.anchor.baseline<=mass.anchor.baseline,'STATISTIC_PRIOR');
  }
  const key=x=>JSON.stringify([x.occurrence_id,x.meaning_id]);
  const maps=[sum,mass].map(c=>new Map(c.ledger.map(x=>[key(x),x])));
  need(maps.every((m,i)=>m.size===[sum,mass][i].ledger.length),'DUPLICATE_SAMPLE');
  need(same([...maps[0].keys()].sort(),[...maps[1].keys()].sort()),'PAIRED_LEDGER_MISMATCH');
  let activeSamples=0,inactiveSamples=0;
  for(const [id,s]of maps[0]){
    const n=maps[1].get(id);
    need(s.interpretation_revision===n.interpretation_revision&&s.at===n.at,'PAIRED_REVISION_MISMATCH');
    signal(s.delta);signal(n.delta);
    need(s.delta.known&&n.delta.known&&s.delta.value>=0&&n.delta.value>=0&&s.delta.value<=n.delta.value,'STATISTIC_CONTRIBUTION');
    need(s.delta.sources?.length>0&&n.delta.sources?.length>0,'STATISTIC_EVIDENCE_REQUIRED');
    need(same([...(new Set(s.delta.sources??[]))].sort(),[...(new Set(n.delta.sources??[]))].sort()),'PAIRED_EVIDENCE_MISMATCH');
    const hasMembership=Object.hasOwn(s,'membership')||Object.hasOwn(n,'membership')||Object.hasOwn(s,'membership_revision_payload')||Object.hasOwn(n,'membership_revision_payload');
    need(declared||!hasMembership,'MEMBERSHIP_REQUIRES_STATISTICS_PAIR');
    if(!declared)continue;
    for(const row of [s,n]){
      fields(row,['occurrence_id','meaning_id','interpretation_revision','delta','at'],['membership','membership_revision_payload']);
      need(memberText(row.occurrence_id)&&memberText(row.meaning_id)&&Number.isSafeInteger(row.interpretation_revision)&&row.interpretation_revision>0,'SAMPLE_REVISION_IDENTITY');
      need(row.at===null||typeof row.at==='number'&&Number.isFinite(row.at),'TIME_INVALID');
      memberSources(row.delta.sources);
    }
    need(n.delta.value>0,'STATISTIC_CONTRIBUTION');
    if(!hasMembership){activeSamples++;continue;}
    need([s,n].every(row=>Object.hasOwn(row,'membership')&&Object.hasOwn(row,'membership_revision_payload')&&
      ['active','inactive'].includes(row.membership)),'PAIRED_MEMBERSHIP_REQUIRED');
    need(s.membership===n.membership,'PAIRED_MEMBERSHIP_MISMATCH');
    const sp=membershipPayload(s.membership_revision_payload),np=membershipPayload(n.membership_revision_payload);
    need(same(membershipComparable(sp),membershipComparable(np)),'PAIRED_MEMBERSHIP_MISMATCH');
    need(sp.pair_id===pair.id&&same(sp.scope,pair.scope)&&sp.occurrence_id===s.occurrence_id&&sp.meaning_id===s.meaning_id&&
      sp.interpretation_revision===s.interpretation_revision&&sp.state===s.membership,'PAIRED_MEMBERSHIP_MISMATCH');
    if(sp.state==='active'){
      need(s.delta.value===sp.outcome.value*sp.weight.value&&n.delta.value===sp.weight.value&&
        same(sourceSet(s.delta.sources),sourceSet(sp.sources)),'SAMPLE_REVISION_PAYLOAD_MISMATCH');
      activeSamples++;
    }else inactiveSamples++;
  }
  return {ok:true,initialized:true,samples:maps[0].size,...(declared?{active_samples:activeSamples,inactive_samples:inactiveSamples}:{})};
}
