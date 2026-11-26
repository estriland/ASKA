"""Qwen3-ASR 隔离 worker。

stdout 只输出一行一个 JSON 响应；模型日志全部进入 stderr，由客户端落盘。
"""
from __future__ import annotations

import base64
import json
import os
import sys

import numpy as np


LANGUAGE_NAMES = {
    "zh": "Chinese",
    "ja": "Japanese",
    "en": "English",
    "mixed": None,
    "auto": None,
    "": None,
}
_model = None


def _load_model():
    global _model
    if _model is not None:
        return _model
    import torch
    from qwen_asr import Qwen3ASRModel

    model_path = os.environ.get("ASUKA_QWEN_ASR_MODEL", "").strip()
    if not model_path:
        raise RuntimeError("未配置 ASUKA_QWEN_ASR_MODEL")
    print(f"[Qwen3-ASR] loading {model_path}", file=sys.stderr, flush=True)
    _model = Qwen3ASRModel.from_pretrained(
        model_path,
        dtype=torch.bfloat16,
        device_map="cuda:0",
        max_inference_batch_size=1,
        max_new_tokens=256,
    )
    print("[Qwen3-ASR] ready", file=sys.stderr, flush=True)
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
    sample_rate = int(value.get("sample_rate") or 16000)
    language_code = str(value.get("language") or "mixed").lower()
    if language_code not in LANGUAGE_NAMES:
        raise ValueError(f"不支持的语言选项：{language_code}")
    result = _load_model().transcribe(
        audio=(audio, sample_rate),
        language=LANGUAGE_NAMES[language_code],
    )[0]
    return {
        "id": request_id,
        "text": str(result.text or "").strip(),
        # 混合语句可以返回 Chinese,English 等组合。
        "language": str(result.language or "").strip(),
    }


def main():
    for line in sys.stdin:
        request_id = None
        try:
            value = json.loads(line)
            request_id = value.get("id")
            response = transcribe_request(value)
        except Exception as exc:
            print(f"[Qwen3-ASR] {exc}", file=sys.stderr, flush=True)
            response = {"id": request_id, "error": str(exc)}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
