import test from "node:test";
import assert from "node:assert/strict";
import {
  createNode,
  parseDocument,
  type DesignDocument,
} from "../src/domain/document";
import { transact, type Operation } from "../src/domain/commands";
import {
  createLibraryFromSelection,
  instantiateComponent,
} from "../src/domain/library";
import { localMasters } from "../src/domain/component-masters";

test("authors can add, rename and unlink live variants without invalidating the original or its consumer's overrides", () => {
  const root = createNode("frame", null),
    label = createNode("text", root.id);
  root.name = "Status";
  label.name = "Label";
  label.text = "Default";
  let doc: DesignDocument = {
    schemaVersion: 1,
    id: "variants",
    name: "Variants",
    revision: 0,
    nodes: [root, label],
    tokens: {},
  };
  const library = createLibraryFromSelection(doc, root.id, "Status");
  const apply = (...operations: Operation[]) => {
    doc = transact(doc, { baseRevision: doc.revision, operations });
  };
  apply({ type: "putLibrary", library });
  const use = instantiateComponent(doc, library, "component", "default", null, {
    x: 200,
    y: 30,
  });
  apply(...use.operations);
  const instanceLabel = doc.nodes.find((n) => n.parentId === use.id)!.id;
  apply({ type: "update", id: instanceLabel, patch: { text: "Localized" } });
  const add = (
    from: string,
    id: string,
    axis: string,
    value: string,
    defaultValue?: string,
  ): Operation => ({
    type: "addComponentVariant",
    id: from,
    newId: id,
    variantId: "v-" + id,
    axis,
    value,
    defaultValue,
  });
  apply(add(root.id, "disabled", "State", "Disabled", "Default"));
  const family = () => doc.libraries![library.id].components[0];
  assert.deepEqual(
    family().variants.map((v) => v.properties.State),
    ["Default", "Disabled"],
  );
  const disabled = doc.nodes.find((n) => n.parentId === "disabled")!;
  apply({ type: "update", id: disabled.id, patch: { text: "Unavailable" } });
  assert.equal(
    family().variants[1].nodes.find((n) => n.type === "text")?.text,
    "Unavailable",
  );
  assert.equal(
    family().variants[0].nodes.find((n) => n.type === "text")?.text,
    "Default",
  );
  apply({ type: "switchInstance", id: use.id, variantId: "v-disabled" });
  assert.equal(
    doc.nodes.find((n) => n.id === instanceLabel)?.text,
    "Localized",
  );
  apply(add("disabled", "large", "Size", "Large", "Medium"));
  apply({
    type: "editVariantProperty",
    id: "large",
    axis: "Size",
    newAxis: "尺寸",
    value: "大",
  });
  assert.deepEqual(
    family().variants.map((v) => v.properties["尺寸"]),
    ["Medium", "Medium", "大"],
  );
  assert.ok(family().variants.every((v) => !("Size" in v.properties)));
  const original = JSON.stringify(doc);
  assert.throws(
    () =>
      apply({
        type: "editVariantProperty",
        id: "large",
        axis: "尺寸",
        newAxis: "尺寸",
        value: "Medium",
      }),
    /相同属性/,
  );
  assert.throws(
    () => apply({ type: "unlinkComponentVariant", id: "disabled" }),
    /仍有实例/,
  );
  assert.equal(JSON.stringify(doc), original);
  apply({ type: "unlinkComponentVariant", id: "large" });
  assert.ok(doc.nodes.some((n) => n.id === "large"));
  assert.ok(!localMasters(doc).some((m) => m.nodeId === "large"));
  assert.equal(family().variants.length, 2);
  parseDocument(JSON.parse(JSON.stringify(doc)));
});
test("combining drawings preserves the existing master, its snapshots and its original instances", () => {
  const first = createNode("frame", null),
    second = createNode("frame", null);
  first.name = "Original";
  second.name = "Different";
  second.style.width = 111;
  let doc: DesignDocument = {
    schemaVersion: 1,
    id: "combine",
    name: "Sets",
    revision: 0,
    nodes: [first, second],
    tokens: {},
  };
  const old = createLibraryFromSelection(doc, first.id, first.name);
  const use = instantiateComponent(doc, old, "component", "default", null, {
    x: 30,
    y: 30,
  });
  const apply = (...operations: Operation[]) => {
    doc = transact(doc, { baseRevision: doc.revision, operations });
  };
  apply(...use.operations);
  const members = [
    { id: first.id, value: "Day", variantId: "day" },
    { id: second.id, value: "Night", variantId: "night" },
  ];
  apply({
    type: "createVariantSet",
    libraryId: "shifts",
    name: "Shift",
    axis: "Theme",
    members,
  });
  const set = doc.libraries!.shifts.components[0];
  assert.notEqual(set.master?.nodeId, first.id);
  assert.equal(set.variants[1].masterNodeId, second.id);
  assert.equal(doc.nodes.find((n) => n.id === first.id)?.name, "Original");
  assert.equal(
    doc.nodes.find((n) => n.id === use.id)?.instance?.libraryId,
    old.id,
  );
  const selected = instantiateComponent(
    doc,
    doc.libraries!.shifts,
    "component",
    "night",
    null,
    { x: 0, y: 0 },
  );
  apply(...selected.operations);
  apply({ type: "update", id: second.id, style: { width: 132 }, patch: {} });
  assert.equal(doc.nodes.find((n) => n.id === selected.id)?.style.width, 132);
  const before = JSON.stringify(doc);
  assert.throws(
    () =>
      apply({
        type: "createVariantSet",
        libraryId: "invalid",
        name: "Other",
        axis: "Theme",
        members: [members[0], { ...members[1], value: "Day" }],
      }),
    /相同属性/,
  );
  assert.equal(JSON.stringify(doc), before);
});

test("renaming a published property keeps earlier code names unique, including when the author restores an old name", () => {
  const root = createNode("text", null);
  let doc: DesignDocument = {
    schemaVersion: 1,
    id: "property-history",
    name: "Badge",
    revision: 0,
    nodes: [root],
    tokens: {},
  };
  const library = createLibraryFromSelection(doc, root.id, "Badge");
  doc = transact(doc, {
    baseRevision: 0,
    operations: [{ type: "putLibrary", library }],
  });
  const component = library.components[0];
  const field = {
    id: "label",
    kind: "text" as const,
    target: component.variants[0].nodes[0].templateKey!,
  };
  const set = (name: string, conflictingName?: string) => {
    const properties = [{ ...field, name }];
    if (conflictingName)
      properties.push({ ...field, id: "another", name: conflictingName });
    doc = transact(doc, {
      baseRevision: doc.revision,
      operations: [
        {
          type: "setComponentProperties",
          id: root.id,
          libraryId: library.id,
          componentId: component.id,
          properties,
        },
      ],
    });
  };
  for (const name of ["Label", "Title", "Caption", "Label"]) set(name);
  const fields = () => doc.libraries![library.id].components[0].exposed!;
  assert.deepEqual(fields()[0].previousNames, ["Caption", "Title"]);
  const revision = doc.revision;
  assert.throws(() => set("Label", "Title"), /重复/);
  assert.equal(doc.revision, revision);
  assert.equal(fields().length, 1);
});
