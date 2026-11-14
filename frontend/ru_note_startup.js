"use strict";

const { translate } = require("./ui_languages");
const PROFILE_ID = "ru-three-stage-v1";

function usesRuNotePipeline(runtime) {
  return runtime?.note_pipeline?.enabled === true
    && runtime.note_pipeline.profile === PROFILE_ID;
}

function shouldStartManagedAtStartup(runtime) {
  return runtime?.provider === "vllm_local" && !usesRuNotePipeline(runtime);
}

function startupReadyStatus(runtime, language = "ru") {
  const t = (ru, en) => translate(language, ru, en);
  if (!usesRuNotePipeline(runtime)) {
    return {
      message: t("Все сервисы готовы", "All services are ready"),
      detail: t("Backend, Qdrant, заметки и модель готовы к работе.", "Local services, notes, and the model are ready."),
    };
  }
  if (runtime.note_pipeline.configurationError) {
    return {
      message: t("Приложение готово", "Noda is ready"),
      detail: t("Не удалось прочитать сохранённые связки. Сохраните их заново в настройках.",
        "Could not read the saved model pairs. Save your pairs again in Settings."),
    };
  }
  const bilingual = Array.isArray(runtime.note_pipeline.supported_languages)
    && runtime.note_pipeline.supported_languages.includes("en");
  return {
    message: bilingual ? t("Конвейер RU/EN настроен", "RU/EN note processing is ready")
      : t("Русский конвейер настроен", "Russian note processing is ready"),
    detail: t("Модели для заголовков, тегов и связей загружаются по этапам. Модель чата загружается по запросу.",
      "Models for titles, tags, and note links load by stage. The chat model loads on demand."),
  };
}

async function ensureManagedQuietly(options, runtime) {
  if (runtime?.provider === "vllm_local") {
    const progress = options.startupProgress;
    if (progress) progress.set(progress.get() + 1);
    try {
      await options.ensureManagedRuntimeReady(runtime);
    } finally {
      if (progress) progress.set(Math.max(0, progress.get() - 1));
    }
  }
}

async function ensureChatRuntimeReady(options) {
  if (options.allowed !== true) return options.deny();
  await options.ensureBackendReady();
  const runtime = await options.fetchRuntimeConfig();
  await ensureManagedQuietly(options, runtime);
  return { ok: true };
}

function isGenerationSender(event, windows) {
  // Identity-only helper. Privileged desktop IPC uses renderer_trust instead.
  return windows.some(window => Boolean(window && !window.isDestroyed() && event.sender === window.webContents));
}

async function ensureGenerationRuntimeReady(options) {
  if (options.allowed !== true) return options.deny();
  await options.ensureBackendReady();
  const runtime = await options.fetchRuntimeConfig();
  if (!usesRuNotePipeline(runtime)) return { ok: true };
  const draft = options.draft;
  const mode = draft?.mode ?? "organize";
  if (typeof draft?.prompt !== "string" || draft.prompt.length > 65536
      || typeof mode !== "string" || mode.length > 32) {
    throw new Error("Некорректный исходник или режим заметки.");
  }
  const response = await options.fetchWithTimeout(`${options.backendUrl}/generate/runtime`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: draft.prompt, mode }),
  });
  const policy = await options.readJsonResponse(response);
  if (!response.ok) throw new Error(policy?.error || `Runtime policy failed: HTTP ${response.status}`);
  if (!policy || typeof policy !== "object" || Array.isArray(policy)
      || typeof policy.requires_legacy_runtime !== "boolean"
      || (policy.requires_legacy_runtime ? policy.profile !== null : policy.profile !== PROFILE_ID)) {
    throw new Error("Сервер вернул некорректный маршрут обработки заметки.");
  }
  if (policy.requires_legacy_runtime) await ensureManagedQuietly(options, runtime);
  return { ok: true };
}

module.exports = {
  PROFILE_ID,
  usesRuNotePipeline,
  shouldStartManagedAtStartup,
  startupReadyStatus,
  ensureChatRuntimeReady,
  isGenerationSender,
  ensureGenerationRuntimeReady,
};
