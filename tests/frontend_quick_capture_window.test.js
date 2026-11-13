"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { captureBounds, createQuickCaptureController } = require("../frontend/quick_capture_window");

test("capture fits small screens and monitors with negative coordinates", () => {
  const normal = captureBounds({ x: -1920, y: 0, width: 1920, height: 1040 }, 86);
  assert.deepEqual(normal, { x: -1360, y: 926, width: 800, height: 86 });
  const small = captureBounds({ x: 100, y: -500, width: 300, height: 400 }, 2000);
  assert.deepEqual(small, { x: 100, y: -500, width: 300, height: 400 });
});

function fixture() {
  const calls = [];
  const focusCalls = [];
  const win = { webContents: {
      focus: () => focusCalls.push("contents-focus"),
      send: channel => focusCalls.push(channel),
      isDestroyed: () => false,
      session: { flushStorageData: () => focusCalls.push("flush-storage") },
    }, isDestroyed: () => false, isVisible: () => true, isFocused: () => true,
    getBounds: () => ({ x: -1200, y: 900, width: 800, height: 86 }),
    setBounds: (bounds) => calls.push(bounds),
    show: () => focusCalls.push("show"), focus: () => focusCalls.push("window-focus") };
  const screen = {
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getDisplayMatching: () => ({ workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }),
  };
  return { calls, focusCalls, win, controller: createQuickCaptureController({ getWindow: () => win, screen }) };
}

test("opening quick capture requests editor focus on every show", () => {
  const { controller, win, focusCalls } = fixture();
  for (let reopen = 0; reopen < 2; reopen += 1) {
    controller.show(win);
    assert.deepEqual(focusCalls.splice(0), ["show", "window-focus", "contents-focus", "quick-note:focus-input"]);
  }
});

test("quit can flush drafts in a hidden window without focusing it", () => {
  const { controller, win, focusCalls } = fixture();
  win.isVisible = () => false;
  controller.flushDraftStorage();
  assert.deepEqual(focusCalls.splice(0), ["flush-storage"]);
  win.webContents.isDestroyed = () => true;
  controller.flushDraftStorage();
  assert.deepEqual(focusCalls, []);
});

test("late page-load completion cannot refocus a hidden or inactive window", () => {
  const { controller, win, focusCalls } = fixture();
  for (const property of ["isDestroyed", "isVisible", "isFocused"]) {
    const original = win[property];
    win[property] = () => property === "isDestroyed";
    assert.equal(controller.focusInput(win), false);
    assert.deepEqual(focusCalls, []);
    win[property] = original;
  }
  assert.equal(controller.focusInput(null), false);
  assert.equal(controller.focusInput(win), true);
  assert.deepEqual(focusCalls, ["contents-focus", "quick-note:focus-input"]);
});

test("only the live quick window can resize, invalid requests leave geometry intact", () => {
  const { controller, win, calls } = fixture();
  assert.equal(controller.resize({ sender: {} }, 420).error, "forbidden");
  for (const height of [null, "420", NaN, Infinity, -1, 0, 86.5, 4097]) {
    assert.equal(controller.resize({ sender: win.webContents }, height).error, "invalid_height");
  }
  win.isDestroyed = () => true;
  assert.equal(controller.resize({ sender: win.webContents }, 420).error, "forbidden");
  assert.deepEqual(calls, []);
  const absent = createQuickCaptureController({ getWindow: () => null, screen: {} });
  assert.equal(absent.resize({}, 420).error, "forbidden");
});

test("queue expansion stays on its monitor and reopening retains the measured size", () => {
  const { controller, win, calls } = fixture();
  controller.show(win);
  assert.deepEqual(calls.pop(), { x: 560, y: 926, width: 800, height: 86 });
  assert.deepEqual(controller.resize({ sender: win.webContents }, 420), { ok: true });
  assert.deepEqual(calls.pop(), { x: -1360, y: 592, width: 800, height: 420 });
  controller.show(win);
  assert.equal(calls.pop().height, 420);
  controller.resize({ sender: win.webContents }, 40);
  assert.equal(calls.pop().height, 86);
  controller.resize({ sender: win.webContents }, 1800);
  assert.equal(calls.pop().height, 650);
});
