# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted large module content into ordered architecture parts while preserving execution
#       order and public API through a thin facade loader to keep file size under 600 lines.

# Who: Tim Buglaev
# When: 2026-06-19
# What: Added lightweight Russian lexical variants for RAG retrieval so short natural
#       questions still match inflected note titles without weakening generation grounding.
_RAG_MATCH_WORD_RE = re.compile(r"[A-Za-z\u0400-\u04FF0-9][A-Za-z\u0400-\u04FF0-9_\-]*")
_RAG_MATCH_SUFFIXES = (
    "иями", "ями", "ами", "ого", "ему", "ому", "ыми", "ими", "ая", "яя",
    "ое", "ее", "ые", "ие", "ый", "ий", "ой", "ом", "ем", "ам", "ям",
    "ах", "ях", "ов", "ев", "у", "ю", "а", "я", "е", "ы", "и",
)


def _rag_normalize_match_token(token):
    value = re.sub(r"[^A-Za-z\u0400-\u04FF0-9]", "", str(token or "")).lower()
    return value.replace("ё", "е")


def _rag_is_cyrillic_token(token):
    return bool(re.fullmatch(r"[\u0400-\u04FF]+", token or ""))


def _rag_token_match_variants(token, allow_short_prefix=False):
    normalized = _rag_normalize_match_token(token)
    if not normalized:
        return set()
    variants = {normalized}
    for suffix in _RAG_MATCH_SUFFIXES:
        if normalized.endswith(suffix) and len(normalized) - len(suffix) >= 3:
            variants.add(normalized[:-len(suffix)])
    if allow_short_prefix and _rag_is_cyrillic_token(normalized) and 5 <= len(normalized) <= 8:
        variants.add(normalized[:3])
    return {variant for variant in variants if len(variant) >= 3 or any(ch.isdigit() for ch in variant)}


def _rag_text_match_variants(text, limit=160):
    variants = set()
    for raw in _RAG_MATCH_WORD_RE.findall(text or ""):
        normalized = _rag_normalize_match_token(raw)
        allow_name_prefix = bool(
            normalized
            and raw[:1].isupper()
            and _rag_is_cyrillic_token(normalized)
            and 5 <= len(normalized) <= 8
        )
        variants.update(_rag_token_match_variants(raw, allow_short_prefix=allow_name_prefix))
        if len(variants) >= max(1, limit):
            break
    return variants


def _rag_overlap_count(left_variants, right_variants):
    return len(set(left_variants or set()).intersection(set(right_variants or set())))


def _rag_context_overlap_meta(query, title, snippet="", tags=None):
    query_variants = _rag_text_match_variants(query, limit=80)
    title_overlap = _rag_overlap_count(query_variants, _rag_text_match_variants(title, limit=40))
    body_text = " ".join([snippet or "", " ".join(str(tag) for tag in (tags or []))])
    body_overlap = _rag_overlap_count(query_variants, _rag_text_match_variants(body_text, limit=160))
    return title_overlap, body_overlap, title_overlap + body_overlap


def _enrich_rag_context_match(query, entry):
    enriched = dict(entry or {})
    title_overlap, body_overlap, lexical_overlap = _rag_context_overlap_meta(
        query,
        enriched.get("title") or "",
        enriched.get("snippet") or "",
        enriched.get("tags") or [],
    )
    enriched["title_overlap"] = max(int(enriched.get("title_overlap") or 0), title_overlap)
    enriched["body_overlap"] = max(int(enriched.get("body_overlap") or 0), body_overlap)
    enriched["lexical_overlap"] = max(int(enriched.get("lexical_overlap") or 0), lexical_overlap)
    return enriched


def _is_strong_lexical_context(entry):
    try:
        score = float((entry or {}).get("score") or 0)
    except Exception:
        score = 0.0
    title_overlap = int((entry or {}).get("title_overlap") or 0)
    lexical_overlap = int((entry or {}).get("lexical_overlap") or 0)
    return bool((entry or {}).get("explicit")) or title_overlap >= 1 or lexical_overlap >= 2 or score >= 3


def _merge_rag_contexts(query, primary, lexical, limit_value):
    combined = []
    seen_titles = set()
    for order, entry in enumerate(list(lexical or []) + list(primary or [])):
        enriched = _enrich_rag_context_match(query, entry)
        title_key = str(enriched.get("title") or "").strip().casefold()
        if title_key and title_key in seen_titles:
            continue
        if title_key:
            seen_titles.add(title_key)
        combined.append((order, enriched))
    combined.sort(
        key=lambda item: (
            -int((item[1] or {}).get("title_overlap") or 0),
            -int((item[1] or {}).get("lexical_overlap") or 0),
            -float((item[1] or {}).get("score") or 0),
            item[0],
        )
    )
    return [entry for _, entry in combined[:max(1, limit_value)]]


# Who: Tim Buglaev
# When: 2026-06-19
# What: Added a title-only lexical merge path for successful Qdrant searches so short
#       person/entity questions can recover missed notes without scanning full vault bodies.
def _select_cache_title_contexts(query, limit_value):
    prompt_tags = {_normalize_candidate_tag(tag) for tag in _derive_tags_from_prompt(query)}
    explicit_titles = _extract_explicit_note_mentions(query)
    explicit_set = {title.strip().lower() for title in explicit_titles}
    with _notes_cache_lock:
        items = list(notes_data.items())
    entries = []
    for title, data in items:
        tags_raw = data.get("tags") or []
        normalized_tags = {_normalize_candidate_tag(tag) for tag in tags_raw if _normalize_candidate_tag(tag)}
        tag_overlap = {tag for tag in normalized_tags if tag in prompt_tags}
        title_lower = str(title or "").lower()
        is_explicit = title_lower in explicit_set
        title_overlap, _, lexical_overlap = _rag_context_overlap_meta(query, title, "", normalized_tags)
        if not is_explicit and not tag_overlap and title_overlap <= 0:
            continue
        raw_content = data.get("content") or ""
        cleaner = globals().get("_clean_note_text_for_rag")
        content = cleaner(raw_content) if callable(cleaner) else raw_content
        content = content or raw_content
        noise_reporter = globals().get("_rag_note_noise_report")
        if callable(noise_reporter) and noise_reporter(title, raw_content, tags=data.get("tags"), clean_text=content).get("excluded"):
            continue
        score = title_overlap * 3 + len(tag_overlap) + (8 if is_explicit else 0)
        snippet = _normalize_snippet_text(_generate_snippet(content, query))
        entries.append(
            {
                "title": title,
                "snippet": snippet or title,
                "tags": list(normalized_tags),
                "score": score,
                "explicit": is_explicit,
                "title_overlap": title_overlap,
                "body_overlap": 0,
                "lexical_overlap": lexical_overlap,
            }
        )
    entries.sort(
        key=lambda entry: (
            0 if entry.get("explicit") else 1,
            -int(entry.get("title_overlap") or 0),
            -float(entry.get("score") or 0),
            str(entry.get("title") or ""),
        )
    )
    return entries[:max(1, limit_value)]


