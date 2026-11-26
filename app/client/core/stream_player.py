"""低延迟 PCM 流播放器：生成线程投递，PortAudio 回调连续消费。"""
from __future__ import annotations

import queue
import threading
import time

import numpy as np

from core.audio_visualizer import spectrum_bands


def play_buffered(audio, sample_rate, stop_event, device, *, on_render=None, on_start=None, on_drained=None,
                  start_allowed=None):
    """Play fallback PCM on a stream owned by this reply, including cancellation."""
    if not len(audio) or stop_event.is_set():
        return
    finished = threading.Event()
    offset = 0

    def fill(output, frames, _time_info, _status):
        nonlocal offset
        output.fill(0)
        if stop_event.is_set():
            raise device.CallbackAbort
        if not offset and start_allowed and not start_allowed(): return
        count = min(frames, len(audio) - offset)
        output[:count, 0] = audio[offset:offset + count]
        if on_render and count:
            on_render(output[:count, 0], sample_rate)
        if on_start and not offset and count:
            on_start()
        offset += count
        if offset == len(audio):
            raise device.CallbackStop

    def device_finished():
        if on_drained and offset == len(audio) and not stop_event.is_set():
            on_drained()
        finished.set()

    stream = device.OutputStream(samplerate=sample_rate, channels=1, dtype='float32',
                                 callback=fill, finished_callback=device_finished)
    try:
        stream.start()
        deadline = time.monotonic() + len(audio) / sample_rate + 8
        while not finished.wait(.05):
            if stop_event.is_set():
                stream.abort()
                return
            if time.monotonic() >= deadline:
                stream.abort()
                raise TimeoutError('音频输出设备没有确认播放结束')
        if offset < len(audio) and not stop_event.is_set():
            raise RuntimeError('音频输出设备提前结束')
    finally:
        stream.close()


