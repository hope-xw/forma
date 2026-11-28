import {
  transactionSchema,
  transact,
  type Operation,
} from "../domain/commands";
import {
  nodeSchema,
  styleSchema,
  type DesignDocument,
  type DesignNode,
  type NodeStyle,
} from "../domain/document";
import { bindingValueSchema } from "../domain/design-system";
import {
  propertyType,
  type VariableProperty,
} from "../domain/design-properties";
import { ancestors, instanceAncestor, isLocked } from "../domain/tree";
import {
  findLayer,
  childrenOf,
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
    const directParent = parents[0];
    if (directParent?.type === "group") return null;
    if (
      directParent &&
      directParent.type === "frame" &&
      directParent.style.layout !== "free" &&
      !node.style.absolutePosition
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
const handleStyle = styleSchema
  .pick({ radius: true, corners: true, padding: true, insets: true, gap: true })
  .partial()
  .strict();

// A binding replacement can change layout even when the literal edit only touches radius.
// Limit additions and removals to the edited family. Check new destinations in every mode.
function validHandleBindings(
  base: DesignDocument,
  node: DesignNode,
  patch: Partial<NodeStyle>,
  bindings: NonNullable<DesignNode["variableBindings"]>,
) {
  const previous = node.variableBindings ?? {};
  const keys = new Set([
    ...Object.keys(previous),
    ...Object.keys(bindings),
  ] as VariableProperty[]);
  for (const key of keys) {
    const id = bindings[key];
    const token =
      id === undefined ? undefined : base.designSystem?.variables[id];
    if (
      id !== undefined &&
      (!token ||
        token.type !== propertyType(key) ||
        (token.scopes.length && !token.scopes.includes(key)))
    )
      return false;
    if (id === previous[key]) continue;
    const editsRadius = key === "radius" || key.startsWith("corners.");
    const editsPadding = key === "padding" || key.startsWith("insets.");
    if (
      !(editsRadius && ("radius" in patch || "corners" in patch)) &&
      !(editsPadding && ("padding" in patch || "insets" in patch)) &&
      !(key === "gap" && "gap" in patch)
    )
      return false;
    if (!token) continue;
    const field = bindingValueSchema(key);
    const pending = [token],
      checked = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (checked.has(current.id)) continue;
      checked.add(current.id);
      for (const value of Object.values(current.values)) {
        if (typeof value === "object") {
          const alias = base.designSystem?.variables[value.alias];
          if (alias?.type !== "number") return false;
          pending.push(alias);
        } else if (!field.safeParse(value).success) return false;
      }
    }
  }
  return true;
}

/** Local appearance previews share the published scene. Spacing still needs fresh layout. */
function handleStyleDraft(base: DesignDocument, operations: Operation[]) {
  if (!operations.length || operations.length > 20000) return null;
  const updated = new Map<string, DesignNode>();
  const affected = new Set<string>();
  const masters = new Set(localMasters(base).map((master) => master.nodeId));
  let changesLayout = false;
  for (const op of operations) {
    if (
      op.type !== "update" ||
      !op.style ||
      Object.keys(op.patch).some((key) => key !== "variableBindings")
    )
      return null;
    const parsed = handleStyle.safeParse(op.style);
    if (!parsed.success) return null;
    const patch = parsed.data;
    if (
      Object.entries(patch).some(
        ([key, value]) =>
          value === undefined && key !== "corners" && key !== "insets",
      )
    )
      return null;
    const node = updated.get(op.id) ?? findLayer(base, op.id);
    if (!node) return null;
    const branch = [node, ...ancestors(base, op.id)];
    if (
      branch.some(
        (layer) =>
          layer.locked ||
          layer.instance ||
          layer.type === "group" ||
          masters.has(layer.id),
      )
    )
      return null;
    // An ordinary update can detach a binding, or create a reusable grid style override.
    if (node.styleBindings?.grid && "gap" in patch) return null;
    const nextNode: DesignNode = {
      ...node,
      style: { ...node.style, ...patch },
    };
    if ("variableBindings" in op.patch) {
      const bindings = nodeSchema.shape.variableBindings
        .unwrap()
        .safeParse(op.patch.variableBindings);
      if (
        !Object.keys(patch).length ||
        !bindings.success ||
        !validHandleBindings(base, node, patch, bindings.data)
      )
        return null;
      nextNode.variableBindings = bindings.data;
    } else if (
      Object.keys(node.variableBindings ?? {}).some((key) => {
        if (key === "radius" || key.startsWith("corners."))
          return "radius" in patch || "corners" in patch;
        if (key === "padding" || key.startsWith("insets."))
          return "padding" in patch || "insets" in patch;
        return key in patch;
      })
    )
      return null;
    for (const layer of branch) affected.add(layer.id);
    if ("gap" in patch || "insets" in patch || "padding" in patch) {
      changesLayout = true;
      // Child CSS depends on its parent's spacing (including negative gap margins).
      for (const child of childrenOf(base, op.id)) affected.add(child.id);
    }
    updated.set(op.id, nextNode);
  }
  const nodes = base.nodes.slice();
  for (const [id, node] of updated) nodes[indexOfLayer(base, id)] = node;
  const doc = { ...base, nodes };
  indexPreview(
    doc,
    base,
    affected,
    changesLayout ? undefined : new Map(),
    updated,
  );
  return doc;
}
export function previewGeometry(base: DesignDocument, operations: Operation[]) {
  return (
    positionDraft(base, operations, base.revision) ??
    handleStyleDraft(base, operations) ??
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