# Who: Tim Buglaev
# When: 2026-06-22
# What: Preserve compatibility with legacy contextual-query callers while extracting only
#       the explicit current question; topic memory is now resolved before retrieval by the model.
def _rag_retrieval_focus_text(query):
    text = str(query or "").strip()
    current_marker = "Текущий вопрос пользователя:"
    if current_marker not in text:
        return text

    _, current_question = text.rsplit(current_marker, 1)
    return current_question.strip() or text


# Who: Tim Buglaev
# When: 2026-06-22
# What: Added the chat retrieval path that returns a bounded Qdrant candidate pool without
#       keyword gates or cache substitution; the model performs universal relevance selection.
def _select_rag_candidates(query, search_state=None):
    state = search_state if isinstance(search_state, dict) else {}
    state["context_source"] = "qdrant"
    _reload_notes_cache(reason="rag candidate selection")
    retrieval_query = str(query or "").strip()
    candidate_limit = _safe_int(os.environ.get("RAG_CHAT_CANDIDATE_LIMIT"), 20) or 20
    candidate_limit = max(1, min(candidate_limit, TOP_K_SEARCH, 40))
    candidates = _vector_search_notes(retrieval_query, candidate_limit, search_state=state)
    if candidates is None:
        state["context_source"] = "unavailable"
        return []
    state["candidate_count"] = len(candidates)
    return candidates


def _select_context(query, limit, search_state=None):
    state = search_state if isinstance(search_state, dict) else {}
    state.setdefault("context_source", "cache")
    _reload_notes_cache(reason="context selection")
    limit_value = _parse_limit_value(
        limit,
        default=RAG_CONTEXT_LIMIT,
        min_value=1,
        max_value=TOP_K_SEARCH,
        label="context_limit",
    )
    # Who: Tim Buglaev
    # When: 2026-06-21
    # What: Search a bounded candidate pool larger than the requested display limit, then
    #       apply relevance gating so the final result may contain from zero to five notes.
    retrieval_query = _rag_retrieval_focus_text(query)
    candidate_limit = min(TOP_K_SEARCH, max(limit_value, limit_value * 2))
    vector_results = None
    if use_qdrant and qdrant_service and not state.get("qdrant_failed"):
        vector_results = _vector_search_notes(retrieval_query, candidate_limit, search_state=state)
        if vector_results:
            state["context_source"] = state.get("context_source") or "qdrant"
            # Who: Tim Buglaev
            # When: 2026-06-19
            # What: Merge only strong title-level cache hits with ANN results on the hot path,
            #       avoiding full content scans for large vaults when Qdrant is healthy.
            lexical_results = [
                entry
                for entry in _select_cache_title_contexts(retrieval_query, candidate_limit)
                if _is_strong_lexical_context(entry)
            ]
            merged_contexts = _merge_rag_contexts(
                retrieval_query,
                vector_results,
                lexical_results,
                candidate_limit,
            )
            return _filter_rag_contexts(retrieval_query, merged_contexts, limit_value)
        elif state.get("qdrant_failed"):
            reason = state.get("qdrant_reason") or "unavailable"
            print(f"[WARNING] Qdrant search unavailable, fallback to cache ({reason}).")
        else:
            print("[WARNING] Qdrant не вернул результатов, используется резервный поиск по кэшу.")
    entries = []
    query_lower = retrieval_query.lower()
    tokens = [token for token in re.findall(r'\w+', query_lower) if token]
    prompt_tags = {_normalize_candidate_tag(tag) for tag in _derive_tags_from_prompt(retrieval_query)}
    explicit_titles = _extract_explicit_note_mentions(retrieval_query)
    explicit_set = {title.strip().lower() for title in explicit_titles}
    with _notes_cache_lock:
        items = list(notes_data.items())
    for title, data in items:
        # Who: Tim Buglaev
        # When: 2026-06-13
        # What: Score and summarize cache fallback with cleaned Markdown text so images,
        #       service blocks, and Obsidian syntax do not pollute RAG context.
        cleaner = globals().get("_clean_note_text_for_rag")
        raw_content = data.get("content") or ""
        content = cleaner(raw_content) if callable(cleaner) else raw_content
        content = content or raw_content
        # Who: Tim Buglaev
        # When: 2026-06-14
        # What: Keep cache fallback aligned with Qdrant indexing by skipping notes quarantined
        #       as repeated/tag-loop noise, preventing fallback retrieval from reintroducing them.
        noise_reporter = globals().get("_rag_note_noise_report")
        if callable(noise_reporter) and noise_reporter(title, raw_content, tags=data.get("tags"), clean_text=content).get("excluded"):
            continue
        content_lower = content.lower()
        title_lower = title.lower()

        # Считаем score: токены в контенте + токены в названии (с весом 2)
        score = sum(1 for token in tokens if token in content_lower)
        score += sum(2 for token in tokens if token in title_lower)
        # Who: Tim Buglaev
        # When: 2026-06-19
        # What: Add variant overlap only when exact cache scoring found nothing, preserving
        #       legacy score expectations while recovering inflected short Russian queries.
        title_overlap, body_overlap, lexical_overlap = _rag_context_overlap_meta(
            retrieval_query,
            title,
            content,
            data.get("tags") or [],
        )
        if score <= 0 and lexical_overlap > 0:
            score += title_overlap * 3 + body_overlap

        # Дополнительный бонус если полный запрос есть в названии
        if query_lower and query_lower in title_lower:
            score += 3
        tags_raw = data.get("tags") or []
        normalized_tags = {_normalize_candidate_tag(tag) for tag in tags_raw if _normalize_candidate_tag(tag)}
        tag_overlap = {tag for tag in normalized_tags if tag in prompt_tags}
        overlap_size = len(tag_overlap)
        if tag_overlap:
            score += 2 + len(tag_overlap)
        is_explicit = title_lower in explicit_set
        if is_explicit:
            score += 8

        snippet = _normalize_snippet_text(_generate_snippet(content, retrieval_query))
        if not is_explicit and overlap_size == 0 and score <= 0:
            continue
        entries.append((score, title, snippet, list(normalized_tags), is_explicit, overlap_size, title_overlap, body_overlap))
    entries.sort(key=lambda item: (0 if item[4] else 1, -item[5], -item[6], -item[0], item[1]))
    selected = []
    for score, title, snippet, tags, is_explicit, _, title_overlap, body_overlap in entries[:candidate_limit]:
        selected.append({
            "title": title,
            "snippet": snippet or title,
            "tags": list(tags),
            "score": score,
            "explicit": is_explicit,
            "title_overlap": title_overlap,
            "body_overlap": body_overlap,
            "lexical_overlap": title_overlap + body_overlap,
        })
    # Who: Tim Buglaev
    # When: 2026-06-21
    # What: Removed arbitrary cache filling and apply the same confidence gate as Qdrant,
    #       returning an empty context when the vault has no evidence for the question.
    return _filter_rag_contexts(retrieval_query, selected, limit_value)


