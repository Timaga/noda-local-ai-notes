"use strict";

const fs = require("node:fs");
const path = require("node:path");

const controls = new WeakSet();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function validateOwnedLauncherControl(environment, projectRoot = path.resolve(__dirname, "..")) {
  if (!Object.hasOwn(environment, "NODA_OWNED_TITLE_PROFILE")) return null;
  const launchId = environment.NODA_OWNED_TITLE_LAUNCH_ID;
  const receiptPath = environment.NODA_OWNED_TITLE_LIFECYCLE_PATH;
  if (typeof launchId !== "string" || !UUID.test(launchId) || typeof receiptPath !== "string"
      || !path.isAbsolute(receiptPath) || path.basename(receiptPath) !== "node-lifecycle.json") {
    throw new Error("Invalid owned launcher metadata");
  }
  const outputRoot = path.resolve(projectRoot, "output");
  const parent = path.resolve(path.dirname(receiptPath));
  const relative = path.relative(outputRoot, parent);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)
      || fs.realpathSync(parent) !== parent) throw new Error("Owned lifecycle output required");
  if (fs.existsSync(receiptPath)) throw new Error("Lifecycle receipt already exists");
  const result = Object.freeze({ launchId, receiptPath });
  controls.add(result);
  return result;
}

function attachOwnedLauncherControl(runtime, requestShutdown, child, suppliedControl) {
  const control = suppliedControl === undefined ? validateOwnedLauncherControl(runtime.env) : suppliedControl;
  if (!control) return null;
  if (!controls.has(control) || typeof requestShutdown !== "function"
      || !Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error("Verified owned child required");
  const descriptor = fs.openSync(control.receiptPath, "wx", 0o600);
  let buffer = Buffer.alloc(0);
  let controlRequested = false;
  let controlSchemaRejected = false;
  let complete = false;
  const stop = (reason) => {
    if (controlRequested) return;
    controlRequested = true;
    requestShutdown(reason);
  };
  const reject = () => {
    controlSchemaRejected = true;
    complete = true;
    stop("owned-invalid-control");
  };
  runtime.stdin.on("data", (chunk) => {
    if (complete) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length + bytes.length > 4096) { reject(); return; }
    buffer = Buffer.concat([buffer, bytes]);
    const newline = buffer.indexOf(10);
    if (newline < 0) return;
    if (newline !== buffer.length - 1) { reject(); return; }
    let message;
    let keys;
    const text = buffer.subarray(0, newline).toString("utf8");
    try {
      message = JSON.parse(text);
      keys = Array.from(text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g), (match) => JSON.parse(`"${match[1]}"`));
    } catch (_) { reject(); return; }
    if (!message || typeof message !== "object" || Array.isArray(message)
        || Object.keys(message).length !== 2 || message.type !== "owned-title-shutdown"
        || message.launch_id !== control.launchId
        || keys.length !== 2 || keys.filter((key) => key === "type").length !== 1
        || keys.filter((key) => key === "launch_id").length !== 1) { reject(); return; }
    complete = true;
    stop("owned-parent-request");
  });
  runtime.stdin.on("end", () => {
    if (!complete && buffer.length) reject();
    else stop("owned-parent-eof");
  });
  runtime.stdin.on("error", () => { controlSchemaRejected = true; stop("owned-parent-pipe-error"); });
  child.once("exit", (code, signal) => {
    const receipt = {
      event: "electron_exit", launchId: control.launchId,
      nodePid: runtime.pid, electronPid: child.pid,
      code: Number.isInteger(code) ? code : null,
      signal: typeof signal === "string" ? signal : null,
      controlRequested, controlSchemaRejected, cleanupInstrumentation: false,
      normalCleanupSourcePathConsistent: code === 0, fullTreeExclusion: false,
    };
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(receipt)}\n`, { encoding: "utf8" });
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  });
  return Object.freeze({ launchId: control.launchId });
}

module.exports = { validateOwnedLauncherControl, attachOwnedLauncherControl };
