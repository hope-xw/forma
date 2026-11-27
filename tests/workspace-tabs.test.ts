import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HOME_TAB_ID,
  LEGACY_DEFAULT_FILE_KEY,
  MAX_CLOSED_STACK,
  MAX_OPEN_TABS,
  WORKSPACE_TABS_STORAGE_KEY,
  activateTab,
  closeOtherTabs,
  closeTab,
  closeTabsToRight,
  createInitialTabsState,
  deserializeTabsState,
  exampleTabId,
  fileTabId,
  homeTab,
  makeExampleTab,
  makeFileTab,
  openTab,
  parseLocationToTab,
  pruneMissingFileTabs,
  reopenClosedTab,
  reorderTab,
  serializeTabsState,
  switchAdjacentTab,
  switchTabByIndex,
  tabToUrl,
  updateTabMeta,
  type WorkspaceTab,
  type WorkspaceTabsState,
} from "../src/application/workspace-tabs";
import type { WorkspaceTabBarProps } from "../src/editor/WorkspaceTabBar";

const css = registerHooks({
  load(url, context, next) {
    return url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context);
  },
});
const { WorkspaceTabBar } = await import("../src/editor/WorkspaceTabBar");
css.deregister();

const file = (fileKey: string) => makeFileTab({ fileKey, title: fileKey });
const sample = makeExampleTab({ example: "mobile-studio", edition: "atlas" });
const initial = () => createInitialTabsState("");
const opened = (...tabs: WorkspaceTab[]) => tabs.reduce(openTab, initial());
const ids = (state: WorkspaceTabsState) => state.tabs.map((tab) => tab.id);
const files = (count: number) =>
  Array.from({ length: count }, (_, i) => file(String(i + 1)));

test("Home, files, editions and custom examples have stable identities and titles", () => {
  assert.deepEqual(homeTab(), { id: "home", kind: "home", title: "工作台" });
  assert.equal(WORKSPACE_TABS_STORAGE_KEY, "forma.workspace-tabs.v1");
  assert.equal(fileTabId("稿:1"), "file:稿:1");
  assert.equal(exampleTabId("library"), "example:library");
  assert.equal(sample.id, "example:mobile-studio:atlas");
  assert.equal(sample.title, "移动设计研究室");
  assert.equal(
    makeExampleTab({ example: "aura-showcase" }).title,
    "SaaS 工作台样例",
  );
  assert.equal(makeExampleTab({ example: "prototype" }).title, "prototype");
  assert.equal(
    makeExampleTab({ example: "aura-showcase", title: "参考稿" }).title,
    "参考稿",
  );
  assert.equal(tabToUrl(homeTab()), "./");
  for (const search of [
    "",
    "?file=",
    "?example=",
    "?editor=0",
    "?preset=mobile",
    "?unknown=1",
  ])
    assert.equal(parseLocationToTab(search), null);
});

test("file and legacy routes encode keys and represent each quick start preset", () => {
  const key = " a/稿 +&?# ";
  const url = "?file=" + encodeURIComponent(key);
  for (const fileKey of [key, LEGACY_DEFAULT_FILE_KEY]) {
    const base = fileKey === key ? url : "?editor=1";
    assert.deepEqual(parseLocationToTab(base), makeFileTab({ fileKey }));
    for (const [preset, suffix] of [
      ["blank", fileKey === key ? "" : "&preset=blank"],
      ["mobile", "&preset=mobile"],
      ["desktop", "&preset=desktop"],
      ["ai", "&ai=1"],
    ] as const) {
      assert.equal(tabToUrl(makeFileTab({ fileKey, preset })), base + suffix);
      assert.equal(
        parseLocationToTab(base + "&preset=" + preset)?.preset,
        preset,
      );
    }
    assert.equal(
      parseLocationToTab(base + "&preset=desktop&ai=1")?.preset,
      "ai",
    );
    assert.equal(
      parseLocationToTab(base + "&preset=bad&ai=0")?.preset,
      undefined,
    );
  }
  assert.equal(
    parseLocationToTab("?editor=1&example=demo&file=x")?.id,
    "file:x",
  );
  assert.equal(
    parseLocationToTab("?editor=1&example=demo")?.id,
    "example:demo",
  );
});

