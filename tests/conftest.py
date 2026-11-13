"""
Pytest РєРѕРЅС„РёРіСѓСЂР°С†РёСЏ Рё fixtures РґР»СЏ РІСЃРµС… С‚РµСЃС‚РѕРІ РїСЂРѕРµРєС‚Р°.

Р­С‚РѕС‚ С„Р°Р№Р» СЃРѕРґРµСЂР¶РёС‚ РѕР±С‰РёРµ fixtures, РєРѕС‚РѕСЂС‹Рµ РёСЃРїРѕР»СЊР·СѓСЋС‚СЃСЏ РІ unit Рё integration С‚РµСЃС‚Р°С….
"""

import pytest
import sys
import os
import tempfile
import shutil
from pathlib import Path
from unittest.mock import MagicMock, patch
import importlib
import socket
import json
from types import SimpleNamespace


# Install isolation before test collection: several test modules import the
# runtime at module scope, before pytest can run an autouse fixture.
_session_sandbox = tempfile.TemporaryDirectory(prefix="noda-pytest-")
_session_root = Path(_session_sandbox.name).resolve(strict=True)
_startup_notes = _session_root / "startup-notes"
_startup_notes.mkdir()
_isolation_env = {
    "NOTES_DIR": str(_startup_notes),
    "PYTHON_DOTENV_DISABLED": "1",
    "ALLOW_MODEL_DOWNLOADS": "0",
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "HF_DATASETS_OFFLINE": "1",
    "HF_HOME": str(_session_root / "hf-cache"),
    "TRANSFORMERS_CACHE": str(_session_root / "model-cache"),
    "RAG_LOCAL_MODEL_CACHE": str(_session_root / "model-cache"),
    "RAG_RUNTIME_PROVIDER": "local",
    "RAG_LOCAL_MODEL_FORMAT": "transformers",
    "RAG_LOCAL_MODEL_ID": "test-model-id",
    "RAG_LOCAL_MODEL_NAME": "test-local-rag",
    "QDRANT_AUTOSTART": "0",
    "QDRANT_COLLECTION_NAME": "noda_pytest_isolated",
    "TURBOQUANT_ENABLED": "false",
}
_original_env = {key: os.environ.get(key) for key in _isolation_env}
os.environ.update(_isolation_env)


def _deny_network(*args, **kwargs):
    raise RuntimeError("Live network access is disabled in the ordinary test suite")


_network_patches = [
    patch.object(socket.socket, "connect", _deny_network),
    patch.object(socket.socket, "connect_ex", _deny_network),
    patch.object(socket.socket, "sendto", _deny_network),
    patch.object(socket, "getaddrinfo", _deny_network),
]
for _network_patch in _network_patches:
    _network_patch.start()


def pytest_unconfigure(config):
    # Collection can import app before fixtures run. Close its durable store first.
    runtime = sys.modules.get("app")
    queue = getattr(runtime, "note_generation_queue", None)
    if queue is not None:
        queue.close()
    for network_patch in reversed(_network_patches):
        network_patch.stop()
    for key, value in _original_env.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    _session_sandbox.cleanup()

# Who: Tim Buglaev
# When: 2026-03-26
# What: Added explicit unicode constants for fixture note titles/paths to eliminate mojibake-induced key
#       mismatches in API tests and keep local-only fixtures deterministic across Windows encodings.
NOTES_DIR_NAME = "\u041c\u043e\u0438 \u0437\u0430\u043c\u0435\u0442\u043a\u0438"
NOTE_BASE_TITLE = "\u0417\u0430\u043c\u0435\u0442\u043a\u0430"
NOTE_TITLE_1 = f"{NOTE_BASE_TITLE} 1"
NOTE_TITLE_2 = f"{NOTE_BASE_TITLE} 2"
NOTE_TITLE_3 = f"{NOTE_BASE_TITLE} 3"
TAG_TEST = "\u0442\u0435\u0441\u0442"


# Р”РѕР±Р°РІР»СЏРµРј РєРѕСЂРµРЅСЊ РїСЂРѕРµРєС‚Р° Рё backend РІ sys.path, С‡С‚РѕР±С‹ import backend СЂР°Р±РѕС‚Р°Р» РґР°Р¶Рµ РїСЂРё Р·Р°РїСѓСЃРєРµ Python СЃ -P.
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

