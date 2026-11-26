// High-confidence Mandarin prose within a line marked Japanese. These cues are
// sentence grammar, not a dictionary of names or a global Han-to-kana ratio.
import {authoredInput} from './file-attachments.mjs';
const JA = new Set(['ja','ja-jp','ja_jp','jp','japanese','日语','日本語']);
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/gu;
const WORDS = /(?:[我你妳他她它][们們]|[这這那][个個样樣种種些里裡]|[怎什][么麼]|为什|為什|[没沒]有|[没沒]人|[时時]候|[觉覺]得|知道|不是|就是|不[会會]|[还還]是|[也就]不|[说說][过過]|一个人|一個人|[别別][把用想再]|的[事人话話]|[你妳您]|[吗嗎吧呢啊]|[这這]|[们們])/gu;
const DISTINCTIVE = /[你妳您们們这這吗嗎么麼啥吧呢呀啦]/u;

function prose(value) {
  const text=String(value??'').normalize('NFKC')
    .replace(/(?:\x60{3}[\s\S]*?(?:\x60{3}|$)|\x60[^\x60\n]*\x60|https?:\/\/[^\s「」『』<>]+|(?:[A-Za-z]:[\\/]|\.{0,2}\/)[^\s「」『』<>]+)/gu,' ');
  // A quoted title or an intentional foreign-language quotation is not the
  // language of its surrounding Japanese sentence.
  const outside=text.replace(/「[^「」]*」|『[^『』]*』|“[^“”]*”|‘[^‘’]*’|"[^"\n]*"/gu,' ');
  return outside;
}

function hanGrams(text) {
  const grams=new Set();
  for(const match of text.matchAll(/\p{Script=Han}{5,}/gu)) {
    const chars=Array.from(match[0]);
    for(let i=0;i<=chars.length-5;i++)grams.add(chars.slice(i,i+5).join(''));
  }
  return grams;
}

export function mixedJapaneseSpeech(speech,language,translation='') {
  if(!JA.has(String(language??'').toLowerCase()) || typeof speech!=='string')return false;
  let captionGrams;
  for(const clause of prose(speech).split(/[。！？!?；;\n]+/u)) {
    const han=(clause.match(HAN)||[]).length;
    if(han<4)continue;
    const cues=new Set(clause.match(WORDS)??[]);
    if(!cues.size)continue;
    const kana=(clause.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)||[]).length;
    if(kana>4 && kana*2>han)continue;
    if(cues.size>=2 && (DISTINCTIVE.test(clause) || !kana && han>=7))return true;
    if(han<6 || !translation)continue;
    captionGrams??=hanGrams(prose(translation));
    if([...hanGrams(clause)].some(gram=>captionGrams.has(gram)) &&
       (DISTINCTIVE.test(clause) || cues.size>=2 || !kana && han>=9))return true;
  }
  return false;
}

export const includesKana = value => KANA.test(String(value??''));
export function mixedVoiceScript(value) {
  const text=prose(value);
  return KANA.test(text) && DISTINCTIVE.test(text) && (text.match(WORDS)??[]).length>0;
}
const isJapaneseCode = value => JA.has(String(value??'').toLowerCase());
export function spokenCode(value){
  const lang=String(value??'').toLowerCase();
  if(isJapaneseCode(lang))return 'ja';
  if(/^(?:zh(?:[-_](?:cn|tw|hans|hant))?|chinese|中文)$/.test(lang))return 'zh';
  if(/^(?:en(?:[-_](?:us|gb))?|english|英语)$/.test(lang))return 'en';
  return lang;
}
export function chineseCaption(value) {
  if(typeof value!=='string' || !value.trim())return false;
  const text=prose(value);
  return /\p{Script=Han}/u.test(text) && !KANA.test(text);
}

const JA_GRAMMAR=/(?:あたし|あんた|[のこそあれ]は|って|なの|でしょ|です|ます|だよ|じゃない|だった|[A-Za-z0-9][よね][。！？])/u;
export function mixedNarration(value){
  const text=prose(value);
  return JA_GRAMMAR.test(text) && (text.match(/\p{Script=Hiragana}/gu)||[]).length>=2 &&
    (text.match(HAN)||[]).length>=5 && new Set(text.match(WORDS)??[]).size>=2;
}

