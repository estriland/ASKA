"""Playback reference and turn ownership for a live, local voice call."""
from collections import deque
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from itertools import count
import threading
import time
import unicodedata

import numpy as np


def _words(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text).casefold() if c.isalnum())


_STOP = {'停', '等等', '等一下', '停一下', '先停一下', '别说了', 'stop', 'wait', '待って', 'ストップ'}
_BACKCHANNEL = {'嗯', '嗯嗯', '啊', '哦', '呃', '唔', 'うん', 'はい', 'ええ', 'uh', 'um', 'mhm'}


@dataclass
class CallUtterance:
    number: int
    reply: str | None
    echoes: tuple
    began_at: float = field(default_factory=time.perf_counter)
    ended_at: float | None = None
    ended: threading.Event = field(default_factory=threading.Event)

    def finish(self):
        self.ended_at = time.perf_counter()
        self.ended.set()


class CallAudio:
    """One instance per call. Full-rate samples stay in a short, in-memory reference."""
    reference_seconds = .8

    def __init__(self):
        self.target = None
        self._target_since = 0.
        self.ducked = False
        self._speaking = ()
        self._audible = False
        self._recent_text = ()
        self._text_until = 0.
        self._sequence = count()
        self._rendered = deque(maxlen=160)
        self._reference = np.empty(0, dtype=np.float32)
        self._last_output = 0.
        self._seen_output = 0.
        self._echo_delays = ()

    def expect(self, reply):
        self.finish(self.target)
        self.target = reply
        self._target_since = time.perf_counter()

    def speaking(self, reply, speech, subtitle=''):
        if reply == self.target and reply is not None:
            self._speaking = tuple(s for s in (_words(speech), _words(subtitle)) if s)

    def finish(self, reply):
        if reply != self.target:
            return
        if self._speaking and self._audible:
            self._recent_text = self._speaking
            self._text_until = time.monotonic() + self.reference_seconds
        self._speaking = ()
        self._audible = False
        self.target = None
        self.ducked = False

    def utterance(self):
        echoes = self._recent_text if time.monotonic() < self._text_until else ()
        if self._audible and time.monotonic() - self._last_output <= self.reference_seconds:
            echoes += self._speaking
        return CallUtterance(next(self._sequence), self.target, echoes)

    def interrupt_target(self, span):
        # A reply can begin after speech onset. Associate it only while the
        # microphone segment actually overlaps it, never on a late ASR result.
        if (span.reply is None and self.target is not None and self._target_since >= span.began_at
                and (span.ended_at is None or self._target_since < span.ended_at)):
            span.reply = self.target
        return self.target if self.target is not None and self.target == span.reply else None

    def decision(self, span, text):
        """Only final speech is sent. A probe may stop the previous reply early."""
        heard = _words(text)
        if not heard:
            return 'ignore'
        references = span.echoes
        if self._audible and time.monotonic() - self._last_output < self.reference_seconds:
            references += self._speaking
        for ref in references:
            if heard == ref or len(heard) >= 3 and heard in ref:
                return 'echo'
            if min(len(heard), len(ref)) >= 4 and SequenceMatcher(None, heard, ref).ratio() >= .85:
                return 'echo'
        if span.reply is None:
            return 'speech'
        if heard in _STOP:
            return 'stop'
        return 'speech' if len(heard) >= 2 and heard not in _BACKCHANNEL else 'ignore'

    def render(self, output, sample_rate):
        """PortAudio callback: apply current gain and retain what was actually submitted."""
        if self.ducked:
            output *= .18
        stamp = time.monotonic()
        self._rendered.append((stamp, sample_rate, output.copy()))
        self._last_output = stamp
        self._audible = True

    def render_for(self, reply, output, sample_rate):
        if reply is None or self.target != reply:
            output.fill(0)
            return
        self.render(output, sample_rate)

    def filter_input(self, audio, sample_rate):
        """Remove a delayed, scaled copy of playback before VAD; retain double talk."""
        now = time.monotonic()
        if now - self._last_output > self.reference_seconds:
            return audio
        new = []
        while True:
            try: stamp, rate, data = self._rendered.popleft()
            except IndexError: break
            if now - stamp > self.reference_seconds:
                continue
            if stamp - self._seen_output > self.reference_seconds:
                self._reference = np.empty(0, dtype=np.float32)
                self._echo_delays = ()
                new.clear()
            self._seen_output = stamp
            if rate != sample_rate:
                data = np.interp(np.arange(0,len(data),rate/sample_rate),np.arange(len(data)),data).astype(np.float32)
            new.append(data)
        if new:
            self._reference = np.concatenate([self._reference,*new])[-int(self.reference_seconds*sample_rate):]
        ref = self._reference
        n = len(audio)
        if n < 32 or len(ref) < n:
            return audio
        original_energy = float(audio @ audio)
        quiet = min(n * .002 ** 2, .08 * original_energy)
        end = len(ref)-n
        old = [end-delay for delay in self._echo_delays if 0 <= end-delay <= end]
        best_residual = self._fit_paths(audio,ref,old) if old else audio
        best_energy = float(best_residual @ best_residual)
        if best_energy < quiet:
            return np.zeros_like(audio)
        # Fit both gains jointly: two delayed copies of speech are often correlated.
        positions = []
        residual = audio
        for _ in range(2):
            pos = self._find_path(ref,residual)
            if pos is None or pos in positions:
                break
            positions.append(pos)
            residual = self._fit_paths(audio,ref,positions)
            power = float(residual @ residual)
            if power < best_energy:
                best_energy, best_residual = power, residual
                if power < .12*original_energy:
                    self._echo_delays = tuple(end-p for p in positions)
            if power < quiet:
                return np.zeros_like(audio)
        return best_residual

    @staticmethod
    def _fit_paths(audio,ref,positions):
        n = len(audio)
        lags = sorted({lag for pos in positions for lag in (pos - 1, pos, pos + 1)
                       if 0 <= lag <= len(ref) - n})
        basis = np.column_stack([ref[lag:lag + n] for lag in lags])
        gains = np.linalg.lstsq(basis, audio, rcond=.02)[0]
        return audio - basis @ gains

    @staticmethod
    def _find_path(ref, audio):
        n = len(audio)
        mic = audio[::4]
        mic = mic - mic.mean()
        power = float(mic @ mic)
        if power < 1e-8:
            return None
        score, best = 0., 0
        for phase in range(4):
            coarse = ref[phase::4]
            if len(coarse) < len(mic):
                continue
            prefix = np.concatenate(([0.], np.cumsum(coarse*coarse,dtype=np.float64)))
            energy = prefix[len(mic):] - prefix[:-len(mic)]
            fit = np.abs(np.correlate(coarse,mic,'valid')) / np.sqrt(np.maximum(energy*power,1e-12))
            pos = int(np.argmax(fit))
            if fit[pos] > score:
                score, best = fit[pos], 4*pos+phase
        if score < .48:
            return None
        chosen, best_energy = None, float(audio @ audio)
        for lag in range(max(0,best-3), min(len(ref)-n,best+3)+1):
            sample = ref[lag:lag+n]
            strength = float(sample @ sample)
            if strength < 1e-8:
                continue
            residual = audio - sample * ((audio @ sample) / strength)
            amount = float(residual @ residual)
            if amount < best_energy:
                chosen, best_energy = lag, amount
        return chosen
