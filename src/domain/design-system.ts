import { mergeStrokePaintOverrides } from "./stroke-paint-overrides";
import { paintVariables, mapPaintVariables } from "./paint-bindings";
import type { DesignDocument, DesignNode, NodeStyle } from "./document";
import { findLayer, isPublished } from "./scene-index";
import { replaceText } from "./rich-text";
import { styleSchema, fillUsesTextColor } from "./node";
import {
  designSystemSchema,
  type ReusableStyle,
  type DesignSystem,
  type VariableValue,
} from "./design-system-schema";
import {
  isNestedProperty,
  nestedStylePatch,
  propertyType,
  styleGroups,
  type VariableProperty,
} from "./design-properties";

/** A single Figma paint style can drive a layer fill and another layer's stroke. */
export function styleForSlot(
  source: ReusableStyle,
  slot: string,
): ReusableStyle {
  if (slot !== "stroke" || source.kind !== "paint") return source;
  return {
    ...source,
    kind: "stroke",
    properties: {
      stroke: source.properties.fill,
      strokeBlendMode: source.properties.fillBlendMode,
      strokePaints: source.properties.paints,
      strokeOpacity: source.properties.fillOpacity,
    },
    bindings: {
      ...(source.bindings.fill && { stroke: source.bindings.fill }),
      ...(source.bindings.fillOpacity && {
        strokeOpacity: source.bindings.fillOpacity,
      }),
    },
  };
}
export function bindingValueSchema(key: string) {
  if (isNestedProperty(key)) {
    if (key.startsWith("corners."))
      return styleSchema.shape.corners.unwrap().shape.tl;
    if (key.startsWith("insets."))
      return styleSchema.shape.insets.unwrap().shape.top;
    return styleSchema.shape.strokeSides.unwrap().shape.top;
  }
  return styleSchema.shape[key as keyof typeof styleSchema.shape];
}
export function effectiveModes(
  doc: DesignDocument,
  node?: DesignNode,
  byId?: ReadonlyMap<string, DesignNode>,
): Record<string, string> {
  const modes = { ...doc.designSystem?.activeModes };
  const chain: DesignNode[] = [];
  let current = node;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentId
      ? byId
        ? byId.get(current.parentId)
        : findLayer(doc, current.parentId)
      : undefined;
  }
  for (const n of chain) Object.assign(modes, n.variableModes);
  return modes;
}
export function resolveVariable(
  system: DesignSystem,
  id: string,
  modes: Record<string, string> = {},
  trail: string[] = [],
): string | number | boolean {
  if (trail.includes(id))
    throw new Error(`变量别名循环：${[...trail, id].join(" → ")}`);
  const token = system.variables[id];
  if (!token) throw new Error("变量引用不存在");
  const collection = system.collections[token.collectionId];
  if (!collection) throw new Error("变量集合不存在");
  const value = token.values[modes[collection.id] ?? collection.defaultModeId];
  if (value === undefined) throw new Error(`变量缺少模式值：${token.name}`);
  if (typeof value === "object")
    return resolveVariable(system, value.alias, modes, [...trail, id]);
  return value;
}
const resolvedNodeCache = new WeakMap<
  DesignDocument,
  WeakMap<DesignNode, DesignNode>
