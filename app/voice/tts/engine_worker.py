"""One-shot JSONL worker for the isolated voice engine (never a client entry)."""
from __future__ import annotations

import argparse
import base64
from contextlib import redirect_stdout
import json
import os
from pathlib import Path
import re
import sys
import time


def _error(exc):
    message = str(exc)
    message = re.sub(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+", r"\1[REDACTED]", message)
    message = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}\b", "[REDACTED]", message)
    message = re.sub(r"(?i)((?:api[_-]?key|access[_-]?token|password|secret)\s*[\"']?\s*[:=]\s*[\"']?)[^\s,;\"']+", r"\1[REDACTED]", message)
    return {"type": type(exc).__name__, "message": message[:4096]}


def run_submission(submission, emit, *, validator=None, loader=None,
                   reference_loader=None, observer_factory=None, result_writer=None):
    """Validate before model import; emit a single terminal after owned cleanup.

    Dependency injection is only for CPU contract tests. The CLI always uses
    the normal engine validation, reference bank and real CUDA backend.
    """
    request_id = submission.get("request_id", "invalid") if isinstance(submission, dict) else "invalid"
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", request_id):
        request_id = "invalid"
    started = time.perf_counter()
    loaded = observer = iterator = prompt = None
    failure = None
    cleanup_complete = True
    observation = {}
    identity = {}
    reference_counts = {}
    next_index = 0

    def send(kind, **fields):
        emit({"type": kind, "request_id": request_id, **fields})

    try:
        send("phase", phase="validating")
        if validator is None:
            from .engine import validate_submission
            validator = validate_submission
        validator(submission)
        # No model/Torch code is imported until provenance and all execution
        # parameters have passed the same validation as the parent planner.
        if loader is None or observer_factory is None:
            from .engine_backend import load_backend, ObservedStream
            loader = loader or load_backend
            observer_factory = observer_factory or ObservedStream
        if reference_loader is None:
            from .engine import load_plan_reference
            reference_loader = load_plan_reference
        config, plan = submission["config"], submission["plan"]
        route = plan["route_plan"]
        send("phase", phase="loading")
        loaded = loader(config, route)
        identity = loaded.identity
        reference_counts = loaded.reference_counts
        prompt = reference_loader(submission) if route["backend"] == "base_clone" else None
        send("phase", phase="ready")
        observer = observer_factory(loaded.faster, config, route, plan["seed"], prompt)
        iterator = iter(observer)
        send("phase", phase="generating")
        for wave, sample_rate, timing in iterator:
            import numpy as np
            audio = np.asarray(wave, dtype="<f4")
            if (audio.ndim != 1 or not 0 < audio.size <= 24_000 * 30
                    or not np.isfinite(audio).all() or np.any(np.abs(audio) > 1)
                    or isinstance(sample_rate, bool) or sample_rate != 24000):
                raise ValueError("Worker received invalid PCM or sample rate")
            send("chunk", index=next_index, sample_rate=int(sample_rate), samples=int(audio.size),
                 pcm_f32le=base64.b64encode(audio.tobytes(order="C")).decode("ascii"))
            next_index += 1
        observation = observer.result()
        if not observation.get("ended_on_eos") or observation.get("reached_token_limit"):
            raise RuntimeError("Generation ended without verified natural EOS")
        if not next_index:
            raise RuntimeError("Generation produced no audio")
        if any(reference_counts.values()):
            raise RuntimeError("Generation unexpectedly extracted a reference")
    except Exception as exc:
        failure = _error(exc)
    finally:
        send("phase", phase="closing")
        try:
            if iterator is not None:
                iterator.close()
        except Exception as exc:
            cleanup_complete = False
            failure = failure or _error(exc)
        try:
            if observer is not None:
                observation = observer.result()
                if observation.get("generator_closed") is not True:
                    cleanup_complete = False
                    failure = failure or {"type": "CleanupError", "message": "Generator closure was not confirmed by the final observation"}
        except Exception as exc:
            cleanup_complete = False
            failure = failure or _error(exc)
        # Observers retain the proxy. Drop them before freeing the loaded owner.
        iterator = observer = prompt = None
        try:
            if loaded is not None:
                loaded.close()
                cleanup_complete = cleanup_complete and loaded.closed
        except Exception as exc:
            cleanup_complete = False
            failure = failure or _error(exc)
        loaded = None
        # A failed load has no owner to close. Reclaim partial allocations if
        # Torch was imported; do not import it on rejected submissions.
        if not identity and "torch" in sys.modules:
            try:
                import gc
                gc.collect()
                torch = sys.modules["torch"]
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception as exc:
                cleanup_complete = False
                failure = failure or _error(exc)
    if not cleanup_complete and failure is None:
        failure = {"type": "CleanupError", "message": "Worker cleanup did not complete"}
    terminal = {
        "status": "failed" if failure else "completed",
        "eos": bool(observation.get("ended_on_eos", False)),
        "truncated": bool(observation.get("reached_token_limit", False)),
        "cleanup_complete": bool(cleanup_complete),
    }
    if failure:
        terminal["error"] = failure
    if result_writer is not None:
        try:
            result_writer({"schema": "asuka.voice-engine-backend-result/1", "request_id": request_id,
                           **terminal, "identity": identity, "observation": observation,
                           "reference_extraction_counts": reference_counts,
                           "chunks": next_index, "worker_seconds": time.perf_counter() - started})
        except Exception as exc:
            failure = _error(exc)
            terminal.update(status="failed", error=failure)
    send("terminal", **terminal)
    return 1 if failure else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--submission", required=True)
    args = parser.parse_args(argv)
    result_path = Path(args.submission).resolve().parent / "backend-result.json"
    protocol = sys.stdout

    def emit(message):
        protocol.write(json.dumps(message, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n")
        protocol.flush()

    def save_result(value):
        if result_path.exists():
            raise FileExistsError("Backend result already exists; refusing to overwrite execution evidence")
        temporary = result_path.with_suffix(".json.tmp")
        with temporary.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        if result_path.exists():
            raise FileExistsError("Backend result appeared during execution; refusing to overwrite")
        os.replace(temporary, result_path)

    try:
        raw = Path(args.submission).read_bytes()
        if len(raw) > 16 * 1024 * 1024:
            raise ValueError("Submission exceeds 16 MiB")
        submission = json.loads(raw.decode("utf-8"))
        if result_path.exists() or result_path.with_suffix(".json.tmp").exists():
            raise FileExistsError("Execution evidence already exists; refusing to replay this worker")
    except Exception as exc:
        emit({"type": "terminal", "request_id": "invalid", "status": "failed",
              "eos": False, "truncated": False, "cleanup_complete": True, "error": _error(exc)})
        return 1
    # Python diagnostics emitted by model libraries must never enter JSONL.
    with redirect_stdout(sys.stderr):
        return run_submission(submission, emit, result_writer=save_result)


if __name__ == "__main__":
    if __package__ in {None, ""}:
        sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
        __package__ = "voice.tts"
    raise SystemExit(main())
