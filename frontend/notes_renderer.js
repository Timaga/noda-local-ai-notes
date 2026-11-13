// Who: Tim Buglaev
// When: 2026-06-16
// What: Implemented the dashboard notes renderer with bounded local API calls,
//       escaped DOM rendering, list filters/sorting, immediate note editing, and
//       explicit create/delete flows so Qdrant-backed notes stay controllable.
const API_BASE = window.quickNoteBridge?.getBackendOrigin?.() || "http://127.0.0.1:5000";
const API_REQUEST_TIMEOUT_MS = 15000;
const TAG_TONE_COUNT = 8;
const noteText = (ru, en) => window.nodaI18n?.t(ru, en) ?? ru;
const noteLocale = () => window.nodaI18n?.locale() ?? "ru-RU";
// Who: Tim Buglaev
// When: 2026-06-16
// What: Define a tight Markdown preview allowlist for Obsidian note rendering:
//       local images, internal note links, and common Markdown tags are allowed,
//       while scripts, event handlers, and arbitrary external image sources are not.
const ALLOWED_MARKDOWN_TAGS = new Set([
  "A", "BLOCKQUOTE", "BR", "CODE", "DEL", "EM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HR", "IMG", "LI", "OL", "P", "PRE", "STRONG", "TABLE", "TBODY", "TD", "TH", "THEAD",
  "TR", "UL",
]);

const notesStatusCard = document.getElementById("notes-status-card");
const notesStatusText = document.getElementById("notes-status-text");
const notesHeaderActions = document.querySelector(".notes-header-actions");
const refreshNotesBtn = document.getElementById("refresh-notes-btn");
const newNoteBtn = document.getElementById("new-note-btn");
const notesSearch = document.getElementById("notes-search");
const notesSortSelect = document.getElementById("notes-sort-select");
const notesFilterButtons = Array.from(document.querySelectorAll("[data-notes-filter]"));
const qdrantState = document.getElementById("qdrant-state");
const notesCount = document.getElementById("notes-count");
const notesList = document.getElementById("notes-list");
const noteViewEmpty = document.getElementById("note-view-empty");
const noteViewPanel = document.getElementById("note-view-panel");
const noteViewTitle = document.getElementById("note-view-title");
const noteViewTags = document.getElementById("note-view-tags");
const noteViewSource = document.getElementById("note-view-source");
const noteViewTime = document.getElementById("note-view-time");
const noteViewContent = document.getElementById("note-view-content");
const noteCreatePanel = document.getElementById("note-create-panel");
const noteTitleInput = document.getElementById("note-title-input");
const noteTagsInput = document.getElementById("note-tags-input");
const noteContentInput = document.getElementById("note-content-input");
const saveNoteBtn = document.getElementById("save-note-btn");
const deleteNoteBtn = document.getElementById("delete-note-btn");
const noteDraftState = document.getElementById("note-draft-state");
const libraryRetry = document.getElementById("notes-library-retry");
const libraryError = document.getElementById("notes-library-error");
const notesTabButtons = Array.from(document.querySelectorAll("[data-notes-tab]"));
const notesTabPanels = Array.from(document.querySelectorAll("[data-notes-panel]"));
const notesHeroTitle = document.querySelector(".notes-hero h1");
const notesHeroEyebrow = document.querySelector(".notes-hero .eyebrow");

let notes = [];
let qdrantInfo = {};
let selectedNoteTitle = "";
let selectedNoteDetail = null;
let noteSelectionVersion = 0;
let creatingNote = false;
let noteWritePending = false;
let libraryState = "loading";
let activeNotesFilter = "all";
let activeNotesTab = "notes";
let projectsController = null;

const notesListReconciler = window.NotesListView.createReconciler({ list: notesList, doc: document, createItem: createNoteListItem });
const notesLiveApplication = window.NotesLiveApplication.create({
  request: apiRequest,
  getState: () => ({ notes, selectedNoteTitle, selectedNoteDetail, noteSelectionVersion,
    creatingNote: creatingNote || inlineEditor.isDirty() }),
  applyList: payload => {
    notes = payload.notes; qdrantInfo = payload.qdrant || {};
    renderQdrantState(); syncNotesChatState(); renderList(true);
    if (notesSearch.value.trim()) searchNotes(true);
    projectsController?.notesChanged();
  },
  applyDetail: payload => {
    const { scrollTop, scrollLeft } = noteViewContent;
    const viewer = document.getElementById("notes-viewer"), outerTop = viewer.scrollTop, outerLeft = viewer.scrollLeft;
    noteTitleInput.value = selectedNoteTitle; noteTagsInput.value = formatTags(payload.tags);
    noteContentInput.value = payload.content; renderNoteView(payload);
    noteViewContent.scrollTop = scrollTop; noteViewContent.scrollLeft = scrollLeft;
    viewer.scrollTop = outerTop; viewer.scrollLeft = outerLeft;
  },
  resetSelection: () => {
    noteSelectionVersion += 1; selectedNoteTitle = ""; selectedNoteDetail = null;
    if (!creatingNote) { renderNoteView(null); setEditorMode(false); }
    updateNoteListSelection();
  },
});
const notesLiveController = window.NotesLiveSync.create({
  refresh: async context => {
    const changed = await notesLiveApplication.refresh(context);
    if (context.isCurrent()) void relatedNotes.refresh(changed);
    if (context.isCurrent() && libraryState !== "ready") { libraryState = "ready"; renderList(true); }
    return changed;
  },
  isVisible: () => !document.hidden && activeNotesTab === "notes" && window.NodaProjectContext.snapshot().status === "ready",
  onError: () => { libraryState = "error"; renderList(true); },
});
const noteDrafts = window.NotesLibraryTools.createDrafts(() => window.localStorage);
const librarySearch = window.NotesLibraryTools.createSearch({ request: apiRequest,
  isCurrent: context => window.NodaProjectContext.isCurrent(context),
  getVault: () => notesLiveApplication.getVault(), onChange: () => renderList(true) });
