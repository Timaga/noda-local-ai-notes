(function (root) {
  "use strict";
  const GRIP_RESPONSE_MS = 27;
  const CAMERA_RESPONSE_MS = 45;
  const axis = value => ({ value, target: value, velocity: 0 });
  function create(canvas, { onSelect, onOpen, onZoom }) {
    const ctx = canvas.getContext("2d"), Model = root.NotesGraphModel;
    let model = Model.build({ nodes: [], edges: [] }), visible = Model.filter(model), points = new Map();
    let selected = "", hover = "", width = 1, height = 1;
    let frame = 0, remaining = 0, drag = null, active = false, disposed = false, needsFit = true;
    let settling = null, lastFrameAt = null;
    const camera = { x: axis(0), y: axis(0), zoom: axis(1) };
    const motion = root.matchMedia("(prefers-reduced-motion: reduce)");
    const colors = ["#a9bacf", "#b8adc8", "#9fc4b6", "#c4b49f", "#a8b9b8"];
    const screen = point => ({ x: point.x * camera.zoom.value + camera.x.value, y: point.y * camera.zoom.value + camera.y.value });
    function draw() {
      ctx.clearRect(0, 0, width, height);
      const focus = drag ? drag.id : hover || selected;
      const neighbors = model.adjacency.get(focus);
      const scale = camera.zoom.value;
      for (const edge of visible.edges) {
        const a = screen(points.get(edge.source)), b = screen(points.get(edge.target));
        const highlighted = edge.source === focus || edge.target === focus;
        ctx.strokeStyle = highlighted ? "#b5cbe5" : "#4b535f";
        ctx.lineWidth = highlighted ? 1.8 : 1;
        ctx.globalAlpha = highlighted ? 1 : focus ? 0.25 : 0.65;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.font = '12px "Segoe UI", sans-serif'; ctx.textAlign = "center";
      const labels = [];
      for (const id of visible.ids) {
        const node = model.nodes.get(id), p = screen(points.get(id)), degree = model.adjacency.get(id).size;
        if (p.x < -150 || p.y < -45 || p.x > width + 150 || p.y > height + 45) continue;
        const emphasis = id === focus, connected = neighbors?.has(id);
        const radius = Math.min(10, 3.5 + Math.sqrt(degree)) + (emphasis ? 2 : connected ? 1 : 0);
        const opacity = !focus || emphasis || connected ? 1 : 0.32;
        ctx.globalAlpha = opacity;
        ctx.fillStyle = emphasis ? "#edf2f7" : connected ? "#c4d7ee" : colors[model.groups.get(id) % colors.length];
        ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill();
        if (emphasis) { ctx.strokeStyle = "#d6e0ee"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, radius + 5, 0, Math.PI * 2); ctx.stroke(); }
        if (emphasis || connected || (visible.ids.size <= 70 && scale >= 0.45) || scale >= 1.6) {
          const label = node.title.length > 40 ? node.title.slice(0, 39) + "…" : node.title;
          labels.push({ label, x: p.x, y: p.y + radius + 17, opacity, priority: emphasis ? 2 : connected ? 1 : 0 });
        }
      }
      ctx.globalAlpha = 1;
      const occupied = [];
      for (const item of labels.sort((a, b) => b.priority - a.priority).slice(0, 180)) {
        const half = ctx.measureText(item.label).width / 2 + 5;
        const box = { left: item.x - half, right: item.x + half, top: item.y - 13, bottom: item.y + 4 };
        if (occupied.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue;
        occupied.push(box); ctx.globalAlpha = item.opacity;
        ctx.lineWidth = 4; ctx.strokeStyle = "#171a20"; ctx.strokeText(item.label, item.x, item.y);
        ctx.fillStyle = "#e0e5ed"; ctx.fillText(item.label, item.x, item.y);
      }
      ctx.globalAlpha = 1;
    }
    function advanceCamera(elapsed, immediate = motion.matches) {
      const x = Model.easeMotion(camera.x, elapsed, CAMERA_RESPONSE_MS, 0.05, immediate);
      const y = Model.easeMotion(camera.y, elapsed, CAMERA_RESPONSE_MS, 0.05, immediate);
      const zoom = Model.easeMotion(camera.zoom, elapsed, CAMERA_RESPONSE_MS, 0.00005, immediate);
      return x || y || zoom;
    }
    function aimCamera(x, y, zoom = camera.zoom.target, animate = true) {
      const zoomChanged = zoom !== camera.zoom.target;
      camera.x.target = x;
      camera.y.target = y;
      camera.zoom.target = zoom;
      if (!animate || motion.matches) advanceCamera(0, true);
      if (zoomChanged) onZoom(zoom);
      schedule();
    }
    function stopCamera() {
      const zoomChanged = camera.zoom.target !== camera.zoom.value;
      for (const value of Object.values(camera)) {
        value.target = value.value;
        value.velocity = 0;
      }
      if (zoomChanged) onZoom(camera.zoom.value);
    }
    function advanceBranch(branch, elapsed) {
      const precision = 0.05 / camera.zoom.value;
      let moving = false;
      for (const entry of branch.nodes) {
        entry.x.target = entry.startX + branch.dx * entry.weight;
        entry.y.target = entry.startY + branch.dy * entry.weight;
        const x = Model.easeMotion(entry.x, elapsed, entry.response, precision, motion.matches);
        const y = Model.easeMotion(entry.y, elapsed, entry.response, precision, motion.matches);
        entry.point.x = entry.x.value;
        entry.point.y = entry.y.value;
        moving ||= x || y;
      }
      return moving;
    }
    function schedule() {
      if (!active || disposed || frame) return;
      frame = root.requestAnimationFrame(timestamp => {
        frame = 0;
        const elapsed = lastFrameAt === null ? 1000 / 60 : Math.min(32, timestamp - lastFrameAt);
        lastFrameAt = timestamp;
        const branch = drag?.branch || settling;
        const cameraMoving = advanceCamera(elapsed);
        const branchMoving = branch && advanceBranch(branch, elapsed);
        if (!branchMoving) settling = null;
        if (!branch && remaining > 0 && !motion.matches) {
          Model.step(points, model.edges, drag?.id, Math.max(0.1, remaining / 110));
          remaining--;
        } else remaining = 0;
        draw();
        if (cameraMoving || branchMoving || remaining) schedule();
        else lastFrameAt = null;
      });
    }
    function fit(animate = true) {
      if (!visible.ids.size) { aimCamera(width / 2, height / 2, 1, animate); return; }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const id of visible.ids) { const p = points.get(id); minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
      const zoom = Math.max(0.03, Math.min(1.6, (width - 110) / (maxX - minX + 100), (height - 100) / (maxY - minY + 100)));
      aimCamera(width / 2 - (minX + maxX) / 2 * zoom, height / 2 - (minY + maxY) / 2 * zoom, zoom, animate);
    }
    function resize() {
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const oldW = width, oldH = height; width = box.width; height = box.height;
      const ratio = Math.min(2, root.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const dx = (width - oldW) / 2, dy = (height - oldH) / 2;
      camera.x.value += dx; camera.x.target += dx;
      camera.y.value += dy; camera.y.target += dy;
      if (needsFit) { needsFit = false; fit(false); } else schedule();
    }
    function zoom(factor, x = width / 2, y = height / 2) {
      const zoom = Math.min(5, Math.max(0.03, camera.zoom.target * factor));
      const ratio = zoom / camera.zoom.target;
      aimCamera(x + (camera.x.target - x) * ratio, y + (camera.y.target - y) * ratio, zoom);
    }
    function hit(x, y) {
      let best = "", distance = 18;
      for (const id of visible.ids) { const p = screen(points.get(id)), d = Math.hypot(x - p.x, y - p.y); if (d < distance) { distance = d; best = id; } }
      return best;
    }
    function coordinates(event) { const box = canvas.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; }
    function updateHover(point) {
      const inside = point && point.x >= 0 && point.x < width && point.y >= 0 && point.y < height;
      hover = inside ? hit(point.x, point.y) : "";
      canvas.style.cursor = drag ? "grabbing" : hover ? "pointer" : "grab";
    }
    function releaseDrag() {
      const finished = drag;
      drag = null;
      if (finished && canvas.hasPointerCapture(finished.pointerId)) canvas.releasePointerCapture(finished.pointerId);
      return finished;
    }
    function clearInteraction() {
      if (drag?.branch || settling) remaining = 0;
      releaseDrag();
      settling = null;
      stopCamera();
      updateHover(null);
    }
    function moveBranch(dx, dy) {
      if (!drag.branch) {
        const scope = Model.dragBranch(model, visible, points, drag.id);
        const nodes = [...scope.weights].map(([id, weight]) => {
          const point = scope.points.get(id);
          return { point, weight, startX: point.x, startY: point.y, x: axis(point.x), y: axis(point.y),
            response: id === scope.anchor ? GRIP_RESPONSE_MS : 52 + (1 - weight) * 78 };
        });
        drag.branch = { nodes, dx: 0, dy: 0 };
        remaining = 0;
      }
      drag.branch.dx += dx / camera.zoom.value;
      drag.branch.dy += dy / camera.zoom.value;
      if (motion.matches) advanceBranch(drag.branch, 0);
    }
    function finishPointer(event, clicked) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const finished = releaseDrag();
      if (finished.branch && !motion.matches) {
        settling = finished.branch;
      }
      if (clicked && !finished.moved) onSelect(finished.id);
      updateHover(clicked ? coordinates(event) : null);
      schedule();
    }
    const handlers = {
      pointerdown(event) {
        if (event.button !== 0 || drag) return;
        const p = coordinates(event);
        if (settling) { remaining = 0; settling = null; }
        stopCamera();
        drag = { ...p, startX: p.x, startY: p.y, id: hit(p.x, p.y), pointerId: event.pointerId, moved: false, branch: null };
        canvas.setPointerCapture(event.pointerId); canvas.focus({ preventScroll: true });
        updateHover(p); schedule();
      },
      pointermove(event) {
        const p = coordinates(event);
        if (drag) {
          if (event.pointerId !== drag.pointerId) return;
          drag.moved ||= Math.hypot(p.x - drag.startX, p.y - drag.startY) > 4;
          if (drag.moved) {
            if (drag.id) moveBranch(p.x - drag.x, p.y - drag.y);
            else aimCamera(camera.x.target + p.x - drag.x, camera.y.target + p.y - drag.y);
            drag.x = p.x; drag.y = p.y;
          }
        } else updateHover(p);
        schedule();
      },
      pointerup(event) { finishPointer(event, true); },
      pointercancel(event) { finishPointer(event, false); },
      lostpointercapture(event) { finishPointer(event, false); },
      pointerleave() { updateHover(null); schedule(); },
      dblclick(event) { const p = coordinates(event), id = hit(p.x, p.y); if (id) onOpen(id); },
      wheel(event) { event.preventDefault(); const p = coordinates(event); zoom(Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * 0.002), p.x, p.y); },
      keydown(event) {
        const directions = { ArrowLeft: [45, 0], ArrowRight: [-45, 0], ArrowUp: [0, 45], ArrowDown: [0, -45] };
        if (directions[event.key]) { event.preventDefault(); aimCamera(camera.x.target + directions[event.key][0], camera.y.target + directions[event.key][1]); }
        else if (["+", "=", "-", "0", "Home"].includes(event.key)) { event.preventDefault(); if (["0", "Home"].includes(event.key)) fit(); else zoom(event.key === "-" ? 0.8 : 1.25); }
      },
    };
    for (const [event, handler] of Object.entries(handlers)) canvas.addEventListener(event, handler, event === "wheel" ? { passive: false } : undefined);
    const observer = new ResizeObserver(resize); observer.observe(canvas);
    return {
      setData(next, reset) {
        clearInteraction();
        model = next; points = Model.positions(model, reset ? new Map() : points); remaining = 110;
        if (reset && model.nodes.size <= 200) {
          for (let i = 0; i < 50; i++) Model.step(points, model.edges, null, 1 - i / 70);
          remaining = motion.matches ? 0 : 40;
        }
        if (reset) { selected = ""; needsFit = true; }
      },
      filter(next) { clearInteraction(); visible = next; if (needsFit && active) { resize(); } schedule(); },
      select(id, center = false) { selected = id; if (center && points.has(id)) { const p = points.get(id); aimCamera(width / 2 - p.x * camera.zoom.target, height / 2 - p.y * camera.zoom.target); } schedule(); },
      activate(value) { active = value; if (active) { resize(); schedule(); } else { root.cancelAnimationFrame(frame); frame = 0; lastFrameAt = null; clearInteraction(); } },
      fit, zoom,
      dispose() { disposed = true; clearInteraction(); root.cancelAnimationFrame(frame); observer.disconnect(); for (const [event, handler] of Object.entries(handlers)) canvas.removeEventListener(event, handler); },
    };
  }
  root.NotesGraphCanvas = { create };
})(window);
