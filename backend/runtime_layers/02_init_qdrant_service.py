# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted large module content into ordered architecture parts while preserving execution
#       order and public API through a thin facade loader to keep file size under 600 lines.

def _init_qdrant_service():
    from backend.managed_qdrant import owns_endpoint

    global qdrant_service, use_qdrant
    if QdrantService is None:
        return False
    _clear_qdrant_health_cache()
    settings = _qdrant_settings()
    autostart = settings["autostart"]
    ready_retries = max(1, settings["ready_retries"])
    ready_delay = settings["ready_delay"]
    http_timeout = settings["http_timeout"]

    def _probe_ready(attempts, delay):
        try:
            return _wait_for_qdrant_ready(settings["url"], attempts=attempts, delay=delay, timeout=http_timeout)
        except TypeError:
            return _wait_for_qdrant_ready(settings["url"], attempts=attempts, delay=delay)

    if os.environ.get("NODA_MANAGED_QDRANT_EXE"):
        if not autostart or not _start_qdrant_process():
            qdrant_service = None
            use_qdrant = False
            return False
        ready = False
        for attempt in range(ready_retries):
            if owns_endpoint(qdrant_process, settings["url"]) and _probe_ready(attempts=1, delay=0):
                ready = True
                break
            if attempt + 1 < ready_retries:
                time.sleep(ready_delay)
        if not ready:
            _cleanup_qdrant_process()
            qdrant_service = None
            use_qdrant = False
            _update_qdrant_health_cache(False, "managed-qdrant-unavailable")
            return False
    elif autostart:
        # Who: Tim Buglaev
        # When: 2026-06-14
        # What: Probe an already published Qdrant endpoint before spawning a managed
        #       process so Docker/WSL setups do not get duplicate qdrant.exe instances.
        ready = _probe_ready(attempts=1, delay=0)
        if not ready:
            started = _start_qdrant_process()
            if not started:
                logger.warning("Qdrant autostart failed, disabling Qdrant (set QDRANT_AUTOSTART=0 to skip autostart).")
                qdrant_service = None
                use_qdrant = False
                return False
            ready = _probe_ready(attempts=ready_retries, delay=ready_delay)
        if not ready:
            qdrant_service = None
            use_qdrant = False
            return False
    else:
        ready = _probe_ready(attempts=ready_retries, delay=ready_delay)
        if not ready:
            logger.warning("Qdrant health check failed at %s, fallback enabled "
                          "(set QDRANT_AUTOSTART=1 to auto-start).", settings['url'])
            qdrant_service = None
            use_qdrant = False
            return False
    try:
        qdrant_service = QdrantService(settings["url"], settings["collection"])
        qdrant_service.initialize_collection(vector_size=settings["vector_size"])
        try:
            use_qdrant = bool(qdrant_service.health_check())
            _update_qdrant_health_cache(use_qdrant, None if use_qdrant else "health-check-failed", service=qdrant_service)
        except Exception as exc:
            logger.warning("Qdrant health check failed after init: %s. "
                          "Disabling Qdrant (adjust QDRANT_HTTP_TIMEOUT).", exc)
            use_qdrant = False
            _update_qdrant_health_cache(False, str(exc), service=qdrant_service)
        if use_qdrant:
            # Who: Tim Buglaev
            # When: 2026-06-14
            # What: Keep startup diagnostics ASCII-only so Windows console output stays
            #       readable when PowerShell or log files are not decoded as UTF-8.
            logger.info("Qdrant service initialized (collection: %s)", settings['collection'])
            return True
        qdrant_service = None
        return False
    except (TimeoutError, ConnectionError, requests.exceptions.RequestException) as exc:
        logger.warning("Qdrant initialization timed out: %s. "
                      "Using cache fallback (see QDRANT_HTTP_TIMEOUT/QDRANT_AUTOSTART).", exc)
        qdrant_service = None
        use_qdrant = False
        _update_qdrant_health_cache(False, str(exc), service=qdrant_service)
        return False
    except Exception as exc:
        logger.warning("Failed to initialize Qdrant: %s. Using cache fallback.", exc)
        qdrant_service = None
        use_qdrant = False
        _update_qdrant_health_cache(False, str(exc), service=qdrant_service)
        return False


