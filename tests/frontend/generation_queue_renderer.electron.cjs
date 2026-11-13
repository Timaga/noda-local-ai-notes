const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
let app;
function fail(error) {
  process.stderr.write(`${String(error.stack || error).slice(0, 1800)}\n`);
  if (app) app.exit(1); else process.exit(1);
}
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

async function run() {
  const electron = require("electron");
  app = electron.app;
  if (!app) throw new Error("Electron must run without ELECTRON_RUN_AS_NODE");
  app.disableHardwareAcceleration();
  app.setPath("userData", process.argv[2]);
  app.setPath("sessionData", process.argv[2]);
  app.commandLine.appendSwitch("disable-background-networking");
  app.on("window-all-closed", () => {});
  await app.whenReady();
  electron.session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(file|data|about):/.test(details.url) });
  });
  const timeout = setTimeout(() => fail(new Error("DOM test timeout")), 45000);
  const workspace = path.resolve(__dirname, "../..");
  const html = fs.readFileSync(path.join(workspace, "frontend/index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace("<head>", `<head><base href="${pathToFileURL(path.join(workspace, "frontend/")).href}">`);
  const fixture = path.join(process.argv[2], "capture-fixture.html");
  fs.writeFileSync(fixture, html);
  async function loadWindow(initialProject) {
    const win = new electron.BrowserWindow({ show: false, width: 800, height: 230, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    await win.loadFile(fixture);
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, "generation_queue_renderer.fixture.js"), "utf8") + "\nvoid 0;");
    if (initialProject) {
      await win.webContents.executeJavaScript(`(() => {
        const projects = ["a", "b"].map(letter => ({id:letter.repeat(32),name:"Тестовый проект "+letter.toUpperCase(),
          notesDirectory:"C:/synthetic/"+letter,collectionName:"fixture-"+letter,legacy:false,noteCount:0}));
        const snapshot = letter => {
          const active = projects.find(item => item.id === letter.repeat(32));
          return {ok:true,mode:"projects",status:"ready",projects,activeProjectId:active.id,
            activeProject:{...active,legacyChatStorage:false},context:{project_id:active.id,context_token:active.id}};
        };
        window.quickNoteBridge.getProjects = async () => snapshot(${JSON.stringify(initialProject)});
        window.quickNoteBridge.onProjectState = receive => {window.__draftSwitch = letter => receive(snapshot(letter)); return () => {};};
        document.body.classList.replace("app-loading","app-ready");
        document.getElementById("startup-overlay").hidden = true;
        document.getElementById("startup-overlay").style.display = "none";
      })()`);
    }
    for (const name of ["ui_translations.js", "ui_languages.js", "i18n.js", "project_context.js", "generation_retry_client.js", "generation_queue_client.js", "quick_capture_view.js", "quick_capture_project.js", "renderer.js"]) {
      await win.webContents.executeJavaScript(fs.readFileSync(path.join(workspace, "frontend", name), "utf8"));
    }
    return win;
  }
  const phase = process.argv[3];
  if (phase === "write-draft" || phase === "read-draft") {
    const draft = "  Проверить список материалов\nи подготовить заметку к встрече  ";
    const win = await loadWindow(phase === "write-draft" ? "a" : "b");
    const execute = source => win.webContents.executeJavaScript(source);
    await execute("init().then(() => queueClient.stop())");
    if (phase === "write-draft") {
      await execute(`promptInput.value = ${JSON.stringify(draft)}; promptInput.dispatchEvent(new Event("input"));`);
      const { createQuickCaptureController } = require("../../frontend/quick_capture_window");
      createQuickCaptureController({ getWindow: () => win }).flushDraftStorage();
    } else {
      assert.equal(await execute("promptInput.value"), "");
      await execute("window.__draftSwitch('a')");
      assert.equal(await execute("promptInput.value"), draft);
      assert.match(await execute("document.getElementById('quick-active-project').textContent"), /Тестовый проект A/);
      assert.equal(await execute("window.__queueFixture.posts.length"), 0);
      await execute("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const screenshot = await win.webContents.capturePage();
      if (!screenshot.isEmpty()) fs.writeFileSync(path.join(process.argv[2], "restored-quick-draft.png"), screenshot.toPNG());
    }
    clearTimeout(timeout);
    process.stdout.write(JSON.stringify({ status: "passed", phase, electron: process.versions.electron }) + "\n");
    app.exit(0);
    return;
  }
  const results = [];
  for (let restart = 0; restart < 2; restart += 1) {
    const win = await loadWindow();
    results.push(await win.webContents.executeJavaScript(`runQueueDomTests(${restart})`));
    win.destroy();
  }
  clearTimeout(timeout);
  process.stdout.write(JSON.stringify({ status: "passed", restarts: results }) + "\n");
  app.exit(0);
}
run().catch(fail);
