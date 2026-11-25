import { iconToFormaVector } from "../agent/icon-library";
import type { Operation } from "../domain/commands";
import {
  emptyDesignSystem,
  type DesignSystem,
} from "../domain/design-system-schema";
import {
  defaultStyle,
  type DesignDocument,
  type DesignNode,
  type NodeStyle,
} from "../domain/document";
import type { Point } from "../domain/geometry";
import { installLibrary, instantiateComponent } from "../domain/library";
import {
  integrateLibrarySystem,
  remapLibraryDesignSystem,
} from "../domain/library-design-system";
import {
  parseLibrary,
  type ComponentLibrary,
  type LibraryComponent,
} from "../domain/library-schema";

export const ANTD5_LIBRARY_ID = "forma-antd5-v1";
const collectionId = "antd5-appearance";
export const antd5Themes = {
  Light: {
    colorPrimary: "#1677ff",
    colorPrimaryBg: "#e6f4ff",
    colorSuccess: "#52c41a",
    colorSuccessBg: "#f6ffed",
    colorWarning: "#faad14",
    colorWarningBg: "#fffbe6",
    colorError: "#ff4d4f",
    colorErrorBg: "#fff2f0",
    colorBgBase: "#ffffff",
    colorBgLayout: "#f5f5f5",
    colorBgElevated: "#ffffff",
    colorFillTertiary: "#f0f0f0",
    colorText: "#141414",
    colorTextSecondary: "#595959",
    colorTextTertiary: "#8c8c8c",
    colorBorder: "#d9d9d9",
    colorSplit: "#f0f0f0",
  },
  Dark: {
    colorPrimary: "#1668dc",
    colorPrimaryBg: "#111a2c",
    colorSuccess: "#49aa19",
    colorSuccessBg: "#162312",
    colorWarning: "#d89614",
    colorWarningBg: "#2b2111",
    colorError: "#d32029",
    colorErrorBg: "#2a1215",
    colorBgBase: "#141414",
    colorBgLayout: "#000000",
    colorBgElevated: "#1f1f1f",
    colorFillTertiary: "#262626",
    colorText: "#e6e6e6",
    colorTextSecondary: "#a6a6a6",
    colorTextTertiary: "#737373",
    colorBorder: "#424242",
    colorSplit: "#303030",
  },
} as const;
type Appearance = keyof typeof antd5Themes;
type Role = keyof typeof antd5Themes.Light;
type Paint = Role | "#ffffff" | "#000000";
const appearances = ["Light", "Dark"] as const;
const roles = Object.keys(antd5Themes.Light) as Role[];
const variableId = (role: Role) => `antd5-color-${role}`;

export const antd5Tokens: Record<string, { name: string; value: string }> =
  Object.fromEntries(
    appearances.flatMap((mode) =>
      roles.map((role) => [
        `antd5-${mode.toLowerCase()}-${role}`,
        { name: `AntD5/${mode}/${role}`, value: antd5Themes[mode][role] },
      ]),
    ),
  );

export const antd5Typography = [
  { name: "Heading 1", size: 38, lineHeight: 46, weight: 600 },
  { name: "Heading 2", size: 30, lineHeight: 38, weight: 600 },
  { name: "Heading 3", size: 24, lineHeight: 32, weight: 600 },
  { name: "Heading 4", size: 20, lineHeight: 28, weight: 600 },
  { name: "Heading 5", size: 16, lineHeight: 24, weight: 600 },
  { name: "Body", size: 14, lineHeight: 22, weight: 400 },
  { name: "Caption", size: 12, lineHeight: 20, weight: 400 },
] as const;
export const antd5Spacing = [
  { name: "Radius SM", value: "4px", kind: "radius" },
  { name: "Radius Base", value: "6px", kind: "radius" },
  { name: "Radius LG", value: "8px", kind: "radius" },
  { name: "Control SM", value: "24px", kind: "spacing" },
  { name: "Control Base", value: "32px", kind: "spacing" },
  { name: "Control LG", value: "40px", kind: "spacing" },
] as const;

export function antd5AppearanceSystem(): DesignSystem {
  const system = emptyDesignSystem();
  system.collections[collectionId] = {
    id: collectionId,
    name: "AntD5 Appearance",
    defaultModeId: "light",
    modes: appearances.map((name) => ({ id: name.toLowerCase(), name })),
  };
  for (const role of roles) {
    const id = variableId(role);
    system.variables[id] = {
      id,
      collectionId,
      name: "AntD5/" + role,
      type: "color",
      description: "",
      codeSyntax: "--" + id,
      scopes: ["fill", "color", "stroke"],
      values: { light: antd5Themes.Light[role], dark: antd5Themes.Dark[role] },
    };
  }
  return system;
}

type LayerStyle = Omit<Partial<NodeStyle>, "fill" | "color" | "stroke"> & {
  fill?: Paint;
  color?: Paint;
  stroke?: Paint;
};
const surface = {
  fill: "colorBgBase",
  stroke: "colorBorder",
  radius: 6,
} as const;
const card = { fill: "colorBgBase", stroke: "colorSplit", radius: 8 } as const;
const popup = {
  fill: "colorBgElevated",
  radius: 8,
  shadows: [
    {
      x: 0,
      y: 6,
      blur: 16,
      spread: 0,
      color: "#000000",
      opacity: 0.12,
      inset: false,
    },
    {
      x: 0,
      y: 2,
      blur: 5,
      spread: 0,
      color: "#000000",
      opacity: 0.08,
      inset: false,
    },
  ],
} satisfies LayerStyle;
const centered = { textAlign: "center" } as const;
const caption = { fontSize: 12, lineHeight: 20 } as const;

