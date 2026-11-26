// Engine-only relation candidates. No semantic admission, native call, state write,
// relationship learning policy, or general-to-personal care conversion occurs here.
import {catalog as baseCatalog} from './catalog.mjs';
import {compileAssembly} from './assembly-compiler.mjs';
import {assemblyIdentity,fingerprint} from './assembly-identity.mjs';

const clone=structuredClone,own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const need=(ok,code,path)=>{if(!ok)throw Object.assign(new Error(code),{code,path});};
const text=(v,p)=>{need(typeof v==='string'&&v.trim()&&!v.includes('\0'),'RELATION_TEXT',p);return v;};
function exact(v,keys,p,optional=[]){need(object(v),'RELATION_OBJECT',p);need(keys.every(k=>own(v,k))&&Object.keys(v).every(k=>keys.includes(k)||optional.includes(k)),'RELATION_FIELDS',p);}
function list(v,p){need(Array.isArray(v),'RELATION_ARRAY',p);return v;}
function refs(v,p){const a=list(v,p).map((s,i)=>text(s,p+'.'+i));need(new Set(a).size===a.length,'RELATION_SOURCE_DUPLICATE',p);return a;}
function signal(v,p,upper=1,lower=0,allowSourceFreeKnown=false){
  need(object(v)&&typeof v.known==='boolean','RELATION_SIGNAL',p);
  exact(v,v.known?['known','value','sources']:['known','reason','sources'],p);refs(v.sources,p+'.sources');
  if(v.known){need(typeof v.value==='number'&&Number.isFinite(v.value)&&(lower===null||v.value>=lower)&&(upper===null||v.value<=upper),'RELATION_DOMAIN',p);
    need(allowSourceFreeKnown||v.sources.length>0,'RELATION_KNOWN_SOURCE',p);}
  else text(v.reason,p+'.reason');
  return clone(v);
}
function namespace(v){exact(v,['character_version','conversation_id','world_id'],'namespace');Object.values(v).forEach(x=>text(x,'namespace'));}
const relationScope=['subject','other'];
const reliabilityScope=['subject','other','dimension','criterion','criterion_revision'];
const input=port=>({input:port}),step=id=>({step:id}),parameter=name=>({parameter:name});
const port=type=>({accepts:[type],optional:false,allow_cross_scope:false});
const op=(id,operator,type,inputs,params={})=>({id,op:operator,type,inputs,params});
const identity=(id,from,type)=>op(id,'weighted_sum',type,[input(from)],{weights:[1],bias:0});
function recipe(id,mechanism,scope,inputs,parameters,steps,outputs,product_steps=[]){
  return {id,mechanism,scope,stage:'activation_field',inputs,parameters,steps,outputs,product_steps,parameter_constraints:[],
    purpose:'Explicit engine-only relation readouts; evidence meaning is supplied by the host.',
    limitations:['Unfitted engineering candidate; no automatic care learning or persistence.']};
}
export function createDailyRelationsCatalog(){
  const catalog=clone(baseCatalog);
  for(const [id,quantity]of Object.entries({general_welfare_value:'general_welfare_value',general_welfare_motive:'general_welfare_motive',available_general_help:'available_general_help'}))
    catalog.types[id]={unit:'ratio',quantity,temporal_role:'level',domain:[0,1]};
  catalog.recipes.push(recipe('daily_general_welfare_value','P.values',['subject'],{value:port('general_welfare_value')},{},
    [identity('value','value','general_welfare_value')],{value:'value'}));
  catalog.recipes.at(-1).stage='snapshot';
  catalog.recipes.push(recipe('daily_general_welfare','M.care',relationScope,
    {value:{...port('general_welfare_value'),allow_cross_scope:true},need:port('other_need'),opportunity:port('help_opportunity')},{gain:{min:0,max:1}},[
      identity('value','value','general_welfare_value'),op('relevance','product','general_welfare_motive',[input('value'),input('need')]),
      op('motive','weighted_sum','general_welfare_motive',[step('relevance')],{weights:[parameter('gain')],bias:0}),
      op('available','product','available_general_help',[step('motive'),input('opportunity')])
    ],{value:'value',motive:'motive',available:'available'},['relevance','available']));
  catalog.recipes.push(recipe('daily_personal_care','M.care',relationScope,
    {care:port('care_level'),need:port('other_need'),opportunity:port('help_opportunity')},{},[
      identity('care','care','care_level'),op('motive','product','care_motive',[input('care'),input('need')]),
      op('available','product','available_help',[step('motive'),input('opportunity')])
    ],{care:'care',motive:'motive',available:'available'},['motive','available']));
  catalog.recipes.push(recipe('daily_affiliation','M.care',relationScope,
    {attraction:port('connection_attraction'),opportunity:port('relation_opportunity')},{gain:{min:0,max:1}},[
      op('motive','weighted_sum','affiliation_drive',[input('attraction')],{weights:[parameter('gain')],bias:0}),
      op('available','product','available_connection',[step('motive'),input('opportunity')])
    ],{motive:'motive',available:'available'},['available']));
  catalog.recipes.push(recipe('daily_relation_sample_candidate','R.expectation',reliabilityScope,
    {sum:port('probability_sum'),mass:port('probability_mass'),sample_sum:port('probability_sum'),sample_mass:port('probability_mass')},{},[
      op('sum','weighted_sum','probability_sum',[input('sum'),input('sample_sum')],{weights:[1,1],bias:0}),
      op('mass','weighted_sum','probability_mass',[input('mass'),input('sample_mass')],{weights:[1,1],bias:0})
    ],{sum:'sum',mass:'mass'}));
  const read=clone(catalog.recipes.find(r=>r.id==='relation_experience'));
  read.id='daily_relation_frequency';read.scope=[...reliabilityScope];read.stage='activation_field';
  read.steps.push(identity('sum','sum','probability_sum'),identity('mass','mass','probability_mass'));
  read.outputs={history:read.outputs.history,sum:'sum',mass:'mass'};catalog.recipes.push(read);
  return catalog;
}
const selector=(instance,field)=>({instance,field});
const rowId=(kind,id)=>JSON.stringify(['daily-relations',kind,id]);
const outputKey=(id,field)=>JSON.stringify([id,field]);
const literal=(s,type,scope,pair)=>({signal:clone(s),type,scope:clone(scope),...(pair?{statistics_pair:pair}:{})});
const known=(value,sources)=>({known:true,value,sources:[...new Set(sources)]});
function wrap(catalog,request,outputs,metadata){
  const compiled=compileAssembly(request,catalog);
  return {catalog,request,outputs,metadata:{...metadata,assembly_identity:assemblyIdentity(compiled),
    parameter_status:'unfitted_engineering_candidate',persisted:false,native_executed:false,semantic_review:'not_performed',
    care_learning:false,history_authority:'host_supplied_snapshot_not_authenticated_here',
    execution_requirements:compiled.execution_requirements,
    limitations:[
      'General welfare, personal care, affiliation and friction are separate; this builder does not sum them into a global relationship score.',
      'No values, sources, event meanings or human parameters are inferred from text.',
      'Reliability is the frequency for this exact dimension and criterion version, not care, intimacy or a future guarantee.',
      'Candidate totals are not a stored update. The host must supply an authoritative paired snapshot and actual native results for the second pass.'
    ]}};
}

