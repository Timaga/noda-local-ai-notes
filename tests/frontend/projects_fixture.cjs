"use strict";

const { wrapper } = require("./notes_live_fixture.cjs");
const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32);

function initial(language = "ru") {
  const projects = [{ id: A, name: "Aster", notesDirectory: "C:\\Synthetic\\Aster", collectionName: "synthetic_a", legacy: false, noteCount: null },
    { id: B, name: "Boreal", notesDirectory: "C:\\Synthetic\\Boreal", collectionName: "synthetic_b", legacy: false, noteCount: 3 }];
  const data = {};
  for (const [index, project] of projects.entries()) {
    const marker = project.id === A ? "ASTER_ONLY" : "BOREAL_ONLY";
    const body = language === "en" ? `${marker}: CRM project plan. Keep this material in its own project.`
      : `${marker}: План проекта CRM. Эти материалы относятся только к выбранному проекту.`;
    const tags = [project.id === A ? "aster" : "boreal"], related = [`${project.name} — план`];
    const notes = Array.from({ length: index + 2 }, (_, n) => ({ title: n ? `${project.name} ${n}` : "CRM",
      snippet: body, tags, indexed: true, content_revision: String(index + 1).repeat(64), timestamp: "2026-11-06T10:00:00Z" }));
    const details = Object.fromEntries(notes.map(note => [note.title, { ...note, resolved_title: note.title,
      content: wrapper(body, { title: `${project.name} CRM`, tags, related }) }]));
    details[related[0]] = { title: related[0], resolved_title: related[0], content: `${marker} linked plan`, tags, indexed: true };
    data[project.id] = { marker, body, notes, details, vault: (index ? "2" : "1").repeat(32), revision: (index ? "2" : "1").repeat(64) };
  }
  data[C] = { marker: "CONNECTED_ONLY", body: "", notes: [], details: {}, vault: "3".repeat(32), revision: "3".repeat(64) };
  return { projects, data, language, A, B, C, active: A, token: "d".repeat(32) };
}

