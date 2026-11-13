"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const A = "a".repeat(32), B = "b".repeat(32);
const BASE = "notes-panel-rag-chats-v1";
const source = file => fs.readFileSync(path.resolve(__dirname, "../../frontend", file), "utf8");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(doc, tag = "div") {
    this.doc = doc; this.tagName = tag; this.children = []; this.dataset = {}; this.events = new Map();
    this.className = ""; this.value = ""; this.scrollTop = 0; this.scrollHeight = 100; this.text = "";
    this.classList = { toggle: (name, enabled) => {
      const names = new Set(this.className.split(" ").filter(Boolean));
      if (enabled) names.add(name); else names.delete(name); this.className = [...names].join(" ");
    }, contains: name => this.className.split(" ").includes(name), remove: name => this.classList.toggle(name, false) };
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
  get parentElement() { return this.parent; }
  set textContent(value) { this.text = String(value); this.children = []; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = []; this.text = ""; this.append(...children); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  getClientRects() { return [{}]; }
  focus() { this.doc.activeElement = this; }
  click() { if (this.tagName === "a") this.doc.download = { url: this.href, file: this.download }; }
  addEventListener(name, fn) { this.events.set(name, fn); }
  removeEventListener(name) { this.events.delete(name); }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name] ?? null; }
  removeAttribute(name) { delete this[name]; }
  play() { this.playing = true; return Promise.resolve(); }
  pause() { this.playing = false; }
  load() { this.unloaded = true; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)])
      .filter(child => selector.startsWith(".") && child.className.split(" ").includes(selector.slice(1)));
  }
  closest(selector) { return selector === "[data-note-title]" && this.dataset.noteTitle ? this : this.parent?.closest(selector); }
  async fire(name, event = {}) { return this.events.get(name)?.({ preventDefault() {}, target: this, ...event }); }
}

function chat(title = "Legacy history") {
  return { id: "old-chat", title, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    messages: [{ id: "old-message", role: "user", text: title, createdAt: "2026-01-01T00:00:00Z" }] };
}

