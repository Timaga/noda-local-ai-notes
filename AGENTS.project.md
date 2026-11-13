# Noda repository evidence

This manifest records the current Windows source layout and local commands.
It supplements applicable agent instructions; it does not prove release readiness.

## Environment and ownership

- Supported release target: Windows 10/11 x64 with AVX2. Other platforms are unverified.
- Tested tools: Node.js 22.21.0, npm 10.9.4, CPython 3.13.14, Windows PowerShell 5.1.
- Frontend versions come from `frontend/package.json` and `package-lock.json`.
- The shipped Python/Qdrant/llama.cpp versions and archive hashes are pinned in
  `scripts/windows-portable/runtime-assets.json`; Python wheels are pinned in
  `scripts/windows-portable/requirements-win-x64.lock`.
- Repository owner and CODEOWNER: `Timaga` (Tim Buglaev). GitHub access and active
  branch/tag protections must be verified separately before public availability.
  Incident escalation is via `SECURITY.md`; no response-time commitment is declared.
  Local checks do not replace maintainer review.

## Commands

Run from the repository root in PowerShell. Installs and full packaging need network access.

```powershell
npm --prefix frontend ci
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -I -m pip --isolated install --index-url https://pypi.org/simple --require-hashes --only-binary=:all: --retries 2 --timeout 30 -r scripts/windows-portable/requirements-win-x64.lock
.\.venv\Scripts\python.exe -I -m pip --isolated install --index-url https://pypi.org/simple --retries 2 --timeout 30 -r requirements-test.txt
.\.venv\Scripts\python.exe -I -m pip --isolated check
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/test.ps1
```

`scripts/test.ps1 -Suite python` runs the curated paths in `tests/runtime-tests.txt`
with branch coverage. `-Suite node` runs `tests/frontend_*.test.js` and
`tests/frontend/*.test.cjs`. Both suites need the selected Python interpreter.
Use `-Python <absolute-python-path>` for an existing environment. The runner passes
the test-only `NODA_TEST_PYTHON` override to the cross-language integration fixture
and restores the previous environment when finished.

Results, coverage, benchmark storage and command records go to an external temporary
folder. `-ResultsDirectory <absolute-folder>` can select another folder outside this
repository. A fresh installation of the declared dependencies is a separate
verification step; a passing run with an existing environment does not prove it.

```powershell
# Stage files and configuration without downloading or packaging Electron.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/windows-portable/build.ps1 -StageOnly
# Create a local source distribution.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/windows-portable/build.ps1 -SourceOnly
# Build the Windows installer locally. The builder uses --publish never.
npm --prefix frontend run build
# Available frontend dependency audit; evaluate findings rather than suppressing them.
npm --prefix frontend audit
```

Build output defaults to a new directory under ignored `output/`. Pass
`-OutputDirectory <new-empty-absolute-folder>` to the PowerShell build script to choose
an external location. GitHub Actions runs the Windows suites defined in
`.github/workflows/verify.yml`; see `docs/CI.md` for the pinned setup and limitations.
No project-wide lint, typecheck, formatter or secret-scanner command is declared;
report unrun checks and remaining risks.

## Architecture and data boundaries

- `frontend/` contains Electron main-process orchestration, the `preload.js` IPC
  bridge, renderer views and localization. Keep privileged filesystem/process work
  in the main process. Preserve context isolation and sender validation.
- `backend/app_runtime.py` starts the Python application. `runtime_layers/` composes
  application services; `routes/` handles HTTP contracts; `services/` contains queue
  and persistence behavior; `ru_pipeline/` implements local note processing.
  Preserve the local request guard and project context checks across these boundaries.
- Markdown files in project folders are the source notes. SQLite under
  `.noda-queue/` preserves generation jobs and original text. Qdrant collections hold
  derived search fragments/vectors. Electron settings, chat and drafts belong to the
  application profile. These user data and downloaded models are outside source control.
- Preserve byte-exact pinned manifests and third-party license texts. The CPU asset
  manifest has a runtime SHA256 check; its `.gitattributes` exception is intentional.

## Safe verification and releases

- `tests/conftest.py` establishes temporary notes/model paths and blocks live sockets
  before collection. Keep it intact. Fixtures must remain synthetic; ordinary tests
  must not access real note folders, model services, credentials or user profiles.
- `tests/fixtures/project_switch_rpc.py` exercises the real backend through a local
  subprocess with synthetic projects; the Node tests supply its Python interpreter.
  Files ending in `.electron.cjs` are separate manual/native harnesses, not ordinary
  Node test entries. Do not describe an unrun native or model smoke check as passing.
- Keep outputs, caches, dependencies, model weights and personal data out of Git.
  Ignore rules are a guardrail; inspect the actual staged files before publication.
- Review `LICENSE`, `NOTICE`, `LICENSES/` and `THIRD_PARTY_NOTICES.md` before redistributing.
  Noda's license does not replace the separate licenses of dependencies or models.
- Build and review locally. Pushing, publishing releases or uploading artifacts
  requires the user's explicit instruction. Do not update an installed application
  or replay a user's queue as part of source/repository verification.
- Before an application upgrade, back up project folders and the application profile
  while Noda is closed. Source changes alone do not prove data-format rollback safety.
