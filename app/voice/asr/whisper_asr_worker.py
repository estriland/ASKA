"""faster-whisper 隔离 worker；stdout 只传输 UTF-8 JSONL。"""
from __future__ import annotations

import base64
import json
import os
import sys

import numpy as np


LANGUAGES = {
    "zh": "zh", "ja": "ja", "en": "en",
    "mixed": None, "auto": None, "": None,
}
_model = None
_device = "cuda"


def _load_model():
    global _model, _device
    if _model is not None:
        return _model
    from faster_whisper import WhisperModel

    model_path = os.environ.get("ASUKA_WHISPER_MODEL", "").strip()
    if not model_path:
        raise RuntimeError("未配置 ASUKA_WHISPER_MODEL")
    _device = os.environ.get("ASUKA_WHISPER_DEVICE", "cuda").strip()
    compute_type = os.environ.get(
        "ASUKA_WHISPER_COMPUTE_TYPE", "float16").strip()
    try:
        cpu_threads = max(1, int(os.environ.get(
            "ASUKA_WHISPER_CPU_THREADS", "4")))
    except ValueError:
        cpu_threads = 4
    print(
        f"[Whisper] loading {model_path} "
        f"device={_device} compute={compute_type} threads={cpu_threads}",
        file=sys.stderr, flush=True)
    _model = WhisperModel(
        model_path, device=_device, compute_type=compute_type,
        cpu_threads=cpu_threads, num_workers=1)
    print("[Whisper] ready", file=sys.stderr, flush=True)
    return _model


def transcribe_request(value):
    request_id = value.get("id")
    if value.get("action") == "warmup":
        _load_model()
        return {"id": request_id, "ready": True}
    raw = base64.b64decode(str(value.get("audio") or ""), validate=True)
    audio = np.frombuffer(raw, dtype=np.float32).copy()
    if not audio.size:
        return {"id": request_id, "text": "", "language": ""}
    language_code = str(value.get("language") or "mixed").lower()
    if language_code not in LANGUAGES:
        raise ValueError(f"不支持的语言选项：{language_code}")
    language = LANGUAGES[language_code]
    segments, info = _load_model().transcribe(
        audio,
        language=language,
        task="transcribe",
        beam_size=3 if _device == "cpu" else 5,
        vad_filter=False,
        condition_on_previous_text=False,
        no_speech_threshold=0.6,
        multilingual=language is None,
    )
    return {
        "id": request_id,
        "text": "".join(segment.text for segment in segments).strip(),
        "language": str(getattr(info, "language", "") or "").strip(),
    }


def main():
    for line in sys.stdin:
        request_id = None
        try:
            value = json.loads(line)
            request_id = value.get("id")
            response = transcribe_request(value)
        except Exception as exc:
            print(f"[Whisper] {exc}", file=sys.stderr, flush=True)
            response = {"id": request_id, "error": str(exc)}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
