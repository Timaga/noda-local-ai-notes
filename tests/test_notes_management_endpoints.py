import uuid

import pytest


@pytest.mark.unit
@pytest.mark.api
def test_post_notes_creates_file_cache_and_indexable_payload(app_client, monkeypatch, temp_notes_dir):
    import app as app_module

    # Who: Tim Buglaev
    # When: 2026-06-13
    # What: Keep the create-note endpoint test focused on API/file/cache behavior by replacing
    #       embedding and Qdrant availability with deterministic local-only test doubles.
    monkeypatch.setattr(app_module, "_get_vector_size", lambda: 3)
    monkeypatch.setattr(app_module, "generate_embedding", lambda text, vector_size=None: [0.1] * (vector_size or 3))
    monkeypatch.setattr(app_module, "_qdrant_enabled", lambda: False)

    response = app_client.post(
        "/notes",
        json={
            "title": "Manual CRM Note",
            "content": "Body text",
            "tags": ["crm", "manual"],
        },
    )

    assert response.status_code == 201
    payload = response.get_json()
    note = payload["note"]
    expected_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, "Manual CRM Note"))

    assert payload["success"] is True
    assert note["title"] == "Manual CRM Note"
    assert note["qdrant_id"] == expected_id
    assert note["indexed"] is False
    assert (temp_notes_dir / "Manual CRM Note.md").exists()
    assert "#crm" in (temp_notes_dir / "Manual CRM Note.md").read_text(encoding="utf-8")
    assert "Manual CRM Note" in app_module.notes_data


@pytest.mark.unit
@pytest.mark.api
@pytest.mark.parametrize(
    ("content", "tags", "prefix", "suffix"),
    [
        ("    code line one\r\n    code line two\r\n\r\nHard break  \nnext\n", [], "# Manual\n\n", ""),
        ("\n\tcode after a blank line\n\n", ["manual"], "# Manual\n\n", "\nТеги: #manual"),
        ("---\r\ncustom: keep\r\n---\r\n\r\n    code\r\n", [], "", ""),
    ],
)
def test_post_notes_preserves_markdown_whitespace_on_disk_and_reopen(
    app_client, monkeypatch, temp_notes_dir, content, tags, prefix, suffix
):
    import app as app_module

    monkeypatch.setattr(app_module, "_get_vector_size", lambda: 3)
    monkeypatch.setattr(app_module, "generate_embedding", lambda *args, **kwargs: [0.1] * 3)
    monkeypatch.setattr(app_module, "_qdrant_enabled", lambda: False)

    response = app_client.post("/notes", json={"title": "Manual", "content": content, "tags": tags})

    assert response.status_code == 201
    expected = prefix + content + suffix
    assert (temp_notes_dir / "Manual.md").read_bytes() == expected.encode("utf-8")
    app_module._reload_notes_cache(force=True, skip_index=True, reason="synthetic manual note reopen")
    reopened = app_client.get("/note-detail/Manual")
    assert reopened.status_code == 200
    assert reopened.get_json()["content"] == expected


@pytest.mark.unit
@pytest.mark.api
def test_post_notes_rejects_path_traversal_title(app_client):
    response = app_client.post(
        "/notes",
        json={
            "title": "../bad",
            "content": "Body text",
        },
    )

    assert response.status_code == 400
    assert "title" in response.get_json()["error"]


