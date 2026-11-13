# Who: Tim Buglaev
# When: 2026-06-15
# What: Added pure helpers for Obsidian service-card metadata, strict note-generation
#       JSON contracts, and card-based RAG index text so the LLM selects only from
#       validated tags/links while Qdrant avoids raw Markdown noise.

import json
import re
from typing import Callable, Dict, Iterable, List, Optional, Tuple


JsonDict = Dict[str, object]
TextCleaner = Optional[Callable[[str], str]]
LinkExtractor = Optional[Callable[[str], Iterable[str]]]
TokenExtractor = Optional[Callable[..., Iterable[str]]]
TagNormalizer = Optional[Callable[[object], Optional[str]]]


def _clean_yaml_scalar(value: object) -> str:
    text = re.sub(r"\s+", " ", str(value or "").strip())
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        text = text[1:-1]
    return text.replace('\\"', '"').replace("\\'", "'").strip()


def _dedupe(values: Iterable[object], limit: int = 20) -> List[str]:
    result: List[str] = []
    seen = set()
    for value in values or []:
        text = _clean_yaml_scalar(value)
        if not text:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(text)
        if limit > 0 and len(result) >= limit:
            break
    return result


def _parse_inline_list(value: str) -> List[str]:
    raw = _clean_yaml_scalar(value)
    if not (raw.startswith("[") and raw.endswith("]")):
        return [raw] if raw else []
    inner = raw[1:-1].strip()
    if not inner:
        return []
    return _dedupe(part for part in re.split(r"\s*,\s*", inner) if part)


