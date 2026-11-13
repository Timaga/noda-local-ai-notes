# Compliance and publication status

Reviewed on **2026-11-13**. This records the source repository, its dependency declarations and the existing Windows beta release. It is a scoped engineering/licensing review, not a legal opinion or regulatory certification. The repository remains **private** for testing. Full public-release approval has not been established.

## Verified scope

| Area | Verified | Remaining limits |
| --- | --- | --- |
| Project license | Canonical PolyForm Noncommercial 1.0.0, required notice and matching package metadata | Applies to project-owned materials; previous MIT grants and upstream rights remain unchanged. |
| Third-party notices | 165 protected files, including 161 license texts; 109 Python runtime packages and 284 npm lock entries | Native subcomponents and future redistributed bundles need exact-artifact review. |
| Development tools | 21 pinned direct test/development requirements, including Pylint's separate GPL tool license | Development transitive dependencies are not fully locked or inventoried. See [development tools](legal/DEVELOPMENT-TOOLS.md). |
| Artwork | Owner declaration and hashes for 13 original assets; derived branding documented | This is a rights declaration, not an independent authorship or trademark assessment. |
| Source privacy | Current-tree and full-history secret scans found no credentials; no tracked notes, caches, weights or profiles were identified | Pattern scans cannot prove that all future commits or runtime logs are private. |
| Installer | Versioned Setup matches its checksum and tested source; bundled Electron/Chromium/marked notices were checked | Unsigned; clean application installation, real-model inference and recovery remain unverified. |
| Search presentation | Descriptive repository name, About, 20 relevant topics, English README, screenshots and versioned download | Private repositories are visible in search only to users with access. No ranking or star count is guaranteed. |

The detailed inventories are in [DEPENDENCIES.md](legal/DEPENDENCIES.md), [MODELS.md](legal/MODELS.md), [RUNTIMES.md](legal/RUNTIMES.md) and [ASSETS.md](legal/ASSETS.md). GitHub's `Other / NOASSERTION` display does not replace the explicit project license. The noncommercial restriction means **source-available**, not OSI open source.

## Open release findings

- **Dependency advisories:** 19 GitHub alerts remain: 5 high, 11 moderate and 3 low. The five high alerts include two development-tool findings. The runtime-only PyPI review identifies eight affected packages. See [known issues and reachability limits](security-known-issues.md); coordinated updates are required rather than an untested automatic upgrade.
- **Desktop trust boundary:** explicit navigation/new-window policies and IPC frame/document validation require hardening. Existing sender identity checks alone do not establish that a window still displays a trusted application document. A complete exploit was not demonstrated by this review.
- **Legacy training/export:** developer/manual paths contain synthetic fallback training results and a placeholder export. Their dry-run handling also needs side-effect containment. Default training is off, and normal note processing is a separate flow. These paths must fail clearly or produce real validated artifacts before being supported or promoted.
- **Diagnostic privacy:** optional/manual model warm-up can log context previews. Normal active RAG logging uses request identifiers and counts; obsolete raw-query statements after an unconditional return are not an active query leak. Minimize previews before sharing diagnostics or enabling those developer paths.
- **Developer model rights:** some source-mode defaults and custom profiles fall outside the reviewed portable Apache-2.0 catalog. Qwen Research restrictions and the unestablished Tev license require separate treatment. Importing a model does not verify its license. No weights are included in this repository; see [the model scope](legal/MODELS.md).
- **Distribution checks:** retain exact notices and complete the native-library inventory if bundling standalone Python or other binaries. Microsoft prerequisites and optional CUDA retain their own terms. Verify clean installation, upgrade and backup restoration using synthetic data.

These findings were not resolved by changing the application's behavior during this audit. The existing release tag and Setup were not replaced. Functional CI success is separate from resolving security, licensing and release findings.

## Discoverability and publication

The repository name, description and topics support searches for local AI notes, Markdown, personal knowledge bases, knowledge graphs and semantic search. GitHub searches name, description and topics by default; README content can be searched with `in:readme`.

The private status currently blocks discovery by people without access and prevents a public launch. The owner must separately choose public visibility after reviewing the open findings. Do not change the license, fabricate popularity or publish private data to improve search placement. The prepared social image is in `docs/assets/social-preview.png`; GitHub's visibility rules govern its upload and sharing.

- [GitHub topics and private search visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)
- [Repository search fields](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories)
- [Social preview rules](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)
- [PolyForm Noncommercial terms](https://polyformproject.org/licenses/noncommercial/1.0.0)
- [Open Source Definition](https://opensource.org/osd)

Report vulnerabilities privately using [SECURITY.md](../SECURITY.md). Keep real notes, credentials and full profile directories out of reports.