def _load_embedding_model(startup=False):
    """
    Loads the configured embedding model once and records its vector size.
    During test runs we avoid forcing a download on startup to speed up pytest.
    """
    global _embedding_model
    try:
        from backend.semantic_embedding import semantic_search_disabled
    except ImportError:
        from semantic_embedding import semantic_search_disabled
    if semantic_search_disabled():
        return None
    if _embedding_model is not None:
        return _embedding_model
    with _embedding_lock:
        if _embedding_model is not None:
            return _embedding_model
        model_id = _embedding_model_id()
        if IS_TEST_ENV and startup:
            _record_embedding_dim(_get_vector_size())
            return None
        try:
            from sentence_transformers import SentenceTransformer

            logger.info(f"Loading embedding model: {model_id}")
            _embedding_model = SentenceTransformer(model_id, local_files_only=True)
            try:
                if hasattr(_embedding_model, "get_sentence_embedding_dimension"):
                    dim = _embedding_model.get_sentence_embedding_dimension()
                    _record_embedding_dim(dim)
            except Exception:
                pass
        except Exception as exc:
            logger.warning("Failed to load semantic embedding model: %s. Semantic search is unavailable.", exc)
            _embedding_model = None
            if _embedding_dim is None:
                _record_embedding_dim(getattr(backend_config, "VECTOR_SIZE", 768))
        return _embedding_model


def _hash_embedding(text, dims):
    import hashlib

    encoded = (text or "").encode("utf-8", errors="ignore")
    digest = hashlib.sha256(encoded).digest()
    return [((digest[i % len(digest)] / 255.0) * 2) - 1 for i in range(max(1, dims))]


def _resize_embedding(vector, target_dim):
    if not vector:
        return [0.0 for _ in range(target_dim)]
    if len(vector) == target_dim:
        return list(vector)
    resized = []
    for idx in range(target_dim):
        resized.append(vector[idx % len(vector)])
    return resized


def generate_embedding(text, vector_size=None):
    try:
        from backend.semantic_embedding import encode_semantic
    except ImportError:
        from semantic_embedding import encode_semantic
    vector = encode_semantic(_load_embedding_model(), text, vector_size or _get_vector_size())
    _record_embedding_dim(len(vector))
    return vector


# Who: Tim Buglaev
# When: 2026-06-22
# What: Keep transient Qdrant health failures recoverable after the bounded cache TTL;
#       a single timeout no longer permanently disables retrieval until process restart.
def _qdrant_enabled():
    global use_qdrant
    if not (use_qdrant and qdrant_service):
        return False
    cached_service = _qdrant_health_cache.get("service_id")
    current_service_id = id(qdrant_service)
    if cached_service is None and current_service_id is not None and _qdrant_health_cache.get("status") is not None:
        _clear_qdrant_health_cache()
        cached_service = _qdrant_health_cache.get("service_id")
    if cached_service not in (None, current_service_id):
        _clear_qdrant_health_cache()
    cached_status = _qdrant_health_cache.get("status")
    if cached_service == current_service_id and cached_status is not None:
        cached_ts = float(_qdrant_health_cache.get("ts") or 0.0)
        if (time.monotonic() - cached_ts) < _QDRANT_HEALTH_TTL:
            return bool(cached_status)
    try:
        status = bool(qdrant_service.health_check())
        _update_qdrant_health_cache(status, None if status else "health-check-failed", service=qdrant_service)
        return status
    except Exception as exc:
        logger.warning("Qdrant health check failed: %s", exc)
        _update_qdrant_health_cache(False, str(exc), service=qdrant_service)
        return False


