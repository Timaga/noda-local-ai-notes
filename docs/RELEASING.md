# Releasing Noda

Noda's Windows application is distributed through **GitHub Releases**. Each version has a Git tag, short release notes and a versioned `Noda-Setup-<version>-x64.exe`. GitHub Packages is for package registries and is not used for this desktop installer.

Version **1.0.3** is the stable source version; [release notes](releases/1.0.3.md) record its scope and verification limits. GitHub Releases records actual publication status. Historical stable and beta tags and assets are retained.

## Prepare another version

1. Agree on the next version and synchronize `frontend/package.json`, the root package entry in `frontend/package-lock.json`, `LICENSES/manifest.json.project_version` and `scripts/check-licenses.py`'s `VERSION`.
2. Update the changelog and release notes. Preserve all upstream notices and byte-pinned assets.
3. Run the checks in [DEVELOPMENT.md](DEVELOPMENT.md), including the license checker. Record the tested commit and actual results.
4. Build the Setup using `npm --prefix frontend run build`. Keep generated files out of Git.
5. Inspect the exact installer, verify its bundled notices, calculate SHA256 and test installation, upgrade and recovery with synthetic data. Record signing status and remaining limitations.
6. Create the matching `v<version>` tag on the verified source commit. Publish beta versions as **prereleases**; use a stable release only after the corresponding acceptance checks pass.
7. Attach Setup and its checksums. Lead the release notes with the download, installation/update steps, changes and known limitations. GitHub also provides source archives for the tag.
8. Update README's download link only after the version and asset exist. Never replace an existing version's installer silently; use another version for changed application code.

README links to the existing Releases page until a versioned asset exists. Verify download links anonymously after publication. `/releases/latest` does not select prereleases.

The owner has authorized public availability with sole-owner write access. Before changing visibility, verify no unintended collaborators, invitations or write deploy keys, read-only workflow permissions and disabled workflow PR approval. Additional branch/tag rules are optional under the owner's current decision. Recheck access after changing visibility. A public repository permits reading and forks; it does not grant write access to visitors. No workflow automatically publishes a release on every source push.

Before a public binary launch, resolve the applicable security and installation gates in [the release notes](releases/1.0.3.md) and [known dependency issues](security-known-issues.md). An unresolved high-risk finding needs a concrete mitigation or explicit owner risk acceptance; changing the version label does not resolve it.

## Installing and updating

Users download **Setup**, run it, then launch the installed Noda from the Start menu. For another version, they back up their projects/profile, fully exit Noda through its tray menu and run that version's Setup. Noda does not provide an automatic updater.

Setup prepares an existing installation with the current uninstaller before the
standard upgrade. It backs up the previous uninstaller for an aborted operation,
rejects redirected uninstaller paths and checks for files in use first. This avoids
depending on a broken legacy beta uninstaller. User projects and profile data are
kept outside application files. Replacing program files cannot reverse queue
schema changes: restore a compatible backup when a downgrade requires it.

Initial runtime/model downloads still need internet access. Do not describe the small application installer as a complete offline model bundle. Private repository tokens must never be embedded in the application to enable downloads or updates.

## References

- [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [GitHub Packages formats](https://docs.github.com/en/packages/learn-github-packages/introduction-to-github-packages)
- [Latest release behavior](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)
- [Joplin's versioned Windows Setup](https://github.com/laurent22/joplin/releases/tag/v3.7.22)
