import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  canEditAutoLayoutHandles,
  canEditCornerRadius,
  checkHandleBindingScopes,
  computeCornerRadiusDrag,
  computeGapDrag,
  computePaddingDrag,
  getAutoLayoutHandleSpecs,
  getCornerHandleSpecs,
  getNodeCornerRadii,
  getNodeInsets,
  type CornerKey,
} from "../src/application/canvas-handles";
import { previewGeometry } from "../src/application/geometry-preview";
import { commit, travel } from "../src/application/history";
import { symbolicNodeCss } from "../src/compiler/design-tokens";
import { reactProjectFiles } from "../src/compiler/runtime";
import { nativeDesignSystem } from "../src/design-system/tokens";
import { resolveNode } from "../src/domain/design-system";
import {
  findLayer,
  indexPublishedScene,
  unchangedBranch,
} from "../src/domain/scene-index";
import { nodeCss, exportReact } from "../src/compiler/react";
import { transact, type Operation } from "../src/domain/commands";
import {
  createNode,
  parseDocument,
  type DesignDocument,
  type DesignNode,
} from "../src/domain/document";
import { layoutBounds } from "../src/domain/geometry";
import {
  createLibraryFromSelection,
  instantiateComponent,
} from "../src/domain/library";
import { createStarter } from "../src/domain/seed";
import { identity } from "../src/domain/transforms";
import { AutoLayoutHandles } from "../src/editor/AutoLayoutHandles";
import { CornerRadiusHandles } from "../src/editor/CornerRadiusHandles";
import { GridHandles } from "../src/editor/GridHandles";
import { useEditor, type EditorController } from "../src/editor/useEditor";

const scene = (...nodes: DesignNode[]): DesignDocument => ({
  ...createStarter(),
  nodes,
});
const box = { x: 80, y: 40, width: 160, height: 81 };
const asymmetric = { tl: 1, tr: 2, br: 3, bl: 4 };
function flow(layout: "row" | "column", count = 3) {
  const frame = createNode("frame");
  Object.assign(frame.style, {
    x: 121,
    y: 87,
    width: 150,
    height: 130,
    padding: 10,
    gap: 8,
    layout,
  });
  const children = Array.from({ length: count }, () => {
    const child = createNode("rectangle", frame.id);
    Object.assign(child.style, { width: 20, height: 16 });
    return child;
  });
  return { doc: scene(frame, ...children), frame, children };
}
function roundTrip(doc: DesignDocument, operations: Operation[]) {
  assert.equal(operations.length, 1);
  const preview = previewGeometry(doc, operations);
  const next = transact(doc, { baseRevision: doc.revision, operations });
  assert.deepEqual(preview.nodes, next.nodes);
  const history = commit({ present: doc, past: [], future: [] }, next);
  assert.equal(history.present.revision, doc.revision + 1);
  const undone = travel(history, "undo");
  assert.equal(undone.past.length, 0);
  assert.deepEqual(undone.present.nodes, doc.nodes);
  assert.deepEqual(travel(undone, "redo").present.nodes, next.nodes);
  return parseDocument(JSON.parse(JSON.stringify(next)));
}
function withLayoutMode(doc: DesignDocument, id: string, mode: string) {
  return transact(doc, {
    baseRevision: doc.revision,
    operations: [
      { type: "update", id, patch: { variableModes: { layout: mode } } },
    ],
  });
}
test("corner and auto-layout eligibility follows layer type, visibility, locks and component protection", () => {
  for (const type of [
    "rectangle",
    "frame",
    "button",
    "ellipse",
    "text",
    "vector",
    "group",
    "section",
    "slice",
  ] as const) {
    const node = createNode(type);
    assert.equal(
      canEditCornerRadius(scene(node), node),
      ["rectangle", "frame", "button"].includes(type),
    );
    assert.equal(canEditAutoLayoutHandles(scene(node), node), false);
  }
  const { frame, doc } = flow("row");
  assert.ok(canEditAutoLayoutHandles(doc, frame));
  frame.style.layout = "grid";
  assert.equal(canEditAutoLayoutHandles(doc, frame), false);
  frame.style.layout = "column";
  const parent = createNode("frame");
  frame.parentId = parent.id;
  const nested = scene(parent, frame);
  for (const check of [canEditCornerRadius, canEditAutoLayoutHandles]) {
    assert.equal(check(nested, frame), true);
    for (const layer of [frame, parent]) {
      for (const field of ["hidden", "locked"] as const) {
        layer[field] = true;
        assert.equal(check(nested, frame), false);
        layer[field] = false;
      }
    }
    frame.componentSet = { libraryId: "kit", componentId: "card" };
    assert.equal(check(nested, frame), false);
    delete frame.componentSet;
  }
  const library = createLibraryFromSelection(nested, parent.id, "Card");
  const target = scene();
  const instance = instantiateComponent(
    target,
    library,
    library.components[0].id,
    "default",
    null,
    { x: 0, y: 0 },
  );
  const installed = transact(target, {
    baseRevision: 0,
    operations: instance.operations,
  });
  const inside = installed.nodes.find((n) => n.parentId === instance.id)!;
  const root = installed.nodes.find((n) => n.id === instance.id)!;
  assert.equal(canEditCornerRadius(installed, inside), false);
  assert.equal(canEditAutoLayoutHandles(installed, inside), false);
  assert.equal(canEditCornerRadius(installed, root), false);
  assert.equal(
    canEditAutoLayoutHandles(installed, {
      ...root,
      style: { ...root.style, layout: "column" },
    }),
    false,
  );
});

test("corner handles use a screen-space threshold, inward clearance and independent radii", () => {
  const rect = createNode("rectangle");
  rect.style.corners = { tl: 0, tr: 16, br: 40, bl: 1000 };
  for (const size of [
    { width: 111, height: 120 },
    { width: 120, height: 111 },
  ]) {
    assert.deepEqual(getCornerHandleSpecs(rect, { ...box, ...size }, 0.5), []);
  }
  assert.equal(
    getCornerHandleSpecs(rect, { ...box, width: 112, height: 112 }, 0.5).length,
    4,
  );
  const specs = getCornerHandleSpecs(rect, box, 1);
  assert.deepEqual(
    specs.map((s) => s.corner),
    ["tl", "tr", "br", "bl"],
  );
  for (const { corner, radius, localPoint, maxRadius } of specs) {
    const dx = corner.endsWith("l") ? localPoint.x : box.width - localPoint.x;
    const dy = corner.startsWith("t")
      ? localPoint.y
      : box.height - localPoint.y;
    assert.ok(dx >= 12 && dx < box.width / 2);
    assert.ok(dy >= 12 && dy < box.height / 2);
    assert.ok(Math.abs(dx - dy) < 1e-8);
    assert.ok(
      Math.abs(
        dx - Math.min(Math.max(12, radius * 0.72 + 4), box.height / 2 - 14),
      ) < 1e-8,
    );
    assert.equal(maxRadius, 40);
  }
});

test("unified corner drag clears existing asymmetric corners in one undoable transaction and in generated CSS", () => {
  const node = createNode("rectangle");
  node.style.corners = { ...asymmetric };
  const doc = scene(node);
  const next = computeCornerRadiusDrag({
    node,
    box,
    corner: "tl",
    localPoint: { x: 12, y: 20 },
    singleCorner: false,
  });
  assert.equal(next.value, 16);
  const reopened = roundTrip(doc, next.operations);
  assert.equal(reopened.nodes[0].style.corners, undefined);
  assert.equal(reopened.nodes[0].style.radius, 16);
  assert.deepEqual(getNodeCornerRadii(reopened.nodes[0]), {
    tl: 16,
    tr: 16,
    br: 16,
    bl: 16,
  });
  assert.equal(nodeCss(reopened.nodes[0], reopened, "canvas").borderRadius, 16);
  assert.match(exportReact(reopened), /"borderRadius":16\b/);
  assert.deepEqual(node.style.corners, asymmetric);
});

