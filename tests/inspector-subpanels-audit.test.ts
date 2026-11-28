import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { act, createElement as h, type ReactElement } from "react";
import { unzipSync } from "fflate";
import {
  createNode,
  type DesignDocument,
  type DesignNode,
} from "../src/domain/document";
import { designSystemSchema } from "../src/domain/design-system-schema";
import { planScaleSelection } from "../src/domain/scale-tool";
import { smartSelection } from "../src/domain/smart-selection";
import { identity } from "../src/domain/transforms";
import { SmartHandles } from "../src/editor/SmartHandles";
import { createStarter } from "../src/domain/seed";
import type { EditorController } from "../src/editor/useEditor";
import {
  collectExportTargets,
  exportTargetZip,
} from "../src/infrastructure/batch-export";
import { commitEditorOperations } from "../src/application/geometry-preview";

const css = registerHooks({
  load(url, context, next) {
    return url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context);
  },
});
const { PrototypeInspector } = await import("../src/editor/PrototypeInspector");
const { DevModePanel } = await import("../src/editor/DevModePanel");
const { ExportPanel, BatchExportModal } =
  await import("../src/editor/ExportPanel");
const { SelectionColors } = await import("../src/editor/SelectionColors");
const { ImageInspector, ImageFillTrigger } =
  await import("../src/editor/ImageInspector");
const { GradientControls, GradientEditor } =
  await import("../src/editor/GradientEditor");
const { VectorInspector } = await import("../src/editor/VectorInspector");
const { ScalePanel } = await import("../src/editor/ScalePanel");
const { GridTracks } = await import("../src/editor/GridTracks");
const { LayoutBreakpoints } = await import("../src/editor/LayoutBreakpoints");
const { LayoutGuidesInspector } =
  await import("../src/editor/LayoutGuidesInspector");
const { SizeLimits } = await import("../src/editor/SizeLimits");
const { PaintStack } = await import("../src/editor/PaintStack");
const { PropertyGlyph } = await import("../src/editor/property-icons");
const { PanelDivider } = await import("../src/editor/PanelDivider");
css.deregister();

