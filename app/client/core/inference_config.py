"""Non-secret inference preferences, shared with the Brain; no QSettings duplication."""
import json
import os
from pathlib import Path
from core.app_config import PROJECT_ROOT

CONFIG_PATH = Path(os.environ.get('ASUKA_INFERENCE_CONFIG', PROJECT_ROOT / 'client/inference.local.json'))
DEFAULT_PATH = PROJECT_ROOT / 'brain/inference-defaults.json'
DEEPSEEK_MODELS = json.loads((PROJECT_ROOT / 'brain/deepseek-models.json').read_text(encoding='utf-8'))


def load_inference(path=CONFIG_PATH):
    defaults = json.loads(DEFAULT_PATH.read_text(encoding='utf-8'))
    if Path(path).exists():
        saved = json.loads(Path(path).read_text(encoding='utf-8'))
        for key in defaults:
            defaults[key].update(saved.get(key, {}))
        # File-based users may keep editor metadata or another extension here.
        # Preserve it on UI save; it is not an arbitrary API payload override.
        for key in saved.keys() - defaults.keys():
            defaults[key] = saved[key]
    else:
        # Preserve previously hand-edited context budgets on first migration.
        policy = json.loads((PROJECT_ROOT / 'brain/personality/shin-dev/context-policy.json').read_text(encoding='utf-8'))
        for key in ('analysis', 'reply'):
            defaults[key]['context_window'] = policy[key + '_window']
            defaults[key]['max_tokens'] = policy['output_reserve']
        for key in ('trigger', 'target', 'image_reserve'):
            defaults['compression'][key] = policy[key]
    return defaults


def save_inference(config, path=CONFIG_PATH):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def stage_vision(config, mode, current_vision, custom=None, local_vision=False):
    phases = ('analysis', 'reply') if mode == 'deep_dive_shin' else ('light',)
    if mode == 'deep_dive':
        return current_vision
    for phase in phases:
        model = config[phase]['model']
        if model == 'current':
            vision = current_vision
        elif model.startswith('deepseek/'):
            vision = any(m['id'] == model.split('/', 1)[1] and m['vision'] for m in DEEPSEEK_MODELS)
        elif model.startswith('custom-api/'):
            vision = bool(custom and custom['supports_vision'] and model == 'custom-api/' + custom['model_id'])
        else:
            vision = model == 'local/qwen' and local_vision
        if not vision:
            return False
    return True
