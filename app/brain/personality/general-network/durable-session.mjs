// Candidate host. A single immutable commit marker publishes the entire bundle.
// File fsync + same-volume hard links are tested for process interruption, not power loss.
import fs from 'node:fs';
import {applyAnalyticResponses} from './analytic-response.mjs';
import path from 'node:path';
import net from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {fingerprint,canonical} from './assembly-identity.mjs';
import {NativeChannel} from './native-channel.mjs';
import {catalog} from './catalog.mjs';
import {createNarrativeCatalog} from './narrative-readout.mjs';
import {createNarrativeStateConfig,usesNarrativePrior,usesNarrativeActivityChoice} from './narrative-motivation.mjs';
import {buildExperienceWrites,validatePairedStatistics} from './experience-writes.mjs';
import {buildCandidateReadRequest,buildReadOnlyRequest} from './read-only-pass.mjs';
import {applyContentChanges,createLifecycleRecord} from './content-records.mjs';
import {scheduleFeedback,acknowledgeFeedback,eligibleFeedback} from './delayed-feedback.mjs';
import {compileAssembly} from './assembly-compiler.mjs';
import {advanceIteration} from './iteration-feedback.mjs';
import {applyMechanismRecords} from './mechanism-records.mjs';
import {validateWriteProgram,prepareMechanismWrites} from './mechanism-writes.mjs';
import {resolveObservationInputs} from './mechanism-inputs.mjs';
import {stageWorkItems,selectWorkItems} from './feedback-work.mjs';
import {emptyIdentityRegistry,applyIdentityProgram,applyInternalGoalIdentities} from './identity-program.mjs';
import {validateIdentityCatalog} from './identity-definitions.mjs';
import {emptyCriterionRegistry,applyCriterionProgram} from './criterion-registry.mjs';
import {validateOutcomeIntake} from './outcome-intake.mjs';
import {createCriterionLearningCatalog,createCriterionLearningConfig,emptyCriterionLearningState,applyCriterionLearning,buildCriterionHistoryRead} from './criterion-learning.mjs';
import {emptyLifecycleState,applyLifecycleProgram,applyLifecycleDelivery} from './lifecycle-program.mjs';
import {emptyInternalGoals,applyInternalGoals} from './internal-goals.mjs';
import {validateGeneralPackage,packageRuntimeConfig} from './general-package.mjs';
import {assemblyIdentity} from './assembly-identity.mjs';
import {emptyOutcomeCorrections,applyOutcomeCorrections,validateCorrectedFirstLearning,validateCorrectedFirstLearningDispatch,describeCorrectedFirstLearningAdmissions} from './outcome-corrections.mjs';
import {RecoveryReadCache} from './recovery-read-cache.mjs';
import {createDailySessionConfig,buildDailySessionPlan,mergeDailyCatalogs} from './daily-session.mjs';
import {applyDailyControls,readDailyEffectPolicy,policyEpoch} from './daily-controls.mjs';
import {createPositiveExperienceCatalog} from './positive-experience.mjs';
import {createGoalImportanceConfig,createGoalImportanceCatalog} from './goal-importance.mjs';

const clone=structuredClone;
const fail=(code)=>{throw Object.assign(new Error(code),{code});};
const need=(v,c)=>{if(!v)fail(c);};
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const text=x=>typeof x==='string'&&Boolean(x.trim());
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function exact(v,required,optional=[]){need(object(v),'OBJECT_REQUIRED');need(required.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k)),'FIELDS_INVALID');}
function texts(v,empty=false){need(Array.isArray(v)&&(empty||v.length>0)&&v.every(text)&&new Set(v).size===v.length,'SOURCE_IDS_INVALID');}
function namespace(v){exact(v,['character_version','conversation_id','world_id']);need(Object.values(v).every(text),'NAMESPACE_INVALID');}
function serial(v){need(Number.isSafeInteger(v)&&v>=0,'REVISION_INVALID');}
const slot=n=>String(n).padStart(16,'0');
const receiptKey=id=>fingerprint({receipt:id});
const refKey=record=>`content:${record.id}@${record.revision}`;
// Goal proposals consume their already reviewed recipe vocabulary. Private
// readout extensions must not make every unrelated committed source invalid,
// nor silently become new motivation/support channels.
const internalGoalRecipes=new Set(createCriterionLearningCatalog().recipes.map(r=>r.id));
function contentRef(contents,ref){exact(ref,['id','revision']);const r=contents.find(r=>r.id===ref.id),version=r?.history.find(v=>v.revision===ref.revision);need(version,'CONTENT_REFERENCE_STALE_OR_MISSING');return {...r,...version};}

function immutable(file,data){
  const bytes=Buffer.from(JSON.stringify(canonical(data),null,2)+'\n');
  if(fs.existsSync(file)){need(fs.readFileSync(file).equals(bytes),'IMMUTABLE_CONFLICT');return;}
  const tmp=file+'.partial-'+randomUUID();const fd=fs.openSync(tmp,'wx');
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  // Linking is atomic and fails if final already exists. Do not replace a previous artifact.
  try{fs.linkSync(tmp,file);}catch(error){if(error.code!=='EEXIST')throw error;need(fs.readFileSync(file).equals(bytes),'IMMUTABLE_CONFLICT');}
  fs.unlinkSync(tmp); // Only this freshly created exact temporary filename.
}

export async function exclusiveLease(directory){
  // Windows-only candidate: named pipe lifetime is owned by the OS, including on process kill.
  need(process.platform==='win32','WINDOWS_LEASE_REQUIRED');
  const address='\\\\.\\pipe\\asuka-general-'+fingerprint(fs.realpathSync(directory).toLowerCase());
  const server=net.createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(address,resolve);});
  return ()=>new Promise(resolve=>server.close(resolve));
}

