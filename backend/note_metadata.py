"""Model metadata around an immutable author-owned note body."""

import json
import re
import unicodedata

try:
    from backend.generated_text_language import (
        GeneratedAlphabetError,
        LANGUAGE_REPAIR_HINT,
        allowed_generated_text,
        assert_allowed_letters,
    )
    from backend.note_metadata_prompt import metadata_prompt
    from backend.note_identity_context import matched_identity_candidates, source_language
except ImportError:
    from generated_text_language import (
        GeneratedAlphabetError,
        LANGUAGE_REPAIR_HINT,
        allowed_generated_text,
        assert_allowed_letters,
    )
    from note_metadata_prompt import metadata_prompt
    from note_identity_context import matched_identity_candidates, source_language

try:
    from backend.note_generation_contract import (
        NoteGenerationError,
        extract_note_tags,
        normalize_tag,
    )
except ImportError:
    from note_generation_contract import (
        NoteGenerationError,
        extract_note_tags,
        normalize_tag,
    )


def metadata_format(max_tags):
    return {
        "type": "json_object",
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["title", "tags"],
            "properties": {
                "title": {"type": "string", "minLength": 1},
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "maxItems": max_tags,
                },
            },
        },
    }


class MetadataValidationError(NoteGenerationError):
    """Public failure with a payload-free diagnostic for one automatic repair."""

    def __init__(self, hint):
        super().__init__(
            "Модель вернула некорректные заголовок или теги. Соблюдай формат и пределы."
        )
        self.repair_hint = hint


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate metadata key")
        result[key] = value
    return result


def _scripts(value):
    result = set()
    for char in value:
        name = unicodedata.name(char, "")
        if "CYRILLIC" in name:
            result.add("Cyrillic")
        elif "LATIN" in name:
            result.add("Latin")
        elif any(
            script in name for script in ("CJK", "HIRAGANA", "KATAKANA", "HANGUL")
        ):
            result.add("Other")
    return result


def _literal_only_tokens(source):
    fence_labels = {
        label.casefold()
        for label in re.findall(
            r"(?m)^```([A-Za-z][A-Za-z0-9_+-]*)[ \t]*$", source
        )
    }
    spans = re.findall(
        r"```[\s\S]*?```|`[^`]*`|«[^»]*»|“[^”]*”|\"[^\"\n]*\"",
        source,
    )
    outside = source
    for span in spans:
        outside = outside.replace(span, " ")
    outside_tokens = {
        token.casefold() for token in re.findall(r"(?u)[\w-]{3,}", outside)
    }
    literal_tokens = {
        token.casefold()
        for span in spans
        for token in re.findall(r"(?u)[\w-]{3,}", span)
    }
    return literal_tokens - outside_tokens - fence_labels


def _code_identifiers(source):
    """Return code-owned keys/variables that cannot become semantic tags."""
    identifiers = set()
    for block in re.findall(r"```(?:[^\n]*)\n([\s\S]*?)```", source):
        identifiers.update(
            value.casefold()
            for value in re.findall(
                r'''["']([A-Za-z_][A-Za-z0-9_-]*)["']\s*:''', block
            )
        )
        identifiers.update(
            value.casefold()
            for value in re.findall(
                r"(?m)^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=", block
            )
        )
    return identifiers


def _structural_tags(source):
    """Describe explicit rendered media without interpreting literal code blocks."""
    language = source_language(source)
    result = []
    if re.search(r"!\[[^\]]*\]\([^\n)]+\)", source):
        result.append("изображение" if language == "Russian" else "image")
    data_formats = {"csv", "json", "sql", "toml", "xml", "yaml", "yml"}
    for label in re.findall(r"(?m)^```([A-Za-z][A-Za-z0-9_+-]*)[ \t]*$", source):
        tag = normalize_tag(label)
        if tag in data_formats and tag not in result:
            result.append(tag)
    prose = re.sub(
        r"```[\s\S]*?```|`[^`]*`|«[^»]*»|“[^”]*”|\"[^\"\n]*\"",
        " ",
        source,
    )
    prose = re.sub(r"(!\[[^\]]*\])\([^\n)]+\)", r"\1", prose)
    if "?" in prose:
        result.append("вопрос" if language == "Russian" else "question")
    return result


def _tag_stems(tag):
    result = set()
    for token in re.split(r"[_/-]+", tag):
        result.add(token[:4] if len(token) >= 4 else token)
    return result