async function fixture(options = {}) {
  const nodes = new Map(), storage = new Map(Object.entries(options.storage || {})), calls = [], events = [], timers = new Map();
  const visibilityListeners = new Set();
  const doc = { addEventListener: (_name, fn) => visibilityListeners.add(fn),
    removeEventListener: (_name, fn) => visibilityListeners.delete(fn),
    createElement: tag => new Element(doc, tag), getElementById: id => {
    if (!nodes.has(id)) nodes.set(id, new Element(doc)); return nodes.get(id);
  } };
  doc.activeElement = new Element(doc);
  let listener, serial = 1;
  const controls = { hold: null, pending: null, holdReadiness: null, denyStorage: false };
  const schedule = (callback, delay) => { const timer = {}; timers.set(timer, { callback, delay }); return timer; };
  const cancel = timer => timers.delete(timer);
  function payload(id = A, status = "ready") {
    const projects = [A, B].map(id => ({ id, name: `Project ${id}`, notesDirectory: `C:\\Synthetic\\${id}`,
      collectionName: `synthetic_${id}`, noteCount: null, legacy: id === A && Boolean(options.legacy) }));
    return { ok: true, mode: "projects", status, projects,
      activeProjectId: id, activeProject: { ...projects.find(project => project.id === id), legacyChatStorage: id === A && Boolean(options.legacy) },
      context: { project_id: id, context_token: serial.toString(16).padStart(32, "0") } };
  }
  const bridge = { getProjects: async () => payload(), onProjectState: fn => { listener = fn; return () => {}; },
    ensureChatRuntimeReady: context => { calls.push({ readiness: context }); return controls.holdReadiness?.promise || Promise.resolve({ ok: true }); } };
  const window = { quickNoteBridge: options.missingHelper ? bridge : options.browser ? undefined : bridge,
    crypto: { randomUUID: (() => { let n = 0; return () => String(++n); })() },
    addEventListener: () => {}, dispatchEvent: event => events.push(event), confirm: () => true,
    console, setTimeout: schedule, clearTimeout: cancel, AbortController, Headers,
    nodaI18n: { t: (ru, en) => options.english ? en : ru, count: () => undefined,
      locale: () => "en-US", isEnglish: () => Boolean(options.english) } };
  window.fetch = async (url, init) => {
    const headers = new Headers(init.headers), id = headers.get("X-Noda-Project-Id");
    calls.push({ url, id, token: headers.get("X-Noda-Project-Context"), signal: init.signal, body: JSON.parse(init.body) });
    const response = new Response(JSON.stringify({ response: `${id || "legacy"} answer`, context: [{ title: `${id || "legacy"} source` }] }));
    if (controls.hold) {
      controls.pending = deferred();
      if (controls.hold === "json") response.json = () => controls.pending.promise;
      else return controls.pending.promise;
    }
    return response;
  };
  const localStorage = {
    getItem: key => { if (controls.denyStorage) throw new Error("Synthetic blocked storage"); return storage.get(key) ?? null; },
    setItem: (key, value) => { if (controls.denyStorage) throw new Error("Synthetic full storage"); storage.set(key, String(value)); },
  };
  class ExportURL extends URL {
    static createObjectURL(blob) { controls.exportedBlob = blob; return "blob:test-chat-export"; }
    static revokeObjectURL(url) { controls.revokedUrl = url; }
  }
  const context = vm.createContext({ window, document: doc, Element, localStorage, AbortController, Blob, Headers, URL: ExportURL, Response,
    setTimeout: schedule, clearTimeout: cancel, fetch: (...args) => window.fetch(...args),
    CustomEvent: class { constructor(type, data) { this.type = type; this.detail = data.detail; } } });
  if (!options.missingHelper) {
    vm.runInContext(source("project_context.js"), context, { filename: path.resolve("frontend/project_context.js") });
    await window.NodaProjectContext.ready();
  }
  vm.runInContext(source("notes_chat_search.js"), context, { filename: path.resolve("frontend/notes_chat_search.js") });
  vm.runInContext(source("notes_chat_renderer.js"), context, { filename: path.resolve("frontend/notes_chat_renderer.js") });
  const get = id => doc.getElementById(`chat-${id}`);
  return { window, doc, storage, calls, controls, events, get, timers, visibilityListeners,
    metadata() { listener(payload()); },
    async switch(id, status = "ready") { serial += 1; listener(payload(id, status)); await tick(); },
    async send(text) { get("input").value = text; return get("form").fire("submit"); },
    dispose() { window.NodaProjectContext?.dispose(); } };
}

test("project histories, drafts, search, selection and scroll restore independently A→B→A", async t => {
  const f = await fixture(); t.after(() => f.dispose());
  await f.send("Question A");
  f.get("input").value = "Draft A"; await f.get("input").fire("input");
  f.get("search").value = "Question A"; await f.get("search").fire("input");
  f.get("history-list").scrollTop = 77; await f.get("history-list").fire("scroll");
  await f.switch(B);
  assert.equal(f.get("input").value, ""); assert.equal(f.get("search").value, "");
  assert.doesNotMatch(f.get("messages").textContent, /Question A|aaaa/);
  await f.send("Question B");
  f.get("input").value = "Draft B"; await f.get("input").fire("input");
  await f.switch(A);
  assert.equal(f.get("input").value, "Draft A"); assert.equal(f.get("search").value, "Question A");
  assert.equal(f.get("history-list").scrollTop, 77); assert.match(f.get("messages").textContent, /Question A/);
  assert.doesNotMatch(f.get("messages").textContent, /Question B|bbbb/);
  assert.ok(f.storage.has(`${BASE}:${A}`)); assert.ok(f.storage.has(`${BASE}:${B}`)); assert.equal(f.storage.has(BASE), false);
});

test("only explicit legacy project copies old history once, retaining its original", async t => {
  const original = JSON.stringify([chat()]), f = await fixture({ legacy: true, storage: { [BASE]: original } });
  t.after(() => f.dispose());
  assert.match(f.get("messages").textContent, /Legacy history/);
  assert.equal(f.storage.get(BASE), original); assert.equal(f.storage.get(`${BASE}:${A}:legacy-imported`), "1");
  await f.switch(B); assert.doesNotMatch(f.get("messages").textContent, /Legacy history/);
  f.storage.set(BASE, JSON.stringify([chat("Changed global history")]));
  f.storage.delete(`${BASE}:${A}`); await f.switch(A);
  assert.doesNotMatch(f.get("messages").textContent, /Changed global history/);
});