class AntdBuilder {
  readonly nodes: DesignNode[] = [];
  readonly root: DesignNode;
  constructor(
    readonly appearance: Appearance,
    width: number,
    height: number,
    style: LayerStyle = {},
    type: "frame" | "button" = "frame",
  ) {
    this.root = this.add("root", type, null, { width, height, ...style });
    this.root.variableModes = { [collectionId]: appearance.toLowerCase() };
  }
  private add(
    key: string,
    type: DesignNode["type"],
    parentId: string | null,
    style: LayerStyle,
    text = "",
  ) {
    const { fill, color = "colorText", stroke, ...layout } = style;
    const node: DesignNode = {
      id: key,
      templateKey: key,
      name: text || key,
      type,
      parentId,
      text,
      hidden: false,
      locked: false,
      style: {
        ...defaultStyle,
        radius: 0,
        padding: 0,
        gap: 0,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        fontSize: 14,
        lineHeight: 22,
        fill: this.palette.colorBgBase,
        fillOpacity: fill ? 1 : 0,
        ...(stroke ? { strokeWidth: 1 } : {}),
        ...layout,
      },
    };
    // Record the role at authoring time: e.g. elevated and base both resolve to white in Light.
    for (const [property, paint] of Object.entries({ fill, color, stroke })) {
      if (!paint) continue;
      const prop = property as "fill" | "color" | "stroke";
      if (paint === "#ffffff" || paint === "#000000") node.style[prop] = paint;
      else {
        node.style[prop] = this.palette[paint];
        (node.variableBindings ??= {})[prop] = variableId(paint);
      }
    }
    this.nodes.push(node);
    return node;
  }
  get palette() {
    return antd5Themes[this.appearance];
  }
  box(
    key: string,
    x: number,
    y: number,
    width: number,
    height: number,
    style: LayerStyle,
  ) {
    return this.add(key, "rectangle", "root", {
      x,
      y,
      width,
      height,
      ...style,
    });
  }
  text(
    key: string,
    text: string,
    x: number,
    y: number,
    width: number,
    style: LayerStyle = {},
  ) {
    return this.add(
      key,
      "text",
      "root",
      { x, y, width, height: style.lineHeight ?? 22, ...style },
      text,
    );
  }
  icon(
    key: string,
    name: string,
    x: number,
    y: number,
    size: number,
    color: Paint = "colorTextSecondary",
  ) {
    const n = this.add(key, "vector", "root", {
      x,
      y,
      width: size,
      height: size,
      color,
    });
    n.name = name;
    n.vector = iconToFormaVector(name) ?? {
      width: 24,
      height: 24,
      paths: [{ d: "M12 3L21 12L12 21L3 12Z", fill: false, strokeWidth: 1.75 }],
    };
    // Lucide's monochrome paths inherit the bound layer color in both renderers.
    for (const path of n.vector.paths) {
      delete path.strokeColor;
      delete path.fillColor;
    }
  }
  rule(key: string, x: number, y: number, width: number) {
    this.box(key, x, y, width, 1, { fill: "colorSplit" });
  }
  control(
    kind: "button" | "input" | "switch" | "checkbox" | "segmented",
    label: string,
    value: boolean | number | string,
    disabled = false,
    options?: string[],
  ) {
    this.root.control = {
      kind: kind === "input" ? "textfield" : kind,
      label,
      value,
      disabled,
      palette: {
        accent: this.palette.colorPrimary,
        track:
          kind === "switch"
            ? this.palette.colorTextTertiary
            : this.palette.colorBgBase,
        surface: this.palette.colorBgBase,
        border: this.palette.colorBorder,
      },
      ...(options ? { options } : {}),
    };
  }
}

type Props = Record<string, string>;
type Axes = Record<string, readonly string[]>;
function define(
  id: string,
  name: string,
  category: string,
  description: string,
  axes: Axes,
  build: (appearance: Appearance, props: Props) => AntdBuilder,
): LibraryComponent {
  const choices = Object.entries(axes).reduce<Props[]>(
    (previous, [axis, values]) =>
      previous.flatMap((p) => values.map((value) => ({ ...p, [axis]: value }))),
    [{}],
  );
  return {
    id: "antd-" + id,
    name,
    category,
    description,
    variants: appearances.flatMap((Appearance) =>
      choices.map((props) => {
        const properties = { Appearance, ...props };
        const values = Object.values(properties);
        const b = build(Appearance, props);
        b.root.name = name;
        return {
          id: values.join("-"),
          name: values.join(" / "),
          properties,
          nodes: b.nodes,
        };
      }),
    ),
  };
}

const tones = {
  blue: { ink: "colorPrimary", bg: "colorPrimaryBg" },
  green: { ink: "colorSuccess", bg: "colorSuccessBg" },
  gold: { ink: "colorWarning", bg: "colorWarningBg" },
  red: { ink: "colorError", bg: "colorErrorBg" },
  neutral: { ink: "colorTextSecondary", bg: "colorFillTertiary" },
} as const;
type Tone = keyof typeof tones;
function tagLayers(
  b: AntdBuilder,
  key: string,
  label: string,
  x: number,
  y: number,
  width: number,
  tone: Tone,
) {
  const { ink, bg } = tones[tone];
  b.box(key + "-surface", x, y, width, 22, {
    fill: bg,
    radius: 4,
    stroke: tone === "neutral" ? "colorBorder" : ink,
    strokeOpacity: 0.46,
  });
  // Ant's status dot carries the hue; keep the label legible on pale backgrounds.
  b.box(key + "-dot", x + 8, y + 8, 6, 6, { fill: ink, radius: 3 });
  b.text(key + "-text", label, x + 20, y + 1, width - 24, {
    ...caption,
    color: "colorText",
  });
}
const sizes = { Small: 24, Middle: 32, Default: 32, Large: 40 } as const;
const tabs = ["First", "Second", "Third"];
const menuItems = [
  { key: "Dashboard", label: "工作台", icon: "layout-dashboard" },
  { key: "Users", label: "客户管理", icon: "users" },
  { key: "Orders", label: "订单管理", icon: "receipt-text" },
  { key: "Settings", label: "系统设置", icon: "settings" },
];
const general = "通用与操作",
  entry = "数据录入",
  nav = "导航",
  data = "数据展示",
  feedback = "反馈";

