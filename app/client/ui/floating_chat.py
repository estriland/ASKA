"""Composer overlay confined to the chat viewport, with matching scroll space."""
from PyQt6 import sip
from PyQt6.QtCore import QEvent, QPoint, QSize, QTimer
from PyQt6.QtGui import QColor
from PyQt6.QtWidgets import QWidget, QVBoxLayout, QGraphicsDropShadowEffect
from ui.themes import set_theme_style


class FloatingChatSurface(QWidget):
    def __init__(self, chat, parent=None):
        super().__init__(parent)
        self.chat = chat
        self.composer = None
        self.audio_buttons = ()
        self._pending = False
        self.setMinimumWidth(320)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addWidget(chat)
        chat.viewport().installEventFilter(self)

    def set_composer(self, composer, audio_buttons=()):
        self.composer = composer
        composer.setParent(self)
        composer.installEventFilter(self)
        shadow=QGraphicsDropShadowEffect(composer);shadow.setBlurRadius(20);shadow.setOffset(0,4);shadow.setColor(QColor(0,0,0,85))
        composer.setGraphicsEffect(shadow)
        composer.show()
        self.audio_buttons = audio_buttons
        for button in audio_buttons:
            button.setParent(self)
            button.setFixedSize(40, 40)
            button.setIconSize(QSize(22, 22))
            button.installEventFilter(self)
            set_theme_style(button, '''
                QPushButton { background:#2b2d32; color:#e3e6ed; border:1px solid #555963; border-radius:20px; padding:0; }
                QPushButton:hover { background:#3a3d44; }
                QPushButton[readAloud="true"] { background:#326ac3; border-color:#326ac3; }
                QPushButton:disabled { color:#626874; }
            ''')
        self.schedule_layout()

    def eventFilter(self, watched, event):
        if event.type() in {QEvent.Type.Resize, QEvent.Type.LayoutRequest, QEvent.Type.Show, QEvent.Type.Hide}:
            self.schedule_layout()
        return super().eventFilter(watched, event)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.schedule_layout()

    def schedule_layout(self):
        if not self._pending:
            self._pending = True
            QTimer.singleShot(0, self.layout_composer)

    def layout_composer(self):
        if sip.isdeleted(self):return
        self._pending = False
        if self.composer is None:
            return
        viewport = self.chat.viewport()
        origin = viewport.mapTo(self, QPoint(0, 0))
        buttons = [button for button in self.audio_buttons if not button.isHidden()]
        available = max(1, viewport.width() - 32)
        controls_width = sum(button.width() + 8 for button in buttons)
        # Keep the input usable even with the personality sidebar open.
        stacked = bool(buttons and available - controls_width < self.composer.minimumSizeHint().width())
        beside = 0 if stacked else controls_width
        width = max(1, min(1000, available - beside))
        self.composer.resize(width, self.composer.height())
        self.composer.layout().activate()
        height = self.composer.sizeHint().height()
        x = origin.x() + (viewport.width() - width - beside) // 2
        y = origin.y() + viewport.height() - height - 16
        self.composer.setGeometry(x, max(origin.y(), y), width, height)
        self.composer.raise_()
        control_x = x + (width - controls_width + 8 if stacked else width + 8)
        control_y = y - 48 if stacked else y + height - 40
        for button in buttons:
            button.move(control_x, max(origin.y(), control_y))
            button.raise_()
            control_x += button.width() + 8
        self.chat.set_bottom_inset(height + 32 + (48 if stacked else 0))