def _note_identifier(title, filename=None, filepath=None):
    title_value = ""
    try:
        title_value = (title or "").strip()
    except Exception:
        title_value = ""
    if title_value:
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, title_value))

    fallback_value = ""
    for alt in (filepath, filename):
        try:
            if alt and str(alt).strip():
                fallback_value = str(alt).strip()
                break
        except Exception:
            continue
    if fallback_value:
        return str(uuid.uuid5(uuid.NAMESPACE_URL, fallback_value))

    return str(uuid.uuid4())


def _note_payload_digest(content, tags, filename, filepath, timestamp, vector, snippet=None):
    payload = {
        "content": content or "",
        "tags": list(tags or []),
        "filename": filename or "",
        "filepath": filepath or "",
        "timestamp": timestamp,
        "vector": list(vector or []),
        "snippet": snippet or "",
    }
    try:
        serialized = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
        return hashlib.sha256(serialized.encode("utf-8", errors="ignore")).hexdigest()
    except Exception:
        return None


def _should_skip_qdrant_upsert(note_id, digest):
    if not note_id or not digest:
        return False
    cached = _qdrant_index_state.get(note_id)
    if cached and cached.get("digest") == digest:
        return True
    _qdrant_index_state[note_id] = {"digest": digest, "ts": time.time()}
    return False


