"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createStartupNoteSelection, saveNotePairs, startupStageIds } = require("../frontend/note_pair_selection");
const { NoteModelDownloadError, prepareNoteModels, importNoteModel } = require("../frontend/note_model_download");
const { PROFILE_ID, usesRuNotePipeline } = require("../frontend/ru_note_startup");

const selection = { title: "qwen25_3b_mmarco", tags: "qwen35_4b_tev", links: "qwen35_4b_mmarco" };
const note_pipeline = { enabled: true, profile: PROFILE_ID, selection, configured: true,
  catalog: Object.entries(selection).map(([id, pairId]) => ({ id, options: [{ id: pairId }] })) };
const runtime = { provider: "vllm_local", note_pipeline };
const askAll = { skipNoteTitleSelection: false, skipNoteTagsSelection: false, skipNoteLinksSelection: false };
const main = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");

test("stage choices are saved through one bounded request and verified against the reply", async () => {
  const calls = [];
  let result = { ok: true, runtime };
  const options = {
    backendUrl: "http://127.0.0.1:5000",
    fetchWithTimeout: async (...args) => { calls.push(args); return { ok: true }; },
    readJsonResponse: async () => result,
    invalid: () => "invalid selection",
    failed: () => "save failed",
  };
  for (const invalid of [[], null, {}, { ...selection, path: "arbitrary" },
    { ...selection, title: "../bad" }, { ...selection, links: "a".repeat(65) }]) {
    await assert.rejects(saveNotePairs(invalid, options), /invalid selection/);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await saveNotePairs(selection, options), { ok: true, runtime });
  assert.deepEqual(calls, [["http://127.0.0.1:5000/runtime/note-pipeline", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection),
  }]]);
  result = { ok: true, runtime: { note_pipeline: { ...note_pipeline, configured: false } } };
  await assert.rejects(saveNotePairs(selection, options), /save failed/);
  result = { ok: true, runtime: { note_pipeline: { ...note_pipeline, selection: { ...selection, tags: "other" } } } };
  await assert.rejects(saveNotePairs(selection, options), /save failed/);
  const newTags = { enabled: true, pairId: "qwen3_4b_instruct_qwen" };
  const experimental = { ...selection, newTags };
  result = { ok: true, runtime: { ...runtime, note_pipeline: { ...note_pipeline, newTags } } };
  assert.deepEqual(await saveNotePairs(experimental, options), result);
  assert.deepEqual(JSON.parse(calls.at(-1)[1].body), experimental);
  result = { ok: true, runtime: { ...runtime, note_pipeline: { ...note_pipeline, newTags: { ...newTags, enabled: false } } } };
  await assert.rejects(saveNotePairs(experimental, options), /save failed/);
});

test("startup pair picker retries failures and releases startup only after a successful save", async () => {
  const shown = [];
  let finish;
  const controller = createStartupNoteSelection({
    show: pipeline => shown.push(pipeline),
    save: () => new Promise((resolve, reject) => { finish = { resolve, reject }; }),
  });
  assert.deepEqual(await controller.apply(selection), { ok: false });
  assert.equal(await controller.wait(null), null);
  const oldRuntime = { note_pipeline: { enabled: true, profile: PROFILE_ID } };
  assert.throws(() => controller.wait(oldRuntime), /Каталог связок/);
  const invalidCatalog = { note_pipeline: { ...note_pipeline, catalog: "invalid" } };
  assert.throws(() => controller.wait(invalidCatalog), /Каталог связок/);
  const wait = controller.wait(runtime, askAll);
  assert.equal(controller.wait(runtime), wait);
  assert.deepEqual(shown, [{ ...note_pipeline, startupStageIds: ["title", "tags", "links"] }]);
  const rejected = controller.apply(selection);
  assert.deepEqual(await controller.apply(selection), { ok: false });
  finish.reject(new Error("unavailable"));
  await assert.rejects(rejected, /unavailable/);
  assert.equal(controller.wait(runtime), wait);
  const retry = controller.apply(selection);
  const confirmed = { ...runtime, note_pipeline: { ...note_pipeline, configured: true } };
  finish.resolve({ ok: true, runtime: confirmed });
  assert.deepEqual(await retry, { ok: true, runtime: confirmed });
  assert.equal(await wait, confirmed);
});

