import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { componentProjectFiles } from "../src/compiler/component-project";
import { reactFileProject } from "../src/compiler/file-project";
import { runtimeNodes } from "../src/compiler/runtime";
import {
  bindPaletteVariant,
  combinations,
  KitBuilder,
} from "../src/design-system/kit-builder";
import {
  MATERIAL3_LIBRARY_ID,
  createMaterial3Template,
  material3Library,
  material3Spacing,
  material3Templates,
  material3Themes,
  material3Tokens,
  material3Typography,
} from "../src/design-system/material3";
import {
  SHADCN_LIBRARY_ID,
  createShadcnTemplate,
  shadcnLibrary,
  shadcnSpacing,
  shadcnTemplates,
  shadcnThemes,
  shadcnTokens,
  shadcnTypography,
} from "../src/design-system/shadcn";
import { transact, type Operation } from "../src/domain/commands";
import { resolveNode } from "../src/domain/design-system";
import {
  nodeSchema,
  parseDocument,
  type DesignDocument,
} from "../src/domain/document";
import {
  instantiateComponent,
  switchInstance,
  validateInstanceStructure,
} from "../src/domain/library";
import { parseLibrary } from "../src/domain/library-schema";
import { createStarter } from "../src/domain/seed";

const modes = ["Light", "Dark"] as const;
const kits = [
  {
    library: material3Library,
    id: MATERIAL3_LIBRARY_ID,
    collection: "m3-appearance",
    count: 18,
    variantCount: 136,
    tokenPrefix: "m3",
    prefix: "Material3",
    themes: material3Themes,
    tokens: material3Tokens,
    typography: material3Typography,
    spacing: material3Spacing,
    templates: material3Templates,
    create: createMaterial3Template,
    variants: {
      "m3-button": 20,
      "m3-fab": 8,
      "m3-icon-button": 8,
      "m3-segmented-button": 6,
      "m3-text-field": 12,
      "m3-search-bar": 4,
      "m3-switch": 8,
      "m3-checkbox": 8,
      "m3-chip": 12,
      "m3-slider": 6,
      "m3-top-app-bar": 6,
      "m3-nav-bar": 8,
      "m3-tabs": 6,
      "m3-card": 6,
      "m3-list-item": 6,
      "m3-dialog": 4,
      "m3-snackbar": 4,
      "m3-progress": 4,
    },
    controls: {
      "m3-button": "button",
      "m3-fab": "button",
      "m3-icon-button": "button",
      "m3-segmented-button": "segmented",
      "m3-text-field": "textfield",
      "m3-search-bar": "textfield",
      "m3-checkbox": "checkbox",
      "m3-switch": "switch",
      "m3-slider": "slider",
      "m3-progress": "progress",
    },
    target: "Dark-Tonal-Default",
  },
  {
    library: shadcnLibrary,
    id: SHADCN_LIBRARY_ID,
    collection: "shadcn-appearance",
    count: 16,
    variantCount: 104,
    tokenPrefix: "shadcn",
    prefix: "shadcn",
    themes: shadcnThemes,
    tokens: shadcnTokens,
    typography: shadcnTypography,
    spacing: shadcnSpacing,
    templates: shadcnTemplates,
    create: createShadcnTemplate,
    variants: {
      "shadcn-button": 30,
      "shadcn-badge": 8,
      "shadcn-avatar-item": 4,
      "shadcn-input": 6,
      "shadcn-select": 4,
      "shadcn-switch": 4,
      "shadcn-checkbox": 4,
      "shadcn-tabs": 6,
      "shadcn-sidebar": 8,
      "shadcn-command": 4,
      "shadcn-dropdown": 2,
      "shadcn-dialog": 4,
      "shadcn-toast": 6,
      "shadcn-card": 6,
      "shadcn-alert": 4,
      "shadcn-data-card": 4,
    },
    controls: {
      "shadcn-button": "button",
      "shadcn-input": "textfield",
      "shadcn-switch": "switch",
      "shadcn-checkbox": "checkbox",
      "shadcn-tabs": "segmented",
    },
    target: "Dark-Destructive-Lg",
  },
];
const apply = (doc: DesignDocument, operations: Operation[]) =>
  transact(doc, { baseRevision: doc.revision, operations });
const readRuntime = (filename: string) =>
  readFileSync(new URL("../src/runtime/" + filename, import.meta.url), "utf8");

