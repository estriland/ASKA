# -*- coding: utf-8 -*-
# asuka-ai/client/core/asr_manager.py
# 语音输入引擎 - 麦克风录音 + Silero VAD 断句 + 可切换 Provider
# 三语混说：混合模式不向 Provider 预先锁定单一语言。
# 用法：ASRManager 后台线程持续录音，VAD 检测语音开始/结束，
#       结束段交给所选后端转写，结果通过 on_result 回调返回。
import threading
import time
import queue

import numpy as np
from core.app_config import VAD_MODEL_DIR as CONFIG_VAD_MODEL_DIR
from core.audio_visualizer import spectrum_bands
from core.metrics import elapsed_ms, latency, timer
from core.qwen_asr_client import QwenASRClient
from core.whisper_asr_client import WhisperASRClient, WhisperLiteASRClient
from core.asr_providers import (
    ASRProviderMetadata, WorkerASRProvider,
)

# 配置
SAMPLE_RATE = 16000  # whisper 输入采样率
VAD_MODEL_DIR = str(CONFIG_VAD_MODEL_DIR)
# VAD 参数
VAD_THRESHOLD = 0.5          # 语音概率阈值
MIN_SPEECH_MS = 250          # 最短语音段
MIN_SILENCE_MS = 400         # 静音多久算一句话结束（低延迟断句）
MAX_SPEECH_S = 15            # 单句最长（防无限录音）
BLOCK_MS = 32                # 音频块大小（silero 要求 ≥31.25ms，512采样@16k）
BLOCK_SIZE = 512             # 32ms @ 16kHz（silero VAD 标准块大小）