function install(t: TestContext, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
    t.after(() => {
      if (old) Object.defineProperty(globalThis, key, old);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

// Mount React in the same XML DOM used by the editor integration suite.
// Supply the HTML form/focus primitives the XML implementation doesn't model.
async function mount(t: TestContext) {
  const doc = new DOMParser().parseFromString(
    "<html><body/></html>",
    "text/html",
  );
  const body = doc.getElementsByTagName("body")[0];
  const win = Object.assign(new EventTarget(), {
    document: doc,
    HTMLIFrameElement: class {},
    innerWidth: 1024,
    innerHeight: 700,
    setTimeout,
  });
  const delegated = new EventTarget();
  let active: Element | null = null;
  const create = doc.createElement.bind(doc);
  function emit(
    type: string,
    target: Element,
    more: Record<string, unknown> = {},
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "target", { value: target });
    Object.assign(event, more);
    if (type === "toggle") target.dispatchEvent(event);
    else delegated.dispatchEvent(event);
  }
  function enhance(el: Element) {
    const nativeEvents = new EventTarget();
    const props = new Map<string, string>();
    Object.assign(el, {
      style: {
        setProperty: (k: string, v: string) => props.set(k, v),
        getPropertyValue: (k: string) => props.get(k) ?? "",
        removeProperty: (k: string) => props.delete(k),
      },
      dataset: {},
      options: [],
      value: "",
      isConnected: true,
      focus() {
        active = el;
      },
      blur() {
        active = null;
        emit("focusout", el);
      },
      click() {
        emit("click", el);
      },
      querySelectorAll: (selector: string) =>
        selector === 'button[role="tab"]'
          ? Array.from(el.getElementsByTagName("button"))
          : [],
      querySelector: (selector: string) =>
        Array.from(el.getElementsByTagName("*")).find(
          (n) => selector === "#" + n.getAttribute("id"),
        ) ?? null,
      closest: (selector: string) => {
        let n: Element | null = el;
        while (n && n.nodeType === 1) {
          if (
            selector === ".app" &&
            n.getAttribute("class")?.split(" ").includes("app")
          )
            return n;
          n = n.parentElement;
        }
        return null;
      },
      contains: (node: Element | null) =>
        node === el ||
        Array.from(el.getElementsByTagName("*")).some(
          (child) => child === node,
        ),
      getClientRects: () => [],
      getBoundingClientRect: () => ({
        top: 10,
        left: 10,
        bottom: 30,
        width: 50,
        height: 20,
      }),
      setPointerCapture() {},
      releasePointerCapture() {},
      hasPointerCapture: () => true,
      dispatchEvent: nativeEvents.dispatchEvent.bind(nativeEvents),
      addEventListener: nativeEvents.addEventListener.bind(nativeEvents),
      removeEventListener: nativeEvents.removeEventListener.bind(nativeEvents),
    });
    Object.defineProperties(el, {
      offsetWidth: { get: () => Number(el.getAttribute("data-width")) },
      valueAsNumber: {
        get: () => {
          const value = (el as HTMLInputElement).value;
          return value.trim() ? Number(value) : NaN;
        },
      },
      validity: { get: () => ({ valid: true, badInput: false }) },
      parentElement: { get: () => el.parentNode },
    });
    return el;
  }
  t.mock.method(doc, "createElement", (tag: string) => enhance(create(tag)));
  const createNS = doc.createElementNS.bind(doc);
  t.mock.method(doc, "createElementNS", (ns: string, tag: string) =>
    enhance(createNS(ns, tag)),
  );
  enhance(body);
  Object.assign(body, {
    addEventListener: delegated.addEventListener.bind(delegated),
    removeEventListener: delegated.removeEventListener.bind(delegated),
  });
  Object.assign(doc, {
    body,
    oninput: null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  });
  Object.defineProperty(doc, "activeElement", { get: () => active });
  Object.assign(doc.documentElement, { dataset: {} });
  install(t, {
    document: doc,
    window: win,
    HTMLElement: class {},
    Element: class {},
    Node: class {},
    innerWidth: 1024,
    innerHeight: 700,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    localStorage: { getItem: () => null, setItem() {} },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(body);
  const all = (tag: string) =>
    Array.from(body.getElementsByTagName(tag)) as HTMLElement[];
  const named = (name: string, tag = "*") => {
    const found = all(tag).find(
      (el) =>
        el.getAttribute("aria-label") === name ||
        (el.tagName === "button" && el.textContent?.trim() === name),
    );
    assert.ok(found, name);
    return found as HTMLInputElement;
  };
  return {
    all,
    named,
    doc,
    get focused() {
      return active;
    },
    show: (view: ReactElement) => act(() => root.render(view)),
    fire: (el: Element, type: string, more: Record<string, unknown> = {}) =>
      act(() => emit(type, el, more)),
    click: (name: string) => act(() => emit("click", named(name))),
    key: (el: Element, key: string, isComposing = false) =>
      act(() => emit("keydown", el, { key, isComposing })),
    type: (el: HTMLInputElement, value: string) =>
      act(() => {
        el.value = value;
        emit("input", el);
      }),
    select: (el: HTMLInputElement, value: string) =>
      act(() => {
        el.value = value;
        emit("change", el);
      }),
    blur: (el: HTMLInputElement) => act(() => el.blur()),
    close: () => act(() => root.unmount()),
  };
}

function fixture(...nodes: DesignNode[]) {
  const doc = { ...createStarter(), nodes };
  const historyRef = { current: { present: doc } };
  const previewRef = { current: null as DesignDocument | null };
  const operations: Parameters<EditorController["apply"]>[0][] = [];
  const failures: string[] = [];
  function editor(selection = [nodes[0].id]) {
    const visible = previewRef.current ?? historyRef.current.present;
    return {
      doc: visible,
      committed: historyRef.current.present,
      historyRef,
      previewRef,
      selection,
      selected: selection.map((id) => visible.nodes.find((n) => n.id === id)!),
      setError: (s: string) => failures.push(s),
      attempt: (work: () => void) => work(),
      setPreview,
      apply,
      update(patch: Partial<DesignNode>, style?: Partial<DesignNode["style"]>) {
        apply(selection.map((id) => ({ type: "update", id, patch, style })));
      },
      actionEligibility: {
        document: visible,
        selection,
        hasPreview: !!previewRef.current,
      },
    } as unknown as EditorController;
  }
  function setPreview(next: DesignDocument | null) {
    previewRef.current = next;
  }
  function apply(ops: Parameters<EditorController["apply"]>[0]) {
    historyRef.current.present = commitEditorOperations(
      historyRef.current.present,
      ops,
      historyRef.current.present.revision,
    );
    operations.push(ops);
    setPreview(null);
  }
  return {
    doc,
    editor,
    operations,
    failures,
    setPreview,
    historyRef,
    previewRef,
  };
}
const noop = () => {};
const gradient = {
  type: "linear" as const,
  angle: 135,
  stops: [
    { offset: 0.2, color: "#000000", opacity: 1 },
    { offset: 1, color: "#ffffff", opacity: 1 },
  ],
};

test("gradient angle and stop positions keep string drafts, roll back on empty, range failure and Escape, and commit once on Enter", async (t) => {
  const ui = await mount(t);
  const values: unknown[] = [];
  await ui.show(
    h(GradientControls, {
      gradient,
      color: "#000000",
      update: (value) => values.push(value),
    }),
  );
  for (const [label, initial, max] of [
    ["渐变角度", "135", 360],
    ["色标 1 位置", "20", 100],
  ] as const) {
    const el = ui.named(label);
    for (const raw of ["", String(max + 1), "-1"]) {
      await ui.type(el, raw);
      await ui.blur(el);
      assert.equal(el.value, initial, label);
    }
    await ui.type(el, "30");
    await ui.key(el, "Escape");
    assert.equal(el.value, initial);
    assert.equal(values.length, 0);
  }
  const angle = ui.named("渐变角度");
  await ui.type(angle, "0");
  await ui.key(angle, "Enter", true);
  assert.equal(values.length, 0);
  await ui.key(angle, "Enter");
  assert.deepEqual(values, [
    {
      ...gradient,
      angle: 0,
      linearProjection: undefined,
      paintTransform: undefined,
    },
  ]);
  await ui.close();
});

test("subset ZIP keeps the collision-resolved path from the original picker", async () => {
  const icons = [1, 1, 2].map((scale) => ({
    ...createNode("rectangle"),
    name: "Symbols/Icon",
    exportSettings: [{ id: "s", format: "svg" as const, scale, suffix: "" }],
  }));
  const { doc } = fixture(...icons);
  const targets = collectExportTargets(doc);
  assert.deepEqual(
    targets.map((t) => t.path),
    ["Symbols/Icon.svg", "Symbols/Icon@1x.svg", "Symbols/Icon@2x.svg"],
  );
  assert.deepEqual(
    Object.keys(unzipSync(await exportTargetZip(doc, [targets[1]]))),
    ["Symbols/Icon@1x.svg"],
  );
});

test("export suffix retains focus and row identity through promotion, and a different layer starts clean", async (t) => {
  const ui = await mount(t);
  const a = createNode("rectangle"),
    b = createNode("rectangle");
  const { doc } = fixture(a, b);
  let writes = 0;
  function show(node: DesignNode, previewBlocked = false) {
    return ui.show(
      h(ExportPanel, {
        document: {
          ...doc,
          nodes: [a, b].map((n) => (n.id === node.id ? node : n)),
        },
        node,
        previewBlocked,
        onUpdateSettings(settings) {
          node.exportSettings = settings;
          writes++;
        },
      }),
    );
  }
  await show(a);
  const input = ui.named("导出后缀");
  input.focus();
  await ui.type(input, "@");
  await ui.type(input, "@2x");
  assert.equal(ui.focused, input);
  assert.equal(writes, 0);
  await ui.blur(input);
  await show(a);
  assert.equal(ui.named("导出后缀"), input);
  assert.equal(a.exportSettings?.[0].suffix, "@2x");
  assert.equal(writes, 1);
  await show(b);
  assert.equal(ui.named("导出后缀").value, "");
  for (const lock of ["preview", "layer"]) {
    b.locked = lock === "layer";
    await show({ ...b }, lock === "preview");
    for (const name of ["导出倍率", "导出后缀", "导出格式", "添加导出配置"])
      assert.ok(ui.named(name).hasAttribute("disabled"), name);
    for (const name of ["切换导出预览", "导出所选图层", "批量导出切图与切片"])
      assert.ok(!ui.named(name).hasAttribute("disabled"), name);
  }
  await ui.close();
});

function variables() {
  const values = {
    count: 2,
    count2: 8,
    enabled: false,
    title: "Hello",
    ink: "#ff0000",
  };
  return designSystemSchema.parse({
    collections: {
      main: {
        id: "main",
        name: "Main",
        defaultModeId: "light",
        modes: [{ id: "light", name: "Light" }],
      },
    },
    variables: Object.fromEntries(
      Object.entries(values).map(([id, value]) => [
        id,
        {
          id,
          name: id,
          collectionId: "main",
          type: id === "ink" ? "color" : typeof value,
          values: { light: value },
        },
      ]),
    ),
    activeModes: { main: "light" },
    styles: {},
  });
}
test("both prototype rules edit URLs, conditions, branch actions and full transitions; each variable action offers compatible targets", async (t) => {
  const ui = await mount(t);
  const a = createNode("frame"),
    b = createNode("frame");
  const rule: NonNullable<DesignNode["interaction"]> = {
    actions: [
      { kind: "openLink", url: "https://example.org" },
      {
        kind: "navigate",
        target: b.id,
        transition: {
          type: "push",
          duration: 300,
          direction: "left",
          easing: "linear",
        },
      },
      { kind: "toggle", variable: "enabled" },
      { kind: "input", variable: "enabled" },
      { kind: "set", variable: "count", value: 2 },
    ],
    condition: { variable: "count", value: 2, operator: "equals" },
    otherwise: [{ kind: "back" }],
  };
  a.interaction = rule;
  a.interactions = [structuredClone(rule)];
  const f = fixture(a, b);
  f.doc.designSystem = variables();
  const show = () =>
    ui.show(h(PrototypeInspector, { editor: f.editor(), openVariables: noop }));
  await show();
  for (const prefix of ["", "交互 2 "]) {
    for (const name of [
      "链接地址",
      "转场动画",
      "转场时长毫秒",
      "转场方向",
      "缓动曲线",
      "条件变量",
      "比较方式",
      "添加否则动作",
    ])
      ui.named(prefix + name);
    const lists = ui
      .all("select")
      .filter((el) => el.getAttribute("aria-label") === prefix + "目标变量");
    const options = lists.map((el) =>
      Array.from(el.getElementsByTagName("option")).map((o) =>
        o.getAttribute("value"),
      ),
    );
    assert.deepEqual(options, [["enabled"], ["enabled"], ["count", "count2"]]);
  }
  const url = ui.named("交互 2 链接地址");
  await ui.type(url, "https://example.org/changed");
  await ui.blur(url);
  await show();
  const ease = ui.named("交互 2 缓动曲线");
  await ui.select(ease, "ease-in-out");
  await show();
  await ui.select(ui.named("交互 2 条件变量"), "enabled");
  await show();
  const n = f.historyRef.current.present.nodes[0];
  assert.deepEqual(n.interaction, rule);
  assert.deepEqual(n.interactions?.[0].actions?.[0], {
    kind: "openLink",
    url: "https://example.org/changed",
  });
  assert.deepEqual(n.interactions?.[0].condition, {
    variable: "enabled",
    operator: "equals",
    value: false,
  });
  const nav = n.interactions?.[0].actions?.[1];
  assert.ok(nav?.kind === "navigate");
  assert.equal(nav.transition?.easing, "ease-in-out");
  await ui.close();
});
test("flow-name composition and Escape never commit on blur; Enter commits once and a pending proposal survives a stale blur", async (t) => {
  const ui = await mount(t);
  const n = createNode("frame");
  n.interaction = { flow: "Start" };
  const f = fixture(n);
  const show = () =>
    ui.show(h(PrototypeInspector, { editor: f.editor(), openVariables: noop }));
  await show();
  const el = ui.named("流程名称");
  await ui.type(el, "新名称");
  await ui.key(el, "Enter", true);
  assert.equal(f.operations.length, 0);
  await ui.key(el, "Escape");
  assert.equal(el.value, "Start");
  assert.equal(f.operations.length, 0);
  await ui.type(el, "Changed");
  await ui.key(el, "Enter");
  assert.equal(f.operations.length, 1);
  await show();
  const proposal = { ...f.historyRef.current.present };
  f.setPreview(proposal);
  const next = ui.named("流程名称");
  await ui.type(next, "Old blur");
  await ui.blur(next);
  await show();
  assert.ok(ui.named("流程名称").hasAttribute("disabled"));
  assert.ok(ui.named("添加交互").hasAttribute("disabled"));
  assert.equal(f.previewRef.current, proposal);
  assert.equal(f.operations.length, 1);
  await ui.close();
});
test("Dev Mode drafts belong to one layer and survive thrown, false and silently rejected saves until the annotation is committed", async (t) => {
  const ui = await mount(t);
  const a = createNode("frame"),
    b = createNode("frame");
  const f = fixture(a, b);
  let result: "throw" | "false" | "ignored" | "ok" = "throw";
  const targets: string[] = [];
  function show(n: DesignNode) {
    return ui.show(
      h(DevModePanel, {
        document: { ...f.doc, nodes: [a, b] },
        selectedIds: [n.id],
        onOpenFullCode: noop,
        onSelectNode: noop,
        onExportReact: noop,
        onUpdateNode(id, patch) {
          targets.push(id);
          if (result === "throw") throw Error("write failed");
          if (result === "false") return false;
          if (result === "ok") Object.assign(n, patch);
        },
      }),
    );
  }
  await show(a);
  await ui.click("添加开发标注");
  await ui.type(ui.named("标注内容"), "A draft");
  await show(b);
  assert.equal(ui.all("textarea").length, 0);
  await ui.click("添加开发标注");
  assert.equal(ui.named("标注内容").value, "");
  await ui.type(ui.named("标注内容"), "B note");
  for (const failure of ["throw", "false", "ignored"] as const) {
    result = failure;
    await ui.click("保存标注");
    await show(b);
    assert.equal(ui.named("标注内容").value, "B note");
  }
  result = "ok";
  await ui.click("保存标注");
  await show(b);
  assert.equal(ui.all("textarea").length, 0);
  assert.equal(b.annotations?.[0].text, "B note");
  assert.deepEqual(targets, [b.id, b.id, b.id, b.id]);
  await ui.close();
});
test("Dev Mode blocks locked, protected and preview annotation/status writes while inspection and export remain available", async (t) => {
  const ui = await mount(t);
  const parent = createNode("frame"),
    n = createNode("frame", parent.id);
  n.annotations = [{ id: "note", category: "spec", text: "Keep" }];
  const f = fixture(parent, n);
  const writes = t.mock.fn();
  const show = (previewBlocked = false) =>
    ui.show(
      h(DevModePanel, {
        document: { ...f.doc },
        selectedIds: [n.id],
        onOpenFullCode: noop,
        onSelectNode: noop,
        onExportReact: noop,
        onUpdateNode: writes,
        previewBlocked,
      }),
    );
  await show();
  await ui.click("添加开发标注");
  await ui.type(ui.named("标注内容"), "keep draft");
  for (const mode of ["preview", "locked", "protected"]) {
    parent.locked = mode === "locked";
    parent.instance =
      mode === "protected"
        ? { libraryId: "lib", componentId: "master", variantId: "base" }
        : undefined;
    await show(mode === "preview");
    for (const label of ["保存标注", "删除标注", "Ready for dev"]) {
      assert.ok(ui.named(label).hasAttribute("disabled"), label);
      await ui.click(label);
    }
    assert.equal(ui.named("标注内容").value, "keep draft");
    for (const label of ["复制当前代码片段", "导出 React 工程"])
      assert.ok(!ui.named(label).hasAttribute("disabled"));
  }
  assert.equal(writes.mock.callCount(), 0);
  await ui.close();
});
test("both Dev Mode tablists move focus, select, wrap and expose a single tab stop", async (t) => {
  const ui = await mount(t);
  const n = createNode("frame");
  n.variableBindings = { fill: "ink" };
  const { doc } = fixture(n);
  doc.designSystem = variables();
  await ui.show(
    h(DevModePanel, {
      document: doc,
      selectedIds: [n.id],
      onUpdateNode: noop,
      onOpenFullCode: noop,
      onSelectNode: noop,
      onExportReact: noop,
    }),
  );
  for (const list of ["代码语法平台", "代码格式"]) {
    const tabs = Array.from(ui.named(list).getElementsByTagName("button"));
    let i = 0;
    for (const [key, next] of [
      ["ArrowLeft", tabs.length - 1],
      ["ArrowRight", 0],
      ["End", tabs.length - 1],
      ["Home", 0],
      ["ArrowRight", 1],
    ] as const) {
      await ui.key(tabs[i], key);
      assert.equal(ui.focused, tabs[next]);
      assert.equal(tabs[next].getAttribute("aria-selected"), "true");
      assert.deepEqual(
        tabs.map((t) => t.getAttribute("tabindex")),
        tabs.map((_, i) => (i === next ? "0" : "-1")),
      );
      i = next;
    }
  }
  await ui.close();
});

test("layout guide HEX cancels synchronously, ignores composing Enter, and commits exactly once", async (t) => {
  const ui = await mount(t);
  const n = createNode("frame");
  n.style.layoutGuides = [
    {
      id: "a",
      kind: "grid",
      visible: true,
      color: "#123456",
      opacity: 0.5,
      size: 8,
      count: 1,
      gutter: 1,
      offset: 0,
      alignment: "center",
    },
  ];
  const writes = t.mock.fn();
  const show = (locked = false, previewBlocked = false) =>
    ui.show(
      h(LayoutGuidesInspector, {
        node: n,
        locked,
        previewBlocked,
        onChange: writes,
      }),
    );
  await show();
  await ui.click("展开网格参数");
  const hex = ui.named("参考网格 1 色值");
  await ui.type(hex, "#ABCDEF");
  await ui.key(hex, "Enter", true);
  assert.equal(writes.mock.callCount(), 0);
  await ui.key(hex, "Escape");
  assert.equal(hex.value, "#123456");
  assert.equal(writes.mock.callCount(), 0);
  await ui.type(hex, "abc");
  await ui.key(hex, "Enter");
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(writes.mock.calls[0].arguments[0][0].color, "#AABBCC");
  for (const locked of [true, false]) {
    await show(locked, !locked);
    assert.ok(hex.hasAttribute("disabled"));
    assert.ok(ui.named("添加布局参考网格").hasAttribute("disabled"));
  }
  await ui.close();
});

test("vector width rejects negatives, non-finite and out-of-range drafts, allows 0–100, and rolls back on Escape", async (t) => {
  const ui = await mount(t);
  const n = createNode("vector");
  n.vector = {
    width: 20,
    height: 20,
    paths: [{ d: "M0 0L20 20", fill: false, strokeWidth: 3 }],
  };
  const f = fixture(n);
  const show = () =>
    ui.show(h(VectorInspector, { editor: f.editor(), node: n }));
  await show();
  const width = ui.named("路径描边宽度");
  for (const raw of ["-1", "NaN", "101", ""]) {
    await ui.type(width, raw);
    await ui.blur(width);
    assert.equal(width.value, "3");
  }
  await ui.type(width, "6");
  await ui.key(width, "Escape");
  assert.equal(width.value, "3");
  assert.equal(f.operations.length, 0);
  await ui.type(width, "100");
  await ui.blur(width);
  assert.equal(
    f.historyRef.current.present.nodes[0].vector?.paths[0].strokeWidth,
    100,
  );
  f.setPreview({ ...f.doc });
  await show();
  assert.ok(width.hasAttribute("disabled"));
  await ui.close();
});
test("empty or invalid scale factors cannot apply cached operations; valid Enter applies once and preview disables writes", async (t) => {
  const ui = await mount(t);
  const n = createNode("rectangle");
  const { doc } = fixture(n);
  const writes = t.mock.fn();
  const show = (previewBlocked = false) =>
    ui.show(
      h(ScalePanel, {
        document: doc,
        selectedIds: [n.id],
        onApplyOperations: writes,
        onExitScale: noop,
        previewBlocked,
      }),
    );
  await show();
  const factor = ui.named("缩放倍率");
  await ui.type(factor, "2");
  for (const raw of ["", "-2", "Infinity", "101"]) {
    await ui.type(factor, raw);
    await ui.key(factor, "Enter");
    assert.equal(writes.mock.callCount(), 0);
    assert.ok(ui.named("应用等比缩放").hasAttribute("disabled"));
  }
  await ui.type(factor, "3");
  await ui.key(factor, "Escape");
  assert.equal(factor.value, "1");
  await ui.type(factor, "2");
  await ui.key(factor, "Enter");
  assert.equal(writes.mock.callCount(), 1);
  await show(true);
  assert.ok(factor.hasAttribute("disabled"));
  assert.ok(!ui.named("退出缩放模式").hasAttribute("disabled"));
  await ui.close();
});
test("grid tracks reject empty and invalid sizes, cancel a valid draft and accept a fractional track", async (t) => {
  const ui = await mount(t);
  const style = { ...createNode("frame").style, gridTracks: "2fr" };
  const writes = t.mock.fn();
  const show = (previewBlocked = false) =>
    ui.show(
      h(GridTracks, { style, disabled: false, previewBlocked, commit: writes }),
    );
  await show();
  const el = ui.named("第 1 列尺寸");
  for (const raw of ["", "0", "10001"]) {
    await ui.type(el, raw);
    await ui.blur(el);
    assert.equal(el.value, "2");
  }
  await ui.type(el, "10");
  await ui.key(el, "Escape");
  assert.equal(el.value, "2");
  assert.equal(writes.mock.callCount(), 0);
  await ui.type(el, "0.5");
  await ui.key(el, "Enter");
  assert.equal(writes.mock.calls[0].arguments[0].gridTracks, "0.5fr");
  await show(true);
  assert.ok(el.hasAttribute("disabled"));
  await ui.close();
});
test("breakpoints preserve required widths, reject duplicates and invalid ranges, support optional inheritance and Escape", async (t) => {
  const ui = await mount(t);
  const writes = t.mock.fn();
  const rules = [{ maxWidth: 480, gap: 12 }, { maxWidth: 900 }];
  const show = (previewBlocked = false) =>
    ui.show(
      h(LayoutBreakpoints, {
        rules,
        grid: true,
        previewBlocked,
        commit: writes,
      }),
    );
  await show();
  const width = ui.named("断点 1 最大宽度");
  for (const raw of ["", "0", "10001", "900"]) {
    await ui.type(width, raw);
    await ui.blur(width);
    assert.equal(width.value, "480");
  }
  const gap = ui.named("断点 1 间距");
  await ui.type(gap, "0");
  await ui.key(gap, "Escape");
  assert.equal(gap.value, "12");
  assert.equal(writes.mock.callCount(), 0);
  await ui.type(gap, "");
  await ui.blur(gap);
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(writes.mock.calls[0].arguments[0][0].gap, undefined);
  await show(true);
  assert.ok(width.hasAttribute("disabled"));
  await ui.close();
});
test("size limits commit explicit clears, roll back invalid and cancelled drafts, and block external previews", async (t) => {
  const ui = await mount(t);
  const n = createNode("rectangle");
  n.style.minWidth = 8;
  const f = fixture(n);
  const show = () =>
    ui.show(h(SizeLimits, { nodes: [n], editor: f.editor(), disabled: false }));
  await show();
  const el = ui.named("最小宽度");
  for (const raw of ["-1", "NaN", "10001"]) {
    await ui.type(el, raw);
    await ui.blur(el);
    assert.equal(el.value, "8");
  }
  await ui.type(el, "");
  await ui.key(el, "Escape");
  assert.equal(el.value, "8");
  assert.equal(f.operations.length, 0);
  await ui.type(el, "");
  await ui.blur(el);
  assert.equal(f.operations.length, 1);
  assert.equal(f.historyRef.current.present.nodes[0].style.minWidth, undefined);
  f.setPreview({ ...f.doc });
  await show();
  assert.ok(el.hasAttribute("disabled"));
  await ui.close();
});

test("selection colors read zero nodes while collapsed and match editable tint, masked vector fill and stroke when expanded", async (t) => {
  const ui = await mount(t);
  const n = createNode("vector");
  n.vector = {
    fillFromStyle: true,
    width: 10,
    height: 10,
    paths: [{ d: "M0 0L10 10Z", fill: true, strokeWidth: 0 }],
  };
  n.style = {
    ...n.style,
    fill: "#123456",
    fillOpacity: 1,
    stroke: "#456789",
    strokeWidth: 2,
    color: "#badbad",
    tint: { color: "#abcdef", opacity: 0.4 },
  };
  const f = fixture(n);
  const e = f.editor();
  let checkCollapsed = true;
  const monitored = new Proxy(e.doc, {
    get(doc, prop) {
      if (checkCollapsed && prop === "nodes")
        throw Error("collapsed palette accessed nodes");
      return Reflect.get(doc, prop);
    },
  });
  const show = () => ui.show(h(SelectionColors, { editor: f.editor() }));
  await ui.show(h(SelectionColors, { editor: { ...e, doc: monitored } }));
  checkCollapsed = false;
  await show();
  const details = ui.all("details")[0] as HTMLDetailsElement;
  details.open = true;
  await ui.fire(details, "toggle");
  for (const color of ["#123456", "#456789", "#abcdef"])
    ui.named("选区颜色 " + color + " HEX");
  assert.ok(
    !ui
      .all("input")
      .some((el) => el.getAttribute("aria-label")?.includes("#badbad")),
  );
  await ui.click("编辑选区颜色 #abcdef颜色");
  const dialog = ui.named("颜色 · 选区颜色 #abcdef");
  const plane = ui.named("饱和度与亮度");
  await ui.fire(plane, "pointerdown", {
    pointerId: 1,
    clientX: 30,
    clientY: 15,
  });
  await ui.fire(plane, "pointermove", {
    pointerId: 1,
    clientX: 40,
    clientY: 20,
  });
  await ui.fire(plane, "pointerup", { pointerId: 1 });
  await show();
  const picked =
    f.historyRef.current.present.nodes[0].style.tint!.color.toLowerCase();
  assert.notEqual(picked, "#abcdef");
  assert.equal(ui.named("颜色 · 选区颜色 " + picked), dialog);
  const hex = ui.named("选区颜色 " + picked + " HEX");
  await ui.type(hex, "ABC001");
  await ui.blur(hex);
  await show();
  assert.deepEqual(f.historyRef.current.present.nodes[0].style.tint, {
    color: "#abc001",
    opacity: 0.4,
  });
  assert.equal(ui.named("颜色 · 选区颜色 #abc001"), dialog);
  await ui.click("关闭颜色选择器");
  for (const [before, after, property] of [
    ["#123456", "112233", "fill"],
    ["#456789", "334455", "stroke"],
  ] as const) {
    const el = ui.named("选区颜色 " + before + " HEX");
    await ui.type(el, after);
    await ui.blur(el);
    await show();
    assert.equal(
      f.historyRef.current.present.nodes[0].style[property],
      "#" + after,
    );
  }
  const proposal = { ...f.historyRef.current.present };
  f.setPreview(proposal);
  await show();
  assert.ok(ui.named("选区颜色 #112233 HEX").hasAttribute("disabled"));
  assert.equal(f.previewRef.current, proposal);
  await ui.close();
});
test("an owned gradient preview can be cancelled; stale pointer cancellation, completion and unmount preserve a replacing proposal", async (t) => {
  const ui = await mount(t);
  const n = createNode("rectangle");
  n.style.gradient = gradient;
  const f = fixture(n);
  const show = () => ui.show(h(GradientEditor, { editor: f.editor() }));
  await show();
  await ui.click("编辑色标 1颜色");
  const slider = ui.named("饱和度与亮度");
  const point = { pointerId: 4, clientX: 35, clientY: 14 };
  await ui.fire(slider, "pointerdown", point);
  assert.ok(f.previewRef.current);
  assert.equal(f.operations.length, 0);
  await ui.fire(slider, "pointercancel", point);
  assert.equal(f.previewRef.current, null);
  await ui.fire(slider, "pointerdown", point);
  await show();
  assert.ok(!ui.named("渐变角度").hasAttribute("disabled"));
  const foreign = { ...f.doc };
  f.setPreview(foreign);
  await ui.fire(slider, "pointerup", point);
  await ui.fire(slider, "pointercancel", point);
  await show();
  assert.equal(f.previewRef.current, foreign);
  assert.equal(f.operations.length, 0);
  assert.ok(ui.named("渐变角度").hasAttribute("disabled"));
  await ui.close();
  assert.equal(f.previewRef.current, foreign);
});
test("paint summaries identify all four gradients, reads remain available and preview disables changes", async (t) => {
  const ui = await mount(t);
  const layers = (["linear", "radial", "angular", "diamond"] as const).map(
    (type) => ({
      id: type,
      color: "#000000",
      visible: true,
      opacity: 1,
      gradient: { ...gradient, type },
    }),
  );
  const writes = t.mock.fn();
  await ui.show(
    h(PaintStack, { layers, previewBlocked: true, update: writes }),
  );
  assert.deepEqual(
    ui.all("summary").map((el) => el.textContent),
    ["线性渐变", "径向渐变", "角度渐变", "菱形渐变"],
  );
  for (const label of ["添加填充层", "填充层 1 混合模式", "编辑填充层 1颜色"])
    assert.ok(ui.named(label).hasAttribute("disabled"));
  assert.equal(writes.mock.callCount(), 0);
  await ui.show(h(PropertyGlyph, { property: "letterSpacing", label: "字距" }));
  const glyph = ui.all("svg")[0];
  assert.match(glyph.getAttribute("class") ?? "", /move-horizontal/);
  await ui.close();
});
test("right divider observes and drags its active tab panel, with an explicit ref taking precedence", async (t) => {
  const ui = await mount(t);
  const observed: Element[] = [];
  install(t, {
    ResizeObserver: class {
      observe(el: Element) {
        observed.push(el);
      }
      disconnect() {}
    },
  });
  const ref: { current: HTMLElement | null } = { current: null };
  function view(useRef: boolean) {
    return h(
      "main",
      {},
      h(
        "div",
        { className: "app", hidden: true },
        h("aside", { id: "right-panel", "data-width": 0 }),
      ),
      h(
        "div",
        { className: "app" },
        h("aside", { id: "right-panel", "data-width": 340 }),
        h("aside", { ref, "data-width": 380 }),
        h(PanelDivider, {
          side: "right",
          visible: true,
          panelRef: useRef ? ref : undefined,
        }),
      ),
    );
  }
  for (const explicit of [false, true]) {
    await ui.show(view(explicit));
    const handle = ui.named("属性栏宽度");
    assert.equal(observed.at(-1), ui.all("aside")[explicit ? 2 : 1]);
    await ui.fire(handle, "pointerdown", {
      button: 0,
      pointerId: 1,
      clientX: 600,
    });
    await ui.fire(handle, "pointerup", { pointerId: 1, clientX: 610 });
    assert.equal(
      handle.getAttribute("aria-valuenow"),
      String(explicit ? 370 : 330),
    );
  }
  await ui.close();
});

test("image adjustments preview every drag sample, create one transaction per gesture, cancel safely and keep foreign previews", async (t) => {
  const ui = await mount(t);
  const n = createNode("rectangle");
  const id = "img-" + "1".repeat(64);
  n.image = { assetId: id, fit: "cover", zoom: 1, x: 50, y: 50 };
  const f = fixture(n);
  f.doc.images = {
    [id]: {
      name: "Image",
      width: 1,
      height: 1,
      data: "data:image/png;base64,AA==",
    },
  };
  const show = () => {
    const editor = f.editor();
    return ui.show(h(ImageInspector, { editor, node: editor.selected[0] }));
  };
  await show();
  const advanced = ui.all("button").find((el) => el.textContent === "高级调色");
  assert.ok(advanced);
  await ui.fire(advanced, "click");
  const slider = ui.named("曝光");
  await ui.type(slider, "10");
  await show();
  await ui.type(slider, "30");
  await show();
  assert.equal(f.previewRef.current?.nodes[0].image?.exposure, 0.3);
  assert.equal(f.operations.length, 0);
  await ui.fire(slider, "pointerup");
  await ui.blur(slider);
  await show();
  assert.equal(f.operations.length, 1);
  assert.equal(f.historyRef.current.present.nodes[0].image?.exposure, 0.3);
  await ui.type(slider, "40");
  await ui.fire(slider, "pointercancel");
  await ui.blur(slider);
  await show();
  assert.equal(f.previewRef.current, null);
  assert.equal(slider.value, "30");
  assert.equal(f.operations.length, 1);
  await ui.type(slider, "31");
  await ui.fire(slider, "keyup", { key: "ArrowRight" });
  await ui.blur(slider);
  await show();
  assert.equal(f.operations.length, 2);
  await ui.type(slider, "99");
  const foreign = { ...f.historyRef.current.present };
  f.setPreview(foreign);
  await ui.fire(slider, "pointerup");
  await ui.fire(slider, "pointercancel");
  await show();
  await ui.close();
  assert.equal(f.operations.length, 2);
  assert.equal(f.previewRef.current, foreign);
});
test("competing image pickers discard the slow first decode and recheck layer lock, file lifetime and external previews", async (t) => {
  const ui = await mount(t);
  const n = createNode("rectangle");
  const f = fixture(n);
  let lifetime = "current";
  let finishedReading: () => void;
  const decoded: ((value: {
    width: number;
    height: number;
    close(): void;
  }) => void)[] = [];
  install(t, {
    createImageBitmap: () => new Promise((resolve) => decoded.push(resolve)),
    FileReader: class {
      result = "data:image/png;base64,iVBORw0KGgo=";
      onload?: () => void;
      readAsDataURL() {
        this.onload?.();
        finishedReading();
      }
    },
  });
  const show = () => {
    const editor = { ...f.editor(), getCurrentLifetimeToken: () => lifetime };
    return ui.show(
      h(
        "div",
        {},
        h(ImageFillTrigger, { editor, node: n }),
        h(ImageInspector, { editor, node: n }),
      ),
    );
  };
  await show();
  const pickers = ui
    .all("input")
    .filter(
      (el) =>
        el.getAttribute("type") === "file" ||
        (el as HTMLInputElement).type === "file",
    ) as HTMLInputElement[];
  assert.equal(pickers.length, 2);
  async function pick(index: number, name: string) {
    const f = new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, name.charCodeAt(0)])],
      name + ".png",
    );
    Object.defineProperty(pickers[index], "files", {
      value: [f],
      configurable: true,
    });
    await ui.fire(pickers[index], "change");
  }
  async function finish(index: number) {
    const bytesRead = new Promise<void>((resolve) => {
      finishedReading = resolve;
    });
    decoded[index]({ width: 1, height: 1, close() {} });
    await bytesRead;
    await new Promise((resolve) => setImmediate(resolve));
  }
  await pick(0, "A");
  await pick(1, "B");
  assert.equal(decoded.length, 2);
  await finish(1);
  await finish(0);
  assert.equal(f.operations.length, 1);
  assert.equal(
    Object.values(f.historyRef.current.present.images ?? {})[0].name,
    "B.png",
  );
  await show();
  await pick(0, "C");
  lifetime = "replaced";
  await finish(2);
  await pick(0, "D");
  f.historyRef.current.present = {
    ...f.historyRef.current.present,
    nodes: [{ ...n, locked: true }],
  };
  await finish(3);
  f.historyRef.current.present = {
    ...f.historyRef.current.present,
    nodes: [n],
  };
  await show();
  await pick(0, "E");
  const proposal = { ...f.doc };
  f.setPreview(proposal);
  await finish(4);
  assert.equal(f.operations.length, 1);
  assert.equal(f.previewRef.current, proposal);
  assert.deepEqual(f.failures, []);
  await ui.close();
});

