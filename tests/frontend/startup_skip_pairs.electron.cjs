"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app, BrowserWindow, ipcMain } = require("electron");
const root = path.resolve(__dirname, "../..");
const frontend = process.env.STARTUP_PAIR_FRONTEND_DIR || path.join(root, "frontend");
const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "profile"));
app.setPath("sessionData", path.join(output, "profile"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");
app.on("window-all-closed", () => {});
const defaults = { title: "qwen25_3b_mmarco", tags: "qwen35_4b_tev", links: "qwen35_4b_mmarco" };
const labels = { title: ["Заголовки", "Titles"], tags: ["Теги", "Tags"], links: ["Связи между заметками", "Note links"] };
const pairNames = {
  qwen25_3b_mmarco: "Qwen2.5-3B + mMARCO MiniLM CrossEncoder",
  qwen35_4b_tev: "Qwen3.5-4B + Tev1-0.8B",
  qwen35_4b_mmarco: "Qwen3.5-4B + mMARCO MiniLM CrossEncoder",
  title_alternative: "Qwen3.5-4B + mMARCO MiniLM CrossEncoder",
  tags_alternative: "Qwen2.5-3B + Tev1-0.8B",
  links_alternative: "Qwen2.5-3B + mMARCO MiniLM CrossEncoder",
};
const option = id => ({ id, label: pairNames[id], languages: ["ru", "en"], available: true });
const catalog = Object.entries(defaults).map(([id, pair]) => ({ id, recommendedId: pair, options: [option(pair), option(`${id}_alternative`)] }));
const checks = [], captures = [], coverage = [];
let blocked = 0;
const sourceFiles = ["startup_model_picker.js", "startup_pair_skip.js", "startup_note_download.js",
  "note_model_download.js", "note_pair_selection.js", "desktop_settings.js", "main.js"];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(name => [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "frontend", name))).digest("hex")]));
const before = sourceHashes();

async function until(win, expression) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`DOM wait failed: ${expression}`);
}