def _index_notes_in_qdrant_legacy(notes_dict):
    if not _qdrant_enabled():
        return False
    try:
        vector_size = _get_vector_size()
        payloads = []
        indexed_count = 0
        noise_note_ids = []
        # Who: Tim Buglaev
        # When: 2026-06-14
        # What: Batch Qdrant upserts so large vaults do not accumulate every point
        #       in memory before the first network write; invalid env values fall back safely.
        batch_size = _safe_int(os.environ.get("QDRANT_UPSERT_BATCH_SIZE"), 128) or 128
        batch_size = max(1, min(batch_size, 2048))

        def _flush_payloads():
            nonlocal indexed_count
            if not payloads:
                return
            qdrant_service.upsert_notes(list(payloads))
            indexed_count += len(payloads)
            payloads.clear()

        for idx, (title, data) in enumerate(notes_dict.items()):
            content_text = data.get("content") or ""
            service_card_text = data.get("service_card_content") or content_text
            # Who: Tim Buglaev
            # When: 2026-06-15
            # What: Index the compact Obsidian service card instead of the full body so Qdrant
            #       retrieval uses title/aliases/summary/concepts without exposing internal
            #       frontmatter in user-visible generated notes.
            cleaner = globals().get("_clean_note_text_for_rag")
            index_builder = globals().get("_build_note_index_text")
            service_card_reader = globals().get("_extract_note_service_card")
            clean_content_text = cleaner(content_text) if callable(cleaner) else content_text
            clean_service_card_text = cleaner(service_card_text) if callable(cleaner) else service_card_text
            embedding_text = (
                index_builder(title, service_card_text, tags=data.get("tags"))
                if callable(index_builder)
                else clean_service_card_text or clean_content_text or content_text
            )
            # Who: Tim Buglaev
            # When: 2026-06-22
            # What: Separate embedding representation from answer evidence so Qdrant keeps
            #       compact title/summary/concepts vectors but returns clean note prose to RAG.
            answer_text = clean_content_text or clean_service_card_text or content_text
            filename = data.get("filename") or f"{title}.md"
            filepath = data.get("filepath") or data.get("path")
            note_id = data.get("id") or _note_identifier(title, filename, filepath)
            # Who: Tim Buglaev
            # When: 2026-06-14
            # What: Quarantine pathological repeated/tag-loop notes from Qdrant and remove any
            #       existing point for them so noisy files cannot poison future retrieval.
            noise_reporter = globals().get("_rag_note_noise_report")
            if callable(noise_reporter):
                noise_report = noise_reporter(
                    title,
                    content_text,
                    tags=data.get("tags"),
                    clean_text=clean_content_text,
                )
                if noise_report.get("excluded"):
                    noise_note_ids.append(note_id)
                    logger.warning(
                        "Skipping noisy note from Qdrant index title=%s reasons=%s",
                        title,
                        ",".join(noise_report.get("reasons") or []),
                    )
                    continue
            vector = data.get("vector")
            if vector is None or data.get("vector_text") != embedding_text:
                vector = generate_embedding(embedding_text, vector_size)
            elif len(vector) != vector_size:
                vector = _resize_embedding(vector, vector_size)
            timestamp = data.get("timestamp")
            try:
                # Приводим к float, чтобы Qdrant корректно сериализовал
                timestamp = float(timestamp) if timestamp is not None else None
            except Exception:
                timestamp = None
            raw_snippet = data.get("snippet")
            if raw_snippet and callable(cleaner):
                raw_snippet = cleaner(raw_snippet) or raw_snippet
            snippet = _normalize_snippet_text(raw_snippet or _generate_snippet(answer_text, title))
            payload_digest = _note_payload_digest(
                "\n".join([embedding_text or "", answer_text or ""]),
                data.get("tags"),
                filename,
                filepath,
                timestamp,
                vector,
                snippet=snippet,
            )
            if _should_skip_qdrant_upsert(note_id, payload_digest):
                continue
            service_card = (
                service_card_reader(title, service_card_text, tags=data.get("tags"))
                if callable(service_card_reader)
                else {}
            )
            metadata = {
                "title": title,
                "text": answer_text,
                "tags": list(data.get("tags") or []),
                "filename": filename,
                "filepath": filepath,
                "note_id": note_id,
                "timestamp": timestamp,
                "snippet": snippet,
                "links": _extract_links_from_content(content_text),
                "aliases": list((service_card or {}).get("aliases") or []),
                "summary": (service_card or {}).get("summary") or "",
                "concepts": list((service_card or {}).get("concepts") or []),
                "related": list((service_card or {}).get("related") or []),
            }
            payloads.append((note_id, vector, metadata))
            if len(payloads) >= batch_size:
                _flush_payloads()
        if noise_note_ids:
            try:
                qdrant_service.delete_notes(noise_note_ids)
                for nid in noise_note_ids:
                    _qdrant_index_state.pop(nid, None)
            except Exception as delete_exc:
                logger.warning("Failed to delete noisy notes from Qdrant: %s", delete_exc)
        if not payloads and indexed_count == 0:
            return True
        _flush_payloads()
        logger.info("Notes cache indexed in Qdrant: %d records", indexed_count)
        return True
    except (TimeoutError, ConnectionError, requests.exceptions.RequestException) as exc:
        logger.warning("Failed to update Qdrant due to timeout/connection: %s. "
                      "Check QDRANT_HTTP_TIMEOUT.", exc)
        return False
    except Exception as exc:
        logger.warning("Failed to update Qdrant: %s", exc)
        return False


# Who: Tim Buglaev
# When: 2026-06-22
# What: Delegate active note indexing to the focused chunk orchestrator while preserving
#       the public runtime function used by startup, file watching, and generation.
def _index_notes_in_qdrant(notes_dict):
    return index_note_chunks(globals(), notes_dict)


def _delete_notes_in_qdrant(note_ids):
    if not _qdrant_enabled():
        return False
    if not note_ids:
        return False
    if not isinstance(note_ids, (list, tuple, set)):
        note_ids = [note_ids]
    try:
        parent_ids = [str(note_id) for note_id in note_ids]
        chunk_ids = []
        for parent_id in parent_ids:
            chunk_ids.extend(_qdrant_note_chunk_ids.pop(parent_id, set()) or set())
        # Who: Tim Buglaev
        # When: 2026-06-22
        # What: Delete chunks through their parent payload even when in-memory chunk state
        #       is empty after restart, then remove known IDs and legacy parent points.
        delete_chunks = getattr(qdrant_service, "delete_note_chunks", None)
        if callable(delete_chunks):
            delete_chunks(parent_ids)
        qdrant_service.delete_notes(list(dict.fromkeys(parent_ids + chunk_ids)))
        for point_id in parent_ids + chunk_ids:
            _qdrant_index_state.pop(str(point_id), None)
        return True
    except Exception as exc:
        logger.warning("Failed to delete records from Qdrant: %s", exc)
        return False


