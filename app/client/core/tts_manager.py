# -*- coding: utf-8 -*-
# asuka-ai/client/core/tts_manager.py
# 明日香 TTS 管理器 - Qwen3-TTS (faster-qwen3-tts) 三语流式
# 原理：faster-qwen3-tts 真流式合成，边生成边播放。
#       语言自动检测(中日英)，xvec_only=True(稳定)，chunk_size=6(约0.5秒首块)。
# 可调参数：temperature(采样稳定度)
import re
import secrets
import threading
import gc
import json
import hashlib
from pathlib import Path
from contextlib import ExitStack, nullcontext
from dataclasses import dataclass

import numpy as np
from core.app_config import PROJECT_ROOT, TTS_MODEL_DIR, TTS_REF_AUDIO
from core.stream_player import StreamingAudioPlayer, play_buffered
from core.metrics import elapsed_ms, latency, timer
from core.tts_diagnostics import tts_diagnostics
from core.tts_segments import split_synthesis_text, plan_synthesis_segments, spoken_segments, V4_COHERENT_SHORT_LIMIT, SEGMENT_LIMITS
from core.quality_config import load_quality_config, load_voice_configuration
from core.quality_tts import QualityTTSBackend
from voice.tts.stream_contract import own_voice_stream
from core.audio_replay import AudioReplayStore, file_hash
from core.reply_delivery import replay_spans, SINGLE_VOICE
from core.voice_inference_policy import resolve_voice_inference
from core.voice_edition import multilingual_available, prepare_multilingual_codec

# ============ 配置 ============
# LoRA 合并模型（asuka-E：纯正文训练×scale0.3合并，情绪走instruct通道）
MODEL_DIR = str(TTS_MODEL_DIR)
# 多语言模型使用便携版的音色参数，或用户配置的参考音频。
REF_AUDIO_PATH = str(TTS_REF_AUDIO)

SAMPLE_RATE = 24000  # Qwen3-TTS 输出采样率

# 朗读前清洗：剥离动作括号、emoji、markdown 符号（TTS 会照读）
def clean_for_tts(text):
    if not text:
        return ""
    # 去掉动作描述/翻译括号，使用深度计数兼容翻译里的拼音嵌套括号。
    cleaned = []
    depth = 0
    for char in str(text):
        if char in "（(":
            depth += 1
        elif char in "）)":
            if depth > 0:
                depth -= 1
        elif depth == 0:
            cleaned.append(char)
    text = "".join(cleaned)
    # 去掉 emoji（含代理对）
    text = re.sub(r'[\U0001F000-\U0001FAFF☀-➿️‍]', '', text)
    # 去掉 markdown 符号 ** * ` #
    text = text.replace('**', '').replace('`', '').replace('*', '')
    text = re.sub(r'^#+\s*', '', text)
    # 折叠多余空白
    text = re.sub(r'\s+', ' ', text).strip()
    return text

# 语言检测：根据文本字符判断
def detect_language(text):
    """检测文本语言：japanese/chinese/english"""
    ja_count = len(re.findall(r'[\u3040-\u30ff\u31f0-\u31ff]', text))  # 假名
    zh_count = len(re.findall(r'[\u4e00-\u9fff]', text))  # 汉字
    if ja_count > 0:
        return "Japanese"
    elif zh_count > 0:
        return "Chinese"
    return "English"


def synthesis_language(text, declared=None):
    aliases = {'ja': 'Japanese', 'jp': 'Japanese', 'ja-jp': 'Japanese', 'japanese': 'Japanese',
               'zh': 'Chinese', 'zh-cn': 'Chinese', 'zh-tw': 'Chinese', 'chinese': 'Chinese',
               'en': 'English', 'en-us': 'English', 'en-gb': 'English', 'english': 'English'}
    return aliases.get(str(declared or '').strip().lower()) or detect_language(text)


def prepare_synthesis(text, pauses=None, language=None, voice_preset=None):
    """The original text/pause preparation, shared with display scheduling.

    Pure string work only: no model, random seed or audio device is touched.
    """
    plan = prepare_synthesis_plan(text, pauses, language, voice_preset)
    return plan['text'], plan['language'], plan['synthesis_text'], plan['segments']


def can_read_reply(text, language, preset):
    return multilingual_available() or (preset == 'natural' and synthesis_language(text, language) == 'Japanese')


