import { MobileBuilder, type Appearance } from "./mobile-foundations";
import type { MobileDefinition } from "./mobile-controls";
import type { NodeStyle } from "../domain/document";

export const mediaGradient = (
  colors: string[],
  angle = 135,
): NonNullable<NodeStyle["gradient"]> => ({
  type: "linear",
  angle,
  stops: colors.map((color, i) => ({
    color,
    offset: i / (colors.length - 1),
    opacity: 1,
  })),
});
const palettes = {
  Dusk: ["#302f69", "#b478a8", "#edb995"],
  Forest: ["#123b3d", "#447e72", "#bad4a9"],
  Coast: ["#21486e", "#70a4b3", "#e4d6b6"],
  Ember: ["#4d2a43", "#bd6659", "#f1c38a"],
  Violet: ["#262648", "#6255a2", "#a5a1d6"],
};
export type MediaMood = keyof typeof palettes;
/** Original, editable vector landscapes. No remote images, SF Symbols or Apple assets. */
export function mediaArtwork(
  b: MobileBuilder,
  key: string,
  x: number,
  y: number,
  width: number,
  height: number,
  mood: string,
  parent = "root",
) {
  const palette = palettes[mood as MediaMood] ?? palettes.Dusk;
  const frame = b.add(
    "frame",
    key,
    parent,
    {
      x,
      y,
      width,
      height,
      padding: 0,
      radius: 14,
      clipContent: true,
      gradient: mediaGradient(palette, 155),
    },
    `封面 / ${mood}`,
  );
  b.add(
    "ellipse",
    `${key}-sun`,
    frame.id,
    {
      x: width * 0.61,
      y: height * 0.12,
      width: width * 0.22,
      height: width * 0.22,
      fill: "#fff5dc",
      opacity: 0.8,
      blur: 1,
    },
    "柔光太阳",
  );
  for (let i = 0; i < 5; i++) {
    const hill = b.add(
      "vector",
      `${key}-ridge-${i}`,
      frame.id,
      {
        x: -width * 0.05,
        y: height * (0.28 + i * 0.12),
        width: width * 1.1,
        height: height * 0.8,
        color: palette[i % 2],
        opacity: 0.3 + i * 0.12,
      },
      `山脊 ${i + 1}`,
    );
    hill.vector = {
      width: 300,
      height: 200,
      paths: [
        {
          d: `M0 ${80 - i * 8} C55 ${-20 + i * 14} 88 ${145 - i * 12} 155 ${55 + i * 5} S240 ${-15 + i * 12} 300 ${65 - i * 9} V200 H0 Z`,
          fill: true,
          strokeWidth: 0,
        },
      ],
    };
  }
  for (let i = 0; i < 4; i++)
    b.box(
      `${key}-haze-${i}`,
      width * 0.1,
      height * (0.72 + i * 0.035),
      width * (0.5 + i * 0.07),
      1,
      { fill: "#ffffff", opacity: 0.13 },
      frame.id,
    );
  if (width >= 100)
    b.text(
      `${key}-edition`,
      "FIELD NOTES / 026",
      14,
      14,
      width - 28,
      8,
      { color: "#ffffff", letterSpacing: 2, opacity: 0.7 },
      frame.id,
    );
  return frame;
}
const mediaBase = (a: Appearance, name: string, w: number, h: number) =>
  new MobileBuilder(a, name, w, h);