def _build_warmup_context(limit=None, search_state=None):
    warmup_limit = limit if isinstance(limit, int) and limit > 0 else RAG_CONTEXT_LIMIT
    warmup_limit = max(1, min(warmup_limit, TOP_K_SEARCH, 15))
    contexts = _select_context("init", warmup_limit, search_state=search_state)
    with _notes_cache_lock:
        notes_count = len(notes_data)
        fallback_items = list(notes_data.items())[:warmup_limit]
    if not contexts and fallback_items:
        # Who: Tim Buglaev
        # When: 2026-06-13
        # What: Keep warmup fallback snippets consistent with the cleaned RAG context path.
        cleaner = globals().get("_clean_note_text_for_rag")
        contexts = [
            {
                "title": title,
                "snippet": _normalize_snippet_text(
                    _generate_snippet(
                        (cleaner(data.get("content", "")) if callable(cleaner) else data.get("content", ""))
                        or data.get("content", ""),
                        title,
                    )
                ),
                "tags": data.get("tags", []),
                "score": 0,
            }
            for title, data in fallback_items
        ]
    return contexts[:warmup_limit], notes_count


# Who: Tim Buglaev
# When: 2026-06-13
# What: Added grounded-RAG checks so random fallback contexts do not trigger hallucinated answers;
#       weak context now produces an explicit no-information response instead of model speculation.
_RAG_NO_INFORMATION_RESPONSE = (
    "В заметках нет достаточной информации, чтобы ответить на этот вопрос. "
    "Добавьте заметку с фактами по этой теме или уточните запрос."
)


def _rag_no_information_response(query=None, contexts=None):
    return _RAG_NO_INFORMATION_RESPONSE


def _rag_tokens(text, limit=64):
    extractor = globals().get("_extract_meaningful_tokens")
    if callable(extractor):
        return set(extractor(text or "", limit=limit, min_len=3))
    return {
        token.lower()
        for token in re.findall(r"[A-Za-z\u0400-\u04FF0-9]{3,}", text or "")
    }


def _tokens_have_soft_overlap(left_tokens, right_tokens):
    soft = globals().get("_has_soft_token_overlap")
    if callable(soft):
        return soft(left_tokens, right_tokens)
    for left in left_tokens or []:
        for right in right_tokens or []:
            if left == right:
                return True
            if len(left) >= 5 and len(right) >= 5 and left[:5] == right[:5]:
                return True
    return False


def _count_supported_tokens(source_tokens, target_tokens):
    count = 0
    target = set(target_tokens or [])
    for token in source_tokens or []:
        if token in target or _tokens_have_soft_overlap([token], target):
            count += 1
    return count


def _rag_context_is_usable(query, contexts):
    query_tokens = _rag_tokens(query, limit=32)
    if not query_tokens:
        return False
    prompt_tags = {_normalize_candidate_tag(tag) for tag in _derive_tags_from_prompt(query)}
    prompt_tags = {tag for tag in prompt_tags if tag}
    for entry in contexts or []:
        # Who: Tim Buglaev
        # When: 2026-06-22
        # What: Trust the single retrieval relevance contract instead of rejecting accepted
        #       one-term entity matches with an incompatible score/overlap threshold.
        if bool((entry or {}).get("retrieval_validated")):
            return True
        if bool((entry or {}).get("explicit")):
            return True
        title = (entry or {}).get("title") or ""
        snippet = (entry or {}).get("snippet") or ""
        tags = {
            _normalize_candidate_tag(tag)
            for tag in ((entry or {}).get("tags") or [])
            if _normalize_candidate_tag(tag)
        }
        context_tokens = _rag_tokens(" ".join([title, snippet, " ".join(tags)]), limit=96)
        if not context_tokens and not tags:
            continue
        try:
            score = float((entry or {}).get("score") or 0)
        except Exception:
            score = 0.0
        title_tokens = _rag_tokens(title, limit=24)
        title_overlap = _count_supported_tokens(query_tokens, title_tokens)
        token_overlap = _count_supported_tokens(query_tokens, context_tokens)
        tag_overlap = len(tags.intersection(prompt_tags))
        # Who: Tim Buglaev
        # When: 2026-06-19
        # What: Reuse retrieval lexical evidence during grounded-RAG validation so selected
        #       inflected-title contexts are not rejected before the model/fallback can answer.
        variant_title_overlap, _, variant_overlap = _rag_context_overlap_meta(query, title, snippet, tags)
        title_overlap = max(title_overlap, variant_title_overlap, int((entry or {}).get("title_overlap") or 0))
        token_overlap = max(token_overlap, variant_overlap, int((entry or {}).get("lexical_overlap") or 0))
        if title_overlap >= 1 and (score >= 0.62 or token_overlap >= 1):
            return True
        if token_overlap >= 2:
            return True
        if tag_overlap >= 1 and (token_overlap >= 1 or score >= 0.62):
            return True
    return False


