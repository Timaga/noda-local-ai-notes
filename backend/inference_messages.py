"""Bounded text-only chat inputs shared by local inference adapters."""


def chat_messages(prompt, *, max_chars=32000):
    if isinstance(prompt, str):
        return [{"role": "user", "content": prompt}]
    if not isinstance(prompt, list) or not 1 <= len(prompt) <= 20:
        raise ValueError("Expected text or a bounded chat message list")
    result = []
    for index, message in enumerate(prompt):
        if (
            not isinstance(message, dict)
            or set(message) != {"role", "content"}
            or message["role"] not in ("system", "user", "assistant")
            or not isinstance(message["content"], str)
            or (message["role"] == "system" and index != 0)
        ):
            raise ValueError("Invalid text chat message")
        result.append(dict(message))
    if result[-1]["role"] != "user" or (
        max_chars is not None
        and sum(len(item["content"]) for item in result) > max_chars
    ):
        raise ValueError("Invalid or oversized chat request")
    return result


def transformer_prompt(pipeline, prompt):
    if isinstance(prompt, str):
        return prompt
    messages = chat_messages(prompt)
    tokenizer = getattr(pipeline, "tokenizer", None)
    if tokenizer is not None and getattr(tokenizer, "chat_template", None):
        return tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
    # Plain completion models lack a native role template. Keep every message
    # visible as explicitly labelled text without inventing provider tokens.
    return (
        "\n\n".join(f"{item['role'].upper()}:\n{item['content']}" for item in messages)
        + "\n\nASSISTANT:\n"
    )
