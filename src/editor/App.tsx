import { sourceNameFonts } from "./SourceName";
import { readNativeDocument } from "../infrastructure/native-document";
import { displayColor, profileLabel } from "../domain/color-profile";
import { ColorProfileDialog, FileColorContext } from "./ColorProfileDialog";
import { loadFonts } from "../infrastructure/font-import";
import {
  resolveProjectMemoryScope,
  type ProjectSpace,
} from "../agent/project-memory";
import {
  getFileProjectSpace,
  isFileLifetimeMismatchError,
  subscribeProjectMemory,
} from "../infrastructure/project-memory-store";
import { getWorkspaceLibraryRecord } from "../infrastructure/library-catalog-store";
import { parseLibrary } from "../domain/library-schema";
import { ModeSelectors } from "./TokenBinding";
import {
  Variable,
  Cable,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  FolderOpen,
  FileCode2,
  FolderSync,
  History,
  Home,
  HardDriveDownload,
  Inbox,
  MessageSquare,
  Palette,
  Package,
  Save,
  Settings2,
  ShieldCheck,
  Sun,
  Moon,
  LayoutGrid,
  Type as TypeIcon,
  ArrowUpRight,
  Code2,
  Download,
  FilePlus2,
  HelpCircle,
  Layers,
  ListFilter,
  PanelLeft,
  PanelRight,
  Play,
  Shapes,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { PagesPanel } from "./PagesPanel";
import { resolveVariable } from "../domain/design-system";
import { indexPublishedScene } from "../domain/scene-index";
import { linkedPrototypeScene } from "../domain/prototype";
import { currentPageOnly } from "../domain/pages";
import type { ProjectRevisionPreview } from "../infrastructure/project-revision";
import { prototypeProgram } from "../compiler/runtime";
import { PrototypeInspector } from "./PrototypeInspector";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  lazy,
  Suspense,
} from "react";
import type { Viewport } from "../domain/geometry";
import {
  downloadFormaFile,
  homeUrl,
  newBlankFile,
  ownLibrary,
  saveFormaDocument,
  type QuickStartPreset,
} from "./file-actions";
import { transact, type Operation } from "../domain/commands";
import {
  createLocalFile,
  createLocalFileWithKey,
  fileUrl,
} from "../infrastructure/storage";
import { RecentFilesSubmenu } from "./RecentFilesSubmenu";
import {
  countPendingInboxTasks,
  type BridgeTabSummary,
} from "../application/external-bridge";
import type { Transaction } from "../agent/provider";
import type { ExternalBridgeSnapshot } from "./ExternalAgentSession";
import type { PendingIntegrationProposal } from "./IntegrationsModal";
import type { EditorFileOptions } from "./useDocument";
import { type DesignComment } from "../domain/document";
import {
  AgentPanel,
  archiveAppliedProposal,
  capturePickerMention,
  projectMemoryReadErrorMessage,
  readFileProjectEpisodes,
  staleProposalMessage,
  useEpisodeArchive,
  type AppliedProposalEvent,
  type ExternalChatRequest,
} from "./AgentPanel";
import {
  CanvasAgentBar,
  type CanvasAgentBarProps,
  type PendingAgentProposal,
} from "./CanvasAgentBar";
import {
  fetchAgentStatus,
  hasConfiguredAgentHint,
  type AgentStatusResponse,
} from "./agent-client";
import { BatchExportModal } from "./ExportPanel";
import { CommentsPanel } from "./CommentsOverlay";
import type { CanvasViewOptions } from "./ViewOptionsMenu";
import { Canvas } from "./Canvas";
import { CanvasWelcomeOverlay } from "./CanvasWelcomeOverlay";
import { ColorField } from "./ColorField";
import { ErrorBoundary } from "./ErrorBoundary";
import { Inspector } from "./Inspector";
import { LayersPanel } from "./LayersPanel";
import { CommandPalette, ShortcutHelp } from "./ActionMenu";
import { ContextMenu } from "./ContextMenu";
import { PanelDivider } from "./PanelDivider";
import { TooltipHost } from "./TooltipHost";
import { useEditor } from "./useEditor";
import {
  saveStateCopy,
  UNIFIED_FRAME_PRESET_GROUPS,
  WELCOME_FRAME_PRESETS,
} from "./ux-copy";

import {
  acceptedDesignFiles,
  isExternalDesign,
  checkDesignFileSize,
} from "../infrastructure/design-import/types";

const UI_THEME_KEY = "forma.ui-theme";

const STYLE_GROUPS = [
  { kind: "paint", label: "颜色样式" },
  { kind: "stroke", label: "描边样式" },
  { kind: "text", label: "文字样式" },
  { kind: "effect", label: "效果样式" },
  { kind: "grid", label: "网格样式" },
] as const;
const DesignSystemDialog = lazy(() =>
  import("./DesignSystemDialog").then((m) => ({
    default: m.DesignSystemDialog,
  })),
);
const AssetsPanel = lazy(() =>
  import("./AssetsPanel").then((m) => ({ default: m.AssetsPanel })),
);
const FileBrowser = lazy(() =>
  import("./FileBrowser").then((m) => ({ default: m.FileBrowser })),
);
const PromoteModuleModal = lazy(() =>
  import("./PromoteModuleModal").then((m) => ({
    default: m.PromoteModuleModal,
  })),
);
const DesignImportDialog = lazy(() =>
  import("./DesignImportDialog").then((m) => ({
    default: m.DesignImportDialog,
  })),
);
const DevModePanel = lazy(() =>
  import("./DevModePanel").then((m) => ({ default: m.DevModePanel })),
);
const DesignLintPanel = lazy(() =>
  import("./DesignLintPanel").then((m) => ({ default: m.DesignLintPanel })),
);
const ModelConfigModal = lazy(() =>
  import("./ModelConfigModal").then((m) => ({ default: m.ModelConfigModal })),
);
const PreviewDialog = lazy(() =>
  import("./PreviewDialog").then((m) => ({ default: m.PreviewDialog })),
);
const CodePreviewModal = lazy(() =>
  import("./CodeAndUpdateModals").then((m) => ({
    default: m.CodePreviewModal,
  })),
);
const ProjectUpdateModal = lazy(() =>
  import("./CodeAndUpdateModals").then((m) => ({
    default: m.ProjectUpdateModal,
  })),
);
const ReleaseNotesDialog = lazy(() =>
  import("./ReleaseNotesDialog").then((m) => ({
    default: m.ReleaseNotesDialog,
  })),
);
const IntegrationsModal = lazy(() =>
  import("./IntegrationsModal").then((m) => ({
    default: m.IntegrationsModal,
  })),
);
const AgentInboxPopover = lazy(() =>
  import("./AgentInboxPopover").then((m) => ({
    default: m.AgentInboxPopover,
  })),
);

// The canvas composer removes chips absent from its picker options. Keep the
// options offered to this draft until send, so the panel can reject a retired
// reference instead of receiving a request with the reference silently omitted.
function CanvasChatDraft({
  projectEpisodes,
  onSendPrompt,
  ...props
}: CanvasAgentBarProps & {
  projectEpisodes: NonNullable<CanvasAgentBarProps["projectEpisodes"]>;
}) {
  const [offered, setOffered] = useState(projectEpisodes);
  useLayoutEffect(() => {
    if (!props.open) return;
    const live = new Set(projectEpisodes.map((ep) => ep.id));
    setOffered((previous) => {
      const retired = previous.filter((ep) => !live.has(ep.id));
      return retired.length
        ? [...projectEpisodes, ...retired]
        : projectEpisodes;
    });
  }, [projectEpisodes, props.open]);
  return (
    <CanvasAgentBar
      {...props}
      projectEpisodes={offered}
      onSendPrompt={(input) => {
        setOffered(projectEpisodes);
        onSendPrompt(input);
      }}
    />
  );
}

export interface AppProps extends EditorFileOptions {
  tabActive?: boolean;
  workspaceTabs?: BridgeTabSummary[];
  activeWorkspaceTabId?: string | null;
  initialPreset?: QuickStartPreset;
  initialViews?: Map<string, Viewport>;
  onTabMetaChange?(meta: {
    title: string;
    dirty: boolean;
    busyReason: "ai" | "mcp" | null;
    nativePath?: string | null;
  }): void;
  onTabViewSnapshot?(snapshot: {
    activePage?: string;
    selectionIds: string[];
    views: Map<string, Viewport>;
  }): void;
  onTabPresetConsumed?(): void;
  onOpenHome?(): void;
  onOpenFileTab?(target: {
    fileKey: string;
    title: string;
    preset?: QuickStartPreset;
  }): void;
  onOpenExampleTab?(target: {
    example: string;
    edition?: string;
    page?: string;
    node?: string;
    title?: string;
  }): void;
  onNewDesignTab?(options?: {
    projectId?: string | null;
    preset?: QuickStartPreset;
  }): void;
  onThemeSync?(theme: "dark" | "light"): void;
}