def _filter_generated_tags(tags, source):
    # Literal-only tags are decided later by the evidence-aware semantic audit:
    # a quoted proper name may contain its real object type, while a quoted
    # instruction remains untrusted. Code-owned keys stay structurally blocked.
    blocked = _code_identifiers(source)
    fence_labels = {
        label.casefold()
        for label in re.findall(r"(?m)^```([A-Za-z][A-Za-z0-9_+-]*)[ \t]*$", source)
    }
    candidates = []
    for tag in tags:
        if tag in candidates or tag in blocked:
            continue
        scripts = _scripts(tag)
        # Generated search tags are compact categories, never sentence-like
        # claims or instructions. Authored metadata is added separately below.
        if (
            len(scripts) > 1
            or (
                tag not in fence_labels
                and not _language_compatible(source, tag)
                # Single-letter scientific/category labels such as x, R or μ
                # carry too little text to infer a document language.  The
                # normal tag audit still validates whether they are supported.
                and not (len(tag) == 1 and tag.isalpha())
            )
            or len(_words(tag)) > 3
        ):
            continue
        candidates.append(tag)
    stem_sets = [_tag_stems(tag) for tag in candidates]
    result = []
    for index, tag in enumerate(candidates):
        if any(
            index != other and stem_sets[index] < stem_sets[other]
            for other in range(len(candidates))
        ):
            continue
        result.append(tag)
    return result


def _words(value):
    return [word.casefold() for word in re.findall(r"(?u)[^\W\d_]+", value)]


def _word_form_matches(left, right):
    if left == right:
        return True
    if min(len(left), len(right)) < 4:
        return False
    if len(left) == len(right) and left[:-1] == right[:-1]:
        return True
    shorter, longer = sorted((left, right), key=len)
    suffix = longer[len(shorter) :]
    return (
        len(shorter) >= 4
        and longer.startswith(shorter)
        and len(longer) - len(shorter) <= (1 if len(shorter) == 4 else 3)
        and (len(shorter) > 4 or suffix in {"а", "я", "у", "ю", "е", "ы", "и", "о", "s"})
    )


def _tag_supported_by_text(tag, text):
    text_words = _words(text)
    tag_words = _words(tag)
    return bool(tag_words) and all(
        any(_word_form_matches(tag_word, text_word) for text_word in text_words)
        for tag_word in tag_words
    )


def _language_compatible(source, value):
    scripts = _scripts(value)
    if not scripts:
        return True
    expected = "Cyrillic" if source_language(source) == "Russian" else "Latin"
    return scripts == {expected}


def _title_language_matches(source, title):
    scripts = _scripts(title)
    if not scripts:
        return True
    # A source made only of digits or symbols does not establish a language.
    if not _scripts(source):
        return True
    expected = "Cyrillic" if source_language(source) == "Russian" else "Latin"
    if expected not in scripts:
        return False
    source_tokens = {
        token.casefold() for token in re.findall(r"(?u)[^\W\d_]+", source)
    }
    for token in re.findall(r"(?u)[^\W\d_]+", title):
        token_scripts = _scripts(token)
        if (
            token_scripts - {expected}
            and token.casefold() not in source_tokens
        ):
            return False
    return True


def _numeric_forms_preserved(source, title):
    """Reject a rewritten separator only when the title kept both numeric sides."""
    pattern = re.compile(
        r"(?<!\w)(\d+(?:[.,]\d+)?)\s*([/:\u00d7])\s*(\d+(?:[.,]\d+)?)(?!\w)"
    )
    compact_title = re.sub(r"\s+", "", title)
    title_numbers = re.findall(r"\d+(?:[.,]\d+)?", title)
    for left, separator, right in pattern.findall(source):
        if left in title_numbers and right in title_numbers:
            if f"{left}{separator}{right}" not in compact_title:
                return False
    return True


def _title_numbers_grounded(source, title):
    """Require every numeric title token to occur in the author's source."""
    normalize = lambda value: value.replace("−", "-").replace("∶", ":").replace("⁄", "/")
    # A sentence-ending full stop is punctuation, not part of an integer.
    # Word boundaries still reject digits embedded in identifiers, while the
    # optional decimal group keeps values such as 3.2 as one exact token.
    pattern = re.compile(r"(?<!\w)[+-]?\d+(?:[.,]\d+)?(?!\w)")
    source_numbers = set(pattern.findall(normalize(source)))
    return all(number in source_numbers for number in pattern.findall(normalize(title)))


def _filename_title_preserved(title):
    """Require a title that survives the cross-platform filename projection."""
    if len(title) > 120 or re.search(r'[<>:"/\\|?*\x00-\x1f\x7f\[\]#]', title):
        return False
    if re.sub(r"\s+", " ", title).strip(" .") != title:
        return False
    return not re.match(
        r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)",
        title,
        re.IGNORECASE,
    )