const noteTrash = window.NotesLibraryTools.createTrash({ dialog: document.getElementById("note-trash-dialog"),
  status: document.getElementById("note-trash-status"), list: document.getElementById("note-trash-list"),
  context: window.NodaProjectContext, getVault: () => notesLiveApplication.getVault(), request: apiRequest,
  refresh: loadNotes, text: noteText });
const noteActions = window.NotesNoteActions.create({
  context: window.NodaProjectContext, request: apiRequest,
  getState: () => ({ selectedNoteTitle, selectedNoteDetail, creatingNote, vault: notesLiveApplication.getVault() }),
  inputs: { title: noteTitleInput, tags: noteTagsInput, content: noteContentInput, save: saveNoteBtn, delete: deleteNoteBtn },
  controls: { status: setStatus, editor: setEditorMode, refresh: loadNotes, select: title => selectNote(title, true),
    moved: () => { selectedNoteTitle = ""; renderNoteView(null); updateNoteListSelection(); },
    created: payload => { clearDraft(null); selectedNoteTitle = payload.title; renderNoteView(payload); setEditorMode(false); } },
  text: noteText, clipboard: window.navigator?.clipboard, confirm: message => window.confirm(message),
  beforeDelete: async () => {
    await inlineEditor.autoSave();
    if (!inlineEditor.isDirty()) return true;
    setStatus("warn", noteText("Сначала сохраните правки или сохраните их отдельно.", "Save your changes or save a copy first."));
    return false;
  },
  presentation: content => window.notesMarkdown?.presentation(content) || { source: content },
});
const notesWorkspace = window.NotesWorkspace.create({ doc: document, text: noteText });
const inlineEditor = window.NotesInlineEditor.create({
  doc: document, context: window.NodaProjectContext, drafts: noteDrafts, request: apiRequest,
  readDetail: notesLiveApplication.readDetail, getProject: draftProject, getVault: notesLiveApplication.getVault,
  text: noteText, renderPreview: renderMarkdownPreview,
  onSaved: detail => { renderNoteView(detail); setStatus("ok", ""); notesLiveController.wake(); },
  saveCopy: state => {
    if (!state) return;
    beginNewNote();
    noteTitleInput.value = `${state.title} — ${noteText("копия", "copy")}`;
    noteContentInput.value = state.content; rememberDraft();
  },
});
const relatedNotes = window.NotesRelatedNotes.create({ doc: document, host: document.getElementById("note-related"),
  context: window.NodaProjectContext, request: apiRequest, getVault: notesLiveApplication.getVault,
  text: noteText, model: window.NotesGraphModel });
const metadataEditor = window.NotesMetadataEditor.create({
  doc: document, text: noteText, context: window.NodaProjectContext,
  getTitle: () => selectedNoteTitle, getDetail: () => selectedNoteDetail,
  getVault: notesLiveApplication.getVault, request: apiRequest, readDetail: notesLiveApplication.readDetail,
  prepare: async () => { await inlineEditor.autoSave(); return !inlineEditor.isDirty(); },
  setBusy: value => { noteWritePending = value; inlineEditor.setDisabled(value); },
  onSaved: async ({ detail, result }) => {
    if (detail) { inlineEditor.close(); renderNoteView(detail); }
    try { await loadNotes(); } catch { /* Saved metadata is already durable. */ }
    if (!detail || result.cache_updated === false) setStatus("warn", noteText(
      "Свойства сохранены. Обновление поиска пока не подтверждено.", "Properties saved. Search refresh is not confirmed yet."));
  },
  onError: message => typeof message === "string" ? setStatus("warn", message)
    : setStatus("error", noteText("Не удалось открыть свойства заметки.", "Could not open note properties.")),
});
inlineEditor.inputElement.addEventListener("input", () => {
  if (!inlineEditor.isDirty() && notesStatusCard.classList.contains("warn") && [
    noteText("Сохраните текст заметки перед изменением заголовка и тегов.", "Save the note text before changing its title or tags."),
    noteText("Сначала сохраните правки или сохраните их отдельно.", "Save your changes or save a copy first."),
  ].includes(notesStatusText.textContent)) setStatus("ok", "");
});

