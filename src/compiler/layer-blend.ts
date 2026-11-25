import type { CSSProperties } from "react";
import type { DesignDocument, DesignNode } from "../domain/document";
import { childrenOf } from "../domain/scene-index";
import { strokeArtwork } from "../domain/stroke";
import { subtractBlend } from "./subtract-blend";
import { hasClearBackdrop } from "./transparent-backdrop";

function hasVisibleStroke(n: DesignNode) {
  const s = n.style;
  return (
    s.strokeVisible !== false &&
    (s.strokePaints?.length
      ? s.strokePaints.some((p) => p.visible && p.opacity > 0)
      : (s.strokeOpacity ?? 1) > 0) &&
    !!(s.strokeWidth || Object.values(s.strokeSides ?? {}).some((v) => v > 0))
  );
}

// A single solid paint on an empty shape can apply Linear Burn directly to
// the scene. Layer-level blending on a container also includes its children.
function simpleSubtractiveLayer(node: DesignNode, doc: DesignDocument) {
  const s = node.style;
  return (
    s.blendMode === "plus-darker" &&
    ["frame", "rectangle", "ellipse"].includes(node.type) &&
    !node.image &&
    !node.maskSourceId &&
    !node.booleanOperation &&
    !s.tint &&
    !s.gradient &&
    !s.paints?.some((p) => p.visible) &&
    !s.shadows?.some((v) => v.visible !== false) &&
    !s.backdropBlur &&
    s.backdropBrightness === undefined &&
    s.backdropSaturation === undefined &&
    !s.fillBlendMode &&
    !childrenOf(doc, node.id).length
  );
}
export function subtractiveFill(node: DesignNode, doc: DesignDocument) {
  if (
    !simpleSubtractiveLayer(node, doc) ||
    (node.style.fillOpacity ?? 1) <= 0 ||
    hasVisibleStroke(node)
  )
    return;
  return subtractBlend(node.style.fill);
}

export function strokePaintBlend(node: DesignNode, doc: DesignDocument) {
  const s = node.style;
  if (
    s.strokePaints?.length ||
    !hasVisibleStroke(node) ||
    !["frame", "rectangle", "ellipse"].includes(node.type)
  )
    return;
  if (
    s.strokeBlendMode &&
    s.strokeBlendMode !== "normal" &&
    s.strokeBlendMode !== "pass-through"
  )
    return s.strokeBlendMode;
  if (s.fillOpacity === 0 && simpleSubtractiveLayer(node, doc))
    return "plus-darker";
}

// Preserve layout borders on the owning node. Draw the paint on the same
// fractional vector contour as the SVG exporter, including outside edges.
export function blendedStroke(
  node: DesignNode,
  doc: DesignDocument,
): CSSProperties | undefined {
  const mode = strokePaintBlend(node, doc);
  if (!mode) return;
  const s = node.style,
    color = s.stroke ?? s.color;
  const filter = mode === "plus-darker" ? subtractBlend(color) : undefined;
  if (mode === "plus-darker" && !filter) return;
  const { shape, mask } = strokeMask(node);
  return {
    ...shape,
    maskImage: mask(),
    opacity: s.strokeOpacity ?? 1,
    ...(filter
      ? { backdropFilter: filter.css, WebkitBackdropFilter: filter.css }
      : {
          background: color,
          mixBlendMode: mode as CSSProperties["mixBlendMode"],
        }),
  };
}

function strokeMask(node: DesignNode) {
  const s = node.style;
  const { body, outset } = strokeArtwork(
    s,
    s.width,
    s.height,
    "white",
    node.type === "ellipse",
  );
  const [top, right, bottom, left] = outset;
  const w = s.width + left + right,
    h = s.height + top + bottom;
  const bounds = `x="${-left}" y="${-top}" width="${w}" height="${h}"`;
  const mask = (coverage?: string) => {
    const ink = coverage
      ? `<defs><filter id="c" filterUnits="userSpaceOnUse" ${bounds}><feComponentTransfer><feFuncA type="table" tableValues="${coverage}"/></feComponentTransfer></filter></defs><g filter="url(#c)">${body}</g>`
      : body;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${-left} ${-top} ${w} ${h}" preserveAspectRatio="none">${ink}</svg>`;
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  };
  const shape: CSSProperties = {
    position: "absolute",
    pointerEvents: "none",
    inset: outset.map((n) => -n + "px").join(" "),
    maskSize: "100% 100%",
    maskRepeat: "no-repeat",
  };
  return { shape, mask };
}

