"""轻量延迟埋点，使用 JSONL 记录稳态 p50/p95 的原始样本。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import threading
import time
from datetime import datetime, timezone

from core.app_config import PROJECT_ROOT


class LatencyRecorder:
    def __init__(self):
        self.path = Path(os.environ.get('ASUKA_METRICS_PATH', PROJECT_ROOT / "data" / "metrics" / "latency.jsonl"))
        self._lock = threading.Lock()

    def record(self, stage, duration_ms, **details):
        event = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "stage": str(stage),
            "duration_ms": round(float(duration_ms), 3),
            **details,
        }
        try:
            with self._lock:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with self.path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        except OSError:
            # 埋点不能影响主链路。
            return


latency = LatencyRecorder()


def timer():
    return time.perf_counter()


def elapsed_ms(started_at):
    return (time.perf_counter() - started_at) * 1000.0
