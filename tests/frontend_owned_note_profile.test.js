"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const registry = require("../frontend/owned_note_profiles.json");
const profile = require("../frontend/owned_note_profile");

function workspace(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-title-profile-"));
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  for (const row of Object.values(registry.profiles)) {
    const model = path.join(root, row.model);
    fs.mkdirSync(path.dirname(model), { recursive: true });
    fs.writeFileSync(model, "synthetic-model-file");
  }
  try { return callback(root, vault); } finally {
    assert.ok(path.relative(os.tmpdir(), root).startsWith("owned-title-profile-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function environment(root, vault, name = "qwen35", method = "planned") {
  const model = path.join(root, registry.profiles[name].model);
  return {
    NODA_OWNED_TITLE_PROFILE: name, RAG_NOTE_TITLE_METHOD: method, NOTES_DIR: vault,
    RAG_LLAMA_SERVER_BASE_URL: "http://127.0.0.1:19187",
    RAG_RUNTIME_PROVIDER: "llama_cpp_server", RAG_LOCAL_MODEL_FORMAT: "llama_cpp_server",
    RAG_LOCAL_MODEL_GGUF_PATH: model, RAG_LOCAL_MODEL_ID: model, GGUF_MODEL_PATH: model,
    UNRELATED_SYNTHETIC_SETTING: "preserve",
  };
}

test("ordinary launch ignores stale owned fields and invokes old loader once", () => {
  const env = { RAG_NOTE_TITLE_METHOD: "unknown", RAG_RUNTIME_PROVIDER: "local" };
  let count = 0;
  const result = profile.initializeOwnedProfileEnvironment(env, "unused", () => {
    count += 1;
    env.OLD_LOADER_RESULT = "unchanged";
  });
  assert.equal(result, null);
  assert.equal(count, 1);
  assert.deepEqual(env, {
    RAG_NOTE_TITLE_METHOD: "unknown", RAG_RUNTIME_PROVIDER: "local", OLD_LOADER_RESULT: "unchanged",
  });
  const settings = Object.freeze({ notesDirectory: "ordinary", theme: "noda-red" });
  assert.equal(profile.applyOwnedProfileSettings(null, settings, env), settings);
  assert.doesNotThrow(() => profile.assertProfileMutable(null));
});

for (const [name, method] of [
  ["qwen35", "planned"], ...Object.keys(registry.profiles).map((name) => [name, "reviewed"]),
]) {
  test(`owned ${name}/${method} uses exact vault and keeps settings in memory`, () => workspace((root, vault) => {
    const env = environment(root, vault, name, method);
    const saved = path.join(root, "desktop-settings.json");
    fs.writeFileSync(saved, "original synthetic settings");
    const owned = profile.initializeOwnedProfileEnvironment(env, root, () => assert.fail("Original .env must not be read"));
    const old = Object.freeze({ notesDirectory: "saved-old-vault", theme: "noda-red", skipModelSelection: false });
    const settings = profile.applyOwnedProfileSettings(owned, old, env);
    assert.equal(settings.notesDirectory, fs.realpathSync(vault));
    assert.equal(settings.theme, "noda-red");
    assert.equal(settings.skipModelSelection, true);
    assert.equal(settings.skipNotesDirectorySelection, true);
    assert.equal(settings.skipTurboQuantSelection, true);
    assert.equal(old.notesDirectory, "saved-old-vault");
    assert.equal(fs.readFileSync(saved, "utf8"), "original synthetic settings");
    assert.equal(env.NOTES_DIR, fs.realpathSync(vault));
    assert.equal(env.RAG_NOTE_TITLE_METHOD, method);
    assert.equal(env.RAG_LOCAL_MODEL_NAME, registry.profiles[name].alias);
    assert.equal(env.RAG_LOCAL_MODEL_CONTEXT_SIZE, String(registry.profiles[name].context));
    assert.equal(env.RAG_RUNTIME_PROVIDER, "llama_cpp_server");
    assert.equal(env.PYTHON_DOTENV_DISABLED, "1");
    assert.equal(env.RAG_MODEL_SELECTION_ON_STARTUP, "false");
    assert.equal(env.RAG_VLLM_AUTOSTART, "false");
    assert.equal(env.RAG_STOP_LEGACY_DOCKER_CONTAINERS, "false");
    assert.equal(env.RAG_VLLM_WSL_TERMINATE_ON_EXIT, "false");
    assert.equal(env.UNRELATED_SYNTHETIC_SETTING, "preserve");
    assert.ok(Object.isFrozen(owned) && Object.isFrozen(owned.fixed));
    assert.throws(() => profile.assertProfileMutable(owned), /завершите/);
  }));
}

for (const marker of ["", "unknown", null, undefined, true, {}]) {
  test(`malformed profile marker ${String(marker)} fails before dotenv`, () => workspace((root, vault) => {
    const env = environment(root, vault);
    env.NODA_OWNED_TITLE_PROFILE = marker;
    const before = { ...env };
    assert.throws(() => profile.initializeOwnedProfileEnvironment(env, root, () => assert.fail("dotenv")));
    assert.deepEqual(env, before);
  }));
}

for (const method of [undefined, null, "", "unknown", "PLANNED", "never_registered_method"]) {
  test(`unregistered method ${String(method)} cannot activate`, () => workspace((root, vault) => {
    const env = environment(root, vault);
    env.RAG_NOTE_TITLE_METHOD = method;
    assert.throws(() => profile.captureOwnedProfile(env, root));
  }));
}

test("nonreasoning profiles cannot activate planned method", () => workspace((root, vault) => {
  for (const name of Object.keys(registry.profiles).filter((name) => name !== "qwen35")) {
    assert.throws(() => profile.captureOwnedProfile(environment(root, vault, name, "planned"), root));
  }
}));

for (const url of [
  "http://localhost:19187", "https://127.0.0.1:19187", "http://192.168.1.1:19187",
  "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:99999",
  "http://user:invalid@127.0.0.1:19187", "http://127.0.0.1:19187/?key=invalid",
  "http://127.0.0.1:19187/#", "http://127.0.0.1:19187/api", "http://2130706433:19187",
  "http://127.1:19187", "http://0x7f000001:19187", " http://127.0.0.1:19187", null,
]) {
  test(`ambiguous or external runtime URL rejects ${String(url)}`, () => workspace((root, vault) => {
    const env = environment(root, vault);
    env.RAG_LLAMA_SERVER_BASE_URL = url;
    assert.throws(() => profile.captureOwnedProfile(env, root));
  }));
}

test("explicit numeric IPv6 and default port remain valid", () => workspace((root, vault) => {
  for (const url of ["http://[::1]:19187/", "http://127.0.0.1:80"]) {
    const env = environment(root, vault);
    env.RAG_LLAMA_SERVER_BASE_URL = url;
    assert.equal(profile.captureOwnedProfile(env, root).fixed.RAG_LLAMA_SERVER_BASE_URL, url.replace(/\/$/, ""));
  }
}));

test("notes target must be exact existing directory, never file or alias", () => workspace((root, vault) => {
  const file = path.join(root, "file");
  fs.writeFileSync(file, "synthetic");
  const alias = path.join(root, "alias");
  fs.symlinkSync(vault, alias, "junction");
  for (const value of ["relative", path.join(root, "missing"), file, alias, null]) {
    const env = environment(root, vault);
    env.NOTES_DIR = value;
    assert.throws(() => profile.captureOwnedProfile(env, root));
  }
}));

test("provider and model mismatch cannot fall back to embedded loader", () => workspace((root, vault) => {
  for (const [key, value] of [
    ["RAG_RUNTIME_PROVIDER", "local"], ["RAG_LOCAL_MODEL_FORMAT", "llama_cpp"],
    ["RAG_LOCAL_MODEL_GGUF_PATH", path.join(root, "wrong.gguf")], ["GGUF_MODEL_PATH", null],
  ]) {
    const env = environment(root, vault);
    env[key] = value;
    assert.throws(() => profile.initializeOwnedProfileEnvironment(env, root, () => assert.fail("dotenv")));
  }
}));

test("capturing an owned profile is read-only before application", () => workspace((root, vault) => {
  const env = environment(root, vault);
  const before = JSON.stringify(env);
  const filenames = fs.readdirSync(root);
  const owned = profile.captureOwnedProfile(env, root);
  assert.equal(owned.notesDirectory, fs.realpathSync(vault));
  assert.equal(JSON.stringify(env), before);
  assert.deepEqual(fs.readdirSync(root), filenames);
}));

test("tampered model metadata cannot exceed the local model bound", () => workspace((root, vault) => {
  const source = fs.readFileSync(path.join(__dirname, "../frontend/owned_note_profile.js"), "utf8");
  for (const [key, value] of [
    ["nominal_size_billion", 8], ["nominal_size_billion", 12], ["nominal_size_billion", "7"],
    ["parameters", "4000000000"], ["parameters", 0],
    ["context", 1], ["sha256", "invalid"], ["model", "../outside.gguf"],
  ]) {
    const altered = JSON.parse(JSON.stringify(registry));
    altered.profiles.qwen35[key] = value;
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module, process,
      require: (id) => id === "./owned_note_profiles.json" ? altered : require(id),
    });
    assert.throws(() => module.exports.captureOwnedProfile(environment(root, vault), root));
  }
}));
