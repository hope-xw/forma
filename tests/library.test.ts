import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createStarter } from "../src/domain/seed";
import {
  parseDocument,
  createNode,
  type DesignDocument,
} from "../src/domain/document";
import { transact, type Operation } from "../src/domain/commands";
import { parseLibrary } from "../src/domain/library-schema";
import {
  instantiateComponent,
  switchInstance,
  detachInstance,
  createLibraryFromSelection,
  installLibrary,
} from "../src/domain/library";
import {
  mobileLibrary,
  mobileComponentLibrary,
} from "../src/design-system/mobile";
import {
  mobileTemplates,
  createMobileTemplate,
} from "../src/design-system/mobile-templates";
import {
  copySelection,
  pasteSelection,
  readClipboard,
} from "../src/domain/clipboard";
import { nodeCss, exportReact } from "../src/compiler/react";
import {
  reactProjectFiles,
  runtimeNodes,
  pageForExport,
} from "../src/compiler/runtime";
import { validateProposal } from "../src/agent/provider";
const blank = (): DesignDocument => ({ ...createStarter(), nodes: [] });
const apply = (doc: DesignDocument, operations: Operation[]) =>
  transact(doc, { baseRevision: doc.revision, operations });
function insert(
  doc = blank(),
  component = "button",
  variant = "Light-Primary-Medium-Default",
) {
  const result = instantiateComponent(
    doc,
    mobileComponentLibrary(component),
    component,
    variant,
    null,
    { x: 120, y: 80 },
  );
  return { doc: apply(doc, result.operations), id: result.id };
}

