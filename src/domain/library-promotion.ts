import {
  classifyComponentTier,
  CUSTOM_NOTES_END,
  CUSTOM_NOTES_START,
  generateLibraryPlaybook,
} from "./library-intelligence";
import { transact, type Operation } from "./commands";
import type { DesignDocument, DesignNode } from "./document";
import type { DesignSystem } from "./design-system-schema";
import { layoutBounds } from "./geometry";
import { createLibraryFromSelection, instantiateComponent } from "./library";
import { libraryDesignSystem, libraryFonts } from "./library-design-system";
import { packageDocumentAsLibrary } from "./library-packaging";
import { remapInteraction } from "./prototype";
import {
  OFFICIAL_BUILTIN_LIBRARY_IDS,
  parseLibrary,
  type AssetTier,
  type ComponentLibrary,
  type LibraryComponent,
} from "./library-schema";
import { stableHash } from "./stable-hash";
import { instanceOwner, isLocked } from "./tree";

export const NEW_PROJECT_LIBRARY_TARGET = "__new_project_library__";

function slug(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function projectDerivedLibraryId(projectId?: string): string {
  if (!projectId) return "custom-modules-" + crypto.randomUUID().slice(0, 8);
  const prefix = "proj-lib-";
  const stem = slug(projectId);
  const limit = 96 - prefix.length;
  if (!stem) return prefix + stableHash(projectId);
  if (stem.length <= limit) return prefix + stem;
  const suffix = "-" + stableHash(projectId);
  return prefix + stem.slice(0, limit - suffix.length) + suffix;
}

export interface PromoteSelectionDefaults {
  componentName: string;
  assetTier: AssetTier;
  category: string;
  suggestedLibraryId: string;
  suggestedNewLibraryName: string;
}

export interface PromoteSelectionOptions {
  targetLibraryId?: string;
  existingWorkspaceLibrary?: ComponentLibrary;
  projectId?: string;
  projectName?: string;
  newLibraryName?: string;
  componentName?: string;
  category?: string;
  assetTier?: AssetTier;
  description?: string;
  whenToUse?: string;
  tags?: string[];
  refreshPlaybook?: boolean;
  replaceSelectionWithInstance?: boolean;
}

export interface PromoteSelectionResult {
  library: ComponentLibrary;
  componentId: string;
  variantId: string;
  createdNewLibrary: boolean;
  playbookRefreshed: boolean;
  operations: Operation[];
  /** The new live instance to select after committing the transaction. */
  replacedNodeId?: string;
}

const categories: Record<AssetTier, string> = {
  page: "页面样板",
  block: "业务模块",
  component: "自定义组件",
};

function selectionRoot(doc: DesignDocument, nodeId: string) {
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("请先选择要沉淀的图层");
  if (!node.instance && instanceOwner(doc, nodeId))
    throw new Error("请先选择所属实例或显式分离后再沉淀");
  if (isLocked(doc, nodeId)) throw new Error("图层或父图层已锁定");
  return node;
}

function newLibraryName(doc: DesignDocument, projectName?: string) {
  const project = projectName?.trim();
  const suffix = project ? " · 业务模块库" : " · 自定义模块库";
  return (project || doc.name).slice(0, 200 - suffix.length).trimEnd() + suffix;
}

function extract(doc: DesignDocument, root: DesignNode, name: string) {
  // Layer names may be empty or longer than the library's display-name limit.
  const displayName = root.name.trim().slice(0, 200) || "自定义模块";
  const source =
    root.name === displayName
      ? doc
      : {
          ...doc,
          nodes: doc.nodes.map((n) =>
            n === root ? { ...n, name: displayName } : n,
          ),
        };
  const library = createLibraryFromSelection(source, root.id, name);
  const component = library.components[0];
  delete component.master;
  const nodes = component.variants[0].nodes;
  nodes.find((n) => n.parentId === null)!.name = root.name;
  // The selection collector reads the singular rule. Include variables used only
  // by secondary triggers, just as the document packaging path does.
  const additional = nodes.flatMap((n) =>
    (n.interactions ?? []).map((interaction) => ({ ...n, interaction })),
  );
  if (additional.length) {
    library.designSystem = libraryDesignSystem(
      doc.designSystem,
      nodes.concat(additional),
    );
    library.fonts = libraryFonts(doc, nodes, library.designSystem);
  }
  return library;
}

export function suggestPromotionDefaults(
  doc: DesignDocument,
  nodeId: string,
  options: {
    projectId?: string;
    projectName?: string;
    preferredLibraryId?: string;
    workspaceLibraries?: ComponentLibrary[];
  } = {},
): PromoteSelectionDefaults {
  const root = selectionRoot(doc, nodeId);
  const suggestedNewLibraryName = newLibraryName(doc, options.projectName);
  const candidate = extract(doc, root, suggestedNewLibraryName);
  const component = candidate.components[0];
  const assetTier = classifyComponentTier(component, candidate);
  const preferred = options.preferredLibraryId;
  const project =
    options.projectId && projectDerivedLibraryId(options.projectId);
  const suggestedLibraryId =
    [preferred, project].find(
      (id) =>
        id &&
        !OFFICIAL_BUILTIN_LIBRARY_IDS.has(id) &&
        (Object.hasOwn(doc.libraries ?? {}, id) ||
          options.workspaceLibraries?.some((lib) => lib.id === id)),
    ) ?? NEW_PROJECT_LIBRARY_TARGET;
  return {
    componentName: component.name,
    assetTier,
    category: categories[assetTier],
    suggestedLibraryId,
    suggestedNewLibraryName,
  };
}

function nextComponentId(name: string, target?: ComponentLibrary) {
  const base = (slug(name) || "module").slice(0, 128);
  const used = new Set(target?.components.map((c) => c.id));
  let id = base;
  for (let i = 2; used.has(id); i++) {
    const suffix = "-" + i;
    id = base.slice(0, 128 - suffix.length) + suffix;
  }
  return id;
}

// putLibrary treats a same-kind, same-name style with a different ID as a
// foreign import. Rename only colliding display names; never change a binding.
function distinctStyleNames(
  incoming: DesignSystem["styles"],
  occupied: DesignSystem["styles"],
  reservedStyles?: DesignSystem["styles"],
) {
  const key = (kind: string, name: string) => kind + "/" + name;
  const byName = new Map(
    Object.values(occupied).map((s) => [key(s.kind, s.name), s.id]),
  );
  const reserved = new Set([
    ...byName.keys(),
    ...[...Object.values(incoming), ...Object.values(reservedStyles ?? {})].map(
      (s) => key(s.kind, s.name),
    ),
  ]);
  let styles = incoming;
  for (const style of Object.values(incoming)) {
    const other = byName.get(key(style.kind, style.name));
    if (other === undefined || other === style.id) continue;
    let name = style.name;
    let number = 2;
    do {
      const suffix = " (" + number++ + ")";
      name = style.name.slice(0, 200 - suffix.length) + suffix;
    } while (reserved.has(key(style.kind, name)));
    reserved.add(key(style.kind, name));
    if (styles === incoming) styles = { ...incoming };
    styles[style.id] = { ...style, name };
  }
  return styles;
}

function checkWorkspaceComponents(
  installed: ComponentLibrary,
  workspace: ComponentLibrary,
) {
  const byId = new Map(
    workspace.components.map((component) => [component.id, component]),
  );
  // Match the putLibrary instance guard. AI annotations do not change a live source.
  function structure(
    { assetTier, aiHints, ...definition }: LibraryComponent,
    system: DesignSystem | undefined,
  ) {
    const nodes = definition.variants.flatMap((variant) => variant.nodes);
    const dependencies = libraryDesignSystem(
      system,
      nodes.flatMap((node) => [
        node,
        ...(node.interactions ?? []).map((interaction) => ({
          ...node,
          interaction,
        })),
      ]),
    );
    return JSON.stringify({ definition, dependencies }, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]]),
          )
        : value,
    );
  }
  for (const local of installed.components) {
    const remote = byId.get(local.id);
    if (
      remote &&
      structure(local, installed.designSystem) ===
        structure(remote, workspace.designSystem)
    )
      continue;
    if (installed.revision >= workspace.revision)
      throw new Error(
        `当前文件中的组件「${local.name}」与工作区副本存在分歧，请先同步组件库或另存为新库，避免覆盖本地定义`,
      );
    throw new Error(
      "当前文件中的已安装组件库与工作区副本存在结构冲突，请先同步组件库或另存为新库，避免覆盖工作区组件",
    );
  }
}

