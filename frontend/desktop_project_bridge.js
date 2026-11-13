"use strict";

const path = require("node:path");
const { createDesktopProjects } = require("./desktop_projects");
const { createDesktopProjectController } = require("./desktop_project_controller");

function createDesktopProjectBridge(options) {
  const { userData, environment, backendUrl, shutdownToken, fetchWithTimeout,
    readJsonResponse, restartBackend, stopBackend, completeBackendStart, persistDirectory, isBusy, setBusy,
    isReadSender, isNotesSender, getNotesWindow, windows, ensureReady,
    assertMutable, dialog, text, ownedProfile, openProjectFolder } = options;
  const legacy = () => ({ ok: true, mode: "legacy", projects: [], activeProjectId: null,
    activeProject: null, context: null, status: "ready" });
  async function rpc(endpoint, context, mutation = false) {
    const response = await fetchWithTimeout(`${backendUrl}${endpoint}`, mutation ? {
      method: "POST", headers: {
        "X-Test-Gui-Shutdown-Token": shutdownToken,
        "X-Noda-Project-Id": context.project_id,
        "X-Noda-Project-Context": context.context_token,
      },
    } : {});
    const value = await readJsonResponse(response);
    if (!response.ok) throw Object.assign(new Error("Project request failed"), { code: value.code });
    if (mutation && (value.ok !== true || value.project_id !== context.project_id
        || value.context_token !== context.context_token
        || (endpoint.endsWith("activate") ? value.activated !== true
          : value.frozen !== endpoint.endsWith("prepare-switch")))) {
      throw Object.assign(new Error("Invalid project switch acknowledgement"), { code: "project_context_invalid" });
    }
    return value;
  }
  let controller = null, initializationError = null;
  try { controller = ownedProfile ? null : createDesktopProjectController({
    registry: createDesktopProjects(path.join(userData, "knowledge-projects.json")),
    environment, storageRoot: path.join(userData, "projects"),
    legacyCollection: environment.QDRANT_COLLECTION_NAME || "notes", text,
    restartBackend, stopBackend, completeBackendStart, persistDirectory, isBusy, setBusy, openProjectFolder,
    prepareSwitch: context => rpc("/projects/prepare-switch", context, true),
    cancelSwitch: context => rpc("/projects/cancel-switch", context, true),
    activateBackend: context => rpc("/projects/activate", context, true),
    readContext: () => rpc("/projects/context"),
    emit: payload => {
      for (const window of windows()) {
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send("quick-note:project-state", payload);
        }
      }
    },
  }); } catch (_) {
    initializationError = new Error(text("Не удалось прочитать реестр проектов Noda. Сохранённые папки не изменены.",
      "Could not read the Noda project registry. Saved folders are unchanged."));
  }
  function checked() {
    if (initializationError) throw initializationError;
    return controller;
  }
  async function chooseFolder(parent, backup = false) {
    const result = await dialog.showOpenDialog(getNotesWindow(), {
      title: backup ? text("Куда сохранить копию заметок?", "Where should the notes backup be saved?")
        : parent ? text("Где создать папку проекта?", "Where should the project folder be created?")
        : text("Подключить папку с заметками", "Connect a notes folder"),
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  }
  function deny() { return { ok: false, code: "invalid_sender", error: text("Недопустимый запрос окна.", "Invalid window request.") }; }
  function context(payload, required = true) {
    if (!checked()) return null;
    if (!payload && !required) {
      if (controller.isTransitioning()) throw Object.assign(new Error("Project is switching"), { code: "project_busy" });
      return null;
    }
    controller.assertContext(payload);
    return controller.snapshot().context;
  }
  async function runWithContext(payload, operation, required = true) {
    context(payload, required);
    const result = await operation();
    context(payload, required);
    return result;
  }
  async function runMutationWithContext(payload, operation) {
    context(payload);
    if (isBusy()) throw Object.assign(new Error("Another change is in progress"), { code: "project_busy" });
    setBusy(true);
    try { return await runWithContext(payload, operation); }
    finally { setBusy(false); }
  }
  function fetchFor(payload) {
    const captured = context(payload);
    return (url, init = {}, timeout) => {
      context(payload);
      if (new URL(url).origin !== backendUrl) throw new Error("Project request must use the local backend");
      const headers = new Headers(init.headers || {});
      if (captured) {
        headers.set("X-Noda-Project-Id", captured.project_id);
        headers.set("X-Noda-Project-Context", captured.context_token);
      }
      return fetchWithTimeout(url, { ...init, headers, redirect: "error" }, timeout);
    };
  }
  function decorateRequest(url, init = {}) {
    const headers = new Headers(init.headers || {});
    if (new URL(url).origin !== backendUrl) {
      if (headers.has("X-Noda-Project-Id") || headers.has("X-Noda-Project-Context")) {
        throw new Error("Project context cannot be sent outside the local backend");
      }
      return init;
    }
    const captured = checked()?.backendContext();
    if (!captured) return { ...init, redirect: "error" };
    if (!headers.has("X-Noda-Project-Id")) headers.set("X-Noda-Project-Id", captured.project_id);
    if (!headers.has("X-Noda-Project-Context")) headers.set("X-Noda-Project-Context", captured.context_token);
    return { ...init, headers, redirect: "error" };
  }
  function register(ipcMain) {
    ipcMain.handle("quick-note:get-projects", async event => {
      if (!isReadSender(event)) return deny();
      checked();
      if (!controller) return legacy();
      await ensureReady();
      return controller.snapshot();
    });
    for (const [channel, action] of [
      ["create-project", payload => controller.createProject(payload, () => chooseFolder(true))],
      ["connect-project", () => controller.connectProject(() => chooseFolder(false))],
      ["switch-project", id => controller.switchProject(id)],
      ["report-project-count", payload => controller.reportCount(payload)],
      ["open-project-folder", payload => controller.openFolder(payload)],
      ["rename-project", payload => controller.renameProject(payload)],
      ["detach-project", payload => controller.detachProject(payload)],
      ["backup-project", payload => controller.backupProject(payload, () => chooseFolder(false, true))],
    ]) ipcMain.handle(`quick-note:${channel}`, async (event, payload) => {
      if (!isNotesSender(event)) return deny();
      assertMutable();
      checked();
      if (!controller) return { ok: false, code: "projects_unavailable" };
      await ensureReady();
      return action(payload);
    });
  }
  return {
    restoredDirectory: () => checked()?.restoredDirectory(),
    currentDirectoryAvailable: directory => checked()?.directoryAvailable(directory) ?? true,
    prepareBackendStart: directory => checked()?.startup(directory),
    verifyBackend: () => checked()?.verifyBackend(),
    activateInitial: () => checked()?.activateInitial(),
    register, runWithContext, runMutationWithContext, fetchFor, decorateRequest,
    isTransitioning: () => controller?.isTransitioning() || false,
    isEnabled: () => Boolean(controller),
  };
}

module.exports = { createDesktopProjectBridge };
