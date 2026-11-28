import { maxLayerDimension } from "./document-limits";
import { childrenOf, isPublished, positionDelta } from "./scene-index";
import { resolvedDocument } from "./design-system";
import { sizeScene, flowInsets, wraps, rowLines, gridMetrics } from "./sizing";
import type { DesignDocument } from "./document";
export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point {
  width: number;
  height: number;
}
export interface Viewport extends Point {
  zoom: number;
}
export const MIN_ZOOM = 0.02,
  MAX_ZOOM = 64;
export function union(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x)),
    y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}
export function contains(r: Rect, p: Point) {
  return (
    p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
  );
}
export function intersects(a: Rect, b: Rect) {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  );
}
export function screenToWorld(p: Point, v: Viewport): Point {
  return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
}
export function zoomAt(v: Viewport, zoom: number, anchor: Point): Viewport {
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  const world = screenToWorld(anchor, v);
  return { zoom, x: anchor.x - world.x * zoom, y: anchor.y - world.y * zoom };
}
export function fitViewport(
  rect: Rect,
  size: { width: number; height: number },
): Viewport {
  const zoom = Math.min(
    2,
    Math.max(
      MIN_ZOOM,
      Math.min(
        (size.width - 96) / Math.max(1, rect.width),
        (size.height - 120) / Math.max(1, rect.height),
      ),
    ),
  );
  return {
    zoom,
    x: (size.width - rect.width * zoom) / 2 - rect.x * zoom,
    y: (size.height - rect.height * zoom) / 2 - rect.y * zoom,
  };
}
class OverlayRectMap extends Map<string, Rect> {
  private base: Map<string, Rect>;
  private overrides: Map<string, Rect>;
  readonly depth: number;
  constructor(base: Map<string, Rect>, overrides: Map<string, Rect>) {
    super();
    this.base = base;
    this.overrides = overrides;
    this.depth = base instanceof OverlayRectMap ? base.depth + 1 : 1;
  }
  override get(key: string): Rect | undefined {
    return this.overrides.get(key) ?? this.base.get(key);
  }
  override has(key: string): boolean {
    return this.overrides.has(key) || this.base.has(key);
  }
  override get size(): number {
    return this.base.size;
  }
  override *[Symbol.iterator](): MapIterator<[string, Rect]> {
    for (const [k, v] of this.base) {
      yield [k, this.overrides.get(k) ?? v];
    }
  }
}
const geometryCache = new WeakMap<DesignDocument, Map<string, Rect>>();
/** World coordinates shared by hit testing, clipboard, hierarchy and inspector. */
export function layoutBounds(doc: DesignDocument): Map<string, Rect> {
  const original = doc,
    cached = geometryCache.get(doc);
  if (cached) return cached;
  const delta = positionDelta(doc);
  if (delta) {
    const baseBounds = geometryCache.get(delta.base);
    if (baseBounds) {
      let hasTranslation = false;
      for (const move of delta.moved.values()) {
        if (move.dx !== 0 || move.dy !== 0) {
          hasTranslation = true;
          break;
        }
      }
      if (!hasTranslation) {
        if (isPublished(original)) geometryCache.set(original, baseBounds);
        return baseBounds;
      }
      const useOverlay =
        baseBounds.size > 200 &&
        (!(baseBounds instanceof OverlayRectMap) || baseBounds.depth < 8);
      const target = useOverlay ? new Map<string, Rect>() : new Map(baseBounds);
      const shiftSubtree = (id: string, dx: number, dy: number) => {
        const prev = baseBounds.get(id);
        if (prev) target.set(id, { ...prev, x: prev.x + dx, y: prev.y + dy });
        for (const child of childrenOf(original, id)) {
          shiftSubtree(child.id, dx, dy);
        }
      };
      for (const [id, move] of delta.moved) {
        if (move.dx !== 0 || move.dy !== 0) shiftSubtree(id, move.dx, move.dy);
      }
      const output = useOverlay
        ? new OverlayRectMap(baseBounds, target)
        : target;
      if (isPublished(original)) geometryCache.set(original, output);
      return output;
    }
  }
  doc = sizeScene(resolvedDocument(doc));
  const output = new Map<string, Rect>();
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const offset = (space: number, alignment: string | undefined) =>
    alignment === "end" ? space : alignment === "center" ? space / 2 : 0;
  const children = new Map<string | null, typeof doc.nodes>();
  for (const n of doc.nodes) {
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  function visit(parentId: string | null, origin: Point) {
    const parent = byId.get(parentId ?? "");
    const layout = parent?.type === "frame" ? parent.style.layout : "free";
    const insets = flowInsets(parent);
    let cursor = layout === "row" ? insets.left : insets.top;
    const wrapped = new Map<string, Point>();
    if (parent && layout === "grid") {
      const grid = gridMetrics(
        parent,
        (children.get(parent.id) ?? []).filter((n) => !n.hidden),
      );
      for (const cell of grid.cells) {
        wrapped.set(cell.child.id, {
          x:
            origin.x +
            insets.left +
            cell.x +
            offset(cell.width - cell.child.style.width, parent.style.alignX),
          y:
            origin.y +
            insets.top +
            cell.y +
            offset(cell.height - cell.child.style.height, parent.style.alignY),
        });
      }
    }
    if (parent && wraps(parent)) {
      let top = insets.top;
      for (const line of rowLines(parent, children.get(parent.id) ?? [])) {
        const height = Math.max(...line.map((c) => c.style.height));
        const width =
          line.reduce((sum, c) => sum + c.style.width, 0) +
          (line.length - 1) * parent.style.gap;
        let left =
          insets.left +
          offset(
            parent.style.width - insets.left - insets.right - width,
            parent.style.alignX,
          );
        for (const child of line) {
          wrapped.set(child.id, {
            x: origin.x + left,
            y:
              origin.y +
              top +
              offset(height - child.style.height, parent.style.alignY),
          });
          left += child.style.width + parent.style.gap;
        }
        top += height + (parent.style.rowGap ?? parent.style.gap);
      }
    }
    if (parent && layout !== "free") {
      const row = layout === "row",
        visible = (children.get(parentId) ?? []).filter(
          (child) => !child.hidden,
        );
      const extent =
        visible.reduce(
          (sum, child) => sum + (row ? child.style.width : child.style.height),
          0,
        ) +
        Math.max(0, visible.length - 1) * parent.style.gap;
      cursor += offset(
        (row
          ? parent.style.width - insets.left - insets.right
          : parent.style.height - insets.top - insets.bottom) - extent,
        row ? parent.style.alignX : parent.style.alignY,
      );
    }
    for (const n of children.get(parentId) ?? []) {
      let x = origin.x + n.style.x,
        y = origin.y + n.style.y;
      if (layout === "row") {
        x = origin.x + cursor;
        y =
          origin.y +
          insets.top +
          offset(
            parent!.style.height - insets.top - insets.bottom - n.style.height,
            parent!.style.alignY,
          );
      }
      if (layout === "column") {
        y = origin.y + cursor;
        x =
          origin.x +
          insets.left +
          offset(
            parent!.style.width - insets.left - insets.right - n.style.width,
            parent!.style.alignX,
          );
      }
      const rect = {
        ...(wrapped.get(n.id) ?? { x, y }),
        width: n.style.width,
        height: n.style.height,
      };
      output.set(n.id, rect);
      visit(n.id, rect);
      if (!n.hidden && layout !== "free")
        cursor +=
          (layout === "row" ? n.style.width : n.style.height) +
          parent!.style.gap;
    }
  }
  visit(null, { x: 0, y: 0 });
  if (isPublished(original)) geometryCache.set(original, output);
  return output;
}
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export function resizeRect(
  start: Rect,
  handle: Handle,
  delta: Point,
  ratio = false,
  center = false,
): Rect {
  const sx = handle.includes("w") ? -1 : handle.includes("e") ? 1 : 0,
    sy = handle.includes("n") ? -1 : handle.includes("s") ? 1 : 0;
  let width = Math.max(
      Math.min(1, start.width),
      start.width + sx * delta.x * (center ? 2 : 1),
    ),
    height = Math.max(
      Math.min(1, start.height),
      start.height + sy * delta.y * (center ? 2 : 1),
    );
  if (ratio && start.width > 0 && start.height > 0) {
    if (sx && sy) {
      const chosen =
        Math.abs(width - start.width) / start.width >
        Math.abs(height - start.height) / start.height
          ? width / start.width
          : height / start.height;
      width = start.width * chosen;
      height = start.height * chosen;
    } else if (sx) height = (start.height * width) / start.width;
    else width = (start.width * height) / start.height;
  }
  width = Math.min(maxLayerDimension, width);
  height = Math.min(maxLayerDimension, height);
  return {
    x: center
      ? start.x + (start.width - width) / 2
      : sx < 0
        ? start.x + start.width - width
        : start.x,
    y: center
      ? start.y + (start.height - height) / 2
      : sy < 0
        ? start.y + start.height - height
        : start.y,
    width,
    height,
  };
}
export interface SnapGuide {
  axis: "x" | "y";
  value: number;
  start?: number;
  end?: number;
  kind?: "edge" | "center" | "ruler";
}
type SnapSource =
  { kind: "ruler" } | { kind: "edge" | "center"; start: number; end: number };
export interface SnapIndex {
  x: number[];
  y: number[];
  spans?: Record<SnapGuide["axis"], Record<number, SnapSource>>;
}
export function createSnapIndex(
  targets: readonly Rect[],
  pageGuides: readonly SnapGuide[] = [],
): SnapIndex {
  const spans: NonNullable<SnapIndex["spans"]> = { x: {}, y: {} };
  function record(
    axis: SnapGuide["axis"],
    value: number,
    start: number,
    end: number,
    kind: "edge" | "center",
  ) {
    const previous = spans[axis][value];
    if (previous?.kind === "ruler") return;
    // Collinear objects share one segment. A coincident edge takes precedence over a center.
    spans[axis][value] = previous
      ? {
          kind: previous.kind === "edge" ? "edge" : kind,
          start: Math.min(previous.start, start),
          end: Math.max(previous.end, end),
        }
      : { kind, start, end };
  }
  for (const { axis, value } of pageGuides)
    spans[axis][value] = { kind: "ruler" };
  for (const { x, y, width, height } of targets) {
    const right = x + width,
      bottom = y + height;
    record("x", x, y, bottom, "edge");
    record("x", x + width / 2, y, bottom, "center");
    record("x", right, y, bottom, "edge");
    record("y", y, x, right, "edge");
    record("y", y + height / 2, x, right, "center");
    record("y", bottom, x, right, "edge");
  }
  const sorted = (sources: Record<number, SnapSource>) =>
    Object.keys(sources)
      .map(Number)
      .sort((a, b) => a - b);
  return { x: sorted(spans.x), y: sorted(spans.y), spans };
}
function nearestInSorted(sorted: readonly number[], target: number) {
  let lo = 0,
    hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const val = sorted[mid];
    if (val === target) return val;
    if (val < target) lo = mid + 1;
    else hi = mid - 1;
  }
  const left = hi >= 0 ? sorted[hi] : undefined;
  const right = lo < sorted.length ? sorted[lo] : undefined;
  if (left === undefined) return right;
  if (right === undefined) return left;
  return target - left <= right - target ? left : right;
}
export function snapMoveIndexed(
  rect: Rect,
  index: SnapIndex,
  threshold: number,
): { dx: number; dy: number; guides: SnapGuide[] } {
  const guides: SnapGuide[] = [];
  let dx = 0,
    dy = 0;
  for (const axis of ["x", "y"] as const) {
    const sorted = index[axis];
    if (!sorted.length) continue;
    const size = axis === "x" ? "width" : "height";
    const edges = [
      rect[axis],
      rect[axis] + rect[size] / 2,
      rect[axis] + rect[size],
    ];
    let best = threshold;
    let offset = 0;
    let guide: number | undefined;
    for (const edge of edges) {
      const value = nearestInSorted(sorted, edge);
      if (value === undefined) continue;
      const difference = value - edge;
      const dist = Math.abs(difference);
      if (dist < best) {
        best = dist;
        offset = difference;
        guide = value;
      }
    }
    if (guide !== undefined) guides.push({ axis, value: guide });
    if (axis === "x") dx = offset;
    else dy = offset;
  }
  for (const guide of guides) {
    const source = index.spans?.[guide.axis][guide.value];
    if (!source) continue;
    guide.kind = source.kind;
    if (source.kind === "ruler") continue;
    const vertical = guide.axis === "x";
    const start = vertical ? rect.y + dy : rect.x + dx;
    guide.start = Math.min(start, source.start);
    guide.end = Math.max(
      start + (vertical ? rect.height : rect.width),
      source.end,
    );
  }
  return { dx, dy, guides };
}
export function snapMove(
  rect: Rect,
  targets: Rect[],
  threshold: number,
  pageGuides: readonly { axis: "x" | "y"; value: number }[] = [],
): { dx: number; dy: number; guides: { axis: "x" | "y"; value: number }[] } {
  const guides: { axis: "x" | "y"; value: number }[] = [];
  let dx = 0,
    dy = 0;
  for (const axis of ["x", "y"] as const) {
    const size = axis === "x" ? "width" : "height";
    const edges = [
      rect[axis],
      rect[axis] + rect[size] / 2,
      rect[axis] + rect[size],
    ];
    let best = threshold;
    let offset = 0;
    let guide: number | undefined;
    const inspect = (value: number) => {
      for (const edge of edges) {
        const difference = value - edge;
        if (Math.abs(difference) < best) {
          best = Math.abs(difference);
          offset = difference;
          guide = value;
        }
      }
    };
    for (const item of pageGuides) if (item.axis === axis) inspect(item.value);
    for (const target of targets) {
      inspect(target[axis]);
      inspect(target[axis] + target[size] / 2);
      inspect(target[axis] + target[size]);
    }
    if (guide !== undefined) guides.push({ axis, value: guide });
    if (axis === "x") dx = offset;
    else dy = offset;
  }
  return { dx, dy, guides };
}
