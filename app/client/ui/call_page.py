"""The in-call screen and its optional, non-activating desktop caption window."""
from PyQt6.QtCore import QEasingCurve, QEvent, QPoint, QRectF, QSize, Qt, QTimer, QVariantAnimation, pyqtSignal
from PyQt6.QtGui import QColor, QGuiApplication, QLinearGradient, QPainter, QPixmap
from PyQt6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QFrame, QHBoxLayout, QLabel, QPushButton, QSizePolicy, QSpinBox, QVBoxLayout, QWidget,
)

from ui.themes import colors
from ui.composer_bar import composer_icon
from ui.widgets import RingWaveform


def caption_label(name, accessible_name):
    label = QLabel()
    label.setObjectName(name)
    label.setAccessibleName(accessible_name)
    label.setTextFormat(Qt.TextFormat.PlainText)
    label.setAlignment(Qt.AlignmentFlag.AlignCenter)
    label.setWordWrap(True)
    return label


class DesktopCaptions(QFrame):
    positioned = pyqtSignal()

    def __init__(self, settings):
        super().__init__()
        self.settings = settings
        self.adjusting = False
        self._drag_offset = None
        self.setWindowTitle('ASKA · 桌面字幕')
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.original = caption_label('desktopOriginal', '日语原文')
        self.primary = caption_label('desktopPrimary', '中文字幕')
        layout = QVBoxLayout(self)
        layout.setContentsMargins(22, 10, 22, 10)
        layout.setSpacing(2)
        layout.addWidget(self.original)
        layout.addWidget(self.primary)
        self.original.hide()
        self._update_flags()
        self.apply_theme()

    def _update_flags(self):
        flags = (Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint
                 | Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.WindowDoesNotAcceptFocus)
        if not self.adjusting:
            flags |= Qt.WindowType.WindowTransparentForInput
        self.setWindowFlags(flags)

    def set_adjusting(self, enabled):
        if self.adjusting != enabled:
            self.adjusting = enabled
            self._drag_offset = None
            self._update_flags()

    def apply_theme(self):
        p = colors()
        size = min(54, max(14, self.settings.value('voice/desktop_caption_font_size', 23, type=int)))
        self.opacity = min(100, max(0, self.settings.value('voice/desktop_caption_opacity', 86, type=int)))
        self.setStyleSheet(
            f'QLabel#desktopPrimary {{ color:{p["text"]}; background:transparent; font-size:{size}px; font-weight:600; }}'
            f'QLabel#desktopOriginal {{ color:{p["muted"]}; background:transparent; font-size:{max(12,round(size*.8))}px; }}'
        )
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        background = QColor(colors()['window'])
        background.setAlphaF(self.opacity / 100)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(background)
        painter.drawRoundedRect(self.rect(), 12, 12)
        painter.end()

    def text(self):
        return self.primary.text()

    def present(self, caption, screen, original=''):
        if not caption and not original and not self.adjusting:
            self.hide()
            return
        self.original.setText(original)
        self.original.setVisible(bool(original))
        self.primary.setText(caption or ('拖动字幕到合适的位置' if self.adjusting and not original else ''))
        saved = self.settings.value('voice/desktop_caption_position')
        monitor = QGuiApplication.screenAt(saved) if isinstance(saved, QPoint) else None
        area = (monitor or screen or QGuiApplication.primaryScreen()).availableGeometry()
        width = min(900, max(1, area.width() - 32))
        self.setFixedSize(width, min(area.height(), max(56, self.layout().heightForWidth(width))))
        point = saved if monitor else QPoint(area.center().x() - width // 2, area.bottom() - self.height() - 48)
        if self._drag_offset is None:
            self._place(point, area)
        self.show()

    def _place(self, point, area):
        self.move(max(area.left(), min(point.x(), area.right()-self.width()+1)),
                  max(area.top(), min(point.y(), area.bottom()-self.height()+1)))

    def mousePressEvent(self, event):
        if self.adjusting and event.button() == Qt.MouseButton.LeftButton:
            self._drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._drag_offset is not None:
            self.move(event.globalPosition().toPoint() - self._drag_offset)
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if self._drag_offset is not None and event.button() == Qt.MouseButton.LeftButton:
            self._drag_offset = None
            self._place(self.pos(), self.screen().availableGeometry())
            self.settings.setValue('voice/desktop_caption_position', self.pos())
            self.positioned.emit()
            return
        super().mouseReleaseEvent(event)


class CallControlTray(QWidget):
    """Clip the sliding controls to a fixed slot so the live captions never jump."""

    def __init__(self, content):
        super().__init__()
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.panel = QWidget(self)
        column = QVBoxLayout(self.panel)
        column.setContentsMargins(0, 0, 0, 12)
        column.setSpacing(2)
        self.handle = QPushButton()
        self.handle.setObjectName('callControlsHandle')
        self.handle.setAccessibleName('展开通话控制')
        self.handle.setFixedSize(88, 22)
        self.handle.setCursor(Qt.CursorShape.PointingHandCursor)
        grip = QFrame()
        grip.setObjectName('callControlsGrip')
        grip.setFixedSize(38, 3)
        grip.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        handle_layout = QHBoxLayout(self.handle)
        handle_layout.setContentsMargins(0, 0, 0, 0)
        handle_layout.addWidget(grip, alignment=Qt.AlignmentFlag.AlignCenter)
        column.addWidget(self.handle, alignment=Qt.AlignmentFlag.AlignHCenter)
        column.addWidget(content)

        self._open_fraction = 1.0
        self._keyboard = False
        self._delay = QTimer(self, singleShot=True)
        self._delay.timeout.connect(self._fold_if_idle)
        self._slide = QVariantAnimation(self)
        self._slide.setEasingCurve(QEasingCurve.Type.InOutCubic)
        self._slide.valueChanged.connect(self._position_panel)
        self.handle.clicked.connect(self.reveal)
        for widget in [self.panel, *self.panel.findChildren(QWidget)]:
            widget.installEventFilter(self)

    def sizeHint(self):
        return self.panel.sizeHint()

    def _position_panel(self, fraction):
        self._open_fraction = float(fraction)
        distance = max(0, self.height() - self.handle.height())
        self.panel.setGeometry(0, round((1 - fraction) * distance), self.width(), self.height())

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._position_panel(self._open_fraction)

    def showEvent(self, event):
        super().showEvent(event)
        self._position_panel(1.0)
        self._delay.start(900)

    def hideEvent(self, event):
        self._delay.stop()
        self._slide.stop()
        self._keyboard = False
        super().hideEvent(event)

    def _animate(self, target):
        if self._slide.state() == QVariantAnimation.State.Running and self._slide.endValue() == target:
            return
        self._slide.stop()
        if self._open_fraction != target:
            start = self._open_fraction
            self._slide.setStartValue(start)
            self._slide.setEndValue(target)
            self._slide.setDuration(max(1, round(180 * abs(start - target))))
            self._slide.start()

    def reveal(self):
        self._delay.stop()
        self._animate(1.0)

    def _fold_if_idle(self):
        if not self.isVisible() or self.panel.underMouse():
            return
        if QApplication.activePopupWidget() or QApplication.mouseButtons():
            self._delay.start(350)
            return
        focus = QApplication.focusWidget()
        if focus and self.panel.isAncestorOf(focus):
            if self._keyboard:
                return
            self.setFocus(Qt.FocusReason.OtherFocusReason)
        self._animate(0.0)

    def eventFilter(self, watched, event):
        kind = event.type()
        if watched is self.panel:
            if kind == QEvent.Type.Enter:
                self._keyboard = False
                self.reveal()
            elif kind == QEvent.Type.Leave:
                self._delay.start(350)
            elif kind == QEvent.Type.LayoutRequest:
                self.updateGeometry()
        if kind == QEvent.Type.FocusIn and event.reason() in (
                Qt.FocusReason.TabFocusReason, Qt.FocusReason.BacktabFocusReason, Qt.FocusReason.ShortcutFocusReason):
            self._keyboard = True
            self.reveal()
        elif kind == QEvent.Type.KeyPress:
            self._keyboard = True
            self.reveal()
        elif kind == QEvent.Type.MouseButtonPress:
            self._keyboard = False
        elif kind == QEvent.Type.FocusOut and self.isVisible():
            self._delay.start(350)
        return super().eventFilter(watched, event)


class VoiceCallPage(QFrame):
    def __init__(self, settings, avatar, user_avatar, background=None):
        super().__init__()
        self.setObjectName('dedicatedVoiceCall')
        self.settings = settings
        self.set_artwork(background)
        self.active = False
        self.desktop = DesktopCaptions(settings)
        self._caption_tail = QTimer(self)
        self._caption_tail.setSingleShot(True)
        self._caption_tail.timeout.connect(self.clear_caption)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(28, 20, 28, 0)
        layout.setSpacing(12)
        title = QLabel('语音通话')
        title.setObjectName('voicePageTitle')
        layout.addWidget(title)
        layout.addStretch(2)
        self.waveform = RingWaveform()
        self.waveform.set_images(tts_image=avatar, user_image=user_avatar)
        layout.addWidget(self.waveform, alignment=Qt.AlignmentFlag.AlignHCenter)
        if avatar:
            participant=QLabel('明日香')
            participant.setObjectName('callParticipant')
            layout.addWidget(participant,alignment=Qt.AlignmentFlag.AlignHCenter)
        self.status = QLabel()
        self.status.setObjectName('voiceCallStatus')
        self.status.setTextFormat(Qt.TextFormat.PlainText)
        self.status.setWordWrap(True)
        self.status.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self.status,alignment=Qt.AlignmentFlag.AlignHCenter)
        self.original = caption_label('voiceCallOriginal', '日语原文')
        self.caption = caption_label('voiceCallCaption', '通话字幕')
        self.original.hide()
        lines = QWidget()
        lines.setMinimumHeight(58)
        lines.setMaximumWidth(760)
        text_layout = QVBoxLayout(lines)
        text_layout.setContentsMargins(0, 0, 0, 0)
        text_layout.setSpacing(3)
        text_layout.addWidget(self.original)
        text_layout.addWidget(self.caption)
        captions = QHBoxLayout()
        captions.addStretch()
        captions.addWidget(lines, stretch=6)
        captions.addStretch()
        layout.addLayout(captions)
        layout.addStretch(2)
        control_body = QWidget()
        control_rows = QVBoxLayout(control_body)
        control_rows.setContentsMargins(0, 0, 0, 0)
        control_rows.setSpacing(8)
        controls = QHBoxLayout()
        controls.addStretch()
        self.microphone = QPushButton('静音')
        self.microphone.setObjectName('callMicControl')
        self.hangup = QPushButton('挂断')
        self.hangup.setObjectName('callHangupControl')
        self.stop_audio = QPushButton('停止音频')
        self.stop_audio.setObjectName('callStopAudio')
        self.stop_audio.setToolTip('停止本句和待播语音，通话继续收音')
        for button,icon in ((self.microphone,'mic'),(self.stop_audio,'stop'),(self.hangup,'hangup')):
            button.setIcon(composer_icon(icon,'#ffffff' if button is self.hangup else colors()['text']))
            button.setIconSize(QSize(17,17))
            button.setMinimumSize(104, 40)
            controls.addWidget(button)
        controls.addStretch()
        control_rows.addLayout(controls)
        options = QHBoxLayout()
        options.addStretch()
        self.language = QComboBox()
        self.language.setAccessibleName('通话回复语言')
        self.language.setToolTip('下一轮回复使用的语言')
        self.language.addItem('日语 · 中文字幕', 'ja')
        from core.voice_edition import multilingual_available
        if multilingual_available():
            self.language.addItem('中文', 'zh')
        else:
            self.language.setEnabled(False)
            self.language.setToolTip('日语语音版支持中文输入和中文字幕。中文发音使用中日双语版。')
        self.language.setCurrentIndex(max(0,self.language.findData(settings.value('voice/call_language','ja'))))
        self.language.currentIndexChanged.connect(lambda:settings.setValue('voice/call_language',self.language.currentData()))
        self.floating = QCheckBox('桌面字幕')
        self.speaker = QCheckBox('扬声器')
        self.floating.setChecked(settings.value('voice/desktop_captions', False, type=bool))
        self.move_subtitle = QPushButton('移动字幕')
        self.move_subtitle.setCheckable(True)
        self.floating.toggled.connect(self._toggle_floating)
        self.move_subtitle.toggled.connect(self._adjust_position)
        self.desktop.positioned.connect(lambda:self.move_subtitle.setChecked(False))
        for widget in (self.language,self.speaker,self.floating):
            options.addWidget(widget)
        options.addStretch()
        control_rows.addLayout(options)
        self.desktop_options = QWidget()
        appearance = QHBoxLayout(self.desktop_options)
        appearance.setContentsMargins(0, 0, 0, 0)
        appearance.addStretch()
        for label, key, low, high, default, suffix in (
                ('字幕字号', 'font_size', 14, 54, 23, ' px'),
                ('背景不透明度', 'opacity', 0, 100, 86, '%')):
            key = 'voice/desktop_caption_' + key
            spin = QSpinBox()
            spin.setAccessibleName(label)
            spin.setRange(low, high)
            spin.setSuffix(suffix)
            spin.setValue(settings.value(key, default, type=int))
            spin.valueChanged.connect(lambda value, key=key: self._change_caption_style(key, value))
            appearance.addWidget(QLabel(label))
            appearance.addWidget(spin)
        appearance.addWidget(self.move_subtitle)
        appearance.addStretch()
        control_rows.addWidget(self.desktop_options)
        self.desktop_options.setVisible(self.floating.isChecked())
        self.controls = CallControlTray(control_body)
        layout.addWidget(self.controls)
        self.apply_theme()

    def set_artwork(self,file):
        self._art_file=file
        self._art=None
        self._ambient=None
        self._ambient_key=None
        self.update()

    def paintEvent(self,event):
        super().paintEvent(event)
        if not self._art_file or self.waveform.isHidden():
            return
        if self._art is None:
            self._art=QPixmap(str(self._art_file))
        if self._art.isNull():return
        ratio=self.devicePixelRatioF()
        c=colors()
        key=(self.width(),self.height(),ratio,c['window'])
        if self._ambient_key!=key:
            width,height=self.width(),self.height()
            buffer=QPixmap(round(width*ratio),round(height*ratio))
            buffer.setDevicePixelRatio(ratio)
            buffer.fill(Qt.GlobalColor.transparent)
            q=QPainter(buffer)
            q.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
            scale=max(.61*width/self._art.width(),height/self._art.height())
            aw,ah=self._art.width()*scale,self._art.height()*scale
            q.setOpacity(.42)
            top=min(0,height*.31-ah*.205)
            q.drawPixmap(QRectF(width*.81-aw*.63,top,aw,ah),self._art,QRectF(self._art.rect()))
            q.setOpacity(1)
            # Reveal the scene on the right while keeping the caller and captions legible.
            fade=QLinearGradient(0,0,width,0)
            for point,alpha in ((0,255),(.44,255),(.62,170),(.84,24),(1,54)):
                shade=QColor(c['window']);shade.setAlpha(alpha);fade.setColorAt(point,shade)
            q.fillRect(self.rect(),fade)
            floor=QLinearGradient(0,height*.58,0,height)
            floor.setColorAt(0,Qt.GlobalColor.transparent);floor.setColorAt(1,QColor(c['window']))
            q.fillRect(self.rect(),floor);q.end()
            self._ambient=buffer;self._ambient_key=key
        p=QPainter(self);p.drawPixmap(0,0,self._ambient);p.end()

    def apply_theme(self):
        p = colors()
        self.setStyleSheet(
            f'QFrame#dedicatedVoiceCall {{ background: qradialgradient(cx:0.5,cy:0.39,radius:0.75,'
            f'stop:0 {p["soft"]},stop:0.64 {p["surface"]},stop:1 {p["window"]}); }}'
            f'QLabel#voiceCallCaption {{ color:{p["text"]}; font-size:22px; font-weight:600; }}'
            f'QLabel#voiceCallOriginal {{ color:{p["muted"]}; font-size:17px; }}'
            f'QLabel#voiceCallStatus {{ color:{p["muted"]};background:transparent;padding:2px 8px; }}'
            f'QLabel#callParticipant {{color:{p["text"]};font-size:23px;font-weight:650;}}'
            f'QLabel#voicePageTitle {{ color:{p["text"]}; font-size:20px; font-weight:650; }}'
            'QPushButton#callControlsHandle { background:transparent; border:0; padding:0; }'
            f'QPushButton#callControlsHandle:focus {{ border:1px solid {p["border"]}; border-radius:8px; }}'
            f'QFrame#callControlsGrip {{ background:{p["muted"]}; border:0; border-radius:1px; }}'
            f'QPushButton#callMicControl,QPushButton#callStopAudio {{ color:{p["text"]}; background:{p["field"]}; '
            f'border:1px solid {p["border"]}; border-radius:20px; }}'
            'QPushButton#callHangupControl { background:#a13950; color:white; border:1px solid #a13950; border-radius:20px; }'
            f'QPushButton#callMicControl:hover,QPushButton#callStopAudio:hover {{background:{p["selection"]};}}'
            'QPushButton#callHangupControl:hover {background:#b74660;}'
            f'QPushButton#callMicControl:focus,QPushButton#callStopAudio:focus,QPushButton#callHangupControl:focus {{border:2px solid {p["accent"]};}}')
        self.desktop.apply_theme()

    def _toggle_floating(self, enabled):
        self.settings.setValue('voice/desktop_captions', enabled)
        self.desktop_options.setVisible(enabled)
        if not enabled:
            self.move_subtitle.setChecked(False)
        self._sync_desktop()

    def _adjust_position(self, enabled):
        self.move_subtitle.setText('锁定字幕' if enabled else '移动字幕')
        self.desktop.set_adjusting(enabled)
        self._sync_desktop()

    def _sync_desktop(self):
        if self.active and self.floating.isChecked():
            self.desktop.present(self.caption.text(), self.screen(), self.original.text())
        else:
            self.desktop.hide()

    def set_active(self, active):
        self.active = active
        self.move_subtitle.setChecked(False)
        self.status.clear()
        self.clear_caption()

    def _change_caption_style(self, key, value):
        self.settings.setValue(key, value)
        self.desktop.apply_theme()
        self._sync_desktop()

    def set_caption(self, text, original=''):
        self._caption_tail.stop()
        self.original.setText(original)
        self.original.setVisible(bool(original))
        self.caption.setText(text)
        self._sync_desktop()

    def finish_caption(self):
        if self.active and self.caption.text():
            self._caption_tail.start(1500)

    def clear_caption(self):
        self.set_caption('')
