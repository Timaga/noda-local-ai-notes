"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../../frontend/notes_chat_search.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ reduced = false, rejectPlay = false, observer = true, mediaQuery = true } = {}) {
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name) { this.listeners.delete(name); }
    fire(name) { this.listeners.get(name)?.(); }
  }
  class Element extends Target {
    constructor(tag) { super(); this.tag = tag; this.children = []; this.attributes = {}; this.plays = 0; this.pauses = 0; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return name === "src" ? this.src : this.attributes[name]; }
    removeAttribute(name) { if (name === "src") delete this.src; delete this.attributes[name]; }
    play() { this.plays++; this.playing = true; return rejectPlay ? Promise.reject(new Error("Autoplay denied")) : Promise.resolve(); }
    pause() { this.pauses++; this.playing = false; }
    load() { this.loaded = true; }
  }
  const document = new Target(), motion = new Target(), observers = [];
  document.createElement = tag => new Element(tag); document.hidden = false; motion.matches = reduced;
  const window = {};
  if (mediaQuery) window.matchMedia = query => { assert.equal(query, "(prefers-reduced-motion: reduce)"); return motion; };
  if (observer) window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(element) { this.element = element; }
    disconnect() { this.disconnected = true; }
  };
  vm.runInNewContext(source, { window, document }, { filename: path.resolve("frontend/notes_chat_search.js") });
  const view = window.NodaChatSearch.create("Ищу ответ по заметкам...");
  const [media, caption] = view.element.children;
  const [poster, video] = media.children;
  return { document, motion, observers, view, media, caption, poster, video };
}

test("pending media is local, muted and decorative; caption remains separate plain text", () => {
  const f = fixture();
  assert.equal(f.media.attributes["aria-hidden"], "true");
  assert.equal(f.caption.textContent, "Ищу ответ по заметкам...");
  assert.equal(f.video.src, "assets/noda-search-loop.mp4");
  assert.equal(f.poster.src, "assets/noda-search-poster.png");
  assert.equal(f.poster.alt, "");
  for (const key of ["muted", "defaultMuted", "loop", "autoplay", "playsInline"]) assert.equal(f.video[key], true);
  assert.equal(f.video.hidden, false); assert.equal(f.poster.hidden, true); assert.equal(f.video.playing, true);
  f.view.destroy();
});

test("reduced motion never loads or plays the video, then follows preference changes", () => {
  const f = fixture({ reduced: true });
  assert.equal(f.video.src, undefined); assert.equal(f.video.plays, 0);
  assert.equal(f.poster.hidden, false); assert.equal(f.video.hidden, true);
  f.motion.matches = false; f.motion.fire("change");
  assert.equal(f.video.playing, true); assert.equal(f.poster.hidden, true);
  f.motion.matches = true; f.motion.fire("change");
  assert.equal(f.video.playing, false); assert.equal(f.poster.hidden, false);
  f.view.destroy();
});

test("hidden page or offscreen message pauses video; returning resumes it", () => {
  const f = fixture();
  f.document.hidden = true; f.document.fire("visibilitychange"); assert.equal(f.video.playing, false);
  f.document.hidden = false; f.document.fire("visibilitychange"); assert.equal(f.video.playing, true);
  f.observers[0].callback([{ isIntersecting: false }]); assert.equal(f.video.playing, false);
  f.observers[0].callback([{ isIntersecting: true }]); assert.equal(f.video.playing, true);
  f.view.destroy();
});

test("media decoding failure retains the poster and readable status", () => {
  const f = fixture(); f.video.fire("error");
  assert.equal(f.poster.hidden, false); assert.equal(f.video.hidden, true); assert.equal(f.video.playing, false);
  assert.equal(f.caption.textContent, "Ищу ответ по заметкам...");
  f.document.fire("visibilitychange"); assert.equal(f.video.playing, false);
  f.view.destroy();
});

test("rejected autoplay shows the static fallback instead of breaking the chat", async () => {
  const f = fixture({ rejectPlay: true }); await tick();
  assert.equal(f.poster.hidden, false); assert.equal(f.video.hidden, true); assert.equal(f.video.playing, false);
  f.view.destroy();
});

test("disposal stops decoding and removes observers and listeners; late rejection is harmless", async () => {
  const f = fixture({ rejectPlay: true }); const lateObserver = f.observers[0].callback;
  f.view.destroy(); f.view.destroy(); await tick();
  assert.equal(f.video.playing, false); assert.equal(f.video.src, undefined); assert.equal(f.video.loaded, true);
  assert.equal(f.document.listeners.size, 0); assert.equal(f.motion.listeners.size, 0);
  assert.equal(f.video.listeners.size, 0); assert.equal(f.observers[0].disconnected, true);
  lateObserver([{ isIntersecting: true }]); assert.equal(f.video.playing, false);
});

test("a rejected play during hiding does not prevent resuming", async () => {
  const f = fixture({ rejectPlay: true });
  f.document.hidden = true; f.document.fire("visibilitychange"); await tick();
  f.video.play = function () { this.playing = true; return Promise.resolve(); };
  f.document.hidden = false; f.document.fire("visibilitychange");
  assert.equal(f.video.playing, true); assert.equal(f.poster.hidden, true);
  f.view.destroy();
});

test("browser without optional motion or observer APIs still gets bounded media lifecycle", () => {
  const f = fixture({ observer: false, mediaQuery: false });
  assert.equal(f.video.playing, true); f.view.destroy(); assert.equal(f.video.playing, false);
});