test("the batch dialog downloads exactly the checked path with its original SVG contents", async (t) => {
  const ui = await mount(t);
  const nodes = [1, 1, 2].map((scale) => ({
    ...createNode("rectangle"),
    name: "Nav/Icon",
    exportSettings: [{ id: "s", format: "svg" as const, scale, suffix: "" }],
  }));
  const { doc } = fixture(...nodes);
  let blob: Blob | undefined;
  t.mock.method(URL, "createObjectURL", (value: Blob) => {
    blob = value;
    return "blob:mock";
  });
  t.mock.method(window, "setTimeout", () => 0);
  const closed = t.mock.fn();
  await ui.show(
    h(BatchExportModal, { document: doc, open: true, onClose: closed }),
  );
  const boxes = ui.all("input");
  await ui.fire(boxes[0], "click");
  await ui.fire(boxes[2], "click");
  await act(async () => {
    ui.named("导出 ZIP (1 项)").click();
  });
  assert.ok(blob);
  const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(Object.keys(entries), ["Nav/Icon@1x.svg"]);
  assert.match(new TextDecoder().decode(entries["Nav/Icon@1x.svg"]), /<svg/);
  assert.equal(closed.mock.callCount(), 1);
  await ui.close();
});

test("minimum width preserves untouched Mixed, commits an explicit clear, rejects zero and accepts one", async (t) => {
  const ui = await mount(t);
  const a = createNode("rectangle"),
    b = createNode("rectangle");
  a.style.minWidth = 12;
  b.style.minWidth = 48;
  const f = fixture(a, b);
  const update = t.mock.fn<EditorController["update"]>();
  await ui.show(
    h(SizeLimits, {
      editor: { ...f.editor([a.id, b.id]), update },
      nodes: [a, b],
      disabled: false,
    }),
  );
  const el = ui.named("最小宽度");
  await ui.blur(el);
  assert.equal(update.mock.callCount(), 0);
  await ui.type(el, "2");
  await ui.type(el, "");
  await ui.blur(el);
  assert.deepEqual(update.mock.calls[0].arguments, [
    {},
    { minWidth: undefined },
  ]);
  await ui.type(el, "0");
  await ui.key(el, "Enter");
  assert.equal(update.mock.callCount(), 1);
  assert.equal(el.value, "");
  await ui.type(el, "1");
  await ui.key(el, "Enter");
  assert.equal(update.mock.callCount(), 2);
  assert.deepEqual(update.mock.calls[1].arguments, [{}, { minWidth: 1 }]);
  await ui.close();
});

