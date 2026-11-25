import { currentTextLayout } from "./text-shape";
import { materializeSlots, variantFor, type SlotRef } from "./component-slots";
import {
  integrateLibrarySystem,
  libraryDesignSystem,
  libraryFonts,
} from "./library-design-system";
import { remapInteraction } from "./prototype";
import { type DesignDocument, type DesignNode } from "./document";
import {
  parseLibrary,
  type ComponentLibrary,
  type ComponentVariant,
} from "./library-schema";
import type { Operation } from "./commands";
import { ancestors, isLocked, subtreeIds } from "./tree";
import { layoutBounds, type Point } from "./geometry";

export function installLibrary(doc: DesignDocument, input: unknown) {
  const library = parseLibrary(input);
  const existing = doc.libraries?.[library.id];
  if (existing && JSON.stringify(existing) !== JSON.stringify(library)) {
    const canMerge =
      existing.revision === library.revision &&
      existing.components.every((c) => {
        const other = library.components.find((n) => n.id === c.id);
        return !other || JSON.stringify(c) === JSON.stringify(other);
      });
    if (canMerge)
      library.components = [
        ...existing.components,
        ...library.components.filter(
          (c) => !existing.components.some((n) => n.id === c.id),
        ),
      ];
    else library.id = `${library.id.slice(0, 80)}-${crypto.randomUUID()}`;
  }
  return library;
}

export function instanceSource(doc: DesignDocument, node: DesignNode) {
  const ref = node.instance;
  if (!ref) return null;
  const library = doc.libraries?.[ref.libraryId];
  const component = library?.components.find((c) => c.id === ref.componentId);
  const variant = component?.variants.find((v) => v.id === ref.variantId);
  return library && component && variant
    ? { library, component, variant: materializeSlots(doc, variant, ref.slots) }
    : null;
}

/** Imported legacy instances remain readable; all newly assembled instances must match their source graph. */
export function validateInstanceStructure(
  doc: DesignDocument,
  root: DesignNode,
) {
  const source = instanceSource(doc, root);
  if (!source) throw new Error("实例来源不可用");
  const ids = subtreeIds(doc, [root.id]);
  const current = doc.nodes.filter((n) => ids.has(n.id));
  const templates = source.variant.nodes;
  const byKey = new Map(current.map((n) => [n.templateKey, n]));
  if (current.length !== templates.length || byKey.size !== current.length)
    throw new Error("组件实例结构与定义不一致");
  for (const template of templates) {
    const node = byKey.get(template.templateKey);
    const parentKey = templates.find(
      (n) => n.id === template.parentId,
    )?.templateKey;
    if (
      !node ||
      node.type !== template.type ||
      (template.parentId && node.parentId !== byKey.get(parentKey)?.id) ||
      (!template.parentId && node.id !== root.id) ||
      (node.id !== root.id && node.instance)
    )
      throw new Error("组件实例结构与定义不一致");
    const children = current
      .filter((n) => n.parentId === node.id)
      .map((n) => n.templateKey);
    const expected = templates
      .filter((n) => n.parentId === template.id)
      .map((n) => n.templateKey);
    if (JSON.stringify(children) !== JSON.stringify(expected))
      throw new Error("组件实例子层顺序与定义不一致");
  }
}

function ordered(nodes: DesignNode[]) {
  const result: DesignNode[] = [];
  const visit = (parentId: string | null) => {
    for (const node of nodes.filter((n) => n.parentId === parentId)) {
      result.push(node);
      visit(node.id);
    }
  };
  visit(null);
  return result;
}

