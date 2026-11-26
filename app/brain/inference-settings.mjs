import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {DESKTOP_STAGES,normalizeDesktopStage,normalizeRequestOptions} from './request-options.mjs';
export const DEFAULT_INFERENCE=JSON.parse(readFileSync(new URL('./inference-defaults.json',import.meta.url),'utf8'));
export const DEEPSEEK_MODELS=JSON.parse(readFileSync(new URL('./deepseek-models.json',import.meta.url),'utf8'));
export function normalizeInference(raw={}) {
  const out={};
  for(const key of Object.keys(DEFAULT_INFERENCE)) {
    if(key==='request'){out[key]=normalizeRequestOptions(raw[key]);continue;}
    if(DESKTOP_STAGES.includes(key)){out[key]=normalizeDesktopStage(raw[key]);continue;}
    const s=out[key]={...DEFAULT_INFERENCE[key],...raw[key]};
    if(!['default','off','minimal','low','medium','high','xhigh','max'].includes(s.reasoning))throw Error(key+' 推理强度无效');
    for(const [field,min,max] of [['max_tokens',key==='light'?0:256,262144],['timeout_seconds',10,1200]])
      if(!Number.isInteger(s[field])||s[field]<min||s[field]>max)throw Error(key+' '+field+' 范围无效');
    if(key==='compression') {
      if(!(s.target>0&&s.target<s.trigger&&s.trigger<1)||!Number.isInteger(s.image_reserve)||s.image_reserve<1)throw Error('上下文压缩设置无效');
    } else {
      if(typeof s.model!=='string'||!s.model.trim())throw Error('模型不能为空');
      if(!Number.isInteger(s.context_window)||(s.context_window!==0&&s.context_window<4096)||s.context_window>2000000||(!s.context_window&&key!=='light'))throw Error(key+' 上下文范围无效');
      if(s.context_window&&s.max_tokens>=s.context_window*.8)throw Error(key+' 输出预留过大，必须保留输入空间');
      for(const [f,max]of [['temperature',2],['top_p',1]])if(s[f]!==null&&(!Number.isFinite(s[f])||s[f]<0||s[f]>max||(f==='top_p'&&s[f]===0)))throw Error(key+' '+f+' 范围无效');
    }
  }
  return out;
}
export function loadInference(root){
  const path=process.env.ASUKA_INFERENCE_CONFIG||join(root,'client/inference.local.json');
  if(existsSync(path))return normalizeInference(JSON.parse(readFileSync(path,'utf8')));
  const p=JSON.parse(readFileSync(new URL('./personality/shin-dev/context-policy.json',import.meta.url),'utf8'));
  return normalizeInference({analysis:{context_window:p.analysis_window,max_tokens:p.output_reserve},reply:{context_window:p.reply_window,max_tokens:p.output_reserve},compression:{trigger:p.trigger,target:p.target,image_reserve:p.image_reserve}});
}
// Extend the installed catalog, never modify node_modules or user credentials.
export function registerDeepSeekModels(runtime){
  const base=runtime.getModel('deepseek','deepseek-v4-flash');
  runtime.registerProvider('deepseek',{
    baseUrl:base.baseUrl,api:base.api,
    models:DEEPSEEK_MODELS.map(m=>({...base,...runtime.getModel('deepseek',m.id),id:m.id,name:m.name,
      ...(m.cost?{cost:m.cost}:{}),
      input:m.vision?['text','image']:['text'],reasoning:true,
      thinkingLevelMap:{minimal:null,low:'low',medium:null,high:'high',max:'max'},
      compat:{...base.compat,supportsReasoningEffort:true,thinkingFormat:'deepseek',maxTokensField:'max_tokens'}}))
  });
}
export function selectStageModel(setting,current,runtime){
  if(setting.model==='current')return current;
  const split=setting.model.indexOf('/');
  const model=runtime.getModel(setting.model.slice(0,split),setting.model.slice(split+1));
  if(!model)throw Error('模型未注册：'+setting.model+'；请先配置 API 或启动本地模型');
  return current?.provider===model.provider&&current.id===model.id?current:model;
}
export function inferenceOptions(s,model,{signal,defaultReasoning}={}) {
  const options={signal,maxRetries:0,timeoutMs:s.timeout_seconds*1000};
  let requested=s.reasoning==='default'?(defaultReasoning||'off'):s.reasoning;
  if(model.reasoning===false)requested='off';
  if(s.reasoning==='default'&&model.provider==='deepseek'&&['medium','xhigh'].includes(requested))requested='high';
  if(requested&&model.provider==='deepseek'&&!['off','low','high','max'].includes(requested))throw Error('DeepSeek 支持关闭 / low / high / max，请重新选择');
  if(requested)options.reasoning=requested;
  if(s.max_tokens)options.maxTokens=Math.min(s.max_tokens,model.maxTokens||s.max_tokens);
  const thinking=model.provider==='deepseek'&&requested!=='off';
  if(s.temperature!=null&&!thinking)options.temperature=s.temperature;
  // top_p is not in Pi's common simple options; send it at the supported wire boundary.
  const flash=model.provider==='deepseek' && ['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp'].includes(model.id);
  // V4.1 Flash 1017 uses top_p only while thinking; legacy aliases serve it too.
  // Pro retains the inverse rule. Unknown historical IDs keep the previous policy.
  if(s.top_p!=null&&(flash?thinking:!thinking)) {
    if(!['openai-completions','openai-responses','anthropic-messages'].includes(model.api))throw Error('当前协议未适配 Top P，请留为服务默认');
    const topP=flash?Math.max(.95,s.top_p):s.top_p;
    options.onPayload=payload=>({...payload,top_p:topP});
  }
  if(model.provider==='deepseek'&&model.api==='openai-completions'){
    const previous=options.onPayload;
    options.onPayload=payload=>{
      const next=previous?previous(payload):{...payload};
      const limit=options.maxTokens??next.max_tokens??next.max_completion_tokens;
      delete next.max_completion_tokens;
      if(limit!==undefined)next.max_tokens=limit;
      if(requested==='off')next.thinking={type:'disabled'};
      return next;
    };
  }
  return options;
}
export function inferenceNote(model,options){
  if(model.reasoning===false)return '当前模型注册为不支持推理，未发送SDK推理控制；供应商内部行为以其配置为准';
  if(model.provider!=='deepseek')return '';
  if(['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp'].includes(model.id))
    return 'Flash 1017：思考时Temperature不生效，Top P下限0.95；非思考时Top P固定1。旧Flash别名不固定旧权重。SDK费用按峰价估算，不是实际账单。';
  return options.reasoning!=='off'?'DeepSeek Pro/历史路径：思考时Temperature/Top P不发送；SDK费用估算不等于账单':'';
}
export function stagePolicy(config,legacy={}){
  return {...legacy,analysis_window:config.analysis.context_window,reply_window:config.reply.context_window,
    analysis_output:config.analysis.max_tokens,reply_output:config.reply.max_tokens,
    trigger:config.compression.trigger,target:config.compression.target,image_reserve:config.compression.image_reserve,
    compression:config.compression};
}
