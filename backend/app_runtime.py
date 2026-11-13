# Who: Tim Buglaev
# When: 2026-03-26
# What: Replaced monolithic file body with a deterministic facade loader that executes split
#       architecture parts in order, preserving backward compatibility for imports and runtime behavior.

from pathlib import Path
import sys

try:
    from backend.project_storage import apply_project_environment
except ImportError:
    from project_storage import apply_project_environment

_PROJECT_CONFIGURATION = apply_project_environment()

try:
    from backend.windows_console import prepare_owned_console_children
except ImportError:
    from windows_console import prepare_owned_console_children

prepare_owned_console_children()

# Who: Tim Buglaev
# When: 2026-06-13
# What: Installed bounded mojibake repair before runtime layers are compiled so legacy
#       mangled Russian strings in prompts/logs are fixed in memory while valid UTF-8 stays unchanged.
try:
    from backend.encoding_utils import install_stdio_mojibake_repair, repair_mojibake_text
except Exception:
    from encoding_utils import install_stdio_mojibake_repair, repair_mojibake_text  # type: ignore

install_stdio_mojibake_repair()
_repair_mojibake_text = repair_mojibake_text

_BACKEND_DIR = Path(__file__).resolve().parent

# Who: Tim Buglaev
# When: 2026-06-14
# What: Add backend/ to sys.path during module execution so legacy absolute imports
#       like import model_init work when launched as python -m backend.app_runtime.
_backend_path = str(_BACKEND_DIR)
if _backend_path not in sys.path:
    sys.path.insert(0, _backend_path)

_PARTS_DIR = _BACKEND_DIR / "runtime_layers"
_PART_FILES = ['01_node_000.py', '02_init_qdrant_service.py', '03_localragmodel.py', '04_create_local_rag_model.py', '05_select_context.py', '06_build_plan_items_from_contexts.py', '07_extract_summary_candidate.py', '08_apply_new_model_path.py', '09_prepare_candidates_from_fallback.py', '10_handle_note_update.py', '11_generate_note_payload.py']

for _part_name in _PART_FILES:
    _part_path = _PARTS_DIR / _part_name
    _part_code = _repair_mojibake_text(_part_path.read_text(encoding="utf-8"))
    exec(compile(_part_code, str(_part_path), "exec"), globals(), globals())
