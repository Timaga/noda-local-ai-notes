"use strict";

const path = require("node:path");
const { fileURLToPath } = require("node:url");
const documents = new WeakMap();

function sameDocument(url, expected) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return false;
    const actual = path.resolve(fileURLToPath(parsed)), target = path.resolve(expected);
    return process.platform === "win32" ? actual.toLowerCase() === target.toLowerCase() : actual === target;
  } catch { return false; }
}

function protectRenderer(window, document, { openExternal } = {}) {
  const expected = path.resolve(document), contents = window.webContents;
  documents.set(window, expected);
  function openLink(url) {
    try {
      if (!openExternal || !sameDocument(contents.getURL(), expected) || /[\u0000-\u001f\u007f]/.test(url)) return;
      const parsed = new URL(url);
      const web = ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
      const mail = parsed.protocol === "mailto:" && /^[a-z0-9._+-]+@[a-z0-9.-]+$/i.test(parsed.pathname) && !parsed.search;
      if (!web && !mail) return;
      Promise.resolve(openExternal(parsed.href)).catch(() => console.warn("[external-link] could not open link"));
    } catch { /* Invalid external URLs stay blocked. */ }
  }
  contents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: "deny" }; });
  contents.on("will-navigate", (event, url) => {
    if (!sameDocument(event.url || url, expected)) { event.preventDefault(); openLink(event.url || url); }
  });
  contents.on("will-frame-navigate", event => {
    if (!event.isMainFrame || !sameDocument(event.url, expected)) {
      event.preventDefault(); if (event.isMainFrame) openLink(event.url);
    }
  });
  contents.on("will-attach-webview", event => event.preventDefault());
}

function isTrustedRenderer(event, window) {
  try {
    if (!window || window.isDestroyed() || !documents.has(window)) return false;
    const contents = window.webContents, frame = event?.senderFrame;
    return event.sender === contents && Boolean(frame) && frame === contents.mainFrame
      && sameDocument(frame.url, documents.get(window));
  } catch { return false; }
}

function isTrustedSender(event, windows) {
  return windows.some(window => isTrustedRenderer(event, window));
}

module.exports = { protectRenderer, isTrustedRenderer, isTrustedSender };
