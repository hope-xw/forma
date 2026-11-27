import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  buildFormaAgentCard,
  inferFormaSkill,
  jsonRpcErrorCodes as codes,
  jsonRpcRequestSchema,
  makeJsonRpcError,
  makeJsonRpcResult,
  messageSendParamsSchema,
  tasksCancelParamsSchema,
  tasksGetParamsSchema,
  tasksListParamsSchema,
  type A2AArtifact,
  type A2AArtifactUpdateEvent,
  type A2AMessage,
  type A2ASkillId,
  type A2AStatusUpdateEvent,
  type A2ATask,
  type A2ATaskState,
  type JsonRpcId,
} from "./a2a-protocol";

export interface A2ASessionAuth {
  sessionKey: string;
  approvalMode: "review" | "auto-apply";
  writeEnabled: boolean;
  documentId: string;
  documentName: string;
  revision: number;
  selection: string | null;
}

export interface A2AReactExportResult {
  targetId: string;
  targetName: string;
  revision: number;
  files: Record<string, string>;
  filePaths: string[];
  fileCount: number;
}

export interface A2APreviewResult {
  nodeId: string;
  nodeName: string;
  width: number;
  height: number;
  mimeType: "image/svg+xml";
  svg: string;
  dataUrl: string;
}

export interface A2ARuntimeAdapter {
  authenticate(authHeader: string | undefined): A2ASessionAuth | null;
  recordClient(sessionKey: string, clientName: string): void;
  auditDesign(
    sessionKey: string,
    input: { rootId?: string },
  ): Promise<{ issues: unknown[]; designSystem?: unknown }>;
  renderPreview(
    sessionKey: string,
    input: { nodeId?: string; scale?: number },
  ): Promise<A2APreviewResult>;
  exportReact(
    sessionKey: string,
    input: {
      nodeId?: string;
      includeTokens?: boolean;
      includeComponents?: boolean;
    },
  ): Promise<A2AReactExportResult>;
  generateProposal(
    sessionKey: string,
    input: {
      taskId: string;
      prompt: string;
      skill: "generate_ui" | "refine_artboard";
      selectionId?: string;
      targetLibraryId?: string;
      transaction?: unknown;
    },
  ): Promise<{
    proposalId: string;
    operations: number;
    reply: string;
    autoApply: boolean;
    diagnostics?: unknown[];
  }>;
  clearTaskProposal(sessionKey: string, taskId: string): void;
  getSessionSnapshot(sessionKey: string): A2ASessionAuth | null;
}

export interface InboxTaskSummary {
  id: string;
  contextId: string;
  skill: A2ASkillId;
  prompt: string;
  state: A2ATaskState;
  summary?: string;
  sourceClient?: string;
  approvalMode: "review" | "auto-apply";
  proposalId?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface A2AServerOptions {
  adapter: A2ARuntimeAdapter;
  version?: string;
  isAllowedOrigin?: (req: IncomingMessage) => boolean;
  /** Maximum wait for an editor update on one HTTP connection. Tasks remain pollable. */
  waitTimeoutMs?: number;
}

export class A2ARpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly httpStatus = 200,
  ) {
    super(message);
  }
}

type TaskEvent = A2AStatusUpdateEvent | A2AArtifactUpdateEvent;
type Listener = (event: TaskEvent) => void;
type SendParams = z.infer<typeof messageSendParamsSchema>;
interface TaskRecord {
  task: A2ATask;
  inbox: InboxTaskSummary;
  documentId: string;
  listeners: Set<Listener>;
  requests: Map<string, Pick<SendParams, "message" | "metadata">>;
  completion?: Promise<A2ATask>;
}

const terminalStates = new Set<A2ATaskState>([
  "completed",
  "failed",
  "rejected",
  "canceled",
]);
const isDesignWrite = (skill: A2ASkillId) =>
  skill === "generate_ui" || skill === "refine_artboard";
const maxBodyBytes = 4 * 1024 * 1024;
const readOnlyMessage = "当前外部连接处于只读模式，不允许写入画布";

