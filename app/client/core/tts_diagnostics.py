"""TTS 异常样本的滚动缓存、标注和报告固化。"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import threading
import wave
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import numpy as np

from core.app_config import PROJECT_ROOT


ROOT = Path(os.environ.get("ASUKA_TTS_DIAGNOSTICS_DIR", PROJECT_ROOT / "data" / "tts_diagnostics"))
PENDING_DIR = ROOT / "pending"
REPORTS_DIR = ROOT / "reports"
MAX_PENDING = 30


def _json_safe(value, depth=0):
    if depth > 5:
        return str(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, dict):
        return {
            str(key): _json_safe(item, depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_json_safe(item, depth + 1) for item in value]
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return {
            "shape": list(value.shape),
            "dtype": str(value.dtype),
        }
    return str(value)


class TTSDiagnostics:
    def __init__(self):
        self._lock = threading.Lock()

    def capture(self, audio_chunks, sample_rate, metadata):
        """保存一条未标注的滚动样本，返回可挂到聊天气泡的描述。"""
        if not audio_chunks:
            return None
        audio = np.ascontiguousarray(
            np.concatenate(audio_chunks), dtype=np.float32)
        if not audio.size:
            return None
        now = datetime.now(timezone.utc)
        sample_id = f"{now.strftime('%Y%m%dT%H%M%S')}-{uuid4().hex[:8]}"
        folder = PENDING_DIR / sample_id
        try:
            with self._lock:
                folder.mkdir(parents=True, exist_ok=False)
                self._write_wav(folder / "audio.wav", audio, sample_rate)
                finite_audio = np.nan_to_num(
                    audio, nan=0.0, posinf=1.0, neginf=-1.0)
                payload = {
                    "schema_version": 1,
                    "sample_id": sample_id,
                    "captured_at": now.isoformat(),
                    "sample_rate": int(sample_rate),
                    "sample_count": int(audio.size),
                    "audio_duration_ms": round(
                        audio.size / float(sample_rate) * 1000.0, 3),
                    "audio_stats": {
                        "peak": round(float(np.max(np.abs(finite_audio))), 7),
                        "rms": round(float(
                            np.sqrt(np.mean(finite_audio ** 2))), 7),
                        "nan_count": int(np.isnan(audio).sum()),
                        "inf_count": int(np.isinf(audio).sum()),
                    },
                    **_json_safe(metadata),
                }
                (folder / "metadata.json").write_text(
                    json.dumps(payload, ensure_ascii=False, indent=2),
                    encoding="utf-8")
                self._prune_pending()
            return {
                "sample_id": sample_id,
                "folder": str(folder),
                "metadata": payload,
            }
        except (OSError, ValueError) as exc:
            print(f"[TTS诊断] 样本缓存失败: {exc}")
            return None

    def annotate(self, sample_id, categories, note=""):
        """把滚动样本提升为异常报告，并写入人工标注。"""
        sample_id = str(sample_id or "").strip()
        if not re.fullmatch(r"\d{8}T\d{6}-[a-f0-9]{8}", sample_id):
            raise ValueError("无效的样本编号")
        with self._lock:
            pending = PENDING_DIR / sample_id
            report = REPORTS_DIR / sample_id
            REPORTS_DIR.mkdir(parents=True, exist_ok=True)
            if pending.exists() and not report.exists():
                pending.replace(report)
            if not report.exists():
                raise FileNotFoundError("该临时样本已过期或不存在")
            annotation = {
                "sample_id": sample_id,
                "annotated_at": datetime.now(timezone.utc).isoformat(),
                "categories": [str(item) for item in categories if str(item)],
                "note": str(note).strip(),
            }
            (report / "annotation.json").write_text(
                json.dumps(annotation, ensure_ascii=False, indent=2),
                encoding="utf-8")
            return str(report)

    def list_unreviewed(self):
        """返回已有人工标注但尚无 review.json 的报告，按时间排序。"""
        reports = []
        if not REPORTS_DIR.exists():
            return reports
        for folder in sorted(path for path in REPORTS_DIR.iterdir()
                             if path.is_dir()):
            if not (folder / "annotation.json").exists():
                continue
            if (folder / "review.json").exists():
                continue
            reports.append({
                "sample_id": folder.name,
                "folder": str(folder),
            })
        return reports

    @staticmethod
    def _write_wav(path, audio, sample_rate):
        pcm = np.asarray(
            np.clip(np.nan_to_num(audio), -1.0, 1.0) * 32767.0,
            dtype="<i2")
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(int(sample_rate))
            handle.writeframes(pcm.tobytes())

    @staticmethod
    def _prune_pending():
        folders = sorted(
            (path for path in PENDING_DIR.iterdir() if path.is_dir()),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        for old in folders[MAX_PENDING:]:
            shutil.rmtree(old, ignore_errors=True)


tts_diagnostics = TTSDiagnostics()
