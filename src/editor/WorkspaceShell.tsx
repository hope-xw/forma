import { ToastHost, type ShellNotice } from "./ToastHost";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  closeTabsToRight,
  createInitialTabsState,
  HOME_TAB_ID,
  LEGACY_DEFAULT_FILE_KEY,
  makeExampleTab,
  makeFileTab,
  openTab,
  parseLocationToTab,
  pruneMissingFileTabs,
  reorderTab,
  reopenClosedTab,
  serializeTabsState,
  switchAdjacentTab,
  switchTabByIndex,
  tabToUrl,
  updateTabMeta,
  WORKSPACE_TABS_STORAGE_KEY,
  type QuickStartPreset,
  type WorkspaceTab,
  type WorkspaceTabsState,
} from "../application/workspace-tabs";
import type { BridgeTabSummary } from "../application/external-bridge";
import { parseDocument, type DesignDocument } from "../domain/document";
import type { Viewport } from "../domain/geometry";
import { openPage } from "../domain/pages";
import { createStarter } from "../domain/seed";
import {
  checkDesignFileSize,
  isExternalDesign,
} from "../infrastructure/design-import/types";
import {
  releaseDocumentFonts,
  retainDocumentFonts,
} from "../infrastructure/font-import";
import { readNativeDocument } from "../infrastructure/native-document";
import { assignFileToProject } from "../infrastructure/project-memory-store";
import {
  BrowserDocumentRepository,
  createLocalFileWithKey,
  deleteLocalFile,
  recentFiles,
} from "../infrastructure/storage";
import { preferredProfile } from "./ColorProfileDialog";
import { ErrorBoundary } from "./ErrorBoundary";
import { TooltipHost } from "./TooltipHost";
import type { EditorFileOptions } from "./useDocument";
import { WorkspaceTabBar } from "./WorkspaceTabBar";
import "./workspace-tabs.css";

const App = lazy(() => import("./App").then((m) => ({ default: m.App })));
const WorkspaceHomeShell = lazy(() =>
  import("./WorkspaceHomeShell").then((m) => ({
    default: m.WorkspaceHomeShell,
  })),
);
const DesignImportDialog = lazy(() =>
  import("./DesignImportDialog").then((m) => ({
    default: m.DesignImportDialog,
  })),
);

interface TabSnapshot {
  activePage?: string;
  selectionIds: string[];
  views: Map<string, Viewport>;
}

interface LoadedEditorOptions extends EditorFileOptions {
  loadKey: string;
}

