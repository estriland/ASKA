"""Read-only bridge from reviewed, durable personality turns to voice intent.

No model, credentials, client, or synthesis code is imported. Review documents
are the authority for semantic admission; immutable model artifacts retain their
old pending flags. This bridge does not turn that admission into hearing approval.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import re

SCHEMA = "asuka.reviewed-voice-turn/1"
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_READOUTS = (
    "asuka.engagement.output.engagement", "asuka.output.protective_distance",
    "asuka.output.unresolved_hurt", "asuka.output.connection_available",
    "asuka.output.openness_available", "asuka.core.output.resources",
)


class ReviewedVoiceError(ValueError):
    """Missing, held, changed, or inconsistent reviewed evidence."""


def _require(ok, message):
    if not ok:
        raise ReviewedVoiceError(message)


def _object(value, field):
    _require(isinstance(value, dict), f"{field} must be an object")
    return value


def _string(value, field):
    _require(isinstance(value, str) and bool(value.strip()), f"{field} must be nonempty text")
    return value


def _integer(value):
    return type(value) is int and value >= 1


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _hash_json(value):
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _unique(rows, key, label):
    _require(isinstance(rows, list), f"{label} must be an array")
    result = {}
    for row in rows:
        _object(row, label)
        identity = _string(row.get(key), label + "." + key)
        _require(identity not in result, f"Duplicate {label} identity: {identity}")
        result[identity] = row
    return result


def _json(text):
    def pairs(entries):
        value = {}
        for key, item in entries:
            _require(key not in value, f"Duplicate JSON key: {key}")
            value[key] = item
        return value
    def invalid(_value):
        raise ReviewedVoiceError("Non-finite JSON value")
    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid)
    except (ValueError, TypeError) as exc:
        raise ReviewedVoiceError("Invalid evidence JSON") from exc


def _response_text(response):
    parts = response.get("content")
    _require(isinstance(parts, list), "Response content must be an array")
    text = "\n".join(x["text"] for x in parts if isinstance(x, dict) and x.get("type") == "text")
    return _string(text, "Response text")


def _response_json(response):
    _require(response.get("stopReason") == "stop", "Incomplete model response")
    _require(response.get("responseModel") in {"deepseek-flash", "deepseek-v4-flash"}, "Unexpected response model")
    text = _response_text(response).strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*```$", "", text)
    return _json(text)


class _Evidence:
    def __init__(self):
        self.dependencies = {}

    def read_bytes(self, path, expected=None):
        path = Path(path).resolve()
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise ReviewedVoiceError(f"Cannot read evidence: {path.name}") from exc
        digest = hashlib.sha256(data).hexdigest()
        if expected is not None:
            _require(isinstance(expected, str) and _SHA.fullmatch(expected), "Invalid evidence SHA-256")
            _require(digest == expected, f"Evidence checksum mismatch: {path.name}")
        previous = self.dependencies.get(str(path))
        _require(previous is None or previous == digest, "Evidence changed during read")
        self.dependencies[str(path)] = digest
        return data

    def read(self, path, expected=None):
        return _json(self.read_bytes(path, expected).decode("utf-8-sig"))

    def ref(self, reference):
        _object(reference, "Evidence reference")
        path = Path(_string(reference.get("path"), "Evidence path"))
        _require(path.is_absolute(), "Evidence path must be absolute")
        _require(isinstance(reference.get("sha256"), str) and _SHA.fullmatch(reference["sha256"]), "Evidence reference requires SHA-256")
        return self.read(path, reference.get("sha256"))

    def entry(self, path):
        path = str(Path(path).resolve())
        return {"path": path, "sha256": self.dependencies[path]}


def _review_source(evidence, row):
    ref = row["review_source"]
    data = evidence.read_bytes(ref["path"], ref["sha256"]).decode("utf-8-sig")
    selector = ref.get("selector")
    if set(selector or {}) == {"turn"}:
        entries = [_json(line) for line in data.splitlines() if line.strip()]
        matches = [x for x in entries if x.get("turn") == selector["turn"]]
    elif set(selector or {}) == {"rows.id"}:
        entries = _unique(_json(data).get("rows"), "id", "Original review")
        matches = [entries[selector["rows.id"]]] if selector["rows.id"] in entries else []
    else:
        raise ReviewedVoiceError("Unsupported original review selector")
    _require(len(matches) == 1 and matches[0] == ref.get("selected_original_record"), "Original content review differs")


def _committed(evidence, row):
    _require(row.get("current_reuse_decision") == "accepted_for_downstream_voice_explanation_in_reviewed_scope", "Personality source is held or not admitted")
    _review_source(evidence, row)
    saved = evidence.ref(row["source"])
    history = evidence.ref(row["history"])
    entries = _unique(history, "historyId", "History")
    href = row["history"]
    assistant = entries.get(href["assistant_historyId"])
    user = entries.get(href["user_historyId"])
    _require(isinstance(assistant, dict) and assistant.get("role") == "assistant" and assistant.get("stopReason") == "stop", "No completed durable assistant turn")
    _require(isinstance(user, dict) and user.get("role") == "user", "No durable user turn")
    ai = history.index(assistant)
    _require(ai > 0 and history[ai - 1] == user and href.get("assistant_array_index") == ai, "History user/assistant position differs")
    _require(href.get("record_json_pointer") == f"/{ai}/asukaNative/record", "History record pointer differs")
    _require(saved.get("id") == row["turn_id"] and saved.get("user") == user.get("content"), "Source identity or user text differs")
    reply = _object(saved.get("reply"), "Saved reply")
    _string(reply.get("speech"), "reply.speech")
    _require(isinstance(reply.get("translation"), str) and reply.get("language") == "ja", "Reply language or translation is invalid")
    text = _response_text(assistant)
    _require(_json(text) == reply == row.get("saved_reply") and text == saved["result"]["text"], "Committed reply text/subject differs")
    native = _object(assistant.get("asukaNative"), "Native history")
    record = _object(native.get("record"), "Committed record")
    snapshot = _object(record.get("snapshot"), "Committed snapshot")
    seq = row.get("sequence")
    _require(_integer(seq) and record.get("sequence") == seq and snapshot.get("state_revision") == seq, "Committed sequence/state revision differs")
    native_ref = row["native_provenance"]
    _require(native_ref.get("source_is_per_turn_history_record") is True and native_ref.get("final_state_json_used") is False, "Per-turn durable state is required")
    _require(native.get("key") == native_ref.get("key") and str(native.get("key")).endswith(":conversation:" + row["conversation_id"]), "Conversation state scope differs")
    _require(_hash_json(record) == native_ref.get("record_canonical_sha256") and _hash_json(snapshot) == native_ref.get("snapshot_canonical_sha256"), "Native record content differs")
    personality = _object(saved["result"].get("personality"), "Saved personality")
    observer = _object(personality.get("observer"), "Observer")
    _require(personality.get("stateRevision") == seq and observer.get("networkId") == snapshot.get("network_id") and observer.get("networkRevision") == snapshot.get("network_revision"), "Observer network/state revision differs")
    _require(_integer(snapshot.get("network_revision")), "Invalid network revision")
    nodes = _unique(observer.get("nodes"), "id", "Observer nodes")
    for node_id in _READOUTS:
        raw = nodes.get(node_id, {}).get("raw")
        _require(type(raw) in (int, float) and math.isfinite(raw), "Missing finite voice readout")
    values = dict(snapshot.get("node_values", {}))
    for scoped in snapshot.get("relationship_values", {}).values():
        for key, value in scoped.items():
            _require(key not in values or values[key] == value, "Ambiguous relationship observation")
            values[key] = value
    for key, value in values.items():
        _require(nodes.get(key, {}).get("raw") == value, "Observer differs from committed snapshot")
    _require(isinstance(record.get("last_mapping", {}).get("applied_mapping", {}).get("signals"), list), "Applied mapping missing from commit")
    calls = _unique(row.get("raw_response_calls"), "phase", "Source calls")
    for call in calls.values():
        for kind in ("request", "response", "wire"):
            evidence.ref(call[kind])
    _require("reply" in calls and "analysis" in calls, "Source analysis and reply calls are required")
    call = calls["reply"]
    _require(_response_json(evidence.ref(call["response"])) == reply, "Raw model reply differs")
    request = evidence.ref(call["request"])["request"]
    blocks = []
    for message in request.get("messages", []):
        parts = message.get("content", [])
        if isinstance(parts, str):
            parts = [{"type": "text", "text": parts}]
        for part in parts:
            if part.get("type") != "text":
                continue
            try:
                value = _json(part["text"])
            except ReviewedVoiceError:
                continue
            if isinstance(value, dict) and value.get("kind") == "engine_turn_data_not_new_user_speech":
                blocks.append(value)
    _require(len(blocks) == 1 and blocks[0].get("supplied_revision") == seq, "Actual reply request revision differs")
    states = [x.get("value") for x in blocks[0].get("system_fields", []) if x.get("name") == "state"]
    _require(len(states) == 1 and isinstance(states[0], dict), "Actual reply semantic state missing")
    version = _string(personality.get("turn_adapter", {}).get("package_hash"), "Personality package version")
    return {"row": row, "reply": reply, "user": saved["user"], "record": record,
            "observer": observer, "semantic_state": states[0], "version": version, "history_key": native["key"]}


def _condition(evidence, path, digest, source, response_digest=None):
    _require(isinstance(digest, str) and _SHA.fullmatch(digest), "Condition requires SHA-256")
    artifact = evidence.read(path, digest)
    row = source["row"]
    _require(artifact.get("id") == row["turn_id"] and artifact.get("conversation_id") == row["conversation_id"] and artifact.get("sequence") == row["sequence"], "Voice condition turn identity differs")
    _require(artifact.get("source_sha256") == row["source"]["sha256"], "Voice condition source differs")
    response = evidence.ref({"path": artifact["raw_response"], "sha256": artifact["response_sha256"]})
    if response_digest is not None:
        _require(artifact["response_sha256"] == response_digest, "Reviewed voice response differs")
    candidate = _object(artifact.get("candidate"), "Voice candidate")
    _require(_response_json(response) == candidate, "Raw voice decision differs")
    for key in ("intent", "attitude", "delivery", "rationale"):
        _string(candidate.get(key), "candidate." + key)
    for key in ("details", "alternatives", "uncertainties"):
        _require(isinstance(candidate.get(key), list) and all(isinstance(x, str) for x in candidate[key]), "Invalid voice condition array")
    _require("parts" not in candidate, "Unreviewed voice parts are not supported")
    speech = source["reply"]["speech"]
    compiled = _object(artifact.get("compiled"), "Compiled condition")
    instruct = "".join(x for x in [candidate["delivery"], *candidate["details"]] if x.strip())
    _require(artifact.get("text") == compiled.get("text") == speech and compiled.get("instruct") == instruct, "Voice condition text or compilation differs")
    return {"text": speech, "instruct": instruct, "delivery": candidate["delivery"],
            "details": candidate["details"], "candidate": candidate}


def load_reviewed_turn(source_review_path, condition_review_path, turn_id, *, compact_review_path=None):
    """Load one accepted turn from an intact reviewed continuous prefix.

    This is artifact-backed replay of a real committed turn, not live client
    integration or a new model decision. Acoustic approval remains false.
    """
    try:
        evidence = _Evidence()
        sr_path, cr_path = Path(source_review_path).resolve(), Path(condition_review_path).resolve()
        sr, cr = evidence.read(sr_path), evidence.read(cr_path)
        _require(sr.get("schema") == "asuka.personality-voice-source-review/v1" and sr.get("status") == "accepted_for_voice_explanation_not_voice_or_production_acceptance", "Unsupported or held source review")
        _require(cr.get("schema") == "asuka.dialogue-voice-semantic-admission/1" and cr.get("status") == "admitted_for_bounded_tts_comparison", "Unsupported or held condition review")
        source_rows = _unique(sr.get("rows"), "turn_id", "Source review")
        reviews = _unique(cr.get("items"), "turn_id", "Condition review")
        _require(turn_id in source_rows and turn_id in reviews, "Turn is absent from reviewed sources")
        row, review = source_rows[turn_id], reviews[turn_id]
        _require(review.get("accepted") is True, "Voice condition is held")
        _require(review.get("source_sha256") == row["source"]["sha256"], "Review source binding differs")
        seq = row["sequence"]
        _require(_integer(seq), "Invalid selected sequence")
        prefix = [x for x in source_rows.values() if x["conversation_id"] == row["conversation_id"] and x["sequence"] <= seq]
        prefix.sort(key=lambda x: x["sequence"])
        _require([x["sequence"] for x in prefix] == list(range(1, seq + 1)), "Missing or duplicated adjacent committed turn")
        loaded = [_committed(evidence, x) for x in prefix]
        for left, right in zip(loaded, loaded[1:]):
            a, b = left["record"]["snapshot"], right["record"]["snapshot"]
            _require(left["history_key"] == right["history_key"] and left["version"] == right["version"] and a["network_id"] == b["network_id"] and a["network_revision"] == b["network_revision"], "Adjacent turns belong to different state versions")
        current = loaded[-1]
        previous = loaded[-2] if len(loaded) > 1 else None
        original = _condition(evidence, cr_path.parent / review["condition_artifact"], review["condition_artifact_sha256"], current, review["response_sha256"])
        selected, compact_review = original, None
        if compact_review_path is not None:
            cp = Path(compact_review_path).resolve()
            compact = evidence.read(cp)
            _require(compact.get("scope") == "bounded_condition_representation_diagnostic", "Unsupported compact review")
            rows = _unique(compact.get("items"), "group_id", "Compact review")
            compact_review = rows.get(turn_id)
            _require(isinstance(compact_review, dict) and compact_review.get("accepted") is True and "artifact" in compact_review, "No accepted compact condition for this turn")
            selected = _condition(evidence, compact_review["artifact"], compact_review["artifact_sha256"], current)
        entries = {"source_review": evidence.entry(sr_path), "condition_review": evidence.entry(cr_path),
                   "compact_review": evidence.entry(compact_review_path) if compact_review_path else None}
        result = {"schema": SCHEMA, "conversation_id": row["conversation_id"], "turn_id": turn_id,
                  "sequence": seq, "speech": current["reply"]["speech"], "translation": current["reply"]["translation"],
                  "language": "Japanese", "speaker": "asuka", "user": current["user"],
                  "personality": {"current_record": current["record"], "previous_record": previous["record"] if previous else None,
                                  "observer": current["observer"], "previous_observer": previous["observer"] if previous else None,
                                  "semantic_state": current["semantic_state"], "version": current["version"],
                                  "prior_status": "known_adjacent_committed_turn" if previous else "unknown_prior"},
                  "condition": {**selected, "representation": "compact" if compact_review else "original",
                                "original_candidate": original["candidate"]},
                  "admission": {"semantic_accepted": True, "scope": review["admission_scope"],
                                "source_scope": row["current_reuse_decision"], "review_note": review.get("notes_zh", ""),
                                "compact_review_note": compact_review.get("notes_zh", "") if compact_review else None,
                                "acoustic_approved": False, "training_ready": False, "production_approved": False},
                  "provenance": {"kind": "reviewed_voice_analysis", "mode": "reused_committed_artifact",
                                 "entries": entries, "dependencies": [{"path": p, "sha256": h} for p, h in sorted(evidence.dependencies.items())]}}
        return deepcopy(result)
    except (KeyError, TypeError, UnicodeError, OSError) as exc:
        raise ReviewedVoiceError("Malformed or unavailable reviewed evidence") from exc


def revalidate_reviewed_turn(turn):
    """Re-read authoritative inputs and reject changed files or in-memory data."""
    _require(isinstance(turn, dict) and turn.get("schema") == SCHEMA, "Unsupported reviewed turn")
    try:
        entries = turn["provenance"]["entries"]
        for entry in entries.values():
            if entry is not None:
                _Evidence().ref(entry)
        rebuilt = load_reviewed_turn(entries["source_review"]["path"], entries["condition_review"]["path"], turn["turn_id"],
                                     compact_review_path=entries["compact_review"]["path"] if entries.get("compact_review") else None)
        _require(_canonical(rebuilt) == _canonical(turn), "Reviewed turn changed after preparation")
        return rebuilt
    except (KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, ReviewedVoiceError):
            raise
        raise ReviewedVoiceError("Malformed reviewed-turn provenance") from exc
