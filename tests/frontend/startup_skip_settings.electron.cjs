"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, session } = require("electron");
const desktop = require("../../frontend/desktop_settings");
const root = path.resolve(__dirname, "../..");
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "profile"));
app.setPath("sessionData", path.join(output, "profile"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.on("window-all-closed", () => {});
const names = ["skipNoteTitleSelection", "skipNoteTagsSelection", "skipNoteLinksSelection"];
const ids = ["settings-skip-note-title", "settings-skip-note-tags", "settings-skip-note-links"];
const selected = { title: "qwen25_3b_mmarco", tags: "qwen35_4b_tev", links: "qwen35_4b_mmarco" };
const pairNames = {
  qwen25_3b_mmarco: "Qwen2.5-3B + mMARCO MiniLM CrossEncoder",
  qwen35_4b_tev: "Qwen3.5-4B + Tev1-0.8B",
  qwen35_4b_mmarco: "Qwen3.5-4B + mMARCO MiniLM CrossEncoder",
  title_alternative: "Qwen3.5-4B + mMARCO MiniLM CrossEncoder",
  tags_alternative: "Qwen2.5-3B + Tev1-0.8B",
  links_alternative: "Qwen2.5-3B + mMARCO MiniLM CrossEncoder",
};
const option = (id) => ({ id, label: pairNames[id], languages: ["ru", "en"], available: true });
const catalog = Object.entries(selected).map(([id, pair]) => ({
  id, recommendedId: pair, options: [option(pair), option(`${id}_alternative`)],
}));
const checks = [], captures = [], coverage = [];
let blocked = 0;

async function until(win, expression) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`DOM wait failed: ${expression}`);
}

