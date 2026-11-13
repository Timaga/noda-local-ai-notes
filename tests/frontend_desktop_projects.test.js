const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { MAX_PROJECTS, MAX_STORE_BYTES, createDesktopProjects, validateProjectState } = require("../frontend/desktop_projects");

function workspace(run) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noda-project-registry-")));
  let serial = 0;
  const idFactory = () => (++serial).toString(16).padStart(32, "0");
  const file = path.join(root, "profile", "projects.json");
  const vault = path.join(root, "old-vault");
  fs.mkdirSync(vault);
  const registry = createDesktopProjects(file, { idFactory });
  const bootstrap = () => registry.bootstrap({ name: "Мои заметки", notesDirectory: vault, collectionName: "existing_notes" });
  try { return run({ root, vault, file, registry, bootstrap, idFactory }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function throwsCode(run, code) {
  assert.throws(run, error => error.code === code);
}

function throwsUnsafeDirectory(run) {
  assert.throws(run, error => ["UNSAFE_DIRECTORY", "DIRECTORY_ALIAS"].includes(error.code));
}

function copy(state) { return JSON.parse(JSON.stringify(state)); }

test("initial import preserves note bytes, legacy collection, stable ID and unknown count", () => workspace(({ vault, file, registry, bootstrap }) => {
  const note = path.join(vault, "old.md");
  const bytes = Buffer.from("---\ntitle: Старое\n---\nИсходный текст\n", "utf8");
  fs.writeFileSync(note, bytes);
  assert.equal(registry.load(), null);
  const state = bootstrap();
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].collectionName, "existing_notes");
  assert.equal(state.projects[0].legacy, true);
  assert.equal(state.projects[0].noteCount, null);
  assert.equal(state.activeProjectId, state.projects[0].id);
  assert.deepEqual(fs.readFileSync(note), bytes);
  assert.deepEqual(fs.readdirSync(vault), ["old.md"]);
  assert.deepEqual(registry.load(), state);
  assert.deepEqual(createDesktopProjects(file).bootstrap({}), state);
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.projects) && Object.isFrozen(state.projects[0]));
  assert.equal(fs.statSync(file).isFile(), true);
}));

test("proposals never persist until commit and projects have separate collections", () => workspace(({ root, file, registry, bootstrap }) => {
  const initial = bootstrap();
  const before = fs.readFileSync(file);
  const second = path.join(root, "work");
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(second, "a.md"), "work note");
  const proposed = registry.addExisting(initial, { name: "Работа", notesDirectory: second });
  const added = proposed.projects[1];
  assert.equal(proposed.activeProjectId, added.id);
  assert.equal(added.collectionName, `noda_project_${added.id}`);
  assert.equal(added.legacy, false);
  assert.equal(added.noteCount, null);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(registry.load(), initial);
  assert.deepEqual(registry.commit(initial, proposed), proposed);
  assert.deepEqual(registry.load(), proposed);
  const switched = registry.activate(proposed, initial.activeProjectId);
  assert.equal(switched.activeProjectId, initial.activeProjectId);
  assert.equal(registry.load().activeProjectId, added.id);
  const counted = registry.updateCount(switched, added.id, 0);
  assert.equal(counted.projects[1].noteCount, 0);
  registry.commit(proposed, counted);
  assert.equal(registry.load().projects[1].noteCount, 0);
  assert.equal(fs.readFileSync(path.join(second, "a.md"), "utf8"), "work note");
}));

test("disconnected inactive folders do not prevent load or activation of another project", () => workspace(({ root, registry, bootstrap }) => {
  const initial = bootstrap();
  const second = path.join(root, "removable");
  fs.mkdirSync(second);
  const next = registry.addExisting(initial, { name: "Диск", notesDirectory: second });
  registry.commit(initial, next);
  fs.rmdirSync(second);
  assert.deepEqual(registry.load(), next);
  assert.equal(registry.activate(next, initial.activeProjectId).activeProjectId, initial.activeProjectId);
  assert.throws(() => registry.activate(next, next.activeProjectId), { code: "ENOENT" });
  assert.deepEqual(registry.load(), next);
}));

