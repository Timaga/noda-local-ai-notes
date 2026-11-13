# Releasing Noda

Noda's Windows application is distributed through **GitHub Releases**. Each version has a Git tag, short release notes and a versioned `Noda-Setup-<version>-x64.exe`. GitHub Packages is for package registries and is not used for this desktop installer.

The current testing release is [v1.0.2-beta.17](https://github.com/Timaga/noda-local-ai-notes/releases/tag/v1.0.2-beta.17). The repository remains private. Publishing a prerelease inside it keeps downloads limited to accounts with repository access.

## Prepare another version

1. Agree on the next version and synchronize `frontend/package.json`, the root package entry in `frontend/package-lock.json`, `LICENSES/manifest.json.project_version` and `scripts/check-licenses.py`'s `VERSION`.
2. Update the changelog and release notes. Preserve all upstream notices and byte-pinned assets.
3. Run the checks in [DEVELOPMENT.md](DEVELOPMENT.md), including the license checker. Record the tested commit and actual results.
4. Build the Setup using `npm --prefix frontend run build`. Keep generated files out of Git.
5. Inspect the exact installer, verify its bundled notices, calculate SHA256 and test installation, upgrade and recovery with synthetic data. Record signing status and remaining limitations.
6. Create the matching `v<version>` tag on the verified source commit. Publish beta versions as **prereleases**; use a stable release only after the corresponding acceptance checks pass.
7. Attach Setup and its checksums. Lead the release notes with the download, installation/update steps, changes and known limitations. GitHub also provides source archives for the tag.
8. Update README's download link only after the version and asset exist. Never replace an existing version's installer silently; use another version for changed application code.

The current beta uses a pinned version download link. `/releases/latest` does not select prereleases, so use the specific beta tag or [all versions](https://github.com/Timaga/noda-local-ai-notes/releases).

Public availability is a separate owner decision. Before a public binary launch, resolve the applicable security and installation gates in [the release notes](releases/1.0.2-beta.17.md) and [known dependency issues](security-known-issues.md). No workflow automatically publishes a release on every source push.

## Installing and updating

Users download **Setup**, run it, then launch the installed Noda from the Start menu. For another version, they back up their projects/profile, fully exit Noda through its tray menu and run that version's Setup. This beta does not provide an automatic updater.

Initial runtime/model downloads still need internet access. Do not describe the small application installer as a complete offline model bundle. Private repository tokens must never be embedded in the application to enable downloads or updates.

## References

- [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [GitHub Packages formats](https://docs.github.com/en/packages/learn-github-packages/introduction-to-github-packages)
- [Latest release behavior](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
- [Joplin's versioned Windows Setup](https://github.com/laurent22/joplin/releases/tag/v3.7.22)