async function runLanguage(language) {
  const directory = path.join(output, language);
  fs.mkdirSync(path.join(directory, "vault"), { recursive: true });
  const settingsFile = path.join(directory, "desktop-settings.json");
  const defaults = { notesDirectory: path.join(directory, "vault"), skipModelSelection: false,
    skipNotesDirectorySelection: true, skipTurboQuantSelection: false, language };
  let pairs = { ...selected }, mode = "success", release, saveCount = 0, received;
  const runtime = () => ({ provider: "local", turboquant: { enabled: false }, note_pipeline: {
    enabled: true, profile: "ru-three-stage-v1", configured: true, selection: { ...pairs }, catalog,
  } });
  const payload = () => ({ ok: true, settings: desktop.loadDesktopSettings(settingsFile, defaults),
    models: [{ id: "fixture-chat", name: "Local fixture chat", downloaded: true, active: true,
      artifact: "gguf", hardware: "8 GB RAM", quantization: "Q4_K_M", estimated_download_gb: 2 }],
    activeModelId: "fixture-chat", runtime: runtime(), hardware: { ramGb: 16 },
    turboquantCapability: { supported: false, code: "runtime_not_vllm", reason: "GGUF" } });
  const win = new BrowserWindow({ width: 1300, height: 1000, show: false,
    webPreferences: { preload: path.join(root, "frontend/preload.js"), contextIsolation: true,
      nodeIntegration: false, sandbox: true, offscreen: true,
      partition: `startup-skip-settings-${language}`, additionalArguments: [`--noda-language=${language}`] } });
  win.webContents.session.webRequest.onBeforeRequest(({ url }, callback) => {
    const allowed = /^(file|data|about):/.test(url);
    if (!allowed) blocked += 1;
    callback({ cancel: !allowed });
  });
  const evaluate = expression => win.webContents.executeJavaScript(expression);
  const handlers = {
    "get-projects": () => ({ ok: true, mode: "legacy", projects: [], activeProjectId: null,
      activeProject: null, context: null, status: "ready" }),
    "get-app-settings": () => payload(),
    "get-projects": () => ({ ok: true, mode: "legacy", status: "ready", projects: [],
      context: null, activeProjectId: null, activeProject: null }),
    "ensure-backend": () => ({ ok: true }),
    "get-startup-status": () => ({ state: "ready", phase: "ready", progress: 100 }),
    "save-app-settings": async (event, next) => {
      assert.equal(event.sender, win.webContents);
      saveCount += 1;
      received = structuredClone(next);
      if (mode === "pending") await new Promise(resolve => { release = resolve; });
      if (mode === "failure") throw new Error("Synthetic settings save rejection");
      if (mode === "mismatch") {
        const result = payload();
        result.settings.skipNoteLinksSelection = !next.skipNoteLinksSelection;
        return result;
      }
      const { turboquantEnabled, ...preferences } = next;
      desktop.saveDesktopSettings(settingsFile, preferences, defaults);
      return payload();
    },
    "apply-settings-note-pairs": (_event, selection) => {
      pairs = { ...selection };
      return { ok: true, runtime: runtime() };
    },
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`quick-note:${name}`, handler);
  const flags = () => evaluate(`${JSON.stringify(ids)}.map(id=>document.getElementById(id).checked)`);
  const setFlags = (values) => evaluate(`${JSON.stringify(ids)}.forEach((id,i)=>{const input=document.getElementById(id);if(input.checked!==${JSON.stringify(values)}[i])input.click();})`);
  const record = (name) => checks.push({ language, name, status: "pass" });
  try {
    await win.loadURL("about:blank");
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Profiler.enable");
    await win.webContents.debugger.sendCommand("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    await win.loadFile(path.join(root, "frontend/notes.html"));
    await until(win, "!document.body.classList.contains('app-loading') && window.NodaProjectContext.snapshot().status === 'ready'");
    await evaluate("document.querySelector('[data-notes-tab=settings]').click()");
    await until(win, "!document.getElementById('settings-save').disabled && document.getElementById('settings-notes-path').value");
    assert.deepEqual(await flags(), [true, true, true]);
    const labels = await evaluate(`${JSON.stringify(ids)}.map(id=>{const input=document.getElementById(id);return {type:input.type,label:input.labels?.[0]?.textContent.trim(),visible:input.getBoundingClientRect().height>0,described:input.getAttribute('aria-describedby')};})`);
    assert.ok(labels.every(item => item.type === "checkbox" && item.label && item.visible));
    assert.ok(labels.every(item => language === "en" ? item.label.startsWith("Skip ") : item.label.startsWith("Пропускать ")));
    assert.equal(await evaluate("document.getElementById('settings-skip-model-row').hidden"), true);
    record("default three checked flags have native localized labels and no legacy pair checkbox");

    await until(win, "getComputedStyle(document.getElementById('startup-overlay')).visibility==='hidden' && getComputedStyle(document.getElementById('startup-overlay')).opacity==='0'");
    await evaluate("document.getElementById('settings-note-pairs-section').scrollIntoView({block:'start',behavior:'instant'})");
    await until(win, "document.getElementById('settings-skip-note-links').getBoundingClientRect().bottom < innerHeight");
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fresh settings frame not painted")), 3000);
      win.webContents.once("paint", () => { clearTimeout(timer); resolve(); });
      win.webContents.invalidate();
    });
    const capture = path.join(directory, `settings-skip-${language}.png`);
    fs.writeFileSync(capture, (await win.webContents.capturePage()).toPNG());
    captures.push({ file: capture, language, flags: [true, true, true], state: "settings-note-pairs" });

    await setFlags([true, false, true]);
    await evaluate("document.querySelector('[data-notes-tab=notes]').click();document.querySelector('[data-notes-tab=settings]').click()");
    assert.deepEqual(await flags(), [true, false, true]);
    record("switching tabs preserves unsaved startup flags");
    mode = "pending";
    await evaluate("document.getElementById('settings-save').click();document.getElementById('settings-save').click()");
    await until(win, `${JSON.stringify(ids)}.every(id=>document.getElementById(id).matches(':disabled'))`);
    assert.equal(saveCount, 1);
    assert.equal(fs.existsSync(settingsFile), false);
    assert.deepEqual(names.map(name => received[name]), [true, false, true]);
    mode = "success";
    release();
    await until(win, "!document.getElementById('settings-save').disabled && document.getElementById('settings-status').classList.contains('ok')");
    assert.deepEqual(names.map(name => desktop.loadDesktopSettings(settingsFile, defaults)[name]), [true, false, true]);
    record("serialized save disables three controls and durably persists each independent flag");

    await setFlags([false, true, false]);
    await evaluate("document.getElementById('settings-cancel').click()");
    assert.deepEqual(await flags(), [true, false, true]);
    await setFlags([false, true, false]);
    await evaluate("window.notesSettingsController.reset()");
    await until(win, "!document.getElementById('settings-save').disabled");
    assert.deepEqual(await flags(), [true, false, true]);
    record("Cancel and Reset restore the saved flags without a save side effect");

    mode = "failure";
    await setFlags([true, false, false]);
    await evaluate("document.getElementById('settings-save').click()");
    await until(win, "!document.getElementById('settings-save').disabled && document.getElementById('settings-status').classList.contains('error')");
    assert.deepEqual(names.map(name => desktop.loadDesktopSettings(settingsFile, defaults)[name]), [true, false, true]);
    await evaluate("document.getElementById('settings-cancel').click()");
    assert.deepEqual(await flags(), [true, false, true]);
    mode = "success";
    record("a rejected save does not persist optimistic checkbox values");

    mode = "mismatch";
    await setFlags([true, false, false]);
    await evaluate("document.getElementById('settings-save').click()");
    await until(win, "!document.getElementById('settings-save').disabled && document.getElementById('settings-status').classList.contains('error')");
    assert.deepEqual(names.map(name => desktop.loadDesktopSettings(settingsFile, defaults)[name]), [true, false, true]);
    await evaluate("document.getElementById('settings-cancel').click()");
    assert.deepEqual(await flags(), [true, false, true]);
    mode = "success";
    record("a mismatched successful acknowledgement is rejected and does not replace the trusted flags");

    await setFlags([true, false, false]);
    await evaluate("const title=document.getElementById('settings-note-pairs-picker-title');title.value='title_alternative';title.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('settings-note-pairs-apply').click()");
    await until(win, "document.getElementById('settings-note-pairs-status').classList.contains('ok')");
    assert.deepEqual(await flags(), [true, false, false]);
    assert.deepEqual(names.map(name => desktop.loadDesktopSettings(settingsFile, defaults)[name]), [true, false, true]);
    record("applying model pairs preserves unsaved startup flags and their separate save contract");

    mode = "failure";
    await evaluate(`{
      const field = document.getElementById('settings-note-pairs-picker-title');
      field.value = ${JSON.stringify(selected.title)};
      field.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('settings-save').click();
    }`);
    await until(win, "!document.getElementById('settings-save').disabled && document.getElementById('settings-status').classList.contains('error')");
    assert.equal(pairs.title, selected.title);
    assert.deepEqual(await flags(), [true, false, false]);
    assert.match(await evaluate("document.getElementById('settings-status').textContent"),
      language === "ru" ? /Настройки обработки уже применены/ : /Processing settings were applied/);
    record("partial failure tells the user what saved and retains the remaining draft");

    await win.reload();
    await until(win, "!document.body.classList.contains('app-loading') && window.NodaProjectContext.snapshot().status === 'ready'");
    await evaluate("document.querySelector('[data-notes-tab=settings]').click()");
    await until(win, "!document.getElementById('settings-save').disabled && document.getElementById('settings-notes-path').value");
    assert.deepEqual(await flags(), [true, false, true]);
    record("a fresh renderer reload reads the durable settings rather than the discarded draft");
    const measured = await win.webContents.debugger.sendCommand("Profiler.takePreciseCoverage");
    coverage.push({ language, result: measured.result.filter(item => /notes_settings_(note_pairs|renderer)\.js$/.test(item.url)) });
  } finally {
    if (release) release();
    for (const name of Object.keys(handlers)) ipcMain.removeHandler(`quick-note:${name}`);
    win.destroy();
  }
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest(({ url }, callback) => {
    const allowed = /^(file|data|about):/.test(url);
    if (!allowed) blocked += 1;
    callback({ cancel: !allowed });
  });
  await runLanguage("ru");
  await runLanguage("en");
  fs.writeFileSync(path.join(output, "coverage.json"), JSON.stringify(coverage, null, 2));
  const result = { checks, captures, blocked, network_allowed: false, electron: process.versions.electron };
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  app.exit(0);
}).catch(error => {
  fs.writeFileSync(path.join(output, "failure.json"), JSON.stringify({ message: error.message, stack: error.stack, checks }, null, 2));
  console.error(error);
  app.exit(1);
});
