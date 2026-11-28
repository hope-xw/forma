import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { act, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  computeAnchoredPopoverLayout as layout,
  PopoverDocumentSessionContext,
} from "../src/editor/useAnchoredPopover";
import { useModalDialog } from "../src/editor/useModalDialog";
import { ToastHost } from "../src/editor/ToastHost";
import { ColorField } from "../src/editor/ColorField";
import { FileColorContext } from "../src/editor/ColorProfileDialog";
import { InstanceProperties } from "../src/editor/ComponentProperties";
import { createLibraryFromSelection } from "../src/domain/library";
import {
  ModeSelectors,
  StyleBinding,
  TokenBinding,
} from "../src/editor/TokenBinding";
import { TooltipHost } from "../src/editor/TooltipHost";
import type { EditorController } from "../src/editor/useEditor";
import { convertColor } from "../src/domain/color-profile";
import { contrastRatio } from "../src/domain/design-lint";
import { createStarter } from "../src/domain/seed";

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}
for (const [viewportWidth, viewportHeight] of [
  [1440, 900],
  [1280, 720],
  [1024, 600],
  [1024, 480],
]) {
  test(`all four edges stay padded at ${viewportWidth}×${viewportHeight}`, () => {
    for (const width of [84, 264, viewportWidth - 24, viewportWidth + 70]) {
      for (const height of [
        45,
        264,
        viewportHeight - 24,
        viewportHeight + 70,
      ]) {
        for (const preferredSide of ["left", "bottom"] as const) {
          for (const x of [-50, 13.75, viewportWidth / 2, viewportWidth - 18]) {
            for (const y of [
              -20,
              12.25,
              viewportHeight / 2,
              viewportHeight + 10,
            ]) {
              for (const draggedPosition of [
                undefined,
                { left: -9000, top: -9000 },
                { left: 9000, top: 9000 },
              ]) {
                const { left, top, maxHeight, maxWidth } = layout({
                  triggerRect: rect(x, y, 32, 24),
                  popRect: { width, height },
                  viewportWidth,
                  viewportHeight,
                  preferredSide,
                  draggedPosition,
                });
                assert.ok(top >= 12 && left >= 12);
                assert.ok(
                  top + Math.min(height, maxHeight) <= viewportHeight - 12,
                );
                assert.ok(
                  left + Math.min(width, maxWidth) <= viewportWidth - 12,
                );
                assert.equal(
                  maxHeight,
                  Math.max(160, Math.floor(viewportHeight - top - 12)),
                );
                assert.equal(maxWidth, viewportWidth - 24);
              }
            }
          }
        }
      }
    }
  });
}
test("side selection preserves the gap, flips above, and shifts an oversized picker up", () => {
  const base = {
    viewportWidth: 1024,
    viewportHeight: 480,
    popRect: { width: 260, height: 200 },
    triggerRect: rect(734, 30, 30, 20),
  };
  assert.equal(layout(base).left, 466);
  assert.equal(
    layout({ ...base, triggerRect: rect(100, 30, 30, 20) }).left,
    138,
  );
  assert.equal(layout({ ...base, preferredSide: "bottom" }).left, 504);
  assert.equal(layout({ ...base, preferredSide: "bottom" }).top, 58);
  assert.equal(
    layout({
      ...base,
      preferredSide: "bottom",
      triggerRect: rect(550, 30, 500, 20),
    }).left,
    550,
  );
  assert.equal(
    layout({
      ...base,
      preferredSide: "bottom",
      triggerRect: rect(25, 305, 20, 30),
    }).left,
    25,
  );
  assert.equal(
    layout({
      ...base,
      preferredSide: "bottom",
      triggerRect: rect(25, 305, 20, 30),
    }).top,
    97,
  );
  assert.equal(
    layout({ ...base, triggerRect: rect(25, 425, 20, 30) }).top,
    268,
  );
  assert.equal(
    layout({
      ...base,
      preferredSide: "bottom",
      popRect: { width: 260, height: 400 },
      triggerRect: rect(300, 200, 20, 30),
    }).top,
    68,
  );
});

function editorFixture() {
  const doc = createStarter();
  return {
    doc,
    committed: doc,
    selected: doc.nodes.slice(0, 2),
    previewRef: { current: null },
  } as EditorController;
}

