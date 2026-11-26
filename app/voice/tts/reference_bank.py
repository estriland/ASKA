"""Immutable local Qwen 12 Hz reference prompts; no model or encoder is loaded here.

The index uses explicit labels, never speaker-vector similarity as emotion retrieval.
``admission='ready'`` admits a candidate to lookup, not to acoustic acceptance.
Source WAV files are provenance only after creation: loading checks frozen fingerprints
and both stored files, so an offline original WAV need not be decoded again.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any, Mapping


SCHEMA = "asuka.qwen-reference-bank/1"
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_FINGERPRINT_KEYS = (
    "source_audio_sha256", "ref_text", "speaker_encoder", "tokenizer", "model", "implementation",
)


class ReferenceBankError(ValueError):
    """A reference is invalid, changed, held, or belongs to another runtime/source."""


def _json_bytes(value: Any) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ReferenceBankError("Cache metadata must be finite JSON data") from exc


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _has_digest(value: Any) -> bool:
    if isinstance(value, str):
        return bool(_SHA.fullmatch(value))
    if isinstance(value, dict):
        return any(_has_digest(item) for item in value.values())
    if isinstance(value, list):
        return any(_has_digest(item) for item in value)
    return False


def _fingerprint(value: Mapping[str, Any]) -> dict:
    if not isinstance(value, Mapping):
        raise ReferenceBankError("A complete fingerprint is required")
    result = json.loads(_json_bytes(dict(value)))
    if any(key not in result for key in _FINGERPRINT_KEYS):
        raise ReferenceBankError("Fingerprint requires " + ", ".join(_FINGERPRINT_KEYS))
    if not isinstance(result["source_audio_sha256"], str) or not _SHA.fullmatch(result["source_audio_sha256"]):
        raise ReferenceBankError("source_audio_sha256 must be a lowercase SHA-256")
    if not isinstance(result["ref_text"], str) or not result["ref_text"].strip():
        raise ReferenceBankError("The exact reference transcript is required")
    for key in _FINGERPRINT_KEYS[2:]:
        if not _has_digest(result[key]):
            raise ReferenceBankError(f"{key} requires a content SHA-256, not only a version or path")
    return result


def _entry_id(value: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ReferenceBankError("entry_id must be a simple local identifier")
    return value


def _field(item: Any, name: str) -> Any:
    return item.get(name) if isinstance(item, Mapping) else getattr(item, name, None)


def _validate_tensors(tensors: dict) -> None:
    # Keep heavyweight imports inside operations that actually handle tensors.
    import torch

    if set(tensors) != {"ref_code", "ref_spk_embedding"}:
        raise ReferenceBankError("A complete prompt requires codec tokens and speaker embedding")
    code, speaker = tensors["ref_code"], tensors["ref_spk_embedding"]
    if not isinstance(code, torch.Tensor) or not isinstance(speaker, torch.Tensor):
        raise ReferenceBankError("Prompt fields must be torch tensors")
    if code.dtype not in {torch.uint8, torch.int8, torch.int16, torch.int32, torch.int64}:
        raise ReferenceBankError("Codec tokens must have an integer dtype")
    if code.ndim != 2 or code.shape[0] < 1 or code.shape[1] != 16 or bool((code < 0).any()):
        raise ReferenceBankError("Expected nonnegative Qwen 12 Hz codec tokens shaped [T,16]")
    if speaker.ndim != 1 or speaker.numel() < 1 or not speaker.is_floating_point():
        raise ReferenceBankError("Speaker embedding must be a nonempty floating point vector")
    if not bool(torch.isfinite(speaker).all()) or not bool((speaker != 0).any()):
        raise ReferenceBankError("Speaker embedding must be finite and nonzero")


def _publish_file(path: Path, data: bytes) -> None:
    """Publish atomically without replacing another writer's immutable record."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".pending-", delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        try:
            os.link(temporary, path)
        except FileExistsError:
            if path.read_bytes() != data:
                raise ReferenceBankError(f"Refusing to overwrite immutable cache file: {path.name}")
    finally:
        temporary.unlink(missing_ok=True)


