import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { act, createElement as h, Fragment } from "react";
import { ColorField } from "../src/editor/ColorField";
import { PopoverSurfaceContext } from "../src/editor/useAnchoredPopover";
import {
  BrowserDocumentRepository,
  deleteLocalFile,
} from "../src/infrastructure/storage";
import {
  assetStore,
  partStore,
  type LocalSnapshot,
} from "../src/infrastructure/storage-parts";
import { importImageBytes } from "../src/infrastructure/design-import/image";
import {
  createInitialTabsState,
  makeExampleTab,
  openTab,
  serializeTabsState,
  WORKSPACE_TABS_STORAGE_KEY,
} from "../src/application/workspace-tabs";
import { assetHash } from "../src/domain/asset-bytes";
import {
  createLibraryFromSelection,
  instantiateComponent,
} from "../src/domain/library";
import {
  createNode,
  parseDocument,
  type DesignNode,
} from "../src/domain/document";
import { createStarter } from "../src/domain/seed";
import { readContours } from "../src/domain/vector-path";
import { outlineTextNode } from "../src/infrastructure/text-outline";
import { resolveSystemFonts } from "../electron/system-fonts.mjs";
import { useEditor, type EditorController } from "../src/editor/useEditor";

const css = registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (
      context.parentURL?.endsWith("/App.tsx") &&
      result.url.endsWith("/AgentPanel.tsx")
    )
      return { ...result, url: result.url + "?scope-fixture" };
    return result;
  },
  load(url, context, next) {
    // Drive the two AI callbacks at their component boundary without a model gateway.
    if (url.endsWith("?scope-fixture"))
      return {
        format: "module",
        shortCircuit: true,
        source: `export * from "./AgentPanel.tsx";
        import { createElement } from "react";
        export function AgentPanel({ onBusyChange, onProjectScopeChanged }) {
          return createElement("button", { "aria-label": "change scope during generation", onClick() {
            onBusyChange(true, "", "");
            onProjectScopeChanged({ id: "other", name: "Other project" }, "项目已切换");
          } });
        }`,
      };
    return url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context);
  },
});
const { Inspector } = await import("../src/editor/Inspector");
const { App } = await import("../src/editor/App");
const { WorkspaceShell } = await import("../src/editor/WorkspaceShell");
await import("../src/editor/WorkspaceHomeShell");
css.deregister();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// React owns the DOM and event handlers. The fixture supplies focus, geometry,
// observation and browser services that the XML DOM does not implement.
async function mountDom(t: TestContext) {
  const document = new DOMParser().parseFromString("<html/>", "text/html");
  const win = Object.assign(new EventTarget(), {
    document,
    HTMLIFrameElement: class {},
    innerWidth: 1280,
    innerHeight: 800,
    getComputedStyle: (el: HTMLElement) => el.style,
    clearTimeout,
    setTimeout,
    devicePixelRatio: 1,
  });
  const events = new WeakMap<Element, EventTarget>();
  let focused: Element | null = null;
  const descendants = (el: Element) => Array.from(el.getElementsByTagName("*"));
  const rect = {
    x: 100,
    y: 60,
    left: 100,
    top: 60,
    right: 400,
    bottom: 300,
    width: 300,
    height: 240,
  };
  function matches(el: Element, selector: string) {
    if (selector.startsWith("."))
      return el.getAttribute("class")?.split(" ").includes(selector.slice(1));
    const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attr)
      return attr[2] === undefined
        ? el.hasAttribute(attr[1])
        : el.getAttribute(attr[1]) === attr[2];
    return el.tagName === selector.split(":")[0];
  }
  const query = (el: Element, selector: string) =>
    descendants(el).filter((n) =>
      selector.split(",").some((s) => matches(n, s.trim())),
    );
  function decorate(el: Element) {
    const target = new EventTarget();
    events.set(el, target);
    Object.defineProperties(el, {
      isConnected: { get: () => document.documentElement.contains(el) },
      parentElement: { get: () => el.parentNode },
      children: {
        get: () => Array.from(el.childNodes).filter((n) => n.nodeType === 1),
      },
      options: { get: () => el.getElementsByTagName("option") },
    });
    Object.assign(el, {
      style: {
        setProperty() {},
        removeProperty() {},
        getPropertyValue: () => "",
      },
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      value: "",
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
      focus() {
        focused = el;
      },
      select() {},
      setPointerCapture() {},
      getContext: () => null,
      blur() {
        focused = null;
        fire("focusout", el);
      },
      contains(n: Element | null) {
        for (let p = n; p; p = p.parentNode as Element | null)
          if (p === el) return true;
        return false;
      },
      closest(selector: string) {
        for (
          let p: Element | null = el;
          p?.nodeType === 1;
          p = p.parentNode as Element | null
        ) {
          if (selector.split(",").some((s) => matches(p!, s.trim()))) return p;
        }
        return null;
      },
      matches: (selector: string) => matches(el, selector),
      querySelector: (selector: string) => query(el, selector)[0] ?? null,
      querySelectorAll: (selector: string) => query(el, selector),
      getBoundingClientRect: () => rect,
      getClientRects: () => [rect],
    });
    return el;
  }
  decorate(document.documentElement);
  const make = document.createElement.bind(document),
    makeNS = document.createElementNS.bind(document);
  t.mock.method(document, "createElement", (tag: string) =>
    decorate(make(tag)),
  );
  t.mock.method(document, "createElementNS", (ns: string, tag: string) =>
    decorate(makeNS(ns, tag)),
  );
  const body = document.createElement("body"),
    host = document.createElement("main");
  document.documentElement.appendChild(body);
  body.appendChild(host);
  const documentEvents = new EventTarget();
  Object.assign(document, {
    body,
    oninput: null,
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener:
      documentEvents.removeEventListener.bind(documentEvents),
    querySelectorAll: body.querySelectorAll,
    querySelector: body.querySelector,
  });
  Object.defineProperty(document, "activeElement", {
    get: () => (focused?.isConnected ? focused : body),
  });
  function fire(type: string, target: Element, props = {}) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "target", { value: target });
    Object.assign(event, props);
    const toastStage = target
      .closest(".forma-toast-layer")
      ?.closest(".canvas-stage");
    const delegate =
      type === "toggle" || type === "cancel"
        ? target
        : (toastStage ?? (host.contains(target) ? host : body));
    events.get(delegate)!.dispatchEvent(event);
  }
  const storage = new Map<string, string>();
  class Observer {
    observe() {}
    disconnect() {}
  }
  const matchMedia = (): EventTarget & { matches: boolean } =>
    Object.assign(new EventTarget(), { matches: false });
  Object.assign(win, { matchMedia });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    document,
    window: win,
    location: new URL("http://forma.test/?editor=1"),
    history: { replaceState() {}, pushState() {} },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    },
    __FORMA_VERSION__: "test",
    HTMLElement: body.constructor,
    Element: body.constructor,
    Node: body.constructor,
    MutationObserver: Observer,
    ResizeObserver: Observer,
    matchMedia,
    requestAnimationFrame: (): number => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  t.after(async () => {
    try {
      await act(() => root.unmount());
    } finally {
      for (const [key, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  function named(label: string) {
    const el = descendants(body).find(
      (n) => n.getAttribute("aria-label") === label,
    );
    assert.ok(el, label);
    return el as HTMLInputElement;
  }
  return { root, body, document, win, named, fire, host };
}
async function mount(
  t: TestContext,
  nodes: DesignNode[],
  backgroundVisible = true,
) {
  const dom = await mountDom(t);
  const { root, win, fire, named } = dom;
  const initialDocument = {
    ...createStarter(),
    nodes,
    pageBackgroundVisible: backgroundVisible,
  };
  const repository = {
    async load() {
      return null;
    },
    async save() {},
    async backup() {
      return null;
    },
    async recovery() {
      return null;
    },
  };
  let editor!: EditorController;
  function Panel({ active }: { active: boolean }) {
    editor = useEditor({
      active,
      initialDocument,
      initialSelection: nodes.map((n) => n.id),
      repository,
    });
    return h(Inspector, { editor, tabActive: active });
  }
  const setActive = (active: boolean) =>
    act(() => root.render(h(Panel, { active })));
  await setActive(true);
  function blur(name: string, value: string) {
    const el = named(name);
    el.value = value;
    fire("focusout", el);
  }
  function shortcut(key: string) {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { key, shiftKey: true });
    win.dispatchEvent(event);
  }
  return {
    get e() {
      return editor;
    },
    ...dom,
    setActive,
    blur,
    shortcut,
  };
}

test("external proposal survives width, color and direct apply in the same event turn", async (t) => {
  const node = createNode("rectangle");
  const ui = await mount(t, [node]);
  const before = ui.e.committed;
  const proposal = { ...structuredClone(before), name: "External proposal" };
  const expected = structuredClone(proposal);
  await act(() => {
    ui.e.setPreview(proposal);
    ui.blur("宽度", "330");
    ui.blur("填充 HEX", "FF0011");
    assert.equal(
      ui.e.apply([{ type: "update", id: node.id, patch: { name: "local" } }]),
      false,
    );
    assert.equal(ui.e.previewRef.current, proposal);
  });
  assert.ok(ui.e.hasExternalPreview);
  assert.ok(ui.named("宽度").hasAttribute("disabled"));
  assert.ok(ui.named("填充 HEX").hasAttribute("disabled"));
  assert.deepEqual(proposal, expected);
  assert.equal(ui.e.committed, before);
  assert.equal(ui.e.historyRef.current.past.length, 0);
  await act(() => {
    ui.e.setPreview(null);
  });
  assert.equal(ui.e.hasExternalPreview, false);
  await act(() => ui.blur("宽度", "331"));
  assert.equal(ui.e.committed.nodes[0].style.width, 331);
});

test("accessible rename preserves each selected control, including after undo", async (t) => {
  const input = createNode("rectangle"),
    toggle = createNode("rectangle");
  input.control = { kind: "textfield", label: "Email", value: "designer" };
  toggle.control = {
    kind: "switch",
    label: "Alerts",
    value: true,
    disabled: true,
    min: 1,
    max: 8,
    step: 1,
    options: ["a", "b"],
  };
  const ui = await mount(t, [input, toggle]);
  const details = Array.from(ui.body.getElementsByTagName("details")).find(
    (el) => el.getElementsByTagName("summary")[0]?.textContent === "更多属性",
  ) as HTMLDetailsElement;
  assert.ok(details);
  await act(() => {
    details.open = true;
    ui.fire("toggle", details);
  });
  assert.equal(ui.named("可访问名称").getAttribute("placeholder"), "Mixed");
  await act(() => ui.blur("可访问名称", "通知"));
  assert.deepEqual(
    ui.e.committed.nodes.map((n) => n.control),
    [input, toggle].map((n) => ({ ...n.control, label: "通知" })),
  );
  assert.equal(ui.e.historyRef.current.past.length, 1);
  await act(() => ui.e.undo());
  assert.deepEqual(
    ui.e.committed.nodes.map((n) => n.control),
    [input.control, toggle.control],
  );
});

test(
  "macOS system-ui resolves standalone PingFang SC and outlines every starter title glyph",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const doc = createStarter(),
      node = doc.nodes.find((n) => n.text === "让好设计，发生。")!;
    const faces = await resolveSystemFonts({
      fontFamily: "system-ui, sans-serif",
      fontWeight: 400,
      fontStyle: "normal",
      text: node.text,
    });
    assert.deepEqual(
      faces.map((f) => f.family),
      ["PingFang SC"],
    );
    const [face] = faces,
      bytes =
        typeof face.data === "string"
          ? Buffer.from(face.data, "base64")
          : Buffer.from(face.data);
    assert.equal(face.faceIndex, 0);
    assert.ok(bytes.length < 20 * 1024 * 1024);
    assert.equal(
      bytes.readUInt32BE(),
      face.format === "otf" ? 0x4f54544f : 0x10000,
    );
    const count = bytes.readUInt16BE(4),
      exp = Math.floor(Math.log2(count));
    assert.deepEqual(
      [6, 8, 10].map((i) => bytes.readUInt16BE(i)),
      [16 * 2 ** exp, exp, 16 * (count - 2 ** exp)],
    );
    let checksum = 0;
    for (let offset = 0; offset < bytes.length; offset += 4)
      checksum = (checksum + bytes.readUInt32BE(offset)) >>> 0;
    assert.equal(checksum, 0xb1b0afba);
    const hb = await import("harfbuzzjs");
    const font = new hb.Font(new hb.Face(new hb.Blob(bytes), 0));
    assert.deepEqual(
      [...node.text].filter((c) => !font.nominalGlyph(c.codePointAt(0)!)),
      [],
    );
    const { operations } = await outlineTextNode(doc, node.id, {
      resolveSystemFonts: async () => faces,
    });
    const op = operations.find((op) => op.type === "convertToVector");
    assert.ok(op);
    const contours = readContours(op.vector.paths[0].d);
    assert.ok(contours.length >= node.text.length);
    t.diagnostic(
      `PingFang SC: ${bytes.length} bytes, ${contours.length} contours, 0 missing glyphs`,
    );
  },
);

test("80px uniform stroke toggles to four valid 80px sides", async (t) => {
  const n = createNode("rectangle");
  n.style.strokeWidth = 80;
  const ui = await mount(t, [n]);
  await act(() => ui.fire("click", ui.named("独立边描边")));
  assert.deepEqual(parseDocument(ui.e.committed).nodes[0].style.strokeSides, {
    top: 80,
    right: 80,
    bottom: 80,
    left: 80,
  });
  assert.equal(ui.e.error, "");
});
test("editing a hidden page background preserves visibility", async (t) => {
  const ui = await mount(t, [createNode("rectangle")], false);
  await act(() => ui.e.updatePageBackground("#ff0011", 0.4));
  assert.equal(ui.e.committed.pageBackground, "#ff0011");
  assert.equal(ui.e.committed.pageBackgroundOpacity, 0.4);
  assert.equal(ui.e.committed.pageBackgroundVisible, false);
});
test("mixed flip buttons and keyboard shortcuts give identical results on both axes", async (t) => {
  const a = createNode("rectangle"),
    b = createNode("rectangle");
  a.style.flipX = a.style.flipY = true;
  const ui = await mount(t, [a, b]);
  for (const [label, key, prop] of [
    ["水平翻转", "H", "flipX"],
    ["垂直翻转", "V", "flipY"],
  ] as const) {
    await act(() => ui.fire("click", ui.named(label)));
    const clicked = ui.e.committed.nodes.map((n) => n.style[prop]);
    assert.deepEqual(clicked, [true, true]);
    await act(() => ui.e.undo());
    await act(() => ui.shortcut(key));
    assert.deepEqual(
      ui.e.committed.nodes.map((n) => n.style[prop]),
      clicked,
    );
  }
});

test("radius scrub previews and releases the same clamped operation, even across renders", async (t) => {
  const n = createNode("rectangle");
  n.style.radius = 12;
  const ui = await mount(t, [n]);
  const icon = ui.named("圆角").parentNode!.firstChild! as HTMLElement;
  const native = (type: string, x: number) =>
    icon.dispatchEvent(
      Object.assign(new Event(type), { pointerId: 3, clientX: x }),
    );
  await act(() =>
    ui.fire("pointerdown", icon, { button: 0, pointerId: 3, clientX: 120 }),
  );
  await act(() => {
    native("pointermove", 60);
  });
  assert.equal(ui.e.doc.nodes[0].style.radius, 0);
  assert.equal(ui.e.hasExternalPreview, false);
  assert.equal(ui.e.historyRef.current.past.length, 0);
  await act(() => {
    native("pointerup", 60);
  });
  assert.equal(ui.e.previewRef.current, null);
  assert.equal(ui.e.committed.nodes[0].style.radius, 0);
  assert.equal(ui.e.historyRef.current.past.length, 1);
  await act(() => ui.e.undo());
  assert.equal(ui.e.committed.nodes[0].style.radius, 12);
});

test("corner smoothing previews without history, cancels, commits once and yields to an arriving proposal", async (t) => {
  const a = createNode("rectangle"),
    b = createNode("rectangle");
  a.style.radius = b.style.radius = 12;
  a.style.cornerSmoothing = 0.2;
  b.style.cornerSmoothing = 0.5;
  const ui = await mount(t, [a, b]);
  const slider = ui.named("圆角平滑");
  const slide = (percent: string) => {
    slider.value = percent;
    ui.fire("input", slider);
  };
  assert.equal(slider.getAttribute("aria-valuetext"), "Mixed");
  await act(() => slide("30"));
  assert.equal(ui.e.doc.nodes[0].style.cornerSmoothing, 0.3);
  assert.equal(ui.e.hasExternalPreview, false);
  await act(() => ui.fire("pointercancel", slider));
  assert.equal(ui.e.previewRef.current, null);
  assert.equal(ui.e.historyRef.current.past.length, 0);
  await act(() => slide("35"));
  await act(() => slide("40"));
  await act(() => ui.fire("pointerup", slider));
  await act(() => slider.blur());
  assert.equal(ui.e.historyRef.current.past.length, 1);
  assert.deepEqual(
    ui.e.committed.nodes.map((n) => n.style.cornerSmoothing),
    [0.4, 0.4],
  );
  await act(() => slide("70"));
  const proposal = { ...ui.e.committed, name: "Proposal" };
  await act(() => {
    ui.e.setPreview(proposal);
    ui.fire("pointerup", slider);
    ui.fire("pointercancel", slider);
  });
  assert.equal(ui.e.previewRef.current, proposal);
  assert.equal(ui.e.historyRef.current.past.length, 1);
});

test("Field ignores composing Enter, cancels Escape synchronously and commits once on Enter", async (t) => {
  const ui = await mount(t, [createNode("rectangle")]);
  const width = ui.named("宽度");
  width.value = "308";
  await act(() =>
    ui.fire("keydown", width, { key: "Enter", isComposing: true }),
  );
  assert.equal(ui.e.historyRef.current.past.length, 0);
  await act(() => ui.fire("keydown", width, { key: "Escape" }));
  assert.equal(ui.e.historyRef.current.past.length, 0);
  await act(() => ui.fire("focusin", width));
  width.value = "308";
  await act(() => ui.fire("keydown", width, { key: "Enter" }));
  assert.equal(ui.e.committed.nodes[0].style.width, 308);
  assert.equal(ui.e.historyRef.current.past.length, 1);
});

test("minimum width rejects zero and leaves both the saved width and undo stack intact", async (t) => {
  const node = createNode("rectangle");
  node.style.minWidth = 24;
  const ui = await mount(t, [node]);
  const input = ui.named("最小宽度");
  assert.equal(input.min || input.getAttribute("min"), "1");
  Object.defineProperties(input, {
    validity: { get: () => ({ valid: true, badInput: false }) },
    valueAsNumber: { get: () => Number(input.value) },
  });
  await act(() => {
    input.value = "0";
    ui.fire("input", input);
  });
  await act(() => input.blur());
  assert.equal(input.value, "24");
  assert.equal(ui.e.committed.nodes[0].style.minWidth, 24);
  assert.equal(ui.e.error, "");
  assert.equal(ui.e.historyRef.current.past.length, 0);
});

test("P0-1: deactivating the Inspector drops Type Details and queued edits without taking focus", async (t) => {
  const ui = await mount(t, [createNode("text")]);
  const trigger = ui.named("更多文字样式设置");
  trigger.focus();
  await act(() => ui.fire("click", trigger));
  const popup = ui.named("文字详情");
  assert.equal(popup.parentNode, ui.body);
  const align = ui.named("底部对齐");
  // Retain the DOM event callback just as an already queued operation would.
  const key = Object.keys(align).find((k) => k.startsWith("__reactProps$"))!;
  const queued = (Reflect.get(align, key) as { onClick(): void }).onClick;
  const committed = ui.e.committed;
  const nextTab = ui.document.createElement("button");
  ui.body.appendChild(nextTab);
  nextTab.focus();
  await ui.setActive(false);
  assert.equal(popup.isConnected, false);
  assert.equal(ui.document.activeElement, nextTab);
  await act(() => {
    ui.fire("click", align);
    queued();
  });
  assert.equal(ui.e.committed, committed);
  assert.equal(ui.e.historyRef.current.past.length, 0);
  await ui.setActive(true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("P0-1: a retained picker opacity blur cannot edit an inactive or reopened document or focus its hidden trigger", async (t) => {
  const ui = await mount(t, [createNode("rectangle")]);
  const trigger = ui.named("编辑填充颜色");
  trigger.focus();
  await act(() => ui.fire("click", trigger));
  const opacity = ui.named("颜色不透明度百分比");
  const props = Object.keys(opacity).find((key) =>
    key.startsWith("__reactProps$"),
  )!;
  const blur = Reflect.get(opacity, props).onBlur;
  opacity.value = "37";
  const before = ui.e.committed;
  const focus = t.mock.method(trigger, "focus");
  ui.host.setAttribute("hidden", "");
  await ui.setActive(false);
  await act(() => blur({ currentTarget: opacity }));
  assert.equal(focus.mock.callCount(), 0);
  assert.equal(ui.e.committed, before);
  assert.equal(ui.e.historyRef.current.past.length, 0);
  ui.host.removeAttribute("hidden");
  await ui.setActive(true);
  await act(() => ui.fire("click", trigger));
  await act(() => blur({ currentTarget: opacity }));
  assert.equal(ui.e.committed, before);
  assert.equal(ui.e.historyRef.current.past.length, 0);
  const current = ui.named("颜色不透明度百分比");
  await act(() => {
    current.value = "37";
    ui.fire("focusout", current);
  });
  assert.equal(ui.e.historyRef.current.past.length, 1);
});

test("P0-1: ColorField drops its body portal on an inactive surface or zero-sized trigger", async (t) => {
  const ui = await mountDom(t);
  const render = (active: boolean) =>
    act(() =>
      ui.root.render(
        h(
          PopoverSurfaceContext.Provider,
          { value: active },
          h(ColorField, { label: "填充", color: "#112233", onChange() {} }),
        ),
      ),
    );
  await render(true);
  const trigger = ui.named("编辑填充颜色");
  trigger.focus();
  await act(() => ui.fire("click", trigger));
  const popup = ui.named("关闭颜色选择器").closest(".color-popover")!;
  assert.equal(popup.parentNode, ui.body);
  const nextTab = ui.document.createElement("button");
  ui.body.appendChild(nextTab);
  nextTab.focus();
  await render(false);
  assert.equal(ui.document.activeElement, nextTab);
  assert.equal(popup.isConnected, false);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  await render(true);
  await act(() => ui.fire("click", trigger));
  const reopened = ui.named("关闭颜色选择器");
  t.mock.method(trigger, "getBoundingClientRect", () => ({
    width: 0,
    height: 0,
  }));
  await act(() => {
    ui.win.dispatchEvent(new Event("resize"));
  });
  assert.equal(reopened.isConnected, false);
});

test("P0-1: edit history preserves the session and crossing a replacement in either direction advances it", async (t) => {
  const ui = await mount(t, [createNode("rectangle")]);
  const a = ui.e;
  assert.equal(a.documentSession, 1);
  await act(() => a.updatePageBackground("#aabbcc", 1));
  assert.equal(ui.e.documentSession, 1);
  await act(() => {
    ui.e.importDocument(
      { ...ui.e.committed, pageBackground: "#123456" },
      { replacedDocument: true },
    );
    // React has not rendered the replacement yet, but its history is already current.
    a.updatePageBackground("#ff0000", 0.1);
  });
  assert.equal(ui.e.committed.pageBackground, "#123456");
  assert.equal(ui.e.documentSession, 2);
  await act(() => ui.e.undo());
  assert.equal(ui.e.committed.pageBackground, "#aabbcc");
  assert.equal(ui.e.documentSession, 3);
  await act(() => ui.e.redo());
  assert.equal(ui.e.documentSession, 4);
});

for (const mode of [
  "open then cancel import",
  "import then replace",
  "first confirmed import finishes first",
  "import then cancel import",
] as const) {
  test("R4-P0-1 / R5-P1-2: delayed file read during " + mode, async (t) => {
    const ui = await mountDom(t);
    const initialDocument = {
      ...createStarter(),
      nodes: [],
      pageBackground: "#123456",
    };
    const pending = {
      ...initialDocument,
      name: "File B",
      pageBackground: "#bbbbbb",
    };
    const newer = {
      ...initialDocument,
      name: "File C",
      pageBackground: "#cccccc",
    };
    const save = t.mock.method(
      BrowserDocumentRepository.prototype,
      "save",
      async () => {},
    );
    const onOpenFileTab = t.mock.fn();
    await act(() => ui.root.render(h(App, { initialDocument, onOpenFileTab })));
    const input = ui.body.querySelector('[data-testid="design-file-input"]')!;
    const click = t.mock.fn();
    const file = new File([JSON.stringify(pending)], "B.forma.json");
    const gate = deferred<string>();
    const read = t.mock.method(file, "text", () => gate.promise);
    Object.assign(input, { type: "file", files: [file], click });
    const open = Array.from(ui.body.getElementsByTagName("button")).find(
      (b) => b.textContent === "打开设计文件…",
    );
    assert.ok(open);
    const asTab = mode === "open then cancel import";
    await act(() => ui.fire("click", asTab ? open : ui.named("导入设计文件")));
    await act(() => ui.fire("change", input));
    assert.equal(read.mock.callCount(), 1);
    await act(() => ui.fire("click", ui.named("导入设计文件")));
    assert.equal(click.mock.callCount(), 2);
    const cancelled = mode.endsWith("cancel import");
    const cGate = deferred<string>();
    if (cancelled) {
      Object.assign(input, { files: [] });
      await act(() => ui.fire("cancel", input));
    } else {
      const c = new File([JSON.stringify(newer)], "C.forma.json");
      const readC = t.mock.method(c, "text", () => cGate.promise);
      Object.assign(input, { files: [c] });
      await act(() => ui.fire("change", input));
      assert.equal(readC.mock.callCount(), 1);
      if (mode === "import then replace")
        await act(() => cGate.resolve(JSON.stringify(newer)));
    }
    await act(() => gate.resolve(JSON.stringify(pending)));
    if (mode === "first confirmed import finishes first") {
      assert.equal(save.mock.callCount(), 0);
      await act(() => cGate.resolve(JSON.stringify(newer)));
    }
    assert.equal(onOpenFileTab.mock.callCount(), asTab ? 1 : 0);
    assert.equal(save.mock.callCount(), 1);
    const saved = save.mock.calls[0];
    assert.equal(
      saved.arguments[0]?.name,
      cancelled ? pending.name : newer.name,
    );
    if (asTab) {
      const [target] = onOpenFileTab.mock.calls[0].arguments;
      assert.ok(saved.this instanceof BrowserDocumentRepository);
      assert.deepEqual(target, {
        title: pending.name,
        fileKey: saved.this.key,
      });
      assert.match(target.fileKey, /^forma\.file\./);
      assert.equal(saved.arguments[1]?.replacedDocument, undefined);
    } else assert.equal(saved.arguments[1]?.replacedDocument, true);
    await act(() => ui.fire("click", ui.named("编辑页面背景色颜色")));
    assert.equal(
      ui.named("页面背景色 HEX").value,
      asTab ? "123456" : cancelled ? "BBBBBB" : "CCCCCC",
    );
  });
}

for (const change of ["recovery", "tab reactivation"] as const) {
  test(
    "R5-P0-1: import chooser returns after " +
      change +
      " without reading or overwriting",
    async (t) => {
      const ui = await mountDom(t);
      const initialDocument = {
        ...createStarter(),
        nodes: [],
        pageBackground: "#aaaaaa",
      };
      const restored = {
        ...initialDocument,
        name: "Restored",
        pageBackground: "#bbbbbb",
      };
      const c = new File(
        [JSON.stringify({ ...initialDocument, name: "C" })],
        "C.forma.json",
      );
      const slice = t.mock.method(c, "slice"),
        read = t.mock.method(c, "text");
      const gate = deferred<typeof restored>();
      const recovery = t.mock.method(
        BrowserDocumentRepository.prototype,
        "recovery",
        () => gate.promise,
      );
      const save = t.mock.method(
        BrowserDocumentRepository.prototype,
        "save",
        async () => {},
      );
      const render = (tabActive: boolean) =>
        act(() => ui.root.render(h(App, { initialDocument, tabActive })));
      await render(true);
      const input = ui.body.querySelector('[data-testid="design-file-input"]')!;
      const click = t.mock.fn();
      Object.assign(input, { type: "file", files: [c], click });
      if (change === "recovery") {
        const restore = Array.from(ui.body.getElementsByTagName("button")).find(
          (b) => b.textContent === "恢复上次保存版本",
        );
        assert.ok(restore);
        await act(() => ui.fire("click", restore));
        assert.equal(recovery.mock.callCount(), 1);
      }
      await act(() => ui.fire("click", ui.named("导入设计文件")));
      assert.equal(click.mock.callCount(), 1);
      if (change === "recovery") await act(() => gate.resolve(restored));
      else {
        await render(false);
        await render(true);
      }
      await act(() => ui.fire("change", input));
      assert.equal(
        slice.mock.callCount(),
        0,
        "even format detection must skip stale files",
      );
      assert.equal(read.mock.callCount(), 0);
      assert.deepEqual(
        save.mock.calls.map((call) => call.arguments[0]?.name),
        change === "recovery" ? ["Restored"] : [],
      );
      await act(() => ui.fire("click", ui.named("编辑页面背景色颜色")));
      assert.equal(
        ui.named("页面背景色 HEX").value,
        change === "recovery" ? "BBBBBB" : "AAAAAA",
      );
    },
  );
}

test("R6 recovery guard keeps imported C saved when A's pending restore finishes", async (t) => {
  const ui = await mountDom(t);
  const initialDocument = {
    ...createStarter(),
    name: "A",
    nodes: [],
    pageBackground: "#aaaaaa",
  };
  const imported = { ...initialDocument, name: "C", pageBackground: "#cccccc" };
  const gate = deferred<typeof initialDocument>();
  const recovery = t.mock.method(
    BrowserDocumentRepository.prototype,
    "recovery",
    () => gate.promise,
  );
  const save = t.mock.method(
    BrowserDocumentRepository.prototype,
    "save",
    async () => {},
  );
  await act(() => ui.root.render(h(App, { initialDocument })));
  const restore = Array.from(ui.body.getElementsByTagName("button")).find(
    (button) => button.textContent === "恢复上次保存版本",
  );
  assert.ok(restore);
  await act(() => ui.fire("click", restore));
  assert.equal(recovery.mock.callCount(), 1);
  const input = ui.body.querySelector('[data-testid="design-file-input"]')!;
  Object.assign(input, {
    type: "file",
    click() {},
    files: [new File([JSON.stringify(imported)], "C.forma.json")],
  });
  await act(() => ui.fire("click", ui.named("导入设计文件")));
  await act(() => ui.fire("change", input));
  assert.equal(save.mock.callCount(), 0);
  await act(() => gate.resolve({ ...initialDocument, name: "Recovered A" }));
  assert.equal(save.mock.callCount(), 1);
  assert.equal(save.mock.calls[0].arguments[0]?.name, "C");
  assert.equal(save.mock.calls[0].arguments[1]?.replacedDocument, true);
  await act(() => ui.fire("click", ui.named("编辑页面背景色颜色")));
  assert.equal(ui.named("页面背景色 HEX").value, "CCCCCC");
});

test("R4-P1-1: Flatten and Detach each commit once after a same-ID replacement", async (t) => {
  const group = createNode("group");
  group.booleanOperation = "union";
  const left = createNode("rectangle", group.id),
    right = createNode("rectangle", group.id);
  right.style.x = 10;
  const frame = createNode("frame");
  const ui = await mount(t, [
    group,
    left,
    right,
    frame,
    createNode("text", frame.id),
  ]);
  const library = createLibraryFromSelection(ui.e.committed, frame.id, "Label");
  const component = library.components[0];
  const instance = instantiateComponent(
    ui.e.committed,
    library,
    component.id,
    component.variants[0].id,
    null,
    { x: 30, y: 40 },
  );
  await act(() => {
    ui.e.apply(instance.operations);
  });
  const child = ui.e.committed.nodes.find((n) => n.parentId === instance.id)!;
  assert.ok(child.templateKey);
  await act(() =>
    ui.e.importDocument(structuredClone(ui.e.committed), {
      replacedDocument: true,
    }),
  );
  assert.equal(ui.e.documentSession, 2);
  for (const [id, key] of [
    [group.id, "e"],
    [instance.id, "b"],
  ]) {
    await act(() => ui.e.setSelection([id]));
    const before = ui.e.historyRef.current.past.length;
    const event = Object.assign(new Event("keydown", { cancelable: true }), {
      key,
      metaKey: true,
      altKey: key === "b",
    });
    await act(() => {
      ui.win.dispatchEvent(event);
    });
    assert.ok(event.defaultPrevented);
    assert.equal(ui.e.historyRef.current.past.length, before + 1);
    const layer = ui.e.committed.nodes.find((n) => n.id === id)!;
    if (key === "e") {
      assert.equal(layer.type, "vector");
      assert.ok(layer.vector?.paths.length);
      assert.equal(layer.booleanOperation, undefined);
      assert.ok(!ui.e.committed.nodes.some((n) => n.parentId === group.id));
    } else {
      assert.equal(layer.instance, undefined);
      const label = ui.e.committed.nodes.find((n) => n.id === child.id)!;
      assert.equal(label.parentId, id);
      assert.equal(label.templateKey, undefined);
    }
  }
});

test("P0-1: recovering the same snapshot after a failed load starts a fresh session with empty history", async (t) => {
  const ui = await mountDom(t);
  const initialDocument = createStarter();
  t.mock.method(
    BrowserDocumentRepository.prototype,
    "recovery",
    async () => initialDocument,
  );
  t.mock.method(BrowserDocumentRepository.prototype, "save", async () => {});
  let editor!: EditorController;
  function Probe() {
    editor = useEditor({ initialDocument, loadError: "Load failed" });
    return null;
  }
  await act(() => ui.root.render(h(Probe)));
  assert.equal(editor.documentSession, 1);
  await act(() => editor.recoverPrevious());
  assert.equal(editor.documentSession, 2);
  assert.equal(editor.historyRef.current.past.length, 0);
  assert.equal(editor.error, "");
});

// Exercise the real repository's read / generation check / atomic write. Delay
// one documents.get request before delivering its result to recovery().
function recoveryDatabase(t: TestContext, fileKey: string, record: unknown) {
  const documents = new Map<string, unknown>([[fileKey, record]]);
  const files = new Map<string, unknown>();
  const parts = new Map<string, unknown>(),
    assets = new Map<string, unknown>();
  const stores = new Map([
    ["documents", documents],
    ["files", files],
    [partStore, parts],
    [assetStore, assets],
  ]);
  type Key = string | (string | number)[];
  type Range = { lower: (string | number)[] };
  const keyOf = (key: Key) =>
    typeof key === "string" ? key : JSON.stringify(key);
  const rangeKeys = (rows: Map<string, unknown>, { lower }: Range) =>
    [...rows.keys()]
      .map((key) => JSON.parse(key) as (string | number)[])
      .filter((key) => lower.every((v, i) => key[i] === v))
      .sort((a, b) => Number(a[2]) - Number(b[2]));
  const started = deferred<void>(),
    release = deferred<void>();
  let hold = false;
  let activeWrites = 0;
  let assetWriteTransactions = 0;
  function request<T>(result: T, delay = false) {
    const req = { result: structuredClone(result), onsuccess() {} };
    if (delay) {
      started.resolve();
      void release.promise.then(() => req.onsuccess());
    } else queueMicrotask(() => req.onsuccess());
    return req;
  }
  const db = {
    onclose() {},
    transaction(names: string | string[], mode?: string) {
      // Key scans see this transaction's pending deletes and puts, including new chunks.
      const staged = new Map(
        (Array.isArray(names) ? names : [names]).map((name) => [
          name,
          new Map(stores.get(name)!),
        ]),
      );
      const writes: (() => void)[] = [];
      let aborted = false;
      const tx = {
        oncomplete() {},
        onabort() {},
        abort() {
          aborted = true;
        },
        objectStore(name: string) {
          const rows = staged.get(name)!;
          const committed = stores.get(name)!;
          return {
            get(key: Key) {
              const delay =
                hold && name === "documents" && key === fileKey && !mode;
              if (delay) hold = false;
              return request(rows.get(keyOf(key)), delay);
            },
            getKey(key: Key) {
              return request(rows.has(keyOf(key)) ? key : undefined);
            },
            getAllKeys(range: Range) {
              return request(rangeKeys(rows, range));
            },
            put(value: unknown, key: Key = (value as { key: string }).key) {
              const id = keyOf(key),
                copy = structuredClone(value);
              rows.set(id, copy);
              writes.push(() => committed.set(id, copy));
              return request(key);
            },
            delete(key: Key | Range) {
              const keys =
                typeof key === "object" && "lower" in key
                  ? rangeKeys(rows, key)
                  : [key];
              for (const k of keys) {
                const id = keyOf(k);
                rows.delete(id);
                writes.push(() => committed.delete(id));
              }
              return request(undefined);
            },
            openCursor(range: Range) {
              const keys = rangeKeys(rows, range)[Symbol.iterator]();
              const cursor = {
                result: null as {
                  key: Key;
                  value: unknown;
                  continue(): void;
                } | null,
                onsuccess() {},
              };
              function visit() {
                const next = keys.next();
                cursor.result = next.done
                  ? null
                  : {
                      key: next.value,
                      value: structuredClone(rows.get(keyOf(next.value))),
                      continue: () => queueMicrotask(visit),
                    };
                cursor.onsuccess();
              }
              queueMicrotask(visit);
              return cursor;
            },
          };
        },
      };
      if (mode === "readwrite") {
        activeWrites++;
        if (names.includes(assetStore)) assetWriteTransactions++;
        setImmediate(() => {
          activeWrites--;
          if (aborted) tx.onabort();
          else {
            for (const write of writes) write();
            tx.oncomplete();
          }
        });
      }
      return tx;
    },
  };
  const originalRange = Object.getOwnPropertyDescriptor(
    globalThis,
    "IDBKeyRange",
  );
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: { bound: (lower: Range["lower"]) => ({ lower }) },
  });
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open(name: string) {
        if (name !== "forma-studio")
          throw new DOMException("unavailable", "SecurityError");
        const req = { result: db, onsuccess() {} };
        queueMicrotask(() => req.onsuccess());
        return req;
      },
    },
  });
  t.after(() => {
    release.resolve();
    db.onclose();
    if (originalRange)
      Object.defineProperty(globalThis, "IDBKeyRange", originalRange);
    else Reflect.deleteProperty(globalThis, "IDBKeyRange");
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  });
  return {
    get activeWrites() {
      return activeWrites;
    },
    get assetWriteTransactions() {
      return assetWriteTransactions;
    },
    holdRead() {
      hold = true;
    },
    started: started.promise,
    release,
    documents,
    assets,
    parts,
  };
}

