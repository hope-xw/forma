import { referencedComponents, layerComponent } from "./component-slots";
import {
  libraryDesignSystem,
  libraryFonts,
  remapLibraryDesignSystem,
  templateNodes,
} from "./library-design-system";
import {
  effectiveModes,
  mergeDesignSystem,
  remapDesignBindings,
} from "./design-system";
import { z } from "zod";
import { documentSchema, parseDocument, type DesignDocument } from "./document";
import { layoutBounds, union, type Point } from "./geometry";
import { currentPageOnly } from "./pages";
import {
  sceneTransforms,
  poseInParent,
  identity,
  localTransform,
} from "./transforms";
import { ancestors, selectionRoots, subtreeIds } from "./tree";
import type { Operation } from "./commands";
const schema = z.object({
  format: z.literal("forma/clipboard"),
  version: z.literal(1),
  document: documentSchema,
  roots: z.array(z.string()).min(1),
  sourceDocument: z.string(),
});
export type ClipboardPayload = z.infer<typeof schema>;
export function copySelection(
  doc: DesignDocument,
  selection: string[],
): ClipboardPayload {
  const roots = selectionRoots(doc, selection);
  if (!roots.length) throw new Error("先选择需要复制的图层");
  const ids = subtreeIds(
    doc,
    roots.map((n) => n.id),
  );
  const bounds = layoutBounds(doc);
  const matrices = sceneTransforms(doc, bounds);
  const nodes = structuredClone(doc.nodes.filter((n) => ids.has(n.id)));
  for (const n of nodes)
    if (roots.some((root) => root.id === n.id)) {
      if (doc.designSystem)
        n.variableModes = effectiveModes(
          doc,
          doc.nodes.find((original) => original.id === n.id),
        );
      n.parentId = null;
      Object.assign(
        n.style,
        poseInParent(
          n,
          bounds.get(n.id)!,
          matrices.get(n.id)!,
          undefined,
          identity,
        ),
      );
    }
  const libraryIds = new Set(
    nodes.flatMap((n) =>
      n.instance
        ? referencedComponents(n.instance).map((r) => r.libraryId)
        : layerComponent(doc, n)
          ? referencedComponents(n.nestedSource!).map((r) => r.libraryId)
          : [],
    ),
  );
  const libraries = Object.fromEntries(
    Object.entries(doc.libraries ?? {}).filter(([id]) => libraryIds.has(id)),
  );
  const related = [
    ...nodes,
    ...Object.values(libraries).flatMap(templateNodes),
  ];
  const designSystem = libraryDesignSystem(doc.designSystem, related);
  return {
    format: "forma/clipboard",
    version: 1,
    document: structuredClone({
      ...currentPageOnly(doc),
      nodes,
      libraries: Object.keys(libraries).length ? libraries : undefined,
      designSystem,
      fonts: libraryFonts(doc, related, designSystem),
      images:
        doc.images &&
        Object.fromEntries(
          nodes
            .filter((n) => n.image)
            .map((n) => [n.image!.assetId, doc.images![n.image!.assetId]]),
        ),
    }),
    roots: roots.map((n) => n.id),
    sourceDocument: doc.id,
  };
}
export function readClipboard(text: string): ClipboardPayload | null {
  if (!text.trim().startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if ((parsed as { format?: string })?.format !== "forma/clipboard")
    return null;
  const payload = schema.parse(parsed);
  parseDocument(payload.document);
  if (
    payload.roots.length !== new Set(payload.roots).size ||
    payload.document.nodes.filter((n) => !n.parentId).length !==
      payload.roots.length ||
    payload.roots.some(
      (id) => !payload.document.nodes.some((n) => n.id === id && !n.parentId),
    )
  )
    throw new Error("剪贴板层级无效");
  return payload;
}
export function pasteSelection(
  doc: DesignDocument,
  payload: ClipboardPayload,
  parentId: string | null,
  position?: Point,
): { operations: Operation[]; selection: string[] } {
  parseDocument(payload.document);
  const idMap = new Map(
    payload.document.nodes.map((n) => [n.id, crypto.randomUUID()]),
  );
  const rootNodes = payload.document.nodes.filter((n) =>
    payload.roots.includes(n.id),
  );
  const box = union(rootNodes.map((n) => n.style))!;
  const bounds = layoutBounds(doc),
    parent = bounds.get(parentId ?? "");
  const matrix = parentId
    ? sceneTransforms(doc, bounds).get(parentId)!
    : identity;
  const tokenMap = new Map<string, string>();
  const operations: Operation[] = [];
  for (const [id, font] of Object.entries(payload.document.fonts ?? {}))
    if (!doc.fonts?.[id]) operations.push({ type: "putFont", id, font });
  for (const id of new Set(
    payload.document.nodes.flatMap((n) => (n.image ? [n.image.assetId] : [])),
  )) {
    if (!doc.images?.[id])
      operations.push({
        type: "putImage",
        id,
        image: payload.document.images![id],
      });
  }
  const merged = mergeDesignSystem(
    doc.designSystem,
    payload.document.designSystem,
  );
  if (
    payload.document.designSystem &&
    JSON.stringify(merged.system) !== JSON.stringify(doc.designSystem)
  )
    operations.push({ type: "setDesignSystem", system: merged.system });
  const libraryMap = new Map<string, string>();
  for (const originalId of new Set(
    payload.document.nodes.flatMap((n) =>
      n.instance
        ? referencedComponents(n.instance).map((r) => r.libraryId)
        : layerComponent(payload.document, n)
          ? referencedComponents(n.nestedSource!).map((r) => r.libraryId)
          : [],
    ),
  )) {
    const library = structuredClone(payload.document.libraries![originalId]);
    if (library.designSystem) remapLibraryDesignSystem(library, merged);
    if (
      doc.libraries?.[originalId] &&
      JSON.stringify(doc.libraries[originalId]) !== JSON.stringify(library)
    )
      library.id = crypto.randomUUID();
    libraryMap.set(originalId, library.id);
    if (!doc.libraries?.[library.id])
      operations.push({ type: "putLibrary", library });
  }
  const usedTokens = new Set(
    payload.document.nodes.flatMap((n) => (n.fillToken ? [n.fillToken] : [])),
  );
  for (const id of usedTokens) {
    const token = payload.document.tokens[id];
    if (
      doc.tokens[id] &&
      JSON.stringify(doc.tokens[id]) !== JSON.stringify(token)
    ) {
      const newId = `import-${crypto.randomUUID()}`;
      tokenMap.set(id, newId);
      operations.push({ type: "putToken", id: newId, token });
    } else {
      tokenMap.set(id, id);
      if (!doc.tokens[id]) operations.push({ type: "putToken", id, token });
    }
  }
  for (const original of payload.document.nodes) {
    const node = structuredClone(original);
    remapDesignBindings(node, merged.maps);
    if (node.maskSourceId) node.maskSourceId = idMap.get(node.maskSourceId);
    remapInteraction(node, idMap, merged.maps.variables);
    if (node.nestedSource)
      for (const r of referencedComponents(node.nestedSource))
        r.libraryId = libraryMap.get(r.libraryId) ?? r.libraryId;
    if (node.instance)
      for (const r of referencedComponents(node.instance))
        r.libraryId = libraryMap.get(r.libraryId)!;
    node.id = idMap.get(original.id)!;
    delete node.componentSet;
    node.locked = false;
    node.parentId = original.parentId
      ? idMap.get(original.parentId)!
      : parentId;
    if (node.fillToken) node.fillToken = tokenMap.get(node.fillToken);
    if (payload.roots.includes(original.id)) {
      Object.assign(
        node.style,
        poseInParent(
          original,
          original.style,
          localTransform(original, original.style),
          parent,
          matrix,
          {
            x: (position?.x ?? box.x) - box.x,
            y: (position?.y ?? box.y) - box.y,
          },
        ),
      );
    }
    operations.push({ type: "create", node });
  }
  const locked = payload.document.nodes
    .filter((n) => n.locked)
    .sort(
      (a, b) =>
        ancestors(payload.document, b.id).length -
        ancestors(payload.document, a.id).length,
    );
  for (const node of locked)
    operations.push({
      type: "update",
      id: idMap.get(node.id)!,
      patch: { locked: true },
    });
  return { operations, selection: payload.roots.map((id) => idMap.get(id)!) };
}
import { remapInteraction } from "./prototype";
