import type { DesignDocument, DesignNode } from "./document";
import type { Operation } from "./commands";
import { layoutBounds, type Rect } from "./geometry";
import { findLayer } from "./scene-index";
import { isVisible, isLocked, instanceAncestor, selectionRoots } from "./tree";
import { localTransform, visualBounds } from "./transforms";

type Item = { node: DesignNode; box: Rect };
export type SmartGrid = {
  items: Item[];
  columns: number;
  gapX: number;
  gapY: number;
  x: number;
  y: number;
  parent: string | null;
};
const medianGap = (values: number[]) => {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return Math.max(
    0,
    Number(
      (
        (values[Math.floor(values.length / 2)] +
          values[Math.floor((values.length - 1) / 2)]) /
        2
      ).toFixed(2),
    ),
  );
};
export function smartSelection(
  doc: DesignDocument,
  ids: string[],
): SmartGrid | null {
  if (ids.length < 3) return null;
  const nodes = selectionRoots(doc, ids),
    parent = nodes[0]?.parentId ?? null,
    container = findLayer(doc, parent);
  if (
    nodes.length < 3 ||
    (container?.type === "frame" && container.style.layout !== "free") ||
    nodes.some(
      (n) =>
        n.parentId !== parent ||
        isLocked(doc, n.id) ||
        instanceAncestor(doc, n.id) ||
        !isVisible(doc, n.id),
    )
  )
    return null;
  const geometry = layoutBounds(doc);
  const items = nodes.map((node) => {
    const rect = geometry.get(node.id)!;
    return { node, box: visualBounds(rect, localTransform(node, rect)) };
  });
  items.sort(
    (a, b) =>
      a.box.y + a.box.height / 2 - b.box.y - b.box.height / 2 ||
      a.box.x - b.box.x,
  );
  const rows: Item[][] = [];
  let rowTop = 0,
    rowBottom = 0;
  for (const item of items) {
    const { y, height } = item.box,
      bottom = y + height;
    const overlap = Math.min(rowBottom, bottom) - Math.max(rowTop, y);
    if (!rows.length || overlap < Math.min(height, rowBottom - rowTop) * 0.5) {
      rows.push([item]);
      rowTop = y;
      rowBottom = bottom;
    } else {
      rows[rows.length - 1].push(item);
      rowTop = Math.max(rowTop, y);
      rowBottom = Math.min(rowBottom, bottom);
    }
  }
  rows.forEach((row) => row.sort((a, b) => a.box.x - b.box.x));
  const columns = Math.max(...rows.map((r) => r.length)),
    left = Array<number>(columns).fill(Infinity),
    right = Array<number>(columns).fill(-Infinity);
  const ys = rows.map((row) => ({
    top: Math.min(...row.map((i) => i.box.y)),
    bottom: Math.max(...row.map((i) => i.box.y + i.box.height)),
  }));
  rows.forEach((row) =>
    row.forEach(({ box }, i) => {
      left[i] = Math.min(left[i], box.x);
      right[i] = Math.max(right[i], box.x + box.width);
    }),
  );
  return {
    items: rows.flat(),
    parent,
    columns,
    x: Math.min(...left),
    y: Math.min(...ys.map((r) => r.top)),
    gapX: medianGap(left.slice(1).map((v, i) => v - right[i])),
    gapY: medianGap(ys.slice(1).map((r, i) => r.top - ys[i].bottom)),
  };
}
export function gridPlacement(grid: SmartGrid, items = grid.items) {
  const widths = Array<number>(grid.columns).fill(0),
    heights = Array<number>(Math.ceil(items.length / grid.columns)).fill(0);
  items.forEach(({ box }, i) => {
    const col = i % grid.columns,
      row = Math.floor(i / grid.columns);
    widths[col] = Math.max(widths[col], box.width);
    heights[row] = Math.max(heights[row], box.height);
  });
  const starts = (sizes: number[], first: number, gap: number) =>
    sizes.map((size) => {
      const value = first;
      first += size + gap;
      return value;
    });
  const xs = starts(widths, grid.x, grid.gapX),
    ys = starts(heights, grid.y, grid.gapY);
  return items.map((item, i) => ({
    ...item,
    x: xs[i % grid.columns],
    y: ys[Math.floor(i / grid.columns)],
  }));
}
export function arrangeGrid(grid: SmartGrid, items = grid.items): Operation[] {
  return gridPlacement(grid, items).flatMap(({ node, box, x, y }) => {
    const dx = x - box.x,
      dy = y - box.y;
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return [];
    return [
      {
        type: "update",
        id: node.id,
        patch: {},
        style: { x: node.style.x + dx, y: node.style.y + dy },
      },
    ];
  });
}
