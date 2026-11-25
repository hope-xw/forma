import type { Operation } from "../domain/commands";
import type { DesignDocument, NodeStyle } from "../domain/document";
import type { Point } from "../domain/geometry";
import { parseLibrary, type ComponentLibrary } from "../domain/library-schema";
import {
  assembleKitTemplate,
  createAppearanceSystem,
  KitBuilder,
  kitComponents,
  kitTokens,
  type Appearance,
  type KitDefinition,
  type KitPlacement,
  type KitTemplateMeta,
  type KitTypographySpec,
  type KitScaleSpec,
} from "./kit-builder";

export const MATERIAL3_LIBRARY_ID = "forma-material3-v1";
const collectionId = "m3-appearance",
  idPrefix = "m3-color";
export const material3Themes = {
  Light: {
    primary: "#6750a4",
    onPrimary: "#ffffff",
    primaryContainer: "#eaddff",
    onPrimaryContainer: "#21005d",
    secondary: "#625b71",
    secondaryContainer: "#e8def8",
    onSecondaryContainer: "#1d192b",
    surface: "#fef7ff",
    surfaceContainer: "#f3edf7",
    surfaceContainerHigh: "#ece6f0",
    onSurface: "#1d1b20",
    onSurfaceVariant: "#49454f",
    outline: "#79747e",
    outlineVariant: "#cac4d0",
    error: "#b3261e",
    onError: "#ffffff",
  },
  Dark: {
    primary: "#d0bcff",
    onPrimary: "#381e72",
    primaryContainer: "#4f378b",
    onPrimaryContainer: "#eaddff",
    secondary: "#ccc2dc",
    secondaryContainer: "#4a4458",
    onSecondaryContainer: "#e8def8",
    surface: "#141218",
    surfaceContainer: "#211f26",
    surfaceContainerHigh: "#2b2930",
    onSurface: "#e6e0e9",
    onSurfaceVariant: "#cac4d0",
    outline: "#938f99",
    outlineVariant: "#49454f",
    error: "#f2b8b5",
    onError: "#601410",
  },
} as const;
export const material3Tokens = kitTokens(material3Themes, "m3", "Material3");
export const material3Typography = [
  { name: "Display Small", size: 36, lineHeight: 44, weight: 400 },
  { name: "Headline Medium", size: 28, lineHeight: 36, weight: 400 },
  { name: "Title Large", size: 22, lineHeight: 28, weight: 500 },
  { name: "Title Medium", size: 16, lineHeight: 24, weight: 500 },
  { name: "Body Large", size: 16, lineHeight: 24, weight: 400 },
  { name: "Body Medium", size: 14, lineHeight: 20, weight: 400 },
  { name: "Label Large", size: 14, lineHeight: 20, weight: 500 },
  { name: "Label Small", size: 11, lineHeight: 16, weight: 500 },
] as const satisfies readonly KitTypographySpec[];
export const material3Spacing = [
  { name: "ExtraSmall", value: "4px", kind: "radius" },
  { name: "Small", value: "8px", kind: "radius" },
  { name: "Medium", value: "12px", kind: "radius" },
  { name: "Large", value: "16px", kind: "radius" },
  { name: "ExtraLarge", value: "28px", kind: "radius" },
  { name: "Full", value: "999px", kind: "radius" },
] as const satisfies readonly KitScaleSpec[];
function defaults(a: Appearance) {
  const palette = material3Themes[a];
  return {
    fill: palette.surface,
    text: palette.onSurface,
    accent: palette.primary,
    secondary: palette.surfaceContainerHigh,
    surface: palette.surface,
    border: palette.outline,
    fontFamily: "Roboto, system-ui, sans-serif",
    semantic: { palette, idPrefix },
  };
}
const action = "操作",
  input = "输入与选择",
  navigation = "导航",
  feedback = "容器与反馈";
