import { z } from "zod";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { iconToInlineSvg, searchIcons } from "./icon-library";
import {
  HtmlComponentSlotError,
  validateArtboardRelations,
  resolveHtmlComponentSlot,
  sanitizeDesignHtml,
  type HtmlArtboardSpec,
  type HtmlDesignDraft,
} from "./html-to-forma";
import {
  buildLibraryManifest,
  classifyComponentTier,
  extractComponentManifest,
  generateLibraryPlaybook,
  isExceptionComponent,
} from "./library-intelligence";
import {
  localizeImageUrl,
  MediaAssetRegistry,
  resolveMediaAssetsForHtml,
  searchStockImages,
  type StockImageCandidate,
} from "./media-assets";
import type { DesignDocument, DesignNode } from "../domain/document";
import { findBuiltinEntry } from "../design-system/catalog";
import {
  assetTierSchema,
  type ComponentLibrary,
} from "../domain/library-schema";
import { checkDesigns } from "../domain/design-lint";
import {
  effectiveModes,
  resolveNode,
  resolveVariable,
} from "../domain/design-system";
import {
  propertyType,
  type VariableProperty,
  styleGroups,
} from "../domain/design-properties";
import { layoutBounds, type Rect } from "../domain/geometry";
import { pageList } from "../domain/pages";
import { findLayer, indexPublishedScene } from "../domain/scene-index";
import { instanceOwner, isLocked, subtreeIds } from "../domain/tree";
import { extractJsonPayload, type AdapterToolDefinition } from "./adapters";
import {
  compileBlueprintToTransaction,
  resolveLibraryComponent,
  type CompileBlueprintResult,
  type CompileDiagnostic,
} from "./blueprint-compiler";
import {
  computeArtboardPlacement,
  episodeReference,
  type DesignChatContext,
  type RecalledEpisodePayload,
  type ScopeProposal,
} from "./context-builder";
import { validateProposalSnapshot } from "./provider";

import {
  maxSkillResourcePageChars,
  maxSkillSearchMatches,
  validResourcePath,
  validSkillResourcePrefix,
  withFormaSkillAdaptation,
  type ActivatedSkillPayload,
  type SkillCatalogEntry,
  type SkillRuntimeProvider,
} from "./skills";
export type {
  ActivatedSkillPayload,
  SkillCatalogEntry,
  SkillRuntimeProvider,
} from "./skills";
interface HtmlPreparationStats {
  imagesLocalized?: number;
  iconsHydrated?: number;
  componentSlotsResolved?: number;
}
export type HtmlDesignDraftProposal = Omit<HtmlDesignDraft, "artboards"> &
  HtmlPreparationStats & {
    reply: string;
    summary: string;
    artboards?: (HtmlArtboardSpec & HtmlPreparationStats)[];
  };

type ToolRuntimeOptions = {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  allowNetworkMedia?: boolean;
};

type MediaOptions = NonNullable<
  Parameters<typeof resolveMediaAssetsForHtml>[1]
>;
const maxHtmlImages = 12;

export interface AgentToolTraceItem {
  name: string;
  status: "ok" | "warning" | "error";
  summary: string;
  durationMs: number;
  detail?: string;
}

const id = z.string().min(1).max(256);
const query = z.string().max(500).optional();
const limit = z.number().int().min(1).max(100).optional();
const offset = z.number().int().min(0).optional();
const records = z
  .array(z.record(z.string(), z.unknown()))
  .max(20000)
  .optional();
const role = z.enum(["primary", "overlay", "exception", "detail"]);
const boardSize = {
  name: z.string().min(1).max(120),
  width: z.number().min(120).max(4096),
  height: z.number().min(120).max(12000),
};
const relation = {
  refId: id.optional(),
  role: role.optional(),
  parentRef: id.optional(),
};
const htmlBoardContent = z.object({
  ...boardSize,
  html: z.string().min(20).max(200_000),
  css: z.string().max(100_000).optional(),
});
const singleHtmlBoard = htmlBoardContent.extend(relation);
export const htmlArtboardSchema = singleHtmlBoard.extend({
  html: z.string().min(1).max(200_000),
});
const summary = z.string().min(1).max(400);
const screenList = z.array(z.string().max(120)).max(24).optional();
const screenPlan = z.strictObject({
  ...boardSize,
  refId: id,
  role,
  parentRef: id.optional(),
  summary,
  reusedComponents: screenList,
  customModules: screenList,
});
const reusedAssets = z.array(z.string().max(160)).max(40);
const customModules = z.array(z.string().max(160)).max(24);
export const scopeProposalSchema = z.strictObject({
  summary,
  targetLibraryId: id.optional(),
  targetLibraryName: z.string().min(1).max(200).optional(),
  screens: z.array(screenPlan).min(1).max(12),
  reusedAssets,
  customModules,
  decisions: z
    .array(
      z.strictObject({
        question: z.string().min(1).max(240),
        defaultChoice: z.string().min(1).max(160),
        alternatives: z.array(z.string().max(160)).max(4).optional(),
      }),
    )
    .max(3)
    .optional(),
});
const schemas = {
  search_project_episodes: z.strictObject({
    query: z.string().max(300).optional(),
    libraryId: id.optional(),
    onlyCurrentFile: z.boolean().optional(),
    limit: z.number().int().min(1).max(8).optional(),
  }),
  get_episode_details: z.strictObject({
    episodeId: id,
    promptOffset: z.number().int().min(0).optional(),
    promptLimit: z.number().int().min(100).max(4000).optional(),
    includeSampleTexts: z.boolean().optional(),
  }),
  get_library_playbook: z.strictObject({
    libraryId: id.optional(),
    includeComponents: z.boolean().optional(),
  }),
  inspect_component_structure: z.strictObject({
    componentId: id,
    libraryId: id.optional(),
    variantId: id.optional(),
  }),
  propose_scope_plan: scopeProposalSchema
    .omit({ targetLibraryName: true })
    .extend({
      reply: z.string().min(1),
      screens: z
        .array(screenPlan.extend({ role: role.default("primary") }))
        .min(1)
        .max(12),
      reusedAssets: reusedAssets.default([]),
      customModules: customModules.default([]),
    }),
  search_icons: z.strictObject({
    query: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(60).optional(),
  }),
  search_stock_images: z.strictObject({
    query: z.string().trim().min(1).max(300),
    orientation: z.enum(["landscape", "portrait", "square"]).optional(),
    mood: z.enum(["dark", "warm", "light", "vibrant"]).optional(),
    limit: z.number().int().min(1).max(12).optional(),
  }),
  propose_html_design: singleHtmlBoard
    .partial()
    .extend({
      reply: z.string().min(1),
      summary: z.string().optional(),
      targetLibraryId: id.optional(),
      snapLibraryTokens: z.boolean().optional(),
      artboards: z.array(htmlArtboardSchema).min(1).max(8).optional(),
    })
    .refine(
      (a) =>
        !a.artboards ||
        [
          a.html,
          a.css,
          a.name,
          a.width,
          a.height,
          a.role,
          a.refId,
          a.parentRef,
        ].every((v) => v === undefined),
      "单画板字段与 artboards 不能混传",
    )
    .refine(
      (a) => a.artboards || (a.name && a.width && a.height && a.html),
      "提供完整的 name、width、height、html 或 1 至 8 张 artboards",
    ),
  get_canvas_overview: z.strictObject({}),
  search_nodes: z.strictObject({
    query,
    rootId: id.optional(),
    ids: z.array(id).min(1).max(20).optional(),
    types: z.array(id).max(32).optional(),
    pageId: id.optional(),
    withinSelection: z.boolean().optional(),
    onlyInstances: z.boolean().optional(),
    limit,
    offset,
  }),
  get_node_details: z.strictObject({
    ids: z.array(id).min(1).max(20),
    includeChildren: z.boolean().optional(),
    depth: z.number().int().min(0).max(10).optional(),
    offset,
    limit,
  }),
  search_components: z.strictObject({
    query,
    tier: assetTierSchema.optional(),
    onlyExceptions: z.boolean().optional(),
    libraryId: id.optional(),
    category: id.optional(),
    limit,
    offset,
  }),
  get_design_system: z.strictObject({
    kind: z.enum(["all", "variables", "styles", "collections"]).optional(),
    query,
    scope: id.optional(),
    limit,
    offset,
  }),
  lint_design: z.strictObject({ rootId: id.optional(), limit, offset }),
  propose_design_changes: z.object({
    mode: z.enum(["edit", "generate"]),
    reply: z.string().min(1),
    summary: z.string().optional(),
    artboards: records,
    edits: records,
    operations: records,
  }),
  activate_skill: z.strictObject({ name: id }),
  read_skill_resource: z.strictObject({
    name: id,
    path: z.string().min(1).max(1024),
    offset,
    limit: z.number().int().min(1).max(maxSkillResourcePageChars).optional(),
  }),
  search_skill_resources: z.strictObject({
    name: id,
    query: z.string().trim().min(1).max(500),
    pathPrefix: z.string().min(1).max(1024).optional(),
    limit: z.number().int().min(1).max(maxSkillSearchMatches).optional(),
  }),
};
type ToolName = keyof typeof schemas;
const descriptions: Record<ToolName, string> = {
  search_project_episodes:
    "Search recalled project episodes by keywords, library or current file. Returns untrusted historical summaries and recall reasons for reference.",
  get_episode_details:
    "Read one recalled episode's screen dimensions, exact component and variant IDs and decisions as untrusted reference. Page its prompt with promptOffset and promptLimit (default 1200); set includeSampleTexts to false for a smaller result.",
  get_library_playbook:
    "Read an installed library's playbook, tier counts, tokens and exception patterns. Defaults to the target or first installed library. Set includeComponents to false to omit the structured asset index.",
  inspect_component_structure:
    "Inspect the read-only template hierarchy, exposed properties and slots of one installed component variant before applying overrides or adapting its outer frame.",
  propose_scope_plan:
    "Before designing an ambiguous multi-screen flow, submit one proposed scope with sensible defaults for designer confirmation. For clear requests generate directly.",
  search_icons:
    "Find Lucide vector icons by name or keyword. Use the returned names with data-icon or native Blueprint icons.",
  search_stock_images:
    "Find editorial photography by subject, orientation and mood. Use the returned URL in an img element or Blueprint image.url.",
  propose_html_design:
    "Submit name, width, height and HTML/CSS for one editable artboard, or artboards (1–8 complete boards with refId, role and parentRef) for the entire flow. Embed installed instances using data-forma-component. Include a concise reply.",
  get_canvas_overview:
    "Read pages, artboards, placement, selection protection and library counts.",
  search_nodes:
    "Search layer names, copy, types and component sources across pages or within rootId. Includes the latest proposed layers. Only the active page is editable.",
  get_node_details:
    "Read exact layer properties, bindings, exposed controls and template keys. Optional descendants are returned flat, in depth order.",
  search_components:
    "Find installed components by library, platform, component ID, name, category or variant. Filter by tier and onlyExceptions. Returns exact variants, template slots and AI hints.",
  get_design_system:
    "List installed libraries and categories. Find exact variable IDs and resolved values, reusable styles and collection modes. scope is a property such as fill or radius.",
  lint_design:
    "Inspect a root, the selection or the page for token, contrast, layout and copy issues.",
  propose_design_changes:
    "Submit a complete replacement proposal using artboards/edits or native operations. All edits must pass together. Follow diagnostics and resubmit the whole proposal if ok is false.",
  activate_skill:
    "Load an enabled skill's design guidance, local resource list, compatibility and Forma canvas adaptation note. Use search_skill_resources for CSV/JSON or multi-file datasets.",
  read_skill_resource:
    "Read a listed local resource of an activated skill. offset is a zero-based character offset. limit defaults to 32768 characters.",
  search_skill_resources:
    "Find ranked local data rows and guide passages by keywords. Activates the enabled skill if needed. Filter with pathPrefix (e.g. data/colors or themes/). Returns up to 16 matches, default 8.",
};
export const toolProgress: Record<ToolName, string> = {
  search_project_episodes: "正在检索项目历史需求…",
  get_episode_details: "正在查阅历史需求档案…",
  get_library_playbook: "正在查阅组件库说明书…",
  inspect_component_structure: "正在分析组件内部结构…",
  propose_scope_plan: "正在梳理生成范围与模块规划…",
  search_icons: "正在检索矢量图标…",
  search_stock_images: "正在检索摄影素材…",
  propose_html_design: "正在校验 HTML 画板并本地化素材…",
  get_canvas_overview: "正在读取画布概览…",
  search_nodes: "正在检索图层…",
  get_node_details: "正在读取图层属性…",
  search_components: "正在检索组件库…",
  get_design_system: "正在查询变量和样式…",
  lint_design: "正在检查设计规范…",
  propose_design_changes: "正在校验设计事务…",
  activate_skill: "正在激活技能…",
  read_skill_resource: "正在读取技能参考资料…",
  search_skill_resources: "正在检索技能参考资料…",
};
export function isEpisodeTool(name: string) {
  return name === "search_project_episodes" || name === "get_episode_details";
}
export function getFormaToolDefinitions(options: {
  hasSkills: boolean;
  hasEpisodes?: boolean;
  enableHtmlDesign?: boolean;
  enableScopePlan?: boolean;
}): AdapterToolDefinition[] {
  return (Object.keys(schemas) as ToolName[])
    .filter((name) => options.hasEpisodes === true || !isEpisodeTool(name))
    .filter(
      (name) =>
        name !== "propose_scope_plan" || options.enableScopePlan === true,
    )
    .filter(
      (name) =>
        name !== "propose_html_design" || options.enableHtmlDesign !== false,
    )
    .filter(
      (n) =>
        options.hasSkills ||
        (n !== "activate_skill" &&
          n !== "read_skill_resource" &&
          n !== "search_skill_resources"),
    )
    .map((name) => {
      const { $schema: _dialect, ...parameters } = z.toJSONSchema(
        name === "propose_scope_plan" && options.enableHtmlDesign !== false
          ? schemas.propose_scope_plan.extend({
              screens: schemas.propose_scope_plan.shape.screens.max(8),
            })
          : schemas[name],
        { io: name === "propose_scope_plan" ? "input" : "output" },
      );
      return { name, description: descriptions[name], parameters };
    });
}

