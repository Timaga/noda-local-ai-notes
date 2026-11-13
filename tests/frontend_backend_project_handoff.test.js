"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { waitForBackendPortRelease } = require("../frontend/backend_port");
const { reserveLoopbackPort } = require("../frontend/portable_runtime");
const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const begin = source.indexOf("function projects() {"), end = source.indexOf("\ntry {\n  const restored", begin);

async function fixture(run, ready = true) {
  const previous = await reserveLoopbackPort();
  let options, released = false;
  const calls = [];
  const context = {
    app: { getPath: () => "synthetic-profile" }, process: { env: {} },
    BACKEND_URL: `http://127.0.0.1:${previous.port}`, BACKEND_PORT: previous.port,
    BACKEND_SHUTDOWN_TOKEN: "synthetic-invalid", OWNED_NOTE_PROFILE: null,
    fetchWithTimeout() {}, readJsonResponse() {}, ensureBackendReady() {},
    uiText: ru => ru, dialog: {}, shell: {}, isGenerationSender() {}, isNotesWindowSender() {},
    notesWindow: null, quickWindow: null, assertProfileMutable() {},
    settingsRuntimeUpdateInProgress: false, startupBroadcastSuppressionDepth: 0,
    backendProcess: {}, backendHttpReadyConfirmed: ready,
    desktopSettings: {}, DESKTOP_SETTINGS_PATH: "synthetic", DESKTOP_SETTINGS_DEFAULTS: {}, saveDesktopSettings() {},
    createDesktopProjectBridge: value => { options = value; return {}; },
    stopBackendManagedServices: async () => { calls.push("graceful-stop"); },
    stopBackendProcess: async () => { calls.push("retire-owned-child"); context.backendProcess = null; },
    waitForBackendPortRelease, reserveLoopbackPort,
    delay: async () => {
      calls.push("wait-for-release");
      await previous.release(); released = true;
    },
    ensureBackendHttpReady: async () => {
      const target = await reserveLoopbackPort(previous.port);
      await target.release(); calls.push("start-target");
    },
  };
  vm.createContext(context);
  vm.runInContext(`let desktopProjectBridge=null;${source.slice(begin, end)};projects();`, context);
  try { await run({ options, calls, context }); }
  finally { if (!released) await previous.release(); }
}

test("actual main waits after retiring its child before starting the target project", () => fixture(async h => {
  await h.options.stopBackend({ project_id: "synthetic", context_token: "synthetic" });
  await h.options.restartBackend();
  assert.deepEqual(h.calls, ["graceful-stop", "retire-owned-child", "wait-for-release", "start-target"]);
  assert.equal(h.context.startupBroadcastSuppressionDepth, 0);
}));

test("an unready owned target can be retired without calling its unavailable HTTP control endpoint", () => fixture(async h => {
  await h.options.stopBackend({ project_id: "synthetic", context_token: "synthetic" });
  await h.options.restartBackend();
  assert.deepEqual(h.calls, ["retire-owned-child", "wait-for-release", "start-target"]);
}, false));
