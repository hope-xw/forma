import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DOMParser } from "@xmldom/xmldom";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import {
  buildManualEpisodeFromSelection,
  fileScopeId,
} from "../src/agent/project-memory";
import { useEditor, type EditorController } from "../src/editor/useEditor";
import { PromoteModuleModal } from "../src/editor/PromoteModuleModal";
import { commit, travel } from "../src/application/history";
import { prototypeProgram } from "../src/compiler/runtime";
import {
  CUSTOM_NOTES_END,
  CUSTOM_NOTES_START,
} from "../src/agent/library-intelligence";
import { BUILTIN_LIBRARY_IDS } from "../src/design-system/catalog";
import { nativeDesignSystem } from "../src/design-system/tokens";
import { transact, type Operation } from "../src/domain/commands";
import {
  createNode,
  parseDocument,
  type DesignDocument,
  type DesignNode,
} from "../src/domain/document";
import { resolveNode } from "../src/domain/design-system";
import { layoutBounds } from "../src/domain/geometry";
import {
  instantiateComponent,
  validateInstanceStructure,
} from "../src/domain/library";
import {
  NEW_PROJECT_LIBRARY_TARGET,
  projectDerivedLibraryId,
  promoteSelectionToLibrary,
  suggestPromotionDefaults,
} from "../src/domain/library-promotion";
import {
  registerCatalogFileGuard,
  beginWorkspaceScopeFence,
  endWorkspaceScopeFence,
  deleteWorkspaceLibrary,
  readWorkspaceScopeFence,
  saveWorkspaceLibraryIfUnchanged,
  getWorkspaceLibraryRecord,
  listWorkspaceLibraries,
} from "../src/infrastructure/library-catalog-store";
import {
  BrowserDocumentRepository,
  checkCatalogFile,
  readLiveFileState,
} from "../src/infrastructure/storage";
import {
  deleteDesignEpisode,
  FileLifetimeMismatchError,
  IndexedDbProjectMemoryRepository,
  listScopeEpisodes,
  saveDesignEpisodeWithReceipt,
} from "../src/infrastructure/project-memory-store";
import { parseLibrary } from "../src/domain/library-schema";
import { openPage } from "../src/domain/pages";
import { linkedPrototypeScene, prototypeIssues } from "../src/domain/prototype";

// Use Vitest's registration when invoked with Vitest and participate in the
// repository's regular `npm test` (Node test runner) with the same assertions.
const runner = process.env.VITEST ? "vitest" : "node:test";
const { test }: { test(name: string, run: () => void): void } = await import(
  runner
);

function drawing(...nodes: DesignNode[]): DesignDocument {
  return {
    schemaVersion: 1,
    id: "file-a",
    name: "设计稿",
    nodes,
    tokens: {},
    revision: 0,
  };
}

function apply(doc: DesignDocument, operations: Operation[]) {
  return transact(doc, { baseRevision: doc.revision, operations });
}

function firstPromotion(name = "Hero") {
  const root = createNode("frame");
  root.name = name;
  const doc = drawing(root);
  const first = promoteSelectionToLibrary(doc, root.id, { projectId: "shop" });
  return { doc, root, first };
}

test("defaults classify page, block and component with the same tier used on promotion", () => {
  const page = createNode("frame");
  const card = createNode("frame");
  Object.assign(card.style, { width: 225, height: 120 });
  card.name = "Product Card";
  const icon = createNode("ellipse", card.id),
    label = createNode("text", card.id);
  const doc = drawing(page, card, icon, label);
  for (const [node, tier, category] of [
    [page, "page", "页面样板"],
    [card, "block", "业务模块"],
    [icon, "component", "自定义组件"],
  ] as const) {
    assert.deepEqual(suggestPromotionDefaults(doc, node.id), {
      assetTier: tier,
      category,
      componentName: node.name,
      suggestedLibraryId: NEW_PROJECT_LIBRARY_TARGET,
      suggestedNewLibraryName: "设计稿 · 自定义模块库",
    });
    const promoted = promoteSelectionToLibrary(doc, node.id).library
      .components[0];
    assert.equal(promoted.assetTier, tier);
    assert.equal(promoted.category, category);
  }
});

test("prefers a writable explicit target, then the existing project library in either location", () => {
  const { first, root, doc } = firstPromotion();
  const custom = { ...first.library, id: "custom" };
  const local = apply(doc, [{ type: "putLibrary", library: custom }]);
  const options = {
    projectId: "shop",
    projectName: "商城",
    workspaceLibraries: [first.library],
  };
  for (const preferredLibraryId of [
    undefined,
    "missing",
    ...BUILTIN_LIBRARY_IDS,
  ]) {
    const defaults = suggestPromotionDefaults(local, root.id, {
      ...options,
      preferredLibraryId,
    });
    assert.equal(defaults.suggestedLibraryId, first.library.id);
    assert.equal(defaults.suggestedNewLibraryName, "商城 · 业务模块库");
  }
  assert.equal(
    suggestPromotionDefaults(local, root.id, {
      ...options,
      preferredLibraryId: custom.id,
    }).suggestedLibraryId,
    custom.id,
  );
  const installed = apply(doc, first.operations);
  assert.equal(
    suggestPromotionDefaults(installed, root.id, { projectId: "shop" })
      .suggestedLibraryId,
    first.library.id,
  );
  assert.equal(
    suggestPromotionDefaults(installed, root.id, {
      preferredLibraryId: custom.id,
      workspaceLibraries: [custom],
    }).suggestedLibraryId,
    custom.id,
  );
  assert.equal(
    suggestPromotionDefaults(doc, root.id, {
      projectId: "other",
      preferredLibraryId: "constructor",
    }).suggestedLibraryId,
    NEW_PROJECT_LIBRARY_TARGET,
  );
});

test("rejects every official kit and missing explicit targets, including mismatched workspace copies", () => {
  const { doc, root, first } = firstPromotion();
  for (const id of BUILTIN_LIBRARY_IDS) {
    const library = { ...first.library, id };
    assert.throws(
      () =>
        promoteSelectionToLibrary(doc, root.id, {
          targetLibraryId: id,
          existingWorkspaceLibrary: library,
        }),
      /官方内置组件库为只读，请沉淀至项目衍生库或自定义组件库/,
    );
  }
  for (const id of ["missing", "constructor"])
    assert.throws(
      () =>
        promoteSelectionToLibrary(doc, root.id, {
          targetLibraryId: id,
          existingWorkspaceLibrary: first.library,
        }),
      /目标组件库不存在/,
    );
});

test("rejects missing, locked and instance-internal selections while accepting the instance root", () => {
  const root = createNode("frame"),
    child = createNode("text", root.id);
  const doc = drawing(root, child);
  assert.throws(() => promoteSelectionToLibrary(doc, "missing"), /选择/);
  root.locked = true;
  for (const n of [root, child])
    assert.throws(() => promoteSelectionToLibrary(doc, n.id), /锁定/);
  root.locked = false;
  const result = promoteSelectionToLibrary(doc, root.id, {
    replaceSelectionWithInstance: true,
  });
  const applied = apply(doc, result.operations);
  const leaf = applied.nodes.find((n) => n.parentId === result.replacedNodeId)!;
  assert.throws(
    () => promoteSelectionToLibrary(applied, leaf.id),
    /请先选择所属实例或显式分离后再沉淀/,
  );
  assert.ok(
    promoteSelectionToLibrary(applied, result.replacedNodeId!)
      .createdNewLibrary,
  );
  child.locked = true;
  assert.throws(
    () =>
      promoteSelectionToLibrary(doc, root.id, {
        replaceSelectionWithInstance: true,
      }),
    /锁定/,
  );
  assert.ok(promoteSelectionToLibrary(doc, root.id).createdNewLibrary);
});

test("creates a detached, schema-valid project library with cleaned hints and an offline playbook", () => {
  const root = createNode("frame");
  const doc = drawing(root);
  const result = promoteSelectionToLibrary(doc, root.id, {
    projectId: "Shop V2",
    projectName: "商城",
    newLibraryName: "  商城楼层  ",
    componentName: "  Sale Banner  ",
    category: " 活动 ",
    assetTier: "block",
    description: " 活动横幅 ",
    whenToUse: "  大促活动页  ",
    tags: [" 大促 ", "", "大促", "节日"],
  });
  const { library, componentId, variantId } = result;
  assert.equal(library.name, "商城楼层");
  assert.equal(library.id, "proj-lib-shop-v2");
  assert.equal(library.revision, 1);
  assert.equal(result.createdNewLibrary, true);
  assert.equal(result.playbookRefreshed, true);
  assert.equal(result.replacedNodeId, undefined);
  assert.equal(componentId, "sale-banner");
  const component = library.components[0];
  assert.equal(component.id, componentId);
  assert.equal(component.name, "Sale Banner");
  assert.equal(component.description, "活动横幅");
  assert.equal(component.assetTier, "block");
  assert.equal(component.category, "活动");
  assert.deepEqual(component.aiHints, {
    whenToUse: "大促活动页",
    tags: ["大促", "节日"],
  });
  assert.equal(component.master, undefined);
  assert.equal(component.variants[0].masterNodeId, undefined);
  assert.equal(component.variants[0].id, variantId);
  assert.equal(library.aiGuide?.revision, 1);
  assert.match(library.aiGuide!.playbookMarkdown!, /Sale Banner/);
  assert.match(library.aiGuide!.playbookMarkdown!, /大促活动页/);
  assert.deepEqual(parseLibrary(library), library);
  assert.deepEqual(result.operations, [{ type: "putLibrary", library }]);
  assert.deepEqual(
    apply(doc, result.operations).nodes,
    parseDocument(doc).nodes,
  );
  assert.equal(doc.libraries, undefined);
});

test("project identifiers are stable and bounded; unassigned files create independent libraries", () => {
  for (const value of ["淘宝", "x".repeat(200), "项目/A 🙂"]) {
    const id = projectDerivedLibraryId(value);
    assert.match(id, /^proj-lib-[a-z0-9-]+$/);
    assert.ok(id.length <= 96);
    assert.equal(projectDerivedLibraryId(value), id);
  }
  assert.notEqual(
    projectDerivedLibraryId("淘宝"),
    projectDerivedLibraryId("京东"),
  );
  assert.notEqual(
    projectDerivedLibraryId("x".repeat(200)),
    projectDerivedLibraryId("x".repeat(201)),
  );
  assert.match(projectDerivedLibraryId(), /^custom-modules-/);
  const { doc, root } = firstPromotion();
  root.name = "";
  const first = promoteSelectionToLibrary(doc, root.id, {
    refreshPlaybook: false,
    tags: [" "],
    whenToUse: "  ",
  });
  assert.match(first.library.id, /^lib-/);
  assert.notEqual(
    first.library.id,
    promoteSelectionToLibrary(doc, root.id).library.id,
  );
  assert.equal(first.componentId, "module");
  assert.equal(first.library.components[0].variants[0].nodes[0].name, "");
  assert.equal(first.library.components[0].aiHints, undefined);
  assert.equal(first.library.aiGuide, undefined);
});

