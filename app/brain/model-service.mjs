// Shared registration for the desktop and its per-turn recorded ModelRuntime.
// Credentials remain runtime-only, and are never used as model definition fields.
export async function registerModelService(runtime, profile) {
  const address=new URL(profile.baseUrl);
  const official=address.origin==='https://api.deepseek.com'&&['','/','/v1','/v1/'].includes(address.pathname);
  const known = official ? runtime.getModel('deepseek',profile.modelId) : null;
  const model = {
    ...(known ? {reasoning:known.reasoning,compat:{...known.compat},thinkingLevelMap:known.thinkingLevelMap} :
      {reasoning:profile.reasoning,compat:{supportsDeveloperRole:false,supportsReasoningEffort:profile.reasoning}}),
    id:profile.modelId,name:profile.name,input:profile.vision?['text','image']:['text'],
    contextWindow:profile.contextWindow,maxTokens:profile.maxTokens,
    cost:known?.cost??{input:0,output:0,cacheRead:0,cacheWrite:0},
  };
  model.reasoning=profile.reasoning??Boolean(known?.reasoning);
  if (profile.api === 'openai-completions' && address.origin === 'https://generativelanguage.googleapis.com'
      && address.pathname.replace(/\/$/, '') === '/v1beta/openai') {
    model.compat.supportsStore = false;
  }
  if (profile.api !== 'openai-completions' && !known) delete model.compat;
  let key = profile.apiKey;
  if (!key && known) {
    // Only the exact official endpoint may reuse its existing configured key.
    const prepared = await runtime.prepareRequest(known,{});
    key = prepared.options?.apiKey;
  }
  if (runtime.getRegisteredProviderIds().includes('custom-api')) runtime.unregisterProvider('custom-api');
  runtime.registerProvider('custom-api',{baseUrl:profile.baseUrl,api:profile.api,models:[model]});
  await runtime.setRuntimeApiKey('custom-api',key || 'local');
  return {...profile,apiKey:key || ''};
}

export function modelTarget(model) {
  const target = Object.fromEntries(['provider','id','api','baseUrl','contextWindow','maxTokens','reasoning','compat','thinkingLevelMap']
    .filter(k=>model[k]!==undefined).map(k=>[k,structuredClone(model[k])]));
  const url = new URL(target.baseUrl);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('模型地址须不含凭据、查询串或片段');
  return target;
}
