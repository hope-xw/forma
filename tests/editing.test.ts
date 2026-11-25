import test from "node:test";
import assert from "node:assert/strict";
import {
  createNode,
  parseDocument,
  type DesignDocument,
} from "../src/domain/document";
import { transact, type Operation } from "../src/domain/commands";
import {
  copySelection,
  pasteSelection,
  readClipboard,
} from "../src/domain/clipboard";
import {
  alignOperations,
  layerOrderOperations,
  reparentOperations,
  ungroupOperations,
  wrapOperations,
} from "../src/domain/editing";
import {
  fitViewport,
  layoutBounds,
  resizeRect,
  screenToWorld,
  snapMove,
  zoomAt,
} from "../src/domain/geometry";
import { isLocked, selectionRoots } from "../src/domain/tree";
import { createStarter } from "../src/domain/seed";
function fixture() {
  const nodes = [0, 1, 2, 3].map((i) => {
    const n = createNode("rectangle");
    n.id = String(i);
    n.style.x = i * 100;
    n.style.y = i * 40;
    n.style.width = 60;
    n.style.height = 30;
    return n;
  });
  return { ...createStarter(), nodes } satisfies DesignDocument;
}
const apply = (doc: DesignDocument, operations: Operation[]) =>
  transact(doc, { baseRevision: doc.revision, operations });

