import type { DesignDocument, DesignNode, NodeStyle } from "../domain/document";
import { effectiveModes, resolveVariable } from "../domain/design-system";
import type { DesignSystem } from "../domain/design-system-schema";
import {
  materializeSlots,
  variantFor,
  type SlotRef,
} from "../domain/component-slots";
import { instantiateComponent } from "../domain/library";
import { integrateLibrarySystem } from "../domain/library-design-system";
import type { ComponentLibrary } from "../domain/library-schema";
import { remapInteraction } from "../domain/prototype";
import { layoutBounds, type Point, type Rect } from "../domain/geometry";
import {
  maxGradientStops,
  maxLayerDimension,
  maxPageNodes,
} from "../domain/document-limits";
import type { ImageAsset } from "../domain/images";
import type { Transaction } from "./provider";

export type ArtboardRole = "primary" | "overlay" | "exception" | "detail";
export type HtmlArtboardSpec = {
  refId?: string;
  role?: ArtboardRole;
  parentRef?: string;
  name: string;
  width: number;
  height: number;
  html: string;
  css?: string;
  placement?: Point;
};
export type HtmlDesignDraft = Omit<
  HtmlArtboardSpec,
  "refId" | "role" | "parentRef"
> & {
  images?: Record<string, ImageAsset>;
  artboards?: HtmlArtboardSpec[];
  targetLibraryId?: string;
  snapLibraryTokens?: boolean;
};
export type HtmlToFormaOptions = {
  baseDocument: DesignDocument;
  name?: string;
  width?: number;
  height?: number;
  placement?: Point;
  images?: Record<string, ImageAsset>;
  selectionParentId?: string | null;
  maxNodes?: number;
  activeLibraryId?: string;
  snapLibraryTokens?: boolean;
};
export type HtmlToFormaResult = {
  transaction: Transaction;
  createdRootIds: string[];
  stats: {
    created: number;
    imagesLocalized: number;
    vectorsConverted: number;
    autoLayoutFrames: number;
    componentsInserted: number;
    tokensBound: number;
  };
  warnings: string[];
};

type IconResolver = (
  name: string,
  opts?: { color?: string; strokeWidth?: number; size?: number },
) => string | null;
type Box = Pick<DOMRect, "left" | "top" | "width" | "height">;
type Color = { hex: string; opacity: number };
type HtmlOperation = Transaction["operations"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class HtmlComponentSlotError extends Error {
  constructor(
    readonly boardName: string,
    readonly component: string,
    readonly field: string,
    reason: string,
  ) {
    super(`画板「${boardName}」组件「${component}」的 ${field}：${reason}`);
  }
}

export function resolveHtmlComponentSlot(
  doc: DesignDocument,
  el: Element,
  fallbackLibraryId?: string,
  boardName = "当前画板",
) {
  let ref = (
    el.getAttribute("data-forma-component") ||
    el.getAttribute("data-component") ||
    ""
  ).trim();
  const invalid = (field: string, reason: string): never => {
    throw new HtmlComponentSlotError(boardName, ref, field, reason);
  };
  function jsonAttribute(field: string): Record<string, unknown> {
    if (!el.hasAttribute(field)) return {};
    let value: unknown;
    try {
      value = JSON.parse(el.getAttribute(field)!);
    } catch {
      return invalid(field, "JSON 语法错误");
    }
    if (!isRecord(value)) return invalid(field, "需要 JSON 对象");
    return value;
  }
  if (!ref) return;
  const libraries = Object.values(doc.libraries ?? {});
  const qualified = libraries
    .filter(
      (lib) => ref.startsWith(lib.id + "/") || ref.startsWith(lib.id + ":"),
    )
    .sort((a, b) => b.id.length - a.id.length)[0];
  const explicit = el.hasAttribute("data-library")
    ? el.getAttribute("data-library")
    : null;
  // Installed IDs may themselves contain separators. Otherwise interpret
  // "lib/card" and "lib:card" as qualified, including an uninstalled library.
  // Human-readable paths such as "Inputs / Search" remain literal names.
  const qualifier = qualified?.id ?? /^([^\s/:]+)[/:](?=\S)/u.exec(ref)?.[1];
  if (explicit !== null && qualifier !== undefined && explicit !== qualifier)
    invalid("data-library", "与组件限定名的来源库不一致");
  if (qualifier !== undefined) ref = ref.slice(qualifier.length + 1);
  const lockedLibrary = explicit ?? qualifier;
  const preferred = lockedLibrary ?? fallbackLibraryId;
  const groups = [libraries.filter((lib) => lib.id === preferred)];
  if (lockedLibrary === undefined)
    groups.push(libraries.filter((lib) => lib.id !== preferred));
  const props = Object.entries(jsonAttribute("data-variant-props"));
  const overrides = jsonAttribute("data-overrides");
  for (const group of groups) {
    const byName = (c: ComponentLibrary["components"][number]) =>
      c.name.toLowerCase() === ref.toLowerCase();
    const library =
      group.find((l) => l.components.some((c) => c.id === ref)) ??
      group.find((l) => l.components.some(byName));
    if (!library) continue;
    const component =
      library.components.find((c) => c.id === ref) ??
      library.components.find(byName)!;
    const variantId = el.getAttribute("data-variant");
    const candidates = el.hasAttribute("data-variant")
      ? component.variants.filter((v) => v.id === variantId)
      : component.variants;
    if (!candidates.length) invalid("data-variant", "找不到变体 " + variantId);
    const variant =
      candidates.find((candidate) =>
        props.every(
          ([key, value]) =>
            Object.hasOwn(candidate.properties, key) &&
            candidate.properties[key] === value,
        ),
      ) ??
      invalid(
        "data-variant-props",
        "没有变体完整匹配 " + JSON.stringify(Object.fromEntries(props)),
      );
    const choices: Record<string, SlotRef> = Object.create(null);
    const swaps = [];
    let live = variant;
    const stableKeys = new Set(variant.nodes.map((n) => n.templateKey));
    if (overrides.slots !== undefined && !isRecord(overrides.slots))
      return invalid("data-overrides.slots", "需要插槽对象");
    for (const [key, raw] of Object.entries(overrides.slots ?? {})) {
      const field = "data-overrides.slots." + key;
      const property =
        component.exposed?.find(
          (p) => p.kind === "swap" && (p.id === key || p.name === key),
        ) ?? invalid(field, "找不到公开的 swap 插槽");
      if (!isRecord(raw)) return invalid(field, "需要替换组件对象");
      const { libraryId, componentId, variantId } = raw;
      if (
        typeof libraryId !== "string" ||
        typeof componentId !== "string" ||
        typeof variantId !== "string"
      )
        return invalid(
          field,
          "需要替换组件的 libraryId、componentId 和 variantId",
        );
      const choice = { libraryId, componentId, variantId };
      if (libraryId === library.id && componentId === component.id)
        invalid(field, "不能替换为自身");
      if (
        !Object.hasOwn(doc.libraries ?? {}, libraryId) ||
        !variantFor(doc, choice)
      )
        invalid(field, "找不到替换组件或变体");
      if (live.nodes.some((n) => n.locked)) invalid(field, "组件包含锁定图层");
      choices[property.target] = choice;
      try {
        live = materializeSlots(doc, variant, choices);
      } catch (error) {
        invalid(field, String(error));
      }
      const keys = new Set(live.nodes.map((n) => n.templateKey));
      for (const k of stableKeys) if (!keys.has(k)) stableKeys.delete(k);
      swaps.push({ property: property.id, choice });
    }
    return { library, component, variant, overrides, swaps, live, stableKeys };
  }
  if (lockedLibrary !== undefined)
    invalid("data-library", "在指定库中找不到该组件：" + lockedLibrary);
}
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
function numeric(value: string | null | undefined, fallback = 0) {
  const n = parseFloat(value ?? "");
  return Number.isFinite(n) ? n : fallback;
}
const pixel = (value: string, max = 1000) => clamp(numeric(value), 0, max);

function cleanCss(input: string) {
  // Read whole CSS strings/functions so punctuation inside a data URI or a
  // quoted font name never terminates the containing declaration.
  const token =
    /\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\\(?:[\da-f]{1,6}\s?|[\s\S])|[\w@-]+|[^]/gi;
  const tokens =
    input.match(token)?.map((t) => (t.startsWith("/*") ? " " : t)) ?? [];
  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // Escaped identifiers can spell at-rules and function names. Drop the
    // stylesheet conservatively. Escapes inside quoted values are preserved.
    if (t.startsWith("\\")) return "";
    if (t.toLowerCase() === "@import") {
      while (i + 1 < tokens.length && tokens[++i] !== ";") {
        /* skip rule */
      }
      continue;
    }
    if (/^(?:url|expression)$/i.test(t)) {
      let open = i + 1;
      while (open < tokens.length && !tokens[open].trim()) open++;
      if (tokens[open] === "(") {
        let end = open + 1,
          depth = 1;
        while (end < tokens.length) {
          if (tokens[end] === "(") depth++;
          if (tokens[end] === ")" && --depth === 0) break;
          end++;
        }
        const value = tokens
          .slice(open + 1, end)
          .join("")
          .trim()
          .replace(/^(["'])([\s\S]*)\1$/, "$2");
        const local =
          /^data:image\/[a-z\d.+-]+[;,]/i.test(value) ||
          /^#[\w.-]+$/.test(value);
        result.push(
          t.toLowerCase() === "url" && local && end < tokens.length
            ? tokens.slice(i, end + 1).join("")
            : "none",
        );
        i = end;
        continue;
      }
    }
    result.push(t);
  }
  return result.join("");
}

export function sanitizeDesignHtml(
  html: string,
  css = "",
): { html: string; css: string } {
  // Template contents belong to an inert document, including image elements.
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const el of template.content.querySelectorAll("*")) {
    const tag = el.localName.toLowerCase();
    if (
      /^(script|iframe|frame|frameset|object|embed|link|meta|base|template|noscript|foreignobject|animate.*|set|discard|math|xmp|plaintext|noembed|noframes)$/.test(
        tag,
      )
    ) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.localName.toLowerCase();
      const value = attr.value
        .replace(/[\u0000-\u0020\u007f]/g, "")
        .toLowerCase();
      if (
        name.startsWith("on") ||
        /^(srcdoc|srcset|imagesrcset|ping|is)$/.test(name) ||
        /^(javascript|vbscript):/.test(value) ||
        (/^(href|src|action|formaction|poster|background|data)$/.test(name) &&
          value.startsWith("data:") &&
          !value.startsWith("data:image/"))
      ) {
        el.removeAttributeNode(attr);
      } else if (
        name === "style" ||
        (/url\s*\(/i.test(attr.value) &&
          /^(fill|stroke|filter|mask|clip-path|cursor|marker.*)$/.test(name))
      ) {
        el.setAttribute(attr.name, cleanCss(attr.value));
      }
    }
    if (tag === "style") el.textContent = cleanCss(el.textContent ?? "");
  }
  return { html: template.innerHTML, css: cleanCss(css) };
}

export function hydrateIconsInDom(
  rootEl: Element,
  iconResolver: IconResolver,
): number {
  const selector = "[data-icon], [data-lucide]";
  let count = 0;
  for (const el of [
    ...(rootEl.matches(selector) ? [rootEl] : []),
    ...rootEl.querySelectorAll(selector),
  ]) {
    const name = el.getAttribute("data-icon") || el.getAttribute("data-lucide");
    if (!name) continue;
    const cs = el.ownerDocument.defaultView!.getComputedStyle(el);
    const size =
      [
        el.getAttribute("data-size"),
        el.getAttribute("width"),
        cs.width,
        cs.fontSize,
      ]
        .map((v) => numeric(v))
        .find((n) => n > 0) ?? 20;
    const svg = iconResolver(name, {
      size,
      color: el.getAttribute("data-color") || cs.color || "currentColor",
      strokeWidth: numeric(el.getAttribute("data-stroke-width"), 1.75),
    });
    if (!svg) continue;
    const template = el.ownerDocument.createElement("template");
    template.innerHTML = svg;
    const resolved = template.content.firstElementChild;
    if (resolved?.localName !== "svg") continue;
    const label = el.getAttribute("data-forma-name") || name;
    resolved.setAttribute("data-forma-name", label);
    if (el.localName === "svg") {
      for (const attr of Array.from(resolved.attributes))
        el.setAttribute(attr.name, attr.value);
      el.replaceChildren(...Array.from(resolved.childNodes));
    } else el.replaceChildren(resolved);
    count++;
  }
  return count;
}

// Split commas or whitespace only at the outermost level of a CSS value.
function parts(value: string, whitespace = false): string[] {
  const out: string[] = [];
  let start = 0,
    depth = 0,
    quote = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (!depth && (whitespace ? /\s/.test(c) : c === ",")) {
      if (i > start) out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (start < value.length) out.push(value.slice(start).trim());
  return out.filter(Boolean);
}
function angle(value: string) {
  const match = /^([-+]?(?:\d*\.)?\d+)(deg|rad|turn|grad)?$/.exec(value);
  if (!match) return;
  const degrees =
    Number(match[1]) *
    ({ rad: 180 / Math.PI, turn: 360, grad: 0.9 }[match[2]] ?? 1);
  return ((degrees % 360) + 360) % 360;
}
function fraction(value: string) {
  return parseFloat(value) / (value.endsWith("%") ? 100 : 1);
}

export function parseCssColor(value: string): Color | null {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return { hex: "#000000", opacity: 0 };
  const named: Record<string, string> = {
    black: "#000000",
    white: "#ffffff",
    red: "#ff0000",
    green: "#008000",
    blue: "#0000ff",
    gray: "#808080",
    yellow: "#ffff00",
  };
  if (Object.hasOwn(named, v)) return { hex: named[v], opacity: 1 };
  if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.test(v)) {
    const hex =
      v.length <= 5 ? v.slice(1).replace(/./g, (c) => c + c) : v.slice(1);
    return {
      hex: "#" + hex.slice(0, 6),
      opacity: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1,
    };
  }
  const fn = /^(rgb|hsl)a?\(([^()]*)\)$/.exec(v);
  if (!fn) return null;
  const channels = fn[2].trim().split(/\s*[,/]\s*|\s+/);
  if (
    channels.length < 3 ||
    channels.length > 4 ||
    !channels.every((c) =>
      /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:%|deg|rad|grad|turn)?$/.test(
        c,
      ),
    )
  )
    return null;
  let rgb: number[];
  if (fn[1] === "rgb")
    rgb = channels
      .slice(0, 3)
      .map((c) => (c.endsWith("%") ? fraction(c) * 255 : Number(c)));
  else {
    const h = angle(channels[0]);
    if (
      h === undefined ||
      !channels[1].endsWith("%") ||
      !channels[2].endsWith("%")
    )
      return null;
    const s = clamp(fraction(channels[1]), 0, 1),
      l = clamp(fraction(channels[2]), 0, 1);
    rgb = [0, 8, 4].map((n) => {
      const k = (n + h / 30) % 12;
      return (
        255 *
        (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)))
      );
    });
  }
  if (!rgb.every(Number.isFinite)) return null;
  return {
    hex:
      "#" +
      rgb
        .map((c) =>
          Math.round(clamp(c, 0, 255))
            .toString(16)
            .padStart(2, "0"),
        )
        .join(""),
    opacity: clamp(fraction(channels[3] ?? "1"), 0, 1),
  };
}