class ReferenceBank:
    def __init__(self, root: str | Path):
        self.root = Path(root)

    def put(self, entry_id: str, prompt_item: Any, metadata: Mapping[str, Any],
            fingerprint: Mapping[str, Any]) -> dict:
        """Store one *complete* prompt; repeated identical puts are idempotent.

        ``fingerprint`` must include source_audio_sha256, exact ref_text, and
        speaker_encoder/tokenizer/model/implementation content fingerprints.
        The latter can be a SHA string or a JSON structure containing SHA values.
        Metadata keeps source paths, label provenance and admission separately.
        Any change requires a new entry_id; no implicit replacement is possible.
        """
        from safetensors.torch import save

        entry_id = _entry_id(entry_id)
        frozen = _fingerprint(fingerprint)
        if _field(prompt_item, "ref_text") != frozen["ref_text"]:
            raise ReferenceBankError("Prompt ref_text differs from the frozen transcript")
        if _field(prompt_item, "icl_mode") is not True or _field(prompt_item, "x_vector_only_mode") is not False:
            raise ReferenceBankError("Store a complete ICL prompt, derive xvector mode when loading")
        tensors = {name: _field(prompt_item, name) for name in ("ref_code", "ref_spk_embedding")}
        _validate_tensors(tensors)
        tensors = {name: tensor.detach().cpu().contiguous() for name, tensor in tensors.items()}
        tensor_bytes = save(tensors)
        if not isinstance(metadata, Mapping):
            raise ReferenceBankError("metadata must be a JSON mapping")
        meta = json.loads(_json_bytes(dict(metadata)))
        meta.setdefault("admission", "candidate")
        meta.setdefault("label_status", "candidate")
        meta.setdefault("acoustic_approved", False)
        meta.setdefault("feature_ready", True)
        meta.setdefault("acoustic_review_status", "not_reviewed")
        if meta["feature_ready"] is not True:
            raise ReferenceBankError("Only successfully extracted features can be cached")
        if meta["admission"] not in {"candidate", "ready", "hold", "rejected"}:
            raise ReferenceBankError("Unknown admission state")
        labels = meta.setdefault("labels", [])
        if not isinstance(labels, list) or any(not isinstance(label, str) or not label for label in labels):
            raise ReferenceBankError("labels must be a list of nonempty strings")
        for key in ("family", "language", "speaker"):
            if key in meta and (not isinstance(meta[key], str) or not meta[key]):
                raise ReferenceBankError(f"{key} must be a nonempty string")
        document = {
            "schema": SCHEMA, "entry_id": entry_id, "fingerprint": frozen,
            "metadata": meta, "ref_text": frozen["ref_text"],
            "tensors_sha256": _digest(tensor_bytes),
            "tensors": {name: {"shape": list(tensor.shape), "dtype": str(tensor.dtype)}
                        for name, tensor in tensors.items()},
        }
        document_bytes = _json_bytes(document)
        content_id = _digest(document_bytes)
        alias = {"schema": SCHEMA, "entry_id": entry_id, "content_sha256": content_id}
        alias_path = self.root / "entries" / f"{entry_id}.json"
        # Fail before writing another blob when the name is already occupied.
        if alias_path.exists():
            current, _, current_id = self._read(entry_id)
            if current_id != content_id or current != document:
                raise ReferenceBankError(f"Entry {entry_id} already exists with different content")
            return self._description(current, content_id)
        object_dir = self.root / "objects" / content_id
        _publish_file(object_dir / "tensors.safetensors", tensor_bytes)
        _publish_file(object_dir / "metadata.json", document_bytes)
        _publish_file(alias_path, _json_bytes(alias))
        return self.describe(entry_id)

    def _read(self, entry_id: str) -> tuple[dict, bytes, str]:
        entry_id = _entry_id(entry_id)
        try:
            alias = json.loads((self.root / "entries" / f"{entry_id}.json").read_bytes())
            content_id = alias.get("content_sha256")
            if (alias.get("schema") != SCHEMA or alias.get("entry_id") != entry_id
                    or not isinstance(content_id, str) or not _SHA.fullmatch(content_id)):
                raise ReferenceBankError("Invalid cache alias")
            object_dir = self.root / "objects" / content_id
            raw = (object_dir / "metadata.json").read_bytes()
            if _digest(raw) != content_id:
                raise ReferenceBankError("Reference metadata checksum mismatch")
            document = json.loads(raw)
            if document.get("schema") != SCHEMA or document.get("entry_id") != entry_id:
                raise ReferenceBankError("Reference identity mismatch")
            if _fingerprint(document["fingerprint"])["ref_text"] != document.get("ref_text"):
                raise ReferenceBankError("Cached transcript mismatch")
            tensor_bytes = (object_dir / "tensors.safetensors").read_bytes()
            if _digest(tensor_bytes) != document["tensors_sha256"]:
                raise ReferenceBankError("Reference tensor checksum mismatch")
            return document, tensor_bytes, content_id
        except (OSError, KeyError, TypeError, AttributeError, json.JSONDecodeError) as exc:
            raise ReferenceBankError(f"Invalid or missing reference cache: {entry_id}") from exc

    @staticmethod
    def _description(document: dict, content_id: str) -> dict:
        return {"entry_id": document["entry_id"], "content_sha256": content_id,
                "fingerprint": document["fingerprint"], "ref_text": document["ref_text"],
                "tensors_sha256": document["tensors_sha256"], "tensors": document["tensors"],
                "metadata": document["metadata"]}

    def describe(self, entry_id: str) -> dict:
        """Return provenance only after checking metadata and tensor-file hashes."""
        document, _, content_id = self._read(entry_id)
        return self._description(document, content_id)

    def load(self, entry_id: str, expected_fingerprint: Mapping[str, Any], *,
             mode: str = "icl", item_type: Any = None) -> list:
        """Rebuild a one-item prompt list without decoding its source WAV.

        An explicitly chosen candidate may be loaded for evaluation, but held or
        rejected references cannot. Queries return only ready entries. Passing
        item_type avoids importing Qwen (useful for tests and adapter boundaries).
        """
        from safetensors.torch import load

        if mode not in {"icl", "xvector"}:
            raise ReferenceBankError("mode must be icl or xvector")
        expected = _fingerprint(expected_fingerprint)
        document, tensor_bytes, _ = self._read(entry_id)
        if document["fingerprint"] != expected:
            raise ReferenceBankError("Source, transcript or runtime fingerprint mismatch")
        if document["metadata"].get("admission") not in {"candidate", "ready"}:
            raise ReferenceBankError("Held or rejected references cannot be loaded")
        tensors = load(tensor_bytes)
        _validate_tensors(tensors)
        specs = {name: {"shape": list(tensor.shape), "dtype": str(tensor.dtype)}
                 for name, tensor in tensors.items()}
        if specs != document["tensors"]:
            raise ReferenceBankError("Reference tensor shape or dtype mismatch")
        if item_type is None:
            from qwen_tts.inference.qwen3_tts_model import VoiceClonePromptItem
            item_type = VoiceClonePromptItem
        return [item_type(ref_code=tensors["ref_code"] if mode == "icl" else None,
                          ref_spk_embedding=tensors["ref_spk_embedding"],
                          x_vector_only_mode=mode == "xvector", icl_mode=mode == "icl",
                          ref_text=document["ref_text"])]

    def query(self, *, labels: list[str] | None = None, family: str | None = None,
              language: str | None = None, speaker: str | None = None) -> list[dict]:
        """Exact metadata filters (all requested labels), only ready candidates."""
        if labels is not None and not isinstance(labels, (list, tuple, set)):
            raise ReferenceBankError("Query labels must be a collection of strings")
        requested = set(labels or [])
        if any(not isinstance(label, str) for label in requested):
            raise ReferenceBankError("Query labels must be strings")
        result = []
        for path in sorted((self.root / "entries").glob("*.json")):
            entry = self.describe(path.stem)
            meta = entry["metadata"]
            if meta.get("admission") != "ready" or not requested.issubset(meta.get("labels", [])):
                continue
            if any(value is not None and meta.get(key) != value
                   for key, value in (("family", family), ("language", language), ("speaker", speaker))):
                continue
            result.append(entry)
        return result
