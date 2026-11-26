// One format-only attempt per Light request. Previously published receipts retain their text.
import fs from 'node:fs';
import path from 'node:path';
import {resolveReply,inspectReply,japaneseScriptMismatch} from './personality/shin-dev/reply-protocol.mjs';
import {sourceParagraphs} from './reply-parts.mjs';
import {mixedJapaneseSpeech,includesKana,chineseCaption,spokenCode,targetScriptMismatch} from './utterance-language.mjs';
import {SINGLE_VOICE,oneVoicePair,oneVoiceTextFallback,publishedVoice} from './voice-turn.mjs';
import {selectedLanguage,matchesSpokenLanguage,validChineseSubtitle,translateSelectedSentence} from './selected-sentence.mjs';
import {publishImmutableDialogueJson} from './dialogue-profile.mjs';

export const LEGACY_LIGHT_FORMAT='light-language-before-result/1';
export const LIGHT_FORMAT='light-language-before-result/2';
// Publication policy is frozen per request; the client still consumes the
// original one-segment acoustic contract (SINGLE_VOICE).
export const SELECTED_VOICE_FORMAT='light-selected-sentence/1';
export const singleVoiceFormat=contract=>contract===SINGLE_VOICE||contract===SELECTED_VOICE_FORMAT;
const DEFAULT_FORMAT=LIGHT_FORMAT;
const voiceLanguage=(behavior,target)=>target || (['ja','zh','en'].includes(spokenCode(behavior.language))?spokenCode(behavior.language):'ja');
const selectedTarget=(behavior,target)=>target || selectedLanguage(behavior.speech,behavior.language) || voiceLanguage(behavior,null);

export function needsLightLanguageRepair(behavior,contract=DEFAULT_FORMAT,targetLanguage=null,voicePreset=null) {
  if (!behavior?.speech) return false;
  if (singleVoiceFormat(contract)) {
    const lang=contract===SELECTED_VOICE_FORMAT?selectedTarget(behavior,targetLanguage):voiceLanguage(behavior,targetLanguage);
    return (contract===SELECTED_VOICE_FORMAT && (Boolean(behavior.voice_error) || !matchesSpokenLanguage(behavior.speech,lang,voicePreset))) ||
      !oneVoicePair(behavior,lang,voicePreset) || spokenCode(behavior.language)!==lang ||
      targetScriptMismatch(behavior.speech,lang,behavior.translation) || (lang!=='zh'&&!chineseCaption(behavior.translation));
  }
  if (contract===LIGHT_FORMAT && targetLanguage && spokenCode(behavior.language)!==targetLanguage) return true;
  if (contract===LIGHT_FORMAT && (targetLanguage==='ja'||targetLanguage==='en') && !chineseCaption(behavior.translation)) return true;
  const check=contract!==LIGHT_FORMAT ? japaneseScriptMismatch : targetLanguage ? targetScriptMismatch : mixedJapaneseSpeech;
  return check(behavior?.speech,behavior?.language,behavior?.translation);
}

function repairOptions(behavior,contract,targetLanguage,voicePreset=null) {
  if (contract===SINGLE_VOICE) {
    const lang=voiceLanguage(behavior,targetLanguage);
    return {singleVoice:true,voicePreset,targetLanguage:lang,languageMismatch:targetScriptMismatch,captionValid:lang==='zh'?null:chineseCaption};
  }
  if (contract!==LIGHT_FORMAT) return {sourceParts:sourceParagraphs(behavior.speech)};
  if (targetLanguage==='en' || targetLanguage==='zh')
    return {targetLanguage,languageMismatch:targetScriptMismatch,captionValid:targetLanguage==='en'?chineseCaption:null};
  // A wholly Chinese original can be the literal subtitle. A mixed original
  // needs a real bilingual pair, otherwise its kana would reappear in the caption.
  return !includesKana(behavior.speech) && chineseCaption(behavior.speech)
    ? {languageMismatch:mixedJapaneseSpeech,sourceParts:sourceParagraphs(behavior.speech)}
    : {languageMismatch:mixedJapaneseSpeech,captionValid:chineseCaption};
}

