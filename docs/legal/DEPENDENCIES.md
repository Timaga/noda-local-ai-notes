# Dependency licenses

Inventory prepared on 2026-11-13 from the repository lockfiles and version-matching installed wheel metadata. This is a licensing/provenance inventory; it is not a vulnerability assessment or a certification of every compiled component.

## Scope and reproducibility

- Windows Python runtime: `scripts/windows-portable/requirements-win-x64.lock`, 109 pinned package versions and wheel SHA-256 values. All 109 installed runtime package versions matched the lock during collection. Package code was not imported.
- Frontend and build: `frontend/package-lock.json`, 284 non-root package entries. All entries declare license metadata. The lock includes development tools, optional dependencies and platform variants; these are not all included in an app release.
- Marked is the declared production npm dependency. Electron is marked as a development dependency for installation/build purposes but its runtime is shipped in an Electron application. Electron-builder and its toolchain are build dependencies.
- Full inventory, upstream text paths and hashes: [dependencies.json](dependencies.json). Text files are under [LICENSES](../../LICENSES/).
- Python license labels below preserve the wheel metadata as declared, with missing labels for Flask-Cors and SentencePiece checked against their tagged upstream license files. Classifiers such as `BSD License` are not an invented exact SPDX expression. Read each package's complete notices for the exact license and included subcomponents.

For a fresh environment, resolve and review the actual target lock and retain licensing files from those exact artifacts. A matching version does not independently prove all installed binary bytes match a lockfile hash. Changing a platform, wheel, model revision or download pin requires a new inventory.

## Windows Python packages

