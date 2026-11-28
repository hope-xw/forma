import { Fragment, useMemo, useState } from "react";
import {
  computeGapDrag,
  computePaddingDrag,
  getAutoLayoutHandleSpecs,
  getNodeInsets,
  type PaddingHandleSpec,
  type GapHandleSpec,
  type PaddingSide,
} from "../application/canvas-handles";
import { resolveNode } from "../domain/design-system";
import { findLayer } from "../domain/scene-index";
import type { DesignNode } from "../domain/document";
import type { Point, Rect } from "../domain/geometry";
import type { Matrix } from "../domain/transforms";
import { arrowIncrement, useCanvasHandleDrag } from "./CornerRadiusHandles";
import type { EditorController } from "./useEditor";

export interface AutoLayoutHandlesProps {
  editor: EditorController;
  node: DesignNode;
  box: Rect;
  bounds: Map<string, Rect>;
  matrix: Matrix;
  zoom: number;
  onDragActiveChange?(active: boolean): void;
}
type Handle = PaddingHandleSpec | GapHandleSpec;
const sideNames: Record<PaddingSide, string> = {
  top: "上",
  right: "右",
  bottom: "下",
  left: "左",
};
const handleId = (s: Handle) =>
  "side" in s ? "padding-" + s.side : "gap-" + s.index;

function spacingChange(
  raw: DesignNode,
  node: DesignNode,
  spec: Handle,
  delta: number,
  alt: boolean,
  shift: boolean,
  snapStep = 1,
) {
  if ("side" in spec) {
    const initialInsets = getNodeInsets(node);
    const next = computePaddingDrag({
      node: raw,
      side: spec.side,
      initialInsets,
      inwardDelta: delta,
      symmetric: alt,
      allSides: alt && shift,
      snapStep,
    });
    const prefix =
      alt && shift
        ? "四边 "
        : alt
          ? spec.orientation === "horizontal"
            ? "上下 "
            : "左右 "
          : "";
    return {
      label: prefix + next.value,
      affectedSides: next.affectedSides,
      operations: next.affectedSides.some(
        (side) => next.insets[side] !== initialInsets[side],
      )
        ? next.operations
        : [],
    };
  }
  const next = computeGapDrag({
    node,
    initialGap: node.style.gap,
    delta,
    snapStep,
  });
  return {
    label: "间距 " + next.value,
    operations: next.value !== node.style.gap ? next.operations : [],
  };
}
function inwardDelta(spec: Handle, delta: Point) {
  if ("axis" in spec) return delta[spec.axis];
  switch (spec.side) {
    case "left":
      return delta.x;
    case "right":
      return -delta.x;
    case "top":
      return delta.y;
    case "bottom":
      return -delta.y;
  }
}
function screenRect(rect: Rect, zoom: number) {
  return {
    left: rect.x * zoom,
    top: rect.y * zoom,
    width: rect.width * zoom,
    height: rect.height * zoom,
  };
}
type HitBox = ReturnType<typeof screenRect>;
const isHorizontal = (spec: Handle) =>
  "side" in spec ? spec.orientation === "horizontal" : spec.axis === "y";

