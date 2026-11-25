import type { DesignDocument, DesignNode } from "./document";
import type { Operation } from "./commands";
import { resolveNode, styleForSlot } from "./design-system";
import {
  isNestedProperty,
  styleGroups,
  type StyleKind,
  type VariableProperty,
} from "./design-properties";
import { emptyDesignSystem, type ReusableStyle } from "./design-system-schema";
export function planBindVariable(
  node: DesignNode,
  key: VariableProperty,
  id?: string,
): Operation {
  const bindings = { ...node.variableBindings };
  if (id) bindings[key] = id;
  else delete bindings[key];
  return {
    type: "update",
    id: node.id,
    patch: {
      variableBindings: bindings,
      ...(key === "fill" ? { fillToken: undefined } : {}),
    },
  };
}
export function detachVariable(
  doc: DesignDocument,
  node: DesignNode,
  key: VariableProperty,
): Operation {
  const resolved = resolveNode(doc, node),
    op = planBindVariable(node, key);
  if (op.type !== "update") throw new Error("Invalid update");
  if (key === "text") op.patch.text = resolved.text;
  else if (key === "visible") op.patch.hidden = resolved.hidden;
  else if (isNestedProperty(key)) {
    const group = key.split(".")[0] as "insets" | "corners" | "strokeSides";
    op.style = { [group]: resolved.style[group] };
  } else
    op.style = { [key]: resolved.style[key as keyof typeof resolved.style] };
  return op;
}
// Older typography styles do not own the layer's independently bound text color.
function ownedStyleKeys(kind: StyleKind, style?: ReusableStyle) {
  if (kind === "stroke" && style?.kind === "paint")
    return [
      "stroke",
      "strokeOpacity",
      "strokeBlendMode",
      "strokePaints",
    ] as const;
  return styleGroups[kind].filter(
    (key) =>
      kind !== "text" ||
      (key !== "color" && key !== "colorOpacity") ||
      style?.properties[key] !== undefined ||
      Boolean(style?.bindings[key]),
  );
}

export function planApplyReusableStyle(
  node: DesignNode,
  style: ReusableStyle,
  slot: StyleKind = style.kind,
): Operation {
  if (slot !== style.kind && !(slot === "stroke" && style.kind === "paint"))
    throw Error("样式类型与目标属性不匹配");
  const variableBindings = { ...node.variableBindings };
  const keys = ownedStyleKeys(slot, style);
  for (const key of keys) delete variableBindings[key as VariableProperty];
  if (slot === "paint" && ["text", "vector"].includes(node.type)) {
    delete variableBindings.color;
    delete variableBindings.colorOpacity;
  }
  return {
    type: "update",
    id: node.id,
    patch: {
      styleBindings: { ...node.styleBindings, [slot]: style.id },
      styleOverrides: node.styleOverrides?.filter(
        (k) =>
          !(keys as readonly string[]).some(
            (key) => k === key || k.startsWith(key + "."),
          ),
      ),
      variableBindings,
      ...(slot === "paint" ? { fillToken: undefined } : {}),
    },
  };
}
export function detachReusableStyle(
  doc: DesignDocument,
  node: DesignNode,
  kind: StyleKind,
): Operation {
  const resolved = resolveNode(doc, node),
    bindings = { ...node.styleBindings };
  const keys = ownedStyleKeys(
    kind,
    doc.designSystem?.styles[bindings[kind] ?? ""],
  );
  delete bindings[kind];
  return {
    type: "update",
    id: node.id,
    patch: {
      styleBindings: bindings,
      styleOverrides: node.styleOverrides?.filter(
        (k) =>
          !(keys as readonly string[]).some(
            (key) => k === key || k.startsWith(key + "."),
          ),
      ),
    },
    style: {
      ...Object.fromEntries(
        keys.map((k) => [k, resolved.style[k as keyof typeof resolved.style]]),
      ),
      ...(kind === "paint" && ["text", "vector"].includes(node.type)
        ? {
            color: resolved.style.color,
            colorOpacity: resolved.style.colorOpacity,
          }
        : {}),
    },
  };
}
export function captureStyle(
  doc: DesignDocument,
  node: DesignNode,
  kind: StyleKind,
  name: string,
): ReusableStyle {
  const resolved = structuredClone(resolveNode(doc, node)),
    id = crypto.randomUUID();
  const sourceId = node.styleBindings?.[kind];
  const inheritedBindings = Object.entries(
    sourceId && doc.designSystem?.styles[sourceId]
      ? styleForSlot(doc.designSystem.styles[sourceId], kind).bindings
      : {},
  ).filter(([key]) => !node.styleOverrides?.includes(key));
  if (kind === "paint" && ["text", "vector"].includes(node.type)) {
    resolved.style.fill = resolved.style.color;
    resolved.style.fillOpacity = resolved.style.colorOpacity;
  }
  return {
    id,
    name,
    kind,
    description: "",
    properties: Object.fromEntries(
      styleGroups[kind].flatMap((key) =>
        resolved.style[key as keyof typeof resolved.style] === undefined
          ? []
          : [[key, resolved.style[key as keyof typeof resolved.style]]],
      ),
    ),
    bindings: Object.fromEntries([
      ...inheritedBindings,
      ...Object.entries(node.variableBindings ?? {})
        .map(([key, value]) => {
          if (kind === "paint" && ["text", "vector"].includes(node.type)) {
            if (key === "color") return ["fill", value];
            if (key === "colorOpacity") return ["fillOpacity", value];
          }
          return [key, value];
        })
        .filter(([key]) =>
          (styleGroups[kind] as readonly string[]).includes(key),
        ),
    ]),
  };
}
export function migrateLegacyTokens(doc: DesignDocument): Operation[] {
  const system = structuredClone(doc.designSystem ?? emptyDesignSystem()),
    collectionId = "legacy-colors";
  if (!system.collections[collectionId])
    system.collections[collectionId] = {
      id: collectionId,
      name: "Imported colors",
      defaultModeId: "base",
      modes: [{ id: "base", name: "Base" }],
    };
  const ids = new Map<string, string>();
  for (const [old, token] of Object.entries(doc.tokens)) {
    const previous = Object.values(system.variables).find(
      (variable) =>
        variable.collectionId === collectionId &&
        variable.type === "color" &&
        variable.name === token.name,
    );
    if (previous) {
      ids.set(old, previous.id);
      continue;
    }
    const id = crypto.randomUUID();
    ids.set(old, id);
    system.variables[id] = {
      id,
      collectionId,
      name: token.name,
      type: "color",
      values: Object.fromEntries(
        system.collections[collectionId].modes.map((mode) => [
          mode.id,
          token.value,
        ]),
      ),
      description: "",
      codeSyntax: "",
      scopes: [],
    };
  }
  return [
    { type: "setDesignSystem", system },
    ...doc.nodes
      .filter((n) => n.fillToken)
      .map((n) => bindVariable(n, "fill", ids.get(n.fillToken!))),
  ];
}

export function bindVariable(
  node: DesignNode,
  key: VariableProperty,
  id?: string,
): Operation {
  return { type: "bindVariable", id: node.id, property: key, variableId: id };
}
export function applyReusableStyle(
  node: DesignNode,
  style: ReusableStyle,
  slot?: StyleKind,
): Operation {
  return {
    type: "applyStyle",
    id: node.id,
    styleId: style.id,
    ...(slot && slot !== style.kind ? { slot } : {}),
  };
}
