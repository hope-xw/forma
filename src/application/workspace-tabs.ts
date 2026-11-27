import { z } from "zod";

export type WorkspaceTabKind = "home" | "file" | "example";
export type QuickStartPreset = "blank" | "mobile" | "desktop" | "ai";

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  title: string;
  fileKey?: string;
  example?: string;
  edition?: string;
  page?: string;
  node?: string;
  preset?: QuickStartPreset;
  dirty?: boolean;
  busyReason?: "ai" | "mcp" | null;
  nativePath?: string | null;
}

export interface TabViewSnapshot {
  activePage?: string;
  selectionIds?: string[];
  camera?: { x: number; y: number; scale: number };
}

export interface WorkspaceTabsState {
  tabs: WorkspaceTab[];
  activeTabId: string;
  closedStack: WorkspaceTab[];
}

export const HOME_TAB_ID = "home";
export const WORKSPACE_TABS_STORAGE_KEY = "forma.workspace-tabs.v1";
export const MAX_OPEN_TABS = 24;
export const MAX_CLOSED_STACK = 10;
export const LEGACY_DEFAULT_FILE_KEY = "forma.document.v1";

export function homeTab(): WorkspaceTab {
  return { id: HOME_TAB_ID, kind: "home", title: "工作台" };
}

export function fileTabId(fileKey: string): string {
  return `file:${fileKey}`;
}

export function exampleTabId(example: string, edition?: string): string {
  return `example:${example}${edition ? `:${edition}` : ""}`;
}

export function makeFileTab(options: {
  fileKey: string;
  title?: string;
  preset?: QuickStartPreset;
  nativePath?: string | null;
}): WorkspaceTab {
  return {
    ...options,
    id: fileTabId(options.fileKey),
    kind: "file",
    title: options.title || "未命名设计文件",
  };
}

const exampleTitles = new Map([
  ["mobile-studio", "移动设计研究室"],
  ["aura-showcase", "SaaS 工作台样例"],
]);

export function makeExampleTab(options: {
  example: string;
  edition?: string;
  page?: string;
  node?: string;
  title?: string;
}): WorkspaceTab {
  const { example, edition } = options;
  return {
    ...options,
    id: exampleTabId(example, edition),
    kind: "example",
    title: options.title || exampleTitles.get(example) || example,
  };
}

export function parseLocationToTab(search: string): WorkspaceTab | null {
  const params = new URLSearchParams(search);
  const fileKey = params.get("file");
  const example = params.get("example");
  if (!fileKey && example) {
    const options: Parameters<typeof makeExampleTab>[0] = { example };
    for (const key of ["edition", "page", "node"] as const) {
      const value = params.get(key);
      if (value) options[key] = value;
    }
    return makeExampleTab(options);
  }
  if (!fileKey && params.get("editor") !== "1") return null;
  const tab = makeFileTab({ fileKey: fileKey || LEGACY_DEFAULT_FILE_KEY });
  const preset = params.get("preset");
  if (params.get("ai") === "1") tab.preset = "ai";
  else if (
    preset === "mobile" ||
    preset === "desktop" ||
    preset === "blank" ||
    preset === "ai"
  )
    tab.preset = preset;
  return tab;
}

export function tabToUrl(tab: WorkspaceTab): string {
  if (tab.kind === "file" && tab.fileKey) {
    const legacy = tab.fileKey === LEGACY_DEFAULT_FILE_KEY;
    const url = legacy
      ? "?editor=1"
      : "?file=" + encodeURIComponent(tab.fileKey);
    if (tab.preset === "ai") return url + "&ai=1";
    return tab.preset && (legacy || tab.preset !== "blank")
      ? url + "&preset=" + tab.preset
      : url;
  }
  if (tab.kind === "example" && tab.example) {
    let url = "?example=" + encodeURIComponent(tab.example);
    for (const key of ["edition", "page", "node"] as const) {
      if (tab[key]) url += "&" + key + "=" + encodeURIComponent(tab[key]);
    }
    return url;
  }
  return "./";
}

function sameTab(a: WorkspaceTab, b: WorkspaceTab): boolean {
  return (
    a.id === b.id ||
    (!!a.fileKey && a.fileKey === b.fileKey) ||
    (!!a.nativePath?.trim() && a.nativePath === b.nativePath)
  );
}

