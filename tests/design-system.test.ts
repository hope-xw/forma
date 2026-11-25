import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import {
  createNode,
  parseDocument,
  type DesignDocument,
} from "../src/domain/document";
import { createStarter } from "../src/domain/seed";
import { transact, type Operation } from "../src/domain/commands";
import { nativeDesignSystem } from "../src/design-system/tokens";
import {
  effectiveModes,
  resolveVariable,
  resolveNode,
  parseDesignSystem,
} from "../src/domain/design-system";
import {
  bindVariable,
  detachVariable,
  applyReusableStyle,
  detachReusableStyle,
  captureStyle,
  migrateLegacyTokens,
} from "../src/domain/design-system-actions";
import { copySelection, pasteSelection } from "../src/domain/clipboard";
import { layoutBounds } from "../src/domain/geometry";
import { commit, travel } from "../src/application/history";
import { currentTextShape, textShapeStyleKey } from "../src/domain/text-shape";
import { symbolicNodeCss } from "../src/compiler/design-tokens";
import { nodeCss } from "../src/compiler/react";
import {
  runtimeNodes,
  reactProjectFiles,
  pageForExport,
} from "../src/compiler/runtime";
import {
  instantiateComponent,
  switchInstance,
  createLibraryFromSelection,
} from "../src/domain/library";
import { mobileComponentLibrary } from "../src/design-system/mobile";
import { validateProposal } from "../src/agent/provider";
import {
  hexToHsv,
  hsvToHex,
  parseColorInput,
  hexToHsl,
} from "../src/domain/color";
const apply = (doc: DesignDocument, operations: Operation[]) =>
  transact(doc, { baseRevision: doc.revision, operations });
