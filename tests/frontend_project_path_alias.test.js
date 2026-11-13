"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { createDesktopProjects } = require("../frontend/desktop_projects");

function workspace(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noda-path-contract-")));
  assert.ok(root.startsWith(fs.realpathSync.native(os.tmpdir()) + path.sep));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notes = path.join(root, "Original notes");
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, "source.md"), "Synthetic source remains unchanged.\n");
  let serial = 0;
  const store = path.join(root, "profile", "projects.json");
  const registry = createDesktopProjects(store, {
    idFactory: () => (++serial).toString(16).padStart(32, "0"),
  });
  const state = registry.bootstrap({ name: "Original", notesDirectory: notes, collectionName: "notes" });
  return { root, notes, store, registry, state };
}

function shortPath(directory) {
  const python = process.env.NODA_TEST_PYTHON || path.join(__dirname, "../.venv/Scripts/python.exe");
  return execFileSync(python, ["-I", "-B", "-c", [
    "import ctypes, sys",
    "convert = ctypes.windll.kernel32.GetShortPathNameW",
    "convert.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]",
    "convert.restype = ctypes.c_uint",
    "size = convert(sys.argv[1], None, 0)",
    "assert size, 'The synthetic directory must have a Windows short path'",
    "buffer = ctypes.create_unicode_buffer(size)",
    "assert convert(sys.argv[1], buffer, size)",
    "print(buffer.value)",
  ].join("\n"), directory], { encoding: "utf8" }).trim();
}

test("ordinary canonical directories remain valid for project admission and backups", t => {
  const { root, notes, store, registry, state } = workspace(t);
  const target = path.join(root, "Another full folder name");
  const destination = path.join(root, "Backups");
  fs.mkdirSync(target); fs.mkdirSync(destination);
  const before = fs.readFileSync(store);
  const proposal = registry.addExisting(state, { name: "Another", notesDirectory: target });
  assert.equal(proposal.projects.at(-1).notesDirectory, fs.realpathSync.native(target));
  assert.equal(registry.backupDestination(state, destination), fs.realpathSync.native(destination));
  assert.deepEqual(fs.readFileSync(store), before, "proposals must not persist");
  assert.equal(fs.readFileSync(path.join(notes, "source.md"), "utf8"), "Synthetic source remains unchanged.\n");
});

test("actual Windows short paths are rejected before reaching project state or backups", {
  skip: process.platform !== "win32",
}, t => {
  const { root, store, registry, state } = workspace(t);
  const target = path.join(root, "Long directory for short path admission");
  fs.mkdirSync(target);
  const alias = shortPath(target);
  if (alias.toLowerCase() === fs.realpathSync.native(target).toLowerCase()) {
    t.skip("This Windows volume has no 8.3 names; the injected alias case still covers denial");
    return;
  }
  const before = fs.readFileSync(store);
  for (const operation of [
    () => registry.addExisting(state, { name: "Alias", notesDirectory: alias }),
    () => registry.backupDestination(state, alias),
    () => registry.createFolder(state, { name: "Should not exist", parentDirectory: alias }),
    () => createDesktopProjects(path.join(alias, "registry.json")).load(),
  ]) assert.throws(operation, { code: "DIRECTORY_ALIAS" });
  assert.deepEqual(fs.readFileSync(store), before);
  assert.deepEqual(registry.load(), state);
  assert.deepEqual(fs.readdirSync(target), [], "alias rejection must precede file creation");
});

test("junctions and linked ancestors remain forbidden for project and backup admission", t => {
  const { root, store, registry, state } = workspace(t);
  const target = path.join(root, "Target");
  const alias = path.join(root, "Linked");
  fs.mkdirSync(target); fs.mkdirSync(path.join(target, "Child"));
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  const before = fs.readFileSync(store);
  for (const directory of [alias, path.join(alias, "Child")]) {
    for (const operation of [
      () => registry.addExisting(state, { name: "Link", notesDirectory: directory }),
      () => registry.backupDestination(state, directory),
    ]) assert.throws(operation, error => ["UNSAFE_DIRECTORY", "DIRECTORY_ALIAS"].includes(error.code));
  }
  assert.deepEqual(fs.readFileSync(store), before);
});

test("an injected filesystem without a native resolver keeps alias denial", t => {
  const { root } = workspace(t);
  const io = { ...fs, realpathSync(value) {
    return value === root ? path.join(root, "Different directory") : fs.realpathSync(value);
  } };
  assert.throws(() => createDesktopProjects(path.join(root, "other.json"), { fs: io }).load(), {
    code: "DIRECTORY_ALIAS",
  });
});
