# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted large module content into ordered architecture parts while preserving execution
#       order and public API through a thin facade loader to keep file size under 600 lines.

try:
    from backend.note_disk_source import (
        NoteDiskSourceError,
        collect_notes_snapshot,
        load_note_cache,
    )
except ImportError:
    from note_disk_source import NoteDiskSourceError, collect_notes_snapshot, load_note_cache

def _extract_summary_candidate(text):
    cleaned = (text or "").strip()
    if not cleaned:
        return ""
    # берем первую осмысленную строку без markdown-заголовка
    for line in cleaned.splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            return line
    parts = re.split(r"[.\n]", cleaned, maxsplit=1)
    return parts[0].strip() if parts else ""


# Who: Tim Buglaev
# When: 2026-06-14
# What: Keep a single generated-body title pipeline after removing the legacy prompt-first
#       duplicate so title generation has one deterministic implementation.
def _clean_title_source_text(text):
    value = str(text or "")
    cleaner = globals().get("_clean_note_text_for_rag")
    if callable(cleaner):
        value = cleaner(value) or value
    value = re.sub(r"\bEVAL[_:\-A-Za-z0-9]*\b", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\[\[([^\]]+)\]\]", r"\1", value)
    # Who: Tim Buglaev
    # When: 2026-06-15
    # What: Remove nested Obsidian hashtags from title-source text as one metadata
    #       token so filenames are not polluted by tag path fragments.
    value = re.sub(r"#([\w\-/\u0400-\u04FF]+)", " ", value)
    value = re.sub(r"(?im)^\s*(?:title|заголовок|tags?|теги)\s*:\s*.*$", " ", value)
    value = re.sub(r"\s+", " ", value).strip(" .:-")
    return value


# Who: Tim Buglaev
# When: 2026-06-14
# What: Score concrete title phrases instead of raw sentences so generated filenames
#       prefer stable subject nouns, reject status/action wording, and avoid English
#       filler leaked by local model output.
def _title_candidate_score(phrase):
    tokens = _extract_meaningful_tokens(phrase, limit=16, min_len=3)
    if not tokens:
        return -100
    filtered = [
        token
        for token in tokens
        if token not in _TITLE_STOPWORDS
        and token not in _TITLE_ACTION_WORDS
        and not _is_latin_title_noise(token)
    ]
    score = len(filtered) * 2
    if not filtered:
        return -50
    lowered = (phrase or "").strip().casefold()
    first_token = filtered[0] if filtered else ""
    if first_token in _TITLE_ACTION_WORDS or lowered.startswith(("мы ", "я ")):
        score -= 8
    if lowered.startswith((
        "тикетная система",
        "дизайн окна",
        "дизайн окон",
        "форма регистрации",
        "уведомление о новом письме",
    )):
        score += 8
    if len(filtered) != len(set(filtered)):
        score -= 6
    if any(
        token.startswith((
            "тикет",
            "систем",
            "календар",
            "crm",
            "мессендж",
            "админ",
            "уведом",
            "заяв",
            "дизайн",
            "авторизац",
            "регистрац",
            "оператор",
            "интерфейс",
        ))
        for token in filtered
    ):
        score += 5
    if 2 <= len(filtered) <= 5:
        score += 2
    if len(filtered) > 6:
        score -= 3
    return score


# Who: Tim Buglaev
# When: 2026-06-14
# What: Extract domain-oriented title candidates from cleaned note text before using
#       generic keyword fallback; this keeps filenames universal enough for large
#       vaults while fixing concrete bad captures like ticket-system/operator notes.
def _title_pattern_candidates(text):
    lowered = (text or "").casefold()
    candidates = []
    if re.search(r"\bтикет\w*\b", lowered) and re.search(r"\bсистем\w*\b", lowered):
        if re.search(r"\bоператор\w*\b", lowered):
            candidates.append("Тикетная система для операторов")
        elif re.search(r"\bмессенджер\w*\b", lowered):
            candidates.append("Тикетная система мессенджеров")
        else:
            candidates.append("Тикетная система")
    if re.search(r"\bдизайн\w*\b", lowered) and re.search(r"\bокн\w*\b", lowered) and re.search(r"\bавторизац\w*\b", lowered):
        if re.search(r"\bрегистрац\w*\b", lowered):
            candidates.append("Дизайн окон авторизации и регистрации")
        else:
            candidates.append("Дизайн окна авторизации")
    if re.search(r"\bформ\w*\b", lowered) and re.search(r"\bрегистрац\w*\b", lowered) and re.search(r"\bавторизац\w*\b", lowered):
        candidates.append("Форма регистрации и авторизации")
    if re.search(r"\bуведомлен\w*\b", lowered) and re.search(r"\bписьм\w*\b", lowered):
        candidates.append("Уведомление о новом письме")
    return candidates


