"use strict";

const { usesRuNotePipeline } = require("./ru_note_startup");

const STAGES = ["title", "tags", "links"];
const SKIP_KEYS = {
  title: "skipNoteTitleSelection", tags: "skipNoteTagsSelection", links: "skipNoteLinksSelection",
};
const validPairId = value => typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value);
const fullSelection = selection => selection && typeof selection === "object" && !Array.isArray(selection)
  && Object.keys(selection).length === STAGES.length
  && STAGES.every(stage => Object.hasOwn(selection, stage) && validPairId(selection[stage]));
const validNewTags = value => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === 2 && typeof value.enabled === "boolean" && validPairId(value.pairId);
const validStageEnabled = value => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === STAGES.length
  && STAGES.every(stage => Object.hasOwn(value, stage) && typeof value[stage] === "boolean");

function isAvailablePair(stage, pairId) {
  const preset = stage.options.find(option => option.id === pairId);
  if (preset) return preset.available !== false;
  return stage.components?.generator?.some(generator =>
    generator.available !== false && pairId.startsWith(generator.id + "_")
    && stage.components.reranker?.some(reranker => reranker.available !== false
      && pairId === `${generator.id}_${reranker.id}`));
}

function startupStageIds(runtime, settings = {}) {
  if (!usesRuNotePipeline(runtime)) return [];
  const pipeline = runtime.note_pipeline;
  const catalog = pipeline.catalog;
  const enabled = validStageEnabled(pipeline.stageEnabled) ? pipeline.stageEnabled : {};
  const active = STAGES.filter(stage => enabled[stage] !== false);
  if (!Array.isArray(catalog) || catalog.length !== STAGES.length
      || !STAGES.every(stage => catalog.filter(entry => entry?.id === stage).length === 1)
      || !catalog.every(entry => Array.isArray(entry.options) && entry.options.length > 0
        && entry.options.every(option => validPairId(option?.id))
        && new Set(entry.options.map(option => option.id)).size === entry.options.length)) {
    throw new Error("Каталог связок недоступен. Повторите запуск приложения.");
  }
  if (pipeline.configured !== true || pipeline.configurationError
      || !fullSelection(pipeline.selection)
      || !catalog.every(entry => !active.includes(entry.id) || isAvailablePair(entry, pipeline.selection[entry.id]))) {
    return active;
  }
  return active.filter(stage => {
    const value = settings?.[SKIP_KEYS[stage]];
    return value !== undefined && value !== true;
  });
}

async function saveNotePairs(selection, { backendUrl, fetchWithTimeout, readJsonResponse, invalid, failed }) {
  const { newTags, stageEnabled, ...required } = selection || {};
  if (!fullSelection(required) || (Object.hasOwn(selection, "newTags") && !validNewTags(newTags))
      || (Object.hasOwn(selection, "stageEnabled") && !validStageEnabled(stageEnabled))) {
    throw new Error(invalid());
  }
  const response = await fetchWithTimeout(`${backendUrl}/runtime/note-pipeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(selection),
  });
  const result = await readJsonResponse(response);
  let savedStages;
  try {
    savedStages = startupStageIds(result?.runtime);
  } catch {
    throw new Error(failed());
  }
  if (!response.ok || result?.ok !== true || !usesRuNotePipeline(result.runtime)
      || result.runtime.note_pipeline.configured !== true
      || savedStages.length !== 0
      || !STAGES.every(stage => result.runtime.note_pipeline.selection?.[stage] === required[stage])
      || (stageEnabled && (!validStageEnabled(result.runtime.note_pipeline.stageEnabled)
        || STAGES.some(stage => result.runtime.note_pipeline.stageEnabled[stage] !== stageEnabled[stage])))
      || (newTags && (result.runtime.note_pipeline.newTags?.enabled !== newTags.enabled
        || result.runtime.note_pipeline.newTags?.pairId !== newTags.pairId))) {
    throw new Error(failed());
  }
  return { ok: true, runtime: result.runtime };
}

function createStartupNoteSelection({ show, save, prepare }) {
  let pending = null;
  let checking = null;

  function prompt(runtime, stageIds, downloadError) {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pending = {
      promise, resolve, saving: false, stageIds,
      selection: runtime.note_pipeline.selection && { ...runtime.note_pipeline.selection },
      enabled: validStageEnabled(runtime.note_pipeline.stageEnabled)
        ? { ...runtime.note_pipeline.stageEnabled } : Object.fromEntries(STAGES.map(stage => [stage, true])),
    };
    show({ ...runtime.note_pipeline, startupStageIds: stageIds, ...(downloadError && { downloadError }) });
    return promise;
  }

  function wait(runtime, settings) {
    if (pending) return pending.promise;
    if (checking) return checking;
    const stageIds = startupStageIds(runtime, settings);
    if (stageIds.length) return prompt(runtime, stageIds);
    if (!prepare || !usesRuNotePipeline(runtime)) return Promise.resolve(runtime);
    const pipeline = runtime.note_pipeline;
    const active = STAGES.filter(stage => pipeline.stageEnabled?.[stage] !== false);
    if (!active.length) return Promise.resolve(runtime);
    checking = Promise.resolve().then(() => prepare(pipeline.selection)).then(() => runtime, error =>
      prompt(runtime, active, error.code || "configuration")
    ).finally(() => { checking = null; });
    return checking;
  }

  async function apply(selection, options) {
    if (!pending || pending.saving) return { ok: false };
    const request = pending;
    const { stageEnabled, ...pairs } = selection || {};
    if (!fullSelection(pairs)
        || STAGES.some(stage => !request.stageIds.includes(stage) && pairs[stage] !== request.selection?.[stage])
        || (Object.hasOwn(selection, "stageEnabled") && (!validStageEnabled(stageEnabled)
          || STAGES.some(stage => stageEnabled[stage] !== request.enabled[stage]
            && (!request.stageIds.includes(stage) || stageEnabled[stage]))))) {
      throw new Error("Некорректный выбор связок для этапов запуска.");
    }
    request.saving = true;
    try {
      if (prepare) await prepare(selection, options);
      const result = await save(selection);
      pending = null;
      request.resolve(result.runtime);
      return result;
    } finally {
      request.saving = false;
    }
  }

  return { wait, apply };
}

module.exports = { createStartupNoteSelection, saveNotePairs, startupStageIds };