test("all original mobile variants have one root and stable unique template keys", () => {
  parseLibrary(mobileLibrary);
  for (const component of mobileLibrary.components)
    for (const variant of component.variants)
      assert.equal(
        variant.nodes.length,
        new Set(variant.nodes.map((n) => n.templateKey)).size,
      );
});
test("inserted instance is editable, persists with its source, and uses fresh IDs", () => {
  const { doc, id } = insert();
  assert.equal(doc.nodes[0].style.x, 120);
  assert.ok(doc.nodes[0].instance);
  assert.deepEqual(parseDocument(JSON.parse(JSON.stringify(doc))), doc);
  const second = insert(doc);
  assert.notEqual(second.id, id);
  assert.equal(Object.keys(second.doc.libraries!).length, 1);
});
test("adding another component merges immutable library snapshots without duplicating versions", () => {
  const first = insert();
  const second = insert(first.doc, "toggle", "Dark-On-Default");
  assert.equal(Object.keys(second.doc.libraries!).length, 1);
  assert.equal(second.doc.libraries![mobileLibrary.id].components.length, 2);
});
test("variant switch preserves root ID, position and manual text but updates untouched styles", () => {
  const { doc, id } = insert();
  const edited = apply(doc, [{ type: "update", id, patch: { text: "购买" } }]);
  const next = apply(
    edited,
    switchInstance(edited, id, "Dark-Secondary-Large-Default"),
  );
  assert.equal(next.nodes[0].id, id);
  assert.equal(next.nodes[0].text, "购买");
  assert.equal(next.nodes[0].style.x, 120);
  assert.equal(next.nodes[0].style.height, 54);
  assert.equal(next.nodes[0].style.fill, "#303a4c");
});
test("variant switch retains nested text edits by template key, not array index", () => {
  const { doc, id } = insert(blank(), "navigation", "Light-Large-Solid");
  const title = doc.nodes.find((n) => n.templateKey === "title")!;
  const edited = apply(doc, [
    { type: "update", id: title.id, patch: { text: "个人空间" } },
  ]);
  const next = apply(edited, switchInstance(edited, id, "Dark-Inline-Glass"));
  assert.equal(
    next.nodes.find((n) => n.templateKey === "title")!.text,
    "个人空间",
  );
  assert.equal(next.nodes.find((n) => n.templateKey === "title")!.id, title.id);
});
test("reset clears appearance and text overrides but preserves canvas placement", () => {
  const { doc, id } = insert();
  const edited = apply(doc, [
    {
      type: "update",
      id,
      patch: { text: "edited" },
      style: { width: 300, fontWeight: 900 },
    },
  ]);
  const next = apply(
    edited,
    switchInstance(edited, id, "Light-Primary-Medium-Default", true),
  );
  assert.equal(next.nodes[0].text, "继续");
  assert.equal(next.nodes[0].style.width, 152);
  assert.equal(next.nodes[0].style.x, 120);
});
test("switching variants rejects structural edits rather than silently discarding them", () => {
  const { doc, id } = insert(blank(), "navigation", "Light-Large-Solid");
  const child = createNode("text", id);
  assert.throws(() => apply(doc, [{ type: "create", node: child }]), /受保护/);
  const edited = structuredClone(doc);
  edited.nodes.push(child);
  assert.throws(
    () => switchInstance(edited, id, "Dark-Inline-Glass"),
    /结构已编辑/,
  );
  const reset = apply(
    edited,
    switchInstance(edited, id, "Dark-Inline-Glass", true),
  );
  assert.ok(!reset.nodes.some((n) => n.id === child.id));
});
test("a removed edited child blocks a variant switch", () => {
  const { doc, id } = insert(blank(), "checkbox", "Light-On-Default");
  const child = doc.nodes.find((n) => n.templateKey === "check")!;
  const edited = apply(doc, [
    { type: "update", id: child.id, patch: { name: "custom" } },
  ]);
  assert.throws(
    () => switchInstance(edited, id, "Light-Off-Default"),
    /已编辑/,
  );
});
test("locked instance cannot be switched or detached", () => {
  const { doc, id } = insert();
  const locked = apply(doc, [{ type: "update", id, patch: { locked: true } }]);
  assert.throws(
    () => switchInstance(locked, id, "Dark-Primary-Medium-Default"),
    /锁定/,
  );
  assert.throws(() => apply(locked, detachInstance(locked, id)), /锁定/);
});
test("detaching retains geometry, text and runtime control semantics", () => {
  const { doc, id } = insert();
  const next = apply(doc, detachInstance(doc, id));
  assert.equal(next.nodes[0].instance, undefined);
  assert.equal(next.nodes[0].control?.kind, "button");
  assert.deepEqual(next.nodes[0].style, doc.nodes[0].style);
});
test("clipboard transports component definitions into another document", () => {
  const { doc, id } = insert(blank(), "toggle", "Light-On-Default");
  const clip = readClipboard(JSON.stringify(copySelection(doc, [id])))!;
  const target = blank(),
    paste = pasteSelection(target, clip, null, { x: 0, y: 0 }),
    next = apply(target, paste.operations);
  assert.ok(next.libraries?.[mobileLibrary.id]);
  assert.equal(next.nodes[0].instance?.variantId, "Light-On-Default");
  assert.equal(next.nodes[1].templateKey, "thumb");
  parseDocument(next);
});
test("conflicting library clipboard IDs are remapped without altering existing definitions", () => {
  const first = insert();
  const library = structuredClone(mobileComponentLibrary("button"));
  library.components[0].variants[0].nodes[0].text = "Different";
  const target = apply(blank(), [{ type: "putLibrary", library }]);
  const paste = pasteSelection(
    target,
    copySelection(first.doc, [first.id]),
    null,
  );
  const next = apply(target, paste.operations);
  assert.equal(Object.keys(next.libraries!).length, 2);
  assert.notEqual(next.nodes[0].instance?.libraryId, mobileLibrary.id);
});
test("used definitions cannot be overwritten in-place", () => {
  const { doc } = insert();
  const library = structuredClone(doc.libraries![mobileLibrary.id]);
  library.components[0].variants[0].nodes[0].text = "changed";
  assert.throws(
    () => apply(doc, [{ type: "putLibrary", library }]),
    /已有实例/,
  );
  assert.notEqual(installLibrary(doc, library).id, library.id);
});
test("malformed library hierarchy and external token references are rejected", () => {
  const base = mobileComponentLibrary("button");
  for (const change of ["cycle", "token", "duplicate"]) {
    const lib = structuredClone(base),
      n = lib.components[0].variants[0].nodes[0];
    if (change === "cycle") n.parentId = n.id;
    if (change === "token") n.fillToken = "unknown";
    if (change === "duplicate") lib.components.push(lib.components[0]);
    assert.throws(() => parseLibrary(lib));
  }
});
test("user selection can be captured as a portable component with resolved token colors", () => {
  const doc = createStarter();
  const lib = createLibraryFromSelection(doc, doc.nodes[0].id, "Custom");
  parseLibrary(lib);
  assert.equal(lib.components[0].variants[0].nodes[0].style.x, 0);
  assert.ok(lib.components[0].variants[0].nodes.every((n) => !n.fillToken));
});
test("all page templates compose valid instances and stay within browser storage limits", () => {
  for (const template of mobileTemplates)
    for (const mode of ["Light", "Dark"] as const) {
      const doc = blank(),
        result = createMobileTemplate(doc, template.id, mode, { x: 0, y: 0 });
      const next = apply(doc, result.operations);
      assert.ok(next.nodes.length > 25);
      assert.ok(JSON.stringify(next).length < 1_000_000);
      parseDocument(next);
    }
});
test("material and typography styles are shared by canvas and exported React", () => {
  const { doc } = insert(blank(), "navigation", "Dark-Large-Glass"),
    css = nodeCss(doc.nodes[0], doc);
  assert.equal(css.backdropFilter, "blur(24px)");
  assert.match(String(css.background), /^rgba/);
  assert.ok(css.boxShadow);
  assert.ok(exportReact(doc).includes("strokeLinecap"));
});
test("generated interactive project compiles syntactically and carries independent runtime source", () => {
  const { doc } = insert(blank(), "toggle", "Light-On-Default");
  const files = reactProjectFiles(
    doc,
    readFileSync(
      new URL("../src/runtime/FormaRuntime.tsx", import.meta.url),
      "utf8",
    ),
  );
  for (const [name, source] of Object.entries(files).filter(([name]) =>
    name.endsWith("tsx"),
  )) {
    const result = ts.transpileModule(source, {
      fileName: name,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
      },
      reportDiagnostics: true,
    });
    assert.equal(result.diagnostics?.length, 0, name);
  }
  assert.ok(files["src/FormaRuntime.tsx"].includes("role={c.kind}"));
  assert.equal(runtimeNodes(doc)[0].control?.kind, "switch");
  const page = pageForExport(doc);
  assert.equal(page.nodes[0].style.x, 0);
  assert.equal(page.nodes[0].style.y, 0);
  assert.equal(doc.nodes[0].style.x, 120);
  assert.throws(() => pageForExport(createStarter()), /请选择/);
});
test("scoped agent cannot inject a global library", () => {
  const doc = createStarter();
  assert.throws(
    () =>
      validateProposal(
        { document: doc, selection: doc.nodes[0].id, prompt: "update" },
        {
          baseRevision: doc.revision,
          operations: [
            { type: "putLibrary", library: mobileComponentLibrary("button") },
          ],
        },
      ),
    /组件库/,
  );
});