function readPersistedTabs(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_TABS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function repositoryKeyForTab(tab: WorkspaceTab): string | undefined {
  if (tab.kind === "example") {
    if (tab.example === "aura-showcase")
      return "forma.example.aura-showcase.v1";
    if (tab.example === "mobile-studio") {
      if (tab.edition === "atlas") return "forma.example.mobile-studio.atlas";
      if (tab.edition === "flows") return "forma.example.mobile-studio.flows";
      return "forma.example.mobile-studio.v1";
    }
    return undefined;
  }
  if (tab.kind === "file") {
    if (tab.fileKey === LEGACY_DEFAULT_FILE_KEY) return undefined;
    if (tab.fileKey && /^forma\.file\.[a-f0-9-]{36}$/.test(tab.fileKey))
      return tab.fileKey;
    return tab.fileKey;
  }
  return undefined;
}

async function loadTabEditorOptions(
  tab: WorkspaceTab,
  snapshot?: TabSnapshot,
  externalFile?: File,
): Promise<LoadedEditorOptions> {
  const repository = new BrowserDocumentRepository(repositoryKeyForTab(tab));
  const options: LoadedEditorOptions = {
    loadKey: `${tab.id}:${Date.now()}`,
    repository,
    fileKey: repository.key,
    externalFile,
  };
  try {
    options.initialDocument = (await repository.load()) ?? undefined;
  } catch {
    options.loadError =
      "本机文件无法读取。可以从文件菜单下载存储备份，或恢复上个版本。";
  }
  const sample =
    tab.kind === "example" &&
    (tab.example === "mobile-studio" || tab.example === "aura-showcase");
  if (sample && !options.initialDocument && !options.loadError) {
    const response = await fetch(
      import.meta.env.BASE_URL +
        (tab.example === "aura-showcase"
          ? "examples/aura-showcase.forma.json"
          : "examples/mobile-studio.forma.json"),
    );
    if (!response.ok) throw new Error("未能加载设计样例");
    options.initialDocument = parseDocument(await response.json());
    options.initialSaved = false;
  }
  let doc: DesignDocument | undefined = options.initialDocument;
  const targetPage = snapshot?.activePage ?? tab.page;
  if (doc && targetPage && doc.pages?.some((p) => p.id === targetPage)) {
    doc = openPage(doc, targetPage);
    options.initialDocument = doc;
  }
  if (snapshot?.selectionIds.length && doc) {
    const valid = snapshot.selectionIds.filter((id) =>
      doc!.nodes.some((n) => n.id === id),
    );
    if (valid.length) options.initialSelection = valid;
  } else if (tab.node && doc?.nodes.some((n) => n.id === tab.node)) {
    options.initialSelection = [tab.node];
  }
  return options;
}

async function importNativeFile(file: File) {
  const doc = await readNativeDocument(file);
  const owner = `file-import:${crypto.randomUUID()}`;
  try {
    await retainDocumentFonts(owner, doc.fonts);
    const { key } = await createLocalFileWithKey(doc);
    return { fileKey: key, title: doc.name };
  } finally {
    releaseDocumentFonts(owner);
  }
}

async function readPendingDesktopFile(
  bridge: FormaDesktopBridge,
  pending: { name: string; size: number },
) {
  const parts: Blob[] = [];
  let received = 0;
  while (received < pending.size) {
    const chunk = await bridge.readPendingChunk();
    if (!chunk.length || received + chunk.length > pending.size)
      throw Error("文件长度不符");
    parts.push(new Blob([chunk]));
    received += chunk.length;
  }
  return new File(parts, pending.name);
}

function EditorTabPane({
  tab,
  active,
  workspaceTabs,
  activeWorkspaceTabId,
  shellNotices,
  onActiveAppChange,
  onDismissShellNotice,
  snapshot,
  onSnapshot,
  onMetaChange,
  onPresetConsumed,
  onOpenHome,
  onOpenFileTab,
  onOpenExampleTab,
  onNewDesignTab,
  onThemeSync,
}: {
  tab: WorkspaceTab;
  active: boolean;
  workspaceTabs: BridgeTabSummary[];
  activeWorkspaceTabId: string;
  shellNotices?: ShellNotice[];
  onDismissShellNotice(id: string): void;
  onActiveAppChange(tabId: string | null): void;
  snapshot?: TabSnapshot;
  onSnapshot(snapshot: TabSnapshot): void;
  onMetaChange(meta: {
    title: string;
    dirty: boolean;
    busyReason: "ai" | "mcp" | null;
    nativePath?: string | null;
  }): void;
  onPresetConsumed(): void;
  onOpenHome(): void;
  onOpenFileTab(target: {
    fileKey: string;
    title: string;
    preset?: QuickStartPreset;
  }): void;
  onOpenExampleTab(target: {
    example: string;
    edition?: string;
    page?: string;
    node?: string;
    title?: string;
  }): void;
  onNewDesignTab(options?: {
    projectId?: string | null;
    preset?: QuickStartPreset;
  }): void;
  onThemeSync(theme: "dark" | "light"): void;
}) {
  const [loaded, setLoaded] = useState<LoadedEditorOptions | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const initialSnapshotRef = useRef(snapshot);
  const preloadedFontOwner = `tab-preload:${tab.id}`;

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    setLoadErr("");
    void loadTabEditorOptions(tab, initialSnapshotRef.current)
      .then(async (opts) => {
        if (!alive) return;
        await retainDocumentFonts(
          preloadedFontOwner,
          opts.initialDocument?.fonts,
        );
        if (!alive) return;
        setLoaded(opts);
        if (opts.initialDocument?.name) {
          onMetaChange({
            title: opts.initialDocument.name,
            dirty: opts.initialSaved === false,
            busyReason: null,
          });
        }
      })
      .catch((error) => {
        if (!alive) return;
        releaseDocumentFonts(preloadedFontOwner);
        setLoadErr(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive = false;
      releaseDocumentFonts(preloadedFontOwner);
    };
  }, [tab.id, preloadedFontOwner]);

  if (loadErr) {
    return (
      <div className="workspace-pane" hidden={!active}>
        <main role="alert" className="forma-boot-loading">
          <span>文件加载失败：{loadErr}</span>
          <button type="button" onClick={onOpenHome}>
            返回工作台
          </button>
        </main>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="workspace-pane" hidden={!active}>
        <main className="forma-boot-loading" role="status" aria-live="polite">
          <span className="design-import-spinner" aria-hidden="true" />
          <span>正在载入画布…</span>
        </main>
      </div>
    );
  }

  return (
    <div className="workspace-pane" hidden={!active}>
      <ErrorBoundary
        scope="workspace"
        title={`「${tab.title}」遇到意外错误`}
        resetKey={loaded.loadKey}
      >
        <Suspense
          fallback={
            <main
              className="forma-boot-loading"
              role="status"
              aria-live="polite"
            >
              <span className="design-import-spinner" aria-hidden="true" />
              <span>正在载入画布…</span>
            </main>
          }
        >
          <App
            {...loaded}
            tabActive={active}
            preloadedFontOwner={preloadedFontOwner}
            shellNotices={shellNotices}
            onActiveAppChange={onActiveAppChange}
            onDismissShellNotice={onDismissShellNotice}
            workspaceTabs={workspaceTabs}
            activeWorkspaceTabId={activeWorkspaceTabId}
            initialPreset={tab.preset}
            initialViews={initialSnapshotRef.current?.views}
            onTabMetaChange={onMetaChange}
            onTabViewSnapshot={onSnapshot}
            onTabPresetConsumed={onPresetConsumed}
            onOpenHome={onOpenHome}
            onOpenFileTab={onOpenFileTab}
            onOpenExampleTab={onOpenExampleTab}
            onNewDesignTab={onNewDesignTab}
            onThemeSync={onThemeSync}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

export function WorkspaceShell() {
  const [state, setState] = useState<WorkspaceTabsState>(() =>
    createInitialTabsState(location.search, readPersistedTabs()),
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const [homeVisit, setHomeVisit] = useState(0);
  const [shellNotices, setShellNotices] = useState<ShellNotice[]>([]);
  const addShellError = useCallback((text: string) => {
    const notice: ShellNotice = {
      id: crypto.randomUUID(),
      text,
      severity: "error",
    };
    setShellNotices((current) =>
      current.some((item) => item.text === text)
        ? current
        : [...current.slice(-3), notice],
    );
  }, []);
  const dismissShellNotice = useCallback((id: string) => {
    setShellNotices((current) => current.filter((item) => item.id !== id));
  }, []);
  // Preload and Suspense can both delay the editor's own toast host.
  const [readyTabId, setReadyTabId] = useState<string | null>(null);
  const activeTabReady =
    state.activeTabId !== HOME_TAB_ID && state.activeTabId === readyTabId;
  const [pendingExternalImport, setPendingExternalImport] =
    useState<File | null>(null);
  const snapshotsRef = useRef(new Map<string, TabSnapshot>());
  const desktopQueueRef = useRef<Promise<void>>(Promise.resolve());
  const skipNextHistoryPushRef = useRef(true);
  const isMacDesktop = window.formaDesktop?.platform === "darwin";

  // Keep shell theme synced whenever Home or any Editor toggles data-theme
  useEffect(() => {
    const sync = () => {
      const next =
        document.documentElement.dataset.theme === "light" ? "light" : "dark";
      setTheme((prev) => (prev === next ? prev : next));
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  // Persist open tabs session
  useEffect(() => {
    try {
      localStorage.setItem(
        WORKSPACE_TABS_STORAGE_KEY,
        serializeTabsState(state),
      );
    } catch {
      /* Ignore storage quota/privacy mode errors */
    }
  }, [state]);

  // Prune stale deleted file tabs once on boot
  useEffect(() => {
    let alive = true;
    void recentFiles()
      .then((files) => {
        if (!alive) return;
        const existing = new Set(files.map((f) => f.key));
        setState((prev) => pruneMissingFileTabs(prev, existing));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Sync browser URL via History API without full page reload
  const activeTab = useMemo(
    () => state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0],
    [state.tabs, state.activeTabId],
  );
  useEffect(() => {
    if (activeTab.id === HOME_TAB_ID) setHomeVisit((n) => n + 1);
    const targetUrl = tabToUrl(activeTab);
    const resolved = new URL(targetUrl, location.href);
    const same =
      resolved.pathname === location.pathname &&
      resolved.search === location.search;
    if (skipNextHistoryPushRef.current) {
      skipNextHistoryPushRef.current = false;
      if (!same) history.replaceState({ tabId: activeTab.id }, "", targetUrl);
      return;
    }
    if (!same) {
      history.pushState({ tabId: activeTab.id }, "", targetUrl);
    }
  }, [activeTab]);

  useEffect(() => {
    const onPopState = () => {
      skipNextHistoryPushRef.current = true;
      const parsed = parseLocationToTab(location.search);
      setState((prev) =>
        parsed ? openTab(prev, parsed) : activateTab(prev, HOME_TAB_ID),
      );
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const openFileInTab = useCallback(
    (target: {
      fileKey: string;
      title: string;
      preset?: QuickStartPreset;
      nativePath?: string | null;
    }) => {
      setState((prev) =>
        openTab(
          prev,
          makeFileTab({
            fileKey: target.fileKey,
            title: target.title,
            preset: target.preset,
            nativePath: target.nativePath,
          }),
        ),
      );
    },
    [],
  );

  const openExampleInTab = useCallback(
    (target: {
      example: string;
      edition?: string;
      page?: string;
      node?: string;
      title?: string;
    }) => {
      setState((prev) => openTab(prev, makeExampleTab(target)));
    },
    [],
  );

  const createNewDesignTab = useCallback(
    async (options?: {
      projectId?: string | null;
      preset?: QuickStartPreset;
      name?: string;
    }) => {
      const doc = createStarter();
      doc.colorProfile = preferredProfile();
      doc.name = options?.name ?? "无标题设计";
      doc.nodes = [];
      doc.revision = 0;
      const { key } = await createLocalFileWithKey(doc);
      if (options?.projectId) {
        try {
          await assignFileToProject(key, options.projectId, {
            migrateDraftEpisodes: false,
            requireDurable: true,
          });
        } catch (error) {
          await deleteLocalFile(key).catch(() => {});
          throw error;
        }
      }
      openFileInTab({
        fileKey: key,
        title: doc.name,
        preset: options?.preset,
      });
    },
    [openFileInTab],
  );

  const openDroppedOrSelectedFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      for (const file of list) {
        try {
          const external = await isExternalDesign(file);
          checkDesignFileSize(file.size, external);
          if (external) {
            setPendingExternalImport(file);
            return;
          }
          openFileInTab(await importNativeFile(file));
        } catch (error) {
          addShellError(
            `打开 ${file.name} 失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
    [openFileInTab, addShellError],
  );

  // Process Electron pending files (cold start & live Finder / Cmd+O open-file-in-tab) strictly in FIFO order
  const drainDesktopPendingFile = useCallback(() => {
    let filename: string | undefined;
    desktopQueueRef.current = desktopQueueRef.current
      .then(async () => {
        const bridge = window.formaDesktop;
        if (!bridge) return;
        const pending = await bridge.consumePendingFile();
        if (!pending) return;
        filename = pending.name;
        const file = await readPendingDesktopFile(bridge, pending);
        const nativePath = pending.nativePath ?? null;
        const external = await isExternalDesign(file);
        checkDesignFileSize(file.size, external);
        if (external) {
          setPendingExternalImport(file);
          return;
        }
        if (nativePath) {
          const existing = stateRef.current.tabs.find(
            (t) => t.nativePath === nativePath,
          );
          if (existing) {
            setState((prev) => activateTab(prev, existing.id));
            return;
          }
        }
        const target = await importNativeFile(file);
        try {
          await bridge.bindPendingFile?.(target.fileKey);
        } catch {
          /* Opening succeeds even if disk path binding is unavailable. */
        }
        openFileInTab({ ...target, nativePath });
      })
      .catch((error) => {
        addShellError(
          `打开 ${filename ?? "文件"} 失败：${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }, [openFileInTab, addShellError]);

  useEffect(() => {
    const bridge = window.formaDesktop;
    if (!bridge) return;
    drainDesktopPendingFile();
    const offOpen = bridge.onOpenFileInTab?.(() => {
      drainDesktopPendingFile();
    });
    const offMenu = bridge.onMenuAction(
      () => {},
      (fileAction) => {
        if (fileAction === "newTab") {
          void createNewDesignTab({ preset: "blank" }).catch((err) =>
            addShellError(err instanceof Error ? err.message : String(err)),
          );
        } else if (fileAction === "reopenTab") {
          setState((prev) => reopenClosedTab(prev));
        } else if (fileAction === "closeTab") {
          if (stateRef.current.activeTabId === HOME_TAB_ID) {
            void bridge.closeCurrentWindow?.();
          } else {
            const closing = stateRef.current.activeTabId;
            snapshotsRef.current.delete(closing);
            setState((prev) => closeTab(prev, closing));
          }
        }
      },
    );
    return () => {
      offOpen?.();
      offMenu?.();
    };
  }, [createNewDesignTab, drainDesktopPendingFile, addShellError]);

  // Global tab switching shortcuts
  useEffect(() => {
    // Switch before a picker's local Tab focus trap handles the keystroke.
    const switchTab = (event: KeyboardEvent) => {
      if (
        event.key !== "Tab" ||
        !event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        document.querySelector(
          '[aria-modal="true"]:not(.color-popover, .binding-popover)',
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setState((prev) => switchAdjacentTab(prev, event.shiftKey ? -1 : 1));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const inInput =
        event.target instanceof HTMLElement &&
        !!event.target.closest(
          'input,textarea,select,[contenteditable="true"],[role="dialog"]',
        );
      if (inInput) return;
      const mod = event.metaKey || event.ctrlKey;
      // Cmd/Ctrl+1..9 jumps directly to Home (1) or open tabs (2..9)
      if (
        mod &&
        !event.altKey &&
        !event.shiftKey &&
        /^Digit[1-9]$/.test(event.code)
      ) {
        const index = Number(event.code.slice(5));
        event.preventDefault();
        setState((prev) => switchTabByIndex(prev, index));
        return;
      }
      // Cmd/Ctrl+Shift+T reopens last closed tab
      if (mod && event.shiftKey && !event.altKey && event.code === "KeyT") {
        if (stateRef.current.closedStack.length > 0) {
          event.preventDefault();
          setState((prev) => reopenClosedTab(prev));
        }
        return;
      }
      // Alt+W safely closes active file tab in Web browsers (Desktop uses native Cmd+W menu IPC)
      if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.code === "KeyW" &&
        stateRef.current.activeTabId !== HOME_TAB_ID
      ) {
        event.preventDefault();
        const closing = stateRef.current.activeTabId;
        snapshotsRef.current.delete(closing);
        setState((prev) => closeTab(prev, closing));
      }
    };
    window.addEventListener("keydown", switchTab, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", switchTab, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const openFileKeys = useMemo(
    () =>
      new Set(
        state.tabs.flatMap((t) => {
          const key = repositoryKeyForTab(t);
          return key ? [key] : [];
        }),
      ),
    [state.tabs],
  );

  const bridgeTabs = useMemo<BridgeTabSummary[]>(
    () =>
      state.tabs.map((t) => ({
        id: t.id,
        kind: t.kind,
        title: t.title,
        fileKey: t.fileKey,
        active: t.id === state.activeTabId,
      })),
    [state.tabs, state.activeTabId],
  );

  // Active editor tab + any busy (AI streaming / MCP paired) background tab stay mounted
  const mountedEditorTabs = useMemo(
    () =>
      state.tabs.filter(
        (t) =>
          t.kind !== "home" &&
          (t.id === state.activeTabId || Boolean(t.busyReason)),
      ),
    [state.tabs, state.activeTabId],
  );

  const handleCloseTab = useCallback((tabId: string) => {
    snapshotsRef.current.delete(tabId);
    setState((prev) => closeTab(prev, tabId));
  }, []);

  const handleOpenInNewWindow = useCallback((tab: WorkspaceTab) => {
    const query = tabToUrl(tab);
    if (window.formaDesktop?.openInNewWindow) {
      void window.formaDesktop.openInNewWindow(query === "./" ? "" : query);
    } else {
      window.open(query, "_blank", "noopener,noreferrer");
    }
  }, []);

  return (
    <div className="workspace-shell" data-theme={theme}>
      <WorkspaceTabBar
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        canReopenClosed={state.closedStack.length > 0}
        isMacDesktop={isMacDesktop}
        onSelectTab={(tabId) => setState((prev) => activateTab(prev, tabId))}
        onCloseTab={handleCloseTab}
        onNewTab={(preset) => {
          void createNewDesignTab({ preset: preset ?? "blank" }).catch((err) =>
            addShellError(err instanceof Error ? err.message : String(err)),
          );
        }}
        onReopenClosed={() => setState((prev) => reopenClosedTab(prev))}
        onCloseOthers={(tabId) =>
          setState((prev) => closeOtherTabs(prev, tabId))
        }
        onCloseToRight={(tabId) =>
          setState((prev) => closeTabsToRight(prev, tabId))
        }
        onReorderTab={(fromId, toId) =>
          setState((prev) => reorderTab(prev, fromId, toId))
        }
        onOpenInNewWindow={handleOpenInNewWindow}
        onDropFiles={(files) => void openDroppedOrSelectedFiles(files)}
      />

      <div className="workspace-shell-body">
        {state.activeTabId === HOME_TAB_ID && (
          <div className="workspace-pane">
            <ErrorBoundary scope="workspace" title="Forma 工作台遇到意外错误">
              <Suspense
                fallback={
                  <main
                    className="forma-boot-loading"
                    role="status"
                    aria-live="polite"
                  >
                    <span
                      className="design-import-spinner"
                      aria-hidden="true"
                    />
                    <span>正在打开工作台…</span>
                  </main>
                }
              >
                <WorkspaceHomeShell
                  key={homeVisit}
                  openFileKeys={openFileKeys}
                  onOpenFileTab={openFileInTab}
                  onOpenExampleTab={openExampleInTab}
                />
              </Suspense>
            </ErrorBoundary>
          </div>
        )}

        {mountedEditorTabs.map((tab) => (
          <EditorTabPane
            key={tab.id}
            tab={tab}
            active={tab.id === state.activeTabId}
            shellNotices={
              activeTabReady && tab.id === state.activeTabId
                ? shellNotices
                : undefined
            }
            onDismissShellNotice={dismissShellNotice}
            onActiveAppChange={setReadyTabId}
            workspaceTabs={bridgeTabs}
            activeWorkspaceTabId={state.activeTabId}
            snapshot={snapshotsRef.current.get(tab.id)}
            onSnapshot={(snap) => snapshotsRef.current.set(tab.id, snap)}
            onMetaChange={(meta) =>
              setState((prev) => updateTabMeta(prev, tab.id, meta))
            }
            onPresetConsumed={() =>
              setState((prev) =>
                updateTabMeta(prev, tab.id, { preset: undefined }),
              )
            }
            onOpenHome={() =>
              setState((prev) => activateTab(prev, HOME_TAB_ID))
            }
            onOpenFileTab={openFileInTab}
            onOpenExampleTab={openExampleInTab}
            onNewDesignTab={(opts) => {
              void createNewDesignTab(opts).catch((err) =>
                addShellError(err instanceof Error ? err.message : String(err)),
              );
            }}
            onThemeSync={setTheme}
          />
        ))}
      </div>

      {pendingExternalImport && (
        <ErrorBoundary
          scope="modal"
          title="设计文件导入窗口异常"
          onReset={() => setPendingExternalImport(null)}
        >
          <Suspense
            fallback={
              <div role="status" className="panel-loading-pill">
                加载设计导入工具…
              </div>
            }
          >
            <DesignImportDialog
              file={pendingExternalImport}
              close={() => setPendingExternalImport(null)}
              onImported={(target) => {
                setPendingExternalImport(null);
                openFileInTab(target);
              }}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {!activeTabReady && (
        <ToastHost
          shellNotices={shellNotices}
          onDismissShellNotice={dismissShellNotice}
        />
      )}

      <TooltipHost />
    </div>
  );
}