export function instantiateComponent(
  doc: DesignDocument,
  library: ComponentLibrary,
  componentId: string,
  variantId: string,
  parentId: string | null,
  position: Point,
) {
  const { library: installed, system } = integrateLibrarySystem(
    doc,
    installLibrary(doc, library),
  );
  const component = installed.components.find((c) => c.id === componentId);
  const variant = component?.variants.find((v) => v.id === variantId);
  if (!variant) throw new Error("找不到组件变体");
  if (parentId && isLocked(doc, parentId)) throw new Error("目标容器已锁定");
  const root = variant.nodes.find((n) => n.parentId === null)!;
  const ids = new Map(variant.nodes.map((n) => [n.id, crypto.randomUUID()]));
  const parent = parentId ? layoutBounds(doc).get(parentId) : undefined;
  const operations: Operation[] = [];
  if (system && system !== doc.designSystem)
    operations.push({ type: "setDesignSystem", system });
  for (const [id, image] of Object.entries(installed.images ?? {}))
    if (!doc.images?.[id]) operations.push({ type: "putImage", id, image });
  if (
    JSON.stringify(doc.libraries?.[installed.id]) !== JSON.stringify(installed)
  )
    operations.push({ type: "putLibrary", library: installed });
  for (const template of ordered(variant.nodes)) {
    const node = structuredClone(template);
    if (node.maskSourceId) node.maskSourceId = ids.get(node.maskSourceId);
    remapInteraction(node, ids);
    node.id = ids.get(template.id)!;
    node.parentId = template.parentId ? ids.get(template.parentId)! : parentId;
    node.locked = false;
    if (template.id === root.id) {
      node.style.x = position.x - (parent?.x ?? 0);
      node.style.y = position.y - (parent?.y ?? 0);
      node.instance = { libraryId: installed.id, componentId, variantId };
    }
    operations.push({ type: "create", node });
  }
  for (const node of [...ordered(variant.nodes)]
    .reverse()
    .filter((n) => n.locked))
    operations.push({
      type: "update",
      id: ids.get(node.id)!,
      patch: { locked: true },
    });
  return { operations, id: ids.get(root.id)! };
}

function changedFields(node: DesignNode, template: DesignNode) {
  const patch: Partial<DesignNode> = {};
  for (const key of [
    "name",
    "text",
    "textRuns",
    "hidden",
    "locked",
    "devStatus",
    "exportSettings",
    "annotations",
    "fillToken",
    "vector",
    "control",
    "interaction",
    "interactions",
    "image",
    "variableBindings",
    "variableModes",
    "styleBindings",
    "styleOverrides",
  ] as const)
    if (
      node.instanceOverrides?.includes(key) ||
      JSON.stringify(node[key]) !== JSON.stringify(template[key])
    )
      Object.assign(patch, { [key]: node[key] });
  const style: Partial<DesignNode["style"]> = {};
  for (const key of new Set([
    ...Object.keys(node.style),
    ...Object.keys(template.style),
  ])) {
    const k = key as keyof DesignNode["style"];
    if (
      node.instanceOverrides?.includes("style." + k) ||
      JSON.stringify(node.style[k]) !== JSON.stringify(template.style[k])
    )
      Object.assign(style, { [key]: node.style[k] });
  }
  return { patch, style };
}

function copySlots(values?: Record<string, SlotRef>): Record<string, SlotRef> {
  return Object.assign(Object.create(null), values);
}

