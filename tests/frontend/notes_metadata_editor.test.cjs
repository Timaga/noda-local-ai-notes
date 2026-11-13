"use strict";
const assert = require("node:assert/strict"), test = require("node:test");
const { parseTags, save } = require("../../frontend/notes_metadata_editor");
test("tags accept Unicode/nested names and reject ambiguous or invalid values", () => {
  assert.deepEqual(parseTags("#Тег, nested/tag;Another"), ["Тег", "nested/tag", "Another"]);
  assert.deepEqual(parseTags(""), []);
  for (const value of ["Tag, tag", "../bad", "123", "bad:tag", "x".repeat(65), Array.from({length:21},(_,i)=>`tag${i}`).join(",")]) {
    assert.throws(() => parseTags(value), { code: "invalid_tags" });
  }
});
function fixture() {
  let current = true, handler, read = async () => ({ title: "Canonical", edit_revision: "b".repeat(64) });
  const calls = [], bound = { project: "A" };
  return { options: { context: { isCurrent: captured => current && captured === bound }, bound,
    title: "Folder/Canonical", vault: "a".repeat(32), detail: { edit_revision: "1".repeat(64) }, metadata: { title: "Visible name", tags: ["tag"] },
    request: async (url, options) => { calls.push({ url, ...options }); return handler ? handler() : { success: true, title: "Folder/Canonical" }; },
    readDetail: (...args) => read(...args) }, calls,
    switch: () => { current = false; }, handler: value => { handler = value; }, read: value => { read = value; } };
}
test("metadata save keeps canonical URL and sends revision/vault protection", async () => {
  const f = fixture(), result = await save(f.options);
  assert.equal(f.calls[0].url, `/note-detail/Folder%2FCanonical?expected_vault_id=${"a".repeat(32)}`);
  assert.deepEqual(JSON.parse(f.calls[0].body), { revision: "1".repeat(64), metadata: f.options.metadata });
  assert.equal(result.detail.edit_revision, "b".repeat(64));
});
test("project changes before or during a save do not apply stale metadata state", async () => {
  const f = fixture(); f.switch(); await assert.rejects(save(f.options), { code: "project_changed" }); assert.equal(f.calls.length, 0);
  const late = fixture(); late.handler(() => { late.switch(); return { success: true }; });
  await assert.rejects(save(late.options), { code: "project_changed" });
});
test("a committed save whose readback fails is not presented as an unsaved retry", async () => {
  const f = fixture(); f.read(async () => { throw new Error("offline"); });
  const result = await save(f.options); assert.equal(result.detail, null); assert.equal(result.result.success, true); assert.equal(f.calls.length, 1);
});