test("ordinary new projects do not import global history", async t => {
  const f = await fixture({ storage: { [BASE]: JSON.stringify([chat()]) } }); t.after(() => f.dispose());
  assert.doesNotMatch(f.get("messages").textContent, /Legacy history/);
  assert.equal(f.storage.has(`${BASE}:${A}:legacy-imported`), false);
});

for (const phase of ["fetch", "json"]) test(`late ${phase} RAG A cannot publish or unlock B`, async t => {
  const f = await fixture(); t.after(() => f.dispose()); f.controls.hold = phase;
  const old = f.send("Pending A"); await tick();
  const pending = f.controls.pending, oldHttp = f.calls.find(call => call.url);
  await f.switch(B); assert.equal(oldHttp.signal.aborted, true);
  f.controls.hold = "fetch";
  const current = f.send("Pending B"); await tick(); const currentPending = f.controls.pending;
  pending.resolve(phase === "json" ? { response: "LEAK A", context: [{ title: "LEAK SOURCE" }] }
    : new Response(JSON.stringify({ response: "LEAK A" })));
  await old;
  assert.equal(f.get("input").disabled, true); assert.doesNotMatch(f.get("messages").textContent, /Pending A|LEAK/);
  currentPending.resolve(new Response(JSON.stringify({ response: "B only", context: [] })));
  await current;
  assert.equal(f.get("input").disabled, false); assert.match(f.get("messages").textContent, /B only/);
  await f.switch(A);
  assert.doesNotMatch(f.get("messages").textContent, /LEAK/); assert.equal(f.get("messages").querySelectorAll(".pending").length, 0);
});

test("captured context reaches readiness and RAG headers; switch during readiness never replays HTTP", async t => {
  const f = await fixture(); t.after(() => f.dispose()); f.controls.holdReadiness = deferred();
  const pending = f.send("A runtime pending"); await tick();
  const readiness = f.calls.find(call => call.readiness).readiness;
  assert.equal(readiness.projectId, A); assert.equal(readiness.contextToken, "1".padStart(32, "0"));
  await f.switch(B); f.controls.holdReadiness.resolve({ ok: true }); await pending;
  assert.equal(f.calls.filter(call => call.url).length, 0);
  f.controls.holdReadiness = null; await f.send("B fresh");
  assert.equal(f.calls.find(call => call.url).id, B);
});

test("stale source buttons cannot navigate after switch, while current sources carry scope", async t => {
  const f = await fixture(); t.after(() => f.dispose()); await f.send("A source question");
  const old = f.get("messages").querySelectorAll(".chat-source-pill")[0];
  await f.get("messages").fire("click", { target: old }); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].detail.projectContext.projectId, A);
  await f.switch(B); await f.get("messages").fire("click", { target: old }); assert.equal(f.events.length, 1);
  await f.switch(A); await f.get("messages").fire("click", { target: old }); assert.equal(f.events.length, 1);
});

test("switching/error fail closed and browser no-bridge legacy still works", async t => {
  const f = await fixture(); t.after(() => f.dispose()); await f.switch(A, "switching");
  assert.equal(f.get("input").disabled, true); await f.send("Forbidden during switch");
  assert.equal(f.calls.length, 0); assert.match(f.get("subtitle").textContent, /Переключение/);
  const missing = await fixture({ missingHelper: true }); t.after(() => missing.dispose());
  assert.equal(missing.get("input").disabled, true); assert.match(missing.get("subtitle").textContent, /недоступен/);
  await missing.send("Forbidden missing helper"); assert.equal(missing.calls.length, 0);
  const legacy = await fixture({ browser: true }); t.after(() => legacy.dispose());
  await legacy.send("Browser question"); assert.equal(legacy.calls.find(call => call.url).id, null);
  assert.ok(legacy.storage.has(BASE));
});

