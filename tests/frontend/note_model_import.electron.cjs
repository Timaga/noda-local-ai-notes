"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const frontend = process.env.STARTUP_PAIR_FRONTEND_DIR || path.resolve(__dirname, "../../frontend");
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "electron-profile-import"));
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

const generator = [{ id: "qwen25_3b", label: "Qwen2.5-3B", languages: ["ru", "en"] },
  { id: "qwen35_4b", label: "Qwen3.5-4B", languages: ["ru", "en"] }];
const reranker = [{ id: "mmarco", label: "mMARCO MiniLM CrossEncoder", languages: ["ru", "en"] },
  { id: "qwen", label: "Qwen3-Reranker-0.6B", languages: ["ru", "en"] }];
const tev = { id: "tev", label: "Tev1-0.8B", languages: ["ru", "en"] };
const newTagGenerator = { id: "qwen3_4b_instruct", label: "Qwen3-4B-Instruct-2507", languages: ["ru", "en"] };
const imported = { id: "hfg_bccb835f11282b53", label: "Qwen/Qwen2.5-0.5B-Instruct-GGUF · Q4_K_M",
  experimental: true, imported: true };
const importedReranker = { id: "hfr_1c21f89e5e4a70cd", label: "Example/Note-Reranker",
  experimental: true, imported: true };
const generatorUrl = "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF";
const rerankerUrl = "https://huggingface.co/Example/Note-Reranker";
const pinnedGenerator = `${generatorUrl}/resolve/${"a".repeat(40)}/weights.gguf`;
const pinnedReranker = `${rerankerUrl}/resolve/${"a".repeat(40)}/model.safetensors`;
const first = { id: "qwen25_3b_mmarco", label: "Qwen2.5-3B + mMARCO MiniLM CrossEncoder", languages: ["ru", "en"] };
const other = { id: "qwen35_4b_qwen", label: "Qwen3.5-4B + Qwen3-Reranker-0.6B", languages: ["ru", "en"] };
const tagPair = { ...first, id: "qwen35_4b_tev", label: "Qwen3.5-4B + Tev1-0.8B" };
const linkPair = { ...first, id: "qwen35_4b_mmarco", label: "Qwen3.5-4B + mMARCO MiniLM CrossEncoder" };
const newTagPair = { ...first, id: "qwen3_4b_instruct_qwen", label: "Qwen3-4B-Instruct-2507 + Qwen3-Reranker-0.6B" };
const stage = (id, recommended, components = { generator, reranker }) =>
  ({ id, recommendedId: recommended.id, options: [recommended, other], components });
const pipeline = {
  enabled: true, configured: true,
  catalog: [stage("title", first), stage("tags", tagPair, { generator, reranker: [tev, ...reranker] }), stage("links", linkPair)],
  selection: { title: first.id, tags: tagPair.id, links: linkPair.id },
  startupStageIds: ["title", "tags", "links"],
  stageEnabled: { title: true, tags: true, links: true },
  downloadFreeBytes: 30_000_000_000,
  newTags: {
    recommendedId: newTagPair.id, options: [newTagPair],
    components: { generator: [newTagGenerator], reranker }, enabled: false, pairId: newTagPair.id,
  },
};
for (const [model, bytes] of [[generator[0], 3e9], [generator[1], 2e9], [reranker[0], 1e9], [tev, 5e8]]) {
  model.downloaded = false;
  model.download_bytes = bytes;
}

async function until(evaluate, condition) {
  for (let i = 0; i < 200; i += 1) {
    if (await evaluate(`Boolean(${condition})`)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const status = await evaluate("document.querySelector('#settings-status')?.textContent || ''");
  throw new Error(`Unmet condition: ${condition}. ${status}`);
}

async function capture(win, name) {
  if (process.argv.includes("--verify-only")) return;
  await win.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("No fresh offscreen frame")), 3000);
    win.webContents.once("paint", () => { clearTimeout(timeout); resolve(); });
    win.webContents.invalidate();
  });
  fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG());
}

