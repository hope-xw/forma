import type { CSSProperties } from "react";
import type { DesignNode } from "../domain/document";
import { strokeArtwork, strokeEdges, strokeInset } from "../domain/stroke";
import { gradientCss } from "./paints";
import { subtractBlend } from "./subtract-blend";

// Stroke width, alignment, individual sides and dashes belong to the outline.
// Every paint on the outline uses the same mask without adding layout borders.
export function strokePaintLayers(
  node: DesignNode,
  variable?: (id: string) => string,
): CSSProperties[] | undefined {
  const s = node.style;
  if (!s.strokePaints?.length || s.strokeVisible === false) return;
  const { body, outset } = strokeArtwork(
    s,
    s.width,
    s.height,
    "white",
    node.type === "ellipse",
  );
  if (!body) return;
  const [t, r, b, l] = outset,
    w = s.width + l + r,
    h = s.height + t + b;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    w +
    '" height="' +
    h +
    '" viewBox="' +
    [-l, -t, w, h].join(" ") +
    '" preserveAspectRatio="none">' +
    body +
    "</svg>";
  const maskImage = 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  return s.strokePaints
    .filter((p) => p.visible)
    .slice()
    .reverse()
    .map((p) => {
      const blend = p.blendMode === "pass-through" ? undefined : p.blendMode;
      const solid =
        variable && p.colorVariableId
          ? "var(" + variable(p.colorVariableId) + ")"
          : p.color;
      const opacity =
        variable && p.opacityVariableId
          ? "var(" + variable(p.opacityVariableId) + ")"
          : p.opacity;
      const filter =
        blend === "plus-darker" && !p.gradient
          ? subtractBlend(p.color)
          : undefined;
      return {
        position: "absolute",
        pointerEvents: "none",
        inset: outset
          .map((v, i) => -(v + strokeInset(s, strokeEdges[i])) + "px")
          .join(" "),
        maskImage,
        maskSize: "100% 100%",
        maskRepeat: "no-repeat",
        opacity,
        ...(filter
          ? { backdropFilter: filter.css, WebkitBackdropFilter: filter.css }
          : {
              background: p.gradient
                ? gradientCss(p.gradient, 1, variable)
                : solid,
              mixBlendMode: blend as CSSProperties["mixBlendMode"],
            }),
      };
    });
}
