"use strict";
const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { initial, createMainFixture, setupHttp } = require("./projects_fixture.cjs");
const root = path.resolve(__dirname, "../.."), out = path.resolve(process.argv[2] || "");
const frontend = path.resolve(process.argv[3] || path.join(root, "frontend"));
assert.ok(process.argv[2] && !fs.existsSync(out), "Use a fresh explicit output directory");
fs.mkdirSync(out, { recursive: true });
app.setPath("userData", path.join(out, "profile")); app.setPath("sessionData", path.join(out, "profile"));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-background-networking");
const checks = [], errors = []; let win, network = 0;
const timeout = setTimeout(() => { fs.writeFileSync(path.join(out, "timeout.json"), JSON.stringify(checks)); app.exit(2); }, 60000);
function setupEditor() {
  const state = window.__projects, original = window.fetch;
  state.patches = []; state.nextFailure = null;
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, location.href);
    if (options.method !== "PATCH") return original(url, options);
    const project = state.data[state.context.activeProjectId], headers = new Headers(options.headers);
    const title = decodeURIComponent(parsed.pathname.slice(13)), detail = project.details[title], body = JSON.parse(options.body);
    const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (headers.get("X-Noda-Project-Id") !== state.context.activeProjectId
        || headers.get("X-Noda-Project-Context") !== state.context.context.context_token
        || parsed.searchParams.get("expected_vault_id") !== project.vault) throw new Error("Unscoped synthetic edit");
    state.patches.push({ title, body });
    if (state.nextFailure) { const status = state.nextFailure; state.nextFailure = null;
      return response({ code: status === 409 ? "note_edit_conflict" : "synthetic_offline" }, status); }
    if (body.revision !== detail.edit_revision) return response({ code: "note_edit_conflict" }, 409);
    detail.editable_body = body.content; detail.content = body.content;
    detail.edit_revision = detail.content_revision = (state.patches.length + 5).toString(16).padStart(64, "0");
    project.revision = detail.edit_revision;
    const row = project.notes.find(note => note.title === title);
    row.snippet = body.content; row.content_revision = detail.content_revision;
    return response({ success: true, title, cache_updated: true });
  };
}
async function run() {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest(({ url }, done) => {
    const local = /^(file|data|about):/.test(url); if (!local) network++; done({ cancel: !local });
  });
  const fixture = createMainFixture(ipcMain, "ru"), seed = initial("ru");
  const titles = ["План запуска проекта", "Добавить напоминания", "Обновить дизайн", "API и интеграции", "Задачи на неделю", "Идеи для следующей версии"];
  const bodies = ["Собрать удобный рабочий экран: проекты слева, список заметок по центру и редактор справа.\n\nПроверить сохранение текста и переходы между заметками.",
    "Продумать напоминания и быстрый переход к задачам.", "Обновить навигацию, карточки заметок и состояния кнопок.",
    "Подготовить новые методы и проверить обработку ошибок.", "Согласовать план и расставить приоритеты.", "Собрать обратную связь и выбрать улучшения."];
  fixture.data.projects[0].name = seed.projects[0].name = "Мои задачи";
  fixture.data.projects[1].name = seed.projects[1].name = "Идеи";
  const project = seed.data[seed.A];
  project.notes = titles.map((title, index) => ({ title, display_title: title, snippet: bodies[index], tags: index === 2 ? ["Дизайн"] : index === 3 ? ["Бэкенд", "Интеграции"] : [],
    indexed: true, timestamp: `2026-11-${String(12 - index).padStart(2, "0")}T10:00:00Z`, content_revision: "1".repeat(64) }));
  project.details = Object.fromEntries(project.notes.map((note, index) => [note.title, { ...note, resolved_title: note.title,
    content: bodies[index], editable_body: bodies[index], edit_revision: "1".repeat(64) }]));
  win = new BrowserWindow({ width: 1600, height: 960, show: false, webPreferences: { preload: path.join(frontend, "preload.js"),
    sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false,
    additionalArguments: ["--noda-language=ru"] } });
  fixture.addWindow(win);
  await win.loadURL("about:blank"); const debug = win.webContents.debugger; debug.attach("1.3");
  await debug.sendCommand("Page.enable"); await debug.sendCommand("Profiler.enable");
  await debug.sendCommand("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  await debug.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source: `(${setupHttp.toString()})(${JSON.stringify(seed)},${JSON.stringify(fixture.snapshot())});(${setupEditor.toString()})();`,
  });
  win.webContents.on("console-message", details => { if (details.level === "error") errors.push(String(details.message)); });
  await win.loadFile(path.join(frontend, "notes.html"));
  const evaluate = source => win.webContents.executeJavaScript(source);
  await evaluate(`window.wait=async f=>{const end=performance.now()+7000;while(!f()){if(performance.now()>end)throw new Error('UI wait expired');await new Promise(r=>setTimeout(r,20));}};
    window.check=(v,m)=>{if(!v)throw new Error(m);};wait(()=>notes.length===6)`);
  async function check(name, body) {
    try { await body(); checks.push({ name, status: "pass" }); }
    catch (error) { checks.push({ name, status: "fail", error: String(error.stack || error) }); }
  }
  const capture = async name => {
    await evaluate("wait(()=>getComputedStyle(document.getElementById('startup-overlay')).opacity==='0')");
    await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
  };
  await check("opening immediately offers an editable body and hides redundant controls", async () => {
    await evaluate(`(async()=>{await selectNote(${JSON.stringify(titles[0])});check(!inlineEditor.inputElement.readOnly&&!inlineEditor.inputElement.hidden,'not editable');
      check(!document.getElementById('edit-note-btn')&&!document.getElementById('copy-note-btn'),'redundant actions');
      check(notesStatusCard.hidden&&getComputedStyle(document.getElementById('projects-breadcrumb')).display==='none','technical chrome visible');
      check(!document.querySelector('.note-actions-menu').open,'trash exposed');check(__projects.patches.length===0,'opening wrote a file');})()`);
    await capture("01-notes-desktop.png");
  });
  await check("real typing saves automatically with a scoped revision and preserves whitespace", async () => {
    await evaluate("inlineEditor.inputElement.focus();inlineEditor.inputElement.setSelectionRange(0,0)");
    win.webContents.insertText("  Правки  \n\n");
    await evaluate(`wait(()=>__projects.patches.length===1&&inlineEditor.getState().status==='saved')`);
    await evaluate(`check(__projects.patches[0].body.content.startsWith('  Правки  \\n\\n'),'whitespace changed');check(!inlineEditor.inputElement.readOnly,'typing locked after save')`);
  });
  await check("toolbar formatting uses native undo and keeps the caret selection", async () => {
    await evaluate("inlineEditor.inputElement.focus();inlineEditor.inputElement.setSelectionRange(2,8);document.querySelector('[data-format=bold]').click();check(inlineEditor.inputElement.value.startsWith('  **Правки**'),'format missing')");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
    await evaluate("wait(()=>inlineEditor.inputElement.value.startsWith('  Правки  '))");
    await evaluate("inlineEditor.flush()");
  });
  await check("preview sanitizes user Markdown and returns to the same editable source", async () => {
    await evaluate(`(async()=>{const before=inlineEditor.inputElement.value;document.getElementById('note-preview-toggle').click();
      check(inlineEditor.inputElement.hidden&&!noteViewContent.hidden,'preview inaccessible');
      renderMarkdownPreview('<img src="https://untrusted.invalid/test"><a href="javascript:alert(1)">bad</a><script>bad()</script>');
      check(!noteViewContent.querySelector('img,script,a[href^="javascript:"]'),'unsafe preview');document.getElementById('note-preview-toggle').click();
      check(!inlineEditor.inputElement.hidden&&inlineEditor.inputElement.value===before,'preview changed source');})()`);
  });
  await check("save failure retains editable text, retry confirms disk state then saves", async () => {
    await evaluate(`(async()=>{__projects.nextFailure=503;inlineEditor.inputElement.value+='\\nOffline draft';inlineEditor.inputElement.dispatchEvent(new Event('input'));
      await inlineEditor.flush();check(inlineEditor.getState().status==='error'&&!inlineEditor.inputElement.readOnly,'failure lost editability');
      check(!document.getElementById('note-save-retry').hidden,'retry absent');await inlineEditor.retry();check(!inlineEditor.isDirty(),'retry failed');})()`);
  });
  await check("disk conflicts retain drafts and offer a separate copy without overwrite", async () => {
    await evaluate(`(async()=>{__projects.nextFailure=409;inlineEditor.inputElement.value+='\\nMy version';inlineEditor.inputElement.dispatchEvent(new Event('input'));await inlineEditor.flush();
      check(inlineEditor.getState().status==='conflict'&&!document.getElementById('note-save-copy').hidden,'conflict not actionable');})()`);
    await capture("02-note-conflict.png");
    await evaluate(`document.getElementById('note-save-copy').click();check(creatingNote&&noteContentInput.value.includes('My version'),'copy recovery lost text');check(noteTitleInput.value.includes('копия'),'copy not named')`);
    await capture("03-new-note.png");
  });
  await check("filters and project actions are compact native menus and Escape closes them", async () => {
    await evaluate(`document.querySelector('.notes-filter-menu').open=true;document.getElementById('projects-add-menu').open=true;
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));check(!document.querySelector('.notes-compact-menu[open]'),'Escape failed')`);
  });
  await evaluate(`selectNote(${JSON.stringify(titles[1])})`);
  await check("900px layout exposes projects through the drawer and keeps text usable", async () => {
    win.setSize(860, 680);
    await evaluate(`(async()=>{await wait(()=>innerWidth===860);document.getElementById('workspace-project-toggle').click();
      check(document.getElementById('notes-projects-panel').getBoundingClientRect().width>150,'drawer missing');
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));check(!document.body.classList.contains('projects-drawer-open'),'drawer not closed');
      check(inlineEditor.inputElement.clientWidth>250&&inlineEditor.inputElement.clientHeight>150,'editor unusable');
      check(document.documentElement.scrollWidth<=innerWidth+1,'horizontal overflow');})()`);
    await capture("04-notes-compact.png");
  });
  await check("375px layout has accessible list, editor, back navigation and project picker", async () => {
    win.setSize(375, 720);
    await evaluate(`(async()=>{await wait(()=>innerWidth===375);check(inlineEditor.inputElement.clientWidth>250,'mobile editor missing');
      check(inlineEditor.inputElement.clientHeight>250,'mobile editor has no visible body');
      check(document.documentElement.scrollWidth<=innerWidth+1,'mobile overflow');document.getElementById('note-list-back').click();
      check(document.querySelector('.notes-library-sidebar').getBoundingClientRect().width>250,'list unreachable');
      document.getElementById('workspace-project-toggle').click();check(document.getElementById('notes-projects-panel').getBoundingClientRect().height>150,'project picker unreachable');
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));})()`);
    await capture("05-notes-mobile-list.png");
    await evaluate(`selectNote(${JSON.stringify(titles[1])})`); await capture("06-notes-mobile-editor.png");
  });
  await check("theme color and reduced motion preserve readable layout", async () => {
    win.setSize(1440, 900); await debug.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await evaluate(`(async()=>{await wait(()=>innerWidth===1440);document.documentElement.dataset.theme='noda-red';
      check(getComputedStyle(newNoteBtn).color!==getComputedStyle(newNoteBtn).backgroundColor,'theme contrast');check(document.documentElement.scrollWidth<=innerWidth+1,'theme overflow');})()`);
    await capture("07-notes-red-theme.png");
    await evaluate("document.documentElement.dataset.theme='classic-blue'"); await capture("08-notes-final.png");
  });
  await check("manual note content starts beside its label and uses the available writing space", async () => {
    await evaluate("beginNewNote()");
    for (const [width, height] of [[1440, 900], [860, 680], [375, 720]]) {
      win.setSize(width, height);
      await evaluate(`(async()=>{await wait(()=>innerWidth===${width});await new Promise(r=>requestAnimationFrame(r));
        const range=document.createRange();range.selectNodeContents(document.querySelector('#note-create-panel .content-field > span'));
        const label=range.getBoundingClientRect();
        const input=noteContentInput.getBoundingClientRect(), field=noteContentInput.parentElement.getBoundingClientRect();
        const actions=document.querySelector('#note-create-panel .editor-actions').getBoundingClientRect();
        const gap=input.top-label.bottom;
        check(gap>=4&&gap<=12,'content label separated from textarea: '+gap);
        check(input.height>=230&&Math.abs(input.bottom-field.bottom)<1,'writing area does not fill its field');
        check(actions.top>=input.bottom+12,'creation actions overlap the writing area');
        check(input.left>=0&&input.right<=innerWidth,'writing area clipped horizontally');
        check(document.documentElement.scrollWidth<=innerWidth+1,'creation page overflows horizontally');})()`);
      await capture(`09-create-content-${width}.png`);
    }
  });
  const coverage = await debug.sendCommand("Profiler.takePreciseCoverage");
  fs.writeFileSync(path.join(out, "coverage.json"), JSON.stringify(coverage));
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ checks, errors, network, electron: process.versions.electron }, null, 2));
  clearTimeout(timeout); win.destroy(); app.exit(checks.some(item => item.status !== "pass") || errors.length || network ? 1 : 0);
}
run().catch(error => { clearTimeout(timeout); fs.writeFileSync(path.join(out, "harness-error.txt"), String(error.stack || error)); app.exit(1); });
