import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AtSign,
  BookOpen,
  Check,
  CheckCircle2,
  Download,
  ScanEye,
  ImagePlus,
  Loader2,
  Plug,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import type { DesignDocument } from "../domain/document";
import { transact } from "../domain/commands";
import { buildLibraryManifest } from "../agent/library-intelligence";
import { iconToInlineSvg } from "../agent/icon-library";
import {
  compileHtmlDraftInBrowser,
  captureFormaArtboardPng,
} from "./html-forma-sandbox";
import { download } from "../infrastructure/storage";
import {
  validateProposal,
  type GenerationContext,
  type Transaction,
} from "../agent/provider";
import { ExternalAgentSession } from "./ExternalAgentSession";
import { SkillsModal } from "./SkillsModal";
import { CapabilityPills, ModelConfigModal } from "./ModelConfigModal";
import {
  canvasScopeReady,
  AgentMentionPopover,
  MentionKindIcon,
  type PendingAgentProposal,
} from "./CanvasAgentBar";
import {
  fetchAgentStatus,
  fetchSkills,
  type SkillSummary,
  providerBadgeStyle,
  readImageFileAsAttachment,
  requestVisualCritique,
  streamAgentChat,
  updateProviderProfile,
  type AgentAttachment,
  type AgentChatProgress,
  type AgentChatResult,
  type CompileDiagnostic,
  type AgentHistoryTurn,
  type AgentMention,
  type AgentStatusResponse,
  type GenerationMode,
  type ScopeProposal,
  type HtmlDesignDraftProposal,
} from "./agent-client";
import "./agent-ui.css";

export interface ExternalChatRequest {
  id: number;
  prompt: string;
  mentions: AgentMention[];
  attachments?: { name: string; mimeType: string; dataUrl: string }[];
}

export interface AgentPanelProps {
  document: DesignDocument;
  selection: string | null;
  selectionCount: number;
  apply(transaction: Transaction): void;
  focusNode?(id: string): void;
  status?: AgentStatusResponse | null;
  onStatusChange?(status: AgentStatusResponse): void;
  onOpenConfig?(): void;
  pendingProposal?: PendingAgentProposal | null;
  onPendingProposalChange?(proposal: PendingAgentProposal | null): void;
  viewportCenter?: { x: number; y: number };
  externalChatRequest?: ExternalChatRequest | null;
  cancelToken?: number;
  onBusyChange?(busy: boolean, progressText: string, error: string): void;
  onUndoLastApply?(): void;
}

type ComposerInput = Pick<
  ExternalChatRequest,
  "prompt" | "mentions" | "attachments"
>;

interface ChatMessage extends Pick<
  AgentChatResult,
  "toolTrace" | "activatedSkills" | "diagnostics" | "critiqueNotes"
> {
  id: string;
  role: "user" | "assistant";
  text: string;
  mentions?: AgentMention[];
  attachments?: AgentAttachment[];
  summary?: string;
  mode?: AgentChatResult["mode"];
  stats?: AgentChatResult["stats"];
  modelUsed?: string;
  providerName?: string;
  proposalId?: string;
  applied?: boolean;
  discarded?: boolean;
  scopeProposal?: ScopeProposal;
  scopeConfirmed?: boolean;
  scopeChoices?: string[];
  invalidatedReason?: string;
  scopeAttemptId?: string;
  scopeRetryInput?: ComposerInput;
  sourcePrompt?: string;
  sourceMessageId?: string;
  sourceSkills?: string[];
}

const selectionInvalidation =
  "已选中图层，整页范围规划已失效；请取消选区后重试，或直接发送选区局部修改";

export function scopeProblem(
  card: Pick<
    ChatMessage,
    "scopeProposal" | "scopeConfirmed" | "invalidatedReason"
  >,
  selection: string | null,
  generationMode: GenerationMode,
  libraries: DesignDocument["libraries"],
  selectionCount = 0,
) {
  if (!card.scopeProposal || card.scopeConfirmed) return;
  if (card.invalidatedReason) return card.invalidatedReason;
  if (selection || selectionCount > 0) return selectionInvalidation;
  if (generationMode === "html" && card.scopeProposal.screens.length > 8)
    return "现代精排单次最多支持 8 张画板，请切换为蓝图模式或重新规划范围";
  const target = card.scopeProposal.targetLibraryId;
  if (target && !libraries?.[target])
    return "目标组件库已移除，原范围规划已失效";
}

export function chatGeneration(
  hasSelection: boolean,
  generationMode: GenerationMode,
  confirmedScope?: ScopeProposal,
) {
  return hasSelection
    ? { generationMode: "blueprint" as const }
    : { generationMode, confirmedScope };
}

export function composeConfirmedScope(
  scope: ScopeProposal,
  card: Pick<ChatMessage, "scopeRetryInput" | "sourcePrompt" | "scopeChoices">,
  input: ComposerInput,
  original?: Pick<ChatMessage, "mentions" | "attachments">,
) {
  const supplement = input.prompt.trim();
  const previous = card.scopeRetryInput;
  const source = previous?.prompt ?? card.sourcePrompt;
  const instruction =
    supplement || (previous ? "" : "按已确认范围直接生成全部画板。");
  const combined = [source, instruction].filter(Boolean).join("\n\n");
  return {
    prompt:
      combined.length <= 16000 ? combined : supplement || source || instruction,
    confirmedScope: {
      ...scope,
      decisions: scope.decisions?.map((decision, index) => {
        const choice = card.scopeChoices?.[index] ?? decision.defaultChoice;
        if (choice === decision.defaultChoice) return decision;
        return {
          ...decision,
          defaultChoice: choice,
          alternatives: [
            decision.defaultChoice,
            ...(decision.alternatives ?? []),
          ].filter((value) => value !== choice),
        };
      }),
    },

    mentions: [
      ...input.mentions,
      ...(previous?.mentions ?? original?.mentions ?? []),
    ].slice(0, 40),
    attachments: [
      ...(input.attachments ?? []),
      ...((previous ?? original)?.attachments ?? []),
    ].slice(0, 4),
  };
}

const SELECTION_PROMPTS = [
  "优化自动布局",
  "提升视觉层级",
  "转为深色主题",
  "补充交互按钮",
];

const PAGE_PROMPTS = [
  "生成 H5 登录页",
  "生成 SaaS 看板",
  "设计电商商品卡",
  "生成移动端个人中心",
];

function extractCreatedRootIds(tx: Transaction): string[] {
  const ids: string[] = [];
  for (const op of tx.operations) {
    if (op.type === "create" && op.node.parentId === null) {
      ids.push(op.node.id);
    }
  }
  return ids;
}

