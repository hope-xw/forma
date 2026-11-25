import type { DesignDocument } from "../domain/document";
import type { Point } from "../domain/geometry";
import { transact, type Operation } from "../domain/commands";
import { instantiateComponent } from "../domain/library";
import { mobileComponentLibrary } from "./mobile";
import { MobileBuilder, type Appearance } from "./mobile-foundations";

/** A complete editable composition. Layout frames remain editable; reusable parts are protected instances. */
export function createMediaTemplate(
  doc: DesignDocument,
  appearance: Appearance,
  position: Point,
) {
  const b = new MobileBuilder(appearance, "平板 · 声场音乐工作台", 1440, 1024),
    t = b.theme;
  Object.assign(b.root.style, {
    ...position,
    fill: t.canvas,
    radius: 24,
    clipContent: true,
  });
  const sidebar = b.add(
    "frame",
    "sidebar",
    "root",
    { x: 0, y: 0, width: 224, height: 1024, fill: t.surface, padding: 0 },
    "侧栏 / 导航与资料库",
  );
  b.box("sidebar-border", 223, 0, 1, 1024, { fill: t.border });
  b.box(
    "brand-mark",
    26,
    38,
    34,
    34,
    { radius: 11, fill: t.accent },
    sidebar.id,
  );
  b.icon("brand-icon", "radio", 34, 46, 18, "#ffffff", sidebar.id);
  b.text(
    "brand",
    "声场",
    72,
    35,
    120,
    24,
    { fontWeight: 750, letterSpacing: 2 },
    sidebar.id,
  );
  b.text(
    "brand-subtitle",
    "SOUNDSPACE",
    73,
    65,
    120,
    8,
    { color: t.muted, letterSpacing: 2 },
    sidebar.id,
  );
  b.text(
    "browse-label",
    "探索音乐",
    30,
    122,
    160,
    10,
    { color: t.muted, letterSpacing: 2 },
    sidebar.id,
  );
  b.text(
    "library-label",
    "你的资料库",
    30,
    335,
    160,
    10,
    { color: t.muted, letterSpacing: 2 },
    sidebar.id,
  );
  b.text(
    "playlist-label",
    "我的歌单",
    30,
    547,
    130,
    10,
    { color: t.muted, letterSpacing: 2 },
    sidebar.id,
  );
  b.icon("new-playlist", "plus", 181, 546, 16, t.muted, sidebar.id);
  b.box(
    "profile-bg",
    16,
    837,
    192,
    65,
    { radius: 12, fill: t.canvas },
    sidebar.id,
  );
  b.add("ellipse", "avatar", sidebar.id, {
    x: 28,
    y: 853,
    width: 32,
    height: 32,
    fill: t.tint,
  });
  b.text(
    "avatar-letter",
    "林",
    36,
    858,
    24,
    14,
    { color: t.accent, fontWeight: 600 },
    sidebar.id,
  );
  b.text(
    "profile-name",
    "林小满",
    72,
    849,
    100,
    13,
    { fontWeight: 600 },
    sidebar.id,
  );
  b.text(
    "profile-plan",
    "个人空间 · 已同步",
    72,
    872,
    120,
    10,
    { color: t.muted },
    sidebar.id,
  );
  b.icon("profile-more", "more", 178, 858, 17, t.muted, sidebar.id);

  const header = b.add(
    "frame",
    "header",
    "root",
    { x: 260, y: 35, width: 1144, height: 87, fillOpacity: 0, padding: 0 },
    "页首 / 搜索与账号",
  );
  b.text(
    "greeting",
    "星期二，11 月 17 日",
    0,
    0,
    480,
    12,
    { color: t.muted },
    header.id,
  );
  b.text(
    "heading",
    "为此刻，找到声音。",
    0,
    26,
    640,
    32,
    { fontWeight: 700, letterSpacing: -1 },
    header.id,
  );
  b.box(
    "search-bg",
    773,
    17,
    265,
    40,
    { fill: t.surface, radius: 20, stroke: t.border, strokeWidth: 1 },
    header.id,
  );
  b.icon("search-icon", "search", 788, 28, 18, t.muted, header.id);
  b.text(
    "search-placeholder",
    "搜索音乐、艺人、播客",
    817,
    27,
    200,
    12,
    { color: t.muted },
    header.id,
  );
  b.box(
    "notifications-bg",
    1054,
    17,
    40,
    40,
    { fill: t.surface, radius: 20, stroke: t.border, strokeWidth: 1 },
    header.id,
  );
  b.icon("notifications", "bell", 1066, 28, 17, t.text, header.id);
  b.add("ellipse", "unread", header.id, {
    x: 1080,
    y: 23,
    width: 5,
    height: 5,
    fill: t.accent,
  });
  b.box(
    "profile-shortcut",
    1108,
    17,
    36,
    40,
    { fill: t.tint, radius: 18 },
    header.id,
  );
  b.icon("profile", "person", 1118, 28, 16, t.accent, header.id);
  b.text("albums-heading", "为你收藏的片刻", 260, 463, 800, 21, {
    fontWeight: 650,
  });
  b.text("albums-more", "查看全部", 1328, 470, 65, 12, { color: t.accent });
  b.icon("albums-next", "forward", 1390, 472, 12, t.accent);
  b.add(
    "frame",
    "albums",
    "root",
    { x: 260, y: 505, width: 1144, height: 254, fillOpacity: 0, padding: 0 },
    "推荐 / 专辑与歌单",
  );
  b.text("tracks-heading", "最近常听", 260, 778, 700, 20, { fontWeight: 650 });
  b.text("tracks-count", "本周播放 128 次", 872, 785, 155, 11, {
    color: t.muted,
    textAlign: "right",
  });
  b.add(
    "frame",
    "tracks",
    "root",
    { x: 260, y: 814, width: 750, height: 96, fillOpacity: 0, padding: 0 },
    "最近播放 / 曲目列表",
  );
  const queue = b.add(
    "frame",
    "queue",
    "root",
    {
      x: 1054,
      y: 779,
      width: 350,
      height: 131,
      fill: t.surface,
      radius: 16,
      padding: 0,
      stroke: t.border,
      strokeWidth: 1,
    },
    "下一首 / 播放队列",
  );
  b.text(
    "queue-title",
    "接下来播放",
    18,
    15,
    252,
    14,
    { fontWeight: 650 },
    queue.id,
  );
  b.icon("queue-icon", "list", 310, 17, 18, t.muted, queue.id);
  ["风吹过的地方", "在海的另一边"].forEach((text, i) => {
    b.text(
      `queue-n-${i}`,
      `0${i + 1}`,
      18,
      49 + i * 33,
      22,
      10,
      { color: t.muted },
      queue.id,
    );
    b.text(
      `queue-song-${i}`,
      text,
      49,
      47 + i * 33,
      216,
      12,
      { fontWeight: 500 },
      queue.id,
    );
    b.text(
      `queue-time-${i}`,
      i ? "4:08" : "3:26",
      286,
      49 + i * 33,
      45,
      10,
      { color: t.muted },
      queue.id,
    );
    b.icon(
      `queue-favorite-${i}`,
      "heart",
      257,
      50 + i * 33,
      14,
      t.muted,
      queue.id,
    );
  });
  const ids = new Map(b.nodes.map((n) => [n.id, crypto.randomUUID()]));
  const operations: Operation[] = b.nodes.map((template) => {
    const node = structuredClone(template);
    node.id = ids.get(template.id)!;
    node.parentId = template.parentId ? ids.get(template.parentId)! : null;
    delete node.templateKey;
    return { type: "create", node };
  });
  let working = transact(doc, { baseRevision: doc.revision, operations });
  const insert = (
    componentId: string,
    x: number,
    y: number,
    properties: Record<string, string> = {},
    texts: Record<string, string> = {},
    parent = "root",
  ) => {
    const library = mobileComponentLibrary(componentId),
      component = library.components[0];
    const variant = component.variants.find(
      (v) =>
        v.properties.Appearance === appearance &&
        Object.entries(properties).every(
          ([key, value]) => v.properties[key] === value,
        ),
    );
    if (!variant) throw new Error(`页面组件变体缺失：${componentId}`);
    const container = b.nodes.find((n) => n.id === parent)!;
    const result = instantiateComponent(
      working,
      library,
      componentId,
      variant.id,
      ids.get(parent)!,
      {
        x: position.x + (parent === "root" ? 0 : container.style.x) + x,
        y: position.y + (parent === "root" ? 0 : container.style.y) + y,
      },
    );
    for (const op of result.operations)
      if (
        op.type === "create" &&
        op.node.templateKey &&
        op.node.templateKey in texts
      )
        op.node.text = texts[op.node.templateKey];
    working = transact(working, {
      baseRevision: working.revision,
      operations: result.operations,
    });
    operations.push(...result.operations);
  };
  ["为你推荐", "发现新声音", "电台与播客"].forEach((label, i) =>
    insert(
      "media-navigation",
      18,
      151 + i * 49,
      { Icon: ["home", "grid", "radio"][i], State: i ? "Default" : "Selected" },
      { label },
      "sidebar",
    ),
  );
  ["喜欢的音乐", "最近播放", "已下载"].forEach((label, i) =>
    insert(
      "media-navigation",
      18,
      365 + i * 49,
      { Icon: ["heart", "clock", "download"][i], State: "Default" },
      { label },
      "sidebar",
    ),
  );
  ["工作时听的歌", "周末慢下来", "去山野走走", "深夜的灵感"].forEach(
    (label, i) =>
      insert(
        "media-navigation",
        18,
        578 + i * 48,
        { Icon: "folder", State: "Default" },
        { label },
        "sidebar",
      ),
  );
  insert("media-feature", 260, 140, { Mood: "Dusk" });
  insert("media-focus", 1054, 140);
  const albums = [
    ["Dusk", "山与回声", "氛围电子 · 24 首"],
    ["Forest", "绿色的呼吸", "自然采样 · 18 首"],
    ["Coast", "沿着海岸线", "独立民谣 · 32 首"],
    ["Ember", "日落之前", "爵士与灵魂 · 26 首"],
    ["Violet", "夜航电台", "深夜精选 · 21 首"],
  ];
  albums.forEach(([Mood, title, subtitle], i) =>
    insert("media-album", i * 234, 0, { Mood }, { title, subtitle }, "albums"),
  );
  insert("media-track", 0, 0, { State: "Playing" }, {}, "tracks");
  insert(
    "media-track",
    0,
    48,
    { State: "Default" },
    {
      number: "02",
      title: "候鸟来信",
      artist: "南方来客 · Letters",
      album: "晴天收件箱",
      duration: "04:16",
    },
    "tracks",
  );
  insert("media-player", 26, 930);
  return { id: ids.get("root")!, operations };
}
