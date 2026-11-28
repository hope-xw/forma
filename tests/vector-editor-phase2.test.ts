import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { DOMParser } from "@xmldom/xmldom";
import { act, createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { commit, travel, type History } from "../src/application/history";
import { commitEditorOperations } from "../src/application/geometry-preview";
import { createNode } from "../src/domain/document";
import {
  createLibraryFromSelection,
  instantiateComponent,
} from "../src/domain/library";
import { createStarter } from "../src/domain/seed";
import {
  identity,
  compose,
  inverse,
  transform,
  type Matrix,
} from "../src/domain/transforms";
import { useEditor, type EditorController } from "../src/editor/useEditor";
import type { EditorFileOptions } from "../src/editor/useDocument";
import {
  getAlignEligibility,
  isEditActionEnabled,
  type ActionEligibilityContext,
} from "../src/editor/actions";
import { ContextMenu } from "../src/editor/ContextMenu";
import { CommandPalette } from "../src/editor/ActionMenu";
import {
  encodeFormaPackage,
  decodeFormaPackage,
} from "../src/infrastructure/forma-package";
import { importFontBytes } from "../src/infrastructure/font-import";
import { editablePaths, evalSegmentPoint } from "../src/domain/vector-path";
import { layoutBounds } from "../src/domain/geometry";
import { runtimeNodes } from "../src/compiler/runtime";
import { DesignNodeView } from "../src/runtime/FormaRuntime";
import { VectorInspector } from "../src/editor/VectorInspector";
import {
  VectorEditor,
  normalizeMarqueeRect,
  resolveAnchorClickSelection,
  segmentPreviewPathData,
} from "../src/editor/VectorEditor";

const at = (a: number) => ({ p: 0, c: 0, a });
for (const [sx, sy, ex, ey] of [
  [10, 20, 70, 90],
  [70, 20, 10, 90],
  [10, 90, 70, 20],
  [70, 90, 10, 20],
]) {
  test(`marquee normalizes (${sx}, ${sy}) to (${ex}, ${ey})`, () => {
    assert.deepEqual(normalizeMarqueeRect({ x: sx, y: sy }, { x: ex, y: ey }), {
      x: 10,
      y: 20,
      width: 60,
      height: 70,
    });
  });
}
test("plain click replaces the selection and defers collapsing a selected group until release", () => {
  const group = [at(1), at(2)];
  assert.deepEqual(resolveAnchorClickSelection(group, at(3), false), {
    onDown: [at(3)],
    onClick: [at(3)],
  });
  assert.deepEqual(resolveAnchorClickSelection(group, at(1), false), {
    onDown: group,
    onClick: [at(1)],
  });
});
test("Shift appends a distinct anchor or defers removing an existing anchor until release", () => {
  const group = [at(0), at(1)];
  for (const pick of [
    { ...at(1), p: 1 },
    { ...at(1), c: 1 },
  ]) {
    const added = [...group, pick];
    assert.deepEqual(resolveAnchorClickSelection(group, pick, true), {
      onDown: added,
      onClick: added,
    });
  }
  assert.deepEqual(resolveAnchorClickSelection(group, at(0), true), {
    onDown: group,
    onClick: [at(1)],
  });
  assert.deepEqual(group, [at(0), at(1)]);
});

const paths = editablePaths({
  width: 100,
  height: 100,
  paths: [
    {
      d: "M0 0 L80 0 C80 20 100 50 80 80 Z M20 20 L30 30",
      fill: false,
      strokeWidth: 1,
    },
  ],
});
test("preview traces exactly the hit line, cubic, or closing segment", () => {
  const preview = (index: number, c = 0) =>
    segmentPreviewPathData(paths, { p: 0, c, index });
  assert.equal(preview(0), "M0 0 L80 0");
  assert.equal(preview(1), "M80 0 C80 20 100 50 80 80");
  assert.equal(preview(2), "M80 80 L0 0");
  assert.equal(preview(0, 1), "M20 20 L30 30");
  assert.equal(preview(1, 1), "");
  assert.equal(preview(0, 2), "");
});

type Props = ComponentProps<typeof VectorEditor>;
function fixture() {
  const node = createNode("vector");
  const box = { x: 0, y: 0, width: 100, height: 100 };
  Object.assign(node.style, box);
  node.vector = {
    width: 100,
    height: 100,
    paths: [{ d: "M0 0L100 0L100 100L0 100Z", fill: true, strokeWidth: 0 }],
  };
  const doc = createStarter();
  doc.nodes = [node];
  const props: Props = {
    editor: {
      doc,
      committed: doc,
      historyRef: { current: { present: doc, past: [], future: [] } },
      hasPreview: false,
      tabActive: true,
      previewRef: { current: null },
      activeEditHandlerRef: { current: null },
      setCanUndoDraft() {},
      tool: "select",
      apply() {},
      attempt: (run) => run(),
      setSelection() {},
    },
    node,
    box,
    viewport: { x: 0, y: 0, zoom: 1 },
    parentAt: () => ({ id: null, matrix: identity }),
    close() {},
    panning: false,
  };
  return props;
}
const bendTip = "拖动曲线段直接拉弯，点击锚点切换平滑或尖角（按住 ⌥ 临时启用）";
test("SSR preserves edit surface, anchor selectors and the seven named toolbar actions", () => {
  const html = renderToStaticMarkup(createElement(VectorEditor, fixture()));
  const doc = new DOMParser().parseFromString(
    "<main>" + html + "</main>",
    "text/html",
  );
  const surface = doc.getElementsByTagName("svg")[0];
  assert.equal(surface.getAttribute("aria-label"), "矢量编辑");
  assert.equal(surface.getAttribute("class"), "vector-surface");
  const anchors = Array.from(surface.getElementsByTagName("circle"));
  assert.equal(anchors.length, 4);
  anchors.forEach((a, i) => {
    assert.equal(a.getAttribute("data-path"), "0");
    assert.equal(a.getAttribute("data-contour"), "0");
    assert.equal(a.getAttribute("data-anchor"), String(i));
    assert.equal(a.getAttribute("class"), "vector-anchor");
    assert.ok(!a.hasAttribute("data-handle"));
  });
  const buttons = new Map(
    Array.from(doc.getElementsByTagName("button"), (b) => [
      b.getAttribute("aria-label"),
      b,
    ]),
  );
  assert.equal(buttons.size, 7);
  for (const name of [
    "插入中点",
    "删除锚点",
    "平滑 / 尖角",
    "闭合 / 断开",
    "从锚点连接分支",
  ]) {
    assert.equal(buttons.get(name)?.hasAttribute("disabled"), true, name);
  }
  assert.equal(buttons.get("完成路径")?.hasAttribute("disabled"), false);
  const bend = buttons.get("弯曲工具");
  assert.equal(bend?.getAttribute("data-tip"), "弯曲工具");
  assert.equal(bend?.getAttribute("data-tip-desc"), bendTip);
  assert.equal(bend?.getAttribute("aria-pressed"), "false");
});
test("SSR keeps the pen drawing surface and finish action", () => {
  const html = renderToStaticMarkup(
    createElement(VectorEditor, { ...fixture(), node: undefined }),
  );
  assert.match(html, /aria-label="钢笔绘制"/);
  assert.match(html, /aria-label="完成路径"/);
  assert.doesNotMatch(html, /aria-label="弯曲工具"/);
});

// Dispatch through React's delegated pointer listeners and the editor's window keyboard listener.
async function mountEditor(
  t: TestContext,
  props = fixture(),
  options: {
    layerMatrix?: Matrix;
    rootMatrix?: Matrix;
    controller?: EditorFileOptions;
  } = {},
) {
  const doc = new DOMParser().parseFromString("<html/>", "text/html");
  const events = new EventTarget();
  const windowEvents = new EventTarget();
  const windowCapture = new EventTarget();
  const win = {
    document: doc,
    HTMLIFrameElement: class {},
    addEventListener: (type: string, handler: EventListener, capture = false) =>
      (capture ? windowCapture : windowEvents).addEventListener(type, handler),
    removeEventListener: (
      type: string,
      handler: EventListener,
      capture = false,
    ) =>
      (capture ? windowCapture : windowEvents).removeEventListener(
        type,
        handler,
      ),
    dispatchEvent: (ev: Event) => {
      windowCapture.dispatchEvent(ev);
      if (!ev.cancelBubble) windowEvents.dispatchEvent(ev);
    },
  };
  let matrixValid = true;
  const measured = (m: Matrix) => ({
    ...m,
    inverse: () => measured(inverse(m)),
    multiply: (n: Matrix) => measured(compose(m, n)),
  });
  const overlayMatrix = measured(options.rootMatrix ?? identity);
  const layerMatrix = measured(
    compose(overlayMatrix, options.layerMatrix ?? identity),
  );
  const create = doc.createElement.bind(doc);
  t.mock.method(doc, "createElement", (tag: string) =>
    Object.assign(create(tag), {
      style: {},
      querySelector: () => null,
      focus() {},
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        right: 200,
        bottom: 200,
        width: 200,
        height: 200,
      }),
    }),
  );
  const createNS = doc.createElementNS.bind(doc);
  const captures = new Set<number>();
  t.mock.method(doc, "createElementNS", (ns: string, tag: string) => {
    const el = createNS(ns, tag);
    Object.defineProperty(el, "dataset", {
      get: () =>
        Object.fromEntries(
          ["path", "contour", "anchor", "handle"]
            .filter((k) => el.hasAttribute("data-" + k))
            .map((k) => [k, el.getAttribute("data-" + k)]),
        ),
    });
    return Object.assign(el, {
      style: {},
      isConnected: true,
      getClientRects: () => [identity],
      getScreenCTM: () => (matrixValid ? overlayMatrix : null),
      setPointerCapture: (id: number) => captures.add(id),
      hasPointerCapture: (id: number) => captures.has(id),
      releasePointerCapture: (id: number) => captures.delete(id),
      closest: (selector: string) =>
        selector === "[data-anchor]" && el.hasAttribute("data-anchor")
          ? el
          : null,
    });
  });
  Object.assign(doc, { querySelector: () => null });
  Object.assign(doc.documentElement, { dataset: { theme: "light" } });
  doc.addEventListener = () => {};
  const host = doc.createElement("div");
  host.addEventListener = events.addEventListener.bind(events);
  const world = doc.createElement("div");
  const layer = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  Object.assign(layer, {
    getScreenCTM: () => (matrixValid ? layerMatrix : null),
  });
  Object.assign(world, { querySelector: () => layer });
  for (const [key, value] of Object.entries({
    document: doc,
    localStorage: { getItem: () => null },
    window: win,
    HTMLElement: class {},
    Element: class {},
    innerWidth: 1280,
    innerHeight: 800,
    requestAnimationFrame: () => 1,
    CSS: { escape: (s: string) => s },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  const apply = t.mock.fn(props.editor.apply);
  const close = t.mock.fn();
  let controller: EditorController;
  function LiveEditor({ next, menu }: { next: Props; menu: boolean }) {
    controller = useEditor({
      ...options.controller,
      active: next.editor.tabActive,
    });
    if (menu)
      return createElement(ContextMenu, {
        editor: controller,
        position: { x: 0, y: 0 },
        close,
      });
    return createElement(VectorEditor, {
      ...next,
      editor: controller,
      worldContainer: world,
      close,
    });
  }
  const show = (next: Props, menu = false) =>
    act(() =>
      root.render(
        options.controller
          ? createElement(LiveEditor, { next, menu })
          : createElement(VectorEditor, {
              ...next,
              worldContainer: world,
              close,
              editor: { ...next.editor, apply },
            }),
      ),
    );
  await show(props);
  const surface = host.getElementsByTagName("svg")[0];
  const currentSurface = () => host.getElementsByTagName("svg")[0];
  const circles = () =>
    Array.from(currentSurface()?.getElementsByTagName("circle") ?? []);
  const active = () =>
    circles()
      .filter((el) => el.getAttribute("data-selected") === "true")
      .map((el) => Number(el.getAttribute("data-anchor")));
  const button = (name: string) => {
    const found = Array.from(host.getElementsByTagName("button")).find(
      (el) => el.getAttribute("aria-label") === name,
    );
    assert.ok(found, name);
    return found;
  };
  async function fire(
    type: string,
    target: Element,
    fields: Record<string, unknown> = {},
  ) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "target", { value: target });
    Object.assign(ev, fields);
    await act(() => {
      (type.startsWith("key") || type === "blur" ? win : events).dispatchEvent(
        ev,
      );
    });
    return ev;
  }
  const pointer = (
    type: string,
    x: number,
    y: number,
    target: Element = currentSurface() ?? surface,
    modifiers = {},
  ) =>
    fire("pointer" + type, target, {
      pointerId: 1,
      button: 0,
      clientX: x,
      clientY: y,
      ...modifiers,
    });
  const key = (key: string, modifiers = {}) =>
    fire("keydown", currentSurface() ?? surface, { key, ...modifiers });
  const click = (name: string) => fire("click", button(name));
  const testId = (id: string) =>
    Array.from(surface.getElementsByTagName("*")).find(
      (el) => el.getAttribute("data-testid") === id,
    );
  const lastPath = () => {
    const ops = apply.mock.calls.at(-1)?.arguments[0];
    assert.equal(ops?.length, 1);
    const op = ops[0];
    assert.ok(op.type === "update" && op.patch?.vector);
    return op.patch.vector.paths[0].d;
  };
  return {
    active,
    host,
    get editor() {
      return controller;
    },
    show,
    button,
    circles,
    click,
    key,
    pointer,
    fire,
    surface,
    apply,
    close,
    lastPath,
    testId,
    invalidateMatrix: () => {
      matrixValid = false;
    },
    unmount: () => act(() => root.unmount()),
  };
}

