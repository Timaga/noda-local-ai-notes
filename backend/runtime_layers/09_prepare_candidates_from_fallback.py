# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted large module content into ordered architecture parts while preserving execution
#       order and public API through a thin facade loader to keep file size under 600 lines.

def _prepare_candidates_from_fallback(vector, current_title, content):
    if vector is None:
        return []
    base_vector_size = len(vector) if hasattr(vector, "__len__") else _get_vector_size()
    try:
        _reload_notes_cache(reason="autolinker-fallback")
    except Exception:
        pass
    with _notes_cache_lock:
        items = list(notes_data.items())
    raw = []
    for title, data in items:
        if str(title).strip().lower() == str(current_title).strip().lower():
            continue
        # Who: Tim Buglaev
        # When: 2026-06-15
        # What: Compare fallback similarity against the same compact service-card index text
        #       used by Qdrant, keeping ANN outages from reintroducing raw Markdown noise.
        cleaner = globals().get("_clean_note_text_for_rag")
        index_builder = globals().get("_build_note_index_text")
        raw_content = data.get("content") or ""
        clean_text = cleaner(raw_content) if callable(cleaner) else raw_content
        index_text = (
            index_builder(title, raw_content, tags=data.get("tags"))
            if callable(index_builder)
            else clean_text
        )
        # Who: Tim Buglaev
        # When: 2026-06-14
        # What: Exclude quarantined repeated/tag-loop notes from fallback vector comparison so
        #       ANN outages cannot resurrect noisy metadata or links from local cache.
        noise_reporter = globals().get("_rag_note_noise_report")
        if callable(noise_reporter) and noise_reporter(title, raw_content, tags=data.get("tags"), clean_text=clean_text).get("excluded"):
            continue
        other_vector = generate_embedding(index_text or raw_content, vector_size=base_vector_size)
        score = _cosine_similarity(vector, other_vector)
        raw.append({
            "title": title,
            "score": score,
            "tags": data.get("tags") or [],
            "snippet": _generate_snippet(index_text, content),
        })
    raw.sort(key=lambda x: (-x["score"], x["title"]))
    return _normalize_similarity_candidates(raw, current_title)


# Who: Tim Buglaev
# When: 2026-03-09
# What: Added prompt-keyword refinement helpers to separate broad domain words (e.g., CRM) from specific
#       intent words (e.g., calendar), reducing unrelated note links when semantic search falls back.
_GENERIC_PROMPT_KEYWORDS = {
    "crm",
    "админка",
    "админки",
    "админке",
    "админку",
    "админпанель",
    "панель",
    "система",
    "системы",
    "систему",
    "модуль",
    "задача",
    "задачи",
    "функция",
    "функции",
    "сообщение",
    "сообщения",
    "сообщений",
    "пользователь",
    "пользователя",
    "пользователей",
    "пользователи",
    "пользовтаель",
    "юзер",
    "юзера",
    "юзеры",
    "оператор",
    "оператора",
    "операторы",
    "операторов",
    "оператору",
    "оператором",
    "операторам",
    "операторами",
    "клиент",
    "клиента",
    "клиенты",
    "клиентов",
    "клиенту",
    "клиентами",
    "центр",
    "центра",
    "центру",
    "центром",
    "управление",
    "управления",
    "компания",
    "компании",
    "компанию",
    "единый",
    "единую",
    "данные",
    "настройки",
    "настройках",
    "ввод",
    "ввода",
    "вводить",
}


# Who: Tim Buglaev
# When: 2026-03-10
# What: Added stem-based generic keyword filtering so inflected forms like "админку"/"систему" are treated
#       as broad domain terms and do not inflate related-link overlap scores.
_GENERIC_PROMPT_KEYWORD_STEMS = {
    keyword[:5]
    for keyword in _GENERIC_PROMPT_KEYWORDS
    if isinstance(keyword, str) and len(keyword) >= 5
}


def _is_generic_prompt_keyword(token):
    cleaned = (token or "").strip().lower()
    if not cleaned:
        return False
    if cleaned in _GENERIC_PROMPT_KEYWORDS:
        return True
    if len(cleaned) >= 5 and cleaned[:5] in _GENERIC_PROMPT_KEYWORD_STEMS:
        return True
    return False


