// Optional, frozen narration extension. JS binds identities and evidence;
// numerical evaluation and persisted effects stay in the existing C++ host.
import {fingerprint} from './assembly-identity.mjs';
import {createNarrativeCatalog} from './narrative-readout.mjs';

const clone=structuredClone,own=(o,k)=>Object.hasOwn(o,k);
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const text=s=>typeof s==='string'&&Boolean(s.trim())&&!s.includes('\0');
const bounded=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1;
const exact=(o,keys,optional=[])=>need(object(o)&&keys.every(k=>own(o,k))&&Object.keys(o).every(k=>keys.includes(k)||optional.includes(k)),'NARRATIVE_FIELDS');
export const usesNarrativePrior=config=>config?.evidence_policy==='prior_plus_known_evidence';
export const usesNarrativeActivityChoice=config=>config?.interest_policy==='explicit_component';
export const NARRATIVE_SIGNALS=['self_exposure','vulnerability','devaluation_risk','exposure_risk'];
export const NARRATIVE_SOURCES=['interest','affiliation','purpose','affirmation'];
export const NARRATIVE_EXTRA=['other_id','content_ref','positive_sources'];
export const NARRATIVE_OPTIONAL=['interest_activity_id','interest_component','purpose_goal_id','standard_ref'];
export const NARRATIVE_CONTENT_KINDS=['event','activity','goal'];
export const narrativeScope=(subject,row)=>({subject,other:row.other_id,content:JSON.stringify([row.content_ref.kind,row.content_ref.id])});

export function validateNarrativeRow(row){
  need(text(row.other_id)&&object(row.content_ref),'NARRATIVE_SCOPE');
  exact(row.content_ref,['kind','id']);
  need(NARRATIVE_CONTENT_KINDS.includes(row.content_ref.kind)&&text(row.content_ref.id),'NARRATIVE_CONTENT');
  need(row.positive_sources===null||Array.isArray(row.positive_sources)&&new Set(row.positive_sources).size===row.positive_sources.length&&row.positive_sources.every(s=>NARRATIVE_SOURCES.includes(s)),'NARRATIVE_SOURCES');
  for(const [source,key]of [['interest','interest_activity_id'],['purpose','purpose_goal_id'],['affirmation','standard_ref']]){
    need(Boolean(row.positive_sources?.includes(source))===own(row,key),'NARRATIVE_SOURCE_REFERENCE');
    if(own(row,key))need(text(row[key]),'NARRATIVE_REFERENCE');
  }
  if(own(row,'interest_component'))need(row.positive_sources?.includes('interest')&&['familiar','present'].includes(row.interest_component),'NARRATIVE_INTEREST_COMPONENT');
  if(row.signals?.self_exposure?.status==='not_applicable')for(const name of ['vulnerability','devaluation_risk'])
    need(row.signals[name]?.status==='not_applicable','NARRATIVE_PRIVATE_BRANCH_APPLICABILITY');
  // Exposure risk may concern someone else's private information, even when
  // this content reveals nothing about the speaker herself.
  return row;
}

export function narrativeInterestComponent(row,config){
  if(!usesNarrativeActivityChoice(config)){need(!own(row,'interest_component'),'NARRATIVE_INTEREST_POLICY_DISABLED');return 'familiar';}
  if(!row.positive_sources?.includes('interest'))return null;
  need(['familiar','present'].includes(row.interest_component),'NARRATIVE_INTEREST_COMPONENT_REQUIRED');return row.interest_component;
}

