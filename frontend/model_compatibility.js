// Who: Tim Buglaev
// When: 2026-06-24
// What: Evaluate whether a catalog model fits the detected PC using structured
//       RAM/VRAM requirements and runtime memory limits, without model-name rules.
(function exposeModelCompatibility(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.modelCompatibility = api;
  }
})(typeof window !== "undefined" ? window : null, (root) => {
  "use strict";

  function finitePositive(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function requirementsFor(model) {
    const memoryType = model?.memory_type === "vram" ? "vram" : "ram";
    const fallbackSize = finitePositive(model?.estimated_download_gb) || 1;
    const minimumGb = finitePositive(model?.min_memory_gb)
      || Math.max(2, Math.ceil(fallbackSize * (memoryType === "vram" ? 1.25 : 1.5)));
    const recommendedGb = Math.max(
      minimumGb,
      finitePositive(model?.recommended_memory_gb) || Math.ceil(minimumGb * 1.35)
    );
    return { memoryType, minimumGb, recommendedGb };
  }

  function availableFor(model, hardware) {
    const requirements = requirementsFor(model);
    if (requirements.memoryType === "ram") {
      return finitePositive(hardware?.ramGb);
    }
    const detectedVram = finitePositive(hardware?.gpuMemoryGb);
    if (!detectedVram) {
      return null;
    }
    const runtimeLimit = finitePositive(model?.gpu_memory_utilization) || 0.85;
    return Math.round(detectedVram * Math.min(0.95, runtimeLimit) * 10) / 10;
  }

  function evaluate(model, hardware, locale = "ru-RU") {
    const requirements = requirementsFor(model);
    const availableGb = availableFor(model, hardware);
    let level = "edge";
    if (availableGb !== null && availableGb >= requirements.recommendedGb) {
      level = "fit";
    } else if (availableGb !== null && availableGb < requirements.minimumGb) {
      level = "hard";
    }
    const t = (ru, en) => root?.nodaI18n?.t(ru, en) ?? (locale === "en-US" ? en : ru);
    const labels = {
      fit: t("Потянет", "Good fit"),
      edge: t("На грани", "Borderline"),
      hard: t("Тяжело", "Too demanding"),
    };
    const memoryLabel = requirements.memoryType === "vram" ? "VRAM" : "RAM";
    const available = `About ${availableGb} GB ${memoryLabel} available`;
    const details = {
      unknown: t(
        `${memoryLabel} не удалось определить. Требуется минимум ${requirements.minimumGb} GB.`,
        `${memoryLabel} could not be detected. At least ${requirements.minimumGb} GB required.`
      ),
      fit: t(
        `Доступно около ${availableGb} GB ${memoryLabel}; рекомендуется ${requirements.recommendedGb} GB.`,
        `${available}. ${requirements.recommendedGb} GB recommended.`
      ),
      edge: t(
        `Доступно около ${availableGb} GB ${memoryLabel}; возможны замедления.`,
        `${available}. May run slowly.`
      ),
      hard: t(
        `Доступно около ${availableGb} GB ${memoryLabel}, требуется минимум ${requirements.minimumGb} GB.`,
        `${available}. At least ${requirements.minimumGb} GB required.`
      ),
    };
    return {
      ...requirements,
      availableGb,
      level,
      label: labels[level],
      detail: details[availableGb === null ? "unknown" : level],
    };
  }

  return { availableFor, evaluate, requirementsFor };
});
