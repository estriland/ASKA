"""Lightweight text reveal driven by PCM submitted to this reply's output device."""
from bisect import bisect_left
import time
import unicodedata

from PyQt6.QtCore import QRectF
from PyQt6.QtGui import QPainter, QPainterPath, QTextDocument
from PyQt6.QtWidgets import QLabel

from core.reply_delivery import replay_spans


class PlaybackProgress:
    """The device callback only updates counters. Text projection runs on the UI thread."""

    def __init__(self, speech):
        self.speech = speech
        self.set_segments([])
        self._ends = []
        self._duration = 0.
        self._position = (0., None, 0.)
        self.first_output = None
        self.last_output = None

    def use_recording(self, record):
        if not isinstance(record, dict):
            return
        samples = record.get('samples')
        rate = record.get('sample_rate')
        if type(samples) is int and samples > 0 and type(rate) is int and rate > 0:
            self._duration = samples / rate
            self._ends = [end / rate for _, end, _ in replay_spans(record, samples)]

    def set_segments(self, segments):
        self.segments = list(segments)
        self._estimated_durations = [
            max(.45, sum(.20 if unicodedata.east_asian_width(char) in ('W','F') else .08 for char in part))
            for part in self.segments or [self.speech]]

    def segment_started(self, index):
        elapsed, active, _ = self._position
        if index != active:
            self._position = elapsed, index, elapsed if index else 0.

    def rendered(self, samples, rate):
        elapsed, index, start = self._position
        duration = samples / rate
        stamp = time.perf_counter()
        if self.first_output is None:
            self.first_output = stamp
        self.last_output = stamp + duration
        self._position = elapsed + duration, index, start

    def overlaps(self, span):
        return (self.first_output is not None and self.last_output is not None
                and self.first_output <= (span.ended_at or time.perf_counter()) and self.last_output >= span.began_at)

    def position(self):
        elapsed, index, start = self._position
        if not elapsed:
            return None, 0., 0
        parts = self.segments or [self.speech]
        if self._ends and len(self._ends) == len(parts):
            index = min(len(parts) - 1, bisect_left(self._ends, elapsed))
            start = self._ends[index - 1] if index else 0.
            duration = self._ends[index] - start
        elif self._duration and len(parts) == 1:
            index, start, duration = 0, 0., self._duration
        else:
            index = min(max(0, index or 0), len(parts) - 1)
            # The first stream has no final duration or word timestamps yet.
            # Reserve the tail until the next marked segment or natural completion.
            duration = self._estimated_durations[index]
            return index, min(.94, (elapsed - start) / duration), round(1000 * elapsed)
        return index, min(1., max(0., (elapsed - start) / duration)), round(1000 * elapsed)

    def boundary(self):
        index, fraction, played_ms = self.position()
        prefix = ''
        if index is not None:
            parts = self.segments or [self.speech]
            # Match the original glyphs before deriving a prefix. Pauses inserted
            # for synthesis can differ from the display text.
            keep = lambda c: not c.isspace() and c not in '…、'
            lengths = [sum(map(keep, part)) for part in parts]
            offsets = [i + 1 for i, ch in enumerate(self.speech) if keep(ch)]
            comparable = ''.join(ch for part in parts for ch in part if keep(ch))
            if comparable == ''.join(self.speech[i - 1] for i in offsets):
                heard = sum(lengths[:index]) + int(lengths[index] * fraction + 1e-9)
                if heard:
                    prefix = self.speech[:offsets[heard - 1]]
        return {'played_ms': played_ms, 'segment_index': index, 'heard_prefix': prefix, 'estimated': True}


class VoiceRevealLabel(QLabel):
    """Keep the full layout fixed and draw only the prefix reached by playback."""

    def __init__(self, html):
        super().__init__(html)
        self.fraction = None
        self._document = None

    def reveal(self, fraction):
        if self.fraction == fraction:
            return
        self.fraction = fraction
        if fraction is None:
            self._document = None
        self.update()

    def paintEvent(self, event):
        if self.fraction is None or self.fraction >= 1:
            super().paintEvent(event)
            return
        if self.fraction <= 0:
            return
        if self._document is None:
            self._document = QTextDocument()
            self._document.setDocumentMargin(0)
            self._document.setDefaultFont(self.font())
            self._document.setHtml(self.text())
        doc = self._document
        if doc.textWidth() != self.width():
            doc.setTextWidth(self.width())
        extent = doc.size()
        offset = int(self.fraction * (doc.characterCount() - 1))
        block = doc.findBlock(offset)
        if not block.isValid():
            return
        local = offset - block.position()
        layout = block.layout()
        line = layout.lineForTextPosition(local)
        if not line.isValid():
            return
        bounds = doc.documentLayout().blockBoundingRect(block)
        x1 = line.cursorToX(line.textStart())[0] + bounds.x()
        x2 = line.cursorToX(local)[0] + bounds.x()
        top = bounds.y() + line.y()
        clip = QPainterPath()
        clip.addRect(QRectF(0, 0, self.width(), top))
        clip.addRect(QRectF(min(x1, x2), top, abs(x2 - x1), line.height()))
        painter = QPainter(self)
        painter.translate(0, max(0., (self.height() - extent.height()) / 2))
        painter.setClipPath(clip)
        doc.drawContents(painter)
        painter.end()