const storedState = z.object({
  tabs: z.array(z.unknown()),
  activeTabId: z.string().optional(),
});
const storedIdentity = {
  id: z.string(),
  title: z.string(),
  page: z.string().optional(),
  node: z.string().optional(),
  nativePath: z.string().nullable().optional(),
};
const storedTab = z.discriminatedUnion("kind", [
  z.object({
    ...storedIdentity,
    kind: z.literal("file"),
    fileKey: z.string().min(1),
  }),
  z.object({
    ...storedIdentity,
    kind: z.literal("example"),
    example: z.string().min(1),
    edition: z.string().optional(),
  }),
]);

function stableTab(tab: WorkspaceTab): WorkspaceTab {
  if (tab.kind === "home") return homeTab();
  const stable: WorkspaceTab = { id: tab.id, kind: tab.kind, title: tab.title };
  for (const key of [
    "fileKey",
    "example",
    "edition",
    "page",
    "node",
  ] as const) {
    if (tab[key] !== undefined) stable[key] = tab[key];
  }
  if (tab.nativePath !== undefined) stable.nativePath = tab.nativePath;
  return stable;
}

export function serializeTabsState(state: WorkspaceTabsState): string {
  return JSON.stringify({
    tabs: state.tabs.map(stableTab),
    activeTabId: state.activeTabId,
  });
}

export function deserializeTabsState(
  raw: string | null | undefined,
): Pick<WorkspaceTabsState, "tabs" | "activeTabId"> | null {
  if (!raw) return null;
  try {
    const session = storedState.safeParse(JSON.parse(raw));
    if (!session.success) return null;
    const tabs = [homeTab()];
    for (const entry of session.data.tabs) {
      const parsed = storedTab.safeParse(entry);
      if (!parsed.success) continue;
      const data = parsed.data;
      const tab =
        data.kind === "file" ? makeFileTab(data) : makeExampleTab(data);
      if (tab.id !== data.id || tabs.some((open) => sameTab(open, tab)))
        continue;
      tabs.push(tab);
      if (tabs.length === MAX_OPEN_TABS) break;
    }
    const activeTabId =
      tabs.find((tab) => tab.id === session.data.activeTabId)?.id ??
      HOME_TAB_ID;
    return { tabs, activeTabId };
  } catch {
    return null;
  }
}

export function createInitialTabsState(
  search: string,
  persistedRaw?: string | null,
): WorkspaceTabsState {
  const restored = deserializeTabsState(persistedRaw);
  const state = {
    tabs: restored?.tabs ?? [homeTab()],
    activeTabId: HOME_TAB_ID,
    closedStack: [],
  };
  const target = parseLocationToTab(search);
  if (!target) return state;
  // Deep links carry a location but no document name.
  const restoredTab = state.tabs.find((tab) => sameTab(tab, target));
  if (restoredTab) target.title = restoredTab.title;
  return openTab(state, target);
}

export function activateTab(
  state: WorkspaceTabsState,
  tabId: string,
): WorkspaceTabsState {
  if (
    tabId === state.activeTabId ||
    !state.tabs.some((tab) => tab.id === tabId)
  )
    return state;
  return { ...state, activeTabId: tabId };
}

export function openTab(
  state: WorkspaceTabsState,
  tab: WorkspaceTab,
): WorkspaceTabsState {
  if (tab.id === HOME_TAB_ID || tab.kind === "home")
    return activateTab(state, HOME_TAB_ID);
  // Opening a native document can also supply a newly assigned browser key.
  const byPath = tab.nativePath?.trim()
    ? state.tabs.find((item) => item.nativePath === tab.nativePath)
    : undefined;
  const existing = byPath ?? state.tabs.find((item) => sameTab(item, tab));
  const closedStack = state.closedStack.filter((item) => !sameTab(item, tab));
  if (existing) {
    const merged = { ...existing };
    for (const key of ["title", "nativePath", "page", "node"] as const) {
      const value = tab[key];
      if (value?.trim()) merged[key] = value;
    }
    if (tab.preset) merged.preset = tab.preset;
    return {
      ...state,
      activeTabId: existing.id,
      tabs: state.tabs.map((item) => (item === existing ? merged : item)),
      closedStack,
    };
  }
  let tabs = state.tabs;
  if (tabs.length >= MAX_OPEN_TABS) {
    const oldest = tabs.find(
      (item) =>
        item.id !== HOME_TAB_ID &&
        item.id !== state.activeTabId &&
        !item.busyReason,
    );
    if (!oldest) return state;
    tabs = tabs.filter((item) => item !== oldest);
  }
  return {
    tabs: [...tabs, tab],
    closedStack,
    activeTabId: tab.id,
  };
}