test("model response is literal text, current failure is safe and UI stays usable", async t => {
  const f = await fixture({ english: true }); t.after(() => f.dispose());
  f.window.fetch = async () => new Response(JSON.stringify({ response: '<img src=x onerror="attack()">', context: [] }));
  await f.send("Literal response"); assert.match(f.get("messages").textContent, /<img src=x/);
  f.window.fetch = async () => { throw new Error("PRIVATE SYNTHETIC INTERNAL FAILURE"); };
  await f.send("Fail safely"); assert.equal(f.get("input").disabled, false);
  assert.match(f.get("messages").textContent, /Could not get an answer/);
  assert.doesNotMatch(f.get("messages").textContent, /PRIVATE SYNTHETIC/);
});

test("readiness timeout is bounded without HTTP replay and releases the composer", async t => {
  const f = await fixture(); t.after(() => f.dispose()); f.controls.holdReadiness = deferred();
  const pending = f.send("Runtime timeout"); await tick();
  const timeout = [...f.timers.values()].find(timer => timer.delay === 180000);
  assert.ok(timeout); timeout.callback(); await pending;
  assert.equal(f.get("input").disabled, false); assert.equal(f.calls.filter(call => call.url).length, 0);
  assert.match(f.get("messages").textContent, /Ответ занял слишком много времени/);
  f.controls.holdReadiness.resolve({ ok: true }); await tick();
  assert.equal(f.calls.filter(call => call.url).length, 0); assert.equal(f.timers.size, 0);
});

test("long answer and ten clickable sources remain intact after reopening the project", async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const answer = "План работ и подтверждённые сроки.\n\n".repeat(210) + "Заключительный пункт готов.";
  const sources = Array.from({ length: 10 }, (_, index) => ({ title: `Заметка ${index + 1}` }));
  let requestedLimit;
  f.window.fetch = async (_url, init) => {
    requestedLimit = JSON.parse(init.body).limit;
    return new Response(JSON.stringify({ response: answer, context: sources }));
  };
  await f.send("Собери полный план работ");
  await f.switch(B); await f.switch(A);
  const messages = f.get("messages");
  assert.equal(requestedLimit, 10);
  assert.ok(messages.querySelectorAll(".chat-message-text").some(node => node.textContent === answer));
  const buttons = messages.querySelectorAll(".chat-source-pill");
  assert.deepEqual(buttons.map(button => button.textContent), sources.map(source => source.title));
  await messages.fire("click", { target: buttons[9] });
  assert.equal(f.events.at(-1).detail.projectContext.projectId, A);
});

test("a running answer gets its own bounded wait after the model is ready", async t => {
  const f = await fixture(); t.after(() => f.dispose());
  f.window.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const pending = f.send("Подготовь развёрнутый ответ");
  await tick();
  assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [600000]);
  [...f.timers.values()][0].callback();
  await pending;
  assert.equal(f.get("input").disabled, false);
  assert.match(f.get("messages").textContent, /Ответ занял слишком много времени/);
  assert.equal(f.timers.size, 0);
});

test("metadata notifications retain drafts; selected conversations survive project changes", async t => {
  const f = await fixture(); t.after(() => f.dispose()); await f.send("First A chat");
  const first = f.get("history-list").querySelectorAll(".chat-history-item")[0].dataset.chatId;
  f.window.notesChatController.startNewChat(); await f.send("Second A chat");
  await f.get("history-list").querySelectorAll(".chat-history-item").find(node => node.dataset.chatId === first).fire("click");
  f.get("input").value = "Unsent A draft"; await f.get("input").fire("input");
  f.metadata(); assert.equal(f.get("input").value, "Unsent A draft");
  await f.switch(B); f.window.notesChatController.startNewChat(); await f.switch(A);
  assert.equal(f.get("title").textContent, "First A chat"); assert.equal(f.get("input").value, "Unsent A draft");
  f.window.notesChatController.activate(); assert.equal(f.doc.activeElement, f.get("input"));
  f.window.notesChatController.setNotesState({ notes: [{ title: "A note" }], qdrant: { available: true } });
  assert.equal(f.get("qdrant-state").textContent, "Qdrant активен");
  await f.get("menu-btn").fire("click"); assert.equal(f.get("messages").textContent.includes("First A chat"), false);
});

