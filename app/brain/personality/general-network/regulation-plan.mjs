// Pure plans for the existing lifecycle review and native deployment record.
// A structurally valid proposal is not semantic approval, adoption or an effect.
import {applyContentChanges} from './content-records.mjs';
import {fingerprint,canonical} from './assembly-identity.mjs';

const copy=structuredClone,own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k),object=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const need=(yes,code,path)=>{if(!yes)throw Object.assign(new Error(code),{code,path});};
function exact(o,keys,p){need(object(o)&&keys.every(k=>own(o,k))&&Object.keys(o).every(k=>keys.includes(k)),'REGULATION_FIELDS',p);}
function text(v,p){need(typeof v==='string'&&Boolean(v.trim())&&!v.includes('\0'),'REGULATION_TEXT',p);return v;}
function integer(v,p,positive=false){need(Number.isSafeInteger(v)&&v>=(positive?1:0),'REGULATION_REVISION',p);return v;}
function array(v,p){need(Array.isArray(v),'REGULATION_ARRAY',p);return v;}
function hash(v,p){need(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'REGULATION_HASH',p);return v;}
function ns(v,p){exact(v,['character_version','conversation_id','world_id'],p);Object.values(v).forEach(x=>text(x,p));}
function refs(v,p){const a=array(v,p).map(x=>text(x,p));need(a.length>0,'REGULATION_SOURCES',p);return [...new Set(a)];}
function ref(v,p){exact(v,['id','revision'],p);text(v.id,p);integer(v.revision,p,true);return copy(v);}
function scope(v,p){need(object(v)&&own(v,'subject'),'REGULATION_SCOPE',p);Object.entries(v).forEach(([k,x])=>{text(k,p);text(x,p);});return canonical(v);}
const tag=f=>`content:${f.id}@${f.version.revision}`;
const eventId=(namespace,meaning)=>'regulation-event:'+fingerprint({namespace,meaning});
const proposalKeys=['strategy_id','target','component','domain','direction','basis_ref','source_transaction_id'];
const deploymentKeys=['record_id','actor_id','action_ref','before_transaction_id'];
const monitorKeys=['record_id','after_transaction_id','observation_ref','verdict','causal_ref'];
const pick=(o,keys)=>Object.fromEntries(keys.map(k=>[k,copy(o[k])]));