/** Inputs are explicitly supplied Known/Unknown signals. An outcome is already
 * designated as an actual eligible binary result by the caller; this is not a
 * language classifier or a claim that such designation is correct. */
export function buildDailyRelations(raw){
  exact(raw,['namespace','subject','relations','reliability','parameters'],'input');namespace(raw.namespace);text(raw.subject,'subject');
  exact(raw.parameters,['general_welfare_gain','affiliation_gain','reliability_sample_weight'],'parameters');
  for(const key of ['general_welfare_gain','affiliation_gain'])need(typeof raw.parameters[key]==='number'&&Number.isFinite(raw.parameters[key])&&raw.parameters[key]>=0&&raw.parameters[key]<=1,'RELATION_PARAMETER','parameters.'+key);
  need(raw.parameters.reliability_sample_weight===1,'RELATION_SAMPLE_POLICY','parameters.reliability_sample_weight');
  const catalog=createDailyRelationsCatalog(),request={namespace:clone(raw.namespace),instances:[],bindings:[]},outputs={},relations=[],reliability_reads=[];
  const allIds=new Set(),relationTargets=new Set(),statTargets=new Set();
  function unique(id,p){text(id,p);need(!allIds.has(id),'RELATION_ID_DUPLICATE',p);allIds.add(id);}
  const signalFields=['general_welfare_value','personal_care','other_need','help_opportunity','connection_appeal','contact_opportunity','respect','cooperation','friction'];
  const relationRows=list(raw.relations,'relations');
  // General welfare is one subject-level value, not a freely chosen value per
  // person. Compare every complete signal before constructing its shared node.
  const sharedValues=relationRows.map((r,i)=>signal(r?.general_welfare_value,'relations.'+i+'.general_welfare_value'));
  need(sharedValues.every(v=>same(v,sharedValues[0])),'RELATION_GENERAL_VALUE_CONFLICT','relations.general_welfare_value');
  const sharedGeneral=sharedValues.length?{subject:raw.subject,signal:clone(sharedValues[0])}:null;
  const generalValueId=rowId('general_value',raw.subject),subjectScope={subject:raw.subject};
  if(sharedGeneral)request.instances.push({id:generalValueId,recipe:'daily_general_welfare_value',scope:subjectScope,
    inputs:{value:literal(sharedGeneral.signal,'general_welfare_value',subjectScope)},parameters:{}});
  for(const [index,r]of relationRows.entries()){
    const p='relations.'+index;exact(r,['id','other_id',...signalFields],p);unique(r.id,p+'.id');text(r.other_id,p+'.other_id');need(r.other_id!==raw.subject,'RELATION_SELF',p);
    need(!relationTargets.has(r.other_id),'RELATION_SCOPE_DUPLICATE',p);relationTargets.add(r.other_id);
    const scope={subject:raw.subject,other:r.other_id},s=Object.fromEntries(signalFields.map(field=>[field,signal(r[field],p+'.'+field)]));
    const add=(kind,recipe,inputs,parameters)=>{const id=rowId(kind,r.id);request.instances.push({id,recipe,scope:clone(scope),inputs,parameters});return id;};
    const g=add('general','daily_general_welfare',{value:{output:selector(generalValueId,'value')},need:literal(s.other_need,'other_need',scope),opportunity:literal(s.help_opportunity,'help_opportunity',scope)},{gain:raw.parameters.general_welfare_gain});
    request.bindings.push({id:rowId('general_value_binding',r.id),from:{instance:generalValueId,output:'value'},to:{instance:g,input:'value'},
      source_scope:clone(subjectScope),target_scope:clone(scope),evidence_refs:s.general_welfare_value.sources.length?[...s.general_welfare_value.sources]:['configuration:daily-general-welfare-context/1']});
    const c=add('personal','daily_personal_care',{care:literal(s.personal_care,'care_level',scope),need:literal(s.other_need,'other_need',scope),opportunity:literal(s.help_opportunity,'help_opportunity',scope)},{});
    const a=add('affiliation','daily_affiliation',{attraction:literal(s.connection_appeal,'connection_attraction',scope),opportunity:literal(s.contact_opportunity,'relation_opportunity',scope)},{gain:raw.parameters.affiliation_gain});
    const t=add('stance','relation_components',{respect:literal(s.respect,'respect_level',scope),cooperation:literal(s.cooperation,'cooperation_level',scope),friction:literal(s.friction,'friction_level',scope)},{});
    for(const [name,instance,field]of [['general_welfare_value',g,'value'],['general_welfare_motive',g,'motive'],['available_general_help',g,'available'],['personal_care',c,'care'],['personal_care_motive',c,'motive'],['available_personal_help',c,'available'],['affiliation',a,'motive'],['available_contact',a,'available'],['respect',t,'respect'],['cooperation',t,'cooperation'],['friction',t,'friction']])outputs[outputKey(r.id,name)]=selector(instance,field);
    relations.push({id:r.id,scope,general_care_is_not_personal_prior:true,care_updated:false});
  }
  for(const [index,r]of list(raw.reliability,'reliability').entries()){
    const p='reliability.'+index;exact(r,['id','other_id','dimension','criterion_ref','history','sample'],p);unique(r.id,p+'.id');
    text(r.other_id,p+'.other_id');need(r.other_id!==raw.subject,'RELATION_SELF',p);text(r.dimension,p+'.dimension');
    exact(r.criterion_ref,['id','revision'],p+'.criterion_ref');text(r.criterion_ref.id,p);need(Number.isSafeInteger(r.criterion_ref.revision)&&r.criterion_ref.revision>0,'RELATION_CRITERION_REVISION',p);
    const scope={subject:raw.subject,other:r.other_id,dimension:r.dimension,criterion:r.criterion_ref.id,criterion_revision:String(r.criterion_ref.revision)};
    const scopeId=fingerprint(scope);need(!statTargets.has(scopeId),'RELATION_STATISTIC_SCOPE_DUPLICATE',p);statTargets.add(scopeId);
    exact(r.history,['sum','mass','applied_samples'],p+'.history');const sum=signal(r.history.sum,p+'.history.sum',null),mass=signal(r.history.mass,p+'.history.mass',null);
    if(sum.known&&mass.known)need(sum.value<=mass.value,'RELATION_STATISTIC_INCONSISTENT',p+'.history');
    const seen=new Map();for(const [i,entry]of list(r.history.applied_samples,p+'.history.applied_samples').entries()){
      exact(entry,['occurrence_id','outcome'],p+'.history.applied_samples.'+i);text(entry.occurrence_id,p);need(entry.outcome===0||entry.outcome===1,'RELATION_BINARY_OUTCOME',p);
      need(!seen.has(entry.occurrence_id),'RELATION_SAMPLE_ID_DUPLICATE',p);seen.set(entry.occurrence_id,entry.outcome);
    }
    let decision='no_sample',deltaSum=0,deltaMass=0,sampleSources=[],occurrence_id=null;
    if(r.sample!==null){exact(r.sample,['occurrence_id','outcome'],p+'.sample');occurrence_id=text(r.sample.occurrence_id,p+'.sample.occurrence_id');const outcome=signal(r.sample.outcome,p+'.sample.outcome');sampleSources=outcome.sources;
      if(!outcome.known)decision='unknown_outcome_no_sample';
      else{need(outcome.value===0||outcome.value===1,'RELATION_BINARY_OUTCOME',p+'.sample.outcome');
        if(seen.has(occurrence_id)){need(seen.get(occurrence_id)===outcome.value,'RELATION_SAMPLE_CONFLICT',p+'.sample');decision='already_represented';}
        else if(!sum.known||!mass.known)decision='unknown_history_no_sample';
        else{decision='candidate_new_sample';deltaSum=outcome.value;deltaMass=1;}
      }
    }
    const pair='daily.relation:'+scopeId,historyId=rowId('history',r.id),candidateId=rowId('candidate',r.id);
    request.instances.push({id:historyId,recipe:'daily_relation_frequency',scope:clone(scope),parameters:{},inputs:{sum:literal(sum,'probability_sum',scope,pair),mass:literal(mass,'probability_mass',scope,pair)}});
    // Only the unit-sample policy maps binary evidence into the two statistic
    // contribution coordinates. Addition and division are exclusively native.
    const deltaSources=decision==='candidate_new_sample'?sampleSources:['configuration:unit-observed-outcome-v1:no-update'];
    request.instances.push({id:candidateId,recipe:'daily_relation_sample_candidate',scope:clone(scope),parameters:{},inputs:{
      sum:literal(sum,'probability_sum',scope),mass:literal(mass,'probability_mass',scope),
      sample_sum:literal(known(deltaSum,deltaSources),'probability_sum',scope),sample_mass:literal(known(deltaMass,deltaSources),'probability_mass',scope)}});
    for(const field of ['history','sum','mass'])outputs[outputKey(r.id,field)]=selector(historyId,field);
    outputs[outputKey(r.id,'next_sum')]=selector(candidateId,'sum');outputs[outputKey(r.id,'next_mass')]=selector(candidateId,'mass');
    reliability_reads.push({id:r.id,scope,statistics_pair:pair,criterion_ref:clone(r.criterion_ref),decision,occurrence_id,
      sample_sources:clone(sampleSources),next_sum:selector(candidateId,'sum'),next_mass:selector(candidateId,'mass'),
      input_history:clone(r.history),proposed_sample:clone(r.sample),persisted:false});
  }
  need(request.instances.length>0,'RELATION_EMPTY_INPUT','input');
  return wrap(catalog,request,outputs,{schema:'asuka.daily-relations/1',phase:'candidate_totals',input_sha256:fingerprint(raw),parameters:clone(raw.parameters),
    parameters_sha256:fingerprint(raw.parameters),relations,shared_general_welfare:sharedGeneral,reliability_reads,reliability_sample_policy:'unit-observed-outcome-v1',
    second_pass_required:reliability_reads.length>0});
}

