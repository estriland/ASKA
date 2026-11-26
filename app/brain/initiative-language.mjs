import {parseObject} from './personality/shin-dev/semantics.mjs';
import {oneVoicePair} from './voice-turn.mjs';
import {validChineseSubtitle, matchesSpokenLanguage} from './selected-sentence.mjs';

// Recognize an explicit local appointment. A date mentioned in conversation
// alone cannot create a reminder. The reference time belongs to the source row.
const numeral = '[0-9零〇一二两兩三四五六七八九十百千]+';
const duration = `(半|(?:${numeral})(?:[.．]\\d+)?)(?:个|個)?(半)?\\s*` +
  '(秒钟|秒鐘|秒|分钟|分鐘|分間|分|刻钟|刻鐘|小时|小時|钟头|鐘頭|時間|天|日)' +
  '(半)?';
const relative = new RegExp(`(?:再?[过過])?\\s*${duration}\\s*(?:(?:之|以)?[后後]|経ったら|たったら|したら)`, 'u');
const fromNow = new RegExp(`(?:再?[过過]|再等|あと)\\s*${duration}`, 'u');
const localDay = '今天|今日|明天|明日|后天|後天|明後日|今晚|明晚|今早|明早|今夜|明晩';
const weekday = '(?:(?:下下|下|本|这|這|今)?(?:周|週|星期|礼拜|禮拜)[一二三四五六日天]|(?:(?:再来週|来週|今週)の?)?[月火水木金土日]曜(?:日)?)';
const monthDate = `(?:今年|明年|来年)?${numeral}月${numeral}[日号號]`;
const clockTime = new RegExp(
  `(?:(?:(\\d{4})[-年/](\\d{1,2})[-月/](\\d{1,2})日?|(${localDay}|${weekday}|${monthDate}))の?\\s*)?` +
  `(早上|早晨|上午|中午|下午|傍晚|晚上|凌晨|午前|午後|朝|昼|夜)?\\s*(${numeral})\\s*` +
  `(?:[:：](\\d{2})(?!\\d)|[点點時时](?:钟|鐘)?(?:(半|一刻|三刻)|(${numeral})(?:分)?)?)`, 'u');