def prepare_synthesis_plan(text, pauses=None, language=None, voice_preset=None):
    raw_text = str(text or '')
    text = clean_for_tts(text)
    language = synthesis_language(text, language)
    sentences = TTSManager._split_sentences(text)
    pauses = pauses or []
    pause_map = {}
    if pauses and isinstance(pauses[0], dict):
        for node in pauses:
            if isinstance(node, dict) and 'idx' in node:
                pause_map[node['idx']] = node.get('level', node.get('ms', 0))
    else:
        pause_map = dict(enumerate(pauses))
    synth_text = ''
    for i, sent in enumerate(sentences):
        if i > 0:
            level = pause_map.get(i - 1, 0)
            if level in ('strong', 'medium'): synth_text += '……'
            elif level == 'weak': synth_text += '、'
        synth_text += sent
    if voice_preset == 'natural' and language == 'Japanese' and len(text) <= V4_COHERENT_SHORT_LIMIT and not pauses:
        synth_text = text
    segments = plan_synthesis_segments(synth_text, language, voice_preset=voice_preset)
    version = 'v4-coherent-short-v1' if voice_preset == 'natural' else 'bounded-v1'
    segment_limit = (V4_COHERENT_SHORT_LIMIT
                     if voice_preset == 'natural' and language == 'Japanese'
                     and len(synth_text) <= V4_COHERENT_SHORT_LIMIT
                     else SEGMENT_LIMITS.get(language, 80))
    if (voice_preset == 'natural' and language == 'Japanese' and not pauses
            and len(synth_text) > V4_COHERENT_SHORT_LIMIT):
        # Preserve explicit message boundaries before whitespace cleaning.
        # Never infer alignment or change the already prepared spoken content.
        raw_parts = [p for p in re.split(r'\n\s*\n', raw_text) if p.strip()]
        if len(raw_parts) > 1:
            cleaned = [clean_for_tts(p) for p in raw_parts]
            parts = [''.join(TTSManager._split_sentences(p)) for p in cleaned]
            if all(parts) and ' '.join(cleaned) == text and ''.join(parts) == synth_text:
                candidate = [s for p in parts for s in
                             plan_synthesis_segments(p, language, voice_preset=voice_preset)]
                if ''.join(candidate) == synth_text:
                    segments = candidate
                    version = 'v4-message-boundary-v1'
                    segment_limit = V4_COHERENT_SHORT_LIMIT
    if not any(char.isalnum() for char in synth_text):
        segments=[]
    return {'text': text, 'language': language, 'synthesis_text': synth_text,
            'segments': segments, 'segmentation': version,
            'segment_limit': segment_limit, 'segment_lengths': [len(s) for s in segments]}


@dataclass(frozen=True)
class RenderedVoice:
    parent_playback_id: str
    language: str
    preset: str | None
    engine_identity: int
    instruction: dict
    model_details: dict
    temperature: float


@dataclass
class PreparedSpeech:
    text: str
    language: str
    segments: list
    audio: np.ndarray
    sample_rate: int
    recording: object
    generation: object


