"""常驻 ASR 子进程的通用 UTF-8 JSONL 客户端。"""
from __future__ import annotations

import base64
import json
import os
import queue
import subprocess
import threading
import time
from pathlib import Path

import numpy as np

from core.app_config import PROJECT_ROOT


class ASRWorkerClient:
    """串行访问一个模型常驻 worker，并在 close 时等待进程退出。"""

    def __init__(self, backend_name, python_path, model_path, worker_path,
                 model_env, log_filename, timeout=180, extra_env=None):
        self.backend_name = str(backend_name)
        self.python_path = Path(python_path)
        self.model_path = Path(model_path)
        self.worker_path = Path(worker_path)
        if self.worker_path.suffix == ".py" and not self.worker_path.is_file() and self.worker_path.with_suffix(".pyc").is_file():
            self.worker_path = self.worker_path.with_suffix(".pyc")
        self.model_env = str(model_env)
        self.extra_env = {
            str(key): str(value) for key, value in (extra_env or {}).items()
        }
        self.timeout = float(timeout)
        self.process = None
        self._responses = queue.Queue()
        self._reader = None
        self._lock = threading.Lock()
        self._request_id = 0
        self._log_handle = None
        self.log_path = PROJECT_ROOT / "data" / "logs" / log_filename

    @property
    def is_available(self):
        return (self.python_path.is_file() and self.model_path.is_dir()
                and self.worker_path.is_file())

    @property
    def is_running(self):
        return self.process is not None and self.process.poll() is None

    def availability_error(self):
        if not self.python_path.is_file():
            return f"找不到 {self.backend_name} Python：{self.python_path}"
        if not self.model_path.is_dir():
            return f"找不到 {self.backend_name} 模型：{self.model_path}"
        if not self.worker_path.is_file():
            return f"找不到 {self.backend_name} worker：{self.worker_path}"
        return ""

    def _start(self):
        if self.is_running:
            return
        if not self.is_available:
            raise RuntimeError(self.availability_error())
        self.close()
        responses = queue.Queue()
        self._responses = responses
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log_handle = self.log_path.open(
            "a", encoding="utf-8", errors="replace")
        env = os.environ.copy()
        env[self.model_env] = str(self.model_path)
        env.update(self.extra_env)
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        creationflags = (
            subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        self.process = subprocess.Popen(
            [str(self.python_path), "-u", str(self.worker_path)],
            cwd=str(PROJECT_ROOT), stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=self._log_handle,
            text=True, encoding="utf-8", errors="replace",
            bufsize=1, env=env, creationflags=creationflags,
        )
        process = self.process

        def read_responses():
            try:
                for line in process.stdout:
                    try:
                        responses.put(json.loads(line))
                    except (ValueError, TypeError):
                        continue
            finally:
                responses.put({
                    "error": f"{self.backend_name} worker 已退出",
                    "worker_exit": True,
                })

        self._reader = threading.Thread(target=read_responses, daemon=True)
        self._reader.start()

    def transcribe(self, audio, sample_rate=16000, language=None):
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)
        if not audio.size:
            return {"text": "", "language": ""}
        with self._lock:
            response = self._exchange({
                "sample_rate": int(sample_rate),
                "language": language,
                "audio": base64.b64encode(audio.tobytes()).decode("ascii"),
            })
        return {
            "text": str(response.get("text") or "").strip(),
            "language": str(response.get("language") or "").strip(),
        }

    def warmup(self):
        with self._lock:
            self._exchange({"action": "warmup"})

    def _exchange(self, payload):
        self._start()
        self._request_id += 1
        request_id = self._request_id
        payload = dict(payload)
        payload["id"] = request_id
        try:
            self.process.stdin.write(
                json.dumps(payload, ensure_ascii=False) + "\n")
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            self.close()
            raise RuntimeError(
                f"{self.backend_name} worker 通信失败") from exc

        deadline = time.monotonic() + self.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.close()
                raise TimeoutError(f"{self.backend_name} 请求超时")
            try:
                response = self._responses.get(timeout=remaining)
            except queue.Empty as exc:
                self.close()
                raise TimeoutError(f"{self.backend_name} 请求超时") from exc
            if response.get("worker_exit"):
                self.close()
                raise RuntimeError(response["error"])
            if response.get("id") != request_id:
                continue
            if response.get("error"):
                raise RuntimeError(str(response["error"]))
            return response

    def close(self):
        process = self.process
        self.process = None
        reader = self._reader
        self._reader = None
        if process is not None and process.stdin is not None:
            try:
                process.stdin.close()
            except OSError:
                pass
        if process is not None and process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    process.kill()
                    process.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    pass
        if (reader is not None and reader is not threading.current_thread()
                and reader.is_alive()):
            reader.join(timeout=1)
        if process is not None and process.stdout is not None:
            try:
                process.stdout.close()
            except OSError:
                pass
        if self._log_handle is not None:
            try:
                self._log_handle.close()
            except OSError:
                pass
            self._log_handle = None
