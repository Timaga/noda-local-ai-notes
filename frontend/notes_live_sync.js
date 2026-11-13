(function (root) {
  "use strict";

  function create({ refresh, isVisible = () => true, intervalMs = 1500,
    maxIntervalMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout,
    onError = () => {} } = {}) {
    if (typeof refresh !== "function" || typeof isVisible !== "function"
        || typeof setTimer !== "function" || typeof clearTimer !== "function"
        || typeof onError !== "function" || !Number.isSafeInteger(intervalMs)
        || intervalMs < 1 || !Number.isSafeInteger(maxIntervalMs)
        || maxIntervalMs < intervalMs || maxIntervalMs > 2147483647) {
      throw new TypeError("Invalid live notes scheduler options");
    }
    let started = false, paused = false, disposed = false;
    let timer = null, running = null, pendingWake = false;
    let epoch = 0, requestId = 0, failures = 0;

    const canAutoRefresh = () => started && !paused && !disposed && isVisible();
    const retryDelay = () => Math.min(maxIntervalMs, intervalMs * 2 ** Math.min(failures, 30));

    function clearScheduled() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    }

    function schedule(delay) {
      clearScheduled();
      if (!canAutoRefresh()) return;
      const scheduledEpoch = epoch;
      const handle = setTimer(() => {
        if (timer !== handle) return;
        timer = null;
        if (scheduledEpoch === epoch && canAutoRefresh()) return backgroundRefresh();
      }, delay);
      timer = handle;
      timer?.unref?.();
    }

    function run(background) {
      if (disposed) return Promise.resolve(false);
      if (running) return running;
      clearScheduled();
      const currentEpoch = epoch, currentRequest = ++requestId;
      const context = {
        background,
        isCurrent: () => !disposed && currentEpoch === epoch && currentRequest === requestId
          && (!background || canAutoRefresh()),
      };
      const operation = Promise.resolve().then(() => refresh(context)).then(
        value => {
          if (context.isCurrent()) failures = 0;
          return value;
        },
        error => {
          if (context.isCurrent()) {
            failures = Math.min(failures + 1, 30);
            if (background) onError(error);
          }
          throw error;
        },
      ).finally(() => {
        running = null;
        if (!canAutoRefresh()) {
          pendingWake = false;
          return;
        }
        const delay = pendingWake ? 0 : retryDelay();
        pendingWake = false;
        schedule(delay);
      });
      running = operation;
      return operation;
    }

    function backgroundRefresh() {
      const operation = run(true);
      // Background failures are reported through onError; callers may still await the rejection.
      operation.catch(() => {});
      return operation;
    }

    function start() {
      if (disposed || started) return;
      started = true;
      paused = false;
      if (!running) schedule(intervalMs);
    }

    function wake() {
      if (!started || disposed || !isVisible()) return Promise.resolve(false);
      paused = false;
      clearScheduled();
      if (running) {
        pendingWake = true;
        return running;
      }
      return backgroundRefresh();
    }

    function pause() {
      paused = true;
      epoch += 1;
      pendingWake = false;
      clearScheduled();
    }

    function dispose() {
      disposed = true;
      pause();
    }

    return {
      refresh: () => run(false), start, wake, pause, dispose,
      getState: () => ({ started, paused, disposed, running: Boolean(running), failures }),
    };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NotesLiveSync = api;
})(typeof window === "undefined" ? globalThis : window);
