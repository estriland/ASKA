// The selector reads the final utterance and verified current-turn evidence.
// Its decision is a rendering choice; nothing here mutates personality state.
const activeLevels = new Set(['较弱', '中等', '明显']);
const currentFactKinds = new Set(['observed', 'self_report']);
const presentOccurrences = new Set(['completed', 'ongoing']);

export function currentAffect(state, inputId) {
  const events = new Set((state.identities?.events ?? []).filter(event =>
    event.occurrence_kind === 'current' && event.origin?.input_id === inputId &&
    event.participants?.includes(state.subject) &&
    event.participants.includes('user')).map(event => event.id));
  const facts = new Map();
  for (const fact of state.facts ?? []) {
    if (!events.has(fact.occurrence_id) || fact.observation_id !== inputId ||
        fact.presentation !== 'current_report' || !presentOccurrences.has(fact.occurrence_status) ||
        !currentFactKinds.has(fact.epistemic_status) || !fact.ref?.id || !Number.isInteger(fact.ref.revision)) continue;
    facts.set('content:' + fact.ref.id + '@' + fact.ref.revision, fact.occurrence_id);
  }
  const cues = [];
  for (const row of state.readouts ?? []) {
    if (row.mechanism !== 'A.emotions' || row.temporal_role !== 'level' ||
        row.coverage !== 'provided' || !activeLevels.has(row.current_symbol) ||
        !['positive_affect', 'negative_affect'].includes(row.type) ||
        row.scope?.subject !== state.subject || (row.scope.other && row.scope.other !== 'user') ||
        !events.has(row.scope.event)) continue;
    const cause = row.cause_refs?.find(ref => facts.get(ref) === row.scope.event);
    if (cause) cues.push({type: row.type, level: row.current_symbol, event: row.scope.event, cause});
  }
  return cues;
}

function spokenForm(speech) {
  const line = speech.normalize('NFKC').trim();
  // Quoting, reporting, or qualifying someone's words is common in this client.
  // Never voice the contents as a fresh emotional reaction by the speaker.
  if (/[「」『』“”‘’"`]/u.test(line) ||
      /(?:って|と)(?:言[っわいうえ]|聞[いか]|書[いか])|(?:なんて|という)(?:言葉|台詞|意味)|(?:らしい|とのこと)[。!?]?$/u.test(line)) return 'quotation';
  if (/^(?:…|\.|\s)*(?:あんた|アンタ)[、,\s]*(?:バカ|ばか|馬鹿)[?!。…\s]*$/u.test(line)) return 'signature';
  if (/(?:彼女|彼|あの人|その人|あいつ)(?:は|も|が)[^、。!?]*(?:嬉し|うれし|助か|感謝|よかった)/u.test(line)) return 'reported';
  if (/(?:ありがとう(?:ございます)?|感謝してる|助かった|くれて(?:嬉しい|うれしい))(?:ね|よ|わ|な|わよ)?[。!…\s]*$/u.test(line)) return 'thanks';
  if (/(?:休みなさい|休んで|おやすみ|気をつけて|無理しないで)(?:ね|よ|な)?[。!…\s]*$/u.test(line)) return 'care';
  if (/(?:いい加減にして|やめなさい|やめて|口を出さないで|決めつけないで|指図しないで|決めるのは(?:私|あたし|俺)(?:だ|よ)?|筋合いは?ない)(?:ね|よ|ってば|わよ|から)?[。!?…\s]*$/u.test(line)) return 'boundary';
  if (/(?:確認して|見てみて|確かめて|試してみて|調べてみて)(?:ね|よ|ごらん)?[。!?…\s]*$/u.test(line)) return 'guidance';
  if (/(?:よかった|良かった|悪い気はしない|悪く(?:は)?ない|上出来|やるじゃない)(?:わ|ね|よ|わね|わよ|けど)?[。!…\s]*$/u.test(line)) return 'acknowledgement';
  if (/^[…\s]*(?:は[ぁあ]?|え[えぇ]?|ほんとに)[?!…\s]+$/u.test(line)) return 'interjection';
  return 'ordinary';
}

export function selectLocalDelivery(speech, cues) {
  const form = spokenForm(speech);
  const has = (type, strongOnly = false) => cues.some(cue =>
    cue.type === type && (!strongOnly || cue.level !== '较弱'));
  const positive = has('positive_affect'), negative = has('negative_affect');
  if (positive && negative) return {tag:'ordinary', form};
  let tag = 'ordinary';
  if (form === 'guidance') tag = 'explain';
  else if (form === 'boundary') tag = has('negative_affect', true) && !positive ? 'restrained' : 'firm';
  else if (form === 'interjection' && has('negative_affect', true) && !positive) tag = 'restrained';
  else if (form === 'signature' && positive !== negative) {
    if (has('negative_affect', true)) tag = 'signature';
    if (has('positive_affect', true)) tag = 'playful';
  } else if (form === 'thanks' && !negative) tag = 'friendly';
  else if (form === 'care' && !negative) tag = 'gentle';
  else if (form === 'acknowledgement' && has('positive_affect', true) && !negative) tag = 'friendly';
  return {tag, form};
}
