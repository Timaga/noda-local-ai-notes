"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { captureProjectDirectory, copyProjectNotes } = require("./project_backup");

const TOKEN = /^[a-f0-9]{32}$/;
const samePath = (a, b) => process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);
const failure = code => Object.assign(new Error(code), { code });

function createDesktopProjectController(options) {
  const { registry, environment, storageRoot, legacyCollection, restartBackend,
    prepareSwitch, cancelSwitch, readContext, persistDirectory, emit, stopBackend, activateBackend, completeBackendStart,
    isBusy = () => false, setBusy = () => {}, text = ru => ru, openProjectFolder,
    makeToken = () => crypto.randomBytes(16).toString("hex") } = options;
  if (typeof completeBackendStart !== "function") throw new TypeError("Project runtime completion callback is required");
  let state = registry.load(), binding = null, publicContext = null;
  let status = "ready", pendingProjectId = null, error = "", running = false;

  const active = () => state?.projects.find(entry => entry.id === state.activeProjectId) || null;
  function snapshot(extra = {}) {
    const selected = active();
    return { ok: true, mode: "projects", projects: state?.projects.filter(entry => !entry.detached) || [],
      activeProjectId: state?.activeProjectId || null,
      activeProject: selected ? { ...selected, legacyChatStorage: selected.legacy } : null,
      context: publicContext ? { ...publicContext } : null, status, pendingProjectId,
      ...(error ? { error } : {}), ...extra };
  }
  function notify() { emit(snapshot()); }
  function bind(entry) {
    const token = makeToken();
    if (!TOKEN.test(token)) throw failure("project_context_invalid");
    binding = { entry, context: { project_id: entry.id, context_token: token } };
    Object.assign(environment, {
      NOTES_DIR: entry.notesDirectory, QDRANT_COLLECTION_NAME: entry.collectionName,
      NODA_PROJECT_ID: entry.id, NODA_PROJECT_CONTEXT: token,
      NODA_PROJECT_STORAGE: path.join(storageRoot, entry.id),
      NODA_PROJECT_LEGACY: entry.legacy ? "1" : "0",
    });
  }
  function startup(directory) {
    if (binding) return binding;
    if (!state) state = registry.bootstrap({ notesDirectory: directory,
      collectionName: legacyCollection, name: path.basename(directory) || text("Мои заметки", "My notes") });
    if (!samePath(active().notesDirectory, directory)) {
      const known = state.projects.find(entry => samePath(entry.notesDirectory, directory));
      const next = known ? registry.reconnect(state, known.id)
        : registry.addExisting(state, { notesDirectory: directory, name: path.basename(directory) });
      state = registry.commit(state, next);
    } else registry.activate(state, state.activeProjectId);
    bind(active()); publicContext = binding.context;
    return binding;
  }
  function assertContext(candidate) {
    if (status !== "ready" || running || !publicContext
        || candidate?.projectId !== publicContext.project_id
        || candidate?.contextToken !== publicContext.context_token) throw failure("project_changed");
  }
  async function verifyBackend() {
    const received = await readContext();
    const entry = binding.entry;
    const root = process.platform === "win32" ? path.resolve(entry.notesDirectory).toLowerCase() : path.resolve(entry.notesDirectory);
    const expectedRoot = crypto.createHash("sha256").update(root).digest("hex");
    if (received?.ready !== true || received.project_id !== entry.id
        || received.context_token !== binding.context.context_token
        || received.collection_name !== entry.collectionName
        || received.root_sha256 !== expectedRoot || !TOKEN.test(received.vault_id || "")) {
      throw failure("project_context_invalid");
    }
    return received;
  }
  async function start(entry) {
    const previousContext = binding?.context;
    await stopBackend(previousContext);
    bind(entry);
    const runtime = await restartBackend({ previousContext, context: binding.context });
    await verifyBackend();
    return runtime;
  }
  function message(cause) {
    if (cause?.code === "project_busy") return text(
      "Дождитесь завершения обработки заметок или ответа чата и повторите переключение.",
      "Wait for note processing or the chat reply to finish, then try again.");
    if (cause?.code === "OVERLAPPING_DIRECTORIES") return text(
      "Папки проектов должны быть отдельными: одна не может находиться внутри другой.",
      "Project folders must be separate; one cannot be inside another.");
    if (["INVALID_FOLDER_NAME", "INVALID_TEXT", "INVALID_NAME"].includes(cause?.code)) return text(
      "Укажите допустимое название проекта без символов пути.", "Enter a valid project name without path characters.");
    if (["ENOENT", "UNSAFE_DIRECTORY", "DIRECTORY_ALIAS"].includes(cause?.code)) return text(
      "Папка недоступна или является ссылкой. Выберите обычную локальную папку.",
      "The folder is unavailable or is a link. Choose a regular local folder.");
    if (cause?.code === "EEXIST") return text("Папка с таким именем уже существует. Подключите её как существующую.",
      "A folder with this name already exists. Connect it as an existing folder.");
    if (cause?.code === "ACTIVE_PROJECT") return text(
      "Перед отключением этого проекта откройте другой.", "Switch to another project before disconnecting this one.");
    if (cause?.code === "project_changed") return text(
      "Текущий проект изменился. Откройте меню проекта снова.", "The current project changed. Open the project menu again.");
    if (cause?.code === "UNKNOWN_PROJECT") return text(
      "Проект уже недоступен в списке.", "The project is no longer in the list.");
    if (cause?.code === "project_folder_open_failed") return text(
      "Не удалось открыть папку проекта в файловом менеджере.", "Could not open the project folder in the file manager.");
    if (cause?.code === "BACKUP_INSIDE_PROJECT") return text(
      "Выберите место для копии вне папок проектов.", "Choose a backup location outside all project folders.");
    if (cause?.code === "backup_source_changed") return text(
      "Файлы проекта изменились или были перемещены. Готовая копия не создана. Дождитесь завершения обработки и повторите.",
      "Project files changed or moved. No completed backup was created. Wait for note processing to finish and try again.");
    if (cause?.code === "backup_verification_failed") return text(
      "Копия не прошла проверку. Попробуйте сохранить её в другую папку.",
      "The backup could not be verified. Try saving it to a different folder.");
    if (cause?.code === "ENOSPC") return text(
      "В папке назначения не хватило свободного места для копии.", "The destination ran out of space for the backup.");
    if (cause?.code === "backup_failed") return text(
      "Не удалось сохранить копию. Проверьте доступ к папке назначения и повторите.",
      "Could not save the backup. Check access to the destination folder and try again.");
    return text("Не удалось открыть проект. Прежний проект сохранён.",
      "Could not open the project. The previous project was preserved.");
  }
  async function change(next) {
    const previous = state, previousEntry = active(), previousContext = publicContext;
    if (typeof next !== "function" && next.activeProjectId === previousEntry.id) return snapshot();
    try { await prepareSwitch(previousContext); }
    catch (cause) {
      // A timed-out prepare may have frozen admissions; explicitly thaw the same context.
      try { await cancelSwitch(previousContext); } catch (cancelError) {
        if (cause?.code !== "project_busy") {
          status = "error"; publicContext = null;
          error = text("Не удалось подтвердить состояние проекта. Перезапустите Noda.",
            "Could not confirm the project state. Restart Noda.");
          notify(); return snapshot({ ok: false, code: "project_switch_unconfirmed" });
        }
      }
      error = message(cause); notify(); return snapshot({ ok: false, code: cause?.code || "project_switch_failed" });
    }
    try { next = typeof next === "function" ? next() : next; }
    catch (cause) {
      try { await cancelSwitch(previousContext); }
      catch (_) { status = "error"; publicContext = null; }
      error = message(cause); notify(); return snapshot({ ok: false, code: cause?.code || "project_failed" });
    }
    const target = next.projects.find(entry => entry.id === next.activeProjectId);
    status = "switching"; pendingProjectId = target.id; error = ""; notify();
    let directoryPersisted = false, committed = false;
    try {
      await start(target);
      await persistDirectory(target.notesDirectory); directoryPersisted = true;
      state = registry.commit(previous, next);
      committed = true;
      await activateBackend(binding.context);
      await completeBackendStart();
      publicContext = binding.context; status = "ready"; pendingProjectId = null; notify();
      return snapshot();
    } catch (cause) {
      if (committed) {
        publicContext = null; status = "error"; pendingProjectId = null;
        error = text("Проект сохранён, но его запуск не подтверждён. Перезапустите Noda; данные проектов сохранены.",
          "The project was saved, but activation could not be confirmed. Restart Noda; project data is preserved.");
        notify(); return snapshot({ ok: false, code: "project_activation_failed" });
      }
      let recovered = false;
      try {
        await start(previousEntry);
        await activateBackend(binding.context);
        await completeBackendStart();
        if (directoryPersisted) await persistDirectory(previousEntry.notesDirectory);
        publicContext = binding.context; recovered = true;
      } catch (_) { publicContext = null; }
      state = previous; pendingProjectId = null; status = recovered ? "ready" : "error";
      error = recovered ? message(cause) : text(
        "Проект не загрузился; восстановление прежнего проекта тоже не завершилось. Перезапустите Noda.",
        "The project could not load and the previous project could not be restored. Restart Noda.");
      notify(); return snapshot({ ok: false, code: recovered ? "project_switch_failed" : "project_rollback_failed" });
    }
  }
  async function action(prepare) {
    if (running || isBusy() || status !== "ready") return snapshot({ ok: false, code: "project_busy",
      error: text("Уже выполняется другое изменение. Дождитесь его завершения.", "Another change is in progress. Please wait.") });
    if (!state || !publicContext) throw failure("project_not_ready");
    running = true; setBusy(true);
    try {
      const next = await prepare();
      if (!next) return snapshot({ canceled: true });
      return await change(next);
    } catch (cause) {
      error = message(cause); notify(); return snapshot({ ok: false, code: cause?.code || "project_failed" });
    } finally { running = false; setBusy(false); }
  }
  function proposal(directory) {
    const known = state.projects.find(entry => samePath(entry.notesDirectory, directory));
    return known ? registry.reconnect(state, known.id) : registry.addExisting(state,
      { notesDirectory: directory, name: path.basename(directory) || text("Проект", "Project") });
  }
  async function manage(payload, operation, rename = false) {
    try {
      assertContext(payload);
      if (isBusy()) throw failure("project_busy");
      const keys = ["projectId", "contextToken", "targetId", ...(rename ? ["name"] : [])];
      if (Array.isArray(payload) || Object.keys(payload).length !== keys.length
          || keys.some(key => !Object.hasOwn(payload, key))
          || typeof payload.targetId !== "string" || !TOKEN.test(payload.targetId)) {
        throw failure("UNKNOWN_PROJECT");
      }
      if (rename && (typeof payload.name !== "string" || payload.name.length > 120
          || !payload.name.trim() || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(payload.name)
          || [".", ".."].includes(payload.name.trim()))) throw failure("INVALID_NAME");
      const result = await operation(payload.targetId);
      return { ok: true, ...result };
    } catch (cause) {
      return { ok: false, code: cause?.code || "project_failed", error: message(cause) };
    }
  }
  function updateRegistry(next) {
    state = registry.commit(state, next);
    error = "";
    notify();
  }
  function reportCount(payload) {
    assertContext(payload);
    const count = payload.count;
    if (!Number.isSafeInteger(count) || count < 0 || count > 1000000) throw failure("invalid_project_count");
    if (active().noteCount !== count) {
      state = registry.commit(state, registry.updateCount(state, state.activeProjectId, count)); notify();
    }
    return snapshot();
  }
  return { snapshot, startup, verifyBackend, assertContext, reportCount,
    openFolder: payload => manage(payload, async id => {
      const directory = registry.directoryFor(state, id);
      if (!openProjectFolder || await openProjectFolder(directory) !== "") throw failure("project_folder_open_failed");
    }),
    renameProject: payload => manage(payload, id => updateRegistry(registry.rename(state, id, payload.name.trim())), true),
    detachProject: payload => manage(payload, id => updateRegistry(registry.detach(state, id))),
    backupProject: (payload, chooseDestination) => manage(payload, async id => {
      setBusy(true);
      try {
        const sourceIdentity = await captureProjectDirectory(registry.directoryFor(state, id));
        const selected = await chooseDestination();
        if (!selected) return { canceled: true };
        assertContext(payload);
        const source = registry.directoryFor(state, id);
        const destination = registry.backupDestination(state, selected);
        try { return await copyProjectNotes(source, destination, sourceIdentity); }
        catch (cause) {
          if (["ENOENT", "ENOSPC", "backup_source_changed", "backup_verification_failed"].includes(cause?.code)) throw cause;
          throw failure("backup_failed");
        }
      } finally { setBusy(false); }
    }),
    backendContext: () => binding ? { ...binding.context } : null,
    activateInitial: () => !running && status === "ready" && binding
      ? activateBackend(binding.context) : Promise.resolve(),
    restoredDirectory: () => active()?.notesDirectory || null,
    directoryAvailable: directory => {
      if (!state) return true;
      const known = state.projects.find(entry => samePath(entry.notesDirectory, directory));
      if (!known) return false;
      try { registry.activate(state, known.id); return true; }
      catch (_) { return false; }
    },
    isTransitioning: () => running || status !== "ready",
    switchProject: id => action(() => registry.activate(state, id)),
    connectProject: chooseDirectory => action(async () => {
      const directory = await chooseDirectory(); return directory ? proposal(directory) : null;
    }),
    createProject: (payload, chooseParent) => action(async () => {
      if (!payload || Object.keys(payload).some(key => key !== "name")
          || typeof payload.name !== "string" || !payload.name.trim() || payload.name.length > 120) throw failure("INVALID_NAME");
      const parentDirectory = await chooseParent();
      return parentDirectory ? () => registry.createFolder(state, { name: payload.name.trim(), parentDirectory }) : null;
    }),
  };
}

module.exports = { createDesktopProjectController };
