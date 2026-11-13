const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_PROJECTS = 128;
const MAX_STORE_BYTES = 512 * 1024;
const ID = /^[a-f0-9]{32}$/;
const CONTROLS = /[\u0000-\u001f\u007f]/;
const STATE_KEYS = ["schema", "activeProjectId", "projects"];
const ENTRY_KEYS = ["id", "name", "notesDirectory", "collectionName", "legacy", "noteCount"];

function fail(code) {
  const error = new Error(`Project registry: ${code}`);
  error.code = code;
  throw error;
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) fail("INVALID_SCHEMA");
}

function text(value, max) {
  if (typeof value !== "string" || !value || value.length > max
    || value.trim() !== value || CONTROLS.test(value)) fail("INVALID_TEXT");
  return value;
}

function projectName(value) {
  return text(value, 120).normalize("NFC");
}

function pathKey(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function absolutePath(value) {
  text(value, 1024);
  if (!path.isAbsolute(value) || /^\\\\[?.]\\/.test(value)) fail("INVALID_PATH");
  return path.resolve(value);
}

function overlaps(left, right) {
  const a = pathKey(left);
  const b = pathKey(right);
  const child = (parent, candidate) => candidate.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  return a === b || child(a, b) || child(b, a);
}

function validateProjectState(value) {
  exactKeys(value, STATE_KEYS);
  if (value.schema !== 1 || !Array.isArray(value.projects)
    || !value.projects.length || value.projects.length > MAX_PROJECTS) fail("INVALID_SCHEMA");
  const ids = new Set();
  const collections = new Set();
  const projects = value.projects.map((entry, index) => {
    const detached = entry?.detached === true;
    exactKeys(entry, detached ? [...ENTRY_KEYS, "detached"] : ENTRY_KEYS);
    if (typeof entry.id !== "string" || !ID.test(entry.id) || ids.has(entry.id)) fail("INVALID_ID");
    ids.add(entry.id);
    const name = projectName(entry.name);
    if (name !== entry.name) fail("INVALID_NAME");
    const directory = absolutePath(entry.notesDirectory);
    if (directory !== entry.notesDirectory) fail("NONCANONICAL_PATH");
    const collection = text(entry.collectionName, 255);
    if (typeof entry.legacy !== "boolean" || entry.legacy !== (index === 0)
      || (!entry.legacy && collection !== `noda_project_${entry.id}`)
      || collections.has(collection)) fail("INVALID_COLLECTION");
    collections.add(collection);
    if (entry.noteCount !== null && (!Number.isSafeInteger(entry.noteCount) || entry.noteCount < 0)) fail("INVALID_COUNT");
    return Object.freeze({ id: entry.id, name, notesDirectory: directory,
      collectionName: collection, legacy: entry.legacy, noteCount: entry.noteCount,
      ...(detached ? { detached: true } : {}) });
  });
  for (let i = 0; i < projects.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (overlaps(projects[i].notesDirectory, projects[j].notesDirectory)) fail("OVERLAPPING_DIRECTORIES");
    }
  }
  if (!projects.some(entry => entry.id === value.activeProjectId && !entry.detached)) fail("UNKNOWN_PROJECT");
  return Object.freeze({ schema: 1, activeProjectId: value.activeProjectId, projects: Object.freeze(projects) });
}

function parseStore(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { fail("CORRUPT_STORE"); }
  // JSON.parse accepts duplicate keys; reject them even when escaped differently.
  const stack = [];
  for (const token of raw.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],]/g) || []) {
    if (token === "{" || token === "[") stack.push({ object: token === "{", key: true, keys: new Set() });
    else if (token === "}" || token === "]") stack.pop();
    else if (token === ",") { if (stack.at(-1)?.object) stack.at(-1).key = true; }
    else if (stack.at(-1)?.object && stack.at(-1).key) {
      const key = JSON.parse(token);
      if (stack.at(-1).keys.has(key)) fail("DUPLICATE_KEY");
      stack.at(-1).keys.add(key);
      stack.at(-1).key = false;
    }
  }
  return validateProjectState(value);
}

