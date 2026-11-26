# -*- coding: utf-8 -*-
"""Safe Markdown + local math rendering for chat messages.

Qt's Markdown parser does not typeset LaTeX math. This module keeps the
message renderer offline by turning math spans into supersampled transparent
images through matplotlib's MathText engine, then lets Python-Markdown handle
the surrounding text.
"""
from __future__ import annotations

import base64
import html
import io
import re
import struct
from functools import lru_cache

import markdown


_TOKEN_RE = re.compile(
    r"(?P<fence>```[^\n]*\n.*?```|~~~[^\n]*\n.*?~~~)"
    r"|(?P<code>`[^`\n]+`)"
    r"|(?P<escaped_dollar_block>\\\$\\\$(?P<escaped_block_body>.+?)\\\$\\\$)"
    r"|(?P<dollar_block>\$\$(?P<dollar_body>.+?)\$\$)"
    r"|(?P<bracket_block>\\\[(?P<bracket_body>.+?)\\\])"
    r"|(?P<paren_inline>\\\((?P<paren_body>.+?)\\\))"
    r"|(?P<escaped_dollar_inline>(?<!\\)\\\$(?!\s)"
    r"(?P<escaped_inline_body>[^$\n]+?)(?<!\s)\\\$)"
    r"|(?P<dollar_inline>(?<!\\)\$(?!\$|\s)"
    r"(?P<inline_body>[^$\n]+?)(?<!\\|\s)\$)",
    re.DOTALL,
)


def _normalise_formula(source: str) -> list[str]:
    """Return one or more MathText-compatible lines for common LLM output."""
    value = source.strip().replace(r"\displaystyle", "")
    environment = re.fullmatch(
        r"\\begin\{(?:aligned|align\*?|equation\*?|gathered)\}"
        r"(.*?)"
        r"\\end\{(?:aligned|align\*?|equation\*?|gathered)\}",
        value,
        re.DOTALL,
    )
    if environment:
        value = environment.group(1).strip()
    lines = [
        line.strip().replace("&", "")
        for line in re.split(r"\\\\", value)
    ]
    return [line for line in lines if line] or [value]


_FORMULA_SCALE = 3


@lru_cache(maxsize=256)
def _formula_image(
        formula: str, color: str, font_size: int) -> tuple[str, int, int]:
    # matplotlib is intentionally lazy: normal conversations do not pay its
    # import/start-up cost.
    import matplotlib as mpl
    from matplotlib.font_manager import FontProperties
    from matplotlib.mathtext import math_to_image

    output = io.BytesIO()
    font = FontProperties(size=font_size)
    with mpl.rc_context({
        "savefig.transparent": True,
        "savefig.facecolor": "none",
        "savefig.edgecolor": "none",
    }):
        math_to_image(
            f"${formula}$", output, prop=font,
            dpi=96 * _FORMULA_SCALE, format="png", color=color,
        )
    raw = output.getvalue()
    # PNG's IHDR stores the physical pixel dimensions at bytes 16..24. Embed
    # the 3x source but declare its 1x logical size: QTextDocument then
    # downscales from a dense source instead of enlarging a blurry bitmap.
    pixel_width, pixel_height = struct.unpack(">II", raw[16:24])
    logical_width = max(1, round(pixel_width / _FORMULA_SCALE))
    logical_height = max(1, round(pixel_height / _FORMULA_SCALE))
    encoded = base64.b64encode(raw).decode("ascii")
    return (
        f"data:image/png;base64,{encoded}",
        logical_width,
        logical_height,
    )


def _render_formula(formula: str, color: str, display: bool) -> str:
    try:
        # Inline math participates in an ordinary QLabel text line.  Rendering
        # it at display-math scale makes Qt enlarge the whole line and produces
        # the sticker-like result seen with fractions and subscripts.  Keep it
        # close to the 14 px chat font; only standalone math gets extra size.
        font_size = 12 if display else 9
        images = []
        for line in _normalise_formula(formula):
            uri, width, height = _formula_image(line, color, font_size)
            images.append(
                f'<img src="{uri}" width="{width}" height="{height}" '
                'align="middle" />')
    except Exception:
        # Unsupported LaTeX must remain readable and must never break a bubble.
        delimiters = ("$$", "$$") if display else ("$", "$")
        return html.escape(f"{delimiters[0]}{formula}{delimiters[1]}")
    if display:
        return '<div align="center">' + "<br />".join(images) + "</div>"
    return "".join(images)


def render_markdown_math(text: str, color: str = "#e8e8f0") -> str:
    """Convert display text to safe HTML with locally rendered math images.

    Raw HTML is escaped before Markdown parsing. Formula-looking content in
    fenced and inline code spans is left untouched.
    """
    source = str(text)
    replacements: dict[str, str] = {}
    chunks: list[str] = []
    cursor = 0
    formula_index = 0

    for match in _TOKEN_RE.finditer(source):
        chunks.append(source[cursor:match.start()])
        kind = match.lastgroup
        if kind in {"fence", "code"}:
            chunks.append(match.group(0))
        else:
            if kind == "escaped_dollar_block":
                formula = match.group("escaped_block_body")
                display = True
            elif kind == "dollar_block":
                formula = match.group("dollar_body")
                display = True
            elif kind == "bracket_block":
                formula = match.group("bracket_body")
                display = True
            elif kind == "paren_inline":
                formula = match.group("paren_body")
                display = False
            elif kind == "escaped_dollar_inline":
                formula = match.group("escaped_inline_body")
                display = False
            else:
                formula = match.group("inline_body")
                display = False
            token = f"MATHRENDERTOKEN{formula_index}END"
            formula_index += 1
            replacements[token] = _render_formula(formula, color, display)
            chunks.append(token)
        cursor = match.end()
    chunks.append(source[cursor:])

    # Escaping first prevents model/user supplied HTML from creating external
    # resources or changing the bubble layout. Markdown syntax remains intact.
    escaped = html.escape("".join(chunks), quote=False)
    rendered = markdown.markdown(
        escaped,
        extensions=["fenced_code", "sane_lists"],
        output_format="html5",
    )
    for token, replacement in replacements.items():
        rendered = rendered.replace(f"<p>{token}</p>", replacement)
        rendered = rendered.replace(token, replacement)

    return (
        "<style>"
        "p { margin: 0 0 4px 0; }"
        "ul, ol { margin-top: 2px; margin-bottom: 4px; }"
        "pre { white-space: pre-wrap; }"
        "code { color: #d9b7ff; }"
        "</style>"
        f"<div style=\"color: {color};\">{rendered}</div>"
    )
