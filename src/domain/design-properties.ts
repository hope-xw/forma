import type { NodeStyle } from "./node";

export const nestedCssProperties = {
  "insets.top": "paddingTop",
  "insets.right": "paddingRight",
  "insets.bottom": "paddingBottom",
  "insets.left": "paddingLeft",
  "corners.tl": "borderTopLeftRadius",
  "corners.tr": "borderTopRightRadius",
  "corners.br": "borderBottomRightRadius",
  "corners.bl": "borderBottomLeftRadius",
  "strokeSides.top": "borderTopWidth",
  "strokeSides.right": "borderRightWidth",
  "strokeSides.bottom": "borderBottomWidth",
  "strokeSides.left": "borderLeftWidth",
} as const;
export type NestedProperty = keyof typeof nestedCssProperties;
export function isNestedProperty(key: string): key is NestedProperty {
  return Object.hasOwn(nestedCssProperties, key);
}
export function nestedStylePatch(
  style: NodeStyle,
  key: NestedProperty,
  value: number,
): Partial<NodeStyle> {
  const [group, side] = key.split(".");
  if (group === "corners") {
    const r = style.radius;
    return {
      corners: {
        ...(style.corners ?? { tl: r, tr: r, br: r, bl: r }),
        [side]: value,
      },
    };
  }
  if (group === "insets") {
    const p = style.padding;
    return {
      insets: {
        ...(style.insets ?? { top: p, right: p, bottom: p, left: p }),
        [side]: value,
      },
    };
  }
  return { strokeSides: { ...style.strokeSides, [side]: value } };
}

export const variableProperties = [
  ...(Object.keys(nestedCssProperties) as NestedProperty[]),
  "fill",
  "color",
  "stroke",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "radius",
  "padding",
  "gap",
  "opacity",
  "fillOpacity",
  "colorOpacity",
  "strokeOpacity",
  "strokeWidth",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "blur",
  "backdropBlur",
  "fontFamily",
  "text",
  "visible",
] as const;
export type VariableProperty = (typeof variableProperties)[number];
export type VariableType = "color" | "number" | "string" | "boolean";
export function propertyType(key: string): VariableType {
  if (["fill", "color", "stroke"].includes(key)) return "color";
  if (["fontFamily", "text"].includes(key)) return "string";
  if (key === "visible") return "boolean";
  return "number";
}
export const styleGroups = {
  grid: [
    "gridTracks",
    "gridRowTracks",
    "layoutBreakpoints",
    "columns",
    "gap",
    "rowGap",
    "minColumnWidth",
    "gridRowHeight",
    "gridBreakpoint",
    "narrowColumns",
    "narrowGap",
  ],
  paint: ["fill", "fillBlendMode", "fillOpacity", "gradient", "paints"],
  stroke: [
    "stroke",
    "strokeOpacity",
    "strokeWidth",
    "strokeAlign",
    "strokeStyle",
    "strokeVisible",
    "strokeSides",
    "strokeBlendMode",
    "strokePaints",
    "strokeDash",
  ],
  text: [
    "color",
    "colorOpacity",
    "fontStyle",
    "textDecoration",
    "textTransform",
    "verticalAlign",
    "leadingTrim",
    "fontVariationSettings",
    "fontFeatureSettings",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "textAlign",
  ],
  effect: [
    "shadows",
    "blur",
    "backdropBlur",
    "backdropSaturation",
    "backdropBrightness",
    "sketchGlass",
    "figmaGlass",
  ],
} as const;
export type StyleKind = keyof typeof styleGroups;

export const propertyLabels: Record<string, string> = {
  layoutBreakpoints: "容器断点",
  gridRowTracks: "逐行高度",
  gridTracks: "自定义列宽",
  fontVariationSettings: "可变字体轴",
  fontFeatureSettings: "OpenType 特性",
  columns: "列数",
  rowGap: "行间距",
  minColumnWidth: "自适应最小列宽",
  gridRowHeight: "固定行高",
  gridBreakpoint: "断点宽度",
  narrowColumns: "窄容器列数",
  narrowGap: "窄容器间距",
  fill: "填充",
  color: "文字颜色",
  stroke: "描边颜色",
  strokePaints: "描边层",
  width: "宽度",
  height: "高度",
  minWidth: "最小宽度",
  maxWidth: "最大宽度",
  minHeight: "最小高度",
  maxHeight: "最大高度",
  radius: "圆角",
  padding: "内边距",
  gap: "间距",
  opacity: "不透明度",
  fillOpacity: "填充透明度",
  colorOpacity: "文字透明度",
  strokeOpacity: "描边透明度",
  strokeWidth: "描边宽度",
  strokeStyle: "描边线型",
  strokeAlign: "描边位置",
  strokeVisible: "显示描边",
  strokeDash: "虚线间隔",
  fontStyle: "字形",
  textDecoration: "文字装饰",
  textTransform: "字母大小写",
  leadingTrim: "文字裁切",
  verticalAlign: "垂直对齐",
  fontSize: "字号",
  fontWeight: "字重",
  lineHeight: "行高",
  letterSpacing: "字距",
  blur: "图层模糊",
  backdropBlur: "背景模糊",
  fontFamily: "字体",
  text: "文本内容",
  visible: "可见性",
  textAlign: "文字对齐",
};