# Who: Tim Buglaev
# When: 2026-03-10
# What: Kept generic-keyword filtering for long prompts but preserved full keyword sets for short prompts,
#       preventing regressions where broad notes (e.g., "для админки") lost all related links.
def _select_effective_prompt_keywords(tokens):
    normalized = []
    for token in tokens or []:
        cleaned = (token or "").strip().lower()
        if cleaned and cleaned not in normalized:
            normalized.append(cleaned)
    if not normalized:
        return []
    if len(normalized) <= 4:
        return normalized
    specific = [
        token
        for token in normalized
        if not _is_generic_prompt_keyword(token) and len(token) >= 4
    ]
    return specific or normalized


def _compute_prompt_title_overlap(title_tokens, prompt_keywords):
    overlap = len(title_tokens.intersection(prompt_keywords))
    if overlap > 0:
        return overlap
    if prompt_keywords and _has_soft_token_overlap(title_tokens, prompt_keywords):
        return 1
    return 0


def _is_context_grounded_by_prompt(entry, prompt_keywords, prompt_tags):
    if bool((entry or {}).get("explicit")):
        return True
    title = (entry or {}).get("title") or ""
    title_tokens = set(_extract_meaningful_tokens(title, limit=12, min_len=3))
    title_overlap = _compute_prompt_title_overlap(title_tokens, prompt_keywords)
    try:
        score = float((entry or {}).get("score") or 0)
    except Exception:
        score = 0.0
    # Who: Tim Buglaev
    # When: 2026-06-14
    # What: Align context grounding with strict metadata gating so weak one-word title
    #       overlap can no longer leak unrelated context into generated notes.
    if _is_strong_metadata_candidate(entry):
        return True
    if title_overlap > 0:
        if score <= 0 and 0 < len(title_tokens) <= 3:
            return True
    context_tags = {
        _normalize_candidate_tag(tag)
        for tag in ((entry or {}).get("tags") or [])
        if _normalize_candidate_tag(tag)
    }
    tag_overlap = len(context_tags.intersection(prompt_tags))
    return tag_overlap >= 2 and (score >= 0.78 or score >= 3)


# Who: Tim Buglaev
# When: 2026-06-13
# What: Centralized strong-candidate gating for links/tags so weak semantic neighbors cannot
#       leak unrelated metadata into generated notes; explicit mentions remain always allowed.
def _is_strong_metadata_candidate(item):
    if bool((item or {}).get("explicit")):
        return True
    try:
        score = float((item or {}).get("score") or 0)
    except Exception:
        score = 0.0
    title_overlap = int((item or {}).get("title_overlap") or 0)
    tag_overlap = int((item or {}).get("overlap") or 0)
    # Who: Tim Buglaev
    # When: 2026-06-14
    # What: Require two independent metadata signals for non-explicit single-title matches so
    #       broad words like "operator" cannot import unrelated links/tags from nearby clusters.
    if title_overlap >= 2 and (score >= 0.62 or score >= 2):
        return True
    if title_overlap >= 1 and tag_overlap >= 1 and (score >= 0.74 or score >= 3):
        return True
    if tag_overlap >= 2 and (score >= 0.78 or score >= 3):
        return True
    if tag_overlap >= 1 and title_overlap >= 1 and score >= 0.88:
        return True
    # Who: Tim Buglaev
    # When: 2026-06-14
    # What: Allow very high-similarity single-overlap candidates to contribute metadata
    #       so useful close neighbors keep tags while weak distant clusters remain blocked.
    if tag_overlap >= 1 and score >= 0.90:
        return True
    return False


def _collect_existing_tag_pool():
    existing = set()
    try:
        with _notes_cache_lock:
            snapshot = list(notes_data.values())
    except Exception:
        snapshot = []
    for data in snapshot:
        noise_reporter = globals().get("_rag_note_noise_report")
        if callable(noise_reporter) and noise_reporter(
            data.get("filename") or "",
            data.get("content") or "",
            tags=data.get("tags"),
        ).get("excluded"):
            continue
        for raw_tag in (data or {}).get("tags") or []:
            normalized = _normalize_candidate_tag(raw_tag)
            if normalized:
                existing.add(normalized)
    return existing


