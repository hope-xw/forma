import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  computeMinimapLayout,
  minimapPointToViewport,
  shouldAutoExpandMinimap,
  viewportWorldRect,
  worldRectToMinimap,
} from "../src/application/minimap-layout";
import type { Rect } from "../src/domain/geometry";
import {
  CanvasMinimap,
  minimapViewBox,
  minimapGrabOffset,
  panMinimapWithKey,
  type CanvasMinimapProps,
} from "../src/editor/CanvasMinimap";
import { CanvasOverlayHud } from "../src/editor/CanvasOverlayHud";

const surface = { width: 1200, height: 720 };
const map = { width: 184, height: 118 };
const camera = { x: 207.5, y: -92.25, zoom: 1.375 };
const center = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const close = (actual: number, expected: number) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-7,
    `expected ${actual} ≈ ${expected}`,
  );

const pages: Rect[] = Array.from({ length: 150 }, (_, index) => ({
  x: ((index % 15) - 7) * 580,
  y: (Math.floor(index / 15) - 5) * 940,
  width: 390,
  height: 844,
}));
const examples = {
  empty: [],
  single: [{ x: 1250, y: 438, width: 420, height: 960 }],
  negative: [{ x: -935, y: -640, width: 375, height: 812 }],
  "150 boards": pages,
};
for (const [name, rects] of Object.entries(examples)) {
  test(`Minimap fits, pads and centers ${name} with one scale`, () => {
    const layout = computeMinimapLayout(rects, camera, surface, map);
    const { worldBounds, scale } = layout;
    assert.ok(Number.isFinite(scale) && scale > 0);
    const bounds = worldRectToMinimap(worldBounds, layout);
    close(center(bounds).x, map.width / 2);
    close(center(bounds).y, map.height / 2);
    close(Math.min(bounds.x, bounds.y), 10);
    const visible = viewportWorldRect(camera, surface);
    for (const rect of [...rects, visible]) {
      assert.ok(rect.x > worldBounds.x && rect.y > worldBounds.y);
      assert.ok(rect.x + rect.width < worldBounds.x + worldBounds.width);
      assert.ok(rect.y + rect.height < worldBounds.y + worldBounds.height);
      const projected = worldRectToMinimap(rect, layout);
      close(projected.width / rect.width, scale);
      close(projected.height / rect.height, scale);
      assert.ok(
        projected.x >= 10 && projected.x + projected.width <= map.width - 10,
      );
      assert.ok(
        projected.y >= 10 && projected.y + projected.height <= map.height - 10,
      );
    }
    if (rects.length === 0) {
      close(center(visible).x, center(worldBounds).x);
      close(center(visible).y, center(worldBounds).y);
    }
  });
}

test("Viewport world bounds invert screen origin and extent", () => {
  const r = viewportWorldRect(camera, surface);
  close(r.x * camera.zoom + camera.x, 0);
  close(r.y * camera.zoom + camera.y, 0);
  close((r.x + r.width) * camera.zoom + camera.x, surface.width);
  close((r.y + r.height) * camera.zoom + camera.y, surface.height);
});

test("Grabbing the visible blue box preserves the off-center grab point even at minimum marker size", () => {
  for (const zoom of [0.6, 64]) {
    const view = { ...camera, zoom };
    const layout = computeMinimapLayout(pages, view, surface, map);
    const projection = worldRectToMinimap(
      viewportWorldRect(view, surface),
      layout,
    );
    const marker = minimapViewBox(projection);
    close(center(marker).x, center(projection).x);
    close(center(marker).y, center(projection).y);
    const down = { x: marker.x + 1, y: marker.y + 1 };
    const offset = minimapGrabOffset(down, marker);
    assert.ok(offset);
    const queued = { ...marker, x: marker.x + 19, y: marker.y - 7 };
    const pendingOffset = minimapGrabOffset(down, marker, queued);
    assert.ok(pendingOffset);
    close(down.x - pendingOffset.x, center(queued).x);
    close(down.y - pendingOffset.y, center(queued).y);
    for (const delta of [
      { x: 0, y: 0 },
      { x: 4, y: -3 },
    ]) {
      const next = minimapPointToViewport(
        { x: down.x + delta.x - offset.x, y: down.y + delta.y - offset.y },
        layout,
        view,
        surface,
      );
      close(next.x, view.x - (delta.x * zoom) / layout.scale);
      close(next.y, view.y - (delta.y * zoom) / layout.scale);
    }
    assert.equal(
      minimapGrabOffset({ x: marker.x - 1, y: down.y }, marker),
      null,
    );
  }
});

