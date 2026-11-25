import { referencedComponents } from "./component-slots";
import { mergeDesignSystem, remapDesignBindings } from "./design-system";
import type { DesignSystem } from "./design-system-schema";
import type { DesignDocument, DesignNode } from "./document";
import { libraryDesignSystem, libraryFonts } from "./library-design-system";
import {
  parseLibrary,
  type ComponentLibrary,
  type LibraryAiGuide,
} from "./library-schema";
import { remapInteraction } from "./prototype";

function* canvasInstances(doc: DesignDocument) {
  for (const nodes of [
    doc.nodes,
    ...(doc.pages ?? []).map((p) => p.nodes ?? []),
  ])
    for (const node of nodes) if (node.instance) yield node.instance;
}

export function countLibraryInstances(
  doc: DesignDocument,
  libraryId: string,
): number {
  let count = 0;
  for (const instance of canvasInstances(doc))
    if (
      referencedComponents(instance).some((ref) => ref.libraryId === libraryId)
    )
      count++;
  return count;
}

export function allLibraryInstanceCounts(
  doc: DesignDocument,
): Record<string, number> {
  const counts = new Map(Object.keys(doc.libraries ?? {}).map((id) => [id, 0]));
  for (const instance of canvasInstances(doc)) {
    const ids = new Set(
      referencedComponents(instance).map((ref) => ref.libraryId),
    );
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

export type PackageLibraryOptions = {
  name: string;
  aiGuide?: LibraryAiGuide;
  description?: string;
  id?: string;
  revision?: number;
  sourceName?: string;
  license?: string;
  libraryIds?: string[];
  includeLocalMasters?: boolean;
  includeImportedLibraries?: boolean;
};

function selectedComponents(
  doc: DesignDocument,
  options: PackageLibraryOptions,
) {
  const ids = options.libraryIds && new Set(options.libraryIds);
  return Object.values(doc.libraries ?? {}).flatMap((library) => {
    const local = library.components.filter(
      (c) => c.master?.documentId === doc.id,
    );
    const include = ids
      ? ids.has(library.id)
      : (local.length > 0 && options.includeLocalMasters !== false) ||
        (local.length === 0 && options.includeImportedLibraries === true);
    if (!include) return [];
    const components =
      ids || options.includeImportedLibraries ? library.components : local;
    return [{ library, components: structuredClone(components) }];
  });
}

// A library owns its definitions. Older snapshots can also rely on document definitions.
function sourceSystem(
  doc?: DesignSystem,
  library?: DesignSystem,
): DesignSystem | undefined {
  if (!doc || !library) return library ?? doc;
  const activeModes = { ...doc.activeModes };
  for (const c of Object.values(library.collections))
    activeModes[c.id] = library.activeModes[c.id] ?? c.defaultModeId;
  return {
    collections: { ...doc.collections, ...library.collections },
    variables: { ...doc.variables, ...library.variables },
    styles: { ...doc.styles, ...library.styles },
    activeModes,
  };
}

function usedDesignSystem(
  system: DesignSystem | undefined,
  nodes: DesignNode[],
) {
  // The shared collector reads the singular interaction field. Include the rules of multi-trigger layers too.
  const additionalRules = nodes.flatMap((n) =>
    (n.interactions ?? []).map((interaction) => ({ ...n, interaction })),
  );
  return libraryDesignSystem(
    system,
    additionalRules.length ? nodes.concat(additionalRules) : nodes,
  );
}

function mergeDependencies(
  target: DesignSystem | undefined,
  source: DesignSystem,
  nodes: DesignNode[],
) {
  if (!target) return source;
  const idConflict = (["collections", "variables", "styles"] as const).some(
    (kind) =>
      Object.entries(source[kind]).some(
        ([id, definition]) =>
          Object.hasOwn(target[kind], id) &&
          JSON.stringify(target[kind][id]) !== JSON.stringify(definition),
      ),
  );
  const modeConflict = Object.values(source.collections).some(
    (c) =>
      target.collections[c.id] &&
      (target.activeModes[c.id] ?? target.collections[c.id].defaultModeId) !==
        source.activeModes[c.id],
  );
  const nameConflict = <T extends { id: string }>(
    existing: Record<string, T>,
    incoming: Record<string, T>,
    key: (definition: T) => string,
  ) => {
    const byName = new Map(Object.values(existing).map((v) => [key(v), v.id]));
    return Object.values(incoming).some((v) => {
      const other = byName.get(key(v));
      return other !== undefined && other !== v.id;
    });
  };
  if (
    !idConflict &&
    !modeConflict &&
    !nameConflict(target.variables, source.variables, (v) =>
      JSON.stringify([v.collectionId, v.name]),
    ) &&
    !nameConflict(target.styles, source.styles, (s) =>
      JSON.stringify([s.kind, s.name]),
    )
  )
    return sourceSystem(target, source)!;

  const merged = mergeDesignSystem(target, source);
  for (const [oldId, newId] of merged.maps.styles) {
    const style = merged.system.styles[newId];
    if (style.name.length > 200) {
      const previous = source.styles[oldId].name;
      const suffix = style.name.slice(previous.length);
      style.name = previous.slice(0, 200 - suffix.length) + suffix;
    }
  }
  const layerIds = new Map<string, string>();
  for (const node of nodes) {
    remapDesignBindings(node, merged.maps);
    remapInteraction(node, layerIds, merged.maps.variables);
  }
  return merged.system;
}

function defaultLibraryName(doc: DesignDocument) {
  const suffix = " 组件库";
  return (
    doc.name.slice(0, 200 - suffix.length).replace(/[\uD800-\uDBFF]$/, "") +
    suffix
  );
}

function uniqueComponentId(
  base: string,
  reserved: Set<string>,
  used: Set<string>,
) {
  let id = base;
  if (used.has(id)) {
    let number = 2;
    do {
      const suffix = "-" + number++;
      id = base.slice(0, 128 - suffix.length) + suffix;
    } while (used.has(id) || reserved.has(id));
  }
  used.add(id);
  return id;
}

export function packageDocumentAsLibrary(
  doc: DesignDocument,
  options: PackageLibraryOptions,
): ComponentLibrary {
  const sources = selectedComponents(doc, options);
  const components = sources.flatMap((source) => source.components);
  if (!components.length) throw new Error("当前文档没有可打包的组件");
  const id = options.id ?? "lib-" + crypto.randomUUID();
  const reserved = new Set(components.map((c) => c.id));
  const used = new Set<string>();
  const componentIds = new Map<string, Map<string, string>>();
  const allNodes: DesignNode[] = [];
  const images: NonNullable<ComponentLibrary["images"]> = {};
  const fontAssets = { ...doc.fonts };
  let system = doc.designSystem;
  for (const { library, components: selected } of sources) {
    const ids = new Map<string, string>();
    componentIds.set(library.id, ids);
    const nodes: DesignNode[] = [];
    for (const c of selected) {
      const newId = uniqueComponentId(c.id, reserved, used);
      ids.set(c.id, newId);
      c.id = newId;
      delete c.master;
      for (const variant of c.variants) {
        delete variant.masterNodeId;
        nodes.push(...variant.nodes);
      }
    }
    if (library.designSystem) {
      const dependencies = usedDesignSystem(
        sourceSystem(doc.designSystem, library.designSystem),
        nodes,
      );
      if (dependencies) system = mergeDependencies(system, dependencies, nodes);
    }
    Object.assign(fontAssets, library.fonts);
    for (const node of nodes) {
      allNodes.push(node);
      if (node.image) {
        const key = node.image.assetId;
        const image = library.images?.[key] ?? doc.images?.[key];
        if (image) images[key] = image;
      }
    }
  }
  // Keep nested source navigation within the new snapshot, including forward and renamed references.
  for (const node of allNodes)
    for (const ref of [node.nestedSource, node.componentSet]) {
      if (!ref) continue;
      const target = componentIds.get(ref.libraryId)?.get(ref.componentId);
      if (target) {
        ref.libraryId = id;
        ref.componentId = target;
      }
    }
  const designSystem = usedDesignSystem(system, allNodes);
  const fonts = libraryFonts(
    { ...doc, fonts: fontAssets },
    allNodes,
    designSystem,
  );
  const aiGuide =
    options.aiGuide ??
    (sources.length === 1 ? sources[0].library.aiGuide : undefined);
  return parseLibrary({
    format: "forma/library",
    version: 1,
    id,
    name: options.name.trim() || defaultLibraryName(doc),
    description:
      options.description ?? "从文档「" + doc.name + "」打包的可复用组件库",
    revision: options.revision ?? 1,
    ...(aiGuide && { aiGuide }),
    ...(Object.keys(images).length ? { images } : {}),
    ...(fonts ? { fonts } : {}),
    ...(designSystem ? { designSystem } : {}),
    source: {
      name: options.sourceName ?? doc.name,
      license: options.license ?? "文档自有组件库快照",
    },
    components,
  });
}

export function extractLibrariesFromDocument(
  doc: DesignDocument,
  options?: Partial<
    Pick<PackageLibraryOptions, "name" | "sourceName" | "license" | "aiGuide">
  >,
): ComponentLibrary {
  if (
    !Object.values(doc.libraries ?? {}).some(
      (library) => library.components.length,
    )
  )
    throw new Error("此文件不包含可提取的组件或符号定义");
  const report = doc.importReport;
  const origin = report
    ? report.format + " 原稿「" + report.filename + "」"
    : "设计文档「" + doc.name + "」";
  return packageDocumentAsLibrary(doc, {
    name: options?.name || defaultLibraryName(doc),
    description: "从 " + origin + " 提取的可复用组件库",
    aiGuide: options?.aiGuide,
    sourceName:
      options?.sourceName ?? (report ? report.format + " 原稿导入" : doc.name),
    license:
      options?.license ??
      "由本地设计文件离线提取；请遵循原始设计文件的授权条款。",
    includeLocalMasters: true,
    includeImportedLibraries: true,
  });
}