function matches(query: string | undefined, ...fields: (string | undefined)[]) {
  const key = query?.trim().toLowerCase();
  return !key || fields.some((f) => f?.toLowerCase().includes(key));
}
// Page at record boundaries. In particular, never cut off the variants of a returned component.
function windowed<T>(items: T[], start = 0, limit = 40) {
  const rows: T[] = [];
  let chars = 0;
  for (const item of items.slice(start, start + limit)) {
    const size = JSON.stringify(item).length;
    if (rows.length && chars + size > 24000) break;
    rows.push(item);
    chars += size;
  }
  const next = start + rows.length;
  return {
    rows,
    total: items.length,
    nextOffset: next < items.length ? next : null,
  };
}

function nodeLocation(node: DesignNode, byId: Map<string, DesignNode>) {
  let locked = node.locked;
  const names = [node.name];
  let parent = node.parentId;
  while (parent) {
    const p = byId.get(parent);
    if (!p) break;
    locked ||= p.locked;
    names.unshift(p.name);
    parent = p.parentId;
  }
  return { path: names.join(" / "), locked };
}

function searchNodes(
  ctx: DesignChatContext,
  args: z.infer<typeof schemas.search_nodes>,
) {
  const doc = ctx.document,
    active = doc.activePage ?? "first";
  const scope = ctx.selection ? subtreeIds(doc, [ctx.selection]) : null;
  const ids = args.ids && new Set(args.ids);
  const rows = pageList(doc)
    .filter((p) => !args.pageId || p.id === args.pageId)
    .flatMap((page) => {
      const current = page.id === active;
      const nodes = current ? doc.nodes : (page.nodes ?? []);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      if (args.rootId && !byId.has(args.rootId)) return [];
      const rootScope = args.rootId
        ? subtreeIds(current ? doc : { ...doc, nodes }, [args.rootId])
        : null;
      return nodes
        .filter(
          (n) =>
            (!ids || ids.has(n.id)) &&
            (!rootScope || rootScope.has(n.id)) &&
            (!args.withinSelection || !scope || (current && scope.has(n.id))) &&
            (!args.onlyInstances || n.instance) &&
            (!args.types?.length || args.types.includes(n.type)) &&
            matches(
              args.query,
              n.id,
              n.name,
              n.text,
              n.type,
              n.instance?.libraryId,
              n.instance?.componentId,
              n.instance?.variantId,
            ),
        )
        .map((n) => {
          const location = nodeLocation(n, byId);
          return {
            id: n.id,
            name: n.name,
            type: n.type,
            parentId: n.parentId,
            pageId: page.id,
            editableOnCurrentPage:
              current && !location.locked && (!scope || scope.has(n.id)),
            withinSelection: scope ? current && scope.has(n.id) : undefined,
            ...location,
            text: n.text.slice(0, 160),
            fill: n.style.fill,
            width: n.style.width,
            height: n.style.height,
            instance: n.instance,
          };
        });
    });
  const { rows: nodes, ...page } = windowed(rows, args.offset, args.limit);
  return { nodes, ...page };
}

function nodeDetails(
  ctx: DesignChatContext,
  args: z.infer<typeof schemas.get_node_details>,
) {
  const doc = ctx.document,
    scope = ctx.selection ? subtreeIds(doc, [ctx.selection]) : null;
  const ids = new Set(args.ids);
  const detail = [];
  const missing = new Set(ids);
  for (const page of pageList(doc)) {
    const current = page.id === (doc.activePage ?? "first");
    const nodes = current ? doc.nodes : (page.nodes ?? []);
    const children = new Map<string, DesignNode[]>();
    for (const node of nodes) {
      if (!node.parentId) continue;
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
    const queue = nodes
      .filter((n) => ids.has(n.id))
      .map((n) => ({ n, level: 0 }));
    const seen = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
      const { n, level } = queue[i];
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      missing.delete(n.id);
      let componentDetails;
      if (n.instance) {
        const ref = n.instance;
        const component = doc.libraries?.[ref.libraryId]?.components.find(
          (c) => c.id === ref.componentId,
        );
        const descendants = [n];
        for (let j = 0; j < descendants.length; j++)
          descendants.push(...(children.get(descendants[j].id) ?? []));
        componentDetails = {
          exposed: component?.exposed ?? [],
          templateKeys: descendants
            .filter((d) => d.templateKey)
            .map((d) => ({
              id: d.id,
              templateKey: d.templateKey,
              type: d.type,
            })),
        };
      }
      detail.push({
        ...n,
        pageId: page.id,
        editableOnCurrentPage:
          current && (!scope || scope.has(n.id)) && !isLocked(doc, n.id),
        ...componentDetails,
      });
      if (args.includeChildren && level < (args.depth ?? 1))
        for (const child of children.get(n.id) ?? [])
          queue.push({ n: child, level: level + 1 });
    }
  }
  const { rows: nodes, ...page } = windowed(detail, args.offset, args.limit);
  return { nodes, missingIds: [...missing], ...page };
}

