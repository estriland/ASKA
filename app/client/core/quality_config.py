"""Optional high-quality desktop wiring; local paths contain no credentials."""
from __future__ import annotations
import json
import os
from pathlib import Path
from core.app_config import PROJECT_ROOT

QUALITY_MODES = {'general_quality', 'general_fast', 'general_auto'}

def config_path():
    return Path(os.environ.get('ASUKA_QUALITY_CONFIG', PROJECT_ROOT / 'client' / 'quality.local.json')).resolve()

def load_quality_config():
    file = config_path()
    if not file.is_file():
        return None
    value = json.loads(file.read_text(encoding='utf-8'))
    if value.get('schema') != 'asuka.desktop-quality/1':
        raise ValueError('高质量版配置格式不正确')
    result = dict(value)
    for key in ('voice_config', 'voice_presets'):
        target = Path(value[key])
        result[key] = str((target if target.is_absolute() else file.parent / target).resolve())
    return result

def load_voice_configuration(settings=None):
    settings = settings if settings is not None else load_quality_config()
    if settings is None:
        raise RuntimeError('尚未准备高质量版资源配置')
    if settings.get('asset_layout') == 'project-relative/1':
        from core.local_voice_assets import read_voice_template
        config = read_voice_template(settings['voice_config'])
    else:
        config = json.loads(Path(settings['voice_config']).read_text(encoding='utf-8'))
    presets = json.loads(Path(settings['voice_presets']).read_text(encoding='utf-8'))
    return config, presets
