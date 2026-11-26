"""New-dialogue defaults only; the Brain freezes each conversation separately."""
import json,os
from pathlib import Path
from uuid import uuid4
from core.app_config import PROJECT_ROOT

SCHEMA='asuka.dialogue-defaults/1'
DEFAULT_PATH=PROJECT_ROOT/'brain/dialogue-defaults.json'
_isolation=os.environ.get('ASUKA_SETTINGS_PATH') or os.environ.get('ASUKA_SESSION_DIR')
_default_directory=Path(_isolation).parent if _isolation else PROJECT_ROOT/'client'
CONFIG_PATH=Path(os.environ.get('ASUKA_DIALOGUE_CONFIG',_default_directory/'dialogue.local.json'))
if not CONFIG_PATH.is_absolute():CONFIG_PATH=PROJECT_ROOT/CONFIG_PATH
FIELDS=('address','identity_intro','opening_relationship','tic_preference')

def normalize_dialogue_defaults(raw):
    if not isinstance(raw,dict) or raw.get('schema')!=SCHEMA or set(raw)-{'schema',*FIELDS}:
        raise ValueError('聊天设定格式无效，原文件已保留')
    result={'schema':SCHEMA}
    for name,limit in [('address',80),('identity_intro',1200),('opening_relationship',1200)]:
        value=raw.get(name,'')
        if not isinstance(value,str) or '\0' in value:
            raise ValueError('聊天设定必须是普通文字')
        if name=='address' and any(c in value for c in '\r\n\u2028\u2029'):
            raise ValueError('称呼请写在一行内')
        value=value.strip()
        if len(value)>limit:raise ValueError(f'{ {"address":"称呼","identity_intro":"身份简介","opening_relationship":"开场关系"}[name]}最多{limit}字')
        result[name]=value
    tic=raw.get('tic_preference','natural')
    if tic=='':tic='natural'
    if tic not in ('natural','reduced'):raise ValueError('语癖偏好无效')
    result['tic_preference']='natural'
    return result

def load_dialogue_defaults(path=CONFIG_PATH):
    file=Path(path);return normalize_dialogue_defaults(json.loads((file if file.exists() else DEFAULT_PATH).read_text('utf-8')))

def save_dialogue_defaults(raw,path=CONFIG_PATH):
    value=normalize_dialogue_defaults(raw)
    write_local_json(path,value)
    return value

def write_local_json(path,value):
    file=Path(path);file.parent.mkdir(parents=True,exist_ok=True)
    temp=file.with_name(file.name+'.'+uuid4().hex+'.tmp')
    try:
        with temp.open('x',encoding='utf-8',newline='\n') as handle:
            json.dump(value,handle,ensure_ascii=False,indent=2);handle.write('\n');handle.flush();os.fsync(handle.fileno())
        os.replace(temp,file)
    finally:temp.unlink(missing_ok=True)