test("mounted marquee, Shift union, group drag, keyboard and toolbar batch actions", async (t) => {
  const m = await mountEditor(t);
  try {
    await m.pointer("down", 105, 5);
    await m.pointer("move", -5, -5);
    assert.equal(m.testId("vector-marquee")?.getAttribute("width"), "110");
    await m.pointer("up", -5, -5);
    assert.deepEqual(m.active(), [0, 1]);
    assert.equal(m.button("删除锚点").parentNode?.textContent, "已选 2 点");
    assert.equal(m.button("插入中点").hasAttribute("disabled"), true);
    assert.equal(m.button("从锚点连接分支").hasAttribute("disabled"), true);
    assert.ok(
      m.circles()[0].getAttribute("class")?.includes("is-multi-selected"),
    );
    await m.pointer("down", 90, -5, m.surface, { shiftKey: true });
    await m.pointer("up", 110, 110);
    assert.deepEqual(m.active(), [0, 1, 2]);
    await m.pointer("down", 100, 100, m.circles()[2], { shiftKey: true });
    await m.pointer("up", 100, 100);
    assert.deepEqual(m.active(), [0, 1]);
    await m.pointer("down", 0, 0, m.circles()[0]);
    await m.pointer("move", 4, 10);
    await m.pointer("move", 8, 20);
    assert.deepEqual(m.active(), [0, 1]);
    assert.equal(m.circles()[1].getAttribute("cy"), "20");
    assert.equal(m.apply.mock.callCount(), 0);
    await m.pointer("up", 8, 20);
    assert.equal(m.lastPath(), "M8 0 L108 0 L100 80 L0 80 Z");
    await m.key("ArrowRight", { shiftKey: true });
    assert.equal(m.lastPath(), "M10 0 L110 0 L100 100 L0 100 Z");
    await m.click("平滑 / 尖角");
    assert.equal(m.lastPath().match(/C/g)?.length, 3);
    await m.click("删除锚点");
    assert.equal(m.lastPath(), "M100 0 L0 0");
    assert.deepEqual(m.active(), []);
    assert.equal(m.apply.mock.callCount(), 4);
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      assert.ok((await m.key("a", modifier)).defaultPrevented);
      assert.deepEqual(m.active(), [0, 1, 2, 3]);
      await m.key("Backspace");
      assert.equal(m.apply.mock.callCount(), 4); // Retain the last segment.
      await m.pointer("down", 0, 0, m.circles()[0]);
      await m.pointer("up", 0, 0);
      assert.deepEqual(m.active(), [0]);
    }
    await m.key("Delete");
    assert.deepEqual(m.active(), []);
    assert.equal(m.apply.mock.callCount(), 5);
  } finally {
    await m.unmount();
  }
});

