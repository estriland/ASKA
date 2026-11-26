// Read-only context telemetry. Derived from the existing recorded transport;
// no model calls, compaction, billing aggregation or credential exposure.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return null;}};
const dirs=p=>{try{return fs.readdirSync(p,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name).sort();}catch{return [];}};
const sameTarget=(a,b)=>a&&b&&['provider','id','api','baseUrl','contextWindow'].every(k=>a[k]===b[k]);
export function usageTokens(usage){
  const values=['input','cacheRead','cacheWrite','output'].map(k=>usage?.[k]);
  return values.every(v=>Number.isFinite(v)&&v>=0)?values.reduce((sum,v)=>sum+v,0):null;
}
export function readGeneralContextUsage({directory,sessionId,currentTarget,analysisProfile}){
  assert.match(sessionId,/^[a-f0-9-]{36}$/);
  const session=path.join(directory,'sessions',sessionId);
  const turn=dirs(path.join(session,'turns')).filter(n=>/^turn-\d{6}$/.test(n)).at(-1);
  const folder=turn?path.join(session,'turns',turn):null;
  const policy=folder?read(path.join(folder,'memory-policy.json')):null;
  const window=folder?read(path.join(folder,'history-window.json')):null;
  const base={source:'general-last-request',session_id:sessionId,turn_id:turn||null,phases:[],main:null,
    history:{auto_summary:false,recent_turns:window?.source==='desktop-current-branch'?null:policy?.recent_turns??null,
      omitted_turns:window?.source==='desktop-current-branch'?null:window?.omitted_turns??null,full_history_preserved:true,
      ...(window?.source==='desktop-current-branch'?{shared_dialogue_context:true,context_messages:window.context_counts?.kept??null,
        inherited_summary:window.context_counts?.summaries>0}: {})}};
  if(!folder)return {...base,reason:'no-recorded-request'};
  if(analysisProfile&&read(path.join(folder,'input.json'))?.analysis_profile!==analysisProfile)return {...base,reason:'mode-changed'};
  function phase(name){
    const directory=path.join(folder,'attempts',name);
    for(const attempt of dirs(directory).filter(n=>/^\d+$/.test(n)).reverse()){
      const raw=path.join(directory,attempt,'raw'),result=read(path.join(raw,'result.json'));
      if(result?.status!=='completed')continue;
      const metadata=read(path.join(raw,'metadata.json'));
      if(!sameTarget(metadata?.target,currentTarget))return {mismatch:true};
      const response=read(path.join(raw,'response.json')),tokens=usageTokens(result.usage||response?.usage);
      const contextWindow=metadata.target.contextWindow;
      if(result.usage_known!==true||tokens===null||!Number.isFinite(contextWindow)||contextWindow<=0)return {phase:name,unknown:true};
      return {phase:name,model:metadata.target.id,context_window:contextWindow,tokens,ratio:tokens/contextWindow};
    }
    return null;
  }
  // A completed fast transport may still fail semantic/schema admission and
  // fall back. A saved successful quality analysis is then the actual result.
  const analysis=phase('analysis')||phase('analysis-fast'),automatic=phase('analysis-auto'),reply=phase('reply');
  if(analysis?.mismatch||automatic?.mismatch||reply?.mismatch)return {...base,reason:'model-changed'};
  const phases=[automatic,analysis,reply].filter(p=>p&&!p.unknown),unknown_phases=[automatic,analysis,reply].filter(p=>p?.unknown).map(p=>p.phase);
  const main=unknown_phases.length?null:phases.reduce((a,b)=>!a||b.ratio>a.ratio?b:a,null);
  const route=read(path.join(folder,'analysis-route.json'));
  return {...base,phases,unknown_phases,main,
    ...(route?.requested==='auto'?{automatic_depth:route.effective,automatic_fallback:route.fallback===true}:{}),
    reason:unknown_phases.length?'usage-incomplete':main?'':'no-recorded-request'};
}

export function readPiContextUsage(session,effectiveWindow){
  const usage=session.getContextUsage();
  const last=[...session.messages].reverse().find(m=>m.role==='assistant'&&m.stopReason!=='error'&&m.stopReason!=='aborted');
  const known=last?.model===session.model?.id&&last?.provider===session.model?.provider&&last?.api===session.model?.api&&usageTokens(last?.usage)!==null;
  const tokens=known&&Number.isFinite(usage?.tokens)?usage.tokens:null;
  const window=Math.min(usage?.contextWindow||effectiveWindow,effectiveWindow);
  const main=tokens===null||!window?null:{phase:'light',tokens,context_window:window,ratio:tokens/window,model:session.model?.id};
  return {source:'pi-current-estimate',main,phases:main?[main]:[],history:{auto_summary:session.autoCompactionEnabled===true},
    compacting:session.isCompacting===true,reason:main?'':'no-recorded-request'};
}