export function closeTab(
  state: WorkspaceTabsState,
  tabId: string,
): WorkspaceTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (tabId === HOME_TAB_ID || index < 0) return state;
  const closed = state.tabs[index];
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  const neighbor = tabs[index] ?? tabs[index - 1];
  return {
    tabs,
    activeTabId:
      tabId === state.activeTabId
        ? (neighbor?.id ?? HOME_TAB_ID)
        : state.activeTabId,
    closedStack: [...state.closedStack, stableTab(closed)].slice(
      -MAX_CLOSED_STACK,
    ),
  };
}

export function reopenClosedTab(state: WorkspaceTabsState): WorkspaceTabsState {
  const lastClosed = state.closedStack.at(-1);
  return lastClosed ? openTab(state, lastClosed) : state;
}

export function closeOtherTabs(
  state: WorkspaceTabsState,
  keepTabId: string,
): WorkspaceTabsState {
  if (!state.tabs.some((tab) => tab.id === keepTabId)) return state;
  return state.tabs.reduce(
    (next, tab) => (tab.id === keepTabId ? next : closeTab(next, tab.id)),
    activateTab(state, keepTabId),
  );
}

export function closeTabsToRight(
  state: WorkspaceTabsState,
  tabId: string,
): WorkspaceTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  return state.tabs
    .slice(index + 1)
    .reduce((next, tab) => closeTab(next, tab.id), state);
}

export function reorderTab(
  state: WorkspaceTabsState,
  draggedId: string,
  targetId: string,
): WorkspaceTabsState {
  const from = state.tabs.findIndex((tab) => tab.id === draggedId);
  const to = state.tabs.findIndex((tab) => tab.id === targetId);
  if (from < 1 || to < 1 || from === to) return state;
  const tabs = [...state.tabs];
  const [dragged] = tabs.splice(from, 1);
  tabs.splice(to, 0, dragged);
  return { ...state, tabs };
}

export function updateTabMeta(
  state: WorkspaceTabsState,
  tabId: string,
  patch: Partial<
    Pick<
      WorkspaceTab,
      "title" | "dirty" | "busyReason" | "nativePath" | "preset"
    >
  >,
): WorkspaceTabsState {
  if (tabId === HOME_TAB_ID) return state;
  const existing = state.tabs.find((tab) => tab.id === tabId);
  if (!existing) return state;
  const merged = {
    ...existing,
    ...patch,
    title: patch.title?.trim() ? patch.title : existing.title,
  };
  if (
    Object.entries(merged).every(
      ([key, value]) => existing[key as keyof WorkspaceTab] === value,
    )
  )
    return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab === existing ? merged : tab)),
  };
}

export function pruneMissingFileTabs(
  state: WorkspaceTabsState,
  existingKeys: ReadonlySet<string>,
): WorkspaceTabsState {
  const tabs = state.tabs.filter(
    (tab) =>
      tab.kind !== "file" ||
      tab.id === state.activeTabId ||
      tab.fileKey === LEGACY_DEFAULT_FILE_KEY ||
      (!!tab.fileKey && existingKeys.has(tab.fileKey)),
  );
  return tabs.length === state.tabs.length ? state : { ...state, tabs };
}

export function switchAdjacentTab(
  state: WorkspaceTabsState,
  delta: -1 | 1,
): WorkspaceTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const count = state.tabs.length;
  return activateTab(state, state.tabs[(index + delta + count) % count].id);
}

export function switchTabByIndex(
  state: WorkspaceTabsState,
  oneBasedIndex: number,
): WorkspaceTabsState {
  if (
    oneBasedIndex < 1 ||
    oneBasedIndex > 9 ||
    !Number.isInteger(oneBasedIndex)
  )
    return state;
  const tab =
    state.tabs[oneBasedIndex === 9 ? state.tabs.length - 1 : oneBasedIndex - 1];
  return tab ? activateTab(state, tab.id) : state;
}
