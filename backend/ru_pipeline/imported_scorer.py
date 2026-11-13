"""Load user rerankers with the local Transformers model classes."""

import json

from .imported_models import WEIGHTS_INDEX, verified_folder
from .scorer_contract import ScorerAssetError, ScorerContextError, ScorerFailure


def validate_checkpoint(item, root):
    folder = verified_folder(item, root)
    names = {asset.name for asset in item.files}
    if WEIGHTS_INDEX in names:
        with (folder / WEIGHTS_INDEX).open("rb") as stream:
            raw = stream.read(16 * 1024 * 1024 + 1)
        if len(raw) > 16 * 1024 * 1024:
            raise ScorerAssetError("Safetensors index is too large")
        index = json.loads(raw).get("weight_map")
        if not isinstance(index, dict) or not index or set(index.values()) != {
            name for name in names if name.endswith(".safetensors")
        }:
            raise ScorerAssetError("Safetensors index does not match the verified shards")
    return folder


def load_local_weights(model_class, folder, item, torch, config):
    size = sum(asset.size for asset in item.files if asset.name.endswith(".safetensors"))
    gpu_budget = {
        index: max(0, torch.cuda.mem_get_info(index)[0] - 768 * 1024**2)
        for index in range(torch.cuda.device_count())
    }
    placement = {}
    if size * 1.2 < sum(gpu_budget.values()):
        placement = {"device_map": "auto", "max_memory": gpu_budget}
    model, info = model_class.from_pretrained(
        folder, config=config, local_files_only=True, trust_remote_code=False,
        use_safetensors=True, dtype="auto", output_loading_info=True, **placement,
    )
    if info.get("missing_keys") or info.get("mismatched_keys"):
        raise ScorerAssetError("Reranker checkpoint lacks compatible trained weights")
    model.eval()
    return model


class ClassificationScorer:
    def __init__(self, folder, item, config):
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        if config.num_labels not in (1, 2):
            raise ScorerAssetError("One relevance logit or two class logits required")
        self.torch = torch
        torch.set_num_threads(4)
        self.tokenizer = AutoTokenizer.from_pretrained(
            folder, local_files_only=True, trust_remote_code=False,
        )
        self.model = load_local_weights(AutoModelForSequenceClassification, folder, item, torch, config)
        self.context = min(8192, self.tokenizer.model_max_length,
                           getattr(config, "max_position_embeddings", 8192))
        self.positive = next((index for index, label in config.id2label.items()
                              if label.casefold() in {"relevant", "positive", "yes", "match", "entailment"}), 1)

    def score(self, pair):
        from .scorer_qwen import relevance_probability

        inputs = self.tokenizer(pair["source"], pair["target"], truncation=False, return_tensors="pt")
        if not 0 < inputs["input_ids"].shape[-1] <= self.context:
            raise ScorerContextError("Full pair exceeds reranker token budget")
        with self.torch.inference_mode():
            logits = self.model(**inputs.to(self.model.device)).logits
        if tuple(logits.shape) == (1, 1):
            return relevance_probability(logits[0, 0].item(), 0.0)
        if tuple(logits.shape) == (1, 2):
            values = logits[0].float().tolist()
            return relevance_probability(values[self.positive], values[1 - self.positive])
        raise ScorerFailure("Unexpected reranker output")

    def close(self):
        self.model = self.tokenizer = None


def create_imported_scorer(item, root, stage):
    import torch
    from transformers import AutoConfig

    from .scorer_qwen import QwenScorer

    try:
        folder = validate_checkpoint(item, root)
        config = AutoConfig.from_pretrained(folder, local_files_only=True, trust_remote_code=False)
        architectures = config.architectures or ()
        if getattr(config, "quantization_config", None):
            raise ScorerAssetError("Checkpoint requires a separate quantization backend")
        if config.model_type == "qwen3" and "Qwen3ForCausalLM" in architectures:
            return QwenScorer(None, root, stage, imported=(folder, item, config))
        if any(name.endswith("ForSequenceClassification") for name in architectures):
            return ClassificationScorer(folder, item, config)
        raise ScorerAssetError("Unsupported reranker scoring head")
    except (torch.OutOfMemoryError, MemoryError):
        raise
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError) as error:
        raise ScorerAssetError("Invalid or unsupported reranker checkpoint") from error
