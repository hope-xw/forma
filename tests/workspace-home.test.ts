import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectSpace } from "../src/agent/project-memory";
import type { DesignDocument } from "../src/domain/document";
import {
  BrowserDocumentRepository,
  cachedRecentFiles,
} from "../src/infrastructure/storage";
import { IndexedDbProjectMemoryRepository } from "../src/infrastructure/project-memory-store";
import { acceptedDesignFiles } from "../src/infrastructure/design-import/types";
import {
  editorFileUrl,
  homeUrl,
  newBlankFile,
  newDesignFile,
} from "../src/editor/file-actions";
import type { WorkspaceHomeProps } from "../src/editor/WorkspaceHome";
import { FileBrowser } from "../src/editor/FileBrowser";
import { createStarter } from "../src/domain/seed";

const css = registerHooks({
  load(url, context, next) {
    return url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context);
  },
});
const { WorkspaceHome } = await import("../src/editor/WorkspaceHome");
css.deregister();

function globals(t: TestContext, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

async function mount(t: TestContext, props: WorkspaceHomeProps = {}) {
  const doc = new DOMParser().parseFromString("<html/>", "text/html");
  const noop = () => {};
  const events = new EventTarget();
  const create = doc.createElement.bind(doc);
  const enhance = (element: Element) =>
    Object.assign(element, {
      style: { setProperty: noop },
      options: [],
      focus: noop,
      addEventListener: noop,
      removeEventListener: noop,
    });
  t.mock.method(doc, "createElement", (tag: string) => enhance(create(tag)));
  doc.addEventListener = noop;
  doc.removeEventListener = noop;
  Object.assign(doc.documentElement, { dataset: {} });
  const host = doc.createElement("div");
  host.addEventListener = events.addEventListener.bind(events);
  const store = new Map<string, string>();
  const assign = t.mock.fn<(url: string) => void>();
  const win = Object.assign(new EventTarget(), {
    document: doc,
    HTMLIFrameElement: class {},
  });
  globals(t, {
    document: doc,
    window: win,
    location: { assign },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
    __FORMA_VERSION__: "test",
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  await act(() => root.render(createElement(WorkspaceHome, props)));
  // Unmount before restoring the simulated DOM globals.
  const unmount = () => act(() => root.unmount());
  function button(label: string) {
    const found = Array.from(host.getElementsByTagName("button")).find(
      (el) =>
        el.getAttribute("aria-label") === label || el.textContent === label,
    );
    assert.ok(found, label);
    return found;
  }
  async function dispatch(
    type: string,
    target: Element,
    fields?: Record<string, unknown>,
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "target", { value: target });
    Object.assign(event, fields);
    await act(() => {
      events.dispatchEvent(event);
    });
  }
  return {
    host,
    store,
    doc,
    assign,
    button,
    dispatch,
    click: (label: string) => dispatch("click", button(label)),
    unmount,
  };
}

const project: ProjectSpace = {
  id: "proj-home-test",
  name: "品牌设计",
  createdAt: "2026-11-26T00:00:00Z",
  updatedAt: "2026-11-26T00:00:00Z",
};

test("Home and editor URLs preserve the file, sample edition and legacy document route", () => {
  assert.equal(homeUrl(), "./");
  for (const [preset, suffix] of [
    [undefined, ""],
    ["blank", ""],
    ["mobile", "&preset=mobile"],
    ["desktop", "&preset=desktop"],
    ["ai", "&ai=1"],
  ] as const)
    assert.equal(
      editorFileUrl("?file=forma.file.abc", preset),
      "?file=forma.file.abc" + suffix,
    );
  assert.equal(editorFileUrl("./"), "?editor=1");
  assert.equal(
    editorFileUrl("?example=mobile-studio&edition=atlas"),
    "?example=mobile-studio&edition=atlas",
  );
  assert.equal(
    editorFileUrl("?file=x&preset=mobile#page", "ai"),
    "?file=x&ai=1#page",
  );
});

test("the full-screen Home presents both named actions, all four starting points and file navigation", () => {
  const markup = renderToStaticMarkup(createElement(WorkspaceHome));
  const dom = new DOMParser().parseFromString(markup, "text/html");
  const buttons = Array.from(dom.getElementsByTagName("button"));
  const main = dom.getElementsByTagName("main")[0];
  assert.equal(main.getElementsByTagName("h1")[0].textContent, "最近打开");
  assert.equal(
    dom.getElementsByTagName("aside")[0].getAttribute("class"),
    "wh-sidebar",
  );
  assert.ok(
    buttons.some(
      (el) =>
        el.getAttribute("class") === "primary wh-primary-cta" &&
        el.textContent === "+ 新建设计",
    ),
  );
  assert.ok(buttons.some((el) => el.textContent === "导入设计文件"));
  assert.deepEqual(
    buttons
      .filter((el) => el.hasAttribute("data-preset"))
      .map((el) => [el.getAttribute("data-preset"), el.textContent]),
    [
      ["mobile", "新建移动端设计iPhone 16 · 393 × 852"],
      ["desktop", "新建桌面端设计Web · 1440 × 900"],
      ["ai", "用 Forma AI 起稿自然语言生成可编辑画板"],
      ["blank", "空白画布从零开始自由绘制"],
    ],
  );
  for (const label of [
    "工作台视图",
    "全部文件",
    "未归类草稿",
    "项目空间",
    "新建项目",
    "搜索设计文件",
    "文件排序",
    "网格视图",
    "列表视图",
  ])
    assert.ok(markup.includes(`aria-label="${label}"`), label);
  assert.equal(
    Array.from(dom.getElementsByTagName("input"))
      .find((el) => el.getAttribute("type") === "file")
      ?.getAttribute("accept"),
    acceptedDesignFiles,
  );
  assert.doesNotMatch(markup, /role="dialog"/);
});

test("empty workspace copy names the desktop or browser storage destination", (t) => {
  const win: { formaDesktop?: { version: string } } = {};
  globals(t, { window: win, localStorage: { getItem: () => null } });
  for (const desktop of [false, true]) {
    win.formaDesktop = desktop ? { version: "test" } : undefined;
    const view = renderToStaticMarkup(createElement(WorkspaceHome));
    assert.match(
      view,
      desktop
        ? /本机工作空间暂无已保存的设计文件/
        : /当前浏览器暂无已保存的设计文件/,
    );
    assert.doesNotMatch(view, /indexeddb/i);
  }
});

test("the editor quick switcher keeps its file controls accessible and visibly labeled", () => {
  const noop = () => {};
  const markup = renderToStaticMarkup(
    createElement(FileBrowser, {
      current: createStarter(),
      currentKey: "draft",
      close: noop,
      externalImport: noop,
      renameCurrent: noop,
    }),
  );
  const dom = new DOMParser().parseFromString(markup, "text/html");
  const buttons = Array.from(dom.getElementsByTagName("button"));
  for (const [label, visible] of [
    ["新建空白文件", "+ 新建设计"],
    ["导入为独立文件", "导入"],
  ]) {
    assert.equal(
      buttons.find((el) => el.getAttribute("aria-label") === label)
        ?.textContent,
      visible,
    );
  }
});

test("new blank files preserve the preferred color profile, empty content, custom title and existing caller contract", async (t) => {
  const save = t.mock.method(
    BrowserDocumentRepository.prototype,
    "save",
    async (_document: DesignDocument) => {},
  );
  const assign = t.mock.fn<(url: string) => void>();
  globals(t, {
    localStorage: { getItem: () => "display-p3" },
    location: { assign },
  });
  await newDesignFile({ name: "原型设计", preset: "desktop" });
  await newBlankFile();
  assert.deepEqual(
    save.mock.calls.map(({ arguments: [doc] }) => [
      doc.name,
      doc.revision,
      doc.nodes,
      doc.colorProfile,
    ]),
    [
      ["原型设计", 0, [], "display-p3"],
      ["无标题设计", 0, [], "display-p3"],
    ],
  );
  assert.match(
    assign.mock.calls[0].arguments[0],
    /^\?file=forma\.file\.[\da-f-]{36}&preset=desktop$/,
  );
  assert.match(
    assign.mock.calls[1].arguments[0],
    /^\?file=forma\.file\.[\da-f-]{36}$/,
  );
});

test("project CTA and all presets persist their design with the active project before navigation", async (t) => {
  t.mock.method(
    IndexedDbProjectMemoryRepository.prototype,
    "listProjects",
    async () => [project],
  );
  const bind = t.mock.method(
    IndexedDbProjectMemoryRepository.prototype,
    "assignFileToProject",
    async () => ({ project, migratedEpisodes: 0 }),
  );
  const save = t.mock.method(
    BrowserDocumentRepository.prototype,
    "save",
    async () => {},
  );
  const ui = await mount(t);
  try {
    await ui.click(project.name);
    assert.equal(
      ui.host.getElementsByTagName("h1")[0].textContent,
      project.name,
    );
    assert.match(ui.host.textContent ?? "", /将自动归入「品牌设计」/);
    for (const [label, suffix] of [
      ["新建设计", ""],
      ["新建移动端设计", "&preset=mobile"],
      ["新建桌面端设计", "&preset=desktop"],
      ["用 Forma AI 起稿", "&ai=1"],
      ["空白画布", ""],
    ]) {
      await ui.click(label);
      const call = bind.mock.calls.at(-1)!;
      assert.equal(call.arguments[1], project.id);
      assert.equal(call.arguments[2]?.requireDurable, true);
      assert.equal(
        ui.assign.mock.calls.at(-1)?.arguments[0],
        "?file=" + call.arguments[0] + suffix,
      );
    }
    assert.equal(save.mock.callCount(), 5);
    assert.equal(bind.mock.callCount(), 5);
    await ui.click("未归类草稿");
    await ui.click("新建设计");
    assert.equal(save.mock.callCount(), 6);
    assert.equal(bind.mock.callCount(), 5);
  } finally {
    await ui.unmount();
  }
});

test("file picker and drag-and-drop route native and external files to the current project", async (t) => {
  t.mock.method(
    IndexedDbProjectMemoryRepository.prototype,
    "listProjects",
    async () => [project],
  );
  const onOpenNativeFile = t.mock.fn(
    async (_file: File, _projectId: string | null) => {},
  );
  const onImportExternalFile = t.mock.fn(
    (_file: File, _projectId: string | null) => {},
  );
  const ui = await mount(t, { onOpenNativeFile, onImportExternalFile });
  try {
    await ui.click(project.name);
    const input = Array.from(ui.host.getElementsByTagName("input")).find(
      (el) => el.getAttribute("aria-label") === "选择设计文件",
    )!;
    const picked = t.mock.fn();
    Object.assign(input, { click: picked });
    await ui.click("导入设计文件");
    assert.equal(picked.mock.callCount(), 1);
    const native = new File(["{}"], "原稿.forma.json");
    Object.assign(input, { files: [native] });
    await ui.dispatch("change", input);
    assert.deepEqual(onOpenNativeFile.mock.calls[0].arguments, [
      native,
      project.id,
    ]);
    for (const filename of ["原稿.sketch", "原稿.fig"]) {
      const file = new File([""], filename);
      await ui.dispatch("drop", ui.host.firstChild as Element, {
        dataTransfer: { types: ["Files"], files: [file] },
      });
      assert.deepEqual(onImportExternalFile.mock.calls.at(-1)?.arguments, [
        file,
        project.id,
      ]);
    }
    const packageFile = new File(["{}"], "原稿.forma");
    await ui.click("全部文件");
    await ui.dispatch("drop", ui.host.firstChild as Element, {
      dataTransfer: { types: ["Files"], files: [packageFile] },
    });
    assert.deepEqual(onOpenNativeFile.mock.calls.at(-1)?.arguments, [
      packageFile,
      null,
    ]);
  } finally {
    await ui.unmount();
  }
});

test("gallery opens legacy designs, switches layouts and filters out assigned files in drafts", async (t) => {
  const files = cachedRecentFiles();
  const entries = [
    { key: "forma.document.v1", name: "原设计稿", pages: 1, updatedAt: 100 },
    { key: "forma.file.test", name: "移动端", pages: 3, updatedAt: 50 },
  ];
  files.push(...entries);
  t.after(() => files.splice(files.indexOf(entries[0]), entries.length));
  t.mock.method(
    IndexedDbProjectMemoryRepository.prototype,
    "listFileAssignments",
    async () => ({ [entries[1].key]: project.id }),
  );
  const ui = await mount(t);
  try {
    await ui.click("全部文件");
    const links = () =>
      Array.from(ui.host.getElementsByTagName("a")).filter((el) =>
        el.hasAttribute("aria-label"),
      );
    assert.deepEqual(
      links().map((el) => el.getAttribute("href")),
      ["?editor=1", "?file=forma.file.test"],
    );
    await ui.click("列表视图");
    assert.equal(ui.button("列表视图").getAttribute("aria-pressed"), "true");
    await ui.click("未归类草稿");
    assert.equal(links().length, 1);
    assert.equal(links()[0].getAttribute("aria-label"), "打开 原设计稿");
  } finally {
    await ui.unmount();
  }
});

test("theme switch persists and utility controls call the supplied integrations", async (t) => {
  const onOpenModelConfig = t.mock.fn(),
    onOpenIntegrations = t.mock.fn(),
    onOpenReleaseNotes = t.mock.fn();
  const ui = await mount(t, {
    initialTheme: "light",
    agentConnectedLabel: "测试模型",
    onOpenModelConfig,
    onOpenIntegrations,
    onOpenReleaseNotes,
  });
  try {
    await ui.click("切换深色主题");
    assert.equal(ui.doc.documentElement.dataset.theme, "dark");
    assert.equal(ui.store.get("forma.ui-theme"), "dark");
    await ui.click("切换浅色主题");
    assert.equal(ui.doc.documentElement.dataset.theme, "light");
    await ui.click("AI 模型配置测试模型");
    await ui.click("外部工具集成 (MCP)");
    await ui.click("版本日志");
    assert.deepEqual(
      [onOpenModelConfig, onOpenIntegrations, onOpenReleaseNotes].map((fn) =>
        fn.mock.callCount(),
      ),
      [1, 1, 1],
    );
  } finally {
    await ui.unmount();
  }
});