test("mixed style IDs and partially bound selections both expose the Mixed pill and detach action", () => {
  const editor = editorFixture();
  for (const second of [undefined, "second"]) {
    editor.selected[0].styleBindings = { paint: "first" };
    editor.selected[1].styleBindings = { paint: second };
    const props = { editor, kind: "paint" as const };
    const body = renderToStaticMarkup(
      h(StyleBinding, { ...props, placement: "body" }),
    );
    assert.match(body, /selected="">Mixed</);
    assert.match(body, /aria-label="解除paint样式"/);
    assert.equal(
      renderToStaticMarkup(h(StyleBinding, { ...props, placement: "header" })),
      "",
    );
  }
  editor.selected.forEach((node) => {
    delete node.styleBindings;
  });
  assert.equal(
    renderToStaticMarkup(
      h(StyleBinding, { editor, kind: "paint", placement: "body" }),
    ),
    "",
  );
  assert.match(
    renderToStaticMarkup(
      h(StyleBinding, { editor, kind: "paint", placement: "header" }),
    ),
    /aria-haspopup="dialog"/,
  );
});

test("closed token trigger skips enumerating variables and is disabled during an external preview", () => {
  const editor = editorFixture();
  editor.doc = { ...editor.committed };
  editor.previewRef.current = editor.doc;
  editor.doc.designSystem = {
    ...editor.doc.designSystem!,
    variables: new Proxy(
      {},
      {
        ownKeys() {
          throw Error("filtered while closed");
        },
      },
    ),
  };
  const html = renderToStaticMarkup(
    h(TokenBinding, { editor, property: "fill" }),
  );
  for (const attribute of [
    'aria-expanded="false"',
    'aria-haspopup="dialog"',
    'disabled=""',
  ])
    assert.ok(html.includes(attribute));
});