test("startup can switch off a shown stage but cannot alter hidden switches", async () => {
  const calls = [];
  const initial = { ...runtime, note_pipeline: {
    ...note_pipeline, stageEnabled: { title: false, tags: true, links: true },
  } };
  const controller = createStartupNoteSelection({ show: () => {}, save: async value => {
    calls.push(value);
    return { ok: true, runtime: { ...initial, note_pipeline: { ...initial.note_pipeline, stageEnabled: value.stageEnabled } } };
  } });
  const waiting = controller.wait(initial, { skipNoteTagsSelection: false });
  for (const flags of [{ tags: false }, { title: true, tags: false, links: true },
    { title: false, tags: false, links: false }]) {
    await assert.rejects(controller.apply({ ...selection, stageEnabled: flags }), /Некорректный выбор/);
  }
  assert.deepEqual(calls, []);
  const change = { ...selection, stageEnabled: { title: false, tags: false, links: true } };
  const confirmed = await controller.apply(change);
  assert.deepEqual(calls, [change]);
  assert.equal(await waiting, confirmed.runtime);
  assert.equal(await controller.wait(confirmed.runtime), confirmed.runtime);
});

test("startup accepts a saved disabled stage with missing files and rejects a mismatched acknowledgement", async () => {
  const stageEnabled = { title: false, tags: false, links: false };
  const selectionToSave = { ...selection, stageEnabled };
  const catalog = note_pipeline.catalog.map(entry => ({
    ...entry, options: entry.options.map(option => ({ ...option, available: false })),
  }));
  let confirmed = { ...runtime, note_pipeline: { ...note_pipeline, stageEnabled, catalog } };
  const options = { backendUrl: "http://127.0.0.1:5000",
    fetchWithTimeout: async (_url, request) => {
      assert.deepEqual(JSON.parse(request.body), selectionToSave);
      return { ok: true };
    },
    readJsonResponse: async () => ({ ok: true, runtime: confirmed }),
    invalid: () => "invalid", failed: () => "unconfirmed",
  };
  assert.equal((await saveNotePairs(selectionToSave, options)).runtime, confirmed);
  confirmed = { ...confirmed, note_pipeline: { ...note_pipeline, stageEnabled: { ...stageEnabled, tags: true } } };
  await assert.rejects(saveNotePairs(selectionToSave, options), /unconfirmed/);
});

test("checks saved files at startup and lets the user recover when preparation fails", async () => {
  const shown = [], calls = [];
  const controller = createStartupNoteSelection({
    show: pipeline => shown.push(pipeline),
    prepare: async value => {
      calls.push(["prepare", value]);
      if (!value.stageEnabled) throw new NoteModelDownloadError("network");
    },
    save: async value => {
      calls.push(["save", value]);
      return { ok: true, runtime };
    },
  });
  const waiting = controller.wait(runtime);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(shown[0].startupStageIds, ["title", "tags", "links"]);
  assert.equal(shown[0].downloadError, "network");
  assert.deepEqual(calls, [["prepare", selection]]);
  const skipped = { ...selection, stageEnabled: { title: false, tags: false, links: false } };
  await controller.apply(skipped);
  assert.equal(await waiting, runtime);
  assert.deepEqual(calls, [["prepare", selection], ["prepare", skipped], ["save", skipped]]);
});

test("downloads stream real byte counts and clear the popup on completion or failure", async () => {
  const progress = [];
  const event = { state: "downloading", model: "Qwen", bytes: 15, total: 20 };
  for (const final of [{ state: "done" }, { state: "error", code: "space" }]) {
    const chunks = [JSON.stringify(event).slice(0, 11), JSON.stringify(event).slice(11) + "\n" + JSON.stringify(final) + "\n"];
    const result = prepareNoteModels(selection, {
      backendUrl: "http://127.0.0.1:5000",
      fetchWithTimeout: async (url, request) => {
        assert.match(url, /\/runtime\/note-pipeline\/prepare$/);
        assert.deepEqual(JSON.parse(request.body), selection);
        return new Response(new ReadableStream({ start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        } }), { headers: { "Content-Type": "application/x-ndjson" } });
      },
      onProgress: state => progress.push(state),
    });
    if (final.state === "done") await result;
    else await assert.rejects(result, { code: "space" });
    assert.deepEqual(progress.splice(0), [{ model: "Qwen", bytes: 15, total: 20 }, null]);
  }
});

