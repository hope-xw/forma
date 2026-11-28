import {
  boardBranchSignatureSteps,
  LruTileCache,
  LOD_MAX_TILE_EDGE,
} from "../application/board-lod";
import { rgba } from "../compiler/paints";
import { displayColor, displayNode } from "../domain/color-profile";
import { resolveNode } from "../domain/design-system";
import type { DesignDocument, DesignNode, NodeStyle } from "../domain/document";
import type { Rect } from "../domain/geometry";
import { imageExtent, type ImageFill, type ImageAsset } from "../domain/images";
import { linearGradientEndpoints } from "../domain/linear-gradient";
import {
  childrenOf,
  findLayer,
  indexPublishedScene,
} from "../domain/scene-index";
import { hasVisibleVectorStroke } from "../domain/vector-path";
import { symbolPaintForView } from "../domain/symbol-background";

type Context = CanvasRenderingContext2D;
export const MAX_CONCURRENT_IMAGE_DECODES = 4;
const thumbnails = new LruTileCache<HTMLCanvasElement>(
  64,
  12 * 1024 * 1024,
  (_key, canvas) => release(canvas),
);
const failedImages = new WeakSet<ImageAsset>();
type ImageReady = (thumbnail?: HTMLCanvasElement) => void;
interface Decode {
  id: string;
  asset: ImageAsset;
  waiters: Set<ImageReady>;
  image?: HTMLImageElement;
}
const decoding = new Map<string, Decode>();
const queued = new Set<Decode>();
let activeDecodes = 0;

export function boardImageCacheStats() {
  return { ...thumbnails.stats(), active: activeDecodes, queued: queued.size };
}

async function decodeThumbnail(task: Decode) {
  const image = new Image();
  task.image = image;
  let thumbnail: HTMLCanvasElement | undefined;
  try {
    image.decoding = "async";
    image.src = task.asset.data;
    await image.decode();
    if (!task.waiters.size) return;
    const w = image.naturalWidth,
      h = image.naturalHeight;
    const scale = Math.min(1, LOD_MAX_TILE_EDGE / Math.max(w, h));
    thumbnail = newCanvas(
      Math.max(1, Math.round(w * scale)),
      Math.max(1, Math.round(h * scale)),
    );
    const ctx = thumbnail.getContext("2d", { colorSpace: "display-p3" });
    if (!ctx) throw new Error("Canvas2D unavailable");
    ctx.drawImage(image, 0, 0, thumbnail.width, thumbnail.height);
    thumbnails.set(task.id, thumbnail, thumbnail.width * thumbnail.height * 4);
  } catch {
    if (thumbnail) release(thumbnail);
    thumbnail = undefined;
    if (task.waiters.size) failedImages.add(task.asset);
  } finally {
    image.removeAttribute("src");
    task.image = undefined;
    if (decoding.get(task.id) === task) decoding.delete(task.id);
    activeDecodes--;
    pumpDecodes();
  }
  // Consume the thumbnail before another decode can evict its surface.
  // The job resumes from this image in paint order; it never pins a batch of pixels.
  for (const notify of task.waiters) notify(thumbnail);
  task.waiters.clear();
}

function pumpDecodes() {
  while (activeDecodes < MAX_CONCURRENT_IMAGE_DECODES && queued.size) {
    const next = queued.values().next().value!;
    queued.delete(next);
    activeDecodes++;
    void decodeThumbnail(next);
  }
}

interface ImageStep {
  id: string;
  asset: ImageAsset;
  draw: (thumbnail: HTMLCanvasElement) => void;
}
type PaintStep = ImageStep | void;

function waitForThumbnail(step: ImageStep, resume: () => void) {
  let task = decoding.get(step.id);
  if (!task) {
    task = { id: step.id, asset: step.asset, waiters: new Set() };
    decoding.set(step.id, task);
    queued.add(task);
  }
  const notify: ImageReady = (thumbnail) => {
    if (thumbnail) step.draw(thumbnail);
    resume();
  };
  task.waiters.add(notify);
  pumpDecodes();
  return () => {
    if (!task.waiters.delete(notify) || task.waiters.size) return;
    queued.delete(task);
    decoding.delete(step.id);
    // An aborted decode occupies its slot until the browser settles its promise.
    task.image?.removeAttribute("src");
  };
}