BACKEND_DIR = ROOT_DIR / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(1, str(BACKEND_DIR))


@pytest.fixture(scope="session")
def test_data_dir():
    """
    РЎРѕР·РґР°РµС‚ РІСЂРµРјРµРЅРЅСѓСЋ РґРёСЂРµРєС‚РѕСЂРёСЋ РґР»СЏ С‚РµСЃС‚РѕРІС‹С… РґР°РЅРЅС‹С… РЅР° РІРµСЃСЊ session.

    Returns:
        Path: РџСѓС‚СЊ Рє РІСЂРµРјРµРЅРЅРѕР№ РґРёСЂРµРєС‚РѕСЂРёРё СЃ С‚РµСЃС‚РѕРІС‹РјРё РґР°РЅРЅС‹РјРё
    """
    # Windows TEMP may use an 8.3 alias. Match the runtime's canonical vault root.
    temp_dir = Path(tempfile.mkdtemp(prefix="test_gui_")).resolve(strict=True)
    yield temp_dir
    # Cleanup РїРѕСЃР»Рµ РІСЃРµС… С‚РµСЃС‚РѕРІ
    if temp_dir.exists():
        shutil.rmtree(temp_dir, ignore_errors=True)


@pytest.fixture
def temp_notes_dir(test_data_dir):
    """
    РЎРѕР·РґР°РµС‚ РІСЂРµРјРµРЅРЅСѓСЋ РґРёСЂРµРєС‚РѕСЂРёСЋ РґР»СЏ Р·Р°РјРµС‚РѕРє РґР»СЏ РєР°Р¶РґРѕРіРѕ С‚РµСЃС‚Р°.

    Args:
        test_data_dir: Р¤РёРєСЃС‚СѓСЂР° СЃ Р±Р°Р·РѕРІРѕР№ РґРёСЂРµРєС‚РѕСЂРёРµР№ РґР»СЏ С‚РµСЃС‚РѕРІ

    Returns:
        Path: РџСѓС‚СЊ Рє РІСЂРµРјРµРЅРЅРѕР№ РґРёСЂРµРєС‚РѕСЂРёРё СЃ Р·Р°РјРµС‚РєР°РјРё
    """
    notes_root = test_data_dir / "notes"
    notes_dir = notes_root / NOTES_DIR_NAME
    shutil.rmtree(notes_root, ignore_errors=True)
    notes_dir.mkdir(parents=True, exist_ok=True)

    yield notes_dir

    # Cleanup РїРѕСЃР»Рµ С‚РµСЃС‚Р° (РѕРїС†РёРѕРЅР°Р»СЊРЅРѕ, С‚.Рє. РІРµСЃСЊ test_data_dir РѕС‡РёСЃС‚РёС‚СЃСЏ)
    if notes_dir.exists():
        for item in notes_dir.iterdir():
            if item.is_file():
                item.unlink()


@pytest.fixture
def sample_notes(temp_notes_dir):
    """
    РЎРѕР·РґР°РµС‚ РЅР°Р±РѕСЂ РїСЂРёРјРµСЂРѕРІ Р·Р°РјРµС‚РѕРє РґР»СЏ С‚РµСЃС‚РёСЂРѕРІР°РЅРёСЏ.

    Args:
        temp_notes_dir: Р¤РёРєСЃС‚СѓСЂР° СЃ РґРёСЂРµРєС‚РѕСЂРёРµР№ РґР»СЏ Р·Р°РјРµС‚РѕРє

    Returns:
        dict: РЎР»РѕРІР°СЂСЊ СЃ РёРЅС„РѕСЂРјР°С†РёРµР№ Рѕ СЃРѕР·РґР°РЅРЅС‹С… Р·Р°РјРµС‚РєР°С…
    """
    notes = {
        NOTE_TITLE_1: {
            "content": f"# \u0422\u0435\u0441\u0442\u043e\u0432\u0430\u044f {NOTE_TITLE_1}\n\n\u0422\u0435\u043a\u0441\u0442 \u0437\u0430\u043c\u0435\u0442\u043a\u0438 #{TAG_TEST} #python",
            "tags": [TAG_TEST, "python"],
        },
        NOTE_TITLE_2: {
            "content": "---\ntags: [ai, ml]\n---\n\n# Machine Learning\n\n\u041e\u043f\u0438\u0441\u0430\u043d\u0438\u0435 #ai",
            "tags": ["ai", "ml"],
        },
        NOTE_TITLE_3: {
            "content": "# Coding\n\n\u041f\u0440\u0438\u043c\u0435\u0440\u044b \u043a\u043e\u0434\u0430 #coding #development",
            "tags": ["coding", "development"],
        },
    }

    # РЎРѕР·РґР°РµРј С„Р°Р№Р»С‹ Р·Р°РјРµС‚РѕРє
    for title, data in notes.items():
        file_path = temp_notes_dir / f"{title}.md"
        file_path.write_text(data["content"], encoding="utf-8")

    return notes