async function runCase(language, stageIds, suffix, corrupted, exercise) {
  const submitted = [];
  let finish, failDownload, allowSave = false;
  const pending = new Promise(resolve => { finish = resolve; });
  let status = { state: "model-select", phase: "model-select", language, notePipeline: {
    catalog: exercise ? catalog.map(entry => entry.id !== "links" ? entry : {
      ...entry, options: entry.options.map(pair => ({ ...pair, available: false })),
    }) : catalog,
    selection: corrupted ? corrupted.value : defaults, configured: suffix !== "full", startupStageIds: stageIds,
  } };
  const win = new BrowserWindow({ width: 1100, height: 800, show: false, transparent: true, backgroundColor: "#00000000",
    webPreferences: { preload: path.join(frontend, "preload.js"), contextIsolation: true,
      nodeIntegration: false, sandbox: true, offscreen: true,
      partition: `startup-skip-${language}-${suffix}`, additionalArguments: [`--noda-language=${language}`] } });
  const evaluate = script => win.webContents.executeJavaScript(script);
  win.webContents.session.webRequest.onBeforeRequest(({ url }, callback) => {
    const allowed = /^(file|data|about):/.test(url);
    if (!allowed) blocked += 1;
    callback({ cancel: !allowed });
  });
  const handlers = {
    "get-startup-status": () => status,
    "ensure-backend": () => pending,
    "startup-renderer-ready": () => ({ ok: true }),
    "complete-startup": () => ({ ok: true }),
    "apply-startup-note-pairs": (event, selection) => {
      assert.equal(event.sender, win.webContents);
      submitted.push(structuredClone(selection));
      if (suffix === "model-download" && submitted.length === 1) {
        const report = noteModelDownload => win.webContents.send("quick-note:startup-status", { ...status, noteModelDownload });
        report({ model: "Qwen3.5-4B", bytes: 2_500_000_000, total: 8_000_000_000 });
        return new Promise(resolve => {
          failDownload = () => {
            report(null);
            resolve({ ok: false, downloadError: "network" });
          };
        });
      }
      if (!allowSave) return { ok: false };
      status = { language, state: "ready", phase: "ready" };
      win.webContents.send("quick-note:startup-status", status);
      finish({ ok: true });
      return { ok: true };
    },
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(`quick-note:${name}`, handler);
  const primary = "document.querySelector('.startup-pair-primary')";
  try {
    await win.loadURL("about:blank");
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Profiler.enable");
    await win.webContents.debugger.sendCommand("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    await win.loadFile(path.join(frontend, "startup.html"));
    await until(win, "document.querySelector('.startup-pair-primary')");
    assert.equal(await evaluate(`(() => {const footer=document.getElementById('app-support-footer'),rect=footer.getBoundingClientRect();
      return rect.height===32&&rect.bottom<=innerHeight&&document.getElementById('support-email').textContent==='tim@buglai.com'&&!document.getElementById('support-copy').textContent.trim();})()`), true);
    if (suffix === "tags") {
      const step = language === "en" ? "Application packages" : "Пакеты приложения";
      const count = language === "en" ? "Steps complete: 4 of 6" : "Готово этапов: 4 из 6";
      await evaluate(`window.startupGate.renderStatus({
        language: ${JSON.stringify(language)}, state: 'loading', phase: 'backend',
        detail: ${JSON.stringify(step)}, provisioning: { completed: 4, total: 6 },
      })`);
      assert.equal(await evaluate("document.getElementById('startup-provisioning').hidden"), false);
      assert.equal(await evaluate("document.getElementById('startup-provisioning-detail').textContent"), step);
      assert.equal(await evaluate("document.getElementById('startup-provisioning-count').textContent"), count);
      assert.deepEqual(await evaluate("[document.getElementById('startup-provisioning-progress').value, document.getElementById('startup-provisioning-progress').max]"), [4, 6]);
      assert.equal(await evaluate("document.getElementById('startup-overlay').classList.contains('startup-icon-only')"), false);
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
      await evaluate(`window.startupGate.renderStatus({language:${JSON.stringify(language)},state:'loading',phase:'backend'})`);
      await until(win, "document.getElementById('startup-overlay').classList.contains('startup-icon-only')");
      assert.equal(await evaluate(`(() => {
        const footer=document.getElementById('app-support-footer'),overlay=document.getElementById('startup-overlay');
        return getComputedStyle(footer).display==='none' && footer.getBoundingClientRect().height===0
          && overlay.getBoundingClientRect().bottom===innerHeight;
      })()`), true, "The icon-only loader must not show support controls or reserve a footer strip");
      await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error("Loader frame not painted")),3000);
        win.webContents.once("paint",()=>{clearTimeout(timer);resolve()});
        win.webContents.invalidate();
      });
      const loaderCapture=`${language}-icon-only.png`;
      fs.writeFileSync(path.join(output, loaderCapture),(await win.webContents.capturePage()).toPNG());
      captures.push(loaderCapture);
      checks.push({ language, suffix: "icon-only-without-support-footer", status: "pass" });
      await evaluate(`window.startupGate.renderStatus(${JSON.stringify(status)})`);
      await until(win, "document.getElementById('app-support-footer').getBoundingClientRect().height===32");
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia",{features:[]});
      assert.equal(await evaluate("document.getElementById('startup-provisioning').hidden"), true);
      checks.push({ language, suffix: "real-provisioning-progress", status: "pass" });
    }
    if (exercise) {
      await exercise({ win, evaluate, submitted, language,
        approve: () => { allowSave = true; }, fail: () => failDownload() });
      checks.push({ language, stageIds, suffix, status: "pass", atomicCalls: submitted.length });
      return;
    }
    for (const [index, stage] of stageIds.entries()) {
      const state = await evaluate(`({heading:document.querySelector('.startup-pair-main h2').textContent,progress:document.querySelector('.model-select-footer > span:last-child').textContent,button:${primary}.textContent,groupCount:document.querySelectorAll('.note-pair-choices').length,rail:Array.from(document.querySelectorAll('.model-select-step strong'),item=>item.textContent)})`);
      assert.equal(state.heading, labels[stage][language === "en" ? 1 : 0]);
      assert.equal(state.progress, `${index + 1}/${stageIds.length}`);
      assert.equal(state.groupCount, 1);
      assert.deepEqual(state.rail.slice(2, -1), stageIds.map(id => labels[id][language === "en" ? 1 : 0]));
      if (index === stageIds.length - 1) assert.match(state.button, language === "en" ? /Save and continue/ : /Сохранить и продолжить/);
      if (suffix === "tags" && index === 0) {
        await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Fresh frame not painted")), 3000);
          win.webContents.once("paint", () => { clearTimeout(timer); resolve(); });
          win.webContents.invalidate();
        });
        const target = path.join(output, `tags-only-${language}.png`);
        fs.writeFileSync(target, (await win.webContents.capturePage()).toPNG());
        const selectedValue = await evaluate("document.querySelector('.note-pair-radio:checked').value");
        assert.equal(selectedValue, defaults.tags);
        captures.push({ file: target, language, stageIds, progress: "1/1", selectedValue });
      }
      if (!corrupted) await evaluate(`document.querySelector('input[value="${stage}_alternative"]').closest('label').click()`);
      if (index < stageIds.length - 1) await evaluate(`${primary}.click()`);
    }
    assert.deepEqual(submitted, []);
    const expected = corrupted ? { ...defaults } : { ...defaults, ...Object.fromEntries(stageIds.map(stage => [stage, `${stage}_alternative`])) };
    await evaluate(`${primary}.click();${primary}.click()`);
    await until(win, `!${primary}.disabled && document.getElementById('startup-model-status').textContent.includes(${JSON.stringify(language === "en" ? "Try again" : "Повторите попытку")})`);
    assert.deepEqual(submitted, [expected]);
    assert.equal(await evaluate("document.querySelector('.note-pair-radio:checked').value"), expected[stageIds.at(-1)]);
    allowSave = true;
    await evaluate(`${primary}.click()`);
    await until(win, "document.getElementById('startup-model-picker').hidden");
    assert.deepEqual(submitted, [expected, expected]);
    const measured = await win.webContents.debugger.sendCommand("Profiler.takePreciseCoverage");
    coverage.push({ language, stageIds, result: measured.result.filter(item => /startup_model_picker\.js$/.test(item.url)) });
    checks.push({ language, stageIds, suffix, status: "pass", fullSelectionPreserved: true, retainedOnFailure: true, atomicCalls: submitted.length });
  } finally {
    finish({ ok: false });
    for (const name of Object.keys(handlers)) ipcMain.removeHandler(`quick-note:${name}`);
    win.destroy();
  }
}

