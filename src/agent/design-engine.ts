import { parseDocument, type DesignDocument } from "../domain/document";
import {
  AdapterHttpError,
  stripThinkingTags,
  createModelAdapter,
  extractJsonPayload,
  type AdapterConfig,
  type AdapterMessage,
  type AdapterRequest,
  type AdapterResponse,
  type AdapterToolDefinition,
} from "./adapters";
import {
  type CompileDiagnostic,
  type CompileBlueprintResult,
  type CompileBlueprintStats,
} from "./blueprint-compiler";
import type { ModelCapabilities } from "./capabilities";
import {
  BLUEPRINT_RESPONSE_JSON_SCHEMA,
  buildDesignContextPayload,
  buildDesignSystemPrompt,
  buildToolModeSystemPrompt,
  type DesignChatContext,
  type ScopeProposal,
} from "./context-builder";
import type { HtmlArtboardSpec } from "./html-to-forma";
import type { Transaction } from "./provider";
import {
  FormaToolExecutor,
  compileValidatedProposal,
  getFormaToolDefinitions,
  toolProgress,
  type AgentToolTraceItem,
  type SkillRuntimeProvider,
  type HtmlDesignDraftProposal,
} from "./forma-tools";
export type {
  HtmlDesignDraftProposal,
  SkillCatalogEntry,
  ActivatedSkillPayload,
  SkillRuntimeProvider,
  AgentToolTraceItem,
} from "./forma-tools";

export const designChatTimeoutMs = 240_000;

export type AgentProgressStage =
  "analyzing" | "planning" | "generating" | "validating" | "repairing" | "done";

export interface AgentProgressEvent {
  stage: AgentProgressStage;
  message: string;
  detail?: string;
}

export interface AgentChatResult {
  htmlDraft?: HtmlDesignDraftProposal;
  critiqueNotes?: string[];
  toolTrace?: AgentToolTraceItem[];
  activatedSkills?: string[];
  diagnostics?: CompileDiagnostic[];
  mode: "generate" | "edit" | "answer" | "clarify";
  scopeProposal?: ScopeProposal;
  targetLibraryId?: string;
  reply: string;
  summary: string;
  transaction?: Transaction;
  createdRootIds: string[];
  stats: CompileBlueprintStats;
  modelUsed: string;
  providerId: string;
  providerName: string;
  capabilities: ModelCapabilities;
}

export interface RunDesignChatOptions {
  adapterConfig: AdapterConfig;
  providerName: string;
  fetchImpl?: typeof fetch;
  signal: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;
  maxRepairAttempts?: number;
  skillProvider?: SkillRuntimeProvider;
  maxToolTurns?: number;
  enableTools?: boolean;
  /** Transaction-only callers have no way to return a scope confirmation. */
  enableScopePlan?: boolean;
  allowNetworkMedia?: boolean;
}

function conciseErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 600);
  }
  return String(error).slice(0, 600);
}

function buildConversationMessages(
  ctx: DesignChatContext,
  capabilities: ModelCapabilities,
  executor: FormaToolExecutor,
  toolMode: boolean,
  enableScopePlan: boolean,
): AdapterMessage[] {
  const systemPrompt = (
    toolMode ? buildToolModeSystemPrompt : buildDesignSystemPrompt
  )(
    ctx,
    capabilities,
    executor.enabledSkills,
    executor.preloadedSkills,
    enableScopePlan,
  );
  const contextPayload = toolMode
    ? {
        document: ctx.document.name,
        revision: ctx.document.revision,
        activePage: ctx.document.activePage ?? "first",
        totalNodes: ctx.document.nodes.length,
        editableSelectionId: ctx.selection,
        viewportCenter: ctx.viewportCenter,
        targetLibraryId: ctx.targetLibraryId ?? null,
        confirmedScope: ctx.confirmedScope ?? null,
        memoryScope: ctx.memoryScope ?? null,
      }
    : buildDesignContextPayload(ctx, capabilities);

  const messages: AdapterMessage[] = [{ role: "system", text: systemPrompt }];

  // Include recent conversation turns for natural multi-turn iterative design
  const recentHistory = (ctx.history ?? []).slice(-10);
  for (const turn of recentHistory) {
    if (!turn.text.trim()) continue;
    messages.push({
      role: turn.role,
      text: turn.text.slice(0, 6000),
    });
  }

  const userBody = [
    `## Designer Request`,
    ctx.prompt,
    ctx.mentions?.length
      ? `\n## Explicit @Mentions\n${ctx.mentions.map((m) => `- @${m.label} (${m.kind}: ${m.id})`).join("\n")}`
      : "",
    `\n## Current Forma Canvas & Design System Context (JSON)\n${JSON.stringify(contextPayload)}`,
  ]
    .filter(Boolean)
    .join("\n");

  messages.push({
    role: "user",
    text: userBody,
    ...(ctx.attachments?.length ? { images: ctx.attachments } : {}),
  });

  return messages;
}

