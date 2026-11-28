import type { Point, Rect, Viewport } from "../domain/geometry";

type Size = Pick<Rect, "width" | "height">;

export interface MinimapNodeSummary {
  id: string;
  rect: Rect;
  kind: "frame" | "section" | "component" | "shape";
  fill?: string;
  selected?: boolean;
}

export interface MinimapLayout {
  worldBounds: Rect;
  scale: number;
  /** Minimap position of the world origin, in CSS pixels. */
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

// Keep enough headroom for adding extents and padding, even on invalid input.
function coordinate(value: number) {
  if (Number.isNaN(value)) return 0;
  return Math.max(
    -Number.MAX_SAFE_INTEGER,
    Math.min(Number.MAX_SAFE_INTEGER, value),
  );
}

function extent(value: number) {
  return Number.isFinite(value) ? Math.max(0, coordinate(value)) : 0;
}

export function viewportWorldRect(viewport: Viewport, surfaceSize: Size): Rect {
  const zoom =
    viewport.zoom > 0 && Number.isFinite(viewport.zoom) ? viewport.zoom : 1;
  return {
    x: coordinate(-viewport.x / zoom),
    y: coordinate(-viewport.y / zoom),
    width: coordinate(extent(surfaceSize.width) / zoom),
    height: coordinate(extent(surfaceSize.height) / zoom),
  };
}

export function computeMinimapLayout(
  rects: readonly Rect[],
  viewport: Viewport,
  surfaceSize: Size,
  mapSize: Size,
  padding = 10,
): MinimapLayout {
  const visible = viewportWorldRect(viewport, surfaceSize);
  let left = visible.x,
    top = visible.y;
  let right = left + visible.width,
    bottom = top + visible.height;
  for (const rect of rects) {
    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) continue;
    const x = coordinate(rect.x),
      y = coordinate(rect.y);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + extent(rect.width));
    bottom = Math.max(bottom, y + extent(rect.height));
  }

  const marginX = Math.max(1, (right - left) * 0.04);
  const marginY = Math.max(1, (bottom - top) * 0.04);
  const worldBounds = {
    x: left - marginX,
    y: top - marginY,
    width: right - left + 2 * marginX,
    height: bottom - top + 2 * marginY,
  };
  const width = Math.max(1, extent(mapSize.width));
  const height = Math.max(1, extent(mapSize.height));
  const inset = Math.min(extent(padding), (Math.min(width, height) - 1) / 2);
  const scale = Math.min(
    (width - 2 * inset) / worldBounds.width,
    (height - 2 * inset) / worldBounds.height,
  );
  return {
    worldBounds,
    scale,
    width,
    height,
    offsetX: (width - worldBounds.width * scale) / 2 - worldBounds.x * scale,
    offsetY: (height - worldBounds.height * scale) / 2 - worldBounds.y * scale,
  };
}

export function worldRectToMinimap(rect: Rect, layout: MinimapLayout): Rect {
  return {
    x: rect.x * layout.scale + layout.offsetX,
    y: rect.y * layout.scale + layout.offsetY,
    width: rect.width * layout.scale,
    height: rect.height * layout.scale,
  };
}

export function minimapPointToViewport(
  point: Point,
  layout: MinimapLayout,
  viewport: Viewport,
  surfaceSize: Size,
): Viewport {
  const worldX = (point.x - layout.offsetX) / layout.scale;
  const worldY = (point.y - layout.offsetY) / layout.scale;
  return {
    x: surfaceSize.width / 2 - worldX * viewport.zoom,
    y: surfaceSize.height / 2 - worldY * viewport.zoom,
    zoom: viewport.zoom,
  };
}

export function shouldAutoExpandMinimap(
  rootBoardCount: number,
  surfaceSize: Size,
) {
  return (
    rootBoardCount >= 6 &&
    surfaceSize.width >= 1080 &&
    surfaceSize.height >= 540
  );
}