function parseSingleCssGradient(
  layer: string,
): NodeStyle["gradient"] | undefined {
  const match = /^(linear|radial)-gradient\(([\s\S]*)\)$/i.exec(layer.trim());
  if (!match) return;
  const type = match[1].toLowerCase() === "linear" ? "linear" : "radial";
  const args = parts(match[2]);
  let degrees = 180;
  const first = args[0]?.toLowerCase() ?? "";
  if (type === "linear" && first.startsWith("to ")) {
    const x = Number(first.includes("right")) - Number(first.includes("left"));
    const y = Number(first.includes("top")) - Number(first.includes("bottom"));
    degrees = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
    args.shift();
  } else if (type === "linear" && angle(first) !== undefined) {
    degrees = angle(first)!;
    args.shift();
  } else if (type === "radial" && !parseCssColor(parts(first, true)[0] ?? ""))
    args.shift();

  const stops: NonNullable<NodeStyle["gradient"]>["stops"] = [];
  for (const arg of args) {
    const [color, ...positions] = parts(arg, true);
    const parsed = parseCssColor(color);
    if (!parsed || positions.some((p) => !/^[-+]?(?:\d*\.)?\d+%$/.test(p)))
      return;
    for (const pos of positions.length ? positions : [""]) {
      stops.push({
        color: parsed.hex,
        opacity: parsed.opacity,
        offset: pos ? clamp(fraction(pos), 0, 1) : NaN,
      });
    }
  }
  if (stops.length < 2 || stops.length > maxGradientStops) return;
  if (Number.isNaN(stops[0].offset)) stops[0].offset = 0;
  if (Number.isNaN(stops.at(-1)!.offset)) stops.at(-1)!.offset = 1;
  let last = 0;
  for (let i = 1; i < stops.length; i++) {
    if (Number.isNaN(stops[i].offset)) continue;
    const from = stops[last].offset,
      to = Math.max(stops[i].offset, from);
    for (let j = last + 1; j <= i; j++)
      stops[j].offset = from + ((to - from) * (j - last)) / (i - last);
    last = i;
  }
  return { type, angle: degrees, stops };
}

export function parseCssGradient(
  bgImage: string,
): NodeStyle["gradient"] | undefined {
  for (const layer of parts(bgImage)) {
    const parsed = parseSingleCssGradient(layer);
    if (parsed) return parsed;
  }
  return undefined;
}

export function parseCssBoxShadows(
  boxShadow: string,
): NodeStyle["shadows"] | undefined {
  const shadows: NonNullable<NodeStyle["shadows"]> = [];
  for (const shadow of parts(boxShadow).slice(0, 32)) {
    let color: Color = { hex: "#000000", opacity: 1 },
      inset = false;
    const lengths: number[] = [];
    for (const word of parts(shadow, true)) {
      if (word === "inset") inset = true;
      else if (/^[-+]?(?:\d*\.)?\d+(?:px)?$/i.test(word))
        lengths.push(numeric(word));
      else {
        const parsed = parseCssColor(word);
        if (!parsed) return;
        color = parsed;
      }
    }
    if (lengths.length < 2 || lengths.length > 4) return;
    const [x, y, blur = 0, spread = 0] = lengths;
    shadows.push({
      x: clamp(x, -1000, 1000),
      y: clamp(y, -1000, 1000),
      blur: clamp(blur, 0, 1000),
      spread: clamp(spread, -1000, 1000),
      color: color.hex,
      opacity: color.opacity,
      inset,
    });
  }
  return shadows.length ? shadows : undefined;
}

export function parseCssBackdropFilter(
  filter: string,
): Pick<
  NodeStyle,
  | "backdropBlur"
  | "backdropBlurVisible"
  | "backdropSaturation"
  | "backdropBrightness"
> {
  const result: ReturnType<typeof parseCssBackdropFilter> = {};
  for (const [, fn, v] of filter.matchAll(
    /\b(blur|saturate|brightness)\(\s*([-+]?(?:\d*\.)?\d+(?:px|%)?)\s*\)/gi,
  )) {
    switch (fn.toLowerCase()) {
      case "blur":
        result.backdropBlur = pixel(v, 512);
        result.backdropBlurVisible = true;
        break;
      case "saturate":
        result.backdropSaturation = clamp(fraction(v), 0, 4);
        break;
      case "brightness":
        result.backdropBrightness = clamp(fraction(v), 0, 4);
        break;
    }
  }
  return result;
}

type Vector = NonNullable<DesignNode["vector"]>;
type Computed = (el: Element) => CSSStyleDeclaration;