function parseToolModeText(text: string): unknown {
  const clean = stripThinkingTags(text);
  if (!clean) throw new Error("模型未返回设计内容");
  try {
    const parsed = extractJsonPayload(clean);
    if (
      parsed &&
      typeof parsed === "object" &&
      ["mode", "edits", "operations", "artboards"].some((k) =>
        Object.hasOwn(parsed, k),
      )
    )
      return parsed;
  } catch (error) {
    if (/^(?:\{|\[|```json)/i.test(clean)) throw error;
  }
  return { mode: "answer", reply: clean };
}

async function applyToolCalls(
  history: AdapterMessage[],
  response: AdapterResponse,
  executor: FormaToolExecutor,
  tools: AdapterToolDefinition[],
  options: Pick<
    RunDesignChatOptions,
    "fetchImpl" | "signal" | "allowNetworkMedia" | "onProgress"
  >,
) {
  history.push({
    role: "assistant",
    text: response.text,
    toolCalls: response.toolCalls,
    reasoningContent: response.reasoningContent,
    geminiParts: response.geminiParts,
  });
  for (const call of response.toolCalls ?? []) {
    options.signal.throwIfAborted();
    options.onProgress?.({
      stage: call.name.startsWith("propose_") ? "validating" : "analyzing",
      message:
        toolProgress[call.name as keyof typeof toolProgress] ??
        "正在检查工具请求…",
      detail: call.name,
    });
    let result: Record<string, unknown>;
    if (tools.some((tool) => tool.name === call.name)) {
      result = await executor.executeAsync(call.name, call.arguments, {
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        allowNetworkMedia: options.allowNetworkMedia,
      });
    } else {
      const error =
        (call.name === "propose_scope_plan" &&
          executor.scopePlanDisabledReason) ||
        "当前模式未启用工具：" + call.name;
      executor.toolTrace.push({
        name: call.name,
        status: "error",
        summary: error,
        durationMs: 0,
      });
      result = { ok: false, error };
    }
    history.push({
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      text: JSON.stringify(result),
    });
    if (executor.latestScopeProposal) break;
  }
}

export async function runDesignChat(
  rawContext: DesignChatContext,
  options: RunDesignChatOptions,
): Promise<AgentChatResult> {
  const {
    adapterConfig,
    providerName,
    fetchImpl = fetch,
    onProgress,
    maxRepairAttempts = 1,
  } = options;

  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(designChatTimeoutMs),
  ]);
  signal.throwIfAborted();
  const emit = (
    stage: AgentProgressStage,
    message: string,
    detail?: string,
  ) => {
    onProgress?.({ stage, message, ...(detail ? { detail } : {}) });
  };

  emit("analyzing", "正在分析画布结构与设计系统上下文…");
  const document = parseDocument(rawContext.document);
  const ctx: DesignChatContext = {
    ...rawContext,
    document,
  };
  const hasSelection = Boolean(ctx.selection || (ctx.selectionCount ?? 0) > 0);
  if (hasSelection) ctx.confirmedScope = undefined;

  const adapter = createModelAdapter(adapterConfig, fetchImpl);
  const executor = new FormaToolExecutor(ctx, options.skillProvider);
  const supported = adapterConfig.capabilities as ModelCapabilities & {
    supportsTools?: boolean;
  };
  const turns = options.maxToolTurns ?? 10;
  if (!Number.isSafeInteger(turns) || turns < 0)
    throw new Error("maxToolTurns 必须是非负整数");
  const toolMode =
    (options.enableTools ?? supported.supportsTools !== false) && turns > 0;
  const enableScopePlan =
    !ctx.confirmedScope && !hasSelection && options.enableScopePlan !== false;
  const messagesFor = (native: boolean) =>
    buildConversationMessages(
      ctx,
      adapterConfig.capabilities,
      executor,
      native,
      enableScopePlan,
    );
  emit("planning", `正在通过 ${adapterConfig.model} 构思设计方案…`);

  const invoke = (req: AdapterRequest, label: string) => {
    signal.throwIfAborted();
    emit("generating", label);
    if (!adapterConfig.capabilities.supportsStreaming)
      return adapter.complete(req, signal);
    let received = 0,
      last = 0;
    return adapter.stream(
      req,
      (delta) => {
        received += delta.length;
        if (received - last >= 320 || last === 0) {
          last = received;
          emit("generating", label, `已接收 ${received} 字符`);
        }
      },
      signal,
    );
  };
  const finish = (
    compiled: Omit<CompileBlueprintResult, "mode"> &
      Pick<AgentChatResult, "mode" | "htmlDraft" | "scopeProposal">,
  ): AgentChatResult => {
    signal.throwIfAborted();
    emit("done", compiled.summary || "设计方案已就绪");
    return {
      ...compiled,
      targetLibraryId:
        ctx.targetLibraryId ??
        ctx.confirmedScope?.targetLibraryId ??
        compiled.htmlDraft?.targetLibraryId ??
        compiled.scopeProposal?.targetLibraryId,
      toolTrace: executor.toolTrace,
      activatedSkills: [...executor.activatedSkills],
      modelUsed: adapterConfig.model,
      providerId: adapterConfig.providerId,
      providerName,
      capabilities: adapterConfig.capabilities,
    };
  };
  const pendingCanvas = {
    createdRootIds: [],
    diagnostics: [],
    stats: {
      created: 0,
      updated: 0,
      removed: 0,
      componentsInserted: 0,
      tokensBound: 0,
    },
  };
  const finishDraft = (draft: HtmlDesignDraftProposal, finalReply = "") =>
    finish({
      mode: "generate",
      reply: stripThinkingTags(finalReply) || draft.reply,
      summary: draft.summary,
      htmlDraft: draft,
      ...pendingCanvas,
    });
  const blueprintRequest = (messages: AdapterMessage[], label: string) =>
    invoke({ messages, jsonSchema: BLUEPRINT_RESPONSE_JSON_SCHEMA }, label);
  const repair = async (raw: string, error: unknown) => {
    if (maxRepairAttempts <= 0 || signal.aborted) throw error;
    const reason = conciseErrorMessage(error);
    emit("repairing", "检测到结构或约束问题，正在自动修复…", reason);
    const messages: AdapterMessage[] = [
      ...messagesFor(false),
      { role: "assistant", text: raw.slice(0, 12000) },
      {
        role: "user",
        text: "Correct the full Blueprint JSON. Validation failed: " + reason,
      },
    ];
    const response = await blueprintRequest(
      messages,
      "正在生成修复后的设计蓝图…",
    );
    emit("validating", "正在复检修复后的设计事务…");
    return compileValidatedProposal(extractJsonPayload(response.text), ctx);
  };

  if (toolMode) {
    const tools = getFormaToolDefinitions({
      hasSkills: executor.enabledSkills.length > 0,
      enableScopePlan,
      enableHtmlDesign: !hasSelection && ctx.generationMode !== "blueprint",
    });
    const history = messagesFor(true);
    // Reserve the existing wrap-up turn for a proposal when the designer has confirmed the scope.
    const closingTools = ctx.confirmedScope
      ? tools.filter((t) =>
          ["propose_design_changes", "propose_html_design"].includes(t.name),
        )
      : tools;
    for (let round = 0; round <= turns; round++) {
      const closing = round === turns;
      const available = closing ? closingTools : tools;
      let response;
      try {
        response = await invoke(
          {
            messages: history,
            tools: available,
            toolChoice: closing
              ? ctx.confirmedScope
                ? "required"
                : "none"
              : "auto",
          },
          closing ? "正在整理设计结论…" : "正在分析设计并选择工具…",
        );
      } catch (error) {
        if (
          round === 0 &&
          error instanceof AdapterHttpError &&
          error.status === 400 &&
          !signal.aborted
        )
          break;
        throw error;
      }
      signal.throwIfAborted();
      if (!response.toolCalls?.length) {
        if (executor.latestHtmlDraft)
          return finishDraft(executor.latestHtmlDraft, response.text);
        if (executor.latestProposal) return finish(executor.latestProposal);
        emit("validating", "正在检查模型回复与设计变更…");
        let compiled;
        try {
          compiled = compileValidatedProposal(
            parseToolModeText(response.text),
            ctx,
          );
        } catch (error) {
          if (ctx.confirmedScope && !closing) {
            history.push(
              { role: "assistant", text: response.text },
              {
                role: "user",
                text:
                  conciseErrorMessage(error) +
                  " 范围已确认，请直接提交完整画板提案。",
              },
            );
            continue;
          }
          compiled = await repair(response.text, error);
        }
        return finish(compiled);
      }
      if (closing && !ctx.confirmedScope)
        throw new Error("已达到工具轮数上限，未获得有效方案");
      await applyToolCalls(history, response, executor, available, {
        ...options,
        signal,
      });
      if (executor.latestScopeProposal) {
        const { reply, scopeProposal } = executor.latestScopeProposal;
        return finish({
          ...pendingCanvas,
          mode: "clarify",
          reply,
          summary: scopeProposal.summary,
          scopeProposal,
        });
      }
      if (round + 1 >= turns) {
        if (executor.latestHtmlDraft)
          return finishDraft(executor.latestHtmlDraft);
        if (executor.latestProposal) return finish(executor.latestProposal);
        if (closing) throw new Error("已达到工具轮数上限，未获得有效方案");
      }
    }
  }

  const response = await blueprintRequest(
    messagesFor(false),
    "正在生成设计蓝图…",
  );
  emit("validating", "正在编译原生图层并执行规范校验…");
  let compiled: CompileBlueprintResult;
  try {
    compiled = compileValidatedProposal(extractJsonPayload(response.text), ctx);
  } catch (error) {
    compiled = await repair(response.text, error);
  }
  return finish(compiled);
}

export const critiquePngDataUrl =
  /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

export interface VisualCritiqueResult {
  improved: boolean;
  htmlDraft: HtmlDesignDraftProposal;
  critiqueNotes: string[];
  reply: string;
  summary: string;
  toolTrace: AgentToolTraceItem[];
  modelUsed: string;
}

export async function runVisualCritique(
  ctx: {
    prompt: string;
    htmlDraft: HtmlDesignDraftProposal;
    renderedImageDataUrl?: string;
    renderedImages?: Array<{ refId?: string; name: string; dataUrl: string }>;
    document?: DesignDocument;
    selection?: string | null;
    activeSkills?: string[];
  },
  options: Pick<
    RunDesignChatOptions,
    | "adapterConfig"
    | "providerName"
    | "fetchImpl"
    | "signal"
    | "allowNetworkMedia"
    | "onProgress"
  >,
): Promise<VisualCritiqueResult> {
  const { htmlDraft } = ctx;
  const boards: NonNullable<HtmlDesignDraftProposal["artboards"]> =
    htmlDraft.artboards ?? [htmlDraft];
  const { adapterConfig } = options;
  const original = {
    improved: false,
    htmlDraft,
    reply: htmlDraft.reply,
    summary: htmlDraft.summary,
    toolTrace: [],
    modelUsed: adapterConfig.model,
  };
  const partialReview = boards.length > 1 && ctx.renderedImages === undefined;
  const scopeNotes = partialReview ? ["仅审阅首张画板的局部视觉自审"] : [];

  const screenshots = ctx.renderedImages ?? [
    {
      refId: boards[0].refId,
      name: boards[0].name,
      dataUrl: ctx.renderedImageDataUrl ?? "",
    },
  ];
  if (
    !screenshots.length ||
    screenshots.some((s) => !critiquePngDataUrl.test(s.dataUrl))
  )
    throw new Error("视觉自审需要已渲染画板的 PNG 截图");
  const sameBoard = (
    board: HtmlArtboardSpec,
    identity: { refId?: string; name: string },
  ) =>
    identity.refId !== undefined
      ? board.refId === identity.refId
      : board.name === identity.name;
  const reviewed = ctx.renderedImages ? boards : boards.slice(0, 1);
  if (screenshots.length !== reviewed.length)
    throw Error("视觉自审需要每张画板对应一张截图");
  if (
    boards.length > 1 &&
    ctx.renderedImages &&
    screenshots.some((s) => !s.refId)
  )
    throw Error("多画板截图必须逐张提供 refId");
  const attachments = reviewed.map((board) => {
    const matches = screenshots.filter((image) => sameBoard(board, image));
    if (
      matches.length !== 1 ||
      reviewed.filter((b) => sameBoard(b, matches[0])).length !== 1
    )
      throw Error("截图与画板身份不匹配：" + (board.refId ?? board.name));
    return {
      name: board.name,
      mimeType: "image/png",
      dataUrl: matches[0].dataUrl,
    };
  });

  if (!adapterConfig.capabilities.supportsVision)
    return {
      ...original,
      critiqueNotes: [...scopeNotes, "当前模型未开启视觉识图，已保留初稿。"],
    };

  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(designChatTimeoutMs),
  ]);
  signal.throwIfAborted();
  const executor = new FormaToolExecutor(
    {
      prompt: ctx.prompt,
      targetLibraryId: htmlDraft.targetLibraryId,
      selection: null,
      activeSkills: ctx.activeSkills,
      document: ctx.document ?? {
        schemaVersion: 1,
        id: "critique",
        name: htmlDraft.name,
        revision: 0,
        nodes: [],
        tokens: {},
      },
    },
    undefined,
    { all: boards, reviewed },
  );
  // Replace embedded photo bytes with stable references in the model text.
  const photoRefs = new Map<string, string>();
  for (const [id, asset] of Object.entries(htmlDraft.images ?? {})) {
    executor.mediaRegistry.register(id, asset);
    photoRefs.set(asset.data, "forma-asset:" + id);
  }
  const compact = (source: string) =>
    source.replace(
      /data:image\/(?:png|jpeg|webp|gif);base64,[\w+/]+=*/gi,
      (data) => photoRefs.get(data) ?? data,
    );
  const sources = reviewed.map(
    ({ name, refId, role, parentRef, width, height, html, css }) => ({
      name,
      refId,
      role,
      parentRef,
      width,
      height,
      html: compact(html),
      css: compact(css ?? ""),
    }),
  );
  const messages: AdapterMessage[] = [
    {
      role: "system",
      text:
        "You are Forma AI. Inspect the ACTUAL rendered screenshot against the original brief and current HTML/CSS. Check hero/photo framing and text-over-photo contrast, cramped padding, edge touching, clipping or overflow behind the bottom bar, hierarchy and typographic restraint, icon clarity and spacing on an 8pt grid, and surface polish (glass, shadows, hairline borders). Screenshots follow the supplied artboard order. Review each against its HTML/CSS. Submit full revised HTML/CSS through propose_html_design, using artboards for multiple revisions or the named single-board format for one. Keep the original refId, name, role, parentRef and dimensions. Preserve data-forma-component instances and reuse unchanged forma-asset: references. Explain 2–4 concrete fixes, one per line, in its Chinese reply. If already studio-grade, reply concisely with your observations and retain the draft." +
        (partialReview ? " 仅审阅首张画板的局部视觉自审。只可修订首张。" : ""),
    },
    {
      role: "user",
      text: JSON.stringify({
        prompt: ctx.prompt,
        ...(sources.length === 1 ? sources[0] : { artboards: sources }),
      }),
      images: attachments,
    },
  ];
  const tools = getFormaToolDefinitions({ hasSkills: false }).filter((tool) =>
    ["search_icons", "search_stock_images", "propose_html_design"].includes(
      tool.name,
    ),
  );
  const adapter = createModelAdapter(adapterConfig, options.fetchImpl);
  options.onProgress?.({
    stage: "analyzing",
    message: "正在检查实际画板截图与原始设计需求…",
  });
  let reply = "";
  for (let turn = 0; turn < 3; turn++) {
    const response = await adapter.complete(
      { messages, tools, toolChoice: "auto" },
      signal,
    );
    signal.throwIfAborted();
    if (!response.toolCalls?.length) {
      reply = stripThinkingTags(response.text);
      break;
    }
    await applyToolCalls(messages, response, executor, tools, {
      ...options,
      signal,
    });
    if (executor.latestHtmlDraft) break;
  }
  const proposal = executor.latestHtmlDraft;
  let revised: HtmlDesignDraftProposal | undefined;
  if (proposal) {
    const merged = boards.map((board) => {
      const edit =
        reviewed.includes(board) &&
        proposal.artboards?.find((item) => sameBoard(board, item));
      if (!edit) return board;
      const {
        html,
        css,
        imagesLocalized,
        iconsHydrated,
        componentSlotsResolved,
      } = edit;
      return {
        ...board,
        html,
        css,
        imagesLocalized,
        iconsHydrated,
        componentSlotsResolved,
      };
    });
    const first = merged[0];
    revised = {
      ...htmlDraft,
      html: first.html,
      css: first.css,
      ...(htmlDraft.artboards && { artboards: merged }),
      reply: proposal.reply,
      summary: proposal.summary,
      images: { ...htmlDraft.images, ...proposal.images },
    };
    for (const key of [
      "imagesLocalized",
      "iconsHydrated",
      "componentSlotsResolved",
    ] as const) {
      const values = merged.map((board) => board[key]);
      revised[key] = values.every((n) => n !== undefined)
        ? values.reduce((sum, n) => sum + n, 0)
        : undefined;
    }
  }
  reply = revised?.reply || reply || "未收到可用的视觉审稿结论，已保留初稿。";
  const critiqueNotes = reply
    .split(/\n+|(?<=。)\s*/u)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "").trim())
    .filter(Boolean);
  return {
    ...original,
    improved: Boolean(revised),
    htmlDraft: revised ?? htmlDraft,
    reply,
    summary: revised?.summary ?? htmlDraft.summary,
    critiqueNotes: [...scopeNotes, ...critiqueNotes],
    toolTrace: executor.toolTrace,
  };
}
