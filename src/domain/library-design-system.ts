import { paintVariables } from "./paint-bindings";
import type { ComponentLibrary } from "./library-schema";
import type { DesignNode, DesignDocument } from "./document";
import { emptyDesignSystem, type DesignSystem } from "./design-system-schema";
import { remapInteraction } from "./prototype";
import { mergeDesignSystem, remapDesignBindings } from "./design-system";

/** Collect only values and styles used by the published variants, including each mode's alias chain. */
export function libraryDesignSystem(
  system: DesignSystem | undefined,
  nodes: DesignNode[],
) {
  if (!system) return undefined;
  const subset = emptyDesignSystem();
  function collection(id: string) {
    if (subset.collections[id]) return;
    const c = system!.collections[id];
    if (!c) throw new Error("组件缺少变量集合 " + id);
    subset.collections[id] = structuredClone(c);
    subset.activeModes[id] = system!.activeModes[id] ?? c.defaultModeId;
  }
  function variable(id: string) {
    if (subset.variables[id]) return;
    const v = system!.variables[id];
    if (!v) throw new Error("组件缺少变量 " + id);
    subset.variables[id] = structuredClone(v);
    collection(v.collectionId);
    for (const value of Object.values(v.values))
      if (typeof value === "object") variable(value.alias);
  }
  for (const node of nodes) {
    paintVariables(node.style).forEach(({ id }) => variable(id));
    Object.values(node.variableBindings ?? {}).forEach(variable);
    Object.keys(node.variableModes ?? {}).forEach(collection);
    const rule = node.interaction;
    if (rule?.condition) variable(rule.condition.variable);
    for (const action of [...(rule?.actions ?? []), ...(rule?.otherwise ?? [])])
      if ("variable" in action) variable(action.variable);
    for (const id of Object.values(node.styleBindings ?? {})) {
      if (!id || subset.styles[id]) continue;
      const style = system.styles[id];
      if (!style) throw new Error("组件缺少样式 " + id);
      subset.styles[id] = structuredClone(style);
      paintVariables(style.properties).forEach(({ id }) => variable(id));
      Object.values(style.bindings).forEach(variable);
    }
  }
  return Object.keys(subset.collections).length ||
    Object.keys(subset.styles).length
    ? subset
    : undefined;
}
/** An independently distributed library carries only typefaces used by its layers and theme modes. */
export function libraryFonts(
  doc: DesignDocument,
  nodes: DesignNode[],
  system?: DesignSystem,
) {
  if (!doc.fonts) return undefined;
  const used = new Set<string>();
  function collect(family: unknown) {
    if (typeof family === "string")
      for (const id of family.match(/font-[a-f0-9]{64}/g) ?? []) used.add(id);
  }
  for (const n of nodes) {
    collect(n.style.fontFamily);
    for (const run of n.textRuns ?? []) collect(run.style.fontFamily);
  }
  for (const style of Object.values(system?.styles ?? {}))
    collect(style.properties.fontFamily);
  for (const variable of Object.values(system?.variables ?? {}))
    for (const value of Object.values(variable.values)) collect(value);
  const entries = Object.entries(doc.fonts).filter(([id]) => used.has(id));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export const templateNodes = (library: ComponentLibrary) =>
  library.components.flatMap((c) => c.variants.flatMap((v) => v.nodes));
export function remapLibraryDesignSystem(
  library: ComponentLibrary,
  merged: ReturnType<typeof mergeDesignSystem>,
) {
  for (const n of templateNodes(library)) {
    remapDesignBindings(n, merged.maps);
    remapInteraction(n, new Map(), merged.maps.variables);
  }
  library.designSystem = libraryDesignSystem(
    merged.system,
    templateNodes(library),
  );
}
export function integrateLibrarySystem(
  doc: DesignDocument,
  library: ComponentLibrary,
) {
  const source = library.designSystem,
    target = doc.designSystem;
  if (!source) return { library, system: target };
  if (!target) return { library, system: structuredClone(source) };
  const known = doc.libraries?.[library.id]?.designSystem;
  const keys = ["collections", "variables", "styles"] as const;
  const matches = keys.every((kind) =>
    Object.entries(source[kind]).every(
      ([id, v]) =>
        !target[kind][id] ||
        JSON.stringify(v) === JSON.stringify(target[kind][id]) ||
        JSON.stringify(known?.[kind][id]) === JSON.stringify(v),
    ),
  );
  const nameConflict = Object.values(source.styles).some((s) =>
    Object.values(target.styles).some(
      (t) => t.id !== s.id && t.kind === s.kind && t.name === s.name,
    ),
  );
  if (matches && !nameConflict) {
    if (keys.every((k) => Object.keys(source[k]).every((id) => target[k][id])))
      return { library, system: target };
    return {
      library,
      system: {
        collections: { ...source.collections, ...target.collections },
        variables: { ...source.variables, ...target.variables },
        styles: { ...source.styles, ...target.styles },
        activeModes: { ...source.activeModes, ...target.activeModes },
      },
    };
  }
  const merged = mergeDesignSystem(target, source),
    copy = structuredClone(library);
  remapLibraryDesignSystem(copy, merged);
  return { library: copy, system: merged.system };
}
