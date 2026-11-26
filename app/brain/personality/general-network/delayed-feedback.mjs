// Pure candidate scheduling. References are data; no payload is loaded/executed,
// no clock is read, and no graph value is converted to a psychological effect.
// A commit_context is protected by the HOST's durable commit marker. Staging it
// inside a prepared intent is not proof that that transaction was committed.
const SCHEMA = 'asuka.general-delayed-feedback/1';
const CLOCKS = ['next_iteration','after_commit','next_observation','offline_review'];
const PHASES = ['prepared','committed','observation','offline_review'];
const ORIGIN_KEYS = ['transaction_id','base_revision','candidate_revision','observation_id','iteration','observation_sequence'];
const CONTEXT_KEYS = ['namespace',...ORIGIN_KEYS,'phase'];
const JOB_KEYS = ['schema','id','namespace','clock','source_refs','payload_refs','origin','status','commit_context','ack_context','retired_context'];
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && Boolean(x.trim()) && !x.includes('\0');
const copy = x => structuredClone(x);
const canonical = x => Array.isArray(x) ? x.map(canonical) : object(x)
  ? Object.fromEntries(Object.keys(x).sort().map(key=>[key,canonical(x[key])])) : x;
const same = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function need(ok,code,path) {
  if (!ok) throw Object.assign(new Error(`${code}: ${path}`),{code,path});
}
function fields(value,keys,path) {
  need(object(value),'OBJECT_REQUIRED',path);
  need(keys.every(key=>Object.hasOwn(value,key)),'FIELD_REQUIRED',path);
  need(Object.keys(value).every(key=>keys.includes(key)),'UNEXPECTED_FIELD',path);
}
function namespace(value,path) {
  fields(value,['character_version','conversation_id','world_id'],path);
  need(Object.values(value).every(text),'NAMESPACE_INVALID',path);
}
function context(value,path='context') {
  fields(value,CONTEXT_KEYS,path); namespace(value.namespace,path+'.namespace');
  need(text(value.transaction_id)&&text(value.observation_id),'IDENTITY_REQUIRED',path);
  need(Number.isSafeInteger(value.base_revision)&&value.base_revision>=0
    &&Number.isSafeInteger(value.candidate_revision)&&value.candidate_revision===value.base_revision+1,
  'REVISION_INVALID',path);
  need(Number.isSafeInteger(value.observation_sequence)&&value.observation_sequence>=0,
    'OBSERVATION_SEQUENCE_INVALID',path+'.observation_sequence');
  need(Number.isSafeInteger(value.iteration)&&value.iteration>=0&&value.iteration<=5,
    'ITERATION_RANGE',path+'.iteration');
  need(PHASES.includes(value.phase),'PHASE_INVALID',path+'.phase');
  return value;
}
function references(value,path) {
  need(Array.isArray(value)&&value.length>0&&value.every(text),'REFERENCES_REQUIRED',path);
  return [...new Set(value)];
}
function proposal(value,path) {
  fields(value,['id','clock','source_refs','payload_refs'],path);
  need(text(value.id),'IDENTITY_REQUIRED',path+'.id');
  need(CLOCKS.includes(value.clock),'CLOCK_INVALID',path+'.clock');
  return {id:value.id,clock:value.clock,source_refs:references(value.source_refs,path+'.source_refs'),
    payload_refs:references(value.payload_refs,path+'.payload_refs')};
}
function originMatches(job,ctx) {
  return ['transaction_id','base_revision','candidate_revision','observation_id','observation_sequence']
    .every(key=>job.origin[key]===ctx[key]);
}
function originContext(job,ctx,path) {
  need(same(job.namespace,ctx.namespace),'NAMESPACE_MISMATCH',path);
  need(originMatches(job,ctx),'TRANSACTION_CONTEXT_MISMATCH',path);
  need(ctx.iteration>=job.origin.iteration,'STALE_ITERATION',path+'.iteration');
}
function logicalProposal(value) {
  return {id:value.id,clock:value.clock,source_refs:[...value.source_refs].sort(),payload_refs:value.payload_refs};
}
function observedRevision(ctx) {
  return ctx.phase==='committed' ? ctx.candidate_revision : ctx.base_revision;
}
function notStale(job,ctx,path) {
  need(same(job.namespace,ctx.namespace),'NAMESPACE_MISMATCH',path);
  need(ctx.base_revision>=job.origin.base_revision,'STALE_BASE_REVISION',path);
  if (job.commit_context)
    need(observedRevision(ctx)>=job.commit_context.candidate_revision,'UNCOMMITTED_REVISION',path);
  if (job.origin.transaction_id===ctx.transaction_id) originContext(job,ctx,path);
}
function eligible(job,ctx) {
  if (job.clock==='next_iteration') return ctx.phase==='prepared'&&originMatches(job,ctx)
    &&ctx.iteration>job.origin.iteration&&job.commit_context===null&&job.retired_context===null;
  if (!job.commit_context) return false;
  if (job.clock==='after_commit') return ctx.phase==='committed'
    &&ctx.candidate_revision>=job.commit_context.candidate_revision;
  if (job.clock==='next_observation') return ctx.phase==='observation'
    &&ctx.base_revision>=job.commit_context.candidate_revision
    &&ctx.observation_sequence>job.origin.observation_sequence
    &&ctx.observation_id!==job.origin.observation_id;
  return job.clock==='offline_review'&&ctx.phase==='offline_review'
    &&ctx.base_revision>=job.commit_context.candidate_revision;
}
function jobs(value,ctx) {
  need(Array.isArray(value),'ARRAY_REQUIRED','jobs');
  const ids=new Set();
  return value.map((input,index)=>{
    const path=`jobs[${index}]`; fields(input,JOB_KEYS,path);
    need(input.schema===SCHEMA,'JOB_SCHEMA',path+'.schema');
    const p=proposal(Object.fromEntries(['id','clock','source_refs','payload_refs'].map(key=>[key,input[key]])),path);
    need(!ids.has(input.id),'DUPLICATE_JOB',path+'.id'); ids.add(input.id);
    namespace(input.namespace,path+'.namespace');
    need(same(input.namespace,ctx.namespace),'NAMESPACE_MISMATCH',path+'.namespace');
    fields(input.origin,ORIGIN_KEYS,path+'.origin');
    context({namespace:input.namespace,...input.origin,phase:'prepared'},path+'.origin');
    need(['pending','acknowledged','retired'].includes(input.status),'JOB_STATUS',path+'.status');
    const job={...copy(input),...p};
    if (job.commit_context!==null) {
      context(job.commit_context,path+'.commit_context');
      need(job.clock!=='next_iteration','ITERATION_CANNOT_PERSIST',path);
      need(job.commit_context.phase==='committed','COMMIT_PHASE_REQUIRED',path);
      originContext(job,job.commit_context,path+'.commit_context');
    }
    if (job.retired_context!==null) {
      context(job.retired_context,path+'.retired_context');
      need(job.status==='retired'&&job.clock==='next_iteration'
        &&job.retired_context.phase==='committed','RETIREMENT_INVALID',path);
      originContext(job,job.retired_context,path+'.retired_context');
    }
    need((job.status==='retired')===(job.retired_context!==null),'RETIREMENT_INVALID',path);
    need(job.status!=='pending'||job.ack_context===null,'ACK_CONTEXT_INVALID',path);
    need(job.status!=='acknowledged'||job.ack_context!==null,'ACK_CONTEXT_REQUIRED',path);
    if (job.ack_context!==null) {
      context(job.ack_context,path+'.ack_context');
      notStale(job,job.ack_context,path+'.ack_context');
      // A retired iteration job may retain an earlier, legitimate acknowledgement.
      const beforeRetirement={...job,retired_context:null};
      need(eligible(beforeRetirement,job.ack_context),'ACK_CONTEXT_INVALID',path+'.ack_context');
    }
    return job;
  });
}

