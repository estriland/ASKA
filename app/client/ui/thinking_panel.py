"""Public structured-analysis preview, never model-private reasoning or TTS text."""
from PyQt6.QtCore import QPropertyAnimation, Qt, pyqtSignal
from PyQt6.QtWidgets import QFrame, QLabel, QVBoxLayout, QGraphicsOpacityEffect
from PyQt6.QtGui import QPainter, QColor, QPen


class AnalysisHeader(QLabel):
    """A text disclosure control, with keyboard access and no separate button."""
    toggled = pyqtSignal(bool)

    def __init__(self):
        super().__init__()
        self.setObjectName('analysisHeader')
        self._checked = False
        self._interactive = False

    def setInteractive(self, enabled):
        self._interactive = enabled
        self.setCursor(Qt.CursorShape.PointingHandCursor if enabled else Qt.CursorShape.ArrowCursor)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus if enabled else Qt.FocusPolicy.NoFocus)
        self.update()

    def isChecked(self):
        return self._checked

    def setChecked(self, checked):
        if self._checked != bool(checked):
            self._checked = bool(checked)
            self.toggled.emit(self._checked)
            self.update()

    def paintEvent(self, event):
        super().paintEvent(event)
        if self._interactive:
            painter = QPainter(self)
            painter.setRenderHint(QPainter.RenderHint.Antialiasing)
            painter.setPen(QPen(QColor('#b9c9dd'), 1.2))
            x = min(self.width() - 10, self.fontMetrics().horizontalAdvance(self.text()) + 9)
            y = self.height() // 2
            if self._checked:
                painter.drawLine(x, y-2, x+3, y+1)
                painter.drawLine(x+3, y+1, x+6, y-2)
            else:
                painter.drawLine(x, y-3, x+3, y)
                painter.drawLine(x+3, y, x, y+3)

    def mouseReleaseEvent(self, event):
        if self._interactive and event.button() == Qt.MouseButton.LeftButton and self.rect().contains(event.position().toPoint()):
            self.setChecked(not self._checked)
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def keyPressEvent(self, event):
        if self._interactive and event.key() in (Qt.Key.Key_Space, Qt.Key.Key_Return, Qt.Key.Key_Enter):
            self.setChecked(not self._checked)
            event.accept()
            return
        super().keyPressEvent(event)


class ThinkingPanel(QFrame):
    geometry_changed = pyqtSignal()
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("thinkingPanel")
        self.setStyleSheet("#thinkingPanel{background:#202733;border:1px solid #384457;border-radius:8px;} QLabel{border:0;color:#b9c9dd;}")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 8, 12, 8)
        self.phase = AnalysisHeader()
        self.phase.setWordWrap(True)
        self._finished = False
        self.toggle = self.phase
        self.toggle.toggled.connect(self._toggle_summary)
        self.summary = QLabel()
        self.summary.setWordWrap(True)
        self.summary.setTextFormat(Qt.TextFormat.PlainText)
        self.summary.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.summary.setToolTip("来自结构化分析输出的简短依据，可能有误；不是模型私有推理，不进入语音。")
        layout.addWidget(self.phase)
        layout.addWidget(self.summary)
        self.divider = QFrame()
        self.divider.setObjectName('analysisDivider')
        self.divider.setFixedHeight(1)
        self.divider.setStyleSheet('#analysisDivider{background:#53617a;border:0;border-radius:0;}')
        layout.addWidget(self.divider)
        self.divider.hide()
        self.opacity = QGraphicsOpacityEffect(self.phase)
        self.phase.setGraphicsEffect(self.opacity)
        self.animation = QPropertyAnimation(self.opacity, b"opacity", self)
        self.animation.setDuration(1400)
        self.animation.setStartValue(.45)
        self.animation.setKeyValueAt(.5, 1.0)
        self.animation.setEndValue(.45)
        self.animation.setLoopCount(-1)
        self.hide()

    def start(self, enabled=True):
        self._finished = False
        self.toggle.setInteractive(False)
        self.divider.hide()
        self.toggle.setChecked(False)
        self.animation.stop()
        self.summary.clear()
        self.summary.hide()
        self.setVisible(enabled)
        if enabled:
            self.phase.setText("正在理解对话内容…")
            self.animation.start()

    def update_progress(self, data):
        if self._finished:
            return
        if data.get("stage") == "unavailable":
            return
        self.phase.setText(str(data.get("text") or "正在思考如何回复") + "…")
        contexts = data.get("context") or {}
        self.phase.setToolTip("\n".join(
            f"{'分析' if key == 'analysis' else '回复'}上下文估计：{value['tokens']:.0f} / {value['budget']:.0f} tokens"
            for key, value in contexts.items() if value and "tokens" in value and "budget" in value))
        if data.get("summary"):
            self.summary.setText("分析摘要：\n" + str(data["summary"])[:600])
            self.summary.show()
        self.geometry_changed.emit()

    def finish(self, success=True):
        if self._finished:
            return
        self._finished = True
        self.animation.stop()
        self.opacity.setOpacity(1.0)
        if not self.isHidden():
            self._header_text = "分析已完成" if success else "本轮已取消或失败"
            self.toggle.setInteractive(bool(self.summary.text()))
            self.toggle.setChecked(False)
            self._toggle_summary(False)
            self.summary.hide()
            self.divider.show()
            self.geometry_changed.emit()

    def _toggle_summary(self, expanded):
        self.summary.setVisible(expanded and bool(self.summary.text()))
        if self._finished:
            self.phase.setText(self._header_text)
        self.geometry_changed.emit()

    def embed(self, width):
        self.setStyleSheet('#thinkingPanel{background:transparent;border:0;border-radius:0;} QLabel{background:transparent;border:0;color:#b9c9dd;} QLabel#analysisHeader:hover{color:#e0e9f7;}')
        self.layout().setContentsMargins(0, 0, 0, 6)
        self.setFixedWidth(width)
        self.summary.setFixedWidth(width)
        self.phase.setMaximumWidth(width)
