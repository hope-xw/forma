import type { Operation } from "../domain/commands";
import {
  isNestedProperty,
  type NestedProperty,
} from "../domain/design-properties";
import { resolveNode } from "../domain/design-system";
import type { DesignDocument, DesignNode, NodeStyle } from "../domain/document";
import type { Point, Rect } from "../domain/geometry";
import { layoutRuleAt } from "../domain/layout-breakpoints";
import { childrenOf } from "../domain/scene-index";
import { flowInsets } from "../domain/sizing";
import { instanceAncestor, isLocked, isVisible } from "../domain/tree";

export type CornerKey = "tl" | "tr" | "br" | "bl";
export interface CornerRadii {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}
export interface CornerHandleSpec {
  corner: CornerKey;
  radius: number;
  maxRadius: number;
  localPoint: Point;
}
export type PaddingSide = "top" | "right" | "bottom" | "left";
export interface PaddingInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
export interface PaddingHandleSpec {
  side: PaddingSide;
  value: number;
  bandRect: Rect;
  handlePoint: Point;
  orientation: "horizontal" | "vertical";
}
export interface GapHandleSpec {
  index: number;
  axis: "x" | "y";
  value: number;
  bandRect: Rect;
  handlePoint: Point;
}

const cornerKeys: CornerKey[] = ["tl", "tr", "br", "bl"];
const sides: PaddingSide[] = ["top", "right", "bottom", "left"];
const opposite: Record<PaddingSide, PaddingSide> = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right",
};
const uniformRadii = (r: number): CornerRadii => ({
  tl: r,
  tr: r,
  br: r,
  bl: r,
});
const center = (r: Rect): Point => ({
  x: r.x + r.width / 2,
  y: r.y + r.height / 2,
});
const maxRadius = (box: Rect) =>
  Math.max(0, Math.floor(Math.min(box.width, box.height) / 2));
function snapped(value: number, min: number, max: number, snapStep = 1) {
  const step = Math.max(1, snapStep);
  return Math.max(min, Math.min(max, Math.round(value / step) * step));
}
function update(
  node: DesignNode,
  style: Partial<NodeStyle>,
  variableBindings?: DesignNode["variableBindings"],
): Operation[] {
  return [
    {
      type: "update",
      id: node.id,
      patch: variableBindings ? { variableBindings } : {},
      style,
    },
  ];
}
/** Make the style edit and its binding migration one undoable update. */
function updateWithSplitBinding(
  node: DesignNode,
  uniform: "radius" | "padding",
  style: Partial<NodeStyle>,
  untouched: NestedProperty[],
) {
  const original = node.variableBindings;
  if (!original) return update(node, style);
  const keys =
    uniform === "radius"
      ? cornerKeys.map((key) => `corners.${key}` as const)
      : sides.map((key) => `insets.${key}` as const);
  const hasExplicitParts =
    (uniform === "radius" ? node.style.corners : node.style.insets) !==
    undefined;
  const bindingKeys = Object.keys(original);
  const uniformIndex = bindingKeys.indexOf(uniform);
  const firstFineIndex = bindingKeys.findIndex((key) =>
    keys.some((part) => part === key),
  );
  if (uniformIndex < 0 && firstFineIndex < 0) return update(node, style);
  // resolveNode expands the first fine binding using the shorthand value at that point.
  const uniformBindingActive =
    !hasExplicitParts &&
    uniformIndex >= 0 &&
    (firstFineIndex < 0 || uniformIndex < firstFineIndex);
  // A partial edit of explicit or bound parts leaves the shadowed literal in place.
  if (uniformIndex >= 0 && !uniformBindingActive && untouched.length)
    delete style[uniform];
  const bindings = { ...original };
  delete bindings[uniform];
  for (const key of keys) {
    if (!untouched.includes(key)) delete bindings[key];
    else if (uniformBindingActive) bindings[key] ??= original[uniform];
  }
  return update(node, style, bindings);
}
/** A token scoped only to the shorthand cannot legally be reassigned to its parts. */
export function checkHandleBindingScopes(
  doc: DesignDocument,
  operations: Operation[],
) {
  for (const op of operations) {
    if (op.type !== "update" || !op.patch.variableBindings) continue;
    for (const [key, id] of Object.entries(op.patch.variableBindings)) {
      if (!isNestedProperty(key)) continue;
      const token = doc.designSystem?.variables[id];
      if (token?.scopes.length && !token.scopes.includes(key))
        throw new Error(
          `变量「${token.name}」的作用域不含 ${key}。请在设计系统中调整该变量的作用域后再局部拖动。`,
        );
    }
  }
  return operations;
}
function editable(doc: DesignDocument, node: DesignNode) {
  return (
    !node.hidden &&
    !node.componentSet &&
    !isLocked(doc, node.id) &&
    !instanceAncestor(doc, node.id) &&
    isVisible(doc, node.id)
  );
}

