"""Bound synthesis requests without dropping or rewriting the prepared text."""
import re
import unicodedata

SEGMENT_LIMITS = {'Japanese': 80, 'Chinese': 80, 'English': 240}
_SENTENCE = re.compile(r'[。！？!?]+[」』”’\"\']*\s*|(?<!\d)\.(?=\s|$)\s*')
_CLAUSE = re.compile(r'[、，,；;：:]\s*|\s+')

# V4's short conversational reply keeps its full prosodic context. This is an
# engineering bound, not a claim that every 160-character utterance is optimal.
V4_COHERENT_SHORT_LIMIT = 160

_LETTER_NAMES = ('エー ビー シー ディー イー エフ ジー エイチ アイ ジェー ケー エル エム '
                 'エヌ オー ピー キュー アール エス ティー ユー ブイ ダブリュー エックス ワイ ゼット').split()
_DIGIT_NAMES = 'ゼロ いち に さん よん ご ろく なな はち きゅう'.split()
_IDENTIFIER = re.compile(r'(?<![A-Za-z0-9_/.:\\-])([A-Z]{2,6})-([0-9]{1,6})(?![A-Za-z0-9_/.-])')
_NUMBER_CONTEXT = re.compile(r'(?:番号|型番|識別子|認証コード|シリアルコード|一文字ずつ|一字ずつ)[^。！？\n]{0,22}$')

def spoken_segments(segments,language,preset):
    """Spell numbered letter codes only in an explicit Japanese identifier context."""
    if language!='Japanese' or not preset:return segments
    joined=''.join(segments)
    prefixes={m[1] for m in _IDENTIFIER.finditer(joined) if _NUMBER_CONTEXT.search(joined[:m.start()])}
    if not prefixes:return segments
    def spell(match):
        if match[1] not in prefixes:return match[0]
        letters=[_LETTER_NAMES[ord(c)-ord('A')] for c in match[1]]
        digits=[_DIGIT_NAMES[int(c)] for c in match[2]]
        return '、'.join([*letters,'ハイフン',*digits])
    limit=V4_COHERENT_SHORT_LIMIT if preset=='natural' else SEGMENT_LIMITS['Japanese']
    result=[]
    for text in segments:
        spoken=_IDENTIFIER.sub(spell,text)
        result.append(spoken if len(spoken)<=limit else text)
    return result

def plan_synthesis_segments(text, language, *, voice_preset=None):
    if voice_preset == 'natural' and language == 'Japanese' and len(text) <= V4_COHERENT_SHORT_LIMIT:
        return [text] if text else []
    return split_synthesis_text(text, language)


def split_synthesis_text(text, language, *, limit=None):
    """Prefer sentence ends; split an oversized sentence at clauses/word gaps.

    The hard limit is a starting engineering bound, not a proven quality cutoff.
    Short inputs take the exact original path. Concatenation reproduces input.
    """
    limit = limit if limit is not None else SEGMENT_LIMITS.get(language, 80)
    if limit < 2:
        raise ValueError('TTS segment limit must be at least 2')
    segments = []
    while len(text) > limit:
        window = text[:limit + 1]
        ends = [m.end() for m in _SENTENCE.finditer(window) if m.end() <= limit]
        if not ends:
            ends = [m.end() for m in _CLAUSE.finditer(window) if m.end() <= limit]
        end = ends[-1] if ends else limit
        if not ends and text[end] in '。！？!?、，,；;：:」』”’':
            end -= 1  # Do not leave only final punctuation for another request.
        # Keep combining marks with their base when falling back to a hard cut.
        while end > 1 and unicodedata.combining(text[end]):
            end -= 1
        segments.append(text[:end])
        text = text[end:]
    if text:
        segments.append(text)
    return segments
