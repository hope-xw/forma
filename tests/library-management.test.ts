import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { commit, travel, type History } from "../src/application/history";
import { nativeDesignSystem } from "../src/design-system/tokens";
import { transact, type Operation } from "../src/domain/commands";
import { resolveNode, resolveVariable } from "../src/domain/design-system";
import {
  createNode,
  parseDocument,
  type DesignDocument,
} from "../src/domain/document";
import {
  createLibraryFromSelection,
  instantiateComponent,
} from "../src/domain/library";
import {
  allLibraryInstanceCounts,
  countLibraryInstances,
  extractLibrariesFromDocument,
  packageDocumentAsLibrary,
} from "../src/domain/library-packaging";
import {
  parseLibrary,
  type ComponentLibrary,
} from "../src/domain/library-schema";
import { addPage } from "../src/domain/pages";
import { promoteSelectionToLibrary } from "../src/domain/library-promotion";
import {
  deleteWorkspaceLibrary,
  getEnabledBuiltinLibraries,
  hasSavedBuiltinPreference,
  listWorkspaceLibraries,
  getWorkspaceLibraryRecord,
  saveWorkspaceLibrary,
  saveWorkspaceLibraryDurable,
  WorkspaceLibraryConflictError,
  updateWorkspaceLibraryAiGuide,
  type WorkspaceLibraryRecord,
  setEnabledBuiltinLibraries,
} from "../src/infrastructure/library-catalog-store";

const blank = (id = "canvas"): DesignDocument => ({
  schemaVersion: 1,
  id,
  name: id,
  revision: 0,
  nodes: [],
  tokens: {},
});
const apply = (doc: DesignDocument, ...operations: Operation[]) =>
  transact(doc, { baseRevision: doc.revision, operations });
const remove = (libraryId: string): Operation => ({
  type: "removeLibrary",
  libraryId,
});

function snapshot(id: string, doc = blank("author")) {
  const root = createNode("frame");
  root.name = id;
  doc.nodes.push(root);
  const library = createLibraryFromSelection(doc, root.id, id);
  library.id = id;
  return library;
}
function place(doc: DesignDocument, lib: ComponentLibrary) {
  const c = lib.components[0];
  const { operations, id } = instantiateComponent(
    doc,
    lib,
    c.id,
    c.variants[0].id,
    null,
    { x: 10, y: 20 },
  );
  return { doc: apply(doc, ...operations), id };
}

test("removing an unused library is atomic, repeatable and undoable as one edit", () => {
  const lib = snapshot("controls"),
    keep = snapshot("keep");
  const doc = apply(
    blank(),
    { type: "putLibrary", library: lib },
    { type: "putLibrary", library: keep },
  );
  const removed = apply(doc, remove(lib.id));
  assert.deepEqual(Object.keys(removed.libraries!), [keep.id]);
  assert.equal(removed.revision, doc.revision + 1);
  const empty = apply(removed, remove(keep.id), remove("missing"));
  assert.equal("libraries" in empty, false);
  const again = apply(empty, remove(keep.id));
  assert.equal(again.libraries, undefined);
  assert.deepEqual(doc.libraries![lib.id], lib);

  const history: History = { present: doc, past: [], future: [] };
  const back = travel(commit(history, removed), "undo");
  assert.deepEqual(back.present.libraries, doc.libraries);
  const forward = travel(back, "redo");
  assert.deepEqual(forward.present.libraries, removed.libraries);
  assert.equal(forward.present.revision, back.present.revision + 1);
});

test("AI annotations on an instantiated component and its library undo together", () => {
  const { doc, id } = place(blank(), snapshot("catalog"));
  const edited = structuredClone(doc.libraries!.catalog);
  edited.aiGuide = { playbookMarkdown: "业务说明" };
  edited.components[0].assetTier = "block";
  edited.components[0].aiHints = { whenToUse: "商品双列展示" };
  const next = apply(doc, { type: "putLibrary", library: edited });
  assert.deepEqual(next.libraries!.catalog, edited);
  assert.deepEqual(
    next.nodes.find((n) => n.id === id),
    doc.nodes.find((n) => n.id === id),
  );
  const back = travel(
    commit({ present: doc, past: [], future: [] }, next),
    "undo",
  );
  assert.deepEqual(back.present.libraries, doc.libraries);
  assert.deepEqual(back.present.nodes, doc.nodes);
});

