"use strict";

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const registry = require("./owned_note_profiles.json");

const PROFILE_MARKER = "NODA_OWNED_TITLE_PROFILE";
const PROFILES = Object.freeze(Object.fromEntries(Object.entries(registry.profiles)
  .map(([name, profile]) => [name, Object.freeze({ ...profile })])));

function comparable(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function localUrl(value) {
  if (typeof value !== "string" || value !== value.trim()) throw new Error("Invalid owned runtime URL");
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error("Invalid owned runtime URL"); }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const authority = value.match(/^http:\/\/(\[[a-fA-F0-9:]+\]|[0-9.]+):([0-9]{1,5})\/?$/);
  const rawHost = authority?.[1].replace(/^\[|\]$/g, "");
  const port = Number(authority?.[2]);
  const version = net.isIP(host);
  const loopback = version === 4 ? host.split(".")[0] === "127" : version === 6 && host === "::1";
  if (parsed.protocol !== "http:" || !loopback || !authority || !net.isIP(rawHost || "")
      || !Number.isInteger(port) || port < 1 || port > 65535 || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Explicit numeric loopback runtime URL required");
  }
  return `http://${parsed.hostname}:${port}`;
}

function existingDirectory(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0")
      || !path.isAbsolute(value)) throw new Error("Explicit absolute notes directory required");
  let stat;
  try { stat = fs.lstatSync(value); } catch (_) { throw new Error("Existing notes directory required"); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Existing notes directory required");
  const resolved = fs.realpathSync(value);
  if (comparable(value) !== comparable(resolved)) throw new Error("Canonical notes directory required");
  return resolved;
}

function captureOwnedProfile(environment, projectRoot) {
  if (!Object.hasOwn(environment, PROFILE_MARKER)) return null;
  const name = environment[PROFILE_MARKER];
  if (typeof name !== "string" || !Object.hasOwn(PROFILES, name)) throw new Error("Unknown owned title profile");
  const selected = PROFILES[name];
  if (registry.version !== 1 || !Number.isSafeInteger(selected.parameters) || selected.parameters <= 0
      || !Number.isSafeInteger(selected.nominal_size_billion) || selected.nominal_size_billion < 1
      || selected.nominal_size_billion > 7 || !Number.isSafeInteger(selected.context)
      || selected.context < 128 || !/^[a-f0-9]{64}$/.test(selected.sha256)
      || !/^models\//.test(selected.model) || selected.model.includes("..")) {
    throw new Error("Invalid owned profile registry");
  }
  const method = environment.RAG_NOTE_TITLE_METHOD;
  if (typeof method !== "string" || !Object.hasOwn(registry.methods, method)
      || (method === "planned" && name !== "qwen35")) {
    throw new Error("Unsupported owned title method");
  }
  const model = path.resolve(projectRoot, selected.model);
  const modelStat = fs.lstatSync(model);
  if (!modelStat.isFile() || modelStat.isSymbolicLink()
      || comparable(fs.realpathSync(model)) !== comparable(model)) throw new Error("Pinned model file required");
  const notesDirectory = existingDirectory(environment.NOTES_DIR);
  const baseUrl = localUrl(environment.RAG_LLAMA_SERVER_BASE_URL);
  const fixed = Object.freeze({
    NODA_OWNED_TITLE_PROFILE: name,
    NOTES_DIR: notesDirectory,
    PYTHON_DOTENV_DISABLED: "1",
    ALLOW_MODEL_DOWNLOADS: "0",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    RAG_RUNTIME_PROVIDER: "llama_cpp_server",
    RAG_LOCAL_MODEL_FORMAT: "llama_cpp_server",
    RAG_LOCAL_MODEL_NAME: selected.alias,
    RAG_LOCAL_MODEL_ID: model,
    RAG_LOCAL_MODEL_GGUF_PATH: model,
    GGUF_MODEL_PATH: model,
    GGUF_FILENAME: path.basename(model),
    RAG_LOCAL_MODEL_CONTEXT_SIZE: String(selected.context),
    GGUF_N_CTX: String(selected.context),
    LLAMA_CPP_CTX_MAX: String(selected.context),
    USE_GGUF: "true",
    QUANTIZATION_BACKEND: "gguf",
    RAG_LOCAL_MODEL_QUANTIZATION: "none",
    RAG_LOCAL_MODEL_MAX_NEW_TOKENS: "1024",
    RAG_LOCAL_MODEL_TEMPERATURE: "0.0",
    RAG_LOCAL_MODEL_TOP_P: "1.0",
    RAG_LLAMA_SERVER_BASE_URL: baseUrl,
    RAG_LLAMA_SERVER_TIMEOUT_SECONDS: "120.0",
    RAG_NOTE_TITLE_METHOD: method,
    RAG_MODEL_SELECTION_ON_STARTUP: "false",
    RAG_VLLM_AUTOSTART: "false",
    RAG_STOP_LEGACY_DOCKER_CONTAINERS: "false",
    RAG_VLLM_WSL_TERMINATE_ON_EXIT: "false",
  });
  for (const key of ["RAG_LOCAL_MODEL_GGUF_PATH", "RAG_LOCAL_MODEL_ID", "GGUF_MODEL_PATH"]) {
    if (typeof environment[key] !== "string" || comparable(environment[key]) !== comparable(model)) {
      throw new Error("Owned model path differs from registry");
    }
  }
  if (environment.RAG_RUNTIME_PROVIDER !== fixed.RAG_RUNTIME_PROVIDER
      || environment.RAG_LOCAL_MODEL_FORMAT !== fixed.RAG_LOCAL_MODEL_FORMAT) {
    throw new Error("Owned provider differs from profile");
  }
  return Object.freeze({ profile: name, method, notesDirectory, fixed });
}

function initializeOwnedProfileEnvironment(environment, projectRoot, loadOrdinaryEnv) {
  const owned = captureOwnedProfile(environment, projectRoot);
  if (!owned) loadOrdinaryEnv();
  else Object.assign(environment, owned.fixed);
  return owned;
}

function applyOwnedProfileSettings(owned, settings, environment) {
  if (!owned) return settings;
  Object.assign(environment, owned.fixed);
  return {
    ...settings, notesDirectory: owned.notesDirectory,
    skipModelSelection: true, skipNotesDirectorySelection: true, skipTurboQuantSelection: true,
  };
}

function assertProfileMutable(owned) {
  if (owned) throw new Error("Для смены модели или настроек завершите текущий запуск профиля.");
}

module.exports = {
  captureOwnedProfile, initializeOwnedProfileEnvironment, applyOwnedProfileSettings, assertProfileMutable,
};
