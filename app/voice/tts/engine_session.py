"""Owned-process execution of an already reviewed, isolated voice plan.

This module does not choose a voice, load a model, play sound, or import a
client. Every dispatched request gets one child process and a permanent claim
directory. Existing request IDs are never replayed, even after cancellation.
PCM is transient; the journal contains sizes/hashes, never base64 audio.
"""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import threading
import time

import numpy as np


SCHEMA = "asuka.voice-engine-submission/1"
MAX_SAMPLES = 24_000 * 30
MAX_LINE = MAX_SAMPLES * 4 * 4 // 3 + 8192
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
_PHASES = {"validating", "loading", "ready", "generating", "closing"}


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def _copy(value):
    return json.loads(_json(value))


def _reject_credentials(value):
    """This local engine has no credential input, including in its artifacts."""
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = re.sub(r"[-_\s]", "", key).lower()
            if normalized in {"apikey", "authorization", "password", "secret", "accesstoken", "refreshtoken", "credentials"}:
                raise ValueError("Credentials are not accepted in a local voice submission")
            _reject_credentials(child)
    elif isinstance(value, list):
        for child in value:
            _reject_credentials(child)
    elif isinstance(value, str) and (re.search(r"\bsk-[A-Za-z0-9_-]{8,}\b", value)
                                    or re.search(r"(?i)authorization\s*[:=]\s*bearer\s+\S+", value)):
        raise ValueError("Credentials are not accepted in a local voice submission")


def _now():
    return datetime.now(timezone.utc).isoformat()


