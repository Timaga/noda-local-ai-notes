# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted large module content into ordered architecture parts while preserving execution
#       order and public API through a thin facade loader to keep file size under 600 lines.

def _apply_new_model_path(new_path, run_id=None, metrics=None):
    """Atomically updates GGUF path in env files and reloads the model with rollback on failure."""
    global GGUF_MODEL_PATH, RAG_LOCAL_MODEL_GGUF_PATH, RAG_RUNTIME_PROVIDER, RAG_LOCAL_MODEL_FORMAT
    global RAG_RUNTIME_MODEL_ID, USE_GGUF, SELECTED_QUANTIZATION_BACKEND
    path_obj = Path(new_path)
    if not path_obj.exists():
        return {
            "success": False,
            "stage": "swap",
            "error": f"GGUF file not found: {new_path}",
            "run_id": run_id,
        }
    # Who: Tim Buglaev
    # When: 2026-06-15
    # What: Persist GGUF swaps as the active local llama.cpp runtime so startup model
    #       selection survives restarts and does not accidentally relaunch vLLM.
    previous_path = RAG_LOCAL_MODEL_GGUF_PATH or GGUF_MODEL_PATH
    previous_filename = os.environ.get("GGUF_FILENAME", Path(previous_path).name if previous_path else None)
    previous_provider = globals().get("RAG_RUNTIME_PROVIDER", "local")
    previous_format = globals().get("RAG_LOCAL_MODEL_FORMAT", "transformers")
    previous_runtime_model_id = globals().get("RAG_RUNTIME_MODEL_ID", globals().get("RAG_LOCAL_MODEL_ID", None))
    previous_use_gguf = globals().get("USE_GGUF", False)
    previous_quantization_backend = globals().get("SELECTED_QUANTIZATION_BACKEND", os.environ.get("QUANTIZATION_BACKEND", "auto"))
    updates = {
        "GGUF_MODEL_PATH": str(path_obj),
        "RAG_LOCAL_MODEL_GGUF_PATH": str(path_obj),
        "GGUF_FILENAME": path_obj.name,
        "RAG_RUNTIME_PROVIDER": "local",
        "RAG_LOCAL_MODEL_FORMAT": "llama_cpp",
        "RAG_RUNTIME_MODEL_ID": str(path_obj),
        "USE_GGUF": "true",
        "QUANTIZATION_BACKEND": "gguf",
    }
    try:
        _update_env_files(updates)
        GGUF_MODEL_PATH = updates["GGUF_MODEL_PATH"]
        RAG_LOCAL_MODEL_GGUF_PATH = updates["RAG_LOCAL_MODEL_GGUF_PATH"]
        RAG_RUNTIME_PROVIDER = "local"
        RAG_LOCAL_MODEL_FORMAT = "llama_cpp"
        RAG_RUNTIME_MODEL_ID = str(path_obj)
        USE_GGUF = True
        SELECTED_QUANTIZATION_BACKEND = "gguf"
        local_rag_model.gguf_path = path_obj
        local_rag_model.runtime_provider = "local"
        local_rag_model.model_format = "llama_cpp"
        local_rag_model.model_id = str(path_obj)
        local_rag_model._pipeline = None
        local_rag_model._pipeline_initialized = False
        local_rag_model.is_fully_loaded = False
        local_rag_model.downloaded = False
        from model_init import initialize_local_model

        init_info = initialize_local_model()
        ready, ready_status, ready_error = _wait_for_local_model_ready(force_rebuild=True)
        if not ready:
            raise RuntimeError(ready_error or ready_status)
        return {
            "success": True,
            "stage": "swap",
            "path": str(path_obj),
            "run_id": run_id,
            "init": init_info,
            "metrics": metrics or {},
        }
    except Exception as exc:
        rollback_path = str(previous_path or "")
        rollback_updates = {
            "GGUF_MODEL_PATH": rollback_path,
            "RAG_LOCAL_MODEL_GGUF_PATH": rollback_path,
            "GGUF_FILENAME": previous_filename or (Path(previous_path).name if previous_path else ""),
            "RAG_RUNTIME_PROVIDER": previous_provider,
            "RAG_LOCAL_MODEL_FORMAT": previous_format,
            "RAG_RUNTIME_MODEL_ID": previous_runtime_model_id or "",
            "USE_GGUF": str(bool(previous_use_gguf)).lower(),
            "QUANTIZATION_BACKEND": previous_quantization_backend or "auto",
        }
        _update_env_files(rollback_updates)
        GGUF_MODEL_PATH = rollback_path
        RAG_LOCAL_MODEL_GGUF_PATH = rollback_path
        RAG_RUNTIME_PROVIDER = previous_provider
        RAG_LOCAL_MODEL_FORMAT = previous_format
        RAG_RUNTIME_MODEL_ID = previous_runtime_model_id
        USE_GGUF = bool(previous_use_gguf)
        SELECTED_QUANTIZATION_BACKEND = previous_quantization_backend
        local_rag_model.gguf_path = Path(previous_path) if previous_path else None
        local_rag_model.runtime_provider = previous_provider
        local_rag_model.model_format = previous_format
        local_rag_model.model_id = previous_runtime_model_id
        local_rag_model._pipeline = None
        local_rag_model._pipeline_initialized = False
        local_rag_model.is_fully_loaded = False
        return {
            "success": False,
            "stage": "swap",
            "error": str(exc),
            "rolled_back": True,
            "previous_path": str(previous_path) if previous_path else None,
            "run_id": run_id,
        }


