// Pure host-policy reducer. It does not authenticate the caller, read time,
// alter numerical state, schedule work or grant a language model this API.
import {fingerprint} from './assembly-identity.mjs';

const clone=structuredClone,own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const need=(yes,code,path)=>{if(!yes)throw Object.assign(new Error(code),{code,path});};
const same=(a,b)=>fingerprint(a)===fingerprint(b);
function exact(x,keys,path){need(object(x),'DAILY_CONTROLS_OBJECT',path);need(keys.every(k=>own(x,k))&&Object.keys(x).every(k=>keys.includes(k)),'DAILY_CONTROLS_FIELDS',path);}
function text(x,path){need(typeof x==='string'&&x.trim()&&!x.includes('\0'),'DAILY_CONTROLS_TEXT',path);return x;}
function integer(x,path,positive=false){need(Number.isSafeInteger(x)&&x>=(positive?1:0),'DAILY_CONTROLS_REVISION',path);return x;}
function hash(x,path){need(typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),'DAILY_CONTROLS_HASH',path);return x;}
function policy(x,path){exact(x,['fatigue','satiation'],path);need(typeof x.fatigue==='boolean'&&typeof x.satiation==='boolean','DAILY_CONTROLS_BOOLEAN',path);return clone(x);}
function namespace(x,path){exact(x,['character_version','conversation_id','world_id'],path);Object.values(x).forEach(v=>text(v,path));return clone(x);}
function state(x){
  exact(x,['schema','revision','policy','receipt_id','receipt_sha256'],'state');need(x.schema==='asuka.daily-controls/1','DAILY_CONTROLS_SCHEMA','state.schema');
  integer(x.revision,'state.revision',true);policy(x.policy,'state.policy');text(x.receipt_id,'state.receipt_id');hash(x.receipt_sha256,'state.receipt_sha256');return clone(x);
}
function selectedState(head){
  need(object(head),'DAILY_CONTROLS_HEAD','head');
  return own(head,'daily_controls')?state(head.daily_controls):undefined;
}

/** Absence keeps legacy behavior and serialized head bytes unchanged. */
export function readDailyEffectPolicy(head){
  const current=selectedState(head);if(current===undefined)return undefined;
  return {schema:'asuka.daily-effect-policy/1',fatigue:current.policy.fatigue,satiation:current.policy.satiation,source_refs:[current.receipt_id]};
}

/** Bind a host receipt/candidate to the exact committed policy, not wall time. */
export function policyEpoch(head){
  const current=selectedState(head);return {revision:current?.revision??0,sha256:fingerprint(current??null)};
}

/** A supplied internal receipt must come from the host's trusted ingestion path.
 * New receipts, even with unchanged flags, advance once; the host may avoid
 * creating such a no-op transaction. Retrying the exact receipt is idempotent. */
export function applyDailyControls(current,program,receipt,ns){
  const before=current===undefined?undefined:state(current),scope=namespace(ns,'namespace');
  exact(program,['schema','receipt_id','base_control_revision','policy'],'program');
  need(program.schema==='asuka.daily-controls-program/1','DAILY_CONTROLS_PROGRAM_SCHEMA','program.schema');
  text(program.receipt_id,'program.receipt_id');integer(program.base_control_revision,'program.base_control_revision');const nextPolicy=policy(program.policy,'program.policy');
  exact(receipt,['input','sequence'],'receipt');integer(receipt.sequence,'receipt.sequence',true);
  exact(receipt.input,['id','namespace','kind','payload'],'receipt.input');text(receipt.input.id,'receipt.input.id');
  need(same(namespace(receipt.input.namespace,'receipt.input.namespace'),scope),'DAILY_CONTROLS_NAMESPACE','receipt.input.namespace');
  need(receipt.input.kind==='internal_daily_controls','DAILY_CONTROLS_RECEIPT_KIND','receipt.input.kind');
  exact(receipt.input.payload,['policy','base_control_revision'],'receipt.input.payload');
  const payload=receipt.input.payload;integer(payload.base_control_revision,'receipt.input.payload.base_control_revision');policy(payload.policy,'receipt.input.payload.policy');
  need(receipt.input.id===program.receipt_id&&payload.base_control_revision===program.base_control_revision&&same(payload.policy,nextPolicy),
    'DAILY_CONTROLS_RECEIPT_BINDING','program');
  const receiptHash=fingerprint(receipt);
  if(before?.receipt_id===receipt.input.id){
    need(before.receipt_sha256===receiptHash&&before.revision===program.base_control_revision+1&&same(before.policy,nextPolicy),
      'DAILY_CONTROLS_RECEIPT_REUSED','receipt');
    return clone(before);
  }
  const base=before?.revision??0;
  need(program.base_control_revision===base,'DAILY_CONTROLS_STALE_BASE','program.base_control_revision');
  need(base<Number.MAX_SAFE_INTEGER,'DAILY_CONTROLS_REVISION_OVERFLOW','state.revision');
  return {schema:'asuka.daily-controls/1',revision:base+1,policy:nextPolicy,receipt_id:receipt.input.id,receipt_sha256:receiptHash};
}
