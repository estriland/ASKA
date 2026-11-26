"""Wrapping chat input; its visible height grows to six lines, not its text limit."""
import math
from PyQt6.QtCore import Qt, QEvent, QTimer, pyqtSignal
from PyQt6.QtGui import QTextOption
from PyQt6.QtWidgets import QPlainTextEdit


class MessageComposer(QPlainTextEdit):
    returnPressed = pyqtSignal()
    MAX_VISIBLE_LINES = 6

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName('messageComposer')
        self.setLineWrapMode(QPlainTextEdit.LineWrapMode.WidgetWidth)
        self.setWordWrapMode(QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setTabChangesFocus(True)
        self._ime_active = False
        self._fit_pending = False
        self.textChanged.connect(self._schedule_fit)
        self.document().documentLayout().documentSizeChanged.connect(self._schedule_fit)
        self._schedule_fit()

    # Existing file attachment/chat code uses these QLineEdit-shaped accessors.
    def text(self):
        return self.toPlainText()

    def setText(self, value):
        self.setPlainText(value)

    def inputMethodEvent(self, event):
        self._ime_active = bool(event.preeditString())
        super().inputMethodEvent(event)

    def focusOutEvent(self, event):
        super().focusOutEvent(event)
        self._ime_active = False

    def keyPressEvent(self, event):
        if event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
            if self._ime_active:
                event.accept()
                return
            if not (event.modifiers() & Qt.KeyboardModifier.ShiftModifier):
                if not event.isAutoRepeat(): self.returnPressed.emit()
                event.accept()
                return
        super().keyPressEvent(event)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._schedule_fit()

    def changeEvent(self, event):
        super().changeEvent(event)
        if event.type() in (QEvent.Type.FontChange, QEvent.Type.StyleChange):
            self._schedule_fit()

    def _schedule_fit(self, *_args):
        if not getattr(self, '_fit_pending', False):
            self._fit_pending = True
            QTimer.singleShot(0, self._fit_height)

    def _fit_height(self):
        self._fit_pending = False
        # Real laid-out lines include soft wraps, long unbroken strings and newlines.
        self.document().documentLayout().documentSize()
        count = 0
        heights = []
        block = self.document().begin()
        while block.isValid() and count <= self.MAX_VISIBLE_LINES:
            layout = block.layout()
            line_count = max(1, layout.lineCount())
            for index in range(min(line_count, self.MAX_VISIBLE_LINES - len(heights))):
                heights.append(layout.lineAt(index).height() if layout.lineCount() else self.fontMetrics().lineSpacing())
            count += line_count
            block = block.next()
        overflow = count > self.MAX_VISIBLE_LINES
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded if overflow else Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        chrome = self.height() - self.viewport().height()
        # Qt rounds its line-fit calculation down at an exact boundary. One
        # logical pixel avoids a phantom scroll range for an otherwise empty row.
        height = math.ceil(sum(heights) + 2 * self.document().documentMargin() + chrome) + 1
        if self.height() != height: self.setFixedHeight(height)