export function App(options: AppProps) {
  const tabActive = options.tabActive !== false;
  const editor = useEditor({ ...options, active: tabActive });
  const [uiTheme, setUiTheme] = useState<"dark" | "light">(() => {
    try {
      const saved = localStorage.getItem(UI_THEME_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* ignore */
    }
    return "dark";
  });
  useEffect(() => {
    if (!tabActive) return;
    document.documentElement.dataset.theme = uiTheme;
    options.onThemeSync?.(uiTheme);
    try {
      localStorage.setItem(UI_THEME_KEY, uiTheme);
    } catch {
      /* ignore */
    }
  }, [uiTheme, tabActive, options.onThemeSync]);
  useEffect(() => {
    const sync = () => {
      const next =
        document.documentElement.dataset.theme === "light" ? "light" : "dark";
      setUiTheme((prev) => (prev === next ? prev : next));
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  const [tab, setTab] = useState<"layers" | "assets" | "agent">("layers");
  const [libraryManagerOpen, setLibraryManagerOpen] = useState(false);
  const [compact, setCompact] = useState(
    () => matchMedia("(max-width: 949px)").matches,
  );
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [compactPanel, setCompactPanel] = useState<"left" | "right" | null>(
    null,
  );
  const showLeft = compact ? compactPanel === "left" : leftOpen;
  const showRight = compact ? compactPanel === "right" : rightOpen;
  useEffect(() => {
    const media = matchMedia("(max-width: 949px)");
    const changed = () => setCompact(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  function togglePanel(side: "left" | "right") {
    if (compact) setCompactPanel((current) => (current === side ? null : side));
    else if (side === "left") setLeftOpen((open) => !open);
    else setRightOpen((open) => !open);
  }
  const previousCompact = useRef<"right" | "left">("left");
  const previousPanels = useRef({ left: true, right: true });
  useEffect(() => {
    if (!tabActive) return;
    function shortcut(event: KeyboardEvent) {
      if (
        event.key === "F6" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !document.querySelector('[aria-modal="true"]')
      ) {
        const sections = [
          "header",
          "#left-panel",
          ".editor-canvas",
          "#right-panel",
        ]
          .map((selector) => document.querySelector<HTMLElement>(selector))
          .filter((el): el is HTMLElement => !!el?.getClientRects().length);
        if (!sections.length) return;
        const index = sections.findIndex((el) =>
          el.contains(document.activeElement),
        );
        const target =
          sections[
            (index + (event.shiftKey ? -1 : 1) + sections.length) %
              sections.length
          ];
        const control = target.matches("[tabindex]")
          ? target
          : target.querySelector<HTMLElement>(
              "button:not(:disabled),summary,input:not(:disabled)",
            );
        if (control) {
          event.preventDefault();
          control.focus({ preventScroll: true });
        }
        return;
      }
      if (
        !event.isComposing &&
        !event.repeat &&
        !document.querySelector('[aria-modal="true"]') &&
        !(event.target as Element)?.closest?.(
          'input,textarea,select,[contenteditable="true"],[role="dialog"]',
        )
      ) {
        if (
          event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          event.code === "KeyE"
        ) {
          event.preventDefault();
          setInspectorTab((t) => (t === "design" ? "prototype" : "design"));
          return;
        }
        if (
          event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          event.code === "KeyD"
        ) {
          event.preventDefault();
          setDevMode((v) => {
            const next = !v;
            if (next) {
              if (compact) setCompactPanel("right");
              else setRightOpen(true);
            }
            return next;
          });
          return;
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.key === "Enter" &&
          !editorRef.current.editing
        ) {
          event.preventDefault();
          setInlineAgentOpen((v) => !v);
          return;
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          event.shiftKey &&
          !event.altKey &&
          event.code === "KeyE"
        ) {
          event.preventDefault();
          setBatchExportOpen(true);
          return;
        }
        if (
          (event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey &&
            event.code === "KeyY") ||
          (event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            event.code === "KeyO")
        ) {
          event.preventDefault();
          setOutlineMode((v) => !v);
          return;
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          !event.altKey &&
          event.code === "Quote"
        ) {
          event.preventDefault();
          setShowPixelGrid((v) => !v);
          return;
        }
        if (
          event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          !event.altKey &&
          event.code === "KeyG"
        ) {
          event.preventDefault();
          setShowLayoutGuides((v) => !v);
          return;
        }
        if (
          event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          event.code === "KeyC"
        ) {
          event.preventDefault();
          setShowComments((v) => !v);
          return;
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          event.code === "KeyS"
        ) {
          event.preventDefault();
          void handleSaveNativeRef.current(event.shiftKey);
          return;
        }
        if (
          event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey
        ) {
          if (event.code === "Digit1") {
            event.preventDefault();
            setTab("layers");
            if (compact) setCompactPanel("left");
            else setLeftOpen(true);
            return;
          }
          if (event.code === "Digit2" || event.code === "Digit3") {
            event.preventDefault();
            setTab("assets");
            setLibraryManagerOpen(event.code === "Digit3");
            if (compact) setCompactPanel("left");
            else setLeftOpen(true);
            return;
          }
        }
      }
      if (
        event.code !== "Backslash" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.isComposing ||
        event.repeat ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      event.preventDefault();
      if (compact) {
        if (compactPanel) previousCompact.current = compactPanel;
        setCompactPanel(compactPanel ? null : previousCompact.current);
      } else if (leftOpen || rightOpen) {
        previousPanels.current = { left: leftOpen, right: rightOpen };
        setLeftOpen(false);
        setRightOpen(false);
      } else {
        setLeftOpen(previousPanels.current.left);
        setRightOpen(previousPanels.current.right);
      }
      if (document.activeElement?.closest("aside,.panel-divider"))
        document
          .querySelector<HTMLElement>(".editor-canvas")
          ?.focus({ preventScroll: true });
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [compact, compactPanel, leftOpen, rightOpen, tabActive]);
  const [designSystemTarget, setDesignSystemTarget] = useState<{
    view: "variables" | "styles";
    styleId?: string;
  } | null>(null);
  const openDesignSystem = (
    view: "variables" | "styles" = "variables",
    styleId?: string,
  ) => setDesignSystemTarget({ view, styleId });
  const [codeOpen, setCodeOpen] = useState(false);
  const [devMode, setDevMode] = useState(false);
  const [showPixelGrid, setShowPixelGrid] = useState(false);
  const [showLayoutGuides, setShowLayoutGuides] = useState(true);
  const [outlineMode, setOutlineMode] = useState(false);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [showComments, setShowComments] = useState(true);
  const [batchExportOpen, setBatchExportOpen] = useState(false);
  const [lintOpen, setLintOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [modelConfigOpen, setModelConfigOpen] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [integrationsMounted, setIntegrationsMounted] = useState(false);
  const [mcpSessionActive, setMcpSessionActive] = useState(false);
  const [bridgeSnapshot, setBridgeSnapshot] =
    useState<ExternalBridgeSnapshot | null>(null);
  const bridgeSnapshotRef = useRef<ExternalBridgeSnapshot | null>(null);
  bridgeSnapshotRef.current = bridgeSnapshot;
  const [inboxOpen, setInboxOpen] = useState(false);
  const taskProposalsRef = useRef(
    new Map<string, PendingIntegrationProposal>(),
  );
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const openIntegrations = useCallback(() => {
    setIntegrationsMounted(true);
    setIntegrationsOpen(true);
  }, []);
  const [boundFile, setBoundFile] = useState<{
    filePath: string;
    fileName: string;
  } | null>(null);
  const [inlineAgentOpen, setInlineAgentOpen] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatusResponse | null>(
    null,
  );
  const [pendingProposal, setPendingProposal] =
    useState<PendingIntegrationProposal | null>(null);
  const [committingProposal, setCommittingProposal] = useState(false);
  const committingProposalRef = useRef(false);
  const [externalChatRequest, setExternalChatRequest] =
    useState<ExternalChatRequest | null>(null);
  const appliedSeqRef = useRef(0);
  const [lastAppliedProposalEvent, setLastAppliedProposalEvent] =
    useState<AppliedProposalEvent | null>(null);
  const [agentCancelToken, setAgentCancelToken] = useState(0);
  const [agentBusyState, setAgentBusyState] = useState({
    busy: false,
    progressText: "",
    error: "",
  });
  const [inlineAgentFocusTick, setInlineAgentFocusTick] = useState(0);
  const openInlineAgent = () => {
    setInlineAgentOpen(true);
    setInlineAgentFocusTick((n) => n + 1);
  };
  const chatSeqRef = useRef(0);
  const viewOptions: CanvasViewOptions = useMemo(
    () => ({
      showRulers: editor.rulers,
      showPixelGrid,
      showLayoutGuides,
      outlineMode,
      snapEnabled,
      showComments,
    }),
    [
      editor.rulers,
      showPixelGrid,
      showLayoutGuides,
      outlineMode,
      snapEnabled,
      showComments,
    ],
  );
  const toggleViewOption = (key: keyof CanvasViewOptions) => {
    switch (key) {
      case "showRulers":
        editor.setRulers((v) => !v);
        break;
      case "showPixelGrid":
        setShowPixelGrid((v) => !v);
        break;
      case "showLayoutGuides":
        setShowLayoutGuides((v) => !v);
        break;
      case "outlineMode":
        setOutlineMode((v) => !v);
        break;
      case "snapEnabled":
        setSnapEnabled((v) => !v);
        break;
      case "showComments":
        setShowComments((v) => !v);
        break;
    }
  };
  const uiHidden = compact ? !compactPanel : !leftOpen && !rightOpen;
  const toggleAllUI = () => {
    if (compact) {
      if (compactPanel) previousCompact.current = compactPanel;
      setCompactPanel(compactPanel ? null : previousCompact.current);
    } else if (leftOpen || rightOpen) {
      previousPanels.current = { left: leftOpen, right: rightOpen };
      setLeftOpen(false);
      setRightOpen(false);
    } else {
      setLeftOpen(previousPanels.current.left);
      setRightOpen(previousPanels.current.right);
    }
  };
  const [projectUpdate, setProjectUpdate] = useState<{
    zipBytes: Uint8Array;
    preview: ProjectRevisionPreview;
  } | null>(null);
  const [inspectorTab, setInspectorTab] = useState<"design" | "prototype">(
    "design",
  );
  const [preview, setPreview] = useState<{
    open: boolean;
    startFrameId?: string;
  }>({ open: false });
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const { doc, getLifetimeToken, getDocumentEpoch, setError } = editor;
  const currentDocumentEpoch = editor.getCurrentDocumentEpoch();
  const currentFileKey = options.fileKey ?? "forma.document.v1";
  const editingFailedDocument = editor.protectCache;
  const [fileLifetimeInvalid, setFileLifetimeInvalid] = useState(
    editingFailedDocument,
  );
  const [activeProject, setActiveProject] = useState<ProjectSpace | null>();
  const currentScopeId = resolveProjectMemoryScope({
    fileKey: currentFileKey,
    project: activeProject,
  }).scopeProjectId;
  const chatSessionKey = JSON.stringify([
    currentFileKey,
    doc.id,
    currentDocumentEpoch,
    doc.activePage,
    currentScopeId,
  ]);
  const proposalContext = useRef({
    pendingProposal,
    currentScopeId,
    currentFileKey,
  });
  proposalContext.current = { pendingProposal, currentScopeId, currentFileKey };
  const [memoryNotice, setMemoryNotice] = useState("");
  const clearMemoryNotice = useCallback(() => setMemoryNotice(""), []);
  const episodeArchive = useEpisodeArchive(
    currentFileKey,
    doc.id,
    currentScopeId,
    fileLifetimeInvalid,
    clearMemoryNotice,
    currentDocumentEpoch,
  );
  const { beginRead: beginEpisodeRead } = episodeArchive;
  const [promoteModalOpen, setPromoteModalOpen] = useState(false);
  const [statusToast, setStatusToast] = useState("");
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  useEffect(() => {
    setWelcomeDismissed(false);
  }, [doc.id, doc.activePage]);
  const saveCopy = saveStateCopy(editor.saved);
  const memoryRead = useRef(0);
  useLayoutEffect(() => {
    setFileLifetimeInvalid(editingFailedDocument);
    setActiveProject(undefined);
    setMemoryNotice("");
    setPendingProposal(null);
    setExternalChatRequest(null);
    setLastAppliedProposalEvent(null);
    return () => {
      memoryRead.current++;
    };
  }, [doc.id, currentFileKey, currentDocumentEpoch, editingFailedDocument]);
  const invalidateFileLifetime = useCallback(
    (
      message = "当前文件已在其他窗口删除或替换，已隔离项目记忆，请重新打开文件",
    ) => {
      memoryRead.current++;
      setFileLifetimeInvalid(true);
      setActiveProject(undefined);
      setPendingProposal(null);
      setLastAppliedProposalEvent(null);
      setExternalChatRequest(null);
      setMemoryNotice(message);
    },
    [],
  );
  const refreshProjectMemory = useCallback(async () => {
    if (editingFailedDocument || fileLifetimeInvalid) return;
    const read = ++memoryRead.current;
    const updateEpisodes = beginEpisodeRead();
    try {
      const [expectedLifetimeToken, expectedDocumentEpoch] = await Promise.all([
        getLifetimeToken(),
        getDocumentEpoch(),
      ]);
      const archive = await readFileProjectEpisodes(
        currentFileKey,
        { expectedLifetimeToken, expectedDocumentEpoch, expectedDocId: doc.id },
        () => read === memoryRead.current,
      );
      if (archive && read === memoryRead.current) {
        setActiveProject(archive.project);
        updateEpisodes(archive.episodes);
      }
    } catch (error) {
      if (read !== memoryRead.current) return;
      if (isFileLifetimeMismatchError(error)) invalidateFileLifetime();
      else setMemoryNotice(projectMemoryReadErrorMessage(error));
    }
  }, [
    currentFileKey,
    doc.id,
    editingFailedDocument,
    fileLifetimeInvalid,
    getLifetimeToken,
    getDocumentEpoch,
    invalidateFileLifetime,
    beginEpisodeRead,
  ]);
  useEffect(() => {
    const refresh = () => void refreshProjectMemory();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const unsubscribe = subscribeProjectMemory(refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    refresh();
    return () => {
      memoryRead.current++;
      unsubscribe();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshProjectMemory]);
  function resetProjectScope(project: ProjectSpace | null, message: string) {
    setPendingProposal(null);
    setActiveProject(project);
    beginEpisodeRead()([]);
    setStatusToast(message);
    void refreshProjectMemory();
  }
  useEffect(() => {
    if (!statusToast) return;
    const timer = window.setTimeout(() => setStatusToast(""), 4800);
    return () => window.clearTimeout(timer);
  }, [statusToast]);
  async function installProjectLibrary(libraryId: string) {
    const start = editor.historyRef.current.present;
    if (ownLibrary(start.libraries, libraryId)) return;
    try {
      const { findBuiltinEntry } = await import("../design-system/catalog");
      const builtin = findBuiltinEntry(libraryId);
      const source =
        builtin?.library ??
        (await getWorkspaceLibraryRecord(libraryId))?.library;
      if (!source)
        throw new Error("本机找不到项目默认组件库，请重新选择或导入组件库");
      if (!builtin) await loadFonts(source.fonts);
      const current = editor.historyRef.current.present;
      if (start.id !== current.id)
        throw new Error("文件已切换，请在当前文件重新载入组件库");
      if (ownLibrary(current.libraries, libraryId)) return;
      const library = parseLibrary(source);
      editor.apply([{ type: "putLibrary", library }]);
      if (!ownLibrary(editor.historyRef.current.present.libraries, libraryId))
        throw new Error("组件库未能成功写入当前文档");
      setStatusToast(`已载入项目组件库「${library.name}」`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    layers?: string[];
  } | null>(null);
  const projectFile = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const openAsFile = useRef(false);
  const [externalFile, setExternalFile] = useState<File | undefined>(
    options.externalFile,
  );
  const [showImportReport, setShowImportReport] = useState(false);
  const [externalImportProjectId, setExternalImportProjectId] = useState<
    string | null
  >(null);
  const openExternalFile = (next: File, projectId: string | null = null) => {
    setExternalImportProjectId(projectId);
    setShowImportReport(false);
    setExternalFile(next);
  };
  const openNativeDroppedFile = async (selected: File) => {
    try {
      checkDesignFileSize(selected.size, false);
      const content = await readNativeDocument(selected);
      await loadFonts(content.fonts);
      location.assign(await createLocalFile(content));
    } catch (error) {
      editor.setError(
        `导入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const fileMenu = useRef<HTMLDetailsElement>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const appVersion = window.formaDesktop?.version || __FORMA_VERSION__;
  const handleSaveNative = useCallback(
    async (saveAs = false) => {
      try {
        const result = await saveFormaDocument(editorRef.current.committed, {
          fileKey: currentFileKey,
          saveAs,
          appVersion,
        });
        if (result.saved) {
          if (result.filePath) {
            setBoundFile({
              filePath: result.filePath,
              fileName: result.fileName,
            });
          }
          setStatusToast(`已保存设计文件「${result.fileName}」`);
        }
      } catch (error) {
        editorRef.current.setError(
          `保存失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [appVersion, currentFileKey],
  );
  const handleSaveNativeRef = useRef(handleSaveNative);
  handleSaveNativeRef.current = handleSaveNative;
  useEffect(() => {
    const desktop = window.formaDesktop;
    if (!desktop?.getBoundFile) return;
    let active = true;
    void desktop
      .getBoundFile(currentFileKey)
      .then((bound) => {
        if (active) setBoundFile(bound);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [currentFileKey]);
  useEffect(() => {
    if (agentStatus) return;
    let active = true;
    const controller = new AbortController();
    void (async () => {
      let shouldHydrate = hasConfiguredAgentHint();
      if (!shouldHydrate && window.formaDesktop?.hasConfiguredAgent) {
        try {
          shouldHydrate = await window.formaDesktop.hasConfiguredAgent();
        } catch {
          shouldHydrate = false;
        }
      }
      if (!shouldHydrate || !active) return;
      try {
        const next = await fetchAgentStatus(controller.signal);
        if (active) setAgentStatus(next);
      } catch {
        /* Leave manual workspace unaffected if agent service is unavailable. */
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [agentStatus]);
  const presetConsumedRef = useRef(false);
  useEffect(() => {
    if (presetConsumedRef.current) return;
    const url = new URL(location.href);
    const preset = options.initialPreset ?? url.searchParams.get("preset");
    const openAi =
      options.initialPreset === "ai" || url.searchParams.get("ai") === "1";
    if (!preset && !openAi) return;
    presetConsumedRef.current = true;
    if (editorRef.current.committed.nodes.length === 0) {
      if (preset === "mobile") {
        const { label, w, h } = WELCOME_FRAME_PRESETS.mobile;
        editorRef.current.addPresetFrame(label, w, h);
        setWelcomeDismissed(true);
      } else if (preset === "desktop") {
        const { label, w, h } = WELCOME_FRAME_PRESETS.desktop;
        editorRef.current.addPresetFrame(label, w, h);
        setWelcomeDismissed(true);
      }
    }
    if (openAi) {
      setWelcomeDismissed(true);
      setInlineAgentOpen(true);
      setInlineAgentFocusTick((n) => n + 1);
    }
    options.onTabPresetConsumed?.();
    if (url.searchParams.has("preset") || url.searchParams.has("ai")) {
      url.searchParams.delete("preset");
      url.searchParams.delete("ai");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  }, [options.initialPreset, options.onTabPresetConsumed]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const menu = fileMenu.current;
      if (menu?.open && !menu.contains(event.target as Node)) menu.open = false;
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, []);
  useEffect(() => {
    const desktop = window.formaDesktop;
    if (!desktop || !tabActive) return;
    const isEditable = (el: Element | null) =>
      el instanceof HTMLElement &&
      (el.isContentEditable ||
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT");
    const offMenu = desktop.onMenuAction(
      (action) => {
        if (
          (action === "undo" || action === "redo" || action === "selectAll") &&
          isEditable(document.activeElement)
        ) {
          document.execCommand(action);
          return;
        }
        editorRef.current.perform(action);
      },
      (fileAction) => {
        if (fileAction === "save" || fileAction === "saveAs") {
          void handleSaveNativeRef.current(fileAction === "saveAs");
        }
      },
    );
    return offMenu;
  }, [tabActive]);
  const agentDocument = useMemo(
    () => currentPageOnly(editor.committed),
    [editor.committed],
  );
  const views = useMemo(
    () => options.initialViews ?? new Map<string, Viewport>(),
    [doc.id, options.initialViews],
  );
  const busyReason: "ai" | "mcp" | null = agentBusyState.busy
    ? "ai"
    : mcpSessionActive
      ? "mcp"
      : null;
  const tabMetaCbRef = useRef(options.onTabMetaChange);
  tabMetaCbRef.current = options.onTabMetaChange;
  useEffect(() => {
    tabMetaCbRef.current?.({
      title: doc.name,
      dirty: !editor.saved,
      busyReason,
      nativePath: boundFile?.filePath ?? null,
    });
  }, [doc.name, editor.saved, busyReason, boundFile?.filePath]);
  const snapshotCbRef = useRef(options.onTabViewSnapshot);
  snapshotCbRef.current = options.onTabViewSnapshot;
  const latestSnapshotRef = useRef({
    activePage: doc.activePage,
    selectionIds: editor.selection,
    views,
  });
  latestSnapshotRef.current = {
    activePage: doc.activePage,
    selectionIds: editor.selection,
    views,
  };
  useEffect(() => {
    snapshotCbRef.current?.(latestSnapshotRef.current);
  }, [doc.activePage, editor.selection, views]);
  useEffect(() => {
    return () => {
      snapshotCbRef.current?.(latestSnapshotRef.current);
    };
  }, []);
  indexPublishedScene(doc);
  const openMenu = (x: number, y: number, layers?: string[]) =>
    setMenu({ x, y, layers });
  const runAgent = (operations: Operation[], baseRevision: number) => {
    editor.apply(operations, baseRevision);
  };
  const aiPreviewState = useMemo(() => {
    if (!pendingProposal) return null;
    if (pendingProposal.transaction.baseRevision !== editor.committed.revision)
      return null;
    try {
      const previewDoc = transact(
        editor.committed,
        pendingProposal.transaction,
      );
      const beforeMap = new Map(editor.committed.nodes.map((n) => [n.id, n]));
      const changedIds = new Set<string>(pendingProposal.createdRootIds);
      for (const n of previewDoc.nodes) {
        const prev = beforeMap.get(n.id);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(n)) {
          changedIds.add(n.id);
        }
      }
      return { previewDoc, changedIds };
    } catch {
      return null;
    }
  }, [pendingProposal, editor.committed]);
  useEffect(() => {
    if (aiPreviewState) {
      editor.setPreview(aiPreviewState.previewDoc);
    } else {
      editor.setPreview(null);
    }
  }, [aiPreviewState, editor.setPreview]);
  const previousIdentity = useRef({
    file: doc.id,
    page: doc.activePage,
    scope: currentScopeId,
  });
  useEffect(() => {
    const previous = previousIdentity.current;
    if (
      previous.file === doc.id &&
      previous.page === doc.activePage &&
      previous.scope === currentScopeId
    )
      return;
    previousIdentity.current = {
      file: doc.id,
      page: doc.activePage,
      scope: currentScopeId,
    };
    if (
      previous.scope !== currentScopeId &&
      (pendingProposal || agentBusyState.busy)
    ) {
      setStatusToast(staleProposalMessage);
    }
    setPendingProposal(null);
    setExternalChatRequest(null);
    setLastAppliedProposalEvent(null);
    setAgentCancelToken((token) => token + 1);
    setActiveCommentId(null);
  }, [doc.id, doc.activePage, currentScopeId]);

  async function commitAgentProposal(proposal: PendingAgentProposal) {
    if (fileLifetimeInvalid || committingProposalRef.current) return false;
    committingProposalRef.current = true;
    setCommittingProposal(true);
    try {
      let expectedLifetimeToken: string | undefined;
      let expectedDocumentEpoch: number | undefined;
      let liveProject: ProjectSpace | null;
      try {
        [expectedLifetimeToken, expectedDocumentEpoch] = await Promise.all([
          getLifetimeToken(),
          getDocumentEpoch(),
        ]);
        liveProject = await getFileProjectSpace(currentFileKey, {
          requireDurable: typeof indexedDB !== "undefined",
          expectedLifetimeToken,
          expectedDocumentEpoch,
          expectedDocId: doc.id,
          requireBoundLifetime: typeof indexedDB !== "undefined",
        });
      } catch (error) {
        if (isFileLifetimeMismatchError(error)) {
          if (
            proposalContext.current.currentFileKey === currentFileKey &&
            editor.historyRef.current.present.id === doc.id
          )
            invalidateFileLifetime();
        } else if (proposalContext.current.pendingProposal === proposal) {
          setPendingProposal(null);
          setError("无法核验当前文件所属项目空间，已丢弃本次结果");
        }
        return false;
      }
      const liveScopeId = resolveProjectMemoryScope({
        fileKey: currentFileKey,
        project: liveProject,
      }).scopeProjectId;
      if (proposalContext.current.pendingProposal !== proposal) return false;
      if (
        liveScopeId !== proposal.scopeProjectId ||
        liveScopeId !== proposalContext.current.currentScopeId
      ) {
        resetProjectScope(liveProject, staleProposalMessage);
        return false;
      }
      const beforeDoc = editor.historyRef.current.present;
      if (
        beforeDoc.id !== doc.id ||
        beforeDoc.activePage !== doc.activePage ||
        proposal.transaction.baseRevision !== beforeDoc.revision
      )
        throw new Error("文件或页面已变更，请重新生成提案");
      runAgent(
        proposal.transaction.operations,
        proposal.transaction.baseRevision,
      );
      const afterDoc = editor.historyRef.current.present;
      setPendingProposal(null);
      setLastAppliedProposalEvent({
        id: ++appliedSeqRef.current,
        proposal,
        beforeDoc,
        afterDoc,
        scopeProjectId: currentScopeId,
        fileKey: currentFileKey,
        archiveNote: archiveAppliedProposal(
          proposal,
          beforeDoc,
          afterDoc,
          currentFileKey,
          expectedLifetimeToken,
          expectedDocumentEpoch,
          episodeArchive.recordReceipt,
        ),
      });
      return true;
    } finally {
      committingProposalRef.current = false;
      setCommittingProposal(false);
    }
  }

  const applyPendingProposal = async () => {
    if (!pendingProposal) return;
    const applied = pendingProposal;
    try {
      if (!(await commitAgentProposal(applied))) return;
      if (applied.proposalId) {
        void bridgeSnapshotRef.current
          ?.ackProposal(applied.proposalId, "applied")
          .catch(() => {});
      }
      if (applied.taskId) {
        taskProposalsRef.current.delete(applied.taskId);
        setStatusToast(
          "已应用外部任务方案，可继续微调并在顶栏「外部 Agent 任务」中确认回传",
        );
      }
      const rootIds = applied.createdRootIds.filter((id) =>
        editor.historyRef.current.present.nodes.some((node) => node.id === id),
      );
      if (rootIds.length) {
        editor.setSelection(rootIds);
        requestAnimationFrame(() => editor.api.current?.fit(rootIds));
      }
    } catch (e) {
      editor.setError(e instanceof Error ? e.message : String(e));
    }
  };
  const discardPendingProposal = () => {
    const discarded = pendingProposal;
    setPendingProposal(null);
    editor.setPreview(null);
    if (discarded?.proposalId && !discarded.taskId) {
      void bridgeSnapshotRef.current
        ?.ackProposal(discarded.proposalId, "discarded")
        .catch(() => {});
    }
  };
  const handleExternalPendingProposal = useCallback(
    (proposal: PendingIntegrationProposal) => {
      if (proposal.taskId) {
        taskProposalsRef.current.set(proposal.taskId, proposal);
        setStatusToast("收到外部 Agent 设计任务，可在画布审阅或顶栏任务箱回传");
      }
      setPendingProposal(proposal);
    },
    [],
  );
  const handleAutoApplyTransaction = useCallback(
    async (
      tx: Transaction,
      meta: { proposalId?: string; taskId?: string; summary?: string },
    ) => {
      const beforeDoc = editor.historyRef.current.present;
      if (tx.baseRevision !== beforeDoc.revision) {
        throw new Error("画布已发生变更，无法自动应用外部方案");
      }
      runAgent(tx.operations, tx.baseRevision);
      const afterDoc = editor.historyRef.current.present;
      setPendingProposal(null);
      editor.setPreview(null);
      if (meta.proposalId) {
        await bridgeSnapshotRef.current
          ?.ackProposal(meta.proposalId, "applied")
          .catch(() => {});
      }
      if (meta.taskId) {
        taskProposalsRef.current.delete(meta.taskId);
        await bridgeSnapshotRef.current?.completeTask(
          meta.taskId,
          "已按受信任会话自动应用并回传",
          afterDoc,
        );
      }
      setStatusToast("已自动应用外部 Agent 方案（可按 ⌘Z 单步撤销）");
    },
    [editor, runAgent],
  );
  const handleCompleteInboxTask = useCallback(
    async (taskId: string) => {
      const snapshot = bridgeSnapshotRef.current;
      if (!snapshot?.connected) throw new Error("外部 Agent 会话已断开");
      if (pendingProposal?.taskId === taskId) {
        const applied = await commitAgentProposal(pendingProposal);
        if (!applied) throw new Error("应用外部任务方案失败");
        if (pendingProposal.proposalId) {
          await snapshot
            .ackProposal(pendingProposal.proposalId, "applied")
            .catch(() => {});
        }
        taskProposalsRef.current.delete(taskId);
      } else {
        const cached = taskProposalsRef.current.get(taskId);
        if (
          cached &&
          cached.transaction.baseRevision ===
            editor.historyRef.current.present.revision
        ) {
          runAgent(
            cached.transaction.operations,
            cached.transaction.baseRevision,
          );
          if (cached.proposalId) {
            await snapshot
              .ackProposal(cached.proposalId, "applied")
              .catch(() => {});
          }
          taskProposalsRef.current.delete(taskId);
        }
      }
      const latestDoc = editor.historyRef.current.present;
      await snapshot.completeTask(taskId, undefined, latestDoc);
      setStatusToast("已将最新画布产物回传给外部 Agent");
    },
    [editor, pendingProposal, runAgent],
  );
  const handleRejectInboxTask = useCallback(
    async (taskId: string, reason?: string) => {
      if (pendingProposal?.taskId === taskId) {
        setPendingProposal(null);
        editor.setPreview(null);
      }
      taskProposalsRef.current.delete(taskId);
      await bridgeSnapshotRef.current?.rejectTask(taskId, reason);
      setStatusToast("已拒绝外部 Agent 任务");
    },
    [editor, pendingProposal],
  );
  const pendingInboxCount = countPendingInboxTasks(bridgeSnapshot?.tasks ?? []);
  const showAgentInboxButton =
    Boolean(bridgeSnapshot?.connected) ||
    (bridgeSnapshot?.tasks.length ?? 0) > 0;
  const updateComments = (nextComments: DesignComment[]) => {
    editor.attempt(() =>
      editor.apply([{ type: "setComments", comments: nextComments }]),
    );
  };
  return (
    <FileColorContext.Provider value={doc.colorProfile ?? "srgb"}>
      <div
        className="app"
        style={sourceNameFonts(doc.fonts)}
        data-theme={uiTheme}
        data-left-open={showLeft}
        data-right-open={showRight}
      >
        <input
          type="file"
          hidden
          ref={projectFile}
          accept=".zip"
          aria-label="选择已有 React 源码 ZIP"
          onChange={async (event) => {
            const selectedFile = event.target.files?.[0];
            event.target.value = "";
            if (selectedFile)
              try {
                const { applyReactProjectUpdate, previewReactProjectUpdate } =
                  await import("../infrastructure/export-project");
                const bytes = new Uint8Array(await selectedFile.arrayBuffer());
                const report = await previewReactProjectUpdate(
                  editor.committed,
                  bytes,
                );
                if (!report.conflicts.length) {
                  await applyReactProjectUpdate(editor.committed, bytes, {});
                } else {
                  setProjectUpdate({ zipBytes: bytes, preview: report });
                }
              } catch (error) {
                editor.setError(String(error));
              }
          }}
        />
        {releaseNotesOpen && (
          <ErrorBoundary
            scope="modal"
            title="版本日志加载异常"
            onReset={() => setReleaseNotesOpen(false)}
          >
            <Suspense
              fallback={
                <div role="status" className="toast">
                  加载版本日志…
                </div>
              }
            >
              <ReleaseNotesDialog
                version={appVersion}
                close={() => setReleaseNotesOpen(false)}
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {profileOpen && (
          <ColorProfileDialog
            doc={editor.committed}
            save={editor.importDocument}
            close={() => {
              setProfileOpen(false);
              fileMenu.current?.querySelector("summary")?.focus();
            }}
          />
        )}
        <header>
          <details
            className="file-menu"
            ref={fileMenu}
            onToggle={(e) => setFileMenuOpen(e.currentTarget.open)}
            onBlur={(e) => {
              if (
                e.relatedTarget &&
                !e.currentTarget.contains(e.relatedTarget as Node)
              )
                e.currentTarget.open = false;
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.currentTarget.open = false;
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.querySelector("summary")?.focus();
              } else if (
                ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)
              ) {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.open = true;
                const items = Array.from(
                  e.currentTarget.querySelectorAll<HTMLElement>(
                    "button:not(:disabled),a[href]",
                  ),
                );
                const i = items.indexOf(document.activeElement as HTMLElement);
                const next =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? items.length - 1
                      : e.key === "ArrowDown"
                        ? (i + 1) % items.length
                        : (Math.max(i, 0) + items.length - 1) % items.length;
                items[next]?.focus();
              }
            }}
          >
            <summary
              className="brand"
              aria-label="文件菜单"
              title="文件菜单"
              data-tip="文件与项目菜单"
              data-tip-desc="打开本地文件、切换界面主题、整文件导出与版本恢复"
              data-tip-side="bottom"
            >
              <span className="brand-mark">f</span>
              <span>Forma</span>
              <ChevronDown size={12} className="brand-chevron" />
            </summary>
            <div
              onClick={() => {
                if (fileMenu.current) fileMenu.current.open = false;
              }}
            >
              <button
                onClick={() => {
                  if (options.onOpenHome) options.onOpenHome();
                  else location.assign(homeUrl());
                }}
              >
                <Home size={13} />
                <span>返回工作台首页</span>
              </button>
              <button
                onClick={() => {
                  if (options.onNewDesignTab) {
                    options.onNewDesignTab({
                      projectId: activeProject?.id,
                      preset: "blank",
                    });
                  } else {
                    void newBlankFile(activeProject?.id).catch((err) =>
                      editor.setError(String(err)),
                    );
                  }
                }}
              >
                <FilePlus2 size={13} />
                <span>新建空白文件</span>
              </button>
              <button
                onClick={() => {
                  openAsFile.current = true;
                  file.current?.click();
                }}
              >
                <FolderOpen size={13} />
                <span>打开设计文件…</span>
              </button>
              <RecentFilesSubmenu
                currentFileKey={currentFileKey}
                menuOpen={fileMenuOpen}
                onOpenFile={(target) => {
                  if (fileMenu.current) fileMenu.current.open = false;
                  if (options.onOpenFileTab) options.onOpenFileTab(target);
                  else location.assign(fileUrl(target.fileKey));
                }}
                onOpenHome={() => {
                  if (fileMenu.current) fileMenu.current.open = false;
                  if (options.onOpenHome) options.onOpenHome();
                  else location.assign(homeUrl());
                }}
              />
              {editor.committed.importReport && (
                <button onClick={() => setShowImportReport(true)}>
                  <Layers size={13} />
                  <span>查看导入报告…</span>
                </button>
              )}
              <button onClick={() => setFilesOpen(true)}>
                <Layers size={13} />
                <span>浏览本机文件…</span>
              </button>
              <button onClick={() => void handleSaveNative(false)}>
                <Save size={13} />
                <span>
                  {boundFile
                    ? `保存到 ${boundFile.fileName}`
                    : "保存设计文件 (.forma)"}
                </span>
                <kbd>⌘S</kbd>
              </button>
              {window.formaDesktop && (
                <button onClick={() => void handleSaveNative(true)}>
                  <Save size={13} />
                  <span>另存为 .forma…</span>
                  <kbd>⇧⌘S</kbd>
                </button>
              )}
              <button
                onClick={() => {
                  downloadFormaFile(editor.committed, appVersion);
                }}
              >
                <Download size={13} />
                <span>保存本地副本 (.forma)</span>
              </button>
              <hr />
              <button onClick={() => setProfileOpen(true)}>
                <Palette size={13} />
                <span>颜色配置 · {profileLabel(doc.colorProfile)}…</span>
              </button>
              <button
                onClick={() =>
                  setUiTheme((t) => (t === "dark" ? "light" : "dark"))
                }
              >
                {uiTheme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
                <span>
                  切换至{uiTheme === "dark" ? "浅色" : "深色"}界面主题
                </span>
              </button>
              <hr />
              <button
                onClick={() =>
                  void import("../infrastructure/export-project")
                    .then(({ downloadReactProject }) =>
                      downloadReactProject(
                        editor.committed,
                        editor.selection,
                        "file",
                      ),
                    )
                    .catch((error) => editor.setError(String(error)))
                }
              >
                <FileCode2 size={13} />
                <span>导出整个文件为 React 项目…</span>
              </button>
              <button onClick={() => projectFile.current?.click()}>
                <FolderSync size={13} />
                <span>更新已有 React 工程…</span>
              </button>
              <button onClick={() => setBatchExportOpen(true)}>
                <Package size={13} />
                <span>批量导出切片与资源…</span>
                <kbd>⇧⌘E</kbd>
              </button>
              <hr />
              <button onClick={() => setLintOpen(true)}>
                <ShieldCheck size={13} />
                <span>设计规范校验 (Check designs)…</span>
              </button>
              <button onClick={() => setModelConfigOpen(true)}>
                <Settings2 size={13} />
                <span>配置 AI 模型供应商…</span>
              </button>
              <button onClick={openIntegrations}>
                <Cable size={13} />
                <span>外部工具集成（MCP）…</span>
              </button>
              <hr />
              <a
                href="?example=mobile-studio&edition=atlas&page=atlas&node=atlas-tablet-root"
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  if (
                    options.onOpenExampleTab &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey &&
                    event.button === 0
                  ) {
                    event.preventDefault();
                    options.onOpenExampleTab({
                      example: "mobile-studio",
                      edition: "atlas",
                      page: "atlas",
                      node: "atlas-tablet-root",
                      title: "移动设计研究室",
                    });
                  }
                }}
              >
                打开移动设计研究室 ↗
              </a>
              <a
                href="?example=aura-showcase"
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  if (
                    options.onOpenExampleTab &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey &&
                    event.button === 0
                  ) {
                    event.preventDefault();
                    options.onOpenExampleTab({
                      example: "aura-showcase",
                      title: "SaaS 工作台样例",
                    });
                  }
                }}
              >
                打开 SaaS 产品与营销样例 ↗
              </a>
              <hr />
              <button onClick={() => void editor.recoverPrevious()}>
                <History size={13} />
                <span>恢复上次保存版本</span>
              </button>
              <button onClick={() => void editor.downloadBackup()}>
                <HardDriveDownload size={13} />
                <span>下载存储备份</span>
              </button>
              <hr />
              <button
                type="button"
                className="file-menu-version"
                aria-haspopup="dialog"
                onClick={() => {
                  fileMenu.current?.querySelector("summary")?.focus();
                  setReleaseNotesOpen(true);
                }}
              >
                <span>
                  Forma v{appVersion}
                  {window.formaDesktop ? " · 桌面客户端" : " · Web"}
                </span>
                <span>版本日志</span>
              </button>
            </div>
          </details>
          {!options.onOpenHome && (
            <a
              href={homeUrl()}
              className="header-home-btn"
              aria-label="返回工作台"
              data-tip="返回工作台首页"
              data-tip-desc="管理项目空间、最近文件或新建设计"
              data-tip-side="bottom"
            >
              <Home size={14} />
              <span>工作台</span>
            </a>
          )}
          <div className="panel-switches">
            {(["left", "right"] as const).map((side) => {
              const left = side === "left";
              const label = left ? "图层与资源面板" : "属性面板";
              const open = left ? showLeft : showRight;
              const Icon = left ? PanelLeft : PanelRight;
              return (
                <button
                  key={side}
                  className="icon-btn"
                  aria-label={label}
                  aria-expanded={open}
                  aria-controls={side + "-panel"}
                  data-tip={(open ? "收起" : "打开") + label}
                  data-tip-side="bottom"
                  onClick={() => togglePanel(side)}
                >
                  <Icon size={15} />
                </button>
              );
            })}
          </div>
          <div className="breadcrumb">
            <button
              type="button"
              className="breadcrumb-workspace"
              aria-label="打开本机工作空间文件列表"
              data-tip={
                activeProject === null
                  ? "未归类草稿 · 点击归入项目空间或浏览本机文件"
                  : "点击管理项目与本机文件"
              }
              data-tip-side="bottom"
              onClick={() => setFilesOpen(true)}
            >
              {activeProject === undefined
                ? "项目归属待核验"
                : (activeProject?.name ?? "个人空间")}
            </button>
            <span className="breadcrumb-sep">/</span>
            <input
              aria-label="文件名"
              key={doc.id + ":" + doc.name}
              defaultValue={doc.name}
              onBlur={(event) => {
                const name = event.target.value.trim();
                if (name && name !== doc.name)
                  editor.attempt(() =>
                    editor.importDocument({ ...editor.committed, name }),
                  );
                else event.target.value = doc.name;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <span
              className="save-state"
              title={saveCopy.title}
              data-tip={saveCopy.tip}
              data-tip-desc={saveCopy.desc}
              data-tip-side="bottom"
            >
              {editor.saved ? (
                <Check size={12} />
              ) : (
                <span aria-label="保存中">·</span>
              )}
            </span>
          </div>
          <div className="header-actions">
            <button
              className="icon-btn"
              aria-label={uiTheme === "dark" ? "切换浅色主题" : "切换深色主题"}
              data-tip={uiTheme === "dark" ? "切换浅色主题" : "切换深色主题"}
              data-tip-desc="在 Figma UI3 深色与浅色外观之间切换"
              data-tip-side="bottom"
              onClick={() =>
                setUiTheme((t) => (t === "dark" ? "light" : "dark"))
              }
            >
              {uiTheme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            {(!showLeft || compact) && (
              <button
                className="icon-btn"
                title="变量与样式"
                aria-label="变量与样式"
                data-tip="变量与样式"
                data-tip-desc="管理颜色/数值/文本变量集合、多模式主题与复用样式"
                data-tip-side="bottom"
                onClick={() => openDesignSystem("variables")}
              >
                <Variable size={16} />
              </button>
            )}
            <button
              className={`icon-btn ${lintOpen ? "active" : ""}`}
              title="设计规范校验"
              aria-label="设计规范校验"
              aria-pressed={lintOpen}
              data-tip="设计规范校验"
              data-tip-desc="检查未绑定变量、字体规范与 WCAG 对比度并支持一键修复"
              data-tip-side="bottom"
              onClick={() => setLintOpen((v) => !v)}
            >
              <ShieldCheck size={15} />
            </button>
            <button
              className={`icon-btn ${commentsOpen ? "active" : ""}`}
              title="画布评审评论"
              aria-label="画布评审评论"
              aria-pressed={commentsOpen}
              data-tip="评审评论"
              data-tip-kbd="C"
              data-tip-desc="查看和管理画布评论图钉，或按 C 在画布上添加评论"
              data-tip-side="bottom"
              onClick={() => setCommentsOpen((v) => !v)}
            >
              <MessageSquare size={15} />
            </button>
            {showAgentInboxButton && (
              <button
                type="button"
                className={`icon-btn header-inbox-btn ${inboxOpen ? "active" : ""}`}
                title="外部 Agent 任务"
                aria-label="外部 Agent 任务"
                aria-expanded={inboxOpen}
                aria-haspopup="dialog"
                data-tip="外部 Agent 任务收件箱"
                data-tip-desc="查看、审阅并回传通过 MCP / A2A 委派的设计任务"
                data-tip-side="bottom"
                onClick={() => setInboxOpen((v) => !v)}
              >
                <Inbox size={15} />
                {pendingInboxCount > 0 && (
                  <span className="header-inbox-badge">
                    {pendingInboxCount > 9 ? "9+" : pendingInboxCount}
                  </span>
                )}
              </button>
            )}
            <button
              className="icon-btn"
              title="快捷键 ?"
              aria-label="快捷键 ?"
              data-tip="快捷键指南"
              data-tip-kbd="?"
              data-tip-desc="查看画布导航、选择、编辑与绘图快捷键"
              data-tip-side="bottom"
              onClick={() => editor.setHelp(true)}
            >
              <HelpCircle size={16} />
            </button>
            <span className="toolbar-sep" aria-hidden="true" />
            <button
              className="header-new-btn"
              title="新建空白文件"
              aria-label="新建空白文件"
              data-tip="新建设计文件"
              data-tip-desc={
                activeProject
                  ? `在「${activeProject.name}」项目中新建设计文件`
                  : "创建一份新的空白设计文件"
              }
              data-tip-side="bottom"
              onClick={() => {
                if (options.onNewDesignTab) {
                  options.onNewDesignTab({
                    projectId: activeProject?.id,
                    preset: "blank",
                  });
                } else {
                  void newBlankFile(activeProject?.id).catch((err) =>
                    editor.setError(String(err)),
                  );
                }
              }}
            >
              <FilePlus2 size={14} />
              <span>新建</span>
            </button>
            {(!showLeft || compact) && (
              <button
                className="icon-btn"
                title="编辑菜单 / ⌘ K"
                aria-label="操作"
                data-tip="命令面板"
                data-tip-kbd="⌘K"
                data-tip-desc="搜索并快速执行编组、对齐、图层和视图命令"
                data-tip-side="bottom"
                onClick={() => editor.setPalette(true)}
              >
                <ListFilter size={15} />
              </button>
            )}
            <button
              className="icon-btn"
              title="下载设计文件"
              aria-label="设计文件"
              data-tip={
                boundFile
                  ? `保存到 ${boundFile.fileName}`
                  : "保存 .forma 设计文件"
              }
              data-tip-kbd="⌘S"
              data-tip-desc="保存可双击直接打开的 .forma 原生设计文件"
              data-tip-side="bottom"
              onClick={() => void handleSaveNative(false)}
            >
              <Download size={15} />
            </button>
            <span className="toolbar-sep" aria-hidden="true" />
            <button
              className="icon-btn"
              title="代码"
              aria-label="代码"
              data-tip="查看 React / Token 代码"
              data-tip-kbd="⇧D"
              data-tip-desc="预览当前画板的 React + TypeScript 源码与 CSS Tokens"
              data-tip-side="bottom"
              onClick={(ev) => {
                ev.currentTarget.focus();
                editor.attempt(() => setCodeOpen(true));
              }}
            >
              <Code2 size={15} />
            </button>
            <button
              className="icon-btn"
              title="预览"
              aria-label="预览"
              data-tip="原型交互预览"
              data-tip-desc="在播放器中测试跨页跳转、浮层与响应式视口"
              data-tip-side="bottom"
              onClick={() =>
                editor.attempt(() => {
                  prototypeProgram(linkedPrototypeScene(doc));
                  setPreview({ open: true });
                })
              }
            >
              <Play size={15} />
            </button>
            <button
              className="primary header-export-btn"
              data-tip="导出独立 React 工程"
              data-tip-desc="打包选中画板与原型依赖为可直接构建的 Vite + TS ZIP"
              data-tip-side="bottom"
              onClick={() =>
                void import("../infrastructure/export-project")
                  .then(({ downloadReactProject }) =>
                    downloadReactProject(editor.committed, editor.selection),
                  )
                  .catch((error) => editor.setError(String(error)))
              }
            >
              导出 React 项目 <ArrowUpRight size={15} />
            </button>
          </div>
        </header>
        <aside id="left-panel" hidden={!showLeft} className="left-panel">
          <nav className="panel-tabs" aria-label="工作区导航">
            <button
              title="图层"
              data-tip="图层与页面"
              data-tip-desc="管理当前文件的多页目录与图层层级"
              data-tip-side="bottom"
              aria-pressed={tab === "layers"}
              className={tab === "layers" ? "active" : ""}
              onClick={() => setTab("layers")}
            >
              <Layers size={14} />
              图层
            </button>
            <button
              title="资源"
              data-tip="组件与资源库"
              data-tip-desc="浏览并插入原生组件、页面模板与设计规范"
              data-tip-side="bottom"
              aria-pressed={tab === "assets"}
              className={tab === "assets" ? "active" : ""}
              onClick={() => setTab("assets")}
            >
              <Shapes size={14} />
              资源
            </button>
            <button
              aria-pressed={tab === "agent"}
              className={tab === "agent" ? "active" : ""}
              title="Agent"
              aria-label="AI 设计助手"
              data-tip="AI 设计助手"
              data-tip-desc="使用自然语言基于设计系统生成或局部修改可编辑图层"
              data-tip-side="bottom"
              onClick={() => setTab("agent")}
            >
              <Sparkles size={14} />
              <span>助手</span>
            </button>
            <span className="panel-tabs-sep" aria-hidden="true" />
            <button
              className="icon-btn"
              title="导入设计文件"
              aria-label="导入设计文件"
              data-tip="导入设计文件"
              data-tip-desc="载入 Forma 文件，或从 Sketch、Figma 原档创建新文件"
              data-tip-side="bottom"
              onClick={() => {
                openAsFile.current = false;
                file.current?.click();
              }}
            >
              <Upload size={14} />
              <span>导入</span>
            </button>
            {!compact && (
              <>
                <button
                  aria-label="操作"
                  data-tip="搜索操作"
                  data-tip-kbd="⌘K"
                  data-tip-side="right"
                  onClick={() => editor.setPalette(true)}
                >
                  <ListFilter size={15} />
                  <span>操作</span>
                </button>
                <button
                  aria-label="变量与样式"
                  data-tip="变量与样式"
                  data-tip-side="right"
                  aria-pressed={!!designSystemTarget}
                  onClick={() => openDesignSystem()}
                >
                  <Variable size={15} />
                  <span>变量</span>
                </button>
              </>
            )}
          </nav>
          <div className={`sidebar-content ${tab}-sidebar`}>
            <ErrorBoundary
              scope="panel"
              title="侧栏面板加载异常"
              resetKey={`${tab}:${doc.id}`}
            >
              {tab === "layers" ? (
                <>
                  <PagesPanel editor={editor} />
                  <LayersPanel
                    key={doc.id + ":" + doc.activePage}
                    editor={editor}
                    contextMenu={openMenu}
                    onSelectMatching={() => editor.perform("selectMatching")}
                  />
                </>
              ) : tab === "assets" ? (
                <Suspense
                  fallback={<div className="compact-empty">加载资源…</div>}
                >
                  <AssetsPanel
                    key={doc.id}
                    editor={editor}
                    managerOpen={libraryManagerOpen}
                    setManagerOpen={setLibraryManagerOpen}
                    onPromoteModule={() => setPromoteModalOpen(true)}
                  />
                </Suspense>
              ) : null}
              <div className="agent-sidebar-host" hidden={tab !== "agent"}>
                <AgentPanel
                  key={chatSessionKey}
                  document={agentDocument}
                  activePageId={doc.activePage}
                  fileKey={currentFileKey}
                  getFileLifetimeToken={editor.getLifetimeToken}
                  getFileDocumentEpoch={editor.getDocumentEpoch}
                  fileLifetimeInvalid={fileLifetimeInvalid}
                  onFileLifetimeInvalidated={invalidateFileLifetime}
                  activeProject={activeProject}
                  onProjectScopeChanged={resetProjectScope}
                  episodeArchive={episodeArchive}
                  onRefreshEpisodes={refreshProjectMemory}
                  onOpenFileBrowser={() => setFilesOpen(true)}
                  onOpenPromoteModule={() => setPromoteModalOpen(true)}
                  canPromoteSelection={!editor.componentUnavailable}
                  onInstallProjectLibrary={installProjectLibrary}
                  selectionCount={editor.selection.length}
                  selection={
                    editor.selection.length === 1 ? editor.selection[0] : null
                  }
                  selectionIds={editor.selection}
                  onCommitProposal={commitAgentProposal}
                  applyingProposal={committingProposal}
                  lastAppliedProposalEvent={lastAppliedProposalEvent}
                  onExternalChatConsumed={(id) =>
                    setExternalChatRequest((cur) =>
                      cur?.id === id ? null : cur,
                    )
                  }
                  focusNode={(id) => {
                    editor.setSelection([id]);
                    requestAnimationFrame(() => editor.api.current?.fit([id]));
                  }}
                  status={agentStatus}
                  onStatusChange={setAgentStatus}
                  onOpenConfig={() => setModelConfigOpen(true)}
                  pendingProposal={pendingProposal}
                  onPendingProposalChange={setPendingProposal}
                  viewportCenter={editor.api.current?.center()}
                  externalChatRequest={externalChatRequest}
                  cancelToken={agentCancelToken}
                  onBusyChange={(busy, progressText, error) =>
                    setAgentBusyState({ busy, progressText, error })
                  }
                  onUndoLastApply={() => editor.undo()}
                />
              </div>
            </ErrorBoundary>
            <div
              className="milestone"
              title={`文档修订 ${doc.revision} · ${saveCopy.title}`}
            >
              <i />
              {doc.nodes.length} 图层
            </div>
          </div>
        </aside>
        <PanelDivider side="left" visible={showLeft && !compact} />
        <PanelDivider side="right" visible={showRight && !compact} />
        <ErrorBoundary
          scope="workspace"
          title="画布视图遇到意外错误"
          resetKey={`${doc.id}:${doc.activePage}`}
          getRecoveryDocument={() => editor.historyRef.current.present}
        >
          <Canvas
            onImportDesign={openExternalFile}
            onOpenNativeDesign={(selected) =>
              void openNativeDroppedFile(selected)
            }
            prototypeMode={inspectorTab === "prototype"}
            views={views}
            key={doc.id + ":" + doc.activePage}
            editor={editor}
            contextMenu={openMenu}
            onPlayFlow={(frameId) =>
              editor.attempt(() => {
                prototypeProgram(linkedPrototypeScene(doc));
                setPreview({ open: true, startFrameId: frameId });
              })
            }
            viewOptions={viewOptions}
            onToggleViewOption={toggleViewOption}
            onToggleUI={toggleAllUI}
            uiHidden={uiHidden}
            devMode={devMode}
            onToggleDevMode={() =>
              setDevMode((v) => {
                const next = !v;
                if (next) {
                  if (compact) setCompactPanel("right");
                  else setRightOpen(true);
                }
                return next;
              })
            }
            comments={doc.comments ?? []}
            activeCommentId={activeCommentId}
            onSelectComment={setActiveCommentId}
            onUpdateComments={updateComments}
            onOpenInlineAgent={() => setInlineAgentOpen((v) => !v)}
            aiPreviewNodeIds={aiPreviewState?.changedIds}
            onOpenDesignLint={() => setLintOpen((v) => !v)}
          />
        </ErrorBoundary>
        <CanvasWelcomeOverlay
          visible={
            doc.nodes.length === 0 &&
            editor.tool === "select" &&
            !pendingProposal &&
            !welcomeDismissed &&
            !inlineAgentOpen
          }
          onCreateFrame={(label, width, height) => {
            editor.addPresetFrame(label, width, height);
            setWelcomeDismissed(true);
          }}
          onOpenAi={() => {
            setWelcomeDismissed(true);
            openInlineAgent();
          }}
          onImportFile={() => {
            openAsFile.current = false;
            file.current?.click();
          }}
          onDismiss={() => setWelcomeDismissed(true)}
        />
        <CanvasChatDraft
          key={JSON.stringify([chatSessionKey, fileLifetimeInvalid])}
          scopeProjectId={currentScopeId}
          projectEpisodes={episodeArchive.pickerEpisodes}
          open={inlineAgentOpen}
          focusTick={inlineAgentFocusTick}
          onClose={() => setInlineAgentOpen(false)}
          document={agentDocument}
          selection={editor.selection.length === 1 ? editor.selection[0] : null}
          selectionCount={editor.selection.length}
          viewportCenter={editor.api.current?.center()}
          status={agentStatus}
          pendingProposal={pendingProposal}
          applyingProposal={committingProposal}
          busy={agentBusyState.busy}
          progressText={agentBusyState.progressText}
          error={agentBusyState.error}
          onOpenConfig={() => setModelConfigOpen(true)}
          onSendPrompt={(input) => {
            chatSeqRef.current += 1;
            setExternalChatRequest({
              id: chatSeqRef.current,
              pageId: doc.activePage,
              scopeProjectId: currentScopeId,
              prompt: input.prompt,
              mentions: input.mentions.map(capturePickerMention),
              attachments: input.attachments,
            });
          }}
          onCancel={() => setAgentCancelToken((n) => n + 1)}
          onApplyProposal={applyPendingProposal}
          onDiscardProposal={discardPendingProposal}
          onOpenFullChat={() => {
            setTab("agent");
            if (compact) setCompactPanel("left");
            else setLeftOpen(true);
            setInlineAgentOpen(false);
          }}
        />
        <aside
          id="right-panel"
          className={`right-panel ${devMode ? "is-dev-mode" : ""}`}
          hidden={!showRight}
        >
          <ErrorBoundary
            scope="panel"
            title="属性面板加载异常"
            resetKey={`${devMode ? "dev" : inspectorTab}:${doc.id}:${editor.selection.join(",")}`}
          >
            {devMode ? (
              <>
                <div className="inspector-tabs fp-dev-header-tabs">
                  <span className="fp-dev-mode-pill">
                    <Code2 size={12} />
                    开发检查 (Dev Mode)
                  </span>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    aria-label="退出开发模式"
                    title="退出开发模式"
                    data-tip="退出开发模式"
                    data-tip-kbd="⇧D"
                    data-tip-side="left"
                    onClick={() => setDevMode(false)}
                  >
                    <X size={13} />
                  </button>
                </div>
                <Suspense
                  fallback={<div className="compact-empty">加载开发检查…</div>}
                >
                  <DevModePanel
                    document={editor.committed}
                    selectedIds={editor.selection}
                    onSelectNode={(id) => {
                      editor.setSelection([id]);
                      requestAnimationFrame(() =>
                        editor.api.current?.fit([id]),
                      );
                    }}
                    onUpdateNode={(id, patch) =>
                      editor.attempt(() =>
                        editor.apply([{ type: "update", id, patch }]),
                      )
                    }
                    onOpenFullCode={() =>
                      editor.attempt(() => setCodeOpen(true))
                    }
                    onExportReact={() =>
                      void import("../infrastructure/export-project")
                        .then(({ downloadReactProject }) =>
                          downloadReactProject(
                            editor.committed,
                            editor.selection,
                          ),
                        )
                        .catch((error) => editor.setError(String(error)))
                    }
                  />
                </Suspense>
              </>
            ) : (
              <>
                <div className="inspector-tabs">
                  <button
                    aria-pressed={inspectorTab === "design"}
                    onClick={() => setInspectorTab("design")}
                  >
                    设计
                  </button>
                  <button
                    aria-pressed={inspectorTab === "prototype"}
                    onClick={() => setInspectorTab("prototype")}
                  >
                    原型
                  </button>
                  {editor.selected.length > 1 && editor.tool !== "frame" ? (
                    <span className="selection-pill">
                      {editor.selection.length} 项
                    </span>
                  ) : !editor.selected.length || editor.tool === "frame" ? (
                    <button
                      type="button"
                      className={`inspector-ai-btn inspector-tabs-ai ${agentStatus?.configured && agentStatus.activeProfile ? "is-ready" : ""}`}
                      title="用 AI 对话生成设计稿"
                      aria-label="用 AI 对话生成新画板"
                      data-tip="AI 对话生成"
                      data-tip-kbd="⌘↵"
                      data-tip-desc="打开画布 Agent 对话框，直接通过对话生成新的页面或组件"
                      data-tip-side="left"
                      onClick={openInlineAgent}
                    >
                      <Sparkles size={12} />
                      <span>AI</span>
                    </button>
                  ) : null}
                </div>
                {inspectorTab === "prototype" ? (
                  <PrototypeInspector
                    editor={editor}
                    openVariables={() => openDesignSystem("variables")}
                  />
                ) : editor.selected.length && editor.tool !== "frame" ? (
                  <Inspector
                    editor={editor}
                    tool={editor.tool}
                    onExitScale={() => editor.setTool("select")}
                    onOpenBatchExport={() => setBatchExportOpen(true)}
                    onOpenDesignLint={() => setLintOpen(true)}
                    onOpenInlineAgent={openInlineAgent}
                    agentConfigured={Boolean(
                      agentStatus?.configured && agentStatus.activeProfile,
                    )}
                    onApplyOperations={(ops) =>
                      editor.attempt(() => editor.apply(ops))
                    }
                  />
                ) : (
                  <div className="page-inspector">
                    <section>
                      <div className="section-title">页面背景</div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <ColorField
                            label="页面背景色"
                            color={
                              doc.pageBackground ??
                              (uiTheme === "dark" ? "#1e1e1e" : "#f5f5f5")
                            }
                            alpha={doc.pageBackgroundOpacity ?? 1}
                            onChange={(color, alpha) =>
                              editor.attempt(() =>
                                editor.apply([
                                  {
                                    type: "setPageBackground",
                                    color,
                                    opacity: alpha,
                                    visible: true,
                                  },
                                ]),
                              )
                            }
                          />
                        </div>
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm"
                          aria-label={
                            doc.pageBackgroundVisible === false
                              ? "显示页面背景"
                              : "隐藏页面背景"
                          }
                          data-tip={
                            doc.pageBackgroundVisible === false
                              ? "显示页面背景"
                              : "隐藏页面背景"
                          }
                          data-tip-side="left"
                          onClick={() =>
                            editor.attempt(() =>
                              editor.apply([
                                {
                                  type: "setPageBackground",
                                  color:
                                    doc.pageBackground ??
                                    (uiTheme === "dark"
                                      ? "#1e1e1e"
                                      : "#f5f5f5"),
                                  opacity: doc.pageBackgroundOpacity ?? 1,
                                  visible: doc.pageBackgroundVisible === false,
                                },
                              ]),
                            )
                          }
                        >
                          {doc.pageBackgroundVisible === false ? (
                            <EyeOff size={13} />
                          ) : (
                            <Eye size={13} />
                          )}
                        </button>
                      </div>
                    </section>
                    {editor.tool === "frame" && (
                      <section>
                        <div className="section-title">画板预设</div>
                        {UNIFIED_FRAME_PRESET_GROUPS.map((group) => {
                          const GroupIcon = group.icon;
                          return (
                            <details
                              key={group.id}
                              className="preset-category"
                              open={group.defaultOpen}
                            >
                              <summary>
                                <GroupIcon size={12} />
                                <span>{group.label}</span>
                              </summary>
                              <div className="preset-list">
                                {group.items.map((item) => (
                                  <button
                                    key={item.label}
                                    type="button"
                                    className="preset-row-btn"
                                    onClick={() =>
                                      editor.addPresetFrame(
                                        item.label,
                                        item.w,
                                        item.h,
                                      )
                                    }
                                  >
                                    <span>{item.label}</span>
                                    <small>
                                      {item.w}×{item.h}
                                    </small>
                                  </button>
                                ))}
                              </div>
                            </details>
                          );
                        })}
                      </section>
                    )}
                    <section>
                      <div className="section-title">
                        本地变量
                        <button
                          className="icon-btn icon-btn-sm"
                          title="管理变量与样式"
                          aria-label="管理变量与样式"
                          data-tip="管理本地变量"
                          data-tip-desc="编辑颜色、尺寸、圆角与文字变量及多主题模式"
                          data-tip-side="left"
                          onClick={() => openDesignSystem("variables")}
                        >
                          <Variable size={15} />
                        </button>
                      </div>
                      <button
                        className="wide local-system-button"
                        onClick={() => openDesignSystem("variables")}
                      >
                        <Variable size={14} />
                        变量与样式
                        <span>
                          {
                            Object.keys(doc.designSystem?.variables ?? {})
                              .length
                          }
                        </span>
                      </button>
                    </section>
                    <ModeSelectors editor={editor} document />
                    <section
                      className={
                        !Object.keys(doc.designSystem?.styles ?? {}).length
                          ? "is-collapsed-section"
                          : undefined
                      }
                    >
                      <div className="section-title">
                        本地样式
                        <button
                          className="icon-btn icon-btn-sm"
                          title="管理样式"
                          aria-label="管理样式"
                          data-tip="新建或管理本地样式"
                          data-tip-desc="打开样式库以创建或编辑颜色、文本与效果样式"
                          data-tip-side="left"
                          onClick={() => openDesignSystem("styles")}
                        >
                          +
                        </button>
                      </div>
                      {(() => {
                        const allStyles = Object.values(
                          doc.designSystem?.styles ?? {},
                        );
                        const activeStyles = allStyles.filter(
                          (s) => !s.sourceArchived,
                        );
                        const archivedStyles = allStyles.filter(
                          (s) => s.sourceArchived,
                        );
                        const renderStyleRow = (
                          style: (typeof allStyles)[number],
                        ) => {
                          let swatchColor: string | undefined;
                          if (style.kind === "paint") {
                            const boundId = style.bindings.fill;
                            if (boundId && doc.designSystem) {
                              try {
                                swatchColor = String(
                                  resolveVariable(
                                    doc.designSystem,
                                    boundId,
                                    doc.designSystem.activeModes,
                                  ),
                                );
                              } catch {
                                swatchColor = style.properties.fill;
                              }
                            } else {
                              swatchColor = style.properties.fill;
                            }
                          }
                          return (
                            <button
                              className="local-style-row"
                              key={style.id}
                              title={style.description || style.name}
                              onClick={() =>
                                openDesignSystem("styles", style.id)
                              }
                            >
                              {style.kind === "paint" && swatchColor ? (
                                <i
                                  className="local-style-swatch"
                                  style={{
                                    background: displayColor(
                                      swatchColor,
                                      doc.colorProfile,
                                    ),
                                  }}
                                />
                              ) : style.kind === "text" ? (
                                <TypeIcon size={12} />
                              ) : style.kind === "grid" ? (
                                <LayoutGrid size={12} />
                              ) : (
                                <Sparkles size={12} />
                              )}
                              <span className="truncate">{style.name}</span>
                            </button>
                          );
                        };
                        return (
                          <>
                            {STYLE_GROUPS.map(({ kind, label }) => {
                              const list = activeStyles.filter(
                                (s) => s.kind === kind,
                              );
                              if (!list.length) return null;
                              return (
                                <div key={kind}>
                                  <div className="local-style-group-title">
                                    {label}
                                  </div>
                                  {list.map(renderStyleRow)}
                                </div>
                              );
                            })}
                            {archivedStyles.length > 0 && (
                              <details className="archived-styles-group">
                                <summary className="local-style-group-title archived-styles-summary">
                                  <span>已归档源样式</span>
                                  <span className="fp-count-pill">
                                    {archivedStyles.length}
                                  </span>
                                </summary>
                                {archivedStyles.map(renderStyleRow)}
                              </details>
                            )}
                          </>
                        );
                      })()}
                    </section>
                    {(() => {
                      const exportCount = doc.nodes.filter(
                        (n) =>
                          n.type === "slice" ||
                          (n.exportSettings?.length ?? 0) > 0,
                      ).length;
                      return (
                        <section
                          className={
                            exportCount === 0
                              ? "is-collapsed-section"
                              : undefined
                          }
                        >
                          <div className="section-title">
                            <span className="fp-section-heading">
                              导出
                              {exportCount > 0 && (
                                <span className="fp-count-pill">
                                  {exportCount}
                                </span>
                              )}
                            </span>
                            <button
                              className="icon-btn icon-btn-sm"
                              title="批量导出资源"
                              aria-label="批量导出资源"
                              data-tip="批量导出切片与资源"
                              data-tip-kbd="⇧⌘E"
                              data-tip-desc="导出文档内所有已配置导出预设的图层与切片"
                              data-tip-side="left"
                              onClick={() => setBatchExportOpen(true)}
                            >
                              +
                            </button>
                          </div>
                          {exportCount > 0 && (
                            <button
                              type="button"
                              className="wide local-system-button"
                              onClick={() => setBatchExportOpen(true)}
                            >
                              <Package size={14} />
                              批量导出切图与切片
                              <span>{exportCount}</span>
                            </button>
                          )}
                        </section>
                      );
                    })()}
                  </div>
                )}
              </>
            )}
          </ErrorBoundary>
        </aside>
        {designSystemTarget && (
          <ErrorBoundary
            scope="modal"
            title="变量与样式窗口加载异常"
            onReset={() => setDesignSystemTarget(null)}
          >
            <Suspense
              fallback={
                <div role="status" className="toast">
                  加载变量与样式…
                </div>
              }
            >
              <DesignSystemDialog
                editor={editor}
                key={
                  designSystemTarget.view +
                  ":" +
                  (designSystemTarget.styleId ?? "")
                }
                initialView={designSystemTarget.view}
                initialStyleId={designSystemTarget.styleId}
                close={() => setDesignSystemTarget(null)}
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {filesOpen && (
          <ErrorBoundary
            scope="modal"
            title="本机文件浏览器加载异常"
            onReset={() => setFilesOpen(false)}
          >
            <Suspense
              fallback={
                <div role="status" className="toast">
                  加载本机文件列表…
                </div>
              }
            >
              <FileBrowser
                externalImport={(selected, projectId) => {
                  setFilesOpen(false);
                  openExternalFile(selected, projectId);
                }}
                onOpenFileTab={options.onOpenFileTab}
                current={editor.committed}
                currentKey={currentFileKey}
                renameCurrent={(name) =>
                  editor.importDocument({ ...editor.committed, name })
                }
                close={() => setFilesOpen(false)}
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {promoteModalOpen && (
          <ErrorBoundary
            scope="modal"
            title="沉淀组件模块窗口异常"
            onReset={() => setPromoteModalOpen(false)}
          >
            <Suspense
              fallback={
                <div role="status" className="toast">
                  加载组件沉淀窗口…
                </div>
              }
            >
              <PromoteModuleModal
                key={JSON.stringify([
                  currentFileKey,
                  doc.id,
                  activeProject?.id,
                ])}
                editor={editor}
                fileKey={currentFileKey}
                fileLifetimeInvalid={fileLifetimeInvalid}
                getFileLifetimeToken={editor.getLifetimeToken}
                onFileLifetimeInvalidated={invalidateFileLifetime}
                activeProject={activeProject}
                preferredLibraryId={activeProject?.defaultLibraryId}
                onSuccess={setStatusToast}
                close={() => setPromoteModalOpen(false)}
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {(externalFile || showImportReport) && (
          <ErrorBoundary
            scope="modal"
            title="设计文件导入窗口异常"
            onReset={() => {
              setExternalFile(undefined);
              setShowImportReport(false);
            }}
          >
            <Suspense
              fallback={
                <div role="status" className="toast">
                  加载设计导入工具…
                </div>
              }
            >
              <DesignImportDialog
                file={externalFile}
                targetProjectId={externalImportProjectId}
                existing={
                  showImportReport && !externalFile
                    ? editor.committed
                    : undefined
                }
                onImported={options.onOpenFileTab}
                close={() => {
                  setExternalFile(undefined);
                  setShowImportReport(false);
                }}
                locate={(page, id) => {
                  if (
                    page !== editor.committed.activePage &&
                    editor.committed.pages
                  )
                    editor.switchPage(page);
                  editor.setSelection([id]);
                  setShowImportReport(false);
                  requestAnimationFrame(() => editor.api.current?.fit([id]));
                }}
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {(editor.error || memoryNotice || statusToast) && (
          <div
            style={{
              position: "fixed",
              right: 20,
              bottom: 18,
              zIndex: 90,
              display: "grid",
              justifyItems: "end",
              gap: 6,
              maxWidth: "calc(100vw - 40px)",
              pointerEvents: "none",
            }}
          >
            {statusToast && !editor.error && (
              <div
                role="status"
                className="toast project-status-toast"
                style={{ position: "static" }}
              >
                {statusToast}
              </div>
            )}
            {memoryNotice && (
              <div
                role="status"
                className="toast project-status-toast"
                style={{ position: "static", pointerEvents: "auto" }}
              >
                {memoryNotice}
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label="关闭项目记忆提示"
                  data-tip="关闭项目记忆提示"
                  data-tip-side="top"
                  onClick={() => setMemoryNotice("")}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {editor.error && (
              <div
                role="alert"
                className="toast"
                style={{ position: "static", pointerEvents: "auto" }}
              >
                {editor.error}
                <button
                  className="icon-btn icon-btn-sm"
                  aria-label="关闭错误"
                  data-tip="关闭提示"
                  data-tip-side="top"
                  onClick={() => editor.setError("")}
                >
                  <X size={16} />
                </button>
              </div>
            )}
          </div>
        )}
        {menu && (
          <ContextMenu
            editor={editor}
            position={menu}
            close={() => setMenu(null)}
            onWrapSection={() => editor.perform("wrapSection")}
            onSelectMatching={() => editor.perform("selectMatching")}
            onToggleDevStatus={() => editor.perform("toggleDevStatus")}
            onPromoteModule={() => setPromoteModalOpen(true)}
          />
        )}
        <BatchExportModal
          open={batchExportOpen}
          document={editor.committed}
          onClose={() => setBatchExportOpen(false)}
        />
        {lintOpen && (
          <ErrorBoundary
            scope="modal"
            title="设计规范校验面板异常"
            onReset={() => setLintOpen(false)}
          >
            <Suspense
              fallback={
                <div role="status" className="toast">
                  加载规范校验…
                </div>
              }
            >
              <DesignLintPanel
                open={lintOpen}
                document={editor.committed}
                selectedIds={editor.selection}
                onClose={() => setLintOpen(false)}
                onFocusNode={(id) => {
                  editor.setSelection([id]);
                  requestAnimationFrame(() => editor.api.current?.fit([id]));
                }}
                onApplyOperations={(ops) =>
                  editor.attempt(() => editor.apply(ops))
                }
              />
            </Suspense>
          </ErrorBoundary>
        )}
        <CommentsPanel
          open={commentsOpen}
          comments={doc.comments ?? []}
          activeCommentId={activeCommentId}
          onSelectComment={(id) => {
            setActiveCommentId(id);
            if (id && !showComments) setShowComments(true);
          }}
          onUpdateComments={updateComments}
          onClose={() => setCommentsOpen(false)}
        />
        {modelConfigOpen && (
          <ErrorBoundary
            scope="modal"
            title="模型配置窗口异常"
            onReset={() => setModelConfigOpen(false)}
          >
            <Suspense
              fallback={
                <div role="status" className="toast">
                  加载模型配置…
                </div>
              }
            >
              <ModelConfigModal
                open={modelConfigOpen}
                onClose={() => setModelConfigOpen(false)}
                status={agentStatus}
                onStatusChange={setAgentStatus}
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {integrationsMounted && (
          <ErrorBoundary
            scope="modal"
            title="外部工具集成窗口异常"
            onReset={() => {
              setIntegrationsOpen(false);
              setIntegrationsMounted(false);
            }}
          >
            <Suspense
              fallback={
                integrationsOpen ? (
                  <div role="status" className="toast">
                    加载外部工具集成…
                  </div>
                ) : null
              }
            >
              <IntegrationsModal
                open={integrationsOpen}
                onClose={() => setIntegrationsOpen(false)}
                document={agentDocument}
                selection={
                  editor.selection.length === 1 ? editor.selection[0] : null
                }
                scopeProjectId={currentScopeId}
                fileKey={currentFileKey}
                tabs={options.workspaceTabs}
                activeTabId={options.activeWorkspaceTabId}
                onPendingProposalChange={handleExternalPendingProposal}
                onAutoApplyTransaction={handleAutoApplyTransaction}
                onSessionActiveChange={setMcpSessionActive}
                onBridgeSnapshotChange={setBridgeSnapshot}
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {inboxOpen && (
          <ErrorBoundary
            scope="modal"
            title="外部任务收件箱异常"
            onReset={() => setInboxOpen(false)}
          >
            <Suspense fallback={null}>
              <AgentInboxPopover
                open={inboxOpen}
                onClose={() => setInboxOpen(false)}
                connected={Boolean(bridgeSnapshot?.connected)}
                tasks={bridgeSnapshot?.tasks ?? []}
                onOpenIntegrations={openIntegrations}
                onPreviewTaskProposal={(task) => {
                  const cached = taskProposalsRef.current.get(task.id);
                  if (cached) {
                    setPendingProposal(cached);
                    setInboxOpen(false);
                  }
                }}
                onCompleteTask={handleCompleteInboxTask}
                onRejectTask={handleRejectInboxTask}
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {editor.palette && (
          <CommandPalette
            editor={editor}
            close={() => editor.setPalette(false)}
          />
        )}
        {editor.help && <ShortcutHelp close={() => editor.setHelp(false)} />}
        {preview.open && (
          <ErrorBoundary
            scope="modal"
            title="原型预览窗口异常"
            onReset={() => setPreview({ open: false })}
          >
            <Suspense
              fallback={
                <div role="status" className="toast">
                  加载原型预览…
                </div>
              }
            >
              <PreviewDialog
                document={editor.committed}
                selection={
                  preview.startFrameId
                    ? [preview.startFrameId]
                    : editor.selection
                }
                close={() => setPreview({ open: false })}
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {codeOpen && (
          <ErrorBoundary
            scope="modal"
            title="代码预览窗口异常"
            onReset={() => setCodeOpen(false)}
          >
            <Suspense
              fallback={
                <div role="status" className="toast">
                  加载代码预览…
                </div>
              }
            >
              <CodePreviewModal
                doc={editor.committed}
                selection={editor.selection}
                close={() => setCodeOpen(false)}
              />
            </Suspense>
          </ErrorBoundary>
        )}
        {projectUpdate && (
          <ErrorBoundary
            scope="modal"
            title="工程更新窗口异常"
            onReset={() => setProjectUpdate(null)}
          >
            <Suspense
              fallback={
                <div role="status" className="toast">
                  加载工程更新视图…
                </div>
              }
            >
              <ProjectUpdateModal
                doc={editor.committed}
                zipBytes={projectUpdate.zipBytes}
                preview={projectUpdate.preview}
                close={() => setProjectUpdate(null)}
                onError={(message) => editor.setError(message)}
              />
            </Suspense>
          </ErrorBoundary>
        )}
        <TooltipHost />
        <input
          ref={file}
          data-testid="design-file-input"
          type="file"
          accept={acceptedDesignFiles}
          hidden
          onChange={async (event) => {
            const input = event.currentTarget;
            const selected = input.files?.[0];
            input.value = "";
            if (!selected) return;
            try {
              const external = await isExternalDesign(selected);
              checkDesignFileSize(selected.size, external);
              if (external) {
                openExternalFile(selected);
                return;
              }
              const content = await readNativeDocument(selected);
              await loadFonts(content.fonts);
              if (openAsFile.current) {
                if (options.onOpenFileTab) {
                  const { key } = await createLocalFileWithKey(content);
                  options.onOpenFileTab({ fileKey: key, title: content.name });
                } else {
                  location.assign(await createLocalFile(content));
                }
                return;
              }
              editor.importDocument(content, { replacedDocument: true });
              setPromoteModalOpen(false);
              editor.setSelection([]);
              requestAnimationFrame(() => editor.api.current?.fit());
            } catch (error) {
              editor.setError(
                `导入失败：${error instanceof Error ? error.message : String(error)}`,
              );
            }
            input.value = "";
          }}
        />
      </div>
    </FileColorContext.Provider>
  );
}