test("AI annotations cannot mask structural edits to a component used on another page", () => {
  const doc = addPage(place(blank(), snapshot("catalog")).doc, "第二页");
  const lib = doc.libraries!.catalog;
  for (const field of ["variants", "exposed"] as const) {
    const edited = structuredClone(lib);
    const component = edited.components[0];
    component.assetTier = "block";
    if (field === "variants") component.variants[0].name += " changed";
    else
      component.exposed = [
        {
          id: "visible",
          name: "可见",
          kind: "visible",
          target: component.variants[0].nodes[0].templateKey!,
        },
      ];
    assert.throws(
      () => apply(doc, { type: "putLibrary", library: edited }),
      /已有实例/,
    );
  }
});

test("uninstall counts actual instances on the current and inactive pages and rolls back earlier operations", () => {
  const lib = snapshot("page-library");
  const first = place(blank(), lib);
  assert.throws(() => apply(first.doc, remove(lib.id)), /仍有 1 个画布实例/);
  const secondPage = addPage(first.doc, "第二页");
  assert.equal(secondPage.nodes.length, 0);
  assert.throws(() => apply(secondPage, remove(lib.id)), /仍有 1 个画布实例/);
  const second = place(secondPage, lib);
  assert.equal(countLibraryInstances(second.doc, lib.id), 2);
  assert.deepEqual(allLibraryInstanceCounts(second.doc), { [lib.id]: 2 });
  assert.throws(() => apply(second.doc, remove(lib.id)), /仍有 2 个画布实例/);
  assert.throws(
    () =>
      apply(
        second.doc,
        { type: "detachInstance", id: second.id },
        remove(lib.id),
      ),
    /仍有 1 个画布实例/,
  );
  assert.ok(second.doc.nodes.find((n) => n.id === second.id)?.instance);
  const detached = apply(
    first.doc,
    { type: "detachInstance", id: first.id },
    remove(lib.id),
  );
  assert.equal(detached.libraries, undefined);
  assert.equal(detached.nodes[0].id, first.id);
});

test("live slots and saved swap properties count each owning instance once per library across pages", () => {
  const author = blank("author");
  const alternative = snapshot("badge"),
    idle = snapshot("unused"),
    other = snapshot("hidden-slot");
  const panel = createNode("frame"),
    slot = createNode("frame", panel.id);
  slot.nestedSlot = true;
  slot.nestedKey = "root";
  author.nodes = [panel, slot];
  const outer = createLibraryFromSelection(author, panel.id, "panel");
  const target = outer.components[0].variants[0].nodes[1].templateKey!;
  outer.components[0].exposed = [
    { id: "swap", kind: "swap", name: "图标", target },
  ];
  let doc = apply(
    blank(),
    ...[alternative, idle, other].map((library) => ({
      type: "putLibrary" as const,
      library,
    })),
  );
  const inserted = place(doc, outer);
  const ref = {
    libraryId: alternative.id,
    componentId: "component",
    variantId: "default",
  };
  doc = apply(inserted.doc, {
    type: "setInstanceSlot",
    id: inserted.id,
    property: "swap",
    value: ref,
  });
  const instance = doc.nodes.find((n) => n.id === inserted.id)!.instance!;
  assert.deepEqual(instance.slots?.[target], ref);
  instance.slotProperties = {
    swap: ref,
    hidden: { ...ref, libraryId: other.id },
  };
  doc = parseDocument(doc);
  assert.throws(() => apply(doc, remove(alternative.id)), /仍有 1 个画布实例/);
  assert.throws(() => apply(doc, remove(other.id)), /仍有 1 个画布实例/);
  doc = place(addPage(doc, "第二页"), alternative).doc;
  assert.deepEqual(allLibraryInstanceCounts(doc), {
    [outer.id]: 1,
    [alternative.id]: 2,
    [other.id]: 1,
    [idle.id]: 0,
  });
  assert.equal(countLibraryInstances(doc, alternative.id), 2);
  assert.equal(countLibraryInstances(doc, "missing"), 0);
  assert.throws(() => apply(doc, remove(alternative.id)), /仍有 2 个画布实例/);
});

