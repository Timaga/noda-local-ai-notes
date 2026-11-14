# Compliance and publication status

Updated on **2026-11-14** for version **1.0.2**. This records the source repository, dependency declarations and scoped release checks. It is an engineering/licensing review, not a legal opinion or regulatory certification. Live repository/release status is available on GitHub. The owner requires sole-owner write access; additional branch/tag rules are not a publication prerequisite.

## Verified scope

| Area | Verified | Remaining limits |
| --- | --- | --- |
| Project license | Canonical PolyForm Noncommercial 1.0.0, required notice and matching package metadata | Applies to project-owned materials; previous MIT grants and upstream rights remain unchanged. |
| Third-party notices | 317 protected files, including 313 license texts; 109 Python runtime packages and 282 npm lock entries | Native subcomponents and future redistributed bundles need exact-artifact review. |
| Development tools | 21 pinned direct test/development requirements, including Pylint's separate GPL tool license | Development transitive dependencies are not fully locked or inventoried. See [development tools](legal/DEVELOPMENT-TOOLS.md). |
| Artwork | Owner declaration and hashes for 13 original assets; derived branding documented | This is a rights declaration, not an independent authorship or trademark assessment. |
| Source privacy | Current-tree and full-history secret scans found no credentials; no tracked notes, caches, weights or profiles were identified | Pattern scans cannot prove that all future commits or runtime logs are private. |
| Installer | Production NSIS include passed six isolated native lifecycle cases: fresh install, upgrade, legacy error recovery, locked files, reparse rejection and uninstall with external notes retained | Unsigned; a synthetic payload is not exact-binary clean-machine or real interruption-recovery evidence. |
| Repository access | Only owner `Timaga` has write/admin access; no invitations, deploy keys, webhooks or Actions secrets were present; workflow defaults are read-only and cannot approve PRs | Active branch/tag rules require verification before visibility changes. A public visitor must never be granted write access. |
| Search presentation | Descriptive repository name, About, 20 relevant topics, English README, screenshots and versioned download | Private repositories are visible in search only to users with access. No ranking or star count is guaranteed. |

The detailed inventories are in [DEPENDENCIES.md](legal/DEPENDENCIES.md), [MODELS.md](legal/MODELS.md), [RUNTIMES.md](legal/RUNTIMES.md) and [ASSETS.md](legal/ASSETS.md). GitHub's `Other / NOASSERTION` display does not replace the explicit project license. The noncommercial restriction means **source-available**, not OSI open source.

## Application mitigations verified for 1.0.2

- Privileged Electron IPC validates the registered local main-frame document, including after navigation. Navigation, subframes, webviews and privileged popups are blocked; supported external links use the OS browser. Positive/negative unit tests and seven real-Electron scenarios verify this boundary. This is not a complete penetration test.
- Fine-tuning is disabled through HTTP, scheduled and legacy Python paths. The old simulated metrics and placeholder GGUF exporter are removed. Disabled endpoints do not instantiate a runner or read old artifact/status files. Normal note inference and indexing remain separate.
- Fresh runtime setup includes the pinned search model by default. Semantic loading uses local files with `trust_remote_code=False`; the portable environment also disables remote model code and offline inference uses the verified cache. User imports are restricted to the supported GGUF workflow. These controls do not certify arbitrary developer-supplied checkpoints or writable caches.

## Remaining limits and risks

- **Dependency advisories:** beta.17 replaces the versions affected by the original 19 GitHub alerts, including all five high findings, with coordinated patched dependencies. Full npm audit now reports zero vulnerabilities. Accelerate and DiskCache still have separate unresolved findings, and the PyTorch update does not prove a fix for PT2 deserialization. See [security status and reachability limits](security-known-issues.md); a clean GitHub count would not establish that all dependency risks are resolved.
- **Diagnostic privacy:** optional/manual model warm-up can log context previews. Normal active RAG logging uses request identifiers and counts; obsolete raw-query statements after an unconditional return are not an active query leak. Minimize previews before sharing diagnostics or enabling those developer paths.
- **Developer model rights:** some source-mode defaults and custom profiles fall outside the reviewed portable Apache-2.0 catalog. Qwen Research restrictions and the unestablished Tev license require separate treatment. Importing a model does not verify its license. No weights are included in this repository; see [the model scope](legal/MODELS.md).
- **Distribution checks:** retain exact notices and complete the native-library inventory if bundling standalone Python or other binaries. Microsoft prerequisites and optional CUDA retain their own terms. Verify clean installation, upgrade and backup restoration using synthetic data.

Version 1.0.2 carries the dependency changes from beta.17 and the library, installer and application mitigations described above. Historical beta releases retain their original artifacts. Separate dependency advisories and unsupported developer/model-rights findings remain documented; functional success does not establish universal security or legal clearance.

## Discoverability and publication

The repository name, description and topics support searches for local AI notes, Markdown, personal knowledge bases, knowledge graphs and semantic search. GitHub searches name, description and topics by default; README content can be searched with `in:readme`.

Public availability is authorized by the owner after verification; write/admin access must remain limited to `Timaga`. Private repositories are discoverable only to authorized users; public indexing is not immediate or guaranteed. Do not change the license, fabricate popularity or publish private data to improve search placement. The prepared social image is in `docs/assets/social-preview.png`.

- [GitHub topics and private search visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)
- [Repository search fields](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories)
- [Social preview rules](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)
- [PolyForm Noncommercial terms](https://polyformproject.org/licenses/noncommercial/1.0.0)
- [Open Source Definition](https://opensource.org/osd)

Report vulnerabilities privately using [SECURITY.md](../SECURITY.md). Keep real notes, credentials and full profile directories out of reports.
