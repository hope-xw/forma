import { responsiveSpacing } from "./layout-breakpoints";
import type { DesignDocument, DesignNode } from "./document";
import type { Point, Rect } from "./geometry";
import { resolveNode } from "./design-system";
import { childrenOf } from "./scene-index";
import { gridMetrics, flowInsets } from "./sizing";
import { inverse, transform, type Matrix } from "./transforms";

export function gridSceneMetrics(
  doc: DesignDocument,
  p: DesignNode,
  boxes: Map<string, Rect>,
) {
  const b = boxes.get(p.id)!;
  return gridMetrics(
    {
      ...p,
      style: {
        ...p.style,
        width: b.width,
        height: b.height,
        ...responsiveSpacing(p.style, b.width),
      },
    },
    childrenOf(doc, p.id)
      .filter((n) => !resolveNode(doc, n).hidden)
      .map((n) => {
        const v = resolveNode(doc, n),
          box = boxes.get(n.id)!;
        return {
          ...v,
          style: { ...v.style, width: box.width, height: box.height },
        };
      }),
  );
}

/** Locate the nearest track including the first empty rows of a fixed-size grid. */
export function gridDrop(
  doc: DesignDocument,
  parent: DesignNode,
  point: Point,
  boxes: Map<string, Rect>,
  matrix: Matrix,
) {
  const b = boxes.get(parent.id)!;
  const raw = resolveNode(doc, parent);
  const p = {
    ...raw,
    style: { ...raw.style, ...responsiveSpacing(raw.style, b.width) },
  };
  if (p.style.layout !== "grid" || p.style.minColumnWidth) return;
  const local = transform(inverse(matrix), point);
  if (
    local.x < b.x ||
    local.y < b.y ||
    local.x > b.x + b.width ||
    local.y > b.y + b.height
  )
    return;
  const grid = gridSceneMetrics(doc, p, boxes);
  const i = flowInsets(p),
    x = local.x - b.x - i.left,
    y = local.y - b.y - i.top,
    rowGap = p.style.rowGap ?? grid.gap;
  const c = grid.starts.slice(1).findIndex((end) => x < end - grid.gap / 2);
  const column = c < 0 ? grid.count - 1 : c;
  const heights = grid.heights;
  let row = 0,
    top = 0;
  for (; row < heights.length && y >= top + heights[row] + rowGap / 2; row++)
    top += heights[row] + rowGap;
  const fallback = p.style.gridRowHeight ?? Math.max(24, heights.at(-1) ?? 48);
  if (row >= heights.length) {
    const more = Math.max(
      0,
      Math.floor((y - top + rowGap / 2) / (fallback + rowGap)),
    );
    row += more;
    top += more * (fallback + rowGap);
  }
  return {
    cell: { row: Math.min(1024, row + 1), column: column + 1 },
    rect: {
      x: b.x + i.left + grid.starts[column],
      y: b.y + i.top + top,
      width: grid.starts[column + 1] - grid.starts[column] - grid.gap,
      height: heights[row] ?? fallback,
    },
    matrix,
  };
}
