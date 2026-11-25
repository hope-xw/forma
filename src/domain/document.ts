import { maxPageNodes } from "./document-limits";
import {
  assetByteLength,
  maxDocumentAssetBytes,
  maxAssetBytes,
} from "./asset-bytes";
import { materializeSlots } from "./component-slots";
import { fontAssets } from "./fonts";
import { designSystemSchema } from "./design-system-schema";
import { validateDesignSystem } from "./design-system";
import { z } from "zod";
import { imageAssets } from "./images";
import { nodeSchema, validateLayerGeometry } from "./node";
import { librarySchema, validateLibrary } from "./library-schema";
export {
  nodeSchema,
  styleSchema,
  layoutGuideSchema,
  exportSettingSchema,
  annotationSchema,
  defaultStyle,
  createNode,
} from "./node";
export type {
  DesignNode,
  NodeStyle,
  LayoutGuide,
  ExportSetting,
  Annotation,
} from "./node";
const id = z.string().min(1).max(128);
const guidesSchema = z
  .array(z.object({ id, axis: z.enum(["x", "y"]), value: z.number().finite() }))
  .max(1000)
  .refine(
    (list) => new Set(list.map((g) => g.id)).size === list.length,
    "辅助线 ID 重复",
  );
export type Guide = z.infer<typeof guidesSchema>[number];
export const commentReplySchema = z.object({
  id,
  author: z.string().min(1).max(80),
  text: z.string().min(1).max(4000),
  createdAt: z.string().max(64),
});
export const commentSchema = z.object({
  id,
  x: z.number().finite(),
  y: z.number().finite(),
  nodeId: id.optional(),
  author: z.string().min(1).max(80).default("设计师"),
  text: z.string().min(1).max(4000),
  createdAt: z.string().max(64),
  resolved: z.boolean().default(false),
  replies: z.array(commentReplySchema).max(100).default([]),
});
export const commentsSchema = z
  .array(commentSchema)
  .max(500)
  .refine(
    (list) => new Set(list.map((c) => c.id)).size === list.length,
    "评论 ID 重复",
  );