/** Variant changes retain edits by stable template key, never by array position. */
export function planSwitchInstance(
  doc: DesignDocument,
  id: string,
  variantId: string,
  reset = false,
  updatedVariant?: ComponentVariant,
  options?: {
    slots?: NonNullable<DesignNode["instance"]>["slots"];
    targetDocument?: DesignDocument;
  },
): Operation[] {
  const root = doc.nodes.find((n) => n.id === id);
  if (!root) throw new Error("实例已不存在");
  const source = instanceSource(doc, root);
  const baseTarget =
    updatedVariant ??
    source?.component.variants.find((v) => v.id === variantId);
  if (!source || !baseTarget) throw new Error("实例来源不可用");
  let slots = reset
    ? undefined
    : options && "slots" in options
      ? options.slots
      : root.instance?.slots;
  if (slots) slots = copySlots(slots);
  let slotProperties = reset ? undefined : root.instance?.slotProperties;
  if (slotProperties) {
    slotProperties = copySlots(slotProperties);
    const live = slots ?? copySlots();
    for (const prop of source.component.exposed ?? []) {
      if (prop.kind !== "swap" || !slotProperties[prop.id]) continue;
      const shown = baseTarget.nodes.some(
        (n) => n.nestedSlot && n.templateKey === prop.target,
      );
      if (!shown) {
        delete live[prop.target];
        continue;
      }
      if (options && "slots" in options) {
        if (live[prop.target]) slotProperties[prop.id] = live[prop.target];
        else delete slotProperties[prop.id];
      } else live[prop.target] ??= slotProperties[prop.id];
    }
    slots = Object.keys(live).length ? live : undefined;
    if (!Object.keys(slotProperties).length) slotProperties = undefined;
  }
  const targetDoc = options?.targetDocument ?? doc;
  const target = materializeSlots(targetDoc, baseTarget, slots);
  const ids = subtreeIds(doc, [id]);
  const current = doc.nodes.filter((n) => ids.has(n.id));
  if (!updatedVariant && current.some((n) => isLocked(doc, n.id)))
    throw new Error("请先解除实例及子层锁定");
  const byKey = new Map(current.map((n) => [n.templateKey, n]));
  // Compare references in the instance namespace. Materializing a template remaps
  // internal action targets even when the designer never edits that interaction.
  const instanceIds = new Map(
    source.variant.nodes.flatMap((n) => {
      const instance = byKey.get(n.templateKey);
      return instance ? [[n.id, instance.id] as const] : [];
    }),
  );
  const previous = new Map(
    source.variant.nodes.map((n) => {
      if (!n.interaction) return [n.templateKey, n] as const;
      const original = { ...n, interaction: structuredClone(n.interaction) };
      remapInteraction(original, instanceIds);
      return [n.templateKey, original] as const;
    }),
  );
  const targetKeys = new Set(target.nodes.map((n) => n.templateKey));
  if (!reset) {
    if (
      byKey.size !== current.length ||
      current.length !== source.variant.nodes.length ||
      current.some((n) => !previous.has(n.templateKey))
    )
      throw new Error("实例结构已编辑，请先重置实例或分离组件后继续");
    for (const node of current) {
      const original = previous.get(node.templateKey)!;
      const parentKey = current.find(
        (n) => n.id === node.parentId,
      )?.templateKey;
      const originalParent = source.variant.nodes.find(
        (n) => n.id === original.parentId,
      )?.templateKey;
      if (node.id !== id && parentKey !== originalParent)
        throw new Error("实例层级已编辑，请先重置或分离");
      const siblings = current
        .filter((n) => n.parentId === node.id)
        .map((n) => n.templateKey);
      const originalSiblings = source.variant.nodes
        .filter((n) => n.parentId === original.id)
        .map((n) => n.templateKey);
      if (JSON.stringify(siblings) !== JSON.stringify(originalSiblings))
        throw new Error("实例子层顺序已编辑，请先重置或分离");
      const changes = changedFields(node, original);
      if (
        !targetKeys.has(node.templateKey) &&
        (Object.keys(changes.patch).length || Object.keys(changes.style).length)
      )
        throw new Error(
          `目标变体没有已编辑的图层“${node.name}”，请先分离或重置，避免丢失修改`,
        );
    }
  }
  const targetRoot = target.nodes.find((n) => n.parentId === null)!;
  const mapping = new Map(
    target.nodes.map((n) => [
      n.id,
      n.id === targetRoot.id
        ? id
        : (byKey.get(n.templateKey)?.id ?? crypto.randomUUID()),
    ]),
  );
  const operations: Operation[] = [];
  for (const id of new Set(
    target.nodes.flatMap((n) => (n.image ? [n.image.assetId] : [])),
  )) {
    if (doc.images?.[id]) continue;
    const asset = Object.values(targetDoc.libraries ?? {}).find(
      (l) => l.images?.[id],
    )?.images?.[id];
    if (asset) operations.push({ type: "putImage", id, image: asset });
  }
  for (const child of current.filter((n) => n.parentId === id))
    operations.push({ type: "remove", id: child.id });
  for (const template of ordered(target.nodes)) {
    const node = structuredClone(template);
    const old = byKey.get(template.templateKey);
    const original = previous.get(template.templateKey);
    if (!reset && old && original) {
      const changes = changedFields(old, original);
      Object.assign(node, changes.patch);
      if (old.instanceOverrides)
        node.instanceOverrides = old.instanceOverrides.slice();
      if (old.control && original.control && template.control) {
        node.control = { ...template.control };
        for (const key of Object.keys(old.control) as (keyof NonNullable<
          DesignNode["control"]
        >)[])
          if (
            JSON.stringify(old.control[key]) !==
            JSON.stringify(original.control[key])
          )
            Object.assign(node.control, { [key]: old.control[key] });
      }
      Object.assign(node.style, changes.style);
      if (changes.patch.text !== undefined) {
        const previousLayout = currentTextLayout({
          ...node,
          sourceTextLayout: old.sourceTextLayout,
        });
        if (previousLayout) node.sourceTextLayout = previousLayout;
        if (!currentTextLayout(node)) delete node.sourceTextLayout;
        if (node.sourceTextShape?.text !== node.text)
          delete node.sourceTextShape;
      }
    }
    if (node.maskSourceId) node.maskSourceId = mapping.get(node.maskSourceId);
    remapInteraction(node, mapping);
    node.id = mapping.get(template.id)!;
    node.parentId = template.parentId
      ? mapping.get(template.parentId)!
      : root.parentId;
    if (template.id === targetRoot.id) {
      Object.assign(node.style, { x: root.style.x, y: root.style.y });
      // Explicitly clear optional values that do not exist in the next variant.
      const style = Object.fromEntries(
        Object.keys(root.style).map((k) => [k, undefined]),
      );
      operations.push({
        type: "update",
        id,
        patch: {
          name: node.name,
          text: node.text,
          textRuns: node.textRuns,
          sourceTextShape: node.sourceTextShape,
          sourceTextLayout: node.sourceTextLayout,
          hidden: node.hidden,
          templateKey: node.templateKey,
          fillToken: node.fillToken,
          control: node.control,
          vector: node.vector,
          maskSourceId: node.maskSourceId,
          maskType: node.maskType,
          siblingMask: node.siblingMask,
          booleanOperation: node.booleanOperation,
          compoundWindingRule: node.compoundWindingRule,
          operandOperation: node.operandOperation,
          interaction: node.interaction,
          image: node.image,
          variableBindings: node.variableBindings,
          variableModes: node.variableModes,
          styleBindings: node.styleBindings,
          styleOverrides: node.styleOverrides,
          instanceOverrides: node.instanceOverrides,
          instance: {
            ...root.instance!,
            ...(root.instance?.slotProperties ? { slotProperties } : {}),
            variantId,
            ...(slots ? { slots } : { slots: undefined }),
          },
        },
        style: { ...style, ...node.style },
      });
    } else
      operations.push({ type: "create", node: { ...node, locked: false } });
  }
  for (const template of [...ordered(target.nodes)]
    .reverse()
    .filter((n) => n.locked && n.id !== targetRoot.id))
    operations.push({
      type: "update",
      id: mapping.get(template.id)!,
      patch: { locked: true },
    });
  return operations;
}