function corruptSnapshot(previous: ReturnType<typeof createStarter>) {
  return {
    generation: 7,
    lifetimeToken: "file-lifetime",
    replacementEpoch: 3,
    current: { id: previous.id, nodes: false },
    previous,
  };
}

test("R9 immediate import after a failed load saves generation 8 and keeps readable backup A", async (t) => {
  const ui = await mountDom(t);
  const previous = { ...createStarter(), name: "Readable A" };
  const record = corruptSnapshot(previous);
  const fileKey = "immediate-import";
  const database = recoveryDatabase(t, fileKey, record);
  const repository = new BrowserDocumentRepository(fileKey);
  let loadError = "";
  await assert.rejects(repository.load(), (err: Error) => {
    loadError = err.message;
    return !!loadError;
  });
  await assert.rejects(repository.save(previous), {
    message: "当前设计快照无法读取，请从文件菜单恢复上个版本",
  });
  assert.deepEqual(database.documents.get(fileKey), record);
  let editor!: EditorController;
  function Probe() {
    editor = useEditor({ repository, initialDocument: previous, loadError });
    return null;
  }
  await act(() => ui.root.render(h(Probe)));
  assert.equal(editor.protectCache, true);
  const imported = { ...previous, name: "C" };
  await act(() => editor.importDocument(imported, { replacedDocument: true }));
  await act(() => editor.flushSave());
  assert.equal(editor.protectCache, false);
  assert.equal(editor.saved, true);
  assert.equal(editor.error, "");
  assert.equal(editor.committed.name, "C");
  const current = editor.committed;
  assert.deepEqual(database.documents.get(fileKey), {
    ...record,
    current,
    generation: 8,
    replacementEpoch: 4,
  });
  await act(() => ui.root.render(null));
  const reopened = new BrowserDocumentRepository(fileKey);
  assert.deepEqual(await reopened.load(), current);
  assert.deepEqual(await reopened.recovery(), previous);
  await repository.save({ ...current, name: "Edited C" });
  assert.deepEqual(database.documents.get(fileKey), {
    ...record,
    current: { ...current, name: "Edited C" },
    previous: current,
    generation: 9,
    replacementEpoch: 4,
  });
});

