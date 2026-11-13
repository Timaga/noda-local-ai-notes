"""Strict full-source transport and failure attribution for the selected RU stages."""

from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
import math
import unicodedata

from backend.inference_runner import ContextBudgetError
from backend.note_processing_failures import NoteModelResponseError, NoteSystemError


SAMPLING = {
    "max_new_tokens": 1024,
    "temperature": 0.0,
    "top_p": 1.0,
    "do_sample": False,
    "seed": 1337,
    "raise_on_truncation": True,
    "require_context_budget": True,
}
MAX_TEXT = 1024 * 1024


def canonical(value):
    return json.dumps(
        value, ensure_ascii=False, allow_nan=False, separators=(",", ":")
    ).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def system_error(message, code="ru_pipeline_failed"):
    return NoteSystemError(message, failure_code=code)


def text(value, *, allow_empty=False, maximum=MAX_TEXT, identifier=False):
    if type(value) is not str or len(value) > maximum or "\x00" in value:
        raise system_error(
            "Неверный текст входных данных русского конвейера.",
            "invalid_ru_pipeline_input",
        )
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise system_error(
            "Входные данные не являются корректным UTF-8.", "invalid_ru_pipeline_input"
        ) from exc
    if not allow_empty and not value.strip():
        raise system_error(
            "Нужен непустой исходный текст.", "invalid_ru_pipeline_input"
        )
    if identifier and any(
        unicodedata.category(char) in {"Cc", "Cf", "Cs"} for char in value
    ):
        raise system_error(
            "Неверный идентификатор каталога.", "invalid_ru_pipeline_input"
        )
    return value


def records_input(records, *, catalog=False, allow_empty_source=False):
    if type(records) is not list:
        raise system_error(
            "Нужен список записей каталога.", "invalid_ru_pipeline_input"
        )
    keys = {"id", "label", "description"} if catalog else {"id", "source"}
    rows, ids, labels = [], set(), set()
    for row in records:
        if type(row) is not dict or set(row) != keys:
            raise system_error(
                "Неверная схема записи каталога.", "invalid_ru_pipeline_input"
            )
        key = text(row["id"], maximum=4096, identifier=True)
        if key in ids:
            raise system_error(
                "Повтор идентификатора каталога.", "invalid_ru_pipeline_input"
            )
        ids.add(key)
        if catalog:
            label = text(row["label"], maximum=160, identifier=True)
            description = text(row["description"], allow_empty=True, maximum=1000)
            if label in labels:
                raise system_error(
                    "Повтор названия тега в каталоге.", "invalid_ru_pipeline_input"
                )
            labels.add(label)
            rows.append({"id": key, "label": label, "description": description})
        else:
            rows.append(
                {
                    "id": key,
                    "source": text(row["source"], allow_empty=allow_empty_source),
                }
            )
    return rows


@contextmanager
def unchanged_input(value):
    try:
        before = canonical(value)
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise system_error(
            "Неверная структура входных данных русского конвейера.",
            "invalid_ru_pipeline_input",
        ) from exc
    try:
        yield
    finally:
        try:
            same = canonical(value) == before
        except (TypeError, ValueError, UnicodeError, RecursionError):
            same = False
        if not same:
            raise system_error(
                "Входные данные изменились во время обработки.",
                "ru_pipeline_input_changed",
            )


@contextmanager
def generator_session(services, model_key):
    try:
        with services.generator(model_key) as generator:
            yield generator
    except (ContextBudgetError, NoteModelResponseError, NoteSystemError):
        raise
    except Exception as exc:
        raise system_error(
            "Локальный генератор недоступен или завершился с ошибкой.",
            "ru_generator_failed",
        ) from exc


def unique_object(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def reject_number(value):
    raise ValueError("Nonfinite JSON number")


def finite_float(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Nonfinite JSON number")
    return result


def parse_object(raw, field):
    if type(raw) is not str or not 1 <= len(raw) <= 32768:
        raise ValueError("Bounded complete JSON required")
    raw.encode("utf-8", errors="strict")
    try:
        value = json.loads(
            raw,
            object_pairs_hook=unique_object,
            parse_constant=reject_number,
            parse_float=finite_float,
        )
    except RecursionError:
        raise ValueError("Bounded JSON nesting required") from None
    if type(value) is not dict or set(value) != {field}:
        raise ValueError("Only the requested JSON field is allowed")
    return value[field]


def parse_ids(raw, field, rows):
    value = parse_object(raw, field)
    allowed = {row["id"] for row in rows}
    if type(value) is not list or len(value) > len(rows):
        raise ValueError("Bounded ID array required")
    if any(type(key) is not str or key not in allowed for key in value):
        raise ValueError("Unknown candidate ID")
    if len(set(value)) != len(value):
        raise ValueError("Duplicate IDs are rejected")
    return value


def response_format(field, rows):
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "ru_" + field,
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "required": [field],
                "properties": {
                    field: {
                        "type": "array",
                        "minItems": 0,
                        "maxItems": len(rows),
                        "items": {
                            "type": "string",
                            "enum": [row["id"] for row in rows],
                        },
                    }
                },
            },
        },
    }


