"""Shared structural validation for model-edited note titles."""

import json
import re
from collections import Counter
import unicodedata

try:
    from backend.note_identity_context import source_language
    from backend.note_metadata import parse_metadata
    from backend.note_prompt_source import metadata_source
except ImportError:
    from note_identity_context import source_language
    from note_metadata import parse_metadata
    from note_prompt_source import metadata_source


def anchors(title, language=None):
    patterns = [
        r"«[^»]+»",
        r"(?<!\w)[−+-]?\d+(?:[.,]\d+)?(?:\s*[:/⁄×∶]\s*\d+(?:[.,]\d+)?)?(?!\w)",
        r"\b[\w]*[_λδμη][\w-]*\b",
    ]
    if language == "English":
        patterns.append(r"\b(?:[A-Z]{2,}|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+|[A-Za-z]+\d+[A-Za-z0-9_-]*)\b")
    else:
        patterns.append(r"\b[A-Za-z][A-Za-z0-9_-]*\b")
    result = []
    for pattern in patterns:
        for match in re.finditer(pattern, title):
            anchor = match.group(0)
            if any(char.isdigit() for char in anchor):
                anchor = anchor.replace(":", "∶").replace("/", "⁄")
            result.append(anchor)
    return result


def _anchors_preserved(draft, candidate, language=None, allowed_removed=()):
    required = Counter(anchors(draft, language))
    for anchor in allowed_removed:
        required.pop(anchor, None)
    actual = Counter(anchors(candidate, language))
    return all(actual[anchor] >= count for anchor, count in required.items())


def _letter_scripts(value):
    """Return Unicode script families without assuming a topic or vocabulary."""
    scripts = set()
    for character in value:
        if not character.isalpha():
            continue
        name = unicodedata.name(character, "")
        for script in ("LATIN", "CYRILLIC", "CJK", "HIRAGANA", "KATAKANA", "ARABIC", "HEBREW"):
            if script in name:
                scripts.add(script)
                break
    return scripts


def validated_title(raw, source, draft, *, allowed_removed_anchors=()):
    parsed = json.loads(raw)
    if not isinstance(parsed, dict) or set(parsed) != {"title"} or not isinstance(parsed["title"], str):
        raise ValueError("Title response shape")
    # A title is one phrase. A semicolon preserves the model's separation
    # without allowing it to turn the filename into prose sentences.
    proposed = re.sub(r"(?<!\d)\.\s+", "; ", parsed["title"].strip())
    candidate = parse_metadata(
        json.dumps({"title": proposed, "tags": []}, ensure_ascii=False),
        source,
        0,
        [],
    )["title"]
    language = source_language(metadata_source(source))
    required_script = "LATIN" if language == "English" else "CYRILLIC"
    if required_script not in _letter_scripts(candidate):
        raise ValueError("Title is not in the required language")
    trusted_scripts = _letter_scripts(metadata_source(source) + " " + draft)
    if not _letter_scripts(candidate) <= trusted_scripts:
        raise ValueError("Title introduced an unsupported writing system")
    if not _anchors_preserved(
        draft,
        candidate,
        language,
        allowed_removed_anchors,
    ):
        raise ValueError("Protected title anchor changed")
    draft_quotes = set(re.findall(r"«[^»]+»|“[^”]+”|\"[^\"\n]+\"|'[^'\n]+'", draft))
    candidate_quotes = set(re.findall(r"«[^»]+»|“[^”]+”|\"[^\"\n]+\"|'[^'\n]+'", candidate))
    unsafe_quotes = {
        quote
        for quote in candidate_quotes - draft_quotes
        if quote[1:-1] not in draft
    }
    if unsafe_quotes:
        raise ValueError("Title copied new quoted material")
    source_anchors = set(anchors(metadata_source(source), language)) | set(anchors(draft, language))
    if any(
        anchor not in source_anchors
        and not (anchor[:1] in {'«', '“', '"', "'"} and anchor[1:-1] in draft)
        for anchor in anchors(candidate, language)
    ):
        raise ValueError("Title introduced an unsupported anchor")
    return candidate