# Who: Tim Buglaev
# When: 2026-06-13
# What: Added an extractive fallback for cases where the model refuses despite exact
#       high-signal context; the answer is built only from retrieved note snippets.
_RAG_QUERY_STOPWORDS = {
    "what", "known", "about", "tell", "please", "info", "information", "does", "work", "any", "some",
    "что", "известно", "про", "об", "о", "как", "какие", "какой", "какая", "какое",
    "есть", "данные", "информация", "ответь", "расскажи", "покажи", "найди", "вопрос",
    "насчет", "насчёт", "по", "ли", "там", "это", "эта", "этот", "этом", "у", "нас", "меня",
}


def _rag_critical_query_tokens(query):
    tokens = []
    seen = set()
    for raw in re.findall(r"[A-Za-z\u0400-\u04FF0-9][A-Za-z\u0400-\u04FF0-9_\-]*", query or ""):
        token = _rag_normalize_match_token(raw).strip("_-")
        if not token or token in _RAG_QUERY_STOPWORDS:
            continue
        if len(token) < 3 and not any(ch.isdigit() for ch in token):
            continue
        if token not in seen:
            seen.add(token)
            tokens.append(token)
    return tokens


# Who: Tim Buglaev
# When: 2026-06-21
# What: Added dynamic source confidence gating: lexical evidence keeps all genuinely
#       related notes up to the limit, while semantic-only retrieval keeps only a strong
#       best cluster and never pads the response with unrelated nearest neighbours.
_RAG_SEMANTIC_SCORE_FLOOR = 0.67
_RAG_STRONG_SEMANTIC_SCORE = 0.72
_RAG_STRONG_SEMANTIC_MAX_GAP = 0.04


def _rag_critical_context_overlap(query, entry):
    critical_tokens = _rag_critical_query_tokens(query)
    if not critical_tokens:
        return 0, 0

    title_variants = _rag_text_match_variants((entry or {}).get("title") or "", limit=60)
    body_text = " ".join(
        [
            str((entry or {}).get("snippet") or ""),
            " ".join(str(tag) for tag in ((entry or {}).get("tags") or [])),
        ]
    )
    body_variants = _rag_text_match_variants(body_text, limit=220)
    title_matches = 0
    body_matches = 0
    for token in critical_tokens:
        token_variants = _rag_token_match_variants(token)
        if token_variants.intersection(title_variants):
            title_matches += 1
        elif token_variants.intersection(body_variants):
            body_matches += 1
    return title_matches, body_matches


def _rag_semantic_score(entry):
    try:
        score = float((entry or {}).get("score") or 0)
    except (TypeError, ValueError):
        return 0.0
    return score if 0.0 < score <= 1.0 else 0.0


def _filter_rag_contexts(query, contexts, limit_value):
    max_contexts = max(1, min(int(limit_value or 1), TOP_K_SEARCH))
    grounded = []
    semantic_only = []
    for order, raw_entry in enumerate(contexts or []):
        entry = _enrich_rag_context_match(query, raw_entry)
        title_matches, body_matches = _rag_critical_context_overlap(query, entry)
        entry["critical_overlap"] = title_matches + body_matches
        if entry.get("explicit") or entry["critical_overlap"] > 0:
            grounded.append((order, entry))
            continue
        semantic_score = _rag_semantic_score(entry)
        if semantic_score > 0:
            semantic_only.append((semantic_score, order, entry))

    if grounded:
        selected = [entry for _, entry in grounded[:max_contexts]]
    else:
        semantic_only.sort(key=lambda item: (-item[0], item[1]))
        if not semantic_only or semantic_only[0][0] < _RAG_SEMANTIC_SCORE_FLOOR:
            selected = []
        elif semantic_only[0][0] < _RAG_STRONG_SEMANTIC_SCORE:
            selected = [semantic_only[0][2]]
        else:
            best_score = semantic_only[0][0]
            score_cutoff = max(
                _RAG_STRONG_SEMANTIC_SCORE,
                best_score - _RAG_STRONG_SEMANTIC_MAX_GAP,
            )
            selected = [
                entry
                for score, _, entry in semantic_only
                if score >= score_cutoff
            ][:max_contexts]

    logger.info(
        "RAG context relevance filter: candidates=%d grounded=%d semantic=%d selected=%d limit=%d",
        len(contexts or []),
        len(grounded),
        len(semantic_only),
        len(selected),
        max_contexts,
    )
    # Who: Tim Buglaev
    # When: 2026-06-22
    # What: Mark contexts accepted by the single retrieval relevance contract so downstream
    #       grounding checks do not apply a conflicting second set of score thresholds.
    for entry in selected:
        entry["retrieval_validated"] = True
    return selected


def _rag_entry_text(entry):
    return " ".join(
        [
            str((entry or {}).get("title") or ""),
            str((entry or {}).get("snippet") or ""),
            " ".join(str(tag) for tag in ((entry or {}).get("tags") or [])),
        ]
    )


def _rag_token_supported(token, text, text_tokens):
    if token in text:
        return True
    # Who: Tim Buglaev
    # When: 2026-06-19
    # What: Let extractive RAG fallback match Russian inflected/nickname-like variants
    #       against note titles while still requiring retrieved context evidence.
    token_variants = _rag_token_match_variants(token)
    if token_variants.intersection(_rag_text_match_variants(text, limit=220)):
        return True
    return _tokens_have_soft_overlap([token], text_tokens)


