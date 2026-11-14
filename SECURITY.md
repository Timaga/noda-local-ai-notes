# Security

See [known dependency advisories](docs/security-known-issues.md) for the current audit scope and release restrictions.

Noda is a local Windows application. Local storage and local inference do not make it a security sandbox, and the app does not encrypt Markdown projects or chat history.

## Report a vulnerability privately

Email **[tim@buglai.com](mailto:tim@buglai.com)** with a subject beginning `Noda security`.

Please include the affected version, the vulnerable component, expected impact and minimal reproduction steps. Prefer a synthetic project. Share only the information needed to reproduce the problem.

Do not send passwords, tokens, private notes, chat history, full profile directories or proprietary model files. Do not post an unpatched vulnerability in a public issue. The maintainer may ask for a smaller reproduction before receiving attachments.

No response-time guarantee or bug-bounty program is currently stated by this project.

## Supported versions

Security fixes target the latest maintained source and release. Older binaries and experimental imported models may require an upgrade or a different model profile. Check the current release notes before using an older build with an existing project.

## Useful boundaries

- Install Noda and its dependencies from the project's documented build or verified release process.
- Review a model's origin and license before importing it. Imported models are experimental.
- Keep backups outside the installation folder and restrict access to your project and profile folders using Windows permissions.
- Treat generated tags, links and answers as suggestions; check source notes before relying on an answer.
- Application dependencies, downloaded runtime components and models have separate update and licensing requirements.

## Release advisory review

Dependency advisory triage is a release gate. Review both source dependencies and the runtime components included in the final artifact. For each known advisory, record the affected version, reachable behavior, mitigation and remaining risk. Resolve relevant high or critical findings before public binary distribution; private testing and passing application tests do not replace this review.

The [release checklist](docs/RELEASING.md) also requires clean-install, update and recovery checks. A source upload does not certify the distributable.

For ordinary bugs, use the repository's bug-report form after removing private information.
