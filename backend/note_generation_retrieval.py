"""Bounded semantic candidates; only the model decides which notes are related."""

import re

try:
    from backend.note_generation_contract import _outside_code, resolve_note_title
    from backend.note_identity_context import matched_identity_candidates
except ImportError:
    from note_generation_contract import _outside_code, resolve_note_title
    from note_identity_context import matched_identity_candidates


def source_references(runtime, source):
    with runtime._notes_cache_lock:
        known = list(runtime.notes_data)
    result = []
    seen = set()
    for match in re.finditer(r"(?<!!)\[\[([^\]\n]+)\]\]", _outside_code(source)):
        target = match.group(1).split("|", 1)[0].split("#", 1)[0].strip()
        title = resolve_note_title(target, known)
        if title and match.group(0) not in seen:
            result.append({"target": title, "raw": match.group(0)})
            seen.add(match.group(0))
    return result


def relation_candidates(source, candidates, authored_links):
    """Keep discovery broad unless the author already supplied an explicit edge.

    An authored wiki link is high-confidence graph intent.  In that case a
    second edge may still be inferred, but only for another note identity that
    is named verbatim in the source.  This prevents a semantic neighbour from
    being attached merely because it ranked beside the authored target.
    """
    authored_titles = {item["target"] for item in authored_links}
    remaining = [
        item for item in candidates if item.get("title") not in authored_titles
    ]
    if not authored_titles:
        return remaining
    exact_titles = {
        item["title"] for item in matched_identity_candidates(source, remaining)
    }
    return [item for item in remaining if item.get("title") in exact_titles]


def retrieve_candidates(runtime, source, limit):
    with runtime._notes_cache_lock:
        snapshot = {title: dict(note) for title, note in runtime.notes_data.items()}
    if not snapshot or limit <= 0:
        return []
    explicit = []
    known = list(snapshot)
    for target in re.findall(r"(?<!!)\[\[([^\]\n]+)\]\]", _outside_code(source)):
        title = resolve_note_title(
            target.split("|", 1)[0].split("#", 1)[0].strip(), known
        )
        if title and title not in explicit:
            explicit.append(title)
    identity_rows = [
        {
            "title": title,
            "tags": list(note.get("tags") or [])[:10],
            "text": runtime._clean_note_text_for_rag(note.get("content") or "")[:900],
        }
        for title, note in snapshot.items()
    ]
    exact_identity = [
        item["title"] for item in matched_identity_candidates(source, identity_rows)
    ]
    ranked = []
    matched_text = {}
    query = runtime._clean_note_text_for_rag(source)
    if len(snapshot) > limit:
        search = getattr(runtime, "_vector_search_notes", None)
        if callable(search):
            try:
                # The shared search combines dense/lexical ranks and validates
                # both the active parent note and its current chunk point ID.
                results = search(query, limit * 3)
                for hit in results or []:
                    title = resolve_note_title(hit.get("title"), known)
                    if not title:
                        continue
                    if title not in ranked:
                        ranked.append(title)
                    text = runtime._clean_note_text_for_rag(
                        hit.get("text") or hit.get("snippet") or ""
                    ).strip()
                    fragments = matched_text.setdefault(title, [])
                    if text and text not in fragments:
                        fragments.append(text)
            except Exception:
                runtime.logger.warning(
                    "Generation retrieval: local index unavailable; using cache vectors"
                )
        if not ranked:
            vector = runtime.generate_embedding(
                query, vector_size=runtime._get_vector_size()
            )
            scored = []
            for title, note in snapshot.items():
                text = (
                    title
                    + "\n"
                    + runtime._clean_note_text_for_rag(note.get("content") or "")
                )
                other = runtime.generate_embedding(text, vector_size=len(vector))
                scored.append((runtime._cosine_similarity(vector, other), title))
            ranked = [
                title
                for _, title in sorted(scored, key=lambda pair: (-pair[0], pair[1]))
            ]
    else:
        ranked = sorted(snapshot, key=str.casefold)
    selected = list(dict.fromkeys(explicit + exact_identity + ranked))[:limit]
    candidates = []
    for title in selected:
        note = snapshot[title]
        candidates.append(
            {
                "title": title,
                "tags": list(note.get("tags") or [])[:10],
                "text": (
                    "\n\n".join(matched_text.get(title) or [])
                    or runtime._clean_note_text_for_rag(note.get("content") or "")
                )[:900],
            }
        )
    return candidates