test("KitBuilder uses unique stable keys, valid themeable Lucide paths and a portable fallback", () => {
  const b = new KitBuilder("Light", "Example", 120, 100, {
    fill: "#ffffff",
    text: "#151515",
    accent: "#155050",
    secondary: "#dddddd",
    surface: "#ffffff",
    border: "#bbbbbb",
    fontFamily: "system-ui",
  });
  const group = b.frame("group", 2, 2, 90, 34, {
    layout: "horizontal",
    padding: 2,
    gap: 4,
  });
  assert.equal(group.style.layout, "row");
  const icon = b.lucideIcon("known", "search", 0, 0, 24, "#151515", 2, "group");
  const fallback = b.lucideIcon(
    "fallback",
    "nonexistent-icon",
    30,
    0,
    24,
    "#155050",
    2,
    "group",
  );
  assert.equal(icon.vector!.paths.length, 2);
  assert.ok(fallback.vector!.paths.length);
  assert.notDeepEqual(icon.vector, fallback.vector);
  for (const n of b.nodes) {
    nodeSchema.parse(n);
    assert.equal(n.id, n.templateKey);
    for (const p of n.vector?.paths ?? [])
      assert.equal(p.strokeColor, undefined);
  }
  assert.throws(() => b.box("known", 0, 0, 4, 4), /重复/);
  assert.throws(() => b.box("orphan", 0, 0, 4, 4, {}, "missing"), /父图层/);
  assert.deepEqual(combinations(), [{}]);
  assert.deepEqual(combinations({ State: [] }), []);
  assert.deepEqual(combinations({ Style: ["A", "B"], State: ["On", "Off"] }), [
    { Style: "A", State: "On" },
    { Style: "A", State: "Off" },
    { Style: "B", State: "On" },
    { Style: "B", State: "Off" },
  ]);
});

test("exact palette matches respect visible paints, role restrictions and existing bindings", () => {
  const palette = {
    surface: "#FFFFFF",
    ink: "#ffffff",
    edge: "#bbbbbb",
    accent: "#155050",
  };
  const b = new KitBuilder("Dark", "Palette", 190, 80, {
    fill: "#ffffff",
    text: "#ffffff",
    accent: palette.accent,
    secondary: "#aaaaaa",
    surface: "#ffffff",
    border: palette.edge,
    fontFamily: "system-ui",
  });
  const text = b.text("text", "Value", 0, 0, 60);
  const hidden = b.box("hidden-paints", 0, 24, 10, 10, {
    fill: palette.accent,
    fillOpacity: 0,
    stroke: palette.edge,
    strokeWidth: 0,
  });
  const border = b.box("border", 12, 24, 12, 12, {
    fill: "#fedcba",
    stroke: palette.edge,
    strokeWidth: 1,
  });
  const white = b.box("white", 30, 24, 12, 12, { fill: "#ffffff" });
  const authored = b.text("authored", "Specified", 0, 42, 90, 14, {
    color: "#ffffff",
  });
  authored.variableBindings = { color: "test-accent" };
  bindPaletteVariant(
    b.nodes,
    "theme",
    "test",
    palette,
    "Dark",
    ["surface"],
    ["surface"],
  );
  assert.deepEqual(b.root.variableModes, { theme: "dark" });
  assert.deepEqual(b.root.variableBindings, { fill: "test-surface" });
  assert.deepEqual(text.variableBindings, { color: "test-ink" });
  assert.equal(hidden.variableBindings, undefined);
  assert.deepEqual(border.variableBindings, { stroke: "test-edge" });
  assert.deepEqual(white.variableBindings, { fill: "test-ink" });
  assert.equal(authored.variableBindings?.color, "test-accent");
});

// Resolve the exported project's modules and npm dependencies without writing a
// second project tree or substituting stub declarations for the Forma runtime.
function typecheckExport(files: Record<string, string>) {
  const root = path.resolve("virtual-forma-kit-export");
  const tree = new Map(
    Object.entries(files).map(([file, contents]) => [
      path.join(root, file),
      contents,
    ]),
  );
  const directories = new Set(
    [...tree.keys()].map((file) => path.dirname(file)),
  );
  const { options, errors } = ts.convertCompilerOptionsFromJson(
    JSON.parse(files["tsconfig.json"]).compilerOptions,
    root,
  );
  assert.equal(errors.length, 0);
  const disk = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...disk,
    fileExists: (file) => tree.has(file) || disk.fileExists(file),
    readFile: (file) => tree.get(file) ?? disk.readFile(file),
    directoryExists: (dir) =>
      directories.has(dir) || ts.sys.directoryExists(dir),
    getSourceFile(file, version, ...rest) {
      const source = tree.get(file);
      return source === undefined
        ? disk.getSourceFile(file, version, ...rest)
        : ts.createSourceFile(file, source, version);
    },
  };
  const program = ts.createProgram(
    [...tree.keys()].filter((file) => /\.tsx?$/.test(file)),
    options,
    host,
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, host));
}

