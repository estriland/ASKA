import {createPersonalStateConfig} from './personal-content-state.mjs';
import {createNarrativeStateConfig} from './narrative-motivation.mjs';
import {catalog} from './catalog.mjs';
import {fingerprint} from './assembly-identity.mjs';
import {buildIdentityCatalog} from './identity-definitions.mjs';
const clone=structuredClone;
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const bounded=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1;
const level=(type,extra={})=>({type,symbols:{absent:0,limited:.4,clear:1},not_applicable:null,...extra});
const exact=(obj,keys)=>need(obj&&typeof obj==='object'&&!Array.isArray(obj)&&Object.keys(obj).sort().join('|')===[...keys].sort().join('|'),'PACKAGE_FIELDS');
function referenceRules(){return Object.fromEntries(Object.entries(catalog.types).filter(([,t])=>['level','comparison'].includes(t.temporal_role)).map(([id,t])=>[id,
  t.domain[0]===0?{upper_bounds:t.domain[1]===1?[0,.25,.7]:[0,.5,1],labels:['无该分量','较弱','中等','明显']}:
  {upper_bounds:[-.25,.25],labels:['负向','接近平衡','正向']} ]));}
export const referenceCodebooks={
  activities:{appeal:level('intrinsic_appeal'),novelty:level('raw_novelty'),comprehension:level('comprehension'),information:level('information_value'),
    attraction:level('outcome_attraction'),outcome_relevance:level('result_relevance'),risk:level('risk_salience'),cost:level('cost_salience'),experience:level('experienced_enjoyment')},
  relations:{other_need:level('other_need'),help_opportunity:level('help_opportunity'),connection_appeal:level('connection_attraction'),contact_opportunity:level('relation_opportunity'),
    respect:level('respect_level'),cooperation:level('cooperation_level'),friction:level('friction_level'),boundary:{type:'applicability_gate',symbols:{permitted:0,restricted:1},not_applicable:0}},
  needs:{condition:level('need_satisfied')},goals:{endorsement:level('endorsed_reason'),pressure:level('external_pressure')},
  means:{available:{type:'hard_availability',symbols:{available:1,blocked:0},not_applicable:null},
    adjustment:{type:'probability_adjustment',symbols:{worse:-.25,unchanged:0,better:.25},not_applicable:null},benefit:level('outcome_benefit'),cost:level('real_cost')},
  appraisals:{advancement:level('positive_consequence'),obstruction:level('negative_consequence'),applicability:{type:'applicability_gate',symbols:{applies:1,irrelevant:0},not_applicable:0},
    norm_relation:{type:'applicability_gate',symbols:{upheld:1,violated:1,at_risk:1,irrelevant:0},not_applicable:0},
    other_responsibility:level('other_responsibility'),self_responsibility:level('self_responsibility'),self_control:level('self_controllability')},
  strategies:{cost:level('control_cost'),applicable:{type:'applicability_gate',symbols:{available:1,unavailable:0},not_applicable:0}},habits:{cue:level('cue_match')},focus:{},
  resources:{capacity:level('control_capacity')},
};

