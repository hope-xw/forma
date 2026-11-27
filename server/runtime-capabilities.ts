import { z } from "zod";
import { validateProposal, type Transaction } from "../src/agent/provider";
import { componentProjectFiles } from "../src/compiler/component-project";
import { exportTokenFiles } from "../src/compiler/design-tokens";
import {
  exportInteractiveReact,
  runtimeNodes,
  unwrapSectionsAndSlices,
} from "../src/compiler/runtime";
import { exportNodeToSvg } from "../src/compiler/svg-export";
import { emptyDesignSystem } from "../src/domain/design-system-schema";
import type { DesignDocument, DesignNode } from "../src/domain/document";
import { layoutBounds } from "../src/domain/geometry";
import { nodeSchema } from "../src/domain/node";
import { currentPageOnly } from "../src/domain/pages";
import type { Interaction, PrototypeAction } from "../src/domain/prototype";
import { findLayer } from "../src/domain/scene-index";
import { subtreeIds } from "../src/domain/tree";

export const sessionTabSummarySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["home", "file", "example"]),
  title: z.string(),
  fileKey: z.string().optional(),
  active: z.boolean(),
});
export type SessionTabSummary = z.infer<typeof sessionTabSummarySchema>;
const nodeId = nodeSchema.shape.id.optional();
export const renderArtboardPreviewSchema = z.object({
  nodeId,
  scale: z.number().min(0.25).max(4).default(1),
});
export type RenderArtboardPreviewInput = z.input<
  typeof renderArtboardPreviewSchema
>;
export const exportReactCodeSchema = z.object({
  nodeId,
  includeTokens: z.boolean().default(true),
  includeComponents: z.boolean().default(true),
});
export type ExportReactCodeInput = z.input<typeof exportReactCodeSchema>;
export const delegateDesignTaskSchema = z.object({
  prompt: z.string().trim().min(1).max(8000),
  mode: z.enum(["auto", "html", "blueprint"]).optional(),
  targetLibraryId: z.string().min(1).optional(),
  selectionId: nodeId,
});
export type DelegateDesignTaskInput = z.input<typeof delegateDesignTaskSchema>;
export type DelegateDesignRunner = (input: {
  prompt: string;
  document: DesignDocument;
  selection: string | null;
  generationMode?: DelegateDesignTaskInput["mode"];
  targetLibraryId?: string;
}) => Promise<{
  transaction?: Transaction;
  reply: string;
  toolTrace?: unknown[];
  diagnostics?: unknown[];
}>;

export function listOpenTabsView(
  tabs: readonly SessionTabSummary[],
  doc: DesignDocument,
  selection: string | null,
) {
  return {
    activeTabId: tabs.find((t) => t.active)?.id ?? null,
    tabs,
    document: {
      id: doc.id,
      name: doc.name,
      revision: doc.revision,
      activePage: doc.activePage ?? null,
      pageCount: doc.pages?.length ?? 1,
      nodeCount: doc.nodes.length,
    },
    selection,
  };
}

function requireNode(
  doc: DesignDocument,
  targetId: string,
  allowed: Set<string> | null,
) {
  if (allowed && !allowed.has(targetId))
    throw new Error("图层不在当前会话范围");
  const node = findLayer(doc, targetId);
  if (!node) throw new Error("当前画布没有可导出的画板或图层");
  return node;
}

export function scopedNode(node: DesignNode, allowed: Set<string> | null) {
  if (!allowed) return node;
  const inScope = (action: PrototypeAction) =>
    !("target" in action) || allowed.has(action.target);
  const rule = (interaction: Interaction) => ({
    ...interaction,
    actions: interaction.actions?.filter(inScope),
    otherwise: interaction.otherwise?.filter(inScope),
  });
  return {
    ...node,
    parentId:
      node.parentId && allowed.has(node.parentId) ? node.parentId : null,
    maskSourceId:
      node.maskSourceId && allowed.has(node.maskSourceId)
        ? node.maskSourceId
        : undefined,
    interaction: node.interaction && rule(node.interaction),
    interactions: node.interactions?.map(rule),
  };
}

function scopedDocument(doc: DesignDocument, ids: Set<string>) {
  return {
    ...currentPageOnly(doc),
    nodes: doc.nodes
      .filter((n) => ids.has(n.id))
      .map((n) => scopedNode(n, ids)),
  };
}

