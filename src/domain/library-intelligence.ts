import { resolveNode, resolveVariable } from "./design-system";
import type { DesignSystem } from "./design-system-schema";
import type { DesignDocument, DesignNode, NodeStyle } from "./document";
import { libraryDesignSystem } from "./library-design-system";
import type {
  AssetTier,
  ComponentAiHints,
  ComponentLibrary,
  ComponentVariant,
  LibraryAiGuide,
  LibraryComponent,
} from "./library-schema";

export const CUSTOM_NOTES_START = "<!-- forma:custom-notes:start -->";
export const CUSTOM_NOTES_END = "<!-- forma:custom-notes:end -->";
const tierLabels = {
  page: "Page 页面样板",
  block: "Block 业务模块与楼层",
  component: "Component 原子组件",
} as const;

export interface ComponentManifest {
  libraryId: string;
  libraryName: string;
  componentId: string;
  name: string;
  category: string;
  description: string;
  assetTier: AssetTier;
  isException: boolean;
  aiHints?: ComponentAiHints;
  defaultVariantId: string;
  rootSize: {
    width: number;
    height: number;
    widthMode: NonNullable<NodeStyle["widthMode"]>;
    heightMode: NonNullable<NodeStyle["heightMode"]>;
    layout: NodeStyle["layout"];
  };
  variantAxes: Record<string, string[]>;
  variants: {
    variantId: string;
    name: string;
    properties: Record<string, string>;
    width: number;
    height: number;
  }[];
  textSlots: {
    templateKey: string;
    name: string;
    defaultText: string;
    recommendedMaxChars: number;
    exposedId?: string;
  }[];
  imageSlots: {
    templateKey: string;
    name: string;
    width: number;
    height: number;
    aspectRatio: number | null;
  }[];
  swapSlots: { exposedId: string; name: string; targetTemplateKey: string }[];
  boundTokens: string[];
}

export interface LibraryManifest {
  libraryId: string;
  libraryName: string;
  revision: number;
  description: string;
  platform: string;
  tierCounts: Record<AssetTier, number>;
  categories: string[];
  components: ComponentManifest[];
  exceptionComponents: ComponentManifest[];
  tokensSummary: LibraryTokensSummary;
}

export interface GeneratedLibraryPlaybook {
  manifest: LibraryManifest;
  aiGuide: LibraryAiGuide;
  markdown: string;
}

function words(text: string) {
  return text
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ");
}

function inferTier(
  component: LibraryComponent,
  { width, height }: NodeStyle,
): AssetTier {
  if (component.assetTier) return component.assetTier;
  const label = words(component.category + " " + component.name);
  const children = component.variants[0].nodes.length - 1;
  if (
    (width >= 320 && height >= 520) ||
    (height >= 400 &&
      /页面|模板|样板|整页|会场|屏幕|\b(screens?|pages?|templates?)\b/i.test(
        label,
      ))
  )
    return "page";
  const block =
    /楼层|模块|导航|标签栏|浮层|弹窗|抽屉|表格|侧[边]?栏|宫格|横幅|商品流|列表|卡片|表单区|\b(section|block|header|nav\s?bar|navigation|tab\s?bar|sheet|dialog|modal|table|side\s?bar|card|list|banner|feed)s?\b/i;
  if ((width >= 260 && children >= 4) || (children >= 2 && block.test(label)))
    return "block";
  return "component";
}

function rootOf(variant: ComponentVariant) {
  // parseLibrary guarantees one root, but places no constraint on node order.
  return variant.nodes.find((n) => n.parentId === null)!;
}

function variantResolver(
  variant: ComponentVariant,
  library?: ComponentLibrary,
) {
  if (!library?.designSystem) return (node: DesignNode) => node;
  const doc: DesignDocument = {
    schemaVersion: 1,
    id: library.id,
    name: library.name,
    revision: library.revision,
    tokens: {},
    designSystem: library.designSystem,
    nodes: variant.nodes,
  };
  const byId = new Map(variant.nodes.map((n) => [n.id, n]));
  return (node: DesignNode) => resolveNode(doc, node, byId);
}