export class DurableSession {
  #root;#config;#native;#release;#head;#marker;#genesis;#busy=false;#closed=false;#fault;#operation=null;#catalog=catalog;#lastTrace=null;
  #recoveryReads=new RecoveryReadCache();
  #verificationIndex=null;
  static async open({directory,binary,package:pkg,state_fields,write_program={schema:'asuka.mechanism-writers/1',channels:[]},configuration_sources=[],identity_subject=null,identity_catalog=null,criterion_enabled=false,criterion_learning_enabled=false,lifecycle_enabled=false,internal_goals_enabled=false,goal_model=null,outcome_correction_enabled=false,goal_confirmation_enabled=false,corrected_first_learning_enabled=false,daily_dynamics=null,positive_experience_enabled=false,goal_importance=null,personal_state=null,analytic_responses=null,narrative_motivation=null,fault=null}){
    const session=new DurableSession();
    try{await session.#open(directory,binary,clone(pkg),clone(state_fields),clone(write_program),clone(configuration_sources),identity_subject,clone(identity_catalog),criterion_enabled,criterion_learning_enabled,lifecycle_enabled,internal_goals_enabled,clone(goal_model),outcome_correction_enabled,goal_confirmation_enabled,corrected_first_learning_enabled,clone(daily_dynamics),positive_experience_enabled,clone(goal_importance),clone(personal_state),clone(analytic_responses),clone(narrative_motivation),fault);return session;}
    catch(error){await session.close();throw error;}
  }
  async #open(directory,binary,pkg,state_fields,write_program,configuration_sources,identity_subject,identity_catalog,criterion_enabled,criterion_learning_enabled,lifecycle_enabled,internal_goals_enabled,goal_model,outcome_correction_enabled,goal_confirmation_enabled,corrected_first_learning_enabled,daily_dynamics,positive_experience_enabled,goal_importance,personal_state,analytic_responses,narrative_motivation,fault){
    namespace(pkg.namespace);need(object(state_fields),'STATE_FIELDS_REQUIRED');
    texts(configuration_sources,true);need(configuration_sources.every(s=>!s.includes('\0')),'CONFIGURATION_SOURCE_INVALID');
    need(identity_subject===null||text(identity_subject)&&!identity_subject.includes('\0'),'IDENTITY_SUBJECT_INVALID');
    need(typeof criterion_enabled==='boolean','CRITERION_MODE_REQUIRED');
    need(!criterion_enabled||identity_subject!==null,'CRITERION_REQUIRES_IDENTITIES');
    need(typeof criterion_learning_enabled==='boolean','CRITERION_LEARNING_MODE_REQUIRED');
    need(!criterion_learning_enabled||criterion_enabled,'LEARNING_REQUIRES_CRITERIA');
    need(typeof lifecycle_enabled==='boolean','LIFECYCLE_MODE_REQUIRED');
    need(!lifecycle_enabled||identity_subject!==null,'LIFECYCLE_REQUIRES_IDENTITIES');
    need(typeof outcome_correction_enabled==='boolean','OUTCOME_CORRECTION_MODE_REQUIRED');
    need(!outcome_correction_enabled||criterion_learning_enabled&&lifecycle_enabled,'OUTCOME_CORRECTION_REQUIRES_LEARNING_AND_LIFECYCLE');
    need(typeof goal_confirmation_enabled==='boolean','GOAL_CONFIRMATION_MODE_REQUIRED');
    need(!goal_confirmation_enabled||outcome_correction_enabled,'GOAL_CONFIRMATION_REQUIRES_CORRECTION');
    need(typeof corrected_first_learning_enabled==='boolean','CORRECTED_FIRST_LEARNING_MODE_REQUIRED');
    need(!corrected_first_learning_enabled||outcome_correction_enabled,'CORRECTED_FIRST_LEARNING_REQUIRES_CORRECTION');
    need(typeof positive_experience_enabled==='boolean','POSITIVE_EXPERIENCE_MODE_REQUIRED');
    if(outcome_correction_enabled){
      const extension=createCriterionLearningConfig(),pair={id:'experience.criterion_means',sum:'experience.criterion_means.sum',mass:'experience.criterion_means.mass',scope:extension.state_fields['experience.criterion_means.sum'].scope};
      need(Array.isArray(pkg.statistics_pairs)&&pkg.statistics_pairs.length===1,'CORRECTION_PAIR_DECLARATION');
      const actual=clone(pkg.statistics_pairs[0]);need(Array.isArray(actual.scope),'CORRECTION_PAIR_SCOPE');
      need(same({...actual,scope:[...actual.scope].sort()},{...pair,scope:[...pair.scope].sort()}),'CORRECTION_PAIR_DECLARATION');
    }else need(!Object.hasOwn(pkg,'statistics_pairs'),'CORRECTION_PAIR_REQUIRES_MODE');
    need(typeof internal_goals_enabled==='boolean','INTERNAL_GOALS_MODE_REQUIRED');
    need(!internal_goals_enabled||lifecycle_enabled,'INTERNAL_GOALS_REQUIRES_LIFECYCLE');
    if(internal_goals_enabled){
      goal_model=validateGeneralPackage(goal_model);const modelConfig=packageRuntimeConfig(goal_model,pkg.namespace,{personal_state,narrative_motivation});
      need(goal_model.profile.subject===identity_subject&&goal_model.profile.version===pkg.namespace.character_version,'INTERNAL_GOALS_MODEL_IDENTITY');
      need(modelConfig.configuration_sources.every(s=>configuration_sources.includes(s))&&modelConfig.package.id===pkg.id&&modelConfig.package.revision===pkg.revision,'INTERNAL_GOALS_MODEL_SOURCE');
      need(modelConfig.package.definitions.every(d=>same(pkg.definitions.find(x=>x.id===d.id),d))&&same(modelConfig.write_program,write_program),'INTERNAL_GOALS_MODEL_CONFIG');
      need(Object.entries(modelConfig.state_fields).every(([id,f])=>same(state_fields[id],f)),'INTERNAL_GOALS_MODEL_FIELDS');
    }else need(goal_model===null,'INTERNAL_GOALS_MODEL_UNEXPECTED');
    if(criterion_learning_enabled){
      this.#catalog=createCriterionLearningCatalog();const extension=createCriterionLearningConfig();
      for(const [id,field]of Object.entries(extension.state_fields))need(same(state_fields[id],field),'CRITERION_LEARNING_FIELD_REQUIRED');
      for(const definition of extension.definitions)need(same(pkg.definitions.find(d=>d.id===definition.id),definition),'CRITERION_LEARNING_DEFINITION_REQUIRED');
    }
    if(daily_dynamics!==null){
      need(identity_subject!==null,'DAILY_SUBJECT_REQUIRED');const extension=createDailySessionConfig(daily_dynamics,pkg.namespace,identity_subject);
      need(extension.definitions.every(d=>same(pkg.definitions.find(x=>x.id===d.id),d)),'DAILY_DEFINITION_REQUIRED');
      need(Object.entries(extension.state_fields).every(([id,f])=>same(state_fields[id],f)),'DAILY_FIELDS_REQUIRED');
      need(extension.configuration_sources.every(s=>configuration_sources.includes(s)),'DAILY_CONFIG_SOURCES_REQUIRED');
      need(!write_program.channels.some(c=>c.target?.startsWith('daily.')),'DAILY_LEGACY_WRITER_FORBIDDEN');
      this.#catalog=mergeDailyCatalogs(this.#catalog,extension.catalog);daily_dynamics=extension.config;
    }
    if(goal_importance!==null){
      const extension=createGoalImportanceConfig(goal_importance);goal_importance=extension.config;
      need(extension.configuration_sources.every(s=>configuration_sources.includes(s)),'GOAL_IMPORTANCE_CONFIG_SOURCES_REQUIRED');
      this.#catalog=createGoalImportanceCatalog(this.#catalog);
    }
    if(narrative_motivation!==null){
      need(identity_subject!==null,'NARRATIVE_IDENTITIES_REQUIRED');
      const extension=createNarrativeStateConfig(narrative_motivation,identity_subject);narrative_motivation=extension.config;
      need(extension.definitions.every(d=>same(pkg.definitions.find(x=>x.id===d.id),d)),'NARRATIVE_DEFINITIONS');
      need(Object.entries(extension.state_fields).every(([k,v])=>same(state_fields[k],v)),'NARRATIVE_STATE_FIELDS');
      need(extension.channels.every(c=>same(write_program.channels.find(x=>x.id===c.id),c)),'NARRATIVE_WRITERS');
      need(extension.configuration_sources.every(s=>configuration_sources.includes(s)),'NARRATIVE_CONFIG_SOURCES');
      this.#catalog=createNarrativeCatalog(this.#catalog,{priorEstimate:usesNarrativePrior(narrative_motivation),activityChoice:usesNarrativeActivityChoice(narrative_motivation)});
    }
    if(positive_experience_enabled)this.#catalog=createPositiveExperienceCatalog(this.#catalog);
    if(analytic_responses!==null){const extension=applyAnalyticResponses(this.#catalog,analytic_responses);
      this.#catalog=extension.catalog;analytic_responses=extension.config;
      need(extension.configuration_sources.every(s=>configuration_sources.includes(s)),'ANALYTIC_CONFIG_SOURCES');}

    if(identity_catalog!==null){need(identity_subject!==null,'IDENTITY_SUBJECT_REQUIRED');validateIdentityCatalog(identity_catalog,{namespace:pkg.namespace,subject:identity_subject});}
    this.#root=path.resolve(directory);fs.mkdirSync(this.#root,{recursive:true});
    this.#release=await exclusiveLease(this.#root);this.#fault=fault;
    for(const name of ['receipts','prepared','prepared-seals','finalized','finalized-seals','decisions','commits','trace'])fs.mkdirSync(path.join(this.#root,name),{recursive:true});
    const binaryHash=createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    validateWriteProgram(write_program,state_fields,this.#catalog);
    this.#config={schema:'asuka.general-host-config/2',package:clone(pkg),state_fields:clone(state_fields),write_program,
      configuration_sources:[...configuration_sources].sort(),native_sha256:binaryHash,catalog_sha256:fingerprint(this.#catalog),
      ...(identity_subject===null?{}:{identity_subject}),...(identity_catalog===null?{}:{identity_catalog}),...(criterion_enabled?{criterion_enabled:true}:{}),
      ...(criterion_learning_enabled?{criterion_learning_enabled:true,criterion_learning_policy:createCriterionLearningConfig().policy}:{}),
      ...(lifecycle_enabled?{lifecycle_enabled:true}:{}),...(internal_goals_enabled?{internal_goals_enabled:true,internal_goal_policy:'typed-reasons-native-witness-v1',goal_model}:{}),
      ...(outcome_correction_enabled?{outcome_correction_enabled:true,outcome_correction_policy:'atomic-reviewed-criterion-correction-v1'}:{}),
      ...(goal_confirmation_enabled?{goal_confirmation_enabled:true,goal_confirmation_policy:'independent-reviewed-completion-v1'}:{}),
      ...(corrected_first_learning_enabled?{corrected_first_learning_enabled:true,corrected_first_learning_policy:'reviewed-first-sample-after-correction-v1'}:{}),
      ...(daily_dynamics!==null?{daily_dynamics,daily_policy:'observed-interval-and-relation-v1'}:{}),
      ...(personal_state!==null?{personal_state:clone(personal_state)}:{}),
      ...(narrative_motivation!==null?{narrative_motivation:clone(narrative_motivation)}:{}),
      ...(analytic_responses!==null?{analytic_responses:clone(analytic_responses)}:{}),
      ...(positive_experience_enabled?{positive_experience_enabled:true,positive_experience_policy:'m-enjoyment-readiness-v1'}:{}),
      ...(goal_importance===null?{}:{goal_importance})};
    immutable(this.#file('config.json'),this.#config);
    const channel_id=randomUUID();let sequence=0;
    this.#native=new NativeChannel(binary,row=>{
      const file=channel_id+'-'+slot(++sequence)+'.json',record={channel_id,sequence,...row};
      immutable(this.#file('trace',file),record);this.#lastTrace={file,sha256:fingerprint(record)};
    });
    const health=await this.#native.call({op:'health'});need(health.capabilities.includes('evaluate-candidate-v1'),'NATIVE_CAPABILITY_REQUIRED');
    if(usesNarrativePrior(narrative_motivation))need(health.capabilities.includes('narrative-prior-estimate-v1'),'NARRATIVE_PRIOR_NATIVE_REQUIRED');
    if(outcome_correction_enabled)need(['outcome-correction-v1','paired-sample-membership-v1'].every(c=>health.capabilities.includes(c)),'CORRECTION_NATIVE_CAPABILITY_REQUIRED');
    if(goal_confirmation_enabled)need(health.capabilities.includes('reviewed-goal-confirmation-v1'),'GOAL_CONFIRMATION_NATIVE_CAPABILITY_REQUIRED');
    if(daily_dynamics!==null)need(health.capabilities.includes('interval-dynamics-v1'),'DAILY_NATIVE_CAPABILITY_REQUIRED');
    const initial=await this.#native.call({op:'load',package:pkg});
    const genesis={schema:'asuka.general-host-state/2',namespace:clone(pkg.namespace),revision:0,numeric:initial,contents:[],records:[],mechanism_records:[],mechanism_state:{observations:[],routes:[]},work_items:[],replies:[],jobs:[],consumed_inputs:[],
      ...(identity_catalog===null&&!lifecycle_enabled?{}:{identity_registry:emptyIdentityRegistry(pkg.namespace,identity_subject,{identity_catalog})}),
      ...(criterion_enabled?{criterion_registry:emptyCriterionRegistry(pkg.namespace,identity_subject),outcome_records:[]}:{}),
      ...(criterion_learning_enabled?{criterion_learning_state:emptyCriterionLearningState(pkg.namespace,identity_subject)}:{}),
      ...(lifecycle_enabled?{lifecycle_state:emptyLifecycleState(pkg.namespace,identity_subject)}:{}),
      ...(internal_goals_enabled?{internal_goals:emptyInternalGoals(pkg.namespace,identity_subject)}:{}),
      ...(outcome_correction_enabled?{outcome_corrections:emptyOutcomeCorrections(pkg.namespace,identity_subject)}:{})};
    immutable(this.#file('genesis.json'),genesis);this.#genesis=genesis;
    this.#validateStatistics(genesis.numeric);
    this.#recover();
    this.recoverDecided();
    await this.#native.call({op:'load',package:pkg,state:this.#head.numeric});
  }
  #file(...parts){return path.join(this.#root,...parts);}
  #assertOpen(){need(!this.#closed&&this.#native,'SESSION_CLOSED');}
  #assertIdle(){this.#assertOpen();need(!this.#busy,'HOST_BUSY');}
  #read(file){return this.#recoveryReads.readJson(file);}
  #names(directory){return this.#recoveryReads.names(directory);}
  #exists(file){return this.#recoveryReads.exists(file);}
  #recover(){
    const recovered=this.#recoveryReads.recover(()=>this.#recoverVerified());
    this.#head=recovered.head;this.#marker=recovered.marker;
  }
  #recoverVerified(){
    // Derived indexes live only within this audited, synchronous verification.
    // RecoveryReadCache still rereads every recorded dependency before reuse
    // and before publishing the result; its public repeated-read guards stay.
    this.#verificationIndex={};
    try{
    // A warm result may only be reused while the actual bytes, directory
    // queries and negative-path checks used by full verification are unchanged.
    // These two frozen anchors also remain disk dependencies during this process.
    need(same(this.#read(this.#file('config.json')),this.#config),'FROZEN_CONFIG_CHANGED');
    need(same(this.#read(this.#file('genesis.json')),this.#genesis),'FROZEN_GENESIS_CHANGED');
    let current=clone(this.#genesis),previous=fingerprint(current);const transactions=new Set();
    for(const name of this.#names(this.#file('commits'))){
      const marker=this.#read(this.#file('commits',name));
      need(name===slot(current.revision+1)+'.json'&&marker.revision===current.revision+1&&marker.previous===previous,'COMMIT_CHAIN_INVALID');
      need(text(marker.transaction_id)&&!transactions.has(marker.transaction_id),'TRANSACTION_DUPLICATE');
      const intent=this.#read(this.#intentPath(marker.transaction_id));
      need(fingerprint(intent)===marker.intent_sha256&&intent.transaction_id===marker.transaction_id&&intent.base_revision===current.revision,'COMMIT_INTENT_MISMATCH');
      this.#validateIntent(intent,current);
      const decision=this.#decision(marker.transaction_id);need(decision?.action==='commit'&&decision.intent_sha256===marker.intent_sha256,'COMMIT_DECISION_MISSING');
      current=intent.bundle;previous=fingerprint(marker);transactions.add(marker.transaction_id);
    }
    return {head:current,marker:previous};
    }finally{this.#verificationIndex=null;}
  }
  #receiptInputs(){
    if(this.#verificationIndex?.receipts)return this.#verificationIndex.receipts;
    const rows=this.#names(this.#file('receipts')).map(name=>this.#read(this.#file('receipts',name)).input);
    if(this.#verificationIndex)this.#verificationIndex.receipts=rows;return rows;
  }
  #baseIntentPath(id){return this.#file('prepared',fingerprint({transaction:id})+'.json');}
  #finalIntentPath(id){return this.#file('finalized',fingerprint({transaction:id})+'.json');}
  #intentPath(id){const finalized=this.#finalIntentPath(id);return this.#exists(finalized)?finalized:this.#baseIntentPath(id);}
  #baseSealPath(id){return this.#file('prepared-seals',fingerprint({transaction:id})+'.json');}
  #finalSealPath(id){return this.#file('finalized-seals',fingerprint({transaction:id})+'.json');}
  #sealPath(id){return this.#exists(this.#finalIntentPath(id))?this.#finalSealPath(id):this.#baseSealPath(id);}
  #verifySeal(intent,{original=false}={}){
    const finalized=!original&&this.#exists(this.#finalIntentPath(intent.transaction_id));
    need(Object.hasOwn(intent,'finalization')===finalized,'FINALIZATION_SHAPE_MISMATCH');
    const file=original?this.#baseSealPath(intent.transaction_id):this.#sealPath(intent.transaction_id);
    need(this.#exists(file),finalized?'FINALIZATION_INCOMPLETE':'PREPARE_INCOMPLETE');
    const seal=this.#read(file);
    need(seal.transaction_id===intent.transaction_id&&seal.intent_sha256===fingerprint(intent),finalized?'FINALIZED_INTENT_CHANGED':'PREPARED_INTENT_CHANGED');
  }
  #validateIntent(intent,current){
    this.#verifySeal(intent);
    if(Object.hasOwn(intent,'finalization')){
      const original=this.#read(this.#baseIntentPath(intent.transaction_id));
      this.#verifySeal(original,{original:true});this.#validateIntentCore(original,current);
      const expected=this.#withFinalReply(original,intent.finalization);
      need(same(intent,expected),'FINALIZATION_SCOPE_CHANGED');
    }
    this.#validateIntentCore(intent,current);
  }
  #validateIntentCore(intent,current){
    need(intent.schema==='asuka.general-host-intent/2'&&intent.request_hash===fingerprint(intent.request)&&intent.request.transaction_id===intent.transaction_id,'INTENT_REQUEST_MISMATCH');
    this.#requireSupportedRecordEvents(intent.request.record_events);
    need(intent.input_id===intent.request.input_id&&intent.input_sha256===fingerprint(this.#read(this.#file('receipts',receiptKey(intent.input_id)+'.json'))),'INPUT_RECEIPT_CHANGED');
    need(intent.base_revision===current.revision&&intent.base_hash===fingerprint(current)&&intent.bundle.revision===current.revision+1&&intent.bundle.numeric.revision===current.revision+1,'BUNDLE_REVISION_MISMATCH');
    need(same(intent.bundle.numeric,intent.numeric_preparation.candidate_state),'NUMERIC_CANDIDATE_MISMATCH');
    need(same(intent.bundle.namespace,this.#config.package.namespace),'NAMESPACE_MISMATCH');
    const daily=this.#dailyPlan(current,intent.request);
    const controls=this.#dailyControlsTransition(current,intent.request);
    if(controls.present)need(same(intent.bundle.daily_controls,controls.state),'DAILY_CONTROLS_STATE_MISMATCH');
    else need(!Object.hasOwn(intent.bundle,'daily_controls'),'DAILY_CONTROLS_STATE_UNEXPECTED');
    need(controls.active?intent.daily_controls_dispatch===true:!Object.hasOwn(intent,'daily_controls_dispatch'),'DAILY_CONTROLS_DISPATCH_WITNESS');
    if(controls.active){
      for(const field of ['contents','records','mechanism_state','mechanism_records','work_items','replies','jobs'])need(same(intent.bundle[field],current[field]),'DAILY_CONTROLS_SIDE_EFFECT');
      need(same(intent.bundle.numeric.cells,current.numeric.cells)&&intent.bundle.numeric.scene_time===current.numeric.scene_time,'DAILY_CONTROLS_NUMERIC_EFFECT');
    }
    need(same(intent.daily_plan??null,daily.active?{outputs:daily.outputs,metadata:daily.metadata}:null),'DAILY_PLAN_MISMATCH');
    if(daily.active){
      for(const field of ['records','mechanism_state','mechanism_records','work_items','replies','jobs'])need(same(intent.bundle[field],current[field]),'DAILY_UNRELATED_SIDE_EFFECT');
    }
    if(this.#config.internal_goals_enabled||this.#config.outcome_correction_enabled||this.#config.daily_dynamics||
      this.#config.positive_experience_enabled||this.#config.goal_importance||this.#config.lifecycle_enabled&&Object.hasOwn(intent,'native_numeric_witness')){
      if(intent.evaluation){
        const w=intent.native_evaluation_witness;need(w&&/^[a-f0-9-]{36}-\d{16}\.json$/.test(w.file),'NATIVE_EVALUATION_WITNESS_REQUIRED');
        const trace=this.#read(this.#file('trace',w.file));need(fingerprint(trace)===w.sha256,'NATIVE_EVALUATION_TRACE_CHANGED');
        const expected=buildCandidateReadRequest(intent.assembly,this.#config.package,intent.numeric_preparation,this.#catalog);
        need(same(trace.request,expected)&&trace.response.ok===true&&same(JSON.parse(trace.raw_response),trace.response)&&
          same(trace.response.result,intent.evaluation),'NATIVE_EVALUATION_MISMATCH');
      }else need(!Object.hasOwn(intent,'native_evaluation_witness'),'NATIVE_EVALUATION_WITNESS_UNEXPECTED');
    }else need(!Object.hasOwn(intent,'native_evaluation_witness'),'NATIVE_EVALUATION_WITNESS_UNEXPECTED');
    const identity=this.#identityTransition(current,intent.request,intent.identity_source_ids);
    if(identity.present)need(Object.hasOwn(intent.bundle,'identity_registry')&&same(intent.bundle.identity_registry,identity.registry),'IDENTITY_REGISTRY_MISMATCH');
    else need(!Object.hasOwn(intent.bundle,'identity_registry'),'IDENTITY_REGISTRY_UNEXPECTED');
    if(Object.hasOwn(intent.request,'identity_program')){
      need(Object.hasOwn(intent,'identity_source_ids')&&Object.hasOwn(intent,'identity_bindings'),'IDENTITY_WITNESS_REQUIRED');
      need(same(intent.identity_bindings,identity.bindings),'IDENTITY_BINDINGS_MISMATCH');
    }else need(!Object.hasOwn(intent,'identity_source_ids')&&!Object.hasOwn(intent,'identity_bindings'),'IDENTITY_WITNESS_UNEXPECTED');
    const internalGoals=this.#internalGoalTransition(current,intent.request);
    if(internalGoals.present){
      need(same(intent.bundle.internal_goals,internalGoals.state),'INTERNAL_GOALS_STATE_MISMATCH');
      need(same(intent.internal_goal_witness??null,internalGoals.witness??null),'INTERNAL_GOALS_WITNESS_MISMATCH');
      if(internalGoals.active){
        for(const name of ['contents','records','mechanism_records','mechanism_state','work_items','replies','jobs','lifecycle_state'])need(same(intent.bundle[name],current[name]),'INTERNAL_GOALS_ADMIN_SIDE_EFFECT');
        need(same(intent.bundle.numeric.cells,current.numeric.cells),'INTERNAL_GOALS_NUMERIC_EFFECT');
      }
    }else need(!Object.hasOwn(intent.bundle,'internal_goals')&&!Object.hasOwn(intent,'internal_goal_witness'),'INTERNAL_GOALS_STATE_UNEXPECTED');
    const criteria=this.#criterionTransition(current,intent.request);
    if(criteria.present){
      need(same(intent.bundle.criterion_registry,criteria.registry),'CRITERION_REGISTRY_MISMATCH');
      need(same(intent.criterion_review_receipt??null,criteria.witness??null),'CRITERION_REVIEW_WITNESS_MISMATCH');
      const contents=applyContentChanges(current.contents,intent.request.content_changes,this.#config.package.namespace).records;
      need(same(contents,intent.bundle.contents),'OUTCOME_CONTENT_MISMATCH');
      const outcome=this.#outcomeTransition(current,intent.request,contents,identity);
      need(same(intent.outcome_projection??null,outcome.projection),'OUTCOME_PROJECTION_MISMATCH');
      need(same(intent.bundle.outcome_records,outcome.records),'OUTCOME_RECORDS_MISMATCH');
      if(Object.hasOwn(intent.request,'criterion_program')){
        for(const name of ['contents','records','mechanism_records','mechanism_state','work_items','replies','jobs'])need(same(intent.bundle[name],current[name]),'CRITERION_REVIEW_SIDE_EFFECT');
        need(same(intent.bundle.numeric.cells,current.numeric.cells),'CRITERION_REVIEW_NUMERIC_EFFECT');
      }
    }else{
      need(!Object.hasOwn(intent.bundle,'criterion_registry')&&!Object.hasOwn(intent.bundle,'outcome_records'),'CRITERION_STATE_UNEXPECTED');
      need(!Object.hasOwn(intent,'criterion_review_receipt')&&!Object.hasOwn(intent,'outcome_projection'),'CRITERION_WITNESS_UNEXPECTED');
    }
    const learning=this.#learningTransition(current,intent.request);
    if(learning.present){
      need(same(intent.bundle.criterion_learning_state,learning.state),'CRITERION_LEARNING_STATE_MISMATCH');
      need(same(intent.learning_review_receipt??null,learning.witness??null),'LEARNING_REVIEW_WITNESS_MISMATCH');
      need(same(intent.learning_work_items??[],learning.work_items),'LEARNING_WORK_MISMATCH');
      need(same(intent.learning_deferred??[],learning.deferred??[]),'LEARNING_DEFERRED_MISMATCH');
      if(Object.hasOwn(intent.request,'criterion_learning_program')){
        for(const name of ['contents','records','mechanism_records','mechanism_state','replies','outcome_records'])need(same(intent.bundle[name],current[name]),'LEARNING_REVIEW_SIDE_EFFECT');
        need(same(intent.bundle.numeric.cells,current.numeric.cells),'LEARNING_REVIEW_NUMERIC_EFFECT');
        const work=stageWorkItems(current.work_items,learning.work_items,{namespace:this.#config.package.namespace,transaction_id:intent.transaction_id,contents:current.contents});
        need(same(intent.bundle.work_items,work.items),'LEARNING_WORK_STATE_MISMATCH');
        need(same(intent.bundle.jobs,this.#reviewJobs(current.jobs,work.proposals,this.#context(intent,'prepared'))),'LEARNING_JOBS_MISMATCH');
      }
    }else need(!Object.hasOwn(intent.bundle,'criterion_learning_state')&&!Object.hasOwn(intent,'learning_review_receipt')&&!Object.hasOwn(intent,'learning_work_items')&&!Object.hasOwn(intent,'learning_deferred'),'LEARNING_STATE_UNEXPECTED');
    const correction=this.#outcomeCorrectionTransition(current,intent.request);
    if(correction.present){
      need(same(intent.bundle.outcome_corrections,correction.state),'OUTCOME_CORRECTION_STATE_MISMATCH');
      need(same(intent.outcome_correction_plan??null,correction.active?this.#outcomeCorrectionWitness(correction):null),'OUTCOME_CORRECTION_PLAN_MISMATCH');
      if(correction.active){
        for(const key of ['contents','identity_registry','criterion_registry','outcome_records','criterion_learning_state','lifecycle_state','mechanism_records','mechanism_state','work_items','replies','jobs'])
          need(same(intent.bundle[key],current[key]),'OUTCOME_CORRECTION_SIDE_EFFECT');
      }
      this.#validateNumericWitness(intent,current,correction,daily);
    }else{
      need(!Object.hasOwn(intent.bundle,'outcome_corrections')&&!Object.hasOwn(intent,'outcome_correction_plan')&&
        (this.#config.daily_dynamics||this.#config.lifecycle_enabled||this.#config.positive_experience_enabled||this.#config.goal_importance||!Object.hasOwn(intent,'native_numeric_witness')),'OUTCOME_CORRECTION_STATE_UNEXPECTED');
      if(this.#config.daily_dynamics||this.#config.positive_experience_enabled||this.#config.goal_importance||this.#config.lifecycle_enabled&&Object.hasOwn(intent,'native_numeric_witness'))this.#validateNumericWitness(intent,current,correction,daily);
    }
    const lifecycle=this.#lifecycleTransition(current,intent.request);
    for(const spec of [...intent.request.record_creations,...(lifecycle.record_creations??[])])this.#checkInternalGoalCreation(spec,lifecycle,current);
    if(lifecycle.present){
      need(same(intent.bundle.lifecycle_state,lifecycle.state),'LIFECYCLE_STATE_MISMATCH');
      need(same(intent.lifecycle_plan,this.#lifecycleWitness(lifecycle)),'LIFECYCLE_PLAN_MISMATCH');
      this.#validateLifecycleRecords(intent,current,{...lifecycle,record_events:[...lifecycle.record_events,...correction.record_events]});
      if(lifecycle.active){
        for(const name of ['contents','mechanism_records','mechanism_state','work_items','replies','jobs'])need(same(intent.bundle[name],current[name]),'LIFECYCLE_ADMIN_SIDE_EFFECT');
        need(same(intent.bundle.numeric.cells,current.numeric.cells),'LIFECYCLE_ADMIN_NUMERIC_EFFECT');
        if(lifecycle.monitor_assembly)need(same(intent.assembly,lifecycle.monitor_assembly),'REGULATION_MONITOR_ASSEMBLY');
      }
    }else need(!Object.hasOwn(intent.bundle,'lifecycle_state')&&!Object.hasOwn(intent,'lifecycle_plan')&&!Object.hasOwn(intent,'lifecycle_native_records'),'LIFECYCLE_STATE_UNEXPECTED');
    this.#validateStatistics(intent.bundle.numeric);
    applyContentChanges(intent.bundle.contents,[],this.#config.package.namespace);
    applyMechanismRecords(intent.bundle.mechanism_records,[],intent.bundle.contents,this.#config.package.namespace,{phase:'observation'});
    scheduleFeedback(intent.bundle.jobs,[],this.#context(intent,'committed'));
  }
  #identityTransition(current,request,sourceIds){
    if(Object.hasOwn(request,'internal_goal_program')){
      const goals=this.#internalGoalTransition(current,request);return {present:true,registry:goals.registry};
    }
    if(!Object.hasOwn(request,'identity_program'))return Object.hasOwn(current,'identity_registry')?
      {present:true,registry:clone(current.identity_registry)}:{present:false};
    need(text(this.#config.identity_subject),'IDENTITY_SUBJECT_REQUIRED');
    need(object(request.identity_program)&&request.identity_program.input_id===request.input_id,'IDENTITY_INPUT_MISMATCH');
    const inputs=this.#receiptInputs();
    for(const input of inputs)need(same(input.namespace,this.#config.package.namespace),'IDENTITY_SOURCE_NAMESPACE');
    const receipts=new Map(inputs.map(input=>[input.id,input]));
    const selected=sourceIds??[...receipts.values()].filter(input=>typeof input.payload.text==='string').map(input=>input.id).sort();
    texts(selected,true);
    const sources=selected.map(id=>{
      const input=receipts.get(id);need(input&&typeof input.payload.text==='string','IDENTITY_SOURCE_RECEIPT_REQUIRED');
      return {id,text:input.payload.text,...(Object.hasOwn(input.payload,'semantic_role')?{role:input.payload.semantic_role}:{})};
    });
    const previous=Object.hasOwn(current,'identity_registry')?current.identity_registry:
      emptyIdentityRegistry(this.#config.package.namespace,this.#config.identity_subject,{identity_catalog:this.#config.identity_catalog});
    const result=applyIdentityProgram(previous,request.identity_program,{namespace:this.#config.package.namespace,
      subject:this.#config.identity_subject,input_id:request.input_id,sources,
      ...(this.#config.identity_catalog?{identity_catalog:this.#config.identity_catalog}:{})});
    return {present:true,registry:result.registry,bindings:result.bindings,source_ids:[...selected]};
  }
  #criterionTransition(current,request){
    const enabled=this.#config.criterion_enabled===true,has=Object.hasOwn(request,'criterion_program');
    need(enabled||!has&&!Object.hasOwn(request,'outcome_candidate'),'CRITERION_MODE_DISABLED');
    if(!enabled)return {present:false};
    need(object(current.criterion_registry)&&Array.isArray(current.outcome_records),'CRITERION_STATE_REQUIRED');
    if(!has)return {present:true,registry:clone(current.criterion_registry),witness:null};
    // A standard review is its own transaction, based entirely on committed
    // evidence. It cannot create new identities/facts or approve its own result.
    need(request.scene_time===null&&request.reply===null,'CRITERION_REVIEW_ONLY');
    for(const name of ['instances','content_changes','record_creations','record_events','experiences','feedback','consume_feedback'])
      need(Array.isArray(request[name])&&request[name].length===0,'CRITERION_REVIEW_ONLY');
    for(const name of ['assembly','cycle','identity_program','outcome_candidate','criterion_learning_program'])need(!Object.hasOwn(request,name),'CRITERION_REVIEW_ONLY');
    for(const name of ['mechanism_changes','mechanism_claims','work_items'])need(request[name]===undefined||Array.isArray(request[name])&&request[name].length===0,'CRITERION_REVIEW_ONLY');
    const program=request.criterion_program;
    need(object(program)&&program.review_receipt_id===request.input_id,'CRITERION_REVIEW_INPUT_MISMATCH');
    const receipt=this.#read(this.#file('receipts',receiptKey(program.review_receipt_id)+'.json'));
    const registry=current.identity_registry??emptyIdentityRegistry(this.#config.package.namespace,this.#config.identity_subject,{identity_catalog:this.#config.identity_catalog});
    const result=applyCriterionProgram(current.criterion_registry,program,{namespace:this.#config.package.namespace,subject:this.#config.identity_subject,
      base_revision:current.revision,identity_registry:registry,contents:current.contents,review_receipt:receipt});
    return {present:true,registry:result.registry,witness:{id:receipt.input.id,sha256:fingerprint(receipt)}};
  }
  #outcomeTransition(current,request,contents,identity){
    if(!this.#config.criterion_enabled)return {projection:null,records:[]};
    const records=clone(current.outcome_records);
    if(!Object.hasOwn(request,'outcome_candidate'))return {projection:null,records};
    need(!Object.hasOwn(request,'criterion_program'),'CRITERION_REVIEW_ONLY');
    const registry=identity.present?identity.registry:emptyIdentityRegistry(this.#config.package.namespace,this.#config.identity_subject,{identity_catalog:this.#config.identity_catalog});
    const projection=validateOutcomeIntake(request.outcome_candidate,{namespace:this.#config.package.namespace,subject:this.#config.identity_subject,
      input_id:request.input_id,base_revision:current.revision,identity_registry:registry,contents,
      criterion_catalog:current.criterion_registry.catalog,criterion_admissions:current.criterion_registry.admissions});
    need(!records.some(r=>r.transaction_id===request.transaction_id),'OUTCOME_TRANSACTION_DUPLICATE');
    records.push({transaction_id:request.transaction_id,input_id:request.input_id,status:'pending_semantic_review',projection});
    return {projection,records};
  }
  #learningContext(current,outcome_transaction_id=null){
    let admissions=[],deferred=[];
    if(this.#config.corrected_first_learning_enabled&&outcome_transaction_id!==null){
      ({admissions,deferred}=describeCorrectedFirstLearningAdmissions(current.outcome_corrections,{outcome_transaction_id},this.#outcomeCorrectionContext(current)));
    }
    return {namespace:this.#config.package.namespace,subject:this.#config.identity_subject,base_revision:current.revision,
      contents:current.contents,identity_registry:current.identity_registry??emptyIdentityRegistry(this.#config.package.namespace,this.#config.identity_subject,{identity_catalog:this.#config.identity_catalog}),
      criterion_registry:current.criterion_registry,outcome_records:current.outcome_records,acknowledged_jobs:current.jobs.filter(j=>j.status==='acknowledged').map(j=>j.id),
      ...(admissions.length?{corrected_first_admissions:admissions}:{}),...(deferred.length?{corrected_first_deferred:deferred}:{})};
  }
  criterionLearningContext(outcome_transaction_id){this.#assertIdle();this.#recover();need(this.#config.criterion_learning_enabled,'CRITERION_LEARNING_MODE_DISABLED');return clone(this.#learningContext(this.#head,outcome_transaction_id));}
  #learningTransition(current,request){
    const has=Object.hasOwn(request,'criterion_learning_program');
    need(this.#config.criterion_learning_enabled||!has,'CRITERION_LEARNING_MODE_DISABLED');
    if(!this.#config.criterion_learning_enabled)return {present:false,work_items:[]};
    need(object(current.criterion_learning_state),'CRITERION_LEARNING_STATE_REQUIRED');
    if(!has)return {present:true,state:clone(current.criterion_learning_state),work_items:[],witness:null};
    need(request.reply===null&&request.scene_time===null,'LEARNING_REVIEW_ONLY');
    for(const name of ['instances','content_changes','record_creations','record_events','experiences','feedback','consume_feedback'])need(Array.isArray(request[name])&&request[name].length===0,'LEARNING_REVIEW_ONLY');
    for(const name of ['assembly','cycle','identity_program','outcome_candidate','criterion_program'])need(!Object.hasOwn(request,name),'LEARNING_REVIEW_ONLY');
    for(const name of ['mechanism_changes','mechanism_claims','work_items'])need(request[name]===undefined||Array.isArray(request[name])&&request[name].length===0,'LEARNING_REVIEW_ONLY');
    const program=request.criterion_learning_program;need(program?.review_receipt_id===request.input_id,'LEARNING_REVIEW_INPUT_MISMATCH');
    const receipt=this.#read(this.#file('receipts',receiptKey(program.review_receipt_id)+'.json'));
    if(this.#config.outcome_correction_enabled){
      for(const assessment of receipt.input.payload?.outcome_review?.accepted_assessments??[]){
        need(!current.criterion_learning_state.routes.some(r=>r.assessment_sha256===assessment),'EXISTING_SAMPLE_REQUIRES_CORRECTION_PROGRAM');
        const amended=current.outcome_corrections.routes.find(r=>r.assessment_sha256===assessment);
        need(!amended||this.#config.corrected_first_learning_enabled,'CORRECTED_ASSESSMENT_FIRST_SAMPLE_NOT_ADMITTED');
        if(amended)validateCorrectedFirstLearning(current.outcome_corrections,{assessment_sha256:assessment,outcome_transaction_id:program.outcome_transaction_id},this.#outcomeCorrectionContext(current));
      }
    }
    const result=applyCriterionLearning(current.criterion_learning_state,program,{...this.#learningContext(current,program.outcome_transaction_id),review_receipt:receipt});
    return {present:true,state:result.state,work_items:result.work_items,deferred:result.deferred,witness:{id:receipt.input.id,sha256:fingerprint(receipt)}};
  }
  #reviewJobs(current,proposals,context){
    const added=scheduleFeedback(scheduleFeedback([],proposals,context),[],{...context,phase:'committed'});
    need(added.every(job=>!current.some(previous=>previous.id===job.id)),'LEARNING_JOB_CONFLICT');
    // Administrative review advances the journal, not the character's internal
    // iteration. Do not retire unrelated queued work as a side effect.
    return [...clone(current),...added];
  }
  #regulationSources(current,proposal){
    const wanted=new Set((current.lifecycle_state?.reviews??[]).flatMap(r=>(r.context.regulation_sources??[]).map(s=>s.transaction_id)));
    for(const p of proposal?.regulations?.proposals??[])wanted.add(p.source_transaction_id);
    for(const d of proposal?.regulations?.deployments??[])wanted.add(d.before_transaction_id);
    for(const m of proposal?.regulations?.monitors??[])wanted.add(m.after_transaction_id);
    const result=[];
    for(const name of this.#names(this.#file('commits'))){
      const marker=this.#read(this.#file('commits',name));if(marker.revision>current.revision)break;
      if(!wanted.has(marker.transaction_id))continue;
      const intent=this.#read(this.#intentPath(marker.transaction_id));this.#verifySeal(intent);
      need(fingerprint(intent)===marker.intent_sha256&&intent.bundle.revision===marker.revision,'REGULATION_COMMITTED_SOURCE');
      const witness=intent.native_numeric_witness;need(witness,'REGULATION_NUMERIC_WITNESS_REQUIRED');
      const prepared=this.#nativeWitness(witness.prepare);
      need(prepared.request.op==='prepare'&&same(prepared.response.result,intent.numeric_preparation)&&
        same(intent.numeric_preparation.candidate_state,intent.bundle.numeric),'REGULATION_NUMERIC_SOURCE');
      const receipt=this.#read(this.#file('receipts',receiptKey(intent.input_id)+'.json')),source='regulation-readout:'+intent.transaction_id;
      const cells=intent.numeric_preparation.cells.filter(c=>['model.positive','model.negative'].includes(c.target.mechanism)).map(c=>{
        const stored=intent.bundle.numeric.cells.find(cell=>same(cell.target,c.target)),has_history=Boolean(stored?.ledger.length);
        return {target:clone(c.target),type:this.#config.state_fields[c.target.mechanism].type,has_history,
          signal:has_history?{known:true,value:c.value,sources:[source]}:{known:false,reason:'no_recorded_episode',sources:[source]}};
      });
      let readouts=[];
      if(intent.assembly&&intent.evaluation){
        need(intent.native_evaluation_witness,'REGULATION_EVALUATION_WITNESS_REQUIRED');
        const trace=this.#nativeWitness(intent.native_evaluation_witness);
        need(same(trace.request,buildCandidateReadRequest(intent.assembly,this.#config.package,intent.numeric_preparation,this.#catalog))&&
          same(trace.response.result,intent.evaluation),'REGULATION_EVALUATION_SOURCE');
        readouts=intent.assembly.outputs.filter(o=>o.recipe==='strategy_conditions').map(o=>({instance:o.instance,field:o.field,type:o.type,
          scope:clone(o.scope),recipe:o.recipe,signal:{...clone(intent.evaluation.graph.values[o.node_id]),sources:[source]}}));
      }
      result.push({transaction_id:intent.transaction_id,revision:marker.revision,intent_sha256:marker.intent_sha256,input_id:intent.input_id,
        input_sequence:receipt.sequence,scene_time:intent.request.scene_time,cells,readouts});wanted.delete(marker.transaction_id);
    }
    need(wanted.size===0,'REGULATION_SOURCE_NOT_COMMITTED');return result;
  }
  #regulationSourceIds(current){return [...new Set((current.lifecycle_state?.reviews??[]).flatMap(r=>(r.context.regulation_sources??[]).map(s=>'regulation-readout:'+s.transaction_id)))];}
  #lifecycleContext(current,proposal){
    return {namespace:this.#config.package.namespace,subject:this.#config.identity_subject,base_revision:current.revision,
      contents:current.contents,identity_registry:current.identity_registry,records:current.records,replies:current.replies,
      criterion_registry:current.criterion_registry??emptyCriterionRegistry(this.#config.package.namespace,this.#config.identity_subject),
      outcome_records:current.outcome_records??[],source_receipts:this.#names(this.#file('receipts')).map(n=>this.#read(this.#file('receipts',n))),
      ...(this.#config.internal_goals_enabled?{internal_goals:current.internal_goals}:{}),
      ...(proposal?.regulations||(current.lifecycle_state?.reviews??[]).some(r=>r.plan.regulations)?{regulation_sources:this.#regulationSources(current,proposal)}:{})};
  }
  lifecycleContext(proposal){this.#assertIdle();this.#recover();need(this.#config.lifecycle_enabled,'LIFECYCLE_MODE_DISABLED');return clone(this.#lifecycleContext(this.#head,proposal));}
  regulationHistory(ids){
    this.#assertIdle();this.#recover();need(this.#config.lifecycle_enabled,'LIFECYCLE_MODE_DISABLED');texts(ids,true);
    const reviews=this.#head.lifecycle_state.reviews;
    return ids.map(id=>{
      const origin=reviews.flatMap(r=>r.plan.regulations?.proposals??[]).find(p=>p.record_id===id);
      const wrapper=this.#head.records.find(r=>r.record.id===id);
      need(origin&&wrapper?.record.kind==='deployment','REGULATION_RECORD_REQUIRED');
      const deployment=reviews.flatMap(r=>r.plan.regulations?.deployments??[]).find(d=>d.record_id===id),monitors=[];
      for(const review of reviews)for(const m of review.plan.regulations?.monitors??[]){
        if(m.record_id!==id)continue;
        const marker=this.#read(this.#file('commits',slot(m.commit_base_revision+1)+'.json'));
        const intent=this.#read(this.#intentPath(marker.transaction_id));this.#verifySeal(intent);
        need(fingerprint(intent)===marker.intent_sha256&&intent.request.lifecycle_program?.review_receipt_id===review.receipt_id&&
          intent.lifecycle_plan.regulations.monitors.some(item=>same(item,m)),'REGULATION_MONITOR_COMMIT');
        let comparison=null;
        if(m.spec_id!==null){
          const output=intent.lifecycle_plan.monitor_outputs.find(o=>o.id===m.spec_id);need(output&&intent.evaluation,'REGULATION_MONITOR_OUTPUT');
          const trace=this.#nativeWitness(intent.native_evaluation_witness);
          need(same(trace.request,buildCandidateReadRequest(intent.assembly,this.#config.package,intent.numeric_preparation,this.#catalog))&&
            same(trace.response.result,intent.evaluation),'REGULATION_MONITOR_NATIVE_RESULT');
          comparison={type:output.type,signal:clone(intent.evaluation.graph.values[output.node_id]),
            transaction_id:intent.transaction_id,intent_sha256:marker.intent_sha256};
        }
        // Keep the submitted assertion as provenance. Only an actually applied
        // native assessment is an accepted verdict in the next-turn readout.
        const {verdict:submitted_verdict,...metadata}=clone(m);
        const assessed=m.event_id!==null&&wrapper.record.applied_events.some(e=>e.event_id===m.event_id&&
          e.payload.operation===(submitted_verdict==='effective'?'assess_success':'assess_failure'));
        monitors.push({...metadata,submitted_verdict,verdict:assessed?submitted_verdict:'unknown',comparison});
      }
      return {id,status:wrapper.record.status,definition:clone(origin.definition),proposal_ref:clone(origin.definition.basis_ref),
        deployment:deployment?clone(deployment):null,monitors,numeric_state_modified_by_monitor:false};
    });
  }
  #outcomeCorrectionContext(current){
    need(this.#config.outcome_correction_enabled,'OUTCOME_CORRECTION_MODE_DISABLED');
    return {namespace:clone(this.#config.package.namespace),subject:this.#config.identity_subject,base_revision:current.revision,
      contents:clone(current.contents),identity_registry:clone(current.identity_registry),criterion_registry:clone(current.criterion_registry),
      outcome_records:clone(current.outcome_records),learning_state:clone(current.criterion_learning_state),lifecycle_state:clone(current.lifecycle_state),
      records:clone(current.records),numeric:clone(current.numeric),work_items:clone(current.work_items),
      acknowledged_jobs:current.jobs.filter(job=>job.status==='acknowledged').map(job=>job.id),
      source_receipts:this.#names(this.#file('receipts')).map(name=>this.#read(this.#file('receipts',name)))};
  }
  outcomeCorrectionContext(){this.#assertIdle();this.#recover();return this.#outcomeCorrectionContext(this.#head);}
  #outcomeCorrectionTransition(current,request){
    const active=Object.hasOwn(request,'outcome_correction_program');
    need(this.#config.outcome_correction_enabled||!active,'OUTCOME_CORRECTION_MODE_DISABLED');
    if(!this.#config.outcome_correction_enabled)return {present:false,active:false,record_events:[],event_authorizations:[],sample_revisions:[],instances:[]};
    if(!active)return {present:true,active:false,state:clone(current.outcome_corrections),record_events:[],event_authorizations:[],sample_revisions:[],instances:[]};
    need(request.reply===null&&request.scene_time===null,'OUTCOME_CORRECTION_ADMIN_ONLY');
    for(const key of ['instances','content_changes','record_creations','record_events','experiences','feedback','consume_feedback'])need(Array.isArray(request[key])&&request[key].length===0,'OUTCOME_CORRECTION_ADMIN_ONLY');
    for(const key of ['assembly','cycle','identity_program','outcome_candidate','criterion_program','criterion_learning_program','lifecycle_program','lifecycle_delivery_program','internal_goal_program'])need(!Object.hasOwn(request,key),'OUTCOME_CORRECTION_ADMIN_ONLY');
    for(const key of ['mechanism_changes','mechanism_claims','work_items'])need(request[key]===undefined||Array.isArray(request[key])&&request[key].length===0,'OUTCOME_CORRECTION_ADMIN_ONLY');
    const program=request.outcome_correction_program;need(program?.review_receipt_id===request.input_id,'OUTCOME_CORRECTION_REVIEW_INPUT');
    const receipt=this.#read(this.#file('receipts',receiptKey(program.review_receipt_id)+'.json'));
    const result=applyOutcomeCorrections(current.outcome_corrections,program,{...this.#outcomeCorrectionContext(current),review_receipt:receipt});
    return {present:true,active:true,...result};
  }
  #outcomeCorrectionWitness(plan){
    return Object.fromEntries(['record_events','event_authorizations','sample_revisions','instances','source_observation_id'].map(key=>[key,clone(plan[key]??null)]));
  }
  #buildDailyPlan(current,input_id,program,content_changes){
    need(this.#config.daily_dynamics,'DAILY_MODE_DISABLED');
    const receipt=this.#read(this.#file('receipts',receiptKey(input_id)+'.json'));
    need(receipt.input.kind==='external_observation'&&same(receipt.input.payload.daily_program,program),'DAILY_RECEIPT_BINDING');
    const epoch=policyEpoch(current),captured=receipt.input.payload.daily_effect_epoch??{revision:0,sha256:fingerprint(null)};
    need(same(captured,epoch),'DAILY_EFFECT_POLICY_STALE');
    const interval=program.activity?.interval;
    if(interval){
      const hasDuration=v=>v&&Number.isFinite(v.start)&&Number.isFinite(v.end)&&v.start>=0&&v.end>v.start;
      if(current.daily_controls&&hasDuration(interval)){
        // The already committed setting transaction contains its actual scene
        // time. Reuse that witness, without adding a wall clock or migrating
        // old policy records. Unknown time stays unknown.
        const prefix='internal-daily-controls:',rid=current.daily_controls.receipt_id;
        need(rid.startsWith(prefix),'DAILY_CONTROLS_ORIGIN');
        const setting=this.#read(this.#intentPath(rid.slice(prefix.length)));this.#verifySeal(setting);
        need(setting.transaction_id===rid.slice(prefix.length)&&setting.input_id===rid&&setting.daily_controls_dispatch===true&&
          same(setting.bundle.daily_controls,current.daily_controls),'DAILY_CONTROLS_ORIGIN');
        const floor=setting.bundle.numeric.scene_time;
        need(floor===null||interval.start>=floor,'DAILY_INTERVAL_BEFORE_POLICY');
      }
      for(const name of this.#names(this.#file('receipts'))){
        const old=this.#read(this.#file('receipts',name)),previous=old.input.payload?.daily_program?.activity?.interval;
        // Fatigue is subject-scoped: renaming an activity or interval must not
        // make a period received under an earlier policy eligible again.
        const overlaps=hasDuration(interval)&&hasDuration(previous)&&interval.start<previous.end&&interval.end>previous.start;
        if(old.sequence<receipt.sequence&&previous&&(previous.interval_id===interval.interval_id||overlaps)){
          need(same(old.input.payload.daily_effect_epoch??{revision:0,sha256:fingerprint(null)},epoch),'DAILY_INTERVAL_POLICY_EPOCH');
        }
      }
    }
    const contents=applyContentChanges(current.contents,content_changes,this.#config.package.namespace).records;
    return buildDailySessionPlan({config:this.#config.daily_dynamics,namespace:this.#config.package.namespace,subject:this.#config.identity_subject,
      input_id,program,numeric:current.numeric,contents,effect_policy:readDailyEffectPolicy(current),
      ...(this.#config.personal_state?{personal_state_head:current}:{})});
  }
  #dailyControlsTransition(current,request){
    const active=Object.hasOwn(request,'daily_controls_program');
    if(!active)return {active:false,present:Object.hasOwn(current,'daily_controls'),state:clone(current.daily_controls)};
    need(this.#config.daily_dynamics,'DAILY_MODE_DISABLED');
    need(request.input_id==='internal-daily-controls:'+request.transaction_id,'DAILY_CONTROLS_ORIGIN');
    for(const k of ['instances','content_changes','record_creations','record_events','experiences','feedback','consume_feedback'])need(Array.isArray(request[k])&&request[k].length===0,'DAILY_CONTROLS_ONLY');
    for(const k of ['assembly','cycle','identity_program','criterion_program','outcome_candidate','criterion_learning_program','lifecycle_program','lifecycle_delivery_program','internal_goal_program','outcome_correction_program','daily_program'])need(!Object.hasOwn(request,k),'DAILY_CONTROLS_ONLY');
    for(const k of ['mechanism_changes','mechanism_claims','work_items'])need(request[k]===undefined||Array.isArray(request[k])&&request[k].length===0,'DAILY_CONTROLS_ONLY');
    need(request.scene_time===null&&request.reply===null&&request.daily_controls_program?.receipt_id===request.input_id,'DAILY_CONTROLS_ONLY');
    const receipt=this.#read(this.#file('receipts',receiptKey(request.input_id)+'.json'));
    return {active:true,present:true,state:applyDailyControls(current.daily_controls,request.daily_controls_program,receipt,this.#config.package.namespace)};
  }
  receiveDaily({id,program}){
    this.#assertIdle();this.#recover();need(this.#config.daily_dynamics,'DAILY_MODE_DISABLED');
    const file=this.#file('receipts',receiptKey(id)+'.json');
    if(this.#exists(file)){const old=this.#read(file);need(old.input.kind==='external_observation'&&same(old.input.payload.daily_program,program),'INPUT_ID_CONFLICT');return clone(old);}
    return this.#storeReceipt({id,kind:'external_observation',namespace:clone(this.#config.package.namespace),
      payload:{daily_program:clone(program),daily_effect_epoch:policyEpoch(this.#head)}},true);
  }
  async prepareDailyEffects({transaction_id,fatigue,satiation}){
    this.#assertIdle();need(this.#config.daily_dynamics,'DAILY_MODE_DISABLED');
    need(typeof fatigue==='boolean'&&typeof satiation==='boolean','DAILY_CONTROLS_BOOLEAN');need(text(transaction_id),'TRANSACTION_ID_REQUIRED');
    this.#busy=true;
    this.#operation=(async()=>{
      this.#recover();const saved=this.#intentPath(transaction_id),policy={fatigue,satiation};
      if(this.#exists(saved)){const old=this.#read(saved);this.#verifySeal(old);need(same(old.request.daily_controls_program?.policy,policy),'TRANSACTION_ID_CONFLICT');return this.#prepare(old.request,null,false,true);}
      const base_control_revision=policyEpoch(this.#head).revision;
      const receipt=this.#storeReceipt({id:'internal-daily-controls:'+transaction_id,namespace:clone(this.#config.package.namespace),kind:'internal_daily_controls',payload:{policy,base_control_revision}},true);
      return this.#prepare({transaction_id,base_revision:this.#head.revision,input_id:receipt.input.id,scene_time:null,
        instances:[],content_changes:[],record_creations:[],record_events:[],experiences:[],feedback:[],consume_feedback:[],reply:null,
        daily_controls_program:{schema:'asuka.daily-controls-program/1',receipt_id:receipt.input.id,base_control_revision,policy}},null,false,true);
    })();
    try{return await this.#operation;}finally{this.#busy=false;this.#operation=null;}
  }
  #dailyPlan(current,request){
    const active=Object.hasOwn(request,'daily_program');
    if(!active){need(!(request.experiences??[]).some(e=>[e.pair?.id,e.pair?.sum,e.pair?.mass].some(id=>typeof id==='string'&&id.startsWith('experience.daily_relations'))),'DAILY_EXPERIENCE_PROGRAM_REQUIRED');return {active:false,interval_transitions:[]};}
    need(this.#config.daily_dynamics,'DAILY_MODE_DISABLED');
    for(const k of ['record_creations','record_events','feedback','consume_feedback'])need(Array.isArray(request[k])&&request[k].length===0,'DAILY_PROGRAM_ONLY');
    for(const k of ['cycle','identity_program','criterion_program','outcome_candidate','criterion_learning_program','lifecycle_program','lifecycle_delivery_program','internal_goal_program','outcome_correction_program'])need(!Object.hasOwn(request,k),'DAILY_PROGRAM_ONLY');
    for(const k of ['mechanism_changes','mechanism_claims','work_items'])need(request[k]===undefined||Array.isArray(request[k])&&request[k].length===0,'DAILY_PROGRAM_ONLY');
    need(request.reply===null,'DAILY_PROGRAM_ONLY');
    const plan=this.#buildDailyPlan(current,request.input_id,request.daily_program,request.content_changes);
    need(same(request.instances,plan.instances)&&same(request.experiences,plan.experiences)&&same(request.assembly??null,plan.assembly)&&
      request.scene_time===plan.scene_time,'DAILY_DERIVED_REQUEST_MISMATCH');
    return {active:true,...plan};
  }
  async prepareDaily({transaction_id,input_id,program,content_changes=[]}){
    this.#assertIdle();const options=clone({transaction_id,input_id,program,content_changes});this.#busy=true;
    this.#operation=(async()=>{
      this.#recover();const saved=this.#intentPath(options.transaction_id);
      if(this.#exists(saved)){
        const old=this.#read(saved);this.#verifySeal(old);need(old.input_id===options.input_id&&same(old.request.daily_program,options.program)&&
          same(old.request.content_changes,options.content_changes),'TRANSACTION_ID_CONFLICT');return this.#prepare(old.request);
      }
      const plan=this.#buildDailyPlan(this.#head,options.input_id,options.program,options.content_changes);
      return this.#prepare({transaction_id:options.transaction_id,base_revision:this.#head.revision,input_id:options.input_id,scene_time:plan.scene_time,
        instances:plan.instances,content_changes:options.content_changes,record_creations:[],record_events:[],experiences:plan.experiences,
        feedback:[],consume_feedback:[],reply:null,daily_program:options.program,...(plan.assembly?{assembly:plan.assembly}:{})});
    })();
    try{return await this.#operation;}finally{this.#busy=false;this.#operation=null;}
  }
  #nativeWitness(value){
    exact(value,['file','sha256']);need(/^[a-f0-9-]{36}-\d{16}\.json$/.test(value.file),'NATIVE_TRACE_PATH');
    const trace=this.#read(this.#file('trace',value.file));
    need(fingerprint(trace)===value.sha256&&trace.response.ok===true&&same(JSON.parse(trace.raw_response),trace.response),'NATIVE_TRACE_WITNESS_CHANGED');
    return trace;
  }
  #validateNumericWitness(intent,current,correction,daily){
    const w=intent.native_numeric_witness;exact(w,['load','prepare']);
    const loaded=this.#nativeWitness(w.load),prepared=this.#nativeWitness(w.prepare);
    need(loaded.channel_id===prepared.channel_id&&loaded.sequence<prepared.sequence,'NUMERIC_WITNESS_ORDER');
    need(same(loaded.request,{op:'load',package:this.#config.package,state:current.numeric}),'NUMERIC_LOAD_BASE_MISMATCH');
    need(same(loaded.response.result,current.numeric),'NUMERIC_LOADED_STATE_MISMATCH');
    for(let sequence=loaded.sequence+1;sequence<prepared.sequence;sequence++){
      const trace=this.#read(this.#file('trace',loaded.channel_id+'-'+slot(sequence)+'.json'));
      need(trace.channel_id===loaded.channel_id&&trace.sequence===sequence&&
        ['numeric','prepare','discard','evaluate_candidate'].includes(trace.request.op),'NUMERIC_BASE_CHANGED_BETWEEN_WITNESSES');
    }
    need(prepared.request.op==='prepare'&&Object.keys(prepared.request).sort().join('|')==='frame|op'&&same(prepared.response.result,intent.numeric_preparation),'NUMERIC_PREPARE_WITNESS_MISMATCH');
    const frame=prepared.request.frame;
    need(same(frame.interval_transitions??[],daily?.interval_transitions??[]),'DAILY_NATIVE_INTERVAL_MISMATCH');
    need(same(frame.namespace,this.#config.package.namespace)&&frame.base_revision===current.revision&&frame.scene_time===intent.request.scene_time,'NUMERIC_FRAME_BASE_MISMATCH');
    if(correction.active){
      need(prepared.sequence===loaded.sequence+1,'CORRECTION_NUMERIC_NOT_ADJACENT');
      const expected={namespace:this.#config.package.namespace,base_revision:current.revision,observation_id:correction.source_observation_id,
        scene_time:null,instances:correction.instances,effects:[],sample_revisions:correction.sample_revisions};
      need(same(frame,expected),'CORRECTION_NATIVE_FRAME_MISMATCH');
    }else{
      need(frame.observation_id===intent.input_id&&!Object.hasOwn(frame,'sample_revisions'),'UNREVIEWED_SAMPLE_REVISION');
      const writes=intent.request.experiences.map(experience=>{
        this.#checkCriterionExperience(experience,intent.dispatch,current);
        return buildExperienceWrites({namespace:this.#config.package.namespace,state_fields:this.#config.state_fields,pair:experience.pair,sample:experience.sample},this.#catalog);
      });
      const pairFields=new Set((this.#config.package.statistics_pairs??[]).flatMap(p=>[p.sum,p.mass]));
      need(same(frame.effects.filter(e=>pairFields.has(e.target.mechanism)),writes.flatMap(w=>w.effects).filter(e=>pairFields.has(e.target.mechanism))),'UNREVIEWED_PAIRED_SAMPLE_EFFECT');
      if(!(intent.request.mechanism_claims??[]).length){
        const instances=[...new Map([...intent.request.instances,...writes.flatMap(w=>w.instances)].map(x=>[fingerprint(x),x])).values()];
        need(same(frame.effects,writes.flatMap(w=>w.effects))&&same(frame.instances,instances),'NUMERIC_FRAME_REQUEST_MISMATCH');
      }
    }
  }
  #internalGoalContext(current){
    need(this.#config.internal_goals_enabled,'INTERNAL_GOALS_MODE_DISABLED');
    const committed_sources=[];let anchor_transaction_id=null;
    // Resolve only the actual journal prefix at this revision. Prepared,
    // discarded and later transactions can never authorize internal reasons.
    for(const name of this.#names(this.#file('commits'))){
      const marker=this.#read(this.#file('commits',name));if(marker.revision>current.revision)break;
      const intent=this.#read(this.#intentPath(marker.transaction_id));this.#verifySeal(intent);
      need(fingerprint(intent)===marker.intent_sha256&&intent.bundle.revision===marker.revision,'INTERNAL_GOALS_COMMIT_SOURCE');
      const receipt=this.#read(this.#file('receipts',receiptKey(intent.input_id)+'.json'));
      if(['user_input','external_observation'].includes(receipt.input.kind))anchor_transaction_id=intent.transaction_id;
      if(!intent.assembly||!intent.evaluation)continue;
      need(intent.evaluation.graph?.input_identity===assemblyIdentity(intent.assembly),'INTERNAL_GOALS_ASSEMBLY_SOURCE');
      committed_sources.push({transaction_id:intent.transaction_id,revision:marker.revision,intent_sha256:marker.intent_sha256,
        assembly_identity:assemblyIdentity(intent.assembly),input_id:intent.input_id,scene_time:intent.request.scene_time,
        readouts:intent.assembly.outputs.filter(o=>internalGoalRecipes.has(o.recipe)).map(o=>({instance:o.instance,field:o.field,type:o.type,scope:clone(o.scope),recipe:o.recipe,
          signal:clone(intent.evaluation.graph.values[o.node_id])}))});
    }
    return {namespace:clone(this.#config.package.namespace),subject:this.#config.identity_subject,base_revision:current.revision,
      model:clone(this.#config.goal_model),identity_registry:clone(current.identity_registry),contents:clone(current.contents),anchor_transaction_id,committed_sources};
  }
  internalGoalContext(){this.#assertIdle();this.#recover();return this.#internalGoalContext(this.#head);}
  #internalGoalSourceIds(current){
    if(!this.#config.internal_goals_enabled)return [];
    const index=this.#verificationIndex;
    const markers=index?.commits??this.#names(this.#file('commits')).map(n=>this.#read(this.#file('commits',n)));
    if(index){index.commits=markers;index.readouts??=new Map();}
    return [...(current.internal_goals?.goals??[]).map(g=>`goal-proposal:${g.id}`),
      ...markers.filter(m=>{
        if(m.revision>current.revision)return false;
        if(index?.readouts.has(m.transaction_id))return index.readouts.get(m.transaction_id);
        const intent=this.#read(this.#intentPath(m.transaction_id)),eligible=Boolean(intent.assembly&&intent.evaluation);
        index?.readouts.set(m.transaction_id,eligible);return eligible;
      }).map(m=>`committed-readout:${m.transaction_id}`)];
  }
  #internalGoalTransition(current,request){
    const active=Object.hasOwn(request,'internal_goal_program');need(this.#config.internal_goals_enabled||!active,'INTERNAL_GOALS_MODE_DISABLED');
    if(!this.#config.internal_goals_enabled)return {present:false};
    if(!active)return {present:true,active:false,state:clone(current.internal_goals)};
    need(request.reply===null&&request.scene_time===null,'INTERNAL_GOALS_ADMIN_ONLY');
    for(const name of ['instances','content_changes','record_creations','record_events','experiences','feedback','consume_feedback'])need(Array.isArray(request[name])&&request[name].length===0,'INTERNAL_GOALS_ADMIN_ONLY');
    for(const name of ['assembly','cycle','identity_program','outcome_candidate','criterion_program','criterion_learning_program','lifecycle_program','lifecycle_delivery_program','outcome_correction_program'])need(!Object.hasOwn(request,name),'INTERNAL_GOALS_ADMIN_ONLY');
    for(const name of ['mechanism_changes','mechanism_claims','work_items'])need(request[name]===undefined||Array.isArray(request[name])&&request[name].length===0,'INTERNAL_GOALS_ADMIN_ONLY');
    const program=request.internal_goal_program;need(program?.review_receipt_id===request.input_id,'INTERNAL_GOALS_REVIEW_INPUT');
    const receipt=this.#read(this.#file('receipts',receiptKey(request.input_id)+'.json'));
    const result=applyInternalGoals(current.internal_goals,program,{...this.#internalGoalContext(current),review_receipt:receipt});
    const {registry}=applyInternalGoalIdentities(current.identity_registry,result.identity_goals,{namespace:this.#config.package.namespace,
      subject:this.#config.identity_subject,...(this.#config.identity_catalog?{identity_catalog:this.#config.identity_catalog}:{})});
    return {present:true,active:true,state:result.state,registry,witness:{receipt_id:receipt.input.id,receipt_sha256:fingerprint(receipt),identity_goals:clone(result.identity_goals)}};
  }
  #lifecycleTransition(current,request){
    const review=Object.hasOwn(request,'lifecycle_program'),delivery=Object.hasOwn(request,'lifecycle_delivery_program');
    need(this.#config.lifecycle_enabled||!review&&!delivery,'LIFECYCLE_MODE_DISABLED');
    if(!this.#config.lifecycle_enabled)return {present:false};
    need(!(review&&delivery),'ONE_LIFECYCLE_PROGRAM');
    // In this opt-in mode model-authored generic events cannot bypass review.
    const managed=['goal','commitment','deployment','text_delivery','speech_delivery'];
    need(!(request.record_creations??[]).some(r=>managed.includes(r.kind)),'LIFECYCLE_REVIEW_REQUIRED');
    need(!(request.record_events??[]).some(e=>managed.includes(current.records.find(r=>r.record.id===e.record_id)?.record.kind)),'LIFECYCLE_REVIEW_REQUIRED');
    if(!review&&!delivery)return {present:true,active:false,state:clone(current.lifecycle_state),record_creations:[],record_events:[],event_authorizations:[],deferred:[]};
    need(request.reply===null&&request.scene_time===null,'LIFECYCLE_ADMIN_ONLY');
    for(const name of ['instances','content_changes','record_creations','record_events','experiences','feedback','consume_feedback'])need(Array.isArray(request[name])&&request[name].length===0,'LIFECYCLE_ADMIN_ONLY');
    for(const name of ['assembly','cycle','identity_program','outcome_candidate','criterion_program','criterion_learning_program','internal_goal_program','outcome_correction_program'])need(!Object.hasOwn(request,name),'LIFECYCLE_ADMIN_ONLY');
    for(const name of ['mechanism_changes','mechanism_claims','work_items'])need(request[name]===undefined||Array.isArray(request[name])&&request[name].length===0,'LIFECYCLE_ADMIN_ONLY');
    const ctx=this.#lifecycleContext(current,request.lifecycle_program?.proposal);let result;
    if(review){
      const p=request.lifecycle_program;need(p?.review_receipt_id===request.input_id,'LIFECYCLE_REVIEW_INPUT');
      if(!this.#config.goal_confirmation_enabled)for(const action of p.proposal?.outcomes??[]){
        const target=current.records.find(r=>r.record.id===action.record_id)?.record;
        need(!(action.operation==='complete'&&target?.kind==='goal'&&target.status==='completion_review_required'),'GOAL_CONFIRMATION_MODE_DISABLED');
      }
      if(this.#config.outcome_correction_enabled)for(const action of p.proposal?.outcomes??[]){
        const amendment=current.outcome_corrections.routes.find(r=>r.assessment_sha256===action.assessment_sha256);
        if(amendment)need(amendment.current.outcome_transaction_id===action.outcome_transaction_id,'LIFECYCLE_CORRECTED_OUTCOME_SOURCE_REQUIRED');
      }
      result=applyLifecycleProgram(current.lifecycle_state,p,{...ctx,review_receipt:this.#read(this.#file('receipts',receiptKey(p.review_receipt_id)+'.json'))});
    }else{
      const p=request.lifecycle_delivery_program,receipt=this.#read(this.#file('receipts',receiptKey(request.input_id)+'.json'));
      const actual=this.#read(this.#file('receipts',receiptKey(p.delivery_receipt_id)+'.json'));
      need(receipt.input.kind==='internal_lifecycle'&&same(receipt.input.payload,{transaction_id:request.transaction_id,delivery_receipt_id:p.delivery_receipt_id,delivery_receipt_sha256:fingerprint(actual)}),'LIFECYCLE_DISPATCH_BINDING');
      result=applyLifecycleDelivery(current.lifecycle_state,p,{...ctx,delivery_receipt:actual});
    }
    return {present:true,active:true,...result};
  }
  #lifecycleWitness(plan){
    return {...Object.fromEntries(['record_creations','record_events','event_authorizations','deferred'].map(k=>[k,clone(plan[k])])),
      ...(plan.regulations?{regulations:clone(plan.regulations),monitor_assembly:clone(plan.monitor_assembly),monitor_outputs:clone(plan.monitor_outputs)}:{})};
  }
  #validateLifecycleRecords(intent,current,plan){
    // Rebuild admission and compare every transition to its separately saved
    // native transcript. This does not reimplement the C++ state machine.
    const records=clone(current.records),ns=this.#config.package.namespace;
    for(const spec of [...intent.request.record_creations,...plan.record_creations]){
      const wrapper=createLifecycleRecord(spec,ns),previous=records.find(r=>r.record.id===wrapper.record.id);
      if(previous)need(same(previous,wrapper),'RECORD_ID_CONFLICT');else records.push(wrapper);
    }
    const events=[...intent.request.record_events,...plan.record_events],witnesses=intent.lifecycle_native_records;
    need(Array.isArray(witnesses)&&witnesses.length===events.length,'LIFECYCLE_NATIVE_WITNESS_REQUIRED');
    events.forEach((change,index)=>{
      const record=records.find(r=>r.record.id===change.record_id),w=witnesses[index];need(record,'RECORD_MISSING');
      exact(w,['file','sha256']);need(/^[a-f0-9-]{36}-\d{16}\.json$/.test(w.file),'NATIVE_TRACE_PATH');
      const trace=this.#read(this.#file('trace',w.file));need(fingerprint(trace)===w.sha256,'LIFECYCLE_NATIVE_TRACE_CHANGED');
      const expected={op:'transition',request:{record:record.record,event:change.event,base_revision:change.base_revision}};
      need(same(trace.request,expected)&&trace.response.ok===true&&same(JSON.parse(trace.raw_response),trace.response),'LIFECYCLE_NATIVE_REQUEST_MISMATCH');
      record.record=clone(trace.response.result.record);
    });
    need(same(records,intent.bundle.records),'LIFECYCLE_NATIVE_RECORDS_MISMATCH');
  }
  #checkInternalGoalCreation(spec,plan,current){
    if(spec.kind!=='goal'||!Array.isArray(spec.content_refs)||spec.content_refs.length!==0)return;
    const auth=plan.event_authorizations?.find(a=>a.kind==='goal_choice'&&a.record_id===spec.id&&a.internal_goal_ref);
    const row=current.internal_goals?.goals.find(g=>g.id===spec.id);
    need(this.#config.internal_goals_enabled&&auth&&row&&auth.internal_goal_ref.id===spec.id&&
      auth.internal_goal_ref.sha256===fingerprint(row)&&plan.record_creations.some(r=>same(r,spec)),'INTERNAL_GOAL_CREATION_REQUIRES_REVIEW');
  }
  #isCriterionExperience(experience){
    const names=['experience.criterion_means','experience.criterion_means.sum','experience.criterion_means.mass'];
    return [experience?.pair?.id,experience?.pair?.sum,experience?.pair?.mass].some(v=>names.includes(v));
  }
  #checkCriterionExperience(experience,dispatch,current=this.#head){
    if(!this.#isCriterionExperience(experience))return;
    need(this.#config.criterion_learning_enabled&&dispatch,'CRITERION_EXPERIENCE_REQUIRES_REVIEWED_JOB');
    const job=current.work_items.find(w=>dispatch.job_ids.includes(w.id)&&w.payload.experiences.some(e=>same(e,experience)));
    need(job,'CRITERION_EXPERIENCE_NOT_IN_JOB');
    const route=current.criterion_learning_state.routes.find(r=>r.history.some(h=>h.job_id===job.id&&h.interpretation_revision===experience.sample.interpretation_revision));
    need(route&&same(route.scope,experience.pair.scope)&&route.meaning_id===experience.sample.meaning_id,'CRITERION_EXPERIENCE_NOT_REVIEWED');
    const amended=current.outcome_corrections?.routes.find(r=>r.assessment_sha256===route.assessment_sha256);
    if(amended&&experience.sample.mode==='new_occurrence_effect'){
      need(this.#config.corrected_first_learning_enabled,'CORRECTED_ASSESSMENT_FIRST_SAMPLE_NOT_ADMITTED');
      validateCorrectedFirstLearningDispatch(current.outcome_corrections,{assessment_sha256:route.assessment_sha256,job_id:job.id},this.#outcomeCorrectionContext(current));
      return true;
    }
    return false;
  }
  #replySources(original){
    const registered=new Set(this.#config.configuration_sources);
    for(const input of this.#receiptInputs())registered.add(input.id);
    for(const content of original.bundle.contents)for(const version of content.history)registered.add(`content:${content.id}@${version.revision}`);
    for(const reply of original.bundle.replies)registered.add(`reply:${reply.id}`);
    for(const id of this.#internalGoalSourceIds(original.bundle))registered.add(id);
    for(const id of this.#regulationSourceIds(original.bundle))registered.add(id);
    if(Object.hasOwn(original,'reply_source_ids')){
      texts(original.reply_source_ids,true);
      need(original.reply_source_ids.every(id=>registered.has(id)),'CANDIDATE_SOURCE_MISSING');
      return new Set(original.reply_source_ids);
    }
    // Conservative compatibility for a prepared intent lacking the new snapshot:
    // later receipts cannot expand the original candidate's context.
    const frozen=new Set([...this.#config.configuration_sources,original.input_id]);
    for(const content of original.bundle.contents)for(const version of content.history){
      frozen.add(`content:${content.id}@${version.revision}`);
      for(const id of version.source_refs)if(registered.has(id))frozen.add(id);
    }
    for(const reply of original.bundle.replies)frozen.add(`reply:${reply.id}`);
    return frozen;
  }
  #withFinalReply(original,finalization){
    need(!['criterion_program','criterion_learning_program','lifecycle_program','lifecycle_delivery_program','internal_goal_program','outcome_correction_program'].some(k=>Object.hasOwn(original.request,k)),'REVIEW_CANNOT_FINALIZE_REPLY');
    exact(finalization,['candidate_sha256','reply']);
    need(typeof finalization.candidate_sha256==='string'&&/^[a-f0-9]{64}$/.test(finalization.candidate_sha256)&&
      finalization.candidate_sha256===fingerprint(original),'CANDIDATE_HASH_MISMATCH');
    need(original.request.reply===null&&!original.bundle.replies.some(r=>r.transaction_id===original.transaction_id),'PREPARED_REPLY_ALREADY_EXISTS');
    const reply=clone(finalization.reply);exact(reply,['id','text','source_refs']);
    need(text(reply.id)&&text(reply.text),'REPLY_REQUIRED');texts(reply.source_refs);
    const sources=this.#replySources(original);need(reply.source_refs.every(id=>sources.has(id)),'REPLY_SOURCE_NOT_IN_CANDIDATE');
    need(!original.bundle.replies.some(r=>r.id===reply.id),'REPLY_ID_CONFLICT');
    reply.source_refs.sort();
    const result=clone(original);
    result.finalization={candidate_sha256:finalization.candidate_sha256,reply};
    result.bundle.replies.push({...clone(reply),input_id:original.input_id,transaction_id:original.transaction_id,publication:'not_confirmed'});
    return result;
  }
  #decisionPath(id){return this.#file('decisions',fingerprint({transaction:id})+'.json');}
  #decision(id){const file=this.#decisionPath(id);return this.#exists(file)?this.#read(file):null;}
  #validateStatistics(snapshot){
    const fields=this.#config.state_fields,groups=new Map();
    need(Array.isArray(this.#config.package.definitions),'DEFINITIONS_REQUIRED');
    const defs=new Map(this.#config.package.definitions.map(d=>[d.id,d]));
    need(defs.size===this.#config.package.definitions.length,'DUPLICATE_DEFINITION');
    need(same([...defs.keys()].sort(),Object.keys(fields).sort()),'STATE_DECLARATION_MISMATCH');
    for(const [id,f]of Object.entries(fields)){
      const def=defs.get(id),type=this.#catalog.types[f.type];need(type&&same([...def.scope].sort(),[...f.scope].sort()),'STATE_TYPE_OR_SCOPE');
      if(type.temporal_role==='statistic'){
        need(text(f.statistics_pair)&&def.half_life===null&&Number.isFinite(def.initial)&&def.initial>=0,'STATISTIC_DEFINITION');
        const part=type.unit==='weighted_probability'?'sum':type.unit==='sample_mass'?'mass':null;
        const group=groups.get(f.statistics_pair)??{};need(part&&!group[part],'STATISTIC_PAIR_DECLARATION');group[part]=id;groups.set(f.statistics_pair,group);
      }else{const [lo,hi]=type.domain;need((lo===null||def.bounds[0]>=lo)&&(hi===null||def.bounds[1]<=hi),'STATE_DOMAIN_DECLARATION');}
    }
    for(const [id,g]of groups){
      need(g.sum&&g.mass&&defs.get(g.sum).initial<=defs.get(g.mass).initial,'PAIRED_DEFINITION_MISSING');
      const scopes=new Map(snapshot.cells.filter(c=>[g.sum,g.mass].includes(c.target.mechanism)).map(c=>[fingerprint(c.target.scope),c.target.scope]));
      for(const scope of scopes.values())validatePairedStatistics(snapshot,{id,...g,scope},fields,this.#catalog);
    }
  }
  state(){this.#assertIdle();this.#recover();return clone(this.#head);}
  committedTransactions(){
    this.#assertIdle();this.#recover();
    return this.#names(this.#file('commits')).map(name=>{
      const m=this.#read(this.#file('commits',name));
      return {transaction_id:m.transaction_id,revision:m.revision,intent_sha256:m.intent_sha256};
    });
  }
  recoveryDiagnostics(){this.#assertIdle();return this.#recoveryReads.diagnostics();}
  async readCriterionHistory(request){
    this.#assertIdle();need(this.#config.criterion_learning_enabled,'CRITERION_LEARNING_MODE_DISABLED');
    const frozen=clone(request);this.#busy=true;this.#operation=this.#readCriterionHistory(frozen);
    try{return await this.#operation;}finally{this.#busy=false;this.#operation=null;}
  }
  async #readCriterionHistory(request){
    this.#recover();
    need(!this.#names(this.#file('decisions')).some(n=>{const d=this.#read(this.#file('decisions',n));return d.action==='commit'&&this.#read(this.#intentPath(d.transaction_id)).base_revision>=this.#head.revision;}),'COMMIT_RECOVERY_REQUIRED');
    const plan=buildCriterionHistoryRead(request,this.#learningContext(this.#head));
    const frame={namespace:this.#config.package.namespace,base_revision:this.#head.revision,observation_id:'criterion-history-read',scene_time:null,instances:plan.instances,effects:[]};
    const checked=buildReadOnlyRequest(plan.assembly,this.#config.package,frame,this.#head.numeric,this.#catalog);
    await this.#native.call({op:'load',package:this.#config.package,state:this.#head.numeric});
    let prepared;
    try{
      prepared=await this.#native.call({op:'prepare',frame:checked.frame});
      const evaluated=await this.#native.call(buildCandidateReadRequest(plan.assembly,this.#config.package,prepared,this.#catalog));
      return {schema:'asuka.criterion-history/1',base_revision:this.#head.revision,criterion_ref:plan.criterion_ref,scope:plan.scope,
        outputs:Object.fromEntries(plan.assembly.outputs.map(o=>[o.field,clone(evaluated.graph.values[o.node_id])])),
        assembly:plan.assembly,evaluation:evaluated,statistic_targets:plan.statistic_targets,output_meaning:plan.output_meaning,committed:false};
    }finally{if(prepared)await this.#native.call({op:'discard',ticket:prepared.ticket});}
  }
  receipt(input){
    this.#assertIdle();return this.#storeReceipt(input,false);
  }
  receiptBatch(inputs){
    // The idle/open lease was verified by open(); this path only appends input
    // receipts, never consults or changes head. The next state/prepare access
    // performs normal recovery, including newly added source dependencies.
    this.#assertIdle();need(Array.isArray(inputs),'INPUT_BATCH_REQUIRED');this.#busy=true;
    try{
      // Only ordinary input receipts: these checks do not depend on head.
      // Delivery/review/internal receipts retain the single-item recovery path.
      const rows=this.#names(this.#file('receipts')).map(name=>[name,this.#read(this.#file('receipts',name))]);
      const index={rows:new Map(rows),next:1+Math.max(0,...rows.map(([,row])=>row.sequence))};
      const result=[];
      for(const input of inputs){
        need(object(input)&&['user_input','external_observation'].includes(input.kind),'INPUT_BATCH_KIND');
        need(!Object.hasOwn(input.payload??{},'semantic_role')||['user','assistant','reference','system','tool'].includes(input.payload.semantic_role),'RECEIPT_SEMANTIC_ROLE');
        result.push(this.#storeReceipt(input,false,index));
      }
      return result;
    }finally{this.#busy=false;}
  }
  #storeReceipt(input,internal,batch=null){
    this.#assertOpen();if(!batch)this.#recover();exact(input,['id','namespace','kind','payload'],['binding']);namespace(input.namespace);
    need(text(input.id)&&same(input.namespace,this.#config.package.namespace),'NAMESPACE_OR_INPUT_ID');
    need(!this.#config.configuration_sources.includes(input.id),'CONFIGURATION_SOURCE_IS_NOT_RECEIPT');
    need(['user_input','external_observation','delivery_receipt','review_instruction',...(internal?['internal_feedback',...(this.#config.lifecycle_enabled?['internal_lifecycle']:[]),...(this.#config.daily_dynamics?['internal_daily_controls']:[])]:[])].includes(input.kind),'INPUT_KIND');
    need(object(input.payload),'INPUT_PAYLOAD');
    need(internal||!Object.hasOwn(input.payload,'daily_effect_epoch'),'DAILY_EFFECT_EPOCH_HOST_ONLY');
    if(input.kind==='delivery_receipt'){
      exact(input.binding,['reply_id','reply_sha256','channel','event'],this.#config.lifecycle_enabled?['delivery_id','recipient_ids','delivered_spans']:[]);
      const b=input.binding;need(['text','speech'].includes(b.channel),'DELIVERY_CHANNEL');
      need((b.channel==='text'?['published','cancelled']:['started','completed','cancelled']).includes(b.event),'DELIVERY_EVENT');
      const reply=this.#head.replies.find(r=>r.id===b.reply_id);need(reply&&fingerprint(reply)===b.reply_sha256,'DELIVERY_REPLY_MISSING_OR_CHANGED');
      if(this.#config.lifecycle_enabled){
        if(b.delivery_id!==undefined)need(text(b.delivery_id),'DELIVERY_INSTANCE_ID');
        if(b.recipient_ids!==undefined){texts(b.recipient_ids,true);const actors=this.#head.identity_registry.actors;need(b.recipient_ids.every(id=>actors.some(a=>a.id===id)),'DELIVERY_RECIPIENT_UNKNOWN');}
        if(b.delivered_spans!==undefined){
          need(Array.isArray(b.delivered_spans),'DELIVERY_SPANS_REQUIRED');
          for(const span of b.delivered_spans){
            exact(span,['start','end']);need(Number.isSafeInteger(span.start)&&Number.isSafeInteger(span.end)&&span.start>=0&&span.end>span.start&&span.end<=reply.text.length,'DELIVERY_SPAN_RANGE');
            const split=i=>i>0&&i<reply.text.length&&/[\uD800-\uDBFF]/.test(reply.text[i-1])&&/[\uDC00-\uDFFF]/.test(reply.text[i]);
            need(!split(span.start)&&!split(span.end),'DELIVERY_SPAN_SURROGATE');
          }
        }
        if(b.delivery_id!==undefined){
          const sameInstance=this.#names(this.#file('receipts')).map(n=>this.#read(this.#file('receipts',n)).input).filter(x=>x.kind==='delivery_receipt'&&x.binding.channel===b.channel&&x.binding.delivery_id===b.delivery_id);
          const binding=x=>({reply_id:x.reply_id,reply_sha256:x.reply_sha256,recipient_ids:x.recipient_ids?[...x.recipient_ids].sort():null});
          need(sameInstance.every(x=>same(binding(x.binding),binding(b))),'DELIVERY_INSTANCE_CHANGED');
        }
      }
    }else need(input.binding===undefined,'UNEXPECTED_BINDING');
    const receiptName=receiptKey(input.id)+'.json',file=this.#file('receipts',receiptName);
    if(batch?.rows.has(receiptName)){const existing=batch.rows.get(receiptName);need(same(existing.input,input),'INPUT_ID_CONFLICT');return clone(existing);}
    if(this.#exists(file)){const existing=this.#read(file);need(same(existing.input,input),'INPUT_ID_CONFLICT');return clone(existing);}
    const sequence=batch?batch.next:1+Math.max(0,...this.#names(this.#file('receipts')).map(n=>this.#read(this.#file('receipts',n)).sequence));
    const row={input:clone(input),sequence};immutable(file,row);
    if(batch){batch.rows.set(receiptName,row);batch.next++;}return clone(row);
  }
  receipts(){this.#assertIdle();return this.#names(this.#file('receipts')).map(n=>this.#read(this.#file('receipts',n))).sort((a,b)=>a.sequence-b.sequence);}
  pending(){this.#assertIdle();return this.#names(this.#file('prepared')).map(n=>this.#read(this.#file('prepared',n))).filter(x=>!this.#decision(x.transaction_id)).map(x=>({transaction_id:x.transaction_id,base_revision:x.base_revision,input_id:x.input_id}));}
  #context(intent,phase){return {namespace:clone(this.#config.package.namespace),transaction_id:intent.transaction_id,base_revision:intent.base_revision,candidate_revision:intent.base_revision+1,observation_id:intent.input_id,observation_sequence:intent.observation_sequence,iteration:0,phase};}
  async prepare(request){
    this.#assertIdle();const frozen=clone(request);this.#busy=true;
    this.#operation=this.#prepare(frozen);
    try{return await this.#operation;}finally{this.#busy=false;this.#operation=null;}
  }
  async #prepare(request,dispatch=null,lifecycleDispatch=false,controlsDispatch=false){
    this.#recover();
    need(!this.#names(this.#file('decisions')).some(n=>{
      const d=this.#read(this.#file('decisions',n));return d.action==='commit'&&this.#read(this.#intentPath(d.transaction_id)).base_revision>=this.#head.revision;
    }),'COMMIT_RECOVERY_REQUIRED');
    exact(request,['transaction_id','base_revision','input_id','scene_time','instances','content_changes','record_creations','record_events','experiences','feedback','consume_feedback','reply'],['assembly','cycle','mechanism_changes','mechanism_claims','work_items','identity_program','criterion_program','outcome_candidate','criterion_learning_program','lifecycle_program','lifecycle_delivery_program','internal_goal_program','outcome_correction_program','daily_program','daily_controls_program']);
    need(!Object.hasOwn(request,'daily_controls_program')||controlsDispatch,'DAILY_CONTROLS_HOST_ONLY');
    need(text(request.transaction_id)&&text(request.input_id),'TRANSACTION_ID_REQUIRED');serial(request.base_revision);
    this.#requireSupportedRecordEvents(request.record_events);
    const saved=this.#intentPath(request.transaction_id);
    if(this.#exists(saved)){const old=this.#read(saved);this.#verifySeal(old);need(old.request_hash===fingerprint(request),'TRANSACTION_ID_CONFLICT');return clone(old);}
    need(!this.#decision(request.transaction_id),'TRANSACTION_ALREADY_DECIDED');
    need(request.base_revision===this.#head.revision,'BASE_REVISION_MISMATCH');
    const receipt=this.#read(this.#file('receipts',receiptKey(request.input_id)+'.json'));
    need(receipt.input.kind!=='internal_feedback'||dispatch,'INTERNAL_DISPATCH_REQUIRED');
    need(receipt.input.kind!=='internal_lifecycle'||lifecycleDispatch,'INTERNAL_LIFECYCLE_DISPATCH_REQUIRED');
    need(receipt.input.kind!=='internal_daily_controls'||controlsDispatch,'DAILY_CONTROLS_HOST_ONLY');
    need(!this.#head.consumed_inputs.includes(request.input_id),'INPUT_ALREADY_COMMITTED');
    const daily=this.#dailyPlan(this.#head,request);
    const controls=this.#dailyControlsTransition(this.#head,request);
    const identity=this.#identityTransition(this.#head,request);
    const internalGoals=this.#internalGoalTransition(this.#head,request);
    const criteria=this.#criterionTransition(this.#head,request);
    const learning=this.#learningTransition(this.#head,request);
    const lifecycle=this.#lifecycleTransition(this.#head,request);
    const correction=this.#outcomeCorrectionTransition(this.#head,request);
    need(!(request.work_items??[]).some(w=>(w.payload?.experiences??[]).some(e=>this.#isCriterionExperience(e))),'CRITERION_WORK_REQUIRES_REVIEW_PROGRAM');
    const workItems=[...(request.work_items??[]),...learning.work_items];
    for(const name of ['instances','content_changes','record_creations','record_events','experiences','feedback','consume_feedback'])need(Array.isArray(request[name]),'ARRAY_REQUIRED');
    const ns=this.#config.package.namespace;
    const phase=dispatch?.phase??'observation';
    const sourceObservations=dispatch?.source_observation_ids??[request.input_id];
    const content=applyContentChanges(this.#head.contents,request.content_changes,ns);
    const contents=content.records;const records=clone(this.#head.records);
    const outcome=this.#outcomeTransition(this.#head,request,contents,identity);
    const mechanismContent=applyMechanismRecords(this.#head.mechanism_records,request.mechanism_changes??[],contents,ns,{phase:phase==='next_observation'?'observation':phase});
    const receiptIds=new Set(this.#names(this.#file('receipts')).map(n=>this.#read(this.#file('receipts',n)).input.id));
    const sources=new Set([...this.#config.configuration_sources,...receiptIds]);
    for(const id of this.#internalGoalSourceIds(this.#head))sources.add(id);
    for(const c of this.#head.contents)for(const version of c.history)sources.add(`content:${c.id}@${version.revision}`);
    const checkRefs=refs=>{texts(refs);need(refs.every(r=>sources.has(r)),'SOURCE_REFERENCE_MISSING');};
    for(const change of request.content_changes){
      checkRefs(change.source_refs);
      if(change.kind==='fact'){
        need(change.body.observation_id===request.input_id||
          receiptIds.has(change.body.observation_id)&&change.source_refs.includes(change.body.observation_id)&&
          ['recollection','quotation'].includes(change.body.presentation),'FACT_OBSERVATION_BINDING');
        need(change.source_refs.every(id=>!this.#config.configuration_sources.includes(id)),'CONFIGURATION_PRIOR_IS_NOT_FACT_EVIDENCE');
        if(this.#config.internal_goals_enabled)need(change.source_refs.every(id=>!id.startsWith('goal-proposal:')&&!id.startsWith('committed-readout:')),'INTERNAL_REASON_IS_NOT_EXTERNAL_FACT');
      }
      sources.add(`content:${change.id}@${change.base_revision+1}`);
    }
    // Plan identifiers describe hypothetical graph inputs. They cannot be
    // promoted into evidence for a newly stored fact in this transaction.
    for(const source of daily.derived_sources??[])sources.add(source);
    for(const source of this.#regulationSourceIds(this.#head))sources.add(source);
    for(const source of lifecycle.regulation_sources??[])sources.add('regulation-readout:'+source.transaction_id);
    for(const reply of this.#head.replies)sources.add(`reply:${reply.id}`);
    for(const route of request.cycle?.routes??[])checkRefs(route.source_refs);
    for(const binding of request.cycle?.request?.bindings??[])checkRefs(binding.evidence_refs);
    const checkLiteralSources=signal=>{if(signal?.sources!==undefined){texts(signal.sources,true);need(signal.sources.every(s=>sources.has(s)),'UNREGISTERED_GRAPH_SOURCE');}};
    for(const inst of request.cycle?.request?.instances??[])for(const ref of Object.values(inst.inputs??{}))if(ref.signal)checkLiteralSources(ref.signal);
    for(const node of request.assembly?.graph?.nodes??[])for(const ref of node.inputs??[])if(ref.literal)checkLiteralSources(ref.literal);
    for(const binding of request.assembly?.graph?.bindings??[])checkRefs(binding.evidence_refs);
    for(const node of lifecycle.monitor_assembly?.graph?.nodes??[])for(const ref of node.inputs??[])if(ref.literal)checkLiteralSources(ref.literal);
    for(const transition of daily.interval_transitions){checkRefs(transition.sources);checkRefs(transition.driver.sources);}
    if((request.mechanism_claims??[]).some(c=>this.#config.write_program.channels.find(x=>x.id===c.channel_id)?.input.kind==='assembly'))
      need(request.cycle,'COMPUTED_WRITE_REQUIRES_COMPILED_CYCLE');
    const lifecycleNative=[];
    for(const spec of [...request.record_creations,...(lifecycle.record_creations??[])]){
      this.#checkInternalGoalCreation(spec,lifecycle,this.#head);
      const record=createLifecycleRecord(spec,ns);checkRefs(record.source_refs);
      need(record.content_refs.every(ref=>contents.some(c=>c.id===ref.id&&c.history.some(v=>v.revision===ref.revision)&&c.owner_id===record.record.owner_id)),'LIFECYCLE_CONTENT_REFERENCE');
      const previous=records.find(x=>x.record.id===record.record.id);
      if(previous)need(same(previous,record),'RECORD_ID_CONFLICT');else records.push(record);
    }
    for(const change of [...request.record_events,...(lifecycle.record_events??[]),...correction.record_events]){
      exact(change,['record_id','base_revision','event']);const record=records.find(r=>r.record.id===change.record_id);need(record,'RECORD_MISSING');
      checkRefs(change.event.sources);
      // Authorizations below were recomputed from an independent review or an
      // exact host receipt. They admit only the generated event, never raw LLM fields.
      const authorization=[...(lifecycle.event_authorizations??[]),...correction.event_authorizations].find(a=>a.event_id===change.event.event_id);
      if(authorization)need([...lifecycle.record_events,...correction.record_events].some(e=>same(e,change))&&authorization.record_id===change.record_id,'LIFECYCLE_EVENT_AUTHORIZATION');
      else this.#checkEvent(record,change.event,receipt,contents);
      const result=await this.#native.call({op:'transition',request:{record:record.record,event:change.event,base_revision:change.base_revision}});
      if(lifecycle.present)lifecycleNative.push(clone(this.#lastTrace));
      record.record=result.record;
    }
    const writes=[];
    for(const experience of request.experiences){
      const correctedFirst=this.#checkCriterionExperience(experience,dispatch);
      exact(experience,['fact_ref','pair','sample']);const fact=contentRef(contents,experience.fact_ref),s=experience.sample;
      need(fact.kind==='fact'&&fact.owner_id===experience.pair.scope.subject,'EXPERIENCE_SUBJECT');
      need(fact.body.instance_refs?.some(scope=>same(scope,experience.pair.scope)),'EXPERIENCE_INSTANCE_BINDING');
      need(fact.body.occurrence_status==='completed'&&['observed','self_report','reported'].includes(fact.body.epistemic_status),'COMPLETED_OUTCOME_REQUIRED');
      need(s.occurrence_id===fact.body.occurrence_id&&s.observation_id===fact.body.observation_id&&sourceObservations.includes(s.observation_id),'EXPERIENCE_EVENT_BINDING');
      need(s.source_refs.includes(refKey(fact)),'EXACT_CONTENT_SOURCE_REQUIRED');checkRefs(s.source_refs);
      const evidence=new Set([refKey(fact),...fact.source_refs]);
      need(s.source_refs.every(r=>evidence.has(r)),'EXPERIENCE_SOURCE_BINDING');
      for(const signal of [s.outcome,s.weight])if(signal.sources?.length){checkRefs(signal.sources);need(signal.sources.every(r=>evidence.has(r)),'EXPERIENCE_SOURCE_BINDING');}
      if(s.mode==='new_occurrence_effect')need(fact.body.presentation==='current_report'&&(fact.body.novelty==='new_evidence'||correctedFirst&&fact.body.novelty==='correction'),'OLD_EVENT_IS_NOT_NEW_EFFECT');
      if(s.mode==='replace_interpretation')need(fact.body.novelty==='correction','CORRECTION_EVIDENCE_REQUIRED');
      writes.push(buildExperienceWrites({namespace:ns,state_fields:this.#config.state_fields,pair:experience.pair,sample:s},this.#catalog));
    }
    const sourceSequences=Object.fromEntries(this.#names(this.#file('receipts')).map(n=>{const r=this.#read(this.#file('receipts',n));return [r.input.id,r.sequence];}));
    const writerContext={program:this.#config.write_program,claims:request.mechanism_claims??[],previous:this.#head.mechanism_state,contents,
      observation_id:request.input_id,source_observation_ids:sourceObservations,observation_sequence_by_id:sourceSequences,phase,namespace:ns};
    const call=req=>this.#native.call(req);
    const symbolClaims=writerContext.claims.filter(c=>this.#config.write_program.channels.find(x=>x.id===c.channel_id)?.input.kind!=='assembly');
    const preliminary=await prepareMechanismWrites({...writerContext,claims:symbolClaims,evaluation:null,assembly:null},call,this.#catalog);
    const nativeFrame=mechanism=>({namespace:ns,base_revision:request.base_revision,observation_id:correction.active?correction.source_observation_id:request.input_id,scene_time:request.scene_time,
      instances:[...new Map([...request.instances,...writes.flatMap(w=>w.instances),...mechanism.instances,...correction.instances].map(x=>[fingerprint(x),x])).values()],
      effects:[...writes.flatMap(w=>w.effects),...mechanism.effects],...(correction.active?{sample_revisions:correction.sample_revisions}:{}),
      ...(daily.interval_transitions.length?{interval_transitions:daily.interval_transitions}:{})});
    let graphRequest=null,currentAssembly=request.assembly??lifecycle.monitor_assembly??null;
    if(request.cycle){
      need(!request.assembly,'ONE_ASSEMBLY_ENTRY');exact(request.cycle,['request','routes','steps','observations']);
      need(Number.isSafeInteger(request.cycle.steps)&&request.cycle.steps>=1&&request.cycle.steps<=5,'ITERATION_RANGE');
      graphRequest=resolveObservationInputs(request.cycle.request,request.cycle.observations,preliminary.state,this.#config.write_program,this.#catalog);
      currentAssembly=compileAssembly(graphRequest,this.#catalog);
    }
    await this.#native.call({op:'load',package:this.#config.package,state:this.#head.numeric});
    const loadWitness=clone(this.#lastTrace);
    let prepared,mechanism=preliminary,evaluation=null,evaluationWitness=null,prepareWitness=null;const iterations=[];
    try{
      const steps=request.cycle?.steps??1;
      for(let step=0;step<steps;step++){
        if(prepared){await this.#native.call({op:'discard',ticket:prepared.ticket});prepared=null;}
        prepared=await this.#native.call({op:'prepare',frame:nativeFrame(preliminary)});
        prepareWitness=clone(this.#lastTrace);
        if(currentAssembly){evaluation=await this.#native.call(buildCandidateReadRequest(currentAssembly,this.#config.package,prepared,this.#catalog));evaluationWitness=clone(this.#lastTrace);}
        // Each update is derived from the committed write journal, never from the prior internal step.
        mechanism=await prepareMechanismWrites({...writerContext,evaluation,assembly:currentAssembly},call,this.#catalog);
        if(!same(mechanism.effects,preliminary.effects)){
          await this.#native.call({op:'discard',ticket:prepared.ticket});prepared=null;
          prepared=await this.#native.call({op:'prepare',frame:nativeFrame(mechanism)});
          prepareWitness=clone(this.#lastTrace);
          if(currentAssembly){evaluation=await this.#native.call(buildCandidateReadRequest(currentAssembly,this.#config.package,prepared,this.#catalog));evaluationWitness=clone(this.#lastTrace);}
        }
        this.#validateStatistics(prepared.candidate_state);
        const row={step,base_revision:request.base_revision,scene_time:request.scene_time,evaluation,mechanism_trace:mechanism.trace};
        if(step+1<steps){
          need(evaluation&&graphRequest,'ITERATION_GRAPH_REQUIRED');
          const advanced=advanceIteration(graphRequest,currentAssembly,evaluation,request.cycle.routes,step+1,this.#catalog);
          row.feedback=advanced.trace;graphRequest=advanced.request;currentAssembly=compileAssembly(graphRequest,this.#catalog);
        }
        iterations.push(row);
      }
      const context=this.#context({...request,observation_sequence:receipt.sequence},'prepared');
      // Consume only committed jobs unlocked by this actual new observation; no payload execution here.
      const consumption={...context,phase:phase==='after_commit'?'committed':phase==='offline_review'?'offline_review':'observation',
        ...(dispatch?.trigger?{observation_id:dispatch.trigger.id,observation_sequence:dispatch.trigger.sequence}:{})};
      const jobs0=acknowledgeFeedback(this.#head.jobs,request.consume_feedback,consumption);
      const work=stageWorkItems(this.#head.work_items,workItems,{namespace:ns,transaction_id:request.transaction_id,contents});
      for(const item of workItems)for(const claim of item.payload.mechanism_claims){
        const channel=this.#config.write_program.channels.find(c=>c.id===claim.channel_id);
        need(channel?.input.kind==='symbol','DELAYED_COMPUTATION_REQUIRES_NEW_CYCLE');
      }
      need(!(request.feedback??[]).some(j=>this.#head.work_items.some(w=>w.id===j.id)||work.proposals.some(p=>p.id===j.id)),'WORK_ITEM_REQUIRES_PAYLOAD_PATH');
      for(const id of request.consume_feedback)if(this.#head.work_items.some(w=>w.id===id))need(dispatch?.job_ids.includes(id),'WORK_ACK_REQUIRES_EXECUTION');
      const proposals=[...request.feedback,...work.proposals];
      const scheduled=scheduleFeedback(jobs0,proposals,context);
      const jobs=Object.hasOwn(request,'criterion_program')||lifecycle.active||internalGoals.active||correction.active||daily.active||controls.active?clone(this.#head.jobs):Object.hasOwn(request,'criterion_learning_program')?
        this.#reviewJobs(this.#head.jobs,work.proposals,context):scheduleFeedback(scheduled,[],{...context,phase:'committed'});
      for(const item of proposals){checkRefs(item.source_refs);checkRefs(item.payload_refs);}
      const replies=clone(this.#head.replies);
      if(request.reply!==null){
        exact(request.reply,['id','text','source_refs']);need(text(request.reply.id)&&text(request.reply.text),'REPLY_REQUIRED');checkRefs(request.reply.source_refs);
        need(!replies.some(r=>r.id===request.reply.id),'REPLY_ID_CONFLICT');
        replies.push({...clone(request.reply),input_id:request.input_id,transaction_id:request.transaction_id,publication:'not_confirmed'});
      }
      const bundle={schema:'asuka.general-host-state/2',namespace:clone(ns),revision:request.base_revision+1,numeric:prepared.candidate_state,contents,records,
        mechanism_records:mechanismContent.records,mechanism_state:mechanism.state,work_items:work.items,replies,jobs,consumed_inputs:[...this.#head.consumed_inputs,request.input_id],
        ...(identity.present?{identity_registry:clone(identity.registry)}:{}),
        ...(criteria.present?{criterion_registry:clone(criteria.registry),outcome_records:outcome.records}:{}),
        ...(learning.present?{criterion_learning_state:clone(learning.state)}:{}),
        ...(lifecycle.present?{lifecycle_state:clone(lifecycle.state)}:{}),
        ...(internalGoals.present?{internal_goals:clone(internalGoals.state)}:{}),
        ...(correction.present?{outcome_corrections:clone(correction.state)}:{}),...(controls.present?{daily_controls:clone(controls.state)}:{})};
      const intent={schema:'asuka.general-host-intent/2',transaction_id:request.transaction_id,input_id:request.input_id,input_sha256:fingerprint(receipt),observation_sequence:receipt.sequence,base_revision:request.base_revision,base_hash:fingerprint(this.#head),request_hash:fingerprint(request),request:clone(request),reply_source_ids:[...sources].sort(),dispatch:clone(dispatch),bundle,evaluation,assembly:currentAssembly,iterations,numeric_preparation:prepared,content_result:content,mechanism_content_result:mechanismContent,experience_results:writes,semantic_review:'not_performed_by_transaction_host',production:false};
      if(Object.hasOwn(request,'identity_program')){intent.identity_source_ids=clone(identity.source_ids);intent.identity_bindings=clone(identity.bindings);}
      if(criteria.witness)intent.criterion_review_receipt=clone(criteria.witness);
      if(outcome.projection)intent.outcome_projection=clone(outcome.projection);
      if(learning.witness){intent.learning_review_receipt=clone(learning.witness);intent.learning_work_items=clone(learning.work_items);intent.learning_deferred=clone(learning.deferred);}
      if(lifecycle.present){intent.lifecycle_plan=this.#lifecycleWitness(lifecycle);intent.lifecycle_native_records=lifecycleNative;}
      if(internalGoals.witness)intent.internal_goal_witness=clone(internalGoals.witness);
      if((this.#config.internal_goals_enabled||this.#config.outcome_correction_enabled||this.#config.daily_dynamics||this.#config.lifecycle_enabled||this.#config.positive_experience_enabled||this.#config.goal_importance)&&evaluationWitness)intent.native_evaluation_witness=evaluationWitness;
      if(correction.active)intent.outcome_correction_plan=this.#outcomeCorrectionWitness(correction);
      if(correction.present||this.#config.daily_dynamics||this.#config.lifecycle_enabled||this.#config.positive_experience_enabled||this.#config.goal_importance)intent.native_numeric_witness={load:loadWitness,prepare:prepareWitness};
      if(daily.active)intent.daily_plan={outputs:clone(daily.outputs),metadata:clone(daily.metadata)};
      if(controls.active)intent.daily_controls_dispatch=true;
      this.#assertOpen();immutable(saved,intent);
      immutable(this.#sealPath(request.transaction_id),{transaction_id:request.transaction_id,intent_sha256:fingerprint(intent)});
      return clone(intent);
    }finally{if(prepared)await this.#native.call({op:'discard',ticket:prepared.ticket});}
  }
  /** Bind language output to one sealed candidate, without recomputing any native result. */
  finalizeReply(request){
    this.#assertIdle();const frozen=clone(request);exact(frozen,['transaction_id','reply','candidate_sha256']);
    need(text(frozen.transaction_id),'TRANSACTION_ID_REQUIRED');this.#recover();
    need(!this.#decision(frozen.transaction_id),'TRANSACTION_ALREADY_DECIDED');
    need(!this.#names(this.#file('decisions')).some(n=>{const d=this.#read(this.#file('decisions',n));return d.action==='commit'&&this.#read(this.#intentPath(d.transaction_id)).base_revision>=this.#head.revision;}),'COMMIT_RECOVERY_REQUIRED');
    const original=this.#read(this.#baseIntentPath(frozen.transaction_id));
    this.#verifySeal(original,{original:true});
    need(original.base_revision===this.#head.revision&&original.base_hash===fingerprint(this.#head),'STALE_CANDIDATE');
    this.#validateIntentCore(original,this.#head);
    const finalized=this.#withFinalReply(original,{candidate_sha256:frozen.candidate_sha256,reply:frozen.reply});
    this.#validateIntentCore(finalized,this.#head);
    const file=this.#finalIntentPath(frozen.transaction_id);
    if(this.#exists(file)){
      const existing=this.#read(file);this.#validateIntent(existing,this.#head);
      need(same(existing,finalized),'FINALIZATION_CONFLICT');return clone(existing);
    }
    immutable(file,finalized);
    this.#fault?.('after_finalized_intent');
    immutable(this.#finalSealPath(frozen.transaction_id),{transaction_id:frozen.transaction_id,intent_sha256:fingerprint(finalized)});
    return clone(finalized);
  }
  #checkEvent(wrapper,event,receipt,contents){
    const kind=wrapper.record.kind;
    if(['text_delivery','speech_delivery'].includes(kind)||['delivered_speech_act','delivered_retraction'].includes(event.evidence_kind)){
      const b=receipt.input.binding;need(receipt.input.kind==='delivery_receipt'&&b&&event.sources.includes(receipt.input.id),'HOST_DELIVERY_RECEIPT_REQUIRED');
      const bindings={host_text_receipt:['text','published'],host_speech_started:['speech','started'],host_speech_completed:['speech','completed']};
      if(bindings[event.evidence_kind])need(same([b.channel,b.event],bindings[event.evidence_kind]),'DELIVERY_EVIDENCE_MISMATCH');
      else if(event.evidence_kind==='host_cancel_receipt')need(b.event==='cancelled','DELIVERY_EVIDENCE_MISMATCH');
      else need(b.event===(b.channel==='text'?'published':'completed'),'COMMITMENT_NOT_DELIVERED');
      if(kind==='text_delivery')need(b.channel==='text','DELIVERY_CHANNEL_MISMATCH');
      if(kind==='speech_delivery')need(b.channel==='speech','DELIVERY_CHANNEL_MISMATCH');
      need(wrapper.source_refs.includes(`reply:${b.reply_id}`),'RECORD_REPLY_BINDING');
    }
    if(event.evidence_kind==='observed_outcome')need(contents.some(c=>c.kind==='fact'&&c.owner_id===wrapper.record.owner_id&&c.body.occurrence_status==='completed'&&c.body.observation_id===receipt.input.id&&event.sources.includes(refKey(c))&&['observed','reported','self_report'].includes(c.body.epistemic_status)&&c.body.instance_refs?.some(scope=>same(scope,{subject:wrapper.record.owner_id,[kind]:wrapper.record.id}))),'OUTCOME_FACT_REQUIRED');
  }
  #requireSupportedRecordEvents(changes){
    // Raw events cannot bypass the independently reviewed correction plan.
    // Its generated events enter through the separate atomic host path.
    // Switching an executable alone never authorizes caller-written corrections.
    need(Array.isArray(changes),'ARRAY_REQUIRED');
    need(!changes.some(change=>['invalidate_completion','invalidate_fulfillment'].includes(change.event?.operation)||
      Object.hasOwn(change.event??{},'correction')),'OUTCOME_CORRECTION_HOST_NOT_CONNECTED');
  }
  /** Execute only a previously committed data payload. Ack and effects share its new commit. */
  async prepareLifecycleDelivery(options){
    this.#assertIdle();const frozen=clone(options);this.#busy=true;
    this.#operation=this.#dispatchLifecycleDelivery(frozen);
    try{return await this.#operation;}finally{this.#busy=false;this.#operation=null;}
  }
  async #dispatchLifecycleDelivery(options){
    exact(options,['transaction_id','delivery_receipt_id']);need(this.#config.lifecycle_enabled,'LIFECYCLE_MODE_DISABLED');
    need(text(options.transaction_id)&&text(options.delivery_receipt_id),'LIFECYCLE_DISPATCH_ID');
    const saved=this.#intentPath(options.transaction_id);
    if(this.#exists(saved)){
      const old=this.#read(saved);this.#verifySeal(old);
      need(old.request.lifecycle_delivery_program?.delivery_receipt_id===options.delivery_receipt_id,'LIFECYCLE_DISPATCH_ID_CONFLICT');return clone(old);
    }
    this.#recover();const actual=this.#read(this.#file('receipts',receiptKey(options.delivery_receipt_id)+'.json'));
    need(actual.input.kind==='delivery_receipt','HOST_DELIVERY_RECEIPT_REQUIRED');
    // The transport evidence remains reusable: its receipt may precede a later
    // semantic review. Each application consumes its own internal dispatch only.
    const receipt=this.#storeReceipt({id:'internal-lifecycle:'+options.transaction_id,namespace:this.#config.package.namespace,kind:'internal_lifecycle',
      payload:{transaction_id:options.transaction_id,delivery_receipt_id:actual.input.id,delivery_receipt_sha256:fingerprint(actual)}},true);
    return this.#prepare({transaction_id:options.transaction_id,base_revision:this.#head.revision,input_id:receipt.input.id,scene_time:null,
      instances:[],content_changes:[],record_creations:[],record_events:[],experiences:[],feedback:[],consume_feedback:[],reply:null,
      lifecycle_delivery_program:{schema:'asuka.lifecycle-delivery-program/1',base_sha256:fingerprint(this.#head.lifecycle_state),delivery_receipt_id:actual.input.id}},null,true);
  }
  async executeFeedback(options){
    this.#assertIdle();const frozen=clone(options);this.#busy=true;
    this.#operation=this.#dispatch(frozen);
    let intent;
    try{intent=await this.#operation;}finally{this.#busy=false;this.#operation=null;}
    this.#assertOpen();return {...this.commit(intent.transaction_id),input_id:intent.input_id,job_ids:intent.dispatch.job_ids};
  }
  async #dispatch(options){
    exact(options,['transaction_id','job_ids','phase'],['receipt_id']);
    need(text(options.transaction_id),'TRANSACTION_ID_REQUIRED');texts(options.job_ids);
    need(['after_commit','next_observation','offline_review'].includes(options.phase),'WORK_PHASE_INVALID');
    const saved=this.#intentPath(options.transaction_id);
    if(this.#exists(saved)){
      const old=this.#read(saved);this.#verifySeal(old);
      need(old.dispatch?.options_hash===fingerprint(options),'DISPATCH_ID_CONFLICT');return old;
    }
    this.#recover();
    const selected=selectWorkItems(this.#head.work_items,this.#head.jobs,options.job_ids,this.#config.package.namespace);
    need(selected.items.every(item=>item.clock===options.phase),'WORK_CLOCK_MISMATCH');
    const ns=this.#config.package.namespace;
    let trigger=null;
    if(options.phase==='after_commit')need(options.receipt_id===undefined,'INTERNAL_JOB_HAS_NO_EXTERNAL_RECEIPT');
    else{
      need(text(options.receipt_id),'EXTERNAL_RECEIPT_REQUIRED');
      const observed=this.#read(this.#file('receipts',receiptKey(options.receipt_id)+'.json'));
      need(options.phase==='offline_review'?observed.input.kind==='review_instruction':['user_input','external_observation','delivery_receipt'].includes(observed.input.kind),'WORK_RECEIPT_KIND');
      trigger={id:observed.input.id,sequence:observed.sequence};
    }
    // The dispatch does not consume the user message which unlocked it. That
    // message must remain available to the normal conversation transaction.
    const receipt=this.#storeReceipt({id:'internal-feedback:'+options.transaction_id,namespace:ns,kind:'internal_feedback',
      payload:{job_ids:options.job_ids,trigger,source_observation_ids:selected.source_observation_ids,payload_sha256:fingerprint(selected.payload)}},true);
    const request={transaction_id:options.transaction_id,base_revision:this.#head.revision,input_id:receipt.input.id,scene_time:null,
      instances:[],content_changes:[],record_creations:[],record_events:[],feedback:[],consume_feedback:options.job_ids,reply:null,
      mechanism_changes:selected.payload.mechanism_changes,mechanism_claims:selected.payload.mechanism_claims,experiences:selected.payload.experiences};
    const ctx={...this.#context({...request,observation_sequence:receipt.sequence},'prepared'),...(trigger?{observation_id:trigger.id,observation_sequence:trigger.sequence}:{}),
      phase:options.phase==='after_commit'?'committed':options.phase==='offline_review'?'offline_review':'observation'};
    const allowed=new Set(eligibleFeedback(this.#head.jobs,ctx).map(j=>j.id));
    need(options.job_ids.every(id=>allowed.has(id)),'WORK_NOT_ELIGIBLE');
    const dispatch={options_hash:fingerprint(options),phase:options.phase,job_ids:clone(options.job_ids),trigger,
      source_observation_ids:selected.source_observation_ids,payload_sha256:fingerprint(selected.payload)};
    return this.#prepare(request,dispatch);
  }
  commit(transaction_id){
    this.#assertIdle();need(text(transaction_id),'TRANSACTION_ID_REQUIRED');
    this.#recover();
    const intent=this.#read(this.#intentPath(transaction_id));const intentHash=fingerprint(intent);
    const markerPath=this.#file('commits',slot(intent.base_revision+1)+'.json');
    if(this.#exists(markerPath)){
      const existing=this.#read(markerPath);need(existing.transaction_id===transaction_id&&existing.intent_sha256===intentHash,'COMMIT_REVISION_TAKEN');
      this.#recover();return {status:'committed',transaction_id,revision:existing.revision,recovered:true};
    }
    need(intent.base_revision===this.#head.revision&&intent.base_hash===fingerprint(this.#head),'STALE_CANDIDATE');
    this.#validateIntent(intent,this.#head);
    need(this.#decision(transaction_id)?.action!=='discard','TRANSACTION_DISCARDED');
    need(!this.#names(this.#file('decisions')).some(n=>{const d=this.#read(this.#file('decisions',n));return d.action==='commit'&&d.transaction_id!==transaction_id&&this.#read(this.#intentPath(d.transaction_id)).base_revision>=this.#head.revision;}),'COMMIT_RECOVERY_REQUIRED');
    immutable(this.#decisionPath(transaction_id),{transaction_id,action:'commit',intent_sha256:intentHash});
    this.#fault?.('before_marker');
    const marker={schema:'asuka.general-host-commit/1',transaction_id,revision:intent.base_revision+1,previous:this.#marker,intent_sha256:intentHash};
    immutable(markerPath,marker);
    // From here onward the transaction is committed, even if this caller never receives success.
    this.#fault?.('after_marker');
    this.#recover();return {status:'committed',transaction_id,revision:marker.revision,recovered:false};
  }
  discard(transaction_id){
    this.#assertIdle();const intent=this.#read(this.#intentPath(transaction_id));
    need(!this.#decision(transaction_id)||this.#decision(transaction_id).action==='discard','COMMIT_DECISION_CANNOT_CANCEL');
    immutable(this.#decisionPath(transaction_id),{transaction_id,action:'discard',intent_sha256:fingerprint(intent)});
    return {status:'discarded',input_retained:true};
  }
  recoverDecided(){
    this.#assertIdle();this.#recover();const result=[];
    for(const name of this.#names(this.#file('decisions'))){const d=this.#read(this.#file('decisions',name));if(d.action==='commit'){
      const intent=this.#read(this.#intentPath(d.transaction_id));if(intent.base_revision>=this.#head.revision)result.push(this.commit(d.transaction_id));
    }}return result;
  }
  eligible(context){this.#assertIdle();return eligibleFeedback(this.#head.jobs,context);}
  async close(){
    if(this.#closed)return;this.#closed=true;
    try{await this.#native?.close();await this.#operation?.catch(()=>{});}finally{if(this.#release){await this.#release();this.#release=null;}}
  }
}
