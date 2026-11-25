import type { CSSProperties } from "react";
import { roundedContour } from "../domain/stroke";
import type { RuntimeNode } from "../runtime/FormaRuntime";
import type { DesignNode } from "../domain/document";

// Figma's saturated smooth corners reduce to circular arcs. The runtime uses
// the same device-pixel coverage sampler as editable vector paths at 1x.
export function separateCapsuleFill(
  node: DesignNode,
  css: CSSProperties,
): RuntimeNode["capsule"] {
  const s = node.style;
  if (
    (node.type !== "rectangle" && node.type !== "frame") ||
    s.cornerSmoothingModel !== "figma" ||
    !s.cornerSmoothing ||
    s.radius < Math.min(s.width, s.height) / 2 ||
    s.width <= 0 ||
    s.height <= 0 ||
    Math.max(s.width, s.height) > 512 ||
    s.corners ||
    s.clipContent ||
    s.strokeWidth ||
    s.strokeSides ||
    s.shadows?.length ||
    s.paints?.length ||
    s.gradient ||
    node.image ||
    s.layoutBreakpoints?.length ||
    (s.fillOpacity ?? 1) === 0 ||
    s.fillBlendMode ||
    (s.blendMode && s.blendMode !== "pass-through") ||
    !css.background ||
    css.background === "transparent"
  )
    return;
  const background = css.background;
  css.background = "transparent";
  return {
    width: s.width,
    height: s.height,
    background,
    d: roundedContour(s.width, s.height, {
      ...s,
      cornerSmoothing: 0,
      radius: Math.min(s.width, s.height) / 2,
    }),
  };
}