def _filter_candidates_by_prompt(candidates, prompt_tags, explicit_mentions, prompt_keywords=None):
    filtered = []
    explicit_lower = {title.strip().lower() for title in explicit_mentions or []}
    normalized_prompt_tags = {tag for tag in prompt_tags or [] if tag}
    normalized_prompt_keywords = {
        token
        for token in _select_effective_prompt_keywords(prompt_keywords or [])
        if token
    }
    try:
        with _notes_cache_lock:
            known_titles = {title.strip().lower() for title in notes_data.keys()}
    except Exception:
        known_titles = set()
    for item in candidates or []:
        title = item.get("title")
        if not title:
            continue
        with _notes_cache_lock:
            note_data = dict(notes_data.get(title) or {})
        noise_reporter = globals().get("_rag_note_noise_report")
        if callable(noise_reporter) and note_data:
            raw_content = note_data.get("content") or ""
            if noise_reporter(title, raw_content, tags=note_data.get("tags")).get("excluded"):
                continue
        if known_titles and title.strip().lower() not in known_titles:
            continue
        normalized_tags = []
        for tag in item.get("tags") or []:
            norm = _normalize_candidate_tag(tag)
            if norm and norm not in normalized_tags:
                normalized_tags.append(norm)
        score = float(item.get("score") or 0)
        title_lower = title.strip().lower()
        is_explicit = title_lower in explicit_lower
        overlap_size = len({tag for tag in normalized_tags if tag in normalized_prompt_tags})
        title_tokens = set(_extract_meaningful_tokens(title, limit=12, min_len=3))
        title_overlap = _compute_prompt_title_overlap(title_tokens, normalized_prompt_keywords)
        if is_explicit:
            score = max(score, 1.0)
        else:
            # Who: Tim Buglaev
            # When: 2026-03-09
            # What: Tightened non-explicit candidate gating by requiring either title-keyword overlap or
            #       stronger multi-tag overlap; this blocks weak single-tag bleed-through into context links.
            if normalized_prompt_keywords:
                if title_overlap == 0 and overlap_size < 2:
                    continue
                min_score = 0.58 if title_overlap > 0 else 0.74
            elif normalized_prompt_tags and overlap_size == 0:
                continue
            elif normalized_prompt_tags and overlap_size < 2:
                min_score = 0.70
            else:
                min_score = max(0.50, SIM_THRESHOLD)
            if score < min_score:
                continue
        filtered.append(
            {
                "title": title,
                "score": score,
                "tags": normalized_tags,
                "explicit": is_explicit,
                "overlap": overlap_size,
                "title_overlap": title_overlap,
            }
        )
    filtered.sort(
        key=lambda item: (
            0 if item.get("explicit") else 1,
            -item.get("title_overlap", 0),
            -item.get("overlap", 0),
            -item["score"],
            item["title"].lower(),
        )
    )
    return filtered


def _gather_tags_from_mentions(mentions):
    mention_tags = []
    try:
        with _notes_cache_lock:
            snapshot = dict(notes_data)
    except Exception:
        snapshot = {}
    for title in mentions or []:
        data = snapshot.get(title) or {}
        for tag in data.get("tags") or []:
            norm = _normalize_candidate_tag(tag)
            if norm and norm not in mention_tags:
                mention_tags.append(norm)
    return mention_tags


def _collect_similarity_candidates(vector, current_title, content, prompt_text=None):
    prompt_tags = set()
    prompt_keywords = set()
    explicit_mentions = []
    if prompt_text:
        prompt_tags = {_normalize_candidate_tag(tag) for tag in _derive_tags_from_prompt(prompt_text)}
        prompt_keywords = set(_select_effective_prompt_keywords(_extract_prompt_keywords(prompt_text, limit=12)))
        explicit_mentions = _extract_explicit_note_mentions(prompt_text)
    candidates = []
    if _qdrant_enabled():
        try:
            results = qdrant_service.search_similar(vector, top_k=TOP_K_SEARCH)
            candidates = _prepare_candidates_from_qdrant(results, current_title)
        except Exception as exc:
            logger.warning("Qdrant similarity search failed, switching to fallback: %s", exc)
    if not candidates:
        candidates = _prepare_candidates_from_fallback(vector, current_title, content)
    filtered = _filter_candidates_by_prompt(candidates, prompt_tags, explicit_mentions, prompt_keywords)
    if explicit_mentions:
        existing = {(item or {}).get("title", "").strip().lower() for item in filtered}
        missing_explicit = []
        for raw_title in explicit_mentions:
            try:
                normalized = (raw_title or "").strip().lower()
            except Exception:
                normalized = ""
            if not normalized or normalized in existing:
                continue
            missing_explicit.append(raw_title)
        if missing_explicit:
            try:
                with _notes_cache_lock:
                    snapshot = dict(notes_data)
            except Exception:
                snapshot = {}
            prompt_overlap = len(prompt_tags)
            for raw_title in missing_explicit:
                data = snapshot.get(raw_title) or {}
                title_tokens = set(_extract_meaningful_tokens(raw_title, limit=12, min_len=3))
                filtered.append({
                    "title": raw_title,
                    "score": 1.0,
                    "tags": data.get("tags") or [],
                    "explicit": True,
                    "overlap": prompt_overlap,
                    "title_overlap": _compute_prompt_title_overlap(title_tokens, prompt_keywords),
                    "snippet": _generate_snippet(
                        (
                            _clean_note_text_for_rag(data.get("content") or "")
                            if "_clean_note_text_for_rag" in globals()
                            else data.get("content") or ""
                        ),
                        prompt_text or "",
                    ),
                })
            filtered.sort(
                key=lambda item: (
                    0 if item.get("explicit") else 1,
                    -item.get("title_overlap", 0),
                    -item.get("overlap", 0),
                    -float(item.get("score") or 0),
                    (item.get("title") or "").lower(),
                )
            )
    return filtered


