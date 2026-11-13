"""Source preservation and stale-plan rejection for maintenance metadata refresh."""

import hashlib
import os

import pytest

from backend.note_metadata_refresh import refresh_metadata
from backend import note_metadata_refresh as refresh_module
from backend.note_faithful_archive import unwrap_source
from backend.ru_pipeline.orchestrator import render_source
from backend.services.windows_note_file import _LockedNote

pytestmark = pytest.mark.skipif(
    os.name != "nt", reason="Exclusive Windows file handles"
)


def seed(tmp_path):
    source = "\ufeff  Полный исходник\r\nХвост и пробелы.  "
    expected, drafts = {}, {}
    for identity in ("Один", "Два"):
        raw = source.encode()
        (tmp_path / (identity + ".md")).write_bytes(raw)
        expected[identity] = hashlib.sha256(raw).hexdigest()
        drafts[identity] = {
            "title": "Грамотный заголовок",
            "tags": ["тема"],
            "links": ["Два" if identity == "Один" else "Один"],
            "content": render_source(
                source,
                "Грамотный заголовок",
                ["тема"],
                ["Два" if identity == "Один" else "Один"],
            ),
        }
    return source, expected, drafts


def test_refresh_preserves_source_identity_and_all_existing_paths(tmp_path):
    source, expected, drafts = seed(tmp_path)
    identities = {p.name: p.stat().st_ino for p in tmp_path.glob("*.md")}
    result = refresh_metadata(tmp_path, expected, drafts)
    assert set(result) == set(drafts)
    assert {p.name: p.stat().st_ino for p in tmp_path.glob("*.md")} == identities
    assert all(
        unwrap_source(p.read_bytes().decode()) == source for p in tmp_path.glob("*.md")
    )


@pytest.mark.parametrize("fault", ["source", "revision", "self", "missing", "fields"])
def test_invalid_or_stale_plan_never_writes_any_note(tmp_path, fault):
    source, expected, drafts = seed(tmp_path)
    if fault == "source":
        drafts["Один"]["content"] = render_source(
            source + "Changed", "Заголовок", ["тема"], ["Два"]
        )
    elif fault == "revision":
        (tmp_path / "Два.md").write_bytes(b"New author text")
    elif fault in ("self", "missing"):
        links = ["Один" if fault == "self" else "Нет такой заметки"]
        drafts["Один"].update(
            links=links, content=render_source(source, "Заголовок", ["тема"], links)
        )
    else:
        drafts["Один"]["tags"] = []
    before = {p.name: p.read_bytes() for p in tmp_path.glob("*.md")}
    with pytest.raises((ValueError, FileExistsError)):
        refresh_metadata(tmp_path, expected, drafts)
    assert {p.name: p.read_bytes() for p in tmp_path.glob("*.md")} == before


def test_partial_write_failure_restores_all_original_bytes(tmp_path, monkeypatch):
    source, expected, drafts = seed(tmp_path)
    before = {p.name: p.read_bytes() for p in tmp_path.glob("*.md")}
    write = _LockedNote.write_all
    calls = []

    def fail_once(note, data):
        calls.append(data)
        if len(calls) == 2:
            write(note, data[:20])
            raise OSError("Synthetic disk failure")
        return write(note, data)

    monkeypatch.setattr(_LockedNote, "write_all", fail_once)
    with pytest.raises(OSError, match="Synthetic"):
        refresh_metadata(tmp_path, expected, drafts)
    assert {p.name: p.read_bytes() for p in tmp_path.glob("*.md")} == before


@pytest.mark.parametrize(
    "expected,drafts",
    [(None, {}), ({}, {}), ({"unknown": "0"}, {}), ({"unknown": "0"}, {"unknown": {}})],
)
def test_missing_or_unknown_note_plan_is_rejected(tmp_path, expected, drafts):
    with pytest.raises(ValueError):
        refresh_metadata(tmp_path, expected, drafts)


def test_author_edit_during_lock_acquisition_is_preserved(tmp_path, monkeypatch):
    source, expected, drafts = seed(tmp_path)
    original = refresh_module.locked_note
    changed = tmp_path / "Один.md"

    def edit_before_lock(path):
        if path == changed:
            path.write_bytes(b"New author text")
        return original(path)

    monkeypatch.setattr(refresh_module, "locked_note", edit_before_lock)
    with pytest.raises(FileExistsError):
        refresh_metadata(tmp_path, expected, drafts)
    assert changed.read_bytes() == b"New author text"
    assert (tmp_path / "Два.md").read_bytes() == source.encode()
