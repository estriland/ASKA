"""Independent dictation reuses the single ASR manager, never the chat sender."""
import threading
from PyQt6.QtCore import QObject, pyqtSignal


class DictationController(QObject):
    changed = pyqtSignal(str)
    text_ready = pyqtSignal(str)
    failed = pyqtSignal(str)
    _raw_text = pyqtSignal(int, str)
    _raw_state = pyqtSignal(int, str)
    _raw_finished = pyqtSignal(int)
    _released = pyqtSignal(int, str)

    def __init__(self, asr, parent=None):
        super().__init__(parent)
        self.asr = asr
        self.state = 'idle'
        self.generation = 0
        self.cancelled = False
        self._cleanup_started = False
        self._cleanup_thread = None
        self._raw_text.connect(self._receive_text)
        self._raw_state.connect(self._receive_state)
        self._raw_finished.connect(self._finish)
        self._released.connect(self._release_done)

    @property
    def active(self):
        return self.state != 'idle'

    def _set_state(self, state):
        self.state = state
        self.changed.emit(state)

    def start(self):
        if self.active or self.asr.is_listening:
            return False
        unavailable = self.asr.provider_availability_error()
        if unavailable:
            self.failed.emit(unavailable)
            return False
        self.generation += 1
        generation = self.generation
        self.cancelled = False
        self._cleanup_started = False
        self._set_state('loading')
        try:
            run = self.asr.start(
                on_result=lambda text: self._raw_text.emit(generation, text),
                on_state=lambda state: self._raw_state.emit(generation, state),
                on_finished=lambda: self._raw_finished.emit(generation))
            if run is None:
                self._set_state('idle')
                return False
        except Exception as error:
            self.failed.emit(str(error)); self.cancel()
            return False
        return True

    def finish(self):
        if self.state=='release_failed':
            self._finish(self.generation)
        elif self.state in {'loading', 'finishing'}:
            self.cancel()
        elif self.active and self.state != 'releasing':
            self._set_state('finishing')
            if not self.asr.finish_capture():
                self._finish(self.generation)

    def cancel(self):
        if not self.active:
            return
        self.cancelled = True
        self.asr.request_stop()
        self._finish(self.generation)

    def _receive_text(self, generation, text):
        if generation == self.generation and self.active and not self.cancelled and self.state != 'releasing' and text.strip():
            self.text_ready.emit(text.strip())

    def _receive_state(self, generation, state):
        if generation != self.generation or not self.active or self.cancelled:
            return
        if state.startswith('error:'):
            self.failed.emit(state[6:]); self.cancel()
        elif self.state not in {'finishing', 'releasing'} and state in {'loading', 'listening', 'recording', 'transcribing'}:
            self._set_state(state)

    def _finish(self, generation):
        if generation != self.generation or not self.active or self._cleanup_started:
            return
        self._cleanup_started = True
        self._set_state('releasing')
        def cleanup():
            error = ''
            try:
                self.asr.unload()
            except Exception as exc:
                error = str(exc)
            self._released.emit(generation, error)
        self._cleanup_thread = threading.Thread(target=cleanup, name='dictation-release', daemon=True)
        self._cleanup_thread.start()

    def _release_done(self, generation, error):
        if generation != self.generation:
            return
        if error:
            # Keep ownership if release failed; a new call must not take the mic.
            self._cleanup_started = False
            self._set_state('release_failed')
            self.failed.emit('语音资源尚未释放：'+error)
            return
        self._set_state('idle')

    def close(self):
        self.cancel()
        if self._cleanup_thread:
            self._cleanup_thread.join(timeout=3)
