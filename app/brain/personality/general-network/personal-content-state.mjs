// Explicitly admitted personal content, not an automatic preference learner.
// Current interest/habit observations replace registers; independent care changes
// use the existing signed contribution writer. P and source content stay unchanged.
import {fingerprint} from './assembly-identity.mjs';

const copy=structuredClone,own=(v,k)=>Object.hasOwn(v,k);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error('PERSONAL_'+code),{code:'PERSONAL_'+code});};
const text=v=>typeof v==='string'&&Boolean(v.trim())&&!v.includes('\0');
const bounded=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
function exact(v,keys,optional=[]){need(object(v)&&keys.every(k=>own(v,k))&&Object.keys(v).every(k=>keys.includes(k)||optional.includes(k)),'FIELDS');}
function namespace(v){exact(v,['character_version','conversation_id','world_id']);need(Object.values(v).every(text),'NAMESPACE');return copy(v);}
function factRef(v){exact(v,['id','revision']);need(text(v.id)&&Number.isSafeInteger(v.revision)&&v.revision>0,'FACT_REF');return copy(v);}
function signal(v){
  need(object(v)&&typeof v.known==='boolean','SIGNAL');
  exact(v,v.known?['known','value','sources']:['known','reason','sources']);
  need(Array.isArray(v.sources)&&v.sources.every(text)&&(!v.known||v.sources.length>0),'SIGNAL_SOURCES');
  need(v.known?bounded(v.value):text(v.reason),'SIGNAL_VALUE');return copy(v);
}
export const personalReferenceLevels=Object.freeze({absent:0,weak:.25,moderate:.5,strong:.75,full:1});
const definitions={
  interest:{channel:'personal.interest',mechanism:'M.interest',field:'familiar',type:'familiar_interest',key:'activity'},
  habit:{channel:'personal.habit',mechanism:'C.habit',field:'strength',type:'habit_strength',key:'habit'},
  care:{mechanism:'R.care',field:'care',type:'care_level',key:'other'},
};

/** Configuration is frozen by the existing host. Input rows never supply gains
 * or numerical strengths. The supplied levels may use an already approved book. */
export function createPersonalStateConfig(raw){
  exact(raw,['levels','care_change_gain']);
  need(object(raw.levels)&&Object.keys(raw.levels).length>0&&Object.keys(raw.levels).every(text)&&Object.values(raw.levels).every(bounded),'LEVELS');
  need(bounded(raw.care_change_gain),'CARE_GAIN');
  const config=copy(raw),channels=[];
  for(const kind of ['interest','habit']){
    const d=definitions[kind];channels.push({id:d.channel,mechanism:d.mechanism,field:d.field,type:d.type,scope:['subject',d.key],
      storage:'observation',target:null,input:{kind:'symbol',values:copy(config.levels)},gain:1});
  }
  for(const direction of ['establish','increase','decrease'])channels.push({id:'personal.care.'+direction,mechanism:'R.care',field:'care',type:'care_level',
    scope:['subject','other'],storage:'contribution',target:'model.care',input:{kind:'symbol',values:copy(config.levels)},
    gain:direction==='establish'?1:(direction==='increase'?1:-1)*config.care_change_gain});
  return {config,channels,configuration_sources:['configuration:personal-state:'+fingerprint(config)],requires_zero_unseeded_care:true};
}

/** Only a real prior or an admitted establishment establishes personal care.
 * A generic numerical cell, reliability statistic or respect is insufficient. */
export function hasPersonalCareBasis({namespace:ns,subject,other,head,prior}){
  namespace(ns);need(text(subject)&&text(other)&&subject!==other&&same(head?.namespace,ns),'CARE_BASIS_IDENTITY');
  if(prior!==undefined&&signal(prior).known)return true;
  const scope={subject,other};
  return (head.mechanism_state?.routes??[]).some(r=>r.channel_id==='personal.care.establish'&&r.mechanism==='R.care'&&r.field==='care'&&
    r.type==='care_level'&&r.target==='model.care'&&same(r.namespace,ns)&&same(r.scope,scope)&&r.current?.value?.known===true);
}

/** Existing content including this input's admitted content changes is supplied
 * through contents. The adapter constructs claims; the original writer/native
 * host still validates sources, projects values, deduplicates and commits them. */