test("import stream forwards checked stages and only accepts a model of the requested role", async () => {
  const payload = { role: "generator", url: "https://huggingface.co/Qwen/Model", ignored: true };
  const id = "hfg_bccb835f11282b53";
  const model = { id, label: "Qwen/Model" };
  const states = [{ state: "checking" }, { state: "downloading", model: "Qwen/Model", bytes: 15, total: 20 },
    { state: "testing" }];
  const progress = [];
  let final = { state: "done", model };
  const options = {
    backendUrl: "http://127.0.0.1:5000",
    fetchWithTimeout: async (url, request) => {
      assert.match(url, /\/runtime\/note-pipeline\/import$/);
      assert.deepEqual(JSON.parse(request.body), { role: payload.role, url: payload.url });
      return new Response([...states, final].map(event => JSON.stringify(event) + "\n").join(""),
        { headers: { "Content-Type": "application/x-ndjson" } });
    },
    onProgress: state => progress.push(state),
  };
  assert.deepEqual(await importNoteModel(payload, options), { ...model, imported: true, experimental: true, downloaded: true });
  assert.deepEqual(progress, [...states, null]);
  final = { state: "done", model: { ...model, id: "hfr_bccb835f11282b53" } };
  await assert.rejects(importNoteModel(payload, options), { code: "configuration" });
  await assert.rejects(importNoteModel({ ...payload, role: "embedding" }, options), { code: "import_url" });
});

test("saved imported combinations skip setup when their components remain in the catalog", () => {
  const generator = "hfg_bccb835f11282b53";
  const active = { ...note_pipeline, selection: { ...selection, title: generator + "_mmarco" },
    catalog: note_pipeline.catalog.map(entry => entry.id === "title" ? {
      ...entry, components: { generator: [{ id: generator }], reranker: [{ id: "mmarco" }] },
    } : entry) };
  assert.deepEqual(startupStageIds({ ...runtime, note_pipeline: active }), []);
  active.catalog[0].components.generator = [];
  assert.deepEqual(startupStageIds({ ...runtime, note_pipeline: active }), ["title", "tags", "links"]);
});

test("invalid save acknowledgements preserve pending startup without an automatic second POST", async () => {
  const invalidPipelines = [
    { catalog: undefined }, { catalog: [] }, { catalog: "invalid" },
    { catalog: note_pipeline.catalog.slice(1) },
    { configurationError: "note_pipeline_selection_unreadable" },
    { selection: { ...selection, extra: "unexpected" } },
    ...["title", "tags", "links"].map(stage => ({ catalog: note_pipeline.catalog.map(entry => ({
      ...entry, options: entry.options.map(option => ({ ...option, available: entry.id !== stage })),
    })) })),
  ];
  for (const invalidPipeline of invalidPipelines) {
    let result = { ok: true, runtime: { ...runtime, note_pipeline: { ...note_pipeline, ...invalidPipeline } } };
    let posts = 0, released = false;
    const controller = createStartupNoteSelection({ show: () => {}, save: value => saveNotePairs(value, {
      backendUrl: "http://127.0.0.1:5000",
      fetchWithTimeout: async () => { posts++; return { ok: true }; },
      readJsonResponse: async () => result,
      invalid: () => "invalid selection", failed: () => "save failed",
    }) });
    const initial = { ...runtime, note_pipeline: { ...note_pipeline, configured: false } };
    const waiting = controller.wait(initial);
    waiting.then(() => { released = true; });
    await assert.rejects(controller.apply(selection), /save failed/);
    assert.equal(posts, 1);
    assert.equal(released, false);
    assert.equal(controller.wait(initial), waiting);
    result = { ok: true, runtime };
    assert.deepEqual(await controller.apply(selection), result);
    assert.equal(await waiting, runtime);
    assert.equal(posts, 2);
  }
});

