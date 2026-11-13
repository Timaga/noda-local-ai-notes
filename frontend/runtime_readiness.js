// Who: Tim Buglaev
// When: 2026-06-21
// What: Added bounded managed-runtime readiness and safe WSL cache-path helpers;
//       cold loads may run long, child exits fail immediately, HTTP probes stay
//       time-limited, and Windows model downloads can be reused inside WSL.
const os = require("os");
const path = require("path");

function windowsPathToWslPath(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z]:[\\/]/.test(normalized) || /[\x00-\x1f]/.test(normalized)) {
    return null;
  }
  const drive = normalized[0].toLowerCase();
  const remainder = normalized.slice(2).replace(/\\/g, "/").replace(/^\/+/, "");
  return `/mnt/${drive}/${remainder}`.replace(/\/+$/, "");
}

function resolveWslHfHome(env = process.env, homeDir = os.homedir()) {
  const configured = String(env.RAG_VLLM_WSL_HF_HOME || "").trim();
  if (configured) {
    if (!configured.startsWith("/") || /[\x00-\x1f]/.test(configured)) {
      throw new Error("RAG_VLLM_WSL_HF_HOME must be an absolute WSL path without control characters.");
    }
    return configured.replace(/\/+$/, "");
  }
  return windowsPathToWslPath(env.HF_HOME || path.join(homeDir, ".cache", "huggingface"));
}
function formatDuration(milliseconds, language = "ru") {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (language === "en") return minutes > 0 ? `${minutes} min ${seconds} s` : `${seconds} s`;
  return minutes > 0 ? `${minutes} мин ${seconds} с` : `${seconds} с`;
}

function describeProcessFailure(failure) {
  if (!failure) {
    return null;
  }
  const code = failure.code === null || failure.code === undefined ? "unknown" : String(failure.code);
  const signal = failure.signal ? `, signal=${failure.signal}` : "";
  const reason = failure.reason ? `: ${failure.reason}` : "";
  return `Managed vLLM runtime exited before readiness (code=${code}${signal})${reason}`;
}

async function waitForRuntimeEndpoint(options) {
  const {
    modelsUrl,
    fetchWithTimeout,
    delay,
    getProcessFailure = () => null,
    isQuitting = () => false,
    onProgress = () => {},
    timeoutMs,
    delayMs,
    probeTimeoutMs,
    progressIntervalMs,
    now = () => Date.now(),
  } = options || {};

  if (!modelsUrl || typeof fetchWithTimeout !== "function" || typeof delay !== "function") {
    throw new TypeError("Managed runtime readiness options are incomplete.");
  }
  if (![timeoutMs, delayMs, probeTimeoutMs, progressIntervalMs].every((value) => Number(value) > 0)) {
    throw new TypeError("Managed runtime readiness limits must be positive numbers.");
  }

  const startedAt = now();
  let nextProgressAt = startedAt;
  let lastProbeReason = "endpoint has not responded yet";

  while (now() - startedAt < timeoutMs) {
    if (isQuitting()) {
      const shutdownError = new Error("Application is shutting down.");
      shutdownError.code = "APP_SHUTTING_DOWN";
      throw shutdownError;
    }

    const processFailure = getProcessFailure();
    if (processFailure) {
      const processError = new Error(describeProcessFailure(processFailure));
      processError.code = "MANAGED_RUNTIME_EXITED";
      processError.details = processFailure;
      throw processError;
    }

    const currentTime = now();
    if (currentTime >= nextProgressAt) {
      onProgress({ elapsedMs: currentTime - startedAt, timeoutMs, lastProbeReason });
      nextProgressAt = currentTime + progressIntervalMs;
    }

    try {
      const response = await fetchWithTimeout(modelsUrl, {}, probeTimeoutMs);
      if (response?.ok) {
        return { elapsedMs: now() - startedAt };
      }
      lastProbeReason = `HTTP ${response?.status || "unknown"}`;
    } catch (error) {
      lastProbeReason = error?.name === "AbortError" ? "probe timed out" : String(error?.message || error);
    }

    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs > 0) {
      await delay(Math.min(delayMs, remainingMs));
    }
  }

  const timeoutError = new Error(
    `Managed vLLM runtime did not become ready in ${formatDuration(timeoutMs)} (${lastProbeReason}).`
  );
  timeoutError.code = "MANAGED_RUNTIME_TIMEOUT";
  throw timeoutError;
}

module.exports = {
  formatDuration,
  resolveWslHfHome,
  waitForRuntimeEndpoint,
  windowsPathToWslPath,
};
