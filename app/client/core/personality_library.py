"""Immutable, data-only personality files and selection for the next Brain boot."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from uuid import uuid4
from core.app_config import PROJECT_ROOT, NODE_EXE

LIBRARY = Path(os.environ.get('ASUKA_PERSONALITY_LIBRARY', PROJECT_ROOT / 'data/personality/packages'))
SELECTION = Path(os.environ.get('ASUKA_PERSONALITY_SELECTION', PROJECT_ROOT / 'client/personality.local.json'))
LIMIT = 10 * 1024 * 1024


def selection():
    value = json.loads(SELECTION.read_text(encoding='utf-8')) if SELECTION.exists() else {}
    if not isinstance(value, dict):
        raise ValueError('人格选择记录必须为对象；未覆盖原文件')
    result = {kind: value.get(kind) for kind in ('light', 'native')}
    if any(v is not None and (not isinstance(v, str) or not re.fullmatch('[a-f0-9]{64}', v)) for v in result.values()):
        raise ValueError('人格选择记录无效；未覆盖原文件')
    return result


def fingerprint(value=None):
    value = selection() if value is None else value
    if not any(value.values()):
        return 'builtin'
    return hashlib.sha256(json.dumps(value, separators=(',', ':')).encode()).hexdigest()


def builtin(kind):
    base = PROJECT_ROOT / 'brain/personality'
    common = {'schema': 'asuka.client-personality/v1', 'kind': kind}
    if kind == 'light':
        return {**common, 'name': '明日香 · Light（内置）',
                'prompt': (base / 'default-light-prompt.md').read_text(encoding='utf-8')}
    return {**common, 'name': '明日香 · 终（内置）',
            'package': json.loads((base / 'shin-dev/assets/shin.native-personality.json').read_text(encoding='utf-8')),
            'profile': json.loads((base / 'shin-dev/assets/profile.json').read_text(encoding='utf-8'))}


def read_bundle(file_id):
    if not re.fullmatch('[a-f0-9]{64}', file_id):
        raise ValueError('无效人格文件ID')
    path = LIBRARY / (file_id + '.json')
    if path.stat().st_size > LIMIT:
        raise ValueError('人格文件超过10MB')
    raw = path.read_bytes()
    if len(raw) > LIMIT or hashlib.sha256(raw).hexdigest() != file_id:
        raise ValueError('人格文件已被修改，请重新导入')
    return json.loads(raw)


def validate(bundle):
    raw = json.dumps(bundle, ensure_ascii=False).encode('utf-8')
    if len(raw) > LIMIT:
        raise ValueError('人格文件超过10MB')
    result = subprocess.run(
        [NODE_EXE, str(PROJECT_ROOT / 'brain/personality/client-packages.mjs')],
        input=raw, capture_output=True, timeout=20,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    try:
        response = json.loads(result.stdout.decode('utf-8'))
    except (ValueError, UnicodeError):
        raise ValueError('人格校验器未正常返回，请检查Node运行环境') from None
    if not response.get('ok') or result.returncode:
        raise ValueError(response.get('error', '人格文件校验失败'))


def import_file(path):
    path = Path(path)
    if path.stat().st_size > LIMIT:
        raise ValueError('人格文件超过10MB')
    raw = path.read_text(encoding='utf-8-sig')
    if path.suffix.lower() in ('.md', '.txt'):
        bundle = {'schema': 'asuka.client-personality/v1', 'kind': 'light',
                  'name': path.stem, 'prompt': raw}
    else:
        bundle = json.loads(raw)
        if bundle.get('schema') == 'asuka.native-package/v1':
            profile_path = path.with_name('profile.json')
            if not profile_path.exists():
                raise ValueError('单独的C++网络需要同目录的profile.json（身份、表达和记忆），或导入完整客户端人格包')
            if profile_path.stat().st_size > LIMIT:
                raise ValueError('profile.json超过10MB')
            bundle = {'schema': 'asuka.client-personality/v1', 'kind': 'native',
                      'name': bundle.get('network', {}).get('name', path.stem),
                      'package': bundle, 'profile': json.loads(profile_path.read_text(encoding='utf-8-sig'))}
    validate(bundle)
    data = (json.dumps(bundle, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    if len(data) > LIMIT:
        raise ValueError('完整人格包超过10MB')
    file_id = hashlib.sha256(data).hexdigest()
    LIBRARY.mkdir(parents=True, exist_ok=True)
    path = LIBRARY / (file_id + '.json')
    if path.exists() and path.read_bytes() != data:
        archive = LIBRARY / 'removed'
        archive.mkdir(parents=True, exist_ok=True)
        path.rename(archive / (file_id + '-modified-' + uuid4().hex + '.json'))
    if not path.exists():
        temporary = LIBRARY / ('.' + uuid4().hex + '.tmp')
        temporary.write_bytes(data)
        os.replace(temporary, path)
    return file_id


def choose(kind, file_id):
    if kind not in ('light', 'native'):
        raise ValueError('不支持的人格类型')
    if file_id:
        bundle = read_bundle(file_id)
        validate(bundle)
        if bundle['kind'] != kind:
            raise ValueError('人格类型不匹配')
    value = selection()
    value[kind] = file_id
    SELECTION.parent.mkdir(parents=True, exist_ok=True)
    temporary = SELECTION.with_name('.' + uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    os.replace(temporary, SELECTION)


def remove(file_id):
    if file_id in selection().values():
        raise ValueError('该人格已选为下次启动使用，请先选择其他人格')
    read_bundle(file_id)
    archive = LIBRARY / 'removed'
    archive.mkdir(parents=True, exist_ok=True)
    # Keep an exact recoverable copy instead of deleting user imports.
    (LIBRARY / (file_id + '.json')).rename(archive / (file_id + '-' + uuid4().hex + '.json'))
