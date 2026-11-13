"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { create } = require("../../frontend/notes_live_sync");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(refresh, extra = {}) {
  let visible = true, nextId = 0, unrefCount = 0;
  const tasks = new Map(), errors = [];
  const options = {
    refresh, isVisible: () => visible, onError: error => errors.push(error),
    setTimer: (callback, delay) => {
      const handle = { id: ++nextId, unref: () => { unrefCount += 1; } };
      tasks.set(handle, { callback, delay });
      return handle;
    },
    clearTimer: handle => tasks.delete(handle), ...extra,
  };
  const controller = create(options);
  return {
    controller, tasks, errors, visible: value => { visible = value; },
    get unrefCount() { return unrefCount; },
    get delay() { return tasks.values().next().value?.delay; },
    fire() {
      const [handle, task] = tasks.entries().next().value;
      tasks.delete(handle);
      return task.callback();
    },
  };
}

test("invalid scheduler options reject before scheduling work", () => {
  for (const options of [undefined, {}, { refresh: 1 },
    { refresh() {}, isVisible: false }, { refresh() {}, onError: false },
    { refresh() {}, setTimer: false }, { refresh() {}, clearTimer: false },
    { refresh() {}, intervalMs: 0 }, { refresh() {}, intervalMs: NaN },
    { refresh() {}, intervalMs: 1.5 }, { refresh() {}, maxIntervalMs: Infinity },
    { refresh() {}, intervalMs: 2, maxIntervalMs: 1 },
    { refresh() {}, maxIntervalMs: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => create(options), TypeError);
  }
});

test("explicit refresh coalesces before start and runs while hidden", async () => {
  const pending = deferred(), contexts = [];
  const f = fixture(context => { contexts.push(context); return pending.promise; });
  f.visible(false);
  const first = f.controller.refresh(), second = f.controller.refresh();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].background, false);
  assert.equal(contexts[0].isCurrent(), true);
  pending.resolve("snapshot");
  assert.equal(await first, "snapshot");
  assert.equal(f.tasks.size, 0);
  assert.equal(f.controller.getState().running, false);
});

test("start schedules one automatic refresh and does not repeat the initial load", async () => {
  const contexts = [];
  const f = fixture(context => { contexts.push(context); return "ok"; });
  f.controller.start(); f.controller.start();
  assert.equal(contexts.length, 0);
  assert.equal(f.tasks.size, 1);
  assert.equal(f.delay, 1500);
  await f.fire();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].background, true);
  assert.equal(f.tasks.size, 1);
  assert.equal(f.delay, 1500);
  assert.equal(f.unrefCount, 2);
  f.controller.dispose();
});

