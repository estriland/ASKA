"""Export only the selected conversation's public history."""
import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile

from PyQt6.QtCore import QThread
from core.session_navigation import session_target


def save_transcript(file,title,history):
    messages=[]
    for msg in history['messages']:
        role=msg.get('role')
        if role not in ('user','assistant') or msg.get('surface')=='call':continue
        content=msg.get('speech') if role=='assistant' else None
        if not isinstance(content,str):content=msg.get('content','')
        if not isinstance(content,str):raise ValueError('聊天正文无效')
        # The history service already projects attachment names. A damaged historical
        # attachment envelope must never substitute its private payload for a filename.
        marker='\n\n[ASUKA_FILE_PAYLOAD_V1]\n'
        if role=='user' and marker in content:content=content.split(marker,1)[0]+'\n[附件]'
        row={'role':role,'text':content}
        if role=='assistant' and msg.get('translation'):row['translation']=msg['translation']
        if msg.get('hasImage'):row['image_attached']=True
        messages.append(row)
    file=Path(file)
    if file.suffix.lower()=='.json':
        text=json.dumps({'title':title,'messages':messages},ensure_ascii=False,indent=2)+'\n'
    else:
        lines=[title]
        for row in messages:
            lines+=['','我' if row['role']=='user' else 'ASKA',row['text']]
            if row.get('image_attached'):lines.append('[图片]')
            if row.get('translation'):lines.append('译文　'+row['translation'])
        text='\n'.join(lines)+'\n'
    temp=None
    try:
        with NamedTemporaryFile('w',encoding='utf8',dir=file.parent,delete=False) as stream:
            temp=Path(stream.name);stream.write(text);stream.flush();os.fsync(stream.fileno())
        os.replace(temp,file)
    finally:
        if temp is not None:temp.unlink(missing_ok=True)
    return len(messages)


class ExportConversation(QThread):
    def __init__(self,brain,session,file,parent):
        super().__init__(parent)
        self.brain,self.session,self.file=brain,dict(session),file
        self.count=None

    def run(self):
        try:
            target={**session_target(self.session),'transcript_only':True,'surface':'chat'}
            history=self.brain.request('POST','/sessions/history',target,timeout=30)
            if history.get('ok') and history.get('id')==self.session['id'] and not self.isInterruptionRequested():
                self.count=save_transcript(self.file,self.session.get('title') or '新对话',history)
        except (OSError,ValueError,KeyError,TypeError,RuntimeError):pass
