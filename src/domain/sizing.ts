import {
  gridBreakpoint,
  layoutRuleAt,
  responsiveSpacing,
} from "./layout-breakpoints";
import { parseTracks, trackCssValue } from "./grid-tracks";
import { strokeInset } from "./stroke";
import { currentTextLayout, currentTextShape } from "./text-shape";
import type { DesignDocument, DesignNode } from "./document";
import { constrainAxis } from "./constraints";
export type Axis = "width" | "height";
const limits = (n: DesignNode, axis: Axis) =>
  axis === "width"
    ? [n.style.minWidth, n.style.maxWidth]
    : [n.style.minHeight, n.style.maxHeight];
function clampSize(n: DesignNode, axis: Axis, value: number) {
  const [min, max] = limits(n, axis);
  return Math.max(
    min ?? Math.min(1, n.style[axis]),
    Math.min(value, max ?? Infinity),
  );
}
/** Flex grow freezes items at their limits and allocates the remaining space to the others. */
function distributeFill(
  items: DesignNode[],
  axis: Axis,
  space: number,
  preferred: boolean,
) {
  let pending = items.slice(),
    remaining = space;
  while (pending.length) {
    const basis = (n: DesignNode) => (preferred ? n.style[axis] : 0);
    const extra = Math.max(
      0,
      (remaining - pending.reduce((sum, n) => sum + basis(n), 0)) /
        pending.length,
    );
    const proposals = pending.map((n) => {
      const unbounded = basis(n) + extra;
      return { n, unbounded, size: clampSize(n, axis, unbounded) };
    });
    const violation = proposals.reduce(
      (sum, p) => sum + p.size - p.unbounded,
      0,
    );
    const frozen = proposals.filter((p) =>
      violation > 0.0001
        ? p.size > p.unbounded
        : violation < -0.0001
          ? p.size < p.unbounded
          : true,
    );
    for (const p of frozen) {
      p.n.style[axis] = p.size;
      remaining -= p.size;
    }
    const done = new Set(frozen.map((p) => p.n.id));
    pending = pending.filter((n) => !done.has(n.id));
  }
}
export type SizeMode = "fixed" | "hug" | "fill";
export const modeKey = (axis: Axis) =>
  axis === "width" ? "widthMode" : "heightMode";
export const flow = (n?: DesignNode) =>
  !!n && n.type === "frame" && n.style.layout !== "free";
export function sizingMode(
  node: DesignNode,
  parent: DesignNode | undefined,
  axis: Axis,
): SizeMode {
  const mode = node.style[modeKey(axis)];
  if (
    mode === "hug" &&
    ((flow(node) && !node.text) ||
      node.type === "text" ||
      (node.type === "button" && axis === "width"))
  )
    return "hug";
  if (
    mode === "fill" &&
    !node.style.absolutePosition &&
    flow(parent) &&
    !(parent!.style[modeKey(axis)] === "hug" && !parent!.text)
  )
    return "fill";
  return "fixed";
}
export function flowInsets(node?: DesignNode) {
  const s = node?.style,
    p = s?.padding ?? 0,
    i = s?.insets ?? { left: p, right: p, top: p, bottom: p };
  return {
    left: i.left + strokeInset(s, "left"),
    right: i.right + strokeInset(s, "right"),
    top: i.top + strokeInset(s, "top"),
    bottom: i.bottom + strokeInset(s, "bottom"),
  };
}
export const wraps = (node?: DesignNode) =>
  node?.type === "frame" && node.style.layout === "row" && !!node.style.wrap;
