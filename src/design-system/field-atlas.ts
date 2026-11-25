import {
  editablePaths,
  vectorBounds,
  encodeVector,
} from "../domain/vector-path";
import { MobileBuilder, type mobileIcons } from "./mobile-foundations";
import type { DesignDocument, DesignNode, NodeStyle } from "../domain/document";
import { instantiateComponent } from "../domain/library";
import type { ComponentLibrary } from "../domain/library-schema";
import { transact } from "../domain/commands";

const ink = "#172f2b",
  muted = "#5d7069",
  paper = "#fbfaf4",
  forest = "#1c594a",
  orange = "#bb552c";
type Icon = keyof typeof mobileIcons;
type Path = NonNullable<DesignNode["vector"]>["paths"][number];
class Board extends MobileBuilder {
  constructor(name: string, width: number, height: number) {
    super("Light", name, width, height);
    Object.assign(this.root.style, {
      fill: paper,
      clipContent: true,
      radius: 24,
    });
  }
  panel(
    key: string,
    parent: string,
    x: number,
    y: number,
    width: number,
    height: number,
    fill: string,
    radius = 0,
    name = key,
  ) {
    return this.add(
      "frame",
      key,
      parent,
      { x, y, width, height, fill, radius, padding: 0 },
      name,
    );
  }
  label(
    key: string,
    parent: string,
    value: string,
    x: number,
    y: number,
    width: number,
    size: number,
    style: Partial<NodeStyle> = {},
  ) {
    return this.text(
      key,
      value,
      x,
      y,
      width,
      size,
      { color: ink, lineHeight: Math.ceil(size * 1.3), ...style },
      parent,
    );
  }
  paths(
    key: string,
    parent: string,
    name: string,
    x: number,
    y: number,
    w: number,
    h: number,
    paths: Path[],
  ) {
    const curves = editablePaths({ width: w, height: h, paths }),
      bounds = vectorBounds(curves);
    const n = this.add(
      "vector",
      key,
      parent,
      {
        x: x + bounds.x,
        y: y + bounds.y,
        width: bounds.width,
        height: bounds.height,
        color: ink,
      },
      name,
    );
    n.vector = encodeVector(curves, bounds);
    return n;
  }
  controlIcon(
    id: string,
    parent: string,
    icon: Icon,
    x: number,
    y: number,
    label: string,
  ) {
    const n = this.panel(id, parent, x, y, 38, 38, paper, 19, label);
    n.style.fillOpacity = 0.92;
    this.icon(id + "-ink", icon, 10, 10, 18, forest, id);
    return n;
  }
  build(prefix: string) {
    return this.nodes.map((n) => ({
      ...n,
      id: prefix + n.id,
      parentId: n.parentId ? prefix + n.parentId : null,
      ...(n.maskSourceId ? { maskSourceId: prefix + n.maskSourceId } : {}),
      templateKey: undefined,
    }));
  }
}
const line = (d: string, color: string, width: number): Path => ({
  d,
  fill: false,
  strokeColor: color,
  strokeWidth: width,
});
const area = (d: string, color: string): Path => ({
  d,
  fill: true,
  fillColor: color,
  strokeWidth: 0,
});
const fixed = (n: number) => Math.round(n * 10) / 10;
// Periodic cubic curves form editable closed contours around each surveyed peak.
function contour(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  phase: number,
) {
  const points = Array.from({ length: 18 }, (_, i) => {
    const a = (i * 2 * Math.PI) / 18,
      noise =
        1 + 0.15 * Math.sin(a * 3 + phase) + 0.09 * Math.cos(a * 5 - phase);
    return {
      x: cx + rx * Math.cos(a) * noise,
      y: cy + ry * Math.sin(a) * noise,
    };
  });
  let d = "M" + fixed(points[0].x) + " " + fixed(points[0].y);
  for (let i = 0; i < points.length; i++) {
    const before = points[(i + 17) % 18],
      p = points[i],
      q = points[(i + 1) % 18],
      after = points[(i + 2) % 18];
    d +=
      "C" +
      [
        p.x + (q.x - before.x) / 6,
        p.y + (q.y - before.y) / 6,
        q.x - (after.x - p.x) / 6,
        q.y - (after.y - p.y) / 6,
        q.x,
        q.y,
      ]
        .map(fixed)
        .join(" ");
  }
  return d + "Z";
}
function terrain(
  b: Board,
  parent: string,
  x: number,
  y: number,
  w: number,
  h: number,
  compact = false,
) {
  const map = parent + "-map";
  b.panel(map, parent, x, y, w, h, "#e8ecd8", 0, "地形底图").style.clipContent =
    true;
  const draw = (key: string, name: string, paths: Path[]) =>
    b.paths(map + key, map, name, 0, 0, w, h, paths);
  for (const [i, [cx, cy, rx, ry]] of [
    [0.12, 0.23, 0.24, 0.35],
    [0.82, 0.22, 0.26, 0.34],
    [0.4, 0.84, 0.32, 0.36],
    [0.93, 0.91, 0.2, 0.28],
  ].entries()) {
    for (let j = 0; j < (compact ? 4 : 9); j++) {
      const scale = 1 - j / (compact ? 5 : 10),
        d = contour(cx * w, cy * h, rx * w * scale, ry * h * scale, i * 1.4);
      draw("ridge" + i + "-" + j, "等高线 · " + (520 + j * 40) + " m", [
        {
          ...line(d, j % 3 ? "#b6c49e" : "#98b38a", compact ? 0.7 : 1.2),
          ...(j === 0
            ? { fill: true, fillColor: "#cedcbb", fillOpacity: 0.7 }
            : {}),
        },
      ]);
    }
  }
  const river =
    "M" +
    [-w * 0.06, h * 0.62].map(fixed).join(" ") +
    "C" +
    [w * 0.22, h * 0.35, w * 0.32, h * 0.73, w * 0.48, h * 0.54]
      .map(fixed)
      .join(" ") +
    "S" +
    [w * 0.74, h * 0.28, w * 1.05, h * 0.39].map(fixed).join(" ");
  draw("river", "澄溪水系", [
    line(river, "#90b9b2", compact ? 5 : 13),
    line(river, "#add0c6", compact ? 3 : 8),
  ]);
  const route =
    "M" +
    [w * 0.17, h * 0.72].map(fixed).join(" ") +
    "C" +
    [w * 0.24, h * 0.72, w * 0.23, h * 0.51, w * 0.34, h * 0.53]
      .map(fixed)
      .join(" ") +
    "S" +
    [w * 0.49, h * 0.57, w * 0.52, h * 0.42].map(fixed).join(" ") +
    "S" +
    [w * 0.66, h * 0.43, w * 0.75, h * 0.25].map(fixed).join(" ");
  draw("route", "徒步线路", [
    line(route, paper, compact ? 4 : 9),
    line(route, orange, compact ? 2 : 5),
  ]);
  if (!compact) {
    for (const [i, [name, px, py]] of (
      [
        ["松风岭", 0.12, 0.13],
        ["澄 溪", 0.6, 0.52],
        ["北麓林场", 0.75, 0.74],
      ] as const
    ).entries())
      b.label(map + "place" + i, map, name, w * px, h * py, 85, 12, {
        color: "#536c51",
        fontWeight: 650,
        letterSpacing: 2,
      });
    b.label(map + "scale", map, "0     ━━━    500 m", 20, h - 34, 145, 11, {
      color: muted,
    });
  }
  return map;
}
function elevation(
  b: Board,
  parent: string,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  b.panel("profile", parent, x, y, w, h, "#eff2e8", 13, "海拔剖面");
  const cw = w - 28,
    ch = h - 43,
    values = [
      0.18, 0.26, 0.23, 0.32, 0.46, 0.4, 0.52, 0.58, 0.49, 0.62, 0.7, 0.65,
      0.78, 0.86, 0.7, 0.82, 0.75, 0.65, 0.6, 0.45, 0.53, 0.36, 0.43, 0.31,
    ];
  const points = values.map((v, i) => [
    fixed(14 + (i * cw) / (values.length - 1)),
    fixed(21 + ch - v * ch),
  ]);
  const edge = "M" + points.map((p) => p.join(" ")).join("L");
  b.paths("elevation-curve", "profile", "海拔曲线", 0, 0, w, h, [
    area(edge + "L" + (w - 14) + " " + (21 + ch) + "H14Z", "#b7ccb0"),
    line(edge, forest, 2),
  ]);
  b.label("high", "profile", "1,240 m", 14, 5, 110, 10, {
    color: forest,
    fontWeight: 700,
  });
  b.label("length", "profile", "12.6 km", w - 72, h - 20, 65, 10, {
    color: muted,
  });
}
const stations = [
  ["雾岭南口", "08:30", "0.0 km"],
  ["澄溪营地", "10:05", "4.8 km"],
  ["北峰观景台", "12:40", "12.6 km"],
] as const;
function steps(b: Board, parent: string, x: number, y: number, w: number) {
  stations.forEach(([name, time, distance], i) => {
    const key = "waypoint-" + i,
      dy = y + i * 51;
    b.panel(key, parent, x, dy, w, 49, paper, 0, name);
    b.add("ellipse", key + "-ring", key, {
      x: 0,
      y: 12,
      width: 18,
      height: 18,
      fill: i === 1 ? orange : forest,
    });
    b.label(key + "-number", key, String(i + 1), 2, 13, 14, 10, {
      color: paper,
      textAlign: "center",
      fontWeight: 700,
    });
    b.label(key + "-title", key, name, 30, 6, w - 108, 15, { fontWeight: 650 });
    b.label(key + "-meta", key, distance, 30, 25, 100, 11, { color: muted });
    b.label(key + "-time", key, time, w - 48, 9, 45, 12, { color: muted });
    b.box(key + "-line", 30, 47, w - 30, 1, { fill: "#dde1d5" }, key);
  });
}
function mast(b: Board, parent: string, x: number, y: number) {
  b.label("mast", parent, "野径图志", x, y, 190, 25, { fontWeight: 750 });
  b.label("edition", parent, "FIELD ATLAS", x, y + 34, 170, 11, {
    fontWeight: 700,
    letterSpacing: 2.7,
    color: forest,
  });
}
function action(
  b: Board,
  id: string,
  parent: string,
  text: string,
  x: number,
  y: number,
  w: number,
) {
  b.panel(id, parent, x, y, w, 43, forest, 13, text);
  b.label(id + "-text", id, text, 12, 10, w - 24, 15, {
    color: paper,
    textAlign: "center",
    fontWeight: 650,
  });
}
function overview(phone: boolean) {
  const w = phone ? 390 : 1180,
    h = phone ? 844 : 820,
    b = new Board(phone ? "iPhone · 雾岭环线" : "iPad · 雾岭路线规划", w, h);
  if (phone) {
    terrain(b, "root", 0, 0, w, 345);
    b.controlIcon("back", "root", "back", 17, 44, "返回");
    b.controlIcon("share", "root", "share", 335, 44, "分享路线");
    b.panel("info", "root", 0, 320, w, 524, paper, 26, "路线信息");
    b.label("region", "info", "浙北 · 天目山", 24, 28, 250, 13, {
      color: forest,
      fontWeight: 650,
    });
    b.label("title", "info", "雾岭环线", 24, 51, 245, 34, { fontWeight: 760 });
    b.label(
      "subtitle",
      "info",
      "12.6 km    ·    爬升 680 m    ·    约 4 小时",
      24,
      105,
      345,
      15,
      { color: muted },
    );
    elevation(b, "info", 24, 149, 342, 112);
    steps(b, "info", 24, 280, 342);
    action(b, "open", "info", "查看路线手记", 24, 445, 342);
  } else {
    terrain(b, "root", 334, 0, 846, h);
    b.panel("sidebar", "root", 0, 0, 334, h, paper, 0, "路线侧栏");
    mast(b, "sidebar", 23, 42);
    b.label("season", "sidebar", "山野手记   /   秋季路线", 24, 120, 280, 13, {
      color: muted,
    });
    b.label("title", "sidebar", "雾岭环线", 23, 149, 290, 36, {
      fontWeight: 780,
    });
    b.label(
      "intro",
      "sidebar",
      "穿过南坡的杉林，在澄溪补水，\n沿山脊抵达北峰。",
      24,
      207,
      290,
      15,
      { height: 48, color: muted, lineHeight: 22 },
    );
    for (const [i, [value, unit]] of [
      ["12.6", "公里"],
      ["680", "爬升 / 米"],
      ["4:10", "预计用时"],
    ].entries()) {
      const x = 24 + i * 99;
      b.label("metric" + i, "sidebar", value, x, 284, 95, 25, {
        fontWeight: 700,
      });
      b.label("unit" + i, "sidebar", unit, x, 319, 95, 12, { color: muted });
    }
    elevation(b, "sidebar", 24, 369, 286, 116);
    b.label("way-title", "sidebar", "沿途地点", 24, 521, 250, 19, {
      fontWeight: 720,
    });
    steps(b, "sidebar", 24, 559, 286);
    action(b, "open", "sidebar", "查看路线手记", 24, 748, 286);
    b.panel("search", "root", 358, 35, 238, 42, paper, 21, "地图搜索");
    b.icon("search-icon", "search", 14, 12, 19, muted, "search");
    b.label("search-placeholder", "search", "搜索地点或路线", 44, 12, 170, 14, {
      color: muted,
    });
    b.controlIcon("north", "root", "expand", 1114, 37, "地图范围");
    b.controlIcon("share", "root", "share", 1114, 86, "分享路线");
    b.panel(
      "map-legend",
      "root",
      942,
      725,
      208,
      57,
      paper,
      14,
      "图例",
    ).style.fillOpacity = 0.93;
    b.box(
      "legend-line",
      15,
      24,
      30,
      4,
      { fill: orange, radius: 2 },
      "map-legend",
    );
    b.label("legend-copy", "map-legend", "雾岭徒步线路", 57, 18, 145, 14, {
      fontWeight: 650,
    });
  }
  return {
    nodes: b.build(phone ? "atlas-phone-" : "atlas-tablet-"),
    width: phone ? 390 : 846,
    height: phone ? 345 : 820,
  };
}
function fieldNote() {
  const b = new Board("iPhone · 路线手记", 390, 844);
  b.controlIcon("back", "root", "back", 16, 38, "返回路线");
  b.controlIcon("share", "root", "share", 333, 38, "分享手记");
  b.label("tag", "root", "FIELD NOTES   /   03", 24, 103, 335, 12, {
    color: forest,
    letterSpacing: 2.8,
    fontWeight: 720,
  });
  b.label("title", "root", "沿澄溪，向北峰", 23, 134, 355, 33, {
    fontWeight: 760,
  });
  const byline = b.label(
    "byline",
    "root",
    "阿岚记录  ·  11 月 16 日",
    24,
    193,
    344,
    14,
    { color: muted },
  );
  byline.textRuns = [
    { start: 0, end: 2, style: { fontWeight: 700, color: forest } },
  ];
  terrain(b, "root", 24, 239, 342, 188);
  b.label("caption", "root", "图 01   澄溪转向北麓山脊处", 24, 439, 345, 12, {
    color: muted,
  });
  b.label(
    "body",
    "root",
    "过营地后从溪流东侧上山。松针小径的第二处分岔向右，北峰平台可以看见完整的环线。",
    24,
    489,
    342,
    18,
    { lineHeight: 29, height: 102 },
  );
  b.label("reminder", "root", "行前准备", 24, 614, 340, 20, {
    fontWeight: 720,
  });
  ["离线地图已下载", "营地附近可补水", "山脊风大，备好外套"].forEach(
    (text, i) => {
      b.icon("check" + i, "check", 25, 660 + i * 31, 16, forest, "root");
      b.label("tip" + i, "root", text, 54, 656 + i * 31, 300, 15, {
        color: muted,
      });
    },
  );
  return b.build("atlas-note-");
}
function markerLibrary(): ComponentLibrary {
  const variants = stations.map(([name], i) => {
    const b = new Board(name, 32, 32);
    Object.assign(b.root.style, {
      fill: [forest, orange, ink][i],
      radius: 16,
      stroke: "#ffffff",
      strokeWidth: 2,
    });
    b.text("label", String(i + 1), 0, 5, 28, 15, {
      color: paper,
      fontWeight: 750,
      textAlign: "center",
      height: 20,
      lineHeight: 20,
    });
    return {
      id: "point" + i,
      name,
      properties: { 站点: name },
      nodes: b.nodes,
    };
  });
  return {
    format: "forma/library",
    version: 1,
    id: "field-atlas-waypoints",
    name: "野径图志 · 地图标记",
    description: "路线站点",
    revision: 1,
    source: { name: "Forma", license: "自研几何与图标" },
    components: [
      {
        id: "marker",
        name: "路线站点",
        category: "地图",
        description: "起点、营地与终点",
        variants,
      },
    ],
  };
}
export function fieldAtlasPage(base: DesignDocument) {
  const tablet = overview(false),
    phone = overview(true),
    notes = fieldNote();
  let d: DesignDocument = {
    ...base,
    activePage: undefined,
    pages: undefined,
    nodes: [...tablet.nodes, ...phone.nodes, ...notes],
  };
  const by = (id: string) => d.nodes.find((n) => n.id === id)!;
  by("atlas-phone-root").style.x = 1290;
  by("atlas-note-root").style.x = 1755;
  by("atlas-tablet-root").interaction = { flow: "iPad 路线规划" };
  by("atlas-phone-root").interaction = { flow: "iPhone 路线手记" };
  for (const key of ["atlas-tablet-open", "atlas-phone-open"])
    by(key).interaction = {
      actions: [{ kind: "navigate", target: "atlas-note-root" }],
    };
  by("atlas-note-back").interaction = { actions: [{ kind: "back" }] };
  const sheet = new Board("路线分享 · 浮层", 348, 246);
  sheet.root.style.radius = 28;
  sheet.label("heading", "root", "分享雾岭环线", 22, 27, 290, 23, {
    fontWeight: 720,
  });
  sheet.label(
    "detail",
    "root",
    "12.6 公里   /   3 个沿途地点",
    23,
    69,
    310,
    14,
    { color: muted },
  );
  ["邮件", "信息", "保存路线"].forEach((name, i) => {
    sheet.panel(
      "tile" + i,
      "root",
      24 + i * 102,
      117,
      54,
      54,
      ["#e1ecf4", "#dcebd9", "#ece7d8"][i],
      14,
      name,
    );
    sheet.icon(
      "glyph" + i,
      (["mail", "radio", "download"] as const)[i],
      14,
      14,
      26,
      forest,
      "tile" + i,
    );
    sheet.label("label" + i, "root", name, 13 + i * 102, 184, 77, 13, {
      textAlign: "center",
    });
  });
  sheet.controlIcon("close", "root", "close", 294, 22, "关闭分享");
  const overlay = sheet.build("atlas-sheet-");
  overlay[0].style.x = 2220;
  d.nodes.push(...overlay);
  for (const prefix of ["tablet", "phone", "note"])
    by("atlas-" + prefix + "-share").interaction = {
      actions: [
        { kind: "overlay", target: "atlas-sheet-root", position: "bottom" },
      ],
    };
  by("atlas-sheet-close").interaction = { actions: [{ kind: "close" }] };
  const lib = markerLibrary();
  for (const [p, canvas] of [
    ["tablet", tablet],
    ["phone", phone],
  ] as const) {
    const parent = "atlas-" + p + "-root-map",
      root = by("atlas-" + p + "-root"),
      map = by(parent);
    for (const [i, [x, y]] of [
      [0.17, 0.72],
      [0.52, 0.42],
      [0.75, 0.25],
    ].entries()) {
      const insertion = instantiateComponent(
        d,
        lib,
        "marker",
        "point" + i,
        parent,
        {
          x: root.style.x + map.style.x + canvas.width * x - 16,
          y: map.style.y + canvas.height * y - 16,
        },
      );
      d = transact(d, {
        baseRevision: d.revision,
        operations: insertion.operations,
      });
    }
  }
  return { nodes: d.nodes, library: lib };
}
/** Additional original contents for the overview pane of the split-view reference. */
export function resourceOverview(parentId: string) {
  const b = new Board("资料库", 850, 650);
  b.label("pinned", "root", "置顶项目", 0, 0, 350, 20, { fontWeight: 720 });
  const titles = ["山野手记", "排印标本", "界面色谱"],
    captions = [
      "野外调查与路线资料",
      "品牌字体与版式研究",
      "界面颜色与语义变量",
    ];
  for (let i = 0; i < 3; i++) {
    const key = "project" + i;
    b.panel(
      key,
      "root",
      i * 277,
      46,
      257,
      192,
      ["#e7ecd7", "#253a46", "#f1e4cf"][i],
      16,
      titles[i],
    ).style.clipContent = true;
    if (i === 0) terrain(b, key, 0, 0, 257, 192, true);
    if (i === 1) {
      b.label("type-example", key, "Aa", 17, 5, 210, 94, {
        color: "#f8edc8",
        fontFamily: "Georgia,serif",
      });
      b.label("type-spec", key, "G g   &   0123", 19, 142, 230, 21, {
        color: "#a8bbad",
        fontFamily: "Georgia,serif",
      });
    }
    if (i === 2) {
      ["#af542f", "#edbd8e", "#e7d5a6", "#749284", "#2a5449"].forEach(
        (fill, j) =>
          b.add("ellipse", "swatch" + j, key, {
            x: 18 + j * 41,
            y: 51 + (j % 2) * 14,
            width: 57,
            height: 57,
            fill,
          }),
      );
      b.label("color-spec", key, "CHROMA    /    05", 19, 151, 220, 13, {
        color: forest,
        letterSpacing: 2.4,
        fontWeight: 700,
      });
    }
    b.label("project-title" + i, "root", titles[i], i * 277, 252, 245, 19, {
      fontWeight: 700,
    });
    b.label("project-sub" + i, "root", captions[i], i * 277, 284, 250, 13, {
      color: muted,
    });
  }
  b.label("recent", "root", "最近更新", 0, 352, 340, 20, { fontWeight: 720 });
  [
    "雾岭环线 · 路线图",
    "展览视觉提案",
    "基础控件与图标",
    "季度调研摘要",
  ].forEach((name, i) => {
    const key = "file" + i;
    b.panel(key, "root", 0, 394 + i * 54, 814, 51, "#ffffff", 0, name);
    b.panel(
      key + "-badge",
      key,
      0,
      5,
      37,
      37,
      ["#e2ebdb", "#f3e3d8", "#e1eafa", "#f0e1ee"][i],
      8,
    );
    b.icon(
      key + "-icon",
      (["folder", "grid", "settings", "list"] as const)[i],
      10,
      10,
      17,
      forest,
      key + "-badge",
    );
    b.label(key + "-title", key, name, 53, 10, 330, 16, { fontWeight: 600 });
    b.label(
      key + "-date",
      key,
      ["今天 09:42", "昨天 16:18", "周二 14:05", "周一 10:21"][i],
      570,
      12,
      160,
      13,
      { color: muted },
    );
    b.icon(key + "-more", "more", 779, 13, 20, muted, key);
    b.box(key + "-divider", 52, 50, 756, 1, { fill: "#e7e7e9" }, key);
  });
  const nodes = b.build("studio-overview-");
  Object.assign(nodes[0].style, { x: 343, y: 188, fillOpacity: 0 });
  nodes[0].parentId = parentId;
  return nodes;
}
export function addFieldAtlas(doc: DesignDocument): DesignDocument {
  if (doc.pages?.some((p) => p.id === "atlas")) return doc;
  const home = doc.nodes.find(
      (n) => !n.parentId && n.name === "分栏导航 · Light",
    ),
    files = doc.nodes.find(
      (n) => !n.parentId && n.name === "文件浏览与长按 · Light",
    );
  if (!home || !files) throw Error("研究室缺少分栏画板");
  const atlas = fieldAtlasPage(doc),
    overview = resourceOverview(home.id);
  for (const n of overview.filter(
    (n) => n.name === "山野手记" || n.name === "雾岭环线 · 路线图",
  ))
    n.interaction = { actions: [{ kind: "navigate", target: files.id }] };
  return {
    ...doc,
    nodes: [...doc.nodes, ...overview],
    libraries: { ...doc.libraries, [atlas.library.id]: atlas.library },
    pages: [
      ...doc.pages!,
      { id: "atlas", name: "04  Field Atlas · 野径图志", nodes: atlas.nodes },
    ],
  };
}
