(function (root) {
  "use strict";
  const ID = /^[a-f0-9]{32}$/;
  const STATUS = new Set(["ready", "switching", "error"]);
  const BODY_METHODS = new Set(["json", "text", "blob", "arrayBuffer", "formData", "bytes"]);
  const PROJECT_FIELDS = ["id", "name", "notesDirectory", "collectionName", "legacy", "noteCount"];

  function validProjects(projects, allowEmpty = false) {
    if (!Array.isArray(projects) || projects.length > 128 || (!projects.length && !allowEmpty)) return false;
    const ids = new Set();
    const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max
      && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
    return projects.every(project => {
      if (!project || !ID.test(project.id) || ids.has(project.id) || !text(project.name, 120)
          || !text(project.notesDirectory, 1024) || !text(project.collectionName, 255)
          || typeof project.legacy !== "boolean"
          || (project.noteCount !== null && (!Number.isSafeInteger(project.noteCount) || project.noteCount < 0))) return false;
      ids.add(project.id);
      return true;
    });
  }

  function createProjectContext(options = {}) {
    const bridge = options.bridge;
    const legacyMode = options.legacyMode ?? !bridge;
    const transport = options.fetch || ((...args) => root.fetch(...args));
    const Abort = options.AbortController || root.AbortController;
    const Header = options.Headers || root.Headers;
    const origin = options.backendOrigin || bridge?.getBackendOrigin?.() || "http://127.0.0.1:5000";
    const backend = new URL(origin);
    const localOrigin = backend.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(backend.hostname)
      && backend.href === `${backend.origin}/` && !backend.username && !backend.password;
    const report = options.report || (() => root.console?.warn("Project state listener failed"));
    const subscribers = new Set(), requests = new Map();
    let revision = 0, disposed = false, projectModeSeen = false, unsubscribe, bootstrapTimer, activePhases = 0;
    let resolveInitial;
    const initialState = new Promise(resolve => { resolveInitial = resolve; });
    let state = Object.freeze({ projectId: null, contextToken: null, epoch: 0,
      status: "switching", legacyChatStorage: false, projectState: null });

    function failure(code) {
      const messages = {
        project_switching: ["Дождитесь переключения проекта.", "Wait for the project to finish switching."],
        project_context_changed: ["Проект изменился. Повторите действие в нужном проекте.", "The project changed. Repeat the action in the intended project."],
        project_context_unavailable: ["Проект пока недоступен. Повторите выбор проекта.", "The project is unavailable. Select the project again."],
        project_request_forbidden: ["Запрос выходит за пределы локального проекта.", "The request is outside the local project."],
        project_requests_busy: ["Дождитесь завершения текущих запросов.", "Wait for the current requests to finish."],
        project_stream_unsupported: ["Используйте обычное чтение ответа проекта.", "Use a standard project response body reader."],
      };
      const [ru, en] = messages[code] || messages.project_context_unavailable;
      return Object.assign(new Error(root.nodaI18n?.t?.(ru, en) ?? ru), { code });
    }

    function freezeCopy(value) {
      const copy = JSON.parse(JSON.stringify(value));
      function freeze(item) {
        if (item && typeof item === "object") {
          Object.values(item).forEach(freeze);
          Object.freeze(item);
        }
        return item;
      }
      return freeze(copy);
    }

    function notify() {
      for (const listener of subscribers) {
        try { listener(state); } catch { report(); }
      }
    }

    function apply(payload) {
      if (disposed) return;
      let next;
      try {
        if (!payload || payload.ok !== true || !STATUS.has(payload.status)) throw failure();
        const dto = freezeCopy(payload);
        if (dto.mode === "legacy" && !projectModeSeen && dto.status === "ready"
            && dto.context === null && dto.activeProjectId === null && dto.activeProject === null
            && Array.isArray(dto.projects) && dto.projects.length === 0) {
          next = { projectId: null, contextToken: null, status: "ready", legacyChatStorage: true, projectState: dto };
        } else {
          if (dto.mode !== "projects") throw failure();
          projectModeSeen = true;
          if (!validProjects(dto.projects, dto.status === "error")) throw failure();
          if (dto.status === "error") {
            if (dto.context !== null) throw failure();
            next = { projectId: null, contextToken: null, status: "error", legacyChatStorage: false, projectState: dto };
          } else {
            const id = dto.activeProjectId, token = dto.context?.context_token;
            const selected = dto.projects.find(project => project.id === id);
            if (!ID.test(id) || !ID.test(token) || dto.context.project_id !== id
                || dto.activeProject?.id !== id || typeof dto.activeProject.legacyChatStorage !== "boolean"
                || (dto.activeProject.legacyChatStorage && dto.activeProject.legacy !== true)
                || !selected || PROJECT_FIELDS.some(key => dto.activeProject[key] !== selected[key])) {
              throw failure();
            }
            next = { projectId: id, contextToken: token, status: dto.status,
              legacyChatStorage: dto.activeProject.legacyChatStorage, projectState: dto };
          }
        }
      } catch {
        next = { projectId: null, contextToken: null, status: "error", legacyChatStorage: false, projectState: null };
      }
      const changed = ["projectId", "contextToken", "status", "legacyChatStorage"].some(key => state[key] !== next[key]);
      state = Object.freeze({ ...next, epoch: state.epoch + Number(changed) });
      if (changed) for (const controller of requests.keys()) controller.abort();
      notify();
      resolveInitial();
    }

    function snapshot() { return state; }
    function isCurrent(bound) {
      return !disposed && state.status === "ready" && bound?.status === "ready"
        && bound.epoch === state.epoch && bound.projectId === state.projectId && bound.contextToken === state.contextToken;
    }
    function requireCurrent(bound) {
      if (!isCurrent(bound)) throw failure(bound?.status === "switching" && bound.epoch === state.epoch
        ? "project_switching" : "project_context_changed");
    }
    function requireReady() {
      if (disposed || state.status === "error") throw failure("project_context_unavailable");
      if (state.status !== "ready") throw failure("project_switching");
      return state;
    }
    function localUrl(input, asset = false) {
      let url;
      try { url = new URL(input, origin); } catch { throw failure("project_request_forbidden"); }
      if (!localOrigin || url.origin !== backend.origin || url.username || url.password || (asset && !url.pathname.startsWith("/notes/assets/"))) {
        throw failure("project_request_forbidden");
      }
      return url;
    }

    async function phase(bound, controller, external, action) {
      requireCurrent(bound);
      if (activePhases >= 128) throw failure("project_requests_busy");
      const abort = () => controller.abort(external.reason);
      if (external?.aborted) abort();
      else external?.addEventListener("abort", abort, { once: true });
      activePhases += 1;
      requests.set(controller, (requests.get(controller) || 0) + 1);
      let rejectAbort;
      const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
      const cancelPhase = () => rejectAbort(controller.signal.reason || Object.assign(new Error("Request cancelled"), { name: "AbortError" }));
      controller.signal.addEventListener("abort", cancelPhase, { once: true });
      try {
        if (controller.signal.aborted) throw controller.signal.reason || Object.assign(new Error("Request cancelled"), { name: "AbortError" });
        const value = await Promise.race([action(), cancelled]);
        requireCurrent(bound);
        if (controller.signal.aborted) throw controller.signal.reason || Object.assign(new Error("Request cancelled"), { name: "AbortError" });
        return value;
      } catch (error) {
        requireCurrent(bound);
        throw error;
      } finally {
        activePhases -= 1;
        const remaining = (requests.get(controller) || 1) - 1;
        if (remaining) requests.set(controller, remaining); else requests.delete(controller);
        controller.signal.removeEventListener("abort", cancelPhase);
        external?.removeEventListener("abort", abort);
      }
    }

    function wrapResponse(response, bound, controller, external) {
      return new Proxy(response, {
        get(target, property) {
          requireCurrent(bound);
          if (property === "body" && target.body !== null && target.body !== undefined) throw failure("project_stream_unsupported");
          if (BODY_METHODS.has(property) && typeof target[property] === "function") {
            return (...args) => phase(bound, controller, external, () => target[property](...args));
          }
          if (property === "clone") return () => { requireCurrent(bound); return wrapResponse(target.clone(), bound, controller, external); };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }

    async function projectFetch(input, options = {}) {
      const bound = requireReady(), url = localUrl(input);
      const headers = new Header(options.headers);
      headers.delete("X-Noda-Project-Id"); headers.delete("X-Noda-Project-Context");
      if (bound.projectId) {
        headers.set("X-Noda-Project-Id", bound.projectId);
        headers.set("X-Noda-Project-Context", bound.contextToken);
      }
      const controller = new Abort();
      const response = await phase(bound, controller, options.signal,
        () => transport(url.href, { ...options, headers, signal: controller.signal, redirect: "error" }));
      return wrapResponse(response, bound, controller, options.signal);
    }

    function assetUrl(input) {
      const bound = requireReady(), url = localUrl(input, true);
      url.searchParams.delete("project_id"); url.searchParams.delete("project_context");
      if (bound.projectId) {
        url.searchParams.set("project_id", bound.projectId);
        url.searchParams.set("project_context", bound.contextToken);
      }
      return url.href;
    }

    const bootstrap = legacyMode ? Promise.resolve().then(() => apply({ ok: true, mode: "legacy",
      projects: [], activeProjectId: null, activeProject: null, context: null, status: "ready" })) : Promise.resolve().then(async () => {
      if (disposed) return;
      if (typeof bridge?.getProjects !== "function" || typeof bridge?.onProjectState !== "function") throw failure();
      unsubscribe = bridge.onProjectState(payload => { revision += 1; apply(payload); });
      const started = revision;
      const timeout = new Promise((_, reject) => { bootstrapTimer = root.setTimeout(() => reject(failure()), options.bootstrapTimeoutMs ?? 15000); });
      let payload;
      try { payload = await Promise.race([bridge.getProjects(), timeout]); }
      finally { root.clearTimeout(bootstrapTimer); }
      if (started === revision) apply(payload);
    }).catch(() => {
      if (!disposed && state.status !== "ready") apply({ ok: false });
    });

    return {
      snapshot, isCurrent, fetch: projectFetch, assetUrl,
      async ready() { await initialState; return requireReady(); },
      subscribe(listener) {
        if (typeof listener !== "function") throw new TypeError("Project listener must be a function");
        subscribers.add(listener);
        try { listener(state); } catch { report(); }
        return () => subscribers.delete(listener);
      },
      dispose() {
        disposed = true;
        root.clearTimeout(bootstrapTimer);
        for (const controller of requests.keys()) controller.abort();
        requests.clear(); subscribers.clear();
        if (typeof unsubscribe === "function") unsubscribe();
        resolveInitial();
      },
    };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { createProjectContext };
  else {
    root.NodaProjectContext = createProjectContext({ bridge: root.quickNoteBridge });
    root.addEventListener("beforeunload", () => root.NodaProjectContext.dispose(), { once: true });
  }
})(typeof window === "undefined" ? globalThis : window);
