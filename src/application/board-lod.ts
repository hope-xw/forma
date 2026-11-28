import type { DesignDocument, DesignNode } from "../domain/document";
import { union, type Rect } from "../domain/geometry";
import {
  editablePaths,
  hasVisibleVectorStroke,
  vectorBounds,
} from "../domain/vector-path";
import { symbolPaintForView } from "../domain/symbol-background";
import {
  compose,
  identity,
  localTransform,
  visualBounds,
} from "../domain/transforms";
import { resolveNode } from "../domain/design-system";
import {
  childrenOf,
  findLayer,
  indexPublishedScene,
  positionDelta,
  unchangedBranch,
} from "../domain/scene-index";

export const LOD_ENTER_ZOOM = 0.38;
export const LOD_EXIT_ZOOM = 0.42;
export const LOD_MIN_ROOT_BOARDS = 12;
export const LOD_MIN_TOTAL_NODES = 600;
export const LOD_MIN_BOARD_NODES = 8;
export const LOD_MAX_TILE_EDGE = 512;
export const LOD_DEFAULT_MAX_BYTES = 48 * 1024 * 1024;
export const LOD_DEFAULT_MAX_ENTRIES = 180;

export type BoardLodMode = "live" | "cached";
export function resolveLodActive(
  zoom: number,
  wasActive: boolean,
  rootBoardCount: number,
  totalNodeCount: number,
) {
  return (
    (rootBoardCount >= LOD_MIN_ROOT_BOARDS ||
      totalNodeCount >= LOD_MIN_TOTAL_NODES) &&
    zoom < (wasActive ? LOD_EXIT_ZOOM : LOD_ENTER_ZOOM)
  );
}

export function structuralDocument(doc: DesignDocument): DesignDocument {
  return positionDelta(doc)?.base ?? doc;
}

// A moved descendant (or a handle-style edit with an empty moved map) can
// change this board's visible geometry even though the root itself did not move.
function branchDocument(doc: DesignDocument, rootId: string) {
  const base = structuralDocument(doc);
  return base !== doc && unchangedBranch(base, doc, rootId) ? base : doc;
}

function branchCache<T>(
  cache: WeakMap<DesignDocument, Map<string, T>>,
  doc: DesignDocument,
) {
  let byId = cache.get(doc);
  if (!byId) {
    indexPublishedScene(doc);
    byId = new Map();
    cache.set(doc, byId);
  }
  return byId;
}

const counts = new WeakMap<
  DesignDocument,
  Map<string, { total: number; exact: boolean }>
>();
function countUntil(doc: DesignDocument, rootId: string, limit: number) {
  const base = structuralDocument(doc);
  const byId = counts.get(doc) ?? branchCache(counts, base);
  // A committed position edit can itself become the base for the next drag.
  if (base !== doc) counts.set(doc, byId);
  const cached = byId.get(rootId);
  if (cached && (cached.exact || cached.total > limit)) return cached.total;
  const pending = [rootId];
  let total = 0;
  while (pending.length) {
    const children = childrenOf(base, pending.pop()!);
    total += children.length;
    if (total > limit) {
      byId.set(rootId, { total, exact: false });
      return total;
    }
    for (const child of children) pending.push(child.id);
  }
  byId.set(rootId, { total, exact: true });
  return total;
}

export function countBoardDescendants(doc: DesignDocument, rootId: string) {
  return countUntil(doc, rootId, Infinity);
}
export function hasMoreDescendantsThan(
  doc: DesignDocument,
  rootId: string,
  limit: number,
) {
  return countUntil(doc, rootId, limit) > limit;
}

function visible(node: DesignNode) {
  return !node.hidden && node.style.opacity !== 0;
}
type BoardChecks = WeakMap<DesignDocument, Map<string, boolean>>;
function cachedBoardCheck(
  cache: BoardChecks,
  doc: DesignDocument,
  rootId: string,
  check: (
    base: DesignDocument,
    rootId: string,
    bounds?: Map<string, Rect>,
  ) => boolean,
  bounds?: Map<string, Rect>,
) {
  const byId = branchCache(cache, doc);
  const hit = byId.get(rootId);
  if (hit !== undefined) return hit;
  const base = branchDocument(doc, rootId);
  const baseChecks = base === doc ? byId : branchCache(cache, base);
  const result = baseChecks.get(rootId) ?? check(base, rootId, bounds);
  baseChecks.set(rootId, result);
  if (base !== doc) byId.set(rootId, result);
  return result;
}

