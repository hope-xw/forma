import { whiteAdditiveHighlights } from "./material-composite";
import { polarPaint } from "../domain/polar-gradient";
import { glassUnderlays, sampleGlass } from "./figma-glass";
import { linearGradientEndpoints } from "../domain/linear-gradient";
import { subtractiveFill, strokePaintBlend } from "./layer-blend";
import { createNode } from "../domain/document";
import { childrenOf } from "../domain/scene-index";
import { resolveNode } from "../domain/design-system";
import type { RuntimeNode } from "../runtime/FormaRuntime";
import { subtractBlend } from "./subtract-blend";
import { solidBlendPaint } from "./material-composite";
import { symbolPaintForView } from "../domain/symbol-background";
import { tintPrimitives } from "./group-tint";
import { backdropSubtraction, textInkPaints, textSubtraction } from "./paints";
import { fontFaceWeight } from "../domain/fonts";
import { currentTextLayout, currentTextShape } from "../domain/text-shape";
import { imageViewport, svgImagePaint } from "../domain/images";
import {
  bitmapMaskArtwork,
  booleanVector,
  maskClip,
  vectorClipPath,
} from "../domain/boolean-shapes";
import { displayColor, displayNode } from "../domain/color-profile";
import { hexToRgb, rgbToHex } from "../domain/color";
import { resolvedDocument } from "../domain/design-system";
import type { DesignDocument, DesignNode, NodeStyle } from "../domain/document";
import { layoutBounds, union, type Rect } from "../domain/geometry";
import { nodeInteractions } from "../domain/prototype";
import { textParts, type InlineStyle } from "../domain/rich-text";
import { roundedContour, strokeArtwork } from "../domain/stroke";
import {
  inverse,
  localTransform,
  visualBounds,
  type Matrix,
} from "../domain/transforms";

const xml = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const attrs = (values: Record<string, unknown>) =>
  Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${xml(v)}"`)
    .join("");