test("actual startup hook forwards independent stage settings without a legacy model bypass", async () => {
  const begin = main.indexOf("async function waitForStartupModelSelection(");
  const end = main.indexOf("async function applyStartupTurboQuantSelection(", begin);
  const prompted = [];
  const context = vm.createContext({
    usesRuNotePipeline, desktopSettings: { skipModelSelection: false }, AUTO_QUIT_AFTER_READY_MS: 0,
    startupNoteSelection: { wait: async (value, settings) => { prompted.push([value, { ...settings }]); return value; } },
  });
  vm.runInContext(main.slice(begin, end), context);
  assert.equal(await context.waitForStartupModelSelection(runtime), runtime);
  context.desktopSettings.skipModelSelection = true;
  assert.equal(await context.waitForStartupModelSelection(runtime), runtime);
  context.desktopSettings.skipModelSelection = false;
  context.AUTO_QUIT_AFTER_READY_MS = 100;
  assert.equal(await context.waitForStartupModelSelection(runtime), runtime);
  assert.deepEqual(prompted, [[runtime, { skipModelSelection: false }], [runtime, { skipModelSelection: true }]]);
});

test("actual pair IPC streams progress and saves only after preparation succeeds", async () => {
  const handlers = {};
  let fail = true;
  let downloadFails = true;
  const calls = [];
  const progress = [];
  const notes = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, send: (channel, value) => progress.push([channel, { ...value }]),
  });
  const startupSender = new EventEmitter();
  const deny = () => ({ ok: false });
  const trustedLegacyBridge = {
    mode: "legacy",
    async runMutationWithContext(payload, operation) {
      assert.equal(payload.projectId, undefined);
      assert.equal(payload.contextToken, undefined);
      if (context.settingsRuntimeUpdateInProgress) throw new Error("settings busy");
      context.settingsRuntimeUpdateInProgress = true;
      try { return await operation(); }
      finally { context.settingsRuntimeUpdateInProgress = false; }
    },
  };
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    AbortController, activeModelDownloads: new Map(),
    NoteModelDownloadError,
    isStartupWindowSender: event => event.sender === startupSender,
    isNotesWindowSender: event => event.sender === notes,
    denyInvalidStartupSender: deny, denyInvalidNotesSender: deny,
    startupNoteSelection: { apply: async value => { calls.push(value); return { ok: true, runtime }; } },
    assertProfileMutable: value => assert.equal(value, null), OWNED_NOTE_PROFILE: null,
    projects: () => trustedLegacyBridge,
    settingsRuntimeUpdateInProgress: false,
    ensureBackendHttpReady: async () => { if (fail) throw new Error("unavailable"); },
    BACKEND_URL: "http://127.0.0.1:5000",
    fetchWithTimeout: async () => assert.fail("unexpected fetch"),
    prepareNoteModels: async (value, { onProgress }) => {
      assert.equal(context.settingsRuntimeUpdateInProgress, true);
      assert.deepEqual({ ...value }, selection);
      onProgress({ model: "model", bytes: 1, total: 2 });
      if (downloadFails) throw new NoteModelDownloadError("network");
    },
    postNotePairSelection: async value => { calls.push({ ...value }); return { ok: true, runtime }; },
  });
  const downloadBegin = main.indexOf("async function runModelDownload(");
  const downloadEnd = main.indexOf("const startupNoteSelection", downloadBegin);
  vm.runInContext(main.slice(downloadBegin, downloadEnd), context);
  for (const kind of ["startup", "settings"]) {
    const begin = main.indexOf(`ipcMain.handle("quick-note:apply-${kind}-note-pairs"`);
    const end = main.indexOf("\n});", begin);
    vm.runInContext(main.slice(begin, end + 4), context);
  }
  const startup = handlers["quick-note:apply-startup-note-pairs"];
  const settings = handlers["quick-note:apply-settings-note-pairs"];
  assert.deepEqual(await startup({ sender: "notes" }, selection), { ok: false });
  assert.deepEqual(await settings({ sender: startupSender }, selection), { ok: false });
  assert.deepEqual(calls, []);
  assert.deepEqual(await startup({ sender: startupSender }, selection), { ok: true, runtime });
  await assert.rejects(settings({ sender: notes }, selection), /unavailable/);
  assert.equal(context.settingsRuntimeUpdateInProgress, false);
  fail = false;
  assert.equal((await settings({ sender: notes }, selection)).downloadError, "network");
  assert.deepEqual(calls, [selection]);
  assert.equal(context.settingsRuntimeUpdateInProgress, false);
  assert.deepEqual(progress, [["quick-note:settings-note-download-progress", { model: "model", bytes: 1, total: 2, cancellable: true }]]);
  downloadFails = false;
  assert.deepEqual(await settings({ sender: notes }, selection), { ok: true, runtime });
  assert.deepEqual(calls, [selection, selection]);
});
