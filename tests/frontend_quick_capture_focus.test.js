"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const frontend = path.join(__dirname, "../frontend");

function preloadFixture() {
  let bridge;
  const listeners = new Map();
  const context = vm.createContext({
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: {
        on: (channel, callback) => listeners.set(channel, callback),
        removeListener: (channel, callback) => {
          assert.equal(listeners.get(channel), callback);
          listeners.delete(channel);
        },
      },
    }),
    process: { argv: [] }, document: { documentElement: { dataset: {}, style: {} } }, window: {},
  });
  vm.runInContext(fs.readFileSync(path.join(frontend, "preload.js"), "utf8"), context,
    { filename: path.join(frontend, "preload.js") });
  return { bridge, listeners };
}

test("focus subscription rejects noncallbacks without adding a listener", () => {
  const { bridge, listeners } = preloadFixture();
  for (const value of [null, undefined, "not-a-callback", {}]) {
    assert.equal(typeof bridge.onQuickNoteFocusInput(value), "function");
    assert.equal(listeners.has("quick-note:focus-input"), false);
  }
});

test("focus bridge strips IPC event and payload, then removes only its subscription", () => {
  const { bridge, listeners } = preloadFixture();
  const received = [];
  const remove = bridge.onQuickNoteFocusInput((...args) => received.push(args));
  listeners.get("quick-note:focus-input")({ sender: "must-not-cross-bridge" }, "unused-payload");
  assert.deepEqual(received, [[]]);
  remove();
  assert.equal(listeners.has("quick-note:focus-input"), false);
});

test("renderer focuses the input only on an explicit request and preserves draft and selection", () => {
  const renderer = fs.readFileSync(path.join(frontend, "renderer.js"), "utf8");
  const block = renderer.slice(renderer.indexOf("const promptInput ="), renderer.indexOf("const modeInputs ="));
  assert.ok(block.includes("onQuickNoteFocusInput"));
  const events = new Map(), focuses = [];
  let requested, removed = 0;
  const input = { value: "Уже набранный текст", selectionStart: 3, selectionEnd: 7,
    focus: options => focuses.push(JSON.parse(JSON.stringify(options))) };
  const before = { ...input };
  const context = vm.createContext({
    document: { getElementById: id => { assert.equal(id, "prompt-input"); return input; } },
    window: {
      quickNoteBridge: { onQuickNoteFocusInput: callback => {
        requested = callback; return () => { removed += 1; };
      } },
      addEventListener: (event, callback, options) => events.set(event, { callback, options }),
    },
  });
  vm.runInContext(block, context);
  assert.deepEqual(focuses, []);
  requested(); requested();
  assert.deepEqual(focuses, [{ preventScroll: true }, { preventScroll: true }]);
  assert.deepEqual(input, before);
  assert.equal(events.get("beforeunload").options.once, true);
  events.get("beforeunload").callback();
  assert.equal(removed, 1);
  context.window.quickNoteBridge = undefined;
  vm.runInNewContext(block, { window: context.window, document: context.document });
  events.get("beforeunload").callback();
  assert.equal(removed, 1);
});