# Who: Tim Buglaev
# When: 2026-06-14
# What: Added Qdrant/vault reconciliation to delete stale points and active noisy-note
#       points after reloads, keeping ANN top-k aligned with files that actually exist.
def _sync_qdrant_collection_with_cache(notes_dict=None, max_points=None):
    if not _qdrant_enabled() or not qdrant_service:
        return {"deleted": 0, "scanned": 0, "skipped": True, "reason": "qdrant_unavailable"}
    scroll_points = getattr(qdrant_service, "scroll_points", None)
    if not callable(scroll_points):
        return {"deleted": 0, "scanned": 0, "skipped": True, "reason": "scroll_unavailable"}

    source = notes_dict
    if source is None:
        with _notes_cache_lock:
            source = dict(notes_data)
    active_by_title = {}
    active_ids = set()
    active_chunk_ids = {}
    for title, data in (source or {}).items():
        item = data or {}
        content_text = item.get("content") or ""
        cleaner = globals().get("_clean_note_text_for_rag")
        clean_text = cleaner(content_text) if callable(cleaner) else content_text
        noise_reporter = globals().get("_rag_note_noise_report")
        if callable(noise_reporter) and noise_reporter(title, content_text, tags=item.get("tags"), clean_text=clean_text).get("excluded"):
            continue
        filename = item.get("filename") or f"{title}.md"
        filepath = item.get("filepath") or item.get("path")
        note_id = item.get("id") or _note_identifier(title, filename, filepath)
        title_key = str(title or "").strip().casefold()
        if title_key:
            active_by_title[title_key] = str(note_id)
        active_ids.add(str(note_id))
        # Who: Tim Buglaev
        # When: 2026-06-22
        # What: Rebuild deterministic active chunk IDs without embeddings so startup
        #       reconciliation removes legacy points and obsolete shortened-note tails.
        service_card_reader = globals().get("_extract_note_service_card")
        service_text = item.get("service_card_content") or content_text
        service_card = service_card_reader(title, service_text, tags=item.get("tags")) if callable(service_card_reader) else {}
        chunks = build_note_chunks(
            title,
            content_text,
            tags=item.get("tags"),
            aliases=(service_card or {}).get("aliases"),
            summary=(service_card or {}).get("summary") or "",
            concepts=(service_card or {}).get("concepts"),
            cleaner=cleaner,
        )
        note_chunk_ids = {note_chunk_point_id(note_id, chunk["chunk_index"]) for chunk in chunks}
        active_chunk_ids[str(note_id)] = note_chunk_ids
        _qdrant_note_chunk_ids[str(note_id)] = set(note_chunk_ids)

    deleted_ids = []
    scanned = 0
    offset = None
    limit = 100
    # Who: Tim Buglaev
    # When: 2026-06-14
    # What: Raise the default reconciliation scan ceiling for large vaults while keeping
    #       an explicit env override for operators that need tighter startup bounds.
    default_max_scan = _safe_int(os.environ.get("QDRANT_SYNC_MAX_POINTS"), 250000) or 250000
    max_scan = max_points if isinstance(max_points, int) and max_points > 0 else max(1000, default_max_scan)
    while scanned < max_scan:
        response = scroll_points(limit=limit, offset=offset, with_payload=True, with_vectors=False)
        if isinstance(response, tuple):
            points, offset = response[0], response[1] if len(response) > 1 else None
        else:
            points = getattr(response, "points", response) or []
            offset = getattr(response, "next_page_offset", None)
        if not points:
            break
        for point in points:
            scanned += 1
            payload = getattr(point, "payload", None)
            point_id = getattr(point, "id", None)
            if isinstance(point, dict):
                payload = point.get("payload") or {}
                point_id = point.get("id")
            payload = payload or {}
            raw_title = payload.get("title") or payload.get("filename") or payload.get("id") or ""
            title_value = str(raw_title or "").strip()
            if title_value.lower().endswith(".md"):
                title_value = title_value[:-3].strip()
            expected_id = active_by_title.get(title_value.casefold())
            payload_id = payload.get("note_id")
            point_id_value = str(point_id) if point_id is not None else ""
            payload_id_value = str(payload_id) if payload_id else ""
            # Who: Tim Buglaev
            # When: 2026-06-22
            # What: Keep only exact current chunk IDs; parent note IDs validate ownership,
            #       but no longer allow stale or legacy whole-note points to survive.
            parent_id = payload_id_value or expected_id
            keep = bool(parent_id and point_id_value in active_chunk_ids.get(parent_id, set()))
            if not keep and point_id is not None:
                deleted_ids.append(point_id)
        if offset is None:
            break

    if deleted_ids:
        try:
            qdrant_service.delete_notes(deleted_ids)
            for point_id in deleted_ids:
                _qdrant_index_state.pop(str(point_id), None)
        except Exception as exc:
            logger.warning("Failed to delete stale Qdrant points: %s", exc)
    if deleted_ids:
        logger.info("Qdrant sync deleted %d stale/noisy point(s) after scanning %d", len(deleted_ids), scanned)
    return {"deleted": len(deleted_ids), "scanned": scanned, "skipped": False}


