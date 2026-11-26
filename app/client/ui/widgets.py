# -*- coding: utf-8 -*-
# asuka-ai/client/ui/widgets.py
# 自定义 UI 组件：聊天气泡、环形波形、可滚动消息列表
import os
import math
import random
import re
from contextlib import contextmanager
from PyQt6 import sip
from PyQt6.QtWidgets import (QAbstractSlider, QWidget, QVBoxLayout, QHBoxLayout, QLabel,
                             QScrollArea, QFrame, QPushButton, QSizePolicy)
from .themes import set_theme_style, style_color, colors
from PyQt6.QtCore import Qt, QTimer, pyqtSignal, QRect, QRectF, QPoint, QPointF, QEvent
from PyQt6.QtGui import (QPainter, QColor, QBrush, QPixmap, QPainterPath,
                         QTextDocument, QPen, QLinearGradient, QFont)

from ui.markdown_math import render_markdown_math
from core.reply_delivery import voice_groups
from ui.voice_reveal import VoiceRevealLabel

ASSETS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "assets")


def _chat_paragraphs(text):
    """Only plain paragraphs have display boundaries; never invent sentences.

    Rich documents keep their existing renderer as one bubble. This is a view
    of the original reply, not a transformation of its history or speech text.
    """
    value = str(text)
    normal = value.replace("\r\n", "\n").replace("\r", "\n")
    if not re.search(r"\n[ \t]*\n", normal):
        return [value]
    block_syntax = (
        r"(?m)^[ \t]{0,3}(?:`{3,}|~{3,}|#{1,6}(?:\s|$)|>"
        r"|[-+*]\s|\d+[.)]\s|(?:[-*_][ \t]*){3,}$|=+[ \t]*$)"
        r"|(?m:^[ \t]*[^\n]*\|[^\n]*$)"
        r"|(?m:^(?: {4}|\t)\S)"
        r"|\$|\\[\[\]()]|\\begin\{|</?[A-Za-z][^>]*>"
    )
    if re.search(block_syntax, normal):
        return [value]
    parts = [part.strip() for part in re.split(r"\n(?:[ \t]*\n)+", normal)
             if part.strip()]
    return parts if len(parts) > 1 else [value]


