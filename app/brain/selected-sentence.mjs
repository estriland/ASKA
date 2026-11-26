// A selected sentence is a single source. A translation can supply its
// spoken rendition or its subtitle, but can never replace a known source line.
import {oneVoiceSentence,briefFollowupText} from './voice-turn.mjs';
import {chineseCaption,detectedSpeechLanguage,mixedNarration,mixedVoiceScript,spokenCode,targetScriptMismatch} from './utterance-language.mjs';
import {parseObject} from './personality/shin-dev/semantics.mjs';

const languages = new Set(['ja','zh','en']);
const identifier = /^(?=.*[\dA-Z])[A-Z\d_.+\-]+[。！？!?]?$/u;

function visibleText(text) {
  return text.trim().replace(/^(?:「([^「」]+)」|『([^『』]+)』|“([^“”]+)”|"([^"]+)")([。！？!?]?)$/u,
    (_,a,b,c,d,end)=>(a??b??c??d)+end);
}

function languageForShape(text,hint,preset,accepts) {
  if (typeof text !== 'string' || !/[\p{L}\p{N}]/u.test(text) || /^\s*(?:[\[{]|`{3})/u.test(text)) return null;
  const visible = visibleText(text);
  // The player omits parenthesized stage directions. They cannot be the only words.
  let depth=0,hasSpokenWord=false;
  for(const ch of visible.normalize('NFKC')){
    if(ch==='(')depth++;
    else if(ch===')')depth=Math.max(0,depth-1);
    else if(!depth && /[\p{L}\p{N}]/u.test(ch)){hasSpokenWord=true;break;}
  }
  if(!hasSpokenWord)return null;
  const declared = spokenCode(hint);
  const detected = detectedSpeechLanguage(visible);
  const language = identifier.test(visible) && languages.has(declared) ? declared : detected;
  if (!languages.has(language) || !accepts(text,language,preset) ||
      mixedVoiceScript(visible) || mixedNarration(visible) || targetScriptMismatch(visible,language,'')) return null;
  return language;
}

export function selectedLanguage(text,hint,preset=null) {
  return languageForShape(text,hint,preset,oneVoiceSentence);
}

export function validBriefFollowupPair(speech,translation,language) {
  if(!languages.has(language)||typeof translation!=='string'||languageForShape(speech,language,null,briefFollowupText)!==language)return false;
  if(language==='zh')return !translation;
  return typeof translation==='string' && chineseCaption(visibleText(translation)) &&
    languageForShape(translation,'zh',null,briefFollowupText)==='zh' && !targetScriptMismatch(speech,language,translation);
}

export function matchesSpokenLanguage(text,language,preset=null) {
  return selectedLanguage(text,language,preset)===language;
}

export function validChineseSubtitle(text,preset=null) {
  return typeof text==='string' && chineseCaption(visibleText(text)) &&
    matchesSpokenLanguage(text,'zh',preset);
}

export async function translateSelectedSentence(source,language,{complete,signal,preset=null}) {
  signal?.throwIfAborted();
  const name={zh:'简体中文',ja:'日语',en:'英语'}[language];
  if (!name) throw Error('不支持的朗读语种');
  const response=await complete({
    systemPrompt:'将给定的一句台词完整翻译为'+name+'，保留语气、指代和编号。仅输出 JSON 对象，translation 字段写一句译文。',
    messages:[{role:'user',content:JSON.stringify({source_text:source,target_language:language}),timestamp:0}],tools:[],
  });
  signal?.throwIfAborted();
  if (response?.stopReason!=='stop') throw Error('单句翻译未完成');
  const obj=parseObject((response.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n'));
  const text=typeof obj.translation==='string' ? obj.translation.trim() : '';
  if (!matchesSpokenLanguage(text,language,preset) || (language==='zh' && !validChineseSubtitle(text,preset)))
    throw Error('译文未满足单句与语种要求');
  return text;
}