/** Explicit engineering reference, not a fitted neutral or character personality. */
export function createReferencePackage(profile){
  return {schema:'asuka.general-execution-package/1',id:'general-reference',revision:1,status:'unfitted_engineering_reference',
    profile:clone(profile),codebooks:clone(referenceCodebooks),
    parameters:{activity_interest:{familiar_gain:1,present_gain:1},exploration:{gain:1},avoidance:{risk_weight:.5,cost_weight:.5},
      continuation:{engagement_weight:1,satiation_weight:-1},adoption_components:{endorsed_gain:1,pressure_gain:1},
      affiliation_motive:{social_weight:.5,shared_weight:.5},action_preparation:{positive_weight:.6,norm_weight:.4},
      revised_attention:{concern_weight:.7,residual_weight:.3},stored_affect_salience:{positive_weight:.5,negative_weight:.5}},
    motive_values:{familiar:1,present:1,exploration:1,desire:1,care:1,affiliation:1,need_pressure:1},
    dynamics:{care:{initial:.25,baseline:.25,half_life:null},engagement:{initial:0,baseline:0,half_life:600},satiation:{initial:0,baseline:0,half_life:900},
      enjoyment:{initial:0,baseline:0,half_life:600},positive:{initial:0,baseline:0,half_life:600},negative:{initial:0,baseline:0,half_life:900}},
    symbol_rules:referenceRules(),limitations:['All numerical values are explicit engineering initialization, not character calibration.','No text is generated and no voice is accepted by this package.']};
}
export function validateGeneralPackage(raw){
  exact(raw,['schema','id','revision','status','profile','codebooks','parameters','motive_values','dynamics','symbol_rules','limitations']);
  need(raw?.schema==='asuka.general-execution-package/1'&&typeof raw.id==='string'&&raw.id.length>0&&Number.isSafeInteger(raw.revision)&&raw.revision>0,'GENERAL_PACKAGE_IDENTITY');
  need(raw.status==='unfitted_engineering_reference','PACKAGE_ADMISSION_NOT_IMPLEMENTED');
  const p=raw.profile;need(p&&typeof p.subject==='string'&&p.subject.trim()&&typeof p.version==='string'&&p.version.trim(),'PROFILE_IDENTITY');
  exact(p,['subject','version','values','principles','interests','habits','relations','needs',...(Object.hasOwn(p,'known_actors')?['known_actors']:[])]);
  const objects=['values','principles','interests','habits','relations','needs'];
  for(const key of objects)need(p[key]&&typeof p[key]==='object'&&!Array.isArray(p[key]),'PROFILE_MAP_REQUIRED');
  if(Object.hasOwn(p,'known_actors'))buildIdentityCatalog(p);
  for(const key of ['values','principles','interests','habits'])for(const value of Object.values(p[key]))need(bounded(value),'PROFILE_DOMAIN');
  for(const value of Object.values(p.relations)){exact(value,['care']);need(bounded(value.care),'RELATION_PRIOR');}
  for(const value of Object.values(p.needs)){exact(value,['wanted','importance']);need(bounded(value.wanted)&&bounded(value.importance),'NEED_PROFILE');}
  for(const [id,values]of Object.entries(raw.parameters??{})){
    const r=catalog.recipes.find(r=>r.id===id);need(r,'PARAMETER_RECIPE_UNKNOWN');
    need(Object.keys(values).length===Object.keys(r.parameters).length,'PARAMETER_KEYS');
    for(const [key,spec]of Object.entries(r.parameters))need(typeof values[key]==='number'&&Number.isFinite(values[key])&&values[key]>=spec.min&&values[key]<=spec.max,'PARAMETER_DOMAIN');
    for(const constraint of r.parameter_constraints)if(constraint.kind==='sum_max')need(constraint.keys.reduce((sum,key)=>sum+values[key],0)<=constraint.value+1e-12,'PARAMETER_CONSTRAINT');
  }
  for(const r of catalog.recipes.filter(r=>Object.keys(r.parameters).length))if(['attention_priority'].includes(r.id))continue;else need(raw.parameters[r.id],'PARAMETER_RECIPE_MISSING');
  for(const key of ['familiar','present','exploration','desire','care','affiliation','need_pressure'])need(Number.isFinite(raw.motive_values?.[key])&&raw.motive_values[key]>=0,'MOTIVE_VALUATION');
  for(const key of ['care','engagement','satiation','enjoyment','positive','negative']){
    const d=raw.dynamics?.[key];exact(d,['initial','baseline','half_life']);need(d&&bounded(d.initial)&&bounded(d.baseline)&&(d.half_life===null||Number.isFinite(d.half_life)&&d.half_life>0),'DYNAMIC_DEFINITION');
  }
  for(const [group,fields]of Object.entries(referenceCodebooks)){
    need(raw.codebooks?.[group]&&Object.keys(raw.codebooks[group]).length===Object.keys(fields).length,'CODEBOOK_FIELDS');
    for(const [key,shape]of Object.entries(fields)){
      const book=raw.codebooks[group][key],t=catalog.types[shape.type];need(book?.type===shape.type&&t,'CODEBOOK_TYPE');
      need(Object.keys(book.symbols??{}).sort().join('|')===Object.keys(shape.symbols).sort().join('|'),'CODEBOOK_SYMBOLS');
      for(const value of [...Object.values(book.symbols),book.not_applicable].filter(v=>v!==null))need(typeof value==='number'&&Number.isFinite(value)&&(t.domain[0]===null||value>=t.domain[0])&&(t.domain[1]===null||value<=t.domain[1]),'CODEBOOK_DOMAIN');
      if(shape.type==='hard_availability')need(book.symbols.available===1&&book.symbols.blocked===0&&book.not_applicable===null,'HARD_AVAILABILITY_ENCODING');
      if(shape.type==='applicability_gate')need(Object.entries(shape.symbols).every(([key,value])=>book.symbols[key]===value),'GATE_ENCODING');
      if(shape.type==='applicability_gate')need(book.not_applicable===shape.not_applicable,'GATE_NOT_APPLICABLE_ENCODING');
    }
  }
  need(raw.symbol_rules&&typeof raw.symbol_rules==='object'&&!Array.isArray(raw.symbol_rules),'SYMBOL_RULES_REQUIRED');
  for(const [name,rule]of Object.entries(raw.symbol_rules)){
    const t=catalog.types[name];need(t,'SYMBOL_RULE_TYPE');exact(rule,['upper_bounds','labels']);
    need(Array.isArray(rule.upper_bounds)&&Array.isArray(rule.labels)&&rule.labels.length===rule.upper_bounds.length+1&&rule.labels.every(v=>typeof v==='string'&&v.trim()),'SYMBOL_RULE_SHAPE');
    need(rule.upper_bounds.every((v,i)=>Number.isFinite(v)&&(i===0||v>rule.upper_bounds[i-1])&&(t.domain[0]===null||v>=t.domain[0])&&(t.domain[1]===null||v<=t.domain[1])),'SYMBOL_RULE_BOUNDS');
  }
  return clone(raw);
}
export const packageIdentity=p=>fingerprint(validateGeneralPackage(p));
export function packageRuntimeConfig(raw,namespace,{personal_state=null,narrative_motivation=null}={}){
  const p=validateGeneralPackage(raw),identity=fingerprint(p),scopeBy={care:['subject','other'],engagement:['subject','activity'],satiation:['subject','activity'],
    enjoyment:['subject','event','activity'],positive:['subject','event','concern'],negative:['subject','event','concern']};
  const types={care:'care_level',engagement:'engagement_level',satiation:'satiation_level',enjoyment:'experienced_enjoyment',positive:'positive_affect',negative:'negative_affect'};
  const state_fields={},definitions=[];
  for(const [key,scope]of Object.entries(scopeBy)){
    const id='model.'+key;state_fields[id]={type:types[key],scope};const d=p.dynamics[key];
    const def={id,scope,...d,anchor_time:0,bounds:[0,1]};
    if(key==='care')def.seeds=Object.entries(p.profile.relations).map(([other,r])=>({scope:{subject:p.profile.subject,other},initial:r.care,baseline:r.care}));
    definitions.push(def);
  }
  for(const [pair,scope]of [['means',['subject','goal','means']],['relations',['subject','other','dimension']]])for(const part of ['sum','mass']){
    const id=`experience.${pair}.${part}`;state_fields[id]={type:part==='sum'?'probability_sum':'probability_mass',scope,statistics_pair:'experience.'+pair};
    definitions.push({id,scope,baseline:0,initial:0,anchor_time:0,half_life:null,bounds:[0,1]});
  }
  const channels=[
    {id:'model.need',mechanism:'M.needs',field:'satisfaction',type:'need_satisfied',scope:['subject','need'],storage:'observation',target:null,input:{kind:'symbol',values:p.codebooks.needs.condition.symbols},gain:1},
    {id:'model.control',mechanism:'C.resources',field:'capacity',type:'control_capacity',scope:['subject'],storage:'observation',target:null,input:{kind:'symbol',values:p.codebooks.resources.capacity.symbols},gain:1},
    {id:'model.enjoyment',mechanism:'M.enjoyment',field:'enjoyable',type:'experienced_enjoyment',scope:scopeBy.enjoyment,storage:'contribution',target:'model.enjoyment',input:{kind:'symbol',values:p.codebooks.activities.experience.symbols},gain:1},
    ...['positive','negative'].map(field=>({id:'model.affect.'+field,mechanism:'A.emotions',field,type:types[field],scope:scopeBy[field],storage:'contribution',target:'model.'+field,input:{kind:'assembly',recipe:'affect_components',field},gain:1}))];
  const personal=personal_state===null?null:createPersonalStateConfig(personal_state);
  if(personal){
    // A new relationship is Unknown until explicitly established. Known
    // character priors retain their original per-person seeds.
    const care=definitions.find(d=>d.id==='model.care');care.initial=0;care.baseline=0;
    channels.push(...personal.channels);
  }
  const narrative=narrative_motivation===null?null:createNarrativeStateConfig(narrative_motivation,p.profile.subject);
  if(narrative){Object.assign(state_fields,narrative.state_fields);definitions.push(...narrative.definitions);channels.push(...narrative.channels);}
  return {identity,configuration_sources:['configuration:'+identity,...(personal?.configuration_sources??[]),...(narrative?.configuration_sources??[])],state_fields,
    package:{schema:'asuka.general-kernel/1',id:p.id,revision:p.revision,namespace:clone(namespace),definitions},write_program:{schema:'asuka.mechanism-writers/1',channels}};
}