export function textOnlyLanguageFallback(behavior,contract=DEFAULT_FORMAT,targetLanguage=null) {
  if (!behavior?.speech) return behavior;
  if (contract===SELECTED_VOICE_FORMAT) return selectedProjection(behavior,targetLanguage);
  if (contract===SINGLE_VOICE) return behavior.voice_error ? oneVoiceTextFallback(behavior) :
    needsLightLanguageRepair(behavior,contract,targetLanguage)?oneVoiceTextFallback(behavior):publishedVoice(behavior);
  if (!needsLightLanguageRepair(behavior,contract,targetLanguage)) return behavior;
  const mixed=contract===LIGHT_FORMAT && includesKana(behavior.speech) && mixedJapaneseSpeech(behavior.speech,'ja',behavior.translation);
  const language=mixed?'und':contract!==LIGHT_FORMAT || chineseCaption(behavior.speech)?'zh':spokenCode(behavior.language)||'und';
  const result={...behavior,language,
    translation:language!=='zh' && chineseCaption(behavior.translation) && behavior.translation!==behavior.speech ? behavior.translation : '',
    pauses:[],voice_preset:null,voice_expression:null,voice_error:'本条暂以文字回复。'};
  delete result.parts;
  return result;
}

const candidateText=b=>JSON.stringify({speech:b.speech,translation:b.translation??'',language:b.language});
function merge(behavior,reply) {
  const result={...behavior,...reply,pauses:[]};
  delete result.voice_error;
  delete result.voice_expression;
  if (!reply.parts) delete result.parts;
  return result;
}

