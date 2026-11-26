import {readFileSync,existsSync,lstatSync,realpathSync,mkdirSync,readdirSync,writeFileSync,renameSync} from 'node:fs';
import {resolve,relative,isAbsolute,parse,join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {createCodingTools} from '@earendil-works/pi-coding-agent';

export const SECURITY_MODES=['chat','read_only','workspace','full'];
export const SECURITY_TOOL_NAMES=['read','write','edit','bash','list_directory','make_directory'];
export const SECURITY_SCHEMA='asuka.tool-security/2';
export const securityPath=root=>process.env.ASUKA_SECURITY_CONFIG||join(root,'client/security.local.json');
const contained=(root,path)=>{const r=relative(root,path);return r===''||(!r.startsWith('..\\')&&!r.startsWith('../')&&r!=='..'&&!isAbsolute(r))};
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;

function normalPath(input,root){
  if(typeof input!=='string'||!input.trim()||input.includes('\0'))throw Error('路径不能为空');
  if(process.platform==='win32'){
    if(/^[\\/]{2}/.test(input)||/^[a-z]:[^\\/]/i.test(input)||input.replace(/^[a-z]:/i,'').includes(':'))throw Error('受限模式不允许UNC、设备路径、驱动器相对路径或数据流');
    if(input.split(/[\\/]/).some(p=>p!=='.'&&p!=='..'&&(/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))))throw Error('不允许Windows特殊文件名');
  }
  return resolve(root,input);
}
function checkComponents(path){
  const base=parse(path).root;let current=base;
  for(const part of relative(base,path).split(/[\\/]/).filter(Boolean)){
    current=join(current,part);
    try{
      const stat=lstatSync(current);
      if(stat.isSymbolicLink())throw Error('受限模式不允许符号链接或目录联接');
      if(stat.isFile()&&stat.nlink>1)throw Error('受限模式不允许硬链接文件');
    }catch(e){if(e.code==='ENOENT')break;throw e}
  }
}
export function normalizeSecurity(value={}){
  let mode=value.mode||'chat';
  if(!SECURITY_MODES.includes(mode))throw Error('安全等级无效，工具已拒绝');
  const current=value.schema===SECURITY_SCHEMA;
  const enabled={workspace:current&&value.enabled?.workspace===true,
    full:current&&value.enabled?.full===true&&value.full_access_confirmed===true};
  // Old grants were made before the two separate capability switches existed.
  // Retain the folder but never silently inherit those grants.
  if(!current||(mode==='workspace'&&!enabled.workspace)||(mode==='full'&&!enabled.full))mode='chat';
  return {schema:SECURITY_SCHEMA,mode,root:typeof value.root==='string'?value.root:'',enabled,full_access_confirmed:enabled.full};
}
export function loadSecurity(root){
  const path=securityPath(root);
  return normalizeSecurity(existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{});
}
export function validateWorkspace(root,applicationRoot){
  const resolved=normalPath(root,applicationRoot);
  if(same(resolved,parse(resolved).root)||same(resolved,homedir()))throw Error('请选择具体项目文件夹，不能选择整个磁盘或用户目录');
  checkComponents(resolved);
  if(!lstatSync(resolved).isDirectory())throw Error('工作文件夹必须是现有目录');
  for(const dir of ['brain','client','tools','runtime','voice','.git','.codex','.agents']){
    const protectedPath=join(applicationRoot,dir);
    if(contained(resolved,protectedPath)||contained(protectedPath,resolved))throw Error('受限工作区不能覆盖客户端程序、凭据或运行组件；自我修改需完全权限');
  }
  return realpathSync(resolved);
}
export function authorizeTool(applicationRoot,policy,name,args){
  policy=normalizeSecurity(policy);
  if(!SECURITY_TOOL_NAMES.includes(name))throw Error('工具未获授权（包括尚未接入的MCP工具）');
  if(policy.mode==='full')return name==='bash'?args:{...args,path:resolve(policy.root||applicationRoot,args.path)};
  if(policy.mode==='chat')throw Error('仅对话模式：本地工具已关闭');
  if(name==='bash')throw Error('受限模式禁止通用终端，请使用文件工具或由用户开启完全权限');
  if(policy.mode==='read_only'&&!['read','list_directory'].includes(name))throw Error('项目只读模式禁止修改');
  if(!policy.root)throw Error('请先在设置中选择允许访问的项目文件夹');
  const root=validateWorkspace(policy.root,applicationRoot),target=normalPath(args.path,root);
  if(!contained(root,target))throw Error('路径超出已授权项目文件夹');
  if(same(target,resolve(securityPath(applicationRoot))))throw Error('Agent不能修改或读取自己的安全配置');
  checkComponents(target);
  // Existing paths are checked again against their actual resolved location.
  if(existsSync(target)&&!contained(root,realpathSync(target)))throw Error('真实路径超出授权目录');
  return {...args,path:target};
}
export function toolNames(policy){
  policy=normalizeSecurity(policy);
  if(policy.mode==='chat'||(!policy.root&&policy.mode!=='full'))return [];
  if(policy.mode==='read_only')return ['read','list_directory'];
  return policy.mode==='full'?[...SECURITY_TOOL_NAMES]:['read','write','edit','list_directory','make_directory'];
}
export function securityGuide(policy){
  return '\n当前代码级安全等级：'+policy.mode+'；授权工作文件夹：'+(policy.root||'未选择')+'。受限模式只能用授权目录内的文件工具，不能运行终端或外部服务；不要尝试绕过权限。完全权限也不代表自动管理员提权。';
}
export function securityTools(applicationRoot){
  const definitions=createCodingTools(applicationRoot);
  const schema={type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false};
  definitions.push({name:'list_directory',label:'List directory',description:'列出授权目录中的文件名；路径相对工作文件夹。',parameters:schema,
    execute:async(_id,args)=>({content:[{type:'text',text:JSON.stringify(readdirSync(args.path,{withFileTypes:true}).map(x=>({name:x.name,directory:x.isDirectory()})))}]})});
  definitions.push({name:'make_directory',label:'Make directory',description:'在授权工作文件夹内创建目录，不执行命令。',parameters:schema,
    execute:async(_id,args)=>{mkdirSync(args.path,{recursive:true});return {content:[{type:'text',text:'目录已创建：'+args.path}]}}});
  return definitions.map(tool=>({...tool,execute:async(id,args,signal,...rest)=>{
    const checked=authorizeTool(applicationRoot,loadSecurity(applicationRoot),tool.name,args);
    signal?.throwIfAborted();
    return tool.execute(id,checked,signal,...rest);
  }}));
}
export function refreshSecurity(session,root){
  const policy=loadSecurity(root);session.setActiveToolsByName(toolNames(policy));
  // Unknown/hallucinated calls are denied even if an SDK registry changes.
  session.agent.beforeToolCall=async({toolCall,args})=>{
    try{authorizeTool(root,loadSecurity(root),toolCall.name,args)}catch(e){return {block:true,reason:e.message}}
  };
  return policy;
}
export function saveSecurity(applicationRoot,value,{capabilities=false}={}){
  if(!SECURITY_MODES.includes(value.mode))throw Error('未知安全等级');
  const previous=loadSecurity(applicationRoot);
  let enabled=previous.enabled,mode=value.mode;
  if(capabilities){
    if(typeof value.enabled?.workspace!=='boolean'||typeof value.enabled?.full!=='boolean')throw Error('请分别设置两项编辑能力');
    if(value.enabled.full&&!previous.enabled.full&&value.full_access_confirmed!==true)throw Error('必须在设置中确认完全权限');
    enabled={workspace:value.enabled.workspace,full:value.enabled.full};
    if((mode==='workspace'&&!enabled.workspace)||(mode==='full'&&!enabled.full))mode='chat';
  }else{
    if(value.enabled!==undefined||value.full_access_confirmed!==undefined)throw Error('编辑能力只能在工具权限设置中启用');
    if((mode==='workspace'&&!enabled.workspace)||(mode==='full'&&!enabled.full))throw Error('请先在设置中单独启用这项权限');
  }
  let root=typeof value.root==='string'?value.root:previous.root;
  if(mode==='read_only'||mode==='workspace'){
    if(!root)throw Error('请选择授权工作文件夹');
    root=validateWorkspace(root,applicationRoot);
  }else if(mode==='full'&&root){
    root=realpathSync(resolve(root));
    if(!lstatSync(root).isDirectory())throw Error('工作文件夹必须是目录');
  }
  const result={schema:SECURITY_SCHEMA,mode,root,enabled,full_access_confirmed:enabled.full};
  const path=securityPath(applicationRoot);mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path+'.tmp',JSON.stringify(result,null,2)+'\n');renameSync(path+'.tmp',path);return result;
}