export { gridBreakpoint } from "./layout-breakpoints";
function gridSettings(n: DesignNode) {
  const s = n.style;
  const rule = layoutRuleAt(s, s.width);
  const tracks =
    rule?.columns === undefined && !s.minColumnWidth && s.gridTracks
      ? parseTracks(s.gridTracks)
      : undefined;
  return {
    tracks,
    count: rule?.columns ?? tracks?.length ?? s.columns ?? 2,
    gap: rule?.gap ?? s.gap,
  };
}
/** Auto-fit grids keep one item per track as the viewport changes. */
export function columnSpan(parent: DesignNode, child: DesignNode) {
  return parent.style.minColumnWidth
    ? 1
    : Math.min(child.style.columnSpan ?? 1, gridSettings(parent).count);
}
export function gridMetrics(n: DesignNode, items: DesignNode[]) {
  const i = flowInsets(n),
    inner = n.style.width - i.left - i.right,
    { count: fixedCount, gap, tracks } = gridSettings(n);
  const count = n.style.minColumnWidth
    ? Math.max(
        1,
        Math.min(
          items.length,
          Math.floor((inner + gap) / (n.style.minColumnWidth + gap)),
        ),
      )
    : fixedCount;
  const occupied = new Map<number, Set<number>>();
  function reserve(row: number, column: number, across: number, down: number) {
    for (let r = row; r < row + down; r++) {
      const used = occupied.get(r) ?? new Set<number>();
      for (let c = column; c < column + across; c++) used.add(c);
      occupied.set(r, used);
    }
  }
  const cells = items.map((child) => {
    const across = n.style.minColumnWidth
        ? 1
        : Math.min(count, child.style.columnSpan ?? 1),
      down = child.style.rowSpan ?? 1;
    const cell = !n.style.minColumnWidth && child.style.gridCell;
    const column = cell ? Math.min(cell.column - 1, count - across) : -1;
    const row = cell ? cell.row - 1 : -1;
    if (cell) reserve(row, column, across, down);
    return { child, column, row, across, down };
  });
  const rowTracks = n.style.gridRowTracks
    ? parseTracks(n.style.gridRowTracks)
    : [];
  const fixedRow = (r: number) =>
    rowTracks[r]
      ? rowTracks[r].unit === "px"
        ? rowTracks[r].value
        : undefined
      : n.style.gridRowHeight;
  const heights: number[] = rowTracks.map((_, r) => fixedRow(r) ?? 0);
  const rowGap = n.style.rowGap ?? gap;
  let cursorRow = 0,
    cursorColumn = 0;
  for (const cell of cells) {
    const { child, across, down } = cell;
    if (cell.row === -1) {
      scan: for (; ; cursorColumn++) {
        if (cursorColumn + across > count) {
          cursorRow++;
          cursorColumn = 0;
        }
        for (let r = cursorRow; r < cursorRow + down; r++)
          for (let c = cursorColumn; c < cursorColumn + across; c++)
            if (occupied.get(r)?.has(c)) continue scan;
        break;
      }
      cell.row = cursorRow;
      cell.column = cursorColumn;
      reserve(cursorRow, cursorColumn, across, down);
      cursorColumn += across;
    }
    const { row } = cell;
    while (heights.length < row + down)
      heights.push(fixedRow(heights.length) ?? 0);
    if (!fixedRow(row) && down === 1)
      heights[row] = Math.max(heights[row], child.style.height);
  }
  if (rowTracks.length || !n.style.gridRowHeight) {
    // Equal-span items size their tracks against the same starting heights.
    // Commit the largest requested increase per track before the next span length.
    const spanning = cells
      .filter((c) => c.down > 1)
      .sort((a, b) => a.down - b.down);
    let planned = new Map<number, number>();
    function distribute() {
      for (const [index, extra] of planned) heights[index] += extra;
      planned.clear();
    }
    for (const [i, { child, row, down }] of spanning.entries()) {
      if (i && spanning[i - 1].down !== down) distribute();
      const existing = heights
        .slice(row, row + down)
        .reduce((sum, h) => sum + h, (down - 1) * rowGap);
      const flexible = heights
        .slice(row, row + down)
        .filter((_, j) => !fixedRow(row + j)).length;
      const extra = flexible
        ? Math.max(0, child.style.height - existing) / flexible
        : 0;
      for (let j = row; j < row + down; j++)
        if (!fixedRow(j)) planned.set(j, Math.max(planned.get(j) ?? 0, extra));
    }
    distribute();
  }
  const flexRows = rowTracks.flatMap((t, index) =>
    t.unit === "fr" ? [{ index, weight: t.value }] : [],
  );
  if (flexRows.length) {
    const fixedHeight = heights.reduce(
      (sum, h, r) => sum + (rowTracks[r]?.unit === "fr" ? 0 : h),
      0,
    );
    const available =
      n.style.height -
      i.top -
      i.bottom -
      fixedHeight -
      (heights.length - 1) * rowGap;
    const unit =
      n.style.heightMode === "hug"
        ? Math.max(...flexRows.map((r) => heights[r.index] / r.weight))
        : Math.max(0, available) /
          Math.max(
            1,
            flexRows.reduce((sum, r) => sum + r.weight, 0),
          );
    for (const r of flexRows) heights[r.index] = unit * r.weight;
  }
  // Intrinsic columns take their content contribution before flexible space is divided.
  const cols =
    tracks ?? Array.from({ length: count }, () => ({ value: 1, unit: "fr" }));
  const widths = cols.map((t) => (t.unit === "px" ? t.value : 0));
  if (cols.some((t) => t.unit === "auto")) {
    const contributions = cells
      .filter(
        (c) =>
          !cols
            .slice(c.column, c.column + c.across)
            .some((t) => t.unit === "fr"),
      )
      .sort((a, b) => a.across - b.across);
    const extra = new Map<number, number>();
    const flush = () => {
      for (const [index, n] of extra) widths[index] += n;
      extra.clear();
    };
    for (const [index, c] of contributions.entries()) {
      if (index && contributions[index - 1].across !== c.across) flush();
      const span = cols.slice(c.column, c.column + c.across),
        autos = span.filter((t) => t.unit === "auto").length;
      if (!autos) continue;
      const used = widths
        .slice(c.column, c.column + c.across)
        .reduce((a, b) => a + b, (c.across - 1) * gap);
      const needed = Math.max(0, c.child.style.width - used) / autos;
      span.forEach((t, j) => {
        if (t.unit === "auto")
          extra.set(
            c.column + j,
            Math.max(extra.get(c.column + j) ?? 0, needed),
          );
      });
    }
    flush();
  }
  const fixed = widths.reduce((a, b) => a + b, 0);
  const fractions = cols.reduce(
    (a, t) => a + (t.unit === "fr" ? t.value : 0),
    0,
  );
  const width =
    Math.max(0, inner - (count - 1) * gap - fixed) / Math.max(1, fractions);
  let intrinsicFraction = 0;
  for (const c of cells) {
    const span = cols.slice(c.column, c.column + c.across);
    const fr = span.reduce((a, t) => a + (t.unit === "fr" ? t.value : 0), 0);
    if (fr) {
      const used = widths
        .slice(c.column, c.column + c.across)
        .reduce((a, b) => a + b, (c.across - 1) * gap);
      intrinsicFraction = Math.max(
        intrinsicFraction,
        (c.child.style.width - used) / fr,
      );
    }
  }
  const starts = [0];
  cols.forEach((t, j) =>
    starts.push(
      starts[j] + (t.unit === "fr" ? width * t.value : widths[j]) + gap,
    ),
  );
  const tops = [0];
  for (const height of heights)
    tops.push(tops[tops.length - 1] + height + rowGap);
  return {
    count,
    width,
    starts,
    intrinsicWidth:
      fixed + Math.max(1, fractions) * intrinsicFraction + (count - 1) * gap,
    gap,
    heights,
    height: Math.max(0, tops[tops.length - 1] - rowGap),
    cells: cells.map((c) => ({
      ...c,
      x: starts[c.column],
      y: tops[c.row],
      width: starts[c.column + c.across] - starts[c.column] - gap,
      height: tops[c.row + c.down] - tops[c.row] - rowGap,
    })),
  };
}

