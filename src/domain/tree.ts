import { resolveNode } from "./design-system";
import { childrenOf, findLayer, isPublished } from "./scene-index";
import type { DesignDocument, DesignNode } from "./document";
export function isContainer(node: DesignNode) {
  return (
    node.type === "frame" || node.type === "group" || node.type === "section"
  );
}
/** Structure protection is distinct from the user-controlled lock property. */
export function instanceAncestor(
  doc: DesignDocument,
  id: string,
): DesignNode | undefined {
  return ancestors(doc, id).find((n) => n.instance);
}
export function instanceOwner(
  doc: DesignDocument,
  id: string,
): DesignNode | undefined {
  const node = findLayer(doc, id);
  return node?.instance ? node : instanceAncestor(doc, id);
}
export const instanceGeometryKeys = new Set([
  "x",
  "y",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "widthMode",
  "heightMode",
  "rotation",
  "flipX",
  "flipY",
  "layout",
  "alignX",
  "alignY",
  "gap",
  "wrap",
  "rowGap",
  "columns",
  "gridCell",
  "columnSpan",
  "rowSpan",
  "gridTracks",
  "gridRowTracks",
  "layoutBreakpoints",
  "gridRowHeight",
  "gridBreakpoint",
  "narrowColumns",
  "narrowGap",
  "minColumnWidth",
  "viewportWidth",
  "constraintX",
  "constraintY",
  "padding",
  "insets",
]);
export function ancestors(doc: DesignDocument, id: string): DesignNode[] {
  const result: DesignNode[] = [];
  let node = findLayer(doc, id);
  const visited = new Set<string>();
  while (node?.parentId && !visited.has(node.parentId)) {
    visited.add(node.parentId);
    node = findLayer(doc, node.parentId);
    if (node) result.push(node);
  }
  return result;
}
export function selectionRoots(
  doc: DesignDocument,
  ids: readonly string[],
): DesignNode[] {
  if (!ids.length) return [];
  if (ids.length === 1) {
    const single = findLayer(doc, ids[0]);
    return single ? [single] : [];
  }
  const selected = new Set(ids);
  return doc.nodes.filter(
    (n) =>
      selected.has(n.id) &&
      !ancestors(doc, n.id).some((p) => selected.has(p.id)),
  );
}
export function subtreeIds(
  doc: DesignDocument,
  ids: readonly string[],
): Set<string> {
  const result = new Set(ids);
  if (!result.size) return result;
  if (isPublished(doc)) {
    const queue = [...result];
    for (let i = 0; i < queue.length; i++) {
      for (const child of childrenOf(doc, queue[i])) {
        if (!result.has(child.id)) {
          result.add(child.id);
          queue.push(child.id);
        }
      }
    }
    return result;
  }
  const children = new Map<string, string[]>();
  for (const n of doc.nodes) {
    if (!n.parentId) continue;
    const list = children.get(n.parentId);
    if (list) list.push(n.id);
    else children.set(n.parentId, [n.id]);
  }
  const queue = [...result];
  for (let i = 0; i < queue.length; i++) {
    for (const childId of children.get(queue[i]) ?? []) {
      if (!result.has(childId)) {
        result.add(childId);
        queue.push(childId);
      }
    }
  }
  return result;
}
export function isLocked(doc: DesignDocument, id: string): boolean {
  return (
    !!findLayer(doc, id)?.locked || ancestors(doc, id).some((n) => n.locked)
  );
}
export function isVisible(doc: DesignDocument, id: string): boolean {
  const node = findLayer(doc, id);
  return (
    !(node && resolveNode(doc, node).hidden) &&
    !ancestors(doc, id).some((n) => resolveNode(doc, n).hidden)
  );
}

/** Paste/asset insertion beside an instance, never into its protected subtree. */
export function insertionParent(
  doc: DesignDocument,
  selected?: DesignNode,
): string | null {
  if (!selected) return null;
  const owner = instanceOwner(doc, selected.id);
  if (owner) return owner.parentId;
  return isContainer(selected) ? selected.id : selected.parentId;
}
