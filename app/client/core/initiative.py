"""Poll the active relationship while the desktop is free to receive a message."""

from __future__ import annotations

import threading
import weakref

from PyQt6.QtCore import QObject, QTimer, pyqtSignal


class InitiativeController(QObject):
    """availability() runs on the GUI thread and returns a route or None.

    on_received(item) returns True once the incoming message is present on this
    desktop. An acknowledgement can then be retried independently of rendering.
    """

    _finished = pyqtSignal(int, str, object)
    ROUTE = '/relationship/initiative/'

    def __init__(self, brain, availability, on_received, parent=None, *, interval_ms=5000):
        super().__init__(parent)
        self.brain = brain
        self.availability = availability
        self.on_received = on_received
        self.timer = QTimer(self)
        self.timer.setInterval(interval_ms)
        self.timer.timeout.connect(self.poll)
        self._finished.connect(self._receive_result)
        self._enabled = False
        self._generation = 0
        self._request = None
        self._route = None
        self._claim = None
        self._item = None
        self._ack = None

    def start(self):
        if self._enabled:
            return
        self._enabled = True
        self.timer.start()
        QTimer.singleShot(0, self.poll)

    def stop(self):
        self._enabled = False
        self._generation += 1
        self.timer.stop()
        self._request = self._route = self._claim = self._item = None
        # Preserve a successfully shown item's ACK across stop/start. The
        # server keeps a published message available across process restarts.

    def _post(self, operation, payload):
        self._request = operation
        generation, brain, handle = self._generation, self.brain, weakref.ref(self)
        route = self.ROUTE + operation

        def run():
            try:
                timeout = 140 if operation == 'poll' else 12
                response = brain.request('POST', route, payload, timeout=timeout)
            except Exception:
                response = {}
            controller = handle()
            if controller is not None:
                try:
                    controller._finished.emit(generation, operation, response)
                except RuntimeError:
                    pass  # The window and its QObject were closed during I/O.

        threading.Thread(target=run, name='feiniao-initiative-' + operation, daemon=True).start()

    def poll(self):
        if not self._enabled or self._request:
            return
        if self._ack:
            self._post('ack', dict(self._ack))
            return
        route = self.availability()
        if not isinstance(route, dict) or not route.get('relationship_id'):
            return
        if self._route and self._route.get('relationship_id') != route['relationship_id']:
            self._claim = self._item = None
        self._route = dict(route)
        if self._item:
            if self.on_received(dict(self._item)):
                self._ack = {**self._identity(), 'relationship_id':route['relationship_id']}
                self._item = self._claim = None
                self._post('ack', dict(self._ack))
            else:
                self._item = None
        elif self._claim:
            self._post('deliver', {**self._route, **self._identity()})
        else:
            self._post('poll', dict(self._route))

    def _identity(self):
        return {'id':self._claim['id'], 'token':self._claim['token']}

    def _receive_result(self, generation, operation, response):
        if not self._enabled or generation != self._generation or self._request != operation:
            return
        self._request = None
        if not isinstance(response, dict) or not response.get('ok'):
            return  # Timer retries when the desktop and transport are available.
        if operation == 'ack':
            self._ack = None
            return
        if operation == 'poll':
            candidate = response.get('claim')
            if isinstance(candidate, dict) and candidate.get('id') and candidate.get('token'):
                self._claim = {'id':candidate['id'], 'token':candidate['token']}
                self.poll()
            return
        item = response.get('item')
        if not isinstance(item, dict) or item.get('id') != self._claim['id'] or item.get('token') != self._claim['token']:
            self._claim = None
            return
        # A message can be erased or the call can end during this pause.
        # Recheck its durable ID at /deliver when the desktop is free again.
        if self.availability():
            self._item = item
            self.poll()