test("packing local masters preserves both asset sources, subsets theme dependencies and removes every canvas pointer", () => {
  const doc = blank();
  doc.designSystem = nativeDesignSystem();
  const ids = ["a", "b", "c"].map((letter) => "img-" + letter.repeat(64));
  const fonts = ["a", "b", "c"].map((letter) => "font-" + letter.repeat(64));
  const image = {
    name: "cover",
    width: 1,
    height: 1,
    data: "data:image/png;base64,AAAA",
  };
  const font = {
    name: "embedded",
    axes: [],
    data: "data:font/ttf;base64,AAAA",
  };
  doc.images = { [ids[0]]: image, [ids[2]]: image };
  doc.fonts = { [fonts[0]]: font, [fonts[2]]: font };
  const first = snapshot("first", doc),
    second = snapshot("second", doc);
  const long = "a".repeat(128);
  for (const [i, lib] of [first, second].entries()) {
    const c = lib.components[0];
    c.id = long;
    const v = c.variants[0],
      node = v.nodes[0];
    node.styleBindings = { paint: "paint-accent" };
    node.variableBindings = { radius: "radius-md" };
    node.style.fontFamily = fonts[i];
    node.image = { assetId: ids[i], fit: "cover", x: 50, y: 50, zoom: 1 };
    c.variants.push({
      ...structuredClone(v),
      id: "other",
      masterNodeId: "variant-" + i,
    });
  }
  second.images = { [ids[1]]: image };
  second.fonts = { [fonts[1]]: font };
  const imported = snapshot("foreign").components[0];
  imported.id = "foreign";
  first.components.push(imported);
  doc.libraries = { first, second };
  const original = structuredClone(doc);
  const packed = packageDocumentAsLibrary(doc, {
    id: "share",
    name: "  组件集  ",
    revision: 8,
  });
  assert.equal(packed.name, "组件集");
  assert.equal(packed.revision, 8);
  assert.deepEqual(
    packed.components.map((c) => c.id),
    [long, long.slice(0, 126) + "-2"],
  );
  for (const c of packed.components) {
    assert.equal("master" in c, false);
    assert.equal(c.variants.length, 2);
    assert.ok(c.variants.every((v) => !("masterNodeId" in v)));
  }
  assert.deepEqual(Object.keys(packed.images!).sort(), ids.slice(0, 2));
  assert.deepEqual(Object.keys(packed.fonts!).sort(), fonts.slice(0, 2));
  assert.deepEqual(Object.keys(packed.designSystem!.styles), ["paint-accent"]);
  assert.deepEqual(Object.keys(packed.designSystem!.variables).sort(), [
    "color-accent",
    "palette-dark-accent",
    "palette-light-accent",
    "radius-md",
  ]);
  assert.deepEqual(parseLibrary(JSON.parse(JSON.stringify(packed))), packed);
  assert.deepEqual(doc, original);
});

test("explicit library choices include entire mixed libraries; imported-only and local-only filters respect source ownership", () => {
  const doc = blank(),
    local = snapshot("local", doc),
    foreign = snapshot("foreign");
  const shared = structuredClone(foreign.components[0]);
  shared.id = "other";
  local.components.push(shared);
  doc.libraries = { local, foreign };
  const select = (
    options: Partial<Parameters<typeof packageDocumentAsLibrary>[1]>,
  ) => packageDocumentAsLibrary(doc, { name: "", ...options });
  assert.deepEqual(
    select({}).components.map((c) => c.name),
    ["local"],
  );
  assert.equal(select({}).name, "canvas 组件库");
  assert.deepEqual(
    select({
      libraryIds: [local.id],
      includeLocalMasters: false,
    }).components.map((c) => c.id),
    ["component", "other"],
  );
  assert.deepEqual(
    select({
      includeLocalMasters: false,
      includeImportedLibraries: true,
    }).components.map((c) => c.name),
    ["foreign"],
  );
  assert.equal(select({ includeImportedLibraries: true }).components.length, 3);
  for (const options of [
    { libraryIds: [] },
    { libraryIds: ["unknown"] },
    { includeLocalMasters: false },
  ])
    assert.throws(() => select(options), /当前文档没有可打包的组件/);
});

