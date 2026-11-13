"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const Model = require("../../frontend/notes_graph_model.js");
class Element {
  constructor(doc) { this.doc = doc; this.children = []; this.dataset = {}; this.handlers = {}; this.hidden = false; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return this.value || this.children.map(x => x.textContent).join(""); }
  setAttribute(name, value) { this[name] = value; }
  append(...nodes) { for (const node of nodes) this.children.push(...(node.fragment ? node.children : [node])); }
  replaceChildren(...nodes) { this.children = []; this.value = ""; this.append(...nodes); }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  focus() { this.doc.activeElement = this; }
  click() { this.handlers.click?.(); }
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
  const doc = { documentElement: { lang: "en" }, activeElement: null };
  doc.createElement = () => new Element(doc);
  doc.createDocumentFragment = () => Object.assign(new Element(doc), { fragment: true });
  const host = new Element(doc), requests = [], events = [];
  let epoch = 1, vault = "a".repeat(32), language = "en", subscriber;
  const context = { snapshot: () => ({ epoch, status: "ready" }), isCurrent: owner => owner.epoch === epoch,
    subscribe: handler => { subscriber = handler; return () => {}; } };
  const root = { dispatchEvent: event => events.push(event) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../frontend/notes_related.js"), "utf8"),
    { window: root, URLSearchParams, CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } } },
    { filename: path.resolve(__dirname, "../../frontend/notes_related.js") });
  const related = root.NotesRelatedNotes.create({ doc, host, context, model: Model, getVault: () => vault,
    text: (ru, en) => language === "ru" ? ru : en,
    request: url => { const item = { url, ...deferred() }; requests.push(item); return item.promise; } });
  const payload = (nodes = ["one", "two", "three"], edges = [{ source: "one", target: "two" }, { source: "three", target: "one" }]) => ({
    nodes: nodes.map(id => typeof id === "object" ? id : ({ id, title: `Title ${id}` })), edges, vault_id: vault, revision: "1".repeat(64),
  });
  return { related, host, requests, events, doc, payload, list: () => host.children[2].children,
    language(value) { language = value; related.refreshLanguage(); },
    switch() { epoch++; vault = "b".repeat(32); subscriber(); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("editor shows outgoing and incoming saved connections, deduplicated and navigable by canonical identity", async () => {
  const f = fixture(); f.related.open("one");
  assert.match(f.host.textContent, /Loading connections/);
  assert.match(f.requests[0].url, /live=1&expected_vault_id=a{32}/);
  f.requests[0].resolve(f.payload()); await settle();
  assert.deepEqual(f.list().map(x => x.textContent), ["Title three", "Title two"]);
  assert.equal(f.host.hidden, false); f.list()[0].click();
  assert.equal(f.events[0].detail.title, "three"); assert.equal(f.events[0].detail.focusEditor, true);
  assert.equal(f.events[0].detail.projectContext.epoch, 1);
  const stale = f.list()[0]; f.related.open("two"); stale.click();
  assert.equal(f.events.length, 1, "detached old-note controls must not navigate");
  assert.deepEqual(f.list().map(x => x.dataset.noteTitle), ["one"]);
});

test("late responses and retained buttons cannot show or navigate another project", async () => {
  const f = fixture(); f.related.open("one"); const old = f.payload(); f.switch();
  f.related.open("one"); assert.equal(f.requests.length, 1, "only one graph request at a time");
  f.requests[0].resolve(old); await settle();
  assert.equal(f.list().length, 0); assert.equal(f.requests.length, 2);
  f.requests[1].resolve(f.payload()); await settle();
  const oldButton = f.list()[0]; f.switch(); oldButton.click();
  assert.equal(f.events.length, 0); assert.equal(f.host.hidden, true); assert.equal(f.list().length, 0);
});

test("automatic refresh removes deleted links, preserves focus, and accepts only matching revisions", async () => {
  const f = fixture(); f.related.open("one"); f.requests[0].resolve(f.payload()); await settle();
  f.list()[0].focus(); const refresh = f.related.refresh();
  assert.match(f.requests[1].url, /if_revision=1{64}/);
  f.requests[1].resolve({ ...f.payload(), unchanged: true }); await refresh;
  assert.equal(f.doc.activeElement.dataset.noteTitle, "three");
  const invalid = f.related.refresh(); f.requests[2].resolve({ ...f.payload(), unchanged: true, revision: "2".repeat(64) }); await invalid;
  assert.equal(f.list().length, 0); assert.match(f.host.textContent, /Could not load/);
  const retry = f.related.refresh(false); f.requests[3].resolve(f.payload(["one"], [])); await retry;
  assert.equal(f.host.hidden, true);
});

test("invalid cross-vault responses and malformed graphs fail closed, then recover automatically", async () => {
  for (const invalid of [f => ({ ...f.payload(), vault_id: "b".repeat(32) }),
    f => ({ ...f.payload(), edges: [{ source: "one", target: "missing" }] }),
    f => ({ ...f.payload(), revision: "invalid" })]) {
    const f = fixture(); f.related.open("one"); f.requests[0].resolve(invalid(f)); await settle();
    assert.equal(f.list().length, 0); assert.match(f.host.textContent, /Could not load/);
    const retry = f.related.refresh(false); f.requests[1].resolve(f.payload()); await retry;
    assert.equal(f.list().length, 2);
  }
});

test("literal titles, pagination and language changes preserve all connections without HTML rendering", async () => {
  const f = fixture(), attack = '<img src=x onerror="attack()">';
  const nodes = ["one", ...Array.from({ length: 71 }, (_, i) => ({ id: `folder/${i}`, title: i ? `Title ${i}` : attack }))];
  const edges = nodes.slice(1).map(node => ({ source: "one", target: node.id }));
  f.related.open("one"); f.requests[0].resolve(f.payload(nodes, edges)); await settle();
  assert.equal(f.list().length, 51); assert.equal(f.list()[0].textContent, attack);
  assert.equal(f.list()[0].children.length, 0); f.list().at(-1).click(); assert.equal(f.list().length, 71);
  f.language("ru"); assert.equal(f.host.children[0].textContent, "Связанные заметки");
  f.related.dispose(); assert.equal(f.host.hidden, true);
});

test("failed transport is contained and empty notes have no empty panel or invented links", async () => {
  const f = fixture(); f.related.open("one"); f.requests[0].reject(new Error("offline")); await settle();
  assert.match(f.host.textContent, /Could not load/); assert.equal(f.list().length, 0);
  const retry = f.related.refresh(false); f.requests[1].resolve(f.payload(["one"], [])); await retry;
  assert.equal(f.host.hidden, true); await f.related.refresh(false); assert.equal(f.requests.length, 2);
  f.related.clear(); assert.equal(f.host.hidden, true);
});
