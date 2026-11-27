import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
} from "react";
import type { DesignDocument } from "../../domain/document";
import { transact } from "../../domain/commands";
import type { AgentProgressStage } from "../../agent/design-engine";
import {
  buildManualEpisodeFromSelection,
  episodeIdentityKey,
  rankProjectEpisodes,
  resolveProjectMemoryScope,
  type DesignEpisode,
  type ProjectSpace,
} from "../../agent/project-memory";
import {
  FileLifetimeMismatchError,
  getFileProjectSpace,
  isFileLifetimeMismatchError,
  isProjectMemoryUnavailableError,
  listScopeEpisodes,
  saveDesignEpisodeWithReceipt,
  subscribeProjectMemory,
} from "../../infrastructure/project-memory-store";
import {
  validateProposal,
  type GenerationContext,
  type Transaction,
} from "../../agent/provider";
import {
  canvasScopeReady,
  MAX_EPISODE_MENTIONS,
  episodeLimitReached,
  episodeMentionLimitNote,
  type AgentMentionPopover,
  type PendingAgentProposal,
} from "../CanvasAgentBar";
import {
  fetchAgentStatus,
  fetchSkills,
  hasConfiguredAgentHint,
  formatContextWindow,
  type SkillSummary,
  providerBadgeStyle,
  readImageFileAsAttachment,
  requestVisualCritique,
  streamAgentChat,
  updateProviderProfile,
  type AgentAttachment,
  type AgentChatProgress,
  type CompileDiagnostic,
  type AgentHistoryTurn,
  type AgentMention,
  type AgentStatusResponse,
  type GenerationMode,
  type ScopeProposal,
  type HtmlDesignDraftProposal,
} from "../agent-client";
import {
  FIXED_PROGRESS_LABELS,
  HTML_COMPILE_PROGRESS,
  mentionIdentity,
  PAGE_PROMPTS,
  SELECTION_PROMPTS,
  VISUAL_CRITIQUE_PROGRESS,
  type AppliedProposalEvent,
  type ChatMessage,
  type ComposerInput,
  type ComposerMention,
  type ExternalChatRequest,
  type SessionIdentity,
} from "./agent-copy";
import {
  archiveAppliedProposal,
  type EpisodeDrawerProps,
  lifetimeMismatchMessage,
  projectMemoryReadErrorMessage,
  projectMemoryUnavailableNotice,
  readFileProjectEpisodes,
  useEpisodeArchive,
} from "./EpisodeDrawer";

import {
  applyScopeChoiceToMessages,
  buildEpisodeMeta,
  buildInvalidatedLibraryScopeMessages,
  buildInvalidatedSelectionScopeMessages,
  captureExternalMentions,
  capturePickerMention,
  chatGeneration,
  composeConfirmedScope,
  extractCreatedRootIds,
  findInstalledLibrary,
  hasAgentSelection,
  scopeProblem,
  scopeVerificationFailed,
  staleEpisodeMention,
  staleProposalMessage,
} from "../../application/agent-session";

export interface AgentPanelProps {
  document: DesignDocument;
  activePageId?: string;
  fileKey?: string;
  getFileLifetimeToken?: () => Promise<string | undefined> | string | undefined;
  getFileDocumentEpoch?: () => Promise<number | undefined> | number | undefined;
  fileLifetimeInvalid?: boolean;
  onFileLifetimeInvalidated?(): void;
  activeProject?: ProjectSpace | null;
  onProjectScopeChanged?(project: ProjectSpace | null, message: string): void;
  projectEpisodes?: DesignEpisode[];
  episodeArchive?: ReturnType<typeof useEpisodeArchive>;
  onRefreshEpisodes?(): void;
  onOpenFileBrowser?(): void;
  onOpenPromoteModule?(): void;
  canPromoteSelection?: boolean;
  onInstallProjectLibrary?(libraryId: string): Promise<void> | void;
  selection: string | null;
  selectionIds?: string[];
  selectionCount: number;
  apply?(transaction: Transaction): DesignDocument | void;
  onCommitProposal?(
    proposal: PendingAgentProposal,
  ): Promise<boolean | void> | void;
  lastAppliedProposalEvent?: AppliedProposalEvent | null;
  onExternalChatConsumed?(id: number): void;
  focusNode?(id: string): void;
  status?: AgentStatusResponse | null;
  onStatusChange?(status: AgentStatusResponse): void;
  onOpenConfig?(): void;
  pendingProposal?: PendingAgentProposal | null;
  applyingProposal?: boolean;
  onPendingProposalChange?(proposal: PendingAgentProposal | null): void;
  viewportCenter?: { x: number; y: number };
  externalChatRequest?: ExternalChatRequest | null;
  cancelToken?: number;
  onBusyChange?(busy: boolean, progressText: string, error: string): void;
  onUndoLastApply?(): void;
}

async function compileDraftProposal(
  draft: HtmlDesignDraftProposal,
  context: GenerationContext,
  viewportCenter: AgentPanelProps["viewportCenter"],
  scopeProjectId: string,
  targetLibraryId?: string,
): Promise<PendingAgentProposal & { diagnostics: CompileDiagnostic[] }> {
  const { iconToInlineSvg } = await import("../../agent/icon-library");
  const { compileHtmlDraftInBrowser } = await import("../html-forma-sandbox");
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
    scopeProjectId,
  };
}

// App remounts the panel when switching pages. Keep explicit choices for the open session.
const manualLibraryByFile = new Map<string, string>();

