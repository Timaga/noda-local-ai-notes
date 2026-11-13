"use strict";

const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { A, B, C, initial, createMainFixture, setupHttp } = require("./projects_fixture.cjs");
const { runQuickCases } = require("./projects_quick_cases.cjs");

const root = path.resolve(__dirname, "../.."), out = path.resolve(process.argv[2] || ""), language = process.argv[3] === "en" ? "en" : "ru";
assert.ok(process.argv[2] && !fs.existsSync(out), "Pass a fresh explicit output directory");
fs.mkdirSync(out, { recursive: true });
app.setPath("userData", path.join(out, "profile")); app.setPath("sessionData", path.join(out, "profile"));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-background-networking");
app.on("window-all-closed", () => {});
const files = ["notes.html", "style.css", "notes_projects.css", "notes_projects_controller.js", "notes_projects_view.js", "notes_note_actions.js",
  "project_context.js", "notes_renderer.js", "notes_live_application.js", "notes_live_sync.js", "notes_list_view.js", "notes_chat_renderer.js",
  "preload.js", "notes_settings_renderer.js", "notes_settings_note_pairs.js", "desktop_project_controller.js", "index.html", "renderer.js", "quick_capture_project.js", "generation_queue_client.js"];
const hashes = () => Object.fromEntries(files.map(name => [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "frontend", name))).digest("hex")]));
const before = hashes(), checks = [], captures = [], coverage = [], windows = [];
let network = 0, fixture;
const timeout = setTimeout(() => { fs.writeFileSync(path.join(out, "timeout.json"), JSON.stringify(checks)); app.exit(2); }, 90000);