# Who: Tim Buglaev
# When: 2026-06-13
# What: Added active-note validation for Qdrant payloads so stale vectors left after a failed
#       delete cannot be used as RAG context once the source markdown note is gone from cache.
def _qdrant_payload_matches_active_note(payload, point_id=None):
    payload = payload or {}
    title = payload.get("title") or payload.get("filename") or payload.get("id")
    if not title:
        return False
    try:
        title_value = str(title).strip()
        title_keys = [title_value.casefold()]
        if title_value.lower().endswith(".md"):
            title_keys.append(title_value[:-3].strip().casefold())
    except Exception:
        return False
    title_keys = [key for key in title_keys if key]
    if not title_keys:
        return False
    # Who: Tim Buglaev
    # When: 2026-06-13
    # What: Keep backward compatibility for legacy Qdrant payloads without note_id; new indexed
    #       payloads include note_id and can be strictly checked against active notes.
    payload_note_id = payload.get("note_id")
    if not payload_note_id:
        return True

    # Who: Tim Buglaev
    # When: 2026-06-13
    # What: Apply stale-Qdrant filtering only when the active notes cache is populated;
    #       an empty cache can happen in isolated tests or early startup and must not hide all ANN results.
    resolved_title = None
    active_data = None
    with _notes_cache_lock:
        active_items = list(notes_data.items())
    if not active_items:
        return True
    for cached_title, cached_data in active_items:
        try:
            cached_filename = str((cached_data or {}).get("filename") or "")
            cached_stem = cached_filename[:-3] if cached_filename.lower().endswith(".md") else cached_filename
            candidates = [
                str(cached_title).strip().casefold(),
                cached_stem.strip().casefold(),
            ]
        except Exception:
            candidates = []
        if any(title_key in candidates for title_key in title_keys):
            resolved_title = cached_title
            active_data = dict(cached_data or {})
            break
    if resolved_title is None:
        return False

    active_id = active_data.get("id") or _note_identifier(
        resolved_title,
        active_data.get("filename") or payload.get("filename"),
        active_data.get("filepath") or active_data.get("path") or payload.get("filepath"),
    )
    if str(payload_note_id) != str(active_id):
        return False
    # Who: Tim Buglaev
    # When: 2026-06-22
    # What: Reject stale chunk points by exact active ID when chunk state is available;
    #       legacy test/startup payloads remain compatible until reconciliation completes.
    active_chunks = _qdrant_note_chunk_ids.get(str(active_id))
    if active_chunks is not None and point_id is not None:
        return str(point_id) in set(active_chunks)
    return True