test("example routes preserve encoded edition, page and node independently", () => {
  const tab = makeExampleTab({
    example: "样例 A",
    edition: "版+1",
    page: "页/1",
    node: "a?b&c",
  });
  assert.equal(
    tabToUrl(tab),
    "?example=%E6%A0%B7%E4%BE%8B%20A&edition=%E7%89%88%2B1&page=%E9%A1%B5%2F1&node=a%3Fb%26c",
  );
  assert.deepEqual(parseLocationToTab(tabToUrl(tab)), tab);
  assert.deepEqual(
    parseLocationToTab("?example=mobile-studio&page=&node=&edition=atlas"),
    sample,
  );
  assert.equal(
    tabToUrl(makeExampleTab({ example: "mobile-studio", node: "solo" })),
    "?example=mobile-studio&node=solo",
  );
});

test("open deduplicates independently by ID, file key or native path and preserves editor state", () => {
  const a = {
    ...file("A"),
    nativePath: "/项目/A.forma",
    dirty: true,
    busyReason: "ai" as const,
  };
  const before = opened(a, file("B"));
  for (const candidate of [
    { ...file("different-key"), id: a.id },
    { ...file("A"), id: "another-id" },
    { ...file("import-copy"), nativePath: a.nativePath },
  ]) {
    const next = openTab(before, {
      ...candidate,
      title: "新文件名",
      preset: "desktop",
    });
    assert.deepEqual(ids(next), ids(before));
    assert.equal(next.activeTabId, a.id);
    assert.deepEqual(next.tabs[1], {
      ...a,
      title: "新文件名",
      preset: "desktop",
    });
  }
  assert.equal(before.tabs[1], a);
  assert.equal(a.title, "A");
  assert.equal(before.activeTabId, "file:B");
  const rebound = opened(file("B"), a);
  const samePath = openTab(rebound, { ...file("B"), nativePath: a.nativePath });
  assert.equal(samePath.activeTabId, a.id);
  assert.equal(
    samePath.tabs.filter((tab) => tab.nativePath === a.nativePath).length,
    1,
  );
  const renamed = openTab(before, {
    ...a,
    nativePath: "/新/A.forma",
    title: "  ",
  });
  assert.equal(renamed.tabs[1].nativePath, "/新/A.forma");
  assert.equal(renamed.tabs[1].title, "A");
  const examples = opened({ ...sample, page: "first", node: "root" });
  assert.deepEqual(
    openTab(examples, { ...sample, page: "", node: "child" }).tabs[1],
    { ...sample, page: "first", node: "child" },
  );
  assert.equal(
    openTab(
      examples,
      makeExampleTab({ example: "mobile-studio", edition: "other" }),
    ).tabs.length,
    3,
  );
  for (const nativePath of [undefined, null, "", " "]) {
    assert.equal(
      opened({ ...file("x"), nativePath }, { ...file("y"), nativePath }).tabs
        .length,
      3,
    );
  }
});

test("Home stays canonical and invalid tab commands leave the current state intact", () => {
  const state = opened(file("A"));
  for (const result of [
    closeTab(state, HOME_TAB_ID),
    updateTabMeta(state, HOME_TAB_ID, { title: "X", dirty: true }),
    reorderTab(state, HOME_TAB_ID, "file:A"),
    reorderTab(state, "file:A", HOME_TAB_ID),
    activateTab(state, "missing"),
    closeTab(state, "missing"),
    closeOtherTabs(state, "missing"),
    closeTabsToRight(state, "missing"),
    reorderTab(state, "missing", "file:A"),
    updateTabMeta(state, "missing", { dirty: true }),
    reopenClosedTab(state),
  ])
    assert.equal(result, state);
  const home = openTab(state, { ...homeTab(), title: "X", dirty: true });
  assert.deepEqual(home.tabs, [homeTab(), file("A")]);
  assert.equal(home.activeTabId, HOME_TAB_ID);
  assert.equal(activateTab(home, HOME_TAB_ID), home);
});