export function classifyComponentTier(
  component: LibraryComponent,
  library?: ComponentLibrary,
): AssetTier {
  if (component.assetTier) return component.assetTier;
  const variant = component.variants[0];
  return inferTier(
    component,
    variantResolver(variant, library)(rootOf(variant)).style,
  );
}

const exceptionScenarios: [RegExp, string][] = [
  [
    /空状态|空态|缺省|无数据|无结果|\bempty\b/i,
    "列表为空或搜索没有结果时展示。",
  ],
  [/断网|离线|\boffline\b/i, "连接中断时说明离线状态与恢复方式。"],
  [/骨架|加载|\b(loadings?|skeletons?)\b/i, "等待内容就绪时展示加载反馈。"],
  [/报错|错误|异常|\berrors?\b/i, "操作失败时说明原因和下一步。"],
  [/警告|\b(warnings?|alerts?)\b/i, "需要提醒风险或引起注意时展示。"],
  [/弹窗|对话框|\b(dialogs?|modals?)\b/i, "需要用户确认或处理阻断事项时展示。"],
  [
    /提示|反馈|通知|\b(toast|notice|notification|feedback)s?\b/i,
    "操作结束或状态变化时告知用户。",
  ],
];

function exceptionScenario(
  component: Pick<
    LibraryComponent,
    "name" | "category" | "description" | "aiHints"
  >,
  id: string,
) {
  const text = words(
    [
      id,
      component.name,
      component.category,
      component.description,
      ...(component.aiHints?.tags ?? []),
    ].join(" "),
  );
  return exceptionScenarios.find(([pattern]) => pattern.test(text))?.[1];
}

export function isExceptionComponent(component: LibraryComponent): boolean {
  return exceptionScenario(component, component.id) !== undefined;
}

function textCapacity({ width, height, fontSize, lineHeight }: NodeStyle) {
  const lines = Math.max(
    1,
    Math.floor(height / (lineHeight ?? fontSize * 1.2)),
  );
  return Math.max(
    4,
    Math.min(120, Math.round((width / Math.max(11, fontSize)) * lines * 1.4)),
  );
}

