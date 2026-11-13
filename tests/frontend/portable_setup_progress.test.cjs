"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const main = fs.readFileSync(path.join(__dirname, "../../frontend/main.js"), "utf8");
const start = main.indexOf("async function ensurePortableDependencies() {");
const end = main.indexOf("\nlet settingsRuntimeUpdateInProgress", start);
assert.ok(start > 0 && end > start);

for (const [language, expected] of [["ru", "Запускаем Noda"], ["en", "Starting Noda"]]) {
  test(`a cached launch shows startup, not installation (${language})`, async () => {
    const states = [];
    const context = vm.createContext({
      AbortController, portableDependenciesReady: false, portableSetupController: null,
      isQuitting: false, PORTABLE_RUNTIME: {}, AUTO_QUIT_AFTER_READY_MS: 0,
      DEFAULT_NOTES_DIRECTORY: "synthetic", process: { argv: [], env: {} },
      uiText: (ru, en) => language === "ru" ? ru : en,
      broadcastStartupStatus: state => states.push(state),
      fs: { mkdirSync() {} },
      setupPortableRuntime: async (_, options) => {
        options.onProgress({ phase: "ready", status: "cached", includeEmbedding: false });
        return { NODA_RUNTIME_HOME: "synthetic" };
      },
    });
    vm.runInContext(main.slice(start, end), context);
    await context.ensurePortableDependencies();
    assert.equal(context.portableDependenciesReady, true);
    assert.ok(states.filter(state => state.message).every(state => state.message === expected));
    assert.equal(states.at(-1).provisioning, null);
    const count = states.length;
    await context.ensurePortableDependencies();
    assert.equal(states.length, count);
  });
}

test("a real missing component still has an installation progress state", async () => {
  const states = [];
  const context = vm.createContext({
    AbortController, portableDependenciesReady: false, portableSetupController: null,
    isQuitting: false, PORTABLE_RUNTIME: {}, AUTO_QUIT_AFTER_READY_MS: 0,
    DEFAULT_NOTES_DIRECTORY: "synthetic", process: { argv: [], env: {} },
    uiText: ru => ru, broadcastStartupStatus: state => states.push(state),
    fs: { mkdirSync() {} },
    setupPortableRuntime: async (_, options) => {
      options.onProgress({ phase: "python", status: "started", includeEmbedding: false });
      return {};
    },
  });
  vm.runInContext(main.slice(start, end), context);
  await context.ensurePortableDependencies();
  assert.ok(states.some(state => state.message === "Устанавливаем Noda" && state.detail === "Python"));
});