export function buildPersonalStateProgram(raw,{head,config,care_priors={},contents=head?.contents}={}){
  exact(raw,['namespace','subject','input_id','scene_time','updates']);namespace(raw.namespace);
  need(text(raw.subject)&&text(raw.input_id)&&(raw.scene_time===null||typeof raw.scene_time==='number'&&Number.isFinite(raw.scene_time)),'IDENTITY');
  need(head&&same(head.namespace,raw.namespace)&&Array.isArray(contents)&&Array.isArray(head.mechanism_state?.observations)&&Array.isArray(head.mechanism_state?.routes),'HEAD');
  need(object(care_priors)&&Array.isArray(raw.updates),'UPDATES');
  const extension=createPersonalStateConfig(config),claims=[],instances=new Map(),seen=new Set(),updates=[];
  for(const row of raw.updates){
    exact(row,['kind','target_id','fact_ref','symbol','mode'],row.kind==='care'?['direction']:[]);
    need(own(definitions,row.kind)&&text(row.target_id)&&['new','correction'].includes(row.mode),'UPDATE');
    const d=definitions[row.kind],scope={subject:raw.subject,[d.key]:row.target_id},ref=factRef(row.fact_ref);
    need(row.symbol===null||typeof row.symbol==='string'&&own(extension.config.levels,row.symbol),'SYMBOL');
    if(row.kind==='care')need(['establish','increase','decrease'].includes(row.direction)&&row.target_id!==raw.subject,'CARE_DIRECTION');
    const key=JSON.stringify([row.kind,row.target_id]);need(!seen.has(key),'DUPLICATE_TARGET');seen.add(key);
    const records=contents.filter(c=>c.id===ref.id),record=records[0];need(records.length===1&&record.kind==='fact'&&record.owner_id===raw.subject&&same(record.namespace,raw.namespace),'FACT_AUTHORITY');
    const versions=record.history?.filter(v=>v.revision===ref.revision),version=versions?.[0];need(versions?.length===1&&object(version.body),'FACT_VERSION');
    const fact=version.body;
    need(fact.observation_id===raw.input_id&&version.source_refs?.includes(raw.input_id)&&fact.presentation==='current_report'&&
      ['observed','self_report','reported'].includes(fact.epistemic_status)&&['ongoing','completed'].includes(fact.occurrence_status)&&text(fact.occurrence_id),'CURRENT_ADMITTED_FACT');
    need(Array.isArray(fact.instance_refs)&&fact.instance_refs.some(s=>same(s,scope)),'FACT_SCOPE');
    need(fact.novelty===(row.mode==='new'?'new_evidence':'correction'),'CHANGE_MODE');
    const channel_id=row.kind==='care'?'personal.care.'+row.direction:d.channel;
    const previousRows=(row.kind==='care'?head.mechanism_state.routes:head.mechanism_state.observations)
      .filter(r=>r.mechanism===d.mechanism&&r.field===d.field&&same(r.scope,scope)&&
        (row.kind!=='care'||r.current.occurrence_id===fact.occurrence_id));
    need(previousRows.length<=1,'PREVIOUS_AMBIGUOUS');const previous=previousRows[0]?.current;
    if(row.kind==='care'){
      // model.care's generic .25 initial value is never authority for a new person.
      // The opt-in host overlays zero only for unseeded care definitions. A real
      // establishment then contributes its absolute value exactly once.
      need(Array.isArray(head.numeric?.cells),'CARE_NATIVE_STATE');
      const prior=own(care_priors,row.target_id)?signal(care_priors[row.target_id]):undefined;
      if(row.direction==='establish'){
        need(row.symbol!==null,'CARE_ESTABLISHMENT_UNKNOWN');
        const exactRetry=previous?.channel_id==='personal.care.establish'&&same(previous.fact_ref,ref);
        const establishedCorrection=row.mode==='correction'&&previous?.channel_id==='personal.care.establish';
        const noState=!head.numeric.cells.some(c=>c.target?.mechanism==='model.care'&&same(c.target.scope,scope))&&
          !head.mechanism_state.routes.some(r=>r.target==='model.care'&&same(r.scope,scope));
        need(!prior?.known&&(noState||exactRetry||establishedCorrection),'CARE_ALREADY_ESTABLISHED');
      }else{
        need(hasPersonalCareBasis({namespace:raw.namespace,subject:raw.subject,other:row.target_id,head,prior}),'CARE_BASELINE_UNKNOWN');
        need(previous?.channel_id!=='personal.care.establish','CARE_ESTABLISHMENT_DIRECTION');
      }
      if(row.mode==='new'&&previous)need(same(previous.fact_ref,ref),'CARE_EXISTING_EVENT_REQUIRES_CORRECTION');
      instances.set(fingerprint(scope),{mechanism:'model.care',scope:copy(scope)});
    }
    if(row.mode==='correction')need(previous&&previous.occurrence_id===fact.occurrence_id,'CORRECTION_TARGET');
    const duplicate=previous?.source_observation_id===raw.input_id&&same(previous.fact_ref,ref);
    const interpretation_revision=row.mode==='correction'?(duplicate?previous.interpretation_revision:previous.interpretation_revision+1):
      duplicate?previous.interpretation_revision:1;
    claims.push({id:'personal:'+fingerprint({input_id:raw.input_id,kind:row.kind,target_id:row.target_id,fact_ref:ref}),channel_id,scope,
      fact_ref:ref,symbol:row.symbol,mode:row.mode==='new'?'new_occurrence_effect':'replace_interpretation',
      meaning_id:'personal:'+row.kind,interpretation_revision,at:row.mode==='correction'?previous.at:raw.scene_time});
    updates.push({kind:row.kind,target_id:row.target_id,fact_ref:ref,channel_id,
      authority:row.kind==='care'?'independent_care_change_not_reliability':'explicit_current_personal_content'});
  }
  return {mechanism_claims:claims,instances:[...instances.values()],metadata:{updates,automatic_learning:false,profile_modified:false,
    care_without_prior:'unknown_until_explicit_establishment',semantic_review:'required_from_caller',persisted:false}};
}

/** null means no observed personal content. An actual Unknown Signal is not null
 * and must mask the profile prior. The caller keeps native calculation/assembly
 * ownership; this reader performs no numerical transformation or learning. */
export function readPersonalState({kind,target_id,subject,namespace:ns,head}){
  need(['interest','habit'].includes(kind)&&text(target_id)&&text(subject),'READ_TARGET');namespace(ns);
  need(head&&same(head.namespace,ns)&&Array.isArray(head.mechanism_state?.observations),'READ_HEAD');
  const d=definitions[kind],scope={subject,[d.key]:target_id};
  const rows=head.mechanism_state.observations.filter(r=>r.mechanism===d.mechanism&&r.field===d.field&&same(r.scope,scope));
  need(rows.length<=1,'READ_AMBIGUOUS');
  if(rows.length){const row=rows[0];need(row.channel_id===d.channel&&row.type===d.type&&same(row.namespace,ns),'READ_IDENTITY');
    return signal(row.current.value);}
  return null;
}
