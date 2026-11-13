"""Syntax-only Markdown cleaning that preserves source facts and literal code."""

from html import unescape
import re
import uuid

try:
    from backend.note_generation_contract import _ASSET
    from backend.markdown_code import transform_code
    from backend.note_service_card import parse_frontmatter
except ImportError:
    from note_generation_contract import _ASSET
    from markdown_code import transform_code
    from note_service_card import parse_frontmatter


def protect_code(text):
    protected = {}
    namespace = uuid.uuid4().hex

    def replace(literal):
        key = f"NODACODE{namespace}N{len(protected)}END"
        protected[key] = literal
        return key

    return transform_code(text, replace), protected


def restore_code(text, protected):
    for marker, original in protected.items():
        text = text.replace(marker, original)
    return text


def _image_caption(match):
    return image_caption(match.group(0))


def image_caption(raw):
    """Read an authored caption, never infer one from an attachment filename."""
    if raw.startswith("![["):
        parts = raw[3:-2].split("|", 1)
        if len(parts) == 2 and not re.fullmatch(r"\d+(?:x\d+)?", parts[1]):
            return parts[1]
        return " "
    if raw.startswith("!["):
        return raw[2 : raw.index("]")]
    alt = re.search(r"\balt\s*=\s*([\"'])(.*?)\1", raw, flags=re.IGNORECASE | re.DOTALL)
    return unescape(alt.group(2)) if alt else " "


def clean_retrieval_text(content, max_chars=0):
    _, body = parse_frontmatter(str(content or ""))
    text, protected = protect_code(body)
    text = re.sub(r"(?s)<!--.*?-->", " ", text)
    text = _ASSET.sub(_image_caption, text)
    text = re.sub(
        r"\[\[([^\[\]]+)\]\]", lambda match: match.group(1).replace("|", " "), text
    )
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", text)
    text = re.sub(r"<((?:https?|mailto):[^>]+)>", r"\1", text)
    text = re.sub(r"</?[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*?)?/?>", " ", text)
    text = re.sub(r"(?m)^[ \t]*(?:#[\w-]+(?:/[\w-]+)*[ \t]*)+$", "", text)
    text = re.sub(r"(?m)^[ \t]{0,3}#{1,6}[ \t]+", "", text)
    text = re.sub(r"(?m)^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]*", "", text)
    text = re.sub(r"(?m)^[ \t]*[-*+][ \t]+", "", text)
    text = re.sub(r"(?m)^[ \t]*>[ \t]?", "", text)
    text = re.sub(r"(?<!\w)(\*\*|__|\*|_)(\S(?:[^\n]*?\S)?)\1(?!\w)", r"\2", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]+|[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    text = restore_code(text, protected).strip()
    if max_chars > 0:
        text = text[:max_chars].rstrip()
    return text