test("same or recursively overlapping vault roots are refused in both directions", () => workspace(({ root, vault, registry, bootstrap }) => {
  const state = bootstrap();
  const child = path.join(vault, "archive");
  fs.mkdirSync(child);
  for (const directory of [vault, child, root, path.join(vault, ".")]) {
    throwsCode(() => registry.addExisting(state, { name: "Conflict", notesDirectory: directory }), "OVERLAPPING_DIRECTORIES");
  }
  if (process.platform === "win32") {
    throwsCode(() => registry.addExisting(state, { name: "Case alias", notesDirectory: vault.toUpperCase() }), "OVERLAPPING_DIRECTORIES");
  }
  throwsCode(() => registry.createFolder(state, { name: "nested", parentDirectory: vault }), "OVERLAPPING_DIRECTORIES");
  assert.equal(fs.existsSync(path.join(vault, "nested")), false);
}));

test("junction/symlink roots and ancestors cannot be registered, activated or used for storage", () => workspace(({ root, vault, registry, bootstrap }) => {
  const state = bootstrap();
  const target = path.join(root, "target");
  const link = path.join(root, "alias");
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(target, "child"));
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  for (const directory of [link, path.join(link, "child")]) {
    throwsUnsafeDirectory(() => registry.addExisting(state, { name: "Alias", notesDirectory: directory }));
  }
  const savedAlias = copy(state);
  savedAlias.projects[0].notesDirectory = link;
  throwsCode(() => registry.activate(savedAlias, savedAlias.activeProjectId), "UNSAFE_DIRECTORY");
  throwsCode(() => createDesktopProjects(path.join(link, "projects.json")).load(), "UNSAFE_DIRECTORY");
  const replacement = path.join(root, "replacement");
  fs.renameSync(vault, replacement);
  fs.symlinkSync(replacement, vault, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(registry.load(), state);
  throwsCode(() => registry.activate(state, state.activeProjectId), "UNSAFE_DIRECTORY");
}));

test("new folder is empty and exclusive, with no automatic cleanup after cancelled switch", () => workspace(({ root, file, registry, bootstrap }) => {
  const state = bootstrap();
  const before = fs.readFileSync(file);
  const proposed = registry.createFolder(state, { name: "Новый проект", parentDirectory: root });
  assert.deepEqual(fs.readdirSync(proposed.projects[1].notesDirectory), []);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => registry.createFolder(state, { name: "Новый проект", parentDirectory: root }), { code: "EEXIST" });
  assert.equal(fs.existsSync(proposed.projects[1].notesDirectory), true);
  registry.commit(state, proposed);
  assert.deepEqual(registry.load(), proposed);
}));

test("folder traversal, unsafe device names, invalid paths and missing folders fail before persistence", () => workspace(({ root, file, registry, bootstrap }) => {
  const state = bootstrap();
  const before = fs.readFileSync(file);
  for (const name of [".", "..", "../outside", "a/b", "a\\b", "C:evil", "a?", "a.", "CON", "nul.txt", "COM1", "LPT9.md"]) {
    throwsCode(() => registry.createFolder(state, { name, parentDirectory: root }), "INVALID_FOLDER_NAME");
  }
  for (const name of ["", " ", " padded", "x\n", "a".repeat(121), null, 4]) {
    throwsCode(() => registry.addExisting(state, { name, notesDirectory: root }), "INVALID_TEXT");
  }
  for (const notesDirectory of ["relative", "", " x", "x\0y", "\\\\?\\C:\\vault"]) {
    assert.throws(() => registry.addExisting(state, { name: "New", notesDirectory }));
  }
  assert.throws(() => registry.addExisting(state, { name: "New", notesDirectory: path.join(root, "missing") }), { code: "ENOENT" });
  assert.deepEqual(fs.readFileSync(file), before);
}));

