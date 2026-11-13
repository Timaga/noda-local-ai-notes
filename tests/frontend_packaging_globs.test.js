"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const test = require("node:test");

const frontendRequire = createRequire(path.join(__dirname, "../frontend/package.json"));
const { FileMatcher } = frontendRequire("app-builder-lib/out/fileMatcher");
const asar = frontendRequire("@electron/asar");
const universalRequire = createRequire(frontendRequire.resolve("@electron/universal"));

function workspace(t) {
  const base = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(base, "noda-packaging-")));
  assert.ok(root.startsWith(base + path.sep));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(root, relative, content = "Synthetic packaging fixture\n") {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function filterAt(root, patterns) {
  return new FileMatcher(root, path.join(root, "destination"), value => value, patterns).createFilter();
}

test("packaging preserves includes, exclusions, re-includes and dotfiles", t => {
  const root = workspace(t);
  const filter = filterAt(root, ["**/*", "!cache/**/*", "cache/keep.json", "!**/*.map"]);
  for (const [name, expected] of [
    ["main.js", true], ["assets/.metadata", true], ["LICENSE", true],
    ["cache/private.txt", false], ["cache/keep.json", true], ["main.js.map", false],
  ]) {
    const file = fixture(root, name);
    assert.equal(filter(file, fs.statSync(file)), expected, name);
  }
});

test("packaging traverses intermediate folders and expands literal directories", t => {
  const root = workspace(t);
  const target = fixture(root, "assets/nested/icons/logo.svg");
  fixture(root, "other/unused.txt");
  const filter = filterAt(root, ["assets"]);
  for (const relative of ["assets", "assets/nested", "assets/nested/icons"]) {
    const directory = path.join(root, relative);
    assert.equal(filter(directory, fs.statSync(directory)), true, relative);
  }
  assert.equal(filter(target, fs.statSync(target)), true);
  const unrelated = path.join(root, "other");
  assert.equal(filter(unrelated, fs.statSync(unrelated)), false);
});

test("packaging matches brace patterns and normalizes Windows separators", t => {
  const root = workspace(t);
  const filter = filterAt(root, ["assets\\**\\*.{svg,png}"]);
  for (const [name, expected] of [
    ["assets/logo.svg", true], ["assets/nested/logo.png", true],
    ["assets/logo.txt", false], ["docs/logo.svg", false],
  ]) {
    const file = fixture(root, name);
    assert.equal(filter(file, fs.statSync(file)), expected, name);
  }
});

test("legacy directory comparison still applies include filters", async t => {
  const root = workspace(t);
  const left = path.join(root, "left");
  const right = path.join(root, "right");
  for (const folder of [left, right]) {
    fixture(folder, "same.txt", "Same text\n");
  }
  fixture(left, "ignored.js", "Left only\n");
  const comparison = await frontendRequire("dir-compare").compare(left, right, {
    includeFilter: "*.txt", compareContent: true,
  });
  assert.equal(comparison.same, true);
});

test("ASAR creation preserves application files through legacy glob consumers", async t => {
  const root = workspace(t);
  const source = path.join(root, "source");
  const archive = path.join(root, "application.asar");
  fixture(source, "package.json", '{"name":"synthetic-packaging-fixture"}\n');
  fixture(source, "assets/.metadata", "Synthetic dotfile\n");
  fixture(source, "shared/common.txt", "Synthetic nested content\n");
  await asar.createPackage(source, archive);
  assert.equal(asar.extractFile(archive, "package.json").toString(),
    '{"name":"synthetic-packaging-fixture"}\n');
  assert.equal(asar.extractFile(archive, path.join("assets", ".metadata")).toString(),
    "Synthetic dotfile\n");
  assert.equal(asar.extractFile(archive, path.join("shared", "common.txt")).toString(),
    "Synthetic nested content\n");
});

test("universal's resolved matcher preserves basename allowlist boundaries", () => {
  const { minimatch } = universalRequire("minimatch");
  const options = { matchBase: true };
  assert.equal(minimatch("native/engine.node", "*.node", options), true);
  assert.equal(minimatch("native/engine.txt", "*.node", options), false);
  assert.equal(minimatch("nested/Info.plist", "Info.plist", options), true);
  assert.equal(minimatch("nested/Info.plist.backup", "Info.plist", options), false);
});
