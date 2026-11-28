import { createNode, type DesignDocument, type DesignNode } from "./document";
import type { Operation } from "./commands";
import { layoutBounds, union } from "./geometry";
import {
  sceneTransforms,
  poseInParent,
  identity,
  localTransform,
  visualBounds,
  inverse,
  vector,
} from "./transforms";
import { findLayer } from "./scene-index";
import { selectionRoots } from "./tree";
export type Alignment =
  | "left"
  | "center"
  | "right"
  | "top"
  | "middle"
  | "bottom"
  | "horizontal"
  | "vertical";
export function alignOperations(
  doc: DesignDocument,
  ids: string[],
  alignment: Alignment,
): Operation[] {
  const nodes = selectionRoots(doc, ids);
  const layout = layoutBounds(doc),
    matrices = sceneTransforms(doc, layout);
  const siblings = nodes.every((n) => n.parentId === nodes[0].parentId);
  // Siblings align to the parent axes. A selection spanning parents shares the canvas axes.
  const bounds = new Map(
    nodes.map((n) => {
      const rect = layout.get(n.id)!;
      return [
        n.id,
        visualBounds(
          rect,
          siblings ? localTransform(n, rect) : matrices.get(n.id)!,
        ),
      ];
    }),
  );
  const box =
    nodes.length === 1
      ? nodes[0].parentId
        ? layout.get(nodes[0].parentId)
        : undefined
      : union([...bounds.values()]);
  const reposition = (n: DesignNode, dx: number, dy: number): Operation => {
    const delta =
      siblings || !n.parentId
        ? { x: dx, y: dy }
        : vector(inverse(matrices.get(n.parentId)!), { x: dx, y: dy });
    return {
      type: "update",
      id: n.id,
      patch: {},
      style: { x: n.style.x + delta.x, y: n.style.y + delta.y },
    };
  };
  if (!box) return [];
  if (
    nodes.some((n) => {
      const p = findLayer(doc, n.parentId);
      return (
        p?.type === "frame" &&
        p.style.layout !== "free" &&
        !n.style.absolutePosition
      );
    })
  )
    throw new Error("自动布局内请调整布局对齐，或开启绝对定位后对齐");
  if (alignment === "horizontal" || alignment === "vertical") {
    if (nodes.length < 3) throw new Error("分布至少需要三个图层");
    const axis = alignment === "horizontal" ? "x" : "y",
      size = axis === "x" ? "width" : "height";
    nodes.sort((a, b) => bounds.get(a.id)![axis] - bounds.get(b.id)![axis]);
    const first = bounds.get(nodes[0].id)!;
    const last = bounds.get(nodes[nodes.length - 1].id)!;
    const middle = nodes.slice(1, -1);
    const firstEnd = first[axis] + first[size];
    const gap =
      (last[axis] -
        firstEnd -
        middle.reduce((sum, n) => sum + bounds.get(n.id)![size], 0)) /
      (nodes.length - 1);
    let cursor = firstEnd + gap;
    return middle.map((n) => {
      const delta = cursor - bounds.get(n.id)![axis];
      cursor += bounds.get(n.id)![size] + gap;
      return reposition(n, axis === "x" ? delta : 0, axis === "y" ? delta : 0);
    });
  }
  return nodes.map((n) => {
    const r = bounds.get(n.id)!;
    let dx = 0,
      dy = 0;
    if (alignment === "left") dx = box.x - r.x;
    if (alignment === "center") dx = box.x + (box.width - r.width) / 2 - r.x;
    if (alignment === "right") dx = box.x + box.width - r.width - r.x;
    if (alignment === "top") dy = box.y - r.y;
    if (alignment === "middle") dy = box.y + (box.height - r.height) / 2 - r.y;
    if (alignment === "bottom") dy = box.y + box.height - r.height - r.y;
    return reposition(n, dx, dy);
  });
}
export function wrapOperations(
  doc: DesignDocument,
  ids: string[],
  type: "group" | "frame",
  autoLayout = false,
): { operations: Operation[]; id: string } {
  const nodes = selectionRoots(doc, ids);
  if (!nodes.length) throw new Error("先选择图层");
  if (!nodes.every((n) => n.parentId === nodes[0].parentId))
    throw new Error("请先选择同一父层中的图层");
  const bounds = layoutBounds(doc);
  const rect = union(nodes.map((n) => bounds.get(n.id)!))!;
  const parent = nodes[0].parentId ? bounds.get(nodes[0].parentId) : null;
  const container = createNode(type, nodes[0].parentId);
  container.style = {
    ...container.style,
    x: rect.x - (parent?.x ?? 0),
    y: rect.y - (parent?.y ?? 0),
    width: rect.width,
    height: rect.height,
    padding: 0,
    gap: 12,
    layout: autoLayout ? "column" : "free",
    radius: 0,
  };
  const siblings = doc.nodes.filter((n) => n.parentId === container.parentId);
  const index = Math.min(
    ...nodes.map((n) => siblings.findIndex((s) => s.id === n.id)),
  );
  const operations: Operation[] = [
    { type: "create", node: container },
    { type: "reorder", id: container.id, index },
  ];
  for (const n of nodes) {
    const b = bounds.get(n.id)!;
    operations.push(
      { type: "move", id: n.id, parentId: container.id },
      {
        type: "update",
        id: n.id,
        patch: {},
        style: { x: b.x - rect.x, y: b.y - rect.y },
      },
    );
  }
  if (autoLayout)
    operations.push({
      type: "update",
      id: container.id,
      patch: {},
      style: {
        height:
          nodes.reduce((sum, n) => sum + n.style.height, 0) +
          12 * (nodes.length - 1),
        width: Math.max(...nodes.map((n) => n.style.width)),
      },
    });
  return { operations, id: container.id };
}
export function ungroupOperations(
  doc: DesignDocument,
  ids: string[],
): { operations: Operation[]; selection: string[] } {
  const operations: Operation[] = [];
  const selection: string[] = [];
  const bounds = layoutBounds(doc);
  const matrices = sceneTransforms(doc, bounds);
  for (const group of selectionRoots(doc, ids)) {
    if (group.type !== "group") continue;
    const parent = group.parentId ? bounds.get(group.parentId) : null;
    const index = doc.nodes
      .filter((n) => n.parentId === group.parentId)
      .findIndex((n) => n.id === group.id);
    doc.nodes
      .filter((n) => n.parentId === group.id)
      .forEach((child, i) => {
        const b = bounds.get(child.id)!;
        operations.push(
          {
            type: "move",
            id: child.id,
            parentId: group.parentId,
            index: index + i,
          },
          {
            type: "update",
            id: child.id,
            patch: {},
            style: poseInParent(
              child,
              b,
              matrices.get(child.id)!,
              parent ?? undefined,
              matrices.get(group.parentId ?? "") ?? identity,
            ),
          },
        );
        selection.push(child.id);
      });
    operations.push({ type: "remove", id: group.id });
  }
  return { operations, selection };
}
export function reparentOperations(
  doc: DesignDocument,
  ids: string[],
  parentId: string | null,
  index?: number,
): Operation[] {
  const bounds = layoutBounds(doc),
    parent = parentId ? bounds.get(parentId) : null;
  const matrices = sceneTransforms(doc, bounds);
  const operations: Operation[] = [];
  selectionRoots(doc, ids).forEach((node, i) => {
    const rect = bounds.get(node.id)!;
    operations.push(
      {
        type: "move",
        id: node.id,
        parentId,
        index: index === undefined ? undefined : index + i,
      },
      {
        type: "update",
        id: node.id,
        patch: {},
        style: poseInParent(
          node,
          rect,
          matrices.get(node.id)!,
          parent ?? undefined,
          matrices.get(parentId ?? "") ?? identity,
        ),
      },
    );
  });
  return operations;
}
export function layerOrderOperations(
  doc: DesignDocument,
  ids: string[],
  action: "front" | "back" | "forward" | "backward",
): Operation[] {
  const roots = selectionRoots(doc, ids);
  const selected = new Set(roots.map((n) => n.id));
  const operations: Operation[] = [];
  for (const parent of new Set(roots.map((n) => n.parentId))) {
    const parentNode = parent ? findLayer(doc, parent) : undefined;
    const reversed =
      parentNode?.type === "frame" &&
      (parentNode.style.layout === "row" ||
        parentNode.style.layout === "column") &&
      parentNode.style.firstChildOnTop;
    const effectiveAction = reversed
      ? (
          {
            front: "back",
            back: "front",
            forward: "backward",
            backward: "forward",
          } as const
        )[action]
      : action;
    const siblings = doc.nodes.filter((n) => n.parentId === parent);
    let order = [...siblings];
    if (effectiveAction === "front")
      order = [
        ...siblings.filter((n) => !selected.has(n.id)),
        ...siblings.filter((n) => selected.has(n.id)),
      ];
    if (effectiveAction === "back")
      order = [
        ...siblings.filter((n) => selected.has(n.id)),
        ...siblings.filter((n) => !selected.has(n.id)),
      ];
    if (effectiveAction === "forward")
      for (let i = order.length - 2; i >= 0; i--)
        if (selected.has(order[i].id) && !selected.has(order[i + 1].id))
          [order[i], order[i + 1]] = [order[i + 1], order[i]];
    if (effectiveAction === "backward")
      for (let i = 1; i < order.length; i++)
        if (selected.has(order[i].id) && !selected.has(order[i - 1].id))
          [order[i], order[i - 1]] = [order[i - 1], order[i]];
    const moved = order.filter((n) => selected.has(n.id));
    if (effectiveAction === "front" || effectiveAction === "forward")
      moved.reverse();
    for (const node of moved)
      operations.push({
        type: "reorder",
        id: node.id,
        index: order.findIndex((n) => n.id === node.id),
      });
  }
  return operations;
}
export function editablePatch(
  nodes: DesignNode[],
  patch: Partial<DesignNode>,
  style?: Partial<DesignNode["style"]>,
): Operation[] {
  return nodes.map((n) => ({ type: "update", id: n.id, patch, style }));
}
export { wrapInSection, findMatchingLayers } from "./section";
