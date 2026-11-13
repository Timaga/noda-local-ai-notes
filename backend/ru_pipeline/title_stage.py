"""Four fixed title candidates followed by full-source mMARCO ranking."""

import json
import unicodedata

from backend.inference_runner import ContextBudgetError
from backend.generated_text_language import assert_allowed_letters
from backend.note_identity_context import source_language
from backend.note_processing_failures import NoteModelResponseError

from .contracts import (
    SAMPLING,
    attempt_summary,
    complete_json,
    generator_session,
    parse_object,
    score_pairs,
    system_error,
    text,
    unchanged_input,
)
from .pair_settings import DEFAULT_PAIRS
from .prompts_title import (
    ENGLISH_RETRY,
    ENGLISH_STYLES,
    ENGLISH_SYSTEM,
    RETRY,
    STYLES,
    SYSTEM,
)


TITLE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "faithful_title",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["title"],
            "properties": {
                "title": {"type": "string", "minLength": 1, "maxLength": 90}
            },
        },
    },
}


def parse_title(raw, language="Russian"):
    if type(language) is not str or language not in {"Russian", "English"}:
        raise ValueError("Unsupported title language")
    title = parse_object(raw, "title")
    if type(title) is not str or not 1 <= len(title) <= 90:
        raise ValueError("Title shape")
    title.encode("utf-8", errors="strict")
    if any(unicodedata.category(char) in {"Cc", "Cf", "Cs"} for char in title):
        raise ValueError("Title shape")
    assert_allowed_letters(title)
    title = " ".join(title.split())
    words = sum(any(char.isalnum() for char in word) for word in title.split())
    target_script_present = (
        any("CYRILLIC" in unicodedata.name(char, "") for char in title)
        if language == "Russian"
        else any("A" <= char <= "Z" or "a" <= char <= "z" for char in title)
    )
    if not 1 <= words <= 12 or not target_script_present:
        raise ValueError("Title shape")
    return title


def generate_title(services, source, *, pair=DEFAULT_PAIRS["title"]):
    text(source)
    language = source_language(source)
    system, styles, retry_instruction = (
        (ENGLISH_SYSTEM, ENGLISH_STYLES, ENGLISH_RETRY)
        if language == "English"
        else (SYSTEM, STYLES, RETRY)
    )
    attempts, candidates = [], []
    parameters = {**SAMPLING, "max_new_tokens": 256, "response_format": TITLE_FORMAT}
    with unchanged_input(source):
        try:
            with generator_session(services, pair.generator) as generator:
                for style, instruction in styles:

                    def build_messages(retry, instruction=instruction):
                        return [
                            {
                                "role": "system",
                                "content": system
                                + " "
                                + instruction
                                + (retry_instruction if retry else ""),
                            },
                            {
                                "role": "user",
                                "content": json.dumps(
                                    {"source_note": source}, ensure_ascii=False
                                ),
                            },
                        ]

                    try:
                        title = complete_json(
                            generator,
                            build_messages,
                            lambda raw: parse_title(raw, language=language),
                            parameters,
                            attempts,
                            stage="title:" + style,
                        )
                    except NoteModelResponseError:
                        candidates.append(
                            {"style": style, "status": "ERROR", "title": None}
                        )
                        continue
                    candidates.append(
                        {"style": style, "status": "COMPLETE", "title": title}
                    )
        except ContextBudgetError as exc:
            raise system_error(
                "Полный исходник не помещается в контекст заголовка. Текст не обрезан.",
                "context_budget_exceeded",
            ) from exc
        valid = [row for row in candidates if row["status"] == "COMPLETE"]
        if not valid:
            raise NoteModelResponseError(
                "Ни один из четырёх заголовков не прошёл проверку формата."
            )
        scores = score_pairs(
            services,
            pair.scorer_engine("title"),
            [{"source": source, "target": row["title"]} for row in valid],
        )
        selected = max(range(len(valid)), key=lambda index: scores[index])
        return {
            "title": valid[selected]["title"],
            "language": language,
            "alphabet_policy": "ru-en-v1",
            "language_rejection_count": sum(
                entry.get("error_type") == "GeneratedAlphabetError"
                for entry in attempts
            ),
            "candidate_count": len(valid),
            "score_count": len(scores),
            "candidate_records": candidates,
            "selected_score": scores[selected],
            **attempt_summary(attempts),
        }
