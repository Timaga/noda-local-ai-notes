"""Generate metadata with one repair; preserve the author-owned source text."""

import json

try:
    from backend.note_generation_contract import NoteGenerationError, TemporaryModelError
    from backend.note_metadata import metadata_prompt, parse_metadata
    from backend.note_metadata_prompt import metadata_recovery_prompt
except ImportError:
    from note_generation_contract import NoteGenerationError, TemporaryModelError
    from note_metadata import metadata_prompt, parse_metadata
    from note_metadata_prompt import metadata_recovery_prompt


def edit_note(
    runtime,
    model_prompt,
    source,
    candidates,
    assets,
    max_tags,
    max_links,
    authored_links,
):
    for marker, original in assets.items():
        source = source.replace(marker, original)
    prompt = model_prompt
    request_candidates = candidates
    for attempt in range(5):
        try:
            raw, model_name = runtime._generate_local_note_response(
                prompt, source, request_candidates
            )
        except (TimeoutError, ConnectionError, OSError) as exc:
            raise TemporaryModelError(
                "Локальная модель не завершила генерацию из-за временного сбоя. Заметка не сохранена."
            ) from exc
        except Exception as exc:
            raise NoteGenerationError(
                "Локальная модель не завершила генерацию. Заметка не сохранена."
            ) from exc
        try:
            contract = parse_metadata(
                raw,
                source,
                max_tags,
                authored_links,
                discard_invalid_tags=attempt == 4,
            )
        except NoteGenerationError as exc:
            if attempt == 4 or not isinstance(raw, str) or not raw.strip():
                raise
            # The failed completion is not reused as source material or instructions.
            feedback = json.dumps(
                {"validation_error": getattr(exc, "repair_hint", str(exc))},
                ensure_ascii=False,
            )
            instruction = (
                "Предыдущий ответ не прошёл проверку содержания или формата. "
                "Создай исправленный ответ заново по неизменному исходнику ниже. "
                "Не добавляй факты и не удаляй исходные сведения ради устранения ошибки. "
                "Диагностика программы (данные JSON): "
                + feedback
                + "\n\n"
            )
            if attempt == 0 and isinstance(model_prompt, list):
                prompt = [dict(message) for message in model_prompt]
                prompt[0]['content'] += '\n' + instruction
            elif attempt == 0:
                prompt = instruction + model_prompt
            elif attempt == 1:
                # A clean source-only fallback removes potentially confusing
                # identity context while preserving the same strict parser.
                prompt = metadata_prompt(
                    source, [], max_tags, identity_candidates=[]
                )
                prompt[0]['content'] += '\n' + instruction
                request_candidates = []
            else:
                # Repeated language or formatting degeneration can be caused by
                # the long few-shot context itself. The final bounded attempt is
                # an independent, source-only contract rather than another edit
                # of a malformed completion.
                prompt = metadata_recovery_prompt(
                    source,
                    max_tags,
                    getattr(exc, "repair_hint", str(exc)),
                )
                request_candidates = []
            continue
        return contract, model_name, attempt
    raise AssertionError("Bounded editor loop has no unhandled exit")
