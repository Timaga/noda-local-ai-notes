# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted large module content into ordered architecture parts while preserving execution
#       order and public API through a thin facade loader to keep file size under 600 lines.

# Who: Tim Buglaev
# When: 2026-06-15
# What: Import focused service-card helpers for structured note generation while
#       preserving the runtime-layer facade and direct-script fallback imports.
try:
    from backend.note_service_card import (
        build_index_text as _service_card_build_index_text,
        build_note_json_prompt as _service_card_build_note_json_prompt,
        extract_service_card as _service_card_extract_service_card,
        render_note_document as _service_card_render_note_document,
        render_visible_note_document as _service_card_render_visible_note_document,
        validate_generation_contract as _service_card_validate_generation_contract,
    )
except Exception:
    try:
        from note_service_card import (  # type: ignore
            build_index_text as _service_card_build_index_text,
            build_note_json_prompt as _service_card_build_note_json_prompt,
            extract_service_card as _service_card_extract_service_card,
            render_note_document as _service_card_render_note_document,
            render_visible_note_document as _service_card_render_visible_note_document,
            validate_generation_contract as _service_card_validate_generation_contract,
        )
    except Exception:
        _service_card_build_index_text = None
        _service_card_build_note_json_prompt = None
        _service_card_extract_service_card = None
        _service_card_render_note_document = None
        _service_card_render_visible_note_document = None
        _service_card_validate_generation_contract = None

def _build_plan_items_from_contexts(contexts, max_items=4):
    if not contexts:
        return []
    plan_items = []
    seen = set()
    for entry in contexts:
        title = (entry or {}).get("title")
        if not title:
            continue
        normalized = title.strip().lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        snippet = (entry or {}).get("snippet") or ""
        item = _format_plan_item(title, snippet)
        if item:
            plan_items.append(item)
        if len(plan_items) >= max(2, min(max_items, 4)):
            break
    return plan_items


def _merge_plan_items(content, plan_items):
    """
    Добавляет пункты плана в блок 'План действий', избегая дубликатов.
    Возвращает кортеж (updated_content, added_items).
    """
    if not plan_items:
        return content, []
    lines = (content or "").splitlines()
    plan_header_re = re.compile(r"^##+\s+План", re.IGNORECASE)
    section_start = None
    section_end = len(lines)
    for idx, line in enumerate(lines):
        if plan_header_re.match(line.strip()):
            section_start = idx
            break
    if section_start is None:
        base = "\n".join(lines).strip("\n")
        new_section = ["## План действий", *plan_items]
        updated = (base + "\n\n" if base else "") + "\n".join(new_section)
        return updated, plan_items
    for idx in range(section_start + 1, len(lines)):
        if re.match(r"^##+\s", lines[idx].strip()):
            section_end = idx
            break
    existing_block = lines[section_start + 1:section_end]
    existing_links = set()
    for raw in existing_block:
        match = re.search(r"\[\[([^\]]+)\]\]", raw)
        if match:
            existing_links.add(match.group(1).strip().lower())
    added = []
    for item in plan_items:
        link_match = re.search(r"\[\[([^\]]+)\]\]", item)
        key = (link_match.group(1).strip().lower() if link_match else item.strip().lower())
        if key in existing_links:
            continue
        existing_block.append(item)
        existing_links.add(key)
        added.append(item)
    lines = lines[:section_start + 1] + existing_block + lines[section_end:]
    updated_content = "\n".join(lines).strip("\n")
    return updated_content, added


