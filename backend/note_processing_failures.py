"""Stable failure attribution without treating infrastructure faults as semantics."""

try:
    from backend.note_generation_contract import NoteGenerationError
except ImportError:
    from note_generation_contract import NoteGenerationError


class NoteSystemError(NoteGenerationError):
    failure_kind = "system"

    def __init__(self, message, *, failure_code="runtime_failed"):
        super().__init__(message)
        self.failure_code = failure_code


class NoteModelResponseError(NoteGenerationError):
    failure_kind = "model_response"
    failure_code = "invalid_model_response"