test("component insertion command expands atomically and increments one revision", () => {
  const doc = apply(blank(), [
    { type: "putLibrary", library: mobileComponentLibrary("toggle") },
  ]);
  const next = apply(doc, [
    {
      type: "insertComponent",
      libraryId: mobileLibrary.id,
      componentId: "toggle",
      variantId: "Light-On-Default",
      parentId: null,
      position: { x: 42, y: 64 },
    },
  ]);
  assert.equal(next.revision, doc.revision + 1);
  assert.equal(next.nodes.length, 2);
  assert.equal(next.nodes[0].style.x, 42);
  assert.throws(() =>
    apply(doc, [
      {
        type: "insertComponent",
        libraryId: mobileLibrary.id,
        componentId: "toggle",
        variantId: "missing",
        parentId: null,
        position: { x: 0, y: 0 },
      },
    ]),
  );
  assert.equal(doc.nodes.length, 0);
});
test("scoped agent can instantiate registered components only inside the selected subtree", () => {
  const base = createStarter();
  const doc = apply(base, [
    { type: "putLibrary", library: mobileComponentLibrary("toggle") },
  ]);
  const op: Operation = {
    type: "insertComponent",
    libraryId: mobileLibrary.id,
    componentId: "toggle",
    variantId: "Light-On-Default",
    parentId: doc.nodes[0].id,
    position: { x: 100, y: 100 },
  };
  assert.doesNotThrow(() =>
    validateProposal(
      { document: doc, selection: doc.nodes[0].id, prompt: "Add toggle" },
      { baseRevision: doc.revision, operations: [op] },
    ),
  );
  assert.throws(
    () =>
      validateProposal(
        { document: doc, selection: doc.nodes[0].id, prompt: "Add toggle" },
        { baseRevision: doc.revision, operations: [{ ...op, parentId: null }] },
      ),
    /选区/,
  );
});
test("an accessibility label override does not freeze the control value across variants", () => {
  const { doc, id } = insert(blank(), "toggle", "Light-On-Default");
  const root = doc.nodes[0];
  const edited = apply(doc, [
    {
      type: "update",
      id,
      patch: { control: { ...root.control!, label: "通知提醒" } },
    },
  ]);
  const next = apply(edited, switchInstance(edited, id, "Dark-Off-Default"));
  assert.equal(next.nodes[0].control?.label, "通知提醒");
  assert.equal(next.nodes[0].control?.value, false);
});
test("manual layer reordering is protected when changing a component variant", () => {
  const { doc, id } = insert(blank(), "navigation", "Light-Large-Solid");
  const child = doc.nodes.find((n) => n.parentId === id)!;
  assert.throws(
    () => apply(doc, [{ type: "reorder", id: child.id, index: 3 }]),
    /受保护/,
  );
  const edited = structuredClone(doc);
  edited.nodes = [...edited.nodes.filter((n) => n.id !== child.id), child];
  assert.throws(() => switchInstance(edited, id, "Dark-Inline-Glass"), /顺序/);
});

