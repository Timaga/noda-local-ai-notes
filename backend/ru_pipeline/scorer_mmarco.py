"""Selected local mMARCO INT8 cross encoder; full pairs and raw logits."""

from .scorer_assets import verify_assets
from .scorer_contract import ScorerContextError, ScorerFailure


class MMarcoScorer:
    def __init__(self, descriptor, project_root):
        folder = verify_assets("mmarco", descriptor, project_root)
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.np = np
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.enable_mem_pattern = False
        options.enable_cpu_mem_arena = False
        self.session = ort.InferenceSession(
            str(folder / "onnx/model_quint8_avx2.onnx"),
            options,
            providers=["CPUExecutionProvider"],
        )
        try:
            if self.session.get_providers() != ["CPUExecutionProvider"]:
                raise ScorerFailure("CPU-only scorer required")
            if {item.name for item in self.session.get_inputs()} != {
                "input_ids",
                "attention_mask",
            }:
                raise ScorerFailure("Unexpected native input schema")
            if [item.name for item in self.session.get_outputs()] != ["logits"]:
                raise ScorerFailure("Unexpected native output schema")
            self.tokenizer = Tokenizer.from_file(str(folder / "tokenizer.json"))
            self.tokenizer.no_truncation()
        except BaseException:
            self.session = None
            raise

    def score(self, pair):
        if self.session is None:
            raise ScorerFailure("Scorer is closed")
        encoded = self.tokenizer.encode(pair["source"], pair["target"])
        if not 0 < len(encoded.ids) <= 512:
            raise ScorerContextError("Full pair exceeds mMARCO token budget")
        inputs = {
            "input_ids": self.np.asarray([encoded.ids], dtype=self.np.int64),
            "attention_mask": self.np.asarray(
                [encoded.attention_mask], dtype=self.np.int64
            ),
        }
        output = self.np.asarray(self.session.run(["logits"], inputs)[0])
        if output.shape != (1, 1) or not self.np.isfinite(output).all():
            raise ScorerFailure("Finite single native raw logit required")
        return float(output[0, 0])

    def close(self):
        self.session = None
        self.tokenizer = None
