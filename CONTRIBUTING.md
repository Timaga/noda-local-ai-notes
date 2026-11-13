# Contributing to Noda

Thanks for helping make local note-taking more dependable. Small, focused changes are easiest to review.

## Before you start

- Read the [license](LICENSE). Contributions to Noda's own code are accepted under the same noncommercial terms unless a separate written agreement applies. Keep third-party license notices intact.
- Check the existing issues before opening a new one. For a larger feature or architectural change, describe the problem and proposed behavior first.
- Use synthetic notes and an isolated project for development. Keep personal libraries, model weights, downloaded runtimes, access tokens and local configuration out of commits.

## Report a bug

Use the bug-report form and include:

1. Noda version and Windows version.
2. Exact steps, expected behavior and actual behavior.
3. Whether the issue involves capture, the queue, editing, search, chat or a particular model pair.
4. A minimal synthetic note that reproduces it, if possible.

Remove personal information from screenshots and logs. Do not attach full project folders or profile directories. Report security issues privately using [SECURITY.md](SECURITY.md).

## Build and test

Follow [DEVELOPMENT.md](docs/DEVELOPMENT.md) for the supported Windows build and local checks. Run the relevant checks before submitting a change, and include the commands and results in the pull request. A passing unit test does not replace a clean-install or real-model test when the change affects that boundary.

Tests must express user-visible behavior. For a bug fix, include a regression case that fails on the old behavior where practical. Keep test inputs small, synthetic and deterministic.

## Pull requests

- Keep one concrete behavior change per pull request.
- Explain the problem, the resulting behavior, and how you verified it.
- Preserve the full note source when changing titles, tags, links or indexing.
- Cover cancellation, retries, errors and project switching when those paths are affected.
- Update user-facing documentation and translations that the change touches.
- Include before/after screenshots for visible changes using only a synthetic project.
- Preserve strict validation, project boundaries and existing safeguards. Do not weaken tests or checks to make a patch pass.
- Do not introduce a dependency or third-party asset without its source, license and reason for inclusion.

Public APIs, persistence formats and model-selection defaults need compatibility review. Describe migration or rollback considerations when changing them.

## Translation and accessibility

Interface translations belong in the existing translation system. Keep model names, filenames and user text unchanged. Check keyboard focus, labels and reduced-motion behavior for interactive changes.

## Scope

The repository contains application code, its build tooling and reproducible tests. Runtime caches, trained weights, private notes and historical research output belong outside it.

Please keep discussion respectful, concrete and focused on the project. Support: [tim@buglai.com](mailto:tim@buglai.com).
