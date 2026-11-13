import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts" / "windows-portable"


def run_powershell(script, *args, env=None):
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-File", str(SCRIPTS / script), *map(str, args)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


@pytest.mark.skipif(sys.platform != "win32", reason="Windows portable package")
@pytest.mark.parametrize("installer", [False, True], ids=["portable", "setup"])
def test_staged_runtime_excludes_personal_and_developer_state(tmp_path, installer):
    output = tmp_path / "portable build"
    options = ["-Installer"] if installer else []
    result = run_powershell("build.ps1", "-OutputDirectory", output, "-StageOnly", *options)
    assert result.returncode == 0, result.stderr
    source = output / "noda-runtime"
    assert (source / "backend" / "app_runtime.py").is_file()
    assert (source / "scripts" / "windows-portable" / "provision.ps1").is_file()
    assert (source / "scripts" / "windows-portable" / "embedding-profile.json").read_bytes() == (
        SCRIPTS / "embedding-profile.json"
    ).read_bytes()
    assert not any((source / excluded).exists() for excluded in (
        ".env", ".venv", "storage", "models", "output", "frontend", "backend/notes", "backend/.cache",
    ))
    target = "installer" if installer else "portable"
    config = json.loads((output / f"electron-builder.{target}.json").read_text(encoding="utf-8"))
    assert config["extraResources"] == [{"from": str(source), "to": "noda-runtime"}]
    for notice in ("LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "scripts/check-licenses.py"):
        assert (source / notice).read_bytes() == (ROOT / notice).read_bytes()
    license_files = [file for file in (ROOT / "LICENSES").rglob("*") if file.is_file()]
    assert license_files
    for file in license_files:
        assert (source / file.relative_to(ROOT)).read_bytes() == file.read_bytes()
    if installer:
        assert config["win"]["target"] == "nsis"
        assert config["nsis"]["artifactName"] == "Noda-Setup-${version}-x64.exe"
        assert config["nsis"]["oneClick"] is False
        assert config["nsis"]["perMachine"] is False
        assert config["nsis"]["allowElevation"] is False
        assert config["nsis"]["runAfterFinish"] is False
        assert config["nsis"]["installerLanguages"] == ["en_US"]
        assert Path(config["nsis"]["include"]) == SCRIPTS / "installer.nsh"
        assert config["nsis"]["deleteAppDataOnUninstall"] is False
        assert config["nsis"]["packElevateHelper"] is False
    else:
        assert config["win"]["target"] == "dir"
        assert "nsis" not in config


@pytest.mark.skipif(sys.platform != "win32", reason="Windows portable package")
def test_source_export_contains_standalone_checks_and_storage_docs(tmp_path):
    output = tmp_path / "source build"
    result = run_powershell("build.ps1", "-OutputDirectory", output, "-SourceOnly")
    assert result.returncode == 0, result.stderr
    source = output / "Noda-source"
    files = (
        "scripts/windows-portable/build.ps1", "scripts/windows-portable/signing.ps1",
        "scripts/windows-portable/installer.nsh", "docs/note-library-storage.md",
        "tests/test_windows_portable_packaging.py", "tests/frontend/portable_runtime.test.cjs",
        "tests/frontend/portable_runtime_cache.test.cjs", "tests/frontend/portable_setup_progress.test.cjs",
        "tests/frontend/notes_note_actions.test.cjs", "tests/frontend/quick_capture_project.test.cjs",
    )
    assert all((source / file).read_bytes() == (ROOT / file).read_bytes() for file in files)
    for file in ("tests/conftest.py", "tests/runtime-tests.txt", "scripts/test.ps1", "requirements-test.txt",
                 "pytest.ini", "AGENTS.project.md", "LICENSES/manifest.json", "CONTRIBUTING.md"):
        assert (source / file).read_bytes() == (ROOT / file).read_bytes()
    assert not list(source.rglob("__pycache__"))


@pytest.mark.skipif(sys.platform != "win32", reason="Windows portable package")
@pytest.mark.parametrize("missing", [True, False], ids=["missing", "tampered"])
def test_build_rejects_invalid_required_legal_notice(tmp_path, missing):
    import shutil

    clone = tmp_path / "source"
    shutil.copytree(ROOT, clone, ignore=shutil.ignore_patterns(
        ".git", "node_modules", ".venv", "__pycache__", ".benchmarks", "NOTICE",
    ))
    if not missing:
        (clone / "NOTICE").write_text("An incomplete notice", encoding="utf-8")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
         str(clone / "scripts/windows-portable/build.ps1"), "-StageOnly", "-OutputDirectory", str(tmp_path / "out")],
        cwd=clone, capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode != 0
    expected = "A required license input is missing: NOTICE" if missing else "The license bundle integrity check failed: NOTICE"
    assert expected in result.stderr


