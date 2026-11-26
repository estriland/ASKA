from urllib.parse import urlencode
from PyQt6.QtCore import QThread, pyqtSignal


class ContextUsageThread(QThread):
    result = pyqtSignal(dict)

    def __init__(self, brain, session_id, mode, generation, parent=None):
        super().__init__(parent)
        self.brain, self.session_id, self.mode, self.generation = brain, session_id, mode, generation

    def run(self):
        try:
            data=self.brain.request('GET','/contextUsage?'+urlencode({'session_id':self.session_id,'mode':self.mode}),timeout=3)
        except Exception:
            data={'error':'上下文统计暂不可用'}
        self.result.emit(data)
