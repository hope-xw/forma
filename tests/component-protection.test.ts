import test from "node:test";
import assert from "node:assert/strict";
import { createStarter } from "../src/domain/seed";
import {
  createNode,
  parseDocument,
  type DesignDocument,
} from "../src/domain/document";
import { transact, type Operation } from "../src/domain/commands";
import {
  instantiateComponent,
  detachInstance,
  switchInstance,
} from "../src/domain/library";
import { mobileComponentLibrary } from "../src/design-system/mobile";
import { createMediaTemplate } from "../src/design-system/mobile-media-template";
import { copySelection, pasteSelection } from "../src/domain/clipboard";
import { insertionParent } from "../src/domain/tree";
import { commit, travel } from "../src/application/history";
import { validateProposal } from "../src/agent/provider";
import { nodeCss, exportReact } from "../src/compiler/react";
import { runtimeNodes, pageForExport } from "../src/compiler/runtime";
const apply = (doc: DesignDocument, operations: Operation[]) =>
  transact(doc, { baseRevision: doc.revision, operations });
const blank = (): DesignDocument => ({ ...createStarter(), nodes: [] });
function fixture() {
  const empty = blank();
  const result = instantiateComponent(
    empty,
    mobileComponentLibrary("navigation"),
    "navigation",
    "Light-Large-Solid",
    null,
    { x: 100, y: 50 },
  );
  const doc = apply(empty, result.operations);
  return {
    doc,
    root: doc.nodes.find((n) => n.id === result.id)!,
    child: doc.nodes.find((n) => n.templateKey === "title")!,
  };
}
test("protected instances reject destructive structural operations atomically", () => {
  const { doc, root, child } = fixture(),
    before = JSON.stringify(doc);
  const ops: Operation[] = [
    { type: "remove", id: child.id },
    { type: "move", id: child.id, parentId: null },
    { type: "reorder", id: child.id, index: 0 },
    { type: "create", node: createNode("text", root.id) },
    { type: "update", id: child.id, patch: {}, style: { x: 40 } },
    { type: "update", id: child.id, patch: {}, style: { width: 40 } },
    { type: "update", id: root.id, patch: {}, style: { layout: "column" } },
    { type: "update", id: root.id, patch: { instance: undefined } },
    { type: "update", id: child.id, patch: { templateKey: undefined } },
  ];
  for (const op of ops) {
    assert.throws(
      () =>
        apply(doc, [
          { type: "update", id: root.id, patch: { name: "must roll back" } },
          op,
        ]),
      /受保护/,
    );
    assert.equal(JSON.stringify(doc), before);
  }
});
test("normal nodes cannot forge instance metadata and external nodes cannot enter instances", () => {
  const { doc, root } = fixture(),
    ordinary = createNode("text");
  const next = apply(doc, [{ type: "create", node: ordinary }]);
  assert.throws(
    () =>
      apply(next, [
        {
          type: "update",
          id: ordinary.id,
          patch: { instance: root.instance, templateKey: "root" },
        },
      ]),
    /受保护/,
  );
  assert.throws(
    () => apply(next, [{ type: "move", id: ordinary.id, parentId: root.id }]),
    /受保护/,
  );
});
test("text, visual overrides, visibility and ordinary unlock do not dismantle protection", () => {
  const { doc, child } = fixture();
  const edited = apply(doc, [
    {
      type: "update",
      id: child.id,
      patch: { text: "我的页面", hidden: true, locked: false },
      style: { color: "#123456", fontSize: 20, opacity: 0.6 },
    },
  ]);
  assert.equal(edited.nodes.find((n) => n.id === child.id)?.text, "我的页面");
  assert.throws(
    () => apply(edited, [{ type: "remove", id: child.id }]),
    /受保护/,
  );
});
test("explicit detach is reversible and alone unlocks structural editing", () => {
  const { doc, root, child } = fixture();
  const next = apply(doc, detachInstance(doc, root.id));
  assert.ok(next.nodes.every((n) => !n.instance && !n.templateKey));
  assert.ok(
    !apply(next, [{ type: "remove", id: child.id }]).nodes.some(
      (n) => n.id === child.id,
    ),
  );
  const undone = travel(
    commit({ present: doc, past: [], future: [] }, next),
    "undo",
  ).present;
  assert.throws(
    () => apply(undone, [{ type: "remove", id: child.id }]),
    /受保护/,
  );
});
test("whole instances can move, duplicate across documents, delete and switch variants", () => {
  const { doc, root } = fixture();
  const moved = apply(doc, [
    { type: "update", id: root.id, patch: {}, style: { x: 900, y: -200 } },
  ]);
  const switched = apply(
    moved,
    switchInstance(moved, root.id, "Dark-Inline-Glass"),
  );
  assert.equal(switched.nodes[0].style.x, 900);
  const target = blank(),
    copy = pasteSelection(target, copySelection(switched, [root.id]), null, {
      x: 0,
      y: 0,
    });
  const pasted = apply(target, copy.operations);
  assert.ok(pasted.nodes[0].instance);
  assert.throws(
    () => apply(pasted, [{ type: "remove", id: pasted.nodes[1].id }]),
    /受保护/,
  );
  assert.equal(
    apply(pasted, [{ type: "remove", id: pasted.nodes[0].id }]).nodes.length,
    0,
  );
});
test("new instance construction validates its entire source graph", () => {
  const empty = blank(),
    result = instantiateComponent(
      empty,
      mobileComponentLibrary("navigation"),
      "navigation",
      "Light-Large-Solid",
      null,
      { x: 0, y: 0 },
    );
  const created = result.operations.filter((op) => op.type === "create");
  assert.throws(
    () =>
      apply(
        empty,
        result.operations.filter((op) => op !== created.at(-1)),
      ),
    /结构/,
  );
  const extra = createNode("text", result.id);
  assert.throws(
    () => apply(empty, [...result.operations, { type: "create", node: extra }]),
    /结构/,
  );
});
test("paste and asset insertion resolve to the parent of the protected instance", () => {
  const { doc, root, child } = fixture();
  assert.equal(insertionParent(doc, root), null);
  assert.equal(insertionParent(doc, child), null);
  const frame = createNode("frame"),
    nested = apply(doc, [
      { type: "create", node: frame },
      { type: "move", id: root.id, parentId: frame.id },
    ]);
  assert.equal(
    insertionParent(
      nested,
      nested.nodes.find((n) => n.id === child.id),
    ),
    frame.id,
  );
});
test("agent proposals share protection rules and can perform safe text overrides", () => {
  const { doc, root, child } = fixture(),
    context = { document: doc, prompt: "更新标题", selection: root.id };
  assert.throws(
    () =>
      validateProposal(context, {
        baseRevision: doc.revision,
        operations: [{ type: "remove", id: child.id }],
      }),
    /受保护/,
  );
  assert.ok(
    validateProposal(context, {
      baseRevision: doc.revision,
      operations: [{ type: "update", id: child.id, patch: { text: "新标题" } }],
    }),
  );
});
test("complex page has real vectors, protected reusable components and serializable gradient effects in both themes", () => {
  for (const appearance of ["Light", "Dark"] as const) {
    const empty = blank(),
      result = createMediaTemplate(empty, appearance, { x: -800, y: 300 });
    const doc = apply(empty, result.operations);
    assert.ok(doc.nodes.length >= 300);
    assert.ok(doc.nodes.filter((n) => n.type === "vector").length >= 90);
    assert.equal(doc.nodes.filter((n) => n.instance).length, 20);
    assert.ok(doc.nodes.filter((n) => n.style.gradient).length >= 10);
    assert.deepEqual(parseDocument(JSON.parse(JSON.stringify(doc))), doc);
    const page = pageForExport(doc, [result.id]);
    assert.equal(page.nodes[0].style.x, 0);
    assert.equal(page.nodes[0].style.y, 0);
    const runtime = runtimeNodes(page);
    assert.equal(
      runtime[0].children.length,
      page.nodes.filter((n) => n.parentId === result.id).length,
    );
    assert.match(exportReact(page), /linear-gradient/);
  }
});
test("gradient ordering and opacity compile consistently without arbitrary CSS", () => {
  const doc = blank(),
    node = createNode("rectangle");
  node.style.fillOpacity = 0.5;
  node.style.gradient = {
    type: "linear",
    angle: 90,
    stops: [
      { offset: 1, color: "#ffffff", opacity: 0.6 },
      { offset: 0, color: "#000000", opacity: 1 },
    ],
  };
  doc.nodes.push(node);
  assert.equal(
    nodeCss(node, doc).background,
    "linear-gradient(90deg, rgba(0, 0, 0, 0.5) 0%, rgba(255, 255, 255, 0.3) 100%)",
  );
  assert.equal(
    runtimeNodes(doc)[0].style.background,
    nodeCss(node, doc).background,
  );
  assert.throws(() =>
    parseDocument({
      ...doc,
      nodes: [
        {
          ...node,
          style: {
            ...node.style,
            gradient: { ...node.style.gradient, angle: Infinity },
          },
        },
      ],
    }),
  );
});

test("clipboard permission prompts time out instead of blocking editor actions", async () => {
  const { clipboardRequest } = await import("../src/infrastructure/clipboard");
  await assert.rejects(
    clipboardRequest(new Promise<string>(() => {}), 5),
    /剪贴板未响应/,
  );
  assert.equal(
    await clipboardRequest(Promise.resolve("forma-test-buffer")),
    "forma-test-buffer",
  );
  await assert.rejects(
    clipboardRequest(Promise.reject(new Error("denied"))),
    /denied/,
  );
});