function setStatus(type, message) {
  notesStatusCard.classList.remove("ok", "warn", "error");
  if (type) {
    notesStatusCard.classList.add(type);
  }
  notesStatusText.textContent = message;
  notesStatusCard.hidden = activeNotesTab !== "notes" || !["warn", "error"].includes(type);
}

function formatTags(tags) {
  return Array.isArray(tags) ? tags.filter(Boolean).join(", ") : "";
}

function parseNoteTimestamp(timestampValue) {
  if (timestampValue === undefined || timestampValue === null || timestampValue === "") {
    return 0;
  }
  if (typeof timestampValue === "number") {
    return timestampValue > 1000000000000 ? timestampValue : timestampValue * 1000;
  }
  const parsedNumber = Number(timestampValue);
  if (Number.isFinite(parsedNumber)) {
    return parsedNumber > 1000000000000 ? parsedNumber : parsedNumber * 1000;
  }
  const parsedDate = Date.parse(String(timestampValue));
  return Number.isFinite(parsedDate) ? parsedDate : 0;
}

function formatNoteTime(timestampValue) {
  const timestampMs = parseNoteTimestamp(timestampValue);
  if (!timestampMs) {
    return noteText("Без даты", "No date");
  }
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return noteText("Без даты", "No date");
  }
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString(noteLocale(), { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString(noteLocale(), { day: "2-digit", month: "2-digit" });
}

function noteMatchesFilter(note) {
  if (activeNotesFilter === "qdrant") {
    return Boolean(note.indexed);
  }
  if (activeNotesFilter === "tagged") {
    return Array.isArray(note.tags) && note.tags.length > 0;
  }
  if (activeNotesFilter === "recent") {
    const timestamp = parseNoteTimestamp(note.timestamp), now = Date.now();
    return timestamp > now - 7 * 86400000 && timestamp <= now;
  }
  return true;
}

function sortNotesForView(items) {
  const sortMode = notesSortSelect?.value || "newest";
  return [...items].sort((left, right) => {
    if (sortMode === "title") {
      return String(left.title || "").localeCompare(String(right.title || ""), noteLocale());
    }
    const leftTs = parseNoteTimestamp(left.timestamp);
    const rightTs = parseNoteTimestamp(right.timestamp);
    return sortMode === "oldest" ? leftTs - rightTs : rightTs - leftTs;
  });
}

function setEditorMode(creating) {
  creatingNote = Boolean(creating);
  noteCreatePanel.hidden = !creatingNote;
  noteViewEmpty.hidden = creatingNote || Boolean(selectedNoteTitle);
  noteViewPanel.hidden = creatingNote || !selectedNoteTitle;
  noteTitleInput.readOnly = !creatingNote;
  noteTagsInput.readOnly = !creatingNote;
  noteContentInput.readOnly = !creatingNote;
  noteContentInput.maxLength = 20000;
  saveNoteBtn.textContent = noteText("Создать", "Create");
  saveNoteBtn.disabled = !creatingNote || noteWritePending;
  deleteNoteBtn.disabled = creatingNote || !selectedNoteTitle;
  metadataEditor.refresh();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = API_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await window.NodaProjectContext.fetch(url, {
      cache: "no-store",
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function apiRequest(path, options = {}, timeoutMs = API_REQUEST_TIMEOUT_MS) {
  const response = await fetchWithTimeout(`${API_BASE}${path}`, options, timeoutMs);
  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    payload = {};
  }
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { code: payload.code, status: response.status });
  }
  return payload;
}

// Who: Tim Buglaev
// When: 2026-06-16
// What: Render Obsidian-flavored Markdown into a sanitized preview with local
//       attachment images and clickable wiki links, without trusting raw note
//       HTML or allowing arbitrary script/event attributes.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function encodeAssetPath(assetPath) {
  return String(assetPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function noteAssetUrl(assetPath) {
  const normalized = String(assetPath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized) || normalized.split("/").includes("..")) {
    return "";
  }
  try { return window.NodaProjectContext.assetUrl(`${API_BASE}/notes/assets/${encodeAssetPath(normalized)}`); }
  catch { return ""; }
}

function preprocessObsidianMarkdown(markdownText) {
  const options = window.notesMarkdown.createOptions({ marked: window.marked, escapeHtml, noteAssetUrl });
  const view = window.notesMarkdown.presentation(markdownText);
  return window.marked.parse(view.source, options);
}

function isSafePreviewHref(value) {
  const href = String(value || "").trim();
  return href === "#" || /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
}

function isSafePreviewImageSrc(value) {
  const src = String(value || "").trim();
  if (/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/i.test(src)) {
    return true;
  }
  try {
    const url = new URL(src);
    return url.origin === API_BASE && !url.username && !url.password && url.pathname.startsWith("/notes/assets/");
  } catch (_) {
    return false;
  }
}

function sanitizeRenderedMarkdown(markdownHtml) {
  const template = document.createElement("template");
  template.innerHTML = String(markdownHtml || "");
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const nodes = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }
  nodes.forEach((node) => sanitizeMarkdownNode(node));
  return template.content;
}

