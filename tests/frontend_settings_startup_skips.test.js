"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function settingsView() {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        checked: false, disabled: false, textContent: "", className: "",
        replaceChildren() {}, addEventListener() {},
      });
      return elements.get(id);
    },
  };
  const window = {
    nodaI18n: { t: ru => ru },
    noteModelPairPicker: { render: () => true },
  };
  const script = path.join(__dirname, "../frontend/notes_settings_note_pairs.js");
  vm.runInNewContext(fs.readFileSync(script, "utf8"), { window, document }, { filename: script });
  return { view: window.notesSettingsNotePairs, elements };
}

const plain = value => JSON.parse(JSON.stringify(value));

test("legacy settings default all three saved pair screens to skip", () => {
  const { view } = settingsView();
  view.renderStartup({ skipModelSelection: false });
  assert.deepEqual(plain(view.startupSettings()), {
    skipNoteTitleSelection: true,
    skipNoteTagsSelection: true,
    skipNoteLinksSelection: true,
  });
});

test("each startup choice remains independent and restoring a saved snapshot discards its draft", () => {
  const { view, elements } = settingsView();
  const saved = { skipNoteTitleSelection: false, skipNoteTagsSelection: true, skipNoteLinksSelection: false };
  view.renderStartup(saved);
  assert.deepEqual(plain(view.startupSettings()), saved);
  elements.get("settings-skip-note-tags").checked = false;
  assert.deepEqual(plain(view.startupSettings()), { ...saved, skipNoteTagsSelection: false });
  view.renderStartup(saved);
  assert.deepEqual(plain(view.startupSettings()), saved);
});

test("refreshing model pairs preserves unsaved startup choices and their fieldset is disabled during work", () => {
  const { view, elements } = settingsView();
  view.renderStartup({ skipNoteTitleSelection: false });
  const before = plain(view.startupSettings());
  const selection = { title: "title_pair", tags: "tags_pair", links: "links_pair" };
  view.render({ enabled: true, configured: true, selection,
    catalog: Object.keys(selection).map(id => ({ id })) }, async () => {});
  assert.deepEqual(plain(view.startupSettings()), before);
  view.setDisabled(true);
  assert.equal(elements.get("settings-note-pairs-fields").disabled, true);
  assert.equal(elements.get("settings-note-pairs-apply").disabled, true);
  view.setDisabled(false);
  assert.equal(elements.get("settings-note-pairs-fields").disabled, false);
});