def _select_extractive_rag_entries(query, contexts, max_entries=2):
    critical_tokens = _rag_critical_query_tokens(query)
    if not critical_tokens:
        return []
    selected = []
    for entry in contexts or []:
        text = _rag_entry_text(entry).lower()
        if not text.strip():
            continue
        text_tokens = _rag_tokens(text, limit=160)
        matches = [token for token in critical_tokens if _rag_token_supported(token, text, text_tokens)]
        try:
            score = float((entry or {}).get("score") or 0)
        except Exception:
            score = 0.0
        strong_matches = [
            token for token in matches
            if any(ch.isdigit() for ch in token) or len(token) >= 5
        ]
        if len(matches) >= 2 or (strong_matches and score >= 0.72):
            selected.append((len(matches), score, entry))
    selected.sort(key=lambda item: (-item[0], -item[1], str((item[2] or {}).get("title") or "")))
    return [entry for _, _, entry in selected[:max(1, max_entries)]]


def _build_extractive_rag_answer(query, contexts):
    entries = _select_extractive_rag_entries(query, contexts)
    if not entries:
        return ""
    lines = []
    for entry in entries:
        title = str((entry or {}).get("title") or "").strip()
        snippet = _normalize_snippet_text((entry or {}).get("snippet") or title)
        if not snippet:
            continue
        # Who: Tim Buglaev
        # When: 2026-06-22
        # What: Remove an exact repeated title prefix from defensive fallback excerpts;
        #       older Qdrant payloads may remain title-prefixed until the next reindex.
        if title and snippet.casefold().startswith(title.casefold()):
            snippet = snippet[len(title):].lstrip(" :-—") or title
        if len(snippet) > 360:
            snippet = snippet[:357].rstrip() + "..."
        prefix = f"{title}: " if title else ""
        lines.append(f"- {prefix}{snippet}")
    if not lines:
        return ""
    return "По заметкам:\n" + "\n".join(lines)


def _sanitize_rag_response(query, contexts, response_text):
    response = (response_text or "").strip()
    if not _rag_context_is_usable(query, contexts):
        return _rag_no_information_response(query, contexts)
    if not response:
        return _build_extractive_rag_answer(query, contexts) or _rag_no_information_response(query, contexts)
    lowered = response.lower()
    no_info_markers = (
        "нет достаточной информации",
        "нет информации",
        "недостаточно данных",
        "not enough information",
        "no information",
    )
    if any(marker in lowered for marker in no_info_markers):
        return _build_extractive_rag_answer(query, contexts) or _rag_no_information_response(query, contexts)
    external_markers = (
        "в интернете",
        "по состоянию на",
        "актуальную информацию",
        "я не имею доступа",
        "как искусственный интеллект",
        "as an ai",
        "current information",
        "external sources",
    )
    if any(marker in lowered for marker in external_markers):
        return _rag_no_information_response(query, contexts)

    # Who: Tim Buglaev
    # When: 2026-06-13
    # What: Detect hedged/no-details model wording and replace it with grounded snippets
    #       when exact retrieved context exists, preventing mixed factual/speculative RAG answers.
    speculative_markers = (
        "могут относиться",
        "может относиться",
        "какому-то",
        "какой-то",
        "нет в предоставленном контексте",
        "нет в контексте",
        "не указано",
        "не указаны",
        "не содержит деталей",
        "specific details are not",
        "not provided in the context",
        "not in the provided context",
    )
    if any(marker in lowered for marker in speculative_markers):
        return _build_extractive_rag_answer(query, contexts) or _rag_no_information_response(query, contexts)

    answer_tokens = _rag_tokens(response, limit=96)
    context_tokens = set()
    for entry in contexts or []:
        context_tokens.update(
            _rag_tokens(
                " ".join(
                    [
                        (entry or {}).get("title") or "",
                        (entry or {}).get("snippet") or "",
                        " ".join((entry or {}).get("tags") or []),
                    ]
                ),
                limit=128,
            )
        )
    if len(answer_tokens) >= 8 and context_tokens:
        supported = _count_supported_tokens(answer_tokens, context_tokens)
        if supported / max(1, len(answer_tokens)) < 0.12:
            return _rag_no_information_response(query, contexts)
    return response


def _build_rag_prompt(query, contexts):
    max_contexts = max(1, RAG_CONTEXT_LIMIT)
    effective_contexts = (contexts or [])[:max_contexts]
    blocks = []
    for entry in effective_contexts:
        title = entry.get('title') or 'Безымянный фрагмент'
        snippet = _normalize_snippet_text(entry.get('snippet') or title)
        tags = entry.get('tags') or []
        tags_line = f"\nТеги: {', '.join(tags)}" if tags else ""
        blocks.append(f"- {title}:{tags_line}\n{snippet}")
    context_block = '\n\n'.join(blocks) if blocks else 'Контекст отсутствует.'
    return (
        'Ты - RAG-ассистент. Используй представленный контекст и сформируй ответ.\n\n'
        f"Контекст:\n{context_block}\n\n"
        f"Вопрос: {query}\n"
        'Ответ (используя контекст выше):'
    )


# Who: Tim Buglaev
# When: 2026-06-13
# What: Overrode the legacy RAG prompt with a stricter grounded-only prompt while preserving the
#       existing function name and API contract for LocalRAGModel.generate_answer.
def _build_rag_prompt(query, contexts):
    # Who: Tim Buglaev
    # When: 2026-06-22
    # What: Pass every already-bounded source to the model so displayed source links and
    #       answer evidence cannot diverge when callers request more than three notes.
    effective_contexts = list(contexts or [])[:TOP_K_SEARCH]
    blocks = []
    for entry in effective_contexts:
        title = entry.get("title") or "Безымянный фрагмент"
        snippet = _normalize_snippet_text(entry.get("snippet") or title)
        tags = entry.get("tags") or []
        tags_line = f"\nТеги: {', '.join(tags)}" if tags else ""
        blocks.append(f"- {title}:{tags_line}\n{snippet}")
    context_block = "\n\n".join(blocks) if blocks else "Контекст отсутствует."
    return (
        "Ты - RAG-ассистент для локальной базы заметок. Отвечай связно и естественно на русском языке. "
        "Сформулируй краткий вывод своими словами, не копируй и не повторяй фрагменты дословно. "
        "Отвечай только по фактам из контекста ниже. "
        "Не используй внешние знания, догадки, общие советы и актуальные данные из интернета. "
        "Если в контексте нет ответа, верни: \"В заметках нет достаточной информации, чтобы ответить на этот вопрос.\"\n\n"
        f"Контекст:\n{context_block}\n\n"
        f"Вопрос: {query}\n"
        "Ответ только по контексту:"
    )