const guides: BoardChecks = new WeakMap();
function hasVisibleGuides(doc: DesignDocument, rootId: string) {
  const root = findLayer(doc, rootId);
  const pending = root ? [root] : [];
  while (pending.length) {
    const node = resolveNode(doc, pending.pop()!);
    if (!visible(node)) continue;
    if (node.style.layoutGuides?.some((guide) => guide.visible !== false))
      return true;
    for (const child of childrenOf(doc, node.id)) pending.push(child);
  }
  return false;
}
export function branchHasLayoutGuides(doc: DesignDocument, rootId: string) {
  return cachedBoardCheck(guides, doc, rootId, hasVisibleGuides);
}

function unsupportedArtwork(node: DesignNode) {
  const s = node.style;
  return !!(
    node.booleanOperation ||
    node.maskSourceId ||
    node.maskType ||
    node.siblingMask ||
    [s.blendMode, s.fillBlendMode, s.strokeBlendMode].some(
      (mode) => mode && mode !== "pass-through" && mode !== "normal",
    ) ||
    s.shadows?.some((shadow) => shadow.visible !== false) ||
    s.strokePaints?.some((paint) => paint.visible) ||
    s.paints?.some((paint) => paint.visible) ||
    s.figmaGlass ||
    s.sketchGlass ||
    (s.blur ?? 0) > 0 ||
    (s.backdropBlur ?? 0) > 0 ||
    s.textEffectClip === "glyphs" ||
    s.tint
  );
}

type VectorData = NonNullable<DesignNode["vector"]>;
type VectorPath = VectorData["paths"][number];
function pathHasFill(
  path: Pick<VectorPath, "fill" | "fillOpacity" | "fillColor" | "opacity">,
) {
  return (
    path.fill &&
    path.fillOpacity !== 0 &&
    path.opacity !== 0 &&
    path.fillColor !== "transparent"
  );
}

function paintLayerCount(doc: DesignDocument, layer: DesignNode) {
  const node = symbolPaintForView(layer, "canvas");
  const { style: s, vector, image } = node;
  const fill = (node.fillToken && doc.tokens[node.fillToken]?.value) || s.fill;
  const filled =
    (s.fillOpacity ?? 1) > 0 &&
    (s.gradient
      ? s.gradient.stops.some((stop) => stop.opacity > 0)
      : fill !== "transparent");
  const colored = (s.colorOpacity ?? 1) > 0 && s.color !== "transparent";
  let layers = Number(
    !!image && !!doc.images?.[image.assetId] && (image.opacity ?? 1) > 0,
  );
  if (node.text && colored) layers++;
  function withVectorPaint(vector: VectorData) {
    for (const path of vector.paths) {
      if (
        pathHasFill(path) &&
        (path.fillColor || (vector.fillFromStyle ? filled : colored))
      )
        layers++;
      if (hasVisibleVectorStroke(node, path)) layers++;
      if (layers >= 2) break;
    }
    return layers;
  }
  if (node.type === "vector" && vector) return withVectorPaint(vector);
  if (
    filled &&
    node.type !== "group" &&
    node.type !== "text" &&
    node.type !== "slice" &&
    node.type !== "vector"
  )
    layers++;
  if (
    s.strokeVisible !== false &&
    (s.strokeOpacity ?? 1) > 0 &&
    (s.stroke ?? s.color) !== "transparent" &&
    ((s.strokeWidth ?? 0) > 0 ||
      Object.values(s.strokeSides ?? {}).some((width) => width > 0))
  )
    layers++;
  // Updates can attach paths to a surface. Both renderers draw that extra ink.
  return vector && layers < 2 ? withVectorPaint(vector) : layers;
}

