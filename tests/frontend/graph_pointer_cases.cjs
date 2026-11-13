"use strict";

const assert = require("node:assert/strict");

function watchGraphPaint() {
  const proto = CanvasRenderingContext2D.prototype;
  let currentPath;
  window.__graphPaint = { frame: 0, nodes: [], lines: [], at: performance.now() };

  function observe(method, observeCall) {
    const original = proto[method];
    proto[method] = function (...args) {
      if (this.canvas.id === "graph-canvas") observeCall(this, ...args);
      return original.apply(this, args);
    };
  }

  observe("clearRect", () => {
    const paint = window.__graphPaint;
    if (window.__graphMotion && paint.nodes.length && window.__graphMotion.length < 240) {
      window.__graphMotion.push(paint.nodes.map(({ x, y }) => ({ x, y })));
    }
    paint.frame++;
    paint.nodes = [];
    paint.lines = [];
    paint.at = performance.now();
  });
  observe("beginPath", () => { currentPath = null; });
  observe("arc", (_ctx, x, y, radius) => { currentPath = { x, y, radius }; });
  observe("moveTo", (_ctx, x, y) => { currentPath = { from: { x, y } }; });
  observe("lineTo", (_ctx, x, y) => { if (currentPath?.from) currentPath.to = { x, y }; });
  observe("fill", ctx => {
    if (currentPath?.radius) window.__graphPaint.nodes.push({ ...currentPath, opacity: ctx.globalAlpha });
  });
  observe("stroke", ctx => {
    if (currentPath?.to) window.__graphPaint.lines.push({ ...currentPath, opacity: ctx.globalAlpha, width: ctx.lineWidth });
  });
}