test("appends against live instances without changing their sources when variable and style definitions conflict", () => {
  const master = createNode("frame"),
    child = createNode("rectangle", master.id);
  const doc = drawing(master, child);
  doc.designSystem = nativeDesignSystem();
  child.variableBindings = { radius: "radius-md" };
  child.styleBindings = { paint: "paint-accent" };
  const normalized = parseDocument(doc);
  const first = promoteSelectionToLibrary(normalized, master.id, {
    componentName: "Hero",
    projectId: "shop",
  });
  const installed = apply(normalized, first.operations);
  const placed = instantiateComponent(
    installed,
    installed.libraries![first.library.id],
    first.componentId,
    first.variantId,
    null,
    { x: 50, y: 60 },
  );
  let live = apply(installed, placed.operations);
  const original = structuredClone(live.libraries![first.library.id]);
  const system = structuredClone(live.designSystem!);
  system.variables["radius-md"].values.comfortable = 41;
  system.variables["palette-light-accent"].values.base = "#aa0011";
  const second = createNode("frame"),
    content = createNode("rectangle", second.id);
  content.variableBindings = { radius: "radius-md" };
  content.styleBindings = { paint: "paint-accent" };
  const label = createNode("text", second.id);
  const textStyle = Object.values(system.styles).find(
    (style) => style.kind === "text",
  )!;
  label.styleBindings = { text: textStyle.id };
  content.interactions = [
    { actions: [{ kind: "toggle", variable: "content-visible" }] },
  ];
  live = apply(live, [
    { type: "setDesignSystem", system },
    { type: "create", node: second },
    { type: "create", node: content },
    { type: "create", node: label },
  ]);
  const before = structuredClone(live);
  const promoted = promoteSelectionToLibrary(live, second.id, {
    projectId: "shop",
    targetLibraryId: NEW_PROJECT_LIBRARY_TARGET,
    componentName: "Hero",
    assetTier: "block",
  });
  assert.equal(promoted.createdNewLibrary, false);
  assert.equal(promoted.componentId, "hero-2");
  assert.equal(promoted.library.revision, original.revision + 1);
  assert.deepEqual(promoted.library.components[0], original.components[0]);
  assert.deepEqual(
    promoted.library.designSystem!.variables["radius-md"],
    original.designSystem!.variables["radius-md"],
  );
  const added = promoted.library.components[1].variants[0].nodes.find(
    (n) => n.id === content.id,
  )!;
  assert.notEqual(added.variableBindings!.radius, "radius-md");
  assert.notEqual(added.styleBindings!.paint, "paint-accent");
  const action = added.interactions![0].actions![0];
  assert.ok(action.kind === "toggle");
  assert.ok(promoted.library.designSystem!.variables[action.variable]);
  const resolved = resolveNode(
    { ...live, designSystem: promoted.library.designSystem },
    added,
  );
  assert.equal(resolved.style.radius, 41);
  assert.equal(resolved.style.fill, "#aa0011");
  const after = apply(live, promoted.operations);
  assert.deepEqual(after.nodes, live.nodes);
  assert.deepEqual(
    after.libraries![first.library.id].components[0],
    original.components[0],
  );
  validateInstanceStructure(
    after,
    after.nodes.find((n) => n.id === placed.id)!,
  );
  assert.deepEqual(live, before);
});

test("appends to workspace-only libraries and rejects publishing against an older workspace missing local components", () => {
  const { doc, root, first } = firstPromotion("A".repeat(180));
  const options = {
    projectId: "shop",
    existingWorkspaceLibrary: first.library,
  };
  const second = promoteSelectionToLibrary(doc, root.id, options);
  assert.equal(second.createdNewLibrary, false);
  assert.equal(second.library.id, first.library.id);
  assert.equal(second.componentId, "a".repeat(126) + "-2");
  const installed = apply(doc, second.operations);
  assert.throws(
    () =>
      promoteSelectionToLibrary(installed, root.id, {
        ...options,
        targetLibraryId: first.library.id,
      }),
    /与工作区副本存在分歧/,
  );
  const third = promoteSelectionToLibrary(installed, root.id, {
    ...options,
    existingWorkspaceLibrary: second.library,
  });
  assert.equal(third.componentId, "a".repeat(126) + "-3");
  assert.equal(third.library.revision, 3);
  assert.deepEqual(
    third.library.components.slice(0, 2),
    second.library.components,
  );
  assert.equal(first.library.components.length, 1);
  assert.equal(doc.libraries, undefined);
});

for (const [start, end] of [
  [CUSTOM_NOTES_START, CUSTOM_NOTES_END],
  ["<!-- forma:custom-notes -->", "<!-- /forma:custom-notes -->"],
  ["<!-- forma:custom-notes -->", ""],
]) {
  test(
    "keeps designer notes byte-for-byte across refreshes with markers " +
      start +
      end,
    () => {
      const { doc, root, first } = firstPromotion();
      const block = start + "\r\n\r\n  - 使用 `商品`  \r\n\t$& / $1\n\n" + end;
      const target = structuredClone(first.library);
      target.aiGuide = {
        summary: "手写摘要",
        revision: 1,
        playbookMarkdown: "旧生成内容\n" + block,
      };
      const opts = {
        targetLibraryId: target.id,
        existingWorkspaceLibrary: target,
        componentName: "Fresh",
      };
      const result = promoteSelectionToLibrary(doc, root.id, opts);
      const markdown = result.library.aiGuide!.playbookMarkdown!;
      assert.ok(markdown.includes(block));
      assert.match(markdown, /Fresh/);
      assert.doesNotMatch(markdown, /旧生成内容/);
      assert.equal(result.library.aiGuide?.summary, "手写摘要");
      const applied = apply(doc, result.operations);
      const again = promoteSelectionToLibrary(applied, root.id, {
        ...opts,
        existingWorkspaceLibrary: result.library,
      });
      assert.ok(again.library.aiGuide!.playbookMarkdown!.includes(block));
      const skipped = promoteSelectionToLibrary(doc, root.id, {
        ...opts,
        refreshPlaybook: false,
      });
      assert.equal(skipped.playbookRefreshed, false);
      assert.deepEqual(skipped.library.aiGuide, target.aiGuide);
    },
  );
}

test("captures nested instance sources, original overrides, images, fonts and variable dependencies", () => {
  const page = createNode("frame"),
    nested = createNode("frame"),
    text = createNode("text", nested.id);
  const doc = drawing(page, nested, text);
  const imageId = "img-" + "a".repeat(64),
    fontId = "font-" + "b".repeat(64);
  doc.images = {
    [imageId]: {
      name: "商品图",
      width: 4,
      height: 8,
      data: "data:image/png;base64,AA==",
    },
  };
  doc.fonts = {
    [fontId]: { name: "标题字体", axes: [], data: "data:font/otf;base64,AA==" },
  };
  doc.designSystem = nativeDesignSystem();
  text.variableBindings = { radius: "radius-md" };
  text.style.fontFamily = fontId;
  nested.image = { assetId: imageId, fit: "cover", x: 50, y: 50, zoom: 1 };
  const normalized = parseDocument(doc);
  const button = promoteSelectionToLibrary(normalized, nested.id, {
    componentName: "Item",
  });
  const installed = apply(normalized, button.operations);
  const placed = instantiateComponent(
    installed,
    installed.libraries![button.library.id],
    button.componentId,
    button.variantId,
    page.id,
    { x: 64, y: 75 },
  );
  let live = apply(installed, placed.operations);
  const leaf = live.nodes.find((n) => n.parentId === placed.id)!;
  live = apply(live, [
    { type: "update", id: leaf.id, patch: { text: "会员商品" } },
  ]);
  const outer = promoteSelectionToLibrary(live, page.id, { projectId: "shop" });
  const nodes = outer.library.components[0].variants[0].nodes;
  const slot = nodes.find((n) => n.id === placed.id)!;
  assert.equal(slot.nestedSlot, true);
  assert.deepEqual(slot.nestedSource, {
    libraryId: button.library.id,
    componentId: button.componentId,
    variantId: button.variantId,
  });
  assert.equal(slot.instance, undefined);
  assert.equal(slot.nestedKey, "root");
  assert.equal(slot.image?.assetId, imageId);
  assert.deepEqual(outer.library.images, doc.images);
  assert.deepEqual(outer.library.fonts, doc.fonts);
  const template = nodes.find((n) => n.id === leaf.id)!;
  assert.equal(template.text, "会员商品");
  assert.equal(template.variableBindings?.radius, "radius-md");
  assert.equal(template.style.fontFamily, fontId);
  assert.deepEqual(Object.keys(outer.library.designSystem!.variables), [
    "radius-md",
  ]);
  const other = drawing();
  const crossFile = instantiateComponent(
    other,
    outer.library,
    outer.componentId,
    outer.variantId,
    null,
    { x: 3, y: 5 },
  );
  const applied = apply(other, crossFile.operations);
  validateInstanceStructure(
    applied,
    applied.nodes.find((n) => n.id === crossFile.id)!,
  );
  assert.deepEqual(applied.images, doc.images);
  assert.deepEqual(applied.fonts, doc.fonts);
});

