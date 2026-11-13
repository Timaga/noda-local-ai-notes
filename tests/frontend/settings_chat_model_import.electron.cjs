"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const frontend = process.env.NODA_CHAT_PICKER_FRONTEND || path.resolve(__dirname, "../../frontend");
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "profile"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

const builtin = { id: "fixture", name: "Qwen2.5 7B Instruct", artifact: "gguf", quantization: "Q5_K_M", downloaded: true,
  estimated_download_gb: 5.44, min_memory_gb: 8, recommended_memory_gb: 12, recommended: true };
const imported = { id: "hfc_1234567890abcdef", name: "Demo/Chat-GGUF", gguf_filename: "chat-Q4_K_M.gguf", imported: true,
  estimated_download_gb: 4.6, min_memory_gb: 7, recommended_memory_gb: 10, artifact: "gguf", quantization: "Q4_K_M", downloaded: true };
const url = "https://huggingface.co/Demo/Chat-GGUF";
const pinned = `${url}/resolve/${"a".repeat(40)}/${imported.gguf_filename}`;
const catalog = [builtin, { ...builtin, id: "compact", name: "Qwen3 4B Instruct", quantization: "Q4_K_M", downloaded: false,
  estimated_download_gb: 2.5, min_memory_gb: 6, recommended_memory_gb: 8 },
{ ...builtin, id: "large", name: "Vikhr-Nemo 12B", quantization: "Q4_K_M", downloaded: false,
  estimated_download_gb: 7.5, min_memory_gb: 12, recommended_memory_gb: 18 }];

