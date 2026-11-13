"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { app, BrowserWindow, ipcMain, screen, session } = require("electron");
const { createQuickCaptureController } = require("../../frontend/quick_capture_window");

const repo = path.resolve(__dirname, "../..");
const output = path.resolve(process.argv[2] || "");
assert.ok(output.startsWith(path.join(repo, "output") + path.sep), "Use an isolated output directory");
assert.equal(fs.existsSync(path.join(output, "profile")), false, "Use a fresh profile for each attempt");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "profile"));
app.setPath("sessionData", path.join(output, "profile"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
const trace = label => fs.appendFileSync(path.join(output, "trace.log"), label + "\n");
trace("module-started");
const watchdog = setTimeout(() => { trace("watchdog-timeout"); app.exit(2); }, 40000);
const sourceNames = ["quick_capture_window.js", "quick_capture_focus.js", "main.js", "preload.js", "renderer.js", "index.html"];
const hashes = () => Object.fromEntries(sourceNames.filter(name => fs.existsSync(path.join(repo, "frontend", name)))
  .map(name => [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(repo, "frontend", name))).digest("hex")]));
const before = hashes();
const ready = { state: "ready", phase: "ready", language: "ru", progress: 100,
  message: "Готово", detail: "Синтетический локальный стенд" };
const mockSource = `
  window.__focusFixture={calls:[],deferRuntime:false,releaseRuntime:null};
  window.fetch=async (url,options={})=>{
    const pathname=new URL(url).pathname;
    window.__focusFixture.calls.push(pathname);
    let payload;
    if(pathname==='/runtime/config'){
      if(window.__focusFixture.deferRuntime) await new Promise(resolve=>window.__focusFixture.releaseRuntime=resolve);
      payload={provider:'local',runtime_model_id:'synthetic-focus-model'};
    }else if(pathname==='/generate/jobs')payload={jobs:[],next_cursor:null,vault_id:'focus-vault'};
    else if(pathname==='/generate/queue')payload={queue:{queued_count:0,processing_count:0},vault_id:'focus-vault'};
    else throw new Error('Unexpected synthetic API path: '+pathname);
    return {ok:true,status:200,json:async()=>payload};
  };
`;