test("extraction preserves colliding library themes, aliases, long style names, modes and interaction-only variables", () => {
  const doc = blank();
  doc.designSystem = nativeDesignSystem();
  const styleName = "S".repeat(200);
  doc.designSystem.styles["paint-accent"].name = styleName;
  const libraries = ["red", "blue"].map((id, i) => {
    const lib = snapshot(id);
    const system = (lib.designSystem = nativeDesignSystem());
    system.styles["paint-accent"].name = styleName;
    system.variables["palette-dark-accent"].values.base = i
      ? "#0000bb"
      : "#aa0000";
    system.variables["content-visible"].values.dark = !i;
    const n = lib.components[0].variants[0].nodes[0];
    n.styleBindings = { paint: "paint-accent" };
    n.variableModes = { semantic: "dark" };
    n.variableBindings = { radius: "radius-md" };
    n.interaction = {
      actions: [{ kind: "set", variable: "radius-md", value: 6 }],
    };
    n.interactions = [
      {
        trigger: "hover",
        condition: {
          variable: "content-visible",
          operator: "equals",
          value: true,
        },
        otherwise: [{ kind: "toggle", variable: "content-visible" }],
      },
    ];
    return lib;
  });
  doc.libraries = Object.fromEntries(
    libraries.map((library) => [library.id, library]),
  );
  doc.importReport = {
    version: 1,
    format: "Sketch",
    filename: "两套主题.sketch",
    sha256: "0".repeat(64),
    sourceNodes: 2,
    issues: [],
  };
  const before = structuredClone(doc);
  const packed = extractLibrariesFromDocument(doc);
  assert.equal(
    packed.description,
    "从 Sketch 原稿「两套主题.sketch」 提取的可复用组件库",
  );
  assert.equal(packed.source.name, "Sketch 原稿导入");
  const system = packed.designSystem!;
  const [first, second] = packed.components.map((c) => c.variants[0].nodes[0]);
  assert.notEqual(first.styleBindings!.paint, second.styleBindings!.paint);
  for (const [i, n] of [first, second].entries()) {
    assert.equal(
      resolveNode({ ...blank(), designSystem: system }, n).style.fill,
      i ? "#0000bb" : "#aa0000",
    );
    assert.deepEqual(n.interaction!.actions, [
      { kind: "set", variable: n.variableBindings!.radius, value: 6 },
    ]);
    const flag = n.interactions![0].condition!.variable;
    assert.equal(resolveVariable(system, flag, n.variableModes), !i);
    assert.deepEqual(n.interactions![0].otherwise, [
      { kind: "toggle", variable: flag },
    ]);
  }
  assert.deepEqual(doc, before);
  assert.deepEqual(parseLibrary(JSON.parse(JSON.stringify(packed))), packed);
});

test("document and library definitions can supply different bindings for the same layer", () => {
  const doc = blank(),
    lib = snapshot("theme");
  doc.name = "A".repeat(195) + "😀xyz";
  doc.designSystem = nativeDesignSystem();
  const layout = doc.designSystem.collections.layout;
  const inset = {
    ...doc.designSystem.variables["space-sm"],
    id: "inset",
    name: "Card inset",
  };
  lib.designSystem = {
    collections: { layout },
    activeModes: { layout: layout.defaultModeId },
    variables: { inset },
    styles: {},
  };
  const layer = lib.components[0].variants[0].nodes[0];
  layer.styleBindings = { paint: "paint-accent" };
  layer.variableBindings = { padding: inset.id };
  doc.libraries = { [lib.id]: lib };
  const packed = extractLibrariesFromDocument(doc);
  assert.ok(packed.name.length <= 200);
  assert.ok(packed.name.endsWith(" 组件库"));
  const node = packed.components[0].variants[0].nodes[0];
  assert.equal(node.variableBindings!.padding, inset.id);
  assert.equal(node.styleBindings!.paint, "paint-accent");
  assert.deepEqual(packed.designSystem!.variables.inset, inset);
  assert.equal(
    resolveNode({ ...blank(), designSystem: packed.designSystem }, node).style
      .padding,
    8,
  );
});

