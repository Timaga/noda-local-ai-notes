(() => {
  "use strict";

  const englishCatalog = {
    t_lite_it_2_1_q4_k_m: {
      quality: "Russian notes",
      description: "Default GGUF profile for editing Russian notes and generating titles, tags, and links.",
      hardware: "12–16 GB RAM. Balances quality and size.",
    },
    t_lite_it_2_1_q5_k_m: {
      quality: "Better editing",
      description: "Higher-quality T-lite GGUF profile for systems with enough RAM and acceptable speed.",
      hardware: "16–24 GB RAM. Fewer artifacts than Q4_K_M.",
    },
    t_lite_it_2_1_q6_k: {
      quality: "Higher quality",
      description: "Larger profile closer to the full model for final edits to Russian notes.",
      hardware: "16–24 GB RAM. Consider it if Q5_K_M runs fast enough.",
    },
    qwen3_4b_instruct_2507_q4_k_m: {
      quality: "Low-spec PCs",
      description: "Lightweight GGUF fallback for running locally with minimal resources.",
      hardware: "8 GB RAM, CPU only. Lightweight, with lower Russian editing quality.",
    },
    vikhr_nemo_12b_q4_k_m: {
      quality: "Russian RAG",
      description: "Large Russian GGUF profile for evaluating RAG quality on more powerful PCs.",
      hardware: "24–32 GB RAM. Use as a high-quality reference model.",
    },
    qwen3_5_2b: {
      quality: "Test both modes",
      description: "Local model for testing note organization and editing in vLLM.",
      hardware: "Tested with 12 GB VRAM and an 8,192-token context.",
    },
    qwen2_5_1_5b: {
      quality: "Quick testing",
      description: "Lightweight profile for low-spec PCs and quick checks. Title and link quality is limited.",
      hardware: "CPU or older GPU. Suitable for checking the pipeline.",
    },
    qwen2_5_3b: {
      quality: "Balanced",
      description: "Stronger option for Russian notes with a modest increase in hardware requirements.",
      hardware: "8–12 GB VRAM recommended, or a CPU that can run it at an acceptable speed.",
    },
    qwen2_5_7b: {
      quality: "High quality",
      description: "4-bit AWQ model for editing and generating titles, tags, and links in vLLM.",
      hardware: "8–12 GB VRAM. Runs on the GPU without loading the full BF16 weights.",
    },
    qwen2_5_14b: {
      quality: "High-end evaluation",
      description: "Profile for evaluating the upper range of quality on a powerful PC.",
      hardware: "Requires a GPU with substantial VRAM. Unsuitable for older GPUs.",
    },
  };

  const englishLanguages = new Map([
    ["русский", "Russian"], ["английский", "English"], ["универсальный", "General purpose"],
    ["многоязычный", "Multilingual"],
  ]);

  const isEnglish = () => window.nodaI18n?.isEnglish() ?? false;
  const localize = (english) => window.nodaI18n?.t(english, english) ?? english;

  function catalogText(model, field, fallbackRu, fallbackEn) {
    const source = String(model?.[field] || "");
    if (!isEnglish()) return source || fallbackRu;
    const translated = Object.hasOwn(englishCatalog, model?.id) ? englishCatalog[model.id][field] : "";
    return translated ? localize(translated) : (source && !/[А-Яа-яЁё]/u.test(source) ? source : localize(fallbackEn));
  }

  function language(model) {
    const source = String(model?.language || "");
    if (!isEnglish()) return source || "Универсальный";
    const translated = englishLanguages.get(source.toLowerCase());
    return translated ? localize(translated) : (source && !/[А-Яа-яЁё]/u.test(source) ? source : localize("General purpose"));
  }

  function turboquantReason(capability = {}) {
    if (!isEnglish()) {
      return capability.reason || "Совместимость TurboQuant не подтверждена — включение заблокировано.";
    }
    switch (capability.code) {
      case "runtime_not_vllm": return localize("TurboQuant requires a vLLM GPU model and is unavailable for GGUF models.");
      case "gpu_unknown": return localize("TurboQuant is unavailable because the GPU could not be detected.");
      case "nvidia_required": return localize("A compatible NVIDIA GPU with CUDA is required.");
      case "compute_unknown": return localize("CUDA compute capability 7.5 or newer could not be verified.");
      case "compute_unsupported": return localize("This GPU does not meet the minimum CUDA compute capability of 7.5.");
      case "vram_unknown": return localize("The amount of video memory could not be detected.");
      case "model_does_not_fit": return localize("There is not enough video memory for the selected model.");
      default: {
        if (!capability.supported) return localize("TurboQuant compatibility could not be verified.");
        const gpu = [
          capability.detectedGpu,
          capability.detectedComputeCapability && localize(`compute capability ${capability.detectedComputeCapability}`),
          capability.detectedVramGb && localize(`${capability.detectedVramGb} GB VRAM`),
        ].filter(Boolean).join(", ");
        return gpu ? localize(`Supported: ${gpu}.`) : localize("TurboQuant is supported on this PC.");
      }
    }
  }

  window.modelLocale = {
    description: (model, ru = "Локальная модель для заметок и чата.", en = "Local model for notes and chat.") => (
      catalogText(model, "description", ru, en)
    ),
    quality: (model, ru = "Профиль", en = "Profile") => catalogText(model, "quality", ru, en),
    hardware: (model) => catalogText(model, "hardware", "По конфигурации", "Depends on your hardware"),
    language,
    turboquantReason,
  };
})();