@pytest.fixture
def mock_local_client():
    # Who: Tim Buglaev
    # When: 2026-05-28
    # What: Renamed the compatibility client fixture to remove legacy provider naming while
    #       keeping tests focused on local/vLLM-only request paths.
    mock_client = MagicMock()

    # РќР°СЃС‚СЂР°РёРІР°РµРј СЃС‚Р°РЅРґР°СЂС‚РЅС‹Р№ РѕС‚РІРµС‚
    mock_response = MagicMock()
    mock_response.text = "Local compatibility mock response"

    mock_client.models.generate_content.return_value = mock_response

    return mock_client


@pytest.fixture
def mock_transformers():
    """
    РЎРѕР·РґР°РµС‚ РјРѕРє РґР»СЏ transformers Р±РёР±Р»РёРѕС‚РµРєРё (РґР»СЏ Р»РѕРєР°Р»СЊРЅРѕР№ RAG РјРѕРґРµР»Рё).

    Returns:
        MagicMock: РњРѕРє transformers РјРѕРґСѓР»СЏ
    """
    mock_trans = MagicMock()

    # РњРѕРє pipeline
    mock_pipeline = MagicMock()
    mock_pipeline.return_value = [{
        "generated_text": "РўРµСЃС‚РѕРІС‹Р№ РѕС‚РІРµС‚ РѕС‚ Р»РѕРєР°Р»СЊРЅРѕР№ РјРѕРґРµР»Рё"
    }]

    mock_trans.pipeline.return_value = mock_pipeline

    return mock_trans


@pytest.fixture(autouse=True)
def setup_test_env(monkeypatch, temp_notes_dir):
    """
    РђРІС‚РѕРјР°С‚РёС‡РµСЃРєРё РЅР°СЃС‚СЂР°РёРІР°РµС‚ С‚РµСЃС‚РѕРІРѕРµ РѕРєСЂСѓР¶РµРЅРёРµ РґР»СЏ РєР°Р¶РґРѕРіРѕ С‚РµСЃС‚Р°.

    РЈСЃС‚Р°РЅР°РІР»РёРІР°РµС‚ РїРµСЂРµРјРµРЅРЅС‹Рµ РѕРєСЂСѓР¶РµРЅРёСЏ Рё РїР°С‚С‡РёС‚ РїСѓС‚Рё Рє С„Р°Р№Р»Р°Рј.

    Args:
        monkeypatch: Pytest С„РёРєСЃС‚СѓСЂР° РґР»СЏ РјРѕРґРёС„РёРєР°С†РёРё РѕРєСЂСѓР¶РµРЅРёСЏ
        temp_notes_dir: Р’СЂРµРјРµРЅРЅР°СЏ РґРёСЂРµРєС‚РѕСЂРёСЏ РґР»СЏ Р·Р°РјРµС‚РѕРє
    """
    # РЈСЃС‚Р°РЅР°РІР»РёРІР°РµРј РїРµСЂРµРјРµРЅРЅС‹Рµ РѕРєСЂСѓР¶РµРЅРёСЏ РґР»СЏ С‚РµСЃС‚РѕРІ
    # Who: Tim Buglaev
    # When: 2026-05-28
    # What: Removed cloud-provider test defaults and pinned runtime provider to embedded local mode so
    #       repository .env vLLM/TurboQuant settings do not leak into unrelated unit tests.
    env_vars = {
        **_isolation_env,
        "NOTES_DIR": str(temp_notes_dir),
        "RAG_MODEL_SOURCE": "local",
        "RAG_RUNTIME_PROVIDER": "local",
        "RAG_LOCAL_MODEL_FORMAT": "transformers",
        "RAG_LOCAL_MODEL_NAME": "test-local-rag",
        "RAG_LOCAL_MODEL_ID": "test-model-id",
        "RAG_CONTEXT_LIMIT": "3",
        "RAG_SNIPPET_LENGTH": "400",
        "NOTE_BASE_TITLE": NOTE_BASE_TITLE,
        "TURBOQUANT_ENABLED": "false",
    }

    for key, value in env_vars.items():
        monkeypatch.setenv(key, value)

    # Imported runtime aliases share state. Isolate paths and mutable clients
    # even for tests that do not use app_client.
    for name in ("backend.app_runtime", "app_runtime"):
        module = sys.modules.get(name)
        if module is not None:
            _isolate_runtime(module, monkeypatch, temp_notes_dir)
    yield
    for name in ("backend.app_runtime", "app_runtime"):
        module = sys.modules.get(name)
        queue = getattr(module, "note_generation_queue", None)
        if queue is not None:
            assert queue.close(), "Test queue did not stop before vault cleanup"