function librarySummary(lib: ComponentLibrary) {
  return {
    id: lib.id,
    name: lib.name,
    platform: findBuiltinEntry(lib.id)?.platform,
    revision: lib.revision,
    componentCount: lib.components.length,
  };
}

function libraryPlaybook(
  ctx: DesignChatContext,
  args: z.infer<typeof schemas.get_library_playbook>,
) {
  const libraries = Object.values(ctx.document.libraries ?? {});
  const wanted =
    args.libraryId ??
    ctx.targetLibraryId ??
    ctx.confirmedScope?.targetLibraryId;
  const lib = wanted ? libraries.find((l) => l.id === wanted) : libraries[0];
  const installedLibraries = libraries.map(librarySummary);
  if (!lib) {
    if (wanted) throw new Error("文档未安装组件库：" + wanted);
    return { installedLibraries, summary: "文档尚未安装组件库。" };
  }
  const manifest = buildLibraryManifest(lib);
  const aiGuide =
    lib.aiGuide?.playbookMarkdown !== undefined
      ? lib.aiGuide
      : generateLibraryPlaybook(lib, lib.aiGuide).aiGuide;
  const {
    libraryId,
    libraryName,
    revision,
    platform,
    tierCounts,
    tokensSummary,
  } = manifest;
  const indexEntry = ({
    componentId,
    name,
    assetTier,
  }: (typeof manifest.components)[number]) => ({
    componentId,
    name,
    assetTier,
  });
  return {
    libraryId,
    libraryName,
    revision,
    platform,
    tierCounts,
    tokensSummary,
    exceptionCount: manifest.exceptionComponents.length,
    exceptionComponents: manifest.exceptionComponents.map(indexEntry),
    summary: aiGuide.summary,
    playbookMarkdown: aiGuide.playbookMarkdown,
    installedLibraries,
    ...(args.includeComponents !== false && {
      components: manifest.components.map(indexEntry),
    }),
  };
}

function inspectComponent(
  ctx: DesignChatContext,
  args: z.infer<typeof schemas.inspect_component_structure>,
) {
  const diagnostics: CompileDiagnostic[] = [];
  const ref = resolveLibraryComponent(
    ctx.document,
    args.libraryId ??
      ctx.targetLibraryId ??
      ctx.confirmedScope?.targetLibraryId,
    args.componentId,
    args.variantId,
    undefined,
    diagnostics,
  );
  if (!ref) throw new ProposalValidationError(diagnostics);
  const library = ctx.document.libraries![ref.libraryId];
  const component = library.components.find((c) => c.id === ref.componentId)!;
  const variant = component.variants.find((v) => v.id === ref.variantId)!;
  const keys = new Map(variant.nodes.map((n) => [n.id, n.templateKey]));
  return {
    ...ref,
    diagnostics,
    nodes: variant.nodes.map((n) => ({
      templateKey: n.templateKey,
      name: n.name,
      type: n.type,
      parentTemplateKey: n.parentId ? keys.get(n.parentId) : null,
      ...(n.text && { text: n.text }),
      width: n.style.width,
      height: n.style.height,
      layout: n.style.layout,
      nestedSlot: n.nestedSlot ?? false,
      nestedSource: n.nestedSource ?? null,
      exposed:
        component.exposed?.filter(
          (property) => property.target === n.templateKey,
        ) ?? [],
    })),
    manifest: extractComponentManifest(library, component),
  };
}

function searchComponents(
  doc: DesignDocument,
  args: z.infer<typeof schemas.search_components>,
) {
  const libraries = Object.values(doc.libraries ?? {});
  const found = libraries
    .filter((l) => !args.libraryId || l.id === args.libraryId)
    .flatMap((lib) => {
      const entry = findBuiltinEntry(lib.id);
      const terms = args.query?.trim().toLowerCase().split(/\s+/) ?? [];
      return lib.components
        .filter((c) => {
          const tier = classifyComponentTier(c, lib);
          if (
            (args.category && c.category !== args.category) ||
            (args.tier && args.tier !== tier) ||
            (args.onlyExceptions && !isExceptionComponent(c))
          )
            return false;
          const fields = [
            lib.id,
            lib.name,
            lib.description,
            lib.aiGuide?.platform,
            entry?.platform,
            entry?.platformLabel,
            entry?.shortName,
            c.id,
            c.name,
            c.category,
            c.description,
            c.aiHints?.whenToUse,
            c.aiHints?.avoidWhen,
            c.aiHints?.slotsNote,
            ...(c.aiHints?.tags ?? []),
            {
              page: "page 页面 页面样板 页面模板 整页 模板 会场 screen template",
              block: "block 业务模块 业务楼层 业务区块 楼层 区块 section",
              component:
                "component 原子组件 基础组件 原子控件 基础控件 控件 atomic",
            }[tier],
            ...c.variants.flatMap((v) => [
              v.id,
              v.name,
              ...Object.entries(v.properties).flat(),
            ]),
          ];
          return terms.every((term) => matches(term, ...fields));
        })
        .map((c) => ({ lib, c }));
    });
  const start = args.offset ?? 0;
  const entries = found
    .slice(start, start + (args.limit ?? 10))
    .map(({ lib, c }) => {
      const {
        assetTier,
        isException,
        textSlots,
        imageSlots,
        swapSlots,
        aiHints,
      } = extractComponentManifest(lib, c);
      return {
        libraryId: lib.id,
        libraryName: lib.name,
        componentId: c.id,
        name: c.name,
        category: c.category,
        exposed: c.exposed ?? [],
        assetTier,
        isException,
        textSlots,
        imageSlots,
        swapSlots,
        aiHints: aiHints ?? null,
        variants: c.variants.map((v) => {
          const root = v.nodes.find((n) => !n.parentId);
          return {
            variantId: v.id,
            name: v.name,
            properties: v.properties,
            width: root?.style.width,
            height: root?.style.height,
          };
        }),
      };
    });
  const { rows: components } = windowed(entries, 0, entries.length);
  const next = start + components.length;
  return {
    components,
    total: found.length,
    nextOffset: next < found.length ? next : null,
    installedLibraries: libraries.map(librarySummary),
    ...(!found.length && {
      hint: "当前文档未找到匹配组件；设计师可在左侧「资源 → 组件库管理」中按需启用 iOS (Forma Mobile)、Android (Material Design 3)、Ant Design 5 或 shadcn/ui，或导入自定义组件库。",
    }),
  };
}

function designSystem(
  ctx: DesignChatContext,
  args: z.infer<typeof schemas.get_design_system>,
) {
  const doc = ctx.document,
    ds = doc.designSystem;
  const modes = effectiveModes(
    doc,
    doc.nodes.find((n) => n.id === ctx.selection),
  );
  const include = (kind: string) =>
    !args.kind || args.kind === "all" || args.kind === kind;
  const property = args.scope as VariableProperty | undefined;
  const entries = [
    ...(include("variables") && ds
      ? Object.values(ds.variables)
          .filter(
            (v) =>
              matches(args.query, v.name, v.id, v.description) &&
              (!property ||
                (v.type === propertyType(property) &&
                  (!v.scopes.length || v.scopes.includes(property)))),
          )
          .map((v) => ({
            group: "variables",
            item: {
              id: v.id,
              name: v.name,
              type: v.type,
              collectionId: v.collectionId,
              scopes: v.scopes,
              value: resolveVariable(ds, v.id, modes),
            },
          }))
      : []),
    ...(include("styles")
      ? Object.values(ds?.styles ?? {})
          .filter(
            (s) =>
              matches(args.query, s.name, s.id, s.description) &&
              (!property ||
                args.scope === s.kind ||
                (styleGroups[s.kind] as readonly string[]).includes(property)),
          )
          .map((item) => ({ group: "styles", item }))
      : []),
    ...(include("collections")
      ? Object.values(ds?.collections ?? {})
          .filter((c) => matches(args.query, c.name, c.id))
          .map((c) => ({
            group: "collections",
            item: { ...c, activeModeId: modes[c.id] ?? c.defaultModeId },
          }))
      : []),
  ];
  const { rows, ...page } = windowed(entries, args.offset, args.limit);
  const group = (name: string) =>
    rows.filter((r) => r.group === name).map((r) => r.item);
  return {
    variables: group("variables"),
    styles: group("styles"),
    collections: group("collections"),
    libraries: Object.values(doc.libraries ?? {}).map((lib) => ({
      ...librarySummary(lib),
      categories: [
        ...new Set(lib.components.map((component) => component.category)),
      ],
    })),
    ...page,
  };
}

function overview(ctx: DesignChatContext) {
  const doc = ctx.document,
    libs = Object.values(doc.libraries ?? {}),
    ds = doc.designSystem;
  const selected = doc.nodes.find((n) => n.id === ctx.selection);
  const roots = doc.nodes.filter((n) => !n.parentId);
  const { rows: artboards, total: rootCount } = windowed(
    roots.map((n) => ({ id: n.id, name: n.name, type: n.type })),
    0,
    100,
  );
  return {
    id: doc.id,
    name: doc.name,
    revision: doc.revision,
    activePage: doc.activePage ?? "first",
    pages: pageList(doc).map(({ id, name }) => ({ id, name })),
    artboards,
    rootCount,
    totalNodes: doc.nodes.length,
    placement: computeArtboardPlacement(doc, ctx.viewportCenter),
    selection: selected
      ? {
          id: selected.id,
          locked: isLocked(doc, selected.id),
          instanceOwner: instanceOwner(doc, selected.id)?.id,
        }
      : null,
    libraries: libs.map((l) => ({
      id: l.id,
      name: l.name,
      components: l.components.length,
    })),
    variables: Object.keys(ds?.variables ?? {}).length,
    styles: Object.keys(ds?.styles ?? {}).length,
    collections: Object.keys(ds?.collections ?? {}).length,
  };
}