for (const kit of kits) {
  const { library, collection } = kit;
  test(
    library.name +
      " has every requested variant, portable geometry, controls and semantic foundations",
    () => {
      const parsed = parseLibrary(library);
      assert.equal(parsed.id, kit.id);
      assert.equal(parsed.revision, 1);
      assert.equal(parsed.components.length, kit.count);
      assert.deepEqual(
        Object.fromEntries(
          parsed.components.map((c) => [c.id, c.variants.length]),
        ),
        kit.variants,
      );
      assert.equal(
        parsed.components.reduce((sum, c) => sum + c.variants.length, 0),
        kit.variantCount,
      );
      assert.equal(kit.templates.length, 2);
      assert.equal(kit.typography.length, 8);
      assert.equal(kit.spacing.length, 6);
      const system = parsed.designSystem!;
      assert.equal(system.collections[collection].defaultModeId, "light");
      assert.deepEqual(
        system.collections[collection].modes.map((m) => m.id),
        ["light", "dark"],
      );
      assert.equal(
        Object.keys(kit.tokens).length,
        Object.keys(system.variables).length * 2,
      );
      for (const mode of modes) {
        for (const [role, value] of Object.entries(kit.themes[mode])) {
          const id = kit.tokenPrefix + "-color-" + role,
            lower = mode.toLowerCase(),
            variable = system.variables[id];
          assert.deepEqual(
            kit.tokens[[kit.tokenPrefix, lower, role].join("-")],
            { name: [kit.prefix, mode, role].join("/"), value },
          );
          assert.equal(variable.values[lower], value);
          assert.equal(variable.collectionId, collection);
          assert.equal(variable.codeSyntax, "--" + id);
          assert.deepEqual(variable.scopes, ["fill", "color", "stroke"]);
        }
      }
      for (const component of parsed.components) {
        const pairs = new Map<string, Set<string>>();
        const controls: Record<string, string | undefined> = kit.controls;
        for (const v of component.variants) {
          const { Appearance: mode, ...axes } = v.properties;
          const key = JSON.stringify(axes);
          if (!pairs.has(key)) pairs.set(key, new Set());
          pairs.get(key)!.add(mode);
          const root = v.nodes[0];
          assert.deepEqual(
            [root.id, root.templateKey, root.type, root.parentId],
            ["root", "root", "frame", null],
          );
          assert.equal(root.variableModes?.[collection], mode.toLowerCase());
          assert.equal(root.control?.kind, controls[component.id]);
          if (root.control && axes.State === "Disabled")
            assert.equal(root.control.disabled, true);
          assert.equal(
            new Set(v.nodes.map((n) => n.templateKey)).size,
            v.nodes.length,
          );
          const parents = new Map(v.nodes.map((n) => [n.id, n]));
          for (const n of v.nodes) {
            assert.equal(n.templateKey, n.id);
            assert.equal(n.fillToken, undefined);
            assert.equal(n.instance, undefined);
            for (const [key, id] of Object.entries(n.variableBindings ?? {}))
              assert.equal(
                n.style[key as "color" | "fill" | "stroke"],
                system.variables[id].values[mode.toLowerCase()],
                component.id + "/" + n.id,
              );
            if (n.parentId) {
              const bounds = parents.get(n.parentId)!.style;
              assert.ok(
                n.style.x >= 0 &&
                  n.style.y >= 0 &&
                  n.style.x + n.style.width <= bounds.width &&
                  n.style.y + n.style.height <= bounds.height,
                component.id + "/" + v.id + "/" + n.id + " exceeds parent",
              );
            }
          }
        }
        for (const pair of pairs.values())
          assert.deepEqual(pair, new Set(modes));
      }
    },
  );

  test(
    library.name +
      " installs every component and compiles all its variants into reusable React modules",
    () => {
      const doc = apply(createStarter(), [{ type: "putLibrary", library }]);
      const operations: Operation[] = [];
      for (const [index, component] of library.components.entries()) {
        const root = instantiateComponent(
          doc,
          library,
          component.id,
          component.variants[0].id,
          null,
          { x: 80 * index, y: 120 },
        );
        assert.ok(root.operations.every((op) => op.type !== "putLibrary"));
        operations.push(...root.operations);
      }
      const next = apply(doc, operations);
      assert.equal(
        next.nodes.filter((n) => n.instance?.libraryId === kit.id).length,
        kit.count,
      );
      const modules = componentProjectFiles(next, (page) =>
        runtimeNodes(page, undefined, true),
      );
      assert.equal(Object.keys(modules).length, kit.count);
      for (const c of library.components) {
        const module = Object.values(modules).find((source) =>
          source.includes(
            "export const componentName = " + JSON.stringify(c.name) + ";",
          ),
        );
        assert.ok(module, c.id);
        for (const v of c.variants)
          assert.ok(module.includes(JSON.stringify(v.id)), v.id);
      }
    },
  );

  test(
    library.name +
      " preserves edited label, layer identity and position through a variant switch and save/reopen",
    () => {
      const starter = createStarter(),
        component = library.components.find(
          (c) => c.id === kit.tokenPrefix + "-button",
        )!;
      const placement = instantiateComponent(
        starter,
        library,
        component.id,
        component.variants[0].id,
        null,
        { x: -75, y: 91 },
      );
      const placed = apply(starter, placement.operations);
      const label = placed.nodes.find(
        (n) => n.parentId === placement.id && n.templateKey === "label",
      )!;
      const edited = apply(placed, [
        { type: "update", id: label.id, patch: { text: "Ship changes" } },
      ]);
      const next = apply(
        edited,
        switchInstance(edited, placement.id, kit.target),
      );
      const reopened = parseDocument(JSON.parse(JSON.stringify(next)));
      const root = reopened.nodes.find((n) => n.id === placement.id)!;
      assert.equal(root.instance?.variantId, kit.target);
      assert.deepEqual([root.style.x, root.style.y], [-75, 91]);
      assert.equal(root.variableModes?.[collection], "dark");
      const child = reopened.nodes.find((n) => n.id === label.id)!;
      assert.equal(child.text, "Ship changes");
      assert.equal(child.parentId, root.id);
      assert.equal(
        resolveNode(reopened, child).style.color,
        kit.tokenPrefix === "m3"
          ? material3Themes.Dark.onSecondaryContainer
          : shadcnThemes.Dark.destructiveForeground,
      );
      validateInstanceStructure(reopened, root);
    },
  );

  for (const meta of kit.templates)
    for (const appearance of modes) {
      test(
        meta.id +
          " / " +
          appearance +
          " inserts editable instances and generates a type-checked React file project",
        () => {
          const starter = createStarter(),
            origin = { x: 1300, y: -120 };
          const placed = kit.create(starter, meta.id, appearance, origin);
          const reopened = parseDocument(
            JSON.parse(JSON.stringify(apply(starter, placed.operations))),
          );
          const board = reopened.nodes.find((n) => n.id === placed.id)!;
          assert.deepEqual(
            [
              board.style.x,
              board.style.y,
              board.style.width,
              board.style.height,
            ],
            [origin.x, origin.y, meta.width, meta.height],
          );
          assert.equal(
            board.variableModes?.[collection],
            appearance.toLowerCase(),
          );
          assert.equal(
            resolveNode(reopened, board).style.fill,
            kit.tokenPrefix === "m3"
              ? material3Themes[appearance].surface
              : shadcnThemes[appearance].background,
          );
          const expected = {
            "m3-android-home": [
              "m3-top-app-bar",
              "m3-nav-bar",
              "m3-search-bar",
              "m3-card",
              "m3-list-item",
              "m3-list-item",
              "m3-fab",
            ],
            "m3-android-settings": [
              "m3-top-app-bar",
              "m3-nav-bar",
              "m3-switch",
              "m3-switch",
              "m3-switch",
              "m3-list-item",
              "m3-list-item",
            ],
            "shadcn-saas-settings": [
              "shadcn-sidebar",
              "shadcn-tabs",
              "shadcn-avatar-item",
              "shadcn-input",
              "shadcn-input",
              "shadcn-switch",
              "shadcn-button",
            ],
            "shadcn-pricing-page": [
              "shadcn-card",
              "shadcn-card",
              "shadcn-card",
              "shadcn-data-card",
              "shadcn-alert",
            ],
          }[meta.id]!;
          const instances = reopened.nodes.filter((n) => n.instance);
          assert.deepEqual(
            instances.map((n) => n.instance!.componentId).sort(),
            expected.sort(),
          );
          for (const n of instances) {
            assert.equal(n.parentId, board.id);
            assert.equal(n.instance!.libraryId, kit.id);
            assert.equal(
              n.variableModes?.[collection],
              appearance.toLowerCase(),
            );
            assert.ok(
              n.style.x >= 0 &&
                n.style.y >= 0 &&
                n.style.x + n.style.width <= board.style.width &&
                n.style.y + n.style.height <= board.style.height,
            );
            validateInstanceStructure(reopened, n);
          }
          if (meta.id === "shadcn-saas-settings")
            assert.deepEqual(
              instances
                .filter((n) => n.control?.kind === "textfield")
                .map((n) => n.control!.value),
              ["Jamie Lee", "jamie@northline.studio"],
            );
          const files = reactFileProject(
            reopened,
            [board.id],
            readRuntime("FormaRuntime.tsx"),
            {
              "src/PrototypePlayer.tsx": readRuntime("PrototypePlayer.tsx"),
              "src/prototype-machine.ts": readRuntime("prototype-machine.ts"),
            },
            readRuntime("FileRouter.tsx"),
          );
          assert.equal(
            Object.keys(files).filter((k) => k.startsWith("src/components/"))
              .length,
            new Set(expected).size,
          );
          assert.ok(files["src/Page1.tsx"].includes("DesignComponents"));
          assert.ok(files["src/pages.ts"].includes(board.id));
          assert.equal(
            JSON.parse(files["design.forma.json"]).nodes.length,
            reopened.nodes.length,
          );
          typecheckExport(files);
        },
      );
    }
}