| Package | Locked version | Direct requirement | Declared license / classifier |
| --- | --- | --- | --- |
| accelerate | 1.11.0 | yes | Apache |
| aiohappyeyeballs | 2.7.1 | transitive | PSF-2.0 |
| aiohttp | 3.14.5 | transitive | Apache-2.0 AND MIT |
| aiosignal | 1.4.0 | transitive | Apache 2.0 |
| annotated-doc | 0.0.3 | yes | MIT |
| annotated-types | 0.7.0 | yes | MIT License |
| anyio | 4.14.2 | yes | MIT |
| attrs | 26.1.0 | transitive | MIT |
| blinker | 1.9.0 | yes | MIT License |
| cachetools | 6.2.2 | yes | MIT |
| certifi | 2026.10.18 | yes | MPL-2.0 |
| charset-normalizer | 3.4.4 | yes | MIT |
| click | 8.3.0 | yes | BSD-3-Clause |
| colorama | 0.4.6 | yes | BSD License |
| coloredlogs | 15.0.1 | transitive | MIT |
| colorlog | 6.10.1 | yes | MIT License |
| datasets | 2.19.0 | yes | Apache 2.0 |
| dill | 0.3.8 | transitive | BSD-3-Clause |
| diskcache | 5.6.3 | transitive | Apache 2.0 |
| distro | 1.9.0 | yes | Apache License, Version 2.0 |
| docstring_parser | 0.18.0 | transitive | MIT |
| fastapi | 0.121.1 | yes | MIT |
| filelock | 3.20.0 | yes | Unlicense |
| Flask | 3.1.3 | yes | BSD-3-Clause |
| flask-cors | 6.0.1 | yes | MIT |
| flatbuffers | 25.12.19 | transitive | Apache 2.0 |
| frozenlist | 1.8.0 | transitive | Apache-2.0 |
| fsspec | 2024.3.1 | yes | BSD |
| grpcio | 1.85.1 | transitive | Apache-2.0 |
| grpcio-tools | 1.80.1 | transitive | Apache-2.0 |
| h11 | 0.16.0 | yes | MIT |
| h2 | 4.4.1 | transitive | MIT |
| hf-xet | 1.4.3 | transitive | Apache-2.0 |
| hpack | 4.2.0 | transitive | MIT |
| httpcore | 1.0.9 | yes | BSD-3-Clause |
| httpx | 0.28.1 | yes | BSD-3-Clause |
| huggingface-hub | 1.13.0 | yes | Apache-2.0 |
| humanfriendly | 10.0 | transitive | MIT |
| hyperframe | 6.1.0 | transitive | MIT License |
| idna | 3.15 | yes | BSD-3-Clause |
| itsdangerous | 2.2.0 | yes | BSD License |
| Jinja2 | 3.1.6 | yes | BSD License |
| jiter | 0.12.0 | yes | MIT License |
| joblib | 1.5.2 | yes | BSD 3-Clause |
| llama_cpp_python | 0.3.21 | yes | MIT |
| markdown-it-py | 4.0.0 | yes | MIT License |
| MarkupSafe | 3.0.3 | yes | BSD-3-Clause |
| mdurl | 0.1.2 | transitive | MIT License |
| mpmath | 1.3.0 | yes | BSD |
| multidict | 7.2.1 | transitive | Apache-2.0 |
| multiprocess | 0.70.16 | transitive | BSD-3-Clause |
| networkx | 3.5 | yes | BSD License |
| numpy | 2.3.4 | yes | BSD License |
| onnxruntime | 1.23.2 | transitive | MIT License |
| packaging | 25.0 | yes | Apache Software License; BSD License |
| pandas | 3.1.1 | transitive | BSD-3-Clause |
| peft | 0.11.1 | yes | Apache |
| pillow | 13.0.0 | yes | MIT-CMU |
| portalocker | 2.10.1 | transitive | BSD-3-Clause |
| propcache | 0.5.4 | transitive | Apache-2.0 |
| protobuf | 6.33.5 | yes | 3-Clause BSD License |
| psutil | 7.2.2 | yes | BSD-3-Clause |
| pyarrow | 26.0.1 | transitive | Apache-2.0 |
| pyarrow-hotfix | 0.7 | transitive | Apache License, Version 2.0 |
| pyasn1 | 0.6.5 | yes | BSD-2-Clause |
| pyasn1_modules | 0.4.2 | yes | BSD |
| pydantic | 2.12.4 | yes | MIT |
| pydantic_core | 2.41.5 | yes | MIT |
| Pygments | 2.21.0 | transitive | BSD-2-Clause |
| pyreadline3 | 3.5.6 | transitive | BSD |
| python-dateutil | 4.0.0 | transitive | BSD-3-Clause |
| python-dotenv | 1.2.2 | yes | BSD-3-Clause |
| pywin32 | 312 | transitive | PSF |
| PyYAML | 6.0.3 | yes | MIT |
| qdrant-client | 1.12.0 | yes | Apache-2.0 |
| regex | 2025.11.3 | yes | Apache-2.0 AND CNRI-Python |
| requests | 2.33.0 | yes | Apache-2.0 |
| rich | 13.7.1 | yes | MIT |
| rsa | 4.9.1 | yes | Apache-2.0 |
| safetensors | 0.6.2 | yes | Apache Software License |
| scikit-learn | 1.7.2 | yes | BSD-3-Clause |
| scipy | 1.16.3 | yes | BSD License |
| sentence-transformers | 5.6.0 | yes | Apache-2.0 |
| sentencepiece | 0.2.1 | transitive | Apache-2.0 |
| setuptools | 80.9.0 | yes | MIT |
| shellingham | 1.5.4 | transitive | ISC License |
| sniffio | 1.3.1 | yes | MIT OR Apache-2.0 |
| starlette | 0.49.3 | yes | BSD-3-Clause |
| sympy | 1.14.0 | yes | BSD |
| tenacity | 9.1.2 | yes | Apache 2.0 |
| threadpoolctl | 3.6.0 | yes | BSD-3-Clause |
| tokenizers | 0.22.2 | yes | Apache Software License |
| torch | 2.10.0+cpu | yes | BSD-3-Clause |
| tqdm | 4.67.1 | yes | MPL-2.0 AND MIT |
| transformers | 5.10.2 | yes | Apache 2.0 License |
| trl | 0.9.4 | yes | Apache 2.0 |
| typeguard | 4.6.0 | transitive | MIT |
| typer | 0.23.1 | transitive | MIT |
| typing_extensions | 4.15.0 | yes | PSF-2.0 |
| typing-inspection | 0.4.2 | yes | MIT |
| tyro | 1.0.17 | transitive | MIT |
| tzdata | 2026.6 | transitive | Apache-2.0 |
| urllib3 | 2.8.0 | yes | MIT |
| uvicorn | 0.38.0 | yes | BSD-3-Clause |
| watchdog | 6.0.0 | yes | Apache-2.0 |
| websockets | 15.0.1 | yes | BSD-3-Clause |
| Werkzeug | 3.1.9 | yes | BSD-3-Clause |
| xxhash | 4.1.0 | transitive | BSD-2-Clause |
| yarl | 1.25.1 | transitive | Apache-2.0 |

