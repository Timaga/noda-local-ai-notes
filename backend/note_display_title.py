"""Read a note headline for presentation without changing its file identity."""

import json
import re
import unicodedata

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from backend import note_faithful_archive
else:
    try:
        from backend import note_faithful_archive
    except ImportError:
        import note_faithful_archive


def note_display_title(canonical_title: str, content: object) -> str:
    """Use current application metadata; ordinary or malformed notes keep their ID."""
    if not isinstance(content, str):
        return canonical_title
    try:
        metadata, _ = note_faithful_archive.current_wrapper_metadata(content)
        headline = metadata.get("title") if metadata else None
        if metadata is None:
            # Ordinary Markdown uses its frontmatter title; the filename remains
            # the canonical lookup identity even when the author changes it.
            try:
                from backend.note_service_card import parse_frontmatter
            except ImportError:
                from note_service_card import parse_frontmatter
            ordinary, _ = parse_frontmatter(content.lstrip("\ufeff"))
            headline = ordinary.get("title")
            match = re.match(r"\A(?:\ufeff)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)", content)
            if match:
                titles = re.findall(r"(?m)^title:[ \t]*(.*)$", match[1])
                if len(titles) > 1:
                    return canonical_title
                if titles and titles[0].lstrip().startswith('"'):
                    headline = json.loads(titles[0])
        if not isinstance(headline, str) or not headline.strip():
            return canonical_title
        if len(headline) > 160 or any(unicodedata.category(char) in {"Cc", "Cs", "Zl", "Zp"} for char in headline):
            return canonical_title
        headline.encode("utf-8", errors="strict")
    except (note_faithful_archive.NoteSystemError, ValueError):
        return canonical_title
    return headline
