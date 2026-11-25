import { polarPaint } from "../../domain/polar-gradient";
import {
  maxGradientStops,
  maxLayerDimension,
} from "../../domain/document-limits";
import { networkStroke, networkRegions } from "./figma-vector";
import { createNode, type DesignNode } from "../../domain/node";
import { limitedText } from "./types";
import type { InlineStyle } from "../../domain/rich-text";
import { blendModes } from "../../domain/node";

export type Fields = Record<string, unknown>;
export const obj = (value: unknown): Fields =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : {};
export const rows = (value: unknown): Fields[] =>
  Array.isArray(value) ? value.map(obj) : [];
export const num = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
export const str = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;
export const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));
export function guid(value: unknown) {
  const v = obj(value);
  return Number.isInteger(v.sessionID) && Number.isInteger(v.localID)
    ? `fig-${v.sessionID}-${v.localID}`
    : "";
}
export function hex(value: unknown) {
  const c = obj(value);
  return (
    "#" +
    [c.r, c.g, c.b]
      .map((n) =>
        Math.round(255 * clamp(num(n), 0, 1))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
export type Report = (node: string, detail: string) => void;
export interface LayerContext {
  assetKeys: Map<string, string>;
  blobs: Fields[];
  images: Map<string, string>;
  report: Report;
  alphaBinding?: (id: string, paint: Fields, row: Fields) => string | undefined;
}
function figmaBlend(value: unknown) {
  const mode =
    value === "LINEAR_BURN"
      ? "plus-darker"
      : value === "LINEAR_DODGE"
        ? "plus-lighter"
        : str(value).toLowerCase().replaceAll("_", "-");
  return blendModes.find((v) => v === mode);
}
const align = (v: unknown) =>
  v === "CENTER" ? "center" : v === "MAX" ? "end" : "start";
function typography(raw: Fields): InlineStyle {
  const font = obj(raw.fontName),
    name = str(font.style).toLowerCase(),
    style: InlineStyle = {};
  if (font.family) style.fontFamily = str(font.family);
  if (name) {
    style.fontWeight = /thin/.test(name)
      ? 100
      : /extra.?light/.test(name)
        ? 200
        : /light/.test(name)
          ? 300
          : /medium/.test(name)
            ? 500
            : /semi.?bold/.test(name)
              ? 600
              : /extra.?bold/.test(name)
                ? 800
                : /black|heavy/.test(name)
                  ? 900
                  : /bold/.test(name)
                    ? 700
                    : 400;
    if (/italic|oblique/.test(name)) style.fontStyle = "italic";
  }
  if (raw.fontSize !== undefined)
    style.fontSize = clamp(num(raw.fontSize, 16), 1, 500);
  if (raw.textDecoration === "UNDERLINE") style.textDecoration = "underline";
  if (raw.textDecoration === "STRIKETHROUGH")
    style.textDecoration = "line-through";
  const p = rows(raw.fillPaints)
    .filter((p) => p.visible !== false)
    .at(-1);
  if (p?.type === "SOLID") style.color = hex(p.color);
  return style;
}
const decodedPaths = new WeakMap<Uint8Array, string>();
function pathCommands(bytes: unknown) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 512000) return "";
  if (decodedPaths.has(bytes)) return decodedPaths.get(bytes)!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const parts: string[] = [];
  while (off < bytes.length) {
    const code = bytes[off++],
      count = [0, 2, 2, 4, 6][code];
    if (count === undefined || off + 4 * count > bytes.length) return "";
    const points: number[] = [];
    for (let n = 0; n < count; n++, off += 4) {
      const v = view.getFloat32(off, true);
      if (!Number.isFinite(v)) return "";
      points.push(Number(v.toFixed(5)));
    }
    parts.push(["Z", "M", "L", "Q", "C"][code] + points.join(" "));
  }
  const d = parts.join(" ");
  const path = d.length <= 100000 ? d : "";
  decodedPaths.set(bytes, path);
  return path;
}
export function makeLayer(
  raw: Fields,
  id: string,
  parent: string | null,
  ctx: LayerContext,
) {
  const type = str(raw.type),
    name = str(raw.name, type);
  const warn = (detail: string) => ctx.report(guid(raw.guid) || id, detail);
  const types: Record<string, DesignNode["type"]> = {
    FRAME: "frame",
    GROUP: "group",
    SECTION: "section",
    SYMBOL: "frame",
    INSTANCE: "frame",
    TEXT: "text",
    VECTOR: "vector",
    BRUSH: "vector",
    LINE: "vector",
    STAR: "vector",
    REGULAR_POLYGON: "vector",
    BOOLEAN_OPERATION: "frame",
    RECTANGLE: "rectangle",
    ROUNDED_RECTANGLE: "rectangle",
    ELLIPSE: "ellipse",
    SLICE: "slice",
  };
  const node = createNode(
    Object.hasOwn(types, type) ? types[type] : "frame",
    parent,
  );
  node.id = id;
  node.name = name.slice(0, 16384).replace(/[\uD800-\uDBFF]$/, "");
  if (node.name !== name)
    warn("图层名称超出 16384 字符，原名：" + name.slice(0, 4000));
  node.hidden = raw.visible === false;
  node.locked = raw.locked === true;
  if (!Object.hasOwn(types, type))
    warn(type + " 缺少对应节点类型，已保留容器及后代");
  const s = node.style,
    m = obj(raw.transform),
    size = obj(raw.size);
  const w = num(size.x, 1),
    h = num(size.y, 1);
  const a = num(m.m00, 1),
    b = num(m.m10),
    c = num(m.m01),
    d = num(m.m11, 1);
  const sx = Math.hypot(a, b),
    sy = Math.hypot(c, d);
  s.width = clamp(w * sx, 0, maxLayerDimension);
  s.height = clamp(h * sy, 0, maxLayerDimension);
  if (
    Math.abs(a * c + b * d) > 0.001 ||
    ((Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001) &&
      ["frame", "group"].includes(node.type))
  )
    warn("复合缩放或倾斜变换已近似");
  if (w * sx !== s.width || h * sy !== s.height)
    warn("尺寸超出 Forma 0–100000 px，已限制");
  s.rotation = (Math.atan2(b, a) * 180) / Math.PI;
  if (a * d - b * c < 0) s.flipY = true;
  // Figma transforms around the local origin. Forma's CSS transform uses the center.
  s.x = num(m.m02) + (a * w + c * h) / 2 - s.width / 2;
  s.y = num(m.m12) + (b * w + d * h) / 2 - s.height / 2;
  s.padding = 0;
  s.gap = 0;
  s.radius = clamp(
    num(raw.cornerRadius ?? raw.rectangleCornerRadius),
    0,
    10000,
  );
  if (typeof raw.cornerSmoothing === "number") {
    s.cornerSmoothingModel = "figma";
    s.cornerSmoothing = clamp(num(raw.cornerSmoothing), 0, 1);
  }
  s.fill = "#000000";
  s.fillOpacity = 0;
  if (raw.rectangleCornerRadiiIndependent)
    s.corners = {
      tl: clamp(num(raw.rectangleTopLeftCornerRadius), 0, 10000),
      tr: clamp(num(raw.rectangleTopRightCornerRadius), 0, 10000),
      br: clamp(num(raw.rectangleBottomRightCornerRadius), 0, 10000),
      bl: clamp(num(raw.rectangleBottomLeftCornerRadius), 0, 10000),
    };
  s.opacity = clamp(num(raw.opacity, 1), 0, 1);
  s.clipContent =
    ["FRAME", "SYMBOL", "INSTANCE"].includes(type) &&
    raw.frameMaskDisabled === false;
  const mode = figmaBlend(raw.blendMode);
  if (mode) s.blendMode = mode;
  const paints = rows(raw.fillPaints),
    visible = paints.filter((p) => p.visible !== false);
  const solid = visible.at(-1),
    alpha = (p: Fields) =>
      clamp(num(p.opacity, 1) * num(obj(p.color).a, 1), 0, 1);
  function readGradient(paint: Fields): DesignNode["style"]["gradient"] {
    if (!str(paint.type).startsWith("GRADIENT_")) return;
    const stops = rows(paint.stops),
      t = obj(paint.transform);
    if (stops.length >= 2 && stops.length <= maxGradientStops) {
      const x = num(t.m00, 1),
        y = num(t.m01),
        offset = num(t.m02);
      const linear =
        paint.type === "GRADIENT_LINEAR" && Math.hypot(x, y) > 1e-10;
      const matrix = {
        a: x,
        c: y,
        e: offset,
        b: num(t.m10),
        d: num(t.m11, 1),
        f: num(t.m12),
      };
      const invertible =
        Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) > 1e-12;
      return {
        ...(!linear &&
        invertible &&
        (paint.type === "GRADIENT_ANGULAR" || paint.type === "GRADIENT_RADIAL")
          ? { paintTransform: matrix }
          : {}),
        ...(linear ? { linearProjection: { x, y, offset } } : {}),
        type:
          paint.type === "GRADIENT_LINEAR"
            ? "linear"
            : paint.type === "GRADIENT_ANGULAR"
              ? "angular"
              : paint.type === "GRADIENT_DIAMOND"
                ? "diamond"
                : "radial",
        angle: linear
          ? (360 + (Math.atan2(x, -y) * 180) / Math.PI) % 360
          : (90 +
              (Math.atan2(-num(t.m10), num(t.m11, 1)) * 180) / Math.PI +
              360) %
            360,
        stops: stops.map((v) => ({
          color: hex(v.color),
          opacity: clamp(num(obj(v.color).a, 1), 0, 1),
          offset: clamp(num(v.position), 0, 1),
        })),
      };
    }
  }
  const gradients = new Map<Fields, DesignNode["style"]["gradient"]>();
  for (const p of paints) {
    if (!str(p.type).startsWith("GRADIENT_")) continue;
    const gradient = readGradient(p);
    gradients.set(p, gradient);
    if (!gradient) warn("渐变色标数超出可编辑范围");
    else if (
      !gradient.linearProjection &&
      (!gradient.paintTransform ||
        !polarPaint(gradient.paintTransform).axisAligned)
    )
      warn("渐变的位置与缩放按 Forma 渐变模型转换");
  }
  const supported = (p: Fields) => p.type === "SOLID" || !!gradients.get(p);
  const layers = (sources: Fields[]) =>
    [...sources].reverse().map((p, i) => ({
      id: "fig-paint-" + i,
      color: hex(p.color),
      visible: p.visible !== false,
      opacity: alpha(p),
      ...(gradients.get(p) && { gradient: gradients.get(p) }),
      ...(p.blendMode && p.blendMode !== "NORMAL"
        ? { blendMode: figmaBlend(p.blendMode) }
        : {}),
    }));
  const useBase = (paint?: Fields) => {
    s.fill = paint ? hex(paint.color) : "#000000";
    s.fillOpacity = paint && paint.visible !== false ? alpha(paint) : 0;
    const gradient = paint && gradients.get(paint);
    if (gradient) s.gradient = gradient;
    if (paint?.blendMode && paint.blendMode !== "NORMAL")
      s.fillBlendMode = figmaBlend(paint.blendMode);
  };
  const image = visible.filter((p) => p.type === "IMAGE").at(-1);
  const imageIndex = paints.findIndex((p) => p === image),
    before = paints.slice(0, imageIndex),
    after = paints.slice(imageIndex + 1);
  const exactImageStack =
    image &&
    before.length <= 1 &&
    after.length <= 16 &&
    [...before, ...after].every(supported);
  if (exactImageStack) {
    useBase(before[0]);
    if (after.length) s.paints = layers(after);
  } else if (
    paints.length > 1 &&
    paints.length <= 16 &&
    paints.every(supported)
  ) {
    s.paints = layers(paints);
  } else if (solid && supported(solid)) {
    useBase(solid);
  }
  if (visible.some((p) => p.type !== "IMAGE" && !supported(p)))
    warn("存在未映射的填充类型");
  if (paints.length > 1 && !s.paints && !exactImageStack)
    warn("混合填充堆栈已近似");
  if (image) {
    const hash = obj(image.image).hash,
      key =
        hash instanceof Uint8Array
          ? Array.from(hash, (n) => n.toString(16).padStart(2, "0")).join("")
          : "";
    const assetId = ctx.images.get(key);
    if (assetId) {
      node.image = {
        assetId,
        fit:
          image.imageScaleMode === "FIT"
            ? "contain"
            : image.imageScaleMode === "TILE"
              ? "tile"
              : "cover",
        x: 50,
        y: 50,
        zoom: 1,
        opacity:
          image.opacity !== undefined
            ? clamp(num(image.opacity, 1), 0, 1)
            : undefined,
      };
      if (image.imageScaleMode === "TILE")
        node.image.tileScale = clamp(num(image.scale, 1), 0.1, 8);
      if (
        image.imageScaleMode === "CROP" ||
        image.imageScaleMode === "STRETCH"
      ) {
        const t = obj(image.transform);
        const ax = num(t.m00),
          ay = num(t.m11),
          tx = num(t.m02),
          ty = num(t.m12);
        const iw = num(image.originalImageWidth),
          ih = num(image.originalImageHeight);
        const cover = Math.max(w / iw, h / ih),
          zx = w / (ax * iw * cover),
          zy = h / (ay * ih * cover);
        const fx = Math.abs(1 - ax) < 1e-6 ? 0.5 : tx / (1 - ax),
          fy = Math.abs(1 - ay) < 1e-6 ? 0.5 : ty / (1 - ay);
        if (
          iw > 0 &&
          ih > 0 &&
          ax > 0 &&
          ay > 0 &&
          Math.abs(num(t.m01)) + Math.abs(num(t.m10)) < 1e-6 &&
          Math.abs(zx - zy) < 0.001 &&
          zx >= 0.9999 &&
          zx <= 8 &&
          fx >= -0.0001 &&
          fx <= 1.0001 &&
          fy >= -0.0001 &&
          fy <= 1.0001
        ) {
          node.image.zoom = clamp(zx, 1, 8);
          node.image.x = clamp(100 * fx, 0, 100);
          node.image.y = clamp(100 * fy, 0, 100);
        } else warn("位图裁切矩阵已近似");
      }
    } else warn("缺少图像资源 " + key);
  }
  const allStrokes = rows(raw.strokePaints);
  const strokes = allStrokes.filter((p) => p.visible !== false);
  const stackedStroke =
    allStrokes.length > 1 &&
    allStrokes.length <= 16 &&
    allStrokes.every((p) => p.type === "SOLID") &&
    ["frame", "rectangle", "ellipse"].includes(node.type);
  const stroke =
    strokes.at(-1) ?? (stackedStroke ? allStrokes.at(-1) : undefined);
  if (stackedStroke)
    s.strokePaints = [...allStrokes].reverse().map((p, i) => ({
      id: "fig-paint-" + i,
      color: hex(p.color),
      opacity: alpha(p),
      visible: p.visible !== false,
      ...(p.blendMode && p.blendMode !== "NORMAL"
        ? { blendMode: figmaBlend(p.blendMode) }
        : {}),
    }));
  if (stroke) {
    s.stroke = hex(stroke.color);
    if (
      !["HORIZONTAL", "VERTICAL"].includes(str(raw.stackMode)) ||
      raw.bordersTakeSpace !== true
    )
      s.strokeInLayout = false;
    if (stroke.blendMode && stroke.blendMode !== "NORMAL")
      s.strokeBlendMode = figmaBlend(stroke.blendMode);
    if (raw.borderStrokeWeightsIndependent)
      s.strokeSides = {
        top: clamp(num(raw.borderTopWeight), 0, 64),
        right: clamp(num(raw.borderRightWeight), 0, 64),
        bottom: clamp(num(raw.borderBottomWeight), 0, 64),
        left: clamp(num(raw.borderLeftWeight), 0, 64),
      };
    s.strokeWidth = clamp(num(raw.strokeWeight, 1), 0, 100);
    s.strokeOpacity = alpha(stroke);
    s.strokeAlign =
      raw.strokeAlign === "INSIDE"
        ? "inside"
        : raw.strokeAlign === "OUTSIDE"
          ? "outside"
          : "center";
    if ((!stackedStroke && allStrokes.length > 1) || stroke.type !== "SOLID")
      warn("多重或非纯色描边已近似");
  }
  for (const effect of rows(raw.effects)) {
    const radius = num(effect.radius),
      visible = effect.visible !== false;
    if (["DROP_SHADOW", "INNER_SHADOW"].includes(str(effect.type))) {
      s.shadows ??= [];
      if (s.shadows.length >= 32) {
        warn("阴影超过 32 项");
        continue;
      }
      s.shadows.push({
        x: clamp(num(obj(effect.offset).x), -1000, 1000),
        y: clamp(num(obj(effect.offset).y), -1000, 1000),
        blur: clamp(radius, 0, 1000),
        spread: clamp(num(effect.spread), -1000, 1000),
        color: hex(effect.color),
        opacity: clamp(num(obj(effect.color).a, 1), 0, 1),
        inset: effect.type === "INNER_SHADOW",
        ...(effect.blendMode && effect.blendMode !== "NORMAL"
          ? { blendMode: figmaBlend(effect.blendMode) }
          : {}),
        visible,
      });
    } else if (effect.type === "GLASS") {
      s.figmaGlass = { visible, radius };
      for (const key of [
        "refractionRadius",
        "refractionIntensity",
        "reflectionDistance",
        "startRadius",
        "opacity",
        "density",
        "specularAngle",
        "specularIntensity",
        "bevelSize",
        "chromaticAberration",
        "splay",
      ] as const)
        if (typeof effect[key] === "number" && Number.isFinite(effect[key]))
          s.figmaGlass[key] = effect[key];
      if (visible && radius > 0)
        s.backdropBlur = Math.max(s.backdropBlur ?? 0, clamp(radius, 0, 100));
      if (visible) warn("玻璃保留源参数与霜化，折射、色散和镜面高光需复核");
    } else if (effect.type === "FOREGROUND_BLUR") {
      s.blur = clamp(radius / 2, 0, 100);
      s.blurVisible = visible;
    } else if (effect.type === "BACKGROUND_BLUR") {
      s.backdropBlur = clamp(radius, 0, 100);
      s.backdropBlurVisible = visible;
    } else warn("未映射效果 " + str(effect.type));
  }
  if (raw.stackMode === "HORIZONTAL" || raw.stackMode === "VERTICAL") {
    s.layout = raw.stackMode === "HORIZONTAL" ? "row" : "column";
    s.gap = clamp(
      num(raw.stackSpacing),
      raw.stackWrap === "WRAP" ? 0 : -1000,
      1000,
    );
    if (raw.stackReverseZIndex === true) s.firstChildOnTop = true;
    if (raw.stackWrap === "WRAP") {
      s.wrap = true;
      s.rowGap = clamp(num(raw.stackCounterSpacing, s.gap), 0, 1000);
    }
    s.insets = {
      top: clamp(num(raw.stackVerticalPadding), 0, 1000),
      bottom: clamp(
        num(raw.stackPaddingBottom ?? raw.stackVerticalPadding),
        0,
        1000,
      ),
      left: clamp(num(raw.stackHorizontalPadding), 0, 1000),
      right: clamp(
        num(raw.stackPaddingRight ?? raw.stackHorizontalPadding),
        0,
        1000,
      ),
    };
    s.alignX = align(
      s.layout === "row"
        ? raw.stackPrimaryAlignItems
        : raw.stackCounterAlignItems,
    );
    s.alignY = align(
      s.layout === "column"
        ? raw.stackPrimaryAlignItems
        : raw.stackCounterAlignItems,
    );
    if (raw.stackPrimaryAlignItems === "SPACE_EVENLY")
      s.justifyContent = "space-between";
    if (raw.stackWrap === "WRAP" && num(raw.stackSpacing) < 0)
      warn("换行布局负间距按 0 px 排布");
  } else if (raw.stackMode && raw.stackMode !== "NONE")
    warn("布局 " + str(raw.stackMode) + " 保留源坐标");
  const constraint = (v: unknown) =>
    v === "CENTER"
      ? "center"
      : v === "MAX"
        ? "end"
        : v === "STRETCH"
          ? "stretch"
          : v === "SCALE"
            ? "scale"
            : "start";
  if (raw.horizontalConstraint)
    s.constraintX = constraint(raw.horizontalConstraint);
  if (raw.verticalConstraint)
    s.constraintY = constraint(raw.verticalConstraint);
  if (
    raw.stackPositioning === "ABSOLUTE" ||
    raw.stackChildPositioning === "ABSOLUTE"
  )
    s.absolutePosition = true;
  if (type === "TEXT" || raw.styleType === "TEXT") {
    if (raw.leadingTrim === "CAP_HEIGHT") s.leadingTrim = "cap";
    const td = obj(raw.textData);
    node.text = limitedText(str(td.characters), 50000, warn);
    Object.assign(s, typography(raw));
    s.colorOpacity = solid ? alpha(solid) : 1;
    s.fillOpacity = 0;
    delete s.paints;
    const lh = obj(raw.lineHeight),
      ls = obj(raw.letterSpacing);
    const baseline = rows(obj(raw.derivedTextData).baselines)[0];
    if (lh.units === "RAW" && num(lh.value) > 0)
      s.lineHeight = clamp(num(lh.value) * s.fontSize, 1, 1000);
    else if (lh.units === "RAW" && num(baseline?.lineHeight) > 0)
      s.lineHeight = clamp(num(baseline?.lineHeight), 1, 1000);
    if (lh.units === "PIXELS" || lh.units === "PERCENT")
      s.lineHeight = clamp(
        num(lh.value) * (lh.units === "PERCENT" ? s.fontSize / 100 : 1),
        1,
        1000,
      );
    if (ls.value !== undefined)
      s.letterSpacing = clamp(
        num(ls.value) * (ls.units === "PERCENT" ? s.fontSize / 100 : 1),
        -50,
        200,
      );
    s.textAlign =
      raw.textAlignHorizontal === "CENTER"
        ? "center"
        : raw.textAlignHorizontal === "RIGHT"
          ? "right"
          : raw.textAlignHorizontal === "JUSTIFIED"
            ? "justify"
            : "left";
    s.verticalAlign =
      raw.textAlignVertical === "CENTER"
        ? "middle"
        : raw.textAlignVertical === "BOTTOM"
          ? "bottom"
          : "top";
    const ids = td.characterStyleIDs,
      table = new Map(
        rows(td.styleOverrideTable).map((row) => [
          row.styleID,
          typography(row),
        ]),
      );
    if (Array.isArray(ids) && table.size) {
      const runs: NonNullable<DesignNode["textRuns"]> = [];
      for (let i = 0; i < ids.length && i < node.text.length;) {
        const start = i,
          style = table.get(ids[i]);
        while (i < ids.length && ids[i] === ids[start]) i++;
        if (style && Object.keys(style).length)
          runs.push({ start, end: Math.min(i, node.text.length), style });
      }
      if (runs.length) node.textRuns = runs;
    }
  }
  if (node.type === "vector") {
    s.color = solid?.type === "SOLID" ? hex(solid.color) : (s.stroke ?? s.fill);
    s.colorOpacity =
      solid && solid.type === "SOLID" ? alpha(solid) : (s.strokeOpacity ?? 1);

    const paths: NonNullable<DesignNode["vector"]>["paths"] = [];
    for (const g of rows(raw.fillGeometry)) {
      const path = pathCommands(ctx.blobs[num(g.commandsBlob, -1)]?.bytes);
      if (path)
        paths.push({
          d: path,
          fill: visible.length > 0,
          fillRule: g.windingRule === "ODD" ? "evenodd" : "nonzero",
          strokeWidth: s.strokeWidth ?? 0,
          strokeColor: s.stroke,
          strokeOpacity: s.strokeOpacity,
          lineCap:
            raw.strokeCap === "ROUND"
              ? "round"
              : raw.strokeCap === "SQUARE"
                ? "square"
                : "butt",
          lineJoin:
            raw.strokeJoin === "ROUND"
              ? "round"
              : raw.strokeJoin === "BEVEL"
                ? "bevel"
                : "miter",
        });
    }
    if (
      !visible.length &&
      stroke?.type === "SOLID" &&
      raw.strokeAlign === "CENTER"
    ) {
      const network = obj(raw.vectorData),
        normalized = obj(network.normalizedSize);
      const overrides = rows(network.styleOverrideTable);
      if (
        overrides.every(
          (v) =>
            !num(v.cornerRadius) &&
            (!v.strokeCap || v.strokeCap === raw.strokeCap) &&
            (!v.strokeJoin || v.strokeJoin === raw.strokeJoin),
        )
      ) {
        const d = networkStroke(
          ctx.blobs[num(network.vectorNetworkBlob, -1)]?.bytes,
          w / (num(normalized.x) || w || 1),
          h / (num(normalized.y) || h || 1),
        );
        if (d)
          paths.push({
            d,
            fill: false,
            strokeWidth: s.strokeWidth ?? 1,
            lineCap:
              raw.strokeCap === "ROUND"
                ? "round"
                : raw.strokeCap === "SQUARE"
                  ? "square"
                  : "butt",
            lineJoin:
              raw.strokeJoin === "ROUND"
                ? "round"
                : raw.strokeJoin === "BEVEL"
                  ? "bevel"
                  : "miter",
          });
      }
    }
    if (!paths.length && !rows(raw.strokeGeometry).length) {
      const data = obj(raw.vectorData),
        size = obj(data.normalizedSize),
        blob = ctx.blobs[num(data.vectorNetworkBlob, -1)]?.bytes;
      const sx = w / (num(size.x) || w || 1),
        sy = h / (num(size.y) || h || 1);
      const regions = networkRegions(blob, sx, sy);
      for (const r of regions ?? []) {
        paths.push({
          d: r.d,
          fill: true,
          fillRule: r.fillRule,
          strokeWidth: s.strokeWidth ?? 0,
          strokeColor: s.stroke,
          strokeOpacity: s.strokeOpacity,
        });
      }
      if (!paths.length) {
        const d = networkStroke(blob, sx, sy);
        if (d)
          paths.push({
            d,
            fill: visible.length > 0,
            strokeWidth: s.strokeWidth ?? 0,
            strokeColor: s.stroke,
            strokeOpacity: s.strokeOpacity,
          });
      }
    }
    if (!paths.length && rows(raw.strokeGeometry).length)
      warn("描边保留为可编辑轮廓路径");
    if (!paths.length)
      for (const g of rows(raw.strokeGeometry)) {
        const path = pathCommands(ctx.blobs[num(g.commandsBlob, -1)]?.bytes);
        if (path)
          paths.push({
            d: path,
            fill: true,
            strokeWidth: 0,
          });
      }
    if (paths.length && paths.length <= 100)
      node.vector = {
        width: clamp(w || 1, Number.EPSILON, 10000),
        height: clamp(h || 1, Number.EPSILON, 10000),
        ...(s.gradient || s.paints ? { fillFromStyle: true as const } : {}),
        ...(paths.some((p) => p.strokeWidth > 0)
          ? { overflowVisible: true as const }
          : {}),
        paths,
      };
    else if (type === "LINE")
      node.vector = {
        width: s.width || 1,
        height: s.height || 1,
        paths: [
          {
            d: `M0 0 L${w} ${h}`,
            fill: false,
            strokeWidth: s.strokeWidth ?? 1,
          },
        ],
      };
    else {
      node.type = "rectangle";
      warn("未取得可表示的矢量路径，保留边界");
    }
  }
  if (node.vector) {
    // Vector artwork owns its strokes. Shape-border properties would also
    // draw a rectangle around the SVG in the canvas and all exports.
    delete s.strokeWidth;
    delete s.strokeSides;
    delete s.strokeAlign;
    delete s.stroke;
    delete s.strokeOpacity;
  }
  if (type === "BOOLEAN_OPERATION") {
    node.type = "group";
    s.color = s.fill;
    s.colorOpacity = s.fillOpacity;
    const operation =
      raw.booleanOperation === "XOR"
        ? "exclude"
        : str(raw.booleanOperation).toLowerCase();
    if (
      operation === "union" ||
      operation === "subtract" ||
      operation === "intersect" ||
      operation === "exclude"
    )
      node.booleanOperation = operation;
    else warn("布尔操作保留可编辑子层");
  }
  if (raw.mask === true)
    node.siblingMask =
      raw.maskType === "LUMINANCE"
        ? "luminance"
        : raw.maskType === "VECTOR"
          ? "vector"
          : "alpha";
  if (rows(raw.prototypeInteractions).length) warn("原型交互尚未迁移");
  return node;
}
