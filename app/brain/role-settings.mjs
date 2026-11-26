import fs from 'node:fs';
import path from 'node:path';

const schema='asuka.role-settings/1';
const valid=(ok)=>{if(!ok)throw Object.assign(new Error('角色设定格式无效'),{code:'ROLE_SETTINGS_INVALID'});};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keysAre=(value,keys)=>object(value)&&Object.keys(value).sort().join('|')===keys;
const empty=()=>({schema,overrides:{}});
const lastValid=new Map();
const warned=new Set();
export function normalizeRoleSettings(value){
  valid(keysAre(value,'overrides|schema')&&value.schema===schema&&object(value.overrides));
  const overrides={};
  for(const [key,entry] of Object.entries(value.overrides)){
    valid(['origin','life_premise','current_life','speaking_style'].includes(key));
    if(key==='origin')valid(keysAre(entry,'mode|text')&&['extend','replace'].includes(entry.mode));
    const raw=key==='origin'?entry.text:entry;
    valid(typeof raw==='string'&&!raw.includes('\0')&&[...raw.trim()].length<=4000);
    const text=raw.trim();
    if(key==='origin'){
      if(text||entry.mode==='replace')overrides.origin={mode:entry.mode,text};
    }else if(text||key!=='current_life')overrides[key]=text;
  }
  return {schema,overrides};
}

export function loadRoleSettings(project){
  const sibling=process.env.ASUKA_DIALOGUE_CONFIG||process.env.ASUKA_SETTINGS_PATH||process.env.ASUKA_SESSION_DIR;
  const directory=sibling?path.dirname(sibling):path.join(project,'client');
  const file=path.resolve(project,process.env.ASUKA_ROLE_CONFIG||path.join(directory,'role-settings.local.json'));
  try{
    const value=normalizeRoleSettings(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')));
    lastValid.set(file,value);warned.delete(file);return structuredClone(value);
  }catch(error){
    if(error.code==='ENOENT'){lastValid.delete(file);warned.delete(file);return empty();}
    if(!warned.has(file)){console.warn('角色设定暂时无法读取，沿用最近可用的设定。');warned.add(file);}
    return structuredClone(lastValid.get(file)??empty());
  }
}

export const encodeRoleData=value=>JSON.stringify(value).replace(/[<>&]/g,c=>({'<':'\\u003c','>':'\\u003e','&':'\\u0026'}[c]));
export function roleData(fields){
  const data={};
  for(const key of ['origin','life_premise','speaking_style','current_life']){
    if(key in fields)data[key]=key==='origin'?fields.origin.text:fields[key];
  }
  return data;
}

export function applyRoleToView(base,fields={},stage='reply'){
  if(!Object.keys(fields).length)return base;
  const original=fields.origin;
  let view={...base};
  if(original?.mode==='replace'){
    const {subject,character_name}=base.identity;
    view={identity:{subject,character_name},life_premise:base.life_premise??'',self_knowledge:[],
      ...(stage==='analysis'?{}:{dispositions:base.dispositions??[]})};
  }
  if(original&&Object.hasOwn(base,'biography')){
    view.biography=original.mode==='replace'?original.text:[base.biography,original.text].filter(Boolean).join('\n');
  }else if(original?.text)view.self_knowledge=[...(view.self_knowledge??[]),original.text];
  if('life_premise'in fields)view.life_premise=fields.life_premise;
  if(fields.current_life)view.current_life=fields.current_life;
  if(stage!=='analysis'&&'speaking_style'in fields)view.dispositions=fields.speaking_style?[fields.speaking_style]:[];
  return view;
}

export function withRoleSettings(catalog,settings){
  const overrides=settings?.overrides;
  if(!catalog||!overrides)return catalog;
  const replace=overrides.origin?.mode==='replace';
  return {...catalog,context:catalog.context?{...catalog.context,role_overrides:overrides}:catalog.context,
    ...(replace?{rows:[],directory:[],state_routes:[],core:null,role_replaced:true}:{})};
}

// The transport receives a copy. No program annotations enter the SDK branch, chat history or tool results.
export function lightTransportContext(context,systemPrompt,tail){
  if(!tail)return {...context,systemPrompt};
  const messages=context.messages.slice();
  const index=messages.findLastIndex(m=>m.role==='user');
  if(index<0)return {...context,systemPrompt:systemPrompt+'\n'+tail};
  const message=messages[index],content=message.content;
  if(typeof content==='string')messages[index]={...message,content:tail+'\n'+content};
  else if(Array.isArray(content))messages[index]={...message,content:[{type:'text',text:tail+'\n'},...content]};
  else return {...context,systemPrompt:systemPrompt+'\n'+tail};
  return {...context,systemPrompt,messages};
}
