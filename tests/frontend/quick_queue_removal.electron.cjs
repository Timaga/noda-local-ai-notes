"use strict";
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "../.."), out = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2] && !fs.existsSync(out), "Use a fresh explicit output directory"); fs.mkdirSync(out, { recursive: true });
app.setPath("userData", path.join(out, "profile")); app.setPath("sessionData", path.join(out, "profile"));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch("disable-background-networking");
const checks = [], errors = []; let network = 0, win;
const timeout = setTimeout(() => { fs.writeFileSync(path.join(out, "timeout.json"), JSON.stringify(checks)); app.exit(2); }, 45000);
function fixture() {
  const vault = "f".repeat(32), letters = ["a", "b", "c", "d", "e", "f"];
  const make = (letter, status, extra = {}) => ({ job_id: letter.repeat(32), created_at: 100 - letters.indexOf(letter), status,
    phase: status, prompt_preview: `Синтетическое задание ${letter}`, prompt_text: "Исходный текст без личных данных", ...extra });
  const state = window.__remove = { rows: [make("a", "queued"), make("b", "processing"),
    make("c", "completed", { processing_outcome: "completed", result: { title: "Созданная заметка", content: "Текст уже созданной заметки", tags: [], related: [] } }),
    make("d", "failed")], revision: 0, deletes: [], mode: "normal", confirm: true, confirmations: [], noteExists: true };
  state.add = letter => { state.rows.push(make(letter, "queued")); state.revision++; };
  const queue = () => ({ queued_count: state.rows.filter(row => row.status === "queued").length,
    processing_count: state.rows.filter(row => row.status === "processing").length, history_revision: state.revision, history_retention_days: 30 });
  window.confirm = message => { state.confirmations.push(message); return state.confirm; };
  window.quickNoteBridge = { getLanguage: () => "ru", getHotkey: async () => "Control+Shift+Space",
    getProjects: async () => ({ ok: true, mode: "legacy", status: "ready", projects: [], context: null, activeProjectId: null, activeProject: null }),
    onProjectState: () => () => {}, setQuickCaptureHeight: async () => ({}), ensureBackendReady: async () => ({ ok: true }) };
  window.startupGate = { waitForReady: async () => {} };
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url), method = options.method || "GET", id = parsed.pathname.split("/").at(-1);
    let payload, status = 200;
    if (method === "DELETE") {
      if (parsed.searchParams.get("expected_vault_id") !== vault) throw new Error("Unscoped removal");
      state.deletes.push(id);
      if (state.mode === "offline") throw new TypeError("Synthetic offline");
      if (state.mode === "busy") { status = 409; payload = { code: "job_busy", error: "Synthetic busy" };
        state.rows = state.rows.map(row => row.job_id === id ? { ...row, status: "processing" } : row); }
      else { state.rows = state.rows.filter(row => row.job_id !== id); state.revision++;
        payload = { success: true, removed: true, job_id: id, already_removed: false, history_revision: state.revision, queue: queue() }; }
    } else if (parsed.pathname === "/generate/enqueue") {
      const body = JSON.parse(options.body);
      payload = { job: { ...make("a", "failed"), removed: true, client_request_id: body.client_request_id }, queue: queue() }; status = 202;
    } else if (parsed.pathname === "/generate/jobs") payload = { jobs: state.rows, next_cursor: null, history_revision: state.revision };
    else if (parsed.pathname.startsWith("/generate/jobs/")) payload = { job: state.rows.find(row => row.job_id === id) };
    else if (parsed.pathname === "/generate/queue") payload = { queue: queue() };
    else if (parsed.pathname === "/runtime/config") payload = { provider: "local", runtime_model_id: "synthetic" };
    else throw new Error(`Unexpected synthetic request ${method} ${parsed.pathname}`);
    return new Response(JSON.stringify({ vault_id: vault, ...payload }), { status, headers: { "Content-Type": "application/json" } });
  };
}
async function run() {
  await app.whenReady(); session.defaultSession.webRequest.onBeforeRequest(({ url }, done) => {
    const local = /^(file|data|about):/.test(url); if (!local) network++; done({ cancel: !local });
  });
  const html = fs.readFileSync(path.join(root, "frontend/index.html"), "utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace("<head>", `<head><base href="${pathToFileURL(path.join(root, "frontend/")).href}">`);
  const file = path.join(out, "fixture.html"); fs.writeFileSync(file, html);
  win = new BrowserWindow({ width: 860, height: 900, show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.on("console-message", details => { if (details.level === "error") errors.push(String(details.message)); });
  await win.loadFile(file); const evaluate = source => win.webContents.executeJavaScript(source);
  await evaluate(`(${fixture.toString()})();document.body.classList.replace('app-loading','app-ready');document.getElementById('startup-overlay').hidden=true;void 0`);
  for (const name of ["ui_translations.js", "ui_languages.js", "i18n.js", "project_context.js", "generation_retry_client.js", "generation_queue_client.js", "quick_capture_view.js", "quick_capture_project.js", "renderer.js"]) {
    await evaluate(fs.readFileSync(path.join(root, "frontend", name), "utf8"));
  }
  await evaluate(`window.check=(value,message)=>{if(!value)throw new Error(message)};window.wait=async predicate=>{
    const end=performance.now()+6000;while(!predicate()){if(performance.now()>end)throw new Error('UI wait expired');await new Promise(r=>setTimeout(r,20));}};
    init().then(()=>{queueClient.stop();quickCaptureView.setQueueOpen(true);})`);
  const button = letter => `document.querySelector('[data-job-id="${letter.repeat(32)}"]').parentElement.querySelector('.quick-remove-button')`;
  const visible = letter => `document.querySelector('[data-job-id="${letter.repeat(32)}"]')`;
  async function check(name, body) { try { await body(); checks.push({ name, status: "pass" }); }
    catch (error) { checks.push({ name, status: "fail", error: String(error.stack || error) }); } }
  await check("queued and terminal entries have accessible compact removal controls; processing explains its disabled state", async () => {
    await evaluate(`check(document.querySelectorAll('.quick-remove-button').length===4,'missing removal controls');
      check(!${button("a")}.disabled&&${button("b")}.disabled,'wrong availability');
      check(${button("a")}.getAttribute('aria-label').includes('Удалить'),'missing accessible name');
      check(${button("b")}.title.includes('Дождитесь'),'disabled state unexplained');
      document.querySelector('[data-job-id="${"d".repeat(32)}"]').open=true`);
    await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    fs.writeFileSync(path.join(out, "01-queue-removal-ru.png"), (await win.webContents.capturePage()).toPNG());
  });
  await check("cancelling removal sends no request", async () => {
    await evaluate(`__remove.confirm=false;${button("a")}.click();check(__remove.deletes.length===0,'cancel sent DELETE');check(${visible("a")},'cancel hid job')`);
  });
  await check("queued removal updates the queue and preserves the current input", async () => {
    await evaluate(`(async()=>{promptInput.value='Черновик следующей заметки';promptInput.dispatchEvent(new Event('input'));__remove.confirm=true;
      ${button("a")}.click();await wait(()=>!${visible("a")});
      check(__remove.deletes.length===1,'duplicate DELETE');check(__remove.confirmations.at(-1).includes('не будет обработано'),'queued consequence omitted');
      check(promptInput.value==='Черновик следующей заметки','input changed');check(document.getElementById('queue-counter').textContent.includes('1'),'counter not updated');})()`);
  });
  await check("terminal removal preserves the note and clears a stale completion preview", async () => {
    await evaluate(`(async()=>{${button("c")}.click();await wait(()=>!${visible("c")});
      check(__remove.noteExists,'note removed');check(document.getElementById('note-preview').textContent==='','stale preview remained');
      check(__remove.confirmations.at(-1).includes('Файлы заметок сохранятся'),'note consequence unclear');})()`);
  });
  await check("a race with processing shows a stable actionable error and retains the entry", async () => {
    await evaluate(`(async()=>{__remove.add('e');await queueClient.refresh();__remove.mode='busy';${button("e")}.click();
      await wait(()=>${visible("e")}.textContent.includes('уже обрабатывается'));check(${visible("e")},'busy job lost');
      __remove.mode='normal';await queueClient.refresh();check(${button("e")}.disabled,'processing state not reconciled');})()`);
  });
  await check("a failed removal keeps source and permits an explicit retry", async () => {
    await evaluate(`(async()=>{await queueClient.detail('${"d".repeat(32)}');__remove.mode='offline';${button("d")}.click();await wait(()=>${visible("d")}.textContent.includes('Не удалось подтвердить'));
      check(!${button("d")}.disabled,'retry unavailable');check(${visible("d")}.textContent.includes('Исходный текст'),'source lost');
      __remove.mode='normal';${button("d")}.click();await wait(()=>!${visible("d")});})()`);
  });
  await check("removal names and disabled explanations follow the selected language", async () => {
    await evaluate(`window.nodaI18n.setLanguage('en');quickCaptureView.refreshLanguage();check(${button("b")}.title.startsWith('Processing is in progress'),'disabled label not translated');
      __remove.add('f');queueClient.refresh()`);
    await evaluate(`check(${button("f")}.getAttribute('aria-label')==='Remove job from queue','delete label not translated')`);
    fs.writeFileSync(path.join(out, "02-queue-removal-en.png"), (await win.webContents.capturePage()).toPNG());
  });
  await check("a removed enqueue receipt preserves the user's input and does not restore the removed row", async () => {
    await evaluate(`(async()=>{promptInput.value='Saved input after removed receipt';promptInput.dispatchEvent(new Event('input'));
      await queueClient.enqueue(promptInput.value,'local','organize');check(promptInput.value==='Saved input after removed receipt','removed receipt cleared input');
      check(!${visible("a")},'removed receipt restored a row');check(document.getElementById('quick-announcement').textContent.includes('Your input was kept'),'receipt outcome unclear');})()`);
  });
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ checks, errors, network, electron: process.versions.electron }, null, 2));
  clearTimeout(timeout); win.destroy(); app.exit(checks.some(item => item.status !== "pass") || errors.length || network ? 1 : 0);
}
run().catch(error => { clearTimeout(timeout); fs.writeFileSync(path.join(out, "harness-error.txt"), String(error.stack || error)); app.exit(1); });