test("mounted Bend and temporary Alt show the hit segment and commit once per gesture", async (t) => {
  const m = await mountEditor(t);
  try {
    await m.click("弯曲工具");
    assert.equal(m.button("弯曲工具").getAttribute("aria-pressed"), "true");
    await m.pointer("move", 2, 1);
    assert.ok(!m.testId("vector-bend-preview"));
    await m.pointer("move", 50, 1);
    assert.equal(
      m.testId("vector-bend-preview")?.getAttribute("d"),
      "M0 0 L100 0",
    );
    await m.pointer("down", 50, 0);
    await m.pointer("move", 50, 10);
    await m.pointer("move", 50, 20);
    assert.match(m.testId("vector-bend-preview")!.getAttribute("d")!, /C/);
    assert.equal(m.apply.mock.callCount(), 0);
    await m.pointer("up", 50, 20);
    assert.match(m.lastPath(), /C/);
    assert.equal(m.apply.mock.callCount(), 1);
    await m.pointer("down", 0, 0, m.circles()[0]);
    assert.equal(m.apply.mock.callCount(), 2);
    assert.deepEqual(m.active(), [0]);
    await m.key("Escape");
    assert.equal(m.close.mock.callCount(), 0);
    assert.equal(m.button("弯曲工具").getAttribute("aria-pressed"), "false");
    await m.pointer("move", 100, 50);
    await m.key("Alt", { altKey: true });
    assert.equal(
      m.testId("vector-bend-preview")?.getAttribute("d"),
      "M100 0 L100 100",
    );
    await m.fire("keyup", m.surface, { key: "Alt" });
    assert.ok(!m.testId("vector-bend-preview"));
    await m.pointer("down", 100, 50, m.surface, { altKey: true });
    await m.pointer("move", 85, 50, m.surface, { altKey: true });
    await m.pointer("up", 85, 50);
    assert.equal(m.apply.mock.callCount(), 3);
    await m.key("Escape");
    assert.equal(m.close.mock.callCount(), 1);
  } finally {
    await m.unmount();
  }
});

test("an off-center vertical Bend drag keeps the projected point's x on preview and release", async (t) => {
  const props = fixture();
  const node = props.node!;
  node.vector = {
    width: 800,
    height: 600,
    paths: [{ d: "M0 0 L800 600", strokeWidth: 0, fill: false }],
  };
  Object.assign(node.style, { width: 800, height: 600 });
  props.box = { x: 0, y: 0, width: 800, height: 600 };
  const m = await mountEditor(t, props);
  try {
    await m.click("弯曲工具");
    await m.pointer("down", 19, 8);
    await m.pointer("move", 19, 16);
    const preview = m.testId("vector-bend-preview")!.getAttribute("d")!;
    await m.pointer("up", 19, 16);
    for (const d of [preview, m.lastPath()]) {
      const [a, b] = editablePaths({
        ...node.vector,
        paths: [{ ...node.vector.paths[0], d }],
      })[0].contours[0].anchors;
      // Projection of (19,8) onto the 800-by-600 line is t=.02, (16,12).
      const p = evalSegmentPoint(a, b, 0.02);
      assert.ok(Math.abs(p.x - 16) < 1e-4, JSON.stringify(p));
      assert.ok(p.y > 12, JSON.stringify(p));
    }
    assert.equal(m.apply.mock.callCount(), 1);
  } finally {
    await m.unmount();
  }
});

