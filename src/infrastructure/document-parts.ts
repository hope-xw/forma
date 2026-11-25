import type { DesignDocument, DesignNode } from "../domain/document";
import type { ComponentLibrary } from "../domain/library-schema";
import {
  assetByteLength,
  maxAssetBytes,
  maxDocumentAssetBytes,
  maxEncodedAssetLength,
} from "../domain/asset-bytes";
type Asset = { data: string };
type AssetMap = Record<string, Asset> | undefined;
type Assets = { images?: AssetMap; fonts?: AssetMap };
type Component = ComponentLibrary["components"][number];
export type DocumentPart =
  | { kind: "header"; document: DesignDocument }
  | {
      kind: "issues";
      issues: NonNullable<DesignDocument["importReport"]>["issues"];
    }
  | { kind: "page"; page: string | null; nodes: DesignNode[] }
  | { kind: "component"; library: string; component: Component }
  | {
      kind: "variant";
      library: string;
      component: string;
      variant: string;
      nodes: DesignNode[];
    };

function nodeWeight(node: DesignNode) {
  return (
    node.name.length +
    node.text.length +
    (node.textRuns?.reduce(
      (sum, run) => sum + 40 + JSON.stringify(run.style).length,
      0,
    ) ?? 0) +
    (node.sourceTextShape?.d.length ?? 0) +
    (node.sourceTextLayout?.lines.reduce(
      (sum, line) => sum + line.text.length + line.x.length * 12,
      0,
    ) ?? 0) +
    (node.vector?.paths.reduce((s, p) => s + p.d.length, 0) ?? 0)
  );
}
export function useLargeDocumentFormat(doc: DesignDocument) {
  const limit = 16 * 1024 * 1024;
  const issues = doc.importReport?.issues ?? [];
  if (issues.length > 2000) return true;
  let weight = issues.reduce(
    (sum, i) => sum + i.node.length + i.detail.length,
    0,
  );
  const groups = [
    doc.nodes,
    ...(doc.pages ?? []).flatMap((p) => (p.nodes ? [p.nodes] : [])),
  ];
  for (const table of [doc, ...Object.values(doc.libraries ?? {})]) {
    for (const assets of [table.images, table.fonts])
      for (const asset of Object.values(assets ?? {})) {
        weight += asset.data.length;
        if (weight > limit) return true;
      }
    if ("components" in table)
      for (const c of table.components)
        for (const v of c.variants) groups.push(v.nodes);
  }
  if (groups.reduce((sum, nodes) => sum + nodes.length, 0) > 10000) return true;
  for (const nodes of groups)
    for (const node of nodes) {
      weight += nodeWeight(node);
      if (weight > limit) return true;
    }
  return weight > limit;
}
function tables<T extends Assets>(
  item: T,
  transform: (asset: Asset, id: string) => Asset,
): T {
  const copy = { ...item };
  for (const key of ["images", "fonts"] as const)
    if (item[key]) {
      Object.assign(copy, {
        [key]: Object.fromEntries(
          Object.entries(item[key]!).map(([id, a]) => [id, transform(a, id)]),
        ),
      });
    }
  return copy;
}
export function splitDocument(doc: DesignDocument) {
  const assets = new Map<string, string>();
  let total = 0;
  function separate(asset: Asset, id: string) {
    const prior = assets.get(id);
    if (prior !== undefined && prior !== asset.data)
      throw Error("同一资源 ID 的内容不一致：" + id);
    if (prior === undefined) {
      const length = assetByteLength(asset.data);
      if (asset.data.length > maxEncodedAssetLength || length > maxAssetBytes)
        throw Error("单个资源超过 32 MiB：" + id);
      total += length;
      if (total > maxDocumentAssetBytes)
        throw Error("文件的独立图片与字体总量超过 256 MiB");
      assets.set(id, asset.data);
    }
    return { ...asset, data: "@" + id };
  }
  let header = tables(doc, separate);
  header = { ...header, nodes: [] };
  if (header.pages)
    header.pages = header.pages.map((p) => (p.nodes ? { ...p, nodes: [] } : p));
  if (header.libraries)
    header.libraries = Object.fromEntries(
      Object.entries(header.libraries).map(([id, l]) => [
        id,
        { ...tables(l, separate), components: [] },
      ]),
    );
  if (header.importReport)
    header.importReport = { ...header.importReport, issues: [] };
  function* nodeSlices(nodes: DesignNode[]) {
    let group: DesignNode[] = [],
      cost = 0;
    for (const node of nodes) {
      const weight = nodeWeight(node);
      if (
        group.length &&
        (group.length === 128 || cost + weight > 512 * 1024)
      ) {
        yield group;
        group = [];
        cost = 0;
      }
      group.push(node);
      cost += weight;
    }
    if (group.length) yield group;
  }
  function* parts(): Generator<DocumentPart> {
    yield { kind: "header", document: header };
    for (const [id, nodes] of [
      [null, doc.nodes] as const,
      ...(doc.pages ?? [])
        .filter((p) => p.nodes)
        .map((p) => [p.id, p.nodes!] as const),
    ]) {
      for (const slice of nodeSlices(nodes))
        yield { kind: "page", page: id, nodes: slice };
    }
    const issues = doc.importReport?.issues ?? [];
    for (let i = 0; i < issues.length; i += 128)
      yield { kind: "issues", issues: issues.slice(i, i + 128) };
    for (const [id, l] of Object.entries(doc.libraries ?? {}))
      for (const c of l.components) {
        yield {
          kind: "component",
          library: id,
          component: {
            ...c,
            variants: c.variants.map((v) => ({ ...v, nodes: [] })),
          },
        };
        for (const v of c.variants)
          for (const nodes of nodeSlices(v.nodes))
            yield {
              kind: "variant",
              library: id,
              component: c.id,
              variant: v.id,
              nodes,
            };
      }
  }
  return { assets, parts };
}

