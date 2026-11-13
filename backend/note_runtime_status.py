"""Read-only status for the selected title method and local server."""

from backend.inference_llama_runtime import server_status_url
from backend.note_title_method import title_method


def note_runtime_status(runtime, provider):
    method = title_method(getattr(runtime, "RAG_NOTE_TITLE_METHOD", "reviewed"))
    result = {
        "note_title_method": {
            "name": method.name,
            "strategy": method.strategy,
            "stages": method.stages,
            "configuration_mode": "launch_only",
        }
    }
    if provider == "llama_cpp_server":
        result["llama_cpp_server"] = {
            "base_url": server_status_url(
                getattr(runtime, "RAG_LLAMA_SERVER_BASE_URL", None)
            ),
            "timeout_seconds": float(
                getattr(runtime, "RAG_LLAMA_SERVER_TIMEOUT_SECONDS", 120.0)
            ),
            "host_policy": "numeric_loopback_only",
            "configuration_mode": "launch_only",
        }
    if getattr(runtime, "RU_NOTE_PIPELINE_ENABLED", False) is True:
        from backend.ru_pipeline.config import PROFILE_ID
        from backend.ru_pipeline.pair_settings import selection_status

        preferences = selection_status(runtime)
        tag_policy = "disabled"
        if preferences["stageEnabled"]["tags"]:
            tag_policy = "existing_then_create" if preferences["newTags"]["enabled"] else "existing_only"
        result["note_pipeline"] = {
            "profile": PROFILE_ID,
            "enabled": True,
            "language": "ru",
            "supported_languages": ["ru", "en"],
            "generated_alphabet_policy": "ru-en-only-v1",
            "model_lifecycle": "per_stage",
            "tag_policy": tag_policy,
            "source_immutable": True,
            **preferences,
        }
    return result