const components: LibraryComponent[] = [
  define(
    "button",
    "按钮 Button",
    general,
    "三种控件高度的主操作、次操作、虚线、文字与危险按钮。",
    {
      Type: ["Primary", "Default", "Dashed", "Text", "Danger"],
      Size: ["Small", "Middle", "Large"],
    },
    (a, p) => {
      const height = sizes[p.Size as keyof typeof sizes];
      const primary = p.Type === "Primary",
        plain = p.Type === "Text",
        danger = p.Type === "Danger";
      const b = new AntdBuilder(
        a,
        height + 60,
        height,
        {
          ...(plain ? {} : { fill: primary ? "colorPrimary" : "colorBgBase" }),
          ...(!primary && !plain
            ? { stroke: danger ? "colorError" : "colorBorder" }
            : {}),
          ...(p.Type === "Dashed"
            ? { strokeStyle: "dashed", strokeDash: "4 3" }
            : {}),
          color: primary ? "#ffffff" : danger ? "colorError" : "colorText",
          radius: height === 24 ? 4 : height === 40 ? 8 : 6,
          fontSize: height === 40 ? 16 : 14,
        },
        "button",
      );
      b.root.text = danger ? "删除" : "确定";
      b.control("button", b.root.text, "");
      return b;
    },
  ),
  define(
    "tag",
    "标签 Tag",
    general,
    "按业务语义区分的紧凑描边标签。",
    { Color: ["Blue", "Green", "Gold", "Red", "Default"] },
    (a, p) => {
      const tags = {
        Blue: ["blue", "进行中"],
        Green: ["green", "已完成"],
        Gold: ["gold", "待审核"],
        Red: ["red", "异常"],
        Default: ["neutral", "未分类"],
      } as const;
      const [tone, label] = tags[p.Color as keyof typeof tags];
      const { ink, bg } = tones[tone];
      const b = new AntdBuilder(a, 60, 22, {
        fill: bg,
        stroke: tone === "neutral" ? "colorBorder" : ink,
        strokeOpacity: 0.52,
        radius: 4,
      });
      b.text("label", label, 3, 1, 54, {
        ...caption,
        ...centered,
        color: tone === "blue" ? "colorPrimary" : "colorText",
      });
      return b;
    },
  ),
  define(
    "badge",
    "状态徽标 Badge",
    general,
    "状态圆点与业务状态文字。",
    { Status: ["Processing", "Success", "Warning", "Error"] },
    (a, p) => {
      const states = {
        Processing: ["blue", "处理中"],
        Success: ["green", "已完成"],
        Warning: ["gold", "待审核"],
        Error: ["red", "有异常"],
      } as const;
      const [tone, label] = states[p.Status as keyof typeof states];
      const b = new AntdBuilder(a, 80, 22);
      if (p.Status === "Processing")
        b.box("pulse", 0, 5, 12, 12, {
          radius: 6,
          stroke: "colorPrimary",
          strokeOpacity: 0.32,
        });
      b.box("dot", 3, 8, 6, 6, { fill: tones[tone].ink, radius: 3 });
      b.text("label", label, 18, 0, 62);
      return b;
    },
  ),
  define(
    "avatar",
    "头像 Avatar",
    general,
    "三个常用尺寸的圆形姓名头像。",
    { Size: ["Small", "Default", "Large"] },
    (a, p) => {
      const size = sizes[p.Size as keyof typeof sizes];
      const b = new AntdBuilder(a, size, size, {
        fill: "colorPrimaryBg",
        radius: size / 2,
      });
      b.text("initial", "林", 0, 0, size, {
        ...centered,
        color: "colorPrimary",
        fontWeight: 600,
        fontSize: size === 24 ? 12 : 16,
        lineHeight: size,
      });
      return b;
    },
  ),
  define(
    "input",
    "输入框 Input",
    entry,
    "支持焦点、错误与禁用状态的文本输入框。",
    {
      State: ["Default", "Focus", "Error", "Disabled"],
      Size: ["Middle", "Large"],
    },
    (a, p) => {
      const h = p.Size === "Large" ? 40 : 32,
        disabled = p.State === "Disabled";
      const b = new AntdBuilder(a, 240, h, {
        ...surface,
        radius: h === 40 ? 8 : 6,
        fill: disabled ? "colorFillTertiary" : "colorBgBase",
        stroke:
          p.State === "Error"
            ? "colorError"
            : p.State === "Focus"
              ? "colorPrimary"
              : "colorBorder",
        ...(p.State === "Focus"
          ? {
              shadows: [
                {
                  x: 0,
                  y: 0,
                  blur: 0,
                  spread: 2,
                  color: antd5Themes[a].colorPrimary,
                  opacity: 0.14,
                  inset: false,
                },
              ],
            }
          : {}),
      });
      b.text("value", "请输入关键词", 12, (h - 22) / 2, 216, {
        color: "colorTextTertiary",
        fontSize: h === 40 ? 16 : 14,
      });
      b.control("input", "关键词", "", disabled);
      return b;
    },
  ),
  define(
    "select",
    "选择器 Select",
    entry,
    "订单状态选择器，展开时展示可编辑的浮层和选项。",
    { State: ["Default", "Open", "Disabled"] },
    (a, p) => {
      const open = p.State === "Open",
        disabled = p.State === "Disabled";
      const b = new AntdBuilder(a, 208, open ? 144 : 32);
      b.box("field", 0, 0, 208, 32, {
        ...surface,
        fill: disabled ? "colorFillTertiary" : "colorBgBase",
        stroke: open ? "colorPrimary" : "colorBorder",
      });
      b.text("value", "全部状态", 12, 5, 166, {
        color: disabled ? "colorTextTertiary" : "colorText",
      });
      b.icon(
        "chevron",
        open ? "chevron-up" : "chevron-down",
        182,
        9,
        14,
        "colorTextTertiary",
      );
      if (open) {
        b.box("dropdown", 0, 38, 208, 106, popup);
        b.box("selected", 4, 42, 200, 32, {
          fill: "colorPrimaryBg",
          radius: 4,
        });
        ["全部状态", "待处理", "已完成"].forEach((text, i) =>
          b.text("option-" + i, text, 12, 47 + i * 32, 166, {
            fontWeight: i === 0 ? 600 : 400,
          }),
        );
        b.icon("checked", "check", 182, 51, 14, "colorPrimary");
      }
      return b;
    },
  ),
  define(
    "switch",
    "开关 Switch",
    entry,
    "带可交互开关值、滑块和禁用状态的开关。",
    { Checked: ["On", "Off"], State: ["Default", "Disabled"] },
    (a, p) => {
      const on = p.Checked === "On",
        disabled = p.State === "Disabled";
      const b = new AntdBuilder(a, 44, 22, {
        fill: on ? "colorPrimary" : "colorTextTertiary",
        radius: 11,
        opacity: disabled ? 0.45 : 1,
      });
      b.box("thumb", on ? 24 : 2, 2, 18, 18, { fill: "#ffffff", radius: 9 });
      b.control("switch", "启用通知", on, disabled);
      return b;
    },
  ),
  define(
    "checkbox",
    "多选框 Checkbox",
    entry,
    "可勾选的描边选择框。",
    { State: ["Checked", "Unchecked", "Disabled"] },
    (a, p) => {
      const on = p.State === "Checked",
        disabled = p.State === "Disabled";
      const b = new AntdBuilder(a, 24, 24, {
        ...surface,
        fill: on
          ? "colorPrimary"
          : disabled
            ? "colorFillTertiary"
            : "colorBgBase",
        stroke: on ? "colorPrimary" : "colorBorder",
        radius: 4,
      });
      if (on) b.icon("check", "check", 4, 4, 16, "#ffffff");
      b.control("checkbox", "选择订单", on, disabled);
      return b;
    },
  ),
  define(
    "radio-group",
    "单选按钮组 Radio Group",
    entry,
    "按周、月或季度查看数据。",
    { Selected: tabs },
    (a, p) => {
      const index = tabs.indexOf(p.Selected),
        labels = ["本周", "本月", "本季"];
      const b = new AntdBuilder(a, 224, 32, {
        ...surface,
        color: "colorPrimary",
      });
      [76, 148].forEach((x, i) =>
        b.box("divider-" + i, x, 1, 1, 30, { fill: "colorBorder" }),
      );
      b.box("active", 4 + index * 72, 1, 72, 30, {
        fill: "colorPrimaryBg",
        stroke: "colorPrimary",
        radius: 4,
      });
      labels.forEach((label, i) =>
        b.text("label-" + i, label, 4 + i * 72, 5, 72, {
          ...centered,
          color: i === index ? "colorPrimary" : "colorText",
        }),
      );
      b.control("segmented", "统计周期", index, false, labels);
      return b;
    },
  ),
  define(
    "form-item",
    "表单项 Form Item",
    entry,
    "含字段名称、必填标记与行内校验文案。",
    { State: ["Default", "Required", "Error"] },
    (a, p) => {
      const error = p.State === "Error",
        required = p.State !== "Default";
      const b = new AntdBuilder(a, 280, error ? 88 : 62);
      if (required) b.text("required", "*", 0, 1, 12, { color: "colorError" });
      b.text("label", "客户名称", required ? 12 : 0, 0, 220);
      b.box("field", 0, 30, 280, 32, {
        ...surface,
        stroke: error ? "colorError" : "colorBorder",
      });
      b.text("value", "请输入客户名称", 12, 35, 254, {
        color: "colorTextTertiary",
      });
      if (error)
        b.text("help", "请填写客户名称", 0, 66, 280, { color: "colorError" });
      return b;
    },
  ),
  define(
    "menu",
    "侧边菜单 Menu",
    nav,
    "四项业务导航，当前页面以品牌色底和图标标识。",
    { Active: menuItems.map((item) => item.key) },
    (a, p) => {
      const b = new AntdBuilder(a, 224, 184, { fill: "colorBgBase" });
      menuItems.forEach((item, i) => {
        const active = p.Active === item.key,
          y = 6 + i * 44;
        if (active)
          b.box("selected", 8, y, 208, 40, {
            fill: "colorPrimaryBg",
            radius: 6,
          });
        b.icon(
          "icon-" + item.key,
          item.icon,
          24,
          y + 11,
          18,
          active ? "colorPrimary" : "colorTextSecondary",
        );
        b.text("label-" + item.key, item.label, 54, y + 9, 148, {
          color: active ? "colorPrimary" : "colorText",
          fontWeight: active ? 600 : 400,
        });
      });
      return b;
    },
  ),
  define(
    "breadcrumb",
    "面包屑 Breadcrumb",
    nav,
    "两级或三级页面路径，末项显示当前位置。",
    { Depth: ["Two", "Three"] },
    (a, p) => {
      const three = p.Depth === "Three",
        b = new AntdBuilder(a, three ? 252 : 156, 22);
      b.text("home", "首页", 0, 0, 34, { color: "colorTextSecondary" });
      b.text("divider-1", "/", 42, 0, 10, { color: "colorTextTertiary" });
      if (three) {
        b.text("section", "销售管理", 64, 0, 64, {
          color: "colorTextSecondary",
        });
        b.text("divider-2", "/", 138, 0, 10, { color: "colorTextTertiary" });
      }
      b.text("current", three ? "订单管理" : "工作台", three ? 160 : 64, 0, 92);
      return b;
    },
  ),
  define(
    "tabs",
    "标签页 Tabs",
    nav,
    "线条或卡片式页签，支持两个当前项。",
    { Style: ["Line", "Card"], Active: ["First", "Second"] },
    (a, p) => {
      const b = new AntdBuilder(a, 320, 40),
        cardTabs = p.Style === "Card",
        selected = tabs.indexOf(p.Active);
      b.rule("baseline", 0, 39, 320);
      ["订单概览", "处理记录"].forEach((title, i) => {
        const x = i * 104,
          active = selected === i;
        if (cardTabs) {
          b.box("card-" + i, x, 0, 100, 40, {
            fill: active ? "colorBgBase" : "colorBgLayout",
            stroke: "colorSplit",
            radius: 6,
          });
          if (active)
            b.box("open-edge", x + 1, 38, 98, 2, { fill: "colorBgBase" });
        } else if (active)
          b.box("underline", x + 14, 38, 72, 2, { fill: "colorPrimary" });
        b.text("label-" + i, title, x, 9, 100, {
          ...centered,
          color: active ? "colorPrimary" : "colorText",
        });
      });
      return b;
    },
  ),
  define(
    "pagination",
    "分页器 Pagination",
    nav,
    "含当前页、高页码省略和上一页、下一页的标准与紧凑分页。",
    { Style: ["Default", "Compact"] },
    (a, p) => {
      const compact = p.Style === "Compact",
        size = compact ? 24 : 32,
        gap = compact ? 4 : 8;
      const pages = ["1", "2", "3", "…", "12"];
      const b = new AntdBuilder(a, 7 * size + 6 * gap, size);
      b.icon(
        "previous",
        "chevron-left",
        (size - 14) / 2,
        (size - 14) / 2,
        14,
        "colorTextTertiary",
      );
      pages.forEach((label, i) => {
        const x = (i + 1) * (size + gap);
        if (i === 0)
          b.box("current", x, 0, size, size, {
            fill: compact ? "colorPrimaryBg" : "colorBgBase",
            stroke: "colorPrimary",
            radius: compact ? 4 : 6,
          });
        b.text("page-" + i, label, x, (size - 22) / 2, size, {
          ...centered,
          color: i === 0 ? "colorPrimary" : "colorText",
          fontWeight: i === 0 ? 600 : 400,
        });
      });
      b.icon(
        "next",
        "chevron-right",
        6 * (size + gap) + (size - 14) / 2,
        (size - 14) / 2,
        14,
      );
      return b;
    },
  ),
  define(
    "steps",
    "步骤条 Steps",
    nav,
    "通过已完成、进行中与等待状态跟踪三步订单流程。",
    { Current: ["Step1", "Step2", "Step3"] },
    (a, p) => {
      const b = new AntdBuilder(a, 532, 52),
        current = Number(p.Current.slice(-1)) - 1;
      ["填写资料", "确认订单", "完成提交"].forEach((label, i) => {
        const x = i * 204,
          done = i < current,
          active = i === current;
        b.box("circle-" + i, x, 0, 32, 32, {
          fill: done
            ? "colorPrimaryBg"
            : active
              ? "colorPrimary"
              : "colorFillTertiary",
          radius: 16,
        });
        if (done) b.icon("check-" + i, "check", x + 8, 8, 16, "colorPrimary");
        else
          b.text("number-" + i, String(i + 1), x, 5, 32, {
            ...centered,
            color: active ? "#ffffff" : "colorTextSecondary",
          });
        b.text("label-" + i, label, x + 42, 5, 72, {
          fontWeight: active ? 600 : 400,
          color: i > current ? "colorTextTertiary" : "colorText",
        });
        if (i < 2)
          b.box("line-" + i, x + 118, 16, 74, 1, {
            fill: done ? "colorPrimary" : "colorSplit",
          });
      });
      return b;
    },
  ),
  define(
    "card",
    "卡片 Card",
    data,
    "标准内容卡片，标题栏可配置额外操作。",
    { Variant: ["Default", "WithExtra"] },
    (a, p) => {
      const b = new AntdBuilder(a, 360, 176, card);
      b.text("title", "客户档案", 24, 15, 216, {
        fontSize: 16,
        lineHeight: 24,
        fontWeight: 600,
      });
      if (p.Variant === "WithExtra")
        b.text("extra", "查看详情", 260, 16, 76, {
          textAlign: "right",
          color: "colorPrimary",
        });
      b.rule("head-split", 0, 55, 360);
      b.box("avatar", 24, 78, 40, 40, { fill: "colorPrimaryBg", radius: 8 });
      b.icon("company", "building", 33, 87, 22, "colorPrimary");
      b.text("customer", "澄海科技有限公司", 78, 77, 252, { fontWeight: 600 });
      b.text("account", "企业客户 · 华东区", 78, 102, 252, {
        ...caption,
        color: "colorTextSecondary",
      });
      b.text("owner", "客户经理  林悦", 24, 138, 288, {
        color: "colorTextSecondary",
      });
      return b;
    },
  ),
  define(
    "statistic",
    "统计数值 Statistic",
    data,
    "核心经营指标、环比变化与趋势图标。",
    { Trend: ["Up", "Down"] },
    (a, p) => {
      const up = p.Trend === "Up",
        ink = up ? "colorSuccess" : "colorError";
      const b = new AntdBuilder(a, 276, 148, card);
      b.text("title", "成交金额（元）", 20, 18, 196, {
        color: "colorTextSecondary",
      });
      b.text("value", "128,640.00", 20, 51, 236, {
        fontSize: 30,
        lineHeight: 38,
        fontWeight: 600,
        letterSpacing: -0.5,
      });
      b.text("period", "较上月", 20, 108, 52, {
        ...caption,
        color: "colorTextSecondary",
      });
      b.icon("trend", up ? "trending-up" : "trending-down", 79, 110, 16, ink);
      b.text("change", up ? "+12.8%" : "−3.2%", 102, 107, 150, {
        color: ink,
        ...caption,
        fontWeight: 600,
      });
      return b;
    },
  ),
  define(
    "table",
    "数据表格 Table",
    data,
    "订单号、客户、状态、金额与操作五列，支持标准和紧凑行高。",
    { Density: ["Default", "Compact"] },
    (a, p) => {
      const compact = p.Density === "Compact",
        header = compact ? 40 : 48,
        row = compact ? 44 : 62;
      const b = new AntdBuilder(a, 1104, header + 3 * row, {
        fill: "colorBgBase",
        radius: 6,
        clipContent: true,
      });
      b.box("header", 0, 0, 1104, header, { fill: "colorFillTertiary" });
      const columns = [
        { label: "订单号", x: 16, w: 240 },
        { label: "客户", x: 282, w: 222 },
        { label: "状态", x: 542, w: 146 },
        { label: "金额（元）", x: 726, w: 170 },
        { label: "操作", x: 988, w: 98 },
      ];
      columns.forEach(({ label, x, w }, i) => {
        b.text("heading-" + i, label, x, (header - 22) / 2, w, {
          fontWeight: 600,
          textAlign: i === 3 ? "right" : "left",
        });
        if (i > 0)
          b.box("column-divider-" + i, x - 16, (header - 16) / 2, 1, 16, {
            fill: "colorBorder",
          });
      });
      const rows = [
        {
          id: "SO-20261125-0186",
          date: "11 月 25 日  10:42",
          customer: "澄海科技有限公司",
          status: "已完成",
          tone: "green",
          amount: "36,800.00",
        },
        {
          id: "SO-20261125-0185",
          date: "11 月 25 日  09:36",
          customer: "南山智造集团",
          status: "处理中",
          tone: "blue",
          amount: "18,450.00",
        },
        {
          id: "SO-20261124-0184",
          date: "11 月 24 日  16:20",
          customer: "栖木商业设计",
          status: "待审核",
          tone: "gold",
          amount: "7,960.00",
        },
      ] as const;
      rows.forEach((order, i) => {
        const key = "row-" + i,
          y = header + i * row,
          mid = y + (row - 22) / 2;
        b.text(key + "-order", order.id, 16, compact ? mid : y + 8, 246, {
          fontWeight: 500,
        });
        if (!compact)
          b.text(key + "-date", order.date, 16, y + 31, 240, {
            ...caption,
            color: "colorTextTertiary",
          });
        b.text(key + "-customer", order.customer, 282, mid, 232);
        tagLayers(b, key + "-status", order.status, 542, mid, 72, order.tone);
        b.text(key + "-amount", order.amount, 726, mid, 170, {
          textAlign: "right",
        });
        b.text(key + "-action", "查看", 988, mid, 80, {
          color: "colorPrimary",
        });
        b.rule(key + "-divider", 0, y + row - 1, 1104);
      });
      return b;
    },
  ),
  define(
    "alert",
    "警告提示 Alert",
    feedback,
    "四色语义反馈，含对应图标、消息和关闭入口。",
    { Type: ["Info", "Success", "Warning", "Error"] },
    (a, p) => {
      const notices = {
        Info: ["blue", "info", "订单数据已同步。"],
        Success: ["green", "badge-check", "审核通过，订单已提交。"],
        Warning: ["gold", "triangle-alert", "请在截止时间前完成审核。"],
        Error: ["red", "circle-x", "提交失败，请检查订单信息。"],
      } as const;
      const [tone, icon, message] = notices[p.Type as keyof typeof notices],
        { ink, bg } = tones[tone];
      const b = new AntdBuilder(a, 440, 40, {
        fill: bg,
        stroke: ink,
        strokeOpacity: 0.5,
        radius: 6,
      });
      b.icon("status", icon, 12, 11, 18, ink);
      b.text("message", message, 40, 9, 350);
      b.icon("close", "x", 410, 13, 14, "colorTextTertiary");
      return b;
    },
  ),
  define(
    "modal",
    "对话框 Modal",
    feedback,
    "新建订单表单或确认提交对话框，带独立可编辑的操作区。",
    { Type: ["Form", "Confirm"] },
    (a, p) => {
      const form = p.Type === "Form",
        h = form ? 346 : 184;
      const b = new AntdBuilder(a, 520, h, popup);
      if (!form)
        b.icon("confirm-icon", "alert-circle", 24, 24, 24, "colorWarning");
      b.text(
        "title",
        form ? "新建订单" : "确认提交订单？",
        form ? 24 : 60,
        22,
        398,
        { fontSize: 18, lineHeight: 26, fontWeight: 600 },
      );
      b.icon("close", "x", 480, 24, 18, "colorTextTertiary");
      if (form) {
        [
          ["客户名称", "请输入客户全称"],
          ["订单金额（元）", "0.00"],
        ].forEach(([label, placeholder], i) => {
          const y = 74 + i * 84;
          b.text("required-" + i, "*", 24, y, 12, { color: "colorError" });
          b.text("label-" + i, label, 37, y, 410);
          b.box("field-" + i, 24, y + 28, 472, 36, { ...surface });
          b.text("value-" + i, placeholder, 36, y + 35, 444, {
            color: "colorTextTertiary",
          });
        });
        b.text("note", "新建订单将进入待审核队列。", 24, 248, 454, {
          ...caption,
          color: "colorTextSecondary",
        });
      } else
        b.text(
          "message",
          "提交后将通知审核人，请核对客户及订单金额。",
          60,
          65,
          422,
          { color: "colorTextSecondary" },
        );
      b.rule("footer-divider", 0, h - 66, 520);
      b.box("cancel-surface", 338, h - 48, 70, 32, surface);
      b.text("cancel", "取消", 338, h - 43, 70, centered);
      b.box("submit-surface", 416, h - 48, 80, 32, {
        fill: "colorPrimary",
        radius: 6,
      });
      b.text("submit", form ? "创建订单" : "确认提交", 416, h - 43, 80, {
        ...centered,
        color: "#ffffff",
      });
      return b;
    },
  ),
];