test("Minimap arrows move the world viewport by a fifth or a half without changing zoom", () => {
  const before = viewportWorldRect(camera, surface);
  for (const shift of [false, true]) {
    const step = shift ? 0.5 : 0.2;
    for (const [key, dx, dy] of [
      ["ArrowLeft", -1, 0],
      ["ArrowRight", 1, 0],
      ["ArrowUp", 0, -1],
      ["ArrowDown", 0, 1],
    ] as const) {
      const next = panMinimapWithKey(key, shift, camera, surface);
      assert.ok(next);
      assert.equal(next.zoom, camera.zoom);
      const after = viewportWorldRect(next, surface);
      close(after.x - before.x, dx * before.width * step);
      close(after.y - before.y, dy * before.height * step);
    }
  }
  assert.equal(panMinimapWithKey("a", false, camera, surface), null);
});

test("Clicking each projected board center centers that board and preserves the exact zoom", () => {
  for (const zoom of [0.02, 0.625, 1, 3.125, 64]) {
    const viewport = { ...camera, zoom };
    const layout = computeMinimapLayout(pages, viewport, surface, map, 6);
    for (const board of pages) {
      const next = minimapPointToViewport(
        center(worldRectToMinimap(board, layout)),
        layout,
        viewport,
        surface,
      );
      assert.equal(next.zoom, zoom);
      const focus = center(board);
      close(focus.x * next.zoom + next.x, surface.width / 2);
      close(focus.y * next.zoom + next.y, surface.height / 2);
    }
    const current = minimapPointToViewport(
      center(worldRectToMinimap(viewportWorldRect(viewport, surface), layout)),
      layout,
      viewport,
      surface,
    );
    close(current.x, viewport.x);
    close(current.y, viewport.y);
  }
});

test("Zero-sized surfaces, invalid geometry and excessive padding produce finite layouts", () => {
  for (const value of [
    0,
    -2,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
  ]) {
    const size = { width: value, height: value };
    const layout = computeMinimapLayout(
      [{ x: value, y: -value, ...size }],
      { x: -value, y: value, zoom: value },
      size,
      size,
      Number.MAX_VALUE,
    );
    const { worldBounds, ...numbers } = layout;
    assert.ok(
      [...Object.values(numbers), ...Object.values(worldBounds)].every(
        Number.isFinite,
      ),
    );
    assert.ok(
      layout.scale > 0 && worldBounds.width > 0 && worldBounds.height > 0,
    );
  }
});

test("Auto-expansion requires all three thresholds, including their exact boundaries", () => {
  assert.equal(shouldAutoExpandMinimap(5, surface), false);
  assert.equal(
    shouldAutoExpandMinimap(150, { width: 1024, height: 480 }),
    false,
  );
  assert.equal(shouldAutoExpandMinimap(6, { width: 1079, height: 540 }), false);
  assert.equal(shouldAutoExpandMinimap(6, { width: 1080, height: 539 }), false);
  assert.equal(shouldAutoExpandMinimap(6, { width: 1080, height: 540 }), true);
  assert.equal(shouldAutoExpandMinimap(150, surface), true);
});

test("Collapsed minimap has no surface; expanded header counts only artboards and names both controls", () => {
  const props: CanvasMinimapProps = {
    camera: { get: () => camera, subscribeLive: () => () => {} },
    viewport: camera,
    surfaceSize: surface,
    items: [
      { id: "a", rect: pages[0], kind: "frame" },
      { id: "b", rect: pages[1], kind: "frame" },
      { id: "section", rect: pages[2], kind: "section" },
      { id: "set", rect: pages[3], kind: "component" },
    ],
    expanded: false,
    onNavigate() {},
    onToggleExpanded() {},
    onFitAll() {},
  };
  assert.equal(renderToStaticMarkup(createElement(CanvasMinimap, props)), "");
  const markup = renderToStaticMarkup(
    createElement(CanvasMinimap, { ...props, expanded: true }),
  );
  assert.match(markup, /data-testid="canvas-minimap"/);
  assert.match(markup, />2 画板</);
  assert.match(markup, /role="application"/);
  assert.match(markup, /tabIndex="0"/i);
  for (const [label, key] of [
    ["适应全部", "⇧1"],
    ["收起小地图", "⇧M"],
  ]) {
    assert.ok(markup.includes(`aria-label="${label}"`));
    assert.ok(markup.includes(`data-tip="${label}"`));
    assert.ok(markup.includes(`data-tip-kbd="${key}"`));
  }
});

test("HUD exposes a single decorative canvas for both the grid and snap guides", () => {
  const markup = renderToStaticMarkup(
    createElement(CanvasOverlayHud, {
      camera: { get: () => camera, subscribeLive: () => () => {} },
      surfaceSize: surface,
      showPixelGrid: true,
      guides: [{ axis: "x", value: 17, start: -8, end: 64 }],
    }),
  );
  assert.equal(
    markup,
    '<canvas class="canvas-overlay-hud" aria-hidden="true"></canvas>',
  );
});
