import os


def _safe_int(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_float(value, default):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


# Who: Tim Buglaev
# When: 2026-06-14
# What: Use an explicit IPv4 loopback default to avoid localhost resolving to a
#       different Docker/IPv6 listener than the managed local Qdrant process.
QDRANT_URL = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
QDRANT_PORT = _safe_int(os.environ.get("QDRANT_PORT"), 6333)
COLLECTION_NAME = os.environ.get("QDRANT_COLLECTION_NAME", "notes")
VECTOR_SIZE = _safe_int(os.environ.get("QDRANT_VECTOR_SIZE"), 768)
# Who: Tim Buglaev
# When: 2026-06-22
# What: Use the same-dimension multilingual MPNet embedder by default so Russian note
#       retrieval is meaningful without requiring a destructive Qdrant schema migration.
EMBEDDING_MODEL = os.environ.get(
    "RAG_EMBEDDING_MODEL",
    "sentence-transformers/paraphrase-multilingual-mpnet-base-v2",
)
QDRANT_AUTOSTART = os.environ.get("QDRANT_AUTOSTART", "1")
RAG_LOCAL_MODEL_ID = os.environ.get("RAG_LOCAL_MODEL_ID", "sentence-transformers/all-MiniLM-L6-v2")
QDRANT_HTTP_TIMEOUT = max(1.0, min(_safe_float(os.environ.get("QDRANT_HTTP_TIMEOUT"), 15.0), 60.0))
QDRANT_READY_RETRIES = _safe_int(os.environ.get("QDRANT_READY_RETRIES"), 5)
QDRANT_READY_DELAY = _safe_float(os.environ.get("QDRANT_READY_DELAY"), 1.0)

# Autolinker and Autotagger configuration
MAX_LINKS = _safe_int(os.environ.get("MAX_LINKS"), 15)
MAX_TAGS = _safe_int(os.environ.get("MAX_TAGS"), 8)
TOP_K_SEARCH = _safe_int(os.environ.get("TOP_K_SEARCH"), 50)
SIM_THRESHOLD = _safe_float(os.environ.get("SIM_THRESHOLD"), 0.30)
UPDATE_ON_SAVE = os.environ.get("UPDATE_ON_SAVE", "1").strip().lower() in ("1", "true", "yes", "on")
