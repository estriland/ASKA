"""Model execution for one owned voice-engine worker.

Importing this module does not import Torch, Qwen, PEFT or load a model. The
caller must validate the complete submission before calling ``load_backend``.
Only existing local weights and cached reference prompts are consumed. Nothing
here selects emotional conditions, changes training data, or encodes references.
"""
from __future__ import annotations

import copy
import gc
import hashlib
import json
from pathlib import Path
import time
from .stream_contract import CachedReferenceView, StreamRandomState, check_faster_installation, own_voice_stream


class BackendError(RuntimeError):
    """A validated request could not be executed by the selected backend."""


def generation_arguments(config, route, prompt=None):
    """Resolve only executable arguments; Base never receives an instruction."""
    sampling = dict(config["generation"])
    sampling.pop("eos_token_id")
    args = {"text": route["text"], "language": route["language"],
            "chunk_size": config["runtime"]["chunk_size"], **sampling}
    backend = route["backend"]
    if backend == "base_clone":
        if route.get("actual_instruct") is not None:
            raise BackendError("Base reference execution cannot consume instruct")
        if not isinstance(prompt, list) or len(prompt) != 1:
            raise BackendError("Base requires exactly one cached reference prompt")
        if route.get("mode") not in {"xvector", "icl"}:
            raise BackendError("Unsupported cached reference mode")
        args.update(voice_clone_prompt=prompt, non_streaming_mode=False)
        return "generate_voice_clone_streaming", args
    if backend == "v4_custom":
        if prompt is not None:
            raise BackendError("Custom voice must not receive a reference prompt")
        args.update(speaker=config["models"]["speaker_name"],
                    instruct=route["actual_instruct"], non_streaming_mode=True)
        return "generate_custom_voice_streaming", args
    raise BackendError("Unsupported backend")


def _merge_custom_voice(base, settings):
    """Merge the frozen adapter and inject its speaker before CUDA capture.

    The speaker config/embedding operations follow the existing Qwen LoRA
    inference entry, without importing or executing that experiment's CLI.
    """
    import torch
    from peft import PeftModel
    from safetensors.torch import load_file

    if settings["lora_scale"] != 1.0:
        raise BackendError("Only the verified V4 adapter scale 1.0 is supported")
    checkpoint = Path(settings["checkpoint"])
    wrapped = PeftModel.from_pretrained(base.model, str(checkpoint), local_files_only=True)
    core = wrapped.merge_and_unload()
    if not hasattr(core, "talker"):
        raise BackendError("Merged model does not expose the expected Qwen talker")
    checkpoint_config = json.loads((checkpoint / "config.json").read_text(encoding="utf-8"))
    speaker_config = checkpoint_config.get("talker_config", {})
    for name in ("spk_id", "spk_is_dialect"):
        value = speaker_config.get(name, {})
        if not isinstance(value, dict):
            raise BackendError("Checkpoint speaker configuration is invalid")
        getattr(core.config.talker_config, name).update(value)
    speaker, speaker_id = settings["speaker_name"], settings["speaker_id"]
    actual = core.config.talker_config.spk_id.get(speaker, speaker_id)
    if isinstance(actual, bool) or actual != speaker_id:
        raise BackendError("Checkpoint speaker identity differs from the frozen configuration")
    core.config.talker_config.spk_id[speaker] = speaker_id
    core.config.talker_config.spk_is_dialect.setdefault(speaker, False)
    payload = load_file(str(checkpoint / "speaker_embedding.safetensors"))
    embedding = payload.get("target_speaker_embedding")
    weight = core.talker.model.codec_embedding.weight
    if embedding is None or not 0 <= speaker_id < weight.shape[0]:
        raise BackendError("Missing or invalid speaker embedding")
    if tuple(embedding.shape) != tuple(weight[speaker_id].shape):
        raise BackendError("Speaker embedding shape differs from the model")
    if not bool(torch.isfinite(embedding).all()):
        raise BackendError("Speaker embedding contains non-finite values")
    with torch.no_grad():
        weight[speaker_id].copy_(embedding.to(device=weight.device, dtype=weight.dtype))
    core.config.tts_model_type = "custom_voice"
    core.tts_model_type = "custom_voice"
    core.supported_speakers = core.config.talker_config.spk_id.keys()
    base.model = core
    return {"merged_before_graph_construction": True, "lora_scale": 1.0,
            "speaker": speaker, "speaker_id": speaker_id,
            "checkpoint_path": str(checkpoint)}


