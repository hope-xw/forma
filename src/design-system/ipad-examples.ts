import {
  MobileBuilder,
  type Appearance,
  type mobileIcons,
} from "./mobile-foundations";
type SymbolName = keyof typeof mobileIcons;
export function ipadExample(
  kind: "sidebar" | "share" | "menu" | "context",
  appearance: Appearance,
  x: number,
  y: number,
) {
  const titles = {
    sidebar: "分栏导航",
    share: "协作分享",
    menu: "文件浏览与长按",
    context: "上下文菜单",
  };
  const b = new MobileBuilder(
      appearance,
      titles[kind] + " · " + appearance,
      1210,
      834,
    ),
    t = b.theme;
  Object.assign(b.root.style, { x, y, clipContent: true, radius: 26 });
  b.root.variableModes = { semantic: appearance.toLowerCase() };
  b.root.styleBindings = { paint: "paint-surface" };
  const frame = (
    id: string,
    name: string,
    left: number,
    top: number,
    width: number,
    height: number,
    fill: string,
    radius = 0,
    parent = "root",
  ) =>
    b.add(
      "frame",
      id,
      parent,
      { x: left, y: top, width, height, fill, radius, padding: 0 },
      name,
    );
  const text = (
    id: string,
    label: string,
    left: number,
    top: number,
    width: number,
    size: number,
    parent = "root",
    muted = false,
  ) => {
    const layer = b.text(
      id,
      label,
      left,
      top,
      width,
      size,
      { color: muted ? t.muted : t.text },
      parent,
    );
    layer.variableBindings = { color: muted ? "color-muted" : "color-text" };
    return layer;
  };
  const pill = (
    id: string,
    icon: SymbolName,
    left: number,
    top: number,
    parent = "root",
  ) => {
    frame(id, id, left, top, 42, 42, t.secondary, 21, parent);
    b.icon(id + "-glyph", icon, 11, 11, 20, t.text, id);
  };
  if (kind === "sidebar") {
    const side = frame("sidebar", "资料库侧栏", 0, 0, 320, 834, t.secondary);
    side.style.gradient = {
      type: "linear",
      angle: 120,
      stops: [
        {
          offset: 0,
          color: appearance === "Light" ? "#eee6df" : "#35313b",
          opacity: 1,
        },
        {
          offset: 1,
          color: appearance === "Light" ? "#dbdbe0" : "#20232b",
          opacity: 1,
        },
      ],
    };
    text("edit", "编辑", 20, 43, 80, 17, "sidebar");
    pill("pin", "grid", 218, 32, "sidebar");
    pill("collapse", "list", 266, 32, "sidebar");
    frame("search", "搜索栏", 12, 84, 296, 44, t.border, 22, "sidebar");
    b.icon("search-icon", "search", 14, 12, 19, t.muted, "search");
    text("placeholder", "搜索", 42, 10, 204, 16, "search", true);
    let top = 146;
    [
      ["资料库", "最近使用", "共享项目", "收藏夹", "离线文件"],
      ["工作空间", "设计资源", "团队文稿", "交付归档"],
      ["位置", "个人云盘", "本机文件", "项目服务器"],
    ].forEach(([heading, ...labels], group) => {
      text("section-" + group, heading, 22, top, 260, 14, "sidebar", true);
      top += 32;
      labels.forEach((label, index) => {
        const key = "row-" + group + "-" + index;
        frame(
          key,
          label,
          10,
          top,
          300,
          41,
          group === 1 && index === 0 ? t.border : t.secondary,
          18,
          "sidebar",
        ).style.fillOpacity = group === 1 && index === 0 ? 1 : 0;
        b.icon(
          key + "-symbol",
          (["folder", "clock", "heart", "download"] as const)[index],
          16,
          10,
          21,
          t.accent,
          key,
        );
        text(key + "-name", label, 52, 8, 170, 17, key);
        text(
          key + "-count",
          String(8 + index * 3 + group),
          256,
          9,
          36,
          15,
          key,
          true,
        );
        top += 45;
      });
      top += 17;
    });
    pill("back", "back", 332, 32);
    frame("tabs", "分段标签", 515, 31, 494, 43, t.secondary, 22);
    ["概览", "文档", "图像", "视频", "归档"].forEach((label, index) => {
      if (index === 0)
        b.box(
          "tab-selected",
          6,
          4,
          89,
          35,
          { fill: t.surface, radius: 18 },
          "tabs",
        );
      text("tab-" + index, label, 32 + index * 95, 9, 56, 15, "tabs");
    });
    text("heading", "设计资源", 342, 91, 530, 28).style.fontWeight = 700;
    text("subtitle", "团队工作空间", 343, 137, 500, 16, "root", true);
  } else {
    pill("back", "back", 16, 35);
    pill("tools", "grid", 68, 35);
    text("heading", "山野手记", 566, 36, 190, 17).style.fontWeight = 700;
    text("subtitle", "共享资料库", 567, 62, 180, 12, "root", true);
    if (kind === "share") {
      const panel = frame(
        "share",
        "协作分享浮层",
        798,
        94,
        402,
        730,
        t.surface,
        34,
      );
      panel.styleBindings = { effect: "effect-card" };
      panel.style.stroke = t.border;
      panel.style.strokeWidth = 1;
      frame("cover", "文档封面", 26, 28, 66, 66, "#454694", 16, "share");
      b.icon("cover-art", "sparkles", 13, 13, 40, "#ffca72", "cover");
      text("doc", "山野手记", 110, 28, 220, 18, "share");
      text("format", "设计文档", 110, 56, 224, 14, "share", true);
      pill("close", "close", 340, 16, "share");
      frame(
        "collaborate",
        "协作权限",
        110,
        89,
        130,
        29,
        t.secondary,
        15,
        "share",
      );
      text("collab-title", "邀请协作  ›", 16, 3, 110, 15, "collaborate");
      text("permission", "仅受邀用户可编辑", 111, 134, 240, 14, "share", true);
      (
        [
          ["小林", "阿岚", "一帆", "乔木"],
          ["附近共享", "信息", "邮件", "备忘录"],
          ["复制", "收藏", "阅读列表", "书签"],
        ] as const
      ).forEach((labels, row) => {
        const top = 178 + row * 132;
        b.box(
          "divider-" + row,
          22,
          top - 6,
          358,
          1,
          { fill: t.border },
          "share",
        );
        labels.forEach((label, col) => {
          const id = "tile-" + row + "-" + col;
          const color = ["#526baf", "#40916e", "#ab654f", "#786394"][col];
          frame(
            id,
            label,
            24 + col * 92,
            top + 12,
            64,
            64,
            row === 2 ? t.secondary : color,
            row === 1 ? 15 : 32,
            "share",
          );
          b.icon(
            id + "-symbol",
            (
              [
                ["person", "person", "person", "person"],
                ["radio", "mail", "share", "list"],
                ["folder", "heart", "list", "plus"],
              ] as const
            )[row][col],
            16,
            16,
            32,
            row === 2 ? t.text : "#ffffff",
            id,
          );
          if (row === 0)
            b.box(
              id + "-badge",
              49,
              47,
              15,
              15,
              { fill: t.success, radius: 5 },
              id,
            );
          text(
            id + "-label",
            label,
            20 + col * 92,
            top + 84,
            80,
            13,
            "share",
          ).style.textAlign = "center";
        });
      });
      frame("actions", "更多操作", 18, 580, 366, 132, t.secondary, 20, "share");
      ["添加到阅读列表", "添加书签", "设为收藏"].forEach((label, index) => {
        b.icon(
          "action-icon-" + index,
          (["list", "folder", "heart"] as const)[index],
          16,
          12 + index * 43,
          20,
          t.text,
          "actions",
        );
        text("action-" + index, label, 52, 10 + index * 43, 275, 16, "actions");
        if (index < 2)
          b.box(
            "action-line-" + index,
            50,
            42 + index * 43,
            298,
            1,
            { fill: t.border },
            "actions",
          );
      });
    } else if (kind === "context") {
      b.box("dim", 0, 0, 1210, 834, { fill: "#13151b", fillOpacity: 0.23 });
      const preview = frame(
        "preview",
        "内容预览",
        298,
        200,
        350,
        160,
        t.surface,
        30,
      );
      preview.styleBindings = { effect: "effect-card" };
      text(
        "preview-label",
        "文档预览",
        0,
        66,
        350,
        16,
        "preview",
        true,
      ).style.textAlign = "center";
      const menu = frame(
        "menu",
        "上下文操作",
        665,
        200,
        248,
        277,
        t.secondary,
        30,
      );
      menu.styleBindings = { effect: "effect-card" };
      menu.style.backdropBlur = 24;
      (["复制", "收藏", "删除"] as const).forEach((label, index) => {
        const id = "quick-" + index;
        frame(
          id,
          label,
          10 + index * 78,
          10,
          74,
          56,
          index === 0 ? t.border : t.secondary,
          15,
          "menu",
        );
        b.icon(
          id + "-icon",
          (["folder", "heart", "close"] as const)[index],
          28,
          5,
          18,
          index === 2 ? t.danger : t.text,
          id,
        );
        text(id + "-text", label, 0, 31, 74, 13, id).style.textAlign = "center";
      });
      ["打开文稿", "离线保存", "移至废纸篓", "更多操作"].forEach(
        (label, index) => {
          const key = "command-" + index,
            top = 82 + index * 47;
          const row = frame(
            key,
            label,
            10,
            top,
            228,
            43,
            t.secondary,
            8,
            "menu",
          );
          if (index === 1) row.style.opacity = 0.45;
          b.icon(
            key + "-icon",
            (["folder", "download", "close", "more"] as const)[index],
            12,
            12,
            18,
            index === 2 ? t.danger : t.text,
            key,
          );
          const caption = text(key + "-label", label, 44, 7, 162, 16, key);
          if (index === 2) caption.variableBindings = { color: "color-danger" };
          if (index === 3)
            b.icon("submenu", "forward", 200, 11, 17, t.muted, key);
        },
      );
    } else {
      for (let i = 0; i < 12; i++) {
        const id = "file-" + i;
        frame(
          id,
          "文件卡片 " + (i + 1),
          52 + (i % 4) * 280,
          138 + Math.floor(i / 4) * 209,
          251,
          180,
          t.secondary,
          18,
        );
        b.icon(
          id + "-icon",
          i % 2 ? "folder" : "grid",
          93,
          26,
          64,
          t.accent,
          id,
        );
        text(
          id + "-name",
          ["周末采集", "海岸来信", "色彩研究", "参考剪辑"][i % 4],
          18,
          110,
          218,
          18,
          id,
        );
        text(
          id + "-meta",
          "项目资料  ·  " + (i + 2) + " 项",
          18,
          145,
          210,
          14,
          id,
          true,
        );
      }
    }
  }
  text("time", "9:41   4月1日 周三", 14, 4, 214, 13);
  text("battery", "100%", 1110, 5, 61, 13);
  b.box("battery-case", 1163, 8, 29, 12, { fill: t.text, radius: 4 });
  pill("trailing", "share", 1154, 32);
  const ids = new Map(b.nodes.map((node) => [node.id, crypto.randomUUID()]));
  return b.nodes.map((template) => {
    const node = structuredClone(template);
    node.id = ids.get(template.id)!;
    node.parentId = template.parentId ? ids.get(template.parentId)! : null;
    delete node.templateKey;
    return node;
  });
}