test("single-corner drags project from each vertex, preserve the other three, snap and clamp", () => {
  const node = createNode("button");
  node.style.corners = asymmetric;
  const pointers = {
    tl: { x: 17, y: 20 },
    tr: { x: 143, y: 20 },
    br: { x: 143, y: 61 },
    bl: { x: 17, y: 61 },
  };
  for (const corner of Object.keys(pointers) as CornerKey[]) {
    const result = computeCornerRadiusDrag({
      node,
      box,
      corner,
      localPoint: pointers[corner],
      singleCorner: true,
      snapStep: 4,
    });
    const expected = { ...asymmetric, [corner]: 20 };
    assert.deepEqual(result.corners, expected);
    const changed = roundTrip(scene(node), result.operations).nodes[0];
    assert.deepEqual(changed.style.corners, expected);
    assert.equal(changed.style.radius, expected.tl);
  }
  const base = { node, box, corner: "tl" as const, singleCorner: false };
  assert.equal(
    computeCornerRadiusDrag({ ...base, localPoint: { x: 400, y: 300 } }).value,
    40,
  );
  assert.equal(
    computeCornerRadiusDrag({ ...base, localPoint: { x: -4, y: -8 } }).value,
    0,
  );
});

test("row and column spacing handles measure real child bounds in the frame's local axes", () => {
  for (const layout of ["row", "column"] as const) {
    const { doc, frame } = flow(layout);
    frame.style.insets = { top: 0, right: 6, bottom: 18, left: 10 };
    frame.style.strokeWidth = 2;
    const { paddings, gaps } = getAutoLayoutHandleSpecs(
      doc,
      frame,
      layoutBounds(doc),
    );
    assert.deepEqual(
      paddings.map((p) => p.side),
      ["top", "right", "bottom", "left"],
    );
    assert.deepEqual(
      paddings.map((p) => p.value),
      [0, 6, 18, 10],
    );
    assert.deepEqual(paddings[0].bandRect, {
      x: 0,
      y: 2,
      width: 150,
      height: 0,
    });
    assert.deepEqual(paddings[1].handlePoint, { x: 145, y: 65 });
    assert.deepEqual(
      gaps.map((g) => [g.index, g.axis, g.value]),
      [
        [0, layout === "row" ? "x" : "y", 8],
        [1, layout === "row" ? "x" : "y", 8],
      ],
    );
    assert.deepEqual(
      gaps[0].bandRect,
      layout === "row"
        ? { x: 32, y: 2, width: 8, height: 16 }
        : { x: 12, y: 18, width: 20, height: 8 },
    );
    assert.deepEqual(
      gaps[1].handlePoint,
      layout === "row" ? { x: 64, y: 10 } : { x: 22, y: 46 },
    );
  }
});

test("spacing bands skip distributed gaps, hidden children and absolute-positioned children", () => {
  const { doc, frame, children } = flow("row", 4);
  children[1].hidden = true;
  children[2].style.absolutePosition = true;
  const specs = () => getAutoLayoutHandleSpecs(doc, frame, layoutBounds(doc));
  const [gap] = specs().gaps;
  assert.equal(specs().gaps.length, 1);
  assert.deepEqual(gap.bandRect, { x: 30, y: 10, width: 8, height: 16 });
  frame.style.justifyContent = "space-between";
  assert.equal(specs().paddings.length, 4);
  assert.equal(specs().gaps.length, 0);
  delete frame.style.justifyContent;
  children[3].hidden = true;
  assert.deepEqual(specs().gaps, []);
});

test("wrapping produces only same-line main-axis gaps, including reversed and center-aligned rows", () => {
  for (const reverse of [false, true]) {
    const { doc, frame, children } = flow("row", 5);
    Object.assign(frame.style, {
      width: 68,
      wrap: true,
      layoutReverse: reverse,
      alignY: "center",
      rowGap: 0,
    });
    children[0].style.height = 24;
    const specs = getAutoLayoutHandleSpecs(doc, frame, layoutBounds(doc));
    assert.deepEqual(
      specs.gaps.map((g) => g.bandRect),
      [
        { x: 30, y: 14, width: 8, height: 16 },
        { x: 30, y: 34, width: 8, height: 16 },
      ],
    );
  }
});

test("padding edits preserve asymmetric sides, symmetrize opposite edges and synchronize uniform padding", () => {
  const { frame, doc } = flow("row");
  assert.deepEqual(getNodeInsets(frame), {
    top: 10,
    right: 10,
    bottom: 10,
    left: 10,
  });
  const initialInsets = { top: 11, right: 7, bottom: 19, left: 1 };
  frame.style.insets = initialInsets;
  const base = {
    node: frame,
    side: "left" as const,
    initialInsets,
    inwardDelta: 6,
    symmetric: false,
    allSides: false,
  };
  const single = computePaddingDrag({ ...base, snapStep: 4 });
  assert.deepEqual(single.affectedSides, ["left"]);
  assert.deepEqual(roundTrip(doc, single.operations).nodes[0].style.insets, {
    ...initialInsets,
    left: 8,
  });
  const symmetric = computePaddingDrag({
    ...base,
    side: "bottom",
    symmetric: true,
    inwardDelta: -100,
  });
  assert.deepEqual(symmetric.affectedSides, ["bottom", "top"]);
  assert.deepEqual(symmetric.insets, { ...initialInsets, top: 0, bottom: 0 });
  const all = computePaddingDrag({
    ...base,
    symmetric: true,
    allSides: true,
    inwardDelta: 1300,
  });
  assert.equal(all.affectedSides.length, 4);
  const reopened = roundTrip(doc, all.operations);
  assert.equal(reopened.nodes[0].style.padding, 1000);
  assert.deepEqual(getNodeInsets(reopened.nodes[0]), {
    top: 1000,
    right: 1000,
    bottom: 1000,
    left: 1000,
  });
  assert.equal(
    nodeCss(reopened.nodes[0], reopened).padding,
    "1000px 1000px 1000px 1000px",
  );
});

test("linked gap edits snap, preserve explicit line spacing and round-trip through history and export", () => {
  const { frame, doc } = flow("row");
  frame.style.rowGap = 25;
  frame.style.wrap = true;
  const base = { node: frame, initialGap: 8 };
  for (const [delta, expected] of [
    [7, 16],
    [-5, 4],
    [-50, 0],
    [1500, 1000],
  ]) {
    const next = computeGapDrag({ ...base, delta, snapStep: 4 });
    assert.equal(next.value, expected);
    const reopened = roundTrip(doc, next.operations);
    assert.equal(reopened.nodes[0].style.gap, expected);
    assert.equal(reopened.nodes[0].style.rowGap, 25);
    assert.equal(nodeCss(reopened.nodes[0], reopened).gap, expected);
  }
  frame.style.wrap = false;
  frame.style.gap = -4;
  assert.deepEqual(
    getAutoLayoutHandleSpecs(doc, frame, layoutBounds(doc)).gaps[0].bandRect,
    { x: 26, y: 10, width: 4, height: 16 },
  );
  const negative = computeGapDrag({
    node: frame,
    initialGap: -4,
    delta: -2000,
  });
  assert.equal(roundTrip(doc, negative.operations).nodes[0].style.gap, -1000);
});