test("merged nested references follow renamed components in the portable library", () => {
  const doc = blank(),
    outer = snapshot("outer"),
    inner = snapshot("inner");
  const variant = outer.components[0].variants[0];
  const nested = createNode("frame", variant.nodes[0].id);
  nested.templateKey = "slot";
  nested.nestedSlot = true;
  nested.nestedSource = {
    libraryId: inner.id,
    componentId: "component",
    variantId: "default",
  };
  variant.nodes.push(nested);
  doc.libraries = { outer, inner };
  const library = extractLibrariesFromDocument(doc);
  assert.deepEqual(library.components[0].variants[0].nodes[1].nestedSource, {
    libraryId: library.id,
    componentId: "component-2",
    variantId: "default",
  });
  assert.equal(library.description, "从 设计文档「canvas」 提取的可复用组件库");
});

test("extracting an empty document or empty library reports the file-specific Chinese error", () => {
  const doc = blank();
  assert.throws(
    () => extractLibrariesFromDocument(doc),
    /此文件不包含可提取的组件或符号定义/,
  );
  doc.libraries = { empty: { ...snapshot("empty"), components: [] } };
  assert.throws(
    () => extractLibrariesFromDocument(doc),
    /此文件不包含可提取的组件或符号定义/,
  );
});

function overrideGlobal(key: "localStorage" | "indexedDB", value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  return () => {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  };
}

test("builtin preferences retain order, persist an explicit empty selection and isolate documents", (t) => {
  const values = new Map<string, string>();
  t.after(
    overrideGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }),
  );
  assert.equal(hasSavedBuiltinPreference("a"), false);
  assert.deepEqual(
    getEnabledBuiltinLibraries("a", new Set(["forma-mobile-v1", "material"])),
    ["forma-mobile-v1", "material"],
  );
  assert.deepEqual(
    getEnabledBuiltinLibraries("a", ["material", "web"], ["web", "web"]),
    ["web", "material"],
  );
  assert.deepEqual(
    setEnabledBuiltinLibraries("a", ["web", "material", "web"]),
    ["web", "material"],
  );
  assert.equal(
    values.get("forma-enabled-builtin-libs:a"),
    '["web","material"]',
  );
  assert.deepEqual(getEnabledBuiltinLibraries("a", ["old"]), [
    "web",
    "material",
  ]);
  setEnabledBuiltinLibraries("a", []);
  assert.equal(hasSavedBuiltinPreference("a"), true);
  assert.deepEqual(getEnabledBuiltinLibraries("a", ["old"]), []);
  assert.deepEqual(getEnabledBuiltinLibraries("b"), ["forma-mobile-v1"]);
  for (const corrupt of ["bad json", "null", "{}", '["old",false]']) {
    values.set("forma-enabled-builtin-libs:b", corrupt);
    assert.equal(hasSavedBuiltinPreference("b"), false);
    assert.deepEqual(getEnabledBuiltinLibraries("b"), ["forma-mobile-v1"]);
  }
});

test("unavailable localStorage still returns a usable builtin selection", (t) => {
  t.after(overrideGlobal("localStorage", undefined));
  assert.equal(hasSavedBuiltinPreference("doc"), false);
  assert.deepEqual(setEnabledBuiltinLibraries("doc", ["web", "web"]), ["web"]);
  assert.deepEqual(getEnabledBuiltinLibraries("doc", ["web"]), [
    "forma-mobile-v1",
    "web",
  ]);
});