export const antd5Library: ComponentLibrary = parseLibrary({
  format: "forma/library",
  version: 1,
  revision: 1,
  id: ANTD5_LIBRARY_ID,
  name: "Ant Design 5",
  description:
    "企业级 Web 中后台设计体系。覆盖高频通用、表单录入、导航菜单、数据表格与反馈组件，支持浅色与深色语义变量。",
  source: {
    name: "Forma 原生设计系统（参考 Ant Design 5 规范）",
    license: "Forma 自研原生组件与 ISC Lucide 矢量图标；不含第三方闭源资产。",
  },
  designSystem: antd5AppearanceSystem(),
  components,
});

export const antd5Templates = [
  {
    id: "antd-admin-dashboard",
    libraryId: ANTD5_LIBRARY_ID,
    name: "AntD 中后台工作台",
    description:
      "侧边导航菜单、面包屑、4 项核心指标统计卡与数据表格分页完整中后台布局。",
    width: 1440,
    height: 900,
    platform: "web-enterprise",
  },
  {
    id: "antd-crud-list",
    libraryId: ANTD5_LIBRARY_ID,
    name: "AntD 筛选列表与表单弹窗",
    description:
      "顶部多条件检索表单、批量操作按钮、状态表格与新建表单弹窗组合页。",
    width: 1440,
    height: 900,
    platform: "web-enterprise",
  },
] as const;