test("native radius and spacing variables survive partial edits, mode changes and React export", () => {
  const { doc, frame } = flow("row");
  doc.designSystem = nativeDesignSystem();
  frame.variableBindings = { radius: "radius-md", padding: "space-sm" };
  const base = parseDocument(doc);
  const node = resolveNode(base, base.nodes[0]);
  const corner = computeCornerRadiusDrag({
    node,
    box,
    corner: "tr",
    singleCorner: true,
    localPoint: { x: box.width - 23, y: 23 },
  });
  const rounded = roundTrip(base, corner.operations);
  for (const symmetric of [false, true]) {
    const node = resolveNode(rounded, rounded.nodes[0]);
    const pad = computePaddingDrag({
      node,
      side: "left",
      initialInsets: getNodeInsets(node),
      inwardDelta: 3,
      symmetric,
      allSides: false,
    });
    const reopened = roundTrip(rounded, pad.operations);
    for (const [mode, radius, padding] of [
      ["compact", 12, 4],
      ["comfortable", 16, 8],
    ] as const) {
      const changed = withLayoutMode(reopened, frame.id, mode);
      const raw = changed.nodes[0],
        style = resolveNode(changed, raw).style;
      assert.equal(raw.variableBindings?.radius, undefined);
      assert.equal(raw.variableBindings?.padding, undefined);
      assert.deepEqual(style.corners, {
        tl: radius,
        tr: 23,
        br: radius,
        bl: radius,
      });
      assert.deepEqual(style.insets, {
        top: padding,
        right: symmetric ? 11 : padding,
        bottom: padding,
        left: 11,
      });
      const css = symbolicNodeCss(changed, raw, nodeCss(raw, changed));
      const files = reactProjectFiles(
        changed,
        readFileSync("src/runtime/FormaRuntime.tsx", "utf8"),
      );
      const react = files["src/DesignPage.tsx"];
      for (const key of [
        "borderTopLeftRadius",
        "borderBottomLeftRadius",
        "borderBottomRightRadius",
      ]) {
        assert.equal(css[key], "calc(var(--radius-md) * 1px)");
        assert.ok(
          react.includes(JSON.stringify(key) + ": " + JSON.stringify(css[key])),
        );
      }
      for (const key of symmetric
        ? ["paddingTop", "paddingBottom"]
        : ["paddingTop", "paddingRight", "paddingBottom"]) {
        assert.equal(css[key], "calc(var(--space-sm) * 1px)");
        assert.ok(
          react.includes(JSON.stringify(key) + ": " + JSON.stringify(css[key])),
        );
      }
      assert.equal(css.borderTopRightRadius, undefined);
      assert.equal(css.paddingLeft, undefined);
      assert.match(
        files["src/tokens.css"],
        /="compact"\] \{[^}]*--space-sm: 4;[^}]*--radius-md: 12;/,
      );
    }
  }
  // The later top-left binding overrides the shared radius only on that corner.
  const mixed = transact(base, {
    baseRevision: base.revision,
    operations: [
      {
        type: "bindVariable",
        id: frame.id,
        property: "corners.tl",
        variableId: "radius-sm",
      },
    ],
  });
  const partial = computeCornerRadiusDrag({
    node: mixed.nodes[0],
    initialRadii: getNodeCornerRadii(resolveNode(mixed, mixed.nodes[0])),
    box,
    corner: "tr",
    singleCorner: true,
    localPoint: { x: box.width - 8, y: 8 },
  });
  const result = roundTrip(mixed, partial.operations);
  assert.deepEqual(result.nodes[0].variableBindings, {
    padding: "space-sm",
    "corners.tl": "radius-sm",
    "corners.br": "radius-md",
    "corners.bl": "radius-md",
  });
  const uniform = computeCornerRadiusDrag({
    node: resolveNode(result, result.nodes[0]),
    box,
    corner: "tl",
    singleCorner: false,
    localPoint: { x: 8, y: 8 },
  });
  assert.deepEqual(
    roundTrip(result, uniform.operations).nodes[0].variableBindings,
    { padding: "space-sm" },
  );
  const all = computePaddingDrag({
    node,
    side: "left",
    initialInsets: getNodeInsets(node),
    inwardDelta: 1,
    symmetric: false,
    allSides: true,
  });
  assert.deepEqual(roundTrip(base, all.operations).nodes[0].variableBindings, {
    radius: "radius-md",
  });
});

test("editing tr preserves literal 1/2/3/4 corners under a shadowed radius binding", () => {
  const { doc, frame } = flow("row");
  doc.designSystem = nativeDesignSystem();
  frame.style.corners = asymmetric;
  for (const fineBindings of [false, true]) {
    frame.variableBindings = fineBindings
      ? {
          radius: "radius-md",
          "corners.bl": "radius-sm",
          "corners.tr": "radius-md",
        }
      : { radius: "radius-md" };
    const base = parseDocument(doc);
    const before = resolveNode(base, base.nodes[0]);
    const edit = computeCornerRadiusDrag({
      node: base.nodes[0],
      initialRadii: getNodeCornerRadii(before),
      box,
      corner: "tr",
      localPoint: { x: box.width - 10, y: 10 },
      singleCorner: true,
    });
    const reopened = roundTrip(base, edit.operations);
    assert.deepEqual(resolveNode(reopened, reopened.nodes[0]).style.corners, {
      tl: 1,
      tr: 10,
      br: 3,
      bl: fineBindings ? before.style.corners!.bl : 4,
    });
    assert.deepEqual(
      reopened.nodes[0].variableBindings,
      fineBindings ? { "corners.bl": "radius-sm" } : {},
    );
  }
});

test("an Option-drag of tr preserves corner inheritance in both binding orders", () => {
  const { doc, frame } = flow("row");
  doc.designSystem = nativeDesignSystem();
  frame.style.radius = 1;
  for (const uniformFirst of [false, true]) {
    frame.variableBindings = uniformFirst
      ? { radius: "radius-md", "corners.bl": "radius-sm" }
      : { "corners.bl": "radius-sm", radius: "radius-md" };
    const base = parseDocument(doc);
    const raw = base.nodes[0];
    assert.equal(raw.style.corners, undefined);
    const initialRadii = getNodeCornerRadii(resolveNode(base, raw));
    const initial = uniformFirst ? 16 : 1;
    assert.deepEqual(initialRadii, {
      tl: initial,
      tr: initial,
      br: initial,
      bl: 8,
    });
    const edit = computeCornerRadiusDrag({
      node: raw,
      initialRadii,
      box,
      corner: "tr",
      localPoint: { x: box.width - 10, y: 10 },
      singleCorner: true,
    });
    const reopened = roundTrip(base, edit.operations);
    const saved = reopened.nodes[0];
    assert.deepEqual(resolveNode(reopened, saved).style.corners, {
      tl: initial,
      tr: 10,
      br: initial,
      bl: 8,
    });
    if (!uniformFirst) assert.equal(saved.style.radius, 1);
    const compact = withLayoutMode(reopened, saved.id, "compact");
    assert.deepEqual(resolveNode(compact, compact.nodes[0]).style.corners, {
      tl: uniformFirst ? 12 : 1,
      tr: 10,
      br: uniformFirst ? 12 : 1,
      bl: 4,
    });
    assert.deepEqual(
      saved.variableBindings,
      uniformFirst
        ? {
            "corners.tl": "radius-md",
            "corners.br": "radius-md",
            "corners.bl": "radius-sm",
          }
        : { "corners.bl": "radius-sm" },
    );
  }
});

test("editing left preserves literal 1/2/3/4 insets under a shadowed padding binding", () => {
  const { doc, frame } = flow("row");
  doc.designSystem = nativeDesignSystem();
  frame.style.insets = { top: 1, right: 2, bottom: 3, left: 4 };
  for (const fineBindings of [false, true]) {
    frame.variableBindings = fineBindings
      ? {
          padding: "space-sm",
          "insets.right": "space-sm",
          "insets.left": "space-sm",
        }
      : { padding: "space-sm" };
    const base = parseDocument(doc);
    const initialInsets = getNodeInsets(resolveNode(base, base.nodes[0]));
    const edit = computePaddingDrag({
      node: base.nodes[0],
      initialInsets,
      side: "left",
      inwardDelta: 5 - initialInsets.left,
      symmetric: false,
      allSides: false,
    });
    const reopened = roundTrip(base, edit.operations);
    assert.deepEqual(resolveNode(reopened, reopened.nodes[0]).style.insets, {
      top: 1,
      right: fineBindings ? initialInsets.right : 2,
      bottom: 3,
      left: 5,
    });
    assert.deepEqual(
      reopened.nodes[0].variableBindings,
      fineBindings ? { "insets.right": "space-sm" } : {},
    );
  }
});