test("workspace catalog validates, overwrites, sorts and isolates snapshots in Node fallback mode", async (t) => {
  t.after(overrideGlobal("indexedDB", undefined));
  const first = snapshot("catalog-first"),
    second = snapshot("catalog-second");
  const original = await saveWorkspaceLibrary(first, "sketch");
  assert.equal(original.componentCount, 1);
  assert.equal(original.variantCount, 1);
  original.library.components.length = 0;
  await saveWorkspaceLibrary(second, "figma");
  // Use a later timestamp so ordering is observable even with millisecond-resolution clocks.
  await new Promise((resolve) => setTimeout(resolve, 5));
  first.revision = 3;
  const c = first.components[0];
  c.variants.push({ ...structuredClone(c.variants[0]), id: "dark" });
  await saveWorkspaceLibrary(first, "packaged");
  const list = await listWorkspaceLibraries();
  assert.deepEqual(
    list.map((r) => r.id),
    [first.id, second.id],
  );
  assert.equal(list[0].revision, 3);
  assert.equal(list[0].variantCount, 2);
  assert.equal(list[0].sourceKind, "packaged");
  assert.ok(list[0].savedAt > list[1].savedAt);
  list[0].library.components.length = 0;
  await assert.rejects(
    saveWorkspaceLibrary({ ...first, components: [] }, "json"),
  );
  assert.equal(
    (await listWorkspaceLibraries())[0].library.components.length,
    1,
  );
  await deleteWorkspaceLibrary(first.id);
  await deleteWorkspaceLibrary(first.id);
  assert.deepEqual(
    (await listWorkspaceLibraries()).map((r) => r.id),
    [second.id],
  );
  await deleteWorkspaceLibrary(second.id);
  assert.deepEqual(await listWorkspaceLibraries(), []);
});

test("putLibrary checks remapped brand bindings before publishing the component source", () => {
  const library = snapshot("controls");
  const system = nativeDesignSystem();
  system.variables.brand = {
    ...system.variables["palette-light-accent"],
    id: "brand",
    name: "Brand",
  };
  library.designSystem = system;
  library.components[0].variants[0].nodes[0].variableBindings = {
    fill: "brand",
  };
  const { doc, id } = place(blank(), library);
  const source = doc.libraries![library.id];
  const changed = structuredClone(source);
  changed.designSystem!.variables.brand.values.base = "#023456";
  assert.throws(
    () => apply(doc, { type: "putLibrary", library: changed }),
    /此版本已有实例，请另存为新组件库，避免覆盖实例来源/,
  );
  assert.equal(
    doc.nodes.find((n) => n.id === id)?.variableBindings?.fill,
    "brand",
  );
  assert.equal(
    source.components[0].variants[0].nodes[0].variableBindings?.fill,
    "brand",
  );
  assert.deepEqual(
    doc.designSystem!.variables.brand.values,
    system.variables.brand.values,
  );
});

// Schedule store reads in transaction order and expose writes only at commit.
function workspaceDatabase(t: TestContext) {
  const disk = new Map<string, WorkspaceLibraryRecord>();
  const calls: string[] = [];
  const state = { failCommit: false, failOpen: false };
  const db = {
    onclose: () => {},
    transaction(storeName: string, mode: string) {
      assert.equal(storeName, "libraries");
      let aborted = false;
      let staged: WorkspaceLibraryRecord | undefined;
      const store = {
        get(id: string) {
          calls.push("get");
          const req = {
            result: undefined as WorkspaceLibraryRecord | undefined,
            onsuccess: () => {},
          };
          queueMicrotask(() => {
            req.result = structuredClone(disk.get(id));
            req.onsuccess();
            if (aborted || (mode === "readwrite" && state.failCommit)) {
              tx.onabort();
            } else {
              if (staged) disk.set(staged.id, staged);
              tx.oncomplete();
            }
          });
          return req;
        },
        put(record: WorkspaceLibraryRecord) {
          assert.equal(mode, "readwrite");
          calls.push("put");
          staged = structuredClone(record);
        },
      };
      const tx = {
        error: new Error("disk commit failed"),
        oncomplete: () => {},
        onabort: () => {},
        abort() {
          aborted = true;
        },
        objectStore: () => store,
      };
      return tx;
    },
  };
  t.after(
    overrideGlobal("indexedDB", {
      open() {
        const req = {
          result: db,
          error: new Error("open failed"),
          onsuccess: () => {},
          onerror: () => {},
        };
        queueMicrotask(() =>
          state.failOpen ? req.onerror() : req.onsuccess(),
        );
        return req;
      },
    }),
  );
  t.after(() => db.onclose());
  return { disk, calls, state };
}

