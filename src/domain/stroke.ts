import type { NodeStyle } from "./document";
import { cssCornerShape, smoothCorners, svgCornerPath } from "./smooth-corners";
export const strokeEdges = ["top", "right", "bottom", "left"] as const;
type Edge = (typeof strokeEdges)[number];
export function strokeInset(style?: NodeStyle, edge?: Edge) {
  if (
    !style ||
    style.strokeInLayout === false ||
    style.strokeVisible === false ||
    style.strokeAlign === "outside"
  )
    return 0;
  const width = (edge && style.strokeSides?.[edge]) ?? style.strokeWidth ?? 0;
  return style.strokeAlign === "center" ? width / 2 : width;
}
function radiiFor(style: NodeStyle, offset = 0) {
  const c = style.corners;
  return [c?.tl, c?.tr, c?.br, c?.bl].map((v) => {
    const r = v ?? style.radius;
    return r === 0 ? 0 : Math.max(0, r - offset);
  });
}
export function smoothCornerCss(
  style: NodeStyle,
  fluid: boolean,
  canClip: boolean,
): Record<string, string> {
  if (!style.cornerSmoothing) return {};
  const radii = radiiFor(style);
  if (!radii.some(Boolean)) return {};
  const { width, height } = style;
  const symmetric = style.cornerSmoothingModel === "figma";
  if (
    symmetric &&
    radii.every((r) => r === radii[0]) &&
    radii[0] >= Math.min(width, height) / 2
  )
    return {};
  const contour = smoothCorners(
    width,
    height,
    radii,
    style.cornerSmoothing,
    0,
    symmetric,
  );
  const shape = cssCornerShape(contour, width, height, fluid);
  return canClip
    ? { clipPath: shape, borderRadius: "0px" }
    : { borderShape: shape };
}
export function roundedContour(
  w: number,
  h: number,
  style: NodeStyle,
  ellipse = false,
  offset = 0,
) {
  const x = offset,
    y = offset,
    right = w - offset,
    bottom = h - offset;
  if (ellipse) {
    const rx = Math.max(0, w / 2 - offset),
      ry = Math.max(0, h / 2 - offset);
    return `M${x} ${h / 2}a${rx} ${ry} 0 1 1 ${2 * rx} 0a${rx} ${ry} 0 1 1 ${-2 * rx} 0Z`;
  }
  const radii = radiiFor(style, offset);
  if (style.cornerSmoothing && radii.some(Boolean))
    return svgCornerPath(
      smoothCorners(
        w,
        h,
        radii,
        style.cornerSmoothing,
        offset,
        style.cornerSmoothingModel === "figma",
      ),
    );
  const [a, b, c1, d] = radii;
  const factor = Math.max(
    0,
    Math.min(
      1,
      (right - x) / (a + b || 1),
      (right - x) / (c1 + d || 1),
      (bottom - y) / (a + d || 1),
      (bottom - y) / (b + c1 || 1),
    ),
  );
  const [tl, tr, br, bl] = radii.map((r) => r * factor);
  const arc = (r: number, x: number, y: number) =>
    r ? `A${r} ${r} 0 0 1 ${x} ${y}` : `L${x} ${y}`;
  return `M${x + tl} ${y}H${right - tr}${arc(tr, right, y + tr)}V${bottom - br}${arc(br, right - br, bottom)}H${x + bl}${arc(bl, x, bottom - bl)}V${y + tl}${arc(tl, x + tl, y)}Z`;
}
// SVG contour shared by static exports and CSS border images. Each edge owns
// its corner up to the diagonal, so unequal widths meet without overlapping.
export function strokeArtwork(
  style: NodeStyle,
  w: number,
  h: number,
  color: string,
  ellipse = false,
  id = "stroke",
) {
  const widths = strokeEdges.map(
    (edge) => style.strokeSides?.[edge] ?? style.strokeWidth ?? 0,
  );
  const factor =
    style.strokeAlign === "outside"
      ? 1
      : style.strokeAlign === "center"
        ? 0.5
        : 0;
  const outset = widths.map((n) => n * factor);
  if (style.strokeVisible === false || !widths.some(Boolean))
    return { body: "", outset: [0, 0, 0, 0] };
  const uniform = widths.every((n) => n === widths[0]);
  if (
    !uniform &&
    !ellipse &&
    !radiiFor(style).some(Boolean) &&
    !style.strokeDash?.trim() &&
    (!style.strokeStyle || style.strokeStyle === "solid")
  ) {
    // The inner corners follow the actual adjacent widths. A lone horizontal
    // side reaches both ends, including where its neighbours are zero-width.
    const [t, r, b, l] = outset;
    const [it, ir, ib, il] = widths.map((v, i) => v - outset[i]);
    const outer = `M${-l} ${-t}H${w + r}V${h + b}H${-l}Z`;
    const inner =
      il + ir < w && it + ib < h
        ? `M${il} ${it}H${w - ir}V${h - ib}H${il}Z`
        : "";
    return {
      body: `<path d="${outer}${inner}" fill-rule="evenodd" fill="${color}"/>`,
      outset,
    };
  }
  const extent = Math.max(...widths);
  const corners = [
    [-extent, -extent],
    [w + extent, -extent],
    [w + extent, h + extent],
    [-extent, h + extent],
  ];
  // Straight sides meet at 45-degree bisectors. A wide, very shallow line
  // has a horizontal medial segment, rather than four wedges at its centre.
  const depth = Math.min(w, h) / 2;
  const joins = [
    [depth, depth],
    [w - depth, depth],
    [w - depth, h - depth],
    [depth, h - depth],
  ];
  const body = widths
    .map((width, i) => {
      if (!width || (uniform && i)) return "";
      const clip = id + i;
      const dash = style.strokeDash?.trim();
      const pattern =
        dash &&
        dash
          .split(/[ ,]+/)
          .every((n) => /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(n))
          ? dash
          : style.strokeStyle === "dashed"
            ? `${3 * width} ${2 * width}`
            : style.strokeStyle === "dotted"
              ? `0 ${2 * width}`
              : undefined;
      const path = (offset: number, thickness: number) =>
        `<path d="${roundedContour(w, h, style, ellipse, offset)}" fill="none" stroke="${color}" stroke-width="${thickness}"${pattern ? ` stroke-dasharray="${pattern}"` : ""}${style.strokeStyle === "dotted" ? ' stroke-linecap="round"' : ""}/>`;
      const center = width * (0.5 - factor);
      if (
        uniform &&
        !pattern &&
        style.strokeStyle !== "double" &&
        style.cornerSmoothingModel === "figma" &&
        !style.corners &&
        style.radius >= Math.min(w, h) / 2 &&
        !ellipse
      ) {
        const widthInside = Math.max(0, w - 2 * center),
          heightInside = Math.max(0, h - 2 * center);
        return `<rect x="${center}" y="${center}" width="${widthInside}" height="${heightInside}" rx="${Math.min(widthInside, heightInside) / 2}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
      }
      const contour =
        style.strokeStyle === "double" && !pattern
          ? path(center - width / 3, width / 3) +
            path(center + width / 3, width / 3)
          : path(center, width);
      return uniform
        ? contour
        : `<defs><clipPath id="${clip}"><polygon points="${corners[i]} ${corners[(i + 1) % 4]} ${joins[(i + 1) % 4]} ${joins[i]}"/></clipPath></defs><g clip-path="url(#${clip})">${contour}</g>`;
    })
    .join("");
  return { body, outset };
}
export function strokeCss(
  style: NodeStyle,
  color: string,
  width = String(style.strokeWidth ?? 0) + "px",
  ellipse = false,
): Record<string, string | number> {
  if (style.strokeVisible === false) return { border: 0 };
  const dash = style.strokeDash?.trim();
  const line = dash ? "dashed" : (style.strokeStyle ?? "solid");
  const decorative = style.strokeInLayout === false;
  const center = style.strokeAlign === "center";
  const inside = !style.strokeAlign || style.strokeAlign === "inside";
  if (style.strokeSides || dash) {
    const css: Record<string, string | number> = {
      borderStyle: line,
      borderColor: color,
    };
    for (const edge of strokeEdges) {
      const value = style.strokeSides?.[edge];
      const edgeWidth = value === undefined ? width : value + "px";
      css["border" + edge[0].toUpperCase() + edge.slice(1) + "Width"] =
        decorative
          ? 0
          : inside
            ? edgeWidth
            : center
              ? "calc(" + edgeWidth + " / 2)"
              : 0;
    }
    if (decorative || dash || !inside) {
      const { width: w, height: h } = style;
      const variableColor = color.includes("var(");
      const ink = variableColor ? (style.stroke ?? style.color) : color;
      const { body, outset } = strokeArtwork(style, w, h, ink, ellipse);
      const [top, right, bottom, left] = outset;
      const image = `<svg xmlns="http://www.w3.org/2000/svg" width="${w + left + right}" height="${h + top + bottom}" viewBox="${-left} ${-top} ${w + left + right} ${h + top + bottom}" preserveAspectRatio="none"><g opacity="${variableColor ? (style.strokeOpacity ?? 1) : 1}">${body}</g></svg>`;
      css.borderColor = "transparent";
      css.borderImageSource =
        'url("data:image/svg+xml,' + encodeURIComponent(image) + '")';
      css.borderImageSlice = "0 fill";
      css.borderImageWidth = 0;
      css.borderImageOutset = outset.map((n) => n + "px").join(" ");
    }
    return css;
  }
  if (decorative && center && line === "solid") {
    // Chromium rounds CSS outlines to device pixels. Two zero-blur shadows
    // paint an odd-width stroke evenly across the edge without changing layout.
    const half = "calc(" + width + " / 2)";
    return {
      border: 0,
      "--forma-center-stroke":
        "inset 0 0 0 " + half + " " + color + ", 0 0 0 " + half + " " + color,
    };
  }
  if (decorative)
    return {
      border: 0,
      outline: width + " " + line + " " + color,
      outlineOffset: inside
        ? "calc(" + width + " * -1)"
        : center
          ? "calc(" + width + " / -2)"
          : 0,
    };
  if (inside) return { border: width + " " + line + " " + color };
  return {
    border: center ? "calc(" + width + " / 2) solid transparent" : 0,
    outline: width + " " + line + " " + color,
    outlineOffset: center ? "calc(" + width + " / -2)" : 0,
  };
}