export function extractComponentManifest(
  library: ComponentLibrary,
  component: LibraryComponent,
): ComponentManifest {
  const defaultVariant = component.variants[0];
  const axes = new Map<string, Set<string>>();
  const textSlots = new Map<string, ComponentManifest["textSlots"][number]>();
  const imageSlots = new Map<string, ComponentManifest["imageSlots"][number]>();
  const exposed = component.exposed ?? [];
  const textProperties = new Map(
    exposed.filter((p) => p.kind === "text").map((p) => [p.target, p.id]),
  );
  const nodes: DesignNode[] = [];
  const defaultResolve = variantResolver(defaultVariant, library);
  const { style } = defaultResolve(rootOf(defaultVariant));
  const variants = component.variants.map((v) => {
    for (const [name, value] of Object.entries(v.properties)) {
      if (!axes.has(name)) axes.set(name, new Set());
      axes.get(name)!.add(value);
    }
    const resolve =
      v === defaultVariant ? defaultResolve : variantResolver(v, library);
    // Prefer the default variant for shared slots. Some exposed targets only exist in other variants.
    for (const node of v.nodes) {
      nodes.push(node);
      for (const interaction of node.interactions ?? [])
        nodes.push({ ...node, interaction });
      const templateKey = node.templateKey!;
      if (
        (node.type === "text" || node.type === "button") &&
        !textSlots.has(templateKey)
      ) {
        const resolved = resolve(node);
        const exposedId = textProperties.get(templateKey);
        textSlots.set(templateKey, {
          templateKey,
          name: node.name,
          defaultText: resolved.text,
          recommendedMaxChars:
            component.aiHints?.maxTextChars ?? textCapacity(resolved.style),
          ...(exposedId && { exposedId }),
        });
      }
      if (node.image && !imageSlots.has(templateKey)) {
        const { width, height } = resolve(node).style;
        imageSlots.set(templateKey, {
          templateKey,
          name: node.name,
          width,
          height,
          aspectRatio: height > 0 ? width / height : null,
        });
      }
    }
    const { width, height } =
      v === defaultVariant ? style : resolve(rootOf(v)).style;
    return {
      variantId: v.id,
      name: v.name,
      properties: { ...v.properties },
      width,
      height,
    };
  });
  const dependencies = libraryDesignSystem(library.designSystem, nodes);
  return {
    libraryId: library.id,
    libraryName: library.name,
    componentId: component.id,
    name: component.name,
    category: component.category,
    description: component.description,
    assetTier: inferTier(component, style),
    isException: isExceptionComponent(component),
    aiHints: component.aiHints && structuredClone(component.aiHints),
    defaultVariantId: defaultVariant.id,
    rootSize: {
      width: style.width,
      height: style.height,
      widthMode: style.widthMode ?? "fixed",
      heightMode: style.heightMode ?? "fixed",
      layout: style.layout,
    },
    variantAxes: Object.fromEntries(
      Array.from(axes, ([name, values]) => [name, [...values]]),
    ),
    variants,
    textSlots: [...textSlots.values()],
    imageSlots: [...imageSlots.values()],
    swapSlots: exposed
      .filter((p) => p.kind === "swap")
      .map((p) => ({
        exposedId: p.id,
        name: p.name,
        targetTemplateKey: p.target,
      })),
    boundTokens: [
      ...new Set([
        ...Object.keys(dependencies?.variables ?? {}),
        ...Object.keys(dependencies?.styles ?? {}),
      ]),
    ].sort(),
  };
}

interface NumericToken {
  id: string;
  name: string;
  value: number;
  valuesByMode: Record<string, number>;
}

interface StyleSummary {
  id: string;
  name: string;
  properties: Partial<NodeStyle>;
}

export interface LibraryTokensSummary {
  colors: { id: string; name: string; light: string; dark: string }[];
  radii: NumericToken[];
  spacing: NumericToken[];
  textStyles: StyleSummary[];
  effectStyles: StyleSummary[];
}

function themeModes(system: DesignSystem, pattern: RegExp) {
  return Object.fromEntries(
    Object.values(system.collections).map((c) => {
      const match = c.modes.find((m) => pattern.test(m.name + " " + m.id));
      return [c.id, match?.id ?? system.activeModes[c.id] ?? c.defaultModeId];
    }),
  );
}

export function extractLibraryTokensSummary(
  library: ComponentLibrary,
): LibraryTokensSummary {
  const summary: LibraryTokensSummary = {
    colors: [],
    radii: [],
    spacing: [],
    textStyles: [],
    effectStyles: [],
  };
  const system = library.designSystem;
  if (!system) return summary;
  const light = themeModes(system, /light|浅色|明亮|日间|白天/i);
  const dark = themeModes(system, /dark|深色|暗色|夜间|黑夜/i);
  for (const v of Object.values(system.variables)) {
    const { id, name } = v;
    if (v.type === "color") {
      summary.colors.push({
        id,
        name,
        light: String(resolveVariable(system, id, light)),
        dark: String(resolveVariable(system, id, dark)),
      });
    } else if (v.type === "number") {
      const label = [id, name, ...v.scopes].join(" ");
      const radius = /radi(us|i)|corner|圆角/i.test(label);
      const spacing = /spac(e|ing)|padding|inset|gap|margin|间距|边距/i.test(
        label,
      );
      if (!radius && !spacing) continue;
      const collection = system.collections[v.collectionId];
      const token = {
        id,
        name,
        value: Number(resolveVariable(system, id, system.activeModes)),
        valuesByMode: Object.fromEntries(
          collection.modes.map((m) => [
            m.id,
            Number(
              resolveVariable(system, id, {
                ...system.activeModes,
                [collection.id]: m.id,
              }),
            ),
          ]),
        ),
      };
      if (radius) summary.radii.push(token);
      if (spacing) summary.spacing.push(token);
    }
  }
  for (const s of Object.values(system.styles)) {
    if (s.kind !== "text" && s.kind !== "effect") continue;
    const properties = structuredClone(s.properties);
    for (const [key, id] of Object.entries(s.bindings)) {
      Object.assign(properties, {
        [key]: resolveVariable(system, id, system.activeModes),
      });
    }
    const list = s.kind === "text" ? summary.textStyles : summary.effectStyles;
    list.push({ id: s.id, name: s.name, properties });
  }
  return summary;
}

