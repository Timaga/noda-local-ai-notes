// Who: Tim Buglaev
// When: 2026-06-21
// What: Added behavior-level regression coverage for long managed-runtime startup,
//       child-process failures, bounded timeout handling, and safe shared HF cache paths.
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveWslHfHome,
  waitForRuntimeEndpoint,
  windowsPathToWslPath,
} = require("../frontend/runtime_readiness");

function createClock() {
  let current = 0;
  return {
    now: () => current,
    delay: async (milliseconds) => {
      current += milliseconds;
    },
  };
}

// Who: Tim Buglaev
// When: 2026-06-21
// What: Verify transient connection failures remain retryable until the local model
//       endpoint becomes ready, while progress receives deterministic elapsed time.
test("waitForRuntimeEndpoint tolerates a cold start and returns on readiness", async () => {
  const clock = createClock();
  const progress = [];
  let calls = 0;
  const result = await waitForRuntimeEndpoint({
    modelsUrl: "http://127.0.0.1:8000/v1/models",
    fetchWithTimeout: async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("connection refused");
      }
      return { ok: true, status: 200 };
    },
    delay: clock.delay,
    now: clock.now,
    timeoutMs: 10000,
    delayMs: 1000,
    probeTimeoutMs: 500,
    progressIntervalMs: 1000,
    onProgress: (entry) => progress.push(entry.elapsedMs),
  });

  assert.equal(calls, 3);
  assert.equal(result.elapsedMs, 2000);
  assert.deepEqual(progress, [0, 1000, 2000]);
});

// Who: Tim Buglaev
// When: 2026-06-21
// What: Ensure a crashed WSL child aborts readiness before another network probe or
//       the long cold-start deadline, preserving the process exit diagnostics.
test("waitForRuntimeEndpoint fails immediately after managed child exit", async () => {
  const clock = createClock();
  let probes = 0;
  await assert.rejects(
    waitForRuntimeEndpoint({
      modelsUrl: "http://127.0.0.1:8000/v1/models",
      fetchWithTimeout: async () => {
        probes += 1;
        throw new Error("connection refused");
      },
      delay: clock.delay,
      now: clock.now,
      timeoutMs: 30000,
      delayMs: 1000,
      probeTimeoutMs: 500,
      progressIntervalMs: 5000,
      getProcessFailure: () => (clock.now() >= 1000 ? { code: 1, signal: null, reason: "load failed" } : null),
    }),
    (error) => error.code === "MANAGED_RUNTIME_EXITED" && error.details.code === 1
  );
  assert.equal(probes, 1);
});

// Who: Tim Buglaev
// When: 2026-06-21
// What: Confirm permanently unavailable endpoints stop exactly at the configured
//       deadline instead of creating an unbounded launcher wait or retry loop.
test("waitForRuntimeEndpoint applies a bounded deadline", async () => {
  const clock = createClock();
  let probes = 0;
  await assert.rejects(
    waitForRuntimeEndpoint({
      modelsUrl: "http://127.0.0.1:8000/v1/models",
      fetchWithTimeout: async () => {
        probes += 1;
        return { ok: false, status: 503 };
      },
      delay: clock.delay,
      now: clock.now,
      timeoutMs: 2500,
      delayMs: 1000,
      probeTimeoutMs: 500,
      progressIntervalMs: 1000,
    }),
    (error) => error.code === "MANAGED_RUNTIME_TIMEOUT" && /HTTP 503/.test(error.message)
  );
  assert.equal(clock.now(), 2500);
  assert.equal(probes, 3);
});

// Who: Tim Buglaev
// When: 2026-06-21
// What: Cover cache path normalization and rejection of shell-control input so WSL
//       receives only an absolute path derived from trusted local configuration.
test("shared Hugging Face cache path is normalized safely for WSL", () => {
  assert.equal(
    windowsPathToWslPath("C:\\Users\\ExampleUser\\.cache\\huggingface\\"),
    "/mnt/c/Users/ExampleUser/.cache/huggingface"
  );
  assert.equal(resolveWslHfHome({}, "F:\\profiles\\user"), "/mnt/f/profiles/user/.cache/huggingface");
  assert.equal(resolveWslHfHome({ RAG_VLLM_WSL_HF_HOME: "/srv/hf/" }, "C:\\ignored"), "/srv/hf");
  assert.equal(windowsPathToWslPath("../relative"), null);
  assert.throws(
    () => resolveWslHfHome({ RAG_VLLM_WSL_HF_HOME: "relative/path" }, "C:\\ignored"),
    /absolute WSL path/
  );
});