def _normalize_tag_value(tag):
    if tag is None:
        return None
    value = str(tag).strip()
    if not value:
        return None
    return value.lstrip("#")


def _collect_context_tags(contexts):
    tags = []
    for entry in contexts or []:
        for tag in entry.get("tags") or []:
            normalized = _normalize_tag_value(tag)
            if normalized:
                tags.append(normalized)
    return tags


def _deduplicate_tags(tags):
    unique = []
    seen = set()
    for tag in tags or []:
        if not tag:
            continue
        normalized = str(tag).lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        unique.append(tag)
    return unique


_TAG_STOPWORDS = {
    # Английские стоп-слова
    "about", "note", "notes", "test", "please", "prompt", "request", "new",
    "this", "is", "that", "and", "with", "for", "those", "these", "now",
    "we", "my", "our", "your", "only", "here", "there", "the", "are",
    "was", "were", "been", "have", "has", "had", "will", "would", "could",
    "should", "may", "might", "can", "not", "but", "also", "just", "from",
    "into", "what", "when", "where", "how", "who", "which", "some", "any",
    "all", "each", "every", "both", "more", "most", "other", "than",
    # Русские стоп-слова: местоимения
    "я", "мы", "ты", "вы", "они", "он", "она", "оно", "его", "её", "их",
    "ей", "ему", "им", "нас", "нам", "вас", "вам", "себя", "себе", "собой",
    "сам", "сама", "само", "сами", "свой", "свою", "своё", "свои",
    # Русские стоп-слова: предлоги и союзы
    "на", "в", "во", "по", "из", "от", "до", "за", "при", "об", "под",
    "над", "без", "для", "через", "между", "после", "перед", "около",
    "что", "как", "где", "когда", "зачем", "почему", "чтобы", "если",
    "или", "но", "да", "нет", "ни", "не", "ли", "же", "бы", "то",
    # Русские стоп-слова: указательные и определительные
    "это", "этот", "эта", "эти", "этого", "этой", "этих", "тот", "та", "те",
    "того", "той", "тех", "такой", "такая", "такое", "такие", "весь", "вся", "всё", "все",
    # Русские стоп-слова: наречия
    "здесь", "тут", "сейчас", "теперь", "тогда", "потом", "там", "туда",
    "очень", "уже", "ещё", "еще", "тоже", "также", "только", "просто",
    "совсем", "вообще", "наверное", "может", "можно", "нужно", "надо",
    "необходимо", "именно", "срочно",
    "полностью", "полноценную", "полноценный", "полноценная", "полноценное",
    "настоящий", "настоящая", "настоящее", "высший", "высшая", "высшее",
    # Русские стоп-слова: глаголы (частотные служебные)
    "будем", "будет", "будут", "буду", "будешь", "будете",
    "быть", "был", "была", "было", "были", "есть", "нет",
    "делать", "делаем", "делаю", "делает", "делают",
    "создай", "сделай", "напиши", "создать", "сделайте", "сделать",
    "сделали", "сделало", "сделала",
    "добавить", "добавим", "добавили", "добавляем",
    "стать", "стал", "стала", "стало", "стали",
    "иметь", "имеет", "имеют", "хотеть", "хочу", "хотим", "хочет",
    "мочь", "могу", "можем", "может", "могут",
    "выполнять", "выполняет", "выполняем",
    "использовать", "используем", "используется",
    "работать", "работает", "работаем",
    "изменить", "изменяем", "изменяет",
    # Русские стоп-слова: прилагательные (частотные)
    "большой", "большая", "большое", "большие", "большим", "большого",
    "хороший", "хорошая", "хорошее", "хорошие",
    "новый", "новая", "новое", "новые",
    "другой", "другая", "другое", "другие",
    # Русские стоп-слова: существительные (служебные) и склонённые формы
    "заметка", "заметку", "заметке", "заметки", "запрос", "новая", "новый",
    "пожалуйста", "прошуу", "тест",
    # Частые склонённые формы — плохие теги
    "систему", "системы", "систем", "системе", "системой",
    "партнера", "партнеров", "партнёра",
    "руками", "приоритет",
}


def _filter_tags(tags):
    """Оставляет только осмысленные теги, нормализуя и удаляя стоп-слова."""
    filtered = []
    for tag in tags or []:
        norm = _normalize_candidate_tag(tag)
        if norm:
            filtered.append(norm)
    return _deduplicate_tags(filtered)


def _derive_tags_from_prompt(prompt, limit=4):
    prompt_lower = (prompt or "").lower()
    tags = []

    # 1. Сначала ищем совпадения с СУЩЕСТВУЮЩИМИ тегами из notes_data
    existing_tags = set()
    try:
        with _notes_cache_lock:
            for data in notes_data.values():
                for tag in (data or {}).get("tags") or []:
                    norm = _normalize_candidate_tag(tag)
                    if norm:
                        existing_tags.add(norm)
    except Exception:
        pass

    for existing_tag in sorted(existing_tags):
        if len(tags) >= max(1, limit):
            break
        # Who: Tim Buglaev
        # When: 2026-03-09
        # What: Skip low-signal ordinal/plan-like tags even if they already exist in vault metadata, so strict
        #       existing-tag mode cannot reintroduce noisy tags from mixed-quality historical notes.
        if _is_noise_tag_token(existing_tag):
            continue
        # Проверяем, что существующий тег встречается в тексте промпта
        tag_pattern = existing_tag.replace("_", " ")
        if tag_pattern in prompt_lower or existing_tag in prompt_lower:
            if existing_tag not in tags:
                tags.append(existing_tag)

    # Who: Tim Buglaev
    # When: 2026-03-09
    # What: Added existing-first tag behavior to avoid inventing noisy tags when relevant tags already exist
    #       in the vault, reducing metadata drift in quick note capture flow.
    if STRICT_EXISTING_TAGS:
        return tags[:max(1, limit)]

    # 2. Если не хватает тегов, добавляем новые из значимых слов (только существительные/ключевые)
    # Но только если это действительно значимые слова, а не склонённые формы
    if len(tags) < max(1, limit):
        for token in _extract_meaningful_tokens(prompt_lower, limit=max(1, limit) * 3, min_len=4):
            if len(tags) >= max(1, limit):
                break
            normalized = _normalize_candidate_tag(token)
            if not normalized:
                continue
            if normalized not in tags:
                tags.append(normalized)

    return tags


