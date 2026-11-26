"""Manual, scope-local voice choices for the isolated reference candidate path.

A selection is a user preference, not personality evidence or permission to use
an experimental reference. Planning preserves the caller's purpose and evidence
and rejects a whole batch if the adapter would silently change the chosen voice.
No model, tensor runtime, production settings or remote service is loaded here.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any

try:
    from .reference_candidate import CandidateVoiceAdapter, CandidateVoiceError
except ImportError:
    from reference_candidate import CandidateVoiceAdapter, CandidateVoiceError


PRESETS_SCHEMA = "asuka.manual-voice-presets/1"
SELECTION_SCHEMA = "asuka.manual-voice-selection/1"
STORE_SCHEMA = "asuka.manual-voice-selection-store/1"
BATCH_SCHEMA = "asuka.manual-voice-batch/1"
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
_PROFILES = {"natural": "ordinary", "youthful": "general_a", "soft_close": "gentle_close"}


class VoicePresetError(ValueError):
    """An invalid choice/request; HTTP callers may return status 400."""

    def __init__(self, message: str, *, code: str = "invalid_request"):
        super().__init__(message)
        self.code = code


class VoicePresetConflict(VoicePresetError):
    """Stale selection or changed sources; HTTP callers may return status 409."""

    def __init__(self, message: str, *, code: str, current: dict | None = None):
        super().__init__(message, code=code)
        self._current = _copy(current)

    @property
    def current(self) -> dict | None:
        return _copy(self._current)


def _json(value: Any) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise VoicePresetError("Expected finite JSON data") from exc


def _copy(value: Any) -> Any:
    return json.loads(_json(value))


def _sha(value: Any) -> str:
    return hashlib.sha256(_json(value)).hexdigest()


def _identifier(value: Any, field: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise VoicePresetError(f"{field} must be a simple local identifier")
    return value


def _fields(value: Any, names: set[str], field: str) -> None:
    if not isinstance(value, dict) or set(value) != names:
        raise VoicePresetError(f"Invalid {field} fields")


class VoicePresetController:
    """Persist one explicit choice per scope and freeze it once per batch.

    ``get_selection`` does not create a default record. ``select`` requires an
    expected revision and a unique mutation ID; an exact repeat returns its
    original result even after later changes. The one-file journal is replaced
    atomically under an exclusive local lock. Changed configurations are reported
    with the previous selection attached; they never reset it to the default.
    This store belongs to the caller's preview/candidate scope, not the original
    client's voice configuration.
    """

    def __init__(self, catalog: dict, presets: dict, store_root: str | Path):
        self._catalog = _copy(catalog)
        self._presets = _copy(presets)
        try:
            self._adapter = CandidateVoiceAdapter(self._catalog)
        except CandidateVoiceError as exc:
            raise VoicePresetError(str(exc), code="invalid_catalog") from exc
        _fields(self._presets, {"schema", "default_preset", "presets"}, "presets")
        if self._presets["schema"] != PRESETS_SCHEMA or self._presets["default_preset"] != "natural":
            raise VoicePresetError("Expected manual presets with natural as the default")
        entries = self._presets["presets"]
        if not isinstance(entries, dict) or set(entries) != set(_PROFILES):
            raise VoicePresetError("Expected natural, youthful and soft_close presets only")
        for preset_id, profile_id in _PROFILES.items():
            entry = entries[preset_id]
            _fields(entry, {"label", "profile_id", "description", "scope_note"}, "preset")
            if entry["profile_id"] != profile_id or profile_id not in self._catalog["profiles"]:
                raise VoicePresetError("Preset profile is missing or does not match its defined route")
            if any(not isinstance(entry[key], str) or not entry[key].strip()
                   for key in ("label", "description", "scope_note")):
                raise VoicePresetError("Preset reading labels and scope notes must be nonempty")
        self._catalog_sha256 = _sha(self._catalog)
        self._presets_sha256 = _sha(self._presets)
        self._root = Path(store_root).expanduser().resolve()
        if self._root.exists() and not self._root.is_dir():
            raise VoicePresetError("store_root must be a directory")

    def list_presets(self) -> list[dict]:
        return [{"preset_id": key, **_copy(self._presets["presets"][key]),
                 "experimental": key != "natural"} for key in _PROFILES]

    def _path(self, scope_id: str, suffix: str = ".json") -> Path:
        _identifier(scope_id, "scope_id")
        name = hashlib.sha256(scope_id.encode("utf-8")).hexdigest() + suffix
        path = self._root / name
        # Reject a replaced root or an existing link before reading or writing.
        if self._root.resolve() != self._root or path.resolve().parent != self._root or path.is_symlink():
            raise VoicePresetError("Selection path escapes store_root", code="unsafe_path")
        return path

    def _default(self, scope_id: str) -> dict:
        return {"schema": SELECTION_SCHEMA, "scope_id": scope_id,
                "preset_id": "natural", "profile_id": "ordinary", "revision": 0,
                "persisted": False, "catalog_sha256": self._catalog_sha256,
                "presets_sha256": self._presets_sha256, "updated_at": None, "mutation_id": None}

    def _read(self, scope_id: str) -> dict:
        path = self._path(scope_id)
        if not path.exists():
            return {"schema": STORE_SCHEMA, "scope_id": scope_id,
                    "catalog_sha256": self._catalog_sha256, "presets_sha256": self._presets_sha256,
                    "selection": self._default(scope_id), "history": []}
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))
            _fields(stored, {"schema", "scope_id", "catalog_sha256", "presets_sha256",
                             "selection", "history"}, "selection store")
            if stored["schema"] != STORE_SCHEMA or stored["scope_id"] != scope_id:
                raise VoicePresetError("Selection store identity mismatch")
            history = stored["history"]
            if not isinstance(history, list) or not history:
                raise VoicePresetError("Persisted selection requires history")
            previous = None
            seen = set()
            for revision, event in enumerate(history, 1):
                _fields(event, {"mutation_id", "expected_revision", "preset_id", "selection"}, "history event")
                current = event["selection"]
                _fields(current, set(self._default(scope_id)), "selection")
                _identifier(event["mutation_id"], "mutation_id")
                if (current["schema"] != SELECTION_SCHEMA or current["scope_id"] != scope_id
                        or current["preset_id"] not in _PROFILES
                        or current["profile_id"] != _PROFILES[current["preset_id"]]
                        or type(current["revision"]) is not int or current["revision"] != revision
                        or current["persisted"] is not True or not isinstance(current["updated_at"], str)
                        or not current["updated_at"]
                        or current["catalog_sha256"] != stored["catalog_sha256"]
                        or current["presets_sha256"] != stored["presets_sha256"]
                        or event["mutation_id"] != current["mutation_id"]
                        or event["mutation_id"] in seen or event["preset_id"] != current["preset_id"]
                        or type(event["expected_revision"]) is not int
                        or event["expected_revision"] != revision - 1):
                    raise VoicePresetError("Selection history is inconsistent")
                seen.add(event["mutation_id"])
                previous = current
            if stored["selection"] != previous:
                raise VoicePresetError("Selection does not match its history")
        except (OSError, ValueError, TypeError, KeyError) as exc:
            raise VoicePresetError("Unreadable or inconsistent selection store; original file retained",
                                   code="invalid_store") from exc
        if (stored["catalog_sha256"] != self._catalog_sha256
                or stored["presets_sha256"] != self._presets_sha256):
            raise VoicePresetConflict("Selection sources changed; previous choice retained",
                                      code="source_changed", current=stored["selection"])
        return stored

    def get_selection(self, scope_id: str) -> dict:
        return _copy(self._read(scope_id)["selection"])

    @contextmanager
    def _lock(self, scope_id: str):
        self._root.mkdir(parents=True, exist_ok=True)
        path = self._path(scope_id, ".lock")
        try:
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError as exc:
            raise VoicePresetConflict("Another selection change is in progress",
                                      code="selection_busy") from exc
        try:
            os.close(descriptor)
            yield
        finally:
            path.unlink()

    def _write(self, scope_id: str, data: dict) -> None:
        path = self._path(scope_id)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="wb", prefix=".voice-choice-", suffix=".tmp",
                                             dir=self._root, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(_json(data) + b"\n")
                stream.flush()
                os.fsync(stream.fileno())
            # Recheck after preparing bytes so a changed link is not followed.
            self._path(scope_id)
            os.replace(temporary, path)
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()

    def select(self, scope_id: str, preset_id: str, expected_revision: int, mutation_id: str) -> dict:
        self._path(scope_id)
        if not isinstance(preset_id, str) or preset_id not in _PROFILES:
            raise VoicePresetError("Unknown manual voice preset", code="unknown_preset")
        if type(expected_revision) is not int or expected_revision < 0:
            raise VoicePresetError("expected_revision must be a nonnegative integer")
        _identifier(mutation_id, "mutation_id")
        with self._lock(scope_id):
            stored = self._read(scope_id)
            current = stored["selection"]
            for event in stored["history"]:
                if event["mutation_id"] == mutation_id:
                    if event["expected_revision"] == expected_revision and event["preset_id"] == preset_id:
                        return _copy(event["selection"])
                    raise VoicePresetConflict("Mutation ID was already used for another selection",
                                              code="mutation_conflict", current=current)
            if current["revision"] != expected_revision:
                raise VoicePresetConflict("Selection revision changed; reload before selecting",
                                          code="revision_conflict", current=current)
            selected = {**current, "preset_id": preset_id, "profile_id": _PROFILES[preset_id],
                        "revision": expected_revision + 1, "persisted": True,
                        "updated_at": datetime.now(timezone.utc).isoformat(), "mutation_id": mutation_id}
            stored["selection"] = selected
            stored["history"].append({"mutation_id": mutation_id, "expected_revision": expected_revision,
                                      "preset_id": preset_id, "selection": _copy(selected)})
            self._write(scope_id, stored)
            return _copy(selected)

    def plan_batch(self, scope_id: str, requests: list[dict], allow_experimental: bool = False) -> dict:
        if not isinstance(requests, list) or not requests:
            raise VoicePresetError("requests must be a nonempty list")
        if not isinstance(allow_experimental, bool):
            raise VoicePresetError("allow_experimental must be boolean")
        requests = _copy(requests)
        selection = self.get_selection(scope_id)
        profile_id = selection["profile_id"]
        plans = []
        for index, request in enumerate(requests):
            if not isinstance(request, dict):
                raise VoicePresetError(f"Request {index + 1} must be an object")
            # Manual choice controls only the profile; it grants no new purpose,
            # changes no text/instruct/mental state, and supplies no evidence.
            request["profile_id"] = profile_id
            try:
                plan = self._adapter.plan(request, allow_experimental=allow_experimental)
            except CandidateVoiceError as exc:
                raise VoicePresetError(f"Request {index + 1}: {exc}", code="invalid_plan") from exc
            if plan["profile_id"] != profile_id:
                raise VoicePresetError(f"Request {index + 1} cannot use the selected voice: "
                                       f"{plan['fallback_reason']}", code="selected_voice_unavailable")
            plans.append(plan)
        return _copy({"schema": BATCH_SCHEMA, "selection_snapshot": selection, "plans": plans,
                      "request_count": len(plans), "catalog_sha256": self._catalog_sha256,
                      "presets_sha256": self._presets_sha256})
