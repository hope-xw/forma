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

export const SHADCN_LIBRARY_ID = "forma-shadcn-v1";
const collectionId = "shadcn-appearance",
  idPrefix = "shadcn-color";
export const shadcnThemes = {
  Light: {
    background: "#ffffff",
    foreground: "#09090b",
    card: "#ffffff",
    primary: "#18181b",
    primaryForeground: "#fafafa",
    secondary: "#f4f4f5",
    secondaryForeground: "#18181b",
    muted: "#f4f4f5",
    mutedForeground: "#71717a",
    border: "#e4e4e7",
    ring: "#18181b",
    destructive: "#ef4444",
    destructiveForeground: "#fafafa",
    success: "#16a34a",
  },
  Dark: {
    background: "#09090b",
    foreground: "#fafafa",
    card: "#09090b",
    primary: "#fafafa",
    primaryForeground: "#18181b",
    secondary: "#27272a",
    secondaryForeground: "#fafafa",
    muted: "#27272a",
    mutedForeground: "#a1a1aa",
    border: "#27272a",
    ring: "#d4d4d8",
    destructive: "#dc2626",
    destructiveForeground: "#fafafa",
    success: "#22c55e",
  },
} as const;
export const shadcnTokens = kitTokens(shadcnThemes, "shadcn", "shadcn");
export const shadcnTypography = [
  { name: "H1", size: 36, lineHeight: 40, weight: 800 },
  { name: "H2", size: 30, lineHeight: 36, weight: 700 },
  { name: "H3", size: 24, lineHeight: 32, weight: 600 },
  { name: "H4", size: 20, lineHeight: 28, weight: 600 },
  { name: "Lead", size: 18, lineHeight: 28, weight: 400 },
  { name: "Body", size: 14, lineHeight: 20, weight: 400 },
  { name: "Small", size: 13, lineHeight: 18, weight: 500 },
  { name: "Muted", size: 12, lineHeight: 16, weight: 400 },
] as const satisfies readonly KitTypographySpec[];
export const shadcnSpacing = [
  { name: "Radius SM", value: "4px", kind: "radius" },
  { name: "Radius MD", value: "6px", kind: "radius" },
  { name: "Radius LG", value: "8px", kind: "radius" },
  { name: "Radius XL", value: "12px", kind: "radius" },
  { name: "Space SM", value: "8px", kind: "spacing" },
  { name: "Space MD", value: "16px", kind: "spacing" },
] as const satisfies readonly KitScaleSpec[];
function defaults(a: Appearance) {
  const palette = shadcnThemes[a];
  return {
    fill: palette.background,
    text: palette.foreground,
    accent: palette.primary,
    secondary: palette.secondary,
    surface: palette.background,
    border: palette.border,
    fontFamily: "Inter, system-ui, sans-serif",
    semantic: { palette, idPrefix },
  };
}
const general = "通用与操作",
  forms = "表单输入",
  nav = "导航与浮层",
  data = "卡片与数据";
