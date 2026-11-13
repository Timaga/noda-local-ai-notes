# Who: Tim Buglaev
# When: 2026-03-26
# What: Replaced monolithic file body with a deterministic facade loader that executes split
#       architecture parts in order, preserving backward compatibility for imports and runtime behavior.

from pathlib import Path

_PARTS_DIR = Path(__file__).resolve().parent / "model_init_layers"
_PART_FILES = ['01_node_000.py', '02_ensure_local_split_shards.py', '03_initialize_local_model.py']

for _part_name in _PART_FILES:
    _part_path = _PARTS_DIR / _part_name
    _part_code = _part_path.read_text(encoding="utf-8")
    exec(compile(_part_code, str(_part_path), "exec"), globals(), globals())
