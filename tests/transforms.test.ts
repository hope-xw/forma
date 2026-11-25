import test from "node:test";
import assert from "node:assert/strict";
import { createStarter } from "../src/domain/seed";
import { createNode } from "../src/domain/document";
import { transact } from "../src/domain/commands";
import { reparentOperations, alignOperations } from "../src/domain/editing";
import { layoutBounds } from "../src/domain/geometry";
import {
  transform,
  sceneTransforms,
  visualBounds,
} from "../src/domain/transforms";
import { copySelection, pasteSelection } from "../src/domain/clipboard";
import {
  readContours,
  pathData,
  splitSegment,
  vectorBounds,
} from "../src/domain/vector-path";
test("layer-tree reparent and clipboard preserve all four painted corners across rotated mirrored frames", () => {
  let doc = createStarter();
  const a = createNode("frame"),
    b = createNode("frame"),
    icon = createNode("rectangle", a.id);
  Object.assign(a.style, { rotation: 51, flipX: true, x: 120, y: 80 });
  Object.assign(b.style, { rotation: -23, y: 402 });
  Object.assign(icon.style, { rotation: -16, flipY: true, x: 42, y: 25 });
  doc.nodes = [a, b, icon];
  const corners = (id: string) => {
    const layout = layoutBounds(doc),
      r = layout.get(id)!,
      m = sceneTransforms(doc, layout).get(id)!;
    return [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ].map(([x, y]) =>
      transform(m, { x: r.x + x * r.width, y: r.y + y * r.height }),
    );
  };
  const expected = corners(icon.id);
  const compare = (id: string) =>
    corners(id).forEach((p, i) =>
      assert.ok(Math.hypot(p.x - expected[i].x, p.y - expected[i].y) < 0.001),
    );
  doc = transact(doc, {
    baseRevision: doc.revision,
    operations: reparentOperations(doc, [icon.id], b.id),
  });
  compare(icon.id);
  const clip = copySelection(doc, [icon.id]);
  const pasted = pasteSelection(doc, clip, a.id);
  doc = transact(doc, {
    baseRevision: doc.revision,
    operations: pasted.operations,
  });
  compare(pasted.selection[0]);
});
test("subdividing cubic paths preserves extrema, closure and canonical SVG", () => {
  const contours = readContours("M0 0 Q30 90 60 0 L30 0z");
  const paths = [{ contours, strokeWidth: 0, fill: true }];
  const before = vectorBounds(paths);
  assert.equal(before.height, 45);
  splitSegment(contours[0], 0);
  assert.deepEqual(vectorBounds(paths), before);
  const encoded = pathData(contours);
  assert.ok(encoded.includes("C"));
  assert.ok(encoded.endsWith("Z"));
  assert.equal(readContours(encoded)[0].anchors.length, 4);
});

test("alignment and distribution use painted edges for rotated siblings and transform world deltas across parents", () => {
  const doc = createStarter();
  const a = createNode("frame"),
    b = createNode("frame");
  const first = createNode("rectangle", a.id),
    mid = createNode("rectangle", a.id),
    last = createNode("rectangle", a.id),
    outside = createNode("rectangle", b.id);
  Object.assign(first.style, {
    x: 35,
    y: 18,
    width: 40,
    height: 20,
    rotation: 90,
  });
  Object.assign(mid.style, { x: 50, y: 50, width: 32, height: 20 });
  Object.assign(last.style, {
    x: 120,
    y: 35,
    width: 30,
    height: 22,
    rotation: -30,
  });
  Object.assign(b.style, { x: 350, y: 10, rotation: 45, flipX: true });
  doc.nodes = [a, b, first, mid, last, outside];
  const positions = (d: typeof doc, id: string) => {
    const layout = layoutBounds(d);
    return visualBounds(layout.get(id)!, sceneTransforms(d, layout).get(id)!);
  };
  for (const [ids, op] of [
    [[first.id, mid.id], "left"],
    [[first.id, outside.id], "top"],
  ] as const) {
    const next = transact(doc, {
      baseRevision: doc.revision,
      operations: alignOperations(doc, [...ids], op),
    });
    const key = op === "left" ? "x" : "y";
    assert.ok(
      Math.abs(positions(next, ids[0])[key] - positions(next, ids[1])[key]) <
        0.0001,
    );
  }
  const spaced = transact(doc, {
    baseRevision: doc.revision,
    operations: alignOperations(doc, [first.id, mid.id, last.id], "horizontal"),
  });
  const [l, m, r] = [first, mid, last].map((n) => positions(spaced, n.id));
  assert.ok(Math.abs(m.x - l.x - l.width - (r.x - m.x - m.width)) < 0.0001);
});
