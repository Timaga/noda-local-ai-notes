"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { isPortableRuntimeReady } = require("./portable_runtime_cache");

const SETUP_TIMEOUT_MS = 45 * 60 * 1000;
const PHASES = new Set(["validation", "prerequisite", "python", "qdrant", "llama", "dependencies", "embedding", "ready"]);
const PHASE_STATUS = new Set(["started", "complete", "cached", "failed", "restart_required"]);

function portablePaths(source, localAppData) {
  if (!path.isAbsolute(localAppData || "")) throw new Error("Windows application data folder unavailable");
  const root = path.join(localAppData, "Noda", "runtime");
  return Object.freeze({
    source,
    root,
    python: path.join(root, ".venv", "Scripts", "python.exe"),
    backendPython: path.join(root, ".venv", "Scripts", "pythonw.exe"),
    qdrant: path.join(root, "bin", "qdrant.exe"),
    llama: path.join(root, "bin", "llama", "llama-server.exe"),
    provisioner: path.join(source, "scripts", "windows-portable", "provision.ps1"),
    setupChoice: path.join(root, "embedding-choice"),
  });
}

function portableEnvironment(runtime, qdrantPorts, includeEmbedding) {
  return {
    NODA_RUNTIME_HOME: runtime.root,
    NODA_RU_MMARCO_PYTHON: runtime.python,
    NODA_RU_TEV_PYTHON: runtime.python,
    NODA_MANAGED_QDRANT_EXE: runtime.qdrant,
    QDRANT_URL: `http://127.0.0.1:${qdrantPorts.http}`,
    QDRANT__SERVICE__HOST: "127.0.0.1",
    QDRANT__SERVICE__HTTP_PORT: String(qdrantPorts.http),
    QDRANT__SERVICE__GRPC_PORT: String(qdrantPorts.grpc),
    QDRANT__STORAGE__STORAGE_PATH: path.join(runtime.root, "qdrant"),
    QDRANT__STORAGE__SNAPSHOTS_PATH: path.join(runtime.root, "qdrant-snapshots"),
    QDRANT_AUTOSTART: "1",
    HF_HOME: path.join(runtime.root, "huggingface"),
    HF_HUB_CACHE: path.join(runtime.root, "huggingface", "hub"),
    RAG_LOCAL_MODEL_CACHE: path.join(runtime.root, "huggingface", "hub"),
    HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    RAG_LOCAL_MODEL_TRUST_REMOTE_CODE: "0",
    RAG_LOCAL_MODEL_FORMAT: "llama_cpp",
    GGUF_MODEL_PATH: path.join(runtime.root, "models", "ru-title-qwen35-4b-q8-v1", "Qwen3.5-4B-Q8_0.gguf"),
    USE_GGUF: "1",
    QUANTIZATION_BACKEND: "gguf",
    RAG_VLLM_AUTOSTART: "0",
    ...(typeof includeEmbedding === "boolean" && { NODA_SEMANTIC_SEARCH_ENABLED: includeEmbedding ? "1" : "0" }),
  };
}

function reserveLoopbackPort(port = 0) {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      resolve({ port: listener.address().port, release: () => new Promise((done, fail) => {
        listener.close(error => error ? fail(error) : done());
      }) });
    });
  });
}

async function selectQdrantPorts() {
  const http = await reserveLoopbackPort();
  try {
    const grpc = await reserveLoopbackPort();
    await grpc.release();
    return { http: http.port, grpc: grpc.port };
  } finally {
    await http.release();
  }
}