export const mediaDefinitions: MobileDefinition[] = [
  {
    id: "media-album",
    name: "音乐 · 专辑卡片",
    category: "媒体与复杂页面",
    description: "五种原创矢量封面、文字、收藏标记与播放入口。",
    axes: { Mood: Object.keys(palettes) },
    build(a, p) {
      const b = mediaBase(a, "专辑卡片", 208, 254);
      b.root.style.fillOpacity = 0;
      mediaArtwork(b, "artwork", 0, 0, 208, 188, p.Mood);
      b.box("play-disc", 158, 138, 36, 36, {
        radius: 18,
        fill: "#ffffff",
        fillOpacity: 0.23,
        backdropBlur: 16,
        stroke: "#ffffff",
        strokeWidth: 0.5,
      });
      b.icon("play", "play", 169, 149, 14, "#ffffff");
      b.text("title", "山与回声", 0, 201, 180, 16, { fontWeight: 650 });
      b.text("subtitle", "氛围电子 · 24 首", 0, 228, 190, 12, {
        color: b.theme.muted,
      });
      b.icon("saved", "heart", 188, 206, 16, b.theme.muted);
      return b;
    },
  },
  {
    id: "media-navigation",
    name: "音乐 · 侧栏导航项",
    category: "媒体与复杂页面",
    description: "可切换图标与选中状态的导航组件。",
    axes: {
      Icon: ["home", "grid", "radio", "heart", "clock", "download", "folder"],
      State: ["Default", "Selected"],
    },
    build(a, p) {
      const b = mediaBase(a, "导航项", 188, 42);
      Object.assign(b.root.style, {
        radius: 10,
        fill: b.theme.accent,
        fillOpacity: p.State === "Selected" ? 0.12 : 0,
      });
      b.icon(
        "icon",
        p.Icon as "home",
        14,
        11,
        20,
        p.State === "Selected" ? b.theme.accent : b.theme.muted,
      );
      b.text("label", "为你推荐", 46, 10, 128, 14, {
        fontWeight: p.State === "Selected" ? 650 : 450,
        color: p.State === "Selected" ? b.theme.accent : b.theme.text,
      });
      return b;
    },
  },
  {
    id: "media-track",
    name: "音乐 · 曲目行",
    category: "媒体与复杂页面",
    description: "编号、封面、双层文案、均衡器、收藏和更多操作。",
    axes: { State: ["Default", "Playing"] },
    build(a, p) {
      const b = mediaBase(a, "曲目行", 750, 48);
      Object.assign(b.root.style, {
        radius: 9,
        fillOpacity: p.State === "Playing" ? 1 : 0,
        fill: b.theme.secondary,
      });
      b.text("number", "01", 12, 14, 24, 12, { color: b.theme.muted });
      mediaArtwork(b, "cover", 44, 6, 36, 36, "Forest");
      b.text("title", "慢慢醒来", 96, 5, 260, 14, { fontWeight: 600 });
      b.text("artist", "远山电台 · Morning Sessions", 96, 27, 300, 10, {
        color: b.theme.muted,
      });
      b.text("album", "山间来信", 414, 15, 145, 12, { color: b.theme.muted });
      if (p.State === "Playing")
        for (let i = 0; i < 5; i++)
          b.box(
            `level-${i}`,
            574 + i * 4,
            24 - [4, 8, 12, 6, 10][i] / 2,
            2,
            [4, 8, 12, 6, 10][i],
            { fill: b.theme.accent, radius: 1 },
          );
      b.icon("favorite", "heart", 614, 16, 16, b.theme.muted);
      b.text("duration", "03:42", 651, 15, 48, 12, { color: b.theme.muted });
      b.icon("more", "more", 716, 15, 18, b.theme.muted);
      return b;
    },
  },
  {
    id: "media-feature",
    name: "音乐 · 编辑精选",
    category: "媒体与复杂页面",
    description: "分层山景、渐变遮罩、玻璃标签与主操作的复杂组合。",
    axes: { Mood: ["Dusk", "Forest"] },
    build(a, p) {
      const b = mediaBase(a, "编辑精选", 770, 300);
      Object.assign(b.root.style, {
        radius: 22,
        clipContent: true,
        fill: "#272d40",
      });
      mediaArtwork(b, "landscape", 290, -35, 490, 370, p.Mood);
      b.box("scrim", 0, 0, 770, 300, {
        gradient: {
          type: "linear",
          angle: 90,
          stops: [
            { offset: 0, color: "#182638", opacity: 1 },
            { offset: 0.42, color: "#182638", opacity: 0.9 },
            { offset: 1, color: "#182638", opacity: 0 },
          ],
        },
      });
      b.text("eyebrow", "本周编辑精选", 30, 29, 300, 11, {
        color: "#d3d6e5",
        letterSpacing: 3,
      });
      b.text("title", "把喧嚣留在远处。", 30, 76, 445, 32, {
        fontWeight: 650,
        color: "#ffffff",
        letterSpacing: -1,
      });
      b.text(
        "subtitle",
        "从日落到星光，让旋律陪你慢下来。\n一份关于独处、远行与松弛的声音记录。",
        32,
        132,
        400,
        13,
        { color: "#c6cbd8", lineHeight: 23, height: 52 },
      );
      b.box("play-button", 30, 219, 123, 42, { fill: "#ffffff", radius: 21 });
      b.icon("play", "play", 49, 233, 14, "#26364c");
      b.text("play-label", "播放精选", 72, 229, 75, 14, {
        fontWeight: 600,
        color: "#26364c",
      });
      b.box("save-button", 164, 219, 42, 42, {
        fill: "#ffffff",
        fillOpacity: 0.12,
        radius: 21,
        stroke: "#ffffff",
        strokeWidth: 0.5,
      });
      b.icon("save", "plus", 176, 231, 18, "#ffffff");
      b.box("glass-label", 552, 246, 191, 30, {
        fill: "#ffffff",
        fillOpacity: 0.17,
        backdropBlur: 20,
        radius: 15,
        stroke: "#ffffff",
        strokeWidth: 0.5,
      });
      b.icon("headphones", "headphones", 566, 254, 14, "#ffffff");
      b.text("badge", "38 首 · 2 小时 26 分钟", 589, 253, 142, 10, {
        color: "#ffffff",
      });
      return b;
    },
  },
  {
    id: "media-focus",
    name: "音乐 · 专注混音",
    category: "媒体与复杂页面",
    description: "原创声波可视化、多层透明度与玻璃操作卡。",
    build(a) {
      const b = mediaBase(a, "专注混音", 350, 300);
      Object.assign(b.root.style, {
        radius: 22,
        clipContent: true,
        gradient: mediaGradient(
          a === "Dark" ? ["#33334f", "#1e293e"] : ["#e9e6f4", "#d7e4ee"],
        ),
      });
      b.icon("sparkles", "sparkles", 25, 25, 20, b.theme.text);
      b.text("eyebrow", "为你调频", 56, 26, 240, 12, { fontWeight: 600 });
      b.text("title", "进入心流", 25, 66, 280, 27, { fontWeight: 650 });
      b.text("subtitle", "少一点打扰，多一点灵感。", 26, 110, 280, 13, {
        color: b.theme.muted,
      });
      for (let i = 0; i < 37; i++) {
        const height =
          12 +
          Math.round(
            Math.abs(Math.sin(i * 0.43)) *
              Math.sin(((i + 1) / 38) * Math.PI) *
              52,
          );
        b.box(`wave-${i}`, 27 + i * 8, 183 - height / 2, 3, height, {
          fill: a === "Dark" ? "#b3a2ed" : "#8d82ba",
          radius: 2,
          opacity: 0.4 + Math.sin(((i + 1) / 38) * Math.PI) * 0.6,
        });
      }
      b.box("action", 24, 242, 302, 35, {
        fill: b.theme.surface,
        fillOpacity: 0.6,
        backdropBlur: 12,
        radius: 18,
      });
      b.icon("play", "play", 44, 253, 12, b.theme.text);
      b.text("action-label", "开启 45 分钟专注", 67, 250, 228, 12, {
        fontWeight: 600,
      });
      return b;
    },
  },
  {
    id: "media-player",
    name: "音乐 · 玻璃播放器",
    category: "媒体与复杂页面",
    description: "浮动玻璃材质、播放进度、音量、队列及设备切换。",
    build(a) {
      const b = mediaBase(a, "正在播放", 1388, 80);
      b.glass();
      Object.assign(b.root.style, {
        radius: 20,
        fillOpacity: a === "Dark" ? 0.9 : 0.86,
      });
      mediaArtwork(b, "cover", 12, 10, 60, 60, "Forest");
      b.text("title", "慢慢醒来", 88, 17, 220, 14, { fontWeight: 600 });
      b.text("artist", "远山电台", 88, 44, 220, 11, { color: b.theme.muted });
      b.icon("favorite", "heart", 303, 29, 21, b.theme.muted);
      b.icon("shuffle", "shuffle", 554, 14, 18, b.theme.muted);
      b.icon("previous", "previous", 597, 14, 18);
      b.box("play-disc", 638, 5, 38, 38, { fill: b.theme.text, radius: 19 });
      b.icon("pause", "pause", 650, 17, 14, b.theme.surface);
      b.icon("next", "next", 700, 14, 18);
      b.icon("repeat", "repeat", 746, 14, 18, b.theme.muted);
      b.text("elapsed", "1:24", 474, 53, 44, 10, { color: b.theme.muted });
      b.box("track", 522, 59, 290, 3, { fill: b.theme.secondary, radius: 2 });
      b.box("progress", 522, 59, 116, 3, { fill: b.theme.accent, radius: 2 });
      b.add("ellipse", "thumb", "root", {
        x: 634,
        y: 56,
        width: 8,
        height: 8,
        fill: b.theme.accent,
      });
      b.text("remaining", "3:42", 828, 53, 44, 10, { color: b.theme.muted });
      b.icon("device", "monitor", 1056, 29, 20, b.theme.muted);
      b.icon("volume", "volume", 1101, 29, 20, b.theme.muted);
      b.box("volume-track", 1133, 38, 98, 3, {
        fill: b.theme.secondary,
        radius: 2,
      });
      b.box("volume-level", 1133, 38, 62, 3, {
        fill: b.theme.muted,
        radius: 2,
      });
      b.icon("queue", "list", 1270, 29, 20, b.theme.muted);
      b.icon("expand", "expand", 1326, 29, 20, b.theme.muted);
      return b;
    },
  },
];
