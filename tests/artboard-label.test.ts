import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { registerHooks } from "node:module";
import { DOMParser } from "@xmldom/xmldom";
import { parse } from "postcss";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { nativeDesignSystem } from "../src/design-system/tokens";
import {
  createNode,
  parseDocument,
  layoutGuideSchema,
  type DesignDocument,
} from "../src/domain/document";
import {
  copySelection,
  duplicateSelectionForDrag,
  pasteSelection,
} from "../src/domain/clipboard";
import { transact } from "../src/domain/commands";
import { createLibraryFromSelection } from "../src/domain/library";
import { resolveNode } from "../src/domain/design-system";
import { boardBranchSignature } from "../src/application/board-lod";
import { boardTileCache } from "../src/editor/board-tile-cache";
import { commit, travel } from "../src/application/history";
import { createStarter } from "../src/domain/seed";
import {
  ArtboardLabel,
  collectArtboardLabelNodes,
  shouldAllowArtboardLabelDrag,
  shouldAllowArtboardLabelPointer,
  type ArtboardLabelProps,
} from "../src/editor/ArtboardLabel";

const pointer = {
  tool: "select",
  locked: false,
  panning: false,
  devMode: false,
  interacting: false,
  hasMarquee: false,
};

for (const tool of [
  "select",
  "scale",
  "hand",
  "frame",
  "rectangle",
  "text",
  "pen",
]) {
  test(`label pointer and drag eligibility with the ${tool} tool`, () => {
    const eligible = tool === "select" || tool === "scale";
    for (const locked of [false, true]) {
      const input = { ...pointer, tool, locked };
      assert.equal(shouldAllowArtboardLabelPointer(input), eligible);
      assert.equal(shouldAllowArtboardLabelDrag(input), eligible && !locked);
    }
  });
}
for (const state of [
  "panning",
  "devMode",
  "interacting",
  "hasMarquee",
] as const) {
  test(`label passes pointers through during ${state}`, () => {
    for (const tool of ["select", "scale"]) {
      const input = { ...pointer, tool, [state]: true };
      assert.equal(shouldAllowArtboardLabelPointer(input), false);
      assert.equal(shouldAllowArtboardLabelDrag(input), false);
    }
  });
}

test("collects visible root and section boards and component sets in document order", () => {
  const board = createNode("frame");
  const section = createNode("section");
  const child = createNode("frame", section.id);
  const subsection = createNode("section", section.id);
  const set = createNode("group");
  const childSet = createNode("group", section.id);
  set.componentSet = childSet.componentSet = {
    libraryId: "kit",
    componentId: "card",
  };
  const hidden = createNode("frame");
  hidden.hidden = true;
  const doc = createStarter();
  doc.nodes = [
    childSet,
    createNode("rectangle"),
    board,
    createNode("frame", board.id),
    hidden,
    createNode("frame", child.id),
    createNode("text"),
    child,
    section,
    subsection,
    createNode("rectangle", section.id),
    set,
  ];
  assert.deepEqual(collectArtboardLabelNodes(doc), [
    childSet,
    board,
    child,
    section,
    subsection,
    set,
  ]);
});

test("visibility bindings on a board or its containing section hide the overlay", () => {
  const doc = createStarter();
  doc.designSystem = nativeDesignSystem();
  doc.designSystem.variables["content-visible"].values.light = false;
  doc.designSystem.activeModes.semantic = "light";
  const section = createNode("section");
  const child = createNode("frame", section.id);
  const board = createNode("frame");
  board.variableBindings = section.variableBindings = {
    visible: "content-visible",
  };
  doc.nodes = [section, board, child];
  assert.deepEqual(collectArtboardLabelNodes(doc), []);
  doc.designSystem.activeModes.semantic = "dark";
  assert.deepEqual(collectArtboardLabelNodes(doc), [section, board, child]);
});

const props: ArtboardLabelProps = {
  nodeId: "board-1",
  name: "首页",
  width: 319.7,
  height: 639.2,
  left: 30,
  top: -8,
  selected: false,
  locked: false,
  interactive: true,
  renaming: false,
  onBeginDrag() {},
  onStartRename() {},
  onCommitRename() {},
  onCancelRename() {},
};

function render(overrides: Partial<ArtboardLabelProps> = {}) {
  const markup = renderToStaticMarkup(
    createElement(ArtboardLabel, { ...props, ...overrides }),
  );
  return new DOMParser().parseFromString(markup, "text/html").documentElement;
}

for (const [mode, overrides, className] of [
  ["normal", {}, "frame-label"],
  [
    "selected component",
    { selected: true, labelRole: "component" },
    "frame-label selected is-component",
  ],
  ["locked", { locked: true }, "frame-label is-locked"],
  ["passthrough", { interactive: false }, "frame-label is-passthrough"],
] as const) {
  test(`SSR preserves the ${mode} label's node identity, position and dimensions`, () => {
    const button = render(overrides);
    assert.equal(button.tagName, "button");
    assert.equal(button.getAttribute("type"), "button");
    assert.equal(button.getAttribute("class"), className);
    assert.equal(button.getAttribute("data-frame-label-id"), props.nodeId);
    assert.equal(button.hasAttribute("data-node-id"), false);
    assert.equal(button.hasAttribute("data-section-label-id"), false);
    assert.equal(
      button.getAttribute("tabindex"),
      mode === "passthrough" ? "-1" : "0",
    );
    assert.equal(
      button.getAttribute("aria-label"),
      mode === "selected component" ? "主组件 首页" : "画板 首页",
    );
    assert.equal(button.getAttribute("style"), "left:30px;top:-8px");
    assert.equal(button.textContent, "首页 320 × 639");
    assert.equal(
      button.getElementsByTagName("small")[0].textContent,
      "320 × 639",
    );
  });
}

