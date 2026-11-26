// A profile bound to the existing Pi conversation, not another conversation
// manager. General inputs and Light snapshots can restore a missing sidecar.
import fs from 'node:fs';import path from 'node:path';
import {fingerprint} from './personality/general-network/assembly-identity.mjs';
import {bindSessionProfile,dialogueStatePath,validateDialogueState,publishImmutableDialogueJson} from './dialogue-profile.mjs';
import {makeDialogueContext,loadDialogueDefaults,validateDialogueContext} from './dialogue-context.mjs';
import {readLightRequestSnapshot} from './light-request-snapshot.mjs';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),fail=code=>{throw Object.assign(new Error(code),{code});};
export function dialogueStateDirectory(sessionDirectory,project){
 return path.resolve(project,process.env.ASUKA_DIALOGUE_STATE_DIR||path.join(sessionDirectory,'.dialogue-state'));
}
function generalHistory(generalDirectory,sessionId){
 if(!generalDirectory)return {hasInput:false,states:[]};
 const file=path.join(generalDirectory,'desktop-links',fingerprint(sessionId)+'.json');
 if(!fs.existsSync(file))return {hasInput:false,states:[]};
 const link=read(file);if(link.pi_id!==sessionId||!/^[a-f0-9-]{36}$/.test(link.session_id??''))fail('DIALOGUE_GENERAL_SOURCE');
 const turns=path.join(generalDirectory,'sessions',link.session_id,'turns');
 const states=[];let hasInput=false;
 for(const name of fs.existsSync(turns)?fs.readdirSync(turns).sort():[]){
  if(!/^turn-\d{6}$/.test(name))continue;const inputFile=path.join(turns,name,'input.json');if(!fs.existsSync(inputFile))continue;
  const input=read(inputFile);hasInput=true;
  if(input.dialogue_profile)states.push(validateDialogueContext(input.dialogue_profile).state);
 }
 return {hasInput,states};
}
export function bindDialogueStateForSession({session,project,sessionDirectory,generalDirectory}){
 const id=session.sessionId??session.sessionManager.getSessionId(),directory=dialogueStateDirectory(sessionDirectory,project),file=dialogueStatePath(directory,id);
 if(fs.existsSync(file))return bindSessionProfile({directory,sessionId:id}).record;
 const prior=generalHistory(generalDirectory,id),states=prior.states;
 const requests=path.join(directory,'requests',fingerprint(id));
 for(const name of fs.existsSync(requests)?fs.readdirSync(requests):[]){
  if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
  const candidate=read(path.join(requests,name));
  if(fingerprint(candidate.request_id)!==name.slice(0,-5))fail('DIALOGUE_REQUEST_SOURCE');
  const request=readLightRequestSnapshot({directory,sessionId:id,requestId:candidate.request_id});
  if(request?.dialogue_profile)states.push(validateDialogueContext(request.dialogue_profile).state);
 }
 if(states.length){
  const state=validateDialogueState(states[0],id);
  if(states.some(row=>fingerprint(validateDialogueState(row,id))!==fingerprint(state)))fail('DIALOGUE_PROFILE_CONFLICT');
  publishImmutableDialogueJson(file,state);
  const restored=bindSessionProfile({directory,sessionId:id}).record;
  if(fingerprint(restored)!==fingerprint(state))fail('DIALOGUE_PROFILE_CONFLICT');
  return restored;
 }
 const hasPriorConversation=prior.hasInput||session.sessionManager.getBranch().some(e=>e.type==='message'&&e.message?.role==='user');
 return bindSessionProfile({directory,sessionId:id,hasPriorConversation,defaults:()=>loadDialogueDefaults(project)}).record;
}
export function bindDialogueForSession(options){return makeDialogueContext(bindDialogueStateForSession(options),options.project);}
