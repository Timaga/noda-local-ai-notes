"use strict";
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../.."), out = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2] && !fs.existsSync(out)); fs.mkdirSync(out, { recursive: true });
app.setPath("userData", path.join(out, "profile")); app.setPath("sessionData", path.join(out, "profile"));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-background-networking");
let win, network = 0;
const timeout = setTimeout(() => app.exit(2), 30000);
async function run() {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest(({url},done) => {
    const local = /^(about|data):/.test(url); if (!local) network++; done({cancel:!local});
  });
  win = new BrowserWindow({ width: 1000, height: 720, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } });
  const html = `<html><style>body{background:#181b20;color:#eee;font-family:Segoe UI;--bg:#181b20;--bg-elevated:#20242c;--line:#4c5560;--text:#eee;--text-muted:#b3bcc7;--bg-soft:#303840;--accent:#67d590;--workspace-accent:#67d590;--workspace-accent-ink:#10251a}${fs.readFileSync(path.join(root,"frontend/notes_metadata_editor.css"),"utf8")}</style><body class="notes-page"><article id="note-view-panel"><header class="note-view-header"><h2>Синтетическая заметка</h2><details class="note-actions-menu"></details></header></article></body></html>`;
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  const debug=win.webContents.debugger; debug.attach("1.3"); await debug.sendCommand("Profiler.enable");
  await debug.sendCommand("Profiler.startPreciseCoverage", {callCount:true,detailed:true});
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(root,"frontend/notes_metadata_editor.js"),"utf8") + "\n//# sourceURL=notes_metadata_editor.js");
  const checks = await win.webContents.executeJavaScript(`(async()=>{
    const checks=[],assert=(x,m)=>{if(!x)throw new Error(m);};
    const wait=async f=>{const end=performance.now()+3000;while(!f()){if(performance.now()>end)throw new Error('UI wait expired');await new Promise(r=>setTimeout(r,10));}};
    const check=async(name,fn)=>{try{await fn();checks.push({name,status:'pass'});}catch(e){checks.push({name,status:'fail',error:e.message});}};
    let current=true,allow=true,fail=false,release=null;
    const calls=[],saved=[],messages=[],busy=[],bound={project:'A'},detail={edit_revision:'1'.repeat(64),display_title:'Синтетический заголовок',tags:['tag'],editable_body:'Do not change this body'};
    const editor=NotesMetadataEditor.create({doc:document,text:ru=>ru,context:{snapshot:()=>bound,isCurrent:value=>current&&value===bound},
      getTitle:()=>'Canonical',getDetail:()=>detail,getVault:()=>'a'.repeat(32),prepare:async()=>allow,
      readDetail:async()=>({...detail}),setBusy:v=>busy.push(v),onSaved:value=>saved.push(value),onError:value=>messages.push(value),
      request:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});if(release)await new Promise(r=>{release=r;});if(fail)throw Object.assign(new Error('conflict'),{code:'note_edit_conflict'});return {success:true,title:'Canonical'};}});
    const dialog=document.querySelector('dialog'),form=dialog.querySelector('form'),fields=dialog.querySelectorAll('input'),submit=dialog.querySelector('[type=submit]');
    await check('properties open from the pencil button with current values and keyboard focus',async()=>{document.querySelector('.note-metadata-edit').click();await wait(()=>dialog.open);assert(fields[0].value===detail.display_title&&fields[1].value==='tag','properties lost');assert(document.activeElement===fields[0],'title not focused');});
    await check('valid save sends metadata only and leaves body untouched',async()=>{fields[0].value='<b>Authored title</b>';fields[1].value='Новый, nested/tag';submit.click();await wait(()=>saved.length===1);assert(!dialog.open,'saved dialog left open');assert(calls[0].body.metadata.title==='<b>Authored title</b>','escaped value changed');assert(!Object.hasOwn(calls[0].body,'content'),'body mutation');assert(detail.editable_body==='Do not change this body','body changed');});
    await wait(()=>!busy.at(-1));
    await check('invalid and duplicate tags show field feedback before a request',async()=>{await editor.open();fields[1].value='tag,TAG';submit.click();assert(calls.length===1,'invalid tags were sent');assert(dialog.open&&dialog.querySelector('[role=status]').textContent.includes('20'),'missing validation');editor.close();});
    await new Promise(r=>setTimeout(r,0));
    await check('overlong titles are rejected and Cancel closes without a request',async()=>{await editor.open();fields[0].value='x'.repeat(161);submit.click();assert(dialog.querySelector('[role=status]').textContent.includes('160'),'title validation absent');assert(calls.length===1,'invalid title submitted');dialog.querySelector('[type=button]').click();await wait(()=>!dialog.open);});
    await new Promise(r=>setTimeout(r,0));
    await check('conflict preserves form values and remains recoverable by closing',async()=>{fail=true;await editor.open();fields[0].value='My title';submit.click();await wait(()=>dialog.querySelector('[role=status]').textContent.includes('другом месте'));assert(dialog.open&&!fields[0].disabled&&fields[0].value==='My title','conflict erased form');editor.close();fail=false;});
    await new Promise(r=>setTimeout(r,0));
    await check('unsaved body blocks metadata editing without losing the body',async()=>{allow=false;await editor.open();assert(!dialog.open&&messages.at(-1).includes('Сохраните текст'),'dirty body not guarded');allow=true;});
    await check('project switch before opening cannot expose old note properties',async()=>{current=false;await editor.open();assert(!dialog.open,'old project dialog exposed');current=true;});
    await check('a pending write blocks duplicate submission and Escape cancellation',async()=>{await editor.open();release=()=>{};submit.click();await wait(()=>typeof release==='function'&&calls.length===3);assert(submit.disabled&&fields[0].disabled,'pending fields editable');const cancelEvent=new Event('cancel',{cancelable:true});dialog.dispatchEvent(cancelEvent);assert(cancelEvent.defaultPrevented&&dialog.open,'Escape abandoned an in-flight write');release();release=null;await wait(()=>saved.length===2);assert(calls.length===3,'duplicate write');});
    await new Promise(r=>setTimeout(r,0));
    await editor.open();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return checks;
  })()`);
  fs.writeFileSync(path.join(out,"properties.png"),(await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(out,"coverage.json"),JSON.stringify(await debug.sendCommand("Profiler.takePreciseCoverage")));
  fs.writeFileSync(path.join(out,"results.json"),JSON.stringify({checks,network,electron:process.versions.electron},null,2));
  clearTimeout(timeout); win.destroy(); app.exit(checks.some(item=>item.status!=="pass")||network?1:0);
}
run().catch(error=>{clearTimeout(timeout);fs.writeFileSync(path.join(out,"harness-error.txt"),String(error.stack||error));app.exit(1);});