def invoke(generator, messages, parameters):
    parameters = deepcopy(parameters)
    with unchanged_input({"messages": messages, "parameters": parameters}):
        try:
            raw = generator.invoke(messages, **parameters)
        except (ContextBudgetError, NoteModelResponseError, NoteSystemError):
            raise
        except Exception as exc:
            raise system_error(
                "Сбой локального вызова модели; исходник не изменён.",
                "ru_generator_failed",
            ) from exc
    if type(raw) is not str or not raw.strip():
        raise system_error(
            "Локальный генератор не вернул завершённый текст.",
            "provider_protocol_failed",
        )
    return raw


def complete_json(generator, build_messages, parser, parameters, diagnostics, *, stage):
    for attempt in range(2):
        entry = {
            "stage": stage,
            "attempt": attempt + 1,
            "status": "ERROR",
            "completion_received": False,
        }
        diagnostics.append(entry)
        messages = build_messages(bool(attempt))
        entry["request_sha256"] = digest(canonical(messages))
        try:
            raw = invoke(generator, messages, parameters)
        except ContextBudgetError:
            entry["status"] = "CONTEXT_BUDGET"
            raise
        except (NoteModelResponseError, NoteSystemError):
            entry["status"] = "SYSTEM_ERROR"
            raise
        entry["completion_received"] = True
        entry["response_sha256"] = digest(raw.encode("utf-8", errors="surrogatepass"))
        try:
            value = parser(raw)
        except (ValueError, TypeError, UnicodeError) as exc:
            entry.update(status="FORMAT_ERROR", error_type=type(exc).__name__)
            continue
        entry["status"] = "COMPLETE"
        return value
    raise NoteModelResponseError("Локальная модель дважды нарушила формат ответа.")


def score_pairs(services, engine, pairs, *, purpose=None):
    if not pairs:
        return []
    with unchanged_input(pairs):
        try:
            scorer = (
                getattr(services, "score_links", None) if purpose == "links" else None
            )
            scorer = scorer if callable(scorer) else services.score
            scores = scorer(engine=engine, pairs=pairs)
        except NoteSystemError:
            raise
        except Exception as exc:
            raise system_error(
                "Оценщик не смог проверить полные исходные тексты.",
                "ru_reranker_failed",
            ) from exc
    if type(scores) is not list or len(scores) != len(pairs):
        raise system_error("Неполный ответ оценщика.", "ru_reranker_protocol_failed")
    try:
        valid = all(
            type(score) in (int, float) and math.isfinite(score) for score in scores
        )
    except (ValueError, TypeError, OverflowError):
        valid = False
    if not valid:
        raise system_error(
            "Оценщик вернул некорректный балл.", "ru_reranker_protocol_failed"
        )
    return scores


def attempt_summary(records):
    return {
        "attempts": sum(row["completion_received"] for row in records),
        "request_attempts": len(records),
        "retry_count": sum(
            row["attempt"] == 2 and row["completion_received"] for row in records
        ),
        "preflight_rejections": sum(
            row["status"] == "CONTEXT_BUDGET" for row in records
        ),
        "attempt_records": records,
    }


def choose_rows(
    generator, source, rows, field, system, retry, diagnostics, *, catalog=False
):
    def build_messages(is_retry):
        payload = {"source_note": source, "catalog" if catalog else "candidates": rows}
        return [
            {"role": "system", "content": system + (retry if is_retry else "")},
            {
                "role": "user",
                "content": json.dumps(payload, ensure_ascii=False, allow_nan=False),
            },
        ]

    parameters = {**SAMPLING, "response_format": response_format(field, rows)}
    try:
        selected = complete_json(
            generator,
            build_messages,
            lambda raw: parse_ids(raw, field, rows),
            parameters,
            diagnostics,
            stage="tags" if catalog else "links",
        )
        return selected, 1
    except ContextBudgetError as exc:
        if len(rows) == 1:
            raise system_error(
                "Полный исходник и одна запись не помещаются в контекст. Текст не обрезан.",
                "context_budget_exceeded",
            ) from exc
        middle = len(rows) // 2
        left, left_count = choose_rows(
            generator,
            source,
            rows[:middle],
            field,
            system,
            retry,
            diagnostics,
            catalog=catalog,
        )
        right, right_count = choose_rows(
            generator,
            source,
            rows[middle:],
            field,
            system,
            retry,
            diagnostics,
            catalog=catalog,
        )
        return left + right, left_count + right_count
