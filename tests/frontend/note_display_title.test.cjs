const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const path = require("node:path");

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.value = "";
    this.dataset = {};
    this.htmlWrites = [];
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = {
      add: (...values) => values.forEach((value) => this.classes.add(value)),
      remove: (...values) => values.forEach((value) => this.classes.delete(value)),
      contains: (value) => this.classes.has(value),
      toggle: (value, enabled) => enabled ? this.classes.add(value) : this.classes.delete(value),
    };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || this.children.map((child) => child.textContent).join(""); }
  set innerHTML(value) { this.htmlWrites.push(String(value)); }
  get innerHTML() { return this.htmlWrites.at(-1) || ""; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = children; this.text = ""; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(selector.startsWith(".") && (child.className || "").split(/\s+/).includes(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  closest() { return null; }
}

function loadRenderer(filename, response = {}) {
  const elements = new Map();
  const requests = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => new Element(tag),
  };
  const context = vm.createContext({
    document, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => response };
    },
    window: {
      addEventListener() {},
      localStorage: { getItem: () => null },
      // Presentation-only adapters; the complete editor is covered by notes_workspace.electron.cjs.
      NotesWorkspace: { create: () => ({ clear() {}, openNote() {} }) },
      NotesInlineEditor: { create: () => ({ inputElement: document.getElementById("note-inline-content"), isDirty: () => false, flush: async () => true, autoSave: async () => true, close() {}, open() {} }) },
      NotesMetadataEditor: { create: () => ({ refresh() {}, dispose() {} }) },
      NotesRelatedNotes: { create: () => ({ open() {}, clear() {}, refresh() {}, dispose() {} }) },
      GenerationQueueClient: { create: () => ({}) },
      QuickCaptureProject: require("../../frontend/quick_capture_project.js"),
      NodaProjectContext: { subscribe: () => () => {}, snapshot: () => ({ status: "ready" }), isCurrent: () => true },
    },
  });
  if (filename === "notes_renderer.js") {
    context.window.NodaProjectContext = require("../../frontend/project_context.js").createProjectContext({
      legacyMode: true, fetch: (...args) => context.fetch(...args), Headers, AbortController,
    });
  }
  const files = filename === "notes_renderer.js"
    ? ["notes_markdown.js", "notes_list_view.js", "notes_live_application.js", "notes_live_sync.js", "notes_note_actions.js", "notes_library_tools.js", filename]
    : ["notes_markdown.js", filename];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, "../../frontend", file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  return { context, elements, requests };
}

function findClass(node, className) {
  if (node.className === className) return node;
  for (const child of node.children) {
    const match = findClass(child, className);
    if (match) return match;
  }
  return null;
}

function wrap(headline) {
  const source = "Synthetic source";
  const digest = crypto.createHash("sha256").update(source).digest("hex");
  return ["---", `title: ${JSON.stringify(headline)}`, "tags: []", "related: []",
    'noda_source_version: "faithful-v1"', `noda_source_sha256: "${digest}"`,
    `noda_source_length: ${source.length}`, "---", source].join("\n");
}

test("list uses headline fallbacks while preserving literal text and payload identities", () => {
  const { context } = loadRenderer("notes_renderer.js");
  const attack = '<img src=x onerror="attack()"> & C#?';
  for (const [fields, expected] of [
    [{ title: "Canonical ID", generated_title: "Generated", display_title: attack }, attack],
    [{ title: "Canonical ID", generated_title: "Generated" }, "Generated"],
    [{ title: "Canonical ID", display_title: "" }, "Canonical ID"],
    [{}, "Без названия"],
  ]) {
    const before = structuredClone(fields);
    const item = context.createNoteListItem(fields);
    const label = findClass(item, "note-list-title");
    assert.equal(label.textContent, expected);
    assert.deepEqual(label.htmlWrites, []);
    assert.equal(label.children.length, 0);
    assert.deepEqual(fields, before);
  }
});

test("duplicate visible headlines open distinct canonical URLs and keep selection canonical", async () => {
  const headline = '<script>attack()</script>: C#?';
  for (const canonical of ["Canonical file", "Canonical file 2"]) {
    const response = { title: canonical, resolved_title: canonical, content: wrap(headline), tags: [] };
    const { context, elements, requests } = loadRenderer("notes_renderer.js", response);
    await context.window.NodaProjectContext.ready();
    const item = context.createNoteListItem({ title: canonical, display_title: headline });
    const button = item.children[0];
    elements.get("notes-list").appendChild(item);
    button.listeners.get("click")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `http://127.0.0.1:5000/note-detail/${encodeURIComponent(canonical)}`);
    assert.equal(vm.runInContext("selectedNoteTitle", context), canonical);
    assert.equal(elements.get("note-title-input").value, canonical);
    assert.equal(elements.get("note-view-title").textContent, headline);
    assert.deepEqual(elements.get("note-view-title").htmlWrites, []);
    assert(button.classList.contains("active"));
    assert.equal(button.dataset.noteTitle, canonical);
    const active = context.createNoteListItem({ title: canonical, display_title: headline });
    assert(active.children[0].classList.contains("active"));
  }
});

test("completed preview escapes every headline fallback and leaves result identity untouched", () => {
  const { context, elements, requests } = loadRenderer("renderer.js");
  const attack = '<img src=x onerror="attack()"> & C#?';
  const escaped = '&lt;img src=x onerror=&quot;attack()&quot;&gt; &amp; C#?';
  for (const fields of [
    { title: "Canonical file", display_title: attack, generated_title: "Generated" },
    { title: "Canonical file", generated_title: attack },
    { title: attack },
  ]) {
    const result = { ...fields, content: "Exact source", tags: [] };
    const before = structuredClone(result);
    context.renderCompletedNote(result);
    const html = elements.get("note-preview").innerHTML;
    assert(html.includes(`<h3 class="note-title">${escaped}</h3>`));
    assert(!html.includes("<img"));
    assert(html.includes("Exact source"));
    assert.deepEqual(result, before);
  }
  context.renderCompletedNote({ title: "Canonical file", display_title: "", generated_title: "" });
  assert(elements.get("note-preview").innerHTML.includes('class="note-title">Canonical file</h3>'));
  context.renderCompletedNote({});
  assert(elements.get("note-preview").innerHTML.includes('class="note-title">Новая заметка</h3>'));
  assert.deepEqual(requests, []);
});
