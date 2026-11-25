import { maxGradientStops } from "../domain/document-limits";
import { variantFor } from "../domain/component-slots";
import svgpath from "svgpath";
import {
  imageId,
  imageSchema,
  type ImageAsset,
  type ImageFill,
} from "../domain/images";
import {
  iconPrimitivesToSvgPaths,
  iconToFormaVector,
  searchIcons,
  svgHexColor,
} from "./icon-library";
import {
  defaultStyle,
  nodeSchema,
  styleSchema,
  type DesignDocument,
  type DesignNode,
  type NodeStyle,
} from "../domain/document";
import {
  instanceSource,
  instantiateComponent,
  planDetachInstance,
  validateInstanceStructure,
} from "../domain/library";
import {
  intersects,
  layoutBounds,
  type Point,
  type Rect,
} from "../domain/geometry";
import { compose, identity, type Matrix } from "../domain/transforms";
import { transact, transactionSchema } from "../domain/commands";
import {
  propertyType,
  variableProperties,
  type VariableProperty,
} from "../domain/design-properties";
import {
  interactionSchema,
  remapInteraction,
  type Interaction,
} from "../domain/prototype";
import {
  instanceOwner,
  instanceGeometryKeys,
  isContainer,
  isLocked,
  subtreeIds,
} from "../domain/tree";
import type { Transaction } from "./provider";
import { ARTBOARD_GAP, computeArtboardPlacement } from "./context-builder";

export interface BlueprintInteraction {
  trigger?: "click" | "hover" | "delay";
  delayMs?: number;
  flow?: string;
  scroll?: "vertical" | "horizontal" | "both";
  navigateToRef?: string;
  navigateToId?: string;
  overlayRef?: string;
  overlayId?: string;
  position?: "center" | "bottom";
  back?: boolean;
  close?: boolean;
  reset?: boolean;
  openLink?: string;
  transition?: {
    type?:
      | "instant"
      | "dissolve"
      | "smart-animate"
      | "move-in"
      | "push"
      | "slide-in";
    direction?: "left" | "right" | "top" | "bottom";
    duration?: number;
    easing?: "linear" | "ease-out" | "ease-in-out";
  };
  actions?: unknown[];
  otherwise?: unknown[];
  condition?: unknown;
}

interface ComponentReference {
  libraryId?: string;
  componentId: string;
  variantId?: string;
}

interface BlueprintProperties {
  adapt?: BlueprintAdaptSpec;
  variantProperties?: Record<string, string>;
  overrides?: {
    text?: string;
    textByTemplateKey?: Record<string, string>;
    fill?: string;
    color?: string;
    opacity?: number;
    slots?: Record<string, ComponentReference>;
  };
  slot?: "paint" | "stroke" | "text" | "grid" | "effect";
  property?: string;
  value?: ComponentReference | string | number | boolean | null;
  variableModes?: Record<string, string>;
}

export interface BlueprintAdaptSpec {
  /** A children list also requests detachment unless this flag is false. */
  detachOuter?: boolean;
  name?: string;
  /** Match descendant template keys or layer names within this copy. */
  removeChildren?: string[];
  appendChildren?: BlueprintNode[];
  style?: Record<string, unknown>;
}

export interface BlueprintNode extends BlueprintProperties {
  refId?: string;
  role?: "primary" | "overlay" | "exception" | "detail";
  parentRef?: string;
  id?: string;
  type?: string;
  name?: string;
  text?: string;
  hidden?: boolean;
  locked?: boolean;
  style?: Record<string, unknown>;
  children?: BlueprintNode[];
  libraryId?: string;
  componentId?: string;
  variantId?: string;
  fillToken?: string;
  variableBindings?: Record<string, string>;
  styleBindings?: Record<string, string>;
  interaction?: BlueprintInteraction;
  control?: Record<string, unknown>;
  vector?: Record<string, unknown>;
  icon?: string;
  iconColor?: string;
  iconStrokeWidth?: number;
  svg?: string;
  image?: string | (Partial<ImageFill> & { url?: string });
  imageAssetId?: string;
  imageFit?: ImageFill["fit"];
  imageOpacity?: number;
  imageAdjustments?: Partial<Omit<ImageFill, "assetId" | "fit" | "opacity">>;
}

export interface BlueprintEdit extends BlueprintProperties {
  collectionId?: string;
  modeId?: string;
  op?: string;
  type?: string;
  id?: string;
  parentId?: string | null;
  patch?: Record<string, unknown>;
  style?: Record<string, unknown>;
  node?: BlueprintNode;
  children?: BlueprintNode[];
  libraryId?: string;
  componentId?: string;
  variantId?: string;
  position?: { x?: number; y?: number };
  variableId?: string;
  styleId?: string;
  index?: number;
  reset?: boolean;
  token?: { name?: string; value?: string };
}

export interface DesignBlueprint {
  mode: "generate" | "edit" | "answer";
  reply: string;
  summary?: string;
  artboards?: BlueprintNode[];
  edits?: BlueprintEdit[];
  operations?: unknown[];
  baseRevision?: number;
}

export interface CompileBlueprintStats {
  created: number;
  updated: number;
  removed: number;
  componentsInserted: number;
  tokensBound: number;
}

export interface CompileDiagnostic {
  severity: "warning" | "error";
  code: string;
  message: string;
  suggestion?: string;
}

export interface CompileBlueprintResult {
  diagnostics: CompileDiagnostic[];
  mode: "generate" | "edit" | "answer";
  reply: string;
  summary: string;
  transaction?: Transaction;
  createdRootIds: string[];
  stats: CompileBlueprintStats;
}

export interface BlueprintCompileContext {
  document: DesignDocument;
  selection: string | null;
  viewportCenter?: { x: number; y: number };
  images?: Record<string, ImageAsset>;
}

export type CompileBlueprintOptions = BlueprintCompileContext;

const NAMED_COLORS: Record<string, { hex: string; opacity?: number }> = {
  none: { hex: "#ffffff", opacity: 0 },
  transparent: { hex: "#ffffff", opacity: 0 },
  white: { hex: "#ffffff" },
  black: { hex: "#000000" },
  red: { hex: "#ef4444" },
  blue: { hex: "#3b82f6" },
  green: { hex: "#22c55e" },
  yellow: { hex: "#eab308" },
  orange: { hex: "#f97316" },
  purple: { hex: "#a855f7" },
  pink: { hex: "#ec4899" },
  cyan: { hex: "#06b6d4" },
  indigo: { hex: "#6366f1" },
  gray: { hex: "#64748b" },
  grey: { hex: "#64748b" },
  slate: { hex: "#475569" },
};

const FONT_WEIGHT_NAMES: Record<string, number> = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
};

const VALID_VARIABLE_PROPS = new Set<string>(variableProperties);

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/px$/i, "");
    if (!trimmed) return undefined;
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

function toHexByte(n: number): string {
  return Math.round(clamp(n, 0, 255))
    .toString(16)
    .padStart(2, "0");
}

export function normalizeHexColor(
  value: unknown,
): { hex: string; opacity?: number } | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;

  if (Object.hasOwn(NAMED_COLORS, raw)) {
    return NAMED_COLORS[raw];
  }

  // #RRGGBB
  if (/^#[0-9a-f]{6}$/.test(raw)) {
    return { hex: raw };
  }
  // #RGB
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return {
      hex: `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`,
    };
  }
  // #RGBA
  if (/^#[0-9a-f]{4}$/.test(raw)) {
    const alpha = parseInt(`${raw[4]}${raw[4]}`, 16) / 255;
    return {
      hex: `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`,
      opacity: Math.round(alpha * 1000) / 1000,
    };
  }
  // #RRGGBBAA
  if (/^#[0-9a-f]{8}$/.test(raw)) {
    const alpha = parseInt(raw.slice(7, 9), 16) / 255;
    return {
      hex: raw.slice(0, 7),
      opacity: Math.round(alpha * 1000) / 1000,
    };
  }
  // rgb(r, g, b) / rgba(r, g, b, a)
  const rgbMatch =
    /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
      raw,
    );
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    let opacity: number | undefined;
    if (rgbMatch[4] !== undefined) {
      const aStr = rgbMatch[4];
      const a = aStr.endsWith("%")
        ? Number(aStr.slice(0, -1)) / 100
        : Number(aStr);
      if (Number.isFinite(a)) {
        opacity = Math.round(clamp(a, 0, 1) * 1000) / 1000;
      }
    }
    return {
      hex: `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`,
      ...(opacity !== undefined ? { opacity } : {}),
    };
  }
  return null;
}

function supportedNodeTypes(): Set<string> {
  return new Set<string>(nodeSchema.shape.type.options as readonly string[]);
}

function normalizeNodeType(node: BlueprintNode): DesignNode["type"] {
  if (typeof node.icon === "string" || typeof node.svg === "string")
    return "vector";
  const raw = node.type;
  const supported = supportedNodeTypes();
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    if (lower === "image" || lower === "img" || lower === "photo") {
      return node.children?.length ? "frame" : "rectangle";
    }
    if (supported.has(lower)) return lower as DesignNode["type"];
    if (
      lower === "card" ||
      lower === "container" ||
      lower === "box" ||
      lower === "stack" ||
      lower === "artboard"
    ) {
      return "frame";
    }
    if (
      lower === "rect" ||
      lower === "divider" ||
      lower === "badge" ||
      lower === "input"
    ) {
      return "rectangle";
    }
    if (lower === "circle" || lower === "avatar" || lower === "oval") {
      return "ellipse";
    }
    if (lower === "label" || lower === "heading" || lower === "paragraph") {
      return "text";
    }
    if (lower === "btn" || lower === "cta") {
      return "button";
    }
    if (lower === "icon" || lower === "svg") {
      return "vector";
    }
  }
  return "frame";
}

function defaultStyleForType(
  type: DesignNode["type"],
  isRootArtboard: boolean,
): NodeStyle {
  if (type === "frame") {
    return {
      ...defaultStyle,
      width: isRootArtboard ? 390 : 320,
      height: isRootArtboard ? 844 : 120,
      fill: "#ffffff",
      color: "#0f172a",
      radius: 0,
      padding: isRootArtboard ? 24 : 0,
      gap: isRootArtboard ? 12 : 0,
      layout: "column",
    };
  }
  if (type === "text") {
    return {
      ...defaultStyle,
      width: 240,
      height: 28,
      fill: "#ffffff",
      color: "#0f172a",
      radius: 0,
      fontSize: 16,
      padding: 0,
      gap: 0,
      layout: "free",
    };
  }
  if (type === "button") {
    return {
      ...defaultStyle,
      width: 160,
      height: 44,
      fill: "#0d99ff",
      color: "#ffffff",
      radius: 10,
      fontSize: 15,
      fontWeight: 600,
      padding: 12,
      gap: 8,
      layout: "row",
      alignX: "center",
      alignY: "center",
    };
  }
  if (type === "ellipse") {
    return {
      ...defaultStyle,
      width: 48,
      height: 48,
      fill: "#e2e8f0",
      color: "#0f172a",
      radius: 24,
      padding: 0,
      gap: 0,
      layout: "free",
    };
  }
  if (type === "rectangle") {
    return {
      ...defaultStyle,
      width: 160,
      height: 100,
      fill: "#f1f5f9",
      color: "#0f172a",
      radius: 12,
      padding: 0,
      gap: 0,
      layout: "free",
    };
  }
  if (type === "vector") {
    return {
      ...defaultStyle,
      width: 24,
      height: 24,
      fill: "#0f172a",
      color: "#0f172a",
      radius: 0,
      padding: 0,
      gap: 0,
      layout: "free",
    };
  }
  return { ...defaultStyle };
}

// The server has no browser text shaper. This fallback also sizes Fill text
// when its parent hugs the same axis and cannot supply a definite width.
function fallbackTextWidth(bp: BlueprintNode, style: NodeStyle) {
  const text =
    typeof bp.text === "string"
      ? bp.text
      : typeof bp.name === "string"
        ? bp.name
        : "文本";
  let lineWidth = 0,
    widest = 0;
  for (const char of text.slice(0, 50000)) {
    if (char === "\n") lineWidth = 0;
    else
      lineWidth +=
        (char.charCodeAt(0) > 255 ? style.fontSize : style.fontSize * 0.56) +
        (style.letterSpacing ?? 0);
    widest = Math.max(widest, lineWidth);
  }
  return clamp(Math.ceil(widest), 1, 10000);
}

