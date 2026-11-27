import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { parseDocument, type DesignDocument } from "../src/domain/document";
import { checkDesigns, type LintIssue } from "../src/domain/design-lint";
import {
  effectiveModes,
  resolveVariable,
  resolveNode,
} from "../src/domain/design-system";
import { layoutBounds } from "../src/domain/geometry";
import { fillUsesTextColor, nodeSchema } from "../src/domain/node";
import { paintVariables } from "../src/domain/paint-bindings";
import { nodeInteractions } from "../src/domain/prototype";
import { findLayer, indexPublishedScene } from "../src/domain/scene-index";
import { subtreeIds } from "../src/domain/tree";
import {
  validateProposal,
  type GenerationContext,
  type Transaction,
} from "../src/agent/provider";
import {
  delegateDesignTaskSchema,
  exportReactCode,
  listOpenTabsView,
  renderArtboardPreview,
  runDelegatedDesignTask,
  scopedNode,
  sessionTabSummarySchema,
  type DelegateDesignRunner,
  type SessionTabSummary,
} from "./runtime-capabilities";
export type { SessionTabSummary } from "./runtime-capabilities";

type RequestBody = () => Promise<unknown>;
const approvalModeSchema = z.enum(["review", "auto-apply"]);
export type SessionApprovalMode = z.infer<typeof approvalModeSchema>;
export interface ConnectedExternalClient {
  id: string;
  name: string;
  protocol: "mcp-http" | "mcp-stdio" | "a2a";
  lastSeenAt: string;
}
export interface SessionProposal {
  id: string;
  transaction: Transaction;
  source?: "mcp" | "a2a";
  taskId?: string;
  summary?: string;
  autoApply?: boolean;
  createdAt?: string;
}
export interface SessionInboxTaskSummary {
  id: string;
  contextId: string;
  skill: string;
  prompt: string;
  state:
    | "submitted"
    | "working"
    | "input-required"
    | "completed"
    | "failed"
    | "canceled"
    | "rejected";
  summary?: string;
  sourceClient?: string;
  approvalMode: SessionApprovalMode;
  proposalId?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
export interface SessionRequestOptions {
  delegateRunner?: DelegateDesignRunner;
  onCompleteTask?: (
    sessionKey: string,
    taskId: string,
    body: { document?: DesignDocument; note?: string },
  ) => Promise<unknown>;
  onRejectTask?: (
    sessionKey: string,
    taskId: string,
    body: { reason?: string },
  ) => Promise<unknown>;
  listSessionTasks?: (sessionKey: string) => SessionInboxTaskSummary[];
}
interface Session {
  context: GenerationContext;
  editor: string;
  lastUsed: number;
  tabs: SessionTabSummary[];
  activeTabId: string | null;
  approvalMode: SessionApprovalMode;
  writeEnabled: boolean;
  proposal?: SessionProposal;
  connectedClients: Map<string, ConnectedExternalClient>;
  persistent: boolean;
}
export interface SessionView {
  readonly key: string;
  readonly context: Readonly<GenerationContext>;
  readonly tabs: readonly SessionTabSummary[];
  readonly activeTabId: string | null;
  readonly approvalMode: SessionApprovalMode;
  readonly writeEnabled: boolean;
  readonly proposal: SessionProposal | null;
  readonly connectedClients: readonly ConnectedExternalClient[];
  readonly persistent: boolean;
}
const optionalDocument = z.unknown().transform(parseDocument).optional();
const syncSchema = z.object({
  document: optionalDocument,
  selection: z.string().nullable().optional(),
  tabs: z.array(sessionTabSummarySchema).optional(),
  activeTabId: z.string().nullable().optional(),
  approvalMode: approvalModeSchema.optional(),
  writeEnabled: z.boolean().optional(),
});
const createSchema = syncSchema.extend({
  document: z.unknown(),
  selection: z.string().nullable(),
  persistent: z.boolean().default(false),
});
const ackSchema = z.object({
  proposalId: z.string().optional(),
  status: z.enum(["applied", "discarded"]),
});
const completeSchema = z.object({
  document: optionalDocument,
  note: z.string().optional(),
});
const rejectSchema = z.object({
  document: optionalDocument,
  reason: z.string().optional(),
});
const sessions = new Map<string, Session>();
function removeExpiredSessions(now: number) {
  for (const [key, s] of sessions) {
    const ttl = (s.persistent ? 120 : 30) * 60 * 1000;
    if (now - s.lastUsed > ttl) sessions.delete(key);
  }
}
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

export function resolveBearerSessionKey(
  authHeader: string | undefined,
): string | null {
  const match = /^Bearer +(?:\d{1,5}\.)?([\w-]+)$/i.exec(authHeader ?? "");
  return match?.[1] ?? null;
}

function lookupSession(key: string) {
  const now = Date.now();
  removeExpiredSessions(now);
  const s = sessions.get(key);
  if (!s) return null;
  s.lastUsed = now;
  return s;
}

function requireSession(key: string) {
  const s = lookupSession(key);
  if (!s) throw new Error("外部 Agent 会话已结束");
  return s;
}

export function getLiveSession(key: string): SessionView | null {
  const s = lookupSession(key);
  if (!s) return null;
  const { context, tabs, activeTabId, approvalMode, writeEnabled, persistent } =
    s;
  return {
    key,
    context,
    tabs,
    activeTabId,
    approvalMode,
    writeEnabled,
    persistent,
    proposal: s.proposal ?? null,
    connectedClients: [...s.connectedClients.values()],
  };
}

export function recordSessionClient(
  key: string,
  client: {
    id?: string;
    name: string;
    protocol: ConnectedExternalClient["protocol"];
  },
): void {
  const s = requireSession(key);
  const id = client.id ?? client.protocol + ":" + client.name;
  s.connectedClients.set(id, {
    ...client,
    id,
    lastSeenAt: new Date().toISOString(),
  });
}

function sessionScope(key: string) {
  const { document, selection } = requireSession(key).context;
  indexPublishedScene(document);
  return {
    document,
    selection,
    allowed: selection !== null ? subtreeIds(document, [selection]) : null,
  };
}

export function readSessionContext(key: string) {
  const { document, selection, allowed } = sessionScope(key);
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

export function listSessionComponents(key: string) {
  const { document } = requireSession(key).context;
  return Object.values(document.libraries ?? {}).flatMap((l) =>
    l.components.map((c) => ({
      libraryId: l.id,
      componentId: c.id,
      name: c.name,
      variants: c.variants.map((v) => ({ id: v.id, properties: v.properties })),
    })),
  );
}

export function runSessionSearchNodes(key: string, input: unknown) {
  const { document, allowed } = sessionScope(key);
  return searchNodes(document, allowed, input);
}
export function runSessionNodeDetails(key: string, input: unknown) {
  const { document, allowed } = sessionScope(key);
  const { ids, includeChildren } =
    sessionToolSchemas["node-details"].parse(input);
  const requested = ids.filter((id) => !allowed || allowed.has(id));
  const found = includeChildren
    ? subtreeIds(document, requested)
    : new Set(requested);
  return {
    nodes: document.nodes
      .filter((n) => found.has(n.id) && (!allowed || allowed.has(n.id)))
      .map((n) => scopedNode(n, allowed)),
  };
}
export function runSessionDesignSystem(key: string, input: unknown) {
  const { document, selection, allowed } = sessionScope(key);
  return designSystemView(document, selection, allowed, input);
}
export function runSessionLint(key: string, input: unknown) {
  const { document, selection, allowed } = sessionScope(key);
  return lintDesign(document, selection, allowed, input);
}
export function runSessionListTabs(key: string) {
  const { tabs, context } = requireSession(key);
  return listOpenTabsView(tabs, context.document, context.selection);
}
export function runSessionRenderPreview(key: string, input: unknown) {
  const { document, selection, allowed } = sessionScope(key);
  return renderArtboardPreview(document, selection, allowed, input);
}
export function runSessionExportReact(key: string, input: unknown) {
  const { document, selection, allowed } = sessionScope(key);
  return exportReactCode(document, selection, allowed, input);
}

function requireWrite(s: Session) {
  if (!s.writeEnabled)
    throw new Error("当前外部连接处于只读模式，不允许写入画布");
}
type ProposalMeta = Pick<SessionProposal, "source" | "taskId" | "summary">;
function queueProposal(
  s: Session,
  transaction: Transaction,
  meta: ProposalMeta,
) {
  requireWrite(s);
  if (s.proposal) throw new Error("编辑器已有待处理提案");
  s.proposal = {
    ...meta,
    source: meta.source ?? "mcp",
    id: randomUUID(),
    transaction,
    autoApply: s.approvalMode === "auto-apply",
    createdAt: new Date().toISOString(),
  };
  return s.proposal;
}
export function submitSessionProposal(
  key: string,
  input: unknown,
  meta: ProposalMeta = {},
) {
  const s = requireSession(key);
  requireWrite(s);
  const transaction = validateProposal(s.context, input);
  const proposal = queueProposal(s, transaction, meta);
  return {
    id: proposal.id,
    baseRevision: transaction.baseRevision,
    operations: transaction.operations.length,
  };
}
export async function runSessionDelegateDesign(
  key: string,
  input: unknown,
  runner?: DelegateDesignRunner,
) {
  const s = requireSession(key);
  requireWrite(s);
  const parsed = delegateDesignTaskSchema.parse(input);
  const { document, selection, allowed } = sessionScope(key);
  const tabId = s.activeTabId;
  const result = await runDelegatedDesignTask(
    document,
    selection,
    allowed,
    parsed,
    runner,
  );
  const live = requireSession(key);
  requireWrite(live);
  const current = live.context;
  if (
    tabId !== live.activeTabId ||
    current.document.id !== document.id ||
    current.document.activePage !== document.activePage ||
    current.document.revision !== document.revision ||
    current.selection !== selection
  )
    throw new Error("画布或选区已变化，请重新委派任务");
  const transaction = result.transaction;
  let proposalId: string | null = null;
  if (transaction) {
    // A sync may replace even a same-revision snapshot while the model is running.
    if (current.document !== document)
      validateProposal(
        { ...current, selection: result.selection },
        transaction,
      );
    proposalId = queueProposal(live, transaction, {
      summary: parsed.prompt.slice(0, 120),
    }).id;
  }
  return {
    proposalId,
    reply: result.reply,
    operations: transaction?.operations.length ?? 0,
    approvalMode: live.approvalMode,
    autoApply: live.approvalMode === "auto-apply",
    diagnostics: result.diagnostics,
    toolTrace: result.toolTrace,
  };
}
export function clearSessionProposalByTask(key: string, taskId: string): void {
  const s = lookupSession(key);
  if (s?.proposal?.taskId === taskId) delete s.proposal;
}

function setSnapshot(
  s: Session,
  document: DesignDocument,
  selection = s.context.selection,
) {
  s.context = {
    ...s.context,
    document,
    selection:
      selection !== null && findLayer(document, selection) ? selection : null,
  };
}
export function updateSessionDocumentSnapshot(
  key: string,
  doc: DesignDocument,
): void {
  setSnapshot(requireSession(key), doc);
}

function setTabs(
  s: Session,
  tabs: SessionTabSummary[],
  activeTabId: string | null | undefined,
) {
  s.activeTabId =
    activeTabId === undefined
      ? (tabs.find((t) => t.active)?.id ?? null)
      : activeTabId;
  s.tabs = tabs.map((t) => ({ ...t, active: t.id === s.activeTabId }));
}

const sessionQueries: Record<string, (key: string, input: unknown) => unknown> =
  {
    "search-nodes": runSessionSearchNodes,
    "node-details": runSessionNodeDetails,
    "design-system": runSessionDesignSystem,
    lint: runSessionLint,
    "render-preview": runSessionRenderPreview,
    "export-react": runSessionExportReact,
    proposal: submitSessionProposal,
  };

export async function sessionRequest(
  req: IncomingMessage,
  body: RequestBody,
  allowedOrigin: boolean,
  options?: SessionRequestOptions,
) {
  const base = "/api/agent/sessions";
  const method = req.method;
  const path = req.url;
  if (path === base && method === "POST") {
    if (!allowedOrigin) throw new Error("仅编辑器可以开启会话");
    const payload = createSchema.parse(await body());
    removeExpiredSessions(Date.now());
    if (sessions.size >= 16) throw new Error("会话已满，请先关闭闲置会话");
    const document = parseDocument(payload.document);
    const {
      selection,
      persistent,
      approvalMode = "review",
      writeEnabled = true,
    } = payload;
    if (selection !== null && !findLayer(document, selection))
      throw new Error("选区不存在");
    const key = token(),
      editor = token();
    const s: Session = {
      context: { document, selection, prompt: "" },
      editor,
      lastUsed: Date.now(),
      tabs: [],
      activeTabId: null,
      connectedClients: new Map(),
      persistent,
      approvalMode,
      writeEnabled,
    };
    setTabs(s, payload.tabs ?? [], payload.activeTabId);
    sessions.set(key, s);
    return { key, editor, approvalMode, writeEnabled, persistent };
  }
  const key = resolveBearerSessionKey(req.headers.authorization);
  const endpoint = path?.startsWith(base + "/")
    ? path.slice(base.length + 1)
    : undefined;
  if (!key) {
    if (
      method === "POST" &&
      endpoint &&
      Object.hasOwn(sessionToolSchemas, endpoint)
    )
      throw new Error("需要 Bearer 会话令牌");
    throw new Error("外部 Agent 会话已结束");
  }
  if (req.headers.origin && !allowedOrigin) throw new Error("请求来源不允许");
  const s = requireSession(key);
  if (req.headers["x-forma-client-protocol"] === "mcp-stdio")
    recordSessionClient(key, { name: "MCP Stdio", protocol: "mcp-stdio" });
  if (method === "GET") {
    if (endpoint === "context") return readSessionContext(key);
    if (endpoint === "components") return listSessionComponents(key);
    if (endpoint === "tabs") return runSessionListTabs(key);
  }
  if (method === "POST" && endpoint) {
    if (Object.hasOwn(sessionQueries, endpoint))
      return sessionQueries[endpoint](key, await body());
    if (endpoint === "delegate-design")
      return runSessionDelegateDesign(
        key,
        await body(),
        options?.delegateRunner,
      );
  }
  if (req.headers["x-forma-editor"] !== s.editor)
    throw new Error("需要编辑器会话");
  if (method === "GET" && endpoint === "proposal")
    return { proposal: s.proposal ?? null };
  if (method === "DELETE" && path === base) {
    sessions.delete(key);
    return { closed: true };
  }
  if (method === "PUT" && endpoint === "sync") {
    const update = syncSchema.parse(await body());
    requireSession(key);
    const document = update.document ?? s.context.document;
    if (update.document !== undefined || update.selection !== undefined)
      setSnapshot(s, document, update.selection);
    if (update.tabs !== undefined || update.activeTabId !== undefined)
      setTabs(s, update.tabs ?? s.tabs, update.activeTabId);
    s.approvalMode = update.approvalMode ?? s.approvalMode;
    s.writeEnabled = update.writeEnabled ?? s.writeEnabled;
    return {
      ok: true,
      revision: document.revision,
      approvalMode: s.approvalMode,
      writeEnabled: s.writeEnabled,
      proposal: s.proposal ?? null,
      connectedClients: [...s.connectedClients.values()],
      tasks: options?.listSessionTasks?.(key) ?? [],
    };
  }
  if (method === "POST" && endpoint === "proposal/ack") {
    const { proposalId } = ackSchema.parse(await body());
    requireSession(key);
    const cleared = proposalId === undefined || s.proposal?.id === proposalId;
    if (cleared) delete s.proposal;
    return { ok: true, cleared };
  }
  const task =
    method === "POST" &&
    /^tasks\/([^/]+)\/(complete|reject)$/.exec(endpoint ?? "");
  if (task) {
    const [, taskId, operation] = task;
    const payload = await body();
    requireSession(key);
    let result: unknown;
    if (operation === "complete") {
      if (!options?.onCompleteTask) throw new Error("外部任务服务不可用");
      const parsed = completeSchema.parse(payload);
      if (parsed.document) updateSessionDocumentSnapshot(key, parsed.document);
      result = await options.onCompleteTask(key, taskId, parsed);
    } else {
      if (!options?.onRejectTask) throw new Error("外部任务服务不可用");
      const { document, reason } = rejectSchema.parse(payload);
      if (document) updateSessionDocumentSnapshot(key, document);
      result = await options.onRejectTask(key, taskId, { reason });
    }
    clearSessionProposalByTask(key, taskId);
    return result;
  }
  throw new Error("会话操作无效");
}