test("strict schema rejects invalid fields, counts, names, IDs and collection reassignment", () => workspace(({ root, registry, bootstrap }) => {
  const state = bootstrap();
  const invalid = [
    value => { value.extra = true; }, value => { delete value.schema; },
    value => { value.schema = 2; }, value => { value.projects = []; },
    value => { value.projects = {}; }, value => { value.activeProjectId = "missing"; },
    value => { value.projects[0].extra = true; }, value => { value.projects[0].id = "INVALID"; },
    value => { value.projects[0].notesDirectory = path.join(root, "x") + path.sep + ".."; },
    value => { value.projects[0].notesDirectory = "relative"; },
    value => { value.projects[0].name = "e\u0301"; }, value => { value.projects[0].legacy = false; },
    value => { value.projects[0].legacy = 1; }, value => { value.projects[0].collectionName = " "; },
    value => { value.projects[0].noteCount = -1; }, value => { value.projects[0].noteCount = 0.5; },
    value => { value.projects[0].noteCount = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.projects[0].noteCount = "2"; }, value => { value.projects[0].noteCount = false; },
  ];
  for (const mutation of invalid) {
    const value = copy(state);
    mutation(value);
    assert.throws(() => validateProjectState(value));
  }
  for (const value of [null, [], 1, "state"]) throwsCode(() => validateProjectState(value), "INVALID_SCHEMA");
  const normal = copy(state);
  normal.projects[0].name = "a".repeat(120);
  normal.projects[0].noteCount = Number.MAX_SAFE_INTEGER;
  assert.equal(validateProjectState(normal).projects[0].name.length, 120);
  assert.equal(registry.updateCount(state, state.activeProjectId, null).projects[0].noteCount, null);
  throwsCode(() => registry.updateCount(state, "missing", 1), "UNKNOWN_PROJECT");
  throwsCode(() => registry.activate(state, "missing"), "UNKNOWN_PROJECT");
}));

test("new collection identities, duplicate IDs, collections and legacy flags are enforced", () => workspace(({ root, registry, bootstrap }) => {
  const state = bootstrap();
  const directory = path.join(root, "new");
  fs.mkdirSync(directory);
  const second = registry.addExisting(state, { name: "Second", notesDirectory: directory });
  for (const change of [
    value => { value.projects[1].id = value.projects[0].id; },
    value => { value.projects[1].collectionName = "wrong"; },
    value => { value.projects[1].legacy = true; },
  ]) {
    const value = copy(second); change(value);
    assert.throws(() => validateProjectState(value));
  }
  const sameCollection = copy(second);
  sameCollection.projects[0].collectionName = sameCollection.projects[1].collectionName;
  throwsCode(() => validateProjectState(sameCollection), "INVALID_COLLECTION");
  const invalidId = createDesktopProjects(path.join(root, "other.json"), { idFactory: () => "bad" });
  throwsCode(() => invalidId.bootstrap({ name: "X", notesDirectory: directory, collectionName: "notes" }), "INVALID_ID");
  const duplicateId = createDesktopProjects(path.join(root, "other.json"), { idFactory: () => state.activeProjectId });
  throwsCode(() => duplicateId.addExisting(state, { name: "X", notesDirectory: directory }), "INVALID_ID");
}));

test("registry limits are bounded without scanning offline folders", () => workspace(({ root, registry, bootstrap }) => {
  const initial = bootstrap();
  const value = copy(initial);
  for (let number = 1; number < MAX_PROJECTS; number += 1) {
    const id = (number + 10).toString(16).padStart(32, "0");
    value.projects.push({ id, name: `Project ${number}`, notesDirectory: path.join(root, `offline-${number}`),
      collectionName: `noda_project_${id}`, legacy: false, noteCount: null });
  }
  assert.equal(validateProjectState(value).projects.length, 128);
  throwsCode(() => registry.addExisting(value, { name: "Over", notesDirectory: root }), "PROJECT_LIMIT");
  throwsCode(() => registry.createFolder(value, { name: "Over", parentDirectory: root }), "PROJECT_LIMIT");
  value.projects.push(value.projects[1]);
  throwsCode(() => validateProjectState(value), "INVALID_SCHEMA");
}));

test("corrupt, duplicate-key, unknown-field and oversized stores fail closed without overwriting", () => workspace(({ file, registry, bootstrap }) => {
  const state = bootstrap();
  const invalid = ["{invalid", "null", "[]", JSON.stringify({ ...state, extra: 1 }),
    JSON.stringify(state).replace('"schema":1', '"schema":1,"schema":1'),
    JSON.stringify(state).replace('"schema":1', '"schema":1,"\\u0073chema":1'),
    JSON.stringify(state).replace('"noteCount":null', '"noteCount":null,"noteCount":0'),
    " ".repeat(MAX_STORE_BYTES + 1)];
  for (const raw of invalid) {
    fs.writeFileSync(file, raw, "utf8");
    assert.throws(() => registry.load());
    assert.throws(() => bootstrap());
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  }
}));

