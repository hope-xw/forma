import { mkdirSync, writeFileSync } from "node:fs";
import {
  defaultStyle,
  parseDocument,
  type DesignDocument,
  type DesignNode,
  type NodeStyle,
} from "../src/domain/document";
import { openPage } from "../src/domain/pages";
import type { DesignSystem } from "../src/domain/design-system-schema";

const system: DesignSystem = {
  collections: {
    theme: {
      id: "theme",
      name: "Theme",
      defaultModeId: "dark",
      modes: [
        { id: "dark", name: "Obsidian Dark" },
        { id: "light", name: "Cloud Light" },
      ],
    },
  },
  activeModes: { theme: "dark" },
  variables: {
    bgCanvas: {
      id: "bgCanvas",
      name: "Surface/Canvas",
      type: "color",
      collectionId: "theme",
      scopes: ["fill"],
      description: "Main page background",
      codeSyntax: "--aura-bg-canvas",
      values: { dark: "#0b0d14", light: "#f7f8fc" },
    },
    bgSurface: {
      id: "bgSurface",
      name: "Surface/Card",
      type: "color",
      collectionId: "theme",
      scopes: ["fill"],
      description: "Primary elevated card surface",
      codeSyntax: "--aura-bg-surface",
      values: { dark: "#131724", light: "#ffffff" },
    },
    bgSubtle: {
      id: "bgSubtle",
      name: "Surface/Subtle",
      type: "color",
      collectionId: "theme",
      scopes: ["fill"],
      description: "Secondary panel / sidebar / pill surface",
      codeSyntax: "--aura-bg-subtle",
      values: { dark: "#1a2033", light: "#f1f3f9" },
    },
    borderSubtle: {
      id: "borderSubtle",
      name: "Border/Subtle",
      type: "color",
      collectionId: "theme",
      scopes: ["stroke"],
      description: "Subtle hairline border",
      codeSyntax: "--aura-border-subtle",
      values: { dark: "#262e45", light: "#e3e7f2" },
    },
    textPrimary: {
      id: "textPrimary",
      name: "Text/Primary",
      type: "color",
      collectionId: "theme",
      scopes: ["color"],
      description: "Primary headings and body",
      codeSyntax: "--aura-text-primary",
      values: { dark: "#f5f7ff", light: "#111629" },
    },
    textSecondary: {
      id: "textSecondary",
      name: "Text/Secondary",
      type: "color",
      collectionId: "theme",
      scopes: ["color"],
      description: "Supporting copy and metadata",
      codeSyntax: "--aura-text-secondary",
      values: { dark: "#96a0bc", light: "#5c6682" },
    },
    brandPrimary: {
      id: "brandPrimary",
      name: "Brand/Primary",
      type: "color",
      collectionId: "theme",
      scopes: ["fill", "color", "stroke"],
      description: "Primary Aura violet accent",
      codeSyntax: "--aura-brand-primary",
      values: { dark: "#7c5cff", light: "#6344f5" },
    },
    brandSoft: {
      id: "brandSoft",
      name: "Brand/Soft",
      type: "color",
      collectionId: "theme",
      scopes: ["fill"],
      description: "Soft accent pill background",
      codeSyntax: "--aura-brand-soft",
      values: { dark: "#221b47", light: "#eeebff" },
    },
    statusGreen: {
      id: "statusGreen",
      name: "Status/Success",
      type: "color",
      collectionId: "theme",
      scopes: ["fill", "color"],
      description: "Positive metric delta & online status",
      codeSyntax: "--aura-status-green",
      values: { dark: "#22c55e", light: "#16a34a" },
    },
    statusCyan: {
      id: "statusCyan",
      name: "Status/Cyan",
      type: "color",
      collectionId: "theme",
      scopes: ["fill", "color"],
      description: "Secondary chart and highlight accent",
      codeSyntax: "--aura-status-cyan",
      values: { dark: "#38bdf8", light: "#0284c7" },
    },
  },
  styles: {
    surfaceCard: {
      id: "surfaceCard",
      kind: "paint",
      name: "Surface/Card",
      description: "Primary card background",
      properties: { fill: "#131724" },
      bindings: { fill: "bgSurface" },
    },
    brandAccent: {
      id: "brandAccent",
      kind: "paint",
      name: "Brand/Accent",
      description: "Primary brand violet",
      properties: { fill: "#7c5cff" },
      bindings: { fill: "brandPrimary" },
    },
    displayTitle: {
      id: "displayTitle",
      kind: "text",
      name: "Display/Hero",
      description: "Hero display headline",
      properties: {
        fontFamily: "Inter, -apple-system, PingFang SC, sans-serif",
        fontSize: 56,
        fontWeight: 700,
        lineHeight: 64,
        letterSpacing: -1.6,
      },
      bindings: {},
    },
    cardShadow: {
      id: "cardShadow",
      kind: "effect",
      name: "Elevation/Card",
      description: "Subtle floating elevation",
      properties: {
        shadows: [
          {
            x: 0,
            y: 16,
            blur: 40,
            spread: -8,
            color: "#000000",
            opacity: 0.32,
            inset: false,
          },
        ],
      },
      bindings: {},
    },
  },
};

const FONT =
  "Inter, -apple-system, BlinkMacSystemFont, PingFang SC, sans-serif";
const MONO = "JetBrains Mono, ui-monospace, SFMono-Regular, monospace";

function makeNode(
  id: string,
  parentId: string | null,
  type: DesignNode["type"],
  name: string,
  style: Partial<NodeStyle>,
  extra: Partial<DesignNode> = {},
): DesignNode {
  return {
    id,
    parentId,
    type,
    name,
    text: "",
    hidden: false,
    locked: false,
    style: {
      ...defaultStyle,
      radius: 0,
      padding: 0,
      gap: 0,
      fontFamily: FONT,
      ...style,
    },
    ...extra,
  };
}

