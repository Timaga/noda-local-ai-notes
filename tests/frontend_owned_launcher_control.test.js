"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { validateOwnedLauncherControl, attachOwnedLauncherControl } = require("../frontend/owned_launcher_control");

const ID = "11111111-1111-4111-8111-111111111111";

function workspace(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-title-bridge-"));
  const output = path.join(root, "output", "owned");
  fs.mkdirSync(output, { recursive: true });
  const env = {
    NODA_OWNED_TITLE_PROFILE: "qwen35", NODA_OWNED_TITLE_LAUNCH_ID: ID,
    NODA_OWNED_TITLE_LIFECYCLE_PATH: path.join(output, "node-lifecycle.json"),
  };
  try { return callback(root, env); } finally {
    assert.ok(path.relative(os.tmpdir(), root).startsWith("owned-title-bridge-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function attach(root, env) {
  const requests = [];
  const runtime = { env, pid: 201, stdin: new EventEmitter() };
  const child = new EventEmitter();
  child.pid = 202;
  const control = validateOwnedLauncherControl(env, root);
  attachOwnedLauncherControl(runtime, (value) => requests.push(value), child, control);
  return { runtime, child, requests };
}

test("ordinary launcher has no owned stdin listeners or receipts", () => {
  const runtime = { env: {}, stdin: new EventEmitter() };
  assert.equal(validateOwnedLauncherControl(runtime.env), null);
  assert.equal(attachOwnedLauncherControl(runtime, () => assert.fail("shutdown"), {}), null);
  assert.equal(runtime.stdin.listenerCount("data"), 0);
});

test("one valid private-pipe control requests normal shutdown exactly once", () => workspace((root, env) => {
  const { runtime, child, requests } = attach(root, env);
  const data = JSON.stringify({ type: "owned-title-shutdown", launch_id: ID }) + "\n";
  runtime.stdin.emit("data", Buffer.from(data.slice(0, 15)));
  runtime.stdin.emit("data", Buffer.from(data.slice(15)));
  runtime.stdin.emit("end");
  runtime.stdin.emit("data", Buffer.from(data));
  assert.deepEqual(requests, ["owned-parent-request"]);
  child.emit("exit", 0, null);
  const receipt = JSON.parse(fs.readFileSync(env.NODA_OWNED_TITLE_LIFECYCLE_PATH, "utf8"));
  assert.deepEqual(receipt, {
    event: "electron_exit", launchId: ID, nodePid: 201, electronPid: 202,
    code: 0, signal: null, controlRequested: true, controlSchemaRejected: false,
    cleanupInstrumentation: false, normalCleanupSourcePathConsistent: true, fullTreeExclusion: false,
  });
}));

test("abrupt parent EOF requests owned app cleanup, never executes input", () => workspace((root, env) => {
  const { runtime, child, requests } = attach(root, env);
  runtime.stdin.emit("end");
  runtime.stdin.emit("end");
  assert.deepEqual(requests, ["owned-parent-eof"]);
  child.emit("exit", null, "SIGKILL");
  const receipt = JSON.parse(fs.readFileSync(env.NODA_OWNED_TITLE_LIFECYCLE_PATH, "utf8"));
  assert.equal(receipt.normalCleanupSourcePathConsistent, false);
  assert.equal(receipt.fullTreeExclusion, false);
}));

test("unique JSON escaped keys obey the exact decoded schema", () => workspace((root, env) => {
  const { runtime, child, requests } = attach(root, env);
  runtime.stdin.emit("data", Buffer.from(`{"ty\\u0070e":"owned-title-shutdown","launch_\\u0069d":"${ID}"}\n`));
  runtime.stdin.emit("end");
  assert.deepEqual(requests, ["owned-parent-request"]);
  child.emit("exit", 0, null);
  const receipt = JSON.parse(fs.readFileSync(env.NODA_OWNED_TITLE_LIFECYCLE_PATH, "utf8"));
  assert.equal(receipt.controlSchemaRejected, false);
}));

for (const data of [
  "invalid\n", "[]\n", "null\n", "{}\n", "x".repeat(4097),
  JSON.stringify({ type: "run-command", launch_id: ID }) + "\n",
  JSON.stringify({ type: "owned-title-shutdown", launch_id: "different" }) + "\n",
  JSON.stringify({ type: "owned-title-shutdown", launch_id: ID, extra: true }) + "\n",
  `{"type":"owned-title-shutdown","type":"owned-title-shutdown","launch_id":"${ID}"}\n`,
  `{"type":"owned-title-shutdown","ty\\u0070e":"owned-title-shutdown","launch_id":"${ID}"}\n`,
  `{"type":"owned-title-shutdown","launch_id":"${ID}","launch_\\u0069d":"${ID}"}\n`,
  JSON.stringify({ type: "owned-title-shutdown", launch_id: ID }),
  "{",
  JSON.stringify({ type: "owned-title-shutdown", launch_id: ID }) + "\nextra\n",
]) {
  test(`malformed bounded control rejected (${data.length} bytes)`, () => workspace((root, env) => {
    const { runtime, child, requests } = attach(root, env);
    runtime.stdin.emit("data", Buffer.from(data));
    runtime.stdin.emit("end");
    assert.deepEqual(requests, ["owned-invalid-control"]);
    child.emit("exit", 1, null);
    const receipt = JSON.parse(fs.readFileSync(env.NODA_OWNED_TITLE_LIFECYCLE_PATH, "utf8"));
    assert.equal(receipt.controlSchemaRejected, true);
    assert.equal(receipt.normalCleanupSourcePathConsistent, false);
  }));
}

test("control pipe error requests one safe shutdown", () => workspace((root, env) => {
  const { runtime, child, requests } = attach(root, env);
  runtime.stdin.emit("error", new Error("synthetic"));
  runtime.stdin.emit("end");
  assert.deepEqual(requests, ["owned-parent-pipe-error"]);
  child.emit("exit", 0, null);
}));

test("receipt target cannot overwrite or escape owned output", () => workspace((root, env) => {
  fs.writeFileSync(env.NODA_OWNED_TITLE_LIFECYCLE_PATH, "original");
  assert.throws(() => validateOwnedLauncherControl(env, root));
  assert.equal(fs.readFileSync(env.NODA_OWNED_TITLE_LIFECYCLE_PATH, "utf8"), "original");
  for (const target of [path.join(root, "node-lifecycle.json"), "relative", path.join(root, "output/node-lifecycle.json")]) {
    assert.throws(() => validateOwnedLauncherControl({ ...env, NODA_OWNED_TITLE_LIFECYCLE_PATH: target }, root));
  }
}));

test("UUID and controlled descriptor are required before attaching listeners", () => workspace((root, env) => {
  for (const value of [null, "", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "not-a-uuid"]) {
    assert.throws(() => validateOwnedLauncherControl({ ...env, NODA_OWNED_TITLE_LAUNCH_ID: value }, root));
  }
  const runtime = { env, pid: 201, stdin: new EventEmitter() };
  assert.throws(() => attachOwnedLauncherControl(runtime, () => {}, { pid: 202 }, { launchId: ID }));
  assert.equal(runtime.stdin.listenerCount("data"), 0);
}));