function sanitizeMarkdownNode(node) {
  if (!ALLOWED_MARKDOWN_TAGS.has(node.tagName)) {
    node.replaceWith(document.createTextNode(node.textContent || ""));
    return;
  }
  Array.from(node.attributes).forEach((attribute) => {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on") || name === "style") {
      node.removeAttribute(attribute.name);
    }
  });
  if (node.tagName === "A") {
    sanitizeMarkdownLink(node);
  } else if (node.tagName === "IMG") {
    sanitizeMarkdownImage(node);
  } else if (node.tagName === "CODE") {
    Array.from(node.attributes).forEach((attribute) => {
      if (attribute.name.toLowerCase() !== "class") {
        node.removeAttribute(attribute.name);
      }
    });
  } else {
    Array.from(node.attributes).forEach((attribute) => node.removeAttribute(attribute.name));
  }
}

function sanitizeMarkdownLink(node) {
  const title = node.getAttribute("data-note-title");
  if (title) {
    node.setAttribute("href", "#");
    node.setAttribute("class", "internal-note-link");
    node.setAttribute("data-note-title", title);
    Array.from(node.attributes).forEach((attribute) => {
      if (!["href", "class", "data-note-title", "title"].includes(attribute.name.toLowerCase())) {
        node.removeAttribute(attribute.name);
      }
    });
    return;
  }
  if (!isSafePreviewHref(node.getAttribute("href"))) {
    node.removeAttribute("href");
  }
  node.setAttribute("target", "_blank");
  node.setAttribute("rel", "noopener noreferrer");
  Array.from(node.attributes).forEach((attribute) => {
    if (!["href", "target", "rel", "title"].includes(attribute.name.toLowerCase())) {
      node.removeAttribute(attribute.name);
    }
  });
}

function sanitizeMarkdownImage(node) {
  if (!/^data:/i.test(node.getAttribute("src") || "")) {
    try { node.setAttribute("src", window.NodaProjectContext.assetUrl(node.getAttribute("src") || "")); }
    catch { node.setAttribute("src", ""); }
  }
  if (!isSafePreviewImageSrc(node.getAttribute("src"))) {
    node.replaceWith(document.createTextNode(node.getAttribute("alt") || noteText("[изображение заблокировано]", "[image blocked]")));
    return;
  }
  node.setAttribute("loading", "lazy");
  node.setAttribute("decoding", "async");
  node.setAttribute("class", "markdown-preview-image");
  Array.from(node.attributes).forEach((attribute) => {
    if (!["src", "alt", "title", "loading", "decoding", "class"].includes(attribute.name.toLowerCase())) {
      node.removeAttribute(attribute.name);
    }
  });
}

function renderMarkdownPreview(markdownText) {
  noteViewContent.replaceChildren();
  if (!window.marked || typeof window.marked.parse !== "function" || !window.notesMarkdown) {
    noteViewContent.textContent = markdownText || "";
    return;
  }
  const rendered = preprocessObsidianMarkdown(markdownText);
  noteViewContent.appendChild(sanitizeRenderedMarkdown(rendered));
}

function renderQdrantState() {
  const embedding = qdrantInfo?.embedding_status;
  const available = qdrantInfo?.available && embedding !== "disabled" && embedding !== "unavailable";
  const label = embedding === "disabled" ? noteText("Только текстовый поиск", "Text search only")
    : embedding === "unavailable" ? noteText("Модель поиска недоступна", "Search model unavailable")
    : available
    ? noteText("Qdrant активен", "Qdrant active")
    : noteText("Резервный кэш", "Cache fallback");
  if (qdrantState.textContent !== label) qdrantState.textContent = label;
  qdrantState.classList.toggle("active", Boolean(available));
}

// Who: Tim Buglaev
// When: 2026-06-19
// What: Share the loaded notes/Qdrant snapshot with the separated chat renderer
//       so the chat tab can render counts and source state without duplicating
//       the notes-panel cache lifecycle.
function syncNotesChatState() {
  if (window.notesChatController && typeof window.notesChatController.setNotesState === "function") {
    window.notesChatController.setNotesState({
      notes,
      qdrant: qdrantInfo,
    });
  }
}

