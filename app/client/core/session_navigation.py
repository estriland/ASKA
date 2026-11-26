"""Qt workers for selecting, reading, cancelling and deleting conversations."""

from PyQt6.QtCore import QThread


def session_target(session):
    if session.get('path'):
        return {'id': session['id'], 'path': session['path']}
    return {'id': session['id'], 'restore_empty': bool(session.get('empty_session'))}


class SessionNavigation(QThread):
    def __init__(self, brain, source, target, parent, create=False):
        super().__init__(parent)
        self.brain = brain
        self.source = dict(source or {})
        self.target = dict(target)
        self.create = create
        self.result = {}

    def _request(self, route, body):
        try:
            return self.brain.request('POST', route, body, timeout=10)
        except Exception as exc:
            return {'ok': False, 'code': getattr(exc, 'code', type(exc).__name__)}

    def _failed(self, stage, response):
        # A lost response can follow a successful server mutation. Resume sending
        # only after the previous session acknowledges its own identity.
        restored = False
        if self.source.get('id'):
            receipt = self._request('/sessions/switch', session_target(self.source))
            restored = bool(receipt.get('ok') and receipt.get('id') == self.source['id'])
        self.result = {'ok': False, 'stage': stage, 'code': response.get('code'), 'restored': restored}

    def run(self):
        if self.create:
            created = self._request('/sessions', {})
            if created.get('ok') and created.get('id'):
                self.target = {'id': created['id'], 'path': None, 'empty_session': True,
                               'pending': True, 'title': '新对话'}
                self.result = {'ok': True, 'history': {'ok': True, 'messages': []}}
            else:
                self._failed('create', created)
            return

        session_id = self.target.get('id')
        if not session_id:
            self.result = {'ok': False, 'stage': 'target', 'restored': bool(self.source.get('id'))}
            return
        switch = self._request('/sessions/switch', session_target(self.target))
        if not switch.get('ok') or switch.get('id') != session_id:
            self._failed('switch', switch)
            return
        if 'path' in switch:
            self.target['path'] = switch['path']
        if switch.get('title'):
            self.target['title'] = switch['title']
        history = self._request('/sessions/history', {**session_target(self.target),'surface':'chat'})
        if history.get('ok') and history.get('id') == session_id and isinstance(history.get('messages'), list):
            self.result = {'ok': True, 'history': history}
        else:
            self._failed('history', history)


class SessionListRead(QThread):
    def __init__(self, brain, parent, pending_store):
        super().__init__(parent)
        self.brain = brain
        self.pending_store = pending_store
        self.result = {}

    def run(self):
        try:
            self.result = self.brain.request('GET', '/sessions', timeout=10)
        except Exception as error:
            self.result = {'ok': False, 'code': getattr(error, 'code', type(error).__name__)}
            return
        try:
            self.result['pending_titles'] = self.pending_store.titles()
        except OSError:
            self.result['pending_titles'] = []


class CancelReply(QThread):
    def __init__(self, brain, request_id, session_id, parent, lookup=None):
        super().__init__(parent)
        self.brain = brain
        self.request_id = request_id
        self.session_id = session_id
        self.outcome = {}
        self.saved = None
        self.lookup = lookup
        self.failure = None

    def run(self):
        try:
            self.outcome = self.brain.cancel_native(self.request_id, self.session_id, details=True)
            if self.outcome.get('completed') and self.lookup:
                self.saved = self.lookup()
        except Exception as error:
            self.failure = error


class DeleteConversation(QThread):
    def __init__(self, brain, pending, replay, session, parent):
        super().__init__(parent)
        self.brain, self.pending, self.replay = brain, pending, replay
        self.session = dict(session)
        self.result = {'ok': False, 'stage': 'server'}

    def run(self):
        sid = self.session['id']
        try:
            result = self.brain.request('POST', '/sessions/delete', {'id': sid, 'path': self.session.get('path')}, timeout=30)
            if not result.get('ok') or result.get('deletedSessionId') != sid:
                self.result['code'] = result.get('code', 'SESSION_DELETE_FAILED')
                return
            self.result = {'ok': False, 'stage': 'local', 'activeSessionId': result.get('activeSessionId')}
            unclassified = self.pending.forget_session(sid) + self.replay.forget_session(sid)
            self.result = {**result, 'unclassified': unclassified}
        except Exception as error:
            self.result['code'] = getattr(error, 'code', type(error).__name__)