async function partitionedGenerations(
  t: TestContext,
  key: string,
  sharedImage: boolean,
) {
  const initial = createStarter();
  const db = recoveryDatabase(t, key, {
    generation: 5,
    lifetimeToken: "original",
    current: initial,
  });
  const writer = new BrowserDocumentRepository(key);
  await writer.load();
  const { id, image } = await importImageBytes(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+C9asAAAAASUVORK5CYII=",
      "base64",
    ),
    "1px",
  );
  const doc = parseDocument({
    ...initial,
    name: "A",
    images: { [id]: image },
    importReport: {
      version: 1,
      format: "Sketch",
      filename: "test.sketch",
      sha256: "a".repeat(64),
      sourceNodes: 1,
      issues: Array(2001).fill({ node: "layer", detail: "issue" }),
    },
  });
  await writer.save(doc);
  const current = { ...doc, name: "B", images: sharedImage ? doc.images : {} };
  await writer.save(current);
  const before = db.documents.get(key) as {
    generation: number;
    current: LocalSnapshot;
    previous: LocalSnapshot;
  };
  assert.equal(before.previous.generation, 6);
  assert.equal(before.current.generation, 7);
  assert.deepEqual(before.previous.assets, [id]);
  assert.deepEqual(before.current.assets, sharedImage ? [id] : []);
  return { db, doc, current, before, id, image };
}