export function validateNarrativeConfig(raw){
  exact(raw,['schema','parameters','safety','signal_levels','symbol_rules'],['evidence_policy','interest_policy']);
  need(raw.schema==='asuka.narrative-motivation/1','NARRATIVE_CONFIG_SCHEMA');
  if(own(raw,'evidence_policy'))need(raw.evidence_policy==='prior_plus_known_evidence','NARRATIVE_EVIDENCE_POLICY');
  if(own(raw,'interest_policy'))need(raw.interest_policy==='explicit_component','NARRATIVE_INTEREST_POLICY');
  const catalog=createNarrativeCatalog({types:{},recipes:[]},{priorEstimate:usesNarrativePrior(raw),activityChoice:usesNarrativeActivityChoice(raw)});
  const recipes=catalog.recipes.filter(r=>Object.keys(r.parameters).length);
  exact(raw.parameters,recipes.map(r=>r.id));
  for(const r of recipes){
    exact(raw.parameters[r.id],Object.keys(r.parameters));
    for(const [key,spec]of Object.entries(r.parameters)){
      const v=raw.parameters[r.id][key];need(typeof v==='number'&&Number.isFinite(v)&&v>=spec.min&&v<=spec.max,'NARRATIVE_PARAMETER');
    }
    for(const c of r.parameter_constraints)if(c.kind==='sum_max')need(c.keys.reduce((n,k)=>n+raw.parameters[r.id][k],0)<=c.value+1e-12,'NARRATIVE_WEIGHT_SUM');
  }
  exact(raw.safety,['default_prior','priors','reference','accepted_gain','devalued_gain']);
  need(raw.safety.default_prior===null||bounded(raw.safety.default_prior),'NARRATIVE_SAFETY_PRIOR');
  need(object(raw.safety.priors)&&Object.entries(raw.safety.priors).every(([k,v])=>text(k)&&bounded(v)),'NARRATIVE_SAFETY_PRIORS');
  need(bounded(raw.safety.reference)&&bounded(raw.safety.accepted_gain)&&bounded(-raw.safety.devalued_gain),'NARRATIVE_SAFETY_GAIN');
  exact(raw.signal_levels,['absent','limited','clear']);
  need(raw.signal_levels.absent===0&&bounded(raw.signal_levels.limited)&&raw.signal_levels.limited>0&&raw.signal_levels.limited<1&&raw.signal_levels.clear===1,'NARRATIVE_SIGNAL_LEVELS');
  exact(raw.symbol_rules,Object.keys(catalog.types).filter(k=>!k.endsWith('_raw')));
  for(const [name,r]of Object.entries(raw.symbol_rules)){
    exact(r,['upper_bounds','labels']);need(Array.isArray(r.upper_bounds)&&Array.isArray(r.labels)&&r.labels.length===r.upper_bounds.length+1&&r.labels.every(text),'NARRATIVE_SYMBOL_RULE');
    need(r.upper_bounds.every((v,i)=>bounded(v)&&(i===0||v>r.upper_bounds[i-1])),'NARRATIVE_SYMBOL_BANDS');
  }
  return clone(raw);
}

export function narrativeCodebooks(raw){
  const c=validateNarrativeConfig(raw),level=type=>({type,symbols:clone(c.signal_levels),not_applicable:0});
  return {narratives:{self_exposure:{type:'applicability_gate',symbols:{exposed:1},not_applicable:0},
    vulnerability:level('narrative_vulnerability'),devaluation_risk:level('risk_salience'),exposure_risk:level('risk_salience')},
    acceptance_evidence:{type:'relation_safety',symbols:{accepted:1,devalued:1},not_applicable:0}};
}

export function createNarrativeStateConfig(raw,subject){
  const config=validateNarrativeConfig(raw),scope=['subject','other'],target='model.relation_safety';
  need(text(subject),'NARRATIVE_SUBJECT');
  const value=config.safety.default_prior??0; // Unavailable priors are never read as this placeholder.
  return {config,state_fields:{[target]:{type:'relation_safety',scope}},
    configuration_sources:['configuration:narrative:'+fingerprint(config)],
    definitions:[{id:target,scope,initial:value,baseline:value,anchor_time:0,half_life:null,bounds:[0,1],
      seeds:Object.entries(config.safety.priors).map(([other,prior])=>({scope:{subject,other},initial:prior,baseline:prior}))}],
    channels:['accepted','devalued'].map(symbol=>({id:'model.safety.'+symbol,mechanism:'R.safety',field:'acceptance',type:'relation_safety',scope,
      storage:'contribution',target,input:{kind:'symbol',values:{[symbol]:1}},gain:config.safety[symbol==='accepted'?'accepted_gain':'devalued_gain']}))};
}

export function hasNarrativeSafetyPrior(config,other){return own(config.safety.priors,other)||config.safety.default_prior!==null;}

