import { MobileBuilder } from "./mobile-foundations";
import type { MobileDefinition } from "./mobile-controls";
const material = { Material: ["Solid", "Glass"] };
export const surfaceDefinitions: MobileDefinition[] = [
  {
    id: "navigation",
    name: "导航栏 Navigation",
    category: "导航",
    description: "紧凑与大标题导航，独立返回和操作图层。",
    axes: { Title: ["Large", "Inline"], ...material },
    build(a, p) {
      const large = p.Title === "Large",
        b = new MobileBuilder(a, "导航栏", 390, large ? 116 : 56);
      b.root.style.radius = 0;
      if (p.Material === "Glass") b.glass();
      b.icon("back", "back", 16, 16, 24, b.theme.accent);
      b.text("back-label", "返回", 44, 16, 72, 16, { color: b.theme.accent });
      b.icon("action", "more", 346, 16, 24, b.theme.accent);
      b.text(
        "title",
        "资料库",
        large ? 20 : 110,
        large ? 62 : 14,
        large ? 320 : 170,
        large ? 32 : 18,
        { fontWeight: 700, textAlign: large ? "left" : "center" },
      );
      return b;
    },
  },
  {
    id: "tab-bar",
    name: "标签栏 Tab Bar",
    category: "导航",
    description: "三项底部导航，当前项变体。",
    axes: { Selected: ["Home", "Explore", "Profile"], ...material },
    build(a, p) {
      const b = new MobileBuilder(a, "标签栏", 358, 72),
        active = ["Home", "Explore", "Profile"].indexOf(p.Selected);
      b.root.style.radius = 32;
      if (p.Material === "Glass") b.glass();
      b.box("active", 12 + active * 112, 8, 110, 56, {
        fill: b.theme.tint,
        radius: 26,
      });
      (["home", "grid", "person"] as const).forEach((icon, i) => {
        b.icon(
          `icon-${i}`,
          icon,
          54 + i * 112,
          16,
          24,
          i === active ? b.theme.accent : b.theme.muted,
        );
        b.text(
          `label-${i}`,
          ["首页", "发现", "我的"][i],
          12 + i * 112,
          43,
          110,
          11,
          {
            textAlign: "center",
            fontWeight: 600,
            color: i === active ? b.theme.accent : b.theme.muted,
          },
        );
      });
      return b;
    },
  },
  {
    id: "toolbar",
    name: "工具栏 Toolbar",
    category: "导航",
    description: "底部操作栏与独立图标。",
    axes: material,
    build(a, p) {
      const b = new MobileBuilder(a, "工具栏", 340, 56);
      b.root.style.radius = 28;
      if (p.Material === "Glass") b.glass();
      (["back", "forward", "share", "heart", "more"] as const).forEach(
        (icon, i) =>
          b.icon(`tool-${i}`, icon, 22 + i * 67, 16, 24, b.theme.accent),
      );
      return b;
    },
  },
  {
    id: "sidebar",
    name: "侧边栏 Sidebar",
    category: "导航",
    description: "适用于平板的分组导航与当前项。",
    axes: material,
    build(a, p) {
      const b = new MobileBuilder(a, "侧边栏", 280, 500);
      if (p.Material === "Glass") b.glass();
      b.text("title", "工作空间", 24, 28, 220, 24, { fontWeight: 700 });
      b.box("search", 16, 86, 248, 40, { fill: b.theme.secondary, radius: 12 });
      b.icon("search-icon", "search", 28, 96, 20, b.theme.muted);
      b.text("search-label", "搜索", 60, 94, 180, 15, { color: b.theme.muted });
      ["概览", "全部文件", "与我共享", "收藏", "最近删除"].forEach(
        (label, i) => {
          if (i === 0)
            b.box("active", 12, 150, 256, 46, {
              fill: b.theme.tint,
              radius: 14,
            });
          b.icon(
            `icon-${i}`,
            (["home", "folder", "person", "heart", "more"] as const)[i],
            26,
            162 + i * 54,
            22,
            i === 0 ? b.theme.accent : b.theme.muted,
          );
          b.text(`label-${i}`, label, 62, 160 + i * 54, 190, 16, {
            color: i === 0 ? b.theme.accent : b.theme.text,
            fontWeight: i === 0 ? 600 : 400,
          });
        },
      );
      b.text("footer", "个人空间 · 12 个文件", 24, 458, 230, 12, {
        color: b.theme.muted,
      });
      return b;
    },
  },
  {
    id: "list-row",
    name: "列表行 List Row",
    category: "内容",
    description: "基础行、副标题、开关附件三种布局。",
    axes: { Accessory: ["Chevron", "Subtitle", "Toggle"] },
    build(a, p) {
      const h = p.Accessory === "Subtitle" ? 76 : 60,
        b = new MobileBuilder(a, "列表行", 350, h);
      b.root.style.radius = 0;
      b.box("icon-bg", 16, (h - 32) / 2, 32, 32, {
        fill: b.theme.tint,
        radius: 9,
      });
      b.icon("icon", "bell", 22, (h - 20) / 2, 20, b.theme.accent);
      b.text(
        "title",
        "通知",
        62,
        p.Accessory === "Subtitle" ? 14 : 18,
        205,
        17,
      );
      if (p.Accessory === "Subtitle")
        b.text("subtitle", "管理提醒与声音", 62, 42, 220, 13, {
          color: b.theme.muted,
        });
      if (p.Accessory === "Toggle") {
        b.box("toggle", 282, 16, 50, 30, { fill: b.theme.success, radius: 15 });
        b.box("thumb", 305, 19, 24, 24, { fill: "#ffffff", radius: 12 });
      } else b.icon("chevron", "forward", 314, (h - 18) / 2, 18, b.theme.muted);
      b.separator(h - 1, 62, 288);
      return b;
    },
  },
  {
    id: "card",
    name: "内容卡片 Card",
    category: "内容",
    description: "带视觉、标题、说明与行动入口的内容卡片。",
    axes: material,
    build(a, p) {
      const b = new MobileBuilder(a, "内容卡片", 340, 250);
      if (p.Material === "Glass") b.glass();
      b.box("art", 16, 16, 308, 110, { fill: b.theme.tint, radius: 14 });
      b.icon("art-symbol", "cloud", 144, 42, 52, b.theme.accent);
      b.text("title", "把灵感留在这里", 20, 144, 300, 21, { fontWeight: 700 });
      b.text("description", "整理收藏，让好想法随时可见。", 20, 180, 300, 14, {
        color: b.theme.muted,
      });
      b.text("action", "开始探索", 20, 216, 250, 15, {
        color: b.theme.accent,
        fontWeight: 600,
      });
      b.icon("arrow", "forward", 298, 216, 18, b.theme.accent);
      return b;
    },
  },
  {
    id: "alert",
    name: "提示对话框 Alert",
    category: "浮层",
    description: "单操作与双操作提示；所有文字可编辑。",
    axes: { Actions: ["Two", "One"] },
    build(a, p) {
      const b = new MobileBuilder(a, "提示对话框", 300, 198);
      b.glass();
      b.root.style.radius = 26;
      b.text("title", "保存更改？", 24, 24, 252, 20, {
        textAlign: "center",
        fontWeight: 700,
      });
      b.text(
        "message",
        "你的修改尚未保存。\n保存后可在所有设备查看。",
        24,
        64,
        252,
        14,
        { textAlign: "center", height: 44, color: b.theme.muted },
      );
      b.separator(140, 0, 300);
      if (p.Actions === "Two") {
        b.box("divider", 149, 140, 1, 58, { fill: b.theme.border });
        b.text("cancel", "取消", 0, 158, 150, 17, {
          textAlign: "center",
          color: b.theme.muted,
        });
      }
      b.text(
        "confirm",
        "保存",
        p.Actions === "Two" ? 150 : 0,
        158,
        p.Actions === "Two" ? 150 : 300,
        17,
        { textAlign: "center", color: b.theme.accent, fontWeight: 600 },
      );
      return b;
    },
  },
  {
    id: "action-sheet",
    name: "操作面板 Action Sheet",
    category: "浮层",
    description: "分组操作与独立取消区域。",
    build(a) {
      const b = new MobileBuilder(a, "操作面板", 358, 260);
      b.root.style.fillOpacity = 0;
      b.box("panel", 0, 0, 358, 194, {
        fill: b.theme.surface,
        radius: 24,
        fillOpacity: 0.94,
        backdropBlur: 24,
      });
      b.text("title", "选择操作", 20, 16, 318, 13, {
        textAlign: "center",
        color: b.theme.muted,
      });
      ["分享链接", "保存到文件", "删除项目"].forEach((label, i) => {
        b.separator(50 + i * 48, 0, 358);
        b.text(`action-${i}`, label, 20, 62 + i * 48, 318, 17, {
          textAlign: "center",
          color: i === 2 ? b.theme.danger : b.theme.accent,
        });
      });
      b.box("cancel-bg", 0, 206, 358, 54, {
        fill: b.theme.surface,
        radius: 24,
      });
      b.text("cancel", "取消", 20, 222, 318, 17, {
        textAlign: "center",
        fontWeight: 600,
        color: b.theme.accent,
      });
      return b;
    },
  },
  {
    id: "sheet",
    name: "半屏面板 Sheet",
    category: "浮层",
    description: "中等与全高容器，包含拖动柄和标题区。",
    axes: { Size: ["Medium", "Large"] },
    build(a, p) {
      const b = new MobileBuilder(
        a,
        "详情面板",
        390,
        p.Size === "Large" ? 720 : 420,
      );
      b.root.style.radius = 30;
      b.box("handle", 173, 10, 44, 5, { fill: b.theme.border, radius: 3 });
      b.text("title", "项目详情", 24, 42, 290, 24, { fontWeight: 700 });
      b.icon("close", "close", 338, 44, 24, b.theme.muted);
      b.text("description", "在这里组织内容与操作。", 24, 86, 342, 15, {
        color: b.theme.muted,
      });
      b.box("content", 24, 136, 342, b.root.style.height - 224, {
        fill: b.theme.secondary,
        radius: 18,
      });
      b.text("content-label", "内容区域", 44, 158, 302, 17, {
        color: b.theme.muted,
      });
      b.box("button", 24, b.root.style.height - 66, 342, 46, {
        fill: b.theme.accent,
        radius: 23,
      });
      b.text("button-label", "完成", 24, b.root.style.height - 54, 342, 17, {
        textAlign: "center",
        fontWeight: 600,
        color: "#ffffff",
      });
      return b;
    },
  },
  {
    id: "menu",
    name: "菜单 Menu",
    category: "浮层",
    description: "通用命令列表与危险项。",
    axes: material,
    build(a, p) {
      const b = new MobileBuilder(a, "菜单", 240, 204);
      if (p.Material === "Glass") b.glass();
      ["复制链接", "分享", "添加到收藏", "删除"].forEach((label, i) => {
        b.text(`label-${i}`, label, 18, 15 + i * 48, 164, 16, {
          color: i === 3 ? b.theme.danger : b.theme.text,
        });
        b.icon(
          `icon-${i}`,
          (["folder", "share", "heart", "close"] as const)[i],
          200,
          15 + i * 48,
          20,
          i === 3 ? b.theme.danger : b.theme.muted,
        );
        if (i < 3) b.separator(50 + i * 48, 12, 216);
      });
      return b;
    },
  },
  {
    id: "context-menu",
    name: "上下文菜单 Context Menu",
    category: "浮层",
    description: "预览区域与就地操作列表。",
    build(a) {
      const b = new MobileBuilder(a, "上下文菜单", 270, 308);
      b.glass();
      b.box("preview", 12, 12, 246, 120, { fill: b.theme.tint, radius: 16 });
      b.icon("preview-icon", "folder", 111, 48, 48, b.theme.accent);
      ["打开", "分享", "重命名"].forEach((label, i) => {
        b.text(`label-${i}`, label, 20, 150 + i * 48, 200, 16);
        if (i < 2) b.separator(184 + i * 48, 16, 238);
      });
      return b;
    },
  },
  {
    id: "popover",
    name: "气泡浮层 Popover",
    category: "浮层",
    description: "平板内容提示与行动入口。",
    build(a) {
      const b = new MobileBuilder(a, "气泡浮层", 300, 176);
      b.glass();
      b.text("title", "一起协作", 20, 20, 260, 18, { fontWeight: 600 });
      b.text(
        "message",
        "邀请成员加入空间，\n共同整理项目和灵感。",
        20,
        54,
        260,
        15,
        { height: 48, color: b.theme.muted },
      );
      b.text("action", "邀请成员", 20, 128, 260, 16, {
        color: b.theme.accent,
        fontWeight: 600,
      });
      return b;
    },
  },
  {
    id: "activity-view",
    name: "分享面板 Activity View",
    category: "浮层",
    description: "独立分享目标和操作，未接设备系统分享。",
    build(a) {
      const b = new MobileBuilder(a, "分享", 390, 348);
      b.box("handle", 173, 10, 44, 5, { fill: b.theme.border, radius: 3 });
      b.text("title", "分享设计方案", 24, 38, 310, 22, { fontWeight: 600 });
      ["信息", "邮件", "复制", "更多"].forEach((label, i) => {
        b.box(`tile-${i}`, 24 + i * 90, 94, 70, 64, {
          fill: b.theme.tint,
          radius: 18,
        });
        b.icon(
          `symbol-${i}`,
          (["person", "mail", "folder", "more"] as const)[i],
          45 + i * 90,
          112,
          28,
          b.theme.accent,
        );
        b.text(`label-${i}`, label, 24 + i * 90, 170, 70, 13, {
          textAlign: "center",
        });
      });
      ["复制链接", "保存到文件"].forEach((label, i) => {
        b.box(`row-${i}`, 20, 212 + i * 56, 350, 50, {
          fill: b.theme.secondary,
          radius: 14,
        });
        b.text(`row-text-${i}`, label, 38, 225 + i * 56, 300, 16);
      });
      return b;
    },
  },
  {
    id: "notification",
    name: "通知 Notification",
    category: "反馈",
    description: "紧凑与展开通知卡片。",
    axes: { Size: ["Compact", "Expanded"] },
    build(a, p) {
      const b = new MobileBuilder(
        a,
        "通知",
        358,
        p.Size === "Expanded" ? 156 : 106,
      );
      b.glass();
      b.box("icon-bg", 16, 16, 32, 32, { fill: b.theme.accent, radius: 9 });
      b.icon("icon", "bell", 22, 22, 20, "#ffffff");
      b.text("app", "Forma", 60, 17, 180, 14, { fontWeight: 600 });
      b.text("time", "现在", 282, 17, 56, 12, {
        textAlign: "right",
        color: b.theme.muted,
      });
      b.text("title", "你的项目有新动态", 16, 58, 326, 16, { fontWeight: 600 });
      b.text(
        "message",
        p.Size === "Expanded"
          ? "小满分享了一份新的设计方案。\n点击查看更新并留下反馈。"
          : "小满分享了一份新的设计方案。",
        16,
        82,
        326,
        14,
        { height: p.Size === "Expanded" ? 52 : 22, color: b.theme.muted },
      );
      return b;
    },
  },
  {
    id: "empty-state",
    name: "空状态 Empty State",
    category: "反馈",
    description: "图形、标题、辅助说明与行动入口。",
    build(a) {
      const b = new MobileBuilder(a, "空状态", 340, 270);
      b.root.style.fillOpacity = 0;
      b.box("illustration", 126, 20, 88, 88, {
        fill: b.theme.tint,
        radius: 28,
      });
      b.icon("symbol", "folder", 148, 42, 44, b.theme.accent);
      b.text("title", "这里还没有内容", 20, 134, 300, 22, {
        textAlign: "center",
        fontWeight: 600,
      });
      b.text("message", "创建第一个项目，让想法开始生长。", 20, 174, 300, 14, {
        textAlign: "center",
        color: b.theme.muted,
      });
      b.text("action", "创建项目", 20, 222, 300, 17, {
        textAlign: "center",
        color: b.theme.accent,
        fontWeight: 600,
      });
      return b;
    },
  },
  {
    id: "page-control",
    name: "分页指示 Page Control",
    category: "导航",
    description: "三个页面位置。",
    axes: { Page: ["1", "2", "3"] },
    build(a, p) {
      const b = new MobileBuilder(a, "分页指示", 80, 28);
      b.root.style.fillOpacity = 0;
      for (let i = 0; i < 3; i++)
        b.box(`dot-${i}`, 16 + i * 20, 10, 8, 8, {
          fill: i === Number(p.Page) - 1 ? b.theme.accent : b.theme.border,
          radius: 4,
        });
      return b;
    },
  },
  {
    id: "status-bar",
    name: "状态栏 Status Bar",
    category: "系统框架",
    description: "通用时间和连接指示，不包含设备商标或原始图形。",
    build(a) {
      const b = new MobileBuilder(a, "状态栏", 390, 52);
      b.root.style.fillOpacity = 0;
      b.text("time", "9:41", 28, 15, 70, 15, { fontWeight: 600 });
      [5, 8, 11, 14].forEach((h, i) =>
        b.box(`signal-${i}`, 292 + i * 5, 30 - h, 3, h, {
          fill: b.theme.text,
          radius: 1,
        }),
      );
      b.box("battery", 330, 17, 28, 13, {
        fillOpacity: 0,
        stroke: b.theme.text,
        strokeWidth: 1,
        radius: 4,
      });
      b.box("battery-fill", 333, 20, 20, 7, { fill: b.theme.text, radius: 1 });
      b.box("battery-cap", 360, 21, 2, 5, { fill: b.theme.muted, radius: 1 });
      return b;
    },
  },
  {
    id: "home-indicator",
    name: "手势指示 Home Indicator",
    category: "系统框架",
    description: "底部安全区域与手势条。",
    build(a) {
      const b = new MobileBuilder(a, "手势指示", 390, 34);
      b.root.style.fillOpacity = 0;
      b.box("indicator", 128, 20, 134, 5, { fill: b.theme.text, radius: 3 });
      return b;
    },
  },
  {
    id: "menu-bar",
    name: "平板菜单栏 Menu Bar",
    category: "系统框架",
    description: "平板窗口菜单与状态。",
    build(a) {
      const b = new MobileBuilder(a, "平板菜单栏", 820, 32);
      b.root.style.radius = 0;
      b.glass();
      ["Forma", "文件", "编辑", "视图", "帮助"].forEach((label, i) =>
        b.text(`menu-${i}`, label, 16 + i * 64, 7, 60, 13, {
          fontWeight: i === 0 ? 700 : 400,
        }),
      );
      b.text("time", "周二  9:41", 696, 7, 108, 13, { textAlign: "right" });
      return b;
    },
  },
  {
    id: "widget",
    name: "信息小组件 Widget",
    category: "内容",
    description: "紧凑与宽版信息卡片。",
    axes: { Size: ["Small", "Medium"] },
    build(a, p) {
      const w = p.Size === "Medium" ? 356 : 170,
        b = new MobileBuilder(a, "今日概览", w, 170);
      b.root.style.fill = b.theme.tint;
      b.icon("sun", "sun", 18, 18, 30, b.theme.accent);
      b.text("title", "今天", 18, 62, w - 36, 14, { color: b.theme.muted });
      b.text("value", "24°", 18, 90, w - 36, 38, { fontWeight: 600 });
      b.text("caption", "晴朗 · 好心情", 18, 140, w - 36, 12, {
        color: b.theme.muted,
      });
      if (w > 200) {
        b.icon("cloud", "cloud", 250, 40, 60, b.theme.accent);
        b.text("forecast", "午后微风", 220, 116, 116, 14, {
          textAlign: "center",
        });
      }
      return b;
    },
  },
  {
    id: "app-tile",
    name: "应用图块 App Tile",
    category: "系统框架",
    description: "自研几何图块；不使用 Apple 应用图标。",
    build(a) {
      const b = new MobileBuilder(a, "应用图块", 72, 72);
      b.root.style.fill = b.theme.accent;
      b.root.style.radius = 21;
      b.icon("symbol", "grid", 20, 20, 32, "#ffffff");
      return b;
    },
  },
  {
    id: "authentication",
    name: "验证提示 Authentication",
    category: "反馈",
    description: "通用验证图形，不仿制 Face ID 标识或设备接口。",
    axes: { State: ["Ready", "Success"] },
    build(a, p) {
      const b = new MobileBuilder(a, "身份验证", 240, 208);
      b.glass();
      b.box("symbol-bg", 84, 24, 72, 72, { fill: b.theme.tint, radius: 24 });
      b.icon(
        "symbol",
        p.State === "Success" ? "check" : "shield",
        100,
        40,
        40,
        p.State === "Success" ? b.theme.success : b.theme.accent,
      );
      b.text(
        "title",
        p.State === "Success" ? "验证成功" : "确认你的身份",
        20,
        118,
        200,
        20,
        { textAlign: "center", fontWeight: 600 },
      );
      b.text(
        "message",
        p.State === "Success" ? "你可以继续操作" : "请使用设备的安全验证方式",
        20,
        158,
        200,
        13,
        { textAlign: "center", color: b.theme.muted },
      );
      return b;
    },
  },
  {
    id: "window",
    name: "平板窗口 Window",
    category: "系统框架",
    description: "带窗口工具区的平板内容容器；不模拟操作系统窗口管理。",
    axes: { Size: ["Regular", "Compact"] },
    build(a, p) {
      const w = p.Size === "Compact" ? 640 : 960,
        h = p.Size === "Compact" ? 480 : 600;
      const b = new MobileBuilder(a, "平板窗口", w, h);
      b.glass();
      b.root.style.clipContent = true;
      b.box("titlebar", 0, 0, w, 54, { fill: b.theme.secondary });
      b.icon("close", "close", 18, 17, 20, b.theme.muted);
      b.icon("menu", "more", 54, 17, 20, b.theme.muted);
      b.text("title", "项目工作空间", 100, 15, w - 200, 17, {
        fontWeight: 600,
        textAlign: "center",
      });
      b.box("sidebar", 0, 54, 200, h - 54, { fill: b.theme.canvas });
      ["全部项目", "最近打开", "收藏"].forEach((label, i) => {
        if (i === 0)
          b.box("selected", 12, 80, 176, 42, {
            fill: b.theme.tint,
            radius: 12,
          });
        b.text(`item-${i}`, label, 28, 90 + i * 52, 148, 15, {
          color: i === 0 ? b.theme.accent : b.theme.muted,
        });
      });
      b.text("heading", "最近的设计", 228, 90, w - 260, 26, {
        fontWeight: 700,
      });
      b.text("description", "在这里继续你的创作。", 228, 134, w - 260, 15, {
        color: b.theme.muted,
      });
      b.box("content", 228, 190, w - 260, h - 230, {
        fill: b.theme.secondary,
        radius: 16,
      });
      b.icon("folder", "folder", w / 2 + 74, h / 2, 44, b.theme.muted);
      return b;
    },
  },
];