def _isolate_runtime(module, monkeypatch, notes_dir):
    config_dir = notes_dir.parent / "test-config" / "backend"
    config_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(module, "BASE_DIR", config_dir)
    monkeypatch.setattr(module, "NOTES_DIR", notes_dir)
    existing_queue = getattr(module, "note_generation_queue", None)
    if existing_queue is not None:
        assert existing_queue.close(), "Previous test queue is still processing"
        from backend.services.note_generation_queue import NoteGenerationQueue
        queue = NoteGenerationQueue(200, 3600,
            lambda prompt, **kwargs: module._generate_note_payload(prompt, **kwargs),
            module.logger, notes_dir=notes_dir)
        queue.start()
        monkeypatch.setattr(module, "note_generation_queue", queue)
    monkeypatch.setattr(module, "notes_data", {})
    monkeypatch.setattr(module, "_notes_snapshot", {})
    monkeypatch.setattr(module, "_notes_dir_mtime", None)
    monkeypatch.setattr(module, "qdrant_service", None)
    monkeypatch.setattr(module, "use_qdrant", False)
    local_model = MagicMock()
    local_model.name = "local-mock"
    local_model.generate_note.return_value = json.dumps({
        "title": "Synthetic generated note", "corrected_text": "Synthetic generated content.",
        "tags": [], "links": [],
    })
    local_model.select_note_relations.side_effect = lambda prompt, **kwargs: _synthetic_relation_response(prompt)
    local_model._invoke_pipeline.return_value = json.dumps({
        "comparison": "Synthetic reviewer accepts the fixture.", "preserves_source": True,
        "supported_tags": True, "covers_topics": True,
    })
    local_model.generate_answer.return_value = "Ответ локальной модели"
    local_model.grounded_generation_limits.return_value = (512, 12000)
    local_model.is_fully_loaded = True
    local_model.downloaded = True
    local_model._pipeline_initialized = True
    monkeypatch.setattr(module, "local_rag_model", local_model)


def _synthetic_relation_response(prompt, selected_titles=()):
    """Return explicit golden decisions for each server-issued candidate ID."""
    payload = json.loads(prompt[-1]['content'])
    return json.dumps({'source_subjects': ['Synthetic source'], 'decisions': {
        key: {"candidate_subjects": [entry['title']], "relationship": 'same_subject' if entry["title"] in selected_titles else 'different_subject'}
        for key, entry in payload["candidates"].items()
    }}, ensure_ascii=False)



@pytest.fixture
def app_client(monkeypatch, temp_notes_dir, mock_local_client):
    """Use the actual filesystem with a synthetic vault and isolated runtime state."""
    import app as app_module

    _isolate_runtime(app_module, monkeypatch, temp_notes_dir)
    monkeypatch.setattr(app_module, "client", None)
    flask_app = app_module.app
    monkeypatch.setitem(flask_app.config, "TESTING", True)
    with flask_app.test_client() as client:
        yield client
    app_module.notes_data.clear()


