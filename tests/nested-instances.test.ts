import test from "node:test";
import assert from "node:assert/strict";
import {
  createNode,
  type DesignDocument,
  parseDocument,
} from "../src/domain/document";
import { transact, type Operation } from "../src/domain/commands";
import {
  createLibraryFromSelection,
  instantiateComponent,
} from "../src/domain/library";
import { copySelection, pasteSelection } from "../src/domain/clipboard";

const file = (id: string): DesignDocument => ({
  schemaVersion: 1,
  id,
  name: id,
  revision: 0,
  nodes: [],
  tokens: {},
});
const apply = (doc: DesignDocument, operations: Operation[]) =>
  transact(doc, { baseRevision: doc.revision, operations });

test("a cross-file slot follows the selected nested library, preserves outer overrides and can be copied again", () => {
  const origin = file("masters");
  function glyph(name: string, text: string) {
    const shape = createNode("frame", null),
      mark = createNode("text", shape.id);
    shape.name = name;
    mark.name = "Label";
    mark.text = text;
    return createLibraryFromSelection(
      { ...origin, nodes: [shape, mark] },
      shape.id,
      name,
    );
  }
  const first = glyph("Member", "Member"),
    other = glyph("Author", "Guest");
  const outer = createNode("frame", null),
    title = createNode("text", outer.id);
  outer.name = "Profile";
  title.name = "Title";
  title.text = "Profile";
  let source = { ...origin, nodes: [outer, title] };
  const original = instantiateComponent(
    source,
    first,
    "component",
    "default",
    outer.id,
    { x: 12, y: 16 },
  );
  source = apply(source, original.operations);
  const lib = createLibraryFromSelection(source, outer.id, "Profile");
  const component = lib.components[0],
    target = component.variants[0].nodes.find((n) => n.nestedSlot)!;
  assert.ok(target);
  component.exposed = [
    { id: "badge", kind: "swap", target: target.templateKey!, name: "Badge" },
  ];
  let consumer = apply(file("consumer"), [
    { type: "putLibrary", library: other },
  ]);
  const placed = instantiateComponent(
    consumer,
    lib,
    component.id,
    component.variants[0].id,
    null,
    { x: 10, y: 10 },
  );
  consumer = apply(consumer, placed.operations);
  const label = consumer.nodes.find((n) => n.name === "Title")!;
  const ref = {
    libraryId: other.id,
    componentId: "component",
    variantId: other.components[0].variants[0].id,
  };
  consumer = apply(consumer, [
    { type: "update", id: label.id, patch: { text: "Edited" } },
    { type: "setInstanceSlot", id: placed.id, property: "badge", value: ref },
  ]);
  const current = consumer.nodes.find((n) => n.text === "Guest")!;
  assert.ok(current);
  const updated = structuredClone(other);
  updated.revision++;
  updated.components[0].variants[0].nodes.find(
    (n) => n.name === "Label",
  )!.text = "Approved";
  consumer = apply(consumer, [
    {
      type: "updateLibrary",
      library: updated,
      expectedRevision: other.revision,
    },
  ]);
  assert.equal(
    consumer.nodes.find((n) => n.id === current.id)?.text,
    "Approved",
  );
  assert.equal(consumer.nodes.find((n) => n.id === label.id)?.text, "Edited");
  const payload = copySelection(consumer, [placed.id]);
  const dest = file("paste");
  const clone = apply(dest, pasteSelection(dest, payload, null).operations);
  assert.ok(clone.libraries?.[other.id]);
  assert.equal(clone.nodes.find((n) => n.name === "Label")?.text, "Approved");
  parseDocument(JSON.parse(JSON.stringify(clone)));
  const locked = apply(consumer, [
    { type: "update", id: current.id, patch: { locked: true } },
  ]);
  assert.throws(
    () =>
      apply(locked, [
        { type: "setInstanceSlot", id: placed.id, property: "badge" },
      ]),
    /锁定/,
  );
  const reset = apply(consumer, [
    { type: "setInstanceSlot", id: placed.id, property: "badge" },
  ]);
  assert.equal(reset.nodes.find((n) => n.name === "Label")?.text, "Member");
});

