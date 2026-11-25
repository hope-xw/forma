import type { DesignDocument, DesignNode } from "./document";
import type { DesignSystem } from "./design-system-schema";
import { hexToRgb, rgbToHex } from "./color";
import { nodeInteractions } from "./prototype";

export type ColorProfile = "srgb" | "display-p3";
export const profileLabel = (profile: ColorProfile = "srgb") =>
  profile === "srgb" ? "sRGB" : "Display P3";

const hexColor = /^#[\da-f]{6}(?:[\da-f]{2})?$/i;
export function displayColor(hex: string, profile: ColorProfile = "srgb") {
  if (profile === "srgb") return hex;
  const alpha = hex.slice(7);
  return `color(display-p3 ${hexToRgb(hex)
    .map((v) => +(v / 255).toFixed(7))
    .join(" ")}${alpha ? " / " + parseInt(alpha, 16) / 255 : ""})`;
}

// Both spaces use a D65 white point and the sRGB transfer curve.
// Rows map linear-light RGB through XYZ into the other set of primaries.
const srgbToP3 = [
  [0.822461969, 0.177538031, 0],
  [0.033194199, 0.966805801, 0],
  [0.017082631, 0.072397441, 0.910519929],
];
const p3ToSrgb = [
  [1.224940176, -0.224940176, 0],
  [-0.042056955, 1.042056955, 0],
  [-0.019637555, -0.078636046, 1.098273601],
];
export function convertColor(
  hex: string,
  from: ColorProfile,
  to: ColorProfile,
) {
  if (from === to) return hex;
  const linear = hexToRgb(hex).map((byte) => {
    const value = byte / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const rgb = (from === "srgb" ? srgbToP3 : p3ToSrgb).map((row) => {
    const value = Math.max(
      0,
      Math.min(
        1,
        row.reduce((sum, k, i) => sum + k * linear[i], 0),
      ),
    );
    return (
      255 *
      (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055)
    );
  });
  return rgbToHex(rgb[0], rgb[1], rgb[2]) + hex.slice(7);
}

type MapColor = (hex: string) => string;
// Only traverse declared paint containers. IDs, text, paths, variable bindings
// and strings that happen to look like colors must retain their original values.
const colorKeys = new Set([
  "fill",
  "color",
  "stroke",
  "fillColor",
  "strokeColor",
  "accent",
  "track",
  "surface",
  "border",
]);
const containers = new Set([
  "style",
  "paints",
  "strokePaints",
  "gradient",
  "tint",
  "stops",
  "shadows",
  "layoutBreakpoints",
  "textRuns",
  "vector",
  "paths",
  "control",
  "palette",
]);
function mapColors<T>(source: T, map: MapColor): T {
  if (Array.isArray(source))
    return source.map((item) => mapColors(item, map)) as T;
  if (!source || typeof source !== "object") return source;
  const result: T = { ...source };
  for (const key of Object.keys(source) as (keyof T & string)[]) {
    const value = source[key];
    if (colorKeys.has(key) && typeof value === "string" && hexColor.test(value))
      result[key] = map(value) as T[typeof key];
    else if (containers.has(key)) result[key] = mapColors(value, map);
  }
  return result;
}
export function displayNode(node: DesignNode, profile: ColorProfile = "srgb") {
  return profile === "srgb"
    ? node
    : mapColors(node, (hex) => displayColor(hex, profile));
}
function mapSystem(system: DesignSystem | undefined, map: MapColor) {
  if (!system) return;
  for (const variable of Object.values(system.variables)) {
    if (variable.type !== "color") continue;
    for (const [mode, color] of Object.entries(variable.values))
      if (typeof color === "string") variable.values[mode] = map(color);
  }
  for (const style of Object.values(system.styles))
    style.properties = mapColors(style.properties, map);
}
export function changeProfile(
  doc: DesignDocument,
  target: ColorProfile,
  mode: "assign" | "convert" | "export",
) {
  const source = doc.colorProfile ?? "srgb";
  if (source === target) return doc;
  if (mode === "assign") return { ...doc, colorProfile: target };
  const next = structuredClone(doc);
  next.colorProfile = target;
  const map = (hex: string) => convertColor(hex, source, target);
  const layers = (nodes: DesignNode[]) =>
    nodes.map((node) => {
      const converted = mapColors(node, map);
      // During export, action values and comparisons follow converted variables.
      if (mode === "export") {
        for (const interaction of nodeInteractions(converted)) {
          for (const action of [
            ...(interaction.actions ?? []),
            ...(interaction.otherwise ?? []),
          ]) {
            if (
              action.kind === "set" &&
              doc.designSystem?.variables[action.variable]?.type === "color" &&
              typeof action.value === "string" &&
              hexColor.test(action.value)
            )
              action.value = map(action.value);
          }
          const condition = interaction.condition;
          if (
            condition &&
            doc.designSystem?.variables[condition.variable]?.type === "color" &&
            typeof condition.value === "string" &&
            hexColor.test(condition.value)
          )
            condition.value = map(condition.value);
        }
      }
      return converted;
    });
  next.nodes = layers(next.nodes);
  for (const page of next.pages ?? [])
    if (page.nodes) page.nodes = layers(page.nodes);
  for (const library of Object.values(next.libraries ?? {})) {
    for (const component of library.components)
      for (const variant of component.variants)
        variant.nodes = layers(variant.nodes);
    if (mode === "export") mapSystem(library.designSystem, map);
  }
  // Figma's file conversion preserves the numeric definitions of styles and variables.
  if (mode === "export") {
    mapSystem(next.designSystem, map);
    for (const token of Object.values(next.tokens))
      token.value = map(token.value);
  }
  return next;
}