const skillInputSchema = z.object({
  prompt: z.string().optional(),
  rootId: z.string().optional(),
  nodeId: z.string().optional(),
  selectionId: z.string().optional(),
  targetLibraryId: z.string().optional(),
  transaction: z.unknown().optional(),
  includeTokens: z.boolean().optional(),
  includeComponents: z.boolean().optional(),
});
type SkillInput = z.infer<typeof skillInputSchema>;

function parseParams<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new A2ARpcError(codes.invalidParams, "Invalid params");
  return result.data;
}

function isLoopback(req: IncomingMessage) {
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i.exec(
    req.headers.host ?? "",
  );
  return (
    match !== null && (match[1] === undefined || Number(match[1]) <= 65535)
  );
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const tooLarge = () =>
    new A2ARpcError(codes.invalidRequest, "Request exceeds 4 MiB", 413);
  if (Number(req.headers["content-length"]) > maxBodyBytes) throw tooLarge();
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes) throw tooLarge();
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new A2ARpcError(codes.parseError, "Parse error", 400);
  }
}

function taskView(task: A2ATask, historyLength?: number): A2ATask {
  if (historyLength === undefined) return task;
  return {
    ...task,
    history: task.history.slice(
      Math.max(0, task.history.length - historyLength),
    ),
  };
}

function statusEvent(task: A2ATask): A2AStatusUpdateEvent {
  return {
    kind: "status-update",
    taskId: task.id,
    contextId: task.contextId,
    status: task.status,
    final:
      terminalStates.has(task.status.state) ||
      task.status.state === "input-required",
    metadata: task.metadata,
  };
}

function artifactEvent(
  task: A2ATask,
  artifact: A2AArtifact,
): A2AArtifactUpdateEvent {
  return {
    kind: "artifact-update",
    taskId: task.id,
    contextId: task.contextId,
    artifact,
    lastChunk: true,
  };
}

function publish(record: TaskRecord, event: TaskEvent) {
  for (const listener of record.listeners) listener(event);
}

function dataArtifact(
  name: string,
  data: Record<string, unknown>,
): A2AArtifact {
  return { artifactId: name, name, parts: [{ kind: "data", data }] };
}

// Both SSE and blocking sends detach on a client disconnect or timeout.
// Disconnecting only ends the HTTP wait; the editor still owns the proposal.
function subscribe(
  record: TaskRecord,
  res: ServerResponse,
  timeout: number,
  listener: Listener,
  onEnd: () => void,
) {
  const close = () => {
    clearTimeout(timer);
    record.listeners.delete(listener);
    res.off("close", close);
    onEnd();
  };
  const timer = setTimeout(close, timeout).unref();
  record.listeners.add(listener);
  res.once("close", close);
  if (res.destroyed) close();
  return close;
}

function openStream(
  record: TaskRecord,
  res: ServerResponse,
  id: JsonRpcId,
  timeout: number,
  mode: "replay" | "follow-up" | "resubscribe",
) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
  });
  const send: Listener = (event) => {
    if (res.destroyed || res.writableEnded) return;
    const frame =
      mode === "resubscribe" &&
      event.kind === "status-update" &&
      event.status.state === "input-required"
        ? { ...event, final: false }
        : event;
    res.write("data: " + JSON.stringify(makeJsonRpcResult(id, frame)) + "\n\n");
    if (frame.kind === "status-update" && frame.final) close();
  };
  const close = subscribe(record, res, timeout, send, () => {
    if (!res.destroyed && !res.writableEnded) res.end();
  });
  if (mode !== "follow-up") {
    for (const artifact of record.task.artifacts)
      send(artifactEvent(record.task, artifact));
    send(statusEvent(record.task));
  }
}