function shapePath(el: Element): string {
  const n = (key: string, fallback = 0) =>
    numeric(el.getAttribute(key), fallback);
  switch (el.localName) {
    case "path":
      return el.getAttribute("d")?.trim() ?? "";
    case "line":
      return `M${n("x1")} ${n("y1")}L${n("x2")} ${n("y2")}`;
    case "circle":
    case "ellipse": {
      const x = n("cx"),
        y = n("cy"),
        rx = n("rx", n("r")),
        ry = n("ry", n("r"));
      return rx > 0 && ry > 0
        ? `M${x - rx} ${y}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`
        : "";
    }
    case "rect": {
      const x = n("x"),
        y = n("y"),
        w = n("width"),
        h = n("height");
      if (w <= 0 || h <= 0) return "";
      const rx = clamp(n("rx", n("ry")), 0, w / 2),
        ry = clamp(n("ry", n("rx")), 0, h / 2);
      if (!rx || !ry) return `M${x} ${y}h${w}v${h}h${-w}Z`;
      const arc = `a${rx} ${ry} 0 0 1 `;
      return `M${x + rx} ${y}h${w - 2 * rx}${arc}${rx} ${ry}v${h - 2 * ry}${arc}${-rx} ${ry}h${2 * rx - w}${arc}${-rx} ${-ry}v${2 * ry - h}${arc}${rx} ${-ry}Z`;
    }
    case "polyline":
    case "polygon": {
      const points = (el.getAttribute("points") ?? "")
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      return points.length >= 4 &&
        !(points.length % 2) &&
        points.every(Number.isFinite)
        ? "M" + points.join(" ") + (el.localName === "polygon" ? "Z" : "")
        : "";
    }
    default:
      return "";
  }
}

// Forma viewBoxes start at (0, 0). Rebase absolute path coordinates and
// the initial relative moveto, leaving arc radii, flags and deltas unchanged.
function rebasePath(path: string, vx: number, vy: number) {
  if (!vx && !vy) return path;
  const arity: Record<string, number> = {
    m: 2,
    l: 2,
    h: 1,
    v: 1,
    c: 6,
    s: 4,
    q: 4,
    t: 2,
    a: 7,
    z: 0,
  };
  let first = true;
  return path.replace(
    /([mzlhvcsqta])([^mzlhvcsqta]*)/gi,
    (_, cmd: string, args: string) => {
      const key = cmd.toLowerCase(),
        relative = key === cmd;
      let index = 0;
      const numbers =
        args.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) ?? [];
      const result = numbers.map((raw) => {
        const axis = index++ % arity[key];
        if (relative && !(first && key === "m" && index <= 2)) return raw;
        if (key === "a" && axis < 5) return raw;
        const horizontal =
          key === "h" ||
          (key !== "v" && (key === "a" ? axis === 5 : axis % 2 === 0));
        return String(Number(raw) - (horizontal ? vx : vy));
      });
      first = false;
      return cmd + result.join(" ");
    },
  );
}

function readVector(
  svg: Element,
  box: Box,
  computed: Computed,
  warn: (message: string) => void,
): Vector | undefined {
  const vb = svg
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  const [vx, vy, w, h] =
    vb?.length === 4 && vb.every(Number.isFinite)
      ? vb
      : [
          0,
          0,
          numeric(svg.getAttribute("width"), box.width),
          numeric(svg.getAttribute("height"), box.height),
        ];
  const paths: Vector["paths"] = [];
  for (const shape of svg.querySelectorAll(
    "path,circle,ellipse,rect,line,polyline,polygon",
  )) {
    if (
      shape.closest("defs,clipPath,mask,symbol,pattern,marker") ||
      shape.closest("svg") !== svg
    )
      continue;
    const cs = computed(shape);
    if (cs.visibility === "hidden" || cs.visibility === "collapse") continue;
    // Group opacity multiplies child paint opacity. The outer SVG's opacity
    // is already on the Forma node and must only be applied once.
    let opacity = 1;
    for (
      let group: Element | null = shape;
      group && group !== svg;
      group = group.parentElement
    ) {
      const style = computed(group);
      if (style.display === "none") {
        opacity = 0;
        break;
      }
      opacity *= clamp(
        numeric(style.opacity || group.getAttribute("opacity"), 1),
        0,
        1,
      );
    }
    if (!opacity) continue;
    const inherited = (prop: string, fallback: string) =>
      cs.getPropertyValue(prop) ||
      shape.closest(`[${prop}]`)?.getAttribute(prop) ||
      fallback;
    const ink = (prop: string, fallback: string) => {
      const raw = inherited(prop, fallback);
      return parseCssColor(
        raw.toLowerCase() === "currentcolor"
          ? cs.color || computed(svg).color || "#000000"
          : raw,
      );
    };
    const fill = ink("fill", "black"),
      stroke = ink("stroke", "none");
    if (!fill && !stroke) continue;
    const raw = shapePath(shape);
    if (
      !/^[Mm][MmZzLlHhVvCcSsQqTtAaEe0-9.,+\s-]+$/.test(raw) ||
      raw.length > 100000
    ) {
      warn("部分 SVG 路径无效或过长");
      continue;
    }
    const d = rebasePath(raw, vx, vy);
    if (d.length > 100000) {
      warn("部分 SVG 路径过长");
      continue;
    }
    if (paths.length >= 100) {
      warn("单个矢量最多导入 100 条路径");
      break;
    }
    const lineCap = inherited("stroke-linecap", "butt"),
      lineJoin = inherited("stroke-linejoin", "miter");
    paths.push({
      d,
      fill: !!fill,
      fillColor: fill?.hex,
      strokeColor: stroke?.hex,
      strokeWidth: stroke ? pixel(inherited("stroke-width", "1"), 100) : 0,
      fillOpacity:
        (fill?.opacity ?? 0) *
        clamp(fraction(inherited("fill-opacity", "1")), 0, 1),
      strokeOpacity:
        (stroke?.opacity ?? 0) *
        clamp(fraction(inherited("stroke-opacity", "1")), 0, 1),
      opacity,
      fillRule:
        inherited("fill-rule", "nonzero") === "evenodd" ? "evenodd" : "nonzero",
      lineCap: lineCap === "round" || lineCap === "square" ? lineCap : "butt",
      lineJoin:
        lineJoin === "round" || lineJoin === "bevel" ? lineJoin : "miter",
    });
  }
  if (paths.length)
    return {
      width: clamp(w || 24, 0.001, 10000),
      height: clamp(h || 24, 0.001, 10000),
      paths,
      ...(svg.getAttribute("preserveAspectRatio") === "none"
        ? { stretch: true }
        : {}),
    };
}

function surface(
  el: Element,
  cs: CSSStyleDeclaration,
  box: Box,
): Partial<NodeStyle> {
  const color = parseCssColor(cs.backgroundColor || "transparent");
  const bgLayers = parts(cs.backgroundImage || "");
  const bitmap = bgLayers.findIndex((layer) => /^url\(/i.test(layer));
  const gradients = bgLayers
    .map((layer, index) => ({
      index,
      gradient: parseSingleCssGradient(layer),
    }))
    .filter(
      (
        entry,
      ): entry is {
        index: number;
        gradient: NonNullable<NodeStyle["gradient"]>;
      } => Boolean(entry.gradient),
    );
  const hasGradient = gradients.length > 0;
  const radius = (raw: string) => {
    const val = (raw || "0").split(/\s/)[0];
    return clamp(
      val.endsWith("%")
        ? fraction(val) * Math.min(box.width, box.height)
        : numeric(val),
      0,
      10000,
    );
  };
  const corners = {
    tl: radius(cs.borderTopLeftRadius || cs.borderRadius),
    tr: radius(cs.borderTopRightRadius || cs.borderRadius),
    br: radius(cs.borderBottomRightRadius || cs.borderRadius),
    bl: radius(cs.borderBottomLeftRadius || cs.borderRadius),
  };
  const radii = Object.values(corners);
  const s: Partial<NodeStyle> = {
    fill: color?.hex ?? "#000000",
    fillOpacity: hasGradient ? 1 : (color?.opacity ?? 0),
    radius: corners.tl,
    opacity: clamp(numeric(cs.opacity, 1), 0, 1),
  };
  if (!radii.every((r) => r === corners.tl)) s.corners = corners;
  if (el.hasAttribute("data-squircle") || Math.max(...radii) >= 24) {
    s.cornerSmoothing = 0.6;
    s.cornerSmoothingModel = "figma";
  }
  if (hasGradient) {
    // Both CSS background-image and Forma stackPaints() list overlay layers top-to-bottom,
    // with `s.gradient` (or `s.fill`) rendered as the bottommost base layer.
    const toPaint = (
      g: NonNullable<NodeStyle["gradient"]>,
      idx: number,
    ): NonNullable<NodeStyle["paints"]>[number] => ({
      id: idx === 0 ? "gradient" : `gradient-${idx}`,
      visible: true,
      color: "#000000",
      opacity: 1,
      gradient: g,
    });
    if (bitmap >= 0) {
      const above = gradients.filter((g) => g.index < bitmap);
      const below = gradients.filter((g) => g.index > bitmap);
      if (color?.opacity) {
        s.fillOpacity = color.opacity;
        const stacked = [...above, ...below];
        if (stacked.length)
          s.paints = stacked.map((g, i) => toPaint(g.gradient, i));
      } else if (below.length) {
        s.gradient = below.at(-1)!.gradient;
        s.fillOpacity = 1;
        const extra = [...above, ...below.slice(0, -1)];
        if (extra.length)
          s.paints = extra.map((g, i) => toPaint(g.gradient, i));
      } else if (above.length) {
        s.fillOpacity = 0;
        s.paints = above.map((g, i) => toPaint(g.gradient, i));
      }
    } else if (color?.opacity) {
      s.fillOpacity = color.opacity;
      s.paints = gradients.map((g, i) => toPaint(g.gradient, i));
    } else {
      s.gradient = gradients.at(-1)!.gradient;
      s.fillOpacity = 1;
      if (gradients.length > 1) {
        s.paints = gradients.slice(0, -1).map((g, i) => toPaint(g.gradient, i));
      }
    }
  }
  const sides = ["top", "right", "bottom", "left"] as const;
  const border = sides.map((side) => {
    const prefix = "border-" + side + "-";
    const style = cs.getPropertyValue(prefix + "style");
    const width =
      style === "none" || style === "hidden"
        ? 0
        : numeric(cs.getPropertyValue(prefix + "width"));
    return {
      style,
      width,
      color:
        parseCssColor(cs.getPropertyValue(prefix + "color")) ??
        parseCssColor(cs.color),
    };
  });
  const primary = border.find((b) => b.width > 0);
  if (primary) {
    s.stroke = primary.color?.hex ?? "#000000";
    s.strokeOpacity = primary.color?.opacity ?? 1;
    s.strokeWidth = clamp(primary.width, 0, 100);
    s.strokeAlign = "inside";
    s.strokeStyle =
      primary.style === "dashed" ||
      primary.style === "dotted" ||
      primary.style === "double"
        ? primary.style
        : "solid";
    if (!border.every((b) => b.width === primary.width))
      s.strokeSides = Object.fromEntries(
        sides.map((side, i) => [side, clamp(border[i].width, 0, 64)]),
      );
  }
  const shadows = parseCssBoxShadows(cs.boxShadow || "");
  if (shadows) s.shadows = shadows;
  if (
    [cs.overflow, cs.overflowX, cs.overflowY].some(
      (v) => v === "hidden" || v === "clip",
    )
  )
    s.clipContent = true;
  const blur = /\bblur\(([^)]+)\)/.exec(cs.filter ?? "");
  if (blur) {
    s.blur = pixel(blur[1], 100);
    s.blurVisible = true;
  }
  return Object.assign(
    s,
    parseCssBackdropFilter(
      cs.backdropFilter ||
        cs.getPropertyValue("backdrop-filter") ||
        cs.getPropertyValue("-webkit-backdrop-filter") ||
        "",
    ),
  );
}

