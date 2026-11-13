"""Russian/English alphabet policy for generated note fields, never source text."""

import unicodedata

try:
    from backend.note_generation_contract import NoteGenerationError
except ImportError:
    from note_generation_contract import NoteGenerationError


LANGUAGE_REPAIR_HINT = (
    "Сгенерируй ответ заново по неизменному исходнику. Используй только буквы "
    "русского и английского алфавитов (А–Я, а–я, Ё, ё, A–Z, a–z); "
    "не используй китайские или другие буквы, не транслитерируй испорченный ответ."
)


class GeneratedAlphabetError(ValueError):
    """A generated value contains a forbidden alphabet; no payload is exposed."""


class GeneratedLanguageError(NoteGenerationError):
    """A draft must be generated again before any publication is attempted."""

    failure_kind = "model_response"
    failure_code = "generated_language_not_allowed"
    repair_hint = LANGUAGE_REPAIR_HINT

    def __init__(self):
        super().__init__(
            "В сгенерированном результате есть недопустимые буквы. "
            "Разрешены русский и английский алфавиты; результат не опубликован."
        )


def _allowed_letter(char):
    return (
        "A" <= char <= "Z"
        or "a" <= char <= "z"
        or "А" <= char <= "Я"
        or "а" <= char <= "я"
        or char in "Ёё"
    )


def _check_compatibility_symbol(char, category):
    """Reject script-bearing symbols/numerals, retaining neutral math glyphs."""
    name = unicodedata.name(char, "")
    if name.startswith(("CJK ", "IDEOGRAPHIC ", "KANGXI ")):
        raise GeneratedAlphabetError("Generated text contains a script-bearing symbol")
    folded = unicodedata.normalize("NFKC", char)
    if any(part.isalpha() and not _allowed_letter(part) for part in folded):
        raise GeneratedAlphabetError("Generated symbol expands to a foreign alphabet")
    if category in {"Nl", "No"} and char not in "0123456789":
        neutral_fold = folded != char and all(
            part in "0123456789"
            or _allowed_letter(part)
            or unicodedata.category(part).startswith("P")
            or unicodedata.category(part).startswith("S")
            or part.isspace()
            for part in folded
        )
        if not neutral_fold and not name.startswith("ROMAN NUMERAL "):
            raise GeneratedAlphabetError("Generated text contains a foreign numeral")


def assert_allowed_letters(value):
    """Validate NFC characters while returning the identical original string."""
    if type(value) is not str:
        raise GeneratedAlphabetError("Generated text must be a string")
    normalized = unicodedata.normalize("NFC", value)
    for index, char in enumerate(normalized):
        category = unicodedata.category(char)
        if char.isalpha() and not _allowed_letter(char):
            raise GeneratedAlphabetError("Generated alphabet is not Russian/English")
        _check_compatibility_symbol(char, category)
        russian_stress = (
            char == "\u0301"
            and index > 0
            and normalized[index - 1] in "АЕЁИОУЫЭЮЯаеёиоуыэюя"
        )
        if (category.startswith("M") and not russian_stress) or (
            char.isdecimal() and char not in "0123456789"
        ):
            raise GeneratedAlphabetError("Generated text contains unsupported marks")
        if category in {"Cc", "Cf", "Cs"} and char not in "\t\n\r":
            raise GeneratedAlphabetError("Generated text contains hidden controls")
    return value


def allowed_generated_text(value):
    """Whether a generated text value obeys the alphabet policy."""
    try:
        assert_allowed_letters(value)
    except GeneratedAlphabetError:
        return False
    return True


def validate_note_output(draft):
    """Reject generated fields before commit; an unchanged author body is exempt."""
    try:
        for key in ("title", "generated_title", "display_title"):
            if key in draft:
                assert_allowed_letters(draft[key])
        for key in ("tags", "links", "related"):
            if key not in draft:
                continue
            if type(draft[key]) not in (list, tuple):
                raise GeneratedAlphabetError("Generated metadata must be a sequence")
            for value in draft[key]:
                assert_allowed_letters(value)
        generation = draft.get("generation") or {}
        if generation.get("editing_applied") is True:
            assert_allowed_letters(draft["content"])
    except GeneratedAlphabetError as exc:
        raise GeneratedLanguageError() from exc