function desktopAgentBridge() {
  if (typeof window === "undefined") return;
  return (
    window as Window & {
      formaDesktop?: { hasConfiguredAgent?(): Promise<boolean> };
    }
  ).formaDesktop;
}

export function useAgentSession({
  document,
  activePageId = document.activePage,
  fileKey,
  getFileLifetimeToken,
  getFileDocumentEpoch,
  fileLifetimeInvalid = false,
  onFileLifetimeInvalidated,
  activeProject: suppliedProject,
  onProjectScopeChanged,
  projectEpisodes,
  episodeArchive,
  onRefreshEpisodes,
  onOpenFileBrowser,
  onOpenPromoteModule,
  canPromoteSelection,
  onInstallProjectLibrary,
  selection,
  selectionCount,
  selectionIds,
  apply,
  onCommitProposal,
  applyingProposal = false,
  lastAppliedProposalEvent,
  onExternalChatConsumed,
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
  const hasSelection = hasAgentSelection(selection, selectionCount);
  const [prompt, setPrompt] = useState("");
  const [mentions, setMentions] = useState<ComposerMention[]>([]);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);

  const [localStatus, setLocalStatus] = useState<AgentStatusResponse | null>(
    null,
  );
  const [connectionState, setConnectionState] = useState<
    "idle" | "checking" | "unavailable"
  >(() =>
    !status &&
    (hasConfiguredAgentHint() || desktopAgentBridge()?.hasConfiguredAgent)
      ? "checking"
      : "idle",
  );
  const [localConfigOpen, setLocalConfigOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [skillError, setSkillError] = useState("");
  const [switchingModel, setSwitchingModel] = useState(false);
  const generationMode: GenerationMode = "auto";

  const effectiveFileKey = fileKey ?? "forma.document.v1";
  const [localArchive, setLocalArchive] = useState<{
    fileKey: string;
    documentId: string;
    project: ProjectSpace | null;
  } | null>(null);
  const fileArchive =
    localArchive?.fileKey === effectiveFileKey &&
    localArchive.documentId === document.id
      ? localArchive
      : null;
  const activeProject =
    !episodeArchive && projectEpisodes === undefined && fileArchive
      ? fileArchive.project
      : suppliedProject;

  // Only the repository that loaded this document can bind its session.
  const resolveSessionIdentity =
    useCallback(async (): Promise<SessionIdentity> => {
      const [expectedLifetimeToken, expectedDocumentEpoch] = await Promise.all([
        getFileLifetimeToken?.(),
        getFileDocumentEpoch?.(),
      ]);
      return { expectedLifetimeToken, expectedDocumentEpoch };
    }, [getFileLifetimeToken, getFileDocumentEpoch]);

  const [localLifetimeInvalid, setLocalLifetimeInvalid] = useState(false);
  useLayoutEffect(() => {
    setLocalLifetimeInvalid(false);
  }, [effectiveFileKey, document.id]);
  const lifetimeInvalid = fileLifetimeInvalid || localLifetimeInvalid;

  async function readDurableSessionProject(identity: SessionIdentity) {
    if (lifetimeInvalid)
      throw new FileLifetimeMismatchError(lifetimeMismatchMessage);
    return getFileProjectSpace(effectiveFileKey, {
      requireDurable: typeof indexedDB !== "undefined",
      ...identity,
      expectedDocId: document.id,
      requireBoundLifetime: typeof indexedDB !== "undefined",
    });
  }

  const projectDefaultId = activeProject?.defaultLibraryId;
  const installedDefaultId =
    findInstalledLibrary(document.libraries, projectDefaultId)?.id ?? "";
  const [targetLibraryId, setTargetLibraryId] = useState(
    () => manualLibraryByFile.get(effectiveFileKey) ?? installedDefaultId,
  );
  const targetLibrary = findInstalledLibrary(
    document.libraries,
    targetLibraryId,
  );
  const selectedLibraryId = targetLibrary?.id ?? "";
  const autoAppliedProjectLibRef = useRef<{
    fileKey: string;
    defaultId: string;
  } | null>(null);

  useLayoutEffect(() => {
    const previous = autoAppliedProjectLibRef.current;
    if (
      previous?.fileKey === effectiveFileKey &&
      previous.defaultId === installedDefaultId &&
      (!targetLibraryId || targetLibrary)
    )
      return;
    autoAppliedProjectLibRef.current = {
      fileKey: effectiveFileKey,
      defaultId: installedDefaultId,
    };
    const preferredId =
      manualLibraryByFile.get(effectiveFileKey) ?? installedDefaultId;
    const next =
      findInstalledLibrary(document.libraries, preferredId)?.id ?? "";
    if (next !== targetLibraryId) changeTargetLibrary(next);
  }, [
    effectiveFileKey,
    installedDefaultId,
    targetLibraryId,
    targetLibrary,
    document.libraries,
  ]);

  const memoryScope = resolveProjectMemoryScope({
    fileKey: effectiveFileKey,
    project: activeProject,
    libraryId: selectedLibraryId || undefined,
  });
  const [memoryDrawerOpen, setMemoryDrawerOpen] = useState(false);
  const [archiveRefresh, setArchiveRefresh] = useState(0);
  const [installingLibrary, setInstallingLibrary] = useState(false);
  const [episodeSavedNote, setEpisodeSavedNote] = useState("");
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scopeId = memoryScope.scopeProjectId;

  useLayoutEffect(() => {
    setMentions([]);
  }, [effectiveFileKey, document.id, scopeId]);

  const localEpisodes = useEpisodeArchive(
    effectiveFileKey,
    document.id,
    scopeId,
    lifetimeInvalid,
  );
  const { episodes, pickerEpisodes, recordReceipt, beginRead } =
    episodeArchive ?? localEpisodes;

  useLayoutEffect(() => {
    if (!episodeArchive && projectEpisodes) beginRead()(projectEpisodes);
  }, [episodeArchive, projectEpisodes, beginRead]);

  useEffect(() => {
    if (episodeArchive || projectEpisodes !== undefined || lifetimeInvalid)
      return;
    let version = 0;
    async function refresh() {
      const request = ++version;
      const updateEpisodes = beginRead();
      try {
        const archive = await readFileProjectEpisodes(
          effectiveFileKey,
          {
            ...(await resolveSessionIdentity()),
            expectedDocId: document.id,
          },
          () => version === request,
        );
        if (version === request && archive) {
          const previous = latestRef.current.activeProject;
          if (previous !== undefined && previous?.id !== archive.project?.id)
            clearChatContext(staleProposalMessage);
          setLocalArchive({
            fileKey: effectiveFileKey,
            documentId: document.id,
            project: archive.project,
          });
          updateEpisodes(archive.episodes);
          setError((message) =>
            message === projectMemoryUnavailableNotice ? "" : message,
          );
        }
      } catch (err) {
        if (version !== request) return;
        if (isFileLifetimeMismatchError(err)) invalidateFileLifetime();
        else setError(projectMemoryReadErrorMessage(err));
      }
    }
    const unsubscribe = subscribeProjectMemory(refresh);
    refresh();
    return () => {
      version++;
      unsubscribe();
    };
  }, [
    projectEpisodes,
    episodeArchive,
    beginRead,
    effectiveFileKey,
    document.id,
    archiveRefresh,
    lifetimeInvalid,
    resolveSessionIdentity,
  ]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const latestAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && !m.discarded);

  function changeTargetLibrary(id: string) {
    setTargetLibraryId(id);
    const name =
      findInstalledLibrary(document.libraries, id)?.name ?? "自动匹配";
    setMessages((previous) =>
      buildInvalidatedLibraryScopeMessages(previous, id, name),
    );
  }

  useLayoutEffect(() => {
    if (hasSelection) setMessages(buildInvalidatedSelectionScopeMessages);
  }, [hasSelection, messages]);

  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const committingRef = useRef(false);
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
  const lastExternalId = useRef<number | null>(null);
  const lastCancelToken = useRef<number>(cancelToken ?? 0);
  const prevProposalRef = useRef<PendingAgentProposal | null>(null);
  const lastAppliedProposalRef = useRef<PendingAgentProposal | null>(null);

  const effectiveStatus =
    onStatusChange && status !== undefined ? status : (status ?? localStatus);
  const activeProfile = effectiveStatus?.activeProfile ?? null;
  const connectedProfileId = effectiveStatus?.configured
    ? activeProfile?.id
    : undefined;
  const skillRequest = useRef<AbortController | null>(null);

  function updateSkills(list: SkillSummary[]) {
    setSkillError("");
    const enabled = list.filter((skill) => skill.enabled);
    setSkills(enabled);
    setActiveSkills((previous) =>
      previous.filter((id) => enabled.some((skill) => skill.id === id)),
    );
  }

  useEffect(() => {
    if (!connectedProfileId) {
      setActiveSkills([]);
      setSkills(null);
      setSkillError("");
      return;
    }
    const controller = new AbortController();
    skillRequest.current = controller;
    setSkillError("");
    void fetchSkills(controller.signal)
      .then(({ skills: list }) => {
        if (!controller.signal.aborted) updateSkills(list);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setSkillError(err.message);
      });
    return () => controller.abort();
  }, [connectedProfileId]);

  // Auto-grow composer cleanly between 38px and 120px
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof el.scrollHeight !== "number") return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 38), 120)}px`;
  }, [prompt]);

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
  }, [document.id, document.revision, scopeId]);

  const selectedNode = useMemo(
    () => (selection ? document.nodes.find((n) => n.id === selection) : null),
    [document.nodes, selection],
  );

  // Keep latest values in refs for async chat invocations triggered externally
  const latestRef = useRef({
    document,
    activeProject,
    activeProposal,
    selection,
    selectionCount,
    hasSelection,
    scopeProjectId: scopeId,
    viewportCenter,
    effectiveStatus,
    messages,
  });
  latestRef.current = {
    document,
    activeProject,
    activeProposal,
    selection,
    selectionCount,
    hasSelection,
    scopeProjectId: scopeId,
    viewportCenter,
    effectiveStatus,
    messages,
  };

  const panelMounted = useRef(false);
  useLayoutEffect(() => {
    panelMounted.current = true;
    return () => {
      panelMounted.current = false;
      abort.current?.abort();
      abort.current = null;
      statusRequest.current?.abort();
    };
  }, []);

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
  }, [messages.length, progressSteps.length, activeProposal]);

  function markApplied(
    proposal: PendingAgentProposal,
    revision: number,
    archiveNote: Promise<string>,
  ) {
    lastAppliedProposalRef.current = proposal;
    setAppliedRevision(revision);
    setError("");
    setEpisodeSavedNote("");
    void archiveNote.then((note) => {
      if (lastAppliedProposalRef.current === proposal)
        setEpisodeSavedNote(note);
    });
  }

  useEffect(() => {
    const previous = prevProposalRef.current;
    prevProposalRef.current = activeProposal;
    if (!previous || activeProposal) return;
    const event = lastAppliedProposalEvent;
    const accepted =
      event?.proposal === previous &&
      event.scopeProjectId === scopeId &&
      event.fileKey === effectiveFileKey;
    if (accepted)
      markApplied(previous, event.afterDoc.revision, event.archiveNote);
    if (activeProposalMsgId) {
      setMessages((messages) =>
        messages.map((m) =>
          m.id === activeProposalMsgId && !m.applied
            ? accepted
              ? { ...m, applied: true }
              : { ...m, discarded: true }
            : m,
        ),
      );
      setActiveProposalMsgId(null);
    }
  }, [
    activeProposal,
    activeProposalMsgId,
    lastAppliedProposalEvent,
    scopeId,
    effectiveFileKey,
  ]);

  function updateStatus(next: AgentStatusResponse) {
    setLocalStatus(next);
    setConnectionState("idle");
    onStatusChange?.(next);
  }

  function updatePendingProposal(
    next: PendingAgentProposal | null,
    msgId: string | null = null,
  ) {
    if (next) {
      lastAppliedProposalRef.current = null;
      setEpisodeSavedNote("");
    }
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

  async function connect(request = new AbortController()) {
    statusRequest.current?.abort();
    statusRequest.current = request;
    setConnectionState("checking");
    setError("");
    setStatusNote("");
    try {
      const next = await fetchAgentStatus(request.signal);
      if (request.signal.aborted) return;
      updateStatus(next);
      if (!next.configured) {
        setStatusNote("本地服务已就绪，请选择模型供应商并填入密钥");
      }
    } catch {
      if (!request.signal.aborted) {
        setConnectionState("unavailable");
      }
    } finally {
      if (statusRequest.current === request) statusRequest.current = null;
    }
  }

  const hydrate = useEffectEvent((request: AbortController) => {
    if (!statusRequest.current || statusRequest.current.signal.aborted)
      void connect(request);
  });
  useEffect(() => {
    const hinted = hasConfiguredAgentHint();
    const desktop = desktopAgentBridge();
    if (effectiveStatus || (!hinted && !desktop?.hasConfiguredAgent)) {
      setConnectionState("idle");
      return;
    }
    setConnectionState("checking");
    const request = new AbortController();
    async function restore() {
      let configured = false;
      try {
        configured = await (hinted || desktop?.hasConfiguredAgent?.() || false);
      } catch {
        // The optional desktop preflight can be unavailable during shutdown.
      }
      if (request.signal.aborted) return;
      if (configured) hydrate(request);
      else if (!statusRequest.current) setConnectionState("idle");
    }
    void restore();
    return () => request.abort();
  }, [effectiveStatus, effectiveFileKey, document.id]);

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
                    "已停止视觉细节优化，保留当前初稿。",
                  ],
                }
              : m,
          ),
        );
      } else {
        setError("已取消生成，当前画布未做改动");
      }
    }
    controller.abort();
    abort.current = null;
    checkRunRevision.current = null;
    refining.current = null;
    setBusy(false);
    setProgressSteps([]);
  }

  function clearChatContext(message: string) {
    cancelChat();
    updatePendingProposal(null);
    setMessages([]);
    setMentions([]);
    setAttachments([]);
    setAppliedRevision(null);
    lastAppliedProposalRef.current = null;
    setEpisodeSavedNote("");
    setError(message);
  }

  function resetChatScope(project: ProjectSpace | null, message: string) {
    clearChatContext(message);
    if (!episodeArchive && projectEpisodes === undefined) {
      setLocalArchive({
        fileKey: effectiveFileKey,
        documentId: document.id,
        project,
      });
      beginRead()([]);
      setArchiveRefresh((value) => value + 1);
    }
    onProjectScopeChanged?.(project, message);
  }

  function invalidateFileLifetime() {
    if (!panelMounted.current) return;
    cancelChat();
    setLocalLifetimeInvalid(true);
    onFileLifetimeInvalidated?.();
  }

  useLayoutEffect(() => {
    if (lifetimeInvalid) {
      setLocalArchive(null);
      clearChatContext(lifetimeMismatchMessage);
    }
  }, [lifetimeInvalid]);

  function rejectScopeRead(error: unknown) {
    if (isFileLifetimeMismatchError(error)) invalidateFileLifetime();
    else clearChatContext(scopeVerificationFailed);
  }

  async function runChat(inputReq: {
    prompt: string;
    mentions: ComposerMention[];
    attachments?: AgentAttachment[];
    clearComposer?: boolean;
    fromCanvas?: boolean;
    confirmedScope?: ScopeProposal;
    scopeMessageId?: string;
    sourceSkills?: string[];
  }) {
    const trimmed = inputReq.prompt.trim();
    if (!trimmed) return;
    if (lifetimeInvalid) {
      clearChatContext(lifetimeMismatchMessage);
      return;
    }
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
    const baseScopeId = memoryScope.scopeProjectId;
    const wireMentions: AgentMention[] = [];
    const explicitEpisodeIds: string[] = [];

    function checkProject(project: ProjectSpace | null) {
      const scope = resolveProjectMemoryScope({
        fileKey: effectiveFileKey,
        project,
      }).scopeProjectId;
      if (scope !== baseScopeId || scope !== latestRef.current.scopeProjectId) {
        resetChatScope(
          project,
          "此文件所属项目空间已在其他标签页切换，已重置会话上下文，请重新发送",
        );
        return null;
      }
      return scope;
    }

    let liveEpisodes: DesignEpisode[];
    let sessionIdentity: SessionIdentity;
    setBusy(true);
    try {
      sessionIdentity = await resolveSessionIdentity();
      const liveProject = await readDurableSessionProject(sessionIdentity);
      if (controller.signal.aborted) return;
      const liveScopeId = checkProject(liveProject);
      if (!liveScopeId) return;
      const updateEpisodes = beginRead();
      liveEpisodes = await listScopeEpisodes(liveScopeId, {
        requireDurable: typeof indexedDB !== "undefined",
      });
      if (controller.signal.aborted) return;
      // Listing and scope verification use separate transactions.
      const verified = await readDurableSessionProject(sessionIdentity);
      if (controller.signal.aborted || !checkProject(verified)) return;
      updateEpisodes(liveEpisodes);
      for (const mention of inputReq.mentions) {
        let { id } = mention;
        if (mention.kind === "episode") {
          const matches = liveEpisodes.filter(
            (ep) => episodeIdentityKey(ep) === mention.identityKey,
          );
          if (matches.length !== 1) {
            cancelChat();
            setError(staleEpisodeMention);
            onRefreshEpisodes?.();
            return;
          }
          id = matches[0].id;
          explicitEpisodeIds.push(id);
        }
        wireMentions.push({ kind: mention.kind, id, label: mention.label });
      }
      if (
        latestRef.current.document.id !== doc.id ||
        latestRef.current.document.revision !== baseRevision
      ) {
        cancelChat();
        setError("生成期间文档已修改，已丢弃过期提案，可重新确认或发送");
        return;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isProjectMemoryUnavailableError(error)) {
        cancelChat();
        setError("无法核验当前项目历史档案，请稍后重试");
      } else rejectScopeRead(error);
      return;
    }

    if (explicitEpisodeIds.length > MAX_EPISODE_MENTIONS) {
      cancelChat();
      setError(episodeMentionLimitNote);
      return;
    }

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
    setError("");
    setStatusNote("");
    setAppliedRevision(null);
    setProgressSteps([
      { stage: "analyzing", message: FIXED_PROGRESS_LABELS.analyzing },
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
      const scopeChanged = latestRef.current.scopeProjectId !== baseScopeId;
      if (
        !scopeChanged &&
        latestRef.current.document.id === doc.id &&
        latestRef.current.document.revision === baseRevision
      )
        return true;
      controller.abort();
      restoreScope();
      setBusy(false);
      setProgressSteps([]);
      setError(
        scopeChanged
          ? staleProposalMessage
          : "生成期间文档已修改，已丢弃过期提案，可重新确认或发送",
      );
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

    async function isCurrentDurable(): Promise<boolean> {
      if (!isCurrent()) return false;
      let liveProject: ProjectSpace | null;
      try {
        liveProject = await readDurableSessionProject(sessionIdentity);
      } catch (error) {
        if (!controller.signal.aborted) rejectScopeRead(error);
        return false;
      }
      if (!isCurrent()) return false;
      const liveScopeId = resolveProjectMemoryScope({
        fileKey: effectiveFileKey,
        project: liveProject,
      }).scopeProjectId;
      if (liveScopeId !== baseScopeId) {
        resetChatScope(liveProject, staleProposalMessage);
        return false;
      }
      return true;
    }

    checkRunRevision.current = isCurrent;
    function reportProgress(progress: AgentChatProgress) {
      if (controller.signal.aborted) return;
      setProgressSteps((prev) => {
        const last = prev.at(-1);
        if (last?.stage === progress.stage && last.message === progress.message)
          return last.detail === progress.detail
            ? prev
            : [...prev.slice(0, -1), progress];
        return [...prev.slice(-5), progress];
      });
    }

    try {
      const recalledEpisodes = rankProjectEpisodes({
        episodes: liveEpisodes,
        prompt: trimmed,
        currentFileKey: effectiveFileKey,
        targetLibraryId: libraryId,
        explicitEpisodeIds,
        limit: 5,
      });
      const recalledEpisodeIds = recalledEpisodes.map((ep) => ep.id);
      const result = await streamAgentChat(
        {
          ...context,
          selectionCount: count,
          targetLibraryId: libraryId,
          ...generation,
          memoryScope: {
            projectId: scopeId,
            projectName: activeProject?.name,
            fileKey: effectiveFileKey,
            libraryId,
            userId: memoryScope.userId,
          },
          recalledEpisodes: recalledEpisodes.length
            ? recalledEpisodes
            : undefined,
          profileId: profile?.id,
          model: profile?.selectedModel,
          history,
          mentions: wireMentions.length ? wireMentions : undefined,
          attachments: userMsg.attachments,
          viewportCenter: center,
          activeSkills: roundSkills.length ? roundSkills : undefined,
        },
        (event) => {
          if (!isCurrent()) return;
          const stage = Object.hasOwn(FIXED_PROGRESS_LABELS, event.stage)
            ? (event.stage as AgentProgressStage)
            : undefined;
          reportProgress({
            stage: stage ?? "processing",
            message: stage ? FIXED_PROGRESS_LABELS[stage] : "正在处理设计需求…",
            detail:
              event.detail && /^已接收 \d+ 字符$/.test(event.detail)
                ? event.detail
                : undefined,
          });
        },
        controller.signal,
      );

      if (!(await isCurrentDurable())) return;
      const draftLibraryId =
        result.htmlDraft?.targetLibraryId ??
        result.targetLibraryId ??
        libraryId;

      const episodeContext = {
        prompt: trimmed,
        mode: result.mode,
        confirmedScope: generation.confirmedScope,
        targetLibraryId: draftLibraryId,
        recalledEpisodeIds,
      };

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
          scopeProjectId: baseScopeId,
          source: "chat",
        };
      } else if (result.htmlDraft) {
        reportProgress({
          stage: "validating",
          message: HTML_COMPILE_PROGRESS,
        });
        const compiled = await compileDraftProposal(
          result.htmlDraft,
          context,
          center,
          baseScopeId,
          draftLibraryId,
        );
        if (!(await isCurrentDurable())) return;
        proposal = compiled;
        diagnostics.push(...compiled.diagnostics);
      }
      if (proposal)
        proposal.episodeMeta = buildEpisodeMeta(
          episodeContext,
          proposal,
          result.htmlDraft,
        );

      const referencedIds = result.recalledEpisodeIds ?? recalledEpisodeIds;
      const assistantMsg: ChatMessage = {
        id: assistantMsgId,
        role: "assistant",
        text:
          result.reply ||
          proposal?.reply ||
          result.summary ||
          (proposal
            ? `已为你准备好设计预览（${proposal.transaction.operations.length} 项改动），满意后可应用到画布。`
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
        recalledEpisodes: recalledEpisodes.filter((ep) =>
          referencedIds.includes(ep.id),
        ),
        recalledEpisodeIds: referencedIds,
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
        !profile?.capabilities.supportsVision ||
        !rootId ||
        controller.signal.aborted
      )
        return;

      refining.current = proposal;
      reportProgress({
        stage: "repairing",
        message: VISUAL_CRITIQUE_PROGRESS,
      });
      let toolTrace = result.toolTrace ?? [];
      let critiqueNotes = result.critiqueNotes ?? [];
      let refined: PendingAgentProposal | undefined;
      try {
        const { captureFormaArtboardPng } =
          await import("../html-forma-sandbox");
        const shadowDoc = transact(doc, proposal.transaction);
        const boards = result.htmlDraft.artboards ?? [result.htmlDraft];
        const renderedImages = [];
        for (const [index, id] of proposal.createdRootIds.entries()) {
          const board = boards[index];
          if (!(await isCurrentDurable())) return;
          const dataUrl = await captureFormaArtboardPng(shadowDoc, id, 1);
          renderedImages.push({
            refId: result.htmlDraft.artboards?.[index]?.refId,
            name: board.name,
            dataUrl,
          });
        }
        if (!(await isCurrentDurable())) return;
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
        if (!(await isCurrentDurable())) return;
        toolTrace = [...toolTrace, ...critique.toolTrace];
        critiqueNotes = [...critiqueNotes, ...critique.critiqueNotes];
        if (critique.improved && critique.htmlDraft) {
          const compiled = await compileDraftProposal(
            critique.htmlDraft,
            context,
            center,
            baseScopeId,
            result.htmlDraft.targetLibraryId ?? draftLibraryId,
          );
          if (!(await isCurrentDurable())) return;
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
          refined.episodeMeta = buildEpisodeMeta(
            episodeContext,
            refined,
            critique.htmlDraft,
          );
          updatePendingProposal(refined, assistantMsgId);
        }
      } catch (err) {
        if (!isCurrent()) return;
        if (!(await isCurrentDurable())) return;
        critiqueNotes = [
          ...critiqueNotes,
          `已保留初稿。视觉细节优化未完成：${err instanceof Error ? err.message : "无法取得优化结果"}`,
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
    } catch (err) {
      if (!isCurrent()) return;
      if (!(await isCurrentDurable())) return;
      setError(err instanceof Error ? err.message : "生成失败");
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
    let input: ComposerInput = retry
      ? { prompt: "", mentions: [], attachments: [] }
      : { prompt, mentions, attachments };
    if (canvasInput) {
      const captured = captureExternalMentions(canvasInput.mentions, episodes);
      if (!captured) {
        setError(staleEpisodeMention);
        return;
      }
      input = { ...canvasInput, mentions: captured };
    }
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
      onExternalChatConsumed?.(externalChatRequest.id);
      if (
        externalChatRequest.pageId === activePageId &&
        externalChatRequest.scopeProjectId === scopeId
      )
        submitRef.current(undefined, externalChatRequest);
    }
  }, [externalChatRequest, onExternalChatConsumed, activePageId, scopeId]);

  // Cancel active stream when App.tsx increments cancelToken
  useEffect(() => {
    if (cancelToken !== undefined && cancelToken !== lastCancelToken.current) {
      lastCancelToken.current = cancelToken;
      cancelChat(true);
    }
  }, [cancelToken]);

  async function handleApplyProposal() {
    if (
      lifetimeInvalid ||
      !activeProposal ||
      applyingProposal ||
      committingRef.current
    )
      return;
    try {
      if (onCommitProposal) {
        await onCommitProposal(activeProposal);
        return;
      }
      if (!apply) throw new Error("当前编辑器无法提交提案");
      committingRef.current = true;
      setCommitting(true);
      let liveProject: ProjectSpace | null;
      let sessionIdentity: SessionIdentity;
      try {
        sessionIdentity = await resolveSessionIdentity();
        liveProject = await readDurableSessionProject(sessionIdentity);
      } catch (error) {
        if (panelMounted.current) rejectScopeRead(error);
        return;
      }
      if (latestRef.current.activeProposal !== activeProposal) return;
      const liveScopeId = resolveProjectMemoryScope({
        fileKey: effectiveFileKey,
        project: liveProject,
      }).scopeProjectId;
      if (
        liveScopeId !== activeProposal.scopeProjectId ||
        liveScopeId !== latestRef.current.scopeProjectId
      ) {
        resetChatScope(liveProject, staleProposalMessage);
        return;
      }
      if (
        latestRef.current.document.revision !==
        activeProposal.transaction.baseRevision
      )
        throw new Error("画布已有变动，请重新生成");
      const afterDoc = apply(activeProposal.transaction);
      if (afterDoc) {
        markApplied(
          activeProposal,
          afterDoc.revision,
          archiveAppliedProposal(
            activeProposal,
            document,
            afterDoc,
            effectiveFileKey,
            sessionIdentity.expectedLifetimeToken,
            sessionIdentity.expectedDocumentEpoch,
            recordReceipt,
          ),
        );
      } else {
        setAppliedRevision(activeProposal.transaction.baseRevision + 1);
      }
      if (activeProposalMsgId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === activeProposalMsgId ? { ...m, applied: true } : m,
          ),
        );
      }
      updatePendingProposal(null);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!onCommitProposal) {
        committingRef.current = false;
        setCommitting(false);
      }
    }
  }

  function handleDiscardProposal() {
    updatePendingProposal(null);
  }

  // Proposals from the independent integrations dialog replace the current chat preview.
  const receiveExternalProposal = useEffectEvent(() => {
    cancelChat();
    setAppliedRevision(null);
    setError("");
    if (activeProposalMsgId) {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === activeProposalMsgId
            ? { ...message, discarded: true }
            : message,
        ),
      );
      setActiveProposalMsgId(null);
    }
  });
  useLayoutEffect(() => {
    if (
      pendingProposal?.source === "external" ||
      pendingProposal?.source === "manual"
    )
      receiveExternalProposal();
  }, [pendingProposal]);

  function addMention(item: ComposerMention) {
    if (mentions.some((m) => mentionIdentity(m) === mentionIdentity(item)))
      return true;
    if (item.kind === "episode" && episodeLimitReached(mentions)) {
      setError(episodeMentionLimitNote);
      return false;
    }
    setMentions((previous) => [...previous, item]);
    return true;
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

  const showProjectContextStrip =
    Boolean(activeProject) ||
    activeProject === undefined ||
    Boolean(projectDefaultId && !installedDefaultId && onInstallProjectLibrary);

  const scopeBadgeLabel = selectedNode
    ? `选区 · ${selectedNode.name}`
    : selection
      ? "当前选区"
      : selectionCount > 1
        ? `已选 ${selectionCount} 层`
        : "当前页面";

  const activeModelSummary = activeProfile
    ? [
        activeProfile.providerName,
        activeProfile.selectedModel,
        activeProfile.capabilities.supportsVision ? "支持识图" : "仅文本",
        `上下文 ${formatContextWindow(activeProfile.capabilities.maxContextTokens)}`,
      ].join(" · ")
    : "";

  const isEmptyConversation = messages.length === 0 && !activeProposal && !busy;

  const drawer: EpisodeDrawerProps = {
    episodes,
    activeProject,
    fileKey: effectiveFileKey,
    expectedDocId: document.id,
    scopeProjectId: scopeId,
    resolveSessionIdentity,
    fileLifetimeInvalid: lifetimeInvalid,
    onOpenFileBrowser,
    onMutationError: async (error) => {
      if (!panelMounted.current) return;
      if (isFileLifetimeMismatchError(error)) {
        invalidateFileLifetime();
        return;
      }
      if (onRefreshEpisodes) {
        await onRefreshEpisodes();
        return;
      }
      const updateEpisodes = beginRead();
      try {
        const archive = await readFileProjectEpisodes(
          effectiveFileKey,
          {
            ...(await resolveSessionIdentity()),
            expectedDocId: document.id,
          },
          () =>
            panelMounted.current &&
            latestRef.current.document.id === document.id &&
            latestRef.current.scopeProjectId === scopeId,
        );
        if (!archive) return;
        if (archive.scopeProjectId !== scopeId)
          resetChatScope(archive.project, staleProposalMessage);
        else updateEpisodes(archive.episodes);
      } catch (readError) {
        if (panelMounted.current) rejectScopeRead(readError);
        throw readError;
      }
    },
    onArchive: async () => {
      if (activeProject === undefined)
        throw new Error("尚未核验文件所属项目空间，请刷新后再归档");
      const identity = await resolveSessionIdentity();
      const {
        expectedLifetimeToken: sourceLifetimeToken,
        expectedDocumentEpoch: sourceDocumentEpoch,
      } = identity;
      if (sourceLifetimeToken === undefined && typeof indexedDB !== "undefined")
        await getFileProjectSpace(effectiveFileKey, {
          ...identity,
          expectedDocId: document.id,
          requireBoundLifetime: true,
        });
      const episode = buildManualEpisodeFromSelection({
        document,
        selectionIds: selectionIds ?? (selection ? [selection] : []),
        scopeProjectId: scopeId,
        sourceFileKey: effectiveFileKey,
        sourceLifetimeToken,
        sourceDocumentEpoch,
        libraryId: selectedLibraryId || undefined,
      });
      const receipt = await saveDesignEpisodeWithReceipt(episode);
      recordReceipt(receipt, sourceLifetimeToken);
      return receipt;
    },
    onReference: (ep) => {
      const added = addMention({
        kind: "episode",
        id: ep.id,
        label: ep.title,
        identityKey: episodeIdentityKey(ep),
      });
      if (added) composerRef.current?.focus();
      return added;
    },
    onClose: () => {
      setMemoryDrawerOpen(false);
      drawerToggleRef.current?.focus();
    },
  };

  function chooseLibrary(id: string) {
    manualLibraryByFile.set(effectiveFileKey, id);
    changeTargetLibrary(id);
  }

  const picker: ComponentProps<typeof AgentMentionPopover> | null = mentionOpen
    ? {
        document,
        episodes: pickerEpisodes,
        attached: mentions.map((m) =>
          m.identityKey !== undefined ? { ...m, id: m.identityKey } : m,
        ),
        placement: "top",
        onSelect: (item) => {
          if (!addMention(capturePickerMention(item))) return;
          setMentionOpen(false);
          composerRef.current?.focus();
        },
        onClose: () => {
          setMentionOpen(false);
          composerRef.current?.focus();
        },
      }
    : null;

  function messageProps(msg: ChatMessage) {
    return {
      msg,
      isLatestAssistant: msg === latestAssistant,
      scopeDisabled: busy || connection !== "ready",
      invalidatedReason: scopeProblem(
        msg,
        selection,
        generationMode,
        document.libraries,
        selectionCount,
      ),
      onScopeChoice: (index: number, choice: string) =>
        setMessages((previous) =>
          applyScopeChoiceToMessages(previous, msg.id, index, choice),
        ),
      onScopeConfirm: () =>
        submitComposer(msg, undefined, !!msg.scopeRetryInput),
    };
  }

  const installDefaultLibrary =
    projectDefaultId && !installedDefaultId && onInstallProjectLibrary
      ? async () => {
          setInstallingLibrary(true);
          try {
            await onInstallProjectLibrary(projectDefaultId);
          } catch (err) {
            setError(err instanceof Error ? err.message : "载入项目默认库失败");
          } finally {
            setInstallingLibrary(false);
          }
        }
      : undefined;

  function onComposerKeyDown(ev: KeyboardEvent<HTMLTextAreaElement>) {
    if (ev.nativeEvent.isComposing || ev.keyCode === 229) return;
    const isSubmitKey =
      (ev.key === "Enter" && !ev.shiftKey) ||
      ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter");
    if (
      isSubmitKey &&
      prompt.trim() &&
      connection === "ready" &&
      !busy &&
      !lifetimeInvalid
    ) {
      ev.preventDefault();
      submitComposer();
    }
  }
  return {
    header: {
      selectedNode,
      selectionCount,
      scopeBadgeLabel,
      episodes,
      memoryScope,
      drawerToggleRef,
      memoryDrawerOpen,
      activeModelSummary,
      openModelConfig,
      openSkillsManager() {
        skillRequest.current?.abort();
        setSkillsOpen(true);
      },
      hasMessages: messages.length > 0,
      busy,
      toggleMemory() {
        setMentionOpen(false);
        setMemoryDrawerOpen((open) => !open);
      },
      clearHistory() {
        setMessages([]);
        setAppliedRevision(null);
        setError("");
      },
      showProjectContextStrip,
      onOpenFileBrowser,
      activeProject,
      installDefaultLibrary,
      installingLibrary,
      lifetimeInvalid,
    },
    drawer: memoryDrawerOpen ? drawer : null,
    conversation: {
      isEmptyConversation,
      selectedNode,
      selectionCount,
      hasSelection,
      connection,
      statusNote,
      openModelConfig,
      connect,
      quickPrompts,
      choosePrompt(chip: string) {
        setPrompt(chip);
        composerRef.current?.focus();
      },
      messages,
      messageProps,
      busy,
      progressSteps,
      preview: activeProposal
        ? {
            proposal: activeProposal,
            document,
            applying: applyingProposal || committing,
            focusNode,
            onApply: handleApplyProposal,
            onDiscard: handleDiscardProposal,
          }
        : null,
      showApplied: appliedRevision === document.revision && !activeProposal,
      episodeSavedNote,
      onPromote: canPromoteSelection ? onOpenPromoteModule : undefined,
      onUndo: onUndoLastApply
        ? () => {
            onUndoLastApply();
            setAppliedRevision(null);
          }
        : undefined,
      threadEndRef,
      error,
    },
    composer: {
      picker,
      libraries: Object.values(document.libraries ?? {}),
      selectedLibraryId,
      chooseLibrary,
      mentions,
      attachments,
      activeSkills,
      hasContext: Boolean(
        mentions.length ||
        attachments.length ||
        (connectedProfileId && activeSkills.length),
      ),
      skills: connectedProfileId ? skills : null,
      skillError,
      toggleSkill(id: string) {
        setActiveSkills((previous) =>
          previous.includes(id)
            ? previous.filter((active) => active !== id)
            : [...previous, id],
        );
      },
      composerRef,
      hasSelection,
      prompt,
      busy,
      setPrompt,
      onComposerKeyDown,
      mentionOpen,
      toggleMentions() {
        setMentionOpen((v) => !v);
      },
      connection,
      supportsVision,
      fileInputRef,
      handleAddImages,
      activeProfile,
      activeModelSummary,
      profileBadge,
      switchingModel,
      handleModelSwitch,
      activeModels,
      cancelChat,
      lifetimeInvalid,
      submit: () => submitComposer(),
      removeMention: (mention: ComposerMention) =>
        setMentions((prev) => prev.filter((item) => item !== mention)),
      removeAttachment: (index: number) =>
        setAttachments((prev) => prev.filter((_, i) => i !== index)),
    },
    skillsModal: skillsOpen
      ? { onClose: () => setSkillsOpen(false), onListChange: updateSkills }
      : null,
    modelConfig: onOpenConfig
      ? null
      : {
          open: localConfigOpen,
          onClose: () => setLocalConfigOpen(false),
          status: effectiveStatus,
          onStatusChange: updateStatus,
        },
  };
}