function lintDesign(doc: DesignDocument, roots?: string[]) {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const scope = roots ? subtreeIds(doc, roots) : null;
  const issues: { kind: string; [field: string]: unknown }[] = checkDesigns(
    doc,
    roots,
  ).map((i) => ({
    ...i,
    suggestion:
      i.suggestion ??
      (i.kind === "low-contrast"
        ? "调整文字色或背景色以满足 AA 对比度"
        : "使用能说明用途的图层名称"),
  }));
  const reportedColors = new Set(
    issues.filter((i) => i.kind === "unbound-color").map((i) => i.id),
  );
  const colorVariables = Object.values(
    doc.designSystem?.variables ?? {},
  ).filter((v) => v.type === "color");
  const bounds = layoutBounds(doc);
  const siblings = new Map<string, { id: string; rect: Rect }[]>();
  for (const node of doc.nodes) {
    if (node.hidden || (scope && !scope.has(node.id))) continue;
    const resolved = resolveNode(doc, node, byId);
    const solidFill =
      ["frame", "rectangle", "ellipse", "button", "section"].includes(
        node.type,
      ) &&
      !node.fillToken &&
      !node.styleBindings?.paint &&
      !resolved.style.gradient &&
      !resolved.style.paints?.length &&
      (resolved.style.fillOpacity ?? 1) > 0;
    const solidText =
      ["text", "button"].includes(node.type) &&
      !node.styleBindings?.text &&
      !(node.type === "text" && node.styleBindings?.paint) &&
      (resolved.style.colorOpacity ?? 1) > 0;
    for (const prop of ["fill", "color"] as const) {
      if (
        !(prop === "fill" ? solidFill : solidText) ||
        node.variableBindings?.[prop] ||
        reportedColors.has("unbound-color:" + node.id + ":" + prop)
      )
        continue;
      if (
        !colorVariables.some((v) => !v.scopes.length || v.scopes.includes(prop))
      )
        continue;
      issues.push({
        kind: "unbound-color",
        nodeId: node.id,
        property: prop,
        message: "颜色 " + resolved.style[prop] + " 未绑定设计变量",
        suggestion:
          "查询 " +
          prop +
          " 作用域的颜色变量，选择语义匹配项后使用 bindVariable",
      });
    }
    if (node.type === "text" && !node.text.trim())
      issues.push({
        kind: "empty-text",
        nodeId: node.id,
        message: "文本层没有文案",
        suggestion: "填写文案或移除空层",
      });
    const parent = node.parentId && byId.get(node.parentId);
    if (!parent) continue;
    const box = bounds.get(node.id),
      outer = bounds.get(parent.id);
    if (!box || !outer) continue;
    if (
      box.x < outer.x - 1 ||
      box.y < outer.y - 1 ||
      box.x + box.width > outer.x + outer.width + 1 ||
      box.y + box.height > outer.y + outer.height + 1
    )
      issues.push({
        kind: "out-of-bounds",
        nodeId: node.id,
        parentId: parent.id,
        message: "子层超出父容器",
        suggestion: "调整子层位置、尺寸或父容器布局",
      });
    if (parent.style.layout === "free" || node.style.absolutePosition) {
      const list = siblings.get(parent.id) ?? [];
      list.push({ id: node.id, rect: box });
      siblings.set(parent.id, list);
    }
  }
  for (const group of siblings.values()) {
    group.sort((a, b) => a.rect.x - b.rect.x);
    for (let i = 0; i < group.length; i++) {
      const a = group[i].rect;
      for (let j = i + 1; j < group.length; j++) {
        const b = group[j].rect;
        if (b.x >= a.x + a.width) break;
        const overlap =
          (Math.min(a.x + a.width, b.x + b.width) - b.x) *
          Math.max(
            0,
            Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
          );
        if (overlap >= 0.8 * Math.min(a.width * a.height, b.width * b.height)) {
          issues.push({
            kind: "overlap",
            nodeId: group[i].id,
            otherId: group[j].id,
            message: "同级固定定位图层重叠至少 80%",
            suggestion: "检查层叠是否有意，或调整位置",
          });
          break;
        }
      }
    }
  }
  return issues;
}

function summarizeLint(issues: ReturnType<typeof lintDesign>) {
  const counts = new Map<string, number>();
  for (const { kind } of issues) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return {
    issueCount: issues.length,
    contrastIssues: counts.get("low-contrast") ?? 0,
    overflowIssues: counts.get("out-of-bounds") ?? 0,
    overlapIssues: counts.get("overlap") ?? 0,
    emptyTextIssues: counts.get("empty-text") ?? 0,
    unboundColorIssues: counts.get("unbound-color") ?? 0,
    topIssues: issues.slice(0, 6),
  };
}

export class ProposalValidationError extends Error {
  constructor(readonly diagnostics: CompileDiagnostic[]) {
    super(
      diagnostics
        .map((d) => [d.message, d.suggestion].filter(Boolean).join(" "))
        .join("\n"),
    );
  }
}

export function compileValidatedProposal(
  input: unknown,
  ctx: DesignChatContext,
): CompileBlueprintResult {
  return compileProposalSnapshot(input, ctx).result;
}

function checkConfirmedBoardCount(ctx: DesignChatContext, count: number) {
  const expected = ctx.confirmedScope?.screens.length;
  if (expected && expected !== count)
    throw new Error(
      `范围已确认 ${expected} 张画板，本次提交 ${count} 张。请按确认范围一次提交全部画板。`,
    );
}

type SubmittedBoard = Pick<
  HtmlArtboardSpec,
  "name" | "width" | "height" | "refId" | "role" | "parentRef"
>;
function checkConfirmedBoards(
  ctx: DesignChatContext,
  boards: SubmittedBoard[],
) {
  if (!ctx.confirmedScope) return;
  checkConfirmedBoardCount(ctx, boards.length);
  validateArtboardRelations(ctx.confirmedScope.screens);
  const remaining = new Set(ctx.confirmedScope.screens);
  return boards.map((board) => {
    const matches = [...remaining].filter((screen) =>
      board.refId !== undefined
        ? screen.refId === board.refId
        : screen.name === board.name,
    );
    const screen = matches[0];
    if (matches.length !== 1)
      throw Error(
        `画板「${board.refId ?? board.name}」与已确认的 refId 或名称不匹配；请按确认范围提交：${[...remaining].map((s) => s.refId + "/" + s.name).join("、")}`,
      );
    remaining.delete(screen);
    for (const field of ["role", "parentRef", "width", "height"] as const) {
      const actual =
        field === "role" ? (board.role ?? "primary") : board[field];
      if (actual !== screen[field])
        throw Error(
          `画板「${screen.refId}」的 ${field} 已确认为 ${screen[field] ?? "无"}，本次提交为 ${actual ?? "无"}。请按确认范围重提。`,
        );
    }
    return screen;
  });
}

function compileProposalSnapshot(
  input: unknown,
  ctx: DesignChatContext,
  images?: HtmlDesignDraft["images"],
) {
  const { artboards = [] } = z
    .object({
      artboards: z.array(z.object(relation)).optional(),
    })
    .parse(input);
  validateArtboardRelations(artboards);
  const result = compileBlueprintToTransaction(
    input,
    images ? { ...ctx, images } : ctx,
  );
  if (result.diagnostics.some((d) => d.severity === "error"))
    throw new ProposalValidationError(result.diagnostics);
  checkConfirmedBoardCount(ctx, result.createdRootIds.length);
  if (result.transaction) {
    try {
      const snapshot = validateProposalSnapshot(ctx, result.transaction);
      if (ctx.confirmedScope) {
        const bounds = layoutBounds(snapshot.document);
        const boards = result.createdRootIds.map((id, i) => {
          const root = snapshot.document.nodes.find(
            (n) => n.id === id && !n.parentId,
          );
          if (!root) throw Error("已确认的画板必须保留在页面顶层：" + id);
          const { width, height } = bounds.get(id)!;
          return { ...artboards[i], name: root.name, width, height };
        });
        checkConfirmedBoards(ctx, boards);
      }
      result.transaction = snapshot.transaction;
      return { result, document: snapshot.document };
    } catch (error) {
      throw new ProposalValidationError([
        ...result.diagnostics,
        {
          severity: "error",
          code: "invalid-transaction",
          message: error instanceof Error ? error.message : String(error),
          suggestion:
            "用 get_node_details 核对选区、实例属性及锁定状态后重新提交",
        },
      ]);
    }
  }
  return { result, document: null };
}

function parseToolInput(input: unknown) {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return extractJsonPayload(input);
  }
}

const serverDomParser = new DOMParser({
  errorHandler: {
    warning() {},
    error() {},
    fatalError() {
      throw new Error("HTML 结构无效");
    },
  },
});
const serializer = new XMLSerializer();

