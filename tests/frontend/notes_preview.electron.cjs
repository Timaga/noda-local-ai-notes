const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.resolve(__dirname, "../..");

async function run() {
  app.setPath("userData", process.argv[2]);
  app.setPath("sessionData", process.argv[2]);
  app.commandLine.appendSwitch("disable-background-networking");
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith("data:") && !details.url.startsWith("about:") });
  });
  const window = new BrowserWindow({
    show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const html = fs.readFileSync(path.join(repo, "frontend/notes.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const rendererRoot = process.argv[3] || repo;
  for (const file of ["frontend/project_context.js", "frontend/node_modules/marked/marked.min.js", "frontend/notes_markdown.js", "frontend/notes_list_view.js", "frontend/notes_live_application.js", "frontend/notes_live_sync.js", "frontend/notes_note_actions.js", "frontend/notes_library_tools.js", "frontend/notes_editor_session.js", "frontend/notes_editor_commands.js", "frontend/notes_inline_editor.js", "frontend/notes_workspace.js", "frontend/notes_metadata_editor.js", "frontend/notes_renderer.js"]) {
    const root = file.endsWith("notes_renderer.js") ? rendererRoot : repo;
    await window.webContents.executeJavaScript(fs.readFileSync(path.join(root, file), "utf8"));
  }
  const results = await window.webContents.executeJavaScript(`(async function () {
    const results = [];
    function assert(condition, message) { if (!condition) throw new Error(message); }
    async function check(name, run) {
      try { await run(); results.push({ name, status: "pass" }); }
      catch (error) { results.push({ name, status: "fail", error: error.message }); }
    }
    function preview(text) {
      renderMarkdownPreview(text);
      return document.getElementById("note-view-content");
    }

    await check("relative Markdown image is served through the local asset API", () => {
      const root = preview("![Схема](_resources/diagram%20one.png)");
      assert(root.querySelector("img")?.getAttribute("src") === "http://127.0.0.1:5000/notes/assets/_resources/diagram%20one.png", "relative image was blocked or misencoded");
    });
    await check("Obsidian image keeps hash and percent characters in its filename", () => {
      const root = preview("![[figure#1%20.png|320]]");
      assert(root.querySelector("img")?.getAttribute("src") === "http://127.0.0.1:5000/notes/assets/figure%231%2520.png", "filename changed");
    });
    await check("two dots within a safe filename remain allowed", () => {
      assert(preview("![[plot..draft.png]]").querySelector("img"), "valid filename blocked");
    });
    await check("wikilink alias and heading open the existing note", () => {
      const link = preview("[[Заметка.md#Раздел|Метка]]").querySelector("a");
      assert(link?.dataset.noteTitle === "Заметка", "anchor was included in note lookup");
      assert(link.textContent === "Метка", "alias lost");
    });
    await check("Markdown .md links open notes in-panel", () => {
      const link = preview("[Метка](%D0%97%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0.md#section)").querySelector("a");
      assert(link?.dataset.noteTitle === "Заметка", "relative note link was blocked");
    });
    await check("inline code keeps wiki syntax literal", () => {
      const root = preview(String.fromCharCode(96) + "[[Literal]] ![[picture.png]]" + String.fromCharCode(96));
      assert(root.querySelector("code")?.textContent === "[[Literal]] ![[picture.png]]", "code content was transformed");
      assert(!root.querySelector("a, img"), "code contains live links or images");
    });
    await check("fenced code keeps wiki syntax literal", () => {
      const root = preview("~~~text\\n[[Literal]] ![[picture.png]]\\n~~~");
      assert(root.querySelector("pre code")?.textContent.trim() === "[[Literal]] ![[picture.png]]", "fenced code content was transformed");
    });
    await check("unsafe HTML and script URLs cannot survive sanitization", () => {
      window.__previewAttack = 0;
      const root = preview('<script>window.__previewAttack = 1</script><iframe srcdoc="attack"></iframe><a href="javascript:alert(1)" onclick="window.__previewAttack=1">x</a><img src="x" onerror="window.__previewAttack=1">');
      assert(!root.querySelector("script, iframe, [onclick], [onerror], a[href^='javascript:']"), "unsafe DOM survived");
      assert(window.__previewAttack === 0, "script executed");
    });
    await check("internal links cannot retain network ping or download attributes", () => {
      const link = preview('<a href="#" data-note-title="Safe" ping="https://untrusted.invalid/ping" download="x">Open</a>').querySelector("a");
      assert(!link.hasAttribute("ping") && !link.hasAttribute("download"), "unapproved link attributes survived");
    });
    await check("image traversal cannot reach another backend route", () => {
      assert(!preview('<img src="http://127.0.0.1:5000/notes/assets/../../generate" alt="blocked">').querySelector("img"), "normalized route escaped asset allowlist");
    });
    await check("remote images are blocked and ordinary external links are isolated", () => {
      const root = preview('![remote](https://untrusted.invalid/image.png) [Docs](https://example.invalid/docs)');
      assert(!root.querySelector("img"), "external image allowed");
      const link = root.querySelector("a");
      assert(link?.target === "_blank" && link.rel.includes("noopener"), "external navigation missing isolation");
    });
    await check("failed save preserves the editable draft and allows retry", async () => {
      beginNewNote();
      document.getElementById("note-title-input").value = "Draft";
      document.getElementById("note-content-input").value = "Unsaved synthetic text";
      window.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: "synthetic offline" }) });
      let rejected = false;
      try { await createNote(); } catch (_) { rejected = true; }
      assert(rejected, "failed save appeared successful");
      assert(!document.getElementById("note-create-panel").hidden, "draft editor was closed");
      assert(!document.getElementById("note-content-input").readOnly, "draft became read-only");
      assert(!document.getElementById("save-note-btn").disabled, "retry disabled");
      assert(document.getElementById("note-content-input").value === "Unsaved synthetic text", "draft lost");
    });
    await check("successful save followed by refresh failure does not invite duplicate submission", async () => {
      beginNewNote();
      document.getElementById("note-title-input").value = "Saved";
      document.getElementById("note-content-input").value = "Persisted synthetic text";
      let writes = 0;
      window.fetch = async (url, options) => {
        if (options.method === "POST") {
          writes += 1;
          return { ok: true, status: 201, json: async () => ({ note: { title: "Saved", tags: [] } }) };
        }
        return { ok: false, status: 503, json: async () => ({ error: "synthetic refresh failure" }) };
      };
      await createNote();
      assert(writes === 1, "save was repeated");
      assert(document.getElementById("note-create-panel").hidden, "committed note remained an unsaved draft");
      assert(document.getElementById("save-note-btn").disabled, "committed note can be resubmitted");
      assert(document.getElementById("notes-status-text").textContent.includes("сохранена"), "saved state not communicated");
    });
    await check("manual save and reopening render the original Markdown indentation", async () => {
      const source = "    first code line\\n    second code line\\n\\nHard break  \\nNext line\\n";
      const content = "# Manual\\n\\n" + source;
      const detail = { title: "Manual", content, editable_body: content, edit_revision: "d".repeat(64), tags: [] };
      let submitted;
      beginNewNote();
      document.getElementById("note-title-input").value = "Manual";
      document.getElementById("note-content-input").value = source;
      window.fetch = async (url, options = {}) => {
        if (options.method === "POST") submitted = JSON.parse(options.body).content;
        const response = options.method === "POST" ? { note: { title: "Manual", tags: [] } }
          : new URL(url).pathname === "/notes" ? { notes: [{ title: "Manual" }] } : detail;
        return { ok: true, json: async () => response };
      };
      await saveEditor();
      assert(submitted === source, "manual save changed the submitted source");
      const view = document.getElementById("note-view-content");
      assert(view.querySelector("pre code")?.textContent === "first code line\\nsecond code line\\n", "indentation did not render as a code block");
      assert(view.querySelector("p br"), "Markdown line break did not render");
      await selectNote("Manual");
      assert(!document.getElementById("note-inline-content").readOnly, "opened note requires edit button");
      assert(document.getElementById("note-inline-content").value === content, "reopened editor changed the saved source");
    });
    await check("a slow earlier selection cannot replace the latest selected note", async () => {
      let release;
      window.fetch = url => new Promise(resolve => {
        const done = () => resolve({ok: true, json: async () => ({title: url.endsWith('/Old') ? 'Old' : 'New', content: url.endsWith('/Old') ? 'old text' : 'new text', tags: []})});
        if (url.endsWith('/Old')) release = done; else done();
      });
      const earlier = selectNote('Old');
      await selectNote('New');
      release(); await earlier;
      assert(document.getElementById('note-view-title').textContent === 'New', 'stale response replaced latest selection');
      assert(document.getElementById('note-view-content').textContent.includes('new text'), 'stale body displayed');
    });
    await check("a delayed selection cannot close a newly started draft", async () => {
      let release;
      window.fetch = () => new Promise(resolve => { release = () => resolve({ok: true, json: async () => ({title: 'Old', content: 'old text', tags: []})}); });
      const earlier = selectNote('Old');
      beginNewNote();
      document.getElementById('note-content-input').value = 'draft kept';
      release(); await earlier;
      assert(!document.getElementById('note-create-panel').hidden, 'stale response closed draft');
      assert(document.getElementById('note-content-input').value === 'draft kept', 'stale response replaced draft');
    });
    await check("a stale failed selection does not report failure for the current note", async () => {
      let rejectOld;
      window.fetch = url => url.endsWith('/Old') ? new Promise((_, reject) => {rejectOld = reject;}) : Promise.resolve({ok:true, json:async () => ({title:'New', content:'new text', tags:[]})});
      const earlier = selectNote('Old');
      await selectNote('New');
      rejectOld(new Error('old request failed')); await earlier;
      assert(document.getElementById('note-view-title').textContent === 'New', 'current selection changed');
    });
    await check("note editor resumes drafts across navigation and refuses stale saves", async () => {
      const vault = 'a'.repeat(32), revision = 'b'.repeat(64);
      const detail = title => ({ title, resolved_title: title, content: 'Source', editable_body: 'Source', edit_revision: revision, tags: [], vault_id: vault });
      let sent;
      window.fetch = async (url, options = {}) => {
        const path = new URL(url);
        if (options.method === 'PATCH') {
          sent = { url: path.pathname, vault: path.searchParams.get('expected_vault_id'), body: JSON.parse(options.body) };
          return { ok: false, status: 409, json: async () => ({ code: 'note_edit_conflict' }) };
        }
        return { ok: true, json: async () => path.pathname === '/notes'
          ? { notes: [{ title: 'First' }, { title: 'Second' }], vault_id: vault }
          : detail(path.pathname.endsWith('First') ? 'First' : 'Second') };
      };
      await loadNotes();
      await selectNote('First');
      const input = document.getElementById('note-inline-content');
      input.value = 'Local draft'; input.dispatchEvent(new Event('input'));
      await selectNote('Second'); await selectNote('First');
      assert(!input.readOnly, 'opened note is not editable');
      assert(input.value === 'Local draft', 'navigation replaced existing draft');
      await saveEditor();
      assert(sent?.url === '/note-detail/First' && sent.vault === vault, 'write was not project scoped');
      assert(sent.body.revision === revision && sent.body.content === 'Local draft', 'write omitted draft or revision');
      assert(!input.readOnly && input.value === 'Local draft', 'conflict removed draft');
      assert(document.getElementById('note-inline-status').textContent.includes('изменён в другом месте'), 'conflict not actionable');
    });
    await check("full text search and reversible trash are reachable from the notes screen", async () => {
      const vault = 'a'.repeat(32), calls = [];
      window.fetch = async (url, options = {}) => {
        const path = new URL(url), args = path.searchParams;
        calls.push([path.pathname, path.search, options.method]);
        let body = { notes: [{ title: 'First' }, { title: 'Second' }], vault_id: vault };
        if (args.has('q')) body = { titles: ['Second'], vault_id: vault };
        if (args.has('trash')) body = { items: [{ title: 'Restorable', id: 'c'.repeat(32) }] };
        if (args.has('restore')) body = { success: true, cache_updated: true };
        return { ok: true, json: async () => body };
      };
      const waitFor = async condition => {
        const deadline = Date.now() + 1000;
        while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert(condition(), 'UI timed out');
      };
      const search = document.getElementById('notes-search');
      search.value = 'term not in snippets'; search.dispatchEvent(new Event('input'));
      await waitFor(() => document.querySelectorAll('.note-list-button').length === 1);
      assert(document.querySelector('.note-list-button').dataset.noteTitle === 'Second', 'wrong search result');
      assert(calls.some(([, query]) => query.includes('q=term+not+in+snippets')), 'search stayed snippet-only');
      document.getElementById('note-trash-btn').click();
      await waitFor(() => document.querySelector('#note-trash-list button'));
      assert(document.getElementById('note-trash-dialog').open, 'trash did not open');
      document.querySelector('#note-trash-list button').click();
      await waitFor(() => document.getElementById('note-trash-status').textContent.includes('восстановлена'));
      assert(calls.some(([, query, method]) => method === 'POST' && query.includes('restore=')), 'restore did not reach notes API');
    });
    return results;
  }())`);
  console.log(JSON.stringify({ checks: results, electron: process.versions.electron, chrome: process.versions.chrome }));
  window.destroy();
  app.exit(results.some((check) => check.status !== "pass") ? 1 : 0);
}

run().catch((error) => {
  console.error(error.stack);
  if (app && typeof app.exit === "function") app.exit(1);
  else process.exit(1);
});