export type CommentReply = z.infer<typeof commentReplySchema>;
export type DesignComment = z.infer<typeof commentSchema>;
const pageBackgroundFields = {
  pageBackground: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  pageBackgroundOpacity: z.number().min(0).max(1).optional(),
  pageBackgroundVisible: z.boolean().optional(),
};
const importIssue = z.object({
  node: z.string().max(4096),
  detail: z.string().max(8192),
  count: z.number().int().positive().optional(),
});
export type ImportIssue = z.infer<typeof importIssue>;
export const importReportSchema = z.object({
  version: z.literal(1),
  format: z.enum(["Sketch", "Figma"]),
  filename: z.string().max(1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceNodes: z.number().int().nonnegative(),
  issues: z.array(importIssue).max(500_000),
});
export type ImportReport = z.infer<typeof importReportSchema>;
export const documentSchema = z.object({
  importReport: importReportSchema.optional(),
  schemaVersion: z.literal(1),
  id,
  name: z.string().min(1).max(200),
  revision: z.number().int().nonnegative(),
  colorProfile: z.enum(["srgb", "display-p3"]).optional(),
  exportColorProfile: z.enum(["srgb", "display-p3"]).optional(),
  activePage: id.optional(),
  ...pageBackgroundFields,
  guides: guidesSchema.optional(),
  comments: commentsSchema.optional(),
  pages: z
    .array(
      z.object({
        id,
        name: z.string().trim().min(1).max(120),
        ...pageBackgroundFields,
        guides: guidesSchema.optional(),
        comments: commentsSchema.optional(),
        nodes: z.array(nodeSchema).max(maxPageNodes).optional(),
      }),
    )
    .min(1)
    .max(100)
    .optional(),
  nodes: z.array(nodeSchema).max(maxPageNodes),
  images: imageAssets.optional(),
  fonts: fontAssets.optional(),
  designSystem: designSystemSchema.optional(),
  libraries: z.record(id, librarySchema).optional(),
  tokens: z.record(
    id,
    z.object({
      name: z.string(),
      value: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    }),
  ),
});
export type DesignDocument = z.infer<typeof documentSchema>;
/** Resource bytes are immutable strings. Clone editable metadata without copying hundreds of MiB through structuredClone. */
export function cloneDocument(doc: DesignDocument): DesignDocument {
  const { images, fonts, libraries, ...rest } = doc;
  function assets<T extends { data: string }>(table: Record<string, T>) {
    return Object.fromEntries(
      Object.entries(table).map(([id, { data, ...fields }]) => [
        id,
        { ...structuredClone(fields), data } as T,
      ]),
    );
  }
  const copy: DesignDocument = structuredClone(rest);
  if (images) copy.images = assets(images);
  if (fonts) copy.fonts = assets(fonts);
  if (libraries)
    copy.libraries = Object.fromEntries(
      Object.entries(libraries).map(([key, { images, fonts, ...spec }]) => [
        key,
        {
          ...structuredClone(spec),
          ...(images ? { images: assets(images) } : {}),
          ...(fonts ? { fonts: assets(fonts) } : {}),
        },
      ]),
    );
  return copy;
}
export type PageRecord = NonNullable<DesignDocument["pages"]>[number];
export function parseDocument(input: unknown): DesignDocument {
  const doc = documentSchema.parse(input);
  const resources = new Map<string, string>();
  let assetBytes = 0;
  for (const scope of [doc, ...Object.values(doc.libraries ?? {})]) {
    for (const table of [scope.images, scope.fonts])
      for (const [id, asset] of Object.entries(table ?? {})) {
        const existing = resources.get(id);
        if (existing !== undefined) {
          if (existing !== asset.data)
            throw Error("同一资源 ID 的内容不一致：" + id);
          continue;
        }
        resources.set(id, asset.data);
        const length = assetByteLength(asset.data);
        if (length > maxAssetBytes) throw Error("单个资源超过 32 MiB：" + id);
        assetBytes += length;
        if (assetBytes > maxDocumentAssetBytes)
          throw Error("文件的独立图片与字体总量超过 256 MiB");
      }
  }
  if (doc.pages || doc.activePage) {
    const pages = doc.pages ?? [];
    if (
      new Set(pages.map((page) => page.id)).size !== pages.length ||
      !pages.some((page) => page.id === doc.activePage)
    )
      throw new Error("页面目录无效");
    const identifiers = new Set(doc.nodes.map((node) => node.id));
    for (const page of pages) {
      if (page.id === doc.activePage) {
        if (
          page.nodes ||
          page.guides ||
          page.comments ||
          page.pageBackground !== undefined ||
          page.pageBackgroundOpacity !== undefined ||
          page.pageBackgroundVisible !== undefined
        )
          throw new Error("活动页面内容重复");
      } else {
        if (!page.nodes) throw new Error("页面缺少图层");
        for (const node of page.nodes) {
          if (identifiers.has(node.id)) throw new Error("跨页图层 ID 重复");
          identifiers.add(node.id);
        }
        validatePage({ ...doc, nodes: page.nodes });
      }
    }
  }
  validatePage(doc);
  for (const [key, library] of Object.entries(doc.libraries ?? {})) {
    if (key !== library.id) throw new Error("组件库 ID 不一致");
    validateLibrary(library);
  }
  return doc;
}
function validatePage(doc: DesignDocument) {
  const nodes = new Map(doc.nodes.map((node) => [node.id, node]));
  if (nodes.size !== doc.nodes.length) throw new Error("图层 ID 重复");
  for (const node of doc.nodes) {
    validateLayerGeometry(node, nodes);
    if (node.image && !doc.images?.[node.image.assetId])
      throw new Error("图层缺少图像资源：" + node.name);
    if (node.fillToken && !doc.tokens[node.fillToken])
      throw new Error("颜色变量引用不存在");
    if (node.type === "section" && node.parentId !== null) {
      const directParent = nodes.get(node.parentId);
      if (!directParent || directParent.type !== "section")
        throw new Error("分区只能位于画布顶层或其他分区内");
    }
    const seen = new Set([node.id]);
    let parentId = node.parentId;
    while (parentId !== null) {
      if (seen.has(parentId)) throw new Error("图层层级不能成环");
      seen.add(parentId);
      if (seen.size > 256) throw new Error("图层嵌套超过 256 层");
      const parent = nodes.get(parentId);
      if (!parent || !["frame", "group", "section"].includes(parent.type))
        throw new Error("父图层必须是存在的 Frame、Group 或 Section");
      parentId = parent.parentId;
    }
  }
  for (const node of doc.nodes)
    if (node.instance) {
      const { libraryId, componentId, variantId } = node.instance;
      const component = doc.libraries?.[libraryId]?.components.find(
        (c) => c.id === componentId,
      );
      const v = component?.variants.find((v) => v.id === variantId);
      if (!v) throw new Error("组件实例引用不存在");
      if (node.instance.slots) materializeSlots(doc, v, node.instance.slots);
    }
  validateDesignSystem(doc, nodes);
  return doc;
}
