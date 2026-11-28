import { Maximize, X } from "lucide-react";
import { useMemo, useRef, type PointerEvent } from "react";
import {
  computeMinimapLayout,
  minimapPointToViewport,
  viewportWorldRect,
  worldRectToMinimap,
  type MinimapLayout,
  type MinimapNodeSummary,
} from "../application/minimap-layout";
import {
  contains,
  type Point,
  type Rect,
  type Viewport,
} from "../domain/geometry";
import { useCameraCanvas, type CameraChannelLike } from "./CanvasOverlayHud";

export interface CanvasMinimapProps {
  camera: CameraChannelLike;
  viewport: Viewport;
  surfaceSize: { width: number; height: number };
  items: readonly MinimapNodeSummary[];
  expanded: boolean;
  onNavigate(next: Viewport): void;
  onToggleExpanded(): void;
  onFitAll(): void;
}

const MAP_SIZE = { width: 184, height: 118 };

/** The minimum-size viewport marker is centered on the true viewport. */
export function minimapViewBox(view: Rect): Rect {
  const width = Math.max(10, view.width),
    height = Math.max(8, view.height);
  return {
    x: view.x + (view.width - width) / 2,
    y: view.y + (view.height - height) / 2,
    width,
    height,
  };
}

export function minimapGrabOffset(
  point: Point,
  paintedBox: Rect,
  liveBox = paintedBox,
): Point | null {
  return contains(paintedBox, point)
    ? {
        x: point.x - (liveBox.x + liveBox.width / 2),
        y: point.y - (liveBox.y + liveBox.height / 2),
      }
    : null;
}

export function panMinimapWithKey(
  key: string,
  shift: boolean,
  viewport: Viewport,
  surface: Pick<Rect, "width" | "height">,
): Viewport | null {
  const fraction = shift ? 0.5 : 0.2;
  switch (key) {
    case "ArrowLeft":
      return { ...viewport, x: viewport.x + surface.width * fraction };
    case "ArrowRight":
      return { ...viewport, x: viewport.x - surface.width * fraction };
    case "ArrowUp":
      return { ...viewport, y: viewport.y + surface.height * fraction };
    case "ArrowDown":
      return { ...viewport, y: viewport.y - surface.height * fraction };
    default:
      return null;
  }
}

export function CanvasMinimap(props: CanvasMinimapProps) {
  return props.expanded ? <ExpandedMinimap {...props} /> : null;
}

