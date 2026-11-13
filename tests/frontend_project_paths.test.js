"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { resolveProjectRoot } = require("../frontend/project_paths");

const pythonMarker = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
const markers = ["backend/app_runtime.py", "frontend/package.json", pythonMarker];
const main = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");

function mainSection(begin, end) {
  const start = main.indexOf(begin);
  const finish = main.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && finish > start, "the actual main-process section exists");
  return main.slice(start, finish);
}

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "noda-project-paths-"));
  assert.ok(path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const project = path.join(folder, "Локальный проект");
  for (const marker of markers) {
    const filename = path.join(project, marker);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, "synthetic test fixture");
  }
  const resources = path.join(folder, "resources");
  fs.mkdirSync(resources);
  const configFile = path.join(resources, "noda-project.json");
  const write = value => fs.writeFileSync(configFile, JSON.stringify(value));
  write({ schema: 1, projectRoot: project });
  return {
    project, resources, configFile, write,
    options: { isPackaged: true, resourcesPath: resources, frontendDir: path.join(resources, "app.asar") },
  };
}

test("development launch keeps the existing checkout root without requiring a sidecar", () => {
  const frontendDir = path.join(os.tmpdir(), "noda-dev-checkout", "frontend");
  assert.equal(resolveProjectRoot({ isPackaged: false, frontendDir }), path.dirname(frontendDir));
});

test("packaged launch resolves the explicit local project with spaces and Cyrillic", t => {
  const value = fixture(t);
  assert.equal(resolveProjectRoot(value.options), value.project);
  assert.equal(resolveProjectRoot({ ...value.options, frontendDir: path.join(value.resources, "other") }), value.project);
});

test("packaged launch fails safely when its sidecar is missing or malformed", t => {
  const value = fixture(t);
  for (const raw of ["", "{", "null", "[]", JSON.stringify({ schema: 1 }), " ".repeat(4097)]) {
    fs.writeFileSync(value.configFile, raw);
    assert.throws(() => resolveProjectRoot(value.options), /Не удалось найти локальный проект Noda/);
  }
  fs.unlinkSync(value.configFile);
  assert.throws(() => resolveProjectRoot(value.options), /Не удалось найти локальный проект Noda/);
  fs.mkdirSync(value.configFile);
  assert.throws(() => resolveProjectRoot(value.options), /Не удалось найти локальный проект Noda/);
});

test("packaged launch validates schema and rejects ambiguous or nonabsolute roots", t => {
  const value = fixture(t);
  for (const config of [
    { schema: 2, projectRoot: value.project },
    { schema: "1", projectRoot: value.project },
    { schema: 1, projectRoot: "relative/project" },
    { schema: 1, projectRoot: "" },
    { schema: 1, projectRoot: 123 },
    { schema: 1, projectRoot: value.project + " " },
    { schema: 1, projectRoot: value.project + "\0" },
    { schema: 1, projectRoot: value.project, extra: true },
  ]) {
    value.write(config);
    assert.throws(() => resolveProjectRoot(value.options), /Не удалось найти локальный проект Noda/);
  }
});

test("packaged launch requires the actual backend, frontend manifest, and local Python", t => {
  const value = fixture(t);
  for (const marker of markers) {
    const filename = path.join(value.project, marker);
    fs.unlinkSync(filename);
    assert.throws(() => resolveProjectRoot(value.options), /Не удалось найти локальный проект Noda/);
    fs.mkdirSync(filename);
    assert.throws(() => resolveProjectRoot(value.options), /Не удалось найти локальный проект Noda/);
    fs.rmdirSync(filename);
    fs.writeFileSync(filename, "synthetic test fixture");
  }
  value.write({ schema: 1, projectRoot: value.configFile });
  assert.throws(() => resolveProjectRoot(value.options), /Не удалось найти локальный проект Noda/);
});

test("packaged errors do not expose the configured project path or raw parser text", t => {
  const value = fixture(t);
  const privateMarker = "PRIVATE-FIXTURE-123";
  value.write({ schema: 1, projectRoot: path.join(value.resources, privateMarker) });
  assert.throws(() => resolveProjectRoot(value.options), error => {
    assert.equal(error.message.includes(privateMarker), false);
    assert.equal(error.message.includes(value.resources), false);
    return true;
  });
});