function appendTagPills(row, tags) {
  row.replaceChildren();
  (tags || []).slice(0, 6).forEach((tag) => {
    const pill = document.createElement("span");
    // Who: Tim Buglaev
    // When: 2026-06-16
    // What: Color user-authored Obsidian tags deterministically by tag text so
    //       the notes dashboard shows meaningful labels instead of technical
    //       Qdrant/cache badges, while keeping rendering escaped via textContent.
    pill.className = `tag-pill tag-tone-${getTagToneIndex(tag)}`;
    pill.textContent = `#${tag}`;
    row.appendChild(pill);
  });
}

function getTagToneIndex(tag) {
  const normalized = String(tag || "").trim().toLowerCase();
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % TAG_TONE_COUNT;
}

function createNoteListItem(note) {
  return window.NotesListView.createItem(note, {
    doc: document, selectedTitle: selectedNoteTitle,
    onSelect: title => selectNote(title).catch((error) => {
      setStatus("error", noteText(`Не удалось открыть заметку: ${error.message}`, "Could not open the note."));
    }), tone: getTagToneIndex, time: formatNoteTime, text: noteText,
  });
}

function updateNoteListSelection() {
  notesList.querySelectorAll(".note-list-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.noteTitle === selectedNoteTitle);
  });
}

function renderList(preserveScroll = false) {
  const search = librarySearch.getState();
  const loading = libraryState === "loading" && !notes.length;
  const failed = libraryState === "error";
  const filtered = sortNotesForView(notes.filter(note => noteMatchesFilter(note) &&
    (search.type === "idle" || search.titles?.has(note.title))));
  let emptyText = noteText("В проекте пока нет заметок.", "This project has no notes yet.");
  if (failed) emptyText = noteText("Не удалось загрузить заметки.", "Could not load notes.");
  else if (loading || search.type === "loading") emptyText = noteText("Загружаем…", "Loading…");
  else if (search.type === "error") emptyText = noteText("Не удалось выполнить поиск.", "Could not search notes.");
  else if (notes.length || search.type === "ready") emptyText = noteText("Подходящих заметок нет.", "No matching notes.");
  libraryRetry.hidden = !failed && search.type !== "error";
  libraryError.textContent = (failed || search.type === "error") && filtered.length
    ? noteText("Показаны последние доступные результаты.", "Showing the last available results.") : "";

  const countLabel = window.nodaI18n?.count(filtered.length, ["заметка", "заметки", "заметок"], "note", "notes")
    ?? `${filtered.length} заметок`;
  if (notesCount.textContent !== String(filtered.length)) notesCount.textContent = String(filtered.length);
  notesCount.setAttribute("aria-label", countLabel);

  notesListReconciler.render(filtered, { preserveScroll, emptyText });
  updateNoteListSelection();
  projectsController?.update();
}

function searchNotes(immediate = false) {
  librarySearch.search(notesSearch.value, window.NodaProjectContext.snapshot(), immediate);
}

function draftProject() {
  return window.NodaProjectContext.snapshot().projectId || notesLiveApplication.getVault();
}

function updateDraftState(saved) {
  const message = saved == null ? "" : saved
    ? noteText("Черновик сохранён на этом устройстве.", "Draft saved on this device.")
    : noteText("Черновик сохранён до закрытия окна.", "Draft is saved until you close this window.");
  if (noteDraftState.textContent !== message) noteDraftState.textContent = message;
}

function rememberDraft() {
  if (!creatingNote) return;
  const project = draftProject();
  if (!project) {
    noteDraftState.textContent = noteText("Локальное сохранение черновика пока недоступно.", "Local draft storage is unavailable for now.");
    return;
  }
  updateDraftState(noteDrafts.write(project, null, {
    title: noteTitleInput.value, tags: noteTagsInput.value, content: noteContentInput.value,
    revision: null,
  }));
}

function clearDraft(title) {
  noteDrafts.write(draftProject(), title, null);
  updateDraftState(null);
}

function beginNewNote() {
  if (noteWritePending) return;
  noteSelectionVersion += 1;
  void inlineEditor.autoSave(); inlineEditor.close(); relatedNotes.clear();
  selectedNoteTitle = "";
  selectedNoteDetail = null;
  const project = draftProject(), draft = noteDrafts.read(project, null);
  noteTitleInput.value = draft?.title || "";
  noteTagsInput.value = draft?.tags || "";
  noteContentInput.value = draft?.content || "";
  updateDraftState(draft ? noteDrafts.isDurable(project, null) : null);
  setEditorMode(true);
  notesWorkspace.openNote();
  renderList();
  noteTitleInput.focus();
}

async function loadNotes() {
  const project = window.NodaProjectContext.snapshot();
  if (!window.NodaProjectContext.isCurrent(project)) return;
  const initial = !notes.length;
  if (initial) { libraryState = "loading"; renderList(true); }
  try { await notesLiveController.refresh(); }
  catch (error) {
    if (window.NodaProjectContext.isCurrent(project)) { libraryState = "error"; renderList(true); }
    throw error;
  }
  if (!window.NodaProjectContext.isCurrent(project)) return;
  setStatus("ok", noteText(`Загружено заметок: ${notes.length}`, `Notes loaded: ${notes.length}`));
}

