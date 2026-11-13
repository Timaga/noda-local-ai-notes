"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");

const allowedScripts = new Set(["i18n.js", "marked.min.js", "notes_markdown.js", "notes_chat_renderer.js"]);
const fixture = {
  query: "Покажи **пример**",
  payload: {
    response: [
      "## План", "", "Первый абзац с **важным** и *уточнением*.", "", "9. **Отмена**", "   - Уведомить школу.",
      "10. **Связь**", "    - Проверить рацию.", "", "~~~text", "**буквально** <example>", "~~~", "",
      "| Время | Действие |", "| --- | --- |", "| 09:00 | Старт |", "", "Заключительный абзац.", "",
      '<img src="https://untrusted.invalid/raw.png" onerror="window.attack=1"><script>window.attack=2</script>',
      "", "![Внешняя картинка](https://untrusted.invalid/markdown.png) [Метка](javascript:alert(1))",
    ].join("\n"),
    context: [{ title: "Регламент" }], context_source: "qdrant",
  },
};

app.disableHardwareAcceleration();

async function run() {
  assert.ok(app.commandLine.hasSwitch("user-data-dir"), "Use a separate Electron profile");
  const frontend = app.commandLine.getSwitchValue("frontend-dir") || path.resolve(__dirname, "../../frontend");
  const output = app.commandLine.getSwitchValue("screenshots-dir");
  const answerFile = app.commandLine.getSwitchValue("answer-file");
  const externalRequests = [];
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest(({ url, resourceType }, done) => {
    const local = url.startsWith("file:");
    if (!local) externalRequests.push(resourceType);
    done({ cancel: !local || (resourceType === "script" && !allowedScripts.has(new URL(url).pathname.split("/").at(-1))) });
  });
  const win = new BrowserWindow({ show: false, width: 1440, height: 960,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true } });
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  try {
    async function load() {
      await win.loadFile(path.join(frontend, "notes.html"));
      await evaluate(`(() => {
        document.documentElement.lang = 'ru';
        document.body.classList.replace('app-loading', 'app-ready');
        document.getElementById('startup-overlay').style.display = 'none';
        document.getElementById('notes-status-card').hidden = true;
        document.querySelector('.notes-hero h1').textContent = 'Чат по заметкам';
        document.querySelector('#new-note-btn [data-en]').textContent = 'Новый чат';
        for (const button of document.querySelectorAll('[data-notes-tab]')) {
          const active = button.dataset.notesTab === 'chat';
          button.classList.toggle('active', active);
          button.setAttribute('aria-selected', String(active));
        }
        for (const panel of document.querySelectorAll('[data-notes-panel]')) {
          const active = panel.dataset.notesPanel === 'chat';
          panel.classList.toggle('active', active);
          panel.hidden = !active;
        }
        window.notesChatController.activate();
      })()`);
    }

    async function send(example) {
      await evaluate(`(async () => {
        window.fetch = async () => new Response(JSON.stringify(${JSON.stringify(example.payload)}), { status: 200 });
        window.notesChatController.setNotesState({notes: ${JSON.stringify(example.payload.context)}, qdrant: {available:true}});
        const input = document.getElementById('chat-input');
        input.value = ${JSON.stringify(example.query)};
        document.getElementById('chat-form').requestSubmit();
        const deadline = performance.now() + 5000;
        while (input.disabled && performance.now() < deadline) await new Promise(requestAnimationFrame);
        if (input.disabled) throw new Error('Chat did not finish');
      })()`);
    }

    const inspect = () => evaluate(`(() => {
      const answer = document.querySelector('.assistant .chat-message-text');
      return {text: answer.textContent, heading: answer.querySelector('h2')?.textContent,
        bold: [...answer.querySelectorAll('strong')].map(node => node.textContent),
        emphasis: answer.querySelector('em')?.textContent, orderedStart: answer.querySelector('ol')?.start,
        bullets: answer.querySelectorAll('ol ul > li').length, code: answer.querySelector('pre code')?.textContent,
        table: answer.querySelector('td')?.textContent, paragraphs: answer.querySelectorAll('p').length,
        unsafe: answer.querySelectorAll('img, script, a, iframe, [style], [onerror], [data-note-title]').length,
        user: document.querySelector('.user .chat-message-text').textContent,
        sources: [...document.querySelectorAll('.chat-source-pill')].map(node => node.textContent)};
    })()`);

    await load();
    await send(fixture);
    const result = await inspect();
    assert.equal(result.heading, "План");
    assert.deepEqual(result.bold, ["важным", "Отмена", "Связь"]);
    assert.equal(result.emphasis, "уточнением");
    assert.equal(result.orderedStart, 9);
    assert.equal(result.bullets, 2);
    assert.equal(result.code.trim(), "**буквально** <example>");
    assert.equal(result.table, "09:00");
    assert.ok(result.paragraphs >= 3);
    assert.equal(result.unsafe, 0);
    assert.match(result.text, /<script>window\.attack=2<\/script>/);
    assert.match(result.text, /Внешняя картинка Метка/);
    assert.ok(!result.text.includes("untrusted.invalid/markdown.png"));
    assert.equal(result.user, fixture.query);
    assert.deepEqual(result.sources, ["Регламент"]);
    await load();
    assert.deepEqual(await inspect(), result);

    if (answerFile && output) {
      const example = JSON.parse(fs.readFileSync(answerFile, "utf8"));
      await evaluate("localStorage.clear()");
      await load();
      await send(example);
      const rendered = await inspect();
      assert.deepEqual(rendered.sources, example.payload.context.map(item => item.title));
      assert.equal(rendered.bold.length, rendered.sources.length);
      assert.ok(rendered.text.includes(example.payload.response.split("\n\n").at(-1)));
      fs.mkdirSync(output, { recursive: true });
      win.webContents.debugger.attach("1.3");
      for (const [name, position] of [["beginning", "0"], ["sources", "messages.scrollHeight"]]) {
        await evaluate(`(async () => { const messages = document.getElementById('chat-messages');
          messages.scrollTop = ${position}; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()`);
        const { data } = await win.webContents.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path.join(output, `chat-${name}.png`), Buffer.from(data, "base64"));
      }
      win.webContents.debugger.detach();
    }
    assert.deepEqual(externalRequests, []);
    console.log("PASS: formatted answers, safe model content, sources and restored history");
  } finally {
    win.destroy();
  }
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
