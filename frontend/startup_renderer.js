// Who: Tim Buglaev
// When: 2026-06-15
// What: Starts the shared readiness sequence from the dedicated startup window
//       when the secure Electron bridge is present; static previews stay render-only.
function bindStartupVideo() {
  const overlay = document.getElementById("startup-overlay");
  const video = document.getElementById("startup-loader-video");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const showStaticLogo = () => video.classList.remove("is-playing");

  function syncPlayback() {
    if (!overlay.classList.contains("startup-icon-only") || reducedMotion.matches || document.hidden) {
      video.pause();
      return;
    }
    if (video.paused && !video.error) {
      video.play().catch(showStaticLogo);
    }
  }

  video.addEventListener("playing", () => video.classList.add("is-playing"));
  video.addEventListener("error", showStaticLogo);
  reducedMotion.addEventListener("change", syncPlayback);
  document.addEventListener("visibilitychange", syncPlayback);
  const observer = new MutationObserver(syncPlayback);
  observer.observe(overlay, { attributes: true, attributeFilter: ["class"] });
  syncPlayback();
}

window.addEventListener("DOMContentLoaded", async () => {
  bindStartupVideo();
  if (!window.startupGate || typeof window.startupGate.waitForReady !== "function") {
    return;
  }
  if (!window.quickNoteBridge || typeof window.quickNoteBridge.ensureBackendReady !== "function") {
    return;
  }
  // Who: Tim Buglaev
  // When: 2026-06-30
  // What: Confirm the initial loading UI is mounted before main may replace it
  //       with the optional interactive notes-directory selection step.
  if (typeof window.quickNoteBridge.notifyStartupRendererReady === "function") {
    await window.quickNoteBridge.notifyStartupRendererReady().catch(() => {});
  }
  window.startupGate.waitForReady().catch(() => {});
});