# --- Autolinker and Autotagger Implementation ---

RELATED_SECTION_HEADER = "## Связанные заметки"
PLAN_BACKLINKS_ENABLED = _parse_bool_env("PLAN_BACKLINKS_ENABLED", False)
_recent_note_events = {}
_RECENT_EVENT_TTL = 3.0
_NOTE_AUTOLINK_DEBOUNCE_SEC = float(os.environ.get("NOTE_AUTOLINK_DEBOUNCE_SEC", 10.0))
_note_autolink_lock = threading.Lock()
_note_autolink_state = {}
_note_processed_signatures = {}
_finalized_note_cache = {}
_NOTE_FINALIZED_TTL = max(5.0, float(os.environ.get("NOTE_FINALIZED_TTL", 240.0)))
_note_generation_guard = {}
_NOTE_GENERATION_TTL = max(5.0, float(os.environ.get("NOTE_GENERATION_TTL", 45.0)))


def _compute_note_digest(content):
    try:
        return hashlib.sha256((content or "").encode("utf-8", errors="ignore")).hexdigest()
    except Exception:
        return None


def _register_finalized_note(path_obj, content):
    key = _note_path_key(path_obj)
    digest = _compute_note_digest(content)
    ts = time.time()
    with _note_autolink_lock:
        _finalized_note_cache[key] = {"digest": digest, "ts": ts}
        _note_generation_guard.pop(key, None)
        try:
            signature = _note_event_signature(path_obj)
        except Exception:
            signature = None
        if signature is not None:
            _note_processed_signatures[key] = signature


def _mark_generated_note_guard(path_obj, content):
    key = _note_path_key(path_obj)
    digest = _compute_note_digest(content)
    try:
        signature = _note_event_signature(path_obj)
    except Exception:
        signature = None
    with _note_autolink_lock:
        _note_generation_guard[key] = {"digest": digest, "signature": signature, "ts": time.time()}


def _should_skip_generated_event(path_obj, content):
    key = _note_path_key(path_obj)
    digest = _compute_note_digest(content)
    try:
        signature = _note_event_signature(path_obj)
    except Exception:
        signature = None
    now = time.time()
    with _note_autolink_lock:
        entry = _note_generation_guard.get(key)
        if not entry:
            return False
        if now - float(entry.get("ts", 0)) > _NOTE_GENERATION_TTL:
            _note_generation_guard.pop(key, None)
            return False
        if (digest and entry.get("digest") == digest) or (signature is not None and entry.get("signature") == signature):
            entry["ts"] = now
            entry["signature"] = signature if signature is not None else entry.get("signature")
            entry["digest"] = digest if digest is not None else entry.get("digest")
            return True
    return False


def _is_finalized_note_event(path_obj, content):
    key = _note_path_key(path_obj)
    digest = _compute_note_digest(content)
    now = time.time()
    with _note_autolink_lock:
        entry = _finalized_note_cache.get(key)
        if entry and digest and entry.get("digest") == digest:
            if now - float(entry.get("ts") or 0) <= _NOTE_FINALIZED_TTL:
                entry["ts"] = now
                return True
            _finalized_note_cache.pop(key, None)
    return False


def _note_path_key(path_obj):
    try:
        return str(path_obj.resolve())
    except Exception:
        return str(path_obj)