test("at 24 tabs only the oldest eligible tab is displaced; fully protected tabs survive", () => {
  assert.equal(MAX_OPEN_TABS, 24);
  const full = opened(...files(23));
  const protectedFirst = updateTabMeta(
    updateTabMeta(full, "file:1", { busyReason: "ai" }),
    "file:2",
    { busyReason: "mcp" },
  );
  const activeThird = activateTab(protectedFirst, "file:3");
  const next = openTab(activeThird, file("new"));
  assert.deepEqual(ids(next), [
    ...ids(full).filter((id) => id !== "file:4"),
    "file:new",
  ]);
  assert.equal(next.activeTabId, "file:new");
  assert.deepEqual(next.closedStack, []);
  const withHistory = { ...activeThird, closedStack: [file("x"), file("y")] };
  const reopened = reopenClosedTab(reopenClosedTab(withHistory));
  assert.deepEqual(reopened.tabs.slice(-2), [file("y"), file("x")]);
  assert.deepEqual(reopened.closedStack, []);
  assert.equal(full.tabs.length, 24);
  const allBusy = activeThird.tabs.reduce(
    (s, tab) => updateTabMeta(s, tab.id, { busyReason: "ai" }),
    activeThird,
  );
  const blocked = { ...allBusy, closedStack: [file("closed")] };
  assert.equal(openTab(blocked, file("new")), blocked);
  assert.equal(reopenClosedTab(blocked), blocked);
  assert.equal(openTab(blocked, file("1")).activeTabId, "file:1");
});

test("closing the active tab selects its right neighbor, then its left neighbor and Home", () => {
  const state = activateTab(opened(file("A"), sample, file("C")), sample.id);
  assert.equal(closeTab(state, "file:A").activeTabId, sample.id);
  const right = closeTab(state, sample.id);
  assert.equal(right.activeTabId, "file:C");
  const left = closeTab(right, "file:C");
  assert.equal(left.activeTabId, "file:A");
  const home = closeTab(left, "file:A");
  assert.deepEqual(home.tabs, [homeTab()]);
  assert.equal(home.activeTabId, HOME_TAB_ID);
});

test("recently closed tabs retain stable metadata and reopen in bounded LIFO order", () => {
  assert.equal(MAX_CLOSED_STACK, 10);
  const originals = files(12).map((tab) => ({
    ...tab,
    dirty: true,
    busyReason: "mcp" as const,
    preset: "ai" as const,
    nativePath: "/" + tab.title,
  }));
  let state = closeOtherTabs(opened(...originals), HOME_TAB_ID);
  assert.equal(state.closedStack.length, 10);
  for (let i = 12; i >= 3; i--) {
    state = reopenClosedTab(state);
    assert.deepEqual(state.tabs.at(-1), {
      ...file(String(i)),
      nativePath: "/" + i,
    });
    assert.equal(state.activeTabId, fileTabId(String(i)));
    assert.equal(state.closedStack.length, i - 3);
  }
  assert.equal(reopenClosedTab(state), state);
  const closed = closeTab(state, "file:4");
  assert.deepEqual(openTab(closed, file("4")).closedStack, []);
  assert.deepEqual(
    openTab(closed, { ...file("alias"), nativePath: "/4" }).closedStack,
    [],
  );
});

test("bulk close keeps its target, records explicitly closed busy tabs and preserves a surviving active tab", () => {
  const state = opened(
    file("A"),
    { ...sample, busyReason: "mcp" },
    file("C"),
    file("D"),
  );
  const others = closeOtherTabs(state, "file:C");
  assert.deepEqual(ids(others), [HOME_TAB_ID, "file:C"]);
  assert.equal(others.activeTabId, "file:C");
  assert.deepEqual(others.closedStack, [file("A"), sample, file("D")]);
  const right = closeTabsToRight(state, "file:A");
  assert.deepEqual(ids(right), [HOME_TAB_ID, "file:A"]);
  assert.equal(right.activeTabId, "file:A");
  assert.deepEqual(right.closedStack, [sample, file("C"), file("D")]);
  assert.equal(
    closeTabsToRight(activateTab(state, "file:A"), sample.id).activeTabId,
    "file:A",
  );
  assert.equal(closeTabsToRight(state, "file:D"), state);
  assert.deepEqual(closeTabsToRight(state, HOME_TAB_ID).tabs, [homeTab()]);
});

