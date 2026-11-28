import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import paper from "paper";
import { transact, type Operation } from "../src/domain/commands";
import {
  createNode,
  parseDocument,
  type DesignNode,
  type DesignDocument,
} from "../src/domain/document";
import { exportReact, nodeCss } from "../src/compiler/react";
import { symbolicNodeCss } from "../src/compiler/design-tokens";
import { vectorFillMask, vectorPathProps } from "../src/runtime/FormaRuntime";
import { nativeDesignSystem } from "../src/design-system/tokens";
import { resolveNode } from "../src/domain/design-system";
import { alignOperations } from "../src/domain/editing";
import {
  layoutBounds,
  union,
  type Point,
  type Rect,
} from "../src/domain/geometry";
import { indexPublishedScene } from "../src/domain/scene-index";
import { createStarter } from "../src/domain/seed";
import { textShapeStyleKey } from "../src/domain/text-shape";
import {
  localTransform,
  sceneTransforms,
  transform,
  visualBounds,
} from "../src/domain/transforms";
import {
  allAnchors,
  anchorKey,
  anchorsInRect,
  bendSegment,
  editablePaths,
  evalSegmentPoint,
  moveNetworkAnchors,
  nearestSegmentPoint,
  readContours,
  removeNetworkAnchors,
  sameAnchor,
  toggleAnchorsSmooth,
  vectorBounds,
  type AnchorIndex,
  type EditablePath,
} from "../src/domain/vector-path";
import {
  buildTextOutlineVector,
  canOutlineStroke,
  canOutlineText,
  outlineStrokeOperations,
  outlineStrokePath,
  outlineTextFromShapeOperations,
} from "../src/domain/vector-outline";
import { importFontBytes } from "../src/infrastructure/font-import";
import { outlineTextNode } from "../src/infrastructure/text-outline";

const at = (a: number, c = 0, p = 0): AnchorIndex => ({ p, c, a });
const path = (d: string): EditablePath => ({
  fill: false,
  strokeWidth: 0,
  contours: readContours(d),
});
const close = (a: number, b: number, epsilon = 1e-6) =>
  assert.ok(
    Math.abs(a - b) < epsilon,
    `expected ${a} within ${epsilon} of ${b}`,
  );
function pointClose(a: Point, b: Point, epsilon?: number) {
  close(a.x, b.x, epsilon);
  close(a.y, b.y, epsilon);
}
function boxClose(a: Rect, b: Rect, epsilon?: number) {
  pointClose(a, b, epsilon);
  close(a.width, b.width, epsilon);
  close(a.height, b.height, epsilon);
}
const api = new paper.PaperScope();
api.setup(new api.Size(1, 1));
function area(d: string) {
  return new api.CompoundPath({
    pathData: d,
    fillRule: "nonzero",
    insert: false,
  });
}
const contains = (d: string, x: number, y: number) =>
  area(d).contains(new api.Point(x, y));
function scene(n: DesignNode) {
  const frame = createNode("frame");
  n.parentId = frame.id;
  const before = createNode("rectangle", frame.id),
    after = createNode("rectangle", frame.id);
  const doc: DesignDocument = {
    ...createStarter(),
    nodes: [frame, before, n, after],
  };
  return { doc, frame, before, after };
}
type Result = { operations: Operation[]; nodeId: string };
function roundtrip(doc: DesignDocument, result: Result, old: DesignNode) {
  const snapshot = JSON.stringify(doc);
  const updated = transact(doc, {
    baseRevision: doc.revision,
    operations: result.operations,
  });
  const reopened = parseDocument(JSON.parse(JSON.stringify(updated)));
  assert.equal(reopened.revision, doc.revision + 1);
  const n = reopened.nodes.find((n) => n.id === result.nodeId)!;
  assert.equal(n.id, old.id);
  assert.equal(n.type, "vector");
  assert.equal(n.parentId, old.parentId);
  assert.deepEqual(
    reopened.nodes.filter((s) => s.parentId === n.parentId).map((s) => s.id),
    doc.nodes
      .filter((s) => s.parentId === old.parentId)
      .map((s) => (s.id === old.id ? n.id : s.id)),
  );
  assert.equal(JSON.stringify(doc), snapshot);
  assert.ok(n.vector);
  const paths = editablePaths(n.vector);
  assert.ok(paths.length);
  for (const p of paths) {
    assert.equal(p.fill, true);
    assert.equal(p.strokeWidth, 0);
    assert.ok(
      p.contours.length &&
        p.contours.every((c) => c.closed && c.anchors.length > 0),
    );
  }
  return { n, paths, vector: n.vector };
}
function parentPoint(n: DesignNode, p: Point) {
  return transform(localTransform(n, n.style), {
    x: n.style.x + p.x,
    y: n.style.y + p.y,
  });
}

test("anchor indices enumerate across paths and include every rectangle boundary", () => {
  const paths = [path("M0 0H10V10 M10 0L3 8"), path("M-1 5L5 10")];
  assert.deepEqual(allAnchors(paths), [
    at(0),
    at(1),
    at(2),
    at(0, 1),
    at(1, 1),
    at(0, 0, 1),
    at(1, 0, 1),
  ]);
  assert.deepEqual(
    anchorsInRect(paths, { x: 0, y: 0, width: 10, height: 10 }),
    allAnchors(paths).filter((a) => !sameAnchor(a, at(0, 0, 1))),
  );
  assert.deepEqual(anchorsInRect(paths, { x: 10, y: 0, width: 0, height: 0 }), [
    at(1),
    at(0, 1),
  ]);
  assert.equal(anchorKey(at(1, 2, 3)), anchorKey({ ...at(1, 2, 3) }));
  assert.equal(new Set(allAnchors(paths).map(anchorKey)).size, 7);
});

test("multi-move translates handles, shared references and indirect junctions exactly once", () => {
  const paths = [path("M0 0C1 2 8 2 10 0 M10 0H20"), path("M12 1H30")];
  const [first, second] = paths[0].contours;
  const linked = paths[1].contours[0].anchors[0];
  first.anchors[1].junction =
    second.anchors[0].junction =
    linked.junction =
      "joint";
  paths[1].contours[0].anchors.push(first.anchors[1]);
  moveNetworkAnchors(paths, [at(1), at(0, 1), at(1), at(0)], { x: 3, y: -4 });
  pointClose(first.anchors[0], { x: 3, y: -4 });
  pointClose(first.anchors[0].outgoing!, { x: 4, y: -2 });
  pointClose(first.anchors[1].incoming!, { x: 11, y: -2 });
  for (const a of [
    first.anchors[1],
    second.anchors[0],
    paths[1].contours[0].anchors[2],
  ])
    pointClose(a, { x: 13, y: -4 });
  pointClose(linked, { x: 15, y: -3 });
  pointClose(second.anchors[1], { x: 20, y: 0 });
});

test("deletion is atomic when the survivors are isolated across contours", () => {
  const paths = [path("M0 0L5 5 M10 10H20")],
    before = structuredClone(paths);
  assert.equal(removeNetworkAnchors(paths, [at(0), at(1, 1)]), false);
  assert.deepEqual(paths, before);
  assert.equal(removeNetworkAnchors(paths, [at(42)]), false);
  assert.equal(removeNetworkAnchors(paths, allAnchors(paths), false), true);
  assert.deepEqual(paths, []);
});
test("deletion handles duplicates in reverse order, opens short contours and prunes orphans", () => {
  const paths = [path("M0 0L1 1L2 2L3 0Z M10 10H20"), path("M40 0H50")];
  assert.equal(
    removeNetworkAnchors(paths, [
      at(0),
      at(2),
      at(2),
      at(1, 1),
      at(0, 0, 1),
      at(1, 0, 1),
    ]),
    true,
  );
  assert.equal(paths.length, 1);
  assert.equal(paths[0].contours.length, 1);
  assert.deepEqual(paths[0].contours[0], {
    closed: false,
    anchors: [
      { x: 1, y: 1 },
      { x: 3, y: 0 },
    ],
  });
});
test("mixed smooth selection preserves existing handles then sharpens the whole selection", () => {
  const paths = [path("M0 0L6 6L18 6"), path("M0 0H12V12Z")];
  const [a, b, c] = paths[0].contours[0].anchors;
  a.outgoing = { x: 1, y: 5 };
  const selected = allAnchors(paths);
  toggleAnchorsSmooth(paths, [...selected, at(2)]);
  assert.deepEqual(a.outgoing, { x: 1, y: 5 });
  assert.equal(a.incoming, undefined);
  pointClose(b.outgoing!, { x: 9, y: 7 });
  pointClose(b.incoming!, { x: 3, y: 5 });
  pointClose(c.outgoing!, { x: 22, y: 6 });
  pointClose(c.incoming!, { x: 14, y: 6 });
  pointClose(paths[1].contours[0].anchors[0].outgoing!, { x: 0, y: -2 });
  toggleAnchorsSmooth(paths, selected);
  assert.ok(
    paths.every((p) =>
      p.contours.every((c) =>
        c.anchors.every((a) => !a.incoming && !a.outgoing),
      ),
    ),
  );
  toggleAnchorsSmooth(paths, [at(0)]);
  pointClose(a.outgoing!, { x: 2, y: 2 });
});

for (const [kind, d] of [
  ["line", "M0 0L100 10"],
  ["cubic", "M0 0C20 80 90 -40 100 10"],
]) {
  test(`${kind} hit reports the nearest parameter and bends to the cursor without moving anchors`, () => {
    const paths = [path("M0 1000H20"), path(d)],
      [a, b] = paths[1].contours[0].anchors;
    const point = evalSegmentPoint(a, b, 0.3765);
    const hit = nearestSegmentPoint(paths, point, 0.001);
    assert.ok(hit && hit.p === 1 && hit.index === 0);
    close(hit.t, 0.3765);
    pointClose(hit.point, point, 1e-4);
    close(hit.distance, 0, 1e-4);
    assert.equal(nearestSegmentPoint(paths, { x: 400, y: 400 }, 4), null);
    const target = { x: 25, y: 49 };
    assert.ok(bendSegment(paths, hit, target));
    assert.ok(a.outgoing && b.incoming);
    pointClose(evalSegmentPoint(a, b, hit.t), target, 1e-7);
    pointClose(a, { x: 0, y: 0 });
    pointClose(b, { x: 100, y: 10 });
  });
}
test("bend handles a closing edge, clamps endpoints, and preserves unrelated control handles", () => {
  const paths = [path("M0 0H20L20 20Z")],
    c = paths[0].contours[0];
  const hit = nearestSegmentPoint(paths, { x: 8, y: 8 }, 0.01)!;
  assert.equal(hit.index, 2);
  c.anchors[2].outgoing = { x: 15, y: 10 };
  c.anchors[0].outgoing = { x: 5, y: 0 };
  const grab = evalSegmentPoint(c.anchors[2], c.anchors[0], 0.15);
  assert.ok(bendSegment(paths, { ...hit, t: -0.1 }, { x: 20, y: 8 }));
  pointClose(
    evalSegmentPoint(c.anchors[2], c.anchors[0], 0.15),
    { x: grab.x, y: grab.y - 12 },
    1e-7,
  );
  assert.deepEqual(c.anchors[0].outgoing, { x: 5, y: 0 });
  c.closed = false;
  const before = structuredClone(paths);
  assert.equal(bendSegment(paths, hit, { x: 0, y: 0 }), false);
  assert.deepEqual(paths, before);
});

