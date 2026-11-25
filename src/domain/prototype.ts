import { z } from "zod";
import type { DesignDocument, DesignNode } from "./document";
const id = z.string().min(1).max(128);
const value = z.union([
  z.string().max(10000),
  z.number().finite(),
  z.boolean(),
]);
export const transitionSchema = z.object({
  type: z.enum([
    "instant",
    "dissolve",
    "move-in",
    "push",
    "slide-in",
    "smart-animate",
  ]),
  direction: z.enum(["left", "right", "top", "bottom"]).optional(),
  duration: z.number().nonnegative().finite().optional(),
  easing: z.enum(["linear", "ease-out", "ease-in-out"]).optional(),
});
export const actionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("navigate"),
    transition: transitionSchema.optional(),
    target: id,
    resetScroll: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("overlay"),
    transition: transitionSchema.optional(),
    target: id,
    position: z.enum(["center", "bottom"]),
  }),
  z.object({
    kind: z.literal("openLink"),
    url: z.url({ protocol: /^https?$/ }).regex(/^https?:\/\//i),
  }),
  z.object({ kind: z.literal("back") }),
  z.object({ kind: z.literal("close") }),
  z.object({ kind: z.literal("reset") }),
  z.object({ kind: z.literal("scrollTo"), target: id }),
  z.object({ kind: z.literal("control"), target: id, value }),
  z.object({ kind: z.literal("set"), variable: id, value }),
  z.object({ kind: z.literal("input"), variable: id }),
  z.object({ kind: z.literal("toggle"), variable: id }),
]);
const sequence = z.array(actionSchema).max(64);
export const interactionSchema = z.object({
  trigger: z.enum(["click", "hover", "delay"]).optional(),
  delayMs: z.number().int().min(0).max(2147483647).optional(),
  flow: z.string().trim().min(1).max(100).optional(),
  scroll: z.enum(["vertical", "horizontal", "both"]).optional(),
  condition: z
    .object({
      variable: id,
      operator: z.enum(["equals", "different", "greater", "less"]),
      value,
    })
    .optional(),
  actions: sequence.optional(),
  otherwise: sequence.optional(),
});
export type Interaction = z.infer<typeof interactionSchema>;
export type PrototypeAction = z.infer<typeof actionSchema>;

/** Return all interaction rules on a node (legacy single `interaction` plus multi-trigger `interactions`). */
export function nodeInteractions(node: DesignNode): Interaction[] {
  const list: Interaction[] = [];
  if (node.interaction) list.push(node.interaction);
  if (node.interactions?.length) list.push(...node.interactions);
  return list;
}

/** True for top-level screen frames, including frames organized directly or transitively inside sections. */
export function isSceneFrame(
  node: DesignNode,
  byId: ReadonlyMap<string, DesignNode>,
): boolean {
  if (node.type !== "frame") return false;
  let parentId = node.parentId;
  const seen = new Set<string>([node.id]);
  while (parentId !== null) {
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent || parent.type !== "section") return false;
    parentId = parent.parentId;
  }
  return true;
}

