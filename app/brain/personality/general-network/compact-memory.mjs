// A separate retrieval index: compact cues and exact body references only.
// Reading never reinforces memory or changes emotional state. Numerical
// retention/consolidation is delegated to the original C++ numeric transport.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fingerprint} from './assembly-identity.mjs';
import {exclusiveLease} from './durable-session.mjs';
import {COMPACT_FEATURE_VERSION,COMPACT_FEATURE_VERSION_V3,compactFeatureVersions,extractCompactCue,compareCompactCues} from './compact-memory-features.mjs';
export {COMPACT_FEATURE_VERSION,COMPACT_FEATURE_VERSION_V3,extractCompactCue,compareCompactCues};
export {compactFeatureTypes,compactFeatureTypesV3,compactGateTypes} from './compact-memory-features.mjs';

const clone=structuredClone,object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),own=(v,k)=>Object.hasOwn(v,k);
const text=v=>typeof v==='string'&&Boolean(v.trim())&&!v.includes('\0')&&v.length<=1024;
const hash=v=>createHash('sha256').update(v).digest('hex');
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error('COMPACT_MEMORY_'+code),{code:'COMPACT_MEMORY_'+code});};
const exact=(v,keys,code)=>need(object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>own(v,k)),code);
const K=(value,sources)=>({known:true,value,sources}),U=(reason,sources=[])=>({known:false,reason,sources});
function signal(v){need(object(v)&&typeof v.known==='boolean'&&Array.isArray(v.sources)&&v.sources.every(text),'SIGNAL');
  if(v.known)need(Number.isFinite(v.value)&&v.value>=0&&v.value<=1,'SIGNAL_RANGE');else need(text(v.reason)&&!own(v,'value'),'UNKNOWN');return clone(v);}
function time(v){need(v===null||Number.isFinite(v),'TIME');return v;}
function write(file,value){const tmp=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
// The tokenizer deliberately matches the existing dynamic-memory implementation:
// NFKC + lower-case Latin words and CJK bigrams, now over key descriptions too.
export function compactMemoryTerms(value){const s=String(value).normalize('NFKC').toLowerCase(),terms=s.match(/[a-z0-9]+/g)??[];
  for(const run of s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)??[])for(let i=0;i<run.length-1;i++)terms.push(run.slice(i,i+2));return new Set(terms);}