const positions = ["First", "Second", "Third"];
const label: Partial<NodeStyle> = { fontWeight: 500, lineHeight: 20 };
const center: Partial<NodeStyle> = { ...label, textAlign: "center" };
const elevated: NodeStyle["shadows"] = [
  {
    x: 0,
    y: 1,
    blur: 3,
    spread: 0,
    color: "#000000",
    opacity: 0.18,
    inset: false,
  },
  {
    x: 0,
    y: 3,
    blur: 8,
    spread: -2,
    color: "#000000",
    opacity: 0.12,
    inset: false,
  },
];

const definitions: KitDefinition[] = [
  {
    id: "m3-button",
    name: "按钮 Button",
    category: action,
    description: "药丸形操作按钮，五种强调层级与禁用态。",
    width: 128,
    height: 40,
    axes: {
      Style: ["Filled", "Tonal", "Outlined", "Text", "Elevated"],
      State: ["Default", "Disabled"],
    },
    draw(b, p) {
      const disabled = p.State === "Disabled",
        outlined = p.Style === "Outlined",
        transparent = outlined || p.Style === "Text";
      const fill = disabled
        ? "onSurface"
        : p.Style === "Filled"
          ? "primary"
          : p.Style === "Tonal"
            ? "secondaryContainer"
            : "surfaceContainer";
      const color = disabled
        ? "onSurface"
        : p.Style === "Filled"
          ? "onPrimary"
          : p.Style === "Tonal"
            ? "onSecondaryContainer"
            : "primary";
      b.rootStyle({
        fill,
        fillOpacity: transparent ? 0 : disabled ? 0.12 : 1,
        radius: 20,
        stroke: disabled ? "onSurface" : "outline",
        strokeWidth: outlined ? 1 : 0,
        strokeOpacity: disabled ? 0.12 : 1,
        shadows: p.Style === "Elevated" && !disabled ? elevated : [],
      });
      const icon = b.lucideIcon("icon", "bookmark", 17, 11, 18, color);
      if (disabled) icon.style.opacity = 0.38;
      b.text("label", "保存路线", 42, 10, 72, 14, {
        ...label,
        color,
        opacity: disabled ? 0.38 : 1,
      });
      b.control("button", "", disabled);
    },
  },
  {
    id: "m3-fab",
    name: "悬浮按钮 FAB",
    category: action,
    description: "主容器色搭配悬浮阴影，扩展尺寸附文字。",
    width: 56,
    height: 56,
    axes: { Size: ["Small", "Standard", "Large", "Extended"] },
    draw(b, p) {
      const extended = p.Size === "Extended",
        height = p.Size === "Small" ? 40 : p.Size === "Large" ? 96 : 56,
        size = p.Size === "Large" ? 36 : 24;
      b.rootStyle({
        width: extended ? 140 : height,
        height,
        radius: height === 40 ? 12 : height === 96 ? 28 : 16,
        fill: "primaryContainer",
        shadows: elevated,
      });
      b.lucideIcon(
        "icon",
        "pencil",
        extended ? 16 : (height - size) / 2,
        (height - size) / 2,
        size,
        "onPrimaryContainer",
      );
      if (extended)
        b.text("label", "新建路线", 52, 18, 76, 14, {
          ...label,
          color: "onPrimaryContainer",
        });
      b.control("button", "");
    },
  },
  {
    id: "m3-icon-button",
    name: "图标按钮 Icon Button",
    category: action,
    description: "收藏图标与四种图标按钮容器。",
    width: 40,
    height: 40,
    axes: { Style: ["Standard", "Filled", "Tonal", "Outlined"] },
    draw(b, p) {
      const filled = p.Style === "Filled",
        tonal = p.Style === "Tonal";
      b.rootStyle({
        radius: 20,
        fill: filled ? "primary" : "secondaryContainer",
        fillOpacity: filled || tonal ? 1 : 0,
        stroke: "outline",
        strokeWidth: p.Style === "Outlined" ? 1 : 0,
      });
      b.lucideIcon(
        "icon",
        "heart",
        8,
        8,
        24,
        filled
          ? "onPrimary"
          : tonal
            ? "onSecondaryContainer"
            : "onSurfaceVariant",
      );
      b.control("button", "");
    },
  },
  {
    id: "m3-segmented-button",
    name: "分段按钮 Segmented Button",
    category: action,
    description: "三个互斥选项，选中段显示勾号与浅色容器。",
    width: 336,
    height: 40,
    axes: { Selected: positions },
    draw(b, p) {
      const index = positions.indexOf(p.Selected),
        labels = ["步行", "骑行", "公交"],
        segment = (336 - 8) / 3;
      b.rootStyle({
        radius: 20,
        stroke: "outline",
        strokeWidth: 1,
        clipContent: true,
      });
      const active = b.frame("active", 4 + index * segment, 2, segment, 36, {
        fill: "secondaryContainer",
        radius: 18,
      });
      b.lucideIcon(
        "mark",
        "check",
        12,
        9,
        18,
        "onSecondaryContainer",
        2,
        active.id,
      );
      [1, 2].forEach((i) =>
        b.box("separator-" + i, 4 + i * segment, 0, 1, 40, { fill: "outline" }),
      );
      labels.forEach((v, i) =>
        b.text("label-" + i, v, 4 + i * segment + 24, 10, segment - 36, 14, {
          ...center,
          color: i === index ? "onSecondaryContainer" : "onSurface",
        }),
      );
      b.control("segmented", index, false, labels);
    },
  },
  {
    id: "m3-text-field",
    name: "文本框 Text Field",
    category: input,
    description: "浮动标签、焦点描边和带提示的错误状态。",
    width: 342,
    height: 56,
    axes: {
      Style: ["Filled", "Outlined"],
      State: ["Default", "Focused", "Error"],
    },
    draw(b, p) {
      const filled = p.Style === "Filled",
        error = p.State === "Error",
        focused = p.State === "Focused",
        ink = error ? "error" : focused ? "primary" : "onSurfaceVariant",
        line = error || focused ? 2 : 1;
      const top = filled ? 0 : 8;
      b.rootStyle({ height: top + (error ? 80 : 56), fillOpacity: 0 });
      b.box("container", 0, top, 342, 56, {
        fill: filled ? "surfaceContainerHigh" : "surface",
        radius: 4,
        ...(filled
          ? { corners: { tl: 4, tr: 4, bl: 0, br: 0 } }
          : { stroke: focused || error ? ink : "outline", strokeWidth: line }),
      });
      if (filled) b.box("indicator", 0, 56 - line, 342, line, { fill: ink });
      else b.box("notch", 12, top, 61, 3, { fill: "surface" });
      b.text("label", "路线名称", 16, filled ? 6 : 0, 56, 12, {
        lineHeight: 16,
        color: ink,
      });
      b.text("value", "输入名称", 16, filled ? 26 : top + 17, 276, 16, {
        lineHeight: 24,
        color: "onSurfaceVariant",
      });
      if (error) {
        b.lucideIcon("error-icon", "alert-circle", 306, top + 18, 20, "error");
        b.text("helper", "请输入路线名称", 16, top + 60, 304, 12, {
          color: "error",
        });
      }
      b.control("input", "");
    },
  },
  {
    id: "m3-search-bar",
    name: "搜索栏 Search Bar",
    category: input,
    description: "圆形搜索容器，输入中显示返回和清除操作。",
    width: 358,
    height: 56,
    axes: { State: ["Default", "Active"] },
    draw(b, p) {
      const active = p.State === "Active";
      b.rootStyle({ radius: 28, fill: "surfaceContainerHigh" });
      b.lucideIcon(
        "leading",
        active ? "arrow-left" : "search",
        16,
        16,
        24,
        "onSurface",
      );
      b.text("value", active ? "山间步道" : "搜索地点和路线", 56, 16, 240, 16, {
        lineHeight: 24,
        color: active ? "onSurface" : "onSurfaceVariant",
      });
      b.lucideIcon(
        "trailing",
        active ? "x" : "sliders-horizontal",
        318,
        16,
        24,
        "onSurfaceVariant",
      );
      b.control("input", active ? "山间步道" : "");
    },
  },
  {
    id: "m3-switch",
    name: "开关 Switch",
    category: input,
    description: "52 × 32 轨道，开启时拇指内显示勾号。",
    width: 52,
    height: 32,
    axes: { Value: ["On", "Off"], State: ["Default", "Disabled"] },
    draw(b, p) {
      const on = p.Value === "On",
        disabled = p.State === "Disabled",
        size = on ? 24 : 16;
      b.rootStyle({
        radius: 16,
        fill: on ? "primary" : "surfaceContainerHigh",
        stroke: "outline",
        strokeWidth: on ? 0 : 2,
        opacity: disabled ? 0.38 : 1,
      });
      b.frame("thumb", on ? 24 : 8, (32 - size) / 2, size, size, {
        radius: size / 2,
        fill: on ? "onPrimary" : "outline",
      });
      if (on) b.lucideIcon("mark", "check", 4, 4, 16, "primary", 2, "thumb");
      b.control("switch", on, disabled);
    },
  },
  {
    id: "m3-checkbox",
    name: "复选框 Checkbox",
    category: input,
    description: "方形勾选控件与低强调禁用态。",
    width: 24,
    height: 24,
    axes: { Value: ["Checked", "Unchecked"], State: ["Default", "Disabled"] },
    draw(b, p) {
      const on = p.Value === "Checked",
        disabled = p.State === "Disabled";
      b.rootStyle({
        radius: 4,
        fill: "primary",
        fillOpacity: on ? 1 : 0,
        stroke: "onSurfaceVariant",
        strokeWidth: on ? 0 : 2,
        opacity: disabled ? 0.38 : 1,
      });
      if (on) b.lucideIcon("check", "check", 3, 3, 18, "onPrimary", 2.5);
      b.control("checkbox", on, disabled);
    },
  },
  {
    id: "m3-chip",
    name: "标签芯片 Chip",
    category: input,
    description: "辅助、筛选及输入芯片，支持已选外观。",
    width: 100,
    height: 32,
    axes: { Kind: ["Assist", "Filter", "Input"], Selected: ["False", "True"] },
    draw(b, p) {
      const selected = p.Selected === "True",
        user = p.Kind === "Input",
        color = selected ? "onSecondaryContainer" : "onSurface";
      b.rootStyle({
        width: user ? 116 : 100,
        radius: 8,
        fill: "secondaryContainer",
        fillOpacity: selected ? 1 : 0,
        stroke: "outline",
        strokeWidth: selected ? 0 : 1,
      });
      b.lucideIcon(
        "leading",
        selected
          ? "check"
          : user
            ? "user-round"
            : p.Kind === "Filter"
              ? "list-filter"
              : "sparkles",
        8,
        7,
        18,
        selected ? color : "primary",
      );
      b.text(
        "label",
        user ? "林予" : p.Kind === "Filter" ? "仅步行" : "推荐",
        34,
        6,
        54,
        14,
        { ...label, color },
      );
      if (user) b.lucideIcon("remove", "x", 92, 8, 16, color);
    },
  },
  {
    id: "m3-slider",
    name: "滑块 Slider",
    category: input,
    description: "连续数值与起、中、高三个起始位置。",
    width: 240,
    height: 36,
    axes: { Value: ["Low", "Mid", "High"] },
    draw(b, p) {
      const value = { Low: 20, Mid: 50, High: 80 }[p.Value]!,
        x = (240 * value) / 100;
      b.rootStyle({ fillOpacity: 0 });
      b.pill("track", 0, 14, 240, 8, { fill: "secondaryContainer" });
      b.pill("fill", 0, 14, x, 8, { fill: "primary" });
      b.box("thumb", x - 3, 2, 6, 32, { radius: 3, fill: "primary" });
      b.pill("stop", 232, 16, 4, 4, { fill: "onSecondaryContainer" });
      b.control("slider", value);
    },
  },
  {
    id: "m3-top-app-bar",
    name: "顶部应用栏 Top App Bar",
    category: navigation,
    description: "居中、小型和两行中型应用栏。",
    width: 390,
    height: 64,
    axes: { Style: ["Center", "Small", "Medium"] },
    draw(b, p) {
      const medium = p.Style === "Medium",
        centered = p.Style === "Center";
      b.rootStyle({ height: medium ? 112 : 64, fill: "surface" });
      b.lucideIcon("menu", "menu", 16, 20, 24, "onSurface");
      b.lucideIcon("action", "more-vertical", 350, 20, 24, "onSurfaceVariant");
      b.text(
        "title",
        "行迹手册",
        medium ? 16 : 64,
        medium ? 64 : 18,
        medium ? 340 : 262,
        medium ? 28 : 22,
        {
          lineHeight: medium ? 36 : 28,
          textAlign: centered ? "center" : "left",
        },
      );
    },
  },
  {
    id: "m3-nav-bar",
    name: "底部导航栏 Navigation Bar",
    category: navigation,
    description: "四个目的地，选中图标带椭圆指示器。",
    width: 390,
    height: 80,
    axes: { Active: ["Home", "Explore", "Saved", "Profile"] },
    draw(b, p) {
      b.rootStyle({ fill: "surfaceContainer" });
      const destinations = [
        ["Home", "home", "首页"],
        ["Explore", "compass", "探索"],
        ["Saved", "bookmark", "收藏"],
        ["Profile", "user-round", "我的"],
      ];
      destinations.forEach(([id, icon, title], i) => {
        const x = (i + 0.5) * 97.5,
          on = id === p.Active;
        if (on)
          b.pill("indicator", x - 32, 10, 64, 32, {
            fill: "secondaryContainer",
          });
        b.lucideIcon(
          "icon-" + id,
          icon,
          x - 12,
          14,
          24,
          on ? "onSecondaryContainer" : "onSurfaceVariant",
          on ? 2.2 : 1.75,
        );
        b.text("label-" + id, title, x - 44, 46, 88, 12, {
          ...center,
          lineHeight: 16,
          fontWeight: on ? 600 : 500,
          color: on ? "onSurface" : "onSurfaceVariant",
        });
      });
    },
  },
  {
    id: "m3-tabs",
    name: "标签页 Tabs",
    category: navigation,
    description: "等宽标签配随内容宽度的主色指示线。",
    width: 390,
    height: 48,
    axes: { Active: positions },
    draw(b, p) {
      const index = positions.indexOf(p.Active);
      b.divider("divider", 0, 47, 390, "outlineVariant");
      ["近期", "已收藏", "离线"].forEach((v, i) =>
        b.text("label-" + i, v, i * 130, 14, 130, 14, {
          ...center,
          color: i === index ? "primary" : "onSurfaceVariant",
        }),
      );
      b.box("indicator", index * 130 + 43, 45, 44, 3, {
        fill: "primary",
        radius: 2,
      });
    },
  },
  {
    id: "m3-card",
    name: "卡片 Card",
    category: feedback,
    description: "可编辑地形插画，支持填充、描边与阴影容器。",
    width: 358,
    height: 200,
    axes: { Style: ["Elevated", "Filled", "Outlined"] },
    draw(b, p) {
      b.rootStyle({
        radius: 12,
        fill:
          p.Style === "Outlined"
            ? "surface"
            : p.Style === "Filled"
              ? "surfaceContainerHigh"
              : "surfaceContainer",
        stroke: "outlineVariant",
        strokeWidth: p.Style === "Outlined" ? 1 : 0,
        shadows: p.Style === "Elevated" ? elevated : [],
        clipContent: true,
      });
      const art = b.frame(
        "landscape",
        0,
        0,
        358,
        110,
        { fill: "primaryContainer", clipContent: true },
        "root",
        "层叠山脊",
      );
      b.pill(
        "sun",
        258,
        12,
        42,
        42,
        { fill: "onPrimaryContainer", opacity: 0.12 },
        art.id,
      );
      for (const [key, d, color, opacity] of [
        [
          "horizon",
          "M0 81 Q52 72 85 48 T164 66 Q200 83 243 56 T358 31 V110 H0 Z",
          "primary",
          0.28,
        ],
        [
          "ridge",
          "M0 95 Q60 50 109 78 T205 75 Q255 36 315 56 L358 71 V110 H0 Z",
          "primary",
          0.65,
        ],
        [
          "foothills",
          "M0 102 Q64 87 105 95 T211 93 Q284 70 358 82 V110 H0 Z",
          "onPrimaryContainer",
          0.65,
        ],
      ] as const) {
        const layer = b.add("vector", key, art.id, {
          x: 0,
          y: 0,
          width: 358,
          height: 110,
          color,
          opacity,
        });
        layer.vector = {
          width: 358,
          height: 110,
          paths: [{ d, fill: true, strokeWidth: 0 }],
        };
      }
      b.text("title", "山间环线", 16, 126, 288, 22, {
        lineHeight: 28,
        fontWeight: 500,
      });
      b.text("subtitle", "步行  ·  6.4 公里  ·  约 2 小时", 16, 164, 292, 14, {
        color: "onSurfaceVariant",
        lineHeight: 20,
      });
      b.lucideIcon("bookmark", "bookmark", 318, 133, 22, "primary");
    },
  },
  {
    id: "m3-list-item",
    name: "列表项 List Item",
    category: feedback,
    description: "前导图标、正文及可选说明和尾随箭头。",
    width: 358,
    height: 72,
    axes: { Density: ["OneLine", "TwoLine", "WithTrailing"] },
    draw(b, p) {
      const compact = p.Density === "OneLine";
      b.rootStyle({ height: compact ? 56 : 72, fill: "surface" });
      b.pill("icon-tile", 8, compact ? 8 : 16, 40, 40, {
        fill: "secondaryContainer",
      });
      b.lucideIcon(
        "icon",
        "map-pin",
        18,
        compact ? 18 : 26,
        20,
        "onSecondaryContainer",
      );
      b.text("title", "湖畔步道", 64, compact ? 16 : 12, 250, 16, {
        lineHeight: 24,
      });
      if (!compact)
        b.text("subtitle", "步行  ·  3.2 公里", 64, 38, 250, 14, {
          color: "onSurfaceVariant",
          lineHeight: 20,
        });
      if (p.Density === "WithTrailing")
        b.lucideIcon(
          "trailing",
          "chevron-right",
          326,
          26,
          20,
          "onSurfaceVariant",
        );
    },
  },
  {
    id: "m3-dialog",
    name: "对话框 Dialog",
    category: feedback,
    description: "圆角对话框，标题、正文和双操作独立可编辑。",
    width: 312,
    height: 180,
    axes: { Style: ["Basic", "WithIcon"] },
    draw(b, p) {
      const icon = p.Style === "WithIcon",
        offset = icon ? 36 : 0;
      b.rootStyle({
        height: 180 + offset,
        radius: 28,
        fill: "surfaceContainerHigh",
        shadows: elevated,
      });
      if (icon) b.lucideIcon("icon", "download", 144, 22, 24, "primary");
      b.text("title", "下载离线地图？", 24, 22 + offset, 264, 24, {
        lineHeight: 32,
        textAlign: icon ? "center" : "left",
      });
      b.text(
        "body",
        "地图约占 24 MB，下载后可在没有网络时查看路线。",
        24,
        66 + offset,
        264,
        14,
        { height: 44, lineHeight: 20, color: "onSurfaceVariant" },
      );
      b.text("cancel", "取消", 164, 136 + offset, 56, 14, {
        ...center,
        color: "primary",
      });
      b.text("confirm", "下载", 228, 136 + offset, 56, 14, {
        ...center,
        color: "primary",
      });
    },
  },
  {
    id: "m3-snackbar",
    name: "轻提示 Snackbar",
    category: feedback,
    description: "反色反馈容器，可带撤销操作。",
    width: 358,
    height: 48,
    axes: { Action: ["Simple", "WithAction"] },
    draw(b, p) {
      b.rootStyle({ radius: 4, fill: "onSurface", shadows: elevated });
      b.text("message", "路线已加入收藏", 16, 14, 238, 14, {
        color: "surface",
        lineHeight: 20,
      });
      if (p.Action === "WithAction")
        b.text("action", "撤销", 278, 14, 64, 14, {
          ...center,
          color: "primaryContainer",
        });
    },
  },
  {
    id: "m3-progress",
    name: "进度指示 Progress",
    category: feedback,
    description: "确定进度的线形和环形表示。",
    width: 240,
    height: 8,
    axes: { Kind: ["Linear", "Circular"] },
    draw(b, p) {
      b.rootStyle({ fillOpacity: 0 });
      if (p.Kind === "Linear") {
        b.pill("track", 0, 2, 240, 4, { fill: "secondaryContainer" });
        b.pill("fill", 0, 2, 144, 4, { fill: "primary" });
      } else {
        b.rootStyle({ width: 40, height: 40 });
        const ring = b.add("vector", "ring", "root", {
          x: 0,
          y: 0,
          width: 40,
          height: 40,
          color: "secondaryContainer",
        });
        ring.vector = {
          width: 40,
          height: 40,
          paths: [
            { d: "M20 3 A17 17 0 1 1 19.99 3", fill: false, strokeWidth: 4 },
          ],
        };
        const arc = b.add("vector", "arc", "root", {
          x: 0,
          y: 0,
          width: 40,
          height: 40,
          color: "primary",
        });
        arc.vector = {
          width: 40,
          height: 40,
          paths: [
            {
              d: "M20 3 A17 17 0 1 1 10 33.75",
              fill: false,
              strokeWidth: 4,
              lineCap: "round",
            },
          ],
        };
      }
      b.control("progress", 60);
    },
  },
];