test("store symlinks, non-file stores, file targets and canonical aliases fail closed", () => workspace(({ root, file, registry, bootstrap }) => {
  const state = bootstrap();
  const foreign = path.join(root, "foreign.json");
  fs.renameSync(file, foreign);
  fs.symlinkSync(foreign, file, process.platform === "win32" ? "file" : undefined);
  throwsCode(() => registry.load(), "UNSAFE_STORE");
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  throwsCode(() => registry.load(), "UNSAFE_STORE");
  throwsCode(() => registry.addExisting(state, { name: "File", notesDirectory: foreign }), "UNSAFE_DIRECTORY");
  const aliasIo = { ...fs, realpathSync(value) { return value === root ? path.join(root, "alias") : fs.realpathSync(value); } };
  throwsCode(() => createDesktopProjects(path.join(root, "new.json"), { fs: aliasIo }).load(), "DIRECTORY_ALIAS");
}));

test("CAS prevents stale updates and commit cannot remove or repoint projects", () => workspace(({ root, registry, bootstrap }) => {
  const initial = bootstrap();
  const counted = registry.updateCount(initial, initial.activeProjectId, 3);
  registry.commit(initial, counted);
  throwsCode(() => registry.commit(initial, registry.updateCount(initial, initial.activeProjectId, 7)), "STALE_STATE");
  throwsCode(() => registry.commit(null, initial), "STALE_STATE");
  const repointed = copy(counted);
  repointed.projects[0].notesDirectory = path.join(root, "somewhere");
  throwsCode(() => registry.commit(counted, repointed), "INVALID_TRANSITION");
  const secondPath = path.join(root, "second"); fs.mkdirSync(secondPath);
  const second = registry.addExisting(counted, { name: "Second", notesDirectory: secondPath });
  registry.commit(counted, second);
  throwsCode(() => registry.commit(second, counted), "INVALID_TRANSITION");
  throwsCode(() => registry.commit(null, second), "INVALID_TRANSITION");
  const thirdPath = path.join(root, "third"); fs.mkdirSync(thirdPath);
  const third = registry.addExisting(second, { name: "Third", notesDirectory: thirdPath });
  throwsCode(() => registry.commit(initial, third), "INVALID_TRANSITION");
  assert.deepEqual(registry.load(), second);
}));

test("atomic rename and write failures retain old registry and clean only own temporary files", () => workspace(({ root, file, registry, bootstrap }) => {
  const initial = bootstrap();
  const before = fs.readFileSync(file);
  const foreign = path.join(path.dirname(file), "foreign.tmp");
  fs.writeFileSync(foreign, "leave alone");
  for (const method of ["renameSync", "writeFileSync", "fsyncSync"]) {
    const io = { ...fs, [method]() { throw Object.assign(new Error("simulated disk failure"), { code: "EIO" }); } };
    const failing = createDesktopProjects(file, { fs: io });
    assert.throws(() => failing.commit(initial, failing.updateCount(initial, initial.activeProjectId, 8)), { code: "EIO" });
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["foreign.tmp", "projects.json"]);
  }
  assert.equal(fs.readFileSync(foreign, "utf8"), "leave alone");
  const denied = createDesktopProjects(path.join(root, "denied.json"), { fs: { ...fs, lstatSync(value) {
    if (value.endsWith("denied.json")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return fs.lstatSync(value);
  } } });
  assert.throws(() => denied.load(), { code: "EACCES" });
}));

test("empty folder remains after post-create validation error; existing vault files remain untouched", () => workspace(({ root, registry, bootstrap }) => {
  const state = bootstrap();
  const child = path.join(root, "Created");
  const io = { ...fs, lstatSync(value) {
    if (value === child && fs.existsSync(child)) throw Object.assign(new Error("disconnected"), { code: "EIO" });
    return fs.lstatSync(value);
  } };
  const failing = createDesktopProjects(path.join(root, "uncommitted.json"), { fs: io });
  assert.throws(() => failing.createFolder(state, { name: "Created", parentDirectory: root }), { code: "EIO" });
  assert.deepEqual(fs.readdirSync(child), []);
  assert.deepEqual(registry.load(), state);
}));
