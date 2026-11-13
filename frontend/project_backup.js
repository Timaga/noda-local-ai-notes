"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// Match the image formats served by the note asset endpoint.
const EXTENSIONS = new Set([".md", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const samePath = (left, right) => process.platform === "win32"
  ? left.toLowerCase() === right.toLowerCase() : left === right;
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameEntry = (left, right) => sameIdentity(left, right)
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
const changed = () => Object.assign(new Error("A project file or folder changed during backup"), { code: "backup_source_changed" });
const invalidCopy = () => Object.assign(new Error("Backup verification failed"), { code: "backup_verification_failed" });

async function checkedEntry(filename, directory) {
  let stat;
  try { stat = await fs.promises.lstat(filename, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw changed();
    throw error;
  }
  if (!(directory ? stat.isDirectory() : stat.isFile())
      || !samePath(await fs.promises.realpath(filename), filename)) throw changed();
  return stat;
}

const captureProjectDirectory = directory => checkedEntry(directory, true);

async function inventory(root, staging = false) {
  const directories = new Map(), files = new Map(), pending = [""];
  while (pending.length) {
    const relative = pending.pop(), folder = path.join(root, relative);
    directories.set(relative, await checkedEntry(folder, true));
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      if (!staging && entry.name.startsWith(".")) continue;
      const item = path.join(relative, entry.name);
      if (entry.isDirectory()) pending.push(item);
      else if (entry.isFile() && (staging || EXTENSIONS.has(path.extname(entry.name).toLowerCase()))) {
        files.set(item, await checkedEntry(path.join(root, item), false));
      } else if (staging) throw invalidCopy();
    }
  }
  for (const [relative, expected] of directories) {
    if (!sameEntry(expected, await checkedEntry(path.join(root, relative), true))) throw changed();
  }
  return { directories, files };
}

function sameInventory(expected, actual) {
  return expected.size === actual.size
    && [...expected].every(([key, entry]) => actual.has(key) && sameEntry(entry, actual.get(key)));
}

async function hashFile(source, expected, target) {
  if (!sameEntry(expected, await checkedEntry(source, false))) throw changed();
  const handle = await fs.promises.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameEntry(expected, await handle.stat({ bigint: true }))) throw changed();
    const size = Number(expected.size);
    if (!Number.isSafeInteger(size)) throw invalidCopy();
    const input = size ? handle.createReadStream({ end: size - 1, autoClose: false }) : Readable.from([]);
    const hash = crypto.createHash("sha256");
    let length = 0;
    const update = chunk => { hash.update(chunk); length += chunk.length; };
    if (target) {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const digest = new Transform({ transform(chunk, _, done) { update(chunk); done(null, chunk); } });
      await pipeline(input, digest, fs.createWriteStream(target, { flags: "wx" }));
    } else {
      for await (const chunk of input) update(chunk);
    }
    if (length !== size || !sameEntry(expected, await handle.stat({ bigint: true }))
        || !sameEntry(expected, await checkedEntry(source, false))) throw changed();
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function verifyCopy(staging, expected, hashes) {
  try {
    const copied = await inventory(staging, true);
    if (copied.files.size !== expected.size) throw invalidCopy();
    for (const [relative, original] of expected) {
      const copy = copied.files.get(relative);
      if (!copy || copy.size !== original.size
          || await hashFile(path.join(staging, relative), copy) !== hashes.get(relative)) throw invalidCopy();
    }
    return copied;
  } catch (error) {
    if (error.code === "backup_source_changed" || error.code === "ENOENT") throw invalidCopy();
    throw error;
  }
}

async function copyProjectNotes(source, destination, sourceIdentity) {
  const destinationIdentity = await captureProjectDirectory(destination);
  const before = await inventory(source);
  if (sourceIdentity && !sameIdentity(sourceIdentity, before.directories.get(""))) throw changed();
  if (!sameIdentity(destinationIdentity, await captureProjectDirectory(destination))) throw invalidCopy();
  const staging = await fs.promises.mkdtemp(path.join(destination, ".noda-copy-"));
  const name = `Noda-copy-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(8).toString("hex")}`;
  const target = path.join(destination, name);
  const stagingIdentity = await captureProjectDirectory(staging);
  let complete = false;
  try {
    const hashes = new Map();
    for (const [relative, expected] of before.files) {
      hashes.set(relative, await hashFile(path.join(source, relative), expected, path.join(staging, relative)));
    }
    const verified = await verifyCopy(staging, before.files, hashes);
    const staged = await inventory(staging, true);
    if (!sameInventory(verified.files, staged.files) || !sameInventory(verified.directories, staged.directories)) throw invalidCopy();
    const after = await inventory(source);
    if (!sameInventory(before.files, after.files) || !sameInventory(before.directories, after.directories)) throw changed();
    if (!sameIdentity(destinationIdentity, await captureProjectDirectory(destination))
        || !sameIdentity(stagingIdentity, await captureProjectDirectory(staging))) throw invalidCopy();
    await fs.promises.rename(staging, target);
    complete = true;
    return { directory: target, files: before.files.size };
  } finally {
    if (!complete) {
      const current = await captureProjectDirectory(staging).catch(() => null);
      if (current && sameIdentity(stagingIdentity, current)) {
        await fs.promises.rm(staging, { recursive: true, force: true });
      }
    }
  }
}

module.exports = { captureProjectDirectory, copyProjectNotes };
