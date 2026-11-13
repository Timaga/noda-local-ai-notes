# GitHub repository setup

The repository is [Timaga/noda-local-ai-notes](https://github.com/Timaga/noda-local-ai-notes), private for owner testing. Its testing prerelease provides a versioned Windows Setup. Public repository visibility, announcements and a stable public launch remain separate owner decisions.

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
- The prepared Social preview PNG at `docs/assets/social-preview.png` is 1280 × 640 pixels, less than 1 MB, with a solid background. GitHub permits an initial upload to a public repository, or an update to a private repository that already had an image. Sharing that image requires a public repository. Keep the current private visibility; add the prepared image when the owner approves public availability.
- Do not show fabricated stars, reviews, user counts, passing CI or unverified speed claims.

## Windows installer release

- Tag: **`v1.0.2-beta.16`**.
- Title: **`Noda 1.0.2-beta.16`**.
- Type: **published prerelease inside the private repository**.
- Download: [Windows x64 Setup](https://github.com/Timaga/noda-local-ai-notes/releases/download/v1.0.2-beta.16/Noda-Setup-1.0.2-beta.16-x64.exe).
- Notes: installation/update steps, changes and honest beta limitations.
- Assets: the verified Setup, checksums and additional source/validation files.

See [RELEASING.md](../docs/RELEASING.md) for future versions. GitHub Packages is not used for this `.exe`; users install through Releases. `/releases/latest` excludes beta prereleases, so README uses the exact version's download link.

Do not label the old 1.0.0 installer as beta.16 or claim that an unsigned build is signed.

## Discoverability

**Current limit: this repository is private.** GitHub search and topic results expose it only to accounts with access. Google cannot crawl its authenticated contents. Better metadata prepares a future public launch; it does not make private code publicly discoverable. Changing visibility requires a separate owner decision.

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