class TTSManager:
    def __init__(self, *, diagnostics_enabled=False):
        self.diagnostics_enabled = bool(diagnostics_enabled)
        self.model = None
        self._multilingual_placement = None
        self._prefer_multilingual_ram = False
        self.temperature = 0.9    # 稳定度：官方默认 0.9（研究确认 0.7 会压低情绪表现力）
        self.is_speaking = False
        self._stop_flag = threading.Event()
        self._model_lock = threading.Lock()
        self._generation_lock = threading.Lock()
        self._output_lock = threading.Lock()
        self._on_level = None
        self._on_spectrum = None
        self._player = None
        self._primed = False
        self._enabled = threading.Event()
        self._quality_backend = None
        self._quality_enabled = False
        self._quality_preset = 'natural'
        self._initiative_tickets = {}
        self._initiative_ticket_lock = threading.Lock()
        self._followup_voice = None
        self.last_quality_results = {}
        self.audio_replay = AudioReplayStore()
        self.last_playback_metrics = {}
        self.last_saved_audio = None
        self.last_audio_save_error = ''

    def configure_quality(self, enabled, preset='natural'):
        """Preference for future requests; never mutates an active generation."""
        self._quality_enabled = bool(enabled)
        self._quality_preset = preset

    def _ensure_quality_backend(self, preset, settings=None):
        if not self.enabled:
            raise RuntimeError('语音朗读未开启')
        if self._quality_backend is None:
            from voice.tts.engine import validate_config
            config, presets = load_voice_configuration(settings)
            validate_config(config)
            with self._model_lock:
                self.model = None
                self._multilingual_placement = None
                self._prefer_multilingual_ram = False
                self._primed = False
                gc.collect()
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                self._quality_backend = QualityTTSBackend(config, presets)
        self._quality_backend.prime(preset)
        if not self.enabled:
            self._quality_backend.close()
            self._quality_backend = None
            raise RuntimeError('语音朗读已关闭，取消预热')
        return self._quality_backend

    @staticmethod
    def spoken_line_instruction(expression,text,language,preset,playback_id):
        if (expression.get('schema')!='feiniao.spoken-line/1' or not playback_id
                or expression.get('playback_id')!=playback_id or expression.get('text')!=text
                or language!='Japanese' or expression.get('language')!='ja' or expression.get('preset')!=preset):
            raise ValueError('朗读条件与这条已选消息不一致')
        if preset=='soft_close' and expression.get('tag') is None:
            return None
        if preset!='natural':
            raise ValueError('本句声线选择无效')
        catalog=json.loads((Path(PROJECT_ROOT)/'brain/voice/local-ja-deliveries.json').read_text('utf-8'))
        entry=catalog.get(expression.get('tag'))
        if not entry:raise ValueError('这条消息的语气标签无效')
        return entry['delivery']

    def _quality_delivery(self, text, language, preset, context, settings=None):
        identity = (context or {}).get('quality_identity') or {}
        session, turn = identity.get('session'), identity.get('turn')
        if not isinstance(session, str) or not re.fullmatch(r'[a-f0-9-]{36}', session):
            raise ValueError('朗读缺少对话绑定')
        if not isinstance(turn, str) or not re.fullmatch(r'turn-\d{6}', turn):
            raise ValueError('朗读缺少消息绑定')
        settings = settings if settings is not None else load_quality_config()
        if settings is None:
            raise ValueError('高质量版资源未配置')
        folder = Path(settings['general_state']) / 'sessions' / session / 'turns' / turn
        localized = json.loads((folder / 'desktop-output/localized.json').read_text('utf-8'))
        options = json.loads((folder / 'desktop-options.json').read_text('utf-8'))
        if (localized.get('speech') != text or localized.get('language') != 'ja'
                or language != 'Japanese' or options.get('voice_preset') != preset
                or options.get('voice_enabled') is not True):
            raise ValueError('朗读内容或声线与本轮请求不一致')
        return identity

    def bind_initiative_voice(self, item, relationship_id, preset):
        """Bind one verified native /deliver response to its selected Japanese voice."""
        behavior = item['behavior']
        playback = item.get('playback_id', '')
        if (not isinstance(relationship_id, str) or not relationship_id or
                not re.fullmatch(r'[a-f0-9-]{36}', str(item.get('id', ''))) or
                item.get('request_id') != 'initiative:' + item['id'] or
                not playback.startswith(relationship_id + ':') or
                len(playback) <= len(relationship_id) + 1 or behavior.get('playback_id') != playback or
                behavior.get('language') != 'ja' or not isinstance(behavior.get('speech'), str) or
                not behavior['speech'].strip() or preset not in {'natural', 'soft_close'}):
            raise ValueError('主动来信的朗读收据与已发布消息不一致')
        instruction = None
        if preset == 'natural':
            with (Path(PROJECT_ROOT) / 'brain/voice/local-ja-deliveries.json').open(encoding='utf-8') as source:
                entries = json.load(source)
            tag = item.get('voice_tag')
            if tag not in entries:
                raise ValueError('主动来信缺少本地声音条件')
            instruction = entries[tag]['delivery']
        key = secrets.token_hex(24)
        with self._initiative_ticket_lock:
            if len(self._initiative_tickets) >= 8:
                self._initiative_tickets.pop(next(iter(self._initiative_tickets)))
            self._initiative_tickets[key] = ((playback, behavior['speech'], 'Japanese', preset), instruction)
        return key

    def _take_initiative_voice(self, key, playback_id, text, language, preset):
        with self._initiative_ticket_lock:
            ticket = self._initiative_tickets.pop(key, None)
        if ticket is None or ticket[0] != (playback_id, text, language, preset):
            raise ValueError('主动来信的朗读凭据已失效或与本句不符')
        return ticket[1]

    def _runtime_instruction(self, text, language, expression, identity, settings=None):
        from voice.tts.expression_contract import validate_contract
        contract = validate_contract(expression)
        if (contract['text'] != text or contract['identity']['language'] != language
                or contract['identity']['speaker'] != 'asuka'
                or contract['review']['status'] != 'pending'
                or contract['source']['adapter_version'] != 'asuka.desktop-localized-voice/1'):
            raise ValueError('本次声音条件与正文、语种或运行来源不一致')
        if (contract['identity']['conversation_id'] != identity['session']
                or contract['identity']['turn_id'] != identity['turn']):
            raise ValueError('声音条件属于另一条消息')
        settings = settings if settings is not None else load_quality_config()
        source = Path(contract['source']['artifact']['path']).resolve()
        if settings is None or not source.is_relative_to(Path(settings['general_state']).resolve()):
            raise ValueError('声音条件不是当前客户端生成的记录')
        raw = source.read_bytes()
        if hashlib.sha256(raw).hexdigest() != contract['source']['artifact']['sha256']:
            raise ValueError('声音条件来源已改变')
        localized = json.loads(raw)
        if localized.get('speech') != text or localized.get('language') != 'ja':
            raise ValueError('日语朗读与原回复绑定不一致')
        return contract['condition']['instruct']

    @property
    def enabled(self):
        return self._enabled.is_set()

    def set_enabled(self, enabled):
        if enabled:
            self._enabled.set()
        else:
            self._enabled.clear()
            self.stop()

    def _ensure_model(self):
        """懒加载模型（首次调用时）"""
        if not self.enabled:
            raise RuntimeError("语音朗读未开启")
        if not multilingual_available():
            raise RuntimeError("中文和英文发音需要中日双语版。")
        if self.model is not None:
            return
        with self._model_lock:
            if self.model is not None:
                return
            if self._quality_backend is not None:
                self._quality_backend.close()
                self._quality_backend = None
                self._primed = False
            prepare_multilingual_codec()
            import torch
            from voice.tts.memory_placement import load_multilingual
            print("[TTS] 加载 Qwen3-TTS 模型...")
            model, placement = load_multilingual(
                MODEL_DIR, precomputed_reference=Path(REF_AUDIO_PATH).suffix.lower() == ".safetensors",
                prefer_ram=self._prefer_multilingual_ram)
            if not self.enabled:
                del model
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                raise RuntimeError("语音朗读已关闭，取消加载 TTS")
            self.model = model
            self._multilingual_placement = placement
            print("[TTS] 模型加载完成")

    @property
    def is_loaded(self):
        with self._model_lock:
            return self.model is not None or (self._quality_backend is not None and self._quality_backend.is_loaded)

    def unload(self):
        """停止当前朗读，并释放 TTS 权重与未使用的 PyTorch 显存。"""
        self.stop()
        # 与生成使用相同的锁顺序；等待正在收尾的生成退出后再析构。
        with self._output_lock, self._generation_lock:
            with self._model_lock:
                model = self.model
                self.model = None
                self._multilingual_placement = None
                self._prefer_multilingual_ram = False
                self._primed = False
                quality = self._quality_backend
                self._quality_backend = None
            if quality is not None:
                quality.close()
            if model is None:
                return
            del model
            gc.collect()
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except (ImportError, RuntimeError):
                pass

    def prime(self):
        """首次实际朗读前完成 CUDA graph 与参考音频缓存预热。"""
        with self._generation_lock:
            if self._quality_enabled:
                self._ensure_quality_backend(self._quality_preset)
                return
            if self._primed:
                return
            for first in (True, False):
                try:
                    # Discard the prompt/decoder warmup; it never reaches the player.
                    for _audio, _sr, _info in self._synth_stream(
                            "あ。", "Japanese", "落ち着いて短く。", max_new_tokens=24, chunk_size=6):
                        pass
                    self._primed = True
                    return
                except RuntimeError as error:
                    from voice.tts.memory_placement import is_cuda_oom
                    if not is_cuda_oom(error):
                        raise
                    retry = self._multilingual_memory_pressure()
                    if not first or not retry:
                        raise
                import torch
                gc.collect()
                torch.cuda.empty_cache()

    def _multilingual_memory_pressure(self):
        with self._model_lock:
            retry = self._multilingual_placement == "cuda"
            self._prefer_multilingual_ram = True
            self._multilingual_placement = None
            self.model = None
            self._primed = False
            return retry

    def _detect_emotion(self, text):
        """从文本推断情绪（日文 instruct 最有效，v3 实测确认）

        优先按显式情绪标记（{情绪}/{强度}），否则按标点/关键词推断。
        语序：先查明确情绪词，再按文本特征兜底。
        """
        # 1) 显式情绪标记：LLM 按人设输出 {生气} {傲娇} 等 → 直接映射
        emo_map = {
            "生气": "怒りを爆発させる。歯を食いしばり、声を張り上げて怒鳴る。悔しさではなく怒りだけを。",
            "愤怒": "怒りを爆発させる。歯を食いしばり、声を張り上げて怒鳴る。悔しさではなく怒りだけを。",
            "平静": "落ち着いて平然と。感情を込めすぎず淡々と。",
            "激动": "声を張り上げて、言葉に熱意を込めて、勢いよくはっきりと話す。",
            "开心": "明るく弾んだ声で、語尾を軽やかに。",
            "难过": "声が沈んで小さくなる。語尾が消えそうに弱々しく。悔しさと寂しさをこらえて、泣き声にならないように。",
            "失落": "声が沈んで小さくなる。語尾が消えそうに弱々しく。悔しさと寂しさをこらえて、泣き声にならないように。",
            "着急": "早口で焦り気味に、息を弾ませて。",
            "撒娇": "甘えた声で、語尾を伸ばして、駄々をこねるように。",
            "调侃": "からかうような軽い調子で、笑いを含ませて。",
            "傲娇": "照れ隠しに怒ったふり。少し緊張して、最後は本心がちょっと漏れる。",
        }
        m = re.search(r'[【〔\[]?\s*(生气|愤怒|平静|激动|开心|难过|失落|着急|撒娇|调侃|傲娇)\s*[】〕\]]?', text)
        if m:
            emo = m.group(1)
            # 强度修饰（强→非常X，弱→有点X）
            strong = bool(re.search(r'强|很|非常|超', text[:20])) or '非常' in text[:30]
            weak = bool(re.search(r'有点|稍微|一点|略', text[:20]))
            if emo == "平静":
                return emo_map["平静"]
            if strong:
                return emo_map.get(emo, "") + "もっと強く、感情を高めて。"
            if weak:
                return "少し控えめに。まだ" + emo_map.get(emo, "")
            return emo_map.get(emo, "")

        # 2) 兜底：按文本特征推断
        if text.count('！') + text.count('!') >= 2 or 'バカ' in text or '笨蛋' in text or 'idiot' in text.lower():
            return "怒りを爆発させる。歯を食いしばり、声を張り上げて怒鳴る。悔しさではなく怒りだけを。"
        if text.count('！') + text.count('!') == 1:
            return "強めに、はっきりと。"
        if '？' in text or '?' in text:
            return "疑問の口調で、語尾をやや上昇させて。"
        if '…' in text or '……' in text:
            return "声が沈んで小さくなる。語尾が消えそうに弱々しく。悔しさと寂しさをこらえて。"
        return "落ち着いて平然と。感情を込めすぎず淡々と。"

    def _synth_stream(self, text, language, instruct,
                      max_new_tokens=2048, chunk_size=6):
        """流式合成，返回 (chunk, sr) 迭代器"""
        self._ensure_model()
        lang_map = {
            "Japanese": "Japanese",
            "Chinese": "Chinese",
            "English": "English",
        }
        if Path(REF_AUDIO_PATH).suffix.lower() == ".safetensors":
            from safetensors.torch import load_file
            tensor = load_file(REF_AUDIO_PATH)["ref_spk_embedding"]
            reference = {"voice_clone_prompt": {"ref_spk_embedding": [tensor]}}
        else:
            reference = {"ref_audio": REF_AUDIO_PATH}
        gen = self.model.generate_voice_clone_streaming(
            text=text,
            language=lang_map[language],
            **reference,
            instruct=instruct,
            xvec_only=True,        # 稳定关键
            chunk_size=chunk_size,
            max_new_tokens=max_new_tokens,
            temperature=self.temperature,
        )
        return gen

    def speak(self, text):
        return self.speak_structured(text)

    def stop(self):
        self.request_stop()
        if self._player is not None:
            self._player.close()
        self.is_speaking = False

    def request_stop(self):
        """Signal cancellation without waiting for a device or generation lock."""
        self._stop_flag.set()

    # ===== 结构化朗读（小句停顿） =====
    @staticmethod
    def _split_sentences(text):
        """按标点把小句拆成列表，保留标点。省略号不单独拆（避免孤立'…'）"""
        import re
        # 先合并省略号到前面（不把……拆成单独小句）
        # 按 。！？!?\n 切分（省略号……保留在前面的句子）
        parts = re.split(r'(?<=[。！？!?])\s*|\n', text)
        return [p.strip() for p in parts if p.strip()]

    def _synth_segments(self, segments, language, instruct, stop_event, records, recording=None):
        with own_voice_stream():
            yield from self._owned_synth_segments(segments,language,instruct,stop_event,records,recording)

    def _owned_synth_segments(self, segments, language, instruct, stop_event, records, recording=None):
        """Independent generation requests, all feeding the same audio player."""
        for index, text in enumerate(segments):
            if stop_event.is_set() or not self.enabled:
                return
            record = {'index': index, 'text': text, 'status': 'generating', 'samples': 0}
            records.append(record)
            generator = None
            try:
                if recording: self._ensure_model()
                watch = recording.observe(self.model.speech_tokenizer,
                    Path(MODEL_DIR) / 'speech_tokenizer') if recording else nullcontext()
                with watch:
                    generator = self._synth_stream(text, language, instruct)
                    for audio, sr, info in generator:
                        if stop_event.is_set() or not self.enabled:
                            record['status'] = 'cancelled'
                            return
                        if recording: recording.chunk(audio, sr)
                        record['samples'] += int(np.asarray(audio).size)
                        yield index, audio, sr, info
                if not record['samples']:
                    raise RuntimeError('TTS分段未生成音频，已停止后续合成')
                record['status'] = 'complete'
                record['memory_placement'] = self._multilingual_placement
            except GeneratorExit:
                record['status'] = 'cancelled'
                raise
            except Exception as error:
                record['status'] = 'failed'
                if isinstance(error, RuntimeError):
                    from voice.tts.memory_placement import is_cuda_oom
                    if is_cuda_oom(error):
                        self._multilingual_memory_pressure()
                raise
            finally:
                if generator is not None and hasattr(generator, 'close'):
                    generator.close()

    def speak_structured(self, text, pauses=None, diagnostic_context=None, language=None,
                         voice_preset=None, voice_expression=None, playback_id=None,
                         on_segments=None, on_segment=None, cancel_event=None, on_render=None, on_drained=None,
                         on_generated=None):
        """有界分段合成，沿用一个流式播放器，支持句间停顿。
        pauses: 每句后的停顿毫秒数列表
        """
        if not self.enabled or (cancel_event is not None and cancel_event.is_set()):
            return None
        self.last_saved_audio = None
        self.last_audio_save_error = ''
        try:
            import sounddevice as sd
            HAS_AUDIO = True
        except ImportError:
            HAS_AUDIO = False
        if not HAS_AUDIO:
            raise RuntimeError('音频输出组件不可用')

        declared_language = synthesis_language(text, language)
        quality_settings = load_quality_config() if voice_preset is not None else None
        if voice_preset is not None:
            if declared_language != 'Japanese':
                raise ValueError('当前高质量声线仅接入日语朗读')
            ticket = (diagnostic_context or {}).get('initiative_ticket')
            if ticket:
                base_instruct = self._take_initiative_voice(ticket, playback_id, text, declared_language, voice_preset)
                diagnostic_context = {key:value for key,value in diagnostic_context.items() if key != 'initiative_ticket'}
            elif isinstance(voice_expression,dict) and voice_expression.get('schema')=='feiniao.spoken-line/1':
                base_instruct=self.spoken_line_instruction(voice_expression,text,declared_language,voice_preset,playback_id)
            else:
                identity = self._quality_delivery(text, declared_language, voice_preset, diagnostic_context,
                                                  settings=quality_settings)
                base_instruct = (self._runtime_instruction(text, declared_language, voice_expression, identity,
                                                           settings=quality_settings)
                                 if voice_preset == 'natural' else None)
        plan = prepare_synthesis_plan(text, pauses, language, voice_preset)
        text, language = plan['text'], plan['language']
        synth_text, segments = plan['synthesis_text'], plan['segments']
        if not text:
            return
        if not segments:
            return
        single_voice=(diagnostic_context or {}).get('voice_turn')==SINGLE_VOICE
        if single_voice and not any(char.isalnum() for char in synth_text):
            return
        if single_voice and len(segments)!=1:
            raise ValueError('本轮台词超出一次连续朗读的范围。')
        spoken=spoken_segments(segments,language,voice_preset)

        pauses = pauses or []
        if voice_preset is None:
            base_instruct = self._detect_emotion(text)
        # Keep the validated personality expression intact. A host-only optional
        # inference rule is resolved once, before recording or publishing audio.
        instruction = resolve_voice_inference(base_instruct, quality_settings, voice_preset, language)
        base_instruct = instruction['instruct']

        tts_started = timer()
        first_audio_at = None
        diagnostic_chunks = []
        diagnostic_chunk_info = []
        diagnostic_sr = SAMPLE_RATE
        diagnostic_seed = None
        stop_event = None
        diagnostic_trace = None
        segment_records = []
        model_details = {
            'model_dir': MODEL_DIR, 'xvec_only': True,
            'temperature': self.temperature, 'chunk_size': 6,
        }
        reference_kind = 'reference_embedding' if Path(REF_AUDIO_PATH).suffix.lower() == '.safetensors' else 'reference_audio'
        model_details[reference_kind] = REF_AUDIO_PATH
        if on_generated and voice_preset is None and Path(REF_AUDIO_PATH).is_file():
            try: model_details['reference_sha256'] = file_hash(REF_AUDIO_PATH)
            except OSError: on_generated = None
        self.last_quality_results = {}
        self.last_playback_metrics = {}
        output_drained = False
        def drained():
            nonlocal output_drained
            output_drained = True
            on_drained()
        drain_observer = {'on_drained': drained} if on_drained is not None else {}
        try:
            with self._output_lock, ExitStack() as producer:
                producer.enter_context(self._generation_lock)
                if not self.enabled or (cancel_event is not None and cancel_event.is_set()):
                    return None
                # 停止事件和播放器均属于本次任务。新任务不能清掉旧任务的
                # stop，也不能被旧任务 finally 误关闭。
                stop_event = cancel_event if cancel_event is not None else threading.Event()
                self._stop_flag = stop_event
                self.is_speaking = True
                player = None
                gen = None
                try:
                    if on_segments: on_segments(segments)
                    # 显式记录每轮随机种子，便于对异常样本做近似复现。
                    diagnostic_seed = secrets.randbits(31)
                    if voice_preset is not None:
                        backend = self._ensure_quality_backend(voice_preset, settings=quality_settings)
                        snapshot = backend.snapshot()
                        config, presets = snapshot['config'], snapshot['presets']
                        profile_id = presets['presets'][voice_preset]['profile_id']
                        model_details = {'models': config['models'], 'voice_preset': voice_preset,
                            'profile': config['catalog']['profiles'][profile_id],
                            'generation': config['generation'], 'subtalker': config['subtalker'],
                            'runtime': config['runtime'], 'protected_sources': config['protected_sources'],
                            'config_sha256': hashlib.sha256(json.dumps(config, ensure_ascii=False,
                                sort_keys=True, separators=(',', ':')).encode('utf8')).hexdigest()}
                    recording = self.audio_replay.begin(playback_id, {
                        'text':text, 'synthesis_text':synth_text, 'language':language,
                        'pauses':pauses, 'segments':segments, 'seed':diagnostic_seed,
                        **({'voice_turn':SINGLE_VOICE} if single_voice else {}),
                        **({'spoken_segments':spoken} if spoken!=segments else {}),
                        'segmentation':plan['segmentation'], 'segment_lengths':plan['segment_lengths'],
                        **instruction, 'voice_preset':voice_preset, 'voice_model':model_details,
                        'voice_expression':voice_expression, 'legacy_model':MODEL_DIR if not voice_preset else None,
                        'temperature':self.temperature if not voice_preset else None})
                    try:
                        import torch
                        torch.manual_seed(diagnostic_seed)
                    except Exception:
                        pass
                    if voice_preset is not None:
                        gen = backend.stream_segments(spoken, preset_id=voice_preset,
                            language=language, instruct=base_instruct,
                            stop_event=stop_event, seed=diagnostic_seed, recording=recording)
                    else:
                        gen = self._synth_segments(segments, language, base_instruct,
                            stop_event, segment_records, recording=recording)
                    fallback_parts = []
                    fallback_sr = SAMPLE_RATE
                    stream_failed = False
                    for segment_index, audio_chunk, chunk_sr, info in gen:
                        if stop_event.is_set():
                            break
                        chunk = np.asarray(
                            audio_chunk, dtype=np.float32).reshape(-1)
                        if not chunk.size:
                            continue
                        if self.diagnostics_enabled:
                            diagnostic_chunks.append(chunk.copy())
                            diagnostic_sr = chunk_sr
                            diagnostic_chunk_info.append({
                                "index": len(diagnostic_chunks) - 1,
                                "samples": int(chunk.size),
                                "received_ms": round(elapsed_ms(tts_started), 3),
                                "engine_info": info,
                                "segment_index": segment_index,
                            })
                        if first_audio_at is None:
                            first_audio_at = timer()
                            latency.record(
                                "tts_first_audio", elapsed_ms(tts_started),
                                characters=len(synth_text), engine="qwen")
                        fallback_sr = chunk_sr
                        if player is None and not stream_failed:
                            candidate = StreamingAudioPlayer(
                                on_level=self._on_level,
                                on_spectrum=self._on_spectrum,
                                stop_event=stop_event,
                                on_segment=on_segment,
                                **({'on_render':on_render} if on_render else {}),
                                **drain_observer,
                            )
                            try:
                                candidate.start(chunk_sr, chunk, segment_index)
                                player = candidate
                                self._player = candidate
                            except Exception as exc:
                                print(
                                    "[TTS] 流式播放器不可用，"
                                    f"回退整段播放: {exc}")
                                candidate.close()
                                stream_failed = True
                                if on_segments: on_segments([])
                                fallback_parts.append(chunk)
                        elif stream_failed:
                            fallback_parts.append(chunk)
                        else:
                            player.enqueue(chunk, segment_index)

                    if voice_preset is not None:
                        self.last_quality_results = dict(backend.results)

                    if gen is not None:
                        gen.close()
                        gen = None
                    engine = self._quality_backend if voice_preset is not None else self.model
                    voice = None
                    if on_generated and first_audio_at is not None and not stop_event.is_set() and engine is not None:
                        voice = RenderedVoice(playback_id, language, voice_preset, id(engine), dict(instruction),
                                              dict(model_details), self.temperature)
                        with self._initiative_ticket_lock:
                            self._followup_voice = voice
                    if on_generated is not None: producer.close()
                    if voice is not None:
                        try: on_generated(voice)
                        except Exception as error:
                            self.release_followup_voice(voice)
                            latency.record('followup_voice_handoff',0,success=False,error=type(error).__name__)
                    if player is not None:
                        player.finish()
                        measured = getattr(player, 'metrics', None)
                        if callable(measured):
                            self.last_playback_metrics = measured()
                    elif fallback_parts and not stop_event.is_set():
                        audio = np.ascontiguousarray(
                            np.concatenate(fallback_parts), dtype=np.float32)
                        play_buffered(audio, fallback_sr, stop_event, sd, on_render=on_render,
                                      on_start=(lambda: on_segment(0)) if on_render and on_segment else None,
                                      **drain_observer)
                    if recording and (output_drained or not stop_event.is_set()):
                        try:
                            self.last_saved_audio = recording.finish(self.last_quality_results or segment_records)
                            self.last_audio_save_error = recording.error
                        except Exception as error:
                            self.last_audio_save_error = str(error)
                finally:
                    if gen is not None:
                        gen.close()
                    if player is not None:
                        player.close()
                        measured = getattr(player, 'metrics', None)
                        if callable(measured):
                            self.last_playback_metrics = measured()
                    if self._player is player:
                        self._player = None
                    self.is_speaking = False
        except Exception as e:
            if cancel_event is not None and cancel_event.is_set():return None
            print(f"[TTS] 播放错误: {e}")
            raise
        finally:
            latency.record(
                "tts_complete", elapsed_ms(tts_started),
                characters=len(synth_text), engine="qwen",
                produced_audio=first_audio_at is not None,
                voice_preset=voice_preset,
                segments=self.last_quality_results if voice_preset else None,
                playback=self.last_playback_metrics,
                stopped=bool(stop_event is not None and stop_event.is_set()))
            if diagnostic_chunks:
                if voice_preset:
                    model_details = {**model_details, 'actual_segments': self.last_quality_results}
                diagnostic_trace = tts_diagnostics.capture(
                    diagnostic_chunks,
                    diagnostic_sr,
                    {
                        "engine": "qwen3-tts",
                        **model_details,
                        "text": synth_text,
                        "language": language,
                        **instruction,
                        "seed": diagnostic_seed,
                        'segmentation':plan['segmentation'],
                        'segment_limit':plan['segment_limit'], 'segment_lengths':plan['segment_lengths'],
                        "synthesis_segments": segment_records,
                        "chunks": diagnostic_chunk_info,
                        "conversation_context": diagnostic_context or {},
                        "stopped": bool(
                            stop_event is not None and stop_event.is_set()),
                        "tts_total_ms": round(elapsed_ms(tts_started), 3),
                    },
                )
        return diagnostic_trace

    def release_followup_voice(self, voice):
        with self._initiative_ticket_lock:
            if voice is not None and self._followup_voice is voice:
                self._followup_voice = None
                return True
        return False

    def prepare_followup(self, voice, text, language, child_id, stop):
        """Generate one private sentence on the exact engine that rendered its parent."""
        if synthesis_language(text, language) != voice.language or stop.is_set() or not self.enabled:
            return None
        plan = prepare_synthesis_plan(text, [], language, voice.preset)
        segments = plan['segments']
        if len(segments)!=1 or not any(ch.isalnum() for ch in segments[0]):
            return None
        with self._generation_lock:
            engine = self._quality_backend if voice.preset is not None else self.model
            if (not self.release_followup_voice(voice) or stop.is_set() or not self.enabled or engine is None or id(engine)!=voice.engine_identity
                    or self.temperature != voice.temperature):
                return None
            reference_hash = voice.model_details.get('reference_sha256')
            if reference_hash and file_hash(REF_AUDIO_PATH)!=reference_hash: return None
            seed = secrets.randbits(31)
            spoken = spoken_segments(segments,voice.language,voice.preset)
            metadata = {'text':plan['text'], 'synthesis_text':plan['synthesis_text'], 'language':voice.language,
                        'pauses':[], 'segments':segments,'seed':seed,'segmentation':plan['segmentation'],
                        'segment_lengths':plan['segment_lengths'],'voice_turn':SINGLE_VOICE,
                        'voice_preset':voice.preset,'voice_model':voice.model_details,**voice.instruction,
                        'parent_playback_id':voice.parent_playback_id,'request_id':child_id,
                        'condition_source':'inherit-parent','temperature':voice.temperature if not voice.preset else None}
            if spoken!=segments: metadata['spoken_segments']=spoken
            recording = self.audio_replay.stage(metadata)
            records = []
            import torch
            torch.manual_seed(seed)
            instruct = voice.instruction['instruct']
            source = (engine.stream_segments(spoken,preset_id=voice.preset,language=voice.language,instruct=instruct,
                                             stop_event=stop,seed=seed,recording=recording) if voice.preset is not None
                      else self._synth_segments(segments,voice.language,instruct,stop,records,recording=recording))
            chunks, rate = [], None
            try:
                for _, pcm, sr, _ in source:
                    if stop.is_set(): return None
                    if rate is not None and rate != sr: raise ValueError('续句采样率改变')
                    rate = sr
                    chunk = np.asarray(pcm,dtype=np.float32).reshape(-1)
                    if not np.isfinite(chunk).all(): raise ValueError('续句包含无效的音频采样')
                    if len(chunk): chunks.append(chunk.copy())
            finally:
                source.close()
            if stop.is_set() or not chunks or not self.enabled: return None
            result = dict(engine.results) if voice.preset is not None else records
            audio = np.concatenate(chunks)
            if recording is not None and sum(part.size for part in recording.parts)!=audio.size:
                recording = None
            return PreparedSpeech(text,language,segments,audio,int(rate),recording,result) if np.any(audio) else None

    def play_prepared(self, prepared, playback_id, stop, *, on_segments, on_segment, on_render, on_drained, start_allowed):
        import sounddevice as sd
        with self._output_lock:
            if stop.is_set() or not self.enabled: return None
            self._stop_flag = stop
            self.is_speaking = True
            delivered = False
            def drained():
                nonlocal delivered
                delivered = True
                on_drained()
            player = StreamingAudioPlayer(on_level=self._on_level,on_spectrum=self._on_spectrum,
                stop_event=stop,on_segment=on_segment,on_render=on_render,on_drained=drained,start_allowed=start_allowed)
            try:
                on_segments(prepared.segments)
                self._player = player
                try:
                    player.start(prepared.sample_rate,prepared.audio,0)
                except Exception:
                    player.close()
                    if player.metrics()['pcm_samples_submitted']: raise
                    play_buffered(prepared.audio,prepared.sample_rate,stop,sd,on_render=on_render,
                                  on_start=lambda:on_segment(0),on_drained=drained,start_allowed=start_allowed)
                else:
                    player.finish()
                if delivered and prepared.recording is not None:
                    return prepared.recording.finish(prepared.generation,playback_id=playback_id)
            finally:
                player.close()
                if self._player is player: self._player = None
                self.is_speaking = False

    def play_saved(self, playback_id, on_segments=None, on_segment=None, cancel_event=None,on_render=None, on_drained=None):
        """Replay without dialing, opening the mic or loading the text/talker model."""
        if not self.audio_replay.enabled: raise ValueError('消息音频回放已关闭')
        with self._output_lock, self._generation_lock:
            stop = cancel_event if cancel_event is not None else threading.Event()
            if stop.is_set(): return
            self._stop_flag = stop
            self.is_speaking = True
            player = None
            try:
                result = self.audio_replay.cached(playback_id)
                if result is None:
                    resident = self._quality_backend.resident_decoder() if self._quality_backend else None
                    if resident is None and self.model is not None:
                        resident = self.model.speech_tokenizer, Path(MODEL_DIR) / 'speech_tokenizer'
                    result = self.audio_replay.reconstruct(playback_id, stop, resident=resident)
                if result is None or stop.is_set() or not self.audio_replay.enabled: return
                wave, rate = result
                record = self.audio_replay.record(playback_id)
                spans = replay_spans(record, len(wave))
                if on_segments: on_segments(record['generation']['segments'] if spans else [])
                player = StreamingAudioPlayer(on_level=self._on_level,
                    on_spectrum=self._on_spectrum, stop_event=stop, on_segment=on_segment,
                    **({'on_render':on_render} if on_render else {}),
                    **({'on_drained':on_drained} if on_drained else {}))
                self._player = player
                size = max(1, rate // 5)
                started = False
                for begin, end, index in spans or [(0, len(wave), 0)]:
                    for start in range(begin, end, size):
                        if stop.is_set() or not self.audio_replay.enabled: break
                        chunk = wave[start:min(end, start + size)]
                        if not started:
                            player.start(rate, chunk, index)
                            started = True
                        else:
                            player.enqueue(chunk, index)
                player.finish()
            finally:
                if player: player.close()
                if self._player is player: self._player = None
                self.is_speaking = False
