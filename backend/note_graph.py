"""Project-local graph of authored links; no retrieval or model inference."""

import os
import posixpath
import re
import unicodedata
from typing import TYPE_CHECKING
from urllib.parse import unquote

from markdown_it import MarkdownIt

if TYPE_CHECKING or __package__ == "backend":
    from backend.markdown_code import transform_code
    from backend.note_faithful_archive import current_wrapper_metadata
    from backend.note_service_card import parse_frontmatter
    from backend.note_display_title import note_display_title
else:
    from markdown_code import transform_code
    from note_faithful_archive import current_wrapper_metadata
    from note_service_card import parse_frontmatter
    from note_display_title import note_display_title


MAX_NODES = 5000
MAX_EDGES = 50000
MAX_SOURCE_CHARS = 25000000
_WIKI = re.compile(r"(?<!\\)\[\[([^\[\]\n]+)\]\]")


class GraphLimitError(ValueError):
    """Refuse oversized graphs explicitly rather than silently omit notes."""


def _key(value):
    return unicodedata.normalize("NFC", value).casefold()


def _target(raw):
    if not isinstance(raw, str) or len(raw) > 4096:
        return None
    raw = raw.strip()
    if raw.startswith("[[") and raw.endswith("]]"):
        raw = raw[2:-2]
    raw = raw.split("|", 1)[0].split("#", 1)[0].split("?", 1)[0]
    raw = unquote(raw).replace("\\", "/").strip()
    if not raw or raw.startswith("/") or ":" in raw or "\0" in raw:
        return None
    stem, extension = posixpath.splitext(raw)
    # Dots may be part of an actual note identity (for example "Release 1.2").
    return stem if extension.casefold() == ".md" else raw


def _body_links(body):
    plain = transform_code(body, lambda literal: " " * len(literal))
    plain = re.sub(r"<!--.*?-->", " ", plain, flags=re.DOTALL)
    plain = re.sub(r"<[^>\n]*>", " ", plain)
    wiki = [match.group(1) for match in _WIKI.finditer(plain)]
    markdown = []
    # CommonMark handles escaped destinations, reference links and inline code.
    for token in MarkdownIt("commonmark").parse(body):
        for child in token.children or []:
            if child.type == "link_open":
                href = child.attrGet("href") or ""
                destination = unquote(re.split(r"[?#]", href, maxsplit=1)[0])
                if posixpath.splitext(destination)[1].lower() == ".md":
                    markdown.append(href)
    return [(value, False) for value in wiki] + [(value, True) for value in markdown]


def build_note_graph(state):
    """Resolve canonical identities, rejecting ambiguous and outside-vault links."""
    if (
        len(state.notes) > MAX_NODES
        or sum(len(entry.get("content") or "") for _, entry in state.notes)
        > MAX_SOURCE_CHARS
    ):
        raise GraphLimitError("Graph size limit exceeded")
    nodes, links, paths, aliases, basenames = [], {}, {}, {}, {}

    def index(mapping, name, identity):
        mapping.setdefault(_key(name), set()).add(identity)

    for identity, entry in sorted(state.notes):
        raw = entry.get("content") or ""
        metadata, body = current_wrapper_metadata(raw)
        if metadata is None:
            _, body = parse_frontmatter(raw)
        title = note_display_title(identity, raw)
        nodes.append({"id": identity, "title": title})
        path = identity.replace("\\", "/")
        file_path = entry.get("filepath") or entry.get("path")
        if file_path and state.root:
            path = os.path.relpath(file_path, state.root).replace("\\", "/")
        elif entry.get("filename"):
            path = entry["filename"].replace("\\", "/")
        if path.lower().endswith(".md"):
            path = path[:-3]
        index(paths, path, identity)
        index(aliases, identity, identity)
        index(aliases, title, identity)
        index(basenames, posixpath.basename(path), identity)
        references = _body_links(body)
        if metadata:
            references += [(value, False) for value in metadata["related"]]
        links[identity] = (path, references)

    def unique(mapping, name):
        values = mapping.get(_key(name), set())
        return next(iter(values)) if len(values) == 1 else None

    edges, unresolved = {}, 0
    for source, (path, references) in links.items():
        for raw, relative in references:
            target = _target(raw)
            if target is None:
                continue
            local = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
            root = posixpath.normpath(target)
            if local == ".." or local.startswith("../"):
                unresolved += 1
                continue
            explicit = target.startswith(("./", "../"))
            candidates = (
                [local] if explicit else ([local, root] if relative else [root, local])
            )
            resolved = None
            for candidate in candidates:
                resolved = unique(paths, candidate)
                if resolved:
                    break
            if not resolved and not explicit:
                resolved = unique(aliases, target)
                if not resolved and "/" not in target:
                    resolved = unique(basenames, target)
            if not resolved and posixpath.splitext(target)[1].casefold() in {
                ".png",
                ".jpg",
                ".jpeg",
                ".gif",
                ".svg",
                ".webp",
                ".pdf",
                ".mp4",
                ".mp3",
                ".wav",
                ".zip",
            }:
                continue
            if not resolved:
                unresolved += 1
            elif resolved != source:
                pair = tuple(sorted((source, resolved)))
                edges.setdefault(pair, set()).add((source, resolved))
                if len(edges) > MAX_EDGES:
                    raise GraphLimitError("Graph size limit exceeded")
    return {
        "nodes": nodes,
        "edges": [
            {
                "source": pair[0],
                "target": pair[1],
                "bidirectional": len(directions) == 2,
            }
            for pair, directions in sorted(edges.items())
        ],
        "unresolved": unresolved,
    }
