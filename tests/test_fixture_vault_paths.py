"""A temporary vault must retain one identity across canonical Windows paths."""

import ctypes
import os
from pathlib import Path
import tempfile

import conftest as fixtures


def _short_path(path):
    if os.name != "nt":
        return str(path)
    function = ctypes.windll.kernel32.GetShortPathNameW
    function.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
    function.restype = ctypes.c_uint
    size = function(str(path), None, 0)
    if not size:
        raise ctypes.WinError()
    buffer = ctypes.create_unicode_buffer(size)
    if not function(str(path), buffer, size):
        raise ctypes.WinError()
    return buffer.value


def test_temporary_vault_alias_supports_live_reads_edits_and_trash(
    tmp_path, app_client, monkeypatch,
):
    import app as runtime

    base = tmp_path / "Canonical temporary vault with spaces"
    anchor = base / "anchor"
    anchor.mkdir(parents=True)
    # Use a real Windows 8.3 alias when available. The lexical parent component
    # also exercises canonicalization on filesystems without short-name support.
    raw = os.path.join(_short_path(base), "anchor", "..")
    assert Path(raw).resolve(strict=True) == base.resolve(strict=True)
    monkeypatch.setattr(tempfile, "mkdtemp", lambda **_options: raw)
    generated = fixtures.test_data_dir.__wrapped__()
    root = next(generated)
    vault = root / "notes"
    vault.mkdir()
    fixtures._isolate_runtime(runtime, monkeypatch, vault)
    try:
        created = app_client.post("/notes", json={
            "title": "Alias fixture note", "content": "Original text", "tags": [],
        })
        assert created.status_code == 201
        listed = app_client.get("/notes?live=1")
        assert listed.status_code == 200
        assert [note["title"] for note in listed.get_json()["notes"]] == [
            "Alias fixture note"
        ]
        detail = app_client.get("/note-detail/Alias fixture note").get_json()
        saved = app_client.patch("/note-detail/Alias fixture note", json={
            "content": "Edited text", "revision": detail["edit_revision"],
        })
        assert saved.status_code == 200
        assert (vault / "Alias fixture note.md").read_bytes() == b"Edited text"
        deleted = app_client.delete("/note-detail/Alias fixture note")
        assert deleted.status_code == 200
        assert not (vault / "Alias fixture note.md").exists()
        receipt = deleted.get_json()["deleted"]["trash_id"]
        restored = app_client.post("/notes", query_string={"restore": receipt})
        assert restored.status_code == 200
        assert (vault / "Alias fixture note.md").read_bytes() == b"Edited text"
    finally:
        assert runtime.note_generation_queue.close()
        generated.close()
