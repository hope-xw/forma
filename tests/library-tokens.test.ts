import test from "node:test";
import assert from "node:assert/strict";
import { createStarter } from "../src/domain/seed";
import { createNode, type DesignDocument } from "../src/domain/document";
import { nativeDesignSystem } from "../src/design-system/tokens";
import {
  createLibraryFromSelection,
  instantiateComponent,
} from "../src/domain/library";
import { parseLibrary } from "../src/domain/library-schema";
import { copySelection, pasteSelection } from "../src/domain/clipboard";
import { resolveNode } from "../src/domain/design-system";
import { transact, type Operation } from "../src/domain/commands";
const apply = (d: DesignDocument, ...operations: Operation[]) =>
  transact(d, { baseRevision: d.revision, operations });
function fixture() {
  const doc = createStarter(),
    master = createNode("frame"),
    child = createNode("rectangle", master.id);
  doc.designSystem = nativeDesignSystem();
  child.styleBindings = { paint: "paint-accent" };
  child.variableBindings = { radius: "radius-md" };
  doc.nodes = [master, child];
  const lib = createLibraryFromSelection(doc, master.id, "Tokens");
  return { doc, master, child, lib };
}
test("portable component captures referenced styles, all mode aliases and number bindings", () => {
  const { doc, lib } = fixture(),
    system = lib.designSystem!;
  assert.deepEqual(Object.keys(system.variables).sort(), [
    "color-accent",
    "palette-dark-accent",
    "palette-light-accent",
    "radius-md",
  ]);
  assert.deepEqual(Object.keys(system.styles), ["paint-accent"]);
  const file = createStarter();
  file.nodes = [];
  const inst = instantiateComponent(
    file,
    parseLibrary(JSON.parse(JSON.stringify(lib))),
    "component",
    "default",
    null,
    { x: 0, y: 0 },
  );
  const target = apply(file, ...inst.operations);
  const root = target.nodes.find((n) => n.id === inst.id)!,
    leaf = target.nodes.find((n) => n.parentId === root.id)!;
  assert.equal(leaf.styleBindings!.paint, "paint-accent");
  const themed = apply(target, {
    type: "update",
    id: root.id,
    patch: { variableModes: { semantic: "dark", layout: "compact" } },
  });
  const actual = resolveNode(
    themed,
    themed.nodes.find((n) => n.id === leaf.id)!,
  );
  assert.equal(actual.style.radius, 12);
  assert.equal(
    actual.style.fill,
    doc.designSystem!.variables["palette-dark-accent"].values.base,
  );
  const bad = structuredClone(lib);
  delete bad.designSystem!.variables["palette-light-accent"];
  assert.throws(() => parseLibrary(bad));
});
test("foreign variable collisions preserve the host theme and map copied instances to their imported styles", () => {
  const { doc, master, lib } = fixture();
  const original = instantiateComponent(
    doc,
    lib,
    "component",
    "default",
    null,
    { x: 30, y: 0 },
  );
  const source = apply(doc, ...original.operations);
  const target = createStarter();
  target.nodes = [];
  target.designSystem = nativeDesignSystem();
  target.designSystem.variables["palette-light-accent"].values.base = "#123456";
  const copied = pasteSelection(
    target,
    copySelection(source, [original.id]),
    null,
  );
  const output = apply(target, ...copied.operations);
  const child = output.nodes.find((n) => !!n.styleBindings?.paint)!;
  const imported =
    output.libraries![
      output.nodes.find((n) => !!n.instance)!.instance!.libraryId
    ];
  const template = imported.components[0].variants[0].nodes.find(
    (n) => !!n.styleBindings?.paint,
  )!;
  assert.equal(child.styleBindings!.paint, template.styleBindings!.paint);
  assert.notEqual(child.styleBindings!.paint, "paint-accent");
  assert.equal(
    output.designSystem!.variables["palette-light-accent"].values.base,
    "#123456",
  );
  assert.equal(
    resolveNode(output, child).style.fill,
    doc.designSystem!.variables["palette-light-accent"].values.base,
  );
  assert.equal(source.nodes.find((n) => n.id === master.id)!.name, master.name);
});
test("changes to a master component's bound token are included when re-exporting its library", () => {
  const { doc, master, lib } = fixture();
  let current = apply(doc, { type: "putLibrary", library: lib });
  const system = structuredClone(current.designSystem!);
  system.variables["palette-dark-accent"].values.base = "#ff22aa";
  current = apply(current, { type: "setDesignSystem", system });
  assert.equal(
    current.libraries![lib.id].designSystem!.variables["palette-dark-accent"]
      .values.base,
    "#ff22aa",
  );
  assert.ok(current.nodes.some((n) => n.id === master.id));
});
