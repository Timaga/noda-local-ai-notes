"""Selected model identity and portable path/launch contracts, no weight reads."""

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.ru_pipeline import native_assets as assets
from backend.ru_pipeline import native_server as server


def test_packaged_relative_manifest_has_only_selected_models_and55_runtime_files():
    value = assets.load_manifest()
    assert set(value["models"]) == {"qwen25_3b", "qwen35_4b", "qwen3_4b_instruct"}
    assert len(value["runtime"]["files"]) == 55
    assert all("output/" not in row["path"] for row in value["runtime"]["files"])
    assert all(not Path(row["path"]).is_absolute() for row in value["models"].values())


@pytest.mark.parametrize("key", ["qwen25_3b", "qwen35_4b", "qwen3_4b_instruct"])
def test_selected_native_launch_is_full_context_single_slot_offline(tmp_path, key):
    config = SimpleNamespace(repo_root=tmp_path, port=19189)
    item = assets.profile(config, key)
    args = assets.command(config, item)
    assert args[args.index("--model") + 1] == str(item.model)
    assert args[args.index("--host") + 1] == "127.0.0.1"
    assert args[args.index("--port") + 1] == "19189"
    assert args[args.index("--ctx-size") + 1] == "8192"
    assert args[args.index("--parallel") + 1] == "1"
    assert args[args.index("--fit") + 1] == "off"
    assert "--offline" in args and "--no-context-shift" in args
    assert item.parameters < 7_000_000_000


@pytest.mark.parametrize(
    "value", ["../foreign", "/foreign", "C:/foreign", "a\\b", "a/../../b"]
)
def test_nonportable_or_traversal_asset_paths_refused(tmp_path, value):
    with pytest.raises(ValueError):
        assets.relative(tmp_path, value)


@pytest.mark.parametrize("key", ["qwen25_7b", "foreign", None])
def test_only_selected_model_keys_allowed(tmp_path, key):
    with pytest.raises(ValueError):
        assets.profile(SimpleNamespace(repo_root=tmp_path), key)


def test_manifest_tamper_refused_before_json_decode(tmp_path, monkeypatch):
    path = tmp_path / "manifest.json"
    path.write_bytes(b"not JSON")
    monkeypatch.setattr(assets, "MANIFEST", path)
    with pytest.raises(ValueError, match="manifest changed"):
        assets.load_manifest()


@pytest.mark.parametrize("port", [0, True, 65536, "19189"])
def test_port_contract_refused(tmp_path, port):
    item = assets.profile(SimpleNamespace(repo_root=tmp_path), "qwen35_4b")
    with pytest.raises(ValueError):
        assets.command(SimpleNamespace(port=port), item)


@pytest.mark.parametrize(
    "base",
    [
        "https://127.0.0.1:19189",
        "http://localhost:19189",
        "http://192.0.2.1:19189",
        "http://user@127.0.0.1:19189",
        "http://127.0.0.1:19189/foreign",
    ],
)
def test_metadata_http_cannot_leave_owned_numeric_loopback(base):
    with pytest.raises(ValueError):
        server.get_json(base, "/health")


def test_metadata_redirect_refused():
    with pytest.raises(ValueError):
        server.NoRedirect().redirect_request(
            None, None, None, None, None, "https://example.invalid"
        )


def test_normal_shutdown_requires_actual_integer_zero():
    normal = {
        "exit_code": 0,
        "ctrl_c_sent": True,
        "forced": False,
        "errors": [],
        "owned_process_retired": True,
    }
    assert server.normal(normal)
    assert not server.normal({**normal, "exit_code": False})


@pytest.fixture
def complete_asset_fixture(tmp_path, monkeypatch):
    binary = tmp_path / "tools/bin"
    binary.mkdir(parents=True)
    files = []
    for index in range(55):
        path = binary / ("llama-server.exe" if index == 0 else f"runtime{index}.dll")
        data = f"synthetic runtime bytes {index}".encode("ascii")
        path.write_bytes(data)
        files.append(
            {
                "path": path.relative_to(tmp_path).as_posix(),
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
    model = tmp_path / "models/selected.gguf"
    model.parent.mkdir()
    model.write_bytes(b"synthetic approved model bytes")
    manifest = {
        "runtime": {"executable": "tools/bin/llama-server.exe", "files": files},
        "models": {
            "qwen35_4b": {
                "path": "models/selected.gguf",
                "sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
                "bytes": model.stat().st_size,
                "parameters": 4659865088,
                "alias": "selected",
                "nominal_billion": 4,
            }
        },
    }
    monkeypatch.setattr(assets, "load_manifest", lambda: manifest)
    config = SimpleNamespace(repo_root=tmp_path)
    return config, assets.profile(config, "qwen35_4b"), manifest


def test_all55_runtime_assets_and_selected_model_verified(complete_asset_fixture):
    config, item, manifest = complete_asset_fixture
    assert assets.verify_assets(config, item) == item
    assert len(manifest["runtime"]["files"]) == 55


def test_last_runtime_asset_digest_change_refused(complete_asset_fixture):
    config, item, manifest = complete_asset_fixture
    path = config.repo_root / manifest["runtime"]["files"][-1]["path"]
    original = path.read_bytes()
    path.write_bytes(b"X" + original[1:])
    with pytest.raises(ValueError, match="dependency bytes changed"):
        assets.verify_assets(config, item)


def test_model_digest_change_refused_even_with_same_size(complete_asset_fixture):
    config, item, _ = complete_asset_fixture
    original = item.model.read_bytes()
    item.model.write_bytes(b"X" + original[1:])
    with pytest.raises(ValueError, match="model bytes required"):
        assets.verify_assets(config, item)