test("SSR renders the named inline rename input at the label position", () => {
  const input = render({ renaming: true });
  assert.equal(input.tagName, "input");
  assert.equal(input.getAttribute("class"), "frame-label-editor");
  assert.equal(input.getAttribute("aria-label"), "重命名画板");
  assert.equal(input.getAttribute("data-frame-label-id"), props.nodeId);
  assert.equal(input.hasAttribute("data-node-id"), false);
  assert.equal(input.hasAttribute("data-section-label-id"), false);
  assert.equal(input.getAttribute("style"), "left:30px;top:-8px");
  assert.equal(input.getAttribute("value"), props.name);
});

for (const [devStatus, badge] of [
  ["ready", "Ready for dev"],
  ["completed", "Completed"],
] as const) {
  test(`the screen-space section title and editor share one anchor (${badge})`, () => {
    const options = {
      labelRole: "section" as const,
      devStatus,
      selected: true,
      maxWidth: 83,
    };
    const button = render(options);
    const input = render({ ...options, renaming: true });
    for (const el of [button, input]) {
      assert.equal(el.hasAttribute("data-node-id"), false);
      assert.equal(el.hasAttribute("data-frame-label-id"), false);
      assert.equal(el.getAttribute("data-section-label-id"), props.nodeId);
      assert.equal(
        el.getAttribute("style"),
        "left:30px;top:-8px;max-width:83px",
      );
    }
    assert.equal(button.tagName, "button");
    assert.equal(button.getAttribute("class"), "section-title-pill selected");
    assert.equal(button.getAttribute("aria-label"), "分区 首页");
    assert.equal(
      button.getElementsByTagName("span")[0].textContent,
      props.name,
    );
    assert.equal(button.getElementsByTagName("small")[0].textContent, badge);
    assert.equal(input.tagName, "input");
    assert.equal(input.getAttribute("aria-label"), "重命名分区");
    assert.equal(
      input.getAttribute("class"),
      "frame-label-editor section-title-editor",
    );
  });
}

function componentSetFixture() {
  const a = createNode("frame"),
    b = createNode("frame");
  const child = createNode("text", a.id);
  const decoration = createNode("rectangle", b.id);
  decoration.name = child.name;
  const doc = { ...createStarter(), nodes: [child, a, decoration, b] };
  const source = transact(doc, {
    baseRevision: doc.revision,
    operations: [
      {
        type: "createVariantSet",
        canvas: true,
        libraryId: "buttons",
        name: "Button",
        axis: "State",
        members: [
          { id: a.id, value: "Idle", variantId: "idle" },
          { id: b.id, value: "Busy", variantId: "busy" },
        ],
      },
    ],
  });
  const group = source.nodes.find((node) => node.componentSet)!;
  return { source, group };
}

test("one drag transaction duplicates the component set, its masters and variant templates independently", () => {
  const { source, group } = componentSetFixture();
  const {
    operations,
    selection: [id],
  } = duplicateSelectionForDrag(source, [group.id], null);
  assert.equal(operations.filter((op) => op.type === "putLibrary").length, 1);
  const history = commit(
    { past: [], present: source, future: [] },
    transact(source, {
      baseRevision: source.revision,
      operations: [
        ...operations,
        { type: "update", id, patch: {}, style: { x: 77 } },
      ],
    }),
  );
  const moved = parseDocument(history.present);
  const root = moved.nodes.find((node) => node.id === id)!;
  assert.equal(root.style.x, 77);
  assert.equal(root.componentSet?.libraryId, "buttons");
  assert.notEqual(
    root.componentSet?.componentId,
    group.componentSet?.componentId,
  );
  const [original, clone] = moved.libraries!.buttons.components;
  assert.deepEqual(original, source.libraries!.buttons.components[0]);
  assert.equal(clone.id, root.componentSet?.componentId);
  assert.equal(clone.name, original.name + " 副本");
  assert.equal(clone.master?.documentId, source.id);
  const masters = [clone.master!.nodeId, clone.variants[1].masterNodeId!];
  assert.deepEqual(
    masters.sort(),
    moved.nodes
      .filter((node) => node.parentId === id)
      .map((node) => node.id)
      .sort(),
  );
  for (const [i, variant] of clone.variants.entries()) {
    assert.deepEqual(variant.properties, original.variants[i].properties);
    assert.deepEqual(
      variant.nodes.map((n) => n.templateKey),
      original.variants[i].nodes.map((n) => n.templateKey),
    );
    assert.ok(
      variant.nodes.every(
        (n) =>
          moved.nodes.some((copy) => copy.id === n.id) &&
          !source.nodes.some((old) => old.id === n.id),
      ),
    );
  }
  assert.equal(history.past.length, 1);
  const undone = travel(history, "undo");
  assert.deepEqual(undone.present.nodes, source.nodes);
  assert.deepEqual(
    undone.present.libraries,
    JSON.parse(JSON.stringify(source.libraries)),
  );
  assert.deepEqual(
    travel(undone, "redo").present.libraries,
    JSON.parse(JSON.stringify(moved.libraries)),
  );
  const ordinaryPaste = pasteSelection(
    source,
    copySelection(source, [group.id]),
    null,
  );
  assert.ok(
    ordinaryPaste.operations.every(
      (op) => op.type !== "create" || !op.node.componentSet,
    ),
  );
});