test("cancel, blur, tool switches and an invalid live matrix discard pending edits", async (t) => {
  const m = await mountEditor(t);
  try {
    await m.pointer("down", -10, -10);
    await m.pointer("move", 105, 10);
    await m.fire("blur", m.surface);
    assert.ok(!m.testId("vector-marquee"));
    await m.pointer("up", 105, 10);
    assert.deepEqual(m.active(), []);
    await m.click("弯曲工具");
    for (const reason of ["pointercancel", "blur", "switch", "matrix"]) {
      await m.pointer("down", 50, 0);
      await m.pointer("move", 55, 25);
      assert.ok(m.testId("vector-bend-preview"));
      if (reason === "switch") {
        await m.click("弯曲工具");
        await m.click("弯曲工具");
      } else if (reason === "matrix") m.invalidateMatrix();
      else await m.fire(reason, m.surface, { pointerId: 1 });
      await m.pointer("up", 55, 25);
      assert.ok(!m.testId("vector-bend-preview"));
      assert.equal(m.apply.mock.callCount(), 0);
    }
  } finally {
    await m.unmount();
  }
});

test("mounted mirrored handles retain their selectors and Alt breaks only the dragged handle", async (t) => {
  const props = fixture();
  props.node!.vector!.paths[0].d =
    "M0 0 C0 0 40 50 50 50 C60 50 100 100 100 100";
  const m = await mountEditor(t, props);
  try {
    await m.pointer("down", 50, 50, m.circles()[1]);
    await m.pointer("up", 50, 50);
    const handle = (name: string) => {
      const el = Array.from(m.surface.getElementsByTagName("rect")).find(
        (r) => r.getAttribute("data-handle") === name,
      );
      assert.ok(el);
      assert.equal(el.getAttribute("data-anchor"), "1");
      return el;
    };
    for (const altKey of [false, true]) {
      await m.pointer("down", 60, 50, handle("outgoing"), { altKey });
      await m.pointer("move", 65, 65, m.surface, { altKey });
      assert.equal(
        handle("incoming").getAttribute("transform"),
        altKey ? "rotate(45 40 50)" : "rotate(45 35 35)",
      );
      await m.pointer("up", 65, 65);
    }
    assert.equal(m.apply.mock.callCount(), 2);
  } finally {
    await m.unmount();
  }
});

test("mounted bend and branch edits roundtrip through document history in single steps", async (t) => {
  const props = fixture();
  const doc = props.editor.doc;
  doc.nodes = [props.node!];
  let history: History = { present: doc, past: [], future: [] };
  props.editor.apply = (ops) => {
    history = commit(
      history,
      commitEditorOperations(history.present, ops, history.present.revision),
    );
  };
  const m = await mountEditor(t, props);
  const refresh = () => {
    props.editor.historyRef.current = history;
    return m.show({
      ...props,
      node: history.present.nodes[0],
      box: history.present.nodes[0].style,
      editor: {
        ...props.editor,
        committed: history.present,
        doc: history.present,
      },
    });
  };
  try {
    await m.click("弯曲工具");
    await m.pointer("down", 50, 0);
    await m.pointer("move", 50, 3);
    await m.pointer("move", 50, 20);
    await m.pointer("up", 50, 20);
    await refresh();
    assert.equal(history.past.length, 1);
    assert.match(history.present.nodes[0].vector!.paths[0].d, /C/);
    history = travel(history, "undo");
    await refresh();
    assert.deepEqual(history.present.nodes[0], doc.nodes[0]);
    await m.key("Escape");
    await m.pointer("down", 0, 0, m.circles()[0]);
    await m.pointer("up", 0, 0);
    await m.click("从锚点连接分支");
    await m.pointer("down", 100, 100, m.circles()[2]);
    await refresh();
    const split = history.present.nodes[0];
    assert.equal(split.vector!.paths.length, 2);
    assert.equal(m.circles().length, 6);
    await m.pointer("down", 100, 100, m.circles()[3]);
    await m.pointer("up", 100, 100);
    await m.key("ArrowRight", { shiftKey: true });
    await refresh();
    history.present.nodes[0].vector!.paths.forEach((path, i) =>
      assert.notEqual(path.d, split.vector!.paths[i].d),
    );
    history = travel(history, "undo");
    assert.deepEqual(history.present.nodes[0], split);
  } finally {
    await m.unmount();
  }
});

test("a short background click preserves a Shift selection and otherwise clears it", async (t) => {
  const m = await mountEditor(t);
  try {
    await m.key("a", { metaKey: true });
    for (const shiftKey of [true, false]) {
      await m.pointer("down", 45, 45, m.surface, { shiftKey });
      await m.pointer("up", 46, 46);
      assert.deepEqual(m.active(), shiftKey ? [0, 1, 2, 3] : []);
      assert.ok(!m.testId("vector-marquee"));
    }
    assert.equal(m.apply.mock.callCount(), 0);
  } finally {
    await m.unmount();
  }
});

test("pen drawing retains draft undo, mirrored tangents and closing on the first anchor", async (t) => {
  const m = await mountEditor(t, { ...fixture(), node: undefined });
  try {
    await m.pointer("down", 0, 0);
    await m.pointer("up", 0, 0);
    await m.pointer("down", 100, 0);
    await m.pointer("move", 110, 10);
    await m.pointer("up", 110, 10);
    await m.pointer("down", 90, 90);
    await m.pointer("up", 90, 90);
    await m.key("z", { metaKey: true });
    assert.equal(m.circles().length, 2);
    assert.equal(m.apply.mock.callCount(), 0);
    await m.pointer("down", 100, 100);
    await m.pointer("up", 100, 100);
    await m.pointer("down", 0, 0, m.circles()[0]);
    const ops = m.apply.mock.calls[0].arguments[0];
    assert.equal(ops.length, 1);
    assert.ok(ops[0].type === "create");
    const path = ops[0].node.vector?.paths[0];
    assert.equal(path?.fill, true);
    assert.match(path.d, /C.*Z$/);
    assert.equal(m.close.mock.callCount(), 1);
  } finally {
    await m.unmount();
  }
});