async function exercise(language, settings) {
  const win = new BrowserWindow({ width: settings ? 1440 : 1100, height: settings ? 960 : 870, show: false,
    webPreferences: { preload: path.join(frontend, "preload.js"), contextIsolation: true,
      nodeIntegration: false, sandbox: true, offscreen: true, partition: `import-${language}-${settings}`,
      additionalArguments: [`--noda-language=${language}`] } });
  win.webContents.session.webRequest.onBeforeRequest(({ url }, callback) =>
    callback({ cancel: !/^(file|data|about):/.test(url) }));
  const evaluate = script => win.webContents.executeJavaScript(script);
  let finish, attempts = 0, inspections = 0;
  let submittedStartupPairs;
  let settingsSaves = 0, pairSaves = 0;
  const settingsPipeline = structuredClone(pipeline);
  settingsPipeline.selection.title = linkPair.id;
  for (const stage of [...settingsPipeline.catalog, settingsPipeline.newTags]) {
    for (const model of [...stage.components.generator, ...stage.components.reranker]) {
      model.downloaded = !["qwen25_3b", "qwen"].includes(model.id);
      if (model.downloaded) model.download_bytes = 0;
    }
  }
  const settingsPayload = () => ({ ok: true, settings: { theme: "classic-blue" }, models: [],
    turboquantCapability: { supported: false }, runtime: { note_pipeline: settingsPipeline } });
  const handlers = {
    "get-startup-status": () => settings ? { phase: "ready", state: "ready", language, progress: 100 }
      : { phase: "model-select", state: "model-select", language, notePipeline: { ...pipeline, configured: false } },
    "ensure-backend": () => settings ? { ok: true } : new Promise(() => {}),
    "startup-renderer-ready": () => ({ ok: true }),
    "get-projects": () => ({ ok: true, mode: "legacy", status: "ready", projects: [],
      context: null, activeProjectId: null, activeProject: null }),
    "get-app-settings": settingsPayload,
    "save-app-settings": (_event, next) => {
      settingsSaves += 1;
      const payload = settingsPayload();
      Object.assign(payload.settings, next);
      return payload;
    },
    "apply-settings-note-pairs": async (event, selection) => {
      assert.equal(event.sender, win.webContents);
      assert.equal(selection.title, "qwen25_3b_qwen");
      pairSaves += 1;
      event.sender.send("quick-note:settings-note-download-progress", {
        model: "Qwen2.5-3B", bytes: 3, total: 4,
      });
      const outcome = await new Promise(resolve => { finish = resolve; });
      if (!outcome) return { ok: false, downloadError: "network" };
      settingsPipeline.selection.title = selection.title;
      for (const model of [...settingsPipeline.catalog[0].components.generator, ...settingsPipeline.catalog[0].components.reranker]) {
        model.downloaded = true;
        model.download_bytes = 0;
      }
      return { ok: true, runtime: { note_pipeline: settingsPipeline } };
    },
    "apply-startup-note-pairs": (event, selection) => {
      assert.equal(event.sender, win.webContents);
      submittedStartupPairs = selection;
      return { ok: true };
    },
    "preview-note-model": (event, payload) => {
      assert.equal(event.sender, win.webContents);
      inspections += 1;
      if (payload.role === "generator") {
        assert.equal(payload.url, generatorUrl);
        return { ok: true, model: imported, url: pinnedGenerator, download_bytes: 491400032,
          disk_free_bytes: 30_000_000_000 };
      }
      assert.deepEqual(payload, { role: "reranker", url: rerankerUrl });
      return { ok: true, model: importedReranker, url: pinnedReranker, download_bytes: 491400032,
        disk_free_bytes: 30_000_000_000 };
    },
    "cancel-model-download": event => {
      assert.equal(event.sender, win.webContents);
      finish({ ok: false, code: "canceled" });
      return { ok: true };
    },
    "import-note-model": (event, payload) => {
      assert.equal(event.sender, win.webContents);
      assert.deepEqual(payload, attempts < 3
        ? { role: "generator", url: pinnedGenerator, id: imported.id }
        : { role: "reranker", url: pinnedReranker, id: importedReranker.id });
      attempts += 1;
      win.webContents.send("quick-note:note-model-import-progress", {
        state: "downloading", bytes: 368550024, total: 491400032,
      });
      return new Promise(resolve => { finish = resolve; });
    },
  };
  for (const [key, handler] of Object.entries(handlers)) ipcMain.handle(`quick-note:${key}`, handler);
  try {
    await win.loadFile(path.join(frontend, settings ? "notes.html" : "startup.html"));
    if (settings) {
      await until(evaluate, "!document.body.classList.contains('app-loading') && window.NodaProjectContext.snapshot().status === 'ready'");
      win.webContents.setZoomFactor(0.8);
      await evaluate("document.querySelector('#notes-settings-tab').click()");
      await until(evaluate, "document.querySelectorAll('.note-component-fields').length === 4");
      await evaluate("document.querySelector('#settings-note-pairs-section').scrollIntoView({block:'start',behavior:'instant'})");
      await capture(win, "settings-components-ru.png");
      const experimental = "#settings-note-pairs-picker-new-tags-reranker";
      assert.equal(await evaluate(`document.querySelector('${experimental}').value`), "qwen");
      assert.equal(await evaluate(`document.querySelector('${experimental}').matches(':disabled')`), true);
      await evaluate("document.querySelector('#settings-note-pairs-apply').scrollIntoView({block:'end',behavior:'instant'})");
      await capture(win, "settings-new-tags-ru.png");
      const title = "#settings-note-pairs-picker-title";
      const warning = `document.querySelector('${title}-download').textContent`;
      const progress = "document.querySelector('#settings-note-pairs-progress')";
      const status = "document.querySelector('#settings-note-pairs-status')";
      assert.equal(await evaluate(warning), "");
      await evaluate(`for (const [role, value] of [['generator', 'qwen25_3b'], ['reranker', 'qwen']]) {
        const input = document.querySelector('${title}-' + role);
        input.value = value;
        input.dispatchEvent(new Event('change', {bubbles:true}));
      }`);
      assert.match(await evaluate(warning), /скачает Qwen2\.5-3B, Qwen3-Reranker-0\.6B/);
      assert.equal(pairSaves, 0);
      await evaluate("document.querySelector('#settings-note-pairs-section').scrollIntoView({block:'start',behavior:'instant'})");
      await capture(win, "settings-model-download-warning.png");
      await evaluate("document.querySelector('#settings-save').click()");
      await until(evaluate, `!${progress}.hidden && ${progress}.value === 75`);
      assert.equal(await evaluate("document.querySelector('#settings-note-pairs-apply').disabled"), true);
      await evaluate("document.querySelector('#settings-note-pairs-apply').scrollIntoView({block:'center',behavior:'instant'})");
      await capture(win, "settings-model-download-progress.png");
      finish(false);
      await until(evaluate, `${progress}.hidden && ${status}.classList.contains('error')`);
      assert.match(await evaluate(`${status}.textContent`), /Проверьте интернет/);
      assert.equal(settingsSaves, 0);
      assert.equal(settingsPipeline.selection.title, linkPair.id);
      assert.match(await evaluate(warning), /скачает/);
      await evaluate("document.querySelector('#settings-note-pairs-apply').click()");
      await until(evaluate, `!${progress}.hidden && ${progress}.value === 75`);
      finish(true);
      await until(evaluate, `${progress}.hidden && ${status}.classList.contains('ok')`);
      assert.equal(pairSaves, 2);
      assert.equal(settingsPipeline.selection.title, "qwen25_3b_qwen");
      assert.equal(await evaluate(warning), "");
      return;
    }
    await until(evaluate, "document.querySelector('#startup-recommended-setup')");
    assert.match(await evaluate("document.querySelector('.startup-download-summary').textContent"),
      language === "ru" ? /6,5 ГБ.*30 ГБ/ : /6\.5 GB.*30 GB/);
    await capture(win, `startup-overview-${language}.png`);
    await evaluate("document.querySelector('#startup-recommended-setup').click()");
    await until(evaluate, "!document.querySelector('#startup-recommended-setup').disabled");
    assert.deepEqual(submittedStartupPairs, pipeline.selection);
    await evaluate("document.querySelector('#startup-skip-setup').click()");
    await until(evaluate, "!document.querySelector('#startup-skip-setup').disabled");
    assert.deepEqual(submittedStartupPairs, {
      ...pipeline.selection, stageEnabled: { title: false, tags: false, links: false },
    });
    await evaluate("document.querySelector('#startup-advanced-setup').click()");
    await until(evaluate, "document.querySelector('#startup-note-pairs-title-generator')");
    const select = id => `document.querySelector('#startup-note-pairs-title${id}')`;
    const downloadLabel = language === "ru" ? "Скачать из Hugging Face" : "Download from Hugging Face";
    assert.equal(await evaluate(`${select("")}.value`), first.id);
    assert.equal(await evaluate(`${select("-generator")}.value`), "qwen25_3b");
    assert.equal(await evaluate(`${select("-reranker")}.value`), "mmarco");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.note-component-add')].map(button => button.textContent)"),
      [downloadLabel, downloadLabel]);
    await capture(win, `startup-components-${language}.png`);
    win.setSize(900, 680);
    await until(evaluate, "innerWidth === 900 && innerHeight === 680");
    assert.equal(await evaluate(`[...document.querySelectorAll('.note-component-add, .startup-pair-skip')].every(button => {
      const bounds = button.getBoundingClientRect();
      return bounds.width > 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
    })`), true);
    await capture(win, `startup-compact-${language}.png`);
    win.setSize(1100, 870);
    await evaluate("document.querySelector('#startup-note-pairs-title-reranker + button').click()");
    assert.match(await evaluate("document.querySelector('.note-import-form .note-pair-description').textContent"),
      language === "ru" ? /любого размера/ : /any size/);
    await capture(win, `hf-reranker-import-${language}.png`);
    await evaluate("document.querySelector('.note-import-dialog').close()");
    await until(evaluate, "!document.querySelector('.note-import-dialog')");
    await evaluate(`${select("")}.value = '${other.id}'; ${select("")}.dispatchEvent(new Event('change',{bubbles:true}));`);
    assert.equal(await evaluate(`${select("-reranker")}.value`), "qwen");
    await evaluate("document.querySelector('#startup-note-pairs-title-generator + button').click()");
    assert.equal(await evaluate("document.activeElement.type"), "url");
    assert.match(await evaluate("document.querySelector('.note-import-form .note-pair-description').textContent"),
      language === "ru" ? /любого размера/ : /any size/);
    await capture(win, `hf-generator-import-${language}.png`);
    const submit = () => evaluate("document.querySelector('.note-import-form').requestSubmit()");
    const preview = async url => {
      await evaluate(`document.querySelector('.note-import-form input').value = ${JSON.stringify(url)}`);
      await submit();
      await until(evaluate, "!document.querySelector('.note-import-preview').hidden");
    };
    await preview(generatorUrl);
    assert.equal(attempts, 0);
    assert.equal(inspections, 1);
    assert.match(await evaluate("document.querySelector('.note-import-preview').textContent"), /491[,.]4/);
    await submit();
    await until(evaluate, "document.querySelector('.note-import-status').textContent.includes('75%')");
    await capture(win, `hf-import-progress-${language}.png`);
    finish({ ok: false, code: "integrity" });
    await until(evaluate, "document.querySelector('.note-import-status').dataset.state === 'error'");
    assert.equal(await evaluate(`${select("-generator")}.value`), "qwen35_4b");
    await submit();
    await until(evaluate, "document.querySelector('.note-import-status').textContent.includes('75%')");
    await evaluate("document.querySelector('.note-import-actions button[type=button]').click()");
    await until(evaluate, `document.querySelector('.note-import-status').textContent.includes(
      '${language === "ru" ? "остановлена" : "stopped"}')`);
    assert.equal(attempts, 2);
    await submit();
    await until(evaluate, "document.querySelector('.note-import-status').textContent.includes('75%')");
    finish({ ok: true, model: imported });
    await until(evaluate, `!document.querySelector('.note-import-dialog') && ${select("-generator")}.value === '${imported.id}'`);
    assert.equal(await evaluate(`${select("-reranker")}.value`), "qwen");
    assert.equal(await evaluate(`${select("")}.value`), "");
    await capture(win, `hf-import-selected-${language}.png`);
    await evaluate("document.querySelector('.startup-pair-primary').click()");
    const tags = "document.querySelector('#startup-note-pairs-tags-generator')";
    await until(evaluate, tags);
    assert.equal(await evaluate(`${tags}.value`), "qwen35_4b");
    assert.equal(await evaluate("document.querySelector('#startup-note-pairs-tags-reranker').value"), "tev");
    assert.ok(await evaluate(`[...${tags}.options].some(item => item.value === '${imported.id}')`));
    await capture(win, `startup-tags-components-${language}.png`);
    await evaluate("document.querySelector('.startup-pair-skip').click()");
    await until(evaluate, "document.querySelector('#startup-pair-skip-dialog').open");
    await evaluate("document.querySelector('#startup-pair-skip-dialog [value=skip]').click()");
    await until(evaluate, "document.querySelector('#startup-note-pairs-links-generator')");
    assert.equal(await evaluate("document.querySelector('#startup-note-pairs-links-generator').value"), "qwen35_4b");
    assert.equal(await evaluate("document.querySelector('#startup-note-pairs-links-reranker').value"), "mmarco");
    await capture(win, `startup-links-components-${language}.png`);
    await evaluate("document.querySelector('#startup-note-pairs-links-reranker + button').click()");
    await preview(rerankerUrl);
    await submit();
    await until(evaluate, "document.querySelector('.note-import-status').textContent.includes('75%')");
    finish({ ok: true, model: importedReranker });
    await until(evaluate, `!document.querySelector('.note-import-dialog') &&
      document.querySelector('#startup-note-pairs-links-reranker').value === '${importedReranker.id}'`);
    await evaluate("document.querySelector('.startup-pair-primary').click()");
    await until(evaluate, "!document.querySelector('.startup-pair-primary').disabled");
    assert.deepEqual(submittedStartupPairs, {
      title: `${imported.id}_qwen`, tags: tagPair.id, links: `qwen35_4b_${importedReranker.id}`,
      stageEnabled: { title: true, tags: false, links: true },
    });
  } finally {
    for (const key of Object.keys(handlers)) ipcMain.removeHandler(`quick-note:${key}`);
    win.destroy();
  }
}

app.whenReady().then(async () => {
  await exercise("ru", false);
  await exercise("en", false);
  await exercise("ru", true);
  console.log("PASS startup RU/EN import, progress, retry, role isolation, shared catalog, settings");
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