export const NARRATIVE_FIELD_MEANINGS={
  self_exposure:{name:'是否显露角色自身',subject:'角色针对content_ref向other_id显露',meaning:'内容是否显露她的私人经历、自我评价或真实感受。',evidence:'明确涉及什么自身内容；公开常识或只谈他人可为not_applicable，不能从不想说倒推。'},
  vulnerability:{name:'暴露的脆弱或私密面',subject:'角色自身',meaning:'该内容涉及依赖、恐惧、私人感受或私密经历的程度，不是羞耻强度。',evidence:'具体暴露了什么，不以一般负面或拒答代替。'},
  devaluation_risk:{name:'被该对象看低的风险',subject:'other_id对角色的可能评价',meaning:'该对象知道此内容后看低角色的可能，不要求角色认同对方标准。',evidence:'对方已有态度、处境与本内容的对应；未知不当作没有风险。'},
  exposure_risk:{name:'内容外露的具体风险',subject:'该内容及其涉及的人',meaning:'内容被利用、转述或失控的具体风险；不局限于角色自身隐私。',evidence:'可指认的风险和依据，不直接输出防备或不愿讲的结论。'}
};
export const ACCEPTANCE_MEANING={name:'对方的实际接纳或贬低',subject:'other_id对角色本人',meaning:'针对角色已表达的真实想法/立场、失误或脆弱的已发生接纳/尊重或轻视/利用事件；是小幅关系安全证据。不局限于私密披露，不以narratives.self_exposure适用为前置。事件感受的appraisal与此关系证据各有用途，不互相替代。',evidence:'只用已经发生、主体明确且针对上述内容的实际反应。正常不同意见或具体纠错本身不等于贬低，一般礼貌回应不自动等于接纳；许诺不会嘲笑、角色自己的表达、记忆检索和重复叙述均不是新对待事件。'};
export const NARRATIVE_READOUT_MEANINGS={
  share_drive:'针对这个内容和对象想讲述的动力，由明确关联的兴趣、联结、自有目的和自我呈现分别支持；不是被要求回答的义务。',
  shame_level:'预期被该对象看低所形成的羞耻分量，含个人敏感度；不同于一般负面和内疚。',
  exposure_discomfort:'暴露自己脆弱或私人一面的不自在；可以与想分享同时存在，不要求自认有错。',
  guard_level:'针对这个内容和对象的防备性保留；来自具体内容风险和适用时的关系不安全感。',
  disclosure_depth:'引擎形成的、此刻愿意让该对象了解这个内容的范围；由人物既有开放程度、正向动机和保留因素合成。不是字数、句数、叙述任务或固定话术。',
  disclosure_estimate:'引擎现持的叙述范围估计。保留明确的人格起点，只用已知输入修正；来源可以是先验、事件证据或二者混合。适用条件不等于数值依据，依据齐备不代表解释正确或人物已校准；不是字数或回复指令。',
  narrative_insecurity:'安全感低于人物参考水平的部分。只在涉及自我暴露时作用，不代表所有话题都危险。',
  relation_safety:'这段关系里预期被尊重而非被利用或贬低的状态；来源区分人格先验与实际相处，不等于可靠性、关切或亲密。'
};

/** Read availability and symbols from the actual native graph. No psychological
 * values are calculated here. Internal supported contributions stay in audit. */