function movePartition(
  parts: Map<string, unknown>,
  key: string,
  snapshot: LocalSnapshot,
  generation: number,
): LocalSnapshot {
  for (let i = 0; i < snapshot.chunks; i++) {
    const from = JSON.stringify([key, snapshot.generation, i]);
    parts.set(JSON.stringify([key, generation, i]), parts.get(from));
    assert.ok(parts.delete(from));
  }
  return { ...snapshot, generation };
}

test("R10 replacing partitioned generation 7 restores the lost image shared with generation 6", async (t) => {
  const key = "missing-shared-asset";
  const { db, doc, id, image } = await partitionedGenerations(t, key, true);
  const assetKey = JSON.stringify([key, id]);
  assert.equal(db.assets.delete(assetKey), true);
  const repository = new BrowserDocumentRepository(key);
  await assert.rejects(repository.load(), /缺少资源/);
  const imported = { ...doc, name: "C" };
  await repository.save(imported, { replacedDocument: true });
  assert.equal((db.documents.get(key) as { generation: number }).generation, 8);
  assert.equal(db.assets.get(assetKey), image.data);
  const reopened = new BrowserDocumentRepository(key);
  assert.deepEqual(await reopened.load(), imported);
  assert.deepEqual(await reopened.recovery(), doc);
});

for (const replacedDocument of [false, true]) {
  test(`R11 ${replacedDocument ? "import" : "save"} restores incoming bytes missing from the generation 6 backup`, async (t) => {
    const key = "missing-backup-image";
    const { db, doc, current, id, image } = await partitionedGenerations(
      t,
      key,
      false,
    );
    const assetKey = JSON.stringify([key, id]);
    assert.ok(db.assets.delete(assetKey));
    const repository = new BrowserDocumentRepository(key);
    assert.deepEqual(await repository.load(), current);
    const imported = { ...doc, name: "C" };
    await repository.save(imported, { replacedDocument });
    assert.equal(
      (db.documents.get(key) as { generation: number }).generation,
      8,
    );
    assert.equal(db.assets.get(assetKey), image.data);
    const reopened = new BrowserDocumentRepository(key);
    assert.deepEqual(await reopened.load(), imported);
    assert.deepEqual(await reopened.recovery(), current);
  });
}

for (const [label, corrupt, replacedDocument] of [
  ["import", null, true],
  ["save", "different bytes", false],
] as const) {
  test(`R12 ${label} replaces corrupt stored asset bytes before reopening`, async (t) => {
    const key = "corrupt-stored-image";
    const { db, doc, current, id, image } = await partitionedGenerations(
      t,
      key,
      false,
    );
    const assetKey = JSON.stringify([key, id]);
    db.assets.set(assetKey, corrupt);
    const repository = new BrowserDocumentRepository(key);
    assert.deepEqual(await repository.load(), current);
    const imported = { ...doc, name: "C" };
    await repository.save(imported, { replacedDocument });
    assert.equal(db.assets.get(assetKey), image.data);
    const reopened = new BrowserDocumentRepository(key);
    assert.deepEqual(await reopened.load(), imported);
    assert.deepEqual(await reopened.recovery(), current);
  });
}

test("R12 saving with outer generation 6 preserves readable partition 7 for rollback", async (t) => {
  const key = "lagging-generation";
  const { db, current, before } = await partitionedGenerations(t, key, true);
  db.documents.set(key, { ...before, generation: 6 });
  const repository = new BrowserDocumentRepository(key);
  assert.deepEqual(await repository.load(), current);
  const saved = { ...current, name: "C" };
  await repository.save(saved);
  const after = db.documents.get(key) as typeof before & { generation: number };
  assert.equal(after.generation, 8);
  assert.equal(after.current.generation, 8);
  assert.equal(after.previous.generation, 7);
  const reopened = new BrowserDocumentRepository(key);
  assert.deepEqual(await reopened.load(), saved);
  assert.deepEqual(await reopened.recovery(), current);
  await repository.save({ ...saved, name: "D" });
  assert.equal((db.documents.get(key) as typeof after).generation, 9);
});

