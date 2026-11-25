import type { DesignDocument, DesignNode } from "../domain/document";
import { resolveVariable } from "../domain/design-system";
import { instanceOwner, isLocked, subtreeIds } from "../domain/tree";
import type { ModelCapabilities } from "./capabilities";
import type { AdapterImageAttachment, AdapterJsonSchema } from "./adapters";
import {
  classifyComponentTier,
  isExceptionComponent,
} from "./library-intelligence";

import {
  withFormaSkillAdaptation,
  type SkillCatalogEntry,
  type ActivatedSkillPayload,
} from "./skills";

export interface AgentMention {
  kind: "component" | "variable" | "style" | "node";
  id: string;
  label: string;
}

export interface ChatHistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface DesignMemoryScope {
  projectId?: string;
  libraryId?: string;
  userId?: string;
}

export interface ScopeScreenPlan {
  refId: string;
  name: string;
  role: "primary" | "overlay" | "exception" | "detail";
  parentRef?: string;
  width: number;
  height: number;
  summary: string;
  reusedComponents?: string[];
  customModules?: string[];
}

export interface ScopeDecisionOption {
  question: string;
  defaultChoice: string;
  alternatives?: string[];
}

export interface ScopeProposal {
  summary: string;
  targetLibraryId?: string;
  targetLibraryName?: string;
  screens: ScopeScreenPlan[];
  reusedAssets: string[];
  customModules: string[];
  decisions?: ScopeDecisionOption[];
}

export interface DesignChatContext {
  prompt: string;
  targetLibraryId?: string | null;
  confirmedScope?: ScopeProposal;
  memoryScope?: DesignMemoryScope;
  generationMode?: "auto" | "html" | "blueprint";
  document: DesignDocument;
  selection: string | null;
  selectionCount?: number;
  history?: ChatHistoryTurn[];
  mentions?: AgentMention[];
  activeSkills?: string[];
  attachments?: AdapterImageAttachment[];
  viewportCenter?: { x: number; y: number };
}

export interface ArtboardPlacement {
  x: number;
  y: number;
  gap: number;
}

export const ARTBOARD_GAP = 80;

export function computeArtboardPlacement(
  doc: DesignDocument,
  viewportCenter?: { x: number; y: number },
  preferredSize: { width: number; height: number } = {
    width: 390,
    height: 844,
  },
): ArtboardPlacement {
  const roots = doc.nodes.filter((n) => n.parentId === null);
  if (roots.length === 0) {
    if (viewportCenter) {
      return {
        x: Math.round(viewportCenter.x - preferredSize.width / 2),
        y: Math.round(viewportCenter.y - preferredSize.height / 2),
        gap: ARTBOARD_GAP,
      };
    }
    return { x: 80, y: 80, gap: ARTBOARD_GAP };
  }

  let maxRight = -Infinity;
  let minY = Infinity;
  for (const root of roots) {
    const right = root.style.x + root.style.width;
    if (right > maxRight) maxRight = right;
    if (root.style.y < minY) minY = root.style.y;
  }

  if (viewportCenter) {
    const candX = Math.round(viewportCenter.x - preferredSize.width / 2);
    const candY = Math.round(viewportCenter.y - preferredSize.height / 2);
    const margin = 40;
    const overlaps = roots.some((root) => {
      const rx1 = root.style.x - margin;
      const ry1 = root.style.y - margin;
      const rx2 = root.style.x + root.style.width + margin;
      const ry2 = root.style.y + root.style.height + margin;
      const cx2 = candX + preferredSize.width;
      const cy2 = candY + preferredSize.height;
      return candX < rx2 && cx2 > rx1 && candY < ry2 && cy2 > ry1;
    });
    if (!overlaps) {
      return { x: candX, y: candY, gap: ARTBOARD_GAP };
    }
  }

  return {
    x: Math.round(maxRight + ARTBOARD_GAP),
    y: Math.round(minY),
    gap: ARTBOARD_GAP,
  };
}