for (const cap of ["butt", "round", "square"] as const) {
  test(`open line has exact ${cap} cap extension and cap silhouette`, () => {
    const d = outlineStrokePath("M10 20H70", 10, { lineCap: cap });
    const outset = cap === "butt" ? 0 : 5;
    boxClose(vectorBounds([path(d)]), {
      x: 10 - outset,
      y: 15,
      width: 60 + 2 * outset,
      height: 10,
    });
    assert.ok(readContours(d).every((c) => c.closed));
    assert.equal(contains(d, 6, 20), cap !== "butt");
    assert.equal(contains(d, 5.5, 15.5), cap === "square");
  });
}
for (const join of ["miter", "round", "bevel"] as const) {
  test(`open right angle uses the ${join} join geometry`, () => {
    const d = outlineStrokePath("M0 0H40V40", 10, {
      lineCap: "butt",
      lineJoin: join,
    });
    assert.equal(contains(d, 44, -4), join === "miter");
    assert.equal(contains(d, 43.2, -3.2), join !== "bevel");
    assert.ok(contains(d, 41, -1));
    if (join === "miter")
      assert.equal(
        contains(
          outlineStrokePath("M0 0H40V40", 10, {
            lineJoin: join,
            miterLimit: 1,
          }),
          44,
          -4,
        ),
        false,
      );
  });
}
test("compound stroke unions crossing strips, retains closed holes, and fills collapsed holes", () => {
  const d = outlineStrokePath("M0 0H60V60H0Z M30 -20V80", 8, {
    lineJoin: "miter",
    lineCap: "butt",
  });
  for (const [x, y] of [
    [30, 0],
    [30, 30],
    [0, 30],
    [60, 60],
  ])
    assert.ok(contains(d, x, y));
  assert.equal(contains(d, 10, 10), false);
  assert.equal(contains(d, 50, 50), false);
  assert.ok(readContours(d).every((c) => c.closed));
  const thick = outlineStrokePath("M0 0H10V10H0Z", 20, { lineJoin: "miter" });
  assert.ok(contains(thick, 5, 5));
});
test("adaptive cubic offsets follow the curve's normals and preserve horizontal butt ends", () => {
  const source = "M0 0C0 80 100 80 100 0",
    d = outlineStrokePath(source, 8, { lineCap: "butt" });
  const [a, b] = readContours(source)[0].anchors;
  boxClose(
    vectorBounds([path(d)]),
    { x: -4, y: 0, width: 108, height: 64 },
    0.03,
  );
  for (const t of [0.1, 0.25, 0.5, 0.73, 0.9]) {
    const p = evalSegmentPoint(a, b, t);
    const dx = 600 * t * (1 - t),
      dy = 240 * (1 - 2 * t),
      length = Math.hypot(dx, dy);
    for (const sign of [-1, 1]) {
      assert.ok(
        contains(
          d,
          p.x + (sign * 3.7 * dy) / length,
          p.y - (sign * 3.7 * dx) / length,
        ),
      );
      assert.equal(
        contains(
          d,
          p.x + (sign * 4.3 * dy) / length,
          p.y - (sign * 4.3 * dx) / length,
        ),
        false,
      );
    }
  }
});
test("zero-length segments retain a round dot, and zero-width strokes have no area", () => {
  const dot = outlineStrokePath("M5 8L5 8L5 8", 6, { lineCap: "round" });
  boxClose(vectorBounds([path(dot)]), { x: 2, y: 5, width: 6, height: 6 });
  assert.ok(contains(dot, 5, 8) && !contains(dot, 2.1, 5.1));
  assert.equal(outlineStrokePath("M5 8L5 8", 6, { lineCap: "butt" }), "");
  assert.equal(outlineStrokePath("M0 0L1 1", 0), "");
});

for (const kind of ["rectangle", "ellipse"] as const)
  for (const align of ["inside", "center", "outside"] as const) {
    test(`${kind} ${align} roundtrip preserves painted bounds, fill, ring, pose and z-order`, () => {
      const raw = createNode(kind),
        { doc } = scene(raw);
      Object.assign(raw.style, {
        x: -24,
        y: 61,
        width: 100,
        height: 60,
        radius: 13,
        rotation: 32,
        flipX: true,
        opacity: 0.7,
        strokeAlign: align,
        strokeWidth: 8,
        stroke: "#abcdef",
        strokeOpacity: 0.4,
        fill: "#ab2311",
        fillOpacity: 0.8,
      });
      assert.ok(canOutlineStroke(doc, raw.id));
      const result = outlineStrokeOperations(doc, raw.id);
      assert.equal(result.nodeId, raw.id);
      assert.deepEqual(
        result.operations.map((op) => op.type),
        ["convertToVector"],
      );
      const { n, paths, vector } = roundtrip(doc, result, raw);
      const outset = align === "inside" ? 0 : align === "center" ? 4 : 8;
      boxClose(n.style, {
        x: raw.style.x - outset,
        y: raw.style.y - outset,
        width: 100 + 2 * outset,
        height: 60 + 2 * outset,
      });
      pointClose(
        parentPoint(n, { x: outset + 50, y: outset }),
        parentPoint(raw, { x: 50, y: 0 }),
      );
      assert.equal(n.style.rotation, 32);
      assert.equal(n.style.flipX, true);
      assert.equal(n.style.opacity, 0.7);
      assert.deepEqual(
        paths.map((p) => [p.fillColor, p.fillOpacity, p.contours.length]),
        [
          ["#ab2311", 0.8, 1],
          ["#abcdef", 0.4, 2],
        ],
      );
      assert.ok(!contains(vector.paths[1].d, 50 + outset, 30 + outset));
      assert.ok(contains(vector.paths[1].d, 50 + outset, 4));
      assert.equal(contains(vector.paths[1].d, 0.1, 0.1), false);
      assert.equal(n.style.strokeWidth, 0);
    });
  }
test("a thick inside stroke with invisible fill becomes one solid contour", () => {
  const raw = createNode("ellipse"),
    { doc } = scene(raw);
  Object.assign(raw.style, {
    width: 40,
    height: 20,
    strokeWidth: 15,
    fillOpacity: 0,
  });
  const { paths, vector } = roundtrip(
    doc,
    outlineStrokeOperations(doc, raw.id),
    raw,
  );
  assert.equal(paths.length, 1);
  assert.equal(paths[0].contours.length, 1);
  assert.ok(contains(vector.paths[0].d, 20, 10));
});
test("disabled and independently sized sides preserve their actual coverage", () => {
  const raw = createNode("rectangle"),
    { doc } = scene(raw);
  Object.assign(raw.style, {
    width: 40,
    height: 20,
    strokeWidth: 4,
    fillOpacity: 0,
    radius: 0,
    strokeSides: { top: 0, left: 0, right: 0, bottom: 0 },
  });
  assert.equal(canOutlineStroke(doc, raw.id), false);
  raw.style.strokeSides!.top = 6;
  const { n, vector } = roundtrip(
    doc,
    outlineStrokeOperations(doc, raw.id),
    raw,
  );
  boxClose(n.style, { x: 0, y: 0, width: 40, height: 6 });
  assert.ok(contains(vector.paths[0].d, 20, 3));
  raw.style.strokeVisible = false;
  assert.equal(canOutlineStroke(doc, raw.id), false);
});

for (const stretch of [true, undefined] as const) {
  test(`vector outline updates in place with ${stretch ? "stretched" : "letterboxed"} coordinates and fill metadata`, () => {
    const raw = createNode("vector"),
      { doc } = scene(raw);
    raw.vector = {
      width: 100,
      height: 100,
      stretch,
      overflowVisible: true,
      paths: [
        {
          d: "M0 20H40V40H0Z",
          fill: true,
          fillRule: "evenodd",
          fillColor: "#cc3344",
          fillOpacity: 0.45,
          strokeWidth: 10,
          lineJoin: "miter",
          strokeColor: "#119944",
          strokeOpacity: 0.6,
          opacity: 1,
          junctions: [{ id: "junction", contour: 0, anchor: 1 }],
        },
        { d: "M60 10V50", fill: false, strokeWidth: 4, lineCap: "square" },
      ],
    };
    Object.assign(raw.style, {
      x: 20,
      y: 30,
      width: 240,
      height: 80,
      rotation: 37,
      flipY: true,
      color: "#222244",
    });
    const result = outlineStrokeOperations(doc, raw.id);
    assert.equal(result.nodeId, raw.id);
    assert.deepEqual(
      result.operations.map((op) => op.type),
      ["convertToVector"],
    );
    const { n, paths, vector } = roundtrip(doc, result, raw);
    assert.equal(paths.length, 3);
    assert.deepEqual(
      paths.map((p) => p.fillColor),
      ["#cc3344", "#119944", undefined],
    );
    assert.equal(paths[0].fillRule, "evenodd");
    assert.equal(paths[0].contours[0].anchors[1].junction, "junction");
    assert.equal(paths[1].fillOpacity, 0.6);
    assert.equal(paths[1].opacity, 1);

    const sx = stretch ? 2.4 : 0.8,
      sy = 0.8,
      offset = stretch ? 0 : 80;
    assert.equal(contains(vector.paths[1].d, 25 * sx, 22 * sy), false);
    close(n.style.width, 67 * sx);
    close(n.style.height, 44 * sy);
    const first = paths[0].contours[0].anchors[0];
    pointClose(
      parentPoint(n, first),
      parentPoint(raw, { x: offset, y: 20 * sy }),
    );
  });
}

