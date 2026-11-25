import { subtractBlend } from "./subtract-blend";
import type { CSSProperties } from "react";
import type { DesignNode, NodeStyle } from "../domain/document";
import { roundedContour } from "../domain/stroke";

type RGB = [number, number, number];
const channels = (color: string): RGB | undefined =>
  /^#[a-f0-9]{6}$/i.test(color)
    ? [
        parseInt(color.slice(1, 3), 16) / 255,
        parseInt(color.slice(3, 5), 16) / 255,
        parseInt(color.slice(5), 16) / 255,
      ]
    : undefined;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const luminance = (p: RGB) => 0.3 * p[0] + 0.59 * p[1] + 0.11 * p[2];
function addLum(base: RGB, l: number): RGB {
  const change = l - luminance(base);
  let result = base.map((c) => c + change);
  const min = Math.min(...result),
    max = Math.max(...result);
  if (min < 0) result = result.map((c) => l + ((c - l) * l) / (l - min));
  if (max > 1) result = result.map((c) => l + ((c - l) * (1 - l)) / (max - l));
  return result as RGB;
}
function saturation(v: RGB) {
  return Math.max(...v) - Math.min(...v);
}
function setSaturation(color: RGB, sat: number): RGB {
  const min = Math.min(...color),
    span = saturation(color);
  return span ? (color.map((v) => ((v - min) * sat) / span) as RGB) : [0, 0, 0];
}
function blend(
  back: RGB,
  ink: RGB,
  mode: NodeStyle["blendMode"],
): RGB | undefined {
  if (mode === "luminosity") return addLum(back, luminance(ink));
  if (mode === "color") return addLum(ink, luminance(back));
  if (mode === "saturation")
    return addLum(setSaturation(back, saturation(ink)), luminance(back));
  if (mode === "hue")
    return addLum(setSaturation(ink, saturation(back)), luminance(back));
  const colors: number[] = [];
  for (let i = 0; i < 3; i++) {
    const a = back[i],
      b = ink[i];
    switch (mode) {
      case "plus-darker":
        colors.push(Math.max(0, a + b - 1));
        break;
      case "plus-lighter":
        colors.push(Math.min(1, a + b));
        break;
      case "multiply":
        colors.push(a * b);
        break;
      case "screen":
        colors.push(1 - (1 - a) * (1 - b));
        break;
      case "darken":
        colors.push(Math.min(a, b));
        break;
      case "lighten":
        colors.push(Math.max(a, b));
        break;
      case "overlay":
        colors.push(a <= 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b));
        break;
      case "color-burn":
        colors.push(a === 1 ? 1 : !b ? 0 : 1 - Math.min(1, (1 - a) / b));
        break;
      case "hard-light":
        colors.push(b <= 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b));
        break;
      case "soft-light": {
        const d = a <= 0.25 ? ((16 * a - 12) * a + 4) * a : Math.sqrt(a);
        colors.push(
          b <= 0.5 ? a - (1 - 2 * b) * a * (1 - a) : a + (2 * b - 1) * (d - a),
        );
        break;
      }
      case "exclusion":
        colors.push(a + b - 2 * a * b);
        break;
      case "difference":
        colors.push(Math.abs(a - b));
        break;
      case "color-dodge":
        colors.push(!a ? 0 : b >= 1 ? 1 : Math.min(1, a / (1 - b)));
        break;
      case "normal":
      case "pass-through":
      case undefined:
        colors.push(b);
        break;
      default:
        return;
    }
  }
  return colors as RGB;
}
// Compose the material's own solid colors before compositing its resulting RGBA
// over the scene. CSS background-blend-mode rejects both additive operators.
export function solidBlendPaint(node: DesignNode, baseColor = node.style.fill) {
  const s = node.style;
  if (
    !s.paints?.length ||
    node.image ||
    s.gradient ||
    s.paints.some((p) => p.visible && p.gradient)
  )
    return;
  const layers = [
    {
      color: baseColor,
      opacity: s.fillOpacity ?? 1,
      blendMode: s.fillBlendMode,
    },
    ...s.paints
      .filter((p) => p.visible)
      .slice()
      .reverse(),
  ];
  if (
    !layers.some(
      (p) =>
        p.blendMode &&
        p.blendMode !== "normal" &&
        p.blendMode !== "pass-through",
    )
  )
    return;
  let back: RGB = [0, 0, 0],
    alpha = 0;
  for (const p of layers) {
    const ink = channels(p.color);
    if (!ink) return;
    const mixed = blend(back, ink, p.blendMode);
    if (!mixed) return;
    const q = p.opacity,
      out = q + alpha * (1 - q);
    if (out)
      back = back.map(
        (b, i) =>
          ((1 - q) * alpha * b +
            q * ((1 - alpha) * ink[i] + alpha * mixed[i])) /
          out,
      ) as RGB;
    alpha = out;
  }
  return {
    color:
      "#" +
      back
        .map((v) =>
          Math.round(clamp(v) * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join(""),
    opacity: alpha,
  };
}
type Shadow = NonNullable<NodeStyle["shadows"]>[number];
function subtractShadow(
  s: NodeStyle,
  sh: Shadow,
  ellipse: boolean,
): CSSProperties[] | undefined {
  const filter = subtractBlend(sh.color);
  if (!filter) return;
  const { x, y, blur, spread, inset } = sh,
    w = s.width,
    h = s.height;
  const pad = inset
    ? 0
    : Math.ceil(
        Math.max(Math.abs(x), Math.abs(y)) + blur * 3 + Math.abs(spread) + 1,
      );
  const width = w + 2 * pad,
    height = h + 2 * pad;
  const shape = roundedContour(w, h, s, ellipse);
  const offset = inset ? spread : -spread;
  const spreadShape =
    offset * 2 < Math.min(w, h) ? roundedContour(w, h, s, ellipse, offset) : "";
  const translated = `<path d="${spreadShape}" transform="translate(${x},${y})" fill="${inset ? "black" : "white"}"/>`;
  // Blur the translated silhouette in the mask's local space. A filter placed
  // on the translated path moves the clip a second time, filling inset shadows
  // across their entire layer when an offset approaches its width or height.
  const shifted = blur
    ? `<g filter="url(#blur)">${translated}</g>`
    : translated;
  const original = `<path d="${shape}" fill="${inset ? "white" : "black"}"/>`;
  const maskBody = inset ? original + shifted : shifted + original;
  const bounds = `x="${-pad}" y="${-pad}" width="${width}" height="${height}"`;
  const extra = Math.ceil(
    Math.max(Math.abs(x), Math.abs(y)) + Math.abs(spread) + 3 * blur + 1,
  );
  const blurBounds = `x="${-pad - extra}" y="${-pad - extra}" width="${width + 2 * extra}" height="${height + 2 * extra}"`;
  const svg = (alphaTable?: string) => {
    const transfer = alphaTable
      ? `<filter id="coverage" filterUnits="userSpaceOnUse" ${bounds}><feComponentTransfer><feFuncA type="table" tableValues="${alphaTable}"/></feComponentTransfer></filter>`
      : "";
    const art = `<rect ${bounds} mask="url(#shadow)"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${-pad} ${-pad} ${width} ${height}" preserveAspectRatio="none"><defs><filter id="blur" filterUnits="userSpaceOnUse" ${blurBounds}><feGaussianBlur stdDeviation="${blur / 2}"/></filter><mask id="shadow" maskUnits="userSpaceOnUse" ${bounds}>${maskBody}</mask>${transfer}</defs>${alphaTable ? `<g filter="url(#coverage)">${art}</g>` : art}</svg>`;
  };
  const mask = (alphaTable?: string) =>
    'url("data:image/svg+xml,' + encodeURIComponent(svg(alphaTable)) + '")';
  const style: CSSProperties = { inset: -pad, maskSize: "100% 100%" };
  const rgb = channels(sh.color);
  if (inset && rgb && rgb[0] === rgb[1] && rgb[1] === rgb[2]) {
    // For a neutral ink B on an opaque backdrop X, burn(X,B) * B =
    // max(0, X+B-1). Applying the mask to the pigments avoids Chromium's
    // unmasked backdrop-filter compositing across the entire shadow box.
    const B = rgb[0];
    if (B === 1) return [];
    const multiply: CSSProperties = {
      ...style,
      background: sh.color,
      mixBlendMode: "multiply",
      maskImage: mask(),
      opacity: sh.opacity,
    };
    if (B === 0) return [multiply];
    const table = Array.from({ length: 129 }, (_, i) => {
      const t = (sh.opacity * i) / 128;
      return Number(((t * B) / (1 - t * (1 - B))).toFixed(6));
    }).join(" ");
    return [
      {
        ...style,
        background: sh.color,
        mixBlendMode: "color-burn",
        maskImage: mask(table),
      },
      multiply,
    ];
  }
  return [
    {
      ...style,
      maskImage: mask(),
      backdropFilter: filter.css,
      WebkitBackdropFilter: filter.css,
      opacity: sh.opacity,
    },
  ];
}
export function hasIndependentShadows(node: DesignNode) {
  const s = node.style;
  return !(
    node.type === "text" ||
    s.tint ||
    (s.clipContent &&
      s.shadows?.some((v) => !v.inset && v.visible !== false)) ||
    !s.shadows?.some(
      (v) =>
        v.visible !== false &&
        v.blendMode &&
        v.blendMode !== "normal" &&
        v.blendMode !== "pass-through",
    )
  );
}
// Inner highlights add to their own isolated paint before the layer's
// Multiply is applied. A fully white face is already at the additive ceiling;
// compositing the highlight a second time at its coverage edge creates a rim.
export function whiteAdditiveHighlights(node: DesignNode) {
  const s = node.style;
  return (
    s.fillBlendMode === "multiply" &&
    (s.fill.toLowerCase() === "#ffffff" ||
      /^color\(display-p3 1 1 1\)$/.test(s.fill)) &&
    (s.fillOpacity ?? 1) === 1 &&
    !s.strokeWidth &&
    !s.strokeSides &&
    !s.strokePaints?.length &&
    !s.gradient &&
    !s.paints?.length &&
    !node.image &&
    !node.fillToken &&
    !node.variableBindings?.fill &&
    !node.variableBindings?.fillOpacity &&
    !node.styleBindings?.paint &&
    !!s.shadows?.length &&
    s.shadows.every(
      (sh) =>
        sh.visible === false || (sh.inset && sh.blendMode === "plus-lighter"),
    )
  );
}
export function independentShadows(
  node: DesignNode,
): CSSProperties[] | undefined {
  if (!hasIndependentShadows(node)) return;
  if (whiteAdditiveHighlights(node)) return [];
  const s = node.style;
  const order = s
    .shadows!.filter((v) => v.visible !== false)
    .slice()
    .reverse();
  return [
    ...order.filter((v) => !v.inset),
    ...order.filter((v) => v.inset),
  ].flatMap((sh): CSSProperties[] => {
    const special =
      sh.blendMode === "plus-darker"
        ? subtractShadow(s, sh, node.type === "ellipse")
        : undefined;
    const c = channels(sh.color);
    const color = c
      ? "rgba(" +
        c.map((v) => Math.round(255 * v)).join(",") +
        "," +
        sh.opacity +
        ")"
      : `color-mix(in srgb, ${sh.color} ${100 * sh.opacity}%,transparent)`;
    const base: CSSProperties = {
      position: "absolute",
      pointerEvents: "none",
      inset: 0,
      borderRadius: "inherit",
    };
    if (special) return special.map((effect) => ({ ...base, ...effect }));
    return [
      {
        ...base,
        boxShadow: `${sh.inset ? "inset " : ""}${sh.x}px ${sh.y}px ${sh.blur}px ${sh.spread}px ${color}`,
        mixBlendMode:
          sh.blendMode === "plus-darker"
            ? "multiply"
            : sh.blendMode === "pass-through"
              ? undefined
              : sh.blendMode,
      },
    ];
  });
}