function libraryPlatform(library: ComponentLibrary) {
  if (library.aiGuide?.platform !== undefined) return library.aiGuide.platform;
  const text = [library.name, library.description].join(" ");
  if (/android|material design|安卓/i.test(text)) return "Android";
  if (/\biOS\b|iPadOS|Forma Mobile/i.test(text)) return "iOS / iPadOS";
  if (/中后台|ant design/i.test(text)) return "Web 中后台";
  if (/移动|手机|mobile|\bH5\b/i.test(text)) return "移动端";
  if (/web|shadcn|saas/i.test(text)) return "Web";
  return "未指定";
}

export function buildLibraryManifest(
  library: ComponentLibrary,
): LibraryManifest {
  const components = library.components.map((c) =>
    extractComponentManifest(library, c),
  );
  const tierCounts = { page: 0, block: 0, component: 0 };
  for (const c of components) tierCounts[c.assetTier]++;
  return {
    libraryId: library.id,
    libraryName: library.name,
    revision: library.revision,
    description: library.description,
    platform: libraryPlatform(library),
    tierCounts,
    categories: [...new Set(components.map((c) => c.category))],
    components,
    exceptionComponents: components.filter((c) => c.isException),
    tokensSummary: extractLibraryTokensSummary(library),
  };
}

function notesRange(markdown: string) {
  const marker = markdown.indexOf(CUSTOM_NOTES_START);
  if (marker < 0) return;
  const start = marker + CUSTOM_NOTES_START.length;
  const end = markdown.indexOf(CUSTOM_NOTES_END, start);
  if (end >= 0) return { start, end };
}

export function extractCustomNotes(markdown = ""): string {
  const range = notesRange(markdown);
  return range ? markdown.slice(range.start, range.end) : "";
}

export function mergeCustomNotes(
  generatedMarkdown: string,
  existingMarkdown = "",
): string {
  const target = notesRange(generatedMarkdown);
  const source = notesRange(existingMarkdown);
  const notes = source
    ? existingMarkdown.slice(source.start, source.end)
    : undefined;
  if (!target)
    return (
      generatedMarkdown +
      "\n\n" +
      CUSTOM_NOTES_START +
      (notes ?? "\n\n") +
      CUSTOM_NOTES_END
    );
  if (notes === undefined) return generatedMarkdown;
  return (
    generatedMarkdown.slice(0, target.start) +
    notes +
    generatedMarkdown.slice(target.end)
  );
}

function mergeRules(authored: string[] = [], defaults: string[]): string[] {
  const rules = new Map<string, string>();
  for (const rule of [...authored, ...defaults]) {
    const key = rule.trim().replace(/\s+/g, " ");
    if (!rules.has(key)) rules.set(key, rule);
  }
  return [...rules.values()].slice(0, 20);
}

