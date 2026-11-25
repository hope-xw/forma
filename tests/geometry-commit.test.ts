import test from "node:test";
import assert from "node:assert/strict";
import { createStarter } from "../src/domain/seed";
import { createNode, parseDocument } from "../src/domain/document";
import { commitEditorOperations } from "../src/application/geometry-preview";
import { indexPublishedScene } from "../src/domain/scene-index";
import { transact, type Operation } from "../src/domain/commands";
import {
  createLibraryFromSelection,
  instantiateComponent,
} from "../src/domain/library";
import { localMasters } from "../src/domain/component-masters";
test("published geometry transactions match a full transaction for installed instances and reject invalid edits", () => {
  const source = createStarter(),
    root = source.nodes[0];
  const lib = createLibraryFromSelection(source, root.id, "Card");
  const target = { ...createStarter(), id: "destination" };
  const instance = instantiateComponent(
    target,
    lib,
    lib.components[0].id,
    "default",
    null,
    { x: 0, y: 0 },
  );
  const doc = parseDocument(
    transact(target, { baseRevision: 0, operations: instance.operations }),
  );
  assert.equal(localMasters(doc).length, 0);
  indexPublishedScene(doc);
  const ops: Operation[] = [
    { type: "update", id: instance.id, patch: {}, style: { x: 93 } },
    {
      type: "update",
      id: instance.id,
      patch: {},
      style: { rotation: -63, y: 206 },
    },
  ];
  const result = commitEditorOperations(doc, ops, doc.revision);
  assert.deepEqual(
    result,
    transact(doc, { baseRevision: doc.revision, operations: ops }),
  );
  assert.equal(result.libraries, doc.libraries);
  assert.equal(result.nodes[0], doc.nodes[0]);
  assert.throws(
    () => commitEditorOperations(doc, ops, doc.revision - 1),
    /文件已变化/,
  );
  assert.throws(() =>
    commitEditorOperations(
      doc,
      [
        {
          type: "update",
          id: instance.id,
          patch: {},
          style: { rotation: 500 },
        },
      ],
      doc.revision,
    ),
  );
  const inside = doc.nodes.find((n) => n.parentId === instance.id)!;
  assert.throws(
    () =>
      commitEditorOperations(
        doc,
        [{ type: "update", id: inside.id, patch: {}, style: { x: 100 } }],
        doc.revision,
      ),
    /保护/,
  );
  const locked = {
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.id === instance.id ? { ...n, locked: true } : n,
    ),
  };
  indexPublishedScene(locked);
  assert.throws(
    () => commitEditorOperations(locked, ops, locked.revision),
    /锁定/,
  );
});
test("group rebasing and local component propagation use the full editing transaction", () => {
  const doc = createStarter(),
    g = createNode("group"),
    leaf = createNode("rectangle", g.id);
  doc.nodes.push(g, leaf);
  indexPublishedScene(doc);
  const ops: Operation[] = [
    { type: "update", id: leaf.id, patch: {}, style: { x: 80 } },
  ];
  assert.deepEqual(
    commitEditorOperations(doc, ops, doc.revision),
    transact(doc, { baseRevision: doc.revision, operations: ops }),
  );
  const master = createStarter(),
    root = master.nodes[0];
  const lib = createLibraryFromSelection(master, root.id, "Local");
  const instance = instantiateComponent(
    master,
    lib,
    lib.components[0].id,
    "default",
    null,
    { x: 800, y: 40 },
  );
  const linked = transact(master, {
    baseRevision: master.revision,
    operations: instance.operations,
  });
  indexPublishedScene(linked);
  const move: Operation[] = [
    { type: "update", id: root.id, patch: {}, style: { x: 100 } },
  ];
  assert.deepEqual(
    commitEditorOperations(linked, move, linked.revision),
    transact(linked, { baseRevision: linked.revision, operations: move }),
  );
});