function liveOptions(props: Props): EditorFileOptions {
  return {
    initialDocument: props.editor.committed,
    initialSelection: props.node ? [props.node.id] : [],
    repository: {
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
    },
  };
}

test("vector gestures use the committed layer and reject a superseded history or pending preview", async (t) => {
  const props = fixture();
  const target = structuredClone(props.node!);
  target.vector!.paths[0].d = "M0 0L20 20";
  const m = await mountEditor(t, { ...props, node: target });
  try {
    assert.equal(m.circles().length, 4);
    for (const guard of ["history", "pending preview", "rendered preview"]) {
      await m.pointer("down", 0, 0, m.circles()[0]);
      await m.pointer("move", 10, 15);
      const preview = structuredClone(props.editor.doc);
      if (guard === "history")
        props.editor.historyRef.current.present = preview;
      else {
        props.editor.previewRef.current = preview;
        if (guard === "rendered preview") {
          await m.show({
            ...props,
            node: target,
            editor: { ...props.editor, doc: preview, hasPreview: true },
          });
          assert.equal(m.circles().length, 0);
        }
      }
      await m.pointer("up", 10, 15);
      assert.equal(m.apply.mock.callCount(), 0, guard);
      props.editor.previewRef.current = null;
      props.editor.historyRef.current.present = props.editor.committed;
      await m.show(props);
      assert.equal(m.circles()[0].getAttribute("cx"), "0");
    }
    await m.pointer("down", 0, 0, m.circles()[0]);
    await m.pointer("up", 10, 15);
    assert.equal(m.apply.mock.callCount(), 1);
  } finally {
    await m.unmount();
  }
});

for (const fillMode of ["widthMode", "heightMode"] as const) {
  test(`nudging all four anchors preserves in-flow ${fillMode} and shifts the painted path`, async (t) => {
    const props = fixture();
    const node = props.node!,
      parent = createNode("frame");
    Object.assign(parent.style, {
      layout: "row",
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      padding: 0,
    });
    node.parentId = parent.id;
    node.style[fillMode] = "fill";
    const base = props.editor.committed;
    base.nodes.unshift(parent);
    const before = layoutBounds(base).get(node.id)!;
    const m = await mountEditor(t, props, { controller: liveOptions(props) });
    try {
      await m.key("a", { metaKey: true });
      assert.deepEqual(m.active(), [0, 1, 2, 3]);
      await m.key("ArrowRight");
      const doc = m.editor.committed;
      const updated = doc.nodes.find((n) => n.id === node.id)!;
      assert.equal(updated.style[fillMode], "fill");
      assert.deepEqual(updated.style, node.style);
      assert.deepEqual(layoutBounds(doc).get(node.id), before);
      assert.deepEqual(
        [
          updated.vector!.width,
          updated.vector!.height,
          updated.vector!.overflowVisible,
        ],
        [100, 100, true],
      );
      const rendered = renderToStaticMarkup(
        createElement(DesignNodeView, { node: runtimeNodes(doc)[0] }),
      );
      const path = new DOMParser()
        .parseFromString(rendered, "text/html")
        .getElementsByTagName("path")[0];
      assert.equal(path.getAttribute("d"), "M1 0 L101 0 L101 100 L1 100 Z");
      assert.equal(m.editor.historyRef.current.past.length, 1);
    } finally {
      await m.unmount();
    }
  });
}

test("a nudge preserves vector rendering flags through a Forma package save and reopen", async (t) => {
  const props = fixture();
  Object.assign(props.node!.vector!, {
    fillFromStyle: true,
    overflowVisible: true,
    stretch: true,
    radial: { kind: "polygon", points: 4 },
  });
  const m = await mountEditor(t, props, { controller: liveOptions(props) });
  try {
    await m.pointer("down", 0, 0, m.circles()[0]);
    await m.pointer("up", 0, 0);
    await m.key("ArrowRight");
    const doc = m.editor.committed;
    assert.equal(m.editor.historyRef.current.past.length, 1);
    for (const scene of [
      doc,
      await decodeFormaPackage(encodeFormaPackage(doc)),
    ]) {
      const v = scene.nodes[0].vector!;
      assert.deepEqual(
        [v.fillFromStyle, v.overflowVisible, v.stretch],
        [true, true, true],
      );
      assert.equal(v.radial, undefined);
      assert.equal(editablePaths(v)[0].contours[0].anchors[0].x, 1);
    }
  } finally {
    await m.unmount();
  }
});

test("deactivating a tab cancels vector capture and leaves keyboard events for the active tab", async (t) => {
  const props = fixture();
  const m = await mountEditor(t, props);
  try {
    for (const gesture of ["marquee", "bend", "anchor"]) {
      if (gesture === "anchor") await m.pointer("down", 0, 0, m.circles()[0]);
      else
        await m.pointer("down", 50, 0, undefined, {
          altKey: gesture === "bend",
        });
      await m.pointer("move", 50, 20, undefined, {
        altKey: gesture === "bend",
      });
      await m.show({ ...props, editor: { ...props.editor, tabActive: false } });
      assert.equal(props.editor.activeEditHandlerRef.current, null);
      for (const key of ["a", "ArrowRight", "Delete", "Escape"]) {
        assert.equal(
          (await m.key(key, { metaKey: key === "a" })).defaultPrevented,
          false,
          key,
        );
      }
      await m.show(props);
      await m.pointer("up", 50, 20);
      assert.equal(m.active().length, gesture === "anchor" ? 1 : 0);
      assert.equal(m.circles()[0].getAttribute("cy"), "0");
      assert.equal(m.button("弯曲工具").getAttribute("aria-pressed"), "false");
    }
    assert.equal(m.apply.mock.callCount(), 0);
    assert.equal(m.close.mock.callCount(), 0);
  } finally {
    await m.unmount();
  }
  assert.equal(props.editor.activeEditHandlerRef.current, null);
});