class LoadedBackend:
    def __init__(self, faster, identity, reference_counts):
        self.faster = faster
        self.identity = identity
        self.reference_counts = reference_counts
        self.closed = False

    def close(self):
        """Drop this worker's model; process exit is the final resource boundary."""
        if self.closed:
            return
        self.faster = None
        self.replay_tokenizer = None
        gc.collect()
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        self.closed = True


def load_backend(config, route):
    import torch
    if not torch.cuda.is_available():
        raise BackendError("本地语音合成需要支持 CUDA 的 NVIDIA 显卡。")
    from .memory_placement import load_adaptively
    with own_voice_stream():
        loaded, _ = load_adaptively(config["runtime"]["device"],
            lambda mode, available: _load_owned_backend(config, route, mode, available),
            prefer_ram=route.get("prefer_ram", False))
        return loaded

def _load_owned_backend(config, route, memory_mode, available):
    """Load only local weights, merge if required, then capture and warm up."""
    backend = route["backend"]
    if backend not in {"base_clone", "v4_custom"}:
        raise BackendError("Unsupported backend")
    runtime, models = config["runtime"], config["models"]
    if runtime["dtype"] != "bfloat16" or runtime["device"] != "cuda:0":
        raise BackendError("Only the verified CUDA/BF16 runtime is supported")
    if backend == "base_clone" and route.get("actual_instruct") is not None:
        raise BackendError("Base reference execution cannot consume instruct")
    check_faster_installation()
    import torch
    import qwen_tts
    import faster_qwen3_tts
    from .memory_placement import load_qwen
    from faster_qwen3_tts import FasterQwen3TTS
    from faster_qwen3_tts.predictor_graph import PredictorGraph
    from faster_qwen3_tts.talker_graph import TalkerGraph
    from .candidate_prefix_backend import PrefixFasterBackend

    device = runtime["device"]
    free, total = torch.cuda.mem_get_info(device)
    started = time.perf_counter()
    base = load_qwen(models["base"], device, runtime["attention"], memory_mode, precomputed_reference=True)
    if base.model.tts_model_type != "base":
        raise BackendError("Configured base checkpoint is not a Base model")
    merge = _merge_custom_voice(base, models) if backend == "v4_custom" else None
    core = base.model
    core.eval()
    talker, talker_config = core.talker, core.config.talker_config
    if memory_mode == "cpu_lookup" and talker.get_text_embeddings().weight.device.type != "cpu":
        raise BackendError("Voice adapter merge changed the CPU text placement")
    sub = config["subtalker"]
    predictor = PredictorGraph(talker.code_predictor, talker.code_predictor.model.config,
                               talker_config.hidden_size, device=device, dtype=torch.bfloat16, **sub)
    talker_graph = TalkerGraph(talker.model, talker_config, device=device, dtype=torch.bfloat16,
                              max_seq_len=runtime["max_seq_len"])
    counts = {"raw_reference_loader": 0, "create_reference": 0, "speaker_encoder": 0, "audio_encoder": 0}
    tokenizer_view = CachedReferenceView(core.speech_tokenizer, {"encode":"audio_encoder"}, counts)
    core_view = CachedReferenceView(core, {"extract_speaker_embedding":"speaker_encoder"}, counts, speech_tokenizer=tokenizer_view)
    model_view = CachedReferenceView(base, {"create_voice_clone_prompt":"create_reference"}, counts, model=core_view)
    class CachedPromptFaster(FasterQwen3TTS):
        def _load_ref_audio_with_silence(self, *args, **kwargs):
            counts["raw_reference_loader"] += 1
            raise BackendError("Unexpected reference extraction: raw_reference_loader")
    faster = CachedPromptFaster(model_view, predictor, talker_graph, device=device,
                                dtype=torch.bfloat16, max_seq_len=runtime["max_seq_len"])
    with torch.inference_mode(), torch.cuda.device(device):
        faster.warmup(prefill_len=100)
    if not (faster._warmed_up and predictor.captured and talker_graph.captured):
        raise BackendError("CUDA capture or warmup did not complete")
    actual_sub = {key: getattr(predictor, key) for key in sub}
    if actual_sub != sub:
        raise BackendError("Subtalker parameters changed during loading")
    if (int(talker_config.codec_eos_token_id) != config["generation"]["eos_token_id"]
            or int(talker_config.num_code_groups) != 16):
        raise BackendError("Codec identity differs from the validated configuration")
    identity = {
        "backend": backend, "base_path": models["base"], "device": device,
        "dtype": str(torch.bfloat16), "attention": runtime["attention"],
        "torch_version": torch.__version__, "qwen_module": qwen_tts.__file__,
        "faster_module": faster_qwen3_tts.__file__, "max_seq_len": runtime["max_seq_len"],
        "actual_subtalker": actual_sub, "v4_merge": merge,
        "warmup_before_request_seed": True, "load_and_warmup_seconds": time.perf_counter() - started,
        "gpu_free_before_load": free, "gpu_total_bytes": total,
        "memory_placement": memory_mode, "available_cuda_budget_bytes": available,
        "decoder": "direct_full_prefix_integer_crop",
        "timing_scope": "Observed execution includes token synchronization; not a production latency benchmark.",
    }
    loaded = LoadedBackend(PrefixFasterBackend(faster), identity, counts)
    loaded.replay_tokenizer = core.speech_tokenizer
    return loaded


