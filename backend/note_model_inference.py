"""Bound note output and retry only a provider-confirmed token-limit failure."""

try:
    from backend.inference_runner import CompletionLimitError
    from backend.note_metadata import metadata_format
except ImportError:
    from inference_runner import CompletionLimitError
    from note_metadata import metadata_format


def generate_note_response(model, prompt, contexts, *, max_tags, max_links):
    initial = max(768, min(4096, model.max_new_tokens))
    parameters = {
        "temperature": 0.0,
        "top_p": 1.0,
        "response_format": metadata_format(max_tags),
        "raise_on_truncation": True,
    }
    print(
        f"Local model note prompt: contexts={len(contexts or [])}, "
        f"length={sum(len(item['content']) for item in prompt) if isinstance(prompt, list) else len(prompt)}"
    )
    try:
        return model._invoke_pipeline(prompt, max_new_tokens=initial, **parameters)
    except CompletionLimitError:
        if initial >= 4096:
            raise
    # The incomplete text is discarded. Never continue it or guess from its shape.
    return model._invoke_pipeline(prompt, max_new_tokens=4096, **parameters)