function typography(cs: CSSStyleDeclaration): Partial<NodeStyle> {
  const ink = parseCssColor(cs.color),
    size = clamp(numeric(cs.fontSize, 16), 1, 500);
  const line = cs.lineHeight;
  const lineHeight =
    !line || line === "normal"
      ? size * 1.2
      : line.endsWith("%")
        ? size * fraction(line)
        : numeric(line) * (line.endsWith("px") ? 1 : size);
  const decor = cs.textDecorationLine || cs.textDecoration || "";
  const align = cs.textAlign,
    transform = cs.textTransform;
  const maxLines = numeric(cs.getPropertyValue("-webkit-line-clamp"));
  return {
    color: ink?.hex ?? "#000000",
    colorOpacity: ink?.opacity ?? 1,
    fontSize: size,
    fontFamily: (cs.fontFamily || "sans-serif").slice(0, 200),
    fontWeight: Math.round(
      clamp(
        numeric(cs.fontWeight, cs.fontWeight === "bold" ? 700 : 400),
        100,
        900,
      ),
    ),
    fontStyle: /italic|oblique/.test(cs.fontStyle) ? "italic" : "normal",
    lineHeight: clamp(lineHeight, 1, 1000),
    letterSpacing: clamp(numeric(cs.letterSpacing), -50, 200),
    textAlign:
      align === "center" || align === "justify"
        ? align
        : align === "right" || align === "end"
          ? "right"
          : "left",
    textTransform:
      transform === "uppercase" ||
      transform === "lowercase" ||
      transform === "capitalize"
        ? transform
        : "none",
    textDecoration: decor.includes("underline")
      ? "underline"
      : decor.includes("line-through")
        ? "line-through"
        : "none",
    ...(maxLines > 0 ? { maxLines: Math.round(clamp(maxLines, 1, 100)) } : {}),
  };
}

function normalizeText(value: string, cs: CSSStyleDeclaration) {
  if (/^(pre|pre-wrap|break-spaces)$/.test(cs.whiteSpace)) return value;
  if (cs.whiteSpace === "pre-line")
    return value.replace(/[\t\f ]+/g, " ").trim();
  return value.replace(/[\t\n\f\r ]+/g, " ").trim();
}
// Inline emphasis belongs to one editable paragraph. Flex items and painted
// spans retain their own boxes and are handled by the ordinary child walk.
function inlineParagraph(
  el: Element,
  cs: CSSStyleDeclaration,
  computed: Computed,
) {
  if (
    !el.childElementCount ||
    !/^(?:p|h[1-6]|label|span|button|a)$/.test(el.localName) ||
    /flex|grid/.test(cs.display)
  )
    return;
  const runs: NonNullable<DesignNode["textRuns"]> = [];
  const base = typography(cs);
  let text = "";
  function append(
    owner: Element,
    css: CSSStyleDeclaration,
    depth: number,
  ): boolean {
    if (depth > 64) return false;
    for (const n of owner.childNodes) {
      if (n.nodeType === 3) {
        const raw = n.textContent ?? "";
        const pre = /^(pre|pre-wrap|break-spaces)$/.test(css.whiteSpace);
        let part = pre ? raw : raw.replace(/[\t\n\f\r ]+/g, " ");
        if (!pre && (!text || /[ \n]$/.test(text)))
          part = part.replace(/^ /, "");
        if (!part) continue;
        const start = text.length;
        text += part;
        if (text.length > 50000) return false;
        if (owner !== el) {
          const fmt = typography(css);
          const style: (typeof runs)[number]["style"] = {};
          for (const key of [
            "fontWeight",
            "fontSize",
            "letterSpacing",
          ] as const)
            if (fmt[key] !== base[key]) style[key] = fmt[key];
          for (const key of ["fontFamily", "color"] as const)
            if (fmt[key] !== base[key]) style[key] = fmt[key];
          if (fmt.fontStyle === "italic" && base.fontStyle !== "italic")
            style.fontStyle = "italic";
          if (
            fmt.textDecoration !== base.textDecoration &&
            (fmt.textDecoration === "underline" ||
              fmt.textDecoration === "line-through")
          )
            style.textDecoration = fmt.textDecoration;
          if (
            fmt.colorOpacity !== base.colorOpacity ||
            fmt.textTransform !== base.textTransform
          )
            return false;
          if (Object.keys(style).length)
            runs.push({ start, end: text.length, style });
        }
      } else if (n.nodeType === 1) {
        const child = n as Element,
          childCss = computed(child);
        if (
          childCss.display === "none" ||
          childCss.visibility === "hidden" ||
          numeric(childCss.opacity, 1) === 0
        )
          continue;
        if (child.localName === "br") {
          text += "\n";
          continue;
        }
        if (
          !/^(?:span|b|strong|i|em|u|s|del|small)$/.test(child.localName) ||
          (childCss.display && childCss.display !== "inline") ||
          childCss.position === "absolute" ||
          childCss.position === "fixed" ||
          numeric(childCss.opacity, 1) !== 1 ||
          child.hasAttribute("data-forma-component") ||
          child.hasAttribute("data-forma-name") ||
          (parseCssColor(childCss.backgroundColor)?.opacity ?? 0) > 0 ||
          (childCss.backgroundImage && childCss.backgroundImage !== "none") ||
          [
            childCss.paddingTop,
            childCss.paddingBottom,
            childCss.paddingLeft,
            childCss.paddingRight,
            childCss.borderTopWidth,
            childCss.borderRightWidth,
            childCss.borderBottomWidth,
            childCss.borderLeftWidth,
          ].some((v) => numeric(v) > 0) ||
          !append(child, childCss, depth + 1)
        )
          return false;
      }
    }
    return true;
  }
  if (!append(el, cs, 0) || !text || runs.length > 10000) return;
  if (!/^(pre|pre-wrap|break-spaces)$/.test(cs.whiteSpace))
    text = text.replace(/ +$/, "");
  return {
    text,
    runs: runs
      .map((run) => ({ ...run, end: Math.min(run.end, text.length) }))
      .filter((run) => run.end > run.start),
  };
}
function measureText(node: Node, fallback: Box) {
  const range = node.ownerDocument!.createRange();
  range.selectNodeContents(node);
  const rects = Array.from(range.getClientRects?.() ?? []).filter(
    (r) => r.width > 0 && r.height > 0,
  );
  const bounds = range.getBoundingClientRect?.();
  if (bounds?.width && bounds.height)
    return { box: bounds, lines: new Set(rects.map((r) => r.top)).size || 1 };
  if (!rects.length) return { box: fallback, lines: 1 };
  const left = Math.min(...rects.map((r) => r.left)),
    top = Math.min(...rects.map((r) => r.top));
  return {
    box: {
      left,
      top,
      width: Math.max(...rects.map((r) => r.left + r.width)) - left,
      height: Math.max(...rects.map((r) => r.top + r.height)) - top,
    },
    lines: new Set(rects.map((r) => r.top)).size,
  };
}
function label(el: Element, text = "") {
  const semantic =
    el.getAttribute("data-forma-name") ||
    el.getAttribute("aria-label") ||
    el.getAttribute("alt");
  const cls = el.getAttribute("class")?.trim().split(/\s+/)[0];
  return (
    semantic ||
    text.trim().slice(0, 60) ||
    el.getAttribute("data-icon") ||
    el.getAttribute("data-lucide") ||
    (cls ? el.localName + "." + cls : el.localName)
  )
    .trim()
    .slice(0, 200);
}