# ============ 聊天气泡 ============
class ChatBubble(QFrame):
    """微信风格聊天气泡：左侧头像 + 右侧文字气泡"""

    def __init__(self, text, is_user=False, avatar_path=None,
                 translation=None, image_path=None, parent=None, call_subtitles=False):
        super().__init__(parent)
        self.is_user = is_user
        self._call_subtitles = call_subtitles and not is_user and bool(translation)
        self.raw_text = str(text)
        self.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)

        if is_user:
            self.text_panel = self._make_text_panel(
                text, translation=None, image_path=image_path)
            layout.addWidget(self.text_panel)
        else:
            # 明日香消息：靠左，头像+气泡
            self.avatar = QLabel()
            self.avatar.setFixedSize(36, 36)
            self.avatar.setAlignment(Qt.AlignmentFlag.AlignCenter)
            self._load_avatar(avatar_path)
            layout.addWidget(self.avatar, 0, Qt.AlignmentFlag.AlignTop)
            self.text_panel = self._make_text_panel(
                text, translation=translation, image_path=image_path)
            layout.addWidget(self.text_panel, 0, Qt.AlignmentFlag.AlignTop)

    @staticmethod
    def _measure_text(text, font, max_width, rich_text=False):
        document = QTextDocument()
        document.setDocumentMargin(0)
        document.setDefaultFont(font)
        if rich_text:
            document.setHtml(str(text))
        else:
            document.setPlainText(str(text))
        natural_width = math.ceil(document.idealWidth())
        width = max(36, min(max_width, natural_width))
        document.setTextWidth(width)
        height = max(16, math.ceil(document.size().height()))
        return width, height

    def _make_text_panel(self, text, translation=None, image_path=None):
        """创建独立的正文与翻译标签，避免 RichText 把翻译裁掉。"""
        panel = QFrame()
        panel_layout = QVBoxLayout(panel)
        panel_layout.setContentsMargins(14, 9, 14, 10)
        panel_layout.setSpacing(5)
        text_html = render_markdown_math(str(text), colors()['muted'] if self._call_subtitles
                                         else "#ffffff" if self.is_user else "#e8e8f0")
        self.text_label = VoiceRevealLabel(text_html)
        set_theme_style(self.text_label,"background:transparent;font-size:15px;")
        self.text_label.ensurePolished()
        self.text_label.setWordWrap(True)
        self.text_label.setTextFormat(Qt.TextFormat.RichText)
        labels = [(self.text_label, text_html, True)]
        self.translation_label = None
        if translation:
            translation_html = render_markdown_math(translation, colors()['text'] if self._call_subtitles else "#aeb6c8")
            self.translation_label = VoiceRevealLabel(translation_html)
            self.translation_label.setWordWrap(True)
            self.translation_label.setTextFormat(Qt.TextFormat.RichText)
            labels.append((self.translation_label, translation_html, True))

        panel.setObjectName('chatBubblePanel')
        fill='bubble_self' if self.is_user else 'bubble_peer'
        corner='border-top-right-radius:4px;' if self.is_user else 'border-top-left-radius:4px;'
        set_theme_style(panel,lambda c:(
            f'QFrame#chatBubblePanel {{background:{c[fill]};border:1px solid {c["bubble_edge"]};'
            f'border-radius:13px;{corner}}} QLabel {{background:transparent;border:0;color:{c["text"]};}}'))
        if self._call_subtitles:
            set_theme_style(self.text_label, "background:transparent;font-size:12px;")
            set_theme_style(self.translation_label, "background:transparent;font-size:15px;font-weight:600;")
            self.text_label.ensurePolished()
            self.translation_label.ensurePolished()
        elif self.translation_label is not None:
            set_theme_style(self.translation_label, 
                "background:transparent;color:#b9c3d4;font-size:13px;")
            self.translation_label.ensurePolished()

        max_content_width = 476
        image_label = None
        image_width = 0
        if image_path and os.path.exists(image_path):
            pixmap = QPixmap(image_path)
            if not pixmap.isNull():
                pixmap = pixmap.scaled(
                    320, 220, Qt.AspectRatioMode.KeepAspectRatio,
                    Qt.TransformationMode.SmoothTransformation)
                image_label = QLabel()
                image_label.setPixmap(pixmap)
                image_label.setFixedSize(pixmap.size())
                image_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
                image_width = pixmap.width()
        measured = [
            self._measure_text(value, label.font(), max_content_width, rich)
            for label, value, rich in labels
        ]
        self._label_content = labels
        content_width = max(
            image_width, max(width for width, _ in measured))
        self._preferred_content_width=content_width
        self._image_label=image_label
        self._thumbnail=image_label.pixmap() if image_label is not None else None
        if image_label is not None:
            panel_layout.addWidget(
                image_label, 0, Qt.AlignmentFlag.AlignHCenter)
        for (label, value, rich), (_, height) in zip(labels, measured):
            # 使用统一正文宽度，让翻译稳定出现在正文正下方。
            _, wrapped_height = self._measure_text(
                value, label.font(), content_width, rich)
            label.setFixedSize(content_width, wrapped_height)
            panel_layout.addWidget(label)
        panel.setFixedWidth(content_width + 30)
        panel.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
        if not text:
            self.text_label.hide()
        return panel

    def fit_content(self,limit):
        width=min(self._preferred_content_width,max(48,limit))
        if getattr(self,'analysis_panel',None):
            width=min(max(48,limit),max(width,310))
        if self.text_panel.width()==width+30:
            return
        if self._image_label is not None:
            image=self._thumbnail.scaledToWidth(min(width,self._thumbnail.width()),Qt.TransformationMode.SmoothTransformation)
            self._image_label.setPixmap(image)
            self._image_label.setFixedSize(image.size())
        for label,value,rich in self._label_content:
            _,height=self._measure_text(value,label.font(),width,rich)
            label.setFixedSize(width,height)
        self.text_panel.setFixedWidth(width+30)
        if getattr(self,'analysis_panel',None):
            self.analysis_panel.embed(width)
        self.updateGeometry()

    def attach_analysis(self, analysis):
        self.analysis_panel = analysis
        width = max(340, self.text_panel.width())
        self.text_panel.setFixedWidth(width)
        for label, value, rich in self._label_content:
            _, height = self._measure_text(value, label.font(), width - 24, rich)
            label.setFixedSize(width - 24, height)
        analysis.embed(width - 24)
        self.text_panel.layout().insertWidget(0, analysis)
        analysis.show()
        # Nested fixed-height size policies need their hints refreshed after folding.
        analysis.geometry_changed.connect(self._resize_analysis)
        self._resize_analysis()

    def _resize_analysis(self):
        panel = self.analysis_panel
        if not panel.summary.isHidden():
            _, height = self._measure_text(panel.summary.text(), panel.summary.font(), panel.width())
            panel.summary.setFixedHeight(height)
        for widget in (panel, self.text_panel, self, self.parentWidget(),
                       getattr(self, 'message_row', None)):
            if widget is None:
                continue
            if widget.layout():
                widget.layout().invalidate()
                widget.layout().activate()
            widget.updateGeometry()

    def _load_avatar(self, avatar_path):
        if avatar_path and os.path.exists(avatar_path):
            pix = QPixmap(avatar_path)
            if not pix.isNull():
                # 圆角头像
                pix = pix.scaled(36, 36, Qt.AspectRatioMode.KeepAspectRatioByExpanding,
                                 Qt.TransformationMode.SmoothTransformation)
                x=max(0,(pix.width()-36)//2)
                y=max(0,(pix.height()-36)//2)
                rounded = self._round_pixmap(pix.copy(x,y,36,36), 18)
                self.avatar.setPixmap(rounded)
                return
        # 无头像：显示首字符或空
        if self.is_user:
            self.avatar.setText("")
            set_theme_style(self.avatar, "background: transparent;")
        else:
            self.avatar.setText("香")
            set_theme_style(self.avatar, 
                "background: #e91e63; color: white; border-radius: 20px;"
                "font-size: 18px; font-weight: bold;")

    @staticmethod
    def _round_pixmap(pixmap, radius):
        """圆角裁剪图片"""
        from PyQt6.QtGui import QPixmap, QPainter, QColor, QBrush
        rounded = QPixmap(pixmap.size())
        rounded.fill(Qt.GlobalColor.transparent)
        painter = QPainter(rounded)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        path = QPainterPath()
        path.addRoundedRect(0, 0, pixmap.width(), pixmap.height(), radius, radius)
        painter.setClipPath(path)
        painter.drawPixmap(0, 0, pixmap)
        painter.end()
        return rounded

    def set_text(self, text):
        self.text_label.setText(render_markdown_math(
            str(text), "#ffffff" if self.is_user else "#e8e8f0"))

    def reveal_voice(self, fraction):
        self.text_label.reveal(fraction)
        if self.translation_label is not None:
            self.translation_label.reveal(fraction)


class ChatMessageRow(QWidget):
    """一条全宽消息行，附带随语音电平变化的光晕与粒子效果。"""

    diagnostic_requested = pyqtSignal(object)
    replay_requested = pyqtSignal(object)

    def __init__(self, text, is_user=False, avatar_path=None,
                 translation=None, image_path=None, parent=None,
                 chat_bubbles=True, parts=None, voice_reveal=False, call_subtitles=False):
        super().__init__(parent)
        self.raw_text = str(text)
        self.is_user = bool(is_user)
        self.playback_id = None
        self._replay_enabled = False
        self._replay_available = False
        self._translation = translation
        self._aligned_parts = parts
        self._call_subtitles = call_subtitles
        self._read_label = None
        self._read = False
        self._avatar_path = avatar_path
        self._image_path = image_path
        self._chat_bubbles = bool(chat_bubbles)
        self._voice_segments = None
        self._voice_cleaner = None
        self._segment_starts = [0]
        self._playing_bubble = 0
        self._voice_reveal = bool(voice_reveal)
        self._pending_reveal = self._voice_reveal
        self._visible_count = 0
        self._reveal_timer = QTimer(self)
        self._reveal_timer.setInterval(900)
        self._reveal_timer.timeout.connect(self._reveal_next)
        self.bubbles = []
        self._diagnostic = None
        self.report_button = None
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        layout = QHBoxLayout(self)
        # 给短半径光晕和粒子预留绘制空间。
        layout.setContentsMargins(14, 7, 14, 7)
        layout.setSpacing(0)
        self._bubble_group = QWidget(self)
        self._bubble_group.setSizePolicy(
            QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        self._bubble_layout = QVBoxLayout(self._bubble_group)
        self._bubble_layout.setContentsMargins(0, 0, 0, 0)
        self._bubble_layout.setSpacing(6)
        if is_user:
            layout.addStretch(1)
            self._read_label = QLabel('已读', self)
            set_theme_style(self._read_label, 'color:#9aa9ba;background:transparent;font-size:10px;padding:0 8px 0 0;')
            self._read_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            self._read_label.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
            self._read_label.hide()
            layout.addWidget(self._read_label, 0, Qt.AlignmentFlag.AlignVCenter)
            layout.addWidget(self._bubble_group, 0, Qt.AlignmentFlag.AlignRight)
        else:
            layout.addWidget(self._bubble_group, 0, Qt.AlignmentFlag.AlignLeft)
            layout.addStretch(1)

        if not is_user:
            self.report_button = QPushButton("⚠ 标注异常")
            self.report_button.setToolTip(
                "将本次实际合成音频、参数和人工备注保存为异常样本")
            self.report_button.setFixedHeight(23)
            self.report_button.setVisible(False)
            self.report_button.clicked.connect(
                lambda: self.diagnostic_requested.emit(self))
        self._rebuild_bubbles()

        self._playing = False
        self._target_level = 0.0
        self._display_level = 0.0
        self._particles = []
        self._effect_timer = QTimer(self)
        self._effect_timer.setInterval(33)
        self._effect_timer.timeout.connect(self._animate_effect)

    def _rebuild_bubbles(self):
        """Keep one row, one analysis panel and one diagnostic attachment."""
        self._reveal_timer.stop()
        analysis = getattr(getattr(self, 'bubble', None), 'analysis_panel', None)
        if analysis is not None:
            analysis.geometry_changed.disconnect(self.bubble._resize_analysis)
            analysis.setParent(self)
        if self.report_button is not None:
            self.report_button.setParent(self)
        for bubble in self.bubbles:
            self._bubble_layout.removeWidget(bubble)
            bubble.hide()
            bubble.deleteLater()
        pairs = [(self.raw_text, self._translation)]
        if self._chat_bubbles and not self.is_user and not self._image_path:
            explicit = self._aligned_parts
            valid = isinstance(explicit,list) and bool(explicit) and all(
                isinstance(p,dict) and isinstance(p.get('speech'),str) and p['speech'].strip()
                and isinstance(p.get('translation'),str) for p in explicit)
            if valid:
                normalize=lambda s: re.sub(r'\s+','',s)
                valid = (normalize(''.join(p['speech'] for p in explicit)) == normalize(self.raw_text)
                         and normalize(''.join(p['translation'] for p in explicit)) == normalize(self._translation or ''))
            if valid:
                pairs = [(p['speech'],p['translation']) for p in explicit]
            else:
                speech_parts = _chat_paragraphs(self.raw_text)
                translations = _chat_paragraphs(self._translation) if self._translation else ['']*len(speech_parts)
                if len(speech_parts) == len(translations): pairs = list(zip(speech_parts,translations))
                # Old records with incompatible boundaries remain one complete pair.
        if self._voice_segments is not None:
            groups = voice_groups(pairs, self._voice_segments, self._voice_cleaner)
            self._segment_starts = [g[2] for g in groups]
            pairs = [(g[0], g[1]) for g in groups]
        else:
            self._segment_starts = [0]
        self._visible_count = 1 if self._pending_reveal else len(pairs)
        self._playing_bubble = 0
        self.bubbles = []
        for index, (text, translation) in enumerate(pairs):
            bubble = ChatBubble(
                text, is_user=self.is_user, avatar_path=self._avatar_path,
                translation=translation,
                image_path=self._image_path, parent=self._bubble_group, call_subtitles=self._call_subtitles)
            bubble.message_row = self
            if self._voice_reveal:
                bubble.reveal_voice(0.)
            self._bubble_layout.addWidget(bubble, 0, Qt.AlignmentFlag.AlignLeft)
            bubble.setVisible(index < self._visible_count)
            self.bubbles.append(bubble)
        self.bubble = self.bubbles[0]  # Existing analysis attachment API.
        if hasattr(self,'_available_width'):
            self.fit_width(self._available_width)
        if self.is_user:
            self._read_label.setVisible(self._read)
        if not self.is_user:
            for bubble in self.bubbles:
                bubble.avatar.installEventFilter(self)
            self.set_replay(self.playback_id, self._replay_enabled, self._replay_available)
        if analysis is not None:
            self.bubble.attach_analysis(analysis)
            analysis.message_row = self
        if self.report_button is not None:
            panel = self.bubbles[-1].text_panel
            panel.setFixedWidth(max(120, panel.width()))
            panel.layout().addWidget(self.report_button, 0, Qt.AlignmentFlag.AlignLeft)
            self.report_button.setVisible(self._diagnostic is not None)
        self._bubble_layout.invalidate()
        self._bubble_layout.activate()
        self.layout().invalidate()
        self.layout().activate()
        self.updateGeometry()
        self.update()

    def fit_width(self,available):
        self._available_width=available
        left,_,right,_=self.layout().getContentsMargins()
        beside=self._read_label.sizeHint().width() if self.is_user else 44
        for bubble in self.bubbles:
            bubble.fit_content(available-left-right-beside-30)

    def set_replay(self, playback_id, enabled, available=False):
        self.playback_id = playback_id
        self._replay_enabled = bool(enabled)
        self._replay_available = bool(available)
        if self.is_user: return
        active = bool(playback_id and enabled and available)
        label = '回放本次回复的完整原音' if active else '这条消息当前没有可用的原音' if enabled else '消息音频回放已关闭'
        for bubble in self.bubbles:
            avatar = bubble.avatar
            avatar.setCursor(Qt.CursorShape.PointingHandCursor if active else Qt.CursorShape.ArrowCursor)
            avatar.setFocusPolicy(Qt.FocusPolicy.StrongFocus if active else Qt.FocusPolicy.NoFocus)
            avatar.setToolTip(label)
            avatar.setAccessibleName(label)

    def set_read(self, read=True):
        if not self.is_user: return
        self._read = bool(read)
        self._read_label.setVisible(self._read)
        self.layout().invalidate()
        self.layout().activate()
        self.updateGeometry()

    def set_reply_parts(self, parts):
        if self.is_user or not parts or parts == self._aligned_parts: return
        self._aligned_parts = parts
        self._rebuild_bubbles()

    def pace_text(self):
        """Only newly delivered text is paced; history never calls this."""
        if self.is_user or len(self.bubbles) < 2: return
        self._pending_reveal = True
        self._visible_count = 1
        for i, bubble in enumerate(self.bubbles): bubble.setVisible(i == 0)
        self._reveal_timer.start()
        self.updateGeometry()

    def _reveal_next(self):
        self._visible_count = min(len(self.bubbles), self._visible_count + 1)
        for i, bubble in enumerate(self.bubbles): bubble.setVisible(i < self._visible_count)
        if self._visible_count == len(self.bubbles): self.finish_delivery()
        self.updateGeometry()

    def configure_voice(self, segments, clean, *, live=False):
        """Display only exact boundaries shared by speech parts and synthesis."""
        segments = list(segments)
        if self._voice_segments == segments:
            return
        self._voice_segments, self._voice_cleaner = segments, clean
        self._voice_offsets = [0]
        for part in segments or [self.raw_text]:
            self._voice_offsets.append(self._voice_offsets[-1] + len(part))
        self._pending_reveal = bool(live)
        self._rebuild_bubbles()

    def audio_segment(self, segment):
        current = max((i for i, start in enumerate(self._segment_starts) if start <= segment), default=0)
        if current != self._playing_bubble:
            if self._voice_reveal:
                for bubble in self.bubbles[self._playing_bubble:current]:
                    bubble.reveal_voice(None)
            self._particles.clear()
        self._playing_bubble = current
        if self._pending_reveal:
            self._visible_count = max(self._visible_count, current + 1)
            for i, bubble in enumerate(self.bubbles): bubble.setVisible(i < self._visible_count)
            self.updateGeometry()
        self.update()

    def audio_progress(self, segment, fraction):
        if not self._voice_reveal or segment is None:
            return
        index = self._playing_bubble
        start = self._segment_starts[index]
        parts = self._voice_segments or [self.raw_text]
        end = self._segment_starts[index + 1] if index + 1 < len(self._segment_starts) else len(parts)
        if not start <= segment < end:
            return
        total = self._voice_offsets[end] - self._voice_offsets[start]
        written = self._voice_offsets[segment] - self._voice_offsets[start] + fraction * len(parts[segment])
        self.bubbles[index].reveal_voice(written / max(1, total))

    def finish_delivery(self):
        """Keep already received text on stop/failure/new turn, without replay."""
        if not self._pending_reveal and not self._voice_reveal:
            return
        self._reveal_timer.stop()
        self._pending_reveal = False
        if self._voice_reveal:
            self._voice_reveal = False
            for bubble in self.bubbles:
                bubble.reveal_voice(None)
        self._visible_count = len(self.bubbles)
        for bubble in self.bubbles: bubble.show()
        self.updateGeometry()

    def eventFilter(self, watched, event):
        if not self.is_user and any(watched is bubble.avatar for bubble in self.bubbles):
            activated = (event.type() == QEvent.Type.MouseButtonRelease and event.button() == Qt.MouseButton.LeftButton)
            activated = activated or (event.type() == QEvent.Type.KeyPress and event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Space))
            if activated and self.playback_id and self._replay_enabled and self._replay_available:
                self.replay_requested.emit(self)
                return True
        return super().eventFilter(watched, event)

    def set_chat_bubbles(self, enabled):
        enabled = bool(enabled)
        if enabled != self._chat_bubbles:
            self.finish_delivery()
            self._chat_bubbles = enabled
            self._rebuild_bubbles()

    @property
    def diagnostic(self):
        return self._diagnostic

    def set_diagnostic(self, diagnostic):
        """语音播放结束后把滚动诊断样本挂到对应气泡。"""
        if not diagnostic or self.report_button is None:
            return
        self._diagnostic = diagnostic
        self.report_button.setVisible(True)
        self.report_button.setEnabled(True)

    def mark_diagnostic_submitted(self):
        if self.report_button is not None:
            self.report_button.setText("✓ 已标注")
            self.report_button.setEnabled(False)

    def set_playing(self, playing):
        """开启或关闭播放态；关闭后光晕与粒子会自然衰减。"""
        self._playing = bool(playing)
        if self._playing:
            if not self._effect_timer.isActive():
                self._effect_timer.start()
        else:
            self.finish_delivery()
            self._target_level = 0.0
            if self._display_level > 0.005 or self._particles:
                if not self._effect_timer.isActive():
                    self._effect_timer.start()
            else:
                self.update()

    def set_audio_level(self, level):
        """接收 0–1 的实时播放电平。"""
        level = max(0.0, min(1.0, float(level)))
        # 开平方提升低音量时的可见度，同时保留动态范围。
        self._target_level = math.sqrt(level)
        if self._playing and not self._effect_timer.isActive():
            self._effect_timer.start()

    def _effect_rect(self):
        """Only the bubble whose synthesis segment is actually being played."""
        panel = self.bubbles[min(self._playing_bubble, len(self.bubbles) - 1)].text_panel
        top_left = panel.mapTo(self, QPoint(0, 0))
        return QRectF(float(top_left.x()), float(top_left.y()), float(panel.width()), float(panel.height()))

    def _spawn_particle(self):
        rect = self._effect_rect().adjusted(-2, -2, 2, 2)
        side = random.randrange(4)
        if side == 0:  # top
            x, y = random.uniform(rect.left(), rect.right()), rect.top()
            nx, ny = random.uniform(-0.35, 0.35), -1.0
        elif side == 1:  # right
            x, y = rect.right(), random.uniform(rect.top(), rect.bottom())
            nx, ny = 1.0, random.uniform(-0.35, 0.35)
        elif side == 2:  # bottom
            x, y = random.uniform(rect.left(), rect.right()), rect.bottom()
            nx, ny = random.uniform(-0.35, 0.35), 1.0
        else:  # left
            x, y = rect.left(), random.uniform(rect.top(), rect.bottom())
            nx, ny = -1.0, random.uniform(-0.35, 0.35)
        speed = random.uniform(0.35, 1.15) * (0.5 + self._display_level)
        self._particles.append({
            "x": x, "y": y, "vx": nx * speed, "vy": ny * speed,
            "life": random.uniform(0.72, 1.0),
            "decay": random.uniform(0.035, 0.065),
            "size": random.uniform(1.0, 2.6),
        })

    def _animate_effect(self):
        response = 0.42 if self._target_level > self._display_level else 0.16
        self._display_level += (
            self._target_level - self._display_level) * response
        if self._playing and self._display_level > 0.025:
            count = 1 + int(self._display_level * 4)
            for _ in range(count):
                if random.random() < 0.45 + self._display_level * 0.4:
                    self._spawn_particle()
        alive = []
        for particle in self._particles:
            particle["x"] += particle["vx"]
            particle["y"] += particle["vy"]
            particle["life"] -= particle["decay"]
            if particle["life"] > 0:
                alive.append(particle)
        self._particles = alive
        if (not self._playing and self._display_level < 0.005
                and not self._particles):
            self._display_level = 0.0
            self._effect_timer.stop()
        self.update()

    def paintEvent(self, event):
        super().paintEvent(event)
        level = self._display_level
        if level <= 0.002 and not self._particles:
            return
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        rect = self._effect_rect()
        # 由亮品红向外透明，最大扩散约 9px，保持短半径。
        for spread in range(9, 0, -1):
            falloff = (1.0 - spread / 10.0) ** 1.7
            alpha = int(150 * level * falloff)
            if alpha <= 0:
                continue
            color = QColor(colors()['glow']); color.setAlpha(alpha)
            painter.setPen(QPen(color, 2.0))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawRoundedRect(
                rect.adjusted(-spread, -spread, spread, spread),
                10 + spread, 10 + spread)
        core = QColor(colors()['glow']); core.setAlpha(int(205 * level))
        painter.setPen(QPen(core, 1.4))
        painter.drawRoundedRect(rect.adjusted(-1, -1, 1, 1), 11, 11)

        painter.setPen(Qt.PenStyle.NoPen)
        for particle in self._particles:
            alpha = int(230 * particle["life"] * (0.35 + 0.65 * level))
            color = QColor(colors()['glow']); color.setAlpha(alpha)
            painter.setBrush(color)
            size = particle["size"] * (0.5 + particle["life"])
            painter.drawEllipse(
                QPointF(particle["x"], particle["y"]), size, size)
        painter.end()


class ChatCanvas(QWidget):
    """固定的聊天视口背景；消息在透明的独立容器中滚动。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._background = QPixmap()
        self._scaled_background = QPixmap()
        self._scaled_size = None
        self._bg_color = QColor("#1e1e1e")
        self._background_opacity = 0.48

    def set_background(self, image_path):
        pixmap = QPixmap(image_path) if image_path else QPixmap()
        if not pixmap.isNull():
            self._background = pixmap
            self._scaled_background = QPixmap()
            self._scaled_size = None
            self.update()
            return True
        return False

    def set_bg_color(self, color):
        self._bg_color = QColor(color)
        self.update()

    def set_background_opacity(self, opacity):
        """设置背景图片透明度，取值范围为 0.0 到 1.0。"""
        self._background_opacity = max(0.0, min(1.0, float(opacity)))
        self.update()

    def paintEvent(self, event):
        self.paint_background()

    def paint_background(self, size=None):
        # Use the scroll area's fixed inner bounds, including its scrollbar
        # gutter. A scrollbar appearing must not rescale/recenter the image.
        target = QRect(QPoint(), size if size is not None else self.size())
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(style_color(self._bg_color.name())))
        if not self._background.isNull() and not target.isEmpty():
            if self._scaled_size != target.size() or self._scaled_background.isNull():
                self._scaled_background = self._background.scaled(
                    target.size(), Qt.AspectRatioMode.KeepAspectRatioByExpanding,
                    Qt.TransformationMode.SmoothTransformation)
                self._scaled_size = target.size()
            scaled = self._scaled_background
            x = max(0, (scaled.width() - target.width()) // 2)
            y = max(0, round((scaled.height() - target.height()) * .37))
            source = QRect(x, y, target.width(), target.height())
            painter.setOpacity(self._background_opacity)
            painter.drawPixmap(target, scaled, source)
            painter.setOpacity(1.0)
            shade = QLinearGradient(0,0,0,target.height())
            shade.setColorAt(0,QColor(12,14,18,22))
            shade.setColorAt(.55,QColor(12,14,18,0))
            shade.setColorAt(1,QColor(12,14,18,102))
            painter.fillRect(target,shade)
        painter.end()


# ============ 消息列表（滚动区） ============
class ChatScrollArea(QScrollArea):
    """可滚动的消息列表，支持背景图"""
    history_page_size = 40
    earlier_message = pyqtSignal(object, object)

    def __init__(self, parent=None, chat_bubbles=True):
        super().__init__(parent)
        self.setWidgetResizable(True)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self.setViewport(ChatCanvas(self))
        self.viewport().setAutoFillBackground(False)
        container = QWidget()
        self._layout = QVBoxLayout(container)
        self._layout.setContentsMargins(12, 12, 12, 12)
        self._layout.setSpacing(10)
        self._layout.addStretch()
        self._summary_scroll_anchor = None
        self._batch_loading = False
        self._chat_bubbles = bool(chat_bubbles)
        self._typing_label = None
        self._system_notice = None
        self._inset_scroll_anchor = None
        self._inset_generation = 0
        self._previous_scroll_maximum = 0
        self._earlier_history = []
        self._prepend_anchor = None
        self._anchor_timer = QTimer(self)
        self._anchor_timer.setSingleShot(True)
        self._anchor_timer.timeout.connect(self._settle_history_anchor)
        self._history_timer = QTimer(self)
        self._history_timer.setSingleShot(True)
        self._history_timer.timeout.connect(self._prepend_history)
        self._batch_scroll_timer = QTimer(self)
        self._batch_scroll_timer.setSingleShot(True)
        self._batch_scroll_timer.timeout.connect(self._finish_batch_scroll)
        self.setWidget(container)
        # QScrollArea.setWidget enables this by default; keep the transcript
        # transparent so the stationary viewport remains visible beneath it.
        container.setAutoFillBackground(False)
        set_theme_style(self, "QScrollArea { background: transparent; border: none; }")
        # 气泡的 RichText/换行高度会延迟更新滚动范围。范围一旦增长，
        # 立即跟随到底部，保证新输入和新回复始终可见。
        self.verticalScrollBar().rangeChanged.connect(
            self._on_scroll_range_changed)
        self.verticalScrollBar().actionTriggered.connect(self._history_scroll_action)

    def retain_earlier(self, messages):
        self._earlier_history = messages

    def _history_scroll_action(self, action):
        # Qt also moves the scrollbar while laying out new rows. Only a
        # reader's wheel, key or slider action should request older messages.
        self._release_history_anchor()
        self._batch_scroll_timer.stop()
        bar=self.verticalScrollBar()
        upward = action in (QAbstractSlider.SliderAction.SliderToMinimum.value,
                            QAbstractSlider.SliderAction.SliderSingleStepSub.value,
                            QAbstractSlider.SliderAction.SliderPageStepSub.value)
        if action==QAbstractSlider.SliderAction.SliderMove.value:
            upward=bar.sliderPosition()<=bar.value()
        if upward and self._earlier_history and bar.sliderPosition()<=self.viewport().height()//2:
            self._history_timer.start(0)
        else:
            self._history_timer.stop()

    def _prepend_history(self):
        if not self._earlier_history:
            return
        if self.sender() is self._history_timer and self.verticalScrollBar().value()>self.viewport().height()//2:
            return
        anchor = self._layout.itemAt(0).widget() if self._layout.count()>1 else None
        if anchor is not None and self._prepend_anchor is None:
            self._prepend_anchor = (anchor,anchor.y()-self.verticalScrollBar().value())
        page = self._earlier_history[-self.history_page_size:]
        del self._earlier_history[-len(page):]
        with self.batch_update(follow_latest=False):
            for message in page:
                self.earlier_message.emit(message, anchor)
            self._layout.activate()
            self.widget().resize(self.widget().width(), max(self.viewport().height(), self.widget().minimumSizeHint().height()))
            self._layout.activate()
        self._align_history_anchor()
        self._anchor_timer.start(20)

    def _align_history_anchor(self):
        if self._prepend_anchor:
            row, top = self._prepend_anchor
            if not sip.isdeleted(row):
                bar = self.verticalScrollBar()
                bar.setValue(row.y() - top)

    def _release_history_anchor(self, *_):
        self._prepend_anchor = None
        self._anchor_timer.stop()

    def _settle_history_anchor(self):
        self._align_history_anchor()
        self._release_history_anchor()
        if self._earlier_history and self.isVisible() and self.widget().minimumSizeHint().height()<=self.viewport().height():
            self._history_timer.start(0)

    def paintEvent(self, event):
        # QAbstractScrollArea routes viewport paint events to this method.
        self.viewport().paint_background(self.contentsRect().size())

    def scrollContentsBy(self, dx, dy):
        super().scrollContentsBy(dx, dy)
        # Refresh the fixed layer instead of reusing scrolled backing pixels.
        self.viewport().update()

    def _on_scroll_range_changed(self, minimum, maximum):
        following = self._previous_scroll_maximum - self.verticalScrollBar().value() <= 3
        self._previous_scroll_maximum = maximum
        if self._batch_loading:
            return
        if self._prepend_anchor:
            self._align_history_anchor()
            return
        anchor = self._inset_scroll_anchor if self._inset_scroll_anchor is not None else self._summary_scroll_anchor
        if anchor is not None or following:
            self.verticalScrollBar().setValue(maximum if anchor is None else anchor)

    def finish_deliveries(self):
        for row in self.widget().findChildren(ChatMessageRow):
            row.finish_delivery()

    def set_bottom_inset(self, pixels):
        margins = self._layout.contentsMargins()
        pixels = max(12, int(pixels))
        if margins.bottom() == pixels:
            return
        bar = self.verticalScrollBar()
        if self._inset_scroll_anchor is None and bar.maximum() - bar.value() > 3:
            self._inset_scroll_anchor = bar.value()
        self._inset_generation += 1
        generation = self._inset_generation
        self._layout.setContentsMargins(margins.left(), margins.top(), margins.right(), pixels)
        self._layout.activate()
        def settle():
            if sip.isdeleted(self) or sip.isdeleted(bar) or generation != self._inset_generation:
                return
            if self._prepend_anchor:
                self._align_history_anchor()
            elif self._inset_scroll_anchor is not None:
                bar.setValue(self._inset_scroll_anchor)
            elif bar.maximum() - bar.value() <= 3:
                bar.setValue(bar.maximum())
            self._inset_scroll_anchor = None
        QTimer.singleShot(60, settle)

    def resizeEvent(self,event):
        super().resizeEvent(event)
        if hasattr(self,'_layout'):
            for i in range(self._layout.count()):
                row=self._layout.itemAt(i).widget()
                if isinstance(row,ChatMessageRow):self._fit_row(row)

    def _fit_row(self,row):
        left,_,right,_=self._layout.getContentsMargins()
        row.fit_width(self.viewport().width()-left-right)

    def _scroll_to_latest(self, row):
        """在布局完成后确保指定消息可见，并对齐到滚动区底部。"""
        if sip.isdeleted(row):
            return
        self._layout.activate()
        self.ensureWidgetVisible(row, 0, 16)
        bar = self.verticalScrollBar()
        bar.setValue(bar.maximum())

    def set_background(self, image_path):
        """设置聊天背景图，成功返回 True。"""
        if image_path and os.path.exists(image_path):
            return self.viewport().set_background(image_path)
        return False

    def set_background_opacity(self, opacity):
        self.viewport().set_background_opacity(opacity)

    def set_chat_bubbles(self, enabled):
        """Reversible presentation only; no new messages or audio tasks."""
        self._chat_bubbles = bool(enabled)
        with self.batch_update():
            for index in range(self._layout.count() - 1):
                row = self._layout.itemAt(index).widget()
                if isinstance(row, ChatMessageRow):
                    row.set_chat_bubbles(self._chat_bubbles)

    def add_message(self, text, is_user=False, avatar_path=None,
                    translation=None, image_path=None, analysis_panel=None, analysis_summary=None, parts=None,before_row=None,
                    voice_reveal=False):
        """添加一条消息。translation 非空时在主气泡下方加小翻译块。"""
        row = ChatMessageRow(
            str(text), is_user=is_user, avatar_path=avatar_path,
            translation=str(translation) if translation else None,
            image_path=image_path, parent=self.widget(),
            chat_bubbles=self._chat_bubbles,parts=parts,voice_reveal=voice_reveal)
        index = self._layout.count() - 1
        if before_row is not None and not sip.isdeleted(before_row):
            before=self._layout.indexOf(before_row)
            if before>=0:index=before
        self._fit_row(row)
        if analysis_summary and analysis_panel is None:
            from ui.thinking_panel import ThinkingPanel
            analysis_panel = ThinkingPanel(row.bubble.text_panel)
            analysis_panel.start(True)
            analysis_panel.update_progress({'summary': analysis_summary})
            analysis_panel.finish(True)
            analysis_panel.toggle.toggled.connect(self._keep_summary_position)
        if analysis_panel is not None:
            old_row = getattr(analysis_panel, 'message_row', None)
            if old_row is not None:
                index = self._layout.indexOf(old_row)
                self._layout.removeWidget(old_row)
                analysis_panel.geometry_changed.disconnect(old_row.bubble._resize_analysis)
            row.bubble.attach_analysis(analysis_panel)
            analysis_panel.message_row = row
            if old_row is not None:
                old_row.hide()
                old_row.deleteLater()
        self._layout.insertWidget(index, row)
        if before_row is not None and self.isVisible():
            row.show()
        # 0ms 处理普通布局；60ms 再处理字体换行/窗口重绘后的高度变化。
        if not self._batch_loading:
            QTimer.singleShot(0, lambda row=row: self._scroll_to_latest(row))
            QTimer.singleShot(60, lambda row=row: self._scroll_to_latest(row))
        return row

    def add_thinking(self, summary=None, avatar_path=None):
        from ui.thinking_panel import ThinkingPanel
        panel = ThinkingPanel(self.widget())
        panel.start(True)
        if summary:
            panel.update_progress({'summary': summary})
            panel.finish(True)
        panel.toggle.toggled.connect(self._keep_summary_position)
        self.add_message('', avatar_path=avatar_path, analysis_panel=panel)
        return panel

    def show_typing(self):
        if self._typing_label is not None:
            return self._typing_label
        label = QLabel('对方正在输入…', self.widget())
        label.setObjectName('typingIndicator')
        set_theme_style(label, 'color:#aeb6c8;background:transparent;border:0;font-size:12px;padding:4px 14px;')
        self._typing_label = label
        self._layout.insertWidget(self._layout.count()-1,label,0,Qt.AlignmentFlag.AlignLeft)
        label.show()
        if not self._batch_loading:
            QTimer.singleShot(0,lambda:self._scroll_to_latest(label))
        return label

    def clear_typing(self):
        label = self._typing_label
        self._typing_label = None
        if label is not None and not sip.isdeleted(label):
            self._layout.removeWidget(label)
            label.hide()
            label.deleteLater()

    def show_system_notice(self, message, *, on_retry=None, on_settings=None):
        """Transient system feedback, never a ChatMessageRow or persona input."""
        previous=self._system_notice
        if previous is not None and not sip.isdeleted(previous) and previous.property('message')==message and not on_retry and not on_settings and not previous.findChildren(QPushButton):
            return previous
        self.clear_system_notice()
        notice=QWidget(self.widget());notice.setObjectName('systemNotice')
        notice.setProperty('message',message)
        notice.setSizePolicy(QSizePolicy.Policy.Maximum,QSizePolicy.Policy.Fixed)
        layout=QHBoxLayout(notice);layout.setContentsMargins(14,2,14,2);layout.setSpacing(10)
        label=QLabel(message,notice);label.setTextFormat(Qt.TextFormat.PlainText)
        set_theme_style(label,'color:#9da4b2;background:transparent;font-size:12px;')
        layout.addWidget(label)
        for text,action in [('重试',on_retry),('连接设置',on_settings)]:
            if action is not None:
                button=QPushButton(text,notice);button.setCursor(Qt.CursorShape.PointingHandCursor)
                set_theme_style(button,'color:#a8c8ed;background:transparent;border:0;padding:3px;font-size:12px;')
                button.clicked.connect(action);layout.addWidget(button)
        self._system_notice=notice
        self._layout.insertWidget(self._layout.count()-1,notice,0,Qt.AlignmentFlag.AlignRight)
        if not self._batch_loading:QTimer.singleShot(0,lambda:self._scroll_to_latest(notice))
        return notice

    def clear_system_notice(self):
        notice=self._system_notice;self._system_notice=None
        if notice is not None and not sip.isdeleted(notice):
            self._layout.removeWidget(notice);notice.hide();notice.deleteLater()

    def discard_thinking(self, panel):
        """Remove only the temporary empty row, never a received reply."""
        row = getattr(panel, 'message_row', None)
        if row is None or sip.isdeleted(row) or row.raw_text:
            return False
        self._layout.removeWidget(row)
        row.hide()
        row.deleteLater()
        return True

    def _keep_summary_position(self, _expanded):
        self._summary_scroll_anchor = self.verticalScrollBar().value()
        def release():
            if self._summary_scroll_anchor is not None:
                self.verticalScrollBar().setValue(self._summary_scroll_anchor)
                self._summary_scroll_anchor = None
        QTimer.singleShot(60, release)

    def clear(self):
        # 清空所有气泡，保留底部 stretch
        self._history_timer.stop()
        self._batch_scroll_timer.stop()
        self._release_history_anchor()
        self._earlier_history = []
        self._typing_label = None
        self._system_notice = None
        while self._layout.count() > 1:
            item = self._layout.takeAt(0)
            w = item.widget()
            if w:
                w.hide()
                w.deleteLater()
        if not self._batch_loading:
            QTimer.singleShot(0, lambda: self.verticalScrollBar().setValue(0))

    @contextmanager
    def batch_update(self, follow_latest=True):
        """Restore a transcript without native window flashes or per-row scroll timers."""
        nested = self._batch_loading
        updates = self.updatesEnabled()
        self._batch_loading = True
        self.setUpdatesEnabled(False)
        try:
            yield
        finally:
            self._batch_loading = nested
            self.setUpdatesEnabled(updates)
            if not nested:
                self._layout.activate()
                if follow_latest:
                    self._batch_scroll_timer.start(0)

    def _finish_batch_scroll(self):
        if self._prepend_anchor:
            return
        if self._layout.count() > 1:
            row = self._layout.itemAt(self._layout.count() - 2).widget()
            self._scroll_to_latest(row)
        else:
            self.verticalScrollBar().setValue(0)
        if self._earlier_history and self.isVisible() and self.widget().minimumSizeHint().height()<=self.viewport().height():
            self._history_timer.start(0)

    def set_bg_color(self, color="#1e1e1e"):
        self.viewport().set_bg_color(color)


# ============ 环形波形 ============
class RingWaveform(QWidget):
    """中心封面 + 环形音量历史波形。

    source='tts' 显示明日香封面，source='user' 显示用户封面。
    set_level(0-1) 由现有 ASR/TTS 电平回调实时驱动。
    """

    BAR_COUNT = 96

    def __init__(self, parent=None, color="#e91e63"):
        super().__init__(parent)
        self._level = 0.0
        self._target = 0.0
        self._color = QColor(color)
        self._source = "tts"
        self._tts_image = QPixmap()
        self._user_image = QPixmap()
        self._spectrum_target = [0.0] * self.BAR_COUNT
        self._spectrum_display = [0.0] * self.BAR_COUNT
        self._call_state = "idle"
        self._call_label = ""
        self._phase = 0.0
        self.setFixedSize(210, 210)
        self.setMinimumSize(210, 210)
        self.setToolTip("实时语音环形波形")
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._tick)

    def set_images(self, tts_image=None, user_image=None):
        """设置两种声源的中心封面路径。"""
        if tts_image is not None:
            pixmap = QPixmap(tts_image) if tts_image else QPixmap()
            self._tts_image = pixmap if not pixmap.isNull() else QPixmap()
        if user_image is not None:
            pixmap = QPixmap(user_image) if user_image else QPixmap()
            self._user_image = pixmap if not pixmap.isNull() else QPixmap()
        self.update()

    def set_source(self, source):
        """切换当前声源封面：tts 或 user。"""
        if source not in ("tts", "user"):
            return
        if source != self._source:
            self._source = source
            self.update()

    def set_level(self, level):
        """设置整体电平（用于封面边框亮度）。"""
        raw = max(0.0, min(1.0, float(level)))
        # 提升小音量的可读性，但不抹平强弱变化。
        self._target = math.sqrt(raw)
        if not self._timer.isActive():
            self._timer.start(33)

    def set_spectrum(self, values):
        """设置当前 FFT 频带；每个值对应环上的一根径向条。"""
        try:
            data = [max(0.0, min(1.0, float(v))) for v in values]
        except (TypeError, ValueError):
            return
        if not data:
            data = [0.0]
        if len(data) != self.BAR_COUNT:
            # 线性重采样到固定柱数，兼容未来不同 FFT 配置。
            remapped = []
            for index in range(self.BAR_COUNT):
                source = index * (len(data) - 1) / max(1, self.BAR_COUNT - 1)
                left = int(source)
                right = min(len(data) - 1, left + 1)
                amount = source - left
                remapped.append(data[left] * (1 - amount) + data[right] * amount)
            data = remapped
        self._spectrum_target = data
        if not self._timer.isActive():
            self._timer.start(33)

    def set_color(self, color):
        """设置波形颜色（用户说话/明日香说话切换）"""
        self._color = QColor(color)

    def set_call_state(self, state, label=""):
        """在现有头像/频谱上叠加通话状态，不遮挡聊天区。"""
        state = str(getattr(state, "value", state) or "idle")
        allowed = {
            "idle", "dialing", "connected", "muted",
            "restoring_mic", "disconnecting", "failed",
        }
        self._call_state = state if state in allowed else "idle"
        self._call_label = str(label or "")
        self.setToolTip(self._call_label or "实时语音环形波形")
        if self._call_state in {
                "dialing", "restoring_mic", "disconnecting"}:
            if not self._timer.isActive():
                self._timer.start(33)
        self.update()

    def reset(self):
        self._target = 0.0
        self._level = 0.0
        self._spectrum_target = [0.0] * self.BAR_COUNT
        self._spectrum_display = [0.0] * self.BAR_COUNT
        self._timer.stop()
        self.update()

    def _tick(self):
        animated_state = self._call_state in {
            "dialing", "restoring_mic", "disconnecting"}
        self._phase = (self._phase + 0.10) % math.tau
        diff = self._target - self._level
        response = 0.38 if diff > 0 else 0.16
        if abs(diff) > 0.003:
            self._level += diff * response
        else:
            self._level = self._target
        if self._target < 0.002 and self._level < 0.004:
            self._level = 0
        has_live_spectrum = any(self._spectrum_target)
        for index, target in enumerate(self._spectrum_target):
            if animated_state and not has_live_spectrum:
                position = index / max(1, self.BAR_COUNT - 1)
                target = 0.10 + 0.12 * (
                    0.5 + 0.5 * math.sin(
                        self._phase * 2.0 - position * math.tau * 2.0))
            current = self._spectrum_display[index]
            band_response = 0.48 if target > current else 0.20
            current += (target - current) * band_response
            if target < 0.002 and current < 0.003:
                current = 0.0
            self._spectrum_display[index] = current
        self.update()
        if (self._target == 0 and self._level == 0
                and not any(self._spectrum_target)
                and not any(self._spectrum_display)
                and not animated_state):
            self._timer.stop()

    @staticmethod
    def _mix_color(a, b, amount, alpha=255):
        amount = max(0.0, min(1.0, amount))
        return QColor(
            round(a.red() + (b.red() - a.red()) * amount),
            round(a.green() + (b.green() - a.green()) * amount),
            round(a.blue() + (b.blue() - a.blue()) * amount),
            alpha,
        )

    def _draw_cover(self, painter, center, radius):
        target = QRectF(center.x() - radius, center.y() - radius,
                        radius * 2, radius * 2)
        pixmap = self._tts_image if self._source == "tts" else self._user_image
        path = QPainterPath()
        path.addEllipse(target)
        painter.save()
        painter.setClipPath(path)
        if not pixmap.isNull():
            scaled = pixmap.scaled(
                round(radius * 2), round(radius * 2),
                Qt.AspectRatioMode.KeepAspectRatioByExpanding,
                Qt.TransformationMode.SmoothTransformation)
            x = max(0, (scaled.width() - round(radius * 2)) // 2)
            y = max(0, (scaled.height() - round(radius * 2)) // 2)
            source = QRectF(x, y, radius * 2, radius * 2)
            painter.drawPixmap(target, scaled, source)
        else:
            # 尚未导入用户图片时，显示明确的麦克风占位背景。
            gradient = QLinearGradient(target.topLeft(), target.bottomRight())
            if self._source == "user":
                gradient.setColorAt(0, QColor(style_color("#173f4b")))
                gradient.setColorAt(1, QColor(style_color("#26364f")))
            else:
                gradient.setColorAt(0, QColor(style_color("#532445")))
                gradient.setColorAt(1, QColor(style_color("#252b48")))
            painter.fillRect(target, gradient)
            painter.setPen(QColor(240, 245, 255, 220))
            painter.setFont(QFont("Segoe UI Symbol", 22, QFont.Weight.Bold))
            painter.drawText(target, Qt.AlignmentFlag.AlignCenter,
                             "MIC" if self._source == "user" else "香")
        painter.restore()
        border = QColor(255, 255, 255, 72 + round(self._level * 100))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.setPen(QPen(border, 2.0))
        painter.drawEllipse(target)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        w, h = self.width(), self.height()
        center = QPointF(w / 2, h / 2)
        cover_radius = 62.0
        bar_start = 72.0
        max_bar_length = 25.0
        values = self._spectrum_display
        cyan = QColor(colors()['voice_start'])
        magenta = QColor(colors()['mic_end' if self._source == 'user' else 'voice_end'])

        for i, value in enumerate(values):
            angle = (i / self.BAR_COUNT) * math.tau - math.pi / 2
            # 静止时保留细小刻度；音量历史决定每根径向条的长度和亮度。
            bar_length = 3.5 + value * max_bar_length
            x1 = center.x() + math.cos(angle) * bar_start
            y1 = center.y() + math.sin(angle) * bar_start
            x2 = center.x() + math.cos(angle) * (bar_start + bar_length)
            y2 = center.y() + math.sin(angle) * (bar_start + bar_length)
            color = self._mix_color(cyan, magenta, i / (self.BAR_COUNT - 1),
                                    55 + round(value * 200))
            pen = QPen(color, 2.0 + value * 1.4)
            pen.setCapStyle(Qt.PenCapStyle.RoundCap)
            painter.setPen(pen)
            painter.drawLine(QPointF(x1, y1), QPointF(x2, y2))

        self._draw_cover(painter, center, cover_radius)
        if self._call_state == "muted":
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QColor(16, 18, 24, 112))
            painter.drawEllipse(QRectF(
                center.x() - cover_radius, center.y() - cover_radius,
                cover_radius * 2, cover_radius * 2))
        if self._call_label:
            label_rect = QRectF(
                center.x() - 53, center.y() + 35, 106, 22)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QColor(20, 22, 29, 205))
            painter.drawRoundedRect(label_rect, 11, 11)
            label_color = QColor(colors()['accent'])
            if self._call_state in {"connected", "restoring_mic"}:
                label_color = QColor("#a9ebdc")
            elif self._call_state == "failed":
                label_color = QColor("#ffabb7")
            painter.setPen(label_color)
            painter.setFont(QFont("Microsoft YaHei UI", 9, QFont.Weight.Medium))
            painter.drawText(
                label_rect, Qt.AlignmentFlag.AlignCenter, self._call_label)
        painter.end()