function buildMarketingPage(): DesignNode[] {
  const nodes: DesignNode[] = [];
  const push = (n: DesignNode) => {
    nodes.push(n);
    return n.id;
  };

  // === DESKTOP MARKETING LANDING (1440 x 2120) ===
  const root = push(
    makeNode(
      "mkt-desktop",
      null,
      "frame",
      "Aura Studio · 营销官网 (Desktop)",
      {
        x: 0,
        y: 0,
        width: 1440,
        height: 2120,
        fill: "#0b0d14",
        clipContent: true,
        viewportWidth: true,
      },
      {
        variableBindings: { fill: "bgCanvas" },
        interaction: { flow: "营销官网 → 工作台" },
      },
    ),
  );

  // Ambient hero glows
  push(
    makeNode("mkt-glow-1", root, "ellipse", "环境光晕 · 紫", {
      x: 340,
      y: -140,
      width: 760,
      height: 520,
      fill: "#7c5cff",
      fillOpacity: 0.22,
      blur: 85,
    }),
  );
  push(
    makeNode("mkt-glow-2", root, "ellipse", "环境光晕 · 青", {
      x: 840,
      y: 120,
      width: 520,
      height: 400,
      fill: "#38bdf8",
      fillOpacity: 0.14,
      blur: 80,
    }),
  );

  // Glassmorphic Navbar
  const nav = push(
    makeNode(
      "mkt-nav",
      root,
      "frame",
      "顶部导航栏",
      {
        x: 72,
        y: 24,
        width: 1296,
        height: 64,
        fill: "#131724",
        fillOpacity: 0.78,
        backdropBlur: 18,
        radius: 16,
        stroke: "#262e45",
        strokeWidth: 1,
        layout: "row",
        alignX: "start",
        alignY: "center",
        insets: { top: 0, right: 20, bottom: 0, left: 20 },
        gap: 24,
      },
      { variableBindings: { fill: "bgSurface", stroke: "borderSubtle" } },
    ),
  );

  // Brand logo lockup
  const brand = push(
    makeNode("mkt-brand", nav, "frame", "品牌标志", {
      width: 180,
      height: 36,
      fill: "#000000",
      fillOpacity: 0,
      layout: "row",
      alignY: "center",
      gap: 10,
    }),
  );
  const logoBadge = push(
    makeNode("mkt-logo-badge", brand, "frame", "Logo 图标框", {
      width: 32,
      height: 32,
      radius: 9,
      gradient: {
        type: "linear",
        angle: 135,
        stops: [
          {
            offset: 0,
            color: "#8b6eff",
            opacity: 1,
            variableId: "brandPrimary",
          },
          { offset: 1, color: "#38bdf8", opacity: 1, variableId: "statusCyan" },
        ],
      },
      layout: "row",
      alignX: "center",
      alignY: "center",
    }),
  );
  push(
    makeNode(
      "mkt-logo-svg",
      logoBadge,
      "vector",
      "Aura 矢量标志",
      { width: 18, height: 18, color: "#ffffff" },
      {
        vector: {
          width: 24,
          height: 24,
          paths: [
            {
              d: "M12 2L21 19H15.5L12 12L8.5 19H3L12 2Z",
              fill: true,
              fillColor: "#ffffff",
              strokeWidth: 0,
            },
          ],
        },
      },
    ),
  );
  push(
    makeNode(
      "mkt-brand-name",
      brand,
      "text",
      "品牌名",
      {
        width: 130,
        height: 22,
        fontSize: 16,
        fontWeight: 700,
        color: "#f5f7ff",
        letterSpacing: -0.3,
      },
      { text: "Aura Studio", variableBindings: { color: "textPrimary" } },
    ),
  );

  // Nav links
  const navLinks = push(
    makeNode("mkt-nav-links", nav, "frame", "导航菜单", {
      width: 560,
      height: 32,
      widthMode: "fill",
      fill: "#000000",
      fillOpacity: 0,
      layout: "row",
      alignX: "center",
      alignY: "center",
      gap: 32,
    }),
  );
  for (const [i, label] of [
    "核心能力",
    "设计系统",
    "代码交付",
    "定价方案",
    "更新日志",
  ].entries()) {
    push(
      makeNode(
        `mkt-nav-link-${i}`,
        navLinks,
        "text",
        `导航 · ${label}`,
        {
          width: 72,
          height: 20,
          widthMode: "hug",
          heightMode: "hug",
          fontSize: 13,
          fontWeight: i === 0 ? 600 : 500,
          color: i === 0 ? "#f5f7ff" : "#96a0bc",
        },
        {
          text: label,
          variableBindings: {
            color: i === 0 ? "textPrimary" : "textSecondary",
          },
        },
      ),
    );
  }

  // Nav actions
  const navCta = push(
    makeNode(
      "mkt-nav-cta",
      nav,
      "frame",
      "进入工作台 CTA",
      {
        width: 132,
        height: 38,
        radius: 10,
        gradient: {
          type: "linear",
          angle: 135,
          stops: [
            { offset: 0, color: "#7c5cff", opacity: 1 },
            { offset: 1, color: "#5b3df5", opacity: 1 },
          ],
        },
        layout: "row",
        alignX: "center",
        alignY: "center",
        shadows: [
          {
            x: 0,
            y: 6,
            blur: 18,
            spread: -2,
            color: "#7c5cff",
            opacity: 0.45,
            inset: false,
          },
        ],
      },
      {
        interaction: {
          actions: [{ kind: "navigate", target: "ws-desktop" }],
        },
      },
    ),
  );
  push(
    makeNode(
      "mkt-nav-cta-text",
      navCta,
      "text",
      "按钮文字",
      {
        width: 96,
        height: 18,
        fontSize: 13,
        fontWeight: 600,
        color: "#ffffff",
        textAlign: "center",
      },
      { text: "打开工作台 →" },
    ),
  );

  // === HERO SECTION ===
  const hero = push(
    makeNode("mkt-hero", root, "frame", "首屏 Hero 区域", {
      x: 120,
      y: 132,
      width: 1200,
      height: 360,
      fill: "#000000",
      fillOpacity: 0,
      layout: "column",
      alignX: "center",
      alignY: "start",
      gap: 22,
    }),
  );

  const badge = push(
    makeNode(
      "mkt-hero-badge",
      hero,
      "frame",
      "版本亮点徽章",
      {
        width: 292,
        height: 32,
        radius: 99,
        fill: "#221b47",
        stroke: "#7c5cff",
        strokeOpacity: 0.45,
        strokeWidth: 1,
        layout: "row",
        alignX: "center",
        alignY: "center",
        gap: 8,
      },
      { variableBindings: { fill: "brandSoft", stroke: "brandPrimary" } },
    ),
  );
  push(
    makeNode(
      "mkt-hero-dot",
      badge,
      "ellipse",
      "状态绿点",
      { width: 8, height: 8, fill: "#22c55e" },
      { variableBindings: { fill: "statusGreen" } },
    ),
  );
  push(
    makeNode(
      "mkt-hero-badge-txt",
      badge,
      "text",
      "徽章文案",
      {
        width: 244,
        height: 16,
        fontSize: 12,
        fontWeight: 500,
        color: "#c7bcff",
      },
      { text: "Aura Studio · Web 与移动设计样例" },
    ),
  );

  push(
    makeNode(
      "mkt-hero-h1",
      hero,
      "text",
      "主标题",
      {
        width: 860,
        height: 132,
        fontSize: 56,
        fontWeight: 700,
        lineHeight: 66,
        letterSpacing: -1.6,
        textAlign: "center",
        color: "#f5f7ff",
      },
      {
        text: "为产品团队打造的\n下一代开放式设计工程平台",
        variableBindings: { color: "textPrimary" },
        styleBindings: { text: "displayTitle" },
      },
    ),
  );

  push(
    makeNode(
      "mkt-hero-sub",
      hero,
      "text",
      "副标题",
      {
        width: 680,
        height: 54,
        fontSize: 17,
        fontWeight: 400,
        lineHeight: 27,
        textAlign: "center",
        color: "#96a0bc",
      },
      {
        text: "原生变量、多模式主题、精确自动布局与一键 React + TypeScript 交付——让设计与生产代码共享同一份真实语义。",
        variableBindings: { color: "textSecondary" },
      },
    ),
  );

  const ctaRow = push(
    makeNode("mkt-hero-ctas", hero, "frame", "首屏操作按钮组", {
      width: 390,
      height: 50,
      fill: "#000000",
      fillOpacity: 0,
      layout: "row",
      alignX: "center",
      alignY: "center",
      gap: 14,
    }),
  );
  const heroPrimary = push(
    makeNode(
      "mkt-cta-primary",
      ctaRow,
      "frame",
      "立即体验工作台",
      {
        width: 196,
        height: 48,
        radius: 12,
        gradient: {
          type: "linear",
          angle: 135,
          stops: [
            { offset: 0, color: "#8a6bff", opacity: 1 },
            { offset: 1, color: "#5e3ff4", opacity: 1 },
          ],
        },
        layout: "row",
        alignX: "center",
        alignY: "center",
        shadows: [
          {
            x: 0,
            y: 10,
            blur: 28,
            spread: -4,
            color: "#7c5cff",
            opacity: 0.55,
            inset: false,
          },
        ],
      },
      {
        interaction: {
          actions: [{ kind: "navigate", target: "ws-desktop" }],
        },
      },
    ),
  );
  push(
    makeNode(
      "mkt-cta-primary-txt",
      heroPrimary,
      "text",
      "主按钮文案",
      {
        width: 150,
        height: 20,
        fontSize: 15,
        fontWeight: 600,
        color: "#ffffff",
        textAlign: "center",
      },
      { text: "进入产品工作台 →" },
    ),
  );

  const heroSecondary = push(
    makeNode(
      "mkt-cta-secondary",
      ctaRow,
      "frame",
      "查看移动版原型",
      {
        width: 164,
        height: 48,
        radius: 12,
        fill: "#1a2033",
        stroke: "#262e45",
        strokeWidth: 1,
        layout: "row",
        alignX: "center",
        alignY: "center",
      },
      {
        variableBindings: { fill: "bgSubtle", stroke: "borderSubtle" },
        interaction: { actions: [{ kind: "navigate", target: "mkt-mobile" }] },
      },
    ),
  );
  push(
    makeNode(
      "mkt-cta-secondary-txt",
      heroSecondary,
      "text",
      "次按钮文案",
      {
        width: 120,
        height: 20,
        fontSize: 15,
        fontWeight: 500,
        color: "#f5f7ff",
        textAlign: "center",
      },
      { text: "查看移动版原型", variableBindings: { color: "textPrimary" } },
    ),
  );

  // === HERO PRODUCT MOCKUP SHOWCASE ===
  const mockup = push(
    makeNode(
      "mkt-mockup",
      root,
      "frame",
      "产品预览窗口",
      {
        x: 140,
        y: 520,
        width: 1160,
        height: 420,
        radius: 20,
        fill: "#131724",
        stroke: "#262e45",
        strokeWidth: 1,
        clipContent: true,
        shadows: [
          {
            x: 0,
            y: 28,
            blur: 70,
            spread: -12,
            color: "#000000",
            opacity: 0.55,
            inset: false,
          },
        ],
      },
      {
        variableBindings: { fill: "bgSurface", stroke: "borderSubtle" },
        styleBindings: { effect: "cardShadow" },
      },
    ),
  );

  // Window Chrome
  const chrome = push(
    makeNode(
      "mkt-mock-chrome",
      mockup,
      "frame",
      "窗口顶栏",
      {
        x: 0,
        y: 0,
        width: 1160,
        height: 44,
        fill: "#1a2033",
        layout: "row",
        alignY: "center",
        insets: { top: 0, right: 16, bottom: 0, left: 16 },
        gap: 8,
      },
      { variableBindings: { fill: "bgSubtle" } },
    ),
  );
  for (const [i, col] of ["#ff5f57", "#febc2e", "#28c840"].entries()) {
    push(
      makeNode(`mkt-dot-${i}`, chrome, "ellipse", `窗口按钮 ${i + 1}`, {
        width: 10,
        height: 10,
        fill: col,
      }),
    );
  }
  push(
    makeNode(
      "mkt-mock-url",
      chrome,
      "text",
      "窗口标题",
      {
        width: 420,
        height: 18,
        fontSize: 12,
        color: "#96a0bc",
        fontFamily: MONO,
      },
      {
        text: "  aura.studio / design-system-v4 / analytics.forma",
        variableBindings: { color: "textSecondary" },
      },
    ),
  );

  // Mockup inner 3 KPI cards + Live Chart
  const mockKpis = [
    ["4", "当前文件画板", "Web / H5", "#22c55e"],
    ["253", "当前文件可编辑图层", "2 页", "#38bdf8"],
    ["10", "文件中的主题变量", "Light/Dark", "#a78bfa"],
  ] as const;
  for (const [i, [val, label, tag, accent]] of mockKpis.entries()) {
    const card = push(
      makeNode(
        `mkt-kpi-${i}`,
        mockup,
        "frame",
        `亮点指标卡 · ${label}`,
        {
          x: 28 + i * 374,
          y: 68,
          width: 356,
          height: 106,
          radius: 14,
          fill: "#1a2033",
          stroke: "#262e45",
          strokeWidth: 1,
          layout: "column",
          insets: { top: 18, right: 20, bottom: 18, left: 20 },
          gap: 8,
        },
        { variableBindings: { fill: "bgSubtle", stroke: "borderSubtle" } },
      ),
    );
    const topRow = push(
      makeNode(`mkt-kpi-top-${i}`, card, "frame", "指标行", {
        width: 316,
        height: 36,
        fill: "#000000",
        fillOpacity: 0,
        layout: "row",
        alignY: "center",
        gap: 10,
      }),
    );
    push(
      makeNode(
        `mkt-kpi-val-${i}`,
        topRow,
        "text",
        "数值",
        {
          width: 180,
          height: 34,
          fontSize: 28,
          fontWeight: 700,
          color: "#f5f7ff",
          letterSpacing: -0.8,
        },
        { text: val, variableBindings: { color: "textPrimary" } },
      ),
    );
    const pill = push(
      makeNode(`mkt-kpi-pill-${i}`, topRow, "frame", "标签", {
        width: 78,
        height: 24,
        radius: 99,
        fill: accent,
        fillOpacity: 0.16,
        layout: "row",
        alignX: "center",
        alignY: "center",
      }),
    );
    push(
      makeNode(
        `mkt-kpi-pill-txt-${i}`,
        pill,
        "text",
        "标签字",
        {
          width: 70,
          height: 15,
          fontSize: 11,
          fontWeight: 600,
          color: accent,
          textAlign: "center",
        },
        { text: tag },
      ),
    );
    push(
      makeNode(
        `mkt-kpi-lbl-${i}`,
        card,
        "text",
        "指标说明",
        { width: 300, height: 18, fontSize: 13, color: "#96a0bc" },
        { text: label, variableBindings: { color: "textSecondary" } },
      ),
    );
  }

  // Mockup Hero Chart Panel
  const heroChart = push(
    makeNode(
      "mkt-chart-box",
      mockup,
      "frame",
      "实时性能曲线面板",
      {
        x: 28,
        y: 194,
        width: 1104,
        height: 198,
        radius: 14,
        fill: "#1a2033",
        stroke: "#262e45",
        strokeWidth: 1,
        clipContent: true,
      },
      { variableBindings: { fill: "bgSubtle", stroke: "borderSubtle" } },
    ),
  );
  push(
    makeNode(
      "mkt-chart-title",
      heroChart,
      "text",
      "曲线标题",
      {
        x: 20,
        y: 16,
        width: 340,
        height: 20,
        fontSize: 13,
        fontWeight: 600,
        color: "#f5f7ff",
      },
      {
        text: "复杂画板渲染帧率监控 · Realtime Frame Budget",
        variableBindings: { color: "textPrimary" },
      },
    ),
  );
  push(
    makeNode(
      "mkt-chart-svg",
      heroChart,
      "vector",
      "双序列性能曲线",
      { x: 16, y: 46, width: 1072, height: 142, color: "#7c5cff" },
      {
        vector: {
          width: 1072,
          height: 142,
          stretch: true,
          paths: [
            {
              d: "M0 36 H1072 M0 74 H1072 M0 112 H1072",
              fill: false,
              strokeColor: "#334155",
              strokeOpacity: 0.35,
              strokeWidth: 1,
            },
            {
              d: "M0 118 C110 110, 180 86, 280 80 C380 74, 460 92, 560 62 C660 32, 760 44, 880 26 C960 14, 1020 20, 1072 12 L1072 142 L0 142 Z",
              fill: true,
              fillColor: "#7c5cff",
              fillOpacity: 0.22,
              strokeWidth: 0,
            },
            {
              d: "M0 118 C110 110, 180 86, 280 80 C380 74, 460 92, 560 62 C660 32, 760 44, 880 26 C960 14, 1020 20, 1072 12",
              fill: false,
              strokeColor: "#8b6eff",
              strokeWidth: 2.5,
              lineCap: "round",
            },
            {
              d: "M0 128 C140 120, 240 104, 360 102 C480 100, 600 84, 720 78 C840 72, 950 56, 1072 48",
              fill: false,
              strokeColor: "#38bdf8",
              strokeWidth: 2,
              strokeOpacity: 0.85,
              lineCap: "round",
            },
          ],
        },
      },
    ),
  );

  // === BENTO FEATURE GRID ===
  push(
    makeNode(
      "mkt-bento-title",
      root,
      "text",
      "功能区标题",
      {
        x: 140,
        y: 996,
        width: 1160,
        height: 44,
        fontSize: 34,
        fontWeight: 700,
        letterSpacing: -0.9,
        textAlign: "center",
        color: "#f5f7ff",
      },
      {
        text: "摆脱生态锁定的专业设计工程内核",
        variableBindings: { color: "textPrimary" },
      },
    ),
  );

  const bento = push(
    makeNode("mkt-bento-grid", root, "frame", "Bento 特性网格", {
      x: 140,
      y: 1068,
      width: 1160,
      height: 332,
      fill: "#000000",
      fillOpacity: 0,
      layout: "grid",
      columns: 3,
      gap: 20,
      rowGap: 20,
    }),
  );

  const features = [
    {
      id: "tokens",
      title: "多模式语义设计系统",
      desc: "原生变量集合、别名链与明暗主题继承，切换一次模式即可实时驱动整站组件和导出 CSS Variables。",
      tag: "Design Tokens",
      accent: "#7c5cff",
      code: "--surface-card: #131724;\n--brand-primary: #7c5cff;",
    },
    {
      id: "vector",
      title: "精密矢量与布尔引擎",
      desc: "钢笔贝塞尔曲线、四种实时布尔运算、矢量蒙版与多画板智能整理，完全本地可编辑与无损撤销。",
      tag: "Vector & Boolean",
      accent: "#38bdf8",
      code: "Union · Subtract · Intersect\nEditable vector paths",
    },
    {
      id: "export",
      title: "可构建 React + TS 工程",
      desc: "一键下载独立 Vite + React + TypeScript 项目，保留 Auto Layout、Token 与跨页交互原型运行时。",
      tag: "Code Delivery",
      accent: "#22c55e",
      code: "npm ci && npm run build\n✓ 0 TypeScript errors",
    },
  ];
  for (const f of features) {
    const card = push(
      makeNode(
        `mkt-feat-${f.id}`,
        bento,
        "frame",
        `特性卡片 · ${f.title}`,
        {
          width: 373,
          height: 316,
          widthMode: "fill",
          radius: 18,
          fill: "#131724",
          stroke: "#262e45",
          strokeWidth: 1,
          layout: "column",
          insets: { top: 26, right: 24, bottom: 24, left: 24 },
          gap: 14,
        },
        { variableBindings: { fill: "bgSurface", stroke: "borderSubtle" } },
      ),
    );
    const pill = push(
      makeNode(`mkt-feat-pill-${f.id}`, card, "frame", "特性标签", {
        width: 124,
        height: 26,
        radius: 99,
        fill: f.accent,
        fillOpacity: 0.16,
        layout: "row",
        alignX: "center",
        alignY: "center",
      }),
    );
    push(
      makeNode(
        `mkt-feat-pill-t-${f.id}`,
        pill,
        "text",
        "标签字",
        {
          width: 112,
          height: 15,
          fontSize: 11,
          fontWeight: 600,
          color: f.accent,
          textAlign: "center",
        },
        { text: f.tag },
      ),
    );
    push(
      makeNode(
        `mkt-feat-h-${f.id}`,
        card,
        "text",
        "特性标题",
        {
          width: 320,
          height: 28,
          fontSize: 20,
          fontWeight: 700,
          color: "#f5f7ff",
          letterSpacing: -0.4,
        },
        { text: f.title, variableBindings: { color: "textPrimary" } },
      ),
    );
    push(
      makeNode(
        `mkt-feat-d-${f.id}`,
        card,
        "text",
        "特性描述",
        {
          width: 320,
          height: 72,
          fontSize: 13.5,
          lineHeight: 22,
          color: "#96a0bc",
        },
        { text: f.desc, variableBindings: { color: "textSecondary" } },
      ),
    );
    const codeBox = push(
      makeNode(
        `mkt-feat-code-${f.id}`,
        card,
        "frame",
        "代码预览块",
        {
          width: 325,
          height: 76,
          widthMode: "fill",
          radius: 10,
          fill: "#0b0d14",
          stroke: "#262e45",
          strokeWidth: 1,
          layout: "column",
          alignY: "center",
          insets: { top: 12, right: 14, bottom: 12, left: 14 },
        },
        { variableBindings: { fill: "bgCanvas", stroke: "borderSubtle" } },
      ),
    );
    push(
      makeNode(
        `mkt-feat-code-t-${f.id}`,
        codeBox,
        "text",
        "代码文本",
        {
          width: 292,
          height: 44,
          fontFamily: MONO,
          fontSize: 12,
          lineHeight: 20,
          color: f.accent,
        },
        { text: f.code },
      ),
    );
  }

  // === PRICING SECTION ===
  push(
    makeNode(
      "mkt-price-title",
      root,
      "text",
      "定价标题",
      {
        x: 140,
        y: 1460,
        width: 1160,
        height: 44,
        fontSize: 34,
        fontWeight: 700,
        letterSpacing: -0.9,
        textAlign: "center",
        color: "#f5f7ff",
      },
      {
        text: "透明定价 · 本地与私有化自由部署",
        variableBindings: { color: "textPrimary" },
      },
    ),
  );

  const pricing = push(
    makeNode("mkt-price-row", root, "frame", "定价方案行", {
      x: 140,
      y: 1532,
      width: 1160,
      height: 430,
      fill: "#000000",
      fillOpacity: 0,
      layout: "row",
      gap: 24,
    }),
  );

  const tiers = [
    {
      id: "starter",
      name: "Starter 开源版",
      price: "¥0",
      unit: "/ 永久免费",
      desc: "适合个人设计师与独立开发者",
      items:
        "✓ 无限本地多页文件\n✓ 完整矢量、自动布局与原型\n✓ 导出独立 React + TS 项目\n✓ 自带 290+ 移动与 Web 组件",
      cta: "立即免费使用",
      featured: false,
    },
    {
      id: "pro",
      name: "Pro 团队版",
      price: "¥99",
      unit: "/ 席位 / 月",
      desc: "为高迭代产品与设计系统团队打造",
      items:
        "✓ 无限共享组件库与版本订阅\n✓ 自定义 OpenAI 兼容模型网关\n✓ 跨页交互原型与响应式评审\n✓ 优先工程交付与设计 Token 同步",
      cta: "进入团队工作台 →",
      featured: true,
    },
    {
      id: "enterprise",
      name: "Enterprise 私有化",
      price: "定制",
      unit: "/ 企业买断",
      desc: "金融、政企与超大型研发团队专享",
      items:
        "✓ 100% 私有化容器与对象存储\n✓ 企业 SSO / OIDC 权限与审计\n✓ 本地大模型推理零数据外泄\n✓ 专属前端框架代码编译器定制",
      cta: "联系架构顾问",
      featured: false,
    },
  ];
  for (const t of tiers) {
    const card = push(
      makeNode(
        `mkt-tier-${t.id}`,
        pricing,
        "frame",
        `定价卡 · ${t.name}`,
        {
          width: 370,
          height: 416,
          widthMode: "fill",
          radius: 20,
          fill: "#131724",
          stroke: t.featured ? "#7c5cff" : "#262e45",
          strokeWidth: t.featured ? 2 : 1,
          layout: "column",
          insets: { top: 28, right: 26, bottom: 26, left: 26 },
          gap: 16,
          ...(t.featured
            ? {
                shadows: [
                  {
                    x: 0,
                    y: 20,
                    blur: 50,
                    spread: -10,
                    color: "#7c5cff",
                    opacity: 0.28,
                    inset: false,
                  },
                ],
              }
            : {}),
        },
        {
          variableBindings: {
            fill: "bgSurface",
            stroke: t.featured ? "brandPrimary" : "borderSubtle",
          },
        },
      ),
    );
    push(
      makeNode(
        `mkt-tier-name-${t.id}`,
        card,
        "text",
        "方案名称",
        {
          width: 300,
          height: 24,
          fontSize: 17,
          fontWeight: 700,
          color: t.featured ? "#a78bfa" : "#f5f7ff",
        },
        {
          text: t.name,
          ...(t.featured ? {} : { variableBindings: { color: "textPrimary" } }),
        },
      ),
    );
    const priceLine = push(
      makeNode(`mkt-tier-pl-${t.id}`, card, "frame", "价格行", {
        width: 300,
        height: 44,
        fill: "#000000",
        fillOpacity: 0,
        layout: "row",
        alignY: "end",
        gap: 8,
      }),
    );
    push(
      makeNode(
        `mkt-tier-p-${t.id}`,
        priceLine,
        "text",
        "价格",
        {
          width: 110,
          height: 42,
          widthMode: "hug",
          fontSize: 36,
          fontWeight: 800,
          letterSpacing: -1,
          color: "#f5f7ff",
        },
        { text: t.price, variableBindings: { color: "textPrimary" } },
      ),
    );
    push(
      makeNode(
        `mkt-tier-u-${t.id}`,
        priceLine,
        "text",
        "周期",
        { width: 120, height: 22, fontSize: 13, color: "#96a0bc" },
        { text: t.unit, variableBindings: { color: "textSecondary" } },
      ),
    );
    push(
      makeNode(
        `mkt-tier-desc-${t.id}`,
        card,
        "text",
        "方案简介",
        { width: 310, height: 20, fontSize: 13, color: "#96a0bc" },
        { text: t.desc, variableBindings: { color: "textSecondary" } },
      ),
    );
    push(
      makeNode(
        `mkt-tier-items-${t.id}`,
        card,
        "text",
        "权益列表",
        {
          width: 316,
          height: 136,
          fontSize: 13.5,
          lineHeight: 32,
          color: "#cbd5e1",
        },
        { text: t.items, variableBindings: { color: "textPrimary" } },
      ),
    );
    const btn = push(
      makeNode(
        `mkt-tier-btn-${t.id}`,
        card,
        "frame",
        `按钮 · ${t.cta}`,
        {
          width: 318,
          height: 44,
          widthMode: "fill",
          radius: 11,
          ...(t.featured
            ? {
                gradient: {
                  type: "linear",
                  angle: 135,
                  stops: [
                    { offset: 0, color: "#8a6bff", opacity: 1 },
                    { offset: 1, color: "#5e3ff4", opacity: 1 },
                  ],
                },
              }
            : { fill: "#1a2033", stroke: "#262e45", strokeWidth: 1 }),
          layout: "row",
          alignX: "center",
          alignY: "center",
        },
        {
          ...(t.featured
            ? {
                interaction: {
                  actions: [{ kind: "navigate", target: "ws-desktop" }],
                },
              }
            : {
                variableBindings: { fill: "bgSubtle", stroke: "borderSubtle" },
              }),
        },
      ),
    );
    push(
      makeNode(
        `mkt-tier-btn-t-${t.id}`,
        btn,
        "text",
        "按钮文案",
        {
          width: 240,
          height: 18,
          fontSize: 14,
          fontWeight: 600,
          textAlign: "center",
          color: t.featured ? "#ffffff" : "#f5f7ff",
        },
        {
          text: t.cta,
          ...(t.featured ? {} : { variableBindings: { color: "textPrimary" } }),
        },
      ),
    );
  }

  // Footer
  push(
    makeNode(
      "mkt-footer",
      root,
      "text",
      "页脚版权",
      {
        x: 140,
        y: 2030,
        width: 1160,
        height: 24,
        fontSize: 12,
        textAlign: "center",
        color: "#64748b",
      },
      {
        text: "© 2026 Aura Studio · Built entirely inside Forma Design Platform · Open Format · React + TypeScript Ready",
        variableBindings: { color: "textSecondary" },
      },
    ),
  );

  // === MOBILE H5 LANDING (390 x 980) ===
  const mob = push(
    makeNode(
      "mkt-mobile",
      null,
      "frame",
      "Aura Studio · 移动 H5 官网 (390)",
      {
        x: 1520,
        y: 0,
        width: 390,
        height: 980,
        fill: "#0b0d14",
        radius: 36,
        stroke: "#262e45",
        strokeWidth: 1,
        clipContent: true,
        layout: "column",
        insets: { top: 44, right: 20, bottom: 28, left: 20 },
        gap: 20,
      },
      {
        variableBindings: { fill: "bgCanvas", stroke: "borderSubtle" },
        interaction: { flow: "移动 H5 落地页" },
      },
    ),
  );
  push(
    makeNode(
      "mkt-mob-brand",
      mob,
      "text",
      "移动端标题栏",
      {
        width: 350,
        height: 24,
        fontSize: 16,
        fontWeight: 700,
        color: "#f5f7ff",
      },
      { text: "▲ Aura Studio", variableBindings: { color: "textPrimary" } },
    ),
  );
  push(
    makeNode(
      "mkt-mob-h1",
      mob,
      "text",
      "移动主标题",
      {
        width: 350,
        height: 112,
        fontSize: 32,
        fontWeight: 800,
        lineHeight: 38,
        letterSpacing: -0.8,
        color: "#f5f7ff",
      },
      {
        text: "开放式设计工程平台\n直出生产代码",
        variableBindings: { color: "textPrimary" },
      },
    ),
  );
  push(
    makeNode(
      "mkt-mob-sub",
      mob,
      "text",
      "移动副标题",
      {
        width: 350,
        height: 66,
        fontSize: 14,
        lineHeight: 22,
        color: "#96a0bc",
      },
      {
        text: "原生变量、多模式主题与可编辑画板，让移动端 H5 与桌面应用设计开发一体化。",
        variableBindings: { color: "textSecondary" },
      },
    ),
  );
  const mobCta = push(
    makeNode(
      "mkt-mob-cta",
      mob,
      "frame",
      "移动主按钮",
      {
        width: 350,
        height: 48,
        widthMode: "fill",
        radius: 12,
        gradient: {
          type: "linear",
          angle: 135,
          stops: [
            { offset: 0, color: "#8a6bff", opacity: 1 },
            { offset: 1, color: "#5e3ff4", opacity: 1 },
          ],
        },
        layout: "row",
        alignX: "center",
        alignY: "center",
      },
      {
        interaction: {
          actions: [{ kind: "navigate", target: "ws-desktop" }],
        },
      },
    ),
  );
  push(
    makeNode(
      "mkt-mob-cta-t",
      mobCta,
      "text",
      "按钮文案",
      {
        width: 200,
        height: 18,
        fontSize: 15,
        fontWeight: 600,
        color: "#ffffff",
        textAlign: "center",
      },
      { text: "立即进入工作台 →" },
    ),
  );

  for (const [i, [val, title, desc]] of [
    ["253 层", "可编辑的原生图层", "桌面与移动画板共用一份多页设计文件"],
    [
      "2 套主题",
      "变量驱动明暗模式",
      "Design System 变量一键切换 Obsidian / Cloud",
    ],
    ["React + TS", "无锁工程导出", "独立 Vite 工程直出，完整保留交互与样式"],
  ].entries()) {
    const mc = push(
      makeNode(
        `mkt-mob-card-${i}`,
        mob,
        "frame",
        `移动卡片 · ${title}`,
        {
          width: 350,
          height: 132,
          widthMode: "fill",
          radius: 16,
          fill: "#131724",
          stroke: "#262e45",
          strokeWidth: 1,
          layout: "column",
          insets: { top: 18, right: 18, bottom: 18, left: 18 },
          gap: 6,
        },
        { variableBindings: { fill: "bgSurface", stroke: "borderSubtle" } },
      ),
    );
    push(
      makeNode(
        `mkt-mob-v-${i}`,
        mc,
        "text",
        "亮点值",
        {
          width: 200,
          height: 26,
          fontSize: 22,
          fontWeight: 700,
          color: "#a78bfa",
        },
        { text: val },
      ),
    );
    push(
      makeNode(
        `mkt-mob-t-${i}`,
        mc,
        "text",
        "亮点标题",
        {
          width: 300,
          height: 20,
          fontSize: 15,
          fontWeight: 600,
          color: "#f5f7ff",
        },
        { text: title, variableBindings: { color: "textPrimary" } },
      ),
    );
    push(
      makeNode(
        `mkt-mob-d-${i}`,
        mc,
        "text",
        "亮点说明",
        {
          width: 310,
          height: 36,
          fontSize: 12.5,
          lineHeight: 18,
          color: "#96a0bc",
        },
        { text: desc, variableBindings: { color: "textSecondary" } },
      ),
    );
  }

  return nodes;
}