function drawImageFill(
  ctx: Context,
  image: HTMLCanvasElement,
  fill: ImageFill,
  asset: ImageAsset,
  w: number,
  h: number,
  outline: Path2D,
) {
  const size = imageExtent(fill, asset, w, h);
  const x = ((w - size.width) * fill.x) / 100,
    y = ((h - size.height) * fill.y) / 100;
  ctx.save();
  ctx.clip(outline);
  ctx.globalAlpha *= fill.opacity ?? 1;
  if (fill.rotation) {
    ctx.translate(w / 2, h / 2);
    ctx.rotate((fill.rotation * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
  }
  if (fill.fit === "tile") {
    const pattern = ctx.createPattern(image, "repeat");
    if (pattern) {
      pattern.setTransform(
        new DOMMatrix()
          .translate(x, y)
          .scale(size.width / image.width, size.height / image.height),
      );
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, w, h);
    }
  } else ctx.drawImage(image, x, y, size.width, size.height);
  ctx.restore();
}

export function summaryFill(doc: DesignDocument, resolved: DesignNode) {
  const s = resolved.style;
  const token = resolved.fillToken && doc.tokens[resolved.fillToken];
  const paint = s.paints?.find((p) => p.visible && p.opacity > 0);
  const stop = (paint ? paint.gradient : s.gradient)?.stops[0];
  const fill = displayColor(
    stop?.color ?? paint?.color ?? (token ? token.value : s.fill),
    doc.colorProfile,
  );
  return rgba(
    fill,
    (s.opacity ?? 1) *
      (paint?.opacity ?? s.fillOpacity ?? 1) *
      (stop?.opacity ?? 1),
  );
}

function gradientFill(
  ctx: Context,
  g: NonNullable<NodeStyle["gradient"]>,
  w: number,
  h: number,
) {
  let brush: CanvasGradient;
  if (g.type === "linear") {
    const endpoints =
      g.linearProjection && linearGradientEndpoints(g.linearProjection);
    if (endpoints) {
      brush = ctx.createLinearGradient(
        endpoints.x1 * w,
        endpoints.y1 * h,
        endpoints.x2 * w,
        endpoints.y2 * h,
      );
    } else {
      const angle = (g.angle * Math.PI) / 180;
      const dx = Math.sin(angle),
        dy = -Math.cos(angle);
      const span = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
      brush = ctx.createLinearGradient(
        w / 2 - dx * span,
        h / 2 - dy * span,
        w / 2 + dx * span,
        h / 2 + dy * span,
      );
    }
  } else {
    brush = ctx.createRadialGradient(
      w / 2,
      h / 2,
      0,
      w / 2,
      h / 2,
      Math.hypot(w, h) / 2,
    );
  }
  for (const stop of g.stops)
    brush.addColorStop(stop.offset, rgba(stop.color, stop.opacity));
  return brush;
}

function outlinePath(node: DesignNode, w: number, h: number) {
  const path = new Path2D();
  const { radius, corners } = node.style;
  if (node.type === "ellipse")
    path.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else
    path.roundRect(
      0,
      0,
      w,
      h,
      corners ? [corners.tl, corners.tr, corners.br, corners.bl] : radius,
    );
  return path;
}

function* paintSurface(
  ctx: Context,
  doc: DesignDocument,
  node: DesignNode,
  w: number,
  h: number,
  outline: Path2D,
): Generator<PaintStep> {
  const s = node.style;
  const alpha = ctx.globalAlpha;
  const token = node.fillToken && doc.tokens[node.fillToken];
  if (
    node.type !== "text" &&
    node.type !== "vector" &&
    node.type !== "group" &&
    node.type !== "slice"
  ) {
    ctx.fillStyle = s.gradient
      ? gradientFill(ctx, s.gradient, w, h)
      : token
        ? displayColor(token.value, doc.colorProfile)
        : s.fill;
    ctx.globalAlpha = alpha * (s.fillOpacity ?? 1);
    ctx.fill(outline);
    for (let i = (s.paints?.length ?? 0) - 1; i >= 0; i--) {
      const paint = s.paints![i];
      if (!paint.visible) continue;
      ctx.fillStyle = paint.gradient
        ? gradientFill(ctx, paint.gradient, w, h)
        : paint.color;
      ctx.globalAlpha = alpha * paint.opacity;
      ctx.fill(outline);
    }
  }
  ctx.globalAlpha = alpha;
  const fill = node.image;
  const asset = fill && doc.images?.[fill.assetId];
  if (fill && asset && !failedImages.has(asset)) {
    const draw = (image: HTMLCanvasElement) =>
      drawImageFill(ctx, image, fill, asset, w, h, outline);
    const hit = thumbnails.get(fill.assetId);
    if (hit) draw(hit);
    else yield { id: fill.assetId, asset, draw };
  }
  if (s.strokeWidth && s.strokeVisible !== false && node.type !== "vector") {
    ctx.save();
    const inside = (s.strokeAlign ?? "inside") === "inside";
    if (inside) ctx.clip(outline);
    ctx.strokeStyle = s.stroke ?? s.color;
    ctx.globalAlpha *= s.strokeOpacity ?? 1;
    ctx.lineWidth = s.strokeWidth * (inside ? 2 : 1);
    ctx.stroke(outline);
    ctx.restore();
  }
}

function* paintVector(
  ctx: Context,
  node: DesignNode,
  w: number,
  h: number,
  fill: string,
) {
  const v = node.vector;
  if (!v) return;
  ctx.save();
  const sx = w / v.width,
    sy = h / v.height,
    fit = Math.min(sx, sy);
  if (!v.stretch)
    ctx.translate((w - v.width * fit) / 2, (h - v.height * fit) / 2);
  ctx.scale(v.stretch ? sx : fit, v.stretch ? sy : fit);
  const alpha = ctx.globalAlpha;
  for (const path of v.paths) {
    let shape: Path2D;
    try {
      shape = new Path2D(path.d);
    } catch {
      continue;
    }
    if (path.fill) {
      ctx.fillStyle =
        path.fillColor ??
        (v.fillFromStyle
          ? node.style.gradient
            ? gradientFill(ctx, node.style.gradient, v.width, v.height)
            : fill
          : node.style.color);
      ctx.globalAlpha =
        alpha *
        (path.opacity ?? 1) *
        (path.fillOpacity ?? 1) *
        (v.fillFromStyle
          ? (node.style.fillOpacity ?? 1)
          : (node.style.colorOpacity ?? 1));
      ctx.fill(shape, path.fillRule);
    }
    if (hasVisibleVectorStroke(node, path)) {
      ctx.globalAlpha =
        alpha *
        (path.opacity ?? 1) *
        (path.strokeOpacity ?? 1) *
        (path.strokeColor ? 1 : (node.style.colorOpacity ?? 1));
      ctx.strokeStyle = path.strokeColor ?? node.style.color;
      ctx.lineWidth = path.strokeWidth;
      ctx.lineJoin = path.lineJoin ?? "round";
      ctx.lineCap = path.lineCap ?? "round";
      ctx.stroke(shape);
    }
    yield;
  }
  ctx.restore();
}

function* paintText(
  ctx: Context,
  node: DesignNode,
  w: number,
  h: number,
  scale: number,
) {
  const s = node.style,
    size = s.fontSize,
    leading = s.lineHeight ?? size * 1.2;
  const maxLines = Math.max(
    1,
    Math.min(s.maxLines ?? Infinity, Math.ceil(h / leading)),
  );
  const lines: { text: string; width: number }[] = [];
  let text = "",
    width = 0;
  for (const ch of node.text) {
    const advance = size * (ch.codePointAt(0)! > 255 ? 1 : 0.55);
    if (ch === "\n" || (text && width + advance > w)) {
      lines.push({ text, width });
      yield;
      text = "";
      width = 0;
      if (lines.length >= maxLines) break;
    }
    if (ch !== "\n") {
      text += ch;
      width += advance;
    }
  }
  if (text && lines.length < maxLines) lines.push({ text, width });
  const center =
    s.textAlign === "center" || (node.type === "button" && !s.textAlign);
  const right = s.textAlign === "right";
  const top =
    node.type === "button" || s.verticalAlign === "middle"
      ? (h - lines.length * leading) / 2
      : s.verticalAlign === "bottom"
        ? h - lines.length * leading
        : 0;
  ctx.save();
  ctx.fillStyle = s.color;
  ctx.globalAlpha *= s.colorOpacity ?? 1;
  ctx.font = `${s.fontStyle ?? "normal"} ${s.fontWeight ?? 400} ${size}px ${s.fontFamily ?? "sans-serif"}`;
  ctx.textAlign = center ? "center" : right ? "right" : "left";
  ctx.textBaseline = "middle";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      middle = top + (i + 0.5) * leading;
    if (size * scale >= 5)
      ctx.fillText(line.text, center ? w / 2 : right ? w : 0, middle, w);
    else {
      const length = Math.min(w, line.width);
      ctx.fillStyle = rgba(s.color, 0.72);
      ctx.fillRect(
        center ? (w - length) / 2 : right ? w - length : 0,
        middle - size * 0.16,
        length,
        size * 0.32,
      );
    }
    yield;
  }
  ctx.restore();
}

