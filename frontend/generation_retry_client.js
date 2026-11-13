(function (root) {
  "use strict";

  const error = (code) => Object.assign(new Error(code), { code });
  const transport = (failure) => failure?.code === "transport_error" && !Number.isFinite(failure.status);

  function create({ request, newId, getVault, getJob, applyJob, refresh }) {
    const pending = new Map(), running = new Map();
    const key = (value) => String(value || "").replaceAll("-", "").toLowerCase();

    function observeJob(job) {
      const context = pending.get(job.job_id);
      if (context && getVault() === context.vault
          && key(job.recovery_summary?.request_id) === key(context.id)) pending.delete(job.job_id);
    }

    function retry(id) {
      if (running.has(id)) return running.get(id);
      const job = getJob(id), vault = getVault();
      if (!job || typeof vault !== "string" || !vault) return Promise.reject(error("retry_not_allowed"));
      let context = pending.get(id);
      if (context && context.vault !== vault) {
        pending.delete(id);
        return Promise.reject(error("vault_changed"));
      }
      if (!context) {
        if (job.retry_available !== true) return Promise.reject(error("retry_not_allowed"));
        if (pending.size >= 100) return Promise.reject(error("submission_busy"));
        context = { id: newId(), vault };
        pending.set(id, context);
      }
      const observedJob = job;
      const promise = (async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const payload = await request(`/generate/jobs/${encodeURIComponent(id)}/retry`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ client_request_id: context.id, expected_vault_id: context.vault }),
            });
            if (getVault() !== context.vault || payload?.vault_id !== context.vault) throw error("vault_changed");
            if (!payload.job || payload.job.job_id !== id
                || !["queued", "processing", "completed", "failed"].includes(payload.job.status)) {
              throw error("schema_error");
            }
            applyJob(payload.job, observedJob, payload.queue);
            pending.delete(id);
            return { ...payload.job, ...getJob(id) };
          } catch (failure) {
            if (attempt === 0 && transport(failure)) continue;
            if (failure.code === "vault_changed"
                || (Number.isFinite(failure.status) && failure.status >= 400 && failure.status < 500)) {
              pending.delete(id);
            }
            await refresh().catch(() => {});
            throw failure;
          }
        }
      })().finally(() => running.delete(id));
      running.set(id, promise);
      return promise;
    }

    return { retry, observeJob };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GenerationRetryClient = api;
})(typeof window === "undefined" ? globalThis : window);