@pytest.mark.skipif(sys.platform != "win32", reason="Windows portable package")
def test_missing_vc_runtime_requires_consent_before_download(tmp_path):
    # The app isolates Windows PowerShell from a PowerShell 7 parent for this launch.
    env = {
        **{key: value for key, value in os.environ.items() if key.lower() != "psmodulepath"},
        "NODA_TEST_INSTALL_ROOT": str(tmp_path / "runtime"),
        "NODA_TEST_SOURCE_ROOT": str(ROOT),
        "NODA_TEST_PROVISION": str(SCRIPTS / "provision.ps1"),
    }
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
         "Import-Module Microsoft.PowerShell.Utility,Microsoft.PowerShell.Management; "
         "function Test-Path { param([string]$LiteralPath,[string]$PathType) "
         "if ($LiteralPath -match 'System32[\\\\/].*140.*\\.dll$') { return $false }; "
         "Microsoft.PowerShell.Management\\Test-Path @PSBoundParameters }; "
         "& $env:NODA_TEST_PROVISION -InstallRoot $env:NODA_TEST_INSTALL_ROOT -SourceRoot $env:NODA_TEST_SOURCE_ROOT; "
         "exit $LASTEXITCODE"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 1, result.stderr
    assert [json.loads(line) for line in result.stdout.splitlines()] == [
        {"phase": "prerequisite", "status": "failed"},
    ], result.stderr
    assert "Approve installation and retry" in result.stderr
    assert not list((tmp_path / "runtime").glob(".setup-*"))


@pytest.mark.skipif(sys.platform != "win32", reason="Windows native process creation")
def test_provisioner_native_processes_have_no_console(tmp_path):
    probe = tmp_path / "native probe.py"
    probe.write_text(
        "import ctypes, json, subprocess, sys\n"
        "kernel = ctypes.windll.kernel32\n"
        "kernel.GetConsoleWindow.restype = ctypes.c_void_p\n"
        "pids = (ctypes.c_uint * 8)()\n"
        "print(json.dumps({'window': bool(kernel.GetConsoleWindow()), "
        "'shared_console': kernel.GetConsoleProcessList(pids, len(pids)) > 1, 'args': sys.argv[1:]}))\n"
        "if sys.prefix != sys.base_prefix:\n"
        "    subprocess.run([sys.executable, '-c', 'import ctypes; "
        "assert not ctypes.windll.kernel32.GetConsoleCP()'], check=True)\n"
        "print('native stderr', file=sys.stderr)\n",
        encoding="utf-8",
    )
    script = tmp_path / "test-provisioner.ps1"
    script.write_text(
        r"""
$ErrorActionPreference = 'Stop'
$tree = [Management.Automation.Language.Parser]::ParseFile($env:NODA_TEST_PROVISION, [ref]$null, [ref]$null)
foreach ($name in @('Invoke-Native', 'Initialize-PythonEnvironment')) {
    $definition = $tree.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $false)
    . ([scriptblock]::Create($definition.Extent.Text))
}
Invoke-Native $env:NODA_TEST_PYTHON @('-I', $env:NODA_TEST_PROBE, 'argument with spaces', 'quote"inside', 'trailing\', '')
Initialize-PythonEnvironment $env:NODA_TEST_PYTHON $env:NODA_TEST_VENV
$pythonw = Join-Path $env:NODA_TEST_VENV 'Scripts/pythonw.exe'
Invoke-Native $pythonw @('-I', '-m', 'pip', '--isolated', '--version')
Invoke-Native $pythonw @('-I', $env:NODA_TEST_PROBE)
try {
    Invoke-Native $env:NODA_TEST_PYTHON @('-I', '-c', 'raise SystemExit(7)')
    throw 'The child exit status was ignored.'
} catch {
    if ($_.Exception.Message -ne 'python.exe exited with code 7.') { throw }
}
[Console]::Out.WriteLine('done')
""",
        encoding="utf-8",
    )
    env = {
        **{key: value for key, value in os.environ.items() if key.lower() != "psmodulepath"},
        "NODA_TEST_PROVISION": str(SCRIPTS / "provision.ps1"),
        "NODA_TEST_PYTHON": sys._base_executable,
        "NODA_TEST_PROBE": str(probe),
        "NODA_TEST_VENV": str(tmp_path / "temporary venv"),
    }
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script)],
        cwd=tmp_path, env=env, capture_output=True, text=True, timeout=60,
        creationflags=subprocess.CREATE_NO_WINDOW, check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "done"
    records = [json.loads(line) for line in result.stderr.splitlines() if line.startswith("{")]
    assert records == [
        {"window": False, "shared_console": False, "args": ["argument with spaces", 'quote"inside', "trailing\\", ""]},
        {"window": False, "shared_console": False, "args": []},
    ]
    assert result.stderr.splitlines().count("native stderr") == 2


def test_embedding_cache_publishes_pinned_ref_and_works_offline(tmp_path, monkeypatch):
    pytest.importorskip("huggingface_hub")
    spec = importlib.util.spec_from_file_location("portable_embedding", SCRIPTS / "cache-embedding.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    root = tmp_path / "test-model"
    folder = root / "snapshots" / module.REVISION
    weights = b"synthetic weights"
    for name in module.FILES:
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(weights if name == "model.safetensors" else b"fixture")
    monkeypatch.setattr(module, "WEIGHTS_BYTES", len(weights))
    monkeypatch.setattr(module, "WEIGHTS_HASH", hashlib.sha256(weights).hexdigest())

    def offline_snapshot(repo, **options):
        assert repo == module.REPOSITORY
        assert options["local_files_only"] is True
        assert options["revision"] == module.REVISION
        assert options["token"] is False
        return str(folder)

    monkeypatch.setattr(module, "snapshot_download", offline_snapshot)
    module.cache_embedding(tmp_path)
    module.cache_embedding(tmp_path)
    assert (root / "refs" / "main").read_text(encoding="ascii") == module.REVISION
    assert (folder / ".noda-verified").is_file()
