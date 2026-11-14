"""Retired fine-tuning entry points fail before loading models or writing data.

Re-enabling training requires a reviewed implementation and real export validation.
Note generation, embeddings and RAG use separate inference paths.
"""

MESSAGE = "Model fine-tuning is disabled in this release."


def disabled_training_status():
    return {"success": False, "status": "disabled", "error": "training_disabled", "message": MESSAGE}


class TrainingDisabledError(RuntimeError):
    """The retired fine-tuning API cannot start an experiment."""


class TrainingPipeline:
    """Reject legacy callers instead of producing simulated training artifacts."""

    def __init__(self, *args, **kwargs):
        raise TrainingDisabledError(MESSAGE)

    def run(self):
        raise TrainingDisabledError(MESSAGE)
