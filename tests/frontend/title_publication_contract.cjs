"use strict";

// Test bridge: actual renderer functions receive only a synthetic published note.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const raw = fs.readFileSync(0);
assert.ok(raw.length > 0 && raw.length <= 65536);
const { result, originalSource, expectedTitle } = JSON.parse(raw.toString("utf8"));
assert.equal(typeof expectedTitle, "string");
assert.equal(result.display_title, expectedTitle);
assert.notEqual(result.title, expectedTitle);

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
      add: (...items) => items.forEach((item) => this.classes.add(item)),
      remove: (...items) => items.forEach((item) => this.classes.delete(item)),
      contains: (item) => this.classes.has(item),
      toggle: (item, enabled) => enabled ? this.classes.add(item) : this.classes.delete(item),
    };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || this.children.map((item) => item.textContent).join(""); }
  set innerHTML(value) { this.htmlWrites.push(String(value)); }
  get innerHTML() { return this.htmlWrites.at(-1) || ""; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = children; this.text = ""; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(selector.startsWith(".") && (child.className || "").split(/\s+/).includes(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  addEventListener(key, callback) { this.listeners.set(key, callback); }
  closest() { return null; }
}

function renderer(filename) {
  const elements = new Map();
  const requests = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    createElement: (tag) => new Element(tag),
  };
  const context = vm.createContext({
    document, AbortController, setTimeout, clearTimeout,
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => result };
    },
    window: {
      addEventListener() {}, localStorage: { getItem: () => null },
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
    const actual = path.join(__dirname, "../../frontend", file);
    vm.runInContext(fs.readFileSync(actual, "utf8"), context, { filename: actual });
  }
  return { context, elements, requests };
}

function byClass(element, name) {
  if (element.className === name) return element;
  for (const child of element.children) {
    const found = byClass(child, name);
    if (found) return found;
  }
  return null;
}

async function verify() {
  const list = renderer("notes_renderer.js");
  await list.context.window.NodaProjectContext.ready();
  const listItem = list.context.createNoteListItem(result);
  const label = byClass(listItem, "note-list-title");
  assert.equal(label.textContent, expectedTitle);
  assert.deepEqual(label.htmlWrites, []);
  const source = list.context.window.notesMarkdown.presentation(result.content);
  assert.equal(source.title, expectedTitle);
  assert.equal(source.source, originalSource);
  listItem.children[0].listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(list.requests, [`http://127.0.0.1:5000/note-detail/${encodeURIComponent(result.title)}`]);
  assert.equal(list.elements.get("note-view-title").textContent, expectedTitle);
  assert.equal(list.elements.get("note-title-input").value, result.title);
  const preview = renderer("renderer.js");
  preview.context.renderCompletedNote(result);
  assert.ok(preview.elements.get("note-preview").innerHTML.includes(`<h3 class="note-title">${expectedTitle}</h3>`));
  assert.deepEqual(preview.requests, []);
  process.stdout.write(JSON.stringify({
    passed: true, listTitle: expectedTitle, detailTitle: expectedTitle,
    previewTitle: expectedTitle, canonicalTitle: result.title, sourceUnchanged: true,
  }));
}

verify().catch((error) => { console.error(error.message); process.exitCode = 1; });