test("malformed or blocked local storage cannot mix histories or break current RAG", async t => {
  const f = await fixture({ storage: { [`${BASE}:${A}`]: "{bad json" } }); t.after(() => f.dispose());
  assert.match(f.get("messages").textContent, /Задайте вопрос/);
  f.controls.denyStorage = true; await f.send("A volatile message");
  f.get("input").value = "Volatile draft"; await f.get("input").fire("input");
  await f.switch(B); assert.doesNotMatch(f.get("messages").textContent, /A volatile|Volatile draft/);
  await f.send("B volatile message"); assert.match(f.get("messages").textContent, /B volatile message/);
  assert.equal(f.get("input").disabled, false);
});

test("HTTP denial and malformed JSON have safe local errors and retain project separation", async t => {
  const f = await fixture(); t.after(() => f.dispose());
  f.window.fetch = async () => new Response(JSON.stringify({ error: "SYNTHETIC PRIVATE ERROR" }), { status: 409 });
  await f.send("Denied question"); assert.match(f.get("messages").textContent, /Не удалось получить ответ/);
  assert.doesNotMatch(f.get("messages").textContent, /SYNTHETIC PRIVATE ERROR/);
  f.window.fetch = async () => new Response("not json"); await f.send("Malformed answer");
  assert.equal(f.get("input").disabled, false); await f.switch(B);
  assert.doesNotMatch(f.get("messages").textContent, /Denied question|Malformed answer/);
});

test("search and model failures show distinct safe messages after restoring the project chat", async t => {
  const f = await fixture({ english: true }); t.after(() => f.dispose());
  for (const code of ["qdrant_unavailable", "chat_model_unavailable"]) {
    f.window.fetch = async () => new Response(JSON.stringify({ code, error: "SYNTHETIC PRIVATE ERROR" }), { status: 503 });
    await f.send("Synthetic question");
  }
  await f.switch(B);
  await f.switch(A);
  assert.match(f.get("messages").textContent, /Note search is temporarily unavailable/);
  assert.match(f.get("messages").textContent, /The chat model is unavailable/);
  assert.doesNotMatch(f.get("messages").textContent, /SYNTHETIC PRIVATE ERROR/);
});

test("corrupt project session metadata cannot discard valid saved conversations", async t => {
  const f = await fixture({ storage: { [`${BASE}:${A}`]: JSON.stringify([chat("Saved A conversation")]),
    [`${BASE}:${A}:state`]: "{corrupt state" } }); t.after(() => f.dispose());
  assert.match(f.get("messages").textContent, /Saved A conversation/);
  assert.equal(f.get("input").value, ""); await f.switch(B); await f.switch(A);
  assert.match(f.get("messages").textContent, /Saved A conversation/);
});

for (const english of [false, true]) test(`search animation has an external ${english ? "EN" : "RU"} caption and leaves on success`, async t => {
  const f = await fixture({ english }); t.after(() => f.dispose());
  f.controls.hold = "fetch";
  const pending = f.send("Synthetic pending question"); await tick();
  const messages = f.get("messages"), search = messages.querySelectorAll(".chat-search-status");
  assert.equal(search.length, 1);
  const video = messages.querySelectorAll(".chat-search-video")[0];
  const media = messages.querySelectorAll(".chat-search-media")[0];
  assert.equal(media.textContent, "", "animated media contains no language-specific text");
  assert.equal(messages.querySelectorAll(".chat-search-caption")[0].textContent,
    english ? "Looking for an answer in your notes..." : "Ищу ответ по заметкам...");
  assert.equal(video.playing, true);
  f.controls.pending.resolve(new Response(JSON.stringify({ response: "Final synthetic answer", context: [] })));
  await pending;
  assert.equal(messages.querySelectorAll(".chat-search-status").length, 0);
  assert.equal(video.playing, false); assert.equal(video.unloaded, true);
  assert.equal(f.visibilityListeners.size, 0);
  assert.match(messages.textContent, /Final synthetic answer/);
});