function buildWorkspacePage(): DesignNode[] {
  const nodes: DesignNode[] = [];
  const push = (n: DesignNode) => {
    nodes.push(n);
    return n.id;
  };

  // === DESKTOP SAAS PRODUCT WORKSPACE (1440 x 900) ===
  const ws = push(
    makeNode(
      "ws-desktop",
      null,
      "frame",
      "Aura Analytics · 产品工作台 (1440×900)",
      {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        fill: "#0b0d14",
        clipContent: true,
        viewportWidth: true,
        layout: "row",
      },
      {
        variableBindings: { fill: "bgCanvas" },
        interaction: { flow: "SaaS 产品工作台" },
      },
    ),
  );

  // Sidebar (248px)
  const sidebar = push(
    makeNode(
      "ws-sidebar",
      ws,
      "frame",
      "左侧导航栏",
      {
        width: 248,
        height: 900,
        heightMode: "fill",
        fill: "#131724",
        stroke: "#262e45",
        strokeWidth: 1,
        layout: "column",
        insets: { top: 20, right: 14, bottom: 20, left: 14 },
        gap: 6,
      },
      { variableBindings: { fill: "bgSurface", stroke: "borderSubtle" } },
    ),
  );

  // Workspace switcher
  const wsHeader = push(
    makeNode(
      "ws-brand-row",
      sidebar,
      "frame",
      "工作区切换器",
      {
        width: 220,
        height: 44,
        widthMode: "fill",
        radius: 10,
        fill: "#1a2033",
        layout: "row",
        alignY: "center",
        insets: { top: 0, right: 12, bottom: 0, left: 12 },
        gap: 10,
      },
      {
        variableBindings: { fill: "bgSubtle" },
        interaction: {
          actions: [{ kind: "navigate", target: "mkt-desktop" }],
        },
      },
    ),
  );
  push(
    makeNode("ws-brand-dot", wsHeader, "frame", "工作区徽标", {
      width: 26,
      height: 26,
      radius: 7,
      gradient: {
        type: "linear",
        angle: 135,
        stops: [
          {
            offset: 0,
            color: "#8b6eff",
            opacity: 1,
            variableId: "brandPrimary",
          },
          { offset: 1, color: "#38bdf8", opacity: 1, variableId: "statusCyan" },
        ],
      },
    }),
  );
  push(
    makeNode(
      "ws-brand-title",
      wsHeader,
      "text",
      "工作区名",
      {
        width: 140,
        height: 18,
        fontSize: 13,
        fontWeight: 700,
        color: "#f5f7ff",
      },
      { text: "Aura Cloud · 生产", variableBindings: { color: "textPrimary" } },
    ),
  );

  const navItems = [
    [
      "总览仪表盘",
      true,
      "M3 13h8V3H3v10zm10 8h8V11h-8v10zM3 21h8v-6H3v6zm10-18v6h8V3h-8z",
    ],
    ["实时部署流", false, "M13 2L3 14h9l-1 8 10-12h-9l1-8z"],
    ["设计系统库", false, "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5"],
    ["性能基准", false, "M3 17l6-6 4 4 8-8"],
    ["团队成员", false, "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"],
    ["网关与安全", false, "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"],
  ] as const;

  for (const [i, [label, active, iconPath]] of navItems.entries()) {
    const item = push(
      makeNode(
        `ws-nav-${i}`,
        sidebar,
        "frame",
        `导航项 · ${label}`,
        {
          width: 220,
          height: 38,
          widthMode: "fill",
          radius: 9,
          fill: active ? "#221b47" : "#000000",
          fillOpacity: active ? 1 : 0,
          layout: "row",
          alignY: "center",
          insets: { top: 0, right: 12, bottom: 0, left: 12 },
          gap: 10,
        },
        active ? { variableBindings: { fill: "brandSoft" } } : {},
      ),
    );
    push(
      makeNode(
        `ws-nav-ico-${i}`,
        item,
        "vector",
        `图标 · ${label}`,
        { width: 16, height: 16, color: active ? "#a78bfa" : "#96a0bc" },
        {
          vector: {
            width: 24,
            height: 24,
            paths: [
              {
                d: iconPath,
                fill: false,
                strokeWidth: 2,
                lineCap: "round",
                lineJoin: "round",
              },
            ],
          },
        },
      ),
    );
    push(
      makeNode(
        `ws-nav-lbl-${i}`,
        item,
        "text",
        label,
        {
          width: 150,
          height: 18,
          fontSize: 13,
          fontWeight: active ? 600 : 500,
          color: active ? "#f5f7ff" : "#96a0bc",
        },
        {
          text: label,
          variableBindings: { color: active ? "textPrimary" : "textSecondary" },
        },
      ),
    );
  }

  // Quota card pinned lower in sidebar
  const quota = push(
    makeNode(
      "ws-quota",
      sidebar,
      "frame",
      "资源配额卡片",
      {
        width: 220,
        height: 112,
        widthMode: "fill",
        radius: 12,
        fill: "#1a2033",
        stroke: "#262e45",
        strokeWidth: 1,
        layout: "column",
        insets: { top: 14, right: 14, bottom: 14, left: 14 },
        gap: 10,
      },
      { variableBindings: { fill: "bgSubtle", stroke: "borderSubtle" } },
    ),
  );
  push(
    makeNode(
      "ws-quota-t",
      quota,
      "text",
      "配额标题",
      {
        width: 190,
        height: 16,
        fontSize: 12,
        fontWeight: 600,
        color: "#f5f7ff",
      },
      {
        text: "本月编译配额 · 74%",
        variableBindings: { color: "textPrimary" },
      },
    ),
  );
  const qTrack = push(
    makeNode("ws-quota-track", quota, "frame", "进度条底轨", {
      width: 190,
      height: 7,
      widthMode: "fill",
      radius: 99,
      fill: "#262e45",
      clipContent: true,
    }),
  );
  push(
    makeNode("ws-quota-bar", qTrack, "rectangle", "进度条填充", {
      x: 0,
      y: 0,
      width: 142,
      height: 7,
      radius: 99,
      gradient: {
        type: "linear",
        angle: 90,
        stops: [
          { offset: 0, color: "#7c5cff", opacity: 1 },
          { offset: 1, color: "#38bdf8", opacity: 1, variableId: "statusCyan" },
        ],
      },
    }),
  );
  push(
    makeNode(
      "ws-quota-sub",
      quota,
      "text",
      "配额详情",
      {
        width: 190,
        height: 32,
        fontSize: 11,
        lineHeight: 16,
        color: "#96a0bc",
      },
      {
        text: "已导出 148 / 200 个独立 React 工程包",
        variableBindings: { color: "textSecondary" },
      },
    ),
  );

  // === MAIN DASHBOARD CONTENT ===
  const main = push(
    makeNode("ws-main", ws, "frame", "主工作区内容", {
      width: 1192,
      height: 900,
      widthMode: "fill",
      heightMode: "fill",
      fill: "#000000",
      fillOpacity: 0,
      layout: "column",
      insets: { top: 24, right: 28, bottom: 24, left: 28 },
      gap: 20,
    }),
  );

  // Top Command Header
  const topBar = push(
    makeNode("ws-topbar", main, "frame", "顶部操作栏", {
      width: 1136,
      height: 48,
      widthMode: "fill",
      fill: "#000000",
      fillOpacity: 0,
      layout: "row",
      alignY: "center",
      gap: 14,
    }),
  );
  const titleBlock = push(
    makeNode("ws-title-block", topBar, "frame", "页面标题区", {
      width: 460,
      height: 44,
      widthMode: "fill",
      fill: "#000000",
      fillOpacity: 0,
      layout: "column",
      gap: 2,
    }),
  );
  push(
    makeNode(
      "ws-h1",
      titleBlock,
      "text",
      "仪表盘标题",
      {
        width: 360,
        height: 26,
        fontSize: 22,
        fontWeight: 700,
        letterSpacing: -0.5,
        color: "#f5f7ff",
      },
      {
        text: "系统运行与交付总览",
        variableBindings: { color: "textPrimary" },
      },
    ),
  );
  push(
    makeNode(
      "ws-h1-sub",
      titleBlock,
      "text",
      "更新时间",
      { width: 320, height: 16, fontSize: 12, color: "#96a0bc" },
      {
        text: "全部 4 个集群运行正常 · 最近同步于 12 秒前",
        variableBindings: { color: "textSecondary" },
      },
    ),
  );

  // Search box (interactive textfield control)
  push(
    makeNode(
      "ws-search",
      topBar,
      "frame",
      "搜索项目与部署",
      {
        width: 240,
        height: 38,
        radius: 10,
        fill: "#131724",
        stroke: "#262e45",
        strokeWidth: 1,
      },
      {
        variableBindings: { fill: "bgSurface", stroke: "borderSubtle" },
        control: {
          kind: "textfield",
          label: "搜索部署记录",
          value: "",
        },
      },
    ),
  );

  // Primary "+ 新建部署" button opening Modal Overlay
  const newBtn = push(
    makeNode(
      "ws-new-deploy",
      topBar,
      "frame",
      "新建部署按钮",
      {
        width: 136,
        height: 38,
        radius: 10,
        gradient: {
          type: "linear",
          angle: 135,
          stops: [
            { offset: 0, color: "#8a6bff", opacity: 1 },
            { offset: 1, color: "#5e3ff4", opacity: 1 },
          ],
        },
        layout: "row",
        alignX: "center",
        alignY: "center",
      },
      {
        interaction: {
          actions: [
            {
              kind: "overlay",
              target: "ws-deploy-modal",
              position: "center",
            },
          ],
        },
      },
    ),
  );
  push(
    makeNode(
      "ws-new-deploy-t",
      newBtn,
      "text",
      "新建部署文字",
      {
        width: 104,
        height: 18,
        fontSize: 13,
        fontWeight: 600,
        color: "#ffffff",
        textAlign: "center",
      },
      { text: "+ 新建部署任务" },
    ),
  );

  // 4-Column KPI Row
  const kpiGrid = push(
    makeNode("ws-kpi-grid", main, "frame", "核心 KPI 卡片组", {
      width: 1136,
      height: 114,
      widthMode: "fill",
      fill: "#000000",
      fillOpacity: 0,
      layout: "grid",
      columns: 4,
      gap: 16,
    }),
  );
  const kpis = [
    [
      "月经常性收入",
      "¥482,900",
      "+18.4%",
      "#22c55e",
      "M2 22 L18 18 L34 20 L50 10 L66 12 L84 4",
    ],
    [
      "活跃协作团队",
      "1,284",
      "+11.2%",
      "#38bdf8",
      "M2 24 L20 20 L38 14 L54 16 L70 8 L84 6",
    ],
    [
      "画布 P95 帧时",
      "16.8 ms",
      "-48.5%",
      "#22c55e",
      "M2 6 L18 10 L36 16 L54 18 L70 21 L84 22",
    ],
    [
      "工程导出成功率",
      "99.94%",
      "+0.6%",
      "#a78bfa",
      "M2 16 L20 14 L38 12 L54 10 L70 8 L84 6",
    ],
  ] as const;
  for (const [i, [label, val, delta, color, spark]] of kpis.entries()) {
    const kc = push(
      makeNode(
        `ws-kpi-${i}`,
        kpiGrid,
        "frame",
        `KPI · ${label}`,
        {
          width: 272,
          height: 112,
          widthMode: "fill",
          radius: 14,
          fill: "#131724",
          stroke: "#262e45",
          strokeWidth: 1,
          layout: "column",
          insets: { top: 16, right: 18, bottom: 16, left: 18 },
          gap: 8,
        },
        { variableBindings: { fill: "bgSurface", stroke: "borderSubtle" } },
      ),
    );
    const headerRow = push(
      makeNode(`ws-kpi-hr-${i}`, kc, "frame", "标题与趋势", {
        width: 236,
        height: 20,
        widthMode: "fill",
        fill: "#000000",
        fillOpacity: 0,
        layout: "row",
        alignY: "center",
        gap: 8,
      }),
    );
    push(
      makeNode(
        `ws-kpi-l-${i}`,
        headerRow,
        "text",
        "标签",
        {
          width: 160,
          height: 16,
          widthMode: "fill",
          fontSize: 12,
          color: "#96a0bc",
        },
        { text: label, variableBindings: { color: "textSecondary" } },
      ),
    );
    push(
      makeNode(
        `ws-kpi-d-${i}`,
        headerRow,
        "text",
        "环比",
        {
          width: 56,
          height: 16,
          fontSize: 11,
          fontWeight: 600,
          color,
          textAlign: "right",
        },
        { text: delta },
      ),
    );
    const valRow = push(
      makeNode(`ws-kpi-vr-${i}`, kc, "frame", "数值与迷你图", {
        width: 236,
        height: 44,
        widthMode: "fill",
        fill: "#000000",
        fillOpacity: 0,
        layout: "row",
        alignY: "end",
        gap: 8,
      }),
    );
    push(
      makeNode(
        `ws-kpi-v-${i}`,
        valRow,
        "text",
        "数值",
        {
          width: 142,
          height: 32,
          widthMode: "fill",
          fontSize: 24,
          fontWeight: 700,
          letterSpacing: -0.6,
          color: "#f5f7ff",
        },
        { text: val, variableBindings: { color: "textPrimary" } },
      ),
    );
    push(
      makeNode(
        `ws-kpi-sp-${i}`,
        valRow,
        "vector",
        "趋势折线",
        { width: 86, height: 28, color },
        {
          vector: {
            width: 86,
            height: 28,
            paths: [
              { d: spark, fill: false, strokeWidth: 2, lineCap: "round" },
            ],
          },
        },
      ),
    );
  }

  // Middle Row: Revenue Chart (Left) + Activity Feed (Right)
  const midRow = push(
    makeNode("ws-mid-row", main, "frame", "分析图表与动态区", {
      width: 1136,
      height: 364,
      widthMode: "fill",
      fill: "#000000",
      fillOpacity: 0,
      layout: "row",
      gap: 18,
    }),
  );

  // Left Chart Card
  const chartCard = push(
    makeNode(
      "ws-chart-card",
      midRow,
      "frame",
      "流量与工程构建趋势卡",
      {
        width: 774,
        height: 364,
        widthMode: "fill",
        radius: 16,
        fill: "#131724",
        stroke: "#262e45",
        strokeWidth: 1,
        layout: "column",
        insets: { top: 20, right: 22, bottom: 18, left: 22 },
        gap: 14,
      },
      { variableBindings: { fill: "bgSurface", stroke: "borderSubtle" } },
    ),
  );
  push(
    makeNode(
      "ws-chart-h",
      chartCard,
      "text",
      "图表标题",
      {
        width: 420,
        height: 22,
        fontSize: 15,
        fontWeight: 600,
        color: "#f5f7ff",
      },
      {
        text: "近 30 日设计稿编译与组件调用量",
        variableBindings: { color: "textPrimary" },
      },
    ),
  );
  push(
    makeNode(
      "ws-main-chart",
      chartCard,
      "vector",
      "面积趋势图",
      { width: 730, height: 248, widthMode: "fill", color: "#7c5cff" },
      {
        vector: {
          width: 730,
          height: 248,
          stretch: true,
          paths: [
            {
              d: "M0 44 H730 M0 104 H730 M0 164 H730 M0 224 H730",
              fill: false,
              strokeColor: "#334155",
              strokeOpacity: 0.35,
              strokeWidth: 1,
            },
            {
              d: "M0 200 C70 184, 130 154, 210 142 C290 130, 350 156, 430 108 C510 60, 580 78, 650 42 C686 24, 710 28, 730 18 L730 224 L0 224 Z",
              fill: true,
              fillColor: "#7c5cff",
              fillOpacity: 0.24,
              strokeWidth: 0,
            },
            {
              d: "M0 200 C70 184, 130 154, 210 142 C290 130, 350 156, 430 108 C510 60, 580 78, 650 42 C686 24, 710 28, 730 18",
              fill: false,
              strokeColor: "#8b6eff",
              strokeWidth: 3,
              lineCap: "round",
            },
            {
              d: "M0 212 C90 198, 170 180, 260 176 C350 172, 440 144, 530 124 C610 108, 670 92, 730 76",
              fill: false,
              strokeColor: "#38bdf8",
              strokeWidth: 2.2,
              lineCap: "round",
            },
          ],
        },
      },
    ),
  );
  push(
    makeNode(
      "ws-chart-axis",
      chartCard,
      "text",
      "横轴刻度",
      {
        width: 730,
        height: 16,
        widthMode: "fill",
        fontFamily: MONO,
        fontSize: 11,
        color: "#64748b",
      },
      {
        text: "10/20          10/26          11/01          11/07          11/13          11/19",
        variableBindings: { color: "textSecondary" },
      },
    ),
  );

  // Right Live Activity Feed Card
  const feedCard = push(
    makeNode(
      "ws-feed-card",
      midRow,
      "frame",
      "实时团队动态卡",
      {
        width: 344,
        height: 364,
        radius: 16,
        fill: "#131724",
        stroke: "#262e45",
        strokeWidth: 1,
        layout: "column",
        insets: { top: 20, right: 18, bottom: 18, left: 18 },
        gap: 12,
      },
      { variableBindings: { fill: "bgSurface", stroke: "borderSubtle" } },
    ),
  );
  push(
    makeNode(
      "ws-feed-h",
      feedCard,
      "text",
      "动态标题",
      {
        width: 280,
        height: 22,
        fontSize: 15,
        fontWeight: 600,
        color: "#f5f7ff",
      },
      {
        text: "设计系统与发布动态",
        variableBindings: { color: "textPrimary" },
      },
    ),
  );
  const events = [
    ["林栀", "发布 Design Tokens v4.2", "2 分钟前", "#7c5cff"],
    ["陈屿", "导出 Marketing Landing ZIP", "14 分钟前", "#38bdf8"],
    ["苏明", "合并 12 个 iPad 导航变体", "38 分钟前", "#22c55e"],
    ["顾清", "更新了复杂画板拖动记录", "1 小时前", "#f59e0b"],
  ] as const;
  for (const [i, [who, action, time, dot]] of events.entries()) {
    const row = push(
      makeNode(
        `ws-ev-${i}`,
        feedCard,
        "frame",
        `动态 · ${who}`,
        {
          width: 308,
          height: 62,
          widthMode: "fill",
          radius: 10,
          fill: "#1a2033",
          layout: "row",
          alignY: "center",
          insets: { top: 10, right: 12, bottom: 10, left: 12 },
          gap: 10,
        },
        { variableBindings: { fill: "bgSubtle" } },
      ),
    );
    const av = push(
      makeNode(`ws-ev-av-${i}`, row, "frame", "头像", {
        width: 32,
        height: 32,
        radius: 16,
        fill: dot,
        layout: "row",
        alignX: "center",
        alignY: "center",
      }),
    );
    push(
      makeNode(
        `ws-ev-avt-${i}`,
        av,
        "text",
        "首字",
        {
          width: 24,
          height: 16,
          fontSize: 12,
          fontWeight: 700,
          color: "#ffffff",
          textAlign: "center",
        },
        { text: who[0] },
      ),
    );
    const info = push(
      makeNode(`ws-ev-inf-${i}`, row, "frame", "详情", {
        width: 220,
        height: 38,
        widthMode: "fill",
        fill: "#000000",
        fillOpacity: 0,
        layout: "column",
        gap: 2,
      }),
    );
    push(
      makeNode(
        `ws-ev-act-${i}`,
        info,
        "text",
        "事件",
        {
          width: 220,
          height: 18,
          fontSize: 12.5,
          fontWeight: 600,
          color: "#f5f7ff",
        },
        {
          text: `${who} · ${action}`,
          variableBindings: { color: "textPrimary" },
        },
      ),
    );
    push(
      makeNode(
        `ws-ev-tm-${i}`,
        info,
        "text",
        "时间",
        { width: 160, height: 16, fontSize: 11, color: "#96a0bc" },
        { text: time, variableBindings: { color: "textSecondary" } },
      ),
    );
  }

  // Bottom Recent Deployments Table Card
  const table = push(
    makeNode(
      "ws-table-card",
      main,
      "frame",
      "最近交付记录表格",
      {
        width: 1136,
        height: 256,
        widthMode: "fill",
        radius: 16,
        fill: "#131724",
        stroke: "#262e45",
        strokeWidth: 1,
        layout: "column",
        insets: { top: 18, right: 20, bottom: 16, left: 20 },
        gap: 10,
      },
      { variableBindings: { fill: "bgSurface", stroke: "borderSubtle" } },
    ),
  );
  push(
    makeNode(
      "ws-table-h",
      table,
      "text",
      "表格标题",
      {
        width: 320,
        height: 22,
        fontSize: 15,
        fontWeight: 600,
        color: "#f5f7ff",
      },
      {
        text: "近期工程导出与预览构建",
        variableBindings: { color: "textPrimary" },
      },
    ),
  );
  const rowsData = [
    ["aura-marketing-web", "main · 2f91c4", "构建通过", "1.92 s", "#22c55e"],
    ["field-atlas-tablet", "release/2.0", "构建通过", "2.04 s", "#22c55e"],
    ["soundspace-h5-player", "feat/dark-mode", "验证中", "0.84 s", "#38bdf8"],
  ] as const;
  for (const [i, [proj, branch, status, dur, col]] of rowsData.entries()) {
    const tr = push(
      makeNode(
        `ws-tr-${i}`,
        table,
        "frame",
        `记录 · ${proj}`,
        {
          width: 1096,
          height: 52,
          widthMode: "fill",
          radius: 10,
          fill: "#1a2033",
          layout: "row",
          alignY: "center",
          insets: { top: 0, right: 16, bottom: 0, left: 16 },
          gap: 16,
        },
        { variableBindings: { fill: "bgSubtle" } },
      ),
    );
    push(
      makeNode(
        `ws-tr-p-${i}`,
        tr,
        "text",
        "项目名",
        {
          width: 340,
          height: 18,
          widthMode: "fill",
          fontSize: 13,
          fontWeight: 600,
          color: "#f5f7ff",
        },
        { text: proj, variableBindings: { color: "textPrimary" } },
      ),
    );
    push(
      makeNode(
        `ws-tr-b-${i}`,
        tr,
        "text",
        "分支",
        {
          width: 220,
          height: 18,
          fontFamily: MONO,
          fontSize: 12,
          color: "#96a0bc",
        },
        { text: branch, variableBindings: { color: "textSecondary" } },
      ),
    );
    const stPill = push(
      makeNode(`ws-tr-st-${i}`, tr, "frame", "状态标签", {
        width: 92,
        height: 26,
        radius: 99,
        fill: col,
        fillOpacity: 0.16,
        layout: "row",
        alignX: "center",
        alignY: "center",
      }),
    );
    push(
      makeNode(
        `ws-tr-stt-${i}`,
        stPill,
        "text",
        "状态字",
        {
          width: 76,
          height: 15,
          fontSize: 11.5,
          fontWeight: 600,
          color: col,
          textAlign: "center",
        },
        { text: status },
      ),
    );
    push(
      makeNode(
        `ws-tr-d-${i}`,
        tr,
        "text",
        "耗时",
        {
          width: 90,
          height: 18,
          fontFamily: MONO,
          fontSize: 12,
          color: "#96a0bc",
          textAlign: "right",
        },
        { text: dur, variableBindings: { color: "textSecondary" } },
      ),
    );
  }

  // === INTERACTIVE MODAL OVERLAY: 新建部署任务 ===
  const modal = push(
    makeNode(
      "ws-deploy-modal",
      null,
      "frame",
      "新建部署任务 · 浮层",
      {
        x: 1520,
        y: 120,
        width: 440,
        height: 410,
        radius: 20,
        fill: "#131724",
        stroke: "#262e45",
        strokeWidth: 1,
        layout: "column",
        insets: { top: 24, right: 24, bottom: 24, left: 24 },
        gap: 16,
        shadows: [
          {
            x: 0,
            y: 24,
            blur: 64,
            spread: -8,
            color: "#000000",
            opacity: 0.65,
            inset: false,
          },
        ],
      },
      { variableBindings: { fill: "bgSurface", stroke: "borderSubtle" } },
    ),
  );
  push(
    makeNode(
      "ws-modal-h",
      modal,
      "text",
      "弹窗标题",
      {
        width: 392,
        height: 24,
        fontSize: 18,
        fontWeight: 700,
        color: "#f5f7ff",
      },
      {
        text: "新建 React 生产部署任务",
        variableBindings: { color: "textPrimary" },
      },
    ),
  );
  push(
    makeNode(
      "ws-modal-sub",
      modal,
      "text",
      "弹窗副标题",
      {
        width: 392,
        height: 36,
        fontSize: 13,
        lineHeight: 19,
        color: "#96a0bc",
      },
      {
        text: "自动打包当前画板、Design Tokens 与交互原型运行时至独立构建产物。",
        variableBindings: { color: "textSecondary" },
      },
    ),
  );
  push(
    makeNode(
      "ws-modal-input",
      modal,
      "frame",
      "项目包名称输入框",
      {
        width: 392,
        height: 42,
        widthMode: "fill",
        radius: 10,
        fill: "#1a2033",
        stroke: "#262e45",
        strokeWidth: 1,
      },
      {
        variableBindings: { fill: "bgSubtle", stroke: "borderSubtle" },
        control: {
          kind: "textfield",
          label: "项目包名称",
          value: "aura-release-v2",
        },
      },
    ),
  );
  const swRow = push(
    makeNode(
      "ws-modal-sw-row",
      modal,
      "frame",
      "开启暗色模式开关行",
      {
        width: 392,
        height: 48,
        widthMode: "fill",
        radius: 10,
        fill: "#1a2033",
        layout: "row",
        alignY: "center",
        insets: { top: 0, right: 14, bottom: 0, left: 14 },
        gap: 12,
      },
      { variableBindings: { fill: "bgSubtle" } },
    ),
  );
  push(
    makeNode(
      "ws-modal-sw-lbl",
      swRow,
      "text",
      "开关标签",
      {
        width: 280,
        height: 18,
        widthMode: "fill",
        fontSize: 13,
        fontWeight: 500,
        color: "#f5f7ff",
      },
      {
        text: "导出包含双主题 CSS Variables",
        variableBindings: { color: "textPrimary" },
      },
    ),
  );
  push(
    makeNode(
      "ws-modal-sw",
      swRow,
      "frame",
      "双主题开关",
      { width: 46, height: 26, radius: 99, fill: "#7c5cff" },
      {
        control: {
          kind: "switch",
          label: "包含双主题变量",
          value: true,
        },
      },
    ),
  );

  const modalBtns = push(
    makeNode("ws-modal-btns", modal, "frame", "弹窗操作按钮", {
      width: 392,
      height: 44,
      widthMode: "fill",
      fill: "#000000",
      fillOpacity: 0,
      layout: "row",
      alignX: "end",
      alignY: "center",
      gap: 10,
    }),
  );
  const cancelBtn = push(
    makeNode(
      "ws-modal-cancel",
      modalBtns,
      "frame",
      "取消按钮",
      {
        width: 96,
        height: 40,
        radius: 10,
        fill: "#1a2033",
        stroke: "#262e45",
        strokeWidth: 1,
        layout: "row",
        alignX: "center",
        alignY: "center",
      },
      {
        variableBindings: { fill: "bgSubtle", stroke: "borderSubtle" },
        interaction: { actions: [{ kind: "close" }] },
      },
    ),
  );
  push(
    makeNode(
      "ws-modal-cancel-t",
      cancelBtn,
      "text",
      "取消文字",
      {
        width: 60,
        height: 18,
        fontSize: 13,
        color: "#96a0bc",
        textAlign: "center",
      },
      { text: "取消", variableBindings: { color: "textSecondary" } },
    ),
  );
  const confirmBtn = push(
    makeNode(
      "ws-modal-confirm",
      modalBtns,
      "frame",
      "确认触发部署",
      {
        width: 148,
        height: 40,
        radius: 10,
        gradient: {
          type: "linear",
          angle: 135,
          stops: [
            { offset: 0, color: "#8a6bff", opacity: 1 },
            { offset: 1, color: "#5e3ff4", opacity: 1 },
          ],
        },
        layout: "row",
        alignX: "center",
        alignY: "center",
      },
      {
        interaction: { actions: [{ kind: "close" }] },
      },
    ),
  );
  push(
    makeNode(
      "ws-modal-confirm-t",
      confirmBtn,
      "text",
      "确认文字",
      {
        width: 120,
        height: 18,
        fontSize: 13,
        fontWeight: 600,
        color: "#ffffff",
        textAlign: "center",
      },
      { text: "立即触发部署" },
    ),
  );

  return nodes;
}

const marketingNodes = buildMarketingPage();
const workspaceNodes = buildWorkspacePage();

const rawDoc: DesignDocument = {
  schemaVersion: 1,
  id: "aura-showcase-v1",
  name: "Aura Studio · SaaS 产品与营销界面",
  revision: 0,
  activePage: "marketing",
  pages: [
    { id: "marketing", name: "01  营销官网 · Marketing Landing" },
    {
      id: "workspace",
      name: "02  产品工作台 · SaaS Analytics",
      nodes: workspaceNodes,
    },
  ],
  nodes: marketingNodes,
  tokens: {},
  designSystem: system,
};

const document = parseDocument(rawDoc);
mkdirSync("public/examples", { recursive: true });
writeFileSync(
  "public/examples/aura-showcase.forma.json",
  JSON.stringify(document, null, 2),
);
console.table(
  document.pages!.map((p) => {
    const pageNodes = openPage(document, p.id).nodes;
    return {
      page: p.name,
      boards: pageNodes.filter((n) => !n.parentId).length,
      layers: pageNodes.length,
      vectors: pageNodes.filter((n) => n.type === "vector").length,
      variablesBound: pageNodes.filter((n) => !!n.variableBindings).length,
    };
  }),
);
