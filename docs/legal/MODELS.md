# Model licenses and provenance

Noda's application license covers Noda-owned code. It does not replace the
licenses of model weights, tokenizers, runtimes, or dependencies. The source
repository contains download descriptors, not model weights. Models are fetched
separately from their upstream publishers; retain their license and attribution
files if redistributing them.

## Portable model catalog

The following exact model-card revisions declare **Apache-2.0**. This is a
permissive upstream license that allows commercial use of the models themselves;
Noda cannot withdraw those upstream permissions. Noda's own noncommercial terms
still apply to Noda-owned code.

| Purpose | Upstream model | Pinned revision |
| --- | --- | --- |
| Default title generation | [Unsloth Qwen3.5-4B GGUF](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF) | `e87f176479d0855a907a41277aca2f8ee7a09523` |
| Alternative title generation | [ggml-org Qwen3-4B-Instruct-2507 Q8_0 GGUF](https://huggingface.co/ggml-org/Qwen3-4B-Instruct-2507-Q8_0-GGUF) | `e6f794d44f9395d0184a966c27b5ae99ea356fcb` |
| Relevance scoring | [mMARCO mMiniLMv2 L12 H384](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1) | `1427fd652930e4ba29e8149678df786c240d8825` |
| Alternative relevance scoring | [Qwen3-Reranker-0.6B](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) | `e61197ed45024b0ed8a2d74b80b4d909f1255473` |
| Multilingual embeddings | [paraphrase-multilingual-mpnet-base-v2](https://huggingface.co/sentence-transformers/paraphrase-multilingual-mpnet-base-v2) | `4328cf26390c98c5e3c738b4460a05b95f4911f5` |

Publisher attribution: Qwen / Alibaba Cloud (Qwen models), Unsloth and ggml-org
(GGUF distributions), cross-encoder / Sentence Transformers (mMARCO), and
Sentence Transformers (multilingual MPNet). Listing these projects does not imply
endorsement.

The complete Apache license is in `LICENSES/models/Apache-2.0.txt`.
`Qwen3.5-4B-base-LICENSE.txt` and `Qwen3-4B-Instruct-2507-base-LICENSE.txt`
preserve the base publishers' current license texts and copyright notices. The
base texts were retrieved from upstream `main`; the quantized model license
declarations were verified separately at the pinned revisions above.

Descriptors in `backend/ru_pipeline/assets/` and
`scripts/windows-portable/embedding-profile.json` record the actual model-file
checksums. `LICENSES/runtime-model-provenance.json` records the license retrieval
URLs, observations, and checksums. A complete recursive public file-tree check
of all five pinned repositories found no separate paths named `LICENSE*`,
`LICENCE*`, `NOTICE*`, `COPYING*`, or `COPYRIGHT*`; the Apache declarations are in
their pinned model cards. This does not turn the models into Noda-owned material.

The local Qwen reranker descriptor does include `LICENSE-2.0.txt`. This is
intentionally downloaded from the Apache Foundation, not from the Hugging Face
model repository: `backend/ru_pipeline/model_downloads.py` selects
`https://www.apache.org/licenses/LICENSE-2.0.txt` for that file. Its pinned size
is 11,358 bytes and SHA-256 is
`cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`, matching
`LICENSES/models/Apache-2.0.txt` included here.

When redistributing models, supply the upstream license, preserve applicable
copyright and attribution notices, identify modifications, and carry forward
any upstream NOTICE material. Merely linking to a license is insufficient when
the license requires a copy. Model-card declarations do not guarantee training
data rights, output rights, accuracy, or suitability for a particular use.

## Restricted developer integrations

These experimental options are excluded from the portable model catalog and
their weights are excluded from the source distribution. Their descriptors are
not permission to use or redistribute their weights.

| Model | Revision | Status |
| --- | --- | --- |
| [Qwen2.5-3B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF) | `7dabda4d13d513e3e842b20f0d435c732f172cbe` | Qwen Research License; research/evaluation restrictions, separate commercial permission required. This is narrower than a general personal-use license. |
| [Tev1-0.8B-experimental](https://huggingface.co/togethercomputer/Tev1-0.8B-experimental) | `6bb2dff14b38fea90ddb14d870166ccaf77374e9` | The pinned publisher card says the fine-tuned weights' release license is still being finalized. Redistribution permission has not been established. |

The Qwen Research License is preserved as
`LICENSES/models/Qwen2.5-3B-research-LICENSE.txt` for transparency about that
optional integration. Its presence does not make Qwen2.5 part of the release.
Do not infer a license for Tev weights from its Apache-licensed base model.

## Source and developer defaults

The five portable entries above do not cover every model path in this source
repository. Without `NODA_RUNTIME_HOME`, the legacy note-stage defaults in
`backend/ru_pipeline/pair_settings.py` select Qwen2.5-3B for titles and Tev for
tags. Their restrictions above also apply to developer runs. Ordinary personal
note-taking is not automatically covered by a research/evaluation-only grant;
Tev's unfinished weight license is not established permission for that use.

Packaged Windows runs set `NODA_RUNTIME_HOME`, use Qwen3.5 with mMARCO by default,
and exclude built-in Qwen2.5-3B/Tev pairs from the selectable catalog and saved
selection checks. This is a boundary of the packaged catalog, not a license
approval for arbitrary models that users import separately.

## Nonportable chat catalog

`backend/model_catalog.py` also exposes these ten choices from eight repositories
when no portable runtime is configured. These are actual developer download
options, distinct from the local offline profiles below.

The official publisher metadata was observed on **2026-11-13**. The revisions in
this table record those observations; **the legacy catalog does not pin them**.
Its snapshot/GGUF download helpers can resolve a newer upstream revision.
Metadata labels alone are not a completed review of exact weights, base-model
conditions or redistribution notices. Review and pin the selected artifact
before relying on it for use or distribution.

| Developer catalog choice | Publisher repository | Observed revision | Declared model-card license |
| --- | --- | --- | --- |
| T-lite-it 2.1 Q4_K_M | [t-tech/T-lite-it-2.1-GGUF](https://huggingface.co/t-tech/T-lite-it-2.1-GGUF) | `fc10186e59064c2e74f59c3d5dbce233931b3b81` | Apache-2.0 |
| T-lite-it 2.1 Q5_K_M | [t-tech/T-lite-it-2.1-GGUF](https://huggingface.co/t-tech/T-lite-it-2.1-GGUF) | `fc10186e59064c2e74f59c3d5dbce233931b3b81` | Apache-2.0 |
| T-lite-it 2.1 Q6_K | [t-tech/T-lite-it-2.1-GGUF](https://huggingface.co/t-tech/T-lite-it-2.1-GGUF) | `fc10186e59064c2e74f59c3d5dbce233931b3b81` | Apache-2.0 |
| Qwen3 4B Instruct 2507 Q4_K_M | [unsloth/Qwen3-4B-Instruct-2507-GGUF](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF) | `a06e946bb6b655725eafa393f4a9745d460374c9` | Apache-2.0 |
| Vikhr-Nemo 12B Q4_K_M | [VlSav/Vikhr-Nemo-12B-Instruct-R-21-09-24-Q4_K_M-GGUF](https://huggingface.co/VlSav/Vikhr-Nemo-12B-Instruct-R-21-09-24-Q4_K_M-GGUF) | `d479412913f4de12beffc32824df932bfc3968c4` | Apache-2.0 |
| Qwen3.5 2B | [Qwen/Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B) | `15852e8c16360a2fea060d615a32b45270f8a8fc` | Apache-2.0 |
| Qwen2.5 1.5B Instruct | [Qwen/Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct) | `989aa7980e4cf806f80c7fef2b1adb7bc71aa306` | Apache-2.0 |
| Qwen2.5 3B Instruct | [Qwen/Qwen2.5-3B-Instruct](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct) | `aa8e72537993ba99e69dfaafa59ed015b17504d1` | Qwen Research License; research/evaluation only |
| Qwen2.5 7B Instruct AWQ | [Qwen/Qwen2.5-7B-Instruct-AWQ](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-AWQ) | `b25037543e9394b818fdfca67ab2a00ecc7dd641` | Apache-2.0 |
| Qwen2.5 14B Instruct | [Qwen/Qwen2.5-14B-Instruct](https://huggingface.co/Qwen/Qwen2.5-14B-Instruct) | `cf98f3b3bbb457ad9e2bb7baf9a0125b6b88caa8` | Apache-2.0 |

The Qwen2.5-3B publisher's [license at the observed revision](https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/blob/aa8e72537993ba99e69dfaafa59ed015b17504d1/LICENSE)
contains its research restrictions. Do not infer that license from another
Qwen2.5 size, or treat Noda's own noncommercial license as permission for the
upstream weights. None of these developer-catalog weights are included here.

## Custom and imported profiles

### Local offline profiles

`frontend/owned_note_profiles.json` includes local ruadapt, Gemma4, Qwen2.5-7B and
T-lite-1.0 paths and file hashes. These are distinct from the T-lite-2.1 chat
catalog. They do not record a publisher, exact upstream revision or license.
The owned-profile launcher requires existing local files and disables downloads;
the term "owned" describes the controlled runtime profile, not ownership of
upstream model rights. No corresponding weights are included. Rights to the
application code and artwork do not establish rights to these model weights.

### User imports

The importer validates public accessibility, supported artifact shape, commit and
file integrity, and can run technical compatibility checks. It rejects private,
gated and disabled repositories. It **does not validate or record a model's
license**, and the resulting local descriptor is not a rights clearance.
An ungated public download can still have research, redistribution or other
restrictions. Before importing, using or redistributing any model, users and
distributors must review the exact publisher, revision, full terms, attribution,
base-model conditions and any optional native runtime separately.

## Release boundary

Source releases must exclude `models/`, downloaded model caches, local runtime
executables, and developer CUDA binaries. Adding weights to a later release
requires a fresh review of the exact revision, its complete notices, and the
release contents. The source-only review does not certify an independently
assembled binary/model bundle.
