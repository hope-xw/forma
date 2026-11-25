import { z } from "zod";
import { localMasters } from "./component-masters";
import { createLibraryFromSelection } from "./library";
import { referencedComponents } from "./component-slots";
import { remapInteraction } from "./prototype";
import { ancestors, instanceOwner, isLocked, subtreeIds } from "./tree";
import {
  libraryDesignSystem,
  libraryFonts,
  templateNodes,
} from "./library-design-system";
import { createNode, type DesignDocument, type DesignNode } from "./document";
import { layoutBounds } from "./geometry";
import type { ComponentVariant, ExposedProperty } from "./library-schema";

const id = z.string().min(1).max(128);
const axisName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((name) => !["__proto__", "constructor", "prototype"].includes(name));
const valueName = z.string().trim().min(1).max(200);
export const variantOperations = [
  z.object({
    type: z.literal("addComponentVariant"),
    id,
    newId: id,
    variantId: id,
    axis: axisName,
    value: valueName,
    defaultValue: valueName.optional(),
  }),
  z.object({
    type: z.literal("editVariantProperty"),
    id,
    axis: axisName,
    newAxis: axisName,
    value: valueName,
  }),
  z.object({ type: z.literal("unlinkComponentVariant"), id }),
  z.object({ type: z.literal("arrangeComponentSet"), id }),
  z.object({ type: z.literal("includeSetDrawing"), id, setId: id }),
  z.object({
    type: z.literal("createVariantSet"),
    canvas: z.literal(true).optional(),
    libraryId: id,
    name: valueName,
    axis: axisName,
    members: z
      .array(z.object({ id, value: valueName, variantId: id }))
      .min(2)
      .max(200),
  }),
] as const;
type Change = z.infer<(typeof variantOperations)[number]>;