export function createA2AServer({
  adapter,
  version,
  isAllowedOrigin = (req) =>
    req.headers.origin === `http://${req.headers.host}` ||
    req.headers.origin === `https://${req.headers.host}`,
  waitTimeoutMs = 120_000,
}: A2AServerOptions) {
  const sessions = new Map<string, Map<string, TaskRecord>>();

  function lookup(key: string, id: string) {
    const record = sessions.get(key)?.get(id);
    if (!record) throw new A2ARpcError(codes.taskNotFound, "Task not found");
    return record;
  }

  function newest(key: string) {
    // Maps preserve creation order even when timestamps share a millisecond.
    return Array.from(sessions.get(key)?.values() ?? []).reverse();
  }

  function prune(key: string) {
    const records = sessions.get(key);
    if (!records || records.size <= 64) return;
    for (const [id, record] of records) {
      if (terminalStates.has(record.task.status.state)) records.delete(id);
      if (records.size <= 64) break;
    }
  }

  function transition(
    key: string,
    record: TaskRecord,
    state: A2ATaskState,
    text?: string,
  ) {
    const { task, inbox } = record;
    const timestamp = new Date().toISOString();
    const message: A2AMessage | undefined =
      text === undefined
        ? undefined
        : {
            kind: "message",
            role: "agent",
            messageId: randomUUID(),
            taskId: task.id,
            contextId: task.contextId,
            parts: [{ kind: "text", text }],
          };
    if (message) task.history.push(message);
    task.status = { state, timestamp, ...(message && { message }) };
    inbox.state = state;
    inbox.updatedAt = timestamp;
    if (text !== undefined) inbox.summary = text;
    if (state === "failed") inbox.error = text;
    publish(record, statusEvent(task));
    if (terminalStates.has(state)) prune(key);
  }

  function clearProposal(key: string, record: TaskRecord) {
    adapter.clearTaskProposal(key, record.task.id);
    delete record.inbox.proposalId;
    delete record.task.metadata?.proposalId;
    delete record.task.metadata?.awaitingAutoApply;
  }

  function finish(
    key: string,
    record: TaskRecord,
    artifacts: A2AArtifact[],
    summary: string,
  ) {
    if (terminalStates.has(record.task.status.state)) return;
    for (const artifact of artifacts) {
      record.task.artifacts.push(artifact);
      publish(record, artifactEvent(record.task, artifact));
    }
    transition(key, record, "completed", summary);
  }

  async function exportArtifacts(
    key: string,
    record: TaskRecord,
    input: Parameters<A2ARuntimeAdapter["exportReact"]>[1],
  ) {
    const snapshot = adapter.getSessionSnapshot(key);
    if (!snapshot || snapshot.documentId !== record.documentId) {
      throw new A2ARpcError(
        codes.invalidParams,
        "请先在 Forma 打开此任务关联的设计稿",
      );
    }
    async function optionalPreview() {
      try {
        return await adapter.renderPreview(key, { nodeId: input.nodeId });
      } catch {
        return null;
      }
    }
    // Start both reads together so the adapters capture the same live selection and revision.
    const [project, preview] = await Promise.all([
      adapter.exportReact(key, input),
      optionalPreview(),
    ]);
    const { targetId, targetName, revision, filePaths, files, fileCount } =
      project;
    const artifacts = [
      dataArtifact("react-project-files", {
        targetId,
        targetName,
        revision,
        filePaths,
        files,
      }),
    ];
    if (preview) {
      artifacts.push({
        artifactId: "artboard-preview",
        name: "artboard-preview",
        parts: [
          {
            kind: "file",
            file: {
              name: targetName + ".svg",
              mimeType: preview.mimeType,
              bytes: Buffer.from(preview.svg).toString("base64"),
            },
          },
        ],
        metadata: {
          nodeId: preview.nodeId,
          width: preview.width,
          height: preview.height,
        },
      });
    }
    artifacts.push(
      dataArtifact("forma-design-summary", {
        documentId: snapshot.documentId,
        documentName: snapshot.documentName,
        targetId,
        targetName,
        revision,
        fileCount,
      }),
    );
    return artifacts;
  }

  async function completeTaskFromEditor(
    key: string,
    taskId: string,
    options: { note?: string; nodeId?: string } = {},
  ) {
    const record = lookup(key, taskId);
    if (
      !record.inbox.proposalId ||
      !["input-required", "working"].includes(record.task.status.state)
    ) {
      throw new A2ARpcError(
        codes.invalidParams,
        "Task is not awaiting editor confirmation",
      );
    }
    if (record.completion) return record.completion;
    record.completion = (async () => {
      const artifacts = await exportArtifacts(key, record, {
        nodeId: options.nodeId,
      });
      // A cancellation/rejection while compiling takes precedence over this callback.
      if (!terminalStates.has(record.task.status.state)) {
        clearProposal(key, record);
        finish(
          key,
          record,
          artifacts,
          options.note || "设计师已确认并回传产物",
        );
      }
      return record.task;
    })();
    try {
      return await record.completion;
    } finally {
      delete record.completion;
    }
  }

  function stopTask(
    key: string,
    id: string,
    state: "rejected" | "canceled",
    reason?: string,
  ) {
    const record = lookup(key, id);
    if (terminalStates.has(record.task.status.state))
      throw new A2ARpcError(codes.taskNotCancelable, "Task not cancelable");
    clearProposal(key, record);
    transition(
      key,
      record,
      state,
      reason || (state === "canceled" ? "任务已取消" : "设计师已拒绝方案"),
    );
    return record.task;
  }

  function begin(
    auth: A2ASessionAuth,
    sourceClient: string,
    request: Pick<SendParams, "message" | "metadata">,
    skill: A2ASkillId,
    prompt: string,
  ) {
    const { sessionKey: key, approvalMode, documentId } = auth;
    const { message } = request;
    const previous =
      message.taskId === undefined ? undefined : lookup(key, message.taskId);
    if (isDesignWrite(skill) && !auth.writeEnabled)
      throw new A2ARpcError(codes.permissionDenied, readOnlyMessage);
    // A retried send (including a stream reconnect) must not queue the same edit twice.
    const candidates = previous
      ? [previous]
      : (sessions.get(key)?.values() ?? []);
    for (const existing of candidates) {
      const sent = existing.requests.get(message.messageId);
      if (!sent) continue;
      if (!isDeepStrictEqual(sent, request)) {
        throw new A2ARpcError(codes.invalidParams, "Message ID already in use");
      }
      return { record: existing, replay: true };
    }
    let record: TaskRecord;
    if (previous) {
      if (
        previous.task.status.state !== "input-required" ||
        previous.completion ||
        !isDesignWrite(skill) ||
        (message.contextId && message.contextId !== previous.task.contextId) ||
        documentId !== previous.documentId
      ) {
        throw new A2ARpcError(
          codes.invalidParams,
          "Task cannot accept this follow-up",
        );
      }
      clearProposal(key, previous);
      record = previous;
      Object.assign(record.inbox, {
        skill,
        prompt,
        approvalMode,
        sourceClient,
      });
    } else {
      const id = randomUUID();
      const contextId = message.contextId ?? randomUUID();
      const timestamp = new Date().toISOString();
      record = {
        documentId,
        task: {
          kind: "task",
          id,
          contextId,
          status: { state: "submitted", timestamp },
          history: [],
          artifacts: [],
        },
        inbox: {
          id,
          contextId,
          state: "submitted",
          createdAt: timestamp,
          updatedAt: timestamp,
          skill,
          prompt,
          approvalMode,
          sourceClient,
        },
        listeners: new Set(),
        requests: new Map(),
      };
      const records = sessions.get(key) ?? new Map<string, TaskRecord>();
      records.set(id, record);
      sessions.set(key, records);
      prune(key);
    }
    record.task.metadata = { skill, approvalMode };
    record.requests.set(message.messageId, request);
    record.task.history.push({
      ...message,
      kind: "message",
      taskId: record.task.id,
      contextId: record.task.contextId,
    });
    return { record, replay: false };
  }

  async function run(
    auth: A2ASessionAuth,
    record: TaskRecord,
    input: SkillInput,
  ) {
    const key = auth.sessionKey;
    const { task, inbox } = record;
    const { skill, prompt } = inbox;
    transition(key, record, "working");
    try {
      if (skill === "audit_design_system") {
        const report = await adapter.auditDesign(key, {
          rootId: input.rootId ?? input.nodeId ?? input.selectionId,
        });
        finish(
          key,
          record,
          [dataArtifact("design-audit-report", report)],
          `设计审校完成，发现 ${report.issues.length} 项问题`,
        );
      } else if (skill === "design_to_react") {
        const artifacts = await exportArtifacts(key, record, {
          nodeId: input.nodeId ?? input.selectionId,
          includeTokens: input.includeTokens,
          includeComponents: input.includeComponents,
        });
        finish(key, record, artifacts, "React 工程已导出");
      } else {
        const proposal = await adapter.generateProposal(key, {
          taskId: task.id,
          skill,
          prompt,
          selectionId:
            input.selectionId ?? input.nodeId ?? auth.selection ?? undefined,
          transaction: input.transaction,
          targetLibraryId: input.targetLibraryId,
        });
        if (terminalStates.has(task.status.state)) {
          // Generation can enqueue after a cancellation cleared the original slot.
          adapter.clearTaskProposal(key, task.id);
          return;
        }
        const live = adapter.getSessionSnapshot(key);
        if (!live?.writeEnabled)
          throw new A2ARpcError(codes.permissionDenied, readOnlyMessage);
        if (live.documentId !== record.documentId) {
          throw new A2ARpcError(
            codes.invalidParams,
            "画布已切换，请重新委派任务",
          );
        }
        inbox.proposalId = proposal.proposalId;
        const auto = live.approvalMode === "auto-apply";
        inbox.approvalMode = auto ? "auto-apply" : "review";
        task.metadata = {
          ...task.metadata,
          approvalMode: inbox.approvalMode,
          proposalId: proposal.proposalId,
          ...(auto && { awaitingAutoApply: true }),
        };
        transition(
          key,
          record,
          auto ? "working" : "input-required",
          auto
            ? "等待 Forma 画布自动应用方案"
            : "已在 Forma 画布生成待审方案，等待设计师确认并回传",
        );
      }
    } catch (error) {
      if (terminalStates.has(task.status.state)) return;
      let failure =
        error instanceof A2ARpcError
          ? error
          : new A2ARpcError(codes.internalError, "Internal error");
      if (
        isDesignWrite(skill) &&
        error instanceof Error &&
        (("status" in error && error.status === 503) ||
          ("statusCode" in error && error.statusCode === 503) ||
          ("code" in error &&
            (error.code === "MODEL_NOT_CONFIGURED" ||
              error.code === codes.modelNotConfigured)))
      ) {
        failure = new A2ARpcError(
          codes.modelNotConfigured,
          "Model not configured",
        );
      }
      if (isDesignWrite(skill)) {
        if (adapter.getSessionSnapshot(key)?.writeEnabled === false) {
          failure = new A2ARpcError(codes.permissionDenied, readOnlyMessage);
        }
        clearProposal(key, record);
      }
      transition(key, record, "failed", failure.message);
      throw failure;
    }
  }

  function handleAgentCard(
    req: IncomingMessage,
    res: ServerResponse,
    baseUrl: string,
  ) {
    if (!isLoopback(req))
      return sendJson(res, 403, { error: "Forbidden Host" });
    res.setHeader("Allow", "GET, OPTIONS");
    if (req.method !== "GET" && req.method !== "OPTIONS")
      return sendJson(res, 405, { error: "Method not allowed" });
    sendJson(res, 200, buildFormaAgentCard({ baseUrl, version }));
  }

  async function handleRpc(req: IncomingMessage, res: ServerResponse) {
    let id: JsonRpcId = null;
    try {
      if (
        !isLoopback(req) ||
        (req.headers.origin !== undefined && !isAllowedOrigin(req))
      ) {
        throw new A2ARpcError(codes.permissionDenied, "Forbidden", 403);
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        throw new A2ARpcError(codes.invalidRequest, "Method not allowed", 405);
      }
      const authenticated = adapter.authenticate(req.headers.authorization);
      if (!authenticated) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="forma-a2a"');
        throw new A2ARpcError(codes.permissionDenied, "Unauthorized", 401);
      }
      const key = authenticated.sessionKey;
      const client = req.headers["x-a2a-client"];
      const name =
        (Array.isArray(client) ? client[0] : client) ||
        req.headers["user-agent"] ||
        "A2A Client";
      adapter.recordClient(key, name);
      const parsed = jsonRpcRequestSchema.safeParse(await readBody(req));
      if (!parsed.success)
        throw new A2ARpcError(codes.invalidRequest, "Invalid Request", 400);
      const { method, params } = parsed.data;
      id = parsed.data.id;
      const auth = adapter.getSessionSnapshot(key);
      if (!auth) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="forma-a2a"');
        throw new A2ARpcError(codes.permissionDenied, "Unauthorized", 401);
      }
      let result: unknown;
      switch (method) {
        case "message/send":
        case "message/stream": {
          const { message, metadata, configuration } = parseParams(
            messageSendParamsSchema,
            params,
          );
          const skill = inferFormaSkill(message, metadata);
          const fields: Record<string, unknown> = Object.create(null);
          for (const part of message.parts) {
            if (part.kind === "data") Object.assign(fields, part.data);
          }
          const input = parseParams(skillInputSchema, {
            ...message.metadata,
            ...fields,
            ...metadata,
          });
          const prompt =
            message.parts
              .filter((part) => part.kind === "text")
              .map((part) => part.text)
              .join("\n")
              .trim() ||
            input.prompt ||
            "";
          const { record, replay } = begin(
            auth,
            name,
            { message, metadata },
            skill,
            prompt,
          );
          if (method === "message/stream")
            openStream(
              record,
              res,
              id,
              waitTimeoutMs,
              replay || !message.taskId ? "replay" : "follow-up",
            );
          if (!replay) await run(auth, record, input);
          if (method === "message/stream") return;
          if (
            configuration?.blocking &&
            record.task.status.state === "working" &&
            !res.destroyed
          ) {
            await new Promise<void>((resolve) => {
              const close = subscribe(
                record,
                res,
                waitTimeoutMs,
                (event) => {
                  if (event.kind === "status-update" && event.final) close();
                },
                resolve,
              );
            });
          }
          result = taskView(record.task, configuration?.historyLength);
          break;
        }
        case "tasks/get": {
          const query = parseParams(tasksGetParamsSchema, params);
          result = taskView(lookup(key, query.id).task, query.historyLength);
          break;
        }
        case "tasks/cancel": {
          const query = parseParams(tasksCancelParamsSchema, params);
          result = stopTask(key, query.id, "canceled", query.reason);
          break;
        }
        case "tasks/list": {
          const query = parseParams(
            tasksListParamsSchema,
            params === undefined ? {} : params,
          );
          result = {
            tasks: newest(key)
              .filter(
                (r) => !query.contextId || r.task.contextId === query.contextId,
              )
              .slice(0, query.limit ?? 20)
              .map((r) => r.task),
          };
          break;
        }
        case "tasks/resubscribe": {
          const query = parseParams(tasksGetParamsSchema, params);
          openStream(
            lookup(key, query.id),
            res,
            id,
            waitTimeoutMs,
            "resubscribe",
          );
          return;
        }
        default:
          throw new A2ARpcError(codes.methodNotFound, "Method not found");
      }
      if (!res.destroyed) sendJson(res, 200, makeJsonRpcResult(id, result));
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const failure =
        error instanceof A2ARpcError
          ? error
          : new A2ARpcError(codes.internalError, "Internal error");
      if (failure.httpStatus === 413) res.setHeader("Connection", "close");
      sendJson(
        res,
        failure.httpStatus,
        makeJsonRpcError(id, failure.code, failure.message),
      );
    }
  }

  return {
    handleAgentCard,
    handleRpc,
    completeTaskFromEditor,
    rejectTaskFromEditor: (key: string, id: string, reason?: string) =>
      stopTask(key, id, "rejected", reason),
    listInboxTasks: (key: string): InboxTaskSummary[] =>
      newest(key)
        .slice(0, 30)
        .map((record) => ({ ...record.inbox })),
    getTask: (key: string, id: string): A2ATask | null =>
      sessions.get(key)?.get(id)?.task ?? null,
  };
}