// Imported labels can contain table delimiters, newlines, or even a notes marker.
function label(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replace(/[\r\n]+/g, " ");
}
function code(value: string) {
  // CommonMark code spans preserve entities literally. Keep ordinary IDs verbatim,
  // and use reversible JSON escapes for delimiters that would break the document.
  const content = /[\r\n|]|<!-- forma:custom-notes:/.test(value)
    ? JSON.stringify(value)
        .replaceAll("|", "\\u007c")
        .replaceAll("<", "\\u003c")
    : value;
  const ticks = "`".repeat(
    Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length)) + 1,
  );
  const pad =
    content.startsWith("`") ||
    content.endsWith("`") ||
    (content.startsWith(" ") && content.endsWith(" ") && content.trim())
      ? " "
      : "";
  return ticks + pad + content + pad + ticks;
}

function assetRow(c: ComponentManifest) {
  const slots = [
    ...c.textSlots.map(
      (s) => `文案 ${code(s.templateKey)} ≤${s.recommendedMaxChars} 字`,
    ),
    ...c.imageSlots.map(
      (s) => `图像 ${code(s.templateKey)} ${s.width}×${s.height}`,
    ),
    ...c.swapSlots.map(
      (s) => `替换 ${code(s.exposedId)} → ${code(s.targetTemplateKey)}`,
    ),
  ];
  const hints = c.aiHints;
  return [
    `- ${label(c.name)} ${code(c.componentId)}（${label(c.category)}，${c.rootSize.width}×${c.rootSize.height}）`,
    "默认变体 " + code(c.defaultVariantId),
    ...slots,
    hints?.whenToUse && "适用 " + label(hints.whenToUse),
    hints?.avoidWhen && "避免 " + label(hints.avoidWhen),
    hints?.slotsNote && label(hints.slotsNote),
  ]
    .filter(Boolean)
    .join(" · ");
}

function tokenRows(tokens: LibraryTokensSummary) {
  const numeric = (tokens: NumericToken[]) =>
    tokens
      .map((t) => label(t.name) + " " + code(t.id) + " " + t.value + "px")
      .join("、");
  const styles = (styles: StyleSummary[]) =>
    styles
      .map((s) => label(s.name) + " " + code(JSON.stringify(s.properties)))
      .join("、");
  return [
    "- 品牌与语义色（浅色 / 深色）",
    ...tokens.colors.map(
      (c) => `  - ${label(c.name)} ${code(c.id)} ${c.light} / ${c.dark}`,
    ),
    ...(!tokens.colors.length ? ["  - 库内未定义色彩变量"] : []),
    "- 圆角 · " + (numeric(tokens.radii) || "库内未定义"),
    "- 间距 · " + (numeric(tokens.spacing) || "库内未定义"),
    "- 文字层级 · " + (styles(tokens.textStyles) || "库内未定义文字样式"),
    "- 效果 · " + (styles(tokens.effectStyles) || "库内未定义效果样式"),
  ];
}

type Section = { heading: string; rows: string[]; indexRows?: () => string[] };

// Reserve the verbatim notes and all headings before allocating space to long catalogues.
// The manifest is unabridged even for a 4096-component library.
function renderPlaybook(sections: Section[], existingMarkdown?: string) {
  const notes = mergeCustomNotes(
    CUSTOM_NOTES_START + "\n\n" + CUSTOM_NOTES_END,
    existingMarkdown,
  );
  const max = 64_000;
  const render = (groups: Section[]) =>
    [
      ...groups.map((s) => s.heading + "\n\n" + s.rows.join("\n")),
      "## 团队自定义备注\n\n" + notes,
    ].join("\n\n");
  const full = render(sections);
  if (full.length <= max) return full;
  const notice = "（详见 Manifest 中的完整条目）";
  const emptySize = render(sections.map((s) => ({ ...s, rows: [] }))).length;
  if (emptySize > max) return notes;
  let remaining = max - emptySize;
  const budgets = new Map<Section, number>();
  // Small sections get their full allocation first. Large sections share the remainder.
  const bySize = sections
    .map((section) => ({ section, length: section.rows.join("\n").length }))
    .sort((a, b) => a.length - b.length);
  for (const [i, { section, length }] of bySize.entries()) {
    const share = Math.min(length, Math.floor(remaining / (bySize.length - i)));
    budgets.set(section, share);
    remaining -= share;
  }
  return render(
    sections.map((s) => {
      let budget = budgets.get(s)!;
      if (s.rows.join("\n").length <= budget) return s;
      const rows: string[] = [];
      if (budget >= notice.length) {
        budget -= notice.length;
        for (const row of s.indexRows?.() ?? s.rows) {
          if (row.length + 1 > budget) break;
          rows.push(row);
          budget -= row.length + 1;
        }
        rows.push(notice);
      }
      return { ...s, rows };
    }),
  );
}

