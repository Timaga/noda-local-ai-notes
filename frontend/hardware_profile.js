// Who: Tim Buglaev
// When: 2026-07-02
// What: Normalize Electron GPU data and bounded nvidia-smi output into a minimal
//       profile, honoring the runtime-visible GPU; fixed arguments, timeout, and
//       output limits prevent shell injection and unbounded hardware probes.
const { execFile } = require("child_process");

const NVIDIA_SMI_TIMEOUT_MS = 3000;
const NVIDIA_SMI_MAX_BUFFER_BYTES = 16 * 1024;

function parseMemoryGb(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "string") {
    const match = value.trim().match(/([\d.]+)\s*(GB|MB|KB|BYTES?)?/i);
    if (!match) {
      return null;
    }
    const amount = Number(match[1]);
    const unit = String(match[2] || "").toUpperCase();
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }
    if (unit === "GB") return amount;
    if (unit === "MB") return amount / 1024;
    if (unit === "KB") return amount / (1024 * 1024);
    if (unit.startsWith("BYTE")) return amount / (1024 ** 3);
    value = amount;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  if (numeric >= 1024 ** 3) return numeric / (1024 ** 3);
  if (numeric >= 256) return numeric / 1024;
  return numeric;
}

function extractGpuProfile(gpuInfo) {
  const info = gpuInfo && typeof gpuInfo === "object" ? gpuInfo : {};
  const attributes = info.auxAttributes && typeof info.auxAttributes === "object"
    ? info.auxAttributes
    : {};
  const devices = Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
  const activeDevice = devices.find((device) => device?.active) || devices[0] || {};
  const memoryCandidates = [
    info.videoMemory,
    attributes.videoMemory,
    attributes.video_memory,
    activeDevice.videoMemory,
    activeDevice.memorySize,
    activeDevice.dedicatedVideoMemory,
  ];
  const memoryGb = memoryCandidates.map(parseMemoryGb).find((value) => Number.isFinite(value)) || null;
  const name = String(
    activeDevice.deviceString
      || activeDevice.name
      || attributes.gl_renderer
      || attributes.glRenderer
      || ""
  ).trim();
  return {
    gpuMemoryGb: memoryGb ? Math.round(memoryGb * 10) / 10 : null,
    gpuName: name.slice(0, 160),
    gpuVendor: /nvidia/i.test(name) ? "nvidia" : /amd|radeon/i.test(name) ? "amd" : "",
  };
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Parse only the fixed CSV schema, honor the runtime-visible GPU, and reject
//       malformed or unmatched devices instead of guessing compatibility.
function parseNvidiaSmiOutput(output, visibleDevices = "") {
  const candidates = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(",").map((part) => part.trim());
      const index = Number(parts[0]);
      const memoryMb = Number(parts[3]);
      const computeCapability = Number(parts[4]);
      if (!Number.isInteger(index) || index < 0 || !parts[1] || !parts[2]
        || !Number.isFinite(memoryMb) || memoryMb <= 0
        || !Number.isFinite(computeCapability) || computeCapability <= 0) {
        return null;
      }
      return {
        index,
        uuid: parts[1],
        gpuName: parts[2].slice(0, 160),
        gpuVendor: "nvidia",
        gpuMemoryGb: Math.round((memoryMb / 1024) * 10) / 10,
        computeCapability: Math.round(computeCapability * 10) / 10,
      };
    })
    .filter(Boolean);
  const requestedDevice = String(visibleDevices || "").split(",")[0].trim();
  const selected = requestedDevice
    ? candidates.find((candidate) => (
      String(candidate.index) === requestedDevice || candidate.uuid === requestedDevice
    ))
    : candidates.sort((left, right) => left.index - right.index)[0];
  if (!selected) {
    return null;
  }
  const { index: _index, uuid: _uuid, ...profile } = selected;
  return profile;
}

// Who: Tim Buglaev
// When: 2026-07-02
// What: Probe nvidia-smi without a shell under strict timeout/output limits and
//       return null when driver metadata cannot be verified.
function detectNvidiaGpu() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=index,uuid,name,memory.total,compute_cap", "--format=csv,noheader,nounits"],
      {
        windowsHide: true,
        timeout: NVIDIA_SMI_TIMEOUT_MS,
        maxBuffer: NVIDIA_SMI_MAX_BUFFER_BYTES,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(parseNvidiaSmiOutput(stdout, process.env.CUDA_VISIBLE_DEVICES));
      }
    );
  });
}

function buildHardwareProfile(totalMemoryBytes, gpuInfo, nvidiaProfile = null) {
  const ramBytes = Number(totalMemoryBytes);
  const ramGb = Number.isFinite(ramBytes) && ramBytes > 0
    ? Math.round((ramBytes / (1024 ** 3)) * 10) / 10
    : null;
  const electronGpu = extractGpuProfile(gpuInfo);
  return {
    ramGb,
    ...electronGpu,
    ...(nvidiaProfile || {}),
  };
}

module.exports = {
  buildHardwareProfile,
  detectNvidiaGpu,
  extractGpuProfile,
  parseNvidiaSmiOutput,
  parseMemoryGb,
};