test("a left drag preserves inset inheritance in both binding orders", () => {
  const { doc, frame } = flow("row");
  doc.designSystem = nativeDesignSystem();
  frame.style.padding = 1;
  for (const uniformFirst of [false, true]) {
    frame.variableBindings = uniformFirst
      ? { padding: "space-sm", "insets.right": "space-md" }
      : { "insets.right": "space-md", padding: "space-sm" };
    const base = parseDocument(doc);
    const raw = base.nodes[0];
    assert.equal(raw.style.insets, undefined);
    const initialInsets = getNodeInsets(resolveNode(base, raw));
    const initial = uniformFirst ? 8 : 1;
    assert.deepEqual(initialInsets, {
      top: initial,
      right: 16,
      bottom: initial,
      left: initial,
    });
    const edit = computePaddingDrag({
      node: raw,
      initialInsets,
      side: "left",
      inwardDelta: 4,
      symmetric: false,
      allSides: false,
    });
    const reopened = roundTrip(base, edit.operations);
    const saved = reopened.nodes[0];
    assert.deepEqual(resolveNode(reopened, saved).style.insets, {
      top: initial,
      right: 16,
      bottom: initial,
      left: uniformFirst ? 12 : 5,
    });
    assert.equal(saved.style.padding, 1);
    const compact = withLayoutMode(reopened, saved.id, "compact");
    assert.deepEqual(resolveNode(compact, compact.nodes[0]).style.insets, {
      top: uniformFirst ? 4 : 1,
      right: 12,
      bottom: uniformFirst ? 4 : 1,
      left: uniformFirst ? 12 : 5,
    });
    assert.deepEqual(
      saved.variableBindings,
      uniformFirst
        ? {
            "insets.top": "space-sm",
            "insets.right": "space-md",
            "insets.bottom": "space-sm",
          }
        : { "insets.right": "space-md" },
    );
  }
});

test("narrow token scopes reject a partial edit atomically and still allow a uniform drag", () => {
  const { frame, doc } = flow("row");
  doc.designSystem = nativeDesignSystem();
  doc.designSystem.variables["radius-md"].scopes = ["radius"];
  doc.designSystem.variables["space-sm"].scopes = ["padding"];
  frame.variableBindings = { radius: "radius-md", padding: "space-sm" };
  const base = parseDocument(doc);
  const node = resolveNode(base, base.nodes[0]);
  const corner = {
    node,
    box,
    corner: "tl" as const,
    localPoint: { x: 28, y: 28 },
  };
  const padding = {
    node,
    side: "top" as const,
    initialInsets: getNodeInsets(node),
    inwardDelta: 5,
    symmetric: false,
  };
  const partialRadius = computeCornerRadiusDrag({
    ...corner,
    singleCorner: true,
  }).operations;
  const partialPadding = computePaddingDrag({
    ...padding,
    allSides: false,
  }).operations;
  assert.throws(
    () => checkHandleBindingScopes(base, partialRadius),
    /radius-md.*corners\./,
  );
  assert.throws(
    () => checkHandleBindingScopes(base, partialPadding),
    /space-sm.*insets\./,
  );
  assert.deepEqual(base.nodes[0].variableBindings, {
    radius: "radius-md",
    padding: "space-sm",
  });
  const uniform = computeCornerRadiusDrag({
    ...corner,
    singleCorner: false,
  }).operations;
  assert.equal(
    roundTrip(base, checkHandleBindingScopes(base, uniform)).nodes[0].style
      .radius,
    28,
  );
});

test("only the fields overridden at the measured width suppress their handles", () => {
  const { doc, frame } = flow("row");
  frame.style.layoutBreakpoints = [
    { maxWidth: 240, padding: 0 },
    { maxWidth: 180, radius: 0 },
    { maxWidth: 130, gap: 0 },
  ];
  for (const [width, corners, paddings, gaps] of [
    [241, 4, 4, 2],
    [240, 4, 0, 2],
    [180, 0, 0, 2],
    [130, 0, 0, 0],
  ]) {
    // The declared width stays constant while the measured container crosses breakpoints.
    const bounds = layoutBounds(doc);
    const measured = { ...bounds.get(frame.id)!, width };
    bounds.set(frame.id, measured);
    assert.equal(getCornerHandleSpecs(frame, measured, 1).length, corners);
    const specs = getAutoLayoutHandleSpecs(doc, frame, bounds);
    assert.equal(specs.paddings.length, paddings);
    assert.equal(specs.gaps.length, gaps);
  }
  assert.deepEqual(
    getAutoLayoutHandleSpecs(doc, frame, layoutBounds(doc), 0.2),
    { paddings: [], gaps: [] },
  );
});

test("a 200px breakpoint with rowGap 36 suppresses only the column main-axis handles", () => {
  for (const direction of ["column", "row"] as const) {
    const { frame, doc } = flow(direction);
    frame.style.width = 200;
    frame.style.layoutBreakpoints = [{ maxWidth: 200, rowGap: 36 }];
    const bounds = layoutBounds(doc);
    const handles = getAutoLayoutHandleSpecs(doc, frame, bounds);
    assert.equal(handles.gaps.length, direction === "column" ? 0 : 2);
    assert.equal(handles.paddings.length, 4);
    bounds.set(frame.id, { ...bounds.get(frame.id)!, width: 201 });
    assert.equal(getAutoLayoutHandleSpecs(doc, frame, bounds).gaps.length, 2);
  }
});

test("row and column gaps cross zero on successive gestures unless wrapped", () => {
  for (const layout of ["row", "column"] as const) {
    const { doc } = flow(layout);
    for (const wrap of [true, false]) {
      let current = doc;
      current.nodes[0].style.wrap = wrap;
      current.nodes[0].style.gap = 0;
      for (const [delta, expected] of [
        [-4, wrap ? 0 : -4],
        [4, wrap ? 4 : 0],
        [-4, wrap ? 0 : -4],
      ]) {
        const node = current.nodes[0];
        const drag = computeGapDrag({
          node,
          initialGap: node.style.gap,
          delta,
        });
        current = roundTrip(current, drag.operations);
        assert.equal(current.nodes[0].style.gap, expected);
      }
    }
  }
});

test("handle previews defer bindings, locks, group rebasing, and master propagation to transactions", () => {
  const { doc, frame, children } = flow("row", 1);
  const radius = (id: string): Operation => ({
    type: "update",
    id,
    patch: {},
    style: { radius: 19 },
  });
  const complete = (base: DesignDocument, ops: Operation[]) => {
    indexPublishedScene(base);
    assert.deepEqual(
      previewGeometry(base, ops),
      transact(base, { baseRevision: base.revision, operations: ops }),
    );
  };
  const bound = parseDocument({ ...doc, designSystem: nativeDesignSystem() });
  complete(bound, [
    {
      type: "bindVariable",
      id: frame.id,
      property: "radius",
      variableId: "radius-md",
    },
    radius(frame.id),
  ]);
  const linked = transact(bound, {
    baseRevision: bound.revision,
    operations: [
      {
        type: "bindVariable",
        id: frame.id,
        property: "radius",
        variableId: "radius-md",
      },
    ],
  });
  complete(linked, [radius(frame.id)]);
  const grouped = createNode("group");
  const child = createNode("rectangle", grouped.id);
  child.style.x = 30;
  complete(scene(grouped, child), [radius(child.id)]);
  const library = createLibraryFromSelection(doc, frame.id, "Master");
  complete({ ...doc, libraries: { [library.id]: library } }, [
    radius(children[0].id),
  ]);
  frame.locked = true;
  assert.throws(() => previewGeometry(doc, [radius(children[0].id)]), /锁定/);
});

