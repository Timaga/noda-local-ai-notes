# GitHub repository setup

The repository is [Timaga/noda-local-ai-notes](https://github.com/Timaga/noda-local-ai-notes). The owner has authorized the stable 1.0.3 fix release, retaining public availability and **Timaga as the only writer**. Live visibility and release status are recorded on GitHub.

## Name and About

Keep **Noda** as the product name. Use the descriptive repository name **`noda-local-ai-notes`**.

About description:

```text
Local-first AI note-taking app for Windows: Markdown notes, a personal knowledge base, knowledge graph, semantic search and chat with cited sources.
```

Leave Homepage empty until an actual Noda website is available and verified. Do not invent a product URL. The existing author brand is buglAI and the public support address is `tim@buglai.com`.

## Topics

Use topics that describe the actual product. Avoid unrelated popular topics.

```text
note-taking
markdown
markdown-editor
local-ai
local-first
personal-knowledge-management
knowledge-management
knowledge-base
knowledge-graph
ai-notes
rag
semantic-search
desktop-app
windows
electron
python
qdrant
gguf
source-available
noncommercial
```

These are 20 factual lowercase topics. GitHub allows up to 20 topics, each no longer than 50 characters. Do not classify the noncommercial source license as `open-source` or `free-software`.

## Presentation

- Lead the README with the logo, one clear value statement and an actual library screenshot.
- Keep the library, graph and chat screenshots current, synthetic and available through relative paths.
- The prepared Social preview PNG at `docs/assets/social-preview.png` is 1280 × 640 pixels, less than 1 MB, with a solid background. Upload it only under the owner's approved publication scope; changing visibility is an explicit owner decision.
- Do not show fabricated stars, reviews, user counts, passing CI or unverified speed claims.

## Windows installer release

- Tag: **`v1.0.3`**.
- Title: **`Noda 1.0.3`**.
- Type: **stable release**, not a prerelease.
- Downloads: versioned Setup assets on [GitHub Releases](https://github.com/Timaga/noda-local-ai-notes/releases).
- Notes: installation/update steps, changes, actual verification and remaining limitations.
- Assets: the verified Setup, checksums and additional source/validation files.

See [RELEASING.md](../docs/RELEASING.md). GitHub Packages is not used for this `.exe`; users install through Releases. Update the README's exact download link after the stable release asset exists.

Do not label an older installer as a newer version or claim that an unsigned build is signed.

## Owner-only control

Public visibility grants reading and forks, not write access to this repository.
Keep `Timaga` as the only account with write/admin access. `CODEOWNERS` routes review
requests; it does not grant or enforce repository permissions by itself.

Before public availability, verify that write/admin access belongs only to the
owner. Extra branch/tag rules are optional under the owner's current decision.
Retain read-only Actions workflow defaults, disable workflow approval of PRs and
require approval for all external contributors' workflow runs once public. Recheck
collaborators, pending invitations, deploy keys, hooks and effective rules after a
visibility change. Do not claim that a configured but unenforced private ruleset
protects the repository; GitHub's applicable plan must support enforcement.

## Discoverability

GitHub search and topic results expose a private repository only to accounts with access. Public availability allows broader discovery, but search indexing and ranking are not guaranteed. The owner has explicitly authorized publication after verification.

The name, About description, README and topics use accurate terms: local AI, Markdown notes, Windows, knowledge graph, semantic search and RAG. This makes the purpose clear and supplies searchable repository fields. It does not guarantee a number of stars.

An unqualified GitHub repository search checks the repository name, description and topics. To search README content, use `in:readme`. Authorized users can find this private project with `repo:Timaga/noda-local-ai-notes` or `user:Timaga topic:local-ai`. After an approved public launch, review search results and links; neither an indexing date nor a search position is guaranteed.

GitHub may label this noncommercial license as `Other` / `NOASSERTION`. The authoritative text is `LICENSE`; package metadata uses `PolyForm-Noncommercial-1.0.0`. Do not replace the license or claim OSI open-source status to obtain another search label.

Before announcing the project, verify the first-run instructions, release link, screenshots and license. A useful demonstration is a real short workflow: quick capture → queue → saved note → question with a source. Publish announcements and invite testers separately, only when the owner decides to do so.

The README includes a brief request for a star if the project is useful. A working installation, reproducible feedback and a clear explanation of the product are the priority.

## Official GitHub references

- [Repository READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
- [Topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)
- [Social preview](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)
- [Repository search](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories)
- [Repository visibility](https://docs.github.com/en/repositories/creating-and-managing-repositories/about-repositories#about-repository-visibility)
- [Google crawl access](https://developers.google.com/search/docs/fundamentals/get-started-developers#control-what-content-google-sees)