async function compileDraftProposal(
  draft: HtmlDesignDraftProposal,
  context: GenerationContext,
  viewportCenter: AgentPanelProps["viewportCenter"],
  targetLibraryId?: string,
): Promise<PendingAgentProposal & { diagnostics: CompileDiagnostic[] }> {
  const activeLibraryId = draft.targetLibraryId ?? targetLibraryId;
  const compiled = await compileHtmlDraftInBrowser(draft, {
    baseDocument: context.document,
    iconResolver: iconToInlineSvg,
    selectionParentId: null,
    viewportCenter,
    activeLibraryId,
    snapLibraryTokens:
      draft.snapLibraryTokens ??
      Boolean(activeLibraryId || context.document.designSystem),
  });
  return {
    transaction: validateProposal(context, compiled.transaction),
    diagnostics: compiled.warnings.map((message) => ({
      severity: "warning",
      code: "html-compile-warning",
      message,
    })),
    createdRootIds: compiled.createdRootIds,
    stats: {
      created: compiled.stats.created,
      updated: 0,
      removed: 0,
      componentsInserted: compiled.stats.componentsInserted,
      tokensBound: compiled.stats.tokensBound,
    },
    reply: draft.reply,
    summary: draft.summary,
    source: "chat",
  };
}

function StatsPills({ stats }: { stats: AgentChatResult["stats"] }) {
  const items: { label: string; cls: string }[] = [];
  if (stats.created > 0)
    items.push({ label: `+${stats.created} 图层`, cls: "is-green" });
  if (stats.updated > 0)
    items.push({ label: `~${stats.updated} 修改`, cls: "is-blue" });
  if (stats.removed > 0)
    items.push({ label: `-${stats.removed} 移除`, cls: "" });
  if (stats.componentsInserted > 0)
    items.push({
      label: `${stats.componentsInserted} 组件`,
      cls: "is-purple",
    });
  if (stats.tokensBound > 0)
    items.push({ label: `${stats.tokensBound} 变量`, cls: "is-blue" });
  if (!items.length) return null;
  return (
    <div className="agent-cap-pills">
      {items.map((item, idx) => (
        <span key={idx} className={`agent-cap-pill ${item.cls}`}>
          {item.label}
        </span>
      ))}
    </div>
  );
}

const screenRoles = {
  primary: "主流程",
  overlay: "浮层",
  exception: "异常态",
  detail: "详情页",
};

