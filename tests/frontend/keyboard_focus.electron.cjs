"use strict";
const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { initial, createMainFixture, setupHttp } = require("./projects_fixture.cjs");
const root = path.resolve(__dirname, "../.."), out = path.resolve(process.argv[2] || "");
const frontend = path.resolve(process.argv[3] || path.join(root, "frontend"));
assert.ok(process.argv[2] && !fs.existsSync(out), "Use a fresh explicit output directory");
fs.mkdirSync(out, { recursive: true });
app.setPath("userData", path.join(out, "profile"));
app.setPath("sessionData", path.join(out, "profile"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
let win, network = 0;
const checks = [], errors = [];
const watchdog = setTimeout(() => app.exit(2), 60000);

async function run() {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest(({ url }, done) => {
    const local = /^(file|data|about):/.test(url);
    if (!local) network++;
    done({ cancel: !local });
  });
  const fixture = createMainFixture(ipcMain, "ru"), seed = initial("ru");
  win = new BrowserWindow({ width: 1100, height: 780, show: false, webPreferences: {
    preload: path.join(frontend, "preload.js"), sandbox: true, contextIsolation: true,
    nodeIntegration: false, offscreen: true, backgroundThrottling: false,
    additionalArguments: ["--noda-language=ru"],
  } });
  fixture.addWindow(win);
  await win.loadURL("about:blank");
  const debug = win.webContents.debugger;
  debug.attach("1.3");
  await debug.sendCommand("Page.enable");
  await debug.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  await debug.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source: `(${setupHttp.toString()})(${JSON.stringify(seed)},${JSON.stringify(fixture.snapshot())});`,
  });
  win.webContents.on("console-message", details => {
    if (details.level === "error") errors.push(String(details.message));
  });
  await win.loadFile(path.join(frontend, "notes.html"));
  const evaluate = source => win.webContents.executeJavaScript(source);
  await evaluate(`window.wait = async f => {
    const end=performance.now()+7000;
    while(!f()) { if(performance.now()>end) throw Error('UI wait expired');
      await new Promise(r=>requestAnimationFrame(r)); }
  }; wait(()=>notes.length===2&&getComputedStyle(document.getElementById('startup-overlay')).opacity==='0')`);
  const key = async (keyCode, modifiers = []) => {
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (keyCode === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await evaluate("new Promise(r=>requestAnimationFrame(r))");
  };
  const capture = async name => {
    await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
  };
  async function check(name, action) {
    try { await action(); checks.push({ name, status: "pass" }); }
    catch (error) { checks.push({ name, status: "fail", error: String(error.stack || error) }); }
  }
  const focusShape = () => evaluate(`(()=>{
    const e=document.activeElement,s=getComputedStyle(e),p=getComputedStyle(e,'::before');
    return { tab:e.dataset.notesTab,visible:e.matches(':focus-visible'),outline:s.outlineStyle,
      indicator:p.content,radius:parseFloat(p.borderRadius),inset:parseFloat(p.top),
      shadow:p.boxShadow,active:document.body.dataset.notesTab,
      underline:getComputedStyle(document.querySelector('.notes-tab.active'),'::after').height };
  })()`);
  for (const theme of ["classic-blue", "noda-red"]) {
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};
      document.activeElement.blur(); document.body.focus();`);
    // Click once to reset sequential navigation, then use genuine Chromium keyboard events.
    const target = await evaluate(`(()=>{const r=document.querySelector('.notes-tab').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...target });
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...target });
    await check(`${theme}: mouse click does not draw keyboard decoration`, async () => {
      assert.equal((await focusShape()).visible, false);
    });
    await key("Tab"); await key("Tab", ["shift"]);
    for (const tab of ["notes", "chat", "settings", "graph"]) {
      await check(`${theme}: Tab gives ${tab} a compact rounded visible highlight`, async () => {
        const shape = await focusShape();
        assert.equal(shape.tab, tab); assert.equal(shape.visible, true, JSON.stringify(shape));
        assert.notEqual(shape.indicator, "none", "Rounded keyboard highlight is missing");
        assert.ok(shape.radius >= 8 && shape.inset >= 6, "Focus must be rounded and inset from the header edges");
        assert.equal(shape.outline, "none", "The old full-height rectangle must be replaced");
        assert.notEqual(shape.shadow, "none");
        assert.equal(shape.active, "notes", "Tab must not activate another section");
        assert.equal(shape.underline, "3px", "Active section marker must remain visible");
      });
      if (tab === "notes" || tab === "settings") await capture(`${theme}-${tab}.png`);
      if (tab !== "graph") await key("Tab");
    }
    await key("Tab", ["shift"]); await key("Tab", ["shift"]);
    await check(`${theme}: Shift+Tab reverses navigation without changing the open section`, async () => {
      const shape = await focusShape(); assert.equal(shape.tab, "chat"); assert.equal(shape.active, "notes");
    });
  }
  await check("Enter activates the focused section", async () => {
    await key("Enter");
    await evaluate("wait(()=>document.body.dataset.notesTab==='chat')");
    assert.equal((await focusShape()).active, "chat");
    await evaluate("document.querySelector('.notes-tab[data-notes-tab=notes]').focus()");
    await key("Enter");
    await evaluate("wait(()=>document.body.dataset.notesTab==='notes')");
  });
  await check("Project buttons, filter button and search retain rounded visible focus", async () => {
    await evaluate("document.querySelector('.project-button').focus()");
    const controls = await evaluate(`[
      document.querySelector('.project-button'),document.querySelector('.notes-filter-menu>summary'),
      document.querySelector('.notes-search-field')].map(e=>({radius:parseFloat(getComputedStyle(e).borderRadius)}))`);
    assert.ok(controls.every(value => value.radius >= 6));
    assert.equal(await evaluate("getComputedStyle(document.activeElement).outlineWidth"), "2px");
  });
  await check("Windows high contrast keeps the keyboard highlight visible without shadows", async () => {
    await debug.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    await evaluate("document.querySelector('.notes-tab').focus()");
    const forced = await evaluate(`(()=>{const p=getComputedStyle(document.activeElement,'::before');
      return {border:p.borderTopWidth,style:p.borderTopStyle,shadow:p.boxShadow}})()`);
    assert.equal(forced.border, "2px"); assert.equal(forced.style, "solid"); assert.equal(forced.shadow, "none");
    await capture("high-contrast.png");
    await debug.sendCommand("Emulation.setEmulatedMedia", { features: [] });
  });
  await check("Narrow layout keeps keyboard focus visible and does not overflow the page", async () => {
    win.setSize(420, 720);
    await evaluate("wait(()=>innerWidth===420)");
    await key("Tab");
    assert.equal((await focusShape()).visible, true);
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
    await capture("compact.png");
  });
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ checks, errors, network, electron: process.versions.electron }, null, 2));
  clearTimeout(watchdog); win.destroy();
  app.exit(checks.some(item => item.status !== "pass") || errors.length || network ? 1 : 0);
}
run().catch(error => {
  clearTimeout(watchdog); fs.writeFileSync(path.join(out, "harness-error.txt"), String(error.stack || error)); app.exit(1);
});
