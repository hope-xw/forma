import { polarPaint } from "../domain/polar-gradient";
import { linearGradientBackground } from "../domain/linear-gradient";
import { subtractBlend } from "./subtract-blend";
import type { DesignNode, NodeStyle } from "../domain/document";
export function rgba(hex: string, alpha = 1) {
  if (hex.startsWith("color(display-p3 "))
    return hex.slice(0, -1) + ` / ${alpha})`;
  return `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${alpha})`;
}
export function gradientCss(
  gradient: NonNullable<NodeStyle["gradient"]>,
  opacity: number,
  variable?: (id: string) => string,
) {
  const sorted = [...gradient.stops].sort((a, b) => a.offset - b.offset);
  const formatStops = (scaleOffset = 1, start = 0) =>
    sorted
      .map(
        (stop) =>
          (stop.variableId && variable
            ? `color-mix(in srgb, var(${variable(stop.variableId)}) ${stop.opacity * opacity * 100}%, transparent)`
            : rgba(stop.color, stop.opacity * opacity)) +
          " " +
          (stop.offset - start) * 100 * scaleOffset +
          "%",
      )
      .join(", ");
  if (gradient.type === "linear" && gradient.linearProjection) {
    const projection = linearGradientBackground(gradient.linearProjection);
    if (projection)
      return `linear-gradient(to ${projection.direction}, ${formatStops(1 / projection.range, projection.min)})${projection.size}`;
  }
  if (gradient.type === "linear")
    return `linear-gradient(${gradient.angle}deg, ${formatStops()})`;
  if (gradient.type === "angular" || gradient.type === "radial") {
    const polar =
      gradient.paintTransform && polarPaint(gradient.paintTransform);
    const center = polar
      ? `${polar.center.x * 100}% ${polar.center.y * 100}%`
      : "50% 50%";
    if (gradient.type === "angular")
      return `conic-gradient(from ${gradient.angle}deg at ${center}, ${formatStops()})`;
    if (polar?.axisAligned)
      return `radial-gradient(ellipse ${polar.rx * 100}% ${polar.ry * 100}% at ${center}, ${formatStops()})`;
  }
  if (gradient.type === "diamond") {
    const halfStops = formatStops(0.5);
    return [
      `linear-gradient(to bottom right, ${halfStops}) bottom right / 50% 50% no-repeat`,
      `linear-gradient(to bottom left, ${halfStops}) bottom left / 50% 50% no-repeat`,
      `linear-gradient(to top left, ${halfStops}) top left / 50% 50% no-repeat`,
      `linear-gradient(to top right, ${halfStops}) top right / 50% 50% no-repeat`,
    ].join(", ");
  }
  return `radial-gradient(ellipse at center, ${formatStops()})`;
}
export function symbolicPaintColor(
  p: NonNullable<NodeStyle["paints"]>[number],
  variable?: (id: string) => string,
) {
  return variable && (p.colorVariableId || p.opacityVariableId)
    ? `color-mix(in srgb, ${p.colorVariableId ? "var(" + variable(p.colorVariableId) + ")" : p.color} ${p.opacityVariableId ? "calc(var(" + variable(p.opacityVariableId) + ") * 100%)" : p.opacity * 100 + "%"}, transparent)`
    : rgba(p.color, p.opacity);
}
export function stackPaints(
  paints: NodeStyle["paints"],
  base: string,
  variable?: (id: string) => string,
) {
  return [
    ...(paints ?? [])
      .filter((p) => p.visible)
      .map((p) => {
        const color = symbolicPaintColor(p, variable);
        return p.gradient
          ? gradientCss(p.gradient, p.opacity, variable)
          : `linear-gradient(${color}, ${color})`;
      }),
    base,
  ].join(", ");
}

// Plus Darker with an opaque neutral fill subtracts the same value from RGB.
// Preserve the independent blend of a frame's children by filtering its backdrop.
export function backdropSubtraction(node: DesignNode, color = node.style.fill) {
  const s = node.style;
  if (
    s.fillBlendMode !== "plus-darker" ||
    (s.fillOpacity ?? 1) !== 1 ||
    s.gradient ||
    s.paints?.some((p) => p.visible) ||
    node.image ||
    !["frame", "rectangle", "ellipse"].includes(node.type) ||
    !/^#([a-f\d]{2})\1\1$/i.test(color)
  )
    return undefined;
  return 1 - parseInt(color.slice(1, 3), 16) / 255;
}

export function textSubtraction(node: DesignNode) {
  const s = node.style;
  if (
    node.type !== "text" ||
    s.blendMode !== "plus-darker" ||
    node.textRuns?.some((r) => r.style.color) ||
    s.paints?.some((p) => p.visible)
  )
    return;
  // Solid black already renders identically with normal source-over.
  if (s.color === "#000000" || s.color === "color(display-p3 0 0 0)") return;
  return subtractBlend(s.color);
}
export function textInkPaints(node: DesignNode) {
  const s = node.style;
  const subtract = textSubtraction(node);
  if (subtract)
    return [
      {
        background: "transparent",
        backdropFilter: subtract.css,
        opacity: s.colorOpacity ?? 1,
      },
    ];
  const hasBackdrop =
    s.backdropBlurVisible !== false &&
    (!!s.backdropBlur ||
      s.backdropSaturation !== undefined ||
      s.backdropBrightness !== undefined);
  if (
    node.type !== "text" ||
    (!s.paints?.some((p) => p.visible) && !hasBackdrop) ||
    !(s.fillBlendMode || s.paints?.some((p) => p.blendMode))
  )
    return undefined;
  return [
    {
      color: s.fill,
      opacity: s.fillOpacity ?? 1,
      gradient: s.gradient,
      blendMode: s.fillBlendMode,
    },
    ...(s.paints ?? [])
      .filter((p) => p.visible)
      .slice()
      .reverse(),
  ].map((p) => ({
    background: p.gradient
      ? gradientCss(p.gradient, p.opacity)
      : rgba(p.color, p.opacity),
    ...(p.blendMode && p.blendMode !== "pass-through"
      ? { blend: p.blendMode }
      : {}),
  }));
}
