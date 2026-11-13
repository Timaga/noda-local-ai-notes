"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { once } = require("node:events");
const { createDesktopProjectBridge } = require("../frontend/desktop_project_bridge");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "frontend/main.js"), "utf8");
function section(begin, end) {
  const start = main.indexOf(begin), finish = main.indexOf(end, start);
  assert.ok(start >= 0 && finish > start);
  return main.slice(start, finish);
}

async function fixture(run) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noda-activation-integration-")));
  const a = path.join(directory, "A"), profile = path.join(directory, "profile");
  fs.mkdirSync(a); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(a, "Source.md"), "Synthetic immutable A source");
  const python = process.env.NODA_TEST_PYTHON
    || path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const child = spawn(python, ["-I", "-B", "-X", "utf8", path.join(__dirname, "fixtures/project_switch_rpc.py")], {
    cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
      TMP: process.env.TMP, PYTHONIOENCODING: "utf-8", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
  });
  const pending = []; let stderr = "";
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const next = pending.shift();
    if (!next) return;
    try { const value = JSON.parse(line); if (value.fixture_error) throw new Error(JSON.stringify(value)); next.resolve(value); }
    catch (error) { next.reject(error); }
  });
  child.on("error", error => { while (pending.length) pending.shift().reject(error); });
  child.on("exit", code => { while (pending.length) pending.shift().reject(new Error(`Fixture exit ${code}: ${stderr}`)); });
  function rpc(value) {
    return new Promise((resolve, reject) => { pending.push({ resolve, reject }); child.stdin.write(JSON.stringify(value) + "\n"); });
  }
  const h = { a, directory, profile, rpc, events: [], http: [], boots: [], failNextBoot: false, failRuntime: false };
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false,
    send: (_channel, state) => h.events.push(state) } };
  const handlers = new Map();
  const context = {
    app: { getPath: () => profile }, process: { env: { QDRANT_COLLECTION_NAME: "notes" } },
    BACKEND_URL: "http://127.0.0.1:1", BACKEND_SHUTDOWN_TOKEN: "synthetic-control-token",
    OWNED_NOTE_PROFILE: null, uiText: ru => ru, notesWindow: window, quickWindow: null,
    isGenerationSender: () => true, isNotesWindowSender: () => true,
    assertProfileMutable() {}, settingsRuntimeUpdateInProgress: false,
    desktopSettings: { notesDirectory: a }, DESKTOP_SETTINGS_PATH: "synthetic", DESKTOP_SETTINGS_DEFAULTS: {},
    saveDesktopSettings: (_file, value) => value, startupBroadcastSuppressionDepth: 0,
    backendProcess: null, backendHttpReadyConfirmed: false, managedQdrantPid: null, HTTP_REQUEST_TIMEOUT_MS: 1000,
    appReadyPromise: Promise.resolve({ originalStartup: true }), broadcastStartupStatus() {},
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [directory] }) },
    readJsonResponse: response => response.json(),
    createDesktopProjectBridge,
    ensureBackendReady: async () => ({ ok: true }),
    stopBackendProcess: async () => {
      await rpc({ op: "stop" });
      context.backendProcess = null; context.backendHttpReadyConfirmed = false; context.appReadyPromise = null;
    },
    runProcess: async () => { throw new Error("No OS process control allowed in fixture"); },
    BACKEND_PORT: 1, reserveLoopbackPort() {}, delay() {}, waitForBackendPortRelease: async () => {},
  };
  context.fetchWithTimeout = async (url, init = {}) => {
    const options = h.bridge.decorateRequest(url, init);
    const endpoint = new URL(url).pathname;
    const reply = await rpc({ op: "http", path: endpoint, method: options.method || "GET",
      headers: Object.fromEntries(new Headers(options.headers)) });
    h.http.push([endpoint, reply.status, reply.body?.code]);
    if (h.failRuntime && endpoint === "/runtime/config") return { ok: false, status: 503, json: async () => ({ error: "Synthetic runtime metadata failure" }) };
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  context.ensureBackendHttpReady = async () => {
    if (context.backendProcess) return;
    h.boots.push(context.process.env.NOTES_DIR);
    if (h.failNextBoot) {
      if (h.failNextBoot === "unready") {
        context.backendProcess = {};
        context.backendHttpReadyConfirmed = false;
      }
      h.failNextBoot = false;
      throw new Error("Synthetic target boot failure");
    }
    await rpc({ op: "boot", environment: context.process.env });
    context.backendProcess = {};
    await h.bridge.verifyBackend();
    context.backendHttpReadyConfirmed = true;
    await h.bridge.activateInitial();
  };
  vm.createContext(context);
  vm.runInContext(`let desktopProjectBridge = null; ${section("function projects() {", "\ntry {\n  const restored")}
    ${section("async function fetchRuntimeConfig(", "\nasync function postRuntimeConfig(")}
    ${section("async function stopBackendManagedServices(", "\n// Who: Tim Buglaev\n// When: 2026-07-02\n// What: Validate all renderer settings")}
    projects();`, context);
  h.bridge = context.projects(); h.bridge.register({ handle: (channel, callback) => handlers.set(channel, callback) });
  h.context = context;
  h.invoke = (channel, value) => handlers.get(`quick-note:${channel}`)({}, value);
  h.bridge.prepareBackendStart(a);
  try {
    const initialPromise = context.appReadyPromise;
    await context.ensureBackendHttpReady();
    assert.equal(context.appReadyPromise, initialPromise, "initial activation must not replace the full startup promise");
    h.initial = await h.invoke("get-projects");
    await run(h);
  } finally {
    child.stdin.end();
    await once(child, "exit");
    lines.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("actual desktop callbacks and Flask gate create a project, then return to the original vault", { timeout: 30000 }, () => fixture(async h => {
  const result = await h.invoke("create-project", { name: "Synthetic B" });
  assert.equal(result.ok, true, JSON.stringify({ code: result.code, error: result.error, http: h.http }));
  assert.equal(result.status, "ready");
  assert.equal(result.projects.length, 2);
  assert.equal((await h.context.appReadyPromise).runtime.provider, "local");
  assert.equal(h.http.some(([endpoint, status]) => endpoint === "/runtime/config" && status === 503), false);
  const lastActivate = h.http.findLastIndex(([endpoint]) => endpoint === "/projects/activate");
  const runtimeRead = h.http.findLastIndex(([endpoint]) => endpoint === "/runtime/config");
  assert.ok(lastActivate < runtimeRead);
  const restored = await h.invoke("switch-project", h.initial.activeProjectId);
  assert.equal(restored.ok, true); assert.equal(restored.activeProject.notesDirectory, h.a);
  assert.equal(fs.readFileSync(path.join(h.a, "Source.md"), "utf8"), "Synthetic immutable A source");
}));

test("target boot failure restores and activates the old project before reading runtime metadata", { timeout: 30000 }, () => fixture(async h => {
  h.failNextBoot = true;
  const result = await h.invoke("create-project", { name: "Synthetic failure" });
  assert.equal(result.ok, false); assert.equal(result.code, "project_switch_failed");
  assert.equal(result.status, "ready"); assert.equal(result.activeProjectId, h.initial.activeProjectId);
  assert.equal((await h.context.appReadyPromise).runtime.provider, "local");
  assert.equal(fs.readFileSync(path.join(h.a, "Source.md"), "utf8"), "Synthetic immutable A source");
}));

test("an owned target that fails before readiness can be retired so the previous project recovers", { timeout: 30000 }, () => fixture(async h => {
  h.failNextBoot = "unready";
  const result = await h.invoke("create-project", { name: "Synthetic unready target" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "project_switch_failed", "An unactivated child must not block recovery");
  assert.equal(result.status, "ready");
  assert.equal(result.activeProjectId, h.initial.activeProjectId);
  assert.equal((await h.context.appReadyPromise).runtime.provider, "local");
  assert.equal(fs.readFileSync(path.join(h.a, "Source.md"), "utf8"), "Synthetic immutable A source");
}));

test("metadata failure after activation keeps committed target and never rolls work back to old project", { timeout: 30000 }, () => fixture(async h => {
  h.failRuntime = true;
  const result = await h.invoke("create-project", { name: "Synthetic metadata failure" });
  assert.equal(result.ok, false); assert.equal(result.code, "project_activation_failed");
  assert.equal(result.status, "error"); assert.equal(result.context, null);
  assert.notEqual(result.activeProjectId, h.initial.activeProjectId);
  assert.equal(h.boots.length, 2);
  assert.equal(fs.readFileSync(path.join(h.a, "Source.md"), "utf8"), "Synthetic immutable A source");
}));