async function exercise(language) {
  let active = builtin.id, installed = false, finish, downloads = 0, choices = 0;
  let stockDownloaded = false, finishStock, stockRequests = 0;
  const snapshot = () => ({ ok: true, settings: { theme: "classic-blue", language },
    models: [...catalog, ...(installed ? [imported] : [])].map(model => ({
      ...model, active: model.id === active,
      ...(model.id === builtin.id && { configured: true, downloaded: stockDownloaded, ready: stockDownloaded }),
    })),
    activeModelId: active, hardware: { ramGb: 8, gpuMemoryGb: 4 }, turboquantCapability: { supported: false },
    runtime: { provider: "local", note_pipeline: { enabled: true } } });
  const win = new BrowserWindow({ width: 1320, height: 890, show: false,
    webPreferences: { preload: path.join(frontend, "preload.js"), contextIsolation: true, sandbox: true,
      offscreen: true, partition: `chat-picker-${language}`, additionalArguments: [`--noda-language=${language}`] } });
  win.webContents.session.webRequest.onBeforeRequest(({ url: target }, respond) => respond({ cancel: !/^(file|data|about):/.test(target) }));
  const handlers = {
    "get-startup-status": () => ({ ok: true, phase: "ready", state: "ready", progress: 100 }),
    "ensure-backend": () => ({ ok: true }),
    "get-projects": () => ({ ok: true, mode: "legacy", status: "ready", projects: [], context: null, activeProjectId: null, activeProject: null }),
    "get-app-settings": snapshot,
    "preview-chat-model": (_event, input) => {
      assert.deepEqual(input, { url });
      return { ok: true, model: imported, url: pinned, download_bytes: 4_600_000_000 };
    },
    "download-chat-model": (event, input) => {
      assert.deepEqual(input, { url: pinned, id: imported.id });
      downloads += 1;
      event.sender.send("quick-note:chat-model-import-progress", { state: "downloading", bytes: 23, total: 46 });
      return new Promise(resolve => { finish = () => { installed = true; resolve({ ok: true, model: imported }); }; });
    },
    "apply-settings-model": (event, input) => {
      if (input.model_id === builtin.id) {
        stockRequests += 1;
        event.sender.send("quick-note:settings-model-progress", {
          state: "loading", download: { bytes: 1_000_000_000, total: 4_000_000_000 },
        });
        return new Promise(resolve => { finishStock = (canceled = false) => {
          if (!canceled) stockDownloaded = true;
          resolve(canceled ? { ok: false, canceled: true } : snapshot());
        }; });
      }
      assert.deepEqual(input, { model_id: imported.id });
      choices += 1;
      active = imported.id;
      return snapshot();
    },
    "cancel-model-download": () => {
      finishStock(true);
      return { ok: true };
    },
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`quick-note:${name}`, handler);
  const run = script => win.webContents.executeJavaScript(script);
  const selector = id => `document.querySelector(${JSON.stringify(id)})`;
  const click = id => run(`${selector(id)}.click()`);
  async function until(condition) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (await run(`Boolean(${condition})`)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Condition not met: ${condition}`);
  }
  async function capture(name) {
    await run("new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No painted frame")), 3000);
      win.webContents.once("paint", () => { clearTimeout(timer); resolve(); });
      win.webContents.invalidate();
    });
    fs.writeFileSync(path.join(output, `${name}-${language}.png`), (await win.webContents.capturePage()).toPNG());
  }
  try {
    await win.loadFile(path.join(frontend, "notes.html"));
    await until("!document.body.classList.contains('app-loading') && window.NodaProjectContext.snapshot().status === 'ready'");
    await until("getComputedStyle(document.querySelector('#startup-overlay')).opacity === '0'");
    await click("#notes-settings-tab");
    await until("!document.getElementById('settings-model-open').disabled && document.getElementById('settings-model-name').textContent.includes('Qwen')");
    await click("#settings-model-open");
    await until(selector(".settings-picker-search"));
    assert.equal(await run(`document.activeElement === ${selector(".settings-picker-search")}`), true);
    assert.equal(await run(`${selector(".settings-picker-choose")}.disabled`), false);
    assert.match(await run(`${selector(".settings-picker-choose")}.textContent`),
      language === "en" ? /Download and use/ : /Скачать и подключить/);
    await capture("chat-model-catalog");
    await click(".settings-picker-footer .settings-picker-choose");
    await until(`!${selector("#settings-switch-download-progress")}.hidden`);
    assert.equal(await run(`${selector("#settings-switch-download-progress")}.value`), 1_000_000_000);
    assert.equal(await run(`${selector("#settings-switch-stop-download")}.hidden`), false);
    await capture("chat-model-stock-download");
    await click("#settings-switch-stop-download");
    await until(`${selector("#settings-model-switch")}.hidden && !${selector("#settings-model-open")}.disabled`);
    assert.match(await run(`${selector("#settings-status")}.textContent`), language === "en" ? /Download stopped/ : /Загрузка остановлена/);
    assert.equal(stockDownloaded, false);
    await click("#settings-model-open");
    await click(".settings-picker-footer .settings-picker-choose");
    await until(`!${selector("#settings-switch-download-progress")}.hidden`);
    finishStock();
    await until(`${selector("#settings-model-switch")}.hidden && !${selector("#settings-model-open")}.disabled`);
    assert.equal(stockRequests, 2);
    assert.match(await run(`${selector("#settings-model-badges")}.textContent`), language === "en" ? /Ready/ : /Готова/);
    await click("#settings-model-open");
    assert.equal(await run(`${selector(".settings-picker-choose")}.disabled`), true);
    await click(".settings-picker-import");
    await until(selector(".settings-hf-dialog[open]"));
    assert.equal(await run("document.activeElement.id"), "settings-hf-url");
    await run(`${selector("#settings-hf-url")}.value=${JSON.stringify(url)}; ${selector(".settings-hf-dialog form")}.requestSubmit();`);
    await until(`!${selector(".settings-hf-result")}.hidden`);
    assert.equal(downloads, 0);
    assert.match(await run(`${selector(".settings-hf-result")}.textContent`), language === "en" ? /Borderline/ : /На грани/);
    await capture("chat-model-preview");
    await click(".settings-hf-dialog button[type=submit]");
    await until(`${selector(".settings-hf-dialog progress")}?.value === 50`);
    await capture("chat-model-download");
    finish();
    await until(`!${selector(".settings-hf-dialog")} && ${selector('.settings-picker-row[aria-pressed="true"]')}?.textContent.includes('Demo/Chat-GGUF')`);
    assert.equal(choices, 0);
    assert.equal(active, builtin.id);
    await capture("chat-model-imported");
    win.setSize(690, 680);
    await until("innerWidth < 730");
    assert.equal(await run(`${selector(".settings-model-picker")}.scrollWidth <= ${selector(".settings-model-picker")}.clientWidth`), true);
    assert.equal(await run(`getComputedStyle(${selector(".settings-picker-details")}).display !== 'none'`), true);
    await click(".settings-picker-footer .settings-picker-choose");
    await until(`${selector("#settings-model-modal")}.hidden && ${selector("#settings-model-name")}.textContent === 'Demo/Chat-GGUF'`);
    assert.equal(choices, 1);
  } finally {
    for (const name of Object.keys(handlers)) ipcMain.removeHandler(`quick-note:${name}`);
    win.destroy();
  }
}

app.whenReady().then(async () => {
  await exercise("ru");
  await exercise("en");
  console.log("PASS chat model catalog, stock model download, hardware estimate, Hugging Face import, persistence and selection (RU/EN)");
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
