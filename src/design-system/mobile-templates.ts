import { createMediaTemplate } from "./mobile-media-template";
import { createNode, type DesignDocument } from "../domain/document";
import { transact, type Operation } from "../domain/commands";
import { instantiateComponent } from "../domain/library";
import { mobileComponentLibrary } from "./mobile";
import {
  MobileBuilder,
  mobileThemes,
  type Appearance,
} from "./mobile-foundations";
import type { Point } from "../domain/geometry";
export const mobileTemplates = [
  {
    id: "music",
    name: "平板 · 声场音乐工作台",
    description: "复杂页面 · 分层封面、玻璃播放器、曲目与组件",
    width: 1440,
    height: 1024,
  },
  {
    id: "settings",
    name: "手机 · 设置",
    description: "分组列表、账号与系统开关",
    width: 390,
    height: 844,
  },
  {
    id: "explore",
    name: "手机 · 内容发现",
    description: "搜索、内容卡片与底部导航",
    width: 390,
    height: 844,
  },
  {
    id: "tablet",
    name: "平板 · 工作空间",
    description: "分栏导航与内容区",
    width: 1194,
    height: 834,
  },
] as const;
export function createMobileTemplate(
  doc: DesignDocument,
  id: string,
  appearance: Appearance,
  position: Point,
) {
  if (id === "music") return createMediaTemplate(doc, appearance, position);
  const template = mobileTemplates.find((t) => t.id === id);
  if (!template) throw new Error("模板不存在");
  const theme = mobileThemes[appearance],
    root = createNode("frame");
  root.name = `${template.name} · ${appearance}`;
  Object.assign(root.style, {
    ...position,
    width: template.width,
    height: template.height,
    fill: theme.canvas,
    padding: 0,
    radius: 28,
    clipContent: true,
  });
  const operations: Operation[] = [{ type: "create", node: root }];
  let working = transact(doc, { baseRevision: doc.revision, operations });
  const insert = (
    componentId: string,
    x: number,
    y: number,
    props: Record<string, string> = {},
    patchText?: Record<string, string>,
  ) => {
    const library = mobileComponentLibrary(componentId),
      c = library.components[0];
    const variant = c.variants.find(
      (v) =>
        v.properties.Appearance === appearance &&
        Object.entries(props).every(([k, value]) => v.properties[k] === value),
    )!;
    const result = instantiateComponent(
      working,
      library,
      c.id,
      variant.id,
      root.id,
      { x: position.x + x, y: position.y + y },
    );
    if (patchText)
      for (const op of result.operations)
        if (op.type === "create" && patchText[op.node.templateKey!])
          op.node.text = patchText[op.node.templateKey!];
    working = transact(working, {
      baseRevision: working.revision,
      operations: result.operations,
    });
    operations.push(...result.operations);
  };
  const label = (
    key: string,
    text: string,
    x: number,
    y: number,
    width: number,
    size: number,
  ) => {
    const b = new MobileBuilder(appearance, "label", width, 40);
    const n = b.text(key, text, x, y, width, size, {
      fontWeight: 600,
      color: theme.muted,
    });
    n.id = crypto.randomUUID();
    n.parentId = root.id;
    delete n.templateKey;
    const op: Operation = { type: "create", node: n };
    operations.push(op);
    working = transact(working, {
      baseRevision: working.revision,
      operations: [op],
    });
  };
  if (id === "tablet") {
    insert("menu-bar", 0, 0);
    insert("sidebar", 20, 54, { Material: "Solid" });
    label("title", "下午好，小满", 340, 74, 780, 32);
    label("subtitle", "继续整理你的创意与项目", 340, 132, 700, 16);
    insert("search", 340, 182);
    insert("card", 340, 260);
    insert("widget", 710, 260, { Size: "Medium" });
    insert(
      "list-row",
      710,
      460,
      { Accessory: "Subtitle" },
      { title: "最近更新", subtitle: "查看团队的新动态" },
    );
    insert("card", 340, 544);
    insert("progress", 730, 584, { Value: "50" });
  } else {
    insert("status-bar", 0, 0);
    insert(
      "navigation",
      0,
      52,
      { Title: "Large", Material: "Solid" },
      { title: id === "settings" ? "设置" : "发现" },
    );
    if (id === "settings") {
      insert(
        "list-row",
        20,
        190,
        { Accessory: "Subtitle" },
        { title: "林小满", subtitle: "个人账号与同步" },
      );
      label("section", "偏好设置", 36, 298, 318, 13);
      ["通知与提醒", "隐私与安全", "显示与外观"].forEach((title, i) =>
        insert(
          "list-row",
          20,
          336 + i * 60,
          { Accessory: "Chevron" },
          { title },
        ),
      );
      label("section-2", "同步", 36, 548, 318, 13);
      insert(
        "list-row",
        20,
        586,
        { Accessory: "Chevron" },
        { title: "自动同步" },
      );
      insert("toggle", 296, 600, { Value: "On" });
      insert(
        "list-row",
        20,
        646,
        { Accessory: "Subtitle" },
        { title: "存储空间", subtitle: "已使用 2.4 GB / 10 GB" },
      );
    } else {
      insert("search", 25, 188);
      insert("segmented", 35, 258, { Value: "Overview" });
      insert("card", 25, 326);
      insert(
        "list-row",
        20,
        600,
        { Accessory: "Subtitle" },
        { title: "你的灵感收藏", subtitle: "12 个新项目等待探索" },
      );
      insert("tab-bar", 16, 720, { Selected: "Explore", Material: "Glass" });
    }
    insert("home-indicator", 0, 810);
  }
  return { id: root.id, operations };
}
