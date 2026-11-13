"use strict";

class NoteModelDownloadError extends Error {
  constructor(code) {
    super("Could not prepare the selected note models");
    this.code = code;
  }
}

async function streamModels(action, payload, { backendUrl, fetchWithTimeout, onProgress, signal }) {
  let reader;
  try {
    const chatRoutes = { chat: "/models/chat-import/download", chatPreset: "/models/chat-preset/download" };
    const route = chatRoutes[action] || `/runtime/note-pipeline/${action}`;
    const response = await fetchWithTimeout(`${backendUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    }, 60000);
    if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("application/x-ndjson")) {
      if (chatRoutes[action] && response.headers.get("content-type")?.startsWith("application/json")) {
        const failure = await response.json();
        throw new NoteModelDownloadError(failure.code);
      }
      throw new NoteModelDownloadError(action === "import" && response.status === 400 ? "import_url" : "configuration");
    }
    reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new NoteModelDownloadError("network");
      const lines = (pending + value).split("\n");
      pending = lines.pop();
      if (pending.length > 4096) throw new NoteModelDownloadError("configuration");
      for (const line of lines) {
        if (line.length > 4096) throw new NoteModelDownloadError("configuration");
        const event = JSON.parse(line);
        if (event?.state === "done") return event.model;
        if (event?.state === "error") throw new NoteModelDownloadError(event.code);
        if (action !== "prepare" && ["checking", "testing"].includes(event?.state)) {
          onProgress({ state: event.state });
          continue;
        }
        if (event?.state !== "downloading" || typeof event.model !== "string" || event.model.length > 200
            || !Number.isSafeInteger(event.bytes) || !Number.isSafeInteger(event.total)
            || event.bytes < 0 || event.total <= 0 || event.bytes > event.total) {
          throw new NoteModelDownloadError("configuration");
        }
        onProgress({
          ...(action !== "prepare" && { state: "downloading" }),
          model: event.model, bytes: event.bytes, total: event.total,
        });
      }
    }
  } catch (error) {
    if (signal?.aborted) throw new NoteModelDownloadError("canceled");
    if (error instanceof NoteModelDownloadError) throw error;
    throw new NoteModelDownloadError(error instanceof SyntaxError ? "configuration" : "network");
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    onProgress(null);
  }
}

const prepareNoteModels = (selection, options) => streamModels("prepare", selection, options);

function noteModelLink(payload) {
  const prefix = payload?.role === "generator" ? "hfg" : "hfr";
  if (!["generator", "reranker"].includes(payload?.role)
      || typeof payload.url !== "string" || payload.url.length > 1800) {
    throw new NoteModelDownloadError("import_url");
  }
  return { role: payload.role, url: payload.url, idPattern: new RegExp(`^${prefix}_[a-f0-9]{16}$`) };
}

function validOption(model, idPattern) {
  return model && typeof model.id === "string" && idPattern.test(model.id)
    && typeof model.label === "string" && model.label.length <= 320;
}

async function previewNoteModel(payload, { backendUrl, fetchWithTimeout }) {
  const { role, url, idPattern } = noteModelLink(payload);
  const response = await fetchWithTimeout(`${backendUrl}/runtime/note-pipeline/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, url }),
  }, 60000);
  const result = await response.json();
  if (!response.ok || result?.ok !== true) {
    throw new NoteModelDownloadError(result?.code || "configuration");
  }
  if (!validOption(result.model, idPattern)
      || typeof result.url !== "string" || result.url.length > 1800
      || !Number.isSafeInteger(result.download_bytes) || result.download_bytes < 0
      || !Number.isSafeInteger(result.disk_free_bytes) || result.disk_free_bytes < 0) {
    throw new NoteModelDownloadError("configuration");
  }
  return { ok: true, model: result.model, url: result.url,
    download_bytes: result.download_bytes, disk_free_bytes: result.disk_free_bytes };
}

async function importNoteModel(payload, options) {
  const { role, url, idPattern } = noteModelLink(payload);
  const { id } = payload;
  if (id !== undefined && (typeof id !== "string" || !idPattern.test(id))) {
    throw new NoteModelDownloadError("import_url");
  }
  const model = await streamModels("import", { role, url, ...(id && { id }) }, options);
  if (!validOption(model, idPattern) || (id && model.id !== id)) throw new NoteModelDownloadError("configuration");
  return { id: model.id, label: model.label, imported: true, experimental: true, downloaded: true };
}

const downloadChatModel = (selection, options) => streamModels("chat", selection, options);
const downloadPortableChatPreset = (selection, options) => streamModels("chatPreset", selection, options);

module.exports = {
  NoteModelDownloadError, prepareNoteModels, previewNoteModel, importNoteModel, downloadChatModel, downloadPortableChatPreset,
};