/** Prepared proposals add jobs. An empty committed call seals this transaction's
 * non-iteration jobs and retires iteration jobs, retaining their audit history.
 * The host must publish this result only with its durable commit marker. */
export function scheduleFeedback(currentJobs,proposals,rawContext) {
  const ctx=context(rawContext), result=jobs(currentJobs,ctx);
  need(Array.isArray(proposals),'ARRAY_REQUIRED','proposals');
  need(ctx.phase==='prepared'||ctx.phase==='committed','SCHEDULE_PHASE','context.phase');
  need(ctx.phase==='prepared'||proposals.length===0,'PROPOSALS_REQUIRE_PREPARED','proposals');
  for (const job of result) notStale(job,ctx,'jobs.'+job.id);
  if (ctx.phase==='committed') {
    for (const job of result) {
      if (job.commit_context!==null||job.retired_context!==null) {
        if (job.origin.transaction_id===ctx.transaction_id)
          need(same(job.commit_context??job.retired_context,ctx),'COMMIT_CONTEXT_CONFLICT','jobs.'+job.id);
        continue;
      }
      need(originMatches(job,ctx),'COMMIT_ORIGIN_MISMATCH','jobs.'+job.id);
      if (job.clock==='next_iteration') {
        job.status='retired'; job.retired_context=copy(ctx);
      } else job.commit_context=copy(ctx);
    }
    return result;
  }
  const byId=new Map(result.map(job=>[job.id,job]));
  proposals.forEach((raw,index)=>{
    const p=proposal(raw,`proposals[${index}]`), previous=byId.get(p.id);
    if (previous) {
      need(same(logicalProposal(previous),logicalProposal(p)),'JOB_CONFLICT',`proposals[${index}]`);
      return;
    }
    const job={schema:SCHEMA,...p,namespace:copy(ctx.namespace),
      origin:Object.fromEntries(ORIGIN_KEYS.map(key=>[key,ctx[key]])),status:'pending',
      commit_context:null,ack_context:null,retired_context:null};
    result.push(job); byId.set(job.id,job);
  });
  return result;
}

/** Return independent eligible records. No status change or payload execution. */
export function eligibleFeedback(currentJobs,rawContext) {
  const ctx=context(rawContext), checked=jobs(currentJobs,ctx);
  return checked.filter(job=>{
    if (job.status!=='pending') return false;
    notStale(job,ctx,'jobs.'+job.id);
    return eligible(job,ctx);
  });
}

/** Acknowledge only jobs eligible at this exact consumption context. Repeating
 * that context is idempotent; acknowledging under another context is a conflict. */
export function acknowledgeFeedback(currentJobs,ids,rawContext) {
  const ctx=context(rawContext), result=jobs(currentJobs,ctx);
  need(Array.isArray(ids)&&ids.every(text),'IDS_REQUIRED','ids');
  const byId=new Map(result.map(job=>[job.id,job]));
  for (const id of new Set(ids)) {
    const job=byId.get(id); need(job,'JOB_UNKNOWN','ids.'+id);
    if (job.ack_context!==null) {
      need(same(job.ack_context,ctx),'ACK_CONTEXT_CONFLICT','ids.'+id);
      continue;
    }
    notStale(job,ctx,'jobs.'+id);
    need(job.status==='pending'&&eligible(job,ctx),'JOB_NOT_ELIGIBLE','ids.'+id);
    job.status='acknowledged'; job.ack_context=copy(ctx);
  }
  return result;
}
