"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../../frontend/notes_live_application");
const A = "a".repeat(32), B = "b".repeat(32), R1 = "1".repeat(64), R2 = "2".repeat(64);
const context = background => ({ background, isCurrent: () => true });
const row = (revision = R1, title = "note") => ({ title, tags: ["tag"], indexed: true, content_revision: revision });
const detail = (revision = R1, content = "old") => ({ ...row(revision), content, vault_id: A });
const list = (notes = [row()], revision = R1, vault = A) => ({ notes, revision, vault_id: vault, qdrant: { available: true } });
function fixture(initial = {}) {
  const state = { notes: [], selectedNoteTitle: "", selectedNoteDetail: null, noteSelectionVersion: 0,
    creatingNote: false, draft: "Exact draft\r\n untouched", ...initial };
  const calls = [], applied = [], details = []; let resets = 0;
  let handler = () => list();
  const app = create({
    request: async url => { calls.push(url); return handler(url); }, getState: () => state,
    applyList: payload => { applied.push(payload); state.notes = payload.notes; },
    applyDetail: payload => { details.push(payload); state.selectedNoteDetail = payload; },
    resetSelection: () => { resets += 1; state.noteSelectionVersion += 1; state.selectedNoteTitle = ""; state.selectedNoteDetail = null; },
  });
  return { app, state, calls, applied, details, resetCount: () => resets, reply: next => { handler = next; } };
}
async function selectedFixture() {
  const f = fixture(); await f.app.refresh(context(false));
  Object.assign(f.state, { selectedNoteTitle: "note", selectedNoteDetail: detail() }); return f;
}

test("initial foreground load establishes conditional cache-only polling without DOM churn", async () => {
  const f = fixture(); await f.app.refresh(context(false));
  f.reply(() => ({ unchanged: true, vault_id: A, revision: R1 }));
  assert.equal(await f.app.refresh(context(true)), false);
  assert.deepEqual(f.calls, ["/notes", `/notes?live=1&expected_vault_id=${A}&if_revision=${R1}`]);
  assert.equal(f.applied.length, 1); assert.equal(f.details.length, 0); assert.equal(f.app.getVault(), A);
});

test("an explicit project reset forgets the former vault and conditional revision before loading", async () => {
  const f = await selectedFixture();
  f.app.reset(); assert.equal(f.app.getVault(), null);
  Object.assign(f.state, { notes: [], selectedNoteTitle: "", selectedNoteDetail: null });
  f.reply(() => list([row(R2, "new project note")], R2, B));
  await f.app.refresh(context(false));
  assert.equal(f.calls.at(-1), "/notes"); assert.equal(f.app.getVault(), B);
  assert.equal(f.state.notes[0].title, "new project note");
});

test("body-only selected revision refreshes detail and an unrelated addition preserves selection", async () => {
  const f = await selectedFixture();
  f.reply(url => url.startsWith("/notes?") ? list([row(R2)], R2) : detail(R2, "new body"));
  await f.app.refresh(context(true));
  assert.equal(f.state.selectedNoteDetail.content, "new body");
  assert.equal(f.details.length, 1); assert.equal(f.state.selectedNoteTitle, "note");
  const previousCalls = f.calls.length;
  f.reply(() => list([row(R2), row(R2, "added")], R2));
  await f.app.refresh(context(true));
  assert.equal(f.calls.length, previousCalls + 1); assert.equal(f.details.length, 1);
  assert.equal(f.resetCount(), 0);
});

test("transient detail failure does not checkpoint the new revision and automatically retries", async () => {
  const f = await selectedFixture(); let failDetail = true;
  f.reply(url => {
    if (url.startsWith("/notes?")) return list([row(R2)], R2);
    if (failDetail) throw new Error("offline");
    return detail(R2, "recovered body");
  });
  await assert.rejects(f.app.refresh(context(true)), /offline/);
  assert.equal(f.state.selectedNoteDetail.content, "old"); failDetail = false;
  await f.app.refresh(context(true));
  assert.equal(f.calls.filter(url => url.startsWith("/notes?")).at(-1),
    `/notes?live=1&expected_vault_id=${A}&if_revision=${R1}`);
  assert.equal(f.state.selectedNoteDetail.content, "recovered body");
});