function provisionPortableRuntime(runtime, { includeEmbedding, installVcRuntime, onProgress, signal }) {
  const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const powershell = path.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", runtime.provisioner, "-InstallRoot", runtime.root, "-SourceRoot", runtime.source];
  if (includeEmbedding) args.push("-IncludeEmbedding");
  if (installVcRuntime) args.push("-InstallVcRuntime");
  return new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(SETUP_TIMEOUT_MS);
    const stopSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (stopSignal.aborted) {
      reject(stopSignal.reason);
      return;
    }
    const child = spawn(powershell, args, {
      cwd: runtime.source, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath")),
    });
    const stop = () => {
      if (!child.pid || child.exitCode !== null) return;
      const kill = spawn(path.join(system32, "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" });
      kill.once("error", () => child.kill());
      kill.once("exit", code => { if (code !== 0 && child.exitCode === null) child.kill(); });
    };
    stopSignal.addEventListener("abort", stop, { once: true });
    const progress = readline.createInterface({ input: child.stdout });
    let lastPhase = null;
    let lastStatus = null;
    child.stderr.resume();
    progress.on("line", line => {
      if (line.length > 4096) return;
      try {
        const record = JSON.parse(line);
        if (PHASES.has(record.phase) && PHASE_STATUS.has(record.status)) {
          lastPhase = record.phase;
          lastStatus = record.status;
          onProgress?.({ phase: record.phase, status: record.status, includeEmbedding });
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    });
    child.once("error", error => {
      stopSignal.removeEventListener("abort", stop);
      reject(error);
    });
    child.once("close", code => {
      stopSignal.removeEventListener("abort", stop);
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const requiredFiles = [runtime.python, runtime.backendPython, runtime.qdrant, runtime.llama];
      if (timeout.aborted || code !== 0 || !requiredFiles.every(file => fs.existsSync(file))) {
        reject(Object.assign(new Error("Noda dependencies could not be installed"),
          { code: lastStatus === "restart_required" ? "provision_restart_required" : "provision_failed",
            phase: lastPhase }));
      } else resolve();
    });
  });
}

function saveEmbeddingChoice(runtime, includeEmbedding) {
  const pending = `${runtime.setupChoice}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(pending, includeEmbedding ? "yes\n" : "no\n", { encoding: "utf8", flag: "wx" });
    fs.renameSync(pending, runtime.setupChoice);
  } finally {
    fs.rmSync(pending, { force: true });
  }
}

async function setupPortableRuntime(runtime, {
  approveVcRuntime, continueWithoutEmbedding, forceEmbedding, onProgress, signal,
  provision = provisionPortableRuntime,
}) {
  fs.mkdirSync(runtime.root, { recursive: true });
  let savedChoice;
  try {
    savedChoice = fs.readFileSync(runtime.setupChoice, "utf8").trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let includeEmbedding = Boolean(forceEmbedding) || savedChoice !== "no";
  let installVcRuntime = false;
  signal?.throwIfAborted();
  const ready = await isPortableRuntimeReady(runtime, includeEmbedding);
  signal?.throwIfAborted();
  if (ready) onProgress?.({ phase: "ready", status: "cached", includeEmbedding });
  for (; !ready;) {
    signal?.throwIfAborted();
    try {
      await provision(runtime, { includeEmbedding, installVcRuntime, onProgress, signal });
      break;
    } catch (error) {
      if (error.code !== "provision_failed" || signal?.aborted) throw error;
      if (error.phase === "prerequisite" && !installVcRuntime) {
        if (!await approveVcRuntime()) return null;
        installVcRuntime = true;
      } else if (error.phase === "embedding" && includeEmbedding && continueWithoutEmbedding) {
        if (!await continueWithoutEmbedding()) return null;
        includeEmbedding = false;
      } else {
        throw error;
      }
    }
  }
  const choice = includeEmbedding ? "yes" : "no";
  if (savedChoice !== choice) saveEmbeddingChoice(runtime, includeEmbedding);
  return portableEnvironment(runtime, await selectQdrantPorts(), includeEmbedding);
}

module.exports = {
  portablePaths, portableEnvironment, reserveLoopbackPort, selectQdrantPorts, setupPortableRuntime, saveEmbeddingChoice,
};