// A portable snapshot may already be installed with file-local variable IDs.
// Compare its components in that namespace before creating a second library.
function templateLibrary(doc: DesignDocument) {
  const incoming = installLibrary(doc, antd5Library);
  if (incoming.id === ANTD5_LIBRARY_ID) return incoming;
  for (const installed of Object.values(doc.libraries ?? {})) {
    if (
      (installed.id !== ANTD5_LIBRARY_ID &&
        !installed.id.startsWith(ANTD5_LIBRARY_ID + "-")) ||
      installed.revision !== antd5Library.revision ||
      installed.name !== antd5Library.name
    )
      continue;
    const system = installed.designSystem;
    if (!system) continue;
    const [collection] = Object.values(system.collections);
    if (collection?.name !== "AntD5 Appearance") continue;
    const variables = new Map<string, string>();
    for (const local of Object.values(system.variables)) {
      const original =
        antd5Library.designSystem!.variables[local.codeSyntax.slice(2)];
      if (
        original &&
        local.collectionId === collection.id &&
        original.values.light === local.values.light &&
        original.values.dark === local.values.dark
      )
        variables.set(original.id, local.id);
    }
    if (variables.size !== roles.length) continue;
    const candidate = structuredClone(antd5Library);
    remapLibraryDesignSystem(candidate, {
      system,
      maps: {
        collections: new Map([[collectionId, collection.id]]),
        variables,
        styles: new Map(),
      },
    });
    if (
      JSON.stringify(candidate.components) ===
      JSON.stringify(installed.components)
    )
      return installed;
  }
  return incoming;
}