for (const baseline of [6, 8]) {
  test(`R14 outer ${baseline}, current 8 and backup 9 advance to 10 and reject a stale writer from 7`, async (t) => {
    const key = "shorter-partition";
    const { db, current, before } = await partitionedGenerations(t, key, true);
    const report = current.importReport!;
    const backup = {
      ...current,
      name: "large backup",
      importReport: { ...report, issues: [...report.issues, ...report.issues] },
    };
    const stale = new BrowserDocumentRepository(key);
    await stale.load();
    const writer = new BrowserDocumentRepository(key);
    await writer.load();
    await writer.save(current);
    await writer.save(backup);
    const record = db.documents.get(key) as typeof before;
    assert.equal(record.previous.generation, 8);
    assert.equal(record.current.generation, 9);
    assert.equal(record.current.chunks, 33);
    db.documents.set(key, {
      ...record,
      generation: baseline,
      current: record.previous,
      previous: record.current,
    });

    const repository = new BrowserDocumentRepository(key);
    assert.deepEqual(await repository.load(), current);
    assert.deepEqual(await repository.recovery(), backup);
    db.parts.set(JSON.stringify([key, 4, 0]), ["orphan"]);
    db.parts.set(JSON.stringify([key, 10, 40]), ["stale tail"]);
    const saved = { ...current, name: "C" };
    await repository.save(saved);
    const reopened = new BrowserDocumentRepository(key);
    assert.deepEqual(await reopened.load(), saved);
    assert.deepEqual(await reopened.recovery(), current);
    const after = db.documents.get(key) as typeof before;
    assert.equal(after.generation, 10);
    assert.equal(after.current.generation, after.generation);
    assert.equal(after.current.chunks, 17);
    assert.equal(after.previous.generation, 8);
    assert.equal(db.parts.size, after.current.chunks + after.previous.chunks);
    await assert.rejects(stale.save(current), /另一个标签页更新/);
    assert.deepEqual(await reopened.load(), saved);
  });
}

test("R14 two inline saves after outer 6, current 8 and backup 7 release every chunk for this file", async (t) => {
  const key = "inline-after-partitions";
  const { db, current, before } = await partitionedGenerations(t, key, true);
  const writer = new BrowserDocumentRepository(key);
  await writer.load();
  await writer.save(current);
  const record = db.documents.get(key) as typeof before;
  assert.equal(record.current.generation, 8);
  assert.equal(record.previous.generation, 7);
  assert.equal(db.parts.size, 34);
  db.documents.set(key, { ...record, generation: 6 });
  const other = JSON.stringify([key + "-other", 7, 0]);
  db.parts.set(other, ["another file"]);
  db.parts.set(JSON.stringify([key, 3, 0]), ["orphan"]);

  const repository = new BrowserDocumentRepository(key);
  assert.deepEqual(await repository.load(), current);
  const inline = createStarter();
  await repository.save(inline);
  assert.equal(db.parts.size, record.current.chunks + 1);
  const reopened = new BrowserDocumentRepository(key);
  assert.deepEqual(await reopened.load(), inline);
  assert.deepEqual(await reopened.recovery(), current);

  const final = { ...inline, name: "Second inline save" };
  await repository.save(final);
  assert.deepEqual([...db.parts], [[other, ["another file"]]]);
  assert.deepEqual(await reopened.load(), final);
  assert.deepEqual(await reopened.recovery(), inline);
});

for (const claim of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1]) {
  test(`R13 recovery ignores corrupt generation ${claim} and subsequent saves advance normally`, async (t) => {
    const key = "corrupt-current-generation";
    const { db, doc, before } = await partitionedGenerations(t, key, true);
    db.documents.set(key, {
      ...before,
      current: { ...before.current, generation: claim },
    });
    const repository = new BrowserDocumentRepository(key);
    await assert.rejects(repository.load(), /分片缺失/);
    const recovered = await repository.recovery();
    assert.deepEqual(recovered, doc);
    await repository.save(recovered);
    const after = db.documents.get(key) as typeof before;
    assert.equal(after.generation, 8);
    assert.equal(after.current.generation, 8);
    assert.equal(after.previous.generation, 6);
    const reopened = new BrowserDocumentRepository(key);
    assert.deepEqual(await reopened.load(), doc);
    assert.deepEqual(await reopened.recovery(), doc);

    const saved = { ...doc, name: "D" };
    await repository.save(saved);
    const final = db.documents.get(key) as typeof before;
    assert.equal(final.generation, 9);
    assert.equal(final.current.generation, 9);
    assert.equal(final.previous.generation, 8);
    const latest = new BrowserDocumentRepository(key);
    assert.deepEqual(await latest.load(), saved);
    assert.deepEqual(await latest.recovery(), doc);
  });
}

test("R14 the last safe generation can be saved and reopened, then rejects both saves and replacements atomically", async (t) => {
  const key = "exhausted-generation";
  const { db, current, before } = await partitionedGenerations(t, key, true);
  db.documents.set(key, { ...before, generation: Number.MAX_SAFE_INTEGER - 1 });
  const writer = new BrowserDocumentRepository(key);
  await writer.load();
  const saved = { ...current, name: "C" };
  await writer.save(saved);
  const high = db.documents.get(key) as typeof before;
  assert.equal(high.generation, Number.MAX_SAFE_INTEGER);
  assert.equal(high.current.generation, high.generation);
  const original = structuredClone([db.documents, db.parts, db.assets]);
  const reopened = new BrowserDocumentRepository(key);
  assert.deepEqual(await reopened.load(), saved);
  for (const replacedDocument of [false, true]) {
    await assert.rejects(reopened.save(current, { replacedDocument }), {
      message: "当前文件保存次数已达存储上限，请先导出 .forma 备份并新建文件",
    });
    assert.deepEqual([db.documents, db.parts, db.assets], original);
  }
  assert.deepEqual(await reopened.load(), saved);
  assert.deepEqual(await reopened.recovery(), current);
});

for (const generation of [8, 7]) {
  test(`R11 a backup header claiming generation ${generation} preserves both live partitions`, async (t) => {
    const key = "aliased-backup";
    const { db, doc, current, before } = await partitionedGenerations(
      t,
      key,
      true,
    );
    before.previous.generation = generation;
    const repository = new BrowserDocumentRepository(key);
    assert.deepEqual(await repository.load(), current);
    const imported = { ...doc, name: "C" };
    await repository.save(imported);
    const after = db.documents.get(key) as typeof before;
    assert.equal(after.current.generation, 8);
    assert.equal(after.previous.generation, 7);
    const reopened = new BrowserDocumentRepository(key);
    assert.deepEqual(await reopened.load(), imported);
    assert.deepEqual(await reopened.recovery(), current);
  });
}

test("R11 replacement after a failed read tolerates a non-array backup asset list", async (t) => {
  const key = "malformed-backup";
  const { db, doc, before } = await partitionedGenerations(t, key, true);
  before.current.chunks++;
  Object.assign(before.previous, { assets: {} });
  const repository = new BrowserDocumentRepository(key);
  await assert.rejects(repository.load(), /分片缺失/);
  const imported = { ...doc, name: "C" };
  await repository.save(imported, { replacedDocument: true });
  assert.equal((db.documents.get(key) as typeof before).current.generation, 8);
  assert.deepEqual(await new BrowserDocumentRepository(key).load(), imported);
});

for (const position of ["current", "previous"] as const) {
  test(`R15 readable ${position} at MAX with outer generation 6 rejects atomically`, async (t) => {
    const key = "readable-generation-limit";
    const { db, doc, current, before } = await partitionedGenerations(
      t,
      key,
      false,
    );
    const stale = new BrowserDocumentRepository(key);
    assert.deepEqual(await stale.load(), current);
    const max = movePartition(
      db.parts,
      key,
      before.current,
      Number.MAX_SAFE_INTEGER,
    );
    const maxIsCurrent = position === "current";
    db.documents.set(key, {
      ...before,
      generation: 6,
      current: maxIsCurrent ? max : before.previous,
      previous: maxIsCurrent ? before.previous : max,
    });
    const original = structuredClone([db.documents, db.parts, db.assets]);
    const repository = new BrowserDocumentRepository(key);
    assert.deepEqual(await repository.load(), maxIsCurrent ? current : doc);
    await assert.rejects(repository.save({ ...current, name: "Fresh edit" }), {
      message: "当前文件保存次数已达存储上限，请先导出 .forma 备份并新建文件",
    });
    assert.deepEqual([db.documents, db.parts, db.assets], original);
    await assert.rejects(stale.save(current), /另一个标签页更新/);
    assert.deepEqual([db.documents, db.parts, db.assets], original);
    const reopened = new BrowserDocumentRepository(key);
    assert.deepEqual(await reopened.load(), maxIsCurrent ? current : doc);
    assert.deepEqual(await reopened.recovery(), maxIsCurrent ? doc : current);
  });
}

for (const fault of ["missing chunk", "missing asset", "invalid document"]) {
  test(`R15 ignores a backup at MAX - 1 during consecutive saves (${fault})`, async (t) => {
    const key = "unreadable-high-backup";
    const { db, current, before, id } = await partitionedGenerations(
      t,
      key,
      false,
    );
    const claim = Number.MAX_SAFE_INTEGER - 1;
    before.previous = movePartition(db.parts, key, before.previous, claim);
    if (fault === "missing chunk") {
      assert.ok(
        db.parts.delete(
          JSON.stringify([key, claim, before.previous.chunks - 1]),
        ),
      );
    } else if (fault === "missing asset") {
      assert.ok(db.assets.delete(JSON.stringify([key, id])));
    } else {
      const [header] = db.parts.get(JSON.stringify([key, claim, 0])) as {
        document: { name: string };
      }[];
      header.document.name = "";
    }
    const repository = new BrowserDocumentRepository(key);
    assert.deepEqual(await repository.load(), current);
    await assert.rejects(repository.recovery());
    const first = { ...current, name: "First edit" };
    await repository.save(first);
    const after = db.documents.get(key) as typeof before;
    assert.equal(after.generation, 8);
    assert.equal(after.current.generation, 8);
    assert.deepEqual(after.previous, before.current);
    assert.equal(db.parts.size, after.current.chunks + after.previous.chunks);
    const reopened = new BrowserDocumentRepository(key);
    assert.deepEqual(await reopened.load(), first);
    assert.deepEqual(await reopened.recovery(), current);

    const second = { ...first, name: "Second edit" };
    await repository.save(second);
    const final = db.documents.get(key) as typeof before;
    assert.equal(final.generation, 9);
    assert.equal(final.current.generation, 9);
    assert.deepEqual(final.previous, after.current);
    assert.deepEqual(await reopened.load(), second);
    assert.deepEqual(await reopened.recovery(), first);
  });
}

test("R16 recovery before load respects a readable MAX current and blocks a stale generation-7 writer", async (t) => {
  const key = "recover-before-load-at-limit";
  const { db, doc, current, before } = await partitionedGenerations(
    t,
    key,
    true,
  );
  const stale = new BrowserDocumentRepository(key);
  assert.deepEqual(await stale.load(), current);
  const max = movePartition(
    db.parts,
    key,
    before.current,
    Number.MAX_SAFE_INTEGER,
  );
  db.documents.set(key, { ...before, generation: 6, current: max });
  const original = structuredClone([db.documents, db.parts, db.assets]);

  const repository = new BrowserDocumentRepository(key);
  const recovered = await repository.recovery();
  assert.deepEqual(recovered, doc);
  await assert.rejects(repository.save(recovered), {
    message: "当前文件保存次数已达存储上限，请先导出 .forma 备份并新建文件",
  });
  assert.deepEqual([db.documents, db.parts, db.assets], original);
  await assert.rejects(stale.save(current), /另一个标签页更新/);
  assert.deepEqual([db.documents, db.parts, db.assets], original);
  const reopened = new BrowserDocumentRepository(key);
  assert.deepEqual(await reopened.load(), current);
  assert.deepEqual(await reopened.recovery(), doc);
});

