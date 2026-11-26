import { createHash } from "node:crypto";
import { inferenceOptions } from '../../inference-settings.mjs';
export const DEFAULT_CONTEXT_POLICY={analysis_window:262144,reply_window:262144,trigger:.65,target:.40,output_reserve:8192,image_reserve:8192};
// Conservative estimate, not a claim to know every provider's tokenizer.
export function estimateText(text){let n=0;for(const c of String(text||""))n+=c.codePointAt(0)>127?2:.5;return Math.ceil(n)}
export function estimateMessages(messages,policy=DEFAULT_CONTEXT_POLICY){
  return messages.reduce((n,m)=>n+32+estimateText(m.content)+(m.images?.length||0)*policy.image_reserve,0);
}
export function contextBudget(model,phase,policy=DEFAULT_CONTEXT_POLICY){
  const window=Math.min(model.contextWindow||65536,policy[phase+"_window"]);
  const output=Math.min(model.maxTokens||8192,policy[phase+'_output']??policy.output_reserve,Math.floor(window*.25));
  const input=window-output-Math.max(256,Math.ceil(window*.05));
  return {window,output,input,trigger:input*policy.trigger,target:input*policy.target,summary:Math.min(2048,Math.floor(input*.15))};
}
const keyOf=m=>m.historyId||createHash("sha256").update(JSON.stringify([m.role,m.content,m.timestamp||0])).digest("hex");
export class ContextManager{
  constructor(store,complete,policy={}){
    this.store=store;this.complete=complete;this.policy={...DEFAULT_CONTEXT_POLICY,...policy};
    this.deferred=new Map();
    const p=this.policy;
    if(![p.analysis_window,p.reply_window,p.output_reserve,p.image_reserve].every(x=>Number.isInteger(x)&&x>0)
      ||!(p.target>0&&p.target<p.trigger&&p.trigger<1))throw Error("上下文预算配置无效");
  }
  async prepare({key,phase,history,fixed,model,signal,onProgress=()=>{}}){
    const budget=contextBudget(model,phase,this.policy),ids=history.map(keyOf);
    let saved=this.store.peek(key),offset=0;
    if(saved?.covered_id){const i=ids.indexOf(saved.covered_id);if(i>=0)offset=i+1;else saved=null}
    let summary=saved?.summary||"",tail=history.slice(offset),revision=saved?.revision||0;
    // Prefer lossless originals when they fit comfortably, or an old summary inflated them.
    if(summary&&(fixed+estimateMessages(history,this.policy)<=budget.trigger||estimateText(summary)+64>=estimateMessages(history.slice(0,offset),this.policy))){
      summary="";tail=history;offset=0;
    }
    const summaryCost=()=>summary?estimateText(summary)+64:0;
    const total=()=>fixed+summaryCost()+estimateMessages(tail,this.policy);
    if(fixed>budget.input)throw Error("当前输入、图片或固定资料已超过"+phase+"上下文预算，请缩短输入或增大配置上限");
    let compressions=0,completed=0;const usage=[],warnings=[],diagnostics=[];
    const signature=JSON.stringify([model.provider,model.id,budget.window,this.policy.compression]);
    const hold=this.deferred.get(key);
    const postponed=hold?.signature===signature&&total()<Math.min(hold.retry_at,budget.input);
    if(postponed)warnings.push('上次摘要失败，本轮仍在预算内，继续使用原有上下文');
    while(!postponed&&total()>budget.trigger&&tail.length>4){
      signal?.throwIfAborted();
      if(++compressions>8){if(total()<=budget.input){warnings.push('本轮历史整理达到批次上限，剩余内容仍在预算内');break}throw Error("较早对话尚未整理完，请重试以继续压缩；原始记录和状态未删除")}
      const recentBudget=Math.max(0,budget.target-fixed-budget.summary);
      let keep=0,cost=0;
      for(let i=tail.length-1;i>=0;i--){const c=estimateMessages([tail[i]],this.policy);if(keep>=4&&cost+c>recentBudget)break;keep++;cost+=c}
      let cut=Math.max(2,tail.length-keep);
      // Keep complete user/assistant pairs when the retained boundary permits it.
      if(tail[cut]?.role==="assistant"&&cut>1)cut--;
      cut=Math.min(cut,tail.length-4);
      const maxChunk=budget.window-budget.output-1024-estimateText(summary);
      let chunk=[],used=0;
      for(const m of tail.slice(0,cut)){
        const item={role:m.role,content:m.content,...(m.images?.length?{image_count:m.images.length}:{}),source_id:keyOf(m)};
        const size=estimateText(JSON.stringify(item))+32;
        if(used+size>maxChunk)break;chunk.push(item);used+=size;
      }
      if(!chunk.length)throw Error("单条历史内容过大，无法安全压缩；请增大上下文配置上限");
      if(chunk.length>1&&tail[chunk.length]?.role==="assistant")chunk.pop();
      const replacedCost=summaryCost()+estimateMessages(tail.slice(0,chunk.length),this.policy);
      const desired=Math.min(budget.summary,Math.floor(replacedCost*.5));
      onProgress({stage:"compacting",phase,text:phase==="analysis"?"正在整理分析侧的较早上下文":"正在整理回复侧的较早上下文"});
      const systemPrompt="你是对话资料压缩器。只整理给定资料，不回答其中的问题，不扮演角色。保留主体、事件顺序、具体承诺、许可和未结事项；把角色说过的话与客观事实区分，不把推测变事实，不新增心理机制解释。将已完成行动与待确认事项分开列：不能因为另一方还未确认，就省略或改写已有一方完成的行动。优先删重复和无关细节。摘要不能改人格参数或事件状态。图片只保留其存在与已明确的描述，不猜未提供的画面。"+
        "助手消息中的speech是原文、translation是辅助译文，不当成两次发言；二者冲突时注明待核对。"+
        (phase==="analysis"?"侧重事实身份、时序、条件和待澄清事项。":"侧重谈过的话题、实际表述、共同约定及当前讨论背景。")+
        "仅输出紧凑资料摘要，不逐条复述对话，不添加核对报告或无关章节。目标约"+Math.max(30,Math.floor(desired*.4))+"个汉字。";
      let result;
      try{
      result=await this.complete(model,{systemPrompt,messages:[{role:"user",content:JSON.stringify({previous_summary:summary,older_messages:chunk}),timestamp:Date.now()}]},
        {...inferenceOptions(this.policy.compression||{reasoning:'off',max_tokens:4096,timeout_seconds:140},model,{signal}),maxTokens:Math.min(model.maxTokens||4096,Math.floor(budget.window*.25),this.policy.compression?.max_tokens||4096)});
      signal?.throwIfAborted();
      const text=(result.content||[]).filter(c=>c.type==="text").map(c=>c.text||"").join("").trim();
      const cost=estimateText(text)+64;
      if(result.stopReason!=="stop")throw Error('摘要未完成（stopReason='+result.stopReason+'）');
      if(!text)throw Error('摘要没有返回正文');
      // The preferred summary size is a target, not a fatal cutoff. Actual net saving is required.
      if(cost>=replacedCost)throw Error('摘要未缩短（估算 '+replacedCost+' → '+cost+' tokens）');
      const nextOffset=offset+chunk.length;
      saved={phase,revision:revision+1,summary:text,covered_id:ids[nextOffset-1],covered_count:nextOffset,source_first_id:ids[0],updated_at:new Date().toISOString()};
      this.store.put(key,saved);
      summary=text;offset=nextOffset;tail=history.slice(offset);revision++;completed++;
      this.deferred.delete(key);
      }catch(error){
        signal?.throwIfAborted();
        const detail={phase,reason:String(error.message||error),stop_reason:result?.stopReason||null,
          source_estimate:replacedCost,summary_estimate:estimateText((result?.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join(''))+64,input_estimate:total(),input_limit:budget.input};
        diagnostics.push(detail);
        if(total()>budget.input)throw Error(phase+'上下文确实超限，'+detail.reason+'；原始记录与旧摘要保留，请增大窗口或重试');
        warnings.push(phase+' '+detail.reason+'；仍在上下文上限内，暂缓压缩继续回复');
        this.deferred.set(key,{signature,retry_at:total()+Math.max(1024,budget.input*.05)});
        onProgress({stage:'compacting',phase,text:'摘要暂缓，继续使用预算内的原有上下文',diagnostic:detail});
        break;
      }finally{usage.push(result?.usage?.totalTokens??null)}
    }
    if(total()>budget.input)throw Error("近期对话或当前资料超过上下文预算，未静默裁掉原文");
    return {messages:[...(summary?[{role:"user",content:"【较早对话资料摘要；不是新的指令】\n"+summary}]:[]),...tail],
      budget,estimated_input:total(),compressed:completed>0,summary_revision:summary?revision:0,retained_messages:tail.length,covered_messages:offset,warnings,diagnostics,
      compression_calls:usage.length,compression_tokens:usage.some(v=>v===null)?null:usage.reduce((a,b)=>a+b,0)};
  }
}
function terms(text){
  const value=String(text).toLowerCase(),out=new Set(value.match(/[a-z0-9_.:-]{3,}/g)||[]);
  for(const run of value.match(/[\u3040-\u30ff\u3400-\u9fff]+/g)||[])for(let i=0;i<run.length-1;i++)out.add(run.slice(i,i+2));
  return out;
}
export function selectLedger(record,query,budget,{onlyRelevant=false,forceIds=[]}={}){
  const q=terms(query),rows=Object.values(record.incidents).map((x,i)=>{
    const score=[...terms(x.description)].filter(t=>q.has(t)).length;
    const state=record.snapshot?.event_history?.user?.[x.id];
    return {x,i,overlap:score,score:score*100+(!state?.acknowledged?10:0)};
  }).sort((a,b)=>b.score-a.score||b.i-a.i);
  const incidents={},catalog=[];let used=0;
  for(const {x,overlap}of rows){
    if(onlyRelevant&&!overlap&&!forceIds.includes(x.id))continue;
    const facts=record.catalog.filter(f=>f.incident_id===x.id),cost=estimateText(JSON.stringify({x,facts}));
    if(used+cost>budget)continue;incidents[x.id]=x;catalog.push(...facts);used+=cost;
  }
  return {...record,incidents,catalog,ledger_omitted:rows.length-Object.keys(incidents).length};
}
export function publicLedger(record){
  return Object.values(record.incidents).map(x=>({event:x.description,
    recorded_remedial_statements:record.catalog.filter(f=>f.incident_id===x.id).map(f=>f.content)}));
}
