"""Deterministic Markdown-aware chunking for local RAG indexing."""

import hashlib
import os
import re
import unicodedata
import uuid

try:
    from backend.markdown_retrieval import protect_code, restore_code
except ImportError:
    from markdown_retrieval import protect_code, restore_code


# Who: Tim Buglaev
# When: 2026-06-22
# What: Keep semantic note fragments small enough for constrained local model contexts;
#       malformed environment values cannot create empty chunks or unbounded prompts.
def _chunk_size(value=None):
    raw_value = value if value is not None else os.environ.get("RAG_CHUNK_MAX_CHARS", "450")
    try:
        parsed = int(raw_value)
    except (TypeError, ValueError):
        parsed = 450
    return max(300, min(parsed, 2400))


# Who: Tim Buglaev
# When: 2026-06-22
# What: Remove YAML frontmatter before section parsing while leaving the original note
#       untouched on disk; metadata is supplied separately to the embedding representation.
def _without_frontmatter(content):
    return re.sub(r"\A\s*---\s*[\s\S]*?\n---\s*", "", str(content or ""), count=1)


# Who: Tim Buglaev
# When: 2026-06-22
# What: Track Markdown hierarchy by explicit heading levels so sibling sections replace
#       one another and documents that start below H1 never gain empty path segments.
def _heading_sections(content):
    sections = []
    heading_stack = []
    body_lines = []
    fence = None

    def flush():
        raw_body = "\n".join(body_lines).strip()
        if raw_body:
            sections.append((" / ".join(value for _, value in heading_stack), raw_body))
        body_lines.clear()

    for line in _without_frontmatter(content).splitlines():
        fence_match = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
        if fence_match:
            current = fence_match.group(1)
            if fence is None:
                fence = current
            elif current[0] == fence[0] and len(current) >= len(fence):
                fence = None
            body_lines.append(line)
            continue
        if fence is not None:
            body_lines.append(line)
            continue
        match = re.match(r"^\s{0,3}(#{1,6})\s+(.+?)\s*$", line)
        if not match:
            body_lines.append(line)
            continue
        flush()
        level = len(match.group(1))
        heading = match.group(2).strip().strip("#").strip()
        while heading_stack and heading_stack[-1][0] >= level:
            heading_stack.pop()
        heading_stack.append((level, heading))
    flush()
    return sections


# Who: Tim Buglaev
# When: 2026-06-22
# What: Normalize Markdown headings before indexing so formatting markers and decorative
#       Unicode symbols do not pollute embeddings or evidence shown to the answer model.
def _clean_heading(heading, cleaner):
    value = cleaner(heading) if callable(cleaner) else str(heading or "")
    value = "".join(char for char in str(value or "") if not unicodedata.category(char).startswith("So"))
    return re.sub(r"\s+", " ", value).strip()


def _split_long_text(text, max_chars):
    remaining = str(text or "").strip()
    parts = []
    while len(remaining) > max_chars:
        boundary = remaining.rfind(" ", 0, max_chars + 1)
        if boundary < max_chars // 2:
            boundary = max_chars
        part = remaining[:boundary].strip()
        if part:
            parts.append(part)
        remaining = remaining[boundary:].strip()
    if remaining:
        parts.append(remaining)
    return parts


# Who: Tim Buglaev
# When: 2026-06-22
# What: Split sections on paragraph boundaries, remove decorative Unicode symbols, and
#       apply bounded word wrapping to oversized paragraphs while preserving order.
def _section_units(raw_body, cleaner, max_chars):
    protected_body, code = protect_code(raw_body or "")
    raw_units = re.split(r"\n\s*\n+", protected_body)
    cleaned_units = []
    for raw_unit in raw_units:
        raw_unit = restore_code(raw_unit, code)
        cleaned = cleaner(raw_unit) if callable(cleaner) else re.sub(r"\s+", " ", raw_unit).strip()
        cleaned = str(cleaned or "").strip()
        if not cleaned:
            continue
        cleaned_units.extend(_split_long_text(cleaned, max_chars))
    return cleaned_units


def _pack_units(units, heading, max_chars):
    chunks = []
    current = []
    heading_prefix = f"{heading}\n" if heading else ""
    body_limit = max(120, max_chars - len(heading_prefix))
    for unit in units:
        candidate = "\n\n".join(current + [unit])
        if current and len(candidate) > body_limit:
            chunks.append((heading_prefix + "\n\n".join(current)).strip())
            current = [unit]
        else:
            current.append(unit)
    if current:
        chunks.append((heading_prefix + "\n\n".join(current)).strip())
    return chunks


def _embedding_text(title, heading, text, tags, aliases, summary, concepts):
    fields = [
        f"Title: {title}" if title else "",
        f"Section: {heading}" if heading else "",
        f"Aliases: {', '.join(aliases)}" if aliases else "",
        f"Summary: {summary}" if summary else "",
        f"Concepts: {', '.join(concepts)}" if concepts else "",
        f"Tags: {', '.join(tags)}" if tags else "",
        text,
    ]
    return "\n".join(field for field in fields if field).strip()


# Who: Tim Buglaev
# When: 2026-06-22
# What: Build stable, clean RAG fragments from all Markdown sections instead of indexing
#       one truncated note preview; images/frontmatter are removed by the shared cleaner.
def build_note_chunks(
    title,
    content,
    tags=None,
    aliases=None,
    summary="",
    concepts=None,
    cleaner=None,
    max_chars=None,
):
    limit = _chunk_size(max_chars)
    normalized_tags = [str(value).strip() for value in (tags or []) if str(value).strip()]
    normalized_aliases = [str(value).strip() for value in (aliases or []) if str(value).strip()]
    normalized_concepts = [str(value).strip() for value in (concepts or []) if str(value).strip()]
    sections = _heading_sections(content)
    if not sections:
        sections = [("", _without_frontmatter(content))]

    result = []
    for heading, raw_body in sections:
        heading = _clean_heading(heading, cleaner)
        units = _section_units(raw_body, cleaner, limit)
        for text in _pack_units(units, heading, limit):
            digest = hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()
            result.append(
                {
                    "chunk_index": len(result),
                    "heading": heading,
                    "text": text,
                    "embedding_text": _embedding_text(
                        str(title or "").strip(),
                        heading,
                        text,
                        normalized_tags,
                        normalized_aliases,
                        str(summary or "").strip(),
                        normalized_concepts,
                    ),
                    "digest": digest,
                }
            )
    return result


# Who: Tim Buglaev
# When: 2026-06-22
# What: Derive stable UUID point identifiers from the parent note and chunk position so
#       edits overwrite current fragments and reconciliation can remove obsolete tails.
def note_chunk_point_id(note_id, chunk_index):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{note_id}:rag-chunk:{int(chunk_index)}"))