class StreamingAudioPlayer:
    """把增量 PCM 块连续送入单个 OutputStream，避免逐块 sd.play。"""

    def __init__(self, on_level=None, on_spectrum=None, stop_event=None, on_segment=None, stall_seconds=8.0,
                 on_render=None, on_drained=None, start_allowed=None):
        self.on_level = on_level
        self.on_spectrum = on_spectrum
        self.on_segment = on_segment
        self.on_render = on_render
        self.on_drained = on_drained
        self.start_allowed = start_allowed
        self._draining = False
        self._current_segment = None
        self._announced_segment = None
        self.stop_event = stop_event or threading.Event()
        self._chunks = queue.Queue(maxsize=16)
        self._analysis = queue.Queue(maxsize=4)
        self._eof = threading.Event()
        self._finished = threading.Event()
        self._stream = None
        self._current = np.empty(0, dtype=np.float32)
        self._offset = 0
        self._analyzer = None
        self._sample_rate = 24000
        self._started_at = None
        self._first_pcm_seconds = None
        self._callback_count = 0
        self._pcm_submitted = 0
        self._pcm_queued = 0
        self._stall_seconds = stall_seconds
        self._close_lock = threading.Lock()
        self._starved_callbacks = 0
        self._starved_frames = 0
        self._partial_starved_callbacks = 0
        self._device_underflows = 0
        self._status_events = 0
        self._queue_high_water = 0

    def start(self, sample_rate, first_chunk, segment=None):
        import sounddevice as sd

        self._sample_rate = int(sample_rate)
        self.enqueue(first_chunk, segment)
        self._analyzer = threading.Thread(target=self._analysis_loop, daemon=True)
        self._analyzer.start()

        def callback(outdata, frames, time_info, status):
            self._callback_count += 1
            if status:
                self._status_events += 1
                if getattr(status, 'output_underflow', False):
                    self._device_underflows += 1
            output = outdata[:, 0]
            output.fill(0)
            if (not self._pcm_submitted and not self.stop_event.is_set() and self.start_allowed
                    and not self.start_allowed()): return
            written = 0
            while written < frames:
                if self.stop_event.is_set():
                    raise sd.CallbackStop
                if self._offset >= self._current.size:
                    try:
                        self._current, self._current_segment = self._chunks.get_nowait()
                        self._offset = 0
                    except queue.Empty:
                        if self._eof.is_set():
                            if written:
                                break
                            raise sd.CallbackStop
                        self._starved_callbacks += 1
                        self._starved_frames += frames - written
                        if written:
                            self._partial_starved_callbacks += 1
                        break
                take = min(frames - written, self._current.size - self._offset)
                if take and self._current_segment != self._announced_segment:
                    self._announced_segment = self._current_segment
                    if self.on_segment and self._current_segment is not None:
                        # FIFO marker accompanies real PCM consumption, not
                        # synthesis/enqueue or the lossy spectrum queue.
                        self.on_segment(self._current_segment)
                output[written:written + take] = self._current[
                    self._offset:self._offset + take]
                self._offset += take
                written += take
                self._pcm_submitted += take
                if take and self._first_pcm_seconds is None:
                    self._first_pcm_seconds = time.perf_counter() - self._started_at
            if written:
                if self.on_render:
                    self.on_render(output[:written], self._sample_rate)
                self._offer_analysis(output[:written])

        def device_finished():
            if (self.on_drained and self._draining and not self.stop_event.is_set()
                    and self._pcm_submitted == self._pcm_queued):
                self.on_drained()
            self._finished.set()

        self._stream = sd.OutputStream(
            samplerate=int(sample_rate), channels=1, dtype="float32",
            callback=callback, finished_callback=device_finished,
            latency="low",
        )
        self._started_at = time.perf_counter()
        self._stream.start()

    def enqueue(self, audio, segment=None):
        chunk = np.ascontiguousarray(
            np.nan_to_num(np.asarray(audio, dtype=np.float32).reshape(-1)))
        if not chunk.size:
            return
        deadline=time.monotonic()+self._stall_seconds
        consumed=self._pcm_submitted
        while not self.stop_event.is_set():
            if self._finished.is_set():
                raise RuntimeError("音频输出设备提前结束")
            try:
                self._chunks.put((chunk, segment), timeout=0.1)
                self._pcm_queued += len(chunk)
                self._queue_high_water = max(self._queue_high_water, self._chunks.qsize())
                return
            except queue.Full:
                if self._pcm_submitted != consumed:
                    consumed=self._pcm_submitted
                    deadline=time.monotonic()+self._stall_seconds
                elif time.monotonic() >= deadline:
                    raise TimeoutError("音频输出设备停止消费数据")

    def finish(self, timeout=120.0):
        self._draining = True
        self._eof.set()
        deadline = time.monotonic() + timeout
        try:
            while not self._finished.wait(0.05):
                if self.stop_event.is_set():return
                if time.monotonic() >= deadline:
                    raise TimeoutError("音频输出设备没有确认播放结束")
            if not self.stop_event.is_set() and self._pcm_submitted < self._pcm_queued:
                raise RuntimeError("音频输出设备提前结束")
        finally:
            self.close()

    def close(self):
        self._eof.set()
        with self._close_lock:
            stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.stop()
            except Exception:
                try:
                    stream.abort()
                except Exception:
                    pass
            try:
                stream.close()
            except Exception:
                pass
        self._finished.set()
        if self._analyzer and self._analyzer.is_alive():
            self._analyzer.join(timeout=0.5)
        self._emit_silence()

    def metrics(self):
        """Read-only totals; queued/submitted PCM is not proof of physical audibility."""
        return {'schema':'asuka.stream-playback-metrics/1', 'callback_count':self._callback_count,
                'pcm_samples_submitted':self._pcm_submitted,
                'starved_callbacks':self._starved_callbacks,
                'starved_samples':self._starved_frames,
                'starved_seconds':self._starved_frames/self._sample_rate,
                'partial_starved_callbacks':self._partial_starved_callbacks,
                'device_output_underflows':self._device_underflows,
                'device_status_events':self._status_events,
                'queue_high_water_chunks':self._queue_high_water,
                'first_pcm_after_start_seconds':self._first_pcm_seconds}

    def _offer_analysis(self, segment):
        try:
            self._analysis.put_nowait(np.asarray(segment, dtype=np.float32).copy())
        except queue.Full:
            try:
                self._analysis.get_nowait()
                self._analysis.put_nowait(
                    np.asarray(segment, dtype=np.float32).copy())
            except queue.Empty:
                pass

    def _analysis_loop(self):
        while not self._finished.is_set():
            try:
                segment = self._analysis.get(timeout=0.1)
            except queue.Empty:
                continue
            if self.on_level:
                rms = float(np.sqrt(np.mean(segment ** 2))) if segment.size else 0.0
                self.on_level(min(1.0, rms / 0.05))
            if self.on_spectrum:
                self.on_spectrum(spectrum_bands(segment, self._sample_rate))

    def _emit_silence(self):
        if self.on_level:
            self.on_level(0.0)
        if self.on_spectrum:
            self.on_spectrum(np.zeros(96, dtype=np.float32))
