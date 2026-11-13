"use strict";

const assert = require("node:assert/strict"), test = require("node:test");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const nodaLanguages = require("../../frontend/ui_languages");
const clone = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Element {
  constructor(id) {
    Object.assign(this, { id, textContent: "", value: "", checked: false, disabled: false,
      hidden: false, className: "", dataset: {}, attributes: {}, children: [], events: {}, selectors: {} });
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(" "); },
      toggle: (name, force) => { const on = force ?? !this.classList.contains(name); this.classList[on ? "add" : "remove"](name); return on; },
    };
  }
  addEventListener(type, handler) { (this.events[type] ||= []).push(handler); }
  fire(type, event = {}) { return Promise.all((this.events[type] || []).map(handler => handler({ target: this, ...event }))); }
  querySelector(selector) { return this.selectors[selector] ||= new Element(`${this.id}:${selector}`); }
  appendChild(child) { this.children.push(child); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  focus() { this.focused = true; }
}

async function fixture({ legacy = false } = {}) {
  const elements = new Map(), listeners = [], calls = [], timers = new Map(), intervals = new Map(), handlers = {};
  let nextTimer = 0, pairPicker, modelPicker, progress, currentModel = "model-a", pairRenders = 0;
  let current = { projectId: "project-A", contextToken: "token-A", epoch: 1, status: "ready",
    projectState: { activeProject: { notesDirectory: "C:/Synthetic/A" } } };
  const element = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const themes = ["classic-blue", "noda-red"].map(value => Object.assign(new Element(value), { value }));
  const selection = { title: "title-a", tags: "tags-a", links: "links-a" };
  const pipeline = (chosen = selection) => ({ enabled: true, configured: true, selection: { ...chosen },
    catalog: Object.keys(chosen).map(id => ({ id })) });
  const payload = () => ({ ok: true, settings: { notesDirectory: "C:/Synthetic/A", theme: "classic-blue", language: "ru",
    skipModelSelection: true, skipNotesDirectorySelection: true, skipTurboQuantSelection: true,
    skipNoteTitleSelection: true, skipNoteTagsSelection: true, skipNoteLinksSelection: true },
    models: ["model-a", "model-b"].map(id => ({ id, name: id, downloaded: true, artifact: "gguf", hardware: "8 GB RAM" })),
    activeModelId: currentModel, runtime: { provider: "local", turboquant: { enabled: false }, note_pipeline: pipeline() },
    turboquantCapability: { supported: true }, hardware: {} });
  const context = { snapshot: () => current,
    isCurrent: bound => current.status === "ready" && bound?.status === "ready" && bound.epoch === current.epoch
      && bound.projectId === current.projectId && bound.contextToken === current.contextToken,
    subscribe: callback => { listeners.push(callback); return () => {}; } };
  const bridge = { onSettingsModelProgress: callback => { progress = callback; return () => {}; } };
  for (const name of ["getAppSettings", "chooseNotesDirectory", "saveAppSettings", "applySettingsModel", "applySettingsNotePairs"]) {
    bridge[name] = async value => {
      calls.push({ name, value: value === undefined ? undefined : clone(value) });
      if (handlers[name]) return handlers[name](value);
      if (name === "saveAppSettings") return { ...payload(), settings: { ...payload().settings, ...value } };
      if (name === "applySettingsModel") { currentModel = value.model_id; return payload(); }
      if (name === "applySettingsNotePairs") return { ok: true, runtime: { note_pipeline: pipeline(value) } };
      return payload();
    };
  }
  const window = { quickNoteBridge: bridge, nodaLanguages, nodaI18n: { t: ru => ru, getLanguage: () => "ru" },
    NotesDesktopPreferences: require("../../frontend/desktop_preferences"),
    modelLocale: { turboquantReason: () => "synthetic capability", quality: () => "synthetic quality" },
    noteModelPairPicker: { render: (_el, options) => { pairPicker = options; pairRenders += 1; return true; } },
    settingsModelPicker: { render: (_el, _data, options) => { modelPicker = options; }, setDisabled() {} },
    addEventListener() {}, dispatchEvent() {},
    setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; }, clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { intervals.set(++nextTimer, { fn, delay }); return nextTimer; }, clearInterval: id => intervals.delete(id),
    ...(legacy ? {} : { NodaProjectContext: context }) };
  const document = { getElementById: element, createElement: () => new Element("created"),
    querySelectorAll: selector => selector.includes("settings-theme") ? themes : [],
    documentElement: { dataset: {} }, addEventListener() {} };
  element("settings-model-modal").hidden = true; element("settings-model-switch").hidden = true;
  const sandbox = vm.createContext({ window, document, CustomEvent: class { constructor(type) { this.type = type; } } });
  for (const file of ["notes_settings_note_pairs.js", "notes_settings_preferences.js", "notes_settings_renderer.js"]) {
    const filename = path.resolve(__dirname, "../../frontend", file);
    vm.runInContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
  }
  await window.notesSettingsController.activate();
  function switchTo(status = "ready", id = "project-B") {
    current = { projectId: status === "ready" ? id : null, contextToken: status === "ready" ? "token-B" : null,
      epoch: current.epoch + 1, status, projectState: { activeProject: { notesDirectory: "C:/Synthetic/B" } } };
    for (const listener of listeners) listener(current);
  }
  function stampNewUi() {
    for (const id of ["settings-status", "settings-model-progress", "settings-switch-title", "settings-switch-detail",
      "settings-switch-elapsed", "settings-note-pairs-status", "settings-model-name"]) element(id).textContent = "NEW PROJECT";
    element("settings-model-switch").hidden = false; element("settings-notes-path").value = "C:/Synthetic/B";
    element("settings-save").disabled = true; element("settings-note-pairs-fields").disabled = true;
  }
  const ui = () => clone([...elements].map(([id, el]) => [id, { text: el.textContent, value: el.value, checked: el.checked,
    disabled: el.disabled, hidden: el.hidden, className: el.className, attributes: el.attributes, children: el.children.map(x => x.textContent) }]));
  return { window, calls, handlers, element, themes, payload, pipeline, selection, timers, intervals, switchTo, stampNewUi, ui,
    get pairRenders() { return pairRenders; }, progress: value => progress(value),
    save: () => window.notesSettingsController.save(),
    async model() { await element("settings-model-open").fire("click"); return modelPicker.onChoose({ id: "model-b", name: "model-b", downloaded: true }); },
    choosePairs() { const chosen = { ...selection, title: "title-b" }; pairPicker.onChange(chosen, true); return chosen; },
    pairs: () => element("settings-note-pairs-apply").fire("click"),
    fireDelay() { const entry = [...timers].find(([, item]) => item.delay === 650); assert.ok(entry, "model completion delay queued"); timers.delete(entry[0]); entry[1].fn(); },
  };
}

