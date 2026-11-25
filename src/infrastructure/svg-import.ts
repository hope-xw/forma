import svgpath from "svgpath";
import { createNode, type DesignNode } from "../domain/document";
import { compose, identity, type Matrix } from "../domain/transforms";

type Vector = NonNullable<DesignNode["vector"]>;
type Path = Vector["paths"][number];
const presentation = [
  "color",
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "opacity",
];
const geometry: Record<string, string[]> = {
  svg: ["width", "height", "viewBox", "version", "preserveAspectRatio"],
  g: [],
  path: ["d"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polygon: ["points"],
  polyline: ["points"],
};
const reject = (detail: string): never => {
  throw new Error("SVG 无法转为可编辑路径：" + detail);
};
function number(value: string, name: string) {
  if (!/^[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?(?:px)?$/i.test(value.trim()))
    return reject(name + " 需要数值或 px");
  const n = Number(value.trim().replace(/px$/i, ""));
  return Number.isFinite(n) ? n : reject(name);
}
function shape(el: Element) {
  const n = (k: string, fallback = 0) =>
    el.hasAttribute(k) ? number(el.getAttribute(k)!, k) : fallback;
  switch (el.localName) {
    case "path":
      return el.getAttribute("d") ?? "";
    case "line":
      return "M" + n("x1") + " " + n("y1") + "L" + n("x2") + " " + n("y2");
    case "circle":
    case "ellipse": {
      const x = n("cx"),
        y = n("cy"),
        rx = n("rx", n("r")),
        ry = n("ry", n("r"));
      if (rx <= 0 || ry <= 0) return "";
      return (
        "M" +
        (x - rx) +
        " " +
        y +
        "a" +
        rx +
        " " +
        ry +
        " 0 1 0 " +
        2 * rx +
        " 0a" +
        rx +
        " " +
        ry +
        " 0 1 0 " +
        -2 * rx +
        " 0z"
      );
    }
    case "rect": {
      const x = n("x"),
        y = n("y"),
        w = n("width"),
        h = n("height");
      if (w <= 0 || h <= 0) return "";
      const rx = Math.min(w / 2, Math.max(0, n("rx", n("ry")))),
        ry = Math.min(h / 2, Math.max(0, n("ry", n("rx"))));
      if (!rx || !ry)
        return "M" + x + " " + y + "h" + w + "v" + h + "h" + -w + "z";
      const arc = "a" + rx + " " + ry + " 0 0 1 ";
      return (
        "M" +
        (x + rx) +
        " " +
        y +
        "h" +
        (w - 2 * rx) +
        arc +
        rx +
        " " +
        ry +
        "v" +
        (h - 2 * ry) +
        arc +
        -rx +
        " " +
        ry +
        "h" +
        (2 * rx - w) +
        arc +
        -rx +
        " " +
        -ry +
        "v" +
        (2 * ry - h) +
        arc +
        rx +
        " " +
        -ry +
        "z"
      );
    }
    case "polygon":
    case "polyline": {
      const nums = (el.getAttribute("points") ?? "")
        .trim()
        .split(/[\s,]+/)
        .map((v) => number(v, "points"));
      if (nums.length < 4 || nums.length % 2)
        return reject("points 坐标不成对");
      return "M" + nums.join(" ") + (el.localName === "polygon" ? "z" : "");
    }
    default:
      return reject(el.localName);
  }
}
function color(raw: string, context: CanvasRenderingContext2D) {
  if (
    !CSS.supports("color", raw) ||
    /var\(|currentcolor|inherit|light-dark\(/i.test(raw)
  )
    return reject("颜色 " + raw);
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = raw;
  context.fillRect(0, 0, 1, 1);
  const rgba = context.getImageData(0, 0, 1, 1).data;
  return {
    hex:
      "#" +
      Array.from(rgba.slice(0, 3), (v) => v.toString(16).padStart(2, "0")).join(
        "",
      ),
    alpha: rgba[3] / 255,
  };
}
/** Parse detached SVG geometry only. Unsupported presentation fails the whole import. */
export function importSvg(source: string, name: string) {
  if (
    source.length > 2_000_000 ||
    /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(source)
  )
    return reject("文档过大或含外部声明");
  const xml = new DOMParser().parseFromString(source, "image/svg+xml"),
    root = xml.documentElement;
  if (
    xml.querySelector("parsererror") ||
    root.localName !== "svg" ||
    root.namespaceURI !== "http://www.w3.org/2000/svg"
  )
    return reject("SVG 格式不正确");
  const values = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map((v) => number(v, "viewBox"));
  if (values && (values.length !== 4 || values[2] <= 0 || values[3] <= 0))
    return reject("viewBox");
  const w = number(
      root.getAttribute("width") ?? String(values?.[2] ?? 300),
      "width",
    ),
    h = number(
      root.getAttribute("height") ?? String(values?.[3] ?? 150),
      "height",
    );
  if (w < 1 || h < 1 || w > 10000 || h > 10000)
    return reject("图标尺寸需介于 1 和 10000 px");
  const [vx, vy, vw, vh] = values ?? [0, 0, w, h];
  const aspect =
    root.getAttribute("preserveAspectRatio")?.trim() ?? "xMidYMid meet";
  const match =
    /^(none|x(Min|Mid|Max)Y(Min|Mid|Max))(?:\s+(meet|slice))?$/.exec(aspect);
  if (!match) return reject("preserveAspectRatio");
  const sx = w / vw,
    sy = h / vh,
    scale = match[4] === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
  const a = match[1] === "none" ? sx : scale,
    d = match[1] === "none" ? sy : scale;
  const align = (key: string, free: number) =>
    key === "Max" ? free : key === "Mid" ? free / 2 : 0;
  const matrix = {
    a,
    b: 0,
    c: 0,
    d,
    e: -vx * a + align(match[2], w - vw * a),
    f: -vy * d + align(match[3], h - vh * d),
  };
  const ctx = document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true })!;
  const paths: Path[] = [];
  function visit(
    el: Element,
    inherited: Record<string, string>,
    parent: Matrix,
    depth: number,
  ) {
    if (depth > 64) return reject("图标嵌套过深");
    const tag = el.localName;
    if (["title", "desc", "metadata"].includes(tag)) return;
    if (
      !(tag in geometry) ||
      el.namespaceURI !== root.namespaceURI ||
      (tag === "svg" && el !== root)
    )
      return reject("暂不支持元素 " + tag);
    const style: Record<string, string> = { ...inherited, opacity: "1" };
    for (const attr of el.attributes) {
      const k = attr.name;
      if (presentation.includes(k)) {
        style[k] = attr.value;
        continue;
      }
      if (
        !geometry[tag].includes(k) &&
        ![
          "id",
          "style",
          "transform",
          "class",
          "focusable",
          "role",
          "xmlns",
        ].includes(k) &&
        !k.startsWith("xmlns:") &&
        !k.startsWith("aria-") &&
        !k.startsWith("data-")
      )
        return reject("暂不支持属性 " + k);
    }
    for (const declaration of (el.getAttribute("style") ?? "")
      .split(";")
      .filter((t) => t.trim())) {
      const i = declaration.indexOf(":"),
        key = declaration.slice(0, i).trim();
      if (i < 0 || !presentation.includes(key))
        return reject("暂不支持样式 " + key);
      style[key] = declaration.slice(i + 1).trim();
    }
    const transform = (
      el as SVGGraphicsElement
    ).transform?.baseVal.consolidate()?.matrix;
    const m = compose(parent, transform ?? identity);
    if (tag === "g" || tag === "svg") {
      if (tag === "g" && Number(style.opacity) !== 1)
        return reject("组级透明度");
      for (const child of el.children) visit(child, style, m, depth + 1);
      return;
    }
    const raw = shape(el);
    if (!raw) return;
    const path = svgpath(raw);
    if ((path as unknown as { err: string }).err) return reject("路径数据错误");
    const resolve = (v: string) =>
      color(v.toLowerCase() === "currentcolor" ? style.color : v, ctx);
    const fill = style.fill === "none" ? null : resolve(style.fill),
      stroke = style.stroke === "none" ? null : resolve(style.stroke);
    if (!fill && !stroke) return;
    const scaleX = Math.hypot(m.a, m.b),
      scaleY = Math.hypot(m.c, m.d);
    if (
      stroke &&
      (Math.abs(scaleX - scaleY) > 1e-5 ||
        Math.abs(m.a * m.c + m.b * m.d) > 1e-5)
    )
      return reject("不等比描边变换");
    const opacity = (v: string) => {
      const n = v.endsWith("%")
        ? number(v.slice(0, -1), "opacity") / 100
        : number(v, "opacity");
      return Math.max(0, Math.min(1, n));
    };
    const cap = style["stroke-linecap"],
      join = style["stroke-linejoin"],
      rule = style["fill-rule"];
    if (
      !["butt", "square", "round"].includes(cap) ||
      !["round", "miter", "bevel"].includes(join) ||
      !["nonzero", "evenodd"].includes(rule)
    )
      return reject("描边或填充规则");
    const width = stroke
      ? scaleX * number(style["stroke-width"], "stroke-width")
      : 0;
    if (width < 0 || width > 100) return reject("描边宽度超过范围");
    paths.push({
      d: path.abs().matrix([m.a, m.b, m.c, m.d, m.e, m.f]).round(6).toString(),
      fill: !!fill,
      fillColor: fill?.hex,
      fillRule: rule as Path["fillRule"],
      strokeColor: stroke?.hex,
      strokeWidth: width,
      lineCap: cap as Path["lineCap"],
      lineJoin: join as Path["lineJoin"],
      opacity: opacity(style.opacity),
      fillOpacity: opacity(style["fill-opacity"]) * (fill?.alpha ?? 1),
      strokeOpacity: opacity(style["stroke-opacity"]) * (stroke?.alpha ?? 1),
    });
    if (paths.length > 100) return reject("单个图标最多 100 条路径");
  }
  visit(
    root,
    {
      color: "#000000",
      fill: "#000000",
      stroke: "none",
      "stroke-width": "1",
      "fill-rule": "nonzero",
      "stroke-linecap": "butt",
      "stroke-linejoin": "miter",
      "fill-opacity": "1",
      "stroke-opacity": "1",
      opacity: "1",
    },
    matrix,
    0,
  );
  if (!paths.length) return reject("没有可编辑路径");
  const node = createNode("vector");
  node.name = (
    root.querySelector("title")?.textContent?.trim() ||
    name.replace(/\.svg$/i, "") ||
    "SVG 图标"
  ).slice(0, 200);
  node.vector = { width: w, height: h, paths };
  Object.assign(node.style, { width: w, height: h, padding: 0, radius: 0 });
  const rootOpacity =
    root.getAttribute("style")?.match(/(?:^|;)\s*opacity\s*:\s*([^;]+)/)?.[1] ??
    root.getAttribute("opacity");
  if (rootOpacity) {
    const alpha = rootOpacity.trim();
    node.style.opacity = Math.min(
      1,
      Math.max(
        0,
        alpha.endsWith("%")
          ? number(alpha.slice(0, -1), "opacity") / 100
          : number(alpha, "opacity"),
      ),
    );
  }
  return node;
}
