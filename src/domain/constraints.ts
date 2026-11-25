import { maxLayerDimension } from "./document-limits";
import { strokeInset } from "./stroke";
import type { DesignDocument, DesignNode } from "./document";
export type Constraint = "start" | "center" | "end" | "stretch" | "scale";
export function anchor(
  mode: Constraint | undefined,
  pos: number,
  size: number,
  before: number,
  after: number,
) {
  const delta = after - before;
  switch (mode) {
    case "center":
      return { pos: pos + delta / 2, size };
    case "end":
      return { pos: pos + delta, size };
    case "stretch":
      return { pos, size: Math.max(Math.min(1, size), size + delta) };
    case "scale": {
      const factor = before > 0 ? after / before : 1;
      return {
        pos: pos * factor,
        size: Math.max(Math.min(1, size), size * factor),
      };
    }
    default:
      return { pos, size };
  }
}
export function constrainAxis(
  node: DesignNode,
  axis: "width" | "height",
  before: number,
  after: number,
) {
  const pos = axis === "width" ? "x" : "y",
    mode = axis === "width" ? node.style.constraintX : node.style.constraintY;
  if (!mode || mode === "start" || before === after) return;
  const result = anchor(mode, node.style[pos], node.style[axis], before, after);
  node.style[pos] = result.pos;
  node.style[axis] = Math.min(maxLayerDimension, result.size);
}
/** Persist child geometry at the new design width so subsequent direct edits use local design coordinates. */
export function resizeAnchoredLayers(
  before: DesignDocument,
  after: DesignDocument,
): boolean {
  if (!after.nodes.some((n) => n.style.constraintX || n.style.constraintY))
    return false;
  const old = new Map(before.nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, DesignNode[]>();
  for (const n of after.nodes) {
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  let changed = false;
  const walk = (n: DesignNode) => {
    const p = old.get(n.id);
    for (const child of children.get(n.id) ?? []) {
      const prev = old.get(child.id);
      if (p && n.style.layout === "free" && prev?.parentId === n.id) {
        for (const axis of ["width", "height"] as const) {
          const pos = axis === "width" ? "x" : "y";
          if (
            prev.style[pos] === child.style[pos] &&
            prev.style[axis] === child.style[axis]
          ) {
            const bx = child.style[pos],
              bs = child.style[axis];
            constrainAxis(child, axis, p.style[axis], n.style[axis]);
            if (child.style[pos] !== bx || child.style[axis] !== bs)
              changed = true;
          }
        }
      }
      walk(child);
    }
  };
  for (const root of children.get(null) ?? []) walk(root);
  return changed;
}
export function constraintCss(n: DesignNode, parent?: DesignNode) {
  const css: Record<string, string> = {};
  if (!parent || parent.style.layout !== "free") return css;
  for (const axis of ["width", "height"] as const) {
    const mode = axis === "width" ? n.style.constraintX : n.style.constraintY,
      pos = axis === "width" ? n.style.x : n.style.y,
      property = axis === "width" ? "left" : "top",
      basis = parent.style[axis] || 1,
      inset = strokeInset(parent.style);
    const linear = (fraction: number, delta: number) =>
      `calc(${fraction * 100}% + ${delta}px)`;
    if (mode === "end" || mode === "center") {
      const fraction = mode === "end" ? 1 : 0.5;
      css[property] = linear(
        fraction,
        pos - basis * fraction + (2 * fraction - 1) * inset,
      );
    }
    if (mode === "stretch")
      css[axis] =
        `max(${Math.min(1, n.style[axis])}px, calc(100% + ${n.style[axis] - basis + 2 * inset}px))`;
    if (mode === "scale") {
      const f = pos / basis;
      css[property] = inset ? linear(f, (2 * f - 1) * inset) : f * 100 + "%";
      const fsize = n.style[axis] / basis;
      css[axis] =
        `max(${Math.min(1, n.style[axis])}px, ${linear(fsize, 2 * inset * fsize)})`;
    }
  }
  return css;
}
