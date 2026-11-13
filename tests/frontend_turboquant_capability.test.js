// Who: Tim Buglaev
// When: 2026-07-02
// What: Cover TurboQuant compatibility for GGUF, missing/old/non-NVIDIA GPUs,
//       insufficient VRAM, and a supported CUDA/vLLM configuration.
const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluateTurboQuantCapability } = require("../frontend/turboquant_capability");

const vllmRuntime = { provider: "vllm_local" };
const vllmModel = {
  artifact: "hf",
  min_memory_gb: 8,
  gpu_memory_utilization: 0.85,
};
const supportedHardware = {
  gpuName: "NVIDIA GeForce RTX 3060",
  gpuVendor: "nvidia",
  gpuMemoryGb: 12,
  computeCapability: 8.6,
};

test("TurboQuant is unavailable for GGUF even on supported NVIDIA hardware", () => {
  const result = evaluateTurboQuantCapability({
    runtime: { provider: "local" },
    model: { artifact: "gguf" },
    hardware: supportedHardware,
  });
  assert.equal(result.supported, false);
  assert.equal(result.code, "runtime_not_vllm");
});

test("TurboQuant fails closed for non-NVIDIA and unverifiable GPUs", () => {
  const amd = evaluateTurboQuantCapability({
    runtime: vllmRuntime,
    model: vllmModel,
    hardware: { gpuName: "AMD Radeon", gpuVendor: "amd", gpuMemoryGb: 16, computeCapability: null },
  });
  const unknownCompute = evaluateTurboQuantCapability({
    runtime: vllmRuntime,
    model: vllmModel,
    hardware: { gpuName: "NVIDIA GPU", gpuVendor: "nvidia", gpuMemoryGb: 12, computeCapability: null },
  });
  assert.equal(amd.code, "nvidia_required");
  assert.equal(unknownCompute.code, "compute_unknown");
});

test("TurboQuant rejects old compute capability and insufficient model VRAM", () => {
  const oldGpu = evaluateTurboQuantCapability({
    runtime: vllmRuntime,
    model: vllmModel,
    hardware: { ...supportedHardware, computeCapability: 7.0 },
  });
  const lowVram = evaluateTurboQuantCapability({
    runtime: vllmRuntime,
    model: vllmModel,
    hardware: { ...supportedHardware, gpuMemoryGb: 8 },
  });
  assert.equal(oldGpu.code, "compute_unsupported");
  assert.equal(lowVram.code, "model_does_not_fit");
});

test("TurboQuant accepts a fitting CUDA 7.5+ vLLM configuration", () => {
  const result = evaluateTurboQuantCapability({
    runtime: vllmRuntime,
    model: vllmModel,
    hardware: supportedHardware,
  });
  assert.equal(result.supported, true);
  assert.equal(result.code, "supported");
  assert.match(result.reason, /RTX 3060/);
});
