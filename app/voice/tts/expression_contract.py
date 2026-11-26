"""Consume the portable personality-to-voice expression contract.

Schema validation is not semantic admission. Only a reviewed-turn snapshot whose
original history and external reviews still validate can enter the voice engine.
No model, audio runtime, network, or credentials are imported here.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re

from .engine_reviewed import revalidate_reviewed_turn


SCHEMA = "asuka.voice-expression/1"
EXPORT_ADAPTER_VERSION = "asuka.reviewed-voice-turn-export/1"
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_EXPRESSION_KEYS = {"intent", "attitude", "delivery", "details", "alternatives", "rationale", "uncertainties"}
# JavaScript String.trim, rather than Python's subtly different str.strip set.
_ECMA_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


class ExpressionContractError(ValueError):
    def __init__(self, message, code="invalid_contract"):
        super().__init__(message)
        self.code = code


def _require(ok, message, code="invalid_contract"):
    if not ok:
        raise ExpressionContractError(message, code)


def _object(value, keys, field):
    _require(type(value) is dict and set(value) == keys, "Invalid fields in " + field)
    return value


def _text(value, field):
    _require(isinstance(value, str) and bool(value.strip(_ECMA_WHITESPACE)), field + " must be nonempty text")
    return value


def _absolute(path):
    return (isinstance(path, str) and "\0" not in path and (
        path.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", path) is not None
        or re.match(r"^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)", path) is not None))


def _artifact(value):
    _object(value, {"path", "sha256"}, "source.artifact")
    _require(_absolute(value["path"]), "Source artifact must have an absolute path")
    _require(isinstance(value["sha256"], str) and _SHA.fullmatch(value["sha256"]) is not None,
             "Source artifact requires a lowercase SHA-256")
    return value


def compile_instruction(expression):
    """Join the chosen delivery and nonblank details, preserving their text."""
    _object(expression, _EXPRESSION_KEYS, "expression")
    for key in ("intent", "attitude", "delivery", "rationale"):
        _text(expression[key], "expression." + key)
    for key in ("details", "alternatives", "uncertainties"):
        _require(isinstance(expression[key], list) and all(isinstance(x, str) for x in expression[key]),
                 "expression." + key + " must be an array of strings")
    return "".join(value for value in [expression["delivery"], *expression["details"]]
                   if value.strip(_ECMA_WHITESPACE))


def validate_contract(value):
    """Return an independent validated JSON value; no file is read or approved."""
    _object(value, {"schema", "identity", "text", "expression", "condition", "source", "review"}, "contract")
    _require(value["schema"] == SCHEMA, "Unsupported expression contract schema")
    identity = _object(value["identity"], {"conversation_id", "turn_id", "sequence", "speaker", "language"}, "identity")
    for key in ("conversation_id", "turn_id", "speaker", "language"):
        _text(identity[key], "identity." + key)
    number = identity["sequence"]
    _require(type(number) in (int, float) and 1 <= number <= 2**53 - 1 and int(number) == number,
             "identity.sequence must be a positive safe integer")
    _text(value["text"], "text")
    instruction = compile_instruction(value["expression"])
    condition = _object(value["condition"], {"text", "instruct"}, "condition")
    _require(condition["text"] == value["text"] and condition["instruct"] == instruction,
             "Compiled condition differs from text or chosen expression")
    source = _object(value["source"], {"kind", "artifact", "adapter_version"}, "source")
    _require(source["kind"] in ("reviewed_voice_turn", "personality_turn"), "Unsupported source kind")
    _artifact(source["artifact"])
    _text(source["adapter_version"], "source.adapter_version")
    review = _object(value["review"], {"status", "scope"}, "review")
    _require(review["status"] in ("pending", "accepted_for_bounded_tts"), "Unsupported review status")
    if review["status"] == "pending":
        _require(review["scope"] is None, "Pending review must have null scope")
    else:
        _text(review["scope"], "review.scope")
    return deepcopy(value)


def export_reviewed_voice_turn(turn, source_artifact):
    """Pure projection matching Brain's exportReviewedVoiceTurn.

    The resulting accepted status records the input's claim only; consumers
    must call ``load_contract_turn`` to establish external review authority.
    """
    _require(type(turn) is dict and turn.get("schema") == "asuka.reviewed-voice-turn/1", "Unsupported reviewed turn")
    _artifact(source_artifact)
    try:
        condition = turn["condition"]
        selected = condition["candidate"]
        _object(selected, _EXPRESSION_KEYS, "reviewed condition.candidate")
        expression = {key: deepcopy(selected[key]) for key in _EXPRESSION_KEYS}
        instruction = compile_instruction(expression)
        _require(condition["text"] == turn["speech"] and condition["delivery"] == selected["delivery"]
                 and condition["details"] == selected["details"] and condition["instruct"] == instruction,
                 "Reviewed condition and chosen expression differ")
        _require(type(turn["admission"].get("semantic_accepted")) is bool,
                 "Reviewed semantic admission must be boolean")
        accepted = turn["admission"]["semantic_accepted"]
        projected = {
            "schema": SCHEMA,
            "identity": {key: turn[key] for key in ("conversation_id", "turn_id", "sequence", "speaker", "language")},
            "text": turn["speech"], "expression": expression,
            "condition": {"text": turn["speech"], "instruct": instruction},
            "source": {"kind": "reviewed_voice_turn", "artifact": deepcopy(source_artifact),
                       "adapter_version": EXPORT_ADAPTER_VERSION},
            "review": {"status": "accepted_for_bounded_tts" if accepted else "pending",
                       "scope": turn["admission"]["scope"] if accepted else None},
        }
    except (KeyError, TypeError) as exc:
        raise ExpressionContractError("Malformed reviewed turn projection") from exc
    return validate_contract(projected)


def _snapshot_json(raw):
    def pairs(entries):
        value = {}
        for key, item in entries:
            _require(key not in value, "Duplicate snapshot field: " + key)
            value[key] = item
        return value
    def invalid(value):
        raise ExpressionContractError("Non-finite snapshot number")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=invalid)
    except (UnicodeError, ValueError) as exc:
        if isinstance(exc, ExpressionContractError):
            raise
        raise ExpressionContractError("Invalid reviewed-turn snapshot JSON") from exc


def load_contract_turn(value):
    """Reopen the exact snapshot, verify original reviews, then return its turn.

    A contract cannot authorize itself. A reviewed general bundle has its own
    bound admission/source loader; the original pending candidate is unchanged.
    Unknown adapter versions are not interpreted optimistically.
    """
    contract = validate_contract(value)
    _require(contract["review"]["status"] == "accepted_for_bounded_tts",
             "Expression remains pending review", "review_pending")
    source = contract["source"]
    if source["kind"] == "personality_turn":
        from .general_reviewed import ADAPTER_VERSION, load_general_reviewed_turn, export_general_contract
        _require(source["adapter_version"] == ADAPTER_VERSION, "Unsupported general reviewed adapter", "unsupported_adapter")
        turn = load_general_reviewed_turn(source["artifact"])
        _require(export_general_contract(turn, source["artifact"]) == contract,
                 "Public expression differs from its bound general review", "projection_mismatch")
        return deepcopy(turn)
    _require(source["kind"] == "reviewed_voice_turn", "Unsupported reviewed source", "unsupported_source")
    _require(source["adapter_version"] == EXPORT_ADAPTER_VERSION, "Unsupported reviewed-turn exporter version", "unsupported_adapter")
    artifact = source["artifact"]
    try:
        raw = Path(artifact["path"]).read_bytes()
    except (OSError, ValueError) as exc:
        raise ExpressionContractError("Reviewed-turn snapshot is unavailable", "source_unavailable") from exc
    _require(hashlib.sha256(raw).hexdigest() == artifact["sha256"], "Reviewed-turn snapshot changed", "source_changed")
    turn = _snapshot_json(raw)
    # This follows original history, model outputs and external review files;
    # changing JSON status alone cannot make an unreviewed snapshot executable.
    verified = revalidate_reviewed_turn(turn)
    expected = export_reviewed_voice_turn(verified, artifact)
    _require(expected == contract, "Public expression differs from its authoritative reviewed turn", "projection_mismatch")
    return deepcopy(verified)