test("8,320-layer handle previews share unaffected nodes and recompute spacing geometry", (t) => {
  const nodes: DesignNode[] = [];
  for (let i = 0; i < 128; i++) {
    const { frame, children } = flow("row", 64);
    nodes.push(frame, ...children);
  }
  const base = parseDocument(scene(...nodes));
  indexPublishedScene(base);
  const frame = base.nodes.at(-65)!,
    child = base.nodes.at(-64)!;
  const original = layoutBounds(base);
  const samples: number[] = [];
  for (let i = 0; i < 24; i++) {
    const radius = i + 1;
    const start = performance.now();
    const preview = previewGeometry(base, [
      { type: "update", id: frame.id, style: { radius }, patch: {} },
    ]);
    samples.push(performance.now() - start);
    assert.equal(preview.revision, base.revision);
    assert.equal(findLayer(preview, frame.id)?.style.radius, radius);
    assert.notEqual(preview.nodes, base.nodes);
    assert.equal(preview.nodes[0], base.nodes[0]);
    assert.equal(preview.nodes.at(-1), base.nodes.at(-1));
    assert.equal(layoutBounds(preview), original);
    assert.ok(unchangedBranch(base, preview, base.nodes[0].id));
  }
  const p95 = samples.sort((a, b) => a - b)[
    Math.ceil(samples.length * 0.95) - 1
  ];
  t.diagnostic(
    `8,320 layers, ${samples.length} radius previews, P95 ${p95.toFixed(2)} ms`,
  );
  assert.ok(p95 < 16.7, `P95 ${p95} ms`);
  const operations: Operation[] = [
    {
      type: "update",
      id: frame.id,
      patch: {},
      style: { padding: 24, gap: -4 },
    },
  ];
  const preview = previewGeometry(base, operations);
  const committed = transact(base, { baseRevision: base.revision, operations });
  assert.equal(preview.nodes[0], base.nodes[0]);
  assert.deepEqual(
    layoutBounds(preview).get(child.id),
    layoutBounds(committed).get(child.id),
  );
  assert.equal(unchangedBranch(base, preview, child.id), false);
  assert.equal(frame.style.padding, 10);
  assert.throws(() =>
    previewGeometry(base, [
      { type: "update", id: frame.id, patch: {}, style: { gap: -1001 } },
    ]),
  );
});

test("8,320-layer bound single-corner previews stay below 5 ms P95 and match the transaction", (t) => {
  const nodes: DesignNode[] = [];
  for (let i = 0; i < 128; i++) {
    const { frame, children } = flow("row", 64);
    nodes.push(frame, ...children);
  }
  const frame = nodes.at(-65)!;
  frame.variableBindings = {
    radius: "radius-md",
    padding: "space-sm",
    gap: "space-sm",
  };
  const base = parseDocument({
    ...scene(...nodes),
    designSystem: nativeDesignSystem(),
  });
  indexPublishedScene(base);
  const raw = findLayer(base, frame.id)!;
  const resolved = resolveNode(base, raw);
  const initialRadii = getNodeCornerRadii(resolved);
  const samples: number[] = [];
  for (let value = 1; value <= 40; value++) {
    const { operations } = computeCornerRadiusDrag({
      node: raw,
      initialRadii,
      box,
      corner: "tr",
      singleCorner: true,
      localPoint: { x: box.width - value, y: value },
    });
    const start = performance.now();
    const draft = previewGeometry(base, operations);
    samples.push(performance.now() - start);
    assert.equal(draft.nodes[0], base.nodes[0]);
    assert.equal(draft.revision, base.revision);
    assert.deepEqual(
      resolveNode(draft, findLayer(draft, frame.id)!).style.corners,
      { tl: 16, tr: value, br: 16, bl: 16 },
    );
    if (value === 40) {
      const committed = transact(base, {
        baseRevision: base.revision,
        operations,
      });
      assert.deepEqual(
        parseDocument({ ...draft, revision: committed.revision }),
        committed,
      );
    }
  }
  for (const { operations } of [
    computePaddingDrag({
      node: raw,
      side: "left",
      initialInsets: getNodeInsets(resolved),
      inwardDelta: 5,
      symmetric: false,
      allSides: false,
    }),
    computeGapDrag({ node: raw, initialGap: resolved.style.gap, delta: 5 }),
  ]) {
    const draft = previewGeometry(base, operations);
    assert.equal(draft.nodes[0], base.nodes[0]);
    const committed = transact(base, {
      baseRevision: base.revision,
      operations,
    });
    assert.deepEqual(
      findLayer(draft, frame.id),
      findLayer(committed, frame.id),
    );
    assert.deepEqual(
      layoutBounds(draft).get(nodes.at(-64)!.id),
      layoutBounds(committed).get(nodes.at(-64)!.id),
    );
  }
  const p95 = samples.sort((a, b) => a - b)[
    Math.ceil(samples.length * 0.95) - 1
  ];
  t.diagnostic(
    `8,320 layers, ${samples.length} bound corner previews, P95 ${p95.toFixed(3)} ms`,
  );
  assert.ok(p95 < 5, `P95 ${p95} ms`);
});

test("binding preview falls back to the same transaction errors including values in inactive alias modes", () => {
  const { frame, doc } = flow("row");
  const system = nativeDesignSystem();
  const numeric = system.variables["radius-md"];
  numeric.scopes = ["radius"];
  system.variables.wide = {
    ...numeric,
    id: "wide",
    name: "Wide",
    scopes: [],
    values: { comfortable: 12, compact: 1001 },
  };
  system.variables.alias = {
    ...numeric,
    id: "alias",
    name: "Wide alias",
    scopes: [],
    values: { comfortable: 8, compact: { alias: "wide" } },
  };
  const base = parseDocument({ ...doc, designSystem: system });
  indexPublishedScene(base);
  const color = Object.values(system.variables).find(
    (v) => v.type === "color",
  )!.id;
  for (const variableBindings of [
    { "insets.left": "missing" },
    { "insets.left": color },
    { "insets.left": "radius-md" },
    { "insets.left": "alias" },
  ]) {
    const operations: Operation[] = [
      {
        type: "update",
        id: frame.id,
        style: { insets: getNodeInsets(frame) },
        patch: { variableBindings },
      },
    ];
    let expected: unknown;
    assert.throws(
      () => transact(base, { baseRevision: base.revision, operations }),
      (err: unknown) => {
        expected = err;
        return true;
      },
    );
    assert.throws(
      () => previewGeometry(base, operations),
      (err: unknown) =>
        err instanceof Error &&
        expected instanceof Error &&
        err.message === expected.message,
    );
  }
});