function renderNoteView(payload) {
  selectedNoteDetail = payload || null;
  if (!selectedNoteDetail) {
    inlineEditor.close(); relatedNotes.clear(); notesWorkspace.clear();
    selectedNoteTitle = "";
    setEditorMode(false);
    projectsController?.update();
    return;
  }
  const resolvedTitle = selectedNoteDetail.resolved_title || selectedNoteDetail.title || noteText("Без названия", "Untitled");
  const view = window.notesMarkdown ? window.notesMarkdown.presentation(selectedNoteDetail.content) : null;
  noteViewTitle.textContent = selectedNoteDetail.display_title || (view && view.title) || resolvedTitle;
  appendTagPills(noteViewTags, Array.isArray(view?.tags) ? view.tags : selectedNoteDetail.tags || []);
  const excluded = selectedNoteDetail.index_status === "excluded_noise";
  noteViewSource.textContent = excluded ? noteText("Исключена из поиска по смыслу", "Excluded from semantic search")
    : selectedNoteDetail.indexed ? noteText("Доступна для поиска по смыслу", "Available in semantic search")
      : noteText("Поиск по смыслу недоступен", "Semantic search unavailable");
  noteViewTime.textContent = formatNoteTime(selectedNoteDetail.timestamp);
  renderMarkdownPreview(selectedNoteDetail.content || "");
  inlineEditor.open(selectedNoteTitle, selectedNoteDetail);
  relatedNotes.open(selectedNoteTitle);
  metadataEditor.refresh();
  projectsController?.notesChanged();
}

function writeProjectNotesState(state) {
  noteSelectionVersion += 1;
  notes = state.notes || []; qdrantInfo = state.qdrantInfo || {};
  selectedNoteTitle = state.selectedNoteTitle || ""; selectedNoteDetail = state.selectedNoteDetail || null;
  noteWritePending = false;
  renderNoteView(selectedNoteDetail); setEditorMode(Boolean(state.creatingNote));
  const project = draftProject();
  const draft = state.creatingNote ? noteDrafts.read(project, null) : null;
  updateDraftState(draft ? noteDrafts.isDurable(project, null) : null);
  renderQdrantState(); setActiveNotesFilter(state.activeNotesFilter || "all"); syncNotesChatState();
}

async function selectNote(title, fromWrite = false) {
  if (noteWritePending && !fromWrite) return;
  if (title !== selectedNoteTitle) void inlineEditor.autoSave();
  const version = ++noteSelectionVersion;
  let payload;
  try {
    payload = await notesLiveApplication.readDetail(title);
  } catch (error) {
    if (version !== noteSelectionVersion) return;
    throw error;
  }
  if (version !== noteSelectionVersion) return;
  const changed = selectedNoteTitle !== (payload.resolved_title || payload.title || title);
  selectedNoteTitle = payload.resolved_title || payload.title || title;
  noteTitleInput.value = selectedNoteTitle;
  noteTagsInput.value = formatTags(payload.tags);
  noteContentInput.value = payload.content || "";
  renderNoteView(payload);
  setEditorMode(false);
  notesWorkspace.openNote();
  if (changed) { noteViewContent.scrollTop = 0; document.getElementById("notes-viewer").scrollTop = 0; }
  updateNoteListSelection();
  setStatus("ok", noteText(`Открыта заметка: ${selectedNoteTitle}`, `Note opened: ${selectedNoteTitle}`));
}

