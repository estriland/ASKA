"""Read-only general-source adapter for the existing reviewed-turn voice path.

This module verifies one immutable general bundle against the external
bounded-TTS admission, then reuses the public voice-expression shape. It does
not write audio, call a model, or approve personality/training/production.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import re

ADAPTER_VERSION = 'asuka.general-reviewed-voice-adapter/1'
TURN_SCHEMA = 'asuka.reviewed-voice-turn/1'
GENERAL_SOURCE_SCHEMA = 'asuka.general-voice-turn/1'
GENERAL_PERSONALITY_ADAPTER = 'asuka.general-personality-voice-adapter/1'
GENERAL_READING_ADAPTER = 'asuka.general-personality-voice-adapter/2'
BUNDLE_SCHEMA = 'asuka.general-voice-execution-source/1'
ADMISSION_SCHEMA = 'asuka.general-voice-bounded-admission/1'
BINDINGS_SCHEMA = 'asuka.general-voice-source-bindings/1'
VOICE_EXPRESSION_SCHEMA = 'asuka.voice-expression/1'
_SHA = re.compile(r'[0-9a-f]{64}\Z')
_ECMA_WS = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


class GeneralReviewedVoiceError(ValueError):
    def __init__(self, message, code='invalid_general_reviewed_voice'):
        super().__init__(message)
        self.code = code


def _require(ok, message, code='invalid_general_reviewed_voice'):
    if not ok:
        raise GeneralReviewedVoiceError(message, code)


def _object(value, field):
    _require(isinstance(value, dict), field + ' must be an object')
    return value


def _exact(value, keys, field):
    _object(value, field)
    _require(set(value) == set(keys), field + ' has unexpected or missing fields')
    return value


def _text(value, field):
    _require(isinstance(value, str) and bool(value.strip(_ECMA_WS)), field + ' must be nonempty text')
    return value


def _integer(value, field):
    _require(type(value) is int and value >= 1, field + ' must be a positive integer')
    return value


def _hash(value, field):
    _require(isinstance(value, str) and _SHA.fullmatch(value) is not None, field + ' must be lowercase SHA-256')
    return value


def _proof(value, field='proof'):
    _exact(value, {'path', 'sha256'}, field)
    path = Path(_text(value['path'], field + '.path'))
    _require(path.is_absolute(), field + '.path must be absolute')
    _hash(value['sha256'], field + '.sha256')
    return {'path': str(path), 'sha256': value['sha256']}


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _hash_json(value):
    return hashlib.sha256(_canonical(value).encode('utf8')).hexdigest()


def _pairs(entries):
    result = {}
    for key, value in entries:
        _require(key not in result, 'Duplicate JSON key: ' + key)
        result[key] = value
    return result


def _invalid_constant(_value):
    raise GeneralReviewedVoiceError('Non-finite JSON number')


def _parse(raw):
    def finite_float(value):
        number = float(value)
        _require(math.isfinite(number), 'Non-finite JSON number')
        return number
    try:
        return json.loads(raw.decode('utf-8-sig'), object_pairs_hook=_pairs,
                          parse_constant=_invalid_constant, parse_float=finite_float)
    except (UnicodeError, ValueError) as exc:
        if isinstance(exc, GeneralReviewedVoiceError):
            raise
        raise GeneralReviewedVoiceError('Invalid JSON evidence') from exc


class _Evidence:
    def __init__(self):
        self.dependencies = {}

    def read(self, proof, field='proof'):
        proof = _proof(proof, field)
        path = Path(proof['path'])
        try:
            data = path.read_bytes()
        except OSError as exc:
            raise GeneralReviewedVoiceError('Unavailable evidence: ' + path.name) from exc
        digest = hashlib.sha256(data).hexdigest()
        _require(digest == proof['sha256'], 'Evidence checksum mismatch: ' + path.name)
        previous = self.dependencies.get(str(path))
        _require(previous is None or previous == digest, 'Evidence changed during read: ' + path.name)
        self.dependencies[str(path)] = digest
        return _parse(data)

    def dependencies_list(self):
        return [{'path': p, 'sha256': h} for p, h in sorted(self.dependencies.items())]


def _find_file(files, name, folder):
    matches = [p for p in files if Path(p).parent == folder and Path(p).name == name]
    _require(len(matches) == 1, 'Expected exactly one ' + name + ' beside completed.json')
    return matches[0]


def _reading_state(evidence, source):
    files = source['provenance']['files']
    completed = [p for p in files if Path(p).name == 'completed.json' and Path(p).parent.name == source['identity']['turn_id']]
    _require(len(completed) == 1, 'Reading source completion is ambiguous')
    folder = Path(completed[0]).parent
    reading_path = _find_file(files, 'expression-projection.json', folder)
    reading = evidence.read({'path': reading_path, 'sha256': files[reading_path]}, 'expression reading')
    _require(reading.get('reading_profile') == 'scoped_state_v1', 'Unsupported shared reading')
    _require(reading.get('source_context_sha256') == _hash_json(source['context']), 'Reading context changed')
    view = _object(reading.get('view'), 'reading.view')
    _require(reading.get('view_sha256') == _hash_json(view), 'Reading view changed')
    _require(view.get('subject') == source['context'].get('subject'), 'Reading subject differs')
    for name in ('所用量的含义', '对象索引', '对象归属与事件时间', '本轮读数'):
        _require(isinstance(view.get(name), list), 'Reading dictionary/rows missing')
    return {key: value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
            for key, value in view.items() if key not in {'subject', '当前事实', '情境对象'} and not (isinstance(value, str) and not value.strip())}


def _verify_shared_reading_and_adjacency(evidence, source, context_doc, commit):
    _require(context_doc['personality']['current'] == _reading_state(evidence, source), 'Current voice state differs from shared reading')
    identity = source['identity']
    if identity['sequence'] == 1:
        _require(context_doc['personality']['previous'] is None, 'First voice turn has a predecessor')
        return
    files = source['provenance']['files']
    bridge_paths = [p for p in files if Path(p).name == 'adjacency.json']
    _require(len(bridge_paths) == 1, 'Current voice source needs one adjacency proof')
    bridge = evidence.read({'path': bridge_paths[0], 'sha256': files[bridge_paths[0]]}, 'adjacency')
    _require(bridge.get('schema') == 'asuka.general-voice-adjacency/1', 'Unsupported adjacency proof')
    previous = evidence.read(bridge['previous_source'], 'previous voice source')
    previous_identity = previous['identity']
    _require(previous_identity['conversation_id'] == identity['conversation_id'] and previous_identity['sequence'] == identity['sequence'] - 1, 'Non-adjacent voice source')
    _require(previous['context']['namespace'] == source['context']['namespace'] == bridge['namespace'], 'Voice adjacency namespace differs')
    old_files = previous['provenance']['files']
    old_completed = [p for p in old_files if Path(p).name == 'completed.json' and Path(p).parent.name == previous_identity['turn_id']]
    _require(len(old_completed) == 1, 'Previous completion is ambiguous')
    old_folder = Path(old_completed[0]).parent
    for name, expected in [('completed.json', previous['completion']), ('prepared.json', None)]:
        p = _find_file(old_files, name, old_folder)
        actual = evidence.read({'path': p, 'sha256': old_files[p]}, 'previous '+name)
        _require((actual if expected is not None else actual.get('context')) == (expected if expected is not None else previous['context']), 'Previous source changed')
    _require(context_doc['personality']['previous'] == _reading_state(evidence, previous), 'Previous voice state differs from shared reading')
    _require(context_doc['personality']['previous_sequence'] == previous_identity['sequence'], 'Previous voice sequence differs')
    _require(bridge['from'] == {'turn': previous_identity['turn_id'], 'sequence': previous_identity['sequence'], 'revision': previous['completion']['revision']}, 'Adjacency start differs')
    _require(bridge['to'] == {'turn': identity['turn_id'], 'sequence': identity['sequence'], 'revision': source['context']['base_revision']}, 'Adjacency end differs')
    last = evidence.read(bridge['anchor']['proof'], 'adjacency anchor')
    _require(last == bridge['anchor']['commit'] and last['revision'] == bridge['from']['revision'], 'Adjacency anchor differs')
    _require(len(bridge['steps']) == bridge['to']['revision'] - bridge['from']['revision'], 'Adjacency revision gap')
    for step in bridge['steps']:
        current = evidence.read(step['commit_proof'], 'adjacency commit')
        _require(current == step['commit'] and current['revision'] == last['revision'] + 1 and current['previous'] == _hash_json(last), 'Broken adjacency chain')
        transaction = current['transaction_id']; owner = previous_identity['turn_id']
        _require(step['kind'] == 'delivery' and transaction == 'chat-delivery:' + owner or step['kind'] == 'automatic' and transaction.startswith('auto:' + owner + ':'), 'Unrelated intervening transaction')
        intent = evidence.read(step['intent_proof'], 'adjacency intent')
        _require(_hash_json(intent) == current['intent_sha256'] and intent['transaction_id'] == transaction and intent['base_revision'] == last['revision'], 'Adjacency intent differs')
        last = current
    _require(commit['revision'] == last['revision'] + 1 and commit['previous'] == _hash_json(last), 'Current commit does not extend adjacency')


def load_general_reviewed_turn(artifact):
    artifact = _proof(artifact, 'artifact')
    evidence = _Evidence()
    bundle = evidence.read(artifact, 'bundle')
    _exact(bundle, {'schema', 'id', 'source', 'context', 'candidate', 'admission', 'bindings'}, 'bundle')
    _require(bundle['schema'] == BUNDLE_SCHEMA, 'Unsupported general execution bundle')
    bundle_id = _text(bundle['id'], 'bundle.id')
    source = evidence.read(bundle['source'], 'source')
    context_doc = evidence.read(bundle['context'], 'context')
    candidate = evidence.read(bundle['candidate'], 'candidate')
    admission = evidence.read(bundle['admission'], 'admission')
    bindings = evidence.read(bundle['bindings'], 'bindings')

    _exact(source, {'schema', 'identity', 'text', 'translation', 'dialogue', 'completion', 'context', 'provenance'}, 'source')
    _require(source['schema'] == GENERAL_SOURCE_SCHEMA, 'Unsupported general voice source')
    identity = _exact(source['identity'], {'conversation_id', 'turn_id', 'sequence', 'speaker', 'language'}, 'source.identity')
    for key in ('conversation_id', 'turn_id', 'speaker', 'language'):
        _text(identity[key], 'source.identity.' + key)
    _integer(identity['sequence'], 'source.identity.sequence')
    text = _text(source['text'], 'source.text')
    _require(isinstance(source['translation'], str), 'source.translation must be a string')
    _exact(source['dialogue'], {'user', 'prior_turns'}, 'source.dialogue')
    user = _text(source['dialogue']['user'], 'source.dialogue.user')
    _require(isinstance(source['dialogue']['prior_turns'], list), 'source.dialogue.prior_turns must be an array')
    completion = _object(source['completion'], 'source.completion')
    _object(source['context'], 'source.context')
    _exact(source['provenance'], {'files', 'commit', 'finalized_sha256', 'admission', 'voice_mapping_review'}, 'source.provenance')
    files = source['provenance']['files']
    _require(isinstance(files, dict) and files, 'source.provenance.files must be nonempty')
    for path, digest in files.items():
        _hash(digest, 'source.provenance.files')
        evidence.read({'path': path, 'sha256': digest}, 'source.provenance.files')
    _hash(source['provenance']['finalized_sha256'], 'source.provenance.finalized_sha256')
    _object(source['provenance']['commit'], 'source.provenance.commit')

    _object(context_doc, 'context')
    _require(isinstance(context_doc.get('schema'), str) and context_doc['schema'].strip(), 'context.schema is required')
    _require(context_doc.get('identity') == identity, 'context.identity differs from source.identity')
    _require(context_doc.get('text') == text, 'context.text differs from source.text')
    _object(context_doc.get('personality'), 'context.personality')
    _object(context_doc['personality'].get('current'), 'context.personality.current')
    _require('previous' in context_doc['personality'] and
             (context_doc['personality']['previous'] is None or isinstance(context_doc['personality']['previous'], dict)),
             'context.personality.previous must preserve the prior state or null')

    from .expression_contract import validate_contract, compile_instruction
    candidate = validate_contract(candidate)
    _require(candidate['schema'] == VOICE_EXPRESSION_SCHEMA, 'Unsupported voice expression')
    _require(candidate['identity'] == identity, 'candidate.identity differs from source.identity')
    _require(candidate['text'] == text, 'candidate.text differs from source.text')
    _require(candidate['source']['kind'] == 'personality_turn', 'candidate source kind must be personality_turn')
    _require(candidate['source']['artifact'] == bundle['source'], 'candidate source artifact differs from bundle')
    _require(candidate['source']['adapter_version'] in (GENERAL_PERSONALITY_ADAPTER, GENERAL_READING_ADAPTER), 'Unexpected personality adapter version')
    _require(candidate['review'] == {'status': 'pending', 'scope': None}, 'Original candidate review must remain pending')
    expression = candidate['expression']
    instruct = compile_instruction(expression)
    _require(candidate['condition'] == {'text': text, 'instruct': instruct}, 'candidate condition differs from its expression')

    _exact(admission, {'schema', 'scope', 'reviewer', 'authorization', 'training_approved', 'production_approved', 'items'}, 'admission')
    _require(admission['schema'] == ADMISSION_SCHEMA, 'Unsupported bounded admission')
    scope = _text(admission['scope'], 'admission.scope')
    _require(admission['reviewer'] == 'primary_assistant', 'Unexpected admission reviewer')
    _text(admission['authorization'], 'admission.authorization')
    _require(admission['training_approved'] is False and admission['production_approved'] is False, 'Admission must not approve training or production')
    _require(isinstance(admission['items'], list), 'admission.items must be an array')
    matched, seen = [], set()
    for row in admission['items']:
        _object(row, 'admission.items')
        _require(_text(row['id'], 'admission.items.id') not in seen, 'Duplicate admission item id')
        seen.add(row['id'])
        if row['id'] == bundle_id:
            matched.append(row)
    _require(len(matched) == 1, 'Expected exactly one admission item for bundle id')
    row = matched[0]
    _require(row['source'] == bundle['source'] and row['context'] == bundle['context'] and
             row['candidate'] == bundle['candidate'] and row['bindings'] == bundle['bindings'],
             'Admission proof does not belong to this bundle')
    _require(row['decision'] == 'accepted_for_bounded_tts', 'Admission is not accepted for bounded TTS')
    _require(row['purpose'] in ('automatic_condition', 'neutral_control'), 'Unsupported admission purpose')
    _text(row['notes'], 'admission.notes')

    _exact(bindings, {'schema', 'identity', 'source', 'context', 'dependencies', 'original_native_voice_approval', 'source_and_adjacent_verified'}, 'bindings')
    _require(bindings['schema'] == BINDINGS_SCHEMA, 'Unsupported source bindings')
    _require(bindings['identity'] == identity and bindings['source'] == bundle['source'] and bindings['context'] == bundle['context'], 'Bindings identity/proofs differ')
    _require(bindings['original_native_voice_approval'] is False and bindings['source_and_adjacent_verified'] is True, 'Bindings admission flags are invalid')
    _require(isinstance(bindings['dependencies'], list) and bindings['dependencies'], 'bindings.dependencies must be a nonempty array')
    for dep in bindings['dependencies']:
        evidence.read(dep, 'bindings.dependencies')

    turn_id = identity['turn_id']
    _require(re.fullmatch(r'turn-\d{6}', turn_id) and int(turn_id[5:]) == identity['sequence'], 'Turn sequence differs')
    completed_paths = [p for p in files if Path(p).name == 'completed.json' and
                       Path(p).parent.name == turn_id and Path(p).parent.parent.name == 'turns']
    _require(len(completed_paths) == 1, 'Expected exactly one completed.json for turn')
    completed_path = Path(completed_paths[0])
    folder = completed_path.parent
    reply_path = _find_file(files, 'reply.json', folder)
    prepared_path = _find_file(files, 'prepared.json', folder)
    input_path = _find_file(files, 'input.json', folder)
    completed = evidence.read({'path': str(completed_path), 'sha256': files[str(completed_path)]}, 'completed')
    reply = evidence.read({'path': str(reply_path), 'sha256': files[str(reply_path)]}, 'reply')
    prepared = evidence.read({'path': str(prepared_path), 'sha256': files[str(prepared_path)]}, 'prepared')
    input_row = evidence.read({'path': str(input_path), 'sha256': files[str(input_path)]}, 'input')
    _require(completed == completion, 'completed.json differs from source.completion')
    _require(completed.get('id') == turn_id, 'Completion belongs to another turn')
    _require(completed.get('text') == reply.get('text') == text, 'Committed reply text differs')
    _require(input_row.get('text') == user, 'input text differs from source dialogue user')
    prepared_context = _object(prepared.get('context'), 'prepared.context')
    _require(prepared_context == source['context'], 'prepared.context differs from source.context')
    _require(prepared_context.get('namespace', {}).get('conversation_id') == identity['conversation_id'], 'Prepared namespace differs')
    _require(prepared_context.get('approved_for_voice') is False, 'Prepared context must remain unapproved for voice')

    native = folder.parents[1] / 'engine' / 'session'
    tx = _hash_json({'transaction': turn_id})
    finalized_path = native / 'finalized' / (tx + '.json')
    finalized = evidence.read({'path': str(finalized_path), 'sha256': source['provenance']['finalized_sha256']}, 'finalized')
    final_reply = _object(finalized.get('finalization', {}).get('reply'), 'finalized.reply')
    _require(final_reply.get('text') == text and final_reply.get('id') == 'assistant-' + turn_id, 'Finalized reply differs')
    commits_dir = native / 'commits'
    _require(commits_dir.is_dir(), 'Native commits directory is unavailable')
    commits = []
    for path in sorted(commits_dir.glob('*.json')):
        data = path.read_bytes()
        commits.append(evidence.read({'path': str(path), 'sha256': hashlib.sha256(data).hexdigest()}, 'commit'))
    matches = [c for c in commits if c.get('transaction_id') == turn_id]
    _require(len(matches) == 1, 'Expected exactly one committed transaction')
    commit = matches[0]
    _require(commit == source['provenance']['commit'], 'Committed transaction differs from source.provenance.commit')
    _integer(commit.get('revision'), 'commit.revision')
    _integer(completed.get('revision'), 'completed.revision')
    _require(commit.get('revision') == prepared_context.get('candidate_revision'), 'Commit revision differs from prepared candidate revision')
    _require(commit.get('revision') <= completed.get('revision'), 'Commit revision exceeds completion revision')
    if candidate['source']['adapter_version'] == GENERAL_READING_ADAPTER:
        _verify_shared_reading_and_adjacency(evidence, source, context_doc, commit)

    return {
        'schema': TURN_SCHEMA,
        'conversation_id': identity['conversation_id'],
        'turn_id': turn_id,
        'sequence': identity['sequence'],
        'speech': text,
        'translation': source['translation'],
        'language': identity['language'],
        'speaker': identity['speaker'],
        'user': user,
        'personality': {
            'current': deepcopy(context_doc['personality']['current']),
            'previous': deepcopy(context_doc['personality']['previous']),
            'source_context': deepcopy(bundle['context']),
        },
        'condition': {
            'text': text,
            'instruct': instruct,
            'delivery': deepcopy(expression['delivery']),
            'details': deepcopy(expression['details']),
            'candidate': deepcopy(expression),
            'representation': row['purpose'],
            'original_candidate': deepcopy(expression),
        },
        'admission': {
            'semantic_accepted': True,
            'scope': scope,
            'source_scope': 'bounded_general_voice_alignment',
            'review_note': row['notes'],
            'acoustic_approved': False,
            'training_ready': False,
            'production_approved': False,
        },
        'provenance': {
            'kind': 'reviewed_general_voice_analysis',
            'entries': {'bundle': artifact},
            'dependencies': evidence.dependencies_list(),
        },
    }


def revalidate_general_turn(turn):
    _exact(turn, {'schema', 'conversation_id', 'turn_id', 'sequence', 'speech', 'translation', 'language',
                  'speaker', 'user', 'personality', 'condition', 'admission', 'provenance'}, 'turn')
    _require(turn.get('schema') == TURN_SCHEMA, 'Unsupported reviewed turn')
    provenance = _exact(turn['provenance'], {'kind', 'entries', 'dependencies'}, 'provenance')
    _require(provenance['kind'] == 'reviewed_general_voice_analysis', 'Unexpected provenance kind')
    entries = _object(provenance['entries'], 'provenance.entries')
    _require(set(entries) == {'bundle'}, 'Only the bundle entry is supported')
    rebuilt = load_general_reviewed_turn(entries['bundle'])
    _require(_canonical(rebuilt) == _canonical(turn), 'General reviewed turn changed after preparation')
    return deepcopy(rebuilt)


def export_general_contract(turn, artifact):
    from .expression_contract import SCHEMA, validate_contract, compile_instruction
    _object(turn, 'turn')
    _require(turn.get('schema') == TURN_SCHEMA, 'Unsupported reviewed turn')
    condition = _object(turn.get('condition'), 'condition')
    expression = deepcopy(condition.get('candidate'))
    _object(expression, 'condition.candidate')
    contract = {
        'schema': SCHEMA,
        'identity': {key: turn[key] for key in ('conversation_id', 'turn_id', 'sequence', 'speaker', 'language')},
        'text': turn['speech'],
        'expression': expression,
        'condition': {'text': turn['speech'], 'instruct': compile_instruction(expression)},
        'source': {'kind': 'personality_turn', 'artifact': _proof(artifact, 'artifact'), 'adapter_version': ADAPTER_VERSION},
        'review': {'status': 'accepted_for_bounded_tts', 'scope': _text(turn['admission'].get('scope'), 'admission.scope')},
    }
    return validate_contract(contract)
