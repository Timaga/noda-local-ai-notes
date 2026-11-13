"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../../frontend/notes_projects_view");

class Element {
  constructor(doc, tag) {
    this.doc = doc; this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {};
    this.className = ""; this.scrollTop = 0; this.events = new Map(); this.text = "";
    this.classList = {
      add: name => { this.className = `${this.className} ${name}`.trim(); },
      toggle: (name, enabled) => {
        const values = new Set(this.className.split(" ").filter(Boolean));
        if (enabled) values.add(name); else values.delete(name); this.className = [...values].join(" ");
      },
    };
  }
  get parentElement() { return this.parent; }
  get isConnected() { return Boolean(this.parent?.isConnected || this.connected); }
  get textContent() { return this.text || this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...children) { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child, target) {
    child.remove(); const index = target ? this.children.indexOf(target) : this.children.length;
    this.children.splice(index, 0, child); child.parent = this;
  }
  remove() {
    if (!this.parent) return;
    if (this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body;
    this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null;
  }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.events.set(name, callback); }
  removeEventListener(name, callback) { if (this.events.get(name) === callback) this.events.delete(name); }
  focus(options) { this.doc.activeElement = this; this.lastFocusOptions = options; }
  click() { if (!this.disabled) this.events.get("click")?.(); }
}

function fixture(english = false) {
  const elements = new Map(), actions = [];
  const doc = {
    createElement: tag => new Element(doc, tag), createElementNS: (_ns, tag) => new Element(doc, tag),
    getElementById(id) {
      if (!elements.has(id)) { const node = new Element(doc, "div"); node.connected = true; elements.set(id, node); }
      return elements.get(id);
    },
  };
  doc.body = doc.createElement("body"); doc.activeElement = doc.body;
  doc.getElementById("layout").append(doc.getElementById("notes-projects-panel"));
  const view = create({ doc, text: (ru, en) => english ? en : ru,
    onSelect: id => actions.push(["select", id]), onCreate: () => actions.push(["create"]),
    onConnect: () => actions.push(["connect"]) });
  return { doc, view, actions, get: id => doc.getElementById(id), list: doc.getElementById("projects-list") };
}
const project = (id, extra = {}) => ({ id, name: `Project ${id}`, path: `F:/synthetic/${id}`, count: 0, ...extra });

test("literal project names and paths stay text; same folder labels use distinct opaque IDs", () => {
  const f = fixture(); const attack = '<img src=x onerror="attack()">';
  f.view.render({ projects: [project("a", { name: attack }), project("b", { name: attack, count: 20 })], activeProjectId: "a" });
  const [a, b] = f.list.children.map(row => row.children[0]);
  assert.equal(a.children[1].children[0].textContent, attack);
  assert.equal(a.children[1].children[0].children.length, 0);
  assert.equal(a.attributes["aria-current"], "true"); assert.equal(b.attributes["aria-current"], "false");
  assert.equal(b.children[2].textContent, "20"); a.click(); b.click();
  assert.deepEqual(f.actions, [["select", "a"], ["select", "b"]]);
});

test("unchanged rows and reordering preserve buttons, focused moved row and scroll", () => {
  const f = fixture(), a = project("a"), b = project("b");
  f.view.render({ projects: [a, b] }); const first = f.list.children[0], second = f.list.children[1];
  const focused = second.children[0]; focused.focus(); f.list.scrollTop = 60;
  f.view.render({ projects: [b, a], activeProjectId: "b" });
  assert.equal(f.list.children[0], second); assert.equal(f.list.children[1], first);
  assert.equal(f.doc.activeElement, focused); assert.equal(f.list.scrollTop, 60);
  f.view.render({ projects: [b, a], activeProjectId: "b" }); assert.equal(f.list.children[0].children[0], focused);
});

test("loading, unknown counts and recoverable errors have explicit accessible states", () => {
  const f = fixture(true);
  f.view.render({ projects: [project("a", { count: -1 }), project("b", { count: NaN })], activeProjectId: "a",
    pendingProjectId: "b", busy: true, message: "Opening project…", noteTitle: "Exact title" });
  assert.equal(f.get("layout").attributes["aria-busy"], "true");
  assert.equal(f.get("projects-switch-overlay").hidden, false);
  assert.equal(f.get("create-project-btn").disabled, true); assert.equal(f.get("connect-project-btn").disabled, true);
  assert.equal(f.list.children[0].children[0].children[2].textContent, "—");
  assert.equal(f.list.children[0].children[0].children[2].attributes["aria-label"], "Note count unavailable");
  assert(f.list.children[1].children[0].className.includes("is-pending"));
  assert.equal(f.get("project-breadcrumb-note").textContent, "Exact title");
  f.view.render({ projects: [project("a")], activeProjectId: "a", error: "Could not open project" });
  assert.equal(f.get("projects-switch-overlay").hidden, true);
  assert.equal(f.get("projects-message").attributes.role, "alert");
  assert.equal(f.get("create-project-btn").disabled, false);
  assert.equal(f.get("project-breadcrumb-note").hidden, true);
});

test("empty states, create/connect, teardown and invalid payloads do not fabricate projects", () => {
  const f = fixture(); f.view.render({ ready: false });
  assert.equal(f.get("projects-total").textContent, "0"); assert.equal(f.get("create-project-btn").disabled, true);
  assert.equal(f.list.children[0].className, "projects-empty");
  f.view.render({ projects: [project("a")], ready: true });
  f.get("create-project-btn").click(); f.get("connect-project-btn").click();
  assert.deepEqual(f.actions, [["create"], ["connect"]]);
  assert.throws(() => f.view.render({ projects: [project("a"), project("a")] }), /Invalid project/);
  assert.throws(() => f.view.render({ projects: [{ name: "missing identity" }] }), /Invalid project/);
  assert.equal(f.list.children.length, 1);
  f.view.render({ projects: [] }); assert.equal(f.list.children[0].className, "projects-empty");
  f.view.dispose(); f.get("create-project-btn").click(); assert.equal(f.actions.length, 2);
});

test("a busy transition restores its project button only when focus was not moved elsewhere", () => {
  const f = fixture(), projects = [project("a")]; f.view.render({ projects });
  const button = f.list.children[0].children[0]; button.focus();
  f.view.render({ projects, busy: true }); f.doc.activeElement = f.doc.body;
  f.view.render({ projects, busy: false }); assert.equal(f.doc.activeElement, button);
  f.view.render({ projects, busy: true }); const input = f.doc.createElement("input"); input.focus();
  f.view.render({ projects, busy: false }); assert.equal(f.doc.activeElement, input);
});