function applyChildDefaults(
  type: DesignNode["type"],
  bp: BlueprintNode,
  defaults: NodeStyle,
  patch: Partial<NodeStyle>,
  parentLayout: NodeStyle["layout"],
) {
  const row = parentLayout === "row";
  const inStack = row || parentLayout === "column";
  if (type === "frame") {
    const hasExplicitFill =
      bp.style?.fill ||
      bp.style?.gradient ||
      patch.fill ||
      patch.paints?.length ||
      bp.fillToken ||
      bp.variableBindings?.fill ||
      bp.styleBindings?.paint;
    if (!hasExplicitFill && bp.style?.fillOpacity === undefined)
      defaults.fillOpacity = 0;
    const layout = patch.layout ?? defaults.layout;
    if (
      bp.children?.length &&
      (layout === "row" || layout === "column") &&
      patch.height === undefined &&
      patch.heightMode === undefined
    ) {
      defaults.height = 40;
      defaults.heightMode = "hug";
    }
  } else if (type === "ellipse" || type === "rectangle") {
    const hasExplicitFill =
      bp.style?.fill !== undefined ||
      bp.style?.background !== undefined ||
      bp.style?.backgroundColor !== undefined ||
      bp.style?.gradient !== undefined ||
      patch.paints?.length ||
      bp.fillToken ||
      bp.variableBindings?.fill ||
      bp.styleBindings?.paint;
    const hasExplicitStroke =
      patch.stroke !== undefined ||
      (patch.strokeWidth !== undefined && patch.strokeWidth > 0) ||
      Boolean(patch.strokePaints?.length);
    if (
      !hasExplicitFill &&
      hasExplicitStroke &&
      bp.style?.fillOpacity === undefined
    ) {
      defaults.fillOpacity = 0;
    }
  }
  if (!inStack) return;
  if (
    type === "text" &&
    patch.height === undefined &&
    patch.heightMode === undefined
  )
    defaults.heightMode = "hug";
  if (type === "button" && row && patch.height === undefined)
    defaults.height = 36;
  if (patch.width !== undefined) return;
  if (type === "text" && patch.widthMode !== "fixed")
    defaults.width = fallbackTextWidth(bp, { ...defaults, ...patch });
  if (patch.widthMode !== undefined) return;
  if (type === "frame" || type === "text") {
    defaults.widthMode = row ? "hug" : "fill";
    if (type === "frame" && row) defaults.width = 80;
  } else if (type === "button" && row) {
    defaults.width = 96;
    defaults.widthMode = "hug";
  }
}

function normalizeGradient(
  raw: unknown,
  doc: DesignDocument,
): NodeStyle["gradient"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const g = raw as Record<string, unknown>;
  const type =
    g.type === "radial" || g.type === "angular" || g.type === "diamond"
      ? g.type
      : "linear";
  const angle = clamp(toFiniteNumber(g.angle) ?? 135, 0, 360);
  if (!Array.isArray(g.stops)) return undefined;
  const stops: NonNullable<NodeStyle["gradient"]>["stops"] = [];
  for (let i = 0; i < Math.min(g.stops.length, maxGradientStops); i++) {
    const s = g.stops[i];
    if (!s || typeof s !== "object") continue;
    const stopObj = s as Record<string, unknown>;
    const parsedColor = normalizeHexColor(stopObj.color);
    if (!parsedColor) continue;
    const offset = clamp(
      toFiniteNumber(stopObj.offset) ??
        (g.stops.length > 1 ? i / (g.stops.length - 1) : 0),
      0,
      1,
    );
    const opacity = clamp(
      toFiniteNumber(stopObj.opacity) ?? parsedColor.opacity ?? 1,
      0,
      1,
    );
    const varId =
      typeof stopObj.variableId === "string" &&
      doc.designSystem?.variables[stopObj.variableId]?.type === "color"
        ? stopObj.variableId
        : undefined;
    stops.push({
      offset,
      color: parsedColor.hex,
      opacity,
      ...(varId ? { variableId: varId } : {}),
    });
  }
  if (stops.length < 2) return undefined;
  return { type, angle, stops };
}

function normalizeShadows(raw: unknown): NodeStyle["shadows"] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: NonNullable<NodeStyle["shadows"]> = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const sh = item as Record<string, unknown>;
    const parsedColor = normalizeHexColor(sh.color) ?? { hex: "#0f172a" };
    result.push({
      x: clamp(toFiniteNumber(sh.x) ?? 0, -1000, 1000),
      y: clamp(toFiniteNumber(sh.y) ?? 4, -1000, 1000),
      blur: clamp(toFiniteNumber(sh.blur) ?? 12, 0, 1000),
      spread: clamp(toFiniteNumber(sh.spread) ?? 0, -1000, 1000),
      color: parsedColor.hex,
      opacity: clamp(
        toFiniteNumber(sh.opacity) ?? parsedColor.opacity ?? 0.12,
        0,
        1,
      ),
      inset: Boolean(sh.inset),
      ...(typeof sh.visible === "boolean" ? { visible: sh.visible } : {}),
    });
  }
  return result.length ? result : undefined;
}

export function normalizeStylePatch(
  rawInput: Record<string, unknown> | undefined,
  doc: DesignDocument,
  referenceFontSize?: number,
): Partial<NodeStyle> {
  if (!rawInput || typeof rawInput !== "object") return {};
  const raw = rawInput;
  const patch: Record<string, unknown> = {};

  // Aliases
  const rawFill = raw.fill ?? raw.background ?? raw.backgroundColor;
  const rawRadius = raw.radius ?? raw.borderRadius;
  const rawStroke = raw.stroke ?? raw.borderColor;
  const rawStrokeWidth = raw.strokeWidth ?? raw.borderWidth;

  const numField = (key: string, val: unknown, min: number, max: number) => {
    const n = toFiniteNumber(val);
    if (n !== undefined) patch[key] = clamp(n, min, max);
  };
  const intField = (key: string, val: unknown, min: number, max: number) => {
    const n = toFiniteNumber(val);
    if (n !== undefined) patch[key] = Math.round(clamp(n, min, max));
  };

  const x = toFiniteNumber(raw.x);
  if (x !== undefined) patch.x = x;
  const y = toFiniteNumber(raw.y);
  if (y !== undefined) patch.y = y;

  numField("width", raw.width, 1, 10000);
  numField("height", raw.height, 1, 10000);
  numField("minWidth", raw.minWidth, 1, 10000);
  numField("maxWidth", raw.maxWidth, 1, 10000);
  numField("minHeight", raw.minHeight, 1, 10000);
  numField("maxHeight", raw.maxHeight, 1, 10000);

  if (
    typeof patch.minWidth === "number" &&
    typeof patch.maxWidth === "number" &&
    patch.minWidth > patch.maxWidth
  ) {
    patch.maxWidth = patch.minWidth;
  }
  if (
    typeof patch.minHeight === "number" &&
    typeof patch.maxHeight === "number" &&
    patch.minHeight > patch.maxHeight
  ) {
    patch.maxHeight = patch.minHeight;
  }

  if (
    raw.widthMode === "fixed" ||
    raw.widthMode === "hug" ||
    raw.widthMode === "fill"
  ) {
    patch.widthMode = raw.widthMode;
  }
  if (
    raw.heightMode === "fixed" ||
    raw.heightMode === "hug" ||
    raw.heightMode === "fill"
  ) {
    patch.heightMode = raw.heightMode;
  }

  numField("rotation", raw.rotation, -360, 360);
  if (typeof raw.flipX === "boolean") patch.flipX = raw.flipX;
  if (typeof raw.flipY === "boolean") patch.flipY = raw.flipY;

  if (rawFill !== undefined) {
    const c = normalizeHexColor(rawFill);
    if (c) {
      patch.fill = c.hex;
      if (c.opacity !== undefined && raw.fillOpacity === undefined) {
        patch.fillOpacity = c.opacity;
      }
    }
  }
  if (raw.color !== undefined) {
    const c = normalizeHexColor(raw.color);
    if (c) {
      patch.color = c.hex;
      if (c.opacity !== undefined && raw.colorOpacity === undefined) {
        patch.colorOpacity = c.opacity;
      }
    }
  }
  if (rawStroke !== undefined) {
    const c = normalizeHexColor(rawStroke);
    if (c) {
      patch.stroke = c.hex;
      if (c.opacity !== undefined && raw.strokeOpacity === undefined) {
        patch.strokeOpacity = c.opacity;
      }
    }
  }

  numField("radius", rawRadius, 0, 1000);
  numField("cornerSmoothing", raw.cornerSmoothing, 0, 1);
  if (Number(patch.cornerSmoothing) > 0) patch.cornerSmoothingModel = "figma";
  numField("fontSize", raw.fontSize, 1, 500);
  numField("padding", raw.padding, 0, 1000);
  numField("gap", raw.gap, 0, 1000);
  numField("rowGap", raw.rowGap, 0, 1000);
  numField("opacity", raw.opacity, 0, 1);
  numField("fillOpacity", raw.fillOpacity, 0, 1);
  numField("colorOpacity", raw.colorOpacity, 0, 1);
  numField("strokeOpacity", raw.strokeOpacity, 0, 1);
  numField("strokeWidth", rawStrokeWidth, 0, 100);
  numField("blur", raw.blur, 0, 100);
  numField("backdropBlur", raw.backdropBlur, 0, 512);
  numField("backdropSaturation", raw.backdropSaturation, 0, 4);
  numField("backdropBrightness", raw.backdropBrightness, 0, 4);
  for (const key of ["blur", "backdropBlur"] as const) {
    const visible = key + "Visible";
    if (typeof raw[visible] === "boolean") patch[visible] = raw[visible];
    else if (Number(patch[key]) > 0) patch[visible] = true;
  }
  if (raw.tint !== undefined) {
    const tint =
      raw.tint && typeof raw.tint === "object"
        ? (raw.tint as Record<string, unknown>)
        : { color: raw.tint, opacity: undefined };
    const color = normalizeHexColor(tint.color);
    if (color)
      patch.tint = {
        color: color.hex,
        opacity: clamp(
          toFiniteNumber(tint.opacity) ?? color.opacity ?? 1,
          0,
          1,
        ),
      };
  }
  numField("letterSpacing", raw.letterSpacing, -50, 200);
  intField("columns", raw.columns, 1, 64);
  intField("columnSpan", raw.columnSpan, 1, 64);
  intField("rowSpan", raw.rowSpan, 1, 64);
  intField("maxLines", raw.maxLines, 1, 100);
  numField("minColumnWidth", raw.minColumnWidth, 0, 10000);
  numField("gridRowHeight", raw.gridRowHeight, 1, 10000);

  if (typeof raw.fontWeight === "string") {
    const mapped = FONT_WEIGHT_NAMES[raw.fontWeight.trim().toLowerCase()];
    if (mapped) patch.fontWeight = mapped;
    else intField("fontWeight", raw.fontWeight, 100, 900);
  } else {
    intField("fontWeight", raw.fontWeight, 100, 900);
  }

  const rawLh = toFiniteNumber(raw.lineHeight);
  if (rawLh !== undefined) {
    const effectiveFontSize =
      typeof patch.fontSize === "number"
        ? patch.fontSize
        : (referenceFontSize ?? 16);
    const pxLh =
      rawLh > 0 && rawLh <= 4 && effectiveFontSize >= 10
        ? Math.round(rawLh * effectiveFontSize)
        : rawLh;
    patch.lineHeight = clamp(pxLh, 1, 1000);
  }

  if (typeof raw.fontFamily === "string" && raw.fontFamily.trim()) {
    patch.fontFamily = raw.fontFamily.trim().slice(0, 200);
  }
  if (raw.fontStyle === "normal" || raw.fontStyle === "italic") {
    patch.fontStyle = raw.fontStyle;
  }
  if (
    raw.textDecoration === "none" ||
    raw.textDecoration === "underline" ||
    raw.textDecoration === "line-through"
  ) {
    patch.textDecoration = raw.textDecoration;
  }
  if (
    raw.textTransform === "none" ||
    raw.textTransform === "uppercase" ||
    raw.textTransform === "lowercase" ||
    raw.textTransform === "capitalize"
  ) {
    patch.textTransform = raw.textTransform;
  }
  if (
    raw.textAlign === "left" ||
    raw.textAlign === "center" ||
    raw.textAlign === "right" ||
    raw.textAlign === "justify"
  ) {
    patch.textAlign = raw.textAlign;
  }
  if (
    raw.verticalAlign === "top" ||
    raw.verticalAlign === "middle" ||
    raw.verticalAlign === "bottom"
  ) {
    patch.verticalAlign = raw.verticalAlign;
  }

  // Layout & alignment
  const rawLayout = raw.layout ?? raw.direction;
  if (typeof rawLayout === "string") {
    const l = rawLayout.trim().toLowerCase();
    if (l === "free" || l === "row" || l === "column" || l === "grid") {
      patch.layout = l;
    } else if (l === "horizontal") {
      patch.layout = "row";
    } else if (l === "vertical") {
      patch.layout = "column";
    }
  }

  if (typeof raw.justifyContent === "string") {
    const jc = raw.justifyContent.trim().toLowerCase();
    if (jc === "space-between" || jc === "between" || jc === "space_between") {
      patch.justifyContent = "space-between";
    } else if (jc === "pack") {
      patch.justifyContent = "pack";
    }
  }
  if (
    raw.alignX === "start" ||
    raw.alignX === "center" ||
    raw.alignX === "end"
  ) {
    patch.alignX = raw.alignX;
  }
  if (
    raw.alignY === "start" ||
    raw.alignY === "center" ||
    raw.alignY === "end"
  ) {
    patch.alignY = raw.alignY;
  }
  if (typeof raw.wrap === "boolean") patch.wrap = raw.wrap;
  if (typeof raw.absolutePosition === "boolean") {
    patch.absolutePosition = raw.absolutePosition;
  }
  if (typeof raw.clipContent === "boolean") patch.clipContent = raw.clipContent;
  if (typeof raw.strokeVisible === "boolean") {
    patch.strokeVisible = raw.strokeVisible;
  }
  if (
    raw.strokeAlign === "inside" ||
    raw.strokeAlign === "center" ||
    raw.strokeAlign === "outside"
  ) {
    patch.strokeAlign = raw.strokeAlign;
  }
  if (
    raw.strokeStyle === "solid" ||
    raw.strokeStyle === "dashed" ||
    raw.strokeStyle === "dotted" ||
    raw.strokeStyle === "double"
  ) {
    patch.strokeStyle = raw.strokeStyle;
  }

  const parseBoxShorthand = (val: unknown) => {
    if (Array.isArray(val) && val.length > 0) {
      const nums = val.map(toFiniteNumber);
      if (nums.every((n): n is number => n !== undefined)) {
        const [a, b = a, c = a, d = b] = nums.map((n) => clamp(n, 0, 1000));
        return { top: a, right: b, bottom: c, left: d };
      }
    }
    return undefined;
  };

  if (Array.isArray(raw.insets)) {
    const sh = parseBoxShorthand(raw.insets);
    if (sh) patch.insets = sh;
  } else if (raw.insets && typeof raw.insets === "object") {
    const ins = raw.insets as Record<string, unknown>;
    patch.insets = {
      top: clamp(toFiniteNumber(ins.top) ?? 0, 0, 1000),
      right: clamp(toFiniteNumber(ins.right) ?? 0, 0, 1000),
      bottom: clamp(toFiniteNumber(ins.bottom) ?? 0, 0, 1000),
      left: clamp(toFiniteNumber(ins.left) ?? 0, 0, 1000),
    };
  } else if (Array.isArray(raw.padding)) {
    const sh = parseBoxShorthand(raw.padding);
    if (sh) patch.insets = sh;
  } else {
    const px = toFiniteNumber(raw.paddingX ?? raw.paddingHorizontal);
    const py = toFiniteNumber(raw.paddingY ?? raw.paddingVertical);
    const pt = toFiniteNumber(raw.paddingTop);
    const pr = toFiniteNumber(raw.paddingRight);
    const pb = toFiniteNumber(raw.paddingBottom);
    const pl = toFiniteNumber(raw.paddingLeft);
    if (
      px !== undefined ||
      py !== undefined ||
      pt !== undefined ||
      pr !== undefined ||
      pb !== undefined ||
      pl !== undefined
    ) {
      const basePad = typeof patch.padding === "number" ? patch.padding : 0;
      patch.insets = {
        top: clamp(pt ?? py ?? basePad, 0, 1000),
        right: clamp(pr ?? px ?? basePad, 0, 1000),
        bottom: clamp(pb ?? py ?? basePad, 0, 1000),
        left: clamp(pl ?? px ?? basePad, 0, 1000),
      };
    }
  }

  if (Array.isArray(raw.corners) && raw.corners.length > 0) {
    const nums = raw.corners.map(toFiniteNumber);
    if (nums.every((n): n is number => n !== undefined)) {
      const [tl, tr = tl, br = tl, bl = tr] = nums.map((n) =>
        clamp(n, 0, 1000),
      );
      patch.corners = { tl, tr, br, bl };
    }
  } else if (raw.corners && typeof raw.corners === "object") {
    const c = raw.corners as Record<string, unknown>;
    patch.corners = {
      tl: clamp(toFiniteNumber(c.tl) ?? 0, 0, 1000),
      tr: clamp(toFiniteNumber(c.tr) ?? 0, 0, 1000),
      br: clamp(toFiniteNumber(c.br) ?? 0, 0, 1000),
      bl: clamp(toFiniteNumber(c.bl) ?? 0, 0, 1000),
    };
  }

  const gradient = normalizeGradient(raw.gradient, doc);
  if (gradient) patch.gradient = gradient;

  const shadows = normalizeShadows(raw.shadows);
  if (shadows) patch.shadows = shadows;

  if (raw.strokeSides !== undefined) {
    const defaultWidth =
      typeof patch.strokeWidth === "number" && patch.strokeWidth > 0
        ? clamp(patch.strokeWidth, 0, 64)
        : 1;
    const validSides = ["top", "right", "bottom", "left"] as const;
    const normalizedSides: Record<string, number> = {};
    if (Array.isArray(raw.strokeSides)) {
      const selected = new Set(
        raw.strokeSides
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().toLowerCase())
          .filter((item) => (validSides as readonly string[]).includes(item)),
      );
      if (selected.size > 0) {
        for (const side of validSides) {
          normalizedSides[side] = selected.has(side) ? defaultWidth : 0;
        }
      }
    } else if (raw.strokeSides && typeof raw.strokeSides === "object") {
      const obj = raw.strokeSides as Record<string, unknown>;
      let sawBoolean = false;
      for (const side of validSides) {
        const v = obj[side];
        if (typeof v === "boolean") {
          sawBoolean = true;
          normalizedSides[side] = v ? defaultWidth : 0;
        } else {
          const n = toFiniteNumber(v);
          if (n !== undefined && n >= 0) {
            normalizedSides[side] = clamp(n, 0, 64);
          }
        }
      }
      if (sawBoolean) {
        for (const side of validSides) {
          if (normalizedSides[side] === undefined) normalizedSides[side] = 0;
        }
      }
    }
    if (Object.keys(normalizedSides).length > 0) {
      const parsedSides =
        styleSchema.shape.strokeSides.safeParse(normalizedSides);
      if (parsedSides.success) patch.strokeSides = parsedSides.data;
    }
  }

  for (const key of [
    "blendMode",
    "fillBlendMode",
    "strokeBlendMode",
    "leadingTrim",
    "fontSmoothing",
    "textEffectClip",
    "strokeDash",
    "paints",
    "strokePaints",
    "gridTracks",
    "gridRowTracks",
    "layoutBreakpoints",
  ] as const) {
    if (raw[key] !== undefined) {
      const parsed = styleSchema.shape[key].safeParse(raw[key]);
      if (parsed.success) patch[key] = parsed.data;
    }
  }
  return patch as Partial<NodeStyle>;
}

