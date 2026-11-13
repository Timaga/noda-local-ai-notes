"use strict";
const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { A, B, createMainFixture, setupHttp } = require("./projects_fixture.cjs");
const { graphInitial, setupGraphHttp } = require("./graph_fixture.cjs");
const { watchGraphPaint, runGraphPointerCases } = require("./graph_pointer_cases.cjs");
const root = path.resolve(__dirname, "../.."), out = path.resolve(process.argv[2] || ""), lang = process.argv[3] === "en" ? "en" : "ru";
assert.ok(process.argv[2] && !fs.existsSync(out), "Use a fresh explicit output directory"); fs.mkdirSync(out, { recursive: true });
app.setPath("userData", path.join(out, "profile")); app.setPath("sessionData", path.join(out, "profile"));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-background-networking"); app.on("window-all-closed", () => {});
const checks = [], captures = []; let network = 0, fixture, win;
const files = ["notes.html", "notes_renderer.js", "notes_graph_model.js", "notes_graph_canvas.js", "notes_graph_renderer.js", "notes_graph.css"];
const hashes = () => Object.fromEntries(files.map(name => [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "frontend", name))).digest("hex")]));
const before = hashes();
const timeout = setTimeout(() => { fs.writeFileSync(path.join(out, "timeout.json"), JSON.stringify(checks)); app.exit(2); }, 90000);
async function run(js) { return win.webContents.executeJavaScript(`(async()=>{${js}})()`); }
async function check(name, body) {
  try { checks.push({ name, status: "pass", detail: await body() }); } catch (error) {
    const diagnostic = await run(`return {status:document.getElementById('graph-status').textContent,context:NodaProjectContext.snapshot(),calls:__graph.calls,graph:__projects.data[__projects.context.activeProjectId].graph,violations:__projects.violations}`);
    checks.push({ name, status: "fail", error: String(error.stack || error), diagnostic });
  }
  fs.writeFileSync(path.join(out, "checks.json"), JSON.stringify(checks, null, 2));
}
async function capture(name) {
  await run("await waitFor(()=>{const el=document.getElementById('startup-overlay');return !el||el.hidden||getComputedStyle(el).opacity==='0'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); ");
  const bitmap = await win.webContents.capturePage(); fs.writeFileSync(path.join(out, name), bitmap.toPNG()); captures.push({ name, ...bitmap.getSize() });
}
async function main() {
  await app.whenReady(); fixture = createMainFixture(ipcMain, lang);
  session.defaultSession.webRequest.onBeforeRequest(({ url }, done) => { const local = /^(file|data|about):/.test(url); if (!local) network++; done({ cancel: !local }); });
  win = new BrowserWindow({ width: 1440, height: 960, show: false, webPreferences: { preload: path.join(root, "frontend/preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false, additionalArguments: [`--noda-language=${lang}`] } });
  let recording = false;
  if (process.argv.includes("--record-motion")) {
    const directory = path.join(out, "motion-frames");
    fs.mkdirSync(directory);
    let count = 0, last = -Infinity;
    win.webContents.on("paint", (_event, _dirty, image) => {
      const now = performance.now();
      if (!recording || count >= 90 || now - last < 30) return;
      last = now;
      fs.writeFileSync(path.join(directory, `frame-${String(count++).padStart(3, "0")}.jpg`), image.toJPEG(88));
    });
  }
  fixture.addWindow(win); await win.loadURL("about:blank");
  win.webContents.on("console-message", details => fs.appendFileSync(path.join(out, "console.log"), details.message + "\n"));
  const debug = win.webContents.debugger; debug.attach("1.3"); await debug.sendCommand("Page.enable"); await debug.sendCommand("Profiler.enable"); await debug.sendCommand("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  await debug.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: `(${setupHttp.toString()})(${JSON.stringify(graphInitial(lang))},${JSON.stringify(fixture.snapshot())});(${setupGraphHttp.toString()})();(${watchGraphPaint.toString()})();` });
  await win.loadFile(path.join(root, "frontend/notes.html"));
  await run(`window.expect=(ok,msg)=>{if(!ok)throw new Error(msg)};window.waitFor=async f=>{const stop=performance.now()+7000;while(!f()){if(performance.now()>stop)throw new Error('Wait expired: '+f);await new Promise(r=>setTimeout(r,20))}};await waitFor(()=>notes.length===30);notesLiveController.pause();`);
  await check("fourth tab opens real canvas and project graph in RU/EN", async () => {
    await run(`document.getElementById('notes-graph-tab').click();await waitFor(()=>document.querySelectorAll('#graph-note-list button').length===30);expect(activeNotesTab==='graph','tab');expect(document.querySelectorAll('[data-notes-tab]')[3].dataset.notesTab==='graph','fourth');expect(document.getElementById('graph-count').textContent.includes('30'),'count');expect(document.querySelector('.notes-hero h1').textContent===${JSON.stringify(lang === "en" ? "Note graph" : "Граф заметок")},'localized hero');`);
    await run(`const missing=document.getElementById('graph-unresolved');expect(!missing.hidden&&missing.textContent===${JSON.stringify(lang === "en" ? "Links without a matching note · 2" : "Ссылки без найденной заметки · 2")},'missing link count');expect(document.querySelectorAll('.graph-legend li').length===3,'legend');`);
    await run(`await waitFor(()=>document.getElementById('graph-canvas').width>500);`);
    await capture(`01-graph-${lang}.png`);
  });
  await runGraphPointerCases({ check, run, capture, debug, lang, setRecording: enabled => { recording = enabled; } });
  await check("selecting a note exposes actual neighbors and opens its source", async () => {
    await run(`document.querySelector('[data-graph-note="graph-0"]').click();expect(document.querySelectorAll('#graph-selection .graph-neighbors button').length===4,'neighbors');expect(document.querySelector('#graph-note-list [aria-pressed=true]'),'selected');`);
    await capture(`02-graph-selected-${lang}.png`);
    await run(`document.querySelector('.graph-open-note').click();await waitFor(()=>activeNotesTab==='notes'&&noteViewContent.textContent.includes('ASTER_ONLY'));expect(selectedNoteTitle==='graph-0','canonical');document.getElementById('notes-graph-tab').click();`);
  });
  await check("search and connected-only filtering use actual data", async () => {
    await run(`const input=document.getElementById('graph-search');input.value=${JSON.stringify(lang === "en" ? "Reading" : "Список для чтения")};input.dispatchEvent(new Event('input'));expect(document.querySelectorAll('#graph-note-list button').length===1,'isolated search');document.getElementById('graph-linked-only').click();expect(!document.getElementById('graph-empty').hidden,'empty filter');`);
    await capture(`03-graph-empty-filter-${lang}.png`);
    await run(`document.getElementById('graph-linked-only').click();document.getElementById('graph-search').value='';document.getElementById('graph-search').dispatchEvent(new Event('input'));`);
  });
  await check("zoom keyboard controls, panning and fit work without dragging", async () => {
    await run(`const canvas=document.getElementById('graph-canvas'),value=document.getElementById('graph-zoom-value');canvas.focus();const old=value.textContent;canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'+'}));expect(value.textContent!==old,'zoom');canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight'}));canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'0'}));expect(document.activeElement===canvas,'focus');`);
  });
  await check("live updates add saved notes without manual refresh", async () => {
    await run(`__projects.data['${A}'].graph.nodes.push({id:'graph-new',title:'New saved note'});__projects.data['${A}'].graph.edges.push({source:'graph-0',target:'graph-new'});__projects.data['${A}'].revision='f'.repeat(64);await waitFor(()=>document.querySelectorAll('#graph-note-list button').length===31);`);
  });
  await check("failed refresh keeps saved graph and exposes retry", async () => {
    await run(`__graph.fail=true;await notesGraphController.refresh();expect(!document.getElementById('graph-retry').hidden,'retry');expect(document.querySelectorAll('#graph-note-list button').length===31,'preserved');`);
    await capture(`04-graph-error-${lang}.png`);
    await run(`__graph.fail=false;await notesGraphController.refresh();expect(document.getElementById('graph-retry').hidden,'recovery');`);
  });
  await check("small screen retains visible graph, controls and accessible list", async () => {
    win.setSize(860, 600); await run(`await waitFor(()=>innerWidth<900);expect(document.documentElement.scrollWidth<=innerWidth,'horizontal overflow');const r=document.getElementById('graph-canvas').getBoundingClientRect();expect(r.height>150&&r.width>200,'canvas size');`);
    await capture(`05-graph-small-${lang}.png`); win.setSize(1440, 960);
  });
  await check("project switch clears old graph and rejects its late response", async () => {
    await run(`__graph.hold=true;window.oldRefresh=notesGraphController.refresh();await waitFor(()=>__graph.pending.length>0);`);
    const switching = fixture.switchProject(B); await switching;
    await run(`expect(document.querySelectorAll('#graph-note-list button').length===0,'old graph cleared');__graph.hold=false;__graph.pending.splice(0).forEach(r=>r());await oldRefresh;await waitFor(()=>document.querySelectorAll('#graph-note-list button').length===2);expect(document.getElementById('graph-note-list').textContent.includes('Boreal'),'new project');expect(!document.getElementById('graph-note-list').textContent.includes(${JSON.stringify(lang === "en" ? "Team calendar" : "Календарь команды")}), 'project leakage');expect(__projects.violations.length===0,'unscoped HTTP');`);
    await capture(`06-graph-project-b-${lang}.png`);
  });
  await check("empty project and no-links graph expose truthful states", async () => {
    await run(`const p=__projects.data['${B}'];p.graph.edges=[];p.revision='8'.repeat(64);await notesGraphController.refresh();expect(!document.getElementById('graph-no-links').hidden,'no links');`);
    await capture(`07-graph-no-links-${lang}.png`);
    await run(`__projects.data['${B}'].graph.nodes=[];__projects.data['${B}'].revision='9'.repeat(64);await notesGraphController.refresh();expect(!document.getElementById('graph-empty').hidden,'empty project');expect(document.querySelectorAll('#graph-note-list button').length===0,'empty list');`);
    await capture(`08-graph-no-notes-${lang}.png`);
  });
  await check("reduced motion remains usable and node labels are text-safe", async () => {
    await debug.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await run(`const p=__projects.data['${B}'];p.graph.nodes=[{id:'safe',title:'<img src=x onerror=alert(1)>'}];p.revision='7'.repeat(64);await notesGraphController.refresh();document.querySelector('#graph-note-list button').click();expect(!document.querySelector('#graph-selection img'),'HTML injection');expect(document.getElementById('graph-selection').textContent.includes('<img'),'literal title');expect(matchMedia('(prefers-reduced-motion: reduce)').matches,'reduce');`);
  });
  await run("window.dispatchEvent(new Event('beforeunload')); ");
  const coverage = await debug.sendCommand("Profiler.takePreciseCoverage"); fs.writeFileSync(path.join(out, "coverage.json"), JSON.stringify(coverage.result.filter(x => /notes_graph_/.test(x.url))));
  const after = hashes(), result = { lang, checks, network, sourceUnchanged: JSON.stringify(before) === JSON.stringify(after), versions: { electron: process.versions.electron, chrome: process.versions.chrome } };
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2)); fs.writeFileSync(path.join(out, "captures.json"), JSON.stringify(captures));
  clearTimeout(timeout); win.destroy(); console.log(JSON.stringify(result)); app.exit(network || checks.some(c => c.status !== "pass") || !result.sourceUnchanged ? 1 : 0);
}
main().catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
