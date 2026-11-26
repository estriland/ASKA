import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export const REQUEST_RESERVE = 1196608;
const LEGACY_CEILING = 100000000;
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');

function subdirectories(directory) {
  try {
    return fs.readdirSync(directory, {withFileTypes:true}).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function countAttempts(directory, root, totals) {
  for (const phase of subdirectories(directory)) {
    const phaseDir = path.join(directory, phase);
    for (const number of subdirectories(phaseDir)) {
      const raw = path.join(phaseDir, number, 'raw');
      const claim = path.join(raw, 'claim.json');
      try { fs.statSync(claim); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      totals.calls++;
      let result;
      try {
        result = json(path.join(raw,'result.json'));
        if (result?.usage_known === true) {
          if (!Number.isSafeInteger(result.confirmed_tokens) || result.confirmed_tokens < 0) throw new TypeError('invalid usage');
          totals.confirmed += result.confirmed_tokens;
          continue;
        }
        if (result?.usage_status === 'not_dispatched') continue;
      } catch (error) {
        totals.issues.push({attempt:path.relative(root,raw),reason:error.code === 'ENOENT' ? 'claimed_without_result' : 'unreadable_result'});
      }
      totals.unknown++;
    }
  }
}

export function usageBeforeErasure(root, sessionId) {
  const totals={calls:0,confirmed:0,unknown:0,issues:[]};
  const turns=path.join(root,'sessions',sessionId,'turns');
  for(const turn of subdirectories(turns))countAttempts(path.join(turns,turn,'attempts'),root,totals);
  return {schema:'feiniao.erased-usage/1',session_key:checksum(sessionId),
    conservative_delta:totals.confirmed+totals.unknown*REQUEST_RESERVE,unknown_calls:totals.unknown};
}

// Called explicitly for reports, and by policies which really use a cumulative
// ceiling. The desktop's single-call gate needs neither a history scan nor a write.
export function rebuildUsageReport(root, manifest, execution) {
  const priorFile = path.join(root,'prior-report.json');
  const bytes = fs.readFileSync(priorFile);
  if (checksum(bytes) !== manifest.assets['prior-report.json']) throw Object.assign(new Error('Prior usage source changed'),{code:'CHAT_ASSET_CHANGED'});
  const prior = JSON.parse(bytes);
  const supplementDir = path.join(root,'budget-supplements');
  const supplements = fs.existsSync(supplementDir)
    ? fs.readdirSync(supplementDir).filter(name => name.endsWith('.json')).map(name => json(path.join(supplementDir,name))) : [];
  let externalDelta = 0, externalUnknown = 0;
  for (const item of supplements) {
    if (![item.conservative_delta,item.unknown_calls].every(n => Number.isSafeInteger(n) && n >= 0)) {
      throw Object.assign(new Error('Invalid usage supplement'),{code:'CHAT_BUDGET_SUPPLEMENT'});
    }
    externalDelta += item.conservative_delta;
    externalUnknown += item.unknown_calls;
  }
  const totals = {calls:0, confirmed:0, unknown:0, issues:[]};
  const alreadyCounted=new Set(supplements.filter(s=>s.schema==='feiniao.erased-usage/1').map(s=>s.session_key));
  for (const session of subdirectories(path.join(root,'sessions'))) {
    if(alreadyCounted.has(checksum(session)))continue;
    const turns = path.join(root,'sessions',session,'turns');
    for (const turn of subdirectories(turns)) countAttempts(path.join(turns,turn,'attempts'),root,totals);
  }
  for (const probe of subdirectories(path.join(root,'observations'))) {
    for (const arm of ['A','B']) countAttempts(path.join(root,'observations',probe,arm,'attempts'),root,totals);
  }
  const total = prior.conservative_total + externalDelta + totals.confirmed + totals.unknown * REQUEST_RESERVE;
  if (!Number.isSafeInteger(total) || total < 0) throw Object.assign(new Error('Invalid usage total'),{code:'CHAT_BUDGET_TOTAL'});
  const consumed = total - (execution?.baseline_total ?? 0);
  const ceiling = execution?.ceiling ?? LEGACY_CEILING;
  const single = execution?.scope === 'single_call';
  const report = {
    schema:'asuka.experimental-chat-budget/1',status:'continuous_candidate',prior_report:manifest.prior_report,
    previous_reported_total:prior.conservative_total,external_usage_supplements:supplements,
    confirmed_new_tokens:totals.confirmed,current_unknown_usage_calls:totals.unknown,
    prior_unknown_usage_calls:prior.unknown_usage_calls + externalUnknown,
    unknown_usage_calls:prior.unknown_usage_calls + externalUnknown + totals.unknown,
    conservative_total:total,request_reserve:REQUEST_RESERVE,token_ceiling:ceiling,requests:totals.calls,
    budget_scope:execution?.scope ?? 'legacy_total',budget_consumed:consumed,budget_remaining:single ? null : ceiling-consumed,
    ...(single ? {single_call_reserve:REQUEST_RESERVE,single_call_ceiling:ceiling,single_call_ok:REQUEST_RESERVE < ceiling} : {}),
    ...(execution ? {execution_budget:structuredClone(execution)} : {}),
    ...(totals.issues.length ? {accounting_issues:totals.issues} : {}),
    semantic_quality:'unreviewed_experimental',production:false,tts_calls:0,training_runs:0,output_directory:root
  };
  const file=path.join(root,'report.json'), temp=file+'.'+randomUUID()+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  fs.renameSync(temp,file);
  return report;
}
