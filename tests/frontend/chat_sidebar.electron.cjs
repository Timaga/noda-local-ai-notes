"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, session } = require("electron");
const { A, B, initial, createMainFixture, setupHttp } = require("./projects_fixture.cjs");

const language = app.commandLine.getSwitchValue("language") === "en" ? "en" : "ru";
const ru = language === "ru";
const frontend = app.commandLine.getSwitchValue("frontend-dir") || path.resolve(__dirname, "../../frontend");
const output = app.commandLine.getSwitchValue("screenshots-dir");
const sampleTime = "2026-11-09T15:07:00+03:00";
const titles = ru ? ["Календарь команды", "Резервное копирование", "План на неделю"]
  : ["Team calendar", "Backups", "Weekly plan"];
const chats = titles.map((title, index) => ({
  id: `sample-${index}`, title, createdAt: sampleTime, updatedAt: sampleTime,
  messages: index === 0 ? [
    { role: "user", text: ru ? "Что запланировано для календаря команды?" : "What is planned for the team calendar?", createdAt: sampleTime },
    { role: "assistant", text: ru ? "В первой версии будут **встречи команды и напоминания**. У каждой встречи можно указать время, участников и ссылку на материалы."
      : "The first version will support **team meetings and reminders**. Each meeting can include a time, attendees and a link to its materials.",
    createdAt: sampleTime, sources: [{ title }], contextSource: "qdrant" },
    { role: "user", text: ru ? "А кто сможет добавлять встречи?" : "Who can add meetings?", createdAt: sampleTime },
    { role: "assistant", text: ru ? "Встречи добавляют организаторы команды. Участники смогут просматривать события и включать напоминания."
      : "Team organizers add meetings. Members can view events and turn on reminders.", createdAt: sampleTime, sources: [{ title }], contextSource: "qdrant" },
  ] : [{ role: "assistant", text: ru ? "Сводка по заметкам проекта." : "Summary from project notes.", createdAt: sampleTime }],
}));

app.disableHardwareAcceleration();