function collectTagsInput() {
  return noteTagsInput.value
    .split(/[,;\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function createNote() { return noteActions.createNote(); }
function deleteSelectedNote() { return noteActions.deleteNote(); }

async function saveEditor() {
  if (!creatingNote) { await inlineEditor.retry(); return; }
  const project = window.NodaProjectContext.snapshot();
  if (noteWritePending || !window.NodaProjectContext.isCurrent(project)) return;
  noteWritePending = true; saveNoteBtn.disabled = true;
  for (const input of [noteTitleInput, noteTagsInput, noteContentInput]) input.readOnly = true;
  try { await createNote(); }
  catch {
    if (window.NodaProjectContext.isCurrent(project)) setStatus("error", noteText(
      "Не удалось создать заметку. Черновик оставлен.", "Could not create the note. Your draft is kept."));
  } finally {
    if (window.NodaProjectContext.isCurrent(project)) { noteWritePending = false; setEditorMode(creatingNote); }
  }
}

function setActiveNotesFilter(nextFilter) {
  activeNotesFilter = nextFilter || "all";
  notesFilterButtons.forEach((button) => {
    const active = button.dataset.notesFilter === activeNotesFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  renderList();
}

function setButtonText(button, text) {
  if (!button) {
    return;
  }
  const label = button.querySelector("span:last-child");
  if (label) {
    label.textContent = text;
    return;
  }
  button.textContent = text;
}

// Who: Tim Buglaev
// When: 2026-06-23
// What: Keep the shared header actions aligned with notes and settings.
function renderActiveTabChrome() {
  const isChat = activeNotesTab === "chat";
  const isSettings = activeNotesTab === "settings";
  if (notesHeroEyebrow) {
    notesHeroEyebrow.textContent = noteText("Управление заметками", "Notes library");
  }
  if (notesHeroTitle) {
    notesHeroTitle.textContent = isSettings
      ? noteText("Настройки", "Settings")
      : isChat ? noteText("Чат по заметкам", "Notes chat") : activeNotesTab === "graph" ? noteText("Граф заметок", "Note graph") : noteText("Все заметки", "All notes");
  }
  notesHeaderActions.hidden = isChat;
  setButtonText(refreshNotesBtn, isSettings ? noteText("Сбросить", "Reset") : noteText("Обновить", "Refresh"));
  newNoteBtn.querySelector(".ui-icon").dataset.uiIcon = isSettings ? "save" : "plus";
  setButtonText(newNoteBtn, isSettings
    ? noteText("Сохранить изменения", "Save changes")
    : noteText("Новая заметка", "New note"));
  notesStatusCard.hidden = activeNotesTab !== "notes" ||
    !(notesStatusCard.classList.contains("warn") || notesStatusCard.classList.contains("error"));
  notesWorkspace.tab(activeNotesTab);
}

// Who: Tim Buglaev
// When: 2026-06-23
// What: Restrict tab activation to known panels and lazily load settings through
//       its controller so malformed DOM data cannot trigger an undefined view.
function activateNotesTab(tabName) {
  if (activeNotesTab === "notes" && tabName !== "notes") noteSelectionVersion += 1;
  activeNotesTab = ["notes", "chat", "settings", "graph"].includes(tabName) ? tabName : "notes";
  notesTabButtons.forEach((button) => {
    const active = button.dataset.notesTab === activeNotesTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  notesTabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.notesPanel !== activeNotesTab;
    panel.classList.toggle("active", panel.dataset.notesPanel === activeNotesTab);
  });
  renderActiveTabChrome();
  window.notesGraphController?.activate(activeNotesTab === "graph");
  if (activeNotesTab === "notes") notesLiveController.wake();
  else notesLiveController.pause();
  syncNotesChatState();
  if (activeNotesTab === "chat" && window.notesChatController && typeof window.notesChatController.activate === "function") {
    window.notesChatController.activate();
  }
  if (activeNotesTab === "settings" && window.notesSettingsController && typeof window.notesSettingsController.activate === "function") {
    window.notesSettingsController.activate();
  }
}

refreshNotesBtn.addEventListener("click", () => {
  if (activeNotesTab === "graph") { window.notesGraphController?.refresh(); return; }
  if (activeNotesTab === "settings" && window.notesSettingsController && typeof window.notesSettingsController.reset === "function") {
    window.notesSettingsController.reset();
    return;
  }
  loadNotes().catch((error) => {
    setStatus("error", noteText(`Не удалось обновить список: ${error.message}`, "Could not refresh the notes list."));
  });
});

newNoteBtn.addEventListener("click", () => {
  if (activeNotesTab === "settings" && window.notesSettingsController && typeof window.notesSettingsController.save === "function") {
    window.notesSettingsController.save();
    return;
  }
  if (activeNotesTab === "graph") activateNotesTab("notes");
  beginNewNote();
});

notesSearch.addEventListener("input", () => {
  searchNotes();
});
document.getElementById("notes-library-retry-btn").addEventListener("click", () => {
  if (libraryState !== "error" && librarySearch.getState().type === "error") searchNotes(true);
  else loadNotes().catch(() => {});
});
document.getElementById("note-trash-btn").addEventListener("click", noteTrash.open);

if (notesSortSelect) {
  notesSortSelect.addEventListener("change", () => {
    renderList();
  });
}

notesFilterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveNotesFilter(button.dataset.notesFilter || "all");
  });
});

notesTabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) {
      return;
    }
    activateNotesTab(button.dataset.notesTab || "notes");
  });
});

saveNoteBtn.addEventListener("click", saveEditor);
for (const input of [noteTitleInput, noteTagsInput, noteContentInput]) input.addEventListener("input", rememberDraft);
document.getElementById("discard-note-draft-btn").addEventListener("click", () => {
  if (noteWritePending) return;
  const title = null;
  if (noteDrafts.read(draftProject(), title) && !window.confirm(noteText(
    "Удалить этот черновик? Сохранённая заметка останется без изменений.",
    "Discard this draft? The saved note will stay as it is."))) return;
  clearDraft(title); setEditorMode(false); notesWorkspace.clear();
});