// WebKit and Gecko ignore SVG URL filters on the backdrop. Reproduce linear
// burn using foreground pigments on the painted stroke. A partially covered
// edge needs the coverage transfer before color burn for each source channel.
export function blendedStrokePaint(
  node: DesignNode,
  doc: DesignDocument,
): CSSProperties[] | undefined {
  const s = node.style;
  const mode = strokePaintBlend(node, doc);
  if (!mode) return;
  const color = s.stroke ?? s.color;
  const raw = /^#([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(color);
  if (mode !== "plus-darker" || !raw) {
    const ink = blendedStroke(node, doc);
    return ink && [ink];
  }
  const { shape, mask } = strokeMask(node);
  const channels = raw.slice(1).map((hex) => parseInt(hex, 16));
  const alpha = s.strokeOpacity ?? 1;
  const layers: CSSProperties[] = [];
  for (const c of new Set(channels)) {
    if (c === 0 || c === 255) continue;
    const normalized = c / 255;
    const samples = Array.from({ length: 33 }, (_, i) => {
      const t = (alpha * i) / 32;
      return Number(((t * normalized) / (1 - t * (1 - normalized))).toFixed(6));
    });
    layers.push({
      ...shape,
      mixBlendMode: "color-burn",
      backgroundColor: `rgb(${channels.map((channel) => (channel === c ? c : 255)).join(" ")})`,
      maskImage: mask(samples.join(" ")),
    });
  }
  layers.push({
    ...shape,
    mixBlendMode: "multiply",
    backgroundColor: color,
    opacity: alpha,
    maskImage: mask(),
  });
  return layers;
}

// For one channel with source S and alpha A, native Linear Burn on an opaque
// backdrop B is (1-A)B + A max(0,B+S-1). Color Burn with source S has the
// same breakpoint. Its opacity p=A*S/M followed by Multiply M=1-A+A*S
// gives exactly both slopes. Independent channels need independent p values.
export function linearBurnLayer(node: DesignNode, doc: DesignDocument) {
  if (!simpleSubtractiveLayer(node, doc)) return;
  const s = node.style;
  const stroked = hasVisibleStroke(node);
  if (stroked === (s.fillOpacity ?? 1) > 0) return;
  const color = stroked ? (s.stroke ?? s.color) : s.fill;
  const raw = /^#([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(color);
  if (!raw) return;
  const rgb = raw.slice(1).map((hex) => parseInt(hex, 16));
  const alpha =
    (s.opacity ?? 1) *
    (stroked ? (s.strokeOpacity ?? 1) : (s.fillOpacity ?? 1));
  const shape: CSSProperties = {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    borderRadius: "inherit",
    clipPath: "var(--forma-burn-clip, none)",
  };
  if (stroked) {
    const stroke = blendedStroke(node, doc);
    if (!stroke) return;
    shape.inset = stroke.inset;
    shape.maskImage = stroke.maskImage;
    shape.maskSize = stroke.maskSize;
    shape.maskRepeat = stroke.maskRepeat;
  }
  const native: CSSProperties = {
    backgroundColor: color,
    mixBlendMode: "plus-darker",
    opacity: alpha,
  };
  if (hasClearBackdrop(node, doc))
    return {
      shape,
      layers: [{ backgroundColor: color, opacity: alpha }] as CSSProperties[],
      native,
    };
  const multiplier = rgb.map((c) => 1 - alpha + (alpha * c) / 255);
  const layers: CSSProperties[] = [];
  for (const c of new Set(rgb)) {
    if (c === 255 || c === 0) continue;
    const channels = rgb.map((channel) => (channel === c ? c : 255));
    layers.push({
      backgroundColor: `rgb(${channels.join(" ")})`,
      mixBlendMode: "color-burn",
      opacity: (alpha * c) / (255 * (1 - alpha) + alpha * c),
    });
  }
  layers.push({
    backgroundColor: `rgb(${multiplier.map((c) => 255 * c).join(" ")})`,
    mixBlendMode: "multiply",
  });
  return { shape, layers, native };
}
