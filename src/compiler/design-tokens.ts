import { fillUsesTextColor } from "../domain/node";
import type { RuntimeNode } from "../runtime/FormaRuntime";
import { flowItemCss } from "./flow-gap";
import { findLayer } from "../domain/scene-index";
import { tintCss } from "./group-tint";
import { displayColor, type ColorProfile } from "../domain/color-profile";
import {
  nestedCssProperties,
  type NestedProperty,
} from "../domain/design-properties";
import { styleForSlot } from "../domain/design-system";
import { strokeCss } from "../domain/stroke";
import { paintVariables } from "../domain/paint-bindings";
import { stackPaints, gradientCss, symbolicPaintColor } from "./paints";
import type { DesignDocument } from "../domain/document";
import { effectiveModes, resolveVariable } from "../domain/design-system";
import type { DesignSystem } from "../domain/design-system-schema";
/** User-facing code names are metadata. Only validated custom-property identifiers enter CSS. */
export function cssVariableName(system: DesignSystem, id: string): string {
  const custom = system.variables[id].codeSyntax;
  if (
    /^--[a-zA-Z_][a-zA-Z0-9_-]*$/.test(custom) &&
    Object.values(system.variables).filter((v) => v.codeSyntax === custom)
      .length === 1
  )
    return custom;
  return `--forma-${[...id].map((c) => c.codePointAt(0)!.toString(16)).join("-")}`;
}
export function scopedCssVariables(
  doc: DesignDocument,
  node: import("../domain/document").DesignNode,
): Record<string, string> {
  if (!doc.designSystem || !Object.keys(node.variableModes ?? {}).length)
    return {};
  const system = doc.designSystem,
    modes = effectiveModes(doc, node);
  return Object.fromEntries(
    Object.values(system.variables).map((v) => [
      cssVariableName(system, v.id),
      cssTokenValue(system, v.id, modes, doc.colorProfile),
    ]),
  );
}
export function cssTokenValue(
  system: DesignSystem,
  id: string,
  modes: Record<string, string>,
  profile?: ColorProfile,
): string {
  const token = system.variables[id],
    collection = system.collections[token.collectionId],
    value = token.values[modes[collection.id] ?? collection.defaultModeId];
  return typeof value === "object"
    ? `var(${cssVariableName(system, value.alias)})`
    : token.type === "string"
      ? String(value)
          .split(",")
          .map((part) =>
            [
              "serif",
              "sans-serif",
              "system-ui",
              "monospace",
              "ui-sans-serif",
              "ui-serif",
              "ui-monospace",
            ].includes(part.trim())
              ? part.trim()
              : JSON.stringify(part.trim()),
          )
          .join(", ")
      : token.type === "color"
        ? displayColor(String(value), profile)
        : String(value);
}
export function exportTokenFiles(doc: DesignDocument): Record<string, string> {
  const system = doc.designSystem;
  if (!system) return {};
  const cssValue = (id: string, modes: Record<string, string>) =>
    cssTokenValue(system, id, modes, doc.colorProfile);
  const declarations = (modes: Record<string, string>, collectionId?: string) =>
    Object.values(system.variables)
      .filter((v) => !collectionId || v.collectionId === collectionId)
      .map(
        (v) => `  ${cssVariableName(system, v.id)}: ${cssValue(v.id, modes)};`,
      )
      .join("\n");
  const css = [
    "/* Numbers are unitless; use calc(var(--token) * 1px) for dimensions. */",
    `:root {\n${declarations(system.activeModes)}\n}`,
    ...Object.values(system.collections).flatMap((c) =>
      c.modes.map(
        (m) =>
          `[data-collection-${[...c.id].map((x) => x.codePointAt(0)!.toString(16)).join("-")}=${JSON.stringify(m.id)}] {\n${declarations({ ...system.activeModes, [c.id]: m.id }, c.id)}\n}`,
      ),
    ),
  ].join("\n\n");
  return {
    "design-system.json": JSON.stringify(
      { format: "forma/design-system", version: 1, system },
      null,
      2,
    ),
    "src/tokens.css": css,
    "src/tokens.ts": `// Resolved default-mode values plus stable CSS names. Full collections, aliases and styles are in design-system.json.\nexport const tokens = ${JSON.stringify(Object.fromEntries(Object.values(system.variables).map((v) => [v.id, { name: v.name, type: v.type, value: resolveVariable(system, v.id, system.activeModes), cssName: cssVariableName(system, v.id) }])), null, 2)} as const;\n`,
  };
}

