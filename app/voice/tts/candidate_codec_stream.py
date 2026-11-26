"""Quality-first cumulative codec decoding for bounded candidate utterances.

Every push decodes the *entire* reference plus generated codec prefix, and only
publishes the newly available PCM suffix. This intentionally retains history
instead of truncating it to a fixed left window. Repeatedly processed codec-frame
count is O(N²) for fixed-size chunks (backend computation can cost more); this
does not provide constant latency for unlimited text.
Use one new decoder per bounded utterance and one calling thread per instance.

The supplied decoder owns its model and chooses its precision. This module has
no model, Torch, player, EOS policy, smoothing, normalization or client binding.
It cannot guarantee that a backend's later prefix decode leaves already emitted
PCM unchanged; acoustic and numeric comparison remain separate checks.
"""

from __future__ import annotations

import copy
import time
from typing import Callable

import numpy as np


class CodecStreamError(ValueError):
    """Invalid codec/output contract; the current utterance cannot continue."""


def _copy_codes(value: np.ndarray, name: str, *, allow_empty: bool = False) -> np.ndarray:
    if not isinstance(value, np.ndarray) or value.ndim != 2 or value.shape[1] != 16:
        raise CodecStreamError(f"{name} must be a numpy integer array shaped [T, 16]")
    if value.dtype.kind not in {"i", "u"}:
        raise CodecStreamError(f"{name} must use an integer dtype")
    if not allow_empty and not len(value):
        raise CodecStreamError(f"{name} must contain at least one codec frame")
    if value.size and (int(value.min()) < 0 or int(value.max()) > np.iinfo(np.int64).max):
        raise CodecStreamError(f"{name} contains invalid codec token IDs")
    # Consistent int64 avoids numpy promoting mixed signed/unsigned chunks to
    # floating point. Both the caller's array and decoder inputs stay separate.
    return np.array(value, dtype=np.int64, order="C", copy=True)