export function projectNarrativeEstimates(assembly,evaluation,readouts,{narratives=[],numeric}={}){
  if(!assembly||!evaluation)return [];
  const nodes=new Map(assembly.graph.nodes.map(n=>[n.id,n])),values=evaluation.graph.values;
  const cellFor=(cells,target)=>cells?.find(c=>fingerprint(c.target)===fingerprint(target));
  const resolve=ref=>{
    if(ref.literal)return ref.literal;
    if(ref.node)return values[ref.node];
    const cell=cellFor(evaluation.cells,ref.cell);
    need(cell&&Number.isFinite(cell[ref.view??'value']),'NARRATIVE_ESTIMATE_CELL');
    return {known:true,value:cell[ref.view??'value'],sources:[]};
  };
  // Trace source kinds, not psychological values. In particular a safety cell
  // contains its original anchor AND event deltas; one cannot replace the other.
  const origins=ref=>{
    if(ref.node)return [...new Set(nodes.get(ref.node).inputs.flatMap(origins))];
    if(ref.cell){
      const cell=cellFor(numeric?.cells,ref.cell);need(cell,'NARRATIVE_ESTIMATE_LEDGER');
      return [ref.cell.mechanism==='model.relation_safety'?'personality_prior':'state_anchor',
        ...(cell.ledger.some(e=>e.delta?.known)?['recorded_event_evidence']:[])];
    }
    const sources=ref.literal?.sources??[];
    return [...new Set(sources.map(s=>s.startsWith('configuration:')?'personality_prior':
      s.startsWith('state:')?'state_source':'supplied_evidence'))];
  };
  const output=(instance,field)=>assembly.outputs.find(o=>o.instance===instance&&o.field===field);
  return assembly.outputs.filter(o=>o.recipe==='narrative_depth'&&o.field==='estimate').map(out=>{
    const local=JSON.parse(out.instance)[1],key=part=>JSON.stringify(['narrative',local,part]);
    const row=narratives.find(r=>r.id===local);need(row,'NARRATIVE_ESTIMATE_SOURCE_ROW');
    const positive=nodes.get(output(key('positive'),'supported_drive').node_id),guard=nodes.get(output(key('guard'),'supported_guard').node_id);
    const privateStatus=row.signals.self_exposure.coverage,sourceStatus=name=>row.positive_sources===null?'unknown':row.positive_sources.includes(name)?'provided':'not_applicable';
    const evidence=[...NARRATIVE_SOURCES.map((name,i)=>({field:name,ref:positive.inputs[i+1],applicability:sourceStatus(name)})),
      ...[['shame','shame','devaluation_risk'],['exposure_discomfort','discomfort','vulnerability']].map(([field,port,signal])=>({field,
        ref:{node:output(key('reservation'),port).node_id},applicability:privateStatus==='not_applicable'?'not_applicable':privateStatus==='provided'?row.signals[signal].coverage:'unknown'})),
      {field:'content_risk',ref:guard.inputs[1],applicability:row.signals.exposure_risk.coverage},
      {field:'insecurity',ref:guard.inputs[2],applicability:privateStatus}];
    for(const e of evidence){e.signal=resolve(e.ref);need(typeof e.signal?.known==='boolean','NARRATIVE_ESTIMATE_COVERAGE');}
    const known=evidence.filter(e=>e.signal.known).map(e=>({field:e.field,
      value_origins:e.applicability==='not_applicable'?['applicability_only']:origins(e.ref),
      applicability:e.applicability,applicability_ref:clone(row.fact_ref),
      ...(e.field==='interest'&&row.positive_sources?.includes('interest')?{activity_id:row.interest_activity_id,component:row.interest_component??'familiar'}:{})}));
    const missing=evidence.filter(e=>!e.signal.known).map(e=>({field:e.field,reason:e.signal.reason}));
    const measured=known.some(e=>e.value_origins.some(s=>['supplied_evidence','recorded_event_evidence'].includes(s)));
    const basis=!measured?'prior_only':missing.length===0?'complete':'partial';
    const symbol=readouts.find(r=>r.instance===out.instance&&r.field==='estimate');need(symbol?.coverage==='provided','NARRATIVE_ESTIMATE_SYMBOL');
    const qualifier=basis==='prior_only'?(known.length?'按已确认适用条件沿用人格先验幅度':'沿用人格起点，尚无已知依据修正'):
      basis==='partial'?'结合部分已知依据的估计':'计算输入齐备的估计（不代表解释已核准）';
    const instances=new Set(['positive','reservation','insecurity','guard','depth'].map(key));
    const localNodes=[...nodes.values()].filter(n=>n.id.startsWith('step:')&&instances.has(JSON.parse(n.id.slice(5))[0]));
    const audit=localNodes.map(n=>({node_id:n.id,op:n.op,parameters:clone(n.params),result:clone(values[n.id]),
      inputs:n.inputs.map(ref=>({reference:clone(ref),signal:clone(resolve(ref)),value_origins:origins(ref),
        ...(ref.cell?{state:clone(cellFor(numeric.cells,ref.cell))}:{})}))}));
    return {scope:clone(out.scope),type:'disclosure_estimate',current_tendency:`${qualifier}：${symbol.current_symbol}`,
      basis,known_inputs:known,missing_evidence:missing,
      cause_refs:clone(symbol.cause_refs),meaning:'引擎当前持有的倾向估计；先验、事件账本和其他有据输入分别标明，输入不默认属于本轮新事实。适用条件可以改变哪些先验起作用，但不等于新的幅度测量。未知感受仍未知；basis描述依据覆盖，不是可信度评分。',audit};
  });
}
