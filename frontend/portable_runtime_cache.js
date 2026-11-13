"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const PACKAGES = ["flask", "llama_cpp", "onnxruntime", "qdrant_client", "sentencepiece",
  "sentence_transformers", "torch", "watchdog"];
const hashText = text => createHash("sha256").update(text).digest("hex").toUpperCase();

async function matchesFile(file, hash, bytes) {
  if (!/^[a-f0-9]{64}$/i.test(hash || "")) return false;
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || (bytes !== undefined && stat.size !== bytes)) return false;
  const digest = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest("hex").toUpperCase() === hash.toUpperCase();
}

function hasFiles(files) {
  return files.every(file => fs.statSync(file).isFile());
}

function embeddingReady(runtime, scripts) {
  const profile = JSON.parse(fs.readFileSync(path.join(scripts, "embedding-profile.json"), "utf8"));
  if (profile?.schema !== "noda-embedding-profile-v1" || !/^[\w.-]+\/[\w.-]+$/.test(profile.repository || "")
      || !/^[a-f0-9]{40}$/.test(profile.revision || "") || !/^[a-f0-9]{64}$/.test(profile.weightsHash || "")
      || !Number.isSafeInteger(profile.weightsBytes) || profile.weightsBytes <= 0
      || !Array.isArray(profile.files) || !profile.files.includes("model.safetensors")
      || !profile.files.every(file => typeof file === "string" && /^[\w.-]+(?:\/[\w.-]+)*$/.test(file)
        && file.split("/").every(part => part !== "." && part !== ".."))) return false;
  const repository = path.join(runtime.root, "huggingface", "hub", `models--${profile.repository.replace("/", "--")}`);
  const folder = path.join(repository, "snapshots", profile.revision);
  if (!hasFiles(profile.files.map(file => path.join(folder, file)))
      || fs.readFileSync(path.join(repository, "refs", "main"), "ascii").trim() !== profile.revision) return false;
  const weights = fs.statSync(path.join(folder, "model.safetensors"), { bigint: true });
  const stamp = fs.readFileSync(path.join(folder, ".noda-verified"), "ascii");
  const expected = `["${profile.weightsHash}", ${profile.weightsBytes}, ${weights.mtimeNs}]`;
  return weights.size === BigInt(profile.weightsBytes) && stamp === expected;
}

async function isPortableRuntimeReady(runtime, includeEmbedding) {
  try {
    const scripts = path.join(runtime.source, "scripts", "windows-portable");
    const receipt = JSON.parse(fs.readFileSync(path.join(runtime.root, "core-ready.json"), "utf8").replace(/^\uFEFF/, ""));
    if (receipt?.schema !== "noda-windows-runtime-v1") return false;
    const assetsText = fs.readFileSync(path.join(scripts, "runtime-assets.json"), "utf8");
    const llamaText = fs.readFileSync(path.join(scripts, "llama-cpu-assets.json"), "utf8");
    const lock = fs.readFileSync(path.join(scripts, "requirements-win-x64.lock"), "utf8");
    if (receipt.assets !== hashText(assetsText) || receipt.llama !== hashText(llamaText)
        || receipt.wheels !== hashText(lock)) return false;
    const assets = JSON.parse(assetsText);
    const llama = JSON.parse(llamaText);
    if (assets?.schema !== receipt.schema || !/^[a-z0-9][a-z0-9.-]*$/i.test(assets.python?.version || "")
        || llama?.schema !== "noda-portable-llama-cpu-v1" || llama.tag !== assets.llama?.version
        || !Array.isArray(llama.files) || !llama.files.length
        || !llama.files.some(file => file.path === "llama-server.exe")
        || !llama.files.every(file => /^[\w-]+(?:\.[\w-]+)*$/.test(file.path || "")
          && Number.isSafeInteger(file.bytes) && file.bytes > 0)) return false;
    const pythonHome = path.join(runtime.root, `python-${assets.python.version}`);
    const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
    if (!hasFiles([runtime.python, runtime.backendPython, path.join(pythonHome, "pythonw.exe"),
      ...["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"].map(file => path.join(system32, file)),
      ...PACKAGES.map(name => path.join(runtime.root, ".venv", "Lib", "site-packages", name, "__init__.py"))])) return false;
    if (!await matchesFile(path.join(pythonHome, "python.exe"), assets.python.executableSha256)
        || !await matchesFile(runtime.qdrant, assets.qdrant?.executableSha256)) return false;
    for (const file of llama.files) {
      if (!await matchesFile(path.join(runtime.root, "bin", "llama", file.path), file.sha256, file.bytes)) return false;
    }
    return !includeEmbedding || embeddingReady(runtime, scripts);
  } catch (error) {
    if (error instanceof SyntaxError || ["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
}

module.exports = { isPortableRuntimeReady };