async function context(file, width = 1440, height = 960) {
  const win = new BrowserWindow({ width, height, show: false, webPreferences: { preload: path.join(root, "frontend/preload.js"),
    sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false,
    additionalArguments: [`--noda-language=${language}`] } });
  windows.push(win); fixture.addWindow(win); await win.loadURL("about:blank");
  const debug = win.webContents.debugger; debug.attach("1.3");
  await debug.sendCommand("Page.enable"); await debug.sendCommand("Profiler.enable");
  await debug.sendCommand("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  await debug.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source: `(${setupHttp.toString()})(${JSON.stringify(initial(language))},${JSON.stringify(fixture.snapshot())});`,
  });
  win.webContents.on("console-message", details => fs.appendFileSync(path.join(out, "renderer-console.log"), String(details.message).slice(0, 1000) + "\n"));
  await win.loadFile(path.join(root, "frontend", file));
  await win.webContents.executeJavaScript(`window.__pAssert=(x,m)=>{if(!x)throw new Error(m);};
    window.__pWait=async f=>{const until=performance.now()+7000;while(!f()){if(performance.now()>until)throw new Error('Native fixture wait expired');await new Promise(r=>setTimeout(r,20));}};
    window.__pFrame=()=>new Promise(r=>requestAnimationFrame(r));void 0;`);
  const evaluate = async source => {
    const result = await win.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${source})};}catch(e){return {ok:false,error:String(e.stack||e)}}})()`);
    if (!result.ok) throw new Error(result.error); return result.value;
  };
  return { win, evaluate };
}
async function check(name, body) {
  try { checks.push({ name, status: "pass", detail: await body() }); }
  catch (error) {
    const win = windows.findLast(item => !item.isDestroyed());
    const diagnostic = win ? await win.webContents.executeJavaScript(`(()=>{const m=document.getElementById('projects-message');
      window.__rollbackObserver?.disconnect();return {context:window.NodaProjectContext?.snapshot(),message:m?{text:m.textContent,role:m.getAttribute('role'),hidden:m.hidden}:null,
      focused:document.activeElement?.outerHTML.slice(0,300),rollbackTransitions:window.__rollbackTransitions,
      detailBody:document.getElementById('note-view-content')?{clientHeight:document.getElementById('note-view-content').clientHeight,scrollHeight:document.getElementById('note-view-content').scrollHeight}:null};})()`).catch(() => null) : null;
    checks.push({ name, status: "fail", error: String(error.stack || error).slice(0, 3000), diagnostic });
  }
  fs.appendFileSync(path.join(out, "checks.jsonl"), JSON.stringify(checks.at(-1)) + "\n");
}
async function capture(ctx, name, state) {
  await ctx.evaluate(`(async()=>{await __pWait(()=>{const x=document.getElementById('startup-overlay');return !x||x.hidden||getComputedStyle(x).opacity==='0'});await __pFrame();await __pFrame()})()`);
  const bitmap = await ctx.win.webContents.capturePage(), png = bitmap.toPNG(), target = path.join(out, name);
  fs.writeFileSync(target, png); captures.push({ path: target, state, language, ...bitmap.getSize(), sha256: crypto.createHash("sha256").update(png).digest("hex") });
}
async function selectProject(ctx, id) {
  await ctx.evaluate(`document.querySelector('[data-project-id="${id}"]').click()`);
  await ctx.evaluate(`__pWait(()=>NodaProjectContext.snapshot().projectId==='${id}'&&NodaProjectContext.snapshot().status==='ready'&&document.querySelector('.notes-projects-layout').getAttribute('aria-busy')==='false')`);
  await ctx.evaluate("notesLiveController.pause()");
}
async function finishContext(ctx) {
  await ctx.evaluate("window.dispatchEvent(new Event('beforeunload'))");
  const result = await ctx.win.webContents.debugger.sendCommand("Profiler.takePreciseCoverage");
  coverage.push(result.result.filter(script => /file:.*frontend\//.test(script.url)));
  ctx.win.destroy();
}
function publishResults(mode = "full") {
  const after = hashes(), result = { language, mode, checks, network, sourceUnchanged: JSON.stringify(before) === JSON.stringify(after), electron: process.versions.electron, chrome: process.versions.chrome };
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(out, "source-hashes.json"), JSON.stringify({ before, after }, null, 2));
  fs.writeFileSync(path.join(out, "captures.json"), JSON.stringify(captures, null, 2));
  fs.writeFileSync(path.join(out, "coverage.json"), JSON.stringify(coverage)); console.log(JSON.stringify(result));
  clearTimeout(timeout); app.exit(checks.some(item => item.status !== "pass") || network || !result.sourceUnchanged ? 1 : 0);
}
async function extraMapStates(ctx) {
  const run = ctx.evaluate;
  await run("selectNote('CRM')");
  await check("project search with no matches keeps the active source and shows an empty result", async () => {
    await run(`(()=>{notesSearch.value='Несуществующая запись';notesSearch.dispatchEvent(new Event('input'));
      __pAssert(notes.length===2&&notesList.querySelectorAll('.note-list-button').length===0&&notesList.textContent.trim(),'search did not show a real empty result');
      __pAssert(noteViewContent.textContent.includes('ASTER_ONLY'),'search changed the selected project source');})()`);
    await capture(ctx, "12-project-search-empty-ru.png", "project-search-empty");
  });
  await check("the tagged filter excludes an actual untagged note in the project layout", async () => {
    await run(`(async()=>{notesSearch.value='';notesSearch.dispatchEvent(new Event('input'));const p=__projects.data['${A}'];
      p.notes.push({title:'Без тега',snippet:'Отдельная синтетическая заметка без тегов.',tags:[],indexed:true,content_revision:'7'.repeat(64)});p.revision='7'.repeat(64);
      await notesLiveController.refresh();Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='С тегами').click();
      __pAssert(notes.length===3&&activeNotesFilter==='tagged'&&notesList.querySelectorAll('.note-list-button').length===2,'tagged filter did not change the visible result');
      __pAssert(!notesList.querySelector('[data-note-title="Без тега"]')&&__projects.violations.length===0,'untagged or unscoped data entered filtered result');})()`);
    await capture(ctx, "13-project-tagged-ru.png", "project-tagged-filter");
  });
}

async function run() {
  await app.whenReady(); fixture = createMainFixture(ipcMain, language);
  session.defaultSession.webRequest.onBeforeRequest(({ url }, done) => { const local = /^(file|data|about):/.test(url); if (!local) network++; done({ cancel: !local }); });
  const ctx = await context("notes.html"), run = ctx.evaluate;
  await run("__pWait(()=>document.querySelectorAll('.project-button').length===2&&notes.length===2&&document.querySelector('.notes-projects-layout').getAttribute('aria-busy')==='false')");
  await run("notesLiveController.pause()");
  if (process.argv[4] === "--map-extra") {
    assert.equal(language, "ru"); await extraMapStates(ctx); await finishContext(ctx); publishResults("map-extra"); return;
  }
  await check("project mode starts with an explicit project and no implicit note selection", () => run(`(()=>{
    __pAssert(NodaProjectContext.snapshot().projectId==='${A}'&&selectedNoteTitle===''&&!creatingNote,'wrong initial context/selection');
    __pAssert(document.querySelector('[data-project-id="${A}"]').getAttribute('aria-current')==='true','active project missing');
    __pAssert(document.getElementById('projects-heading').textContent.trim()===${JSON.stringify(language === "en" ? "Projects" : "Проекты")},'project heading not localized');
    __pAssert(document.querySelector('[data-project-id="${A}"] .project-count').textContent==='2','project count incorrect');})()`));
  await check("same CRM identifier resolves only within the current project", () => run(`(async()=>{
    await selectNote('CRM');__pAssert(noteViewContent.textContent.includes('ASTER_ONLY')&&!noteViewContent.textContent.includes('BOREAL_ONLY'),'wrong A source');
    __pAssert(noteViewTags.textContent.includes('#aster')&&!noteViewTags.textContent.includes('#boreal'),'wrong A tags');
    __pAssert(noteViewContent.querySelector('a[data-note-title]')?.dataset.noteTitle==='Aster — план','wrong A links');
    __pAssert(document.getElementById('project-breadcrumb-note').textContent==='Aster CRM','breadcrumb missing display title');})()`));
  await check("desktop layout orders projects, notes, detail without horizontal overflow", () => run(`(()=>{
    const boxes=['.notes-projects-panel','.notes-sidebar','.notes-viewer'].map(s=>document.querySelector(s).getBoundingClientRect());
    __pAssert(boxes.every(r=>r.width>100&&r.height>100)&&boxes[0].right<=boxes[1].left+1&&boxes[1].right<=boxes[2].left+1,'three columns overlap or collapse');
    __pAssert(document.documentElement.scrollWidth<=innerWidth+1,'desktop page overflows horizontally');})()`));
  await capture(ctx, `01-projects-${language}.png`, "projects-notes-detail");
  await check("project actions are keyboard reachable, target the chosen project, and explain disconnection", async () => {
    await run(`(()=>{const row=id=>document.querySelector('[data-project-id="'+id+'"]').parentElement;
      const open=id=>row(id).querySelector('.project-manage-button').click();
      const menu=document.getElementById('project-management-dialog'), detach=document.getElementById('project-management-detach');
      open('${A}');__pAssert(menu.open&&detach.disabled&&!document.getElementById('project-management-hint').hidden,'active project detach');
      menu.close();open('${B}');__pAssert(menu.open&&!detach.disabled,'inactive project detach');
      const scope=document.getElementById('project-management-backup-hint').textContent;
      __pAssert(scope.includes('Markdown')&&scope.includes('JPEG')&&scope.includes(${JSON.stringify(language === "en" ? "drafts, chats, settings" : "черновики, чаты, настройки")}), 'backup scope');
      const confirm=window.confirm;let warning='';window.confirm=text=>(warning=text,false);detach.click();window.confirm=confirm;
      __pAssert(warning.includes('Boreal')&&menu.open,'detach cancellation');
    })()`);
    await capture(ctx, `12-project-management-${language}.png`, "project-management");
    await run(`(async()=>{const menu=document.getElementById('project-management-dialog'), form=document.getElementById('project-name-form');
      const rename=()=>document.getElementById('project-management-rename').click();
      for(const name of ['Archive', 'Boreal']) { rename();
        __pAssert(document.activeElement.id==='project-name-input','rename focus');
        document.getElementById('project-name-input').value=name;form.requestSubmit();
        await __pWait(()=>!document.getElementById('project-name-dialog').open&&document.getElementById('project-management-heading').textContent===name);
      }
      document.getElementById('project-management-backup').click();
      await __pWait(()=>document.getElementById('project-management-status').textContent.includes('Noda-copy'));
      __pAssert(document.getElementById('project-management-status').textContent.includes(${JSON.stringify(language === "en" ? "verified" : "проверена")}), 'backup verification status');
      document.getElementById('project-management-open').click();await __pWait(()=>!menu.open);
    })()`);
    const opened = fixture.calls.findLast(call => call.action === "openProjectFolder");
    assert.deepEqual(opened.payload, { projectId: A, contextToken: fixture.snapshot().context.context_token, targetId: B });
    assert.deepEqual(fixture.calls.findLast(call => call.action === "backupProject").payload, opened.payload);
  });
  await check("an initially unknown count is persisted and new background notes update the project count", async () => {
    await run(`__pWait(()=>NodaProjectContext.snapshot().projectState.projects.find(p=>p.id==='${A}').noteCount===2)`);
    assert.ok(fixture.calls.some(call => call.action === "count" && call.payload.projectId === A && call.payload.count === 2));
    await run(`(async()=>{const p=__projects.data['${A}'];p.notes.push({...p.notes[1],title:'Background count entry'});p.revision='4'.repeat(64);
      window.dispatchEvent(new Event('focus'));await __pWait(()=>document.querySelector('[data-project-id="${A}"] .project-count').textContent==='3');
      __pAssert(notes.length===3,'count did not match actual notes');notesLiveController.pause();
      p.notes.pop();p.revision='5'.repeat(64);await notesLiveController.refresh();})()`);
  });
  await check("create dialog validates names before invoking the native picker and cancel keeps current project", async () => {
    const before = fixture.calls.filter(call => call.action === "create").length;
    await run(`(async()=>{document.getElementById('create-project-btn').click();
      __pAssert(document.getElementById('project-name-dialog').open&&document.activeElement.id==='project-name-input','dialog did not focus input');
      document.getElementById('project-name-input').value='../outside';document.getElementById('project-name-form').requestSubmit();
      await __pFrame();__pAssert(!document.getElementById('project-name-error').hidden,'invalid project name accepted');})()`);
    assert.equal(fixture.calls.filter(call => call.action === "create").length, before);
    await run("(()=>{document.getElementById('project-name-cancel').click();document.getElementById('create-project-btn').click();document.getElementById('project-name-input').value='New knowledge';})()");
    await capture(ctx, `05-project-create-${language}.png`, "project-create-name");
    await run(`(async()=>{document.getElementById('project-name-form').requestSubmit();
      await __pWait(()=>!document.getElementById('project-name-submit').disabled);__pAssert(NodaProjectContext.snapshot().projectId==='${A}','cancel changed project');
      document.getElementById('project-name-cancel').click();__pAssert(!document.getElementById('project-name-dialog').open,'cancel button failed');})()`);
    assert.equal(fixture.calls.filter(call => call.action === "create").at(-1).payload.name, "New knowledge");
  });
  await check("connect cancellation and picker errors preserve the previous data", async () => {
    await run(`(async()=>{document.getElementById('connect-project-btn').click();await __pWait(()=>!document.getElementById('connect-project-btn').disabled);})()`);
    fixture.nextConnect = "error";
    await run(`(async()=>{document.getElementById('connect-project-btn').click();await __pWait(()=>document.getElementById('projects-message').getAttribute('role')==='alert');
      __pAssert(NodaProjectContext.snapshot().projectId==='${A}'&&noteViewContent.textContent.includes('ASTER_ONLY'),'picker error changed data');})()`);
  });
  await check("switching hides old data, blocks requests and shows a loading state before B commits", async () => {
    fixture.holdSwitch = true;
    await run(`document.querySelector('[data-project-id="${B}"]').click()`);
    await run(`(async()=>{await __pWait(()=>NodaProjectContext.snapshot().status==='switching');
      __pAssert(!document.getElementById('projects-switch-overlay').hidden&&document.querySelector('.notes-sidebar').inert,'switching does not block UI');
      __pAssert(noteViewContent.textContent===''&&notes.length===0,'A data remains in switching view');
      __pAssert(notesStatusText.textContent==='','old note status survived the project switch');
      const before=__projects.calls.length;await NodaProjectContext.fetch('/notes').then(()=>{throw new Error('switch request admitted')},()=>{});
      __pAssert(before===__projects.calls.length,'HTTP dispatched while switching');})()`);
    await capture(ctx, `02-switching-${language}.png`, "project-switching");
    fixture.holdSwitch = false; fixture.release();
    await run(`__pWait(()=>NodaProjectContext.snapshot().projectId==='${B}'&&document.querySelector('.notes-projects-layout').getAttribute('aria-busy')==='false')`);
    await run(`(async()=>{notesLiveController.pause();await selectNote('CRM');
      __pAssert(noteViewContent.textContent.includes('BOREAL_ONLY')&&!noteViewContent.textContent.includes('ASTER_ONLY'),'B leaked A body');
      __pAssert(noteViewTags.textContent.includes('#boreal')&&!noteViewTags.textContent.includes('#aster'),'B leaked A tags');
      __pAssert(notes.length===3&&document.querySelector('[data-project-id="${B}"] .project-count').textContent==='3','B count incorrect');})()`);
  });
  await check("a failed project switch rolls back to the previous project without a mixed view", async () => {
    fixture.nextSwitch = "error";
    await run(`(()=>{const node=document.getElementById('projects-message');window.__rollbackTransitions=[];
      window.__rollbackObserver=new MutationObserver(()=>{if(window.__rollbackTransitions.length<40)window.__rollbackTransitions.push({text:node.textContent,role:node.getAttribute('role'),hidden:node.hidden});});
      window.__rollbackObserver.observe(node,{attributes:true,childList:true,subtree:true});})()`);
    await run(`document.querySelector('[data-project-id="${A}"]').click()`);
    await run(`(async()=>{await __pWait(()=>document.getElementById('projects-message').getAttribute('role')==='alert');
      __pAssert(NodaProjectContext.snapshot().projectId==='${B}'&&notes.length===3,'rollback context incorrect');
      __pAssert(!noteViewContent.textContent.includes('ASTER_ONLY'),'rollback mixed source');notesLiveController.pause();})()`);
    await capture(ctx, `06-project-rollback-${language}.png`, "project-switch-error-rollback");
    await run("window.__rollbackObserver.disconnect()");
  });
  await check("draft text and view inputs are restored independently for A and B", async () => {
    await selectProject(ctx, A);
    await run(`(()=>{beginNewNote();noteTitleInput.value='A draft';noteContentInput.value=' A exact draft\\nsecond line ';noteTagsInput.value='aster';})()`);
    await selectProject(ctx, B);
    await run(`(()=>{beginNewNote();noteTitleInput.value='B draft';noteContentInput.value=' B independent draft ';noteTagsInput.value='boreal';})()`);
    await selectProject(ctx, A);
    await run(`(()=>{__pAssert(creatingNote&&noteTitleInput.value==='A draft'&&noteContentInput.value===' A exact draft\\nsecond line '&&noteTagsInput.value==='aster','A draft not restored');})()`);
    await capture(ctx, `10-project-draft-${language}.png`, "project-scoped-draft");
    await selectProject(ctx, B);
    await run(`(()=>{__pAssert(creatingNote&&noteTitleInput.value==='B draft'&&noteContentInput.value===' B independent draft ','B draft not restored');})()`);
  });
  await check("an old detail body resolved after project switch cannot replace B CRM", async () => {
    await selectProject(ctx, A);
    await run(`(()=>{__projects.hold={id:'${A}',path:'/note-detail/CRM',phase:'json'};window.__oldDetail=selectNote('CRM').catch(()=>{});})()`);
    await run("__pWait(()=>__projects.pending.length>0)"); await selectProject(ctx, B);
    await run(`(async()=>{await selectNote('CRM');__projects.hold=null;__projects.pending.splice(0).forEach(x=>x.release());await window.__oldDetail;
      __pAssert(noteViewContent.textContent.includes('BOREAL_ONLY')&&!noteViewContent.textContent.includes('ASTER_ONLY'),'old response crossed project');})()`);
  });
  await check("a delayed A list body cannot repopulate the B project", async () => {
    await selectProject(ctx, A);
    await run(`(()=>{__projects.hold={id:'${A}',path:'/notes',method:'GET',phase:'json'};window.__oldList=notesLiveController.refresh().catch(()=>{});})()`);
    await run("__pWait(()=>__projects.pending.length>0)"); await fixture.switchProject(B);
    await run(`(async()=>{await __pWait(()=>NodaProjectContext.snapshot().projectId==='${B}');
      __pAssert(!noteViewContent.textContent.includes('ASTER_ONLY'),'old source remained during B activation');
      __projects.hold=null;__projects.pending.splice(0).forEach(x=>x.release());await window.__oldList;
      await __pWait(()=>notes.length===3&&document.querySelector('.notes-projects-layout').getAttribute('aria-busy')==='false');
      __pAssert(notes.every(n=>n.tags.includes('boreal')),'old list crossed project');notesLiveController.pause();})()`);
  });
  await check("a delayed RAG answer cannot appear in another project's chat history", async () => {
    await selectProject(ctx, A);
    await run(`(()=>{activateNotesTab('chat');__projects.hold={id:'${A}',path:'/rag',phase:'json'};
      document.getElementById('chat-input').value='ASTER confidential question';document.getElementById('chat-form').requestSubmit();})()`);
    await run("__pWait(()=>__projects.pending.length>0)"); await fixture.switchProject(B);
    await run(`(async()=>{await __pWait(()=>NodaProjectContext.snapshot().projectId==='${B}'&&!document.getElementById('chat-input').disabled);
      __pAssert(!document.getElementById('chat-messages').textContent.includes('ASTER'),'A conversation leaked into B');
      __projects.hold=null;document.getElementById('chat-input').value='BOREAL public question';document.getElementById('chat-form').requestSubmit();
      await __pWait(()=>document.getElementById('chat-messages').textContent.includes('BOREAL_ONLY RAG answer'));
      __projects.pending.splice(0).forEach(x=>x.release());await __pFrame();await __pFrame();
      __pAssert(!document.getElementById('chat-messages').textContent.includes('ASTER'),'late A RAG overwrote B chat');})()`);
    await capture(ctx, `07-project-chat-${language}.png`, "project-scoped-chat");
    await run("(()=>{activateNotesTab('notes');notesLiveController.pause();})()");
  });
  await check("an admitted old write response cannot clear or close the new project's draft", async () => {
    await selectProject(ctx, A);
    await run(`(()=>{beginNewNote();noteTitleInput.value='Saved A';noteContentInput.value='A submitted body';
      __projects.hold={id:'${A}',path:'/notes',method:'POST',phase:'fetch'};window.__oldWrite=createNote().catch(()=>{});})()`);
    await run("__pWait(()=>__projects.pending.length>0)"); await selectProject(ctx, B);
    await run(`(async()=>{beginNewNote();noteTitleInput.value='Unsaved B';noteContentInput.value='B must remain';
      __projects.hold=null;__projects.pending.splice(0).forEach(x=>x.release());await window.__oldWrite;
      __pAssert(creatingNote&&noteTitleInput.value==='Unsaved B'&&noteContentInput.value==='B must remain','old write affected B draft');})()`);
  });
  await check("project buttons support keyboard activation through native input events", async () => {
    await run(`document.querySelector('[data-project-id="${A}"]').focus()`);
    await ctx.win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
    await ctx.win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await run(`__pWait(()=>NodaProjectContext.snapshot().projectId==='${A}'&&document.querySelector('.notes-projects-layout').getAttribute('aria-busy')==='false')`);
    await run("notesLiveController.pause()");
  });
  await check("late old settings cannot replace the active project's read-only path", async () => {
    await selectProject(ctx, A); fixture.holdSettings = true;
    await run("activateNotesTab('settings')");
    const until = Date.now() + 5000;
    while (!fixture.pendingSettings.length) {
      if (Date.now() > until) throw new Error("Settings IPC did not start");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await fixture.switchProject(B); fixture.holdSettings = false;
    await run(`(async()=>{await __pWait(()=>NodaProjectContext.snapshot().projectId==='${B}');await window.notesSettingsController.activate();
      __pAssert(document.getElementById('settings-notes-path').value===${JSON.stringify(initial(language).projects.find(p=>p.id===B).notesDirectory)}&&document.getElementById('settings-notes-path').readOnly,'B path not displayed read-only');})()`);
    fixture.releaseSettings();
    await run(`(async()=>{await __pFrame();await __pFrame();__pAssert(document.getElementById('settings-notes-path').value===${JSON.stringify(initial(language).projects.find(p=>p.id===B).notesDirectory)},'late A settings replaced B path');})()`);
  });
  await check("settings Projects action returns to the active project and focuses its selector", async () => {
    await run(`(async()=>{document.getElementById('settings-notes-path').scrollIntoView({block:'center'});await __pFrame();
      __pAssert(document.getElementById('settings-path-browse').textContent.includes(${JSON.stringify(language === "en" ? "Projects" : "Проекты")}), 'settings retained the legacy picker label');})()`);
    await capture(ctx, `09-project-settings-${language}.png`, "project-settings-path");
    await run(`(async()=>{document.getElementById('settings-path-browse').click();await __pWait(()=>activeNotesTab==='notes');
      __pAssert(document.activeElement.dataset.projectId==='${B}','Projects action did not focus active project');notesLiveController.pause();})()`);
  });
  await check("settings save carries its captured project context and a late response preserves B preferences", async () => {
    await selectProject(ctx, A);
    await run("(async()=>{activateNotesTab('settings');await window.notesSettingsController.activate();})()");
    fixture.holdSaves = true;
    await run("document.getElementById('settings-save').click()");
    const until = Date.now() + 5000;
    while (!fixture.pendingSaves.length) {
      if (Date.now() > until) throw new Error("Context-bound settings save IPC did not start");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const request = fixture.calls.filter(item => item.action === "saveSettings").at(-1);
    assert.equal(request.payload.projectId, A); assert.match(request.payload.contextToken, /^[a-f0-9]{32}$/);
    await fixture.switchProject(B);
    await run(`(async()=>{await __pWait(()=>NodaProjectContext.snapshot().projectId==='${B}');await window.notesSettingsController.activate();
      document.getElementById('settings-skip-note-title').checked=false;})()`);
    fixture.holdSaves = false; fixture.releaseSaves();
    await run(`(async()=>{await __pFrame();await __pFrame();
      __pAssert(document.getElementById('settings-notes-path').value===${JSON.stringify(initial(language).projects.find(p=>p.id===B).notesDirectory)},'late saved A settings rewrote B path');
      __pAssert(!document.getElementById('settings-skip-note-title').checked,'late saved A settings overwrote B preference');
      activateNotesTab('notes');notesLiveController.pause();})()`);
  });
  await check("small-window layout keeps projects, note navigation and detail reachable", async () => {
    await run("selectNote('CRM')"); ctx.win.setSize(860, 600);
    try { await run(`(async()=>{await __pWait(()=>innerWidth===860);await __pFrame();
      const picker=document.getElementById('workspace-project-toggle');picker.click();
      const panel=document.getElementById('notes-projects-panel').getBoundingClientRect();
      __pAssert(panel.width>150&&panel.height>150,'project drawer unreachable');
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
      const notesBox=document.querySelector('.notes-sidebar').getBoundingClientRect(),detail=document.querySelector('.notes-viewer').getBoundingClientRect();
      __pAssert(notesBox.width>150&&detail.width>150&&detail.height>300,'small regions unusable');
      __pAssert(document.documentElement.scrollWidth<=innerWidth+1,'small layout overflows');
      const style=getComputedStyle(noteViewContent);
      __pAssert(noteViewContent.clientHeight>=parseFloat(style.lineHeight)*3,'no readable body');
      document.querySelector('.note-actions-menu').open=true;
      const action=deleteNoteBtn.getBoundingClientRect();
      __pAssert(action.top>=0&&action.bottom<=innerHeight,'trash menu unreachable');
      document.querySelector('.note-actions-menu').open=false;})()`);
      await capture(ctx, `03-projects-small-${language}.png`, "projects-responsive");
    } finally { ctx.win.setSize(1440, 960); }
  });
  await check("successful create opens an empty project and connecting its folder does not duplicate it", async () => {
    fixture.nextCreate = "success";
    await run(`(async()=>{document.getElementById('create-project-btn').click();document.getElementById('project-name-input').value='New knowledge';
      document.getElementById('project-name-form').requestSubmit();await __pWait(()=>NodaProjectContext.snapshot().projectId==='${C}'&&!document.getElementById('project-name-dialog').open);
      await __pWait(()=>document.querySelector('.notes-projects-layout').getAttribute('aria-busy')==='false');
      __pAssert(notes.length===0&&!noteViewContent.textContent.includes('ASTER_ONLY')&&!noteViewContent.textContent.includes('BOREAL_ONLY'),'new empty project reused prior material');
      __pAssert(document.querySelectorAll('.project-button').length===3,'created project not listed');notesLiveController.pause();})()`);
    await capture(ctx, `04-project-empty-${language}.png`, "project-empty");
    await selectProject(ctx, A); fixture.nextConnect = "success";
    await run(`(async()=>{document.getElementById('connect-project-btn').click();await __pWait(()=>NodaProjectContext.snapshot().projectId==='${C}'&&document.querySelector('.notes-projects-layout').getAttribute('aria-busy')==='false');
      __pAssert(document.querySelectorAll('.project-button').length===3,'connect duplicated existing folder');notesLiveController.pause();})()`);
  });
  await check("every data HTTP request carries the current mandatory project headers", () => run(`(()=>{
    __pAssert(__projects.calls.length>5&&__projects.violations.length===0,'missing or mismatched project fence headers');return {requests:__projects.calls.length};})()`));
  await check("an unrecoverable project error masks old data and disables every mutation", async () => {
    await selectProject(ctx, A); await run("selectNote('CRM')");
    await run("__pAssert(noteViewContent.textContent.includes('ASTER_ONLY'),'hard-error fixture did not begin with an open source')");
    fixture.emitHardError();
    await run(`(async()=>{await __pWait(()=>NodaProjectContext.snapshot().status==='error');
      __pAssert(['create-project-btn','connect-project-btn','refresh-notes-btn','new-note-btn'].every(id=>document.getElementById(id).disabled),'hard error left mutation controls enabled');
      __pAssert(Array.from(document.querySelectorAll('.project-button')).every(b=>b.disabled),'hard error allowed a project switch');
      __pAssert(noteViewContent.textContent===''&&notes.length===0,'hard error exposed old source');
      __pAssert(notesStatusText.textContent==='','hard error retained the old note status');
      const before=__projects.calls.length;await NodaProjectContext.fetch('/notes').then(()=>{throw new Error('hard error admitted HTTP')},()=>{});
      __pAssert(before===__projects.calls.length&&!document.getElementById('projects-message').hidden,'hard error missing visible failure or request fence');})()`);
    await capture(ctx, `08-project-hard-error-${language}.png`, "project-unrecoverable-error");
  });
  await check("unconfirmed activation displays the committed project with a restart requirement and no data access", async () => {
    fixture.emitHardError("activation");
    const expected = language === "en" ? "The project was saved, but activation could not be confirmed. Restart Noda; project data is preserved."
      : "Проект сохранён, но его запуск не подтверждён. Перезапустите Noda; данные проектов сохранены.";
    assert.ok(fs.readFileSync(path.join(root, "frontend/desktop_project_controller.js"), "utf8").includes(expected), "Fixture activation message differs from production source");
    await run(`(async()=>{await __pWait(()=>document.getElementById('projects-message').textContent===${JSON.stringify(expected)});
      __pAssert(NodaProjectContext.snapshot().status==='error'&&NodaProjectContext.snapshot().projectState.activeProjectId==='${C}','unconfirmed commit displayed a previous project');
      __pAssert(notes.length===0&&noteViewContent.textContent===''&&document.getElementById('new-note-btn').disabled,'unconfirmed activation admitted data access');})()`);
    await capture(ctx, `11-project-unconfirmed-${language}.png`, "project-activation-unconfirmed");
  });
  const fixtureResult = await run("({calls:__projects.calls,violations:__projects.violations,writes:__projects.writes})");
  fs.writeFileSync(path.join(out, "synthetic-http.json"), JSON.stringify(fixtureResult, null, 2));
  await finishContext(ctx);
  await runQuickCases({ context, fixture, check, finishContext });
  publishResults();
}
run().catch(error => {
  clearTimeout(timeout); for (const win of windows) if (!win.isDestroyed()) win.destroy();
  fs.writeFileSync(path.join(out, "harness-error.txt"), String(error.stack || error)); console.error(error.stack); app.exit(1);
});
