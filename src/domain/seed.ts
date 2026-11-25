import { createNode, type DesignDocument, type DesignNode } from "./document";
export function createStarter(): DesignDocument {
  const desktop = createNode("frame");
  desktop.name = "01 / 工作空间";
  desktop.style = {
    ...desktop.style,
    width: 760,
    height: 540,
    x: 80,
    y: 80,
    layout: "column",
    padding: 40,
    gap: 20,
  };
  const mobile = createNode("frame");
  mobile.name = "02 / 移动端";
  mobile.style = {
    ...mobile.style,
    width: 320,
    height: 540,
    x: 900,
    y: 80,
    layout: "column",
    padding: 28,
    gap: 20,
  };
  const children = (parent: DesignNode): DesignNode[] => {
    const title = createNode("text", parent.id);
    title.name = "标题";
    title.text = "让好设计，发生。";
    title.style = {
      ...title.style,
      width: parent.style.width - 2 * parent.style.padding,
      height: 64,
      fontSize: parent.id === desktop.id ? 36 : 28,
    };
    const subtitle = createNode("text", parent.id);
    subtitle.name = "描述";
    subtitle.text = "从一个想法开始，和团队一起创造下一个作品。";
    subtitle.style = {
      ...subtitle.style,
      width: title.style.width,
      height: 60,
      color: "#64748b",
    };
    const card = createNode("frame", parent.id);
    card.name = "内容卡片";
    card.style = {
      ...card.style,
      width: title.style.width,
      height: 140,
      fill: "#f2f0ff",
      radius: 16,
      layout: "column",
      padding: 24,
    };
    const label = createNode("text", card.id);
    label.text = "你的下一个灵感";
    label.style = {
      ...label.style,
      width: card.style.width - 48,
      height: 40,
      fontSize: 20,
    };
    const button = createNode("button", parent.id);
    button.name = "开始创作";
    button.text = "创建新项目";
    button.fillToken = "brand";
    return [title, subtitle, card, label, button];
  };
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: "未命名设计文件",
    revision: 0,
    nodes: [desktop, ...children(desktop), mobile, ...children(mobile)],
    tokens: { brand: { name: "品牌 / 主色", value: "#635bff" } },
  };
}