async function runGraphPointerCases({ check, run, capture, debug, lang, setRecording }) {
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 0.05;
  const paint = () => run("return __graphPaint;");
  const settled = () => run("await waitFor(() => __graphPaint.nodes.length === 30 && performance.now() - __graphPaint.at > 100);");
  const recordMotion = () => run("window.__graphMotion = [];");
  const readMotion = () => run("const frames = [...__graphMotion, __graphPaint.nodes]; window.__graphMotion = null; return frames;");
  const nextPaint = frame => run(`await waitFor(() => __graphPaint.frame > ${frame}); return __graphPaint;`);
  const fit = async () => {
    const { frame } = await paint();
    await run("document.getElementById('graph-fit').click();");
    await nextPaint(frame);
    await settled();
  };
  const bounds = () => run("const { left, top } = document.getElementById('graph-canvas').getBoundingClientRect(); return { left, top };");
  const mouse = (type, x, y, held = false) => debug.sendCommand("Input.dispatchMouseEvent", {
    type, x, y, button: type === "mouseMoved" ? "none" : "left",
    buttons: held ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1,
  });

  await check("pointer hover highlights only the hovered node, its neighbors and their edges", async () => {
    await settled();
    const before = await paint(), box = await bounds(), anchor = before.nodes[0];
    const incident = before.lines.filter(line => near(line.from, anchor) || near(line.to, anchor));
    assert.equal(incident.length, 4, "fixture anchor is connected to four neighbors");
    await mouse("mouseMoved", box.left + anchor.x, box.top + anchor.y);
    const hover = await nextPaint(before.frame);
    assert.ok(hover.nodes[0].radius > anchor.radius, "hovered node has a larger marker");
    assert.ok(hover.nodes[28].opacity < before.nodes[28].opacity, "unconnected notes dim");
    assert.equal(hover.lines.filter(line => line.width > 1 && line.opacity === 1).length, 4);
    for (const [index, line] of hover.lines.entries()) {
      const connected = near(line.from, anchor) || near(line.to, anchor);
      assert.equal(line.width > before.lines[index].width, connected, "only incident lines become brighter and wider");
      if (connected) {
        const neighbor = near(line.from, anchor) ? line.to : line.from;
        assert.ok(hover.nodes.some(node => near(node, neighbor) && node.opacity === 1 && node.radius > before.nodes.find(old => near(old, neighbor)).radius));
      }
    }
    assert.equal(await run("return Boolean(document.querySelector('#graph-note-list [aria-pressed=true]'));"), false, "hover does not select a note");
    await capture(`09-graph-hover-${lang}.png`);
    await mouse("mouseMoved", box.left - 10, box.top + 40);
    const left = await nextPaint(hover.frame);
    assert.ok(left.lines.every(line => line.width === 1), "leaving canvas restores the unselected view");
  });

  await check("a fast drag advances through frames, then connected branches catch up after release", async () => {
    await settled();
    const before = await paint(), box = await bounds();
    const start = { x: box.left + before.nodes[0].x, y: box.top + before.nodes[0].y };
    setRecording(true);
    await mouse("mouseMoved", start.x, start.y);
    await mouse("mousePressed", start.x, start.y, true);
    await recordMotion();
    await mouse("mouseMoved", start.x + 115, start.y + 38, true);
    await run(`await waitFor(() => __graphPaint.nodes[0].x > ${before.nodes[0].x + 45});`);
    const dragged = await paint();
    assert.ok(near(dragged.nodes[28], before.nodes[28]), "isolated note stays in place");
    assert.equal(await run("return document.getElementById('graph-canvas').style.cursor;"), "grabbing");
    await capture(`10-graph-drag-${lang}.png`);
    const atRelease = await paint();
    await mouse("mouseReleased", start.x + 115, start.y + 38);
    await run(`await waitFor(() => Math.hypot(__graphPaint.nodes[1].x - ${atRelease.nodes[1].x}, __graphPaint.nodes[1].y - ${atRelease.nodes[1].y}) > 0.1);`);
    await settled();
    setRecording(false);
    const after = await paint();
    const frames = await readMotion();
    const inFlight = frames.filter(nodes => nodes[0].x > before.nodes[0].x + 1 && nodes[0].x < before.nodes[0].x + 114);
    assert.ok(inFlight.length >= 4, "one input event produces several intermediate positions");
    assert.ok(inFlight[0][0].x < before.nodes[0].x + 60, "first frame does not jump to the pointer");
    assert.ok(inFlight.some(nodes => {
      const grip = nodes[0].x - before.nodes[0].x;
      const peer = nodes[1].x - before.nodes[1].x;
      return grip > 35 && peer > 0 && peer < grip * 0.45;
    }), "neighbor movement lags behind the held note");
    assert.ok(near(after.nodes[0], { x: before.nodes[0].x + 115, y: before.nodes[0].y + 38 }), "dragged node reaches the drop position");
    assert.ok(after.nodes[1].x > before.nodes[1].x + 30 && after.nodes[5].x > before.nodes[5].x + 10, "direct and distant connections follow");
    assert.ok(near(after.nodes[28], before.nodes[28]), "settling leaves unrelated notes alone");
    return { intermediateFrames: inFlight.length, firstFramePixels: inFlight[0][0].x - before.nodes[0].x };
  });

  await check("dragging empty canvas pans linked and isolated notes together", async () => {
    const before = await paint(), box = await bounds();
    assert.ok(before.nodes.every(node => Math.hypot(node.x - 30, node.y - 60) > 18), "pan starts in empty space");
    await mouse("mouseMoved", box.left + 30, box.top + 60);
    await mouse("mousePressed", box.left + 30, box.top + 60, true);
    await recordMotion();
    await mouse("mouseMoved", box.left + 74, box.top + 84, true);
    await mouse("mouseReleased", box.left + 74, box.top + 84);
    await settled();
    const after = await paint();
    for (const index of [0, 1, 28]) {
      assert.ok(near(after.nodes[index], { x: before.nodes[index].x + 44, y: before.nodes[index].y + 24 }));
    }
    const frames = await readMotion();
    assert.ok(frames.filter(nodes => nodes[0].x > before.nodes[0].x + 1 && nodes[0].x < before.nodes[0].x + 43).length >= 4);
    await mouse("mouseMoved", box.left - 10, box.top + 40);
    await fit();
  });

  await check("wheel zoom is smooth and keeps its pointer anchor in place", async () => {
    await settled();
    const before = await paint(), box = await bounds(), anchor = before.nodes[0];
    const gap = nodes => Math.hypot(nodes[0].x - nodes[1].x, nodes[0].y - nodes[1].y);
    await recordMotion();
    await debug.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.left + anchor.x, y: box.top + anchor.y, deltaX: 0, deltaY: -120 });
    await nextPaint(before.frame);
    await settled();
    const frames = await readMotion(), end = frames.at(-1);
    const initialGap = gap(before.nodes), finalGap = gap(end);
    assert.ok(finalGap > initialGap * 1.15);
    assert.ok(frames.filter(nodes => gap(nodes) > initialGap + 0.2 && gap(nodes) < finalGap - 0.2).length >= 4);
    assert.ok(frames.every(nodes => Math.hypot(nodes[0].x - anchor.x, nodes[0].y - anchor.y) < 0.3), "zoom stays anchored to the pointer");
    await mouse("mouseMoved", box.left - 10, box.top + 40);
    await fit();
  });

  await check("reduced motion keeps dragging direct, with no animated tail", async () => {
    await settled();
    await debug.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    try {
      await run("await waitFor(() => matchMedia('(prefers-reduced-motion: reduce)').matches);");
      const before = await paint(), box = await bounds(), anchor = before.nodes[0];
      const x = box.left + anchor.x, y = box.top + anchor.y;
      await mouse("mouseMoved", x, y);
      await mouse("mousePressed", x, y, true);
      await recordMotion();
      await mouse("mouseMoved", x + 40, y, true);
      await mouse("mouseReleased", x + 40, y);
      await nextPaint(before.frame);
      await settled();
      const frames = await readMotion();
      assert.ok(near(frames.at(-1)[0], { x: anchor.x + 40, y: anchor.y }), JSON.stringify({ anchor, final: frames.at(-1)[0], frames: frames.length }));
      assert.ok(frames.every(nodes => near(nodes[0], anchor) || near(nodes[0], { x: anchor.x + 40, y: anchor.y })));
    } finally {
      await debug.sendCommand("Emulation.setEmulatedMedia", { features: [] });
    }
  });
}

module.exports = { watchGraphPaint, runGraphPointerCases };