# Who: Tim Buglaev
# When: 2026-03-09
# What: Added related-link family deduplication so auto-numbered note clones (e.g., "Topic 1/2/3") collapse to a
#       single representative link, reducing noisy duplicate backlinks in generated note metadata.
def _related_link_family_key(title):
    normalized = re.sub(r"\s+", " ", str(title or "").strip())
    if not normalized:
        return ""
    base = re.sub(r"\s+[1-9]\d?$", "", normalized)
    base_tokens = re.findall(r"[A-Za-zА-Яа-яЁё]{3,}", base)
    if base and len(base_tokens) >= 2:
        return base.lower()
    return normalized.lower()


def _dedupe_related_link_titles(titles, max_links):
    deduped = []
    seen_exact = set()
    seen_family = set()
    for raw_title in titles or []:
        title = re.sub(r"\s+", " ", str(raw_title or "").strip())
        if not title:
            continue
        title_key = title.lower()
        if title_key in seen_exact:
            continue
        family_key = _related_link_family_key(title)
        if family_key and family_key in seen_family:
            continue
        seen_exact.add(title_key)
        if family_key:
            seen_family.add(family_key)
        deduped.append(title)
        if max_links > 0 and len(deduped) >= max_links:
            break
    return deduped


def _select_related_links(candidates, prompt_text=None):
    if not candidates:
        return []
    max_links = min(MAX_LINKS, 15) if MAX_LINKS > 0 else 0
    if max_links <= 0:
        return []
    explicit_links = [item["title"] for item in candidates if item.get("explicit")]
    prompt_keywords = (
        set(_select_effective_prompt_keywords(_extract_prompt_keywords(prompt_text, limit=12)))
        if prompt_text
        else set()
    )
    links = []
    if explicit_links:
        links.extend(explicit_links)
        for item in candidates:
            if item.get("explicit"):
                continue
            if not _is_strong_metadata_candidate(item):
                continue
            if prompt_keywords and item.get("title_overlap", 0) <= 0 and item.get("overlap", 0) < 2:
                continue
            if item.get("overlap", 0) >= 2 and float(item.get("score") or 0) >= 0.78:
                links.append(item["title"])
                continue
            if item.get("title_overlap", 0) >= 1 and float(item.get("score") or 0) >= 0.62:
                links.append(item["title"])
    else:
        for item in candidates:
            if not _is_strong_metadata_candidate(item):
                continue
            if prompt_keywords and item.get("title_overlap", 0) <= 0 and item.get("overlap", 0) < 2:
                continue
            if item.get("title_overlap", 0) >= 1 and float(item.get("score") or 0) >= 0.62:
                links.append(item["title"])
                continue
            if item.get("overlap", 0) >= 2 and float(item.get("score") or 0) >= 0.78:
                links.append(item["title"])
    return _dedupe_related_link_titles(links, max_links)