test("published selections and cross-file clipboard carry only referenced embedded fonts", () => {
  const d = createStarter();
  const n = createNode("text", null);
  const layer = "font-" + "a".repeat(64),
    run = "font-" + "b".repeat(64),
    other = "font-" + "c".repeat(64);
  const font = { name: "Fixture", axes: [], data: "data:font/ttf;base64,AA==" };
  n.text = "Title";
  n.style.fontFamily = layer;
  n.textRuns = [{ start: 0, end: 1, style: { fontFamily: run } }];
  d.nodes = [n];
  d.fonts = { [layer]: font, [run]: font, [other]: font };
  const lib = createLibraryFromSelection(d, n.id, "Presentation");
  const payload = copySelection(d, [n.id]);
  assert.deepEqual(Object.keys(lib.fonts ?? {}).sort(), [layer, run]);
  assert.deepEqual(Object.keys(payload.document.fonts ?? {}).sort(), [
    layer,
    run,
  ]);
  const target = createStarter();
  target.nodes = [];
  const pasted = transact(target, {
    baseRevision: target.revision,
    operations: pasteSelection(target, payload, null).operations,
  });
  assert.deepEqual(Object.keys(pasted.fonts ?? {}).sort(), [layer, run]);
  assert.equal(pasted.nodes[0].textRuns?.[0].style.fontFamily, run);
});
