"""Place prompt lookups and inactive encoders in RAM when CUDA memory is tight.

Import on the synthesis path only. Acoustic generation, graph buffers, LoRA
merging and the waveform decoder always stay on the selected CUDA device.
"""
import gc
import torch


# RC5 used 5.42 GiB of process VRAM on the measured Japanese route. Six GiB is
# a preference between two loaders; both still attempt to run below that value.
FULL_GPU_BUDGET = 6 * 1024**3


def is_cuda_oom(error):
    if isinstance(error, torch.OutOfMemoryError):
        return "DefaultCPUAllocator" not in str(error)
    msg = str(error).lower()
    return isinstance(error, RuntimeError) and any(reason in msg for reason in (
        "cuda out of memory", "cuda error: out of memory", "cuda_error_out_of_memory", "cublas_status_alloc_failed",
    ))


def load_adaptively(device, build, *, prefer_ram=False):
    """Retry only a failed, unpublished model construction, after its frames unwind."""
    free, total = torch.cuda.mem_get_info(device)
    cap = int(torch.cuda.get_per_process_memory_fraction(device) * total)
    available = min(free, max(0, cap - torch.cuda.memory_allocated(device)))
    modes = ("cpu_lookup",) if prefer_ram or available < FULL_GPU_BUDGET else ("cuda", "cpu_lookup")
    for mode in modes:
        try:
            return build(mode, available), mode
        except RuntimeError as error:
            if not is_cuda_oom(error):
                raise
            detail = str(error)
        # Keeping an exception (or its traceback) alive here retains failed weights.
        gc.collect()
        torch.cuda.empty_cache()
    raise torch.OutOfMemoryError("GPU 显存不足以运行声学生成，内存协同加载也未成功。 " + detail)


class _HostTextEmbedding(torch.nn.Embedding):
    """Gather only the requested vocabulary rows on CPU, once per prompt fragment."""
    def forward(self, ids):
        return super().forward(ids.to(self.weight.device)).to(ids.device)


def load_qwen(path, device, attention, mode, *, precomputed_reference):
    from qwen_tts import Qwen3TTSModel
    base = Qwen3TTSModel.from_pretrained(
        str(path), device_map="cpu" if mode == "cpu_lookup" else device,
        torch_dtype=torch.bfloat16, attn_implementation=attention, local_files_only=True,
    )
    if mode != "cpu_lookup":
        return base

    core = base.model
    talker, body = core.talker, core.talker.model
    # These two containers have only child modules in the pinned Qwen backend.
    # Do not accidentally leave new root-level buffers on a different device.
    if any(next(m.parameters(recurse=False), None) is not None or next(m.buffers(recurse=False), None) is not None
           for m in (talker, body)):
        raise ValueError("Unsupported Qwen talker layout for CPU text lookup")
    for name, child in talker.named_children():
        if name != "model":
            child.to(device)
    for name, child in body.named_children():
        if name != "text_embedding":
            child.to(device)
    table = body.text_embedding
    if table.weight.device.type != "cpu":
        raise ValueError("Expected CPU-staged text embedding")
    body.text_embedding = _HostTextEmbedding.from_pretrained(
        table.weight.detach(), freeze=True, padding_idx=table.padding_idx, max_norm=table.max_norm,
        norm_type=table.norm_type, scale_grad_by_freq=table.scale_grad_by_freq, sparse=table.sparse,
    )
    codec = core.speech_tokenizer
    if precomputed_reference:
        codec.model.decoder.to(device)
    else:
        # A source install may supply an actual reference WAV and need both encoders.
        codec.model.to(device)
        if core.speaker_encoder is not None:
            core.speaker_encoder.to(device)
    codec.device = torch.device(device)
    base.device = torch.device(device)
    return base


def load_multilingual(path, *, precomputed_reference, prefer_ram=False):
    from faster_qwen3_tts import FasterQwen3TTS
    from faster_qwen3_tts.predictor_graph import PredictorGraph
    from faster_qwen3_tts.talker_graph import TalkerGraph

    device = "cuda:0"
    if not torch.cuda.is_available():
        raise RuntimeError("本地语音合成需要支持 CUDA 的 NVIDIA 显卡。")
    def build(mode, _available):
        if mode == "cuda":
            model = FasterQwen3TTS.from_pretrained(
                str(path), device=device, dtype=torch.bfloat16, backend="torch", quant="BF16", local_files_only=True)
        else:
            base = load_qwen(path, device, "sdpa", mode, precomputed_reference=precomputed_reference)
            talker = base.model.talker
            config = base.model.config.talker_config
            # The same predictor defaults and graph size as FasterQwen 0.3.2.
            predictor = PredictorGraph(talker.code_predictor, talker.code_predictor.model.config, config.hidden_size,
                                       device=device, dtype=torch.bfloat16, do_sample=True, top_k=50, temperature=0.9)
            graph = TalkerGraph(talker.model, config, device=device, dtype=torch.bfloat16, max_seq_len=2048)
            model = FasterQwen3TTS(base, predictor, graph, device=device, dtype=torch.bfloat16, max_seq_len=2048)
        model.warmup(prefill_len=100)
        return model
    return load_adaptively(device, build, prefer_ram=prefer_ram)