def _refresh_note_entry_in_cache(title, content, path_obj, existing_tags=None, vector=None):
    """Обновляет notes_data и Qdrant после изменения файла заметки."""
    try:
        from backend.note_faithful_archive import current_wrapper_metadata
    except ImportError:
        from note_faithful_archive import current_wrapper_metadata

    try:
        stat = path_obj.stat()
        timestamp_value = getattr(stat, "st_mtime", None)
        snapshot_value = (stat.st_mtime_ns, stat.st_size)
    except Exception:
        timestamp_value = None
        snapshot_value = None
    metadata, _ = current_wrapper_metadata(content)
    if metadata and metadata["noda_source_version"] == "ru-pipeline-v1":
        tags = list(metadata["tags"])
    else:
        tags = _filter_tags(extract_tags(content))
        if existing_tags:
            tags = _filter_tags(list(tags) + list(existing_tags))
    filepath = str(path_obj)
    filename = path_obj.name
    # Who: Tim Buglaev
    # When: 2026-06-13
    # What: Refresh embeddings/snippets from cleaned RAG text while keeping raw Markdown in notes_data
    #       for editing and Obsidian-compatible output.
    cleaner = globals().get("_clean_note_text_for_rag")
    index_text = cleaner(content) if callable(cleaner) else content
    index_text = index_text or content
    snippet = _generate_snippet(index_text, title)
    with _notes_cache_lock:
        notes_data[title] = {
            "content": content,
            "tags": tags,
            "filename": filename,
            "filepath": filepath,
            "timestamp": timestamp_value,
            "snippet": snippet,
        }
        if snapshot_value:
            _notes_snapshot[title] = snapshot_value
    _index_notes_in_qdrant(
        {
            title: {
                "content": content,
                "tags": tags,
                "filename": filename,
                "filepath": filepath,
                "timestamp": timestamp_value,
                "snippet": snippet,
                "vector": vector,
                "vector_text": index_text,
            }
        }
    )


def _append_note_to_related_plan(current_title, note_snippet, candidates):
    """
    Добавляет ссылку на новую заметку в план действий схожей (сводной) заметки.
    Возвращает название обновленной заметки или None.
    """
    global _notes_dir_mtime
    plan_line = _format_plan_item(current_title, note_snippet)
    if not plan_line:
        return None
    for candidate in candidates or []:
        candidate_title = (candidate or {}).get("title")
        if not candidate_title:
            continue
        if candidate_title.strip().lower() == str(current_title).strip().lower():
            continue
        with _notes_cache_lock:
            target = dict(notes_data.get(candidate_title) or {})
        if not target:
            continue
        content = target.get("content") or ""
        # Обновляем только заметки, где уже есть план, чтобы не захламлять точечные записи.
        if "план" not in content.lower():
            continue
        filepath = target.get("filepath") or target.get("path")
        if not filepath:
            continue
        try:
            path_obj = pathlib.Path(filepath)
            current_text = path_obj.read_text(encoding="utf-8")
        except Exception:
            continue
        updated_content, added = _merge_plan_items(current_text, [plan_line])
        if not added:
            continue
        try:
            path_obj.write_text(updated_content, encoding="utf-8")
        except Exception as write_exc:
            logger.warning("Не удалось дополнить план в %s: %s", filepath, write_exc)
            continue
        _refresh_note_entry_in_cache(candidate_title, updated_content, path_obj, existing_tags=target.get("tags"))
        try:
            _notes_dir_mtime = NOTES_DIR.stat().st_mtime_ns
            _update_notes_cache_state(
                reloaded=False,
                disk_count=len(_notes_snapshot),
                reason="plan_updated",
                dir_mtime=_notes_dir_mtime,
            )
        except Exception:
            pass
        return candidate_title
    return None


def _build_note_prompt(prompt, contexts):
    context_blocks = []
    for entry in contexts or []:
        title = entry.get("title") or "Без названия"
        tags = entry.get("tags") or []
        tags_line = f"теги: {', '.join(tags)}" if tags else "теги: нет"
        context_blocks.append(f"- {title} ({tags_line})")
    context_block = "\n".join(context_blocks) if context_blocks else "Контекст не найден."
    return (
        "Ты помогаешь вести базу заметок Obsidian. "
        "Перефразируй запрос пользователя в 2-5 предложений на русском языке. "
        "Сохрани все факты и смысл, но сформулируй текст чисто и лаконично.\n\n"
        "СТРОГИЕ ПРАВИЛА:\n"
        "- НЕ добавляй заголовки (##, ###).\n"
        "- НЕ добавляй секции 'Краткое резюме', 'Ключевые пункты', 'Финальная заметка', 'План действий'.\n"
        "- НЕ добавляй маркированные списки, нумерованные списки, чек-листы.\n"
        "- НЕ выдумывай факты, отсутствующие в запросе.\n"
        "- Верни ТОЛЬКО связный текст (2-5 предложений), ничего больше.\n\n"
        f"Доступные заметки (для справки):\n{context_block}\n\n"
        f"Запрос пользователя: {prompt}\n\n"
        "Перефразированный текст:"
    )