test("SmartHandles releases only its own spacing preview on tool, selection, revision, pointer or unmount interruptions", async (t) => {
  const ui = await mount(t);
  const nodes = [0, 30, 60].map((x) => {
    const n = createNode("rectangle");
    Object.assign(n.style, { x, y: 0, width: 20, height: 20 });
    return n;
  });
  const ids = nodes.map((n) => n.id);
  const f = fixture(...nodes);
  const grid = smartSelection(f.doc, ids)!;
  let editor = f.editor(ids);
  const local = t.mock.fn<EditorController["setLocalPreview"]>(
    (owned, next) => {
      if (editor.hasExternalPreview || f.previewRef.current !== owned)
        return false;
      f.setPreview(next);
      return true;
    },
  );
  editor = {
    ...editor,
    setLocalPreview: local,
    setPreview: () => assert.fail("must use setLocalPreview"),
    tool: "select",
  };
  const show = () =>
    ui.show(
      h(SmartHandles, {
        editor,
        grid,
        matrix: identity,
        viewport: { x: 0, y: 0, zoom: 1 },
      }),
    );
  const point = { button: 0, pointerId: 2, clientX: 10, clientY: 10 };
  async function drag() {
    await show();
    const handle = ui.named("拖动水平间距");
    await ui.fire(handle, "pointerdown", point);
    await ui.fire(handle, "pointermove", { ...point, clientX: 18 });
    assert.ok(f.previewRef.current);
    return handle;
  }
  for (const reason of [
    "tool",
    "selection",
    "revision",
    "pointercancel",
    "lostpointercapture",
    "unmount",
  ]) {
    editor = { ...editor, tool: "select", selection: ids };
    const handle = await drag();
    const owned = f.previewRef.current;
    if (reason === "unmount") await ui.show(h("div"));
    else if (reason === "pointercancel" || reason === "lostpointercapture")
      await ui.fire(handle, reason, point);
    else {
      if (reason === "tool") editor = { ...editor, tool: "scale" };
      if (reason === "selection") editor = { ...editor, selection: [ids[1]] };
      if (reason === "revision")
        editor = {
          ...editor,
          committed: {
            ...editor.committed,
            revision: editor.committed.revision + 1,
          },
        };
      await show();
    }
    assert.equal(f.previewRef.current, null, reason);
    assert.deepEqual(local.mock.calls.at(-1)?.arguments, [owned, null], reason);
    await ui.fire(handle, "pointerup", point);
    assert.equal(f.operations.length, 0, reason);
  }
  const handle = await drag();
  await ui.fire(handle, "pointerup", point);
  await ui.fire(handle, "lostpointercapture", point);
  assert.equal(f.operations.length, 1);
  assert.equal(f.previewRef.current, null);

  await drag();
  const proposal = { ...f.doc };
  f.setPreview(proposal); // Arrival before React publishes hasExternalPreview.
  await ui.fire(handle, "pointerup", point);
  editor = { ...editor, hasExternalPreview: true };
  await show();
  await ui.fire(handle, "pointerdown", point);
  await ui.fire(handle, "pointermove", { ...point, clientX: 24 });
  await ui.close();
  assert.equal(f.previewRef.current, proposal);
  assert.equal(f.operations.length, 1);
});