>();
export function resolveNode(
  doc: DesignDocument,
  node: DesignNode,
  byId?: ReadonlyMap<string, DesignNode>,
): DesignNode {
  if (
    !doc.designSystem ||
    (!node.variableBindings &&
      !node.styleBindings &&
      !paintVariables(node.style).length)
  )
    return node;
  const cacheable = isPublished(doc);
  if (cacheable) {
    const cached = resolvedNodeCache.get(doc)?.get(node);
    if (cached) return cached;
  }
  const system = doc.designSystem,
    modes = effectiveModes(doc, node, byId),
    style = { ...node.style };
  for (const [kind, id] of Object.entries(node.styleBindings ?? {})) {
    if (!id) continue;
    const definition = system.styles[id];
    if (!definition) throw new Error("样式引用不存在");
    const source = styleForSlot(definition, kind);
    for (const key of styleGroups[kind as keyof typeof styleGroups]) {
      if (node.styleOverrides?.includes(key)) continue;
      if (
        key === "strokePaints" &&
        source.properties.strokePaints &&
        node.styleOverrides
      ) {
        style.strokePaints = mergeStrokePaintOverrides(
          source.properties.strokePaints,
          node.style.strokePaints,
          node.styleOverrides,
        );
        continue;
      }
      const bound = source.bindings[key as VariableProperty];
      const value = bound
        ? resolveVariable(system, bound, modes)
        : source.properties[key as keyof NodeStyle];
      if (value !== undefined) Object.assign(style, { [key]: value });
      else if (
        [
          "gradient",
          "paints",
          "fillBlendMode",
          "strokePaints",
          "strokeBlendMode",
          "shadows",
          "blur",
          "backdropBlur",
          "fontFamily",
          "fontVariationSettings",
          "fontFeatureSettings",
          "fontWeight",
          "lineHeight",
          "letterSpacing",
          "textAlign",
        ].includes(key) ||
        (kind === "grid" && key !== "gap")
      )
        delete (style as Record<string, unknown>)[key];
    }
  }
  if (
    node.styleBindings?.paint &&
    fillUsesTextColor(node) &&
    !node.styleOverrides?.includes("fill")
  )
    style.color = style.fill;
  if (
    node.styleBindings?.paint &&
    fillUsesTextColor(node) &&
    !node.styleOverrides?.includes("fillOpacity")
  )
    style.colorOpacity = style.fillOpacity;
  if (paintVariables(style).length)
    Object.assign(
      style,
      mapPaintVariables(style, (id) => ({
        value: resolveVariable(system, id, modes),
      })),
    );
  const result = { ...node, style };
  if (node.variableBindings?.fill || node.styleBindings?.paint)
    delete result.fillToken;
  for (const [key, id] of Object.entries(node.variableBindings ?? {})) {
    const value = resolveVariable(system, id, modes);
    if (key === "text")
      Object.assign(result, replaceText(result, String(value)));
    else if (key === "visible") result.hidden = !value;
    else if (isNestedProperty(key))
      Object.assign(style, nestedStylePatch(style, key, Number(value)));
    else Object.assign(style, { [key]: value });
  }
  if (cacheable) {
    let map = resolvedNodeCache.get(doc);
    if (!map) {
      map = new WeakMap();
      resolvedNodeCache.set(doc, map);
    }
    map.set(node, result);
  }
  return result;
}
export function resolvedDocument(doc: DesignDocument): DesignDocument {
  if (!doc.designSystem) return doc;
  const byId =
    doc.nodes.length > 100 && !isPublished(doc)
      ? new Map(doc.nodes.map((n) => [n.id, n]))
      : undefined;
  return { ...doc, nodes: doc.nodes.map((n) => resolveNode(doc, n, byId)) };
}

