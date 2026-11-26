"""One unacknowledged input per conversation, not another conversation store."""
import hashlib
import json
import os
import re
import uuid
from pathlib import Path
from core.app_config import PROJECT_ROOT

FIELDS=('request_id','session_id','group_id','call_id','message','images','personality_mode','personality_state_scope','api_connection',
        'voice_enabled','voice_preset','voice_turn','voice_planner','call_language','display_text','image_path','cancelled','empty_session','session_path','analysis_complete',
        'failure_code','failure_retryable','recovery_request_id','failure_closed')

class PendingChatStore:
    def __init__(self,root=None):
        settings = os.environ.get('ASUKA_SETTINGS_PATH')
        default = Path(settings).parent/'pending-chat' if settings else PROJECT_ROOT/'data/client-pending'
        self.root=Path(root or os.environ.get('ASUKA_PENDING_CHAT_DIR') or default)

    def _path(self,session_id):
        key=hashlib.sha256(str(session_id or 'unbound').encode('utf-8')).hexdigest()
        return self.root/(key+'.json')

    def begin_removal(self,session_id):
        sid=str(uuid.UUID(session_id))
        folder=self.root/'removals';folder.mkdir(parents=True,exist_ok=True)
        file=folder/(sid+'.json')
        if not file.exists():
            temporary=file.with_name(file.name+'.'+uuid.uuid4().hex+'.tmp')
            with temporary.open('x',encoding='utf8') as stream:
                json.dump({'session_id':sid},stream);stream.flush();os.fsync(stream.fileno())
            os.replace(temporary,file)

    def pending_removals(self):
        folder=self.root/'removals'
        ids=[]
        for file in sorted(folder.glob('*.json')):
            try:
                sid=str(uuid.UUID(file.stem))
                if sid==file.stem and json.loads(file.read_text('utf8')).get('session_id')==sid:ids.append(sid)
            except (OSError,ValueError,AttributeError):continue
        return ids

    def finish_removal(self,session_id):
        (self.root/'removals'/(str(uuid.UUID(session_id))+'.json')).unlink(missing_ok=True)

    def forget_request(self, session_id, request_id):
        self.clear(session_id,request_id)
        try: canonical = str(uuid.UUID(request_id))
        except (TypeError,ValueError): return  # Proactive messages have no locally pending input.
        folder = self.root/'history'
        file = folder/(canonical+'.json')
        if folder.is_symlink() or folder.is_junction() or file.is_symlink():
            raise ValueError('待发历史归属无法验证')
        if file.is_file():
            row = json.loads(file.read_text('utf8'))
            if row.get('session_id')!=session_id or row.get('request_id',canonical)!=canonical:
                raise ValueError('待发历史归属不符')
            file.unlink()

    def forget_session(self,session_id):
        sid=str(uuid.UUID(session_id))
        unclassified=0
        current=self.load(sid)
        if current:self.clear(sid,current['request_id'])
        for file in (self.root/'history').glob('*.json'):
            if file.is_symlink():raise ValueError('待发历史记录路径无法验证')
            try:row=json.loads(file.read_text('utf8'))
            except (UnicodeError,ValueError):
                unclassified+=1;continue
            if not isinstance(row,dict):
                unclassified+=1;continue
            if row.get('session_id')==sid:
                # The explicit owner and the archive filename bind older records
                # too. A conflicting stored request ID must never be guessed.
                if file.stem!=str(uuid.UUID(file.stem)) or row.get('request_id',file.stem)!=file.stem:
                    raise ValueError('待发历史记录归属不一致')
                file.unlink()
        return unclassified

    def save(self,payload):
        value={k:payload[k] for k in FIELDS if k in payload}
        if not isinstance(value.get('message'),str) or not value['message'].strip():raise ValueError('待发消息为空')
        uuid.UUID(value['request_id'])
        value['schema']='asuka.pending-chat/1'
        file=self._path(value.get('session_id'));file.parent.mkdir(parents=True,exist_ok=True)
        if file.exists():
            previous=json.loads(file.read_text('utf-8'))
            if previous.get('request_id')!=value['request_id']:
                old_id=str(uuid.UUID(previous['request_id']))
                archive=self.root/'history'/(old_id+'.json');archive.parent.mkdir(exist_ok=True)
                if not archive.exists():
                    with archive.open('x',encoding='utf-8') as out:json.dump(previous,out,ensure_ascii=False)
        # Keep the contact-list fields before image data. A list refresh only
        # needs the first few KiB even when a pending send contains attachments.
        title = '语音通话' if value.get('call_language') else (value.get('display_text') or value['message']).strip().split('\n',1)[0][:64]
        route = value.get('session_path')
        value = {'sidebar':{'id':value.get('session_id'),'title':title,'path':route if isinstance(route,str) and len(route)<=512 else None,
                            'empty_session':bool(value.get('empty_session'))}, **value}
        temp=file.with_name(file.name+'.'+uuid.uuid4().hex+'.tmp')
        with temp.open('w',encoding='utf-8') as out:
            json.dump(value,out,ensure_ascii=False);out.flush();os.fsync(out.fileno())
        os.replace(temp,file)

    def load(self,session_id):
        file=self._path(session_id)
        if not file.exists():return None
        value=json.loads(file.read_text('utf-8'))
        if value.get('schema')!='asuka.pending-chat/1' or value.get('session_id')!=session_id:raise ValueError('待发消息记录不匹配')
        uuid.UUID(value['request_id'])
        return {k:value[k] for k in FIELDS if k in value}

    def clear(self,session_id,request_id):
        value=self.load(session_id)
        if value and value['request_id']==request_id:self._path(session_id).unlink()

    def find_request(self,session_id,request_id):
        """Read the exact archived input when a pending item points to an older one."""
        request_id=str(uuid.UUID(request_id))
        current=self.load(session_id)
        if current and current['request_id']==request_id:return current
        file=self.root/'history'/(request_id+'.json')
        if not file.exists():return None
        value=json.loads(file.read_text('utf-8'))
        if value.get('schema')!='asuka.pending-chat/1' or value.get('session_id')!=session_id or value.get('request_id')!=request_id:
            raise ValueError('历史待发消息不匹配')
        return {k:value[k] for k in FIELDS if k in value}

    def all(self):
        records=[]
        if not self.root.exists():return records
        for file in self.root.glob('*.json'):
            try:
                value=json.loads(file.read_text('utf-8'))
                if value.get('schema')=='asuka.pending-chat/1':records.append(value)
            except (OSError,ValueError):pass # Preserve damaged files for diagnosis.
        return records

    def titles(self):
        """Read a bounded prefix of each outstanding packet, including legacy ones."""
        rows = []
        if not self.root.is_dir():
            return rows
        decoder = json.JSONDecoder()
        key_pattern = re.compile(r'\s*[,\{]\s*"([^"]+)"\s*:\s*')
        for file in self.root.glob('*.json'):
            try:
                if file.is_symlink():
                    continue
                with file.open('rb') as stream:
                    prefix = stream.read(4096).decode('utf8', errors='ignore')
                offset = 0
                row = {}
                while match := key_pattern.match(prefix, offset):
                    key = match[1]
                    if key not in {'sidebar','request_id','session_id','message'}:
                        break
                    try:
                        field, offset = decoder.raw_decode(prefix, match.end())
                    except ValueError:
                        break
                    if key == 'sidebar':
                        if isinstance(field, dict):
                            row = field
                        break
                    if key == 'session_id':
                        row['id'] = field
                    elif key == 'message' and isinstance(field,str):
                        row['title'] = field.strip().split('\n',1)[0][:64]
                        break
                sid = str(uuid.UUID(row['id']))
                if self._path(sid) != file or (self.root/'removals'/(sid+'.json')).exists():
                    continue
                rows.append({'id':sid, 'title':str(row.get('title') or '未完成的消息')[:64],
                             'path':row.get('path'), 'empty_session':row.get('empty_session',True),
                             'pending':True, 'recovery':True, 'updated_ms':file.stat().st_mtime_ns//1_000_000})
            except (OSError, ValueError, KeyError, TypeError, AttributeError):
                continue
        return sorted(rows,key=lambda row:(row['updated_ms'],row['id']),reverse=True)
