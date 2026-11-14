# Development

Build and validation currently target **Windows x64**. The packaged runtime uses CPython 3.13; use Python 3.13 for the Python checks below. Use Node.js 22.12 or newer within the 22.x line with npm.

Run these commands from the repository root in PowerShell. Dependency installation and packaging can download components from their configured registries and official release sources.

## Install development dependencies

Use the Windows Python launcher to create an isolated Python 3.13 environment:

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -I -m pip --isolated install --index-url https://pypi.org/simple --require-hashes --only-binary=:all: --retries 2 --timeout 30 -r scripts/windows-portable/requirements-win-x64.lock
.\.venv\Scripts\python.exe -I -m pip --isolated install --index-url https://pypi.org/simple --retries 2 --timeout 30 -r requirements-test.txt
.\.venv\Scripts\python.exe -I -m pip --isolated check
npm --prefix frontend ci
```

Install the hashed Windows CPU runtime before the test tools, as in [CI](CI.md). A successful test run in an existing environment does not prove this clean-install sequence; verification in a fresh environment remains a separate gate.

Do not use a personal project or an installed app profile as a test fixture. The tests should use their isolated fixtures and temporary directories.

## Run the source checks

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/test.ps1
```

The runner executes the Python runtime test manifest and the Node regression tests. It writes logs, command records and Python branch-coverage results to a new `%TEMP%\noda-tests-<id>` folder instead of adding generated files to the repository.

Use `-Suite python` or `-Suite node` for a focused run. Pass `-Python C:\path\to\python.exe` to use another environment with the test dependencies installed. Some Node integration checks also invoke Python; create the test environment before running either suite.

Record the exact scope, command and exit status when reporting results. Model inference, a full Windows installation and recovery after a real interruption need separate checks; they are not proven by a unit-test result.

## Build the installer

```powershell
npm --prefix frontend run build
```

The build uses `scripts/windows-portable/build.ps1 -Installer` and prints the resulting executable path. Outputs go to a dedicated release directory. The builder passes `--publish never` and does not upload artifacts.

The release script supports a separate source-only staging mode:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/windows-portable/build.ps1 -SourceOnly -OutputDirectory artifacts/source-check
```

The destination must be empty. Do not use the repository root or an existing project folder as the output directory.

## Check the Windows installer lifecycle

After installing frontend dependencies and building Setup once (to populate the
verified NSIS tool cache), run the opt-in native check with a new absolute output
directory outside the repository:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tests/windows_installer_lifecycle.smoke.ps1 -OutputDirectory C:/Temp/noda-installer-check
```

The check builds a tiny synthetic payload with the production NSIS include and a
unique application ID. It verifies fresh install, upgrade, recovery from an old
uninstaller returning exit 2, locked-file rejection, reparse-point rejection and
uninstall while retaining external notes. It never installs over Noda or opens
personal projects. Its outputs stay in the selected folder. A failure retains
diagnostics; inspect and remove only that fixture's installation if necessary.
This check does not replace validation of the exact release binary on a clean PC.

## Repository boundaries

- `frontend/`: Electron main/preload code and the HTML, CSS and JavaScript interface.
- `backend/`: local Python application, routes, note persistence, queue, indexing and model orchestration.
- `scripts/windows-portable/`: pinned runtime preparation and Windows packaging.
- `tests/`: application regression tests and synthetic fixtures.
- `docs/`: user, contributor and release documentation.

Keep dependencies, caches, virtual environments, runtime profiles, private notes, downloaded models and generated releases out of source control. Do not commit `.env` files or local user paths.

## Before a release

Follow [RELEASING.md](RELEASING.md) and the remaining release acceptance checks. Build from a recorded source revision, retain checksums and verify the exact installer intended for distribution on a clean Windows profile. Review the licenses and notices for each component included in that artifact.
