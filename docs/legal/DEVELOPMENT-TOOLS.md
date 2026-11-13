# Development-tool licenses

Audit date: **2026-11-13**. This inventory closes the direct development-pin scope beside the separate [Windows runtime and npm inventory](DEPENDENCIES.md). It covers all **21 exact-version requirements** in `requirements-test.txt`; **20** are development-only direct requirements, while `psutil` is also part of the locked application runtime.

The source repository contains dependency declarations, not copies of these tools. The Windows installer does not bundle the Python test/formatter/linter environment. Installing a tool from its publisher does not relicense it under Noda's PolyForm Noncommercial terms.

## Direct pins

License labels below reproduce official version-specific PyPI metadata or classifiers. A generic `BSD` classifier is not an invented exact SPDX expression. Read the upstream license for its actual terms and embedded components. [Machine-readable metadata](development-tools.json) includes original declarations, official source URLs, retrieval hashes and declared dependency constraints.

| Package | Version | Upstream declaration / classifier | Shared with runtime |
| --- | --- | --- | --- |
| [pytest](https://pypi.org/pypi/pytest/9.0.3/json) | 9.0.3 | MIT | no |
| [pytest-cov](https://pypi.org/pypi/pytest-cov/6.0.0/json) | 6.0.0 | MIT | no |
| [pytest-mock](https://pypi.org/pypi/pytest-mock/3.14.0/json) | 3.14.0 | MIT | no |
| [pytest-asyncio](https://pypi.org/pypi/pytest-asyncio/1.3.0/json) | 1.3.0 | Apache-2.0 | no |
| [pytest-xdist](https://pypi.org/pypi/pytest-xdist/3.6.1/json) | 3.6.1 | MIT License | no |
| [coverage](https://pypi.org/pypi/coverage/7.6.10/json) | 7.6.10 | Apache-2.0 | no |
| [mock](https://pypi.org/pypi/mock/5.1.0/json) | 5.1.0 | BSD License | no |
| [Faker](https://pypi.org/pypi/faker/33.3.1/json) | 33.3.1 | MIT License | no |
| [freezegun](https://pypi.org/pypi/freezegun/1.5.1/json) | 1.5.1 | Apache 2.0 | no |
| [requests-mock](https://pypi.org/pypi/requests-mock/1.12.1/json) | 1.12.1 | Apache-2 | no |
| [responses](https://pypi.org/pypi/responses/0.25.3/json) | 0.25.3 | Apache 2.0 | no |
| [Flask-Testing](https://pypi.org/pypi/Flask-Testing/0.8.1/json) | 0.8.1 | BSD | no |
| [black](https://pypi.org/pypi/black/26.10.1/json) | 26.10.1 | MIT | no |
| [flake8](https://pypi.org/pypi/flake8/7.1.1/json) | 7.1.1 | MIT | no |
| [mypy](https://pypi.org/pypi/mypy/1.14.1/json) | 1.14.1 | MIT | no |
| [pylint](https://pypi.org/pypi/pylint/4.0.9/json) | 4.0.9 | GPL-2.0-or-later | no |
| [isort](https://pypi.org/pypi/isort/5.13.2/json) | 5.13.2 | MIT | no |
| [pytest-benchmark](https://pypi.org/pypi/pytest-benchmark/5.1.0/json) | 5.1.0 | BSD-2-Clause | no |
| [pytest-timeout](https://pypi.org/pypi/pytest-timeout/2.3.1/json) | 2.3.1 | MIT | no |
| [psutil](https://pypi.org/pypi/psutil/7.2.2/json) | 7.2.2 | BSD-3-Clause | yes |
| [pytest-html](https://pypi.org/pypi/pytest-html/4.1.1/json) | 4.1.1 | MIT License | no |

## Tool-only copyleft boundary

`pylint` declares **GPL-2.0-or-later**. It is a development linter, not imported by Noda's backend and not included in the application installer. Running a separate GPL development tool does not by itself make independently written application source GPL. This follows the separate-work and output boundaries in sections 0 and 2 of [Pylint's upstream GPL text](https://github.com/pylint-dev/pylint/blob/v4.0.9/LICENSE); copying GPL code or bundling/linking it into another work requires a separate review. Pylint and any of its covered dependencies retain their own terms. The [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html#CanIUseGPLToolsForNF) provides additional tool-use guidance.

If redistributing a complete development environment, tool cache, container or copied tool code, collect its exact licenses, copyright notices and applicable source/relinking obligations first. The current runtime license bundle is not a notice set for every possible development environment.

## Limits and maintenance

Development transitive dependencies are **not fully locked or inventoried**. The JSON's `requires_dist` fields state publisher constraints, not the exact versions resolved by CI. Existing CI artifacts do not contain a complete `pip freeze`/`pip inspect` environment ledger. An exact whole-development-environment SBOM and hash lock therefore remain follow-up work; this inventory does not claim they already exist.

The security update pins Black 26.10.1, pytest 9.0.3 and Pylint 4.0.9 to their reviewed fixes, with pytest-asyncio 1.3.0 for pytest 9 compatibility. Exact-version PyPI metadata reports no known advisories for the 21 direct pins as of this review. License metadata remains independent from vulnerability status; consult [dependency security status](../security-known-issues.md) for the complete application and development scopes.

Recheck this document and JSON whenever `requirements-test.txt` changes. Model weights, native runtimes, installed app data and user notes are outside this inventory. See [runtime terms](RUNTIMES.md), [model terms](MODELS.md) and [artwork provenance](ASSETS.md) for their separate boundaries.