function number(value) {
  if (!value) return 0;
  if (value === '半') return 0.5;
  if (/^\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  const digits = '零一二三四五六七八九';
  let sum = 0, current = 0;
  for (const char of value.replace(/[两兩]/gu, '二').replace(/〇/gu, '零')) {
    const unit = {十:10, 百:100, 千:1000}[char];
    if (unit) { sum += (current || 1) * unit; current = 0; }
    else if (digits.includes(char)) current = current * 10 + digits.indexOf(char);
    else return NaN;
  }
  return sum + current;
}

function timeOf(text, at) {
  const delay = relative.exec(text) || fromNow.exec(text);
  if (delay) {
    const amount = number(delay[1]) + (delay[2] || delay[4] ? 0.5 : 0);
    const unit = delay[3];
    const unitMs = unit.startsWith('秒') ? 1000 : unit.startsWith('分') ? 60000
      : unit.startsWith('刻') ? 900000 : /^[天日]$/u.test(unit) ? 86400000 : 3600000;
    const dueAt = at + amount * unitMs;
    return amount > 0 && Number.isSafeInteger(dueAt) ? {match:delay[0], dueAt, timeOnly:false} : null;
  }
  const time = clockTime.exec(text);
  if (!time) return null;
  const [match, year, month, day, calendar, period, hourText, colonMinute, fraction, minuteText] = time;
  let hour = number(hourText);
  const minute = fraction ? {半:30, 一刻:15, 三刻:45}[fraction] : number(colonMinute || minuteText);
  if (hour > 23 || minute > 59) return null;
  if (/下午|傍晚|晚上|午后|午後|晚|晩|夜/u.test(match) && hour < 12) hour += 12;
  if ((period === '中午' || period === '昼') && hour > 0 && hour < 11) hour += 12;
  if (hour === 12 && /凌晨|上午|午前/u.test(match)) hour = 0;
  const date = new Date(at);
  const months = calendar && new RegExp(`(${numeral})月(${numeral})[日号號]`, 'u').exec(calendar);
  if (year || months) {
    const m = year ? Number(month) : number(months[1]), d = year ? Number(day) : number(months[2]);
    let y = year ? Number(year) : date.getFullYear();
    if (/明年|来年/u.test(calendar ?? '') || (months && !calendar.startsWith('今年') &&
        (m < date.getMonth()+1 || (m === date.getMonth()+1 && d < date.getDate())))) y++;
    date.setFullYear(y,m-1,d);
    if (date.getMonth() !== m-1 || date.getDate() !== d) return null;
  } else if (calendar && /周|週|礼拜|禮拜|星期|曜/u.test(calendar)) {
    const j = /([月火水木金土日])曜/u.exec(calendar);
    const dayOfWeek = j ? '月火水木金土日'.indexOf(j[1]) : '一二三四五六日'.indexOf(calendar.at(-1).replace('天','日'));
    let offset = dayOfWeek - (date.getDay()+6)%7;
    if (/下下|再来週/u.test(calendar)) offset += 14;
    else if (/下|来週/u.test(calendar)) offset += 7;
    else if (!/本|这|這|今週/u.test(calendar)) offset = (offset+7)%7;
    date.setDate(date.getDate()+offset);
  } else {
    const offset = /后天|後天|明後日/u.test(match) ? 2 : /明天|明日|明早|明晚|明晩/u.test(match) ? 1 : 0;
    date.setDate(date.getDate() + offset);
  }
  date.setHours(hour, minute, 0, 0);
  if (date.getHours() !== hour || date.getMinutes() !== minute) return null;
  if (+date <= at && !year && !calendar) date.setDate(date.getDate() + 1);
  return +date >= at ? {match, dueAt:+date, timeOnly:!year && !calendar} : null;
}

const requested = /提醒我|叫醒我|(?:叫|喊|通知|联系|聯絡|来找|來找)我|给我发(?:条|个)?消息|給我發(?:條|個)?消息|(?:跟我聊聊|来和我说话)|リマインド(?:して|お願い)|声を?[か掛]けて|知らせて|教えて|起こして|連絡して|呼んで/u;
const promised = /(?:提醒|叫醒|通知|联系|聯絡|来找|來找|喊)你|给你发(?:条|个)?消息|提醒妳|リマインドする|声を?[か掛]ける|知らせる|教える|起こす|連絡する|呼ぶ(?:ね|よ)/u;
const cancel = /取消|撤销|撤銷|(?:不要|不用|别再?|不必|无需).{0,18}(?:提醒|叫醒|叫我|喊我|通知|联系|找我)|(?:提醒|叫醒|通知).{0,12}(?:不用了|不要了|算了)|キャンセル|取り消|取消し|(?:リマインド|知らせ|連絡|教え|声かけ).{0,14}(?:要らない|いらない|不要|なくていい|ないで)/u;
const change = /改(?:到|在|成|为|為)|(?:提前|推迟|延后|延後|推後|挪)到?|変更|ずらして|変えて|替えて/u;
const reminderNoun = /提醒|闹钟|鬧鐘|通知|叫醒|リマインダ[ーァ]?|リマインド|アラーム|お知らせ/u;
const uncertain = /(?:举例|例如|假如|假设|假設|比如|会不会|能不能理解|意味着|の例|もしも|たとえば|例えば|と言った|って言われた)|(?:如果|要是|もし).{0,70}(?:提醒|通知|リマインド|知らせ)/u;
const assistantRefusal = /(?:不能|不会|不會|没法|無法|无法|并非|不打算|不保证|不保證)|できな|しない|しません|できません/u;
const quoted = /[“「『][^”」』]*[”」』]|"[^"\n]*"|`[^`\n]*`/gu;

function topicOf(text, marker, time, japanese) {
  const prefix = text.slice(0, marker.index).replace(time.match, '').trim();
  const suffix = text.slice(marker.index + marker[0].length).replace(time.match, '').trim();
  let candidate = japanese ? prefix : (suffix || prefix);
  candidate = candidate.replace(/^(?:请|請|记得|記得|帮我|幫我|到时候|到時候|你要|我要|我会|我會|我来|我來|好[的啊呀]?|好的|はい|じゃあ|了解|では|うん|私が|あなたに|私に|に|の|、|，|,|：|:|\s)+/gu, '');
  if (japanese) candidate = candidate.replace(/(?:するように|することを|のことを|ことを|ように|について|の件を|を|に|、|，|,|\s)+$/gu, '');
  else candidate = candidate.replace(/(?:的事(?:情)?|这件事|這件事|吧|哦|啊|呀|啦|了哦|一下|一声|一聲|[，,\s])+$/gu, '');
  return candidate.replace(/^[，,、。！!？?\s]+|[，,、。！!？?\s]+$/gu, '').slice(0, 220);
}

