import { fontAssets } from "./fonts";
import { z } from "zod";
import { designSystemSchema } from "./design-system-schema";
import { validateDesignSystem } from "./design-system";
import { nodeSchema, validateLayerGeometry } from "./node";
import { imageAssets } from "./images";

const id = z.string().min(1).max(128);
export const assetTierSchema = z.enum(["page", "block", "component"]);
export type AssetTier = z.infer<typeof assetTierSchema>;

export const componentAiHintsSchema = z.object({
  whenToUse: z.string().max(500).optional(),
  avoidWhen: z.string().max(500).optional(),
  tags: z.array(z.string().max(40)).max(16).optional(),
  maxTextChars: z.number().int().positive().max(2000).optional(),
  slotsNote: z.string().max(500).optional(),
});
export type ComponentAiHints = z.infer<typeof componentAiHintsSchema>;

export const libraryAiGuideSchema = z.object({
  summary: z.string().max(1000).optional(),
  platform: z.string().max(80).optional(),
  visualPrinciples: z.array(z.string().max(240)).max(20).optional(),
  compositionRules: z.array(z.string().max(240)).max(20).optional(),
  exceptionPatterns: z.array(z.string().max(240)).max(20).optional(),
  playbookMarkdown: z.string().max(64_000).optional(),
  generatedAt: z.string().max(64).optional(),
  revision: z.number().int().nonnegative().optional(),
});
export type LibraryAiGuide = z.infer<typeof libraryAiGuideSchema>;

export const exposedProperty = z.object({
  id,
  name: z.string().trim().min(1).max(100),
  previousNames: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  kind: z.enum(["text", "visible", "swap"]),
  target: id,
});
export type ExposedProperty = z.infer<typeof exposedProperty>;
export const librarySchema = z.object({
  format: z.literal("forma/library"),
  version: z.literal(1),
  id,
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  revision: z.number().int().nonnegative(),
  images: imageAssets.optional(),
  fonts: fontAssets.optional(),
  designSystem: designSystemSchema.optional(),
  aiGuide: libraryAiGuideSchema.optional(),
  source: z.object({
    name: z.string().max(200),
    url: z.url().optional(),
    license: z.string().max(2000),
  }),
  components: z
    .array(
      z.object({
        id,
        name: z.string().min(1).max(200),
        category: z.string().min(1).max(200),
        assetTier: assetTierSchema.optional(),
        aiHints: componentAiHintsSchema.optional(),
        exposed: z.array(exposedProperty).max(100).optional(),
        master: z.object({ documentId: id, nodeId: id }).optional(),
        description: z.string().max(2000),
        variants: z
          .array(
            z.object({
              id,
              name: z.string().min(1).max(200),
              masterNodeId: id.optional(),
              properties: z.record(id, z.string().max(200)),
              nodes: z.array(nodeSchema).min(1).max(1000),
            }),
          )
          .min(1)
          .max(200),
      }),
    )
    .min(1)
    .max(4096),
});
export type ComponentLibrary = z.infer<typeof librarySchema>;
export type LibraryComponent = ComponentLibrary["components"][number];
export type ComponentVariant = LibraryComponent["variants"][number];

/** Libraries are portable, immutable snapshots. No network assets or implicit references. */
export function validateLibrary(library: ComponentLibrary) {
  const componentIds = new Set<string>();
  let total = 0;
  for (const c of library.components) {
    const firstRoot = c.variants[0].nodes.find((n) => n.parentId === null);
    if (componentIds.has(c.id)) throw new Error("组件 ID 重复");
    componentIds.add(c.id);
    const props = c.exposed ?? [];
    const names = props.flatMap((p) => [p.name, ...(p.previousNames ?? [])]);
    if (
      new Set(props.map((p) => p.id)).size !== props.length ||
      new Set(names).size !== names.length
    )
      throw Error("组件属性名称或 ID 重复");
    for (const p of props)
      if (
        !c.variants.some((v) =>
          v.nodes.some(
            (n) =>
              n.templateKey === p.target &&
              (p.kind !== "swap" || !!n.nestedSlot) &&
              (p.kind !== "text" || n.type === "text" || n.type === "button"),
          ),
        )
      )
        throw Error("组件属性缺少目标图层：" + p.name);
    const variants = new Set<string>();
    const drawings = new Set(c.master ? [c.master.nodeId] : []);
    for (const v of c.variants) {
      if (v.masterNodeId) {
        if (!c.master || drawings.has(v.masterNodeId) || v === c.variants[0])
          throw Error("变体主组件图层链接无效或重复");
        drawings.add(v.masterNodeId);
      }
      const root = v.nodes.find((n) => n.parentId === null);
      if (
        root?.type !== firstRoot?.type ||
        root?.templateKey !== firstRoot?.templateKey
      )
        throw new Error("同一组件的根类型与模板键必须一致");
      if (variants.has(v.id)) throw new Error("变体 ID 重复");
      variants.add(v.id);
      total += v.nodes.length;
      if (total > 50000) throw new Error("组件库超过 50000 图层，请拆分导入");
      if (library.designSystem)
        validateDesignSystem({
          schemaVersion: 1,
          id: library.id,
          name: library.name,
          revision: library.revision,
          tokens: {},
          nodes: v.nodes,
          designSystem: library.designSystem,
        });
      const nodes = new Map(v.nodes.map((n) => [n.id, n]));
      if (nodes.size !== v.nodes.length) throw new Error("模板图层 ID 重复");
      if (v.nodes.filter((n) => n.parentId === null).length !== 1)
        throw new Error("每个变体必须只有一个根图层");
      const keys = new Set<string>();
      for (const n of v.nodes) {
        validateLayerGeometry(n, nodes);
        if (n.image && !library.images?.[n.image.assetId])
          throw new Error("组件库缺少图像资源");
        if (
          n.fillToken ||
          n.instance ||
          (!library.designSystem &&
            (n.variableBindings || n.variableModes || n.styleBindings))
        )
          throw new Error("组件模板必须自包含，不能引用外部变量或实例");
        if (!n.templateKey || keys.has(n.templateKey))
          throw new Error("模板键缺失或重复");
        keys.add(n.templateKey);
        const seen = new Set([n.id]);
        let parentId = n.parentId;
        while (parentId !== null) {
          if (seen.has(parentId) || seen.size > 256)
            throw new Error("组件层级成环或过深");
          seen.add(parentId);
          const parent = nodes.get(parentId);
          if (!parent || !["frame", "group"].includes(parent.type))
            throw new Error("组件父图层无效");
          parentId = parent.parentId;
        }
      }
    }
  }
}
export function parseLibrary(input: unknown): ComponentLibrary {
  const library = librarySchema.parse(input);
  validateLibrary(library);
  return library;
}
