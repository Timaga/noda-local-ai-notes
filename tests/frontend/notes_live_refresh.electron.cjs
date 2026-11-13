"use strict";

const { app, BrowserWindow, ipcMain, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { initial, setup, wrapper } = require("./notes_live_fixture.cjs");

const root = path.resolve(__dirname, "../..");
const out = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2] && !fs.existsSync(out), "Use a new, explicit output folder");
fs.mkdirSync(out, { recursive: true });
app.setPath("userData", path.join(out, "profile"));
app.setPath("sessionData", path.join(out, "profile"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.on("window-all-closed", () => {});
const checks = [], coverage = [], captures = [], windows = [];
let network = 0, interfaceLanguage = "ru";
const sourceFiles = ["notes.html", "notes_renderer.js", "notes_markdown.js", "notes_live_sync.js",
  "notes_live_application.js", "notes_list_view.js", "preload.js"];
const hashes = () => Object.fromEntries(sourceFiles.map(name => [name,
  crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "frontend", name))).digest("hex")]));
const before = hashes();
const watchdog = setTimeout(() => { fs.writeFileSync(path.join(out, "timeout.json"), JSON.stringify(checks)); app.exit(2); }, 60000);

async function context(language) {
  interfaceLanguage = language;
  const win = new BrowserWindow({ width: 1440, height: 960, show: false,
    webPreferences: { preload: path.join(root, "frontend/preload.js"), sandbox: true,
      contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false,
      additionalArguments: [`--noda-language=${language}`] } });
  windows.push(win);
  await win.loadURL("about:blank");
  const debuggerApi = win.webContents.debugger;
  debuggerApi.attach("1.3");
  await debuggerApi.sendCommand("Page.enable");
  await debuggerApi.sendCommand("Profiler.enable");
  await debuggerApi.sendCommand("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  await debuggerApi.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source: `(${setup.toString()})(${JSON.stringify(initial(language))});`,
  });
  await win.loadFile(path.join(root, "frontend/notes.html"));
  const evaluate = source => win.webContents.executeJavaScript(source);
  await evaluate(`window.__liveAssert=(value,message)=>{if(!value)throw new Error(message);};
    window.__liveWait=async predicate=>{const deadline=performance.now()+6500;while(!predicate()){
      if(performance.now()>deadline)throw new Error('Timed out waiting for native state');
      await new Promise(resolve=>setTimeout(resolve,20));}};
    window.__liveFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));void 0;`);
  await evaluate(`__liveWait(()=>notesList.querySelectorAll('.note-list-button').length===101 &&
    typeof notesLiveController==='object' && !creatingNote)`);
  assert.equal(await evaluate("document.hidden"), false, "The offscreen fixture must expose visible page state for auto polling");
  return { win, evaluate };
}

async function check(name, body) {
  try { const detail = await body(); checks.push({ name, status: "pass", detail }); }
  catch (error) { checks.push({ name, status: "fail", error: String(error.stack || error).slice(0, 1800) }); }
  fs.appendFileSync(path.join(out, "checks.jsonl"), JSON.stringify(checks.at(-1)) + "\n");
}

async function capture(win, language, name, state = "library", selector = "") {
  await win.webContents.executeJavaScript(`(async()=>{
    await __liveWait(()=>{const x=document.getElementById('startup-overlay');
      return !x || x.hidden || getComputedStyle(x).opacity==='0' || getComputedStyle(x).display==='none';});
    await __liveFrame();await __liveFrame();})()`);
  const bounds = selector ? await win.webContents.executeJavaScript(`(()=>{
    const box=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return {x:Math.floor(box.x),y:Math.floor(box.y),width:Math.floor(Math.min(box.width,innerWidth-box.x)),
      height:Math.floor(Math.min(box.height,innerHeight-box.y))};})()`) : undefined;
  const image = await win.webContents.capturePage(bounds);
  const file = path.join(out, name);
  fs.writeFileSync(file, image.toPNG());
  captures.push({ path: file, language, state, width: image.getSize().width, height: image.getSize().height,
    sha256: crypto.createHash("sha256").update(image.toPNG()).digest("hex") });
}