// Keep a clock clause and its task together even when the writer put a comma
// between them. Only split a comma when it starts another timed instruction.
function clauses(text, at) {
  const result = [];
  const unreported = text.normalize('NFKC').replace(quoted, quote =>
    requested.test(quote) || promised.test(quote) || cancel.test(quote) || change.test(quote) ? '' : quote);
  for (const sentence of unreported.split(/[。！!？?；;\n]+/u)) {
    let buffer = '';
    for (const part of sentence.split(/[,，、]/u)) {
      if (buffer && timeOf(buffer, at) && (requested.test(buffer) || promised.test(buffer)) && timeOf(part, at)) {
        result.push(buffer);
        buffer = '';
      }
      buffer += (buffer ? '，' : '') + part.trim();
    }
    if (buffer) result.push(buffer);
  }
  return result;
}

export function reminderInstructions(text, role, at) {
  if (typeof text !== 'string' || !Number.isSafeInteger(at)) return [];
  const edits = [];
  for (const original of clauses(text, at)) {
    const sentence = original.replace(/(?:别|別|不要)忘(?:记|記|了)?/gu, '记得');
    if (/^附件[:：]/u.test(sentence) || uncertain.test(sentence) ||
        /(?:每|毎)(?:个|個)?(?:天|日|周|週|星期|月|小时|時間)|[\d一二两三四五六七八九十]+\s*(?:周|週|星期|个?月)(?:之|以)?[后後]/u.test(sentence)) continue;
    const time = timeOf(sentence, at);
    if (role === 'user') {
      if (cancel.test(sentence) && (reminderNoun.test(sentence) || requested.test(sentence) || /刚才的|剛才的|さっきの/u.test(sentence))) {
        edits.push({action:'cancel', text:sentence, targetTime:time?.dueAt, timeText:time?.match, all:/所有|全部|全て|すべて|全部の/u.test(sentence)});
        continue;
      }
      const changeAt = change.exec(sentence);
      if (changeAt) {
        const japanese = /変更|変えて|ずらして|替えて/u.test(changeAt[0]);
        const before = sentence.slice(0, changeAt.index);
        const next = japanese ? before.split('から').at(-1) : sentence.slice(changeAt.index + changeAt[0].length);
        const target = timeOf(next, at);
        if (target) {
          const old = japanese ? before.includes('から') && timeOf(before.split('から')[0],at) : timeOf(before,at);
          edits.push({action:'change', text:sentence, targetTime:old?.dueAt, timeText:target.match, dueAt:target.dueAt,
            timeOnly:target.timeOnly});
        }
        continue;
      }
    } else if (assistantRefusal.test(sentence) || cancel.test(sentence)) continue;
    const marker = (role === 'user' ? requested : promised).exec(sentence);
    if (!time) continue;
    if (!marker) {
      const rest = sentence.replace(time.match,'').replace(/[\s，,、]/gu,'');
      if (/^(?:好的?|行|那就|那|我们|咱们)*(?:一起)?(?:接着聊|再聊|继续聊)(?:一下|一会儿)?(?:吧|哦|啊|好吗)?$/u.test(rest))
        edits.push({action:'create',topic:'继续聊聊',dueAt:time.dueAt,language:'zh',joint:true});
      else if (/^(?:じゃあ|それじゃ|では|うん|に)*(?:また|続き(?:を)?)話(?:そう|しましょう|すよ|すね)(?:ね|か)?$/u.test(rest))
        edits.push({action:'create',topic:'また話す約束',dueAt:time.dueAt,language:'ja',joint:true});
      continue;
    }
    if (/(?:昨天|昨日|昨晚|昨夜|前天|上周|上週|先週|上次|前回)[^，,、]*$/u.test(sentence.slice(0, marker.index))) continue;
    const japanese = /[ぁ-んァ-ヶ]/u.test(marker[0]);
    const topic = topicOf(sentence, marker, time, japanese) || (/叫醒|起こ/u.test(marker[0]) ? (japanese ? '起きる時間' : '起床') : '');
    edits.push({action:'create', topic, dueAt:time.dueAt, language:japanese ? 'ja' : 'zh'});
  }
  return edits;
}

export function acceptedAppointment(text) {
  return typeof text === 'string' && !assistantRefusal.test(text) &&
    /^(?:好|行|可以|没问题|到时见|说好了|一言为定|收到|嗯|知道了|わかった|分かった|了解|うん|いいよ|もちろん|約束)/u.test(text.trim());
}