function createDesktopProjects(filePath, options = {}) {
  const io = options.fs || fs;
  // Native resolution expands Windows short names consistently with the backend and backups.
  const realpath = value => typeof io.realpathSync.native === "function"
    ? io.realpathSync.native(value) : io.realpathSync(value);
  const makeId = options.idFactory || (() => crypto.randomBytes(16).toString("hex"));
  const storePath = absolutePath(filePath);
  const parent = path.dirname(storePath);

  function inspectDirectory(value) {
    const directory = absolutePath(value);
    let cursor = directory;
    while (true) {
      const stat = io.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_DIRECTORY");
      if (pathKey(realpath(cursor)) !== pathKey(cursor)) fail("DIRECTORY_ALIAS");
      const ancestor = path.dirname(cursor);
      if (ancestor === cursor) break;
      cursor = ancestor;
    }
    return realpath(directory);
  }

  function checkStoreParent(create) {
    let ancestor = parent;
    while (!io.existsSync(ancestor)) {
      const next = path.dirname(ancestor);
      if (next === ancestor) fail("UNSAFE_DIRECTORY");
      ancestor = next;
    }
    inspectDirectory(ancestor);
    if (create) io.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (io.existsSync(parent)) inspectDirectory(parent);
  }

  function load() {
    checkStoreParent(false);
    let stat;
    try { stat = io.lstatSync(storePath); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) fail("UNSAFE_STORE");
    const fd = io.openSync(storePath, "r");
    try {
      const bytes = Buffer.alloc(MAX_STORE_BYTES + 1);
      const size = io.readSync(fd, bytes, 0, bytes.length, 0);
      if (size > MAX_STORE_BYTES) fail("UNSAFE_STORE");
      return parseStore(bytes.subarray(0, size).toString("utf8"));
    } finally { io.closeSync(fd); }
  }

  function commit(previous, next) {
    const before = previous === null ? null : validateProjectState(previous);
    const after = validateProjectState(next);
    if (before) {
      if (after.projects.length < before.projects.length || after.projects.length > before.projects.length + 1) fail("INVALID_TRANSITION");
      before.projects.forEach((entry, index) => {
        for (const key of ["id", "notesDirectory", "collectionName", "legacy"]) {
          if (entry[key] !== after.projects[index][key]) fail("INVALID_TRANSITION");
        }
      });
    } else if (after.projects.length !== 1) fail("INVALID_TRANSITION");
    checkStoreParent(true);
    // main serializes mutations in the single app instance; CAS rejects stale proposals.
    if (JSON.stringify(load()) !== JSON.stringify(before)) fail("STALE_STATE");
    const temporary = path.join(parent, `.projects-${crypto.randomBytes(16).toString("hex")}.tmp`);
    let fd;
    let owned = false;
    try {
      fd = io.openSync(temporary, "wx", 0o600);
      owned = true;
      io.writeFileSync(fd, JSON.stringify(after, null, 2) + "\n", "utf8");
      io.fsyncSync(fd);
      io.closeSync(fd);
      fd = undefined;
      io.renameSync(temporary, storePath);
      owned = false;
      return after;
    } finally {
      if (fd !== undefined) io.closeSync(fd);
      if (owned) io.unlinkSync(temporary);
    }
  }

  function newEntry(state, name, directory, legacy = false, collectionName) {
    const id = makeId();
    if (typeof id !== "string" || !ID.test(id) || state?.projects.some(entry => entry.id === id)) fail("INVALID_ID");
    const entry = { id, name: projectName(name), notesDirectory: directory,
      collectionName: legacy ? collectionName : `noda_project_${id}`, legacy, noteCount: null };
    return validateProjectState({ schema: 1, activeProjectId: id, projects: [...(state?.projects || []), entry] });
  }

  function bootstrap({ notesDirectory, collectionName, name }) {
    const existing = load();
    if (existing) return existing;
    return commit(null, newEntry(null, name, inspectDirectory(notesDirectory), true, collectionName));
  }

  function addExisting(state, { name, notesDirectory }) {
    const current = validateProjectState(state);
    if (current.projects.length >= MAX_PROJECTS) fail("PROJECT_LIMIT");
    return newEntry(current, name, inspectDirectory(notesDirectory));
  }

  function createFolder(state, { name, parentDirectory }) {
    const current = validateProjectState(state);
    if (current.projects.length >= MAX_PROJECTS) fail("PROJECT_LIMIT");
    const child = projectName(name);
    if (/[\\/:*?"<>|]/.test(child) || /[. ]$/.test(child)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(child)) fail("INVALID_FOLDER_NAME");
    const directory = path.join(inspectDirectory(parentDirectory), child);
    const proposal = newEntry(current, child, directory);
    io.mkdirSync(directory, { recursive: false, mode: 0o700 });
    // A later switch failure leaves this empty directory for the user; never delete a vault.
    if (inspectDirectory(directory) !== directory) fail("DIRECTORY_ALIAS");
    return proposal;
  }

  function activate(state, id, reconnect = false) {
    const current = validateProjectState(state);
    const entry = current.projects.find(project => project.id === id);
    if (!entry || (entry.detached && !reconnect)) fail("UNKNOWN_PROJECT");
    if (inspectDirectory(entry.notesDirectory) !== entry.notesDirectory) fail("DIRECTORY_ALIAS");
    if (!entry.detached) return validateProjectState({ ...current, activeProjectId: id });
    const { detached, ...restored } = entry;
    return validateProjectState({ ...current, activeProjectId: id,
      projects: current.projects.map(project => project.id === id ? restored : project) });
  }

  function updateProject(state, id, patch) {
    const current = validateProjectState(state);
    if (!current.projects.some(entry => entry.id === id && !entry.detached)) fail("UNKNOWN_PROJECT");
    return validateProjectState({ ...current, projects: current.projects.map(entry => entry.id === id ? { ...entry, ...patch } : entry) });
  }

  function detach(state, id) {
    if (state.activeProjectId === id) fail("ACTIVE_PROJECT");
    return updateProject(state, id, { detached: true });
  }

  function directoryFor(state, id) {
    const entry = validateProjectState(state).projects.find(project => project.id === id && !project.detached);
    if (!entry) fail("UNKNOWN_PROJECT");
    const directory = inspectDirectory(entry.notesDirectory);
    if (directory !== entry.notesDirectory) fail("DIRECTORY_ALIAS");
    return directory;
  }

  function backupDestination(state, value) {
    const directory = inspectDirectory(value), key = pathKey(directory);
    if (validateProjectState(state).projects.some(entry => {
      const root = pathKey(entry.notesDirectory);
      return key === root || key.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    })) fail("BACKUP_INSIDE_PROJECT");
    return directory;
  }

  return Object.freeze({ load, bootstrap, addExisting, createFolder, activate,
    reconnect: (state, id) => activate(state, id, true),
    updateCount: (state, id, noteCount) => updateProject(state, id, { noteCount }),
    rename: (state, id, name) => updateProject(state, id, { name: projectName(name) }),
    detach, directoryFor, backupDestination, commit });
}

module.exports = { MAX_PROJECTS, MAX_STORE_BYTES, createDesktopProjects, validateProjectState };
