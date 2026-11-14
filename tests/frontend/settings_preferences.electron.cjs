"use strict";
const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { initial, createMainFixture, setupHttp } = require("./projects_fixture.cjs");
const { DEFAULT_PREFERENCES } = require("../../frontend/desktop_preferences");
const root = path.resolve(__dirname, "../.."), out = path.resolve(process.argv[2] || "");
const language = process.argv[3] === "en" ? "en" : "ru";
const frontend = path.resolve(process.argv[4] || path.join(root, "frontend"));
assert.ok(process.argv[2] && !fs.existsSync(out), "Use a fresh explicit result directory");
fs.mkdirSync(out, { recursive: true }); app.setPath("userData", path.join(out, "profile")); app.setPath("sessionData", path.join(out, "profile"));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-background-networking");
let win, network = 0, restartCalls = 0, refuseShortcut = false;
const checks = [], errors = [], calls = [];
const watchdog = setTimeout(() => { fs.writeFileSync(path.join(out, "timeout.json"), JSON.stringify(checks)); app.exit(2); }, 60000);

function supplement() {
  const original = window.fetch;
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, location.href), state = window.__projects, project = state.data[state.context.activeProjectId];
    if (parsed.pathname === "/notes-graph") return new Response(JSON.stringify({ nodes: [], edges: [], vault_id: project.vault }));
    if (options.method === "PATCH") {
      const title = decodeURIComponent(parsed.pathname.slice(13)), content = JSON.parse(options.body).content;
      project.details[title].content = project.details[title].editable_body = content;
      project.details[title].edit_revision = "2".repeat(64);
      state.editorWrites = (state.editorWrites || 0) + 1;
      return new Response(JSON.stringify({ success: true, title, cache_updated: true }));
    }
    return original(url, options);
  };
}
async function run() {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest(({ url }, done) => {
    const local = /^(file|data|about):/.test(url); if (!local) network++; done({ cancel: !local });
  });
  const fixture = createMainFixture(ipcMain, language), seed = initial(language);
  for (const project of Object.values(seed.data)) for (const detail of Object.values(project.details)) {
    detail.content = detail.editable_body = "Synthetic note for settings checks.\n\nNo personal data.";
    detail.edit_revision = "1".repeat(64);
  }
  let saved = { ...DEFAULT_PREFERENCES, language, theme: "classic-blue", notesDirectory: seed.projects[0].notesDirectory,
    skipModelSelection: true, skipNotesDirectorySelection: true, skipTurboQuantSelection: true,
    skipNoteTitleSelection: true, skipNoteTagsSelection: true, skipNoteLinksSelection: true };
  let activeModelId = "model-a", notePipeline = { enabled: false, configured: false };
  const payload = () => ({ ok: true, settings: { ...saved }, activeModelId, hardware: { ramGb: 32 },
    models: ["a", "b"].map(id => ({ id: `model-${id}`, name: `Synthetic Model ${id.toUpperCase()}`, artifact: "gguf", downloaded: true,
      ready: true, active: activeModelId === `model-${id}`, min_memory_gb: 2, recommended_memory_gb: 4, estimated_download_gb: 1 })),
    turboquantCapability: { supported: true }, runtime: { provider: "local", runtime_model_id: activeModelId, turboquant: { enabled: false },
      note_pipeline: notePipeline } });
  for (const channel of ["get-app-settings", "save-app-settings", "apply-settings-model"]) ipcMain.removeHandler(`quick-note:${channel}`);
  ipcMain.handle("quick-note:get-app-settings", () => { calls.push({ method: "get" }); return payload(); });
  ipcMain.handle("quick-note:save-app-settings", (_event, value) => {
    calls.push({ method: "save", value });
    assert.equal(value.projectId, fixture.snapshot().activeProjectId); assert.equal(value.contextToken, fixture.snapshot().context.context_token);
    if (refuseShortcut) throw new Error(language === "en" ? "This shortcut is already in use. Choose another shortcut." : "Эта горячая клавиша уже занята. Выберите другое сочетание.");
    const { projectId, contextToken, turboquantEnabled, ...values } = value; saved = { ...saved, ...values };
    const result = payload(); win.webContents.send("quick-note:preferences-changed", result.settings); return result;
  });
  ipcMain.handle("quick-note:apply-settings-model", (_event, value) => { calls.push({ method: "model", value }); activeModelId = value.model_id; return payload(); });
  ipcMain.handle("quick-note:restart-for-settings", () => { restartCalls++; return { ok: false, canceled: true }; });
  win = new BrowserWindow({ width: 1440, height: 960, show: false, webPreferences: { preload: path.join(frontend, "preload.js"),
    contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false,
    additionalArguments: [`--noda-language=${language}`, `--noda-preferences=${JSON.stringify(DEFAULT_PREFERENCES)}`] } });
  fixture.addWindow(win); await win.loadURL("about:blank");
  const debug = win.webContents.debugger; debug.attach("1.3"); await debug.sendCommand("Page.enable");
  await debug.sendCommand("Profiler.enable");
  await debug.sendCommand("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  await debug.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: `(${setupHttp.toString()})(${JSON.stringify(seed)},${JSON.stringify(fixture.snapshot())});(${supplement.toString()})();` });
  win.webContents.on("console-message", details => { if (details.level === "error") errors.push(String(details.message)); });
  await win.loadFile(path.join(frontend, "notes.html"));
  const evaluate = source => win.webContents.executeJavaScript(`(async()=>{${source}})()`);
  await evaluate(`window.assert=(v,m)=>{if(!v)throw new Error(m)};window.wait=async f=>{const end=performance.now()+8000;while(!f()){if(performance.now()>end)throw new Error('Native wait expired');await new Promise(r=>setTimeout(r,20));}};await wait(()=>notes.length>0&&!document.body.classList.contains('app-loading'));`);
  async function check(name, body) { try { await body(); checks.push({ name, status: "pass" }); } catch (error) { checks.push({ name, status: "fail", error: String(error.stack || error) }); } }
  async function capture(name) {
    await evaluate("await wait(()=>getComputedStyle(document.getElementById('startup-overlay')).opacity==='0');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));");
    fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
  }
  const otherLanguage = language === "ru" ? "en" : "ru";
  await check("settings controls load and navigation stays at the same top position", async () => {
    const boxes = await evaluate(`const boxes=[];for(const tab of ['notes','settings','chat','graph']){activateNotesTab(tab);await new Promise(r=>requestAnimationFrame(r));const x=document.querySelector('.notes-tabs').getBoundingClientRect();boxes.push({tab,top:x.top,height:x.height});
      const footer=document.getElementById('app-support-footer').getBoundingClientRect();assert(footer.height===32&&footer.bottom<=innerHeight,'footer missing or clipped');assert(document.querySelector('.notes-dashboard-shell').getBoundingClientRect().bottom<=footer.top+1,'footer covers workspace');
      assert(document.getElementById('support-email').textContent==='tim@buglai.com'&&!document.getElementById('support-copy').textContent.trim(),'support email is not compact');}
      activateNotesTab('settings');await wait(()=>document.getElementById('settings-quick-hotkey').value);return boxes;`);
    assert.ok(boxes.every(box => box.top === boxes[0].top), JSON.stringify(boxes));
    await capture("01-settings.png");
  });
  await check("search recovery is hidden when ready and service badges do not clutter settings", async () => {
    await evaluate(`document.getElementById('notes-settings-tab').click();
      const section=document.getElementById('settings-semantic-section');
      window.notesSemanticControls.update({embedding_status:'ready',available:true});
      assert(section.hidden&&!section.getClientRects().length,'configured search still shows setup');
      assert(!document.querySelector('.settings-summary-bar'),'runtime summary remains visible');
      assert(!document.getElementById('chat-qdrant-state'),'technical chat badge remains');
      window.notesSemanticControls.update({embedding_status:'unavailable'});
      assert(!section.hidden&&section.getClientRects().length===1,'recovery card cannot be opened');
      document.getElementById('settings-semantic-setup').focus();
      window.notesSemanticControls.update({embedding_status:'ready',available:false});
      assert(section.hidden,'a service failure incorrectly requests model installation');
      assert(document.activeElement.id==='notes-settings-tab','focus remains in the hidden recovery card');
      document.querySelector('.settings-theme-section').scrollIntoView({block:'start'});`);
    await capture("11-clean-settings-search-ready.png");
  });
  await check("editor setting fields align in rows and keep consistent sizes at wide and narrow widths", async () => {
    for (const width of [1440, 860, 640]) {
      win.setSize(width, 900);
      const boxes = await evaluate(`await wait(()=>innerWidth===${width});document.getElementById('settings-editor-heading').scrollIntoView({block:'start'});
        await new Promise(r=>requestAnimationFrame(r));
        return [...document.querySelectorAll('.settings-preferences-grid > label')].map(label=>{
          const field=label.querySelector('input,select').getBoundingClientRect(), caption=label.querySelector('span').getBoundingClientRect();
          assert(field.top>=caption.bottom+6,'field overlaps its label');
          const hint=label.querySelector('small')?.getBoundingClientRect();if(hint)assert(hint.top>=field.bottom+6,'hint overlaps its field');
          assert(field.left>=0&&field.right<=innerWidth,'setting field clipped');
          return {top:field.top,left:field.left,height:field.height};
        });`);
      assert.equal(boxes.length, 4);
      assert.ok(boxes.every(box => box.height >= 44 && Math.abs(box.height - boxes[0].height) < 1), JSON.stringify({ width, boxes }));
      for (const [left, right] of [[boxes[0], boxes[1]], [boxes[2], boxes[3]]]) {
        if (right.left > left.left + 1) assert.ok(Math.abs(left.top - right.top) < 1, JSON.stringify({ width, left, right }));
      }
      await capture(`10-editor-fields-${width}.png`);
    }
    win.setSize(1440, 960); await evaluate("await wait(()=>innerWidth===1440)");
  });
  await check("model selection keeps unsaved language and editor preferences", async () => {
    await evaluate(`document.getElementById('settings-language').value=${JSON.stringify(otherLanguage)};document.getElementById('settings-skip-path').checked=false;
      document.getElementById('settings-editor-font-size').value='20';document.getElementById('settings-interface-density').value='compact';
      document.getElementById('settings-editor-autosave').checked=false;document.getElementById('settings-editor-autosave-delay').value='2500';
      assert(document.getElementById('settings-language-restart').hidden,'unsaved language offers restart');document.getElementById('settings-model-open').click();
      await wait(()=>document.querySelectorAll('.settings-picker-row').length===2);[...document.querySelectorAll('.settings-picker-row')].find(x=>x.textContent.includes('Model B')).click();
      document.querySelector('.settings-picker-choose').click();await wait(()=>document.getElementById('settings-model-switch').hidden&&document.getElementById('settings-model-name').textContent.includes('Model B'));
      assert(document.getElementById('settings-language').value===${JSON.stringify(otherLanguage)},'language lost');assert(!document.getElementById('settings-skip-path').checked,'skip lost');
      assert(document.getElementById('settings-editor-font-size').value==='20'&&!document.getElementById('settings-editor-autosave').checked,'editor preferences lost');`);
  });
  await check("saving applies editor size, density, manual save and exposes restart", async () => {
    await evaluate(`document.getElementById('settings-save').click();await wait(()=>!document.getElementById('settings-language-restart').hidden&&!document.getElementById('settings-save').disabled);
      assert(document.documentElement.lang===${JSON.stringify(language)},'language changed before restart');assert(NodaPreferences.get().editorFontSize===20&&NodaPreferences.get().interfaceDensity==='compact','saved preferences not applied');
      assert(!NodaPreferences.get().editorAutoSave,'autosave flag lost');activateNotesTab('notes');await selectNote('CRM');
      assert(getComputedStyle(inlineEditor.inputElement).fontSize==='20px','font size not applied');assert(!document.getElementById('note-save-manual').hidden,'manual save inaccessible');
      inlineEditor.inputElement.value+='\\nManual change';inlineEditor.inputElement.dispatchEvent(new Event('input'));assert(inlineEditor.getState().dirty,'manual change absent');
      document.getElementById('note-save-manual').click();await wait(()=>!inlineEditor.getState().dirty);assert(__projects.editorWrites===1,'manual save did not reach API');`);
    await capture("02-workspace-preferences.png");
  });
  await check("cancel restores visual preferences and restarting can be canceled safely", async () => {
    await evaluate(`activateNotesTab('settings');await wait(()=>!document.getElementById('settings-save').disabled);document.getElementById('settings-editor-heading').scrollIntoView({block:'start'});`);
    await capture("03-editor-settings.png");
    await evaluate(`const size=document.getElementById('settings-editor-font-size');
      size.value='23';size.dispatchEvent(new Event('input',{bubbles:true}));assert(NodaPreferences.get().editorFontSize===23,'preview absent');
      assert(document.getElementById('settings-language-restart').disabled,'restart allowed with dirty settings');document.getElementById('settings-cancel').click();
      assert(NodaPreferences.get().editorFontSize===20&&size.value==='20','cancel did not restore preview');assert(!document.getElementById('settings-language-restart').disabled,'restart not enabled');
      document.getElementById('settings-language-restart').click();await wait(()=>!document.getElementById('settings-save').disabled);assert(!document.getElementById('settings-status').classList.contains('error'),'canceled restart shows error');`);
    assert.equal(restartCalls, 1);
  });
  await check("a refused shortcut leaves saved preferences intact and gives an actionable error", async () => {
    refuseShortcut = true;
    await evaluate(`document.getElementById('settings-quick-hotkey').value='Control+Alt+X';document.getElementById('settings-save').click();
      await wait(()=>document.getElementById('settings-status').classList.contains('error'));assert(NodaPreferences.get().quickNoteHotkey==='Control+Shift+Space','failed shortcut was applied');
      const value=document.getElementById('settings-status').textContent;assert(value.includes(${JSON.stringify(language === "en" ? "already in use" : "уже занята")}), 'shortcut error lost');`);
    refuseShortcut = false;
  });
  await check("a compact window keeps editor preferences and language controls reachable", async () => {
    win.setSize(860, 680);
    await evaluate(`await wait(()=>innerWidth===860);document.getElementById('settings-cancel').click();document.getElementById('settings-editor-heading').scrollIntoView({block:'start'});
      await new Promise(r=>requestAnimationFrame(r));assert(document.documentElement.scrollWidth<=innerWidth+1,'horizontal overflow');
      const field=document.getElementById('settings-quick-hotkey').getBoundingClientRect();assert(field.width>180&&field.left>=0&&field.right<=innerWidth,'shortcut control clipped');
      document.getElementById('settings-language-restart').scrollIntoView({block:'nearest'});const restart=document.getElementById('settings-language-restart').getBoundingClientRect();
      assert(restart.top>=0&&restart.bottom<=innerHeight,'restart control unreachable');`);
    await capture("04-settings-compact.png");
  });
  await check("manual mode never writes canceled properties or trash actions", async () => {
    await evaluate(`activateNotesTab('notes');await selectNote('CRM');
      const editor=inlineEditor.inputElement, original=editor.value, writes=__projects.editorWrites||0;
      editor.value=original+' Manual unsaved text';editor.dispatchEvent(new Event('input'));
      assert(inlineEditor.isDirty()&&!NodaPreferences.get().editorAutoSave,'manual draft absent');
      document.querySelector('.note-metadata-edit').click();await wait(()=>!document.querySelector('.note-metadata-edit').disabled);
      assert(!document.querySelector('.note-metadata-dialog').open,'properties opened over an unsaved manual draft');
      assert((__projects.editorWrites||0)===writes&&inlineEditor.isDirty(),'opening properties silently saved the body');
      const oldConfirm=window.confirm;let prompts=0;window.confirm=()=>{prompts++;return false};
      try {document.getElementById('delete-note-btn').click();await wait(()=>prompts===1&&!noteWritePending);}
      finally {window.confirm=oldConfirm;}
      assert((__projects.editorWrites||0)===writes&&inlineEditor.isDirty(),'canceling trash silently saved the body');
      assert(__projects.data[__projects.context.activeProjectId].details.CRM.editable_body===original,'canceled action changed disk body');
      let accepted=0;window.confirm=()=>{accepted++;return true};
      try {document.getElementById('delete-note-btn').click();await wait(()=>accepted===1&&!noteWritePending);}
      finally {window.confirm=oldConfirm;}
      assert((__projects.editorWrites||0)===writes&&inlineEditor.isDirty(),'confirmed trash silently saved a manual draft');
      assert(__projects.data[__projects.context.activeProjectId].details.CRM,'unsaved manual note was deleted');`);
    await capture("05-manual-save-safety.png");
    await evaluate(`const writes=__projects.editorWrites||0;
      document.getElementById('note-save-manual').click();await wait(()=>!inlineEditor.isDirty());
      assert(__projects.editorWrites===writes+1,'explicit save absent');
      assert(document.getElementById('notes-status-card').hidden,'save-first warning was not cleared after explicit save');
      document.querySelector('.note-metadata-edit').click();await wait(()=>document.querySelector('.note-metadata-dialog').open);
      document.querySelector('.note-metadata-actions button').click();await wait(()=>!document.querySelector('.note-metadata-dialog').open);
      assert(__projects.editorWrites===writes+1,'canceling clean properties wrote again');`);
  });
  await check("reverting a manual draft clears only its save-first warning without writing", async () => {
    await evaluate(`const editor=inlineEditor.inputElement, original=editor.value, writes=__projects.editorWrites||0;
      editor.value=original+' Temporary draft';editor.dispatchEvent(new Event('input'));
      document.querySelector('.note-metadata-edit').click();await wait(()=>!document.querySelector('.note-metadata-edit').disabled);
      assert(!document.getElementById('notes-status-card').hidden,'save-first warning missing');
      editor.value=original;editor.dispatchEvent(new Event('input'));
      assert(!inlineEditor.isDirty()&&document.getElementById('notes-status-card').hidden,'reverting the draft left an obsolete save-first warning');
      document.querySelector('.note-metadata-edit').click();await wait(()=>document.querySelector('.note-metadata-dialog').open);
      assert(document.getElementById('notes-status-card').hidden,'clean properties retained the draft warning');
      document.querySelector('.note-metadata-actions button').click();
      for(const type of ['warn','error']) {
        setStatus(type,'Synthetic service problem');editor.value=original+' Temporary draft';editor.dispatchEvent(new Event('input'));
        editor.value=original;editor.dispatchEvent(new Event('input'));
        assert(!document.getElementById('notes-status-card').hidden&&document.getElementById('notes-status-text').textContent==='Synthetic service problem','reverting a draft hid an unrelated problem');
      }
      assert((__projects.editorWrites||0)===writes,'reverting or canceling properties wrote to disk');setStatus('ok','');`);
  });
  await check("unsaved processing choices block restart and reset restores it", async () => {
    const stages = ["title", "tags", "links"];
    notePipeline = { enabled: true, configured: true, selection: Object.fromEntries(stages.map(id => [id, id + "_one"])),
      stageEnabled: { title: true, tags: true, links: true },
      catalog: stages.map(id => ({ id, recommendedId: id + "_one", options: [
        { id: id + "_one", label: "Synthetic one", available: true }, { id: id + "_two", label: "Synthetic two", available: true }] })) };
    const before = restartCalls;
    await evaluate(`activateNotesTab('settings');notesSettingsController.reset();await wait(()=>document.querySelector('#settings-note-pairs-picker select')&&!document.getElementById('settings-save').disabled);
      const selector=document.querySelector('#settings-note-pairs-picker select'), restart=document.getElementById('settings-language-restart');
      assert(!restart.hidden&&!restart.disabled,'clean settings cannot restart');
      selector.value='title_two';selector.dispatchEvent(new Event('change',{bubbles:true}));
      assert(notesSettingsNotePairs.hasDraft()&&restart.disabled,'restart allowed with processing draft');
      assert(!document.getElementById('settings-language-restart-note').hidden,'save-before-restart hint absent');
      restart.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      selector.value='title_one';selector.dispatchEvent(new Event('change',{bubbles:true}));
      assert(!notesSettingsNotePairs.hasDraft()&&!restart.disabled,'reverting processing choice did not unlock restart');
      const toggle=document.querySelector('#settings-note-pairs-picker .note-pair-switch');toggle.click();
      assert(notesSettingsNotePairs.hasDraft()&&restart.disabled,'stage toggle bypassed restart guard');
      document.getElementById('settings-language-heading').scrollIntoView({block:'start'});`);
    assert.equal(restartCalls, before, "dirty processing choices reached restart IPC");
    await capture("06-restart-protected.png");
    await evaluate(`document.getElementById('settings-cancel').click();await wait(()=>!document.getElementById('settings-save').disabled);
      assert(!notesSettingsNotePairs.hasDraft()&&!document.getElementById('settings-language-restart').disabled,'reset did not clear processing guard');`);
  });
  await check("Escape restores project-picker focus without stealing focus when closed", async () => {
    await evaluate(`document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());await wait(()=>!noteWritePending);
      activateNotesTab('notes');const trigger=document.getElementById('workspace-project-toggle');trigger.click();
      assert(document.activeElement.classList.contains('project-button'),'drawer did not focus current project');
      const addMenu=document.getElementById('projects-add-menu');addMenu.open=true;addMenu.querySelector('summary').focus();
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      assert(!addMenu.open&&document.body.classList.contains('projects-drawer-open')&&document.activeElement===addMenu.querySelector('summary'),'Escape hid a focused nested menu');
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      assert(!document.body.classList.contains('projects-drawer-open')&&document.activeElement===trigger,'Escape lost focus');
      inlineEditor.focus();const editorFocus=document.activeElement;
      assert(editorFocus===inlineEditor.inputElement||editorFocus.id==='note-view-content','editor did not receive focus');
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      assert(document.activeElement===editorFocus,'closed drawer stole focus');
      const arrow=trigger.querySelector('[data-ui-icon="chevron"]');assert(arrow&&arrow.getAttribute('aria-hidden')==='true','project arrow is not a shared decorative icon');
      assert(getComputedStyle(arrow).width==='16px'&&getComputedStyle(arrow).maskImage!=='none','project arrow is not rendered');
      const select=document.getElementById('note-text-style');assert(getComputedStyle(select).backgroundImage!=='none','editor selector lost its shared arrow');`);
    await capture("07-project-chevron.png");
  });
  await check("wide project arrow selects actual projects and filters need no refresh button", async () => {
    win.setSize(1440, 900);
    await evaluate(`await wait(()=>innerWidth===1440);const trigger=document.getElementById('workspace-project-toggle'), original=NodaProjectContext.snapshot().projectId;
      trigger.click();const menu=document.getElementById('workspace-project-picker');assert(!menu.hidden&&menu.querySelectorAll('button').length===2,'wide arrow did not open project menu');
      assert(menu.contains(document.activeElement),'wide picker did not receive keyboard focus');
      menu.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));assert(document.activeElement===menu.lastElementChild,'End did not navigate project menu');
      menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));assert(document.activeElement===menu.firstElementChild,'Home did not navigate project menu');
      menu.querySelector('[aria-checked="false"]').click();await wait(()=>NodaProjectContext.snapshot().projectId!==original&&NodaProjectContext.snapshot().status==='ready');
      trigger.click();menu.querySelector('[aria-checked="false"]').click();await wait(()=>NodaProjectContext.snapshot().projectId===original&&notes.length===2);
      trigger.click();menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert(menu.hidden&&document.activeElement===trigger,'wide picker Escape lost focus');
      const filter=document.querySelector('.notes-filter-menu');filter.open=true;
      assert(!document.getElementById('refresh-notes-btn').getClientRects().length,'refresh is still visible');
      document.querySelector('[data-notes-sort="title"]').click();assert(document.querySelector('#notes-list .note-list-title').textContent.includes('Aster'),'sort did not reorder notes');
      assert(document.querySelectorAll('[data-notes-sort][aria-pressed="true"]').length===1,'sort selection ambiguous');
      const label=document.getElementById('projects-heading').getBoundingClientRect(), add=document.querySelector('#projects-add-menu summary').getBoundingClientRect();
      assert(Math.abs(label.top+label.height/2-add.top-add.height/2)<2,'project add button is misaligned');`);
    await capture("08-clean-filters.png");
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.getElementById('workspace-project-toggle').click();`);
    await capture("09-wide-project-picker.png");
    await evaluate(`document.getElementById('workspace-project-picker').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);
  });
  await check("support is copied by the shared icon without changing settings", async () => {
    const before = calls.filter(call => call.method === "save").length;
    await evaluate(`const descriptor=Object.getOwnPropertyDescriptor(navigator,'clipboard');let copied=null;
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{copied=value}}});
      try {document.getElementById('support-copy').click();await wait(()=>copied!==null);assert(copied==='tim@buglai.com','support icon copied another value');assert(document.getElementById('support-copy').dataset.copied==='true','copy success missing');}
      finally {if(descriptor)Object.defineProperty(navigator,'clipboard',descriptor);else delete navigator.clipboard;}`);
    assert.equal(calls.filter(call => call.method === "save").length, before);
  });
  fs.writeFileSync(path.join(out, "coverage.json"), JSON.stringify(await debug.sendCommand("Profiler.takePreciseCoverage")));
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ language, frontend, checks, errors, network, calls, restartCalls, electron: process.versions.electron }, null, 2));
  clearTimeout(watchdog); win.destroy(); app.exit(checks.some(item => item.status !== "pass") || errors.length || network ? 1 : 0);
}
run().catch(error => { clearTimeout(watchdog); fs.writeFileSync(path.join(out, "harness-error.txt"), String(error.stack || error)); app.exit(1); });