function normalizeControl(
  raw: Record<string, unknown> | undefined,
): DesignNode["control"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const kind = raw.kind;
  const validKinds = [
    "button",
    "switch",
    "checkbox",
    "textfield",
    "slider",
    "stepper",
    "segmented",
    "progress",
  ] as const;
  if (
    typeof kind !== "string" ||
    !(validKinds as readonly string[]).includes(kind)
  ) {
    return undefined;
  }
  const typedKind = kind as (typeof validKinds)[number];
  const label = typeof raw.label === "string" ? raw.label.slice(0, 200) : "";

  let value: boolean | string | number = "";
  if (typedKind === "switch" || typedKind === "checkbox") {
    value = Boolean(raw.value);
  } else if (
    typedKind === "slider" ||
    typedKind === "stepper" ||
    typedKind === "progress"
  ) {
    value = toFiniteNumber(raw.value) ?? 50;
  } else if (typeof raw.value === "string") {
    value = raw.value.slice(0, 10000);
  } else if (typeof raw.value === "number" || typeof raw.value === "boolean") {
    value = raw.value;
  }

  const options =
    Array.isArray(raw.options) && raw.options.length > 0
      ? raw.options
          .filter((o): o is string => typeof o === "string" && o.length > 0)
          .slice(0, 20)
          .map((o) => o.slice(0, 200))
      : undefined;

  let palette: NonNullable<DesignNode["control"]>["palette"];
  if (raw.palette && typeof raw.palette === "object") {
    const p = raw.palette as Record<string, unknown>;
    const accent = normalizeHexColor(p.accent)?.hex;
    const track = normalizeHexColor(p.track)?.hex;
    const surface = normalizeHexColor(p.surface)?.hex;
    const border = normalizeHexColor(p.border)?.hex;
    if (accent && track && surface) {
      palette = { accent, track, surface, ...(border ? { border } : {}) };
    }
  }

  const min = toFiniteNumber(raw.min);
  const max = toFiniteNumber(raw.max);
  const step = toFiniteNumber(raw.step);

  return {
    kind: typedKind,
    label,
    value,
    ...(typeof raw.disabled === "boolean" ? { disabled: raw.disabled } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined && step > 0 ? { step } : {}),
    ...(options && options.length ? { options } : {}),
    ...(palette ? { palette } : {}),
  };
}

function normalizeVector(
  raw: Record<string, unknown> | undefined,
): DesignNode["vector"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (!Array.isArray(raw.paths) || raw.paths.length === 0) return undefined;
  const width = clamp(toFiniteNumber(raw.width) ?? 24, 1, 10000);
  const height = clamp(toFiniteNumber(raw.height) ?? 24, 1, 10000);
  const pathRegex = /^[MmZzLlHhVvCcSsQqTtAaEe0-9.,+\s-]+$/;
  const paths: NonNullable<DesignNode["vector"]>["paths"] = [];

  for (const p of raw.paths.slice(0, 100)) {
    if (!p || typeof p !== "object") continue;
    const po = p as Record<string, unknown>;
    if (typeof po.d !== "string" || !po.d.trim() || !pathRegex.test(po.d)) {
      continue;
    }
    const fillColor = normalizeHexColor(po.fillColor)?.hex;
    const strokeColor = normalizeHexColor(po.strokeColor)?.hex;
    paths.push({
      d: po.d.slice(0, 100000),
      fill: typeof po.fill === "boolean" ? po.fill : true,
      strokeWidth: clamp(toFiniteNumber(po.strokeWidth) ?? 0, 0, 100),
      ...(fillColor ? { fillColor } : {}),
      ...(strokeColor ? { strokeColor } : {}),
      ...(po.lineCap === "round" ||
      po.lineCap === "square" ||
      po.lineCap === "butt"
        ? { lineCap: po.lineCap }
        : {}),
      ...(po.lineJoin === "miter" ||
      po.lineJoin === "round" ||
      po.lineJoin === "bevel"
        ? { lineJoin: po.lineJoin }
        : {}),
    });
  }
  if (!paths.length) return undefined;
  return { width, height, paths };
}

function blueprintVector(
  bp: BlueprintNode,
  diagnostics: CompileDiagnostic[],
):
  | {
      vector: NonNullable<DesignNode["vector"]>;
      defaults?: Partial<NodeStyle>;
      iconColor?: string;
    }
  | undefined {
  const color =
    [bp.iconColor, bp.style?.color, bp.style?.stroke]
      .map(normalizeHexColor)
      .find(Boolean)?.hex ?? "#111827";
  if (typeof bp.svg === "string") {
    const parsed = svgToVector(bp.svg, color);
    if (parsed)
      return {
        vector: parsed.vector,
        defaults: {
          width: parsed.width,
          height: parsed.height,
          fillOpacity: 0,
          color,
        },
      };
    diagnostics.push({
      severity: "warning",
      code: "invalid-svg",
      message: "SVG 中没有可导入的矢量图形，或尺寸、路径超出了支持范围。",
    });
  }
  const native = normalizeVector(bp.vector);
  if (
    typeof bp.icon === "string" ||
    (typeof bp.type === "string" &&
      bp.type.trim().toLowerCase() === "icon" &&
      !native)
  ) {
    const name =
      typeof bp.icon === "string"
        ? bp.icon
        : typeof bp.name === "string"
          ? bp.name
          : "";
    const options = {
      color,
      strokeWidth: toFiniteNumber(bp.iconStrokeWidth ?? bp.style?.strokeWidth),
    };
    let vector = iconToFormaVector(name, options);
    if (!vector) {
      const suggestions = searchIcons(name, 3).map((icon) => icon.name);
      diagnostics.push({
        severity: "warning",
        code: "unknown-icon",
        message: "找不到图标 " + name + "，已使用 sparkles。",
        suggestion:
          "可用图标：" +
          (suggestions.length ? suggestions : ["sparkles", "circle"]).join(
            "、",
          ),
      });
      vector = iconToFormaVector("sparkles", options)!;
    }
    return {
      vector,
      iconColor: color,
      defaults: { width: 20, height: 20, fillOpacity: 0, color },
    };
  }
  if (native) return { vector: native };
}

const imageRanges = {
  opacity: [0, 1],
  x: [0, 100],
  y: [0, 100],
  zoom: [1, 8],
  tileScale: [0.1, 8],
  rotation: [-360, 360],
  brightness: [0, 2],
  contrast: [0, 2],
  saturation: [0, 2],
  exposure: [-1, 1],
  temperature: [-1, 1],
  tint: [-1, 1],
  highlights: [-1, 1],
  shadows: [-1, 1],
} as const;

function blueprintImageFill(bp: BlueprintNode, assetId: string): ImageFill {
  const options = {
    ...bp.imageAdjustments,
    fit: bp.imageFit,
    opacity: bp.imageOpacity,
    ...(typeof bp.image === "object" ? bp.image : {}),
  };
  const fit = options.fit;
  const image: ImageFill = {
    assetId,
    fit: fit === "contain" || fit === "fill" || fit === "tile" ? fit : "cover",
    x: 50,
    y: 50,
    zoom: 1,
  };
  for (const key of Object.keys(imageRanges) as (keyof typeof imageRanges)[]) {
    const n = toFiniteNumber(options[key]);
    const [min, max] = imageRanges[key];
    if (n !== undefined) image[key] = clamp(n, min, max);
  }
  return image;
}