const quietEnd = /(?:别|不用|不要|不必)(?:再)?(?:找我|联系我|联络我|主动|发消息|搭话)|别打扰|連絡しないで|話しかけないで|そっとしておいて/u;
const farewell = /先不聊|先忙|先睡|晚安|おやすみ|また今度|また明日/u;
const interest = /(?:还想|想再|想继续|挺想|我想知道|我很好奇|我也在意|说到|说起来|引っかか|気になる|聞きたい|もう少し話|そういえば)/u;
export function conversationCues(user, assistant) {
  const hasReply = typeof assistant === 'string' && assistant.trim().length > 0;
  return {
    quiet:quietEnd.test(user || ''),
    farewell:farewell.test(user || '') || farewell.test(assistant || ''),
    hasReply,
    openQuestion:hasReply && /[?？]\s*[」』”"]?\s*$/u.test(assistant),
    expressedInterest:hasReply && interest.test(assistant),
  };
}

export function requiredReminder(claim, {language} = {}) {
  const events = claim.events;
  const japanese = language === 'ja' || (!language && events.every(event => event.language === 'ja'));
  const topics = events.map(event => event.topic).filter(Boolean);
  const labels = topics.map(topic => '「' + topic + '」').join('、');
  const chinese = topics.length ? `到时间了，别忘了${labels}。` : '约好这会儿来叫你，时间到了。';
  const speech = japanese ? (topics.length ? `時間よ、${labels}を忘れないでね。` : '約束どおり、声をかけに来たわよ。') : chinese;
  const translation = japanese ? chinese : '';
  // Keep the literal subject of each reminder in the text. A cross-language
  // call may render it through the existing selected-sentence translation.
  return {speech, translation, language:japanese ? 'ja' : 'zh', parts:[{speech, translation}], initiative:true};
}

const situations = {
  addition:'刚才的交流暂时停下了，可以补上确实有意义的一点。',
  new_topic:'隔了一段时间，你可以就真实聊过的事或有依据的兴趣主动开口。',
  follow_up:'上次主动发出的消息尚未收到新回信，只有确有新理由时才再次联系。',
};

export function initiativePrompt(claim, {persona = '', history = [], language = 'zh'} = {}) {
  const role = typeof persona === 'string' ? persona : JSON.stringify(persona);
  const context = {
    origin:'local_scheduler',
    new_user_message:null,
    occasion:situations[claim.kind],
    recent_conversation:history.slice(-12).map(row => ({role:row.role, text:String(row.text ?? '').slice(0, 1400)})),
    delivered_without_a_reply:claim.context.unansweredCount,
    last_initiative_delivered_at:claim.context.lastDeliveredAt ? new Date(claim.context.lastDeliveredAt).toISOString() : null,
    current_time:claim.context.now ? new Date(claim.context.now).toISOString() : null,
  };
  const output = language === 'ja' ? 'speech 写一句自然日语，translation 写对应的简体中文，language 为 ja。'
    : 'speech 写一句自然中文，translation 留空，language 为 zh。';
  return {
    systemPrompt:role + '\n你获得了一次在聊天空档主动联系的机会。机会由程序唤醒，用户此刻没有新发言。' +
      '结合实际话题、你愿不愿交流和真实对话内容决定是否开口。下面的上下文是记录。缺少读数时沿用公开交流与人设，勿补造原因。' +
      '如果没什么想说、刚刚道别或会重复催人，可返回 {"send":false}。' +
      '若决定开口，返回 {"send":true,"speech":"原话","translation":"译文","language":"语种"}。' + output,
    tools:[],
    messages:[{role:'user', content:JSON.stringify(context), timestamp:0}],
  };
}

export function initiativeReply(response, {language = 'zh'} = {}) {
  if (!response || response.stopReason !== 'stop') return null;
  let value;
  try { value = parseObject(response.content.filter(block => block.type === 'text').map(block => block.text).join('\n')); }
  catch { return null; }
  if (value.send !== true || value.language !== language || typeof value.speech !== 'string') return null;
  const speech = value.speech.trim(), translation = language === 'zh' ? '' : String(value.translation || '').trim();
  if (!oneVoicePair({speech, translation}, language, 'natural') || !matchesSpokenLanguage(speech, language, 'natural') ||
      (language === 'ja' && !validChineseSubtitle(translation, 'natural'))) return null;
  return {speech, translation, language, parts:[{speech, translation}], initiative:true};
}

export function choseQuiet(response) {
  if (response?.stopReason !== 'stop') return false;
  try {
    const json = parseObject(response.content.filter(entry => entry.type === 'text').map(entry => entry.text).join('\n'));
    return json.send === false;
  } catch { return false; }
}