function mountDOM(t: TestContext) {
  const dom = new DOMParser().parseFromString("<html/>", "text/html");
  const create = dom.createElement.bind(dom);
  const captured = new Map<Element, number>();
  const noop = () => {};
  t.mock.method(dom, "createElement", (tag: string) => {
    const el = create(tag);
    return Object.assign(el, {
      style: { setProperty: noop, removeProperty: noop },
      dataset: {},
      classList: { toggle: noop },
      closest: () => null,
      getContext: () => null,
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
      }),
      focus: noop,
      addEventListener: noop,
      removeEventListener: noop,
      setPointerCapture: (id: number) => captured.set(el, id),
      hasPointerCapture: (id: number) => captured.get(el) === id,
      releasePointerCapture: () => captured.delete(el),
    });
  });
  dom.addEventListener = dom.removeEventListener = noop;
  const host = dom.createElement("div");
  const events = new EventTarget();
  host.addEventListener = events.addEventListener.bind(events);
  let tick = 0;
  const frames = new Map<number, FrameRequestCallback>();
  async function paint() {
    await act(() => {
      for (const [id, frame] of [...frames]) {
        frames.delete(id);
        frame(performance.now());
      }
    });
  }
  const win = Object.assign(new EventTarget(), {
    document: dom,
    HTMLIFrameElement: class {},
  });
  for (const [key, value] of Object.entries({
    requestAnimationFrame: (frame: FrameRequestCallback) => {
      frames.set(++tick, frame);
      return tick;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    HTMLElement: host.constructor,
    window: win,
    document: dom,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }

  const root = createRoot(host);
  const byTestId = (id: string) =>
    Array.from(host.getElementsByTagName("*")).find(
      (el) => el.getAttribute("data-testid") === id,
    );
  const control = (id: string) => {
    const el = byTestId(id);
    assert.ok(el, id);
    return el;
  };
  function dispatch(
    type: string,
    target: Element | Window | EventTarget,
    fields: Record<string, unknown> = {},
    receiver = target === win ? win : events,
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "target", { value: target });
    Object.assign(event, {
      pointerId: 7,
      button: 0,
      clientX: 0,
      clientY: 0,
      ...fields,
    });
    receiver.dispatchEvent(event);
  }
  return {
    dom,
    host,
    root,
    win,
    dispatch,
    fire: (...args: Parameters<typeof dispatch>) =>
      act(() => dispatch(...args)),
    paint,
    captured,
    frames,
    byTestId,
    control,
  };
}

for (const [layout, label, value, original, dragged] of [
  ["row", "画布左上圆角手柄", (n: DesignNode) => n.style.radius, 4, 24],
  ["row", "画布左内边距手柄", (n: DesignNode) => getNodeInsets(n).left, 12, 32],
  [
    "grid",
    "拖动调整第 1 列宽",
    (n: DesignNode) => n.style.gridTracks,
    "40px 1fr",
    "60px 1fr",
  ],
] as const) {
  test(`releasing ${label} preserves a proposal queued before React renders`, async (t) => {
    const { root, host, fire, dispatch, paint, captured } = mountDOM(t);
    const { frame, doc } = flow("row");
    frame.style.radius = 4;
    frame.style.padding = 12;
    if (layout === "grid") {
      frame.style.layout = layout;
      frame.style.columns = 2;
      frame.style.gridTracks = original;
    }
    let editor!: EditorController;
    function Selection() {
      editor = useEditor({ initialDocument: doc, active: false });
      const node = editor.doc.nodes[0];
      const bounds = layoutBounds(editor.doc);
      const props = { editor, node, matrix: identity, zoom: 1 };
      if (node.style.layout === "grid")
        return createElement(GridHandles, { ...props, boxes: bounds });
      const box = bounds.get(node.id)!;
      return createElement(
        "div",
        null,
        createElement(CornerRadiusHandles, { ...props, box }),
        createElement(AutoLayoutHandles, { ...props, box, bounds }),
      );
    }
    try {
      await act(() => root.render(createElement(Selection)));
      const handle = Array.from(host.getElementsByTagName("button")).find(
        (button) => button.getAttribute("aria-label") === label,
      );
      assert.ok(handle);
      const base = editor.committed;
      const proposal = { ...base, name: "AI proposal" };
      const point = { clientX: 20, clientY: 20 };
      await act(() => {
        editor.setPreview(proposal);
        dispatch("keydown", handle, { key: "ArrowRight" });
        dispatch("pointerdown", handle);
        assert.equal(editor.historyRef.current.past.length, 0);
        assert.equal(captured.has(handle), false);
        assert.equal(editor.previewRef.current, proposal);
        editor.setPreview(null);
      });
      await fire("pointerdown", handle);
      await fire("pointermove", handle, point);
      await paint();
      const draft = editor.doc;
      assert.equal(value(draft.nodes[0]), dragged);
      assert.equal(editor.previewRef.current, draft);
      await act(() => {
        editor.setPreview(proposal);
        assert.equal(editor.doc, draft);
        dispatch("pointerup", handle, point);
      });
      assert.equal(value(editor.committed.nodes[0]), original);
      assert.equal(editor.historyRef.current.past.length, 0);
      assert.equal(editor.previewRef.current, proposal);
      assert.equal(editor.doc, proposal);
    } finally {
      await act(() => root.unmount());
    }
  });
}

test("mounted handles capture rotated drags, cancel previews, survive a rewrap and commit one history entry", async (t) => {
  const { host, root, win, fire, paint, captured, frames, byTestId, control } =
    mountDOM(t);
  const activity: boolean[] = [];
  let zoom = 2;
  const { frame, doc } = flow("row", 4);
  Object.assign(frame.style, {
    wrap: true,
    width: 68,
    radius: 0,
    rotation: 90,
  });
  const repository = {
    load: async () => doc,
    save: async () => {},
    recovery: async () => null,
    backup: async () => null,
  };
  const matrix = { a: 0, b: 1, c: -1, d: 0, e: 350, f: 37 };
  let editor!: EditorController;
  function Selection() {
    editor = useEditor({
      initialDocument: doc,
      initialSelection: [frame.id],
      repository,
      active: false,
    });
    const bounds = layoutBounds(editor.doc);
    const props = {
      editor,
      node: editor.doc.nodes[0],
      box: bounds.get(frame.id)!,
      matrix,
      zoom,
      onDragActiveChange: (active: boolean) => activity.push(active),
    };
    return createElement(
      "div",
      { className: "selection-overlay" },
      createElement(CornerRadiusHandles, props),
      createElement(AutoLayoutHandles, { ...props, bounds }),
    );
  }
  try {
    await act(() => root.render(createElement(Selection)));
    for (const el of Array.from(host.getElementsByTagName("button"))) {
      assert.equal(el.getAttribute("type"), "button");
      for (const attribute of [
        "aria-label",
        "title",
        "data-tip",
        "data-tip-desc",
      ])
        assert.ok(el.getAttribute(attribute), attribute);
    }
    for (const [id, label] of Object.entries({
      "corner-handle-tl": "左上圆角",
      "corner-handle-tr": "右上圆角",
      "corner-handle-br": "右下圆角",
      "corner-handle-bl": "左下圆角",
      "autolayout-padding-left": "左内边距",
      "autolayout-padding-right": "右内边距",
      "autolayout-padding-top": "上内边距",
      "autolayout-padding-bottom": "下内边距",
    })) {
      assert.equal(control(id).getAttribute("aria-label"), `画布${label}手柄`);
      assert.equal(control(id).getAttribute("data-tip"), label);
    }
    assert.equal(
      control("autolayout-gap-1").getAttribute("aria-label"),
      "画布子项间距手柄 2",
    );
    function assertSafeZones() {
      const { width, height } = layoutBounds(editor.doc).get(frame.id)!;
      const cx = width,
        cy = height; // The selection is rendered at 2×.
      for (const el of Array.from(host.getElementsByTagName("button"))) {
        if (!el.getAttribute("data-testid")?.startsWith("autolayout-"))
          continue;
        const {
          left,
          top,
          width: w,
          height: h,
        } = (el as HTMLButtonElement).style;
        const [x, y, sw, sh] = [left, top, w, h].map(parseFloat);
        assert.ok(
          x >= 5 &&
            y >= 5 &&
            x + sw <= width * 2 - 5 &&
            y + sh <= height * 2 - 5,
          "resize edge clearance",
        );
        assert.ok(
          Math.max(sw, sh) <= 28 && Math.min(sw, sh) <= 12,
          "bounded spacing hit box",
        );
        assert.ok(
          x + sw <= cx - 10 ||
            x >= cx + 10 ||
            y + sh <= cy - 10 ||
            y >= cy + 10,
          "20px center move target",
        );
      }
    }
    assertSafeZones();
    const corner = control("corner-handle-tl");
    await fire("pointerdown", corner);
    assert.equal(captured.get(corner), 7);
    assert.deepEqual(activity, [true]);
    await fire("pointermove", corner, { clientX: -4, clientY: 4 });
    await fire("pointermove", corner, { clientX: -18, clientY: 18 });
    assert.equal(frames.size, 1);
    assert.equal(editor.doc, editor.committed);
    await paint();
    assert.equal(editor.doc.nodes[0].style.radius, 9);
    assert.equal(editor.committed.nodes[0].style.radius, 0);
    await fire("keydown", win, { key: "Alt", altKey: true });
    assert.equal(control("corner-radius-badge").textContent, "左上 9");
    await fire("keydown", win, { key: "Escape" });
    assert.equal(editor.doc, editor.committed);
    assert.equal(captured.size, 0);
    assert.deepEqual(activity, [true, false]);
    await fire("pointerup", corner, { clientX: -18, clientY: 18 });
    assert.equal(editor.historyRef.current.past.length, 0);
    // An embedding can still update the zoom prop while a pointer is captured.
    await fire("pointerdown", corner);
    zoom = 3;
    await act(() => root.render(createElement(Selection)));
    await fire("pointermove", corner, { clientX: -12, clientY: 12 });
    await paint();
    assert.equal(editor.doc.nodes[0].style.radius, 4);
    await fire("pointerup", corner, { clientX: -12, clientY: 12 });
    assert.equal(editor.committed.nodes[0].style.radius, 4);
    zoom = 2;
    await act(() => editor.undo());
    for (const event of [
      "blur",
      "pointercancel",
      "lostpointercapture",
      "focusout",
    ]) {
      await fire("pointerdown", corner);
      await fire("pointermove", corner, { clientX: -8, clientY: 8 });
      await fire(event, event === "blur" ? win : corner);
      assert.equal(frames.size, 0);
      await paint();
      assert.equal(editor.doc, editor.committed, event);
      assert.equal(byTestId("corner-radius-badge"), undefined);
    }
    await fire("keydown", corner, { key: "ArrowRight", shiftKey: true });
    assert.equal(editor.committed.nodes[0].style.radius, 4);
    await act(() => editor.undo());

    const top = control("autolayout-padding-top");
    await fire("pointerdown", top);
    await fire("pointermove", top, {
      clientX: -27,
      altKey: true,
      shiftKey: true,
    });
    await paint();
    assert.equal(control("autolayout-spacing-badge").textContent, "四边 24");
    assert.equal(editor.doc.nodes[0].style.padding, 24);
    await fire("pointerup", top, {
      clientX: -27,
      altKey: true,
      shiftKey: true,
    });
    assert.equal(editor.historyRef.current.past.length, 1);
    await act(() => editor.undo());
    assert.equal(editor.committed.nodes[0].style.padding, 10);

    const gap = control("autolayout-gap-1");
    await fire("pointerdown", gap);
    const lit = () =>
      Array.from(host.getElementsByTagName("span")).filter((el) =>
        el.getAttribute("class")?.includes("autolayout-gap-band is-active"),
      );
    assert.equal(lit().length, 2);
    await fire("pointermove", gap, { clientY: 60 });
    await paint();
    assert.equal(editor.doc.nodes[0].style.gap, 38);
    assert.equal(control("autolayout-gap-1"), gap);
    assert.equal(byTestId("autolayout-gap-0"), undefined);
    await fire("pointermove", gap, { clientY: 52 });
    assert.equal(frames.size, 1);
    await fire("pointerup", gap, { clientY: 52 });
    assert.equal(frames.size, 0);
    assert.equal(editor.committed.nodes[0].style.gap, 34);
    assert.equal(editor.historyRef.current.past.length, 1);
    await act(() => editor.undo());
    assert.equal(editor.committed.nodes[0].style.gap, 8);
    const gapAgain = control("autolayout-gap-0");
    await fire("keydown", gapAgain, { key: "ArrowLeft" });
    assert.equal(editor.committed.nodes[0].style.gap, 7);
    const before = editor.committed;
    const proposal = transact(before, {
      baseRevision: before.revision,
      operations: [
        {
          type: "update",
          id: frame.id,
          patch: {},
          style: {
            insets: { top: 31, right: 32, bottom: 33, left: 34 },
            radius: 29,
          },
        },
      ],
    });
    await act(() => editor.setPreview(proposal));
    assert.equal(byTestId("corner-handle-tl"), undefined);
    assert.equal(byTestId("autolayout-padding-top"), undefined);
    await fire("keydown", win, { key: "Escape" });
    assert.equal(editor.doc, proposal);
    await act(() => editor.setPreview(null));
    const topAgain = control("autolayout-padding-top");
    await fire("pointerdown", topAgain);
    await fire("pointermove", topAgain, { clientX: -8 });
    await paint();
    assert.equal(editor.doc.nodes[0].style.insets?.top, 14);
    await fire("pointermove", topAgain, { clientX: -16 });
    await act(() => editor.setPreview(proposal));
    assert.equal(frames.size, 0);
    assert.equal(captured.size, 0);
    await fire("pointerup", topAgain, { clientX: -16 });
    assert.equal(editor.doc, proposal);
    assert.equal(editor.committed, before);
    assert.equal(activity.at(-1), false);
    await act(() => editor.setPreview(null));
    await act(() =>
      editor.apply([
        {
          type: "update",
          id: frame.id,
          patch: {},
          style: {
            width: 60,
            height: 60,
            wrap: false,
            gap: 0,
            padding: 0,
            alignY: "center",
          },
        },
      ]),
    );
    assertSafeZones();
    await act(() =>
      editor.apply([
        {
          type: "update",
          id: frame.id,
          patch: {},
          style: { layoutBreakpoints: [{ maxWidth: 100, padding: 0 }] },
        },
      ]),
    );
    assert.equal(byTestId("autolayout-padding-top"), undefined);
    assert.ok(control("autolayout-gap-0"));
  } finally {
    await act(() => root.unmount());
  }
});

test("mounted spacing buttons have disjoint rectangles and uniquely hittable centers on small rows and columns", async (t) => {
  const { host, root } = mountDOM(t);
  function Selection({ doc }: { doc: DesignDocument }) {
    const editor = useEditor({ initialDocument: doc, active: false });
    const node = editor.committed.nodes[0];
    const bounds = layoutBounds(editor.committed);
    return createElement(AutoLayoutHandles, {
      editor,
      node,
      bounds,
      box: bounds.get(node.id)!,
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      zoom: 1,
    });
  }
  try {
    for (const layout of ["row", "column"] as const) {
      const row = layout === "row";
      const { doc, frame, children } = flow(layout, 3);
      Object.assign(frame.style, {
        width: row ? 60 : 100,
        height: row ? 100 : 60,
        padding: 6,
        gap: 8,
      });
      for (const child of children)
        Object.assign(child.style, {
          width: row ? 20 : 26,
          height: row ? 26 : 20,
        });
      await act(() =>
        root.render(createElement(Selection, { key: frame.id, doc })),
      );
      const buttons = Array.from(host.getElementsByTagName("button"), (el) => {
        const style = (el as HTMLButtonElement).style;
        const [x, y, w, h] = [
          style.left,
          style.top,
          style.width,
          style.height,
        ].map(parseFloat);
        return {
          id: el.getAttribute("data-testid"),
          x,
          y,
          right: x + w,
          bottom: y + h,
          cx: x + w / 2,
          cy: y + h / 2,
        };
      });
      const pads = buttons.filter((b) => b.id?.includes("padding"));
      const gaps = buttons.filter((b) => b.id?.includes("gap"));
      assert.equal(pads.length, 4);
      assert.ok(gaps.length > 0);
      const near = pads.find((b) => b.id?.endsWith(row ? "top" : "left"))!;
      const far = pads.find((b) => b.id?.endsWith(row ? "bottom" : "right"))!;
      for (const gap of gaps) {
        assert.ok(
          row
            ? gap.y >= near.bottom + 2 && gap.bottom <= far.y - 2
            : gap.x >= near.right + 2 && gap.right <= far.x - 2,
        );
        assert.ok(row ? gap.bottom - gap.y >= 10 : gap.right - gap.x >= 10);
      }
      for (const a of buttons) {
        assert.deepEqual(
          buttons.filter(
            (b) =>
              a.cx >= b.x && a.cx <= b.right && a.cy >= b.y && a.cy <= b.bottom,
          ),
          [a],
        );
        for (const b of buttons.filter((b) => b !== a))
          assert.ok(
            a.right <= b.x ||
              b.right <= a.x ||
              a.bottom <= b.y ||
              b.bottom <= a.y,
            a.id + " overlaps " + b.id,
          );
      }
    }
  } finally {
    await act(() => root.unmount());
  }
});

async function loadCanvas() {
  const css = registerHooks({
    load(url, context, next) {
      return url.endsWith(".css")
        ? { format: "module", source: "", shortCircuit: true }
        : next(url, context);
    },
  });
  try {
    return (await import("../src/editor/Canvas")).Canvas;
  } finally {
    css.deregister();
  }
}

test("P1-9: deactivating a mounted Canvas releases its SmartHandles capture and preview before pointerup", async (t) => {
  const Canvas = await loadCanvas();
  const { dom, root, host, fire, captured } = mountDOM(t);
  Object.assign(dom, { querySelector: () => null });
  const nodes = [0, 30, 60].map((x) => {
    const node = createNode("rectangle");
    Object.assign(node.style, { x, y: 0, width: 20, height: 20 });
    return node;
  });
  const doc = scene(...nodes);
  const ids = nodes.map((node) => node.id);
  const views = new Map([[doc.activePage ?? "first", { x: 0, y: 0, zoom: 1 }]]);
  let editor!: EditorController;
  function Surface({ active }: { active: boolean }) {
    editor = useEditor({ initialDocument: doc, initialSelection: ids });
    return createElement(Canvas, {
      active,
      editor,
      views,
      prototypeMode: false,
      contextMenu() {},
      onImportDesign() {},
    });
  }
  const render = (active: boolean) =>
    act(() => root.render(createElement(Surface, { active })));
  try {
    await render(true);
    const handle = Array.from(host.getElementsByTagName("button")).find(
      (el) => el.getAttribute("aria-label") === "拖动水平间距",
    )!;
    assert.ok(handle);
    await fire("pointerdown", handle);
    await fire("pointermove", handle, { clientX: 10 });
    assert.equal(captured.get(handle), 7);
    assert.deepEqual(
      editor.previewRef.current?.nodes.map((n) => n.style.x),
      [0, 40, 80],
    );
    await render(false);
    assert.equal(editor.previewRef.current, null);
    assert.equal(captured.has(handle), false);
    await fire("pointerup", handle, { clientX: 10 });
    await fire("keydown", handle, { key: "ArrowRight" });
    await fire("pointerdown", handle);
    assert.equal(captured.has(handle), false);
    assert.equal(editor.previewRef.current, null);
    assert.deepEqual(
      editor.committed.nodes.map((n) => n.style.x),
      [0, 30, 60],
    );
    assert.equal(editor.historyRef.current.past.length, 0);
  } finally {
    await act(() => root.unmount());
  }
});

test("mounted Canvas isolates proposed rotation and size, locks camera shortcuts and respects an open view menu", async (t) => {
  const Canvas = await loadCanvas();
  const { dom, host, root, win, fire, control } = mountDOM(t);
  const elements = () => Array.from(host.getElementsByTagName("*"));
  Object.assign(dom, {
    querySelector: (selector: string) =>
      selector === '[role="menu"]'
        ? (elements().find((el) => el.getAttribute("role") === "menu") ?? null)
        : null,
  });
  const { doc, frame } = flow("row");
  frame.style.rotation = 0;
  const page = doc.activePage ?? "first";
  const views = new Map([[page, { x: 0, y: 0, zoom: 1 }]]);
  let editor!: EditorController;
  const toggles: string[] = [];
  function App({ marked }: { marked: boolean }) {
    editor = useEditor({ initialDocument: doc, initialSelection: [frame.id] });
    return createElement(Canvas, {
      editor,
      views,
      prototypeMode: false,
      contextMenu() {},
      onImportDesign() {},
      viewOptions: {
        showRulers: false,
        showPixelGrid: false,
        showLayoutGuides: false,
        outlineMode: false,
        snapEnabled: true,
        showComments: false,
        showMinimap: false,
      },
      onToggleViewOption: (key) => toggles.push(key),
      aiPreviewNodeIds: marked ? new Set([frame.id]) : undefined,
    });
  }
  const render = async (marked = false) =>
    act(() => root.render(createElement(App, { marked })));
  const byClass = (key: string) =>
    elements().filter((el) =>
      el.getAttribute("class")?.split(" ").includes(key),
    );
  try {
    await render();
    const base = editor.committed;
    const proposal = transact(base, {
      baseRevision: base.revision,
      operations: [
        {
          type: "update",
          id: frame.id,
          patch: {},
          style: { rotation: 90, width: 360 },
        },
      ],
    });
    function assertGrips(count: number) {
      assert.equal(byClass("rotation-handle").length, count);
      assert.equal(byClass("resize-handle").length, count * 8);
    }
    assertGrips(1);
    await act(() => editor.setPreview(proposal));
    assertGrips(0);
    assert.equal(editor.committed, base);
    await act(() => editor.setPreview(null));
    await render(true);
    assertGrips(0);
    await render();
    assertGrips(1);
    const surface = byClass("editor-canvas")[0];
    for (const grip of ["rotation-handle", "handle-e"]) {
      await fire("pointerdown", byClass(grip)[0], {
        clientX: 300,
        clientY: 200,
      });
      await fire("pointermove", surface, { clientX: 320, clientY: 220 });
      assert.notEqual(editor.doc, base);
      await act(() => editor.setPreview(proposal));
      assertGrips(0);
      await fire("pointerup", surface, { clientX: 320, clientY: 220 });
      assert.equal(editor.doc, proposal);
      assert.equal(editor.committed, base);
      assert.equal(editor.historyRef.current.past.length, 0);
      await act(() => editor.setPreview(null));
    }
    const cx = frame.style.x + frame.style.width / 2,
      cy = frame.style.y + frame.style.height / 2;
    const angle = Math.PI / 18;
    await fire("pointerdown", byClass("rotation-handle")[0], {
      clientX: cx + 100,
      clientY: cy,
    });
    const finish = {
      clientX: cx + 100 * Math.cos(angle),
      clientY: cy + 100 * Math.sin(angle),
    };
    await fire("pointermove", surface, finish);
    await fire("pointerup", surface, finish);
    assert.ok(Math.abs(editor.committed.nodes[0].style.rotation! - 10) < 0.01);
    await act(() => editor.undo());
    await fire("pointerdown", byClass("handle-e")[0], {
      clientX: cx,
      clientY: cy,
    });
    await fire("pointermove", surface, { clientX: cx + 10, clientY: cy });
    await fire("pointerup", surface, { clientX: cx + 10, clientY: cy });
    assert.equal(editor.committed.nodes[0].style.width, frame.style.width + 10);
    await act(() => editor.undo());

    const press = (
      target: Element,
      key: string,
      extra: Record<string, unknown> = {},
    ) => fire("keydown", target, { key, ...extra }, win);
    await press(surface, "+");
    assert.equal(views.get(page)!.zoom, 1.2);
    for (const id of ["corner-handle-tl", "autolayout-padding-top"]) {
      const handle = control(id);
      await fire("pointerdown", handle);
      const view = views.get(page);
      for (const fields of [
        { key: "+" },
        { key: "-" },
        { key: "0", code: "Digit0", metaKey: true },
        { key: "!", code: "Digit1", shiftKey: true },
        { key: "@", code: "Digit2", shiftKey: true },
      ]) {
        await press(handle, fields.key, fields);
        assert.equal(views.get(page), view);
      }
      await fire("pointerup", handle);
    }
    await press(surface, "0", { code: "Digit0", metaKey: true });
    assert.equal(views.get(page)!.zoom, 1);
    const trigger = byClass("fp-view-trigger")[0];
    await fire("click", trigger);
    assert.ok(dom.querySelector('[role="menu"]'));
    await press(trigger, "M", { code: "KeyM", shiftKey: true });
    assert.deepEqual(toggles, []);
    await fire("click", trigger);
    await press(trigger, "M", { code: "KeyM", shiftKey: true });
    assert.deepEqual(toggles, ["showMinimap"]);
  } finally {
    await act(() => root.unmount());
  }
});