function promoteImageGradient(
  style: NodeStyle,
  opacity: number,
  diagnostics: CompileDiagnostic[],
) {
  if (!style.gradient) return;
  const paints = style.paints ?? [];
  if (paints.length >= 16) {
    diagnostics.push({
      severity: "error",
      code: "image-paint-limit",
      message: "叠加在图片上的填充与渐变总数不能超过 16。",
    });
    return;
  }
  let id = "image-scrim";
  while (paints.some((p) => p.id === id)) id += "-1";
  // separateImageOverlay places all paints above the image and the base below it.
  style.paints = [
    ...paints,
    {
      id,
      color: style.fill,
      opacity,
      visible: true,
      gradient: style.gradient,
      ...(style.fillBlendMode ? { blendMode: style.fillBlendMode } : {}),
    },
  ];
  delete style.gradient;
}

// Read only the SVG primitives Forma can store. Never mount markup, resolve a URL,
// or collect geometry from non-rendered subtrees such as defs and foreignObject.
const svgShapes = new Set([
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
]);
const svgPresentation = [
  "color",
  "fill",
  "stroke",
  "stroke-width",
  "fill-rule",
  "fill-opacity",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "visibility",
];
function svgTransform(value: string, parent: Matrix) {
  const command =
    /\s*,?\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)/gy;
  let result = parent;
  for (let i = 0; i < value.length; i = command.lastIndex) {
    const match = command.exec(value);
    if (!match) return;
    const args = match[2]
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (!args.every(Number.isFinite)) return;
    const [a, b, c, d, e, f] = args;
    let next: Matrix;
    if (match[1] === "matrix" && args.length === 6) next = { a, b, c, d, e, f };
    else if (match[1] === "translate" && args.length <= 2)
      next = { ...identity, e: a, f: b ?? 0 };
    else if (match[1] === "scale" && args.length <= 2)
      next = { ...identity, a, d: b ?? a };
    else if (
      match[1] === "rotate" &&
      (args.length === 1 || args.length === 3)
    ) {
      const cos = Math.cos((a * Math.PI) / 180),
        sin = Math.sin((a * Math.PI) / 180);
      const x = b ?? 0,
        y = c ?? 0;
      next = {
        a: cos,
        b: sin,
        c: -sin,
        d: cos,
        e: x - cos * x + sin * y,
        f: y - sin * x - cos * y,
      };
    } else if (
      (match[1] === "skewX" || match[1] === "skewY") &&
      args.length === 1
    ) {
      next = {
        ...identity,
        [match[1] === "skewX" ? "c" : "b"]: Math.tan((a * Math.PI) / 180),
      };
    } else return;
    result = compose(result, next);
  }
  return result;
}

function svgAttributes(source: string) {
  const attrs: Record<string, string> = Object.create(null);
  const attr = /\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
  for (let i = 0; i < source.length; i = attr.lastIndex) {
    const m = attr.exec(source);
    if (!m) return;
    attrs[m[1]] = m[2] ?? m[3];
  }
  // Inline declarations override presentation attributes.
  for (const declaration of (attrs.style ?? "").split(";")) {
    const split = declaration.indexOf(":");
    const key = declaration.slice(0, split).trim();
    if (split > 0 && [...svgPresentation, "display", "opacity"].includes(key)) {
      attrs[key] = declaration.slice(split + 1).trim();
    }
  }
  return attrs;
}

function svgOpacity(value: string | undefined) {
  if (!value) return 1;
  const percent = value.endsWith("%");
  const n = toFiniteNumber(percent ? value.slice(0, -1) : value);
  return n === undefined ? 1 : clamp(percent ? n / 100 : n, 0, 1);
}

function svgColor(raw: string, currentColor: string) {
  const s = raw.toLowerCase() === "currentcolor" ? currentColor : raw;
  if (s === "none") return null;
  const hex = svgHexColor(s);
  return hex ? { hex, opacity: 1 } : normalizeHexColor(s);
}