async function run() {
  await app.whenReady();
  trace("app-ready");
  let blockedNetwork = 0, resizeCalls = 0, win, heldHotkey = false, releaseHotkey = null;
  const checks = [];
  session.defaultSession.webRequest.onBeforeRequest(({ url }, callback) => {
    const local = /^(file|data|about):/.test(url);
    if (!local) blockedNetwork += 1;
    callback({ cancel: !local });
  });
  const handlers = {
    "get-startup-status": () => ready,
    "ensure-backend": () => ({ ok: true }),
    "get-hotkey": () => heldHotkey
      ? new Promise(resolve => { releaseHotkey = () => resolve("Control+Shift+Space"); })
      : "Control+Shift+Space",
    "resize-capture": (event, height) => { resizeCalls += 1; return controller.resize(event, height); },
    "toggle-window": () => { win.hide(); return { ok: true }; },
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle("quick-note:" + name, handler);
  const controller = createQuickCaptureController({ getWindow: () => win, screen });
  win = new BrowserWindow({ width: 800, height: 86, show: false, frame: false,
    webPreferences: { preload: path.join(repo, "frontend/preload.js"), sandbox: true,
      nodeIntegration: false, contextIsolation: true, additionalArguments: ["--noda-language=ru"] } });
  const donor = new BrowserWindow({ width: 360, height: 180, show: false,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  const evaluate = source => win.webContents.executeJavaScript(source);
  const waitFor = async predicate => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error("Focus condition timed out");
  };
  async function check(name, body) {
    try { await body(); checks.push({ name, status: "pass" }); }
    catch (error) {
      let state;
      try { state = { ...await inputState(), nativeFocused:win.isFocused(), visible:win.isVisible() }; }
      catch (stateError) { state = { unavailable:stateError.message }; }
      checks.push({ name, status: "fail", error: error.message, state });
    }
    fs.appendFileSync(path.join(output, "checks.jsonl"), JSON.stringify(checks.at(-1)) + "\n");
  }
  async function stable() {
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  }
  async function inputState() {
    return evaluate(`({active:document.activeElement?.id,windowFocus:document.hasFocus(),
      disabled:document.getElementById('prompt-input').disabled,
      value:document.getElementById('prompt-input').value,
      start:document.getElementById('prompt-input').selectionStart,
      end:document.getElementById('prompt-input').selectionEnd,
      direction:document.getElementById('prompt-input').selectionDirection})`);
  }
  async function opened() {
    await waitFor(async () => { const state = await inputState(); return state.active === "prompt-input" && state.windowFocus && !state.disabled; });
    assert.equal(win.isFocused(), true);
  }
  async function donorFocus() {
    donor.show(); donor.focus(); donor.webContents.focus();
    await donor.webContents.executeJavaScript("document.getElementById('donor-input').focus()");
    await waitFor(() => Promise.resolve(donor.isFocused()));
  }
  async function reload() {
    await new Promise(resolve => {
      win.webContents.once("did-finish-load", resolve);
      win.reload();
    });
  }
  try {
    await donor.loadURL("data:text/html,<textarea id='donor-input' aria-label='Synthetic focus donor'></textarea>");
    trace("donor-loaded");
    await win.loadURL("about:blank");
    trace("target-blank-loaded");
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Page.enable");
    trace("page-enabled");
    await win.webContents.debugger.sendCommand("Profiler.enable");
    await win.webContents.debugger.sendCommand("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: mockSource });
    trace("debugger-ready");
    const main = fs.readFileSync(path.join(repo, "frontend/main.js"), "utf8");
    const createWindow = main.slice(main.indexOf("function createQuickWindow()"), main.indexOf("function createNotesWindow()"));
    const loadHook = createWindow.match(/quickWindow\.webContents\.on\("did-finish-load", \(\) => \{[\s\S]*?\n  \}\);/);
    assert.ok(loadHook, "Actual main quick-window load callback must exist");
    vm.runInNewContext(loadHook[0], { quickWindow: win, quickCapture: controller,
      sendStartupStatusToWindow: target => target.webContents.send("quick-note:startup-status", ready) });

    await check("first open before document load focuses the real textarea once ready", async () => {
      trace("first-open-started");
      await donorFocus();
      trace("donor-focused");
      controller.show(win);
      trace("target-shown");
      await win.loadFile(path.join(repo, "frontend/index.html"));
      trace("target-loaded");
      await opened();
      assert.equal(await evaluate("document.getElementById('prompt-input').value"), "");
    });
    await check("typing directly after opening reaches the note input without a click", async () => {
      for (const character of "Быстрая заметка") win.webContents.sendInputEvent({ type: "char", keyCode: character });
      await waitFor(async () => (await inputState()).value === "Быстрая заметка");
      assert.equal((await inputState()).active, "prompt-input");
    });
    await check("reopening moves focus from the queue control without selecting or clearing the draft", async () => {
      await evaluate("promptInput.value='Точный черновик';promptInput.setSelectionRange(2,6,'backward');document.getElementById('quick-queue-toggle').focus()");
      const old = await inputState();
      win.hide(); await donorFocus(); controller.show(win); await opened();
      const current = await inputState();
      assert.equal(current.value, old.value);
      assert.deepEqual([current.start,current.end,current.direction],[old.start,old.end,old.direction]);
    });
    await check("repeated show and hide returns keyboard input to the textarea every time", async () => {
      for (let iteration = 0; iteration < 3; iteration += 1) {
        await evaluate("document.getElementById('quick-queue-toggle').focus()");
        win.hide(); await donorFocus(); controller.show(win); await opened();
      }
    });
    await check("queue refresh and delayed runtime responses do not steal later intentional focus", async () => {
      trace("late-runtime-start");
      await evaluate("window.__focusFixture.deferRuntime=true;window.__lateRuntime=refreshRuntimeConfig();document.getElementById('quick-queue-toggle').focus()");
      trace("late-runtime-queued");
      await evaluate("queueClient.refresh()");
      trace("queue-refreshed");
      assert.equal((await inputState()).active, "quick-queue-toggle");
      await evaluate("window.__focusFixture.releaseRuntime();window.__lateRuntime");
      await stable();
      assert.equal((await inputState()).active, "quick-queue-toggle");
    });
    await check("visible renderer reload requests focus through the actual main load callback", async () => {
      await evaluate("document.getElementById('quick-queue-toggle').focus()");
      await reload();
      await opened();
    });
    await check("hidden renderer reload does not take native focus from another window", async () => {
      win.hide(); await donorFocus(); await reload();
      await waitFor(async () => await evaluate("document.body.classList.contains('app-ready')"));
      // Hidden renderers do not receive animation frames.
      assert.equal(donor.isFocused(), true); assert.equal(win.isFocused(), false);
      controller.show(win); await opened();
    });
    await check("late hotkey response cannot blur the already focused input during startup readiness", async () => {
      heldHotkey = true; releaseHotkey = null;
      await reload();
      await waitFor(() => Promise.resolve(typeof releaseHotkey === "function"));
      // Model the shortcut explicitly while the metadata reply is still held.
      controller.show(win); await opened();
      const initial = await inputState();
      assert.equal(initial.active, "prompt-input", "Actual load callback must focus before delayed hotkey reply");
      assert.equal(initial.windowFocus, true);
      fs.writeFileSync(path.join(output,"held-hotkey-before.json"),JSON.stringify(initial,null,2));
      heldHotkey = false; releaseHotkey();
      await waitFor(async () => await evaluate("document.body.classList.contains('app-ready')&&window.__focusFixture.calls.includes('/runtime/config')"));
      const current = await inputState();
      fs.writeFileSync(path.join(output,"held-hotkey-after.json"),JSON.stringify(current,null,2));
      assert.equal(current.active, "prompt-input");
      assert.equal(current.windowFocus, true);
    });
    controller.show(win); await opened();
    await evaluate("promptInput.value='Можно сразу печатать';promptInput.setSelectionRange(6,11);queueClient.stop()");
    await waitFor(async () => await evaluate(`(() => {
      const overlay=document.getElementById('startup-overlay');
      return !overlay || overlay.hidden || getComputedStyle(overlay).display==='none'
        || getComputedStyle(overlay).opacity==='0';
    })()`));
    await stable();
    const captureState = await inputState();
    assert.equal(captureState.active, "prompt-input"); assert.equal(captureState.windowFocus, true);
    fs.writeFileSync(path.join(output, "focused-input.png"), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, "capture-state.json"), JSON.stringify(captureState,null,2));
    const coverage = await win.webContents.debugger.sendCommand("Profiler.takePreciseCoverage");
    fs.writeFileSync(path.join(output, "coverage.json"), JSON.stringify(coverage.result.filter(script=>script.url.includes("/frontend/")),null,2));
    const after = hashes();
    assert.deepEqual(after, before, "Production source changed during QA");
    fs.writeFileSync(path.join(output,"source-hashes.json"), JSON.stringify({before,after},null,2));
    const result = { checks, blockedNetwork, resizeCalls, globalShortcutRegistered: false,
      realUserProfileTouched: false, sourceUnchanged: true, electron: process.versions.electron,
      chrome: process.versions.chrome, captureState };
    fs.writeFileSync(path.join(output,"result.json"), JSON.stringify(result,null,2));
    process.stdout.write(JSON.stringify(result)+"\n");
    clearTimeout(watchdog);
    app.exit(checks.some(check=>check.status!=="pass") || blockedNetwork ? 1 : 0);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    if (!donor.isDestroyed()) donor.destroy();
    for (const name of Object.keys(handlers)) ipcMain.removeHandler("quick-note:" + name);
  }
}
run().catch(error=>{ process.stderr.write(String(error.stack||error)+"\n"); app.exit(1); });