async function exerciseModelDownload({ win, evaluate, submitted, language, approve, fail }) {
  const english = language === "en";
  const popup = "document.getElementById('startup-note-download')";
  const primary = "document.querySelector('.startup-pair-primary')";
  await evaluate(`${primary}.click()`);
  await until(win, `!${popup}.hidden`);
  assert.equal(await evaluate(`${primary}.disabled`), true);
  assert.equal(await evaluate("document.getElementById('startup-note-download-model').textContent"), "Qwen3.5-4B");
  assert.equal(await evaluate("document.getElementById('startup-note-download-percent').textContent"), "31%");
  assert.equal(await evaluate("document.getElementById('startup-note-download-size').textContent"),
    english ? "2.5 / 8 GB" : "2,5 / 8 ГБ");
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const target = path.join(output, `model-download-${language}.png`);
  fs.writeFileSync(target, (await win.webContents.capturePage()).toPNG());
  captures.push({ file: target, language, state: "model-download" });
  fail();
  await until(win, `${popup}.hidden && !${primary}.disabled`);
  assert.match(await evaluate("document.getElementById('startup-model-status').textContent"),
    english ? /Check your connection/ : /Проверьте подключение/);
  approve();
  await evaluate(`${primary}.click()`);
  await until(win, "document.getElementById('startup-model-picker').hidden");
  assert.deepEqual(submitted, [defaults, defaults]);
}