function* paintInto(
  canvas: HTMLCanvasElement,
  doc: DesignDocument,
  rootId: string,
  bounds: Map<string, Rect>,
): Generator<PaintStep, boolean> {
  indexPublishedScene(doc);
  const ctx = canvas.getContext("2d", {
    colorSpace: doc.colorProfile ?? "srgb",
  });
  const root = findLayer(doc, rootId),
    board = bounds.get(rootId);
  if (!ctx || !root || !board?.width || !board.height) return false;
  const sx = canvas.width / board.width,
    sy = canvas.height / board.height;
  ctx.scale(sx, sy);
  function* visit(
    ctx: Context,
    raw: DesignNode,
    parent: Rect,
    isRoot: boolean,
  ): Generator<PaintStep> {
    const node = displayNode(
      symbolPaintForView(resolveNode(doc, raw), "canvas"),
      doc.colorProfile,
    );
    const r = bounds.get(node.id);
    if (!r || node.hidden || node.style.opacity === 0) return;
    const s = node.style,
      w = r.width,
      h = r.height;
    ctx.save();
    ctx.translate(r.x - parent.x, r.y - parent.y);
    if (!isRoot && (s.rotation || s.flipX || s.flipY)) {
      ctx.translate(w / 2, h / 2);
      ctx.rotate(((s.rotation ?? 0) * Math.PI) / 180);
      ctx.scale(s.flipX ? -1 : 1, s.flipY ? -1 : 1);
      ctx.translate(-w / 2, -h / 2);
    }
    if (!isRoot) ctx.globalAlpha *= s.opacity ?? 1;
    const clip = !!s.clipContent;
    if (isRoot || (w * sx >= 0.75 && h * sy >= 0.75)) {
      const shape = outlinePath(node, w, h);
      yield* paintSurface(ctx, doc, node, w, h, shape);
      if (clip) ctx.clip(shape);
      if (node.vector) {
        const token = node.fillToken && doc.tokens[node.fillToken];
        yield* paintVector(
          ctx,
          node,
          w,
          h,
          token ? displayColor(token.value, doc.colorProfile) : s.fill,
        );
      }
      if (node.text) yield* paintText(ctx, node, w, h, Math.min(sx, sy));
    } else if (clip) {
      ctx.restore();
      return;
    }
    yield;
    const children = childrenOf(doc, node.id);
    for (let i = 0; i < children.length; i++) {
      const child = children[s.firstChildOnTop ? children.length - 1 - i : i];
      if (child.id !== node.maskSourceId) yield* visit(ctx, child, r, false);
      yield;
    }
    ctx.restore();
  }
  yield* visit(ctx, root, board, true);
  // Apply board opacity once to the flattened subtree, including overlaps.
  const opacity = resolveNode(doc, root).style.opacity ?? 1;
  if (opacity < 1) {
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = `rgba(0,0,0,${opacity})`;
    ctx.fillRect(0, 0, board.width, board.height);
  }
  return true;
}

function newCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
function release(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

export function paintBoardTile(
  doc: DesignDocument,
  rootId: string,
  bounds: Map<string, Rect>,
  targetWidth: number,
  targetHeight: number,
  onImagesReady?: () => void,
) {
  const canvas = newCanvas(targetWidth, targetHeight);
  const painter = paintInto(canvas, doc, rootId, bounds);
  let waiting = false;
  function paintRemaining() {
    for (let next = painter.next(); !next.done; next = painter.next()) {
      if (next.value) {
        waiting = true;
        waitForThumbnail(next.value, paintRemaining);
        return;
      }
    }
    if (waiting) onImagesReady?.();
  }
  paintRemaining();
  return canvas;
}

const jobs = new Set<() => boolean | void>();
let frame: number | undefined;
// Each step paints at most one node or vector path. Returning false resumes it in the current or next slice.
export function scheduleTilePaint(step: () => boolean | void) {
  jobs.add(step);
  if (frame === undefined) frame = requestAnimationFrame(runSlice);
  return () => {
    jobs.delete(step);
    if (!jobs.size && frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
  };
}
function runSlice() {
  // Leave 1 ms of the 4 ms frame budget for the last non-preemptible drawing call.
  const deadline = performance.now() + 3;
  try {
    while (jobs.size && performance.now() < deadline) {
      const step = jobs.values().next().value!;
      try {
        if (step() !== false) jobs.delete(step);
      } catch (error) {
        jobs.delete(step);
        throw error;
      }
    }
  } finally {
    frame = jobs.size ? requestAnimationFrame(runSlice) : undefined;
  }
}

interface BoardTile {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  signature: string;
}
export class BoardTileCache extends LruTileCache<BoardTile> {
  constructor(maxEntries?: number, maxBytes?: number) {
    super(maxEntries, maxBytes, (_key, tile) => release(tile.canvas));
  }
  request(
    doc: DesignDocument,
    rootId: string,
    bounds: Map<string, Rect>,
    width: number,
    height: number,
    blit: (tile: BoardTile, key: string) => void,
  ) {
    const cache = this;
    function* render(): Generator<PaintStep> {
      const signature = yield* boardBranchSignatureSteps(doc, rootId);
      const key = JSON.stringify([rootId, signature, width, height]);
      const hit = cache.get(key);
      if (hit) {
        blit(hit, key);
        return;
      }
      yield;
      const canvas = newCanvas(width, height);
      let transferred = false;
      try {
        if (!(yield* paintInto(canvas, doc, rootId, bounds))) return;
        const tile = { canvas, width, height, signature };
        blit(tile, key);
        cache.set(key, tile, width * height * 4);
        transferred = true;
      } finally {
        if (!transferred) release(canvas);
      }
    }

    const painter = render();
    // A previously computed signature and resident tile can blit before first paint.
    if (painter.next().done) return () => {};
    function advance() {
      const next = painter.next();
      if (next.done) {
        cancel = undefined;
        return true;
      }
      if (!next.value) return false;
      cancel = waitForThumbnail(next.value, () => {
        cancel = scheduleTilePaint(advance);
      });
      return true;
    }
    let cancel: (() => void) | undefined = scheduleTilePaint(advance);
    return () => {
      cancel?.();
      cancel = undefined;
      painter.return(undefined);
    };
  }
}
export const boardTileCache = new BoardTileCache();