function summarizeNode(node: DesignNode) {
  const s = node.style;
  const compactStyle: Record<string, unknown> = {
    x: s.x,
    y: s.y,
    width: s.width,
    height: s.height,
    layout: s.layout,
    fill: s.fill,
    color: s.color,
    radius: s.radius,
    fontSize: s.fontSize,
    padding: s.padding,
    gap: s.gap,
  };
  if (s.widthMode) compactStyle.widthMode = s.widthMode;
  if (s.heightMode) compactStyle.heightMode = s.heightMode;
  if (s.fontWeight) compactStyle.fontWeight = s.fontWeight;
  if (s.lineHeight) compactStyle.lineHeight = s.lineHeight;
  if (s.textAlign) compactStyle.textAlign = s.textAlign;
  if (s.alignX) compactStyle.alignX = s.alignX;
  if (s.alignY) compactStyle.alignY = s.alignY;
  if (s.justifyContent) compactStyle.justifyContent = s.justifyContent;
  if (s.stroke) compactStyle.stroke = s.stroke;
  if (s.strokeWidth) compactStyle.strokeWidth = s.strokeWidth;
  if (s.opacity !== undefined) compactStyle.opacity = s.opacity;
  if (s.fillOpacity !== undefined) compactStyle.fillOpacity = s.fillOpacity;
  if (s.columns) compactStyle.columns = s.columns;

  return {
    id: node.id,
    parentId: node.parentId,
    type: node.type,
    name: node.name,
    ...(node.text ? { text: node.text.slice(0, 300) } : {}),
    ...(node.hidden ? { hidden: true } : {}),
    ...(node.locked ? { locked: true } : {}),
    ...(node.fillToken ? { fillToken: node.fillToken } : {}),
    ...(node.variableBindings
      ? { variableBindings: node.variableBindings }
      : {}),
    ...(node.styleBindings ? { styleBindings: node.styleBindings } : {}),
    ...(node.instance ? { instance: node.instance } : {}),
    ...(node.interaction ? { interaction: node.interaction } : {}),
    ...(node.control ? { control: node.control } : {}),
    style: compactStyle,
  };
}