export function validateDesignSystem(
  doc: DesignDocument,
  byId?: ReadonlyMap<string, DesignNode>,
) {
  const system = doc.designSystem;
  if (!system) {
    if (
      doc.nodes.some(
        (n) =>
          paintVariables(n.style).length ||
          Object.keys(n.variableBindings ?? {}).length ||
          Object.keys(n.variableModes ?? {}).length ||
          Object.values(n.styleBindings ?? {}).some(Boolean),
      )
    )
      throw new Error("设计系统引用不存在");
    return;
  }
  const checkModes = (modes: Record<string, string>) => {
    for (const [collectionId, mode] of Object.entries(modes))
      if (!system.collections[collectionId]?.modes.some((m) => m.id === mode))
        throw new Error("集合模式不存在");
  };
  checkModes(system.activeModes);
  for (const [id, c] of Object.entries(system.collections)) {
    if (
      id !== c.id ||
      new Set(c.modes.map((m) => m.id)).size !== c.modes.length ||
      new Set(c.modes.map((m) => m.name)).size !== c.modes.length ||
      !c.modes.some((m) => m.id === c.defaultModeId)
    )
      throw new Error("集合模式定义无效");
  }
  const names = new Set<string>();
  for (const [id, v] of Object.entries(system.variables)) {
    const c = system.collections[v.collectionId];
    if (id !== v.id || !c) throw new Error("变量集合引用无效");
    const name = `${c.id}/${v.name}`;
    if (names.has(name)) throw new Error("同一集合内变量名称重复");
    names.add(name);
    if (v.scopes.some((k) => propertyType(k) !== v.type))
      throw new Error("变量作用域与类型不匹配");
    if (
      Object.keys(v.values).some((mode) => !c.modes.some((m) => m.id === mode))
    )
      throw new Error("变量包含未知模式");
    for (const m of c.modes) {
      const value = v.values[m.id];
      if (value === undefined) throw new Error(`变量缺少模式值：${v.name}`);
      if (typeof value === "object") {
        if (system.variables[value.alias]?.type !== v.type)
          throw new Error("变量别名类型不匹配");
      } else if (
        v.type === "color"
          ? typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)
          : typeof value !== v.type
      )
        throw new Error("变量值与类型不匹配");
    }
  }
  // Walk every alias edge, including edges inactive in the current mode. This avoids latent theme cycles.
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("变量别名循环");
    if (done.has(id)) return;
    visiting.add(id);
    for (const v of Object.values(system.variables[id].values))
      if (typeof v === "object") visit(v.alias);
    visiting.delete(id);
    done.add(id);
  };
  Object.keys(system.variables).forEach(visit);
  const checkedBindings = new Map<string, Set<string>>();
  const checkBinding = (key: string, id: string) => {
    let checked = checkedBindings.get(key);
    if (checked?.has(id)) return;
    if (!checked) checkedBindings.set(key, (checked = new Set()));
    checked.add(id);
    const v = system.variables[id];
    if (
      !v ||
      v.type !== propertyType(key) ||
      (v.scopes.length && !v.scopes.includes(key as VariableProperty))
    )
      throw new Error("变量绑定类型或作用域不匹配");
    const field = bindingValueSchema(key);
    if (field) {
      const visited = new Set<string>();
      const validateValues = (tokenId: string) => {
        if (visited.has(tokenId)) return;
        visited.add(tokenId);
        for (const value of Object.values(system.variables[tokenId].values))
          if (typeof value === "object") validateValues(value.alias);
          else field.parse(value);
      };
      validateValues(id);
    }
  };
  const styleNames = new Set<string>();
  for (const [id, s] of Object.entries(system.styles)) {
    if (id !== s.id) throw new Error("样式 ID 不一致");
    const key = `${s.kind}/${s.name}`;
    if (styleNames.has(key)) throw new Error("同类样式名称重复");
    styleNames.add(key);
    const allowed: readonly string[] = styleGroups[s.kind];
    if (
      [...Object.keys(s.properties), ...Object.keys(s.bindings)].some(
        (k) => !allowed.includes(k),
      )
    )
      throw new Error("样式包含不支持的属性");
    for (const { property, id } of paintVariables(s.properties))
      checkBinding(property, id);
    for (const [key, id] of Object.entries(s.bindings)) checkBinding(key, id);
  }
  for (const node of doc.nodes) {
    checkModes(node.variableModes ?? {});
    for (const { property, id } of paintVariables(node.style))
      checkBinding(property, id);
    for (const [key, id] of Object.entries(node.variableBindings ?? {}))
      checkBinding(key, id);
    for (const [kind, id] of Object.entries(node.styleBindings ?? {}))
      if (
        id &&
        system.styles[id]?.kind !== kind &&
        !(kind === "stroke" && system.styles[id]?.kind === "paint")
      )
        throw new Error("样式引用类型不匹配");
    if (node.styleBindings?.grid && node.type !== "frame")
      throw Error("网格样式只能用于画板或布局容器");
    styleSchema.parse(resolveNode(doc, node, byId).style);
  }
  // Check all mode values against the destination property, not only the currently visible mode.
  const boundPropsByVar = new Map<string, Set<string>>();
  for (const n of doc.nodes) {
    if (!n.variableBindings) continue;
    for (const [key, id] of Object.entries(n.variableBindings)) {
      if (!id) continue;
      let props = boundPropsByVar.get(id);
      if (!props) {
        props = new Set();
        boundPropsByVar.set(id, props);
      }
      props.add(key);
    }
  }
  for (const v of Object.values(system.variables)) {
    const keys = new Set<string>(v.scopes);
    const bound = boundPropsByVar.get(v.id);
    if (bound) for (const k of bound) keys.add(k);
    for (const value of Object.values(v.values)) {
      if (typeof value === "object") continue;
      for (const key of keys)
        if (key !== "text" && key !== "visible") {
          const field = bindingValueSchema(key);
          field?.parse(value);
        }
    }
  }
}
export function parseDesignSystem(input: unknown): DesignSystem {
  const system = designSystemSchema.parse(input);
  validateDesignSystem({
    schemaVersion: 1,
    id: "validate",
    name: "validate",
    revision: 0,
    nodes: [],
    tokens: {},
    designSystem: system,
  });
  return system;
}