test("search animation is disposed on failure, conversation change and project switch", async t => {
  const f = await fixture(); t.after(() => f.dispose());
  for (const action of ["failure", "conversation", "project"]) {
    f.controls.hold = "fetch";
    const pending = f.send(`Synthetic ${action}`); await tick();
    const response = f.controls.pending;
    const video = f.get("messages").querySelectorAll(".chat-search-video")[0];
    assert.ok(video);
    if (action === "failure") response.resolve(new Response("{}", { status: 503 }));
    else {
      if (action === "conversation") f.window.notesChatController.startNewChat();
      else await f.switch(B);
      assert.equal(video.playing, false); assert.equal(video.unloaded, true);
      assert.equal(f.get("messages").querySelectorAll(".chat-search-status").length, 0);
      response.resolve(new Response(JSON.stringify({ response: "Old answer", context: [] })));
    }
    await pending;
    assert.equal(f.get("messages").querySelectorAll(".chat-search-status").length, 0);
    assert.equal(video.playing, false); assert.equal(video.unloaded, true);
    assert.equal(f.visibilityListeners.size, 0);
  }
});

for (const english of [false, true]) test(`chat validates 800 Unicode characters in ${english ? "English" : "Russian"}`, async t => {
  const f = await fixture({ english }); t.after(() => f.dispose());
  await f.send("😀".repeat(801));
  assert.equal(f.calls.length, 0);
  assert.equal(f.get("input").getAttribute("aria-invalid"), "true");
  assert.match(f.get("query-hint").textContent, english ? /Shorten the question to 800/ : /Сократите вопрос до 800/);
  assert.equal(f.get("input").value, "😀".repeat(801));
  await f.send("😀".repeat(800));
  assert.equal(f.calls.find(call => call.url).body.query, "😀".repeat(800));
  assert.equal(f.get("input").getAttribute("aria-invalid"), "false");
});

for (const phase of ["readiness", "fetch", "json"]) test(`stopping ${phase} unlocks the composer and retries without another user message`, async t => {
  const f = await fixture(); t.after(() => f.dispose());
  if (phase === "readiness") f.controls.holdReadiness = deferred();
  else f.controls.hold = phase;
  f.get("input").focus();
  const pending = f.send("One question");
  await tick();
  const late = f.controls.holdReadiness || f.controls.pending;
  const http = f.calls.find(call => call.url);
  assert.equal(f.get("stop-btn").hidden, false);
  assert.equal(f.doc.activeElement, f.get("stop-btn"));
  await f.get("stop-btn").fire("click");
  await pending;
  assert.equal(f.get("stop-btn").hidden, true);
  assert.equal(f.get("input").disabled, false);
  assert.equal(f.doc.activeElement, f.get("input"));
  assert.match(f.get("messages").textContent, /Ожидание ответа остановлено/);
  if (http) assert.equal(http.signal.aborted, true);
  else assert.equal(f.calls.some(call => call.url), false);

  f.controls.hold = f.controls.holdReadiness = null;
  await f.get("messages").querySelectorAll(".chat-retry-btn")[0].fire("click");
  late.resolve(phase === "json" ? { response: "Late answer" }
    : new Response(JSON.stringify({ response: "Late answer" })));
  await tick();
  assert.doesNotMatch(f.get("messages").textContent, /Late answer/);
  const saved = JSON.parse(f.storage.get(`${BASE}:${A}`))[0].messages;
  assert.equal(saved.length, 2);
  assert.equal(saved[0].text, "One question");
  assert.match(saved[1].text, /answer$/);
  assert.deepEqual(f.calls.filter(call => call.url).at(-1).body.history, []);
  assert.equal(f.timers.size, 0);
});

test("search reaches long, earlier turns and reports misses without leaking between projects", async t => {
  const f = await fixture(); t.after(() => f.dispose());
  await f.send(`${"A".repeat(105)} Beyond the preview`);
  await f.send("Different later question");
  f.get("search").value = "beyond the preview";
  await f.get("search").fire("input");
  assert.equal(f.get("history-list").querySelectorAll(".chat-history-item").length, 1);
  await f.switch(B);
  f.get("search").value = "beyond the preview";
  await f.get("search").fire("input");
  assert.match(f.get("history-list").textContent, /В истории ничего не найдено/);
});