test("native Select All selects anchors and both Undo entry points exhaust pen anchors before document history", async (t) => {
  const props = fixture();
  props.editor.doc.nodes.push(createNode("rectangle"));
  const m = await mountEditor(t, props, { controller: liveOptions(props) });
  try {
    await act(() => m.editor.perform("selectAll"));
    assert.deepEqual(m.active(), [0, 1, 2, 3]);
    assert.deepEqual(m.editor.selection, [props.node!.id]);
    await m.show({ ...props, node: undefined });
    await m.pointer("down", 10, 10);
    await m.pointer("up", 10, 10);
    assert.equal(m.editor.canUndo, true);
    assert.equal(m.editor.historyRef.current.past.length, 0);
    await act(() => m.editor.perform("undo"));
    assert.equal(m.circles().length, 0);
    assert.equal(m.editor.canUndo, false);
    await act(() =>
      m.editor.apply([
        { type: "update", id: props.node!.id, patch: { name: "renamed" } },
      ]),
    );
    for (const x of [10, 20]) {
      await m.pointer("down", x, 10);
      await m.pointer("up", x, 10);
    }
    const committed = m.editor.committed;
    await act(() => m.editor.perform("undo"));
    assert.equal(m.circles().length, 1);
    await act(() => m.editor.undo());
    assert.equal(m.circles().length, 0);
    assert.equal(m.editor.committed, committed);
    await act(() => m.editor.perform("undo"));
    assert.equal(m.editor.committed.nodes[0].name, props.node!.name);
  } finally {
    await m.unmount();
  }
});

test("45 degree marquee stays in overlay coordinates and includes both visually enclosed anchors", async (t) => {
  const c = Math.SQRT1_2;
  const m = await mountEditor(t, fixture(), {
    layerMatrix: { a: c, b: c, c: -c, d: c, e: 0, f: 0 },
    rootMatrix: { ...identity, a: 2, d: 2, e: 200, f: 10 },
  });
  try {
    // ViewBox corners 1 and 3 project to (+/-70.71, 70.71) in the overlay.
    await m.pointer("down", 50, 140);
    await m.pointer("move", 350, 170);
    const rect = m.testId("vector-marquee")!;
    assert.equal(rect.parentNode, m.surface);
    assert.deepEqual(
      ["x", "y", "width", "height"].map((k) => Number(rect.getAttribute(k))),
      [-75, 65, 150, 15],
    );
    await m.pointer("up", 350, 170);
    assert.deepEqual(m.active(), [1, 3]);
  } finally {
    await m.unmount();
  }
});

for (const flip of [false, true]) {
  test(`ArrowRight nudges one canvas pixel on a 90 degree stretched vector (flipY=${flip})`, async (t) => {
    const props = fixture();
    props.viewport.zoom = 2;
    props.node!.style.rotation = 90;
    props.node!.style.flipY = flip;
    props.node!.style.height = props.box!.height = 50;
    props.node!.vector!.stretch = true;
    props.node!.vector!.paths[0].d = "M0 0L50 50L100 0L100 100L0 100Z";
    const matrix = { a: 0, b: 2, c: flip ? 1 : -1, d: 0, e: 200, f: 5 };
    const m = await mountEditor(t, props, { layerMatrix: matrix });
    try {
      const start = transform(matrix, { x: 50, y: 50 });
      await m.pointer("down", start.x, start.y, m.circles()[1]);
      await m.pointer("up", start.x, start.y);
      for (const d of [1, 10]) {
        await m.key("ArrowRight", { shiftKey: d === 10 });
        const op = m.apply.mock.calls.at(-1)!.arguments[0][0];
        assert.ok(op.type === "update" && op.patch?.vector);
        const moved = transform(
          matrix,
          editablePaths(op.patch.vector)[0].contours[0].anchors[1],
        );
        assert.equal((moved.x - start.x) / props.viewport.zoom, d);
        assert.equal(moved.y, start.y);
      }
    } finally {
      await m.unmount();
    }
  });
}

test("a queued or displayed external preview survives native, keyboard, and in-flight outline commands", async (t) => {
  const props = fixture();
  const vector = props.node!;
  vector.vector!.paths[0].strokeWidth = 2;
  const text = createNode("text");
  text.id = "letters";
  text.text = "AB";
  const bytes = await readFile(
    new URL("./fixtures/forma-geometry-test.ttf", import.meta.url),
  );
  const { id, asset } = await importFontBytes(bytes, "Forma Geometry.ttf");
  text.style.fontFamily = id;
  const base = props.editor.committed;
  base.fonts = { [id]: asset };
  base.nodes.push(text);
  const preview = structuredClone(base);
  preview.name = "AI preview";
  const m = await mountEditor(t, props, { controller: liveOptions(props) });
  try {
    for (const [selected, action] of [
      [vector, "outlineStroke"],
      [text, "outlineText"],
    ] as const) {
      await act(() => m.editor.setSelection([selected.id]));
      assert.ok(isEditActionEnabled(action, m.editor.actionEligibility));
      await act(() => {
        m.editor.setPreview(preview);
        m.editor.perform(action);
      });
      assert.equal(m.editor.hasPreview, true);
      await act(() => m.editor.perform(action));
      await m.key("O", { metaKey: true, shiftKey: true });
      await m.key("ArrowRight");
      assert.equal(m.editor.committed, base);
      assert.equal(m.editor.doc, preview);
      assert.equal(m.editor.historyRef.current.past.length, 0);
      await act(() => m.editor.setPreview(null));
    }
    const { outlineTextNode } =
      await import("../src/infrastructure/text-outline");
    // The second request uses the same embedded font and import; awaiting its
    // result also allows the first request's continuation to run.
    for (const interrupt of ["preview", "history", "none"]) {
      await act(async () => {
        const scene = m.editor.committed;
        m.editor.perform("outlineText");
        if (interrupt === "preview") m.editor.setPreview(preview);
        if (interrupt === "history")
          m.editor.apply([
            { type: "update", id: vector.id, patch: { name: "new base" } },
          ]);
        await outlineTextNode(scene, text.id);
      });
      const layer = m.editor.committed.nodes.find((n) => n.id === text.id)!;
      if (interrupt === "preview") {
        assert.equal(m.editor.doc, preview);
        assert.equal(m.editor.committed, base);
        await act(() => m.editor.setPreview(null));
      } else if (interrupt === "history") {
        assert.equal(layer.type, "text");
        assert.equal(m.editor.historyRef.current.past.length, 1);
      } else {
        assert.equal(layer.type, "vector");
        assert.equal(m.editor.historyRef.current.past.length, 2);
        const output = renderToStaticMarkup(
          createElement(DesignNodeView, {
            node: runtimeNodes(m.editor.committed, ["letters"])[0],
          }),
        );
        const root = new DOMParser().parseFromString(
          output,
          "text/html",
        ).documentElement;
        assert.equal(root.getAttribute("data-design-id"), "letters");
        const svg = root.getElementsByTagName("svg")[0];
        const paths = Array.from(svg.getElementsByTagName("path"));
        const glyphs = paths.filter(
          (path) => path.getAttribute("stroke-width") === "0",
        );
        assert.ok(
          glyphs.reduce(
            (n, path) =>
              n + (path.getAttribute("d")!.match(/z/gi) ?? []).length,
            0,
          ) >= 2,
        );
      }
    }
  } finally {
    await m.unmount();
  }
});

