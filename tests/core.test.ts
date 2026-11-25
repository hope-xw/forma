import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { createStarter } from "../src/domain/seed";
import { createNode, parseDocument } from "../src/domain/document";
import { transact } from "../src/domain/commands";
import { commit, travel } from "../src/application/history";
import { exportReact } from "../src/compiler/react";

test("source document can be serialized and reopened without losing IDs, hierarchy or tokens", () => {
  const doc = createStarter();
  assert.deepEqual(parseDocument(JSON.parse(JSON.stringify(doc))), doc);
});
test("failed batch does not apply any partial change", () => {
  const doc = createStarter();
  const original = structuredClone(doc);
  assert.throws(() =>
    transact(doc, {
      baseRevision: 0,
      operations: [
        { type: "update", id: doc.nodes[0].id, patch: { name: "changed" } },
        { type: "remove", id: "missing" },
      ],
    }),
  );
  assert.deepEqual(doc, original);
});
test("agent cannot overwrite changes made after reading its context", () => {
  const doc = createStarter();
  const next = transact(doc, {
    baseRevision: 0,
    operations: [
      { type: "update", id: doc.nodes[0].id, patch: { name: "manual" } },
    ],
  });
  assert.throws(
    () =>
      transact(next, {
        baseRevision: 0,
        operations: [
          { type: "update", id: doc.nodes[0].id, patch: { name: "agent" } },
        ],
      }),
    /文件已变化/,
  );
  assert.equal(next.nodes[0].name, "manual");
});
test("cycles, missing parent and non-frame parent are rejected", () => {
  for (const parentId of ["missing", "self"]) {
    const node = createNode("frame");
    node.id = "self";
    node.parentId = parentId;
    assert.throws(() => parseDocument({ ...createStarter(), nodes: [node] }));
  }
  const doc = createStarter();
  doc.nodes[0].parentId = doc.nodes[1].id;
  assert.throws(() => parseDocument(doc));
});
test("duplicate IDs and dangling token bindings are rejected", () => {
  const doc = createStarter();
  assert.throws(() =>
    parseDocument({ ...doc, nodes: [...doc.nodes, doc.nodes[0]] }),
  );
  doc.nodes[0].fillToken = "missing";
  assert.throws(() => parseDocument(doc));
});
test("delete removes all descendants atomically", () => {
  const doc = createStarter();
  const root = doc.nodes[0];
  const next = transact(doc, {
    baseRevision: 0,
    operations: [{ type: "remove", id: root.id }],
  });
  assert.ok(next.nodes.length < doc.nodes.length - 1);
  assert.ok(!next.nodes.some((n) => n.parentId === root.id));
  parseDocument(next);
});
test("locked descendants prevent deletion of their containing frame", () => {
  const doc = createStarter();
  doc.nodes[1].locked = true;
  assert.throws(
    () =>
      transact(doc, {
        baseRevision: 0,
        operations: [{ type: "remove", id: doc.nodes[0].id }],
      }),
    /锁定/,
  );
});
test("invalid geometry is rejected without mutating source", () => {
  const doc = createStarter();
  assert.throws(() =>
    transact(doc, {
      baseRevision: 0,
      operations: [
        {
          type: "update",
          id: doc.nodes[0].id,
          patch: {},
          style: { width: -1 },
        },
      ],
    }),
  );
  assert.equal(doc.nodes[0].style.width, 760);
});
test("undo and redo preserve document content but advance revision monotonically", () => {
  const doc = createStarter();
  const next = transact(doc, {
    baseRevision: 0,
    operations: [
      { type: "update", id: doc.nodes[0].id, patch: { name: "new" } },
    ],
  });
  const history = commit({ present: doc, past: [], future: [] }, next);
  const undo = travel(history, "undo");
  assert.equal(undo.present.nodes[0].name, doc.nodes[0].name);
  assert.equal(undo.present.revision, 2);
  const redo = travel(undo, "redo");
  assert.equal(redo.present.nodes[0].name, "new");
  assert.equal(redo.present.revision, 3);
});
test("legacy image fills survive edits and history snapshots isolate asset metadata", () => {
  const doc = createStarter();
  const assetId =
    "img-7ac2abfce2be8b46dd9826d597d94edeefc1570b4a992622721b90a1850e3ee9";
  const asset = {
    name: "tile.png",
    width: 1,
    height: 1,
    data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  };
  const fill = { assetId, fit: "cover", x: 50, y: 50, zoom: 2 } as const;
  doc.images = { [assetId]: asset };
  doc.nodes[0].image = fill;
  const legacy = parseDocument(doc);
  const next = transact(legacy, {
    baseRevision: legacy.revision,
    operations: [
      {
        type: "update",
        id: legacy.nodes[0].id,
        patch: {
          image: { ...fill, fit: "tile", tileScale: 0.5, saturation: 0 },
        },
      },
    ],
  });
  const undo = travel(
    commit({ present: legacy, past: [], future: [] }, next),
    "undo",
  );
  assert.deepEqual(undo.present.nodes[0].image, fill);
  undo.present.images![assetId].name = "undo.png";
  assert.equal(legacy.images![assetId].name, "tile.png");
  const redo = travel(undo, "redo");
  assert.deepEqual(redo.present.nodes[0].image, next.nodes[0].image);
  assert.deepEqual(redo.present.images![assetId], asset);
  assert.notEqual(redo.present.images![assetId], next.images![assetId]);
});
test("editing after undo clears the redo branch", () => {
  const doc = createStarter();
  const undo = travel(
    commit({ present: doc, past: [], future: [] }, { ...doc, revision: 1 }),
    "undo",
  );
  assert.equal(commit(undo, { ...doc, revision: 3 }).future.length, 0);
});
test("React export remains parseable with JSX metacharacters in content and node IDs", () => {
  const doc = createStarter();
  doc.nodes[1].text = '</p><script>alert("x")</script> {hello}';
  doc.nodes[1].id = 'quotes"<>';
  const source = exportReact(doc);
  const output = ts.transpileModule(source, {
    fileName: "DesignPage.tsx",
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  assert.equal(output.diagnostics?.length, 0);
  assert.ok(source.includes("var(--token-brand)"));
  assert.ok(source.includes("flexDirection"));
});
