"""Bounded, topic-independent identity context and source coverage units."""

import re
import unicodedata


_WORD = re.compile(r"(?u)[^\W\d_]+")
_TOKEN = re.compile(r"(?u)[\w.-]+")
_CODE = re.compile(r"```[\s\S]*?```|`[^`]*`")


def source_language(text):
    """Return the trusted output language supported by the local prompt examples."""
    prose = _CODE.sub(" ", text)
    cyrillic = sum("CYRILLIC" in unicodedata.name(char, "") for char in prose)
    latin = sum("LATIN" in unicodedata.name(char, "") for char in prose)
    return "Russian" if cyrillic >= latin else "English"


def coverage_units(source, limit=8):
    """Keep the opening and final source blocks within a bounded review context."""
    if limit < 1:
        return {}
    literals = {}

    def protect(match):
        marker = f"<CODE_{len(literals)}>"
        literals[marker] = match.group(0)
        return marker

    protected = _CODE.sub(protect, source)
    parts = re.split(r"(?<=[.!?])\s+|\n{2,}|(?<=;)\s+", protected)
    result = []
    for part in parts:
        value = part.strip()
        if not value:
            continue
        for marker, literal in literals.items():
            value = value.replace(marker, literal)
        result.append(value)
    if len(result) > limit:
        result = result[: limit - 1] + [result[-1]]
    return {f"U{index}": value for index, value in enumerate(result, start=1)}


def _normalized(value):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", str(value))).casefold()


def _word_stems(value):
    return {word.casefold()[:4] for word in _WORD.findall(value) if len(word) >= 4}


def _capitalized_stems(value):
    """Return non-sentence-initial capitalized words as explicit name evidence."""
    result = set()
    for match in _WORD.finditer(value):
        word = match.group(0)
        before = value[: match.start()]
        sentence_initial = not before.strip() or bool(
            re.search(r"[.!?]\s*$", before)
        )
        if len(word) >= 4 and word[0].isupper() and not sentence_initial:
            result.add(word.casefold()[:4])
    return result


def _proper_stems(candidate):
    words = _WORD.findall(candidate["title"])
    type_words = [
        word.casefold()
        for tag in candidate.get("tags") or []
        for word in _WORD.findall(str(tag))
    ]
    type_stems = {word[:4] for word in type_words if len(word) >= 4}
    has_explicit_type = any(
        any(
            word.casefold() == type_word
            or (
                min(len(word), len(type_word)) >= 5
                and (
                    word.casefold().startswith(type_word)
                    or type_word.startswith(word.casefold())
                )
                and abs(len(word) - len(type_word)) <= 3
            )
            for type_word in type_words
        )
        for word in words
    )
    return {
        word.casefold()[:4]
        for index, word in enumerate(words)
        if len(word) >= 4 and word[0].isupper()
        and word.casefold()[:4] not in type_stems
        # Sentence-initial capitalization alone is not identity evidence.
        # It becomes a name anchor only when the title also carries an explicit
        # object type (for example, "Aster sensor").
        and (index > 0 or has_explicit_type)
    }


def _identifier_tokens(value):
    result = set()
    for token in _TOKEN.findall(value):
        token = token.strip(".-_")
        if any(char.isalpha() for char in token) and any(
            char.isdigit() for char in token
        ):
            result.add(token.casefold())
    return result


def _primary_identifier_tokens(candidate):
    """Return identifiers that describe the candidate, not every referenced object."""
    title_tokens = _identifier_tokens(candidate["title"])
    if title_tokens:
        return title_tokens
    text = str(candidate.get("text") or "")
    for line in text.splitlines():
        tokens = _identifier_tokens(line)
        if tokens:
            # The first identifier in descriptive prose normally belongs to the
            # subject; later identifiers can identify referenced entities.
            for token in _TOKEN.findall(line):
                normalized = token.strip(".-_").casefold()
                if normalized in tokens:
                    return {normalized}
    return set()


def _identity_excerpt(candidate):
    lines = [
        re.sub(r"^#\s*", "", line).strip()
        for line in str(candidate.get("text") or "").splitlines()
        if line.strip()
    ]
    if lines and _normalized(lines[0]) == _normalized(candidate["title"]):
        lines = lines[1:]
    return (lines[0] if lines else "")[:240]


def _exact_identity(source, candidate):
    normalized_source = _normalized(source)
    title = candidate["title"]
    normalized_title = _normalized(title)
    if normalized_title and normalized_title in normalized_source:
        return True
    words = _WORD.findall(title)
    if len(words) > 2 and _normalized(" ".join(words[1:])) in normalized_source:
        return True
    return bool(
        _identifier_tokens(source)
        & _primary_identifier_tokens(candidate)
    )


def _named_identity(source, candidate):
    source_stems = _word_stems(source)
    title_stems = _word_stems(candidate["title"])
    named_stems = _proper_stems(candidate)
    if not named_stems or not named_stems <= source_stems or len(title_stems) < 2:
        return False
    # One ordinary capitalized word in a vault title is weak evidence: it can
    # also be a common noun capitalized only because it ends that title.  For a
    # single-word name, require matching capitalization in source prose.
    return len(named_stems) > 1 or named_stems <= _capitalized_stems(source)


def matched_identity_candidates(source, identity_candidates):
    """Return deduplicated candidates with a concrete source identity match."""
    candidates = {}
    for candidate in identity_candidates or []:
        title = candidate.get("title") if isinstance(candidate, dict) else None
        if isinstance(title, str) and title:
            candidates.setdefault(title, candidate)
    matches = []
    for candidate in candidates.values():
        if _exact_identity(source, candidate):
            matches.append((2, candidate))
        elif _named_identity(source, candidate):
            matches.append((1, candidate))
    return [
        candidate
        for _score, candidate in sorted(
            matches, key=lambda item: (-item[0], item[1]["title"].casefold())
        )
    ]


def _context_row(candidate, max_tags, *, with_excerpt):
    tags = []
    for raw in candidate.get("tags") or []:
        value = str(raw).strip()
        if value and value not in tags:
            tags.append(value)
    row = {"title": candidate["title"], "tags": tags[:max_tags]}
    if with_excerpt and (excerpt := _identity_excerpt(candidate)):
        row["identity_excerpt"] = excerpt
    return row


def identity_context(source, accepted, identity_candidates, max_tags, limit=6):
    """Resolve identity only; this context never creates a graph relationship."""
    candidates = {}
    for candidate in identity_candidates or []:
        title = candidate.get("title") if isinstance(candidate, dict) else None
        if isinstance(title, str) and title:
            candidates.setdefault(title, candidate)
    for item in accepted:
        title = item.get("title") if isinstance(item, dict) else None
        if isinstance(title, str) and title:
            candidates.setdefault(title, item)

    result = []
    identity_titles = {
        candidate.get("title")
        for candidate in identity_candidates or []
        if isinstance(candidate, dict)
    }
    # A graph relation is not proof that all metadata from the related note
    # describes the new note.  Expose vocabulary only for a concrete identity
    # named in the source; relation selection remains an independent channel.
    for candidate in matched_identity_candidates(source, candidates.values()):
        result.append(
            _context_row(
                candidate,
                max_tags,
                with_excerpt=candidate["title"] in identity_titles,
            )
        )
        if len(result) >= limit:
            break
    return result[:limit]