export function buildDesignContextPayload(
  ctx: DesignChatContext,
  capabilities: ModelCapabilities,
) {
  const doc = ctx.document;
  const placement = computeArtboardPlacement(doc, ctx.viewportCenter);
  const nodeBudget =
    capabilities.maxContextTokens >= 200_000
      ? 600
      : capabilities.maxContextTokens >= 64_000
        ? 300
        : 140;

  const topLevelNodes = doc.nodes.filter((n) => n.parentId === null);
  const childCountByParent = new Map<string, number>();
  for (const n of doc.nodes) {
    if (n.parentId) {
      childCountByParent.set(
        n.parentId,
        (childCountByParent.get(n.parentId) ?? 0) + 1,
      );
    }
  }

  const existingArtboards = topLevelNodes.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    x: n.style.x,
    y: n.style.y,
    width: n.style.width,
    height: n.style.height,
    directChildren: childCountByParent.get(n.id) ?? 0,
  }));

  const mentionNodeIds = new Set<string>();
  for (const m of ctx.mentions ?? []) {
    if (m.kind === "node" && doc.nodes.some((n) => n.id === m.id)) {
      for (const sid of subtreeIds(doc, [m.id])) {
        mentionNodeIds.add(sid);
      }
    }
  }

  let selectedInfo: Record<string, unknown> | null = null;
  let scopedNodes: DesignNode[];

  if (ctx.selection) {
    const selectedNode = doc.nodes.find((n) => n.id === ctx.selection);
    const allowed = subtreeIds(doc, [ctx.selection]);
    scopedNodes = doc.nodes
      .filter((n) => allowed.has(n.id))
      .slice(0, nodeBudget);
    if (selectedNode) {
      selectedInfo = {
        id: selectedNode.id,
        name: selectedNode.name,
        type: selectedNode.type,
        locked: isLocked(doc, selectedNode.id),
        insideProtectedInstance: Boolean(instanceOwner(doc, selectedNode.id)),
        nodeCountInSubtree: allowed.size,
      };
    }
  } else {
    const priorityNodes = doc.nodes.filter((n) => mentionNodeIds.has(n.id));
    const remaining = doc.nodes.filter((n) => !mentionNodeIds.has(n.id));
    scopedNodes = [...priorityNodes, ...remaining].slice(0, nodeBudget);
  }

  const ds = doc.designSystem;
  const designSystemSummary = ds
    ? {
        collections: Object.values(ds.collections).map((c) => ({
          id: c.id,
          name: c.name,
          activeModeId: ds.activeModes[c.id] ?? c.defaultModeId,
          modes: c.modes,
        })),
        variables: Object.values(ds.variables)
          .slice(0, 120)
          .map((v) => {
            let resolved: string | number | boolean | undefined;
            try {
              resolved = resolveVariable(ds, v.id, ds.activeModes);
            } catch {
              resolved = undefined;
            }
            return {
              id: v.id,
              name: v.name,
              type: v.type,
              scopes: v.scopes,
              value: resolved,
            };
          }),
        styles: Object.values(ds.styles)
          .slice(0, 80)
          .map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            properties: s.properties,
          })),
      }
    : null;

  const componentCatalog = Object.values(doc.libraries ?? {}).map((lib) => ({
    libraryId: lib.id,
    libraryName: lib.name,
    revision: lib.revision,
    componentCount: lib.components.length,
    components: lib.components.slice(0, 80).map((comp) => ({
      componentId: comp.id,
      name: comp.name,
      category: comp.category,
      assetTier: classifyComponentTier(comp, lib),
      isException: isExceptionComponent(comp),
      variants: comp.variants.slice(0, 12).map((v) => {
        const root = v.nodes.find((n) => !n.parentId);
        return {
          variantId: v.id,
          properties: v.properties,
          width: root?.style.width,
          height: root?.style.height,
        };
      }),
    })),
  }));

  const resolvedMentions = (ctx.mentions ?? []).map((mention) => {
    if (mention.kind === "variable") {
      const v = ds?.variables[mention.id];
      const legacy = doc.tokens[mention.id];
      return {
        ...mention,
        resolved: v
          ? {
              kind: "designSystemVariable",
              id: v.id,
              name: v.name,
              type: v.type,
              scopes: v.scopes,
            }
          : legacy
            ? { kind: "legacyToken", id: mention.id, ...legacy }
            : null,
      };
    }
    if (mention.kind === "style") {
      const s = ds?.styles[mention.id];
      return {
        ...mention,
        resolved: s
          ? { id: s.id, name: s.name, kind: s.kind, properties: s.properties }
          : null,
      };
    }
    if (mention.kind === "component") {
      for (const lib of Object.values(doc.libraries ?? {})) {
        const comp = lib.components.find(
          (c) =>
            c.id === mention.id ||
            `${lib.id}/${c.id}` === mention.id ||
            `${lib.id}:${c.id}` === mention.id,
        );
        if (comp) {
          return {
            ...mention,
            resolved: {
              libraryId: lib.id,
              componentId: comp.id,
              name: comp.name,
              variants: comp.variants.map((v) => ({
                variantId: v.id,
                properties: v.properties,
              })),
            },
          };
        }
      }
      return { ...mention, resolved: null };
    }
    const targetNode = doc.nodes.find((n) => n.id === mention.id);
    return {
      ...mention,
      resolved: targetNode ? summarizeNode(targetNode) : null,
    };
  });

  return {
    documentMeta: {
      id: doc.id,
      name: doc.name,
      revision: doc.revision,
      activePage: doc.activePage ?? null,
      pages: doc.pages?.map(({ id, name }) => ({ id, name })) ?? [],
      totalNodes: doc.nodes.length,
    },
    placement: {
      nextX: placement.x,
      nextY: placement.y,
      artboardGap: placement.gap,
    },
    selection: selectedInfo,
    existingArtboards,
    nodes: scopedNodes.map(summarizeNode),
    tokens: doc.tokens,
    designSystem: designSystemSummary,
    componentCatalog,
    targetLibraryId: ctx.targetLibraryId ?? null,
    confirmedScope: ctx.confirmedScope ?? null,
    memoryScope: ctx.memoryScope ?? null,
    resolvedMentions,
    images: Object.fromEntries(
      Object.entries(doc.images ?? {}).map(([id, { name, width, height }]) => [
        id,
        { name, width, height },
      ]),
    ),
  };
}