@pytest.mark.unit
@pytest.mark.api
def test_post_notes_rejects_empty_content(app_client):
    response = app_client.post(
        "/notes",
        json={
            "title": "Empty Note",
            "content": "   ",
        },
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "content is required"


@pytest.mark.unit
@pytest.mark.api
def test_post_notes_rejects_remote_origin(app_client):
    response = app_client.post(
        "/notes",
        json={
            "title": "Remote Origin",
            "content": "Body text",
        },
        headers={"Origin": "https://evil.example"},
    )

    assert response.status_code == 403
    assert response.get_json()["error"] == "Forbidden origin"


@pytest.mark.unit
@pytest.mark.api
def test_delete_note_removes_file_cache_and_qdrant(app_client, monkeypatch, temp_notes_dir):
    import app as app_module

    note_path = temp_notes_dir / "Noise Note.md"
    note_path.write_text("Noise body #test", encoding="utf-8")
    app_module.notes_data["Noise Note"] = {
        "content": "Noise body #test",
        "tags": ["test"],
        "filename": note_path.name,
        "filepath": str(note_path),
    }

    deleted_ids = []

    # Who: Tim Buglaev
    # When: 2026-06-13
    # What: Capture the Qdrant delete identifier to prove managed deletion removes the same
    #       deterministic point id that note indexing uses.
    def fake_delete(note_id):
        deleted_ids.append(note_id)
        return True

    monkeypatch.setattr(app_module, "_delete_notes_in_qdrant", fake_delete)

    response = app_client.delete("/notes/Noise%20Note")

    expected_id = app_module._note_identifier("Noise Note", note_path.name, str(note_path))
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["success"] is True
    assert payload["deleted"]["qdrant_id"] == expected_id
    assert payload["deleted"]["qdrant_deleted"] is True
    assert deleted_ids == [expected_id]
    assert not note_path.exists()
    assert "Noise Note" not in app_module.notes_data


@pytest.mark.unit
@pytest.mark.api
def test_delete_note_rejects_remote_origin(app_client, monkeypatch, temp_notes_dir):
    import app as app_module

    note_path = temp_notes_dir / "Protected Note.md"
    note_path.write_text("Protected body", encoding="utf-8")
    app_module.notes_data["Protected Note"] = {
        "content": "Protected body",
        "tags": [],
        "filename": note_path.name,
        "filepath": str(note_path),
    }

    delete_called = {"value": False}

    # Who: Tim Buglaev
    # When: 2026-06-13
    # What: Assert the remote-origin guard stops deletion before filesystem or Qdrant mutation.
    def fake_delete(_note_id):
        delete_called["value"] = True
        return True

    monkeypatch.setattr(app_module, "_delete_notes_in_qdrant", fake_delete)

    response = app_client.delete(
        "/notes/Protected%20Note",
        headers={"Origin": "https://evil.example"},
    )

    assert response.status_code == 403
    assert response.get_json()["error"] == "Forbidden origin"
    assert note_path.exists()
    assert "Protected Note" in app_module.notes_data
    assert delete_called["value"] is False


@pytest.mark.unit
@pytest.mark.api
def test_delete_note_rejects_cached_path_outside_notes_dir(app_client, temp_notes_dir):
    import app as app_module

    outside_path = temp_notes_dir.parent / "outside.md"
    outside_path.write_text("outside", encoding="utf-8")
    app_module.notes_data["Outside"] = {
        "content": "outside",
        "tags": [],
        "filename": outside_path.name,
        "filepath": str(outside_path),
    }

    response = app_client.delete("/notes/Outside")

    assert response.status_code == 409
    assert outside_path.exists()
    assert "Outside" in app_module.notes_data


@pytest.mark.unit
@pytest.mark.api
def test_get_note_asset_serves_resource_image(app_client, temp_notes_dir):
    resources_dir = temp_notes_dir / "_resources"
    resources_dir.mkdir()
    image_path = resources_dir / "Pasted image.png"
    image_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    image_path.write_bytes(image_bytes)

    response = app_client.get("/notes/assets/Pasted%20image.png")

    assert response.status_code == 200
    assert response.data == image_bytes
    assert response.mimetype == "image/png"


@pytest.mark.unit
@pytest.mark.api
def test_get_note_asset_allows_electron_file_preview_headers(app_client, temp_notes_dir):
    # Who: Tim Buglaev
    # When: 2026-06-19
    # What: Reproduce Electron's local file-preview image requests where Chrome
    #       may mark the loopback asset load as cross-site even though the
    #       request comes from the packaged local notes panel.
    resources_dir = temp_notes_dir / "_resources"
    resources_dir.mkdir()
    image_path = resources_dir / "Pasted image 20251021161301.png"
    image_bytes = b"\x89PNG\r\n\x1a\nlocal-image"
    image_path.write_bytes(image_bytes)

    response = app_client.get(
        "/notes/assets/Pasted%20image%2020251021161301.png",
        headers={
            "Sec-Fetch-Site": "cross-site",
            "Referer": "file:///F:/projects/TEST_GUI/frontend/notes.html",
        },
    )

    assert response.status_code == 200
    assert response.data == image_bytes
    assert response.mimetype == "image/png"


@pytest.mark.unit
@pytest.mark.api
def test_get_note_asset_allows_loopback_same_site_preview_headers(app_client, temp_notes_dir):
    # Who: Tim Buglaev
    # When: 2026-06-19
    # What: Cover localhost development previews where the frontend and Flask
    #       ports are same-site but not same-origin, which should still be
    #       allowed for read-only image assets inside NOTES_DIR.
    resources_dir = temp_notes_dir / "_resources"
    resources_dir.mkdir()
    image_path = resources_dir / "preview.png"
    image_bytes = b"\x89PNG\r\n\x1a\nsame-site"
    image_path.write_bytes(image_bytes)

    response = app_client.get(
        "/notes/assets/preview.png",
        headers={
            "Origin": "http://127.0.0.1:8765",
            "Sec-Fetch-Site": "same-site",
        },
    )

    assert response.status_code == 200
    assert response.data == image_bytes
    assert response.mimetype == "image/png"


@pytest.mark.unit
@pytest.mark.api
def test_get_note_asset_allows_electron_cross_site_without_referer(app_client, temp_notes_dir):
    # Who: Tim Buglaev
    # When: 2026-06-19
    # What: Cover packaged Electron image requests that can arrive as cross-site
    #       without Origin/Referer while still identifying the local desktop shell.
    resources_dir = temp_notes_dir / "_resources"
    resources_dir.mkdir()
    image_path = resources_dir / "electron.png"
    image_bytes = b"\x89PNG\r\n\x1a\nelectron"
    image_path.write_bytes(image_bytes)

    response = app_client.get(
        "/notes/assets/electron.png",
        headers={
            "Sec-Fetch-Site": "cross-site",
            "User-Agent": "Mozilla/5.0 Electron/42.3.0 Chrome/142.0.0.0",
        },
    )

    assert response.status_code == 200
    assert response.data == image_bytes
    assert response.mimetype == "image/png"


@pytest.mark.unit
@pytest.mark.api
def test_get_note_asset_rejects_cross_site_browser_without_referer(app_client, temp_notes_dir):
    # Who: Tim Buglaev
    # When: 2026-06-19
    # What: Keep remote no-referrer browser image probes blocked unless the
    #       request carries a local file/loopback context or Electron identity.
    resources_dir = temp_notes_dir / "_resources"
    resources_dir.mkdir()
    (resources_dir / "browser.png").write_bytes(b"\x89PNG\r\n\x1a\nbrowser")

    response = app_client.get(
        "/notes/assets/browser.png",
        headers={
            "Sec-Fetch-Site": "cross-site",
            "User-Agent": "Mozilla/5.0 Chrome/142.0.0.0",
        },
    )

    assert response.status_code == 403
    assert response.get_json()["error"] == "Forbidden origin"


@pytest.mark.unit
@pytest.mark.api
def test_get_note_asset_rejects_path_traversal(app_client, temp_notes_dir):
    outside_path = temp_notes_dir.parent / "secret.png"
    outside_path.write_bytes(b"not allowed")

    response = app_client.get("/notes/assets/%2e%2e/secret.png")

    assert response.status_code == 403
    assert response.get_json()["error"] == "asset path is outside NOTES_DIR"


@pytest.mark.unit
@pytest.mark.api
def test_get_note_asset_rejects_non_image_extension(app_client, temp_notes_dir):
    text_path = temp_notes_dir / "secret.txt"
    text_path.write_text("not an image", encoding="utf-8")

    response = app_client.get("/notes/assets/secret.txt")

    assert response.status_code == 400
    assert response.get_json()["error"] == "asset type is not supported"


@pytest.mark.unit
@pytest.mark.api
def test_get_note_asset_rejects_remote_origin(app_client, temp_notes_dir):
    resources_dir = temp_notes_dir / "_resources"
    resources_dir.mkdir()
    (resources_dir / "private.png").write_bytes(b"\x89PNG\r\n\x1a\n")

    response = app_client.get(
        "/notes/assets/private.png",
        headers={"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"},
    )

    assert response.status_code == 403
    assert response.get_json()["error"] == "Forbidden origin"