function ScopeProposalCard({
  scope,
  confirmed,
  disabled,
  choices,
  invalidatedReason,
  onChoice,
  onConfirm,
}: {
  scope: ScopeProposal;
  confirmed: boolean;
  disabled: boolean;
  choices: string[];
  invalidatedReason?: string;
  onChoice: (index: number, choice: string) => void;
  onConfirm: () => void;
}) {
  return (
    <div className="agent-scope-card" role="group" aria-label="生成范围确认">
      <div className="agent-scope-heading">
        <strong>生成范围</strong>
        <span className="agent-scope-library">
          {scope.targetLibraryName ?? scope.targetLibraryId ?? "不限库"}
        </span>
      </div>
      <p>{scope.summary}</p>
      <ol className="agent-scope-screens">
        {scope.screens.map((screen) => (
          <li key={screen.refId}>
            <div>
              <strong>{screen.name}</strong>
              <span>{screenRoles[screen.role]}</span>
            </div>
            <small>
              {screen.width} × {screen.height}
            </small>
            <p>{screen.summary}</p>
          </li>
        ))}
      </ol>
      {!!scope.reusedAssets.length && (
        <p>
          <strong>复用资产</strong> · {scope.reusedAssets.join("、")}
        </p>
      )}
      {!!scope.customModules.length && (
        <p>
          <strong>新建模块</strong> · {scope.customModules.join("、")}
        </p>
      )}
      {scope.decisions?.map((decision, i) => (
        <fieldset
          key={i}
          disabled={disabled || confirmed || !!invalidatedReason}
        >
          <legend>{decision.question}</legend>
          <div>
            {[
              ...new Set([
                decision.defaultChoice,
                ...(decision.alternatives ?? []),
              ]),
            ].map((choice) => (
              <button
                type="button"
                key={choice}
                aria-pressed={choices[i] === choice}
                onClick={() => onChoice(i, choice)}
              >
                {choice}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      {invalidatedReason && <p role="status">{invalidatedReason}</p>}
      <button
        type="button"
        className="primary wide"
        disabled={disabled || confirmed || !!invalidatedReason}
        onClick={onConfirm}
      >
        {confirmed ? "范围已确认" : "确认并直接生成"}
      </button>
    </div>
  );
}

function CallDetails({ message }: { message: ChatMessage }) {
  const {
    toolTrace = [],
    activatedSkills = [],
    diagnostics = [],
    critiqueNotes = [],
  } = message;
  if (
    !toolTrace.length &&
    !activatedSkills.length &&
    !diagnostics.length &&
    !critiqueNotes.length
  )
    return null;
  return (
    <details className="agent-call-details">
      <summary>
        调用详情 · {toolTrace.length} 次工具调用 · {activatedSkills.length}{" "}
        个技能{diagnostics.length > 0 && ` · ${diagnostics.length} 条提醒`}
      </summary>
      {critiqueNotes.length > 0 && (
        <div className="agent-critique-notes">
          <strong>视觉自审精修要点</strong>
          <ul>
            {critiqueNotes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </div>
      )}
      {toolTrace.length > 0 && (
        <ol>
          {toolTrace.map((item, i) => (
            <li key={i}>
              <div className="agent-tool-step">
                <code>{item.name}</code>
                <span className="agent-cap-pill" data-status={item.status}>
                  {{ ok: "完成", warning: "提醒", error: "失败" }[item.status]}
                </span>
              </div>
              <span className="agent-skill-meta">
                {item.summary} · {item.durationMs} ms
              </span>
              {item.detail && <p>{item.detail}</p>}
            </li>
          ))}
        </ol>
      )}
      {activatedSkills.length > 0 && (
        <div className="agent-chips-row" aria-label="已激活技能">
          {activatedSkills.map((name) => (
            <span className="agent-skill-badge" key={name}>
              <BookOpen size={10} />
              {name}
            </span>
          ))}
        </div>
      )}
      {diagnostics.map((d, i) => (
        <p key={i} className="agent-diagnostic" data-severity={d.severity}>
          <strong>{d.severity === "error" ? "错误" : "提醒"}</strong> ·{" "}
          {d.message}
          {d.suggestion && <span>{d.suggestion}</span>}
        </p>
      ))}
    </details>
  );
}

export function AgentPanel({
  document,
  selection,
  selectionCount,
  apply,
  focusNode,
  status,
  onStatusChange,
  onOpenConfig,
  pendingProposal,
  onPendingProposalChange,
  viewportCenter,
  externalChatRequest,
  cancelToken,
  onBusyChange,
  onUndoLastApply,
}: AgentPanelProps) {
  const hasSelection = Boolean(selection || selectionCount > 0);
  const [prompt, setPrompt] = useState("");
  const [input, setInput] = useState("");
  const [mentions, setMentions] = useState<AgentMention[]>([]);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);

  const [localStatus, setLocalStatus] = useState<AgentStatusResponse | null>(
    null,
  );
  const [connectionState, setConnectionState] = useState<
    "idle" | "checking" | "unavailable"
  >("idle");
  const [localConfigOpen, setLocalConfigOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [skillError, setSkillError] = useState("");
  const [switchingModel, setSwitchingModel] = useState(false);
  const [generationMode, setGenerationMode] = useState<GenerationMode>("auto");
  const [visualCritiqueEnabled, setVisualCritiqueEnabled] = useState(true);

  const [targetLibraryId, setTargetLibraryId] = useState("");
  const targetLibrary = document.libraries?.[targetLibraryId];
  const selectedLibraryId = targetLibrary?.id ?? "";
  useEffect(() => {
    if (targetLibraryId && !targetLibrary) changeTargetLibrary("");
  }, [targetLibraryId, targetLibrary]);
  const tiers = useMemo(
    () => targetLibrary && buildLibraryManifest(targetLibrary).tierCounts,
    [targetLibrary],
  );

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const latestAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && !m.discarded);
  function changeTargetLibrary(id: string) {
    setTargetLibraryId(id);
    const name = document.libraries?.[id]?.name ?? "自动 / 不限库";
    setMessages((previous) =>
      previous.map((m) =>
        m.scopeProposal &&
        !m.scopeConfirmed &&
        (m.scopeProposal.targetLibraryId ?? "") !== id
          ? {
              ...m,
              invalidatedReason: `目标组件库已切换为「${name}」，原范围规划已失效`,
            }
          : m,
      ),
    );
  }
  useLayoutEffect(() => {
    if (
      (selection || selectionCount > 0) &&
      messages.some(
        (m) => m.scopeProposal && !m.scopeConfirmed && !m.invalidatedReason,
      )
    )
      setMessages((previous) =>
        previous.map((m) =>
          m.scopeProposal && !m.scopeConfirmed && !m.invalidatedReason
            ? { ...m, invalidatedReason: selectionInvalidation }
            : m,
        ),
      );
  }, [selection, selectionCount, messages]);
  const [busy, setBusy] = useState(false);
  const [progressSteps, setProgressSteps] = useState<AgentChatProgress[]>([]);
  const [error, setError] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [localProposal, setLocalProposal] =
    useState<PendingAgentProposal | null>(null);
  const [activeProposalMsgId, setActiveProposalMsgId] = useState<string | null>(
    null,
  );
  const [appliedRevision, setAppliedRevision] = useState<number | null>(null);

  const abort = useRef<AbortController | null>(null);
  const refining = useRef<PendingAgentProposal | null>(null);
  const statusRequest = useRef<AbortController | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastExternalId = useRef<number>(0);
  const lastCancelToken = useRef<number>(cancelToken ?? 0);
  const prevProposalRef = useRef<PendingAgentProposal | null>(null);
  const prevRevisionRef = useRef<number>(document.revision);

  const effectiveStatus = status !== undefined ? status : localStatus;
  const activeProfile = effectiveStatus?.activeProfile ?? null;

  function updateSkills(list: SkillSummary[]) {
    const enabled = list.filter((skill) => skill.enabled);
    setSkills(enabled);
    setActiveSkills((previous) =>
      previous.filter((id) => enabled.some((skill) => skill.id === id)),
    );
  }

  useEffect(() => {
    if (!pickerOpen || !activeProfile) return;
    const controller = new AbortController();
    setSkillError("");
    void fetchSkills(controller.signal)
      .then(({ skills: list }) => {
        if (!controller.signal.aborted) updateSkills(list);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setSkillError(err.message);
      });
    return () => controller.abort();
  }, [pickerOpen, activeProfile?.id]);

  const connection: "idle" | "checking" | "ready" | "unavailable" =
    connectionState === "checking"
      ? "checking"
      : effectiveStatus?.configured
        ? "ready"
        : connectionState === "unavailable"
          ? "unavailable"
          : "idle";

  const activeProposal =
    pendingProposal !== undefined ? pendingProposal : localProposal;

  // Once this preview is accepted, discarded, replaced or stale, a late
  // critique must never put it back on the canvas.
  useLayoutEffect(
    () => () => {
      if (activeProposal && refining.current === activeProposal) {
        abort.current?.abort();
      }
    },
    [activeProposal],
  );

  const checkRunRevision = useRef<(() => boolean) | null>(null);
  useLayoutEffect(() => {
    checkRunRevision.current?.();
  }, [document.revision]);

  const selectedNode = useMemo(
    () => (selection ? document.nodes.find((n) => n.id === selection) : null),
    [document.nodes, selection],
  );

  // Keep latest values in refs for async chat invocations triggered externally
  const latestRef = useRef({
    document,
    selection,
    selectionCount,
    hasSelection,
    viewportCenter,
    effectiveStatus,
    messages,
  });
  latestRef.current = {
    document,
    selection,
    selectionCount,
    hasSelection,
    viewportCenter,
    effectiveStatus,
    messages,
  };

  useEffect(
    () => () => {
      abort.current?.abort();
      abort.current = null;
      statusRequest.current?.abort();
    },
    [],
  );

  const latestProgressText =
    progressSteps.length > 0
      ? progressSteps[progressSteps.length - 1].message
      : "";

  const onBusyChangeRef = useRef(onBusyChange);
  onBusyChangeRef.current = onBusyChange;

  useEffect(() => {
    onBusyChangeRef.current?.(busy, latestProgressText, error);
  }, [busy, latestProgressText, error]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length, progressSteps.length]);

  // Sync chat message badge when lifted pendingProposal is accepted/discarded via CanvasAgentBar HUD
  useEffect(() => {
    const prevProp = prevProposalRef.current;
    const prevRev = prevRevisionRef.current;
    prevProposalRef.current = activeProposal;
    prevRevisionRef.current = document.revision;
    if (prevProp && !activeProposal && activeProposalMsgId) {
      const wasApplied = document.revision > prevRev;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === activeProposalMsgId && !m.applied && !m.discarded
            ? wasApplied
              ? { ...m, applied: true }
              : { ...m, discarded: true }
            : m,
        ),
      );
      if (wasApplied) setAppliedRevision(document.revision);
      setActiveProposalMsgId(null);
    }
  }, [activeProposal, activeProposalMsgId, document.revision]);

  function updateStatus(next: AgentStatusResponse) {
    setLocalStatus(next);
    setConnectionState("idle");
    onStatusChange?.(next);
  }

  function updatePendingProposal(
    next: PendingAgentProposal | null,
    msgId: string | null = null,
  ) {
    if (next && next.source !== "chat") cancelChat();
    if (activeProposalMsgId && activeProposalMsgId !== msgId) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === activeProposalMsgId && !m.applied
            ? { ...m, discarded: true }
            : m,
        ),
      );
    }
    setLocalProposal(next);
    setActiveProposalMsgId(msgId);
    onPendingProposalChange?.(next);
  }

  function openModelConfig() {
    if (onOpenConfig) {
      onOpenConfig();
    } else {
      setLocalConfigOpen(true);
    }
  }

  async function connect() {
    statusRequest.current?.abort();
    const request = new AbortController();
    statusRequest.current = request;
    setConnectionState("checking");
    setError("");
    setStatusNote("");
    try {
      const next = await fetchAgentStatus(request.signal);
      if (request.signal.aborted) return;
      updateStatus(next);
      if (!next.configured) {
        setStatusNote("本机服务已就绪，请选择模型供应商");
      }
    } catch {
      if (!request.signal.aborted) {
        setConnectionState("unavailable");
      }
    }
  }

  async function handleModelSwitch(nextModel: string) {
    if (!activeProfile || nextModel === activeProfile.selectedModel) return;
    setSwitchingModel(true);
    setError("");
    try {
      const res = await updateProviderProfile(activeProfile.id, {
        selectedModel: nextModel,
      });
      updateStatus(res.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "切换模型失败");
    } finally {
      setSwitchingModel(false);
    }
  }

  function cancelChat(reportCancellation = false) {
    const controller = abort.current;
    if (!controller) return;
    if (reportCancellation) {
      if (refining.current) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === activeProposalMsgId
              ? {
                  ...m,
                  critiqueNotes: [
                    ...(m.critiqueNotes ?? []),
                    "已停止视觉自审，保留初稿。",
                  ],
                }
              : m,
          ),
        );
      } else {
        setError("已取消生成，设计未修改");
      }
    }
    controller.abort();
    abort.current = null;
    checkRunRevision.current = null;
    refining.current = null;
    setBusy(false);
    setProgressSteps([]);
  }

  async function runChat(inputReq: {
    prompt: string;
    mentions: AgentMention[];
    attachments?: AgentAttachment[];
    clearComposer?: boolean;
    fromCanvas?: boolean;
    confirmedScope?: ScopeProposal;
    scopeMessageId?: string;
    sourceSkills?: string[];
  }) {
    const trimmed = inputReq.prompt.trim();
    if (!trimmed) return;
    const {
      document: doc,
      selection: sel,
      selectionCount: count,
      hasSelection: selected,
      viewportCenter: center,
      effectiveStatus: currentStatus,
      messages: currentMessages,
    } = latestRef.current;

    abort.current?.abort();
    refining.current = null;
    const controller = new AbortController();
    abort.current = controller;

    const baseRevision = doc.revision;
    const roundSkills = inputReq.sourceSkills ?? activeSkills;
    const generation = chatGeneration(
      selected,
      generationMode,
      inputReq.confirmedScope,
    );
    const libraryId = generation.confirmedScope
      ? generation.confirmedScope.targetLibraryId
      : selectedLibraryId || undefined;
    let previewReady = false;
    const profile = currentStatus?.activeProfile;
    const context = {
      prompt: trimmed,
      document: doc,
      selection: sel,
    };
    setActiveSkills([]);
    setPickerOpen(false);
    const userMsgId = `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: "user",
      text: trimmed,
      mentions: inputReq.mentions.length ? inputReq.mentions : undefined,
      attachments:
        profile?.capabilities.supportsVision && inputReq.attachments?.length
          ? inputReq.attachments
          : undefined,
    };

    const history: AgentHistoryTurn[] = currentMessages.slice(-8).map((m) => ({
      role: m.role,
      text: m.summary ? `${m.text}\n(${m.summary})` : m.text,
    }));

    setMessages((prev) => [
      ...prev.map((m) =>
        generation.confirmedScope && m.id === inputReq.scopeMessageId
          ? { ...m, scopeConfirmed: true, scopeAttemptId: userMsgId }
          : m,
      ),
      userMsg,
    ]);
    setBusy(true);
    setError("");
    setStatusNote("");
    setAppliedRevision(null);
    setProgressSteps([
      { stage: "analyzing", message: "正在分析当前画布与设计系统…" },
    ]);
    updatePendingProposal(null);
    if (inputReq.clearComposer) {
      setPrompt("");
      setMentions([]);
      setAttachments([]);
      setMentionOpen(false);
    }

    const assistantMsgId = `a-${userMsgId}`;
    function restoreScope() {
      if (inputReq.scopeMessageId)
        setMessages((previous) =>
          previous.map((m) =>
            m.scopeAttemptId === userMsgId
              ? {
                  ...m,
                  scopeConfirmed: false,
                  scopeAttemptId: undefined,
                  scopeRetryInput: {
                    prompt: trimmed,
                    mentions: inputReq.mentions,
                    attachments: userMsg.attachments,
                  },
                }
              : m,
          ),
        );
    }
    function isCurrent() {
      if (abort.current !== controller || controller.signal.aborted)
        return false;
      if (latestRef.current.document.revision === baseRevision) return true;
      controller.abort();
      restoreScope();
      setBusy(false);
      setProgressSteps([]);
      setError("生成期间文档已修改，已丢弃过期提案，可重新确认或发送");
      if (previewReady) {
        previewReady = false;
        setMessages((previous) =>
          previous.map((m) =>
            m.id === assistantMsgId ? { ...m, discarded: true } : m,
          ),
        );
        updatePendingProposal(null);
      }
      return false;
    }
    checkRunRevision.current = isCurrent;
    function reportProgress(progress: AgentChatProgress) {
      if (controller.signal.aborted) return;
      setProgressSteps((prev) => {
        const last = prev.at(-1);
        return last?.stage === progress.stage &&
          last.message === progress.message
          ? prev
          : [...prev.slice(-6), progress];
      });
    }
    try {
      const result = await streamAgentChat(
        {
          ...context,
          selectionCount: count,
          targetLibraryId: libraryId,
          ...generation,
          memoryScope: { projectId: doc.id, libraryId },
          profileId: profile?.id,
          model: profile?.selectedModel,
          history,
          mentions: inputReq.mentions.length ? inputReq.mentions : undefined,
          attachments: userMsg.attachments,
          viewportCenter: center,
          activeSkills: roundSkills.length ? roundSkills : undefined,
        },
        reportProgress,
        controller.signal,
      );

      if (!isCurrent()) return;
      const draftLibraryId = result.targetLibraryId ?? libraryId;
      let proposal: PendingAgentProposal | undefined;
      const diagnostics = [...(result.diagnostics ?? [])];
      if (result.transaction) {
        const tx = validateProposal(context, result.transaction);
        proposal = {
          transaction: tx,
          summary: result.summary || `${tx.operations.length} 项改动`,
          reply: result.reply,
          createdRootIds: result.createdRootIds?.length
            ? result.createdRootIds
            : extractCreatedRootIds(tx),
          stats: result.stats,
          source: "chat",
        };
      } else if (result.htmlDraft) {
        reportProgress({
          stage: "validating",
          message: "正在沙盒排版并编译原生图层…",
        });
        const compiled = await compileDraftProposal(
          result.htmlDraft,
          context,
          center,
          draftLibraryId,
        );
        if (!isCurrent()) return;
        proposal = compiled;
        diagnostics.push(...compiled.diagnostics);
      }

      const assistantMsg: ChatMessage = {
        id: assistantMsgId,
        role: "assistant",
        text:
          result.reply ||
          proposal?.reply ||
          result.summary ||
          (proposal
            ? `已生成 ${proposal.transaction.operations.length} 项设计改动，可预览并应用到画布。`
            : "已完成分析。"),
        summary: proposal?.summary ?? result.summary,
        mode: result.mode,
        ...(result.mode === "clarify" &&
          result.scopeProposal && {
            scopeProposal: {
              ...result.scopeProposal,
              targetLibraryId:
                draftLibraryId ?? result.scopeProposal.targetLibraryId,
            },
            sourcePrompt: trimmed,
            sourceMessageId: userMsgId,
            sourceSkills: roundSkills,
          }),
        toolTrace: result.toolTrace,
        activatedSkills: result.activatedSkills,
        diagnostics: [...diagnostics],
        critiqueNotes: result.critiqueNotes,
        stats: proposal?.stats ?? result.stats,
        modelUsed: result.modelUsed,
        providerName: result.providerName,
        proposalId: proposal ? assistantMsgId : undefined,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      if (inputReq.fromCanvas && assistantMsg.scopeProposal)
        window.dispatchEvent(new Event(canvasScopeReady));

      if (!proposal) return;
      previewReady = true;
      updatePendingProposal(proposal, assistantMsgId);
      const rootId = proposal.createdRootIds[0];
      if (
        !result.htmlDraft ||
        result.transaction ||
        !visualCritiqueEnabled ||
        !profile?.capabilities.supportsVision ||
        !rootId ||
        controller.signal.aborted
      )
        return;

      refining.current = proposal;
      reportProgress({
        stage: "repairing",
        message: "正在截屏执行多模态视觉自审精修…",
      });
      let toolTrace = result.toolTrace ?? [];
      let critiqueNotes = result.critiqueNotes ?? [];
      let refined: PendingAgentProposal | undefined;
      try {
        const shadowDoc = transact(doc, proposal.transaction);
        const boards = result.htmlDraft.artboards ?? [result.htmlDraft];
        const renderedImages = [];
        for (const [index, id] of proposal.createdRootIds.entries()) {
          const board = boards[index];
          const dataUrl = await captureFormaArtboardPng(shadowDoc, id, 1);
          if (!isCurrent()) return;
          renderedImages.push({
            refId: result.htmlDraft.artboards?.[index]?.refId,
            name: board.name,
            dataUrl,
          });
        }
        const critique = await requestVisualCritique(
          {
            ...context,
            htmlDraft: {
              ...result.htmlDraft,
              targetLibraryId:
                result.htmlDraft.targetLibraryId ?? draftLibraryId,
            },
            renderedImageDataUrl: renderedImages[0].dataUrl,
            renderedImages:
              renderedImages.length > 1 ? renderedImages : undefined,
            profileId: profile.id,
            model: profile.selectedModel,
            activeSkills: roundSkills,
          },
          controller.signal,
        );
        if (!isCurrent()) return;
        toolTrace = [...toolTrace, ...critique.toolTrace];
        critiqueNotes = [...critiqueNotes, ...critique.critiqueNotes];
        if (critique.improved && critique.htmlDraft) {
          const compiled = await compileDraftProposal(
            critique.htmlDraft,
            context,
            center,
            result.htmlDraft.targetLibraryId ?? draftLibraryId,
          );
          if (!isCurrent()) return;
          refined = compiled;
          for (const warning of compiled.diagnostics)
            if (
              !diagnostics.some(
                (d) => d.code === warning.code && d.message === warning.message,
              )
            )
              diagnostics.push(warning);
          refined.reply = critique.reply || refined.reply;
          refined.summary = critique.summary || refined.summary;
          updatePendingProposal(refined, assistantMsgId);
        }
      } catch (err) {
        if (!isCurrent()) return;
        critiqueNotes = [
          ...critiqueNotes,
          `已保留初稿。视觉自审未完成：${err instanceof Error ? err.message : "无法取得精修结果"}`,
        ];
      }
      const changes = {
        diagnostics: [...diagnostics],
        toolTrace,
        critiqueNotes,
        ...(refined && {
          text: refined.reply,
          summary: refined.summary,
          stats: refined.stats,
        }),
      };
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMsgId ? { ...m, ...changes } : m)),
      );
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : "生成失败");
    } finally {
      if (!previewReady) restoreScope();
      if (abort.current === controller) {
        checkRunRevision.current = null;
        setBusy(false);
        setProgressSteps([]);
        refining.current = null;
        abort.current = null;
      }
    }
  }

  function submitComposer(
    card = latestAssistant,
    canvasInput?: ComposerInput,
    retry = false,
  ) {
    const input =
      canvasInput ??
      (retry
        ? { prompt: "", mentions: [], attachments: [] }
        : { prompt, mentions, attachments });
    const origin = {
      clearComposer: !canvasInput && !retry,
      fromCanvas: !!canvasInput,
    };
    const scope = card?.scopeProposal;
    const supplement = input.prompt.trim();
    if (
      !card ||
      !scope ||
      card.scopeConfirmed ||
      scopeProblem(
        card,
        selection,
        generationMode,
        document.libraries,
        selectionCount,
      )
    ) {
      if (supplement) void runChat({ ...input, ...origin });
      return;
    }
    const original = messages.find((m) => m.id === card.sourceMessageId);
    void runChat({
      ...origin,
      ...composeConfirmedScope(scope, card, input, original),
      scopeMessageId: card.id,
      sourceSkills: [
        ...new Set([...(card.sourceSkills ?? []), ...activeSkills]),
      ],
    });
  }

  // Trigger chat when CanvasAgentBar dispatches a request via App.tsx
  const submitRef = useRef(submitComposer);
  submitRef.current = submitComposer;

  useEffect(() => {
    if (
      externalChatRequest &&
      externalChatRequest.id !== lastExternalId.current
    ) {
      lastExternalId.current = externalChatRequest.id;
      submitRef.current(undefined, externalChatRequest);
    }
  }, [externalChatRequest]);

  // Cancel active stream when App.tsx increments cancelToken
  useEffect(() => {
    if (cancelToken !== undefined && cancelToken !== lastCancelToken.current) {
      lastCancelToken.current = cancelToken;
      cancelChat(true);
    }
  }, [cancelToken]);

  function handleApplyProposal() {
    if (!activeProposal) return;
    try {
      apply(activeProposal.transaction);
      if (activeProposalMsgId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === activeProposalMsgId ? { ...m, applied: true } : m,
          ),
        );
      }
      updatePendingProposal(null);
      setAppliedRevision(activeProposal.transaction.baseRevision + 1);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleDiscardProposal() {
    updatePendingProposal(null);
  }

  function receiveExternalProposal(tx: Transaction) {
    setError("");
    setAppliedRevision(null);
    updatePendingProposal({
      transaction: tx,
      summary: `外部 Agent 提案（${tx.operations.length} 项改动）`,
      reply: "",
      createdRootIds: extractCreatedRootIds(tx),
      source: "external",
    });
  }

  async function handleAddImages(files: FileList | null) {
    if (!files || !files.length) return;
    setError("");
    const added: AgentAttachment[] = [];
    for (const file of Array.from(files).slice(0, 3 - attachments.length)) {
      try {
        added.push(await readImageFileAsAttachment(file));
      } catch (err) {
        setError(err instanceof Error ? err.message : "读取参考图失败");
      }
    }
    if (added.length) {
      setAttachments((prev) => [...prev, ...added].slice(0, 3));
    }
  }

  const supportsVision = Boolean(activeProfile?.capabilities.supportsVision);
  const critiqueTip = supportsVision
    ? "截取初稿画板，请当前模型检查排版并精修"
    : "选择支持视觉识图的模型后可开启精修";
  const quickPrompts = hasSelection ? SELECTION_PROMPTS : PAGE_PROMPTS;
  const activeModels =
    activeProfile && activeProfile.models.length > 0
      ? activeProfile.models
      : activeProfile
        ? [
            {
              id: activeProfile.selectedModel,
              label: activeProfile.selectedModel,
              capabilities: activeProfile.capabilities,
            },
          ]
        : [];
  const profileBadge = activeProfile
    ? providerBadgeStyle(activeProfile.providerId)
    : null;

  return (
    <div className="panel-body agent-panel-root">
      {/* Header Row */}
      <div className="agent-panel-header">
        <Sparkles
          size={15}
          style={{ color: "var(--figma-blue)", flexShrink: 0 }}
        />
        <strong>Forma AI</strong>
        <span
          className="agent-scope-badge"
          title={
            selectedNode
              ? `当前选区：${selectedNode.name}`
              : selectionCount > 1
                ? `已选 ${selectionCount} 层 · 作用于当前页面`
                : "当前页面"
          }
        >
          {selectedNode
            ? `选区 · ${selectedNode.name}`
            : selection
              ? "当前选区"
              : selectionCount > 1
                ? `已选 ${selectionCount} 层`
                : "当前页面"}
        </span>
        {messages.length > 0 && (
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="清空对话历史"
            title="清空对话历史"
            data-tip="清空对话"
            data-tip-desc="重置当前多轮 AI 对话记录"
            data-tip-side="bottom"
            disabled={busy}
            onClick={() => {
              setMessages([]);
              setAppliedRevision(null);
              setError("");
            }}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {/* Connection Status Row — keeps exact "未连接模型" inside role="status" */}
      <div className="agent-connection">
        <div className="agent-connection-left">
          <span role="status" className="agent-connection-status">
            <i
              aria-hidden="true"
              className={`agent-status-dot ${
                connection === "ready"
                  ? "is-ready"
                  : connection === "unavailable"
                    ? "is-unavailable"
                    : connection === "checking"
                      ? "is-checking"
                      : ""
              }`}
            />
            {
              {
                idle: "未连接模型",
                checking: "正在连接…",
                ready: "模型已连接",
                unavailable: "模型服务不可用",
              }[connection]
            }
          </span>
          {connection === "ready" && activeProfile && (
            <span
              className="agent-connection-provider"
              title={`${activeProfile.providerName} · ${activeProfile.selectedModel}`}
            >
              {activeProfile.providerName}
            </span>
          )}
        </div>

        <div className="agent-connection-actions">
          {connection !== "ready" && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              title="连接模型服务"
              aria-label="连接模型服务"
              data-tip="连接模型服务"
              data-tip-desc="检测本机 AI 模型服务连接状态"
              data-tip-side="bottom"
              disabled={connection === "checking"}
              onClick={() => void connect()}
            >
              <Plug size={14} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            title="配置模型供应商"
            aria-label="配置模型供应商"
            data-tip="配置模型供应商"
            data-tip-desc="配置 OpenAI、Claude、Gemini、Kimi、DeepSeek 等 API Key 与模型"
            data-tip-side="bottom"
            onClick={openModelConfig}
          >
            <Settings2 size={14} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="管理设计技能（Skills）"
            title="管理设计技能（Skills）"
            data-tip="管理设计技能"
            data-tip-desc="查看、启停或导入第三方 SKILL.md"
            data-tip-side="bottom"
            onClick={() => {
              setPickerOpen(false);
              setSkillsOpen(true);
            }}
          >
            <BookOpen size={14} />
          </button>
        </div>
      </div>

      {connection !== "ready" && (
        <div className="agent-setup-nudge">
          <span>{statusNote || "选择供应商并连接模型后即可生成设计"}</span>
          <button type="button" onClick={openModelConfig}>
            配置模型
          </button>
        </div>
      )}

      {/* Connected Active Model Switcher + Capability Pills */}
      {connection === "ready" && activeProfile && (
        <div className="agent-model-bar">
          <div className="agent-model-select-row">
            {profileBadge && (
              <span
                className="agent-vendor-badge agent-vendor-badge-sm"
                style={{ background: profileBadge.accent }}
                aria-hidden="true"
              >
                {profileBadge.monogram}
              </span>
            )}
            <select
              aria-label="切换当前模型"
              value={activeProfile.selectedModel}
              disabled={
                busy || switchingModel || activeProfile.source === "env"
              }
              onChange={(ev) => void handleModelSwitch(ev.target.value)}
            >
              {activeModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label || m.id}
                  {m.recommended ? " ★" : ""}
                </option>
              ))}
            </select>
          </div>

          <CapabilityPills capabilities={activeProfile.capabilities} compact />
        </div>
      )}

      {/* Multi-Turn Chat Thread */}
      {messages.length > 0 && (
        <div className="agent-chat-thread" role="log" aria-label="AI 对话记录">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`agent-msg ${msg.role === "user" ? "agent-msg-user" : "agent-msg-assistant"}`}
            >
              <div className="agent-msg-head">
                <span className="agent-msg-role">
                  {msg.role === "user" ? "设计师" : "Forma AI"}
                  {msg.modelUsed ? ` · ${msg.modelUsed}` : ""}
                </span>
                {msg.applied && (
                  <span className="agent-msg-badge">
                    <Check size={10} />
                    已应用
                  </span>
                )}
                {msg.discarded && (
                  <span className="agent-msg-badge is-discarded">已丢弃</span>
                )}
              </div>

              {msg.mentions && msg.mentions.length > 0 && (
                <div className="agent-chips-row">
                  {msg.mentions.map((m) => (
                    <span
                      key={`${m.kind}:${m.id}`}
                      className="agent-mention-chip"
                    >
                      <MentionKindIcon kind={m.kind} />
                      <span className="agent-chip-label">@{m.label}</span>
                    </span>
                  ))}
                </div>
              )}

              {msg.attachments && msg.attachments.length > 0 && (
                <div className="agent-chips-row">
                  {msg.attachments.map((att, idx) => (
                    <span
                      key={`${att.name}:${idx}`}
                      className="agent-attachment-chip"
                    >
                      <img
                        className="agent-attachment-thumb"
                        src={att.dataUrl}
                        alt={att.name}
                      />
                      <span className="agent-chip-label">{att.name}</span>
                    </span>
                  ))}
                </div>
              )}

              <div className="agent-msg-text">{msg.text}</div>

              {msg.scopeProposal && (
                <ScopeProposalCard
                  scope={msg.scopeProposal}
                  choices={
                    msg.scopeChoices ??
                    msg.scopeProposal.decisions?.map((d) => d.defaultChoice) ??
                    []
                  }
                  invalidatedReason={scopeProblem(
                    msg,
                    selection,
                    generationMode,
                    document.libraries,
                    selectionCount,
                  )}
                  onChoice={(index, choice) =>
                    setMessages((previous) =>
                      previous.map((m) =>
                        m.id === msg.id
                          ? {
                              ...m,
                              scopeChoices: m.scopeProposal?.decisions?.map(
                                (d, i) =>
                                  i === index
                                    ? choice
                                    : (m.scopeChoices?.[i] ?? d.defaultChoice),
                              ),
                            }
                          : m,
                      ),
                    )
                  }
                  confirmed={!!msg.scopeConfirmed}
                  disabled={
                    busy || msg !== latestAssistant || connection !== "ready"
                  }
                  onConfirm={() =>
                    submitComposer(msg, undefined, !!msg.scopeRetryInput)
                  }
                />
              )}
              {msg.stats && <StatsPills stats={msg.stats} />}
              {msg.role === "assistant" && <CallDetails message={msg} />}
            </div>
          ))}
          <div ref={threadEndRef} />
        </div>
      )}

      {/* Live Streaming Progress Timeline */}
      {busy && progressSteps.length > 0 && (
        <div
          className="agent-progress-timeline"
          role="status"
          aria-live="polite"
        >
          {progressSteps.map((step, idx) => {
            const isLatest = idx === progressSteps.length - 1;
            return (
              <div
                key={`${step.stage}:${idx}`}
                className={`agent-progress-step ${isLatest ? "is-latest" : ""}`}
              >
                {isLatest ? (
                  <Loader2
                    size={12}
                    className="agent-spin"
                    style={{
                      color: "var(--figma-blue)",
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  />
                ) : (
                  <CheckCircle2
                    size={12}
                    style={{
                      color: "var(--figma-green)",
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  />
                )}
                <span>
                  {step.message}
                  {step.detail ? `（${step.detail}）` : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Composer */}
      <div className="agent-composer">
        {mentionOpen && (
          <AgentMentionPopover
            document={document}
            attached={mentions}
            placement="inline"
            onSelect={(item) => {
              setMentions((prev) =>
                prev.some((m) => m.kind === item.kind && m.id === item.id)
                  ? prev
                  : [...prev, item],
              );
              setMentionOpen(false);
            }}
            onClose={() => setMentionOpen(false)}
          />
        )}

        {(mentions.length > 0 || attachments.length > 0) && (
          <div className="agent-chips-row">
            {mentions.map((m) => (
              <span key={`${m.kind}:${m.id}`} className="agent-mention-chip">
                <MentionKindIcon kind={m.kind} />
                <span className="agent-chip-label">@{m.label}</span>
                <button
                  type="button"
                  className="agent-chip-remove"
                  aria-label={`移除引用 ${m.label}`}
                  title={`移除引用 ${m.label}`}
                  data-tip="移除引用"
                  data-tip-side="top"
                  onClick={() =>
                    setMentions((prev) =>
                      prev.filter(
                        (item) => !(item.kind === m.kind && item.id === m.id),
                      ),
                    )
                  }
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            {attachments.map((att, idx) => (
              <span
                key={`${att.name}:${idx}`}
                className="agent-attachment-chip"
              >
                <img
                  className="agent-attachment-thumb"
                  src={att.dataUrl}
                  alt={att.name}
                />
                <span className="agent-chip-label">{att.name}</span>
                <button
                  type="button"
                  className="agent-chip-remove"
                  aria-label={`移除参考图 ${att.name}`}
                  title={`移除参考图 ${att.name}`}
                  data-tip="移除参考图"
                  data-tip-side="top"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((_, i) => i !== idx))
                  }
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        {activeSkills.length > 0 && (
          <div className="agent-chips-row" aria-label="本轮已选技能">
            {activeSkills.map((id) => (
              <button
                type="button"
                key={id}
                className="agent-skill-badge"
                aria-label={"移除本轮技能 " + id}
                title="移除本轮技能"
                data-tip="移除本轮技能"
                data-tip-side="top"
                onClick={() =>
                  setActiveSkills((list) => list.filter((item) => item !== id))
                }
              >
                <BookOpen size={11} />
                {skills?.find((skill) => skill.id === id)?.name ?? id}
                <X size={10} />
              </button>
            ))}
          </div>
        )}
        {pickerOpen && activeProfile && (
          <div
            className="agent-skill-picker"
            role="group"
            aria-label="选择本轮技能"
          >
            {skillError ? (
              <p role="alert">{skillError}</p>
            ) : !skills ? (
              <span role="status">正在读取技能…</span>
            ) : !skills.length ? (
              <span>暂无启用的技能</span>
            ) : (
              skills.map((skill) => (
                <label key={skill.id} title={skill.description}>
                  <input
                    type="checkbox"
                    checked={activeSkills.includes(skill.id)}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setActiveSkills((previous) =>
                        checked
                          ? [...previous, skill.id]
                          : previous.filter((id) => id !== skill.id),
                      );
                    }}
                  />
                  {skill.name}
                </label>
              ))
            )}
          </div>
        )}
        <div className="agent-target-library">
          <label>
            <span>目标组件库</span>
            <select
              aria-label="目标组件库"
              value={selectedLibraryId}
              disabled={busy}
              onChange={(event) => changeTargetLibrary(event.target.value)}
            >
              <option value="">自动 / 不限库</option>
              {Object.values(document.libraries ?? {}).map((lib) => (
                <option key={lib.id} value={lib.id}>
                  {lib.name} · {lib.components.length} 组件
                </option>
              ))}
            </select>
          </label>
          {tiers && (
            <small>
              AI 说明书就绪 · P{tiers.page}/B{tiers.block}/C{tiers.component}
            </small>
          )}
        </div>
        {hasSelection && generationMode === "html" && (
          <small className="agent-mode-note" role="status">
            当前选区将使用蓝图编辑
          </small>
        )}
        <div className="agent-composer-toolbar">
          <select
            className="agent-generation-mode"
            aria-label="生成引擎模式"
            title="生成引擎模式"
            data-tip="生成引擎模式"
            data-tip-desc="智能模式按选区选择引擎，现代精排生成新画板，蓝图编辑可修改选区"
            data-tip-side="top"
            disabled={busy}
            value={generationMode}
            onChange={(ev) =>
              setGenerationMode(ev.target.value as GenerationMode)
            }
          >
            <option value="auto">智能模式</option>
            <option value="html">现代精排（新建画板）</option>
            <option value="blueprint">蓝图编辑</option>
          </select>
          <button
            type="button"
            className="agent-critique-toggle"
            aria-label="视觉自审精修"
            title={critiqueTip}
            data-tip="视觉自审精修"
            data-tip-desc={critiqueTip}
            data-tip-side="top"
            aria-pressed={supportsVision && visualCritiqueEnabled}
            disabled={!supportsVision || busy}
            onClick={() => setVisualCritiqueEnabled((value) => !value)}
          >
            <ScanEye size={13} aria-hidden="true" />
            自审
          </button>
          {activeProfile && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label="选择本轮技能"
              title="选择本轮技能"
              data-tip="选择本轮技能"
              data-tip-desc="所选技能用于下一条面板或画布指令"
              data-tip-side="top"
              aria-expanded={pickerOpen}
              disabled={busy}
              onClick={() => setPickerOpen(!pickerOpen)}
            >
              <BookOpen size={13} />
            </button>
          )}
          <button
            type="button"
            className={`icon-btn icon-btn-sm ${mentionOpen ? "active" : ""}`}
            aria-label="引用组件、变量、样式或画板"
            aria-expanded={mentionOpen}
            title="引用设计元素 @"
            data-tip="@引用设计元素"
            data-tip-desc="在需求中引用文档的组件、变量、样式或画板"
            data-tip-side="top"
            disabled={busy}
            onClick={() => setMentionOpen((v) => !v)}
          >
            <AtSign size={13} />
          </button>

          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="上传参考图"
            title="上传参考图"
            data-tip="上传参考图"
            data-tip-desc={
              connection !== "ready"
                ? "连接支持视觉识图的模型后可上传参考图"
                : supportsVision
                  ? "上传界面截图或草图供 AI 视觉参考（最多 3 张）"
                  : "可在模型设置 → 已保存连接中刷新或手动开启视觉"
            }
            data-tip-side="top"
            disabled={
              busy ||
              connection !== "ready" ||
              !supportsVision ||
              attachments.length >= 3
            }
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus size={13} />
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            hidden
            onChange={(ev) => {
              void handleAddImages(ev.currentTarget.files);
              ev.currentTarget.value = "";
            }}
          />
        </div>

        <textarea
          aria-label="设计需求"
          placeholder="描述页面目标、用户和视觉方向…（⌘↵ 提交）"
          value={prompt}
          disabled={busy}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(ev) => {
            if (
              (ev.metaKey || ev.ctrlKey) &&
              ev.key === "Enter" &&
              prompt.trim() &&
              connection === "ready" &&
              !busy
            ) {
              ev.preventDefault();
              submitComposer();
            }
          }}
        />

        {/* Context-Aware Quick Prompt Chips */}
        {!busy && (
          <div className="agent-quick-chips" aria-label="快捷设计需求">
            {quickPrompts.map((chip) => (
              <button
                key={chip}
                type="button"
                className="agent-quick-chip"
                onClick={() => setPrompt(chip)}
              >
                {chip}
              </button>
            ))}
          </div>
        )}

        {busy ? (
          <button
            type="button"
            className="wide agent-cancel-btn"
            onClick={() => cancelChat(true)}
          >
            <Loader2 size={13} className="agent-spin" />
            正在生成 · 取消
          </button>
        ) : (
          <button
            type="button"
            className="primary wide"
            disabled={!prompt.trim() || connection !== "ready"}
            onClick={() => submitComposer()}
          >
            <Sparkles size={14} />
            生成设计
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}

      {/* Post-Apply Undo Bar */}
      {appliedRevision === document.revision && !activeProposal && (
        <div className="agent-undo-bar" role="status">
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
          >
            <Check size={13} />
            已应用到画布
          </span>
          {onUndoLastApply ? (
            <button
              type="button"
              onClick={() => {
                onUndoLastApply();
                setAppliedRevision(null);
              }}
            >
              <Undo2 size={12} />
              撤回上次应用
            </button>
          ) : (
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
              按 ⌘Z 可撤回
            </span>
          )}
        </div>
      )}

      {/* Pending Proposal Preview & Operation List */}
      {activeProposal && (
        <div className="proposal">
          <h3>
            <Sparkles size={13} style={{ color: "var(--figma-purple-soft)" }} />
            {activeProposal.transaction.operations.length} 项改动
          </h3>
          {activeProposal.summary && <p>{activeProposal.summary}</p>}
          {activeProposal.stats && <StatsPills stats={activeProposal.stats} />}
          <p>
            基于版本 {activeProposal.transaction.baseRevision}
            {activeProposal.transaction.baseRevision !== document.revision
              ? " · 文件已改变，请重新生成"
              : ""}
          </p>
          <ul>
            {activeProposal.transaction.operations.map((op, i) => {
              const id =
                op.type === "create"
                  ? op.node.parentId
                  : op.type === "insertComponent"
                    ? op.parentId
                    : "id" in op &&
                        !["putToken", "putImage", "putFont"].includes(op.type)
                      ? op.id
                      : undefined;
              const target = document.nodes.find((n) => n.id === id);
              const targetName =
                op.type === "create"
                  ? op.node.name
                  : op.type === "insertComponent"
                    ? op.componentId
                    : op.type === "putLibrary" || op.type === "updateLibrary"
                      ? op.library.name
                      : (target?.name ?? ("id" in op ? op.id : "设计系统"));
              return (
                <li key={i}>
                  {target && focusNode ? (
                    <button
                      type="button"
                      style={{
                        padding: "1px 4px",
                        borderRadius: 4,
                        textAlign: "left",
                      }}
                      data-tip={`定位图层 ${target.name}`}
                      onClick={() => focusNode(target.id)}
                    >
                      {op.type} · {targetName}
                    </button>
                  ) : (
                    <>
                      {op.type} · {targetName}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="agent-proposal-actions">
            <button
              type="button"
              className="primary wide"
              disabled={
                activeProposal.transaction.baseRevision !== document.revision
              }
              onClick={handleApplyProposal}
            >
              应用到设计
            </button>
            <button
              type="button"
              className="wide"
              onClick={handleDiscardProposal}
            >
              丢弃结果
            </button>
          </div>
        </div>
      )}

      {/* External Agent / Manual JSON Transaction Import — 100% preserved contract */}
      <details className="agent-external-details">
        <summary>外部 Agent / 事务导入</summary>
        <div className="agent-external-body">
          <ExternalAgentSession
            key={document.id}
            document={document}
            selection={selection}
            receive={receiveExternalProposal}
          />
          <button
            type="button"
            className="wide"
            onClick={() =>
              download(
                "agent-context.json",
                JSON.stringify({ document, selection }, null, 2),
              )
            }
          >
            <Download size={14} />
            导出上下文
          </button>
          <p>基准版本 {document.revision}。事务协议见项目文档。</p>
          <textarea
            aria-label="Agent 事务 JSON"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="粘贴事务 JSON"
          />
          <button
            type="button"
            className="wide"
            disabled={!input.trim()}
            onClick={() => {
              try {
                const validated = validateProposal(
                  { prompt: "", document, selection },
                  JSON.parse(input),
                );
                updatePendingProposal({
                  transaction: validated,
                  summary: `导入事务（${validated.operations.length} 项改动）`,
                  reply: "",
                  createdRootIds: extractCreatedRootIds(validated),
                  source: "manual",
                });
                setInput("");
                setError("");
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            校验并预览
          </button>
        </div>
      </details>

      {skillsOpen && (
        <SkillsModal
          onClose={() => setSkillsOpen(false)}
          onListChange={updateSkills}
        />
      )}

      {/* Fallback standalone config modal if parent did not provide onOpenConfig */}
      {!onOpenConfig && (
        <ModelConfigModal
          open={localConfigOpen}
          onClose={() => setLocalConfigOpen(false)}
          status={effectiveStatus}
          onStatusChange={updateStatus}
        />
      )}
    </div>
  );
}
