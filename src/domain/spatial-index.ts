import type { DesignDocument, DesignNode } from "./document";
import { contains, intersects, type Point, type Rect } from "./geometry";
import {
  identity,
  inverse,
  transform,
  visualBounds,
  type Matrix,
} from "./transforms";

export interface SpatialEntry {
  id: string;
  /** Axis-aligned world bounds, including the layer's inherited transform. */
  rect: Rect;
  type: DesignNode["type"];
  parentId: string | null;
  /** Layout area. Rotating a container does not change its hit priority. */
  area: number;
  order: number;
}

export interface SpatialIndex {
  readonly cellSize: number;
  readonly size: number;
  queryRect(rect: Rect): SpatialEntry[];
  queryPoint(point: Point): SpatialEntry[];
  queryRootsInRect(rect: Rect): SpatialEntry[];
  findSmallestContainerAt(
    point: Point,
    predicate: (entry: SpatialEntry) => boolean,
  ): string | null;
}

function finiteRect(rect: Rect) {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.x + rect.width) &&
    Number.isFinite(rect.y + rect.height)
  );
}

function cellRange(rect: Rect, cellSize: number) {
  const left = Math.floor(rect.x / cellSize),
    top = Math.floor(rect.y / cellSize);
  // Include the far edges: a zero-width query on a cell boundary hits both touching layers.
  const right = Math.floor((rect.x + rect.width) / cellSize);
  const bottom = Math.floor((rect.y + rect.height) / cellSize);
  const count = (right - left + 1) * (bottom - top + 1);
  // At extreme coordinates incrementing a cell index by 1 may never advance.
  if (
    ![left, top, right, bottom].every(Number.isSafeInteger) ||
    right < left ||
    bottom < top
  )
    return null;
  return { left, top, right, bottom, count };
}

type CellRange = NonNullable<ReturnType<typeof cellRange>>;
const cellKey = (x: number, y: number) => x + "," + y;
function visitCells(range: CellRange, visit: (key: string) => void) {
  for (let y = range.top; y <= range.bottom; y++) {
    for (let x = range.left; x <= range.right; x++) visit(cellKey(x, y));
  }
}

class SpatialGrid {
  readonly entries: SpatialEntry[] = [];
  private readonly buckets = new Map<string, SpatialEntry[]>();
  private readonly largeEntries: SpatialEntry[] = [];

  constructor(private readonly cellSize: number) {}

  insert(entry: SpatialEntry) {
    this.entries.push(entry);
    const range = cellRange(entry.rect, this.cellSize);
    if (!range || range.count > 16) {
      this.largeEntries.push(entry);
      return;
    }
    visitCells(range, (key) => {
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(entry);
      else this.buckets.set(key, [entry]);
    });
  }

  query(rect: Rect): SpatialEntry[] {
    if (!finiteRect(rect)) return [];
    const range = cellRange(rect, this.cellSize);
    // At overview zoom, testing entries can be cheaper than walking mostly empty cells.
    if (!range || range.count > this.entries.length) {
      return this.entries.filter((entry) => intersects(entry.rect, rect));
    }
    const candidates = new Set<SpatialEntry>();
    visitCells(range, (key) => {
      const bucket = this.buckets.get(key);
      if (bucket) for (const entry of bucket) candidates.add(entry);
    });
    const hits = this.largeEntries.filter((entry) =>
      intersects(entry.rect, rect),
    );
    for (const entry of candidates)
      if (intersects(entry.rect, rect)) hits.push(entry);
    return hits.sort((a, b) => a.order - b.order);
  }

  queryPoint(point: Point): SpatialEntry[] {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return [];
    // Each entry is in either the point's bucket or the overflow list, never both.
    const key = cellKey(
      Math.floor(point.x / this.cellSize),
      Math.floor(point.y / this.cellSize),
    );
    const hits = this.largeEntries.filter((entry) =>
      contains(entry.rect, point),
    );
    const bucket = this.buckets.get(key);
    if (bucket) {
      for (const entry of bucket) {
        if (contains(entry.rect, point)) hits.push(entry);
      }
    }
    return hits.sort((a, b) => a.order - b.order);
  }
}

// Documents and geometry maps are snapshots. A new map or cell size needs its own index,
// even when a drag preview shares the document or transform map with the previous frame.
const cache = new WeakMap<
  DesignDocument,
  WeakMap<
    Map<string, Rect>,
    WeakMap<Map<string, Matrix>, Map<number, SpatialIndex>>
  >
>();

export function buildSpatialIndex(
  doc: DesignDocument,
  bounds: Map<string, Rect>,
  transforms: Map<string, Matrix>,
  cellSize = 256,
): SpatialIndex {
  if (!Number.isFinite(cellSize) || cellSize <= 0)
    throw new RangeError("cellSize must be positive and finite");
  let byBounds = cache.get(doc);
  if (!byBounds) cache.set(doc, (byBounds = new WeakMap()));
  let byTransforms = byBounds.get(bounds);
  if (!byTransforms) byBounds.set(bounds, (byTransforms = new WeakMap()));
  let byCellSize = byTransforms.get(transforms);
  if (!byCellSize) byTransforms.set(transforms, (byCellSize = new Map()));
  const cached = byCellSize.get(cellSize);
  if (cached) return cached;

  const all = new SpatialGrid(cellSize),
    roots = new SpatialGrid(cellSize);
  doc.nodes.forEach((node, order) => {
    const box = bounds.get(node.id);
    if (!box) return;
    const rect = visualBounds(box, transforms.get(node.id) ?? identity);
    if (!finiteRect(rect)) return;
    const entry = {
      id: node.id,
      rect,
      type: node.type,
      parentId: node.parentId,
      area: box.width * box.height,
      order,
    };
    all.insert(entry);
    if (node.parentId === null) roots.insert(entry);
  });
  const index: SpatialIndex = {
    cellSize,
    size: all.entries.length,
    queryRect: (rect) => all.query(rect),
    queryPoint: (point) => all.queryPoint(point),
    queryRootsInRect: (rect) => roots.query(rect),
    findSmallestContainerAt(point, predicate) {
      let best: SpatialEntry | undefined;
      for (const entry of all.queryPoint(point)) {
        if ((best && best.area <= entry.area) || !predicate(entry)) continue;
        const matrix = transforms.get(entry.id) ?? identity;
        // The corners of a rotated AABB can be outside the painted container.
        if (
          matrix !== identity &&
          !contains(bounds.get(entry.id)!, transform(inverse(matrix), point))
        )
          continue;
        best = entry;
      }
      return best?.id ?? null;
    },
  };
  byCellSize.set(cellSize, index);
  return index;
}