test("forwarded slots retain the leaf's identity and overrides across three levels and either order of edits", () => {
  const initial = file("composition-author");
  function label(value: string) {
    const frame = createNode("frame", null);
    frame.name = value;
    const leaf = createNode("text", frame.id);
    leaf.name = "Name";
    leaf.text = value;
    return createLibraryFromSelection(
      { ...initial, nodes: [frame, leaf] },
      frame.id,
      value,
    );
  }
  function parent(name: string, nested: ReturnType<typeof label>) {
    const root = createNode("frame", null);
    root.name = name;
    const origin = { ...initial, nodes: [root] };
    const inserted = instantiateComponent(
      origin,
      nested,
      "component",
      "default",
      root.id,
      { x: 0, y: 0 },
    );
    const current = apply(origin, inserted.operations);
    return createLibraryFromSelection(current, root.id, name);
  }
  const regular = label("Badge"),
    featured = label("Featured");
  const toolbar = parent("Toolbar", regular),
    page = parent("Panel", toolbar);
  const shell = page.components[0],
    nodes = shell.variants[0].nodes;
  const bar = nodes.find((n) => n.name === "Toolbar")!,
    badge = nodes.find((n) => n.name === "Badge")!;
  shell.exposed = [
    { name: "Toolbar", id: "bar", kind: "swap", target: bar.templateKey! },
    { name: "Badge", id: "badge", kind: "swap", target: badge.templateKey! },
  ];
  const ref = (lib: typeof toolbar) => ({
    libraryId: lib.id,
    componentId: "component",
    variantId: "default",
  });
  let consumer = apply(
    file("consumer-deep"),
    [toolbar, featured].map((library) => ({ type: "putLibrary", library })),
  );
  const inserted = instantiateComponent(
    consumer,
    page,
    "component",
    "default",
    null,
    { x: 32, y: 32 },
  );
  consumer = apply(consumer, inserted.operations);
  const leaf = consumer.nodes.find((n) => n.name === "Name")!;
  consumer = apply(consumer, [
    { type: "update", id: leaf.id, patch: { text: "Pinned title" } },
  ]);
  const set = (property: string, lib: typeof toolbar): Operation => ({
    type: "setInstanceSlot",
    id: inserted.id,
    property,
    value: ref(lib),
  });
  for (const order of [
    [set("badge", featured), set("bar", toolbar)],
    [set("bar", toolbar), set("badge", featured)],
  ]) {
    const result = apply(consumer, order);
    assert.equal(
      result.nodes.find((n) => n.id === leaf.id)?.text,
      "Pinned title",
    );
    assert.equal(
      result.nodes.find((n) => n.templateKey === badge.templateKey)
        ?.nestedSource?.libraryId,
      featured.id,
    );
    assert.deepEqual(
      result.nodes.find((n) => n.id === inserted.id)?.instance?.slots?.[
        bar.templateKey!
      ],
      ref(toolbar),
    );
    parseDocument(JSON.parse(JSON.stringify(result)));
    const updated = apply(result, [
      { type: "setInstanceSlot", id: inserted.id, property: "bar" },
    ]);
    assert.equal(
      updated.nodes.find((n) => n.id === leaf.id)?.text,
      "Pinned title",
    );
    assert.equal(
      updated.nodes.find((n) => n.templateKey === badge.templateKey)
        ?.nestedSource?.libraryId,
      featured.id,
    );
    const detached = apply(updated, [
      { type: "detachInstance", id: inserted.id },
    ]);
    assert.ok(
      detached.nodes.every(
        (n) =>
          !n.nestedSource && !n.nestedSlot && !n.nestedKey && !n.nestedPath,
      ),
    );
  }
});

test("a dormant slot value survives portable storage and reappears when a variant exposes its layer", () => {
  const origin = file("slot-master");
  const slotRoot = createNode("frame"),
    label = createNode("text", slotRoot.id);
  label.text = "Original content";
  const first = createLibraryFromSelection(
    { ...origin, nodes: [slotRoot, label] },
    slotRoot.id,
    "Content",
  );
  const alt = structuredClone(first);
  alt.id = "custom-content";
  alt.components[0].variants[0].nodes.find((n) => n.type === "text")!.text =
    "Customized content";
  const root = createNode("frame");
  const source = { ...origin, nodes: [root] };
  const inner = instantiateComponent(
    source,
    first,
    "component",
    "default",
    root.id,
    { x: 0, y: 0 },
  );
  const outer = createLibraryFromSelection(
    apply(source, inner.operations),
    root.id,
    "Outer",
  );
  const c = outer.components[0],
    active = c.variants[0],
    slot = active.nodes.find((n) => n.nestedSlot)!;
  c.exposed = [
    { id: "buttons", name: "Buttons", kind: "swap", target: slot.templateKey! },
  ];
  c.variants.push({
    ...active,
    id: "symbol-only",
    nodes: active.nodes
      .filter((n) => !n.parentId)
      .map((n) => ({ ...n, id: "symbol-root" })),
  });
  const blank = apply(file("slot-file"), [
    { type: "putLibrary", library: alt },
  ]);
  const inserted = instantiateComponent(
    blank,
    outer,
    c.id,
    "symbol-only",
    null,
    { x: 0, y: 0 },
  );
  let saved = apply(blank, inserted.operations);
  const instance = saved.nodes.find((n) => n.id === inserted.id)!;
  const choice = {
    libraryId: alt.id,
    componentId: alt.components[0].id,
    variantId: "default",
  };
  instance.instance!.slotProperties = { buttons: choice };
  saved = parseDocument(JSON.parse(JSON.stringify(saved)));
  const show = apply(saved, [
    { type: "switchInstance", id: inserted.id, variantId: active.id },
  ]);
  assert.ok(show.nodes.some((n) => n.text === "Customized content"));
  const hidden = apply(show, [
    { type: "switchInstance", id: inserted.id, variantId: "symbol-only" },
  ]);
  assert.equal(hidden.nodes.length, 1);
  assert.deepEqual(hidden.nodes[0].instance?.slotProperties, {
    buttons: choice,
  });
  const reset = apply(hidden, [
    {
      type: "switchInstance",
      id: inserted.id,
      variantId: active.id,
      reset: true,
    },
  ]);
  assert.equal(reset.nodes[0].instance?.slotProperties, undefined);
  assert.ok(reset.nodes.some((n) => n.text === "Original content"));
});