class CumulativePCMDecoder:
    """Decode full prefixes and return ``(new_pcm_float32, sample_rate)``.

    ``decode_fn(all_codes)`` must return mono float32 PCM and a positive integer
    sample rate. Its input always contains reference frames first, followed by
    every accepted generated frame. All arrays crossing the boundary are copied.

    Reference cropping is exact integer arithmetic:
    ``reference_frames * decoded_samples // total_frames``. No reference PCM is
    ever published. A non-growing output is recorded and returns an empty suffix;
    a shrinking output or any error permanently fails this utterance instance.
    Already emitted chunks and prior snapshots remain valid independent copies.
    """

    def __init__(self, decode_fn: Callable, reference_codes: np.ndarray | None = None):
        if not callable(decode_fn):
            raise TypeError("decode_fn must be callable")
        self._decode = decode_fn
        self._reference = (np.empty((0, 16), dtype=np.int64) if reference_codes is None
                           else _copy_codes(reference_codes, "reference_codes", allow_empty=True))
        self._codes: list[np.ndarray] = []
        self._received_frames = 0
        self._published_samples = 0
        self._decoded_samples = 0
        self._sample_rate: int | None = None
        self._reference_crop = 0
        self._status = "ready"
        self._attempts: list[dict] = []
        self._decode_seconds = 0.0
        self._total_seconds = 0.0

    def push(self, codes: np.ndarray) -> tuple[np.ndarray, int]:
        if self._status == "failed":
            raise CodecStreamError("This utterance failed; create a new CumulativePCMDecoder")
        if self._status == "decoding":
            raise CodecStreamError("Concurrent or recursive push is not supported")
        started = time.perf_counter()
        attempt = {"index": len(self._attempts), "status": "running", "stage": "input",
                   "previous_published_samples": self._published_samples}
        self._attempts.append(attempt)
        self._status = "decoding"
        decode_started = None
        decode_finished = None
        try:
            chunk = _copy_codes(codes, "codes")
            received = self._received_frames + len(chunk)
            full_codes = np.concatenate([self._reference, *self._codes, chunk], axis=0)
            total_frames = len(full_codes)
            attempt.update(input_frames=len(chunk), cumulative_generated_frames=received,
                           reference_frames=len(self._reference), total_decode_frames=total_frames,
                           stage="decode")
            decode_started = time.perf_counter()
            # full_codes is disposable: a backend mutation cannot corrupt any
            # stored chunk, reference array, or caller-provided input.
            result = self._decode(full_codes)
            decode_finished = time.perf_counter()
            attempt["stage"] = "output"
            if not isinstance(result, (tuple, list)) or len(result) != 2:
                raise CodecStreamError("decode_fn must return (mono_float32_pcm, sample_rate)")
            audio, rate = result
            if (not isinstance(audio, np.ndarray) or audio.ndim != 1
                    or audio.dtype != np.dtype(np.float32) or not audio.size):
                raise CodecStreamError("decode_fn must return a nonempty mono float32 PCM array")
            if not np.isfinite(audio).all():
                raise CodecStreamError("Decoded PCM contains non-finite samples")
            if isinstance(rate, (bool, np.bool_)) or not isinstance(rate, (int, np.integer)) or rate <= 0:
                raise CodecStreamError("sample_rate must be a positive integer")
            rate = int(rate)
            if self._sample_rate is not None and rate != self._sample_rate:
                raise CodecStreamError("sample_rate changed within one utterance")
            if int(audio.size) < self._decoded_samples:
                raise CodecStreamError("Decoded total PCM length moved backwards")
            reference_crop = len(self._reference) * int(audio.size) // total_frames
            generated_samples = int(audio.size) - reference_crop
            attempt.update(decoded_samples=int(audio.size), reference_crop_samples=reference_crop,
                           cumulative_generated_samples=generated_samples, sample_rate=rate)
            if generated_samples < self._published_samples:
                raise CodecStreamError("Decoded generated PCM length moved backwards")
            incremental = np.array(audio[reference_crop + self._published_samples:],
                                   dtype=np.float32, order="C", copy=True)
            self._codes.append(chunk)
            self._received_frames = received
            self._sample_rate = rate
            self._reference_crop = reference_crop
            self._published_samples = generated_samples
            self._decoded_samples = int(audio.size)
            attempt.update(status="accepted", emitted_samples=int(incremental.size),
                           published_samples=self._published_samples)
            self._status = "active"
            return incremental, rate
        except BaseException as exc:
            self._status = "failed"
            attempt.update(status="failed", error={"type": type(exc).__name__, "message": str(exc)})
            raise
        finally:
            elapsed = time.perf_counter() - started
            decode_elapsed = (0.0 if decode_started is None else
                              (decode_finished or time.perf_counter()) - decode_started)
            attempt.update(total_seconds=elapsed, decode_seconds=decode_elapsed)
            self._total_seconds += elapsed
            self._decode_seconds += decode_elapsed

    def snapshot(self) -> dict:
        return copy.deepcopy({
            "schema": "asuka.cumulative-codec-stream/1",
            "status": self._status,
            "reference_frames": len(self._reference),
            "accepted_chunks": len(self._codes),
            "attempted_chunks": len(self._attempts),
            "received_codec_frames": self._received_frames,
            "published_samples": self._published_samples,
            "last_decoded_samples_including_reference": self._decoded_samples,
            "sample_rate": self._sample_rate,
            "reference_crop_samples": self._reference_crop,
            "decode_seconds": self._decode_seconds,
            "total_seconds": self._total_seconds,
            "strategy": "full_reference_and_generated_prefix",
            "cost_scope": "Repeated full-prefix decode; O(N squared) processed frames for fixed-size chunks, backend compute may cost more. Bounded utterances only.",
            "smoothing": False, "normalization": False,
            "chunks": self._attempts,
        })