async function run() {
  assert.ok(app.commandLine.hasSwitch("user-data-dir"), "Use an isolated profile");
  await app.whenReady();
  const fixture = createMainFixture(ipcMain, language);
  const unexpected = [];
  session.defaultSession.webRequest.onBeforeRequest(({ url }, done) => {
    const local = /^(file|data|about):/.test(url);
    if (!local) unexpected.push(url);
    done({ cancel: !local });
  });
  const win = new BrowserWindow({ width: 1440, height: 960, show: false,
    webPreferences: { preload: path.join(frontend, "preload.js"), sandbox: true, contextIsolation: true,
      offscreen: true, backgroundThrottling: false, additionalArguments: [`--noda-language=${language}`] } });
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  const waitFor = (condition) => evaluate(`(async () => {
    const until = performance.now() + 5000;
    while (!(${condition})) {
      if (performance.now() >= until) throw new Error(${JSON.stringify(`Timed out: ${condition}`)});
      await new Promise(requestAnimationFrame);
    }
  })()`);
  const buttonText = () => evaluate("document.querySelector('#chat-new-btn span:last-child').textContent");
  try {
    fixture.addWindow(win);
    await win.loadURL("about:blank");
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Page.enable");
    await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source:
      `(${setupHttp.toString()})(${JSON.stringify(initial(language))},${JSON.stringify(fixture.snapshot())});
       localStorage.setItem('notes-panel-rag-chats-v1:${A}', ${JSON.stringify(JSON.stringify(chats))});` });
    await win.loadFile(path.join(frontend, "notes.html"));
    await waitFor("!document.body.classList.contains('app-loading') && notes.length === 2");
    await evaluate("document.getElementById('notes-chat-tab').click()");
    await waitFor("document.querySelectorAll('.chat-history-item').length === 3");
    assert.equal(await buttonText(), ru ? "Новый чат" : "New chat");
    const degradedSearch = await evaluate(`(() => {
      const previous = qdrantInfo;
      qdrantInfo = { ...previous, available: true, embedding_status: 'disabled' };
      renderQdrantState(); syncNotesChatState();
      const result = {
        library: document.getElementById('qdrant-state').textContent,
        chat: document.getElementById('chat-subtitle').textContent,
        disabled: document.getElementById('chat-input').disabled,
      };
      qdrantInfo = previous;
      renderQdrantState(); syncNotesChatState();
      return result;
    })()`);
    assert.equal(degradedSearch.library, ru ? "Только текстовый поиск" : "Text search only");
    assert.match(degradedSearch.chat, ru ? /Настроить смысловой поиск.*перезапустите/ : /Set up semantic search.*restart/);
    assert.equal(degradedSearch.disabled, true);
    assert.equal(await evaluate(`(() => {
      const button = document.getElementById('chat-new-btn');
      const search = document.getElementById('chat-search');
      const [refresh, newNote] = ['refresh-notes-btn', 'new-note-btn'].map(id => document.getElementById(id));
      return button.closest('.chat-history-panel') && !button.disabled && button.getClientRects().length === 1
        && button.getBoundingClientRect().bottom <= search.getBoundingClientRect().top
        && !refresh.getClientRects().length && !newNote.getClientRects().length;
    })()`), true);
    const composerLayout = await evaluate(`(() => {
      const form = document.getElementById('chat-form');
      const workspace = form.closest('.notes-workspace');
      const panel = form.closest('.chat-conversation-panel');
      const inset = workspace.closest('.notes-dashboard-shell').getBoundingClientRect().bottom
        - panel.getBoundingClientRect().bottom;
      return {children:form.children.length,input:form.querySelector('#chat-input').getClientRects().length,
        send:form.querySelector('#chat-send-btn').getClientRects().length,badge:!!document.getElementById('chat-qdrant-state'),
        inset,padding:parseFloat(getComputedStyle(workspace).paddingBottom),
        border:parseFloat(getComputedStyle(workspace.closest('.notes-dashboard-shell')).borderBottomWidth)};
    })()`);
    assert.equal(composerLayout.children, 1);
    assert.equal(composerLayout.input, 1);
    assert.equal(composerLayout.send, 1);
    assert.equal(composerLayout.badge, false);
    assert.ok(Math.abs(composerLayout.inset - composerLayout.padding - composerLayout.border) < 1, JSON.stringify(composerLayout));
    if (output) {
      await waitFor("document.getElementById('startup-overlay').hidden || getComputedStyle(document.getElementById('startup-overlay')).opacity === '0'");
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const { data } = await win.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(output, `chat-sidebar-${language}.png`), Buffer.from(data, "base64"));
    }
    await evaluate("document.getElementById('chat-new-btn').click()");
    assert.equal(await evaluate("document.querySelectorAll('.chat-history-item').length"), 4);
    assert.equal(await evaluate("document.activeElement.id"), "chat-input");
    assert.equal(await evaluate("Boolean(document.querySelector('.chat-empty-state'))"), true);
    await evaluate(`document.getElementById('chat-input').value = '😀'.repeat(801);
      document.getElementById('chat-form').requestSubmit();`);
    assert.equal(await evaluate("document.getElementById('chat-input').getAttribute('aria-invalid')"), "true");
    assert.match(await evaluate("document.getElementById('chat-query-hint').textContent"), /800/);
    assert.equal(await evaluate("window.__projects.calls.filter(call => call.path === '/rag').length"), 0);
    const question = ru ? "Что в заметках проекта?" : "What is in the project notes?";
    await evaluate(`window.__projects.hold = { id: ${JSON.stringify(A)}, path: '/rag', method: 'POST' };
      document.getElementById('chat-input').value = ${JSON.stringify(question)};
      document.getElementById('chat-form').requestSubmit();`);
    await waitFor("window.__projects.pending.length === 1 && document.activeElement.id === 'chat-stop-btn'");
    await evaluate("document.getElementById('chat-stop-btn').click()");
    await waitFor("Boolean(document.querySelector('.chat-retry-btn')) && !document.getElementById('chat-input').disabled");
    assert.match(await evaluate("document.getElementById('chat-messages').textContent"), ru ? /Ожидание ответа остановлено/ : /Stopped waiting/);
    await evaluate("window.__projects.hold = null; document.querySelector('.chat-retry-btn').click()");
    await waitFor("document.getElementById('chat-messages').textContent.includes('RAG answer')");
    await evaluate("window.__projects.pending.shift().release()");
    assert.equal(await evaluate("document.querySelectorAll('.chat-message-row.user').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('.chat-message-row.assistant').length"), 1);
    assert.equal(await evaluate(`window.__projects.calls.filter(call => call.path === '/rag'
      && call.method === 'POST' && call.body.query === ${JSON.stringify(question)}).length`), 2);
    const exportPath = path.join(app.getPath("userData"), "chat-audit-export.json");
    const download = new Promise((resolve, reject) => {
      win.webContents.session.once("will-download", (_event, item) => {
        item.setSavePath(exportPath);
        item.once("done", (_done, state) => state === "completed" ? resolve() : reject(new Error(`Export: ${state}`)));
      });
    });
    await evaluate("document.getElementById('chat-export-btn').click()");
    let timeout;
    try {
      await Promise.race([download, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Export timed out")), 5000); })]);
    } finally {
      clearTimeout(timeout);
    }
    const archive = JSON.parse(fs.readFileSync(exportPath, "utf8"));
    assert.equal(archive.chats.length, 4);
    assert.ok(archive.chats.some(chat => chat.messages[0].text === question));
    assert.deepEqual(await evaluate("window.__projects.violations"), []);

    await evaluate("document.querySelector('[data-notes-tab=notes]').click()");
    assert.equal(await evaluate("document.getElementById('refresh-notes-btn').getClientRects().length"), 0);
    assert.equal(await evaluate("document.getElementById('new-note-btn').getClientRects().length"), 1);
    assert.equal(await evaluate("document.getElementById('chat-new-btn').getClientRects().length"), 0);
    await evaluate("document.querySelector('[data-notes-tab=settings]').click()");
    assert.equal(await evaluate("document.querySelector('#refresh-notes-btn span:last-child').textContent"), ru ? "Сбросить" : "Reset");
    assert.equal(await evaluate("document.querySelector('#new-note-btn span:last-child').textContent"), ru ? "Сохранить изменения" : "Save changes");

    await evaluate("document.getElementById('notes-chat-tab').click()");
    assert.equal(await evaluate("document.getElementById('refresh-notes-btn').getClientRects().length"), 0);
    await fixture.switchProject(B);
    await waitFor("window.NodaProjectContext.snapshot().projectId === '" + B + "'");
    assert.equal(await evaluate("document.querySelectorAll('.chat-history-item').length"), 1);
    fixture.emitHardError("rollback");
    await waitFor("document.getElementById('chat-new-btn').disabled");
    assert.deepEqual(unexpected, []);
    console.log(`PASS ${language}: chat sidebar action, composer, answer, tab headers and project isolation`);
  } catch (error) {
    console.error(await evaluate(`({
      startup: document.body.className,
      bridge: Boolean(window.quickNoteBridge),
      project: window.NodaProjectContext?.snapshot().status,
      notes: typeof notes === 'undefined' ? null : notes.length,
      requests: window.__projects?.calls.map(call => call.path),
    })`).catch(() => null));
    throw error;
  } finally {
    win.destroy();
  }
}

run().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
