"""Retry DTO and local browser boundary tests against a real synthetic receipt."""

import os
import uuid
from types import SimpleNamespace

from flask import Flask
import pytest

from backend.routes.generation_routes import register_generation_routes
from backend.services.note_job_store import JobError
from test_source_note_recovery import RAW, saved_source, successful

pytestmark = pytest.mark.skipif(
    os.name != "nt", reason="Strict Windows recovery protocol"
)


@pytest.fixture
def recovery_api(tmp_path):
    queue, old, target = saved_source(tmp_path)
    app = Flask(__name__)
    app.config["TESTING"] = True
    register_generation_routes(
        app, SimpleNamespace(module=SimpleNamespace(note_generation_queue=queue))
    )
    try:
        yield app.test_client(), queue, old, target
    finally:
        queue.close()


def body(queue, key=None):
    return {
        "client_request_id": key or str(uuid.uuid4()),
        "expected_vault_id": queue.store.vault_id,
    }


def test_api_retry_ack_status_and_idempotent_post_keeps_one_job(recovery_api):
    client, queue, old, target = recovery_api
    url = f"/generate/jobs/{old['job_id']}/retry"
    request = body(queue)
    response = client.post(url, json=request)
    assert response.status_code == 202
    assert response.json["job"]["job_id"] == old["job_id"]
    assert response.json["job"]["processing_outcome"] == "pending"
    assert (
        response.json["job"]["recovery_summary"]["request_id"]
        == uuid.UUID(request["client_request_id"]).hex
    )
    assert "result" not in response.json["job"]
    assert client.post(url, json=request).status_code == 202
    queue._generate_note_payload = successful(target.parent)
    queue.process_one()
    replay = client.post(url, json=request)
    assert (
        replay.status_code == 200
        and replay.json["job"]["processing_outcome"] == "completed"
    )
    assert len(queue.store.listing(50)[0]) == 1


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {},
        {"client_request_id": "x"},
        {"client_request_id": True, "expected_vault_id": "0" * 32},
        {"client_request_id": "not-a-uuid", "expected_vault_id": "0" * 32},
        {"client_request_id": "0" * 32, "expected_vault_id": []},
    ],
)
def test_retry_invalid_dto_does_not_change_receipt_or_source(recovery_api, payload):
    client, queue, old, target = recovery_api
    before = queue.store.get(old["job_id"])
    response = client.post(f"/generate/jobs/{old['job_id']}/retry", json=payload)
    assert response.status_code in (400, 409)
    assert queue.store.get(old["job_id"]) == before
    assert target.read_bytes() == RAW.encode("utf-8")


@pytest.mark.parametrize("extra", ["source", "target", "path", "metadata", "mode"])
def test_retry_rejects_all_caller_controlled_content_or_paths(recovery_api, extra):
    client, queue, old, target = recovery_api
    request = dict(body(queue), **{extra: "PRIVATE_UNTRUSTED_INPUT"})
    response = client.post(f"/generate/jobs/{old['job_id']}/retry", json=request)
    assert response.status_code == 400
    assert "PRIVATE_UNTRUSTED_INPUT" not in response.get_data(as_text=True)
    assert target.read_bytes() == RAW.encode("utf-8")


def test_retry_is_bounded_and_post_only_with_unknown_job_and_wrong_vault(recovery_api):
    client, queue, old, target = recovery_api
    url = f"/generate/jobs/{old['job_id']}/retry"
    assert client.get(url).status_code == 405
    assert client.post(url, data="bad", content_type="text/plain").status_code == 400
    assert (
        client.post(url, data="{bad", content_type="application/json").status_code
        == 400
    )
    assert (
        client.post(
            url, data='{"too_big":"' + "x" * 600 + '"}', content_type="application/json"
        ).status_code
        == 413
    )
    assert (
        client.post("/generate/jobs/not-valid/retry", json=body(queue)).status_code
        == 400
    )
    assert (
        client.post(
            "/generate/jobs/" + "f" * 32 + "/retry", json=body(queue)
        ).status_code
        == 404
    )
    wrong = dict(body(queue), expected_vault_id="0" * 32)
    response = client.post(url, json=wrong)
    assert response.status_code == 409 and response.json["code"] == "vault_changed"
    assert target.read_bytes() == RAW.encode("utf-8")


@pytest.mark.parametrize(
    "headers,remote",
    [
        ({"Origin": "https://untrusted.example"}, "127.0.0.1"),
        ({"Origin": "null"}, "127.0.0.1"),
        ({"Origin": "http://localhost:5000"}, "192.0.2.10"),
        ({"Host": "untrusted.example"}, "127.0.0.1"),
    ],
)
def test_retry_inherits_local_request_guard(recovery_api, headers, remote):
    client, queue, old, target = recovery_api
    response = client.post(
        f"/generate/jobs/{old['job_id']}/retry",
        json=body(queue),
        headers=headers,
        environ_overrides={"REMOTE_ADDR": remote},
    )
    assert response.status_code == 403
    assert queue.store.get(old["job_id"])["status"] == "completed"
    assert target.read_bytes() == RAW.encode("utf-8")


def test_retry_request_id_is_bound_to_one_job_and_cannot_reuse_enqueue_id(recovery_api):
    client, queue, old, target = recovery_api
    url = f"/generate/jobs/{old['job_id']}/retry"
    reused = client.post(url, json=body(queue, old["client_request_id"]))
    assert reused.status_code == 409 and reused.json["code"] == "retry_request_conflict"
    first = body(queue)
    assert client.post(url, json=first).status_code == 202
    with pytest.raises(JobError) as collision:
        queue.enqueue(
            "Accidental resend as a new note",
            "local",
            False,
            client_request_id=first["client_request_id"],
        )
    assert collision.value.code == "request_conflict"
    other = queue.enqueue("Другой исходник", "local", False)[0]["job"]
    collision = client.post(f"/generate/jobs/{other['job_id']}/retry", json=first)
    assert (
        collision.status_code == 409
        and collision.json["code"] == "retry_request_conflict"
    )