def _vector_search_notes(query, limit, search_state=None):
    state = search_state if isinstance(search_state, dict) else {}
    state.setdefault("context_source", "cache")
    if state.get("qdrant_failed"):
        return None
    if not _qdrant_enabled():
        state["qdrant_failed"] = True
        state.setdefault("qdrant_reason", "health-check-failed")
        return None
    try:
        limit_value = _parse_limit_value(
            limit,
            default=RAG_CONTEXT_LIMIT,
            min_value=1,
            max_value=TOP_K_SEARCH,
            label="qdrant_limit",
        )
        vector_size = _get_vector_size()
        query_vector = generate_embedding(query, vector_size)
        # Who: Tim Buglaev
        # When: 2026-06-22
        # What: Combine semantic and morphology-tolerant lexical retrieval through
        #       Qdrant RRF so paraphrases and exact note terminology both remain findable.
        hybrid_search = getattr(qdrant_service, "search_hybrid", None)
        if callable(hybrid_search):
            results = hybrid_search(
                query_vector,
                lexical_sparse_vector(query),
                top_k=limit_value,
            )
        else:
            results = qdrant_service.search_similar(query_vector, top_k=limit_value)
        if results is None:
            state["qdrant_failed"] = True
            state.setdefault("qdrant_reason", "timeout")
            return None
        contexts = []
        for item in results or []:
            payload = getattr(item, "payload", {}) or {}
            point_id = getattr(item, "id", None)
            if isinstance(item, dict):
                # Who: Tim Buglaev
                # When: 2026-06-22
                # What: Preserve payload from application-level RRF result dictionaries;
                #       dropping it caused every valid hybrid candidate to fail active-note checks.
                payload = item.get("payload") or {}
                point_id = item.get("id")
            if not _qdrant_payload_matches_active_note(payload, point_id=point_id):
                continue
            # Who: Tim Buglaev
            # When: 2026-06-13
            # What: Clean Qdrant payload text on read as a defensive fallback for older noisy
            #       points that may still exist until the next full reindex completes.
            cleaner = globals().get("_clean_note_text_for_rag")
            title = payload.get("title") or payload.get("filename") or payload.get("id") or "Заметка"
            text = payload.get("text") or ""
            if callable(cleaner):
                text = cleaner(text) or text
            snippet = payload.get("snippet") or _generate_snippet(text, query)
            if snippet and callable(cleaner):
                snippet = cleaner(snippet) or snippet
            snippet = _normalize_snippet_text(snippet)
            tags = payload.get("tags") or []
            score = item.get("score", payload.get("score", 0)) if isinstance(item, dict) else getattr(item, "score", payload.get("score", 0))
            contexts.append({
                "title": title,
                "snippet": snippet or title,
                "text": text or snippet or title,
                "tags": tags,
                "score": score,
                "source_id": str(payload.get("chunk_id") or point_id or ""),
                "chunk_id": str(payload.get("chunk_id") or point_id or ""),
                "note_id": str(payload.get("note_id") or ""),
                "heading": payload.get("heading") or "",
            })
        if contexts:
            state["qdrant_used"] = True
            state["context_source"] = "qdrant"
        return contexts
    except (TimeoutError, ConnectionError, requests.exceptions.RequestException) as exc:
        state["qdrant_failed"] = True
        state["qdrant_reason"] = str(exc)
        logger.info("Qdrant search unavailable, using cache fallback (%s)", state["qdrant_reason"])
        return None
    except Exception as exc:
        state["qdrant_failed"] = True
        state["qdrant_reason"] = str(exc)
        logger.info("Qdrant search unavailable, using cache fallback (%s)", state["qdrant_reason"])
        return None


