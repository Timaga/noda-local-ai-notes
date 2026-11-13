"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createStartupLanguageSelection } = require("../frontend/startup_language");

test("an explicitly reset language waits for a saved, valid choice before proceeding", async () => {
  const calls = [];
  const selection = createStartupLanguageSelection({
    initialLanguage: null,
    showPrompt: () => calls.push("prompt"),
    persist: language => calls.push(`save:${language}`),
  });
  const first = selection.wait().then(language => calls.push(`ready:${language}`));
  const second = selection.wait();
  assert.equal(selection.getLanguage(), null);
  for (const invalid of [null, undefined, "uk", "EN", ["en"], { language: "en" }]) {
    assert.deepEqual(selection.select(invalid), { ok: false, code: "invalid_language" });
  }
  await Promise.resolve();
  assert.deepEqual(calls, ["prompt"]);

  assert.deepEqual(selection.select("en"), { ok: true, language: "en" });
  assert.equal(await second, "en");
  await first;
  assert.equal(selection.getLanguage(), "en");
  assert.equal(await selection.wait(), "en");
  assert.deepEqual(selection.select("ru"), { ok: false, code: "selection_inactive" });
  assert.deepEqual(calls, ["prompt", "save:en", "ready:en"]);
});

test("persistence failure leaves the prompt active and retryable", async () => {
  const writes = [];
  let fail = true;
  const selection = createStartupLanguageSelection({
    initialLanguage: null,
    showPrompt: () => {},
    persist: language => {
      if (fail) throw new Error("Synthetic read-only profile");
      writes.push(language);
    },
  });
  let continued = false;
  const pending = selection.wait().then(language => {
    continued = true;
    return language;
  });
  assert.deepEqual(selection.select("en"), { ok: false, code: "language_save_failed" });
  await Promise.resolve();
  assert.equal(continued, false);
  assert.equal(selection.getLanguage(), null);
  assert.deepEqual(writes, []);

  fail = false;
  assert.deepEqual(selection.select("ru"), { ok: true, language: "ru" });
  assert.equal(await pending, "ru");
  assert.deepEqual(writes, ["ru"]);
});

test("failure to show the prompt does not leave a stale startup wait", async () => {
  const failure = new Error("Synthetic startup window failure");
  let prompts = 0;
  const selection = createStartupLanguageSelection({
    showPrompt: () => {
      prompts += 1;
      if (prompts === 1) throw failure;
    },
    persist: () => {},
  });
  assert.throws(() => selection.wait(), failure);
  assert.deepEqual(selection.select("en"), { ok: false, code: "selection_inactive" });
  const pending = selection.wait();
  assert.deepEqual(selection.select("en"), { ok: true, language: "en" });
  assert.equal(await pending, "en");
  assert.equal(prompts, 2);
});

for (const [initialLanguage, bypass, expected] of [["ru", false, "ru"], ["en", false, "en"], ["en", true, "en"], ["zh", false, "zh"], ["ko", false, "ko"], [null, true, "en"]]) {
  test(`launch reuses saved or noninteractive language (${initialLanguage}, bypass=${bypass})`, async () => {
    const selection = createStartupLanguageSelection({
      initialLanguage,
      bypass,
      showPrompt: () => assert.fail("Unexpected language prompt"),
      persist: () => assert.fail("Unexpected language write"),
    });
    assert.equal(await selection.wait(), expected);
    assert.equal(selection.getLanguage(), expected);
  });
}

test("only the dedicated startup window can submit a language", async () => {
  const main = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
  const senderStart = main.indexOf("function isStartupWindowSender(");
  const senderEnd = main.indexOf("\n}", senderStart);
  const start = main.indexOf('ipcMain.handle("quick-note:select-startup-language"');
  const end = main.indexOf("\n});", start);
  assert.ok(senderStart >= 0 && senderEnd > senderStart, "Expected startup window sender check");
  assert.ok(start >= 0 && end > start, "Expected startup language IPC handler");
  const calls = [];
  const denied = { ok: false, error: "forbidden" };
  const startup = {};
  let destroyed = false;
  let handle;
  const context = vm.createContext({
    ipcMain: { handle: (channel, callback) => {
      assert.equal(channel, "quick-note:select-startup-language");
      handle = callback;
    } },
    startupLanguage: { select: language => { calls.push(language); return { ok: true, language }; } },
    startupWindow: { isDestroyed: () => destroyed, webContents: startup },
    denyInvalidStartupSender: () => denied,
  });
  vm.runInContext(main.slice(senderStart, senderEnd + 2) + "\n" + main.slice(start, end + 4), context);
  assert.equal(await handle({ sender: {} }, "en"), denied);
  destroyed = true;
  assert.equal(await handle({ sender: startup }, "en"), denied);
  destroyed = false;
  const startupWindow = context.startupWindow;
  context.startupWindow = null;
  assert.equal(await handle({ sender: startup }, "en"), denied);
  context.startupWindow = startupWindow;
  assert.deepEqual(calls, []);
  const result = await handle({ sender: startup }, "en");
  assert.equal(result.ok, true);
  assert.equal(result.language, "en");
  assert.deepEqual(calls, ["en"]);
});