export function remapInteraction(
  node: DesignNode,
  ids: Map<string, string>,
  variables?: Map<string, string>,
) {
  const rules = nodeInteractions(node);
  if (!rules.length) return;
  const variable = (id: string) => variables?.get(id) ?? id;
  for (const rule of rules) {
    if (rule.condition)
      rule.condition.variable = variable(rule.condition.variable);
    for (const action of [...(rule.actions ?? []), ...(rule.otherwise ?? [])]) {
      if ("target" in action)
        action.target = ids.get(action.target) ?? action.target;
      if ("variable" in action) action.variable = variable(action.variable);
    }
  }
}
/** Follow only linked foreign artboards, including links that return to an earlier page. */
export function linkedPrototypeScene(doc: DesignDocument): DesignDocument {
  if (!doc.pages?.some((p) => p.nodes?.length)) return doc;
  const otherRoots = new Map<string, DesignNode>();
  const children = new Map<string, DesignNode[]>();
  for (const page of doc.pages) {
    const pageNodes = page.nodes ?? [];
    const pageById = new Map(pageNodes.map((n) => [n.id, n]));
    for (const n of pageNodes) {
      if (!n.parentId || isSceneFrame(n, pageById)) otherRoots.set(n.id, n);
      if (n.parentId) {
        const list = children.get(n.parentId) ?? [];
        list.push(n);
        children.set(n.parentId, list);
      }
    }
  }
  const included = new Set<string>();
  const nodes = doc.nodes.slice();
  function include(n: DesignNode, detachRoot = false) {
    nodes.push(detachRoot && n.parentId ? { ...n, parentId: null } : n);
    for (const child of children.get(n.id) ?? []) include(child, false);
  }
  for (const n of nodes) {
    const rules = nodeInteractions(n);
    if (!rules.length) continue;
    for (const rule of rules)
      for (const branch of [rule.actions, rule.otherwise])
        for (const action of branch ?? []) {
          if (action.kind !== "navigate" && action.kind !== "overlay") continue;
          const root = otherRoots.get(action.target);
          if (root && !included.has(root.id)) {
            included.add(root.id);
            include(root, true);
          }
        }
  }
  if (!included.size) return doc;
  const { pages: _pages, activePage: _active, ...page } = doc;
  return { ...page, nodes };
}

/** Keep incomplete links editable and surface them before preview or handoff. */
export function prototypeIssues(doc: DesignDocument): string[] {
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  const foreignBoards = new Map<
    string,
    { node: DesignNode; map: ReadonlyMap<string, DesignNode> }
  >();
  for (const p of doc.pages ?? []) {
    const list = p.nodes ?? [];
    const map = new Map(list.map((n) => [n.id, n]));
    for (const n of list) {
      if (n.parentId === null || isSceneFrame(n, map))
        foreignBoards.set(n.id, { node: n, map });
    }
  }
  const issues: string[] = [];
  for (const n of doc.nodes) {
    const rules = nodeInteractions(n);
    if (!rules.length) continue;
    const issue = (message: string) => issues.push(n.name + " · " + message);
    for (const rule of rules) {
      if (rule.flow && !isSceneFrame(n, nodes)) issue("流程起点必须是顶层画板");
      const variable = (id: string, v?: string | number | boolean) => {
        const token = doc.designSystem?.variables[id];
        if (!token) issue("缺少变量 " + id);
        else if (
          v !== undefined &&
          (token.type === "color"
            ? typeof v !== "string" || !/^#[\da-f]{6}$/i.test(v)
            : typeof v !== token.type)
        )
          issue("变量值类型不匹配");
        return token;
      };
      if (rule.condition) {
        const t = variable(rule.condition.variable, rule.condition.value);
        if (
          ["greater", "less"].includes(rule.condition.operator) &&
          t?.type !== "number"
        )
          issue("大小比较需要数值变量");
      }
      for (const a of [...(rule.actions ?? []), ...(rule.otherwise ?? [])]) {
        if ("variable" in a) {
          const token = variable(
            a.variable,
            a.kind === "set" ? a.value : undefined,
          );
          if (a.kind === "toggle" && token?.type !== "boolean")
            issue("切换需要布尔变量");
          if (a.kind === "input") {
            const inputType = n.control ? typeof n.control.value : "boolean";
            if (token && token.type !== inputType)
              issue("控件与变量类型不匹配");
          }
        }
        if ("target" in a) {
          const local = nodes.get(a.target);
          const foreign =
            !local && (a.kind === "overlay" || a.kind === "navigate")
              ? foreignBoards.get(a.target)
              : undefined;
          const target = local ?? foreign?.node;
          const targetMap = local ? nodes : foreign?.map;
          if (!target) issue("目标图层已删除");
          else if (
            (a.kind === "overlay" || a.kind === "navigate") &&
            (!targetMap || !isSceneFrame(target, targetMap) || target.hidden)
          )
            issue("目标必须是可见的顶层画板");
          else if (
            a.kind === "control" &&
            (!target.control || typeof target.control.value !== typeof a.value)
          )
            issue("控件目标或值类型无效");
        }
      }
    }
  }
  return issues;
}