function gridColumns(value: string) {
  const tracks = parts((value || "").replace(/\[[^\]]*\]/g, " "), true);
  const expanded: string[] = [];
  for (const track of tracks) {
    if (track === "none") continue;
    const repeat = /^repeat\(\s*(\d+)\s*,\s*(.*)\)$/i.exec(track);
    if (!repeat) expanded.push(track);
    else
      for (let i = 0; i < Math.min(64, Number(repeat[1])); i++)
        expanded.push(...parts(repeat[2], true));
    if (expanded.length >= 64) break;
  }
  const valid =
    expanded.length > 0 &&
    expanded.length <= 64 &&
    expanded.every(
      (t) =>
        t === "auto" ||
        (/^(?:\d*\.)?\d+(px|fr)$/.test(t) &&
          numeric(t) > 0 &&
          numeric(t) <= 10000),
    ) &&
    expanded.join(" ").length <= 1024;
  return {
    columns: clamp(expanded.length, 1, 64),
    ...(valid ? { gridTracks: expanded.join(" ") } : {}),
  };
}
type Child = { node: Node; box: Box; absolute: boolean };
function frameLayout(
  cs: CSSStyleDeclaration,
  children: Child[],
  box: Box,
): Partial<NodeStyle> {
  const insets = {
    top: pixel(cs.paddingTop),
    right: pixel(cs.paddingRight),
    bottom: pixel(cs.paddingBottom),
    left: pixel(cs.paddingLeft),
  };
  const s: Partial<NodeStyle> = {
    insets,
    padding: insets.top,
    layout: "free",
    gap: 0,
  };
  const align = (v: string) =>
    v === "center" ? "center" : /end|right|bottom/.test(v) ? "end" : "start";
  const [rows = "0", columns = rows] = parts(cs.gap || "", true);
  const rowGap = pixel(cs.rowGap || rows),
    colGap = pixel(cs.columnGap || columns);
  if (cs.display === "grid" || cs.display === "inline-grid") {
    const gridCols = gridColumns(cs.gridTemplateColumns);
    const flowCount = children.filter((child) => !child.absolute).length;
    const colCount =
      "columns" in gridCols && typeof gridCols.columns === "number"
        ? gridCols.columns
        : 1;
    const jx =
      cs.justifyItems && cs.justifyItems !== "normal"
        ? cs.justifyItems
        : cs.justifyContent;
    const ay =
      cs.alignItems && cs.alignItems !== "normal"
        ? cs.alignItems
        : cs.alignContent;
    if (
      colCount <= 1 &&
      flowCount <= 1 &&
      (align(jx) === "center" || align(ay) === "center")
    ) {
      // Single-cell `display: grid; place-items: center` is an icon/content
      // centering wrapper; map it to centered AutoLayout so Forma centers vertically.
      Object.assign(s, {
        layout: "row",
        gap: 0,
        rowGap: 0,
        alignX: align(jx),
        alignY: align(ay),
        justifyContent: "pack",
      });
    } else {
      Object.assign(s, gridCols, {
        layout: "grid",
        gap: colGap,
        rowGap,
        alignX: align(cs.justifyItems),
        alignY: align(cs.alignItems),
      });
    }
  } else if (cs.display === "flex" || cs.display === "inline-flex") {
    const row = !(cs.flexDirection || "row").startsWith("column");
    Object.assign(s, {
      layout: row ? "row" : "column",
      gap: row ? colGap : rowGap,
      rowGap: row ? rowGap : colGap,
      alignX: align(row ? cs.justifyContent : cs.alignItems),
      alignY: align(row ? cs.alignItems : cs.justifyContent),
      justifyContent:
        cs.justifyContent === "space-between" ? "space-between" : "pack",
    });
    if (cs.flexWrap === "wrap" || cs.flexWrap === "wrap-reverse") s.wrap = true;
    if (cs.flexDirection?.endsWith("reverse")) s.layoutReverse = true;
  } else if (
    (!cs.display || cs.display === "block" || cs.display === "flow-root") &&
    children.length &&
    !children.some((child) => child.absolute)
  ) {
    // Normal flow can include collapsed margins. Only promote it to a stack
    // when one set of insets and a single gap reproduce the measured boxes.
    const first = children[0].box;
    const gaps = children
      .slice(1)
      .map(
        ({ box: b }, i) => b.top - children[i].box.top - children[i].box.height,
      );
    const left = first.left - box.left - pixel(cs.borderLeftWidth);
    const top = first.top - box.top - pixel(cs.borderTopWidth);
    if (
      left >= -0.5 &&
      top >= -0.5 &&
      children.every((c) => Math.abs(c.box.left - first.left) < 0.75) &&
      gaps.every((g) => g >= -0.5 && Math.abs(g - gaps[0]) < 0.75)
    ) {
      s.layout = "column";
      s.gap = clamp(gaps[0] ?? 0, 0, 1000);
      insets.left = clamp(left, 0, 1000);
      insets.top = clamp(top, 0, 1000);
    }
  }
  return s;
}

type MatrixBoard = Pick<
  HtmlArtboardSpec,
  "refId" | "role" | "parentRef" | "width" | "height" | "placement"
>;

export function validateArtboardRelations(
  boards: ReadonlyArray<Pick<MatrixBoard, "role" | "refId" | "parentRef">>,
) {
  const byId = new Map<string, (typeof boards)[number]>();
  for (const board of boards) {
    if (!board.refId) continue;
    if (byId.has(board.refId)) throw Error("重复的画板 refId：" + board.refId);
    byId.set(board.refId, board);
  }
  for (const board of boards) {
    if (!board.parentRef) continue;
    const parent = byId.get(board.parentRef);
    if (
      !parent ||
      parent === board ||
      parent.parentRef ||
      (parent.role && parent.role !== "primary") ||
      board.role === "primary"
    )
      throw Error(
        `画板 ${board.refId ?? ""} 的 parentRef「${board.parentRef}」必须指向另一张已存在的 primary 主画板，主画板不能有 parentRef`,
      );
  }
}

export function computeMatrixArtboardPlacements(
  baseDocument: DesignDocument,
  artboards: ReadonlyArray<MatrixBoard>,
  viewportCenter?: Point,
  gap = 80,
): Point[] {
  validateArtboardRelations(artboards);
  if (!artboards.length) return [];
  if (!Number.isFinite(gap) || gap < 0)
    throw Error("画板间距必须是非负有限数值");
  const bounds = layoutBounds(baseDocument);
  const occupied: Rect[] = baseDocument.nodes
    .filter((n) => !n.parentId)
    .map((n) => bounds.get(n.id) ?? n.style);
  const primary = (b: MatrixBoard) =>
    b.role === "primary" || (!b.role && !b.parentRef);
  const first = artboards.find(primary) ?? artboards[0];
  const start = occupied.length
    ? {
        x: Math.max(...occupied.map((r) => r.x + r.width)) + gap,
        y: Math.min(...occupied.map((r) => r.y)),
      }
    : viewportCenter
      ? {
          x: Math.round(viewportCenter.x - first.width / 2),
          y: Math.round(viewportCenter.y - first.height / 2),
        }
      : { x: 80, y: 80 };
  const positions: Point[] = [];
  const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height;
  function place(index: number, point: Point, axis?: "x" | "y") {
    const { width, height } = artboards[index];
    const rect = { ...point, width, height };
    if (!Object.values(rect).every(Number.isFinite) || width < 0 || height < 0)
      throw Error("画板坐标和尺寸无效");
    for (;;) {
      const hit = occupied.find((r) => overlaps(r, rect));
      if (!hit) break;
      if (!axis)
        throw Error(
          "显式画板位置重叠：" + (artboards[index].refId ?? index + 1),
        );
      rect[axis] =
        axis === "x" ? hit.x + hit.width + gap : hit.y + hit.height + gap;
    }
    positions[index] = { x: rect.x, y: rect.y };
    occupied.push(rect);
    return positions[index];
  }
  // Reserve explicit placements first, even if they occur after an automatic board.
  artboards.forEach((board, i) => {
    if (board.placement) place(i, board.placement);
  });
  let x = start.x;
  const columns = new Map<string, Point>();
  artboards.forEach((board, i) => {
    if (!primary(board)) return;
    if (!positions[i]) place(i, { x, y: start.y }, "x");
    const point = positions[i];
    x = Math.max(x, point.x + board.width + gap);
    if (board.refId)
      columns.set(board.refId, { x: point.x, y: point.y + board.height + gap });
  });
  artboards.forEach((board, i) => {
    const column = board.parentRef && columns.get(board.parentRef);
    if (primary(board) || !column) return;
    if (!positions[i]) place(i, column, "y");
    column.y = Math.max(column.y, positions[i].y + board.height + gap);
  });
  for (const rect of occupied) x = Math.max(x, rect.x + rect.width + gap);
  artboards.forEach((board, i) => {
    if (positions[i]) return;
    const placed = place(i, { x, y: start.y }, "x");
    x = placed.x + board.width + gap;
  });
  return positions;
}

