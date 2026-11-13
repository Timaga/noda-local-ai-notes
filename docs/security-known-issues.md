# Dependency security status

Reviewed on **2026-11-13** for the **1.0.2-beta.17** private prerelease: 109 hash-pinned Windows runtime distributions and 282 npm dependency entries. Dependency updates do not constitute security approval for a public release.

## Remediation of the previous 19 repository alerts

All declared versions affected by the original 19 GitHub alerts have been replaced with versions outside their published vulnerable ranges. These are package updates, not alert dismissals or scanner exclusions. GitHub's default-branch alert state is checked separately after the source update reaches that branch.

| Component | Previous version | Updated version | Original alerts addressed |
| --- | --- | --- | --- |
| minimatch | 9.0.9 / 10.2.6 | 11.0.8 for the affected packaging consumers | 1 |
| filelock | 3.20.0 | 4.2.1 | 4 |
| setuptools | 80.9.0 | 84.1.0 | 2 |
| fsspec | 2024.3.1 | 2026.6.0 | 1 |
| datasets | 2.19.0 | 5.0.1 | 1 |
| torch | 2.10.0+cpu | 2.13.0+cpu | 1 |
| Starlette | 0.49.3 | 1.3.1 | 5 |
| Black (development) | 25.1.0 | 26.10.1 | 2 |
| pytest (development) | 8.3.4 | 9.0.3 | 1 |
| Pylint (development) | 3.3.5 | 4.0.9 | 1 |

FastAPI is updated to 0.135.0 alongside Starlette; pytest-asyncio is updated to 1.3.0 alongside pytest. The datasets/fsspec pair is resolved together. Other runtime pins are retained where compatible. Updated datasets no longer requires pyarrow-hotfix.

The runtime lock also pins **pip 26.3** to address [GHSA-qwm4-qh6w-59xr](https://github.com/advisories/GHSA-qwm4-qh6w-59xr) in the installer supplied by ensurepip. The existing hashed installation uses the explicit official PyPI index and replaces pip before installing development requirements. That command does not use a private index or user pip configuration.

The complete npm audit, including build tools, reports **0 vulnerabilities**; production-only audit also reports **0**. This does not establish that every native component, model or Python dependency is safe.

## Scoped packaging overrides

electron-builder 26.18.1 and @electron/universal 2.0.3 still request affected minimatch versions. Two overrides select 11.0.8 only for minimatch ranges `>=7 <11.0.1` below those parents. Legacy minimatch 3/5 consumers retain their callable APIs. A global override would break those consumers and is not used.

Regression checks cover the actual FileMatcher, include/exclude/re-include rules, dotfiles, Windows separators, directory comparison and ASAR creation/extraction. A real Windows Setup build is also required before distribution. macOS universal packaging is outside Noda's supported Windows release target.

**Maintenance:** Tim Buglaev should review the overrides on the next electron-builder or universal upgrade. Remove them once upstream accepts patched minimatch and the audit, regression tests and Windows packaging pass without overrides. Existing upstream deprecation warnings are separate from vulnerability findings and are not suppressed.

## Remaining dependency risks outside those 19 alerts

The fresh official PyPI package-level scan queried all 109 locked distributions successfully and still identifies two affected packages: Accelerate and DiskCache. The separate PT2 source-review concern below remains even though that advisory is absent from the newer Torch version's package metadata.

- **Accelerate 1.11.0:** [GHSA-4j2p-28q2-5m79](https://github.com/advisories/GHSA-4j2p-28q2-5m79) concerns paths in sharded checkpoint metadata. The newer 1.15.0 package's clean metadata is not accepted as proof of a fix: source review still found the unsafe checkpoint-path handling and the proposed upstream fixes were not merged. The existing pin is retained instead of hiding the finding through a cosmetic upgrade. Transformers can use Accelerate through device mapping; untrusted checkpoints remain a trust boundary.
- **DiskCache 5.6.3:** [GHSA-w8v5-vhqr-4h9v](https://github.com/advisories/GHSA-w8v5-vhqr-4h9v) has no published patched version. llama-cpp-python requires it. No application cache construction was found, but its presence remains a dependency risk; do not load attacker-writable cache contents.
- **PyTorch PT2 loading:** version 2.13.0 addresses the separate TorchScript advisory. It does not establish a fix for [GHSA-33x2-ppm4-v46v](https://github.com/advisories/GHSA-33x2-ppm4-v46v), whose reviewed range/fix information is incomplete. Source review still found PT2 pickle-loading behavior. Noda has no direct PT2 loader call, but no global claim of safe untrusted model loading is made.

A zero GitHub alert count would not resolve these separate findings. No exceptions are accepted on the owner's behalf. Legacy training permits remote model code and is not a safe loader for arbitrary checkpoints. Package-level scans also do not individually audit every vendored/native component; pip's vendored libraries have separate provenance in the legal inventory.

## Verification and release boundaries

Validation uses a fresh external Windows/Python 3.13 environment installed from the exact wheel lock, pip consistency checks, the repository's Python/Node suites, and synthetic real-library compatibility cases. License records are regenerated from matching artifacts. Record actual CI results and the installer checksum in release notes before calling an artifact verified.

The beta.16 tag and installer retain their original dependencies. Updating source does not retroactively patch a downloaded installation; use a separately versioned, verified Setup to update the application.

Separate open findings include Electron IPC/document validation, experimental training/export, optional diagnostic previews and developer-model rights; see [COMPLIANCE.md](COMPLIANCE.md). Clean-machine installation, real-model inference, recovery, native fuzzing and independent legal/regulatory review remain separate checks. Report vulnerabilities using [SECURITY.md](../SECURITY.md).

Scans transmit public package coordinates only. Source code, private notes and credentials are not sent to external analyzers.
