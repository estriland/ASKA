// Conservative request ceiling, not an expected bill. Reviewed 2026-10-18.
export function independentBilling(model, reasoning, now=Date.now()) {
  const expires_at='2026-10-19T00:00:00.000Z';
  const rates=model.id==='deepseek-v4-pro'?[1.32,3.96]:
    ['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp'].includes(model.id)?[.30,1.20]:null;
  if(model.provider!=='deepseek'||model.api!=='openai-completions'||!officialBillingRoute(model)||!rates||reasoning!=='off'||now>=Date.parse(expires_at))return null;
  // Entire published 1M context rounded UP to 2^20; no cache/off-peak discount.
  const input_tokens_ceiling=1048576, output_tokens_ceiling=1200;
  return {policy:'deepseek-official-20261018/2',wire_contract:'deepseek-chat-max-tokens/1',currency:'USD',expires_at,
    source:'https://api-docs.deepseek.com/quick_start/pricing/',
    input_tokens_ceiling,output_tokens_ceiling,
    input_usd_per_million:rates[0],output_usd_per_million:rates[1],
    per_call_micro_usd:Math.ceil(input_tokens_ceiling*rates[0]+output_tokens_ceiling*rates[1]),
    method:'full-context upper bound; peak cache-miss pricing; no tools; no retries; non-thinking only'};
}
export function officialBillingRoute(model, auth) {
  const base=auth?.auth?.baseUrl||model.baseUrl;
  try{return ['https://api.deepseek.com','https://api.deepseek.com/v1'].includes(new URL(base).href.replace(/\/$/,''));}catch{return false;}
}