def _is_note_path_in_vault(path_obj):
    try:
        notes_root = getattr(NOTES_DIR, "resolve", lambda: NOTES_DIR)()
        resolved = path_obj.resolve()
        return resolved == notes_root or notes_root in resolved.parents
    except Exception:
        try:
            return str(path_obj).startswith(str(NOTES_DIR))
        except Exception:
            return False


def _cancel_scheduled_note_update(event_path):
    try:
        key = _note_path_key(Path(event_path))
    except Exception:
        key = str(event_path)
    with _note_autolink_lock:
        state = _note_autolink_state.pop(key, None)
        if state:
            timer = state.get("timer")
            if timer:
                timer.cancel()
        _note_processed_signatures.pop(key, None)


def _run_debounced_note_update(key, event_path, previous_path, version):
    with _note_autolink_lock:
        state = _note_autolink_state.get(key)
        if not state or state.get("version") != version:
            return
    try:
        _handle_note_update(event_path, previous_path=previous_path)
    finally:
        try:
            final_sig = _note_event_signature(Path(event_path))
        except Exception:
            final_sig = None
        with _note_autolink_lock:
            _note_processed_signatures[key] = final_sig
            _note_autolink_state.pop(key, None)


def _schedule_debounced_note_update(event_path, previous_path=None):
    try:
        path_obj = Path(event_path)
    except Exception:
        return
    if path_obj.suffix.lower() != ".md":
        return
    if not _is_note_path_in_vault(path_obj):
        return
    key = _note_path_key(path_obj)
    signature = _note_event_signature(path_obj)
    with _note_autolink_lock:
        processed_sig = _note_processed_signatures.get(key)
        if processed_sig is not None and processed_sig == signature:
            return
        state = _note_autolink_state.get(key) or {}
        version = state.get("version", 0) + 1
        timer = state.get("timer")
        if timer:
            timer.cancel()
        delayed = threading.Timer(
            _NOTE_AUTOLINK_DEBOUNCE_SEC,
            _run_debounced_note_update,
            args=(key, event_path, previous_path, version),
        )
        delayed.daemon = True
        _note_autolink_state[key] = {"timer": delayed, "version": version, "previous": previous_path}
        delayed.start()


def _note_event_signature(path_obj):
    try:
        stat = path_obj.stat()
        return (stat.st_mtime_ns, stat.st_size)
    except Exception:
        return None


def _mark_recent_note_event(path_obj):
    try:
        signature = _note_event_signature(path_obj)
    except Exception:
        signature = None
    try:
        _recent_note_events[str(path_obj)] = {"signature": signature, "ts": time.time()}
    except Exception:
        pass


def _should_skip_recent_event(path_obj):
    key = str(path_obj)
    signature = _note_event_signature(path_obj)
    now = time.time()
    entry = _recent_note_events.get(key)
    if entry:
        if entry.get("signature") == signature and (now - entry.get("ts", 0)) < _RECENT_EVENT_TTL:
            return True
        if (now - entry.get("ts", 0)) > (_RECENT_EVENT_TTL * 4):
            _recent_note_events.pop(key, None)
    _recent_note_events[key] = {"signature": signature, "ts": now}
    return False


def _strip_existing_related_section(content):
    cleaned = re.sub(r"<!-- AUTOLINKER:START -->.*?<!-- AUTOLINKER:END -->", "", content, flags=re.DOTALL)
    cleaned = re.sub(rf"^{RELATED_SECTION_HEADER}.*?(?=^## |\Z)", "", cleaned, flags=re.MULTILINE | re.DOTALL)
    cleaned = re.sub(r"^\s*Связанные:\s.*$", "", cleaned, flags=re.MULTILINE)
    return cleaned.strip("\n")


def _remove_stopword_hashtags(text):
    """Удаляет бессмысленные хэштеги прямо в тексте заметки."""
    return re.sub(
        # Who: Tim Buglaev
        # When: 2026-06-15
        # What: Remove slash-based Obsidian nested tags with the same stopword guard
        #       used for flat hashtags.
        r"#([\w\-/\u0400-\u04FF]+)",
        lambda match: "" if _normalize_candidate_tag(match.group(1)) is None else match.group(0),
        text,
    )


