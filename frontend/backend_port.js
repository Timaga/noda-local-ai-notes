"use strict";

async function waitForBackendPortRelease({ port, reserve, delay, timeoutMs = 5000, intervalMs = 100 }) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    let reservation;
    try {
      reservation = await reserve(port);
    } catch (cause) {
      if (!["EADDRINUSE", "EACCES"].includes(cause.code)) throw cause;
      if (attempt === attempts) {
        throw Object.assign(new Error("Local API port was not released"), { code: "backend_port_busy" });
      }
      await delay(intervalMs);
      continue;
    }
    await reservation.release();
    return;
  }
}

module.exports = { waitForBackendPortRelease };
