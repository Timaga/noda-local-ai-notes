"use strict";
const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { initial, setup, wrapper } = require("./notes_live_fixture.cjs");
const root = path.resolve(__dirname, "../.."), out = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2] && !fs.existsSync(out), "Use a fresh external output directory");
fs.mkdirSync(out, { recursive: true });
app.setPath("userData", path.join(out, "profile")); app.setPath("sessionData", path.join(out, "profile"));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-background-networking");
const checks = [], errors = []; let network = 0;
const watchdog = setTimeout(() => { fs.writeFileSync(path.join(out, "timeout.json"), JSON.stringify(checks)); app.exit(2); }, 60000);
async function run() {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest(({ url }, done) => {
    const local = /^(file|data|about):/.test(url); if (!local) network++; done({ cancel: !local });
  });
  for (const [name, value] of Object.entries({
    "get-projects": { ok: true, mode: "legacy", projects: [], activeProjectId: null, activeProject: null, context: null, status: "ready" },
    "get-startup-status": { state: "ready", phase: "ready", progress: 100, language: "en" },
    "ensure-backend": { ok: true }, "ensure-chat-runtime": { ok: true }, "startup-renderer-ready": { ok: true }, "complete-startup": { ok: true },
    "get-hotkey": "Control+Shift+Space",
  })) ipcMain.handle(`quick-note:${name}`, () => value);
  const win = new BrowserWindow({ width: 1440, height: 960, show: false, webPreferences: {
    preload: path.join(root, "frontend/preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false,
    offscreen: true, backgroundThrottling: false, additionalArguments: ["--noda-language=en"] } });
  win.webContents.on("console-message", info => { if (info.level === "error") errors.push(String(info.message)); });
  await win.loadURL("about:blank"); const debug = win.webContents.debugger; debug.attach("1.3");
  await debug.sendCommand("Page.enable"); await debug.sendCommand("Profiler.enable");
  await debug.sendCommand("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  const data = initial("en");
  data.details[data.canonical].content = data.generated;
  data.details[data.canonical].editable_body = data.source;
  data.details[data.canonical].edit_revision = "1".repeat(64);
  for (const title of ["Список мастерских", "Весеннее обслуживание"]) Object.assign(data.details[title], {
    editable_body: data.details[title].content, edit_revision: "2".repeat(64),
  });
  data.details["Incoming"] = { title: "Incoming", resolved_title: "Incoming", tags: [], content: wrapper("Incoming source", { related: [data.canonical] }) };
  data.legacySource = '#crm\n\nTicket workflow for CRM.\n\n## Connected notes\n- [[CRM]]\n- **Important item**\n\n```text\n[[Literal example]]\n```';
  data.details['Legacy Markdown'] = { title: 'Legacy Markdown', resolved_title: 'Legacy Markdown', tags: ['crm'],
    content: data.legacySource, editable_body: data.legacySource, edit_revision: '3'.repeat(64) };
  data.details.CRM = { title: 'CRM', resolved_title: 'CRM', tags: [], content: 'CRM source' };
  await debug.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: `(${setup.toString()})(${JSON.stringify(data)});` });
  await win.loadFile(path.join(root, "frontend/notes.html"));
  const evaluate = source => win.webContents.executeJavaScript(source);
  await evaluate(`window.check=(value,message)=>{if(!value)throw new Error(message)};
    window.wait=async fn=>{const end=performance.now()+5000;while(!fn()){if(performance.now()>end)throw new Error('Native UI state timeout');await new Promise(r=>setTimeout(r,15))}};void 0;`);
  async function check(name, source) {
    try { await evaluate(`(async()=>{${source}})()`); checks.push({ name, status: "pass" }); }
    catch (error) { checks.push({ name, status: "fail", error: String(error.stack || error) }); }
    fs.appendFileSync(path.join(out, "checks.jsonl"), JSON.stringify(checks.at(-1)) + "\n");
  }
  await check("legacy Obsidian Markdown opens formatted by default without writing a file", `
    await wait(()=>notes.length===101);notesLiveController.pause();await selectNote('Legacy Markdown');
    check(inlineEditor.inputElement.hidden&&!noteViewContent.hidden,'opened raw source');
    check(document.getElementById('note-preview-toggle').getAttribute('aria-pressed')==='true','preview not selected');
    check(noteViewContent.querySelector('h2')?.textContent==='Connected notes','heading not formatted');
    check(noteViewContent.querySelectorAll('li').length===2&&noteViewContent.querySelector('strong')?.textContent==='Important item','list or bold not formatted');
    check(noteViewContent.querySelector('pre code')?.textContent.includes('[[Literal example]]'),'literal code changed');
    check(noteViewContent.querySelector('[data-note-title="CRM"]')?.textContent==='CRM','Obsidian link not rendered');
    check(__live.calls.filter(x=>x.method==='PATCH').length===0,'opening preview wrote to disk');`);
  await check("preview links open their notes and returning to another note defaults to preview again", `
    noteViewContent.querySelector('[data-note-title="CRM"]').click();await wait(()=>selectedNoteTitle==='CRM');
    await selectNote('Legacy Markdown');check(inlineEditor.inputElement.hidden&&!noteViewContent.hidden,'return opened source mode');`);
  await check("source switching and same-note refresh preserve edits, while reopened drafts are formatted", `
    NodaPreferences.preview({editorAutoSave:false});const toggle=document.getElementById('note-preview-toggle');toggle.click();
    check(!inlineEditor.inputElement.hidden&&inlineEditor.inputElement.value===__live.legacySource,'source changed or inaccessible');
    inlineEditor.inputElement.value+='\\n\\n**Draft text**';inlineEditor.inputElement.dispatchEvent(new Event('input'));
    renderNoteView(selectedNoteDetail);check(!inlineEditor.inputElement.hidden,'same-note refresh reset editing mode');
    toggle.click();check(noteViewContent.querySelectorAll('strong').length===2,'draft preview missing formatting');
    await selectNote('CRM');await selectNote('Legacy Markdown');
    check(inlineEditor.inputElement.hidden&&noteViewContent.querySelectorAll('strong').length===2,'reopened draft not formatted');
    check(inlineEditor.inputElement.value===__live.legacySource+'\\n\\n**Draft text**','draft changed');
    check(__live.calls.filter(x=>x.method==='PATCH').length===0,'mode change published manual edits');`);
  await evaluate(`(async()=>{await wait(()=>{const x=document.getElementById('startup-overlay');return !x||x.hidden||getComputedStyle(x).opacity==='0'||getComputedStyle(x).display==='none'});
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
  fs.writeFileSync(path.join(out, "formatted-default-en.png"), (await win.webContents.capturePage()).toPNG());
  await check("saved connections are visible during immediate editing with canonical IDs and no duplicate preview list", `
    await wait(()=>notes.length===101);notesLiveController.pause();await selectNote(__live.canonical);
    await wait(()=>document.querySelectorAll('#note-related .note-related-link').length===3);
    check(inlineEditor.inputElement.hidden&&!noteViewContent.hidden,'default preview missing');
    check([...document.querySelectorAll('#note-related button')].some(x=>x.dataset.noteTitle==='Incoming'),'backlink missing');
    check(!document.getElementById('note-related').hidden,'preview hides connections');
    check(!noteViewContent.querySelector('[data-note-title]'),'metadata duplicated in preview');
    document.getElementById('note-preview-toggle').click();`);
  await check("keyboard opens a connected note and restores an unsaved draft without publishing text", `
    NodaPreferences.preview({editorAutoSave:false});const input=inlineEditor.inputElement;
    input.value=__live.source+' Unsaved draft';input.dispatchEvent(new Event('input'));
    window.beforeWrites=__live.calls.filter(x=>x.method==='PATCH').length;
    const button=document.querySelector('#note-related [data-note-title="Список мастерских"]');button.focus();`);
  win.webContents.focus();
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await check("native Enter navigation preserves author text and transfers focus to the editor", `
    await wait(()=>selectedNoteTitle==='Список мастерских');
    check(document.activeElement===noteViewContent,'preview keyboard focus lost');
    await selectNote(__live.canonical);
    check(inlineEditor.inputElement.value===__live.source+' Unsaved draft','unsaved source lost');
    check(__live.calls.filter(x=>x.method==='PATCH').length===beforeWrites,'autosave-off navigation published text');`);
  await check("read-only connected notes receive keyboard focus in the preview", `
    document.querySelector('#note-related [data-note-title="Incoming"]').click();
    await wait(()=>selectedNoteTitle==='Incoming');await Promise.resolve();
    check(document.activeElement===noteViewContent,'read-only preview focus lost');await selectNote(__live.canonical);`);
  await check("chat exposes source buttons and clicking a citation opens that exact note", `
    __live.ragPayload={response:'See the saved workshop note.',context:[{title:'Список мастерских',snippet:'Synthetic source excerpt'}],context_source:'qdrant'};
    activateNotesTab('chat');const input=document.getElementById('chat-input');input.value='Where is the workshop?';
    document.getElementById('chat-form').requestSubmit();await wait(()=>!!document.querySelector('.chat-source-pill'));
    check(document.querySelector('.chat-source-pill').textContent==='Список мастерских','source title missing');
    document.querySelector('.chat-source-pill').click();
    await wait(()=>selectedNoteTitle==='Список мастерских'&&activeNotesTab==='notes');
    await selectNote(__live.canonical);`);
  for (const [language, label] of [["en", "Connected notes"], ["ru", "Связанные заметки"], ["es", "Notas conectadas"]]) {
    await check(`${language} connection heading is localized`, `nodaI18n.setLanguage('${language}');relatedNotes.refreshLanguage();
    renderNoteView(selectedNoteDetail);
    check(document.getElementById('note-related-heading').textContent===${JSON.stringify(label)},'wrong heading');`);
  }
  await evaluate("activateNotesTab('chat');new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  fs.writeFileSync(path.join(out, "chat-sources-en.png"), (await win.webContents.capturePage()).toPNG());
  await evaluate("activateNotesTab('notes');void 0;");
  await evaluate(`(async()=>{nodaI18n.setLanguage('en');renderNoteView(selectedNoteDetail);relatedNotes.refreshLanguage();notesLiveController.pause();
    await wait(()=>{const x=document.getElementById('startup-overlay');return !x||x.hidden||getComputedStyle(x).opacity==='0'||getComputedStyle(x).display==='none'});})()`);
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  fs.writeFileSync(path.join(out, "connected-notes-en.png"), (await win.webContents.capturePage()).toPNG());
  await win.setSize(620, 820);
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await check("narrow editor keeps connections visible without horizontal overflow", `
    notesWorkspace.openNote();const section=document.getElementById('note-related');
    check(section.scrollWidth<=section.clientWidth+1,'connections overflow');
    check(section.getBoundingClientRect().height>0,'connections hidden on narrow layout');`);
  fs.writeFileSync(path.join(out, "connected-notes-narrow.png"), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(out, "coverage.json"), JSON.stringify(await debug.sendCommand("Profiler.takePreciseCoverage")));
  const result = { checks, errors, blockedNetwork: network, electron: process.versions.electron };
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); clearTimeout(watchdog); win.destroy();
  app.exit(checks.some(x => x.status !== "pass") || errors.length || network ? 1 : 0);
}
run().catch(error => { clearTimeout(watchdog); fs.writeFileSync(path.join(out, "harness-error.txt"), String(error.stack || error)); app.exit(1); });
