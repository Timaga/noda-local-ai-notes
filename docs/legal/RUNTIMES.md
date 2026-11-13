# Runtime licenses and distribution boundary

The source repository does not contain downloaded Python, Qdrant, llama.cpp,
Microsoft, NVIDIA, or model binaries. Pinned download URLs and checksums are in
`scripts/windows-portable/runtime-assets.json` and `llama-cpu-assets.json`.
Noda's application license does not relicense these components.

| Component | Pinned build | Upstream license / terms | Included license text |
| --- | --- | --- | --- |
| Qdrant | `1.16.0` | [Apache-2.0](https://github.com/qdrant/qdrant/blob/v1.16.0/LICENSE) | `LICENSES/runtime/Qdrant-LICENSE.txt` |
| llama.cpp CPU | `b11564`, commit `08ffba21e5c2f1728b6b405c05ff3913f65706d4` | [MIT](https://github.com/ggml-org/llama.cpp/blob/08ffba21e5c2f1728b6b405c05ff3913f65706d4/LICENSE) | `LICENSES/runtime/llama.cpp-LICENSE.txt` |
| LLVM OpenMP | The exact DLL and accompanying notice are pinned by file hashes | [Apache-2.0 with LLVM exception plus preserved legacy notices](https://github.com/llvm/llvm-project/blob/main/openmp/LICENSE.TXT) | `LICENSES/runtime/LLVM-OpenMP-LICENSE.txt` |
| CPython | `3.13.14`, python-build-standalone `20260728` | [PSF license and historical notices](https://github.com/python/cpython/blob/v3.13.14/LICENSE), plus component licenses | `LICENSES/runtime/CPython-3.13.14-LICENSE.txt` and `CPython-installed-LICENSE.txt` |
| python-build-standalone build system | `20260728` | [MPL-2.0](https://github.com/astral-sh/python-build-standalone/blob/20260728/LICENSE) | `LICENSES/runtime/python-build-standalone-build-system-LICENSE.txt`; build-system terms do not replace output component licenses |
| Microsoft Visual C++ Redistributable | `14.51.36247.0` | [Microsoft proprietary license terms](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170) | Downloaded separately from Microsoft when required; not relicensed by Noda |
| NVIDIA CUDA libraries | Developer configuration only; excluded from portable CPU release | [NVIDIA SDK agreement and CUDA supplement](https://docs.nvidia.com/cuda/eula/index.html) | No NVIDIA binaries included in this source release |

License text retrieval details and hashes are recorded in
`LICENSES/runtime-model-provenance.json`. The existing OpenMP notice was copied
without alteration and matches the pinned notice hash in the runtime manifests.
Missing optional upstream `NOTICE` paths were recorded rather than invented.

## Before distributing a binary bundle

- Preserve the complete Electron distribution's `LICENSE.electron.txt` and
  `LICENSES.chromium.html`, together with notices of Python wheels, npm modules,
  downloaded runtimes, and models actually included in that artifact.
- Carry the MIT notice for llama.cpp and Apache license for Qdrant into the
  release. The original provisioner extracts selected executable files, so the
  notices directory must also be packaged explicitly.
- Retain CPython's notices and audit the built-in libraries in the exact
  python-build-standalone artifact. Its [full distribution metadata](https://gregoryszorc.com/docs/python-build-standalone/main/distributions.html)
  records license paths for built-in components. The installed `LICENSE.txt`
  alone is not a complete inventory of OpenSSL, SQLite, zlib, libffi, Tcl/Tk, or
  other libraries that may be bundled; Python wheel metadata is a separate
  inventory. Review the exact artifact rather than assuming that list is
  exhaustive or that every listed library is included.
- Keep Microsoft's prerequisite installer under Microsoft's own terms. Those
  terms, including redistribution eligibility, require separate review if
  repackaging that installer. It is not open-source software.
- Do not add developer CUDA DLLs to a release merely because llama.cpp uses
  MIT. NVIDIA's terms separately govern which library binaries may be
  redistributed and how they may be used.

This source preparation does not establish complete third-party compliance for
future binaries assembled outside this source tree.