for (const container of ["root", "frame", "column"] as const) {
  test(
    "replaces a middle " +
      container +
      " sibling in place and restores the entire document with one undo",
    () => {
      const parent = container === "root" ? undefined : createNode("frame");
      if (parent)
        Object.assign(parent.style, {
          x: 300,
          y: -90,
          layout: container === "column" ? "column" : "free",
          padding: 8,
          gap: 9,
        });
      const before = createNode("rectangle", parent?.id),
        after = createNode("rectangle", parent?.id);
      const root = createNode("frame", parent?.id);
      Object.assign(root.style, { x: -23, y: 84, width: 144, height: 96 });
      const child = createNode("text", root.id);
      const doc = parseDocument(
        drawing(...(parent ? [parent] : []), before, root, child, after),
      );
      const first = promoteSelectionToLibrary(doc, before.id, {
        projectId: "shop",
      });
      const original = parent ? apply(doc, first.operations) : doc;
      const bounds = layoutBounds(original).get(root.id);
      const result = promoteSelectionToLibrary(original, root.id, {
        projectId: "shop",
        replaceSelectionWithInstance: true,
      });
      assert.equal(
        result.operations.filter((op) => op.type === "putLibrary").length,
        1,
      );
      const applied = apply(original, result.operations);
      assert.equal(applied.revision, original.revision + 1);
      assert.deepEqual(
        applied.nodes
          .filter((n) => n.parentId === root.parentId)
          .map((n) => n.id),
        [before.id, result.replacedNodeId, after.id],
      );
      assert.equal(result.replacedNodeId, root.id);
      assert.equal(
        applied.nodes.find((n) => n.id === child.id)?.parentId,
        root.id,
      );
      const instance = applied.nodes.find(
        (n) => n.id === result.replacedNodeId,
      )!;
      assert.deepEqual(instance.instance, {
        libraryId: result.library.id,
        componentId: result.componentId,
        variantId: result.variantId,
      });
      assert.deepEqual(layoutBounds(applied).get(instance.id), bounds);
      validateInstanceStructure(applied, instance);
      const leaf = applied.nodes.find((n) => n.parentId === instance.id)!;
      assert.throws(
        () => apply(applied, [{ type: "remove", id: leaf.id }]),
        /结构受保护/,
      );
      const undo = travel(
        commit({ present: original, past: [], future: [] }, applied),
        "undo",
      );
      assert.deepEqual(undo.present, {
        ...original,
        revision: applied.revision + 1,
      });
    },
  );
}

test("promoting an artboard preserves incoming navigation, overlays and child targets on both pages through one undo", () => {
  const a = createNode("frame"),
    button = createNode("button", a.id);
  const b = createNode("frame"),
    maskGroup = createNode("group", b.id),
    leaf = createNode("rectangle", maskGroup.id);
  const foreign = createNode("frame"),
    link = createNode("button", foreign.id);
  button.interaction = { actions: [{ kind: "navigate", target: b.id }] };
  button.interactions = [
    { trigger: "hover", actions: [{ kind: "scrollTo", target: leaf.id }] },
  ];
  leaf.interactions = [{ actions: [{ kind: "navigate", target: b.id }] }];
  b.interaction = {
    flow: "结账",
    actions: [{ kind: "navigate", target: foreign.id }],
  };
  maskGroup.maskSourceId = leaf.id;
  maskGroup.maskType = "alpha";
  link.interaction = {
    actions: [{ kind: "overlay", target: b.id, position: "center" }],
  };
  const doc = parseDocument({
    ...drawing(a, button, b, maskGroup, leaf),
    activePage: "boards",
    pages: [
      { id: "boards", name: "画板" },
      { id: "other", name: "另一页", nodes: [foreign, link] },
    ],
  });
  const result = promoteSelectionToLibrary(doc, b.id, {
    replaceSelectionWithInstance: true,
  });
  assert.equal(result.replacedNodeId, b.id);
  assert.deepEqual(
    result.operations.slice(0, 2).map((op) => op.type),
    ["putLibrary", "remove"],
  );
  const applied = apply(doc, result.operations);
  const instance = applied.nodes.find((n) => n.id === b.id)!;
  validateInstanceStructure(applied, instance);
  assert.equal(
    applied.nodes.find((n) => n.id === maskGroup.id)?.maskSourceId,
    leaf.id,
  );
  function verifyLinks(document: DesignDocument) {
    for (const page of ["boards", "other"]) {
      const scene = linkedPrototypeScene(openPage(document, page));
      assert.deepEqual(prototypeIssues(scene), []);
      const program = prototypeProgram(scene)!;
      assert.deepEqual(
        program.rules[link.id].actions,
        link.interaction!.actions,
      );
      assert.deepEqual(
        program.rules[leaf.id].actions,
        leaf.interactions![0].actions,
      );
      assert.ok(program.flows.some((flow) => flow.id === b.id));
      if (page === "boards") {
        assert.deepEqual(
          program.rules[button.id].actions,
          button.interaction!.actions,
        );
        assert.deepEqual(
          program.multiRules![button.id][1].actions,
          button.interactions![0].actions,
        );
      }
    }
  }
  verifyLinks(applied);
  const undo = travel(
    commit({ present: doc, past: [], future: [] }, applied),
    "undo",
  );
  assert.deepEqual(undo.present, { ...doc, revision: applied.revision + 1 });
  verifyLinks(undo.present);
});

test("file B preserves file A's equal-revision workspace guide when refreshing or leaving it untouched", () => {
  const { first } = firstPromotion();
  const root = createNode("frame");
  const fileB = apply({ ...drawing(root), id: "file-b" }, first.operations);
  const note =
    CUSTOM_NOTES_START + "\nfile A: keep my note\n" + CUSTOM_NOTES_END;
  const workspace = {
    ...first.library,
    aiGuide: { playbookMarkdown: note, summary: "file A summary" },
  };
  for (const refreshPlaybook of [true, false]) {
    const result = promoteSelectionToLibrary(fileB, root.id, {
      projectId: "shop",
      existingWorkspaceLibrary: workspace,
      refreshPlaybook,
    });
    const guide = apply(fileB, result.operations).libraries![workspace.id]
      .aiGuide;
    assert.ok(guide?.playbookMarkdown?.includes(note));
    assert.equal(guide?.summary, workspace.aiGuide.summary);
    if (!refreshPlaybook) assert.deepEqual(guide, workspace.aiGuide);
  }
});

test("appending uses newer workspace components and rejects incompatible sources used on an inactive page", () => {
  const { root, doc, first } = firstPromotion();
  const placed = instantiateComponent(
    doc,
    first.library,
    first.componentId,
    first.variantId,
    null,
    { x: 0, y: 0 },
  );
  const live = apply(doc, placed.operations);
  const other = createNode("frame");
  const file = parseDocument({
    ...live,
    nodes: [other],
    activePage: "second",
    pages: [
      { id: "first", name: "Live instance", nodes: live.nodes },
      { id: "second", name: "Editor" },
    ],
  });
  const workspace = promoteSelectionToLibrary(doc, root.id, {
    targetLibraryId: first.library.id,
    existingWorkspaceLibrary: first.library,
  }).library;
  const options = { projectId: "shop", existingWorkspaceLibrary: workspace };
  for (const replaceSelectionWithInstance of [false, true]) {
    const result = promoteSelectionToLibrary(file, other.id, {
      ...options,
      replaceSelectionWithInstance,
    });
    assert.equal(result.library.revision, workspace.revision + 1);
    assert.deepEqual(
      result.library.components.slice(0, 2),
      workspace.components,
    );
    const applied = openPage(apply(file, result.operations), "first");
    validateInstanceStructure(
      applied,
      applied.nodes.find((n) => n.id === placed.id)!,
    );
    const incompatible = {
      ...workspace,
      components: workspace.components.slice(1),
    };
    assert.throws(
      () =>
        promoteSelectionToLibrary(file, other.id, {
          ...options,
          existingWorkspaceLibrary: incompatible,
          replaceSelectionWithInstance,
        }),
      /已安装组件库与工作区副本存在结构冲突/,
    );
  }
});

test("promotion from revision 1 preserves the workspace Remote component and the file's live Initial instance", () => {
  const { root, first, doc } = firstPromotion("Initial");
  const placed = instantiateComponent(
    doc,
    first.library,
    first.componentId,
    first.variantId,
    null,
    { x: 0, y: 0 },
  );
  const fileB = apply(doc, placed.operations);
  const remote = promoteSelectionToLibrary(fileB, root.id, {
    targetLibraryId: first.library.id,
    componentName: "Remote",
  }).library;
  assert.equal(remote.revision, 2);
  const result = promoteSelectionToLibrary(fileB, root.id, {
    targetLibraryId: remote.id,
    existingWorkspaceLibrary: remote,
    componentName: "Next",
  });
  assert.equal(result.library.revision, 3);
  assert.deepEqual(
    result.library.components.map((c) => c.name),
    ["Initial", "Remote", "Next"],
  );
  assert.deepEqual(result.library.components.slice(0, 2), remote.components);
  const applied = apply(fileB, result.operations);
  assert.deepEqual(applied.nodes, fileB.nodes);
  validateInstanceStructure(
    applied,
    applied.nodes.find((n) => n.id === placed.id)!,
  );
  const conflict = structuredClone(remote);
  conflict.components[0].variants[0].nodes[0].style.width++;
  assert.throws(
    () =>
      promoteSelectionToLibrary(fileB, root.id, {
        targetLibraryId: remote.id,
        existingWorkspaceLibrary: conflict,
      }),
    {
      message:
        "当前文件中的已安装组件库与工作区副本存在结构冲突，请先同步组件库或另存为新库，避免覆盖工作区组件",
    },
  );
});

test("equal-revision local and workspace branches cannot silently remove Local or Remote on promotion", () => {
  const { root, first, doc } = firstPromotion("Initial");
  const installed = apply(doc, first.operations);
  const append = (componentName: string) =>
    promoteSelectionToLibrary(installed, root.id, {
      targetLibraryId: first.library.id,
      componentName,
    });
  const workspace = append("Remote").library;
  const fileB = apply(installed, append("Local").operations);
  const local = fileB.libraries![workspace.id];
  assert.equal(workspace.revision, 2);
  assert.equal(local.revision, 2);
  assert.throws(
    () =>
      promoteSelectionToLibrary(fileB, root.id, {
        targetLibraryId: workspace.id,
        existingWorkspaceLibrary: workspace,
        componentName: "Next",
      }),
    {
      message:
        "当前文件中的组件「Local」与工作区副本存在分歧，请先同步组件库或另存为新库，避免覆盖本地定义",
    },
  );
  assert.deepEqual(
    workspace.components.map((c) => c.name),
    ["Initial", "Remote"],
  );
  assert.deepEqual(
    local.components.map((c) => c.name),
    ["Initial", "Local"],
  );
});