/** Leave the resize edges and a 20px square around the selection center free. */
function spacingHitBox(spec: Handle, box: Rect, zoom: number) {
  const horizontal = isHorizontal(spec);
  const length = (horizontal ? box.width : box.height) * zoom;
  const breadth = (horizontal ? box.height : box.width) * zoom;
  const along = (horizontal ? spec.handlePoint.x : spec.handlePoint.y) * zoom;
  const across = (horizontal ? spec.handlePoint.y : spec.handlePoint.x) * zoom;
  if (Math.min(length, breadth) < 32) return null;
  const edge = 5;
  const thickness = Math.min(12, breadth / 2 - edge);
  const span = Math.min(28, length - 2 * edge);
  const clamp = (n: number, low: number, high: number) =>
    Math.max(low, Math.min(high, n));
  let min = edge,
    max = breadth - edge - thickness;
  if ("side" in spec) {
    if (spec.side === "top" || spec.side === "left")
      max = breadth / 2 - thickness;
    else min = breadth / 2;
  } else if (across < 0 || across > breadth || along < 0 || along > length)
    return null;
  const cross = clamp(across - thickness / 2, min, max);
  let start = clamp(along - span / 2, edge, length - edge - span);
  if (
    cross < breadth / 2 + 10 &&
    cross + thickness > breadth / 2 - 10 &&
    start < length / 2 + 10 &&
    start + span > length / 2 - 10
  ) {
    // Slide along the highlighted band when its midpoint is the move target.
    const before = length / 2 - 10 - span,
      after = length / 2 + 10;
    start = along <= length / 2 ? before : after;
    if (start < edge || start + span > length - edge) return null;
    if ("axis" in spec) {
      const band = screenRect(spec.bandRect, zoom);
      const origin = horizontal ? band.left : band.top;
      const end = origin + (horizontal ? band.width : band.height);
      if (start + span / 2 < origin || start + span / 2 > end) return null;
    }
  }
  return horizontal
    ? { left: start, top: cross, width: span, height: thickness }
    : { left: cross, top: start, width: thickness, height: span };
}

function spacingHitBoxes(
  paddings: PaddingHandleSpec[],
  gaps: GapHandleSpec[],
  box: Rect,
  zoom: number,
) {
  const visible = new Map<string, HitBox>();
  function reserve(spec: Handle, hit: HitBox) {
    for (const other of visible.values()) {
      if (
        hit.left < other.left + other.width &&
        other.left < hit.left + hit.width &&
        hit.top < other.top + other.height &&
        other.top < hit.top + hit.height
      )
        return;
    }
    visible.set(handleId(spec), hit);
  }
  for (const spec of paddings) {
    const hit = spacingHitBox(spec, box, zoom);
    if (hit) reserve(spec, hit);
  }
  for (const spec of gaps) {
    const hit = spacingHitBox(spec, box, zoom);
    if (!hit) continue;
    const row = spec.axis === "x";
    const start = row ? "top" : "left",
      span = row ? "height" : "width";
    const near = visible.get(row ? "padding-top" : "padding-left");
    const far = visible.get(row ? "padding-bottom" : "padding-right");
    const end = Math.min(
      hit[start] + hit[span],
      far ? far[start] - 2 : Infinity,
    );
    if (near) hit[start] = Math.max(hit[start], near[start] + near[span] + 2);
    hit[span] = end - hit[start];
    if (hit[span] >= 10) reserve(spec, hit);
  }
  return visible;
}

