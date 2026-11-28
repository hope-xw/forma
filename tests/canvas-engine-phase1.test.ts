import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { parse } from "postcss";
import {
  WHEEL_ZOOM_PRESETS,
  applyWheelToViewport,
  clampZoom,
  computeMinimapLayout,
  createCameraChannel,
  minimapPointToViewport,
  stepZoomLevel,
  worldRectToMinimap,
  type CameraState,
  type WheelDeltaInput,
} from "../src/application/canvas-camera";
import { createNode, type DesignNode } from "../src/domain/document";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  contains,
  createSnapIndex,
  intersects,
  layoutBounds,
  screenToWorld,
  snapMoveIndexed,
  zoomAt,
  type Point,
  type Rect,
  type Viewport,
} from "../src/domain/geometry";
import { indexPublishedScene } from "../src/domain/scene-index";
import { createStarter } from "../src/domain/seed";
import {
  buildSpatialIndex,
  type SpatialEntry,
} from "../src/domain/spatial-index";
import {
  identity,
  inverse,
  sceneTransforms,
  transform,
  visualBounds,
} from "../src/domain/transforms";

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
}
function samePoint(actual: Point, expected: Point) {
  near(actual.x, expected.x);
  near(actual.y, expected.y);
}

test("zoom limits and off-center anchors hold across the full camera range", () => {
  assert.equal(MIN_ZOOM, 0.02);
  assert.equal(MAX_ZOOM, 64);
  assert.equal(clampZoom(-Infinity), MIN_ZOOM);
  assert.equal(clampZoom(Infinity), MAX_ZOOM);
  assert.equal(clampZoom(NaN), 1);
  assert.equal(clampZoom(0.023456789123), 0.023456789123);
  const anchor = { x: -62.125, y: 461.25 };
  for (const zoom of [0.02, 1, 64]) {
    const view = { x: 149.5, y: -895, zoom };
    for (const target of [-1, 0.02, 1, 64, 999]) {
      const next = zoomAt(view, target, anchor);
      assert.equal(next.zoom, clampZoom(target));
      samePoint(screenToWorld(anchor, next), screenToWorld(anchor, view));
    }
  }
});

