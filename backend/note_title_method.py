"""Explicit immutable title method selection; no automatic quality fallback."""

from dataclasses import dataclass
from types import MappingProxyType


@dataclass(frozen=True)
class TitleMethod:
    name: str
    strategy: str
    stages: int


METHODS = MappingProxyType(
    {
        "reviewed": TitleMethod("reviewed", "review-v1", 2),
        "planned": TitleMethod("planned", "planned-v1", 3),
    }
)


def title_method(value="reviewed"):
    if type(value) is not str or value not in METHODS:
        raise ValueError("Unknown local note title method")
    return METHODS[value]


def generate_selected_title(runtime, source, *, reviewed):
    """Keep the previous reviewed entry point as the unchanged default."""
    method = title_method(
        getattr(runtime, "RAG_NOTE_TITLE_METHOD", "reviewed")
    )
    if method.name == "reviewed":
        result = reviewed(runtime, source)
    else:
        from backend.note_title_planned import generate_title

        result = generate_title(runtime, source)
    return method, result
