import {selectLocalDelivery} from './local-delivery.mjs';
import {SINGLE_VOICE} from '../voice-turn.mjs';

// Old clients can still send their stored preset. New Japanese lines share the natural voice.
export function spokenLine(behavior, request, sessionId) {
  if (request.voice_turn !== SINGLE_VOICE || !behavior?.speech || behavior.silence || behavior.voice_error)
    return behavior;
  if (behavior.language !== 'ja' || !['natural', 'soft_close'].includes(request.voice_preset))
    return {...behavior, voice_backend:'multilingual'};
  if (!behavior.playback_id?.startsWith(sessionId + ':')) throw Error('朗读消息缺少回放身份');
  const {tag,form}=selectLocalDelivery(behavior.speech, []);
  const delivery = form === 'signature' ? (behavior.emotion === 'happy' ? 'playful' : 'signature') : tag;
  return {...behavior, voice_preset:'natural', voice_expression:{
    schema:'feiniao.spoken-line/1', playback_id:behavior.playback_id,
    text:behavior.speech, language:'ja', preset:'natural', tag:delivery
  }};
}
