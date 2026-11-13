"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const policy = require("../frontend/ru_note_startup");

const main = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const chat = fs.readFileSync(path.join(__dirname, "../frontend/notes_chat_renderer.js"), "utf8");
const ru = { provider: "vllm_local", note_pipeline: { enabled: true, profile: policy.PROFILE_ID } };

function section(source, begin, end) {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start);
  return source.slice(start, finish);
}

test("only the explicit enabled Russian profile bypasses legacy startup", () => {
  assert.equal(policy.usesRuNotePipeline(ru), true);
  for (const candidate of [undefined, {}, { note_pipeline: {} },
    { note_pipeline: { enabled: "true", profile: policy.PROFILE_ID } },
    { note_pipeline: { enabled: 1, profile: policy.PROFILE_ID } },
    { note_pipeline: { enabled: false, profile: policy.PROFILE_ID } },
    { note_pipeline: { enabled: true, profile: "other" } }]) {
    assert.equal(policy.usesRuNotePipeline(candidate), false);
  }
  assert.equal(policy.shouldStartManagedAtStartup(ru), false);
  assert.equal(policy.shouldStartManagedAtStartup({ provider: "vllm_local" }), true);
  assert.equal(policy.shouldStartManagedAtStartup({ provider: "local" }), false);
});

test("ready text describes all three stages and lazy loading", () => {
  const status = policy.startupReadyStatus(ru);
  assert.match(status.detail, /для заголовков, тегов и связей/);
  assert.match(status.detail, /загружаются по этапам/);
  assert.deepEqual(policy.startupReadyStatus({}), {
    message: "Все сервисы готовы",
    detail: "Backend, Qdrant, заметки и модель готовы к работе.",
  });
});

test("ready text names both languages only when backend advertises English", () => {
  const bilingual = { ...ru, note_pipeline: { ...ru.note_pipeline, supported_languages: ["ru", "en"] } };
  assert.equal(policy.startupReadyStatus(bilingual).message, "Конвейер RU/EN настроен");
  assert.equal(policy.startupReadyStatus(ru).message, "Русский конвейер настроен");
  const malformed = { ...ru, note_pipeline: { ...ru.note_pipeline, supported_languages: "ru,en" } };
  assert.equal(policy.startupReadyStatus(malformed).message, "Русский конвейер настроен");
});

test("actual model-prompt hook preserves preferences and skips only Russian profile", () => {
  const context = vm.createContext({
    usesRuNotePipeline: policy.usesRuNotePipeline,
    desktopSettings: { skipModelSelection: false }, AUTO_QUIT_AFTER_READY_MS: 0,
  });
  vm.runInContext(section(main, "function shouldPromptForStartupModel(", "function findStartupCatalogModel("), context);
  assert.equal(context.shouldPromptForStartupModel(ru), false);
  assert.equal(context.shouldPromptForStartupModel({ provider: "local" }), true);
  assert.equal(context.shouldPromptForStartupModel({ provider: "vllm_local" }), true);
  context.desktopSettings.skipModelSelection = true;
  assert.equal(context.shouldPromptForStartupModel({ provider: "local" }), false);
});

test("actual TurboQuant hook returns the Russian profile without model or hardware work", async () => {
  const context = vm.createContext({ usesRuNotePipeline: policy.usesRuNotePipeline });
  vm.runInContext(section(main, "async function waitForStartupTurboQuantSelection(", "async function chooseNotesDirectory("), context);
  assert.equal(await context.waitForStartupTurboQuantSelection(ru), ru);
});