function hasMultiplePaintedLayers(
  doc: DesignDocument,
  node: DesignNode,
  counts: Map<string, number>,
) {
  function count(layer: DesignNode): number {
    const cached = counts.get(layer.id);
    if (cached !== undefined) return cached;
    let layers = paintLayerCount(doc, layer);
    for (const raw of childrenOf(doc, layer.id)) {
      if (layers >= 2) break;
      const child = resolveNode(doc, raw);
      if (visible(child)) layers += count(child);
    }
    counts.set(layer.id, layers);
    return layers;
  }
  return count(node) >= 2;
}

// Keep geometry independent of the owning layer. The same vector may be drawn
// with strokes disabled or with a transparent inherited currentColor.
function measureVectorInk(v: VectorData) {
  let chars = 0;
  for (const path of v.paths) {
    chars += path.d.length;
    if (chars > 2048) return "complex" as const;
  }
  const fill: Rect[] = [],
    explicit: Rect[] = [],
    inherited: Rect[] = [];
  for (const path of editablePaths(v)) {
    if (path.opacity === 0) continue;
    const box = vectorBounds([{ ...path, strokeWidth: 0 }], 0);
    if (!Number.isFinite(box.x)) continue;
    if (pathHasFill(path)) fill.push(box);
    if (
      !path.strokeWidth ||
      path.strokeOpacity === 0 ||
      path.strokeColor === "transparent"
    )
      continue;
    const half =
      path.strokeWidth *
      (path.lineJoin === "miter"
        ? 2
        : path.lineCap === "square"
          ? Math.SQRT1_2
          : 0.5);
    (path.strokeColor ? explicit : inherited).push({
      x: box.x - half,
      y: box.y - half,
      width: box.width + 2 * half,
      height: box.height + 2 * half,
    });
  }
  return {
    fill: union(fill),
    explicit: union([...fill, ...explicit]),
    all: union([...fill, ...explicit, ...inherited]),
  };
}
const vectorInk = new WeakMap<
  VectorData,
  ReturnType<typeof measureVectorInk>
>();

function paintedBox(node: DesignNode, rect: Rect): Rect | null {
  // Attached paths can overflow a non-vector surface too.
  const v = node.vector;
  if (!v) return rect;
  // CanvasNode falls back to intrinsic SVG dimensions for zero-sized layers.
  if (rect.width <= 0 || rect.height <= 0 || v.width <= 0 || v.height <= 0)
    return null;
  let measured = vectorInk.get(v);
  if (!measured) {
    measured = measureVectorInk(v);
    vectorInk.set(v, measured);
  }
  if (measured === "complex") return null;
  const ink =
    node.style.strokeVisible === false
      ? measured.fill
      : node.style.color === "transparent" || node.style.colorOpacity === 0
        ? measured.explicit
        : measured.all;
  if (!ink) return rect;
  const fit = Math.min(rect.width / v.width, rect.height / v.height);
  const sx = v.stretch ? rect.width / v.width : fit;
  const sy = v.stretch ? rect.height / v.height : fit;
  return union([
    rect,
    {
      x: rect.x + (rect.width - v.width * sx) / 2 + ink.x * sx,
      y: rect.y + (rect.height - v.height * sy) / 2 + ink.y * sy,
      width: ink.width * sx,
      height: ink.height * sy,
    },
  ])!;
}

function canPaintBranch(
  doc: DesignDocument,
  rootId: string,
  bounds?: Map<string, Rect>,
) {
  const raw = findLayer(doc, rootId);
  if (!raw) return false;
  const root = resolveNode(doc, raw);
  const board = bounds?.get(rootId) ?? root.style;
  const unclipped = root.style.clipContent !== true;
  const paintCounts = new Map<string, number>();
  const pending = [{ node: root, rect: board, matrix: identity }];
  while (pending.length) {
    const { node, rect, matrix } = pending.pop()!;
    if (!visible(node)) continue;
    if (unsupportedArtwork(node)) return false;
    const isolated = node.id !== rootId && (node.style.opacity ?? 1) < 1;
    if (isolated && hasMultiplePaintedLayers(doc, node, paintCounts))
      return false;
    for (const rawChild of childrenOf(doc, node.id)) {
      const child = resolveNode(doc, rawChild);
      if (!visible(child)) continue;
      const s = child.style;
      let childRect = rect,
        childMatrix = matrix;
      if (unclipped) {
        childRect = bounds?.get(child.id) ?? {
          x: rect.x + s.x,
          y: rect.y + s.y,
          width: s.width,
          height: s.height,
        };
        if (s.rotation || s.flipX || s.flipY)
          childMatrix = compose(matrix, localTransform(child, childRect));
        const ink = paintedBox(child, childRect);
        if (!ink) return false;
        const r = visualBounds(ink, childMatrix);
        if (
          r.x < board.x ||
          r.y < board.y ||
          r.x + r.width > board.x + board.width ||
          r.y + r.height > board.y + board.height
        )
          return false;
      }
      pending.push({ node: child, rect: childRect, matrix: childMatrix });
    }
  }
  return true;
}

