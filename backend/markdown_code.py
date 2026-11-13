"""Locate literal code blocks by CommonMark structure, preserving source bytes."""
import re

from markdown_it import MarkdownIt


CODE_PATTERN = re.compile(
    r"(?ms)^[ \t]*(?P<fence>`{3,}|~{3,})[^\n]*\n.*?^[ \t]*(?P=fence)[ \t]*(?:\n|$)"
    r"|`+[^`\n]+`+"
)


def code_spans(text):
    offsets = [0] + [match.end() for match in re.finditer(r"\r\n?|\n", text)]
    offsets.append(len(text))
    blocks = []
    for token in MarkdownIt('commonmark').parse(text):
        if token.type in ('code_block', 'fence') and token.map is not None:
            start, end = token.map
            blocks.append((offsets[start], offsets[end]))
    spans = list(blocks)
    for match in CODE_PATTERN.finditer(text):
        start, end = match.span()
        if not any(start < stop and end > begin for begin, stop in blocks):
            spans.append((start, end))
    return sorted(spans)


def transform_code(text, replace):
    parts, position = [], 0
    for start, end in code_spans(text):
        parts.extend((text[position:start], replace(text[start:end])))
        position = end
    parts.append(text[position:])
    return ''.join(parts)
