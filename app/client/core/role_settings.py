"""Profile-wide, editable role facts. An absent override follows the installed character."""
import hashlib
import json
import os
from pathlib import Path
import re

from core.app_config import PROJECT_ROOT
from core.dialogue_profile import CONFIG_PATH as DIALOGUE_PATH, write_local_json

SCHEMA='asuka.role-settings/1'
PATH=Path(os.environ.get('ASUKA_ROLE_CONFIG') or DIALOGUE_PATH.with_name('role-settings.local.json'))
LABELS={'current_life':'角色近况','life_premise':'生活起点','origin':'身世','speaking_style':'说话性格'}


def normalize_role_settings(value):
    if not isinstance(value,dict) or set(value)!={'schema','overrides'} or value['schema']!=SCHEMA:
        raise ValueError('角色设定文件格式无效')
    fields=value['overrides']
    if not isinstance(fields,dict) or set(fields)-LABELS.keys():
        raise ValueError('角色设定含无法识别的字段')
    result={}
    for key,entry in fields.items():
        if key=='origin':
            if not isinstance(entry,dict) or set(entry)!={'mode','text'} or entry['mode'] not in ('extend','replace'):
                raise ValueError('请选择补充或重写身世')
            text=entry['text']
        else:
            text=entry
        if not isinstance(text,str) or '\0' in text or len(text.strip())>4000:
            raise ValueError(f'{LABELS[key]}请使用 4000 字以内的普通文字')
        text=text.strip()
        if key=='origin':
            if text or entry['mode']=='replace':
                result[key]={'mode':entry['mode'],'text':text}
        elif text or key!='current_life':
            result[key]=text
    return {'schema':SCHEMA,'overrides':result}


def load_role_settings(path=PATH):
    path=Path(path)
    if not path.is_file():return {'schema':SCHEMA,'overrides':{}}
    return normalize_role_settings(json.loads(path.read_text(encoding='utf-8-sig')))


def save_role_settings(overrides,path=PATH):
    value=normalize_role_settings({'schema':SCHEMA,'overrides':overrides})
    write_local_json(path,value)
    return value


def builtin_role_fields(memory_root=None):
    fields=dict.fromkeys(LABELS,'')
    root=Path(memory_root or os.environ.get('ASUKA_CHARACTER_MEMORY_ROOT') or PROJECT_ROOT/'brain/personality/character-memory')
    pointer=root/'default-v2.json'
    if not pointer.is_file():return fields
    version=json.loads(pointer.read_text(encoding='utf-8-sig'))['version']
    if not re.fullmatch(r'memory-[a-f0-9]{64}',version):raise ValueError('角色资料版本无效')
    content=(root/version/'catalog.json').read_bytes()
    if hashlib.sha256(content).hexdigest()!=version[7:]:raise ValueError('角色资料校验失败')
    context=json.loads(content).get('context',{})
    if not context:return fields
    origin=context['identity'].get('origin_class','')
    fields['origin']=context.get('biography') or (origin.rstrip('。')+'。' if origin else '')
    fields['life_premise']=context.get('present','')
    fields['speaking_style']='\n'.join(context.get('persona_traits',[]))
    return fields