export function renderArtboardPreview(
  doc: DesignDocument,
  selection: string | null,
  allowed: Set<string> | null,
  input: unknown,
) {
  const { nodeId, scale } = renderArtboardPreviewSchema.parse(input);
  const targetId =
    nodeId ??
    selection ??
    doc.nodes.find((n) => !n.parentId && n.type !== "slice")?.id ??
    doc.nodes[0]?.id;
  if (!targetId) throw new Error("当前画布没有可导出的画板或图层");
  const node = requireNode(doc, targetId, allowed);
  // A slice serializes the entire scene behind its clip, including invisible off-slice text.
  const scene =
    allowed &&
    (node.type === "slice" ||
      Array.from(subtreeIds(doc, [targetId])).some((id) => !allowed.has(id)))
      ? scopedDocument(doc, allowed)
      : doc;
  const svg = exportNodeToSvg(scene, targetId, scale);
  const { width, height } = layoutBounds(doc).get(targetId) ?? node.style;
  return {
    nodeId: targetId,
    nodeName: node.name,
    width,
    height,
    scale,
    mimeType: "image/svg+xml" as const,
    svg,
    dataUrl: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg),
  };
}

// Older documents store named colors in doc.tokens. Project those into the
// compiler's token format using stable IDs and the CSS names used by DesignPage.
function tokenFiles(doc: DesignDocument) {
  if (doc.designSystem) return exportTokenFiles(doc);
  const system = emptyDesignSystem();
  const colors = Object.entries(doc.tokens);
  if (colors.length) {
    const collectionId = "legacy-colors";
    system.collections[collectionId] = {
      id: collectionId,
      name: "Imported colors",
      defaultModeId: "base",
      modes: [{ id: "base", name: "Base" }],
    };
    system.activeModes[collectionId] = "base";
    system.variables = Object.fromEntries(
      colors.map(([id, token]) => [
        id,
        {
          id,
          name: token.name,
          type: "color",
          collectionId,
          values: { base: token.value },
          description: "",
          codeSyntax: "--token-" + id,
          scopes: ["fill"],
        },
      ]),
    );
  }
  return exportTokenFiles({ ...doc, designSystem: system });
}

export function exportReactCode(
  doc: DesignDocument,
  selection: string | null,
  allowed: Set<string> | null,
  input: unknown,
) {
  const { nodeId, includeTokens, includeComponents } =
    exportReactCodeSchema.parse(input);
  const targetId = nodeId ?? selection ?? null;
  const target = targetId ? requireNode(doc, targetId, allowed) : null;
  const ids = target ? subtreeIds(doc, [target.id]) : allowed;
  if (ids && allowed && target) {
    for (const id of ids) if (!allowed.has(id)) ids.delete(id);
  }
  const unwrapped = unwrapSectionsAndSlices(
    ids ? scopedDocument(doc, ids) : doc,
  );
  const files: Record<string, string> = {};
  if (includeComponents)
    Object.assign(
      files,
      componentProjectFiles(unwrapped, (page) =>
        runtimeNodes(page, undefined, true),
      ),
    );
  files["src/DesignPage.tsx"] = exportInteractiveReact(unwrapped, false, true, {
    module: "DesignPage",
    files,
  });
  if (includeTokens) Object.assign(files, tokenFiles(unwrapped));
  const filePaths = Object.keys(files).sort();
  return {
    targetId: targetId ?? doc.activePage ?? "page",
    targetName: target?.name ?? doc.name,
    revision: doc.revision,
    files,
    filePaths,
    fileCount: filePaths.length,
  };
}

export async function runDelegatedDesignTask(
  doc: DesignDocument,
  selection: string | null,
  allowed: Set<string> | null,
  input: unknown,
  runner?: DelegateDesignRunner,
) {
  const parsed = delegateDesignTaskSchema.parse(input);
  const effectiveSelection = parsed.selectionId ?? selection;
  if (effectiveSelection !== null)
    requireNode(doc, effectiveSelection, allowed);
  else if (allowed) throw new Error("图层不在当前会话范围");
  if (!runner)
    throw Object.assign(
      new Error(
        "Forma 尚未配置 AI 模型，请先在 Forma 模型配置中连接供应商；只读查询、画板出图、React 导出与直接提交事务仍可离线使用",
      ),
      { status: 503 },
    );
  const result = await runner({
    prompt: parsed.prompt,
    document: doc,
    selection: effectiveSelection,
    generationMode: parsed.mode,
    targetLibraryId: parsed.targetLibraryId,
  });
  const transaction =
    result.transaction &&
    validateProposal(
      { document: doc, selection: effectiveSelection, prompt: parsed.prompt },
      result.transaction,
    );
  return {
    transaction,
    reply: result.reply,
    toolTrace: result.toolTrace ?? [],
    diagnostics: result.diagnostics ?? [],
    selection: effectiveSelection,
  };
}
