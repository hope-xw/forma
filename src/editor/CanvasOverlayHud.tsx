import { useLayoutEffect, useRef } from "react";
import type { Rect, Viewport } from "../domain/geometry";

export interface CameraChannelLike {
  get(): Viewport;
  subscribeLive(
    listener: (state: { viewport: Viewport; interacting: boolean }) => void,
  ): () => void;
}

export interface HudSnapGuide {
  axis: "x" | "y";
  value: number;
  start?: number;
  end?: number;
  kind?: "edge" | "center" | "ruler";
}

export interface HudMeasureOverlay {
  selectionBox: Rect;
  hoverRect: Rect;
  inside: boolean;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  dx: number;
  dy: number;
}

type Size = Pick<Rect, "width" | "height">;

export interface CanvasOverlayHudProps {
  camera: CameraChannelLike;
  surfaceSize: Size;
  showPixelGrid: boolean;
  guides?: readonly HudSnapGuide[];
  measure?: HudMeasureOverlay | null;
}

function canvasColors(canvas: HTMLCanvasElement) {
  const style = getComputedStyle(canvas);
  const color = (token: string, fallback: string) =>
    style.getPropertyValue(token).trim() || fallback;
  return {
    grid: color("--hud-grid", "rgba(162, 168, 180, 0.28)"),
    red: color("--figma-red", "#f24822"),
    blue: color("--figma-blue", "#0d99ff"),
    purple: color("--figma-purple", "#9747ff"),
    frame: color("--minimap-frame", "#626873"),
    outline: color("--minimap-outline", "#949ba5"),
  };
}

interface CanvasFrame extends Size {
  ctx: CanvasRenderingContext2D;
  viewport: Viewport;
  dpr: number;
  colors: ReturnType<typeof canvasColors>;
}