test("the support button copies only the displayed address and reports the result", async () => {
  const f = await fixture();
  const address = "support@example.test";
  const copied = [];
  f.window.navigator = { clipboard: { writeText: async value => copied.push(value) } };
  const body = new Element("body");
  f.window.document = { body, documentElement: {}, getElementById: () => null, createElement: () => new Element("footer-child") };
  const filename = path.resolve(__dirname, "../../frontend/support_footer.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { window: f.window,
    MutationObserver: class { observe() {} disconnect() {} }, setTimeout: f.window.setTimeout, clearTimeout: f.window.clearTimeout }, { filename });
  const [email, copy, status] = body.children[0].children;
  email.textContent = address;
  const first = copy.fire("click");
  assert.equal(copy.disabled, true);
  await copy.fire("click"); await first;
  assert.deepEqual(copied, [address]);
  assert.equal(status.textContent, "Почта скопирована.");
  assert.equal(copy.textContent, ""); assert.equal(copy.attributes["aria-label"], "Копировать почту");

  f.window.navigator.clipboard.writeText = async () => { throw new Error("Clipboard unavailable"); };
  await copy.fire("click");
  assert.equal(status.textContent, "Не удалось скопировать почту.");
  f.window.document.getElementById = id => id === "app-support-footer" ? body.children[0] : null;
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { window: f.window }, { filename });
  assert.equal(body.children.length, 1, "shared footer must not be duplicated");
  assert.deepEqual(f.calls.map(call => call.name), ["getAppSettings"]);
});

test("all three settings mutations carry captured project IDs at the top level", async () => {
  const f = await fixture(); f.save(); await turn();
  const chosen = f.choosePairs(); await f.pairs();
  const model = f.model(); await turn(); f.fireDelay(); await model;
  for (const name of ["saveAppSettings", "applySettingsModel", "applySettingsNotePairs"]) {
    const sent = f.calls.find(call => call.name === name).value;
    assert.equal(sent.projectId, "project-A"); assert.equal(sent.contextToken, "token-A");
    assert.equal(Object.hasOwn(sent, "selection"), false);
  }
  assert.deepEqual(f.calls.find(call => call.name === "applySettingsNotePairs").value,
    { ...chosen, projectId: "project-A", contextToken: "token-A" });
  assert.equal(f.element("settings-status").className, "ok");
});