function checkedPolicy(policy){
  exact(policy,['strength','consolidation'],'RETENTION_POLICY');
  exact(policy.strength,['fast_half_life','slow_half_life_min','slow_half_life_max','stability_power','slow_weight'],'RETENTION_STRENGTH');
  exact(policy.consolidation,['fast','slow','stability'],'RETENTION_COMPONENTS');
  for(const name of ['fast','slow','stability'])exact(policy.consolidation[name],['encoding_gain','repetition_gain','intensity_power','spacing_half_life'],'RETENTION_COMPONENT');
  return clone(policy); // C++ remains the numerical parameter/domain authority.
}
function checkedRetrievalPolicy(policy){
  exact(policy,['pattern_threshold','retention_floor','specific_match_threshold','minimum_components'],'RETRIEVAL_POLICY');
  for(const name of ['pattern_threshold','retention_floor','specific_match_threshold'])need(Number.isFinite(policy[name])&&policy[name]>=0&&policy[name]<=1,'RETRIEVAL_THRESHOLD');
  need(policy.specific_match_threshold>=policy.pattern_threshold&&Number.isSafeInteger(policy.minimum_components)&&policy.minimum_components>=1&&policy.minimum_components<=16,'RETRIEVAL_COMPONENTS');
  return clone(policy);
}
function checkedCue(cue,owner){
  need(cue?.schema==='asuka.compact-cue/1'&&compactFeatureVersions.includes(cue.representation_version)&&cue.owner_id===owner,'CUE');
  need(['actual','predicted'].includes(cue.reality)&&['self','other','shared','unknown'].includes(cue.owner_role),'CUE_SCOPE');
  const limit=cue.representation_version===COMPACT_FEATURE_VERSION_V3?20:cue.representation_version===COMPACT_FEATURE_VERSION?12:16;
  need(Object.keys(cue.components??{}).length<=limit&&Object.keys(cue.response??{}).length<=4&&cue.frame_refs?.length<=3,'COMPACT_LIMIT');
  for(const v of [...Object.values(cue.components),...Object.values(cue.response)])need(object(v)&&typeof v.known==='boolean'&&(v.known?Number.isFinite(v.value)&&v.value>=-1&&v.value<=1:text(v.reason)&&!own(v,'value')),'COMPACT_COMPONENT');
  need(!['graph','history','curves','states','frames','values'].some(k=>own(cue,k))&&Buffer.byteLength(JSON.stringify(cue))<=16000,'RAW_STATE_FORBIDDEN');
  return clone(cue);
}
function checkedMemory(memory,owner,world){
  const allowed=['id','version','supersedes','event_group','owner_id','world_id','period_id','known_from','body_ref','source_refs','key_description','keywords','cue','origin','actor_refs'];
  need(object(memory)&&Object.keys(memory).every(k=>allowed.includes(k))&&[memory.id,memory.version,memory.event_group,memory.period_id].every(text),'MEMORY');
  need(/^[a-zA-Z0-9._:-]{1,160}$/.test(memory.id)&&!['__proto__','prototype','constructor'].includes(memory.id),'MEMORY_ID');
  need(memory.owner_id===owner&&memory.world_id===world&&Number.isSafeInteger(memory.known_from)&&memory.known_from>=0,'MEMORY_SCOPE');
  need(['canonical','interaction'].includes(memory.origin)&&Array.isArray(memory.source_refs)&&memory.source_refs.length>0&&memory.source_refs.every(text),'MEMORY_SOURCES');
  need(text(memory.key_description)&&memory.key_description.length<=2000&&Array.isArray(memory.keywords)&&memory.keywords.length<=24&&memory.keywords.every(text),'MEMORY_CUES');
  const b=memory.body_ref;need(object(b)&&Object.keys(b).every(k=>['id','revision','path','sha256'].includes(k))&&text(b.id)&&text(b.path)&&Number.isSafeInteger(b.revision)&&b.revision>0&&/^[a-f0-9]{64}$/.test(b.sha256),'BODY_REFERENCE');
  need(memory.actor_refs===undefined||Array.isArray(memory.actor_refs)&&memory.actor_refs.every(text),'ACTORS');
  return {...clone(memory),cue:checkedCue(memory.cue,owner)};
}
function filterEntry(memory,query){
  if(memory.known_from>query.period)return false;
  if(query.period_ids&&!query.period_ids.includes(memory.period_id))return false;
  if(!query.allowed_realities.includes(memory.cue.reality)||!query.allowed_owner_roles.includes(memory.cue.owner_role))return false;
  if(query.source_id&&!memory.source_refs.includes(query.source_id))return false;
  return true;
}
function checkedQuery(query){
  need(object(query)&&Number.isSafeInteger(query.period)&&query.period>=0,'QUERY_PERIOD');
  need(Array.isArray(query.allowed_realities)&&query.allowed_realities.length&&query.allowed_realities.every(v=>['actual','predicted'].includes(v)),'QUERY_REALITY');
  need(Array.isArray(query.allowed_owner_roles)&&query.allowed_owner_roles.length&&query.allowed_owner_roles.every(v=>['self','other','shared','unknown'].includes(v)),'QUERY_OWNER_ROLE');
  if(query.period_ids)need(Array.isArray(query.period_ids)&&query.period_ids.every(text),'QUERY_PERIODS');return query;
}

