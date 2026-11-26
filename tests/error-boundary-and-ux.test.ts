import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { act, createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStarter } from "../src/domain/seed";
import { readNativeDocument } from "../src/infrastructure/native-document";
import {
  ErrorBoundary,
  type ErrorBoundaryProps,
} from "../src/editor/ErrorBoundary";
import { CanvasWelcomeOverlay } from "../src/editor/CanvasWelcomeOverlay";
import { FileBrowser } from "../src/editor/FileBrowser";
import {
  isDesktopRuntime,
  saveStateCopy,
  storageUnavailableCopy,
  UNIFIED_FRAME_PRESET_GROUPS,
} from "../src/editor/ux-copy";

async function domTestHost(t: TestContext) {
  const document = new DOMParser().parseFromString("<html/>", "text/html");
  const events = new EventTarget();
  const noop = () => {};
  const create = document.createElement.bind(document);
  t.mock.method(document, "createElement", (tag: string) =>
    Object.assign(create(tag), {
      style: { setProperty: noop },
      addEventListener: noop,
      removeEventListener: noop,
    }),
  );
  document.addEventListener = noop;
  const host = document.createElement("div");
  host.addEventListener = events.addEventListener.bind(events);
  const globals = {
    document,
    window: { document, HTMLIFrameElement: class {} },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const before = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, globals);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host, { onCaughtError: () => {} });
  t.after(async () => {
    try {
      await act(() => root.unmount());
    } finally {
      for (const key of Object.keys(globals)) {
        if (before[key]) Object.defineProperty(globalThis, key, before[key]);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  const render = (element: ReactNode) => act(() => root.render(element));
  const dispatch = async (type: string, target: Element) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "target", { value: target });
    await act(() => {
      events.dispatchEvent(event);
    });
  };
  function button(label: string) {
    const match = Array.from(host.getElementsByTagName("button")).find(
      (el) =>
        el.getAttribute("aria-label") === label ||
        el.textContent?.startsWith(label),
    );
    assert.ok(match, label);
    return match;
  }
  return {
    host,
    render,
    dispatch,
    button,
    click: (label: string) => dispatch("click", button(label)),
  };
}

function brokenChild(): never {
  throw new Error("图层视图异常");
}

function boundary(props: Partial<ErrorBoundaryProps> = {}) {
  return createElement(ErrorBoundary, {
    scope: "workspace",
    children: createElement(brokenChild),
    ...props,
  });
}

test("healthy children render without a recovery alert", async (t) => {
  const { host, render } = await domTestHost(t);
  await render(boundary({ children: createElement("p", null, "画布已就绪") }));
  assert.equal(host.textContent, "画布已就绪");
  assert.equal(host.getElementsByTagName("button").length, 0);
});

for (const [scope, title, body] of [
  [
    "workspace",
    "画布视图遇到意外错误",
    "你的设计文件依然安全。可以尝试重新加载视图，或先立即导出本地备份。",
  ],
  [
    "panel",
    "此面板加载异常",
    "不会影响画布中的设计内容，可尝试重新加载此面板。",
  ],
  ["modal", "窗口暂时无法显示", "你可以重试或关闭此窗口继续编辑画布。"],
] as const) {
  test(`${scope} errors leave siblings mounted and show scoped recovery details`, async (t) => {
    const logged = t.mock.method(console, "error", () => {});
    const { host, render } = await domTestHost(t);
    const tree = (children: ReactNode) =>
      createElement(
        Fragment,
        null,
        createElement("aside", null, "设计内容"),
        boundary({ scope, children }),
      );
    await render(tree("已就绪"));
    const sibling = host.firstChild;
    await render(tree(createElement(brokenChild)));
    assert.equal(host.firstChild, sibling);
    assert.equal(sibling?.textContent, "设计内容");
    const alert = host.getElementsByTagName("section")[0];
    assert.equal(alert.getAttribute("role"), "alert");
    assert.equal(
      alert.getAttribute("class"),
      `forma-error-boundary is-${scope}`,
    );
    assert.equal(alert.getElementsByTagName("h2")[0].textContent, title);
    assert.equal(alert.getElementsByTagName("p")[0].textContent, body);
    const details = alert.getElementsByTagName("details")[0];
    assert.equal(details.hasAttribute("open"), false);
    assert.equal(
      details.getElementsByTagName("summary")[0].textContent,
      "查看错误详情",
    );
    assert.equal(
      details.getElementsByTagName("pre")[0].textContent,
      "图层视图异常",
    );
    assert.equal(alert.getElementsByTagName("button").length, 1);
    assert.equal(logged.mock.callCount(), 1);
  });
}

test("重新加载 retries the failed child and calls onReset once", async (t) => {
  t.mock.method(console, "error", () => {});
  const { host, render, click } = await domTestHost(t);
  let failed = true;
  function panel() {
    if (failed) return brokenChild();
    return createElement("p", null, "图层已恢复");
  }
  const onReset = t.mock.fn(() => {
    failed = false;
  });
  await render(
    boundary({
      scope: "panel",
      title: "图层面板",
      onReset,
      children: createElement(panel),
    }),
  );
  assert.equal(host.getElementsByTagName("h2")[0].textContent, "图层面板");
  await click("重新加载");
  assert.equal(onReset.mock.callCount(), 1);
  assert.equal(host.textContent, "图层已恢复");
});

test("only a changed resetKey automatically remounts a failed subtree", async (t) => {
  t.mock.method(console, "error", () => {});
  const { host, render } = await domTestHost(t);
  const onReset = t.mock.fn();
  await render(boundary({ resetKey: 1, onReset }));
  await render(boundary({ resetKey: 1, onReset, children: "新文件" }));
  assert.equal(
    host.getElementsByTagName("section")[0].getAttribute("role"),
    "alert",
  );
  await render(boundary({ resetKey: 2, onReset, children: "新文件" }));
  assert.equal(host.textContent, "新文件");
  assert.equal(onReset.mock.callCount(), 0);
});

test("导出设计备份 downloads the latest readable native document and reports success", async (t) => {
  t.mock.method(console, "error", () => {});
  const { host, render, click } = await domTestHost(t);
  const document = createStarter();
  const getRecoveryDocument = t.mock.fn(() => document);
  const create = host.ownerDocument.createElement.bind(host.ownerDocument);
  const names: string[] = [];
  t.mock.method(host.ownerDocument, "createElement", (tag: string) => {
    const el = create(tag);
    if (tag === "a") {
      const link = el as HTMLAnchorElement;
      link.click = () => {
        names.push(link.download);
      };
    }
    return el;
  });
  const blobs: Blob[] = [];
  t.mock.method(URL, "createObjectURL", (blob: Blob) => {
    blobs.push(blob);
    return "blob:recovery";
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await render(boundary({ getRecoveryDocument }));
  assert.equal(getRecoveryDocument.mock.callCount(), 0);
  for (const name of ["品牌 / 新稿", " / "]) {
    document.name = name;
    await click("导出设计备份");
    const restored = await readNativeDocument(blobs.at(-1)!);
    assert.equal(restored.name, name);
    assert.equal(restored.id, document.id);
    assert.deepEqual(
      restored.nodes.map((node) => node.id),
      document.nodes.map((node) => node.id),
    );
    assert.match(host.textContent ?? "", /已导出恢复备份文件/);
  }
  assert.equal(getRecoveryDocument.mock.callCount(), 2);
  assert.deepEqual(names, [
    "品牌-新稿.forma.json",
    "forma-recovery.forma.json",
  ]);
});

test("missing documents and failed backups leave the recovery controls usable", async (t) => {
  t.mock.method(console, "error", () => {});
  const { host, render, click, button } = await domTestHost(t);
  await render(boundary({ getRecoveryDocument: () => null }));
  await click("导出设计备份");
  assert.match(host.textContent ?? "", /暂时没有可导出的设计文件/);
  await render(
    boundary({
      getRecoveryDocument: () => {
        throw new Error("读取失败");
      },
    }),
  );
  await click("导出设计备份");
  assert.match(host.textContent ?? "", /无法导出设计备份：读取失败/);
  assert.doesNotMatch(host.textContent ?? "", /已导出恢复备份文件/);
  assert.ok(button("重新加载"));
});

test("save copy preserves Web titles and reflects the desktop bridge", async (t) => {
  for (const desktop of [false, true]) {
    const saved = saveStateCopy(true, desktop);
    const saving = saveStateCopy(false, desktop);
    assert.equal(saved.title, desktop ? "已保存到本机" : "已保存到此浏览器");
    assert.equal(saved.tip, saved.title);
    assert.equal(saving.title, "保存中");
    assert.equal(saving.tip, "正在保存…");
    assert.equal(
      saved.desc,
      desktop
        ? "变更已自动保存在本机工作空间，随时可导出 .forma.json 备份"
        : "变更已自动保存在当前浏览器中，换设备前可下载设计源文件",
    );
    assert.equal(saving.desc, saved.desc);
    assert.doesNotMatch(
      JSON.stringify([saved, saving, storageUnavailableCopy(desktop)]),
      /IndexedDB/,
    );
    assert.match(
      storageUnavailableCopy(desktop),
      desktop ? /本机工作空间/ : /当前浏览器/,
    );
  }
  assert.equal(isDesktopRuntime(), false);
  await domTestHost(t);
  assert.deepEqual(saveStateCopy(true), saveStateCopy(true, false));
  Object.assign(window, { formaDesktop: {} });
  assert.equal(isDesktopRuntime(), true);
  assert.deepEqual(saveStateCopy(true), saveStateCopy(true, true));
});

test("FileBrowser shows the platform empty state and preserves the file and project controls", async (t) => {
  await domTestHost(t);
  const noop = () => {};
  const dialog = createElement(FileBrowser, {
    current: createStarter(),
    currentKey: "draft",
    close: noop,
    externalImport: noop,
    renameCurrent: noop,
  });
  for (const desktop of [false, true]) {
    Object.assign(window, { formaDesktop: desktop ? {} : undefined });
    const markup = renderToStaticMarkup(dialog);
    assert.ok(
      markup.includes(
        desktop ? "本机工作空间暂无已保存的设计文件" : "暂无已保存的本机文件",
      ),
    );
    for (const label of [
      "本机文件",
      "关闭本机文件",
      "全部文件",
      "未归类草稿",
    ]) {
      assert.ok(markup.includes(`aria-label="${label}"`), label);
    }
    assert.ok(markup.includes("新建项目空间"));
  }
});

test("frame presets retain the inspector groups and the exact iPhone 16 entry", () => {
  assert.deepEqual(
    UNIFIED_FRAME_PRESET_GROUPS.map(({ label, items }) => [
      label,
      items.length,
    ]),
    [
      ["手机", 5],
      ["平板", 3],
      ["桌面端", 4],
      ["演示文稿", 2],
      ["智能手表", 2],
      ["打印纸张", 2],
      ["社交媒体", 3],
    ],
  );
  assert.deepEqual(UNIFIED_FRAME_PRESET_GROUPS[0].items[0], {
    label: "iPhone 16",
    w: 393,
    h: 852,
  });
});

test("welcome card dispatches four quick actions, dismisses, and leaves the surrounding canvas interactive", async (t) => {
  const { host, render, click, dispatch, button } = await domTestHost(t);
  const props = {
    onCreateFrame:
      t.mock.fn<(label: string, width: number, height: number) => void>(),
    onOpenAi: t.mock.fn(),
    onImportFile: t.mock.fn(),
    onDismiss: t.mock.fn(),
  };
  const canvasPointerDown = t.mock.fn();
  const tree = (visible: boolean) =>
    createElement(
      "main",
      { onPointerDown: canvasPointerDown },
      createElement(CanvasWelcomeOverlay, { ...props, visible }),
    );
  await render(tree(false));
  assert.equal(host.firstChild?.hasChildNodes(), false);
  await render(tree(true));
  const overlay = host.getElementsByTagName("section")[0];
  assert.equal(overlay.getAttribute("aria-label"), "快速开始");
  assert.equal(overlay.getAttribute("role"), "region");
  assert.equal(overlay.getElementsByTagName("button").length, 5);
  const actions = [
    ["移动端画板", "393 × 852 · iPhone 16"],
    ["桌面端画板", "1440 × 900 · Web"],
    ["用 Forma AI 起稿", "⌘↵ 对话生成可编辑画板"],
    ["导入设计文件", ".fig / .sketch / .forma"],
  ];
  for (const [title, detail] of actions) {
    const action = button(title);
    assert.equal(action.getAttribute("class"), "canvas-welcome-action");
    assert.equal(action.getElementsByTagName("small")[0].textContent, detail);
    await dispatch("pointerdown", action);
    await click(title);
  }
  assert.equal(canvasPointerDown.mock.callCount(), 0);
  await dispatch("pointerdown", overlay);
  assert.equal(canvasPointerDown.mock.callCount(), 1);
  assert.deepEqual(
    props.onCreateFrame.mock.calls.map((call) => call.arguments),
    [
      ["iPhone 16", 393, 852],
      ["Desktop 1440×900", 1440, 900],
    ],
  );
  assert.equal(props.onOpenAi.mock.callCount(), 1);
  assert.equal(props.onImportFile.mock.callCount(), 1);
  const links = Array.from(overlay.getElementsByTagName("a"));
  assert.deepEqual(
    links.map((link) => link.getAttribute("href")),
    [
      "?example=aura-showcase",
      "?example=mobile-studio&edition=atlas&page=atlas&node=atlas-tablet-root",
    ],
  );
  for (const link of links) {
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noreferrer");
  }
  await click("收起引导");
  assert.equal(props.onDismiss.mock.callCount(), 1);
  await render(tree(false));
  assert.equal(host.firstChild?.hasChildNodes(), false);
});
