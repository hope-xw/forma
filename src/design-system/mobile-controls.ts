import { MobileBuilder, type Appearance } from "./mobile-foundations";
export type VariantProps = Record<string, string>;
export type MobileDefinition = {
  id: string;
  name: string;
  category: string;
  description: string;
  axes?: Record<string, readonly string[]>;
  build(appearance: Appearance, props: VariantProps): MobileBuilder;
};
export const controlDefinitions: MobileDefinition[] = [
  {
    id: "button",
    name: "按钮 Button",
    category: "输入与操作",
    description: "主操作、次操作、轻量和危险操作；三种尺寸与交互状态。",
    axes: {
      Style: ["Primary", "Secondary", "Plain", "Destructive"],
      Size: ["Medium", "Small", "Large"],
      State: ["Default", "Pressed", "Disabled"],
    },
    build(a, p) {
      const height = p.Size === "Small" ? 34 : p.Size === "Large" ? 54 : 44;
      const b = new MobileBuilder(
          a,
          "按钮",
          p.Size === "Large" ? 220 : 152,
          height,
        ),
        t = b.theme;
      b.root.type = "button";
      b.root.text = "继续";
      Object.assign(b.root.style, {
        fill:
          p.Style === "Primary"
            ? t.accent
            : p.Style === "Destructive"
              ? t.danger
              : t.secondary,
        color:
          p.Style === "Primary" || p.Style === "Destructive"
            ? a === "Dark"
              ? t.canvas
              : "#ffffff"
            : t.accent,
        radius: height / 2,
        fontWeight: 600,
        fontSize: p.Size === "Small" ? 14 : 17,
        fillOpacity: p.Style === "Plain" ? 0 : 1,
        opacity:
          p.State === "Disabled" ? 0.38 : p.State === "Pressed" ? 0.72 : 1,
      });
      b.control("button", "", p.State === "Disabled");
      return b;
    },
  },
  {
    id: "icon-button",
    name: "图标按钮 Icon Button",
    category: "输入与操作",
    description: "使用 Forma 自绘矢量图标，不包含 SF Symbols。",
    axes: { State: ["Default", "Disabled"], Size: ["Medium", "Large"] },
    build(a, p) {
      const s = p.Size === "Large" ? 52 : 40,
        b = new MobileBuilder(a, "添加", s, s);
      b.glass();
      b.root.style.radius = s / 2;
      b.icon("symbol", "plus", (s - 24) / 2, (s - 24) / 2, 24, b.theme.accent);
      b.control("button", "", p.State === "Disabled");
      if (p.State === "Disabled") b.root.style.opacity = 0.4;
      return b;
    },
  },
  {
    id: "toggle",
    name: "开关 Toggle",
    category: "输入与操作",
    description: "开 / 关及禁用状态；可交互导出。",
    axes: { Value: ["On", "Off"], State: ["Default", "Disabled"] },
    build(a, p) {
      const b = new MobileBuilder(a, "开关", 52, 32),
        on = p.Value === "On";
      Object.assign(b.root.style, {
        fill: on ? b.theme.success : b.theme.secondary,
        radius: 16,
        opacity: p.State === "Disabled" ? 0.4 : 1,
      });
      b.box("thumb", on ? 23 : 3, 3, 26, 26, {
        fill: "#ffffff",
        radius: 13,
        shadows: [
          {
            x: 0,
            y: 2,
            blur: 4,
            spread: 0,
            color: "#000000",
            opacity: 0.16,
            inset: false,
          },
        ],
      });
      b.control("switch", on, p.State === "Disabled");
      return b;
    },
  },
  {
    id: "checkbox",
    name: "复选框 Checkbox",
    category: "输入与操作",
    description: "勾选状态与可访问标签。",
    axes: { Value: ["On", "Off"], State: ["Default", "Disabled"] },
    build(a, p) {
      const b = new MobileBuilder(a, "选择项目", 28, 28),
        on = p.Value === "On";
      Object.assign(b.root.style, {
        fill: on ? b.theme.accent : b.theme.surface,
        stroke: b.theme.border,
        strokeWidth: on ? 0 : 2,
        radius: 8,
        opacity: p.State === "Disabled" ? 0.4 : 1,
      });
      if (on) b.icon("check", "check", 4, 4, 20, "#ffffff");
      b.control("checkbox", on, p.State === "Disabled");
      return b;
    },
  },
  {
    id: "segmented",
    name: "分段控制 Segmented",
    category: "输入与操作",
    description: "三个互斥选项；保留标签与选中值。",
    axes: { Value: ["Overview", "Activity", "Files"] },
    build(a, p) {
      const b = new MobileBuilder(a, "内容切换", 320, 40),
        labels = ["概览", "动态", "文件"],
        index = ["Overview", "Activity", "Files"].indexOf(p.Value);
      b.root.style.fill = b.theme.secondary;
      b.root.style.radius = 14;
      b.box("active", 4 + index * 104, 4, 104, 32, {
        fill: b.theme.surface,
        radius: 10,
      });
      labels.forEach((label, i) =>
        b.text(`label-${i}`, label, 4 + i * 104, 8, 104, 14, {
          textAlign: "center",
          fontWeight: i === index ? 600 : 400,
          color: i === index ? b.theme.text : b.theme.muted,
        }),
      );
      b.control("segmented", index, false, labels);
      return b;
    },
  },
  {
    id: "text-field",
    name: "文本输入 Text Field",
    category: "输入与操作",
    description: "空值、填写、错误和禁用状态。",
    axes: { State: ["Default", "Filled", "Error", "Disabled"] },
    build(a, p) {
      const b = new MobileBuilder(a, "姓名", 320, 52),
        filled = p.State === "Filled";
      Object.assign(b.root.style, {
        fill: b.theme.secondary,
        radius: 14,
        stroke: p.State === "Error" ? b.theme.danger : b.theme.border,
        strokeWidth: p.State === "Error" ? 2 : 1,
        opacity: p.State === "Disabled" ? 0.45 : 1,
      });
      b.text("value", filled ? "林小满" : "请输入姓名", 16, 14, 282, 16, {
        color: filled ? b.theme.text : b.theme.muted,
      });
      b.control("textfield", filled ? "林小满" : "", p.State === "Disabled");
      return b;
    },
  },
  {
    id: "search",
    name: "搜索 Search",
    category: "输入与操作",
    description: "带搜索标识的输入框。",
    axes: { State: ["Default", "Filled"] },
    build(a, p) {
      const b = new MobileBuilder(a, "搜索", 340, 48);
      b.root.style.fill = b.theme.secondary;
      b.root.style.radius = 24;
      b.icon("search", "search", 15, 13, 22, b.theme.muted);
      b.text(
        "value",
        p.State === "Filled" ? "设计系统" : "搜索内容",
        48,
        12,
        270,
        16,
        { color: b.theme.muted },
      );
      b.control("textfield", p.State === "Filled" ? "设计系统" : "");
      return b;
    },
  },
  {
    id: "slider",
    name: "滑块 Slider",
    category: "输入与操作",
    description: "0–100 连续数值与禁用态。",
    axes: { Value: ["25", "50", "75"], State: ["Default", "Disabled"] },
    build(a, p) {
      const b = new MobileBuilder(a, "音量", 280, 36),
        value = Number(p.Value);
      b.root.style.fillOpacity = 0;
      b.box("track", 0, 15, 280, 6, { fill: b.theme.secondary, radius: 3 });
      b.box("fill", 0, 15, 2.8 * value, 6, { fill: b.theme.accent, radius: 3 });
      b.box("thumb", Math.min(252, Math.max(0, 2.8 * value - 14)), 4, 28, 28, {
        fill: b.theme.surface,
        radius: 14,
        stroke: b.theme.border,
        strokeWidth: 1,
        shadows: [
          {
            x: 0,
            y: 2,
            blur: 6,
            spread: 0,
            color: "#000000",
            opacity: 0.16,
            inset: false,
          },
        ],
      });
      b.control("slider", value, p.State === "Disabled");
      Object.assign(b.root.control!, { min: 0, max: 100, step: 1 });
      if (p.State === "Disabled") b.root.style.opacity = 0.4;
      return b;
    },
  },
  {
    id: "stepper",
    name: "步进器 Stepper",
    category: "输入与操作",
    description: "数值增减及边界控制。",
    axes: { State: ["Default", "Disabled"] },
    build(a, p) {
      const b = new MobileBuilder(a, "数量", 150, 40);
      b.root.style.fill = b.theme.secondary;
      b.root.style.radius = 14;
      b.icon("minus", "minus", 12, 8, 24, b.theme.accent);
      b.text("value", "1", 52, 8, 46, 16, {
        textAlign: "center",
        fontWeight: 600,
      });
      b.icon("plus", "plus", 114, 8, 24, b.theme.accent);
      b.control("stepper", 1, p.State === "Disabled");
      Object.assign(b.root.control!, { min: 0, max: 99, step: 1 });
      if (p.State === "Disabled") b.root.style.opacity = 0.4;
      return b;
    },
  },
  {
    id: "progress",
    name: "进度条 Progress",
    category: "反馈",
    description: "确定进度；导出保留进度语义。",
    axes: { Value: ["25", "50", "100"] },
    build(a, p) {
      const b = new MobileBuilder(a, "上传进度", 280, 48);
      b.root.style.fillOpacity = 0;
      b.text("label", "正在同步", 0, 0, 220, 13, { color: b.theme.muted });
      b.text("value", `${p.Value}%`, 230, 0, 50, 13, {
        textAlign: "right",
        color: b.theme.muted,
      });
      b.box("track", 0, 32, 280, 6, { fill: b.theme.secondary, radius: 3 });
      b.box("fill", 0, 32, 2.8 * Number(p.Value), 6, {
        fill: b.theme.accent,
        radius: 3,
      });
      b.control("progress", Number(p.Value));
      return b;
    },
  },
  {
    id: "popup-button",
    name: "弹出选择 Pop-up Button",
    category: "输入与操作",
    description: "带当前值的选择触发器。",
    build(a) {
      const b = new MobileBuilder(a, "排序", 160, 44);
      b.root.style.fill = b.theme.secondary;
      b.text("label", "最近更新", 18, 10, 108, 16, { fontWeight: 500 });
      b.icon("chevron", "forward", 128, 14, 16, b.theme.muted);
      return b;
    },
  },
  {
    id: "color-picker",
    name: "颜色选择 Color Picker",
    category: "输入与操作",
    description: "自研色板与当前颜色指示。",
    build(a) {
      const b = new MobileBuilder(a, "颜色", 320, 204),
        colors = [
          "#246bfd",
          "#7964e8",
          "#d55c9b",
          "#df354d",
          "#ea8b35",
          "#d7b735",
          "#25a975",
          "#269aab",
          "#192234",
          "#778195",
          "#dce2ec",
          "#ffffff",
        ];
      b.text("title", "颜色", 20, 16, 240, 17, { fontWeight: 600 });
      colors.forEach((fill, i) => {
        b.box(
          `color-${i}`,
          20 + (i % 6) * 48,
          60 + Math.floor(i / 6) * 48,
          36,
          36,
          { fill, radius: 18, stroke: b.theme.border, strokeWidth: 1 },
        );
        if (i === 0) b.icon("selected", "check", 26, 66, 24, "#ffffff");
      });
      b.text("hex", "#246BFD", 20, 162, 280, 14, { color: b.theme.muted });
      return b;
    },
  },
  {
    id: "date-picker",
    name: "日期选择 Date Picker",
    category: "输入与操作",
    description: "完整月份布局与选中日期，静态设计组件。",
    build(a) {
      const b = new MobileBuilder(a, "日期选择", 336, 340);
      b.text("month", "2026 年 11 月", 20, 18, 230, 18, { fontWeight: 600 });
      b.icon("prev", "back", 260, 20, 20, b.theme.accent);
      b.icon("next", "forward", 296, 20, 20, b.theme.accent);
      ["日", "一", "二", "三", "四", "五", "六"].forEach((d, i) =>
        b.text(`weekday-${i}`, d, 16 + i * 44, 64, 40, 12, {
          textAlign: "center",
          color: b.theme.muted,
        }),
      );
      for (let day = 1; day <= 30; day++) {
        const i = day - 1,
          x = 16 + (i % 7) * 44,
          y = 99 + Math.floor(i / 7) * 44;
        if (day === 17)
          b.box("selected", x + 2, y - 3, 36, 36, {
            fill: b.theme.accent,
            radius: 18,
          });
        b.text(`day-${day}`, String(day), x, y, 40, 16, {
          textAlign: "center",
          color: day === 17 ? "#ffffff" : b.theme.text,
        });
      }
      return b;
    },
  },
  {
    id: "keyboard",
    name: "键盘 Keyboard",
    category: "系统框架",
    description: "可编辑的字母与数字键盘设计稿；不替代设备输入法。",
    axes: { Type: ["Alphabet", "Numeric"] },
    build(a, p) {
      const b = new MobileBuilder(a, "键盘", 390, 280);
      b.root.style.fill = b.theme.secondary;
      b.root.style.radius = 0;
      const rows =
        p.Type === "Numeric"
          ? ["123", "456", "789"]
          : ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
      rows.forEach((row, r) => {
        const w = p.Type === "Numeric" ? 112 : 32,
          gap = 6,
          start = (390 - row.length * (w + gap) + gap) / 2;
        [...row].forEach((letter, i) => {
          const x = start + i * (w + gap),
            y = 16 + r * 54;
          b.box(`key-${r}-${i}`, x, y, w, 44, {
            fill: b.theme.surface,
            radius: 7,
          });
          b.text(`text-${r}-${i}`, letter, x, y + 8, w, 19, {
            textAlign: "center",
          });
        });
      });
      b.box("space", 80, 184, 222, 44, { fill: b.theme.surface, radius: 8 });
      b.text(
        "space-label",
        p.Type === "Numeric" ? "0" : "空格",
        80,
        194,
        222,
        16,
        { textAlign: "center" },
      );
      b.box("return", 310, 184, 72, 44, { fill: b.theme.accent, radius: 8 });
      b.text("return-label", "完成", 310, 194, 72, 16, {
        textAlign: "center",
        color: "#ffffff",
      });
      b.box("home", 128, 260, 134, 5, { fill: b.theme.text, radius: 3 });
      return b;
    },
  },
  {
    id: "time-picker",
    name: "时间选择 Time Picker",
    category: "输入与操作",
    description: "12 / 24 小时滚轮式时间设计组件，选择行为留待原型流程绑定。",
    axes: { Format: ["24h", "12h"] },
    build(a, p) {
      const b = new MobileBuilder(a, "时间选择", 300, 216);
      b.box("selection", 12, 88, 276, 40, {
        fill: b.theme.secondary,
        radius: 12,
      });
      const columns =
        p.Format === "12h"
          ? [
              ["09", "10", "11", "12", "01"],
              ["22", "23", "24", "25", "26"],
              ["", "", "上午", "下午", ""],
            ]
          : [
              ["09", "10", "11", "12", "13"],
              ["22", "23", "24", "25", "26"],
            ];
      columns.forEach((values, col) =>
        values.forEach((value, row) => {
          if (value)
            b.text(
              `value-${col}-${row}`,
              value,
              (p.Format === "12h" ? 25 : 60) +
                col * (p.Format === "12h" ? 84 : 110),
              18 + row * 40,
              80,
              22,
              {
                textAlign: "center",
                color: row === 2 ? b.theme.text : b.theme.muted,
                opacity: row === 0 || row === 4 ? 0.35 : row === 2 ? 1 : 0.6,
                fontWeight: row === 2 ? 600 : 400,
              },
            );
        }),
      );
      return b;
    },
  },
];
