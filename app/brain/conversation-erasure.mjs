import fs from 'node:fs';
import path from 'node:path';
import {fingerprint} from './personality/general-network/assembly-identity.mjs';
import {dialogueStatePath,publishImmutableDialogueJson} from './dialogue-profile.mjs';
import {usageBeforeErasure} from '../tools/personality/chat-usage.mjs';
import {eraseIndexedTitle} from './session-title-index.mjs';

const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
function requireOwner(ok){if(!ok)throw Object.assign(new Error('对话数据归属需要检查，删除尚未完成'),{code:'SESSION_DELETE_SCOPE'});}
function entry(file){
  try{return fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function bounded(root,...parts){
  const base=path.resolve(root),file=path.resolve(base,...parts),rel=path.relative(base,file);
  requireOwner(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  let current=base;
  requireOwner(!entry(base)?.isSymbolicLink());
  for(const part of rel.split(path.sep)){
    current=path.join(current,part);requireOwner(!entry(current)?.isSymbolicLink());
  }
  return file;
}
function removeFile(file){
  if(entry(file)){requireOwner(entry(file).isFile());fs.unlinkSync(file);}
}
function removeOwnedDirectory(root,...parts){
  const folder=bounded(root,...parts);
  if(!entry(folder))return;
  requireOwner(entry(folder).isDirectory());
  // Each path component and child is checked; directory links never confer
  // ownership of their targets. Interrupted removal is repeatable.
  function empty(dir){
    for(const child of fs.readdirSync(dir,{withFileTypes:true})){
      const file=bounded(folder,path.relative(folder,dir),child.name);
      if(child.isDirectory()){empty(file);fs.rmdirSync(file);}
      else removeFile(file);
    }
  }
  empty(folder);
  fs.rmdirSync(folder);
}

export function deletionReceipt(root,id){
  if(!uuid.test(id))return null;
  const file=bounded(root,'.session-removal',fingerprint(id)+'.json');
  if(!entry(file))return null;
  const r=read(file);
  requireOwner(r.schema==='feiniao.session-removal/1' && r.id===id &&
    (r.general_id===null||uuid.test(r.general_id)) && (r.sdk_name===null||path.basename(r.sdk_name)===r.sdk_name && r.sdk_name.endsWith('.jsonl')));
  return r;
}

// Only marker presence matters to the sidebar. Erasure and recovery still
// validate the individual receipt before performing any operation.
export function catalogRemovalFilter(root){
  const folder=bounded(root,'.session-removal');
  if(!entry(folder))return ()=>false;
  const markers=new Set(fs.readdirSync(folder));
  return markers.size ? id=>uuid.test(id)&&markers.has(fingerprint(id)+'.json') : ()=>false;
}

export function prepareRemoval({root,id,sdkFile,generalRoot}){
  requireOwner(uuid.test(id));
  const existing=deletionReceipt(root,id);
  if(existing)return existing;
  const sdk=sdkFile?bounded(root,path.basename(sdkFile)):null;
  if(sdk)requireOwner(sdk===path.resolve(sdkFile) && entry(sdk)?.isFile());
  else requireOwner(!fs.readdirSync(root).some(n=>n.endsWith('_'+id+'.jsonl')));
  let generalId=null;
  if(generalRoot){
    const link=bounded(generalRoot,'desktop-links',fingerprint(id)+'.json');
    if(entry(link)){
      const row=read(link);requireOwner(row.pi_id===id && uuid.test(row.session_id));
      generalId=row.session_id;
      const meta=read(bounded(generalRoot,'sessions',generalId,'session.json'));
      requireOwner(meta.id===generalId && meta.namespace?.conversation_id===generalId);
    }
  }
  const receipt={schema:'feiniao.session-removal/1',id,sdk_name:sdk?path.basename(sdk):null,general_id:generalId,
    accounting:generalId?usageBeforeErasure(generalRoot,generalId):null,
    general_namespace:generalRoot?fingerprint(path.resolve(generalRoot)):null};
  publishImmutableDialogueJson(bounded(root,'.session-removal',fingerprint(id)+'.json'),receipt);
  return deletionReceipt(root,id);
}

export function eraseSessionRecords({root,receipt,generalRoot,dialogueRoot,journalRoot,preserveDialogueState=false}){
  const {id,general_id:gid}=receipt;
  requireOwner(uuid.test(id) && receipt.general_namespace===(generalRoot?fingerprint(path.resolve(generalRoot)):null));
  if(gid){
    const links=bounded(generalRoot,'desktop-links'),own=fingerprint(id)+'.json';
    for(const name of fs.readdirSync(links).filter(n=>n.endsWith('.json'))){
      const row=read(bounded(links,name));
      if(name===own)requireOwner(row.pi_id===id && row.session_id===gid);
      else requireOwner(row.session_id!==gid);
    }
    const meta=bounded(generalRoot,'sessions',gid,'session.json');
    if(entry(meta)){const s=read(meta);requireOwner(s.id===gid && s.namespace?.conversation_id===gid);}
    const usage=bounded(generalRoot,'budget-supplements','erased-'+fingerprint(gid)+'.json');
    requireOwner(receipt.accounting?.schema==='feiniao.erased-usage/1');
    publishImmutableDialogueJson(usage,receipt.accounting);
    requireOwner(fingerprint(read(usage))===fingerprint(receipt.accounting));
    removeOwnedDirectory(generalRoot,'sessions',gid);
    removeFile(bounded(links,own));
  }
  const key=fingerprint(id);
  if(!preserveDialogueState)removeFile(bounded(dialogueRoot,path.basename(dialogueStatePath(dialogueRoot,id))));
  for(const name of ['requests','format-reports'])removeOwnedDirectory(dialogueRoot,name,key);
  if(journalRoot)removeOwnedDirectory(journalRoot,key);
  eraseIndexedTitle(root,receipt.id,receipt.sdk_name);
  if(receipt.sdk_name)removeFile(bounded(root,receipt.sdk_name));
}
