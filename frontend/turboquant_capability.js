// Who: Tim Buglaev
// When: 2026-07-02
// What: Evaluate TurboQuant enablement from trusted runtime, catalog, and bounded
//       NVIDIA hardware metadata; unsupported or unverifiable systems fail closed.
"use strict";

const MINIMUM_COMPUTE_CAPABILITY = 7.5;

function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isGgufModel(model) {
  return model?.artifact === "gguf"
    || model?.model_format === "llama_cpp"
    || Boolean(model?.gguf_filename);
}

function unsupported(code, reason, hardware) {
  return {
    supported: false,
    code,
    reason,
    minimumComputeCapability: MINIMUM_COMPUTE_CAPABILITY,
    detectedGpu: String(hardware?.gpuName || "").slice(0, 160),
    detectedVramGb: finitePositive(hardware?.gpuMemoryGb),
    detectedComputeCapability: finitePositive(hardware?.computeCapability),
  };
}

function evaluateTurboQuantCapability({ runtime, model, hardware } = {}) {
  if (runtime?.provider !== "vllm_local" || isGgufModel(model)) {
    return unsupported(
      "runtime_not_vllm",
      "TurboQuant доступен только для GPU-моделей vLLM. Для выбранной GGUF-модели он не используется.",
      hardware
    );
  }

  const gpuName = String(hardware?.gpuName || "").trim();
  const gpuVendor = String(hardware?.gpuVendor || "").toLowerCase();
  if (!gpuName) {
    return unsupported("gpu_unknown", "Видеокарта не определена — включение TurboQuant заблокировано.", hardware);
  }
  if (gpuVendor !== "nvidia") {
    return unsupported("nvidia_required", "Нужна совместимая видеокарта NVIDIA с CUDA.", hardware);
  }

  const computeCapability = finitePositive(hardware?.computeCapability);
  if (!computeCapability) {
    return unsupported(
      "compute_unknown",
      "Не удалось подтвердить поддержку CUDA compute capability 7.5 или новее.",
      hardware
    );
  }
  if (computeCapability < MINIMUM_COMPUTE_CAPABILITY) {
    return unsupported(
      "compute_unsupported",
      `Видеокарта поддерживает compute capability ${computeCapability}, требуется ${MINIMUM_COMPUTE_CAPABILITY} или новее.`,
      hardware
    );
  }

  const vramGb = finitePositive(hardware?.gpuMemoryGb);
  if (!vramGb) {
    return unsupported("vram_unknown", "Не удалось определить объём видеопамяти.", hardware);
  }
  const minimumModelGb = finitePositive(model?.min_memory_gb);
  const runtimeLimit = Math.min(0.95, finitePositive(model?.gpu_memory_utilization) || 0.85);
  const availableModelGb = Math.round(vramGb * runtimeLimit * 10) / 10;
  if (minimumModelGb && availableModelGb < minimumModelGb) {
    return unsupported(
      "model_does_not_fit",
      `Для выбранной модели доступно около ${availableModelGb} GB VRAM, требуется минимум ${minimumModelGb} GB.`,
      hardware
    );
  }

  return {
    supported: true,
    code: "supported",
    reason: `Поддерживается: ${gpuName}, compute capability ${computeCapability}, ${vramGb} GB VRAM.`,
    minimumComputeCapability: MINIMUM_COMPUTE_CAPABILITY,
    detectedGpu: gpuName.slice(0, 160),
    detectedVramGb: vramGb,
    detectedComputeCapability: computeCapability,
  };
}

module.exports = {
  MINIMUM_COMPUTE_CAPABILITY,
  evaluateTurboQuantCapability,
  isGgufModel,
};
