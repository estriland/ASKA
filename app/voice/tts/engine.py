"""Independent reviewed-turn -> executable voice plan -> owned worker entry.

This engine consumes decisions from the existing personality/voice interpretation
pipeline. It never invents an emotion from node values or treats a manual voice
preference as semantic approval. No client, model or API loads on import.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import sys
import threading

from .engine_reviewed import revalidate_reviewed_turn
from .general_reviewed import revalidate_general_turn
from .expression_contract import SCHEMA as EXPRESSION_SCHEMA, load_contract_turn, validate_contract
from .reference_candidate import CandidateVoiceAdapter

CONFIG_SCHEMA = 'asuka.voice-engine-config/1'
PLAN_SCHEMA = 'asuka.voice-engine-plan/1'
SUBMISSION_SCHEMA = 'asuka.voice-engine-submission/1'
_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\Z')


class VoiceEngineError(ValueError):
    def __init__(self, message, code='invalid_input'):
        super().__init__(message)
        self.code = code


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf8')


def fingerprint(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def revalidate_turn(turn):
    kind = turn.get('provenance', {}).get('kind') if isinstance(turn, dict) else None
    if kind == 'reviewed_general_voice_analysis':
        return revalidate_general_turn(turn)
    if kind == 'reviewed_voice_analysis':
        return revalidate_reviewed_turn(turn)
    raise VoiceEngineError('Unsupported reviewed source kind', 'unsupported_source')


def _require(ok, message, code='invalid_input'):
    if not ok:
        raise VoiceEngineError(message, code)


def _file(proof):
    _require(isinstance(proof, dict) and set(proof) == {'path', 'sha256'}, 'Invalid source proof')
    path = Path(proof['path'])
    _require(path.is_absolute() and path.is_file(), 'Missing absolute source file')
    _require(isinstance(proof['sha256'], str) and re.fullmatch('[0-9a-f]{64}', proof['sha256']), 'Invalid source hash')
    with path.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    _require(actual == proof['sha256'], 'Source changed: ' + path.name, 'source_changed')
    return path


def validate_config(config):
    _require(isinstance(config, dict) and set(config) == {'schema','catalog','models','generation','subtalker','runtime','protected_sources'}, 'Invalid engine config')
    _require(config['schema'] == CONFIG_SCHEMA, 'Unknown config schema')
    # Limit this initial execution boundary to the already validated family.
    _require(config['generation'] == {'max_new_tokens':512,'min_new_tokens':2,'temperature':.9,'top_k':50,'top_p':1.0,'do_sample':True,'repetition_penalty':1.05,'eos_token_id':2150}, 'Unvalidated generation settings')
    _require(config['subtalker'] == {'do_sample':True,'top_k':50,'top_p':1.0,'temperature':.9}, 'Unvalidated predictor settings')
    _require(config['runtime'] == {'device':'cuda:0','dtype':'bfloat16','attention':'eager','max_seq_len':2048,'chunk_size':12}, 'Unvalidated runtime settings')
    models = config['models']
    _require(isinstance(models, dict) and set(models) == {'base','checkpoint','dependencies','speaker_name','speaker_id','lora_scale'}, 'Invalid model identity')
    for field in ['base','checkpoint','dependencies']:
        _require(isinstance(models[field], str) and Path(models[field]).is_absolute() and Path(models[field]).is_dir(), 'Missing local model/dependency directory: '+field)
    _require(models['speaker_name'] == 'asuka_calibrated_v4' and models['speaker_id'] == 3000 and models['lora_scale'] == 1.0, 'Unvalidated V4 speaker configuration')
    CandidateVoiceAdapter(config['catalog'])
    protected = config['protected_sources']
    _require(isinstance(protected, dict) and bool(protected), 'Source manifest is required')
    required = [Path(models['base'])/'model.safetensors',Path(models['base'])/'config.json',
                Path(models['base'])/'speech_tokenizer/model.safetensors',
                Path(models['checkpoint'])/'adapter_model.safetensors',
                Path(models['checkpoint'])/'speaker_embedding.safetensors',
                Path(models['checkpoint'])/'config.json']
    normalized = {str(Path(p).resolve()): h for p,h in protected.items()}
    _require(all(str(p.resolve()) in normalized for p in required), 'Model weights/config are not fully bound to hashes')
    for path, digest in protected.items():
        _file({'path':path,'sha256':digest})


class ReviewedCandidateAdapter(CandidateVoiceAdapter):
    """Same backend/reference checks, with real committed evidence instead of probes."""
    def plan(self, request, allow_experimental=False):
        route = super().plan(request, allow_experimental=allow_experimental)
        route['selection_reason'] = ('reviewed_text_condition' if route['backend']=='v4_custom'
                                     else 'explicit_reviewed_reference')
        return route

    def _context(self, request):
        evidence = request.get('evidence')
        _require(isinstance(evidence, dict) and set(evidence) == {'kind','turn_id','text_sha256','reviewed_turn','reviewed_turn_sha256','reference_binding'}, 'Invalid reviewed context')
        _require(evidence['kind'] == 'reviewed_voice_analysis', 'Diagnostic requests are not engine turns')
        turn = evidence['reviewed_turn']
        revalidate_turn(turn)
        _require(fingerprint(turn) == evidence['reviewed_turn_sha256'], 'Reviewed turn fingerprint differs')
        _require(evidence['turn_id'] == request['turn_id'] == turn['turn_id'], 'Turn identity differs')
        _require(request['text'] == turn['speech'] == turn['condition']['text'], 'Reply/condition text differs')
        _require(evidence['text_sha256'] == hashlib.sha256(turn['speech'].encode('utf8')).hexdigest(), 'Spoken text hash differs')
        _require(request['language'] == turn['language'] and request['speaker'] == turn['speaker'], 'Language or speaker differs')
        _require(request.get('instruct') == turn['condition']['instruct'], 'Compiled voice condition was changed')
        _require(request.get('purpose') == 'reviewed_dialogue', 'Wrong request purpose')
        binding = evidence['reference_binding']
        profile_id = request.get('profile_id')
        profile = self._catalog['profiles'].get(profile_id)
        _require(profile is not None, 'Unknown voice profile')
        if profile['backend'] == 'base_clone':
            _require(binding is not None, 'Selected Base voice cannot execute text instructions; an explicit reviewed reference binding is required', 'unsupported_condition')
            path = _file(binding)
            body = json.loads(path.read_text(encoding='utf8'))
            _require(body.get('schema') == 'asuka.voice-reference-binding/1' and body.get('accepted') is True, 'Reference match is not reviewed')
            _require(body.get('reviewed_turn_sha256') == fingerprint(turn) and body.get('profile_id') == profile_id
                     and body.get('reference_id') == profile['reference_id'], 'Reference binding belongs to a different turn/voice')
            _require(isinstance(body.get('basis'), str) and body['basis'].strip(), 'Reference match requires a semantic basis')
            _require(isinstance(body.get('evidence'), list) and body['evidence'], 'Reference match requires sources')
            for source in body['evidence']:
                _file(source)
        else:
            _require(binding is None, 'V4 text conditions do not use a Base reference binding')
        return deepcopy(evidence)


def prepare_submission(reviewed_turn, config, request_id, *, profile_id='ordinary',
                       selection_snapshot=None, reference_binding=None, seed=None):
    """Prepare a whole reply once. No choice/condition changes after submission."""
    _require(isinstance(request_id,str) and _ID.fullmatch(request_id), 'Invalid request identity')
    expression_contract = None
    if isinstance(reviewed_turn, dict) and reviewed_turn.get('schema') == EXPRESSION_SCHEMA:
        expression_contract = validate_contract(reviewed_turn)
        reviewed_turn = load_contract_turn(expression_contract)
    validate_config(config)
    revalidate_turn(reviewed_turn)
    turn = deepcopy(reviewed_turn)
    _require(isinstance(profile_id,str) and profile_id in config['catalog']['profiles'], 'Unknown voice profile')
    if selection_snapshot is not None:
        _require(isinstance(selection_snapshot,dict) and set(selection_snapshot)=={
            'schema','scope_id','preset_id','profile_id','revision','persisted','catalog_sha256',
            'presets_sha256','updated_at','mutation_id'}, 'Invalid selection snapshot')
        _require(selection_snapshot['schema']=='asuka.manual-voice-selection/1'
                 and {'natural':'ordinary','youthful':'general_a','soft_close':'gentle_close'}.get(selection_snapshot['preset_id'])==profile_id,
                 'Selection preset and profile differ')
        _require(type(selection_snapshot['revision']) is int and selection_snapshot['revision']>=0
                 and type(selection_snapshot['persisted']) is bool, 'Invalid selection revision')
        _require(isinstance(selection_snapshot['presets_sha256'],str) and re.fullmatch('[0-9a-f]{64}',selection_snapshot['presets_sha256']), 'Invalid preset configuration fingerprint')
        if selection_snapshot['persisted']:
            _require(selection_snapshot['revision']>0 and isinstance(selection_snapshot['updated_at'],str)
                     and bool(selection_snapshot['updated_at']) and isinstance(selection_snapshot['mutation_id'],str)
                     and bool(selection_snapshot['mutation_id']), 'Persisted choice is incomplete')
        else:
            _require(selection_snapshot['revision']==0 and selection_snapshot['updated_at'] is None
                     and selection_snapshot['mutation_id'] is None, 'Default choice is inconsistent')
        _require(selection_snapshot.get('profile_id') == profile_id and selection_snapshot.get('scope_id') == turn['conversation_id'], 'Selection belongs to a different voice or conversation')
        _require(selection_snapshot.get('catalog_sha256') == fingerprint(config['catalog']), 'Selection catalog changed')
    if seed is None:
        seed = int(hashlib.sha256(request_id.encode('utf8')).hexdigest()[:8], 16)
    _require(type(seed) is int and 0 <= seed < 2**63, 'Invalid synthesis seed')
    evidence = {'kind':'reviewed_voice_analysis','turn_id':turn['turn_id'],
                'text_sha256':hashlib.sha256(turn['speech'].encode('utf8')).hexdigest(),
                'reviewed_turn':turn,'reviewed_turn_sha256':fingerprint(turn),
                'reference_binding':deepcopy(reference_binding)}
    request = {'text':turn['speech'],'language':turn['language'],'speaker':turn['speaker'],
               'turn_id':turn['turn_id'],'profile_id':profile_id,'purpose':'reviewed_dialogue',
               'instruct':turn['condition']['instruct'],'evidence':evidence}
    route = ReviewedCandidateAdapter(config['catalog']).plan(request, allow_experimental=True)
    _require(route['profile_id'] == profile_id, 'Selected voice cannot execute the request; no implicit fallback', 'unsupported_condition')
    condition_mode = 'text_instruction' if route['backend']=='v4_custom' else 'reviewed_reference_style'
    plan = {'schema':PLAN_SCHEMA,'request_id':request_id,'config_sha256':fingerprint(config),
            'conversation_id':turn['conversation_id'],'turn_id':turn['turn_id'],'sequence':turn['sequence'],
            'seed':seed,'selection_snapshot':deepcopy(selection_snapshot),'route_plan':route,
            'speech_plan':{'text':turn['speech'],'language':turn['language'],'speaker':turn['speaker'],
                           'conditioning_method':condition_mode,'requested_instruct':turn['condition']['instruct'],
                           'actual_instruct':route['actual_instruct'],'reference_binding':deepcopy(reference_binding),
                           'semantic_admission':deepcopy(turn['admission']), 'whole_reply_voice_frozen':True}}
    if expression_contract is not None:
        # Retain the public source proof so worker-time validation detects a
        # changed snapshot too, instead of discarding it after normalization.
        plan['expression_contract'] = expression_contract
    plan['plan_sha256']=fingerprint(plan)
    return {'schema':SUBMISSION_SCHEMA,'request_id':request_id,'plan':plan,'config':deepcopy(config)}


def validate_submission(submission):
    _require(isinstance(submission,dict) and set(submission)=={'schema','request_id','plan','config'} and submission['schema']==SUBMISSION_SCHEMA, 'Invalid submission')
    plan = submission['plan']
    _require(isinstance(plan,dict) and plan.get('schema')==PLAN_SCHEMA, 'Invalid speech plan')
    _require(plan.get('plan_sha256')==fingerprint({k:v for k,v in plan.items() if k!='plan_sha256'}),
             'Prepared speech plan was changed', 'source_changed')
    try:
        route = plan['route_plan']; evidence=route['request']['evidence']
        expected = prepare_submission(plan.get('expression_contract', evidence['reviewed_turn']),submission['config'],submission['request_id'],
            profile_id=route['requested_profile_id'],selection_snapshot=plan['selection_snapshot'],
            reference_binding=evidence['reference_binding'],seed=plan['seed'])
    except (KeyError,TypeError) as exc:
        raise VoiceEngineError('Incomplete speech plan') from exc
    _require(expected==submission, 'Submission changed after planning', 'source_changed')


def load_plan_reference(submission):
    validate_submission(submission)
    return ReviewedCandidateAdapter(submission['config']['catalog']).load_reference(submission['plan']['route_plan'])


class VoiceEngine:
    """Single active task entry, with durable results and no automatic replay."""
    def __init__(self, config, artifact_root, *, python_path=None, presets=None):
        validate_config(config)
        self.config=deepcopy(config);self.root=Path(artifact_root).resolve()
        self.python_path=str(Path(python_path or sys.executable).resolve());self._active=None
        self._lock=threading.RLock();self._closed=False
        self._choices=None
        if presets is not None:
            from .voice_presets import VoicePresetController
            self._choices=VoicePresetController(self.config['catalog'],presets,self.root/'choices')

    def select_voice(self, scope_id, preset_id, expected_revision, mutation_id):
        with self._lock:
            _require(not self._closed,'Engine is closed','closed')
            _require(self._choices is not None,'No presets configured')
            return self._choices.select(scope_id,preset_id,expected_revision,mutation_id)

    def prepare(self, reviewed_turn, request_id, *, reference_binding=None, seed=None):
        with self._lock:
            _require(not self._closed,'Engine is closed','closed')
            normalized = (load_contract_turn(reviewed_turn) if isinstance(reviewed_turn, dict)
                          and reviewed_turn.get('schema') == EXPRESSION_SCHEMA else reviewed_turn)
            selection=self._choices.get_selection(normalized['conversation_id']) if self._choices else None
        profile=selection['profile_id'] if selection else 'ordinary'
        return prepare_submission(reviewed_turn,self.config,request_id,profile_id=profile,
                                  selection_snapshot=selection,reference_binding=reference_binding,seed=seed)

    def submit(self, submission):
        from .engine_session import VoiceEngineSession
        validate_submission(submission)
        _require(submission['config']==self.config,'Submission belongs to another engine configuration')
        with self._lock:
            _require(not self._closed,'Engine is closed','closed')
            if self._active is not None:
                state=self._active.snapshot()
                _require(not state.get('worker_alive') and state.get('status') in {'completed','cancelled','failed'},'Another speech task has not terminated','busy')
            worker=Path(__file__).with_name('engine_worker').with_suffix(Path(__file__).suffix)
            command=[self.python_path,'-B','-X','utf8',str(worker)]
            session=VoiceEngineSession(submission,command,self.root/'tasks')
            session.start()
            self._active=session
            return session

    def recover(self):
        from .engine_session import VoiceEngineSession
        return VoiceEngineSession.recover(self.root/'tasks')

    def close(self):
        with self._lock:
            self._closed=True
            active=self._active
        if active is not None:return active.close()
        return None