/** The host supplies actual first-pass native results, not JS-calculated totals.
 * This pure shape/identity check cannot authenticate native execution itself. */
export function buildDailyRelationsReliabilityRead(first,execution){
  exact(first,['catalog','request','outputs','metadata'],'first');
  need(first.metadata?.schema==='asuka.daily-relations/1'&&first.metadata.phase==='candidate_totals','RELATION_FIRST_PASS','first.metadata');
  const compiled=compileAssembly(first.request,first.catalog),identity=assemblyIdentity(compiled);
  need(first.metadata.assembly_identity===identity,'RELATION_FIRST_ASSEMBLY_CHANGED','first');
  exact(execution,['assembly_identity','evaluation_id','results'],'execution',['assembly']);text(execution.evaluation_id,'execution.evaluation_id');
  const executed=execution.assembly??compiled;
  need(object(executed)&&executed.schema===compiled.schema&&object(executed.graph)&&Array.isArray(executed.graph.nodes)&&Array.isArray(executed.graph.bindings)&&
    Array.isArray(executed.outputs)&&object(executed.types),'RELATION_NATIVE_ASSEMBLY_SHAPE','execution.assembly');
  need(execution.assembly_identity===assemblyIdentity(executed),'RELATION_NATIVE_ASSEMBLY_MISMATCH','execution');
  need(same(executed.graph.namespace,compiled.graph.namespace),'RELATION_NATIVE_NAMESPACE_MISMATCH','execution.assembly');
  // A merged graph is admissible only as an exact supergraph. Reusing the single
  // bundle hash for a different native request would conceal the actual input.
  function includeExact(required,actual,key,path){
    const entries=new Map();for(const row of actual){need(object(row),'RELATION_NATIVE_ASSEMBLY_SHAPE',path);const id=key(row);text(id,path);need(!entries.has(id),'RELATION_NATIVE_ASSEMBLY_DUPLICATE',path);entries.set(id,row);}
    for(const row of required)need(entries.has(key(row))&&same(entries.get(key(row)),row),'RELATION_NATIVE_SUBGRAPH_CHANGED',path);
  }
  includeExact(compiled.graph.nodes,executed.graph.nodes,r=>r.id,'execution.assembly.graph.nodes');
  includeExact(compiled.graph.bindings,executed.graph.bindings,r=>r.id,'execution.assembly.graph.bindings');
  includeExact(compiled.outputs,executed.outputs,r=>JSON.stringify([r.instance,r.field]),'execution.assembly.outputs');
  for(const [id,type]of Object.entries(compiled.types))need(own(executed.types,id)&&same(executed.types[id],type),'RELATION_NATIVE_SUBGRAPH_CHANGED','execution.assembly.types.'+id);
  need(same(executed.execution_requirements,compiled.execution_requirements)&&Array.isArray(executed.state_effects)&&executed.state_effects.length===0,
    'RELATION_NATIVE_READ_ONLY_REQUIRED','execution.assembly');
  const relationOutputKeys=new Set(compiled.outputs.map(row=>JSON.stringify([row.instance,row.field])));
  const allOutputs=new Map(executed.outputs.map(row=>[JSON.stringify([row.instance,row.field]),row])),allNodes=new Map(executed.graph.nodes.map(row=>[row.id,row])),provided=new Map();
  for(const [i,row]of list(execution.results,'execution.results').entries()){
    const path='execution.results.'+i;exact(row,['instance','field','scope','signal'],path);text(row.instance,path);text(row.field,path);
    const key=JSON.stringify([row.instance,row.field]),descriptor=allOutputs.get(key);need(descriptor,'RELATION_NATIVE_OUTPUT_UNKNOWN',path);
    need(!provided.has(key),'RELATION_NATIVE_OUTPUT_DUPLICATE',path);need(same(descriptor.scope,row.scope),'RELATION_NATIVE_SCOPE_MISMATCH',path);
    need(allNodes.has(descriptor.node_id)&&same(allNodes.get(descriptor.node_id).scope,row.scope),'RELATION_NATIVE_OUTPUT_DESCRIPTOR',path);
    // Other first-pass outputs may be supplied; only uncapped candidate statistic
    // results are consumed by this second graph.
    const type=executed.types[descriptor.type];need(object(type)&&Array.isArray(type.domain)&&type.domain.length===2&&type.domain.every(v=>v===null||typeof v==='number'&&Number.isFinite(v)),
      'RELATION_NATIVE_OUTPUT_TYPE',path);
    // A different module may legitimately expose a fixed graph constant with
    // no evidence sources. Relation outputs (especially the consumed pair)
    // retain the stronger provenance requirement of this builder's inputs.
    signal(row.signal,path+'.signal',type.domain[1],type.domain[0],!relationOutputKeys.has(key));
    if(row.signal.known&&type.quantity==='hard_availability')need(row.signal.value===0||row.signal.value===1,'RELATION_DOMAIN',path+'.signal');
    provided.set(key,row);
  }
  const catalog=clone(first.catalog),request={namespace:clone(first.request.namespace),instances:[]},outputs={},reads=[];
  const seenIds=new Set(),expectedCandidates=new Set(first.request.instances.filter(r=>r.recipe==='daily_relation_sample_candidate').map(r=>r.id));
  for(const row of first.metadata.reliability_reads){
    text(row.id,'metadata.reliability_reads.id');need(!seenIds.has(row.id),'RELATION_NATIVE_PAIR_DUPLICATE','metadata.reliability_reads');seenIds.add(row.id);
    const candidateId=rowId('candidate',row.id);
    need(expectedCandidates.delete(candidateId)&&same(row.next_sum,selector(candidateId,'sum'))&&same(row.next_mass,selector(candidateId,'mass')),
      'RELATION_NATIVE_PAIR_MISMATCH','metadata.reliability_reads');
    need(same(row.criterion_ref,{id:row.scope.criterion,revision:Number(row.scope.criterion_revision)})&&
      row.statistics_pair==='daily.relation:'+fingerprint(row.scope),'RELATION_NATIVE_CRITERION_MISMATCH','metadata.reliability_reads');
    const inputs={},native_sources=[];
    for(const field of ['sum','mass']){
      const select=row['next_'+field],key=JSON.stringify([select.instance,select.field]),actual=provided.get(key),descriptor=allOutputs.get(key);
      need(actual,'RELATION_NATIVE_PAIR_MISSING','execution.results');
      need(descriptor.recipe==='daily_relation_sample_candidate'&&descriptor.type===(field==='sum'?'probability_sum':'probability_mass')&&same(descriptor.scope,row.scope),
        'RELATION_NATIVE_PAIR_MISMATCH','metadata.reliability_reads');
      inputs[field]=literal(actual.signal,descriptor.type,row.scope,row.statistics_pair);native_sources.push({selector:clone(select),scope:clone(actual.scope),signal:clone(actual.signal)});
    }
    if(inputs.sum.signal.known&&inputs.mass.signal.known)need(inputs.sum.signal.value<=inputs.mass.signal.value,'RELATION_STATISTIC_INCONSISTENT','execution.results');
    const id=rowId('after',row.id);request.instances.push({id,recipe:'daily_relation_frequency',scope:clone(row.scope),inputs,parameters:{}});
    for(const field of ['history','sum','mass'])outputs[outputKey(row.id,field)]=selector(id,field);
    reads.push({id:row.id,scope:clone(row.scope),criterion_ref:clone(row.criterion_ref),decision:row.decision,native_sources});
  }
  need(expectedCandidates.size===0,'RELATION_NATIVE_PAIR_MISSING','metadata.reliability_reads');
  need(request.instances.length>0,'RELATION_NO_RELIABILITY_READ','first');
  return wrap(catalog,request,outputs,{schema:'asuka.daily-relations/1',phase:'candidate_frequency',first_assembly_identity:identity,
    executed_assembly_identity:execution.assembly_identity,merged_first_pass:execution.assembly_identity!==identity,
    evaluation_id:execution.evaluation_id,evaluation_sha256:fingerprint(execution),reliability_reads:reads,second_pass_required:false,
    native_result_boundary:'Host-supplied exact native output identities; execution is not authenticated by this pure builder.'});
}
