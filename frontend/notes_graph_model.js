(function (root) {
  "use strict";
  function build(payload) {
    if (!Array.isArray(payload?.nodes) || !Array.isArray(payload?.edges)
        || payload.nodes.length > 5000 || payload.edges.length > 50000) throw new Error("Invalid graph");
    const unresolved = payload.unresolved ?? 0;
    if (!Number.isSafeInteger(unresolved) || unresolved < 0) throw new Error("Invalid missing link count");
    const nodes = new Map(), edges = [], adjacency = new Map();
    for (const node of payload.nodes) {
      if (typeof node?.id !== "string" || !node.id || node.id.length > 4096
          || typeof node.title !== "string" || !node.title || node.title.length > 4096 || nodes.has(node.id)) throw new Error("Invalid node");
      nodes.set(node.id, { id: node.id, title: node.title }); adjacency.set(node.id, new Set());
    }
    const seen = new Set();
    for (const edge of payload.edges) {
      if (!nodes.has(edge?.source) || !nodes.has(edge?.target) || edge.source === edge.target) throw new Error("Invalid edge");
      const key = JSON.stringify([edge.source, edge.target].sort());
      if (seen.has(key)) throw new Error("Duplicate edge");
      seen.add(key); edges.push({ source: edge.source, target: edge.target });
      adjacency.get(edge.source).add(edge.target); adjacency.get(edge.target).add(edge.source);
    }
    const groups = new Map(); let group = 0;
    for (const id of nodes.keys()) {
      if (groups.has(id)) continue;
      const pending = [id]; groups.set(id, group);
      for (let i = 0; i < pending.length; i++) {
        for (const peer of adjacency.get(pending[i])) if (!groups.has(peer)) { groups.set(peer, group); pending.push(peer); }
      }
      group++;
    }
    return { nodes, edges, adjacency, groups, unresolved };
  }
  const normalize = text => text.normalize("NFC").toLocaleLowerCase();
  function filter(model, query = "", linkedOnly = false) {
    const search = normalize(query.trim()), matches = new Set(), visible = new Set();
    for (const node of model.nodes.values()) {
      if (linkedOnly && !model.adjacency.get(node.id).size) continue;
      if (!search || normalize(node.title + " " + node.id).includes(search)) matches.add(node.id);
    }
    for (const id of matches) {
      visible.add(id);
      if (search) for (const peer of model.adjacency.get(id)) visible.add(peer);
    }
    return { ids: visible, matches, edges: model.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target)) };
  }
  function dragBranch(model, view, points, anchor) {
    const weights = new Map([[anchor, 1]]);
    const queue = [anchor];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      const weight = Math.max(0.08, weights.get(id) * 0.55);
      for (const peer of model.adjacency.get(id)) {
        if (!view.ids.has(peer) || weights.has(peer)) continue;
        weights.set(peer, weight);
        queue.push(peer);
      }
    }
    return {
      anchor, weights,
      points: new Map(queue.map(id => [id, points.get(id)])),
      edges: view.edges.filter(edge => weights.has(edge.source) && weights.has(edge.target)),
    };
  }
  function positions(model, previous = new Map()) {
    const result = new Map(), counts = new Map();
    for (const id of model.nodes.keys()) counts.set(model.groups.get(id), (counts.get(model.groups.get(id)) || 0) + 1);
    const centers = new Map(); let x = 0, y = 0, rowHeight = 0;
    const width = Math.max(300, Math.sqrt(model.nodes.size) * 90);
    for (const [group, count] of counts) {
      const size = Math.sqrt(count) * 55 + 80;
      if (x && x + size > width) { x = 0; y += rowHeight; rowHeight = 0; }
      centers.set(group, { x: x + size / 2, y: y + size / 2, used: 0 });
      x += size; rowHeight = Math.max(rowHeight, size);
    }
    for (const id of model.nodes.keys()) {
      const center = centers.get(model.groups.get(id)), order = center.used++, angle = order * 2.399963229728653;
      const radius = Math.sqrt(order + 1) * 25;
      const old = previous.get(id);
      result.set(id, old ? { ...old } : { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius, vx: 0, vy: 0 });
    }
    return result;
  }
  function easeMotion(axis, elapsed, response, precision, immediate = false) {
    const offset = axis.value - axis.target;
    if (immediate || (Math.abs(offset) <= precision && Math.abs(axis.velocity * response) <= precision)) {
      axis.value = axis.target;
      axis.velocity = 0;
      return false;
    }
    // A critically damped spring integrated over elapsed milliseconds.
    const rate = 1 / response;
    const drift = axis.velocity + offset * rate;
    const decay = Math.exp(-elapsed * rate);
    axis.value = axis.target + (offset + drift * elapsed) * decay;
    axis.velocity = (axis.velocity - drift * rate * elapsed) * decay;
    return true;
  }
  function step(points, edges, pinned, strength = 1) {
    const cells = new Map(), size = 100;
    for (const point of points.values()) {
      const key = `${Math.floor(point.x / size)},${Math.floor(point.y / size)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(point);
    }
    for (const point of points.values()) {
      const x = Math.floor(point.x / size), y = Math.floor(point.y / size);
      let examined = 0;
      nearby: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const other of cells.get(`${x + dx},${y + dy}`) || []) {
          if (examined++ >= 80) break nearby;
          if (other === point) continue;
          const sx = point.x - other.x || 0.01, sy = point.y - other.y || 0.01;
          const distance = Math.max(20, sx * sx + sy * sy), force = 110 / distance * strength;
          point.vx += sx * force; point.vy += sy * force;
        }
      }
    }
    for (const edge of edges) {
      const a = points.get(edge.source), b = points.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
      const force = (length - 85) / length * 0.012 * strength;
      a.vx += dx * force; a.vy += dy * force; b.vx -= dx * force; b.vy -= dy * force;
    }
    for (const [id, point] of points) {
      if (id === pinned) { point.vx = 0; point.vy = 0; continue; }
      point.vx = Math.max(-10, Math.min(10, point.vx * 0.72)); point.vy = Math.max(-10, Math.min(10, point.vy * 0.72));
      point.x += point.vx; point.y += point.vy;
    }
  }
  const api = { build, filter, dragBranch, positions, easeMotion, step };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.NotesGraphModel = api;
})(typeof window === "undefined" ? globalThis : window);