test("Alt-dragging a set title clones its library entry and one editor undo restores the original set", async (t) => {
  const { source, group } = componentSetFixture();
  const canvas = await mountCanvas(t, source);
  await canvas.send("pointerdown", canvas.label(group.id), {
    altKey: true,
    clientX: 20,
    clientY: 10,
  });
  await canvas.send("pointermove", canvas.surface, {
    clientX: 56,
    clientY: 34,
  });
  assert.equal(canvas.editor.historyRef.current.past.length, 0);
  const [id] = canvas.editor.selection;
  assert.notEqual(id, group.id);
  await canvas.send("pointerup", canvas.surface, { clientX: 56, clientY: 34 });
  const moved = canvas.editor.committed;
  const copy = moved.nodes.find((n) => n.id === id)!;
  assert.ok(copy.componentSet);
  assert.deepEqual(
    [copy.style.x - group.style.x, copy.style.y - group.style.y],
    [36, 24],
  );
  const clone = moved.libraries!.buttons.components.find(
    (c) => c.id === copy.componentSet!.componentId,
  )!;
  assert.equal(clone.name, "Button 副本");
  assert.equal(clone.variants.length, 2);
  assert.equal(canvas.editor.historyRef.current.past.length, 1);
  await act(() => canvas.editor.undo());
  assert.deepEqual(canvas.editor.selection, [group.id]);
  assert.deepEqual(canvas.editor.committed.nodes, source.nodes);
  assert.deepEqual(
    canvas.editor.committed.libraries!.buttons.components,
    source.libraries!.buttons.components,
  );
});

test("duplicating two sets in the same library remaps each set's own surviving drawings", () => {
  const { source, group } = componentSetFixture();
  const family = source.libraries!.buttons.components[0];
  const textKey = family.variants[0].nodes.find(
    (n) => n.type === "text",
  )!.templateKey!;
  family.exposed = [
    { id: "caption", name: "Caption", kind: "text", target: textKey },
  ];
  assert.ok(
    family.variants[1].nodes.some(
      (n) => n.templateKey === textKey && n.type === "rectangle",
    ),
  );
  const second = createNode("group");
  second.componentSet = { ...group.componentSet! };
  const alternate =
    source.libraries!.buttons.components[0].variants[1].masterNodeId!;
  source.nodes.find((n) => n.id === alternate)!.parentId = second.id;
  source.nodes.push(second);
  const { operations, selection } = duplicateSelectionForDrag(
    source,
    [group.id, second.id],
    null,
  );
  const duplicated = transact(source, {
    baseRevision: source.revision,
    operations,
  });
  const entries = duplicated.libraries!.buttons.components;
  assert.equal(entries.length, 3);
  assert.equal(operations.filter((op) => op.type === "putLibrary").length, 1);
  for (const [i, id] of selection.entries()) {
    const root = duplicated.nodes.find((n) => n.id === id)!;
    const comp = entries.find(
      (entry) => entry.id === root.componentSet?.componentId,
    )!;
    assert.deepEqual(
      comp.variants.map((v) => v.id),
      [i === 0 ? "idle" : "busy"],
    );
    assert.deepEqual(comp.exposed, i === 0 ? family.exposed : []);
    assert.equal(comp.variants[0].masterNodeId, undefined);
    assert.equal(
      duplicated.nodes.find((n) => n.id === comp.master?.nodeId)?.parentId,
      id,
    );
  }
});