test("wake during a request queues at most one follow-up without overlap", async () => {
  const pending = deferred();
  let active = 0, peak = 0, calls = 0;
  const f = fixture(async () => {
    active += 1; peak = Math.max(active, peak); calls += 1;
    if (calls === 1) await pending.promise;
    active -= 1;
  });
  f.controller.start();
  const first = f.controller.wake();
  assert.equal(f.controller.wake(), first);
  assert.equal(f.controller.wake(), first);
  assert.equal(f.controller.refresh(), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  pending.resolve(); await first;
  assert.equal(f.delay, 0);
  await f.fire();
  assert.equal(calls, 2);
  assert.equal(peak, 1);
  assert.equal(f.delay, 1500);
  f.controller.dispose();
});

test("automatic failures back off to a bound and successful refresh resets it", async () => {
  const failure = new Error("synthetic-network-failure");
  let fail = true;
  const f = fixture(() => fail ? Promise.reject(failure) : "recovered");
  f.controller.start();
  assert.equal(f.delay, 1500);
  for (const delay of [3000, 6000, 12000, 15000, 15000]) {
    await assert.rejects(f.fire(), error => error === failure);
    assert.equal(f.delay, delay);
  }
  assert.equal(f.errors.length, 5);
  fail = false;
  assert.equal(await f.fire(), "recovered");
  assert.equal(f.delay, 1500);
  assert.equal(f.controller.getState().failures, 0);
  f.controller.dispose();
});

test("manual rejection keeps the original error without background notification", async () => {
  const failure = new Error("manual-read-failed");
  const f = fixture(() => { throw failure; });
  await assert.rejects(f.controller.refresh(), error => error === failure);
  assert.deepEqual(f.errors, []);
  assert.equal(f.controller.getState().running, false);
  assert.equal(f.controller.getState().failures, 1);
});

test("pause invalidates an in-flight result, wake queues a fresh request", async () => {
  const pending = deferred(), contexts = [];
  const f = fixture(context => {
    contexts.push(context);
    return contexts.length === 1 ? pending.promise : "fresh";
  });
  f.controller.start();
  const old = f.controller.wake();
  await Promise.resolve();
  assert.equal(contexts[0].isCurrent(), true);
  f.controller.pause();
  assert.equal(contexts[0].isCurrent(), false);
  assert.equal(f.tasks.size, 0);
  assert.equal(f.controller.wake(), old);
  pending.resolve("stale"); await old;
  assert.equal(f.delay, 0);
  assert.equal(await f.fire(), "fresh");
  assert.equal(contexts[1].isCurrent(), true);
  assert.equal(contexts[0].isCurrent(), false);
  f.controller.dispose();
});

test("hidden pages do not schedule automatic work and resume on wake", async () => {
  const pending = deferred(), contexts = [];
  const f = fixture(context => { contexts.push(context); return pending.promise; });
  f.visible(false); f.controller.start();
  assert.equal(f.tasks.size, 0);
  assert.equal(await f.controller.wake(), false);
  assert.equal(contexts.length, 0);
  f.visible(true);
  const run = f.controller.wake();
  await Promise.resolve();
  assert.equal(contexts[0].isCurrent(), true);
  f.visible(false);
  assert.equal(contexts[0].isCurrent(), false);
  pending.resolve(); await run;
  assert.equal(f.tasks.size, 0);
  f.controller.dispose();
});

test("dispose cancels queued timers, invalidates results, and prevents new requests", async () => {
  const pending = deferred(), contexts = [];
  const f = fixture(context => { contexts.push(context); return pending.promise; });
  f.controller.start();
  const run = f.controller.wake();
  await Promise.resolve();
  f.controller.dispose(); f.controller.dispose();
  assert.equal(contexts[0].isCurrent(), false);
  assert.equal(await f.controller.refresh(), false);
  assert.equal(await f.controller.wake(), false);
  f.controller.start();
  pending.resolve(); await run;
  assert.equal(f.tasks.size, 0);
  assert.equal(contexts.length, 1);
  assert.equal(f.controller.getState().disposed, true);
  assert.equal(f.controller.getState().running, false);
});

test("a cleared timer callback cannot revive a paused or disposed scheduler", async () => {
  let calls = 0;
  const f = fixture(() => { calls += 1; });
  f.controller.start();
  const callback = f.tasks.values().next().value.callback;
  f.controller.pause();
  assert.equal(callback(), undefined);
  assert.equal(calls, 0);
  f.controller.dispose();
  assert.equal(callback(), undefined);
  assert.equal(await f.controller.wake(), false);
  assert.equal(calls, 0);
});

test("a stale timer cannot orphan a newer timer or evade dispose", async () => {
  let calls = 0;
  const f = fixture(() => { calls += 1; });
  f.controller.start();
  const stale = f.tasks.values().next().value.callback;
  f.controller.pause();
  await f.controller.wake();
  assert.equal(calls, 1);
  assert.equal(f.tasks.size, 1);
  stale();
  assert.equal(f.tasks.size, 1);
  f.controller.dispose();
  assert.equal(f.tasks.size, 0);
  assert.equal(calls, 1);
});

test("browser numeric timer handles need no Node unref method", async () => {
  let scheduled, cleared;
  const controller = create({ refresh() {}, setTimer: callback => { scheduled = callback; return 0; },
    clearTimer: handle => { cleared = handle; } });
  controller.start();
  assert.equal(typeof scheduled, "function");
  controller.dispose();
  assert.equal(cleared, 0);
  assert.equal(scheduled(), undefined);
});

test("new refresh contexts invalidate earlier completed contexts", async () => {
  const contexts = [];
  const f = fixture(context => { contexts.push(context); });
  await f.controller.refresh();
  assert.equal(contexts[0].isCurrent(), true);
  const next = f.controller.refresh();
  assert.equal(contexts[0].isCurrent(), false);
  await next;
  assert.equal(contexts[1].isCurrent(), true);
});

test("the same module exposes its browser API without Node globals", () => {
  const filename = path.resolve(__dirname, "../../frontend/notes_live_sync.js");
  const context = vm.createContext({ window: {}, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  assert.equal(typeof context.window.NotesLiveSync.create, "function");
  const controller = context.window.NotesLiveSync.create({ refresh: () => "ok" });
  controller.dispose();
});
