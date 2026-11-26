"""Isolated quality-first PCM decoding on an existing FasterQwen model.

Generation, prompt preparation and CUDA graphs remain the installed backend's.
Only codec-to-waveform decoding changes: each chunk decodes the complete causal
prefix directly, avoiding both Faster's 25-frame window and the tokenizer's
hidden 300-frame/25-frame split. No client, model loading or encoder is added.
"""
from __future__ import annotations

from contextlib import contextmanager
import copy
from functools import wraps
from inspect import signature
import math
import threading

import numpy as np

from .candidate_codec_stream import CumulativePCMDecoder


class PrefixBackendError(ValueError):
    """Unsupported or inconsistent candidate streaming request."""


def _lazy_inference(function):
    """Use Torch's generator-aware context wrapper without eager Torch import.

    A plain ``with inference_mode()`` across a yield would leak thread-local
    inference mode into a direct consumer. Torch's decorator scopes each resume.
    """
    parameters = signature(function)

    @wraps(function)
    def call(*args, **kwargs):
        parameters.bind(*args, **kwargs)
        import torch
        return torch.inference_mode()(function)(*args, **kwargs)
    return call


class PrefixFasterBackend:
    """Wrap a loaded FasterQwen3TTS instance without altering it or its weights.

    The underlying object must be idle and owned by this wrapper while a stream
    is active. An optional per-request observer receives the actual preparation,
    sampled tokens and codec results through explicit callbacks.
    ``completed``/EOS/cancellation policy belongs to the caller, not this decoder.
    """

    def __init__(self, faster):
        self._faster = faster
        self._stream_lock = threading.Lock()
        self._last_decode_snapshot = None

    def __getattr__(self, name):
        return getattr(object.__getattribute__(self, "_faster"), name)

    @property
    def last_decode_snapshot(self):
        return copy.deepcopy(self._last_decode_snapshot)

    @contextmanager
    def _request(self):
        if not self._stream_lock.acquire(blocking=False):
            raise PrefixBackendError("Only one active stream may use a candidate backend")
        self._last_decode_snapshot = None
        try:
            yield
        finally:
            self._stream_lock.release()

    @staticmethod
    def _sampling(max_new_tokens, min_new_tokens, temperature, top_k, top_p,
                  do_sample, repetition_penalty, chunk_size):
        for key, value, minimum in (("max_new_tokens", max_new_tokens, 1),
                                    ("min_new_tokens", min_new_tokens, 0),
                                    ("top_k", top_k, 0), ("chunk_size", chunk_size, 1)):
            if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
                raise PrefixBackendError(key + " is invalid")
        if min_new_tokens >= max_new_tokens:
            raise PrefixBackendError("min_new_tokens must be below max_new_tokens")
        if not isinstance(do_sample, bool):
            raise PrefixBackendError("do_sample must be a boolean")
        for key, value in (("temperature", temperature), ("top_p", top_p),
                           ("repetition_penalty", repetition_penalty)):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise PrefixBackendError(key + " must be finite and positive")
        if top_p > 1:
            raise PrefixBackendError("top_p must not exceed one")
        return dict(max_new_tokens=max_new_tokens, min_new_tokens=min_new_tokens,
                    temperature=temperature, top_k=top_k, top_p=top_p,
                    do_sample=do_sample, repetition_penalty=repetition_penalty,
                    chunk_size=chunk_size)

    @staticmethod
    def _codes_numpy(codes):
        if hasattr(codes, "detach"):
            codes = codes.detach().cpu().numpy()
        array = np.asarray(codes)
        if array.ndim != 2 or array.shape[1] != 16 or array.dtype.kind not in {"i", "u"}:
            raise PrefixBackendError("Codec input must be an integer [T, 16] array")
        if array.size and (int(array.min()) < 0 or int(array.max()) > np.iinfo(np.int64).max):
            raise PrefixBackendError("Codec input contains invalid integer token IDs")
        return np.array(array, copy=True, order="C")

    @staticmethod
    def _direct_decoder(tokenizer):
        """Build the exact 12.5 Hz -> 24 kHz decoder, never wrapper.decode()."""
        model = tokenizer.model
        if model.get_model_type() != "qwen3_tts_tokenizer_12hz":
            raise PrefixBackendError("Only the verified 12 Hz tokenizer is supported")
        if int(model.get_output_sample_rate()) != 24000 or int(model.get_decode_upsample_rate()) != 1920:
            raise PrefixBackendError("Unexpected tokenizer sample rate or frame stride")
        decoder = model.decoder
        config = decoder.config
        if int(config.num_quantizers) != 16 or int(decoder.total_upsample) != 1920:
            raise PrefixBackendError("Unexpected decoder quantizers or upsampling")
        if int(decoder.quantizer.n_q_semantic) != 1:
            raise PrefixBackendError("Expected one semantic and fifteen acoustic codebooks")
        semantic_size, acoustic_size = int(config.semantic_codebook_size), int(config.codebook_size)
        if semantic_size != 4096 or acoustic_size != 2048:
            raise PrefixBackendError("Unexpected codebook ranges")
        if model.training or decoder.training:
            raise PrefixBackendError("Candidate decoder must be in eval mode")

        def decode(all_codes):
            import torch
            if (not isinstance(all_codes, np.ndarray) or all_codes.ndim != 2
                    or all_codes.shape[1] != 16 or all_codes.dtype.kind not in {"i", "u"}
                    or not len(all_codes)):
                raise PrefixBackendError("Expected nonempty integer [T, 16] codec prefix")
            if (np.any(all_codes < 0) or np.any(all_codes[:, 0] >= semantic_size)
                    or np.any(all_codes[:, 1:] >= acoustic_size)):
                raise PrefixBackendError("Codec token is outside its codebook range")
            expected_samples = len(all_codes) * 1920
            codes = torch.from_numpy(np.array(all_codes, dtype=np.int64, copy=True))
            codes = codes.to(tokenizer.device).transpose(0, 1).unsqueeze(0).contiguous()
            with torch.inference_mode():
                # Do not call tokenizer.decode or tokenizer.model.decode: both
                # reintroduce the installed 300-frame + 25-history chunking.
                wave = decoder(codes)
            if tuple(wave.shape) != (1, 1, expected_samples):
                raise PrefixBackendError("Direct decoder violated N * 1920 output length")
            audio = wave.detach().float().cpu().numpy().reshape(-1).copy()
            if not np.isfinite(audio).all() or np.any(np.abs(audio) > 1.0):
                raise PrefixBackendError("Direct decoder returned invalid PCM")
            return audio, 24000

        return decode

    def _codec_to_pcm(self, prepared, sampling, reference_codes=None, observer=None):
        if observer is None:
            from faster_qwen3_tts.streaming import fast_generate_streaming
        else:
            from .vendor.observed_graph import fast_generate_streaming
        m, talker, config, tie, tam, tth, tpe = prepared
        prefill = int(tie.shape[1])
        if prefill + sampling["max_new_tokens"] + 1 >= self.max_seq_len:
            raise PrefixBackendError("Request cannot fit the configured static cache")
        reference = None if reference_codes is None else self._codes_numpy(reference_codes)
        decoder = CumulativePCMDecoder(self._direct_decoder(m.speech_tokenizer), reference)
        callback = {}
        if observer is not None:
            observer.codec_parameters(sampling, config)
            callback["on_sample"] = observer.sampled
        source = fast_generate_streaming(
            talker=talker, talker_input_embeds=tie, attention_mask=tam,
            trailing_text_hiddens=tth, tts_pad_embed=tpe, config=config,
            predictor_graph=self.predictor_graph, talker_graph=self.talker_graph, **sampling, **callback,
        )
        try:
            for codes, timing in source:
                array = self._codes_numpy(codes)
                if observer is not None:
                    observer.codec_chunk(array,timing)
                audio, rate = decoder.push(array)
                # Our direct decoder has a fixed positive integer stride. An
                # empty/non-growing suffix is therefore a contract violation.
                if len(audio) != len(array) * 1920:
                    raise PrefixBackendError("Incremental PCM length differs from new codec frames")
                snapshot = decoder.snapshot()
                expected_crop = snapshot["reference_frames"] * 1920
                if snapshot["reference_crop_samples"] != expected_crop:
                    raise PrefixBackendError("Reference crop must equal reference_frames * 1920")
                observed = dict(timing)
                observed["pcm_decode"] = {
                    "strategy": "direct_full_prefix_integer_crop", "samples_per_frame": 1920,
                    "reference_frames": snapshot["reference_frames"],
                    "reference_crop_samples": expected_crop,
                    "cumulative_generated_frames": snapshot["received_codec_frames"],
                    "cumulative_generated_samples": snapshot["published_samples"],
                    "chunk_decode_seconds": snapshot["chunks"][-1]["decode_seconds"],
                    "cumulative_decode_seconds": snapshot["decode_seconds"],
                    "installed_window_decoder_used": False,
                }
                yield audio, rate, observed
            if observer is not None:
                observer.codec_source_exhausted = True
        finally:
            try:
                source.close()
            finally:
                self._last_decode_snapshot = decoder.snapshot()

    @_lazy_inference
    def generate_voice_clone_streaming(
        self, text, language, ref_audio=None, ref_text="", max_new_tokens=2048,
        min_new_tokens=2, temperature=0.9, top_k=50, top_p=1.0, do_sample=True,
        repetition_penalty=1.05, chunk_size=12, xvec_only=False,
        non_streaming_mode=None, append_silence=True, parity_mode=False,
        instruct=None, voice_clone_prompt=None, *, observer=None,
    ):
        if parity_mode:
            raise PrefixBackendError("This candidate validates only the installed Faster CUDA graph path")
        if instruct is not None:
            raise PrefixBackendError("Base candidate does not support experimental instruct conditioning")
        if voice_clone_prompt is None or ref_audio is not None:
            raise PrefixBackendError("Candidate prefix backend requires a cached prompt and no raw reference audio")
        sampling = self._sampling(max_new_tokens, min_new_tokens, temperature, top_k, top_p,
                                  do_sample, repetition_penalty, chunk_size)
        with self._request():
            prepared = self._prepare_generation(
                text=text, language=language, ref_audio=None, ref_text=ref_text,
                xvec_only=xvec_only, non_streaming_mode=False if non_streaming_mode is None else non_streaming_mode,
                append_silence=append_silence, voice_clone_prompt=voice_clone_prompt, instruct=instruct,
            )
            if observer is not None:
                observer.prepared(prepared,non_streaming_mode=False if non_streaming_mode is None else non_streaming_mode,instruct=instruct)
            yield from self._codec_to_pcm(prepared[:7], sampling, reference_codes=prepared[7],observer=observer)

    @_lazy_inference
    def generate_custom_voice_streaming(
        self, text, speaker, language, instruct=None, non_streaming_mode=None,
        max_new_tokens=2048, min_new_tokens=2, temperature=0.9, top_k=50,
        top_p=1.0, do_sample=True, repetition_penalty=1.05, chunk_size=12, *, observer=None,
    ):
        if self.model.model.tts_model_type != "custom_voice":
            raise PrefixBackendError("Loaded model does not support custom voice generation")
        self.model._validate_languages([language])
        self.model._validate_speakers([speaker])
        if self.model.model.tts_model_size in "0b6" and instruct:
            raise PrefixBackendError("This candidate does not silently discard instructions for 0.6B")
        sampling = self._sampling(max_new_tokens, min_new_tokens, temperature, top_k, top_p,
                                  do_sample, repetition_penalty, chunk_size)
        with self._request():
            prepared = self._prepare_generation_custom(
                text=text, speaker=speaker, language=language, instruct=instruct,
                non_streaming_mode=True if non_streaming_mode is None else non_streaming_mode,
            )
            if observer is not None:
                observer.prepared(prepared,non_streaming_mode=True if non_streaming_mode is None else non_streaming_mode,instruct=instruct)
            yield from self._codec_to_pcm(prepared, sampling, observer=observer)