test("drag reorder moves in both directions while preserving the active identity", () => {
  const state = opened(file("A"), sample, file("C"));
  const toEnd = reorderTab(state, "file:A", "file:C");
  assert.deepEqual(ids(toEnd), [HOME_TAB_ID, sample.id, "file:C", "file:A"]);
  assert.equal(toEnd.activeTabId, "file:C");
  assert.deepEqual(reorderTab(toEnd, "file:A", sample.id), state);
  assert.equal(reorderTab(toEnd, sample.id, sample.id), toEnd);
});

test("metadata updates report saves and disconnections and clear consumed quick starts", () => {
  const tab = makeFileTab({ fileKey: "A", preset: "ai" });
  const state = opened(tab);
  const patch = {
    title: "原型",
    dirty: true,
    nativePath: "/A.forma",
    busyReason: "ai" as const,
  };
  const updated = updateTabMeta(state, tab.id, patch);
  assert.deepEqual(updated.tabs[1], { ...tab, ...patch });
  assert.equal(updated.tabs[0], state.tabs[0]);
  assert.equal(updateTabMeta(updated, tab.id, patch), updated);
  assert.equal(updateTabMeta(updated, tab.id, { title: undefined }), updated);
  const cleared = {
    dirty: false,
    nativePath: null,
    busyReason: null,
    preset: undefined,
  };
  assert.deepEqual(updateTabMeta(updated, tab.id, cleared).tabs[1], {
    ...tab,
    ...patch,
    ...cleared,
  });
  assert.equal(state.tabs[1].dirty, undefined);
});

test("adjacent navigation wraps; shortcuts 1–8 are positional and 9 selects the last tab", () => {
  const state = opened(...files(12));
  const home = switchAdjacentTab(state, 1);
  assert.equal(home.activeTabId, HOME_TAB_ID);
  assert.equal(switchAdjacentTab(home, -1).activeTabId, "file:12");
  assert.equal(switchAdjacentTab(home, 1).activeTabId, "file:1");
  for (let i = 1; i <= 8; i++)
    assert.equal(switchTabByIndex(state, i).activeTabId, state.tabs[i - 1].id);
  assert.equal(switchTabByIndex(home, 9).activeTabId, "file:12");
  for (const index of [0, -1, 1.5, NaN, 10])
    assert.equal(switchTabByIndex(state, index), state);
  const one = initial();
  for (const index of [1, 2, 8, 9])
    assert.equal(switchTabByIndex(one, index), one);
  assert.equal(switchAdjacentTab(one, -1), one);
  assert.equal(switchAdjacentTab(one, 1), one);
});

test("persistence roundtrips stable labels, native paths and example deep links only", () => {
  const design = {
    ...file(" 稿 A "),
    nativePath: "/项目/设计.forma",
    page: "页面",
    node: "画板",
  };
  const ref = { ...sample, page: "atlas", node: "root", nativePath: null };
  const editing = {
    ...design,
    dirty: true,
    preset: "ai",
    busyReason: "ai",
    documentContent: "private",
  } as const;
  const state = closeTab(opened(editing, ref, file("closed")), "file:closed");
  const raw = serializeTabsState(state);
  assert.deepEqual(JSON.parse(raw), {
    tabs: [homeTab(), design, ref],
    activeTabId: ref.id,
  });
  assert.deepEqual(deserializeTabsState(raw), JSON.parse(raw));
  const home = createInitialTabsState("", raw);
  assert.deepEqual(home, {
    tabs: [homeTab(), design, ref],
    activeTabId: HOME_TAB_ID,
    closedStack: [],
  });
  const direct = createInitialTabsState(
    tabToUrl({ ...design, preset: "mobile" }),
    raw,
  );
  assert.deepEqual(direct.tabs[1], { ...design, preset: "mobile" });
  assert.equal(direct.activeTabId, design.id);
  const location = createInitialTabsState(
    "?example=mobile-studio&edition=atlas&node=leaf",
    raw,
  );
  assert.deepEqual(location.tabs.at(-1), { ...ref, node: "leaf" });
  assert.equal(location.activeTabId, ref.id);
  assert.deepEqual(
    createInitialTabsState("?file=fresh", raw).tabs.at(-1),
    makeFileTab({ fileKey: "fresh" }),
  );
});

