"""One optional second spoken line belonging to the user's current turn."""
from collections import deque
from dataclasses import dataclass, field
import threading
import time

from PyQt6.QtCore import QObject, QTimer, pyqtSignal


@dataclass(eq=False)
class FollowupTurn:
    parent: str
    relation: str
    group: str | None
    call: str | None
    route: tuple
    stop: threading.Event = field(default_factory=threading.Event)
    allow_output: threading.Event = field(default_factory=threading.Event)
    holds: set = field(default_factory=set)
    handle: dict | None = None
    draft: dict | None = None
    voice: object = None
    audio: object = None
    item: dict | None = None
    language: str = ''
    parent_playback_id: str = ''
    phase: str = 'parent'
    drained_at: float | None = None
    start_until: float | None = None
    child_started: bool = False
    cancel_reason: str = ''

    def can_start(self):
        if self.start_until is not None and time.perf_counter()>=self.start_until:
            self.stop.set()
            return False
        return self.allow_output.is_set() and not self.stop.is_set()


class ImmediateFollowup(QObject):
    """Qt owns presentation and identity; workers only transport or generate private PCM."""
    prepared = pyqtSignal(object,object)
    timing = pyqtSignal(str,str,float)
    pause_seconds = .14
    max_gap_seconds = .95
    candidate_seconds = 30

    def __init__(self, window):
        super().__init__(window)
        self.w = window
        self.current = None
        self.recovering = set()
        self.retry = QTimer(self)
        self.retry.setSingleShot(True)
        self.retry.timeout.connect(self.recover_pending)
        self.prepared.connect(self._prepared)
        window.input_box.textChanged.connect(self._typing)
        window.dictation.changed.connect(lambda state: self.cancel('dictation') if state!='idle' else None)
        for combo in (window.call_language,
                      window.backend_combo,window.api_provider_combo,window.api_model_combo,
                      window.saved_api_combo,window.model_combo):
            combo.currentIndexChanged.connect(lambda _index:self.cancel('route_changed'))
        window.temp_slider.valueChanged.connect(lambda _value:self.cancel('voice_changed'))
        window.page_stack.currentChanged.connect(lambda _index:self.cancel('navigation'))

    def _typing(self):
        if not self.w._draft_loading and self.w.input_box.text().strip():
            self.cancel('new_input')

    def _route(self):
        w = self.w
        connection = w._custom_api_profile or {}
        return (w._call_generation, w.call_language.currentData() if w._active_call_id else None,
                w.backend_combo.currentData(),w.api_provider_combo.currentData(),
                w.api_model_combo.currentData(),connection.get('connection_id'),connection.get('connection_revision'),
                w.tts.temperature)

    def begin(self, owner):
        self.cancel('new_input')
        w = self.w
        if (not w.immediate_speech_check.isChecked() or not owner.voice_enabled or not w.voice_check.isChecked() or not w.tts.enabled
                or not w.relationship_view.ready or (not w._active_call_id and not w._read_aloud_started_call)):
            return
        packet = owner.request_packet
        job = FollowupTurn(owner.request_id,owner.session_id,packet.get('group_id'),packet.get('call_id'),self._route())
        job.allow_output.set()
        owner.immediate_followup = True
        owner.followup_turn = self.current = job
        self.mark(job,'user_accepted')

    def mark(self, job, stage):
        self.timing.emit(job.parent,stage,time.perf_counter())

    def _valid(self, job):
        w = self.w
        return (self.current is job and not w._closing and not w._navigation_blocked and not w.relationship_view.erasing
                and not job.stop.is_set() and w.immediate_speech_check.isChecked() and w.voice_check.isChecked()
                and w.tts.enabled and not w.dictation.active and not w.input_box._ime_active
                and (w._current_session or {}).get('id')==job.relation and w._active_call_id==job.call
                and (w._relationship_call_group_id if job.call else w._relationship_group_id)==job.group
                and self._route()==job.route and (bool(job.call) or w._read_aloud_started_call))

    @staticmethod
    def _scope(job):
        return {'relationship_id':job.relation,'parent_request_id':job.parent,'group_id':job.group,'call_id':job.call}

    def _identity(self,job):
        return {**self._scope(job),'id':job.handle['id'],'token':job.handle['token']}

    def parent_reply(self, owner, data):
        job = getattr(owner,'followup_turn',None)
        if job is None or job.handle is not None: return
        handle = data.get('followup')
        if (not isinstance(handle,dict) or handle.get('parent_request_id')!=job.parent
                or not isinstance(handle.get('id'),str) or not isinstance(handle.get('token'),str)):
            if self.current is job: self.cancel('no_followup')
            return
        job.handle = handle
        if not self._valid(job):
            if self.current is job: self.cancel('route_changed')
            else: self._cancel_remote(job)
            return
        if not data.get('speech') or data.get('voice_error') or data.get('degraded_continuity'):
            self.cancel('parent_failed')
            return
        job.language = data.get('language') or ''
        job.parent_playback_id = data.get('playback_id') or ''
        job.phase = 'preparing'
        self.mark(job,'parent_reply')
        QTimer.singleShot(self.candidate_seconds*1000,lambda:self._expire(job))
        self._poll(job)

    def _poll(self,job):
        if self.current is not job or job.phase!='preparing': return
        if not self._valid(job):
            self.cancel('route_changed')
            return
        def receive(data):
            if self.current is not job: return
            state = data.get('state')
            if not data.get('ok') or state not in ('pending','ready'):
                self.cancel(state or 'unavailable')
                return
            if state=='pending':
                QTimer.singleShot(130,lambda:self._poll(job))
                return
            draft = data.get('draft')
            if not self._matches(job,draft) or draft.get('voice_style')!='inherit-parent':
                self.cancel('draft_mismatch')
                return
            job.draft = draft
            self.mark(job,'draft_ready')
            self._prepare_audio(job)
        self.w.relationship_view.request('POST','/relationship/followup/prepare',self._identity(job),receive)

    @staticmethod
    def _matches(job, data):
        if not isinstance(data,dict): return False
        line = data.get('behavior')
        if not isinstance(line,dict): return False
        return (data.get('id')==job.handle['id'] and data.get('token')==job.handle['token']
                and data.get('request_id')=='initiative:'+job.handle['id'] and data.get('parent_request_id')==job.parent
                and data.get('group_id')==job.group and data.get('call_id')==job.call
                and isinstance(line.get('speech'),str) and bool(line['speech'].strip())
                and line.get('language')==job.language and isinstance(line.get('translation',''),str))

    def generated(self,job,voice):
        if self.current is job and self._valid(job) and voice.parent_playback_id==job.parent_playback_id:
            job.voice = voice
            self.mark(job,'parent_generation_eos')
            self._prepare_audio(job)
        else:
            self.w.tts.release_followup_voice(voice)
            if self.current is job: self.cancel('parent_voice_changed')

    def _prepare_audio(self, job):
        if job.phase!='preparing' or job.voice is None or job.draft is None or not self._valid(job): return
        job.phase = 'synthesizing'
        line = job.draft['behavior']
        self.mark(job,'second_generation_start')
        def run():
            try:
                audio = self.w.tts.prepare_followup(job.voice,line['speech'],line['language'],job.draft['request_id'],job.stop)
            except Exception as error:
                if not job.stop.is_set():
                    from core.chat_failure import failure_from_exception, record_failure
                    record_failure(failure_from_exception(error),request_id=job.parent,stage='followup-audio')
                audio = None
            self.prepared.emit(job,audio)
        self.w._start_voice_task(run,'immediate-followup-synthesis')

    def _prepared(self,job,audio):
        if self.current is not job: return
        if (audio is None or not self._valid(job) or audio.text!=job.draft['behavior']['speech']
                or audio.language!=job.language):
            self.cancel('preparation_failed')
            return
        job.audio = audio
        job.phase = 'ready'
        self.mark(job,'second_pcm_ready')
        self._advance(job)

    def parent_audio_end(self,job,owner):
        if self.current is not job: return
        if not owner.output_drained:
            self.cancel('parent_not_played')
            return
        if job.drained_at is None:
            job.drained_at = owner.drained_at
            job.start_until = job.drained_at + self.max_gap_seconds
            self.mark(job,'parent_device_drained')
            if job.phase in ('parent','preparing'):
                self.cancel('late')
                return
            remaining = max(0.,self.max_gap_seconds - (time.perf_counter()-job.drained_at))
            QTimer.singleShot(round(remaining*1000)+1,lambda:self._expire(job))
        self._advance(job)

    def _expire(self,job):
        if self.current is job and not job.child_started:
            self.cancel('late')

    def _advance(self,job):
        if self.current is not job or job.drained_at is None: return
        if not self._valid(job): self.cancel('route_changed');return
        age = time.perf_counter()-job.drained_at
        if age >= self.max_gap_seconds and not job.child_started: self.cancel('late');return
        if job.holds or self.w._queued_asr or (job.call and getattr(self.w.asr,'_current_speech',False)): return
        if age < self.pause_seconds:
            QTimer.singleShot(round((self.pause_seconds-age)*1000)+1,lambda:self._advance(job))
            return
        if job.phase=='published':
            job.phase = 'queued'
            self.w._play_followup(job)
        elif job.phase=='ready':
            job.phase = 'delivering'
            receipt = {**self._identity(job),'request_id':job.draft['request_id']}
            pending = self.w.relationship_view._saved('pending_followup_receipts')
            if receipt not in pending:
                self.w.relationship_view._save('pending_followup_receipts',[*pending,receipt])
            self.w.relationship_view.request('POST','/relationship/followup/deliver',self._identity(job),
                                             lambda data:self._delivered(job,data),during_close=True)

    def _delivered(self,job,data):
        if job.item is not None: return
        item = data.get('item')
        if data.get('ok') and item is None:
            self._forget_receipt(job.draft['request_id'])
            if self.current is job: self.cancel('not_published')
            return
        if not self._matches(job,item):
            if self.current is job: self.cancel('delivery_unconfirmed')
            else: self.recover_pending()
            return
        expected, actual = job.draft['behavior'], item['behavior']
        if (not isinstance(item.get('playback_id'),str) or not item['playback_id'].startswith(job.relation+':')
                or len(item['playback_id'])<=len(job.relation)+1
                or any(actual.get(k,'')!=expected.get(k,'') for k in ('speech','translation','language'))):
            if self.current is job: self.cancel('receipt_mismatch')
            return
        job.item = item
        self.mark(job,'published')
        if not self._valid(job):
            self._account_unplayed(job)
            self._forget_receipt(item['request_id'])
            return
        self._forget_receipt(item['request_id'])
        job.phase = 'published'
        self._advance(job)

    def input_event(self,kind,span,choice=None):
        job = self.current
        if not job or not job.call: return
        if kind=='onset':
            job.holds.add(span.number)
            job.allow_output.clear()
        elif choice in ('speech','stop'):
            self.cancel('user_speech')
        elif kind=='final':
            job.holds.discard(span.number)
            if not job.holds:
                job.allow_output.set()
                self._advance(job)

    def _cancel_remote(self,job):
        if not job.handle and job.cancel_reason=='no_followup': return
        if job.phase=='delivering' and job.draft and any(p['request_id']==job.draft['request_id']
                for p in self.w.relationship_view._saved('pending_followup_receipts')):
            self.recover_pending()
            return
        body=self._identity(job) if job.handle else self._scope(job)
        self.w.relationship_view.request('POST','/relationship/followup/cancel',body,lambda _:None,during_close=True)

    def _forget_receipt(self, request_id):
        view=self.w.relationship_view
        pending=view._saved('pending_followup_receipts')
        if any(record['request_id']==request_id for record in pending):
            view._save('pending_followup_receipts',[record for record in pending if record['request_id']!=request_id])
            view.followup_receipt_resolved(request_id)

    def recover_pending(self):
        """Fence a lost publication response before reading the canonical child; never re-deliver it."""
        view = self.w.relationship_view
        relation=(self.w._current_session or {}).get('id')
        for record in view._saved('pending_followup_receipts'):
            rid=record['request_id']
            if rid in self.recovering or record['relationship_id']!=relation: continue
            if self.current and self.current.draft and self.current.draft['request_id']==rid: continue
            self._recover(record)

    def _recover(self,record):
        view=self.w.relationship_view
        rid=record['request_id']
        self.recovering.add(rid)
        def failed():
            self.recovering.discard(rid)
            if not self.w._closing: self.retry.start(3000)
        def read(data):
            if not data.get('ok') or data.get('id')!=record['relationship_id']:
                failed()
                return
            if any(m.get('role')=='assistant' and m.get('request_id')==rid and m.get('call_id')==record['call_id']
                   for m in data.get('messages',[])):
                if record['call_id']:
                    self.w._record_call_event('interrupted',record['call_id'],request_id=rid,group_id=record['group_id'],
                        reason='delivery_unconfirmed',played_ms=0,heard_prefix='',segment_index=None,estimated=True,overlap=False)
                elif not self.w._closing:
                    view.arrival(record['group_id'])
            self._forget_receipt(rid)
            self.recovering.discard(rid)
        def cancelled(data):
            if not data.get('ok'):
                failed()
                return
            view.request('POST','/relationship/history',{'relationship_id':record['relationship_id'],'request_id':rid},read,during_close=True)
        view.request('POST','/relationship/followup/cancel',record,cancelled,during_close=True)

    def _account_unplayed(self,job):
        if job.call:
            self.w._record_call_event('interrupted',job.call,request_id=job.item['request_id'],group_id=job.group,
                reason=job.cancel_reason or 'route_changed',played_ms=0,heard_prefix='',segment_index=None,estimated=True,overlap=False)
        elif not self.w._closing and job.cancel_reason!='exit':
            self.w.relationship_view.arrival(job.group)

    def cancel(self,reason):
        job,self.current = self.current,None
        if job is None: return
        job.cancel_reason = reason
        job.stop.set()
        self.w.tts.release_followup_voice(job.voice)
        job.allow_output.clear()
        for task in self.w._tts_queue:
            if task.get('child_followup') is job and task.get('row') is not None:
                task['row'].finish_delivery()
        self.w._tts_queue=deque(task for task in self.w._tts_queue if task.get('child_followup') is not job)
        if job.item:
            if not job.child_started:
                self._account_unplayed(job)
            elif job.call and self.w._call_audio and self.w._call_audio.target==job.item['request_id']:
                self.w._record_call_interruption(reason)
            if self.w._call_audio and self.w._call_audio.target==job.item['request_id']:
                self.w._call_audio.finish(job.item['request_id'])
                self.w.voice_call_panel.clear_caption()
        self.mark(job,'cancelled:'+reason)
        self._cancel_remote(job)

    def child_end(self,job):
        if self.current is job:
            self.mark(job,'second_end')
            self.current = None