test("workspace guide compare-and-update commits only against the latest durable library revision", async (t) => {
  const library = snapshot("guide-cas");
  const { disk: records, calls, state } = workspaceDatabase(t);
  const initial = await saveWorkspaceLibraryDurable(library, "json");
  calls.length = 0;
  const guide = { playbookMarkdown: "使用当前版本的业务规则" };
  const update = (revision: number) =>
    updateWorkspaceLibraryAiGuide(library.id, revision, guide);
  const result = await update(library.revision);
  assert.equal(result.status, "updated");
  assert.deepEqual(calls, ["get", "put"]);
  const disk = records.get(library.id)!;
  assert.ok(disk.savedAt > initial.savedAt);
  assert.deepEqual(disk.library, { ...library, aiGuide: guide });
  if (result.status === "updated") assert.deepEqual(result.record, disk);
  // A different window publishes a component, leaving this window's cache stale.
  disk.library.components.push({
    ...structuredClone(library.components[0]),
    id: "new-component",
  });
  disk.revision = ++disk.library.revision;
  disk.componentCount++;
  disk.variantCount++;
  const newer = structuredClone(disk);
  assert.deepEqual(await update(library.revision), {
    status: "conflict",
    currentRevision: disk.revision,
  });
  assert.deepEqual(records.get(library.id), newer);
  assert.deepEqual(await updateWorkspaceLibraryAiGuide("missing", 0, guide), {
    status: "not-found",
  });
  assert.deepEqual(calls, ["get", "put", "get", "get"]);
  state.failCommit = true;
  assert.equal(
    (
      await updateWorkspaceLibraryAiGuide(library.id, disk.revision, {
        summary: "never committed",
      })
    ).status,
    "error",
  );
  assert.deepEqual(records.get(library.id), newer);
});

test("durable saves compare revision and guide timestamp inside the write transaction", async (t) => {
  const { disk } = workspaceDatabase(t);
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-11-25T00:00:00Z"),
  });
  const library = snapshot("durable-compare");
  assert.equal(await getWorkspaceLibraryRecord(library.id), null);
  const [created, raced] = await Promise.allSettled([
    saveWorkspaceLibraryDurable(library, "packaged"),
    saveWorkspaceLibraryDurable(library, "json"),
  ]);
  assert.equal(created.status, "fulfilled");
  assert.equal(raced.status, "rejected");
  assert.ok(raced.reason instanceof WorkspaceLibraryConflictError);
  assert.deepEqual(raced.reason.current, created.value);

  // A different file edits only the guide while this file holds its old token.
  const guide = {
    playbookMarkdown:
      "<!-- forma:custom-notes -->file A's hand-edited guide<!-- /forma:custom-notes -->",
  };
  const board = createNode("frame");
  const fileB = apply(
    { ...blank("file-b"), nodes: [board] },
    { type: "putLibrary", library },
  );
  const plan = (record: WorkspaceLibraryRecord) =>
    promoteSelectionToLibrary(fileB, board.id, {
      targetLibraryId: library.id,
      existingWorkspaceLibrary: record.library,
    });
  const stale = plan(created.value);
  const edited = await updateWorkspaceLibraryAiGuide(
    library.id,
    library.revision,
    guide,
  );
  assert.equal(edited.status, "updated");
  assert.equal(edited.record.revision, created.value.revision);
  assert.notEqual(edited.record.savedAt, created.value.savedAt);
  await assert.rejects(
    saveWorkspaceLibraryDurable(stale.library, "packaged", created.value),
    (err) => {
      assert.ok(err instanceof WorkspaceLibraryConflictError);
      assert.deepEqual(err.current, edited.record);
      err.current.library.components.length = 0;
      return true;
    },
  );
  const latest = await getWorkspaceLibraryRecord(library.id);
  assert.ok(latest);
  const promotion = plan(latest);
  const next = promotion.library;
  assert.ok(next.aiGuide?.playbookMarkdown?.includes(guide.playbookMarkdown));
  assert.deepEqual(
    apply(fileB, ...promotion.operations).libraries![library.id],
    next,
  );
  await assert.rejects(
    saveWorkspaceLibraryDurable(next, "packaged", {
      ...edited.record,
      revision: 0,
    }),
    WorkspaceLibraryConflictError,
  );
  const saved = await saveWorkspaceLibraryDurable(
    next,
    "packaged",
    edited.record,
  );
  assert.deepEqual(await getWorkspaceLibraryRecord(library.id), saved);
  disk.set(library.id, { ...saved, componentCount: 999 });
  await assert.rejects(getWorkspaceLibraryRecord(library.id), /损坏/);
  await assert.rejects(
    saveWorkspaceLibraryDurable(next, "packaged", saved),
    /损坏/,
  );
  disk.delete(library.id);
  assert.equal(await getWorkspaceLibraryRecord(library.id), null);
  await assert.rejects(
    saveWorkspaceLibraryDurable(next, "packaged", saved),
    /已删除/,
  );
});

