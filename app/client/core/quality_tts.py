"""Resident quality-TTS backend: reuse the verified VoiceEngine backend.

This module only loads/warms the already-validated backend and streams PCM for
pre-segmented Japanese text. It does not own the player, the chat UI, the
generation lock or the stop flag; the caller guarantees one active stream.

natural  = ordinary   -> V4 custom voice, explicit instruct is mandatory
soft_close=gentle_close -> Base310 full ICL, cached prompt, never receives instruct
youthful = general_a  -> Base clone (xvector), cached prompt, no instruct
"""
from __future__ import annotations

import sys
import copy
import threading
import time
from pathlib import Path
from contextlib import nullcontext

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from voice.tts.engine_backend import ObservedStream, load_backend
from voice.tts.reference_bank import ReferenceBank

CONFIG_SCHEMA = "asuka.voice-engine-config/1"
PRESETS_SCHEMA = "asuka.manual-voice-presets/1"
QUALITY_LANGUAGE = "Japanese"


class QualityTTSError(RuntimeError):
    """The quality backend refused or failed; the caller must present it."""


class QualityTTSBackend:
    """One resident backend per route, reusable across turns.

    ``prime`` loads/warms the backend and (for Base) the cached reference prompt.
    ``stream_segments`` yields ``(segment_index, audio, sample_rate, info)``; the
    completed segment records are available in ``results`` with actual arguments,
    EOS and truncation facts. Chunks are yielded immediately without look-ahead. Truncation raises ``QualityTTSError`` instead of
    silently reporting completion.
    """

    def __init__(self, config, presets):
        if not isinstance(config, dict) or config.get("schema") != CONFIG_SCHEMA:
            raise QualityTTSError("invalid quality voice config")
        if not isinstance(presets, dict) or presets.get("schema") != PRESETS_SCHEMA:
            raise QualityTTSError("invalid manual voice presets")
        self._config = copy.deepcopy(config)
        self._presets = copy.deepcopy(presets)
        self._catalog = self._config["catalog"]
        self._backends = {}   # backend name -> LoadedBackend
        self._prompts = {}    # (bank_path, reference_id, mode) -> one-item prompt list
        self._lock = threading.RLock()   # backstop; the caller holds its own lock
        self._closed = False
        self.results = {}     # segment_index -> ObservedStream.result()
        self._primed_routes = set()
        self._prefer_ram = False
        self.warmup_results = {}

    # ---- lifecycle -----------------------------------------------------
    @property
    def is_loaded(self):
        return bool(self._backends) and not self._closed

    def snapshot(self):
        """Describe this resident backend, even if the configuration on disk changes."""
        return {'config': copy.deepcopy(self._config), 'presets': copy.deepcopy(self._presets)}

    def _check_open(self):
        if self._closed:
            raise QualityTTSError("quality backend is closed")

    def _preset(self, preset_id):
        entries = self._presets.get("presets")
        if not isinstance(entries, dict) or preset_id not in entries:
            raise QualityTTSError("unknown voice preset: %r" % (preset_id,))
        entry = entries[preset_id]
        if not isinstance(entry, dict):
            raise QualityTTSError("invalid voice preset entry")
        profile_id = entry.get("profile_id")
        expected = {"natural": "ordinary", "soft_close": "gentle_close", "youthful": "general_a"}
        if preset_id not in expected or profile_id != expected[preset_id]:
            raise QualityTTSError("voice preset identity changed")
        profiles = self._catalog.get("profiles")
        profile = profiles.get(profile_id) if isinstance(profiles, dict) else None
        if not isinstance(profile, dict):
            raise QualityTTSError("voice preset has no catalog profile")
        if profile.get("language") != QUALITY_LANGUAGE:
            raise QualityTTSError("quality path only supports Japanese profiles")
        if profile.get("backend") not in {"v4_custom", "base_clone"}:
            raise QualityTTSError("unsupported backend in profile")
        return profile_id, profile

    def _loaded(self, profile):
        backend = profile["backend"]
        if backend not in self._backends:
            for old in self._backends.values():
                old.close()
            self._backends.clear()
            self._primed_routes.clear()
            route = {"backend": backend}
            if self._prefer_ram:
                route["prefer_ram"] = True
            self._backends[backend] = load_backend(self._config, route)
        return self._backends[backend]

    def _prompt(self, profile):
        key = (profile["bank_path"], profile["reference_id"], profile["mode"])
        if key not in self._prompts:
            # ReferenceBank.load re-checks the frozen fingerprint and admission and
            # rebuilds the one-item prompt from cached tensors; no audio re-encoding.
            self._prompts[key] = ReferenceBank(profile["bank_path"]).load(
                profile["reference_id"], profile["fingerprint"], mode=profile["mode"])
        return self._prompts[key]

    def prime(self, preset_id):
        """Load and warm the backend required by this preset (idempotent)."""
        with self._lock:
            for first in (True, False):
                try:
                    return self._prime_locked(preset_id)
                except RuntimeError as error:
                    from voice.tts.memory_placement import is_cuda_oom
                    if not is_cuda_oom(error):
                        raise
                    retry = self._on_memory_pressure()
                    if not first or not retry:
                        raise
                # The warmup PCM was never played. Release its frames before retry.
                import gc
                import torch
                gc.collect()
                torch.cuda.empty_cache()

    def _prime_locked(self, preset_id):
        self._check_open()
        profile_id, profile = self._preset(preset_id)
        loaded = self._loaded(profile)
        prompt = self._prompt(profile) if profile['backend'] == 'base_clone' else None
        if profile_id not in self._primed_routes:
            # CUDA graph capture does not exercise the first real prefill
            # and waveform decode. Do that once before declaring readiness.
            route = {'backend':profile['backend'], 'mode':profile['mode'],
                     'text':'はい、わかった。', 'language':QUALITY_LANGUAGE,
                     'speaker':profile['speaker'],
                     'actual_instruct':'自然に話す。' if profile['backend']=='v4_custom' else None}
            if prompt is not None:
                route['reference']={'reference_id':profile['reference_id']}
            observer = ObservedStream(loaded.faster, self._config, route, 20261110, prompt=prompt)
            iterator = iter(observer); started=time.perf_counter()
            try:
                audio, rate, _ = next(iterator)
                if not len(audio) or rate != 24000:
                    raise QualityTTSError('Quality warmup returned no usable PCM')
            except StopIteration as error:
                raise QualityTTSError('Quality warmup returned no PCM') from error
            finally:
                iterator.close()
            # Warmup is discarded: no player, recording or user-message result.
            self.warmup_results[profile_id]={'seconds':time.perf_counter()-started,
                'discarded_samples':len(audio),'recorded':False}
            self._primed_routes.add(profile_id)
        return {"preset_id": preset_id, "profile_id": profile_id,
                "backend": profile["backend"], "loaded": True}

    def close(self):
        """Drop the current resident backend and cached prompts; caller must hold the lock."""
        if self._closed:
            return
        self._closed = True
        self._drop_models()

    def _drop_models(self):
        for backend in self._backends.values():
            backend.close()
        self._backends.clear()
        self._prompts.clear()
        self._primed_routes.clear()

    def _on_memory_pressure(self):
        retry = any(b.identity.get("memory_placement") == "cuda" for b in self._backends.values())
        self._prefer_ram = True
        self._drop_models()
        return retry

    def resident_decoder(self):
        if not self._backends:
            return None
        loaded = next(iter(self._backends.values()))
        return loaded.replay_tokenizer, Path(self._config['models']['base']) / 'speech_tokenizer'

    # ---- streaming -----------------------------------------------------
    def stream_segments(self, segments, *, preset_id, language, instruct,
                        stop_event, seed, recording=None):
        """Yield ``(segment_index, audio, sample_rate, info)`` in order.

        ``segments`` are already split by the caller. ``seed`` is an int; each
        segment uses ``seed + index``. On stop, the current generator is closed
        without claiming completion.
        """
        self._check_open()
        if language != QUALITY_LANGUAGE:
            raise QualityTTSError("quality path only supports Japanese")
        if not isinstance(seed, int) or isinstance(seed, bool):
            raise QualityTTSError("seed must be an integer")
        profile_id, profile = self._preset(preset_id)
        backend = profile["backend"]
        if backend == "base_clone":
            if instruct is not None:
                raise QualityTTSError("Base voice must not receive a text instruction")
            actual_instruct = None
        else:
            if not isinstance(instruct, str) or not instruct.strip():
                raise QualityTTSError("natural (V4) requires a nonempty instruct")
            actual_instruct = instruct
        if not self._lock.acquire(blocking=False):
            raise QualityTTSError("another quality stream is already active")
        try:
            loaded = self._loaded(profile)
            prompt = self._prompt(profile) if backend == "base_clone" else None
            self.results = {}
            for index, segment in enumerate(segments):
                if stop_event.is_set():
                    return
                if not isinstance(segment, str) or not segment.strip():
                    continue
                route = {"backend": backend, "mode": profile["mode"],
                         "text": segment, "language": language,
                         "speaker": profile["speaker"],
                         "actual_instruct": actual_instruct}
                if backend == "base_clone":
                    route["reference"] = {"reference_id": profile["reference_id"]}
                segment_seed = seed + index
                observer = ObservedStream(
                    loaded.faster, self._config, route, segment_seed, prompt=prompt)
                generator = iter(observer)
                try:
                    watch = recording.observe(loaded.replay_tokenizer,
                        Path(self._config['models']['base']) / 'speech_tokenizer') if recording else nullcontext()
                    with watch:
                        for audio, rate, info in generator:
                            if stop_event.is_set():
                                break
                            if recording: recording.chunk(audio, rate)
                            enriched = dict(info)
                            enriched["segment_index"] = index
                            enriched["seed"] = segment_seed
                            yield (index, audio, rate, enriched)
                        else:
                            if stop_event.is_set(): return
                            result = observer.result()
                            if result["reached_token_limit"] or not result["ended_on_eos"]:
                                raise QualityTTSError("segment %d ended without EOS (truncated)" % index)
                            if not result.get("pcm_samples"):
                                raise QualityTTSError("segment %d produced no audio" % index)
                            self.results[index] = result
                            continue
                        return
                finally:
                    generator.close()
        except RuntimeError as error:
            from voice.tts.memory_placement import is_cuda_oom
            if is_cuda_oom(error):
                # A stream may already have reached the speaker. Never restart it.
                self._on_memory_pressure()
            raise
        finally:
            self._lock.release()
