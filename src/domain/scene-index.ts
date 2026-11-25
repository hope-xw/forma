import type { DesignDocument, DesignNode } from "./document";
export interface NodeDelta {
  dx: number;
  dy: number;
  rotationChanged: boolean;
}
interface SceneIndex {
  byId: Map<string, DesignNode>;
  indexById: Map<string, number>;
  children: Map<string | null, DesignNode[]>;
  base?: SceneIndex;
  depth: number;
}
const empty: DesignNode[] = [];
const published = new WeakMap<DesignDocument, SceneIndex>();
const previews = new WeakMap<
  DesignDocument,
  {
    base: WeakRef<DesignDocument>;
    affected: Set<string>;
    moved?: Map<string, NodeDelta>;
  }
>();
export function indexPreview(
  doc: DesignDocument,
  base: DesignDocument,
  affected: Set<string>,
  moved?: Map<string, NodeDelta>,
  updatedNodes?: Map<string, DesignNode>,
) {
  previews.set(doc, { base: new WeakRef(base), affected, moved });
  const baseIdx = published.get(base);
  if (
    baseIdx &&
    baseIdx.depth < 8 &&
    updatedNodes &&
    updatedNodes.size > 0 &&
    !published.has(doc)
  ) {
    const byId = new Map<string, DesignNode>(updatedNodes);
    const children = new Map<string | null, DesignNode[]>();
    const touchedParents = new Set<string | null>();
    for (const node of updatedNodes.values()) touchedParents.add(node.parentId);
    for (const parentId of touchedParents) {
      const siblings = childrenOf(base, parentId);
      children.set(
        parentId,
        siblings.map((s) => updatedNodes.get(s.id) ?? s),
      );
    }
    published.set(doc, {
      byId,
      indexById: baseIdx.indexById,
      children,
      base: baseIdx,
      depth: baseIdx.depth + 1,
    });
    return;
  }
  indexPublishedScene(doc);
}
export function positionDelta(
  doc: DesignDocument,
): { base: DesignDocument; moved: Map<string, NodeDelta> } | null {
  const entry = previews.get(doc);
  if (!entry?.moved) return null;
  const base = entry.base.deref();
  return base ? { base, moved: entry.moved } : null;
}
export function unchangedBranch(
  old: DesignDocument,
  next: DesignDocument,
  id: string,
) {
  if (old === next) return true;
  const a = previews.get(old),
    b = previews.get(next);
  const from = a?.base.deref(),
    to = b?.base.deref();
  if (to === old) return !b!.affected.has(id);
  if (from === next) return !a!.affected.has(id);
  return !!from && from === to && !a!.affected.has(id) && !b!.affected.has(id);
}
export const isPublished = (doc: DesignDocument) => published.has(doc);
export function indexPublishedScene(doc: DesignDocument) {
  if (published.has(doc)) return;
  const byId = new Map<string, DesignNode>(),
    indexById = new Map<string, number>(),
    children = new Map<string | null, DesignNode[]>();
  for (let i = 0; i < doc.nodes.length; i++) {
    const node = doc.nodes[i];
    byId.set(node.id, node);
    indexById.set(node.id, i);
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node);
    else children.set(node.parentId, [node]);
  }
  published.set(doc, { byId, indexById, children, depth: 0 });
}
export function indexOfLayer(doc: DesignDocument, id: string): number {
  const idx = published.get(doc);
  if (idx) return idx.indexById.get(id) ?? -1;
  return doc.nodes.findIndex((node) => node.id === id);
}
export function findLayer(doc: DesignDocument, id: string | null) {
  let idx = published.get(doc);
  if (idx) {
    const key = id ?? "";
    while (idx) {
      const hit = idx.byId.get(key);
      if (hit !== undefined) return hit;
      idx = idx.base;
    }
    return undefined;
  }
  return doc.nodes.find((node) => node.id === id);
}
export function childrenOf(doc: DesignDocument, parent: string | null) {
  let idx = published.get(doc);
  if (idx) {
    while (idx) {
      const hit = idx.children.get(parent);
      if (hit !== undefined) return hit;
      idx = idx.base;
    }
    return empty;
  }
  return doc.nodes.filter((node) => node.parentId === parent);
}