test("live overlay CSS compensates fixed grips on both axes and only the thickness of full edges", () => {
  const sheet = parse(
    readFileSync(
      new URL("../src/editor/canvas-feel.css", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(
    sheet.nodes.every(
      (n) => n.type === "atrule" && n.name === "layer" && n.params === "panels",
    ),
  );
  const selectorsByScale = new Map<string, string[]>();
  const scope = ".editor-canvas.is-camera-moving .canvas-live-overlays ";
  const inverse = "var(--live-overlay-inv-scale, 1)";
  sheet.walkDecls((decl) => {
    assert.equal(decl.important, undefined);
    if (decl.prop !== "scale" || decl.parent?.type !== "rule") return;
    const selector = decl.parent.selector.replace(/\s+/g, " ").trim();
    assert.ok(selector.startsWith(scope));
    const minimum = {
      ["1 " + inverse]: "min-width",
      [inverse + " 1"]: "min-height",
    }[decl.value];
    if (minimum) {
      assert.ok(
        decl.parent.nodes.some(
          (n) => n.type === "decl" && n.prop === minimum && n.value === "0",
        ),
        selector + " must reset " + minimum + " for narrow selections",
      );
    }
    // Expand the selector's :is() so a broad .resize-handle would fail this check.
    const parts = selector.slice(scope.length).split(":is(");
    const targets =
      parts.length === 1
        ? parts
        : parts[1]
            .slice(0, -1)
            .split(",")
            .map((s) => parts[0] + s.trim());
    selectorsByScale.set(decl.value, [
      ...(selectorsByScale.get(decl.value) ?? []),
      ...targets,
    ]);
  });
  function targets(scale: string, expected: string[]) {
    assert.deepEqual(selectorsByScale.get(scale)?.sort(), expected.sort());
  }
  targets(inverse, [
    ".corner-radius-handle",
    ".rotation-handle",
    ".frame-label",
    ".dimension-label",
    ...["nw", "ne", "sw", "se"].map((c) => ".resize-handle.handle-" + c),
  ]);
  targets("1 " + inverse, [
    ".resize-handle.handle-n",
    ".resize-handle.handle-s",
  ]);
  targets(inverse + " 1", [
    ".resize-handle.handle-e",
    ".resize-handle.handle-w",
  ]);
  targets("min(1, " + inverse + ")", [
    ".autolayout-padding-zone",
    ".autolayout-gap-zone",
  ]);
});

test("indexed snapping spans both objects and distinguishes edges, centers and page rulers", () => {
  const target = { x: 100, y: 20, width: 80, height: 60 };
  const index = createSnapIndex(
    [target, { ...target, y: -40, height: 20 }],
    [{ axis: "x", value: 140 }],
  );
  assert.deepEqual(
    snapMoveIndexed({ x: 98, y: 140, width: 15, height: 10 }, index, 3),
    {
      dx: 2,
      dy: 0,
      guides: [{ axis: "x", value: 100, start: -40, end: 150, kind: "edge" }],
    },
  );
  assert.deepEqual(
    snapMoveIndexed({ x: -50, y: 48, width: 30, height: 10 }, index, 3),
    {
      dx: 0,
      dy: 2,
      guides: [{ axis: "y", value: 50, start: -50, end: 180, kind: "center" }],
    },
  );
  assert.deepEqual(
    snapMoveIndexed({ x: 141, y: -100, width: 10, height: 3 }, index, 2),
    {
      dx: -1,
      dy: 0,
      guides: [{ axis: "x", value: 140, kind: "ruler" }],
    },
  );
});

test("two-axis snap guides end at the final moved rectangle", () => {
  const index = createSnapIndex([{ x: 100, y: 50, width: 20, height: 20 }]);
  assert.deepEqual(
    snapMoveIndexed({ x: 67, y: 72, width: 30, height: 40 }, index, 5),
    {
      dx: 3,
      dy: -2,
      guides: [
        { axis: "x", value: 100, start: 50, end: 110, kind: "edge" },
        { axis: "y", value: 70, start: 70, end: 120, kind: "edge" },
      ],
    },
  );
});

test("indexed snapping still accepts bare coordinate arrays, breaks ties consistently and excludes the threshold", () => {
  const index = { x: [0, 4], y: [42] };
  const point = { x: 2, y: 44, width: 0, height: 0 };
  assert.deepEqual(snapMoveIndexed(point, index, 3), {
    dx: -2,
    dy: -2,
    guides: [
      { axis: "x", value: 0 },
      { axis: "y", value: 42 },
    ],
  });
  assert.deepEqual(snapMoveIndexed(point, index, 2), {
    dx: 0,
    dy: 0,
    guides: [],
  });
});

function layer(
  id: string,
  type: DesignNode["type"],
  rect: Rect,
  parentId: string | null = null,
  rotation = 0,
) {
  const node = createNode(type, parentId);
  node.id = id;
  Object.assign(node.style, rect, { rotation });
  return node;
}

test("spatial cells include touching edges, zero-area lines, overflow and extreme negative coordinates", () => {
  const nodes = [
    layer("giant", "section", { x: -1e9, y: -1e9, width: 2e9, height: 2e9 }),
    layer(
      "vertical",
      "vector",
      { x: -256, y: -512, width: 0, height: 512 },
      "giant",
    ),
    layer("horizontal", "vector", { x: -512, y: -256, width: 256, height: 0 }),
    layer("point", "frame", { x: -256, y: -256, width: 0, height: 0 }),
    layer("distant", "frame", { x: -1e23, y: -1e23, width: 100, height: 0 }),
    layer("invalid", "rectangle", { x: NaN, y: 0, width: 1, height: 1 }),
    layer("bad-matrix", "rectangle", { x: 0, y: 0, width: 1, height: 1 }),
    layer("missing", "rectangle", { x: 0, y: 0, width: 1, height: 1 }),
  ];
  const doc = { ...createStarter(), nodes };
  const bounds = new Map(nodes.slice(0, -1).map((n) => [n.id, n.style]));
  const transforms = new Map([["bad-matrix", { ...identity, e: NaN }]]);
  const index = buildSpatialIndex(doc, bounds, transforms);
  assert.equal(index.cellSize, 256);
  assert.equal(index.size, 5);
  const crossing = { x: -256, y: -256 };
  const rect = { ...crossing, width: 0, height: 0 };
  const ids = (entries: SpatialEntry[]) => entries.map((e) => e.id);
  assert.deepEqual(ids(index.queryPoint(crossing)), [
    "giant",
    "vertical",
    "horizontal",
    "point",
  ]);
  assert.deepEqual(ids(index.queryRect(rect)), ids(index.queryPoint(crossing)));
  assert.deepEqual(ids(index.queryRootsInRect(rect)), [
    "giant",
    "horizontal",
    "point",
  ]);
  assert.deepEqual(ids(index.queryPoint({ x: -1e23, y: -1e23 })), ["distant"]);
  assert.deepEqual(
    ids(index.queryRect({ x: -1e24, y: -1e24, width: 2e24, height: 2e24 })),
    nodes.slice(0, 5).map((n) => n.id),
  );
  assert.deepEqual(index.queryPoint({ x: NaN, y: 0 }), []);
  assert.equal(
    index.findSmallestContainerAt(crossing, () => false),
    null,
  );
});

test("spatial caches isolate document, bounds, transform and cell size snapshots", () => {
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  const doc = { ...createStarter(), nodes: [layer("node", "frame", rect)] };
  indexPublishedScene(doc);
  const bounds = layoutBounds(doc),
    matrices = sceneTransforms(doc, bounds);
  const first = buildSpatialIndex(doc, bounds, matrices);
  assert.equal(
    buildSpatialIndex(
      doc,
      layoutBounds(doc),
      sceneTransforms(doc, bounds),
      256,
    ),
    first,
  );
  const moved = new Map([["node", { ...rect, x: 1024 }]]);
  const newBounds = buildSpatialIndex(doc, moved, matrices);
  assert.deepEqual(newBounds.queryPoint(rect), []);
  assert.equal(newBounds.queryPoint({ x: 1024, y: 0 })[0].id, "node");
  const shifted = buildSpatialIndex(
    doc,
    bounds,
    new Map([["node", { ...identity, f: 15 }]]),
  );
  assert.deepEqual(shifted.queryPoint(rect), []);
  assert.equal(shifted.queryPoint({ x: 0, y: 16 })[0].id, "node");
  const empty = buildSpatialIndex({ ...doc, nodes: [] }, bounds, matrices);
  assert.equal(empty.size, 0);
  assert.equal(buildSpatialIndex(doc, bounds, matrices, 32).cellSize, 32);
  assert.equal(buildSpatialIndex(doc, bounds, matrices), first);
  assert.throws(() => buildSpatialIndex(doc, bounds, matrices, 0), RangeError);
});

test("container picking tests the actual rotated shape and preserves document-order ties", () => {
  const square = { x: -50, y: -50, width: 100, height: 100 };
  const background = { x: -100, y: -100, width: 200, height: 200 };
  const doc = {
    ...createStarter(),
    nodes: [
      layer("section", "section", background),
      layer("first", "frame", square, null, 45),
      layer("second", "frame", square),
    ],
  };
  const bounds = layoutBounds(doc);
  const index = buildSpatialIndex(doc, bounds, sceneTransforms(doc, bounds));
  const corner = { x: -65, y: -65 };
  assert.deepEqual(
    index.queryPoint(corner).map((e) => e.id),
    ["section", "first"],
  );
  assert.equal(
    index.findSmallestContainerAt(corner, () => true),
    "section",
  );
  assert.equal(
    index.findSmallestContainerAt({ x: 0, y: 0 }, () => true),
    "first",
  );
  assert.equal(
    index.findSmallestContainerAt({ x: 0, y: 0 }, (e) => e.id !== "first"),
    "second",
  );
});

function seededRandom(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function compareQueries<Q, R>(
  t: TestContext,
  name: string,
  inputs: Q[],
  indexed: (q: Q) => R,
  linear: (q: Q) => R,
) {
  for (const q of inputs.slice(0, 24)) {
    indexed(q);
    linear(q);
  }
  const indexedTimes: number[] = [],
    linearTimes: number[] = [];
  for (const q of inputs) {
    const start = performance.now();
    const actual = indexed(q);
    const mid = performance.now();
    const expected = linear(q);
    linearTimes.push(performance.now() - mid);
    indexedTimes.push(mid - start);
    assert.deepEqual(actual, expected);
  }
  const median = (samples: number[]) =>
    samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  const fast = median(indexedTimes),
    slow = median(linearTimes);
  t.diagnostic(
    `${name}: median of ${inputs.length} individual queries, index ${(fast * 1000).toFixed(2)} µs, linear ${(slow * 1000).toFixed(2)} µs`,
  );
  assert.ok(fast * 2 < slow, `${name}: expected at least a 2x median speedup`);
}

test("10,000 layers: spatial queries match ordered linear scans of transformed bounds and accelerate local queries", (t) => {
  const random = seededRandom(1127);
  const nodes = [
    layer("section", "section", { x: -1e8, y: -1e8, width: 2e8, height: 2e8 }),
  ];
  for (let i = 0; i < 100; i++) {
    nodes.push(
      layer(
        "board-" + i,
        "frame",
        {
          x: ((i % 10) - 5) * 1100,
          y: (Math.floor(i / 10) - 5) * 800,
          width: 730,
          height: 510,
        },
        null,
        i % 4 === 0 ? -17 : 0,
      ),
    );
  }
  while (nodes.length < 10_000) {
    const i = nodes.length;
    nodes.push(
      layer(
        "item-" + i,
        i % 6 === 0 ? "frame" : "rectangle",
        {
          x: Math.floor(random() * 700),
          y: Math.floor(random() * 485),
          width: i % 39 === 0 ? 0 : 20 + Math.floor(random() * 120),
          height: i % 53 === 0 ? 0 : 10 + Math.floor(random() * 80),
        },
        "board-" + (i % 100),
        i % 5 === 0 ? random() * 180 - 90 : 0,
      ),
    );
  }
  const doc = { ...createStarter(), nodes };
  indexPublishedScene(doc);
  const bounds = layoutBounds(doc),
    matrices = sceneTransforms(doc, bounds);
  const index = buildSpatialIndex(doc, bounds, matrices);
  assert.equal(index.size, 10_000);
  // Precompute visual boxes for the baseline too, so timing measures only lookup.
  const entries = doc.nodes.map(({ id, type, parentId }, order) => {
    const box = bounds.get(id)!;
    return {
      id,
      type,
      parentId,
      order,
      area: box.width * box.height,
      rect: visualBounds(box, matrices.get(id) ?? identity),
    };
  });
  const points: Point[] = [],
    rects: Rect[] = [];
  for (let i = 0; i < 256; i++) {
    const box = entries[1 + Math.floor(random() * (entries.length - 1))].rect;
    const point =
      i % 4 === 0
        ? { x: box.x, y: box.y }
        : { x: box.x + box.width * random(), y: box.y + box.height * random() };
    points.push(point);
    rects.push({
      ...point,
      width: Math.floor(random() * 640),
      height: Math.floor(random() * 300),
    });
  }
  compareQueries(t, "queryPoint", points, index.queryPoint, (q) =>
    entries.filter((e) => contains(e.rect, q)),
  );
  compareQueries(t, "queryRect", rects, index.queryRect, (q) =>
    entries.filter((e) => intersects(e.rect, q)),
  );
  compareQueries(t, "queryRootsInRect", rects, index.queryRootsInRect, (q) =>
    entries.filter((e) => e.parentId === null && intersects(e.rect, q)),
  );
  const container = (e: SpatialEntry) =>
    e.type === "section" || e.type === "frame";
  compareQueries(
    t,
    "findSmallestContainerAt",
    points,
    (p) => index.findSmallestContainerAt(p, container),
    (p) => {
      let best: SpatialEntry | undefined;
      for (const e of entries) {
        if (!container(e) || (best && e.area >= best.area)) continue;
        const m = matrices.get(e.id) ?? identity;
        if (
          contains(
            bounds.get(e.id)!,
            m === identity ? p : transform(inverse(m), p),
          )
        )
          best = e;
      }
      return best?.id ?? null;
    },
  );
});

const view = { x: -67, y: 81, zoom: 1 };
const wheel: WheelDeltaInput = {
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  anchor: { x: 271, y: 33 },
};
test("wheel and pinch zoom smoothly at the pointer, saturating at both limits", () => {
  for (const dy of [-40, -3, 0.125, 40]) {
    const result = applyWheelToViewport(view, {
      ...wheel,
      ctrlKey: true,
      deltaY: dy,
    });
    assert.equal(result.kind, "zoom");
    near(result.viewport.zoom, Math.exp(-dy * 0.01));
    samePoint(
      screenToWorld(wheel.anchor, result.viewport),
      screenToWorld(wheel.anchor, view),
    );
  }
  for (const [dy, factor, limit] of [
    [-480, 1.54, MAX_ZOOM],
    [480, 0.65, MIN_ZOOM],
  ]) {
    const input = { ...wheel, metaKey: true, deltaY: dy };
    const result = applyWheelToViewport(view, input);
    assert.equal(result.viewport.zoom, factor);
    samePoint(
      screenToWorld(wheel.anchor, result.viewport),
      screenToWorld(wheel.anchor, view),
    );
    const capped = { ...view, zoom: limit };
    assert.deepEqual(applyWheelToViewport(capped, input).viewport, capped);
  }
  assert.deepEqual(
    applyWheelToViewport(view, {
      ...wheel,
      deltaMode: 1,
      deltaY: 2,
      ctrlKey: true,
    }),
    applyWheelToViewport(view, { ...wheel, deltaY: 32, ctrlKey: true }),
  );
});

test("pan normalizes line and page deltas and redirects only predominantly vertical Shift-wheel input", () => {
  const pan = (overrides: Partial<WheelDeltaInput>, dx: number, dy: number) => {
    assert.deepEqual(applyWheelToViewport(view, { ...wheel, ...overrides }), {
      kind: "pan",
      viewport: { x: view.x - dx, y: view.y - dy, zoom: 1 },
    });
  };
  pan({ deltaX: 3, deltaY: -2, deltaMode: 1 }, 48, -32);
  pan({ deltaX: 1, deltaY: -2, deltaMode: 2 }, 400, -800);
  pan({ deltaX: 1, deltaY: -8, shiftKey: true }, -8, 0);
  pan({ deltaX: 8, deltaY: -1, shiftKey: true }, 8, -1);
  pan({ deltaX: -8, deltaY: 8, shiftKey: true }, -8, 8);
});

test("zoom buttons step from every exact preset and every intermediate zoom", () => {
  assert.deepEqual(
    [...WHEEL_ZOOM_PRESETS],
    [0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8, 16, 32, 64],
  );
  assert.equal(stepZoomLevel(MIN_ZOOM, -1), MIN_ZOOM);
  assert.equal(stepZoomLevel(MAX_ZOOM, 1), MAX_ZOOM);
  for (let i = 1; i < WHEEL_ZOOM_PRESETS.length; i++) {
    const low = WHEEL_ZOOM_PRESETS[i - 1],
      high = WHEEL_ZOOM_PRESETS[i];
    const mid = Math.sqrt(low * high);
    assert.equal(stepZoomLevel(low, 1), high);
    assert.equal(stepZoomLevel(high, -1), low);
    assert.equal(stepZoomLevel(mid, 1), high);
    assert.equal(stepZoomLevel(mid, -1), low);
  }
});

function manualClock() {
  let now = 0,
    nextId = 0;
  const tasks = new Map<number, { due: number; run: () => void }>();
  return {
    scheduleTimeout(run: () => void, delay: number) {
      const id = nextId++;
      tasks.set(id, { due: now + delay, run });
      return id;
    },
    clearTimeout(id: number) {
      tasks.delete(id);
    },
    pending: () => tasks.size,
    advance(ms: number) {
      now += ms;
      for (const [id, task] of tasks) {
        if (task.due <= now) {
          tasks.delete(id);
          task.run();
        }
      }
    },
  };
}

test("60 live updates arrive synchronously and settle once, 72 ms after the last input", () => {
  const clock = manualClock();
  const channel = createCameraChannel(view, clock);
  const live: CameraState[] = [],
    settled: Viewport[] = [];
  channel.subscribeLive((s) => live.push(s));
  channel.subscribeSettled((v) => settled.push(v));
  assert.equal(channel.get(), view);
  assert.equal(channel.isInteracting(), false);
  for (let i = 1; i <= 60; i++) {
    const next = { ...view, x: i };
    channel.setLive(next);
    assert.equal(channel.get(), next);
    assert.equal(channel.isInteracting(), true);
    assert.deepEqual(live.at(-1), { viewport: next, interacting: true });
    assert.equal(clock.pending(), 1);
    if (i < 60) clock.advance(8);
  }
  clock.advance(71);
  assert.equal(live.length, 60);
  assert.equal(settled.length, 0);
  clock.advance(1);
  assert.deepEqual(live.at(-1), {
    viewport: channel.get(),
    interacting: false,
  });
  assert.equal(live.length, 61);
  assert.equal(channel.isInteracting(), false);
  assert.deepEqual(settled, [channel.get()]);
  channel.flush();
  clock.advance(500);
  assert.equal(settled.length, 1);
});

test("immediate jumps, flush, unsubscribe and disposal leave no stale camera callbacks", () => {
  const clock = manualClock(),
    channel = createCameraChannel(view, { ...clock, settleMs: 15 });
  const events: string[] = [];
  const offLive = channel.subscribeLive(({ interacting }) =>
    events.push(interacting ? "moving" : "idle"),
  );
  const offSettled = channel.subscribeSettled((v) =>
    events.push("settled " + v.x),
  );
  const jump = { ...view, x: 300 };
  channel.setLive(view);
  channel.setImmediate(jump);
  assert.equal(channel.get(), jump);
  assert.equal(clock.pending(), 0);
  assert.equal(channel.isInteracting(), false);
  channel.setLive(jump);
  channel.flush();
  channel.flush();
  clock.advance(1000);
  assert.deepEqual(events.splice(0), [
    "moving",
    "idle",
    "settled 300",
    "moving",
    "idle",
    "settled 300",
  ]);
  offLive();
  channel.setLive(view);
  clock.advance(14);
  assert.equal(events.length, 0);
  clock.advance(1);
  assert.deepEqual(events.splice(0), ["settled -67"]);
  offSettled();
  channel.setImmediate(jump);
  channel.setLive(view);
  channel.subscribeLive(() => events.push("live"));
  channel.subscribeSettled(() => events.push("settled"));
  channel.dispose();
  assert.equal(clock.pending(), 0);
  assert.equal(channel.isInteracting(), false);
  clock.advance(1000);
  channel.flush();
  channel.setImmediate(jump);
  channel.setLive(jump);
  assert.equal(channel.get(), view);
  assert.equal(events.length, 0);
  assert.equal(clock.pending(), 0);
});

test("minimap projects negative boards and the visible world; clicking a projected center restores the camera", () => {
  const surface = { width: 960, height: 480 },
    map = { width: 200, height: 120 };
  const board = { x: -3400, y: -920, width: 80, height: 60 };
  const center = { x: surface.width / 2, y: surface.height / 2 };
  for (const zoom of [MIN_ZOOM, 1, MAX_ZOOM]) {
    const camera = { ...view, zoom };
    const visible = {
      ...screenToWorld({ x: 0, y: 0 }, camera),
      width: surface.width / zoom,
      height: surface.height / zoom,
    };
    const layout = computeMinimapLayout([board], camera, surface, map, 8);
    for (const rect of [visible, board]) {
      const projected = worldRectToMinimap(rect, layout);
      assert.ok(projected.x >= 8 - 1e-7 && projected.y >= 8 - 1e-7);
      assert.ok(projected.x + projected.width <= map.width - 8 + 1e-7);
      assert.ok(projected.y + projected.height <= map.height - 8 + 1e-7);
      near(projected.width, rect.width * layout.scale);
      const clicked = minimapPointToViewport(
        {
          x: projected.x + projected.width / 2,
          y: projected.y + projected.height / 2,
        },
        layout,
        camera,
        surface,
      );
      assert.equal(clicked.zoom, zoom);
      samePoint(screenToWorld(center, clicked), {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      });
      if (rect === visible) samePoint(clicked, camera);
    }
  }
});