function uniqueCombinations(variants: ComponentVariant[]) {
  const seen = new Set<string>();
  for (const variant of variants) {
    const key = JSON.stringify(
      Object.entries(variant.properties).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
    if (seen.has(key)) throw Error("已有相同属性组合的变体");
    seen.add(key);
  }
}
function variantName(props: Record<string, string>) {
  return Object.values(props).join(" / ").slice(0, 200);
}
function cloneDrawing(
  doc: DesignDocument,
  root: DesignNode,
  newId: string,
  x: number,
  y: number,
) {
  const scope = subtreeIds(doc, [root.id]);
  const originals = doc.nodes.filter((n) => scope.has(n.id));
  const mapping = new Map(
    originals.map((n) => [
      n.id,
      n.id === root.id ? newId : crypto.randomUUID(),
    ]),
  );
  for (const original of originals) {
    const n = structuredClone(original);
    n.id = mapping.get(n.id)!;
    n.parentId = mapping.get(n.parentId ?? "") ?? n.parentId;
    if (n.maskSourceId)
      n.maskSourceId = mapping.get(n.maskSourceId) ?? n.maskSourceId;
    remapInteraction(n, mapping);
    if (original.id === root.id) {
      n.style.x = x;
      n.style.y = y;
    }
    doc.nodes.push(n);
  }
  return mapping;
}

function clonedTemplate(variant: ComponentVariant, ids: Map<string, string>) {
  return {
    ...variant,
    nodes: variant.nodes.map((n) => ({ ...n, id: ids.get(n.id) ?? n.id })),
  };
}

function arrangeSet(doc: DesignDocument, masterId: string) {
  const sources = localMasters(doc);
  const master = sources.find((m) => m.nodeId === masterId);
  if (!master) throw Error("请选择本页主组件");
  const { component, library } = master;
  const drawings = sources
    .filter((m) => m.component === component)
    .map((m) => ({ ...m, node: doc.nodes.find((n) => n.id === m.nodeId) }));
  if (
    drawings.some(
      (m) => !m.node || isLocked(doc, m.nodeId) || instanceOwner(doc, m.nodeId),
    )
  )
    throw Error("请先将同一组件集的可编辑主件放在本页");
  const first = drawings[0].node!;
  let group = doc.nodes.find(
    (n) =>
      n.componentSet?.libraryId === library.id &&
      n.componentSet?.componentId === component.id &&
      drawings.some((m) => m.node!.parentId === n.id),
  );
  if (group && isLocked(doc, group.id)) throw Error("组件集已锁定");
  if (!group) {
    const sameParent = drawings.every(
      (m) => m.node!.parentId === first.parentId,
    );
    group = createNode("group", sameParent ? first.parentId : null);
    const origin = sameParent ? first.style : layoutBounds(doc).get(first.id)!;
    group.componentSet = { libraryId: library.id, componentId: component.id };
    group.name = (component.name + " · 组件集").slice(0, 200);
    Object.assign(group.style, {
      x: origin.x - 24,
      y: origin.y - 32,
      padding: 0,
      layout: "free",
    });
    doc.nodes.push(group);
  }
  const axes = Object.keys(component.variants[0].properties);
  const columns = [
    ...new Set(drawings.map((m) => m.variant.properties[axes[0]] ?? "")),
  ];
  const rows = [
    ...new Set(
      drawings.map((m) =>
        JSON.stringify(axes.slice(1).map((axis) => m.variant.properties[axis])),
      ),
    ),
  ];
  const widths = columns.map(() => 0),
    heights = rows.map(() => 0);
  const cells = drawings.map(({ variant, node }) => {
    const col = columns.indexOf(variant.properties[axes[0]] ?? "");
    const row = rows.indexOf(
      JSON.stringify(axes.slice(1).map((a) => variant.properties[a])),
    );
    widths[col] = Math.max(widths[col], node!.style.width);
    heights[row] = Math.max(heights[row], node!.style.height);
    return { row, col, node: node! };
  });
  const offset = (sizes: number[], i: number) =>
    sizes.slice(0, i).reduce((sum, v) => sum + v + 24, 0);
  for (const { row, col, node } of cells) {
    node.parentId = group.id;
    node.style.x = 24 + offset(widths, col);
    node.style.y = 32 + offset(heights, row);
  }
  group.style.width = 24 + offset(widths, widths.length);
  group.style.height = 32 + offset(heights, heights.length);
  return group;
}
function includeSetDrawing(doc: DesignDocument, id: string, setId: string) {
  const group = doc.nodes.find((n) => n.id === setId);
  const source = doc.nodes.find((n) => n.id === id);
  const ref = group?.componentSet;
  const library = ref && doc.libraries?.[ref.libraryId],
    component = library?.components.find((c) => c.id === ref!.componentId);
  const first = doc.nodes.find((n) => n.id === component?.master?.nodeId);
  if (
    !group ||
    !library ||
    !component ||
    component.master?.documentId !== doc.id ||
    !first ||
    first.parentId !== group.id ||
    !source ||
    source.type !== first.type ||
    source.componentSet ||
    instanceOwner(doc, id) ||
    isLocked(doc, id) ||
    isLocked(doc, setId) ||
    ancestors(doc, setId).some((n) => n.id === id) ||
    ancestors(doc, id).some((n) => n.id === setId)
  )
    throw Error("请拖入可编辑且类型一致的独立图层或主组件");
  const original = localMasters(doc).find((m) => m.nodeId === id);
  let drawing = source,
    previous: ComponentVariant | undefined;
  if (original) {
    const copy = crypto.randomUUID();
    const ids = cloneDrawing(doc, source, copy, 0, 0);
    drawing = doc.nodes.find((n) => n.id === copy)!;
    previous = clonedTemplate(original.variant, ids);
  }
  const captured = createLibraryFromSelection(
    doc,
    drawing.id,
    library.name,
    previous,
  );
  const template = captured.components[0].variants[0];
  const base = component.variants[0].properties;
  const axis = Object.keys(base)[0] ?? "状态";
  if (!Object.keys(base).length) base[axis] = "默认";
  const baseValue = drawing.name.slice(0, 180);
  let value = baseValue,
    i = 2;
  while (component.variants.some((v) => v.properties[axis] === value))
    value = baseValue + " " + i++;
  const properties = { ...base, [axis]: value };
  component.variants.push({
    ...template,
    id: crypto.randomUUID(),
    masterNodeId: drawing.id,
    properties,
    name: variantName(properties),
  });
  library.images = { ...library.images, ...captured.images };
  const nodes = templateNodes(library);
  library.designSystem = libraryDesignSystem(doc.designSystem, nodes);
  library.fonts = libraryFonts(doc, nodes, library.designSystem);
  library.revision++;
  arrangeSet(doc, first.id);
}
function createVariantSet(
  doc: DesignDocument,
  change: Extract<Change, { type: "createVariantSet" }>,
) {
  if (doc.libraries?.[change.libraryId]) throw Error("组件库标识已存在");
  const roots = change.members.map((m) => doc.nodes.find((n) => n.id === m.id));
  const ids = new Set(change.members.map((m) => m.id));
  if (
    ids.size !== roots.length ||
    new Set(change.members.map((m) => m.variantId)).size !== roots.length
  )
    throw Error("不能重复选择同一图层或变体");
  const masters = localMasters(doc);
  const exposed = new Map<string, ExposedProperty>();
  const snapshots = change.members.map((member, i) => {
    let root = roots[i];
    if (
      !root ||
      root.componentSet ||
      root.type !== roots[0]?.type ||
      instanceOwner(doc, root.id) ||
      isLocked(doc, root.id)
    )
      throw Error("请选择相同图层类型的可编辑主组件或普通图层");
    if (ancestors(doc, root.id).some((n) => ids.has(n.id)))
      throw Error("不能同时选择变体与其子层");
    const original = masters.find((m) => m.nodeId === member.id);
    let previous: ComponentVariant | undefined;
    if (original) {
      const copy = crypto.randomUUID();
      const ids = cloneDrawing(
        doc,
        root,
        copy,
        root.style.x,
        root.style.y + root.style.height + 32,
      );
      previous = clonedTemplate(original.variant, ids);
      root = doc.nodes.find((n) => n.id === copy)!;
    }
    if (i === 0) root.name = change.name;
    const lib = createLibraryFromSelection(doc, root.id, change.name, previous);
    const variant: ComponentVariant = {
      ...lib.components[0].variants[0],
      id: member.variantId,
      name: member.value,
      properties: { [change.axis]: member.value },
      ...(i ? { masterNodeId: root.id } : {}),
    };
    for (const prop of original?.component.exposed ?? []) {
      if (!variant.nodes.some((n) => n.templateKey === prop.target)) continue;
      const existing = exposed.get(prop.name);
      if (
        existing &&
        (existing.kind !== prop.kind || existing.target !== prop.target)
      )
        throw Error("同名公开属性的类型或目标不同，请先调整名称：" + prop.name);
      if (!existing)
        exposed.set(prop.name, { ...prop, id: crypto.randomUUID() });
    }
    return { lib, variant };
  });
  const set = snapshots[0].lib;
  set.id = change.libraryId;
  set.name = change.name;
  set.components[0].variants = snapshots.map((s) => s.variant);
  if (exposed.size) set.components[0].exposed = [...exposed.values()];
  uniqueCombinations(set.components[0].variants);
  const nodes = templateNodes(set);
  set.images = Object.assign({}, ...snapshots.map((s) => s.lib.images));
  set.designSystem = libraryDesignSystem(doc.designSystem, nodes);
  set.fonts = libraryFonts(doc, nodes, set.designSystem);
  doc.libraries = { ...doc.libraries, [set.id]: set };
  if (change.canvas) arrangeSet(doc, set.components[0].master!.nodeId);
}
/** Change the source drawings and the portable component definition within the same transaction. */
export function applyVariantChange(doc: DesignDocument, change: Change) {
  if (change.type === "createVariantSet") return createVariantSet(doc, change);
  if (change.type === "arrangeComponentSet") {
    arrangeSet(doc, change.id);
    return;
  }
  if (change.type === "includeSetDrawing")
    return includeSetDrawing(doc, change.id, change.setId);
  const master = localMasters(doc).find((m) => m.nodeId === change.id);
  const root = doc.nodes.find((n) => n.id === change.id);
  if (!master || !root || isLocked(doc, root.id) || instanceOwner(doc, root.id))
    throw Error("请在当前页选择可编辑的本地主组件");
  const { library, component, variant } = master;
  const drawings = [
    ...doc.nodes,
    ...(doc.pages ?? []).flatMap((p) => p.nodes ?? []),
  ];
  const setProperties = (
    v: ComponentVariant,
    properties: Record<string, string>,
  ) => {
    const drawing =
      v.masterNodeId && drawings.find((n) => n.id === v.masterNodeId);
    const automatic = (name: string) =>
      (component.name + " · " + name).slice(0, 200);
    const next = variantName(properties);
    if (drawing && drawing.name === automatic(v.name))
      drawing.name = automatic(next);
    v.properties = properties;
    v.name = next;
  };
  if (change.type === "unlinkComponentVariant") {
    if (component.variants[0] === variant) throw Error("默认变体须保留");
    const layers = [
      ...drawings,
      ...Object.values(doc.libraries ?? {}).flatMap((l) =>
        l.components.flatMap((c) => c.variants.flatMap((v) => v.nodes)),
      ),
    ];
    for (const n of layers) {
      const refs = n.instance ? referencedComponents(n.instance) : [];
      if (n.nestedSource) refs.push(...referencedComponents(n.nestedSource));
      if (
        refs.some(
          (r) =>
            r.libraryId === library.id &&
            r.componentId === component.id &&
            r.variantId === variant.id,
        )
      )
        throw Error("仍有实例使用此变体，请先切换到其他变体");
    }
    component.variants = component.variants.filter((v) => v !== variant);
  } else if (change.type === "editVariantProperty") {
    if (!Object.hasOwn(variant.properties, change.axis))
      throw Error("属性已不存在");
    if (
      change.newAxis !== change.axis &&
      component.variants.some((v) =>
        Object.hasOwn(v.properties, change.newAxis),
      )
    )
      throw Error("新属性名称已存在");
    for (const v of component.variants) {
      setProperties(
        v,
        Object.fromEntries(
          Object.entries(v.properties).map(([axis, value]) =>
            axis === change.axis
              ? [change.newAxis, v === variant ? change.value : value]
              : [axis, value],
          ),
        ),
      );
    }
    uniqueCombinations(component.variants);
  } else {
    if (
      component.variants.length >= 200 ||
      component.variants.some((v) => v.id === change.variantId)
    )
      throw Error("变体数量已达上限或标识重复");
    if (
      doc.nodes.some((n) => n.id === change.newId) ||
      doc.pages?.some((p) => p.nodes?.some((n) => n.id === change.newId))
    )
      throw Error("新图层标识重复");
    if (!Object.hasOwn(variant.properties, change.axis)) {
      if (!change.defaultValue) throw Error("请指定此属性的默认值");
      for (const v of component.variants) {
        setProperties(v, {
          ...v.properties,
          [change.axis]: change.defaultValue,
        });
      }
    }
    const properties = { ...variant.properties, [change.axis]: change.value };
    const siblings = new Set(
      localMasters(doc)
        .filter((m) => m.component === component)
        .map((m) => m.nodeId),
    );
    const right = doc.nodes
      .filter((n) => n.parentId === root.parentId && siblings.has(n.id))
      .reduce(
        (x, n) => Math.max(x, n.style.x + n.style.width),
        root.style.x + root.style.width,
      );
    const mapping = cloneDrawing(
      doc,
      root,
      change.newId,
      right + 32,
      root.style.y,
    );
    doc.nodes.find((n) => n.id === change.newId)!.name = (
      component.name +
      " · " +
      variantName(properties)
    ).slice(0, 200);
    const previous = clonedTemplate(variant, mapping);
    const snapshot = createLibraryFromSelection(
      doc,
      change.newId,
      library.name,
      previous,
    ).components[0].variants[0];
    component.variants.push({
      ...snapshot,
      id: change.variantId,
      masterNodeId: change.newId,
      name: variantName(properties),
      properties,
    });
    uniqueCombinations(component.variants);
  }
  const group = doc.nodes.find(
    (n) =>
      n.id === root.parentId &&
      n.componentSet?.libraryId === library.id &&
      n.componentSet?.componentId === component.id,
  );
  if (group) {
    if (change.type === "unlinkComponentVariant") {
      root.parentId = group.parentId;
      root.style.x = group.style.x + group.style.width + 24;
      root.style.y = group.style.y;
    }
    arrangeSet(doc, component.master!.nodeId);
  }
  library.revision++;
}