async function exerciseExplicitSkips({ win, evaluate, submitted, language, approve }) {
  const english = language === "en";
  const dialog = "document.getElementById('startup-pair-skip-dialog')";
  const skip = "document.querySelector('.startup-pair-skip')";
  const primary = "document.querySelector('.startup-pair-primary')";
  const click = target => evaluate(`${target}.click()`);
  const ask = async (stage) => {
    await evaluate(`${skip}.focus(); ${skip}.click()`);
    assert.equal(await evaluate(`${dialog}.open`), true);
    assert.equal(await evaluate("document.activeElement.value"), "cancel");
    assert.equal(await evaluate("document.getElementById('startup-pair-skip-question').textContent"),
      english ? "Continue?" : "Продолжить?");
    assert.match(await evaluate("document.getElementById('startup-pair-skip-warning').textContent"), {
      title: /28/,
      tags: english ? /nor create new/ : /или создавать новые/,
      links: english ? /link new notes/ : /связывать новые заметки/,
    }[stage]);
  };
  const capture = async name => {
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const target = path.join(output, `${name}-${language}.png`);
    fs.writeFileSync(target, (await win.webContents.capturePage()).toPNG());
    captures.push({ file: target, language, state: name });
  };
  await capture("startup-title");
  await ask("title");
  await capture("skip-title");
  await click(`${dialog}.querySelector('[value="cancel"]')`);
  assert.equal(await evaluate(`!${dialog}.open && document.activeElement === ${skip}`), true);
  await ask("title");
  await click(`${dialog}.querySelector('[value="skip"]')`);
  assert.equal(await evaluate("document.querySelector('.model-select-step.skipped strong').textContent"), labels.title[english ? 1 : 0]);
  if (english) {
    await click("document.querySelector('.startup-pair-back')");
    assert.match(await evaluate(`${primary}.textContent`), /Enable stage/);
    await click(primary);
    assert.equal(await evaluate("document.querySelector('.model-select-step.skipped')"), null);
  }
  await capture("startup-tags");
  await ask("tags");
  await capture("skip-tags");
  await click(`${dialog}.querySelector('[value="skip"]')`);
  await capture("startup-links");
  await ask("links");
  assert.equal(await evaluate(`${primary}.disabled && !${skip}.disabled`), true);
  assert.equal(submitted.length, 0);
  await capture("skip-links");
  await click(`${dialog}.querySelector('[value="skip"]')`);
  const expected = { ...defaults, stageEnabled: { title: english, tags: false, links: false } };
  await until(win, `!${skip}.disabled && document.getElementById('startup-model-status').textContent.includes(${JSON.stringify(english ? "Try again" : "Повторите попытку")})`);
  assert.deepEqual(submitted, [expected]);
  assert.match(await evaluate(`${primary}.textContent`), english ? /Enable stage/ : /Включить этап/);
  approve();
  await ask("links");
  await click(`${dialog}.querySelector('[value="skip"]')`);
  await until(win, "document.getElementById('startup-model-picker').hidden");
  assert.deepEqual(submitted, [expected, expected]);
}

app.whenReady().then(async () => {
  for (const language of ["ru", "en"]) {
    await runCase(language, ["tags"], "tags");
    await runCase(language, ["title", "links"], "mixed");
    await runCase(language, ["title", "tags", "links"], "full");
    await runCase(language, ["title", "tags", "links"], "explicit-skips", null, exerciseExplicitSkips);
    await runCase(language, ["tags"], "model-download", null, exerciseModelDownload);
  }
  for (const [name, value] of [["array", ["bad"]], ["extra", { ...defaults, unrelated: "bad" }], ["null", null]]) {
    await runCase("ru", ["title", "tags", "links"], `corrupt-${name}`, { value });
  }
  fs.writeFileSync(path.join(output, "coverage.json"), JSON.stringify(coverage, null, 2));
  const after = sourceHashes();
  fs.writeFileSync(path.join(output, "source-hashes.json"), JSON.stringify({ before, after }, null, 2));
  assert.deepEqual(after, before, "source files must remain frozen during native QA");
  const result = { checks, captures, blocked, network_allowed: false, electron: process.versions.electron };
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  app.exit(0);
}).catch(error => {
  fs.writeFileSync(path.join(output, "failure.json"), JSON.stringify({ message: error.message, stack: error.stack, checks }, null, 2));
  console.error(error);
  app.exit(1);
});