function fixture() {
  const root = createNode("frame"),
    text = createNode("text", root.id);
  root.style.layout = "column";
  root.style.padding = 16;
  text.style.width = 200;
  const doc: DesignDocument = {
    ...createStarter(),
    nodes: [root, text],
    designSystem: nativeDesignSystem(),
  };
  return { doc: parseDocument(doc), root, text };
}
test("native system has typed collections, modes and alias-backed composite styles", () => {
  const { doc } = fixture();
  assert.equal(Object.keys(doc.designSystem!.variables).length, 40);
  assert.equal(Object.keys(doc.designSystem!.styles).length, 8);
  assert.equal(
    resolveVariable(doc.designSystem!, "color-surface", { semantic: "dark" }),
    "#202734",
  );
  assert.deepEqual(
    parseDesignSystem(JSON.parse(JSON.stringify(doc.designSystem))),
    doc.designSystem,
  );
});
test("invalid aliases, missing modes, cycles and duplicate names fail atomically", () => {
  const { doc } = fixture();
  for (const mutate of [
    (s: NonNullable<DesignDocument["designSystem"]>) => {
      s.variables["color-surface"].values.light = { alias: "missing" };
    },
    (s: NonNullable<DesignDocument["designSystem"]>) => {
      delete s.variables["color-surface"].values.dark;
    },
    (s: NonNullable<DesignDocument["designSystem"]>) => {
      s.variables["palette-light-surface"].values.base = {
        alias: "color-surface",
      };
    },
    (s: NonNullable<DesignDocument["designSystem"]>) => {
      s.variables["color-accent"].name = s.variables["color-surface"].name;
    },
  ]) {
    const system = structuredClone(doc.designSystem!);
    mutate(system);
    assert.throws(() => apply(doc, [{ type: "setDesignSystem", system }]));
  }
  assert.equal(doc.revision, 0);
});
test("inherited modes resolve down frames and local mode overrides take precedence", () => {
  const { doc, root, text } = fixture();
  const next = apply(doc, [
    bindVariable(text, "color", "color-text"),
    {
      type: "update",
      id: root.id,
      patch: { variableModes: { semantic: "dark" } },
    },
  ]);
  assert.equal(resolveNode(next, next.nodes[1]).style.color, "#f5f7fc");
  const override = apply(next, [
    {
      type: "update",
      id: text.id,
      patch: { variableModes: { semantic: "light" } },
    },
  ]);
  assert.equal(resolveNode(override, override.nodes[1]).style.color, "#192234");
  assert.equal(effectiveModes(override, override.nodes[1]).semantic, "light");
});
test("numeric bindings update geometry and layout, not just painted CSS", () => {
  const { doc, root, text } = fixture();
  const bound = apply(doc, [
    bindVariable(root, "padding", "space-lg"),
    bindVariable(text, "width", "space-lg"),
  ]);
  assert.equal(layoutBounds(bound).get(text.id)!.width, 24);
  assert.equal(layoutBounds(bound).get(text.id)!.x, 24);
  const system = structuredClone(bound.designSystem!);
  system.activeModes.layout = "compact";
  const compact = apply(bound, [{ type: "setDesignSystem", system }]);
  assert.equal(layoutBounds(compact).get(text.id)!.width, 16);
  assert.equal(nodeCss(compact.nodes[1], compact).width, 16);
});
test("imported source glyphs follow editable text and paint, and invalidate on reflow or a text edit", () => {
  const { doc, text } = fixture();
  const layer = doc.nodes[1];
  layer.sourceTextShape = {
    text: layer.text,
    styleKey: textShapeStyleKey(layer.style),
    width: layer.style.width,
    height: layer.style.height,
    d: "M0 0L10 0L5 10Z",
  };
  const current = parseDocument(JSON.parse(JSON.stringify(doc)));
  const recolored = apply(current, [
    { type: "update", id: text.id, patch: {}, style: { color: "#123456" } },
  ]);
  assert.equal(
    runtimeNodes(recolored)[0].children[0].sourceTextShape?.d,
    layer.sourceTextShape.d,
  );
  assert.deepEqual(
    Object.keys(runtimeNodes(recolored)[0].children[0].sourceTextShape!).sort(),
    ["d", "height", "text", "width"],
  );
  const resized = apply(current, [
    { type: "update", id: text.id, patch: {}, style: { width: 317 } },
  ]);
  assert.equal(currentTextShape(resized.nodes[1]), undefined);
  const rewritten = apply(current, [
    { type: "update", id: text.id, patch: { text: "中文 👩🏽‍💻" } },
  ]);
  assert.equal(rewritten.nodes[1].sourceTextShape, undefined);
  assert.equal(runtimeNodes(rewritten)[0].children[0].text, "中文 👩🏽‍💻");
});
test("a decorative Figma frame stroke preserves the padding origin through layout and export", () => {
  const { doc, root, text } = fixture();
  const framed = apply(doc, [
    {
      type: "update",
      id: root.id,
      patch: {},
      style: {
        strokeInLayout: false,
        strokeWidth: 10,
        stroke: "#00cc66",
        strokeAlign: "inside",
        padding: 100,
      },
    },
  ]);
  const bounds = layoutBounds(framed);
  assert.equal(bounds.get(text.id)!.x - bounds.get(root.id)!.x, 100);
  const style = nodeCss(framed.nodes[0], framed);
  assert.equal(style.border, 0);
  assert.match(String(style.outline), /10px solid #00cc66/i);
  const wider = apply(framed, [
    { type: "update", id: root.id, patch: {}, style: { strokeWidth: 16 } },
  ]);
  assert.equal(
    layoutBounds(wider).get(text.id)!.x - bounds.get(root.id)!.x,
    100,
  );
  const standard = apply(doc, [
    {
      type: "update",
      id: root.id,
      patch: {},
      style: { strokeWidth: 10, strokeAlign: "inside", padding: 100 },
    },
  ]);
  assert.equal(
    layoutBounds(standard).get(text.id)!.x - bounds.get(root.id)!.x,
    110,
  );
});
test("per-side bindings survive a round trip, change with modes and detach independently", () => {
  const { doc, root } = fixture();
  // Imported variables can be used on each edge independently.
  const system = structuredClone(doc.designSystem!);
  system.variables["space-lg"].scopes = [];
  system.variables["space-sm"].scopes = [];
  const bound = apply(doc, [
    { type: "setDesignSystem", system },
    bindVariable(root, "insets.left", "space-lg"),
    bindVariable(root, "insets.right", "space-sm"),
    bindVariable(root, "corners.tl", "space-sm"),
    bindVariable(root, "strokeSides.top", "space-sm"),
  ]);
  const reopened = parseDocument(JSON.parse(JSON.stringify(bound)));
  const compact = apply(reopened, [
    {
      type: "update",
      id: root.id,
      patch: { variableModes: { layout: "compact" } },
    },
  ]);
  const node = compact.nodes[0];
  const current = resolveNode(compact, node).style;
  assert.equal(current.insets!.left, 16);
  assert.equal(current.insets!.right, 4);
  assert.equal(current.corners!.tl, 4);
  assert.equal(current.strokeSides!.top, 4);
  const css = symbolicNodeCss(compact, node, nodeCss(node, compact));
  for (const prop of [
    "paddingLeft",
    "paddingRight",
    "borderTopLeftRadius",
    "borderTopWidth",
  ])
    assert.match(String(css[prop]), /var\(/);
  const changed = apply(compact, [
    {
      type: "update",
      id: root.id,
      patch: {},
      style: { insets: { ...current.insets!, left: 19 } },
    },
  ]);
  assert.equal(changed.nodes[0].variableBindings?.["insets.left"], undefined);
  assert.equal(changed.nodes[0].variableBindings?.["insets.right"], "space-sm");
});
test("applying and detaching a typography-only style preserves the independent text color variable", () => {
  const { doc, text } = fixture();
  const bound = apply(doc, [
    bindVariable(text, "color", "color-text"),
    applyReusableStyle(text, doc.designSystem!.styles["text-title"]),
  ]);
  const detached = apply(bound, [
    detachReusableStyle(bound, bound.nodes[1], "text"),
  ]);
  assert.equal(detached.nodes[1].variableBindings?.color, "color-text");
});
test("bindings enforce property types, scopes and constraints in inactive alias modes", () => {
  const { doc, text } = fixture();
  assert.throws(
    () => apply(doc, [bindVariable(text, "width", "color-surface")]),
    /类型/,
  );
  assert.throws(
    () => apply(doc, [bindVariable(text, "text", "font-family")]),
    /作用域/,
  );
  const system = structuredClone(doc.designSystem!);
  system.variables["space-md"].values.compact = -1;
  system.variables["space-lg"].values.compact = { alias: "space-md" };
  assert.throws(() =>
    apply(doc, [
      { type: "setDesignSystem", system },
      bindVariable(text, "width", "space-lg"),
    ]),
  );
});
test("boolean visibility and string bindings reach canvas compilation and runtime", () => {
  const { doc, text } = fixture();
  const system = structuredClone(doc.designSystem!);
  system.variables["content-label"].values.dark = "Dark label";
  system.variables["content-visible"].values.dark = false;
  system.activeModes.semantic = "dark";
  const bound = apply(doc, [
    { type: "setDesignSystem", system },
    bindVariable(text, "text", "content-label"),
    bindVariable(text, "visible", "content-visible"),
  ]);
  const node = resolveNode(bound, bound.nodes[1]);
  assert.equal(node.text, "Dark label");
  assert.equal(node.hidden, true);
  assert.equal(nodeCss(bound.nodes[1], bound).display, "none");
  assert.equal(runtimeNodes(bound)[0].children[0].text, "Dark label");
});
test("style edits propagate, direct overrides survive source edits, and detach preserves appearance", () => {
  const { doc, text } = fixture();
  const style = doc.designSystem!.styles["text-title"];
  let current = apply(doc, [applyReusableStyle(text, style)]);
  assert.equal(resolveNode(current, current.nodes[1]).style.fontSize, 28);
  current = apply(current, [
    { type: "update", id: text.id, patch: {}, style: { fontWeight: 800 } },
  ]);
  const system = structuredClone(current.designSystem!);
  system.styles["text-title"].properties.fontWeight = 500;
  system.styles["text-title"].properties.lineHeight = 44;
  current = apply(current, [{ type: "setDesignSystem", system }]);
  assert.equal(resolveNode(current, current.nodes[1]).style.fontWeight, 800);
  assert.equal(resolveNode(current, current.nodes[1]).style.lineHeight, 44);
  const detached = apply(current, [
    detachReusableStyle(current, current.nodes[1], "text"),
  ]);
  assert.equal(detached.nodes[1].style.fontWeight, 800);
  assert.equal(detached.nodes[1].style.lineHeight, 44);
  assert.ok(!detached.nodes[1].styleBindings?.text);
});
test("paint styles apply to text fill and respect local color overrides", () => {
  const { doc, text } = fixture();
  let current = apply(doc, [
    applyReusableStyle(text, doc.designSystem!.styles["paint-accent"]),
  ]);
  assert.equal(resolveNode(current, current.nodes[1]).style.color, "#246bfd");
  const detached = apply(current, [
    detachReusableStyle(current, current.nodes[1], "paint"),
  ]);
  assert.equal(detached.nodes[1].style.color, "#246bfd");
  current = apply(current, [
    { type: "update", id: text.id, patch: {}, style: { color: "#112233" } },
  ]);
  assert.equal(resolveNode(current, current.nodes[1]).style.color, "#112233");
});
test("manual property edits detach only that variable while keeping other bindings", () => {
  const { doc, text } = fixture();
  let current = apply(doc, [
    bindVariable(text, "fontSize", "text-body"),
    bindVariable(text, "color", "color-text"),
  ]);
  current = apply(current, [
    { type: "update", id: text.id, patch: {}, style: { fontSize: 22 } },
  ]);
  assert.ok(!current.nodes[1].variableBindings?.fontSize);
  assert.equal(current.nodes[1].variableBindings?.color, "color-text");
  const dark = apply(current, [
    {
      type: "update",
      id: text.id,
      patch: { variableModes: { semantic: "dark" } },
    },
  ]);
  const detached = apply(dark, [detachVariable(dark, dark.nodes[1], "color")]);
  assert.equal(detached.nodes[1].style.color, "#f5f7fc");
});
test("referenced variable, style and collection deletion cannot leave dangling bindings", () => {
  const { doc, text } = fixture();
  const bound = apply(doc, [
    bindVariable(text, "color", "color-text"),
    applyReusableStyle(text, doc.designSystem!.styles["text-title"]),
  ]);
  for (const key of ["variable", "style", "collection"]) {
    const system = structuredClone(bound.designSystem!);
    if (key === "variable") delete system.variables["color-text"];
    if (key === "style") delete system.styles["text-title"];
    if (key === "collection") delete system.collections.semantic;
    assert.throws(() => apply(bound, [{ type: "setDesignSystem", system }]));
  }
});
test("cross-file copy remaps collisions and preserves ancestor modes and style bindings", () => {
  const { doc, root, text } = fixture();
  const bound = apply(doc, [
    {
      type: "update",
      id: root.id,
      patch: { variableModes: { semantic: "dark" } },
    },
    bindVariable(text, "color", "color-text"),
    applyReusableStyle(text, doc.designSystem!.styles["text-title"]),
  ]);
  const target = fixture().doc;
  target.designSystem!.variables["palette-dark-text"].values.base = "#ff0000";
  const paste = pasteSelection(target, copySelection(bound, [text.id]), null, {
    x: 0,
    y: 0,
  });
  const result = apply(target, paste.operations);
  const copied = result.nodes.find((n) => n.id === paste.selection[0])!;
  assert.equal(resolveNode(result, copied).style.color, "#f5f7fc");
  assert.equal(resolveNode(result, copied).style.fontSize, 28);
  assert.equal(
    result.designSystem!.variables["palette-dark-text"].values.base,
    "#ff0000",
  );
  assert.notEqual(copied.styleBindings?.text, "text-title");
});
test("same-document duplication reuses variable and style definitions", () => {
  const { doc, text } = fixture();
  const bound = apply(doc, [bindVariable(text, "color", "color-text")]);
  const paste = pasteSelection(bound, copySelection(bound, [text.id]), null, {
    x: 0,
    y: 0,
  });
  const result = apply(bound, paste.operations);
  assert.equal(Object.keys(result.designSystem!.variables).length, 40);
  assert.equal(result.nodes.at(-1)!.variableBindings?.color, "color-text");
});
test("token edits support undo and file serialization", () => {
  const { doc } = fixture(),
    system = structuredClone(doc.designSystem!);
  system.activeModes.semantic = "dark";
  const next = apply(doc, [{ type: "setDesignSystem", system }]);
  const history = commit({ present: doc, past: [], future: [] }, next);
  assert.equal(
    travel(history, "undo").present.designSystem!.activeModes.semantic,
    undefined,
  );
  assert.deepEqual(parseDocument(JSON.parse(JSON.stringify(next))), next);
});
test("instance variants preserve external token bindings; custom component capture is self-contained", () => {
  const { doc } = fixture();
  const insertion = instantiateComponent(
    doc,
    mobileComponentLibrary("navigation"),
    "navigation",
    "Light-Large-Solid",
    null,
    { x: 0, y: 0 },
  );
  let current = apply(doc, insertion.operations);
  const text = current.nodes.find(
    (n) => n.parentId === insertion.id && n.templateKey === "title",
  )!;
  current = apply(current, [bindVariable(text, "color", "color-accent")]);
  current = apply(
    current,
    switchInstance(current, insertion.id, "Dark-Large-Solid"),
  );
  assert.equal(
    current.nodes.find((n) => n.id === text.id)!.variableBindings?.color,
    "color-accent",
  );
  const library = createLibraryFromSelection(current, insertion.id, "Captured");
  const captured = library.components[0].variants[0].nodes.find(
    (n) => n.id === text.id,
  )!;
  assert.equal(captured.variableBindings?.color, "color-accent");
  assert.equal(
    resolveNode(
      {
        ...current,
        nodes: library.components[0].variants[0].nodes,
        designSystem: library.designSystem,
      },
      captured,
    ).style.color,
    "#246bfd",
  );
});
test("scoped agents cannot mutate global definitions but can bind allowed properties", () => {
  const { doc, text } = fixture();
  assert.throws(
    () =>
      validateProposal(
        { document: doc, selection: text.id, prompt: "edit" },
        {
          baseRevision: doc.revision,
          operations: [
            {
              type: "setDesignSystem",
              system: {
                ...doc.designSystem,
                activeModes: { semantic: "dark" },
              },
            },
          ],
        },
      ),
    /全局设计系统/,
  );
  assert.ok(
    validateProposal(
      { document: doc, selection: text.id, prompt: "edit" },
      {
        baseRevision: doc.revision,
        operations: [bindVariable(text, "color", "color-text")],
      },
    ),
  );
});
test("legacy color variables migrate with their layer bindings", () => {
  const { doc, text } = fixture();
  doc.tokens.brand = { name: "Brand", value: "#223344" };
  doc.nodes[1].fillToken = "brand";
  const migrated = apply(doc, migrateLegacyTokens(doc));
  assert.equal(resolveNode(migrated, migrated.nodes[1]).style.fill, "#223344");
  assert.ok(!migrated.nodes[1].fillToken);
  assert.ok(migrated.nodes[1].variableBindings?.fill);
  assert.equal(
    captureStyle(migrated, migrated.nodes[1], "paint", "Saved").kind,
    "paint",
  );
  assert.equal(text.type, "text");
});
test("exported project contains typed tokens, aliases, modes, composite styles and resolved page output", () => {
  const { doc, text } = fixture();
  const bound = apply(doc, [
    bindVariable(text, "color", "color-text"),
    {
      type: "update",
      id: text.id,
      patch: { variableModes: { semantic: "dark" } },
    },
  ]);
  const files = reactProjectFiles(
    pageForExport(bound),
    readFileSync("src/runtime/FormaRuntime.tsx", "utf8"),
  );
  assert.ok(files["design-system.json"].includes("alias"));
  assert.ok(
    files["src/tokens.css"].includes(
      "--color-surface: var(--palette-light-surface)",
    ),
  );
  assert.ok(files["src/tokens.css"].includes('"dark"'));
  assert.ok(files["src/DesignPage.tsx"].includes("#f5f7fc"));
  assert.ok(files["src/DesignPage.tsx"].includes("var(--color-text)"));
  assert.ok(
    files["src/DesignPage.tsx"].includes(
      '"--color-text": "var(--palette-dark-text)"',
    ),
  );
  const directory = mkdtempSync(resolve(".forma-export-test-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      const path = resolve(directory, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
    }
    const config = ts.parseJsonConfigFileContent(
      JSON.parse(files["tsconfig.json"]),
      ts.sys,
      directory,
    );
    const program = ts.createProgram(config.fileNames, config.options);
    const diagnostics = [
      ...config.errors,
      ...ts.getPreEmitDiagnostics(program),
    ];
    assert.deepEqual(
      diagnostics.map((issue) =>
        ts.flattenDiagnosticMessageText(issue.messageText, "\n"),
      ),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("color conversions round-trip and reject invalid input", () => {
  for (const color of [
    "#000000",
    "#ffffff",
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#635bff",
    "#808080",
  ])
    assert.equal(hsvToHex(hexToHsv(color)), color);
  assert.equal(parseColorInput("abc", "HEX"), "#aabbcc");
  assert.equal(parseColorInput("300,0,0", "RGB"), null);
  assert.equal(parseColorInput("120, 100, 50", "HSL"), "#00ff00");
  assert.deepEqual(hexToHsl("#ff0000"), [0, 100, 50]);
  assert.equal(parseColorInput("not-a-color", "HEX"), null);
});

test("gradient stop bindings follow aliases in both modes and reject invalid destinations", () => {
  const { doc, root } = fixture();
  const gradient = {
    type: "linear" as const,
    angle: 45,
    stops: [
      {
        offset: 0,
        color: "#010203",
        variableId: "color-surface",
        opacity: 0.6,
      },
      { offset: 1, color: "#030201", opacity: 1 },
    ],
  };
  const updated = apply(doc, [
    {
      type: "update",
      id: root.id,
      patch: { variableModes: { semantic: "dark" } },
      style: { gradient },
    },
  ]);
  assert.deepEqual(
    resolveNode(updated, updated.nodes[0]).style.gradient?.stops[0],
    { ...gradient.stops[0], color: "#202734" },
  );
  const lib = createLibraryFromSelection(updated, root.id, "Gradient");
  assert.ok(lib.designSystem?.variables["palette-light-surface"]);
  assert.ok(lib.designSystem?.variables["color-surface"]);
  for (const variableId of ["missing", "space-md", "font-family"]) {
    assert.throws(
      () =>
        apply(doc, [
          {
            type: "update",
            id: root.id,
            patch: {},
            style: {
              gradient: {
                ...gradient,
                stops: [
                  { ...gradient.stops[0], variableId },
                  gradient.stops[1],
                ],
              },
            },
          },
        ]),
      /绑定/,
    );
  }
});