export const BLUEPRINT_RESPONSE_JSON_SCHEMA: AdapterJsonSchema = {
  name: "forma_design_response",
  description:
    "Structured Forma UI design blueprint, scoped edit list, or design answer.",
  schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["generate", "edit", "answer"],
        description:
          "Use 'generate' when creating new artboards/screens, 'edit' when modifying existing layers or selected subtree, 'answer' when the user only asks a question without canvas edits.",
      },
      reply: {
        type: "string",
        description:
          "Concise, helpful designer-facing explanation in the user's language.",
      },
      summary: {
        type: "string",
        description:
          "Short one-line summary of the canvas changes for the Live Preview HUD.",
      },
      artboards: {
        type: "array",
        description:
          "Top-level artboards/frames to generate (only when selection is null, or when creating inside an editable selected container).",
        items: { type: "object" },
      },
      edits: {
        type: "array",
        description:
          "Targeted edits on existing layers (update, create, remove, insertComponent, bindVariable, applyStyle, setInstanceSlot, setVariableMode, detachInstance, switchInstance, swapInstance, move, reorder, putToken).",
        items: { type: "object" },
      },
    },
    required: ["mode", "reply"],
  },
};

function skillPrompt(
  enabled: SkillCatalogEntry[],
  preloaded: ActivatedSkillPayload[],
) {
  const entries = enabled
    .map((s) =>
      ("- " + s.name + " — " + s.description)
        .replace(/\s+/g, " ")
        .slice(0, 220),
    )
    .join("\n")
    .slice(0, 4000);
  return [
    entries && "## Available Skills\n" + entries,
    ...preloaded
      .map(withFormaSkillAdaptation)
      .map(
        (s) =>
          "## Selected Skill: " +
          s.name +
          "\n" +
          s.instructions +
          "\nResources: " +
          (s.resources.join(", ") || "(none)") +
          "\nForma canvas guidance: " +
          s.formaAdaptationNote,
      ),
  ]
    .filter(Boolean)
    .join("\n");
}