def _normalize_list(value: object, limit: int = 20) -> List[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return _dedupe(value, limit=limit)
    if isinstance(value, str):
        return _dedupe(_parse_inline_list(value), limit=limit)
    return _dedupe([value], limit=limit)


# Who: Tim Buglaev
# When: 2026-06-15
# What: Parse only a safe YAML-like frontmatter subset used by generated Obsidian
#       cards; no object construction or evaluation is allowed, and malformed
#       blocks fall back to plain body parsing.
def parse_frontmatter(markdown_text: str) -> Tuple[JsonDict, str]:
    original = str(markdown_text or "")
    text = original.removeprefix("\ufeff")
    if text.startswith("---") and "noda_source_version:" in text.split("\n---", 1)[0]:
        try:
            from backend.note_faithful_archive import current_wrapper_metadata
        except ImportError:
            from note_faithful_archive import current_wrapper_metadata
        wrapped_metadata, source = current_wrapper_metadata(text)
        if wrapped_metadata is not None:
            return wrapped_metadata, source
    if not text.startswith("---"):
        return {}, original
    match = re.match(r"\A---\s*\n([\s\S]*?)\n---\s*(?:\n|$)", text)
    if not match:
        return {}, original
    metadata: JsonDict = {}
    current_key = ""
    for line in match.group(1).splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        list_match = re.match(r"^-\s*(.+)$", stripped)
        if list_match and current_key:
            metadata.setdefault(current_key, [])
            if isinstance(metadata[current_key], list):
                metadata[current_key].append(_clean_yaml_scalar(list_match.group(1)))
            continue
        key_match = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$", stripped)
        if not key_match:
            current_key = ""
            continue
        current_key = key_match.group(1).strip()
        value = key_match.group(2).strip()
        if not value:
            metadata[current_key] = []
        elif value.startswith("[") and value.endswith("]"):
            metadata[current_key] = _parse_inline_list(value)
        else:
            metadata[current_key] = _clean_yaml_scalar(value)
    return metadata, text[match.end():]


def _plain_link_title(value: object) -> str:
    text = _clean_yaml_scalar(value)
    wiki_match = re.fullmatch(r"\[\[([^\[\]]+)\]\]", text)
    if wiki_match:
        text = wiki_match.group(1).strip()
    if "|" in text:
        text = text.split("|", 1)[0].strip()
    return text.split("#", 1)[0].strip()


def _fallback_terms(text: str, limit: int = 8) -> List[str]:
    terms: List[str] = []
    for raw in re.findall(r"[A-Za-zА-Яа-яЁё0-9]{3,}", text or ""):
        token = raw.strip().casefold()
        if token and token not in terms:
            terms.append(token)
        if len(terms) >= limit:
            break
    return terms


def _extract_terms(text: str, token_func: TokenExtractor, limit: int = 8) -> List[str]:
    if callable(token_func):
        try:
            return _dedupe(token_func(text, limit=limit, min_len=3), limit=limit)
        except TypeError:
            try:
                return _dedupe(token_func(text, limit=limit), limit=limit)
            except Exception:
                return _fallback_terms(text, limit=limit)
        except Exception:
            return _fallback_terms(text, limit=limit)
    return _fallback_terms(text, limit=limit)


def _summary_from_body(body: str, clean_text_func: TextCleaner, max_chars: int = 280) -> str:
    text = str(body or "")
    if callable(clean_text_func):
        try:
            text = clean_text_func(text) or text
        except Exception:
            pass
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    sentence = re.split(r"(?<=[.!?…])\s+", text, maxsplit=1)[0].strip()
    value = sentence or text
    if len(value) <= max_chars:
        return value
    return value[:max_chars].rsplit(" ", 1)[0].strip() or value[:max_chars].strip()


# Who: Tim Buglaev
# When: 2026-06-15
# What: Build a compact service card from frontmatter plus safe fallbacks so indexing
#       and link selection can use title/aliases/summary/concepts instead of noisy
#       raw Markdown while still preserving Obsidian metadata on disk.
def extract_service_card(
    title: str,
    content: str,
    tags: Optional[Iterable[str]] = None,
    clean_text_func: TextCleaner = None,
    extract_links_func: LinkExtractor = None,
    token_func: TokenExtractor = None,
    infer_metadata: bool = True,
) -> JsonDict:
    metadata, body = parse_frontmatter(content)
    card_title = _clean_yaml_scalar(metadata.get("title") or title)
    aliases = _normalize_list(metadata.get("aliases"), limit=8)
    summary = _clean_yaml_scalar(metadata.get("summary"))
    if not summary and infer_metadata:
        summary = _summary_from_body(body, clean_text_func)
    concepts = _normalize_list(metadata.get("concepts"), limit=12)
    if not concepts and infer_metadata:
        concepts = _extract_terms(" ".join([card_title, summary, body]), token_func, limit=10)
    lossless = metadata.get("noda_source_version") in {"faithful-v1", "ru-pipeline-v1"}
    related_values = _normalize_list(metadata.get("related"), limit=0 if lossless else 20)
    if callable(extract_links_func):
        try:
            related_values.extend(list(extract_links_func(content) or []))
        except Exception:
            pass
    clean_related = (
        list(metadata["related"])
        if lossless
        else _dedupe((_plain_link_title(value) for value in related_values), limit=20)
    )
    return {
        "title": card_title,
        "aliases": aliases,
        "tags": (
            list(metadata["tags"])
            if metadata.get("noda_source_version") == "ru-pipeline-v1"
            else _normalize_list(
                tags if tags is not None else metadata.get("tags"), limit=20
            )
        ),
        "summary": summary,
        "concepts": concepts,
        "related": clean_related,
        "body": body,
    }


def build_index_text(
    title: str,
    content: str,
    tags: Optional[Iterable[str]] = None,
    clean_text_func: TextCleaner = None,
    extract_links_func: LinkExtractor = None,
    token_func: TokenExtractor = None,
    max_chars: int = 4000,
) -> str:
    card = extract_service_card(
        title,
        content,
        tags=tags,
        clean_text_func=clean_text_func,
        extract_links_func=extract_links_func,
        token_func=token_func,
    )
    parts = [card.get("title"), *card.get("aliases", []), card.get("summary"), *card.get("concepts", [])]
    text = " ".join(str(part or "").strip() for part in parts if str(part or "").strip())
    if not text:
        text = _summary_from_body(str(card.get("body") or content or ""), clean_text_func, max_chars=max_chars)
    if callable(clean_text_func):
        try:
            text = clean_text_func(text) or text
        except Exception:
            pass
    text = re.sub(r"\s+", " ", text).strip()
    if max_chars > 0 and len(text) > max_chars:
        text = text[:max_chars].rsplit(" ", 1)[0].strip() or text[:max_chars].strip()
    return text


def _safe_json_dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


# Who: Tim Buglaev
# When: 2026-06-15
# What: Generate a strict JSON-only prompt where the LLM edits the current note but
#       can choose tags and links only from preselected candidates supplied by the
#       retrieval layer.
def build_note_json_prompt(prompt: str, contexts: Iterable[JsonDict], allowed_tags: Iterable[str]) -> str:
    candidates = []
    for item in list(contexts or [])[:20]:
        title = _clean_yaml_scalar((item or {}).get("title"))
        if not title:
            continue
        candidates.append(
            {
                "title": title,
                "tags": _normalize_list((item or {}).get("tags"), limit=10),
                "score": round(float((item or {}).get("score") or 0), 4),
                "snippet": _clean_yaml_scalar((item or {}).get("snippet"))[:500],
            }
        )
    schema = {
        "title": "string",
        "aliases": ["string"],
        "tags": ["string"],
        "corrected_text": "string",
        "links": [{"target": "string", "anchor": "string", "reason": "string", "confidence": 0.0}],
        "suggested_links": [{"target": "string", "anchor": "string", "reason": "string", "confidence": 0.0}],
    }
    return (
        "Ты редактор русскоязычной базы знаний в Obsidian.\n"
        "Исходный текст пользователя является единственным источником новых фактов.\n"
        "Исправь русский текст: орфографию, пунктуацию, стиль и ясность. Не добавляй факты из контекста.\n"
        "Сделай короткий точный заголовок по сути заметки.\n"
        "Теги можно брать только из списка allowed_tags. Если подходящих тегов нет, верни пустой список.\n"
        "Ссылки можно выбирать только из candidate_notes. Не создавай ссылки на несуществующие заметки.\n"
        "links используй только при высокой уверенности, suggested_links - для слабых, но возможных связей.\n"
        "Верни только валидный JSON без Markdown, комментариев и пояснений.\n\n"
        f"Исходная заметка:\n<<<\n{prompt}\n>>>\n\n"
        f"allowed_tags:\n{_safe_json_dumps(list(allowed_tags or []))}\n\n"
        f"candidate_notes:\n{_safe_json_dumps(candidates)}\n\n"
        f"JSON schema:\n{_safe_json_dumps(schema)}"
    )


def _extract_json_object(raw_text: str) -> Optional[JsonDict]:
    text = str(raw_text or "").strip()
    text = re.sub(r"\A```(?:json)?\s*|\s*```\Z", "", text, flags=re.IGNORECASE).strip()
    for candidate in (text,):
        try:
            parsed = json.loads(candidate)
            return parsed if isinstance(parsed, dict) else None
        except Exception:
            pass
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index, char in enumerate(text[start:], start=start):
        if escaped:
            escaped = False
            continue
        if char == "\\" and in_string:
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    parsed = json.loads(text[start:index + 1])
                    return parsed if isinstance(parsed, dict) else None
                except Exception:
                    return None
    return None


def _normalize_confidence(value: object) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = 0.0
    return max(0.0, min(1.0, parsed))


def _normalize_tag_list(raw_tags: object, allowed_tags: Iterable[str], normalizer: TagNormalizer) -> List[str]:
    allowed = {}
    for tag in allowed_tags or []:
        norm = normalizer(tag) if callable(normalizer) else _clean_yaml_scalar(tag).casefold()
        if norm:
            allowed[str(norm)] = str(norm)
    selected = []
    for tag in _normalize_list(raw_tags, limit=20):
        norm = normalizer(tag) if callable(normalizer) else tag.casefold()
        if norm and norm in allowed and norm not in selected:
            selected.append(str(norm))
    return selected


def _normalize_link_items(raw_links: object, candidate_titles: Iterable[str], min_confidence: float) -> List[JsonDict]:
    candidates = {_plain_link_title(title).casefold(): _plain_link_title(title) for title in candidate_titles or []}
    result: List[JsonDict] = []
    seen = set()
    for item in raw_links if isinstance(raw_links, list) else []:
        if not isinstance(item, dict):
            continue
        target = candidates.get(_plain_link_title(item.get("target")).casefold())
        confidence = _normalize_confidence(item.get("confidence"))
        if not target or confidence < min_confidence or target.casefold() in seen:
            continue
        seen.add(target.casefold())
        result.append(
            {
                "target": target,
                "anchor": _clean_yaml_scalar(item.get("anchor"))[:120],
                "reason": _clean_yaml_scalar(item.get("reason"))[:300],
                "confidence": confidence,
            }
        )
    return result


# Who: Tim Buglaev
# When: 2026-06-15
# What: Validate model JSON against existing tag and candidate-note allow-lists so
#       generated metadata cannot introduce invented tags, dead Obsidian links, or
#       low-confidence automatic links.
def validate_generation_contract(
    raw_text: str,
    allowed_tags: Iterable[str],
    candidate_titles: Iterable[str],
    normalizer: TagNormalizer = None,
    auto_link_confidence: float = 0.75,
    suggested_link_confidence: float = 0.55,
) -> Optional[JsonDict]:
    parsed = _extract_json_object(raw_text)
    if not parsed:
        return None
    title = _clean_yaml_scalar(parsed.get("title"))[:120]
    corrected = str(parsed.get("corrected_text") or "").strip()
    if not corrected:
        return None
    links = _normalize_link_items(parsed.get("links"), candidate_titles, auto_link_confidence)
    suggested = _normalize_link_items(parsed.get("suggested_links"), candidate_titles, suggested_link_confidence)
    suggested = [item for item in suggested if item.get("target") not in {link.get("target") for link in links}]
    return {
        "title": title,
        "aliases": _normalize_list(parsed.get("aliases"), limit=5),
        "tags": _normalize_tag_list(parsed.get("tags"), allowed_tags, normalizer),
        "corrected_text": corrected,
        "links": links,
        "suggested_links": suggested,
    }


def _quote_yaml(value: object) -> str:
    text = _clean_yaml_scalar(value)
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _render_list_block(key: str, values: Iterable[str], wiki: bool = False) -> List[str]:
    clean_values = _dedupe(values, limit=20)
    if not clean_values:
        return [f"{key}: []"]
    lines = [f"{key}:"]
    for value in clean_values:
        text = f"[[{_plain_link_title(value)}]]" if wiki else value
        lines.append(f"  - {_quote_yaml(text)}")
    return lines


def render_frontmatter(
    title: str,
    aliases: Iterable[str],
    tags: Iterable[str],
    summary: str,
    concepts: Iterable[str],
    related: Iterable[str],
    suggested_links: Iterable[str],
) -> str:
    tag_values = _dedupe(tags, limit=20)
    lines = ["---", f"title: {_quote_yaml(title)}"]
    lines.extend(_render_list_block("aliases", aliases))
    lines.append("tags: [" + ", ".join(_quote_yaml(tag) for tag in tag_values) + "]")
    lines.append(f"summary: {_quote_yaml(summary)}")
    lines.extend(_render_list_block("concepts", concepts))
    lines.extend(_render_list_block("related", related, wiki=True))
    lines.extend(_render_list_block("suggested_links", suggested_links, wiki=True))
    lines.append("---")
    return "\n".join(lines)


def render_note_document(
    title: str,
    body: str,
    tags: Iterable[str],
    related: Iterable[str],
    contract: Optional[JsonDict] = None,
    clean_text_func: TextCleaner = None,
    token_func: TokenExtractor = None,
) -> str:
    contract = contract or {}
    _, stripped_body = parse_frontmatter(body)
    clean_body = stripped_body.strip()
    summary = _clean_yaml_scalar(contract.get("summary"))
    if not summary:
        summary = _summary_from_body(clean_body, clean_text_func)
    concepts = _normalize_list(contract.get("concepts"), limit=10)
    if not concepts:
        concepts = _extract_terms(" ".join([title, summary, clean_body]), token_func, limit=8)
    suggested = [str(item.get("target")) for item in contract.get("suggested_links", []) if isinstance(item, dict)]
    frontmatter = render_frontmatter(
        title=title,
        aliases=_normalize_list(contract.get("aliases"), limit=5),
        tags=tags,
        summary=summary,
        concepts=concepts,
        related=related,
        suggested_links=suggested,
    )
    return f"{frontmatter}\n\n{clean_body.rstrip()}\n"


# Who: Tim Buglaev
# When: 2026-06-15
# What: Render the user-visible Obsidian note body without internal service-card
#       frontmatter so generated files stay readable while Qdrant can still index
#       a separate metadata document.
def render_visible_note_document(body: str) -> str:
    _, stripped_body = parse_frontmatter(body)
    clean_body = stripped_body.strip()
    return f"{clean_body.rstrip()}\n" if clean_body else ""