# Who: Tim Buglaev
# When: 2026-06-13
# What: Overrode the note-generation prompt to make user text the authoritative fact source while
#       limiting retrieved context to optional links/tags; this prevents RAG context from overwriting new facts.
def _build_note_prompt(prompt, contexts):
    context_blocks = []
    for entry in contexts or []:
        title = entry.get("title") or "Без названия"
        tags = entry.get("tags") or []
        tags_line = f"теги: {', '.join(tags)}" if tags else "теги: нет"
        context_blocks.append(f"- {title} ({tags_line})")
    context_block = "\n".join(context_blocks) if context_blocks else "Контекст не найден."
    return (
        "Ты помогаешь вести базу заметок Obsidian.\n"
        "Текст пользователя ниже является главным и единственным источником новых фактов. "
        "Сохрани все конкретные факты, ограничения, сущности, числа, названия и новые требования из текста пользователя. "
        "Контекст существующих заметок используй только как справку для возможных связей и тегов, но не добавляй из него новые факты в тело заметки.\n\n"
        "Строгие правила:\n"
        "- Перефразируй текст пользователя на русском в 2-5 ясных предложений.\n"
        "- Не добавляй заголовки, списки, чек-листы, секции, таблицы или markdown-блоки.\n"
        "- Не выдумывай факты и не заменяй факты пользователя фактами из контекста.\n"
        "- Если модель не уверена, верни аккуратно очищенный текст пользователя без новых деталей.\n"
        "- Верни только тело заметки, без тегов и без блока связанных заметок.\n\n"
        f"Доступные заметки только для справки:\n{context_block}\n\n"
        f"Текст пользователя:\n{prompt}\n\n"
        "Тело заметки:"
    )


# Who: Tim Buglaev
# When: 2026-06-15
# What: Added runtime wrappers around the pure service-card module so note generation
#       can request strict JSON, validate tags/links against existing candidates, and
#       build Qdrant index text from title/aliases/summary/concepts only.
def _build_note_json_prompt(prompt, contexts, allowed_tags):
    if callable(_service_card_build_note_json_prompt):
        return _service_card_build_note_json_prompt(prompt, contexts or [], allowed_tags or [])
    return _build_note_prompt(prompt, contexts)


def _parse_note_generation_contract(raw_text, allowed_tags=None, candidate_titles=None):
    if not callable(_service_card_validate_generation_contract):
        return None
    try:
        return _service_card_validate_generation_contract(
            raw_text,
            allowed_tags=allowed_tags or [],
            candidate_titles=candidate_titles or [],
            normalizer=_normalize_candidate_tag,
        )
    except Exception as exc:
        logger.warning("Failed to validate note generation JSON contract: %s", exc)
        return None


def _build_note_index_text(title, content, tags=None):
    if callable(_service_card_build_index_text):
        try:
            return _service_card_build_index_text(
                title,
                content,
                tags=tags,
                clean_text_func=_clean_note_text_for_rag,
                extract_links_func=_extract_links_from_content,
                token_func=_extract_meaningful_tokens,
                max_chars=RAG_MAX_INDEX_TEXT_CHARS,
            )
        except Exception as exc:
            logger.warning("Failed to build service-card index text for %s: %s", title, exc)
    return _clean_note_text_for_rag(content) or str(content or "")


def _extract_note_service_card(title, content, tags=None):
    if callable(_service_card_extract_service_card):
        try:
            return _service_card_extract_service_card(
                title,
                content,
                tags=tags,
                clean_text_func=_clean_note_text_for_rag,
                extract_links_func=_extract_links_from_content,
                infer_metadata=False,
            )
        except Exception as exc:
            logger.warning("Index metadata could not be parsed (%s)", type(exc).__name__)
    return {
        "title": title,
        "aliases": [],
        "tags": list(tags or []),
        "summary": "",
        "concepts": [],
        "related": _extract_links_from_content(content),
    }


