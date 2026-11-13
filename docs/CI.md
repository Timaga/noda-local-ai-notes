# Continuous integration

`Windows checks` runs on pushes, pull requests and manual dispatch. It uses an
ephemeral Windows 2025 runner, Node 22.21.0 and Python 3.13.14. All actions are
pinned to commits in their official `actions/*` repositories.

The job installs the Windows runtime's hashed wheel lock, the existing pinned
test tools and the frontend's npm lock. Test-tool transitive dependencies are
resolved by pip; they do not have a separate hash lock. `pip check` rejects an
inconsistent environment. npm lifecycle scripts are disabled: these tests do not
need to download or launch Electron.

The same `scripts/test.ps1` command used locally runs both suites and measures
backend branch coverage. Tests use temporary synthetic vaults and fake model
boundaries; ordinary Python tests reject network connections. Model weights,
personal notes, cloud inference and running Qdrant are not required. Dependency
installation uses the public registries and pinned binary download URLs.

The workflow publishes no application or release. Its token can only read
repository content, checkout credentials are not persisted, and diagnostic
artifacts expire after seven days. Duplicate runs on the same ref are cancelled;
each job has a 30-minute limit. Private repository runs may consume the account's
included Actions minutes; no billing setting is changed by this configuration.

This job proves the checked-in isolated tests, not a fresh interactive installer
run, real model quality, code signing, or a complete security audit. See
`SECURITY.md` and the release notes for the current security and release limits.
Inspect the actual Actions run before treating remote verification as passed.
