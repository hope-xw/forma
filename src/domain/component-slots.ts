import { maxPageNodes } from "./document-limits";
import type { DesignDocument, DesignNode } from "./document";
import type { ComponentVariant } from "./library-schema";
import { remapInteraction } from "./prototype";
import { stableHash } from "./stable-hash";
import { subtreeIds } from "./tree";

type Instance = NonNullable<DesignNode["instance"]>;
export type SlotRef = Pick<Instance, "libraryId" | "componentId" | "variantId">;
export function referencedComponents(instance: Instance) {
  return [
    instance,
    ...Object.values(instance.slots ?? {}),
    ...Object.values(instance.slotProperties ?? {}),
  ];
}

export function variantFor(
  doc: Pick<DesignDocument, "libraries">,
  ref: SlotRef,
) {
  return doc.libraries?.[ref.libraryId]?.components
    .find((c) => c.id === ref.componentId)
    ?.variants.find((v) => v.id === ref.variantId);
}

/** The default subtree stays portable. A chosen replacement uses a separately installed library. */
export function materializeSlots(
  doc: DesignDocument,
  base: ComponentVariant,
  slots?: Instance["slots"],
): ComponentVariant {
  if (base.nodes.length > maxPageNodes) throw Error("组件展开超出单页图层限制");
  if (!slots || !Object.keys(slots).length) return base;
  let nodes = base.nodes;
  // A parent replacement can introduce a slot that did not exist in the initial template.
  // Resolve the shallowest live slot each time, measuring depth on the current tree.
  const pending = new Map(Object.entries(slots));
  while (pending.size) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    let slot: DesignNode | undefined,
      depth = Infinity;
    for (const n of nodes) {
      if (!n.nestedSlot || !n.templateKey || !pending.has(n.templateKey))
        continue;
      let level = 0,
        p = n.parentId ? byId.get(n.parentId) : undefined;
      const visited = new Set<string>();
      while (p) {
        if (visited.has(p.id)) throw Error("嵌套实例父链存在循环");
        visited.add(p.id);
        if (p.nestedSlot) level++;
        p = p.parentId ? byId.get(p.parentId) : undefined;
      }
      if (level < depth) {
        slot = n;
        depth = level;
      }
    }
    if (!slot?.templateKey)
      throw Error("无法替换嵌套实例：" + pending.keys().next().value);
    const key = slot.templateKey,
      ref = pending.get(key)!;
    pending.delete(key);
    const variant = variantFor(doc, ref),
      root = variant?.nodes.find((n) => !n.parentId);
    if (!slot || !slot.parentId || !variant || !root || root.type !== slot.type)
      throw Error("无法替换嵌套实例：" + (slot?.name ?? key));
    const branch = subtreeIds({ ...doc, nodes }, [slot.id]);
    if (nodes.length - branch.size + variant.nodes.length > maxPageNodes)
      throw Error("组件展开超出单页图层限制");
    const previous = new Map<string, DesignNode>();
    for (const n of nodes) {
      if (!branch.has(n.id)) continue;
      const innerKey =
        n.nestedPath?.[depth] ?? (depth === 0 ? n.nestedKey : undefined);
      if (innerKey) previous.set(innerKey, n);
    }
    const ids = new Map<string, string>(),
      keys = new Map<string, string>();
    for (const n of variant.nodes) {
      const old = n.id === root.id ? slot : previous.get(n.templateKey!);
      const generated =
        "slot-" + stableHash(JSON.stringify([slot.templateKey, n.templateKey]));
      ids.set(n.id, old?.id ?? generated);
      keys.set(n.id, old?.templateKey ?? generated);
    }
    const replacement = variant.nodes.map((source) => {
      const n = structuredClone(source);
      n.id = ids.get(source.id)!;
      n.parentId = source.parentId ? ids.get(source.parentId)! : slot.parentId;
      n.templateKey = keys.get(source.id)!;
      const old =
        source.id === root.id ? slot : previous.get(source.templateKey!);
      const outerPath = old?.nestedPath?.slice(0, depth) ?? [];
      // New descendants also need unique keys in each enclosing component.
      while (outerPath.length < depth) outerPath.push(keys.get(source.id)!);
      const path = [
        ...outerPath,
        source.templateKey!,
        ...(source.nestedPath ?? (source.nestedKey ? [source.nestedKey] : [])),
      ];
      n.nestedKey = path[0];
      n.nestedPath = path.length > 1 ? path : undefined;
      if (n.maskSourceId) n.maskSourceId = ids.get(n.maskSourceId);
      remapInteraction(n, ids);
      if (source.id === root.id) {
        n.nestedSlot = true;
        n.nestedSource = { ...ref };
        n.name = slot.name;
        n.hidden = slot.hidden;
        n.locked = slot.locked;
        for (const key of [
          "x",
          "y",
          "width",
          "height",
          "widthMode",
          "heightMode",
          "constraintX",
          "constraintY",
          "gridCell",
          "columnSpan",
          "rowSpan",
          "rotation",
          "flipX",
          "flipY",
        ] as const)
          Object.assign(n.style, { [key]: slot.style[key] });
      }
      return n;
    });
    nodes = nodes.flatMap((n) =>
      n.id === slot.id ? replacement : branch.has(n.id) ? [] : [n],
    );
  }
  if (
    new Set(nodes.map((n) => n.id)).size !== nodes.length ||
    new Set(nodes.map((n) => n.templateKey)).size !== nodes.length
  )
    throw Error("嵌套实例的图层标识重复");
  return { ...base, nodes };
}

/** Nested snapshots can be used on their own when their source library is unavailable. */
export function layerComponent(doc: DesignDocument, node: DesignNode) {
  if (node.instance) return node.instance;
  if (
    node.nestedSlot &&
    node.nestedSource &&
    variantFor(doc, node.nestedSource)
  )
    return node.nestedSource;
}