// Each part appends to one declared page or component variant; no generic path
// evaluation is involved. Final domain validation also checks all references.
export function joinDocumentParts() {
  let doc: DesignDocument | undefined;
  const pages = new Map<string, DesignNode[]>();
  let component: Component | undefined,
    libraryId = "";
  const variants = new Map<string, DesignNode[]>();
  function append(target: DesignNode[] | undefined, nodes: DesignNode[]) {
    if (!target || !Array.isArray(nodes) || nodes.length > 128)
      throw Error("分块文件的图层目标无效");
    target.push(...nodes);
  }
  function push(part: DocumentPart) {
    if (!part || typeof part !== "object")
      throw Error("分块文件包含无效的记录");
    if (!doc) {
      if (
        part?.kind !== "header" ||
        !part.document ||
        !Array.isArray(part.document.nodes)
      )
        throw Error("分块文件缺少首页记录");
      doc = part.document;
      if (doc.pages !== undefined && !Array.isArray(doc.pages))
        throw Error("分块文件的页面列表无效");
      for (const p of doc.pages ?? []) {
        if (!p || (p.nodes !== undefined && !Array.isArray(p.nodes)))
          throw Error("分块文件的页面图层列表无效");
        if (p.nodes) pages.set(p.id, p.nodes);
      }
      if (doc.importReport && !Array.isArray(doc.importReport.issues))
        throw Error("分块文件的导入问题列表无效");
      for (const library of Object.values(doc.libraries ?? {}))
        if (!Array.isArray(library?.components))
          throw Error("分块文件的组件列表无效");
      return;
    }
    if (part.kind === "page")
      append(part.page === null ? doc.nodes : pages.get(part.page), part.nodes);
    else if (
      part.kind === "issues" &&
      doc.importReport &&
      Array.isArray(part.issues) &&
      part.issues.length <= 128
    )
      doc.importReport.issues.push(...part.issues);
    else if (part.kind === "component") {
      if (!doc.libraries || !Object.hasOwn(doc.libraries, part.library))
        throw Error("分块文件的组件库不存在");
      libraryId = part.library;
      component = part.component;
      variants.clear();
      if (!Array.isArray(component?.variants))
        throw Error("分块文件的变体列表无效");
      for (const v of component.variants) {
        if (!Array.isArray(v?.nodes)) throw Error("分块文件的变体图层列表无效");
        variants.set(v.id, v.nodes);
      }
      doc.libraries[libraryId].components.push(component);
    } else if (
      part.kind === "variant" &&
      component?.id === part.component &&
      part.library === libraryId
    )
      append(variants.get(part.variant), part.nodes);
    else throw Error("分块文件包含无效的记录");
  }
  function finish(assets: ReadonlyMap<string, string>) {
    if (!doc) throw Error("分块文件没有设计文档");
    function attach(asset: Asset, id: string) {
      const data = assets.get(id);
      if (asset.data !== "@" + id || data === undefined)
        throw Error("分块文件缺少资源：" + id);
      return { ...asset, data };
    }
    const output = tables(doc, attach);
    if (doc.libraries)
      output.libraries = Object.fromEntries(
        Object.entries(doc.libraries).map(([id, l]) => [id, tables(l, attach)]),
      );
    return output;
  }
  return { push, finish };
}