def _flush_title_chunk(chunks, current):
    if len(current) >= 2:
        chunks.append(list(current))
    current.clear()


def _title_chunk_candidates(sentence, max_words=6):
    chunks = []
    current = []
    for raw in re.findall(r"[A-Za-zА-Яа-яЁё0-9]{2,}", sentence or ""):
        token = re.sub(r"[^A-Za-zА-Яа-яЁё0-9]", "", raw).lower()
        if (
            not token
            or token in _TITLE_STOPWORDS
            or token in _TITLE_ACTION_WORDS
            or token in _TAG_STOPWORDS
            or _is_noise_tag_token(token)
            or _is_latin_title_noise(token)
        ):
            _flush_title_chunk(chunks, current)
            continue
        current.append(token)
        if len(current) >= max_words:
            _flush_title_chunk(chunks, current)
    _flush_title_chunk(chunks, current)
    return [_format_title_words(chunk[:max_words]) for chunk in chunks]


def _title_from_source_text(text, max_words=6):
    cleaned = _clean_title_source_text(text)
    if not cleaned:
        return ""
    sentences = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+|\n+", cleaned)
        if sentence.strip()
    ]
    if not sentences:
        sentences = [cleaned]
    candidates = []
    candidates.extend(_title_pattern_candidates(cleaned))
    for sentence in sentences[:5]:
        candidates.extend(_title_pattern_candidates(sentence))
        candidates.extend(_title_chunk_candidates(sentence, max_words=max_words))
        fallback_phrase = _normalize_title_phrase(sentence, max_words=max_words)
        if fallback_phrase:
            candidates.append(fallback_phrase)
    scored = [
        (candidate, _title_candidate_score(candidate))
        for candidate in candidates
        if _is_meaningful_title_phrase(candidate)
    ]
    if scored:
        scored.sort(key=lambda item: item[1], reverse=True)
        if scored[0][1] > -50:
            return scored[0][0]
    return ""


def _derive_note_base_title(prompt, contexts, generated_text):
    prompt_text = (prompt or "").strip()
    candidates = []
    # Who: Tim Buglaev
    # When: 2026-06-14
    # What: Prefer the normalized generated body for title derivation because it carries
    #       the final note wording; prompt-first titles overfit quick-capture wording.
    generated_body_title = _title_from_source_text(generated_text, max_words=6)
    if generated_body_title:
        prompt_tokens_for_title = set(_extract_meaningful_tokens(prompt_text, limit=32, min_len=3))
        generated_tokens_for_title = set(_extract_meaningful_tokens(generated_body_title, limit=16, min_len=3))
        if (
            not prompt_tokens_for_title
            or generated_tokens_for_title.intersection(prompt_tokens_for_title)
            or _has_soft_token_overlap(generated_tokens_for_title, prompt_tokens_for_title)
        ):
            candidates.append(generated_body_title)

    prompt_title = _title_from_source_text(prompt_text, max_words=6)
    if prompt_title:
        candidates.append(prompt_title)

    prompt_keywords = (
        _select_effective_prompt_keywords(_extract_prompt_keywords(prompt_text, limit=12))[:5]
        if prompt_text
        else []
    )
    if prompt_keywords:
        phrase = _format_title_words(
            token
            for token in prompt_keywords
            if token not in _TITLE_STOPWORDS
            and token not in _TITLE_ACTION_WORDS
            and not _is_latin_title_noise(token)
        )
        if _is_meaningful_title_phrase(phrase):
            candidates.append(phrase)

    heading = _extract_first_heading(generated_text)
    generated_title = _title_from_source_text(heading, max_words=6)
    if generated_title:
        generated_tokens = set(_extract_meaningful_tokens(generated_title, limit=12, min_len=3))
        prompt_tokens = set(_extract_meaningful_tokens(prompt_text, limit=24, min_len=3))
        if not prompt_tokens or generated_tokens.intersection(prompt_tokens) or _has_soft_token_overlap(generated_tokens, prompt_tokens):
            candidates.append(generated_title)

    candidates.append(NOTE_BASE_TITLE)
    seen = set()
    for candidate in candidates:
        normalized = re.sub(r"\s+", " ", str(candidate or "").strip())
        key = normalized.lower()
        if normalized and key not in seen:
            seen.add(key)
            return normalized
    return NOTE_BASE_TITLE