test("locked ancestors, instance owners and blank text reject outline transactions", async () => {
  const n = createNode("text"),
    { doc, frame } = scene(n),
    shape = createNode("rectangle", frame.id);
  shape.style.strokeWidth = 4;
  doc.nodes.push(shape);
  for (const protection of ["self", "ancestor", "instance"]) {
    n.locked = shape.locked = protection === "self";
    frame.locked = protection === "ancestor";
    frame.instance =
      protection === "instance"
        ? { libraryId: "lib", componentId: "c", variantId: "v" }
        : undefined;
    const snapshot = JSON.stringify(doc);
    assert.equal(canOutlineText(doc, n.id), false);
    assert.equal(canOutlineStroke(doc, shape.id), false);
    assert.equal(outlineTextFromShapeOperations(doc, n.id), null);
    await assert.rejects(outlineTextNode(doc, n.id), /锁定.*实例/);
    assert.throws(() => outlineStrokeOperations(doc, shape.id), /锁定.*实例/);
    assert.equal(JSON.stringify(doc), snapshot);
  }
  delete frame.instance;
  n.text = " \n ";
  assert.equal(canOutlineText(doc, n.id), false);
  await assert.rejects(outlineTextNode(doc, n.id), /非空/);
  assert.equal(canOutlineStroke(doc, "missing"), false);
});

test("source glyph outlines stay pinned through rotated, flipped replacement and take precedence over fonts", async () => {
  const raw = createNode("text"),
    { doc } = scene(raw);
  raw.name = "标题";
  raw.text = "O";
  Object.assign(raw.style, {
    x: 19,
    y: -7,
    width: 60,
    height: 40,
    rotation: -27,
    flipX: true,
    color: "#345678",
    colorOpacity: 0.37,
    opacity: 0.8,
  });
  raw.sourceTextShape = {
    text: "O",
    styleKey: textShapeStyleKey(raw.style),
    width: 60,
    height: 40,
    d: "M8 4H36V32H8Z M15 10V24H27V10Z",
  };
  const built = buildTextOutlineVector(
    raw,
    raw,
    raw.sourceTextShape.d,
    60,
    40,
    "evenodd",
  );
  assert.equal(built.paths[0].fillRule, "evenodd");
  close(built.width, 28);
  close(built.height, 28);
  for (const result of [
    outlineTextFromShapeOperations(doc, raw.id),
    await outlineTextNode(doc, raw.id),
  ]) {
    assert.ok(result);
    assert.deepEqual(
      result.operations.map((op) => op.type),
      ["convertToVector"],
    );
    const { n, vector } = roundtrip(doc, result, raw);
    assert.equal(n.name, "标题（轮廓）");
    assert.equal(n.style.rotation, -27);
    assert.equal(n.style.opacity, 0.8);
    pointClose(
      parentPoint(n, { x: 0, y: 0 }),
      parentPoint(raw, { x: 8, y: 4 }),
    );
    pointClose(
      parentPoint(n, { x: 28, y: 28 }),
      parentPoint(raw, { x: 36, y: 32 }),
    );
    assert.equal(vector.paths[0].fillColor, "#345678");
    assert.equal(vector.paths[0].fillOpacity, 0.37);
    assert.equal(contains(vector.paths[0].d, 12, 12), false);
    assert.ok(contains(vector.paths[0].d, 2, 2));
  }
  raw.text = "changed";
  assert.equal(outlineTextFromShapeOperations(doc, raw.id), null);
});

async function embeddedText() {
  const bytes = await readFile(
    new URL("./fixtures/forma-geometry-test.ttf", import.meta.url),
  );
  const { id, asset } = await importFontBytes(bytes, "Forma Geometry.ttf");
  const n = createNode("text"),
    { doc } = scene(n);
  doc.fonts = { [id]: asset };
  Object.assign(n.style, {
    width: 60,
    height: 50,
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 1,
    fontFamily: id,
    fontVariationSettings: '"wght" 535',
    fontWeight: 500,
    textAlign: "center",
    verticalAlign: "bottom",
    textTransform: "uppercase",
  });
  return { doc, n, id };
}
test("real embedded outlines use shaped advances, Y-up metrics, tracking and line alignment", async () => {
  const { doc, n } = await embeddedText();
  n.text = "ab\na";
  // Fixture letters have a 600-unit advance and a triangular 500 x 650-unit ink box.
  for (const family of [n.style.fontFamily!, `"Missing", 'Forma Geometry'`]) {
    n.style.fontFamily = family;
    const {
      n: out,
      paths,
      vector,
    } = roundtrip(doc, await outlineTextNode(doc, n.id), n);
    boxClose(out.style, { x: 23, y: 28.5, width: 12, height: 18.5 });
    assert.equal(paths.length, 1);
    assert.equal(vector.stretch, true);
    const [a, b, c] = paths[0].contours;
    assert.equal(paths[0].contours.length, 3);
    assert.deepEqual(
      a.anchors.map((p) => [p.x, p.y]),
      [
        [0, 6.5],
        [2.5, 0],
        [5, 6.5],
      ],
    );
    pointClose(b.anchors[0], { x: 7, y: 6.5 });
    pointClose(c.anchors[0], { x: 3.5, y: 18.5 });
  }
});
test("fixed width wraps at words, preserves blank rows and reshapes line starts", async () => {
  const { doc, n } = await embeddedText();
  n.text = "AB AB\n\nA";
  Object.assign(n.style, {
    width: 13,
    height: 48,
    textAlign: "right",
    verticalAlign: "top",
    letterSpacing: 0,
  });
  const { paths, n: out } = roundtrip(doc, await outlineTextNode(doc, n.id), n);
  const origins = paths[0].contours.map((c) => c.anchors[0]);
  assert.deepEqual(
    origins.map((p) => [p.x + out.style.x, p.y + out.style.y]),
    [
      [1, 9],
      [7, 9],
      [1, 21],
      [7, 21],
      [7, 45],
    ],
  );
});
test("missing family reports uncovered glyphs even when the document embeds an unrelated face", async () => {
  const { doc, n } = await embeddedText();
  n.text = "AB";
  n.style.fontFamily = "System UI, sans-serif";
  const before = JSON.stringify(doc);
  await assert.rejects(
    outlineTextNode(doc, n.id, { resolveSystemFonts: async () => [] }),
    /System UI, sans-serif.*缺少部分字形.*U\+41.*U\+42/,
  );
  assert.equal(JSON.stringify(doc), before);
});
test("missing glyph coverage leaves text intact rather than baking fallback boxes", async () => {
  const { doc, n } = await embeddedText();
  n.text = "设计";
  const before = JSON.stringify(doc);
  await assert.rejects(outlineTextNode(doc, n.id), /缺少部分字形/);
  assert.equal(JSON.stringify(doc), before);
});

test("a single cubic closing back to its own anchor retains its stroked loop", () => {
  const d = "M0 0C60 -50 60 50 0 0Z";
  assert.equal(readContours(d)[0].anchors.length, 1);
  const outline = outlineStrokePath(d, 3);
  assert.ok(contains(outline, 45, 0));
  assert.equal(contains(outline, 25, 0), false);
});

test("subpixel stroke bounds stay tight through a document roundtrip", () => {
  const raw = createNode("vector"),
    { doc } = scene(raw);
  raw.style.width = raw.style.height = 10;
  raw.vector = {
    width: 10,
    height: 10,
    paths: [{ d: "M2 2h5", fill: false, strokeWidth: 0.25, lineCap: "butt" }],
  };
  const { n } = roundtrip(doc, outlineStrokeOperations(doc, raw.id), raw);
  boxClose(n.style, { x: 2, y: 1.875, width: 5, height: 0.25 });
});

test("quoted family lists select the matching embedded face by weight", async () => {
  const { doc, n, id } = await embeddedText();
  const regular = {
    ...doc.fonts![id],
    name: "Forma, Geometry",
    weight: 400,
    axes: [],
  };
  const otherId = "font-" + "1".repeat(64);
  // The mismatched face is intentionally unreadable; selecting it would abort shaping.
  doc.fonts = {
    [otherId]: { ...regular, weight: 800, data: "data:font/ttf;base64,AAAA" },
    [id]: regular,
  };
  n.text = "AB";
  n.style.fontFamily = 'Missing, "Forma, Geometry"';
  n.style.fontWeight = 400;
  const result = await outlineTextNode(doc, n.id);
  assert.ok(
    result.operations[0].type === "convertToVector" &&
      result.operations[0].vector.paths[0].d,
  );
});

function apply(doc: DesignDocument, operations: Operation[]) {
  return transact(doc, { baseRevision: doc.revision, operations });
}

test("atomic conversion preserves references, metadata and sibling order through save/reopen", () => {
  const n = createNode("rectangle"),
    { doc, frame, before, after } = scene(n);
  frame.type = "group";
  frame.maskSourceId = n.id;
  n.style.strokeWidth = 5;
  n.annotations = [{ id: "spec", category: "dev", text: "Border dimensions" }];
  n.exportSettings = [{ id: "out", format: "svg", scale: 1, suffix: "" }];
  n.devStatus = "ready";
  n.interaction = { actions: [{ kind: "back" }] };
  n.interactions = [
    { trigger: "hover", actions: [{ kind: "scrollTo", target: after.id }] },
  ];
  before.interactions = [
    {
      actions: [
        { kind: "scrollTo", target: n.id },
        { kind: "navigate", target: n.id },
      ],
      otherwise: [{ kind: "overlay", position: "center", target: n.id }],
    },
  ];
  doc.comments = [
    {
      id: "note",
      nodeId: n.id,
      x: 3,
      y: 5,
      author: "D",
      text: "ink",
      createdAt: "2026-11-27",
      resolved: false,
      replies: [],
    },
  ];
  const result = outlineStrokeOperations(doc, n.id);
  assert.equal(result.nodeId, n.id);
  const reopened = parseDocument(
    JSON.parse(JSON.stringify(apply(doc, result.operations))),
  );
  assert.deepEqual(
    reopened.nodes.map((s) => s.id),
    doc.nodes.map((s) => s.id),
  );
  assert.deepEqual(reopened.comments, doc.comments);
  assert.equal(reopened.nodes[0].maskSourceId, n.id);
  assert.deepEqual(reopened.nodes[1].interactions, before.interactions);
  const converted = reopened.nodes[2];
  for (const key of [
    "id",
    "parentId",
    "annotations",
    "exportSettings",
    "devStatus",
    "interaction",
    "interactions",
  ] as const)
    assert.deepEqual(converted[key], n[key]);
});