class ASRManager:
    def __init__(self, on_result=None, on_state=None, on_level=None,
                 on_spectrum=None):
        """语音输入引擎
        on_result: 回调(text) - 每句转写完成
        on_state: 回调(state) - "listening"/"recording"/"idle"
        on_level: 回调(level) - 实时音量电平(0-1)，用于环形波形
        """
        self.on_result = on_result
        self.on_state = on_state
        self.on_level = on_level
        self.on_spectrum = on_spectrum
        self._listening = False
        self._paused = False      # 暂停（TTS 播放时避免录到音箱声）
        self._thread = None
        self._transcribe_thread = None
        self._audio_queue = queue.Queue(maxsize=64)
        self._transcribe_queue = queue.Queue(maxsize=4)
        self._run_id = 0
        self._run_handlers = {}
        self._finish_requested_run = None
        self._vad = None
        self._vad_backend = ""
        self._prepared_engine = None
        self._whisper = WhisperASRClient()
        self._whisper_lite = WhisperLiteASRClient()
        self._lock = threading.Lock()
        # 加载、推理、切换和释放共用生命周期锁，避免停止监听后仍在
        # 收尾的最后一次转写与模型卸载并发。
        self._model_lock = threading.RLock()
        self._qwen = QwenASRClient()
        # Provider 只负责本地模型生命周期与转写。麦克风、VAD、队列和
        # 运行代次仍由 Manager 统一管理，UI 不再按具体模型写推理分支。
        self._providers = {
            "whisper-lite": WorkerASRProvider(
                ASRProviderMetadata(
                    "whisper-lite", "Whisper Small · CPU INT8",
                    "本地 CPU · 0 GiB 显存 · 约 0.8–1.5 GiB 内存"),
                lambda: self._whisper_lite,
            ),
            "whisper": WorkerASRProvider(
                ASRProviderMetadata(
                    "whisper", "Whisper Large · GPU",
                    "本地 GPU · 约 4.2 GiB", requires_gpu=True),
                lambda: self._whisper,
            ),
            "qwen3-asr": WorkerASRProvider(
                ASRProviderMetadata(
                    "qwen3-asr", "Qwen3-ASR 本地（高显存）",
                    "本地 GPU · 约 4.8 GiB", requires_gpu=True),
                lambda: self._qwen,
            ),
        }
        self.default_engine = (
            "whisper-lite" if self._whisper_lite.is_available else "whisper")
        self.engine = self.default_engine
        self.language = None      # None=混合/自动，或 "zh"/"en"/"ja"

    # ===== 模型懒加载 =====
    def _ensure_models(self):
        with self._model_lock:
            if self._vad is None:
                print("[ASR] 加载 VAD 模型...")
                from silero_vad import load_silero_vad
                try:
                    # VAD 固定在 CPU 上。ONNX 避免用 PyTorch 执行每个
                    # 32ms 音频块；缺少 runtime 时仍可回退原实现。
                    self._vad = load_silero_vad(onnx=True)
                    self._vad_backend = "onnx-cpu"
                except Exception as exc:
                    print(f"[ASR] ONNX VAD 不可用，回退 PyTorch CPU: {exc}")
                    self._vad = load_silero_vad(onnx=False)
                    self._vad_backend = "torch-cpu"
                if hasattr(self._vad, "eval"):
                    self._vad.eval()
            provider = self._providers[self.engine]
            if not provider.is_available:
                raise RuntimeError(provider.availability_error())
            if (self._prepared_engine == self.engine
                    and provider.is_running):
                return
            # 任一时刻只允许一个本地 ASR worker 驻留。CPU 小模型同样
            # 遵循这一边界，避免无意义地同时占用系统内存。
            for provider_id, other in self._providers.items():
                if provider_id != self.engine:
                    other.close()
            if provider.metadata.requires_gpu:
                self._set_state("loading")
            provider.warmup()
            self._prepared_engine = self.engine
            print(
                f"[ASR] {self.engine} 就绪 "
                f"(VAD={self._vad_backend}, {provider.metadata.resource_hint})")

    def set_engine(self, engine):
        if engine not in self._providers:
            raise ValueError(f"不支持的 ASR 引擎：{engine}")
        if engine == self.engine:
            return
        if self._listening:
            raise RuntimeError("监听期间不能切换 ASR 引擎")
        with self._model_lock:
            previous = self.engine
            # 先完整释放旧 Provider，再更新选择。对于本地 worker，这一步
            # 会等待进程退出；GPU Provider 同时回收 CUDA context。
            self._providers[previous].close()
            self._prepared_engine = None
            self.engine = engine

    def _unload_whisper_locked(self):
        """结束 Whisper worker，并等待进程级 CUDA 上下文被回收。"""
        self._whisper.close()

    @property
    def qwen_available(self):
        return self._qwen.is_available

    @property
    def whisper_lite_available(self):
        return self._whisper_lite.is_available

    def provider_options(self):
        return [provider.metadata for provider in self._providers.values()]

    def provider_availability_error(self, provider_id=None):
        provider = self._providers.get(provider_id or self.engine)
        if provider is None:
            return "未知 ASR Provider"
        return "" if provider.is_available else provider.availability_error()

    def prepare(self):
        """只准备 VAD 与当前 ASR Provider，不打开麦克风输入流。"""
        self._ensure_models()

    def unload(self):
        """停止监听并释放 VAD/ASR；Manager 本身仍可再次使用。"""
        self.stop()
        with self._model_lock:
            for provider in self._providers.values():
                provider.close()
            self._prepared_engine = None
            # 挂断后不保留任何语音模型。VAD 固定在 CPU，但仍应与 ASR
            # worker 共用通话生命周期；下一次 prepare() 会重新创建。
            self._vad = None
            self._vad_backend = ""

    def close(self):
        self.unload()

    # ===== 开始/停止监听 =====
    def start(self, *, on_result=None, on_state=None, on_finished=None, call_audio=None, on_call_input=None):
        """开始持续监听（点击语音对话后）"""
        with self._lock:
            if self._listening:
                return
            self._listening = True
            self._run_id += 1
            run_id = self._run_id
            self._finish_requested_run = None
            self._run_handlers[run_id] = {
                'result': on_result or self.on_result,
                'state': on_state or self.on_state,
                'finished': on_finished,
                'call_audio': call_audio, 'call_input': on_call_input,
            }
            # 每轮监听独占队列，避免上一轮的结束标记污染重新启动。
            self._audio_queue = queue.Queue(maxsize=64)
            self._transcribe_queue = queue.Queue(maxsize=4)
            audio_queue = self._audio_queue
            transcribe_queue = self._transcribe_queue
        self._thread = threading.Thread(
            target=self._listen_loop,
            args=(run_id, audio_queue, transcribe_queue), daemon=True)
        self._thread.start()
        return run_id

    def finish_capture(self):
        """Stop acquiring PCM, then transcribe the tail and drain this run's queue."""
        with self._lock:
            if not self._listening:
                return False
            self._finish_requested_run = self._run_id
        return True

    def _finish_run(self, run_id):
        with self._lock:
            handlers = self._run_handlers.pop(run_id, {})
            if self._run_id == run_id:
                self._listening = False
        if handlers.get('finished'):
            handlers['finished']()

    def request_stop(self):
        """立即使当前运行代次失效；线程回收由 stop/unload 在后台等待。"""
        with self._lock:
            self._listening = False
            self._run_id += 1
            transcribe_queue = self._transcribe_queue
        try:
            transcribe_queue.put_nowait(None)
        except queue.Full:
            pass

    def stop(self):
        """停止监听"""
        self.request_stop()
        if self._thread:
            self._thread.join(timeout=2)
            self._thread = None
        if self._transcribe_thread:
            self._transcribe_thread.join(timeout=2)
            self._transcribe_thread = None

    def set_paused(self, paused):
        """暂停/恢复监听。TTS 播放时暂停，避免麦克风录到音箱声导致回声循环。"""
        self._paused = paused
        if paused:
            # 清空 VAD 状态，丢弃当前累积的语音缓冲
            self._discard_speech()

    @property
    def is_listening(self):
        return self._listening

    @property
    def is_paused(self):
        return self._paused

    def _discard_speech(self):
        """丢弃当前语音段缓冲（暂停时清空，防止残留触发误识别）"""
        with self._lock:
            try:
                self._speech_buffer = []
                self._current_speech = False
            except AttributeError:
                pass

    # ===== 核心监听循环 =====
    def _is_current_run(self, run_id):
        return self._listening and self._run_id == run_id

    def _listen_loop(self, run_id, audio_queue, transcribe_queue):
        try:
            self._ensure_models()
        except Exception as e:
            print(f"[ASR] 模型加载失败: {e}")
            with self._lock:
                if self._run_id == run_id:
                    self._listening = False
            self._set_state(f"error:{e}", run_id)
            self._finish_run(run_id)
            return

        if not self._is_current_run(run_id):
            self._finish_run(run_id)
            return

        try:
            import sounddevice as sd
            from silero_vad.utils_vad import VADIterator
            vad_iterator = VADIterator(
                self._vad, threshold=VAD_THRESHOLD, sampling_rate=SAMPLE_RATE,
                min_silence_duration_ms=MIN_SILENCE_MS, speech_pad_ms=30)
        except Exception as error:
            self._set_state(f'error:{error}',run_id)
            self._finish_run(run_id)
            return

        self._transcribe_thread = threading.Thread(
            target=self._transcribe_worker,
            args=(run_id, transcribe_queue), daemon=True)
        self._transcribe_thread.start()

        # 录音缓冲：每块的音频 + 是否在说话（实例属性，便于暂停时清空）
        block_size = BLOCK_SIZE  # 512采样=32ms（silero VAD 标准）
        self._speech_buffer = []  # 当前语音段的音频块
        self._current_speech = False  # 当前是否在说话
        pre_roll = []           # 滚动缓冲：保留最近 ~400ms 音频（VAD start 前回补，防吞首词）
        PRE_ROLL_MS = 400       # 回补时长
        pre_roll_max = PRE_ROLL_MS // BLOCK_MS  # 400ms / 32ms ≈ 12 块
        handlers = self._run_handlers.get(run_id, {})
        call_audio, call_input = handlers.get('call_audio'), handlers.get('call_input')
        span = None
        speech_blocks = 0
        probed = False

        def finish_sentence():
            if span is None:
                self._queue_transcription(self._speech_buffer, transcribe_queue, run_id)
            else:
                span.finish()
                self._queue_transcription(self._speech_buffer, transcribe_queue, run_id, span=span)

        def audio_callback(indata, frames, time_info, status):
            """实时回调只复制 PCM；不得在 PortAudio 线程做模型推理。"""
            if self._paused or self._finish_requested_run == run_id or not self._is_current_run(run_id):
                return
            audio = np.asarray(indata[:, 0], dtype=np.float32).copy()
            try:
                audio_queue.put_nowait(audio)
            except queue.Full:
                # 延迟优先：队列拥塞时丢最旧块，而不是阻塞音频线程。
                try:
                    audio_queue.get_nowait()
                    audio_queue.put_nowait(audio)
                except queue.Empty:
                    pass

        try:
            with sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=1,
                dtype="float32",
                callback=audio_callback,
                blocksize=block_size,
            ):
                self._set_state("listening", run_id)
                print("[ASR] 监听中...（点击停止或说一句话）")
                was_paused = False
                while self._is_current_run(run_id):
                    if self._finish_requested_run == run_id and audio_queue.empty():
                        break
                    if self._paused:
                        if not was_paused:
                            self._discard_speech()
                            pre_roll = []
                            vad_iterator.reset_states()
                            self._drain_audio_queue(audio_queue)
                        was_paused = True
                        time.sleep(0.02)
                        continue
                    if was_paused:
                        vad_iterator.reset_states()
                        was_paused = False
                    try:
                        audio = audio_queue.get(timeout=0.1)
                    except queue.Empty:
                        continue

                    if call_audio is not None:
                        audio = call_audio.filter_input(audio, SAMPLE_RATE)
                    if self.on_level:
                        rms = float(np.sqrt(np.mean(audio ** 2)))
                        self.on_level(min(1.0, rms / 0.05))
                    if self.on_spectrum and self._current_speech:
                        self.on_spectrum(spectrum_bands(audio, SAMPLE_RATE))

                    try:
                        vad_result = vad_iterator(audio)
                    except Exception:
                        continue
                    if vad_result is not None:
                        if "start" in vad_result and not self._current_speech:
                            self._current_speech = True
                            self._set_state("recording", run_id)
                            self._speech_buffer = list(pre_roll) + [audio]
                            pre_roll = []
                            speech_blocks = 1
                            probed = False
                            if call_input is not None:
                                span = call_audio.utterance()
                                call_input('onset', span, '')
                        elif "end" in vad_result and self._current_speech:
                            self._current_speech = False
                            finish_sentence()
                            self._speech_buffer = []
                    elif self._current_speech:
                        self._speech_buffer.append(audio)
                        speech_blocks += 1
                        if (span is not None and not probed and speech_blocks>=18 and transcribe_queue.empty()
                                and call_audio.interrupt_target(span) is not None):
                            probed=True
                            call_input('onset',span,'')
                            self._queue_transcription(self._speech_buffer[-32:],transcribe_queue,run_id,span=span,preview=True)
                        if speech_blocks * BLOCK_MS >= MAX_SPEECH_S * 1000:
                            self._current_speech = False
                            finish_sentence()
                            vad_iterator.reset_states()
                            self._speech_buffer = []
                    else:
                        pre_roll.append(audio)
                        if len(pre_roll) > pre_roll_max:
                            pre_roll = pre_roll[-pre_roll_max:]
        except Exception as e:
            print(f"[ASR] 录音错误: {e}")
            if self._is_current_run(run_id):
                self._set_state(f"error:{e}", run_id)
        finally:
            if self._is_current_run(run_id) and self._finish_requested_run == run_id:
                finish_sentence()
                self._speech_buffer = []
                self._current_speech = False
                while self._is_current_run(run_id):
                    try:
                        transcribe_queue.put(None, timeout=.1)
                        break
                    except queue.Full:
                        continue
            else:
                try:
                    transcribe_queue.put_nowait(None)
                except queue.Full:
                    pass
            if not self._listening or self._run_id == run_id:
                self._set_state("idle", run_id)

    def _drain_audio_queue(self, audio_queue=None):
        audio_queue = audio_queue or self._audio_queue
        while True:
            try:
                audio_queue.get_nowait()
            except queue.Empty:
                return

    def _queue_transcription(self, audio_blocks, transcribe_queue=None, run_id=None, *, span=None, preview=False):
        transcribe_queue = transcribe_queue or self._transcribe_queue
        if not audio_blocks:
            return
        audio = np.asarray(np.concatenate(audio_blocks), dtype=np.float32)
        if span is not None:
            item = (audio, timer(), span, preview)
            if preview:
                try: transcribe_queue.put_nowait(item)
                except queue.Full: pass
                return
            self._set_state("transcribing", run_id)
            while self._is_current_run(run_id):
                try:
                    transcribe_queue.put(item, timeout=.1)
                    break
                except queue.Full:
                    continue
            return
        self._set_state("transcribing", run_id)
        if run_id is not None and self._run_handlers.get(run_id, {}).get('finished'):
            # Independent dictation must not silently drop an earlier sentence.
            while self._is_current_run(run_id):
                try:
                    transcribe_queue.put((audio, timer()), timeout=.1)
                    return
                except queue.Full:
                    continue
            return
        try:
            transcribe_queue.put_nowait((audio, timer()))
        except queue.Full:
            # 最多缓存几句；拥塞时优先保留最新输入。
            try:
                transcribe_queue.get_nowait()
                transcribe_queue.put_nowait((audio, timer()))
            except queue.Empty:
                pass

    def _transcribe_worker(self, run_id, transcribe_queue):
        try:
            while self._is_current_run(run_id):
                try:
                    item = transcribe_queue.get(timeout=0.1)
                except queue.Empty:
                    continue
                if item is None:
                    return
                audio, queued_at, *call = item
                if call and call[1] and call[0].ended.is_set():
                    continue
                self._transcribe(audio, queued_at, run_id, *call)
        finally:
            self._finish_run(run_id)

    def _transcribe(self, audio, queued_at, run_id, span=None, preview=False):
        """在独立工作线程转写，不阻塞麦克风与 VAD。"""
        try:
            with self._model_lock:
                audio = np.asarray(audio, dtype=np.float32)
                engine = self.engine
                language = self.language
                provider = self._providers[engine]
                result = provider.transcribe(
                    audio, SAMPLE_RATE, language=language or "mixed")
                text = str(result.get("text") or "").strip()
                detected_language = str(
                    result.get("language") or "").strip()
            if span is not None and self._is_current_run(run_id):
                callback = self._run_handlers.get(run_id, {}).get('call_input')
                if callback:
                    callback('preview' if preview else 'final', span, text)
            elif text and self._is_current_run(run_id):
                suffix = (
                    f" [{detected_language}]" if detected_language else "")
                print(f"[ASR:{engine}] 识别完成{suffix}，{len(text)}字")
                callback = self._run_handlers.get(run_id, {}).get('result', self.on_result)
                if callback:
                    callback(text)
            latency.record(
                "asr_preview" if preview else "asr_transcribe", elapsed_ms(queued_at),
                audio_ms=round(len(audio) / SAMPLE_RATE * 1000.0, 1),
                has_text=bool(text), engine=engine,
                detected_language=detected_language)
            if not preview and self._is_current_run(run_id):
                self._set_state(
                    "recording" if self._current_speech else "listening", run_id)
        except Exception as e:
            print(f"[ASR] 转写错误: {e}")
            if preview:
                callback = self._run_handlers.get(run_id, {}).get('call_input')
                if callback and self._is_current_run(run_id):
                    callback('preview', span, '')
                return
            self._set_state(f"error:{e}", run_id)
            if self._is_current_run(run_id):
                self._set_state(
                    "recording" if self._current_speech else "listening", run_id)

    def _set_state(self, state, run_id=None):
        if run_id is not None and run_id != self._run_id:
            return
        callback = self.on_state if run_id is None else self._run_handlers.get(run_id, {}).get('state', self.on_state)
        if callback:
            try:
                callback(state)
            except Exception:
                pass
        if state in ("listening", "recording"):
            print(f"[ASR] {state}")