const css = registerHooks({
  load(url, context, next) {
    return url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context);
  },
});
const { Inspector } = await import("../src/editor/Inspector");
css.deregister();

test("Inspector, context menu, command palette and perform agree on normalized roots, flow children, locks and previews", async (t) => {
  const props = fixture();
  const frame = createNode("frame"),
    sibling = createNode("rectangle");
  const absolute = createNode("rectangle", frame.id),
    flow = createNode("rectangle", frame.id);
  const locked = createNode("rectangle");
  frame.style.layout = "row";
  absolute.style.strokeWidth = 2;
  absolute.style.absolutePosition = true;
  absolute.style.x = 30;
  locked.locked = true;
  const base = props.editor.committed;
  base.nodes.push(frame, absolute, flow, sibling, locked);
  const library = createLibraryFromSelection(base, frame.id, "Row");
  const component = library.components[0];
  const instance = instantiateComponent(
    base,
    library,
    component.id,
    component.variants[0].id,
    null,
    { x: 200, y: 200 },
  );
  const doc = commitEditorOperations(base, instance.operations, base.revision);
  const internal = doc.nodes.find((n) => n.parentId === instance.id)!;
  const m = await mountEditor(t, props, {
    controller: { ...liveOptions(props), initialDocument: doc },
  });
  function parse(markup: string) {
    return Array.from(
      new DOMParser()
        .parseFromString("<main>" + markup + "</main>", "text/html")
        .getElementsByTagName("button"),
    );
  }
  try {
    await m.show(props, true);
    for (const scenario of [
      {
        ids: [frame.id, absolute.id, sibling.id],
        align: true,
        reason: "needThree",
        hint: "请同时选中至少 3 个同级或独立图层",
      },
      {
        ids: [absolute.id],
        align: true,
        reason: "needThree",
        hint: "请同时选中至少 3 个同级或独立图层",
      },
      {
        ids: [flow.id],
        align: false,
        reason: "inFlow",
        hint: "自动布局内请调整布局对齐，或开启绝对定位后对齐",
      },
      {
        ids: [locked.id, sibling.id],
        align: false,
        reason: "locked",
        hint: "选中包含锁定图层，请先解锁",
      },
      {
        ids: [internal.id],
        align: false,
        reason: "instance",
        hint: "组件实例内部图层不可直接对齐",
      },
      {
        ids: [sibling.id],
        align: false,
        reason: "needMore",
        hint: "请选中至少 2 个图层或容器内子图层",
      },
      {
        ids: [absolute.id],
        align: false,
        reason: "preview",
        hint: "请先确认或取消当前预览",
      },
    ]) {
      await act(() => {
        m.editor.setSelection(scenario.ids);
        m.editor.setPreview(
          scenario.reason === "preview" ? structuredClone(doc) : null,
        );
      });
      const e = m.editor;
      const ctx = e.actionEligibility;
      assert.deepEqual(getAlignEligibility(e.doc, e.selection, e.hasPreview), {
        canAlign: scenario.align,
        canDistribute: false,
        reason: scenario.reason,
      });
      assert.equal(isEditActionEnabled("alignLeft", ctx), scenario.align);
      assert.equal(isEditActionEnabled("distributeX", ctx), false);
      const panel = parse(
        renderToStaticMarkup(createElement(Inspector, { editor: e })),
      );
      const align = panel.find(
        (b) => b.getAttribute("aria-label") === "左对齐",
      )!;
      const distribute = panel.find(
        (b) => b.getAttribute("aria-label") === "水平分布",
      )!;
      assert.equal(align.hasAttribute("disabled"), !scenario.align);
      assert.equal(distribute.hasAttribute("disabled"), true);
      assert.equal(
        (scenario.align ? distribute : align).getAttribute("data-tip-desc"),
        scenario.hint,
      );
      const palette = parse(
        renderToStaticMarkup(
          createElement(CommandPalette, { editor: e, close() {} }),
        ),
      );
      for (const id of [
        "alignLeft",
        "distributeX",
        "outlineStroke",
        "outlineText",
      ] as const) {
        const item = palette.find((b) => b.getAttribute("id") === "cmd-" + id)!;
        assert.equal(
          item.hasAttribute("disabled"),
          !isEditActionEnabled(id, ctx),
          id,
        );
      }
      assert.ok(
        palette
          .find((b) => b.getAttribute("id") === "cmd-outlineText")!
          .hasAttribute("disabled"),
      );
      const strokeEnabled =
        scenario.ids.length === 1 &&
        scenario.ids[0] === absolute.id &&
        !e.hasPreview;
      assert.equal(
        palette
          .find((b) => b.getAttribute("id") === "cmd-outlineStroke")!
          .hasAttribute("disabled"),
        !strokeEnabled,
      );
      const buttons = () => Array.from(m.host.getElementsByTagName("button"));
      const category = buttons().find(
        (b) => b.getAttribute("data-category") === "对齐与分布",
      );
      if (category) {
        await m.fire("click", category);
        assert.equal(
          buttons()
            .find((b) => b.textContent === "左对齐")!
            .hasAttribute("disabled"),
          !scenario.align,
        );
        assert.ok(!buttons().some((b) => b.textContent === "水平等距分布"));
      } else assert.equal(scenario.align, false);
      await act(() => e.perform("distributeX"));
      assert.equal(m.editor.committed, doc);
      if (!scenario.align) {
        await act(() => e.perform("alignLeft"));
        assert.equal(m.editor.committed, doc);
        assert.equal(m.editor.doc, e.doc);
      }
    }
    await act(() => m.editor.setPreview(null));
    await act(() => m.editor.perform("alignLeft"));
    assert.equal(m.editor.error, "");
    assert.equal(
      m.editor.committed.nodes.find((n) => n.id === absolute.id)!.style.x,
      0,
    );
    assert.equal(m.editor.historyRef.current.past.length, 1);
  } finally {
    await m.unmount();
  }
});