test("duplicate Zinc hexes keep their distinct semantic roles when a designer changes just one role", () => {
  const v = shadcnLibrary.components
    .find((c) => c.id === "shadcn-select")!
    .variants.find((v) => v.id === "Dark-Open")!;
  const doc = {
    ...createStarter(),
    nodes: v.nodes,
    designSystem: structuredClone(shadcnLibrary.designSystem!),
  };
  const field = v.nodes.find((n) => n.id === "trigger")!,
    selection = v.nodes.find((n) => n.id === "highlight")!;
  assert.equal(field.style.stroke, selection.style.fill);
  assert.equal(field.variableBindings?.stroke, "shadcn-color-border");
  assert.equal(selection.variableBindings?.fill, "shadcn-color-secondary");
  doc.designSystem.variables["shadcn-color-border"].values.dark = "#aa4499";
  assert.equal(resolveNode(doc, field).style.stroke, "#aa4499");
  assert.equal(
    resolveNode(doc, selection).style.fill,
    shadcnThemes.Dark.secondary,
  );
});

test("template imports preserve a colliding local palette and bind the board to the installed collection", () => {
  const doc = createStarter();
  doc.designSystem = structuredClone(material3Library.designSystem!);
  doc.designSystem.variables["m3-color-surface"].values.dark = "#123456";
  const placed = createMaterial3Template(doc, "m3-android-home", "Dark", {
    x: -220,
    y: 180,
  });
  const next = apply(doc, placed.operations);
  const board = next.nodes.find((n) => n.id === placed.id)!;
  assert.equal(
    next.designSystem!.variables["m3-color-surface"].values.dark,
    "#123456",
  );
  assert.notEqual(board.variableBindings?.fill, "m3-color-surface");
  assert.equal(
    resolveNode(next, board).style.fill,
    material3Themes.Dark.surface,
  );
  const again = createMaterial3Template(
    parseDocument(JSON.parse(JSON.stringify(next))),
    "m3-android-settings",
    "Light",
    { x: 240, y: 180 },
  );
  const second = apply(next, again.operations);
  assert.equal(
    again.operations.filter((op) => op.type === "putLibrary").length,
    0,
  );
  assert.equal(
    new Set(
      second.nodes.flatMap((n) => (n.instance ? [n.instance.libraryId] : [])),
    ).size,
    1,
  );
});

test("repeated placement and both kits coexist in one document without duplicate libraries or layer IDs", () => {
  let doc = createStarter();
  for (const [kit, appearance] of [
    [kits[0], "Light"],
    [kits[0], "Dark"],
    [kits[1], "Dark"],
  ] as const) {
    const placed = kit.create(doc, kit.templates[0].id, appearance, {
      x: 24,
      y: 48,
    });
    assert.equal(
      placed.operations.filter((op) => op.type === "putLibrary").length,
      doc.libraries?.[kit.id] ? 0 : 1,
    );
    doc = apply(doc, placed.operations);
  }
  assert.equal(Object.keys(doc.libraries!).length, 2);
  assert.equal(Object.keys(doc.designSystem!.collections).length, 2);
  assert.equal(new Set(doc.nodes.map((n) => n.id)).size, doc.nodes.length);
});