function ExpandedMinimap({
  camera,
  viewport,
  surfaceSize,
  items,
  onNavigate,
  onToggleExpanded,
  onFitAll,
}: CanvasMinimapProps) {
  const rects = useMemo(() => items.map((item) => item.rect), [items]);
  const boardCount = useMemo(
    () => items.filter((item) => item.kind === "frame").length,
    [items],
  );
  const displayed = useRef<{ layout: MinimapLayout; viewBox: Rect } | null>(
    null,
  );
  // Keep the displayed coordinate system fixed until release, even if the
  // navigated viewport extends the document's previous bounds.
  const drag = useRef<{
    id: number;
    layout: MinimapLayout;
    offset: Point;
  } | null>(null);
  const { canvasRef, invalidate } = useCameraCanvas(
    camera,
    ({ ctx, width, height, dpr, colors, viewport: live }) => {
      const held = drag.current?.layout;
      const layout =
        held && held.width === width && held.height === height
          ? held
          : computeMinimapLayout(rects, live, surfaceSize, { width, height });
      if (drag.current) drag.current.layout = layout;
      ctx.lineWidth = 1 / dpr;
      for (const item of items) {
        const r = worldRectToMinimap(item.rect, layout);
        const w = Math.max(1, r.width),
          h = Math.max(1, r.height);
        if (item.kind === "section") {
          ctx.setLineDash([3, 2]);
        } else {
          ctx.fillStyle = colors.frame;
          if (item.fill) ctx.fillStyle = item.fill;
          ctx.fillRect(r.x, r.y, w, h);
        }
        ctx.strokeStyle =
          item.kind === "component" ? colors.purple : colors.outline;
        ctx.strokeRect(r.x, r.y, w, h);
        if (item.kind === "section") ctx.setLineDash([]);
      }
      ctx.strokeStyle = colors.blue;
      ctx.lineWidth = 1.5;
      for (const item of items) {
        if (!item.selected) continue;
        const r = worldRectToMinimap(item.rect, layout);
        ctx.strokeRect(r.x, r.y, Math.max(1, r.width), Math.max(1, r.height));
      }
      const view = worldRectToMinimap(
        viewportWorldRect(live, surfaceSize),
        layout,
      );
      const viewBox = minimapViewBox(view);
      displayed.current = { layout, viewBox };
      const { x, y, width: w, height: h } = viewBox;
      ctx.fillStyle = colors.blue;
      ctx.globalAlpha = 0.16;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeRect(x, y, w, h);
    },
  );

  function mapPoint(
    event: PointerEvent<HTMLCanvasElement>,
    layout: MinimapLayout,
  ) {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    return {
      x:
        Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) *
        layout.width,
      y:
        Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) *
        layout.height,
    };
  }
  function end(event: PointerEvent<HTMLCanvasElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    invalidate.current?.();
  }
  return (
    <div
      className="canvas-minimap"
      data-testid="canvas-minimap"
      role="group"
      aria-label="小地图"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onPointerCancel={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="canvas-minimap-header">
        <strong>小地图</strong>
        <span className="canvas-minimap-count">{boardCount} 画板</span>
        <button
          type="button"
          className="icon-btn"
          aria-label="适应全部"
          data-tip="适应全部"
          data-tip-kbd="⇧1"
          onClick={onFitAll}
        >
          <Maximize size={12} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="收起小地图"
          data-tip="收起小地图"
          data-tip-kbd="⇧M"
          onClick={onToggleExpanded}
        >
          <X size={13} />
        </button>
      </div>
      <canvas
        ref={canvasRef}
        aria-label="当前页画布缩略图，可使用方向键平移画布或按 0 适应全部"
        role="application"
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            event.altKey ||
            event.metaKey ||
            event.ctrlKey ||
            event.nativeEvent.isComposing
          )
            return;
          const next = panMinimapWithKey(
            event.key,
            event.shiftKey,
            camera.get(),
            surfaceSize,
          );
          if (next) onNavigate(next);
          else if (event.key === "0" || event.key === "Enter") onFitAll();
          else if (event.key === "Escape") event.currentTarget.blur();
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return;
          const layout =
            displayed.current?.layout ??
            computeMinimapLayout(rects, viewport, surfaceSize, MAP_SIZE);
          const point = mapPoint(event, layout);
          if (!point) return;
          const live = camera.get();
          const liveBox = minimapViewBox(
            worldRectToMinimap(viewportWorldRect(live, surfaceSize), layout),
          );
          // Hit-test what was painted, but keep any newer camera input when starting the drag.
          const offset = minimapGrabOffset(
            point,
            displayed.current?.viewBox ?? liveBox,
            liveBox,
          );
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            id: event.pointerId,
            layout,
            offset: offset ?? { x: 0, y: 0 },
          };
          if (!offset)
            onNavigate(
              minimapPointToViewport(point, layout, live, surfaceSize),
            );
        }}
        onPointerMove={(event) => {
          const held = drag.current;
          if (held?.id !== event.pointerId) return;
          const point = mapPoint(event, held.layout);
          if (point)
            onNavigate(
              minimapPointToViewport(
                { x: point.x - held.offset.x, y: point.y - held.offset.y },
                held.layout,
                camera.get(),
                surfaceSize,
              ),
            );
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onDoubleClick={onFitAll}
      />
    </div>
  );
}