test("invalid stored sessions recover, malformed entries are skipped, and restoration enforces the open limit", () => {
  for (const raw of [
    undefined,
    null,
    "",
    "invalid",
    "null",
    "{}",
    "[]",
    '{"tabs":{}}',
  ]) {
    assert.equal(deserializeTabsState(raw), null);
    assert.deepEqual(createInitialTabsState("", raw), initial());
  }
  const first = { ...file("1"), nativePath: "/1" };
  const raw = JSON.stringify({
    tabs: [
      null,
      "x",
      { ...homeTab(), title: "x" },
      { ...file("bad"), id: "example:bad" },
      { ...file(""), fileKey: "" },
      { ...sample, page: 2 },
      { ...sample, kind: "other" },
      {
        ...first,
        dirty: true,
        busyReason: "mcp",
        preset: "ai",
        document: "ignored",
      },
      { ...first, title: "duplicate" },
      { ...file("copy"), nativePath: "/1" },
      ...files(30),
    ],
    activeTabId: "file:30",
  });
  const restored = createInitialTabsState("", raw);
  assert.deepEqual(restored.tabs, [homeTab(), first, ...files(23).slice(1)]);
  assert.equal(deserializeTabsState(raw)?.activeTabId, HOME_TAB_ID);
  const direct = createInitialTabsState("?file=30", raw);
  assert.equal(direct.tabs.length, 24);
  assert.equal(direct.activeTabId, "file:30");
});

test("pruning removes only inactive, missing, nonlegacy files without adding them to history", () => {
  const legacy = file(LEGACY_DEFAULT_FILE_KEY);
  const state = opened(
    file("deleted"),
    legacy,
    sample,
    file("kept"),
    file("active"),
  );
  const pruned = pruneMissingFileTabs(state, new Set(["kept"]));
  assert.deepEqual(pruned.tabs, [
    homeTab(),
    legacy,
    sample,
    file("kept"),
    file("active"),
  ]);
  assert.equal(pruned.activeTabId, "file:active");
  assert.deepEqual(pruned.closedStack, []);
  assert.equal(pruneMissingFileTabs(pruned, new Set(["kept"])), pruned);
});

function tabBarFixture(t: TestContext) {
  return {
    tabs: [
      homeTab(),
      { ...file("设计稿"), dirty: true, busyReason: "ai" as const },
      { ...sample, busyReason: "mcp" as const },
    ],
    activeTabId: "file:设计稿",
    isMacDesktop: true,
    canReopenClosed: true,
    onSelectTab: t.mock.fn<(tabId: string) => void>(),
    onCloseTab: t.mock.fn<(tabId: string) => void>(),
    onNewTab: t.mock.fn(),
    onReopenClosed: t.mock.fn(),
    onCloseOthers: t.mock.fn<(tabId: string) => void>(),
    onCloseToRight: t.mock.fn<(tabId: string) => void>(),
    onReorderTab: t.mock.fn<(fromId: string, toId: string) => void>(),
    onOpenInNewWindow: t.mock.fn<(tab: WorkspaceTab) => void>(),
    onDropFiles: t.mock.fn<(files: FileList) => void>(),
  } satisfies WorkspaceTabBarProps;
}