@pytest.fixture
def model_note_response(app_client, monkeypatch):
    """Supply explicit model output; tests still exercise validation and persistence."""
    import app as module

    def configure(title, text, tags=(), links=(), load_seed_files=True):
        if load_seed_files:
            module._reload_notes_cache(force=True, skip_index=True, reason="synthetic fixture seed")
        payload = {"title": title, "corrected_text": text, "tags": list(tags), "links": list(links)}
        result = MagicMock(return_value=(json.dumps(payload, ensure_ascii=False), "local-test"))
        monkeypatch.setattr(module, "_generate_local_note_response", result)
        monkeypatch.setattr(module.local_rag_model, "select_note_relations", MagicMock(
            side_effect=lambda prompt, **kwargs: _synthetic_relation_response(prompt, links)
        ))
        previous_invoke = module.local_rag_model._invoke_pipeline

        def faithful_response(prompt, **kwargs):
            name = (kwargs.get("response_format") or {}).get("json_schema", {}).get("name")
            if name not in {"faithful_title", "faithful_title_review", "faithful_pair"}:
                return previous_invoke(prompt, **kwargs)
            data = json.loads(prompt[-1]["content"])
            if name in {"faithful_title", "faithful_title_review"}:
                fixture_title = title if any(
                    character.isalpha() and "\u0400" <= character <= "\u052f"
                    for character in title
                ) else "Синтетическая заметка"
                decision = {"title": fixture_title}
                if name == "faithful_title_review":
                    decision = {"analysis": "Синтетическая сверка исходника", **decision}
            else:
                candidate = data["candidate"]
                decision = {
                    "reason": "Явно заданное решение синтетической модели",
                    "useful": candidate["id"] in links,
                }
            return json.dumps(decision, ensure_ascii=False)

        faithful_calls = MagicMock(side_effect=faithful_response)
        monkeypatch.setattr(module.local_rag_model, "_invoke_pipeline", faithful_calls)
        result.faithful_calls = faithful_calls
        return result

    return configure


@pytest.fixture
def synthetic_rag_service(app_client, monkeypatch, temp_notes_dir):
    """Fake only external embedding/Qdrant/model boundaries, keeping RAG wiring real."""
    import app as module

    def configure(notes, answer, cited_titles=None):
        points = []
        for index, (title, content) in enumerate(notes.items()):
            path = temp_notes_dir / f"{title}.md"
            path.write_text(content, encoding="utf-8")
            note_id = module._note_identifier(title, path.name, str(path))
            module.notes_data[title] = {
                "content": content, "tags": [], "id": note_id,
                "filename": path.name, "filepath": str(path),
            }
            points.append(SimpleNamespace(
                id=f"synthetic-chunk-{index}", score=0.9 - index * 0.01,
                payload={"title": title, "text": content, "tags": [], "note_id": note_id},
            ))
        searches = []
        received_contexts = []

        class SyntheticQdrant:
            def health_check(self):
                return True

            def search_hybrid(self, vector, sparse_vector, top_k):
                searches.append({"vector": vector, "top_k": top_k})
                return points[:top_k]

        def generate_grounded_answer(query, contexts, **kwargs):
            received_contexts.append(list(contexts))
            selected = [item for item in contexts if cited_titles is None or item["title"] in cited_titles]
            return json.dumps({
                "answer": answer,
                "citations": [{"source_id": item["source_id"], "quote": item["text"]} for item in selected],
                "insufficient_information": not bool(selected),
            })

        monkeypatch.setattr(module, "qdrant_service", SyntheticQdrant())
        monkeypatch.setattr(module, "use_qdrant", True)
        monkeypatch.setattr(module, "_qdrant_note_chunk_ids", {})
        module._clear_qdrant_health_cache()
        monkeypatch.setattr(module, "generate_embedding", lambda *args, **kwargs: [0.1, 0.2, 0.3])
        monkeypatch.setattr(module.local_rag_model, "generate_grounded_answer", generate_grounded_answer)
        return SimpleNamespace(searches=searches, received_contexts=received_contexts)

    return configure


