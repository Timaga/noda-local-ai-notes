const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repo = path.resolve(__dirname, "../..");
const output = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "noda-notes-scroll-")));
const rendererRoot = path.resolve(process.argv[3] || repo);
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "profile"));
app.setPath("sessionData", path.join(output, "profile"));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-background-networking");

async function run() {
  await app.whenReady();
  let networkRequests = 0;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const local = /^(?:file|about|data):/.test(details.url);
    if (!local) networkRequests += 1;
    callback({ cancel: !local });
  });
  const window = new BrowserWindow({
    width: 1440, height: 960, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  const html = fs.readFileSync(path.join(repo, "frontend/notes.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace("<head>", `<head><base href="${pathToFileURL(path.join(repo, "frontend/")).href}">`);
  const fixture = path.join(output, "fixture.html");
  fs.writeFileSync(fixture, html);
  await window.loadFile(fixture);
  window.webContents.debugger.attach("1.3");
  await window.webContents.debugger.sendCommand("Profiler.enable");
  await window.webContents.debugger.sendCommand("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  for (const file of ["frontend/project_context.js", "frontend/node_modules/marked/marked.min.js", "frontend/notes_markdown.js", "frontend/notes_list_view.js", "frontend/notes_live_application.js", "frontend/notes_live_sync.js", "frontend/notes_note_actions.js", "frontend/notes_library_tools.js", "frontend/notes_renderer.js"]) {
    const root = file.endsWith("notes_renderer.js") ? rendererRoot : repo;
    await window.webContents.executeJavaScript(`${fs.readFileSync(path.join(root, file), "utf8")}\n//# sourceURL=noda-test://${file}`);
  }
  await window.webContents.executeJavaScript(`
    document.body.classList.remove("app-loading");
    document.getElementById("startup-overlay").hidden = true;
    document.documentElement.dataset.theme = "classic-blue";
    window.__scrollResults = [];
    window.__scrollAssert = (condition, message) => { if (!condition) throw new Error(message); };
    window.__scrollCheck = async (name, run) => {
      try { const detail = await run(); window.__scrollResults.push({ name, status: "pass", detail }); }
      catch (error) { window.__scrollResults.push({ name, status: "fail", error: error.message }); }
    };
    window.__scrollFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
    window.__scrollWaitForTitle = async title => {
      const deadline = performance.now() + 3000;
      while (noteViewTitle.textContent !== title) {
        if (performance.now() > deadline) throw new Error("selected detail did not arrive");
        await window.__scrollFrame();
      }
      await window.__scrollFrame();
    };
    window.__scrollFakeResponse = title => ({ ok: true, status: 200, json: async () => ({
      title, content: title + "\\n\\nЭто синтетическая заметка для проверки прокрутки. Рабочая база не используется.",
      tags: ["проверка"], indexed: true, timestamp: "2026-11-05T09:00:00Z",
    }) });
    window.__scrollReset = () => {
      notes = Array.from({ length: 100 }, (_, index) => ({
        title: "Заметка " + String(index + 1).padStart(3, "0"),
        snippet: "Синтетическая запись: план работ, вопросы и следующий шаг. Проверяем сохранение места в списке.",
        tags: index % 2 ? ["проверка", "план"] : [], indexed: index % 3 !== 0,
        timestamp: new Date(Date.UTC(2026, 10, 5, 10) - index * 60000).toISOString(),
      }));
      selectedNoteTitle = ""; selectedNoteDetail = null; activeNotesFilter = "all";
      notesSearch.value = ""; notesSortSelect.value = "newest";
      window.fetch = async url => window.__scrollFakeResponse(decodeURIComponent(url.split("/").pop()));
      qdrantInfo = { available: true }; renderQdrantState(); setActiveNotesFilter("all"); setEditorMode(false);
    };
    window.__scrollPosition = index => {
      const button = notesList.querySelectorAll(".note-list-button")[index];
      button.scrollIntoView({ block: "center" }); button.focus({ preventScroll: true });
      return button;
    };
    window.__scrollReset();
  `);

  const middle = await window.webContents.executeJavaScript(`(async () => {
    window.__scrollTarget = window.__scrollPosition(45);
    await window.__scrollFrame();
    window.__scrollBefore = notesList.scrollTop;
    const rect = window.__scrollTarget.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  })()`);
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...middle });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...middle });
  await window.webContents.executeJavaScript(`window.__scrollCheck("mouse selection preserves the middle of the list and its focused row", async () => {
    await window.__scrollWaitForTitle("Заметка 046");
    window.__scrollAssert(window.__scrollBefore > notesList.clientHeight, "fixture did not scroll to the middle");
    window.__scrollAssert(Math.abs(notesList.scrollTop - window.__scrollBefore) <= 1, "list jumped: " + window.__scrollBefore + " -> " + notesList.scrollTop);
    window.__scrollAssert(document.activeElement === window.__scrollTarget && window.__scrollTarget.isConnected, "selection removed the focused row");
    window.__scrollAssert(notesList.querySelectorAll(".note-list-button.active").length === 1 && window.__scrollTarget.classList.contains("active"), "active marker does not match selected detail");
    return { before: window.__scrollBefore, after: notesList.scrollTop, title: noteViewTitle.textContent };
  })`);

  await window.webContents.executeJavaScript(`window.__scrollReset(); window.__scrollTarget = window.__scrollPosition(55); window.__scrollBefore = notesList.scrollTop;`);
  window.webContents.focus();
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  await window.webContents.executeJavaScript(`window.__scrollCheck("keyboard activation retains focus and viewport", async () => {
    await window.__scrollWaitForTitle("Заметка 056");
    window.__scrollAssert(Math.abs(notesList.scrollTop - window.__scrollBefore) <= 1, "keyboard selection changed scroll position");
    window.__scrollAssert(document.activeElement === window.__scrollTarget, "keyboard selection lost focus");
  })`);

  await window.webContents.executeJavaScript(`(async () => {
    await window.__scrollCheck("detail arrival preserves scrolling performed while its request was pending", async () => {
      window.__scrollReset(); window.__scrollPosition(40);
      let release;
      window.fetch = () => new Promise(resolve => { release = () => resolve(window.__scrollFakeResponse("Заметка 041")); });
      const pending = selectNote("Заметка 041");
      window.__scrollPosition(70);
      const current = notesList.scrollTop;
      release(); await pending; await window.__scrollFrame();
      window.__scrollAssert(Math.abs(notesList.scrollTop - current) <= 1, "late response reverted newer scrolling");
      return { before: current, after: notesList.scrollTop };
    });
    await window.__scrollCheck("failed detail request preserves selection, list position and rows", async () => {
      window.__scrollReset(); const target = window.__scrollPosition(50);
      await selectNote("Заметка 051"); const current = notesList.scrollTop;
      let requests = 0;
      window.fetch = async () => { requests += 1; throw new Error("synthetic offline"); };
      let failed = false;
      try { await selectNote("Заметка 052"); } catch (_) { failed = true; }
      window.__scrollAssert(failed && requests === 1, "failed request was hidden or retried");
      window.__scrollAssert(noteViewTitle.textContent === "Заметка 051" && target.classList.contains("active"), "failed request replaced current selection");
      window.__scrollAssert(notesList.scrollTop === current && target.isConnected, "failed request changed list");
    });
    await window.__scrollCheck("search, filters and sorting still rebuild the displayed result correctly", async () => {
      window.__scrollReset();
      setActiveNotesFilter("tagged");
      window.__scrollAssert(notesList.children.length === 50, "tag filter changed");
      notesSortSelect.value = "oldest"; notesSortSelect.dispatchEvent(new Event("change"));
      window.__scrollAssert(notesList.querySelector(".note-list-title").textContent === "Заметка 100", "oldest sort changed");
      notesSearch.value = "Заметка 010"; notesSearch.dispatchEvent(new Event("input"));
      window.__scrollAssert(notesList.children.length === 1 && notesList.textContent.includes("Заметка 010"), "search changed");
      const row = notesList.querySelector("button"); await selectNote("Заметка 010");
      window.__scrollAssert(row.classList.contains("active") && notesList.children.length === 1, "selection changed filtered result");
      notesSearch.value = "нет такого результата"; notesSearch.dispatchEvent(new Event("input"));
      await selectNote("Заметка 011");
      window.__scrollAssert(notesList.querySelector(".notes-empty") && !notesList.querySelector(".note-list-button"), "selection changed empty search result");
    });
    await window.__scrollCheck("stale detail response cannot replace the selected marker or rebuild the list", async () => {
      window.__scrollReset(); const target = window.__scrollPosition(50);
      let release;
      window.fetch = url => url.endsWith(encodeURIComponent("Заметка 050"))
        ? new Promise(resolve => { release = () => resolve(window.__scrollFakeResponse("Заметка 050")); })
        : Promise.resolve(window.__scrollFakeResponse("Заметка 051"));
      const pending = selectNote("Заметка 050"); await selectNote("Заметка 051");
      const current = notesList.scrollTop; release(); await pending;
      window.__scrollAssert(target.isConnected && target.classList.contains("active"), "stale response changed active row");
      window.__scrollAssert(noteViewTitle.textContent === "Заметка 051" && notesList.scrollTop === current, "stale response changed detail or viewport");
    });
    window.__scrollReset(); window.__scrollPosition(45); await selectNote("Заметка 046");
    setStatus("ok", "Демонстрационные данные · 100 заметок · место в списке сохранено");
    await window.__scrollFrame();
  })()`);
  const capture = await window.webContents.capturePage();
  fs.writeFileSync(path.join(output, "notes-middle-selected.png"), capture.toPNG());
  const checks = await window.webContents.executeJavaScript("window.__scrollResults");
  const coverage = await window.webContents.debugger.sendCommand("Profiler.takePreciseCoverage");
  const rendererCoverage = coverage.result.find(script => script.url === "noda-test://frontend/notes_renderer.js");
  fs.writeFileSync(path.join(output, "notes-renderer-coverage.json"), `${JSON.stringify(rendererCoverage, null, 2)}\n`);
  const selectionCoverage = rendererCoverage.functions.filter(fn => ["createNoteListItem", "updateNoteListSelection", "selectNote"].includes(fn.functionName))
    .map(fn => ({ function: fn.functionName, calls: fn.ranges[0].count, coveredRanges: fn.ranges.filter(range => range.count > 0).length, totalRanges: fn.ranges.length }));
  const result = { checks, selectionCoverage, networkRequests, screenshot: capture.getSize(), electron: process.versions.electron, chrome: process.versions.chrome };
  fs.writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  window.destroy();
  app.exit(checks.some(check => check.status !== "pass") || networkRequests ? 1 : 0);
}

run().catch(error => { console.error(error.stack); app.exit(1); });