const body: Partial<NodeStyle> = { color: "foreground", lineHeight: 20 };
const medium: Partial<NodeStyle> = { ...body, fontWeight: 500 };
const muted: Partial<NodeStyle> = { color: "mutedForeground", lineHeight: 18 };
const subtle: NodeStyle["shadows"] = [
  {
    x: 0,
    y: 1,
    blur: 2,
    spread: 0,
    color: "#000000",
    opacity: 0.08,
    inset: false,
  },
];
const panel: Partial<NodeStyle> = {
  fill: "card",
  stroke: "border",
  strokeWidth: 1,
  radius: 8,
};
const floating: Partial<NodeStyle> = {
  ...panel,
  shadows: [
    {
      x: 0,
      y: 10,
      blur: 24,
      spread: -8,
      color: "#000000",
      opacity: 0.19,
      inset: false,
    },
    ...subtle,
  ],
};
function tileIcon(
  b: KitBuilder,
  key: string,
  icon: string,
  x: number,
  y: number,
  size: number,
  solid = false,
) {
  b.frame(key, x, y, size, size, {
    fill: solid ? "primary" : "secondary",
    radius: 7,
  });
  b.lucideIcon(
    key + "-icon",
    icon,
    Math.round(size / 4),
    Math.round(size / 4),
    Math.round(size / 2),
    solid ? "primaryForeground" : "secondaryForeground",
    1.8,
    key,
  );
}
const definitions: KitDefinition[] = [
  {
    id: "shadcn-button",
    name: "Button 按钮",
    category: general,
    description: "五种操作强调色及三档尺寸。",
    width: 140,
    height: 36,
    axes: {
      Variant: ["Default", "Secondary", "Outline", "Ghost", "Destructive"],
      Size: ["Sm", "Default", "Lg"],
    },
    draw(b, p) {
      const small = p.Size === "Sm",
        large = p.Size === "Lg",
        height = small ? 32 : large ? 44 : 36,
        width = small ? 124 : large ? 158 : 140;
      const outline = p.Variant === "Outline",
        ghost = p.Variant === "Ghost",
        danger = p.Variant === "Destructive",
        secondary = p.Variant === "Secondary";
      const color = danger
        ? "destructiveForeground"
        : secondary
          ? "secondaryForeground"
          : ghost || outline
            ? "foreground"
            : "primaryForeground";
      b.rootStyle({
        width,
        height,
        radius: 6,
        fill: danger
          ? "destructive"
          : secondary
            ? "secondary"
            : outline || ghost
              ? "background"
              : "primary",
        fillOpacity: ghost ? 0 : 1,
        stroke: "border",
        strokeWidth: outline ? 1 : 0,
        shadows: ghost || secondary ? [] : subtle,
      });
      b.text(
        "label",
        danger ? "Delete project" : "Save changes",
        4,
        (height - 20) / 2,
        width - 8,
        small ? 13 : 14,
        { lineHeight: 20, color, fontWeight: 500, textAlign: "center" },
      );
      b.control("button", "");
    },
  },
  {
    id: "shadcn-badge",
    name: "Badge 徽章",
    category: general,
    description: "紧凑状态徽章与四种视觉层级。",
    width: 76,
    height: 24,
    axes: { Variant: ["Default", "Secondary", "Outline", "Destructive"] },
    draw(b, p) {
      const outline = p.Variant === "Outline",
        secondary = p.Variant === "Secondary",
        danger = p.Variant === "Destructive";
      b.rootStyle({
        radius: 6,
        fill: danger
          ? "destructive"
          : secondary
            ? "secondary"
            : outline
              ? "background"
              : "primary",
        stroke: "border",
        strokeWidth: outline ? 1 : 0,
      });
      b.text(
        "label",
        danger
          ? "Blocked"
          : secondary
            ? "Draft"
            : outline
              ? "Preview"
              : "Published",
        4,
        4,
        68,
        11,
        {
          lineHeight: 16,
          fontWeight: 600,
          textAlign: "center",
          color: danger
            ? "destructiveForeground"
            : secondary
              ? "secondaryForeground"
              : outline
                ? "foreground"
                : "primaryForeground",
        },
      );
    },
  },
  {
    id: "shadcn-avatar-item",
    name: "Avatar Row 用户条目",
    category: general,
    description: "姓名、邮箱和可编辑的在线指示点。",
    width: 280,
    height: 56,
    axes: { Status: ["Online", "Offline"] },
    draw(b, p) {
      b.rootStyle({ fillOpacity: 0 });
      b.pill("avatar", 4, 8, 40, 40, { fill: "secondary" });
      b.text("initials", "JL", 4, 18, 40, 14, {
        ...medium,
        textAlign: "center",
        color: "secondaryForeground",
      });
      b.pill("status", 33, 36, 12, 12, {
        fill: p.Status === "Online" ? "success" : "mutedForeground",
        stroke: "background",
        strokeWidth: 2,
      });
      b.text("name", "Jamie Lee", 58, 7, 212, 14, medium);
      b.text("email", "jamie@northline.studio", 58, 29, 212, 13, muted);
    },
  },
  {
    id: "shadcn-input",
    name: "Input 输入框",
    category: forms,
    description: "单行文本输入，焦点环与错误边框。",
    width: 360,
    height: 40,
    axes: { State: ["Default", "Focus", "Error"] },
    draw(b, p) {
      const focus = p.State === "Focus",
        error = p.State === "Error";
      b.rootStyle({
        fill: "background",
        radius: 6,
        stroke: error ? "destructive" : focus ? "ring" : "border",
        strokeWidth: focus ? 2 : 1,
        shadows: subtle,
      });
      b.text("value", "Enter a value…", 12, 10, 334, 14, {
        ...muted,
        lineHeight: 20,
      });
      b.control("input", "");
    },
  },
  {
    id: "shadcn-select",
    name: "Select 选择器",
    category: forms,
    description: "带当前值的触发器与可独立编辑的选项列表。",
    width: 240,
    height: 38,
    axes: { State: ["Default", "Open"] },
    draw(b, p) {
      const open = p.State === "Open";
      b.rootStyle({ height: open ? 158 : 38, fillOpacity: 0 });
      b.frame("trigger", 0, 0, 240, 38, {
        ...panel,
        radius: 6,
        shadows: subtle,
      });
      b.text("value", "Editor", 12, 9, 182, 14, body, "trigger");
      b.lucideIcon(
        "chevron",
        "chevrons-up-down",
        211,
        11,
        16,
        "mutedForeground",
        1.75,
        "trigger",
      );
      if (open) {
        b.frame("menu", 0, 44, 240, 114, floating);
        ["Owner", "Editor", "Viewer"].forEach((v, i) => {
          const y = 5 + i * 34;
          if (i === 1)
            b.box(
              "highlight",
              4,
              y,
              232,
              32,
              { fill: "secondary", radius: 4 },
              "menu",
            );
          b.text("option-" + i, v, 12, y + 6, 180, 14, body, "menu");
          if (i === 1)
            b.lucideIcon(
              "check",
              "check",
              210,
              y + 8,
              16,
              "foreground",
              2,
              "menu",
            );
        });
      }
    },
  },
  {
    id: "shadcn-switch",
    name: "Switch 开关",
    category: forms,
    description: "紧凑轨道与圆形拇指，保留开关语义。",
    width: 42,
    height: 24,
    axes: { Value: ["On", "Off"] },
    draw(b, p) {
      const on = p.Value === "On";
      b.rootStyle({
        radius: 12,
        fill: on ? "primary" : "secondary",
        stroke: "border",
        strokeWidth: on ? 0 : 1,
      });
      b.pill("thumb", on ? 21 : 3, 3, 18, 18, {
        fill: on ? "primaryForeground" : "background",
        shadows: subtle,
      });
      b.control("switch", on);
    },
  },
  {
    id: "shadcn-checkbox",
    name: "Checkbox 复选框",
    category: forms,
    description: "可切换的方框、勾选图标与主色填充。",
    width: 24,
    height: 24,
    axes: { Value: ["Checked", "Unchecked"] },
    draw(b, p) {
      const on = p.Value === "Checked";
      b.rootStyle({
        radius: 4,
        fill: on ? "primary" : "background",
        stroke: "primary",
        strokeWidth: 1,
        shadows: subtle,
      });
      if (on)
        b.lucideIcon("check", "check", 4, 4, 16, "primaryForeground", 2.25);
      b.control("checkbox", on);
    },
  },
  {
    id: "shadcn-tabs",
    name: "Tabs 选项卡",
    category: nav,
    description: "浅色轨道上的活动选项卡，附原生分段语义。",
    width: 332,
    height: 36,
    axes: { Active: ["Account", "Password", "Billing"] },
    draw(b, p) {
      const labels = ["Account", "Password", "Billing"],
        index = labels.indexOf(p.Active),
        width = 108;
      b.rootStyle({ fill: "muted", radius: 7 });
      b.box("active", 4 + index * width, 4, width, 28, {
        fill: "background",
        radius: 5,
        shadows: subtle,
      });
      labels.forEach((title, i) =>
        b.text("label-" + i, title, 4 + i * width, 8, width, 13, {
          lineHeight: 20,
          textAlign: "center",
          fontWeight: 500,
          color: i === index ? "foreground" : "mutedForeground",
        }),
      );
      b.control("segmented", index, false, labels);
    },
  },
  {
    id: "shadcn-sidebar",
    name: "Sidebar 侧栏导航",
    category: nav,
    description: "工作区切换区、当前目的地与固定账户栏。",
    width: 240,
    height: 900,
    axes: { Active: ["Overview", "Projects", "Team", "Settings"] },
    draw(b, p) {
      b.rootStyle({ fill: "background" });
      b.box("edge", 239, 0, 1, 900, { fill: "border" });
      tileIcon(b, "workspace-icon", "layers", 18, 18, 34, true);
      b.text("workspace", "Northline", 62, 16, 134, 15, {
        ...medium,
        fontWeight: 600,
      });
      b.text("edition", "Studio workspace", 62, 37, 148, 12, muted);
      b.lucideIcon(
        "switcher",
        "chevrons-up-down",
        204,
        27,
        15,
        "mutedForeground",
      );
      b.divider("header-line", 0, 70, 239, "border");
      b.text("section", "Workspace", 22, 98, 188, 12, {
        ...muted,
        fontWeight: 500,
      });
      const icons = ["layout-dashboard", "folder", "users", "settings"];
      ["Overview", "Projects", "Team", "Settings"].forEach((title, i) => {
        const y = 128 + i * 40,
          on = title === p.Active;
        if (on)
          b.box("active", 12, y, 216, 36, { fill: "secondary", radius: 6 });
        b.lucideIcon(
          "icon-" + i,
          icons[i],
          23,
          y + 10,
          16,
          on ? "foreground" : "mutedForeground",
        );
        b.text("nav-" + i, title, 50, y + 8, 161, 14, {
          ...body,
          fontWeight: on ? 600 : 400,
        });
      });
      b.text("resources", "Resources", 22, 320, 188, 12, {
        ...muted,
        fontWeight: 500,
      });
      b.lucideIcon("book", "book-open", 23, 361, 16, "mutedForeground");
      b.text("docs", "Documentation", 50, 358, 161, 14, body);
      b.lucideIcon(
        "external",
        "arrow-up-right",
        200,
        362,
        14,
        "mutedForeground",
      );
      b.divider("footer-line", 0, 824, 239, "border");
      b.pill("avatar", 18, 847, 34, 34, { fill: "secondary" });
      b.text("initials", "JL", 18, 854, 34, 12, {
        ...medium,
        textAlign: "center",
        color: "secondaryForeground",
      });
      b.text("name", "Jamie Lee", 62, 844, 158, 13, medium);
      b.text("role", "Workspace owner", 62, 864, 158, 12, muted);
    },
  },
  {
    id: "shadcn-command",
    name: "Command 命令面板",
    category: nav,
    description: "命令搜索、分组结果、快捷键与筛选结果。",
    width: 384,
    height: 214,
    axes: { State: ["Default", "Filtered"] },
    draw(b, p) {
      const filtered = p.State === "Filtered";
      b.rootStyle({ ...floating, height: filtered ? 142 : 214 });
      b.lucideIcon("search", "search", 14, 14, 18, "mutedForeground");
      b.text(
        "query",
        filtered ? "project" : "Type a command or search…",
        44,
        12,
        280,
        14,
        filtered ? body : muted,
      );
      b.box("esc-key", 332, 13, 38, 20, { fill: "secondary", radius: 4 });
      b.text("esc", "esc", 332, 14, 38, 12, { ...muted, textAlign: "center" });
      b.divider("search-rule", 0, 44, 384, "border");
      b.text(
        "group",
        filtered ? "Projects" : "Suggestions",
        14,
        57,
        310,
        12,
        muted,
      );
      const items = filtered
        ? [["folder", "Open projects", "⌘ P"]]
        : [
            ["layout-dashboard", "Go to overview", "⌘ 1"],
            ["folder", "Open projects", "⌘ P"],
            ["settings", "Workspace settings", "⌘ ,"],
          ];
      items.forEach(([icon, title, shortcut], i) => {
        const y = 84 + 36 * i;
        if (i === 0)
          b.box("active", 6, y, 372, 34, { fill: "secondary", radius: 5 });
        b.lucideIcon("icon-" + i, icon, 16, y + 9, 16, "foreground");
        b.text("option-" + i, title, 44, y + 7, 236, 14, body);
        b.text("shortcut-" + i, shortcut, 304, y + 8, 58, 12, {
          ...muted,
          textAlign: "right",
        });
      });
    },
  },
  {
    id: "shadcn-dropdown",
    name: "Dropdown Menu 下拉菜单",
    category: nav,
    description: "带分组标题、快捷键与危险操作的菜单。",
    width: 232,
    height: 188,
    axes: { State: ["Open"] },
    draw(b) {
      b.rootStyle(floating);
      b.text("title", "Project actions", 12, 10, 196, 13, {
        ...medium,
        fontWeight: 600,
      });
      b.divider("rule", 4, 38, 224, "border");
      const items = [
        ["pencil", "Rename", "R"],
        ["copy", "Duplicate", "⌘ D"],
        ["external-link", "Open in new tab", "↗"],
        ["trash-2", "Delete project", ""],
      ];
      items.forEach(([icon, title, hint], i) => {
        const y = 44 + i * 34 + (i === 3 ? 3 : 0),
          color = i === 3 ? "destructive" : "foreground";
        if (i === 0)
          b.box("highlight", 4, y, 224, 32, { fill: "secondary", radius: 4 });
        if (i === 3) b.divider("danger-rule", 4, y - 3, 224, "border");
        b.lucideIcon("icon-" + i, icon, 12, y + 8, 16, color);
        b.text("action-" + i, title, 38, y + 6, 147, 13, { ...medium, color });
        if (hint)
          b.text("hint-" + i, hint, 181, y + 7, 38, 12, {
            ...muted,
            textAlign: "right",
          });
      });
    },
  },
  {
    id: "shadcn-dialog",
    name: "Dialog 弹窗",
    category: nav,
    description: "表单弹窗或删除确认，附分层操作按钮。",
    width: 416,
    height: 236,
    axes: { Variant: ["Form", "Confirm"] },
    draw(b, p) {
      const form = p.Variant === "Form",
        height = form ? 236 : 192;
      b.rootStyle({ ...floating, height });
      b.text(
        "title",
        form ? "Rename project" : "Delete this project?",
        24,
        21,
        340,
        20,
        { ...medium, lineHeight: 28, fontWeight: 600, letterSpacing: -0.5 },
      );
      b.lucideIcon("close", "x", 376, 24, 16, "mutedForeground");
      b.text(
        "description",
        form
          ? "Choose a name your team can recognize."
          : "This will permanently remove the project and its files.",
        24,
        57,
        360,
        14,
        { ...muted, height: 40, lineHeight: 20 },
      );
      if (form) {
        b.text("field-label", "Project name", 24, 92, 350, 13, medium);
        b.frame("field", 24, 118, 368, 36, { ...panel, radius: 6 });
        b.text("value", "Field notes", 12, 8, 340, 14, body, "field");
      }
      b.frame("cancel", 166, height - 60, 96, 36, { ...panel, radius: 6 });
      b.text(
        "cancel-label",
        "Cancel",
        0,
        8,
        96,
        14,
        { ...medium, textAlign: "center" },
        "cancel",
      );
      b.frame("confirm", 272, height - 60, 120, 36, {
        radius: 6,
        fill: form ? "primary" : "destructive",
      });
      b.text(
        "confirm-label",
        form ? "Save changes" : "Delete project",
        0,
        8,
        120,
        14,
        {
          ...medium,
          textAlign: "center",
          color: form ? "primaryForeground" : "destructiveForeground",
        },
        "confirm",
      );
    },
  },
  {
    id: "shadcn-toast",
    name: "Toast 通知",
    category: nav,
    description: "带状态图标、标题、详情与关闭按钮的浮动消息。",
    width: 364,
    height: 82,
    axes: { Variant: ["Default", "Success", "Destructive"] },
    draw(b, p) {
      const success = p.Variant === "Success",
        error = p.Variant === "Destructive";
      b.rootStyle({ ...floating, stroke: error ? "destructive" : "border" });
      b.lucideIcon(
        "status",
        error ? "alert-circle" : success ? "check-circle-2" : "info",
        16,
        18,
        18,
        error ? "destructive" : success ? "success" : "foreground",
      );
      b.text(
        "title",
        error
          ? "Changes weren’t saved"
          : success
            ? "Invitation sent"
            : "Settings updated",
        46,
        15,
        272,
        14,
        { ...medium, fontWeight: 600 },
      );
      b.text(
        "description",
        error
          ? "Check your connection and try again."
          : success
            ? "Your teammate will receive an email."
            : "Your preferences have been saved.",
        46,
        42,
        293,
        13,
        muted,
      );
      b.lucideIcon("close", "x", 334, 16, 14, "mutedForeground");
    },
  },
  {
    id: "shadcn-card",
    name: "Card 卡片",
    category: data,
    description: "内容摘要、指标趋势及带权益清单的定价卡片。",
    width: 348,
    height: 194,
    axes: { Variant: ["Standard", "Metric", "Pricing"] },
    draw(b, p) {
      const pricing = p.Variant === "Pricing",
        metric = p.Variant === "Metric",
        height = pricing ? 278 : metric ? 170 : 194;
      b.rootStyle({ ...panel, height, shadows: subtle });
      if (pricing) {
        b.text("title", "Studio", 24, 21, 292, 18, {
          ...medium,
          lineHeight: 24,
          fontWeight: 600,
        });
        b.text("description", "For growing teams.", 24, 54, 302, 14, muted);
        b.text("price", "$24", 24, 87, 118, 36, {
          ...body,
          lineHeight: 42,
          fontWeight: 700,
          letterSpacing: -1.5,
        });
        b.text("period", "/ seat / month", 144, 104, 180, 13, muted);
        ["Unlimited projects", "Shared component libraries"].forEach((v, i) => {
          b.lucideIcon(
            "check-" + i,
            "check",
            24,
            154 + 26 * i,
            16,
            "foreground",
            2,
          );
          b.text("feature-" + i, v, 50, 151 + 26 * i, 272, 13, body);
        });
        b.frame("cta", 24, 218, 300, 38, { fill: "primary", radius: 6 });
        b.text(
          "action",
          "Choose Studio",
          0,
          9,
          300,
          14,
          { ...medium, textAlign: "center", color: "primaryForeground" },
          "cta",
        );
      } else if (metric) {
        b.text("title", "Active members", 22, 19, 260, 14, medium);
        b.lucideIcon("icon", "users", 304, 21, 18, "mutedForeground");
        b.text("value", "128", 22, 54, 288, 36, {
          ...body,
          lineHeight: 42,
          fontWeight: 700,
          letterSpacing: -1.2,
        });
        b.lucideIcon("trend", "trending-up", 22, 118, 16, "success");
        b.text("delta", "+12 this month", 48, 116, 272, 13, muted);
      } else {
        tileIcon(b, "icon", "folder", 22, 20, 36);
        b.text("title", "Field notes", 22, 70, 306, 20, {
          ...body,
          fontWeight: 600,
          lineHeight: 28,
          letterSpacing: -0.4,
        });
        b.text(
          "description",
          "A shared project for the studio team.",
          22,
          106,
          306,
          14,
          muted,
        );
        b.divider("divider", 22, 140, 304, "border");
        b.text("footer", "Updated yesterday", 22, 155, 264, 12, muted);
        b.lucideIcon("arrow", "arrow-up-right", 306, 154, 18, "foreground");
      }
    },
  },
  {
    id: "shadcn-alert",
    name: "Alert 提示条",
    category: data,
    description: "内联说明与破坏性操作提示。",
    width: 396,
    height: 92,
    axes: { Variant: ["Default", "Destructive"] },
    draw(b, p) {
      const error = p.Variant === "Destructive",
        color = error ? "destructive" : "foreground";
      b.rootStyle({ ...panel, stroke: error ? "destructive" : "border" });
      b.lucideIcon(
        "icon",
        error ? "triangle-alert" : "info",
        16,
        19,
        18,
        color,
      );
      b.text(
        "title",
        error ? "Payment required" : "Billing contact",
        46,
        16,
        330,
        14,
        { ...medium, color, fontWeight: 600 },
      );
      b.text(
        "description",
        error
          ? "Update your payment method to keep your workspace active."
          : "Invoices are emailed to the workspace owner.",
        46,
        43,
        326,
        13,
        {
          ...muted,
          color: error ? "destructive" : "mutedForeground",
          height: 36,
        },
      );
    },
  },
  {
    id: "shadcn-data-card",
    name: "Table Card 数据表卡",
    category: data,
    description: "账单表格，包含金额、状态及两种行密度。",
    width: 640,
    height: 244,
    axes: { Density: ["Default", "Compact"] },
    draw(b, p) {
      const row = p.Density === "Compact" ? 36 : 46;
      b.rootStyle({
        ...panel,
        height: 94 + row * 3 + 8,
        shadows: subtle,
        clipContent: true,
      });
      b.text("title", "Recent invoices", 20, 16, 420, 18, {
        ...body,
        lineHeight: 24,
        fontWeight: 600,
      });
      b.frame("header", 1, 58, 638, 36, { fill: "muted" });
      const cols = [20, 188, 370, 532];
      ["Invoice", "Issued", "Status", "Amount"].forEach((v, i) =>
        b.text(
          "heading-" + i,
          v,
          cols[i],
          9,
          i === 3 ? 86 : 144,
          12,
          { ...muted, fontWeight: 500, textAlign: i === 3 ? "right" : "left" },
          "header",
        ),
      );
      const records = [
        ["INV-1043", "Nov 01, 2026", "Paid", "$96.00"],
        ["INV-1042", "Oct 01, 2026", "Paid", "$96.00"],
        ["INV-1041", "Sep 01, 2026", "Paid", "$72.00"],
      ];
      records.forEach(([invoice, date, status, amount], i) => {
        const key = "row-" + i;
        b.frame(
          key,
          1,
          94 + row * i,
          638,
          row,
          { fill: "card" },
          "root",
          invoice,
        );
        if (i) b.divider("line-" + i, 0, 0, 638, "border", key);
        const y = (row - 20) / 2;
        b.text("invoice-" + i, invoice, cols[0], y, 146, 13, medium, key);
        b.text("date-" + i, date, cols[1], y, 174, 13, body, key);
        b.pill("dot-" + i, cols[2], y + 7, 6, 6, { fill: "success" }, key);
        b.text("status-" + i, status, cols[2] + 14, y, 110, 13, body, key);
        b.text(
          "amount-" + i,
          amount,
          cols[3],
          y,
          86,
          13,
          { ...medium, textAlign: "right" },
          key,
        );
      });
    },
  },
];
export const shadcnLibrary: ComponentLibrary = parseLibrary({
  format: "forma/library",
  version: 1,
  id: SHADCN_LIBRARY_ID,
  revision: 1,
  name: "shadcn/ui",
  description: "用于现代 Web 工作区的原生 Zinc 双主题组件、表单及数据展示。",
  source: {
    name: "Forma 原生设计系统（参考 shadcn/ui & Radix 风格）",
    license:
      "Forma 自研原生组件与 ISC Lucide 矢量图标；适合现代 Web 与 SaaS 界面交付。",
  },
  designSystem: createAppearanceSystem(
    collectionId,
    "shadcn Appearance",
    "shadcn",
    idPrefix,
    shadcnThemes.Light,
    shadcnThemes.Dark,
  ),
  components: kitComponents(
    definitions,
    shadcnThemes,
    collectionId,
    idPrefix,
    defaults,
  ),
});
export const shadcnTemplates: readonly KitTemplateMeta[] = [
  {
    id: "shadcn-saas-settings",
    libraryId: SHADCN_LIBRARY_ID,
    name: "shadcn SaaS 设置页",
    description: "工作区侧栏、个人资料表单与邮件偏好。",
    width: 1440,
    height: 900,
    platform: "web-modern",
  },
  {
    id: "shadcn-pricing-page",
    libraryId: SHADCN_LIBRARY_ID,
    name: "shadcn 定价与工作区",
    description: "工作区方案对比、账单记录与发票联系人。",
    width: 1440,
    height: 900,
    platform: "web-modern",
  },
];
export function createShadcnTemplate(
  doc: DesignDocument,
  templateId: string,
  appearance: Appearance,
  origin: Point,
): { operations: Operation[]; id: string } {
  const meta = shadcnTemplates.find((t) => t.id === templateId);
  if (!meta) throw Error("未知 shadcn 模板：" + templateId);
  const b = new KitBuilder(
    appearance,
    meta.name + " · " + appearance,
    meta.width,
    meta.height,
    defaults(appearance),
  );
  b.rootStyle({ fill: "background", clipContent: true });
  const settings = templateId === "shadcn-saas-settings";
  const placements: KitPlacement[] = [];
  if (settings) {
    placements.push({
      component: "shadcn-sidebar",
      x: 0,
      y: 0,
      props: { Active: "Settings" },
    });
    b.lucideIcon("panel", "panel-left", 271, 24, 18, "mutedForeground");
    b.text("crumb-workspace", "Workspace", 310, 22, 90, 14, muted);
    b.lucideIcon(
      "crumb-divider",
      "chevron-right",
      399,
      25,
      14,
      "mutedForeground",
    );
    b.text("crumb-page", "Settings", 426, 22, 180, 14, medium);
    b.divider("top-rule", 240, 70, 1200, "border");
    b.text("heading", "Settings", 328, 116, 880, 36, {
      ...body,
      fontWeight: 700,
      lineHeight: 42,
      letterSpacing: -1.3,
    });
    b.text(
      "subheading",
      "Manage your account and workspace preferences.",
      328,
      172,
      880,
      16,
      { ...muted, lineHeight: 24 },
    );
    placements.push({ component: "shadcn-tabs", x: 328, y: 224 });
    b.divider("form-rule", 328, 290, 992, "border");
    b.text("profile", "Profile", 328, 330, 262, 20, {
      ...body,
      fontWeight: 600,
      lineHeight: 28,
    });
    b.text(
      "profile-note",
      "Your details are visible to other members of this workspace.",
      328,
      374,
      244,
      14,
      { ...muted, height: 60, lineHeight: 20 },
    );
    placements.push({ component: "shadcn-avatar-item", x: 660, y: 319 });
    b.text("name-label", "Display name", 660, 403, 350, 14, medium);
    placements.push({
      component: "shadcn-input",
      x: 660,
      y: 431,
      inputValue: "Jamie Lee",
    });
    b.text("email-label", "Email address", 660, 498, 350, 14, medium);
    placements.push({
      component: "shadcn-input",
      x: 660,
      y: 526,
      inputValue: "jamie@northline.studio",
    });
    b.divider("notifications-rule", 328, 612, 992, "border");
    b.text("notifications", "Notifications", 328, 650, 274, 20, {
      ...body,
      fontWeight: 600,
      lineHeight: 28,
    });
    b.text(
      "notifications-note",
      "Choose how we keep you up to date.",
      328,
      692,
      272,
      14,
      { ...muted, height: 42, lineHeight: 20 },
    );
    b.text("digest", "Weekly digest", 660, 652, 278, 14, medium);
    b.text(
      "digest-note",
      "A weekly summary of workspace activity.",
      660,
      682,
      388,
      13,
      muted,
    );
    placements.push(
      { component: "shadcn-switch", x: 1100, y: 652, props: { Value: "On" } },
      { component: "shadcn-button", x: 660, y: 754 },
    );
  } else {
    tileIcon(b, "brand", "layers", 64, 18, 36, true);
    b.text("workspace", "Northline Studio", 114, 24, 212, 18, {
      ...medium,
      fontWeight: 600,
      lineHeight: 24,
      letterSpacing: -0.4,
    });
    b.text("workspace-menu", "Workspace", 1184, 25, 95, 14, muted);
    b.lucideIcon(
      "menu-chevron",
      "chevron-down",
      1270,
      27,
      15,
      "mutedForeground",
    );
    b.pill("member", 1336, 18, 36, 36, { fill: "secondary" });
    b.text("initials", "JL", 1336, 26, 36, 13, {
      ...medium,
      textAlign: "center",
      color: "secondaryForeground",
    });
    b.divider("top-rule", 0, 72, 1440, "border");
    b.text("heading", "Plans & billing", 172, 110, 1080, 36, {
      ...body,
      fontWeight: 700,
      lineHeight: 42,
      letterSpacing: -1.2,
    });
    b.text(
      "subheading",
      "Choose the right plan for Northline Studio.",
      172,
      168,
      1080,
      16,
      { ...muted, lineHeight: 24 },
    );
    const plans = [
      [
        "Personal",
        "For individual projects.",
        "$0",
        "/ month",
        "3 active projects",
        "Personal component library",
        "Current plan",
      ],
      [
        "Studio",
        "For teams working together.",
        "$24",
        "/ seat / month",
        "Unlimited projects",
        "Shared component libraries",
        "Choose Studio",
      ],
      [
        "Business",
        "For connected workspaces.",
        "$48",
        "/ seat / month",
        "Unlimited workspaces",
        "SSO and audit history",
        "Choose Business",
      ],
    ];
    plans.forEach(
      ([title, description, price, period, first, second, action], i) =>
        placements.push({
          component: "shadcn-card",
          x: 172 + 374 * i,
          y: 226,
          props: { Variant: "Pricing" },
          text: {
            title,
            description,
            price,
            period,
            "feature-0": first,
            "feature-1": second,
            action,
          },
        }),
    );
    b.divider("invoice-rule", 172, 548, 1096, "border");
    placements.push(
      { component: "shadcn-data-card", x: 172, y: 588 },
      { component: "shadcn-alert", x: 854, y: 588 },
    );
    b.text("contact-label", "Invoice recipient", 854, 712, 392, 14, medium);
    b.text("contact", "finance@northline.studio", 854, 741, 392, 14, muted);
  }
  return assembleKitTemplate(doc, shadcnLibrary, b, origin, placements);
}