test("uniform and independent strokes scale from 80 to 88 and share the 100 px ceiling", () => {
  const n = createNode("rectangle");
  n.style.strokeWidth = 80;
  n.style.strokeSides = { top: 80, right: 80, bottom: 80, left: 80 };
  const f = fixture(n);
  for (const [factor, expected] of [
    [1.1, 88],
    [2, 100],
  ]) {
    const scaled = commitEditorOperations(
      f.doc,
      planScaleSelection(f.doc, [n.id], factor),
      f.doc.revision,
    );
    assert.equal(scaled.nodes[0].style.strokeWidth, expected);
    assert.deepEqual(scaled.nodes[0].style.strokeSides, {
      top: expected,
      right: expected,
      bottom: expected,
      left: expected,
    });
  }
});

test("scale target dimensions reject out-of-range drafts and commit the exact displayed width and height", async (t) => {
  const ui = await mount(t);
  const n = createNode("rectangle");
  Object.assign(n.style, { width: 20, height: 40 });
  const f = fixture(n);
  const show = () =>
    ui.show(
      h(ScalePanel, {
        document: f.historyRef.current.present,
        selectedIds: [n.id],
        onApplyOperations: f.editor().apply,
        onExitScale: noop,
      }),
    );
  await show();
  const width = ui.named("目标宽度"),
    height = ui.named("目标高度"),
    factor = ui.named("缩放倍率");
  assert.equal(width.getAttribute("max"), "2000");
  assert.equal(height.getAttribute("max"), "4000");
  for (const [el, raw, original] of [
    [width, "4000", "20"],
    [height, "0.1", "40"],
  ] as const) {
    await ui.type(el, raw);
    assert.equal(el.getAttribute("aria-invalid"), "true");
    assert.ok(ui.named("应用等比缩放").hasAttribute("disabled"));
    await ui.click("应用等比缩放");
    await ui.key(el, "Enter");
    assert.equal(f.operations.length, 0);
    assert.equal(el.value, original);
    assert.equal(factor.value, "1");
    await ui.type(el, raw);
    await ui.blur(el);
    assert.equal(el.value, original);
    assert.equal(f.operations.length, 0);
  }
  for (const [el, raw, submit] of [
    [width, "2000", "Enter"],
    [height, "61.24", "Apply"],
  ] as const) {
    await ui.type(el, raw);
    const expected = [Number(width.value), Number(height.value)];
    assert.equal(Number(el.value), Number(raw));
    if (submit === "Apply") await ui.click("应用等比缩放");
    else await ui.key(el, "Enter");
    const result = f.historyRef.current.present.nodes[0].style;
    assert.deepEqual([result.width, result.height], expected);
    await show();
    assert.deepEqual([Number(width.value), Number(height.value)], expected);
  }
  assert.equal(f.operations.length, 2);
  await ui.close();
});