test("packaged launch rejects a linked project directory", t => {
  const value = fixture(t);
  const alias = path.join(value.resources, "project-link");
  fs.symlinkSync(value.project, alias, process.platform === "win32" ? "junction" : "dir");
  value.write({ schema: 1, projectRoot: alias });
  assert.throws(() => resolveProjectRoot(value.options), /Не удалось найти локальный проект Noda/);
  assert.equal(fs.readFileSync(path.join(value.project, markers[0]), "utf8"), "synthetic test fixture");
});

test("actual packaged main resolves backend paths from the installed sidecar", () => {
  const project = path.join(os.tmpdir(), "synthetic-local-project");
  const resources = path.join(os.tmpdir(), "synthetic-installed-app", "resources");
  const frontend = path.join(resources, "app.asar");
  let resolverCalls = 0;
  const context = vm.createContext({
    path, app: { isPackaged: true }, process: { resourcesPath: resources }, __dirname: frontend,
    resolveProjectRoot: options => {
      resolverCalls += 1;
      assert.equal(options.isPackaged, true);
      assert.equal(options.resourcesPath, resources);
      assert.equal(options.frontendDir, frontend);
      return project;
    },
  });
  const result = vm.runInContext(
    mainSection("const PROJECT_ROOT =", "const BACKEND_RUNTIME_MODULE")
      + "\n({ project: PROJECT_ROOT, backend: BACKEND_PACKAGE_DIR });",
    context
  );
  assert.equal(resolverCalls, 1);
  assert.equal(result.project, project);
  assert.equal(result.backend, path.join(project, "backend"));
});

for (const platform of ["win32", "linux"]) {
  test(`actual ${platform} Python selection uses the project root outside app.asar`, () => {
    const project = path.join(os.tmpdir(), "synthetic-local-project");
    const frontend = path.join(os.tmpdir(), "synthetic-installed-app", "resources", "app.asar");
    const executable = path.join(project, platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
    const expectedChecks = platform === "win32"
      ? [path.join(project, ".venv/Scripts/pythonw.exe"), executable]
      : [executable];
    const inspected = [];
    const context = vm.createContext({
      path, PROJECT_ROOT: project, PORTABLE_RUNTIME: null, __dirname: frontend, process: { platform },
      fs: { existsSync: filename => { inspected.push(filename); return filename === executable; } },
    });
    vm.runInContext(mainSection("function getPythonExecutable()", "function startBackendProcess()"), context);
    assert.equal(context.getPythonExecutable(), executable);
    assert.deepEqual(inspected, expectedChecks);
    assert.equal(inspected.some(filename => filename.startsWith(path.dirname(frontend))), false);
  });
}

test("actual environment loading reads the local backend folder with synthetic content only", () => {
  const backend = path.join(os.tmpdir(), "synthetic-local-project", "backend");
  const frontend = path.join(os.tmpdir(), "synthetic-installed-app", "resources", "app.asar");
  const expected = path.join(backend, ".env");
  const calls = [];
  const environment = {};
  let present = true;
  const context = vm.createContext({
    path, BACKEND_PACKAGE_DIR: backend, __dirname: frontend,
    process: { env: environment },
    console: { warn: () => assert.fail("synthetic environment loading must succeed") },
    fs: {
      existsSync: filename => { calls.push(["exists", filename]); return present && filename === expected; },
      readFileSync: (filename, encoding) => {
        calls.push(["read", filename, encoding]);
        assert.equal(filename, expected);
        return "# synthetic fixture\nNODA_SYNTHETIC_VALUE=test-only\n";
      },
    },
  });
  vm.runInContext(mainSection("function loadLocalEnvFile()", "const OWNED_NOTE_PROFILE"), context);
  context.loadLocalEnvFile();
  assert.deepEqual(calls, [["exists", expected], ["read", expected, "utf8"]]);
  assert.deepEqual(environment, { NODA_SYNTHETIC_VALUE: "test-only" });
  calls.length = 0;
  present = false;
  context.loadLocalEnvFile();
  assert.deepEqual(calls, [["exists", expected]]);
});
