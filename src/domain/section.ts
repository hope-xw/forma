import { createNode, type DesignDocument } from "./document";
import type { Operation } from "./commands";
import { layoutBounds, union } from "./geometry";
import { selectionRoots } from "./tree";

/**
 * Wrap selected top-level or section-scoped layers inside a new Section container.
 * Enforces Figma F06 hierarchy: sections may only live at canvas root or inside another section.
 */
export function wrapInSection(
  doc: DesignDocument,
  nodeIds: string[],
  padding = 48,
): { operations: Operation[]; id: string } {
  const nodes = selectionRoots(doc, nodeIds);
  if (!nodes.length) throw new Error("先选择图层");
  const parentId = nodes[0].parentId;
  if (!nodes.every((n) => n.parentId === parentId))
    throw new Error("请先选择同一父层中的图层");
  if (parentId !== null) {
    const parent = doc.nodes.find((n) => n.id === parentId);
    if (!parent || parent.type !== "section")
      throw new Error("分区只能位于画布顶层或其他分区内");
  }
  const bounds = layoutBounds(doc);
  const rect = union(nodes.map((n) => bounds.get(n.id)!))!;
  const parentBounds = parentId ? bounds.get(parentId) : null;
  const pad = Math.max(0, padding);
  const secX = rect.x - pad;
  const secY = rect.y - pad;
  const width = Math.min(10000, Math.max(1, rect.width + pad * 2));
  const height = Math.min(10000, Math.max(1, rect.height + pad * 2));
  const section = createNode("section", parentId);
  section.style = {
    ...section.style,
    x: secX - (parentBounds?.x ?? 0),
    y: secY - (parentBounds?.y ?? 0),
    width,
    height,
  };
  const siblings = doc.nodes.filter((n) => n.parentId === parentId);
  const index = Math.min(
    ...nodes.map((n) => siblings.findIndex((s) => s.id === n.id)),
  );
  const operations: Operation[] = [
    { type: "create", node: section },
    { type: "reorder", id: section.id, index },
  ];
  for (const n of nodes) {
    const b = bounds.get(n.id)!;
    operations.push(
      { type: "move", id: n.id, parentId: section.id },
      {
        type: "update",
        id: n.id,
        patch: {},
        style: { x: b.x - secX, y: b.y - secY },
      },
    );
  }
  return { operations, id: section.id };
}

/**
 * Select matching layers (Figma F12): finds all layers across sibling artboards/sections
 * sharing the same name and type as any of the seed layers.
 */
export function findMatchingLayers(
  doc: DesignDocument,
  nodeIds: string[],
): string[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const seeds = nodeIds
    .map((id) => byId.get(id))
    .filter((n): n is NonNullable<typeof n> => Boolean(n));
  if (!seeds.length) return [];

  const rootKeys = new Set<string>();
  const nestedKeys = new Set<string>();
  const matched = new Set<string>();

  for (const seed of seeds) {
    matched.add(seed.id);
    const key = `${seed.type}\0${seed.name}`;
    if (seed.parentId === null) rootKeys.add(key);
    else nestedKeys.add(key);
  }

  for (const node of doc.nodes) {
    const key = `${node.type}\0${node.name}`;
    if (node.parentId === null) {
      if (rootKeys.has(key)) matched.add(node.id);
    } else if (nestedKeys.has(key)) {
      matched.add(node.id);
    }
  }

  return doc.nodes.filter((n) => matched.has(n.id)).map((n) => n.id);
}