// React mounts the real components. Only browser services (layout rectangles,
// focus, event delivery, timers, observer notifications) are supplied by the test.
async function mount(t: TestContext) {
  const doc = new DOMParser().parseFromString("<html/>", "text/html");
  const events = new WeakMap<EventTarget, EventTarget>();
  const boxes = new Map<Element, ReturnType<typeof rect>>();
  const observers = new Map<Element, Set<() => void>>();
  const captured = new Map<Element, number>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let focused: Element | null = null;
  const descendants = (el: Element) => Array.from(el.getElementsByTagName("*"));
  const attachEvents = (el: EventTarget) => {
    const target = new EventTarget();
    events.set(el, target);
    Object.assign(el, {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    });
  };
  const fire = (
    source: EventTarget,
    type: string,
    target: EventTarget = source,
    fields = {},
  ) => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "target", { value: target });
    Object.assign(ev, fields);
    (events.get(source) ?? source).dispatchEvent(ev);
  };
  function matches(el: Element, selector: string) {
    if (selector.startsWith("."))
      return el.getAttribute("class")?.split(" ").includes(selector.slice(1));
    if (selector === '[aria-modal="true"]')
      return el.getAttribute("aria-modal") === "true";
    if (selector === "[data-tip]") return el.hasAttribute("data-tip");
    if (selector === "[hidden]") return el.hasAttribute("hidden");
    if (selector === "[inert]") return el.hasAttribute("inert");
    return el.tagName === selector.split(":")[0];
  }
  function decorate(el: Element) {
    attachEvents(el);
    const style = {
      setProperty() {},
      removeProperty() {},
      left: "",
      top: "",
      maxWidth: "",
      maxHeight: "",
    };
    Object.defineProperties(el, {
      isConnected: { get: () => descendants(doc.documentElement).includes(el) },
      options: { get: () => el.getElementsByTagName("option") },
    });
    return Object.assign(el, {
      style,
      dataset: new Proxy<Record<string, string>>(
        {},
        {
          get: (target, key: string) =>
            target[key] ??
            el.getAttribute(
              "data-" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()),
            ) ??
            undefined,
        },
      ),
      focus() {
        focused = el;
        fire(doc, "focusin", el);
      },
      blur() {
        focused = null;
        fire(host.contains(el) ? host : body, "focusout", el);
      },
      select() {},
      matches: (selector: string) =>
        selector === ":focus-visible" || Boolean(matches(el, selector)),
      contains: (target: Element | null) =>
        target === el || descendants(el).includes(target!),
      closest(selector: string) {
        for (
          let n: Element | null = el;
          n && n.nodeType === 1;
          n = n.parentNode as Element | null
        )
          if (selector.split(",").some((s) => matches(n!, s.trim()))) return n;
        return null;
      },
      querySelectorAll: (selector: string) =>
        descendants(el).filter((n) =>
          selector.split(",").some((s) => matches(n, s.trim())),
        ),
      getBoundingClientRect() {
        const box = boxes.get(el) ?? rect(0, 0, 260, 160);
        const w = Math.min(box.width, parseFloat(style.maxWidth) || Infinity);
        const h = Math.min(box.height, parseFloat(style.maxHeight) || Infinity);
        return rect(
          parseFloat(style.left) || box.left,
          parseFloat(style.top) || box.top,
          w,
          h,
        );
      },
      getClientRects: () => [rect(0, 0, 20, 20)],
      setPointerCapture: (id: number) => captured.set(el, id),
      hasPointerCapture: (id: number) => captured.get(el) === id,
      releasePointerCapture: () => captured.delete(el),
    });
  }
  attachEvents(doc);
  decorate(doc.documentElement);
  const create = doc.createElement.bind(doc);
  t.mock.method(doc, "createElement", (name: string) => decorate(create(name)));
  const createNS = doc.createElementNS.bind(doc);
  t.mock.method(doc, "createElementNS", (ns: string, name: string) =>
    decorate(createNS(ns, name)),
  );
  const body = doc.createElement("body");
  doc.documentElement.appendChild(body);
  Object.defineProperties(doc, {
    oninput: { value: null },
    body: { value: body },
    activeElement: { get: () => (focused?.isConnected ? focused : body) },
  });
  doc.querySelectorAll = body.querySelectorAll;
  const host = doc.createElement("div");
  body.appendChild(host);
  const win = Object.assign(new EventTarget(), {
    document: doc,
    innerWidth: 1024,
    innerHeight: 480,
    getComputedStyle: (el: HTMLElement) => el.style,
    HTMLIFrameElement: class {},
    setTimeout,
    clearTimeout,
  });
  class Observer {
    private targets = new Set<Element>();
    constructor(private callback: () => void) {}
    observe(el: Element) {
      const list = observers.get(el) ?? new Set();
      list.add(this.callback);
      observers.set(el, list);
      this.targets.add(el);
    }
    disconnect() {
      for (const el of this.targets) observers.get(el)?.delete(this.callback);
      this.targets.clear();
    }
  }
  const globals = {
    requestAnimationFrame(callback: FrameRequestCallback) {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
    window: win,
    document: doc,
    Element: body.constructor,
    Node: body.constructor,
    HTMLElement: body.constructor,
    ResizeObserver: Observer,
    MutationObserver: Observer,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, globals);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  t.after(async () => {
    try {
      await act(() => root.unmount());
    } finally {
      for (const key of Object.keys(globals)) {
        if (previous[key])
          Object.defineProperty(globalThis, key, previous[key]);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  function find(attr: string, value: string) {
    const el = descendants(body).find((n) => n.getAttribute(attr) === value);
    assert.ok(el, attr + "=" + value);
    return el as HTMLElement;
  }
  return {
    root,
    body,
    host,
    win,
    boxes,
    doc,
    fire,
    find,
    captured,
    frames,
    paint() {
      for (const [id, run] of [...frames]) {
        frames.delete(id);
        run(performance.now());
      }
    },
    observers,
    resize(el: Element) {
      for (const update of [...(observers.get(el) ?? [])]) update();
    },
  };
}

test("R2-P2-3: an initially unmeasured trigger gets one observed layout frame to position its picker", async (t) => {
  const m = await mount(t);
  await act(() =>
    m.root.render(
      h(ColorField, { label: "填充", color: "#123456", onChange() {} }),
    ),
  );
  const trigger = m.find("aria-label", "编辑填充颜色");
  const toggle = () => act(() => m.fire(m.host, "click", trigger));
  const zero = rect(0, 0, 0, 0);
  m.boxes.set(trigger, zero);
  await toggle();
  const popup = m.find("class", "color-popover");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.ok(m.observers.get(trigger)?.size);
  m.resize(trigger);
  m.resize(popup);
  assert.equal(m.frames.size, 1);
  m.boxes.set(trigger, rect(740, 120, 20, 20));
  await act(() => m.paint());
  assert.equal(m.find("class", "color-popover"), popup);
  assert.deepEqual([popup.style.left, popup.style.top], ["472px", "120px"]);
  await toggle();
  m.boxes.set(trigger, zero);
  await toggle();
  await act(() => m.paint());
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(m.frames.size, 0);
  await toggle();
  assert.equal(m.frames.size, 1);
  await toggle();
  assert.equal(m.frames.size, 0, "closing cancels the pending layout retry");
  trigger.setAttribute("hidden", "");
  await toggle();
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(m.frames.size, 0);
});

test("color picker follows scroll and content growth, clamps each captured move and resize, and restores focus", async (t) => {
  const m = await mount(t);
  await act(() =>
    m.root.render(
      h(ColorField, { label: "填充", color: "#994411", onChange() {} }),
    ),
  );
  const trigger = m.find("aria-label", "编辑填充颜色");
  m.boxes.set(trigger, rect(785, 395, 20, 20));
  await act(() => m.fire(m.host, "click", trigger));
  const popup = m.find("class", "color-popover"),
    header = m.find("class", "panel-heading");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.ok(m.observers.get(trigger)?.size && m.observers.get(popup)?.size);
  assert.equal(popup.style.left, "517px");
  assert.equal(popup.style.top, "308px");
  m.boxes.set(trigger, rect(740, 120, 20, 20));
  m.win.dispatchEvent(new Event("scroll"));
  assert.equal(popup.style.left, "472px");
  assert.equal(popup.style.top, "120px");
  m.boxes.set(popup, rect(0, 0, 264, 400));
  m.resize(popup);
  assert.equal(popup.style.top, "68px");
  const pointer = (x: number, y: number) => ({
    button: 0,
    pointerId: 3,
    clientX: x,
    clientY: y,
  });
  await act(() => m.fire(m.body, "pointerdown", header, pointer(500, 90)));
  assert.equal(m.captured.get(header), 3);
  m.fire(header, "pointermove", header, pointer(3000, 3000));
  assert.equal(popup.style.left, "748px");
  assert.equal(popup.style.top, "68px");
  m.fire(header, "pointermove", header, pointer(2999, 2999));
  assert.equal(popup.style.left, "747px");
  assert.equal(popup.style.top, "67px");
  m.win.innerWidth = 810;
  m.win.dispatchEvent(new Event("resize"));
  assert.equal(popup.style.left, "534px");
  m.fire(header, "pointercancel", header, pointer(0, 0));
  assert.equal(m.captured.size, 0);
  m.fire(header, "pointermove", header, pointer(1, 1));
  assert.equal(popup.style.left, "534px");
  const close = m.find("aria-label", "关闭颜色选择器");
  close.focus();
  await act(() => m.fire(m.body, "click", close));
  assert.equal(m.doc.activeElement, trigger);
  assert.equal(m.observers.get(popup)?.size, 0);
});

for (const surface of ["anchored picker", "standalone modal"] as const) {
  test(`P0-1: ${surface} skips focus restoration to a CSS-hidden trigger with a layout box`, async (t) => {
    const m = await mount(t);
    function Dialog({ open }: { open: boolean }) {
      const ref = useModalDialog(open, () => {});
      return h(
        "div",
        null,
        h("button", { "aria-label": "Open" }),
        open &&
          h("div", { ref, role: "dialog", "aria-modal": true }, h("button")),
      );
    }
    const picker = surface === "anchored picker";
    const render = (open: boolean) =>
      act(() =>
        m.root.render(
          picker
            ? h(ColorField, { label: "填充", color: "#111111", onChange() {} })
            : h(Dialog, { open }),
        ),
      );
    await render(false);
    const trigger = m.find("aria-label", picker ? "编辑填充颜色" : "Open");
    trigger.focus();
    if (picker) await act(() => m.fire(m.host, "click", trigger));
    else await render(true);
    const dialog = m.find("role", "dialog");
    assert.ok(dialog.contains(m.doc.activeElement));
    trigger.style.visibility = "hidden";
    assert.ok(trigger.getClientRects()[0].width > 0);
    const focus = t.mock.method(trigger, "focus");
    if (picker)
      await act(() =>
        m.fire(m.body, "click", m.find("aria-label", "关闭颜色选择器")),
      );
    else await render(false);
    assert.equal(dialog.isConnected, false);
    assert.equal(focus.mock.callCount(), 0);
  });
}

test("alpha draft rolls back invalid entries and commits a valid integer on blur; P3 WCAG uses converted colors", async (t) => {
  const m = await mount(t);
  const onChange = t.mock.fn(),
    onCancelPreview = t.mock.fn();
  const color = "#c48844",
    background = "#477d89";
  await act(() =>
    m.root.render(
      h(
        FileColorContext.Provider,
        { value: "display-p3" },
        h(ColorField, {
          label: "填充",
          color,
          contrastAgainst: background,
          alpha: 1,
          onChange,
          onCancelPreview,
        }),
      ),
    ),
  );
  await act(() =>
    m.fire(m.host, "click", m.find("aria-label", "编辑填充颜色")),
  );
  const contrast = m.find("aria-label", "WCAG 对比度检查");
  const expected = contrastRatio(
    convertColor(color, "display-p3", "srgb"),
    convertColor(background, "display-p3", "srgb"),
  ).toFixed(2);
  assert.ok(contrast.textContent?.includes(expected + ":1"));
  const input = m.find("aria-label", "颜色不透明度百分比") as HTMLInputElement;
  for (const value of ["150", "", "abc", "40.5", "-2"]) {
    input.value = value;
    await act(() => m.fire(m.body, "focusout", input));
    assert.equal(input.value, "100");
    assert.equal(onChange.mock.callCount(), 0);
  }
  input.value = "62";
  await act(() => m.fire(m.body, "keydown", input, { key: "Enter" }));
  assert.deepEqual(onChange.mock.calls[0].arguments, [color, 0.62, "alpha"]);
  const swatch = m.find("aria-label", "使用颜色 #ffffff");
  assert.equal(swatch.getAttribute("data-tip"), "#ffffff");
  const slider = m.find("aria-label", "颜色透明度");
  await act(() => m.fire(m.body, "pointercancel", slider));
  assert.equal(onCancelPreview.mock.callCount(), 0);
  await act(() => m.fire(m.body, "pointerdown", slider));
  await act(() => m.fire(m.body, "pointercancel", slider));
  assert.equal(onCancelPreview.mock.callCount(), 1);
});

test("toast stack anchors, avoids a dragged picker, keeps compatibility selectors and deduplicates messages", async (t) => {
  const m = await mount(t);
  const anchor = m.doc.createElement("main");
  m.body.appendChild(anchor);
  m.boxes.set(anchor, rect(256, 44, 512, 436));
  const popup = m.doc.createElement("div");
  popup.setAttribute("class", "color-popover");
  m.body.appendChild(popup);
  m.boxes.set(popup, rect(700, 50, 260, 405));
  const props = {
    error: "保存失败",
    status: "已保存",
    notice: "记忆已更新",
    anchorRef: { current: anchor },
  };
  await act(() => m.root.render(h(ToastHost, props)));
  const host = m.find("class", "forma-toast-host"),
    stack = m.find("class", "forma-toast-stack");
  assert.equal(host.style.left, "512px");
  assert.equal(host.style.top, "56px");
  assert.equal(host.style.maxWidth, "420px");
  assert.equal(stack.style.left, "calc(50% + 0px)");
  const cards = () =>
    Array.from(m.body.getElementsByTagName("div")).filter((el) =>
      el.hasAttribute("data-kind"),
    );
  assert.deepEqual(
    cards().map((el) => el.getAttribute("role")),
    ["alert", "status", "status"],
  );
  assert.equal(
    cards()[0].getAttribute("class"),
    "forma-toast forma-toast-error toast",
  );
  assert.equal(
    cards()[1].getAttribute("class"),
    "forma-toast forma-toast-info toast project-status-toast",
  );
  m.boxes.set(popup, rect(520, 50, 260, 405));
  m.resize(popup);
  // The stack ends four pixels before the picker's left edge.
  assert.equal(stack.style.left, "calc(50% + -120px)");
  assert.equal(stack.style.maxWidth, "248px");
  await act(() => m.fire(m.host, "click", m.find("aria-label", "关闭错误")));
  assert.equal(cards().length, 2);
  await act(() =>
    m.root.render(h(ToastHost, { ...props, status: props.notice })),
  );
  assert.equal(cards().length, 1);
  await act(() =>
    m.fire(m.host, "click", m.find("aria-label", "关闭项目记忆提示")),
  );
  assert.equal(cards().length, 0);
});

test("status timer pauses across hover and focus, resumes its remaining time and restarts for replacement text", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 15000 });
  t.mock.method(performance, "now", () => Date.now());
  const m = await mount(t);
  const onDismissStatus = t.mock.fn();
  const show = (status: string) =>
    act(() => m.root.render(h(ToastHost, { status, onDismissStatus })));
  await show("A");
  const card = m.find("data-kind", "status");
  assert.equal(m.find("class", "forma-toast-host").style.top, "52px");
  await act(() => t.mock.timers.tick(3000));
  m.fire(card, "mouseenter");
  m.fire(card, "focusin");
  m.fire(card, "mouseleave");
  await act(() => t.mock.timers.tick(8000));
  assert.equal(onDismissStatus.mock.callCount(), 0);
  m.fire(card, "focusout");
  await act(() => t.mock.timers.tick(1499));
  assert.equal(onDismissStatus.mock.callCount(), 0);
  await show("B");
  await act(() => t.mock.timers.tick(4499));
  assert.equal(onDismissStatus.mock.callCount(), 0);
  await act(() => t.mock.timers.tick(1));
  assert.equal(onDismissStatus.mock.callCount(), 1);
  assert.equal(m.host.textContent, "");
});

test("tooltip describes its active target and preserves existing and newly added description IDs", async (t) => {
  const m = await mount(t);
  const button = m.doc.createElement("button");
  button.setAttribute("data-tip", "颜色");
  button.setAttribute("aria-describedby", "hint keyboard");
  m.body.appendChild(button);
  await act(() => m.root.render(h(TooltipHost)));
  await act(() => button.focus());
  assert.equal(
    m.find("role", "tooltip").getAttribute("id"),
    "forma-global-tooltip",
  );
  assert.equal(
    button.getAttribute("aria-describedby"),
    "hint keyboard forma-global-tooltip",
  );
  button.setAttribute(
    "aria-describedby",
    button.getAttribute("aria-describedby") + " extra",
  );
  await act(() => m.fire(m.doc, "focusout", button));
  assert.equal(button.getAttribute("aria-describedby"), "hint keyboard extra");
  await act(() => button.focus());
  await act(() => m.root.render(null));
  assert.equal(button.getAttribute("aria-describedby"), "hint keyboard extra");
});

test("P0-1: the anchored variable picker closes without restoring focus when only the document session changes", async (t) => {
  const m = await mount(t);
  const editor = editorFixture();
  const render = (session: number) =>
    act(() =>
      m.root.render(
        h(
          PopoverDocumentSessionContext.Provider,
          { value: session },
          h(TokenBinding, { editor, property: "fill" }),
        ),
      ),
    );
  await render(1);
  const trigger = m.find("aria-label", "绑定变量 fill");
  trigger.focus();
  await act(() => m.fire(m.host, "click", trigger));
  const search = m.find("aria-label", "搜索变量 fill");
  assert.equal(m.doc.activeElement, search);
  const focus = t.mock.method(trigger, "focus");
  await render(2);
  assert.equal(search.isConnected, false);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(focus.mock.callCount(), 0);
});

test("variable and create-style pickers remeasure anchored dialogs and close when an external preview arrives", async (t) => {
  const m = await mount(t);
  const editor = editorFixture();
  const controls = () =>
    h(
      "section",
      null,
      h(TokenBinding, { editor, property: "fill" }),
      h(StyleBinding, { editor, kind: "paint", placement: "header" }),
    );
  await act(() => m.root.render(controls()));
  const bind = m.find("aria-label", "绑定变量 fill"),
    style = m.find("aria-label", "应用或新建颜色样式");
  m.boxes.set(bind, rect(743, 410, 18, 18));
  await act(() => m.fire(m.host, "click", bind));
  let dialog = m.find("aria-label", "选择变量 fill");
  assert.equal(dialog.style.left, "475px");
  assert.equal(dialog.style.top, "308px");
  const search = m.find("aria-label", "搜索变量 fill");
  assert.equal(m.doc.activeElement, search);
  await act(() => m.fire(m.doc, "keydown", search, { key: "Escape" }));
  assert.equal(m.doc.activeElement, bind);
  m.boxes.set(style, rect(896, 383, 18, 18));
  await act(() => m.fire(m.host, "click", style));
  dialog = m.find("aria-label", "选择颜色样式");
  const initial = dialog.style.top;
  await act(() =>
    m.fire(m.body, "click", m.find("aria-label", "创建paint样式")),
  );
  assert.ok(m.find("aria-label", "新样式名称"));
  m.boxes.set(dialog, rect(0, 0, 264, 390));
  m.resize(dialog);
  assert.notEqual(dialog.style.top, initial);
  assert.equal(dialog.style.top, "78px");
  editor.doc = { ...editor.committed };
  editor.previewRef.current = editor.doc;
  await act(() => m.root.render(controls()));
  assert.equal(m.body.querySelectorAll('[aria-modal="true"]').length, 0);
  assert.equal(bind.getAttribute("aria-expanded"), "false");
  assert.equal(style.getAttribute("aria-expanded"), "false");
});

test("instance swap picker follows its trigger and blocks stale writes after a preview starts", async (t) => {
  const m = await mount(t);
  const editor = editorFixture(),
    root = editor.selected[0];
  const library = createLibraryFromSelection(editor.doc, root.id, "控件");
  const component = library.components[0],
    variant = component.variants[0];
  root.templateKey = variant.nodes.find((n) => !n.parentId)?.templateKey;
  library.components.push(
    ...Array.from({ length: 41 }, (_, i) => ({
      ...component,
      id: "component-" + i,
      name: "控件 " + i,
    })),
  );
  editor.doc.libraries = { [library.id]: library };
  const selection = [{ root, source: { library, component, variant } }];
  const apply = t.mock.fn();
  editor.apply = apply;
  editor.attempt = (work) => {
    work();
  };
  const controls = () => h(InstanceProperties, { editor, selection });
  await act(() => m.root.render(controls()));
  const trigger = m.find("aria-label", "替换实例组件");
  assert.equal(trigger.getAttribute("data-tip"), component.name);
  m.boxes.set(trigger, rect(822, 450, 70, 20));
  await act(() => m.fire(m.host, "click", trigger));
  const dialog = m.find("aria-label", "选择 替换实例组件");
  assert.equal(dialog.style.left, "554px");
  assert.equal(dialog.style.top, "308px");
  editor.previewRef.current = { ...editor.committed };
  const alternative = Array.from(dialog.getElementsByTagName("button")).find(
    (n) => n.textContent?.includes("控件 0"),
  );
  assert.ok(alternative);
  await act(() => m.fire(m.body, "click", alternative));
  assert.equal(apply.mock.callCount(), 0);
  editor.doc = editor.previewRef.current;
  await act(() => m.root.render(controls()));
  assert.ok(trigger.hasAttribute("disabled"));
});

test("collection name remains available to the tooltip beside its mode selector", () => {
  const editor = editorFixture(),
    name = "长变量集合名称".repeat(8);
  editor.doc.designSystem = {
    activeModes: {},
    styles: {},
    variables: {},
    collections: {
      ui: {
        id: "ui",
        name,
        defaultModeId: "a",
        modes: [
          { id: "a", name: "白天" },
          { id: "b", name: "夜晚" },
        ],
      },
    },
  };
  const html = renderToStaticMarkup(h(ModeSelectors, { editor }));
  assert.ok(html.includes('data-tip="' + name + '"'));
  assert.ok(html.includes('aria-label="模式 ' + name + '"'));
});

test("an external preview interrupts a local color gesture without clearing the proposal or retaining pointer capture", async (t) => {
  const m = await mount(t);
  const onCancelPreview = t.mock.fn(),
    onChange = t.mock.fn();
  const show = (previewDisabled: boolean) =>
    act(() =>
      m.root.render(
        h(ColorField, {
          color: "#111111",
          label: "描边",
          onCancelPreview,
          onChange,
          previewDisabled,
        }),
      ),
    );
  await show(false);
  const trigger = m.find("aria-label", "编辑描边颜色");
  await act(() => m.fire(m.host, "click", trigger));
  const slider = m.find("aria-label", "色相");
  await act(() =>
    m.fire(m.body, "pointerdown", slider, { pointerId: 2, button: 0 }),
  );
  await show(true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.ok(trigger.hasAttribute("disabled"));
  assert.equal(onCancelPreview.mock.callCount(), 0);
  assert.equal(onChange.mock.callCount(), 0);
  await show(false);
  await act(() => m.fire(m.host, "click", trigger));
  const header = m.find("class", "panel-heading");
  await act(() =>
    m.fire(m.body, "pointerdown", header, {
      pointerId: 7,
      button: 0,
      clientX: 10,
      clientY: 50,
    }),
  );
  assert.equal(m.captured.get(header), 7);
  await act(() => m.root.render(null));
  assert.equal(m.captured.size, 0);
});

for (const [label, sample, channel] of [
  ["饱和度与亮度", null, "color"],
  ["色相", "180", "color"],
  ["颜色透明度", "25", "alpha"],
] as const) {
  test(
    label +
      " cancels once on lost capture and commits once on pointerup after capture release",
    async (t) => {
      const m = await mount(t);
      let live: { color: string; alpha: number } | null = null;
      const onPreview = (color: string, alpha: number) => {
        live = { color, alpha };
      };
      const cancel = t.mock.fn(() => {
        live = null;
      });
      const commit = t.mock.fn(
        (_color: string, _alpha: number, _channel: string) => {
          live = null;
        },
      );
      await act(() =>
        m.root.render(
          h(ColorField, {
            label: "填充",
            color: "#cc3300",
            alpha: 0.5,
            onPreview,
            onChange: commit,
            onCancelPreview: cancel,
          }),
        ),
      );
      await act(() =>
        m.fire(m.host, "click", m.find("aria-label", "编辑填充颜色")),
      );
      const el = m.find("aria-label", label) as HTMLInputElement;
      const pointer = (type: string, pointerId = 4) =>
        act(() =>
          m.fire(m.body, type, el, {
            pointerId,
            clientX: 88,
            clientY: 40,
            button: 0,
          }),
        );
      const start = async () => {
        await pointer("pointerdown");
        if (sample !== null) {
          el.value = sample;
          await act(() => m.fire(m.body, "input", el));
        }
        assert.ok(live, label + " started a live preview");
      };
      await start();
      await pointer("lostpointercapture", 9);
      assert.ok(live);
      el.releasePointerCapture(4);
      await pointer("lostpointercapture");
      await pointer("pointercancel");
      await pointer("pointerup");
      assert.equal(live, null);
      assert.equal(cancel.mock.callCount(), 1);
      assert.equal(commit.mock.callCount(), 0);
      await start();
      const expected = live as { color: string; alpha: number } | null;
      assert.ok(expected);
      el.releasePointerCapture(4);
      await pointer("pointerup");
      await pointer("lostpointercapture");
      await pointer("pointerup");
      assert.equal(live, null);
      assert.equal(cancel.mock.callCount(), 1);
      assert.equal(commit.mock.callCount(), 1);
      assert.deepEqual(commit.mock.calls[0].arguments, [
        expected.color,
        expected.alpha,
        channel,
      ]);
    },
  );
}

for (const picker of [false, true]) {
  test(
    (picker ? "picker" : "inline") +
      " opacity rejects invalid drafts, ignores composing keys, cancels on Escape and commits a valid integer once",
    async (t) => {
      const m = await mount(t);
      const onChange = t.mock.fn();
      const color = "#112233";
      await act(() =>
        m.root.render(
          h(ColorField, { label: "填充", color, alpha: 0.5, onChange }),
        ),
      );
      if (picker)
        await act(() =>
          m.fire(m.host, "click", m.find("aria-label", "编辑填充颜色")),
        );
      const root = picker ? m.body : m.host;
      const input = m.find(
        "aria-label",
        picker ? "颜色不透明度百分比" : "填充不透明度",
      ) as HTMLInputElement;
      const type = (value: string) =>
        act(() => {
          input.value = value;
          m.fire(root, "input", input);
        });
      const key = (key: string, isComposing = false) =>
        act(() => m.fire(root, "keydown", input, { key, isComposing }));
      for (const raw of ["101", "-1", "42.5", ""]) {
        await type(raw);
        await act(() => input.blur());
        assert.equal(input.value, "50", raw);
        assert.equal(onChange.mock.callCount(), 0);
      }
      await type("75");
      await key("Enter", true);
      await key("Escape", true);
      assert.equal(input.value, "75");
      await key("Escape");
      await act(() => input.blur());
      assert.equal(input.value, "50");
      assert.equal(onChange.mock.callCount(), 0);
      await type("30");
      await key("Enter");
      assert.equal(onChange.mock.callCount(), 1);
      assert.deepEqual(onChange.mock.calls[0].arguments, [color, 0.3, "alpha"]);
    },
  );
}