def _derive_tag_from_prompt(prompt):
    derived = _derive_tags_from_prompt(prompt, limit=1)
    return derived[0] if derived else "note"


def _ensure_tags_in_text(content, tags):
    if not tags:
        return content
    missing = [tag for tag in tags if f"#{tag}" not in content]
    if not missing:
        return content
    tag_line = " ".join(f"#{tag}" for tag in tags)
    separator = "\n\n" if content and not content.endswith("\n") else "\n"
    return f"{content}{separator}Теги: {tag_line}"


def _ensure_links_in_text(content, contexts):
    if not contexts:
        return content
    missing_links = []
    for entry in contexts:
        title = (entry or {}).get("title")
        if not title:
            continue
        link = f"[[{title}]]"
        if link not in content and link not in missing_links:
            missing_links.append(link)
    if not missing_links:
        return content
    links_line = ", ".join(missing_links)
    separator = "\n\n" if content and not content.endswith("\n") else "\n"
    return f"{content}{separator}Связанные: {links_line}"


def _strip_question_lines(text):
    cleaned_lines = []
    for line in (text or "").splitlines():
        stripped = line.strip()
        if not stripped:
            cleaned_lines.append(line)
            continue
        if stripped.endswith("?") and len(stripped) < 120:
            continue
        cleaned_lines.append(line)
    cleaned = "\n".join(cleaned_lines).strip()
    return cleaned


# Who: Tim Buglaev
# When: 2026-03-09
# What: Added post-generation cleanup helpers to remove inline markdown noise ("###"), collapse near-duplicate
#       paraphrase lines, and drop truncated tail fragments that degrade note readability.
def _strip_inline_heading_noise(text):
    if not text:
        return ""
    cleaned = re.sub(r"(?im)\s*#{3,}\s*$", "", text)
    cleaned = re.sub(r"\s*#{3,}\s*", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _dedupe_near_duplicate_lines(text, similarity_threshold=0.90):
    if not text:
        return ""
    unique_lines = []
    normalized_lines = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        normalized = re.sub(r"[\W_]+", "", line.lower())
        if not normalized:
            continue
        duplicate = False
        for prev in normalized_lines:
            if normalized == prev:
                duplicate = True
                break
            if len(normalized) >= 24 and len(prev) >= 24:
                if difflib.SequenceMatcher(None, normalized, prev).ratio() >= similarity_threshold:
                    duplicate = True
                    break
        if duplicate:
            continue
        unique_lines.append(line)
        normalized_lines.append(normalized)
    return "\n".join(unique_lines).strip()


def _drop_truncated_tail_line(text):
    if not text:
        return ""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) < 2:
        return text.strip()
    last = lines[-1]
    prev = lines[-2]
    if re.search(r"[.!?…]$", last):
        return "\n".join(lines).strip()
    normalized_last = re.sub(r"\s+", " ", last.lower())
    normalized_prev = re.sub(r"\s+", " ", prev.lower())
    if normalized_prev.startswith(normalized_last):
        lines = lines[:-1]
    elif len(last.split()) <= 6:
        lines = lines[:-1]
    return "\n".join(lines).strip()


# Who: Tim Buglaev
# When: 2026-03-10
# What: Added sentence-level body cleanup helpers to remove inline "Теги:/Tags:" artifacts, strip sentence-count
#       variant markers (e.g., "(2 предложений)"), drop leading inline hashtag prefixes, skip generic
#       restatements, deduplicate repeated paraphrases, and trim incomplete tails from long generations.
def _strip_inline_tag_fragments(text):
    if not text:
        return ""
    cleaned = re.sub(
        r"(?i)\b(?:tags?|теги)\s*:\s*(?:[#\w\u0400-\u04FF\-]+(?:\s*,\s*[#\w\u0400-\u04FF\-]+){0,12})",
        " ",
        text,
    )
    # Who: Tim Buglaev
    # When: 2026-06-15
    # What: Treat slash-based Obsidian tag paths as tag fragments during body cleanup.
    cleaned = re.sub(
        r"(?i)\b(?:tags?|С‚РµРіРё)\s*:\s*(?:[#\w/\u0400-\u04FF\-]+(?:\s*,\s*[#\w/\u0400-\u04FF\-]+){0,12})",
        " ",
        cleaned,
    )
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    return cleaned.strip()


def _strip_inline_hashtag_prefixes(text):
    if not text:
        return ""
    cleaned = re.sub(
        r"(?im)^(?:#[\w\-\u0400-\u04FF]+\s+){1,12}(?=[A-Za-zА-Яа-яЁё0-9])",
        "",
        text,
    )
    # Who: Tim Buglaev
    # When: 2026-06-15
    # What: Add a second cleanup pass for slash-based Obsidian tags without
    #       rewriting the legacy mojibake-heavy regex above.
    cleaned = re.sub(
        r"(?im)^(?:#[\w\-/\u0400-\u04FF]+\s+){1,12}(?=\S)",
        "",
        cleaned,
    )
    return cleaned.strip()


def _strip_sentence_count_variants(text):
    if not text:
        return ""
    marker_pattern = re.compile(
        r"\(\s*\d+\s+(?:предложен(?:ие|ия|ий)|sentences?)\s*\)",
        re.IGNORECASE,
    )
    matches = list(marker_pattern.finditer(text))
    if len(matches) >= 2:
        first_segment = text[:matches[0].start()].strip()
        if first_segment:
            return first_segment
    cleaned = marker_pattern.sub(" ", text)
    cleaned = re.sub(r"\s{2,}", " ", cleaned)
    return cleaned.strip()