def _paraphrase_note_content(content):
    """
    Приводит заметку к человеческому виду: нормализует текст без потери смысла.
    Сохраняет исходные факты, но убирает служебные блоки автолинковки и лишние секции.
    """
    normalized_body = _strip_existing_related_section(_normalize_user_note_text(content))
    normalized_body = re.sub(r"(?im)^теги:\s*.*$", "", normalized_body).strip()
    # Who: Tim Buglaev
    # When: 2026-06-15
    # What: Drop standalone Obsidian hashtag metadata before paragraph normalization
    #       and remove exact leaked tag prefixes from older watcher rewrites, so
    #       "#crm" cannot become plain "crm" body text.
    leading_tag_values = []
    tag_line_pattern = re.compile(r"^(#([\w\-/\u0400-\u04FF]+)\s*)+$")
    for raw_line in normalized_body.splitlines():
        stripped_line = raw_line.strip()
        if not stripped_line:
            continue
        if not tag_line_pattern.match(stripped_line):
            break
        leading_tag_values.extend(re.findall(r"#([\w\-/\u0400-\u04FF]+)", stripped_line))
    tag_line_stripper = globals().get("_strip_standalone_hashtag_lines")
    if callable(tag_line_stripper):
        normalized_body = tag_line_stripper(normalized_body)
    else:
        normalized_body = re.sub(r"(?m)^(#([\w\-/\u0400-\u04FF]+)\s*)+$", "", normalized_body).strip()
    for tag_value in leading_tag_values:
        prefix = f"{tag_value} "
        if normalized_body.startswith(prefix):
            normalized_body = normalized_body[len(prefix):].lstrip()
    normalized_body = _remove_stopword_hashtags(normalized_body)
    if not normalized_body:
        return content

    # Убираем секционные заголовки (## Краткое резюме, ## Основной текст и т.д.)
    body_paragraphs = []
    for paragraph in re.split(r"\n\s*\n", normalized_body):
        normalized = re.sub(r"^#+\s*", "", paragraph.strip())
        normalized = re.sub(r"\s+", " ", normalized).strip()
        if not normalized:
            continue
        # Пропускаем строки, которые являются только заголовком секции
        if normalized.lower() in ("краткое резюме", "основной текст", "ключевые пункты",
                                   "финальная заметка", "план действий", "контекст", "шаги"):
            continue
        body_paragraphs.append(normalized)

    return "\n\n".join(body_paragraphs).strip() if body_paragraphs else normalized_body


def _render_related_block(links):
    if not links:
        return ""
    lines = [RELATED_SECTION_HEADER]
    lines.extend(f"- [[{link}]]" for link in links)
    return "\n".join(lines)


def _apply_related_block(content, links):
    if not links:
        return content
    block = _render_related_block(links)
    pattern = re.compile(rf"^{RELATED_SECTION_HEADER}.*?(?=^## |\Z)", re.MULTILINE | re.DOTALL)
    if pattern.search(content):
        return pattern.sub(block, content)
    separator = "\n\n" if content and not content.endswith("\n") else "\n"
    return f"{content.rstrip()}{separator}{block}"


_RU_INFLECTION_SUFFIXES = (
    "ки", "ку", "ке", "ок", "ек",  # мн.ч., род.п.
    "ой", "ей", "ою", "ею",  # тв.п.
    "ую", "юю",  # прилагательные
    "ём", "ем", "им", "ым", "ом",  # предл.п.
    "ёт", "ет", "ит", "ут", "ют", "ат", "ят",  # глаголы
    "ать", "ять", "еть", "ить", "уть",  # инфинитивы
    "ёшь", "ешь", "ете",  # спряжение
    "ого", "его",  # род.п. прилагательных
    "ому", "ему",  # дат.п.
    "ных", "тых",  # множ. прилагательных
    "ную",  # вин.п. прил.
)


def _normalize_candidate_tag(tag):
    try:
        from backend.note_generation_contract import normalize_tag
    except ImportError:
        from note_generation_contract import normalize_tag
    return normalize_tag(tag)


