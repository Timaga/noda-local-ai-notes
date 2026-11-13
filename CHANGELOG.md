# Changelog

## 1.0.2-beta.17 — unreleased

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
