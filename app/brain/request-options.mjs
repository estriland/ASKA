// Shared, non-secret request features. Never accept arbitrary payload overrides:
// model/messages/authentication and the stage output contract belong to runtime.
export const DEFAULT_REQUEST_OPTIONS=Object.freeze({json_mode:'auto',web_search:false});
export function normalizeRequestOptions(raw={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('request 必须是配置对象');
  for(const key of Object.keys(raw))if(!Object.hasOwn(DEFAULT_REQUEST_OPTIONS,key))throw Error('未知请求选项：'+key);
  const out={...DEFAULT_REQUEST_OPTIONS,...raw};
  if(!['auto','json','prompt'].includes(out.json_mode))throw Error('JSON模式须为auto、json或prompt');
  if(typeof out.web_search!=='boolean')throw Error('web_search 须为true或false');
  return out;
}
export function validateRequestTarget(model, options){
  if(options?.json_mode==='json'&&!['openai-completions','openai-responses'].includes(model.api))
    throw Error('当前协议未接入API JSON约束，请将json_mode设为auto或prompt。');
  if(!options?.web_search)return;
  const url=new URL(model.baseUrl);
  if(url.origin!=='https://api.deepseek.com'||!['','/','/v1','/v1/'].includes(url.pathname)
      ||model.api!=='openai-responses'||model.id!=='deepseek-v4-pro')
    throw Error('内置搜索需要 DeepSeek 官方地址、deepseek-v4-pro 和 Responses 协议；请在模型服务调整连接，或在请求配置关闭 web_search。');
}
export function requestUsesJson(model,{options=DEFAULT_REQUEST_OPTIONS,jsonOutput=false,jsonCompatible=false}={}){
  return ['openai-completions','openai-responses'].includes(model.api)
    && options.json_mode!=='prompt' && (jsonOutput || options.json_mode==='json'&&jsonCompatible);
}
export function applyRequestPayload(payload,model,{options=DEFAULT_REQUEST_OPTIONS,jsonOutput=false,jsonCompatible=false,allowSearch=false}={}){
  const next={...payload};
  if(options.json_mode==='json'&&(jsonCompatible||jsonOutput)&&!['openai-completions','openai-responses'].includes(model.api))
    throw Error('当前协议未接入API JSON约束，请将json_mode设为auto或prompt，保留提示中的结构化输出要求。');
  if(requestUsesJson(model,{options,jsonOutput,jsonCompatible})){
    if(model.api==='openai-responses')next.text={...next.text,format:{type:'json_object'}};
    else next.response_format={type:'json_object'};
  }
  if(options.web_search&&allowSearch){
    validateRequestTarget(model,options);
    const tools=[...(next.tools||[])];
    if(!tools.some(t=>t.type==='web_search'))tools.push({type:'web_search'});
    next.tools=tools;
  }
  return next;
}

export const DESKTOP_STAGES=['general_fast','general_quality','general_reply'];
export const DEFAULT_DESKTOP_STAGE=Object.freeze({reasoning:'default',max_tokens:0,timeout_seconds:0,temperature:null,top_p:null});
export function normalizeDesktopStage(raw={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('生成参数必须是配置对象');
  for(const key of Object.keys(raw))if(!Object.hasOwn(DEFAULT_DESKTOP_STAGE,key))throw Error('未知人格模式生成参数：'+key);
  const out={...DEFAULT_DESKTOP_STAGE,...raw};
  if(!['default','off','minimal','low','medium','high','xhigh','max'].includes(out.reasoning))throw Error('推理强度无效');
  if(!Number.isInteger(out.max_tokens)||out.max_tokens<0||out.max_tokens>196608)throw Error('人格模式最大输出须在0到196608之间（0为沿用）');
  if(!Number.isInteger(out.timeout_seconds)||(out.timeout_seconds!==0&&(out.timeout_seconds<10||out.timeout_seconds>1200)))throw Error('超时须为0或10到1200秒');
  for(const [key,max]of [['temperature',2],['top_p',1]])if(out[key]!==null&&(!Number.isFinite(out[key])||out[key]<0||out[key]>max||(key==='top_p'&&out[key]===0)))throw Error(key+' 范围无效');
  return out;
}
export function desktopStageForPhase(phase){
  return ['analysis-fast','analysis-auto','analysis-recovery-fast'].includes(phase)?'general_fast':['analysis','analysis-reference-correction'].includes(phase)?'general_quality':['reply','continuity'].includes(phase)?'general_reply':null;
}
