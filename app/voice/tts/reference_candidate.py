"""Explicit, isolated voice-reference planning; never imports a model at startup.

This module does not choose expressive references from text or personality values.
The default is the catalog's V4 baseline. Experimental profiles require an explicit
name, purpose and per-request opt-in, with text-bound diagnostic evidence. A plan
is an audit record, not an acoustic acceptance or permission to change production.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
from typing import Any

try:
    from .reference_bank import ReferenceBank, ReferenceBankError
except ImportError:  # Direct execution/import from voice/tts is also supported.
    from reference_bank import ReferenceBank, ReferenceBankError


CATALOG_SCHEMA = "asuka.reference-candidate-catalog/1"
PLAN_SCHEMA = "asuka.reference-candidate-plan/1"
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")


class CandidateVoiceError(ValueError):
    """The proposed call is inconsistent, unsupported, or bound to changed assets."""


def _json(value: Any) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise CandidateVoiceError("Expected finite JSON data") from exc


def _copy(value: Any) -> Any:
    return json.loads(_json(value))


def _digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CandidateVoiceError(f"{field} must be a nonempty string")
    return value


def _sha(value: Any, field: str) -> str:
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        raise CandidateVoiceError(f"{field} must be a lowercase SHA-256")
    return value


def _keys(value: Any, required: set[str], optional: set[str], field: str) -> None:
    if not isinstance(value, dict) or not required <= value.keys() or value.keys() - required - optional:
        raise CandidateVoiceError(f"Invalid {field} fields")


def _file_evidence(item: dict) -> Path:
    _keys(item, {"path", "sha256"}, set(), "file evidence")
    path = Path(_text(item["path"], "evidence.path"))
    if not path.is_absolute():
        raise CandidateVoiceError("Evidence paths must be absolute")
    expected = _sha(item["sha256"], "evidence.sha256")
    try:
        with path.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
    except OSError as exc:
        raise CandidateVoiceError(f"Missing evidence: {path.name}") from exc
    if actual != expected:
        raise CandidateVoiceError(f"Evidence checksum mismatch: {path.name}")
    return path


class CandidateVoiceAdapter:
    """Create independent plans using one privately copied, versioned catalog.

    ``plan(request, allow_experimental=False)`` performs all provenance checks
    before a caller loads its model. ``load_reference(plan, item_type=None)``
    rechecks that plan and restores a one-item Qwen prompt list only for Base.
    This first version supports declared diagnostic probes. A reviewed voice
    analysis requires a future approval adapter and is deliberately not accepted.
    """

    def __init__(self, catalog: dict):
        catalog = _copy(catalog)
        _keys(catalog, {"schema", "default_profile", "profiles"}, set(), "catalog")
        if catalog["schema"] != CATALOG_SCHEMA or catalog["default_profile"] != "ordinary":
            raise CandidateVoiceError("Expected versioned catalog with ordinary as the default")
        profiles = catalog["profiles"]
        if not isinstance(profiles, dict) or "ordinary" not in profiles:
            raise CandidateVoiceError("Catalog requires profiles.ordinary")
        for profile_id, profile in profiles.items():
            if not _ID.fullmatch(profile_id):
                raise CandidateVoiceError("Invalid profile identifier")
            _keys(profile, {"backend", "mode", "speaker", "language", "status", "evidence", "allowed_purposes"},
                  {"reference_id", "bank_path", "fingerprint"}, "profile")
            for field in ("speaker", "language"):
                _text(profile[field], f"profile.{field}")
            if profile["status"] not in {"baseline", "evaluation_only"}:
                raise CandidateVoiceError("Profile is not baseline or evaluation_only")
            if not isinstance(profile["evidence"], list) or not profile["evidence"]:
                raise CandidateVoiceError("Profile requires source evidence")
            for evidence in profile["evidence"]:
                _keys(evidence, {"path", "sha256"}, set(), "profile evidence")
                _text(evidence["path"], "profile evidence.path")
                _sha(evidence["sha256"], "profile evidence.sha256")
            purposes = profile["allowed_purposes"]
            if (not isinstance(purposes, list)
                    or any(not isinstance(p, str) or not p.strip() for p in purposes)
                    or len(set(purposes)) != len(purposes)):
                raise CandidateVoiceError("allowed_purposes must be unique nonempty strings")
            if profile["backend"] == "v4_custom":
                if profile["mode"] != "custom" or any(k in profile for k in ("reference_id", "bank_path", "fingerprint")):
                    raise CandidateVoiceError("V4 custom profiles cannot carry a Base reference")
            elif profile["backend"] == "base_clone":
                if profile["mode"] not in {"xvector", "icl"}:
                    raise CandidateVoiceError("Base requires xvector or icl mode")
                if any(k not in profile for k in ("reference_id", "bank_path", "fingerprint")):
                    raise CandidateVoiceError("Base requires bank, reference and fingerprint")
                if not _ID.fullmatch(_text(profile["reference_id"], "reference_id")):
                    raise CandidateVoiceError("Invalid reference identifier")
                if not Path(_text(profile["bank_path"], "bank_path")).is_absolute():
                    raise CandidateVoiceError("bank_path must be absolute")
                if not isinstance(profile["fingerprint"], dict):
                    raise CandidateVoiceError("Reference fingerprint must be an object")
            else:
                raise CandidateVoiceError("Unsupported backend")
            if profile_id == "ordinary":
                if profile["backend"] != "v4_custom" or profile["status"] != "baseline":
                    raise CandidateVoiceError("ordinary must remain the V4 baseline")
            elif profile["status"] != "evaluation_only" or not purposes:
                raise CandidateVoiceError("Nondefault profiles require evaluation status and purposes")
        self._catalog = catalog
        self._catalog_sha256 = _digest(_json(catalog))

    def _context(self, request: dict) -> dict:
        evidence = request.get("evidence")
        _keys(evidence, {"kind", "turn_id", "text_sha256"}, {"path", "sha256"}, "request evidence")
        if evidence["kind"] != "declared_probe":
            raise CandidateVoiceError("Only declared_probe is implemented; reviewed analysis requires an approval adapter")
        turn_id = _text(evidence["turn_id"], "evidence.turn_id")
        if "turn_id" in request and request["turn_id"] != turn_id:
            raise CandidateVoiceError("Evidence turn_id mismatch")
        if _sha(evidence["text_sha256"], "evidence.text_sha256") != _digest(request["text"].encode("utf-8")):
            raise CandidateVoiceError("Evidence text_sha256 mismatch")
        if ("path" in evidence) != ("sha256" in evidence):
            raise CandidateVoiceError("Evidence path and sha256 must be provided together")
        if "path" in evidence:
            path = _file_evidence({key: evidence[key] for key in ("path", "sha256")})
            try:
                stored = json.loads(path.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError) as exc:
                raise CandidateVoiceError("Request evidence must be a JSON object") from exc
            if not isinstance(stored, dict) or any(stored.get(k) != evidence[k] for k in ("kind", "turn_id", "text_sha256")):
                raise CandidateVoiceError("Stored request evidence identity mismatch")
            if stored.get("text") != request["text"] or stored.get("purpose") != request.get("purpose"):
                raise CandidateVoiceError("Stored request text or purpose mismatch")
        return _copy(evidence)

    def _reference(self, profile: dict) -> dict | None:
        for evidence in profile["evidence"]:
            _file_evidence(evidence)
        if profile["backend"] == "v4_custom":
            return None
        try:
            described = ReferenceBank(profile["bank_path"]).describe(profile["reference_id"])
        except ReferenceBankError as exc:
            raise CandidateVoiceError(str(exc)) from exc
        if described["fingerprint"] != profile["fingerprint"]:
            raise CandidateVoiceError("Reference fingerprint mismatch")
        metadata = described["metadata"]
        if metadata.get("admission") not in {"candidate", "ready"} or metadata.get("feature_ready") is not True:
            raise CandidateVoiceError("Held, rejected or unready reference cannot be selected")
        if metadata.get("language") != profile["language"] or metadata.get("speaker") != profile["speaker"]:
            raise CandidateVoiceError("Cached reference language or speaker mismatch")
        return {"bank_path": profile["bank_path"], "reference_id": profile["reference_id"],
                "fingerprint": _copy(profile["fingerprint"]),
                "content_sha256": described["content_sha256"], "tensors_sha256": described["tensors_sha256"]}

    def plan(self, request: dict, allow_experimental: bool = False) -> dict:
        request = _copy(request)
        _keys(request, {"text", "language", "speaker"},
              {"profile_id", "purpose", "evidence", "instruct", "mental_state", "turn_id"}, "request")
        for field in ("text", "language", "speaker"):
            _text(request[field], f"request.{field}")
        if not isinstance(allow_experimental, bool):
            raise CandidateVoiceError("allow_experimental must be boolean")
        for field in ("profile_id", "purpose", "turn_id"):
            if field in request and request[field] is not None:
                _text(request[field], f"request.{field}")
        if request.get("instruct") is not None and not isinstance(request["instruct"], str):
            raise CandidateVoiceError("instruct must be a string or null")
        nominated = request.get("profile_id")
        profiles = self._catalog["profiles"]
        if nominated is None:
            reason = "no_profile_requested"
        elif nominated == "ordinary":
            reason = "ordinary_requested"
        elif nominated not in profiles:
            reason = "unknown_profile"
        elif not allow_experimental:
            reason = "experimental_not_allowed"
        elif request.get("purpose") not in profiles[nominated]["allowed_purposes"]:
            reason = "purpose_not_allowed"
        else:
            reason = None
        profile_id = "ordinary" if reason else nominated
        profile = profiles[profile_id]
        if request["language"] != profile["language"] or request["speaker"] != profile["speaker"]:
            raise CandidateVoiceError("Request language or speaker differs from selected profile")
        # Fallback changes the voice route, never the validity of supplied context.
        # An ordinary request may omit evidence; an explicit evidence field and
        # every experimental selection must pass the same text/turn checks.
        context = self._context(request) if "evidence" in request or reason is None else None
        reference = self._reference(profile)
        return {
            "schema": PLAN_SCHEMA, "catalog_sha256": self._catalog_sha256,
            "request_sha256": _digest(_json(request)), "request": request,
            "experimental_allowed": allow_experimental,
            "turn_id": request.get("turn_id") or (context.get("turn_id") if isinstance(context, dict) else None),
            "text": request["text"], "language": request["language"], "speaker": request["speaker"],
            "requested_profile_id": nominated, "profile_id": profile_id,
            "profile_sha256": _digest(_json(profile)), "backend": profile["backend"],
            "mode": profile["mode"], "status": profile["status"], "reference": reference,
            "context_evidence": context, "profile_evidence": _copy(profile["evidence"]),
            "requested_instruct": request.get("instruct"),
            "actual_instruct": request.get("instruct") if profile["backend"] == "v4_custom" else None,
            "fallback_reason": reason, "selection_reason": "explicit_diagnostic_profile" if reason is None else reason,
        }

    def load_reference(self, plan: dict, item_type: Any = None) -> list:
        """Revalidate provenance and rebuild Base's list; no model is loaded here."""
        plan = _copy(plan)
        if not isinstance(plan, dict) or plan.get("schema") != PLAN_SCHEMA:
            raise CandidateVoiceError("Invalid plan")
        if plan.get("catalog_sha256") != self._catalog_sha256:
            raise CandidateVoiceError("Plan belongs to another catalog")
        fresh = self.plan(plan.get("request"), allow_experimental=plan.get("experimental_allowed"))
        if fresh != plan:
            raise CandidateVoiceError("Plan has changed; regenerate it from its original request")
        if fresh["backend"] != "base_clone":
            raise CandidateVoiceError("V4 custom plans do not load reference prompts")
        profile = self._catalog["profiles"][fresh["profile_id"]]
        try:
            return ReferenceBank(profile["bank_path"]).load(profile["reference_id"], profile["fingerprint"],
                                                            mode=profile["mode"], item_type=item_type)
        except ReferenceBankError as exc:
            raise CandidateVoiceError(str(exc)) from exc
