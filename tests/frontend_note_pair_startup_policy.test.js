"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createStartupNoteSelection, startupStageIds } = require("../frontend/note_pair_selection");
const { PROFILE_ID } = require("../frontend/ru_note_startup");

const stages = ["title", "tags", "links"];
const flags = ["skipNoteTitleSelection", "skipNoteTagsSelection", "skipNoteLinksSelection"];
const selected = { title: "qwen25_3b_mmarco", tags: "qwen35_4b_tev", links: "qwen35_4b_mmarco" };
const catalog = stages.map(id => ({ id, options: [{ id: selected[id] }, { id: "alternative" }] }));
const runtime = (patch = {}) => ({ note_pipeline: {
  enabled: true, profile: PROFILE_ID, configured: true, selection: selected, catalog, ...patch,
} });

test("first and unreadable setup require every stage despite auto-skip defaults", () => {
  for (const configured of [false, undefined, "true"]) {
    assert.deepEqual(startupStageIds(runtime({ configured })), stages);
  }
  for (const patch of [{ configurationError: "note_pipeline_selection_unreadable" },
    { selection: undefined }, { selection: {} }, { selection: { ...selected, other: "extra" } },
    { selection: { ...selected, title: "unknown" } }, { selection: { ...selected, tags: 1 } }]) {
    assert.deepEqual(startupStageIds(runtime(patch), Object.fromEntries(flags.map(key => [key, true]))), stages);
  }
  for (const unavailable of stages) {
    const unavailableCatalog = catalog.map(entry => ({ ...entry,
      options: entry.options.map(option => ({ ...option,
        available: !(entry.id === unavailable && option.id === selected[unavailable]),
      })),
    }));
    assert.deepEqual(startupStageIds(runtime({ catalog: unavailableCatalog })), stages);
  }
});

test("valid saved selection skips on every repeated launch with migrated defaults", async () => {
  let shown = 0, saves = 0;
  const controller = createStartupNoteSelection({ show: () => shown++, save: () => saves++ });
  for (let launch = 0; launch < 3; launch++) {
    const savedRuntime = runtime();
    assert.equal(await controller.wait(savedRuntime), savedRuntime);
    assert.deepEqual(startupStageIds(savedRuntime, { skipModelSelection: false }), []);
  }
  assert.equal(shown, 0);
  assert.equal(saves, 0);
});

test("all eight independent checkbox combinations choose only unchecked stages", () => {
  for (let combination = 0; combination < 8; combination++) {
    const settings = Object.fromEntries(flags.map((key, index) => [key, Boolean(combination & (1 << index))]));
    const expected = stages.filter((_, index) => !settings[flags[index]]);
    assert.deepEqual(startupStageIds(runtime(), { ...settings, skipModelSelection: true }), expected);
  }
  assert.deepEqual(startupStageIds(runtime(), { skipNoteTagsSelection: "true" }), ["tags"]);
});

test("disabled processing stages never prompt for a pair even when their files are missing", () => {
  const stageEnabled = { title: false, tags: true, links: false };
  const unavailableCatalog = catalog.map(entry => entry.id === "tags" ? entry : {
    ...entry, options: entry.options.map(option => ({ ...option, available: false })),
  });
  const savedRuntime = runtime({ stageEnabled, catalog: unavailableCatalog });
  assert.deepEqual(startupStageIds(savedRuntime, { skipNoteTitleSelection: false, skipNoteLinksSelection: false }), []);
  assert.deepEqual(startupStageIds(savedRuntime, { skipNoteTagsSelection: false }), ["tags"]);
});

test("malformed catalogs fail explicitly instead of silently releasing startup", () => {
  for (const invalid of [undefined, null, "catalog", [], catalog.slice(1),
    [...catalog, catalog[0]], [catalog[0], catalog[0], catalog[2]],
    catalog.map(entry => entry.id === "tags" ? { ...entry, options: [] } : entry),
    catalog.map(entry => entry.id === "tags" ? { ...entry, options: [{ id: "../bad" }] } : entry),
    catalog.map(entry => entry.id === "tags" ? { ...entry, options: [{ id: "same" }, { id: "same" }] } : entry)]) {
    assert.throws(() => startupStageIds(runtime({ catalog: invalid })), /Каталог связок/);
  }
  for (const foreign of [null, {}, { note_pipeline: { enabled: true, profile: "foreign" } }]) {
    assert.deepEqual(startupStageIds(foreign), []);
  }
});

test("mixed startup preserves hidden pairs, retries failure, then skips after successful first setup", async () => {
  const shown = [], calls = [];
  let fail = true;
  const controller = createStartupNoteSelection({
    show: pipeline => shown.push(pipeline),
    save: async selection => {
      calls.push(selection);
      if (fail) throw new Error("save failed");
      return { ok: true, runtime: runtime({ selection }) };
    },
  });
  const waiting = controller.wait(runtime(), { skipNoteTagsSelection: false });
  assert.deepEqual(shown[0].startupStageIds, ["tags"]);
  await assert.rejects(controller.apply({ ...selected, title: "alternative" }), /Некорректный выбор/);
  await assert.rejects(controller.apply({ tags: "alternative" }), /Некорректный выбор/);
  assert.equal(calls.length, 0);
  const updated = { ...selected, tags: "alternative" };
  await assert.rejects(controller.apply(updated), /save failed/);
  assert.equal(controller.wait(runtime()), waiting);
  fail = false;
  const saved = await controller.apply(updated);
  assert.equal(await waiting, saved.runtime);
  assert.deepEqual(calls, [updated, updated]);
  assert.equal(await controller.wait(saved.runtime), saved.runtime);

  const first = createStartupNoteSelection({ show: pipeline => shown.push(pipeline),
    save: async selection => ({ ok: true, runtime: runtime({ selection }) }) });
  const firstWait = first.wait(runtime({ configured: false }));
  assert.deepEqual(shown.at(-1).startupStageIds, stages);
  const confirmed = await first.apply(selected);
  assert.equal(await firstWait, confirmed.runtime);
  assert.equal(await first.wait(confirmed.runtime), confirmed.runtime);
});