def _project_numeric_filename_separators(title):
    """Map numeric separators to filename-safe semantic Unicode equivalents."""
    title = re.sub(r"(?<=\d):(?=\d)", "∶", title)
    title = re.sub(r"\s*:\s*", " — ", title)
    unit_ratio = re.compile(
        r"(?P<left>\d(?:[\d.,]*)(?:\s*[^\W\d_]{1,8})?\s*)/"
        r"(?=\s*\d)",
        re.UNICODE,
    )
    title = unit_ratio.sub(lambda match: match.group("left") + "⁄", title)
    # A measurement unit such as 7.2 m/s contains a semantic unit separator,
    # not a filesystem path. Project it only when a number immediately owns
    # the short unit expression; arbitrary paths such as assets/plan remain
    # invalid and are rejected below.
    measured_unit_ratio = re.compile(
        r"(?P<number>\d(?:[\d.,]*))(?P<space>\s+)"
        r"(?P<left>[^\W\d_]{1,8})/(?P<right>[^\W\d_]{1,8})(?!\w)",
        re.UNICODE,
    )
    return measured_unit_ratio.sub(
        lambda match: (
            match.group("number")
            + match.group("space")
            + match.group("left")
            + "⁄"
            + match.group("right")
        ),
        title,
    )


def _canonical_title_tags(source, identity_candidates):
    """Yield established tags that literally name the candidate's object type."""
    for candidate in identity_candidates or []:
        if not isinstance(candidate, dict) or not isinstance(
            candidate.get("title"), str
        ):
            continue
        for raw in candidate.get("tags") or []:
            tag = normalize_tag(raw)
            if (
                tag
                and _language_compatible(source, tag)
                and _tag_supported_by_text(tag, candidate["title"])
            ):
                yield tag, candidate


def _candidate_name_words(candidate, canonical_tags):
    type_words = [word for tag in canonical_tags for word in _words(tag)]
    if not type_words:
        return set()
    title_words = re.findall(r"(?u)[^\W\d_]+", candidate["title"])
    name_words = [
        word
        for word in title_words
        if not any(
            _word_form_matches(word.casefold(), item) for item in type_words
        )
    ]
    # A matched vault identity may contain a multi-word proper name whose later
    # words are lowercase (for example, a work title).  The exact identity
    # match is the trust boundary; once a capitalized name anchor is present,
    # all non-type words in that trusted title belong to the name phrase.
    if not any(len(word) >= 4 and word[0].isupper() for word in name_words):
        return set()
    return {word.casefold() for word in name_words if len(word) >= 4}


def _tags_duplicate_meaning(left, right):
    """Detect only broad/specific duplicates made from the same complete words."""
    left_words = _words(left)
    right_words = _words(right)
    if not left_words or not right_words:
        return False

    def contained(needles, haystack):
        return all(
            any(_word_form_matches(needle, item) for item in haystack)
            for needle in needles
        )

    return contained(left_words, right_words) or contained(right_words, left_words)


def enrich_metadata_tags(source, title, tags, identity_candidates, max_tags):
    """Add only structurally or vault-grounded facets after model validation."""
    result = list(dict.fromkeys(tags))
    if max_tags <= 0:
        return result
    authored = set(extract_note_tags(source))
    canonical = list(_canonical_title_tags(source, identity_candidates))
    matches = matched_identity_candidates(source, identity_candidates)
    evidence_text = "\n".join(
        "\n".join(
            (
                str(candidate.get("title") or ""),
                str(candidate.get("text") or ""),
                " ".join(str(tag) for tag in candidate.get("tags") or []),
            )
        )
        for candidate in matches
    )
    additions = _structural_tags(source)

    # Prefer a trusted identity type over a one-character-short generated
    # prefix (for example, a noun truncated into a different search word).
    # The rule is applied only to exact matched identities and never removes
    # explicit author tags.
    matched_titles = {candidate["title"] for candidate in matches}
    canonical_tags = {
        tag
        for tag, candidate in canonical
        if candidate["title"] in matched_titles
    }
    result = [
        tag
        for tag in result
        if tag in authored
        or not any(
            len(tag) >= 4
            and len(canonical_tag) == len(tag) + 1
            and canonical_tag.startswith(tag)
            for canonical_tag in canonical_tags
        )
    ]

    # If the model already used an established object type in the title, reuse
    # the exact vault tag instead of asking a small model to repeat that facet.
    for tag, _candidate in canonical:
        if (
            evidence_text
            and _tag_supported_by_text(tag, title)
            and _tag_supported_by_text(tag, evidence_text)
            and tag not in additions
        ):
            additions.append(tag)

    # A proper-name-only tag is not a topic. Replace it only when the source has
    # a concrete match and the matched vault title provides a canonical type.
    for candidate in matches:
        raw_types = [
            tag
            for raw in candidate.get("tags") or []
            if (tag := normalize_tag(raw))
            and _tag_supported_by_text(tag, candidate["title"])
        ]
        compatible_types = [
            tag for tag in raw_types if _language_compatible(source, tag)
        ]
        names = _candidate_name_words(candidate, raw_types)
        removable = {
            tag
            for tag in result
            if tag not in authored
            and _words(tag)
            and all(
                any(_word_form_matches(word, name) for name in names)
                for word in _words(tag)
            )
        }
        if removable:
            result = [tag for tag in result if tag not in removable]
            for tag in compatible_types:
                if tag not in additions:
                    additions.append(tag)

    for tag in additions:
        if (
            tag not in result
            and not any(_tags_duplicate_meaning(tag, current) for current in result)
            and len(result) < max_tags
        ):
            result.append(tag)
    return result