test("promotion rejects unused divergent 122px and 244px Card definitions at equal and newer workspace revisions", () => {
  const { root, doc, first } = firstPromotion("Initial");
  const installed = apply(doc, first.operations);
  const branch = (width: number) =>
    promoteSelectionToLibrary(
      {
        ...installed,
        nodes: [{ ...root, style: { ...root.style, width } }],
      },
      root.id,
      { targetLibraryId: first.library.id, componentName: "Card" },
    );
  const local = branch(122);
  const workspace = branch(244).library;
  const fileB = apply(installed, local.operations);
  assert.ok(fileB.nodes.every((node) => !node.instance));
  const cardWidth = (lib: typeof workspace) =>
    lib.components.find((component) => component.id === "card")!.variants[0]
      .nodes[0].style.width;
  assert.deepEqual([local.library.revision, workspace.revision], [2, 2]);
  const newer = promoteSelectionToLibrary(installed, root.id, {
    targetLibraryId: workspace.id,
    existingWorkspaceLibrary: workspace,
    componentName: "Other",
  }).library;
  assert.equal(newer.revision, 3);
  assert.equal(newer.components.at(-1)?.name, "Other");
  for (const remote of [workspace, newer]) {
    assert.throws(
      () =>
        promoteSelectionToLibrary(fileB, root.id, {
          targetLibraryId: remote.id,
          existingWorkspaceLibrary: remote,
          componentName: "Next",
        }),
      /与工作区副本存在(分歧|结构冲突)/,
    );
    assert.deepEqual(
      [cardWidth(fileB.libraries![remote.id]), cardWidth(remote)],
      [122, 244],
    );
    assert.ok(!remote.components.some((c) => c.name === "Next"));
  }
});

test("library parsing rejects the reserved __proto__ ID", () => {
  const { first } = firstPromotion();
  assert.throws(
    () => parseLibrary({ ...first.library, id: "__proto__" }),
    /组件库 ID 不能为保留键名 __proto__/,
  );
});

test("replaying a replacement resolves workspace-only token collisions to the IDs actually installed", () => {
  const source = createNode("rectangle"),
    author = drawing(source);
  source.variableBindings = { radius: "radius-md" };
  author.designSystem = nativeDesignSystem();
  const first = promoteSelectionToLibrary(author, source.id, {
    projectId: "shop",
  });
  const root = createNode("frame"),
    child = createNode("text", root.id);
  root.variableBindings = child.variableBindings = { radius: "radius-md" };
  const doc = drawing(root, child);
  doc.designSystem = nativeDesignSystem();
  doc.designSystem.variables["radius-md"].values.comfortable = 21;
  const result = promoteSelectionToLibrary(doc, root.id, {
    projectId: "shop",
    existingWorkspaceLibrary: first.library,
    replaceSelectionWithInstance: true,
  });
  assert.deepEqual(result.library.components[0], first.library.components[0]);
  for (let replay = 0; replay < 2; replay++) {
    const applied = apply(doc, result.operations);
    const actual =
      applied.libraries![first.library.id].components[1].variants[0].nodes;
    const instance = applied.nodes.find((n) => n.id === result.replacedNodeId)!;
    validateInstanceStructure(applied, instance);
    for (const n of applied.nodes) {
      const template = actual.find((t) => t.templateKey === n.templateKey)!;
      assert.deepEqual(n.variableBindings, template.variableBindings);
      assert.equal(resolveNode(applied, n).style.radius, 21);
    }
  }
});

test("merges image and font assets additively and keeps existing metadata for shared content", () => {
  const root = createNode("frame"),
    title = createNode("text", root.id);
  const doc = drawing(root, title);
  const cover = "img-" + "a".repeat(64),
    detail = "img-" + "b".repeat(64);
  const heading = "font-" + "c".repeat(64),
    caption = "font-" + "d".repeat(64);
  const image = {
    name: "Cover",
    width: 4,
    height: 8,
    data: "data:image/png;base64,AA==",
  };
  const font = { name: "Heading", axes: [], data: "data:font/ttf;base64,AA==" };
  doc.images = { [cover]: image };
  doc.fonts = { [heading]: font };
  root.image = { assetId: cover, fit: "cover", x: 50, y: 50, zoom: 1 };
  title.style.fontFamily = heading;
  const first = promoteSelectionToLibrary(doc, root.id, { projectId: "shop" });
  const workspace = structuredClone(first.library);
  const next = structuredClone(doc);
  next.images![cover].name = "Different file name";
  next.fonts![heading].name = "Different family label";
  next.images![detail] = {
    ...image,
    name: "Detail",
    data: "data:image/png;base64,AQ==",
  };
  next.fonts![caption] = {
    ...font,
    name: "Caption",
    data: "data:font/ttf;base64,AQ==",
  };
  const label = createNode("text", root.id);
  label.image = { ...root.image, assetId: detail };
  label.style.fontFamily = caption;
  next.nodes.push(label);
  const options = {
    targetLibraryId: workspace.id,
    existingWorkspaceLibrary: workspace,
  };
  const added = promoteSelectionToLibrary(next, root.id, options);
  assert.deepEqual(added.library.images, {
    [cover]: image,
    [detail]: next.images![detail],
  });
  assert.deepEqual(added.library.fonts, {
    [heading]: font,
    [caption]: next.fonts![caption],
  });
  assert.deepEqual(
    apply(next, added.operations).libraries![workspace.id],
    added.library,
  );
  for (const [kind, id] of [
    ["images", cover],
    ["fonts", heading],
  ] as const) {
    const invalid = structuredClone(next);
    invalid[kind]![id].data = invalid[kind]![id].data.replace("AA==", "Ag==");
    assert.throws(
      () => promoteSelectionToLibrary(invalid, root.id, options),
      /同一资源 ID 的内容不一致/,
    );
  }
  assert.deepEqual(workspace, first.library);
});

test("a document style renamed after installation can yield its old name to another style without rewriting the live library", () => {
  const parent = createNode("frame"),
    shape = createNode("rectangle", parent.id);
  shape.styleBindings = { paint: "paint-accent" };
  const author = drawing(parent, shape);
  author.designSystem = nativeDesignSystem();
  const doc = parseDocument(author);
  const first = promoteSelectionToLibrary(doc, parent.id, {
    projectId: "shop",
    replaceSelectionWithInstance: true,
  });
  const live = apply(doc, first.operations);
  const before = live.libraries![first.library.id];
  const theme = structuredClone(live.designSystem!);
  const accent = theme.styles["paint-accent"];
  theme.styles["local-accent"] = { ...accent, id: "local-accent" };
  accent.name = "项目品牌色";
  const newcomer = createNode("rectangle");
  newcomer.styleBindings = { paint: "local-accent" };
  const renamed = apply(live, [
    { type: "setDesignSystem", system: theme },
    { type: "create", node: newcomer },
  ]);
  for (const replaceSelectionWithInstance of [false, true]) {
    const promotion = promoteSelectionToLibrary(renamed, newcomer.id, {
      projectId: "shop",
      replaceSelectionWithInstance,
    });
    const after = apply(renamed, promotion.operations);
    assert.deepEqual(
      after.libraries![before.id].components[0],
      before.components[0],
    );
    assert.deepEqual(
      after.libraries![before.id].designSystem!.styles["paint-accent"],
      before.designSystem!.styles["paint-accent"],
    );
    for (const id of Object.keys(theme.styles))
      assert.deepEqual(after.designSystem!.styles[id], theme.styles[id]);
    const oldInstance = after.nodes.find((n) => n.id === first.replacedNodeId)!;
    validateInstanceStructure(after, oldInstance);
    if (replaceSelectionWithInstance)
      validateInstanceStructure(
        after,
        after.nodes.find((n) => n.id === promotion.replacedNodeId)!,
      );
  }
});

test("workspace token conflicts keep root prototype actions connected to the replacement's bound layers on replay", () => {
  const source = createNode("rectangle");
  source.variableBindings = { radius: "radius-md" };
  const author = drawing(source);
  author.designSystem = nativeDesignSystem();
  const first = promoteSelectionToLibrary(parseDocument(author), source.id, {
    projectId: "shop",
  });
  const root = createNode("frame"),
    child = createNode("rectangle", root.id);
  const doc = drawing(root, child);
  doc.designSystem = nativeDesignSystem();
  doc.designSystem.variables["radius-md"].values.comfortable = 25;
  child.variableBindings = { radius: "radius-md" };
  root.interactions = [
    {
      trigger: "hover",
      actions: [{ kind: "set", variable: "radius-md", value: 8 }],
    },
  ];
  const result = promoteSelectionToLibrary(doc, root.id, {
    projectId: "shop",
    existingWorkspaceLibrary: first.library,
    replaceSelectionWithInstance: true,
  });
  const applied = apply(doc, result.operations);
  const instance = applied.nodes.find((n) => n.id === result.replacedNodeId)!;
  const leaf = applied.nodes.find((n) => n.parentId === instance.id)!;
  const action = instance.interactions![0].actions![0];
  assert.ok(action.kind === "set");
  assert.equal(action.variable, leaf.variableBindings?.radius);
  assert.equal(
    applied.designSystem!.variables[action.variable].values.comfortable,
    25,
  );
  validateInstanceStructure(applied, instance);
});

test("stored reserved library IDs and legacy project bindings resolve to the same durable migrated library", async () => {
  const { first } = firstPromotion();
  const rows = new Map<string, Record<string, unknown>>();
  const seed = (id: string, name: string) => {
    const library = { ...first.library, id, name };
    rows.set(id, {
      id,
      name,
      revision: library.revision,
      savedAt: "2026-11-25T12:00:00.000Z",
      sourceKind: "json",
      componentCount: library.components.length,
      variantCount: library.components.reduce(
        (n, c) => n + c.variants.length,
        0,
      ),
      library,
    });
  };
  seed("__proto__", "旧组件库");
  seed("legacy-lib-__proto__", "同名的现有库");
  const req = <T>(result: T) => {
    const value = { result, onsuccess() {} };
    queueMicrotask(() => value.onsuccess());
    return value;
  };
  const project = {
    id: "p",
    name: "项目",
    defaultLibraryId: "__proto__",
    createdAt: "2026-11-25T12:00:00.000Z",
    updatedAt: "2026-11-25T12:00:00.000Z",
  };
  const db = {
    onclose() {},
    transaction() {
      const tx = {
        oncomplete() {},
        onabort() {},
        abort() {},
        objectStore: (name: string) => ({
          get: (key: string) =>
            req(name === "projects" ? project : rows.get(key)),
          getKey: (key: string) => req(rows.has(key) ? key : undefined),
          getAll: () => req([...rows.values()]),
          put: (row: Record<string, unknown>) =>
            rows.set(String(row.id), structuredClone(row)),
        }),
      };
      setImmediate(() => tx.oncomplete());
      return tx;
    },
  };
  const before = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const connections: (typeof db)[] = [];
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        const connection = { ...db };
        connections.push(connection);
        return req(connection);
      },
    },
  });
  try {
    const repo = new IndexedDbProjectMemoryRepository();
    const list = await listWorkspaceLibraries();
    const recovered = await repo.getProject("p");
    const legacy = await getWorkspaceLibraryRecord("__proto__");
    assert.ok(legacy);
    assert.equal(legacy.name, "旧组件库");
    assert.equal(legacy.id, legacy.library.id);
    assert.equal(recovered?.defaultLibraryId, legacy.id);
    assert.deepEqual(await getWorkspaceLibraryRecord(legacy.id), legacy);
    assert.deepEqual(
      list.find((lib) => lib.id === legacy.id),
      legacy,
    );
    assert.equal(
      (await getWorkspaceLibraryRecord("legacy-lib-__proto__"))?.name,
      "同名的现有库",
    );
    assert.ok(!rows.get("__proto__")?.library);
    for (const id of ["__proto__", "constructor", "prototype"]) {
      assert.throws(() => parseLibrary({ ...first.library, id }), /保留键名/);
      await assert.rejects(
        repo.createProject({ name: "新项目", defaultLibraryId: id }),
        /保留键名/,
      );
      await assert.rejects(
        repo.updateProject("p", { defaultLibraryId: id }),
        /保留键名/,
      );
    }
  } finally {
    for (const connection of connections) connection.onclose();
    if (before) Object.defineProperty(globalThis, "indexedDB", before);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});