function hydrateIcon(el: Element) {
  const name = el.getAttribute("data-icon") || el.getAttribute("data-lucide");
  if (
    !name ||
    !/^(i|span|div)$/i.test(el.tagName) ||
    el.getElementsByTagName("*").length ||
    !["", name, "icon", "…", "..."].includes(el.textContent?.trim() ?? "")
  )
    return false;
  const markup = iconToInlineSvg(name, {
    size: parseFloat(el.getAttribute("data-size") || "20"),
    strokeWidth: parseFloat(el.getAttribute("data-stroke-width") || "1.75"),
    color: el.getAttribute("data-color") || undefined,
  });
  if (!markup) return false;
  const svg = el.ownerDocument.importNode(
    serverDomParser.parseFromString(markup, "image/svg+xml").documentElement,
    true,
  );
  for (const key of [
    "class",
    "style",
    "id",
    "role",
    "aria-label",
    "aria-hidden",
  ]) {
    if (el.hasAttribute(key)) svg.setAttribute(key, el.getAttribute(key)!);
  }
  svg.setAttribute(
    "data-forma-name",
    el.getAttribute("data-forma-name") || name,
  );
  el.parentNode!.replaceChild(svg, el);
  return true;
}

// Count placements in sanitized CSS, including quoted alternatives in image-set().
// Strings in content: or type() and local SVG fragment references are not images.
function cssImageCount(css: string) {
  const functions: string[] = [];
  let count = 0;
  const tokens =
    /\/\*[\s\S]*?(?:\*\/|$)|\b(?:url|src)\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^()'"]*))\s*\)|"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([-\w]*)\(|\)/gi;
  for (const m of css.matchAll(tokens)) {
    if (m[6] !== undefined) functions.push(m[6].toLowerCase());
    else if (m[0] === ")") functions.pop();
    else {
      const alternative = ["image-set", "-webkit-image-set", "image"].includes(
        functions.at(-1) ?? "",
      );
      const url =
        m[1] ?? m[2] ?? m[3] ?? (alternative ? (m[4] ?? m[5]) : undefined);
      if (url !== undefined && !/^(?:#|data:(?!image\/))/i.test(url.trim()))
        count++;
    }
  }
  return count;
}

function elementImageUsage(el: Element) {
  const tag = el.tagName.toLowerCase();
  let count = cssImageCount(el.getAttribute("style") ?? "");
  if (tag === "style") count += cssImageCount(el.textContent ?? "");
  const svg = tag === "image" || tag === "feimage";
  const attr = svg
    ? el.hasAttribute("href")
      ? "href"
      : "xlink:href"
    : tag === "video"
      ? "poster"
      : tag === "img" ||
          (tag === "input" &&
            el.getAttribute("type")?.toLowerCase() === "image")
        ? "src"
        : "background";
  const source = el.getAttribute(attr)?.trim();
  const hasSource = Boolean(source && !(svg && source.startsWith("#")));
  const stock = el.hasAttribute("data-stock-query");
  const placement =
    hasSource ||
    tag === "img" ||
    stock ||
    el.hasAttribute("data-forma-asset-id");
  // A source, stock query and asset marker on one styled element share a
  // position. The localizer can still visit both the CSS and source URLs.
  return {
    positions: Math.max(count, Number(placement)),
    mediaReferences: count + Number(hasSource || (tag === "img" && stock)),
  };
}

function localizedBoardImageCount(board: HtmlArtboardSpec) {
  const root = serverDomParser.parseFromString(
    "<forma-fragment>" + board.html + "</forma-fragment>",
    "text/html",
  ).documentElement;
  return Array.from(root.getElementsByTagName("*")).reduce(
    (sum, el) => sum + elementImageUsage(el).positions,
    cssImageCount(board.css ?? ""),
  );
}

type VisualReviewBoards = {
  all: HtmlArtboardSpec[];
  reviewed: HtmlArtboardSpec[];
};

function prepareHtmlDraft(
  board: HtmlArtboardSpec,
  doc: DesignDocument,
  targetLibraryId?: string,
) {
  // The shared sanitizer accepts only local CSS urls. Carry candidate photo URLs
  // through it as inert fragments until the media resolver can check each URL.
  const prefix = "forma-" + crypto.randomUUID() + "-";
  const urls: string[] = [];
  const protect = (style: string) =>
    style.replace(
      /\burl\(\s*(?:"((?:https?:\/\/|forma-asset:)[^"]*)"|'((?:https?:\/\/|forma-asset:)[^']*)'|((?:https?:\/\/|forma-asset:)[^\s()'"]+))\s*\)/gi,
      (_, double, single, bare) => {
        const url: string = double ?? single ?? bare;
        urls.push(url);
        return "url(#" + prefix + (urls.length - 1) + ")";
      },
    );
  const restore = (style: string) =>
    style.replace(
      new RegExp("url\\(#" + prefix + "(\\d+)\\)", "g"),
      (_, index) =>
        'url("' +
        urls[Number(index)].replace(/["\\\r\n\f]/g, (c) =>
          encodeURIComponent(c),
        ) +
        '")',
    );
  let imageCount = 0;
  let mediaReferences = 0;
  let iconsHydrated = 0;
  let componentSlotsResolved = 0;
  const diagnostics: CompileDiagnostic[] = [];
  let fragment: Element;
  const elements = () => Array.from(fragment.getElementsByTagName("*"));
  // Node has no inert HTMLTemplateElement. Back just the synchronous template
  // operations used by sanitizeDesignHtml with the bundled, non-executing DOM.
  const template = {
    set innerHTML(value: string) {
      fragment = serverDomParser.parseFromString(
        "<forma-fragment>" + value + "</forma-fragment>",
        "text/html",
      ).documentElement;
      for (const el of elements()) {
        // Browser HTML folds attribute names to lowercase; xmldom preserves their case.
        for (const attr of Array.from(el.attributes)) {
          const key = attr.name.toLowerCase();
          if (
            key !== attr.name &&
            [
              "style",
              "src",
              "type",
              "background",
              "href",
              "xlink:href",
              "poster",
              "data-stock-query",
              "data-forma-asset-id",
              "data-forma-component",
              "data-library",
              "data-variant",
              "data-variant-props",
              "data-overrides",
            ].includes(key)
          ) {
            if (!el.hasAttribute(key)) el.setAttribute(key, attr.value);
            el.removeAttributeNode(attr);
          }
        }
        if (el.hasAttribute("style"))
          el.setAttribute("style", protect(el.getAttribute("style")!));
        if (el.tagName.toLowerCase() === "style")
          el.textContent = protect(el.textContent ?? "");
      }
    },
    content: {
      querySelectorAll() {
        return elements().map((el) =>
          Object.assign(el, {
            remove: () => el.parentNode?.removeChild(el),
          }),
        );
      },
    },
    get innerHTML() {
      const styles: string[] = [];
      for (const el of elements()) {
        if (el.hasAttribute("style"))
          el.setAttribute("style", restore(el.getAttribute("style")!));
        if (el.tagName.toLowerCase() === "style")
          el.textContent = restore(el.textContent ?? "");
        const usage = elementImageUsage(el);
        imageCount += usage.positions;
        mediaReferences += usage.mediaReferences;
        if (el.tagName.toLowerCase() === "style") {
          // CSS in a style element is raw text. XML-escaping child selectors
          // or ampersands in photo URLs changes their CSS meaning.
          styles.push(
            (el.textContent ?? "").replace(/<\/style/gi, "\\3c /style"),
          );
          el.textContent = prefix + "style-" + (styles.length - 1);
        }
        if (el.hasAttribute("data-forma-component")) {
          try {
            if (!resolveHtmlComponentSlot(doc, el, targetLibraryId, board.name))
              throw new HtmlComponentSlotError(
                board.name,
                el.getAttribute("data-forma-component") || "(空 ID)",
                "data-forma-component",
                "找不到组件",
              );
            componentSlotsResolved++;
          } catch (error) {
            if (!(error instanceof HtmlComponentSlotError)) throw error;
            diagnostics.push({
              severity: "error",
              code: "invalid-component-slot",
              message: error.message,
              suggestion:
                "请用 search_components 核对组件来源、变体及公开槽位后重新提交。",
            });
          }
        } else if (hydrateIcon(el)) iconsHydrated++;
      }
      const markup = Array.from(fragment.childNodes, (n) =>
        serializer.serializeToString(n),
      ).join("");
      return markup.replace(
        new RegExp(prefix + "style-(\\d+)", "g"),
        (_, index) => styles[Number(index)],
      );
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => template },
  });
  try {
    const clean = sanitizeDesignHtml(board.html, protect(board.css ?? ""));
    const css = restore(clean.css);
    const cssReferences = cssImageCount(css);
    return {
      ...board,
      html: clean.html,
      css,
      imageCount: imageCount + cssReferences,
      mediaReferences: mediaReferences + cssReferences,
      iconsHydrated,
      componentSlotsResolved,
      diagnostics,
    };
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

const episodeToolBudget = 16_000;
const episodeBudgetNote = "历史档案工具上下文预算已满，返回精简索引";
const exhaustedEpisodeReply = {
  ok: false,
  budgetExhausted: true,
  error: "历史档案工具上下文预算已用尽",
} as const;
const exhaustionReplyChars = JSON.stringify(exhaustedEpisodeReply).length;

export class FormaToolExecutor {
  private episodeToolCharsUsed = 0;
  private pendingEpisodeReplies = 0;
  private directExhaustionSent = false;
  private inEpisodeBatch = false;
  private episodeReadsClosed = false;
  get episodeToolBudgetExhausted(): boolean {
    return (
      this.episodeReadsClosed || this.episodeToolCharsUsed >= episodeToolBudget
    );
  }
  prepareEpisodeToolBatch(count: number) {
    if (
      this.episodeToolCharsUsed + count * exhaustionReplyChars >
      episodeToolBudget
    ) {
      this.episodeReadsClosed = true;
      return false;
    }
    this.pendingEpisodeReplies = count;
    return true;
  }
  private get remainingEpisodeChars() {
    return (
      episodeToolBudget -
      this.episodeToolCharsUsed -
      Math.max(1, this.pendingEpisodeReplies) * exhaustionReplyChars
    );
  }
  readonly toolTrace: AgentToolTraceItem[] = [];
  readonly consultedEpisodeIds = new Set<string>();
  readonly activatedSkills = new Set<string>();
  readonly enabledSkills: SkillCatalogEntry[];
  readonly preloadedSkills: ActivatedSkillPayload[] = [];
  latestProposal?: CompileBlueprintResult;
  latestHtmlDraft?: HtmlDesignDraftProposal;
  latestScopeProposal?: { reply: string; scopeProposal: ScopeProposal };
  readonly mediaRegistry = new MediaAssetRegistry();
  private readonly stockCandidates = new Map<string, StockImageCandidate>();
  private shadowDoc: DesignDocument | null = null;
  private readonly active = new Map<string, ActivatedSkillPayload>();

  constructor(
    private readonly ctx: DesignChatContext,
    private readonly skillProvider?: SkillRuntimeProvider,
    private readonly review?: VisualReviewBoards,
  ) {
    this.enabledSkills = skillProvider?.listEnabledSkills() ?? [];
    for (const name of new Set(ctx.activeSkills ?? [])) {
      const payload = this.activate(name);
      if (payload && !this.preloadedSkills.some((s) => s.id === payload.id))
        this.preloadedSkills.push(payload);
    }
  }

  private activate(name: string, refresh = false) {
    const entry = this.enabledSkills.find(
      (e) => e.id === name || e.name === name,
    );
    if (!entry) return null;
    const cached = this.active.get(entry.id);
    if (cached && !refresh) return cached;
    const payload = this.skillProvider?.activateSkill(entry.id);
    if (!payload) return null;
    const skill = withFormaSkillAdaptation(payload);
    this.active.set(entry.id, skill);
    this.activatedSkills.add(skill.id);
    return skill;
  }

  get scopePlanDisabledReason() {
    if (this.ctx.confirmedScope)
      return "范围已确认，请直接生成画板，不要再次提问";
    if (this.ctx.selection) return "局部选区修改请直接生成，不需要范围确认";
  }

  private readContext(ids: string[], defaultToShadow = false) {
    const shadow = this.shadowDoc;
    if (
      shadow &&
      (defaultToShadow ||
        ids.some(
          (id) => !findLayer(this.ctx.document, id) && findLayer(shadow, id),
        ))
    )
      return { ...this.ctx, document: shadow, source: "proposed-shadow" };
    return { ...this.ctx, source: undefined };
  }

  execute(
    name: string,
    input: unknown,
    unavailableReason?: string,
  ): Record<string, unknown> {
    const start = performance.now();
    const recall = isEpisodeTool(name);
    if (recall) {
      const batched = this.pendingEpisodeReplies > 0;
      if (
        !batched &&
        (this.directExhaustionSent ||
          episodeToolBudget - this.episodeToolCharsUsed < exhaustionReplyChars)
      )
        throw new Error("历史档案工具响应预算已耗尽（上限 16,000 字符）");
      this.pendingEpisodeReplies = Math.max(0, this.pendingEpisodeReplies - 1);
      this.inEpisodeBatch = batched;
      if (this.episodeToolBudgetExhausted)
        return this.exhaustEpisodeBudget(name, start);
    }
    let response: Record<string, unknown>;
    try {
      if (unavailableReason) throw new Error(unavailableReason);
      const result = this.dispatch(name, parseToolInput(input));
      if (recall && !this.fitsEpisodeBudget(result))
        return this.exhaustEpisodeBudget(name, start);
      response = this.success(name, start, result);
    } catch (error) {
      response = this.failure(name, start, error);
    }
    if (recall) {
      const length = JSON.stringify(response).length;
      if (length > this.remainingEpisodeChars)
        return this.exhaustEpisodeBudget(name, start, false);
      this.episodeToolCharsUsed += length;
      if (
        response.ok &&
        name === "get_episode_details" &&
        typeof response.id === "string"
      )
        this.consultedEpisodeIds.add(response.id);
      if (this.remainingEpisodeChars < exhaustionReplyChars)
        this.episodeReadsClosed = true;
    }
    return response;
  }

  private exhaustEpisodeBudget(name: string, start: number, trace = true) {
    this.episodeReadsClosed = true;
    if (!this.inEpisodeBatch) this.directExhaustionSent = true;
    this.episodeToolCharsUsed += exhaustionReplyChars;
    if (trace)
      this.toolTrace.push({
        name,
        status: "error",
        summary: exhaustedEpisodeReply.error,
        durationMs: Math.round(performance.now() - start),
      });
    return { ...exhaustedEpisodeReply };
  }

  async executeAsync(
    name: string,
    input: unknown,
    runtimeOpts: ToolRuntimeOptions = {},
  ): Promise<Record<string, unknown>> {
    runtimeOpts.signal?.throwIfAborted();
    if (
      ![
        "search_stock_images",
        "propose_html_design",
        "propose_design_changes",
      ].includes(name)
    )
      return this.execute(name, input);

    const start = performance.now();
    try {
      const value = parseToolInput(input);
      const mediaOptions = {
        fetchImpl: runtimeOpts.fetchImpl,
        signal: runtimeOpts.signal,
        allowNetwork: runtimeOpts.allowNetworkMedia ?? true,
        registry: this.mediaRegistry,
      };
      let result: Record<string, unknown>;
      if (name === "search_stock_images")
        result = await this.searchPhotos(value, mediaOptions);
      else if (name === "propose_html_design")
        result = await this.proposeHtml(value, mediaOptions);
      else result = await this.proposeBlueprintWithMedia(value, mediaOptions);
      runtimeOpts.signal?.throwIfAborted();
      return this.success(name, start, result);
    } catch (error) {
      runtimeOpts.signal?.throwIfAborted();
      return this.failure(name, start, error);
    }
  }

  private async searchPhotos(value: unknown, mediaOptions: MediaOptions) {
    const { query, ...filters } = schemas.search_stock_images.parse(value);
    const candidates = await searchStockImages(query, {
      ...mediaOptions,
      ...filters,
    });
    for (const c of candidates) {
      this.stockCandidates.set(c.url, c);
      this.stockCandidates.set(c.id, c);
    }
    if (candidates[0]) this.stockCandidates.set(query, candidates[0]);
    return {
      images: candidates.map(({ id, title, url, orientation, mood, tags }) => ({
        id,
        title,
        url,
        orientation,
        mood,
        tags: tags.slice(0, 5),
      })),
      note: '在 propose_html_design 中可直接用于 <img src="..."> 或 data-stock-query，或在 propose_design_changes 中通过 image.url 引用。',
    };
  }

  private async localizeArtboard(
    clean: ReturnType<typeof prepareHtmlDraft>,
    mediaOptions: MediaOptions,
  ) {
    // A refinement can refer to previously localized photos by short IDs.
    let restored = 0;
    const expandAsset = (source: string) =>
      source.replace(/forma-asset:(img-[a-f\d]{64})/g, (ref, id) => {
        const asset = this.mediaRegistry.get(id);
        if (!asset || restored >= maxHtmlImages) return ref;
        restored++;
        return asset.data;
      });
    const stylesheet =
      '<style data-forma-stylesheet="' + crypto.randomUUID() + '">';
    const markup =
      expandAsset(clean.html) +
      stylesheet +
      expandAsset(clean.css).replace(/<\/style/gi, "\\3c /style") +
      "</style>";
    const resolved = await resolveMediaAssetsForHtml(markup, {
      ...mediaOptions,
      maxImages: clean.mediaReferences + 1,
    });
    mediaOptions.signal?.throwIfAborted();
    if (resolved.resolvedCount > clean.mediaReferences)
      throw Error(
        `画板「${clean.name}」本地化的图片位置超出预检数量，请核对 HTML 与 CSS 中的图片。`,
      );
    const boundary = resolved.html.lastIndexOf(stylesheet);
    if (boundary < 0) throw new Error("无法分离画板样式表");
    const {
      diagnostics: _diagnostics,
      imageCount: _imageCount,
      mediaReferences: _mediaReferences,
      ...board
    } = clean;
    return {
      board: {
        ...board,
        html: resolved.html.slice(0, boundary),
        css: resolved.html.slice(boundary + stylesheet.length, -8),
        imagesLocalized: resolved.resolvedCount,
      },
      images: resolved.images,
      fallbackImages: resolved.fallbackCount,
    };
  }

  private async proposeHtml(value: unknown, mediaOptions: MediaOptions) {
    if (this.ctx.selection)
      throw Error("请用 propose_design_changes 在选区内提交 Blueprint 修改");
    const args = schemas.propose_html_design.parse(value);
    const targetLibraryId =
      this.ctx.targetLibraryId ??
      this.ctx.confirmedScope?.targetLibraryId ??
      args.targetLibraryId;
    const submitted: HtmlArtboardSpec[] = args.artboards ?? [
      singleHtmlBoard.parse(args),
    ];
    const changed = new Set<HtmlArtboardSpec>();
    const boards = submitted.map((board) => {
      if (!this.review) return board;
      const matches =
        !args.artboards && this.review.reviewed.length === 1
          ? this.review.reviewed
          : this.review.reviewed.filter((b) =>
              board.refId ? b.refId === board.refId : b.name === board.name,
            );
      if (matches.length !== 1 || changed.has(matches[0]))
        throw Error("精修画板与原稿身份不匹配：" + (board.refId ?? board.name));
      changed.add(matches[0]);
      const { name, refId, role, parentRef, width, height } = matches[0];
      return { ...board, name, refId, role, parentRef, width, height };
    });
    const confirmed = checkConfirmedBoards(this.ctx, boards);
    if (args.artboards && !this.review) {
      const reserved = new Set(boards.flatMap((b) => [b.refId, b.parentRef]));

      let next = 1;
      for (const [index, board] of boards.entries()) {
        if (board.refId !== undefined) continue;
        const screen = confirmed?.[index];
        if (screen) board.refId = screen.refId;
        else {
          while (reserved.has("board-" + next)) next++;
          board.refId = "board-" + next++;
        }
      }
    }
    const prepared = boards.map((board) =>
      prepareHtmlDraft(board, this.ctx.document, targetLibraryId),
    );
    const diagnostics = prepared.flatMap((board) => board.diagnostics);
    if (diagnostics.length) throw new ProposalValidationError(diagnostics);
    validateArtboardRelations(this.review?.all ?? boards);
    const usage = prepared.map(({ name, imageCount }) => ({
      name,
      imageCount,
    }));
    for (const board of this.review?.all ?? []) {
      if (!changed.has(board))
        usage.push({
          name: board.name,
          imageCount: localizedBoardImageCount(board),
        });
    }
    const count = usage.reduce((sum, board) => sum + board.imageCount, 0);
    if (count > maxHtmlImages)
      throw Error(
        `画板图片位置共 ${count} 个，上限 ${maxHtmlImages}：${usage.map((b) => b.name + " " + b.imageCount + " 个").join("、")}`,
      );
    const artboards = [];
    const images: NonNullable<HtmlDesignDraft["images"]> = {};
    let imagesLocalized = 0,
      iconsHydrated = 0,
      componentSlotsResolved = 0,
      fallbackImages = 0;
    for (const clean of prepared) {
      const localized = await this.localizeArtboard(clean, mediaOptions);
      artboards.push(localized.board);
      Object.assign(images, localized.images);
      imagesLocalized += localized.board.imagesLocalized;
      iconsHydrated += clean.iconsHydrated;
      componentSlotsResolved += clean.componentSlotsResolved;
      fallbackImages += localized.fallbackImages;
    }
    const { name, width, height, html, css } = artboards[0];
    const totals = { imagesLocalized, iconsHydrated, componentSlotsResolved };
    const placement = computeArtboardPlacement(
      this.ctx.document,
      this.ctx.viewportCenter,
      { width, height },
    );
    this.latestHtmlDraft = {
      name,
      width,
      height,
      html,
      css,
      images,
      ...((this.review ||
        args.artboards ||
        args.refId ||
        args.role ||
        args.parentRef) && {
        artboards,
      }),
      ...(targetLibraryId && { targetLibraryId }),
      ...(args.snapLibraryTokens !== undefined && {
        snapLibraryTokens: args.snapLibraryTokens,
      }),
      placement: { x: placement.x, y: placement.y },
      reply: args.reply,
      summary:
        args.summary ??
        (artboards.length > 1
          ? `生成 ${artboards.length} 张画板`
          : "生成现代精排画板：" + name),
      ...totals,
    };
    this.latestProposal = undefined;
    this.latestScopeProposal = undefined;
    this.shadowDoc = null;
    return {
      name,
      width,
      height,
      artboardCount: artboards.length,
      ...totals,
      fallbackImages,
      guidance:
        "HTML 现代精排画板已校验并本地化全部摄影图与矢量图标，直接用简洁中文向设计师总结。",
    };
  }

  private async proposeBlueprintWithMedia(
    value: unknown,
    mediaOptions: MediaOptions,
  ) {
    const args = schemas.propose_design_changes.parse(value);
    // Nested z.unknown() properties can still refer to the caller's data.
    const proposal = structuredClone(args);
    const pending: unknown[] = [
      ...(proposal.artboards ?? []),
      ...(proposal.edits ?? []),
    ];
    const localized = new Map<string, string>();
    const visited = new WeakSet<object>();
    while (pending.length) {
      mediaOptions.signal?.throwIfAborted();
      const entry = pending.pop();
      if (!entry || typeof entry !== "object") continue;
      const node = entry as Record<string, unknown>;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const child of Object.values(node))
        if (child && typeof child === "object") pending.push(child);
      const image = node.image;
      const spec =
        image && typeof image === "object"
          ? (image as Record<string, unknown>)
          : undefined;
      const ref = typeof image === "string" ? image : spec?.url;
      if (typeof ref !== "string" || !/^(?:https:\/\/|stock:)/i.test(ref))
        continue;
      let assetId = localized.get(ref);
      if (!assetId) {
        const isStock = /^stock:/i.test(ref);
        const query = isStock ? ref.slice(6).trim() : ref;
        let candidate = this.stockCandidates.get(query);
        if (isStock && !candidate) {
          [candidate] = await searchStockImages(query, {
            ...mediaOptions,
            limit: 1,
          });
        }
        const asset = await localizeImageUrl(candidate?.url ?? ref, {
          ...mediaOptions,
          name: candidate?.title,
          fallbackPrompt: query,
        });
        assetId = asset.assetId;
        localized.set(ref, assetId);
      }
      if (spec) {
        delete spec.url;
        spec.assetId = assetId;
      } else node.image = assetId;
    }
    mediaOptions.signal?.throwIfAborted();
    return this.dispatch(
      "propose_design_changes",
      proposal,
      this.mediaRegistry.toRecord(),
    );
  }

  private success(
    name: string,
    start: number,
    result: Record<string, unknown>,
  ) {
    const warning =
      Array.isArray(result.diagnostics) && result.diagnostics.length > 0;
    const summary =
      typeof result.summary === "string"
        ? result.summary
        : typeof result.total === "number"
          ? "匹配 " + result.total + " 项"
          : "已完成";
    this.toolTrace.push({
      name,
      status: warning ? "warning" : "ok",
      summary,
      durationMs: Math.round(performance.now() - start),
    });
    const response = {
      ok: true,
      editableSelectionId: this.ctx.selection,
      ...result,
    };
    return response;
  }

  private fitsEpisodeBudget(result: Record<string, unknown>) {
    return (
      JSON.stringify({
        ok: true,
        editableSelectionId: this.ctx.selection,
        ...result,
      }).length <= this.remainingEpisodeChars
    );
  }

  private episodeDetails(
    ep: RecalledEpisodePayload,
    offset: number,
    limit: number,
    includeSamples: boolean,
  ) {
    const index = {
      id: ep.id,
      title: ep.title.slice(0, 80),
      sourceFileName: ep.sourceFileName.slice(0, 80),
      libraryId: ep.libraryId,
      screens: ep.screens.slice(0, 3).map(({ name, width, height }) => ({
        name: name.slice(0, 48),
        width,
        height,
      })),
      componentsUsed: ep.componentsUsed
        .slice(0, 3)
        .map(({ libraryId, componentId, variantId }) => ({
          libraryId,
          componentId,
          variantId,
        })),
      truncatedByBudget: true,
      note: episodeBudgetNote,
    };
    const promptPage = (length: number) => {
      const prompt = ep.prompt.slice(offset, offset + length);
      return {
        prompt,
        promptOffset: offset,
        promptLength: ep.prompt.length,
        hasMorePrompt: offset + prompt.length < ep.prompt.length,
      };
    };
    const recipe = {
      ...episodeReference(ep),
      libraryName: ep.libraryName,
      ...promptPage(limit),
      summary: ep.summary,
      mode: ep.mode,
      screens: includeSamples
        ? ep.screens
        : ep.screens.map((s) => ({ ...s, sampleTexts: [] })),
      componentsUsed: ep.componentsUsed,
      customModules: ep.customModules,
      decisions: ep.decisions,
      tags: ep.tags,
      createdAt: ep.createdAt,
    };
    if (this.fitsEpisodeBudget(recipe)) return recipe;
    const compact = {
      ...recipe,
      summary: ep.summary.slice(0, 160),
      matchReasons: undefined,
      screens: ep.screens.slice(0, 3).map((s) => ({
        ...s,
        componentIds: s.componentIds.slice(0, 3),
        sampleTexts: [],
      })),
      componentsUsed: ep.componentsUsed.slice(0, 4),
      customModules: ep.customModules.slice(0, 2),
      decisions: ep.decisions.slice(0, 2),
      tags: ep.tags.slice(0, 4),
      truncatedByBudget: true,
    };
    if (this.fitsEpisodeBudget(compact)) return compact;
    // Preserve usable pagination even when the full arrays or escaped prompt cannot fit.
    const pageIndex = this.fitsEpisodeBudget({ ...index, ...promptPage(0) })
      ? index
      : { id: ep.id, truncatedByBudget: true };
    const partial = { ...pageIndex, ...promptPage(0) };
    if (!this.fitsEpisodeBudget(partial)) return index;
    let lo = 0,
      hi = recipe.prompt.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.fitsEpisodeBudget({ ...partial, ...promptPage(mid) })) lo = mid;
      else hi = mid - 1;
    }
    return { ...pageIndex, ...promptPage(lo) };
  }

  private failure(name: string, start: number, error: unknown) {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 1800);
    const diagnostics =
      error instanceof ProposalValidationError
        ? error.diagnostics
        : [{ severity: "error", code: "tool-error", message }];
    this.toolTrace.push({
      name,
      status: "error",
      summary: message,
      durationMs: Math.round(performance.now() - start),
    });
    return {
      ok: false,
      error: message,
      diagnostics,
      editableSelectionId: this.ctx.selection,
    };
  }

  private dispatch(
    name: string,
    input: unknown,
    images?: HtmlDesignDraft["images"],
  ): Record<string, unknown> {
    switch (name) {
      case "search_project_episodes": {
        const {
          query,
          libraryId,
          onlyCurrentFile,
          limit = 8,
        } = schemas.search_project_episodes.parse(input);
        const keyword = query?.trim().toLowerCase() ?? "";
        const tokens = keyword.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [keyword];
        const found = (this.ctx.recalledEpisodes ?? []).filter((ep) => {
          if (
            (libraryId && libraryId !== ep.libraryId) ||
            (onlyCurrentFile && !ep.isCurrentFile)
          )
            return false;
          const text = [
            ep.title,
            ep.summary,
            ep.prompt,
            ...ep.tags,
            ...ep.customModules,
            ...ep.screens.map((s) => s.name),
            ...ep.componentsUsed.map((c) => c.componentName),
          ]
            .join("\n")
            .toLowerCase();
          return tokens.every((token) => text.includes(token));
        });
        const matches = found.slice(0, limit);
        const result = {
          total: found.length,
          scope: this.ctx.memoryScope ?? null,
          episodes: matches.map((ep) => ({
            ...episodeReference(ep),
            libraryName: ep.libraryName,
            summary: ep.summary,
          })),
        };
        if (!this.fitsEpisodeBudget(result)) {
          const limited = {
            total: found.length,
            episodes: [] as Pick<
              RecalledEpisodePayload,
              "id" | "title" | "libraryId"
            >[],
            truncatedByBudget: true,
            note: episodeBudgetNote,
          };
          for (const ep of matches) {
            limited.episodes.push({
              id: ep.id,
              title: ep.title.slice(0, 80),
              libraryId: ep.libraryId,
            });
            if (!this.fitsEpisodeBudget(limited)) {
              limited.episodes.pop();
              break;
            }
            this.consultedEpisodeIds.add(ep.id);
          }
          return limited;
        }
        for (const ep of matches) this.consultedEpisodeIds.add(ep.id);
        return result;
      }
      case "get_episode_details": {
        const {
          episodeId,
          promptOffset = 0,
          promptLimit = 1200,
          includeSampleTexts = true,
        } = schemas.get_episode_details.parse(input);
        const episode = this.ctx.recalledEpisodes?.find(
          (ep) => ep.id === episodeId,
        );
        if (!episode) throw new Error("未找到历史需求档案：" + episodeId);
        return this.episodeDetails(
          episode,
          promptOffset,
          promptLimit,
          includeSampleTexts,
        );
      }
      case "search_icons": {
        const { query, limit } = schemas.search_icons.parse(input);
        return { icons: searchIcons(query, limit) };
      }
      case "get_canvas_overview":
        schemas.get_canvas_overview.parse(input);
        return overview(this.ctx);
      case "search_nodes": {
        const args = schemas.search_nodes.parse(input);
        const ctx = this.readContext(
          [...(args.rootId ? [args.rootId] : []), ...(args.ids ?? [])],
          !args.rootId && !args.ids,
        );
        return {
          ...searchNodes(ctx, args),
          ...(ctx.source && { source: ctx.source }),
        };
      }
      case "get_node_details": {
        const args = schemas.get_node_details.parse(input);
        const ctx = this.readContext(args.ids);
        return {
          ...nodeDetails(ctx, args),
          ...(ctx.source && { source: ctx.source }),
        };
      }
      case "search_components":
        return searchComponents(
          this.ctx.document,
          schemas.search_components.parse(input),
        );
      case "get_library_playbook":
        return libraryPlaybook(
          this.ctx,
          schemas.get_library_playbook.parse(input),
        );
      case "inspect_component_structure":
        return inspectComponent(
          this.ctx,
          schemas.inspect_component_structure.parse(input),
        );
      case "propose_scope_plan": {
        if (this.scopePlanDisabledReason)
          throw new Error(this.scopePlanDisabledReason);
        const { reply, ...plan } = schemas.propose_scope_plan.parse(input);
        if (this.ctx.generationMode !== "blueprint" && plan.screens.length > 8)
          throw Error("HTML 范围规划最多 8 张画板");
        validateArtboardRelations(plan.screens);
        const targetLibraryId =
          this.ctx.targetLibraryId ?? plan.targetLibraryId;
        const library = Object.values(this.ctx.document.libraries ?? {}).find(
          (l) => l.id === targetLibraryId,
        );
        const scopeProposal = {
          ...plan,
          targetLibraryId,
          targetLibraryName: library?.name,
        };
        this.latestScopeProposal = { reply, scopeProposal };
        this.latestHtmlDraft = undefined;
        this.latestProposal = undefined;
        this.shadowDoc = null;
        return {
          reply,
          scopeProposal,
          summary: plan.summary,
          guidance: "用简洁中文呈现默认方案，等待设计师确认范围。",
        };
      }
      case "get_design_system":
        return designSystem(this.ctx, schemas.get_design_system.parse(input));
      case "lint_design": {
        const args = schemas.lint_design.parse(input);
        const root = args.rootId ?? this.ctx.selection;
        const ctx = this.readContext(
          root ? [root] : [],
          !root && !this.ctx.document.nodes.length,
        );
        if (root && !ctx.document.nodes.some((n) => n.id === root))
          throw new Error("体检根节点不存在：" + root);
        const issues = lintDesign(ctx.document, root ? [root] : undefined);
        const { rows, ...page } = windowed(issues, args.offset, args.limit);
        return {
          issues: rows,
          ...page,
          ...(ctx.source && { source: ctx.source }),
        };
      }
      case "propose_design_changes": {
        const { result: compiled, document } = compileProposalSnapshot(
          schemas.propose_design_changes.parse(input),
          this.ctx,
          images,
        );
        if (!document) throw new Error("提案缺少有效事务");
        indexPublishedScene(document);
        const { summary, stats, diagnostics, createdRootIds } = compiled;
        const roots = createdRootIds.length
          ? createdRootIds
          : this.ctx.selection
            ? [this.ctx.selection]
            : undefined;
        const lintSummary = summarizeLint(lintDesign(document, roots));
        this.latestHtmlDraft = undefined;
        this.latestScopeProposal = undefined;
        this.latestProposal = compiled;
        this.shadowDoc = document;
        const {
          contrastIssues,
          overflowIssues,
          overlapIssues,
          emptyTextIssues,
        } = lintSummary;
        const guidance =
          contrastIssues || overflowIssues || overlapIssues || emptyTextIssues
            ? "请按 lintSummary 核对提案中的问题，修改后重新提交完整提案。"
            : "对比度、越界、重叠和空文案检查通过，无需再次调用 lint_design 或 get_canvas_overview，直接用简洁中文向设计师总结。";
        return {
          summary,
          stats,
          diagnostics,
          createdRootIds,
          lintSummary,
          guidance,
        };
      }
      case "activate_skill": {
        const args = schemas.activate_skill.parse(input);
        const skill = this.activate(args.name, true);
        if (!skill) throw new Error("技能未启用或不存在：" + args.name);
        return { ...skill };
      }
      case "read_skill_resource": {
        const { name, path, ...options } =
          schemas.read_skill_resource.parse(input);
        const skill = [...this.active.values()].find(
          (s) => s.id === name || s.name === name,
        );
        if (!skill) throw new Error("请先激活该技能");
        if (!validResourcePath(path) || !skill.resources.includes(path))
          throw new Error("资源路径不在已激活技能清单内");
        const resource = this.skillProvider?.readSkillResource(
          skill.id,
          path,
          options,
        );
        if (
          !resource ||
          resource.path !== path ||
          resource.content.length > (options.limit ?? maxSkillResourcePageChars)
        )
          throw new Error("无法读取技能资源或超出本次分页上限");
        return resource;
      }
      case "search_skill_resources": {
        const {
          name,
          query,
          pathPrefix,
          limit = 8,
        } = schemas.search_skill_resources.parse(input);
        if (pathPrefix !== undefined && !validSkillResourcePrefix(pathPrefix))
          throw new Error("技能资源路径前缀无效");
        if (!this.skillProvider?.searchSkillResources)
          throw new Error(
            "当前技能提供方未支持检索，请激活后使用 read_skill_resource",
          );
        const previouslyActive = this.activatedSkills.size;
        const skill = this.activate(name);
        if (!skill) throw new Error("技能未启用或不存在：" + name);
        const result = this.skillProvider.searchSkillResources(
          skill.id,
          query,
          { pathPrefix, limit },
        );
        if (!result) throw new Error("无法检索该技能的本地资源");
        if (
          result.matches.length > limit ||
          result.matches.some(
            (match) =>
              !validResourcePath(match.path) ||
              !skill.resources.includes(match.path) ||
              (pathPrefix !== undefined && !match.path.startsWith(pathPrefix)),
          )
        )
          throw new Error("检索结果超出已激活技能的资源范围");
        return {
          ...result,
          summary:
            "已检索 " +
            result.searchedFiles +
            " 份资源，命中 " +
            result.matches.length +
            " 项",
          ...(this.activatedSkills.size > previouslyActive && {
            activatedSkill: skill,
          }),
        };
      }
      default:
        throw new Error("未知工具：" + name);
    }
  }
}
