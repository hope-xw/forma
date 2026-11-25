import test from "node:test";
import assert from "node:assert/strict";
import { createStarter } from "../src/domain/seed";
import { createNode, type DesignDocument } from "../src/domain/document";
import { transact, type Operation } from "../src/domain/commands";
import {
  createLibraryFromSelection,
  instantiateComponent,
} from "../src/domain/library";
import { openPage } from "../src/domain/pages";
const apply = (d: DesignDocument, ...ops: Operation[]) =>
  transact(d, { baseRevision: d.revision, operations: ops });
test("master changes propagate by stable layer identity across pages; overrides and instance placement survive", () => {
  let d = createStarter();
  const master = createNode("frame"),
    label = createNode("text", master.id);
  d.nodes = [master, label];
  const lib = createLibraryFromSelection(d, master.id, "Controls");
  d = apply(d, { type: "putLibrary", library: lib });
  d.pages = [
    { id: "source", name: "Master" },
    { id: "usage", name: "Usage", nodes: [] },
  ];
  d.activePage = "source";
  d = openPage(d, "usage");
  const instance = instantiateComponent(d, lib, "component", "default", null, {
    x: 87,
    y: 99,
  });
  d = apply(d, ...instance.operations);
  const text = d.nodes.find((n) => n.type === "text")!;
  d = apply(d, { type: "update", id: text.id, patch: { text: "Override" } });
  d = openPage(d, "source");
  const added = createNode("ellipse", master.id);
  d = apply(
    d,
    {
      type: "update",
      id: label.id,
      patch: { text: "Updated", name: "Renamed" },
      style: { fontSize: 32 },
    },
    { type: "create", node: added },
  );
  const use = openPage(d, "usage").nodes;
  assert.equal(use.find((n) => n.id === text.id)?.text, "Override");
  assert.equal(use.find((n) => n.id === text.id)?.style.fontSize, 32);
  assert.equal(use.find((n) => n.id === text.id)?.name, "Renamed");
  assert.ok(use.some((n) => n.type === "ellipse"));
  assert.equal(use.find((n) => !n.parentId)?.style.x, 87);
  assert.throws(() => apply(d, { type: "remove", id: label.id }), /已编辑/);
});
test("published revisions update inherited prototype targets and preserve explicit instance actions", () => {
  const source = createStarter(),
    root = createNode("frame"),
    trigger = createNode("button", root.id),
    first = createNode("text", root.id),
    second = createNode("text", root.id);
  first.name = "First";
  second.name = "Second";
  trigger.interaction = { actions: [{ kind: "scrollTo", target: first.id }] };
  source.nodes = [root, trigger, first, second];
  const library = createLibraryFromSelection(source, root.id, "Navigation");
  const target = { ...createStarter(), id: "consumer", nodes: [] };
  const inserted = instantiateComponent(
    target,
    library,
    "component",
    "default",
    null,
    { x: 0, y: 0 },
  );
  const doc = apply(target, ...inserted.operations);
  const instanceButton = doc.nodes.find((n) => n.type === "button")!;
  const next = structuredClone(library);
  next.revision++;
  next.components[0].variants[0].nodes.find(
    (n) => n.id === trigger.id,
  )!.interaction = { actions: [{ kind: "scrollTo", target: second.id }] };
  const update: Operation = {
    type: "updateLibrary",
    library: next,
    expectedRevision: library.revision,
  };
  const merged = apply(doc, update);
  const destination = merged.nodes.find((n) => n.name === "Second")!;
  assert.deepEqual(
    merged.nodes.find((n) => n.id === instanceButton.id)?.interaction?.actions,
    [{ kind: "scrollTo", target: destination.id }],
  );
  const edited = apply(doc, {
    type: "update",
    id: instanceButton.id,
    patch: { interaction: { actions: [{ kind: "back" }] } },
  });
  assert.deepEqual(
    apply(edited, update).nodes.find((n) => n.id === instanceButton.id)
      ?.interaction?.actions,
    [{ kind: "back" }],
  );
  assert.throws(() => apply(merged, update), /版本/);
});