@pytest.fixture
def reset_app_state():
    """
    РЎР±СЂР°СЃС‹РІР°РµС‚ РіР»РѕР±Р°Р»СЊРЅРѕРµ СЃРѕСЃС‚РѕСЏРЅРёРµ РїСЂРёР»РѕР¶РµРЅРёСЏ РјРµР¶РґСѓ С‚РµСЃС‚Р°РјРё.

    Yields:
        None
    """
    yield

    # РћС‡РёС‰Р°РµРј РёРјРїРѕСЂС‚РёСЂРѕРІР°РЅРЅС‹Р№ РјРѕРґСѓР»СЊ app
    if 'app' in sys.modules:
        import app
        if hasattr(app, 'notes_data'):
            app.notes_data.clear()


@pytest.fixture
def mock_local_rag_model():
    """
    РЎРѕР·РґР°РµС‚ РјРѕРє РґР»СЏ Р»РѕРєР°Р»СЊРЅРѕР№ RAG РјРѕРґРµР»Рё.

    Returns:
        MagicMock: РњРѕРє LocalRagModel СЃ РЅР°СЃС‚СЂРѕРµРЅРЅС‹РјРё РјРµС‚РѕРґР°РјРё
    """
    mock_model = MagicMock()
    mock_model.name = "test-local-rag"
    mock_model.generate_answer.return_value = "Р›РѕРєР°Р»СЊРЅС‹Р№ РѕС‚РІРµС‚ РЅР° Р·Р°РїСЂРѕСЃ"

    return mock_model


@pytest.fixture
def sample_rag_contexts():
    """
    Р’РѕР·РІСЂР°С‰Р°РµС‚ РїСЂРёРјРµСЂС‹ РєРѕРЅС‚РµРєСЃС‚РѕРІ РґР»СЏ RAG Р·Р°РїСЂРѕСЃРѕРІ.

    Returns:
        list: РЎРїРёСЃРѕРє РєРѕРЅС‚РµРєСЃС‚РѕРІ СЃ Р·Р°РјРµС‚РєР°РјРё
    """
    return [
        {
            "title": "Р—Р°РјРµС‚РєР° 1",
            "snippet": "РўРµРєСЃС‚ Р·Р°РјРµС‚РєРё Рѕ Python",
            "tags": ["python", "coding"],
            "score": 2
        },
        {
            "title": "Р—Р°РјРµС‚РєР° 2",
            "snippet": "РРЅС„РѕСЂРјР°С†РёСЏ Рѕ РјР°С€РёРЅРЅРѕРј РѕР±СѓС‡РµРЅРёРё",
            "tags": ["ai", "ml"],
            "score": 1
        }
    ]


# Markers РґР»СЏ РєР°С‚РµРіРѕСЂРёР·Р°С†РёРё С‚РµСЃС‚РѕРІ
def pytest_configure(config):
    """
    РќР°СЃС‚СЂРѕР№РєР° pytest РјР°СЂРєРµСЂРѕРІ РїСЂРё РёРЅРёС†РёР°Р»РёР·Р°С†РёРё.

    Args:
        config: pytest config РѕР±СЉРµРєС‚
    """
    config.addinivalue_line(
        "markers", "unit: Р‘С‹СЃС‚СЂС‹Рµ РёР·РѕР»РёСЂРѕРІР°РЅРЅС‹Рµ unit С‚РµСЃС‚С‹"
    )
    config.addinivalue_line(
        "markers", "integration: Integration С‚РµСЃС‚С‹ СЃ РІРЅРµС€РЅРёРјРё Р·Р°РІРёСЃРёРјРѕСЃС‚СЏРјРё"
    )
    config.addinivalue_line(
        "markers", "api: API endpoint С‚РµСЃС‚С‹"
    )
    config.addinivalue_line(
        "markers", "rag: RAG РјРѕРґРµР»СЊ С‚РµСЃС‚С‹"
    )
    config.addinivalue_line(
        "markers", "slow: РњРµРґР»РµРЅРЅС‹Рµ С‚РµСЃС‚С‹"
    )
    config.addinivalue_line(
        "markers", "smoke: Smoke С‚РµСЃС‚С‹ Р±Р°Р·РѕРІРѕР№ С„СѓРЅРєС†РёРѕРЅР°Р»СЊРЅРѕСЃС‚Рё"
    )