test("P1-12: entered factors and presets reject clamped plans and leave the displayed size at the committed selection", async (t) => {
  const ui = await mount(t);
  const left = createNode("rectangle"),
    right = createNode("rectangle");
  Object.assign(left.style, { x: 0, y: 0, width: 100, height: 20 });
  Object.assign(right.style, { x: 200, y: 0, width: 300, height: 20 });
  const f = fixture(left, right);
  const show = () =>
    ui.show(
      h(ScalePanel, {
        document: f.historyRef.current.present,
        selectedIds: [left.id, right.id],
        onApplyOperations: f.editor().apply,
        onExitScale: noop,
      }),
    );
  await show();
  const factor = ui.named("缩放倍率"),
    width = ui.named("目标宽度"),
    height = ui.named("目标高度");
  const warning = () =>
    ui.all("div").find((el) => el.getAttribute("role") === "status")
      ?.textContent ?? "";
  await ui.type(factor, "50");
  await ui.key(factor, "Enter");
  assert.deepEqual(
    [factor.value, width.value, height.value],
    ["1", "500", "20"],
  );
  assert.match(warning(), /尺寸限制.*20000 × 1000/);
  assert.equal(f.operations.length, 0);
  await ui.type(factor, "20");
  await ui.key(factor, "Enter");
  await show();
  assert.equal(f.operations.length, 1);
  const committed = f.historyRef.current.present;
  assert.deepEqual([width.value, height.value], ["10000", "400"]);
  await ui.click("3×");
  await ui.click("应用等比缩放");
  assert.deepEqual(
    [factor.value, width.value, height.value],
    ["1", "10000", "400"],
  );
  assert.match(warning(), /尺寸限制.*22000 × 1200/);
  assert.equal(f.historyRef.current.present, committed);
  assert.equal(f.operations.length, 1);
  await ui.close();
});