test("the settings snapshot does not promote a catalog entry over the runtime model", async () => {
  const tlite = { id: "tlite", name: "T-lite", active: true, local_path: "C:/models/T-lite.gguf" };
  const awq = { id: "awq", hf_model_id: "Qwen/Qwen2.5-7B-Instruct-AWQ" };
  const runtime = { provider: "local", runtime_model_id: "C:/models/qwen2.5-7b-instruct-q5_k_m-00001-of-00002.gguf" };
  const context = vm.createContext({
    desktopSettings: {}, ensureBackendHttpReady: async () => {},
    fetchRuntimeConfig: async () => runtime,
    fetchModelCatalog: async () => ({ models: [tlite, awq] }),
    getHardwareProfile: async () => ({}),
    evaluateTurboQuantCapability: ({ model }) => ({ supported: Boolean(model) }),
  });
  vm.runInContext(section(main, "function findStartupCatalogModel(", "function isGgufCatalogModel("), context);
  vm.runInContext(section(main, "function resolveActiveCatalogModel(", "async function applySettingsModelSelection("), context);
  const settings = await context.getDesktopSettingsPayload();
  assert.equal(settings.activeModelId, "");
  assert.equal(settings.runtime.runtime_model_id, runtime.runtime_model_id);
  assert.equal(settings.turboquantCapability.supported, false);
  assert.equal(context.resolveActiveCatalogModel([tlite], { ...runtime, runtime_model_id: tlite.local_path }), tlite);
  assert.equal(context.resolveActiveCatalogModel([tlite, awq], { provider: "vllm_local", runtime_model_id: "local-model",
    vllm: { source_model_id: awq.hf_model_id } }), awq);
  assert.equal(context.resolveActiveCatalogModel([{ ...tlite, active: false }], {}), null);
});

for (const [name, runtime, managed] of [["Russian", ru, false], ["legacy vLLM", { provider: "vllm_local" }, true]]) {
  test(`actual ${name} startup keeps full readiness before hotkey and only required runtime`, async () => {
    const calls = [], statuses = [];
    let continueStartup;
    const languageSelected = new Promise(resolve => { continueStartup = resolve; });
    let enteredLanguageChoice;
    const choosingLanguage = new Promise(resolve => { enteredLanguageChoice = resolve; });
    const context = vm.createContext({
      usesRuNotePipeline: policy.usesRuNotePipeline,
      shouldStartManagedAtStartup: policy.shouldStartManagedAtStartup,
      startupReadyStatus: policy.startupReadyStatus,
      process: { platform: "win32" },
      Menu: { getApplicationMenu: () => null },
      PORTABLE_RUNTIME: false, isQuitting: false,
      coldStartupPending: true, startupStatus: { progress: 0 },
      broadcastStartupStatus: payload => statuses.push(payload),
      showStartupWindow: () => calls.push("window"),
      waitForStartupSurfaceReady: async () => calls.push("surface"),
      startupLanguage: {
        wait: () => {
          calls.push("language");
          enteredLanguageChoice();
          return languageSelected;
        },
        getLanguage: () => "ru",
      },
      uiText: (ru) => ru,
      createQuickWindow: () => calls.push("quick"),
      createTray: () => calls.push("tray"),
      stopLegacyDockerContainers: async () => calls.push("legacy-cleanup"),
      waitForStartupNotesDirectory: async () => calls.push("vault"),
      ensureBackendHttpReady: async () => calls.push("backend"),
      fetchRuntimeConfig: async () => runtime,
      waitForStartupModelSelection: async payload => payload,
      waitForStartupTurboQuantSelection: async payload => payload,
      ensureManagedRuntimeReady: async payload => { assert.equal(payload, runtime); calls.push("managed"); },
      registerHotkey: () => { assert.equal(statuses.at(-1).state, "ready"); calls.push("hotkey"); },
    });
    vm.runInContext(section(main, "async function runBackendReadySequence(", "async function ensureBackendReady("), context);
    const startup = context.runBackendReadySequence();
    await choosingLanguage;
    assert.deepEqual(calls, ["window", "surface", "language"]);
    continueStartup("ru");
    const result = await startup;
    assert.equal(result.ok, true);
    assert.ok(calls.indexOf("language") < calls.indexOf("vault"));
    assert.ok(calls.indexOf("vault") < calls.indexOf("backend"));
    assert.equal(calls.includes("managed"), managed);
    assert.ok(calls.indexOf("window") < calls.indexOf("surface"));
    assert.equal(calls.at(-1), "hotkey");
    assert.equal(context.coldStartupPending, false);
  });
}

