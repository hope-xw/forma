import {
  maxGradientStops,
  maxLayerDimension,
} from "../../domain/document-limits";
import { limitedText } from "./types";
import {
  defaultStyle,
  type DesignNode,
  type NodeStyle,
} from "../../domain/node";
import type { InlineStyle } from "../../domain/rich-text";
import {
  alpha,
  bounded,
  rotation,
  array,
  color,
  number,
  object,
  point,
  string,
  type Fields,
  type Layer,
  type Warn,
} from "./sketch-source";

export interface SketchFontContext {
  families: ReadonlyMap<string, string>;
  instances?: ReadonlyMap<string, Record<string, number>>;
  tracking?: ReadonlyMap<string, (size: number) => number>;
}
// CoreText type and selector pairs, from SFNTLayoutTypes.h, mapped to OpenType tags.
function fontFeatures(source: unknown) {
  const features = new Map<string, number>();
  for (const f of array(source)) {
    const type = number(f.CTFeatureTypeIdentifier, -1),
      selector = number(f.CTFeatureSelectorIdentifier, -1);
    let tag: string | undefined;
    let enabled = selector % 2 === 0 ? 1 : 0;
    if (type === 35 && selector >= 2 && selector <= 41)
      tag = "ss" + String(Math.floor(selector / 2)).padStart(2, "0");
    if (type === 33) tag = ["case", "case", "cpsp", "cpsp"][selector];
    if (type === 36)
      tag = ["calt", "calt", "swsh", "swsh", "cswh", "cswh"][selector];
    if (type === 37 || type === 38) {
      tag = (type === 37 ? ["", "smcp", "pcap"] : ["", "c2sc", "c2pc"])[
        selector
      ];
      enabled = 1;
    }
    if (tag) features.set(tag, enabled);
  }
  return (
    [...features].map(([tag, value]) => '"' + tag + '" ' + value).join(", ") ||
    undefined
  );
}
export function fontAttributes(
  a: Fields,
  fontContext?: SketchFontContext,
  warn?: (msg: string) => void,
): Partial<NodeStyle> {
  const f = object(object(a.MSAttributedStringFontAttribute).attributes);
  const name = string(f.name);
  const para = object(a.paragraphStyle);
  const style: Partial<NodeStyle> = {};
  if (name) {
    // PostScript face names may be absent from the CSS family list. Keep the original
    // first, then its family and the platform fallback used to measure text.
    const family = name
      .replace(/[-,].*$/, "")
      .replace(/^\.?SF(?=[A-Z])/, "SF ")
      .replace(/([a-z])([A-Z])/g, "$1 $2");
    const system = /^\.?SF(?:Pro|Compact|UI)/.test(name);
    const safe = (v: string) => JSON.stringify(v);
    style.fontFamily =
      fontContext?.families.get(name) ??
      (system
        ? safe(name) +
          ", " +
          safe(family) +
          ", -apple-system, BlinkMacSystemFont, sans-serif"
        : family === name
          ? name
          : safe(name) + ", " + safe(family));
    style.fontFamily = limitedText(style.fontFamily, 200, warn, "字体名称");
    const weight = /black/i.test(name)
      ? 900
      : /extra.?bold|heavy/i.test(name)
        ? 800
        : /semi.?bold|demi/i.test(name)
          ? 600
          : /bold/i.test(name)
            ? 700
            : /medium/i.test(name)
              ? 500
              : /ultra.?light/i.test(name)
                ? 200
                : /thin/i.test(name)
                  ? 100
                  : /light/i.test(name)
                    ? 300
                    : 400;
    const axes = fontContext?.instances?.get(name);
    style.fontWeight = Math.min(
      900,
      Math.max(100, Math.round(axes?.wght ?? weight)),
    );
    if (axes) {
      const settings = Object.entries(axes).filter(
        ([tag, v]) =>
          tag !== "opsz" &&
          (tag !== "wght" || Math.abs(v - style.fontWeight!) > 0.5) &&
          (tag !== "wdth" || v !== 100),
      );
      if (settings.length) {
        let value = "";
        for (const [tag, axis] of settings) {
          const entry = JSON.stringify(tag) + " " + axis;
          const next = value ? value + ", " + entry : entry;
          if (next.length > 512) {
            warn?.("可变字体轴设置超过 512 字符，已截短");
            break;
          }
          value = next;
        }
        style.fontVariationSettings = value;
      }
    }
    style.fontStyle = /italic|oblique/i.test(name) ? "italic" : "normal";
  }
  if (a.MSAttributedStringTextTransformAttribute !== undefined)
    style.textTransform = (["none", "uppercase", "lowercase"] as const)[
      number(a.MSAttributedStringTextTransformAttribute)
    ];
  const features = fontFeatures(f.featureSettings);
  if (features) style.fontFeatureSettings = features;
  if (typeof f.size === "number")
    style.fontSize = bounded(f.size, 1, 500, warn, "字号");
  if (a.MSAttributedStringColorAttribute) {
    style.color = color(a.MSAttributedStringColorAttribute);
    style.colorOpacity = alpha(a.MSAttributedStringColorAttribute, warn);
  }
  if (typeof a.kerning === "number") style.letterSpacing = a.kerning;
  if (fontContext?.tracking && style.fontFamily && style.fontSize) {
    const track = fontContext.tracking.get(style.fontFamily);
    if (track)
      style.letterSpacing = (style.letterSpacing ?? 0) + track(style.fontSize);
  }
  if (style.letterSpacing !== undefined)
    style.letterSpacing = bounded(style.letterSpacing, -50, 200, warn, "字距");
  if (typeof para.alignment === "number")
    style.textAlign = (["left", "right", "center", "justify", "left"] as const)[
      para.alignment
    ];
  if (number(para.maximumLineHeight) !== 0)
    style.lineHeight = bounded(
      number(para.maximumLineHeight),
      1,
      1000,
      warn,
      "行高",
    );
  if (number(a.underlineStyle) > 0) style.textDecoration = "underline";
  if (number(a.strikethroughStyle) > 0) style.textDecoration = "line-through";
  return style;
}
export function textContent(
  layer: Layer,
  node: DesignNode,
  warn: Warn,
  fontContext?: SketchFontContext,
) {
  const att = object(layer.attributedString);
  if (typeof att.string !== "string")
    throw Error("Sketch 文本缺少可读字符串：" + layer.name);
  const report = (msg: string) => warn(node.id, msg);
  node.text = limitedText(att.string, 50000, report);
  node.style.fontSmoothing = "antialiased";
  const runs = array(att.attributes);
  if (
    runs.some(
      (r, i) => i > 0 && number(r.location) < number(runs[i - 1].location),
    )
  ) {
    runs.sort((a, b) => number(a.location) - number(b.location));
    report("文本样式区间已按起点排序");
  }
  const base = object(object(object(layer.style).textStyle).encodedAttributes);
  Object.assign(
    node.style,
    fontAttributes(base, fontContext, report),
    fontAttributes(object(runs[0]?.attributes), fontContext, report),
  );
  // Inline runs can apply italics and decorations. Keep the base neutral when a run explicitly clears one.
  const mixedStyles = runs.map((r) =>
    fontAttributes(object(r.attributes), fontContext, report),
  );
  if (
    mixedStyles.some((s) => s.fontStyle === "normal") &&
    mixedStyles.some((s) => s.fontStyle === "italic")
  )
    node.style.fontStyle = "normal";
  if (new Set(mixedStyles.map((s) => s.textDecoration ?? "none")).size > 1)
    node.style.textDecoration = "none";
  if (typeof layer.textBehaviour === "number") {
    if (layer.textBehaviour === 0) node.style.widthMode = "hug";
    if (layer.textBehaviour === 0 || layer.textBehaviour === 1)
      node.style.heightMode = "hug";
    if (!node.style.lineHeight && layer.textBehaviour === 0)
      node.style.lineHeight = Math.max(
        1,
        Math.min(
          layer.frame.height / node.text.split("\n").length,
          Math.round(node.style.fontSize * 1.22),
        ),
      );
    if (!node.style.lineHeight && layer.textBehaviour === 1)
      node.style.lineHeight = node.style.fontSize * 1.2;
  }
  if (!node.style.lineHeight && layer.verticalSizing === 1) {
    const lines = node.text.split(/\r\n|\r|\n/).length;
    const sourceLine = layer.frame.height / lines;
    // Fit-width text does not soft-wrap. For fixed-width text only trust its stored
    // line box when its height excludes an additional line of this face.
    if (
      sourceLine >= 1 &&
      sourceLine <= 1000 &&
      (layer.horizontalSizing === 1 || sourceLine <= node.style.fontSize * 1.6)
    )
      node.style.lineHeight = sourceLine;
  }
  const vertical = number(
    object(object(layer.style).textStyle).verticalAlignment,
  );
  node.style.verticalAlign = (["top", "middle", "bottom"] as const)[vertical];
  let lastEnd = 0,
    runCount = 0;
  node.textRuns = runs.flatMap((r, index) => {
    const style = mixedStyles[index];
    const inline: InlineStyle = {};
    for (const k of [
      "fontWeight",
      "fontFamily",
      "fontSize",
      "fontFeatureSettings",
      "fontVariationSettings",
      "letterSpacing",
      "color",
    ] as const)
      if (style[k] !== undefined && style[k] !== node.style[k])
        Object.assign(inline, { [k]: style[k] });
    if (style.fontStyle === "italic" && node.style.fontStyle !== "italic")
      inline.fontStyle = "italic";
    if (
      style.textDecoration &&
      style.textDecoration !== "none" &&
      style.textDecoration !== node.style.textDecoration
    )
      inline.textDecoration = style.textDecoration;
    if (
      (style.fontStyle === "normal" && node.style.fontStyle === "italic") ||
      (style.colorOpacity !== undefined &&
        style.colorOpacity !== node.style.colorOpacity) ||
      (style.lineHeight !== undefined &&
        style.lineHeight !== node.style.lineHeight)
    )
      warn(node.id, "段内透明度、正体或行高差异需要复核");
    const location = r.location,
      length = r.length;
    if (
      typeof location !== "number" ||
      typeof length !== "number" ||
      !Number.isInteger(location) ||
      !Number.isInteger(location + length) ||
      length < 0
    ) {
      report("无效的文本样式区间已跳过");
      return [];
    }
    const start = Math.max(lastEnd, 0, location),
      end = Math.min(node.text.length, location + length);
    if (start !== location || end !== location + length)
      report("文本样式区间重叠或越界，已裁剪");
    if (end <= start) return [];
    lastEnd = end;
    if (!Object.keys(inline).length) return [];
    if (++runCount > 10000) {
      report("段内样式超过 10000 项，已截短");
      return [];
    }
    return [{ start, end, style: inline }];
  });
  if (!node.textRuns.length) delete node.textRuns;
}
export const sketchBlendModes: NonNullable<NodeStyle["blendMode"]>[] = [
  "normal",
  "darken",
  "multiply",
  "color-burn",
  "lighten",
  "screen",
  "color-dodge",
  "overlay",
  "soft-light",
  "hard-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "plus-darker",
  "plus-lighter",
];
/** Background fills sit below the layer’s regular paints. Keep the archive indexes for Symbol overrides. */
export function orderedFills(source: Fields) {
  return array(source.fills)
    .map((fill, index) => ({ fill, index }))
    .filter(({ fill }) => fill.layeringType !== 1)
    .sort(
      (a, b) =>
        Number(b.fill.layeringType === 2) - Number(a.fill.layeringType === 2),
    );
}
export function appearance(
  source: Fields,
  warn: (msg: string) => void,
  fontContext?: SketchFontContext,
): Partial<NodeStyle> {
  const result: Partial<NodeStyle> = {};
  const context = object(source.contextSettings);
  if (typeof context.opacity === "number")
    result.opacity = bounded(context.opacity, 0, 1, warn, "图层透明度");
  if (number(context.blendMode)) {
    result.blendMode = sketchBlendModes[number(context.blendMode)];
    if (!result.blendMode) warn("未支持的图层混合模式");
    if (result.blendMode === "plus-darker")
      warn("Plus Darker 图层混合需在目标浏览器核对");
  }
  const tints = array(source.fills).filter(
    (f) => f.layeringType === 1 && f.isEnabled !== false,
  );
  const tint = tints.at(-1);
  if (tint) {
    result.tint = {
      color: color(tint.color),
      opacity:
        alpha(tint.color, warn) *
        bounded(
          number(object(tint.contextSettings).opacity, 1),
          0,
          1,
          warn,
          "绘制透明度",
        ),
    };
    if (
      tints.length > 1 ||
      number(tint.fillType) ||
      number(object(tint.contextSettings).blendMode)
    )
      warn("复杂叠色使用顶层着色，混合需复核");
    if (object(tint.color).swatchID) warn("整体着色保留当前色变量值");
  }
  const fills = orderedFills(source);
  const paints: NonNullable<NodeStyle["paints"]> = [];
  for (const { index, fill: f } of fills) {
    const paint: NonNullable<NodeStyle["paints"]>[number] = {
      id: "p" + index,
      visible: f.isEnabled !== false,
      color: color(f.color),
      opacity:
        alpha(f.color, warn) *
        bounded(
          number(object(f.contextSettings).opacity, 1),
          0,
          1,
          warn,
          "绘制透明度",
        ),
    };
    if (number(f.fillType) === 1) {
      const g = object(f.gradient);
      const type = (["linear", "radial", "angular"] as const)[
        number(g.gradientType)
      ];
      if (!type) {
        warn("未支持的渐变类型");
        continue;
      }
      const stops = array(g.stops);
      if (stops.length < 2) {
        warn("渐变少于两个色标，已跳过");
        continue;
      }
      if (stops.length > maxGradientStops) warn("渐变色标超过 64 项，已截短");
      let start, end;
      try {
        start = point(g.from);
        end = point(g.to);
      } catch {
        warn("渐变端点无效，已跳过");
        continue;
      }
      const angle =
        ((Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI + 450) %
        360;
      paint.gradient = {
        type,
        angle,
        stops: stops.slice(0, maxGradientStops).map((stop) => ({
          offset: bounded(number(stop.position), 0, 1, warn, "渐变色标位置"),
          color: color(stop.color),
          opacity: alpha(stop.color, warn),
          ...(typeof object(stop.color).swatchID === "string"
            ? { variableId: string(object(stop.color).swatchID) }
            : {}),
        })),
      };
      if (
        type !== "linear" ||
        Math.abs((start.x + end.x) / 2 - 0.5) > 0.001 ||
        Math.abs((start.y + end.y) / 2 - 0.5) > 0.001
      )
        warn("渐变中心或范围需与原稿对照");
    } else if (number(f.fillType) === 4) {
      if (paints.length) warn("图片下方还有填充，透明区域需核对");
      paint.opacity = 0;
    } else if (number(f.fillType) !== 0) {
      if (f.isEnabled !== false && number(f.fillType) !== 4)
        warn("不支持的填充类型 " + String(f.fillType));
      continue;
    }
    const blend = number(object(f.contextSettings).blendMode);
    if (blend && sketchBlendModes[blend])
      paint.blendMode = sketchBlendModes[blend];
    else if (blend && paint.visible) warn("未知的填充混合模式：" + blend);
    paints.push(paint);
  }
  if (paints.length > 17) {
    paints.splice(0, paints.length - 17);
    warn("额外填充超过 16 层，已保留顶层填充");
  }
  const top = paints[0];
  const editOnly = new Set(
    fills.filter((p) => p.fill.layeringType === 2).map((p) => "p" + p.index),
  );
  if (editOnly.size) {
    result.sketchCanvasPaints = paints
      .filter((p) => editOnly.has(p.id))
      .map((p) => (p === top ? "base" : p.id));
    const visibleImage = fills
      .filter((p) => p.fill.fillType === 4 && p.fill.isEnabled !== false)
      .at(-1);
    if (visibleImage?.fill.layeringType === 2)
      result.sketchCanvasPaints.push("image");
  }
  if (top?.blendMode) result.fillBlendMode = top.blendMode;
  result.fill = top?.color ?? "#000000";
  result.fillOpacity = top?.visible ? top.opacity : 0;
  if (top?.gradient) result.gradient = top.gradient;
  if (paints.length > 1) result.paints = paints.slice(1).reverse();
  const borders = array(source.borders).filter((b) => b.isEnabled !== false);
  if (borders.length > 1) warn("多重描边仅映射最上方启用的描边");
  const b = borders.at(-1);
  if (b) {
    if (number(b.fillType)) warn("渐变描边需复核");
    result.stroke = color(b.color);
    result.strokeOpacity = alpha(b.color, warn);
    result.strokeAlign = (["center", "inside", "outside"] as const)[
      number(b.position)
    ];
    result.strokeWidth = bounded(
      number(b.thickness, 1),
      0,
      100,
      warn,
      "描边宽度",
    );
    const dash = object(source.borderOptions).dashPattern;
    if (Array.isArray(dash) && dash.length) {
      result.strokeDash = dash.map((d) => number(d)).join(" ");
      result.strokeStyle = "dashed";
    }
  }
  const shadows = [
    ...array(source.shadows).map((s) => [s, s.isInnerShadow === true] as const),
    ...array(source.innerShadows).map((s) => [s, true] as const),
  ];
  if (shadows.some(([s]) => number(object(s.contextSettings).blendMode)))
    warn("阴影含独立混合模式，需核对目标浏览器的合成外观");
  if (shadows.length > 32) warn("阴影超过 32 项，已截短");
  if (shadows.length)
    result.shadows = shadows.slice(0, 32).map(([s, inset]) => ({
      inset,
      visible: s.isEnabled !== false,
      ...(number(object(s.contextSettings).blendMode) &&
      sketchBlendModes[number(object(s.contextSettings).blendMode)]
        ? {
            blendMode:
              sketchBlendModes[number(object(s.contextSettings).blendMode)],
          }
        : {}),
      x: bounded(number(s.offsetX), -1000, 1000, warn, "阴影参数"),
      y: bounded(number(s.offsetY), -1000, 1000, warn, "阴影参数"),
      spread: bounded(number(s.spread), -1000, 1000, warn, "阴影参数"),
      blur: bounded(number(s.blurRadius), 0, 1000, warn, "阴影参数"),
      color: color(s.color),
      opacity:
        alpha(s.color, warn) *
        bounded(
          number(object(s.contextSettings).opacity, 1),
          0,
          1,
          warn,
          "绘制透明度",
        ),
    }));
  const blurs = (
    Array.isArray(source.blurs) ? array(source.blurs) : [object(source.blur)]
  ).filter((b) => b.isEnabled === true);
  const blurKinds = new Set<string>();
  for (const b of blurs) {
    const backdrop = b.type === 3 || b.type === 4;
    if (!backdrop && b.type !== 0) {
      warn("方向或缩放模糊缺少等价效果");
      continue;
    }
    const key = backdrop ? "backdropBlur" : "blur";
    if (blurKinds.has(key)) warn("同类模糊叠加只映射最后一项");
    blurKinds.add(key);
    result[key] = bounded(
      number(b.radius),
      0,
      backdrop ? 512 : 100,
      warn,
      "模糊半径",
    );
    if (backdrop) {
      if (typeof b.saturation === "number")
        result.backdropSaturation = bounded(
          b.saturation,
          0,
          4,
          warn,
          "背景饱和度",
        );
      if (typeof b.brightness === "number")
        result.backdropBrightness = bounded(
          b.brightness,
          0,
          4,
          warn,
          "背景亮度",
        );
    }
    if (b.type === 4) {
      result.sketchGlass = {
        depth: typeof b.depth === "number" ? b.depth : undefined,
        distortion: typeof b.distortion === "number" ? b.distortion : undefined,
        chromaticAberrationMultiplier:
          typeof b.chromaticAberrationMultiplier === "number"
            ? b.chromaticAberrationMultiplier
            : undefined,
        skipLightingEffects:
          typeof b.skipLightingEffects === "boolean"
            ? b.skipLightingEffects
            : undefined,
      };
      warn(
        "Liquid Glass 折射、色散及光照参数已保留，当前以背景模糊、色调和阴影近似显示",
      );
    }
    if (b.isProgressive) warn("渐进模糊保留峰值半径，渐变范围需复核");
  }
  if (source.textStyle)
    Object.assign(
      result,
      fontAttributes(
        object(object(source.textStyle).encodedAttributes),
        fontContext,
        warn,
      ),
    );
  return result;
}
export function makeLayer(
  l: Layer,
  warn: Warn,
  fontContext?: SketchFontContext,
): DesignNode {
  const classes: Record<string, DesignNode["type"]> = {
    artboard: "frame",
    symbolMaster: "frame",
    symbolInstance: "frame",
    group: "group",
    shapeGroup: "group",
    rectangle: "rectangle",
    oval: "ellipse",
    text: "text",
    slice: "slice",
    bitmap: "rectangle",
    shapePath: "vector",
    triangle: "vector",
    polygon: "vector",
    star: "vector",
  };
  const modernFrame =
    l._class === "group" &&
    (l.groupBehavior === 1 ||
      l.groupBehavior === 2 ||
      l.clippingBehavior === 1 ||
      object(l.groupLayout)._class === "MSImmutableFlexGroupLayout");
  const type = modernFrame ? "frame" : (classes[l._class] ?? "group");
  if (!Object.hasOwn(classes, l._class))
    warn(l.do_objectID, "图层类型 " + l._class + " 仅保留边界和子层");
  const { frame } = l;
  const report = (msg: string) => warn(l.do_objectID, msg);
  const node: DesignNode = {
    type,
    id: l.do_objectID,
    parentId: null,
    name: limitedText(l.name, 16384, report, "图层名"),
    text: "",
    hidden: l.isVisible === false,
    locked: l.isLocked === true,
    style: {
      ...defaultStyle,
      ...frame,
      width: bounded(
        Math.max(1, frame.width),
        1,
        maxLayerDimension,
        report,
        "图层宽度",
      ),
      height: bounded(
        Math.max(1, frame.height),
        1,
        maxLayerDimension,
        report,
        "图层高度",
      ),
      padding: 0,
      gap: 0,
      radius: 0,
      fillOpacity: 0,
      ...appearance(
        object(l.style),
        (msg) => warn(l.do_objectID, msg),
        fontContext,
      ),
    },
  };
  if (frame.height < 1 || frame.width < 1)
    warn(node.id, "小于 1 的图层边界以 1 作为命中范围，路径坐标保留");
  if (l.rotation) node.style.rotation = rotation(l, warn);
  if (l.isFlippedHorizontal) node.style.flipX = true;
  if (l.isFlippedVertical) node.style.flipY = true;
  if (l._class === "artboard" || l._class === "symbolMaster") {
    node.style.clipContent =
      l._class === "artboard" || l.clippingBehavior === 1;
    if (l.hasBackgroundColor) {
      node.style.fill = color(l.backgroundColor);
      node.style.fillOpacity = alpha(l.backgroundColor, report);
    }
  }
  if (
    l._class === "symbolMaster" &&
    l.groupBehavior !== undefined &&
    (typeof l.includeBackgroundColorInExport === "boolean" ||
      typeof l.includeBackgroundColorInInstance === "boolean")
  )
    node.style.sketchSymbolBackground = {
      inExport: l.includeBackgroundColorInExport !== false,
      inInstance: l.includeBackgroundColorInInstance !== false,
    };
  if (modernFrame) node.style.clipContent = l.clippingBehavior !== 2;
  if (l._class === "rectangle") {
    const physicalRadius = (r: number) => {
      if (r <= 1000) return bounded(r, 0, 10000, report, "圆角");
      const effective = Math.min(r, frame.width / 2, frame.height / 2);
      warn(node.id, "超大圆角按当前矩形实际可见半径映射");
      return Math.min(10000, effective);
    };
    const corners = array(l.points).map((p) =>
      physicalRadius(number(p.cornerRadius)),
    );
    if (corners.some(Boolean)) {
      node.style.radius = corners[0];
      if (corners.length === 4 && new Set(corners).size > 1)
        node.style.corners = {
          tl: corners[0],
          tr: corners[1],
          br: corners[2],
          bl: corners[3],
        };
    } else if (number(l.fixedRadius) !== 0)
      node.style.radius = physicalRadius(number(l.fixedRadius));
  }
  const corners = object(object(l.style).corners);
  if (
    (type === "frame" || type === "rectangle") &&
    Array.isArray(corners.radii) &&
    corners.radii.length
  ) {
    const radii = corners.radii.map((r) => {
      const value = number(r);
      if (value < 0 || value > 10000) report("圆角超出范围，已按实际边界限制");
      return value > 10000
        ? Math.min(
            10000,
            value,
            Math.max(0.5, frame.width / 2),
            Math.max(0.5, frame.height / 2),
          )
        : Math.max(0, value);
    });
    const [tl, tr, br, bl] = Array.from(
      { length: 4 },
      (_, i) => radii[i % radii.length],
    );
    node.style.radius = tl;
    if (new Set(radii).size > 1) node.style.corners = { tl, tr, br, bl };
    if (corners.style === 1)
      node.style.cornerSmoothing = bounded(
        number(corners.smoothing),
        0,
        1,
        report,
        "圆角平滑度",
      );
    if (number(corners.style) > 1)
      warn(node.id, "异形角保留各角半径，轮廓需复核");
  }
  if (type === "text") {
    textContent(l, node, warn, fontContext);
    node.style.textEffectClip = "glyphs";
    // A Sketch text layer's enabled fills paint its glyphs over the attributed text color.
    const active = array(object(l.style).fills).filter(
      (f) => f.isEnabled !== false && f.layeringType !== 1,
    );
    if (active.length === 1 && active.every((f) => number(f.fillType) === 0)) {
      const solid = active.at(-1)!;
      node.style.color = color(solid.color);
      node.style.colorOpacity =
        alpha(solid.color, report) *
        bounded(
          number(object(solid.contextSettings).opacity, 1),
          0,
          1,
          report,
          "绘制透明度",
        );
    }
  }
  const points = type === "vector" ? array(l.points) : [];
  if (type === "vector" && !points.length) {
    node.type = "rectangle";
    report("空矢量路径已保留边界");
  }
  if (node.type === "vector") {
    const width = bounded(node.style.width, 1, 10000, report, "矢量坐标宽度"),
      height = bounded(node.style.height, 1, 10000, report, "矢量坐标高度");
    const xy = (v: unknown) => {
      const p = point(v);
      return (
        p.x * Math.min(frame.width, width) +
        " " +
        p.y * Math.min(frame.height, height)
      );
    };
    let d = "M" + xy(points[0].point);
    for (let i = 1; i < points.length + (l.isClosed ? 1 : 0); i++) {
      const prev = points[i - 1],
        next = points[i % points.length];
      d +=
        prev.hasCurveFrom || next.hasCurveTo
          ? "C" +
            xy(prev.hasCurveFrom ? prev.curveFrom : prev.point) +
            " " +
            xy(next.hasCurveTo ? next.curveTo : next.point) +
            " " +
            xy(next.point)
          : "L" + xy(next.point);
    }
    if (l.isClosed) d += "Z";
    node.style.color = node.style.fill;
    node.style.colorOpacity = node.style.fillOpacity;
    const st = object(l.style),
      opts = object(st.borderOptions);
    node.vector = {
      width,
      height,
      stretch: true,
      paths: [
        {
          d,
          fill: !!l.isClosed || !!node.style.fillOpacity,
          strokeWidth: node.style.strokeWidth ?? 0,
          lineCap: (["butt", "round", "square"] as const)[
            number(opts.lineCapStyle)
          ],
          lineJoin: (["miter", "round", "bevel"] as const)[
            number(opts.lineJoinStyle)
          ],
          fillRule: st.windingRule === 1 ? "evenodd" : "nonzero",
        },
      ],
    };
  }

  const layout = string(object(l.groupLayout)._class);
  if (layout && !/Freeform|FlexGroupLayout/i.test(layout))
    warn(
      node.id,
      layout === "MSImmutableInferredGroupLayout"
        ? "Sketch 智能布局（Smart Layout）已保留当前尺寸，动态布局需复核"
        : "Sketch 布局 " + layout + " 已保留当前尺寸，动态布局需复核",
    );

  return node;
}