export function AutoLayoutHandles({
  editor: e,
  node: selected,
  box,
  bounds,
  zoom,
  onDragActiveChange,
}: AutoLayoutHandlesProps) {
  const drag = useCanvasHandleDrag<Handle>(
    e,
    selected.id,
    zoom,
    onDragActiveChange,
  );
  const [hover, setHover] = useState<string | null>(null);
  const raw = findLayer(e.committed, selected.id);
  const node = raw && resolveNode(e.committed, raw);
  const foreignPreview =
    e.doc !== e.committed && drag.active?.preview !== e.doc;
  const display = drag.active?.preview ?? e.committed;
  const displayBounds = display === e.committed ? drag.bounds : bounds;
  const { paddings, gaps } = useMemo(() => {
    const shown = !foreignPreview && findLayer(display, selected.id);
    return shown
      ? getAutoLayoutHandleSpecs(
          display,
          resolveNode(display, shown),
          displayBounds,
          zoom,
        )
      : { paddings: [], gaps: [] };
  }, [foreignPreview, display, selected.id, displayBounds, zoom]);
  const hits = useMemo(
    () => spacingHitBoxes(paddings, gaps, box, zoom),
    [paddings, gaps, box, zoom],
  );
  if (!raw || !node || foreignPreview) return null;
  const held = drag.active?.target;
  // Growing the gap can put each child on its own line. Keep the capturing button
  // mounted so the pointer can still shrink the gap again or finish the gesture.
  const activeId = held ? handleId(held) : hover;
  const handles: Handle[] = [...paddings, ...gaps];
  const missing =
    held && !handles.some((spec) => handleId(spec) === activeId)
      ? held
      : undefined;
  if (missing) handles.push(missing);
  return (
    <>
      {handles.map((spec) => {
        const id = handleId(spec);
        const padding = "side" in spec;
        const kind = padding ? "padding" : "gap";
        const horizontal = isHorizontal(spec);
        const lit = padding
          ? (drag.active?.affectedSides?.includes(spec.side) ?? activeId === id)
          : spec !== missing && activeId?.startsWith("gap-");
        const label = padding ? sideNames[spec.side] + "内边距" : "子项间距";
        const band = screenRect(spec.bandRect, zoom);
        // The coloured band shows the actual dimension, even at zero. The independent
        // hit area stays reachable inside the selection, clear of the outer resize edge.
        const hit = hits.get(id);
        // Keep a captured target mounted through reflow, even when its grip no longer fits.
        if (!hit && (!held || handleId(held) !== id)) return null;
        const point = hit
          ? { x: hit.left + hit.width / 2, y: hit.top + hit.height / 2 }
          : { x: spec.handlePoint.x * zoom, y: spec.handlePoint.y * zoom };
        return (
          <Fragment key={id}>
            <span
              aria-hidden="true"
              className={
                "autolayout-" + kind + "-band" + (lit ? " is-active" : "")
              }
              style={band}
            />
            <button
              type="button"
              className={`autolayout-${kind}-zone autolayout-${kind}-handle${lit ? " is-active" : ""}`}
              data-testid={"autolayout-" + id}
              aria-label={
                padding
                  ? `画布${label}手柄`
                  : `画布子项间距手柄 ${spec.index + 1}`
              }
              title={label}
              data-tip={label}
              data-tip-side="bottom"
              data-tip-desc={
                padding
                  ? "向内拖动增加内边距，⌥ 对称，⌥⇧ 四边同步"
                  : "沿布局方向拖动，所有子项间距同步调整"
              }
              data-tip-kbd="⇧ 4px"
              style={{
                ...(hit ?? { width: 0, height: 0 }),
                opacity: hit ? undefined : 0,
                pointerEvents: hit ? undefined : "none",
                cursor: horizontal ? "ns-resize" : "ew-resize",
              }}
              {...drag.events}
              onPointerEnter={() => setHover(id)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(id)}
              onBlur={() => {
                setHover(null);
                drag.events.onBlur();
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              onPointerDown={(event) =>
                drag.begin(event, spec, (delta, mods) =>
                  spacingChange(
                    raw,
                    node,
                    spec,
                    inwardDelta(spec, delta),
                    mods.altKey,
                    mods.shiftKey,
                    mods.shiftKey ? 4 : 1,
                  ),
                )
              }
              onKeyDown={(event) => {
                const step = arrowIncrement(event.key, event.shiftKey);
                if (!step) return;
                event.preventDefault();
                event.stopPropagation();
                if (drag.active) return;
                const next = spacingChange(
                  raw,
                  node,
                  spec,
                  step,
                  event.altKey,
                  event.shiftKey,
                );
                drag.commit(next.operations);
              }}
            >
              <span
                className={
                  "autolayout-handle-bar " +
                  (horizontal ? "horizontal" : "vertical")
                }
                aria-hidden="true"
              />
            </button>
            {held && activeId === id && (
              <span
                className="autolayout-spacing-badge"
                data-testid="autolayout-spacing-badge"
                style={{ left: point.x + 10, top: point.y + 10 }}
              >
                {drag.active?.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