function appendSelection(
  doc: DesignDocument,
  target: ComponentLibrary,
  candidate: ComponentLibrary,
) {
  // Asset IDs are content hashes. A conflicting payload cannot be installed
  // alongside the original in a valid document.
  for (const kind of ["images", "fonts"] as const) {
    for (const [id, asset] of Object.entries(candidate[kind] ?? {})) {
      const existing = target[kind]?.[id];
      if (existing && existing.data !== asset.data)
        throw new Error("同一资源 ID 的内容不一致：" + id);
    }
  }
  let designSystem = target.designSystem ?? candidate.designSystem;
  if (target.designSystem && candidate.designSystem) {
    // Package ONLY the incoming component against the destination definitions.
    // Packaging remaps conflicting aliases, styles, modes and prototype rules on
    // its own copy. Keep the old components and their dependency IDs verbatim.
    candidate = packageDocumentAsLibrary(
      {
        ...doc,
        designSystem: target.designSystem,
        libraries: { [candidate.id]: candidate },
      },
      { id: candidate.id, name: candidate.name, libraryIds: [candidate.id] },
    );
    const added = candidate.designSystem!;
    // A remapped style can also collide with a document style that was never
    // used in the target library. Reserve those names before putLibrary runs.
    const styles = distinctStyleNames(
      added.styles,
      doc.designSystem?.styles ?? {},
      target.designSystem.styles,
    );
    designSystem = {
      collections: { ...added.collections, ...target.designSystem.collections },
      variables: { ...added.variables, ...target.designSystem.variables },
      styles: { ...styles, ...target.designSystem.styles },
      activeModes: { ...added.activeModes, ...target.designSystem.activeModes },
    };
  }
  return {
    ...target,
    revision: target.revision + 1,
    components: [...target.components, ...candidate.components],
    designSystem,
    images: { ...candidate.images, ...target.images },
    ...(candidate.fonts && { fonts: { ...candidate.fonts, ...target.fonts } }),
  };
}