test("convertToVector enforces transaction protection, clears incompatible fields and keeps untouched bindings", () => {
  const n = createNode("text"),
    { doc, frame } = scene(n);
  doc.designSystem = nativeDesignSystem();
  n.variableBindings = { color: "color-accent", width: "space-md" };
  n.text = "A";
  n.image = {
    assetId: "img-" + "a".repeat(64),
    fit: "cover",
    x: 50,
    y: 50,
    zoom: 1,
  };
  doc.images = {
    [n.image.assetId]: {
      name: "Photo",
      width: 1,
      height: 1,
      data: "data:image/png;base64,AAAA",
    },
  };
  n.textRuns = [{ start: 0, end: 1, style: { color: "#ff0000" } }];
  n.sourceTextShape = {
    text: "A",
    styleKey: "key",
    width: 20,
    height: 20,
    d: "M0 0H20V20Z",
  };
  n.sourceTextLayout = {
    text: "A",
    styleKey: "key",
    width: 20,
    height: 20,
    lines: [{ text: "A", x: [0], y: 10 }],
  };
  const op: Operation = {
    type: "convertToVector",
    id: n.id,
    vector: {
      width: 20,
      height: 20,
      paths: [{ d: "M0 0H20V20Z", fill: true, strokeWidth: 0 }],
    },
    patch: { name: "Converted" },
    style: { width: 20 },
  };
  for (const mode of ["node", "parent", "instanceRoot", "instanceChild"]) {
    n.locked = mode === "node";
    frame.locked = mode === "parent";
    const instance = {
      libraryId: "lib",
      componentId: "component",
      variantId: "variant",
    };
    n.instance = mode === "instanceRoot" ? instance : undefined;
    frame.instance = mode === "instanceChild" ? instance : undefined;
    const before = JSON.stringify(doc);
    assert.throws(() => apply(doc, [op]), /锁定|组件/);
    assert.equal(JSON.stringify(doc), before);
  }
  delete frame.instance;
  const out = apply(doc, [op]).nodes.find((s) => s.id === n.id)!;
  assert.equal(out.text, "");
  for (const key of [
    "textRuns",
    "sourceTextShape",
    "sourceTextLayout",
    "image",
    "booleanOperation",
  ] as const)
    assert.equal(out[key], undefined);
  assert.deepEqual(out.variableBindings, n.variableBindings);
  assert.equal(out.name, "Converted");
});

for (const layout of ["row", "column", "grid"] as const) {
  test(`outline uses computed ${layout} layout pixels and leaves all sibling footprints pinned`, () => {
    const raw = createNode("rectangle"),
      { doc, frame, before, after } = scene(raw);
    Object.assign(frame.style, {
      layout,
      width: 620,
      height: 320,
      x: 30,
      y: 20,
      gap: 10,
      padding: 0,
      columns: 3,
      rotation: 36,
      flipY: true,
    });
    Object.assign(raw.style, {
      x: 17,
      y: 19,
      width: 40,
      height: 20,
      widthMode: "fill",
      strokeAlign: "outside",
      strokeWidth: 9,
      flipX: true,
      rotation: 27,
    });
    before.style.width = after.style.width = 50;
    const bounds = layoutBounds(doc),
      rect = bounds.get(raw.id)!;
    assert.ok(rect.width > 40);
    const updated = apply(doc, outlineStrokeOperations(doc, raw.id).operations);
    const out = updated.nodes.find((n) => n.id === raw.id)!;
    const afterBounds = layoutBounds(updated);
    for (const n of doc.nodes)
      boxClose(afterBounds.get(n.id)!, bounds.get(n.id)!);
    assert.equal(out.style.widthMode, "fill");
    assert.equal(out.style.x, 17);
    assert.equal(out.style.y, 19);
    assert.equal(out.vector!.width, rect.width);
    assert.equal(out.vector!.height, rect.height);
    assert.equal(out.vector!.stretch, undefined);
    assert.equal(out.vector!.overflowVisible, true);
    assert.ok(
      contains(out.vector!.paths[1].d, rect.width + 4, rect.height / 2),
    );
    assert.ok(
      contains(out.vector!.paths[0].d, rect.width - 10, rect.height / 2),
    );
  });
}

test("free absolute stroke conversion preserves asymmetric ink in rotated and reflected ancestors", () => {
  const raw = createNode("rectangle"),
    { doc, frame } = scene(raw);
  Object.assign(frame.style, {
    x: 400,
    y: 215,
    rotation: 39,
    flipY: true,
    layout: "row",
  });
  Object.assign(raw.style, {
    x: 71,
    y: 9,
    width: 80,
    height: 30,
    radius: 0,
    strokeSides: { left: 8 },
    strokeAlign: "outside",
    rotation: 51,
    flipX: true,
    fillOpacity: 0,
    absolutePosition: true,
  });
  const oldBounds = layoutBounds(doc),
    r = oldBounds.get(raw.id)!;
  const next = apply(doc, outlineStrokeOperations(doc, raw.id).operations);
  const newBounds = layoutBounds(next),
    q = newBounds.get(raw.id)!;
  for (const [dx, dy] of [
    [0, 0],
    [8, 0],
    [0, 30],
    [8, 30],
  ]) {
    pointClose(
      transform(sceneTransforms(doc, oldBounds).get(raw.id)!, {
        x: r.x - 8 + dx,
        y: r.y + dy,
      }),
      transform(sceneTransforms(next, newBounds).get(raw.id)!, {
        x: q.x + dx,
        y: q.y + dy,
      }),
    );
  }
});

test("embedded text shapes against its laid-out fill width and retains text bearings within the row", async () => {
  const { doc, n } = await embeddedText();
  const [parent, before, , after] = doc.nodes;
  Object.assign(parent.style, {
    layout: "row",
    width: 600,
    gap: 0,
    padding: 0,
  });
  before.style.width = 50;
  after.style.width = 50;
  n.text = "AB";
  Object.assign(n.style, {
    width: 40,
    widthMode: "fill",
    textAlign: "center",
    letterSpacing: 0,
  });
  const oldBounds = layoutBounds(doc);
  const updated = apply(doc, (await outlineTextNode(doc, n.id)).operations);
  const out = updated.nodes.find((s) => s.id === n.id)!;
  assert.equal(out.vector!.width, 500);
  const ink = vectorBounds(editablePaths(out.vector!), 0);
  close(ink.x, 244);
  for (const layer of doc.nodes)
    boxClose(layoutBounds(updated).get(layer.id)!, oldBounds.get(layer.id)!);
});

test("fill token and legacy fillToken remain live in the vector fill mask", () => {
  for (const legacy of [false, true]) {
    const n = createNode("rectangle"),
      { doc } = scene(n);
    n.style.strokeWidth = 3;
    if (legacy) {
      doc.tokens.blue = { name: "Blue", value: "#2563eb" };
      n.fillToken = "blue";
    } else {
      doc.designSystem = nativeDesignSystem();
      doc.designSystem.variables["palette-light-accent"].values.base =
        "#2563eb";
      n.variableBindings = { fill: "color-accent" };
    }
    const updated = apply(doc, outlineStrokeOperations(doc, n.id).operations);
    const out = updated.nodes.find((v) => v.id === n.id)!;
    assert.equal(out.vector!.fillFromStyle, true);
    assert.equal(out.vector!.paths[0].fillColor, undefined);
    assert.equal(out.style.fill, "#2563eb");
    assert.ok(vectorFillMask(out.vector!)?.maskImage);
    const fill = symbolicNodeCss(updated, out, nodeCss(out, updated))[
      "--forma-vector-fill"
    ];
    assert.ok(String(fill).includes("var(--"));
    if (legacy) {
      assert.equal(out.fillToken, "blue");
      const edit = apply(updated, [
        {
          type: "putToken",
          id: "blue",
          token: { name: "Blue", value: "#112233" },
        },
      ]);
      assert.equal(edit.tokens[out.fillToken!].value, "#112233");
    } else {
      assert.equal(out.variableBindings?.fill, "color-accent");
      const dark = apply(updated, [
        {
          type: "update",
          id: out.id,
          patch: { variableModes: { semantic: "dark" } },
        },
      ]);
      assert.notEqual(
        resolveNode(
          dark,
          dark.nodes.find((s) => s.id === out.id)!,
        ).style.fill,
        "#2563eb",
      );
    }
  }
});