/** Retain symbolic CSS bindings in exported components. Editor geometry continues to use resolved numbers. */
export function symbolicNodeCss(
  doc: DesignDocument,
  node: import("../domain/document").DesignNode,
  base: Record<string, string | number>,
  setBlendedPaints?: (
    paints: NonNullable<RuntimeNode["blendedPaints"]>,
  ) => void,
): Record<string, string | number> {
  const system = doc.designSystem;
  if (!system) return base;
  const bindings: Record<string, string> = {};
  for (const [slot, id] of Object.entries(node.styleBindings ?? {}))
    if (id) {
      const style = styleForSlot(system.styles[id], slot);
      for (const [key, value] of Object.entries(style.bindings))
        if (!(node.styleOverrides ?? []).includes(key)) bindings[key] = value;
    }
  if (fillUsesTextColor(node) && node.styleBindings?.paint) {
    if (bindings.fill) {
      bindings.color = bindings.fill;
      delete bindings.fill;
    }
    if (bindings.fillOpacity) {
      bindings.colorOpacity = bindings.fillOpacity;
      delete bindings.fillOpacity;
    }
  }
  Object.assign(bindings, node.variableBindings);
  const variable = (key: string) =>
    bindings[key]
      ? `var(${cssVariableName(system, bindings[key])})`
      : undefined;
  const px = (key: string) =>
    variable(key) ? `calc(${variable(key)} * 1px)` : undefined;
  const css = { ...base };
  for (const key of [
    "width",
    "height",
    "minWidth",
    "maxWidth",
    "minHeight",
    "maxHeight",
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "gap",
  ])
    if (
      px(key) &&
      !((key === "width" || key === "height") && base[key] !== node.style[key])
    )
      css[key] = px(key)!;
  if (
    px("gap") &&
    (node.style.layout === "row" || node.style.layout === "column")
  )
    css.gap = `max(0px, ${px("gap")})`;
  const parent = findLayer(doc, node.parentId);
  if (
    parent &&
    (parent.style.layout === "row" || parent.style.layout === "column") &&
    !parent.style.wrap
  ) {
    const slot = parent.styleBindings?.grid;
    const gap =
      parent.variableBindings?.gap ??
      (slot && !parent.styleOverrides?.includes("gap")
        ? system.styles[slot]?.bindings.gap
        : undefined);
    if (gap)
      Object.assign(
        css,
        flowItemCss(
          doc,
          node,
          parent,
          `min(0px, calc(var(${cssVariableName(system, gap)}) * 1px))`,
        ),
      );
  }
  if (px("padding") && node.type === "frame" && !node.style.insets)
    css.padding = px("padding")!;
  if (px("radius") && !node.style.corners && node.type !== "ellipse") {
    if (node.style.cornerSmoothing) {
      delete css.borderShape;
      delete css.clipPath;
    }
    css.borderRadius = px("radius")!;
  }
  for (const key of ["opacity", "fontWeight"])
    if (variable(key)) css[key] = variable(key)!;
  if (variable("fontFamily")) css.fontFamily = variable("fontFamily")!;
  const mixed = (color: string, opacityKey: string, fallback: number) =>
    `color-mix(in srgb, ${color} ${variable(opacityKey) ? `calc(${variable(opacityKey)} * 100%)` : `${fallback * 100}%`}, transparent)`;
  if (variable("color") || variable("colorOpacity"))
    css.color = mixed(
      variable("color") ?? node.style.color,
      "colorOpacity",
      node.style.colorOpacity ?? 1,
    );
  const surface = node.vector?.fillFromStyle
    ? "--forma-vector-fill"
    : "background";
  if (
    (node.vector?.fillFromStyle ||
      !["text", "vector", "group", "slice"].includes(node.type)) &&
    base[surface] !== "transparent" &&
    (paintVariables({
      paints: node.style.paints,
      gradient: node.style.gradient,
    }).length ||
      (!node.style.gradient && (variable("fill") || variable("fillOpacity"))))
  ) {
    const baseColor = mixed(
      variable("fill") ??
        (node.fillToken ? `var(--token-${node.fillToken})` : node.style.fill),
      "fillOpacity",
      node.style.fillOpacity ?? 1,
    );
    const paints = node.style.paints?.filter((p) => p.visible) ?? [];
    const hasBlend =
      paints.length &&
      [node.style.fillBlendMode, ...paints.map((p) => p.blendMode)].some(
        (mode) => mode && mode !== "normal" && mode !== "pass-through",
      );
    if (
      hasBlend &&
      !node.image &&
      !node.style.gradient &&
      !paints.some((p) => p.gradient)
    ) {
      if (setBlendedPaints) {
        setBlendedPaints([
          { color: baseColor },
          ...paints
            .slice()
            .reverse()
            .map((p) => ({
              color: symbolicPaintColor(p, (id) => cssVariableName(system, id)),
              mode:
                p.blendMode === "pass-through"
                  ? ("normal" as const)
                  : p.blendMode,
            })),
        ]);
        css[surface] = "transparent";
      }
    } else {
      css[surface] = stackPaints(
        node.style.paints,
        node.style.gradient
          ? gradientCss(
              node.style.gradient,
              node.style.fillOpacity ?? 1,
              (id) => cssVariableName(system, id),
            )
          : baseColor,
        (id) => cssVariableName(system, id),
      );
    }
  }
  if (
    variable("stroke") ||
    variable("strokeWidth") ||
    variable("strokeOpacity")
  )
    Object.assign(
      css,
      strokeCss(
        node.style,
        node.style.strokePaints?.length
          ? "transparent"
          : mixed(
              variable("stroke") ?? node.style.stroke ?? node.style.color,
              "strokeOpacity",
              node.style.strokeOpacity ?? 1,
            ),
        px("strokeWidth") ?? `${node.style.strokeWidth ?? 0}px`,
      ),
    );
  for (const [key, property] of Object.entries(nestedCssProperties)) {
    const value = px(key as NestedProperty);
    if (!value) continue;
    if (key.startsWith("corners.") && node.type !== "ellipse")
      css[property] = value;
    if (
      key.startsWith("insets.") &&
      node.type === "frame" &&
      node.style.layout !== "free"
    )
      css[property] = value;
    if (
      key.startsWith("strokeSides.") &&
      node.style.strokeVisible !== false &&
      node.style.strokeInLayout !== false
    ) {
      if (!node.style.strokeAlign || node.style.strokeAlign === "inside")
        css[property] = value;
      else if (node.style.strokeAlign === "center")
        css[property] = "calc(" + value + " / 2)";
    }
  }
  if (px("blur"))
    css.filter = [tintCss(node.style), `blur(${px("blur")})`]
      .filter(Boolean)
      .join(" ");
  if (px("backdropBlur")) {
    css.backdropFilter = `blur(${px("backdropBlur")})`;
    css.WebkitBackdropFilter = css.backdropFilter;
  }
  return css;
}