def _make_json_safe(value, depth=0):
    if depth > 5:
        return str(value)
    if isinstance(value, dict):
        return {k: _make_json_safe(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_make_json_safe(v, depth + 1) for v in value]
    try:
        json.dumps(value)
        return value
    except TypeError:
        return str(value)


def _make_unique_note_title(base_title):
    normalized_base = (base_title or "").strip() or NOTE_BASE_TITLE

    _reload_notes_cache(reason="/generate numbering")
    existing_numbers = []
    has_base_title = False

    with _notes_cache_lock:
        existing_keys = list(notes_data.keys())

    for key in existing_keys:
        if key == normalized_base:
            has_base_title = True
        elif key.startswith(normalized_base + " "):
            suffix = key[len(normalized_base) + 1:].strip()
            if suffix.isdigit():
                existing_numbers.append(int(suffix))

    current_notes_dir = sys.modules[__name__].NOTES_DIR
    try:
        is_real_path = isinstance(current_notes_dir, pathlib.Path)
        if is_real_path and current_notes_dir.exists():
            for note_file in current_notes_dir.glob(f"{normalized_base}*.md"):
                title = note_file.stem
                if title == normalized_base:
                    has_base_title = True
                elif title.startswith(normalized_base + " "):
                    suffix = title[len(normalized_base) + 1:].strip()
                    if suffix.isdigit():
                        num = int(suffix)
                        if num not in existing_numbers:
                            existing_numbers.append(num)
    except Exception:
        pass

    # Who: Tim Buglaev
    # When: 2026-06-14
    # What: Keep clean base titles when there is no collision and add numeric suffixes
    #       only for real duplicates, avoiding default "... 1" generated titles.
    if not has_base_title:
        return normalized_base
    existing_numbers.sort()
    next_num = 2
    for num in existing_numbers:
        if num == next_num:
            next_num += 1
        elif num > next_num:
            break
    return f"{normalized_base} {next_num}"


# Who: Tim Buglaev
# When: 2026-03-25
# What: Enforced local-only source normalization and ignored remote/auto request values to keep
#       endpoint behavior deterministic and prevent cloud-routing through request parameters.
def _normalize_requested_source(data):
    return "local"


# Who: Tim Buglaev
# When: 2026-03-25
# What: Disabled remote RAG execution path explicitly so any legacy call-site fails fast instead of
#       silently attempting network inference.
def _fetch_remote_rag_response(query, contexts, use_raw_prompt=False):
    raise RuntimeError("Remote/cloud RAG is disabled in local-only mode")


def _generate_local_rag_response(query, contexts):
    context_titles = [entry.get("title") for entry in (contexts or [])]
    previews = []
    for entry in (contexts or [])[:3]:
        title = entry.get("title") or "без названия"
        snippet = (entry.get("snippet") or "").replace("\n", " ").strip()
        if len(snippet) > 160:
            snippet = snippet[:157] + "..."
        tags = entry.get("tags") or []
        tags_label = f" | теги: {', '.join(tags)}" if tags else ""
        previews.append(f"{title}{tags_label}: {snippet}")
    if previews:
        print(f"RAG локально: выбрано {len(context_titles)} контекст(ов). Примеры: {previews}")
    else:
        print("RAG локально: контекст не найден для локальной модели.")
    # Who: Tim Buglaev
    # When: 2026-06-13
    # What: Guard local RAG generation with context usability and post-generation grounding checks so
    #       the model cannot answer from outside the note database when retrieval is weak.
    if not _rag_context_is_usable(query, contexts):
        return _rag_no_information_response(query, contexts), local_rag_model.name
    response = local_rag_model.generate_answer(query, contexts)
    return _sanitize_rag_response(query, contexts, response), local_rag_model.name


# Who: Tim Buglaev
# When: 2026-06-22
# What: Generate chat answers through the strict evidence contract, validate model budget
#       settings, and return only verified source metadata; malformed output fails closed.
def _generate_grounded_rag_result(query, contexts, display_limit=5):
    try:
        from backend.rag_grounding import RagGenerationError
    except ImportError:
        from rag_grounding import RagGenerationError
    limits_reader = getattr(local_rag_model, "grounded_generation_limits", None)
    try:
        limits = limits_reader() if callable(limits_reader) else (512, 12000)
        if not isinstance(limits, (tuple, list)) or len(limits) != 2:
            raise ValueError("invalid grounded generation limits")
        evidence_budget = int(limits[1])
    except (TypeError, ValueError):
        logger.warning("RAG model returned invalid generation limits; using bounded defaults")
        evidence_budget = 12000
    candidates = prepare_grounded_candidates(contexts, text_budget=evidence_budget)
    if not candidates:
        return {
            "response": NO_INFORMATION_RESPONSE,
            "context": [],
            "citations": [],
            "model": local_rag_model.name,
            "insufficient_information": True,
            "validation_error": None,
        }
    raw_response = local_rag_model.generate_grounded_answer(query, candidates)
    if not isinstance(raw_response, str) or not raw_response.strip():
        raise RagGenerationError("Локальная модель не завершила ответ. Повторите запрос.")
    parsed = parse_grounded_answer(raw_response, candidates, display_limit=display_limit)
    public_contexts = []
    for entry in parsed.get("contexts") or []:
        public_contexts.append(
            {
                "title": entry.get("title") or "Безымянная заметка",
                "snippet": entry.get("matched_excerpt") or entry.get("snippet") or "",
                "tags": list(entry.get("tags") or []),
                "score": entry.get("score") or 0,
                "note_id": entry.get("note_id") or "",
                "heading": entry.get("heading") or "",
            }
        )
    validation_error = parsed.get("validation_error")
    if validation_error:
        logger.warning(
            "RAG grounded output rejected reason=%s candidates=%d",
            validation_error,
            len(candidates),
        )
        raise RagGenerationError("Ответ модели не прошёл проверку источников. Повторите запрос.")
    return {
        "response": parsed["answer"],
        "context": public_contexts,
        "citations": parsed.get("citations") or [],
        "model": local_rag_model.name,
        "insufficient_information": bool(parsed.get("insufficient_information")),
        "validation_error": validation_error,
    }


def _generate_local_note_response(note_prompt, query, contexts):
    logger.info("Local note generation candidate_count=%d", len(contexts or []))
    return local_rag_model.generate_note(note_prompt, query, contexts), local_rag_model.name


# Who: Tim Buglaev
# When: 2026-03-25
# What: Forced remote availability checks to False so cloud branches remain unreachable at runtime.
def _remote_available():
    return False


# Who: Tim Buglaev
# When: 2026-03-25
# What: Converted test-client helper into a no-op because local-only mode does not initialize cloud clients.
def _ensure_test_client():
    return None


notes_data = {}
_notes_snapshot = {}
_notes_cache_lock = threading.RLock()
_notes_dir_mtime = None
_notes_cache_state = {
    "reloaded": False,
    "cache_count": 0,
    "snapshot_count": 0,
    "disk_count": 0,
    "last_reason": "",
    "dir_mtime": None,
}


def _collect_notes_snapshot():
    return collect_notes_snapshot(NOTES_DIR)


def _update_notes_cache_state(reloaded, disk_count, reason, dir_mtime=None):
    with _notes_cache_lock:
        _notes_cache_state.update({
            "reloaded": bool(reloaded),
            "cache_count": len(notes_data),
            "snapshot_count": len(_notes_snapshot),
            "disk_count": disk_count,
            "last_reason": reason,
            "dir_mtime": dir_mtime if dir_mtime is not None else _notes_dir_mtime,
        })


def _get_notes_cache_state():
    with _notes_cache_lock:
        return dict(_notes_cache_state)


def _reload_notes_cache(force=False, reason="", skip_index=False):
    """Обновляет кэш notes_data, если на диске произошли изменения или запрос принудительный."""
    global _notes_snapshot, _notes_dir_mtime
    reason_text = f" ({reason})" if reason else ""
    is_test_env = "PYTEST_CURRENT_TEST" in os.environ
    if IS_TEST_ENV and not force:
        _update_notes_cache_state(
            reloaded=False,
            disk_count=len(_notes_snapshot),
            reason=reason or "test_env_skip",
            dir_mtime=_notes_dir_mtime,
        )
        return False
    try:
        from unittest.mock import Mock
        notes_dir_mocked = isinstance(NOTES_DIR, Mock)
    except Exception:
        notes_dir_mocked = False

    # Who: Tim Buglaev
    # When: 2026-06-14
    # What: Keep cache reload diagnostics ASCII-only so Windows startup logs stay readable
    #       even when the terminal cannot decode UTF-8 Russian text.
    # В тестах, когда NOTES_DIR замокирован, не трогаем кэш (иначе MagicMock меняет mtime и кэш очищается)
    if notes_dir_mocked and is_test_env and not force:
        _update_notes_cache_state(
            reloaded=False,
            disk_count=len(_notes_snapshot),
            reason=reason or "mock_notes_dir",
            dir_mtime=_notes_dir_mtime,
        )
        print(f"Notes cache not reloaded{reason_text}: NOTES_DIR is mocked")
        return False
    try:
        if not NOTES_DIR.exists():
            raise NoteDiskSourceError("Notes directory is unavailable; previous cache preserved")
    except OSError as dir_err:
        raise NoteDiskSourceError("Could not verify the notes directory") from dir_err

    current_dir_mtime = None
    try:
        current_dir_mtime = NOTES_DIR.stat().st_mtime_ns
    except Exception:
        current_dir_mtime = None
    if notes_dir_mocked:
        current_dir_mtime = None

    try:
        snapshot = _collect_notes_snapshot() or {}
    except Exception as snap_err:
        print(f"[WARNING] Failed to build notes snapshot{reason_text}: {snap_err}")
        raise

    snapshot_keys = set(snapshot.keys())
    with _notes_cache_lock:
        cached_keys = set(notes_data.keys())
        previous_count = len(notes_data)

    dir_mtime_changed = (
        _notes_dir_mtime is not None
        and current_dir_mtime is not None
        and _notes_dir_mtime != current_dir_mtime
    )
    cache_mismatch = cached_keys != snapshot_keys
    disk_changed = snapshot != _notes_snapshot
    if notes_dir_mocked and is_test_env:
        dir_mtime_changed = False
        disk_changed = False
    should_reload = force or disk_changed or dir_mtime_changed or (cache_mismatch and not is_test_env)

    if not should_reload:
        if cache_mismatch:
            print(
                f"[WARNING] Notes cache differs from disk state{reason_text}: "
                f"cache={len(cached_keys)}, files={len(snapshot_keys)}"
            )
        else:
            print(f"Notes cache unchanged{reason_text}: {previous_count} records")
        if current_dir_mtime is not None:
            with _notes_cache_lock:
                _notes_dir_mtime = current_dir_mtime
        _update_notes_cache_state(
            reloaded=False,
            disk_count=len(snapshot_keys),
            reason=reason or "no_reload",
            dir_mtime=_notes_dir_mtime,
        )
        return False

    loaded, snapshot = load_note_cache(NOTES_DIR, extract_tags, _filter_tags)
    snapshot_keys = set(snapshot)

    loaded_keys = set(loaded.keys())
    if loaded_keys != snapshot_keys:
        print(
            f"[WARNING] Notes cache reload mismatch{reason_text}: "
            f"files={len(snapshot_keys)}, loaded={len(loaded_keys)}"
        )

    with _notes_cache_lock:
        notes_data.clear()
        notes_data.update(loaded)
        _notes_snapshot = snapshot
        _notes_dir_mtime = current_dir_mtime

    qdrant_indexed = False
    qdrant_sync_report = None
    if not skip_index:
        qdrant_indexed = _index_notes_in_qdrant(loaded)
        # Who: Tim Buglaev
        # When: 2026-06-14
        # What: Reconcile Qdrant with the freshly loaded vault after indexing so deleted,
        #       renamed, or quarantined noisy notes cannot remain as stale ANN candidates.
        try:
            syncer = globals().get("_sync_qdrant_collection_with_cache")
            if callable(syncer):
                qdrant_sync_report = syncer(loaded)
        except Exception as sync_err:
            print(f"[WARNING] Qdrant sync after cache reload failed{reason_text}: {sync_err}")

    _update_notes_cache_state(
        reloaded=True,
        disk_count=len(snapshot_keys),
        reason=reason or "reload",
        dir_mtime=_notes_dir_mtime,
    )
    if qdrant_indexed:
        print(f"Notes cache indexed in Qdrant: {len(notes_data)} records")
    if qdrant_sync_report and qdrant_sync_report.get("deleted"):
        print(f"Qdrant stale points deleted: {qdrant_sync_report.get('deleted')}")
    print(f"Notes cache refreshed{reason_text}: {len(notes_data)} records (files on disk: {len(snapshot_keys)})")
    return True


def _validate_notes_cache(reason="validation"):
    """Перепроверяет кэш заметок и при рассинхроне выполняет принудительный reload."""
    try:
        disk_snapshot = _collect_notes_snapshot() or {}
    except Exception as snap_err:
        print(f"[WARNING] Failed to validate notes cache ({reason}): {snap_err}")
        return
    disk_keys = set(disk_snapshot.keys())
    with _notes_cache_lock:
        cache_keys = set(notes_data.keys())
        snapshot_keys = set(_notes_snapshot.keys())
    if cache_keys != disk_keys or snapshot_keys != disk_keys:
        print(
            f"[WARNING] Обнаружен рассинхрон кэша заметок ({reason}): "
            f"кэш={len(cache_keys)}, снапшот={len(snapshot_keys)}, диск={len(disk_keys)}. "
            "Выполняем принудительную перезагрузку."
        )
        _reload_notes_cache(force=True, reason=f"{reason} validation")
    else:
        _update_notes_cache_state(
            reloaded=False,
            disk_count=len(disk_keys),
            reason=reason or "validation",
            dir_mtime=_notes_dir_mtime,
        )


def _wait_for_local_model_ready(max_wait_seconds=None, force_rebuild=False):
    """Ждет загрузки локальной модели, чтобы не отдавать 503 при первом запросе."""
    try:
        from unittest.mock import Mock
    except Exception:
        Mock = None
    timeout = max_wait_seconds or MODEL_READY_TIMEOUT
    start = time.time()
    force_flag = bool(force_rebuild)
    retry_on_error = True
    while time.time() - start < timeout:
        try:
            ready = local_rag_model.load_model(
                block=True,
                wait_timeout=timeout,
                force_rebuild=force_flag,
            )
        except Exception as exc:
            return False, "error", str(exc)
        force_flag = False
        if ready and local_rag_model.is_fully_loaded and local_rag_model.downloaded:
            return True, "ready", None
        last_error = getattr(local_rag_model, "last_load_error", None)
        if Mock and isinstance(last_error, Mock):
            last_error = None
        if last_error:
            if retry_on_error:
                retry_on_error = False
                force_flag = True
                # Повторяем попытку после ошибки, чтобы избежать преждевременного 503
                continue
            return False, "error", str(last_error)
        time.sleep(MODEL_READY_POLL_INTERVAL)
    last_error = getattr(local_rag_model, "last_load_error", None)
    if Mock and isinstance(last_error, Mock):
        last_error = None
    if last_error:
        return False, "error", str(last_error)
    return False, "loading", None


# --- retraining helpers -------------------------------------------------
_training_runner = None
_training_runner_lock = threading.Lock()


def _atomic_env_write(env_path, lines):
    try:
        tmp_path = env_path.with_suffix(env_path.suffix + ".tmp")
        tmp_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        tmp_path.replace(env_path)
    except Exception as exc:
        print(f"[WARNING] Не удалось обновить {env_path}: {exc}")


def _update_env_files(env_updates):
    """Safely updates .env files in backend/ and project root."""
    if not env_updates:
        return
    portable = portable_runtime_root()
    env_paths = [portable / "runtime.env"] if portable else [BASE_DIR / ".env", Path(BASE_DIR).parent / ".env"]
    for env_path in env_paths:
        try:
            lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
        except Exception:
            lines = []
        new_lines = []
        seen = set()
        for line in lines:
            if not line or line.lstrip().startswith("#") or "=" not in line:
                new_lines.append(line)
                continue
            key, _, _ = line.partition("=")
            key = key.strip()
            if key in env_updates and env_updates[key] is not None:
                new_lines.append(f"{key}={env_updates[key]}")
                seen.add(key)
            else:
                new_lines.append(line)
        for key, value in env_updates.items():
            if key not in seen and value is not None:
                new_lines.append(f"{key}={value}")
        _atomic_env_write(env_path, new_lines)
    for key, value in env_updates.items():
        if value is None:
            continue
        os.environ[key] = str(value)