def _redact(value):
    text = str(value)
    text = re.sub(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+", r"\1[REDACTED]", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "[REDACTED]", text)
    text = re.sub(r"(?i)((?:api[_-]?key|access[_-]?token|password|secret)\s*[\"']?\s*[:=]\s*[\"']?)[^\s,;\"']+", r"\1[REDACTED]", text)
    return text[:8192]


def _timeout(value, *, optional=False):
    if optional and value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError("timeout must be finite and nonnegative")
    return float(value)


def _atomic(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        stream.write(_json(value) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


class VoiceEngineSession:
    """One consumer, bounded PCM queue, and one exclusively owned process.

    ``get`` returns dict events and raises TimeoutError without implicitly
    retrying. Chunk events hold an owned float32 ``audio`` array. Cancel stops
    publication immediately and confirms process exit before reporting success.
    Already delivered audio belongs to the caller and cannot be recalled here.
    ``recover`` is read-only and never starts or terminates any process.
    """

    def __init__(self, submission, worker_command, artifact_root, max_chunks=2,
                 termination_timeout=3):
        submission = _copy(submission)
        if (not isinstance(submission, dict) or submission.get("schema") != SCHEMA
                or set(submission) != {"schema", "request_id", "plan", "config"}
                or not isinstance(submission["request_id"], str)
                or not _ID.fullmatch(submission["request_id"])
                or not isinstance(submission["plan"], dict)
                or not isinstance(submission["config"], dict)):
            raise ValueError("Invalid voice engine submission")
        _reject_credentials(submission)
        if (not isinstance(worker_command, (list, tuple)) or not worker_command
                or any(not isinstance(part, str) or not part or "\0" in part for part in worker_command)):
            raise ValueError("worker_command must be a nonempty argv list")
        if isinstance(max_chunks, bool) or not isinstance(max_chunks, int) or max_chunks < 1:
            raise ValueError("max_chunks must be a positive integer")
        self.request_id = submission["request_id"]
        self._submission = submission
        self._command = list(worker_command)
        self.artifact_root = Path(artifact_root).resolve()
        self.artifact_dir = self.artifact_root / self.request_id
        self._max_chunks = max_chunks
        self._termination_timeout = _timeout(termination_timeout)
        self._condition = threading.Condition(threading.RLock())
        self._stop_lock = threading.Lock()
        self._log_lock = threading.Lock()
        self._events = deque()
        self._status = "created"
        self._phase = None
        self._process = None
        self._reader = self._watcher = self._stderr_reader = None
        self._reader_done = threading.Event()
        self._cancelled = False
        self._abort = None
        self._worker_terminal = None
        self._terminal_at = None
        self._terminal = None
        self._terminal_delivered = False
        self._claimed = False
        self._started = time.monotonic()
        self._published = self._delivered = self._discarded = 0
        self._phase_count = 0
        self._next_index = 0
        self._stop_method = None

    def _journal(self, entry):
        if not self._claimed:
            return
        entry = {"utc": _now(), "elapsed_seconds": time.monotonic() - self._started, **entry}
        with self._log_lock:
            with (self.artifact_dir / "events.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(_json(entry) + "\n")
                stream.flush()

    def start(self):
        with self._condition:
            if self._status != "created":
                return self
            self.artifact_root.mkdir(parents=True, exist_ok=True)
            # An exclusive directory is the claim. It is never removed/reused.
            self.artifact_dir.mkdir(exist_ok=False)
            self._claimed = True
            _atomic(self.artifact_dir / "submission.json", self._submission)
            self._started = time.monotonic()
            self._status = "starting"
            self._journal({"type": "submitted", "request_id": self.request_id,
                           "submission_sha256": hashlib.sha256(_json(self._submission).encode()).hexdigest()})
            env = os.environ.copy()
            env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")
            try:
                self._process = subprocess.Popen(
                    [*self._command, "--submission", str(self.artifact_dir / "submission.json")],
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    cwd=str(Path(__file__).resolve().parents[2]), env=env,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                    shell=False,
                )
                self._status = "running"
                self._journal({"type": "spawned", "pid": self._process.pid})
                self._stderr_reader = threading.Thread(target=self._read_stderr, daemon=True)
                self._reader = threading.Thread(target=self._read_stdout, daemon=True)
                self._watcher = threading.Thread(target=self._watch, daemon=True)
                self._stderr_reader.start()
                self._reader.start()
                self._watcher.start()
            except BaseException as exc:
                self._fail("start", type(exc).__name__, str(exc))
                if self._process is not None:
                    self._stop_owned()
                self._finish("failed")
                raise
        return self

    def _fail(self, stage, error_type, message):
        with self._condition:
            if self._abort is None:
                self._abort = {"stage": stage, "type": error_type, "message": _redact(message)}
                self._journal({"type": "error", "error": self._abort})
            self._discarded += sum(event["type"] == "chunk" for event in self._events)
            self._events.clear()
            self._condition.notify_all()

    def _read_stderr(self):
        # Read bounded lines; never retain an unbounded backend debug stream.
        try:
            with (self.artifact_dir / "stderr.log").open("w", encoding="utf-8") as output:
                total = 0
                while line := self._process.stderr.readline(8193):
                    if total < 1024 * 1024:
                        text = _redact(line.decode("utf-8", "replace"))
                        output.write(text)
                        output.flush()
                        total += len(text)
        except Exception as exc:
            self._fail("stderr", type(exc).__name__, str(exc))

    def _read_stdout(self):
        try:
            while line := self._process.stdout.readline(MAX_LINE + 1):
                if self._cancelled:
                    continue
                if len(line) > MAX_LINE or not line.endswith(b"\n"):
                    raise ValueError("Worker protocol line exceeds size limit or is incomplete")
                raw = json.loads(line.decode("utf-8"), parse_constant=lambda x: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
                self._accept(raw)
        except Exception as exc:
            if not self._cancelled:
                self._fail("protocol", type(exc).__name__, str(exc))
        finally:
            self._reader_done.set()

    def _accept(self, raw):
        if not isinstance(raw, dict) or raw.get("request_id") != self.request_id:
            raise ValueError("Worker event request ID mismatch")
        with self._condition:
            if self._cancelled or self._abort:
                return
            if self._worker_terminal is not None:
                raise ValueError("Worker emitted data after its terminal event")
            kind = raw.get("type")
            if kind == "phase":
                if set(raw) != {"type", "request_id", "phase"} or raw["phase"] not in _PHASES:
                    raise ValueError("Invalid worker phase")
                self._phase_count += 1
                if self._phase_count > 128:
                    raise ValueError("Excessive worker phase events")
                self._phase = raw["phase"]
                event = _copy(raw)
                self._journal(event)
                self._events.append(event)
            elif kind == "chunk":
                if set(raw) != {"type", "request_id", "index", "sample_rate", "samples", "pcm_f32le"}:
                    raise ValueError("Invalid PCM event fields")
                if (type(raw["index"]) is not int or raw["index"] != self._next_index
                        or type(raw["sample_rate"]) is not int or raw["sample_rate"] != 24000
                        or type(raw["samples"]) is not int or not 0 < raw["samples"] <= MAX_SAMPLES
                        or not isinstance(raw["pcm_f32le"], str)):
                    raise ValueError("Invalid PCM sequence, rate or size")
                pcm = base64.b64decode(raw["pcm_f32le"], validate=True)
                if len(pcm) != raw["samples"] * 4:
                    raise ValueError("PCM byte length differs from declared samples")
                audio = np.frombuffer(pcm, dtype="<f4").astype(np.float32, copy=True)
                if not np.isfinite(audio).all():
                    raise ValueError("PCM contains nonfinite values")
                while sum(e["type"] == "chunk" for e in self._events) >= self._max_chunks and not self._cancelled and not self._abort:
                    self._condition.wait()
                if self._cancelled or self._abort:
                    self._discarded += 1
                    return
                metadata = {key: value for key, value in raw.items() if key != "pcm_f32le"}
                metadata["pcm_sha256"] = hashlib.sha256(pcm).hexdigest()
                self._journal(metadata)
                self._events.append({**metadata, "audio": audio})
                self._published += 1
                self._next_index += 1
            elif kind == "terminal":
                if (set(raw) - {"type", "request_id", "status", "eos", "truncated", "cleanup_complete", "error"}
                        or raw.get("status") not in {"completed", "failed"}
                        or any(type(raw.get(k)) is not bool for k in ("eos", "truncated", "cleanup_complete"))):
                    raise ValueError("Invalid terminal event")
                self._worker_terminal = _copy(raw)
                if "error" in self._worker_terminal:
                    self._worker_terminal["error"] = _redact(_json(raw["error"]))
                self._terminal_at = time.monotonic()
                self._journal({"type": "worker_terminal", "value": self._worker_terminal})
            else:
                raise ValueError("Unknown worker event type")
            self._condition.notify_all()

    def _stop_owned(self):
        with self._stop_lock:
            process = self._process
            if process is None or process.poll() is not None:
                return True
            try:
                self._stop_method = "terminate"
                process.terminate()
                process.wait(timeout=self._termination_timeout)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    self._stop_method = "kill"
                    process.kill()
                    process.wait(timeout=self._termination_timeout)
                except (OSError, subprocess.TimeoutExpired) as exc:
                    self._fail("stop", type(exc).__name__, str(exc))
            return process.poll() is not None

    def _watch(self):
        try:
            while self._process.poll() is None:
                if self._cancelled or self._abort:
                    if not self._stop_owned():
                        self._finish("failed")
                        return
                elif self._terminal_at is not None and time.monotonic() - self._terminal_at > self._termination_timeout:
                    self._fail("exit", "TimeoutError", "Worker did not exit after its terminal event")
                    self._stop_owned()
                time.sleep(.01)
            # Drain stdout even if the process exited before the reader ran.
            while not self._reader_done.wait(.02):
                if self._cancelled or self._abort:
                    with self._condition:
                        self._condition.notify_all()
            if self._stderr_reader is not None:
                self._stderr_reader.join(timeout=1)
            with self._condition:
                terminal = self._worker_terminal
                if not self._cancelled and not self._abort:
                    if self._process.returncode != 0:
                        self._fail("exit", "WorkerExit", f"Worker exited with code {self._process.returncode}")
                    elif terminal is None:
                        self._fail("completion", "MissingTerminal", "Worker exited without a terminal event")
                    elif (terminal["status"] != "completed" or not terminal["eos"] or terminal["truncated"]
                          or not terminal["cleanup_complete"] or terminal.get("error")):
                        self._fail("completion", "IncompleteGeneration", terminal.get("error") or "EOS or cleanup requirements failed")
                    elif self._published == 0:
                        self._fail("completion", "EmptyGeneration", "Worker returned no PCM")
                # The terminal follows consumed chunks; cancellation may discard them.
                while self._events and not self._cancelled and not self._abort:
                    self._condition.wait()
                self._finish("failed" if self._abort else "cancelled" if self._cancelled else "completed")
        except Exception as exc:
            self._fail("monitor", type(exc).__name__, str(exc))
            self._stop_owned()
            self._finish("failed")
        finally:
            for stream in (self._process.stdout, self._process.stderr):
                try:
                    stream.close()
                except OSError:
                    pass

    def _finish(self, status):
        with self._condition:
            if self._terminal is not None:
                return
            alive = self._process is not None and self._process.poll() is None
            if alive:
                status = "failed"
            self._status = status
            self._terminal = {"type": "terminal", "request_id": self.request_id, "status": status,
                              "worker_alive": alive, "worker_exit_code": None if self._process is None else self._process.poll(),
                              "stop_method": self._stop_method, "error": _copy(self._abort),
                              "worker_result": _copy(self._worker_terminal)}
            self._journal(self._terminal)
            if self._claimed:
                _atomic(self.artifact_dir / "result.json", {**self._terminal, "finished_utc": _now(),
                                                          "snapshot": self.snapshot()})
            self._condition.notify_all()

    def get(self, timeout=None):
        timeout = _timeout(timeout, optional=True)
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._condition:
            if self._status == "created":
                raise RuntimeError("start() must be called before get()")
            while True:
                if self._terminal_delivered:
                    return None
                if self._events and not self._cancelled and not self._abort:
                    event = self._events.popleft()
                    if event["type"] == "chunk":
                        self._delivered += 1
                    self._condition.notify_all()
                    return event
                if self._terminal is not None:
                    self._terminal_delivered = True
                    return _copy(self._terminal)
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    raise TimeoutError("No voice engine event within timeout")
                self._condition.wait(remaining)

    def iter_events(self, timeout=None):
        while (event := self.get(timeout)) is not None:
            yield event
            if event["type"] == "terminal":
                return

    def cancel(self):
        with self._condition:
            if self._terminal is not None or self._cancelled:
                return False
            self._cancelled = True
            self._status = "cancelling"
            self._discarded += sum(e["type"] == "chunk" for e in self._events)
            self._events.clear()
            self._journal({"type": "cancel_requested", "request_id": self.request_id})
            self._condition.notify_all()
        stopped = self._stop_owned()
        if self._process is None:
            self._finish("cancelled")
        elif not stopped:
            self._finish("failed")
        return True

    def close(self):
        self.cancel()
        watcher = self._watcher
        if watcher is not None and watcher is not threading.current_thread():
            watcher.join(timeout=2 * self._termination_timeout + 2)
        return not self.snapshot()["worker_alive"] and (watcher is None or not watcher.is_alive())

    def snapshot(self):
        with self._condition:
            return {"request_id": self.request_id, "status": self._status, "phase": self._phase,
                    "pid": None if self._process is None else self._process.pid,
                    "worker_alive": self._process is not None and self._process.poll() is None,
                    "artifact_dir": str(self.artifact_dir), "claimed": self._claimed,
                    "queue_chunks": sum(e["type"] == "chunk" for e in self._events),
                    "queue_capacity": self._max_chunks, "published_chunks": self._published,
                    "delivered_chunks": self._delivered, "discarded_chunks": self._discarded,
                    "cancel_requested": self._cancelled, "terminal_delivered": self._terminal_delivered,
                    "stop_method": self._stop_method, "error": _copy(self._abort)}

    @classmethod
    def recover(cls, artifact_root):
        """List persisted results only; an unfinished claim may still be active.

        Never infer ownership from a saved PID, modify an unfinished record, or
        start a worker. Callers must use a new request ID for a deliberate retry.
        """
        root = Path(artifact_root).resolve()
        records = []
        if not root.exists():
            return records
        for directory in sorted(root.iterdir()):
            if not directory.is_dir() or directory.is_symlink():
                continue
            record = {"request_id": directory.name, "artifact_dir": str(directory), "automatic_replay": False}
            try:
                result_path = directory / "result.json"
                if result_path.is_file():
                    record["result"] = json.loads(result_path.read_text(encoding="utf-8"))
                    record["status"] = record["result"]["status"]
                else:
                    record["status"] = "interrupted_or_active_unknown"
            except (OSError, ValueError, KeyError, TypeError):
                record["status"] = "unreadable"
            records.append(record)
        return records

