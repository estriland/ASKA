"""通话拨号提示音；与 TTS 播放器完全隔离。"""
from __future__ import annotations

import math
import threading

import numpy as np


class CallTonePlayer:
    """在短生命周期 OutputStream 中播放低音量电子提示音。"""

    SAMPLE_RATE = 24000
    BLOCK_SAMPLES = 480  # 20 ms，停止拨号时无需等待完整音节

    def __init__(self, on_error=None):
        self._on_error = on_error
        self._lock = threading.Lock()
        self._stop_event = None
        self._thread = None

    @classmethod
    def _dual_tone(cls, duration, frequencies, amplitude=0.025):
        count = max(1, round(duration * cls.SAMPLE_RATE))
        time_axis = np.arange(count, dtype=np.float32) / cls.SAMPLE_RATE
        wave = np.zeros(count, dtype=np.float32)
        for frequency in frequencies:
            wave += np.sin(2 * math.pi * float(frequency) * time_axis)
        wave *= float(amplitude) / max(1, len(frequencies))
        return cls._fade(wave)

    @classmethod
    def _chirp(cls, duration, start_hz, end_hz, amplitude=0.03):
        count = max(1, round(duration * cls.SAMPLE_RATE))
        time_axis = np.arange(count, dtype=np.float32) / cls.SAMPLE_RATE
        slope = (float(end_hz) - float(start_hz)) / max(duration, 0.001)
        phase = 2 * math.pi * (
            float(start_hz) * time_axis + 0.5 * slope * time_axis ** 2)
        return cls._fade(np.sin(phase).astype(np.float32) * amplitude)

    @classmethod
    def _fade(cls, wave):
        wave = np.asarray(wave, dtype=np.float32)
        fade_samples = min(len(wave) // 2, round(cls.SAMPLE_RATE * 0.018))
        if fade_samples > 1:
            ramp = np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)
            wave[:fade_samples] *= ramp
            wave[-fade_samples:] *= ramp[::-1]
        return np.ascontiguousarray(wave)

    @classmethod
    def _write_wave(cls, stream, wave, stop_event):
        for start in range(0, len(wave), cls.BLOCK_SAMPLES):
            if stop_event.is_set():
                return False
            stream.write(wave[start:start + cls.BLOCK_SAMPLES])
        return not stop_event.is_set()

    def _report_error(self, exc):
        if self._on_error:
            try:
                self._on_error(exc)
            except Exception:
                pass

    def _replace(self, target, name):
        self.stop()
        stop_event = threading.Event()

        def runner():
            try:
                target(stop_event)
            except Exception as exc:
                self._report_error(exc)
            finally:
                with self._lock:
                    if self._thread is threading.current_thread():
                        self._thread = None
                        self._stop_event = None

        thread = threading.Thread(
            target=runner, name=f"call-tone-{name}", daemon=True)
        with self._lock:
            self._stop_event = stop_event
            self._thread = thread
        thread.start()
        return thread

    def start_ringback(self):
        """循环播放短促双频回铃；两次音节之间保持安静。"""
        tone = self._dual_tone(0.62, (425, 510), amplitude=0.026)

        def play(stop_event):
            import sounddevice as sd
            while not stop_event.is_set():
                with sd.OutputStream(
                        samplerate=self.SAMPLE_RATE, channels=1,
                        dtype="float32") as stream:
                    if not self._write_wave(stream, tone, stop_event):
                        return
                if stop_event.wait(0.88):
                    return

        return self._replace(play, "ringback")

    def play_connected(self, on_finished=None):
        tone = self._chirp(0.18, 560, 920, amplitude=0.032)

        def play(stop_event):
            try:
                import sounddevice as sd
                with sd.OutputStream(
                        samplerate=self.SAMPLE_RATE, channels=1,
                        dtype="float32") as stream:
                    self._write_wave(stream, tone, stop_event)
            finally:
                # 提示音不可用时也必须继续通话，不能让待朗读回复永久卡住。
                if not stop_event.is_set() and on_finished:
                    on_finished()

        return self._replace(play, "connected")

    def play_hangup(self):
        tone = self._chirp(0.16, 720, 360, amplitude=0.028)

        def play(stop_event):
            import sounddevice as sd
            with sd.OutputStream(
                    samplerate=self.SAMPLE_RATE, channels=1,
                    dtype="float32") as stream:
                self._write_wave(stream, tone, stop_event)

        return self._replace(play, "hangup")

    def stop(self):
        """停止本类创建的提示音，不触碰 TTS 的 OutputStream。"""
        with self._lock:
            stop_event = self._stop_event
            thread = self._thread
        if stop_event is not None:
            stop_event.set()
        if (thread is not None and thread is not threading.current_thread()
                and thread.is_alive()):
            thread.join(timeout=0.5)
        with self._lock:
            if self._thread is thread and (
                    thread is None or not thread.is_alive()):
                self._thread = None
                self._stop_event = None