function createMainFixture(ipcMain, language = "ru") {
  const data = initial(language), calls = [], windows = new Set();
  let active = A, token = data.token, status = "ready", pendingProjectId = null, serial = 14, projectError = "";
  const control = { holdSwitch: false, holdGeneration: false, holdSettings: false, holdSaves: false, nextSwitch: "success", nextCreate: "cancel", nextConnect: "cancel", pending: [], pendingGeneration: [], pendingSettings: [], pendingSaves: [], calls, data };
  function snapshot(extra = {}) {
    const project = data.projects.find(item => item.id === active);
    return { ok: true, mode: "projects", projects: data.projects, activeProjectId: active,
      activeProject: { ...project, legacyChatStorage: false }, context: { project_id: active, context_token: token },
      status, pendingProjectId, ...(projectError ? { error: projectError } : {}), ...extra };
  }
  function emit() {
    for (const win of windows) if (!win.isDestroyed()) win.webContents.send("quick-note:project-state", snapshot());
  }
  async function switchProject(id) {
    calls.push({ action: "switch", id });
    if (!data.projects.some(item => item.id === id)) return { ok: false, code: "unknown_project" };
    const previous = active;
    status = "switching"; pendingProjectId = id; projectError = ""; emit();
    const outcome = control.nextSwitch; control.nextSwitch = "success";
    const finish = () => {
      active = outcome === "error" ? previous : id;
      projectError = outcome === "error" ? language === "en" ? "Could not open the project. The previous project was preserved."
        : "Не удалось открыть проект. Прежний проект сохранён." : "";
      token = (++serial).toString(16).padStart(32, "0"); status = "ready"; pendingProjectId = null; emit();
      return snapshot(outcome === "error" ? { ok: false, code: "project_switch_failed" } : {});
    };
    return control.holdSwitch ? new Promise(resolve => control.pending.push(() => resolve(finish()))) : finish();
  }
  function action(kind, payload) {
    calls.push({ action: kind, payload });
    const outcome = control[kind === "create" ? "nextCreate" : "nextConnect"];
    if (outcome === "cancel") return snapshot({ canceled: true });
    if (outcome === "error") return { ok: false, code: "synthetic_picker_error" };
    if (!data.projects.some(project => project.id === C)) {
      data.projects.push({ id: C, name: payload?.name || "Connected", notesDirectory: "C:\\Synthetic\\Connected",
        collectionName: "synthetic_c", noteCount: 0, legacy: false });
      data.data[C] = { marker: "CONNECTED_ONLY", body: "", notes: [], details: {}, vault: "3".repeat(32), revision: "3".repeat(64) };
    }
    return switchProject(C);
  }
  function settings() {
    const selection = { title: "qwen25_3b_mmarco", tags: "qwen35_4b_tev", links: "qwen35_4b_mmarco" };
    const labels = { title: "Qwen2.5-3B + mMARCO MiniLM CrossEncoder", tags: "Qwen3.5-4B + Tev1-0.8B", links: "Qwen3.5-4B + mMARCO MiniLM CrossEncoder" };
    return { ok: true, settings: { notesDirectory: data.projects.find(p => p.id === active).notesDirectory, theme: "classic-blue", language,
      skipModelSelection: true, skipNotesDirectorySelection: true, skipTurboQuantSelection: true,
      skipNoteTitleSelection: true, skipNoteTagsSelection: true, skipNoteLinksSelection: true },
      models: [], activeModelId: null, hardware: { ramGb: 16 }, turboquantCapability: { supported: false },
      runtime: { provider: "local", turboquant: { enabled: false }, note_pipeline: { enabled: true, configured: true,
        selection, catalog: Object.entries(selection).map(([id, pair]) => ({ id, recommendedId: pair,
          options: [{ id: pair, label: labels[id], languages: ["ru", "en"], available: true }] })) } } };
  }
  function manage(kind, payload) {
    calls.push({ action: kind, payload });
    const project = data.projects.find(item => item.id === payload?.targetId);
    if (!project || payload?.projectId !== active || payload?.contextToken !== token) return { ok: false, code: "project_changed" };
    if (kind === "renameProject") { project.name = payload.name; emit(); }
    if (kind === "backupProject") return { ok: true, directory: "C:\\Synthetic\\Backups\\Noda-copy", files: 2 };
    return { ok: true };
  }
  const handlers = {
    "get-projects": () => snapshot(), "create-project": (_event, payload) => action("create", payload),
    "get-app-settings": () => {
      const payload = settings(); calls.push({ action: "settings", projectId: active });
      return control.holdSettings ? new Promise(resolve => control.pendingSettings.push(() => resolve(payload))) : payload;
    },
    "save-app-settings": (_event, payload) => {
      calls.push({ action: "saveSettings", payload });
      if (payload?.projectId !== active || payload?.contextToken !== token) return { ok: false, code: "project_changed" };
      const result = settings(), { projectId, contextToken, turboquantEnabled, ...preferences } = payload;
      result.settings = { ...result.settings, ...preferences };
      return control.holdSaves ? new Promise(resolve => control.pendingSaves.push(() => resolve(result))) : result;
    },
    "choose-notes-directory": () => { throw new Error("Legacy folder picker must not be used in projects mode"); },
    "connect-project": () => action("connect"), "switch-project": (_event, id) => switchProject(id),
    "open-project-folder": (_event, payload) => manage("openProjectFolder", payload),
    "rename-project": (_event, payload) => manage("renameProject", payload),
    "backup-project": (_event, payload) => manage("backupProject", payload),
    "report-project-count": (_event, payload) => {
      calls.push({ action: "count", payload });
      if (payload?.projectId !== active || payload?.contextToken !== token) return { ok: false, code: "project_changed" };
      data.projects.find(item => item.id === active).noteCount = payload.count; emit(); return snapshot();
    },
    "get-startup-status": () => ({ state: "ready", phase: "ready", progress: 100, language }),
    "ensure-backend": () => ({ ok: true }), "ensure-chat-runtime": () => ({ ok: true }),
    "ensure-generation-runtime": (_event, payload) => {
      calls.push({ action: "generationReady", payload });
      return control.holdGeneration ? new Promise(resolve => control.pendingGeneration.push(() => resolve({ ok: true }))) : { ok: true };
    }, "startup-renderer-ready": () => ({ ok: true }),
    "complete-startup": () => ({ ok: true }), "get-hotkey": () => "Control+Shift+Space",
    "report-window-size": () => ({ ok: true }), "resize-capture": () => ({ ok: true }),
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(`quick-note:${channel}`, handler);
  return { ...control, addWindow: win => windows.add(win), snapshot, emit,
    emitHardError: kind => {
      status = "error";
      if (kind === "activation") active = C;
      const error = kind === "activation"
        ? language === "en" ? "The project was saved, but activation could not be confirmed. Restart Noda; project data is preserved."
          : "Проект сохранён, но его запуск не подтверждён. Перезапустите Noda; данные проектов сохранены."
        : language === "en" ? "The project could not load and the previous project could not be restored. Restart Noda."
          : "Проект не загрузился; восстановление прежнего проекта тоже не завершилось. Перезапустите Noda.";
      for (const win of windows) if (!win.isDestroyed()) win.webContents.send("quick-note:project-state", snapshot({ context: null,
        error }));
    },
    release: () => control.pending.splice(0).forEach(fn => fn()),
    releaseGeneration: () => control.pendingGeneration.splice(0).forEach(fn => fn()),
    releaseSettings: () => control.pendingSettings.splice(0).forEach(fn => fn()),
    releaseSaves: () => control.pendingSaves.splice(0).forEach(fn => fn()),
    switchProject, get holdSwitch() { return control.holdSwitch; }, set holdSwitch(value) { control.holdSwitch = value; },
    get holdGeneration() { return control.holdGeneration; }, set holdGeneration(value) { control.holdGeneration = value; },
    get holdSettings() { return control.holdSettings; }, set holdSettings(value) { control.holdSettings = value; },
    get holdSaves() { return control.holdSaves; }, set holdSaves(value) { control.holdSaves = value; },
    get nextSwitch() { return control.nextSwitch; }, set nextSwitch(value) { control.nextSwitch = value; },
    get nextCreate() { return control.nextCreate; }, set nextCreate(value) { control.nextCreate = value; },
    get nextConnect() { return control.nextConnect; }, set nextConnect(value) { control.nextConnect = value; } };
}

function setupHttp(data, initialState) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const state = window.__projects = { ...data, context: initialState, calls: [], violations: [], hold: null, pending: [], writes: [], clipboardWrites: [] };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { state.clipboardWrites.push(value); } } });
  window.quickNoteBridge.onProjectState(payload => { state.context = payload; });
  function response(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } }); }
  function wait(payload, status, phase) {
    const item = { phase, release: null };
    const promise = new Promise(resolve => { item.release = () => resolve(phase === "json" ? clone(payload) : response(payload, status)); });
    state.pending.push(item); return promise;
  }
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, location.href), path = parsed.pathname, headers = new Headers(options.headers);
    const id = headers.get("X-Noda-Project-Id"), token = headers.get("X-Noda-Project-Context");
    const method = options.method || "GET", body = options.body ? JSON.parse(options.body) : null;
    state.calls.push({ path, id, token, method, body });
    if (!/^[a-f0-9]{32}$/.test(id || "") || !/^[a-f0-9]{32}$/.test(token || "")
        || id !== state.context.activeProjectId || token !== state.context.context?.context_token || state.context.status !== "ready") {
      state.violations.push({ path, id, token, method }); return response({ error: "Wrong synthetic project", code: "project_changed" }, 409);
    }
    const project = state.data[id];
    let payload;
    if (path === "/notes" && method === "GET") payload = parsed.searchParams.get("if_revision") === project.revision
      ? { unchanged: true, revision: project.revision, vault_id: project.vault }
      : { notes: clone(project.notes), revision: project.revision, vault_id: project.vault, qdrant: { available: true, collection: id } };
    else if (path.startsWith("/note-detail/")) {
      const key = decodeURIComponent(path.slice(13));
      payload = { ...clone(project.details[key] || { title: key, content: `${project.marker} missing detail`, tags: [] }), vault_id: project.vault };
    } else if (path === "/notes" && method === "POST") {
      state.writes.push({ id, body }); payload = { note: { title: body.title, content: body.content, tags: body.tags, indexed: true } };
    } else if (path === "/rag") payload = { response: `${project.marker} RAG answer`, context: [{ title: "CRM", tags: [id === state.A ? "aster" : "boreal"] }], context_source: "synthetic" };
    else if (path === "/generate/queue") payload = { vault_id: project.vault, queue: { vault_id: project.vault, queued_count: 0, processing_count: 0 } };
    else if (path === "/generate/jobs") payload = { jobs: [], next_cursor: null, vault_id: project.vault };
    else if (path.startsWith("/generate/jobs/")) payload = { vault_id: project.vault, job: { job_id: "same-job", status: "completed", vault_id: project.vault,
      prompt_text: `${project.marker} source`, result: { title: `${project.marker} generated`, content: `${project.marker} body`, tags: [], related: [] } } };
    else if (path === "/generate/enqueue") {
      state.writes.push({ id, body }); payload = { vault_id: project.vault, job: { job_id: "same-job", status: "queued", vault_id: project.vault, client_request_id: body.client_request_id } };
    } else if (path === "/runtime/config") payload = { config: { provider: "local", turboquant: false }, provider: "local", runtime_model_id: `${project.marker}-model`, turboquant: { enabled: false, supported: false }, model: { name: `${project.marker} model` } };
    else if (path === "/model-status") payload = { status: "ready", initialized: true };
    else if (path === "/runtime/models") payload = { models: [] };
    else throw new Error(`Unexpected synthetic project HTTP ${method} ${path}`);
    const captured = clone(payload), hold = state.hold;
    if (hold && hold.id === id && hold.path === path && (!hold.method || hold.method === method)) {
      if (hold.phase === "json") { const value = response(captured); value.json = () => wait(captured, 200, "json"); return value; }
      return wait(captured, 200, "fetch");
    }
    return response(captured);
  };
}

module.exports = { A, B, C, initial, createMainFixture, setupHttp };