test("without project helper legacy IPC payloads add preferences without project context", async () => {
  const f = await fixture({ legacy: true }); f.save(); await turn();
  const chosen = f.choosePairs(); await f.pairs(); const model = f.model(); await turn(); f.fireDelay(); await model;
  const sent = name => f.calls.find(call => call.name === name).value;
  assert.deepEqual(sent("applySettingsNotePairs"), chosen); assert.deepEqual(sent("applySettingsModel"), { model_id: "model-b" });
  assert.deepEqual(Object.keys(sent("saveAppSettings")).sort(), ["notesDirectory", "skipModelSelection", "skipNotesDirectorySelection",
    "skipTurboQuantSelection", "skipNoteTitleSelection", "skipNoteTagsSelection", "skipNoteLinksSelection", "turboquantEnabled", "theme", "language",
    "quickNoteHotkey", "editorFontSize", "interfaceDensity", "editorAutoSave", "editorAutoSaveDelayMs"].sort());
});

test("connecting a model preserves every unsaved settings field and the processing draft", async () => {
  const f = await fixture();
  f.element("settings-language").value = "en";
  f.element("settings-skip-path").checked = false;
  f.element("settings-skip-model").checked = false;
  f.element("settings-skip-note-title").checked = false;
  f.element("settings-turboquant-enabled").checked = true;
  f.element("settings-quick-hotkey").value = "Alt+N";
  f.element("settings-editor-font-size").value = "20";
  f.element("settings-interface-density").value = "compact";
  f.element("settings-editor-autosave").checked = false;
  f.element("settings-editor-autosave-delay").value = "2500";
  for (const input of f.themes) input.checked = input.value === "noda-red";
  const chosen = f.choosePairs(), renders = f.pairRenders;
  const model = f.model(); await turn(); f.fireDelay(); await model;
  assert.equal(f.element("settings-language").value, "en");
  for (const id of ["settings-skip-path", "settings-skip-model", "settings-skip-note-title"]) assert.equal(f.element(id).checked, false, id);
  assert.equal(f.element("settings-turboquant-enabled").checked, true);
  assert.equal(f.element("settings-editor-font-size").value, "20");
  assert.equal(f.element("settings-editor-autosave").checked, false);
  assert.equal(f.themes.find(input => input.value === "noda-red").checked, true);
  assert.equal(f.pairRenders, renders);
  assert.equal(f.window.notesSettingsNotePairs.hasDraft(), true);
  f.save(); await turn(); await turn();
  const saved = f.calls.find(call => call.name === "saveAppSettings").value;
  assert.deepEqual(f.calls.find(call => call.name === "applySettingsNotePairs").value,
    { ...chosen, projectId: "project-A", contextToken: "token-A" });
  assert.equal(saved.language, "en"); assert.equal(saved.editorAutoSave, false);
  assert.equal(saved.quickNoteHotkey, "Alt+N"); assert.equal(saved.editorAutoSaveDelayMs, 2500);
  assert.equal(saved.theme, "noda-red");
});

test("a selected legacy folder survives the model catalog refresh", async () => {
  const f = await fixture({ legacy: true });
  f.element("settings-notes-path").value = "C:/Synthetic/Chosen";
  const work = f.model(); await turn(); f.fireDelay(); await work;
  assert.equal(f.element("settings-notes-path").value, "C:/Synthetic/Chosen");
});

test("invalid editor values block saving and valid changes preview then persist", async () => {
  const f = await fixture(), previews = [], applied = [];
  f.window.NodaPreferences = { preview: value => previews.push(clone(value)), apply: value => applied.push(clone(value)) };
  f.element("settings-editor-font-size").value = "25";
  f.save(); await turn();
  assert.equal(f.calls.filter(call => call.name === "saveAppSettings").length, 0);
  assert.equal(f.element("settings-editor-font-size").focused, true);
  f.element("settings-editor-font-size").value = "18";
  f.element("settings-interface-density").value = "compact";
  await f.element("settings-editor-font-size").fire("input");
  assert.deepEqual(previews.at(-1), { editorFontSize: 18, interfaceDensity: "compact" });
  f.save(); await turn();
  assert.equal(applied.at(-1).editorFontSize, 18);
  assert.equal(applied.at(-1).interfaceDensity, "compact");
});

test("restart is available only for a saved new language and reports failure safely", async () => {
  const f = await fixture(); let restarts = 0;
  f.window.quickNoteBridge.restartAppForSettings = async () => { restarts++; return { ok: false }; };
  const button = f.element("settings-language-restart"); assert.equal(button.hidden, true);
  f.element("settings-language").value = "en"; f.save(); await turn();
  assert.equal(button.hidden, false); assert.equal(button.disabled, false);
  f.element("settings-editor-font-size").value = "19"; await f.element("settings-editor-font-size").fire("input");
  assert.equal(button.disabled, true); await button.fire("click"); assert.equal(restarts, 0);
  await f.element("settings-cancel").fire("click"); assert.equal(button.disabled, false);
  f.window.quickNoteBridge.restartAppForSettings = async () => { restarts++; return { ok: false, canceled: true }; };
  await button.fire("click"); assert.equal(restarts, 1);
  assert.notEqual(f.element("settings-status").className, "error");
  f.window.quickNoteBridge.restartAppForSettings = async () => { restarts++; return { ok: false }; };
  await button.fire("click"); assert.equal(restarts, 2);
  assert.equal(f.element("settings-status").className, "error");
  assert.match(f.element("settings-status").textContent, /Выход/);
});

