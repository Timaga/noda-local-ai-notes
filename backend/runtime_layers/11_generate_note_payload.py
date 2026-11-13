# Who: Tim Buglaev
# When: 2026-03-26
# What: Extracted large module content into ordered architecture parts while preserving execution
#       order and public API through a thin facade loader to keep file size under 600 lines.

from backend.ru_pipeline.config import enabled as _ru_pipeline_enabled


RU_NOTE_PIPELINE_ENABLED = _ru_pipeline_enabled()

def _generate_note_payload(prompt_text, requested_source=None, source_provided=False, *, publication_context=None, mode="organize"):
    try:
        from backend.note_generation import create_note
    except ImportError:
        from note_generation import create_note
    validated = _validate_prompt_text(prompt_text)
    # Leading indentation and trailing spaces may be meaningful Markdown/code.
    prompt = prompt_text if isinstance(prompt_text, str) else validated
    return create_note(sys.modules[__name__], prompt, publication_context=publication_context, mode=mode)


# Who: Tim Buglaev
# When: 2026-03-26
# What: Switched queue bootstrap to injected service implementation so scheduling stays decoupled from
#       app.py internals and can be reused/tested independently.
def _reconcile_queued_publication(context):
    try:
        from backend.services.note_job_recovery import reconcile_publication
    except ImportError:
        from services.note_job_recovery import reconcile_publication
    return reconcile_publication(sys.modules[__name__], context)


_queue_model_initialized = False
note_generation_queue = NoteGenerationQueue(
    max_size=GENERATE_QUEUE_MAX_SIZE,
    job_ttl_seconds=GENERATE_QUEUE_JOB_TTL_SECONDS,
    generate_note_payload=(
        lambda prompt_text, requested_source=None, source_provided=False, publication_context=None, mode="organize": _generate_note_payload(
            prompt_text,
            requested_source=requested_source,
            source_provided=source_provided,
            publication_context=publication_context,
            mode=mode,
        )
    ),
    logger=logger,
    notes_dir=NOTES_DIR,
    reconcile_publication=_reconcile_queued_publication,
    generation_ready=lambda: _queue_model_initialized and (
        RU_NOTE_PIPELINE_ENABLED or not local_rag_model._loading
    ),
)
from backend.project_activation import prepare_project_queue as _prepare_project_queue
_prepare_project_queue(note_generation_queue, _PROJECT_CONFIGURATION)
note_generation_queue.start()


# Who: Tim Buglaev
# When: 2026-03-26
# What: Replaced inline route declarations with modular registration and explicit dependency wiring,
#       reducing app.py coupling while preserving API contracts and runtime behavior.
if not _routes_registered:
    route_dependencies = SimpleNamespace(
        module=sys.modules[__name__],
    )
    register_app_routes(app, route_dependencies)
    _routes_registered = True


if RU_NOTE_PIPELINE_ENABLED:
    MODEL_INIT_RESULT = {"status": "managed_by_ru_pipeline", "profile": "ru-three-stage-v1"}
    print("Selected Russian note pipeline will load its local models per stage")
elif not IS_TEST_ENV:
    try:
        from model_init import initialize_local_model
        print("=== Initializing local RAG model ===")
        MODEL_INIT_RESULT = initialize_local_model()
        print(f"Model initialization result: {MODEL_INIT_RESULT}")
        warmup_ready = local_rag_model.load_model()
        # Who: Tim Buglaev
        # When: 2026-06-14
        # What: Keep startup model-readiness output ASCII-only and report managed
        #       vLLM warmup separately from embedded local model loading.
        if warmup_ready:
            print("Model fully loaded and ready")
        elif str(globals().get("RAG_RUNTIME_PROVIDER", "")).strip().lower() == "vllm_local":
            print("Managed vLLM runtime will be started by the Electron launcher")
        else:
            print("Local model is not loaded into memory yet")
    except Exception as e:
        print(f"[WARNING] Model initialization failed: {e}")
else:
    MODEL_INIT_RESULT = {"status": "skipped", "reason": "test_environment"}
    print("Skipping local model initialization warmup in test environment")

_queue_model_initialized = True

if __name__ == "__main__":
    listen_port = 18741 if portable_runtime_root() and os.environ.get("NODA_BACKEND_PORT") == "18741" else 5000
    # Suppress Flask/click banner to avoid Windows encoding errors (OSError: Windows error 6).
    # DO NOT set WERKZEUG_RUN_MAIN - it breaks werkzeug's socket handling (KeyError: WERKZEUG_SERVER_FD).
    import flask.cli as _flask_cli
    _flask_cli.show_server_banner = lambda *a, **kw: None

    print("=" * 60)
    print(" Flask RAG Application")
    print(f" Server: http://127.0.0.1:{listen_port}")
    print(" Press CTRL+C to quit")
    print("=" * 60)

    app.run(
        host="127.0.0.1",
        port=listen_port,
        debug=False,       # [IMPORTANT] без debug
        use_reloader=False # [IMPORTANT] без перезапускающегося дочернего процесса
    )