const matrix = (m: Matrix) =>
  `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;
type Gradient = NonNullable<NodeStyle["gradient"]>;
export type Scale = number;
export type RasterFormat = "png" | "jpeg" | "webp";
export type MeasureSvgTextWidth = (
  text: string,
  font: {
    style: string;
    weight: string | number;
    size: number;
    family: string;
  },
) => number | undefined;

let svgTextWidthMeasurer: MeasureSvgTextWidth | null = null;

export function configureSvgTextWidth(measurer: MeasureSvgTextWidth | null) {
  svgTextWidthMeasurer = measurer;
}

function parseStopRgb(color: string): [number, number, number] {
  if (/^#[0-9a-f]{6}/i.test(color)) return hexToRgb(color.slice(0, 7));
  if (color.startsWith("color(display-p3 ")) {
    const nums = color
      .slice("color(display-p3 ".length, -1)
      .split(/[ /\s]+/)
      .slice(0, 3)
      .map((n) => Math.round(Number(n) * 255));
    if (nums.length === 3 && nums.every(Number.isFinite))
      return [nums[0], nums[1], nums[2]];
  }
  return [0, 0, 0];
}

function sampleGradientStop(
  stops: { offset: number; color: string; opacity: number }[],
  t: number,
): { color: string; opacity: number } {
  if (t <= stops[0].offset)
    return { color: stops[0].color, opacity: stops[0].opacity };
  const last = stops[stops.length - 1];
  if (t >= last.offset) return { color: last.color, opacity: last.opacity };
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (t >= a.offset && t <= b.offset) {
      const span = b.offset - a.offset || 1;
      const f = (t - a.offset) / span;
      const [r1, g1, b1] = parseStopRgb(a.color);
      const [r2, g2, b2] = parseStopRgb(b.color);
      return {
        color: rgbToHex(
          r1 + (r2 - r1) * f,
          g1 + (g2 - g1) * f,
          b1 + (b2 - b1) * f,
        ),
        opacity: Number((a.opacity + (b.opacity - a.opacity) * f).toFixed(4)),
      };
    }
  }
  return { color: last.color, opacity: last.opacity };
}

function svgText(node: DesignNode, w: number, h: number) {
  const s = node.style,
    button = node.type === "button";
  const shape = currentTextShape(node);
  if (
    shape &&
    Math.abs(w - shape.width) <= 1 &&
    Math.abs(h - shape.height) <= 1
  ) {
    return (
      "<path" +
      attrs({
        d: shape.d,
        fill: s.color,
        "fill-opacity": s.colorOpacity,
        "aria-label": node.text,
      }) +
      "/>"
    );
  }
  const layout = currentTextLayout(node);
  if (
    layout &&
    Math.abs(w - layout.width) <= 1 &&
    Math.abs(h - layout.height) <= 1
  ) {
    return layout.lines
      .map(
        (line) =>
          "<text" +
          attrs({
            "font-family": s.fontFamily,
            "font-size": s.fontSize,
            "font-weight": s.fontWeight,
            "font-style": s.fontStyle,
            "text-decoration": s.textDecoration,
            fill: s.color,
            "fill-opacity": s.colorOpacity,
            "xml:space": "preserve",
            style: [
              "-webkit-font-smoothing:antialiased",
              "letter-spacing:0",
              s.fontVariationSettings &&
                "font-variation-settings:" + s.fontVariationSettings,
              s.fontFeatureSettings &&
                "font-feature-settings:" + s.fontFeatureSettings,
            ]
              .filter(Boolean)
              .join(";"),
          }) +
          ">" +
          [...line.text]
            .map(
              (c, i) =>
                "<tspan" +
                attrs({ x: line.x[i], y: line.y }) +
                ">" +
                xml(c) +
                "</tspan>",
            )
            .join("") +
          "</text>",
      )
      .join("");
  }
  const padding = button ? 8 : node.type === "frame" ? s.padding : 0;
  const width = Math.max(1, w - padding * 2);
  type Run = { text: string; style: InlineStyle; width: number };
  const lines: Run[][] = [[]];
  let used = 0;
  const add = (text: string, style: InlineStyle, size: number) => {
    const font = {
      style: style.fontStyle ?? s.fontStyle ?? "normal",
      weight: style.fontWeight ?? s.fontWeight ?? 400,
      size,
      family: style.fontFamily ?? s.fontFamily ?? "system-ui",
    };
    const length = (t: string) =>
      (svgTextWidthMeasurer?.(t, font) ??
        [...t].reduce(
          (a, c) => a + (c.charCodeAt(0) > 255 ? size : size * 0.56),
          0,
        )) +
      [...t].length * (style.letterSpacing ?? s.letterSpacing ?? 0);
    const append = (t: string, n: number) => {
      const line = lines[lines.length - 1],
        last = line.at(-1);
      if (last?.style === style) {
        last.text += t;
        last.width += n;
      } else line.push({ text: t, style, width: n });
      used += n;
    };
    for (const token of text.match(/\r\n|\n|[^\S\n\r]+|[^\s]+/gu) ?? []) {
      if (token.includes("\n")) {
        lines.push([]);
        used = 0;
        continue;
      }
      const n = length(token);
      if (used && n + used > width && token.trim()) {
        lines.push([]);
        used = 0;
      }
      if (n <= width) append(token, n);
      else
        for (const c of token) {
          const cw = length(c);
          if (used && used + cw > width) {
            lines.push([]);
            used = 0;
          }
          append(c, cw);
        }
    }
  };
  for (const part of textParts(node)) {
    let t = part.text;
    if (s.textTransform === "uppercase") t = t.toUpperCase();
    if (s.textTransform === "lowercase") t = t.toLowerCase();
    if (s.textTransform === "capitalize")
      t = t.replace(/(^|\s)(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
    add(t, part.style, part.style.fontSize ?? s.fontSize);
  }
  if (s.maxLines && lines.length > s.maxLines) {
    lines.length = s.maxLines;
    const line = lines.at(-1)!;
    const last = line.at(-1);
    if (last) last.text = last.text.trimEnd().replace(/.$/u, "…");
  }
  const heights = lines.map(
    (line) =>
      s.lineHeight ??
      Math.max(s.fontSize, ...line.map((run) => run.style.fontSize ?? 0)) * 1.4,
  );
  const total = heights.reduce((a, b) => a + b, 0);
  let y =
    button || s.verticalAlign === "middle"
      ? (h - total) / 2
      : s.verticalAlign === "bottom"
        ? h - padding - total
        : padding;
  const anchor =
    s.textAlign === "right"
      ? "end"
      : s.textAlign === "center" || button
        ? "middle"
        : "start";
  const x =
    anchor === "start" ? padding : anchor === "middle" ? w / 2 : w - padding;
  const css = (style: InlineStyle | NodeStyle) =>
    [
      style.fontVariationSettings &&
        "font-variation-settings:" + style.fontVariationSettings,
      style.fontFeatureSettings &&
        "font-feature-settings:" + style.fontFeatureSettings,
    ]
      .filter(Boolean)
      .join(";") || undefined;
  const font = (f: InlineStyle | NodeStyle) => ({
    "font-family": f.fontFamily,
    "font-size": f.fontSize,
    "font-style": f.fontStyle,
    "font-weight": f.fontWeight,
    "letter-spacing": f.letterSpacing,
    "text-decoration": f.textDecoration,
    style: css(f),
  });
  return (
    "<text" +
    attrs({
      ...font(s),
      "font-family": s.fontFamily ?? "system-ui, sans-serif",
      fill: s.color,
      "fill-opacity": s.colorOpacity,
      "text-anchor": anchor,
      "xml:space": "preserve",
    }) +
    ">" +
    lines
      .map((line, i) => {
        const size = Math.max(
          s.fontSize,
          ...line.map((r) => r.style.fontSize ?? 0),
        );
        const baseline = y + (heights[i] - size) / 2 + size * 0.8;
        y += heights[i];
        return (
          "<tspan" +
          attrs({ x, y: baseline }) +
          ">" +
          line
            .map(
              (r) =>
                "<tspan" +
                attrs({ ...font(r.style), fill: r.style.color }) +
                ">" +
                xml(r.text) +
                "</tspan>",
            )
            .join("") +
          "</tspan>"
        );
      })
      .join("") +
    "</text>"
  );
}
export function svgAsset(
  doc: DesignDocument,
  nodeId: string,
  scale: Scale = 1,
) {
  doc = resolvedDocument(doc);
  const root = doc.nodes.find((n) => n.id === nodeId);
  if (!root) throw Error("图层不存在：" + nodeId);
  const bounds = layoutBounds(doc),
    rootBox = bounds.get(nodeId)!;
  const opticalFloors = glassUnderlays(doc, bounds, nodeId);
  const children = new Map<string, DesignNode[]>();
  for (const n of doc.nodes)
    if (n.parentId) {
      const list = children.get(n.parentId) ?? [];
      list.push(n);
      children.set(n.parentId, list);
    }
  const defs: string[] = [];
  const usedFonts = new Set<string>();
  let serial = 0;
  const id = () => "f" + ++serial;
  const define = (
    tag: string,
    attributes: Record<string, unknown>,
    content: string,
  ) => {
    const key = id();
    defs.push(
      "<" +
        tag +
        attrs({ id: key, ...attributes }) +
        ">" +
        content +
        "</" +
        tag +
        ">",
    );
    return key;
  };
  const use = (id: string) => `<use href="#${id}"/>`;
  const needsBackdrop = doc.nodes.some(
    (n) =>
      backdropSubtraction(
        n,
        (n.fillToken && doc.tokens[n.fillToken]?.value) || n.style.fill,
      ) !== undefined ||
      textSubtraction(n) !== undefined ||
      n.style.figmaGlass?.visible === true ||
      n.style.blendMode === "plus-darker" ||
      n.style.strokeBlendMode === "plus-darker" ||
      n.style.strokePaints?.some(
        (p) =>
          p.visible &&
          p.blendMode &&
          p.blendMode !== "normal" &&
          p.blendMode !== "pass-through",
      ) ||
      n.style.shadows?.some(
        (v) => v.visible !== false && v.blendMode === "plus-darker",
      ) ||
      ((n.style.backdropBlur ||
        n.style.backdropBrightness !== undefined ||
        n.style.backdropSaturation !== undefined) &&
        n.style.backdropBlurVisible !== false),
  );
  function gradient(g: Gradient, w: number, h: number) {
    const sorted = g.stops.slice().sort((a, b) => a.offset - b.offset);
    const stops = sorted
      .map(
        (stop) =>
          "<stop" +
          attrs({
            offset: stop.offset,
            "stop-color": stop.color,
            "stop-opacity": stop.opacity,
          }) +
          "/>",
      )
      .join("");
    if (g.type === "linear" && g.linearProjection) {
      const points = linearGradientEndpoints(g.linearProjection);
      if (points)
        return "url(#" + define("linearGradient", points, stops) + ")";
    }
    if (g.type === "radial") {
      const basis = g.paintTransform && polarPaint(g.paintTransform).basis;
      return (
        "url(#" +
        define(
          "radialGradient",
          basis ? { gradientTransform: matrix(basis) } : {},
          stops,
        ) +
        ")"
      );
    }
    if (g.type === "diamond") {
      const br = define(
        "linearGradient",
        { x1: 0, y1: 0, x2: 0.5, y2: 0.5 },
        stops,
      );
      const bl = define(
        "linearGradient",
        { x1: 1, y1: 0, x2: 0.5, y2: 0.5 },
        stops,
      );
      const tl = define(
        "linearGradient",
        { x1: 1, y1: 1, x2: 0.5, y2: 0.5 },
        stops,
      );
      const tr = define(
        "linearGradient",
        { x1: 0, y1: 1, x2: 0.5, y2: 0.5 },
        stops,
      );
      const quadrants =
        `<rect x="0.5" y="0.5" width="0.5" height="0.5" fill="url(#${br})"/>` +
        `<rect x="0" y="0.5" width="0.5" height="0.5" fill="url(#${bl})"/>` +
        `<rect x="0" y="0" width="0.5" height="0.5" fill="url(#${tl})"/>` +
        `<rect x="0.5" y="0" width="0.5" height="0.5" fill="url(#${tr})"/>`;
      return (
        "url(#" +
        define(
          "pattern",
          {
            patternUnits: "objectBoundingBox",
            width: 1,
            height: 1,
            viewBox: "0 0 1 1",
            preserveAspectRatio: "none",
          },
          quadrants,
        ) +
        ")"
      );
    }
    if (g.type === "angular") {
      const segments = 72;
      const center = g.paintTransform && polarPaint(g.paintTransform).center;
      const cx = w * (center?.x ?? 0.5);
      const cy = h * (center?.y ?? 0.5);
      const radius = Math.max(1, Math.hypot(w, h));
      const baseDeg = g.angle - 90;
      const wedges: string[] = [];
      for (let i = 0; i < segments; i++) {
        const a1 = ((baseDeg + (i / segments) * 360) * Math.PI) / 180;
        const a2 = ((baseDeg + ((i + 1.05) / segments) * 360) * Math.PI) / 180;
        const x1 = +(cx + Math.cos(a1) * radius).toFixed(3);
        const y1 = +(cy + Math.sin(a1) * radius).toFixed(3);
        const x2 = +(cx + Math.cos(a2) * radius).toFixed(3);
        const y2 = +(cy + Math.sin(a2) * radius).toFixed(3);
        const sample = sampleGradientStop(sorted, (i + 0.5) / segments);
        wedges.push(
          `<path d="M${cx} ${cy}L${x1} ${y1}L${x2} ${y2}Z"${attrs({ fill: sample.color, "fill-opacity": sample.opacity })}/>`,
        );
      }
      return (
        "url(#" +
        define(
          "pattern",
          {
            patternUnits: "userSpaceOnUse",
            width: Math.max(1, w),
            height: Math.max(1, h),
          },
          wedges.join(""),
        ) +
        ")"
      );
    }
    const angle = (g.angle * Math.PI) / 180,
      dx = Math.sin(angle),
      dy = -Math.cos(angle);
    const length = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
    return (
      "url(#" +
      define(
        "linearGradient",
        {
          gradientUnits: "userSpaceOnUse",
          x1: w / 2 - dx * length,
          y1: h / 2 - dy * length,
          x2: w / 2 + dx * length,
          y2: h / 2 + dy * length,
        },
        stops,
      ) +
      ")"
    );
  }
  function render(raw: DesignNode, parent: Rect, backdrop?: string): string {
    if (raw.hidden || raw.type === "slice") return "";
    const subtract = backdropSubtraction(
      raw,
      (raw.fillToken && doc.tokens[raw.fillToken]?.value) || raw.style.fill,
    );
    const node = displayNode(
        symbolPaintForView(raw, "export"),
        doc.colorProfile,
      ),
      s = node.style;
    const box = bounds.get(node.id)!,
      { width: w, height: h } = box;
    const local = { x: 0, y: 0, width: w, height: h };
    const m = localTransform(node, local);
    m.e += box.x - parent.x;
    m.f += box.y - parent.y;
    const shape = roundedContour(w, h, s, node.type === "ellipse");
    const path = (fill: string, opacity?: number) =>
      "<path" + attrs({ d: shape, fill, "fill-opacity": opacity }) + "/>";
    const crop = define("clipPath", {}, path("white"));
    const clipped = (body: string) =>
      `<g clip-path="url(#${crop})">${body}</g>`;
    const textSubtract = textSubtraction(node);
    const paintGlyphs = node.type === "text" && s.textEffectClip === "glyphs";
    const inkPaints = textInkPaints(node);
    const glyphClip =
      (paintGlyphs || textSubtract !== undefined) &&
      node.text &&
      (inkPaints ||
        s.backdropBlur ||
        s.backdropSaturation !== undefined ||
        s.backdropBrightness !== undefined)
        ? define(
            "clipPath",
            { clipPathUnits: "userSpaceOnUse" },
            svgText(node, w, h),
          )
        : undefined;
    const behind =
      backdrop && needsBackdrop
        ? define("g", { transform: matrix(inverse(m)) }, use(backdrop))
        : undefined;
    let content = (opticalFloors.get(node.id) ?? [])
      .map(
        ({ style, node: face }) =>
          "<path" +
          attrs({
            d: roundedContour(
              Number(style.width),
              Number(style.height),
              face.style,
            ),
            transform: `translate(${style.left} ${style.top})`,
            fill: style.background,
          }) +
          "/>",
      )
      .join("");
    const glass = behind && s.figmaGlass && sampleGlass(raw, doc, {});
    if (glass && !glass.floorOnly && behind) {
      const g = s.figmaGlass!;
      const rim = Math.min(g.refractionRadius! / 2, w / 2, h / 2);
      const soft = define(
        "filter",
        {},
        `<feGaussianBlur stdDeviation="${g.bevelSize}"/>`,
      );
      const mask = define(
        "mask",
        {
          maskUnits: "userSpaceOnUse",
          x: 0,
          y: 0,
          width: w,
          height: h,
          "mask-type": "alpha",
        },
        "<rect" +
          attrs({
            x: rim,
            y: rim,
            width: w - 2 * rim,
            height: h - 2 * rim,
            rx: Math.max(0, Math.min(s.radius, w / 2, h / 2) - rim),
            fill: "white",
            filter: `url(#${soft})`,
          }) +
          "/>",
      );
      const lowpass = define(
        "filter",
        { "color-interpolation-filters": "sRGB" },
        `<feGaussianBlur stdDeviation="${g.refractionIntensity! * g.bevelSize!}"/>`,
      );
      content += `<g mask="url(#${mask})" opacity="${glass.layer.opacity}"><rect width="${w}" height="${h}" fill="${glass.layer.background ?? glass.environment}"/><g filter="url(#${lowpass})">${use(behind)}</g></g>`;
    }
    if (
      behind &&
      (s.backdropBlur ||
        s.backdropBrightness !== undefined ||
        s.backdropSaturation !== undefined) &&
      s.backdropBlurVisible !== false
    ) {
      const blur = define(
        "filter",
        {},
        [
          s.backdropBlur &&
            `<feGaussianBlur stdDeviation="${s.backdropBlur}"/>`,
          s.backdropSaturation !== undefined &&
            `<feColorMatrix type="saturate" values="${s.backdropSaturation}"/>`,
          s.backdropBrightness !== undefined &&
            "<feComponentTransfer>" +
              ["R", "G", "B"]
                .map(
                  (channel) =>
                    `<feFunc${channel} type="linear" slope="${s.backdropBrightness}"/>`,
                )
                .join("") +
              "</feComponentTransfer>",
        ]
          .filter(Boolean)
          .join(""),
      );
      const filtered = `<g filter="url(#${blur})">${use(behind)}</g>`;
      content += glyphClip
        ? `<g clip-path="url(#${glyphClip})">${filtered}</g>`
        : clipped(filtered);
    }
    if (subtract !== undefined && behind) {
      const channels = ["R", "G", "B"]
        .map(
          (channel) =>
            `<feFunc${channel} type="linear" slope="1" intercept="${-subtract}"/>`,
        )
        .join("");
      const filter = define(
        "filter",
        { "color-interpolation-filters": "sRGB" },
        "<feComponentTransfer>" + channels + "</feComponentTransfer>",
      );
      content += clipped(`<g filter="url(#${filter})">${use(behind)}</g>`);
    }
    const layerInk = subtractiveFill(node, doc);
    const strokeBlend = strokePaintBlend(node, doc);
    if (layerInk && behind) {
      const filter = define(
        "filter",
        {
          filterUnits: "userSpaceOnUse",
          x: 0,
          y: 0,
          width: w,
          height: h,
          "color-interpolation-filters": "sRGB",
        },
        layerInk.primitives,
      );
      content += clipped(
        `<g opacity="${s.fillOpacity ?? 1}" filter="url(#${filter})">${use(behind)}</g>`,
      );
    }
    const boxPaint =
      !(layerInk && behind) &&
      subtract === undefined &&
      !["text", "group", "vector", "slice"].includes(node.type);
    const visibleNode = symbolPaintForView(raw, "export");
    const composed =
      boxPaint &&
      solidBlendPaint(
        visibleNode,
        (visibleNode.fillToken && doc.tokens[visibleNode.fillToken]?.value) ||
          visibleNode.style.fill,
      );
    if (composed)
      content += path(
        displayColor(composed.color, doc.colorProfile),
        composed.opacity,
      );
    else if (boxPaint) {
      const token = node.fillToken && doc.tokens[node.fillToken];
      content += path(
        s.gradient
          ? gradient(s.gradient, w, h)
          : token
            ? displayColor(token.value, doc.colorProfile)
            : s.fill,
        s.fillOpacity,
      );
    }
    const paint = node.image,
      asset = paint && doc.images?.[paint.assetId];
    if (paint && asset) {
      const area = imageViewport(s, w, h);
      if (area.width > 0 && area.height > 0) {
        const bitmap = svgImagePaint(
          paint,
          asset,
          area.width,
          area.height,
          id(),
        );
        if (area.width === w && area.height === h) content += clipped(bitmap);
        else {
          const contour = roundedContour(
            area.width,
            area.height,
            s,
            node.type === "ellipse",
          );
          const clip = define(
            "clipPath",
            {},
            "<path" + attrs({ d: contour }) + "/>",
          );
          content += `<g transform="translate(${area.x} ${area.y})"><g clip-path="url(#${clip})">${bitmap}</g></g>`;
        }
      }
    }
    if (boxPaint && !composed)
      for (const p of [...(s.paints ?? [])].reverse())
        if (p.visible)
          content += path(
            p.gradient ? gradient(p.gradient, w, h) : p.color,
            p.opacity,
          );
    const shadows =
      s.tint || whiteAdditiveHighlights(node)
        ? []
        : (s.shadows?.filter((v) => v.visible !== false) ?? []);
    const shadow = (effect: (typeof shadows)[number], scene?: string) => {
      const { spread, blur, x, y, color, opacity, inset } = effect;
      const morphology = spread
        ? `<feMorphology operator="${spread > 0 !== inset ? "dilate" : "erode"}" radius="${Math.abs(spread)}"/>`
        : "";
      const extent = {
        x: -Math.abs(x) - blur * 3 - Math.abs(spread),
        y: -Math.abs(y) - blur * 3 - Math.abs(spread),
        width: w + 2 * (Math.abs(x) + blur * 3 + Math.abs(spread)),
        height: h + 2 * (Math.abs(y) + blur * 3 + Math.abs(spread)),
      };
      const sub =
        effect.blendMode === "plus-darker" && scene
          ? subtractBlend(color)
          : undefined;
      const filter = define(
        "filter",
        { filterUnits: "userSpaceOnUse", ...extent },
        morphology +
          `<feGaussianBlur stdDeviation="${blur / 2}"/><feOffset dx="${x}" dy="${y}" result="offset"/>` +
          `<feComposite in="${inset ? "SourceAlpha" : "offset"}" in2="${inset ? "offset" : "SourceAlpha"}" operator="out" result="shadow"/>` +
          "<feFlood" +
          attrs({
            "flood-color": sub ? "white" : color,
            "flood-opacity": opacity,
          }) +
          '/><feComposite in2="shadow" operator="in"/>',
      );
      const silhouette = paintGlyphs
        ? svgText(
            { ...node, style: { ...s, color: "#000000", colorOpacity: 1 } },
            w,
            h,
          )
        : path("black");
      if (sub && scene) {
        const mask = define(
          "mask",
          { maskUnits: "userSpaceOnUse", "mask-type": "alpha", ...extent },
          `<g filter="url(#${filter})">${silhouette}</g>`,
        );
        const subtractFilter = define(
          "filter",
          {
            ...extent,
            filterUnits: "userSpaceOnUse",
            "color-interpolation-filters": "sRGB",
          },
          sub.primitives,
        );
        return `<g mask="url(#${mask})"><g filter="url(#${subtractFilter})">${use(scene)}</g></g>`;
      }
      const blend =
        effect.blendMode && effect.blendMode !== "pass-through"
          ? "mix-blend-mode:" + effect.blendMode
          : undefined;
      return (
        "<g" +
        attrs({ filter: `url(#${filter})`, style: blend }) +
        ">" +
        silhouette +
        "</g>"
      );
    };
    const effects = shadows.slice().reverse();
    let outset = "";
    for (const effect of effects.filter((s) => !s.inset)) {
      const base =
        effect.blendMode === "plus-darker" && outset
          ? define("g", {}, (behind ? use(behind) : "") + outset)
          : behind;
      outset += shadow(effect, base);
    }
    function insetShadows() {
      for (const effect of effects.filter((s) => s.inset)) {
        const base =
          effect.blendMode === "plus-darker"
            ? define("g", {}, (behind ? use(behind) : "") + outset + content)
            : undefined;
        content += shadow(effect, base);
      }
    }
    if (!paintGlyphs) insetShadows();
    const strokeLayers = s.strokePaints?.length
      ? s.strokePaints
          .filter((p) => p.visible)
          .slice()
          .reverse()
      : [
          {
            color: s.stroke ?? s.color,
            opacity: s.strokeOpacity ?? 1,
            blendMode: strokeBlend,
            gradient: undefined,
          },
        ];
    for (const paint of strokeLayers) {
      const artwork = strokeArtwork(
        s,
        w,
        h,
        xml(paint.gradient ? gradient(paint.gradient, w, h) : paint.color),
        node.type === "ellipse",
        id() + "-",
      );
      if (artwork.body) {
        const mode = paint.blendMode;
        // Firefox isolates nested SVG paint groups when rasterizing a selected
        // frame. Blend an opaque source against the same local backdrop before
        // masking it with the stroke coverage and the paint's own alpha.
        const subtract =
          mode === "plus-darker" && !paint.gradient
            ? subtractBlend(paint.color)
            : undefined;
        const isolated =
          s.strokePaints?.length &&
          !paint.gradient &&
          mode &&
          mode !== "normal" &&
          mode !== "pass-through" &&
          mode !== "plus-darker";
        if ((subtract || isolated) && (behind || content)) {
          const [top, right, bottom, left] = artwork.outset;
          const region = {
            x: -left,
            y: -top,
            width: w + left + right,
            height: h + top + bottom,
          };
          const filter =
            subtract &&
            define(
              "filter",
              {
                ...region,
                filterUnits: "userSpaceOnUse",
                "color-interpolation-filters": "sRGB",
              },
              subtract.primitives,
            );
          const mask = define(
            "mask",
            { ...region, maskUnits: "userSpaceOnUse", "mask-type": "alpha" },
            strokeArtwork(s, w, h, "white", node.type === "ellipse", id() + "-")
              .body,
          );
          const scene = define(
            "g",
            {},
            (behind ? use(behind) : "") + outset + content,
          );
          const blended = filter
            ? `<g filter="url(#${filter})">${use(scene)}</g>`
            : `<g style="isolation:isolate">${use(scene)}<rect${attrs({ ...region, fill: paint.color, style: "mix-blend-mode:" + mode })}/></g>`;
          content += `<g opacity="${paint.opacity}" mask="url(#${mask})">${blended}</g>`;
        } else {
          const style =
            paint.blendMode && paint.blendMode !== "pass-through"
              ? "mix-blend-mode:" + paint.blendMode
              : undefined;
          content +=
            "<g" +
            attrs({ opacity: paint.opacity, style }) +
            ">" +
            artwork.body +
            "</g>";
        }
      }
    }
    const drawing = node.booleanOperation
      ? booleanVector(doc, raw)
      : node.vector;
    if (drawing) {
      let vectorSurface = "";
      if (drawing.fillFromStyle) {
        const maskPaths = drawing.paths
          .filter((p) => p.fill && !p.fillColor)
          .map(
            (p) =>
              "<path" +
              attrs({
                d: p.d,
                fill: "white",
                "fill-rule": p.fillRule,
                opacity: (p.fillOpacity ?? 1) * (p.opacity ?? 1),
              }) +
              "/>",
          )
          .join("");
        const mask = define(
          "mask",
          {
            maskUnits: "userSpaceOnUse",
            x: 0,
            y: 0,
            width: drawing.width,
            height: drawing.height,
          },
          maskPaths,
        );
        const pigment = (fill: string, opacity: number, mode?: string) =>
          "<rect" +
          attrs({
            width: drawing.width,
            height: drawing.height,
            fill,
            opacity,
            style:
              mode && mode !== "normal" && mode !== "pass-through"
                ? "mix-blend-mode:" + mode
                : undefined,
          }) +
          "/>";
        const paint = solidBlendPaint(visibleNode);
        const base = paint
          ? pigment(displayColor(paint.color, doc.colorProfile), paint.opacity)
          : pigment(
              s.gradient
                ? gradient(s.gradient, drawing.width, drawing.height)
                : s.fill,
              s.fillOpacity ?? 1,
            ) +
            [...(s.paints ?? [])]
              .reverse()
              .filter((p) => p.visible)
              .map((p) =>
                pigment(
                  p.gradient
                    ? gradient(p.gradient, drawing.width, drawing.height)
                    : p.color,
                  p.opacity,
                  p.blendMode,
                ),
              )
              .join("");
        vectorSurface = `<g mask="url(#${mask})">${base}</g>`;
      }
      content +=
        "<svg" +
        attrs({
          width: w || drawing.width,
          height: h || drawing.height,
          viewBox: `0 0 ${drawing.width} ${drawing.height}`,
          preserveAspectRatio: drawing.stretch ? "none" : undefined,
          overflow: drawing.overflowVisible ? "visible" : undefined,
        }) +
        ">" +
        vectorSurface +
        drawing.paths
          .map(
            (p) =>
              "<path" +
              attrs({
                d: p.d,
                fill: p.fill
                  ? (p.fillColor ?? (drawing.fillFromStyle ? "none" : s.color))
                  : "none",
                "fill-rule": p.fillRule,
                "fill-opacity": p.fillOpacity ?? s.colorOpacity,
                stroke:
                  s.strokeVisible !== false && p.strokeWidth
                    ? (p.strokeColor ?? s.color)
                    : "none",
                "stroke-width": p.strokeWidth,
                "stroke-dasharray": s.strokeDash,
                "stroke-opacity": p.strokeOpacity ?? s.colorOpacity,
                "stroke-linecap": p.lineCap ?? "round",
                "stroke-linejoin": p.lineJoin ?? "round",
                opacity: p.opacity,
              }) +
              "/>",
          )
          .join("") +
        "</svg>";
    }
    if (node.text) {
      for (const family of [
        s.fontFamily,
        ...(node.textRuns ?? []).map((r) => r.style.fontFamily),
      ])
        for (const id of family?.match(/font-[a-f0-9]{64}/g) ?? [])
          usedFonts.add(id);
      const t = svgText(node, w, h);
      if (glyphClip && textSubtract !== undefined && behind) {
        const base = define("g", {}, use(behind) + content);
        const filter = define(
          "filter",
          {
            "color-interpolation-filters": "sRGB",
            filterUnits: "userSpaceOnUse",
            x: 0,
            y: 0,
            width: w,
            height: h,
          },
          textSubtract.primitives,
        );
        content += `<g opacity="${s.colorOpacity ?? 1}" clip-path="url(#${glyphClip})"><g filter="url(#${filter})">${use(base)}</g></g>`;
      } else if (glyphClip && inkPaints && textSubtract === undefined) {
        const layers = [
          {
            color: s.fill,
            gradient: s.gradient,
            opacity: s.fillOpacity ?? 1,
            blendMode: s.fillBlendMode,
          },
          ...(s.paints ?? [])
            .filter((p) => p.visible)
            .slice()
            .reverse(),
        ];
        for (const layer of layers) {
          const ink = path(
            layer.gradient ? gradient(layer.gradient, w, h) : layer.color,
            layer.opacity,
          );
          content +=
            "<g" +
            attrs({
              "clip-path": `url(#${glyphClip})`,
              style:
                layer.blendMode && layer.blendMode !== "pass-through"
                  ? "mix-blend-mode:" + layer.blendMode
                  : undefined,
            }) +
            ">" +
            ink +
            "</g>";
        }
      } else content += s.maxLines ? clipped(t) : t;
      if (paintGlyphs) insetShadows();
    }
    let nested = "",
      scene = needsBackdrop
        ? define("g", {}, (behind ? use(behind) : "") + content)
        : undefined;
    const descendants = children.get(node.id) ?? [];
    const paintChildren = s.firstChildOnTop
      ? descendants.slice().reverse()
      : descendants;
    let siblingMask = "",
      inside = "",
      below = scene;
    function finishMask() {
      if (!siblingMask) return;
      let range = `<g mask="url(#${siblingMask})">${inside}</g>`;
      if (below) {
        range = use(define("g", {}, range));
        scene = define("g", {}, use(below) + range);
      }
      nested += range;
      inside = "";
      siblingMask = "";
    }
    if (!node.booleanOperation)
      for (const child of paintChildren) {
        if (child.id === node.maskSourceId || child.type === "slice") continue;
        if (child.siblingMask) {
          finishMask();
          below = scene;
          if (!child.hidden) {
            let art = render(child, box);
            if (child.siblingMask === "vector") {
              const clip = vectorClipPath(doc, child),
                start = clip.indexOf('"');
              art =
                start < 0
                  ? ""
                  : "<path" +
                    attrs({
                      d: JSON.parse(clip.slice(start, -1)),
                      fill: "white",
                      "fill-rule": clip.includes("evenodd,")
                        ? "evenodd"
                        : undefined,
                    }) +
                    "/>";
            }
            siblingMask = define(
              "mask",
              {
                "mask-type":
                  child.siblingMask === "luminance" ? "luminance" : "alpha",
                maskUnits: "userSpaceOnUse",
                x: 0,
                y: 0,
                width: w,
                height: h,
              },
              art,
            );
          }
          continue;
        }
        if (child.hidden) continue;
        let painted = render(child, box, scene);
        if (scene) {
          painted = use(define("g", {}, painted));
          scene = define("g", {}, use(scene) + painted);
        }
        if (siblingMask) inside += painted;
        else nested += painted;
      }
    finishMask();
    if (node.maskSourceId) {
      const mask = (children.get(node.id) ?? []).find(
        (n) => n.id === node.maskSourceId,
      );
      if (mask && !mask.hidden) {
        if (node.maskType === "alpha" || node.maskType === "luminance") {
          const key = define(
            "mask",
            {
              "mask-type": node.maskType,
              maskUnits: "userSpaceOnUse",
              x: 0,
              y: 0,
              width: w,
              height: h,
            },
            bitmapMaskArtwork(mask, doc, id()),
          );
          nested = `<g mask="url(#${key})">${nested}</g>`;
        } else {
          const clip = maskClip(doc, raw);
          const start = clip.indexOf('"');
          if (start >= 0) {
            const d = JSON.parse(clip.slice(start, -1));
            const key = define(
              "clipPath",
              {},
              "<path" +
                attrs({
                  d,
                  "clip-rule": clip.includes("evenodd,")
                    ? "evenodd"
                    : undefined,
                }) +
                "/>",
            );
            nested = `<g clip-path="url(#${key})">${nested}</g>`;
          } else nested = "";
        }
      }
    }
    const hasScroll = nodeInteractions(raw).some((r) => r.scroll);
    content += s.clipContent || hasScroll ? clipped(nested) : nested;
    content = outset + content;
    if (s.tint) {
      const tint = define(
        "filter",
        {
          x: "-100%",
          y: "-100%",
          width: "300%",
          height: "300%",
          "color-interpolation-filters": "sRGB",
        },
        tintPrimitives(s),
      );
      content = `<g filter="url(#${tint})">${content}</g>`;
    }
    const blur =
      s.blur && s.blurVisible !== false
        ? define(
            "filter",
            { x: "-100%", y: "-100%", width: "300%", height: "300%" },
            `<feGaussianBlur stdDeviation="${s.blur}"/>`,
          )
        : undefined;
    return (
      "<g" +
      attrs({
        transform: matrix(m),
        opacity: s.opacity,
        filter: blur ? `url(#${blur})` : undefined,
        style:
          !layerInk &&
          !(strokeBlend && !s.strokeBlendMode && s.fillOpacity === 0) &&
          s.blendMode &&
          s.blendMode !== "pass-through" &&
          textSubtract === undefined
            ? "mix-blend-mode:" + s.blendMode
            : subtract === undefined &&
                !composed &&
                !inkPaints &&
                s.fillBlendMode &&
                s.fillBlendMode !== "pass-through"
              ? "mix-blend-mode:" + s.fillBlendMode
              : undefined,
      }) +
      ">" +
      content +
      "</g>"
    );
  }
  // Keep ink outside the layout box in the export, including shadows on a
  // selected leaf and overflowing children of an unclipped frame.
  function paintedBounds(n: DesignNode): Rect {
    const rect = bounds.get(n.id)!,
      s = n.style;
    const box = { x: 0, y: 0, width: rect.width, height: rect.height };
    let ink = box;
    if (!n.hidden) {
      const outside =
        s.strokeVisible === false
          ? 0
          : s.strokeAlign === "outside"
            ? 1
            : s.strokeAlign === "center"
              ? 0.5
              : 0;
      const vectorBleed =
        n.vector?.overflowVisible && s.strokeVisible !== false
          ? (Math.max(0, ...n.vector.paths.map((p) => p.strokeWidth)) / 2) *
            Math.max(rect.width / n.vector.width, rect.height / n.vector.height)
          : 0;
      const edge = (side: "left" | "right" | "top" | "bottom") =>
        Math.max(
          vectorBleed,
          (s.strokeSides?.[side] ?? s.strokeWidth ?? 0) * outside,
        );
      const painted: Rect[] = [
        {
          x: -edge("left"),
          y: -edge("top"),
          width: rect.width + edge("left") + edge("right"),
          height: rect.height + edge("top") + edge("bottom"),
        },
      ];
      if (
        !s.clipContent &&
        !n.booleanOperation &&
        !n.maskSourceId &&
        !nodeInteractions(n).some((r) => r.scroll)
      ) {
        for (const child of children.get(n.id) ?? [])
          if (!child.hidden && child.type !== "slice")
            painted.push(paintedBounds(child));
      }
      for (const effect of s.shadows ?? []) {
        if (effect.visible === false || effect.inset || !effect.opacity)
          continue;
        const spread = 1.5 * effect.blur + effect.spread;
        painted.push({
          x: effect.x - spread,
          y: effect.y - spread,
          width: Math.max(0, rect.width + 2 * spread),
          height: Math.max(0, rect.height + 2 * spread),
        });
      }
      ink = union(painted)!;
      const bleed = s.blurVisible !== false ? (s.blur ?? 0) * 3 : 0;
      ink = {
        x: ink.x - bleed,
        y: ink.y - bleed,
        width: ink.width + 2 * bleed,
        height: ink.height + 2 * bleed,
      };
    }
    const parent = n.parentId && bounds.get(n.parentId);
    const transformed = visualBounds(ink, localTransform(n, box));
    return {
      ...transformed,
      x: transformed.x + (n === root ? 0 : rect.x - (parent ? parent.x : 0)),
      y: transformed.y + (n === root ? 0 : rect.y - (parent ? parent.y : 0)),
    };
  }
  let extent: Rect;
  let body: string;
  if (root.type === "slice") {
    extent = { x: 0, y: 0, width: rootBox.width, height: rootBox.height };
    const clip = define(
      "clipPath",
      {},
      `<rect width="${rootBox.width}" height="${rootBox.height}"/>`,
    );
    const sceneBody = doc.nodes
      .filter((n) => !n.parentId && n.type !== "slice" && !n.hidden)
      .map((n) => render(n, rootBox))
      .join("");
    body = `<g clip-path="url(#${clip})">${sceneBody}</g>`;
  } else {
    extent = paintedBounds(root);
    body = render(root, {
      ...rootBox,
      x: rootBox.x + extent.x,
      y: rootBox.y + extent.y,
    });
  }
  const safeScale = Math.max(0.1, scale);
  const fonts = Object.entries(doc.fonts ?? {})
    .filter(([id]) => usedFonts.has(id))
    .map(([id, font]) => {
      const weight = fontFaceWeight(font);
      return `@font-face{font-family:"${id}";src:url("${font.data}");${weight ? `font-weight:${weight};` : ""}${font.italic ? "font-style:italic;" : ""}}`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${extent.width * safeScale}" height="${extent.height * safeScale}" viewBox="0 0 ${extent.width} ${extent.height}"><title>${xml(root.name)}</title><defs>${fonts ? "<style>" + xml(fonts) + "</style>" : ""}${defs.join("")}</defs>${body}</svg>`;
  return { svg, width: extent.width, height: extent.height };
}
const maskCache = new WeakMap<
  DesignDocument,
  Map<string, NonNullable<RuntimeNode["siblingMask"]>>
>();
/** Keep the source and all masked siblings in their authored parent and paint order. */
export function siblingMaskPaint(
  doc: DesignDocument,
  parent: DesignNode,
  source: DesignNode,
  symbolic = false,
): RuntimeNode["siblingMask"] {
  if (!source.siblingMask) return;
  let cache = maskCache.get(doc);
  if (!cache) {
    cache = new Map();
    maskCache.set(doc, cache);
  }
  const key = source.id + (symbolic ? "-symbolic" : "-live");
  const old = cache.get(key);
  if (old) return old;
  const n = resolveNode(doc, source);
  if (n.hidden) return { style: {} };
  const m = n.siblingMask!;
  let result: NonNullable<RuntimeNode["siblingMask"]>;
  if (m === "vector") result = { style: { clipPath: vectorClipPath(doc, n) } };
  else if (
    n.image &&
    !n.style.rotation &&
    !n.style.flipX &&
    !n.style.flipY &&
    !n.style.radius &&
    !n.style.corners &&
    n.style.x === 0 &&
    n.style.y === 0 &&
    n.style.width === parent.style.width &&
    n.style.height === parent.style.height &&
    (n.image.zoom ?? 1) === 1 &&
    !n.image.rotation &&
    (n.image.fit === "cover" || n.image.fit === "contain") &&
    (n.style.opacity ?? 1) === 1 &&
    (n.image.opacity ?? 1) === 1 &&
    !n.style.gradient &&
    !n.style.paints?.length &&
    !(n.style.fillOpacity ?? 0)
  ) {
    result = {
      assetId: n.image.assetId,
      source: symbolic ? undefined : doc.images?.[n.image.assetId]?.data,
      style: {
        maskSize: n.image.fit,
        maskPosition: `${n.image.x}% ${n.image.y}%`,
        maskRepeat: "no-repeat",
        maskMode: m,
      },
    };
  } else {
    const wrapper = createNode("frame");
    wrapper.id = "mask-view-" + source.id;
    wrapper.style = {
      ...wrapper.style,
      x: 0,
      y: 0,
      width: parent.style.width,
      height: parent.style.height,
      fillOpacity: 0,
      padding: 0,
      layout: "free",
      radius: 0,
      clipContent: true,
    };
    const nodes: DesignNode[] = [
      wrapper,
      { ...n, siblingMask: undefined, parentId: wrapper.id },
    ];
    const queue = [n.id];
    for (let i = 0; i < queue.length; i++)
      for (const child of childrenOf(doc, queue[i])) {
        nodes.push(resolveNode(doc, child));
        queue.push(child.id);
      }
    const svg = svgAsset(
      { ...doc, designSystem: undefined, nodes },
      wrapper.id,
    ).svg;
    result = {
      style: {
        maskImage: 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")',
        maskSize: "100% 100%",
        maskRepeat: "no-repeat",
        maskMode: m,
      },
    };
  }
  cache.set(key, result);
  return result;
}
export function exportNodeToSvg(
  doc: DesignDocument,
  nodeId: string,
  scale: Scale = 1,
): string {
  return svgAsset(doc, nodeId, scale).svg;
}