function snapCustomNodes(
  doc: DesignDocument,
  nodes: DesignNode[],
  options: HtmlToFormaOptions,
) {
  const system = doc.designSystem;
  if (!system || options.snapLibraryTokens === false) return 0;
  const ids = options.activeLibraryId
    ? Object.keys(
        doc.libraries?.[options.activeLibraryId]?.designSystem?.variables ?? {},
      )
    : Object.keys(system.variables);
  const parent = options.selectionParentId
    ? doc.nodes.find((n) => n.id === options.selectionParentId)
    : undefined;
  const modes = effectiveModes(doc, parent);
  type ColorProp = "fill" | "color" | "stroke";
  type Swatch = { id: string; value: string; rgb: number[] };
  const swatches: Record<ColorProp, Swatch[]> = {
    fill: [],
    color: [],
    stroke: [],
  };
  const radii: { id: string; value: number }[] = [];
  const rgb = (hex: string) =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  // Binding validation checks every mode, including inactive aliases on unscoped number tokens.
  const radiusSafe = new Map<string, boolean>();
  function validRadius(id: string): boolean {
    if (!radiusSafe.has(id))
      radiusSafe.set(
        id,
        Object.values(system!.variables[id].values).every((v) =>
          typeof v === "object"
            ? validRadius(v.alias)
            : typeof v === "number" && v >= 0 && v <= 10000,
        ),
      );
    return radiusSafe.get(id)!;
  }
  for (const id of ids) {
    const v = system.variables[id];
    if (!v || (v.type !== "number" && v.type !== "color")) continue;
    const value = resolveVariable(system, id, modes);
    if (
      typeof value === "number" &&
      (!v.scopes.length || v.scopes.includes("radius")) &&
      validRadius(id)
    )
      radii.push({ id, value });
    if (typeof value === "string") {
      const swatch = { id, value, rgb: rgb(value) };
      for (const prop of ["fill", "color", "stroke"] as const)
        if (!v.scopes.length || v.scopes.includes(prop))
          swatches[prop].push(swatch);
    }
  }
  let bound = 0;
  for (const node of nodes) {
    const s = node.style;
    for (const prop of ["fill", "color", "stroke"] as const) {
      if (
        !s[prop] ||
        (prop === "fill" &&
          (s.fillOpacity === 0 ||
            s.gradient ||
            s.paints?.some((p) => p.gradient))) ||
        (prop === "color" && node.type !== "text" && node.type !== "button") ||
        (prop === "stroke" && !s.strokeWidth) ||
        !swatches[prop].length
      )
        continue;
      const [r, g, b] = rgb(s[prop]!);
      let best: Swatch | undefined,
        min = Infinity;
      for (const candidate of swatches[prop]) {
        const [cr, cg, cb] = candidate.rgb;
        const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
        if (distance <= 12 ** 2 && distance < min) {
          best = candidate;
          min = distance;
        }
        if (min === 0) break;
      }
      if (!best) continue;
      (node.variableBindings ??= {})[prop] = best.id;
      s[prop] = best.value;
      bound++;
    }
    if (!s.corners && s.radius > 0) {
      const best = radii.find(
        (candidate) => Math.abs(s.radius - candidate.value) < 1e-6,
      );
      if (best) {
        (node.variableBindings ??= {}).radius = best.id;
        s.radius = best.value;
        bound++;
      }
    }
  }
  return bound;
}

function defaultPlacement(doc: DesignDocument): Point {
  // Preserve the rounded legacy single-artboard placement.
  let right = -Infinity,
    top = Infinity;
  for (const node of doc.nodes)
    if (node.parentId === null) {
      right = Math.max(right, node.style.x + node.style.width);
      top = Math.min(top, node.style.y);
    }
  return top === Infinity
    ? { x: 80, y: 80 }
    : { x: Math.round(right + 80), y: Math.round(top) };
}

function sizing(
  node: DesignNode,
  parent: DesignNode,
  cs: CSSStyleDeclaration,
  textHug: boolean,
) {
  const s = node.style,
    p = parent.style;
  if (s.absolutePosition) return;
  if (textHug) s.widthMode = "hug";
  if (p.layout === "free") return;
  const i = p.insets;
  const border = (edge: "left" | "right" | "top" | "bottom") =>
    p.strokeSides?.[edge] ?? p.strokeWidth ?? 0;
  const innerWidth =
    p.width -
    (i?.left ?? p.padding) -
    (i?.right ?? p.padding) -
    border("left") -
    border("right");
  const innerHeight =
    p.height -
    (i?.top ?? p.padding) -
    (i?.bottom ?? p.padding) -
    border("top") -
    border("bottom");
  const grow = numeric(cs.flexGrow) > 0;
  if ((grow && p.layout === "row") || Math.abs(s.width - innerWidth) < 0.65)
    s.widthMode = "fill";
  if (
    (grow && p.layout === "column") ||
    (p.layout === "row" && Math.abs(s.height - innerHeight) < 0.65)
  )
    s.heightMode = "fill";
}

type ResolvedSlot = NonNullable<ReturnType<typeof resolveHtmlComponentSlot>>;

function componentOverrides(
  doc: DesignDocument,
  slot: ResolvedSlot,
  root: DesignNode,
  layers: DesignNode[],
  prepareLibrary: (library: ComponentLibrary) => void,
  warn: (message: string) => void,
) {
  const operations: HtmlOperation[] = [];
  const { live, stableKeys } = slot;
  for (const { property, choice } of slot.swaps) {
    prepareLibrary(doc.libraries![choice.libraryId]);
    operations.push({
      type: "setInstanceSlot",
      id: root.id,
      property,
      value: choice,
    });
  }
  const liveByKey = new Map(live.nodes.map((n) => [n.templateKey, n]));
  const liveById = new Map(live.nodes.map((n) => [n.id, n]));
  function editable(n: DesignNode) {
    let layer = liveByKey.get(n.templateKey);
    while (layer) {
      if (layer.locked) {
        warn("组件图层已锁定：" + layer.name);
        return false;
      }
      layer = layer.parentId ? liveById.get(layer.parentId) : undefined;
    }
    return true;
  }
  const labels = layers.filter(
    (n) =>
      stableKeys.has(n.templateKey) &&
      ["text", "button"].includes(liveByKey.get(n.templateKey)!.type),
  );
  const main =
    slot.component.exposed
      ?.filter((p) => p.kind === "text")
      .map((p) => labels.find((n) => n.templateKey === p.target))
      .find(Boolean) ?? labels[0];
  const changes = new Map<DesignNode, string>();
  if (typeof slot.overrides.text === "string") {
    if (main) changes.set(main, slot.overrides.text);
    else warn("找不到可覆写的文本层：" + slot.component.name);
  }
  for (const [key, value] of Object.entries(
    isRecord(slot.overrides.textByTemplateKey)
      ? slot.overrides.textByTemplateKey
      : {},
  )) {
    const label =
      labels.find((n) => n.templateKey === key) ??
      labels.find((n) => n.name === key);
    if (label && typeof value === "string") changes.set(label, value);
    else warn("无效的文本覆写：" + key);
  }
  for (const [n, text] of changes) {
    if (editable(n))
      operations.push({
        type: "update",
        id: n.id,
        patch: { text: text.slice(0, 50000) },
      });
  }
  for (const key of ["fill", "color", "opacity"] as const) {
    const target = key === "color" ? (main ?? root) : root;
    const raw = slot.overrides[key];
    if (raw === undefined) continue;
    const value =
      key === "opacity"
        ? typeof raw === "number" &&
          Number.isFinite(raw) &&
          raw >= 0 &&
          raw <= 1
          ? raw
          : undefined
        : typeof raw === "string"
          ? parseCssColor(raw)?.hex
          : undefined;
    if (value === undefined) warn("无效的外观覆写：" + key);
    else if (editable(target))
      operations.push({
        type: "update",
        id: target.id,
        patch: {},
        style: { [key]: value },
      });
  }
  return { operations, sizeChange: live.nodes.length - layers.length };
}

// Recompiling the same measured DOM against the same immutable snapshot is a replay.
// Each new DOM or document gets independent UUIDs, including current-page-only snapshots.
const measuredIds = new WeakMap<
  HTMLElement,
  WeakMap<DesignDocument, string[]>
>();

