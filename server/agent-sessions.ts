import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import {
  parseDocument,
  type DesignDocument,
  type DesignNode,
} from "../src/domain/document";
import { checkDesigns, type LintIssue } from "../src/domain/design-lint";
import {
  effectiveModes,
  resolveVariable,
  resolveNode,
} from "../src/domain/design-system";
import { layoutBounds } from "../src/domain/geometry";
import { fillUsesTextColor, nodeSchema } from "../src/domain/node";
import { paintVariables } from "../src/domain/paint-bindings";
import {
  nodeInteractions,
  type Interaction,
  type PrototypeAction,
} from "../src/domain/prototype";
import { findLayer, indexPublishedScene } from "../src/domain/scene-index";
import { subtreeIds } from "../src/domain/tree";
import {
  validateProposal,
  type GenerationContext,
  type Transaction,
} from "../src/agent/provider";
type RequestBody = () => Promise<unknown>;
interface Session {
  context: GenerationContext;
  editor: string;
  lastUsed: number;
  proposal?: { id: string; transaction: Transaction };
}
const sessions = new Map<string, Session>();
const expires = 30 * 60 * 1000;
const token = () => randomBytes(24).toString("base64url");
const querySchema = z.string().max(1000).optional();
const nodeId = nodeSchema.shape.id;
export const sessionToolSchemas = {
  "search-nodes": z.object({
    query: querySchema,
    types: z.array(nodeSchema.shape.type).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  "node-details": z.object({
    ids: z.array(nodeId).min(1).max(200),
    includeChildren: z.boolean().optional(),
  }),
  "design-system": z.object({
    kind: z.enum(["all", "variables", "styles", "collections"]).optional(),
    query: querySchema,
  }),
  lint: z.object({ rootId: nodeId.optional() }),
};

function visibleDetail(node: DesignNode, allowed: Set<string> | null) {
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

function searchNodes(
  document: DesignDocument,
  allowed: Set<string> | null,
  input: unknown,
) {
  const {
    query,
    types,
    limit = 40,
  } = sessionToolSchemas["search-nodes"].parse(input);
  const term = query?.trim().toLowerCase();
  const nodes = [];
  for (const n of document.nodes) {
    if (
      (allowed && !allowed.has(n.id)) ||
      (types?.length && !types.includes(n.type))
    )
      continue;
    const resolved = resolveNode(document, n);
    if (
      term &&
      ![
        n.name,
        n.id,
        resolved.text,
        n.type,
        n.instance?.componentId,
        n.instance?.variantId,
        n.instance?.libraryId,
      ].some((value) => value?.toLowerCase().includes(term))
    )
      continue;
    const path = [n.name];
    let parent = n.parentId;
    while (parent && (!allowed || allowed.has(parent))) {
      const ancestor = findLayer(document, parent);
      if (!ancestor) break;
      path.unshift(ancestor.name);
      parent = ancestor.parentId;
    }
    const { width, height, layout } = resolved.style;
    nodes.push({
      id: n.id,
      name: n.name,
      type: n.type,
      text: resolved.text.slice(0, 200),
      path,
      width,
      height,
      layout,
      instance: n.instance,
    });
    if (nodes.length === limit) break;
  }
  return { nodes };
}

function designSystemView(
  doc: DesignDocument,
  selection: string | null,
  allowed: Set<string> | null,
  input: unknown,
) {
  const { kind = "all", query } =
    sessionToolSchemas["design-system"].parse(input);
  const matches = (id: string, name: string) =>
    !query ||
    (id + " " + name).toLowerCase().includes(query.trim().toLowerCase());
  const sys = doc.designSystem;
  const variables = new Set<string>(),
    styles = new Set<string>(),
    collections = new Set<string>(),
    tokens = new Set<string>();
  if (allowed) {
    for (const id of allowed) {
      const node = findLayer(doc, id);
      if (!node) continue;
      for (const value of Object.values(node.variableBindings ?? {}))
        variables.add(value);
      for (const { id } of paintVariables(node.style)) variables.add(id);
      for (const value of Object.values(node.styleBindings ?? {}))
        styles.add(value);
      for (const id of Object.keys(node.variableModes ?? {}))
        collections.add(id);
      for (const rule of nodeInteractions(node)) {
        if (rule.condition) variables.add(rule.condition.variable);
        for (const action of [
          ...(rule.actions ?? []),
          ...(rule.otherwise ?? []),
        ])
          if ("variable" in action) variables.add(action.variable);
      }
      if (node.fillToken) tokens.add(node.fillToken);
    }
    for (const id of styles) {
      const style = sys?.styles[id];
      if (!style) continue;
      for (const value of Object.values(style.bindings)) variables.add(value);
      for (const { id } of paintVariables(style.properties)) variables.add(id);
    }
    // Set iteration also visits newly found aliases; shared/cyclic references terminate.
    for (const id of variables) {
      const variable = sys?.variables[id];
      if (!variable) continue;
      collections.add(variable.collectionId);
      for (const value of Object.values(variable.values))
        if (typeof value === "object") variables.add(value.alias);
    }
  }
  const modes = effectiveModes(doc, findLayer(doc, selection));
  const includeVars = kind === "all" || kind === "variables";
  const legacy = includeVars
    ? Object.entries(doc.tokens)
        .filter(
          ([id, v]) => (!allowed || tokens.has(id)) && matches(id, v.name),
        )
        .map(([id, v]) => ({
          id,
          name: v.name,
          type: "color",
          scopes: ["fill"],
          resolvedValue: v.value,
          source: "token",
        }))
    : [];
  return {
    variables: [
      ...(includeVars && sys
        ? Object.values(sys.variables)
            .filter(
              (v) => (!allowed || variables.has(v.id)) && matches(v.id, v.name),
            )
            .map((v) => ({
              ...v,
              resolvedValue: resolveVariable(sys, v.id, modes),
            }))
        : []),
      ...legacy,
    ],
    styles:
      kind === "all" || kind === "styles"
        ? Object.values(sys?.styles ?? {}).filter(
            (s) => (!allowed || styles.has(s.id)) && matches(s.id, s.name),
          )
        : [],
    collections:
      kind === "all" || kind === "collections"
        ? Object.values(sys?.collections ?? {})
            .filter(
              (c) =>
                (!allowed || collections.has(c.id)) && matches(c.id, c.name),
            )
            .map((c) => ({
              ...c,
              activeModeId: modes[c.id] ?? c.defaultModeId,
            }))
        : [],
  };
}

function lintDesign(
  doc: DesignDocument,
  selection: string | null,
  allowed: Set<string> | null,
  input: unknown,
) {
  const { rootId = selection } = sessionToolSchemas.lint.parse(input);
  if (
    rootId !== null &&
    (!findLayer(doc, rootId) || (allowed && !allowed.has(rootId)))
  )
    throw new Error("图层不在当前会话范围");
  const ids = rootId !== null ? subtreeIds(doc, [rootId]) : null;
  // Reuse the editor's contrast calculation, including inherited backgrounds
  // and local variable modes. Keep global token-matching suggestions private.
  type Issue = Pick<
    LintIssue,
    "id" | "message" | "nodeId" | "nodeName" | "contrast" | "severity"
  > & { kind: string };
  const issues: Issue[] = checkDesigns(
    doc,
    rootId ? [rootId] : undefined,
  ).filter(
    (issue) => issue.kind === "low-contrast" || issue.kind === "generic-name",
  );
  const bounds = layoutBounds(doc);
  for (const n of doc.nodes) {
    if ((ids && !ids.has(n.id)) || n.hidden || n.type === "slice") continue;
    const add = (kind: string, message: string, property = "") =>
      issues.push({
        id: [kind, n.id, property].filter(Boolean).join(":"),
        kind,
        severity: "warning",
        nodeId: n.id,
        nodeName: n.name,
        message,
      });
    const resolved = resolveNode(doc, n);
    const style = resolved.style;
    if ((n.type === "text" || n.type === "button") && !resolved.text.trim())
      add("empty-text", "文字内容为空");
    const child = bounds.get(n.id);
    const parent =
      n.parentId && (!allowed || allowed.has(n.parentId))
        ? bounds.get(n.parentId)
        : undefined;
    if (
      child &&
      parent &&
      (child.x < parent.x ||
        child.y < parent.y ||
        child.x + child.width > parent.x + parent.width ||
        child.y + child.height > parent.y + parent.height)
    )
      add("out-of-bounds", "子层超出父容器边界");

    const literalPaint = (
      stack: typeof style.paints,
      gradient?: typeof style.gradient,
    ) => {
      if (stack?.length)
        return stack.some(
          (p) =>
            p.visible &&
            p.opacity > 0 &&
            (p.gradient
              ? p.gradient.stops.some((s) => !s.variableId)
              : !p.colorVariableId),
        );
      return !gradient || gradient.stops.some((s) => !s.variableId);
    };
    const textFill = fillUsesTextColor(n);
    const textStyle =
      n.styleBindings?.text && doc.designSystem?.styles[n.styleBindings.text];
    const styledTextColor =
      textStyle &&
      (textStyle.properties.color || textStyle.bindings.color) &&
      !n.styleOverrides?.includes("color");
    const styledFill =
      n.styleBindings?.paint && !n.styleOverrides?.includes("fill");
    const styledStroke =
      n.styleBindings?.stroke && !n.styleOverrides?.includes("stroke");
    if (
      n.type !== "group" &&
      !n.image &&
      !textFill &&
      (style.fillOpacity ?? 1) > 0 &&
      !n.fillToken &&
      !n.variableBindings?.fill &&
      !styledFill &&
      literalPaint(style.paints, style.gradient)
    )
      add("unbound-color", "填充颜色未绑定变量或样式", "fill");
    if (
      (textFill || n.type === "button") &&
      (style.colorOpacity ?? 1) > 0 &&
      !n.variableBindings?.color &&
      !styledTextColor &&
      (!textFill || (!styledFill && literalPaint(style.paints, style.gradient)))
    )
      add("unbound-color", "前景颜色未绑定变量或样式", "color");
    if (
      style.strokeVisible !== false &&
      (style.strokeOpacity ?? 1) > 0 &&
      (style.strokeWidth ||
        Object.values(style.strokeSides ?? {}).some(Boolean)) &&
      !n.variableBindings?.stroke &&
      !styledStroke &&
      literalPaint(style.strokePaints)
    )
      add("unbound-color", "描边颜色未绑定变量或样式", "stroke");
  }
  return { issues };
}

export async function sessionRequest(
  req: IncomingMessage,
  body: RequestBody,
  allowedOrigin: boolean,
) {
  const method = req.method,
    path = req.url;
  for (const [id, s] of sessions)
    if (Date.now() - s.lastUsed > expires) sessions.delete(id);
  if (path === "/api/agent/sessions" && method === "POST") {
    if (!allowedOrigin) throw new Error("仅编辑器可以开启会话");
    if (sessions.size >= 16) throw new Error("会话已满，请先关闭闲置会话");
    const payload = z
      .object({ document: z.unknown(), selection: z.string().nullable() })
      .parse(await body());
    const document = parseDocument(payload.document),
      selection = payload.selection;
    if (selection && !document.nodes.some((n) => n.id === selection))
      throw new Error("选区不存在");
    const key = token(),
      editor = token();
    sessions.set(key, {
      context: { document, selection, prompt: "" },
      editor,
      lastUsed: Date.now(),
    });
    return { key, editor };
  }
  const prefix = "/api/agent/sessions/";
  const endpoint =
    method === "POST" && path?.startsWith(prefix)
      ? path.slice(prefix.length)
      : "";
  const queryEndpoint = Object.hasOwn(sessionToolSchemas, endpoint)
    ? endpoint
    : null;
  if (queryEndpoint && !req.headers.authorization?.startsWith("Bearer "))
    throw new Error("需要 Bearer 会话令牌");
  const rawKey = req.headers.authorization?.replace(/^Bearer /, "");
  const key = rawKey?.replace(/^\d{1,5}\./, "");
  const s = key && sessions.get(key);
  if (!s) throw new Error("外部 Agent 会话已结束");
  if (req.headers.origin && !allowedOrigin) throw new Error("请求来源不允许");
  s.lastUsed = Date.now();
  const { document, selection } = s.context;
  if (path === "/api/agent/sessions/context" && method === "GET") {
    const allowed = selection ? subtreeIds(document, [selection]) : null;
    return {
      id: document.id,
      revision: document.revision,
      selection,
      nodes: document.nodes.filter((n) => !allowed || allowed.has(n.id)),
      tokens: document.tokens,
      designSystem: document.designSystem,
      images: Object.fromEntries(
        Object.entries(document.images ?? {}).map(
          ([id, { name, width, height }]) => [id, { name, width, height }],
        ),
      ),
    };
  }
  if (path === "/api/agent/sessions/components" && method === "GET")
    return Object.values(document.libraries ?? {}).flatMap((l) =>
      l.components.map((c) => ({
        libraryId: l.id,
        componentId: c.id,
        name: c.name,
        variants: c.variants.map((v) => ({
          id: v.id,
          properties: v.properties,
        })),
      })),
    );
  if (queryEndpoint) {
    const input = await body();
    if (sessions.get(key!) !== s || Date.now() - s.lastUsed > expires)
      throw new Error("外部 Agent 会话已结束");
    indexPublishedScene(document);
    const allowed =
      selection !== null ? subtreeIds(document, [selection]) : null;
    switch (queryEndpoint) {
      case "search-nodes":
        return searchNodes(document, allowed, input);
      case "design-system":
        return designSystemView(document, selection, allowed, input);
      case "lint":
        return lintDesign(document, selection, allowed, input);
      case "node-details": {
        const { ids, includeChildren } =
          sessionToolSchemas["node-details"].parse(input);
        const requested = ids.filter((id) => !allowed || allowed.has(id));
        const found = includeChildren
          ? subtreeIds(document, requested)
          : new Set(requested);
        return {
          nodes: document.nodes
            .filter((n) => found.has(n.id) && (!allowed || allowed.has(n.id)))
            .map((n) => visibleDetail(n, allowed)),
        };
      }
    }
  }
  if (path === "/api/agent/sessions/proposal" && method === "POST") {
    const transaction = validateProposal(s.context, await body());
    if (s.proposal) throw new Error("编辑器已有待处理提案");
    s.proposal = { id: randomUUID(), transaction };
    return {
      id: s.proposal.id,
      baseRevision: transaction.baseRevision,
      operations: transaction.operations.length,
    };
  }
  if (req.headers["x-forma-editor"] !== s.editor)
    throw new Error("需要编辑器会话");
  if (path === "/api/agent/sessions/proposal" && method === "GET")
    return { proposal: s.proposal ?? null };
  if (path === "/api/agent/sessions" && method === "DELETE") {
    sessions.delete(key!);
    return { closed: true };
  }
  throw new Error("会话操作无效");
}