export function getNodeCornerRadii(node: DesignNode): CornerRadii {
  return node.style.corners ?? uniformRadii(node.style.radius);
}
export function canEditCornerRadius(
  doc: DesignDocument,
  node: DesignNode,
): boolean {
  return (
    (node.type === "rectangle" ||
      node.type === "frame" ||
      node.type === "button") &&
    !node.instance &&
    editable(doc, node)
  );
}

/** Reflect a local point between the top-left and a given corner's inward axes. */
export function cornerCoordinates(
  box: Rect,
  corner: CornerKey,
  point: Point,
): Point {
  return {
    x: corner === "tr" || corner === "br" ? box.width - point.x : point.x,
    y: corner === "bl" || corner === "br" ? box.height - point.y : point.y,
  };
}
export function getCornerHandleSpecs(
  node: DesignNode,
  box: Rect,
  zoom: number,
): CornerHandleSpec[] {
  const shortSide = Math.min(box.width, box.height) * zoom;
  const maxScreenOffset = shortSide / 2 - 14;
  if (
    shortSide < 56 ||
    maxScreenOffset < 12 ||
    layoutRuleAt(node.style, box.width)?.radius !== undefined
  )
    return [];
  const radii = getNodeCornerRadii(node);
  return cornerKeys.map((corner) => {
    const radius = radii[corner];
    const offset =
      Math.min(Math.max(12, radius * zoom * 0.72 + 4), maxScreenOffset) / zoom;
    return {
      corner,
      radius,
      maxRadius: maxRadius(box),
      localPoint: cornerCoordinates(box, corner, { x: offset, y: offset }),
    };
  });
}
export function computeCornerRadiusDrag({
  node,
  initialRadii = getNodeCornerRadii(node),
  box,
  corner,
  localPoint,
  singleCorner,
  snapStep,
}: {
  node: DesignNode;
  initialRadii?: CornerRadii;
  box: Rect;
  corner: CornerKey;
  localPoint: Point;
  singleCorner: boolean;
  snapStep?: number;
}) {
  const inward = cornerCoordinates(box, corner, localPoint);
  // The projection onto (1, 1) has equal x/y components, each in radius pixels.
  const value = snapped(
    (inward.x + inward.y) / 2,
    0,
    Math.min(10000, maxRadius(box)),
    snapStep,
  );
  const corners = singleCorner
    ? { ...initialRadii, [corner]: value }
    : uniformRadii(value);
  return {
    value,
    corners,
    singleCorner,
    operations: updateWithSplitBinding(
      node,
      "radius",
      {
        radius: corners.tl,
        corners: singleCorner ? corners : undefined,
      },
      singleCorner
        ? cornerKeys
            .filter((key) => key !== corner)
            .map((key) => `corners.${key}` as const)
        : [],
    ),
  };
}

export function canEditAutoLayoutHandles(
  doc: DesignDocument,
  node: DesignNode,
): boolean {
  return (
    node.type === "frame" &&
    (node.style.layout === "row" || node.style.layout === "column") &&
    !node.instance &&
    editable(doc, node)
  );
}
export function getNodeInsets(node: DesignNode): PaddingInsets {
  const p = node.style.padding;
  return node.style.insets ?? { top: p, right: p, bottom: p, left: p };
}

function paddingHandles(node: DesignNode, box: Rect): PaddingHandleSpec[] {
  const insets = getNodeInsets(node);
  const outer = flowInsets(node);
  return sides.map((side) => {
    const horizontal = side === "top" || side === "bottom";
    const extent = horizontal ? box.height : box.width;
    const value = insets[side];
    // A layout stroke sits outside the editable padding.
    const border = Math.min(extent, outer[side] - value);
    const thickness = Math.min(extent - border, value);
    const start =
      side === "bottom" || side === "right"
        ? extent - border - thickness
        : border;
    const bandRect = horizontal
      ? { x: 0, y: start, width: box.width, height: thickness }
      : { x: start, y: 0, width: thickness, height: box.height };
    return {
      side,
      value,
      bandRect,
      handlePoint: center(bandRect),
      orientation: horizontal ? "horizontal" : "vertical",
    };
  });
}

