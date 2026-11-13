const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repo = path.resolve(__dirname, "../..");
const output = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "noda-quick-capture-")));
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "profile"));
app.setPath("sessionData", path.join(output, "profile"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");

async function run() {
  await app.whenReady();
  let blockedNetwork = 0;
  session.defaultSession.webRequest.onBeforeRequest(({ url }, callback) => {
    const local = /^(file|data|about):/.test(url);
    if (!local) blockedNetwork += 1;
    callback({ cancel: !local });
  });
  const win = new BrowserWindow({ width: 760, height: 630, show: false,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, offscreen: true } });
  const evaluate = source => win.webContents.executeJavaScript(source);
  const checks = [];
  async function check(name, body) {
    try { await body(); checks.push({ name, status: "pass" }); }
    catch (error) { checks.push({ name, status: "fail", error: error.message }); }
  }
  async function key(keyCode, modifiers = []) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (keyCode === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  }
  async function capture(name, rect) {
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    let image;
    for (let frame = 0; frame < 2; frame += 1) {
      image = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { win.webContents.removeListener("paint", painted); reject(new Error("Offscreen paint timeout")); }, 3000);
        function painted(_event, _dirty, value) { clearTimeout(timeout); resolve(value); }
        win.webContents.once("paint", painted);
        win.webContents.invalidate();
      });
    }
    const height = await evaluate("Math.min(630,Math.max(86,Math.ceil(document.querySelector('.quick-shell').getBoundingClientRect().bottom+8)))");
    fs.writeFileSync(path.join(output, name), image.crop(rect || {x:0,y:0,width:760,height}).toPNG());
  }
  try {
    const html = fs.readFileSync(path.join(repo, "frontend/index.html"), "utf8")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace("<head>", `<head><base href="${pathToFileURL(path.join(repo, "frontend/")).href}">`);
    const fixture = path.join(output, "fixture.html");
    fs.writeFileSync(fixture, html);
    await win.loadFile(fixture);
    await evaluate(fs.readFileSync(path.join(__dirname, "generation_queue_renderer.fixture.js"), "utf8") + "\nvoid 0;");
    await evaluate(`
      window.__queueFixture.rows = [];
      window.__queueFixture.resizes = [];
      window.quickNoteBridge.getLanguage = () => "ru";
      window.quickNoteBridge.setQuickCaptureHeight = async value => { window.__queueFixture.resizes.push(value); return {ok:true}; };
      document.body.classList.replace("app-loading", "app-ready");
      document.getElementById("startup-overlay").hidden = true;
      document.getElementById("startup-overlay").style.display = "none";
      document.documentElement.dataset.theme = "classic-blue";
    `);
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Profiler.enable");
    await win.webContents.debugger.sendCommand("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    for (const file of ["ui_translations.js", "ui_languages.js", "i18n.js", "support_footer.js", "project_context.js", "generation_retry_client.js", "generation_queue_client.js", "quick_capture_view.js", "quick_capture_project.js", "renderer.js"]) {
      await evaluate(`${fs.readFileSync(path.join(repo, "frontend", file), "utf8")}\n//# sourceURL=noda-quick-test://${file}`);
    }
    await evaluate("init().then(() => queueClient.stop())");
    await check("quick capture reserves space for the shared support footer", async () => {
      await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
      const actual = await evaluate(`({email:document.getElementById('support-email').textContent,
        icon:!document.getElementById('support-copy').textContent.trim(),footer:document.getElementById('app-support-footer').getBoundingClientRect().height,
        requested:__queueFixture.resizes.at(-1),entry:document.getElementById('quick-note-form').getBoundingClientRect().height})`);
      assert.equal(actual.email,"tim@buglai.com");assert.equal(actual.icon,true);assert.equal(actual.footer,32);
      assert(actual.requested>=actual.entry+48,JSON.stringify(actual));
      win.setSize(760,actual.requested);
      await evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
      assert.equal(await evaluate("document.getElementById('app-support-footer').getBoundingClientRect().top>=document.querySelector('.quick-shell').getBoundingClientRect().bottom"),true);
      await capture("00-support-footer-ru.png",{x:0,y:0,width:760,height:actual.requested});
      win.setSize(760,630);await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    });
    await check("collapsed window contains only the note entry and queue control", async () => {
      const actual = await evaluate(`(() => {
        const visible = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
        return { open:document.getElementById('quick-queue-toggle').getAttribute('aria-expanded'),
          panelVisible:visible(document.getElementById('quick-queue-panel')),
          buttons:[...document.querySelectorAll('button')].filter(visible).map(node=>node.id),
          radios:[...document.querySelectorAll('[name="note-mode"]')].filter(visible).length,
          textareaVisible:visible(promptInput),height:document.querySelector('main').getBoundingClientRect().height,
          placeholder:promptInput.placeholder };
      })()`);
      assert.equal(actual.open, "false"); assert.equal(actual.panelVisible, false);
      assert.deepEqual(actual.buttons, ["quick-queue-toggle", "support-copy"]); assert.equal(actual.radios, 0);
      assert.equal(actual.textareaVisible, true); assert(actual.height <= 100, JSON.stringify(actual));
      assert(actual.placeholder.includes("Быстрая заметка"));
    });
    await check("plain Enter sends the exact source once while duplicate Enter is ignored", async () => {
      await evaluate(`promptInput.value='  Проверить заявки\\nи почту  '; promptInput.focus();
        window.__queueFixture.mode='waiting'; window.__queueFixture.postStarted=()=>{};void 0;`);
      win.webContents.focus(); await key("Enter");
      const before = await evaluate("({posts:window.__queueFixture.posts.length,raw:promptInput.value,body:window.__queueFixture.posts.at(-1)})");
      assert.equal(before.posts, 1); assert.equal(before.raw, "  Проверить заявки\nи почту  ");
      assert.equal(before.body.prompt, before.raw); assert.equal(before.body.mode, "organize");
      await key("Enter"); assert.equal(await evaluate("window.__queueFixture.posts.length"), 1);
      await evaluate("promptInput.value='Следующий черновик';document.getElementById('quick-queue-toggle').focus();window.__submissionFocus=document.activeElement");
      await evaluate("window.__queueFixture.release(); new Promise(resolve=>requestAnimationFrame(resolve))");
      await evaluate("new Promise(resolve=>requestAnimationFrame(resolve))");
      assert.equal(await evaluate("promptInput.value"), "Следующий черновик");
      assert.equal(await evaluate("document.activeElement===window.__submissionFocus"),true);
      await evaluate("queueClient.stop();window.__queueFixture.mode='normal';");
    });
    await check("Shift+Enter adds a line without submitting and composition Enter is ignored", async () => {
      await evaluate("promptInput.value='Первая строка';promptInput.focus();promptInput.setSelectionRange(promptInput.value.length,promptInput.value.length)");
      await key("Enter", ["shift"]);
      assert.equal(await evaluate("window.__queueFixture.posts.length"), 1);
      assert.equal(await evaluate("promptInput.value"), "Первая строка\n");
      await evaluate(`promptInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));`);
      await evaluate(`promptInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true,cancelable:true}));`);
      assert.equal(await evaluate("window.__queueFixture.posts.length"), 1);
    });
    await check("empty input is rejected without submitting", async () => {
      await evaluate("promptInput.value='   ';promptInput.focus()"); await key("Enter");
      assert.equal(await evaluate("window.__queueFixture.posts.length"), 1);
      assert.equal(await evaluate("promptInput.value"), "   ");
    });
    await check("unconfirmed submission preserves the raw draft and reports a safe error", async () => {
      await evaluate("window.__queueFixture.bridgeFailure=true;promptInput.value='  Точный исходник\\nбез изменений  ';promptInput.focus()");
      await key("Enter");
      assert.equal(await evaluate("promptInput.value"), "  Точный исходник\nбез изменений  ");
      assert.equal(await evaluate("window.__queueFixture.posts.length"), 1);
      const error = await evaluate("document.getElementById('quick-feedback').textContent");
      assert(error.includes("не подтверждена")); assert(!error.includes("Synthetic"));
      await evaluate("window.__queueFixture.bridgeFailure=false");
    });
    await check("queue control is keyboard accessible and opens only the requested panel", async () => {
      await evaluate("document.getElementById('quick-queue-toggle').focus()"); await key("Enter");
      assert.equal(await evaluate("document.getElementById('quick-queue-toggle').getAttribute('aria-expanded')"), "true");
      assert.equal(await evaluate("document.getElementById('quick-queue-panel').hidden"), false);
    });
    await evaluate(`window.__setQuickJobs = async rows => { window.__queueFixture.rows=rows;await queueClient.refresh();queueClient.stop(); };
      window.__progress = (current) => ({version:1,attempt:1,current_stage:current,stages:['title','tags','links','save'].map((id,index)=>({
        id,status:current===null?'completed':index<['title','tags','links','save'].indexOf(current)?'completed':id===current?'running':'pending',started_at:null,finished_at:null}))});
      promptInput.value='';setStatus('ok','Готово');
      window.__setQuickJobs([{job_id:'staged',status:'processing',created_at:100,prompt_preview:'Проверить письма для новых пользователей',progress:window.__progress('tags')}]);
    `);
    await evaluate("window.quickCaptureView.setQueueOpen(false)");
    await capture("01-quick-collapsed.png", {x:0,y:0,width:760,height:86});
    await evaluate("window.quickCaptureView.setQueueOpen(true)");
    await capture("02-queue-expanded.png");
    await check("each queued note exposes the actual stage statuses and keeps its expansion on updates", async () => {
      await evaluate("document.querySelector('details[data-job-id=staged] summary').click()");
      const stages = await evaluate("[...document.querySelectorAll('details[data-job-id=staged] [data-stage-id]')].map(n=>({id:n.dataset.stageId,status:n.dataset.state,text:n.textContent}))");
      assert.deepEqual(stages.map(({id,status})=>({id,status})), [
        {id:"title",status:"completed"},{id:"tags",status:"running"},{id:"links",status:"pending"},{id:"save",status:"pending"},
      ]);
      assert(stages.every(stage=>stage.text.trim()));
      await evaluate("document.querySelector('details[data-job-id=staged] summary').focus();window.__queueFixture.rows[0].progress=window.__progress('links');queueClient.refresh()");
      assert.equal(await evaluate("document.querySelector('details[data-job-id=staged]').open"), true);
      assert.equal(await evaluate("document.activeElement === document.querySelector('details[data-job-id=staged] summary')"), true);
      assert.equal(await evaluate("document.querySelector('details[data-job-id=staged] [data-stage-id=links]').dataset.state"), "running");
      await capture("03-job-stages.png");
    });
    await check("saved source after generation failure is not presented as a completed pipeline", async () => {
      await evaluate(`window.__setQuickJobs([{job_id:'source-only',status:'completed',processing_outcome:'source_saved',created_at:101,
        prompt_preview:'<img src=x onerror=window.__attack=1>',result:{generation:{metadata_pending:true}},
        progress:{version:1,attempt:1,current_stage:null,stages:['title','tags','links','save'].map(id=>({id,status:id==='title'?'failed':id==='save'?'completed':'pending',started_at:null,finished_at:null}))}}]).then(()=>document.querySelector('details[data-job-id=source-only] summary').click());`);
      const actual = await evaluate("({text:jobsList.textContent,attack:window.__attack,images:jobsList.querySelectorAll('img').length,state:jobsList.querySelector('details[data-job-id=source-only] [data-stage-id=title]').dataset.state})");
      assert.equal(actual.attack, 0); assert.equal(actual.images, 0); assert.equal(actual.state, "failed");
      assert(actual.text.includes("Исходник сохранён"));
      assert.equal(await evaluate("jobsList.querySelector('details[data-job-id=source-only]').dataset.status"), "source_saved");
      await evaluate(`window.__queueFixture.queueQueuedCount=0;
        window.__setQuickJobs([...jobs.values()].map(job=>job.job_id==='source-only'?job:
          {...job,status:'completed',processing_outcome:'completed',progress:window.__progress(null)}));`);
      const attention = await evaluate("({badge:document.getElementById('quick-queue-badge').textContent,hidden:document.getElementById('quick-queue-badge').hidden,status:document.getElementById('quick-queue-toggle').dataset.hasFailures})");
      assert.deepEqual(attention,{badge:"!",hidden:false,status:"true"});
      assert.equal(await evaluate("document.querySelector('details[data-job-id=staged]').dataset.status"), "completed");
      assert.equal(await evaluate("[...document.querySelectorAll('details[data-job-id=staged] [data-stage-id]')].every(node=>node.dataset.state==='completed')"),true);
      await capture("04-quick-source-saved.png");
    });
    await check("English entry, queue, and stages are localized", async () => {
      await evaluate("window.nodaI18n.setLanguage('en');window.quickCaptureView?.refreshLanguage?.();renderJobs();renderQueueCounter()");
      const actual = await evaluate("({placeholder:promptInput.placeholder,text:[...jobsList.querySelectorAll('.quick-job-status,.quick-job-phase,[data-stage-id],.quick-job-error,.quick-source-button')].map(n=>n.textContent).join(' '),label:document.getElementById('quick-queue-toggle').getAttribute('aria-label')})");
      assert(actual.placeholder.includes("Quick note")); assert(actual.label.includes("queue") || actual.label.includes("Queue"));
      assert(!/[А-Яа-яЁё]/.test(actual.text));
      await capture("06-quick-english-expanded.png");
      await evaluate("window.quickCaptureView.setQueueOpen(false)");
      await capture("05-quick-english-collapsed.png", {x:0,y:0,width:760,height:86});
    });
    await check("long draft and expanded failure rows remain scrollable on a small viewport", async () => {
      win.setSize(400,300,false);
      await evaluate(`window.quickCaptureView.setQueueOpen(true);promptInput.value=Array(20).fill('Long synthetic draft').join('\\n');
        promptInput.dispatchEvent(new Event('input',{bubbles:true}));
        window.__setQuickJobs(Array.from({length:10},(_,index)=>({job_id:'overflow-'+index,status:'failed',created_at:1000+index,
          prompt_preview:'Synthetic failed source '+index}))).then(()=>{
            document.querySelectorAll('details[data-status=failed]').forEach(row=>{row.open=true;});
          });`);
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const actual = await evaluate(`(() => {
        const button=document.querySelector('details[data-job-id=overflow-0] .quick-source-button');
        button.scrollIntoView({block:'end'});
        const rect=button.getBoundingClientRect(),list=jobsList.getBoundingClientRect();
        return {top:rect.top,bottom:rect.bottom,listTop:list.top,listBottom:list.bottom,height:innerHeight,
          scrollable:jobsList.scrollHeight>jobsList.clientHeight,scroll:jobsList.scrollTop};
      })()`);
      assert(actual.scrollable && actual.scroll>0,JSON.stringify(actual));
      assert(actual.top>=actual.listTop-1 && actual.bottom<=actual.listBottom+1,JSON.stringify(actual));
      assert(actual.bottom<=actual.height+1,JSON.stringify(actual));
    });
    await check("Escape uses the existing window bridge once", async () => {
      await evaluate("promptInput.focus()");await key("Escape");
      assert.equal(await evaluate("window.__queueFixture.hideCalls"),1);
    });
    await check("the HTTP timeout aborts a stalled request", async () => {
      const result = await evaluate(`(async()=>{
        const original=window.fetch;
        window.fetch=(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Synthetic stalled request','AbortError')),{once:true}));
        try{await fetchWithTimeout('http://127.0.0.1:5000/synthetic-stall',{},5);return 'unexpected success';}
        catch(error){return error.name;}finally{window.fetch=original;}
      })()`);
      assert.equal(result,"AbortError");
    });
    await check("queue retention is visible and clearing successful entries keeps failed sources", async () => {
      win.setSize(760,630,false);
      await evaluate(`
        window.nodaI18n.setLanguage('ru');
        quickCaptureView.renderProject({status:'ready',projectState:{activeProject:{name:'Тестовый проект'}}});
        promptInput.value=''; quickCaptureView.resizeInput();
        window.__queueFixture.history={vault_id:'0123456789abcdef0123456789abcdef',history_revision:0,history_retention_days:30};
        window.__setQuickJobs([
          {job_id:'history-ready',status:'completed',created_at:3020,prompt_preview:'Готовый результат',processing_outcome:'completed'},
          {job_id:'history-protected',status:'completed',created_at:3030,prompt_preview:'Сохранённый исходник',processing_outcome:'source_saved'},
        ]);`);
      const before = await evaluate(`({
        project:document.getElementById('quick-active-project').textContent,
        hint:document.getElementById('quick-input-help').textContent,
        retention:document.getElementById('quick-queue-retention').textContent,
      })`);
      assert(before.project.includes("Тестовый проект"));
      assert(before.hint.includes("Shift + Enter"));
      assert(before.retention.includes("30 дней"));
      await evaluate(`window.confirm = () => false; document.getElementById('quick-queue-cleanup').click();`);
      assert.equal(await evaluate("window.__queueFixture.history.history_revision"), 0);
      await evaluate(`window.confirm = () => true; document.getElementById('quick-queue-cleanup').click();
        new Promise((resolve,reject) => {
          const status=document.getElementById('quick-queue-cleanup-status');
          const timeout=setTimeout(()=>reject(new Error('Missing cleanup acknowledgement')),3000);
          const observer=new MutationObserver(()=>{
            if (!status.hidden) { clearTimeout(timeout); observer.disconnect(); resolve(); }
          });
          observer.observe(status,{attributes:true});
        });`);
      assert.equal(await evaluate("window.__queueFixture.history.history_revision"), 1);
      assert.equal(await evaluate("document.querySelector('details[data-job-id=history-ready]')"), null);
      assert.equal(await evaluate("Boolean(document.querySelector('details[data-job-id=history-protected]'))"), true);
      assert.match(await evaluate("document.getElementById('quick-queue-cleanup-status').textContent"), /1/);
    });
    const coverage = await win.webContents.debugger.sendCommand("Profiler.takePreciseCoverage");
    fs.writeFileSync(path.join(output, "coverage.json"), JSON.stringify(coverage.result.filter(script=>script.url.startsWith("noda-quick-test://")),null,2));
    win.setSize(760,630,false);
    await win.loadFile(fixture);
    await evaluate(fs.readFileSync(path.join(__dirname, "generation_queue_renderer.fixture.js"), "utf8") + "\nvoid 0;");
    await evaluate(`window.__queueFixture.rows=[{job_id:'clean-source-saved',status:'completed',created_at:100,
      processing_outcome:'source_saved',prompt_preview:'Подготовить план встречи с командой',
      progress:{version:1,attempt:1,current_stage:null,stages:['title','tags','links','save'].map(id=>({id,
        status:id==='title'?'failed':id==='save'?'completed':'pending',started_at:null,finished_at:null}))}}];
      window.__queueFixture.source='Подготовить план встречи с командой: обсудить задачи недели и договориться о следующем шаге.';
      window.__queueFixture.queueQueuedCount=0;
      document.body.classList.replace('app-loading','app-ready');document.getElementById('startup-overlay').remove();
      document.documentElement.dataset.theme='classic-blue';`);
    for (const file of ["ui_translations.js", "ui_languages.js", "i18n.js", "project_context.js", "generation_retry_client.js", "generation_queue_client.js", "quick_capture_view.js", "quick_capture_project.js", "renderer.js"]) {
      await evaluate(fs.readFileSync(path.join(repo, "frontend", file), "utf8"));
    }
    await evaluate("init().then(()=>{queueClient.stop();window.quickCaptureView.setQueueOpen(true);document.querySelector('details summary').click();})");
    win.webContents.focus();
    await key("Tab");
    await capture("07-clean-source-saved.png");
    await evaluate(`
      quickCaptureView.renderProject({status:'ready',projectState:{activeProject:{name:'Тестовый проект'}}});
      window.__queueFixture.history={vault_id:'0123456789abcdef0123456789abcdef',history_revision:0,history_retention_days:30};
      window.__queueFixture.rows.push({job_id:'ready-entry',status:'completed',created_at:101,
        processing_outcome:'completed',prompt_preview:'Подготовить список материалов'});
      queueClient.refresh();`);
    await capture("08-queue-retention-ru.png");
    const result = { checks, blockedNetwork, electron:process.versions.electron, chrome:process.versions.chrome };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result,null,2));
    process.stdout.write(JSON.stringify(result)+"\n");
    app.exit(checks.some(check=>check.status!=="pass") || blockedNetwork ? 1 : 0);
  } finally { if (!win.isDestroyed()) win.destroy(); }
}
run().catch(error => { process.stderr.write(String(error.stack||error)+"\n"); app.exit(1); });