function refreshedGuide(library: ComponentLibrary) {
  const guide = library.aiGuide;
  const markdown = guide?.playbookMarkdown ?? "";
  const literal = "<!-- forma:custom-notes -->";
  const start = markdown.indexOf(literal);
  if (start < 0 || markdown.includes(CUSTOM_NOTES_START))
    return generateLibraryPlaybook(library, guide).aiGuide;

  // Older hand-written guides use the literal marker (optionally closed).
  // Give the generator its native delimiters for budgeting, then restore the
  // original delimiters as well as all whitespace inside the notes.
  const close = "<!-- /forma:custom-notes -->";
  const body = start + literal.length;
  const end = markdown.indexOf(close, body);
  const notes = markdown.slice(body, end < 0 ? undefined : end);
  const generated = generateLibraryPlaybook(library, {
    ...guide,
    playbookMarkdown: CUSTOM_NOTES_START + notes + CUSTOM_NOTES_END,
  }).aiGuide;
  generated.playbookMarkdown = generated
    .playbookMarkdown!.replace(CUSTOM_NOTES_START, literal)
    .replace(CUSTOM_NOTES_END, end < 0 ? "" : close);
  return generated;
}

export function promoteSelectionToLibrary(
  doc: DesignDocument,
  nodeId: string,
  options: PromoteSelectionOptions = {},
): PromoteSelectionResult {
  const root = selectionRoot(doc, nodeId);
  const requested = options.targetLibraryId;
  if (requested && OFFICIAL_BUILTIN_LIBRARY_IDS.has(requested))
    throw new Error("官方内置组件库为只读，请沉淀至项目衍生库或自定义组件库");
  const explicit = requested && requested !== NEW_PROJECT_LIBRARY_TARGET;
  const id = explicit
    ? requested
    : options.projectId
      ? projectDerivedLibraryId(options.projectId)
      : "lib-" + crypto.randomUUID();
  const workspace =
    options.existingWorkspaceLibrary?.id === id
      ? options.existingWorkspaceLibrary
      : undefined;
  const installed = Object.hasOwn(doc.libraries ?? {}, id)
    ? doc.libraries?.[id]
    : undefined;
  if (workspace && installed) checkWorkspaceComponents(installed, workspace);
  const target = workspace ?? installed;
  if (explicit && !target) throw new Error("目标组件库不存在，请重新选择");
  const candidate = extract(
    doc,
    root,
    target?.name ??
      (options.newLibraryName?.trim() ||
        newLibraryName(doc, options.projectName)),
  );
  const component = candidate.components[0];
  component.name = options.componentName?.trim() || component.name;
  component.id = nextComponentId(component.name, target);
  if (options.category?.trim()) component.category = options.category.trim();
  component.assetTier =
    options.assetTier ?? classifyComponentTier(component, candidate);
  component.category =
    options.category?.trim() || categories[component.assetTier];
  component.description = options.description?.trim() ?? "";
  const whenToUse = options.whenToUse?.trim();
  const tags = [
    ...new Set(options.tags?.map((tag) => tag.trim()).filter(Boolean)),
  ];
  if (whenToUse || tags.length)
    component.aiHints = {
      ...(whenToUse && { whenToUse }),
      ...(tags.length && { tags }),
    };

  const next = target
    ? appendSelection(doc, target, candidate)
    : { ...candidate, id };
  const playbookRefreshed = options.refreshPlaybook !== false;
  if (playbookRefreshed) next.aiGuide = refreshedGuide(next);
  const library = parseLibrary(next);
  const componentId = component.id;
  const variantId = component.variants[0].id;
  const operations: Operation[] = [{ type: "putLibrary", library }];
  const result = {
    library,
    componentId,
    variantId,
    createdNewLibrary: !target,
    playbookRefreshed,
    operations,
  };
  // A designer may have renamed an installed style and reused its old name
  // for another ID in this document. Stage distinct names for the install
  // and restore the designer's names within the same atomic transaction.
  const host = doc.designSystem;
  const stagedStyles =
    host && doc.libraries?.[id] && library.designSystem
      ? distinctStyleNames(host.styles, library.designSystem.styles)
      : undefined;
  let restore: Operation | undefined;
  if (host && stagedStyles && stagedStyles !== host.styles) {
    operations.unshift({
      type: "setDesignSystem",
      system: { ...host, styles: stagedStyles },
    });
  }
  if (
    !options.replaceSelectionWithInstance &&
    !(workspace && installed) &&
    operations.length === 1
  )
    return result;
  if (
    options.replaceSelectionWithInstance &&
    component.variants[0].nodes.some((n) => n.locked)
  )
    throw new Error("包含锁定的子图层，无法替换选区");

  const afterPut = transact(doc, { baseRevision: doc.revision, operations });
  if (host && operations[0].type === "setDesignSystem") {
    const system = afterPut.designSystem!;
    const styles = distinctStyleNames(system.styles, host.styles);
    restore = {
      type: "setDesignSystem",
      system: { ...system, styles: { ...styles, ...host.styles } },
    };
  }
  if (!options.replaceSelectionWithInstance) {
    if (restore) operations.push(restore);
    return result;
  }
  const localLibrary = afterPut.libraries![id];
  const localComponent = localLibrary.components.find(
    (c) => c.id === componentId,
  )!;
  // First-time foreign installs can assign different token IDs on each replay.
  const remapped =
    JSON.stringify(localComponent.variants) !==
    JSON.stringify(library.components.at(-1)!.variants);
  // switchInstance rebuilds child rules and the root's singular interaction.
  // For a multi-trigger root preserve the original document bindings as live
  // instance overrides, including the bindings those prototype actions drive.
  const keepFileBindings = remapped && !!root.interactions?.length;
  const placementLibrary = keepFileBindings
    ? parseLibrary({ ...candidate, id })
    : localLibrary;
  const placementDoc = keepFileBindings
    ? {
        ...afterPut,
        libraries: { ...afterPut.libraries, [id]: placementLibrary },
      }
    : afterPut;
  const instance = instantiateComponent(
    placementDoc,
    placementLibrary,
    componentId,
    variantId,
    root.parentId,
    layoutBounds(doc).get(nodeId)!,
  );
  operations.push({ type: "remove", id: nodeId });
  // The source template IDs came from this selection. Reuse them for incoming
  // navigation, scroll/control actions, masks and references on inactive pages.
  const sourceIds = new Map(
    component.variants[0].nodes.map((n) => [n.templateKey, n.id]),
  );
  const creates = instance.operations.filter((op) => op.type === "create");
  const ids = new Map(
    creates.map(({ node }) => [node.id, sourceIds.get(node.templateKey)!]),
  );
  const rootCreate = creates.find((op) => op.node.id === instance.id)!;
  for (const op of creates) {
    const node = op.node;
    node.id = ids.get(node.id)!;
    if (node.parentId) node.parentId = ids.get(node.parentId) ?? node.parentId;
    if (node.maskSourceId)
      node.maskSourceId = ids.get(node.maskSourceId) ?? node.maskSourceId;
    remapInteraction(node, ids);
  }
  // transact protects children as soon as an instance with a pre-existing ID
  // is present. Assemble the children before placing their protected root.
  for (const op of instance.operations) {
    if (op.type === "putLibrary" || op === rootCreate) continue;
    operations.push(op);
  }
  operations.push(rootCreate);
  if (remapped && !keepFileBindings)
    operations.push({
      type: "switchInstance",
      id: nodeId,
      variantId,
      reset: true,
    });
  const siblings = doc.nodes.filter((n) => n.parentId === root.parentId);
  const index = siblings.findIndex((n) => n.id === nodeId);
  operations.push({ type: "reorder", id: nodeId, index });
  const parent = doc.nodes.find((n) => n.id === root.parentId);
  if (parent?.maskSourceId === nodeId)
    operations.push({
      type: "update",
      id: parent.id,
      patch: { maskSourceId: nodeId, maskType: parent.maskType },
    });
  if (restore) operations.push(restore);
  return { ...result, replacedNodeId: nodeId };
}
