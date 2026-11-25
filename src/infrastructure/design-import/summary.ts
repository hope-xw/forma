import type { DesignDocument, ImportIssue } from "../../domain/document";

export type ImportIssueCategory =
  "font" | "style" | "component" | "layout" | "other";

export const importIssueCategoryLabels: Record<
  ImportIssueCategory | "all",
  string
> = {
  all: "全部",
  font: "字体与排版",
  style: "材质与样式",
  component: "组件与覆盖",
  layout: "布局与矢量",
  other: "其他",
};

export function classifyImportIssue(detail: string): ImportIssueCategory {
  if (/字体|字形|排字|排版|字距|行高|段内/.test(detail)) return "font";
  if (
    /玻璃|Liquid Glass|阴影|模糊|混合|Plus Darker|着色|Tint|色变量|颜色|渐变|描边|填充|样式|变量|色域/.test(
      detail,
    )
  )
    return "style";
  if (/主件|实例|换件|覆盖|组件|插槽|Symbol/.test(detail)) return "component";
  if (
    /布局|尺寸|边界|圆角|路径|矢量|蒙版|变换|缩放|倾斜|栈|原型|节点/.test(
      detail,
    )
  )
    return "layout";
  return "other";
}

export function issueWeight(issue: ImportIssue): number {
  return issue.count && issue.count > 1 ? issue.count : 1;
}

export function importSummary(doc: DesignDocument) {
  const issueIds = new Set(doc.importReport?.issues.map((issue) => issue.node));
  let instances = 0,
    layers = 0;
  const positions = new Map<
    string,
    { page: string; pageName: string; name: string }
  >();
  const labels = new Map<string, string>();

  const pageNames = new Map<string, string>();
  for (const page of doc.pages ?? []) {
    pageNames.set(page.id, page.name);
    if (issueIds.has(page.id)) labels.set(page.id, `页面 · ${page.name}`);
  }

  function scan(page: string, nodes: DesignDocument["nodes"]) {
    const pageName = pageNames.get(page) ?? "";
    layers += nodes.length;
    for (const node of nodes) {
      if (node.instance) instances++;
      if (issueIds.has(node.id))
        positions.set(node.id, {
          page,
          pageName,
          name: node.name || "未命名图层",
        });
    }
  }
  scan(doc.activePage ?? "first", doc.nodes);
  for (const page of doc.pages ?? []) if (page.nodes) scan(page.id, page.nodes);

  for (const [id, v] of Object.entries(doc.designSystem?.variables ?? {})) {
    if (issueIds.has(id) && !positions.has(id)) {
      labels.set(id, `${v.type === "color" ? "色变量" : "变量"} · ${v.name}`);
    }
  }
  for (const [id, s] of Object.entries(doc.designSystem?.styles ?? {})) {
    if (issueIds.has(id) && !positions.has(id)) {
      labels.set(id, `样式 · ${s.name}`);
    }
  }
  for (const lib of Object.values(doc.libraries ?? {})) {
    for (const comp of lib.components) {
      if (issueIds.has(comp.id) && !positions.has(comp.id))
        labels.set(comp.id, `组件 · ${comp.name}`);
      if (
        comp.master?.nodeId &&
        issueIds.has(comp.master.nodeId) &&
        !positions.has(comp.master.nodeId)
      )
        labels.set(comp.master.nodeId, `主组件 · ${comp.name}`);
      for (const v of comp.variants) {
        if (issueIds.has(v.id) && !positions.has(v.id))
          labels.set(v.id, `组件变体 · ${comp.name} / ${v.name}`);
      }
    }
  }
  for (const [id, label] of [
    ["document", "文档全局"],
    ["DOCUMENT", "文档全局"],
    ["canvas.fig", "Figma 源归档"],
    ["字体", "字体检查"],
  ] as const) {
    if (issueIds.has(id) && !positions.has(id) && !labels.has(id))
      labels.set(id, label);
  }
  if (doc.importReport?.filename && issueIds.has(doc.importReport.filename)) {
    labels.set(doc.importReport.filename, "源文件");
  }

  return {
    positions,
    labels,
    values: [
      ["页面", doc.pages?.length ?? 1],
      ["可选图层", layers],
      [
        "组件",
        Object.values(doc.libraries ?? {}).reduce(
          (n, lib) => n + lib.components.length,
          0,
        ),
      ],
      ["实例", instances],
      ["样式", Object.keys(doc.designSystem?.styles ?? {}).length],
      ["图片", Object.keys(doc.images ?? {}).length],
    ] as [string, number][],
  };
}
export type ImportSummary = ReturnType<typeof importSummary>;
