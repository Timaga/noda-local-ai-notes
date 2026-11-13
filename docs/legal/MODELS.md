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

## Custom and imported profiles

Custom or imported profiles, including local ruadapt, Gemma, Qwen2.5 and T-lite descriptors, are outside this portable catalog. A profile name or descriptor does not grant model-weight rights. No weights for these profiles are included; users and distributors must review each actual publisher, revision, license and optional native runtime before downloading, using or redistributing them.

## Release boundary

Source releases must exclude `models/`, downloaded model caches, local runtime
executables, and developer CUDA binaries. Adding weights to a later release
requires a fresh review of the exact revision, its complete notices, and the
release contents. The source-only review does not certify an independently
assembled binary/model bundle.