test("export is local, project-scoped and works even when history storage fails", async t => {
  const f = await fixture({ english: true }); t.after(() => f.dispose());
  assert.equal(f.get("export-btn").disabled, true);
  assert.match(f.get("storage-hint").textContent, /30 chats per project and 80 messages/);
  await f.send("A private synthetic question");
  await f.switch(B);
  f.controls.denyStorage = true;
  await f.send("B private synthetic question");
  assert.match(f.get("storage-hint").textContent, /Chat history could not be saved or read/);
  await f.get("export-btn").fire("click");
  assert.match(f.doc.download.file, /^noda-chats-\d{4}-\d{2}-\d{2}\.json$/);
  const archive = JSON.parse(await f.controls.exportedBlob.text());
  assert.equal(archive.chats[0].messages[0].text, "B private synthetic question");
  assert.doesNotMatch(JSON.stringify(archive), /A private synthetic question/);
  [...f.timers.values()].find(timer => timer.delay === 1000).callback();
  assert.equal(f.controls.revokedUrl, "blob:test-chat-export");
});

test("source excerpts survive project changes and navigation uses the current title for the cited note ID", async t => {
  const f = await fixture(); t.after(() => f.dispose());
  const source = { title: "Previous title", note_id: "exact-id", heading: "Dates", snippet: '<img src=x onerror="synthetic">' };
  f.window.fetch = async () => new Response(JSON.stringify({ response: "Answer", context: [source] }));
  await f.send("What are the dates?");
  await f.switch(B); await f.switch(A);
  const [details] = f.get("messages").querySelectorAll(".chat-citation");
  assert.match(details.textContent, /Previous title · Dates\n<img/);
  f.window.notesChatController.setNotesState({ notes: [{ title: "Current title", qdrant_id: "exact-id" }], qdrant: { available: true } });
  const [button] = f.get("messages").querySelectorAll(".chat-source-pill");
  await f.get("messages").fire("click", { target: button });
  assert.equal(f.events.at(-1).detail.title, "Current title");
  f.window.notesChatController.setNotesState({ notes: [{ title: "Previous title", qdrant_id: "other-id" }], qdrant: { available: true } });
  await f.get("messages").fire("click", { target: button });
  assert.equal(f.events.length, 1);
  assert.match(f.get("messages").textContent, /Источник больше не найден/);
});

test("search availability and an empty project show actionable, distinct states", async t => {
  const f = await fixture({ english: true }); t.after(() => f.dispose());
  assert.match(f.get("subtitle").textContent, /Checking whether note search is available/);
  f.window.notesChatController.setNotesState({ notes: [], qdrant: { available: true } });
  assert.match(f.get("messages").textContent, /Add a note to start searching/);
  f.window.fetch = async () => new Response(JSON.stringify({ code: "qdrant_unavailable" }), { status: 503 });
  await f.send("Can I search yet?");
  assert.match(f.get("subtitle").textContent, /Note search is unavailable/);
  assert.doesNotMatch(f.get("subtitle").textContent, /cache/i);
  assert.equal(f.get("messages").querySelectorAll(".chat-retry-btn").length, 1);
});

test("healthy Qdrant does not enable chat when semantic search was skipped", async t => {
  const f = await fixture({ english: true }); t.after(() => f.dispose());
  const state = embedding_status => ({ notes: [{ title: "Synthetic note" }], qdrant: { available: true, embedding_status } });
  f.window.notesChatController.setNotesState(state("disabled"));
  assert.match(f.get("subtitle").textContent, /Set up semantic search.*restart/);
  assert.match(f.get("messages").textContent, /search by text on the Notes tab/);
  assert.equal(f.get("qdrant-state").textContent, "Text search only");
  assert.equal(f.get("qdrant-state").classList.contains("active"), false);
  assert.equal(f.get("input").disabled, true);
  await f.send("Do not start a model");
  assert.equal(f.calls.length, 0);

  f.window.notesChatController.setNotesState(state("unavailable"));
  assert.match(f.get("subtitle").textContent, /could not load/);
  assert.equal(f.get("qdrant-state").classList.contains("active"), false);
  assert.equal(f.get("input").disabled, true);
  f.window.notesChatController.setNotesState(state("ready"));
  assert.equal(f.get("input").disabled, false);
  assert.equal(f.get("qdrant-state").classList.contains("active"), true);
  await f.send("Search now");
  assert.equal(f.calls.filter(call => call.url).length, 1);
});