test("chat guard rejects unauthorized callers before backend or process access", async () => {
  const denial = { ok: false, error: "forbidden" };
  assert.equal(await policy.ensureChatRuntimeReady({ allowed: false, deny: () => denial }), denial);
  assert.equal(await policy.ensureChatRuntimeReady({ allowed: "true", deny: () => denial }), denial);
});

for (const provider of ["local", "vllm_local", "llama_cpp_server"]) {
  test(`explicit ${provider} chat warms only its configured managed runtime`, async () => {
    const calls = [];
    const runtime = { ...ru, provider };
    const result = await policy.ensureChatRuntimeReady({
      allowed: true, deny: () => { throw new Error("Unexpected denial"); },
      ensureBackendReady: async () => calls.push("backend"),
      fetchRuntimeConfig: async () => { calls.push("config"); return runtime; },
      ensureManagedRuntimeReady: async payload => { assert.equal(payload, runtime); calls.push("managed"); },
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, provider === "vllm_local" ? ["backend", "config", "managed"] : ["backend", "config"]);
  });
}

test("actual chat IPC checks notes-window sender before any readiness work", async () => {
  let handler;
  let provider = "local";
  const calls = [];
  const context = vm.createContext({
    ipcMain: { handle: (name, callback) => { assert.equal(name, "quick-note:ensure-chat-runtime"); handler = callback; } },
    ensureChatRuntimeReady: policy.ensureChatRuntimeReady,
    projects: () => ({ runWithContext: (_context, action) => action() }),
    isNotesWindowSender: event => event.sender === "notes",
    denyInvalidNotesSender: action => { calls.push(action); return { ok: false, error: "forbidden" }; },
    ensureBackendReady: async () => calls.push("backend"),
    fetchRuntimeConfig: async options => { assert.equal(options.announceStartup, false); calls.push("config"); return { provider }; },
    ensureManagedRuntimeReady: async () => { assert.equal(context.startupBroadcastSuppressionDepth, 1); calls.push("managed"); },
    startupBroadcastSuppressionDepth: 0,
  });
  vm.runInContext(section(main, 'ipcMain.handle("quick-note:ensure-chat-runtime"', 'ipcMain.handle("quick-note:ensure-generation-runtime"'), context);
  assert.deepEqual(await handler({ sender: "untrusted" }), { ok: false, error: "forbidden" });
  assert.deepEqual(calls, ["ensure-chat-runtime"]);
  calls.length = 0;
  assert.deepEqual(await handler({ sender: "notes" }, { command: "ignored" }), { ok: true });
  assert.deepEqual(calls, ["backend", "config"]);
  calls.length = 0;
  provider = "vllm_local";
  assert.deepEqual(await handler({ sender: "notes" }), { ok: true });
  assert.deepEqual(calls, ["backend", "config", "managed"]);
  assert.equal(context.startupBroadcastSuppressionDepth, 0);
});

for (const fails of [false, true]) {
  test(`chat managed warmup restores nested startup-progress suppression on ${fails ? "failure" : "success"}`, async () => {
    let depth = 2;
    const operation = policy.ensureChatRuntimeReady({
      allowed: true, deny: () => { throw new Error("Unexpected denial"); },
      ensureBackendReady: async () => {},
      fetchRuntimeConfig: async () => ru,
      startupProgress: { get: () => depth, set: value => { depth = value; } },
      ensureManagedRuntimeReady: async () => {
        assert.equal(depth, 3);
        if (fails) throw new Error("Synthetic load failure");
      },
    });
    if (fails) await assert.rejects(operation, /Synthetic load failure/);
    else assert.deepEqual(await operation, { ok: true });
    assert.equal(depth, 2);
  });
}

function ragFixture(bridge) {
  const calls = [];
  const context = vm.createContext({
    window: { quickNoteBridge: bridge },
    t: ru => ru,
    boundProject: { projectId: null, contextToken: null }, activeRequest: null,
    scopeCurrent: () => true, projectContext: null,
    API_BASE: "http://127.0.0.1:5000", CHAT_READY_TIMEOUT_MS: 500, RAG_REQUEST_TIMEOUT_MS: 500, CHAT_CONTEXT_LIMIT: 10,
    AbortController, setTimeout: () => { calls.push("timer"); return 1; }, clearTimeout: () => calls.push("clear"),
    fetch: async (url, options) => {
      calls.push("fetch");
      return { ok: true, json: async () => ({ response: "Synthetic answer", url, body: JSON.parse(options.body) }) };
    },
  });
  vm.runInContext(section(chat, "async function ragRequest(", "function setSending("), context);
  return { context, calls };
}

test("actual chat bounds readiness and waits for runtime before HTTP, preserving query/history", async () => {
  let release;
  const fixture = ragFixture({ ensureChatRuntimeReady: () => new Promise(resolve => { release = resolve; }) });
  const result = fixture.context.ragRequest("Точный вопрос", [{ role: "user", text: "Контекст" }]);
  assert.deepEqual(fixture.calls, ["timer"]);
  release({ ok: true });
  const payload = await result;
  assert.deepEqual(fixture.calls, ["timer", "clear", "timer", "fetch", "clear"]);
  assert.equal(payload.body.query, "Точный вопрос");
  assert.equal(payload.body.history[0].text, "Контекст");
});

test("failed chat preparation never sends a RAG request", async () => {
  const rejected = ragFixture({ ensureChatRuntimeReady: async () => ({ ok: false }) });
  await assert.rejects(rejected.context.ragRequest("Вопрос", []), { code: "chat_model_unavailable" });
  assert.deepEqual(rejected.calls, ["timer", "clear"]);
  const thrown = ragFixture({ ensureChatRuntimeReady: async () => { throw new Error("Synthetic load error"); } });
  await assert.rejects(thrown.context.ragRequest("Вопрос", []), { code: "chat_model_unavailable" });
  assert.deepEqual(thrown.calls, ["timer", "clear"]);
});

test("browser legacy mode retains its direct RAG request", async () => {
  const fixture = ragFixture(undefined);
  const payload = await fixture.context.ragRequest("Вопрос", null);
  assert.equal(payload.body.history.length, 0);
  assert.deepEqual(fixture.calls, ["timer", "fetch", "clear"]);
});

test("a client timeout during preparation is reported separately from a model load failure", async () => {
  const fixture = ragFixture({ ensureChatRuntimeReady: () => new Promise(() => {}) });
  let expire;
  fixture.context.setTimeout = callback => { expire = callback; return 1; };
  const pending = fixture.context.ragRequest("Вопрос", []);
  expire();
  await assert.rejects(pending, { code: "chat_timeout" });
  assert.equal(fixture.context.activeRequest, null);
  assert.deepEqual(fixture.calls, ["clear"]);
});

test("actual preload forwards the captured project context through the narrow chat-readiness command", async () => {
  const calls = [];
  let bridge;
  const context = vm.createContext({
    require: name => {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "quickNoteBridge"); bridge = value; } },
        ipcRenderer: { on: () => {}, invoke: async (...args) => { calls.push(args); return { ok: true }; } },
      };
    },
    process: { argv: [] }, document: { documentElement: { dataset: {}, style: {} } }, window: {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../frontend/preload.js"), "utf8"), context);
  const captured = { projectId: "a".repeat(32), contextToken: "b".repeat(32) };
  assert.deepEqual(await bridge.ensureChatRuntimeReady(captured), { ok: true });
  assert.deepEqual(calls, [["quick-note:ensure-chat-runtime", captured]]);
});