const secondPng =
  "iVBORw0KGgoAAAANSUhEUgAAAA0AAAAHCAIAAABcElBNAAAAFUlEQVR4nGP0MFRkIAIwEaNoGKkDALAjAKhevskuAAAAAElFTkSuQmCC";

test("R16 incoming bytes cannot make a discarded MAX snapshot readable", async (t) => {
  const key = "discarded-max-with-missing-image";
  const { db, doc, current, before, id } = await partitionedGenerations(
    t,
    key,
    true,
  );
  const max = movePartition(
    db.parts,
    key,
    before.current,
    Number.MAX_SAFE_INTEGER,
  );
  db.documents.set(key, { ...before, generation: 6, current: max });
  assert.ok(db.assets.delete(JSON.stringify([key, id])));
  const repo = new BrowserDocumentRepository(key);
  await assert.rejects(repo.load(), /缺少资源/);
  await repo.save(current, { replacedDocument: true });
  const saved = db.documents.get(key) as typeof before;
  assert.equal(saved.generation, 7);
  assert.deepEqual(saved.previous, before.previous);
  const reopened = new BrowserDocumentRepository(key);
  assert.deepEqual(await reopened.load(), current);
  assert.deepEqual(await reopened.recovery(), doc);
});

test("R16 hashes outside the write transaction and rechecks swapped bytes before assigning a generation", async (t) => {
  const key = "swapped-backup-image";
  const { db, current, before, id } = await partitionedGenerations(
    t,
    key,
    false,
  );
  before.previous = movePartition(
    db.parts,
    key,
    before.previous,
    Number.MAX_SAFE_INTEGER - 1,
  );
  const repo = new BrowserDocumentRepository(key);
  await repo.load();
  const activeDuringHash: number[] = [];
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(
    crypto.subtle,
    "digest",
    async (...args: Parameters<typeof digest>) => {
      activeDuringHash.push(db.activeWrites);
      if (activeDuringHash.length === 1)
        db.assets.set(JSON.stringify([key, id]), "data:image/png;base64,AAAA");
      return digest(...args);
    },
  );
  await repo.save(current);
  assert.deepEqual(activeDuringHash, [0, 0]);
  assert.equal((db.documents.get(key) as typeof before).generation, 8);
  await repo.save(current);
  assert.deepEqual(activeDuringHash, [0, 0]);
  assert.equal((db.documents.get(key) as typeof before).generation, 9);
});

test("R17 a single save repairs the retained image and prunes the corrupt MAX - 1 backup sharing its ID", async (t) => {
  const key = "corrupt-shared-backup-image";
  const { db, current, before, id, image } = await partitionedGenerations(
    t,
    key,
    true,
  );
  const backup = movePartition(
    db.parts,
    key,
    before.previous,
    Number.MAX_SAFE_INTEGER - 1,
  );
  db.documents.set(key, { ...before, generation: 6, previous: backup });
  const repo = new BrowserDocumentRepository(key);
  assert.deepEqual(await repo.load(), current);
  const assetKey = JSON.stringify([key, id]);
  db.assets.set(assetKey, "data:image/png;base64,AAAA");

  const first = { ...current, name: "First edit" };
  const writes = db.assetWriteTransactions;
  await repo.save(first);
  assert.equal(db.assetWriteTransactions - writes, 2);
  const after = db.documents.get(key) as typeof before;
  assert.equal(after.generation, 8);
  assert.equal(after.current.generation, 8);
  assert.deepEqual(after.previous, before.current);
  assert.equal(db.assets.get(assetKey), image.data);
  for (let i = 0; i < backup.chunks; i++)
    assert.equal(
      db.parts.has(JSON.stringify([key, backup.generation, i])),
      false,
    );

  const second = { ...current, name: "Second edit" };
  await repo.save(second);
  const final = db.documents.get(key) as typeof before;
  assert.equal(final.generation, 9);
  assert.equal(final.current.generation, 9);
  assert.deepEqual(final.previous, after.current);
  const reopened = new BrowserDocumentRepository(key);
  assert.deepEqual(await reopened.load(), second);
  assert.deepEqual(await reopened.recovery(), first);
});

for (const fault of [
  "invalid PNG",
  "wrong hash",
  "wrong dimensions",
  "unreferenced asset",
]) {
  test(`R16 consecutive saves ignore a MAX - 1 backup with ${fault}`, async (t) => {
    const key = "invalid-backup-payload";
    const { db, id, current, before } = await partitionedGenerations(
      t,
      key,
      false,
    );
    const backup = movePartition(
      db.parts,
      key,
      before.previous,
      Number.MAX_SAFE_INTEGER - 1,
    );
    before.previous = backup;
    const header = (
      db.parts.get(JSON.stringify([key, backup.generation, 0])) as {
        document: typeof current;
      }[]
    )[0].document;
    if (fault === "wrong dimensions") header.images![id].width++;
    else {
      if (fault === "unreferenced asset") header.images = {};
      db.assets.set(
        JSON.stringify([key, id]),
        fault === "wrong hash"
          ? "data:image/png;base64," + secondPng
          : "data:image/png;base64,AAAA",
      );
    }
    const writer = new BrowserDocumentRepository(key);
    assert.deepEqual(await writer.load(), current);
    const first = { ...current, name: "First edit" };
    await writer.save(first);
    const after = db.documents.get(key) as typeof before;
    assert.equal(after.generation, 8);
    assert.equal(after.current.generation, 8);
    assert.deepEqual(after.previous, before.current);
    const reopened = new BrowserDocumentRepository(key);
    assert.deepEqual(await reopened.load(), first);
    assert.deepEqual(await reopened.recovery(), current);

    const second = { ...first, name: "Second edit" };
    await writer.save(second);
    const final = db.documents.get(key) as typeof before;
    assert.equal(final.generation, 9);
    assert.equal(final.current.generation, 9);
    assert.deepEqual(final.previous, after.current);
    assert.deepEqual(await reopened.load(), second);
    assert.deepEqual(await reopened.recovery(), first);
  });
}

for (const fault of ["missing", "corrupt"]) {
  test(`R16 replacement repairs a ${fault} image in backup 8 and keeps its backup-only image`, async (t) => {
    const key = "repair-high-backup";
    const { db, doc, current, before, id, image } =
      await partitionedGenerations(t, key, false);
    const other = await importImageBytes(
      Buffer.from(secondPng, "base64"),
      "backup only",
    );
    const backup = {
      ...doc,
      name: "Backup with two images",
      images: { [id]: image, [other.id]: other.image },
    };
    const writer = new BrowserDocumentRepository(key);
    await writer.load();
    await writer.save(backup);
    const row = db.documents.get(key) as typeof before;
    db.documents.set(key, {
      ...row,
      generation: 6,
      current: { ...row.previous, chunks: row.previous.chunks + 1 },
      previous: row.current,
    });
    const assetKey = JSON.stringify([key, id]);
    if (fault === "missing") assert.ok(db.assets.delete(assetKey));
    else db.assets.set(assetKey, "data:image/png;base64,AAAA");

    const repository = new BrowserDocumentRepository(key);
    await assert.rejects(repository.load(), /分片缺失/);
    const replacement = {
      ...current,
      name: "Replacement with one image",
      images: { [id]: image },
    };
    await repository.save(replacement, { replacedDocument: true });
    const saved = db.documents.get(key) as typeof before;
    assert.equal(saved.generation, 9);
    assert.equal(saved.current.generation, 9);
    assert.equal(saved.previous.generation, 8);
    assert.deepEqual(saved.previous, row.current);
    assert.equal(db.parts.size, saved.current.chunks + saved.previous.chunks);
    assert.equal(db.assets.get(assetKey), image.data);
    assert.equal(
      db.assets.get(JSON.stringify([key, other.id])),
      other.image.data,
    );
    const reopened = new BrowserDocumentRepository(key);
    assert.deepEqual(await reopened.load(), replacement);
    assert.deepEqual(await reopened.recovery(), backup);
  });
}

test("R15 a transient read failure while checking a higher backup aborts the save and permits retry", async (t) => {
  const key = "transient-high-backup";
  const { db, current, before } = await partitionedGenerations(t, key, false);
  before.previous = movePartition(db.parts, key, before.previous, 9);
  const repository = new BrowserDocumentRepository(key);
  await repository.load();
  const original = structuredClone([db.documents, db.parts, db.assets]);
  const readFailure = t.mock.method(
    IDBKeyRange,
    "bound",
    () => {
      throw new DOMException("read denied", "SecurityError");
    },
    { times: 1 },
  );
  const saved = { ...current, name: "Retry" };
  await assert.rejects(repository.save(saved), { name: "SecurityError" });
  assert.deepEqual(readFailure.mock.calls[0].arguments[0], [key, 9]);
  assert.deepEqual([db.documents, db.parts, db.assets], original);
  await repository.save(saved);
  assert.equal((db.documents.get(key) as typeof before).generation, 10);
  assert.deepEqual(await new BrowserDocumentRepository(key).load(), saved);
});

test("R15 replacing a failed load drops an unreadable backup that claims the next generation", async (t) => {
  const key = "unreadable-retained";
  const { db, current, before, id } = await partitionedGenerations(
    t,
    key,
    false,
  );
  before.current.chunks++;
  before.previous.generation = 8;
  const repository = new BrowserDocumentRepository(key);
  await assert.rejects(repository.load(), /分片缺失/);
  await repository.save(current, { replacedDocument: true });
  const after = db.documents.get(key) as typeof before;
  assert.equal(after.generation, 8);
  assert.equal(after.previous, undefined);
  assert.equal(db.parts.size, after.current.chunks);
  assert.equal(db.assets.has(JSON.stringify([key, id])), false);
  const reopened = new BrowserDocumentRepository(key);
  assert.deepEqual(await reopened.load(), current);
  assert.equal(await reopened.recovery(), null);
});

for (const recreate of [false, true]) {
  test(`R10 failed legacy generation 2 ${recreate ? "rejects a replacement after peer deletion and recreation" : "accepts replacement with its original absent lifetime token"}`, async (t) => {
    const key = "legacy-missing-current",
      previous = createStarter();
    const db = recoveryDatabase(t, key, { generation: 2, previous });
    const stale = new BrowserDocumentRepository(key);
    await assert.rejects(stale.load(), /快照缺失/);
    const imported = { ...previous, name: "C" };
    if (recreate) {
      await deleteLocalFile(key);
      assert.equal(db.documents.has(key), false);
      const peer = new BrowserDocumentRepository(key),
        live = { ...previous, name: "peer generation 2" };
      await peer.save(previous);
      await peer.save(live);
      const record = db.documents.get(key) as {
        generation: number;
        lifetimeToken: string;
      };
      assert.equal(record.generation, 2);
      assert.ok(record.lifetimeToken);
      await assert.rejects(stale.recovery(), /另一个标签页更新/);
      await assert.rejects(
        stale.save(imported, { replacedDocument: true }),
        /另一个标签页更新/,
      );
      assert.deepEqual(await new BrowserDocumentRepository(key).load(), live);
    } else {
      await stale.save(imported, { replacedDocument: true });
      assert.deepEqual(
        await new BrowserDocumentRepository(key).load(),
        imported,
      );
    }
  });
}

for (const changed of ["generation", "lifetimeToken"] as const) {
  test(`R9 replacement from a failed load rejects a changed ${changed}`, async (t) => {
    const previous = createStarter(),
      record = corruptSnapshot(previous);
    const key = "concurrent-replacement";
    const database = recoveryDatabase(t, key, record);
    const repository = new BrowserDocumentRepository(key);
    await assert.rejects(repository.load());
    const peer = {
      ...record,
      current: { ...previous, name: "Peer" },
      [changed]: changed === "generation" ? 8 : "new-lifetime",
    };
    database.documents.set(key, peer);
    await assert.rejects(
      repository.save({ ...previous, name: "C" }, { replacedDocument: true }),
      /另一个标签页更新/,
    );
    assert.deepEqual(database.documents.get(key), peer);
  });
}