export class CompactMemory{
  #file;#release;#state;#numeric;#verifyCommit;#readBody;#busy=false;#closed=false;
  static async open({directory,owner_id,world_id,representation_version=COMPACT_FEATURE_VERSION,retention_policy,retrieval_policy,numeric,verifyCommit,readBody=f=>fs.readFileSync(f)}){
    need(text(directory)&&text(owner_id)&&text(world_id)&&compactFeatureVersions.includes(representation_version),'CONFIG');
    need(typeof numeric==='function'&&typeof verifyCommit==='function'&&typeof readBody==='function','CALLBACKS');
    const config={owner_id,world_id,representation_version,retention_policy:checkedPolicy(retention_policy),retrieval_policy:checkedRetrievalPolicy(retrieval_policy)};
    const store=new CompactMemory();fs.mkdirSync(directory,{recursive:true});store.#file=path.join(directory,'compact-index.json');
    store.#release=await exclusiveLease(path.resolve(directory));
    try{
      if(fs.existsSync(store.#file)){store.#state=JSON.parse(fs.readFileSync(store.#file,'utf8'));
        exact(store.#state,['schema','revision','config','entries','active','events'],'INDEX_FIELDS');
        exact(store.#state.config,['owner_id','world_id','representation_version','retention_policy','retrieval_policy'],'INDEX_CONFIG_FIELDS');
        checkedPolicy(store.#state.config.retention_policy);checkedRetrievalPolicy(store.#state.config.retrieval_policy);
        need(store.#state.schema==='asuka.compact-memory-index/1'&&fingerprint(store.#state.config)===fingerprint(config),'FROZEN_CONFIG');
        need(Array.isArray(store.#state.entries)&&object(store.#state.active)&&object(store.#state.events),'INDEX');
        for(const entry of store.#state.entries){const {retention,encoding_event,...memory}=entry;checkedMemory(memory,owner_id,world_id);
          need(object(retention)&&object(retention.seed)&&object(encoding_event),'RETENTION_RECORD');for(const anchor of [retention.seed,retention.local].filter(Boolean)){time(anchor.at);for(const name of ['fast','slow','stability'])signal(anchor[name]);}}
        for(const [id,version]of Object.entries(store.#state.active))need(store.#state.entries.some(e=>e.id===id&&e.version===version),'ACTIVE_REFERENCE');}
      else{store.#state={schema:'asuka.compact-memory-index/1',revision:0,config,entries:[],active:{},events:{}};write(store.#file,store.#state);}
      store.#numeric=numeric;store.#verifyCommit=verifyCommit;store.#readBody=readBody;return store;
    }catch(error){await store.#release();store.#release=null;throw error;}
  }
  snapshot(){need(!this.#closed,'CLOSED');return clone(this.#state);}
  async #operation(fn){need(!this.#closed&&!this.#busy,'BUSY');this.#busy=true;try{return await fn();}finally{this.#busy=false;}}
  async #call(op,inputs,params){return signal(await this.#numeric({op,inputs:clone(inputs),params:clone(params)}));}
  #elapsed(anchor,at,sources){time(at);if(anchor.at===null||at===null)return U('unknown_elapsed_time',sources);need(at>=anchor.at,'TIME_REVERSED');return K(at-anchor.at,sources);}
  async #strength(entry,at,component='combined'){
    const anchor=entry.retention.local??entry.retention.seed,elapsed=this.#elapsed(anchor,at,entry.source_refs);
    // elapsed uses seconds rather than a level; validate it only in the C++ op.
    return this.#call('memory_strength',[anchor.fast,anchor.slow,elapsed,anchor.stability],{...this.#state.config.retention_policy.strength,component});
  }
  async #event(event,kind){
    need(object(event)&&text(event.id)&&object(event.commit)&&event.kind===kind&&Array.isArray(event.source_refs)&&event.source_refs.length&&event.source_refs.every(text),'EVENT');
    time(event.at);signal(event.intensity);const proof=await this.#verifyCommit(clone(event.commit));
    need(typeof proof==='string'&&/^[a-f0-9]{64}$/.test(proof),'COMMITTED_EVENT_REQUIRED');return proof;
  }
  #publish(next){next.revision=this.#state.revision+1;write(this.#file,next);this.#state=next;}
  async remember({memory,event}){return this.#operation(async()=>{
    const proof=await this.#event(event,'encoding'),m=checkedMemory(memory,this.#state.config.owner_id,this.#state.config.world_id);
    const key=fingerprint({operation:'remember',id:m.id,version:m.version,event_id:event.id}),input=fingerprint({memory:m,event,proof});
    if(this.#state.events[key]){need(this.#state.events[key].input_sha256===input,'EVENT_CONFLICT');return {status:'reused',id:m.id,version:m.version};}
    need(!this.#state.entries.some(e=>e.id===m.id&&e.version===m.version),'VERSION_EXISTS');
    need(this.#state.active[m.id]===undefined?m.supersedes===undefined:m.supersedes===this.#state.active[m.id],'EXPLICIT_VERSION_SUCCESSION');
    const zero=K(0,event.source_refs),retention={at:event.at};
    for(const name of ['fast','slow','stability'])retention[name]=await this.#call('memory_consolidate',[zero,event.intensity,zero,zero],this.#state.config.retention_policy.consolidation[name]);
    need(['fast','slow','stability'].every(k=>retention[k].known),'INITIAL_ENCODING_UNKNOWN');
    const next=clone(this.#state);next.entries.push({...m,retention:{seed:retention,local:null},encoding_event:{id:event.id,commit_sha256:proof}});
    next.active[m.id]=m.version;next.events[key]={input_sha256:input,kind:'encoding',id:event.id};this.#publish(next);return {status:'remembered',id:m.id,version:m.version};
  });}
  async reinforce({id,version,event}){return this.#operation(async()=>{
    const proof=await this.#event(event,'actual_recall');need(event.effective===true,'EFFECTIVE_RECALL_REQUIRED');
    const entry=this.#state.entries.find(e=>e.id===id&&e.version===version);need(entry&&this.#state.active[id]===version,'MEMORY_NOT_FOUND');
    const key=fingerprint({operation:'recall',id,version,event_id:event.id}),input=fingerprint({id,version,event,proof});
    if(this.#state.events[key]){need(this.#state.events[key].input_sha256===input,'EVENT_CONFLICT');return {status:'reused',id,version};}
    need(!Object.values(this.#state.events).some(e=>e.kind==='actual_recall'&&e.memory_id===id&&e.version===version&&e.commit_sha256===proof),'SAME_COMMIT_RECALL');
    const previous=entry.retention.local??entry.retention.seed,elapsed=this.#elapsed(previous,event.at,event.source_refs);
    // Missing time is not a zero interval or an empty strengthening event.
    if(!elapsed.known)return {status:'deferred_unknown_time',id,version,changed:false};
    const base={fast:await this.#strength(entry,event.at,'fast'),slow:await this.#strength(entry,event.at,'slow'),stability:previous.stability},local={at:event.at};
    for(const name of ['fast','slow','stability'])local[name]=await this.#call('memory_consolidate',[base[name],event.intensity,K(1,event.source_refs),elapsed],this.#state.config.retention_policy.consolidation[name]);
    need(['fast','slow','stability'].every(k=>local[k].known),'RECALL_CONSOLIDATION_UNKNOWN');
    const next=clone(this.#state),row=next.entries.find(e=>e.id===id&&e.version===version);row.retention.local=local;
    next.events[key]={input_sha256:input,kind:'actual_recall',id:event.id,memory_id:id,version,commit_sha256:proof};this.#publish(next);return {status:'reinforced',id,version,retention:clone(local)};
  });}
  async recall({text:queryText='',cue=null,at=null,budget=6,...scope}){return this.#operation(async()=>{
    checkedQuery(scope);time(at);need(typeof queryText==='string'&&Number.isSafeInteger(budget)&&budget>=0&&budget<=24,'QUERY');if(cue)checkedCue(cue,this.#state.config.owner_id);
    const policy=this.#state.config.retrieval_policy;
    const query=compactMemoryTerms(queryText),normalized=queryText.normalize('NFKC').toLowerCase(),matches=[];
    for(const entry of this.#state.entries){
      if(this.#state.active[entry.id]!==entry.version||!filterEntry(entry,scope))continue;
      const overlap=[...compactMemoryTerms(entry.key_description+' '+entry.keywords.join(' '))].filter(t=>query.has(t));
      const exact=entry.keywords.filter(k=>{const n=k.normalize('NFKC').toLowerCase();return n.length>=2&&(/^[a-z0-9]+$/.test(n)?query.has(n):normalized.includes(n));});
      const keyword=overlap.length>=2||exact.length>0,pattern=cue?compareCompactCues(cue,entry.cue,{minimum_components:policy.minimum_components}):{matched:false,reason:'no_pattern_query'};
      if(!keyword&&!(pattern.matched&&pattern.score>=policy.pattern_threshold))continue;
      const retention=await this.#strength(entry,at),patternStrong=pattern.matched&&pattern.score>=policy.pattern_threshold;
      // A highly specific cue can still locate a weak memory. Retention changes
      // availability for broad pattern matches, never the body or credibility.
      const availablePattern=patternStrong&&(!retention.known||retention.value>=policy.retention_floor||pattern.score>=policy.specific_match_threshold);
      if(!keyword&&!availablePattern)continue;
      matches.push({id:entry.id,version:entry.version,event_group:entry.event_group,key_description:entry.key_description,body_ref:clone(entry.body_ref),source_refs:clone(entry.source_refs),actor_refs:clone(entry.actor_refs??[]),
        owner_id:entry.owner_id,world_id:entry.world_id,period_id:entry.period_id,known_from:entry.known_from,reality:entry.cue.reality,owner_role:entry.cue.owner_role,
        reasons:[...(keyword?[{route:'keyword',terms:overlap,exact_keywords:exact}]:[]),...(availablePattern?[{route:'pattern',...pattern}]:[])],retention,index_revision:this.#state.revision,
        interpretation:'Candidate association only. Original participants, responsibility, actuality and body version are unchanged; reading is not a new memory event.'});
    }
    const keyStrength=c=>c.reasons.find(r=>r.route==='keyword')?.terms.length??0,patternScore=c=>c.reasons.find(r=>r.route==='pattern')?.score??-1;
    matches.sort((a,b)=>Number(b.reasons.some(r=>r.route==='keyword'))-Number(a.reasons.some(r=>r.route==='keyword'))||keyStrength(b)-keyStrength(a)||patternScore(b)-patternScore(a)||a.id.localeCompare(b.id)||a.version.localeCompare(b.version));
    const groups=new Set(),candidates=[],omitted=[];
    for(const match of matches){if(groups.has(match.event_group)){omitted.push({id:match.id,version:match.version,reason:'same_event_group'});continue;}groups.add(match.event_group);
      if(candidates.length>=budget){omitted.push({id:match.id,version:match.version,reason:'candidate_budget'});continue;}candidates.push(match);}
    return {candidates,omitted,index_revision:this.#state.revision,reinforced:false,body_reads:0};
  });}
  async readSelected(candidates,{max_items=2,max_bytes=24000,...scope}){return this.#operation(async()=>{
    checkedQuery(scope);need(Array.isArray(candidates)&&Number.isSafeInteger(max_items)&&max_items>=0&&max_items<=6&&Number.isSafeInteger(max_bytes)&&max_bytes>=0,'BODY_BUDGET');
    const selected=[],omitted=[],seen=new Set();let bytes=0;
    for(const candidate of candidates){
      need(candidate.index_revision===this.#state.revision,'INDEX_CHANGED');const entry=this.#state.entries.find(e=>e.id===candidate.id&&e.version===candidate.version);
      need(entry&&this.#state.active[entry.id]===entry.version&&filterEntry(entry,scope)&&fingerprint(entry.body_ref)===fingerprint(candidate.body_ref),'BODY_SCOPE_OR_VERSION');
      if(seen.has(entry.event_group)||selected.length>=max_items){omitted.push({id:entry.id,reason:'body_budget_or_same_event'});continue;}seen.add(entry.event_group);
      const raw=Buffer.from(await this.#readBody(entry.body_ref.path));need(hash(raw)===entry.body_ref.sha256,'BODY_HASH');
      if(bytes+raw.length>max_bytes){omitted.push({id:entry.id,reason:'body_byte_budget'});continue;}
      const body=JSON.parse(raw.toString('utf8'));need(body.id===entry.body_ref.id,'BODY_IDENTITY');bytes+=raw.length;
      selected.push({...clone(candidate),body,body_sha256:entry.body_ref.sha256});
    }return {selected,omitted,bytes,reinforced:false};
  });}
  async close(){need(!this.#busy,'BUSY');if(!this.#closed){this.#closed=true;if(this.#release){await this.#release();this.#release=null;}}}
}