test("SSR exposes tab roles, selected state, indicators, Mac chrome and tooltip contracts", (t) => {
  const props = tabBarFixture(t);
  const html = renderToStaticMarkup(createElement(WorkspaceTabBar, props));
  const doc = new DOMParser().parseFromString(html, "text/html");
  const buttons = Array.from(doc.getElementsByTagName("button"));
  const [home, design, example] = buttons.filter(
    (b) => b.getAttribute("role") === "tab",
  );
  assert.equal(doc.documentElement.getAttribute("role"), "navigation");
  assert.equal(
    doc.documentElement.getAttribute("aria-label"),
    "设计文件标签栏",
  );
  assert.equal(
    doc.documentElement.getAttribute("class"),
    "workspace-tabbar is-mac-desktop",
  );
  assert.equal(home.getAttribute("aria-label"), "返回工作台");
  assert.equal(home.getAttribute("data-tip"), "工作台首页");
  assert.equal(home.getAttribute("data-tip-kbd"), "⌘1");
  assert.equal(home.getAttribute("draggable"), "false");
  assert.equal(home.getAttribute("aria-selected"), "false");
  assert.equal(design.getAttribute("aria-selected"), "true");
  assert.equal(design.getAttribute("data-file-key"), "设计稿");
  assert.equal(design.getAttribute("draggable"), "true");
  assert.equal(example.getAttribute("data-tab-id"), sample.id);
  assert.equal(example.hasAttribute("data-file-key"), false);
  const spans = Array.from(doc.getElementsByTagName("span"));
  assert.deepEqual(
    spans
      .filter((el) => el.getAttribute("class") === "wtb-dirty-dot")
      .map((el) => el.getAttribute("aria-label")),
    ["未保存"],
  );
  assert.deepEqual(
    spans
      .filter((el) => el.getAttribute("class") === "wtb-busy-dot")
      .map((el) => el.getAttribute("title")),
    ["AI 生成中", "MCP 已连接"],
  );
  assert.deepEqual(
    buttons
      .filter((b) => b.getAttribute("aria-label")?.startsWith("关闭标签页"))
      .map((b) => b.getAttribute("aria-label")),
    ["关闭标签页 设计稿", "关闭标签页 移动设计研究室"],
  );
  const plus = buttons.at(-1)!;
  assert.equal(plus.getAttribute("class"), "wtb-new-btn");
  assert.equal(plus.getAttribute("aria-label"), "新建设计标签页");
  assert.equal(plus.getAttribute("data-tip"), "新建设计标签页");
  assert.equal(plus.getAttribute("data-tip-kbd"), "⌘T");
  assert.equal(plus.getAttribute("data-tip-side"), "bottom");
  assert.doesNotMatch(
    renderToStaticMarkup(
      createElement(WorkspaceTabBar, { ...props, isMacDesktop: false }),
    ),
    /is-mac-desktop/,
  );
});

