// Who: Tim Buglaev
// When: 2026-06-24
// What: Verify hardware normalization and model-fit decisions for comfortable,
//       borderline, insufficient, and unknown VRAM configurations.
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildHardwareProfile,
  parseMemoryGb,
  parseNvidiaSmiOutput,
} = require("../frontend/hardware_profile");
const { evaluate } = require("../frontend/model_compatibility");

test("hardware profile normalizes system RAM and GPU memory units", () => {
  const profile = buildHardwareProfile(64 * (1024 ** 3), {
    auxAttributes: { videoMemory: "12227 MB", gl_renderer: "RTX test GPU" },
  });
  assert.deepEqual(profile, {
    ramGb: 64,
    gpuMemoryGb: 11.9,
    gpuName: "RTX test GPU",
    gpuVendor: "",
  });
  assert.equal(parseMemoryGb(8 * (1024 ** 3)), 8);
});

// Who: Tim Buglaev
// When: 2026-07-02
// What: Verify strict nvidia-smi parsing, malformed-output rejection, runtime-visible
//       multi-GPU selection, and trusted metadata overriding incomplete Electron data.
test("nvidia-smi profile selects the runtime-visible GPU", () => {
  const result = parseNvidiaSmiOutput([
    "broken, GPU-bad, Malformed GPU, unknown, 8.6",
    "0, GPU-old, NVIDIA RTX 2080, 8192, 7.5",
    "1, GPU-new, NVIDIA RTX 3060, 12288, 8.6",
  ].join("\n"), "1");
  assert.deepEqual(result, {
    gpuName: "NVIDIA RTX 3060",
    gpuVendor: "nvidia",
    gpuMemoryGb: 12,
    computeCapability: 8.6,
  });
  assert.equal(parseNvidiaSmiOutput("broken"), null);
  assert.equal(parseNvidiaSmiOutput("0, GPU-a, NVIDIA GPU, 8192, 8.6", "4"), null);
});

test("verified NVIDIA metadata overrides incomplete Electron GPU data", () => {
  const profile = buildHardwareProfile(
    16 * (1024 ** 3),
    { gpuDevice: [{ active: true, deviceString: "Generic adapter" }] },
    {
      gpuName: "NVIDIA RTX 4070",
      gpuVendor: "nvidia",
      gpuMemoryGb: 12,
      computeCapability: 8.9,
    }
  );
  assert.equal(profile.gpuName, "NVIDIA RTX 4070");
  assert.equal(profile.gpuVendor, "nvidia");
  assert.equal(profile.computeCapability, 8.9);
});

test("compatibility uses structured RAM and VRAM requirements", () => {
  const hardware = { ramGb: 64, gpuMemoryGb: 12 };
  assert.equal(evaluate({
    memory_type: "ram",
    min_memory_gb: 12,
    recommended_memory_gb: 16,
  }, hardware).level, "fit");
  assert.equal(evaluate({
    memory_type: "vram",
    min_memory_gb: 8,
    recommended_memory_gb: 12,
    gpu_memory_utilization: 0.82,
  }, hardware).level, "edge");
  assert.equal(evaluate({
    memory_type: "vram",
    min_memory_gb: 24,
    recommended_memory_gb: 32,
    gpu_memory_utilization: 0.86,
  }, hardware).level, "hard");
});

test("missing VRAM produces an explicit borderline result instead of a false fit", () => {
  const result = evaluate({
    memory_type: "vram",
    min_memory_gb: 8,
    recommended_memory_gb: 12,
  }, { ramGb: 32, gpuMemoryGb: null });
  assert.equal(result.level, "edge");
  assert.match(result.detail, /не удалось определить/);
});
