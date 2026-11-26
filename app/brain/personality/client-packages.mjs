import {readFileSync,existsSync,mkdirSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
export const selectionPath=root=>process.env.ASUKA_PERSONALITY_SELECTION||join(root,'client/personality.local.json');
export const libraryPath=root=>process.env.ASUKA_PERSONALITY_LIBRARY||join(root,'data/personality/packages');
export function normalizeSelection(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('人格选择记录必须为对象');
  const out={light:value.light??null,native:value.native??null};
  for(const id of Object.values(out))if(id!==null&&(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw Error('人格选择记录无效');
  return out;
}
export function selectionFingerprint(value){
  const selected=normalizeSelection(value);
  return selected.light===null&&selected.native===null?'builtin':digest(JSON.stringify(selected));
}
function text(value,label,max=200000){
  if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(label+'为空或过长');
}
export function validateBundle(bundle,{root,nativeCheck=false}={}){
  if(bundle?.schema!=='asuka.client-personality/v1')throw Error('需要客户端人格包；旧预览图或单独网络不能用于聊天');
  text(bundle.name,'人格名称',100);
  if(bundle.kind==='light')text(bundle.prompt,'Light人格正文');
  else throw Error('此预览支持文字人格文件');
  return bundle;
}
export function loadSelection(root,requested){
  const path=selectionPath(root);
  const selected=normalizeSelection(requested??(existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{}));
  const result={selected,fingerprint:selectionFingerprint(selected),light:null,native:null};
  for(const kind of ['light']){
    if(!selected[kind])continue;
    const data=readFileSync(join(libraryPath(root),selected[kind]+'.json'));
    if(data.length>10*1024*1024||digest(data)!==selected[kind])throw Error('已选人格文件被修改或过大，请重新导入');
    const bundle=validateBundle(JSON.parse(data.toString('utf8')),{root,nativeCheck:true});
    if(bundle.kind!==kind)throw Error('人格类型与选择位置不匹配');
    result[kind]=bundle;
  }
  return result;
}
export function saveSelection(root,selected){
  const path=selectionPath(root),temporary=join(dirname(path),'.'+randomUUID()+'.tmp');
  mkdirSync(dirname(path),{recursive:true});
  try{writeFileSync(temporary,JSON.stringify(normalizeSelection(selected)),'utf8');renameSync(temporary,path)}
  finally{if(existsSync(temporary))unlinkSync(temporary)}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const root=resolve(import.meta.dirname,'../..');
    const data=readFileSync(0);if(data.length>10*1024*1024)throw Error('人格包超过10MB');
    validateBundle(JSON.parse(data.toString('utf8')),{root,nativeCheck:true});
    console.log(JSON.stringify({ok:true}));
  }catch(e){console.log(JSON.stringify({ok:false,error:e.message}));process.exitCode=1}
}