test("overlapping file and project changes keep publication fenced until both finish", async () => {
  const fileKey = "overlapping-file",
    projectId = "overlapping-project";
  const scope = { fileKey, projectId };
  const library = {
    ...firstPromotion().first.library,
    id: "overlapping-library",
  };
  registerCatalogFileGuard(async (key) => (key === fileKey ? "ok" : "changed"));
  try {
    const initial = await readWorkspaceScopeFence(fileKey, projectId);
    const record = await saveWorkspaceLibraryIfUnchanged(
      library,
      "packaged",
      null,
      { expectedFence: initial },
    );
    const [both, file] = await Promise.all([
      beginWorkspaceScopeFence(scope),
      beginWorkspaceScopeFence({ fileKey }),
    ]);
    assert.notEqual(file, both);
    await assert.rejects(
      readWorkspaceScopeFence(fileKey, projectId),
      /正在变更/,
    );
    await assert.rejects(
      saveWorkspaceLibraryIfUnchanged(library, "packaged", record, {
        expectedFence: initial,
      }),
      /所属项目空间已变更/,
    );
    await endWorkspaceScopeFence(scope, both);
    const internalKey = "__forma_fence__:file:" + fileKey;
    assert.equal(await getWorkspaceLibraryRecord(internalKey), null);
    await deleteWorkspaceLibrary(internalKey);
    const prefixed = await saveWorkspaceLibraryIfUnchanged(
      { ...library, id: internalKey },
      "json",
    );
    assert.deepEqual(await getWorkspaceLibraryRecord(internalKey), prefixed);
    assert.ok(
      (await listWorkspaceLibraries()).some((row) => row.id === internalKey),
    );
    await deleteWorkspaceLibrary(internalKey);
    await assert.rejects(
      readWorkspaceScopeFence(fileKey, projectId),
      /正在变更/,
    );
    await endWorkspaceScopeFence({ fileKey }, file);
    const current = await readWorkspaceScopeFence(fileKey, projectId);
    assert.deepEqual(current, {
      ...scope,
      fileEpoch: initial.fileEpoch + 4,
      projectEpoch: initial.projectEpoch + 2,
    });
    await assert.rejects(
      saveWorkspaceLibraryIfUnchanged(library, "packaged", record, {
        expectedFence: initial,
      }),
      /所属项目空间已变更/,
    );
    assert.deepEqual(await getWorkspaceLibraryRecord(library.id), record);
    const updated = await saveWorkspaceLibraryIfUnchanged(
      library,
      "packaged",
      record,
      { expectedFence: current },
    );
    assert.notEqual(updated.savedAt, record.savedAt);
    assert.equal(
      (await listWorkspaceLibraries()).some((r) =>
        r.id.startsWith("__forma_fence__:"),
      ),
      false,
    );
    await deleteWorkspaceLibrary(library.id);
  } finally {
    registerCatalogFileGuard(checkCatalogFile);
  }
});

async function catalogFixture(fromV1 = true) {
  const url = new URL(
    "../src/infrastructure/library-catalog-store.ts",
    import.meta.url,
  );
  url.searchParams.set("upgrade", crypto.randomUUID());
  const api = (await import(
    url.href
  )) as typeof import("../src/infrastructure/library-catalog-store");
  const id = "__forma_fence__:custom-kit";
  const source = firstPromotion().first.library;
  const library = { ...source, id };
  const record = {
    id,
    library,
    name: library.name,
    revision: library.revision,
    sourceKind: "json",
    savedAt: "2026-11-25T12:00:00.000Z",
    componentCount: library.components.length,
    variantCount: library.components.reduce((n, c) => n + c.variants.length, 0),
  };
  const oldKey = "__forma_fence__:file:upgraded-file";
  const libraries = new Map<string, unknown>([
    [id, structuredClone(record)],
    [
      oldKey,
      { id: oldKey, __formaFence: true, epoch: 7, inFlightOps: ["old-op"] },
    ],
  ]);
  if (!fromV1) libraries.clear();
  const decisions = new Map<string, unknown>();
  decisions.set("upgraded-file", {
    generation: 1,
    current: { id: "doc-a" },
    lifetimeToken: "live",
  });
  const stores = new Map([
    ["libraries", libraries],
    ["documents", decisions],
    ...[
      "files",
      "document-parts",
      "document-assets",
      "assignments",
      "projects",
      "episodes",
      "tombstones",
    ].map((name): [string, Map<string, unknown>] => [name, new Map()]),
  ]);
  if (!fromV1) stores.set("fences", new Map());
  const req = <T>(result: T) => {
    const request = { result, onsuccess() {} };
    queueMicrotask(() => request.onsuccess());
    return request;
  };
  const faults = { abortPublication: false, abortOutcomeRead: false };
  function store(name: string, rows = stores.get(name)!) {
    return {
      get: (id: string) => req(rows.get(id)),
      getKey: (id: string) => req(rows.has(id) ? id : undefined),
      getAll: (range?: { lower: string; upper: string }) =>
        req(
          [...rows]
            .filter(([k]) => !range || (k >= range.lower && k <= range.upper))
            .map(([, row]) => row),
        ),
      index: (index: string) => {
        assert.equal(index, "byScope");
        const matches = (scope: string) =>
          [...rows].filter(
            ([, row]) =>
              (row as { scopeProjectId: string }).scopeProjectId === scope,
          );
        return {
          getAll: (scope: string) => req(matches(scope).map(([, row]) => row)),
          getAllKeys: (scope: string) =>
            req(matches(scope).map(([key]) => key)),
        };
      },
      delete: (id: string) => rows.delete(id),
      put(
        row: { id?: string; fileKey?: string; key?: string },
        explicitKey?: string,
      ) {
        const key = explicitKey ?? row.id ?? row.key ?? row.fileKey;
        assert.ok(key);
        rows.set(key, structuredClone(row));
        return req(key);
      },
      openCursor() {
        const keys = [...rows.keys()];
        const cursor: {
          result?: {
            key: string;
            value: unknown;
            delete(): void;
            continue(): void;
          };
          onsuccess(): void;
        } = { onsuccess() {} };
        const next = () =>
          queueMicrotask(() => {
            const key = keys.shift();
            cursor.result =
              key === undefined
                ? undefined
                : {
                    key,
                    value: rows.get(key),
                    delete: () => {
                      rows.delete(key);
                    },
                    continue: next,
                  };
            cursor.onsuccess();
          });
        next();
        return cursor;
      },
    };
  }
  const db = {
    onclose() {},
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore(name: string, options: { keyPath: string }) {
      assert.equal(name, "fences");
      assert.equal(options.keyPath, "id");
      stores.set(name, new Map());
      return store(name);
    },
    transaction(names: string | string[], mode?: string) {
      const included = Array.isArray(names) ? names : [names];
      const staged = new Map(
        included.map((name) => [name, new Map(stores.get(name))]),
      );
      let aborted =
        faults.abortOutcomeRead && names === "fences" && mode !== "readwrite";
      const tx = {
        abort() {
          aborted = true;
        },
        error: new Error("commit failed"),
        onabort() {},
        oncomplete() {},
        objectStore(name: string) {
          assert.ok(included.includes(name));
          const table = store(name, staged.get(name));
          return {
            ...table,
            put(row: { id?: string; commitId?: string }, key?: string) {
              if (
                name === "libraries" &&
                row.commitId &&
                faults.abortPublication
              )
                aborted = true;
              return table.put(row, key);
            },
          };
        },
      };
      setImmediate(() => {
        if (aborted) return tx.onabort();
        if (mode === "readwrite")
          for (const [name, values] of staged) {
            const rows = stores.get(name)!;
            rows.clear();
            for (const [id, row] of values) rows.set(id, row);
          }
        tx.oncomplete();
      });
      return tx;
    },
  };
  const connections: (typeof db)[] = [];
  const beforeRange = Object.getOwnPropertyDescriptor(
    globalThis,
    "IDBKeyRange",
  );
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: { bound: (lower: string, upper: string) => ({ lower, upper }) },
  });
  const before = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open(name: string, version: number) {
        const connection = { ...db };
        connections.push(connection);
        if (name === "forma-studio" || name === "forma-project-memory-v1")
          return req(connection);
        assert.equal(name, "forma-workspace-libraries-v1");
        assert.equal(version, 2);
        const request = {
          result: connection,
          transaction: { objectStore: store },
          onupgradeneeded(_event: { oldVersion: number }) {},
          onsuccess() {},
        };
        if (!stores.has("fences"))
          queueMicrotask(() => request.onupgradeneeded({ oldVersion: 1 }));
        setImmediate(() => request.onsuccess());
        return request;
      },
    },
  });
  return {
    api,
    id,
    record,
    stores,
    libraries,
    decisions,
    faults,
    restore() {
      for (const connection of connections) connection.onclose();
      if (before) Object.defineProperty(globalThis, "indexedDB", before);
      else Reflect.deleteProperty(globalThis, "indexedDB");
      if (beforeRange)
        Object.defineProperty(globalThis, "IDBKeyRange", beforeRange);
      else Reflect.deleteProperty(globalThis, "IDBKeyRange");
    },
  };
}