def _render_note_service_document(title, body, tags, related_links, contract=None):
    if callable(_service_card_render_note_document):
        try:
            return _service_card_render_note_document(
                title,
                body,
                tags=tags or [],
                related=related_links or [],
                contract=contract or {},
                clean_text_func=_clean_note_text_for_rag,
                token_func=_extract_meaningful_tokens,
            )
        except Exception as exc:
            logger.warning("Failed to render service-card frontmatter for %s: %s", title, exc)
    return body


# Who: Tim Buglaev
# When: 2026-06-15
# What: Keep generated note files and API responses free of internal service-card
#       frontmatter while preserving the existing runtime-layer fallback path.
def _render_visible_note_document(body):
    if callable(_service_card_render_visible_note_document):
        try:
            return _service_card_render_visible_note_document(body)
        except Exception as exc:
            logger.warning("Failed to render visible note document: %s", exc)
    clean_body = str(body or "").strip()
    return f"{clean_body.rstrip()}\n" if clean_body else ""


def _has_meaningful_note_content(text):
    """Эвристика: проверяет, есть ли в тексте осмысленное содержимое, а не только линки/теги."""
    raw = (text or "").strip()
    if not raw:
        return False
    placeholder_markers = ("Пустой ответ", "Модель не вернула текст")
    if any(marker in raw for marker in placeholder_markers):
        return False
    tags_present = bool(extract_tags(raw))
    cleaned = re.sub(r"```.+?```", " ", raw, flags=re.S)
    cleaned = re.sub(r"\[\[[^\]]+\]\]", " ", cleaned)
    # Who: Tim Buglaev
    # When: 2026-06-15
    # What: Treat nested Obsidian tags as metadata during content-quality checks so
    #       slash-based tags do not leak into generated body scoring.
    cleaned = re.sub(r"#([\w\-/\u0400-\u04FF]+)", " ", cleaned)
    cleaned = re.sub(r"(?im)^теги:\s*.*$", " ", cleaned)
    cleaned = re.sub(r"(?im)^связанные:\s*.*$", " ", cleaned)
    cleaned = re.sub(r"[•\-\*]\s*\[\[.*?\]\]", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    word_like_tokens = re.findall(r"[A-Za-zА-Яа-яЁё0-9]{2,}", cleaned)
    if len(word_like_tokens) < 2:
        return tags_present and len(word_like_tokens) >= 1
    return True


def _build_fallback_note_body(prompt, contexts):
    """Создает содержательное тело заметки, если модель вернула мусор или пустоту."""
    prompt_text = (prompt or "").strip()
    if not prompt_text:
        return "Запрос: без текста"
    return prompt_text


# Who: Tim Buglaev
# When: 2026-03-10
# What: Expanded prompt-noise vocabulary with capture-flow verbs (e.g., "добавить/добавил/осталось") so
#       related-link/title selection stays focused on domain entities instead of generic action wording.
_PROMPT_NOISE_TOKENS = {
    "план",
    "планы",
    "плана",
    "плану",
    "планом",
    "плане",
    "планов",
    "планам",
    "планами",
    "планах",
    "первый",
    "первая",
    "первое",
    "первые",
    "второй",
    "вторая",
    "третья",
    "шаг",
    "шаги",
    "этап",
    "этапы",
    "выход",
    "выходы",
    "выходит",
    "необходимо",
    "именно",
    "срочно",
    "сейчас",
    "нужно",
    "надо",
    "пришлось",
    "приходится",
    "осталось",
    "остается",
    "добавить",
    "добавил",
    "добавила",
    "добавлено",
    "добавлена",
    "добавлять",
    "добавление",
    "добавлений",
    "добавляем",
    "добавит",
    "важность",
    "высший",
    "высшего",
    "приоритетным",
    "plan",
    "plans",
    "first",
    "second",
    "third",
}

# Who: Tim Buglaev
# When: 2026-03-09
# What: Added mixed-script canonicalization for lookalike latin/cyrillic symbols so noise filtering catches
#       evasive variants like "плaн"/"пеpвый" that previously bypassed exact token matching.
_LATIN_TO_CYRILLIC_CONFUSABLES = str.maketrans(
    {
        "a": "а",
        "c": "с",
        "e": "е",
        "h": "н",
        "k": "к",
        "m": "м",
        "o": "о",
        "p": "р",
        "t": "т",
        "x": "х",
        "y": "у",
        "A": "А",
        "C": "С",
        "E": "Е",
        "H": "Н",
        "K": "К",
        "M": "М",
        "O": "О",
        "P": "Р",
        "T": "Т",
        "X": "Х",
        "Y": "У",
    }
)
_NOISE_TOKEN_PREFIXES = (
    "перв",
    "втор",
    "трет",
    "четвер",
    "пят",
    "шест",
    "седьм",
    "восьм",
    "девят",
    "десят",
    "first",
    "second",
    "third",
)


def _canonicalize_noise_token(token):
    normalized = str(token or "").strip().lower()
    if not normalized:
        return "", ""
    normalized = re.sub(r"[_\-\s]+", "", normalized)
    canonical = normalized.translate(_LATIN_TO_CYRILLIC_CONFUSABLES)
    return normalized, canonical


def _is_noise_tag_token(token):
    normalized, canonical = _canonicalize_noise_token(token)
    if not normalized and not canonical:
        return False
    variants = [variant for variant in (normalized, canonical) if variant]
    for variant in variants:
        if variant in _PROMPT_NOISE_TOKENS:
            return True
        if any(variant.startswith(prefix) for prefix in _NOISE_TOKEN_PREFIXES):
            return True
    return False


def _extract_meaningful_tokens(text, limit=16, min_len=3):
    tokens = []
    for token in re.findall(r"[A-Za-zА-Яа-яЁё0-9]{2,}", text or ""):
        normalized = re.sub(r"[^A-Za-zА-Яа-яЁё0-9]", "", token).lower()
        if not normalized:
            continue
        # Who: Tim Buglaev
        # When: 2026-03-09
        # What: Preserved short acronym-like tokens (e.g., CRM/API/aml) while still rejecting short cyrillic
        #       fragments; this improves title/tag precision without losing common technical abbreviations.
        allow_short_acronym = bool(re.fullmatch(r"[A-ZА-ЯЁ0-9]{2,6}", token))
        allow_short_latin = bool(re.fullmatch(r"[a-z0-9]{2,4}", token))
        if len(normalized) < max(2, min_len) and not (allow_short_acronym or allow_short_latin):
            continue
        # Who: Tim Buglaev
        # When: 2026-03-09
        # What: Applied shared noise-token guard with mixed-script normalization so keyword extraction ignores
        #       confusable fillers and keeps link/title selection anchored to meaningful prompt entities.
        if normalized in _TAG_STOPWORDS or _is_noise_tag_token(normalized):
            continue
        if normalized not in tokens:
            tokens.append(normalized)
        if len(tokens) >= max(1, limit):
            break
    return tokens


# Who: Tim Buglaev
# When: 2026-03-09
# What: Added lightweight soft overlap matching on token prefixes to recover inflected-word matches (e.g.,
#       "админка" vs "админки") without reopening broad fuzzy matching.
def _has_soft_token_overlap(tokens_a, tokens_b, min_prefix=5):
    token_set_a = [token for token in tokens_a or [] if token]
    token_set_b = [token for token in tokens_b or [] if token]
    for left in token_set_a:
        for right in token_set_b:
            if left == right:
                return True
            if len(left) >= min_prefix and len(right) >= min_prefix and left[:min_prefix] == right[:min_prefix]:
                return True
    return False


def _extract_prompt_keywords(prompt, limit=8):
    # Who: Tim Buglaev
    # When: 2026-03-09
    # What: Switched prompt keyword extraction to a shared meaningful-token parser to keep downstream retrieval
    #       deterministic and resilient against noisy words like "первый"/"план", and to avoid short title debris.
    return _extract_meaningful_tokens(prompt, limit=limit, min_len=4)


def _strip_contextual_noise(text, contexts):
    cleaned = (text or "").strip()
    if not cleaned:
        return ""
    cleaned = re.sub(r"<!-- AUTOLINKER:START -->.*?<!-- AUTOLINKER:END -->", "", cleaned, flags=re.S)
    cleaned = re.sub(r"(?im)^#{1,3}\s*контекст.*?(?=^#|\Z)", "", cleaned, flags=re.S | re.M)
    cleaned = re.sub(r"(?im)^контекст:\s.*$", "", cleaned, flags=re.M)
    cleaned = re.sub(r"(?im)^связанные:\s.*$", "", cleaned, flags=re.M)
    for entry in contexts or []:
        title = (entry or {}).get("title")
        if title:
            pattern = re.compile(rf"(?im)^[-*•]\s*\[\[\s*{re.escape(title)}\s*\]\].*$")
            cleaned = re.sub(pattern, "", cleaned)
        snippet = _normalize_snippet_text((entry or {}).get("snippet") or "")
        if snippet:
            cleaned = cleaned.replace(snippet, "")
    cleaned_lines = []
    tag_line_pattern = re.compile(r"^(#\w[\w\-/]*(\s+#\w[\w\-/]*)*)$", re.IGNORECASE)
    bullet_tag_pattern = re.compile(r"^-+\s*#\w", re.IGNORECASE)
    for line in cleaned.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if tag_line_pattern.match(stripped):
            continue
        if bullet_tag_pattern.match(stripped):
            continue
        cleaned_lines.append(line)
    return "\n".join(cleaned_lines).strip()


def _build_prompt_driven_body(prompt):
    prompt_text = _normalize_user_note_text(prompt)
    if not prompt_text:
        return "Запрос: без текста"
    return prompt_text.strip()


# Who: Tim Buglaev
# When: 2026-06-13
# What: Added prompt-fact coverage checks so generated note bodies cannot drop user-provided
#       facts, numbers, or acronyms while trying to paraphrase the quick-note input.
def _extract_critical_prompt_tokens(text):
    critical = set()
    for token in re.findall(r"\b[A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9_-]{1,}\b", text or ""):
        critical.add(token.casefold())
    for token in re.findall(r"\b\d+(?:[.,]\d+)?\b", text or ""):
        critical.add(token.casefold())
    return critical


def _note_body_preserves_prompt_facts(prompt_text, body_text):
    prompt_tokens = set(_extract_meaningful_tokens(prompt_text, limit=80, min_len=3))
    if not prompt_tokens:
        return True
    body_tokens = set(_extract_meaningful_tokens(body_text, limit=120, min_len=3))
    if not body_tokens:
        return False
    critical_tokens = _extract_critical_prompt_tokens(prompt_text)
    body_lower = (body_text or "").casefold()
    for token in critical_tokens:
        if token and token not in body_lower:
            return False
    counter = globals().get("_count_supported_tokens")
    if callable(counter):
        covered = counter(prompt_tokens, body_tokens)
    else:
        covered = len(prompt_tokens.intersection(body_tokens))
    required_ratio = 0.34 if len(prompt_tokens) >= 8 else 0.45
    return (covered / max(1, len(prompt_tokens))) >= required_ratio


def _ensure_note_body_with_prompt(prompt, contexts, generated_text):
    prompt_text = _normalize_user_note_text(prompt)
    sanitized_body = _sanitize_generated_note_body(prompt_text, generated_text)
    if sanitized_body:
        sanitized_body = _strip_contextual_noise(sanitized_body, contexts)
        sanitized_body = _strip_section_by_heading(sanitized_body, "Краткое резюме")
        sanitized_body = _strip_section_by_heading(sanitized_body, "Ключевые пункты")
        sanitized_body = _strip_section_by_heading(sanitized_body, "Финальная заметка")
        sanitized_body = _strip_section_by_heading(sanitized_body, "План действий")
        sanitized_body = _collapse_duplicate_headings(sanitized_body)
    if sanitized_body and sanitized_body.strip():
        if not _note_body_preserves_prompt_facts(prompt_text, sanitized_body):
            return _build_prompt_driven_body(prompt_text)
        return sanitized_body.strip()
    return _build_prompt_driven_body(prompt_text)


# Who: Tim Buglaev
# When: 2026-03-09
# What: Added strict grounding post-processors for generated notes to drop unsupported acronyms and collapse
#       hashtag-only header noise, preventing unrelated entities (e.g., AML) from leaking into final note text.
def _strip_standalone_hashtag_lines(text):
    if not text:
        return ""
    hashtag_only_pattern = re.compile(r"^(#([\w\-/\u0400-\u04FF]+)\s*)+$")
    cleaned_lines = []
    for raw_line in (text or "").splitlines():
        stripped = raw_line.strip()
        if hashtag_only_pattern.match(stripped):
            continue
        cleaned_lines.append(raw_line)
    return "\n".join(cleaned_lines).strip()


def _strip_unprompted_acronym_sentences(prompt_text, body_text, allowed_titles=None):
    if not body_text:
        return ""
    allowed_tokens = set(_extract_meaningful_tokens(prompt_text, limit=64, min_len=2))
    for title in allowed_titles or []:
        allowed_tokens.update(_extract_meaningful_tokens(title, limit=24, min_len=2))
    segments = re.split(r"(?<=[.!?])\s+|\n+", body_text)
    kept_segments = []
    for segment in segments:
        snippet = (segment or "").strip()
        if not snippet:
            continue
        acronyms = re.findall(r"\b[A-ZА-ЯЁ]{2,8}\b", snippet)
        unknown_acronyms = [token for token in acronyms if token.casefold() not in allowed_tokens]
        if unknown_acronyms:
            continue
        kept_segments.append(snippet)
    if not kept_segments:
        return _build_prompt_driven_body(prompt_text)
    return " ".join(kept_segments).strip()


def _extract_first_heading(text):
    tag_line_pattern = re.compile(r"^(#[\w\-/\u0400-\u04FF]+)(\s+#[\w\-/\u0400-\u04FF]+)*$")
    for line in (text or "").splitlines():
        stripped = line.strip()
        if not stripped.startswith("#"):
            continue
        if tag_line_pattern.match(stripped):
            continue
        heading = stripped.lstrip("#").strip()
        if heading:
            return heading
    return ""


# Who: Tim Buglaev
# When: 2026-06-14
# What: Expanded title-only stop words and added title casing helpers so generated
#       Russian note names prefer subject phrases over quick-capture status wording,
#       drop unsupported English filler, and preserve technical acronym casing.
_TITLE_STOPWORDS = {
    "заметка",
    "заметку",
    "note",
    "notes",
    "test",
    "тест",
    "summary",
    "итог",
    "резюме",
    "draft",
    "outline",
    "черновик",
    "описание",
    "план",
    "первый",
    "первая",
    "первое",
    "выходит",
    "необходимо",
    "именно",
    "срочно",
    "сейчас",
    "важность",
    "высший",
    "высшего",
    "пришлось",
    "приходится",
    "закончили",
    "завершили",
    "запустили",
    "начали",
    "обрабатывать",
    "обработать",
    "обработку",
    "объединяет",
    "позволит",
    "общаться",
    "завершить",
    "завершено",
    "завершена",
    "завершены",
    "запустить",
    "запущено",
    "начать",
    "начато",
    "добавил",
    "добавили",
    "добавить",
    "добавлено",
    "сделал",
    "сделали",
    "сделать",
    "исправил",
    "исправили",
    "исправить",
    "поменять",
    "изменить",
    "изменили",
    "переделать",
    "переписать",
    "настроить",
    "настроили",
    "реализовать",
    "реализовали",
    "разработку",
    "разработка",
    "работаем",
    "работать",
    "должно",
    "должна",
    "должны",
    "должен",
    "появляться",
    "появиться",
    "попытке",
    "попытка",
    "попытки",
    "входа",
    "работу",
    "работа",
    "компании",
    "наши",
    "наш",
    "наша",
    "наше",
    "своих",
    "своими",
    "все",
    "всё",
    "всех",
    "этот",
    "эта",
    "это",
    "эти",
    "одной",
    "точки",
    "доступа",
    "единую",
    "единая",
    "единый",
    "центральную",
    "integrates",
    "integrate",
    "integrated",
    "нужно",
    "надо",
    "кол",
}


_TITLE_ACTION_WORDS = {
    "добавить",
    "добавил",
    "добавили",
    "запустить",
    "запустили",
    "закончили",
    "завершили",
    "начали",
    "изменить",
    "поменять",
    "переделать",
    "сделать",
    "сделал",
    "сделали",
    "настроить",
    "исправить",
    "реализовать",
    "обработать",
    "работаем",
    "integrates",
}


_TITLE_PROPER_CASE = {
    "api": "API",
    "crm": "CRM",
    "aml": "AML",
    "gguf": "GGUF",
    "vllm": "vLLM",
    "wsl": "WSL",
    "qdrant": "Qdrant",
    "proxmox": "Proxmox",
    "cryptobee": "Cryptobee",
    "telegram": "Telegram",
}


_TITLE_ALLOWED_LATIN_WORDS = set(_TITLE_PROPER_CASE) | {
    "pay",
    "site",
    "parser",
    "exchanger",
    "docker",
    "electron",
    "flask",
}


def _is_latin_title_noise(token):
    normalized = str(token or "").strip().lower()
    if not normalized or normalized in _TITLE_ALLOWED_LATIN_WORDS:
        return False
    if re.fullmatch(r"[a-z]{5,}", normalized):
        return True
    return False


def _format_title_word(token, is_first=False):
    cleaned = (token or "").strip()
    if not cleaned:
        return ""
    normalized = cleaned.lower()
    if normalized in _TITLE_PROPER_CASE:
        return _TITLE_PROPER_CASE[normalized]
    if re.fullmatch(r"[a-z0-9]{2,4}", cleaned):
        return cleaned.upper()
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", cleaned):
        return cleaned[:1].upper() + cleaned[1:].lower()
    return cleaned[:1].upper() + cleaned[1:].lower() if is_first else cleaned.lower()


def _format_title_words(tokens):
    words = []
    for token in tokens or []:
        formatted = _format_title_word(token, is_first=not words)
        if formatted:
            words.append(formatted)
    return " ".join(words).strip()


def _format_title_token(token):
    return _format_title_word(token, is_first=True)


# Who: Tim Buglaev
# When: 2026-03-09
# What: Reworked title phrase normalization to reuse meaningful-token extraction and title token formatter so
#       modal fillers and short clipped fragments (e.g., "кол") do not leak into final note titles.
def _normalize_title_phrase(text, max_words=5):
    keywords = _extract_meaningful_tokens(text, limit=max_words, min_len=4)
    words = []
    for token in keywords:
        # Who: Tim Buglaev
        # When: 2026-06-14
        # What: Drop title-only action/status words after meaningful-token extraction so quick
        #       capture phrasing does not dominate generated note names.
        if token in _TITLE_STOPWORDS or token in _TITLE_ACTION_WORDS or _is_latin_title_noise(token):
            continue
        words.append(token)
    return _format_title_words(words[:max_words])


def _is_meaningful_title_phrase(phrase):
    if not phrase:
        return False
    lowered = phrase.lower()
    if lowered in _TITLE_STOPWORDS:
        return False
    tokens = re.findall(r"[A-Za-zА-Яа-яЁё0-9]+", lowered)
    # Отклоняем только если ВСЕ токены — стоп-слова (а не любой)
    if tokens and all(token in _TITLE_STOPWORDS for token in tokens):
        return False
    if lowered.isdigit():
        return False
    generic_prefixes = (
        "краткое резюме",
        "резюме",
        "итог",
        "summary",
        "draft",
        "черновик",
        "по запросу",
    )
    if any(lowered.startswith(prefix) for prefix in generic_prefixes):
        return False
    return bool(re.search(r"[A-Za-zА-Яа-яЁё]", phrase))


