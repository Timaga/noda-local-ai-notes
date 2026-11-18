# Changelog

## 1.0.3 — 2026-11-18

- Retry note generation within the existing queue attempt limit when its archive
  snapshot changes during processing. Rebuild decisions from a fresh snapshot,
  preserve the exact source and same job identity, and never restore deleted notes
  or publish stale links. Other permanent generation failures retain their behavior.

## 1.0.2 — 2026-11-14

- Install the semantic-search model during first preparation by default; reuse verified cached files on subsequent launches and retain explicit text-only choices.
- Hide semantic-search setup after the model is ready, and retain recovery controls for disabled or unavailable search.
- Remove decorative runtime/startup and healthy Qdrant labels from Settings and Chat while preserving errors, progress and citations.
- Disable fine-tuning through HTTP, scheduled and legacy Python entry points; remove simulated training metrics and placeholder GGUF exports.
- Validate IPC against the registered local main-frame document, block embedded app navigation and keep web links in the external browser.
- Open notes in formatted Markdown preview by default, with an explicit editing switch that preserves drafts.
- Display saved connections and backlinks beneath notes, with keyboard navigation and protection against stale project responses.
- Prepare upgrades with the current build's uninstaller, so a broken legacy beta uninstaller does not block the update.
- Reject upgrades when application files are in use or the previous uninstaller is redirected through a directory or reparse point.
- Preserve project data during updates and include a reproducible, isolated Windows installer lifecycle check.

This stable version includes the dependency changes from beta.17 and the local interface changes from beta.18–19. The stable version label does not certify arbitrary model files or experimental training paths; see [known issues](docs/security-known-issues.md). The Windows installer remains unsigned pending issuance of a code-signing certificate.

## 1.0.2-beta.19 — 2026-11-14 (local testing build)

- Open notes in formatted preview by default, including legacy Obsidian Markdown.
- Keep an explicit switch to source editing, retain drafts across mode changes and preserve editing mode during automatic refresh.

## 1.0.2-beta.18 — 2026-11-14 (local testing build)

- Show saved outgoing connections and backlinks below the editable note body, using the same canonical identities as Graph.
- Open connected notes by mouse or keyboard, retain manual drafts and restore focus in editable or read-only views.
- Refresh connections automatically, hide empty lists and reject stale project or vault responses.
- Verify chat citation navigation, translations and narrow layouts with isolated Electron fixtures.

## 1.0.2-beta.17 — 2026-11-13

### Dependency security

- Update the Windows Python runtime and development tools to compatible patched versions.
- Restrict patched glob-matching overrides to the two affected Electron packaging consumers.
- Refresh dependency locks and third-party license evidence for the updated artifacts.

The previous beta.16 installer remains a historical release. Dependency updates do not resolve the separately documented desktop IPC, experimental training or model-rights findings.

## 1.0.2-beta.16 — 2026-11-13

### Repository and licensing preparation

- Prepare a clean source repository, English introduction and contribution/reporting templates.
- State the noncommercial source license for the new Noda source version and preserve separate third-party terms.
- Include the existing Noda branding, real synthetic screenshots and a social preview asset.
- Start fresh app profiles in English while retaining saved language choices and selectable translations.
- Publish a private Windows prerelease with Setup and source downloads; code signing and clean-machine verification remain pending.
- Reject Windows directory aliases before project or backup activation; use full folder paths.

This source preparation is separate from the already installed beta.15 build. Earlier copies distributed under MIT retain their original grants.

## 1.0.2-beta.15 — included source baseline

### Fixed

- Reuse an existing topic tag when only an action or schedule changes, rather than creating a duplicate action-shaped tag.
- Review proposed new topics against the full note source and tag catalog. Empty tag selections remain valid.
- Confirm positive batch link suggestions with an independent comparison of the full pair of notes.
- Save manual notes without a redundant dependency on whole-note embedding generation.
- Clear the stale unsaved-changes hint when the edited source exactly matches its saved value again.
- Align settings controls and remove excess spacing in the new-note form.
- Correct the project-retry instruction in all ten interface languages.

### Notes

- Earlier CPU compatibility work for the Qwen scorer is included in this source baseline.
- AI stages are optional. A note does not have to receive a tag or a relationship.
- Metadata and answer quality depend on the model and input. Additional verification calls can increase CPU processing time.
- An existing project should be backed up before upgrading or downgrading its application version.