test("v1 upgrade preserves a prefixed workspace library byte for byte and moves only old fence metadata", async () => {
  const { api, id, record, stores, libraries, restore } =
    await catalogFixture();
  const {
    registerCatalogFileGuard,
    readWorkspaceScopeFence,
    beginWorkspaceScopeFence,
    endWorkspaceScopeFence,
    listWorkspaceLibraries,
    getWorkspaceLibraryRecord,
  } = api;
  try {
    registerCatalogFileGuard(async (key) =>
      key === "upgraded-file" ? "ok" : "changed",
    );
    const fence = await readWorkspaceScopeFence("upgraded-file");
    assert.equal(fence.fileEpoch, 8);
    const active = await beginWorkspaceScopeFence({ fileKey: "upgraded-file" });
    try {
      await assert.rejects(
        readWorkspaceScopeFence("upgraded-file"),
        /正在变更/,
      );
      assert.deepEqual(await getWorkspaceLibraryRecord(id), record);
      assert.deepEqual(
        (await listWorkspaceLibraries()).find((row) => row.id === id),
        record,
      );
      assert.deepEqual([...libraries], [[id, record]]);
      assert.deepEqual(
        [...stores.get("fences")!.keys()],
        ["file:upgraded-file"],
      );
    } finally {
      await endWorkspaceScopeFence({ fileKey: "upgraded-file" }, active);
    }
  } finally {
    restore();
  }
});

test("catalog reconciliation materializes only an authorized stage with the captured CAS and both current scope epochs", async () => {
  const { api, record, stores, libraries, decisions, restore } =
    await catalogFixture();
  try {
    api.registerCatalogFileGuard(async () => "ok");
    const fence = await api.readWorkspaceScopeFence(
      "upgraded-file",
      "team",
      "doc-a",
    );
    const stages = stores.get("fences")!;
    const seed = (
      name: string,
      options: {
        authorized?: boolean;
        keepOutcome?: boolean;
        age?: number;
        fileEpoch?: number;
        projectEpoch?: number;
        savedAt?: string;
      } = {},
    ) => {
      const commitId = "cat-" + name;
      const id = "__staged_lib__:" + commitId;
      const existing = {
        ...record,
        id: name,
        library: { ...record.library, id: name },
      };
      if (options.savedAt) libraries.set(name, existing);
      if (options.authorized)
        decisions.set("__forma_internal_commit__:" + commitId, {
          commitId,
          authorizedAt: Date.now(),
        });
      stages.set(id, {
        id,
        __stagedLib: true,
        commitId,
        record: existing,
        expectedRevision: options.savedAt ? existing.revision : null,
        expectedSavedAt: options.savedAt ?? null,
        expectedFence: {
          ...fence,
          fileEpoch: options.fileEpoch ?? fence.fileEpoch,
          projectEpoch: options.projectEpoch ?? fence.projectEpoch,
        },
        createdAt: Date.now() - (options.age ?? 0),
        keepOutcome: options.keepOutcome,
      });
      return id;
    };
    const ready = seed("ready", { authorized: true });
    const tracked = seed("tracked", { authorized: true, keepOutcome: true });
    assert.equal(await api.hasAppliedCatalogCommit("cat-tracked"), true);
    assert.equal(stages.has(tracked), false);
    assert.equal(libraries.has("tracked"), true);
    await api.acknowledgeCatalogCommit("cat-tracked");
    const expired = seed("expired", { age: 61_000 });
    const preparing = seed("preparing");
    const conflict = seed("conflict", {
      authorized: true,
      savedAt: "2020-01-01T00:00:00.000Z",
    });
    const moved = seed("moved", {
      authorized: true,
      fileEpoch: fence.fileEpoch + 1,
    });
    const deleted = seed("deleted", {
      authorized: true,
      projectEpoch: fence.projectEpoch + 1,
    });
    const original = structuredClone(libraries.get("conflict"));
    const visible = await api.listWorkspaceLibraries();
    assert.equal(stages.has("__applied_cat__:cat-ready"), false);
    assert.ok(visible.some((row) => row.id === "ready"));
    assert.deepEqual(libraries.get("conflict"), original);
    for (const id of [ready, expired, conflict, moved, deleted])
      assert.equal(stages.has(id), false, id);
    assert.ok(stages.has(preparing));
    for (const id of ["expired", "preparing", "moved", "deleted"])
      assert.equal(await api.getWorkspaceLibraryRecord(id), null);
  } finally {
    restore();
  }
});

test("a retry after the final catalog transaction aborts uses its original commit ID and appends the component once", async () => {
  const { api, stores, decisions, faults, libraries, restore } =
    await catalogFixture();
  try {
    api.registerCatalogFileGuard(checkCatalogFile);
    const fence = await api.readWorkspaceScopeFence(
      "upgraded-file",
      null,
      "doc-a",
      1,
    );
    const commitId = crypto.randomUUID();
    const { first, doc, root } = firstPromotion("Old board");
    const library = first.library;
    assert.equal(library.revision, 1);
    assert.equal(library.components.length, 1);
    const options = { expectedFence: fence, commitId };
    faults.abortPublication = true;
    await assert.rejects(
      api.saveWorkspaceLibraryIfUnchanged(library, "packaged", null, options),
      /commit failed/,
    );
    assert.ok(decisions.has("__forma_internal_commit__:" + commitId));
    assert.ok(stores.get("fences")!.has("__staged_lib__:" + commitId));
    assert.equal(libraries.has(library.id), false);
    faults.abortPublication = false;
    const published = await api.saveWorkspaceLibraryIfUnchanged(
      library,
      "packaged",
      null,
      options,
    );
    assert.equal(decisions.has("__forma_internal_commit__:" + commitId), false);
    assert.equal(
      stores.get("fences")!.has("__staged_lib__:" + commitId),
      false,
    );
    const repeated = promoteSelectionToLibrary(doc, root.id, {
      projectId: "shop",
      existingWorkspaceLibrary: published.library,
    }).library;
    assert.equal(repeated.components.length, 2);
    assert.deepEqual(
      await api.saveWorkspaceLibraryIfUnchanged(
        repeated,
        "packaged",
        published,
        options,
      ),
      published,
    );
    const durable = await api.getWorkspaceLibraryRecord(library.id);
    assert.equal(durable?.revision, 1);
    assert.equal(durable?.componentCount, 1);
    assert.deepEqual(durable?.library, library);
  } finally {
    restore();
  }
});

async function loadEditorViews() {
  // Provide Vite's base URL and CSS handling when these views run under node:test.
  const hooks = registerHooks({
    load(url, context, next) {
      if (url.endsWith(".css"))
        return { format: "module", source: "", shortCircuit: true };
      const result = next(url, context);
      if (new URL(url).pathname.endsWith("/PagesPanel.tsx")) {
        const source =
          typeof result.source === "string"
            ? result.source
            : Buffer.from(result.source as Uint8Array).toString();
        return {
          ...result,
          source: 'import.meta.env = { BASE_URL: "/" };\n' + source,
        };
      }
      return result;
    },
  });
  try {
    const { PagesPanel } = await import("../src/editor/PagesPanel");
    const { AgentPanel, readFileProjectEpisodes } =
      await import("../src/editor/AgentPanel");
    return { PagesPanel, AgentPanel, readFileProjectEpisodes };
  } finally {
    hooks.deregister();
  }
}