def _select_related_tags(candidates, existing_tags, mention_tags=None):
    if not candidates and not mention_tags:
        return []
    weight = {}
    tag_candidates = candidates[:30]
    for item in tag_candidates:
        if STRICT_EXISTING_TAGS and not _is_strong_metadata_candidate(item):
            continue
        score = float(item.get("score") or 0)
        boost = 0.35 if item.get("explicit") else 0.0
        for tag in item.get("tags") or []:
            norm = _normalize_candidate_tag(tag)
            if not norm:
                continue
            weight[norm] = weight.get(norm, 0) + score + boost
    for tag in mention_tags or []:
        norm = _normalize_candidate_tag(tag)
        if not norm:
            continue
        weight[norm] = weight.get(norm, 0) + 1.0
    existing_normalized = {_normalize_candidate_tag(tag) for tag in existing_tags or [] if _normalize_candidate_tag(tag)}
    sorted_tags = sorted(weight.items(), key=lambda kv: (-kv[1], kv[0]))
    max_tags = min(MAX_TAGS, 10) if MAX_TAGS > 0 else 0
    selected = [tag for tag, _ in sorted_tags if tag not in existing_normalized][:max_tags]
    if STRICT_EXISTING_TAGS:
        return selected[:max_tags]
    min_tags = min(max_tags, 5)
    if len(selected) < min_tags and len(sorted_tags) >= min_tags:
        selected = [tag for tag, _ in sorted_tags[:min_tags] if tag not in existing_normalized]
    return selected


# Who: Tim Buglaev
# When: 2026-06-13
# What: Added strict existing-tag selection that only keeps user-mentioned tags, explicit-note tags,
#       or tags from strong related contexts; distant clusters now intentionally produce no tags.
def _select_grounded_existing_tags(candidates, contexts, prompt_tags, mention_tags=None, related_links=None, max_tags=None):
    max_count = min(MAX_TAGS, 10) if max_tags is None else max(0, int(max_tags or 0))
    if max_count <= 0:
        return []
    existing_pool = _collect_existing_tag_pool()
    if STRICT_EXISTING_TAGS and not existing_pool:
        return []
    selected = []

    def _append(raw_tag):
        norm = _normalize_candidate_tag(raw_tag)
        if not norm or _is_noise_tag_token(norm):
            return
        if existing_pool and norm not in existing_pool:
            return
        if norm not in selected:
            selected.append(norm)

    for tag in prompt_tags or []:
        _append(tag)
    for tag in mention_tags or []:
        _append(tag)

    related_set = {str(title or "").strip().lower() for title in related_links or [] if str(title or "").strip()}
    sources = list(candidates or []) + list(contexts or [])
    for item in sources:
        if len(selected) >= max_count:
            break
        title_key = str((item or {}).get("title") or "").strip().lower()
        if not title_key:
            continue
        if not ((title_key in related_set) or _is_strong_metadata_candidate(item)):
            continue
        for tag in (item or {}).get("tags") or []:
            _append(tag)
            if len(selected) >= max_count:
                break
    return selected[:max_count]


def _strip_disallowed_hashtags(text, allowed_tags):
    allowed = {_normalize_candidate_tag(tag) for tag in allowed_tags or [] if _normalize_candidate_tag(tag)}
    if not allowed:
        # Who: Tim Buglaev
        # When: 2026-06-15
        # What: Strip disallowed nested Obsidian hashtags as one token so ai/rag
        #       cannot partially survive as plain body text.
        return re.sub(r"#([\w\-/\u0400-\u04FF]+)", "", text or "").strip()

    def _replace(match):
        normalized = _normalize_candidate_tag(match.group(1))
        return match.group(0) if normalized in allowed else ""

    cleaned = re.sub(r"#([\w\-/\u0400-\u04FF]+)", _replace, text or "")
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _update_note_content(file_path, new_links, new_tags, existing_tags=None, rewritten_body=None):
    """Safely updates the note file with new links, tags и переписанным содержимым."""
    updated = False
    try:
        with open(file_path, "r+", encoding="utf-8") as f:
            content = f.read()
            original_content = content

            if rewritten_body is not None:
                content = rewritten_body

            content = _strip_existing_related_section(content)
            if new_links:
                content = _apply_related_block(content, new_links)

            content, added_tags = _merge_tags_into_content(content, new_tags, existing_tags)
            content = _remove_stopword_hashtags(content)

            if content != original_content:
                f.seek(0)
                f.write(content)
                f.truncate()
                updated = True
                logger.info(
                    "Updated note %s with %d links and %d new tags.",
                    file_path,
                    len(new_links),
                    len(added_tags),
                )

    except Exception as e:
        logger.error(f"Failed to update note file {file_path}: {e}")
        return False
    return updated