/** Flex line breaks use each item's preferred outer width, including Fill items. */
export function rowLines(parent: DesignNode, items: DesignNode[]) {
  const inset = flowInsets(parent);
  const available = parent.style.width - inset.left - inset.right;
  const lines: DesignNode[][] = [];
  let used = 0;
  for (const item of items) {
    if (item.hidden || item.style.absolutePosition) continue;
    let line = lines.at(-1);
    if (
      !line ||
      used + parent.style.gap + item.style.width > available + 0.001
    ) {
      line = [];
      lines.push(line);
      used = 0;
    }
    used += (line.length ? parent.style.gap : 0) + item.style.width;
    line.push(item);
  }
  return lines;
}

export type MeasureText = (
  node: DesignNode,
  width?: number,
) => { width: number; height: number };
let textMetrics: MeasureText | undefined;
export function configureTextMetrics(measure: MeasureText) {
  textMetrics = measure;
}
export function sizeScene(doc: DesignDocument): DesignDocument {
  if (
    !doc.nodes.some(
      (n) =>
        n.style.layoutReverse ||
        n.style.justifyContent === "space-between" ||
        n.style.absolutePosition ||
        n.style.layoutBreakpoints?.length ||
        n.style.widthMode ||
        n.style.heightMode ||
        n.style.minWidth ||
        n.style.maxWidth ||
        n.style.minHeight ||
        n.style.maxHeight,
    )
  )
    return doc;
  const nodes = doc.nodes.map((n) => ({ ...n, style: { ...n.style } })),
    children = new Map<string | null, DesignNode[]>();
  for (const n of nodes) {
    const siblings = children.get(n.parentId);
    if (siblings) siblings.push(n);
    else children.set(n.parentId, [n]);
  }
  const roots = children.get(null) ?? [];
  const originals = new Map(doc.nodes.map((n) => [n.id, n]));
  function resolveSpacing(n: DesignNode) {
    const source = originals.get(n.id)!.style;
    if (source.layoutBreakpoints?.length)
      Object.assign(n.style, responsiveSpacing(source, n.style.width));
  }
  function measure(n: DesignNode, axis: Axis, parent?: DesignNode) {
    resolveSpacing(n);
    const items = children.get(n.id) ?? [];
    for (const item of items) measure(item, axis, n);
    measureContent(n, axis, parent, items);
    n.style[axis] = clampSize(n, axis, n.style[axis]);
  }
  function measureContent(
    n: DesignNode,
    axis: Axis,
    parent: DesignNode | undefined,
    items: DesignNode[],
  ) {
    const visible = items.filter(
        (item) => !item.hidden && !item.style.absolutePosition,
      ),
      i = flowInsets(n);
    if (sizingMode(n, parent, axis) === "hug") {
      if (n.type === "button") {
        // Native buttons render with 8px padding on either side of the label.
        if (textMetrics) n.style.width = textMetrics(n).width + 16;
        return;
      }
      if (n.type === "text") {
        const source = currentTextLayout(n) ?? currentTextShape(n);
        if (source) n.style[axis] = source[axis];
        else if (textMetrics)
          n.style[axis] = textMetrics(
            n,
            axis === "height" ? n.style.width : undefined,
          )[axis];
        if (axis === "height" && n.style.maxLines)
          n.style.height = Math.min(
            n.style.height,
            n.style.maxLines * (n.style.lineHeight ?? n.style.fontSize * 1.4),
          );
        return;
      }
      if (n.style.layout === "grid") {
        const grid = gridMetrics(n, visible);
        n.style[axis] = Math.max(
          1,
          axis === "width"
            ? i.left +
                i.right +
                (n.style.minColumnWidth
                  ? Math.max(0, ...visible.map((c) => c.style.width))
                  : grid.intrinsicWidth)
            : i.top + i.bottom + grid.height,
        );
        return;
      }
      if (axis === "height" && wraps(n)) {
        const lines = rowLines(n, visible);
        n.style.height = Math.max(
          1,
          i.top +
            i.bottom +
            lines.reduce(
              (sum, line) => sum + Math.max(...line.map((c) => c.style.height)),
              0,
            ) +
            Math.max(0, lines.length - 1) * (n.style.rowGap ?? n.style.gap),
        );
        return;
      }
      const main = (axis === "width") === (n.style.layout === "row"),
        inset = axis === "width" ? i.left + i.right : i.top + i.bottom;
      const content = main
        ? visible.reduce((sum, c) => sum + c.style[axis], 0) +
          Math.max(0, visible.length - 1) * n.style.gap
        : Math.max(0, ...visible.map((c) => c.style[axis]));
      n.style[axis] = Math.max(Math.min(1, n.style[axis]), inset + content);
    }
  }
  function allocate(n: DesignNode, axis: Axis) {
    resolveSpacing(n);
    const items = children.get(n.id) ?? [],
      visible = items.filter((c) => !c.hidden && !c.style.absolutePosition),
      i = flowInsets(n);
    const wrapped = wraps(n);
    if (
      n.style.layout === "free" &&
      n.style[axis] !== originals.get(n.id)!.style[axis]
    )
      for (const c of items)
        constrainAxis(c, axis, originals.get(n.id)!.style[axis], n.style[axis]);
    const grid = n.style.layout === "grid" ? gridMetrics(n, visible) : null;
    if (grid) {
      for (const cell of grid.cells)
        if (sizingMode(cell.child, n, axis) === "fill")
          cell.child.style[axis] = clampSize(cell.child, axis, cell[axis]);
    }
    for (const line of grid ? [] : wrapped ? rowLines(n, visible) : [visible]) {
      const flexible = line.filter((c) => sizingMode(c, n, axis) === "fill");
      if (!flexible.length) continue;
      const main = (axis === "width") === (n.style.layout === "row"),
        space =
          n.style[axis] -
          (axis === "width" ? i.left + i.right : i.top + i.bottom);
      if (wrapped) {
        if (main) {
          const fixed = line
            .filter((c) => sizingMode(c, n, axis) !== "fill")
            .reduce((sum, c) => sum + c.style[axis], 0);
          distributeFill(
            flexible,
            axis,
            space - fixed - (line.length - 1) * n.style.gap,
            true,
          );
        } else {
          const cross = Math.max(...line.map((c) => c.style[axis]));
          for (const c of flexible) c.style[axis] = clampSize(c, axis, cross);
        }
        continue;
      }
      const fixed = line.reduce(
        (sum, c) =>
          sum + (sizingMode(c, n, axis) === "fill" ? 0 : c.style[axis]),
        0,
      );
      if (main)
        distributeFill(
          flexible,
          axis,
          space - fixed - Math.max(0, visible.length - 1) * n.style.gap,
          false,
        );
      else for (const c of flexible) c.style[axis] = clampSize(c, axis, space);
    }
    for (const child of items) allocate(child, axis);
  }
  for (const axis of ["width", "height"] as const) {
    for (const root of roots) {
      measure(root, axis);
      allocate(root, axis);
    }
  }
  // Geometry consumers walk a measured scene. Materialize these frames into
  // local coordinates after Hug and Fill settle, preserving the editable scene.
  for (const parent of nodes) {
    if (!flow(parent)) continue;
    const items = children.get(parent.id) ?? [];
    if (
      !parent.style.layoutReverse &&
      parent.style.justifyContent !== "space-between" &&
      !items.some((c) => c.style.absolutePosition)
    )
      continue;
    positionFlow(
      parent,
      items.filter((c) => !c.hidden && !c.style.absolutePosition),
    );
    parent.style.layout = "free";
  }
  return { ...doc, nodes };
}
function positionFlow(parent: DesignNode, items: DesignNode[]) {
  const s = parent.style,
    inset = flowInsets(parent);
  const align = (room: number, value?: string) =>
    value === "end" ? room : value === "center" ? room / 2 : 0;
  if (s.layout === "grid") {
    for (const cell of gridMetrics(parent, items).cells) {
      const child = cell.child.style;
      child.x = inset.left + cell.x + align(cell.width - child.width, s.alignX);
      child.y =
        inset.top + cell.y + align(cell.height - child.height, s.alignY);
    }
    return;
  }
  const row = s.layout === "row",
    main = row ? "width" : "height",
    cross = row ? "height" : "width";
  const width = s.width - inset.left - inset.right,
    height = s.height - inset.top - inset.bottom;
  const wrapped = wraps(parent);
  let crossStart = row ? inset.top : inset.left;
  for (const line of wrapped ? rowLines(parent, items) : [items]) {
    const remaining =
      (row ? width : height) -
      line.reduce((sum, c) => sum + c.style[main], 0) -
      Math.max(0, line.length - 1) * s.gap;
    const between = s.justifyContent === "space-between";
    const gap =
      s.gap +
      (between && line.length > 1
        ? Math.max(0, remaining) / (line.length - 1)
        : 0);
    let cursor =
      (row ? inset.left : inset.top) +
      (between ? 0 : align(remaining, row ? s.alignX : s.alignY));
    const lineSize = wrapped
      ? Math.max(...line.map((c) => c.style[cross]))
      : row
        ? height
        : width;
    for (const child of s.layoutReverse ? line.slice().reverse() : line) {
      child.style[row ? "x" : "y"] = cursor;
      child.style[row ? "y" : "x"] =
        crossStart +
        align(lineSize - child.style[cross], row ? s.alignY : s.alignX);
      cursor += child.style[main] + gap;
    }
    crossStart += lineSize + (s.rowGap ?? s.gap);
  }
}
// Give each reversed stack its own inherited variable, including for a fill
// child that is itself a stack. The shared border-box basis compensates for
// CSS flexbox's minimum content insets without changing layer paint order.
const reverseBasis = (parent: DesignNode) =>
  "--forma-fill-" +
  Array.from(parent.id, (ch) => ch.codePointAt(0)!.toString(16)).join("-");