export function generateLibraryPlaybook(
  library: ComponentLibrary,
  existingGuide?: LibraryAiGuide,
): GeneratedLibraryPlaybook {
  const previous = { ...library.aiGuide, ...existingGuide };
  const manifest = buildLibraryManifest(library);
  const platform = previous.platform ?? manifest.platform;
  manifest.platform = platform;
  const { tierCounts, components, exceptionComponents } = manifest;
  const summary = previous.summary ?? library.description.slice(0, 1000);
  const visualPrinciples = mergeRules(previous.visualPrinciples, [
    "颜色按语义角色绑定，随模式切换。",
    "沿用库内字阶、圆角、间距与效果样式。",
  ]);
  const compositionRules = mergeRules(previous.compositionRules, [
    "优先选择 Page 搭建整屏，再用 Block 组织楼层，最后用 Component 填充控件。",
  ]);
  const exceptionPatterns = mergeRules(previous.exceptionPatterns, [
    "主流程遇到无数据、失败或等待时，优先复用对应的反馈组件。",
  ]);
  const bullets = (rules: string[]) => rules.map((rule) => "- " + label(rule));
  const sections: Section[] = [
    {
      heading: "# " + label(library.name) + " · 组件库说明书",
      rows: [
        `库 ${code(library.id)} · 修订 ${library.revision} · 平台 ${label(platform)}`,
        label(summary),
        `${components.length} 个组件，${components.reduce((sum, c) => sum + c.variants.length, 0)} 个变体。Page ${tierCounts.page} / Block ${tierCounts.block} / Component ${tierCounts.component}。`,
      ],
    },
    {
      heading: "## 视觉与 Token 铁律",
      rows: [
        ...bullets(visualPrinciples),
        ...tokenRows(manifest.tokensSummary),
      ],
    },
    {
      heading: "## 三级资产选型指南",
      rows: [
        "槽位按模板键引用。共用槽位列出默认变体尺寸，其他变体特有的槽位仅在对应变体使用。",
      ],
    },
  ];
  for (const tier of Object.keys(tierLabels) as AssetTier[]) {
    const assets = components.filter((c) => c.assetTier === tier);
    sections.push({
      heading: "### " + tierLabels[tier],
      rows: assets.length ? assets.map(assetRow) : ["此层级暂无资产。"],
      indexRows: () => assets.map((c) => "- " + code(c.componentId)),
    });
  }
  sections.push(
    {
      heading: "## 异常与边界态对照表",
      rows: [
        ...bullets(exceptionPatterns),
        "",
        "| 反馈组件 | 精确 ID | 适用场景 |",
        "| --- | --- | --- |",
        ...exceptionComponents.map(
          (c) =>
            `| ${label(c.name)} | ${code(c.componentId)} | ${label(c.aiHints?.whenToUse || c.description || exceptionScenario(c, c.componentId)!)} |`,
        ),
        ...(!exceptionComponents.length ? ["| 暂无 | — | — |"] : []),
      ],
    },
    {
      heading: "## 混合装配调用规则",
      rows: [
        '- 在 `propose_html_design` 中用 `<div data-forma-component="组件ID" data-library="库ID" data-variant="变体ID"></div>` 放置原装实例。用 `data-overrides` 的 `textByTemplateKey` 覆写文案，遵守槽位字数。',
        "- 需要改变业务模块的外框结构时，在 Blueprint 的组件节点使用 `adapt: { detachOuter: true }` 派生，保留内部子组件实例。",
        "- 库内无合适资产时新建模块，将颜色、圆角和间距绑定到库 Token，文字使用库字阶。",
        ...bullets(compositionRules),
      ],
    },
  );
  const noteSource = notesRange(previous.playbookMarkdown ?? "")
    ? previous.playbookMarkdown
    : library.aiGuide?.playbookMarkdown;
  const markdown = renderPlaybook(sections, noteSource);
  return {
    manifest,
    markdown,
    aiGuide: {
      summary,
      platform,
      visualPrinciples,
      compositionRules,
      exceptionPatterns,
      playbookMarkdown: markdown,
      revision: library.revision,
    },
  };
}