export function planSetSlot(
  doc: DesignDocument,
  id: string,
  property: string,
  value?: SlotRef,
) {
  const root = doc.nodes.find((n) => n.id === id);
  const source = root && instanceSource(doc, root);
  const p = source?.component.exposed?.find(
    (p) => p.id === property && p.kind === "swap",
  );
  if (!root?.instance || !p) throw Error("实例没有公开此替换属性");
  if (value && !variantFor(doc, value)) throw Error("请先安装要使用的组件库");
  if (
    value &&
    value.componentId === root.instance.componentId &&
    value.libraryId === root.instance.libraryId
  )
    throw Error("实例不能嵌套自身");
  if ([...subtreeIds(doc, [id])].some((n) => isLocked(doc, n)))
    throw Error("请先解除实例及子层锁定");
  const slots = copySlots(root.instance.slots);
  if (value) slots[p.target] = value;
  else delete slots[p.target];
  return planSwitchInstance(
    doc,
    id,
    root.instance.variantId,
    false,
    undefined,
    { slots: Object.keys(slots).length ? slots : undefined },
  );
}

export function planDetachInstance(
  doc: DesignDocument,
  id: string,
): Operation[] {
  if (!doc.nodes.find((n) => n.id === id)?.instance)
    throw new Error("请选中组件实例");
  const ids = subtreeIds(doc, [id]);
  return doc.nodes
    .filter((n) => ids.has(n.id))
    .map((n) => ({
      type: "update",
      id: n.id,
      patch: {
        instance: undefined,
        instanceOverrides: undefined,
        templateKey: undefined,
        nestedSlot: undefined,
        nestedSource: undefined,
        nestedKey: undefined,
        nestedPath: undefined,
      },
    }));
}