// Exercise React's delegated events using the same lightweight DOM as workspace-home.
async function mountBar(t: TestContext, props: WorkspaceTabBarProps) {
  const doc = new DOMParser().parseFromString("<html/>", "text/html");
  const events = new EventTarget();
  const docEvents = new EventTarget();
  const create = doc.createElement.bind(doc);
  const noop = () => {};
  t.mock.method(doc, "createElement", (tag: string) => {
    const el = create(tag);
    const query = (selector: string) =>
      Array.from(el.getElementsByTagName("button")).filter((button) =>
        selector === '[role="tab"]'
          ? button.getAttribute("role") === "tab"
          : !button.hasAttribute("disabled"),
      );
    Object.defineProperty(el, "dataset", {
      get: () => ({ tabId: el.getAttribute("data-tab-id") }),
    });
    return Object.assign(el, {
      addEventListener: noop,
      removeEventListener: noop,
      style: { setProperty: noop },
      focus: () => Object.assign(doc, { activeElement: el }),
      getBoundingClientRect: () => ({
        left: 10,
        bottom: 36,
        width: 188,
        height: 150,
      }),
      querySelectorAll: query,
      querySelector: (selector: string) => query(selector)[0],
      contains: (target: Node | null) => {
        for (let node = target; node; node = node.parentNode)
          if (node === el) return true;
        return false;
      },
    });
  });
  doc.addEventListener = docEvents.addEventListener.bind(docEvents);
  doc.removeEventListener = docEvents.removeEventListener.bind(docEvents);
  const win = Object.assign(new EventTarget(), {
    document: doc,
    HTMLIFrameElement: class {},
    innerWidth: 320,
    innerHeight: 200,
  });
  const host = doc.createElement("div");
  host.addEventListener = events.addEventListener.bind(events);
  const globals = {
    document: doc,
    window: win,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const before = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, globals);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  t.after(async () => {
    await act(() => root.unmount());
    for (const key of Object.keys(globals)) {
      if (before[key]) Object.defineProperty(globalThis, key, before[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(() => root.render(createElement(WorkspaceTabBar, props)));
  function button(label: string) {
    const el = Array.from(host.getElementsByTagName("button")).find(
      (b) => b.getAttribute("aria-label") === label || b.textContent === label,
    );
    assert.ok(el, label);
    return el;
  }
  const menu = () =>
    Array.from(host.getElementsByTagName("div")).find(
      (el) => el.getAttribute("role") === "menu",
    );
  async function dispatch(
    type: string,
    target: Element,
    fields: Record<string, unknown> = {},
    onDocument = false,
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "target", { value: target });
    Object.assign(event, fields);
    await act(() => {
      (onDocument ? docEvents : events).dispatchEvent(event);
    });
    return event;
  }
  return { doc, host, bar: host.firstChild as Element, menu, button, dispatch };
}

test("mounted tabs route selection, keyboard navigation, close, middle-click and new independently", async (t) => {
  const props = tabBarFixture(t);
  const ui = await mountBar(t, props);
  await ui.dispatch("click", ui.button("返回工作台"));
  await ui.dispatch("click", ui.button("设计稿"));
  await ui.dispatch("keydown", ui.button("设计稿"), { key: "ArrowRight" });
  await ui.dispatch("keydown", ui.button(sample.title), { key: "ArrowRight" });
  assert.deepEqual(
    props.onSelectTab.mock.calls.map((call) => call.arguments[0]),
    [HOME_TAB_ID, "file:设计稿", sample.id, HOME_TAB_ID],
  );
  await ui.dispatch("click", ui.button("关闭标签页 设计稿"));
  await ui.dispatch("auxclick", ui.button(sample.title), { button: 1 });
  await ui.dispatch("auxclick", ui.button("设计稿"), { button: 2 });
  await ui.dispatch("auxclick", ui.button("返回工作台"), { button: 1 });
  assert.deepEqual(
    props.onCloseTab.mock.calls.map((call) => call.arguments[0]),
    ["file:设计稿", sample.id],
  );
  await ui.dispatch("click", ui.button("新建设计标签页"));
  assert.deepEqual(props.onNewTab.mock.calls[0].arguments, []);
  assert.equal(props.onSelectTab.mock.callCount(), 4);
});

test("context menu uses the clicked tab, fits a short viewport, and supports keyboard and outside dismissal", async (t) => {
  const props = tabBarFixture(t);
  const ui = await mountBar(t, props);
  const trigger = ui.button("设计稿");
  const open = () =>
    ui.dispatch("contextmenu", trigger, { clientX: 319, clientY: 198 });
  assert.equal((await open()).defaultPrevented, true);
  const menu = ui.menu()!;
  assert.equal(menu.style.left, "128px");
  assert.equal(menu.style.top, "46px");
  assert.equal(ui.doc.activeElement, ui.button("关闭标签页"));
  await ui.dispatch("keydown", ui.button("关闭标签页"), { key: "End" });
  assert.equal(ui.doc.activeElement, ui.button("在新窗口中打开"));
  await ui.dispatch("keydown", menu, { key: "Escape" }, true);
  assert.equal(ui.menu(), undefined);
  assert.equal(ui.doc.activeElement, trigger);
  await open();
  await ui.dispatch("pointerdown", ui.button("新建设计标签页"), {}, true);
  assert.equal(ui.menu(), undefined);
  for (const [label, callback] of [
    ["关闭标签页", props.onCloseTab],
    ["关闭其他标签页", props.onCloseOthers],
    ["关闭右侧标签页", props.onCloseToRight],
  ] as const) {
    await open();
    await ui.dispatch("click", ui.button(label));
    assert.deepEqual(callback.mock.calls.at(-1)?.arguments, ["file:设计稿"]);
    assert.equal(ui.menu(), undefined);
  }
  await open();
  await ui.dispatch("click", ui.button("重新打开已关闭标签页"));
  assert.equal(props.onReopenClosed.mock.callCount(), 1);
  await ui.dispatch("contextmenu", ui.button(sample.title), {
    clientX: 10,
    clientY: 20,
  });
  assert.equal(ui.button("关闭右侧标签页").hasAttribute("disabled"), true);
  await ui.dispatch("click", ui.button("在新窗口中打开"));
  assert.deepEqual(props.onOpenInNewWindow.mock.calls.at(-1)?.arguments, [
    props.tabs[2],
  ]);
  assert.equal(props.onSelectTab.mock.callCount(), 0);
});

test("the Home menu protects Home and shows unavailable actions in their disabled state", async (t) => {
  const props = {
    ...tabBarFixture(t),
    tabs: [homeTab()],
    activeTabId: HOME_TAB_ID,
    canReopenClosed: false,
    onOpenInNewWindow: undefined,
  };
  const ui = await mountBar(t, props);
  await ui.dispatch("contextmenu", ui.button("返回工作台"), {
    clientX: 0,
    clientY: 0,
  });
  const items = Array.from(ui.menu()!.getElementsByTagName("button"));
  assert.deepEqual(
    items.map((b) => b.textContent),
    ["关闭标签页", "关闭其他标签页", "关闭右侧标签页", "重新打开已关闭标签页"],
  );
  assert.ok(items.every((b) => b.hasAttribute("disabled")));
});

test("dragging a tab reorders locally and dropping actual files on a child forwards the original list once", async (t) => {
  const props = tabBarFixture(t);
  const ui = await mountBar(t, props);
  const design = ui.button("设计稿");
  const target = ui.button(sample.title);
  const move = {
    types: ["application/x-forma-tab"],
    files: [],
    setData: t.mock.fn(),
    dropEffect: "",
    effectAllowed: "",
  };
  await ui.dispatch("dragstart", design, { dataTransfer: move });
  assert.equal(move.effectAllowed, "move");
  assert.deepEqual(move.setData.mock.calls[0].arguments, [
    "application/x-forma-tab",
    "file:设计稿",
  ]);
  assert.equal(
    (await ui.dispatch("dragover", target, { dataTransfer: move }))
      .defaultPrevented,
    true,
  );
  await ui.dispatch("drop", target, { dataTransfer: move });
  assert.deepEqual(props.onReorderTab.mock.calls[0].arguments, [
    "file:设计稿",
    sample.id,
  ]);
  await ui.dispatch("dragend", design);
  await ui.dispatch("drop", target, { dataTransfer: move });
  assert.equal(props.onReorderTab.mock.callCount(), 1);
  const desktopFiles = [
    new File(["{}"], "稿.forma"),
    new File([""], "参考.fig"),
  ];
  const copy = { types: ["Files"], files: desktopFiles, dropEffect: "" };
  const enter = () => ui.dispatch("dragenter", design, { dataTransfer: copy });
  await enter();
  await enter();
  await ui.dispatch("dragleave", design, { dataTransfer: copy });
  assert.match(ui.bar.getAttribute("class")!, /is-file-over/);
  assert.equal(
    (await ui.dispatch("dragover", design, { dataTransfer: copy }))
      .defaultPrevented,
    true,
  );
  assert.equal(copy.dropEffect, "copy");
  await ui.dispatch("drop", design, { dataTransfer: copy });
  assert.doesNotMatch(ui.bar.getAttribute("class")!, /is-file-over/);
  assert.equal(props.onDropFiles.mock.callCount(), 1);
  assert.equal(props.onDropFiles.mock.calls[0].arguments[0], desktopFiles);
  assert.equal(props.onReorderTab.mock.callCount(), 1);
  await enter();
  await ui.dispatch("dragleave", design, { dataTransfer: copy });
  assert.doesNotMatch(ui.bar.getAttribute("class")!, /is-file-over/);
});
