import { z } from "zod";
import { parseDocument, type DesignDocument } from "../domain/document";
import { transactionSchema, transact } from "../domain/commands";
import { extractJsonPayload } from "./adapters";
export const generationSchema = z.object({
  prompt: z.string().trim().min(1).max(8000),
  document: z.unknown(),
  selection: z.string().nullable(),
});
export type Transaction = z.infer<typeof transactionSchema>;
export interface GenerationContext {
  prompt: string;
  document: DesignDocument;
  selection: string | null;
}
export interface ModelProvider {
  generate(context: GenerationContext, signal: AbortSignal): Promise<unknown>;
}

export function validateProposal(
  context: GenerationContext,
  input: unknown,
): Transaction {
  return validateProposalSnapshot(context, input).transaction;
}

export function validateProposalSnapshot(
  context: GenerationContext,
  input: unknown,
) {
  const proposal = transactionSchema.parse(input);
  const before = parseDocument(context.document);
  const after = transact(before, proposal);
  if (context.selection) {
    if (!before.nodes.some((n) => n.id === context.selection))
      throw new Error("选区已不存在");
    const allowed = new Set([context.selection]);
    if (
      JSON.stringify(before.images) !== JSON.stringify(after.images) ||
      JSON.stringify(before.fonts) !== JSON.stringify(after.fonts) ||
      JSON.stringify(before.pages) !== JSON.stringify(after.pages) ||
      JSON.stringify(before.guides) !== JSON.stringify(after.guides)
    )
      throw new Error("Agent 修改超出当前选区");
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of before.nodes)
        if (n.parentId && allowed.has(n.parentId) && !allowed.has(n.id)) {
          allowed.add(n.id);
          changed = true;
        }
    }
    if (JSON.stringify(before.libraries) !== JSON.stringify(after.libraries))
      throw new Error("选区任务不能修改组件库");
    if (
      JSON.stringify(before.designSystem) !== JSON.stringify(after.designSystem)
    )
      throw new Error("选区任务不能修改全局设计系统");
    if (JSON.stringify(before.tokens) !== JSON.stringify(after.tokens))
      throw new Error("选区任务不能修改全局变量");
    const outside = before.nodes
      .filter((n) => !allowed.has(n.id))
      .map((n) => n.id);
    if (
      JSON.stringify(outside) !==
      JSON.stringify(
        after.nodes
          .filter(
            (n) =>
              !allowed.has(n.id) && before.nodes.some((p) => p.id === n.id),
          )
          .map((n) => n.id),
      )
    )
      throw new Error("Agent 排序超出当前选区");
    const previous = new Map(before.nodes.map((n) => [n.id, n]));
    const next = new Map(after.nodes.map((n) => [n.id, n]));
    for (const node of before.nodes)
      if (
        !allowed.has(node.id) &&
        JSON.stringify(node) !== JSON.stringify(next.get(node.id))
      )
        throw new Error("Agent 修改超出当前选区");
    for (const node of after.nodes)
      if (!previous.has(node.id)) {
        let parent = node.parentId;
        const visited = new Set<string>();
        while (parent && !allowed.has(parent) && !visited.has(parent)) {
          visited.add(parent);
          parent = next.get(parent)?.parentId ?? null;
        }
        if (!parent || !allowed.has(parent))
          throw new Error("新增图层必须位于选区内");
      }
    const selected = next.get(context.selection);
    if (
      selected &&
      selected.parentId !== previous.get(context.selection)?.parentId
    )
      throw new Error("不能把选区移出原容器");
    for (const n of after.nodes)
      if (allowed.has(n.id) && n.id !== context.selection) {
        let p = n.parentId;
        while (p && p !== context.selection) p = next.get(p)?.parentId ?? null;
        if (!p) throw new Error("不能把子层移出选区");
      }
  }
  return { transaction: proposal, document: after };
}

export class CompatibleProvider implements ModelProvider {
  constructor(
    private config: { baseUrl: string; apiKey: string; model: string },
    private request: typeof fetch = fetch,
  ) {}
  async generate(context: GenerationContext, signal: AbortSignal) {
    const endpoint = new URL(
      this.config.baseUrl.replace(/\/$/, "") + "/chat/completions",
    );
    if (!["http:", "https:"].includes(endpoint.protocol))
      throw new Error("模型服务地址协议无效");
    const response = await this.request(endpoint, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          {
            role: "system",
            content: [
              "You are a professional UI designer. Return only one JSON transaction satisfying the schema below. Never return code or markdown.",
              "Use the current document revision. Preserve existing edits. Modify only the selected subtree if selection is provided.",
              "Create editable native nodes with unique IDs. Use balanced spacing, hierarchy, clear Chinese copy, and existing color tokens. Respect supported node and style types.",
              "You may only express features the schema supports. Do not claim unsupported interactions or assets are implemented.",
              "Prefer insertComponent operations for components in componentCatalog. Use its exact library/component/variant IDs. Position is in document world coordinates. Definitions are already installed; do not emit putLibrary. Instances have protected structure: change text and appearance only inside them. Move/copy whole instances or use switchInstance. Never remove/reparent/reorder internal layers, modify their geometry, or strip instance/templateKey metadata. Use detachInstance only when the user explicitly requests detaching. Do not redraw library components as approximations.",
              JSON.stringify(z.toJSONSchema(transactionSchema)),
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              ...context,
              document: {
                ...context.document,
                pages: context.document.pages?.map(({ id, name }) => ({
                  id,
                  name,
                })),
                libraries: undefined,
                images: Object.fromEntries(
                  Object.entries(context.document.images ?? {}).map(
                    ([id, { name, width, height }]) => [
                      id,
                      { name, width, height },
                    ],
                  ),
                ),
              },
              componentCatalog: Object.values(
                context.document.libraries ?? {},
              ).map((library) => ({
                id: library.id,
                name: library.name,
                components: library.components.map((component) => ({
                  id: component.id,
                  name: component.name,
                  category: component.category,
                  variants: component.variants.map((variant) => ({
                    id: variant.id,
                    properties: variant.properties,
                    width: variant.nodes.find((n) => !n.parentId)?.style.width,
                    height: variant.nodes.find((n) => !n.parentId)?.style
                      .height,
                  })),
                })),
              })),
            }),
          },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok)
      throw new Error(
        `模型服务请求失败（HTTP ${response.status}），请检查配置或额度`,
      );
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("模型未返回设计事务");
    if (content.length > 2_000_000) throw new Error("模型输出超过大小限制");
    return extractJsonPayload(content);
  }
}