export interface LibraryAssetSearchOptions {
  query?: string;
  libraryId?: string;
  category?: string;
  tier?: AssetTier;
  onlyExceptions?: boolean;
  limit?: number;
  offset?: number;
}

const tierAliases: Record<AssetTier, string> = {
  page: "page 页面 页面样板 页面模板 整页 模板 会场 screen template",
  block: "block 业务模块 业务楼层 业务区块 楼层 区块 section",
  component: "component 原子组件 基础组件 原子控件 基础控件 控件 atomic",
};

function relevance(
  library: ComponentLibrary,
  component: LibraryComponent,
  tier: AssetTier,
  terms: string[],
) {
  if (!terms.length) return 0;
  const fields = [
    { weight: 10, values: [component.id, component.name] },
    {
      weight: 6,
      values: [
        component.category,
        ...(component.aiHints?.tags ?? []),
        ...tierAliases[tier].split(" "),
      ],
    },
    {
      weight: 4,
      values: [component.description, component.aiHints?.whenToUse ?? ""],
    },
    {
      weight: 3,
      values: component.variants.flatMap((v) => [
        v.id,
        v.name,
        ...Object.entries(v.properties).flat(),
      ]),
    },
    { weight: 2, values: [library.id, library.name] },
  ].map((f) => ({ ...f, values: f.values.map((s) => s.toLowerCase()) }));
  let score = 0;
  for (const term of terms) {
    let best = 0;
    for (const { weight, values } of fields) {
      if (values.some((s) => s.includes(term)))
        best = Math.max(best, weight + (values.includes(term) ? 2 : 0));
    }
    if (!best) return -1;
    score += best;
  }
  return score;
}

export function searchLibraryAssets(
  doc: DesignDocument,
  options: LibraryAssetSearchOptions = {},
) {
  const terms =
    options.query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const hits = [];
  for (const library of Object.values(doc.libraries ?? {})) {
    if (options.libraryId && options.libraryId !== library.id) continue;
    for (const component of library.components) {
      if (options.category && options.category !== component.category) continue;
      if (options.onlyExceptions && !isExceptionComponent(component)) continue;
      const tier = classifyComponentTier(component, library);
      if (options.tier && tier !== options.tier) continue;
      const score = relevance(library, component, tier, terms);
      if (score >= 0) hits.push({ library, component, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  const offset = Math.max(0, Math.trunc(options.offset ?? 0)) || 0;
  const limit = Math.max(1, Math.trunc(options.limit ?? 10)) || 10;
  const components = hits
    .slice(offset, offset + limit)
    .map(({ library, component }) =>
      extractComponentManifest(library, component),
    );
  const next = offset + components.length;
  return {
    components,
    total: hits.length,
    offset,
    limit,
    nextOffset: next < hits.length ? next : null,
  };
}
