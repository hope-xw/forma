import {
  transactionSchema,
  transact,
  type Operation,
} from "../domain/commands";
import type { DesignDocument, DesignNode, NodeStyle } from "../domain/document";
import { ancestors, instanceAncestor, isLocked } from "../domain/tree";
import {
  findLayer,
  indexOfLayer,
  indexPreview,
  isPublished,
  type NodeDelta,
} from "../domain/scene-index";
import { localMasters } from "../domain/component-masters";

/** On a published free scene, a position edit changes only the selected nodes and their rendered ancestors. */
function positionDraft(
  base: DesignDocument,
  operations: Operation[],
  revision: number,
) {
  const updates = new Map<string, Partial<NodeStyle>>(),
    affected = new Set<string>();
  for (const op of operations) {
    if (
      op.type !== "update" ||
      !op.style ||
      Object.keys(op.patch).length ||
      Object.entries(op.style).some(
        ([key, value]) =>
          !["x", "y", "rotation"].includes(key) || !Number.isFinite(value),
      )
    )
      return null;
    const node = findLayer(base, op.id);
    if (!node || isLocked(base, op.id) || instanceAncestor(base, op.id))
      return null;
    if (
      node.variableBindings &&
      Object.keys(op.style).some((key) => key in node.variableBindings!)
    )
      return null;
    const parents = ancestors(base, op.id);
    if (parents.some((p) => p.type === "group")) return null;
    const directParent = parents[0];
    if (
      directParent &&
      directParent.type === "frame" &&
      directParent.style.layout !== "free"
    )
      return null;
    updates.set(op.id, { ...updates.get(op.id), ...op.style });
    affected.add(op.id);
    parents.forEach((p) => affected.add(p.id));
  }
  const moved = new Map<string, NodeDelta>();
  const updatedNodes = new Map<string, DesignNode>();
  const nodes = base.nodes.slice();
  for (const [id, patch] of updates) {
    const idx = indexOfLayer(base, id);
    if (idx < 0) return null;
    const n = nodes[idx];
    const nextStyle = { ...n.style, ...patch };
    const nextNode = { ...n, style: nextStyle };
    nodes[idx] = nextNode;
    updatedNodes.set(id, nextNode);
    moved.set(id, {
      dx: nextStyle.x - n.style.x,
      dy: nextStyle.y - n.style.y,
      rotationChanged: (nextStyle.rotation ?? 0) !== (n.style.rotation ?? 0),
    });
  }
  const doc = {
    ...base,
    revision,
    nodes,
  };
  indexPreview(doc, base, affected, moved, updatedNodes);
  return doc;
}
export function previewGeometry(base: DesignDocument, operations: Operation[]) {
  return (
    positionDraft(base, operations, base.revision) ??
    transact(base, { baseRevision: base.revision, operations })
  );
}
/** UI history holds validated, immutable files. The general transaction handles changes with structural side effects. */
export function commitEditorOperations(
  base: DesignDocument,
  operations: Operation[],
  baseRevision: number,
) {
  if (
    isPublished(base) &&
    baseRevision === base.revision &&
    operations.every(
      (op) =>
        op.type === "update" && op.style && Object.keys(op.patch).length === 0,
    )
  ) {
    const masters = localMasters(base);
    const masterIds = masters.length
      ? new Set(masters.map((m) => m.nodeId))
      : null;
    const touchesMaster =
      masterIds !== null &&
      operations.some(
        (op) =>
          op.type === "update" &&
          (masterIds.has(op.id) ||
            ancestors(base, op.id).some((p) => masterIds.has(p.id))),
      );
    const touchesGroupNode = operations.some(
      (op) => op.type === "update" && findLayer(base, op.id)?.type === "group",
    );
    if (!touchesMaster && !touchesGroupNode) {
      const tx = transactionSchema.parse({ baseRevision, operations });
      const changed = positionDraft(base, tx.operations, baseRevision + 1);
      if (changed) return changed;
    }
  }
  return transact(base, { baseRevision, operations });
}