test("durable saves reject open and commit failures without publishing a cache entry or blocking a retry", async (t) => {
  const { disk, state } = workspaceDatabase(t);
  const library = snapshot("durable-failure");
  state.failOpen = true;
  await assert.rejects(
    saveWorkspaceLibraryDurable(library, "packaged"),
    /无法持久化组件库到本机工作区：open failed/,
  );
  state.failOpen = false;
  state.failCommit = true;
  await assert.rejects(
    saveWorkspaceLibraryDurable(library, "packaged"),
    /无法持久化组件库到本机工作区：disk commit failed/,
  );
  await assert.rejects(
    saveWorkspaceLibrary(library, "packaged"),
    /无法持久化组件库到本机工作区：disk commit failed/,
  );
  assert.equal(disk.has(library.id), false);
  const restore = overrideGlobal("indexedDB", undefined);
  try {
    assert.equal(await getWorkspaceLibraryRecord(library.id), null);
  } finally {
    restore();
  }
  state.failCommit = false;
  const saved = await saveWorkspaceLibraryDurable(library, "packaged");
  const restoreDisk = overrideGlobal("indexedDB", undefined);
  try {
    await saveWorkspaceLibrary(
      { ...library, revision: library.revision + 1 },
      "json",
    );
  } finally {
    restoreDisk();
  }
  await assert.rejects(
    saveWorkspaceLibraryDurable(library, "packaged", saved),
    /工作区有未持久化的组件库变更，请刷新后重试/,
  );
  assert.deepEqual(await getWorkspaceLibraryRecord(library.id), saved);
});

test("memory-only catalog never reports a durable guide update", async (t) => {
  t.after(overrideGlobal("indexedDB", undefined));
  const lib = snapshot("offline-guide");
  const fallback = await saveWorkspaceLibrary(lib, "json");
  try {
    assert.deepEqual(await getWorkspaceLibraryRecord(lib.id), fallback);
    await assert.rejects(
      saveWorkspaceLibraryDurable(lib, "json"),
      /当前环境不支持本机持久化组件库仓库/,
    );
    assert.equal(
      (
        await updateWorkspaceLibraryAiGuide(lib.id, lib.revision, {
          summary: "offline",
        })
      ).status,
      "error",
    );
    assert.equal(
      (await listWorkspaceLibraries()).find((r) => r.id === lib.id)!.library
        .aiGuide,
      undefined,
    );
  } finally {
    await deleteWorkspaceLibrary(lib.id);
  }
});