def parse_metadata(
    raw, source, max_tags, authored_links, *, discard_invalid_tags=False
):
    try:
        if not isinstance(raw, str) or not 1 <= len(raw) <= 40000:
            raise ValueError("Missing metadata")
        parsed = json.loads(raw, object_pairs_hook=_unique_object)
        # Older model adapters may still emit the old body/link fields. They
        # have no authority to rewrite the author's body or select graph edges.
        if not isinstance(parsed, dict) or not set(parsed).issubset(
            {"subject", "title", "tags", "corrected_text", "links"}
        ):
            raise MetadataValidationError(
                "Верни один JSON-объект с title и tags без дополнительных полей."
            )
        title, raw_tags = parsed.get("title"), parsed.get("tags")
        if not isinstance(title, str) or not title.strip() or len(title) > 120:
            raise MetadataValidationError(
                "title: непустая строка длиной до 120 символов."
            )
        try:
            assert_allowed_letters(title)
        except GeneratedAlphabetError as exc:
            raise MetadataValidationError(LANGUAGE_REPAIR_HINT) from exc
        if not _title_language_matches(source, title):
            language = source_language(source)
            raise MetadataValidationError(
                f"title: используй язык {language}, заданный приложением; "
                "имена можно сохранить в исходном написании."
            )
        if not _numeric_forms_preserved(source, title):
            raise MetadataValidationError(
                "title: если дробь, масштаб, отношение или размер включены в заголовок, "
                "сохрани исходный разделитель /, : или × без замены пробелом."
            )
        if not _title_numbers_grounded(source, title):
            raise MetadataValidationError(
                "title: каждое число должно буквально присутствовать в исходной заметке; "
                "не добавляй номера вариантов или файлов."
            )
        title = _project_numeric_filename_separators(title)
        if not _filename_title_preserved(title):
            raise MetadataValidationError(
                "title: верни готовое переносимое имя файла до 120 символов без "
                "<>:\"/\\|?*[]#, управляющих символов, завершающих пробелов или точек. "
                "Значение с / или : лучше не включать в title; не заменяй разделитель пробелом."
            )
        if not isinstance(raw_tags, list) or len(raw_tags) > max_tags:
            raise MetadataValidationError(f"tags: массив не более {max_tags} строк.")
        if "subject" in parsed and (
            not isinstance(parsed["subject"], str) or len(parsed["subject"]) > 3000
        ):
            raise MetadataValidationError("subject: строка длиной до 3000 символов.")
        tags = []
        for index, value in enumerate(raw_tags):
            if isinstance(value, str):
                try:
                    assert_allowed_letters(value)
                except GeneratedAlphabetError as exc:
                    raise MetadataValidationError(LANGUAGE_REPAIR_HINT) from exc
            tag = normalize_tag(value)
            if tag is None:
                if discard_invalid_tags:
                    continue
                raise MetadataValidationError(
                    f"tags[{index}]: тег должен содержать хотя бы одну букву, "
                    "быть не длиннее 80 символов и состоять из букв, цифр, "
                    "подчёркиваний, дефисов или / между непустыми частями. "
                    "Исправь или убери эту метку; не добавляй тему ради заполнения массива."
                )
            if tag not in tags:
                tags.append(tag)
        if discard_invalid_tags and raw_tags and not tags:
            raise MetadataValidationError(
                "tags: все предложенные метки не прошли проверку; верни хотя бы одну "
                "корректную тематическую метку или пустой массив, если метки не нужны."
            )
    except (ValueError, TypeError) as exc:
        raise MetadataValidationError(
            "Верни завершённый JSON-объект без обёрток и повторяющихся ключей."
        ) from exc
    tags = _filter_generated_tags(tags, source)
    # Explicit author metadata is preserved independently of the model quota.
    authored_tags = [
        tag for tag in extract_note_tags(source) if allowed_generated_text(tag)
    ]
    tags = list(dict.fromkeys(authored_tags + tags))
    return {
        "title": title.strip(),
        "body": source,
        "tags": tags,
        "links": list(
            dict.fromkeys(
                item["target"]
                for item in authored_links
                if allowed_generated_text(item["target"])
            )
        ),
        "source_links": authored_links,
    }
