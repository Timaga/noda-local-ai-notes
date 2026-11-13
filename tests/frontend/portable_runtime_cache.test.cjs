"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { portablePaths, setupPortableRuntime } = require("../../frontend/portable_runtime");

const digest = value => createHash("sha256").update(value).digest("hex").toUpperCase();

function installed(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "noda-installed-runtime-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const runtime = portablePaths(path.join(base, "source"), base);
  const write = (file, content = "fixture") => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const previousSystemRoot = process.env.SystemRoot;
  process.env.SystemRoot = path.join(base, "Windows");
  t.after(() => {
    if (previousSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousSystemRoot;
  });
  for (const dll of ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"]) {
    write(path.join(process.env.SystemRoot, "System32", dll));
  }
  const scripts = path.join(runtime.source, "scripts", "windows-portable");
  const python = path.join(runtime.root, "python-test", "python.exe");
  const assets = { schema: "noda-windows-runtime-v1", python: { version: "test", executableSha256: digest("python") },
    qdrant: { executableSha256: digest("qdrant") }, llama: { version: "fixture" } };
  const llama = { schema: "noda-portable-llama-cpu-v1", tag: "fixture", executable: "llama-server.exe",
    files: [{ path: "llama-server.exe", bytes: 5, sha256: digest("llama") }] };
  const embedding = { schema: "noda-embedding-profile-v1", repository: "fixture/model", revision: "a".repeat(40),
    weightsHash: digest("weights").toLowerCase(), weightsBytes: 7, files: ["model.safetensors", "config.json"] };
  write(path.join(scripts, "runtime-assets.json"), JSON.stringify(assets));
  write(path.join(scripts, "llama-cpu-assets.json"), JSON.stringify(llama));
  write(path.join(scripts, "requirements-win-x64.lock"), "pinned wheels");
  write(path.join(scripts, "embedding-profile.json"), JSON.stringify(embedding));
  const receipt = { schema: assets.schema, assets: digest(JSON.stringify(assets)),
    llama: digest(JSON.stringify(llama)), wheels: digest("pinned wheels") };
  write(path.join(runtime.root, "core-ready.json"), JSON.stringify(receipt));
  write(python, "python");
  write(path.join(path.dirname(python), "pythonw.exe"));
  write(runtime.python);
  write(runtime.backendPython);
  write(runtime.qdrant, "qdrant");
  write(runtime.llama, "llama");
  write(runtime.setupChoice, "no\n");
  for (const name of ["flask", "llama_cpp", "onnxruntime", "qdrant_client", "sentencepiece",
    "sentence_transformers", "torch", "watchdog"]) {
    write(path.join(runtime.root, ".venv", "Lib", "site-packages", name, "__init__.py"));
  }
  return { runtime, write, scripts, receipt, python, embedding };
}

test("repeated launches reuse a verified installation without starting setup", async t => {
  const { runtime } = installed(t);
  const progress = [];
  const options = { provision: () => assert.fail("a ready runtime must not start a setup process"),
    onProgress: item => progress.push(item) };
  for (let launch = 0; launch < 2; launch += 1) {
    const env = await setupPortableRuntime(runtime, options);
    assert.equal(env.NODA_SEMANTIC_SEARCH_ENABLED, "0");
    assert.equal(env.NODA_RUNTIME_HOME, runtime.root);
  }
  assert.deepEqual(progress.map(item => [item.phase, item.status]), [["ready", "cached"], ["ready", "cached"]]);
});

for (const [name, damage] of [
  ["missing receipt", f => fs.unlinkSync(path.join(f.runtime.root, "core-ready.json"))],
  ["malformed receipt", f => f.write(path.join(f.runtime.root, "core-ready.json"), "{")],
  ["changed dependency lock", f => f.write(path.join(f.scripts, "requirements-win-x64.lock"), "new lock")],
  ["wrong receipt schema", f => f.write(path.join(f.runtime.root, "core-ready.json"), JSON.stringify({ ...f.receipt, schema: "other" }))],
  ["missing backend Python", f => fs.unlinkSync(f.runtime.backendPython)],
  ["changed Python binary", f => f.write(f.python, "changed")],
  ["changed Qdrant binary", f => f.write(f.runtime.qdrant, "changed")],
  ["changed model engine", f => f.write(f.runtime.llama, "other")],
  ["missing package", f => fs.unlinkSync(path.join(f.runtime.root, ".venv/Lib/site-packages/flask/__init__.py"))],
  ["missing Windows prerequisite", () => fs.unlinkSync(path.join(process.env.SystemRoot, "System32/msvcp140.dll"))],
  ["changed engine size", f => f.write(f.runtime.llama, "larger engine")],
  ["invalid packaged JSON", f => f.write(path.join(f.scripts, "runtime-assets.json"), "{")],
]) {
  test(`${name} requires setup instead of trusting an old marker`, async t => {
    const fixture = installed(t);
    damage(fixture);
    const failure = new Error("setup required");
    let attempts = 0;
    await assert.rejects(setupPortableRuntime(fixture.runtime, { provision: async () => { attempts += 1; throw failure; } }), failure);
    assert.equal(attempts, 1);
  });
}

test("invalid engine paths cannot escape the runtime while checking its cache", async t => {
  const f = installed(t);
  const manifest = JSON.stringify({ schema: "noda-portable-llama-cpu-v1", tag: "fixture",
    files: [{ path: "../outside.exe", bytes: 5, sha256: digest("llama") }] });
  f.write(path.join(f.scripts, "llama-cpu-assets.json"), manifest);
  f.write(path.join(f.runtime.root, "core-ready.json"), JSON.stringify({ ...f.receipt, llama: digest(manifest) }));
  const failure = new Error("invalid manifest");
  await assert.rejects(setupPortableRuntime(f.runtime, { provision: async () => { throw failure; } }), failure);
});

test("an unreadable receipt fails closed instead of starting setup", async t => {
  const f = installed(t);
  const receipt = path.join(f.runtime.root, "core-ready.json");
  fs.unlinkSync(receipt);
  fs.mkdirSync(receipt);
  await assert.rejects(setupPortableRuntime(f.runtime, {
    provision: () => assert.fail("an I/O failure must not trigger installation"),
  }), { code: "EISDIR" });
});

test("semantic search reuses its verified cached snapshot and detects a changed file", async t => {
  const { runtime, write, embedding } = installed(t);
  write(runtime.setupChoice, "yes\n");
  const folder = path.join(runtime.root, "huggingface/hub/models--fixture--model/snapshots", embedding.revision);
  write(path.join(folder, "config.json"));
  const weights = path.join(folder, "model.safetensors");
  write(weights, "weights");
  const stamp = `["${embedding.weightsHash}", ${embedding.weightsBytes}, ${fs.statSync(weights, { bigint: true }).mtimeNs}]`;
  write(path.join(folder, ".noda-verified"), stamp);
  write(path.join(folder, "../../refs/main"), embedding.revision);
  const env = await setupPortableRuntime(runtime, { provision: () => assert.fail("verified model is already installed") });
  assert.equal(env.NODA_SEMANTIC_SEARCH_ENABLED, "1");
  write(weights, "altered");
  const failure = new Error("model needs verification");
  await assert.rejects(setupPortableRuntime(runtime, { provision: async (_, options) => {
    assert.equal(options.includeEmbedding, true);
    throw failure;
  } }), failure);
});

test("enabling semantic search with no snapshot still requests setup", async t => {
  const { runtime } = installed(t);
  const failure = new Error("model needs download");
  await assert.rejects(setupPortableRuntime(runtime, { forceEmbedding: true, provision: async (_, options) => {
    assert.equal(options.includeEmbedding, true);
    throw failure;
  } }), failure);
  assert.equal(fs.readFileSync(runtime.setupChoice, "utf8"), "no\n");
});

test("canceled startup never starts setup or returns a cached environment", async t => {
  const { runtime } = installed(t);
  const controller = new AbortController();
  controller.abort(new Error("closed"));
  await assert.rejects(setupPortableRuntime(runtime, { signal: controller.signal,
    provision: () => assert.fail("startup has been canceled") }), /closed/);
});
