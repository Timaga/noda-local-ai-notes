"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createItem, createReconciler } = require("../../frontend/notes_list_view");

class Element {
  constructor(doc, tag) {
    this.doc = doc; this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {};
    this.parent = null; this.className = ""; this.writes = 0; this.scrollTop = 0;
    this.classList = { toggle: (name, active) => {
      const names = new Set(this.className.split(" ").filter(Boolean));
      if (active) names.add(name); else names.delete(name); this.className = [...names].join(" ");
    } };
  }
  get childNodes() { return this.children; }
  get isConnected() { return this === this.doc.list || Boolean(this.parent?.isConnected); }
  set textContent(value) { this.text = String(value); this.children = []; this.writes++; }
  get textContent() { return this.text || this.children.map(child => child.textContent).join(""); }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  appendChild(node) { this.append(node); return node; }
  insertBefore(node, target) {
    node.remove(); const index = target ? this.children.indexOf(target) : this.children.length;
    this.children.splice(index, 0, node); node.parent = this; this.writes++;
  }
  remove() {
    if (!this.parent) return;
    const parent = this.parent;
    if (this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body;
    parent.children.splice(parent.children.indexOf(this), 1); parent.writes++; this.parent = null;
  }
  replaceChildren(...nodes) {
    for (const child of [...this.children]) child.remove();
    this.text = ""; this.append(...nodes); this.writes++;
  }
  querySelector(selector) {
    const className = selector.slice(1);
    for (const child of this.children) {
      if (child.className.split(" ").includes(className)) return child;
      const nested = child.querySelector(selector); if (nested) return nested;
    }
    return null;
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  getBoundingClientRect() {
    if (this === this.doc.list) return { top: 0, bottom: 120 };
    if (this.parent === this.doc.list) {
      const top = this.parent.children.indexOf(this) * 40 - this.doc.list.scrollTop;
      return { top, bottom: top + 40 };
    }
    return this.parent?.getBoundingClientRect() || { top: 0, bottom: 0 };
  }
  focus(options) { this.doc.activeElement = this; this.lastFocus = options; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, callback) { (this.events ||= {})[key] = callback; }
}

function fixture() {
  const doc = { createElement: tag => new Element(doc, tag) };
  doc.body = doc.createElement("body"); doc.list = doc.createElement("ul"); doc.activeElement = doc.body;
  let created = 0;
  const make = note => {
    created++;
    const li = doc.createElement("li"), button = doc.createElement("button"), label = doc.createElement("span");
    button.className = "note-list-button"; button.dataset.noteTitle = note.title;
    label.textContent = note.snippet || note.title; button.append(label); li.append(button); return li;
  };
  const view = createReconciler({ list: doc.list, doc, createItem: make });
  return { doc, list: doc.list, view, created: () => created };
}
const rows = names => names.map(title => ({ title, snippet: title, tags: [] }));

test("unchanged rows preserve DOM identity, focused button, and avoid writes", () => {
  const f = fixture(), notes = rows(["a", "b", "c"]);
  f.view.render(notes); const nodes = [...f.list.children], writes = f.list.writes;
  const focused = nodes[1].children[0]; focused.focus();
  f.view.render(structuredClone(notes), { preserveScroll: true });
  assert.deepEqual(f.list.children, nodes); assert.equal(f.created(), 3);
  assert.equal(f.list.writes, writes); assert.equal(f.doc.activeElement, focused);
});

test("insertion above a scrolled reader preserves the visible row anchor", () => {
  const f = fixture(); f.view.render(rows(["a", "b", "c", "d", "e", "f"]));
  f.list.scrollTop = 50; const anchor = f.list.children[1], before = anchor.getBoundingClientRect().top;
  f.view.render(rows(["new", "a", "b", "c", "d", "e", "f"]), { preserveScroll: true });
  assert.equal(anchor.getBoundingClientRect().top, before); assert.equal(f.list.scrollTop, 90);
  assert.equal(f.created(), 7);
  f.list.scrollTop = 0; f.view.render(rows(["newer", "new", "a", "b", "c"]), { preserveScroll: true });
  assert.equal(f.list.scrollTop, 0); assert.equal(f.list.children[0].children[0].dataset.noteTitle, "newer");
});

test("changed summaries patch only button contents and moving rows restores only original focus", () => {
  const f = fixture(); f.view.render(rows(["a", "b"]));
  const originalRow = f.list.children[0], button = originalRow.children[0]; button.focus();
  f.view.render([{ title: "a", snippet: "edited" }, { title: "b", snippet: "b", tags: [] }], { preserveScroll: true });
  assert.equal(f.list.children[0], originalRow); assert.equal(originalRow.children[0], button);
  assert.equal(button.textContent, "edited"); assert.equal(f.doc.activeElement, button);
  const movedButton = f.list.children[1].children[0]; movedButton.focus();
  f.view.render(rows(["b", "a"]), { preserveScroll: true });
  assert.equal(f.doc.activeElement, movedButton); assert.equal(movedButton.lastFocus.preventScroll, true);
});

test("empty/deleted/unmanaged rows are removed without auto-selecting or focusing another row", () => {
  const f = fixture(), placeholder = f.doc.createElement("li"); f.list.append(placeholder);
  f.view.render(rows(["a"])); assert.equal(placeholder.isConnected, false);
  f.list.children[0].children[0].focus(); f.view.render([], { preserveScroll: true, emptyText: "Empty" });
  assert.equal(f.list.children.length, 1); assert.equal(f.list.children[0].textContent, "Empty");
  assert.equal(f.doc.activeElement, f.doc.body); const empty = f.list.children[0], writes = empty.writes;
  f.view.render([], { emptyText: "Empty" }); assert.equal(empty.writes, writes);
  f.view.render([], { emptyText: "Ничего" }); assert.equal(empty.textContent, "Ничего");
  f.view.render(rows(["a"])); assert.equal(empty.isConnected, false);
  assert.throws(() => f.view.render(rows(["a", "a"])), /Duplicate/);
  assert.equal(f.list.children.length, 1);
});

test("list presentation remains literal and keeps the canonical click target", () => {
  const f = fixture(); const selected = [];
  const options = { doc: f.doc, selectedTitle: "canonical", onSelect: title => selected.push(title),
    tone: () => 2, time: () => "Now", text: ru => ru };
  const item = createItem({ title: "canonical", display_title: "<script>bad()</script>", snippet: "literal",
    tags: ["one", "two"], timestamp: 1 }, options);
  const button = item.children[0]; assert.equal(button.className, "note-list-button active");
  assert.equal(button.querySelector(".note-list-title").textContent, "<script>bad()</script>");
  assert.equal(button.querySelector(".tag-pill").textContent, "#one");
  button.events.click(); assert.deepEqual(selected, ["canonical"]);
  assert.equal(createItem({}, options).children[0].querySelector(".note-list-title").textContent, "Без названия");
  assert.equal(createItem({ generated_title: "Generated" }, options).children[0].querySelector(".note-list-title").textContent, "Generated");
});