def _merge_tags_into_content(content, candidate_tags, existing_tags=None):
    existing_tags = existing_tags or extract_tags(content)
    normalized_existing = []
    for tag in existing_tags:
        norm = _normalize_candidate_tag(tag)
        if norm and norm not in normalized_existing:
            normalized_existing.append(norm)

    normalized_new = []
    for tag in candidate_tags or []:
        norm = _normalize_candidate_tag(tag)
        if norm and norm not in normalized_new and norm not in normalized_existing:
            normalized_new.append(norm)

    max_tags = min(MAX_TAGS, 10) if MAX_TAGS > 0 else 0
    if max_tags <= 0:
        return content, []

    normalized_existing = normalized_existing[:max_tags]
    available_slots = max_tags - len(normalized_existing)
    tags_to_add = normalized_new[:available_slots] if available_slots > 0 else []
    final_tags = (normalized_existing + tags_to_add)[:max_tags]
    if not final_tags:
        return content, []
    tag_line = " ".join(f"#{tag}" for tag in final_tags)

    # Who: Tim Buglaev
    # When: 2026-03-10
    # What: Reworked tag-line merge to remove all pre-existing standalone tag lines (single and combined) before
    #       inserting one canonical top tag line, preventing duplicate hashtag blocks in generated notes.
    lines = content.splitlines()
    insert_index = 0
    if content.startswith("---"):
        for idx, line in enumerate(lines[1:], start=1):
            if line.strip().startswith('---'):
                insert_index = idx + 1
                break
    tag_line_pattern = re.compile(r"^(Теги:|tags:)", re.IGNORECASE)
    hashtag_line_pattern = re.compile(r"^(#\w[\w\-/]*)(\s+#\w[\w\-/]*)*$")
    filtered_lines = []
    first_tag_slot = None
    removed_before_insert = 0
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if tag_line_pattern.match(stripped) or hashtag_line_pattern.match(stripped):
            if first_tag_slot is None:
                first_tag_slot = len(filtered_lines)
            if idx < insert_index:
                removed_before_insert += 1
            continue
        filtered_lines.append(line)
    insert_index = max(0, insert_index - removed_before_insert)
    if first_tag_slot is not None:
        insert_index = min(insert_index, first_tag_slot)
    insert_index = min(insert_index, len(filtered_lines))
    filtered_lines.insert(insert_index, tag_line)
    updated = "\n".join(filtered_lines).strip("\n") + "\n"
    return updated, tags_to_add


def _cosine_similarity(vec1, vec2):
    if not vec1 or not vec2:
        return 0.0
    if len(vec1) != len(vec2):
        target = max(len(vec1), len(vec2))
        vec1 = _resize_embedding(vec1, target)
        vec2 = _resize_embedding(vec2, target)
    dot = sum(a * b for a, b in zip(vec1, vec2))
    norm1 = sum(a * a for a in vec1) ** 0.5
    norm2 = sum(b * b for b in vec2) ** 0.5
    if not norm1 or not norm2:
        return 0.0
    return dot / (norm1 * norm2)


def _normalize_similarity_candidates(raw_candidates, current_title):
    normalized = []
    seen = set()
    current = (current_title or "").strip().lower()
    for candidate in raw_candidates or []:
        title = str(candidate.get("title") or "").strip()
        if not title:
            continue
        if title.strip().lower() == current:
            continue
        score = float(candidate.get("score") or 0)
        min_threshold = max(SIM_THRESHOLD, 0.35)
        if score < min_threshold:
            continue
        tags = candidate.get("tags") or []
        key = title.lower()
        if key in seen:
            continue
        seen.add(key)
        # Who: Tim Buglaev
        # When: 2026-06-15
        # What: Preserve service-card evidence fields through candidate normalization so
        #       structured note generation receives the same compact context Qdrant stored.
        normalized.append({
            "title": title,
            "score": score,
            "tags": tags,
            "snippet": candidate.get("snippet") or "",
            "aliases": candidate.get("aliases") or [],
            "concepts": candidate.get("concepts") or [],
        })
    normalized.sort(key=lambda x: (-x["score"], x["title"].lower()))
    return normalized[:TOP_K_SEARCH]


def _prepare_candidates_from_qdrant(results, current_title):
    raw = []
    for item in results or []:
        payload = getattr(item, "payload", {}) or {}
        # Who: Tim Buglaev
        # When: 2026-06-13
        # What: Drop stale Qdrant candidates during note generation/autolinking so deleted notes
        #       cannot re-enter related links even if vector deletion previously failed.
        validator = globals().get("_qdrant_payload_matches_active_note")
        if callable(validator) and not validator(payload):
            continue
        raw.append(
            {
                "title": payload.get("title") or payload.get("filename") or payload.get("id"),
                "score": getattr(item, "score", payload.get("score", 0)),
                "tags": payload.get("tags") or [],
                # Who: Tim Buglaev
                # When: 2026-06-15
                # What: Carry compact service-card context into note-generation prompts so
                #       the LLM chooses links from candidate evidence instead of title-only guesses.
                "snippet": payload.get("summary") or payload.get("snippet") or payload.get("text") or "",
                "aliases": payload.get("aliases") or [],
                "concepts": payload.get("concepts") or [],
            }
        )
    return _normalize_similarity_candidates(raw, current_title)


