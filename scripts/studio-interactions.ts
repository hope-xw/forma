import type { DesignDocument, DesignNode } from "../src/domain/document";
import type { PrototypeAction } from "../src/domain/prototype";
import { subtreeIds } from "../src/domain/tree";

/** Connect the independently editable iPad screens and extract a reusable overlay board. */
export function wireStudio(doc: DesignDocument) {
  const required = (node: DesignNode | undefined, name: string) => {
    if (!node) throw new Error("样例缺少图层 " + name);
    return node;
  };
  const root = (name: string) =>
    required(
      doc.nodes.find((n) => !n.parentId && n.name === name),
      name,
    );
  const child = (parent: DesignNode, name: string) =>
    required(
      doc.nodes.find((n) => n.parentId === parent.id && n.name === name),
      name,
    );
  const home = root("分栏导航 · Light"),
    files = root("文件浏览与长按 · Light"),
    detail = root("协作分享 · Light"),
    context = root("上下文菜单 · Light");
  const sheet = child(detail, "协作分享浮层");
  const scope = subtreeIds(doc, [sheet.id]);
  const copies = doc.nodes
    .filter((n) => scope.has(n.id))
    .map((n) => {
      const copy = structuredClone(n);
      copy.id = "sheet-" + n.id;
      copy.parentId = n.id === sheet.id ? null : "sheet-" + n.parentId;
      return copy;
    });
  doc.nodes.push(...copies);
  const overlay = required(
    copies.find((n) => !n.parentId),
    "共享浮层",
  );
  overlay.type = "frame";
  overlay.name = "共享 · 浮层";
  Object.assign(overlay.style, { x: 1420, y: 1910 });
  home.interaction = { flow: "浏览资料库" };
  files.interaction = { flow: "文件操作", scroll: "vertical" };
  const connect = (node: DesignNode, ...actions: PrototypeAction[]) => {
    node.interaction = { ...node.interaction, actions };
  };
  const share: PrototypeAction = {
    kind: "overlay",
    target: overlay.id,
    position: "center",
  };
  const sidebar = child(home, "资料库侧栏");
  connect(child(sidebar, "共享项目"), share);
  connect(child(sidebar, "设计资源"), { kind: "navigate", target: files.id });
  connect(child(home, "trailing"), share);
  connect(child(files, "文件卡片 1"), { kind: "navigate", target: context.id });
  connect(child(files, "tools"), share);
  connect(child(files, "back"), { kind: "back" });
  connect(child(context, "back"), { kind: "back" });
  connect(child(context, "tools"), share);
  connect(child(overlay, "close"), { kind: "close" });
  return doc;
}