test("late detail cannot replace a newer selection or a paused request", async () => {
  for (const invalidate of [false, true]) {
    const f = await selectedFixture(); let release, valid = true;
    f.reply(url => url.startsWith("/notes?") ? list([row(R2)], R2) : new Promise(resolve => { release = resolve; }));
    const pending = f.app.refresh({ background: true, isCurrent: () => valid });
    while (!release) await Promise.resolve();
    if (invalidate) valid = false;
    else Object.assign(f.state, { selectedNoteTitle: "other", noteSelectionVersion: 2 });
    release(detail(R2, "must not apply")); await pending;
    assert.equal(f.details.length, 0); assert.equal(f.state.selectedNoteDetail.content, "old");
  }
});

test("stale list responses never apply and editing drafts are untouched", async () => {
  const f = fixture({ creatingNote: true }); const draft = f.state.draft;
  await f.app.refresh({ background: true, isCurrent: () => false });
  assert.equal(f.applied.length, 0);
  await f.app.refresh(context(false));
  assert.equal(f.state.creatingNote, true); assert.equal(f.state.draft, draft); assert.equal(f.details.length, 0);
});

test("vault change requires explicit 409, then safely drops previous selection", async () => {
  const f = await selectedFixture();
  f.reply(url => {
    if (url.includes("expected_vault_id")) throw Object.assign(new Error("changed"), { code: "vault_changed" });
    return list([row(R2, "new vault note")], R2, B);
  });
  await f.app.refresh(context(true));
  assert.equal(f.app.getVault(), B); assert.equal(f.state.selectedNoteTitle, "");
  assert.equal(f.resetCount(), 1); assert.equal(f.state.notes[0].title, "new vault note");
  assert.equal(f.calls.at(-1), "/notes?live=1");
});

test("unsolicited foreign vault payload and wrong-vault details fail closed", async () => {
  const f = await selectedFixture(); f.reply(() => list([row(R2, "foreign")], R2, B));
  await assert.rejects(f.app.refresh(context(true)), error => error.code === "vault_changed");
  assert.equal(f.state.notes[0].title, "note"); assert.equal(f.app.getVault(), A);
  f.reply(() => ({ ...detail(), vault_id: B }));
  await assert.rejects(f.app.readDetail("note"), error => error.code === "vault_changed");
});

test("invalid snapshots and impossible unchanged receipts preserve the prior list", async () => {
  for (const invalid of [
    { ...list(), notes: null }, { ...list(), notes: [row(), row()] },
    { ...list(), notes: [null] }, { ...list(), revision: "bad" }, { ...list(), vault_id: 3 },
    { unchanged: true, revision: R2, vault_id: A },
  ]) {
    const f = await selectedFixture(); const original = f.state.notes; f.reply(() => invalid);
    await assert.rejects(f.app.refresh(context(true)), error => error.code === "invalid_notes_response");
    assert.equal(f.state.notes, original);
  }
  const first = fixture(); first.reply(() => ({ unchanged: true, vault_id: A, revision: R1 }));
  await assert.rejects(first.app.refresh(context(true)), /invalid_notes_response/);
});

test("deleted selection clears safely without choosing another note", async () => {
  const f = await selectedFixture(); f.reply(() => list([row(R2, "other")], R2));
  await f.app.refresh(context(true)); assert.equal(f.state.selectedNoteTitle, "");
  assert.equal(f.details.length, 0); assert.equal(f.resetCount(), 1);
});

test("legacy manual payloads remain readable and malformed detail fails", async () => {
  const f = fixture(); f.reply(() => ({ notes: [row()], vault_id: null }));
  await f.app.refresh(context(false)); assert.equal(f.app.getVault(), null);
  f.reply(() => ({ content: null, tags: [] })); await assert.rejects(f.app.readDetail("note"), /invalid_notes_response/);
  f.reply(() => ({ content: "", tags: [] })); assert.equal((await f.app.readDetail("note")).content, "");
});

test("presentation-identical detail updates revision without repainting", async () => {
  const f = await selectedFixture(); f.reply(url => url.startsWith("/notes?") ? list([row(R2)], R2) : detail(R2));
  await f.app.refresh(context(true)); assert.equal(f.details.length, 0);
  assert.equal(f.state.selectedNoteDetail.content_revision, R2);
});