export function getAutoLayoutHandleSpecs(
  doc: DesignDocument,
  node: DesignNode,
  bounds: Map<string, Rect>,
  zoom = 1,
): {
  paddings: PaddingHandleSpec[];
  gaps: GapHandleSpec[];
} {
  const box = bounds.get(node.id);
  if (
    !box ||
    Math.min(box.width, box.height) * zoom < 32 ||
    !canEditAutoLayoutHandles(doc, node)
  )
    return { paddings: [], gaps: [] };
  const rule = layoutRuleAt(node.style, box.width);
  const paddings = rule?.padding === undefined ? paddingHandles(node, box) : [];
  const gaps: GapHandleSpec[] = [];
  if (
    rule?.gap !== undefined ||
    (node.style.layout === "column" && rule?.rowGap !== undefined) ||
    node.style.justifyContent === "space-between"
  )
    return { paddings, gaps };
  const row = node.style.layout === "row";
  const main = row ? "x" : "y",
    length = row ? "width" : "height";
  const cross = row ? "y" : "x",
    breadth = row ? "height" : "width";
  const children = childrenOf(doc, node.id).filter(
    (child) => !resolveNode(doc, child).hidden && !child.style.absolutePosition,
  );
  for (let i = 1; i < children.length; i++) {
    const previous = bounds.get(children[i - 1].id),
      current = bounds.get(children[i].id);
    if (!previous || !current) continue;
    const [a, b] = node.style.layoutReverse
      ? [current, previous]
      : [previous, current];
    const near = a[main] + a[length],
      far = b[main];
    const crossStart = Math.max(a[cross], b[cross]);
    const crossEnd = Math.min(a[cross] + a[breadth], b[cross] + b[breadth]);
    // At a line break the cross intervals are disjoint. Zero-height children
    // can touch, and negative line spacing can overlap: check main-axis advance then.
    if (node.style.wrap) {
      if (
        crossEnd < crossStart ||
        (crossEnd === crossStart && a[breadth] > 0 && b[breadth] > 0) ||
        ((crossEnd === crossStart ||
          (node.style.rowGap ?? node.style.gap) < 0) &&
          Math.abs(far - near - node.style.gap) > 0.01)
      )
        continue;
    }
    const start = Math.min(near, far) - box[main],
      size = Math.abs(far - near);
    const across = crossStart - box[cross],
      span = Math.max(0, crossEnd - crossStart);
    const bandRect = row
      ? { x: start, y: across, width: size, height: span }
      : { x: across, y: start, width: span, height: size };
    gaps.push({
      index: gaps.length,
      axis: main,
      value: node.style.gap,
      bandRect,
      handlePoint: center(bandRect),
    });
  }
  return { paddings, gaps };
}
export function computePaddingDrag({
  node,
  side,
  initialInsets,
  inwardDelta,
  symmetric,
  allSides,
  snapStep,
}: {
  node: DesignNode;
  side: PaddingSide;
  initialInsets: PaddingInsets;
  inwardDelta: number;
  symmetric: boolean;
  allSides: boolean;
  snapStep?: number;
}) {
  const value = snapped(initialInsets[side] + inwardDelta, 0, 1000, snapStep);
  const affectedSides = allSides
    ? [...sides]
    : symmetric
      ? [side, opposite[side]]
      : [side];
  const insets = { ...initialInsets };
  for (const edge of affectedSides) insets[edge] = value;
  const uniform = sides.every((edge) => insets[edge] === value);
  return {
    value,
    insets,
    affectedSides,
    operations: updateWithSplitBinding(
      node,
      "padding",
      uniform ? { padding: value, insets } : { insets },
      sides
        .filter((edge) => !affectedSides.includes(edge))
        .map((edge) => `insets.${edge}` as const),
    ),
  };
}
export function computeGapDrag({
  node,
  initialGap,
  delta,
  snapStep,
}: {
  node: DesignNode;
  initialGap: number;
  delta: number;
  snapStep?: number;
}) {
  const value = snapped(
    initialGap + delta,
    (node.style.layout === "row" || node.style.layout === "column") &&
      !node.style.wrap
      ? -1000
      : 0,
    1000,
    snapStep,
  );
  const bindings = node.variableBindings?.gap
    ? { ...node.variableBindings }
    : undefined;
  if (bindings) delete bindings.gap;
  return { value, operations: update(node, { gap: value }, bindings) };
}