const renderable = new WeakMap<DesignDocument, Map<string, boolean>>();
// Local style boxes and measured layout boxes can legitimately disagree.
const measuredRenderable = new WeakMap<DesignDocument, Map<string, boolean>>();
const measuredBounds = new WeakMap<DesignDocument, Map<string, Rect>>();
export function isBoardLodRenderable(
  doc: DesignDocument,
  rootId: string,
  bounds?: Map<string, Rect>,
): boolean {
  const cache = bounds ? measuredRenderable : renderable;
  if (bounds && measuredBounds.get(doc) !== bounds) {
    measuredRenderable.delete(doc);
    measuredBounds.set(doc, bounds);
  }
  return cachedBoardCheck(cache, doc, rootId, canPaintBranch, bounds);
}

export function resolveBoardLodMode(input: {
  lodActive: boolean;
  node: DesignNode;
  descendantCount: number;
  isSelectedBranch: boolean;
  isHovered: boolean;
  isEditingBranch: boolean;
  isDragging: boolean;
  isAiPreview: boolean;
  outlineMode: boolean;
  showLayoutGuides: boolean;
  hasLayoutGuides: boolean;
  renderable?: boolean;
}): BoardLodMode {
  return input.renderable === false ||
    !input.lodActive ||
    input.node.type !== "frame" ||
    input.descendantCount <= LOD_MIN_BOARD_NODES ||
    input.isSelectedBranch ||
    input.isHovered ||
    input.isEditingBranch ||
    input.isDragging ||
    input.isAiPreview ||
    input.outlineMode ||
    (input.showLayoutGuides && input.hasLayoutGuides)
    ? "live"
    : "cached";
}

export function computeTileResolution(
  boardWidth: number,
  boardHeight: number,
  zoom: number,
  dpr: number,
) {
  const w = Math.max(1, boardWidth),
    h = Math.max(1, boardHeight);
  const cap = LOD_MAX_TILE_EDGE / Math.max(w, h);
  const scale = Math.min(cap, 0.5, Math.max(0.18, zoom * dpr * 1.5));
  // Grow both dimensions together to reach the 16px allocation floor where possible.
  const allocation = Math.min(cap, Math.max(scale, 16 / Math.min(w, h)));
  const width = Math.max(16, Math.round(w * allocation));
  const height = Math.max(16, Math.round(h * allocation));
  return { width, height, scale, estimatedBytes: width * height * 4 };
}