function svgToVector(source: string, color: string) {
  if (source.length > 500000 || /<!DOCTYPE|<!ENTITY/i.test(source)) return;
  const xml = source.trim().replace(/^<\?xml\s+[^?]*\?>\s*/i, "");
  const token =
    /<!--[\s\S]*?-->|<(\/?)([\w:-]+)(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>|([^<]+)/gy;
  type Scope = {
    tag: string;
    hidden: boolean;
    paints: Record<string, string>;
    matrix: Matrix;
    opacity: number;
  };
  const stack: Scope[] = [];
  let vector: DesignNode["vector"];
  let width: number | undefined, height: number | undefined;
  for (let i = 0; i < xml.length; i = token.lastIndex) {
    const match = token.exec(xml);
    if (!match || stack.length > 64) return;
    const [, closing, tag, attributes, content] = match;
    if (!tag) {
      if (!stack.length && content?.trim()) return;
      continue;
    }
    if (closing) {
      if (attributes.trim() || stack.pop()?.tag !== tag) return;
      continue;
    }
    const parent = stack.at(-1);
    if (!parent && (vector || tag !== "svg")) return;
    const selfClosing = attributes.endsWith("/");
    const attrs = svgAttributes(
      (selfClosing ? attributes.slice(0, -1) : attributes).trimEnd(),
    );
    if (!attrs) return;
    const paints = {
      ...(parent?.paints ?? { color, fill: "#000000", stroke: "none" }),
    };
    for (const key of svgPresentation) {
      if (attrs[key] && attrs[key] !== "inherit") paints[key] = attrs[key];
    }
    let matrix = parent?.matrix ?? identity;
    if (!parent) {
      const box = attrs.viewBox
        ?.trim()
        .split(/[\s,]+/)
        .map(Number);
      if (box && (box.length !== 4 || !box.every(Number.isFinite))) return;
      width = toFiniteNumber(attrs.width);
      height = toFiniteNumber(attrs.height);
      const [x, y, w, h] = box ?? [0, 0, width ?? 24, height ?? 24];
      if (w <= 0 || h <= 0 || w > 10000 || h > 10000) return;
      matrix = { ...identity, e: -x, f: -y };
      vector = {
        width: w,
        height: h,
        paths: [],
        ...(attrs.preserveAspectRatio === "none" ? { stretch: true } : {}),
      };
    }
    const hidden =
      !!parent?.hidden ||
      attrs.display === "none" ||
      (!!parent && tag !== "g" && !svgShapes.has(tag)) ||
      (!!parent && parent.tag !== "g" && parent.tag !== "svg");
    const transformed = hidden
      ? matrix
      : svgTransform((attrs.transform ?? "").trim(), matrix);
    if (!transformed) return;
    const scope = {
      tag,
      hidden,
      paints,
      matrix: transformed,
      opacity: (parent?.opacity ?? 1) * svgOpacity(attrs.opacity),
    };
    if (!selfClosing) stack.push(scope);
    if (
      hidden ||
      paints.visibility === "hidden" ||
      !svgShapes.has(tag) ||
      !vector
    )
      continue;
    const [raw] = iconPrimitivesToSvgPaths([[tag, attrs]]);
    if (!raw) continue;
    const { a, b, c, d, e, f } = transformed;
    const data =
      a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0
        ? raw
        : svgpath(raw).abs().matrix([a, b, c, d, e, f]).round(6).toString();
    if (data.length > 100000 || /NaN|Infinity/.test(data)) return;
    const fill = svgColor(paints.fill, paints.color),
      stroke = svgColor(paints.stroke, paints.color);
    if (!fill && !stroke) continue;
    const cap = paints["stroke-linecap"],
      join = paints["stroke-linejoin"];
    const scale = Math.hypot(a, b);
    if (
      stroke &&
      (Math.abs(scale - Math.hypot(c, d)) > 1e-5 ||
        Math.abs(a * c + b * d) > 1e-5)
    )
      return;
    vector.paths.push({
      d: data,
      fill: !!fill,
      ...(fill
        ? {
            fillColor: fill.hex,
            fillOpacity:
              svgOpacity(paints["fill-opacity"]) * (fill.opacity ?? 1),
          }
        : {}),
      ...(stroke
        ? {
            strokeColor: stroke.hex,
            strokeOpacity:
              svgOpacity(paints["stroke-opacity"]) * (stroke.opacity ?? 1),
          }
        : {}),
      strokeWidth: stroke
        ? clamp((toFiniteNumber(paints["stroke-width"]) ?? 1) * scale, 0, 100)
        : 0,
      lineCap: cap === "round" || cap === "square" ? cap : "butt",
      lineJoin: join === "round" || join === "bevel" ? join : "miter",
      fillRule: paints["fill-rule"] === "evenodd" ? "evenodd" : "nonzero",
      opacity: scope.opacity,
    });
    if (vector.paths.length > 100) return;
  }
  if (!stack.length && vector?.paths.length)
    return {
      vector,
      width: clamp(width ?? vector.width, 1, 10000),
      height: clamp(height ?? vector.height, 1, 10000),
    };
}

function normalizeInteraction(
  raw: BlueprintInteraction | undefined,
  refMap: ReadonlyMap<string, string>,
  validTargets: ReadonlySet<string>,
  isTopLevelFrame: boolean,
): Interaction | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const actions: NonNullable<Interaction["actions"]> = [];

  const transition =
    raw.transition && typeof raw.transition === "object"
      ? {
          type: ([
            "instant",
            "dissolve",
            "smart-animate",
            "move-in",
            "push",
            "slide-in",
          ].includes(raw.transition.type ?? "")
            ? raw.transition.type
            : "dissolve") as
            | "instant"
            | "dissolve"
            | "smart-animate"
            | "move-in"
            | "push"
            | "slide-in",
          ...(raw.transition.direction &&
          ["left", "right", "top", "bottom"].includes(raw.transition.direction)
            ? { direction: raw.transition.direction }
            : {}),
          ...(raw.transition.duration !== undefined
            ? { duration: clamp(raw.transition.duration, 0, 5000) }
            : {}),
          ...(raw.transition.easing &&
          ["linear", "ease-out", "ease-in-out"].includes(raw.transition.easing)
            ? { easing: raw.transition.easing }
            : {}),
        }
      : undefined;

  const resolveRef = (ref?: string) => {
    if (!ref) return undefined;
    const mapped = refMap.get(ref) ?? ref;
    return validTargets.has(mapped) ? mapped : undefined;
  };

  const navTarget = resolveRef(raw.navigateToRef ?? raw.navigateToId);
  if (navTarget) {
    actions.push({
      kind: "navigate",
      target: navTarget,
      ...(transition ? { transition } : {}),
    });
  }

  const overlayTarget = resolveRef(raw.overlayRef ?? raw.overlayId);
  if (overlayTarget) {
    actions.push({
      kind: "overlay",
      target: overlayTarget,
      position: raw.position === "center" ? "center" : "bottom",
      ...(transition ? { transition } : {}),
    });
  }

  if (raw.back) actions.push({ kind: "back" });
  if (raw.close) actions.push({ kind: "close" });
  if (raw.reset) actions.push({ kind: "reset" });
  if (
    typeof raw.openLink === "string" &&
    /^https?:\/\//i.test(raw.openLink.trim())
  ) {
    actions.push({ kind: "openLink", url: raw.openLink.trim() });
  }

  // Also preserve valid raw actions if provided and no shorthand was given
  if (actions.length === 0 && Array.isArray(raw.actions)) {
    for (const candidate of raw.actions) {
      if (!candidate || typeof candidate !== "object") continue;
      const copy = { ...(candidate as Record<string, unknown>) };
      if (typeof copy.target === "string") {
        copy.target = refMap.get(copy.target) ?? copy.target;
      }
      const parsedAction = interactionSchema.shape.actions
        .unwrap()
        .element.safeParse(copy);
      if (parsedAction.success) {
        actions.push(parsedAction.data);
      }
    }
  }

  const candidate: Record<string, unknown> = {};
  if (raw.trigger && ["click", "hover", "delay"].includes(raw.trigger)) {
    candidate.trigger = raw.trigger;
  } else if (actions.length > 0) {
    candidate.trigger = "click";
  }
  if (raw.delayMs !== undefined && Number.isFinite(raw.delayMs)) {
    candidate.delayMs = Math.max(0, Math.round(raw.delayMs));
  }
  if (isTopLevelFrame && typeof raw.flow === "string" && raw.flow.trim()) {
    candidate.flow = raw.flow.trim().slice(0, 100);
  }
  if (raw.scroll && ["vertical", "horizontal", "both"].includes(raw.scroll)) {
    candidate.scroll = raw.scroll;
  }
  if (actions.length > 0) {
    candidate.actions = actions;
  }

  if (Object.keys(candidate).length === 0) return undefined;
  const parsed = interactionSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function candidates(items: { id: string; name: string }[]): string {
  return (
    items
      .slice(0, 5)
      .map((item) => item.id + " (" + item.name + ")")
      .join(", ") || "无"
  );
}

function variableDiagnostic(
  doc: DesignDocument,
  property: string,
  id: string,
): CompileDiagnostic | null {
  const variables = Object.values(doc.designSystem?.variables ?? {});
  const variable = doc.designSystem?.variables[id];
  const accepts = (v: (typeof variables)[number]) =>
    v.type === propertyType(property) &&
    (!v.scopes.length || v.scopes.includes(property as VariableProperty));
  const reason = !VALID_VARIABLE_PROPS.has(property)
    ? "属性不存在"
    : !variable
      ? "变量不存在"
      : variable.type !== propertyType(property)
        ? "变量类型不匹配"
        : !accepts(variable)
          ? "变量作用域不匹配"
          : "";
  return reason
    ? {
        severity: "error",
        code: "invalid-variable",
        message: reason + "：" + id + " → " + property,
        suggestion: "可用变量：" + candidates(variables.filter(accepts)),
      }
    : null;
}

function styleDiagnostic(
  doc: DesignDocument,
  type: DesignNode["type"],
  id: string,
  slot?: string,
  layout?: string,
): CompileDiagnostic | null {
  const style = doc.designSystem?.styles[id];
  const compatible = (kind: string) =>
    !slot || slot === kind || (kind === "paint" && slot === "stroke");
  const reason = !style
    ? "样式不存在"
    : !compatible(style.kind)
      ? "样式类型与槽位不匹配"
      : style.kind === "grid" && (type !== "frame" || layout !== "grid")
        ? "网格样式需要网格画板"
        : "";
  return reason
    ? {
        severity: "error",
        code: "invalid-style",
        message: reason + "：" + id + " → " + (slot ?? type),
        suggestion:
          "可用样式：" +
          candidates(
            Object.values(doc.designSystem?.styles ?? {}).filter((s) =>
              compatible(s.kind),
            ),
          ),
      }
    : null;
}

function validateBindingsForNode(
  doc: DesignDocument,
  nodeType: DesignNode["type"],
  bp: BlueprintNode,
  layout: string,
  stats: CompileBlueprintStats,
  diagnostics: CompileDiagnostic[],
) {
  const result: Pick<
    DesignNode,
    "fillToken" | "variableBindings" | "styleBindings"
  > = {};
  if (bp.fillToken) {
    if (doc.tokens[bp.fillToken]) {
      result.fillToken = bp.fillToken;
      stats.tokensBound++;
    } else
      diagnostics.push({
        severity: "error",
        code: "unknown-token",
        message: "填充 Token 不存在：" + bp.fillToken,
      });
  }
  for (const [prop, id] of Object.entries(bp.variableBindings ?? {})) {
    const issue = variableDiagnostic(doc, prop, id);
    if (issue) diagnostics.push(issue);
    else {
      (result.variableBindings ??= {})[prop as VariableProperty] = id;
      stats.tokensBound++;
    }
  }
  for (const [slot, id] of Object.entries(bp.styleBindings ?? {})) {
    const issue = styleDiagnostic(doc, nodeType, id, slot, layout);
    if (issue) diagnostics.push(issue);
    else {
      (result.styleBindings ??= {})[
        slot as keyof NonNullable<DesignNode["styleBindings"]>
      ] = id;
      stats.tokensBound++;
    }
  }
  return result;
}

export function resolveLibraryComponent(
  doc: DesignDocument,
  libraryId: string | undefined,
  componentId: string | undefined,
  variantId: string | undefined,
  variantProperties: Record<string, string> | undefined,
  diagnostics: CompileDiagnostic[],
) {
  const libraries = Object.values(doc.libraries ?? {});
  const entries = libraries
    .filter((lib) => !libraryId || lib.id === libraryId)
    .flatMap((lib) => lib.components.map((component) => ({ lib, component })));
  const exactMatches = entries.filter((e) => e.component.id === componentId);
  if (exactMatches.length > 1) {
    diagnostics.push({
      severity: "error",
      code: "ambiguous-component",
      message: "多个库包含组件 " + componentId,
      suggestion:
        "请指定 libraryId：" + candidates(exactMatches.map((e) => e.lib)),
    });
    return null;
  }
  const exact = exactMatches[0];
  const key = componentId?.trim().toLowerCase();
  const names = entries.filter((e) => e.component.name.toLowerCase() === key);
  const matches = names.length
    ? names
    : entries.filter(
        (e) =>
          key &&
          e.component.name
            .split(/[/／›]/)
            .at(-1)
            ?.trim()
            .toLowerCase() === key,
      );
  const match = exact ?? (matches.length === 1 ? matches[0] : undefined);
  if (!match || !match.component.variants.length) {
    const options = entries.length
      ? entries.map((e) => e.component)
      : libraries.flatMap((lib) => lib.components);
    diagnostics.push({
      severity: "error",
      code: "unknown-component",
      message:
        "无法定位组件：" + [libraryId, componentId].filter(Boolean).join("/"),
      suggestion:
        "用 search_components 核对库与组件。候选：" + candidates(options),
    });
    return null;
  }
  const { lib, component } = match;
  if (!exact)
    diagnostics.push({
      severity: "warning",
      code: "component-name-resolved",
      message: "组件名 " + componentId + " 已解析为 " + component.id,
    });
  const variants = component.variants;
  const byId = variants.find((v) => v.id === variantId);
  const properties = Object.entries(variantProperties ?? {});
  const score = (v: (typeof variants)[number]) =>
    properties.filter(([k, val]) => v.properties[k] === val).length;
  const variant =
    byId ?? variants.reduce((best, v) => (score(v) > score(best) ? v : best));
  if ((variantId && !byId) || (!byId && score(variant) < properties.length))
    diagnostics.push({
      severity: "warning",
      code: "variant-fallback",
      message:
        "变体 " +
        (variantId ?? JSON.stringify(variantProperties)) +
        " 已匹配为 " +
        variant.id,
      suggestion: "可用变体：" + candidates(variants),
    });
  return {
    libraryId: lib.id,
    componentId: component.id,
    variantId: variant.id,
  };
}

function outerAdapt(bp: BlueprintNode | BlueprintEdit) {
  const adapt = bp.adapt;
  if (adapt?.detachOuter === true) return adapt;
  if (adapt && adapt.detachOuter === undefined && Array.isArray(bp.children))
    return adapt;
}

function appendedChildren(
  bp: BlueprintNode | BlueprintEdit,
  adapt: BlueprintAdaptSpec,
) {
  return [
    ...(Array.isArray(bp.children) ? bp.children : []),
    ...(Array.isArray(adapt.appendChildren) ? adapt.appendChildren : []),
  ];
}

// Library templates embed snapshots under outer template keys. Recover the inner
// namespace from its source, retaining the placed IDs, appearance and text overrides.
function restoreNestedInstances(
  snapshot: DesignDocument,
  root: DesignNode,
  operations: Transaction["operations"],
  diagnostics: CompileDiagnostic[],
) {
  const protectedChildren = new Set<string>();
  for (const slot of snapshot.nodes) {
    if (slot === root || !slot.nestedSource || protectedChildren.has(slot.id))
      continue;
    const ids = subtreeIds(snapshot, [slot.id]);
    for (const id of ids) if (id !== slot.id) protectedChildren.add(id);
    const members = snapshot.nodes.filter((n) => ids.has(n.id));
    let branch: DesignNode[];
    try {
      // A swap deeper inside this component was addressed by the outer key.
      // Carry the active choice into the standalone component's namespace.
      const slots = Object.fromEntries(
        members.flatMap((n) => {
          const ref = n.templateKey && root.instance?.slots?.[n.templateKey];
          const key = n.nestedPath?.[0] ?? n.nestedKey;
          return n !== slot && key && ref ? [[key, ref]] : [];
        }),
      );
      const standalone = {
        ...slot,
        instance: {
          ...slot.nestedSource,
          ...(Object.keys(slots).length ? { slots } : {}),
        },
      };
      const source = instanceSource(snapshot, standalone);
      const templates = new Map(
        source?.variant.nodes.map((n) => [n.templateKey, n]),
      );
      branch = members.map((node) => {
        const key =
          node.id === slot.id
            ? source?.variant.nodes.find((n) => !n.parentId)?.templateKey
            : (node.nestedPath?.[0] ?? node.nestedKey ?? node.templateKey);
        const template = templates.get(key);
        return {
          ...node,
          templateKey: key,
          nestedSource: template?.nestedSource,
          nestedKey: template?.nestedKey,
          nestedPath: template?.nestedPath,
          nestedSlot: template?.nestedSlot,
          instance: node.id === slot.id ? standalone.instance : undefined,
          locked: false,
        };
      });
      validateInstanceStructure({ ...snapshot, nodes: branch }, standalone);
    } catch {
      diagnostics.push({
        severity: "warning",
        code: "nested-source-unavailable",
        message: "保留嵌套图层快照，无法匹配组件定义：" + slot.name,
      });
      continue;
    }
    // Ordinary atoms only need their keys and source restored. A nested slot
    // inside the atom also needs source metadata that an update cannot write.
    if (
      branch.some(
        (n) => n.nestedSlot || n.nestedSource || n.nestedKey || n.nestedPath,
      )
    ) {
      operations.push({ type: "remove", id: slot.id });
      for (const node of branch) operations.push({ type: "create", node });
      const index = snapshot.nodes
        .filter((n) => n.parentId === slot.parentId)
        .findIndex((n) => n.id === slot.id);
      operations.push({ type: "reorder", id: slot.id, index });
      const parent = snapshot.nodes.find((n) => n.id === slot.parentId);
      if (parent?.maskSourceId === slot.id)
        operations.push({
          type: "update",
          id: parent.id,
          patch: { maskSourceId: slot.id, maskType: parent.maskType },
        });
    } else {
      for (const node of branch)
        operations.push({
          type: "update",
          id: node.id,
          patch: {
            templateKey: node.templateKey,
            ...(node.instance ? { instance: node.instance } : {}),
            ...(node.instanceOverrides
              ? { instanceOverrides: node.instanceOverrides }
              : {}),
          },
        });
    }
  }
  return protectedChildren;
}

function removeAdaptChildren(
  snapshot: DesignDocument,
  root: DesignNode,
  selectors: string[],
  protectedChildren: Set<string>,
  operations: Transaction["operations"],
  diagnostics: CompileDiagnostic[],
) {
  const removed = new Set<string>();
  const matches = new Set(selectors);
  for (const node of snapshot.nodes) {
    if (
      node === root ||
      removed.has(node.id) ||
      !(
        matches.has(node.name) ||
        (node.templateKey && matches.has(node.templateKey))
      )
    )
      continue;
    const branch = subtreeIds(snapshot, [node.id]);
    if (
      isLocked(snapshot, node.id) ||
      snapshot.nodes.some((n) => n.locked && branch.has(n.id))
    ) {
      diagnostics.push({
        severity: "warning",
        code: "locked-layer",
        message: "已保留锁定图层及其容器：" + node.name,
      });
    } else if (protectedChildren.has(node.id)) {
      diagnostics.push({
        severity: "warning",
        code: "instance-protected",
        message: "已保留嵌套实例内部图层：" + node.name,
      });
    } else {
      operations.push({ type: "remove", id: node.id });
      for (const id of branch) removed.add(id);
    }
  }
  return removed;
}

function placeArtboardMatrix(
  doc: DesignDocument,
  viewportCenter: Point | undefined,
  boards: { blueprint: BlueprintNode; node: DesignNode; bounds: Rect }[],
) {
  const primaryByRef = new Map(
    boards
      .filter(
        ({ blueprint: b }) =>
          (!b.role || b.role === "primary" || !b.parentRef) &&
          typeof b.refId === "string",
      )
      .map((board) => [board.blueprint.refId!.trim(), board]),
  );
  const parentOf = ({ blueprint: b }: (typeof boards)[number]) =>
    b.role &&
    b.role !== "primary" &&
    typeof b.parentRef === "string" &&
    b.parentRef
      ? primaryByRef.get(b.parentRef.trim())
      : undefined;
  const first = boards.find((board) => !parentOf(board));
  if (!first) return;
  const start = computeArtboardPlacement(doc, viewportCenter, first.bounds);
  const existing = layoutBounds(doc);
  const occupied = doc.nodes
    .filter((n) => !n.parentId)
    .map((n) => existing.get(n.id) ?? n.style);
  const columns = new Map<(typeof boards)[number], Point>();
  function place(
    board: (typeof boards)[number],
    position: Point,
    axis: "x" | "y",
  ) {
    const box = { ...board.bounds, ...position };
    const length = axis === "x" ? "width" : "height";
    for (const other of [...occupied].sort((a, b) => a[axis] - b[axis]))
      if (intersects(box, other))
        box[axis] = other[axis] + other[length] + ARTBOARD_GAP;
    // Keep the original emission order (and all symbolic links). Only the
    // root moves; child coordinates in the matrix are emitted parent-local.
    board.node.style.x += box.x - board.bounds.x;
    board.node.style.y += box.y - board.bounds.y;
    occupied.push(box);
    return box;
  }
  let x = start.x;
  for (const board of boards) {
    if (parentOf(board)) continue;
    const box = place(board, { x, y: start.y }, "x");
    columns.set(board, { x: box.x, y: box.y + box.height + ARTBOARD_GAP });
    x = box.x + box.width + ARTBOARD_GAP;
  }
  for (const board of boards) {
    const parent = parentOf(board);
    if (!parent) continue;
    const cursor = columns.get(parent)!;
    const box = place(board, cursor, "y");
    cursor.y = box.y + box.height + ARTBOARD_GAP;
  }
}

function collectExistingIds(doc: DesignDocument): Set<string> {
  const ids = new Set<string>();
  for (const n of doc.nodes) ids.add(n.id);
  for (const page of doc.pages ?? []) {
    for (const n of page.nodes ?? []) ids.add(n.id);
  }
  return ids;
}

function allocateNodeId(usedIds: Set<string>, hint?: string): string {
  const slug = (hint ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  for (let i = 0; i < 8; i++) {
    const short = crypto.randomUUID().slice(0, 8);
    const candidate = slug ? `ai-${slug}-${short}` : `ai-${short}`;
    if (!usedIds.has(candidate)) {
      usedIds.add(candidate);
      return candidate;
    }
  }
  const fallback = crypto.randomUUID();
  usedIds.add(fallback);
  return fallback;
}

function summarizeStats(
  mode: "generate" | "edit" | "answer",
  stats: CompileBlueprintStats,
  createdRoots: number,
): string {
  if (mode === "answer") return "已回答设计问题（未修改画布）";
  const parts: string[] = [];
  if (createdRoots > 0) parts.push(`新增 ${createdRoots} 个画板`);
  if (stats.created > 0) parts.push(`创建 ${stats.created} 个图层`);
  if (stats.componentsInserted > 0) {
    parts.push(`复用 ${stats.componentsInserted} 个组件`);
  }
  if (stats.updated > 0) parts.push(`更新 ${stats.updated} 处样式/文案`);
  if (stats.removed > 0) parts.push(`移除 ${stats.removed} 个图层`);
  if (stats.tokensBound > 0)
    parts.push(`绑定 ${stats.tokensBound} 项变量/样式`);
  return parts.length ? parts.join(" · ") : "已生成设计更新";
}

function isRawTransaction(input: Record<string, unknown>): boolean {
  return (
    Array.isArray(input.operations) &&
    (input.artboards === undefined ||
      (Array.isArray(input.artboards) && !input.artboards.length)) &&
    (input.edits === undefined ||
      (Array.isArray(input.edits) && !input.edits.length))
  );
}

export function compileBlueprintToTransaction(
  rawInput: unknown,
  options: CompileBlueprintOptions,
): CompileBlueprintResult {
  if (!rawInput || typeof rawInput !== "object") {
    throw new Error("模型返回结果不是有效对象");
  }
  const input = rawInput as Record<string, unknown>;
  const { document: doc, selection, viewportCenter } = options;

  const diagnostics: CompileDiagnostic[] = [];
  const stats: CompileBlueprintStats = {
    created: 0,
    updated: 0,
    removed: 0,
    componentsInserted: 0,
    tokensBound: 0,
  };

  // Support raw Forma Transaction JSON seamlessly!
  if (isRawTransaction(input)) {
    const parsedTx = transactionSchema.parse({
      baseRevision: input.baseRevision ?? doc.revision,
      operations: input.operations,
    });
    const createdRootIds: string[] = [];
    for (const op of parsedTx.operations) {
      if (op.type === "create") {
        stats.created++;
        if (op.node.parentId === null) createdRootIds.push(op.node.id);
      } else if (op.type === "update") {
        stats.updated++;
      } else if (op.type === "remove") {
        stats.removed++;
      } else if (op.type === "insertComponent") {
        stats.componentsInserted++;
      } else if (op.type === "bindVariable" || op.type === "applyStyle") {
        stats.tokensBound++;
      }
    }
    const mode =
      input.mode === "generate" || createdRootIds.length > 0
        ? "generate"
        : "edit";
    const summary =
      typeof input.summary === "string"
        ? input.summary
        : summarizeStats(mode, stats, createdRootIds.length);
    return {
      mode,
      reply:
        typeof input.reply === "string"
          ? input.reply
          : `已完成设计事务生成：${summary}。`,
      summary,
      transaction: parsedTx,
      createdRootIds,
      stats,
      diagnostics,
    };
  }

  if (Array.isArray(input.operations) && input.operations.length)
    throw new Error("请单独提交原始 operations，或使用 artboards 与 edits");
  const rawMode = input.mode;
  let mode: "generate" | "edit" | "answer" =
    rawMode === "generate" || rawMode === "edit" || rawMode === "answer"
      ? rawMode
      : Array.isArray(input.artboards) && input.artboards.length > 0
        ? "generate"
        : Array.isArray(input.edits) && input.edits.length > 0
          ? "edit"
          : "answer";

  const reply =
    typeof input.reply === "string" && input.reply.trim()
      ? input.reply.trim()
      : mode === "answer"
        ? "已完成分析。"
        : "已为您生成设计方案，可在画布中实时预览后采纳。";

  if (
    mode === "answer" &&
    !input.artboards &&
    !input.edits &&
    !input.operations
  ) {
    return {
      mode,
      reply,
      summary:
        typeof input.summary === "string" && input.summary.trim()
          ? input.summary.trim()
          : "设计咨询回复",
      createdRootIds: [],
      stats,
      diagnostics,
    };
  }

  const usedIds = collectExistingIds(doc);
  const refMap = new Map<string, string>();
  const validInteractionTargets = new Set<string>(
    doc.nodes
      .filter((n) => n.parentId === null && n.type === "frame")
      .map((n) => n.id),
  );

  const allowedSelectionSet = selection ? subtreeIds(doc, [selection]) : null;
  const selectedNode = selection
    ? doc.nodes.find((n) => n.id === selection)
    : undefined;
  const selectionIsEditableContainer = Boolean(
    selectedNode &&
    isContainer(selectedNode) &&
    !isLocked(doc, selectedNode.id) &&
    !instanceOwner(doc, selectedNode.id),
  );

  const operations: Transaction["operations"] = [];
  const imageOperations: Extract<
    Transaction["operations"][number],
    { type: "putImage" }
  >[] = [];
  const createdRootIds: string[] = [];

  const fail = (code: string, message: string, suggestion?: string) => {
    diagnostics.push({ severity: "error", code, message, suggestion });
  };
  // Component expansion may materialize a library's design system or image assets.
  // Carry these forward so a second insertion cannot overwrite the first one's dependencies.
  const componentSnapshot: DesignDocument = { ...doc, nodes: [] };
  const resolveImage = (bp: BlueprintNode): ImageFill | undefined => {
    if (bp.image === undefined && bp.imageAssetId === undefined) return;
    const spec = typeof bp.image === "object" ? bp.image : undefined;
    const reference =
      spec?.assetId ??
      bp.imageAssetId ??
      (typeof bp.image === "string" ? bp.image : spec?.url);
    let assetId =
      typeof reference === "string" && imageId.safeParse(reference).success
        ? reference
        : undefined;
    // URL shorthands can only point to previously localized assets.
    if (!assetId && typeof reference === "string" && reference.length) {
      for (const table of [componentSnapshot.images, options.images]) {
        assetId = Object.entries(table ?? {}).find(
          ([id, asset]) =>
            imageId.safeParse(id).success &&
            (asset.name === reference || asset.data === reference),
        )?.[0];
        if (assetId) break;
      }
    }
    const existing = assetId ? componentSnapshot.images?.[assetId] : undefined;
    if (assetId && !existing) {
      const parsed = imageSchema.safeParse(options.images?.[assetId]);
      if (parsed.success) {
        if (selection) {
          fail(
            "selection-scope",
            "选区提案不能新增文档级图片资源。",
            "请使用文档中已有的图片，或取消选区后生成。",
          );
          return;
        }
        imageOperations.push({
          type: "putImage",
          id: assetId,
          image: parsed.data,
        });
        componentSnapshot.images = {
          ...componentSnapshot.images,
          [assetId]: parsed.data,
        };
        return blueprintImageFill(bp, assetId);
      }
    }
    if (assetId && existing) return blueprintImageFill(bp, assetId);
    diagnostics.push({
      severity: "warning",
      code: "unknown-image",
      message:
        "找不到已本地化的图片资源：" + String(reference ?? "").slice(0, 160),
      suggestion: "传入 images 中的资源 ID，或使用文档中已有的图片。",
    });
  };
  const componentOverrides = (
    overrides: NonNullable<BlueprintProperties["overrides"]>,
    nodes: DesignNode[],
    rootId: string,
    componentId: string,
  ) => {
    const updates: Transaction["operations"] = [];
    const labels = nodes.filter(
      (n) => n.type === "text" || n.type === "button",
    );
    const changes = new Map<string, string>();
    if (overrides.text !== undefined) {
      if (labels[0]) changes.set(labels[0].id, overrides.text);
      else fail("missing-text-layer", "组件没有可覆写的文本层：" + componentId);
    }
    for (const [key, text] of Object.entries(
      overrides.textByTemplateKey ?? {},
    )) {
      const node = labels.find((n) => n.templateKey === key);
      if (node) changes.set(node.id, text);
      else
        fail(
          "unknown-template-key",
          "找不到文本模板键：" + key,
          "可用键：" +
            labels
              .map((n) => n.templateKey)
              .slice(0, 10)
              .join(", "),
        );
    }
    for (const [id, text] of changes) {
      updates.push({ type: "update", id, patch: { text } });
      stats.updated++;
    }
    for (const key of ["fill", "color", "opacity"] as const) {
      if (overrides[key] === undefined) continue;
      const value =
        key === "opacity"
          ? overrides.opacity
          : normalizeHexColor(overrides[key])?.hex;
      if (value === undefined) {
        fail("invalid-override", "外观覆写值无效：" + key);
        continue;
      }
      updates.push({
        type: "update",
        id: key === "color" ? (labels[0]?.id ?? rootId) : rootId,
        patch: {},
        style: { [key]: value },
      });
      stats.updated++;
    }
    for (const [property, ref] of Object.entries(overrides.slots ?? {})) {
      const value = resolveLibraryComponent(
        doc,
        ref.libraryId,
        ref.componentId,
        ref.variantId,
        undefined,
        diagnostics,
      );
      if (value) {
        updates.push({
          type: "setInstanceSlot",
          id: rootId,
          property,
          value,
        });
        stats.updated++;
      }
    }
    return updates;
  };

  const insertComponent = (
    bp: BlueprintNode | BlueprintEdit,
    parentId: string | null,
    position: Point,
    localPosition: Point,
    pinIds = false,
  ) => {
    const resolved = resolveLibraryComponent(
      componentSnapshot,
      bp.libraryId,
      bp.componentId,
      bp.variantId,
      bp.variantProperties,
      diagnostics,
    );
    if (!resolved) return;
    const adapt = outerAdapt(bp);
    const expanded = instantiateComponent(
      componentSnapshot,
      componentSnapshot.libraries![resolved.libraryId],
      resolved.componentId,
      resolved.variantId,
      null,
      localPosition,
    );
    const resources = expanded.operations.filter(
      (op) =>
        op.type === "putImage" ||
        op.type === "putLibrary" ||
        op.type === "setDesignSystem",
    );
    if (selection && resources.length) {
      fail("selection-scope", "选区内插入组件需要修改文档级资源。");
      return;
    }
    const interaction =
      "interaction" in bp
        ? normalizeInteraction(
            bp.interaction,
            refMap,
            validInteractionTargets,
            parentId === null,
          )
        : undefined;
    if (
      !adapt &&
      !bp.overrides &&
      !interaction &&
      !pinIds &&
      parentId !== null &&
      !resources.length
    ) {
      operations.push({
        type: "insertComponent",
        ...resolved,
        parentId,
        position,
      });
      stats.componentsInserted++;
      return;
    }
    const nodes = expanded.operations.flatMap((op) =>
      op.type === "create" ? [op.node] : [],
    );
    const allocated = assignedIds.get(bp);
    const rootId = allocated ?? expanded.id;
    if (allocated) {
      // Forward prototype references already point to this top-level component.
      const ids = new Map([[expanded.id, allocated]]);
      for (const node of nodes) {
        if (node.id === expanded.id) node.id = allocated;
        if (node.parentId === expanded.id) node.parentId = allocated;
        remapInteraction(node, ids);
      }
      for (const op of expanded.operations)
        if (op.type === "update" && op.id === expanded.id) op.id = allocated;
    }
    const updates = bp.overrides
      ? componentOverrides(bp.overrides, nodes, rootId, resolved.componentId)
      : [];
    let snapshot: DesignDocument | undefined;
    if (adapt) {
      // Slot swaps can allocate IDs on each replay. Freeze the overridden,
      // still-protected instance once, before emitting any edits addressing it.
      try {
        snapshot = transact(componentSnapshot, {
          baseRevision: componentSnapshot.revision,
          operations: [...expanded.operations, ...updates],
        });
      } catch (error) {
        fail(
          "invalid-adapt",
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      const root = snapshot.nodes.find((n) => n.id === rootId)!;
      if (!isContainer(root) || root.locked) {
        fail("invalid-adapt", "模块外框必须是未锁定的容器：" + root.name);
        return;
      }
      if (root.booleanOperation || root.maskSourceId || root.componentSet) {
        fail(
          "invalid-adapt",
          "转换为 Frame 会改变布尔组、蒙版组或组件集的结构：" + root.name,
        );
        return;
      }
      // A replacement slot may bring its own image into the instance.
      for (const [id, image] of Object.entries(snapshot.images ?? {}))
        if (
          !componentSnapshot.images?.[id] &&
          !resources.some((op) => op.type === "putImage" && op.id === id)
        )
          resources.push({ type: "putImage", id, image });
      if (selection && resources.length) {
        fail("selection-scope", "选区内替换插槽需要新增文档级资源。");
        return;
      }
    }
    stats.componentsInserted++;
    operations.push(...resources);
    for (const op of resources) {
      if (op.type === "setDesignSystem")
        componentSnapshot.designSystem = op.system;
      if (op.type === "putImage")
        componentSnapshot.images = {
          ...componentSnapshot.images,
          [op.id]: op.image,
        };
      if (op.type === "putLibrary")
        componentSnapshot.libraries = {
          ...componentSnapshot.libraries,
          [op.library.id]: op.library,
        };
    }
    if (!parentId) createdRootIds.push(rootId);
    if (adapt && snapshot) {
      const root = snapshot.nodes.find((n) => n.id === rootId)!;
      // instantiateComponent sets locks after construction. Finish constructing
      // this new copy before locking it, and consult the source locks on removal.
      for (const node of snapshot.nodes)
        operations.push({
          type: "create",
          node: {
            ...node,
            parentId: node === root ? parentId : node.parentId,
            locked: false,
          },
        });
      operations.push({ type: "detachInstance", id: root.id });
      // Group bounds follow their children. Convert a detached Group to a
      // Frame so its new grid/padding actually takes effect. Keep every ID.
      if (root.type !== "frame") {
        const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
        operations.push({ type: "remove", id: root.id });
        for (const op of planDetachInstance(snapshot, root.id)) {
          if (op.type !== "update") throw new Error("无法分离模块外框");
          const node = byId.get(op.id)!;
          operations.push({
            type: "create",
            node: {
              ...node,
              ...op.patch,
              locked: false,
              ...(node === root ? { type: "frame", parentId } : {}),
            },
          });
        }
      }
      const style = {
        ...normalizeStylePatch(bp.style, snapshot, root.style.fontSize),
        ...normalizeStylePatch(adapt.style, snapshot, root.style.fontSize),
      };
      // Position comes from the insertion point or the artboard placement pass.
      delete style.x;
      delete style.y;
      const name =
        typeof adapt.name === "string" ? adapt.name.trim().slice(0, 200) : "";
      if (name || interaction || Object.keys(style).length) {
        operations.push({
          type: "update",
          id: root.id,
          patch: { ...(name && { name }), ...(interaction && { interaction }) },
          style,
        });
        stats.updated++;
      }
      const protectedChildren = restoreNestedInstances(
        snapshot,
        root,
        operations,
        diagnostics,
      );
      if (Array.isArray(adapt.removeChildren))
        stats.removed += removeAdaptChildren(
          snapshot,
          root,
          adapt.removeChildren,
          protectedChildren,
          operations,
          diagnostics,
        ).size;
      for (const child of appendedChildren(bp, adapt))
        emitSubtree(
          child,
          root.id,
          style.layout ?? root.style.layout,
          position.x,
          position.y,
          undefined,
          true,
        );
      for (const node of [...snapshot.nodes].reverse())
        if (node.locked)
          operations.push({
            type: "update",
            id: node.id,
            patch: { locked: true },
          });
    } else {
      for (const op of expanded.operations) {
        if (op.type === "create" && op.node.id === rootId)
          op.node.parentId = parentId;
        if (op.type === "create" || op.type === "update") operations.push(op);
      }
      operations.push(...updates);
      if (interaction)
        operations.push({ type: "update", id: rootId, patch: { interaction } });
    }
  };

  // Pass 1: Pre-allocate node IDs & register symbolic refIds for cross-screen links
  const assignedIds = new WeakMap<BlueprintNode, string>();
  const preAllocateTree = (node: BlueprintNode, isTopLevel: boolean) => {
    if (!node || typeof node !== "object") return;
    const adapt = outerAdapt(node);
    if (node.type === "component") {
      if (adapt)
        for (const child of appendedChildren(node, adapt))
          preAllocateTree(child, false);
      if (!isTopLevel) return;
    }
    const allocated = allocateNodeId(
      usedIds,
      node.refId ?? node.id ?? node.name,
    );
    assignedIds.set(node, allocated);
    if (typeof node.refId === "string" && node.refId.trim()) {
      refMap.set(node.refId.trim(), allocated);
    }
    if (
      typeof node.id === "string" &&
      node.id.trim() &&
      !usedIds.has(node.id.trim())
    ) {
      refMap.set(node.id.trim(), allocated);
    }
    if (isTopLevel) {
      if (node.type === "component") {
        const ref = resolveLibraryComponent(
          doc,
          node.libraryId,
          node.componentId,
          node.variantId,
          node.variantProperties,
          [],
        );
        const root =
          ref && variantFor(doc, ref)?.nodes.find((n) => !n.parentId);
        if (root && (root.type === "frame" || (adapt && isContainer(root))))
          validInteractionTargets.add(allocated);
      } else if (normalizeNodeType(node) === "frame")
        validInteractionTargets.add(allocated);
    }
    if (node.type !== "component" && Array.isArray(node.children)) {
      for (const child of node.children) {
        preAllocateTree(child, false);
      }
    }
  };

  const artboards = Array.isArray(input.artboards)
    ? (input.artboards as BlueprintNode[])
    : [];
  const edits = Array.isArray(input.edits)
    ? (input.edits as BlueprintEdit[])
    : [];

  for (const board of artboards) {
    preAllocateTree(board, !selection);
  }
  for (const edit of edits) {
    if (edit.node) preAllocateTree(edit.node, false);
    if (Array.isArray(edit.adapt?.appendChildren))
      for (const child of edit.adapt.appendChildren)
        preAllocateTree(child, false);
    if (Array.isArray(edit.children)) {
      for (const ch of edit.children) preAllocateTree(ch, false);
    }
  }

  // Pass 2: Compile Blueprint trees into Forma create / insertComponent ops
  const emitSubtree = (
    bp: BlueprintNode,
    parentId: string | null,
    parentLayout: NodeStyle["layout"] | null,
    parentWorldX: number,
    parentWorldY: number,
    overridePos?: Point,
    pinIds = false,
  ) => {
    if (!bp || typeof bp !== "object") return;

    if (bp.type === "component") {
      const local = {
        x:
          overridePos?.x ??
          toFiniteNumber(outerAdapt(bp)?.style?.x) ??
          toFiniteNumber(bp.style?.x) ??
          0,
        y:
          overridePos?.y ??
          toFiniteNumber(outerAdapt(bp)?.style?.y) ??
          toFiniteNumber(bp.style?.y) ??
          0,
      };
      insertComponent(
        bp,
        parentId,
        { x: parentWorldX + local.x, y: parentWorldY + local.y },
        local,
        pinIds,
      );
      return;
    }

    const isRootArtboard = parentId === null;
    let nodeType = normalizeNodeType(bp);
    const artwork =
      nodeType === "vector" ? blueprintVector(bp, diagnostics) : undefined;
    const vector = artwork?.vector;
    if (nodeType === "vector" && !vector) {
      nodeType = "rectangle";
    }

    const nodeId = assignedIds.get(bp) ?? allocateNodeId(usedIds, bp.name);
    const defaults = defaultStyleForType(nodeType, isRootArtboard);
    if (artwork?.defaults) Object.assign(defaults, artwork.defaults);
    const patch = normalizeStylePatch(bp.style, doc, defaults.fontSize);
    if (artwork?.iconColor) {
      patch.color = artwork.iconColor;
      // A Lucide stroke belongs to each path. A node stroke would draw a box around the icon.
      delete patch.strokeWidth;
    }
    if (parentLayout !== null)
      applyChildDefaults(nodeType, bp, defaults, patch, parentLayout);
    const style: NodeStyle = styleSchema.parse({
      ...defaults,
      ...patch,
      ...(overridePos ? { x: overridePos.x, y: overridePos.y } : {}),
    });
    const image = resolveImage(bp);
    if (image) {
      if (nodeType === "frame") style.clipContent = true;
      promoteImageGradient(
        style,
        clamp(toFiniteNumber(bp.style?.fillOpacity) ?? 1, 0, 1),
        diagnostics,
      );
    }

    const bindings = validateBindingsForNode(
      doc,
      nodeType,
      bp,
      style.layout,
      stats,
      diagnostics,
    );

    const interaction = normalizeInteraction(
      bp.interaction,
      refMap,
      validInteractionTargets,
      isRootArtboard && nodeType === "frame",
    );
    const control = normalizeControl(bp.control);

    const nodeName =
      typeof bp.name === "string" && bp.name.trim()
        ? bp.name.trim().slice(0, 200)
        : nodeType === "frame"
          ? "画板"
          : nodeType === "text"
            ? typeof bp.text === "string" && bp.text.trim()
              ? bp.text.trim().slice(0, 24)
              : "文本"
            : nodeType === "button"
              ? typeof bp.text === "string" && bp.text.trim()
                ? bp.text.trim().slice(0, 24)
                : "按钮"
              : "图层";

    const nodeText =
      typeof bp.text === "string"
        ? bp.text.slice(0, 50000)
        : nodeType === "button"
          ? nodeName
          : nodeType === "text"
            ? nodeName
            : "";

    const node: DesignNode = nodeSchema.parse({
      id: nodeId,
      parentId,
      type: nodeType,
      name: nodeName,
      text: nodeText,
      style,
      hidden: Boolean(bp.hidden),
      locked: Boolean(bp.locked),
      ...bindings,
      variableModes: bp.variableModes,
      ...(interaction ? { interaction } : {}),
      ...(control ? { control } : {}),
      ...(vector ? { vector } : {}),
      ...(image ? { image } : {}),
    });

    const lockAfterChildren =
      node.locked && isContainer(node) && Boolean(bp.children?.length);
    operations.push({
      type: "create",
      node: lockAfterChildren ? { ...node, locked: false } : node,
    });
    stats.created++;
    if (isRootArtboard) {
      createdRootIds.push(nodeId);
    }

    const canHaveChildren = isContainer(node);
    if (canHaveChildren && Array.isArray(bp.children)) {
      const worldX = parentWorldX + style.x;
      const worldY = parentWorldY + style.y;
      for (const child of bp.children) {
        emitSubtree(
          child,
          nodeId,
          style.layout,
          worldX,
          worldY,
          undefined,
          pinIds,
        );
      }
      if (lockAfterChildren)
        operations.push({
          type: "update",
          id: nodeId,
          patch: { locked: true },
        });
    }
  };

  // Emit artboards
  if (artboards.length > 0) {
    if (selection) {
      // Strictly enforce selection scope: place inside selected editable container!
      if (selectionIsEditableContainer && selectedNode) {
        const origin =
          layoutBounds(doc).get(selectedNode.id) ?? selectedNode.style;
        for (const board of artboards) {
          emitSubtree(
            board,
            selectedNode.id,
            selectedNode.style.layout,
            origin.x,
            origin.y,
          );
        }
      } else fail("selection-scope", "选区不能容纳新增图层：" + selection);
    } else if (
      artboards.length > 1 ||
      artboards.some((board) => board.role && board.role !== "primary")
    ) {
      for (const board of artboards)
        emitSubtree(board, null, null, 0, 0, { x: 0, y: 0 }, true);
      if (operations.length) {
        // Measure the emitted graph, including Hug sizing, components and bound
        // dimensions. Declared width/height alone can underestimate a column.
        const measured = layoutBounds(
          transact(doc, {
            baseRevision: doc.revision,
            operations: [...imageOperations, ...operations],
          }),
        );
        const rootCreates = new Map(
          operations.flatMap((op) =>
            op.type === "create" && op.node.parentId === null
              ? [[op.node.id, op.node] as const]
              : [],
          ),
        );
        placeArtboardMatrix(
          doc,
          viewportCenter,
          artboards.flatMap((blueprint) => {
            const node = rootCreates.get(assignedIds.get(blueprint)!);
            const bounds = node && measured.get(node.id);
            return node && bounds ? [{ blueprint, node, bounds }] : [];
          }),
        );
      }
    } else {
      const firstStyle = normalizeStylePatch(artboards[0]?.style, doc);
      const firstWidth = firstStyle.width ?? 390;
      const firstHeight = firstStyle.height ?? 844;
      const placement = computeArtboardPlacement(doc, viewportCenter, {
        width: firstWidth,
        height: firstHeight,
      });
      let cursorX = placement.x;
      const baseY = placement.y;

      for (const board of artboards) {
        const st = normalizeStylePatch(board.style, doc);
        const w = st.width ?? 390;
        emitSubtree(board, null, null, 0, 0, { x: cursorX, y: baseY });
        cursorX += w + ARTBOARD_GAP;
      }
    }
  }

  // Compute world coordinates lookup for existing nodes (for insertComponent edits)
  const existingById = new Map(doc.nodes.map((n) => [n.id, n]));
  let bounds: ReturnType<typeof layoutBounds> | undefined;
  const worldCoordsOf = (id: string | null) =>
    id
      ? ((bounds ??= layoutBounds(doc)).get(id) ?? { x: 0, y: 0 })
      : { x: 0, y: 0 };
  const detachedInstances = new Set<string>();
  const modesByNode = new Map<string, Record<string, string>>();
  // Emit targeted edits
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") continue;
    const opKind = (edit.op ?? edit.type ?? "").trim();

    if (!["create", "insertComponent", "putToken"].includes(opKind)) {
      const id = edit.id;
      if (!id || !existingById.has(id)) {
        fail(
          "unknown-node",
          opKind + "：目标节点不存在：" + (id ?? "（未提供）"),
          "用 search_nodes 查找。候选：" +
            candidates(
              doc.nodes.filter(
                (n) => !allowedSelectionSet || allowedSelectionSet.has(n.id),
              ),
            ),
        );
        continue;
      }
      if (allowedSelectionSet && !allowedSelectionSet.has(id)) {
        fail(
          "selection-scope",
          opKind + "：节点 " + id + " 超出当前选区 " + selection,
          "请在当前选区内选择目标",
        );
        continue;
      }
    }

    if (opKind === "update" && typeof edit.id === "string") {
      const target = existingById.get(edit.id);
      if (!target) continue;

      const rawPatch = (edit.patch ?? {}) as Record<string, unknown>;
      const cleanPatch: Record<string, unknown> = {};
      if (typeof rawPatch.name === "string" && rawPatch.name.trim()) {
        cleanPatch.name = rawPatch.name.trim().slice(0, 200);
      }
      if (typeof rawPatch.text === "string") {
        cleanPatch.text = rawPatch.text.slice(0, 50000);
      }
      if (typeof rawPatch.hidden === "boolean")
        cleanPatch.hidden = rawPatch.hidden;
      if (typeof rawPatch.locked === "boolean")
        cleanPatch.locked = rawPatch.locked;
      if (
        typeof rawPatch.fillToken === "string" &&
        doc.tokens[rawPatch.fillToken]
      ) {
        cleanPatch.fillToken = rawPatch.fillToken;
        stats.tokensBound++;
      }
      if (rawPatch.interaction && typeof rawPatch.interaction === "object") {
        const inter = normalizeInteraction(
          rawPatch.interaction as BlueprintInteraction,
          refMap,
          validInteractionTargets,
          target.parentId === null && target.type === "frame",
        );
        if (inter) cleanPatch.interaction = inter;
      }
      if (rawPatch.control && typeof rawPatch.control === "object") {
        const ctrl = normalizeControl(
          rawPatch.control as Record<string, unknown>,
        );
        if (ctrl) cleanPatch.control = ctrl;
      }

      const stylePatch = normalizeStylePatch(
        edit.style,
        doc,
        target.style.fontSize,
      );

      // Protect component instances automatically: strip geometry changes on internal layers
      const owner = instanceOwner(doc, target.id);
      const isInsideInstance =
        owner && owner.id !== target.id && !detachedInstances.has(owner.id);
      if (isInsideInstance) {
        for (const key of Object.keys(stylePatch) as (keyof NodeStyle)[]) {
          if (instanceGeometryKeys.has(key)) {
            fail(
              "instance-protected",
              "实例内部几何受保护：" + target.id + "." + key,
              "只修改文字或外观，结构修改须显式分离实例",
            );
            delete stylePatch[key];
          }
        }
      }

      if (
        Object.keys(cleanPatch).length > 0 ||
        Object.keys(stylePatch).length > 0
      ) {
        operations.push({
          type: "update",
          id: target.id,
          patch: cleanPatch,
          ...(Object.keys(stylePatch).length > 0 ? { style: stylePatch } : {}),
        });
        if (stylePatch.layout !== undefined)
          existingById.set(target.id, {
            ...target,
            style: { ...target.style, layout: stylePatch.layout },
          });
        stats.updated++;
      } else
        fail(
          "empty-update",
          "update 没有可更新的合法属性：" + target.id,
          "使用 patch.text、patch.name 或 style",
        );
      continue;
    }

    if (opKind === "create" || opKind === "insertComponent") {
      const parentId =
        edit.parentId !== undefined
          ? edit.parentId
          : selection && selectionIsEditableContainer
            ? selection
            : null;
      if (allowedSelectionSet) {
        if (!parentId || !allowedSelectionSet.has(parentId)) {
          fail("selection-scope", opKind + "：父节点超出当前选区 " + selection);
          continue;
        }
      }
      const parentNode = parentId ? existingById.get(parentId) : undefined;
      if (parentId && (!parentNode || !isContainer(parentNode))) {
        fail(
          "invalid-parent",
          "目标容器不存在或无法容纳子层：" + parentId,
          "用 search_nodes 查找画板",
        );
        continue;
      }
      const world = worldCoordsOf(parentId);
      if (opKind === "insertComponent") {
        const adapt = outerAdapt(edit);
        const local = {
          x:
            toFiniteNumber(edit.position?.x) ??
            toFiniteNumber(adapt?.style?.x) ??
            toFiniteNumber(adapt && edit.style?.x) ??
            0,
          y:
            toFiniteNumber(edit.position?.y) ??
            toFiniteNumber(adapt?.style?.y) ??
            toFiniteNumber(adapt && edit.style?.y) ??
            0,
        };
        insertComponent(
          edit,
          parentId,
          { x: world.x + local.x, y: world.y + local.y },
          local,
        );
        continue;
      }
      if (edit.node) {
        emitSubtree(
          edit.node,
          parentId,
          parentNode?.style.layout ?? null,
          world.x,
          world.y,
        );
      }
      if (Array.isArray(edit.children)) {
        for (const child of edit.children) {
          emitSubtree(
            child,
            parentId,
            parentNode?.style.layout ?? null,
            world.x,
            world.y,
          );
        }
      }
      continue;
    }

    if (opKind === "remove" && typeof edit.id === "string") {
      operations.push({ type: "remove", id: edit.id });
      stats.removed++;
      continue;
    }

    if (opKind === "bindVariable" && edit.id) {
      const prop = edit.property ?? "";
      const issue =
        edit.variableId !== undefined
          ? variableDiagnostic(doc, prop, edit.variableId)
          : null;
      if (issue) {
        diagnostics.push(issue);
        continue;
      }
      if (!VALID_VARIABLE_PROPS.has(prop)) {
        fail(
          "invalid-property",
          "变量绑定属性无效：" + prop,
          variableProperties.join(", "),
        );
        continue;
      }
      operations.push({
        type: "bindVariable",
        id: edit.id,
        property: prop as VariableProperty,
        variableId: edit.variableId,
      });
      stats.tokensBound++;
      continue;
    }
    if (opKind === "applyStyle" && edit.id) {
      const target = existingById.get(edit.id)!;
      const id = edit.styleId ?? "";
      const issue = styleDiagnostic(
        doc,
        target.type,
        id,
        edit.slot,
        target.style.layout,
      );
      if (issue) {
        diagnostics.push(issue);
        continue;
      }
      operations.push({
        type: "applyStyle",
        id: edit.id,
        styleId: id,
        slot: edit.slot,
      });
      stats.tokensBound++;
      continue;
    }
    if (opKind === "setVariableMode" && edit.id) {
      const modes =
        edit.variableModes ??
        (edit.collectionId && edit.modeId
          ? { [edit.collectionId]: edit.modeId }
          : {});
      if (
        !Object.keys(modes).length ||
        Object.entries(modes).some(
          ([id, mode]) =>
            !doc.designSystem?.collections[id]?.modes.some(
              (m) => m.id === mode,
            ),
        )
      ) {
        fail(
          "invalid-mode",
          "集合或局部模式不存在：" + JSON.stringify(modes),
          "用 get_design_system 查询集合及模式 ID",
        );
        continue;
      }
      const variableModes = {
        ...(modesByNode.get(edit.id) ??
          existingById.get(edit.id)?.variableModes),
        ...modes,
      };
      modesByNode.set(edit.id, variableModes);
      operations.push({
        type: "update",
        id: edit.id,
        patch: { variableModes },
      });
      stats.updated++;
      continue;
    }
    if (
      [
        "switchInstance",
        "swapInstance",
        "detachInstance",
        "setInstanceSlot",
      ].includes(opKind) &&
      edit.id
    ) {
      const instance = existingById.get(edit.id)?.instance;
      if (!instance) {
        fail(
          "not-instance",
          "目标不是组件实例：" + edit.id,
          "用 search_nodes 的 onlyInstances 查找实例",
        );
        continue;
      }
      if (opKind === "detachInstance") {
        operations.push({ type: "detachInstance", id: edit.id });
        detachedInstances.add(edit.id);
      }
      if (opKind === "setInstanceSlot") {
        const ref = edit.value;
        const value =
          ref && typeof ref === "object"
            ? resolveLibraryComponent(
                doc,
                ref.libraryId,
                ref.componentId,
                ref.variantId,
                undefined,
                diagnostics,
              )
            : undefined;
        if (ref != null && !value) {
          fail(
            "invalid-slot",
            "插槽需要有效组件引用",
            "用 search_components 查询组件",
          );
          continue;
        }
        if (!edit.property) {
          fail(
            "missing-slot",
            "缺少公开插槽属性 ID",
            "用 get_node_details 查询 exposed",
          );
          continue;
        }
        operations.push({
          type: "setInstanceSlot",
          id: edit.id,
          property: edit.property,
          value: value ?? undefined,
        });
      }
      if (opKind === "switchInstance") {
        const variants =
          doc.libraries?.[instance.libraryId]?.components.find(
            (c) => c.id === instance.componentId,
          )?.variants ?? [];
        if (!variants.some((v) => v.id === edit.variantId)) {
          fail(
            "unknown-variant",
            "变体不存在：" + edit.variantId,
            "可用变体：" + candidates(variants),
          );
          continue;
        }
        operations.push({
          type: "switchInstance",
          id: edit.id,
          variantId: edit.variantId!,
          reset: edit.reset,
        });
      }
      if (opKind === "swapInstance") {
        const resolved = resolveLibraryComponent(
          doc,
          edit.libraryId,
          edit.componentId,
          edit.variantId,
          edit.variantProperties,
          diagnostics,
        );
        if (!resolved) continue;
        operations.push({ type: "swapInstance", id: edit.id, ...resolved });
      }
      stats.updated++;
      continue;
    }

    if (opKind === "move" && typeof edit.id === "string") {
      const newParent = edit.parentId ?? null;
      if (
        allowedSelectionSet &&
        (!newParent || !allowedSelectionSet.has(newParent))
      ) {
        fail("selection-scope", "不能将图层移出当前选区");
        continue;
      }
      operations.push({
        type: "move",
        id: edit.id,
        parentId: newParent,
        ...(typeof edit.index === "number" && edit.index >= 0
          ? { index: Math.round(edit.index) }
          : {}),
      });
      stats.updated++;
      continue;
    }

    if (
      opKind === "reorder" &&
      typeof edit.id === "string" &&
      typeof edit.index === "number"
    ) {
      operations.push({
        type: "reorder",
        id: edit.id,
        index: Math.max(0, Math.round(edit.index)),
      });
      stats.updated++;
      continue;
    }

    if (opKind === "putToken" && selection) {
      fail("selection-scope", "选区任务不能修改全局 Token");
      continue;
    }
    if (
      opKind === "putToken" &&
      !selection &&
      typeof edit.id === "string" &&
      edit.id.trim() &&
      edit.token &&
      typeof edit.token.name === "string"
    ) {
      const hex = normalizeHexColor(edit.token.value)?.hex;
      if (hex) {
        operations.push({
          type: "putToken",
          id: edit.id.trim().slice(0, 128),
          token: { name: edit.token.name.trim() || edit.id.trim(), value: hex },
        });
        stats.tokensBound++;
        continue;
      }
    }
    fail(
      "invalid-edit",
      "编辑操作无效或缺少参数：" + opKind,
      "检查 op、目标 ID 和该操作的必填属性",
    );
  }

  if (operations.length === 0) {
    if (mode !== "answer" && !diagnostics.length) {
      throw new Error(
        "未编译出有效的设计变更操作，请提供具体的 artboards 或 edits 内容",
      );
    }
    return {
      mode,
      reply,
      summary:
        typeof input.summary === "string" && input.summary.trim()
          ? input.summary.trim()
          : "设计咨询回复",
      createdRootIds: [],
      stats,
      diagnostics,
    };
  }

  const transaction = transactionSchema.parse({
    baseRevision: doc.revision,
    operations: [...imageOperations, ...operations],
  });

  if (mode === "answer") {
    mode = createdRootIds.length > 0 ? "generate" : "edit";
  }

  const summary =
    typeof input.summary === "string" && input.summary.trim()
      ? input.summary.trim()
      : summarizeStats(mode, stats, createdRootIds.length);

  return {
    mode,
    reply,
    summary,
    transaction,
    createdRootIds,
    stats,
    diagnostics,
  };
}
