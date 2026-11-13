const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repo = path.resolve(__dirname, "../..");
const output = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "noda-quick-retry-")));
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "profile"));
app.setPath("sessionData", path.join(output, "profile"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
const raw = "  Проверить почту\r\nи новые заявки <script>window.__retryAttack=1</script>  ";
const scripts = ["ui_translations.js", "ui_languages.js", "i18n.js", "project_context.js", "generation_retry_client.js", "generation_queue_client.js", "quick_capture_view.js", "quick_capture_project.js", "renderer.js"];
const buttonSelector = 'details[data-job-id="eligible"] .quick-retry-button';

const fixtureSource = `
  window.__retryAttack=0;
  window.__retry = { vault:'vault-a', mode:'normal', posts:[], enqueues:[], admitted:[], release:null,
    rejectCode:'retry_target_changed', copies:[], language:'ru' };
  const stageIds=['title','tags','links','save'];
  window.__retryProgress=(current=null)=>({version:1,attempt:1,current_stage:current,
    stages:stageIds.map(id=>({id,status:id==='links'?'failed':id==='save'?'completed':'completed',started_at:null,finished_at:null}))});
  window.__retry.rows=[
    {job_id:'eligible',client_request_id:'original-job-request',created_at:100,status:'completed',phase:'completed',
      processing_outcome:'source_saved',retry_available:true,recovery_summary:null,prompt_preview:'Проверить почту и новые заявки',
      progress:window.__retryProgress(),result:{title:'Unprocessed source',generation:{metadata_pending:true}}},
    {job_id:'complete',created_at:90,status:'completed',processing_outcome:'completed',retry_available:false,
      prompt_preview:'Другая заметка',progress:null},
    {job_id:'legacy',created_at:80,status:'completed',processing_outcome:'source_saved',prompt_preview:'Старое задание',progress:null}
  ];
  window.quickNoteBridge={ getHotkey:async()=> 'Ctrl+Shift+Space',getLanguage:()=>window.__retry.language,
    getProjects:async()=>({ok:true,mode:'legacy',status:'ready',context:null,activeProjectId:null,activeProject:null,projects:[]}),onProjectState:()=>()=>{},
    setQuickCaptureHeight:async()=>({ok:true}),ensureBackendReady:async()=>({ok:true}) };
  window.startupGate={waitForReady:async()=>{}};
  Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.__retry.copies.push(text)}});
  window.__retryAdmit=(job,body,vault)=>{
    const queued={...job,status:'queued',phase:'queued',processing_outcome:'pending',retry_available:false,result:undefined,
      progress:{version:1,attempt:0,current_stage:null,stages:stageIds.map(id=>({id,status:'pending',started_at:null,finished_at:null}))},
      recovery_summary:{request_id:body.client_request_id.replaceAll('-',''),status:'queued',requested_at:101,retry_count:1}};
    if(!window.__retry.admitted.includes(body.client_request_id))window.__retry.admitted.push(body.client_request_id);
    if(window.__retry.vault===vault)window.__retry.rows=window.__retry.rows.map(row=>row.job_id===job.job_id?queued:row);
    return {job:queued,queue:{queued_count:1,processing_count:0},vault_id:vault};
  };
  window.fetch=async(url,options={})=>{
    const state=window.__retry, pathname=new URL(url).pathname;
    let payload,status=200;
    if(pathname.endsWith('/retry')&&options.method==='POST'){
      const body=JSON.parse(options.body),id=decodeURIComponent(pathname.split('/').at(-2));
      const job=structuredClone(state.rows.find(row=>row.job_id===id));const vault=state.vault;
      state.posts.push({id,body});
      if(state.mode==='offline')throw new TypeError('INTERNAL_UNSAFE_RETRY_DETAIL');
      if(state.mode==='reject'){
        status=state.rejectCode==='retry_unsupported'?503:409;payload={code:state.rejectCode,error:'INTERNAL_UNSAFE_RETRY_DETAIL'};
        if(['retry_target_changed','retry_not_allowed'].includes(state.rejectCode)){
          state.rows=state.rows.map(row=>row.job_id===id?{...row,retry_available:false}:row);
        }
      }
      else{
        if(state.mode==='waiting')await new Promise(resolve=>{state.release=resolve;});
        payload=window.__retryAdmit(job,body,vault);status=202;
        if(state.mode==='lost-ack')throw new TypeError('INTERNAL_UNSAFE_RETRY_DETAIL');
      }
    }else if(pathname==='/generate/enqueue'){
      state.enqueues.push(JSON.parse(options.body));status=202;
      payload={job:{job_id:'unexpected-new-job',status:'queued'},queue:{queued_count:1},vault_id:state.vault};
    }else if(pathname==='/generate/jobs')payload={jobs:state.rows,next_cursor:null,vault_id:state.vault};
    else if(pathname.startsWith('/generate/jobs/')){
      const id=decodeURIComponent(pathname.split('/').at(-1));const job=state.rows.find(row=>row.job_id===id);
      payload={job:{...job,prompt_text:window.__retryRaw},vault_id:state.vault};
    }else if(pathname==='/generate/queue')payload={queue:{queued_count:state.rows.filter(row=>row.status==='queued').length,
      processing_count:state.rows.filter(row=>row.status==='processing').length},vault_id:state.vault};
    else if(pathname==='/runtime/config')payload={provider:'local',runtime_model_id:'synthetic'};
    else throw new Error('Unexpected synthetic API path');
    return {status,ok:status>=200&&status<300,json:async()=>structuredClone(payload)};
  };
`;

async function run() {
  await app.whenReady();
  app.on("window-all-closed",()=>{});
  let blockedNetwork = 0;
  const checks = [], windows = [], coverage = [];
  session.defaultSession.webRequest.onBeforeRequest(({url},callback)=>{
    const local=/^(file|about|data):/.test(url);if(!local)blockedNetwork+=1;callback({cancel:!local});
  });
  const html=fs.readFileSync(path.join(repo,"frontend/index.html"),"utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"")
    .replace("<head>",`<head><base href="${pathToFileURL(path.join(repo,"frontend/")).href}">`);
  const fixture=path.join(output,"fixture.html");fs.writeFileSync(fixture,html);
  async function fresh(options={}) {
    const win=new BrowserWindow({width:800,height:650,show:false,webPreferences:{sandbox:true,nodeIntegration:false,
      contextIsolation:true,offscreen:true}});
    windows.push(win);
    const evaluate=source=>win.webContents.executeJavaScript(source);
    await win.loadFile(fixture);
    await evaluate(fixtureSource+`\nwindow.__retryRaw=${JSON.stringify(raw)};
      window.__retry.language=${JSON.stringify(options.language||"ru")};
      window.__retryRaw=${JSON.stringify(options.raw||raw)};
      window.__retry.rows[0].processing_error=${JSON.stringify(options.processingError||null)};
      if(${Boolean(options.onlyEligible)})window.__retry.rows=window.__retry.rows.slice(0,1);
      document.body.classList.replace('app-loading','app-ready');document.getElementById('startup-overlay').remove();
      document.documentElement.dataset.theme='classic-blue';void 0;`);
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Profiler.enable");
    await win.webContents.debugger.sendCommand("Profiler.startPreciseCoverage",{callCount:true,detailed:true});
    for(const file of scripts)await evaluate(`${fs.readFileSync(path.join(repo,"frontend",file),"utf8")}\n//# sourceURL=noda-retry-test://${file}`);
    await evaluate("init().then(()=>queueClient.stop())");
    await evaluate("queueClient.detail('eligible').then(()=>{window.quickCaptureView.setQueueOpen(true);document.querySelector('details[data-job-id=eligible] summary').click();})");
    return {win,evaluate};
  }
  async function wait(page,condition) {
    return page.evaluate(`(async()=>{const deadline=performance.now()+3000;while(!(${condition})){
      if(performance.now()>deadline)throw new Error('Synthetic state wait timed out');await new Promise(resolve=>requestAnimationFrame(resolve));}})()`);
  }
  async function check(name,body) {
    let page;const firstWindow=windows.length;
    fs.appendFileSync(path.join(output,"check-progress.jsonl"),JSON.stringify({name,phase:"begin"})+"\n");
    try{page=await fresh();await body(page);checks.push({name,status:"pass"});}
    catch(error){checks.push({name,status:"fail",error:error.message});}
    finally{if(page){const data=await page.win.webContents.debugger.sendCommand("Profiler.takePreciseCoverage");
      coverage.push({check:name,result:data.result.filter(script=>script.url.startsWith('noda-retry-test://'))});
      page.win.destroy();}else{for(const win of windows.slice(firstWindow))if(!win.isDestroyed())win.destroy();}
      fs.appendFileSync(path.join(output,"check-progress.jsonl"),JSON.stringify(checks.at(-1))+"\n");}
  }
  async function key(page,keyCode) {
    page.win.webContents.sendInputEvent({type:"keyDown",keyCode});
    if(keyCode==='Enter')page.win.webContents.sendInputEvent({type:"char",keyCode:"\r"});
    page.win.webContents.sendInputEvent({type:"keyUp",keyCode});
    await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  }
  async function capture(page,name) {
    page.win.webContents.focus();await key(page,"Tab");
    let image;
    for(let frame=0;frame<2;frame+=1){image=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{page.win.webContents.removeListener('paint',painted);reject(new Error('Offscreen paint timeout'));},3000);
      function painted(_event,_dirty,value){clearTimeout(timeout);resolve(value);}
      page.win.webContents.once('paint',painted);page.win.webContents.invalidate();
    });}
    const height=await page.evaluate("Math.min(650,Math.max(86,Math.ceil(document.querySelector('.quick-shell').getBoundingClientRect().bottom+8)))");
    fs.writeFileSync(path.join(output,name),image.crop({x:0,y:0,width:800,height}).toPNG());
  }
  try {
    await check("only server-eligible saved-source jobs expose retry",async page=>{
      const actual=await page.evaluate(`({eligible:document.querySelector(${JSON.stringify(buttonSelector)})?.hidden,
        others:[...document.querySelectorAll('details:not([data-job-id=eligible]) .quick-retry-button')].every(button=>button.hidden),
        source:document.querySelector('details[data-job-id=eligible] .quick-job-source').textContent,attack:window.__retryAttack})`);
      assert.equal(actual.eligible,false);assert.equal(actual.others,true);assert.equal(actual.source,raw);assert.equal(actual.attack,0);
    });
    await check("double click sends one retry and preserves raw source without optimistic progress",async page=>{
      await page.evaluate(`window.__retry.mode='waiting';promptInput.value=window.__retryRaw;
        window.__draftBeforeRetry=promptInput.value;
        document.querySelector(${JSON.stringify(buttonSelector)}).click();document.querySelector(${JSON.stringify(buttonSelector)}).click();`);
      await wait(page,"window.__retry.posts.length===1&&typeof window.__retry.release==='function'");
      const pending=await page.evaluate(`({draft:promptInput.value,posts:window.__retry.posts,queued:window.__retry.enqueues.length,
        button:document.querySelector(${JSON.stringify(buttonSelector)}).disabled,
        status:document.querySelector('details[data-job-id=eligible]').dataset.status,
        links:document.querySelector('details[data-job-id=eligible] [data-stage-id=links]').dataset.state})`);
      const draftBefore=await page.evaluate("window.__draftBeforeRetry");
      assert.equal(pending.draft,draftBefore);assert.equal(pending.queued,0);assert.equal(pending.button,true);
      assert.equal(pending.status,"source_saved");assert.equal(pending.links,"failed");
      assert.equal(pending.posts[0].id,"eligible");assert.deepEqual(Object.keys(pending.posts[0].body).sort(),["client_request_id","expected_vault_id"]);
      assert.equal(pending.posts[0].body.expected_vault_id,"vault-a");
      await page.evaluate("window.__retry.release();void 0;");
      await wait(page,"window.__retry.rows[0].status==='queued'");
      await page.evaluate("queueClient.refresh()");
      const accepted=await page.evaluate(`({draft:promptInput.value,ids:[...jobs.keys()],source:window.__retryRaw,
        status:document.querySelector('details[data-job-id=eligible]').dataset.status,
        stages:[...document.querySelectorAll('details[data-job-id=eligible] [data-stage-id]')].map(node=>node.dataset.state)})`);
      assert.equal(accepted.draft,draftBefore);assert.equal(accepted.ids.filter(id=>id==='eligible').length,1);
      assert.equal(accepted.source,raw);assert.equal(accepted.status,"queued");
      assert.deepEqual(accepted.stages,["pending","pending","pending","pending"]);
    });
    await check("keyboard retry does not submit the quick draft and polling keeps the new focus",async page=>{
      await page.evaluate(`window.__retry.mode='waiting';promptInput.value='Следующий отдельный черновик';document.querySelector(${JSON.stringify(buttonSelector)}).focus();`);
      page.win.webContents.focus();await key(page,"Enter");
      await wait(page,"window.__retry.posts.length===1&&typeof window.__retry.release==='function'");
      await page.evaluate("document.querySelector('details[data-job-id=complete] summary').focus();window.__keptFocus=document.activeElement;queueClient.refresh()");
      assert.equal(await page.evaluate("document.activeElement===window.__keptFocus"),true);
      await page.evaluate("window.__retry.release();void 0;");
      await wait(page,"window.__retry.rows[0].status==='queued'");
      await page.evaluate("queueClient.refresh()");
      const result=await page.evaluate("({enqueues:window.__retry.enqueues.length,draft:promptInput.value,focus:document.activeElement===window.__keptFocus,posts:window.__retry.posts.length})");
      assert.deepEqual(result,{enqueues:0,draft:"Следующий отдельный черновик",focus:true,posts:1});
    });
    for(const code of ["retry_target_changed","retry_target_busy","retry_request_conflict","retry_not_allowed","retry_pending","retry_unsupported"]){
      await check(`safe ${code} rejection preserves the draft and saved source`,async page=>{
        await page.evaluate(`window.__retry.mode='reject';window.__retry.rejectCode=${JSON.stringify(code)};promptInput.value='Несохранённый черновик';
          document.querySelector(${JSON.stringify(buttonSelector)}).click();`);
        await wait(page,"window.__retry.posts.length>0&&document.querySelector('details[data-job-id=eligible]').dataset.retryState!=='submitting'");
        const result=await page.evaluate(`({text:document.body.textContent,draft:promptInput.value,source:window.__retryRaw,
          posts:window.__retry.posts.length,enqueues:window.__retry.enqueues.length,status:jobs.get('eligible').status,
          message:document.querySelector('details[data-job-id=eligible] .quick-retry-message').textContent,
          state:document.querySelector('details[data-job-id=eligible]').dataset.retryState,
          disabled:document.querySelector(${JSON.stringify(buttonSelector)}).disabled})`);
        assert.equal(result.draft,"Несохранённый черновик");assert.equal(result.source,raw);assert.equal(result.posts,1);
        assert.equal(result.enqueues,0);assert.equal(result.status,"completed");assert(result.message.trim());
        assert(!result.text.includes("INTERNAL_UNSAFE_RETRY_DETAIL"));
        const expected=code==='retry_pending'?'queued':code==='retry_target_busy'?'failed':'conflict';
        assert.equal(result.state,expected);assert.equal(result.disabled,code!=='retry_target_busy');
        if(code==='retry_target_changed')assert(result.message.includes('изменена'));
        if(code==='retry_target_busy'){
          assert(result.message.includes('занят'));
          await page.evaluate(`window.__retry.mode='normal';document.querySelector(${JSON.stringify(buttonSelector)}).click();`);
          await wait(page,"window.__retry.rows[0].status==='queued'");
          const keys=await page.evaluate("window.__retry.posts.map(post=>post.body.client_request_id)");
          assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);
        }
      });
    }
    await check("failed-stage reasons use safe codes and never display upstream messages",async page=>{
      const cases=[['context_budget_exceeded','лимит обработки'],['links_reranker_source_too_long','лимит оценщика'],
        ['links_reranker_window_budget_exceeded','объём текста']];
      for(const [code,expected] of cases){
        await page.evaluate(`window.__retry.rows[0].processing_error={code:'generation_failed',detail_code:${JSON.stringify(code)},message:'INTERNAL_UNSAFE_RETRY_DETAIL'};queueClient.refresh();`);
        const message=await page.evaluate("document.querySelector('details[data-job-id=eligible] .quick-job-error').textContent");
        assert(message.includes(expected),message);assert(!message.includes('INTERNAL_UNSAFE_RETRY_DETAIL'));
      }
      await page.evaluate("window.__retry.rows[0].processing_error={code:'INTERNAL_UNSAFE_RETRY_DETAIL',detail_code:'unsafe-unknown',message:'INTERNAL_UNSAFE_RETRY_DETAIL'};queueClient.refresh()");
      assert.equal(await page.evaluate("document.body.textContent.includes('INTERNAL_UNSAFE_RETRY_DETAIL')"),false);
    });
    await check("unknown transport failure reuses its original retry key on explicit replay",async page=>{
      await page.evaluate(`window.__retry.mode='offline';document.querySelector(${JSON.stringify(buttonSelector)}).click();`);
      await wait(page,"window.__retry.posts.length===2&&document.querySelector('details[data-job-id=eligible]').dataset.retryState!=='submitting'");
      const original=await page.evaluate("window.__retry.posts[0].body.client_request_id");
      await page.evaluate(`window.__retry.mode='normal';document.querySelector(${JSON.stringify(buttonSelector)}).click();`);
      await wait(page,"window.__retry.rows[0].status==='queued'");
      const result=await page.evaluate("({keys:window.__retry.posts.map(post=>post.body.client_request_id),admitted:window.__retry.admitted,enqueues:window.__retry.enqueues.length,raw:window.__retryRaw})");
      assert(result.keys.length>=3);assert(result.keys.every(value=>value===original));
      assert.deepEqual(result.admitted,[original]);assert.equal(result.enqueues,0);assert.equal(result.raw,raw);
    });
    await check("polling reconciles an admitted retry whose acknowledgements were lost",async page=>{
      await page.evaluate(`window.__retry.mode='lost-ack';document.querySelector(${JSON.stringify(buttonSelector)}).click();`);
      await wait(page,"window.__retry.posts.length===2&&document.querySelector('details[data-job-id=eligible]').dataset.retryState!=='submitting'");
      await page.evaluate("queueClient.refresh()");
      const result=await page.evaluate(`({keys:window.__retry.posts.map(post=>post.body.client_request_id),admitted:window.__retry.admitted.length,
        status:jobs.get('eligible').status,summary:jobs.get('eligible').recovery_summary,enqueues:window.__retry.enqueues.length,
        button:document.querySelector(${JSON.stringify(buttonSelector)}).hidden})`);
      assert.equal(new Set(result.keys).size,1);assert.equal(result.admitted,1);assert.equal(result.status,"queued");
      assert.equal(result.summary.request_id,result.keys[0].replaceAll('-',''));assert.equal(result.enqueues,0);assert.equal(result.button,true);
    });
    await check("a late acknowledgement from the previous vault cannot replace the new library",async page=>{
      await page.evaluate(`window.__retry.mode='waiting';promptInput.value='Черновик текущего окна';document.querySelector(${JSON.stringify(buttonSelector)}).click();`);
      await wait(page,"typeof window.__retry.release==='function'");
      await page.evaluate(`window.__retry.vault='vault-b';window.__retry.rows=[{job_id:'new-vault-note',created_at:200,status:'completed',retry_available:false,
        processing_outcome:'completed',prompt_preview:'Новая библиотека',progress:null}];
        queueClient.refresh().catch(()=>{}).then(()=>queueClient.refresh());`);
      await page.evaluate("window.__retry.release();void 0;");
      await wait(page,"!document.querySelector('details[data-job-id=eligible]')");
      await page.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const result=await page.evaluate("({ids:[...jobs.keys()],draft:promptInput.value,enqueues:window.__retry.enqueues.length,text:document.body.textContent})");
      assert.deepEqual(result.ids,["new-vault-note"]);assert.equal(result.draft,"Черновик текущего окна");assert.equal(result.enqueues,0);
      assert(!result.text.includes("INTERNAL_UNSAFE_RETRY_DETAIL"));
    });
    await check("retry controls and safe stage errors are localized in English",async page=>{
      await page.evaluate("window.nodaI18n.setLanguage('en');window.quickCaptureView.refreshLanguage();void 0;");
      const before=await page.evaluate(`({label:document.querySelector(${JSON.stringify(buttonSelector)}).textContent,
        stage:document.querySelector('details[data-job-id=eligible] [data-stage-id=links]').getAttribute('aria-label')})`);
      assert(!/[А-Яа-яЁё]/.test(before.label+before.stage));assert(before.label.trim());assert(before.stage.includes("failed"));
      await page.evaluate(`window.__retry.mode='reject';window.__retry.rejectCode='retry_target_busy';document.querySelector(${JSON.stringify(buttonSelector)}).click();`);
      await wait(page,"window.__retry.posts.length>0&&document.querySelector('details[data-job-id=eligible]').dataset.retryState!=='submitting'");
      const message=await page.evaluate("document.querySelector('details[data-job-id=eligible] .quick-retry-message').textContent");
      assert(message.trim());assert(!/[А-Яа-яЁё]/.test(message));assert(!message.includes("INTERNAL_UNSAFE_RETRY_DETAIL"));
    });
    const clean={raw:'Проверить почту и новые заявки, затем подготовить следующий шаг.',onlyEligible:true,
      processingError:{code:'generation_failed',detail_code:'links_reranker_source_too_long'}};
    const captureRu=await fresh(clean);
    await capture(captureRu,'01-retry-eligible-ru.png');
    await captureRu.evaluate(`window.__retry.mode='waiting';document.querySelector(${JSON.stringify(buttonSelector)}).click();`);
    await wait(captureRu,"typeof window.__retry.release==='function'");
    await capture(captureRu,'02-retry-pending-ru.png');
    await captureRu.evaluate("window.__retry.release();void 0;");await wait(captureRu,"window.__retry.rows[0].status==='queued'");
    await captureRu.evaluate("queueClient.refresh()");await capture(captureRu,'03-retry-queued-ru.png');captureRu.win.destroy();
    const captureEn=await fresh({...clean,language:'en'});await capture(captureEn,'04-retry-eligible-en.png');captureEn.win.destroy();
    const captureConflict=await fresh(clean);
    await captureConflict.evaluate(`window.__retry.mode='reject';window.__retry.rejectCode='retry_target_changed';document.querySelector(${JSON.stringify(buttonSelector)}).click();`);
    await wait(captureConflict,"document.querySelector('details[data-job-id=eligible]').dataset.retryState==='conflict'");
    const conflictState=await captureConflict.evaluate(`({panelOpen:!document.getElementById('quick-queue-panel').hidden,
      rowOpen:document.querySelector('details[data-job-id=eligible]').open,
      message:document.querySelector('details[data-job-id=eligible] .quick-retry-message').textContent,
      retryHidden:document.querySelector(${JSON.stringify(buttonSelector)}).hidden})`);
    assert.equal(conflictState.panelOpen,true);assert.equal(conflictState.rowOpen,true);
    assert(conflictState.message.includes('изменена'));assert.equal(conflictState.retryHidden,true);
    fs.writeFileSync(path.join(output,'conflict-capture-state.json'),JSON.stringify(conflictState,null,2));
    await capture(captureConflict,'05-retry-target-changed-first-frame.png');
    await capture(captureConflict,'05-retry-target-changed-ru.png');captureConflict.win.destroy();
    fs.writeFileSync(path.join(output,"coverage.json"),JSON.stringify(coverage,null,2));
    const result={checks,blockedNetwork,electron:process.versions.electron,chrome:process.versions.chrome};
    fs.writeFileSync(path.join(output,"result.json"),JSON.stringify(result,null,2));process.stdout.write(JSON.stringify(result)+"\n");
    app.exit(checks.some(value=>value.status!=='pass')||blockedNetwork?1:0);
  } finally {for(const win of windows)if(!win.isDestroyed())win.destroy();}
}
run().catch(error=>{process.stderr.write(String(error.stack||error)+"\n");app.exit(1);});