export function compileRenderedDomToForma(
  rootEl: HTMLElement,
  options: HtmlToFormaOptions,
): HtmlToFormaResult {
  const { baseDocument } = options;
  const view = rootEl.ownerDocument.defaultView;
  if (!view) throw Error("排版 DOM 没有关联窗口");
  const cssCache = new WeakMap<Element, CSSStyleDeclaration>(),
    boxCache = new WeakMap<Element, Box>();
  const computed: Computed = (el) => {
    let value = cssCache.get(el);
    if (!value) {
      value = view.getComputedStyle(el);
      cssCache.set(el, value);
    }
    return value;
  };
  const rect = (el: Element) => {
    let box = boxCache.get(el);
    if (!box) {
      box = el.getBoundingClientRect();
      boxCache.set(el, box);
    }
    return box;
  };
  const visible = (el: Element) => {
    if (
      /^(script|style|template|head|meta|link|title|desc|noscript|iframe|object|embed)$/i.test(
        el.localName,
      )
    )
      return false;
    const s = computed(el);
    return (
      s.display !== "none" &&
      s.visibility !== "hidden" &&
      s.visibility !== "collapse" &&
      numeric(s.opacity, 1) !== 0
    );
  };
  const warningSet = new Set<string>();
  const warn = (message: string) => {
    warningSet.add(message);
  };
  const workingDoc = {
    ...baseDocument,
    images: { ...baseDocument.images },
    libraries: { ...baseDocument.libraries },
  };
  const libraries = new Map<string, ComponentLibrary>();
  function prepareLibrary(library: ComponentLibrary) {
    const prepared = integrateLibrarySystem(workingDoc, library);
    workingDoc.designSystem = prepared.system;
    if (prepared.library !== library) {
      workingDoc.libraries[library.id] = prepared.library;
      libraries.set(library.id, prepared.library);
    }
  }
  const target =
    options.activeLibraryId &&
    Object.hasOwn(workingDoc.libraries, options.activeLibraryId) &&
    workingDoc.libraries[options.activeLibraryId];
  if (target && options.snapLibraryTokens !== false) prepareLibrary(target);
  const images = { ...options.images, ...baseDocument.images };
  const imageIdsByData = new Map(
    Object.entries(images).map(([id, asset]) => [asset.data, id]),
  );
  const imageOps = new Map<string, ImageAsset>();
  const nodes: DesignNode[] = [];
  const customNodes: DesignNode[] = [];
  const instanceEdits: HtmlOperation[] = [];
  let slotSizeChange = 0;
  function storeImage(id: string, image: ImageAsset) {
    if (images[id] && images[id].data !== image.data)
      throw Error("图像资源标识冲突：" + id);
    if (workingDoc.images[id]) return;
    workingDoc.images[id] = images[id] = image;
    imageIdsByData.set(image.data, id);
    imageOps.set(id, image);
  }
  const ids = new Set(baseDocument.nodes.map((n) => n.id));
  for (const page of baseDocument.pages ?? [])
    for (const node of page.nodes ?? []) ids.add(node.id);
  const limit = Math.min(
    Math.max(1, Math.floor(options.maxNodes ?? 20000)),
    20000,
    maxPageNodes - baseDocument.nodes.length,
  );
  if (limit < 1) throw Error("当前页面已达图层数量上限");
  const stats = {
    created: 0,
    imagesLocalized: 0,
    vectorsConverted: 0,
    autoLayoutFrames: 0,
    componentsInserted: 0,
    tokensBound: 0,
  };
  const rootBox = rect(rootEl);
  const placement = options.placement ?? defaultPlacement(baseDocument);
  if (!Number.isFinite(placement.x) || !Number.isFinite(placement.y))
    throw Error("画板位置必须是有限坐标");
  const byDocument =
    measuredIds.get(rootEl) ?? new WeakMap<DesignDocument, string[]>();
  measuredIds.set(rootEl, byDocument);
  const allocated = byDocument.get(baseDocument) ?? [];
  byDocument.set(baseDocument, allocated);
  let index = 0;
  function nextId() {
    let id = allocated[index];
    while (!id || ids.has(id)) id = "html-" + crypto.randomUUID();
    allocated[index++] = id;
    ids.add(id);
    return id;
  }
  function makeNode(
    type: DesignNode["type"],
    name: string,
    box: Box,
    parent: DesignNode | null,
    origin: Box,
  ): DesignNode {
    const node: DesignNode = {
      id: nextId(),
      type,
      name: name.slice(0, 200),
      parentId: parent?.id ?? options.selectionParentId ?? null,
      hidden: false,
      locked: false,
      text: "",
      style: {
        x: parent ? box.left - origin.left : placement.x,
        y: parent ? box.top - origin.top : placement.y,
        width: clamp(
          parent ? box.width : (options.width ?? box.width),
          0,
          maxLayerDimension,
        ),
        height: clamp(
          parent ? box.height : (options.height ?? box.height),
          0,
          maxLayerDimension,
        ),
        widthMode: "fixed",
        heightMode: "fixed",
        fill: "#000000",
        fillOpacity: 0,
        color: "#000000",
        fontSize: 16,
        radius: 0,
        padding: 0,
        gap: 0,
        layout: "free",
      },
    };
    nodes.push(node);
    customNodes.push(node);
    return node;
  }
  function attachImage(el: Element, cs: CSSStyleDeclaration, node: DesignNode) {
    const img = el.localName === "img";
    const layers = parts(cs.backgroundImage || "");
    const bitmapIndex = layers.findIndex((p) => /^url\(/i.test(p));
    const url = layers[bitmapIndex]
      ?.slice(4, -1)
      .trim()
      .replace(/^(["'])([\s\S]*)\1$/, "$2");
    const src = img
      ? (el as HTMLImageElement).currentSrc || el.getAttribute("src")
      : url;
    const hint = el.getAttribute("data-forma-asset-id");
    if (!img && !url && !hint) return;
    const id =
      hint && Object.hasOwn(images, hint)
        ? hint
        : src && imageIdsByData.get(src);
    if (!id || !/^img-[a-f\d]{64}$/.test(id)) {
      warn("图像缺少本地资源：" + node.name);
      return;
    }
    if (
      options.images?.[id] &&
      baseDocument.images?.[id] &&
      options.images[id].data !== baseDocument.images[id].data
    )
      throw Error("图像资源标识冲突：" + id);
    const backgroundValue = (list: string) => {
      const values = parts(list || "");
      return values[Math.max(0, bitmapIndex) % values.length] || "";
    };
    const fit = img ? cs.objectFit : backgroundValue(cs.backgroundSize);
    const [x, y] = (
      img ? cs.objectPosition || "" : backgroundValue(cs.backgroundPosition)
    ).split(/\s+/);
    const position = (v: string | undefined) =>
      v?.endsWith("%")
        ? clamp(numeric(v), 0, 100)
        : v === "left" || v === "top"
          ? 0
          : v === "right" || v === "bottom"
            ? 100
            : 50;
    node.image = {
      assetId: id,
      fit: fit === "contain" || fit === "fill" ? fit : "cover",
      x: position(x),
      y: position(y),
      zoom: 1,
    };
    storeImage(id, images[id]);
  }
  const texts = new WeakMap<Node, ReturnType<typeof measureText>>();
  function textBounds(n: Node, fallback: Box) {
    let result = texts.get(n);
    if (!result) {
      result = measureText(n, fallback);
      texts.set(n, result);
    }
    return result;
  }
  function visibleChildren(el: Element, cs: CSSStyleDeclaration, box: Box) {
    const items: Child[] = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && normalizeText(n.textContent ?? "", cs)) {
        items.push({ node: n, box: textBounds(n, box).box, absolute: false });
      } else if (n.nodeType === 1) {
        const child = n as Element;
        if (!visible(child)) continue;
        const cb = rect(child);
        if (
          (!cb.width || !cb.height) &&
          child.localName !== "svg" &&
          !child.hasAttribute("data-forma-component") &&
          !child.childElementCount
        )
          continue;
        const pos = computed(child).position;
        items.push({
          node: n,
          box: cb,
          absolute: pos === "absolute" || pos === "fixed",
        });
      }
    }
    return items;
  }
  function room(depth: number) {
    if (nodes.length + slotSizeChange >= limit) {
      warn(`已达到 ${limit} 个图层上限`);
      return false;
    }
    if (depth > 255) {
      warn("已达到图层嵌套深度上限");
      return false;
    }
    return true;
  }
  function assignText(
    node: DesignNode,
    value: string,
    cs: CSSStyleDeclaration,
  ) {
    node.text = value.slice(0, 50000);
    if (value.length > 50000) warn("部分文字超出 50000 字符上限");
    Object.assign(node.style, typography(cs));
  }
  function visit(
    el: Element,
    parent: DesignNode | null,
    origin: Box,
    depth: number,
  ) {
    if (!room(depth)) return;
    const cs = computed(el),
      box = rect(el),
      isRoot = !parent;
    const absolute = cs.position === "absolute" || cs.position === "fixed";
    const placeholder = parent && el.hasAttribute("data-forma-component");
    if (placeholder) {
      const slot = resolveHtmlComponentSlot(
        workingDoc,
        el,
        options.activeLibraryId,
        options.name,
      );
      if (slot) {
        if (nodes.length + slotSizeChange + slot.variant.nodes.length > limit) {
          warn(`组件超出 ${limit} 个图层上限：${slot.component.name}`);
          return;
        }
        // The measured offset is already in parent-local coordinates.
        const expanded = instantiateComponent(
          workingDoc,
          slot.library,
          slot.component.id,
          slot.variant.id,
          null,
          { x: box.left - origin.left, y: box.top - origin.top },
        );
        const layers: DesignNode[] = [];
        for (const op of expanded.operations) {
          if (op.type === "setDesignSystem")
            workingDoc.designSystem = op.system;
          else if (op.type === "putLibrary") {
            workingDoc.libraries[op.library.id] = op.library;
            libraries.set(op.library.id, op.library);
          } else if (op.type === "putImage") storeImage(op.id, op.image);
          else if (op.type === "create") layers.push(op.node);
          else if (op.type === "update") instanceEdits.push(op);
        }
        const root = layers.find((n) => n.id === expanded.id)!;
        root.parentId = parent.id;
        root.style.absolutePosition = absolute || undefined;
        for (const axis of ["width", "height"] as const) {
          if (box[axis] <= 0 || root.style[axis] === box[axis]) continue;
          root.style[axis] = clamp(box[axis], 0, maxLayerDimension);
          root.style[axis === "width" ? "widthMode" : "heightMode"] = "fixed";
        }
        sizing(root, parent, cs, false);
        nodes.push(...layers);
        if (Object.keys(slot.overrides).length) {
          const edits = componentOverrides(
            workingDoc,
            slot,
            root,
            layers,
            (library) => {
              prepareLibrary(library);
              for (const [id, image] of Object.entries(library.images ?? {}))
                storeImage(id, image);
            },
            warn,
          );
          slotSizeChange += edits.sizeChange;
          instanceEdits.push(...edits.operations);
        }
        stats.componentsInserted++;
        return;
      }
      warn(
        "找不到组件插槽：" +
          (el.getAttribute("data-forma-component") ||
            el.getAttribute("data-component") ||
            "（空）"),
      );
    }
    const svg = el.localName === "svg",
      img = el.localName === "img";
    const children = svg || img ? [] : visibleChildren(el, cs, box);
    const paragraph = inlineParagraph(el, cs, computed);
    const textOnly =
      !!paragraph ||
      (children.length > 0 && children.every((c) => c.node.nodeType === 3));
    const text =
      paragraph?.text ??
      (textOnly
        ? normalizeText(children.map((c) => c.node.textContent).join(""), cs)
        : "");
    const paint = surface(el, cs, box);
    const hasPaint = !!(
      paint.fillOpacity ||
      paint.strokeWidth ||
      paint.shadows ||
      paint.gradient ||
      paint.backdropBlur ||
      paint.backdropBrightness ||
      paint.backdropSaturation ||
      paint.blur ||
      (cs.backgroundImage && cs.backgroundImage !== "none")
    );
    const button =
      textOnly &&
      (el.localName === "button" || el.getAttribute("role") === "button") &&
      hasPaint;
    const zeroInsets = ![
      cs.paddingTop,
      cs.paddingRight,
      cs.paddingBottom,
      cs.paddingLeft,
    ].some((v) => numeric(v) !== 0);
    // Drop only neutral wrappers whose sole child occupies the same flow slot.
    // Otherwise the wrapper's size/offset is part of the parent's layout.
    if (
      parent &&
      children.length === 1 &&
      children[0].node.nodeType === 1 &&
      !hasPaint &&
      !paint.clipContent &&
      paint.opacity === 1 &&
      !absolute &&
      (!cs.position || cs.position === "static") &&
      !numeric(cs.flexGrow) &&
      zeroInsets &&
      !placeholder &&
      !el.hasAttribute("data-forma-name") &&
      !el.hasAttribute("aria-label") &&
      (cs.display === "contents" ||
        (el.localName === "div" &&
          (cs.display === "block" || !cs.display) &&
          (parent.style.layout === "free" ||
            (["left", "top", "width", "height"] as const).every(
              (k) => Math.abs(box[k] - children[0].box[k]) < 0.5,
            ))))
    ) {
      visit(children[0].node as Element, parent, origin, depth);
      return;
    }
    const type: DesignNode["type"] = isRoot
      ? "frame"
      : svg
        ? "vector"
        : img
          ? "rectangle"
          : button
            ? "button"
            : textOnly && !hasPaint && zeroInsets
              ? "text"
              : "frame";
    const range = type === "text" ? textBounds(el, box) : undefined;
    const inline = cs.display === "inline" || cs.display === "contents";
    const measured =
      range && inline && range.lines === 1
        ? {
            left: range.box.left,
            top: range.box.top,
            width: range.box.width,
            height: Math.max(range.box.height, typography(cs).lineHeight ?? 0),
          }
        : box;
    const node = makeNode(
      type,
      isRoot
        ? options.name || label(el)
        : placeholder
          ? label(el, el.getAttribute("data-forma-component") || text)
          : label(el, text),
      measured,
      parent,
      origin,
    );
    Object.assign(node.style, paint);
    if (parent && absolute) node.style.absolutePosition = true;
    if (parent)
      sizing(
        node,
        parent,
        cs,
        !!range &&
          range.lines === 1 &&
          Math.abs(measured.width - range.box.width) < 1,
      );
    if (svg) {
      node.vector = readVector(el, box, computed, warn);
      if (node.vector) stats.vectorsConverted++;
      else {
        nodes.pop();
        customNodes.pop();
        warn("SVG 没有可编辑路径：" + node.name);
      }
      return;
    }
    attachImage(el, cs, node);
    if (type === "button" || type === "text") {
      assignText(node, text, cs);
      if (paragraph?.runs.length) node.textRuns = paragraph.runs;
      if (
        range &&
        !absolute &&
        node.style.heightMode === "fixed" &&
        !(el as HTMLElement).style.height &&
        Math.abs(measured.height - range.lines * (node.style.lineHeight ?? 0)) <
          0.75
      )
        node.style.heightMode = "hug";
      return;
    }
    if (type !== "frame") return;
    Object.assign(node.style, frameLayout(cs, children, box));
    if (node.style.layout !== "free") stats.autoLayoutFrames++;
    const flowStart = nodes.length;
    for (const child of children) {
      if (!room(depth + 1)) break;
      if (child.node.nodeType === 1)
        visit(child.node as Element, node, box, depth + 1);
      else {
        const value = normalizeText(child.node.textContent ?? "", cs);
        const run = makeNode("text", value.slice(0, 60), child.box, node, box);
        assignText(run, value, cs);
        // Anonymous flex items have no flex-grow, background or group opacity.
        run.style.height = clamp(
          Math.max(
            run.style.height,
            (run.style.lineHeight ?? 0) * textBounds(child.node, box).lines,
          ),
          0,
          maxLayerDimension,
        );
        run.style.widthMode =
          textBounds(child.node, box).lines === 1 ? "hug" : "fixed";
        if (
          node.style.layout === "column" &&
          Math.abs(
            child.box.width -
              (box.width -
                (node.style.insets?.left ?? 0) -
                (node.style.insets?.right ?? 0)),
          ) < 0.65
        )
          run.style.widthMode = "fill";
      }
    }
    // Forma shares the main-axis remainder equally among Fill siblings. For
    // unequal CSS grow factors retain the browser's measured allocations.
    if (node.style.layout === "row" || node.style.layout === "column") {
      const axis = node.style.layout === "row" ? "width" : "height",
        mode = axis === "width" ? "widthMode" : "heightMode";
      const flexible = nodes
        .slice(flowStart)
        .filter((n) => n.parentId === node.id && n.style[mode] === "fill");
      if (
        flexible.length > 1 &&
        flexible.some(
          (n) => Math.abs(n.style[axis] - flexible[0].style[axis]) > 1,
        )
      )
        for (const n of flexible) n.style[mode] = "fixed";
    }
  }
  visit(rootEl, null, rootBox, 1);
  stats.created = nodes.length + slotSizeChange;
  stats.imagesLocalized = imageOps.size;
  stats.tokensBound = snapCustomNodes(workingDoc, customNodes, options);
  const operations: HtmlOperation[] = [];
  if (
    workingDoc.designSystem &&
    workingDoc.designSystem !== baseDocument.designSystem
  )
    operations.push({
      type: "setDesignSystem",
      system: workingDoc.designSystem,
    });
  for (const [id, image] of imageOps)
    operations.push({ type: "putImage", id, image });
  for (const library of libraries.values())
    operations.push({ type: "putLibrary", library });
  for (const node of nodes) operations.push({ type: "create", node });
  operations.push(...instanceEdits);
  if (stats.created > limit || operations.length > 20000)
    throw Error("生成的图层与资源超过单笔事务上限");
  if (
    !options.activeLibraryId &&
    options.snapLibraryTokens === undefined &&
    !stats.componentsInserted &&
    !stats.tokensBound
  ) {
    // Existing single-board clients serialize the original four counters.
    Object.defineProperty(stats, "componentsInserted", { enumerable: false });
    Object.defineProperty(stats, "tokensBound", { enumerable: false });
  }
  return {
    transaction: { baseRevision: baseDocument.revision, operations },
    createdRootIds: [nodes[0].id],
    stats,
    warnings: [...warningSet],
  };
}

function unionDefinitions<T>(
  left: Record<string, T>,
  right: Record<string, T>,
) {
  const result = { ...left };
  for (const [id, definition] of Object.entries(right)) {
    if (
      Object.hasOwn(left, id) &&
      left[id] !== definition &&
      JSON.stringify(left[id]) !== JSON.stringify(definition)
    )
      throw Error("画板引用了冲突的设计系统定义：" + id);
    result[id] = definition;
  }
  return result;
}

export function mergeHtmlArtboardResults(
  baseDocument: DesignDocument,
  results: HtmlToFormaResult[],
): HtmlToFormaResult {
  if (!results.length) throw Error("没有可合并的画板");
  const ids = new Set(baseDocument.nodes.map((n) => n.id));
  for (const page of baseDocument.pages ?? [])
    for (const n of page.nodes ?? []) ids.add(n.id);
  const images = new Map<string, ImageAsset>(),
    libraries = new Map<string, ComponentLibrary>();
  let system: DesignSystem | undefined = baseDocument.designSystem;
  const edits: HtmlOperation[] = [],
    createdRootIds: string[] = [];
  const stats = {
    created: 0,
    imagesLocalized: 0,
    vectorsConverted: 0,
    autoLayoutFrames: 0,
    componentsInserted: 0,
    tokensBound: 0,
  };
  const warnings = new Set<string>();
  for (const result of results) {
    if (result.transaction.baseRevision !== baseDocument.revision)
      throw Error("画板编译所用的文档版本不一致");
    const mapping = new Map<string, string>();
    for (const op of result.transaction.operations) {
      if (op.type !== "create") continue;
      let id = op.node.id;
      if (mapping.has(id)) throw Error("画板内的图层 ID 重复：" + id);
      while (ids.has(id)) id = crypto.randomUUID();
      mapping.set(op.node.id, id);
      ids.add(id);
    }
    for (const op of result.transaction.operations) {
      switch (op.type) {
        case "setDesignSystem":
          system = system
            ? {
                collections: unionDefinitions(
                  system.collections,
                  op.system.collections,
                ),
                variables: unionDefinitions(
                  system.variables,
                  op.system.variables,
                ),
                styles: unionDefinitions(system.styles, op.system.styles),
                activeModes: unionDefinitions(
                  system.activeModes,
                  op.system.activeModes,
                ),
              }
            : op.system;
          break;
        case "putImage": {
          const existing = images.get(op.id) ?? baseDocument.images?.[op.id];
          if (existing && existing.data !== op.image.data)
            throw Error("图像资源标识冲突：" + op.id);
          if (!existing) images.set(op.id, op.image);
          break;
        }
        case "putLibrary": {
          const existing = libraries.get(op.library.id);
          if (
            existing &&
            JSON.stringify(existing) !== JSON.stringify(op.library)
          )
            throw Error("画板引用了冲突的组件库：" + op.library.id);
          if (
            !existing &&
            JSON.stringify(baseDocument.libraries?.[op.library.id]) !==
              JSON.stringify(op.library)
          )
            libraries.set(op.library.id, op.library);
          break;
        }
        case "create": {
          const node = structuredClone(op.node);
          node.id = mapping.get(node.id)!;
          if (node.parentId)
            node.parentId = mapping.get(node.parentId) ?? node.parentId;
          if (node.maskSourceId)
            node.maskSourceId =
              mapping.get(node.maskSourceId) ?? node.maskSourceId;
          remapInteraction(node, mapping);
          edits.push({ type: "create", node });
          break;
        }
        case "update":
        case "setInstanceSlot":
          edits.push({ ...op, id: mapping.get(op.id) ?? op.id });
          break;
        default:
          throw Error("画板编译结果含有非装配操作：" + op.type);
      }
    }
    createdRootIds.push(...result.createdRootIds.map((id) => mapping.get(id)!));
    for (const key of [
      "created",
      "vectorsConverted",
      "autoLayoutFrames",
      "componentsInserted",
      "tokensBound",
    ] as const)
      stats[key] += result.stats[key];
    result.warnings.forEach((w) => warnings.add(w));
  }
  stats.imagesLocalized = images.size;
  const operations: HtmlOperation[] = [];
  if (system && system !== baseDocument.designSystem)
    operations.push({ type: "setDesignSystem", system });
  for (const [id, image] of images)
    operations.push({ type: "putImage", id, image });
  for (const library of libraries.values())
    operations.push({ type: "putLibrary", library });
  if (
    operations.length + edits.length > 20000 ||
    stats.created + baseDocument.nodes.length > maxPageNodes
  )
    throw Error("合并的画板超过单笔事务或页面图层上限");
  operations.push(...edits);
  return {
    transaction: { baseRevision: baseDocument.revision, operations },
    createdRootIds,
    stats,
    warnings: [...warnings],
  };
}
