"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const Model = require("../../frontend/notes_graph_model.js");
const sample = () => Model.build({ nodes: [{ id: "A", title: "Календарь" }, { id: "B", title: "CRM" }, { id: "C", title: "Отдельно" }], edges: [{ source: "A", target: "B" }] });
test("graph preserves isolated notes, unique saved connections and connected components", () => {
  const model = sample(); assert.equal(model.nodes.size, 3); assert.equal(model.edges.length, 1);
  assert.deepEqual([...model.adjacency.get("B")], ["A"]);
  assert.equal(model.groups.get("A"), model.groups.get("B")); assert.notEqual(model.groups.get("A"), model.groups.get("C"));
});
test("search shows matches and their actual neighbors; connected-only removes isolated notes", () => {
  const model = sample(), view = Model.filter(model, "КАЛЕНДАРЬ");
  assert.deepEqual([...view.ids], ["A", "B"]); assert.deepEqual([...view.matches], ["A"]);
  assert.deepEqual([...Model.filter(model, "", true).ids], ["A", "B"]);
  assert.equal(Model.filter(model, "Missing").ids.size, 0);
});
test("untrusted graphs reject duplicates, missing endpoints and self-connections", () => {
  for (const payload of [null, {}, { nodes: [{ id: "A", title: "A" }, { id: "A", title: "A" }], edges: [] },
    { nodes: [{ id: "A", title: "A" }], edges: [{ source: "A", target: "B" }] },
    { nodes: [{ id: "A", title: "A" }], edges: [{ source: "A", target: "A" }] }]) assert.throws(() => Model.build(payload));
  const valid = { nodes: [{ id: "A", title: "A" }, { id: "B", title: "B" }], edges: [{ source: "A", target: "B" }, { source: "B", target: "A" }] };
  assert.throws(() => Model.build(valid));
});
test("positions are deterministic, remain finite and retain coordinates after live updates", () => {
  const model = sample(), points = Model.positions(model); assert.deepEqual(points, Model.positions(model));
  for (let i = 0; i < 150; i++) Model.step(points, model.edges, "A");
  for (const point of points.values()) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  assert.deepEqual(Model.positions(model, points), points);
});
test("1000-note graph settles with bounded finite coordinates", () => {
  const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), title: `Note ${i}` }));
  const edges = nodes.slice(1).map((node, i) => ({ source: String(i), target: node.id }));
  const model = Model.build({ nodes, edges }), points = Model.positions(model);
  for (let i = 0; i < 30; i++) Model.step(points, edges);
  assert.equal(points.size, 1000); for (const point of points.values()) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
});
test("a dragged branch reaches connected cycles, respects filtering and excludes isolated notes", () => {
  const nodes = ["Start", "Near", "Middle", "Far", "Isolated"].map(id => ({ id, title: id }));
  const edges = [["Start", "Near"], ["Near", "Middle"], ["Middle", "Far"], ["Far", "Near"]]
    .map(([source, target]) => ({ source, target }));
  const model = Model.build({ nodes, edges });
  const points = Model.positions(model);
  const branch = Model.dragBranch(model, Model.filter(model), points, "Start");
  assert.deepEqual(new Set(branch.points.keys()), new Set(["Start", "Near", "Middle", "Far"]));
  assert.deepEqual(branch.edges, edges);
  assert.ok(branch.weights.get("Start") > branch.weights.get("Near"));
  assert.ok(branch.weights.get("Near") > branch.weights.get("Far"));
  assert.equal(branch.weights.get("Far"), branch.weights.get("Middle"));
  const filtered = Model.dragBranch(model, Model.filter(model, "Start"), points, "Start");
  assert.deepEqual([...filtered.points.keys()], ["Start", "Near"]);
  assert.deepEqual(filtered.edges, [edges[0]]);
  const isolated = Model.dragBranch(model, Model.filter(model), points, "Isolated");
  assert.equal(isolated.points.size, 1);
  assert.equal(isolated.edges.length, 0);
});
test("motion approaches a target gradually and tracks elapsed time across refresh rates", () => {
  const at = (frames, elapsed) => {
    const axis = { value: 0, target: 100, velocity: 0 };
    for (let i = 0; i < frames; i++) Model.easeMotion(axis, elapsed / frames, 45, 0.001);
    return axis;
  };
  const early = at(1, 16), middle = at(6, 100), fine = at(24, 100);
  assert.ok(early.value > 0 && early.value < middle.value && middle.value < 100);
  assert.ok(Math.abs(middle.value - fine.value) < 0.00001);
  assert.ok(Math.abs(middle.velocity - fine.velocity) < 0.00001);
  const late = at(60, 1000);
  assert.equal(late.value, 100);
  assert.equal(late.velocity, 0);
});
test("reduced motion applies the target directly and clears residual movement", () => {
  const axis = { value: 20, target: -30, velocity: 2 };
  assert.equal(Model.easeMotion(axis, 0, 45, 0.001, true), false);
  assert.deepEqual(axis, { value: -30, target: -30, velocity: 0 });
});