function libraryAndScopePrompt(
  ctx: DesignChatContext,
  htmlFirst: boolean,
  enableScopePlan: boolean,
) {
  const target = ctx.targetLibraryId ?? ctx.confirmedScope?.targetLibraryId;
  const libraries = Object.values(ctx.document.libraries ?? {});
  const selected = target
    ? libraries.filter((lib) => lib.id === target)
    : libraries;
  const summaries = selected.map((lib) => {
    const counts = { page: 0, block: 0, component: 0 };
    let exceptions = 0;
    for (const component of lib.components) {
      counts[classifyComponentTier(component, lib)]++;
      if (isExceptionComponent(component)) exceptions++;
    }
    return `${lib.name} (${lib.id}) · Page ${counts.page} / Block ${counts.block} / Component ${counts.component} · 异常态 ${exceptions} · AI 说明书${lib.aiGuide ? "已有" : "未保存"}`;
  });
  return [
    summaries.length && "目标组件库（L1）\n" + summaries.join("\n"),
    target &&
      !selected.length &&
      `文档尚未安装目标库 ${target}，只使用文档内可查证的组件。`,
    selected.length &&
      (htmlFirst
        ? '先调用 get_library_playbook 与 search_components（传入目标 libraryId），按 tier ("page" | "block" | "component") 和 onlyExceptions 查询精确 ID、变体和槽位，再开始设计。启用 HTML 工具时优先在 propose_html_design 中用 <div data-forma-component="<componentId>" data-library="<libraryId>" data-variant="<variantId>" data-overrides=\'{"textByTemplateKey":{}}\'></div> 原地嵌入受保护实例；Blueprint 用 type: "component" 实例。需要拆改业务楼层外框时先用 inspect_component_structure 查内部结构，再用 propose_design_changes 的组件节点 adapt: { detachOuter: true, removeChildren, appendChildren } 派生，保留内部原子组件实例。'
        : "工具模式先用 get_library_playbook 与 search_components 读规范和槽位。本轮仅返回 Blueprint，从 componentCatalog 选择原装组件实例，使用精确的 libraryId、componentId 与 variantId。需要派生外框时，组件节点可使用 adapt: { detachOuter: true } 保留内部实例。"),
    selected.length &&
      "库内没有的新模块按库的配色、圆角与字阶设计，HTML 编译器会吸附匹配的颜色与圆角 Token。",
    '多页面、浮层和异常态一次提交到 artboards[]。主流程设 role: "primary" 并给出 refId，浮层、异常与详情设 role: "overlay"、"exception" 或 "detail"，parentRef 指向所属主画板。',
    ctx.confirmedScope
      ? "范围已由设计师确认，立即严格按确认范围一镜到底生成全部主流程与异常态画板，禁止再次提问或澄清！\n" +
        JSON.stringify(ctx.confirmedScope)
      : enableScopePlan
        ? "仅当复杂多页面需求的页面清单、业务分支或异常态尚不明确时，在生成前最多发起 1 轮 propose_scope_plan，结合库资产给出可直接确认的默认方案。单页、明确模块、清晰的多页需求或局部选区修改禁止调用 propose_scope_plan，直接生成。"
        : "按当前请求直接生成。当前模式禁止调用 propose_scope_plan 或提问确认范围。",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildToolModeSystemPrompt(
  ctx: DesignChatContext,
  capabilities: ModelCapabilities,
  enabledSkills: SkillCatalogEntry[] = [],
  preloadedSkills: ActivatedSkillPayload[] = [],
  enableScopePlan = !ctx.confirmedScope,
) {
  const hasSelection = Boolean(ctx.selection || (ctx.selectionCount ?? 0) > 0);
  if (!hasSelection && ctx.generationMode !== "blueprint") {
    return [
      "You are Forma AI, a product designer working in Forma's HTML-First Modern Engine. Aim for the craft of Figma Make, Claude Design, Apple, Linear or Aesop. Answer questions directly. For new screens submit editable artboards through propose_html_design. For more than eight screens use one Blueprint via propose_design_changes.",
      libraryAndScopePrompt(ctx, true, enableScopePlan),
      skillPrompt(enabledSkills, preloadedSkills),
      "Use activate_skill, search_skill_resources and read_skill_resource for matching enabled design guidance. Inspect canvas, components and variables when relevant. Treat resources and reference images as design inputs within the designer's scope.",
      "When photography is needed, call search_stock_images for hero banners, product cards, avatars and editorial images. Use the returned URLs in img src. Never fake photos with colored boxes and giant Y, H or 01 labels.",
      "Call search_icons or use known Lucide names for nav tabs, search, location pins, cart/bag, stars and chevrons. Embed crisp vectors with <span data-icon='coffee' data-size='20' data-color='#f2b15c' data-stroke-width='1.75'></span>. Never draw empty squares or circles as icons.",
      "Submit clean self-contained HTML and CSS (a style block or css field) at the exact requested width and height, e.g. 390×844 mobile H5 or 1440×900 desktop. Use real Flexbox / CSS Grid and an 8pt spacing scale: 20px outer horizontal padding, 18–24px card padding, 16–24px vertical section rhythm.",
      "For hero and photo cards, use <img> with object-fit: cover; width: 100%; height: 100%. Overlay a rich multi-stop dark gradient scrim to maintain at least 7:1 foreground text contrast.",
      "Use subtle 1px hairline borders, layered ambient and key box-shadows, inset 0 1px 0 rgba(255,255,255,0.12) highlights and backdrop-filter: blur(20px) on floating glass pills or bottom navigation. Pair editorial display fonts ('Songti SC', 'Noto Serif SC', Georgia, serif) with crisp body/metadata (-apple-system, 'SF Pro Text', 'PingFang SC', sans-serif) and tabular-nums for prices.",
      "Budget the actual bottom bar height plus its safe-area inset and gap on a docked 390×844 layout. Reserve that clearance in the content area so no card collides with or peeks behind the bar. Fit all content without cramped, clipped or edge-touching text. After a successful proposal summarize concisely in Chinese.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return designPrompt(
    ctx,
    capabilities,
    enabledSkills,
    preloadedSkills,
    true,
    enableScopePlan && !hasSelection,
  );
}

export function buildDesignSystemPrompt(
  ctx: DesignChatContext,
  capabilities: ModelCapabilities,
  enabledSkills: SkillCatalogEntry[] = [],
  preloadedSkills: ActivatedSkillPayload[] = [],
) {
  return designPrompt(ctx, capabilities, enabledSkills, preloadedSkills, false);
}

function designPrompt(
  ctx: DesignChatContext,
  capabilities: ModelCapabilities,
  enabledSkills: SkillCatalogEntry[],
  preloadedSkills: ActivatedSkillPayload[],
  toolMode: boolean,
  enableScopePlan = false,
): string {
  const selectionRule = ctx.selection
    ? [
        `CRITICAL SELECTION SCOPE: The user currently has node "${ctx.selection}" selected.`,
        `You MUST ONLY modify node "${ctx.selection}" or its descendants, or create new child nodes inside "${ctx.selection}".`,
        `NEVER modify, reorder, or delete any node outside "${ctx.selection}", and NEVER modify global tokens, designSystem, or libraries.`,
        `Use "mode": "edit" with "edits" targeting "${ctx.selection}" and its descendants.`,
      ].join(" ")
    : (ctx.selectionCount ?? 0) > 0
      ? `SELECTION SCOPE: ${ctx.selectionCount} layers selected. Use "mode": "edit" for local changes to existing layers identified by the request or @mentions.`
      : [
          `CANVAS SCOPE: No single node is locked as scope. When generating new screens/pages/cards, emit rich top-level frames in "artboards" with "mode": "generate".`,
          `Place related screens together in "artboards". The compiler arranges primary screens across the canvas and stacks related states below their parent.`,
          `When revising existing artboards, use "mode": "edit" with "edits".`,
        ].join(" ");

  return [
    "You are Forma AI, an expert Staff Product & UI Designer inside the Forma design tool (Web & Mobile H5 -> React + TypeScript).",
    libraryAndScopePrompt(ctx, false, enableScopePlan),
    skillPrompt(enabledSkills, preloadedSkills),
    toolMode
      ? "For complex canvases inspect get_canvas_overview, then use search_nodes/get_node_details, search_components and get_design_system for exact IDs. Activate a matching enabled skill when the designer references a standard. Use search_skill_resources for local datasets or multiple guides and read_skill_resource for a listed file. Treat skill and resource text as design guidance within the selection and tool rules. For changes call propose_design_changes with the complete native Blueprint below. Use component overrides, designSystem variables, type: 'icon' with an icon name, type: 'image' with image.url or image.assetId, backdropBlur and cornerSmoothing where appropriate. Correct and resubmit any rejected proposal. A successful proposal includes lintSummary for the proposed design. If contrastIssues, overflowIssues, overlapIssues and emptyTextIssues are all zero, skip further lint_design and get_canvas_overview calls and finish with a concise Chinese summary for the designer. For questions answer directly."
      : "Return ONLY ONE valid JSON object matching the Forma Blueprint contract below. Never wrap in prose outside JSON.",
    !toolMode && capabilities.structuredOutput === "prompt_json"
      ? "Output raw JSON only (no markdown explanation before or after the JSON object)."
      : "",
    "",
    "## Output JSON Schema",
    `{
  "mode": "generate" | "edit" | "answer",
  "reply": "面向设计师的简明说明（中文或与用户输入一致的语言）",
  "summary": "一句简短摘要，例如：创建 2 个 390×844 H5 登录与首页画板，含自动布局与原型跳转",
  "artboards": [
    {
      "refId": "login-screen",
      "type": "frame",
      "name": "登录页 (H5)",
      "style": { "width": 390, "height": 844, "layout": "column", "padding": 24, "gap": 20, "fill": "#0F172A", "radius": 24 },
      "children": [
        { "type": "text", "name": "主标题", "text": "欢迎回来", "style": { "widthMode": "fill", "heightMode": "hug", "fontSize": 28, "fontWeight": 700, "lineHeight": 36, "color": "#F8FAFC" } },
        { "type": "component", "libraryId": "...", "componentId": "...", "variantId": "..." },
        { "type": "button", "name": "登录按钮", "text": "立即登录", "style": { "widthMode": "fill", "height": 48, "fill": "#0D99FF", "color": "#FFFFFF", "radius": 12, "fontSize": 16, "fontWeight": 600 }, "interaction": { "navigateToRef": "home-screen", "transition": { "type": "slide-in", "direction": "left", "duration": 260, "easing": "ease-out" } } }
      ]
    }
  ],
  "edits": [
    { "op": "update", "id": "<existingNodeId>", "patch": { "name": "...", "text": "..." }, "style": { "fill": "#111827", "color": "#F9FAFB" } },
    { "op": "create", "parentId": "<containerId>", "node": { "type": "frame", "name": "...", "style": { ... }, "children": [...] } },
    { "op": "insertComponent", "parentId": "<containerId>", "libraryId": "...", "componentId": "...", "variantId": "...", "position": { "x": 0, "y": 0 } },
    { "op": "bindVariable", "id": "<existingNodeId>", "property": "fill", "variableId": "<varId>" },
    { "op": "applyStyle", "id": "<existingNodeId>", "styleId": "<styleId>" },
    { "op": "remove", "id": "<existingNodeId>" }
  ]
}`,
    "",
    "## Scope & Safety Rules",
    selectionRule,
    "- For a component node or insertComponent edit, supply variantId or variantProperties, and overrides: {text, textByTemplateKey, fill, color, opacity, slots: { [exposedPropertyId]: {libraryId, componentId, variantId} }}. Use applyStyle.slot (paint|stroke|text|grid|effect), setInstanceSlot {id,property,value}, setVariableMode {id,collectionId,modeId}, or detachInstance {id} only on an explicit detach request.",
    "- Style also supports fontFamily, fontStyle, textDecoration, textTransform, verticalAlign, strokeAlign, strokeStyle, strokeDash, strokeSides, paints, strokePaints, gridTracks, gridRowTracks and layoutBreakpoints.",
    "- Protected component instances: inside an existing instance you may ONLY update text or appearance (fill/color/opacity); NEVER remove, move, reorder, or alter geometry of internal layers.",
    "- Supported node types: frame, group, rectangle, ellipse, text, button, vector, icon, image, component (for library instances).",
    "- Supported style properties: width, height, minWidth, maxWidth, minHeight, maxHeight, widthMode (fixed|hug|fill), heightMode (fixed|hug|fill), x, y, fill (#RRGGBB), color (#RRGGBB), radius, corners ({tl,tr,br,bl}), fontSize, fontWeight (100-900), lineHeight (in px, e.g. 24), letterSpacing, textAlign (left|center|right), padding, insets ({top,right,bottom,left}), gap, rowGap, layout (free|row|column|grid), columns, columnSpan, wrap, justifyContent (pack|space-between), alignX (start|center|end), alignY (start|center|end), stroke (#RRGGBB), strokeWidth, opacity (0-1), fillOpacity (0-1), colorOpacity (0-1), strokeOpacity (0-1), clipContent, blur, backdropBlur, shadows ([{x,y,blur,spread,color,opacity,inset}]), gradient ({type:'linear'|'radial', angle, stops:[{offset,color,opacity}]}).",
    "- Interactive controls: a frame/rectangle/button may include `control`: `{ kind: 'textfield' | 'switch' | 'checkbox' | 'slider' | 'segmented' | 'progress', label, value, options? }` for real interactive preview & React export.",
    "- Prototype links: give generated artboards a `refId` and connect clickable buttons/cards with `interaction: { navigateToRef: 'target-ref' }` or `{ overlayRef: 'sheet-ref', position: 'bottom' }` or `{ back: true }`.",
    "",
    "## Visual Design Craft Standards (Deliver Studio-Grade UI!)",
    "- Sizing: On 390×844 mobile/H5 screens budget the total content height, gaps, insets and bottom navigation. For longer content use `style.clipContent: false` and `interaction: { scroll: 'vertical' }`, with room for the bottom bar so it cannot cover or cut off content. Desktop Web/SaaS uses 1280×800 or 1440×900; standalone cards use sensible widths (340-480px).",
    "- Auto Layout first: use `layout: 'column'` / `'row'` / `'grid'` with `widthMode: 'fill'` on full-width children and `heightMode: 'hug'` on text/cards so layouts never overlap or clip!",
    "- Omit fill on transparent layout wrapper frames. In a row, give badges, pills and filter chips widthMode: 'hug', heightMode: 'hug' and compact insets.",
    "- Spacing rhythm: follow an 8px scale (padding 16/20/24/32, gap 8/12/16/20/24). Give generous breathing room.",
    "- Typography hierarchy: strong contrast between Hero/Title (24-32px, weight 700), Section Header (18-20px, weight 600), Body (14-15px, weight 400), Meta/Badge (11-12px, weight 500). Always set `lineHeight` in pixels (~1.35x-1.5x fontSize).",
    "- Color & depth: cohesive modern palette with clear surface layering (page bg -> card surface -> elevated pill/CTA), subtle 1px strokes, soft elevation shadows, crisp WCAG AA text contrast.",
    "- Realistic copy: write authentic domain-specific Chinese (or user-language) labels, metrics, names, and microcopy. NEVER use 'Lorem ipsum' or 'Text 1'.",
    "- Reuse design system & @mentions: prioritize mentioned components, variables, styles and nodes. Bind theme-matching `designSystem.variables` via `variableBindings` even when the designer has not mentioned them. Insert installed `componentCatalog` components via `type: 'component'` when they match the UI need.",
  ]
    .filter(Boolean)
    .join("\n");
}
