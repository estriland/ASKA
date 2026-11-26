// Check the application's own history storage, independently of agent tools.
import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const STORAGE_CODES=new Set(['EACCES','EPERM','EROFS','ENOSPC','EDQUOT','EIO','EMFILE','ENFILE','ENOENT','EEXIST']);
export const isStorageFailure=error=>error?.code==='SESSION_STORAGE_UNAVAILABLE'||STORAGE_CODES.has(error?.code);
export function storageFailure(error){
  if(error?.code==='SESSION_STORAGE_UNAVAILABLE')return error;
  return Object.assign(new Error('聊天记录无法保存：'+String(error?.message||error),{cause:error}),
    {code:'SESSION_STORAGE_UNAVAILABLE',retryable:true});
}

export function assertSessionDirectoryWritable(directory){
  const probe=join(directory,'.asuka-write-probe-'+randomUUID()+'.tmp');
  let fd=null,created=false;
  try{
    mkdirSync(directory,{recursive:true});
    fd=openSync(probe,'wx');created=true;
    writeFileSync(fd,'asuka-session-storage\n');fsyncSync(fd);
    closeSync(fd);fd=null;unlinkSync(probe);created=false;
  }catch(error){throw storageFailure(error);}
  finally{
    if(fd!==null){try{closeSync(fd);}catch{}}
    if(created){try{unlinkSync(probe);}catch{}}
  }
}

export function assertSessionWritable(manager){
  if(!manager.isPersisted())return;
  const file=manager.getSessionFile();
  assertSessionDirectoryWritable(manager.getSessionDir());
  if(file&&existsSync(file)){
    let fd=null;
    try{fd=openSync(file,'r+');}
    catch(error){throw storageFailure(error);}
    finally{if(fd!==null)closeSync(fd);}
  }
}
