// Request-local character/configuration evidence. SDK branch/tail rules still
// decide whether a failed Agent turn is safe to retry, including tool effects.
import fs from 'node:fs';import path from 'node:path';
import {fingerprint} from './personality/general-network/assembly-identity.mjs';
import {publishImmutableDialogueJson} from './dialogue-profile.mjs';
import {validateDialogueContext} from './dialogue-context.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code,retryable:false});};
const str=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n&&!v.includes('\0');
const keys='configuration|configuration_sha256|created_at|dialogue_profile|had_messages|legacy|parent_id|prompt_sha256|request_id|request_key|schema|security_sha256|selected_light|session_id|system_prompt';
export function lightRequestSnapshotPath(directory,sessionId,requestId){
 if(!str(sessionId,512)||!str(requestId,96))fail('DIALOGUE_REQUEST_ID');
 return path.join(path.resolve(directory),'requests',fingerprint(sessionId),fingerprint(requestId)+'.json');
}
function checked(record,{sessionId,requestId,requestKey}){
 if(!record||typeof record!=='object'||Array.isArray(record))fail('DIALOGUE_REQUEST_INVALID');
 const {record_sha256,...body}=record;
 if(Object.keys(body).sort().join('|')!==keys||body.schema!=='asuka.light-request-start/1'||record_sha256!==fingerprint(body))fail('DIALOGUE_REQUEST_HASH');
 if(body.session_id!==sessionId||body.request_id!==requestId||requestKey!==undefined&&body.request_key!==requestKey)fail('DIALOGUE_REQUEST_CHANGED');
 if(!/^[a-f0-9]{64}$/.test(body.request_key??'')||!/^[a-f0-9]{64}$/.test(body.security_sha256??''))fail('DIALOGUE_REQUEST_INVALID');
 if(!str(body.system_prompt,12*1024*1024)||body.prompt_sha256!==fingerprint(body.system_prompt)
   ||body.configuration_sha256!==fingerprint(body.configuration)||!body.configuration?.model||!body.configuration?.light||!body.configuration?.request_policy
   ||typeof body.had_messages!=='boolean'||typeof body.legacy!=='boolean'
   ||body.parent_id!==null&&!str(body.parent_id,256)
   ||body.selected_light!==null&&!/^[a-f0-9]{64}$/.test(body.selected_light??''))fail('DIALOGUE_REQUEST_INVALID');
 if(!str(body.created_at,40)||!Number.isFinite(Date.parse(body.created_at))||new Date(body.created_at).toISOString()!==body.created_at)fail('DIALOGUE_REQUEST_INVALID');
 if(body.dialogue_profile!==null&&validateDialogueContext(body.dialogue_profile).state.session_id!==sessionId)fail('DIALOGUE_REQUEST_CHANGED');
 return structuredClone(record);
}
export function readLightRequestSnapshot({directory,sessionId,requestId,requestKey}){
 const file=lightRequestSnapshotPath(directory,sessionId,requestId);let bytes;
 try{if(fs.statSync(file).size>32*1024*1024)fail('DIALOGUE_REQUEST_TOO_LARGE');bytes=fs.readFileSync(file,'utf8');}
 catch(error){if(error.code==='ENOENT')return null;throw error;}
 let record;try{record=JSON.parse(bytes);}catch{fail('DIALOGUE_REQUEST_INVALID');}
 return checked(record,{sessionId,requestId,requestKey});
}
export function bindLightRequestSnapshot({directory,sessionId,requestId,requestKey,parentId=null,hadMessages=false,
  configuration,systemPrompt,dialogueProfile=null,selectedLight=null,legacy=false,securityHash}){
 const identity={directory,sessionId,requestId,requestKey},old=readLightRequestSnapshot(identity);if(old)return {record:old,created:false};
 const body={schema:'asuka.light-request-start/1',session_id:sessionId,request_id:requestId,request_key:requestKey,
   parent_id:parentId,had_messages:hadMessages,configuration:structuredClone(configuration),configuration_sha256:fingerprint(configuration),
   system_prompt:systemPrompt,prompt_sha256:fingerprint(systemPrompt),dialogue_profile:dialogueProfile?validateDialogueContext(dialogueProfile):null,
   selected_light:selectedLight,legacy,security_sha256:securityHash,created_at:new Date().toISOString()};
 const record=checked({...body,record_sha256:fingerprint(body)},identity);
 if(publishImmutableDialogueJson(lightRequestSnapshotPath(directory,sessionId,requestId),record))return {record,created:true};
 const winner=readLightRequestSnapshot(identity);if(!winner)fail('DIALOGUE_REQUEST_STORAGE');return {record:winner,created:false};
}
