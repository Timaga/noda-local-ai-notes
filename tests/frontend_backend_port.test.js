"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { waitForBackendPortRelease } = require("../frontend/backend_port");
const { reserveLoopbackPort } = require("../frontend/portable_runtime");

test("owned server handoff waits for its actual listener to close before starting the new project", async () => {
  const previous = await reserveLoopbackPort();
  let attempts = 0, waits = 0;
  try {
    await waitForBackendPortRelease({ port: previous.port, intervalMs: 100, timeoutMs: 500,
      reserve: async port => { attempts++; return reserveLoopbackPort(port); },
      delay: async interval => {
        assert.equal(interval, 100);
        waits++;
        if (waits === 2) await previous.release();
      },
    });
    assert.equal(attempts, 3);
    const target = await reserveLoopbackPort(previous.port);
    await target.release();
  } finally {
    if (waits < 2) await previous.release();
  }
});

test("a listener owned by another application remains untouched and produces a bounded failure", async () => {
  const foreign = await reserveLoopbackPort();
  let waits = 0;
  try {
    await assert.rejects(waitForBackendPortRelease({ port: foreign.port, reserve: reserveLoopbackPort,
      delay: async () => { waits++; }, timeoutMs: 200, intervalMs: 100 }), { code: "backend_port_busy" });
    assert.equal(waits, 2);
    await assert.rejects(reserveLoopbackPort(foreign.port), error => ["EADDRINUSE", "EACCES"].includes(error.code));
  } finally { await foreign.release(); }
});

test("Windows access errors during release retry, while unrelated failures surface immediately", async () => {
  let attempts = 0, released = false;
  await waitForBackendPortRelease({ port: 1234, delay: async () => {}, reserve: async () => {
    if (++attempts === 1) throw Object.assign(new Error("Synthetic access race"), { code: "EACCES" });
    return { release: async () => { released = true; } };
  } });
  assert.equal(attempts, 2); assert.equal(released, true);
  const failure = Object.assign(new Error("Synthetic system error"), { code: "EINVAL" });
  await assert.rejects(waitForBackendPortRelease({ port: 1234,
    reserve: async () => { throw failure; }, delay: async () => assert.fail("Must not retry") }), error => error === failure);
});

test("reservation is released immediately without waiting when the endpoint is already free", async () => {
  let released = false;
  await waitForBackendPortRelease({ port: 1234, delay: async () => assert.fail("No wait expected"),
    reserve: async () => ({ release: async () => { released = true; } }) });
  assert.equal(released, true);
});

test("release errors are surfaced rather than retried against a reservation still held by this process", async () => {
  const failure = Object.assign(new Error("Synthetic reservation close failure"), { code: "EACCES" });
  await assert.rejects(waitForBackendPortRelease({ port: 1234,
    reserve: async () => ({ release: async () => { throw failure; } }),
    delay: async () => assert.fail("A release error must not be retried") }), error => error === failure);
});