test("per-layer size limits cannot silently change a typed multi-selection target", async (t) => {
  const ui = await mount(t);
  const left = createNode("rectangle"),
    right = createNode("rectangle");
  Object.assign(left.style, { x: 0, width: 100, height: 20 });
  Object.assign(right.style, { x: 200, width: 300, height: 20 });
  const f = fixture(left, right);
  await ui.show(
    h(ScalePanel, {
      document: f.doc,
      selectedIds: [left.id, right.id],
      onApplyOperations: f.editor().apply,
      onExitScale: noop,
    }),
  );
  const width = ui.named("目标宽度");
  await ui.type(width, "25000");
  assert.equal(ui.named("缩放倍率").value, "50");
  await ui.key(width, "Enter");
  assert.equal(f.operations.length, 0);
  assert.equal(width.value, "500");
  assert.ok(
    ui
      .all("div")
      .some(
        (el) =>
          el.getAttribute("role") === "status" &&
          el.textContent?.includes("尺寸限制"),
      ),
  );
  await ui.close();
});

test("layout guide numeric edits stay local until Enter or blur and Escape restores the latest stored value", async (t) => {
  const ui = await mount(t);
  const n = createNode("frame");
  const guide = {
    id: "guide",
    kind: "grid" as const,
    visible: true,
    color: "#123456",
    opacity: 0.5,
    size: 8,
    count: 12,
    gutter: 16,
    offset: 4,
    alignment: "min" as const,
  };
  n.style.layoutGuides = [guide];
  const f = fixture(n);
  const show = () =>
    ui.show(
      h(LayoutGuidesInspector, {
        node: f.historyRef.current.present.nodes[0],
        locked: false,
        onChange: (layoutGuides) => f.editor().update({}, { layoutGuides }),
      }),
    );
  await show();
  await ui.click("展开网格参数");
  const size = ui.named("网格大小");
  for (const key of ["Escape", "Enter"]) {
    for (const raw of ["", "2", "24"]) {
      await ui.type(size, raw);
      assert.equal(size.value, raw);
      assert.equal(f.operations.length, 0);
    }
    await ui.key(size, "Enter", true);
    assert.equal(f.operations.length, 0);
    await ui.key(size, key);
    await show();
    await ui.blur(size);
    assert.equal(size.value, key === "Escape" ? "8" : "24");
    assert.equal(f.operations.length, key === "Escape" ? 0 : 1);
  }
  f.editor().update({}, { layoutGuides: [{ ...guide, kind: "columns" }] });
  await show();
  for (const [label, prop, raw, expected] of [
    ["列数", "count", "4", 4],
    ["列宽", "size", "9.5", 9.5],
    ["网格偏移", "offset", "0", 0],
    ["槽宽", "gutter", "32", 32],
    ["参考网格 1 不透明度", "opacity", "25", 0.25],
  ] as const) {
    const before = f.operations.length,
      el = ui.named(label);
    await ui.type(el, "");
    await ui.blur(el);
    await ui.type(el, raw);
    assert.equal(f.operations.length, before, prop);
    await ui.blur(el);
    await show();
    assert.equal(f.operations.length, before + 1, prop);
    assert.equal(
      f.historyRef.current.present.nodes[0].style.layoutGuides![0][prop],
      expected,
    );
    await ui.type(el, raw);
    await ui.key(el, "Enter");
    assert.equal(f.operations.length, before + 1, prop);
  }
  const count = ui.named("列数");
  await ui.type(count, "30");
  f.editor().update(
    {},
    { layoutGuides: [{ ...guide, kind: "columns", count: 5 }] },
  );
  await show();
  assert.equal(count.value, "30");
  const before = f.operations.length;
  await ui.key(count, "Escape");
  assert.equal(count.value, "5");
  assert.equal(f.operations.length, before);
  await ui.close();
});