export function targetScriptMismatch(value,language,translation){
  const lang=spokenCode(language);
  if(lang==='ja')return mixedJapaneseSpeech(value,lang,translation);
  const text=prose(value);
  if(lang==='zh')return mixedNarration(text) ||
    (JA_GRAMMAR.test(text) && (text.match(/\p{Script=Hiragana}/gu)||[]).length>=6 && !(text.match(WORDS)||[]).length);
  return lang==='en' && (text.match(/[\p{Script=Han}\p{Script=Hiragana}]/gu)||[]).length>=5 &&
    (text.match(/\b[a-z]{2,}\b/giu)||[]).length<2;
}

// Bind straightforward user directions. Translation, verbatim and ambiguous
// multilingual requests retain the user's original wording for the model.
function userLanguageChoice(value) {
  const text=authoredInput(value).normalize('NFKC')
    .replace(/`{3}[\s\S]*?(?:`{3}|$)|`[^`\n]*`|「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"/gu,' ')
    .split(/[，,。！？!?；;\n]/u)
    .filter(clause=>!/^\s*(?:你|妳|我|他|她)(?:上次|刚才|之前|以前|昨天)(?:是)?(?:用|说|講|讲)/u.test(clause))
    .join(' ').trim();
  if (!text) return null;
  if (/(?:逐字|原样(?:读|念|复述|输出)|只(?:回|念|读)(?:编号|原文)|verbatim|repeat exactly|そのまま読)/iu.test(text))
    return {language:null,persistent:false};
  const tokens=text.match(/中文|汉语|漢語|国语|國語|普通话|普通話|日语|日語|日文|日本語|英语|英語|英文|中国語|Chinese|Mandarin|Japanese|English/giu);
  if (!tokens) return null;
  const single=text.replace(/[\s。.!！?？]+/g,'').toLowerCase()===tokens[0].toLowerCase();
  const direction=/(?:用|改成|换成|切换到|翻成|译成|翻译为|讲|說|说|使用)(?:简体|繁体)?\s*(?:中|汉|漢|国|國|普|日|英)|(?:中文|汉语|日语|日文|英语|英文)\s*(?:回答|答复|回复|聊天|聊|说)|(?:中国語|日本語|英語)\s*(?:で(?:話|答|返|お願い)|に(?:して|変え))|\b(?:speak|use|switch to|(?:answer|reply|respond|write|say|talk) in|translate.{0,40} into)\s+(?:English|Chinese|Mandarin|Japanese)\b|\b(?:English|Chinese|Japanese)\s+please/iu.test(text);
  if (!single && !direction) return null;
  const langs=new Set(tokens.map(t=>/日|japanese/i.test(t)?'ja':/英|english/i.test(t)?'en':'zh'));
  // Complex/negative directions are interpreted from the user's own wording.
  const language=langs.size===1 && !/(?:(?:不要|别|別)(?:用|说|說|讲|講)|don't|do not|使わない)/iu.test(text)?[...langs][0]:null;
  const persistent=/(?:以后|以後|今后|今後|接下来|从现在|從現在|一直|切换到|改用|换成|聊天|(?:换|換|改)(?:用)?(?:中文|日语|日語|日文|英语|英語|英文)聊|これから|from now on|keep speaking|switch to)/iu.test(text)
    && !/(?:这(?:一)?[句条次轮]|這(?:一)?[句條次輪]|just this|this (?:one|reply|sentence)|今回は)/iu.test(text);
  return {language,persistent};
}

function chooseSpokenLanguage(current,history,fallback) {
  const explicit=userLanguageChoice(current);
  if (explicit) return explicit.language;
  for (let i=history.length-1;i>=0;i--) {
    const m=history[i];
    if (m.role!=='user') continue;
    const text=typeof m.text==='string'?m.text:typeof m.content==='string'?m.content:(m.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
    const choice=userLanguageChoice(text);
    if (choice?.persistent) return choice.language;
  }
  return fallback;
}

export const lightSpokenLanguage=(current,history=[])=>chooseSpokenLanguage(current,history,'ja');
export const explicitSpokenLanguage=(current,history=[])=>chooseSpokenLanguage(current,history,null);
export function detectedSpeechLanguage(value){
  const text=prose(value);
  if(mixedNarration(text))return 'und';
  if((text.match(WORDS)||[]).length>0 && /\p{Script=Han}/u.test(text) && !JA_GRAMMAR.test(text))return 'zh';
  if(includesKana(text))return 'ja';
  return /\p{Script=Han}/u.test(text)?'zh':/\b[a-z]{2,}\b/i.test(text)?'en':null;
}
export function generalSpokenLanguage(current,history=[]) {
  const detected=detectedSpeechLanguage(authoredInput(current));
  return chooseSpokenLanguage(current,history,detected==='und'?null:detected);
}
