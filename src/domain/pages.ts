import type { DesignDocument } from "./document";
export type { PageRecord } from "./document";
import { remapInteraction } from "./prototype";
function background(
  page: Pick<
    DesignDocument,
    "pageBackground" | "pageBackgroundOpacity" | "pageBackgroundVisible"
  >,
) {
  return {
    pageBackground: page.pageBackground,
    pageBackgroundOpacity: page.pageBackgroundOpacity,
    pageBackgroundVisible: page.pageBackgroundVisible,
  };
}
export const pageList = (
  doc: DesignDocument,
): NonNullable<DesignDocument["pages"]> =>
  doc.pages ?? [{ id: "first", name: "页面 1" }];
export function openPage(doc: DesignDocument, id: string): DesignDocument {
  const pages = pageList(doc),
    current = doc.activePage ?? pages[0].id;
  const target = pages.find((page) => page.id === id);
  if (!target) throw new Error("页面不存在");
  if (id === current) return doc;
  return {
    ...doc,
    activePage: id,
    nodes: target.nodes ?? [],
    ...background(target),
    guides: target.guides,
    comments: target.comments,
    pages: pages.map((page) =>
      page.id === id
        ? { id: page.id, name: page.name }
        : page.id === current
          ? {
              ...page,
              ...background(doc),
              nodes: doc.nodes,
              guides: doc.guides,
              comments: doc.comments,
            }
          : page,
    ),
  };
}
export function addPage(doc: DesignDocument, name: string): DesignDocument {
  const pages = pageList(doc),
    id = crypto.randomUUID();
  return openPage({ ...doc, pages: [...pages, { id, name, nodes: [] }] }, id);
}
export function removePage(doc: DesignDocument): DesignDocument {
  const pages = pageList(doc),
    current = doc.activePage ?? pages[0].id;
  if (pages.length === 1) throw new Error("文件至少保留一个页面");
  const next = openPage(doc, pages.find((page) => page.id !== current)!.id);
  return { ...next, pages: next.pages!.filter((page) => page.id !== current) };
}
export function duplicatePage(doc: DesignDocument): DesignDocument {
  const name = pageList(doc).find(
    (page) => page.id === (doc.activePage ?? "first"),
  )!.name;
  const ids = new Map(doc.nodes.map((node) => [node.id, crypto.randomUUID()]));
  return {
    ...addPage(doc, name.slice(0, 116) + " 副本"),
    ...background(doc),
    guides: doc.guides?.map((g) => ({ ...g, id: crypto.randomUUID() })),
    comments: doc.comments?.map((c) => ({
      ...structuredClone(c),
      id: crypto.randomUUID(),
      nodeId: c.nodeId ? (ids.get(c.nodeId) ?? c.nodeId) : undefined,
      replies: c.replies.map((r) => ({ ...r, id: crypto.randomUUID() })),
    })),
    nodes: doc.nodes.map((node) => {
      const copy = structuredClone(node);
      copy.id = ids.get(node.id)!;
      delete copy.componentSet;
      copy.parentId = node.parentId ? ids.get(node.parentId)! : null;
      if (copy.maskSourceId) copy.maskSourceId = ids.get(copy.maskSourceId);
      remapInteraction(copy, ids);
      return copy;
    }),
  };
}
export function reorderPage(
  doc: DesignDocument,
  source: string,
  target: string,
  side?: "before" | "after",
): DesignDocument {
  const pages = pageList(doc).slice(),
    from = pages.findIndex((page) => page.id === source),
    to = pages.findIndex((page) => page.id === target);
  if (from === -1 || to === -1 || from === to) return doc;
  const [moved] = pages.splice(from, 1);
  const index = side
    ? pages.findIndex((page) => page.id === target) + Number(side === "after")
    : to;
  if (index === from) return doc;
  pages.splice(index, 0, moved);
  return { ...doc, pages };
}
export function currentPageOnly(doc: DesignDocument): DesignDocument {
  const { activePage: _activePage, pages: _pages, ...current } = doc;
  return current;
}