test("zoom keeps the point under cursor fixed at negative and positive coordinates", () => {
  const before = { x: -130, y: 80, zoom: 0.75 },
    anchor = { x: 250, y: 300 };
  const world = screenToWorld(anchor, before);
  assert.deepEqual(screenToWorld(anchor, zoomAt(before, 2, anchor)), world);
});
test("fit handles distant negative document coordinates", () => {
  const rect = { x: -5000, y: -2000, width: 1000, height: 500 },
    v = fitViewport(rect, { width: 1000, height: 800 });
  assert.ok(v.zoom > 0);
  assert.ok(rect.x * v.zoom + v.x >= 0);
  assert.ok((rect.x + rect.width) * v.zoom + v.x <= 1000);
});
test("resize handles support reversed drag, minimum size and center scaling", () => {
  const start = { x: 100, y: 100, width: 200, height: 100 };
  assert.deepEqual(resizeRect(start, "nw", { x: 40, y: 20 }), {
    x: 140,
    y: 120,
    width: 160,
    height: 80,
  });
  assert.deepEqual(resizeRect(start, "se", { x: 50, y: 25 }, true, true), {
    x: 50,
    y: 75,
    width: 300,
    height: 150,
  });
  assert.equal(resizeRect(start, "w", { x: 1000, y: 0 }).width, 1);
});
test("snap uses nearest edge within world-space tolerance", () => {
  const result = snapMove(
    { x: 99, y: 50, width: 50, height: 50 },
    [{ x: 150, y: 0, width: 60, height: 40 }],
    3,
  );
  assert.equal(result.dx, 1);
  assert.ok(result.guides.some((g) => g.axis === "x" && g.value === 150));
});
test("selecting parent and child only produces one root operation", () => {
  const doc = createStarter();
  assert.deepEqual(
    selectionRoots(doc, [doc.nodes[0].id, doc.nodes[1].id]).map((n) => n.id),
    [doc.nodes[0].id],
  );
});
test("copy/paste a frame preserves nested layout and token bindings with entirely new IDs", () => {
  const doc = createStarter();
  const root = doc.nodes[0];
  const payload = readClipboard(
    JSON.stringify(copySelection(doc, [root.id, doc.nodes[1].id])),
  )!;
  const result = pasteSelection(doc, payload, null, { x: -200, y: 400 });
  const next = apply(doc, result.operations);
  const copied = next.nodes.filter(
    (n) => !doc.nodes.some((old) => old.id === n.id),
  );
  assert.equal(copied.length, 6);
  assert.equal(new Set(next.nodes.map((n) => n.id)).size, next.nodes.length);
  const frame = next.nodes.find((n) => n.id === result.selection[0])!;
  assert.equal(frame.style.x, -200);
  assert.equal(frame.style.y, 400);
  assert.equal(frame.style.layout, "column");
  assert.ok(copied.some((n) => n.fillToken === "brand"));
  parseDocument(next);
});
test("pasting from another file remaps conflicting tokens instead of changing existing designs", () => {
  const source = createStarter(),
    target = fixture();
  target.tokens.brand.value = "#000000";
  const payload = copySelection(source, [source.nodes[0].id]);
  const result = pasteSelection(target, payload, null);
  const next = apply(target, result.operations);
  assert.equal(next.tokens.brand.value, "#000000");
  const button = next.nodes.find(
    (n) => n.fillToken && n.fillToken !== "brand",
  )!;
  assert.equal(next.tokens[button.fillToken!].value, "#635bff");
});
test("copying nested locked content preserves locks without preventing creation", () => {
  const doc = createStarter();
  const frame = doc.nodes.find(
    (n) => n.parentId === doc.nodes[0].id && n.type === "frame",
  )!;
  frame.locked = true;
  const result = pasteSelection(
    doc,
    copySelection(doc, [doc.nodes[0].id]),
    null,
  );
  const next = apply(doc, result.operations);
  assert.equal(next.nodes.filter((n) => n.locked).length, 2);
});
test("plain text is distinguished from malformed native clipboard data", () => {
  assert.equal(readClipboard("hello"), null);
  assert.equal(readClipboard("{hello"), null);
  assert.throws(() => readClipboard('{"format":"forma/clipboard"}'));
});
test("group and ungroup preserve world positions, child IDs, and sibling order", () => {
  const doc = fixture();
  const before = layoutBounds(doc);
  const wrapped = wrapOperations(doc, ["1", "2"], "group");
  const grouped = apply(doc, wrapped.operations);
  const after = layoutBounds(grouped);
  for (const id of ["1", "2"]) assert.deepEqual(after.get(id), before.get(id));
  const unwrapped = ungroupOperations(grouped, [wrapped.id]);
  const next = apply(grouped, unwrapped.operations);
  for (const n of doc.nodes)
    assert.deepEqual(layoutBounds(next).get(n.id), before.get(n.id));
  assert.deepEqual(
    next.nodes.filter((n) => !n.parentId).map((n) => n.id),
    doc.nodes.map((n) => n.id),
  );
});
test("groups follow child bounds while frames remain fixed", () => {
  let doc = fixture();
  const wrapped = wrapOperations(doc, ["0", "1"], "group");
  doc = apply(doc, wrapped.operations);
  const group = doc.nodes.find((n) => n.id === wrapped.id)!;
  const before = layoutBounds(doc).get("0")!;
  doc = apply(doc, [{ type: "update", id: "1", patch: {}, style: { x: 400 } }]);
  assert.equal(doc.nodes.find((n) => n.id === group.id)!.style.width, 460);
  assert.deepEqual(layoutBounds(doc).get("0"), before);
});
test("reparenting into a nested free frame preserves world coordinates", () => {
  const doc = fixture();
  const frame = createNode("frame");
  frame.style.x = 500;
  frame.style.y = -300;
  doc.nodes.push(frame);
  const before = layoutBounds(doc).get("1");
  const next = apply(doc, reparentOperations(doc, ["1"], frame.id));
  assert.deepEqual(layoutBounds(next).get("1"), before);
  assert.equal(next.nodes.find((n) => n.id === "1")!.parentId, frame.id);
});
test("moving into a descendant is rejected atomically", () => {
  const doc = createStarter();
  const child = doc.nodes.find(
    (n) => n.parentId === doc.nodes[0].id && n.type === "frame",
  )!;
  assert.throws(
    () =>
      apply(doc, [{ type: "move", id: doc.nodes[0].id, parentId: child.id }]),
    /自身/,
  );
});
test("locked ancestor forbids editing a descendant or moving objects into it", () => {
  const doc = createStarter();
  doc.nodes[0].locked = true;
  assert.ok(isLocked(doc, doc.nodes[1].id));
  assert.throws(
    () =>
      apply(doc, [
        { type: "update", id: doc.nodes[1].id, patch: { text: "invalid" } },
      ]),
    /锁定/,
  );
  assert.throws(
    () =>
      apply(doc, [
        { type: "move", id: doc.nodes.at(-1)!.id, parentId: doc.nodes[0].id },
      ]),
    /锁定/,
  );
});
test("bring to front preserves multi-selection order and does not rewrite locked siblings", () => {
  const doc = fixture();
  doc.nodes[2].locked = true;
  const next = apply(doc, layerOrderOperations(doc, ["0", "1"], "front"));
  assert.deepEqual(
    next.nodes.map((n) => n.id),
    ["2", "3", "0", "1"],
  );
});
test("move backward and forward skip a selected adjacent block", () => {
  const doc = fixture();
  assert.deepEqual(
    apply(doc, layerOrderOperations(doc, ["1", "2"], "forward")).nodes.map(
      (n) => n.id,
    ),
    ["0", "3", "1", "2"],
  );
  assert.deepEqual(
    apply(doc, layerOrderOperations(doc, ["1", "2"], "backward")).nodes.map(
      (n) => n.id,
    ),
    ["1", "2", "0", "3"],
  );
});
test("alignment and distribution operate in shared world coordinates", () => {
  const doc = fixture();
  const next = apply(doc, alignOperations(doc, ["0", "1", "2"], "bottom"));
  assert.deepEqual(
    next.nodes.slice(0, 3).map((n) => n.style.y + n.style.height),
    [110, 110, 110],
  );
  doc.nodes[1].style.x = 20;
  const distributed = apply(
    doc,
    alignOperations(doc, ["0", "1", "2"], "horizontal"),
  );
  assert.deepEqual(
    distributed.nodes.slice(0, 3).map((n) => n.style.x),
    [0, 100, 200],
  );
});
test("flow reordering changes layout geometry and hidden children leave no gap", () => {
  const doc = createStarter();
  const parent = doc.nodes[0],
    children = doc.nodes.filter((n) => n.parentId === parent.id);
  const firstY = layoutBounds(doc).get(children[0].id)!.y;
  const next = apply(doc, [
    { type: "reorder", id: children.at(-1)!.id, index: 0 },
  ]);
  assert.equal(layoutBounds(next).get(children.at(-1)!.id)!.y, firstY);
  const hidden = apply(doc, [
    { type: "update", id: children[0].id, patch: { hidden: true } },
  ]);
  assert.equal(layoutBounds(hidden).get(children[1].id)!.y, firstY);
});