test("R9 explicit replacement requires a baseline after a transient load failure", async (t) => {
  const previous = createStarter(),
    record = corruptSnapshot(previous);
  const key = "no-observed-generation";
  const database = recoveryDatabase(t, key, record);
  const repository = new BrowserDocumentRepository(key);
  t.mock.method(
    indexedDB,
    "open",
    () => {
      throw new DOMException("read denied", "SecurityError");
    },
    { times: 1 },
  );
  await assert.rejects(repository.load(), { name: "SecurityError" });
  await assert.rejects(repository.save(previous, { replacedDocument: true }), {
    message: "当前设计快照无法读取，请从文件菜单恢复上个版本",
  });
  assert.deepEqual(database.documents.get(key), record);
});

test("R8 importing C during recovery of corrupt generation 7 persists C across unmount and reload", async (t) => {
  const ui = await mountDom(t);
  const placeholder = createStarter();
  const previous = { ...placeholder, name: "Recovered A" };
  const record = corruptSnapshot(previous);
  const imported = { ...placeholder, name: "C" };
  const fileKey = "corrupt-generation-seven";
  const database = recoveryDatabase(t, fileKey, record);
  const repository = new BrowserDocumentRepository(fileKey);
  let loadError = "";
  await assert.rejects(repository.load(), (err: Error) => {
    loadError = err.message;
    return !!loadError;
  });
  const save = t.mock.method(repository, "save");
  let editor!: EditorController;
  function Probe() {
    editor = useEditor({ repository, initialDocument: placeholder, loadError });
    return h("output", null, editor.doc.name);
  }
  await act(() => ui.root.render(h(Probe)));
  assert.equal(editor.protectCache, true);
  database.holdRead();
  const restoring = editor.recoverPrevious();
  await database.started;
  await act(() => editor.importDocument(imported, { replacedDocument: true }));
  assert.equal(editor.protectCache, false);
  assert.equal(editor.saved, false);
  assert.equal(editor.getCurrentDocumentEpoch(), undefined);
  assert.equal(editor.canUndo, false);
  assert.equal(editor.canRedo, false);
  assert.equal(ui.host.textContent, "C");
  assert.equal(save.mock.callCount(), 0);
  assert.deepEqual(database.documents.get(fileKey), record);
  await act(async () => {
    database.release.resolve();
    await restoring;
  });
  const committed = editor.committed;
  assert.equal(ui.host.textContent, "C");
  assert.equal(editor.saved, true);
  assert.equal(editor.getCurrentDocumentEpoch(), 4);
  assert.equal(editor.error, "");
  assert.equal(editor.documentSession, 2);
  await act(() => ui.root.render(null));
  assert.equal(save.mock.callCount(), 1);
  assert.deepEqual(save.mock.calls[0].arguments, [
    committed,
    { replacedDocument: true },
  ]);
  assert.deepEqual(database.documents.get(fileKey), {
    ...record,
    generation: 8,
    replacementEpoch: 4,
    current: committed,
  });
  assert.deepEqual(
    await new BrowserDocumentRepository(fileKey).load(),
    committed,
  );
});

test("a superseded recovery read error leaves the imported document saved without a stale error", async (t) => {
  const ui = await mountDom(t);
  const initialDocument = createStarter();
  const gate = deferred<void>();
  const repository = new BrowserDocumentRepository();
  t.mock.method(repository, "recovery", async () => {
    await gate.promise;
    throw Error("previous snapshot unavailable");
  });
  const save = t.mock.method(repository, "save", async () => {});
  let editor!: EditorController;
  function Probe() {
    editor = useEditor({ repository, initialDocument });
    return null;
  }
  await act(() => ui.root.render(h(Probe)));
  const restoring = editor.recoverPrevious();
  await act(() =>
    editor.importDocument(
      { ...initialDocument, name: "C" },
      { replacedDocument: true },
    ),
  );
  assert.equal(save.mock.callCount(), 0);
  await act(async () => {
    gate.resolve();
    await restoring;
  });
  assert.equal(save.mock.callCount(), 1);
  assert.equal(editor.doc.name, "C");
  assert.equal(editor.saved, true);
  assert.equal(editor.error, "");
});

