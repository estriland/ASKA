// New read-aloud turns use one public sentence and one acoustic context.
export const SINGLE_VOICE = 'single-spoken-turn/1';
export function callSpeechLanguage(value) {
  if (value === undefined || value === null) return null;
  if (value === 'zh' || value === 'ja') return value;
  throw Object.assign(new Error('通话语种须为日语或中文'),{code:'REQUEST_INVALID'});
}
export function callLineGuide(language, field='speech') {
  const japanese=language==='ja';
  const spoken=japanese?'一句自然日语':'一句自然中文';
  const caption=japanese?'这一句的简体中文字幕':'';
  const payload=JSON.stringify({[field]:spoken,translation:caption,language});
  return '你正在和对方语音通话。挑此刻最想让对方听见的一个意思，用一口气说完整。'+
    '语气词和转折接在同一句里，句中用逗号，句末用一个结束标点。直接交付这一句的 JSON：'+payload+'。'+
    (japanese?'字幕完整对应这句日语。':'中文原话同时作为字幕。')+
    (field==='text'?'如果此刻选择沉默，返回 {"text":null}。':'');
}
export const voiceTurnGuide = '这轮正在朗读。挑此刻最值得说的一个意思，用一句简短、完整、自然的口语回应，然后等对方接话。遇到复杂问题，先说最有用的一点。台词和译文各占一行、表达同一句话。';

const sentences=new Intl.Segmenter('ja',{granularity:'sentence'});
const quotes=/「[^「」\n]*」|『[^『』\n]*』|“[^“”\n]*”|"[^"\n]*"|`[^`\n]*`/gu;
const entirelyQuoted=/^(?:「([^「」]+)」|『([^『』]+)』|“([^“”]+)”|"([^"]+)")$/u;

function units(value){
  const parts=[];
  for(const line of String(value??'').trim().split(/\r\n?|\n/u)){
    const whole=entirelyQuoted.exec(line.trim());
    const inner=whole?.slice(1).find(Boolean);
    // A whole quotation can itself contain several independent sentences.
    const text=inner??line;
    const mask=text.replace(quotes,quoted=>quoted.replace(/[。！？.!?]/gu,'字'));
    for(const s of sentences.segment(mask)){
      const t=text.slice(s.index,s.index+s.segment.length).trim();
      if(t)parts.push(whole&&t===inner?line.trim():t);
    }
  }
  return parts;
}
export function voiceWindow(language,preset){
  return language==='en'?240:preset==='natural'?160:80;
}
export function oneVoiceSentence(text,language,preset=null){
  if(typeof text!=='string'||!text.trim()||/[\r\n]/.test(text.trim()))return false;
  return [...text.trim()].length<=voiceWindow(language,preset) && units(text).length===1;
}

// A continuing utterance can have two short clauses in one acoustic window.
// The primary read-aloud and later idle messages keep their single sentence contract.
export function briefFollowupText(text,language){
  if(typeof text!=='string'||!text.trim()||/[\r\n\u2028\u2029]/u.test(text)||
      [...text].length>voiceWindow(language,null))return false;
  const spoken=units(text).filter(part=>/[\p{L}\p{N}]/u.test(part));
  return spoken.length>0&&spoken.length<=2;
}
export function oneVoicePair(value,language,preset=null){
  return oneVoiceSentence(value?.speech,language,preset) && (language==='zh'
    ? !value.translation||oneVoiceSentence(value.translation,'zh',preset)
    : oneVoiceSentence(value?.translation,'zh',preset));
}
export function publishedVoice(value){
  if(!value?.speech)return value;
  const speech=value.speech.trim(),translation=value.language==='zh'?'':(value.translation||'').trim();
  return {...value,speech,translation,pauses:[],parts:[{speech,translation}],voice_turn:SINGLE_VOICE};
}
export function oneVoiceTextFallback(value){
  if(!value?.speech)return value;
  // A failed bilingual rewrite provides no trustworthy sentence-to-caption alignment.
  // Publish one intact sentence already present in the draft, with speech disabled.
  const caption=value.language!=='zh' && typeof value.translation==='string' && /\p{Script=Han}/u.test(value.translation)
    && !/[\p{Script=Katakana}\p{Script=Hiragana}]/u.test(value.translation) ? value.translation : '';
  const pieces=units(caption||value.speech);
  const speech=pieces.find(t=>/[\p{L}\p{N}]/u.test(t))??pieces[0]??value.speech.trim();
  return publishedVoice({...value,speech,translation:'',language:caption?'zh':value.language,
    voice_preset:null,voice_expression:null,voice_error:'这句话先用文字显示。'});
}