export const material3Library: ComponentLibrary = parseLibrary({
  format: "forma/library",
  version: 1,
  id: MATERIAL3_LIBRARY_ID,
  revision: 1,
  name: "Material Design 3",
  description:
    "Android 原生可编辑组件，含 Material 3 双主题语义色、输入状态、导航与反馈。",
  source: {
    name: "Forma 原生设计系统（参考 Material Design 3）",
    license:
      "Forma 自研原生组件与 ISC Lucide 矢量图标；不含 Google 专有字体或闭源资产。",
  },
  designSystem: createAppearanceSystem(
    collectionId,
    "Material 3 Appearance",
    "Material3",
    idPrefix,
    material3Themes.Light,
    material3Themes.Dark,
  ),
  components: kitComponents(
    definitions,
    material3Themes,
    collectionId,
    idPrefix,
    defaults,
  ),
});

export const material3Templates: readonly KitTemplateMeta[] = [
  {
    id: "m3-android-home",
    libraryId: MATERIAL3_LIBRARY_ID,
    name: "Android 应用首页",
    description: "路线搜索、山景推荐与收藏路线。",
    width: 390,
    height: 844,
    platform: "android",
  },
  {
    id: "m3-android-settings",
    libraryId: MATERIAL3_LIBRARY_ID,
    name: "Android 系统设置",
    description: "管理地图、定位与离线下载偏好。",
    width: 390,
    height: 844,
    platform: "android",
  },
];
export function createMaterial3Template(
  doc: DesignDocument,
  templateId: string,
  appearance: Appearance,
  origin: Point,
): { operations: Operation[]; id: string } {
  const meta = material3Templates.find((t) => t.id === templateId);
  if (!meta) throw Error("未知 Material 3 模板：" + templateId);
  const board = new KitBuilder(
    appearance,
    meta.name + " · " + appearance,
    meta.width,
    meta.height,
    defaults(appearance),
  );
  board.rootStyle({ fill: "surface", clipContent: true });
  board.text("time", "9:41", 20, 8, 64, 14, { ...label, color: "onSurface" });
  board.lucideIcon("wifi", "wifi", 304, 9, 16, "onSurface");
  board.lucideIcon("signal", "signal", 326, 9, 16, "onSurface");
  board.lucideIcon("battery", "battery-full", 348, 8, 20, "onSurface");
  const home = templateId === "m3-android-home";
  const placements: KitPlacement[] = [
    {
      component: "m3-top-app-bar",
      x: 0,
      y: 32,
      props: { Style: home ? "Small" : "Medium" },
      text: { title: home ? "行迹手册" : "设置" },
    },
    {
      component: "m3-nav-bar",
      x: 0,
      y: 740,
      props: { Active: home ? "Home" : "Profile" },
    },
  ];
  if (home) {
    board.text("featured", "本周精选", 20, 182, 328, 22, {
      lineHeight: 28,
      fontWeight: 500,
      color: "onSurface",
    });
    board.text("recent", "最近路线", 20, 452, 328, 22, {
      lineHeight: 28,
      fontWeight: 500,
      color: "onSurface",
    });
    placements.push(
      { component: "m3-search-bar", x: 16, y: 106 },
      { component: "m3-card", x: 16, y: 226, props: { Style: "Filled" } },
      {
        component: "m3-list-item",
        x: 16,
        y: 494,
        props: { Density: "WithTrailing" },
      },
      {
        component: "m3-list-item",
        x: 16,
        y: 568,
        props: { Density: "WithTrailing" },
        text: { title: "杉林栈道", subtitle: "骑行  ·  8.6 公里" },
      },
      { component: "m3-fab", x: 318, y: 664, props: { Size: "Standard" } },
    );
  } else {
    board.text("preferences", "地图偏好", 24, 164, 342, 14, {
      ...label,
      color: "primary",
    });
    const settings = [
      ["moon", "跟随系统外观", "根据设备设置切换明暗主题", "On"],
      ["navigation", "实时定位", "行进时在地图上更新位置", "On"],
      ["download", "自动离线下载", "连接无线网络时更新已收藏的地图", "Off"],
    ] as const;
    settings.forEach(([icon, title, subtitle, value], i) => {
      const y = 204 + i * 86;
      board.lucideIcon(
        "setting-icon-" + i,
        icon,
        24,
        y + 13,
        22,
        "onSurfaceVariant",
      );
      board.text("setting-title-" + i, title, 64, y + 1, 232, 16, {
        lineHeight: 24,
        color: "onSurface",
      });
      board.text("setting-note-" + i, subtitle, 64, y + 29, 234, 12, {
        color: "onSurfaceVariant",
      });
      placements.push({
        component: "m3-switch",
        x: 314,
        y: y + 8,
        props: { Value: value },
      });
    });
    board.divider("divider", 24, 462, 342, "outlineVariant");
    board.text("map-section", "离线地图", 24, 488, 342, 14, {
      ...label,
      color: "primary",
    });
    placements.push(
      {
        component: "m3-list-item",
        x: 16,
        y: 526,
        props: { Density: "WithTrailing" },
        text: { title: "已下载的地区", subtitle: "2 个地区  ·  48 MB" },
      },
      {
        component: "m3-list-item",
        x: 16,
        y: 606,
        props: { Density: "WithTrailing" },
        text: { title: "存储位置", subtitle: "设备内部存储空间" },
      },
    );
  }
  board.box("system-bar", 0, 820, 390, 24, { fill: "surfaceContainer" });
  board.pill("gesture", 141, 830, 108, 4, { fill: "onSurface" });
  return assembleKitTemplate(doc, material3Library, board, origin, placements);
}
