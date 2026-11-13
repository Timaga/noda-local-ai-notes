"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const main = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const begin = main.indexOf("function startBackendProcess() {");
const end = main.indexOf("\nasync function waitForBackendReady()", begin);
assert(begin >= 0 && end > begin);

function fixture() {
  const children = [];
  const context = {
    backendProcess: null, managedBackendPid: null, backendReadyPromise: null,
    appReadyPromise: null, backendHttpReadyConfirmed: false,
    projectInitializationError: null, projects: () => ({ prepareBackendStart() {} }),
    desktopSettings: { notesDirectory: "synthetic-A" },
    process: { platform: "win32", env: { NOTES_DIR: "synthetic-A" } },
    broadcastStartupStatus() {}, uiText: ru => ru, suppressBackendOutput: false,
    getPythonExecutable: () => "synthetic-python-never-executed",
    PROJECT_ROOT: "synthetic-code", BACKEND_PACKAGE_DIR: "synthetic-backend",
    PORTABLE_RUNTIME: null, BACKEND_PORT: 18741,
    BACKEND_RUNTIME_MODULE: "synthetic-unused", BACKEND_SHUTDOWN_TOKEN: "synthetic-invalid",
    BACKEND_INSTANCE_ID: "synthetic-instance", path, console: { log() {}, error() {} },
    spawn(_executable, _args, options) {
      const child = new EventEmitter();
      child.pid = 900000 + children.length;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.options = options;
      children.push(child);
      return child;
    },
  };
  vm.createContext(context);
  vm.runInContext(main.slice(begin, end), context, { filename: "actual-main-startBackendProcess.js" });
  return { context, children };
}

function ready(context) {
  context.backendReadyPromise = { identity: "current-backend-ready" };
  context.appReadyPromise = { identity: "current-app-ready" };
  context.backendHttpReadyConfirmed = true;
  return [context.backendReadyPromise, context.appReadyPromise];
}

for (const event of ["error", "exit"]) {
  test(`late project A backend ${event} cannot clear project B handle or readiness`, () => {
    const { context, children } = fixture();
    context.startBackendProcess(); const a = children[0];
    // The owned stop has retired A; its queued ChildProcess notification may arrive later.
    context.backendProcess = null; context.managedBackendPid = null;
    context.process.env.NOTES_DIR = "synthetic-B";
    context.startBackendProcess(); const b = children[1];
    const [backendReady, appReady] = ready(context);
    a.emit(event, ...(event === "error" ? [new Error("old synthetic A failure")] : [0, null]));
    assert.equal(context.backendProcess, b);
    assert.equal(context.managedBackendPid, b.pid);
    assert.equal(context.backendReadyPromise, backendReady);
    assert.equal(context.appReadyPromise, appReady);
    assert.equal(context.backendHttpReadyConfirmed, true);
    assert.equal(b.options.env.NOTES_DIR, "synthetic-B");
    context.startBackendProcess();
    assert.equal(children.length, 2, "A stale event must not cause a duplicate backend launch");
  });

  test(`current backend ${event} still invalidates its own handle and cached readiness`, () => {
    const { context, children } = fixture();
    context.startBackendProcess(); ready(context);
    children[0].emit(event, ...(event === "error" ? [new Error("current synthetic failure")] : [1, null]));
    assert.equal(context.backendProcess, null);
    assert.equal(context.managedBackendPid, null);
    assert.equal(context.backendReadyPromise, null);
    assert.equal(context.appReadyPromise, null);
    assert.equal(context.backendHttpReadyConfirmed, false);
  });
}

test("explicitly retiring an owned backend invalidates HTTP readiness before awaiting process exit", async () => {
  const { context, children } = fixture();
  let release;
  context.runProcess = () => new Promise(resolve => { release = resolve; });
  context.PROCESS_STOP_TIMEOUT_MS = 1000;
  context.startBackendProcess();
  ready(context);
  const stopBegin = main.indexOf("async function stopBackendProcess() {");
  const stopEnd = main.indexOf("\n// Who:", stopBegin);
  vm.runInContext(main.slice(stopBegin, stopEnd), context);
  const stopping = context.stopBackendProcess();
  assert.equal(context.backendHttpReadyConfirmed, false);
  assert.equal(context.backendProcess, null);
  assert.equal(context.backendReadyPromise, null);
  release({ ok: true });
  await stopping;
  assert.equal(children.length, 1);
});
