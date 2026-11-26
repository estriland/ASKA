// Standalone model completion using the already configured ModelRuntime.
// No AgentSession, personality, tools, history store, credential reader or retry loop.
import {createHash} from 'node:crypto';
import {inferenceOptions} from './inference-settings.mjs';
import {independentBilling,officialBillingRoute} from './independent-billing.mjs';

// The SDK initializes absent usage to zero and does not retain raw provider usage.
// Preserve its counters separately; never present those defaults as measured cache misses/hits.
export function independentUsage(value){
  const normalized={};
  for(const key of ['input','output','cacheRead','cacheWrite','totalTokens'])
    if(Number.isFinite(value?.[key])&&value[key]>=0)normalized[key]=value[key];
  const positive=key=>normalized[key]>0?normalized[key]:null;
  return {source:'sdk_normalized_raw_usage_unavailable',sdk_normalized:normalized,
    cache_hit_input_tokens:positive('cacheRead'),cache_miss_input_tokens:null,
    output_tokens:positive('output'),total_tokens:positive('totalTokens'),
    note:'SDK defaults missing fields to zero; zero is unconfirmed. Raw prompt_cache_miss_tokens is unavailable; SDK input is a derived counter.'};
}

export function createIndependentGeneration({modelRuntime,resolveSelection}) {
  function snapshot(){
    const {model,setting,defaultReasoning}=resolveSelection();
    if(!model?.provider||!model?.id)throw Error('No resolved client model');
    const selected=structuredClone(model);
    const options=inferenceOptions({...setting,max_tokens:1200,timeout_seconds:120},selected,{defaultReasoning});
    // Detect route or inference changes without publishing endpoints or credentials.
    const configuration_id=createHash('sha256').update(JSON.stringify({model:selected,setting,defaultReasoning,wire_contract:'deepseek-chat-max-tokens/1'})).digest('hex');
    const identity={provider:selected.provider,model:selected.id,adapter_version:'brain-independent/1',configuration_id,
      reasoning:options.reasoning??'off',billing:independentBilling(selected,options.reasoning??'off')};
    return {model:selected,options,identity};
  }
  return {
    describe(){return snapshot().identity;},
    async generate(request,signal){
      const {model,options,identity}=snapshot();
      if(!request||request.external_text_approved!==true||request.max_output_tokens!==1200||
        JSON.stringify(request.expected)!==JSON.stringify(identity))throw Error('Identity/approval mismatch');
      if(typeof request.system!=='string'||request.system.length>8000||!request.input||
        typeof request.input!=='object'||Array.isArray(request.input)||JSON.stringify(request.input).length>20000)
        throw Error('Invalid bounded independent input');
      signal?.throwIfAborted();
      if(request.budget!==undefined){
        if(!identity.billing||JSON.stringify(request.budget)!==JSON.stringify(identity.billing))throw Error('Billing policy changed');
        const auth=await modelRuntime.getAuth(model);
        if(!officialBillingRoute(model,auth))throw Error('Billing route unavailable');
      }
      const callSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000);
      const context={systemPrompt:request.system,tools:[],messages:[{
        role:'user',content:[{type:'text',text:JSON.stringify(request.input)}],timestamp:0,
      }]};
      // This runtime resolves its existing auth internally, as in the production Shin path.
      const response=await modelRuntime.completeSimple(model,context,{...options,signal:callSignal,maxRetries:0});
      callSignal.throwIfAborted();
      const usage=independentUsage(response.usage);
      return {finish:response.stopReason,text:(response.content||[]).filter(b=>b.type==='text').map(b=>b.text).join(''),usage};
    },
  };
}

export function independentHandler(service,readJsonBody){
  return async function handle(req,res){
    if(!['/independent/identity','/independent/generate'].includes(req.url))return false;
    res.setHeader('Content-Type','application/json');
    const controller=new AbortController();
    const abort=()=>{if(!res.writableEnded)controller.abort();};
    res.once('close',abort);
    try{
      if(req.headers.origin||req.headers['x-asuka-independent']!=='1')throw Error('Native client required');
      if(req.url==='/independent/identity'&&req.method==='GET'){
        res.end(JSON.stringify({ok:true,identity:service.describe()}));
      }else if(req.url==='/independent/generate'&&req.method==='POST'&&req.headers['content-type']?.startsWith('application/json')){
        const body=await readJsonBody(req,128*1024);
        const result=await service.generate(body,controller.signal);
        if(!res.destroyed)res.end(JSON.stringify({ok:true,...result}));
      }else throw Error('Unsupported independent operation');
    }catch{
      // Never return or log provider exception bodies, authentication or request contents.
      if(!res.destroyed){res.statusCode=400;res.end(JSON.stringify({ok:false,error:'Independent request refused or failed; no automatic retry'}));}
    }finally{res.off('close',abort);}
    return true;
  };
}
