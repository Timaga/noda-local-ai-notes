"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { resolveProjectRoot } = require("../../frontend/project_paths");
const {
  portableEnvironment, portablePaths, reserveLoopbackPort, selectQdrantPorts, setupPortableRuntime, saveEmbeddingChoice,
} = require("../../frontend/portable_runtime");

test("a complete portable package resolves its own server after relocation", t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "noda-path-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const resourcesPath = path.join(base, "Переносимая Noda", "resources");
  const source = path.join(resourcesPath, "noda-runtime");
  fs.mkdirSync(path.join(source, "backend"), { recursive: true });
  fs.writeFileSync(path.join(source, "backend", "app_runtime.py"), "");
  const options = { isPackaged: true, resourcesPath };
  assert.throws(() => resolveProjectRoot(options), /incomplete/);
  fs.mkdirSync(path.join(source, "scripts", "windows-portable"), { recursive: true });
  fs.writeFileSync(path.join(source, "scripts", "windows-portable", "provision.ps1"), "");
  assert.equal(resolveProjectRoot(options), source);
  const runtime = portablePaths(source, path.join(base, "App Data"));
  const env = portableEnvironment(runtime, { http: 29333, grpc: 29334 });
  assert.equal(runtime.backendPython, path.join(runtime.root, ".venv", "Scripts", "pythonw.exe"));
  assert.equal(env.QDRANT_URL, "http://127.0.0.1:29333");
  assert.equal(env.QDRANT__SERVICE__HOST, "127.0.0.1");
  assert.equal(env.NODA_MANAGED_QDRANT_EXE, path.join(runtime.root, "bin", "qdrant.exe"));
  assert.equal(env.NODA_RU_MMARCO_PYTHON, path.join(runtime.root, ".venv", "Scripts", "python.exe"));
  assert.equal(env.RAG_LOCAL_MODEL_TRUST_REMOTE_CODE, "0");
  assert.ok(!runtime.root.startsWith(source));
});

test("port selection avoids an existing listener and never stops it", async () => {
  const other = await reserveLoopbackPort();
  try {
    await assert.rejects(() => reserveLoopbackPort(other.port), { code: "EADDRINUSE" });
    const selected = await selectQdrantPorts();
    assert.equal(new Set([other.port, selected.http, selected.grpc]).size, 3);
    await assert.rejects(() => reserveLoopbackPort(other.port), { code: "EADDRINUSE" });
  } finally {
    await other.release();
  }
});

test("first launch installs semantic search and retains it on subsequent launches", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "noda-fresh-runtime-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const runtime = portablePaths(base, base);
  const embeddingAttempts = [];
  const provision = async (_, { includeEmbedding }) => embeddingAttempts.push(includeEmbedding);

  const fresh = await setupPortableRuntime(runtime, { provision });
  const optIn = await setupPortableRuntime(runtime, { provision, forceEmbedding: true });
  const next = await setupPortableRuntime(runtime, { provision });

  assert.deepEqual(embeddingAttempts, [true, true, true]);
  assert.equal(fresh.NODA_SEMANTIC_SEARCH_ENABLED, "1");
  assert.equal(optIn.NODA_SEMANTIC_SEARCH_ENABLED, "1");
  assert.equal(next.NODA_SEMANTIC_SEARCH_ENABLED, "1");
});

test("an explicit text-only choice is preserved until semantic search is requested", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "noda-text-only-runtime-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const runtime = portablePaths(base, base), attempts = [];
  fs.mkdirSync(runtime.root, { recursive: true });
  saveEmbeddingChoice(runtime, false);
  const provision = async (_, { includeEmbedding }) => attempts.push(includeEmbedding);
  const textOnly = await setupPortableRuntime(runtime, { provision });
  const enabled = await setupPortableRuntime(runtime, { provision, forceEmbedding: true });
  assert.equal(textOnly.NODA_SEMANTIC_SEARCH_ENABLED, "0");
  assert.equal(enabled.NODA_SEMANTIC_SEARCH_ENABLED, "1");
  assert.deepEqual(attempts, [false, true]);
  assert.equal(fs.readFileSync(runtime.setupChoice, "utf8").trim(), "yes");
});

test("an unavailable optional embedding model can fall back and stays off on relaunch", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "noda-embedding-fallback-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const runtime = portablePaths(base, base);
  fs.mkdirSync(runtime.root, { recursive: true });
  saveEmbeddingChoice(runtime, true);
  const choices = [];
  let warnings = 0;
  const options = {
    approveVcRuntime: () => assert.fail("this is not a Visual C++ failure"),
    continueWithoutEmbedding: () => { warnings += 1; return true; },
    provision: async (_, { includeEmbedding }) => {
      choices.push(includeEmbedding);
      if (includeEmbedding) throw Object.assign(new Error("offline"), { code: "provision_failed", phase: "embedding" });
    },
  };
  const first = await setupPortableRuntime(runtime, options);
  assert.equal(first.NODA_SEMANTIC_SEARCH_ENABLED, "0");
  assert.equal(fs.readFileSync(runtime.setupChoice, "utf8").trim(), "no");
  const next = await setupPortableRuntime(runtime, options);
  assert.equal(next.NODA_SEMANTIC_SEARCH_ENABLED, "0");
  assert.deepEqual(choices, [true, false, false]);
  assert.equal(warnings, 1);
});

test("a failed mandatory component still blocks setup without changing the saved choice", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "noda-core-failure-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const runtime = portablePaths(base, base);
  const error = Object.assign(new Error("pip failed"), { code: "provision_failed", phase: "dependencies" });
  await assert.rejects(setupPortableRuntime(runtime, {
    continueWithoutEmbedding: () => assert.fail("missing packages cannot be bypassed"),
    provision: async () => { throw error; },
  }), error);
  assert.equal(fs.existsSync(runtime.setupChoice), false);
});
