import { maxGradientStops, maxLayerDimension } from "./document-limits";
import { layoutBreakpoints } from "./layout-breakpoints";
import { fontSettingsSchema } from "./font-settings";
import { trackList } from "./grid-tracks";
import { variableProperties } from "./design-properties";
import { interactionSchema } from "./prototype";
import { imageFillSchema } from "./images";
import { textRunsSchema, validateRuns } from "./rich-text";
import { z } from "zod";

const id = z.string().min(1).max(128);
export const componentRef = z.object({
  libraryId: id,
  componentId: id,
  variantId: id,
});
// Prefix keys while z.record validates them. It would otherwise skip "__proto__".
// The public JSON Schema describes the original, unprefixed property names.
const slotKey = z
  .string()
  .min(2)
  .max(129)
  .meta({ minLength: 1, maxLength: 128 });
const slotDictionary = z.preprocess(
  (value) => {
    if (value === null || typeof value !== "object") return null;
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) return null;
    return Object.fromEntries(
      Object.entries(value).map(([key, ref]) => [":" + key, ref]),
    );
  },
  z
    .record(slotKey, componentRef)
    .refine((values) => Object.keys(values).length <= 100)
    .meta({ maxProperties: 100 })
    .overwrite((encoded) => {
      const values: Record<
        string,
        z.infer<typeof componentRef>
      > = Object.create(null);
      for (const [key, value] of Object.entries(encoded))
        Object.defineProperty(values, key.slice(1), {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      return values;
    }),
);
// Exposed slots may be assigned on an instance while its selected variant
// has no corresponding layer. Preserve the value until a matching variant is used.
const instanceSourceRef = componentRef.extend({
  // Keep the public DTO shape for ordinary property names. Names shared
  // with Object.prototype retain the safe dictionary used during parsing.
  slotProperties: slotDictionary
    .overwrite((values) =>
      Object.keys(values).some((key) => Object.hasOwn(Object.prototype, key))
        ? values
        : { ...values },
    )
    .optional(),
});
const gradient = z.object({
  paintTransform: z
    .object({
      a: z.number().finite(),
      b: z.number().finite(),
      c: z.number().finite(),
      d: z.number().finite(),
      e: z.number().finite(),
      f: z.number().finite(),
    })
    .refine((m) => {
      const determinant = m.a * m.d - m.b * m.c;
      return Number.isFinite(determinant) && Math.abs(determinant) > 1e-12;
    }, "渐变坐标矩阵须可逆")
    .optional(),
  linearProjection: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      offset: z.number().finite(),
    })
    .optional(),
  type: z.enum(["linear", "radial", "angular", "diamond"]),
  angle: z.number().min(0).max(360),
  stops: z
    .array(
      z.object({
        variableId: id.optional(),
        offset: z.number().min(0).max(1),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        opacity: z.number().min(0).max(1),
      }),
    )
    .min(2)
    .max(maxGradientStops),
});
export const layoutGuideSchema = z.object({
  id,
  kind: z.enum(["grid", "columns", "rows"]),
  visible: z.boolean().default(true),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#F24822"),
  opacity: z.number().min(0).max(1).default(0.12),
  size: z.number().min(1).max(2000).default(8),
  count: z.number().int().min(1).max(64).default(12),
  gutter: z.number().min(0).max(500).default(16),
  offset: z.number().min(0).max(2000).default(16),
  alignment: z.enum(["stretch", "min", "center", "max"]).default("stretch"),
});
export type LayoutGuide = z.infer<typeof layoutGuideSchema>;
export const exportSettingSchema = z.object({
  id,
  format: z.enum(["png", "jpeg", "webp", "svg"]),
  scale: z.number().min(0.25).max(4),
  suffix: z.string().max(64).default(""),
});
export type ExportSetting = z.infer<typeof exportSettingSchema>;
export const annotationSchema = z.object({
  id,
  category: z.enum(["spec", "dev", "interaction", "a11y"]).default("spec"),
  text: z.string().min(1).max(2000),
  properties: z.array(z.string().max(64)).max(16).optional(),
});
export type Annotation = z.infer<typeof annotationSchema>;
export const blendModes = [
  "pass-through",
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "plus-darker",
  "plus-lighter",
] as const;
export const shadowSchema = z.object({
  blendMode: z.enum(blendModes).optional(),
  x: z.number().min(-1000).max(1000),
  y: z.number().min(-1000).max(1000),
  blur: z.number().min(0).max(1000),
  spread: z.number().min(-1000).max(1000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  gradient: z
    .object({
      type: z.enum(["linear", "radial", "angular", "diamond"]),
      angle: z.number().min(0).max(360),
      stops: z
        .array(
          z.object({
            offset: z.number().min(0).max(1),
            color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
            opacity: z.number().min(0).max(1),
          }),
        )
        .min(2)
        .max(maxGradientStops),
    })
    .optional(),
  opacity: z.number().min(0).max(1),
  visible: z.boolean().optional(),
  inset: z.boolean(),
});
const sideWidth = z.number().min(0).max(64).optional();
const paintLayers = z
  .array(
    z.object({
      id: z.string().min(1),
      colorVariableId: id.optional(),
      opacityVariableId: id.optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      opacity: z.number().min(0).max(1),
      visible: z.boolean(),
      blendMode: z.enum(blendModes).optional(),
      gradient: gradient.optional(),
    }),
  )
  .max(16)
  .optional();
export const styleSchema = z.object({
  width: z.number().min(0).max(maxLayerDimension),
  height: z.number().min(0).max(maxLayerDimension),
  minWidth: z.number().min(1).max(10000).optional(),
  maxWidth: z.number().min(1).max(10000).optional(),
  minHeight: z.number().min(1).max(10000).optional(),
  maxHeight: z.number().min(1).max(10000).optional(),
  widthMode: z.enum(["fixed", "hug", "fill"]).optional(),
  heightMode: z.enum(["fixed", "hug", "fill"]).optional(),
  x: z.number().finite(),
  rotation: z.number().finite().min(-360).max(360).optional(),
  flipX: z.boolean().optional(),
  flipY: z.boolean().optional(),
  y: z.number().finite(),
  fill: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  radius: z.number().min(0).max(10000),
  fontSize: z.number().min(1).max(500),
  padding: z.number().min(0).max(1000),
  insets: z
    .object({
      top: z.number().min(0).max(1000),
      right: z.number().min(0).max(1000),
      bottom: z.number().min(0).max(1000),
      left: z.number().min(0).max(1000),
    })
    .optional(),
  gap: z.number().min(-1000).max(1000),
  firstChildOnTop: z.boolean().optional(),
  justifyContent: z.enum(["pack", "space-between"]).optional(),
  absolutePosition: z.boolean().optional(),
  layoutReverse: z.boolean().optional(),
  wrap: z.boolean().optional(),
  rowGap: z.number().min(0).max(1000).optional(),
  layout: z.enum(["free", "row", "column", "grid"]),
  layoutBreakpoints: layoutBreakpoints.optional(),
  gridRowTracks: trackList.optional(),
  gridTracks: trackList.optional(),
  gridCell: z
    .object({
      row: z.number().int().min(1).max(1024),
      column: z.number().int().min(1).max(64),
    })
    .optional(),
  rowSpan: z.number().int().min(1).max(64).optional(),
  gridBreakpoint: z.number().int().min(1).max(10000).optional(),
  narrowColumns: z.number().int().min(1).max(64).optional(),
  narrowGap: z.number().min(0).max(1000).optional(),
  gridRowHeight: z.number().min(1).max(10000).optional(),
  columnSpan: z.number().int().min(1).max(64).optional(),
  columns: z.number().int().min(1).max(64).optional(),
  minColumnWidth: z.number().min(0).max(10000).optional(),
  viewportWidth: z.boolean().optional(),
  constraintX: z
    .enum(["start", "center", "end", "stretch", "scale"])
    .optional(),
  constraintY: z
    .enum(["start", "center", "end", "stretch", "scale"])
    .optional(),
  alignX: z.enum(["start", "center", "end"]).optional(),
  alignY: z.enum(["start", "center", "end"]).optional(),
  gradient: gradient.optional(),
  tint: z
    .object({
      color: z.string().regex(/^#[0-9a-f]{6}$/i),
      opacity: z.number().min(0).max(1),
    })
    .optional(),
  paints: paintLayers,
  strokePaints: paintLayers,
  corners: z
    .object({
      tl: z.number().min(0).max(10000),
      tr: z.number().min(0).max(10000),
      br: z.number().min(0).max(10000),
      bl: z.number().min(0).max(10000),
    })
    .optional(),
  cornerSmoothingModel: z.literal("figma").optional(),
  cornerSmoothing: z.number().min(0).max(1).optional(),
  layoutGuides: z.array(layoutGuideSchema).max(16).optional(),
  blendMode: z.enum(blendModes).optional(),
  fillBlendMode: z.enum(blendModes).optional(),
  strokeBlendMode: z.enum(blendModes).optional(),
  sketchCanvasPaints: z.array(z.string().max(64)).max(20).optional(),
  sketchSymbolBackground: z
    .object({ inExport: z.boolean(), inInstance: z.boolean() })
    .optional(),
  strokeInLayout: z.literal(false).optional(),
  strokeAlign: z.enum(["inside", "center", "outside"]).optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted", "double"]).optional(),
  opacity: z.number().min(0).max(1).optional(),
  fillOpacity: z.number().min(0).max(1).optional(),
  colorOpacity: z.number().min(0).max(1).optional(),
  strokeOpacity: z.number().min(0).max(1).optional(),
  stroke: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  strokeVisible: z.boolean().optional(),
  strokeSides: z
    .object({
      top: sideWidth,
      right: sideWidth,
      bottom: sideWidth,
      left: sideWidth,
    })
    .optional(),
  strokeDash: z.string().optional(),
  strokeWidth: z.number().min(0).max(100).optional(),
  ...fontSettingsSchema,
  fontFamily: z.string().min(1).max(200).optional(),
  fontWeight: z.number().int().min(100).max(900).optional(),
  lineHeight: z.number().min(1).max(1000).optional(),
  letterSpacing: z.number().min(-50).max(200).optional(),
  leadingTrim: z.literal("cap").optional(),
  fontSmoothing: z.literal("antialiased").optional(),
  fontStyle: z.enum(["normal", "italic"]).optional(),
  textDecoration: z.enum(["none", "underline", "line-through"]).optional(),
  textTransform: z
    .enum(["none", "uppercase", "lowercase", "capitalize"])
    .optional(),
  verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
  maxLines: z.number().int().min(1).max(100).optional(),
  textAlign: z.enum(["left", "center", "right", "justify"]).optional(),
  clipContent: z.boolean().optional(),
  blur: z.number().min(0).max(100).optional(),
  blurVisible: z.boolean().optional(),
  backdropBlurVisible: z.boolean().optional(),
  textEffectClip: z.literal("glyphs").optional(),
  backdropBlur: z.number().min(0).max(512).optional(),
  backdropSaturation: z.number().min(0).max(4).optional(),
  backdropBrightness: z.number().min(0).max(4).optional(),
  glassEnvironment: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  glassSampleEnvironment: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  figmaGlass: z
    .object({
      visible: z.boolean(),
      radius: z.number().finite(),
      refractionRadius: z.number().finite().optional(),
      refractionIntensity: z.number().finite().optional(),
      reflectionDistance: z.number().finite().optional(),
      startRadius: z.number().finite().optional(),
      opacity: z.number().finite().optional(),
      density: z.number().finite().optional(),
      specularAngle: z.number().finite().optional(),
      specularIntensity: z.number().finite().optional(),
      bevelSize: z.number().finite().optional(),
      chromaticAberration: z.number().finite().optional(),
      splay: z.number().finite().optional(),
    })
    .optional(),
  sketchGlass: z
    .object({
      depth: z.number().finite().optional(),
      distortion: z.number().finite().optional(),
      chromaticAberrationMultiplier: z.number().finite().optional(),
      skipLightingEffects: z.boolean().optional(),
    })
    .optional(),
  shadows: z.array(shadowSchema).max(32).optional(),
});
export const nodeSchema = z.object({
  id,
  parentId: id.nullable(),
  type: z.enum([
    "frame",
    "group",
    "section",
    "slice",
    "rectangle",
    "ellipse",
    "text",
    "button",
    "vector",
  ]),
  // Original design layers may have an explicitly empty name (e.g. an unlabelled Section).
  name: z.string().max(16384),
  text: z.string().max(50000),
  textRuns: textRunsSchema.optional(),
  sourceTextLayout: z
    .object({
      text: z.string().min(1).max(10000),
      styleKey: z.string().max(2048),
      width: z.number().positive().max(10000),
      height: z.number().positive().max(10000),
      lines: z
        .array(
          z
            .object({
              text: z.string().min(1).max(10000),
              x: z.array(z.number().finite()).min(1).max(10000),
              y: z.number().finite(),
            })
            .refine(
              (line) => line.x.length === [...line.text].length,
              "文字坐标数量须匹配 Unicode 字符数",
            ),
        )
        .min(1)
        .max(512),
    })
    .optional(),
  sourceTextShape: z
    .object({
      text: z.string().max(10000),
      styleKey: z.string().max(2048),
      width: z.number().positive().max(10000),
      height: z.number().positive().max(10000),
      coverageOffsets: z
        .array(
          z.object({
            start: z.number().int().min(0).max(200000),
            shiftY: z.number().min(-0.5).max(0.5),
          }),
        )
        .max(512)
        .optional(),
      d: z
        .string()
        .min(1)
        .max(200000)
        .regex(/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\s-]+$/),
    })
    .optional(),
  style: styleSchema,
  hidden: z.boolean(),
  locked: z.boolean(),
  devStatus: z.enum(["none", "ready", "completed"]).optional(),
  exportSettings: z.array(exportSettingSchema).max(16).optional(),
  annotations: z.array(annotationSchema).max(64).optional(),
  fillToken: id.optional(),
  // Source tools can explicitly override a field to its current inherited value.
  instanceOverrides: z.array(z.string().min(1).max(100)).max(256).optional(),
  templateKey: id.optional(),
  componentSet: z.object({ libraryId: id, componentId: id }).optional(),
  nestedSlot: z.literal(true).optional(),
  nestedSource: instanceSourceRef.optional(),
  nestedKey: id.optional(),
  nestedPath: z.array(id).min(2).max(128).optional(),
  vector: z
    .object({
      width: z.number().positive().max(10000),
      height: z.number().positive().max(10000),
      stretch: z.literal(true).optional(),
      fillFromStyle: z.literal(true).optional(),
      overflowVisible: z.literal(true).optional(),
      radial: z
        .discriminatedUnion("kind", [
          z.object({
            kind: z.literal("polygon"),
            points: z.number().int().min(3).max(64),
          }),
          z.object({
            kind: z.literal("star"),
            points: z.number().int().min(3).max(64),
            innerRatio: z.number().min(0.01).max(0.99),
          }),
        ])
        .optional(),
      paths: z
        .array(
          z.object({
            d: z
              .string()
              .min(1)
              .max(100000)
              .regex(/^[MmZzLlHhVvCcSsQqTtAaEe0-9.,+\s-]+$/),
            junctions: z
              .array(
                z.object({
                  contour: z.number().int().nonnegative(),
                  anchor: z.number().int().nonnegative(),
                  id,
                }),
              )
              .max(8192)
              .optional(),
            fill: z.boolean(),
            fillColor: z
              .string()
              .regex(/^#[a-f\d]{6}$/i)
              .optional(),
            strokeColor: z
              .string()
              .regex(/^#[a-f\d]{6}$/i)
              .optional(),
            lineCap: z.enum(["round", "square", "butt"]).optional(),
            lineJoin: z.enum(["miter", "round", "bevel"]).optional(),
            opacity: z.number().min(0).max(1).optional(),
            fillOpacity: z.number().min(0).max(1).optional(),
            strokeOpacity: z.number().min(0).max(1).optional(),
            fillRule: z.enum(["nonzero", "evenodd"]).optional(),
            strokeWidth: z.number().min(0).max(100),
          }),
        )
        .min(1)
        .max(100),
    })
    .optional(),
  variableBindings: z.partialRecord(z.enum(variableProperties), id).optional(),
  variableModes: z.record(id, id).optional(),
  styleBindings: z
    .object({
      paint: id.optional(),
      stroke: id.optional(),
      text: id.optional(),
      effect: id.optional(),
      grid: id.optional(),
    })
    .optional(),
  styleOverrides: z.array(z.string()).optional(),
  instance: instanceSourceRef
    .extend({
      slots: slotDictionary.optional(),
    })
    .optional(),
  interaction: interactionSchema.optional(),
  interactions: z.array(interactionSchema).max(16).optional(),
  image: imageFillSchema.optional(),
  maskType: z.enum(["vector", "alpha", "luminance"]).optional(),
  siblingMask: z.enum(["alpha", "luminance", "vector"]).optional(),
  maskSourceId: id.optional(),
  operandOperation: z
    .enum(["union", "subtract", "intersect", "exclude"])
    .optional(),
  compoundWindingRule: z.enum(["nonzero", "evenodd"]).optional(),
  booleanOperation: z
    .enum(["union", "subtract", "intersect", "exclude", "compound"])
    .optional(),
  control: z
    .object({
      kind: z.enum([
        "button",
        "switch",
        "checkbox",
        "textfield",
        "slider",
        "stepper",
        "segmented",
        "progress",
      ]),
      label: z.string().max(200),
      value: z.union([z.boolean(), z.string().max(10000), z.number()]),
      disabled: z.boolean().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      step: z.number().positive().optional(),
      options: z.array(z.string().max(200)).min(1).max(20).optional(),
      palette: z
        .object({
          accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
          track: z.string().regex(/^#[0-9a-fA-F]{6}$/),
          surface: z.string().regex(/^#[0-9a-fA-F]{6}$/),
          border: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .optional(),
        })
        .optional(),
    })
    .optional(),
});
export type DesignNode = z.infer<typeof nodeSchema>;
export function fillUsesTextColor(node: DesignNode) {
  return (
    node.type === "text" ||
    (node.type === "vector" && !node.vector?.fillFromStyle) ||
    !!node.booleanOperation
  );
}
export type NodeStyle = DesignNode["style"];
export const defaultStyle: NodeStyle = {
  x: 0,
  y: 0,
  width: 160,
  height: 80,
  fill: "#e5e7eb",
  color: "#1e293b",
  radius: 8,
  fontSize: 16,
  padding: 16,
  gap: 12,
  layout: "free",
};

export function createNode(
  type: DesignNode["type"],
  parentId: string | null = null,
): DesignNode {
  return {
    id: crypto.randomUUID(),
    parentId,
    type,
    name: {
      frame: "画板",
      group: "组",
      section: "分区",
      slice: "切片",
      rectangle: "矩形",
      ellipse: "椭圆",
      text: "文本",
      button: "按钮",
      vector: "矢量",
    }[type],
    text: type === "button" ? "继续" : type === "text" ? "输入你的文字" : "",
    hidden: false,
    locked: false,
    style: {
      ...defaultStyle,
      ...(type === "frame" ? { width: 390, height: 844, fill: "#ffffff" } : {}),
      ...(type === "section"
        ? {
            width: 640,
            height: 480,
            fill: "#eef2ff",
            fillOpacity: 0.65,
            radius: 8,
            stroke: "#525866",
            strokeWidth: 1,
          }
        : {}),
      ...(type === "slice"
        ? {
            width: 200,
            height: 160,
            fill: "#ffffff",
            fillOpacity: 0,
            radius: 0,
          }
        : {}),
      ...(type === "text" ? { height: 36, radius: 0 } : {}),
      ...(type === "button"
        ? { height: 44, fill: "#635bff", color: "#ffffff" }
        : {}),
    },
  };
}

export function validateLayerGeometry(
  node: DesignNode,
  nodes: ReadonlyMap<string, DesignNode>,
) {
  validateRuns(node);
  if (node.componentSet && node.type !== "group")
    throw Error("画布组件集必须使用组图层");
  const s = node.style;
  if (
    (s.minWidth ?? 1) > (s.maxWidth ?? 10000) ||
    (s.minHeight ?? 1) > (s.maxHeight ?? 10000)
  )
    throw new Error("最小尺寸不能超过最大尺寸");
  if (node.maskSourceId) {
    const source = nodes.get(node.maskSourceId);
    if (
      node.type !== "group" ||
      node.booleanOperation ||
      !source ||
      source.parentId !== node.id ||
      (!["rectangle", "ellipse", "vector"].includes(source.type) &&
        !source.booleanOperation)
    )
      throw new Error("矢量蒙版需要同组的形状源");
  }
  if (node.booleanOperation && node.type !== "group")
    throw new Error("布尔运算需要组图层");
  if (
    node.parentId &&
    nodes.get(node.parentId)?.booleanOperation &&
    !(
      node.type === "rectangle" ||
      node.type === "ellipse" ||
      node.booleanOperation ||
      node.vector?.paths.every((p) => p.fill)
    )
  )
    throw new Error("布尔组只接受填充形状");
}
