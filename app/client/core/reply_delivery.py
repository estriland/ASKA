"""Display boundaries backed by the existing synthesis plan, without alignment."""
import re

SINGLE_VOICE = 'single-spoken-turn/1'


def _spoken_key(text):
    # TTS inserts pause glyphs and removes sentence whitespace. No word, kana,
    # number or other punctuation is discarded; a mismatch stays one bubble.
    return re.sub(r'[\s…、]+', '', text)


def voice_groups(pairs, segments, clean):
    """Merge display parts unless their end is also a unique synthesis end.

    Returns (speech, translation, first synthesis segment). Never cuts text or
    audio, and never changes the original synthesis plan.
    """
    whole = ('\n\n'.join(p[0] for p in pairs), '\n\n'.join(p[1] or '' for p in pairs), 0)
    if not segments or not pairs:
        return [whole]
    spoken = [_spoken_key(clean(p[0])) for p in pairs]
    audio = [_spoken_key(s) for s in segments]
    if not all(spoken) or not all(audio) or ''.join(spoken) != ''.join(audio):
        return [whole]
    ends, offset = {}, 0
    for i, segment in enumerate(audio):
        offset += len(segment)
        ends[offset] = i + 1
    groups, first_part, first_segment, offset = [], 0, 0, 0
    for i, part in enumerate(spoken):
        offset += len(part)
        if offset in ends:
            subset = pairs[first_part:i + 1]
            groups.append(('\n\n'.join(p[0] for p in subset),
                           '\n\n'.join(p[1] or '' for p in subset), first_segment))
            first_part, first_segment = i + 1, ends[offset]
    return groups or [whole]


def replay_spans(record, samples):
    """Use recorded, completed synthesis lengths only; no proportional timing."""
    if not isinstance(record,dict) or not isinstance(record.get('generation'),dict): return []
    segments = record['generation'].get('segments', [])
    actual = (record or {}).get('actual_generation', {})
    if not isinstance(segments,list) or not segments or not all(isinstance(s,str) and s for s in segments) or record.get('samples') != samples:
        return []
    if isinstance(actual, dict):
        if set(actual) != {str(i) for i in range(len(segments))}: return []
        rows = [actual[str(i)] for i in range(len(segments))]
        if not all(isinstance(r,dict) for r in rows): return []
        counts = [r.get('pcm_samples') if r.get('ended_on_eos') is True else None for r in rows]
    elif isinstance(actual, list) and len(actual) == len(segments):
        if not all(isinstance(r,dict) for r in actual): return []
        counts = [r.get('samples') if r.get('index') == i and r.get('status') == 'complete'
                  and r.get('text') == segments[i] else None for i, r in enumerate(actual)]
    else:
        return []
    if any(type(n) is not int or n <= 0 for n in counts) or sum(counts) != samples:
        return []
    spans, start = [], 0
    for index, count in enumerate(counts):
        spans.append((start, start + count, index))
        start += count
    return spans