export function describeRegulations(raw,ctx){
  exact(raw,['proposals','deployments','monitors'],'regulations');for(const k of Object.keys(raw))array(raw[k],k);
  exact(ctx,['namespace','subject','base_revision','contents','identity_registry','records','source_receipts','lifecycle_state','native_sources'],'context');
  ns(ctx.namespace,'namespace');text(ctx.subject,'subject');integer(ctx.base_revision,'base_revision');
  const c=copy(ctx),registry=c.identity_registry,state=c.lifecycle_state;
  need(registry?.schema==='asuka.semantic-identities/1'&&same(registry.namespace,c.namespace)&&registry.subject===c.subject,'REGULATION_IDENTITY_CONTEXT','identity_registry');
  need(state?.schema==='asuka.lifecycle-state/1'&&same(state.namespace,c.namespace)&&state.subject===c.subject,'REGULATION_LIFECYCLE_CONTEXT','lifecycle_state');
  function index(rows,key,p){const m=new Map();for(const r of array(rows,p)){text(r[key],p);need(!m.has(r[key]),'REGULATION_DUPLICATE_ID',p);m.set(r[key],r);}return m;}
  const entities=index(registry.entities,'id','entities'),events=index(registry.events,'id','events'),actors=index(registry.actors,'id','actors');
  need(actors.has(c.subject),'REGULATION_SUBJECT_ACTOR','actors');
  const contents=index(applyContentChanges(c.contents,[],c.namespace).records,'id','contents'),records=new Map(),receipts=new Map();
  for(const wrapper of array(c.records,'records')){
    exact(wrapper,['record','source_refs','content_refs'],'record');const r=wrapper.record;
    need(object(r)&&same(r.namespace,c.namespace),'REGULATION_RECORD_NAMESPACE','record');text(r.id,'record.id');integer(r.revision,'record.revision');
    need(!records.has(r.id),'REGULATION_DUPLICATE_ID','record');records.set(r.id,wrapper);
  }
  for(const r of array(c.source_receipts,'source_receipts')){
    exact(r,['input','sequence'],'receipt');integer(r.sequence,'receipt.sequence',true);
    need(object(r.input)&&same(r.input.namespace,c.namespace)&&object(r.input.payload),'REGULATION_RECEIPT_NAMESPACE','receipt');text(r.input.id,'receipt.id');
    need(!receipts.has(r.input.id),'REGULATION_DUPLICATE_ID','receipt');receipts.set(r.input.id,r);
  }
  const native=new Map(),nativeRevisions=new Set();
  function signal(v,tx,p){
    need(object(v)&&typeof v.known==='boolean','REGULATION_SIGNAL',p);exact(v,v.known?['known','value','sources']:['known','reason','sources'],p);
    need(same(v.sources,['regulation-readout:'+tx]),'REGULATION_NATIVE_SOURCE_TAG',p);
    if(v.known)need(typeof v.value==='number'&&Number.isFinite(v.value),'REGULATION_SIGNAL',p);else text(v.reason,p);return copy(v);
  }
  for(const source of array(c.native_sources,'native_sources')){
    exact(source,['transaction_id','revision','intent_sha256','input_id','input_sequence','scene_time','cells','readouts'],'native_source');
    text(source.transaction_id,'native_source');integer(source.revision,'native_source.revision',true);hash(source.intent_sha256,'native_source.intent_sha256');
    integer(source.input_sequence,'native_source.input_sequence',true);text(source.input_id,'native_source.input_id');
    need(source.revision<=c.base_revision,'REGULATION_NATIVE_FUTURE','native_source');
    need(source.scene_time===null||typeof source.scene_time==='number'&&Number.isFinite(source.scene_time),'REGULATION_NATIVE_TIME','native_source');
    need(receipts.get(source.input_id)?.sequence===source.input_sequence,'REGULATION_NATIVE_RECEIPT','native_source');
    need(!native.has(source.transaction_id)&&!nativeRevisions.has(source.revision),'REGULATION_NATIVE_DUPLICATE','native_source');
    const cellKeys=new Set(),readKeys=new Set();
    for(const row of array(source.cells,'native_source.cells')){
      exact(row,['target','type','signal','has_history'],'native_cell');exact(row.target,['mechanism','scope'],'native_cell.target');
      need(['model.positive','model.negative'].includes(row.target.mechanism)&&row.type===row.target.mechanism.slice('model.'.length)+'_affect',
        'REGULATION_NATIVE_TARGET_CELL','native_cell');
      exact(row.target.scope,['subject','event','concern'],'native_cell.scope');scope(row.target.scope,'native_cell.scope');
      need(row.target.scope.subject===c.subject,'REGULATION_NATIVE_CELL_SUBJECT','native_cell.scope');
      need(typeof row.has_history==='boolean','REGULATION_NATIVE_HISTORY','native_cell');signal(row.signal,source.transaction_id,'native_cell.signal');
      need(!row.signal.known||row.has_history,'REGULATION_UNRECORDED_ZERO','native_cell');
      if(row.signal.known)need(row.signal.value>=0&&row.signal.value<=1,'REGULATION_AFFECT_DOMAIN','native_cell');
      const key=fingerprint(row.target);need(!cellKeys.has(key),'REGULATION_NATIVE_CELL_DUPLICATE','native_cell');cellKeys.add(key);
    }
    for(const row of array(source.readouts,'native_source.readouts')){
      exact(row,['instance','field','type','scope','recipe','signal'],'native_readout');
      for(const k of ['instance','field','type','recipe'])text(row[k],'native_readout.'+k);scope(row.scope,'native_readout.scope');signal(row.signal,source.transaction_id,'native_readout.signal');
      const key=JSON.stringify([row.instance,row.field]);need(!readKeys.has(key),'REGULATION_NATIVE_READOUT_DUPLICATE','native_readout');readKeys.add(key);
    }
    native.set(source.transaction_id,source);nativeRevisions.add(source.revision);
  }
  const usedFacts=new Map(),usedNative=new Map(),actions=[],monitor_specs=[],deferred=[];
  const regulations={proposals:[],deployments:[],monitors:[]};let collect=false;
  function fact(reference,p){ref(reference,p);const r=contents.get(reference.id),version=r?.history.find(v=>v.revision===reference.revision);
    need(r?.kind==='fact'&&r.owner_id===c.subject&&version,'REGULATION_EXACT_OWNED_FACT',p);
    const f={id:r.id,kind:r.kind,namespace:copy(r.namespace),owner_id:r.owner_id,version:copy(version)};
    if(collect)usedFacts.set(fingerprint(reference),f);return f;
  }
  function source(tx,base,p){text(tx,p);const row=native.get(tx);need(row&&row.revision<=base,'REGULATION_NATIVE_TRANSACTION',p);
    if(collect)usedNative.set(tx,copy(row));return row;
  }
  function hasScopes(f,scopes,p){need(scopes.every(s=>f.version.body.instance_refs?.some(t=>same(s,t))),'REGULATION_FACT_SCOPE',p);}
  function actual(f,p){const b=f.version.body;
    need(['completed','ongoing'].includes(b.occurrence_status)&&['observed','self_report','reported'].includes(b.epistemic_status)&&
      b.presentation==='current_report'&&b.novelty==='new_evidence','REGULATION_ACTUAL_CURRENT_EVIDENCE',p);
    const receipt=receipts.get(b.observation_id),role=receipt?.input.payload.semantic_role??(receipt?.input.kind==='user_input'?'user':null);
    need(receipt&&f.version.source_refs.includes(b.observation_id)&&
      (receipt.input.kind==='user_input'&&role==='user'||receipt.input.kind==='external_observation'&&[null,'user','tool'].includes(role)),
      'REGULATION_INDEPENDENT_SOURCE',p);return receipt;
  }
  function nativeCell(row,definition,p){const target={mechanism:'model.'+definition.component,scope:definition.target};
    const found=row.cells.find(v=>same(v.target,target));
    // The host authenticated this exact committed snapshot. Absence does not
    // establish calm/zero and must not prevent recording a real strategy action.
    // Other well-formed episodes are not substitutes for this selected target.
    if(!found)return {known:false,reason:'no_recorded_episode',sources:['regulation-readout:'+row.transaction_id]};
    need(found.type===definition.component+'_affect','REGULATION_NATIVE_TARGET_CELL',p);
    need(!found.signal.known||found.has_history,'REGULATION_UNRECORDED_ZERO','native_cell');
    if(found.signal.known)need(found.signal.value>=0&&found.signal.value<=1,'REGULATION_AFFECT_DOMAIN',p);
    return copy(found.signal);
  }
  const sources=(facts,transactions=[])=>[...new Set([...facts.flatMap(f=>[tag(f),...f.version.source_refs]),...transactions.map(tx=>'regulation-readout:'+tx)])];
  function proposal(raw,base){
    exact(raw,proposalKeys,'proposal');text(raw.strategy_id,'proposal.strategy_id');
    need(entities.get(raw.strategy_id)?.kind==='strategy','REGULATION_STRATEGY_IDENTITY','proposal');
    exact(raw.target,['subject','event','concern'],'proposal.target');scope(raw.target,'proposal.target');
    need(raw.target.subject===c.subject&&events.has(raw.target.event),'REGULATION_TARGET_IDENTITY','proposal');
    need(['positive','negative'].includes(raw.component)&&['experience','expression'].includes(raw.domain)&&['increase','decrease','maintain'].includes(raw.direction),'REGULATION_PROPOSAL_KIND','proposal');
    const definition=copy(raw),basis=fact(raw.basis_ref,'proposal.basis_ref'),strategyScope={subject:c.subject,event:raw.target.event,strategy:raw.strategy_id};
    need(['completed','ongoing','planned'].includes(basis.version.body.occurrence_status),'REGULATION_PROPOSAL_BASIS','proposal.basis_ref');
    hasScopes(basis,[strategyScope,raw.target],'proposal.basis_ref');
    const nativeSource=source(raw.source_transaction_id,base,'proposal.source_transaction_id');
    const readiness=nativeSource.readouts.find(v=>v.instance===JSON.stringify(['strategy',raw.strategy_id])&&v.field==='fit'&&v.type==='strategy_fit'&&v.recipe==='strategy_conditions'&&same(v.scope,strategyScope));
    need(readiness,'REGULATION_STRATEGY_READOUT','proposal.source_transaction_id');
    need(!readiness.signal.known||readiness.signal.value>=0&&readiness.signal.value<=1,'REGULATION_STRATEGY_FIT_DOMAIN','proposal.source_transaction_id');
    return {record_id:'regulation:'+fingerprint({namespace:c.namespace,...canonical(definition)}),definition,commit_base_revision:base,
      source_refs:sources([basis],[nativeSource.transaction_id])};
  }
  const proposals=new Map(),deployments=new Map(),monitors=new Map(),occurrences=new Map();
  function storedProposal(id,p){const entry=proposals.get(text(id,p));need(entry,'REGULATION_PROPOSAL_REQUIRED',p);
    return proposal(entry.definition,entry.commit_base_revision);
  }
  function record(id,statuses,p){const r=records.get(id)?.record;
    need(r?.kind==='deployment'&&r.owner_id===c.subject&&same(r.namespace,c.namespace)&&statuses.includes(r.status),'REGULATION_RECORD_STATE',p);return r;
  }
  function deployment(raw,base){
    exact(raw,deploymentKeys,'deployment');need(raw.actor_id===c.subject,'REGULATION_ACTOR','deployment.actor_id');
    const p=storedProposal(raw.record_id,'deployment.record_id'),d=p.definition,f=fact(raw.action_ref,'deployment.action_ref'),r=actual(f,'deployment.action_ref');
    hasScopes(f,[{subject:c.subject,actor:c.subject,event:f.version.body.occurrence_id},{subject:c.subject,deployment:p.record_id},
      {subject:c.subject,event:d.target.event,strategy:d.strategy_id},d.target],'deployment.action_ref');
    const before=source(raw.before_transaction_id,base,'deployment.before_transaction_id');nativeCell(before,d,'deployment.before_transaction_id');
    need(before.input_sequence<=r.sequence,'REGULATION_BEFORE_ACTION_ORDER','deployment');
    return {...copy(raw),commit_base_revision:base,action_occurrence_id:f.version.body.occurrence_id,action_observation_id:f.version.body.observation_id,
      source_refs:[...new Set([...p.source_refs,...sources([f],[before.transaction_id])])],
      event_id:eventId(c.namespace,{kind:'deployment',record_id:raw.record_id,actor_id:raw.actor_id,action_ref:raw.action_ref,before_transaction_id:raw.before_transaction_id})};
  }
  const occurrenceKey=d=>{const p=proposals.get(d.record_id).definition;return fingerprint({actor_id:d.actor_id,strategy_id:p.strategy_id,target:p.target,occurrence_id:d.action_occurrence_id});};
  function monitor(raw,base){
    exact(raw,monitorKeys,'monitor');need(['unknown','effective','ineffective'].includes(raw.verdict),'REGULATION_VERDICT','monitor');
    const p=storedProposal(raw.record_id,'monitor.record_id'),d=p.definition,dep=deployments.get(raw.record_id);need(dep,'REGULATION_DEPLOYMENT_REQUIRED','monitor');
    deployment(pick(dep,deploymentKeys),dep.commit_base_revision);
    const before=source(dep.before_transaction_id,base,'monitor.before'),after=source(raw.after_transaction_id,base,'monitor.after');
    need(after.revision>=dep.commit_base_revision+1&&after.revision>before.revision,'REGULATION_AFTER_DEPLOYMENT_ORDER','monitor');
    need(before.scene_time===null||after.scene_time===null||after.scene_time>=before.scene_time,'REGULATION_SCENE_TIME_REVERSED','monitor');
    const beforeSignal=nativeCell(before,d,'monitor.before'),afterSignal=nativeCell(after,d,'monitor.after');
    const observation=fact(raw.observation_ref,'monitor.observation_ref'),receipt=actual(observation,'monitor.observation_ref');
    hasScopes(observation,[{subject:c.subject,deployment:p.record_id},d.target],'monitor.observation_ref');
    need(after.input_sequence<=receipt.sequence,'REGULATION_AFTER_OBSERVATION_ORDER','monitor');
    const action=fact(dep.action_ref,'monitor.action_ref'),actionReceipt=actual(action,'monitor.action_ref');
    need(receipt.sequence>=actionReceipt.sequence,'REGULATION_OBSERVATION_PRECEDES_ACTION','monitor.observation_ref');
    need(after.input_sequence>=actionReceipt.sequence,'REGULATION_AFTER_SOURCE_PRECEDES_ACTION','monitor.after');
    let cause=null;
    if(raw.causal_ref!==null){
      cause=fact(raw.causal_ref,'monitor.causal_ref');const causalReceipt=actual(cause,'monitor.causal_ref');
      need(causalReceipt.sequence>=actionReceipt.sequence,'REGULATION_CAUSE_PRECEDES_ACTION','monitor.causal_ref');
      need(!same(raw.causal_ref,raw.observation_ref)&&!same(raw.causal_ref,dep.action_ref)&&
        ![action.version.body.occurrence_id,observation.version.body.occurrence_id].includes(cause.version.body.occurrence_id)&&
        ![action.version.body.proposition.trim(),observation.version.body.proposition.trim()].includes(cause.version.body.proposition.trim()),
        'REGULATION_CAUSAL_COPY','monitor.causal_ref');
      hasScopes(cause,[{subject:c.subject,actor:c.subject,event:cause.version.body.occurrence_id},{subject:c.subject,deployment:p.record_id},
        {subject:c.subject,event:d.target.event,strategy:d.strategy_id},d.target],'monitor.causal_ref');
    }
    const expression=d.domain==='expression',known=raw.verdict!=='unknown',reasons=[];
    if(expression)reasons.push('expression_not_measured_by_episode_affect');
    else if(known){need(cause,'REGULATION_CAUSAL_EVIDENCE_REQUIRED','monitor');need(beforeSignal.known&&afterSignal.known,'REGULATION_KNOWN_COMPARISON_REQUIRED','monitor');}
    else reasons.push('effect_verdict_unknown');
    const id='regulation-monitor:'+fingerprint({namespace:c.namespace,normalized_monitor:raw,before_transaction_id:dep.before_transaction_id});
    return {entry:{id,...copy(raw),commit_base_revision:base,spec_id:expression?null:id,measurement:expression?'unmeasured_expression':'episode_affect',
      source_refs:[...new Set([...dep.source_refs,...sources([observation,...(cause?[cause]:[])],[before.transaction_id,after.transaction_id])])],
      event_id:!expression&&known?eventId(c.namespace,{kind:'monitor',id,verdict:raw.verdict}):null,
      disposition:!expression&&known?'assessment_ready':'observed_only',reasons},
      spec:expression?null:{id,scope:copy(d.target),component:d.component,before:beforeSignal,after:afterSignal}};
  }
  function pastBase(entry){integer(entry.commit_base_revision,'history.commit_base_revision');need(entry.commit_base_revision<c.base_revision,'REGULATION_UNCOMMITTED_HISTORY','history');}
  // Lifecycle's existing review layer authenticates these retained plans. Here
  // their exact fact versions, native read selections and derived identities are
  // rechecked without rebuilding the C++ lifecycle state machine.
  for(const review of array(state.reviews,'lifecycle_state.reviews')){
    const rows=review.plan?.regulations;if(rows===undefined)continue;exact(rows,['proposals','deployments','monitors'],'history.regulations');
    for(const entry of array(rows.proposals,'history.proposals')){
      exact(entry,['record_id','definition','commit_base_revision','source_refs'],'history.proposal');pastBase(entry);
      need(same(entry,proposal(entry.definition,entry.commit_base_revision))&&!proposals.has(entry.record_id),'REGULATION_PROPOSAL_HISTORY','history');
      record(entry.record_id,['proposed','deployed','effective','ineffective'],'history.record');proposals.set(entry.record_id,entry);
    }
    for(const entry of array(rows.deployments,'history.deployments')){
      exact(entry,[...deploymentKeys,'commit_base_revision','action_occurrence_id','action_observation_id','source_refs','event_id'],'history.deployment');pastBase(entry);
      need(same(entry,deployment(pick(entry,deploymentKeys),entry.commit_base_revision))&&!deployments.has(entry.record_id),'REGULATION_DEPLOYMENT_HISTORY','history');
      const r=record(entry.record_id,['deployed','effective','ineffective'],'history.record');
      need(r.applied_events?.some(e=>e.event_id===entry.event_id&&e.payload?.operation==='deploy'),'REGULATION_DEPLOYMENT_NATIVE_HISTORY','history');
      const key=occurrenceKey(entry);need(!occurrences.has(key),'REGULATION_DUPLICATE_ACTUAL_ACTION','history');occurrences.set(key,entry.record_id);deployments.set(entry.record_id,entry);
    }
    for(const entry of array(rows.monitors,'history.monitors')){
      exact(entry,['id',...monitorKeys,'commit_base_revision','spec_id','measurement','source_refs','event_id','disposition','reasons'],'history.monitor');pastBase(entry);
      need(same(entry,monitor(pick(entry,monitorKeys),entry.commit_base_revision).entry)&&!monitors.has(entry.id),'REGULATION_MONITOR_HISTORY','history');
      if(entry.event_id){const r=record(entry.record_id,['effective','ineffective'],'history.record');
        need(r.applied_events?.some(e=>e.event_id===entry.event_id&&e.payload?.operation===(entry.verdict==='effective'?'assess_success':'assess_failure')),'REGULATION_MONITOR_NATIVE_HISTORY','history');}
      monitors.set(entry.id,entry);
    }
  }
  collect=true;
  const newProposals=new Set(),newDeployments=new Map(),newMonitors=new Map();
  for(const rawProposal of raw.proposals){
    const entry=proposal(rawProposal,c.base_revision),old=proposals.get(entry.record_id);
    if(old||newProposals.has(entry.record_id)){deferred.push({record_id:entry.record_id,reasons:['regulation_proposal_already_registered']});continue;}
    need(!records.has(entry.record_id),'REGULATION_RECORD_CONFLICT','proposal');newProposals.add(entry.record_id);regulations.proposals.push(entry);
    actions.push({kind:'regulation_proposal',record_id:entry.record_id,record_kind:'deployment',operation:null,evidence_kind:null,base_revision:0,
      create:true,content_refs:[copy(entry.definition.basis_ref)],source_refs:copy(entry.source_refs),event_id:null});
  }
  for(const rawDeployment of raw.deployments){
    const entry=deployment(rawDeployment,c.base_revision),old=deployments.get(entry.record_id),pending=newDeployments.get(entry.record_id);
    if(old||pending){need(same(pick(old??pending,deploymentKeys),rawDeployment),'REGULATION_DEPLOYMENT_CONFLICT','deployment');deferred.push({record_id:entry.record_id,reasons:['regulation_deployment_already_registered']});continue;}
    const r=record(entry.record_id,['proposed'],'deployment');const key=occurrenceKey(entry);
    need(!occurrences.has(key),'REGULATION_DUPLICATE_ACTUAL_ACTION','deployment');occurrences.set(key,entry.record_id);newDeployments.set(entry.record_id,entry);regulations.deployments.push(entry);
    actions.push({kind:'regulation_deployment',record_id:entry.record_id,record_kind:'deployment',operation:'deploy',evidence_kind:'observed_action',base_revision:r.revision,
      create:false,content_refs:[copy(proposals.get(entry.record_id).definition.basis_ref),copy(entry.action_ref)],source_refs:copy(entry.source_refs),event_id:entry.event_id});
  }
  for(const rawMonitor of raw.monitors){
    const {entry,spec}=monitor(rawMonitor,c.base_revision);
    if(monitors.has(entry.id)||newMonitors.get(entry.record_id)?.id===entry.id){deferred.push({record_id:entry.record_id,monitor_id:entry.id,reasons:['regulation_monitor_already_registered']});continue;}
    need(!newMonitors.has(entry.record_id),'REGULATION_MONITOR_BATCH_CONFLICT','monitor');const r=record(entry.record_id,['deployed'],'monitor');
    newMonitors.set(entry.record_id,entry);regulations.monitors.push(entry);if(spec)monitor_specs.push(spec);
    if(entry.disposition==='assessment_ready')actions.push({kind:'regulation_monitor',record_id:entry.record_id,record_kind:'deployment',
      operation:entry.verdict==='effective'?'assess_success':'assess_failure',evidence_kind:'observed_effect',base_revision:r.revision,create:false,
      content_refs:[copy(rawMonitor.observation_ref),copy(rawMonitor.causal_ref)],source_refs:copy(entry.source_refs),event_id:entry.event_id});
    else deferred.push({record_id:entry.record_id,monitor_id:entry.id,reasons:copy(entry.reasons)});
  }
  return {actions,regulations,source_facts:[...usedFacts.values()].map(v=>copy(v)),native_sources:[...usedNative.values()].map(v=>copy(v)),monitor_specs,deferred};
}
