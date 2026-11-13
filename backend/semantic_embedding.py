"""Never substitute random/hash coordinates for an unavailable semantic model."""

import math
import os


class EmbeddingUnavailable(RuntimeError):
    pass


def semantic_search_disabled():
    return os.environ.get("NODA_SEMANTIC_SEARCH_ENABLED") == "0"


def semantic_model_status(runtime):
    if semantic_search_disabled():
        return "disabled"
    if hasattr(runtime, "_embedding_model"):
        return "ready" if runtime._embedding_model is not None else "unavailable"
    return None


def encode_semantic(model, text, expected_dimensions=None):
    if model is None:
        raise EmbeddingUnavailable("Семантическая модель поиска недоступна.")
    try:
        try:
            values = model.encode(
                text or "", normalize_embeddings=True, show_progress_bar=False
            )
        except TypeError:
            values = model.encode(text or "", normalize_embeddings=True)
        vector = values.tolist() if hasattr(values, "tolist") else list(values)
        if not vector or any(
            not isinstance(value, (int, float)) or not math.isfinite(value)
            for value in vector
        ):
            raise ValueError("Invalid embedding values")
        if not any(vector):
            raise ValueError("Zero embedding")
        if expected_dimensions and len(vector) != expected_dimensions:
            raise ValueError("Embedding dimension does not match the index")
        return vector
    except Exception as exc:
        raise EmbeddingUnavailable(
            "Семантический поиск не смог вычислить вектор. Проверьте модель и индекс."
        ) from exc