test("stroke-only color and opacity bindings paint currentColor and follow subsequent mode changes", () => {
  const n = createNode("ellipse"),
    { doc } = scene(n);
  const system = (doc.designSystem = nativeDesignSystem());
  system.variables.alpha = {
    ...system.variables["space-md"],
    id: "alpha",
    name: "Ink alpha",
    collectionId: "semantic",
    values: { light: 0.45, dark: 0.9 },
  };
  n.variableBindings = {
    stroke: "color-accent",
    strokeOpacity: "alpha",
    padding: "space-md",
  };
  doc.colorProfile = "display-p3";
  Object.assign(n.style, {
    fillOpacity: 0,
    strokeWidth: 4,
    opacity: 0.55,
    blendMode: "multiply",
    rotation: 28,
    flipX: true,
    flipY: true,
    shadows: [
      {
        x: 2,
        y: 1,
        blur: 4,
        spread: 0,
        color: "#445566",
        opacity: 0.4,
        inset: false,
      },
    ],
  });
  const updated = apply(doc, outlineStrokeOperations(doc, n.id).operations);
  const out = updated.nodes.find((l) => l.id === n.id)!;
  assert.equal(out.vector!.paths.length, 1);
  assert.equal(out.vector!.paths[0].fillColor, undefined);
  assert.equal(out.vector!.paths[0].fillOpacity, 1);
  assert.equal(vectorPathProps(out.vector!.paths[0]).fill, "currentColor");
  assert.match(
    String(symbolicNodeCss(updated, out, nodeCss(out, updated)).color),
    /color-mix.*var\(/,
  );
  assert.deepEqual(out.variableBindings, {
    color: "color-accent",
    colorOpacity: "alpha",
    padding: "space-md",
  });
  for (const mode of ["light", "dark"]) {
    const edit = apply(updated, [
      {
        type: "update",
        id: out.id,
        patch: { variableModes: { semantic: mode } },
      },
    ]);
    const original = resolveNode(doc, {
      ...n,
      variableModes: { semantic: mode },
    }).style;
    const result = resolveNode(
      edit,
      edit.nodes.find((l) => l.id === out.id)!,
    ).style;
    assert.equal(result.color, original.stroke);
    assert.equal(result.colorOpacity, original.strokeOpacity);
  }
  assert.equal(updated.colorProfile, doc.colorProfile);
  for (const key of [
    "opacity",
    "blendMode",
    "rotation",
    "flipX",
    "flipY",
    "shadows",
  ] as const)
    assert.deepEqual(out.style[key], n.style[key]);
});

test("unrepresentable primitive paints are consistently disabled and leave their layer untouched", () => {
  const paint = { id: "first", color: "#884422", opacity: 0.5, visible: true };
  const gradient = {
    type: "linear" as const,
    angle: 0,
    stops: [
      { offset: 0, color: "#000000", opacity: 1 },
      { offset: 1, color: "#ffffff", opacity: 1 },
    ],
  };
  for (const type of ["rectangle", "ellipse"] as const)
    for (const kind of [
      "image",
      "gradient",
      "paints",
      "strokePaints",
      "bindings",
      "scope",
    ] as const) {
      const n = createNode(type),
        { doc } = scene(n);
      n.style.strokeWidth = 3;
      if (kind === "image")
        n.image = {
          assetId: "img-" + "0".repeat(64),
          fit: "cover",
          x: 0,
          y: 0,
          zoom: 1,
        };
      else if (kind === "gradient") n.style.gradient = gradient;
      else if (kind === "bindings" || kind === "scope") {
        doc.designSystem = nativeDesignSystem();
        n.variableBindings =
          kind === "bindings"
            ? { fill: "color-surface", stroke: "color-accent" }
            : { stroke: "color-accent" };
        if (kind === "scope")
          doc.designSystem.variables["color-accent"].scopes = ["stroke"];
      } else n.style[kind] = [paint, { ...paint, id: "second" }];
      const before = JSON.stringify(doc);
      assert.equal(canOutlineStroke(doc, n.id), false);
      assert.throws(
        () => outlineStrokeOperations(doc, n.id),
        kind === "bindings" || kind === "scope"
          ? /绑定/
          : /图片、渐变或多重叠加/,
      );
      assert.equal(JSON.stringify(doc), before);
    }
});

test("transparent or hidden stroke paths never acquire visible ink during expansion", () => {
  const n = createNode("vector"),
    { doc } = scene(n);
  n.style.width = n.style.height = 100;
  const hidden = { d: "M10 50H90", fill: false, strokeWidth: 6 };
  for (const decoration of [
    { strokeOpacity: 0 },
    { strokeColor: "transparent" },
    { opacity: 0 },
  ]) {
    n.vector = {
      width: 100,
      height: 100,
      paths: [{ ...hidden, ...decoration }],
    };
    assert.equal(canOutlineStroke(doc, n.id), false);
    n.vector.paths.push({ ...hidden, d: "M10 20H90" });
    assert.equal(
      roundtrip(doc, outlineStrokeOperations(doc, n.id), n).paths.length,
      1,
    );
  }
  n.vector!.paths = [
    { d: "M10 10", fill: false, strokeWidth: 4, lineCap: "butt" },
  ];
  assert.equal(canOutlineStroke(doc, n.id), false);
  n.vector!.paths = [
    { d: "M10 10H50", fill: false, strokeWidth: 4, lineCap: "butt" },
  ];
  n.style.strokeDash = "0 8";
  assert.equal(canOutlineStroke(doc, n.id), false);
  delete n.style.strokeDash;
  n.style.strokeVisible = false;
  assert.equal(canOutlineStroke(doc, n.id), false);
  const r = createNode("rectangle"),
    { doc: d } = scene(r);
  Object.assign(r.style, {
    strokeWidth: 0,
    strokeSides: { top: 6 },
    strokeOpacity: 0,
  });
  assert.equal(canOutlineStroke(d, r.id), false);
  r.style.strokeOpacity = 1;
  assert.ok(canOutlineStroke(d, r.id));
  r.style.strokeVisible = false;
  assert.equal(canOutlineStroke(d, r.id), false);
});

test("unequal rounded sides with zero base width follow edge ownership", () => {
  const n = createNode("rectangle"),
    { doc } = scene(n);
  Object.assign(n.style, {
    width: 100,
    height: 40,
    radius: 8,
    strokeWidth: 0,
    strokeSides: { top: 6, left: 2 },
    fillOpacity: 0,
  });
  const out = roundtrip(doc, outlineStrokeOperations(doc, n.id), n);
  const ink = (x: number, y: number) =>
    contains(out.vector.paths[0].d, x - out.n.style.x, y - out.n.style.y);
  assert.ok(ink(50, 5) && ink(1, 20));
  assert.ok(!ink(50, 7) && !ink(3, 20) && !ink(99, 20) && !ink(50, 39));
  assert.ok(!ink(0.1, 0.1));
});

test("dashes, custom odd-length patterns and round dots have measurable gaps and correct caps", () => {
  const line = "M0 0H100",
    outline = (options: Parameters<typeof outlineStrokePath>[2]) =>
      outlineStrokePath(line, 4, options);
  const dashed = outline({ strokeStyle: "dashed", lineCap: "butt" }),
    dotted = outline({ strokeStyle: "dotted" });
  assert.ok(
    contains(dashed, 10, 0) &&
      !contains(dashed, 15, 0) &&
      contains(dashed, 22, 0),
  );
  assert.ok(
    contains(dotted, 8, 1.9) &&
      !contains(dotted, 4, 0) &&
      !contains(dotted, 9.8, 1.8),
  );
  const odd = outline({ strokeDash: "5,3,2", lineCap: "butt" });
  for (const [x, ink] of [
    [4, true],
    [6, false],
    [9, true],
    [12, false],
    [16, true],
    [19, false],
    [21, true],
  ] as const)
    assert.equal(contains(odd, x, 0), ink);
  for (const strokeStyle of ["dashed", "dotted"] as const) {
    const n = createNode("rectangle"),
      { doc } = scene(n);
    Object.assign(n.style, {
      width: 100,
      height: 40,
      radius: 0,
      strokeWidth: 4,
      strokeStyle,
      strokeAlign: "center",
      fillOpacity: 0,
    });
    const { n: out, vector } = roundtrip(
      doc,
      outlineStrokeOperations(doc, n.id),
      n,
    );
    const drawn = (x: number) =>
      contains(vector.paths[0].d, x - out.style.x, -out.style.y);
    if (strokeStyle === "dashed") assert.ok(drawn(7) && !drawn(16));
    else assert.ok(drawn(8) && !drawn(4));
  }
});

test("clipping uses the actual SVG viewport including letterbox space and overflowVisible", () => {
  const n = createNode("vector"),
    { doc } = scene(n);
  Object.assign(n.style, { width: 200, height: 100 });
  n.vector = {
    width: 100,
    height: 100,
    paths: [
      { d: "M-100 50H250", fill: false, strokeWidth: 4, lineCap: "butt" },
    ],
  };
  boxClose(roundtrip(doc, outlineStrokeOperations(doc, n.id), n).n.style, {
    x: 0,
    y: 48,
    width: 200,
    height: 4,
  });
  n.vector.overflowVisible = true;
  boxClose(roundtrip(doc, outlineStrokeOperations(doc, n.id), n).n.style, {
    x: -50,
    y: 48,
    width: 350,
    height: 4,
  });
  n.style.clipContent = true;
  boxClose(roundtrip(doc, outlineStrokeOperations(doc, n.id), n).n.style, {
    x: 0,
    y: 48,
    width: 200,
    height: 4,
  });
  n.vector.paths[0].d = "M-200 50H-160";
  assert.equal(canOutlineStroke(doc, n.id), false);
});

for (const group of [1, 0.5]) {
  test(`fill and stroke retain their SVG premultiplied overlap at path opacity ${group}`, () => {
    const n = createNode("vector"),
      { doc } = scene(n);
    Object.assign(n.style, { width: 100, height: 100, opacity: 0.7 });
    n.vector = {
      width: 100,
      height: 100,
      paths: [
        {
          d: "M20 20H80V80H20Z",
          fill: true,
          fillColor: "#ff0000",
          fillOpacity: 0.5,
          strokeWidth: 10,
          strokeOpacity: 0.4,
          strokeColor: "#0000ff",
          opacity: group,
          lineJoin: "miter",
        },
      ],
    };
    const { n: out, vector } = roundtrip(
      doc,
      outlineStrokeOperations(doc, n.id),
      n,
    );
    for (const [x, y, fill, stroke] of [
      [50, 50, 0.5, 0],
      [50, 17, 0, 0.4],
      [50, 22, 0.5, 0.4],
    ]) {
      let red = 0,
        blue = 0;
      for (const p of vector.paths)
        if (contains(p.d, x - out.style.x, y - out.style.y)) {
          const a = (p.fillOpacity ?? 1) * (p.opacity ?? 1);
          red = red * (1 - a) + (p.fillColor === "#ff0000" ? a : 0);
          blue = blue * (1 - a) + (p.fillColor === "#0000ff" ? a : 0);
        }
      close(red * out.style.opacity!, 0.7 * group * fill * (1 - stroke));
      close(blue * out.style.opacity!, 0.7 * group * stroke);
    }
  });
}

test("rich runs, decorations, wrapped ellipsis and mixed directions fail before shaping or issuing a transaction", async () => {
  for (const variation of [
    "rich",
    "font",
    "underline",
    "strike",
    "ellipsis",
    "bidi",
    "control",
  ]) {
    const { n, doc } = await embeddedText();
    n.text = "AB AB AB AB";
    n.style.width = 13;
    if (variation === "rich" || variation === "font")
      n.textRuns = [
        {
          start: 0,
          end: 1,
          style:
            variation === "rich"
              ? { color: "#ff0000", fontWeight: 800, fontSize: 18 }
              : { fontFamily: "Missing" },
        },
      ];
    if (variation === "underline" || variation === "strike")
      n.style.textDecoration =
        variation === "strike" ? "line-through" : "underline";
    if (variation === "ellipsis") n.style.maxLines = 1;
    if (variation === "bidi") n.text = "עברית AB";
    if (variation === "control") n.text = "A\u2067B\u2069";
    n.sourceTextShape = {
      text: n.text,
      styleKey: textShapeStyleKey(n.style),
      width: n.style.width,
      height: n.style.height,
      d: "M0 0H10V10Z",
    };
    const before = JSON.stringify(doc);
    assert.equal(canOutlineText(doc, n.id), false);
    assert.equal(outlineTextFromShapeOperations(doc, n.id), null);
    await assert.rejects(outlineTextNode(doc, n.id), /暂不支持/);
    assert.equal(JSON.stringify(doc), before);
  }
});

test("deleting elsewhere retains a one-anchor cubic loop, whose single segment can be hit and bent", () => {
  const paths = [path("M0 0C60 -50 60 50 0 0Z M100 0H120")];
  const loop = paths[0].contours[0],
    before = structuredClone(loop);
  assert.equal(removeNetworkAnchors(paths, [at(0, 1)]), true);
  assert.deepEqual(paths[0].contours, [before]);
  const a = loop.anchors[0],
    p = evalSegmentPoint(a, a, 0.37);
  const hit = nearestSegmentPoint(paths, p, 0.0001)!;
  assert.equal(hit.index, 0);
  close(hit.t, 0.37);
  const target = { x: p.x + 4, y: p.y - 6 };
  assert.ok(bendSegment(paths, hit, target));
  pointClose(evalSegmentPoint(a, a, hit.t), target);
  pointClose(a, { x: 0, y: 0 });
});

test("deleting down to two anchors preserves a curved closing segment and permits a surviving one-anchor loop", () => {
  const paths = [path("M0 0H30L30 30C0 50 -20 30 0 0Z")];
  assert.ok(removeNetworkAnchors(paths, [at(1)]));
  assert.ok(paths[0].contours[0].closed);
  const [first, last] = paths[0].contours[0].anchors;
  assert.equal(
    nearestSegmentPoint(paths, evalSegmentPoint(last, first, 0.5), 0.001)
      ?.index,
    1,
  );
  assert.ok(removeNetworkAnchors(paths, [at(1)]));
  assert.ok(paths[0].contours[0].closed);
  assert.equal(paths[0].contours[0].anchors.length, 1);
  const curvedForward = [path("M0 0C5 -10 20 -10 30 0V20Z")];
  assert.ok(removeNetworkAnchors(curvedForward, [at(2)]));
  assert.ok(curvedForward[0].contours[0].closed);
});

for (const t of [0.02, 0.98])
  test(`Bend drag at t=${t} adds only the actual three pixel displacement`, () => {
    const paths = [path("M0 0H1000")],
      [a, b] = paths[0].contours[0].anchors;
    const hit = nearestSegmentPoint(paths, { x: 1000 * t, y: 0 }, 1)!;
    assert.ok(bendSegment(paths, hit, { x: hit.point.x, y: 3 }));
    close(a.outgoing!.x, 1000 / 3);
    close(b.incoming!.x, 2000 / 3);
    pointClose(evalSegmentPoint(a, b, t < 0.5 ? 0.15 : 0.85), {
      x: t < 0.5 ? 150 : 850,
      y: 3,
    });
  });

for (const [direction, axis, size] of [
  ["horizontal", "x", "width"],
  ["vertical", "y", "height"],
] as const) {
  test(`${direction} distribution pins the ordered endpoints for both negative and positive gaps`, () => {
    for (const overlap of [true, false]) {
      const nodes = [
        createNode("rectangle"),
        createNode("ellipse"),
        createNode("rectangle"),
      ];
      const doc = { ...createStarter(), nodes };
      const starts = overlap ? [0, 40, 80] : [0, 30, 100],
        sizes = overlap ? [200, 10, 10] : [20, 20, 20];
      nodes.forEach((n, i) => {
        n.style[axis] = starts[i];
        n.style[size] = sizes[i];
      });
      const updated = apply(
        doc,
        alignOperations(
          doc,
          [...nodes].reverse().map((n) => n.id),
          direction,
        ),
      );
      assert.deepEqual(
        updated.nodes.map((n) => n.style[axis]),
        [starts[0], overlap ? 135 : 50, starts[2]],
      );
    }
  });
}

for (const flip of [false, true])
  test(`rebasing a rotated group preserves unselected world bounds with flip=${flip}`, () => {
    const parent = createNode("frame"),
      g = createNode("group", parent.id),
      a = createNode("rectangle", g.id),
      b = createNode("rectangle", g.id);
    Object.assign(parent.style, { x: 210, y: -70, rotation: 18 });
    Object.assign(g.style, {
      x: 80,
      y: 42,
      width: 140,
      height: 30,
      rotation: 90,
      flipX: flip,
    });
    Object.assign(a.style, { x: 0, y: 0, width: 60, height: 30 });
    Object.assign(b.style, { x: 120, y: 0, width: 20, height: 30 });
    const doc = { ...createStarter(), nodes: [parent, g, a, b] };
    const world = (d: DesignDocument, id: string) => {
      const boxes = layoutBounds(d);
      return visualBounds(boxes.get(id)!, sceneTransforms(d, boxes).get(id)!);
    };
    const updated = apply(doc, alignOperations(doc, [b.id], "left"));
    boxClose(world(updated, a.id), world(doc, a.id), 1e-10);
    assert.equal(updated.nodes[1].style.width, 60);
    assert.equal(updated.nodes[3].style.x, 0);
  });

test("wrapped Fill siblings retain their flex bases and footprint after a parent resize", () => {
  const n = createNode("rectangle"),
    { doc, frame, before, after } = scene(n);
  Object.assign(frame.style, {
    layout: "row",
    wrap: true,
    width: 640,
    padding: 0,
    gap: 10,
  });
  Object.assign(n.style, {
    width: 40,
    widthMode: "fill",
    strokeWidth: 4,
    strokeAlign: "outside",
  });
  Object.assign(before.style, { width: 60, widthMode: "fill" });
  after.style.width = 75;
  const old = layoutBounds(doc);
  const out = apply(doc, outlineStrokeOperations(doc, n.id).operations);
  assert.equal(out.nodes[2].vector!.width, old.get(n.id)!.width);
  for (const width of [640, 500, 130]) {
    const resize: Operation[] = [
      { type: "update", id: frame.id, patch: {}, style: { width } },
    ];
    const original = layoutBounds(apply(doc, resize)),
      converted = layoutBounds(apply(out, resize));
    for (const layer of doc.nodes)
      boxClose(converted.get(layer.id)!, original.get(layer.id)!);
  }
});

test("a dotted open end includes its final round cap and a short closed contour paints one dot", () => {
  const options = { strokeDash: "0 8", lineCap: "round" } as const;
  assert.ok(contains(outlineStrokePath("M0 0H16", 2, options), 16.7, 0));
  const tiny = outlineStrokePath("M0 0H2V1H0Z", 1, options);
  assert.ok(contains(tiny, 0.3, 0));
  assert.equal(contains(tiny, 2, 0), false);
});

test("tight outlines of constrained children stay in place inside a responsively resized free frame", () => {
  for (const constraintX of ["center", "end", "stretch", "scale"] as const) {
    const outer = createNode("frame"),
      parent = createNode("frame", outer.id),
      child = createNode("rectangle", parent.id);
    Object.assign(outer.style, {
      width: 500,
      layout: "row",
      padding: 0,
      rotation: -21,
    });
    Object.assign(parent.style, {
      width: 150,
      widthMode: "fill",
      rotation: 31,
      flipX: true,
    });
    Object.assign(child.style, {
      x: 15,
      y: 25,
      width: 48,
      height: 35,
      strokeWidth: 4,
      strokeAlign: "outside",
      rotation: 17,
      constraintX,
    });
    const doc = { ...createStarter(), nodes: [outer, parent, child] };
    const old = layoutBounds(doc),
      original = old.get(child.id)!;
    const updated = apply(
      doc,
      outlineStrokeOperations(doc, child.id).operations,
    );
    const boxes = layoutBounds(updated),
      out = boxes.get(child.id)!;
    close(out.width, original.width + 8);
    close(out.height, original.height + 8);
    pointClose(
      transform(sceneTransforms(updated, boxes).get(child.id)!, {
        x: out.x + 4,
        y: out.y + 4,
      }),
      transform(sceneTransforms(doc, old).get(child.id)!, original),
    );
  }
});

test("an alpha-bearing fill and path opacity retain their separate contributions under an opaque stroke", () => {
  const n = createNode("vector"),
    { doc } = scene(n);
  n.vector = {
    width: 160,
    height: 80,
    paths: [
      {
        d: "M20 20H80V60H20Z",
        fill: true,
        fillColor: "#ff000080",
        fillOpacity: 0.5,
        opacity: 0.5,
        strokeWidth: 4,
        strokeColor: "#0000ff",
      },
    ],
  };
  const { n: out, vector } = roundtrip(
    doc,
    outlineStrokeOperations(doc, n.id),
    n,
  );
  const fill = vector.paths.find((p) => p.fillColor === "#ff0000")!;
  close(fill.fillOpacity!, (0.5 * 128) / 255);
  assert.equal(fill.opacity, 0.5);
  assert.ok(contains(fill.d, 40 - out.style.x, 40 - out.style.y));
  assert.equal(contains(fill.d, 40 - out.style.x, 21 - out.style.y), false);
});

test("an invisible bound base fill does not prevent a sole visible stroke from keeping its token", () => {
  const n = createNode("rectangle"),
    { doc } = scene(n);
  doc.designSystem = nativeDesignSystem();
  n.variableBindings = { fill: "color-surface", stroke: "color-accent" };
  Object.assign(n.style, { strokeWidth: 3, fillOpacity: 0 });
  const { n: out, vector } = roundtrip(
    doc,
    outlineStrokeOperations(doc, n.id),
    n,
  );
  assert.equal(out.variableBindings?.color, "color-accent");
  assert.equal(out.variableBindings?.fill, "color-surface");
  assert.equal(vector.paths.length, 1);
  assert.equal(vectorPathProps(vector.paths[0]).fill, "currentColor");
});

test("outlining a wrapped row Fill-height child keeps its 10px basis when the row narrows to 120px", () => {
  const n = createNode("rectangle");
  const { doc, frame, before, after } = scene(n);
  Object.assign(frame.style, {
    x: 0,
    y: 0,
    layout: "row",
    width: 330,
    wrap: true,
    gap: 0,
    padding: 0,
  });
  [before, n, after].forEach((child, i) =>
    Object.assign(child.style, { width: 100, height: [100, 10, 20][i] }),
  );
  Object.assign(n.style, { heightMode: "fill", strokeWidth: 2 });
  assert.equal(layoutBounds(doc).get(n.id)!.height, 100);
  const out = apply(doc, outlineStrokeOperations(doc, n.id).operations);
  assert.equal(out.nodes[2].style.height, 10);
  assert.equal(out.nodes[2].vector!.height, 100);
  for (const d of [doc, out]) {
    const narrow = apply(d, [
      { type: "update", id: frame.id, patch: {}, style: { width: 120 } },
    ]);
    assert.equal(layoutBounds(narrow).get(after.id)!.y, 110);
  }
});

test("a canvas-only Sketch base fill cannot become exported SVG ink after Outline Stroke", () => {
  const n = createNode("rectangle");
  const { doc } = scene(n);
  Object.assign(n.style, {
    sketchCanvasPaints: ["base"],
    fill: "#ff0000",
    stroke: "#0000ff",
    strokeWidth: 4,
  });
  const exported = exportReact(doc);
  assert.equal(nodeCss(n, doc, "canvas").background, "#ff0000");
  assert.equal(nodeCss(n, doc, "export").background, "rgba(255, 0, 0, 0)");
  assert.ok(exported.includes('"background":"rgba(255, 0, 0, 0)"'));
  assert.equal(canOutlineStroke(doc, n.id), false);
  assert.throws(
    () => outlineStrokeOperations(doc, n.id),
    /暂不支持对含画布专属样式的导入图层直接轮廓化/,
  );
  assert.equal(n.type, "rectangle");
  assert.equal(exportReact(doc), exported);
  for (const appearance of [
    { tint: { color: "#ffffff", opacity: 1 } },
    { figmaGlass: { visible: true, radius: 10 } },
    { blendMode: "plus-darker" },
  ] as const) {
    const copy = structuredClone(doc);
    delete copy.nodes[2].style.sketchCanvasPaints;
    Object.assign(copy.nodes[2].style, appearance);
    assert.equal(canOutlineStroke(copy, n.id), false);
    assert.throws(() => outlineStrokeOperations(copy, n.id), /画布专属样式/);
  }
});

test("SVG percentage dashes use the normalized viewport diagonal and invalid dash syntax rejects atomically", () => {
  const n = createNode("vector");
  const { doc } = scene(n);
  Object.assign(n.style, { width: 100, height: 40, strokeDash: "10% 10%" });
  n.vector = {
    width: 100,
    height: 40,
    paths: [{ d: "M10 20H90", fill: false, strokeWidth: 4, lineCap: "butt" }],
  };
  assert.ok(canOutlineStroke(doc, n.id));
  const { n: out, vector } = roundtrip(
    doc,
    outlineStrokeOperations(doc, n.id),
    n,
  );
  const ink = (x: number) =>
    contains(vector.paths[0].d, x - out.style.x, 20 - out.style.y);
  const dash = Math.hypot(100, 40) / Math.SQRT2 / 10;
  assert.ok(ink(10 + dash - 0.02));
  assert.ok(!ink(10 + dash + 0.02));
  assert.ok(!ink(21));
  assert.ok(ink(10 + 2 * dash + 0.02));
  const ascii = structuredClone(doc);
  ascii.nodes[2].style.strokeDash = " \t4\r\n,\f4\t ";
  assert.ok(canOutlineStroke(ascii, n.id));
  assert.ok(outlineStrokeOperations(ascii, n.id).operations.length);
  for (const strokeDash of [
    "10em 3",
    "2rem",
    "calc(5% + 1px)",
    "2 abc",
    "2,,3",
    "-1 1",
    "1e999",
    "1.px 2.px",
    "1. 2.",
    ".px",
    "8\u00a08",
    "\u00a04 4",
    "4\u20034",
    "4 4\u00a0",
  ]) {
    const copy = structuredClone(doc);
    copy.nodes[2].style.strokeDash = strokeDash;
    const before = JSON.stringify(copy);
    assert.equal(canOutlineStroke(copy, n.id), false, strokeDash);
    assert.throws(() => outlineStrokeOperations(copy, n.id), /虚线间隔/);
    assert.equal(JSON.stringify(copy), before);
  }
});

test("Mandaic, Samaritan, presentation forms, astral RTL and bidi controls reject before either glyph source", async () => {
  const { n, doc } = await embeddedText();
  for (const text of [
    "A\u0840\u0841",
    "A\u0800",
    "A\ufb1d",
    "A\u0860",
    "A\u{10900}",
    "A\u{1e900}",
    "A\u{1ee00}",
    "\u0840\u2801", // Braille symbol, Bidi_Class L
    "\u0800\u0964", // Devanagari danda, Bidi_Class L
    "A\u2067",
    "A\u200e",
    "A\u061c",
  ]) {
    n.text = text;
    for (const saved of [true, false]) {
      n.sourceTextShape = saved
        ? {
            text,
            styleKey: textShapeStyleKey(n.style),
            width: n.style.width,
            height: n.style.height,
            d: "M0 0H5V5Z",
          }
        : undefined;
      const before = JSON.stringify(doc);
      assert.equal(canOutlineText(doc, n.id), false, text);
      assert.equal(outlineTextFromShapeOperations(doc, n.id), null);
      await assert.rejects(outlineTextNode(doc, n.id), /双向混排/);
      assert.equal(JSON.stringify(doc), before);
    }
  }
  for (const supported of ["A\n\u0840\u0841", "A،B", "A\ufeffB"]) {
    n.text = supported;
    assert.equal(canOutlineText(doc, n.id), true);
  }
});

test("20 inspector availability checks on a 990-unit round-cap 1 1 dashed line take under 5ms including the cold lookup", (t) => {
  const n = createNode("vector");
  const { doc } = scene(n);
  Object.assign(n.style, { width: 1000, height: 40, strokeDash: "1 1" });
  n.vector = {
    width: 1000,
    height: 40,
    paths: [{ d: "M5 20H995", fill: false, strokeWidth: 4, lineCap: "round" }],
  };
  indexPublishedScene(doc);
  const path = n.vector.paths[0],
    data = path.d;
  let reads = 0;
  Object.defineProperty(path, "d", {
    get() {
      reads++;
      return data;
    },
  });
  const expand = t.mock.method(api.Path.prototype, "outline", () => {
    throw Error("Inspector called Paper.js");
  });
  const flatten = t.mock.method(api.Path.prototype, "flatten", () => {
    throw Error("Inspector flattened a path");
  });
  const start = performance.now();
  for (let i = 0; i < 20; i++) assert.ok(canOutlineStroke(doc, n.id));
  const ms = performance.now() - start;
  assert.ok(ms < 5, `20 calls took ${ms} ms`);
  assert.equal(reads, 1, "cached Inspector reads must not revisit path data");
  assert.equal(expand.mock.callCount(), 0);
  assert.equal(flatten.mock.callCount(), 0);
  t.diagnostic(`20 availability checks: ${ms.toFixed(3)} ms`);
});

test("stroke preflight streams SVG segments, including implicit commands, reflected controls and compact arc flags", () => {
  const n = createNode("vector"),
    { doc } = scene(n);
  n.style.width = n.style.height = 10;
  const path = { d: "", fill: false, strokeWidth: 1, lineCap: "butt" as const };
  n.vector = { width: 10, height: 10, paths: [path] };
  for (const [d, expected] of [
    ["m20 5 -15 0", true],
    ["M20 5l-18 0", true],
    ["M+2.E1\t+5.L.5e+1,-.25e1", true],
    ["M20\r\n5L+20.5.25", false],
    ["M20 5L.,5", false],
    ["M20 5A10 10 0 2 1 5 5", false],
    ["M20 5h-18", true],
    ["M5 20v-18", true],
    ["M20 5c-40 0 -40 0 0 0", true],
    ["M20 5C20 5 60 5 20 5s0 0 0 0", true],
    ["M20 5q-40 0 0 0", true],
    ["M20 5Q60 5 20 5t0 0", true],
    ["M-5 15a10 10 0 0110-10", true],
    ["M15 -5A10 10 0 0 1 15 15", false],
    ["M15 -5A10 10 0 0 0 15 15", true],
    ["M-5 -5H15V15z", true],
    ["M5 100a1 1 0 010-1a1 1 0 010-1e2", true],
    ["M5 164" + "a1 1 0 010-1".repeat(64) + "e2", true],
    ["M5 164" + "a1 1 0 010-1".repeat(64) + "00", true],
    [
      "M200 5" + "a 1 1 0 0 1 .01 0".repeat(40) + "a,1 1 0 0 1 .01 0L5 5",
      false,
    ],
    ["M5 100a1 1 0 010-1 1 1 0 010-1 1 1 0 010-99", true],
    ["M20 5h5z m-15 0v2", true],
    ["M20 0V20 M-20 0V20", false],
    ["M5 5z", false],
    ["M5 5L5 5", false],
  ] as const) {
    path.d = d;
    assert.equal(canOutlineStroke(doc, n.id), expected, d);
  }
  n.vector.paths[0] = { ...path, lineCap: "round" };
  assert.ok(
    canOutlineStroke(doc, n.id),
    "a zero-length open segment paints a round cap",
  );
});

test("large circular arcs and radius-corrected ellipses retain visible stroke beyond the endpoint radii", () => {
  const n = createNode("vector"),
    { doc } = scene(n);
  n.style.width = n.style.height = 10;
  const p = { d: "", fill: false, strokeWidth: 1, lineCap: "butt" as const };
  n.vector = { width: 10, height: 10, paths: [p] };
  for (const d of [
    "M24 4A10 10 0 1 0 24 6",
    "M200 0A50 1 0 0 0 200 10",
    "M200 0A1 50 90 0 0 200 10",
  ]) {
    p.d = d;
    assert.ok(canOutlineStroke(doc, n.id), d);
    assert.ok(outlineStrokeOperations(doc, n.id).operations.length, d);
  }
  p.d = "M24 4A10 10 0 0 0 24 6";
  assert.equal(canOutlineStroke(doc, n.id), false);
});

test("cached path bounds preserve pen-up gaps and cap visibility across viewport and cap changes", () => {
  const n = createNode("vector"),
    { doc } = scene(n);
  n.style.width = n.style.height = 10;
  const p: NonNullable<DesignNode["vector"]>["paths"][number] = {
    d: "M22 1v6 M-12 1v6 M5 5l0 0",
    fill: false,
    strokeWidth: 1,
    lineCap: "butt",
  };
  n.vector = { width: 10, height: 10, paths: [p] };
  assert.equal(canOutlineStroke(doc, n.id), false);
  n.style.width = 12;
  assert.equal(canOutlineStroke(doc, n.id), false);
  p.lineCap = "round";
  assert.equal(canOutlineStroke(doc, n.id), true);
  p.lineCap = "butt";
  n.style.width = 40;
  assert.equal(canOutlineStroke(doc, n.id), true);
});

test("11 large stroked paths short-circuit on the first segment in three cold document revisions", (t) => {
  const n = createNode("vector"),
    { doc } = scene(n);
  Object.assign(n.style, { width: 100, height: 100 });
  const curve =
    "c.0100000000001 .0100000000001 .0200000000002 .0200000000002 .0300000000003 .0300000000003";
  n.vector = {
    width: 100,
    height: 100,
    paths: Array.from({ length: 11 }, (_, i) => ({
      d: `M1 ${i + 1}` + curve.repeat(1000),
      fill: false,
      strokeWidth: 1,
    })),
  };
  const revisions = Array.from({ length: 3 }, (_, i) => {
    const d = parseDocument({
      ...doc,
      name: `Revision ${i}`,
      revision: doc.revision + i,
    });
    indexPublishedScene(d);
    return d;
  });
  const times: number[] = [],
    warm: number[] = [];
  for (const d of revisions) {
    const start = performance.now();
    const available = canOutlineStroke(d, n.id);
    times.push(performance.now() - start);
    assert.ok(available);
    const again = performance.now();
    assert.ok(canOutlineStroke(d, n.id));
    warm.push(performance.now() - again);
  }
  const total = times.reduce((a, b) => a + b, 0);
  t.diagnostic(
    `First-segment times (ms): ${times.map((ms) => ms.toFixed(3)).join(", ")}; total ${total.toFixed(3)}; warm max ${Math.max(...warm).toFixed(3)}`,
  );
  assert.ok(total < 15, `three revisions took ${total} ms`);
  assert.ok(Math.max(...warm) < 1, `warm hits took ${warm} ms`);
  assert.ok(
    times.every((ms) => ms < 1),
    `first-segment hits took ${times} ms`,
  );
});

test("fully scanned offscreen paths reuse availability across revisions and recheck a changed viewport", (t) => {
  const n = createNode("vector"),
    { doc } = scene(n);
  n.style.width = n.style.height = 100;
  n.vector = {
    width: 100,
    height: 100,
    paths: Array.from({ length: 11 }, (_, i) => ({
      d: `M200 ${i + 1}` + "h.01".repeat(1000),
      fill: false,
      strokeWidth: 1,
    })),
  };
  assert.equal(canOutlineStroke(doc, n.id), false);
  const revision = structuredClone(doc);
  revision.revision++;
  const start = performance.now();
  assert.equal(canOutlineStroke(revision, n.id), false);
  const ms = performance.now() - start;
  assert.ok(ms < 5, `cached offscreen paths took ${ms} ms`);
  t.diagnostic(`11 cached offscreen paths: ${ms.toFixed(3)} ms`);
  revision.nodes[2].style.width = 400;
  assert.equal(canOutlineStroke(revision, n.id), true);
});

for (const [separators, pair] of [
  ["spaces", "a1 1 0 0 1 .01 0a1 1 0 0 1 .01 0"],
  ["alternating spaces and commas", "a1 1 0 0 1 .01 0a1,1,0,0,1,.01,0"],
] as const)
  test(`ten thousand offscreen arcs with ${separators} reuse path bounds across three viewport widths`, (t) => {
    const n = createNode("vector");
    const { doc } = scene(n);
    n.style.width = n.style.height = 100;
    const offscreen = Array.from({ length: 10 }, (_, i) => ({
      d: `M200 ${10 + i}` + pair.repeat(500),
      fill: false,
      strokeWidth: 1,
    }));
    n.vector = {
      width: 100,
      height: 100,
      paths: [...offscreen, { d: "M8 8h5", fill: false, strokeWidth: 1 }],
    };
    const times: number[] = [],
      warm: number[] = [];
    for (const width of [100, 101, 102]) {
      n.style.width = width;
      const revision = parseDocument({
        ...doc,
        revision: doc.revision + width - 100,
      });
      indexPublishedScene(revision);
      const start = performance.now();
      const hit = canOutlineStroke(revision, n.id);
      times.push(performance.now() - start);
      const again = performance.now();
      const cached = canOutlineStroke(revision, n.id);
      warm.push(performance.now() - again);
      assert.ok(hit && cached);
    }
    const total = times.reduce((sum, ms) => sum + ms, 0);
    t.diagnostic(
      `10,000 arcs with ${separators} at widths 100/101/102 (ms): ${times.map((ms) => ms.toFixed(6)).join(", ")}; warm ${warm.map((ms) => ms.toFixed(6)).join(", ")}`,
    );
    assert.ok(times[0] < 12, `cold arc scan took ${times[0]} ms`);
    assert.ok(total < 12, `three revisions took ${total} ms`);
    assert.ok(
      times.slice(1).every((ms) => ms < 1),
      `resized revisions took ${times.slice(1)} ms`,
    );
    assert.ok(Math.max(...warm) < 0.2, `warm hits took ${warm} ms`);
    n.vector.paths = offscreen;
    for (const width of [100, 101, 102, 400]) {
      n.style.width = width;
      assert.equal(canOutlineStroke(doc, n.id), width === 400);
    }
  });

for (const sizing of ["fixed", "minWidth", "maxWidth", "hug"] as const)
  test(`rotated ${sizing} child bounds keep free, absolute and in-flow groups tight after rebasing`, () => {
    for (const placement of ["free", "absolute", "in-flow"] as const)
      for (const rotation of [0, 90]) {
        const root = createNode("frame");
        const group = createNode("group", root.id);
        const first = createNode("rectangle", group.id),
          child = createNode(
            sizing === "hug" ? "frame" : "rectangle",
            group.id,
          );
        Object.assign(root.style, {
          layout: placement === "free" ? "free" : "row",
          width: 400,
          height: 300,
        });
        Object.assign(group.style, {
          x: 20,
          y: 30,
          width: 110,
          height: 20,
          rotation,
          absolutePosition: placement === "absolute",
        });
        Object.assign(first.style, { x: 0, y: 0, width: 20, height: 20 });
        Object.assign(child.style, {
          x: 70,
          y: 0,
          width: 40,
          height: 10,
          flipX: true,
        });
        const doc = { ...createStarter(), nodes: [root, group, first, child] };
        if (sizing === "minWidth")
          Object.assign(child.style, { width: 20, minWidth: 40 });
        if (sizing === "maxWidth")
          Object.assign(child.style, {
            width: 80,
            maxWidth: 40,
            height: 30,
            maxHeight: 10,
          });
        if (sizing === "hug") {
          Object.assign(child.style, {
            layout: "row",
            width: 20,
            height: 30,
            widthMode: "hug",
            heightMode: "hug",
            padding: 0,
          });
          const inner = createNode("group", child.id);
          Object.assign(inner.style, { width: 80, height: 30 });
          const content = createNode("rectangle", inner.id);
          Object.assign(content.style, {
            x: 0,
            y: 0,
            width: 40,
            height: 5,
            minHeight: 10,
          });
          doc.nodes.push(inner, content);
        }
        const next = apply(doc, [
          { type: "update", id: child.id, patch: {}, style: { rotation: 90 } },
        ]);
        const boxes = layoutBounds(next),
          transforms = sceneTransforms(next, boxes);
        const world = (id: string) =>
          visualBounds(boxes.get(id)!, transforms.get(id)!);
        const rebased = next.nodes[1].style;
        close(rebased.width, 95, 1e-4);
        close(rebased.height, 40, 1e-4);
        boxClose(
          world(group.id),
          union([world(first.id), world(child.id)])!,
          1e-4,
        );
        if (placement === "in-flow") pointClose(rebased, group.style);
        else {
          const before = layoutBounds(doc);
          boxClose(
            world(first.id),
            visualBounds(
              before.get(first.id)!,
              sceneTransforms(doc, before).get(first.id)!,
            ),
            1e-4,
          );
        }
        const renamed = apply(next, [
          { type: "update", id: child.id, patch: { name: "Renamed" } },
        ]);
        assert.deepEqual(
          renamed.nodes.map((n) => n.style),
          next.nodes.map((n) => n.style),
        );
      }
  });

test("bending the diagonal at 2% applies only the off-center pointer displacement", () => {
  const paths = [path("M0 0L800 600")];
  // This press is 5 units off the centerline, along its perpendicular.
  const press = { x: 13, y: 16 },
    hit = nearestSegmentPoint(paths, press, 6)!;
  pointClose(hit.point, { x: 16, y: 12 });
  close(hit.t, 0.02);
  const release = { x: 13, y: 24 };
  const target = {
    x: hit.point.x + release.x - press.x,
    y: hit.point.y + release.y - press.y,
  };
  assert.ok(bendSegment(paths, hit, target));
  const [a, b] = paths[0].contours[0].anchors;
  close(a.outgoing!.x, 800 / 3);
  close(b.incoming!.x, 1600 / 3);
  pointClose(evalSegmentPoint(a, b, 0.15), { x: 120, y: 98 });
});

for (const placement of ["free", "absolute", "in-flow"] as const)
  test(`rebasing a ${placement} group keeps its local and visual selection tight`, () => {
    for (const rotation of [0, 90])
      for (const flipX of [false, true]) {
        const root = createNode("frame"),
          g = createNode("group", root.id);
        const a = createNode("rectangle", g.id),
          b = createNode("rectangle", g.id);
        Object.assign(root.style, {
          x: -20,
          y: 20,
          width: 330,
          height: 80,
          layout: placement === "free" ? "free" : "row",
          padding: 0,
          gap: 0,
          alignX: "center",
        });
        Object.assign(g.style, {
          x: 18,
          y: 12,
          width: 60,
          height: 20,
          rotation,
          flipX,
          absolutePosition: placement === "absolute",
        });
        Object.assign(a.style, { x: 0, y: 0, width: 20, height: 20 });
        Object.assign(b.style, { x: 40, y: 0, width: 20, height: 20 });
        const doc = { ...createStarter(), nodes: [root, g, a, b] };
        const world = (d: DesignDocument, id: string) => {
          const boxes = layoutBounds(d),
            matrix = sceneTransforms(d, boxes).get(id)!;
          const rect = boxes.get(id)!;
          return {
            origin: transform(matrix, rect),
            bounds: visualBounds(rect, matrix),
          };
        };
        const old = world(doc, b.id);
        const updated = apply(doc, [
          { type: "update", id: a.id, patch: {}, style: { x: -30 } },
        ]);
        const [, group, first, second] = updated.nodes;
        const local = union([first.style, second.style])!;
        assert.deepEqual(local, { x: 0, y: 0, width: 90, height: 20 });
        assert.equal(group.style.width, local.width);
        assert.equal(group.style.height, local.height);
        const sibling = world(updated, b.id);
        boxClose(
          world(updated, g.id).bounds,
          union([world(updated, a.id).bounds, sibling.bounds])!,
        );
        if (placement === "in-flow") {
          assert.deepEqual(
            [group.style.x, group.style.y],
            [g.style.x, g.style.y],
          );
        } else {
          pointClose(sibling.origin, old.origin);
          boxClose(sibling.bounds, old.bounds);
        }
        const renamed = apply(updated, [
          { type: "update", id: b.id, patch: { name: "Renamed" } },
        ]);
        pointClose(world(renamed, b.id).origin, sibling.origin);
      }
  });

test("a conservative stroke preflight never converts fill-only ink when every dash is clipped", () => {
  const n = createNode("vector"),
    { doc } = scene(n);
  Object.assign(n.style, { width: 10, height: 10, strokeDash: "2 100" });
  n.vector = {
    width: 10,
    height: 10,
    paths: [
      { d: "M1 1H8V8H1Z", fill: true, strokeWidth: 0 },
      { d: "M-5 5H15", fill: false, strokeWidth: 1, lineCap: "butt" },
    ],
  };
  const before = JSON.stringify(doc);
  assert.throws(() => outlineStrokeOperations(doc, n.id), /可见描边/);
  assert.equal(JSON.stringify(doc), before);
});