const signatures = new WeakMap<DesignDocument, Map<string, string>>();
const nodeHashes = new WeakMap<DesignNode, string>();
// Two independent 32-bit lanes. Feed fields incrementally, without concatenating the subtree.
class RasterHash {
  private a = 2166136261;
  private b = 5381;
  append(text: string) {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      this.a = Math.imul(this.a ^ code, 16777619);
      this.b = Math.imul(this.b ^ code, 33);
    }
  }
  digest() {
    return (this.a >>> 0).toString(36) + "." + (this.b >>> 0).toString(36);
  }
}
function* nodeHash(node: DesignNode): Generator<void, string> {
  const cached = nodeHashes.get(node);
  if (cached !== undefined) return cached;
  const hash = new RasterHash();
  hash.append(
    JSON.stringify([
      node.id,
      node.parentId,
      node.type,
      node.name,
      node.text,
      node.style,
      node.textRuns,
      node.image,
      node.booleanOperation,
      node.compoundWindingRule,
      node.operandOperation,
      node.maskSourceId,
      node.maskType,
      node.siblingMask,
      node.locked,
      !!node.componentSet,
      !!node.instance,
      !!node.nestedSlot,
    ]),
  );
  if (node.vector) {
    const { paths, ...viewBox } = node.vector;
    hash.append(JSON.stringify(viewBox));
    for (const { d, junctions, ...paint } of paths) {
      if (junctions?.length) {
        const ordered = [...junctions].sort(
          (a, b) =>
            a.contour - b.contour ||
            a.anchor - b.anchor ||
            a.id.localeCompare(b.id),
        );
        hash.append(
          JSON.stringify(ordered.map((j) => [j.contour, j.anchor, j.id])),
        );
      }
      hash.append(JSON.stringify(paint));
      // A single imported path can contain up to 100,000 characters.
      for (let i = 0; i < d.length; i += 8192) {
        hash.append(d.slice(i, i + 8192));
        yield;
      }
    }
  }
  const result = hash.digest();
  nodeHashes.set(node, result);
  return result;
}

// The editor can yield between nodes even on the first read of a large immutable branch.
export function* boardBranchSignatureSteps(
  doc: DesignDocument,
  rootId: string,
): Generator<void, string> {
  doc = branchDocument(doc, rootId);
  const byId = branchCache(signatures, doc);
  const cached = byId.get(rootId);
  if (cached !== undefined) return cached;
  const hash = new RasterHash();
  hash.append(
    JSON.stringify([
      rootId,
      doc.colorProfile ?? "srgb",
      Object.entries(doc.designSystem?.activeModes ?? {}).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ]),
  );
  const root = findLayer(doc, rootId);
  const pending = root ? [root] : [];
  while (pending.length) {
    const node = resolveNode(doc, pending.pop()!);
    yield;
    if (node.hidden) continue;
    hash.append(
      JSON.stringify([
        yield* nodeHash(node),
        node.fillToken ? doc.tokens[node.fillToken]?.value : null,
        node.image && doc.images?.[node.image.assetId]?.width,
        node.image && doc.images?.[node.image.assetId]?.height,
      ]),
    );
    const children = childrenOf(doc, node.id);
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
  const signature = hash.digest();
  byId.set(rootId, signature);
  return signature;
}

export function boardBranchSignature(
  doc: DesignDocument,
  rootId: string,
): string {
  const steps = boardBranchSignatureSteps(doc, rootId);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export class LruTileCache<T> {
  private readonly items = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  constructor(
    readonly maxEntries = LOD_DEFAULT_MAX_ENTRIES,
    readonly maxBytes = LOD_DEFAULT_MAX_BYTES,
    private readonly onEvict?: (key: string, value: T) => void,
  ) {
    if (![maxEntries, maxBytes].every((n) => Number.isSafeInteger(n) && n >= 0))
      throw new RangeError("Tile cache limits must be nonnegative integers");
  }
  get(key: string): T | undefined {
    const item = this.items.get(key);
    if (!item) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.items.delete(key);
    this.items.set(key, item);
    return item.value;
  }
  set(key: string, value: T, bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new RangeError("Invalid tile byte size");
    const old = this.items.get(key);
    if (old) {
      this.items.delete(key);
      this.bytes -= old.bytes;
      if (old.value !== value) this.onEvict?.(key, old.value);
    }
    if (!this.maxEntries || bytes > this.maxBytes) {
      this.onEvict?.(key, value);
      return;
    }
    while (
      this.items.size >= this.maxEntries ||
      this.bytes + bytes > this.maxBytes
    ) {
      this.delete(this.items.keys().next().value!);
      this.evictions++;
    }
    this.items.set(key, { value, bytes });
    this.bytes += bytes;
  }
  delete(key: string) {
    const item = this.items.get(key);
    if (!item) return false;
    this.items.delete(key);
    this.bytes -= item.bytes;
    this.onEvict?.(key, item.value);
    return true;
  }
  clear() {
    for (const key of this.items.keys()) this.delete(key);
  }
  stats() {
    return {
      entries: this.items.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}