for (const sameId of [false, true]) {
  test(`P0-1: importing a ${sameId ? "same-ID" : "different-ID"} file closes the page picker and discards its pending edits`, async (t) => {
    const ui = await mountDom(t);
    const docA = { ...createStarter(), nodes: [], pageBackground: "#112233" };
    const docB = {
      ...docA,
      id: sameId ? docA.id : "replacement",
      pageBackground: "#abcdef",
      pageBackgroundOpacity: 0.62,
    };
    const save = t.mock.method(
      BrowserDocumentRepository.prototype,
      "save",
      async () => {},
    );
    const sample = deferred<{ sRGBHex: string }>();
    const start = t.mock.fn(() => sample.promise);
    Object.assign(ui.win, {
      EyeDropper: class {
        open = start;
      },
    });
    await act(() => ui.root.render(h(App, { initialDocument: docA })));
    const file = new File([JSON.stringify(docB)], "replacement.forma.json");
    const contents = deferred<string>();
    const read = t.mock.method(file, "text", () => contents.promise);
    const input = ui.body.querySelector('[data-testid="design-file-input"]')!;
    Object.assign(input, { type: "file", files: [file] });
    await act(() => ui.fire("change", input));
    assert.equal(read.mock.callCount(), 1);
    const trigger = ui.named("编辑页面背景色颜色");
    await act(() => ui.fire("click", trigger));
    const opacity = ui.named("颜色不透明度百分比");
    const props = Object.keys(opacity).find((key) =>
      key.startsWith("__reactProps$"),
    )!;
    const blur = Reflect.get(opacity, props).onBlur;
    opacity.value = "37";
    await act(() => ui.fire("click", ui.named("吸管")));
    assert.equal(start.mock.callCount(), 1);
    const focus = t.mock.method(trigger, "focus");
    await act(() => contents.resolve(JSON.stringify(docB)));
    assert.equal(
      ui.named("编辑页面背景色颜色").getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(opacity.isConnected, false);
    assert.equal(focus.mock.callCount(), 0);
    // Reopen B's picker before A's events arrive so an open/closed flag alone cannot pass.
    await act(() => ui.fire("click", ui.named("编辑页面背景色颜色")));
    await act(async () => {
      sample.resolve({ sRGBHex: "#ff0000" });
      await sample.promise;
      blur({ currentTarget: opacity });
    });
    assert.equal(ui.named("页面背景色 HEX").value, "ABCDEF");
    assert.equal(ui.named("颜色不透明度百分比").value, "62");
    assert.equal(save.mock.callCount(), 1);
    const [saved] = save.mock.calls[0].arguments;
    assert.ok(saved);
    assert.deepEqual(
      [saved.id, saved.pageBackground, saved.pageBackgroundOpacity],
      [docB.id, docB.pageBackground, docB.pageBackgroundOpacity],
    );
  });
}

for (const mode of [
  "active",
  "inactive",
  "reactivated",
  "unmounted",
  "stale error",
] as const) {
  test(`R3-P1-1: deferred Outline Text completion with the editor ${mode}`, async (t) => {
    const node = createNode("text");
    node.text = "AB";
    node.style.fontFamily = "Forma Geometry";
    const ui = await mount(t, [node]);
    const data = await readFile(
      new URL("./fixtures/forma-geometry-test.ttf", import.meta.url),
    );
    const gate = deferred<void>();
    const requested = t.mock.fn(async () => {
      await gate.promise;
      return mode === "stale error"
        ? { error: "Font unavailable" }
        : [{ family: node.style.fontFamily, data, faceIndex: 0 }];
    });
    Object.assign(ui.win, { formaDesktop: { resolveSystemFonts: requested } });
    await act(() => ui.e.perform("outlineText"));
    await t.waitFor(() => assert.equal(requested.mock.callCount(), 1));
    if (mode === "unmounted") await act(() => ui.root.render(null));
    else if (mode !== "active") await ui.setActive(false);
    if (mode === "inactive") await act(() => ui.e.perform("outlineText"));
    if (mode === "reactivated" || mode === "stale error")
      await ui.setActive(true);
    await act(async () => {
      gate.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    assert.equal(requested.mock.callCount(), 1);
    assert.equal(
      ui.e.committed.nodes[0].type,
      mode === "active" ? "vector" : "text",
    );
    assert.equal(
      ui.e.historyRef.current.past.length,
      mode === "active" ? 1 : 0,
    );
    assert.equal(ui.e.error, "");
  });
}

test("P0-1: Ctrl+Tab closes an inspector portal while its busy editor stays mounted", async (t) => {
  const ui = await mountDom(t);
  const text = createNode("text");
  location.search = "?example=first&node=" + text.id;
  const state = openTab(
    createInitialTabsState(location.search),
    makeExampleTab({ example: "second" }),
  );
  localStorage.setItem(WORKSPACE_TABS_STORAGE_KEY, serializeTabsState(state));
  let opened = 0;
  t.mock.method(BrowserDocumentRepository.prototype, "load", async () => ({
    ...createStarter(),
    name: ++opened === 1 ? "Document A" : "Document B",
    nodes: [text],
  }));
  await act(() => ui.root.render(h(WorkspaceShell)));
  await act(() => ui.fire("click", ui.named("change scope during generation")));
  const pane = ui.named("更多文字样式设置").closest(".workspace-pane")!;
  const cycle = (shiftKey = false) =>
    act(() => {
      ui.win.dispatchEvent(
        Object.assign(new Event("keydown", { cancelable: true }), {
          key: "Tab",
          ctrlKey: true,
          shiftKey,
        }),
      );
    });
  for (const [trigger, selector] of [
    ["更多文字样式设置", ".type-details-popover"],
    ["编辑填充颜色", ".color-popover"],
  ]) {
    await act(() => ui.fire("click", ui.named(trigger)));
    const popup = ui.body.querySelector(selector);
    assert.ok(popup && popup.parentNode === ui.body);
    await cycle();
    assert.equal(popup.isConnected, false);
    assert.ok(pane.isConnected && pane.hasAttribute("hidden"));
    assert.equal(ui.named("Document B").getAttribute("aria-selected"), "true");
    await cycle(true);
    assert.equal(ui.named("Document A").getAttribute("aria-selected"), "true");
    assert.equal(ui.named(trigger).getAttribute("aria-expanded"), "false");
  }
});

test("P1-16: two mounted editors have four unique panels with matching separators and toggles", async (t) => {
  const ui = await mountDom(t);
  const doc = { ...createStarter(), nodes: [] };
  await act(() =>
    ui.root.render(
      h(
        Fragment,
        null,
        h(App, { initialDocument: doc }),
        h(App, { initialDocument: doc, tabActive: false }),
      ),
    ),
  );
  const apps = ui.body.querySelectorAll(".app");
  assert.equal(apps.length, 2);
  const ids = new Set<string>();
  for (const app of apps) {
    const separators = app.querySelectorAll(".panel-divider");
    assert.equal(separators.length, 2);
    for (const [i, divider] of Array.from(separators).entries()) {
      assert.equal(divider.getAttribute("role"), "separator");
      const panel = app.querySelector(i ? ".right-panel" : ".left-panel")!;
      const id = panel.getAttribute("id")!;
      assert.ok(id);
      assert.equal(divider.getAttribute("aria-controls"), id);
      assert.equal(
        app
          .querySelector(
            i ? '[aria-label="属性面板"]' : '[aria-label="图层与资源面板"]',
          )
          ?.getAttribute("aria-controls"),
        id,
      );
      ids.add(id);
    }
  }
  assert.equal(ids.size, 4);
});

test("P1-17: Finder errors share the active canvas stack and follow Home until dismissed", async (t) => {
  const ui = await mountDom(t);
  let openFile!: () => void;
  let pending = false;
  Object.assign(ui.win, {
    formaDesktop: {
      version: "test",
      onMenuAction() {
        return () => {};
      },
      onOpenFileInTab(cb: () => void) {
        openFile = cb;
        return () => {};
      },
      async consumePendingFile() {
        return pending ? { name: "bad.forma", size: 2 } : null;
      },
      async readPendingChunk() {
        return new Uint8Array();
      },
    },
  });
  await act(() => ui.root.render(h(WorkspaceShell)));
  const stage = ui.body.querySelector(".canvas-stage");
  assert.ok(stage, "editor loaded");
  await act(async () => {
    pending = true;
    openFile();
  });
  const hosts = () => Array.from(ui.body.querySelectorAll(".forma-toast-host"));
  assert.equal(hosts().length, 1);
  assert.ok(stage.contains(hosts()[0]));
  assert.ok(
    hosts()[0].querySelector('[data-kind="error"]'),
    "repository read error shares the same stack",
  );
  assert.ok(hosts()[0].querySelector('[data-kind="shellNotice"]'));
  assert.match(hosts()[0].textContent!, /文件长度不符/);
  assert.equal((hosts()[0] as HTMLElement).style.top, "72px");
  await act(() => {
    ui.win.dispatchEvent(
      Object.assign(new Event("keydown", { cancelable: true }), {
        key: "1",
        code: "Digit1",
        ctrlKey: true,
      }),
    );
  });
  assert.equal(hosts().length, 1);
  assert.equal(hosts()[0].closest(".app"), null);
  assert.equal((hosts()[0] as HTMLElement).style.top, "52px");
  assert.match(hosts()[0].textContent!, /文件长度不符/);
  await act(() => ui.fire("click", ui.named("关闭错误")));
  assert.equal(hosts().length, 0);
});

async function dropInvalidFiles(
  ui: Awaited<ReturnType<typeof mountDom>>,
  ...names: string[]
) {
  await act(async () => {
    ui.fire("drop", ui.named("设计文件标签栏"), {
      dataTransfer: { files: names.map((name) => new File(["invalid"], name)) },
    });
  });
}

test("R2-P2-1: invalid file drops show distinct filenames together, deduplicate and dismiss independently", async (t) => {
  const ui = await mountDom(t);
  await act(() => ui.root.render(h(WorkspaceShell)));
  const stage = ui.body.querySelector(".canvas-stage")!;
  const cards = () =>
    Array.from(stage.querySelectorAll('[data-kind="shellNotice"]'));
  await dropInvalidFiles(ui, "first.forma", "second.forma", "first.forma");
  assert.equal(cards().length, 2);
  assert.match(cards()[0].textContent!, /first\.forma/);
  assert.match(cards()[1].textContent!, /second\.forma/);
  await act(() => ui.fire("click", cards()[0].querySelector("button")!));
  assert.equal(cards().length, 1);
  assert.match(cards()[0].textContent!, /second\.forma/);
  await dropInvalidFiles(ui, "a.forma", "b.forma", "c.forma", "d.forma");
  assert.equal(cards().length, 4);
  assert.match(cards()[0].textContent!, /a\.forma/);
  assert.match(cards()[3].textContent!, /d\.forma/);
});

test("R2-P2-2: an active loading tab shows file errors immediately and hands them to its mounted canvas", async (t) => {
  const ui = await mountDom(t);
  const doc = { ...createStarter(), nodes: [] };
  let finish!: (value: typeof doc) => void;
  const loading = new Promise<typeof doc>((resolve) => {
    finish = resolve;
  });
  t.mock.method(BrowserDocumentRepository.prototype, "load", () => loading);
  await act(() => ui.root.render(h(WorkspaceShell)));
  assert.match(ui.host.textContent!, /正在载入画布/);
  await dropInvalidFiles(ui, "during-preload.forma");
  const notices = () =>
    Array.from(ui.body.querySelectorAll('[data-kind="shellNotice"]'));
  assert.equal(ui.body.querySelector(".app"), null);
  assert.equal(notices().length, 1);
  assert.match(notices()[0].textContent!, /during-preload\.forma/);
  assert.equal(notices()[0].closest("[hidden]"), null);
  assert.equal(
    (notices()[0].closest(".forma-toast-stack") as HTMLElement).style
      .visibility,
    "visible",
  );
  await act(async () => finish(doc));
  assert.equal(notices().length, 1);
  assert.ok(notices()[0].closest(".canvas-stage"));
});

test("R2-P2-2: Finder errors remain visible and dismissible on a failed editor tab", async (t) => {
  let rejectFont!: (error: Error) => void;
  const decoding = new Promise<void>((_, reject) => {
    rejectFont = reject;
  });
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const { ui, fonts } = await fontFixture(t, async () => {
    start();
    await decoding;
  });
  const doc = { ...createStarter(), nodes: [], fonts };
  t.mock.method(BrowserDocumentRepository.prototype, "load", async () => doc);
  let notify!: () => void;
  const queue: string[] = [];
  Object.assign(ui.win, {
    formaDesktop: {
      onOpenFileInTab(callback: () => void) {
        notify = callback;
        return () => {};
      },
      onMenuAction() {
        return () => {};
      },
      async consumePendingFile() {
        const name = queue.shift();
        return name ? { name, size: 2 } : null;
      },
      async readPendingChunk() {
        return new Uint8Array();
      },
    },
  });
  await act(() => ui.root.render(h(WorkspaceShell)));
  await act(async () => {
    await started;
    rejectFont(new Error("font preload failed"));
  });
  assert.match(ui.host.textContent!, /文件加载失败.*font preload failed/);
  await act(async () => {
    queue.push("finder-A.forma", "finder-B.forma");
    notify();
    notify();
  });
  const cards = () =>
    Array.from(ui.body.querySelectorAll('[data-kind="shellNotice"]'));
  assert.equal(cards().length, 2);
  assert.match(cards()[0].textContent!, /finder-A\.forma/);
  assert.match(cards()[1].textContent!, /finder-B\.forma/);
  assert.equal(cards()[0].closest("[hidden]"), null);
  assert.equal(
    (cards()[0].closest(".forma-toast-stack") as HTMLElement).style.visibility,
    "visible",
  );
  await act(() => ui.fire("click", cards()[0].querySelector("button")!));
  assert.equal(cards().length, 1);
  assert.match(cards()[0].textContent!, /finder-B\.forma/);
  assert.equal(ui.body.querySelector(".app"), null);
});

test("P1-18: changing project during AI generation produces a dismissible warning", async (t) => {
  const ui = await mountDom(t);
  await act(() =>
    ui.root.render(
      h(App, { initialDocument: { ...createStarter(), nodes: [] } }),
    ),
  );
  await act(() => ui.fire("click", ui.named("change scope during generation")));
  const warning = ui.body.querySelector('[data-severity="warning"]');
  assert.ok(warning);
  assert.match(warning.textContent!, /已丢弃过期提案/);
  assert.equal(warning.getAttribute("role"), "status");
  assert.ok(warning.querySelector(".lucide-triangle-alert"));
  assert.equal(warning.querySelector(".lucide-circle-check"), null);
  await act(() => ui.fire("click", ui.named("关闭状态提示")));
  assert.equal(warning.isConnected, false);
});

async function fontFixture(t: TestContext, decode?: () => Promise<void>) {
  const ui = await mountDom(t);
  class Face {
    async load() {
      await decode?.();
      return this;
    }
  }
  const saved = Object.getOwnPropertyDescriptor(globalThis, "FontFace");
  Object.defineProperty(globalThis, "FontFace", {
    configurable: true,
    value: Face,
  });
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, "FontFace", saved);
    else Reflect.deleteProperty(globalThis, "FontFace");
  });
  const faces = new Set<Face>();
  Object.assign(ui.document, { fonts: faces });
  const bytes = Buffer.from("embedded test font");
  const id = "font-" + (await assetHash(bytes));
  const fonts = {
    [id]: {
      name: "Embedded",
      axes: [],
      data: "data:font/ttf;base64," + bytes.toString("base64"),
    },
  };
  return { ui, fonts, faces };
}

test("P1-6: an embedded face survives a shared library owner and is evicted when the last editor unmounts", async (t) => {
  const { ui, fonts, faces } = await fontFixture(t);
  const removed = t.mock.method(faces, "delete");
  const source = createStarter();
  const library = createLibraryFromSelection(
    source,
    source.nodes[0].id,
    "Shared",
  );
  library.fonts = fonts;
  const doc = { ...source, nodes: [], fonts };
  const subscriber = {
    ...source,
    nodes: [],
    libraries: { [library.id]: library },
  };
  const render = (a: boolean, b: boolean) =>
    act(() =>
      ui.root.render(
        h(
          Fragment,
          null,
          a && h(App, { key: "a", initialDocument: doc }),
          b && h(App, { key: "b", initialDocument: subscriber }),
        ),
      ),
    );
  await render(true, true);
  await t.waitFor(() => assert.equal(faces.size, 1));
  const [face] = faces;
  await render(false, true);
  assert.ok(faces.has(face));
  assert.equal(removed.mock.callCount(), 0);
  await render(false, false);
  assert.deepEqual(removed.mock.calls[0].arguments, [face]);
  assert.equal(faces.size, 0);
  await render(true, false);
  await t.waitFor(() => assert.equal(faces.size, 1));
  assert.notEqual([...faces][0], face, "reopening decodes a fresh face");
  await render(false, false);
});

test("P1-6: closing a workspace tab while its font decodes cancels the preload", async (t) => {
  let finishDecode!: () => void, markStarted!: () => void;
  const decoding = new Promise<void>((resolve) => {
    finishDecode = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const { ui, fonts, faces } = await fontFixture(t, () => {
    markStarted();
    return decoding;
  });
  const doc = { ...createStarter(), nodes: [], fonts };
  t.mock.method(BrowserDocumentRepository.prototype, "load", async () => doc);
  await act(() => ui.root.render(h(WorkspaceShell)));
  await started;
  assert.equal(ui.body.querySelector(".app"), null);
  await act(() => {
    ui.win.dispatchEvent(
      Object.assign(new Event("keydown", { cancelable: true }), {
        altKey: true,
        code: "KeyW",
      }),
    );
  });
  await act(async () => {
    finishDecode();
  });
  assert.equal(faces.size, 0, "a closed tab cannot register a late FontFace");
  assert.equal(ui.body.querySelector(".app"), null);
});

test("P1-6: the shell hands off the preloaded face until the mounted editor replaces its document", async (t) => {
  const { ui, fonts, faces } = await fontFixture(t);
  const doc = { ...createStarter(), nodes: [], fonts };
  t.mock.method(BrowserDocumentRepository.prototype, "load", async () => doc);
  const added = t.mock.method(faces, "add");
  await act(() => ui.root.render(h(WorkspaceShell)));
  await act(async () => {
    await t.waitFor(() => assert.equal(faces.size, 1));
  });
  assert.equal(added.mock.callCount(), 1);
  const input = ui.body.querySelector('[data-testid="design-file-input"]')!;
  const replacement = new File(
    [JSON.stringify(createStarter())],
    "replacement.forma.json",
  );
  Object.assign(input, { type: "file", files: [replacement] });
  await act(() => ui.fire("change", input));
  assert.equal(
    faces.size,
    0,
    "the preload owner cannot outlive its handoff to the editor",
  );
  assert.ok(ui.body.querySelector(".app"));
});