def _dedupe_near_duplicate_sentences(text, similarity_threshold=0.88):
    if not text:
        return ""
    normalized_text = re.sub(r"\s+", " ", text).strip()
    if not normalized_text:
        return ""
    parts = [part.strip() for part in re.split(r"(?<=[.!?])\s+", normalized_text) if part.strip()]
    if not parts:
        return ""
    generic_user_sentence_pattern = re.compile(
        r"(?i)^(?:пользователь|user)\s+"
        r"(?:запросил|просит|хочет|попросил|уточнил|добавил|requested|asks?|wants?)\b"
    )
    kept = []
    normalized_kept = []
    for part in parts:
        if generic_user_sentence_pattern.match(part) and kept:
            continue
        normalized = re.sub(r"[\W_]+", "", part.lower())
        if not normalized:
            continue
        duplicate = False
        for prev in normalized_kept:
            if normalized == prev:
                duplicate = True
                break
            if len(normalized) >= 30 and len(prev) >= 30:
                if difflib.SequenceMatcher(None, normalized, prev).ratio() >= similarity_threshold:
                    duplicate = True
                    break
        if duplicate:
            continue
        kept.append(part)
        normalized_kept.append(normalized)
    if not kept:
        return ""
    last = kept[-1].strip()
    if last and not re.search(r"[.!?…]$", last):
        tail_tokens = re.findall(r"[A-Za-zА-Яа-яЁё0-9]+", last.lower())
        tail_endings = {
            "и", "в", "на", "по", "с", "к", "у", "из", "за", "для", "при", "от", "до", "о", "об",
            "как", "что", "чтобы", "или", "но", "а", "либо",
        }
        if tail_tokens and (len(tail_tokens) <= 10 or tail_tokens[-1] in tail_endings):
            kept = kept[:-1]
    return " ".join(kept).strip()


def _strip_duplicate_markdown_blocks(text):
    """Удаляет дублирующиеся markdown блоки (обернутые в тройные обратные кавычки)"""
    if not text:
        return text

    # Проверяем наличие markdown блоков
    if '```markdown' not in text and '```' not in text:
        return text

    # Разбиваем текст на строки
    lines = text.split('\n')

    # Удаляем markdown блоки в начале и в конце
    cleaned_lines = []
    skip_mode = False

    for i, line in enumerate(lines):
        stripped = line.strip()

        # Обнаружение начала markdown блока
        if stripped.startswith('```'):
            # Если это первая или последняя строка с ```, пропускаем её
            if i == 0 or i == len(lines) - 1:
                skip_mode = not skip_mode
                continue
            # Если внутри текста - переключаем режим
            skip_mode = not skip_mode
            continue

        # Если не в режиме пропуска, добавляем строку
        if not skip_mode:
            cleaned_lines.append(line)

    return '\n'.join(cleaned_lines).strip()


def _collapse_duplicate_headings(text):
    if not text:
        return text
    seen = set()
    cleaned_lines = []
    heading_re = re.compile(r"^(#{1,6})\s*(.+)$")
    for line in text.splitlines():
        match = heading_re.match(line.strip())
        if match:
            heading_text = match.group(2).strip().lower()
            if heading_text in seen:
                continue
            seen.add(heading_text)
        cleaned_lines.append(line)
    return "\n".join(cleaned_lines).strip()


def _strip_section_by_heading(text, heading):
    if not text or not heading:
        return text
    pattern = rf"(?im)^##+\s*{re.escape(heading)}.*?(?=^##\s|\Z)"
    return re.sub(pattern, "", text, flags=re.S | re.M).strip()


# Who: Tim Buglaev
# When: 2026-03-10
# What: Extended generated-note sanitization pipeline to remove inline tag fragments and collapse near-duplicate
#       sentences in long single-line outputs, including sentence-count artifacts like "(2 предложений)".
def _sanitize_generated_note_body(prompt_text, generated_text):
    # Who: Tim Buglaev
    # When: 2026-06-13
    # What: Remove generated image/service artifacts while preserving Obsidian links and tags
    #       needed for the final note notation.
    output_cleaner = globals().get("_clean_generated_note_output")
    cleaned = _normalize_user_note_text(generated_text or "")
    if callable(output_cleaner):
        cleaned = output_cleaner(cleaned)
    if not cleaned:
        return ""
    cleaned = _strip_existing_related_section(cleaned)
    cleaned = re.sub(r"(?im)^(tags?|теги:?)\s*:?.*$", "", cleaned)
    cleaned = re.sub(r"(?im)^связанные:\s.*$", "", cleaned)
    cleaned = re.sub(r"(?im)^\[[a-z0-9_\-]+\]\s*(локальный ответ на|local answer to)\s*:?\s*", "", cleaned)
    cleaned = _strip_question_lines(cleaned)
    cleaned = _strip_inline_heading_noise(cleaned)
    cleaned = _strip_inline_tag_fragments(cleaned)
    cleaned = _strip_inline_hashtag_prefixes(cleaned)
    cleaned = _strip_sentence_count_variants(cleaned)
    cleaned = _dedupe_near_duplicate_lines(cleaned)
    cleaned = _drop_truncated_tail_line(cleaned)
    cleaned = _dedupe_near_duplicate_sentences(cleaned)
    cleaned = _remove_stopword_hashtags(cleaned)
    cleaned = _strip_duplicate_markdown_blocks(cleaned)
    cleaned = _collapse_duplicate_headings(cleaned)
    return cleaned.strip()


def _dedupe_text_lines(lines):
    result = []
    seen = set()
    for line in lines or []:
        normalized = line.strip().lower()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(line.strip())
    return result


def _normalize_user_note_text(text):
    """
    Очищает пользовательский ввод: убирает пустые строки и повторяющиеся абзацы.
    Сохраняет исходную формулировку без генерации новых требований.
    """
    if text is None:
        return ""
    paragraphs = []
    seen = set()
    for raw_block in re.split(r"\n\s*\n", str(text).strip()):
        cleaned = re.sub(r"\s+", " ", raw_block).strip()
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        paragraphs.append(raw_block.strip())
    return "\n\n".join(paragraphs).strip()


def _format_plan_item(title, snippet=None):
    if not title:
        return None
    snippet_text = _normalize_snippet_text(snippet or "")
    if snippet_text:
        return f"- [[{title}]] — {snippet_text}"
    return f"- [[{title}]]"