function cachedResult(behavior,reportDir,contract,targetLanguage,voicePreset=null) {
  const candidate=candidateText(behavior), options=repairOptions(behavior,contract,targetLanguage,voicePreset);
  try {
    if (!fs.existsSync(reportDir)) return null;
    for (const file of fs.readdirSync(reportDir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const report=JSON.parse(fs.readFileSync(path.join(reportDir,file),'utf8'));
      if (report.original_text!==candidate) continue;
      if (report.status==='recovered') {
        const saved=inspectReply({stopReason:'stop',content:[{type:'text',text:report.repaired_text}]},options);
        if (saved.reply) return merge(behavior,saved.reply);
      }
      if (report.repair_attempts>0) return textOnlyLanguageFallback(behavior,contract,targetLanguage);
    }
  } catch { return textOnlyLanguageFallback(behavior,contract,targetLanguage); }
  return null;
}

export function cachedLightBehavior(behavior,reportDir,contract=DEFAULT_FORMAT,targetLanguage=null) {
  if (contract===SELECTED_VOICE_FORMAT) {
    const saved=readSelectedResult(behavior,reportDir,targetLanguage,true);
    if(saved)return saved;
    if(!behavior?.speech)return behavior;
    if(matchesSpokenLanguage(behavior.speech,selectedTarget(behavior,targetLanguage)))return selectedProjection(behavior,targetLanguage);
    // The first formatting phase may already have completed. Validate its
    // cached output against the new speech policy before exposing it on lookup.
    const prior=cachedLightBehavior(behavior,reportDir,SINGLE_VOICE,targetLanguage);
    return selectedProjection(prior,targetLanguage);
  }
  if (!needsLightLanguageRepair(behavior,contract,targetLanguage)) return contract===SINGLE_VOICE?publishedVoice(behavior):behavior;
  const prior=cachedResult(behavior,reportDir,contract,targetLanguage);
  return contract===SINGLE_VOICE&&prior?publishedVoice(prior):prior??behavior;
}

export async function formatGeneratedUtterance({behavior,model,complete,signal,reportDir,voiceStyle='',contract=DEFAULT_FORMAT,targetLanguage=null,voicePreset=null}) {
  if (!needsLightLanguageRepair(behavior,contract,targetLanguage,voicePreset)) return contract===SINGLE_VOICE?publishedVoice(behavior):behavior;
  signal?.throwIfAborted();
  const cached=cachedResult(behavior,reportDir,contract,targetLanguage,voicePreset);
  if (cached) return contract===SINGLE_VOICE?publishedVoice(cached):cached;
  const assistant={role:'assistant',stopReason:'stop',content:[{type:'text',text:candidateText(behavior)}]};
  try {
    const result=await resolveReply({assistant,model,complete,signal,reportDir,voiceStyle,...repairOptions(behavior,contract,targetLanguage,voicePreset)});
    signal?.throwIfAborted();
    const merged=merge(behavior,result.reply);
    return contract===SINGLE_VOICE?publishedVoice(merged):merged;
  } catch {
    signal?.throwIfAborted();
    return textOnlyLanguageFallback(behavior,contract,targetLanguage);
  }
}
function applySelected(behavior,value) {
  const result=merge(behavior,{speech:value.speech,language:value.language,translation:value.translation});
  if(value.voice_error)result.voice_error=value.voice_error;
  return publishedVoice(result);
}

function sourceReading(source,language,destination) {
  const value={speech:source,language,translation:''};
  if(!language || language!==destination)value.voice_error='这句话先用文字显示。';
  return value;
}

function selectedProjection(behavior,targetLanguage) {
  const target=selectedTarget(behavior,targetLanguage);
  const exact=selectedLanguage(behavior.speech,behavior.language);
  const source=exact?behavior:oneVoiceTextFallback(behavior);
  const language=exact||selectedLanguage(source.speech,source.language);
  const result=sourceReading(source.speech,language??'und',target);
  if(exact===target && target!=='zh' && validChineseSubtitle(behavior.translation))result.translation=behavior.translation;
  return applySelected(behavior,result);
}

function readSelectedResult(behavior,dir,target,includeClaim=false) {
  const file=path.join(dir,'selected-reading.json');
  const claim=path.join(dir,'selected-translation-claim.json');
  const available=fs.existsSync(file)?file:includeClaim&&fs.existsSync(claim)?claim:null;
  if(!available)return null;
  let record;
  try{record=JSON.parse(fs.readFileSync(available,'utf8'));}catch{return selectedProjection(behavior,target);}
  if(!record || typeof record.input!=='string' || typeof record.source!=='string')return selectedProjection(behavior,target);
  const input=candidateText(behavior);
  const value=record.value??sourceReading(record.source,record.language,record.destination);
  if(typeof value.speech!=='string' || typeof value.translation!=='string' || typeof value.language!=='string' ||
     (!value.voice_error && (!matchesSpokenLanguage(value.speech,value.language) ||
       (value.translation && !validChineseSubtitle(value.translation)))))return selectedProjection(behavior,target);
  if(record.target!==target || (input!==record.input && input!==candidateText(value) &&
    !(behavior.voice_error && behavior.speech===record.source)))return selectedProjection(behavior,target);
  return applySelected(behavior,value);
}

export async function finalizeLightBehavior(args) {
  if(args.contract!==SELECTED_VOICE_FORMAT || !args.behavior?.speech)return formatGeneratedUtterance(args);
  const {behavior,reportDir,model,complete,signal,targetLanguage=null}=args;
  signal?.throwIfAborted();
  const saved=readSelectedResult(behavior,reportDir,targetLanguage,true);
  if(saved)return saved;
  const target=selectedTarget(behavior,targetLanguage);
  let selected;
  if(matchesSpokenLanguage(behavior.speech,target)){
    if(target==='zh' || validChineseSubtitle(behavior.translation))return selectedProjection(behavior,target);
    // Good spoken text already exists; only its subtitle needs work.
    selected={speech:behavior.speech,language:target};
  }else if(behavior.voice_error && behavior.voice_turn===SINGLE_VOICE){
    // Recovery may start from the saved selection rather than the SDK draft.
    selected=behavior;
  }else{
    const formatted=await formatGeneratedUtterance({...args,contract:SINGLE_VOICE});
    if(!formatted.voice_error && !needsLightLanguageRepair(formatted,SELECTED_VOICE_FORMAT,target))return formatted;
    selected=formatted.voice_error ? formatted : oneVoiceTextFallback(behavior);
  }
  const language=selectedLanguage(selected.speech,selected.language);
  const source=selected.speech;
  const ready=sourceReading(source,language??selected.language,target);
  if(!language)ready.voice_error='这句话先用文字显示。';
  const claim={input:candidateText(behavior),target:targetLanguage,source,language:ready.language,destination:target};
  const destination=language===target ? (target==='zh'?null:'zh') : target;
  let translationUsage;
  if(language && destination && publishImmutableDialogueJson(path.join(reportDir,'selected-translation-claim.json'),claim)){
    translationUsage=null;
    try{
      const translation=await translateSelectedSentence(source,destination,{signal,
        complete:async req=>{
          const response=await complete(model,req,{reasoning:'off',maxTokens:Math.min(model.maxTokens||1024,1024),signal,maxRetries:0,timeoutMs:15000});
          translationUsage=response.usage?.totalTokens??null;
          return response;
        }});
      if(language===target)ready.translation=translation;
      else {ready.speech=translation;ready.language=target;ready.translation=language==='zh'&&target!=='zh'?source:'';delete ready.voice_error;}
    }catch{signal?.throwIfAborted();}
  }
  signal?.throwIfAborted();
  const file=path.join(reportDir,'selected-reading.json');
  if(!publishImmutableDialogueJson(file,{...claim,value:ready,...(translationUsage===undefined?{}:{translation_usage_tokens:translationUsage})})){
    const winner=readSelectedResult(behavior,reportDir,targetLanguage);
    if(!winner)throw Error('已保存的朗读句与本轮不一致');
    return winner;
  }
  return applySelected(behavior,ready);
}