function editorTestHost() {
  const doc = new DOMParser().parseFromString("<html/>", "text/html");
  const create = doc.createElement.bind(doc);
  const createNS = doc.createElementNS.bind(doc);
  const noop = () => {};
  const element = (el: Element) => {
    Object.assign(el, {
      style: { setProperty: noop },
      focus: noop,
      scrollIntoView: noop,
      querySelectorAll: () => [],
      addEventListener: noop,
      removeEventListener: noop,
    });
    if (el.tagName === "select")
      Object.defineProperty(el, "options", {
        get: () => el.getElementsByTagName("option"),
      });
    if (el.tagName === "option")
      Object.defineProperty(el, "value", {
        get: () => el.getAttribute("value"),
      });
    return el;
  };
  Object.assign(doc, {
    createElement: (tag: string) => element(create(tag)),
    createElementNS: (ns: string, tag: string) => element(createNS(ns, tag)),
    addEventListener: noop,
    removeEventListener: noop,
  });
  const host = doc.createElement("div");
  const events = new EventTarget();
  host.addEventListener = events.addEventListener.bind(events);
  const before = Object.getOwnPropertyDescriptors(globalThis);
  // xmldom supplies the tree. Reflect the mounted controls into the form data
  // React's submit handler would receive from a browser.
  class MountedFormData extends FormData {
    constructor(form: HTMLFormElement) {
      super();
      for (const tag of ["input", "select", "textarea"]) {
        for (const field of Array.from(
          form.getElementsByTagName(tag),
        ) as HTMLInputElement[]) {
          const name = field.name || field.getAttribute("name");
          if (!name || (field.type === "checkbox" && !field.checked)) continue;
          const value =
            tag === "select"
              ? Array.from(
                  (field as unknown as HTMLSelectElement).options,
                ).find((o) => o.selected)?.value
              : (field.value ?? field.defaultValue);
          this.append(name, value ?? "");
        }
      }
    }
  }
  const globals = {
    document: doc,
    window: Object.assign(new EventTarget(), {
      document: doc,
      HTMLIFrameElement: class {},
      setTimeout,
      clearTimeout,
    }),
    FormData: MountedFormData,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  Object.assign(globalThis, globals);
  const root = createRoot(host);
  return {
    host,
    root,
    async dispatch(target: Element, type: string) {
      assert.ok(target, "missing target for " + type);
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      await act(() => {
        events.dispatchEvent(event);
      });
    },
    async restore() {
      await act(() => root.unmount());
      for (const key of Object.keys(globals)) {
        if (before[key]) Object.defineProperty(globalThis, key, before[key]);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

async function settleEditor(condition: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline)
    await act(() => new Promise<void>((resolve) => setImmediate(resolve)));
  assert.ok(condition(), message);
}

test("reopening the mobile example from Pages invalidates a peer's mounted promotion and archive session", async () => {
  const { PagesPanel, readFileProjectEpisodes } = await loadEditorViews();
  const database = await catalogFixture(false);
  const ui = editorTestHost();
  const beforeFetch = globalThis.fetch;
  try {
    const fileKey = "pages-mobile";
    const exampleBoard = createNode("frame");
    const example = parseDocument({
      ...drawing(exampleBoard),
      activePage: "mobile",
      pages: [
        { id: "mobile", name: "移动设计" },
        { id: "tablet", name: "平板设计", nodes: [createNode("frame")] },
      ],
    });
    let fetches = 0;
    globalThis.fetch = async (url) => {
      assert.equal(url, "/examples/mobile-studio.forma.json");
      fetches++;
      return Response.json(example);
    };
    const old = new BrowserDocumentRepository(fileKey);
    const added = createNode("frame");
    added.name = "临时画板";
    await old.save(example);
    await old.save(apply(example, [{ type: "create", node: added }]));
    const writer = new BrowserDocumentRepository(fileKey);
    const oldDoc = (await old.load())!,
      writerDoc = (await writer.load())!;
    let first!: EditorController,
      second!: EditorController,
      operations = 0,
      invalidated = "";
    function Editors() {
      first = useEditor({
        repository: old,
        initialDocument: oldDoc,
        initialSelection: [added.id],
      });
      second = useEditor({ repository: writer, initialDocument: writerDoc });
      return createElement(
        Fragment,
        null,
        createElement(PromoteModuleModal, {
          editor: {
            ...first,
            apply(ops, rev) {
              operations += ops.length;
              first.apply(ops, rev);
            },
          },
          fileKey,
          onFileLifetimeInvalidated: (msg) => {
            invalidated = msg ?? "invalidated";
          },
          close() {},
        }),
        createElement(PagesPanel, { editor: second }),
      );
    }
    await act(() => ui.root.render(createElement(Editors)));
    await settleEditor(
      () => !!ui.host.getElementsByTagName("form").length,
      "promotion form should capture the original board",
    );
    const identity = {
      expectedDocId: first.committed.id,
      expectedLifetimeToken: await first.getLifetimeToken(),
      expectedDocumentEpoch: await first.getDocumentEpoch(),
    };
    assert.ok(identity.expectedLifetimeToken);
    assert.equal(identity.expectedDocumentEpoch, 1);
    assert.equal(await second.getDocumentEpoch(), 1);
    const button = Array.from(ui.host.getElementsByTagName("button")).find(
      (b) => b.getAttribute("aria-label") === "打开移动设计样例",
    );
    assert.ok(button);
    await ui.dispatch(button, "click");
    await settleEditor(
      () =>
        second.saved && !second.committed.nodes.some((n) => n.id === added.id),
      "Pages replacement should save",
    );
    assert.equal(fetches, 1);
    assert.equal(await second.getDocumentEpoch(), 2);
    assert.equal((await readLiveFileState(fileKey))?.documentEpoch, 2);
    const reopened = new BrowserDocumentRepository(fileKey);
    assert.deepEqual((await reopened.load())?.nodes, example.nodes);
    assert.equal(reopened.getDocumentEpoch(), 2);
    assert.equal(
      await first.getDocumentEpoch(),
      1,
      "the peer must retain its captured session",
    );
    assert.equal(second.canUndo, true);

    await ui.dispatch(ui.host.getElementsByTagName("form")[0], "submit");
    await settleEditor(
      () => !!invalidated,
      "stale promotion should invalidate the session",
    );
    assert.equal(operations, 0);
    assert.deepEqual(await listWorkspaceLibraries(), []);
    const scope = fileScopeId(fileKey);
    const capture = (editor: EditorController, id: string) =>
      buildManualEpisodeFromSelection({
        document: editor.committed,
        selectionIds: [id],
        sourceFileKey: fileKey,
        scopeProjectId: scope,
        sourceDocumentEpoch: editor.getCurrentDocumentEpoch(),
        sourceLifetimeToken: editor.getCurrentLifetimeToken(),
      });
    await assert.rejects(
      saveDesignEpisodeWithReceipt(capture(first, added.id)),
      (err: unknown) =>
        err instanceof Error && err.constructor.name === "StaleFileError",
    );
    const receipt = await saveDesignEpisodeWithReceipt(
      capture(second, exampleBoard.id),
    );
    assert.equal(receipt.durable, true);
    await assert.rejects(
      readFileProjectEpisodes(fileKey, identity, () => true),
      FileLifetimeMismatchError,
    );
    await assert.rejects(
      deleteDesignEpisode(receipt.episode.id, {
        ...identity,
        expectedScopeId: scope,
        sourceFileKey: fileKey,
        requireBoundLifetime: true,
      }),
      FileLifetimeMismatchError,
    );
    assert.deepEqual(await listScopeEpisodes(scope), [receipt.episode]);
    assert.deepEqual((await old.load())?.nodes, example.nodes);
    assert.equal(old.getDocumentEpoch(), 2);

    await act(() => second.recoverPrevious());
    await settleEditor(
      () =>
        second.saved && second.committed.nodes.some((n) => n.id === added.id),
      "restoring the prior snapshot should save",
    );
    assert.equal((await readLiveFileState(fileKey))?.documentEpoch, 3);
    const peerAtRecovery = new BrowserDocumentRepository(fileKey);
    const recovered = (await peerAtRecovery.load())!;
    assert.equal(peerAtRecovery.getDocumentEpoch(), 3);
    await act(() => second.undo());
    await settleEditor(
      () =>
        second.saved && !second.committed.nodes.some((n) => n.id === added.id),
      "recovery should undo in one step",
    );
    assert.equal((await readLiveFileState(fileKey))?.documentEpoch, 4);
    const staleCapture = buildManualEpisodeFromSelection({
      document: recovered,
      selectionIds: [added.id],
      sourceFileKey: fileKey,
      scopeProjectId: scope,
      sourceDocumentEpoch: peerAtRecovery.getDocumentEpoch(),
      sourceLifetimeToken: peerAtRecovery.getLifetimeToken(),
    });
    await assert.rejects(
      saveDesignEpisodeWithReceipt(staleCapture),
      (err: unknown) =>
        err instanceof Error && err.constructor.name === "StaleFileError",
    );
    assert.deepEqual(
      await new IndexedDbProjectMemoryRepository().listEpisodes(scope),
      [receipt.episode],
    );
    await act(() => second.redo());
    await settleEditor(
      () =>
        second.saved && second.committed.nodes.some((n) => n.id === added.id),
      "redo should restore the recovered document",
    );
    assert.equal((await readLiveFileState(fileKey))?.documentEpoch, 5);

    await act(() =>
      second.apply([
        { type: "update", id: added.id, patch: { name: "Edited" } },
      ]),
    );
    await settleEditor(() => second.saved, "the edit should save");
    await act(() => second.undo());
    await settleEditor(() => second.saved, "the edit should undo");
    assert.equal(
      second.committed.nodes.find((n) => n.id === added.id)?.name,
      added.name,
    );
    assert.equal(second.getCurrentDocumentEpoch(), 5);
    await act(() => second.redo());
    await settleEditor(() => second.saved, "the edit should redo");
    assert.equal(
      second.committed.nodes.find((n) => n.id === added.id)?.name,
      "Edited",
    );
    assert.equal((await readLiveFileState(fileKey))?.documentEpoch, 5);
  } finally {
    globalThis.fetch = beforeFetch;
    await ui.restore();
    database.restore();
  }
});

test("failed Undo of a same-ID import cannot archive the displayed board under the peer's saved epoch", async () => {
  const { AgentPanel } = await loadEditorViews();
  const database = await catalogFixture(false);
  const ui = editorTestHost();
  try {
    const file = new BrowserDocumentRepository("undo-conflict");
    const a = drawing(createNode("frame"));
    const b = drawing(createNode("frame"));
    assert.equal(a.id, b.id);
    await file.save(a);
    let editor!: EditorController;
    const episodes: [] = [];
    function Editor() {
      editor = useEditor({ repository: file, initialDocument: a });
      return createElement(AgentPanel, {
        document: editor.committed,
        fileKey: file.key,
        getFileLifetimeToken: editor.getLifetimeToken,
        getFileDocumentEpoch: editor.getDocumentEpoch,
        selection: null,
        selectionCount: 0,
        activeProject: null,
        projectEpisodes: episodes,
        status: {
          configured: false,
          activeProfile: null,
          activeProfileId: null,
          profiles: [],
        },
      });
    }
    await act(() => ui.root.render(createElement(Editor)));
    await act(() => editor.importDocument(b, { replacedDocument: true }));
    await settleEditor(() => editor.saved, "same-ID replacement should save");
    assert.equal(await editor.getDocumentEpoch(), 2);
    assert.equal((await readLiveFileState(file.key))?.generation, 2);
    const peer = new BrowserDocumentRepository(file.key);
    const peerDoc = apply((await peer.load())!, [
      { type: "update", id: b.nodes[0].id, patch: { name: "Peer edit on B" } },
    ]);
    await peer.save(peerDoc);
    assert.equal((await readLiveFileState(file.key))?.generation, 3);
    assert.equal(peer.getDocumentEpoch(), 2);

    await act(() => editor.undo());
    await settleEditor(
      () => editor.error.includes("另一个标签页更新"),
      "Undo save must conflict",
    );
    assert.equal(editor.committed.nodes[0].id, a.nodes[0].id);
    assert.equal(file.getDocumentEpoch(), 2);
    await assert.rejects(editor.getDocumentEpoch(), FileLifetimeMismatchError);
    assert.equal(editor.getCurrentDocumentEpoch(), undefined);

    for (const label of ["历史需求档案", "归档当前画板"]) {
      const button = Array.from(ui.host.getElementsByTagName("button")).find(
        (el) => el.getAttribute("aria-label") === label,
      );
      assert.ok(button && !button.hasAttribute("disabled"), label);
      await ui.dispatch(button, "click");
    }
    await settleEditor(
      () => !!ui.host.textContent?.includes("请重新打开文件以恢复项目记忆"),
      "drawer must reject the archive",
    );
    const archives = new IndexedDbProjectMemoryRepository();
    assert.deepEqual(
      await archives.listEpisodes(fileScopeId(file.key), {
        requireDurable: true,
      }),
      [],
    );
    const reopened = new BrowserDocumentRepository(file.key);
    assert.deepEqual((await reopened.load())?.nodes, peerDoc.nodes);
    assert.equal(reopened.getDocumentEpoch(), 2);
  } finally {
    await ui.restore();
    database.restore();
  }
});

test("an ordinary same-branch autosave failure retains the editor's saved epoch", async () => {
  const ui = editorTestHost();
  try {
    const board = createNode("frame");
    const doc = drawing(board);
    const repository = {
      load: async () => doc,
      recovery: async () => null,
      backup: async () => null,
      getDocumentEpoch: () => 1,
      save: async () => {
        throw new Error("Offline");
      },
    };
    let editor!: EditorController;
    function Editor() {
      editor = useEditor({ initialDocument: doc, repository });
      return null;
    }
    await act(() => ui.root.render(createElement(Editor)));
    await act(() =>
      editor.apply([
        { type: "update", id: board.id, patch: { name: "Offline edit" } },
      ]),
    );
    await settleEditor(
      () => editor.error === "Offline",
      "ordinary autosave should fail",
    );
    assert.equal(editor.getCurrentDocumentEpoch(), 1);
    assert.equal(await editor.getDocumentEpoch(), 1);
  } finally {
    await ui.restore();
  }
});

for (const entry of ["recoverPrevious", "repository.save"] as const) {
  test(`failed-load recovery through ${entry} fences an epoch-1 peer from archiving or deleting`, async () => {
    const database = await catalogFixture(false);
    const ui = editorTestHost();
    try {
      const key = "failed-load-" + entry;
      const peer = new BrowserDocumentRepository(key);
      const restoredBoard = createNode("frame"),
        removedBoard = createNode("frame");
      await peer.save(drawing(restoredBoard));
      await peer.save(drawing(restoredBoard, removedBoard));
      const oldDoc = (await peer.load())!;
      assert.equal(peer.getDocumentEpoch(), 1);
      const scope = fileScopeId(key);
      const capture = (
        file: BrowserDocumentRepository,
        document: DesignDocument,
        id: string,
      ) =>
        buildManualEpisodeFromSelection({
          document,
          selectionIds: [id],
          scopeProjectId: scope,
          sourceFileKey: key,
          sourceDocumentEpoch: file.getDocumentEpoch(),
          sourceLifetimeToken: file.getLifetimeToken(),
        });
      const file = new BrowserDocumentRepository(key);
      const record = database.decisions.get(key) as { current: DesignDocument };
      database.decisions.set(key, {
        ...record,
        current: { ...oldDoc, nodes: null },
      });
      await assert.rejects(file.load());
      const beforeFence = await readWorkspaceScopeFence(
        key,
        undefined,
        oldDoc.id,
      );
      if (entry === "recoverPrevious") {
        let editor!: EditorController;
        function Editor() {
          editor = useEditor({
            repository: file,
            loadError: "Damaged snapshot",
          });
          return null;
        }
        await act(() => ui.root.render(createElement(Editor)));
        assert.equal(editor.protectCache, true);
        await act(() => editor.recoverPrevious());
        assert.equal(editor.protectCache, false);
        assert.equal(editor.saved, true);
        assert.equal(editor.canUndo, false);
      } else {
        const previous = (await file.recovery())!;
        await file.save(previous);
      }
      const fresh = new BrowserDocumentRepository(key);
      const restored = (await fresh.load())!;
      assert.deepEqual(
        restored.nodes.map((n) => n.id),
        [restoredBoard.id],
      );
      assert.equal(fresh.getDocumentEpoch(), 2);
      assert.equal(fresh.getLifetimeToken(), peer.getLifetimeToken());
      const afterFence = await readWorkspaceScopeFence(
        key,
        undefined,
        restored.id,
      );
      assert.ok(afterFence.fileEpoch > beforeFence.fileEpoch);
      await assert.rejects(
        saveDesignEpisodeWithReceipt(capture(peer, oldDoc, removedBoard.id)),
        (err: unknown) =>
          err instanceof Error && err.constructor.name === "StaleFileError",
      );
      const receipt = await saveDesignEpisodeWithReceipt(
        capture(fresh, restored, restoredBoard.id),
      );
      assert.equal(receipt.durable, true);
      await assert.rejects(
        deleteDesignEpisode(receipt.episode.id, {
          sourceFileKey: key,
          expectedScopeId: scope,
          expectedDocId: oldDoc.id,
          expectedDocumentEpoch: peer.getDocumentEpoch(),
          expectedLifetimeToken: peer.getLifetimeToken(),
        }),
        FileLifetimeMismatchError,
      );
      assert.deepEqual(
        await new IndexedDbProjectMemoryRepository().listEpisodes(scope),
        [receipt.episode],
      );
    } finally {
      await ui.restore();
      database.restore();
    }
  });
}

test("a mounted promotion survives peer finalization and 40 unrelated publications until its origin acknowledges success", async () => {
  const database = await catalogFixture(false);
  const ui = editorTestHost();
  try {
    const fileKey = "promotion-retention",
      board = createNode("frame");
    const doc = drawing(board);
    const repository = new BrowserDocumentRepository(fileKey);
    await repository.save(doc);
    const { createProjectSpace, assignFileToProject } =
      await import("../src/infrastructure/project-memory-store");
    const project = await createProjectSpace({ name: "模块项目" });
    await assignFileToProject(fileKey, project.id);
    const target = projectDerivedLibraryId(project.id);
    let applications = 0,
      closed = false;
    let controller!: EditorController;
    function Editor() {
      controller = useEditor({
        repository,
        initialDocument: doc,
        initialSelection: [board.id],
      });
      return createElement(PromoteModuleModal, {
        editor: {
          ...controller,
          apply(ops, rev) {
            applications++;
            controller.apply(ops, rev);
          },
        },
        fileKey,
        activeProject: project,
        close() {
          closed = true;
        },
      });
    }
    await act(() => ui.root.render(createElement(Editor)));
    await settleEditor(
      () => !!ui.host.getElementsByTagName("form").length,
      "promotion form should open",
    );
    const form = ui.host.getElementsByTagName("form")[0];
    database.faults.abortPublication = true;
    await ui.dispatch(form, "submit");
    await settleEditor(
      () =>
        Array.from(form.getElementsByTagName("p")).some(
          (p) => p.getAttribute("role") === "alert",
        ),
      "origin should observe the final transaction abort",
    );
    assert.match(form.textContent ?? "", /commit failed/);
    assert.equal(applications, 0);
    const fences = database.stores.get("fences")!;
    const stage = [...fences.values()].find(
      (row) => (row as { __stagedLib?: boolean }).__stagedLib,
    ) as { commitId: string };
    assert.ok(stage);
    assert.ok(
      database.decisions.has("__forma_internal_commit__:" + stage.commitId),
    );
    assert.equal(database.libraries.has(target), false);
    database.faults.abortPublication = false;
    const peer = database.api;
    const published = await peer.getWorkspaceLibraryRecord(target);
    assert.ok(published);
    assert.equal(published.revision, 1);
    assert.equal(published.componentCount, 1);
    const outcomeKey = "__applied_cat__:" + stage.commitId;
    assert.deepEqual(fences.get(outcomeKey), {
      id: outcomeKey,
      commitId: stage.commitId,
      libraryId: target,
      revision: 1,
      savedAt: published.savedAt,
      sourceKind: "packaged",
    });
    for (let i = 0; i < 40; i++) {
      await peer.saveWorkspaceLibraryIfUnchanged(
        { ...published.library, id: "unrelated-" + i },
        "json",
        null,
        { commitId: "unrelated-commit-" + i },
      );
    }
    assert.equal(await peer.hasAppliedCatalogCommit(stage.commitId), true);
    assert.equal(ui.host.getElementsByTagName("form")[0], form);
    await ui.dispatch(form, "submit");
    await settleEditor(
      () => closed && controller.saved,
      "unchanged retry should apply and save the canvas",
    );
    assert.equal(applications, 1);
    assert.deepEqual(
      controller.committed.libraries?.[target],
      published.library,
    );
    assert.deepEqual(await peer.getWorkspaceLibraryRecord(target), published);
    await settleEditor(
      () => !fences.has(outcomeKey),
      "origin should acknowledge its catalog outcome",
    );
    assert.equal(await peer.hasAppliedCatalogCommit(stage.commitId), false);
  } finally {
    await ui.restore();
    database.restore();
  }
});

for (const mode of ["IndexedDB", "session"] as const) {
  test(
    mode +
      " retry returns the original publication after the target changes and after deletion",
    async () => {
      const database =
        mode === "IndexedDB" ? await catalogFixture(false) : undefined;
      const api =
        database?.api ??
        (await import("../src/infrastructure/library-catalog-store"));
      try {
        const { first } = firstPromotion();
        const id = "original-" + mode,
          commitId = "origin-" + mode;
        const library = { ...first.library, id };
        const origin = await api.saveWorkspaceLibraryIfUnchanged(
          library,
          "packaged",
          null,
          { commitId },
        );
        let latest = origin;
        for (let i = 1; i <= 40; i++) {
          latest = await api.saveWorkspaceLibraryIfUnchanged(
            {
              ...library,
              revision: origin.revision + i,
              name: "Edited " + i,
            },
            "json",
            latest,
            { commitId: commitId + "-" + i },
          );
        }
        const retry = () =>
          api.saveWorkspaceLibraryIfUnchanged(library, "json", null, {
            commitId,
          });
        assert.deepEqual(await retry(), origin);
        assert.deepEqual(await api.getWorkspaceLibraryRecord(id), latest);
        await api.deleteWorkspaceLibrary(id);
        assert.equal(await api.hasAppliedCatalogCommit(commitId), true);
        assert.deepEqual(await retry(), origin);
        assert.equal(await api.getWorkspaceLibraryRecord(id), null);
        await api.acknowledgeCatalogCommit(commitId);
        assert.equal(await api.hasAppliedCatalogCommit(commitId), false);
        for (let i = 1; i <= 40; i++)
          await api.acknowledgeCatalogCommit(commitId + "-" + i);
      } finally {
        database?.restore();
      }
    },
  );
}

test("legacy catalog outcomes survive a failed status read and remain readable until acknowledged", async () => {
  const { api, stores, faults, restore } = await catalogFixture(false);
  try {
    const origin = await api.saveWorkspaceLibraryIfUnchanged(
      firstPromotion().first.library,
      "json",
    );
    const fences = stores.get("fences")!;
    assert.equal(fences.size, 0);
    const commitId = "legacy-outcome",
      id = "__applied_cat__:" + commitId;
    fences.set(id, { id, record: origin });
    faults.abortOutcomeRead = true;
    await assert.rejects(
      api.hasAppliedCatalogCommit(commitId),
      (err: unknown) =>
        err instanceof Error &&
        err.constructor.name === "LibraryStageUnavailable",
    );
    faults.abortOutcomeRead = false;
    assert.equal(await api.hasAppliedCatalogCommit(commitId), true);
    assert.deepEqual(
      await api.saveWorkspaceLibraryIfUnchanged(
        origin.library,
        "packaged",
        null,
        { commitId },
      ),
      origin,
    );
    await api.acknowledgeCatalogCommit(commitId);
    assert.equal(fences.size, 0);
  } finally {
    restore();
  }
});