## Notice and source obligations

The collected Python/npm set contains 151 unmodified legal-text files, including the full MPL-2.0 text. The machine-readable inventory records their individual SHA-256 values and origin. Separate runtime/model texts have their own provenance in this directory.

`certifi` includes MPL-covered Mozilla certificate data. `tqdm` records MPL-2.0 and MIT notices for different contributions. Their exact version source archives are listed in [mpl-sources.json](mpl-sources.json); those covered sources remain available under their upstream terms. Preserve notices and provide the covered source, including any modifications, when the MPL requires it. Independent Noda files are not relicensed by using these packages. See [Mozilla MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/) and its [official distribution FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).

NumPy, SciPy, PyTorch, ONNX Runtime and other native wheels include multiple embedded libraries. Their LICENSE/NOTICE/ThirdPartyNotices files are included without flattening those components into the package's headline license. For example, NumPy's wheel notice explicitly identifies GCC runtime code as `GPL-3.0-or-later WITH GCC-exception-3.1`; the exception must be retained and assessed with the actual component. This is not a finding that Noda itself is GPL-licensed. The [official GCC exception](https://gcc.gnu.org/onlinedocs/libstdc++/manual/license.html) explains its scope.

## npm lock metadata

The full npm inventory is in [dependencies.json](dependencies.json), with package paths, exact versions, license strings, source URLs and integrity values. Counts by declared expression:

| Declared license expression | Lock entries |
| --- | ---: |
| (MIT OR CC0-1.0) | 1 |
| (WTFPL OR MIT) | 1 |
| 0BSD | 1 |
| Apache-2.0 | 6 |
| BSD-2-Clause | 6 |
| BSD-3-Clause | 9 |
| BlueOak-1.0.0 | 8 |
| ISC | 36 |
| MIT | 213 |
| Python-2.0 | 1 |
| WTFPL | 1 |
| WTFPL OR ISC | 1 |

The source repository excludes `node_modules` and build-tool executables. Lockfile metadata for a tool does not replace notices for native executables that the tool may download. If redistributing a build-tool cache or binary, inventory its contents separately. Retain Electron's full generated `LICENSES.chromium.html` in the actual Electron release rather than substituting this npm table.

## Experimental optional requirements

`backend/requirements-optional.txt` describes optional development/research GPU paths, outside the 109-package Windows production lock. They are not covered by the locked-runtime completeness statement above. In particular, its `bitsandbytes-windows>=0.45.0` requirement cannot be satisfied by the currently published `bitsandbytes-windows` release 0.37.5 ([official PyPI package page](https://pypi.org/project/bitsandbytes-windows/)). Do not present that file as a supported reproducible installation path. Optional CUDA/vLLM/GPTQ environments require a separate resolved dependency, native-library and license review.

## Limits of this inventory

No Python vulnerability scanner was installed or executed during this collection. npm vulnerability audit is a separate check and does not establish license compliance. The inventory does not assert that models or downloaded runtimes are part of the source repository, does not replace their own terms, and does not close the full CPython built-in-library binary audit described in [RUNTIMES.md](RUNTIMES.md). No user notes, private settings, credentials or environment values are part of these public legal artifacts.