test("present project helper with switching/error and no ID blocks every mutation before IPC", async () => {
  for (const status of ["switching", "error"]) for (const operation of ["save", "model", "pairs"]) {
    const f = await fixture(); if (operation === "pairs") f.choosePairs(); f.switchTo(status);
    if (operation === "save") f.save(); else if (operation === "pairs") await f.pairs();
    else await f.model();
    await turn(); assert.equal(f.calls.filter(call => call.name !== "getAppSettings").length, 0, `${status}/${operation}`);
  }
});

test("late settings save success/rejection/finally cannot modify a new project's UI", async () => {
  for (const fails of [false, true]) {
    const f = await fixture(), pending = deferred(); f.handlers.saveAppSettings = () => pending.promise;
    f.save(); assert.equal(f.calls.at(-1).name, "saveAppSettings"); f.switchTo(); f.stampNewUi(); const before = f.ui();
    if (fails) pending.reject(new Error("old settings save")); else pending.resolve(f.payload());
    await turn(); assert.deepEqual(f.ui(), before);
  }
});

test("late model request success/rejection cannot emit old success, error, reload or finally UI", async () => {
  for (const fails of [false, true]) {
    const f = await fixture(), pending = deferred(); f.handlers.applySettingsModel = () => pending.promise;
    const work = f.model(); await turn(); const reads = f.calls.filter(call => call.name === "getAppSettings").length;
    const oldTick = [...f.intervals.values()][0]?.fn;
    f.switchTo(); f.stampNewUi(); const before = f.ui();
    if (fails) pending.reject(new Error("old model request")); else pending.resolve(f.payload());
    await work; oldTick?.(); f.progress({ state: "error", message: "OLD MODEL PROGRESS", detail: "old" });
    assert.deepEqual(f.ui(), before); assert.equal(f.calls.filter(call => call.name === "getAppSettings").length, reads);
  }
});

test("model completion delay from an old project cannot hide a new model overlay", async () => {
  const f = await fixture(), work = f.model(); await turn();
  f.switchTo(); f.stampNewUi(); const before = f.ui(); f.fireDelay(); await work;
  assert.deepEqual(f.ui(), before); assert.equal(f.element("settings-model-switch").hidden, false);
});

test("model reload resolving or failing after switch cannot render or report the old project", async () => {
  for (const fails of [false, true]) {
    const f = await fixture(), pending = deferred(); f.handlers.getAppSettings = () => pending.promise;
    const work = f.model(); await turn(); assert.ok(f.calls.filter(call => call.name === "getAppSettings").length >= 2);
    f.switchTo(); f.stampNewUi(); const before = f.ui();
    if (fails) pending.reject(new Error("old model reload")); else pending.resolve(f.payload());
    await work; assert.deepEqual(f.ui(), before); assert.equal(f.timers.size, 0);
  }
});

test("actual pair producer and consumer ignore late success/rejection after the new pipeline renders", async () => {
  for (const fails of [false, true]) {
    const f = await fixture(), pending = deferred(); f.handlers.applySettingsNotePairs = () => pending.promise;
    const chosen = f.choosePairs(), work = f.pairs(); assert.equal(f.calls.at(-1).name, "applySettingsNotePairs");
    f.switchTo(); f.window.notesSettingsNotePairs.render(f.pipeline({ title: "B", tags: "B", links: "B" }), async () => f.pipeline());
    f.stampNewUi(); const before = f.ui(), renders = f.pairRenders;
    if (fails) pending.reject(new Error("old pair save")); else pending.resolve({ ok: true, runtime: { note_pipeline: f.pipeline(chosen) } });
    await work; assert.deepEqual(f.ui(), before); assert.equal(f.pairRenders, renders);
  }
});

test("pair consumer independently discards stale valid pipeline, undefined result and rejection", async () => {
  for (const outcome of ["valid", "undefined", "error"]) {
    const f = await fixture(), pending = deferred();
    f.window.notesSettingsNotePairs.render(f.pipeline(), () => pending.promise); f.choosePairs(); const work = f.pairs();
    f.switchTo(); f.window.notesSettingsNotePairs.render(f.pipeline({ title: "B", tags: "B", links: "B" }), async () => f.pipeline());
    f.stampNewUi(); const before = f.ui(), renders = f.pairRenders;
    if (outcome === "error") pending.reject(new Error("old consumer")); else pending.resolve(outcome === "valid" ? f.pipeline() : undefined);
    await work; assert.deepEqual(f.ui(), before); assert.equal(f.pairRenders, renders);
  }
});