export function sizingCss(
  node: DesignNode,
  parent?: DesignNode,
): Record<string, string | number> {
  const css: Record<string, string | number> = {};
  if (parent?.style.layout === "grid" && !node.style.absolutePosition) {
    const bp = gridBreakpoint(parent);
    const count = parent.style.gridTracks
      ? parseTracks(parent.style.gridTracks).length
      : (parent.style.columns ?? 2);
    const max = bp ? `var(${bp.variable}, ${count})` : String(count);
    const across = parent.style.minColumnWidth
      ? 1
      : (node.style.columnSpan ?? 1);
    const span = bp
      ? `min(${across}, ${max})`
      : String(Math.min(across, count));
    const cell = !parent.style.minColumnWidth && node.style.gridCell;
    if (cell) {
      const start = bp
        ? `min(${cell.column}, calc(${max} - ${span} + 1))`
        : String(Math.min(cell.column, count - Number(span) + 1));
      css.gridColumn = `${start} / span ${span}`;
      css.gridRow = `${cell.row} / span ${node.style.rowSpan ?? 1}`;
    } else {
      if (across > 1) css.gridColumn = "span " + span;
      if ((node.style.rowSpan ?? 1) > 1)
        css.gridRow = "span " + node.style.rowSpan;
    }
  }
  for (const axis of ["width", "height"] as const) {
    const mode = sizingMode(node, parent, axis);
    if (mode === "fixed") continue;
    css[axis === "width" ? "minWidth" : "minHeight"] = 1;
    if (mode === "hug") css[axis] = "max-content";
    else if (parent?.style.layout === "grid") {
      css[axis] = "auto";
      css[axis === "width" ? "justifySelf" : "alignSelf"] = "stretch";
      if (
        axis === "height" &&
        !parent.style.gridRowHeight &&
        !parent.style.gridRowTracks
      )
        css.minHeight = node.style.height;
    } else if (wraps(parent) && axis === "width") {
      css.flexGrow = 1;
      css.flexBasis = node.style.width;
    } else if ((axis === "width") === (parent?.style.layout === "row")) {
      css[axis] = "100%";
      css.flexBasis = parent?.style.layoutReverse
        ? "var(" + reverseBasis(parent) + ", 0px)"
        : 0;
      if (parent?.style.layoutReverse) css.flexShrink = 1;
      css.flexGrow = 1;
    } else {
      css[axis] = "auto";
      css.alignSelf = "stretch";
      css.justifySelf = "stretch";
      if (wraps(parent)) css.minHeight = node.style.height;
    }
  }
  for (const key of ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const)
    if (node.style[key] !== undefined) css[key] = node.style[key]!;
  return css;
}
export function trackCss(
  node: DesignNode,
  items: DesignNode[],
): Record<string, string | number> {
  const row = node.style.layout === "row",
    axis = row ? "width" : "height",
    visible = items.filter((c) => !c.hidden && !c.style.absolutePosition);
  if (wraps(node))
    return {
      flexWrap: "wrap",
      rowGap: node.style.rowGap ?? node.style.gap,
      alignContent: "start",
    };
  if (node.style.layout === "grid") {
    const bp = gridBreakpoint(node);
    return {
      display: "grid",
      gridTemplateColumns: node.style.minColumnWidth
        ? `repeat(auto-fit,minmax(min(100%, ${node.style.minColumnWidth}px),1fr))`
        : node.style.gridTracks
          ? (() => {
              const list = parseTracks(node.style.gridTracks)
                .map(trackCssValue)
                .join(" ");
              return bp
                ? "var(" + bp.variable + "-tracks, " + list + ")"
                : list;
            })()
          : `repeat(${bp ? "var(" + bp.variable + ", " + (node.style.columns ?? 2) + ")" : (node.style.columns ?? 2)},minmax(0,1fr))`,
      ...(node.style.gridRowTracks
        ? {
            gridTemplateRows: parseTracks(node.style.gridRowTracks)
              .map(trackCssValue)
              .join(" "),
          }
        : {}),
      gridAutoRows: node.style.gridRowHeight
        ? node.style.gridRowHeight + "px"
        : "max-content",
      alignContent: "start",
      ...(node.style.rowGap === undefined ? {} : { rowGap: node.style.rowGap }),
      justifyItems: node.style.alignX ?? "start",
      alignItems: node.style.alignY ?? "start",
    };
  }
  if (node.style.layoutReverse) {
    let basis = 0;
    for (const child of visible) {
      if (sizingMode(child, node, axis) !== "fill") continue;
      const i = flowInsets(child);
      basis = Math.max(basis, row ? i.left + i.right : i.top + i.bottom);
    }
    return basis ? { [reverseBasis(node)]: basis + "px" } : {};
  }
  if (!flow(node) || !visible.some((c) => sizingMode(c, node, axis) === "fill"))
    return {};
  if (
    visible.some(
      (c) =>
        sizingMode(c, node, axis) === "fill" &&
        limits(c, axis).some((v) => v !== undefined),
    )
  )
    return {};
  const tracks = visible
    .map((c) =>
      sizingMode(c, node, axis) === "fill" ? "minmax(1px, 1fr)" : "max-content",
    )
    .join(" ");
  return {
    display: "grid",
    gridAutoFlow: row ? "column" : "row",
    gridTemplateColumns: row ? tracks : "minmax(0, 1fr)",
    gridTemplateRows: row ? "minmax(0, 1fr)" : tracks,
    alignItems: node.style.alignY ?? "start",
    justifyItems: node.style.alignX ?? "start",
  };
}
