import test from "node:test";
import assert from "node:assert/strict";
import { createNode, type DesignDocument } from "../src/domain/document";
import { createStarter } from "../src/domain/seed";
import { copySelection, pasteSelection } from "../src/domain/clipboard";
import { duplicatePage } from "../src/domain/pages";
import { maskSelection } from "../src/domain/boolean-shapes";
import { transact, type Operation } from "../src/domain/commands";
import {
  createLibraryFromSelection,
  instantiateComponent,
} from "../src/domain/library";
import { parseLibrary } from "../src/domain/library-schema";
import { runtimeNodes } from "../src/compiler/runtime";
const apply = (doc: DesignDocument, operations: Operation[]) =>
  transact(doc, { baseRevision: doc.revision, operations });
function masked() {
  const shape = createNode("ellipse"),
    paint = createNode("text");
  const doc = { ...createStarter(), nodes: [shape, paint] };
  const group = maskSelection(doc, [paint.id, shape.id]);
  return { doc: apply(doc, group.operations), id: group.id, shape, paint };
}
function assertMask(doc: DesignDocument, id: string) {
  const group = doc.nodes.find((n) => n.id === id)!;
  const source = doc.nodes.find((n) => n.id === group.maskSourceId);
  assert.equal(source?.parentId, id);
  assert.equal(source.type, "ellipse");
  const output = runtimeNodes(doc, [id])[0];
  assert.match(String(output.style.clipPath), /^path\(/);
  assert.deepEqual(
    output.children.map((n) => n.type),
    ["text"],
  );
  return source.id;
}
test("duplicating a mask via clipboard, page, and component remaps its shape and preserves its editable paint", () => {
  const { doc, id, shape } = masked();
  const paste = pasteSelection(doc, copySelection(doc, [id]), null);
  const dup = duplicatePage(doc);
  const library = createLibraryFromSelection(doc, id, "Masked label");
  const empty = { ...createStarter(), nodes: [] };
  const instance = instantiateComponent(
    empty,
    library,
    library.components[0].id,
    "default",
    null,
    { x: 0, y: 0 },
  );
  const sources = [
    assertMask(apply(doc, paste.operations), paste.selection[0]),
    assertMask(dup, dup.nodes.find((n) => !!n.maskSourceId)!.id),
    assertMask(apply(empty, instance.operations), instance.id),
  ];
  assert.equal(new Set([shape.id, ...sources]).size, 4);
  const removed = apply(doc, [{ type: "remove", id: shape.id }]);
  assert.equal(removed.nodes.find((n) => n.id === id)?.maskSourceId, undefined);
  assert.equal(runtimeNodes(removed, [id])[0].style.clipPath, undefined);
});
test("external library variants reject broken mask and text references on import", () => {
  const { doc, id } = masked();
  const library = createLibraryFromSelection(doc, id, "Masked label");
  const nodes = library.components[0].variants[0].nodes;
  const root = nodes.find((n) => n.id === id)!;
  const previous = root.maskSourceId;
  root.maskSourceId = "missing";
  assert.throws(() => parseLibrary(library), /蒙版/);
  root.maskSourceId = previous;
  nodes.find((n) => n.type === "text")!.textRuns = [
    { start: 0, end: 1000, style: { fontWeight: 700 } },
  ];
  assert.throws(() => parseLibrary(library), /文字样式/);
});