async function run() {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest(({ url }, done) => {
    const local = /^(file|data|about):/.test(url); if (!local) network += 1; done({ cancel: !local });
  });
  const ready = { state: "ready", phase: "ready", progress: 100, language: "ru" };
  for (const [name, handler] of Object.entries({
    "get-projects": () => ({ ok: true, mode: "legacy", projects: [], activeProjectId: null,
      activeProject: null, context: null, status: "ready" }),
    "get-startup-status": () => ({ ...ready, language: interfaceLanguage }), "ensure-backend": () => ({ ok: true }),
    "startup-renderer-ready": () => ({ ok: true }), "complete-startup": () => ({ ok: true }),
    "get-hotkey": () => "Control+Shift+Space",
  })) ipcMain.handle(`quick-note:${name}`, handler);

  const ru = await context("ru"), evaluate = ru.evaluate;
  await check("a completed background note appears automatically without refresh or changing selection", async () => {
    const result = await evaluate(`(async()=>{const selected=selectedNoteTitle;const calls=__live.listRequests;
      const title=__liveAdd('автоматически');
      await __liveWait(()=>!!notesList.querySelector('[data-note-title="'+title+'"]'));
      __liveAssert(selectedNoteTitle===selected,'background note stole selection');
      __liveAssert(__live.listRequests>calls,'no automatic request observed');
      notesLiveController.pause();return {title,selected};})()`);
    return result;
  });
  await check("an unchanged poll keeps DOM rows, focus, viewport and the selected detail intact", () => evaluate(`(async()=>{
    await selectNote('Архив 046');const row=notesList.querySelector('[data-note-title="Архив 046"]');
    row.scrollIntoView({block:'center'});row.focus({preventScroll:true});const top=row.getBoundingClientRect().top;
    const body=noteViewContent.firstChild;await notesLiveController.refresh();await __liveFrame();
    __liveAssert(row.isConnected&&document.activeElement===row,'unchanged poll replaced focused row');
    __liveAssert(noteViewContent.firstChild===body,'unchanged poll rebuilt detail');
    __liveAssert(Math.abs(row.getBoundingClientRect().top-top)<=1,'unchanged poll moved viewport');})()`));
  await check("new rows preserve search, filter, sort and the visible row anchor", () => evaluate(`(async()=>{
    notesSearch.value='Архив';notesSearch.dispatchEvent(new Event('input'));
    setActiveNotesFilter('tagged');notesSortSelect.value='oldest';notesSortSelect.dispatchEvent(new Event('change'));
    await __liveWait(()=>notesList.querySelectorAll('.note-list-button').length>25);
    const row=notesList.querySelectorAll('.note-list-button')[25];row.scrollIntoView({block:'start'});
    row.focus({preventScroll:true});const key=row.dataset.noteTitle,top=row.getBoundingClientRect().top;
    const title=__liveAdd('во-время-фильтра');await notesLiveController.refresh();await __liveFrame();
    __liveAssert(notesSearch.value==='Архив'&&activeNotesFilter==='tagged'&&notesSortSelect.value==='oldest','view controls reset');
    __liveAssert(row.isConnected&&document.activeElement===row,'row/focus replaced');
    __liveAssert(Math.abs(row.getBoundingClientRect().top-top)<=1,'visible row anchor moved');
    __liveAssert(!notesList.querySelector('[data-note-title="'+title+'"]'),'filter was ignored');
    notesSearch.value='';notesSearch.dispatchEvent(new Event('input'));
    setActiveNotesFilter('all');notesSortSelect.value='newest';notesSortSelect.dispatchEvent(new Event('change'));})()`));
  await check("completion updates the already opened canonical note with body, title, tags and links", () => evaluate(`(async()=>{
    await selectNote(__live.canonical);const key=selectedNoteTitle;__liveComplete();
    await notesLiveController.refresh();
    __liveAssert(selectedNoteTitle===key,'completion changed canonical selection');
    __liveAssert(noteViewTitle.textContent==='План ремонта велосипеда','generated title missing');
    __liveAssert(noteViewTags.textContent.includes('#велосипед')&&noteViewTags.textContent.includes('#ремонт'),'tags missing');
    __liveAssert(noteViewContent.querySelectorAll('a[data-note-title]').length===2,'related links missing');
    __liveAssert(noteViewContent.textContent.includes(__live.source),'original body missing');
    __liveAssert(!/noda_source_|^title:|^tags:|^related:/m.test(noteViewContent.textContent),'service header leaked');})()`));
  await capture(ru.win, "ru", "01-live-note-ru.png");
  await capture(ru.win, "ru", "02-note-view-ru.png", "note-view", "#note-view-panel");
  await check("valid wrapper tags clear stale DTO tags and keep nonempty metadata visible", () => evaluate(`(async()=>{
    const detail=__live.details[__live.canonical];detail.tags=[];
    detail.content_revision=(++__live.serial).toString(16).padStart(64,'0');
    __live.notes.find(n=>n.title===__live.canonical).content_revision=detail.content_revision;__live.revision++;
    await notesLiveController.refresh();__liveAssert(noteViewTags.textContent.includes('#велосипед'),'wrapper tags lost behind stale DTO');})()`));
  const emptyMetadata = wrapper("Личная запись без подходящих тегов и связей. 😀", { title: "Личная запись", tags: [], related: [] });
  await check("empty generated metadata never shows stale DTO tags or invented related links", () => evaluate(`(async()=>{
    const detail=__live.details[__live.canonical],row=__live.notes.find(n=>n.title===__live.canonical);
    detail.content=${JSON.stringify(emptyMetadata)};detail.tags=['устаревший'];row.tags=['устаревший'];
    row.content_revision=detail.content_revision=(++__live.serial).toString(16).padStart(64,'0');__live.revision++;
    await notesLiveController.refresh();
    __liveAssert(noteViewTags.textContent.trim()===''&&!noteViewContent.querySelector('a[data-note-title]'),'empty metadata fabricated tags or links');
    __liveAssert(noteViewContent.textContent.includes('😀')&&!noteViewContent.textContent.includes('noda_source_'),'Unicode source or header handling failed');})()`));
  const longSource = Array.from({ length: 90 }, (_, index) => `Абзац ${index + 1}. Синтетический подробный план обслуживания велосипеда и проверки запасных деталей.`).join("\n\n");
  const longBefore = wrapper(longSource), longAfter = wrapper(longSource + "\n\nНовый пункт в конце длинной заметки.");
  await check("an automatic body update preserves the real right pane scroll position and focused control", () => evaluate(`(async()=>{
    const key=__live.canonical,detail=__live.details[key],row=__live.notes.find(n=>n.title===key);
    detail.content=${JSON.stringify(longBefore)};row.content_revision=detail.content_revision=(++__live.serial).toString(16).padStart(64,'0');__live.revision++;
    await notesLiveController.refresh();await __liveFrame();
    __liveAssert(noteViewContent.scrollHeight>noteViewContent.clientHeight+1000,'fixture did not exercise a scrollable body');
    const focusControl=document.querySelector(".note-actions-menu summary");noteViewContent.scrollTop=460;focusControl.focus({preventScroll:true});const top=noteViewContent.scrollTop;
    __liveAssert(top>0,'fixture did not scroll the right pane');
    detail.content=${JSON.stringify(longAfter)};row.content_revision=detail.content_revision=(++__live.serial).toString(16).padStart(64,'0');__live.revision++;
    window.dispatchEvent(new Event('focus'));
    await __liveWait(()=>noteViewContent.textContent.includes('Новый пункт в конце длинной заметки.'));
    __liveAssert(Math.abs(noteViewContent.scrollTop-top)<=1,'body update reset the right pane viewport');
    __liveAssert(document.activeElement===focusControl&&selectedNoteTitle===key,'body update changed focus or selection');notesLiveController.pause();})()`));
  await check("a draft is not closed, reset or blurred by a completed background note", () => evaluate(`(async()=>{
    beginNewNote();noteTitleInput.value='Несохранённый черновик';noteTagsInput.value='план';
    noteContentInput.value='  Точный черновик\\nвторая строка  ';noteContentInput.focus();noteContentInput.setSelectionRange(3,8);
    __liveAdd('при-черновике');await notesLiveController.refresh();
    __liveAssert(creatingNote&&!noteCreatePanel.hidden,'background update closed draft');
    __liveAssert(noteTitleInput.value==='Несохранённый черновик'&&noteContentInput.value==='  Точный черновик\\nвторая строка  ','draft changed');
    __liveAssert(document.activeElement===noteContentInput&&noteContentInput.selectionStart===3&&noteContentInput.selectionEnd===8,'draft focus/selection changed');})()`));
  await check("concurrent refreshes coalesce and an offline poll leaves the current view intact", () => evaluate(`(async()=>{
    await selectNote(__live.canonical);__live.holdLists=true;const before=__live.listRequests;
    const first=notesLiveController.refresh(),second=notesLiveController.refresh();
    await __liveWait(()=>__live.pendingLists.length>0);__liveAssert(__live.listRequests===before+1,'refresh requests overlapped');
    __live.holdLists=false;__live.pendingLists.splice(0).forEach(item=>item.release());await Promise.allSettled([first,second]);
    const current=noteViewContent.textContent,row=notesList.firstChild;__live.failLists=true;
    await Promise.allSettled([notesLiveController.refresh()]);__live.failLists=false;
    __liveAssert(selectedNoteTitle===__live.canonical&&noteViewContent.textContent===current&&notesList.firstChild===row,'offline poll destroyed view');})()`));
  await check("late detail cannot replace a newer selection", () => evaluate(`(async()=>{
    const key=__live.canonical;__live.holdDetails=key;
    const summary=__live.notes.find(n=>n.title===key);summary.content_revision=(++__live.serial).toString(16).padStart(64,'0');
    __live.details[key].content_revision=summary.content_revision;__live.revision++;
    const pending=notesLiveController.refresh();await __liveWait(()=>__live.pendingDetails.length>0);
    __live.holdDetails='';await selectNote('Архив 020');
    __live.pendingDetails.splice(0).forEach(item=>item.release());await pending;
    __liveAssert(selectedNoteTitle==='Архив 020'&&noteViewTitle.textContent==='Архив 020','late metadata replaced selection');})()`));
  await check("a held selection response cannot replace a newly opened draft", () => evaluate(`(async()=>{
    const key=__live.canonical;__live.holdDetails=key;const pending=selectNote(key);
    await __liveWait(()=>__live.pendingDetails.length>0);beginNewNote();noteContentInput.value='Черновик после запроса';
    noteContentInput.focus();__live.holdDetails='';__live.pendingDetails.splice(0).forEach(item=>item.release());await pending;
    __liveAssert(creatingNote&&noteContentInput.value==='Черновик после запроса'&&document.activeElement===noteContentInput,'late selection replaced draft');})()`));
  await check("a transient detail failure recovers automatically after a changed list revision", () => evaluate(`(async()=>{
    await selectNote(__live.canonical);const key=__live.canonical;
    const detail=__live.details[key],row=__live.notes.find(note=>note.title===key);
    detail.content='Recovered detail after temporary failure';detail.content_revision=(++__live.serial).toString(16).padStart(64,'0');
    row.content_revision=detail.content_revision;__live.revision++;__live.failDetailOnce=key;
    notesLiveController.wake().catch(()=>{});
    await __liveWait(()=>noteViewContent.textContent.includes('Recovered detail after temporary failure'));
    notesLiveController.pause();__liveAssert(selectedNoteTitle===key,'recovery changed selected identity');})()`));

  await check("visibility pause suppresses polling and the real resume handler updates the view", () => evaluate(`(async()=>{
    window.__liveHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__liveHidden});
    document.dispatchEvent(new Event('visibilitychange'));const before=__live.listRequests;
    const title=__liveAdd('после-паузы');window.dispatchEvent(new Event('focus'));
    __liveAssert(notesLiveController.getState().paused&&__live.listRequests===before,'hidden focus started polling');
    window.__liveHidden=false;document.dispatchEvent(new Event('visibilitychange'));
    await __liveWait(()=>!!notesList.querySelector('[data-note-title="'+title+'"]'));
    __liveAssert(__live.listRequests>before,'resume did not fetch');notesLiveController.pause();delete document.hidden;})()`));

  const legacy = wrapper("~~~yaml\n---\ntitle: literal\n---\n~~~", { title: "Legacy", tags: [], related: [], version: "faithful-v1" });
  await check("ordinary YAML, code examples and unsafe markup are rendered safely", () => evaluate(`(()=>{
    renderMarkdownPreview('---\\ntitle: Author text\\n---\\nBody');
    __liveAssert(noteViewContent.textContent.includes('Author text'),'ordinary author header hidden');
    renderMarkdownPreview(${JSON.stringify(legacy)});
    __liveAssert(noteViewContent.querySelector('pre code')?.textContent.includes('title: literal'),'code example rewritten');
    renderMarkdownPreview('<script>window.__liveAttack=1</script><img src=x onerror="window.__liveAttack=1"><a href="javascript:alert(1)">x</a>');
    __liveAssert(window.__liveAttack===0&&!noteViewContent.querySelector('script,[onerror],a[href^="javascript:"]'),'unsafe DOM survived');})()`));
  const unsafeRelated = wrapper("Безопасное тело", { tags: [], related: ['<img src=x onerror="window.__liveAttack=1">'] });
  await check("related metadata is escaped as inert link text", () => evaluate(`(()=>{
    renderMarkdownPreview(${JSON.stringify(unsafeRelated)});
    __liveAssert(noteViewContent.querySelector('a[data-note-title]')?.textContent===${JSON.stringify('<img src=x onerror="window.__liveAttack=1">')},'related label changed');
    __liveAssert(!noteViewContent.querySelector('img,[onerror]')&&window.__liveAttack===0,'related metadata injected DOM');})()`));
  await check("a vault switch rejects the old request context and a late old detail cannot reappear", () => evaluate(`(async()=>{
    await selectNote('Архив 020');__live.holdDetails='Архив 020';
    const pending=selectNote('Архив 020');await __liveWait(()=>__live.pendingDetails.length>0);
    __live.vault='b'.repeat(32);__live.revision++;
    __live.notes=[{title:'Другой архив',tags:[],indexed:true,snippet:'New synthetic vault',content_revision:'c'.repeat(64)}];
    __live.details={'Другой архив':{title:'Другой архив',content:'New synthetic vault',tags:[],content_revision:'c'.repeat(64)}};
    await notesLiveController.refresh();
    __live.holdDetails='';__live.pendingDetails.splice(0).forEach(item=>item.release());await pending;
    __liveAssert(selectedNoteTitle===''&&notes.length===1&&notes[0].title==='Другой архив','old vault selection survived');
    __liveAssert(!noteViewContent.textContent.includes('Recovered detail'),'old vault detail reappeared');})()`));
  await check("the actual unload handler disposes the scheduler and prevents further requests", () => evaluate(`(async()=>{
    window.dispatchEvent(new Event('beforeunload'));const before=__live.listRequests;
    await notesLiveController.refresh();await notesLiveController.wake();
    __liveAssert(notesLiveController.getState().disposed&&before===__live.listRequests,'unload left scheduler active');})()`));
  const ruCoverage = await ru.win.webContents.debugger.sendCommand("Profiler.takePreciseCoverage");
  coverage.push({ language: "ru", result: ruCoverage.result.filter(script => /notes_(live_sync|live_application|list_view|renderer|markdown)\.js/.test(script.url)) });
  ru.win.destroy();

  const en = await context("en");
  await check("English note view shows source text, translated related label and metadata without service fields", () => en.evaluate(`(async()=>{
    notesLiveController.pause();__liveComplete();await notesLiveController.refresh();
    __liveAssert(noteViewTitle.textContent==='Bicycle repair plan','English display title missing');
    __liveAssert(noteViewContent.textContent.includes('Related notes')&&noteViewContent.textContent.includes(__live.source),'English note not rendered');
    __liveAssert(noteViewContent.querySelectorAll('a[data-note-title]').length===2&&noteViewTags.textContent.includes('#ремонт'),'metadata missing');
    __liveAssert(!noteViewContent.textContent.includes('noda_source_'),'service header leaked');})()`));
  await capture(en.win, "en", "03-live-note-en.png");
  await en.evaluate("notesLiveController.dispose()");
  const enCoverage = await en.win.webContents.debugger.sendCommand("Profiler.takePreciseCoverage");
  coverage.push({ language: "en", result: enCoverage.result.filter(script => /notes_(live_sync|live_application|list_view|renderer|markdown)\.js/.test(script.url)) });
  en.win.destroy();
  const after = hashes();
  const result = { checks, blockedNetwork: network, sourceUnchanged: JSON.stringify(before) === JSON.stringify(after),
    electron: process.versions.electron, chrome: process.versions.chrome };
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(out, "source-hashes.json"), JSON.stringify({ before, after }, null, 2));
  fs.writeFileSync(path.join(out, "coverage.json"), JSON.stringify(coverage));
  fs.writeFileSync(path.join(out, "captures.json"), JSON.stringify(captures, null, 2));
  console.log(JSON.stringify(result));
  clearTimeout(watchdog);
  app.exit(checks.some(item => item.status !== "pass") || network || !result.sourceUnchanged ? 1 : 0);
}

run().catch(error => {
  clearTimeout(watchdog);
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  fs.writeFileSync(path.join(out, "harness-error.txt"), String(error.stack || error));
  console.error(error.stack); app.exit(1);
});
