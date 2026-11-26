"""Paths owned by one desktop profile."""
import os
from pathlib import Path


def configure_storage(directory,*,relationship=False):
    files = {'ASUKA_LOCAL_CONFIG': 'private/config.local.json',
        'ASUKA_QUALITY_CONFIG': 'quality.local.json', 'ASUKA_SETTINGS_PATH': 'settings.ini',
        'ASUKA_AUDIO_REPLAY_DIR': 'audio', 'ASUKA_TTS_DIAGNOSTICS_DIR': 'diagnostics',
        'ASUKA_INFERENCE_CONFIG': 'inference.local.json',
        'ASUKA_SECURITY_CONFIG': 'security.local.json', 'ASUKA_DIALOGUE_CONFIG': 'dialogue.local.json',
        'ASUKA_ROLE_CONFIG': 'role-settings.local.json',
        'ASUKA_DIALOGUE_STATE_DIR': 'sessions/.dialogue-state', 'ASUKA_PERSONALITY_SELECTION': 'personality.local.json',
        'ASUKA_PERSONALITY_LIBRARY': 'personality-library', 'ASUKA_PERSONALITY_STATE_FILE': 'personality-state.json',
        'ASUKA_NATIVE_STATE_FILE': 'native-state.json', 'ASUKA_AGENT_JOURNAL_DIR': 'agent-journal',
        'PI_AGENT_DIR': 'pi-agent', 'ASUKA_SESSION_DIR': 'sessions',
        'ASUKA_BRAIN_ERROR_LOG': 'logs/brain-errors.log', 'ASUKA_BRAIN_STARTUP_LOG': 'logs/brain-startup.log',
        'ASUKA_LLAMA_LOG': 'logs/llama.log', 'ASUKA_CLIENT_FAILURE_LOG': 'logs/client-failures.jsonl',
        'ASUKA_METRICS_PATH': 'logs/latency.jsonl', 'ASUKA_CRASH_LOG': 'logs/crash.log'}
    os.environ.update({key: str(Path(directory) / value) for key, value in files.items()})
    if relationship:
        relation=Path(directory)/'relationship'
        relation.mkdir(parents=True,exist_ok=True)
        os.environ['ASUKA_RELATIONSHIP_DIR']=str(relation)
        for key,value in {'ASUKA_SESSION_DIR':'sessions','ASUKA_DIALOGUE_STATE_DIR':'sessions/.dialogue-state',
                'ASUKA_PENDING_CHAT_DIR':'pending-chat','ASUKA_AUDIO_REPLAY_DIR':'audio',
                'ASUKA_AGENT_JOURNAL_DIR':'agent-journal','ASUKA_NATIVE_STATE_FILE':'native-state.json',
                'ASUKA_PERSONALITY_STATE_FILE':'personality-state.json'}.items():
            os.environ[key]=str(relation/value)