async function mount(t: TestContext) {
  const doc = new DOMParser().parseFromString("<html/>", "text/html");
  const events = new EventTarget();
  const focus = t.mock.fn();
  const select = t.mock.fn();
  const create = doc.createElement.bind(doc);
  const captured = new Map<Element, number>();
  const noop = (): void => {};
  t.mock.method(doc, "createElement", (tag: string) => {
    const el = create(tag);
    Object.defineProperty(el, "parentElement", { get: () => el.parentNode });
    return Object.assign(el, {
      style: { setProperty: noop, removeProperty: noop },
      classList: { toggle: noop },
      dataset: {
        get nodeId() {
          return el.getAttribute("data-node-id");
        },
      },
      closest(selector: string) {
        for (let n: Element | null = el; n; n = n.parentElement) {
          if (
            selector
              .split(",")
              .some(
                (s) =>
                  s === "[data-node-id]" && n!.hasAttribute("data-node-id"),
              )
          )
            return n;
        }
        return null;
      },
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
      }),
      getContext: () => null,
      setPointerCapture: (id: number) => captured.set(el, id),
      hasPointerCapture: (id: number) => captured.get(el) === id,
      releasePointerCapture: () => captured.delete(el),
      focus,
      select,
      addEventListener: noop,
      removeEventListener: noop,
    });
  });
  const host = doc.createElement("div");
  host.addEventListener = events.addEventListener.bind(events);
  Object.assign(doc, {
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    elementsFromPoint: () => [],
    elementFromPoint: () => null,
  });
  const win = Object.assign(new EventTarget(), {
    document: doc,
    HTMLIFrameElement: class {},
    CompositionEvent: Event,
  });
  const restoreGlobals: Array<() => void> = [];
  for (const [key, value] of Object.entries({
    window: win,
    document: doc,
    HTMLElement: host.constructor,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (): number => 1,
    cancelAnimationFrame: noop,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    restoreGlobals.push(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  t.after(async () => {
    try {
      await act(() => root.unmount());
    } finally {
      for (const restore of restoreGlobals) restore();
    }
  });
  function fire(
    type: string,
    target: Element,
    fields: Record<string, unknown> = {},
  ) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "target", { value: target });
    Object.assign(event, {
      button: 0,
      pointerId: 7,
      clientX: 0,
      clientY: 0,
      ...fields,
    });
    events.dispatchEvent(event);
    return event;
  }
  return { root, host, focus, select, fire, captured };
}

test("mounted labels route pointer gestures and finish each rename session exactly once", async (t) => {
  const { root, host, focus, select, fire } = await mount(t);
  const calls: string[] = [];
  function show(overrides: Partial<ArtboardLabelProps> = {}) {
    return act(() =>
      root.render(
        createElement(
          "div",
          {
            onPointerDown: () => calls.push("surface down"),
            onKeyDown: () => calls.push("surface key"),
            onContextMenu: () => calls.push("menu"),
          },
          createElement(ArtboardLabel, {
            ...props,
            onBeginDrag: (event, id) => {
              calls.push("drag " + id);
              event.stopPropagation();
            },
            onSelect: (id, add) => calls.push(`select ${id} ${add}`),
            onStartRename: (id) => calls.push("rename " + id),
            onHoverChange: (id) => calls.push("hover " + id),
            onCommitRename: (id, value) => calls.push(id + " " + value),
            onCancelRename: () => calls.push("cancel"),
            ...overrides,
          }),
        ),
      ),
    );
  }
  function expectCalls(...expected: string[]) {
    assert.deepEqual(calls.splice(0), expected);
  }
  async function edit(value: string) {
    await show();
    await show({ renaming: true });
    const input = host.getElementsByTagName("input")[0];
    input.value = value;
    return input;
  }

  await show();
  const button = host.getElementsByTagName("button")[0];
  fire("pointerover", button);
  fire("pointerout", button);
  fire("pointerdown", button, { button: 1 });
  fire("pointerdown", button, { button: 2 });
  fire("contextmenu", button);
  fire("pointerdown", button, { button: 0 });
  assert.ok(fire("dblclick", button).defaultPrevented);
  expectCalls(
    "hover board-1",
    "hover null",
    "surface down",
    "surface down",
    "menu",
    "drag board-1",
    "rename board-1",
  );
  for (const labelRole of ["frame", "section"] as const) {
    await show({ labelRole });
    for (const [key, shiftKey] of [
      ["Enter", false],
      [" ", true],
      ["F2", false],
    ] as const)
      assert.ok(fire("keydown", button, { key, shiftKey }).defaultPrevented);
    expectCalls(
      "select board-1 false",
      "select board-1 true",
      "rename board-1",
    );
  }
  await show({ locked: true });
  fire("pointerover", button);
  fire("pointerdown", button, { button: 0 });
  fire("dblclick", button);
  expectCalls("hover board-1");
  await show({ interactive: false });
  fire("pointerover", button);
  fire("pointerdown", button, { button: 0 });
  fire("dblclick", button);
  expectCalls("surface down");

  const input = await edit("  新画板  ");
  assert.equal(focus.mock.callCount(), 1);
  assert.equal(select.mock.callCount(), 1);
  fire("pointerdown", input, { button: 0 });
  for (const key of ["v", "r", "f", "Backspace", " ", "M"]) {
    assert.equal(
      fire("keydown", input, { key, shiftKey: key === "M" }).defaultPrevented,
      false,
    );
  }
  fire("compositionstart", input);
  assert.equal(
    fire("keydown", input, { key: "Enter" }).defaultPrevented,
    false,
  );
  assert.equal(
    fire("keydown", input, { key: "Escape" }).defaultPrevented,
    false,
  );
  fire("compositionend", input);
  for (const guard of [{ isComposing: true }, { keyCode: 229 }]) {
    assert.equal(
      fire("keydown", input, { key: "Enter", ...guard }).defaultPrevented,
      false,
    );
  }
  for (const guard of [{ isComposing: true }, { keyCode: 229 }])
    assert.equal(
      fire("keydown", input, { key: "Escape", ...guard }).defaultPrevented,
      false,
    );
  expectCalls();
  assert.ok(fire("keydown", input, { key: "Enter" }).defaultPrevented);
  fire("focusout", input);
  expectCalls("board-1 新画板");

  const cancelled = await edit("discard");
  assert.ok(fire("keydown", cancelled, { key: "Escape" }).defaultPrevented);
  fire("focusout", cancelled);
  expectCalls("cancel");
  for (const [draft, expected] of [
    ["  另一个  ", "board-1 另一个"],
    ["  ", "cancel"],
    [" 首页 ", "cancel"],
  ]) {
    fire("focusout", await edit(draft));
    expectCalls(expected);
  }
});

test("unmounting a blurred rename input before compositionend discards unfinished pinyin", async (t) => {
  const { root, host, fire } = await mount(t);
  const onCommitRename = t.mock.fn();
  await act(() =>
    root.render(
      createElement(ArtboardLabel, {
        ...props,
        renaming: true,
        onCommitRename,
      }),
    ),
  );
  const input = host.getElementsByTagName("input")[0];
  fire("compositionstart", input);
  input.value = "pin";
  fire("focusout", input);
  assert.equal(onCommitRename.mock.callCount(), 0);
  await act(() => root.render(null));
  assert.equal(onCommitRename.mock.callCount(), 0);
});

async function mountCanvas(t: TestContext, doc: DesignDocument, zoom = 1) {
  const css = registerHooks({
    load(url, context, next) {
      return url.endsWith(".css")
        ? { format: "module", source: "", shortCircuit: true }
        : next(url, context);
    },
  });
  const { Canvas } = await import("../src/editor/Canvas").finally(() =>
    css.deregister(),
  );
  const { useEditor } = await import("../src/editor/useEditor");
  const { root, host, captured, fire } = await mount(t);
  const views = new Map([[doc.activePage ?? "first", { x: 0, y: 0, zoom }]]);
  let editor!: ReturnType<typeof useEditor>;
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
  function App({ marked, guides }: { marked: boolean; guides: boolean }) {
    editor = useEditor({ initialDocument: doc, active: false, repository });
    return createElement(Canvas, {
      editor,
      views,
      prototypeMode: false,
      contextMenu() {},
      onImportDesign() {},
      aiPreviewNodeIds: marked ? new Set([doc.nodes[0].id]) : undefined,
      viewOptions: {
        showRulers: false,
        showPixelGrid: false,
        showLayoutGuides: guides,
        outlineMode: false,
        snapEnabled: false,
        showComments: false,
        showMinimap: false,
      },
    });
  }
  const render = (marked = false, guides = false) =>
    act(() => root.render(createElement(App, { marked, guides })));
  const elements = () => Array.from(host.getElementsByTagName("*"));
  const label = (nodeId: string) =>
    elements().find(
      (el) =>
        el.getAttribute("data-frame-label-id") === nodeId ||
        el.getAttribute("data-section-label-id") === nodeId,
    )!;
  const send = (
    type: string,
    target: Element,
    fields: Record<string, unknown> = {},
  ) =>
    act(() => {
      fire(type, target, fields);
    });
  await render();
  const surface = elements().find((el) =>
    el.getAttribute("class")?.split(" ").includes("editor-canvas"),
  )!;
  const layer = (id: string) =>
    elements().find((el) => el.getAttribute("data-node-id") === id)!;
  return {
    get editor() {
      return editor;
    },
    surface,
    elements,
    render,
    label,
    captured,
    layer,
    send,
    fire,
  };
}

test("IME blur keeps the mounted rename input until compositionend commits the final text once", async (t) => {
  const board = createNode("frame");
  const canvas = await mountCanvas(t, { ...createStarter(), nodes: [board] });
  await canvas.send("dblclick", canvas.label(board.id));
  const input = canvas.label(board.id) as HTMLInputElement;
  await canvas.send("compositionstart", input);
  input.value = "pin";
  await canvas.send("focusout", input);
  await Promise.resolve();
  assert.equal(canvas.label(board.id), input);
  assert.equal(canvas.editor.historyRef.current.past.length, 0);
  input.value = "拼音";
  await canvas.send("compositionend", input, { data: "拼音" });
  await canvas.send("focusout", input);
  assert.equal(canvas.label(board.id).tagName, "button");
  assert.equal(canvas.editor.committed.nodes[0].name, "拼音");
  assert.equal(canvas.editor.historyRef.current.past.length, 1);
});

test("Canvas supplies distinct accessible names for frames, sections, sets, masters and instances", async (t) => {
  const board = createNode("frame"),
    section = createNode("section");
  const master = createNode("frame"),
    instance = createNode("frame"),
    set = createNode("group");
  const doc = {
    ...createStarter(),
    nodes: [board, section, master, instance, set],
  };
  const library = createLibraryFromSelection(doc, master.id, "Cards");
  const component = library.components[0];
  doc.libraries = { [library.id]: library };
  set.componentSet = { libraryId: library.id, componentId: component.id };
  instance.instance = {
    ...set.componentSet,
    variantId: component.variants[0].id,
  };
  const canvas = await mountCanvas(t, doc);
  for (const [node, role] of [
    [board, "画板"],
    [section, "分区"],
    [set, "组件集"],
    [master, "主组件"],
    [instance, "组件实例"],
  ] as const)
    assert.equal(
      canvas.label(node.id).getAttribute("aria-label"),
      role + " " + node.name,
    );
});

for (const action of [
  "Enter",
  "pointerdown",
  "pointermove",
  "pointerup",
] as const) {
  test(`a queued proposal survives title ${action} before React renders`, async (t) => {
    const board = createNode("frame");
    const base = { ...createStarter(), nodes: [board] };
    const canvas = await mountCanvas(t, base);
    const proposal = transact(base, {
      baseRevision: base.revision,
      operations: [
        { type: "update", id: board.id, patch: { name: "AI proposal" } },
      ],
    });
    const expected = structuredClone(proposal);
    const position = { clientX: 45, clientY: 20 };
    if (action === "Enter") {
      await canvas.send("dblclick", canvas.label(board.id));
      const input = canvas.label(board.id) as HTMLInputElement;
      assert.equal(input.tagName, "input");
      input.value = "Stale rename";
    } else if (action !== "pointerdown") {
      await canvas.send("pointerdown", canvas.label(board.id));
      await canvas.send("pointermove", canvas.surface, { clientX: 30 });
      assert.ok(canvas.editor.previewRef.current);
      assert.equal(canvas.editor.committed, base);
    }
    const rendered = canvas.editor;
    await act(() => {
      rendered.setPreview(() => proposal);
      assert.equal(canvas.editor, rendered);
      assert.equal(rendered.previewRef.current, proposal);
      if (action === "Enter")
        canvas.fire("keydown", canvas.label(board.id), { key: "Enter" });
      else {
        canvas.fire(
          action,
          action === "pointerdown" ? canvas.label(board.id) : canvas.surface,
          position,
        );
        if (action === "pointerdown")
          assert.equal(canvas.captured.has(canvas.surface), false);
        assert.equal(rendered.previewRef.current, proposal);
        if (action !== "pointerup")
          canvas.fire("pointerup", canvas.surface, position);
      }
      assert.equal(rendered.historyRef.current.past.length, 0);
    });
    assert.equal(canvas.editor.doc, proposal);
    assert.equal(canvas.editor.previewRef.current, proposal);
    assert.deepEqual(proposal, expected);
    assert.equal(canvas.editor.committed, base);
  });
}

for (const handle of ["调整尺寸 se", "旋转选区"]) {
  test(`a queued proposal keeps ownership through ${handle} move and release`, async (t) => {
    const board = createNode("frame");
    Object.assign(board.style, { x: 0, y: 0, width: 100, height: 100 });
    const base = { ...createStarter(), nodes: [board] };
    const canvas = await mountCanvas(t, base);
    await act(() => canvas.editor.setSelection([board.id]));
    const proposal = { ...base, name: "AI proposal" };
    for (const event of ["pointermove", "pointerup"]) {
      const button = canvas
        .elements()
        .find((el) => el.getAttribute("aria-label") === handle)!;
      await canvas.send("pointerdown", button, { clientX: 100, clientY: 100 });
      await canvas.send("pointermove", canvas.surface, {
        clientX: 150,
        clientY: 90,
      });
      assert.ok(canvas.editor.previewRef.current);
      await act(() => {
        canvas.editor.setPreview(proposal);
        canvas.fire(event, canvas.surface, { clientX: 160, clientY: 90 });
        if (event === "pointermove") canvas.fire("pointerup", canvas.surface);
        assert.equal(canvas.editor.previewRef.current, proposal);
      });
      assert.equal(canvas.editor.doc, proposal);
      assert.equal(canvas.editor.committed, base);
      assert.equal(canvas.editor.historyRef.current.past.length, 0);
      await act(() => canvas.editor.setPreview(null));
    }
  });
}

for (const action of ["Enter", "pointermove", "pointerup"] as const) {
  test(`a synchronous history change supersedes title ${action}`, async (t) => {
    const board = createNode("frame");
    const base = { ...createStarter(), nodes: [board] };
    const canvas = await mountCanvas(t, base);
    if (action === "Enter") {
      await canvas.send("dblclick", canvas.label(board.id));
      (canvas.label(board.id) as HTMLInputElement).value = "Stale title";
    } else {
      await canvas.send("pointerdown", canvas.label(board.id));
      await canvas.send("pointermove", canvas.surface, { clientX: 32 });
    }
    await act(() => {
      canvas.editor.apply([
        { type: "update", id: board.id, patch: { name: "Current title" } },
      ]);
      if (action === "Enter")
        canvas.fire("keydown", canvas.label(board.id), { key: "Enter" });
      else {
        canvas.fire(action, canvas.surface, { clientX: 48 });
        if (action === "pointermove")
          canvas.fire("pointerup", canvas.surface, { clientX: 48 });
      }
    });
    assert.equal(canvas.editor.doc, canvas.editor.committed);
    assert.equal(canvas.editor.previewRef.current, null);
    assert.equal(canvas.editor.committed.nodes[0].name, "Current title");
    assert.deepEqual(canvas.editor.committed.nodes[0].style, board.style);
    assert.equal(canvas.editor.historyRef.current.past.length, 1);
    assert.equal(canvas.editor.error, "");
  });
}

test("mounted Canvas preserves external previews and only the owning pointer can finish a title drag", async (t) => {
  const section = createNode("section");
  Object.assign(section.style, { x: 0, y: 0, width: 200, height: 150 });
  const board = createNode("frame", section.id);
  Object.assign(board.style, { x: 25, y: 1, width: 60, height: 60 });
  const other = createNode("frame");
  Object.assign(other.style, { x: 290, y: 1, width: 60, height: 60 });
  const doc = { ...createStarter(), nodes: [section, board, other] };
  const canvas = await mountCanvas(t, doc);
  const { surface, render, label, captured, send } = canvas;
  const base = canvas.editor.committed;
  const proposal = transact(base, {
    baseRevision: base.revision,
    operations: [
      { type: "update", id: section.id, patch: { name: "Proposal" } },
    ],
  });
  for (const markerOnly of [false, true]) {
    await send("dblclick", label(section.id));
    const input = label(section.id);
    assert.equal(input.tagName, "input");
    (input as HTMLInputElement).value = "Uncommitted rename";
    if (markerOnly) await render(true);
    else await act(() => canvas.editor.setPreview(proposal));
    assert.equal(label(section.id).tagName, "button");
    await send("focusout", input);
    await send("dblclick", label(section.id));
    await send("keydown", label(board.id), { key: "F2" });
    await send("pointerdown", label(board.id));
    await send("pointermove", surface, { clientX: 60 });
    await send("pointerup", surface, { clientX: 60 });
    assert.equal(label(section.id).tagName, "button");
    assert.equal(label(board.id).tagName, "button");
    assert.equal(canvas.editor.doc, markerOnly ? base : proposal);
    assert.equal(canvas.editor.historyRef.current.past.length, 0);
    await render();
    await act(() => canvas.editor.setPreview(null));
  }
  const start = () =>
    send("pointerdown", label(board.id), { clientX: 25, clientY: -12 });
  await start();
  await send("pointermove", surface, { clientX: 55, clientY: -12 });
  assert.notEqual(canvas.editor.doc, base);
  await act(() => canvas.editor.setPreview(proposal));
  assert.equal(captured.has(surface), false);
  await send("pointerup", surface);
  assert.equal(canvas.editor.committed, base);
  assert.equal(canvas.editor.doc, proposal);
  await act(() => canvas.editor.setPreview(null));

  await act(() => canvas.editor.setSelection([board.id, other.id]));
  await start();
  await send("pointerdown", label(other.id), { pointerId: 8 });
  for (const type of [
    "pointermove",
    "pointerup",
    "pointercancel",
    "lostpointercapture",
  ]) {
    await send(type, surface, { pointerId: 8, clientX: 750 });
    assert.equal(captured.get(surface), 7);
    assert.equal(canvas.editor.doc, base);
  }
  // Both boards move by 30; the title itself remains above the section's top edge.
  const finish = { clientX: 55, clientY: -12 };
  await send("pointermove", surface, finish);
  await send("pointerup", surface, finish);
  const [nested, outside] = [board, other].map((n) =>
    canvas.editor.committed.nodes.find((node) => node.id === n.id)!,
  );
  assert.deepEqual(
    [nested.parentId, nested.style.x, nested.style.y],
    [section.id, 55, 1],
  );
  assert.deepEqual(
    [outside.parentId, outside.style.x, outside.style.y],
    [null, 320, 1],
  );
  assert.equal(canvas.editor.historyRef.current.past.length, 1);
  await start();
  await send("pointermove", surface, finish);
  await send("lostpointercapture", surface);
  await send("pointerup", surface, finish);
  assert.equal(canvas.editor.doc, canvas.editor.committed);
  assert.equal(canvas.editor.historyRef.current.past.length, 1);
});

for (const layout of ["row", "grid"] as const) {
  test(`absolute child of a ${layout} frame previews and commits free coordinates without reordering or assigning a cell`, async (t) => {
    const parent = createNode("frame");
    Object.assign(parent.style, {
      x: 0,
      y: 0,
      width: 240,
      height: 150,
      layout,
      columns: 2,
    });
    const child = createNode("rectangle", parent.id);
    Object.assign(child.style, {
      x: 12,
      y: 20,
      width: 24,
      height: 16,
      absolutePosition: true,
    });
    const sibling = createNode("rectangle", parent.id);
    Object.assign(sibling.style, { width: 10, height: 10 });
    const canvas = await mountCanvas(t, {
      ...createStarter(),
      nodes: [parent, child, sibling],
    });
    await act(() => canvas.editor.setSelection([child.id]));
    const before = canvas.editor.committed;
    await canvas.send("pointerdown", canvas.layer(child.id), {
      clientX: 24,
      clientY: 28,
    });
    const finish = { clientX: 69, clientY: 56 };
    await canvas.send("pointermove", canvas.surface, finish);
    const result = (doc: DesignDocument) => {
      const n = doc.nodes.find((n) => n.id === child.id)!;
      assert.deepEqual(
        [n.parentId, n.style.x, n.style.y, n.style.gridCell],
        [parent.id, 57, 48, undefined],
      );
      assert.deepEqual(
        doc.nodes.map((n) => n.id),
        before.nodes.map((n) => n.id),
      );
    };
    result(canvas.editor.doc);
    assert.equal(canvas.editor.committed, before);
    await canvas.send("pointerup", canvas.surface, finish);
    result(canvas.editor.committed);
    assert.equal(canvas.editor.historyRef.current.past.length, 1);
  });
}

test("Canvas switches nested guide branches between a tile and live layers and suppresses tiny unselected titles", async (t) => {
  const boards = Array.from({ length: 12 }, (_, i) => {
    const board = createNode("frame");
    Object.assign(board.style, {
      x: i * 250,
      y: 0,
      width: 240,
      height: 160,
      clipContent: true,
    });
    const children = Array.from({ length: 9 }, () =>
      createNode("frame", board.id),
    );
    return [board, ...children];
  });
  const [guided, guideLayer] = boards[0];
  guideLayer.style.layoutGuides = [
    layoutGuideSchema.parse({ id: "grid", kind: "grid" }),
  ];
  const [unsupported, shadow] = boards[1];
  shadow.style.blur = 8;
  const canvas = await mountCanvas(
    t,
    { ...createStarter(), nodes: boards.flat() },
    0.15,
  );
  const mode = (id: string) => canvas.layer(id).getAttribute("data-lod");
  assert.equal(mode(guided.id), "cached");
  assert.equal(canvas.label(guided.id), undefined);
  assert.notEqual(mode(unsupported.id), "cached");
  await canvas.render(false, true);
  assert.notEqual(mode(guided.id), "cached");
  assert.ok(canvas.layer(guideLayer.id));
  await canvas.render();
  assert.equal(mode(guided.id), "cached");
  const center = { clientX: 18, clientY: 12 };
  await canvas.send("pointerdown", canvas.layer(guided.id), center);
  assert.deepEqual(canvas.editor.selection, [guided.id]);
  assert.notEqual(mode(guided.id), "cached");
  assert.equal(canvas.label(guided.id).getAttribute("tabindex"), "0");
  await canvas.send("pointerup", canvas.surface, center);
  await act(() => canvas.editor.setSelection([]));
  assert.equal(canvas.label(guided.id), undefined);
  await canvas.send("pointermove", canvas.layer(guided.id), center);
  assert.equal(canvas.label(guided.id).tagName, "button");
});

test("a file mode change invalidates an unselected board's mounted tile at 15% zoom", async (t) => {
  const boards = Array.from({ length: 12 }, () => createNode("frame"));
  const board = boards[0];
  board.style.clipContent = true;
  const children = Array.from({ length: 9 }, () =>
    createNode("rectangle", board.id),
  );
  const child = children[0];
  child.variableBindings = { fill: "color-surface" };
  const system = nativeDesignSystem();
  system.variables["color-surface"].values = {
    light: "#e13649",
    dark: "#264ed1",
  };
  system.activeModes.semantic = "light";
  const request = t.mock.method(boardTileCache, "request");
  const canvas = await mountCanvas(
    t,
    {
      ...createStarter(),
      nodes: [...boards, ...children],
      designSystem: system,
    },
    0.15,
  );
  function requestedPaint() {
    const call = request.mock.calls.find((c) => c.arguments[1] === board.id);
    assert.ok(call);
    const [doc] = call.arguments;
    return {
      signature: boardBranchSignature(doc, board.id),
      fill: resolveNode(
        doc,
        doc.nodes.find((n) => n.id === child.id)!,
      ).style.fill,
    };
  }
  const tile = () => canvas.layer(board.id).getElementsByTagName("canvas")[0];
  const mounted = tile();
  assert.ok(mounted);
  assert.deepEqual(canvas.editor.selection, []);
  const before = requestedPaint();
  assert.equal(before.fill, "#e13649");
  request.mock.resetCalls();
  await act(() =>
    canvas.editor.apply([
      {
        type: "setDesignSystem",
        system: {
          ...system,
          activeModes: { ...system.activeModes, semantic: "dark" },
        },
      },
    ]),
  );
  assert.deepEqual(canvas.editor.selection, []);
  assert.equal(canvas.layer(board.id).getAttribute("data-lod"), "cached");
  assert.equal(tile(), mounted);
  const after = requestedPaint();
  assert.equal(after.fill, "#264ed1");
  assert.notEqual(after.signature, before.signature);
});

test("canvas feel rules stay inside the panels layer with zero important declarations", () => {
  const css = readFileSync(
    new URL("../src/editor/canvas-feel.css", import.meta.url),
    "utf8",
  );
  const sheet = parse(css);
  assert.ok(sheet.nodes.length > 0);
  for (const block of sheet.nodes) {
    assert.ok(
      block.type === "atrule" &&
        block.name === "layer" &&
        block.params === "panels",
    );
  }
  sheet.walkDecls((decl) => {
    assert.ok(!decl.important, decl.toString());
  });
});