class ObservedStream:
    """Observe actual talker EOS and codec frames, not Faster's is_final flag."""

    def __init__(self, faster, config, route, seed, prompt=None):
        self.faster, self.config = faster, config
        self.route, self.seed, self.prompt = route, seed, prompt
        self.first_tokens, self.codec_trace, self.pcm_trace = [], [], []
        self.codec_frames = self.generated_pcm_samples = 0
        self.codec_hash = hashlib.sha256()
        self.preparation = self.actual_stream_arguments = self.actual_public_arguments = None
        self.codec_source_exhausted = False
        self.started = self.closed_at = None

    def sampled(self, token):
        self.first_tokens.extend(int(v) for v in token.detach().flatten().cpu().tolist())

    def prepared(self, result, *, non_streaming_mode, instruct):
        size = 8 if self.route['backend'] == 'base_clone' else 7
        if not isinstance(result,(tuple,list)) or len(result) != size:
            raise BackendError('Unsupported FasterQwen preparation shape')
        text_shape = getattr(result[3], 'shape', ())
        tail_shape = getattr(result[5], 'shape', ())
        if len(text_shape) != 3 or len(tail_shape) != 3 or text_shape[0] != 1 or tail_shape[0] != 1:
            raise BackendError('Unsupported FasterQwen embedding shape')
        prefill=int(text_shape[1])
        if prefill + self.config['generation']['max_new_tokens'] + 1 >= self.config['runtime']['max_seq_len']:
            raise BackendError('Request cannot fit the configured static cache')
        if instruct != self.route['actual_instruct']:
            raise BackendError('Prepared instruction differs from the validated route')
        self.preparation = {'prefill_tokens':prefill, 'trailing_text_tokens':int(tail_shape[1]),
                            'non_streaming_mode':non_streaming_mode, 'actual_instruct':instruct,
                            'ready_elapsed_seconds':time.perf_counter()-self.started,
                            'cache_limit_cannot_be_reached_with_budget':True}

    def codec_parameters(self, sampling, config):
        expected=self.config['generation']
        self.actual_stream_arguments={key:sampling[key] for key in expected if key!='eos_token_id'}
        self.actual_stream_arguments['eos_token_id']=int(config.codec_eos_token_id)
        if self.actual_stream_arguments!=expected or sampling['chunk_size']!=self.config['runtime']['chunk_size']:
            raise BackendError('Actual generation parameters differ from the validated configuration')

    def codec_chunk(self, codes, timing):
        if codes.ndim != 2 or codes.shape[1] != 16:
            raise BackendError('Expected codec shape [T, 16]')
        self.codec_hash.update(codes.astype('<i8',copy=False).tobytes(order='C'))
        frames=int(codes.shape[0]);self.codec_frames+=frames
        self.codec_trace.append({'frames':frames,'timing':dict(timing),'elapsed_seconds':time.perf_counter()-self.started})

    def __iter__(self):
        import numpy as np
        import torch
        self.started = time.perf_counter()
        method_name, args = generation_arguments(self.config, self.route, self.prompt)
        self.actual_public_arguments = {key: value for key, value in args.items() if key != "voice_clone_prompt"}
        if self.prompt is not None:
            self.actual_public_arguments["voice_clone_prompt"] = {
                "cached_list_length": len(self.prompt), "mode": self.route["mode"],
                "reference_id": self.route["reference"]["reference_id"],
                "ref_text": self.prompt[0].ref_text,
                "ref_code_frames": 0 if self.prompt[0].ref_code is None else int(self.prompt[0].ref_code.shape[0]),
            }
        try:
            with own_voice_stream():
                rng=StreamRandomState(torch,self.config['runtime']['device'],self.seed)
                source=getattr(self.faster,method_name)(**args,observer=self)
                try:
                    while True:
                        with rng.advance():
                            try: audio,rate,timing=next(source)
                            except StopIteration: break
                        wave = np.asarray(audio, dtype=np.float32).reshape(-1).copy()
                        if not wave.size or not np.isfinite(wave).all() or np.any(np.abs(wave) > 1):
                            raise BackendError("PCM chunk is empty, non-finite or outside [-1, 1]")
                        if int(rate) != 24000:
                            raise BackendError("Unexpected output sample rate")
                        self.generated_pcm_samples += int(wave.size)
                        observed = dict(timing)
                        observed["producer_elapsed_seconds"] = time.perf_counter() - self.started
                        self.pcm_trace.append({"index": len(self.pcm_trace), "samples": int(wave.size),
                                               "end_sample": self.generated_pcm_samples,
                                               "sample_rate": int(rate), **observed})
                        yield wave, int(rate), observed
                finally:
                    with rng.advance():
                        source.close()
        finally:
            self.closed_at = time.perf_counter()

    def result(self):
        eos = self.config["generation"]["eos_token_id"]
        terminal = self.first_tokens[-1] if self.first_tokens else None
        reached_limit = self.codec_frames >= self.config["generation"]["max_new_tokens"]
        return {
            "actual_public_arguments": copy.deepcopy(self.actual_public_arguments),
            "resolved_generation_parameters": copy.deepcopy(self.actual_stream_arguments),
            "preparation": copy.deepcopy(self.preparation), "seed": self.seed,
            "first_codebook_tokens": list(self.first_tokens), "codec_frames": self.codec_frames,
            "codec_sha256": self.codec_hash.hexdigest(), "codec_hash_format": "int64_little_endian_rows_T_by_16",
            "codec_chunks": copy.deepcopy(self.codec_trace), "pcm_chunks": copy.deepcopy(self.pcm_trace),
            "codec_source_exhausted": self.codec_source_exhausted,
            "terminal_first_codebook_token": terminal, "eos_token_id": eos,
            "ended_on_eos": bool(self.codec_source_exhausted and terminal == eos and not reached_limit),
            "reached_token_limit": reached_limit, "generator_closed": self.closed_at is not None,
            "first_pcm_seconds": self.pcm_trace[0]["producer_elapsed_seconds"] if self.pcm_trace else None,
            "generator_seconds": self.closed_at - self.started if self.closed_at is not None else None,
            "pcm_samples": self.generated_pcm_samples,
            "decode": copy.deepcopy(getattr(self.faster, "last_decode_snapshot", None)),
        }