/** Share the same physical-pixel sizing and live-camera cadence on both surfaces. */
export function useCameraCanvas(
  camera: CameraChannelLike,
  draw: (frame: CanvasFrame) => void,
  sizeHint?: Size,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painter = useRef(draw);
  const invalidate = useRef<(() => void) | null>(null);
  const hintWidth = sizeHint?.width ?? 0,
    hintHeight = sizeHint?.height ?? 0;
  useLayoutEffect(() => {
    painter.current = draw;
    invalidate.current?.();
  }, [draw]);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let viewport = camera.get();
    let width = canvas.clientWidth || hintWidth,
      height = canvas.clientHeight || hintHeight;
    let colors = canvasColors(canvas);
    let raf: number | null = null;

    function paint() {
      raf = null;
      if (!canvas || !ctx || width <= 0 || height <= 0) return;
      const ratio = window.devicePixelRatio;
      const dpr = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
      const pixelsX = Math.max(1, Math.round(width * dpr)),
        pixelsY = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pixelsX) canvas.width = pixelsX;
      if (canvas.height !== pixelsY) canvas.height = pixelsY;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, pixelsX / dpr, pixelsY / dpr);
      painter.current({ ctx, width, height, dpr, viewport, colors });
    }
    function schedule() {
      if (raf === null) raf = requestAnimationFrame(paint);
    }
    invalidate.current = schedule;
    const unsubscribe = camera.subscribeLive((state) => {
      viewport = state.viewport;
      schedule();
    });
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(([entry]) => {
            width = entry.contentRect.width;
            height = entry.contentRect.height;
            schedule();
          });
    const resizeWindow = () => {
      width = canvas.clientWidth || hintWidth;
      height = canvas.clientHeight || hintHeight;
      schedule();
    };
    if (resize) resize.observe(canvas);
    else window.addEventListener("resize", resizeWindow);
    const theme = new MutationObserver(() => {
      colors = canvasColors(canvas);
      schedule();
    });
    const themeRoot =
      canvas.closest("[data-theme]") ?? document.documentElement;
    theme.observe(themeRoot, { attributeFilter: ["data-theme"] });
    if (themeRoot !== document.documentElement)
      theme.observe(document.documentElement, {
        attributeFilter: ["data-theme"],
      });
    // Moving a window between displays can change DPR without changing its CSS size.
    let resolution = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`,
    );
    function updateResolution() {
      resolution.removeEventListener("change", updateResolution);
      resolution = window.matchMedia(
        `(resolution: ${window.devicePixelRatio}dppx)`,
      );
      resolution.addEventListener("change", updateResolution);
      schedule();
    }
    resolution.addEventListener("change", updateResolution);
    paint();
    return () => {
      invalidate.current = null;
      unsubscribe();
      resize?.disconnect();
      window.removeEventListener("resize", resizeWindow);
      theme.disconnect();
      resolution.removeEventListener("change", updateResolution);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [camera, hintWidth, hintHeight]);
  return { canvasRef, invalidate };
}

function hairline(value: number, dpr: number) {
  return (Math.floor(value * dpr) + 0.5) / dpr;
}

function drawGrid({ ctx, width, height, viewport, dpr, colors }: CanvasFrame) {
  const { zoom } = viewport;
  if (!Number.isFinite(zoom) || zoom <= 0) return;
  // Below 400%, sample multiples of eight world pixels, keeping at least 8 CSS px of air.
  const step = zoom >= 4 ? zoom : zoom * 8 * Math.max(1, Math.ceil(1 / zoom));
  ctx.strokeStyle = colors.grid;
  ctx.beginPath();
  for (let x = viewport.x % step; x < width; x += step) {
    const center = hairline(x, dpr);
    ctx.moveTo(center, 0);
    ctx.lineTo(center, height);
  }
  for (let y = viewport.y % step; y < height; y += step) {
    const center = hairline(y, dpr);
    ctx.moveTo(0, center);
    ctx.lineTo(width, center);
  }
  ctx.stroke();
}

function drawRule(
  frame: CanvasFrame,
  vertical: boolean,
  at: number,
  start: number,
  end: number,
  caps: boolean,
  dashed = false,
) {
  const { ctx, dpr } = frame;
  const center = hairline(at, dpr);
  const from = hairline(start, dpr),
    to = hairline(end, dpr);
  const segment = (
    along1: number,
    across1: number,
    along2: number,
    across2: number,
  ) => {
    ctx.moveTo(vertical ? across1 : along1, vertical ? along1 : across1);
    ctx.lineTo(vertical ? across2 : along2, vertical ? along2 : across2);
  };
  if (dashed) ctx.setLineDash([3, 3]);
  ctx.beginPath();
  segment(from, center, to, center);
  ctx.stroke();
  if (dashed) ctx.setLineDash([]);
  if (caps) {
    ctx.beginPath();
    segment(from, center - 2.5, from, center + 2.5);
    segment(to, center - 2.5, to, center + 2.5);
    ctx.stroke();
  }
}

function drawGuide(frame: CanvasFrame, guide: HudSnapGuide) {
  const { viewport, width, height, ctx, colors } = frame;
  const vertical = guide.axis === "x";
  const at = viewport[guide.axis] + guide.value * viewport.zoom;
  const origin = vertical ? viewport.y : viewport.x;
  const limit = vertical ? height : width;
  const bounded =
    guide.kind !== "ruler" &&
    guide.start !== undefined &&
    guide.end !== undefined;
  const start = bounded ? origin + guide.start! * viewport.zoom : 0;
  const end = bounded ? origin + guide.end! * viewport.zoom : limit;
  const low = Math.max(0, Math.min(start, end)),
    high = Math.min(limit, Math.max(start, end));
  if (at < 0 || at >= (vertical ? width : height) || low > high) return;
  drawRule(frame, vertical, at, start, end, bounded);
  const along = bounded ? (low + high) / 2 : 6;
  const label = Number(guide.value.toFixed(2)) + " px";
  ctx.font = "600 10px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const w = Math.ceil(ctx.measureText(label).width) + 10,
    h = 16;
  const x = Math.max(1, Math.min(width - w - 1, vertical ? at + 4 : along));
  const y = Math.max(1, Math.min(height - h - 1, vertical ? along : at + 4));
  ctx.fillStyle = colors.red;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4);
  ctx.fill();
  ctx.fillStyle = "#170e0a";
  ctx.fillText(label, x + 5, y + h / 2);
}

function drawMeasure(frame: CanvasFrame, measure: HudMeasureOverlay) {
  const { viewport } = frame;
  const a = measure.selectionBox,
    b = measure.hoverRect;
  const right = a.x + a.width,
    bottom = a.y + a.height;
  const bx = b.x + b.width,
    by = b.y + b.height;
  const cx = a.x + a.width / 2,
    cy = a.y + a.height / 2;
  function ruler(
    vertical: boolean,
    at: number,
    start: number,
    end: number,
    caps = true,
  ) {
    if (start === end) return;
    const axis = vertical ? viewport.x : viewport.y;
    const origin = vertical ? viewport.y : viewport.x;
    drawRule(
      frame,
      vertical,
      axis + at * viewport.zoom,
      origin + start * viewport.zoom,
      origin + end * viewport.zoom,
      caps,
      true,
    );
  }
  if (measure.inside) {
    if ((measure.left ?? a.x - b.x) > 0) ruler(false, cy, b.x, a.x);
    if ((measure.right ?? bx - right) > 0) ruler(false, cy, right, bx);
    if ((measure.top ?? a.y - b.y) > 0) ruler(true, cx, b.y, a.y);
    if ((measure.bottom ?? by - bottom) > 0) ruler(true, cx, bottom, by);
    return;
  }
  if (measure.dx > 0) {
    const edge = b.x >= right ? b.x : bx;
    ruler(false, cy, b.x >= right ? right : a.x, edge);
    ruler(true, edge, cy, Math.max(b.y, Math.min(by, cy)), false);
  }
  if (measure.dy > 0) {
    const edge = b.y >= bottom ? b.y : by;
    ruler(true, cx, b.y >= bottom ? bottom : a.y, edge);
    ruler(false, edge, cx, Math.max(b.x, Math.min(bx, cx)), false);
  }
}

export function CanvasOverlayHud({
  camera,
  surfaceSize,
  showPixelGrid,
  guides = [],
  measure,
}: CanvasOverlayHudProps) {
  const { canvasRef } = useCameraCanvas(
    camera,
    (frame) => {
      frame.ctx.lineWidth = 1 / frame.dpr;
      if (showPixelGrid || frame.viewport.zoom >= 4) drawGrid(frame);
      frame.ctx.strokeStyle = frame.colors.red;
      if (measure) drawMeasure(frame, measure);
      for (const guide of guides) drawGuide(frame, guide);
    },
    surfaceSize,
  );
  return (
    <canvas ref={canvasRef} className="canvas-overlay-hud" aria-hidden="true" />
  );
}