test("Vector Inspector honors the shared outline eligibility while a proposal is displayed", async (t) => {
  const props = fixture();
  const node = props.node!;
  node.vector!.paths[0].strokeWidth = 2;
  const m = await mountEditor(t, props, { controller: liveOptions(props) });
  try {
    for (const preview of [null, structuredClone(props.editor.doc), null]) {
      await act(() => m.editor.setPreview(preview));
      const markup = renderToStaticMarkup(
        createElement(VectorInspector, { node, editor: m.editor }),
      );
      const button = Array.from(
        new DOMParser()
          .parseFromString(markup, "text/html")
          .getElementsByTagName("button"),
      ).find((b) => b.getAttribute("aria-label") === "轮廓化描边")!;
      assert.equal(button.hasAttribute("disabled"), preview !== null);
      assert.equal(
        button.hasAttribute("disabled"),
        !isEditActionEnabled("outlineStroke", m.editor.actionEligibility),
      );
    }
  } finally {
    await m.unmount();
  }
});

test("layer ordering operates within each selected child's frame", async (t) => {
  const props = fixture();
  const frames = [createNode("frame"), createNode("frame")];
  const children = frames.map((frame) => [
    createNode("rectangle", frame.id),
    createNode("rectangle", frame.id),
  ]);
  props.editor.committed.nodes.push(...frames, ...children.flat());
  const m = await mountEditor(t, props, { controller: liveOptions(props) });
  try {
    await act(() => m.editor.setSelection(children.map(([first]) => first.id)));
    for (const action of ["group", "wrapFrame", "autoLayout"] as const)
      assert.equal(
        isEditActionEnabled(action, m.editor.actionEligibility),
        false,
        action,
      );
    for (const action of ["front", "back", "forward", "backward"] as const) {
      assert.equal(
        isEditActionEnabled(action, m.editor.actionEligibility),
        true,
        action,
      );
      await act(() => m.editor.perform(action));
      for (const [index, frame] of frames.entries()) {
        const ids = children[index].map((child) => child.id);
        assert.deepEqual(
          m.editor.committed.nodes
            .filter((n) => n.parentId === frame.id)
            .map((n) => n.id),
          action === "front" || action === "forward" ? ids.reverse() : ids,
        );
      }
    }
    assert.equal(m.editor.historyRef.current.past.length, 4);
  } finally {
    await m.unmount();
  }
});

test("edit command eligibility accounts for empty, protected and compatible selections", () => {
  const doc = createStarter();
  const frame = createNode("frame");
  const group = createNode("group");
  const a = createNode("rectangle"),
    b = createNode("rectangle");
  const child = createNode("text", frame.id);
  const instance = createNode("frame"),
    internal = createNode("ellipse", instance.id);
  instance.instance = {
    libraryId: "lib",
    componentId: "component",
    variantId: "variant",
  };
  a.style.strokeWidth = 2;
  child.text = "AB";
  doc.nodes = [frame, group, a, b, child, instance, internal];
  const ctx: ActionEligibilityContext = {
    doc,
    selection: [],
    canUndo: false,
    canRedo: false,
    hasSmartGrid: false,
    componentUnavailable: false,
    canPasteStyle: false,
  };
  const selected = { ...ctx, selection: [a.id, b.id] };
  const three = { ...ctx, selection: [a.id, b.id, group.id] };
  assert.deepEqual(getAlignEligibility(doc, three.selection), {
    canAlign: true,
    canDistribute: true,
    reason: "ok",
  });
  for (const id of ["distributeX", "distributeY"] as const)
    assert.ok(isEditActionEnabled(id, three));
  const lockedChild = { ...ctx, selection: [child.id] };
  frame.locked = true;
  for (const id of [
    "cut",
    "delete",
    "duplicate",
    "group",
    "wrapFrame",
    "autoLayout",
    "back",
    "front",
    "forward",
    "backward",
    "mask",
    "union",
    "subtract",
    "intersect",
    "exclude",
  ] as const) {
    assert.equal(isEditActionEnabled(id, selected), true, id);
    for (const denied of [
      ctx,
      lockedChild,
      { ...selected, hasPreview: true },
      { ...ctx, selection: [internal.id] },
    ])
      assert.equal(isEditActionEnabled(id, denied), false, id);
  }
  for (const id of ["hide", "rename", "lock", "pasteStyle"] as const)
    assert.equal(
      isEditActionEnabled(id, { ...lockedChild, canPasteStyle: true }),
      false,
      id,
    );
  assert.equal(
    isEditActionEnabled("lock", { ...ctx, selection: [frame.id] }),
    true,
  );
  assert.equal(getAlignEligibility(doc, [internal.id]).reason, "instance");
  assert.equal(
    isEditActionEnabled("autoLayout", { ...ctx, selection: [instance.id] }),
    false,
  );
  const single = { ...ctx, selection: [a.id] };
  assert.equal(isEditActionEnabled("outlineStroke", single), true);
  assert.equal(isEditActionEnabled("outlineText", single), false);
  assert.equal(isEditActionEnabled("outlineText", lockedChild), false);
  assert.equal(isEditActionEnabled("outlineStroke", selected), false);
  assert.equal(isEditActionEnabled("ungroup", single), false);
  assert.equal(
    isEditActionEnabled("ungroup", { ...ctx, selection: [group.id] }),
    true,
  );
  assert.equal(
    isEditActionEnabled("releaseMask", { ...ctx, selection: [group.id] }),
    false,
  );
  group.maskSourceId = a.id;
  assert.equal(
    isEditActionEnabled("releaseMask", { ...ctx, selection: [group.id] }),
    true,
  );
  assert.equal(isEditActionEnabled("createComponent", single), true);
  assert.equal(
    isEditActionEnabled("createComponent", {
      ...single,
      componentUnavailable: true,
    }),
    false,
  );
  for (const [id, flag] of [
    ["undo", "canUndo"],
    ["redo", "canRedo"],
    ["tidy", "hasSmartGrid"],
    ["pasteStyle", "canPasteStyle"],
  ] as const) {
    assert.equal(isEditActionEnabled(id, single), false, id);
    assert.equal(
      isEditActionEnabled(id, { ...single, [flag]: true }),
      true,
      id,
    );
    assert.equal(
      isEditActionEnabled(id, { ...single, [flag]: true, hasPreview: true }),
      false,
      id,
    );
  }
});
