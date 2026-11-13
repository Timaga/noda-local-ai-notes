"""Versioned, user-visible note processing modes."""

ORGANIZE = "organize"
ORGANIZE_EDIT = "organize_edit"
PROCESSING_VERSION = "note-processing-v1"
MODES = frozenset((ORGANIZE, ORGANIZE_EDIT))


def validate_mode(mode):
    if not isinstance(mode, str) or mode not in MODES:
        raise ValueError("Некорректный режим обработки заметки.")
    return mode
