# Third-party notices

Noda's original code is licensed under PolyForm Noncommercial License 1.0.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE). That license applies only to material whose rights the Noda rights holder can grant. Dependencies, model weights, runtime tools, certificate data and their notices retain their upstream licenses, including any independent commercial-use rights. Noda's noncommercial condition does not amend those licenses.

Earlier copies supplied under MIT keep the permissions granted with those copies. This edition does not retroactively replace their license. PolyForm Noncommercial is a source-available license, not an OSI-approved open-source license. Its exact permitted-purpose provisions, including specified organizations, control over any short summary here.

## Inventory and complete texts

- [Dependency inventory](docs/legal/DEPENDENCIES.md): all 109 entries in the Windows Python lock and all 282 non-root entries in the npm lock, including build and optional platform entries.
- [Machine-readable inventory and text hashes](docs/legal/dependencies.json).
- [Models](docs/legal/MODELS.md), [runtime downloads](docs/legal/RUNTIMES.md), and [project artwork](docs/legal/ASSETS.md).
- [LICENSES](LICENSES/) contains unmodified collected upstream license and notice texts. Package-level labels are summaries; embedded-component notices and exceptions remain controlling.

## Principal components

| Component | License / notice scope | Full terms and provenance |
| --- | --- | --- |
| Electron | MIT for Electron; Chromium, Node.js and embedded components have separate licenses | [Electron notice](LICENSES/npm/electron/LICENSE); retain the distributed `LICENSE.electron.txt` and `LICENSES.chromium.html` with an Electron binary |
| Marked | MIT | [Marked notice](LICENSES/npm/marked/LICENSE.md) |
| Python packages | Multiple licenses, including MIT, Apache-2.0, BSD variants, PSF-2.0, MPL-2.0, LGPLv3 for vendored autocommand, and bundled native-component terms | [Versioned package notices](LICENSES/python/); [complete inventory](docs/legal/dependencies.json) |
| certifi | MPL-2.0 for covered certificate data | Preserve its original notices; [MPL text](LICENSES/common/MPL-2.0.txt) and [exact source locations](docs/legal/mpl-sources.json) |
| tqdm | MPL-2.0 and MIT, according to file/author notices | Preserve its original notices; [MPL text](LICENSES/common/MPL-2.0.txt) and [exact source locations](docs/legal/mpl-sources.json) |
| CPython and Python Build Standalone | Python's own licenses and embedded-library terms; the build system has a separate license | [Runtime terms](docs/legal/RUNTIMES.md) |
| Qdrant | Apache-2.0 | [Runtime terms](docs/legal/RUNTIMES.md) |
| llama.cpp / llama-cpp-python | MIT for those projects; backend binaries can include other libraries | [Runtime terms](docs/legal/RUNTIMES.md), [Python inventory](docs/legal/DEPENDENCIES.md) |
| Model weights and tokenizers | Model-specific terms, independent of the inference library | [Pinned model sources and licenses](docs/legal/MODELS.md) |

## Distribution boundaries

The source repository does not contain `node_modules`, Python environments, downloaded model weights, runtime executables, CUDA libraries or the Microsoft Visual C++ Redistributable. Package and runtime installers download their own components separately. Keeping a license text in this repository does not mean the corresponding executable or model is bundled.

A packaged Electron app must retain Electron's complete Chromium/Node.js notices and this legal-text bundle. If a distributor additionally bundles Python, native libraries, models, CUDA components or runtime tools, that distributor must include their exact-version notices and satisfy applicable source-availability, exception and redistribution terms. The dependency inventory alone is not a complete binary SBOM.

Microsoft Visual C++ Redistributable and optional NVIDIA CUDA components are proprietary prerequisites under their vendors' terms. They are not covered by Noda's noncommercial license and are not represented as free/open-source software here. See [runtime prerequisites](docs/legal/RUNTIMES.md).

The MPL terms apply to covered upstream files, including modifications to those files; they do not automatically relicense independent Noda files. GCC runtime notices in native wheels include their stated Runtime Library Exception. Preserve the complete texts rather than replacing them with a package-level label.

## Attribution maintenance

When changing a dependency, model, downloaded tool or artwork, update the corresponding inventory, license texts and provenance before distributing it. Do not remove copyright, NOTICE, license or exception texts. Any modified third-party files must be identified and remain subject to their applicable upstream terms.