test("untouched, normalized and escaped prototype URLs produce zero transactions; Enter saves one change", async (t) => {
  const ui = await mount(t);
  const n = createNode("frame");
  const original = "https://example.org";
  n.interaction = { actions: [{ kind: "openLink", url: original }] };
  const f = fixture(n);
  await ui.show(
    h(PrototypeInspector, { editor: f.editor(), openVariables: noop }),
  );
  const url = ui.named("链接地址");
  url.focus();
  await ui.blur(url);
  await ui.type(url, " " + original + " ");
  await ui.blur(url);
  assert.equal(url.value, original);
  await ui.type(url, original + "/discard");
  await ui.key(url, "Enter", true);
  await ui.key(url, "Escape");
  assert.equal(url.value, original);
  await ui.blur(url);
  assert.equal(f.operations.length, 0);
  assert.deepEqual(f.historyRef.current.present.nodes[0].interaction?.actions, [
    { kind: "openLink", url: original },
  ]);
  await ui.type(url, " " + original + "/saved ");
  await ui.key(url, "Enter");
  assert.deepEqual(f.historyRef.current.present.nodes[0].interaction?.actions, [
    { kind: "openLink", url: original + "/saved" },
  ]);
  assert.equal(f.operations.length, 1);
  await ui.close();
});
