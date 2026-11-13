import hashlib

import pytest

from backend.note_disk_source import note_inventory
from backend.note_faithful_generation import render_source


@pytest.fixture
def library(monkeypatch, temp_notes_dir):
    import app as runtime

    monkeypatch.setattr(runtime, "_get_vector_size", lambda: 3)
    monkeypatch.setattr(runtime, "generate_embedding", lambda *args, **kwargs: [0.1] * 3)
    monkeypatch.setattr(runtime, "_qdrant_enabled", lambda: False)
    monkeypatch.setattr(runtime, "_delete_notes_in_qdrant", lambda _: False)

    def publish(title, content):
        path = temp_notes_dir / f"{title}.md"
        path.parent.mkdir(exist_ok=True, parents=True)
        path.write_bytes(content.encode("utf-8"))
        runtime._refresh_note_entry_in_cache(title, content, path)
        return path

    return publish


def test_edit_preserves_metadata_links_crlf_and_receipt(app_client, library):
    raw = render_source("Original text\n\n[[Follow-up]]\n", "Title", ["Related"])
    raw = raw.replace("\n", "\r\n")
    path = library("Nested/Title", raw)
    detail = app_client.get("/note-detail/Nested/Title").get_json()
    assert detail["edit_revision"] == hashlib.sha256(raw.encode()).hexdigest()
    assert detail["editable_body"] == "Original text\r\n\r\n[[Follow-up]]\r\n"
    response = app_client.patch(
        "/note-detail/Nested/Title",
        json={"content": "  Revised text\n\n[[Follow-up]]\n", "revision": detail["edit_revision"]},
        query_string={"expected_vault_id": detail["vault_id"]},
    )
    assert response.status_code == 200
    assert response.get_json()["cache_updated"] is True
    expected = raw.split("Original text", 1)[0] + "  Revised text\r\n\r\n[[Follow-up]]\r\n"
    assert path.read_bytes() == expected.encode("utf-8")
    refreshed = app_client.get("/note-detail/Nested/Title").get_json()
    assert refreshed["content"] == expected
    assert refreshed["edit_revision"] != detail["edit_revision"]


def test_edit_refuses_external_changes_and_wrong_vault(app_client, library):
    frontmatter = "\ufeff---\r\n# keep this\r\ncustom:\r\n  values: [a, b]\r\n---\r\n"
    path = library("Plain", frontmatter + "original\r\n")
    detail = app_client.get("/note-detail/Plain").get_json()
    assert detail["editable_body"] == "original\r\n"
    request = {"revision": detail["edit_revision"], "content": "new content"}
    wrong = app_client.patch("/note-detail/Plain?expected_vault_id=" + "0" * 32, json=request)
    assert wrong.status_code == 409 and wrong.get_json()["code"] == "vault_changed"
    forbidden = app_client.patch("/note-detail/Plain", json=request, headers={"Origin": "https://example.invalid"})
    assert forbidden.status_code == 403
    external = frontmatter + "external\r\n"
    path.write_bytes(external.encode())
    response = app_client.patch("/note-detail/Plain", json=request)
    assert response.status_code == 409 and response.get_json()["code"] == "note_edit_conflict"
    assert path.read_bytes() == external.encode()
    detail = app_client.get("/note-detail/Plain").get_json()
    response = app_client.patch("/note-detail/Plain", json={**request, "revision": detail["edit_revision"]})
    assert response.status_code == 200
    assert path.read_bytes() == (frontmatter + "new content").encode()


def test_edit_rejects_invalid_internal_properties_before_writing(app_client, library):
    path = library("Plain", "original")
    detail = app_client.get("/note-detail/Plain").get_json()
    response = app_client.patch("/note-detail/Plain", json={
        "revision": detail["edit_revision"],
        "content": '---\nnoda_source_version: "ru-pipeline-v1"\n---\nnew content',
    })
    assert response.status_code == 400
    assert path.read_bytes() == b"original"


def test_trash_is_reversible_does_not_overwrite_and_reports_index_failure(app_client, library, temp_notes_dir):
    original = "---\r\ncustom: true\r\n---\r\nБез потери байтов  \r\n"
    path = library("Subfolder/Unique", original)
    removed = app_client.delete("/note-detail/Subfolder/Unique")
    assert removed.status_code == 200
    result = removed.get_json()["deleted"]
    assert result["qdrant_deleted"] is False
    assert not path.exists()
    assert "Subfolder/Unique" not in note_inventory(temp_notes_dir)
    assert app_client.get("/notes?trash=1").get_json()["items"] == [{"id": result["trash_id"], "title": "Subfolder/Unique"}]
    restore = f"/notes?restore={result['trash_id']}"
    assert app_client.post(restore, headers={"Origin": "https://example.invalid"}).status_code == 403
    assert app_client.post(restore + "&expected_vault_id=" + "0" * 32).status_code == 409
    path.write_bytes(b"replacement")
    response = app_client.post(restore)
    assert response.status_code == 409 and response.get_json()["code"] == "restore_conflict"
    assert path.read_bytes() == b"replacement"
    path.unlink()
    response = app_client.post(restore)
    assert response.status_code == 200
    assert path.read_bytes() == original.encode()
    assert app_client.get("/notes?trash=1").get_json()["items"] == []
    assert app_client.post(restore).status_code == 404


def test_full_text_search_finds_terms_beyond_summary_without_returning_content(app_client, library):
    library("With match", "Пример. " * 400 + "Уникальный МАРКЕР в конце")
    library("Without match", "Unrelated content")
    response = app_client.get("/notes", query_string={"q": "уникальный маркер"})
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["titles"] == ["With match"]
    assert set(payload) == {"titles", "vault_id"}
    assert app_client.get("/notes", query_string={"q": "x" * 201}).status_code == 400
