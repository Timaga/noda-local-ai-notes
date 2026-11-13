"""Real Flask project lifecycle over JSON lines; temporary vaults, no models/TCP."""

import json
import logging
import os
from pathlib import Path
import sys
import threading
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from flask import Flask
from backend.routes.register import register_app_routes
from backend.services.note_generation_queue import NoteGenerationQueue

app = module = None


def command(message):
    global app, module
    if message["op"] == "stop":
        if module is not None:
            module.note_generation_queue.close()
        app = module = None
        return {"ok": True}
    if message["op"] == "boot":
        command({"op": "stop"})
        for key, value in message["environment"].items():
            os.environ[key] = value
        os.environ["TEST_GUI_SHUTDOWN_TOKEN"] = "synthetic-control-token"
        notes = Path(os.environ["NOTES_DIR"])
        queue = NoteGenerationQueue(
            10,
            30,
            lambda *_args, **_kwargs: {},
            logging.getLogger(__name__),
            notes_dir=notes,
        )
        collection = os.environ["QDRANT_COLLECTION_NAME"]
        module = SimpleNamespace(
            NOTES_DIR=notes,
            note_generation_queue=queue,
            backend_config=SimpleNamespace(COLLECTION_NAME=collection),
            qdrant_service=SimpleNamespace(collection_name=collection),
            _notes_cache_lock=threading.RLock(),
            notes_data={},
            _notes_snapshot={},
            _qdrant_index_state={},
            use_qdrant=False,
            _qdrant_enabled=lambda: False,
            _make_json_safe=lambda value: value,
            _schedule_backend_exit=lambda: True,
        )
        app = Flask(__name__)
        app.config["TESTING"] = True
        register_app_routes(app, SimpleNamespace(module=module))
        return {"ok": True}
    if message["op"] == "http":
        response = app.test_client().open(
            message["path"],
            method=message.get("method", "GET"),
            headers=message.get("headers", {}),
        )
        return {"status": response.status_code, "body": response.get_json()}
    raise ValueError("Unknown fixture operation")


try:
    for line in sys.stdin:
        try:
            result = command(json.loads(line))
        except Exception as error:
            result = {"fixture_error": type(error).__name__, "message": str(error)}
        print(json.dumps(result), flush=True)
finally:
    command({"op": "stop"})