deleteNoteBtn.addEventListener("click", async () => {
  if (noteWritePending) return;
  const project = window.NodaProjectContext.snapshot(), title = selectedNoteTitle;
  noteWritePending = true; inlineEditor.setDisabled(true);
  try {
    if (!window.NodaProjectContext.isCurrent(project) || selectedNoteTitle !== title) return;
    await deleteSelectedNote();
  } catch {
    if (window.NodaProjectContext.isCurrent(project)) setStatus("error", noteText(
      "Не удалось переместить заметку в корзину.", "Could not move the note to trash."));
  } finally {
    document.querySelector(".note-actions-menu").open = false;
    if (window.NodaProjectContext.isCurrent(project)) { noteWritePending = false; inlineEditor.setDisabled(false); }
  }
});

// Who: Tim Buglaev
// When: 2026-06-16
// What: Route Obsidian wiki-link clicks through the existing note loader so
//       related notes open in-panel without exposing arbitrary navigation.
noteViewContent.addEventListener("click", (event) => {
  const link = event.target.closest("[data-note-title]");
  if (!link || !noteViewContent.contains(link)) {
    return;
  }
  event.preventDefault();
  const targetTitle = link.getAttribute("data-note-title");
  if (!targetTitle) {
    return;
  }
  selectNote(targetTitle).catch((error) => {
    setStatus("error", noteText(`Не удалось открыть связанную заметку: ${error.message}`, "Could not open the related note."));
  });
});

// Who: Tim Buglaev
// When: 2026-06-19
// What: Let the separated chat renderer open a cited note through the existing
//       notes loader, preserving path validation/API access in the backend and
//       avoiding arbitrary navigation from chat source pills.
window.addEventListener("notes-chat:open-note", (event) => {
  if (!window.NodaProjectContext.isCurrent(event.detail?.projectContext)) return;
  const title = event.detail && event.detail.title;
  if (!title) {
    return;
  }
  activateNotesTab("notes");
  selectNote(title).then(() => {
    if (event.detail.focusEditor && window.NodaProjectContext.isCurrent(event.detail.projectContext)
        && selectedNoteTitle === title) inlineEditor.focus();
  }).catch((error) => {
    setStatus("error", noteText(`Не удалось открыть источник: ${error.message}`, "Could not open the source note."));
  });
});

window.addEventListener("noda-projects:manage", () => {
  activateNotesTab("notes");
  const target = document.querySelector('#projects-list .project-button[aria-current="true"]')
    || document.getElementById("create-project-btn");
  target?.focus({ preventScroll: true });
});

window.addEventListener("DOMContentLoaded", async () => {
  try {
    renderActiveTabChrome();
    // Who: Tim Buglaev
    // When: 2026-06-14
    // What: Block notes-panel loading behind the shared startup gate so list,
    //       create, and delete actions cannot run before Qdrant/backend are ready.
    if (!window.startupGate || typeof window.startupGate.waitForReady !== "function") {
      throw new Error("Startup gate is unavailable.");
    }
    await window.startupGate.waitForReady();
    inlineEditor.refreshLanguage(); relatedNotes.refreshLanguage(); metadataEditor.refreshLanguage(); renderActiveTabChrome();
    projectsController = window.NotesProjectsController.create({
      doc: document, context: window.NodaProjectContext, bridge: window.quickNoteBridge,
      createView: window.NotesProjectsView.create, text: noteText,
      notes: { read: () => ({ notes, qdrantInfo, selectedNoteTitle, selectedNoteDetail, creatingNote, activeNotesFilter, noteSelectionVersion }),
        write: writeProjectNotesState, status: setStatus, start: () => notesLiveController.start(),
        pause: () => notesLiveController.pause(), reset: () => {
          inlineEditor.close(); inlineEditor.setDisabled(false);
          noteTrash.close();
          libraryState = "loading"; librarySearch.reset(); notesLiveApplication.reset();
        },
        resume: () => { notesLiveController.start(); notesLiveController.wake(); },
        refresh: loadNotes, select: selectNote, newNote: beginNewNote },
    });
    await projectsController.start();
  } catch (error) {
    setStatus("error", noteText(`Служба заметок недоступна: ${error.message}`, "The notes service is unavailable."));
    // Who: Tim Buglaev
    // When: 2026-06-14
    // What: Keep editor controls blocked when startup gate fails so create/delete
    //       actions cannot become available under the loading error overlay.
    if (!document.body.classList.contains("app-loading")) {
      beginNewNote();
    }
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) notesLiveController.pause();
  else notesLiveController.wake();
});
window.addEventListener("focus", () => notesLiveController.wake());
window.addEventListener("beforeunload", () => { inlineEditor.close(); relatedNotes.dispose(); metadataEditor.dispose(); projectsController?.dispose(); notesLiveController.dispose(); }, { once: true });
