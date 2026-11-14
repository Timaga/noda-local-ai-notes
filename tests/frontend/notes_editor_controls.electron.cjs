"use strict";
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../.."), out = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2] && !fs.existsSync(out), "Use a fresh explicit output directory");
fs.mkdirSync(out, { recursive: true });
app.setPath("userData", path.join(out, "profile")); app.setPath("sessionData", path.join(out, "profile"));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-background-networking");
const checks = [], errors = []; let network = 0;
const timeout = setTimeout(() => { fs.writeFileSync(path.join(out, "timeout.json"), JSON.stringify(checks)); app.exit(2); }, 30000);
async function run() {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest(({ url }, done) => {
    const local = /^(data|about):/.test(url); if (!local) network++; done({ cancel: !local });
  });
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.on("console-message", info => { if (info.level === "error") errors.push(String(info.message)); });
  const css = fs.readFileSync(path.join(root, "frontend/notes_inline_editor.css"), "utf8");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
    :root{--bg:#181c21;--bg-elevated:#20262c;--bg-soft:#262d35;--line:#47505b;--text:#edf1f5;--text-muted:#adb7c3;--warn:#e3b95d;--workspace-accent:#67d590;--workspace-accent-ink:#10251a;--workspace-line:#39434e}
    [hidden]{display:none!important}body{margin:20px;background:var(--bg);color:var(--text);font-family:'Segoe UI',sans-serif}article{height:610px}textarea{font:inherit}.sr-only{position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden}${css}
    </style></head><body class="notes-page"><div class="notes-viewer"><article id="note-view-panel" class="note-view-panel"><header class="note-view-header"><h2>Синтетическая заметка</h2><button id="delete-note-btn">Корзина</button><div id="note-view-tags" class="tag-row"></div></header><div id="note-view-content" class="note-view-content"></div></article></div></body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  for (const file of ["notes_library_tools.js", "notes_editor_session.js", "notes_editor_commands.js", "notes_inline_editor.js"]) {
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, "frontend", file), "utf8"));
  }
  const evaluate = source => win.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${source})};}catch(error){return {ok:false,error:String(error.stack||error)}}})()`)
    .then(result => { if (!result.ok) throw new Error(result.error); return result.value; });
  await evaluate(`(()=>{window.check=(condition,message)=>{if(!condition)throw new Error(message)};
    window.wait=async test=>{const end=performance.now()+3000;while(!test()){if(performance.now()>end)throw new Error('UI wait expired');await new Promise(r=>setTimeout(r,10))}};
    let epoch=1;window.changeContext=()=>epoch++;
    const context={snapshot:()=>({epoch}),isCurrent:state=>state.epoch===epoch};
    window.fixture={source:'original',revision:'1'.repeat(64),writes:[],nextFailure:null,confirms:0,answer:true,prefs:{editorAutoSave:false,editorAutoSaveDelayMs:1000}};
    window.NodaPreferences={get:()=>fixture.prefs};window.confirm=()=>{fixture.confirms++;return fixture.answer};
    const memory=new Map(),drafts=NotesLibraryTools.createDrafts(()=>({getItem:key=>memory.get(key),setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)}));
    const detail=()=>({title:'note',editable_body:fixture.source,edit_revision:fixture.revision,tags:[]});
    window.editor=NotesInlineEditor.create({doc:document,context,drafts,getProject:()=> 'a'.repeat(32),getVault:()=> 'a'.repeat(32),text:(ru,en)=>ru,
      renderPreview:value=>document.getElementById('note-view-content').textContent=value,saveCopy:()=>{},
      request:async(url,options)=>{fixture.writes.push(JSON.parse(options.body));if(fixture.nextFailure){const code=fixture.nextFailure;fixture.nextFailure=null;throw Object.assign(new Error(code),{code})}
        fixture.source=JSON.parse(options.body).content;fixture.revision='2'.repeat(64);return {title:'note',cache_updated:true}},readDetail:async()=>detail()});
    window.drafts=drafts;window.fresh=detail;editor.open('note',detail());return true})()`);
  async function check(name, body) {
    try { await body(); checks.push({ name, status: "pass" }); }
    catch (error) { checks.push({ name, status: "fail", error: String(error.stack || error) }); }
  }
  await check("opening defaults to preview and explicitly switching to editing preserves the source", async () => {
    await evaluate(`(()=>{const toggle=document.getElementById('note-preview-toggle'),preview=document.getElementById('note-view-content');
      check(editor.inputElement.hidden&&!preview.hidden&&toggle.getAttribute('aria-pressed')==='true','default preview missing');
      check(preview.textContent==='original'&&fixture.writes.length===0,'preview changed source');
      check(toggle.title==='Редактировать','preview action not labeled');toggle.click();
      check(!editor.inputElement.hidden&&preview.hidden&&editor.inputElement.value==='original','editing unavailable');
      check(toggle.getAttribute('aria-pressed')==='false','editing mode not reflected');return true})()`);
  });
  await check("disabled autosave exposes manual save and blur does not publish", async () => {
    await evaluate(`(async()=>{const input=editor.inputElement;input.value='manual text';input.dispatchEvent(new Event('input'));input.dispatchEvent(new Event('blur'));
      check(fixture.writes.length===0,'blur bypassed autosave setting');check(!document.getElementById('note-save-manual').hidden,'manual action missing');
      document.getElementById('note-save-manual').click();await wait(()=>editor.getState().status==='saved');check(fixture.writes.length===1,'manual action did not save')})()`);
  });
  await check("Cyrillic layout shortcuts save and format through the physical key", async () => {
    await evaluate(`(async()=>{const input=editor.inputElement;input.value='word';input.dispatchEvent(new Event('input'));input.focus();input.setSelectionRange(0,4);
      const bold=new KeyboardEvent('keydown',{key:'и',code:'KeyB',ctrlKey:true,bubbles:true,cancelable:true});input.dispatchEvent(bold);
      check(bold.defaultPrevented&&input.value==='**word**','Russian bold failed');
      const save=new KeyboardEvent('keydown',{key:'ы',code:'KeyS',ctrlKey:true,bubbles:true,cancelable:true});input.dispatchEvent(save);
      check(save.defaultPrevented,'Russian save was not intercepted');await wait(()=>editor.getState().status==='saved')})()`);
  });
  await check("link dialog rejects unsafe addresses, inserts the requested URL and supports native undo", async () => {
    await evaluate(`(async()=>{const input=editor.inputElement;input.value='reference';input.dispatchEvent(new Event('input'));input.focus();input.select();
      document.querySelector('[data-format="link"]').click();const dialog=document.getElementById('note-link-dialog');check(dialog.open,'link dialog missing');
      const url=document.getElementById('note-link-address');url.value='javascript:alert(1)';dialog.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      check(document.getElementById('note-link-error').textContent.length>0&&input.value==='reference','unsafe link inserted');url.value='https://example.org/docs?q=1&n=2';
      dialog.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await wait(()=>!document.getElementById('note-link-dialog'));
      check(input.value==='[reference](<https://example.org/docs?q=1&n=2>)','wrong address or source');return true})()`);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Z", modifiers: ["control"] });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Z", modifiers: ["control"] });
    await evaluate("wait(()=>editor.inputElement.value==='reference')");
  });
  await check("a stale link dialog cannot change another note or project", async () => {
    await evaluate(`(async()=>{editor.inputElement.select();document.querySelector('[data-format="link"]').click();changeContext();
      const dialog=document.getElementById('note-link-dialog');document.getElementById('note-link-address').value='https://example.org/';
      dialog.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      check(editor.inputElement.value==='reference'&&dialog.open,'stale dialog edited source');dialog.close();await wait(()=>!document.getElementById('note-link-dialog'));editor.open('note',fresh());return true})()`);
  });
  await check("conflict recovery requires confirmation and then opens the current file", async () => {
    await evaluate(`(async()=>{editor.inputElement.value='my draft';editor.inputElement.dispatchEvent(new Event('input'));fixture.nextFailure='note_edit_conflict';await editor.flush();
      const button=document.getElementById('note-reload-latest');check(!button.hidden,'recovery action missing');fixture.answer=false;button.click();
      check(editor.getState().content==='my draft'&&editor.getState().blocked,'cancel discarded draft');fixture.answer=true;fixture.source='external current';fixture.revision='3'.repeat(64);button.click();
      await wait(()=>editor.getState().status==='saved'&&!editor.getState().reloading);check(editor.inputElement.value==='external current','fresh file not opened');
      check(drafts.read('a'.repeat(32),'note')===null&&fixture.confirms===2,'draft not cleared after confirmation');})()`);
  });
  await check("a preferences event reconfigures autosave without recreating the editor", async () => {
    await evaluate(`(()=>{window.dispatchEvent(new CustomEvent('noda-preferences:changed',{detail:{editorAutoSave:true,editorAutoSaveDelayMs:2500}}));
      check(editor.getState().autoSaveEnabled&&editor.getState().autoSaveDelayMs===2500,'preferences not applied');return true})()`);
  });
  fs.writeFileSync(path.join(out, "editor-controls.png"), (await win.webContents.capturePage()).toPNG());
  await evaluate("editor.close()");
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ checks, errors, network, electron: process.versions.electron }, null, 2));
  clearTimeout(timeout); win.destroy(); app.exit(checks.some(item => item.status !== "pass") || errors.length || network ? 1 : 0);
}
run().catch(error => { clearTimeout(timeout); fs.writeFileSync(path.join(out, "harness-error.txt"), String(error.stack || error)); app.exit(1); });