export function planSwapInstance(
  doc: DesignDocument,
  id: string,
  libraryId: string,
  componentId: string,
  variantId: string,
): Operation[] {
  const node = doc.nodes.find((n) => n.id === id),
    source = node && instanceSource(doc, node);
  const variant = doc.libraries?.[libraryId]?.components
    .find((c) => c.id === componentId)
    ?.variants.find((v) => v.id === variantId);
  if (!node || !source || !variant) throw Error("选择的组件或变体不存在");
  const root = variant.nodes.find((n) => !n.parentId)!;
  if (root.type !== node.type || root.templateKey !== node.templateKey)
    throw Error("替换需要相同根图层类型和模板键");
  if ([...subtreeIds(doc, [id])].some((layer) => isLocked(doc, layer)))
    throw Error("请先解除实例及子层锁定");
  const ops = planSwitchInstance(doc, id, variantId, false, variant);
  const update = ops.find((op) => op.type === "update" && op.id === id);
  if (update?.type === "update")
    update.patch.instance = {
      ...update.patch.instance,
      libraryId,
      componentId,
      variantId,
    };
  return ops;
}
export function switchInstance(
  doc: DesignDocument,
  id: string,
  variantId: string,
  reset = false,
): Operation[] {
  planSwitchInstance(doc, id, variantId, reset);
  return [{ type: "switchInstance", id, variantId, reset }];
}
export function detachInstance(doc: DesignDocument, id: string): Operation[] {
  planDetachInstance(doc, id);
  return [{ type: "detachInstance", id }];
}

export function createLibraryFromSelection(
  doc: DesignDocument,
  id: string,
  name: string,
  previous?: ComponentVariant,
): ComponentLibrary {
  const root = doc.nodes.find((n) => n.id === id);
  if (!root) throw new Error("请先选中一个组件根图层");
  const included = subtreeIds(doc, [id]);
  const nodes = structuredClone(doc.nodes.filter((n) => included.has(n.id)));
  const keys = new Map<string, string>();
  const nestedLayers = subtreeIds(
    doc,
    nodes.filter((n) => n.id !== id && n.instance).map((n) => n.id),
  );
  const originalById = new Map(
    nodes.map((n) => [
      n.id,
      { instance: n.instance, templateKey: n.templateKey },
    ]),
  );
  for (const node of [...nodes].sort(
    (a, b) => ancestors(doc, a.id).length - ancestors(doc, b.id).length,
  )) {
    const siblings = nodes.filter(
      (n) => n.parentId === node.parentId && n.name === node.name,
    );
    const key =
      node.id === id
        ? "root"
        : `${keys.get(node.parentId!)}/${node.name}:${siblings.findIndex((n) => n.id === node.id)}`;
    keys.set(node.id, key.slice(-128));
    node.templateKey =
      previous?.nodes.find((n) => n.id === node.id)?.templateKey ??
      (previous ? "layer-" + node.id.slice(-120) : keys.get(node.id));
    const original = originalById.get(node.id)!;
    if (node.id !== id && original.instance) {
      node.nestedSlot = true;
      const { libraryId, componentId, variantId } = original.instance;
      node.nestedSource = { libraryId, componentId, variantId };
    }
    if (nestedLayers.has(node.id) && original.templateKey) {
      const inner = node.nestedPath ?? (node.nestedKey ? [node.nestedKey] : []);
      node.nestedKey = original.templateKey;
      if (inner.length) node.nestedPath = [original.templateKey, ...inner];
    }
    delete node.instance;

    if (node.fillToken) {
      node.style.fill = doc.tokens[node.fillToken].value;
      delete node.fillToken;
    }
    if (node.id === id) {
      node.parentId = null;
      node.style.x = 0;
      node.style.y = 0;
    }
  }
  const designSystem = libraryDesignSystem(doc.designSystem, nodes);
  const fonts = libraryFonts(doc, nodes, designSystem);
  return parseLibrary({
    format: "forma/library",
    version: 1,
    id: crypto.randomUUID(),
    name,
    designSystem,
    description: "从当前设计创建的自定义组件库",
    revision: 1,
    ...(fonts ? { fonts } : {}),
    images: Object.fromEntries(
      nodes
        .filter((n) => n.image)
        .map((n) => [n.image!.assetId, doc.images![n.image!.assetId]]),
    ),
    source: { name: "用户创建", license: "用户自有资源" },
    components: [
      {
        id: "component",
        name: root.name,
        category: "自定义",
        ...(root.instance
          ? {}
          : { master: { documentId: doc.id, nodeId: id } }),
        description: "",
        variants: [{ id: "default", name: "默认", properties: {}, nodes }],
      },
    ],
  });
}

export function variantPreview(variant: ComponentVariant): DesignDocument {
  return {
    schemaVersion: 1,
    id: "preview",
    name: "Preview",
    revision: 0,
    tokens: {},
    nodes: variant.nodes,
  };
}