export function createAntd5Template(
  doc: DesignDocument,
  templateId: string,
  appearance: Appearance,
  origin: Point,
): { operations: Operation[]; id: string } {
  const template = antd5Templates.find((t) => t.id === templateId);
  if (!template) throw new Error("Ant Design 5 模板不存在：" + templateId);
  const dashboard = template.id === "antd-admin-dashboard";
  const b = new AntdBuilder(appearance, template.width, template.height, {
    ...origin,
    fill: "colorBgLayout",
    clipContent: true,
  });
  b.root.name = template.name + " · " + appearance;
  b.box("sidebar", 0, 0, 224, 900, { fill: "colorBgBase" });
  b.box("header", 0, 0, 1440, 64, { fill: "colorBgBase" });
  b.rule("header-rule", 0, 63, 1440);
  b.box("sidebar-rule", 223, 64, 1, 836, { fill: "colorSplit" });
  b.box("brand-mark", 20, 16, 32, 32, { fill: "colorPrimary", radius: 8 });
  b.icon("brand-icon", "layers", 26, 22, 20, "#ffffff");
  b.text("brand", "云舟商贸", 64, 18, 134, {
    fontSize: 20,
    lineHeight: 28,
    fontWeight: 600,
  });
  b.icon("collapse", "panel-left", 248, 23, 18);
  b.text("workspace", "运营中心", 282, 21, 210, {
    color: "colorTextSecondary",
  });
  b.icon("notifications", "bell", 1252, 22, 20);
  b.box("account-rule", 1292, 22, 1, 20, { fill: "colorBorder" });
  b.text("account", "林悦", 1358, 21, 48);
  b.text("menu-group", "业务导航", 24, 92, 176, {
    ...caption,
    color: "colorTextTertiary",
  });
  b.rule("org-rule", 16, 815, 192);
  b.icon("org-icon", "building", 24, 845, 20);
  b.text("org", "华东运营团队", 56, 844, 146, { color: "colorTextSecondary" });
  b.text("heading", dashboard ? "经营工作台" : "订单管理", 256, 138, 670, {
    fontSize: 30,
    lineHeight: 38,
    fontWeight: 600,
  });
  b.text(
    "period",
    dashboard ? "2026 年 11 月 · 经营概览" : "销售订单查询与审核",
    256,
    182,
    640,
    { color: "colorTextSecondary" },
  );
  if (dashboard) {
    b.box("date-range", 1175, 147, 233, 32, surface);
    b.icon("calendar", "calendar-range", 1187, 155, 16);
    b.text("range", "2026/11/01   —   2026/11/30", 1213, 152, 186, {
      ...caption,
    });
  } else {
    b.box("filters", 256, 228, 1152, 148, card);
    b.text("filter-customer", "客户 / 订单号", 280, 248, 238, {
      fontWeight: 500,
    });
    b.text("filter-status", "订单状态", 554, 248, 208, { fontWeight: 500 });
  }
  const panelY = dashboard ? 412 : 400;
  b.box("orders-panel", 256, panelY, 1152, 444, card);
  b.text(
    "table-title",
    dashboard ? "最近订单" : "订单列表",
    280,
    panelY + 22,
    360,
    { fontSize: 20, lineHeight: 28, fontWeight: 600 },
  );
  b.text("count", "共 36 条订单", 280, panelY + 382, 250, {
    color: "colorTextSecondary",
  });

  // Install once so every sibling uses the same snapshot and variable IDs, including
  // when an imported file already owns a conflicting collection or library ID.
  const { library, system } = integrateLibrarySystem(doc, templateLibrary(doc));
  const operations: Operation[] = [];
  if (system && system !== doc.designSystem)
    operations.push({ type: "setDesignSystem", system });
  if (JSON.stringify(doc.libraries?.[library.id]) !== JSON.stringify(library))
    operations.push({ type: "putLibrary", library });
  const boardId = crypto.randomUUID();
  const palette = library.designSystem!;
  const installedCollection = Object.values(palette.collections).find(
    (c) => c.name === "AntD5 Appearance",
  )!;
  const bindings = new Map(
    Object.values(palette.variables).map((v) => [v.codeSyntax, v.id]),
  );
  function addPageLayer(n: DesignNode) {
    n.parentId = n === b.root ? null : boardId;
    n.id = n === b.root ? boardId : crypto.randomUUID();
    delete n.templateKey;
    if (n.variableModes)
      n.variableModes = { [installedCollection.id]: appearance.toLowerCase() };
    for (const field of ["fill", "color", "stroke"] as const) {
      const id = n.variableBindings?.[field];
      if (id) n.variableBindings![field] = bindings.get("--" + id)!;
    }
    operations.push({ type: "create", node: n });
  }
  b.nodes.forEach(addPageLayer);
  const board: DesignDocument = {
    ...doc,
    designSystem: system,
    libraries: { ...doc.libraries, [library.id]: library },
    nodes: [...doc.nodes, b.root],
  };
  function insert(
    id: string,
    variant: string,
    x: number,
    y: number,
    labels: Record<string, string> = {},
  ) {
    const componentId = "antd-" + id;
    const component = library.components.find((c) => c.id === componentId)!;
    const placed = instantiateComponent(
      board,
      { ...library, components: [component] },
      componentId,
      appearance + "-" + variant,
      boardId,
      { x: origin.x + x, y: origin.y + y },
    );
    for (const op of placed.operations) {
      if (op.type === "create") {
        const label = labels[op.node.templateKey!];
        if (label !== undefined) {
          op.node.text = label;
          if (op.node.control?.kind === "button") op.node.control.label = label;
        }
      }
      operations.push(op);
    }
  }

  insert("avatar", "Default", 1314, 16);
  insert("menu", dashboard ? "Dashboard" : "Orders", 0, 120);
  insert("breadcrumb", dashboard ? "Two" : "Three", 256, 92);
  if (dashboard) {
    const metrics = [
      {
        title: "成交金额（元）",
        value: "128,640.00",
        change: "+12.8%",
        trend: "Up",
      },
      { title: "订单总量（笔）", value: "386", change: "+8.4%", trend: "Up" },
      { title: "新增客户（家）", value: "42", change: "+5.0%", trend: "Up" },
      { title: "退款率", value: "0.82%", change: "−0.3%", trend: "Down" },
    ];
    metrics.forEach(({ trend, ...labels }, i) =>
      insert("statistic", trend, 256 + i * 292, 232, labels),
    );
    insert("button", "Default-Middle", 1292, panelY + 20, { root: "导出报表" });
  } else {
    insert("input", "Default-Middle", 280, 280, { value: "搜索客户或订单号" });
    insert("select", "Default", 554, 280);
    insert("button", "Primary-Middle", 790, 280, { root: "查询" });
    insert("button", "Default-Middle", 894, 280, { root: "重置" });
    insert("button", "Default-Middle", 1188, panelY + 20, { root: "批量审核" });
    insert("button", "Primary-Middle", 1292, panelY + 20, { root: "新建订单" });
  }
  insert("table", dashboard ? "Default" : "Compact", 280, panelY + 80);
  insert("pagination", "Default", 1112, panelY + 374);
  if (!dashboard) {
    addPageLayer(
      b.box("scrim", 0, 0, 1440, 900, { fill: "#000000", fillOpacity: 0.42 }),
    );
    insert("modal", "Form", 460, 248);
  }
  return { operations, id: boardId };
}
