// Process-local optimization of one synchronous recovery derivation.
// Every observed dependency is checked against current bytes/results before reuse.
// No disk protocol, source authority or semantic validation is introduced here.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const clone=structuredClone;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const list=dir=>fs.readdirSync(dir).filter(name=>name.endsWith('.json')).sort();
const equivalent=(a,b)=>Array.isArray(a)&&Array.isArray(b)?a.length===b.length&&a.every((x,i)=>x===b[i]):a===b;
function freezePrivate(value,seen=new WeakSet()){
  if(value!==null&&typeof value==='object'&&!seen.has(value)){
    seen.add(value);for(const child of Object.values(value))freezePrivate(child,seen);Object.freeze(value);
  }
  return value;
}

export class RecoveryReadCache {
  #cache=null;
  #capture=null;
  #captureFailure=null;
  #hits=0;
  #fullReplays=0;
  #invalidations=0;

  #observe(kind,file,value){
    if(this.#capture===null)return;
    const resolved=path.resolve(file),key=kind+'\0'+resolved;
    const previous=this.#capture.get(key);
    if(previous&&!equivalent(previous.value,value)){
      const error=Object.assign(new Error('RECOVERY_DEPENDENCY_CHANGED'),{code:'RECOVERY_DEPENDENCY_CHANGED'});
      this.#captureFailure??=error;throw error;
    }
    if(!previous)this.#capture.set(key,{kind,path:resolved,value:clone(value)});
  }

  readJson(file){
    try{
      const bytes=fs.readFileSync(file);
      if(this.#capture!==null)this.#observe('bytes',file,digest(bytes));
      return JSON.parse(bytes.toString('utf8'));
    }catch(error){if(this.#capture!==null)this.#captureFailure??=error;throw error;}
  }

  names(dir){
    try{const result=list(dir);this.#observe('names',dir,result);return result;}
    catch(error){if(this.#capture!==null)this.#captureFailure??=error;throw error;}
  }

  exists(file){
    const result=fs.existsSync(file);this.#observe('exists',file,result);return result;
  }

  #unchanged(dependencies){
    for(const dependency of dependencies.values()){
      let value;
      try{
        if(dependency.kind==='bytes')value=digest(fs.readFileSync(dependency.path));
        else if(dependency.kind==='names')value=list(dependency.path);
        else value=fs.existsSync(dependency.path);
      }catch(error){
        // A deleted file/directory invalidates a warm derivation. Its full
        // recomputation must then surface the actual error or new valid branch.
        if(error.code==='ENOENT')return false;
        throw error;
      }
      if(!equivalent(dependency.value,value))return false;
    }
    return true;
  }

  recover(computeSync){
    if(this.#capture!==null)fail('RECOVERY_REENTRANT');
    if(typeof computeSync!=='function')fail('RECOVERY_COMPUTE_REQUIRED');
    if(Object.prototype.toString.call(computeSync)==='[object AsyncFunction]')fail('RECOVERY_ASYNC_COMPUTE_FORBIDDEN');
    if(this.#cache!==null){
      let unchanged;
      try{unchanged=this.#unchanged(this.#cache.dependencies);}
      catch(error){this.#cache=null;this.#invalidations++;throw error;}
      if(unchanged){this.#hits++;return clone(this.#cache.result);}
      this.#cache=null;this.#invalidations++;
    }

    const dependencies=new Map();this.#capture=dependencies;this.#captureFailure=null;this.#fullReplays++;
    try{
      const result=computeSync();
      if(result!==null&&(typeof result==='object'||typeof result==='function')&&typeof result.then==='function')fail('RECOVERY_ASYNC_COMPUTE_FORBIDDEN');
      if(this.#captureFailure!==null)throw this.#captureFailure;
      // Detach before publication: neither the callback's object nor a returned
      // head can mutate the private result retained for the next recovery.
      const retained=freezePrivate(clone(result));
      if(!this.#unchanged(dependencies))fail('RECOVERY_DEPENDENCY_CHANGED');
      this.#cache={dependencies,result:retained};
      return clone(retained);
    }finally{
      // All throw paths leave no usable partially validated result.
      this.#capture=null;this.#captureFailure=null;
    }
  }

  clear(){
    if(this.#capture!==null)fail('RECOVERY_REENTRANT');
    this.#cache=null;
  }

  diagnostics(){
    return Object.freeze({hits:this.#hits,full_replays:this.#fullReplays,
      invalidations:this.#invalidations,dependencies:this.#cache?.dependencies.size??0});
  }
}