/** Cross-file copies retain independent definitions and effective modes; ID collisions never overwrite local data. */
export function mergeDesignSystem(
  target: DesignSystem | undefined,
  source: DesignSystem | undefined,
) {
  const system = structuredClone(
    target ?? { collections: {}, variables: {}, styles: {}, activeModes: {} },
  ) as DesignSystem;
  const maps = {
    collections: new Map<string, string>(),
    variables: new Map<string, string>(),
    styles: new Map<string, string>(),
  };
  if (!source) return { system, maps };
  const identical =
    !!target &&
    (["collections", "variables", "styles"] as const).every((kind) =>
      Object.entries(source[kind]).every(
        ([id, value]) =>
          JSON.stringify(target[kind][id]) === JSON.stringify(value),
      ),
    ) &&
    Object.values(source.collections).every(
      (c) =>
        (target.activeModes[c.id] ?? c.defaultModeId) ===
        (source.activeModes[c.id] ?? c.defaultModeId),
    );
  const rename = !!target && !identical;
  for (const kind of ["collections", "variables", "styles"] as const)
    for (const id of Object.keys(source[kind]))
      maps[kind].set(id, rename ? crypto.randomUUID() : id);
  if (identical) return { system, maps };
  for (const c of Object.values(source.collections)) {
    const id = maps.collections.get(c.id)!;
    system.collections[id] = { ...structuredClone(c), id };
    system.activeModes[id] = source.activeModes[c.id] ?? c.defaultModeId;
  }
  for (const v of Object.values(source.variables)) {
    const id = maps.variables.get(v.id)!;
    system.variables[id] = {
      ...structuredClone(v),
      id,
      collectionId: maps.collections.get(v.collectionId)!,
      values: Object.fromEntries(
        Object.entries(v.values).map(([m, value]) => [
          m,
          typeof value === "object"
            ? { alias: maps.variables.get(value.alias)! }
            : value,
        ]),
      ),
    };
  }
  for (const s of Object.values(source.styles)) {
    const id = maps.styles.get(s.id)!;
    system.styles[id] = {
      ...structuredClone(s),
      properties: mapPaintVariables(structuredClone(s.properties), (id) => ({
        id: maps.variables.get(id) ?? id,
      })),
      name:
        rename &&
        Object.values(system.styles).some(
          (existing) => existing.kind === s.kind && existing.name === s.name,
        )
          ? `${s.name} (import ${id.slice(0, 8)})`
          : s.name,
      id,
      bindings: Object.fromEntries(
        Object.entries(s.bindings).map(([key, id]) => [
          key,
          maps.variables.get(id)!,
        ]),
      ),
    };
  }
  return { system, maps };
}
export function remapDesignBindings(
  node: DesignNode,
  maps: ReturnType<typeof mergeDesignSystem>["maps"],
) {
  if (paintVariables(node.style).length)
    node.style = mapPaintVariables(node.style, (id) => ({
      id: maps.variables.get(id) ?? id,
    }));
  if (node.variableBindings)
    node.variableBindings = Object.fromEntries(
      Object.entries(node.variableBindings).map(([k, id]) => [
        k,
        maps.variables.get(id) ?? id,
      ]),
    );
  if (node.styleBindings)
    node.styleBindings = Object.fromEntries(
      Object.entries(node.styleBindings).map(([k, id]) => [
        k,
        id ? (maps.styles.get(id) ?? id) : undefined,
      ]),
    );
  if (node.variableModes)
    node.variableModes = Object.fromEntries(
      Object.entries(node.variableModes).map(([id, m]) => [
        maps.collections.get(id) ?? id,
        m,
      ]),
    );
}
export function formatVariableValue(value: VariableValue) {
  return typeof value === "object" ? `{${value.alias}}` : String(value);
}
