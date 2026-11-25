import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { reactFileProject } from "../src/compiler/file-project";
import { componentProjectFiles } from "../src/compiler/component-project";
import { runtimeNodes } from "../src/compiler/runtime";
import {
  ANTD5_LIBRARY_ID,
  antd5AppearanceSystem,
  antd5Library,
  antd5Spacing,
  antd5Templates,
  antd5Themes,
  antd5Tokens,
  antd5Typography,
  createAntd5Template,
} from "../src/design-system/antd5";
import { transact, type Operation } from "../src/domain/commands";
import { resolveNode } from "../src/domain/design-system";
import { parseDocument, type DesignDocument } from "../src/domain/document";
import {
  instantiateComponent,
  switchInstance,
  validateInstanceStructure,
} from "../src/domain/library";
import { parseLibrary } from "../src/domain/library-schema";

const blank = (): DesignDocument => ({
  schemaVersion: 1,
  id: "test-file",
  name: "AntD 5",
  revision: 0,
  tokens: {},
  nodes: [],
});
const apply = (doc: DesignDocument, operations: Operation[]) =>
  transact(doc, { baseRevision: doc.revision, operations });
const collection = "antd5-appearance";
const modes = ["Light", "Dark"] as const;
const catalog: Record<string, Record<string, string[]>> = {
  button: {
    Type: ["Primary", "Default", "Dashed", "Text", "Danger"],
    Size: ["Small", "Middle", "Large"],
  },
  tag: { Color: ["Blue", "Green", "Gold", "Red", "Default"] },
  badge: { Status: ["Processing", "Success", "Warning", "Error"] },
  avatar: { Size: ["Small", "Default", "Large"] },
  input: {
    State: ["Default", "Focus", "Error", "Disabled"],
    Size: ["Middle", "Large"],
  },
  select: { State: ["Default", "Open", "Disabled"] },
  switch: { Checked: ["On", "Off"], State: ["Default", "Disabled"] },
  checkbox: { State: ["Checked", "Unchecked", "Disabled"] },
  "radio-group": { Selected: ["First", "Second", "Third"] },
  "form-item": { State: ["Default", "Required", "Error"] },
  menu: { Active: ["Dashboard", "Users", "Orders", "Settings"] },
  breadcrumb: { Depth: ["Two", "Three"] },
  tabs: { Style: ["Line", "Card"], Active: ["First", "Second"] },
  pagination: { Style: ["Default", "Compact"] },
  steps: { Current: ["Step1", "Step2", "Step3"] },
  card: { Variant: ["Default", "WithExtra"] },
  statistic: { Trend: ["Up", "Down"] },
  table: { Density: ["Default", "Compact"] },
  alert: { Type: ["Info", "Success", "Warning", "Error"] },
  modal: { Type: ["Form", "Confirm"] },
};

test("all 20 components cover the complete 156-variant matrix with stable, self-contained layers", () => {
  const lib = parseLibrary(antd5Library);
  assert.equal(lib.id, ANTD5_LIBRARY_ID);
  assert.deepEqual(
    lib.components.map((c) => c.id),
    Object.keys(catalog).map((id) => "antd-" + id),
  );
  assert.equal(
    lib.components.reduce((count, c) => count + c.variants.length, 0),
    156,
  );
  for (const c of lib.components) {
    const axes = { Appearance: [...modes], ...catalog[c.id.slice(5)] };
    const signatures = new Set<string>();
    const expected = Object.values(axes).reduce(
      (n, opts) => n * opts.length,
      1,
    );
    assert.equal(c.variants.length, expected, c.id);
    for (const v of c.variants) {
      assert.deepEqual(Object.keys(v.properties), Object.keys(axes));
      for (const [axis, values] of Object.entries(axes))
        assert.ok((values as string[]).includes(v.properties[axis]), v.id);
      signatures.add(JSON.stringify(v.properties));
      const root = v.nodes.find((n) => !n.parentId)!;
      assert.equal(root.templateKey, "root");
      assert.equal(root.type, c.variants[0].nodes[0].type);
      assert.equal(
        root.variableModes?.[collection],
        v.properties.Appearance.toLowerCase(),
      );
      assert.equal(new Set(v.nodes.map((n) => n.id)).size, v.nodes.length);
      assert.equal(
        new Set(v.nodes.map((n) => n.templateKey)).size,
        v.nodes.length,
      );
      assert.ok(
        v.nodes.every((n) => n.templateKey && !n.instance && !n.fillToken),
      );
    }
    assert.equal(signatures.size, expected, c.id);
  }
});

test("foundation scales, both palettes and inherited paint bindings resolve at every layer", () => {
  const system = antd5AppearanceSystem();
  assert.deepEqual(system, antd5Library.designSystem);
  assert.deepEqual(
    system.collections[collection].modes.map((m) => m.id),
    ["light", "dark"],
  );
  assert.equal(system.collections[collection].defaultModeId, "light");
  assert.equal(Object.keys(antd5Tokens).length, 34);
  assert.equal(Object.keys(system.variables).length, 17);
  assert.deepEqual(
    antd5Typography.map((t) => [t.size, t.lineHeight, t.weight]),
    [
      [38, 46, 600],
      [30, 38, 600],
      [24, 32, 600],
      [20, 28, 600],
      [16, 24, 600],
      [14, 22, 400],
      [12, 20, 400],
    ],
  );
  assert.deepEqual(
    antd5Spacing.map((s) => [s.kind, s.value]),
    [
      ["radius", "4px"],
      ["radius", "6px"],
      ["radius", "8px"],
      ["spacing", "24px"],
      ["spacing", "32px"],
      ["spacing", "40px"],
    ],
  );
  for (const mode of modes) {
    for (const [role, hex] of Object.entries(antd5Themes[mode])) {
      assert.deepEqual(
        antd5Tokens["antd5-" + mode.toLowerCase() + "-" + role],
        { name: "AntD5/" + mode + "/" + role, value: hex },
      );
      const variable = system.variables["antd5-color-" + role];
      assert.equal(variable.collectionId, collection);
      assert.equal(variable.values[mode.toLowerCase()], hex);
    }
  }
  const used = new Set<string>();
  for (const c of antd5Library.components)
    for (const v of c.variants) {
      const dark = v.properties.Appearance === "Dark",
        opposite = dark ? "light" : "dark";
      const nodes = v.nodes.map((n) =>
        n.parentId ? n : { ...n, variableModes: { [collection]: opposite } },
      );
      const doc = { ...blank(), designSystem: system, nodes };
      for (const n of nodes) {
        const resolved = resolveNode(doc, n);
        for (const k of ["fill", "color", "stroke"] as const) {
          const binding = n.variableBindings?.[k];
          if (binding) {
            used.add(binding);
            const values = system.variables[binding].values;
            assert.equal(n.style[k], values[dark ? "dark" : "light"]);
            assert.equal(
              resolved.style[k],
              values[opposite],
              c.id + "/" + v.id + "/" + n.templateKey,
            );
          }
        }
        if (n.vector)
          assert.ok(
            n.vector.paths.every((p) => !p.strokeColor && !p.fillColor),
          );
      }
    }
  assert.deepEqual(used, new Set(Object.keys(system.variables)));
  const dialog = antd5Library.components.find((c) => c.id === "antd-modal")!
    .variants[0].nodes;
  assert.equal(dialog[0].variableBindings?.fill, "antd5-color-colorBgElevated");
  assert.equal(
    dialog.find((n) => n.templateKey === "field-0")?.variableBindings?.fill,
    "antd5-color-colorBgBase",
  );
  assert.equal(
    dialog.find((n) => n.templateKey === "submit")?.variableBindings?.color,
    undefined,
  );
});

for (const [componentId, start, end, key] of [
  ["antd-button", "Light-Primary-Middle", "Dark-Dashed-Large", "root"],
  ["antd-input", "Light-Default-Middle", "Dark-Error-Large", "value"],
  ["antd-table", "Light-Default", "Dark-Compact", "row-1-customer"],
  ["antd-modal", "Light-Form", "Dark-Confirm", "title"],
])
  test(
    componentId +
      " retains an edited label and layer ID through a variant switch and file reopen",
    () => {
      const doc = blank(),
        position = { x: 120, y: -60 };
      const placed = instantiateComponent(
        doc,
        antd5Library,
        componentId,
        start,
        null,
        position,
      );
      const inserted = apply(doc, placed.operations);
      const field = inserted.nodes.find((n) => n.templateKey === key)!;
      const edited = apply(inserted, [
        { type: "update", id: field.id, patch: { text: "自定义文案" } },
      ]);
      const switched = apply(edited, switchInstance(edited, placed.id, end));
      const reopened = parseDocument(JSON.parse(JSON.stringify(switched)));
      const root = reopened.nodes.find((n) => n.id === placed.id)!;
      validateInstanceStructure(reopened, root);
      assert.deepEqual(root.instance, {
        libraryId: ANTD5_LIBRARY_ID,
        componentId,
        variantId: end,
      });
      assert.equal(root.style.x, position.x);
      assert.equal(root.style.y, position.y);
      assert.equal(root.variableModes?.[collection], "dark");
      assert.equal(
        reopened.nodes.find((n) => n.id === field.id)?.text,
        "自定义文案",
      );
      if (componentId === "antd-button")
        assert.equal(root.style.strokeStyle, "dashed");
      if (componentId === "antd-input")
        assert.equal(root.style.stroke, antd5Themes.Dark.colorError);
      if (componentId === "antd-table")
        assert.ok(!reopened.nodes.some((n) => n.templateKey === "row-0-date"));
      if (componentId === "antd-modal")
        assert.ok(reopened.nodes.some((n) => n.templateKey === "confirm-icon"));
    },
  );

test("interactive controls carry native preview/export control kinds, values and disabled states", () => {
  for (const [id, kind] of [
    ["button", "button"],
    ["input", "textfield"],
    ["switch", "switch"],
    ["checkbox", "checkbox"],
    ["radio-group", "segmented"],
  ]) {
    for (const v of antd5Library.components.find((c) => c.id === "antd-" + id)!
      .variants) {
      const control = v.nodes[0].control!;
      assert.equal(control.kind, kind);
      assert.equal(control.disabled, v.properties.State === "Disabled");
      if (id === "switch")
        assert.equal(control.value, v.properties.Checked === "On");
      if (id === "checkbox")
        assert.equal(control.value, v.properties.State === "Checked");
      if (id === "radio-group") {
        assert.deepEqual(control.options, ["本周", "本月", "本季"]);
        assert.equal(
          control.value,
          ["First", "Second", "Third"].indexOf(v.properties.Selected),
        );
      }
    }
  }
});

const runtimeSource = (name: string) =>
  readFileSync(new URL("../src/runtime/" + name, import.meta.url), "utf8");

// Type-check the generated project's own TS config and every module together.
// The virtual project can resolve the workspace's installed npm dependencies.
function checkGeneratedProject(files: Record<string, string>) {
  const root = path.resolve(".virtual-antd-export");
  const virtual = new Map(
    Object.entries(files).map(([name, source]) => [
      path.join(root, name),
      source,
    ]),
  );
  const dirs = new Set<string>();
  for (const file of virtual.keys()) {
    for (
      let dir = path.dirname(file);
      dir.startsWith(root);
      dir = path.dirname(dir)
    )
      dirs.add(dir);
  }
  const config = ts.convertCompilerOptionsFromJson(
    JSON.parse(files["tsconfig.json"]).compilerOptions,
    root,
  );
  assert.deepEqual(config.errors, []);
  const host = ts.createCompilerHost(config.options),
    disk = { ...host };
  host.readFile = (file) => virtual.get(file) ?? disk.readFile(file);
  host.fileExists = (file) => virtual.has(file) || disk.fileExists(file);
  host.directoryExists = (dir) => dirs.has(dir) || ts.sys.directoryExists(dir);
  host.getSourceFile = (file, languageVersion, ...rest) => {
    const source = virtual.get(file);
    return source !== undefined
      ? ts.createSourceFile(file, source, languageVersion)
      : disk.getSourceFile(file, languageVersion, ...rest);
  };
  const inputs = [...virtual.keys()].filter((file) => /\.tsx?$/.test(file));
  const program = ts.createProgram(inputs, config.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, host));
}

assert.equal(antd5Templates.length, 2);
for (const template of antd5Templates)
  for (const mode of modes)
    test(
      template.id +
        " / " +
        mode +
        " builds an editable 1440×900 document and a type-checked React project",
      () => {
        const doc = blank(),
          origin = { x: -184, y: 272 };
        const placed = createAntd5Template(doc, template.id, mode, origin);
        assert.equal(
          placed.operations.filter((op) => op.type === "putLibrary").length,
          1,
        );
        const saved = apply(doc, placed.operations);
        const reopened = parseDocument(JSON.parse(JSON.stringify(saved)));
        const board = reopened.nodes.find((n) => n.id === placed.id)!;
        assert.deepEqual(
          [board.style.x, board.style.y, board.style.width, board.style.height],
          [origin.x, origin.y, 1440, 900],
        );
        assert.equal(
          resolveNode(reopened, board).style.fill,
          antd5Themes[mode].colorBgLayout,
        );
        const instances = reopened.nodes.filter((n) => n.instance);
        for (const n of instances) {
          assert.equal(n.instance!.libraryId, ANTD5_LIBRARY_ID);
          assert.equal(n.parentId, board.id);
          assert.equal(n.variableModes?.[collection], mode.toLowerCase());
          validateInstanceStructure(reopened, n);
        }
        const used = instances.map((n) => n.instance!.componentId);
        for (const id of [
          "menu",
          "breadcrumb",
          "table",
          "button",
          "pagination",
          "avatar",
        ])
          assert.ok(used.includes("antd-" + id));
        if (template.id === "antd-admin-dashboard") {
          assert.equal(used.filter((id) => id === "antd-statistic").length, 4);
          const titles = reopened.nodes.filter(
            (n) =>
              n.templateKey === "title" &&
              instances.some(
                (i) =>
                  i.instance?.componentId === "antd-statistic" &&
                  i.id === n.parentId,
              ),
          );
          assert.equal(new Set(titles.map((n) => n.text)).size, 4);
        } else {
          for (const id of ["input", "select", "modal"])
            assert.ok(used.includes("antd-" + id));
          const siblings = reopened.nodes.filter(
            (n) => n.parentId === board.id,
          );
          assert.equal(siblings.at(-1)?.instance?.componentId, "antd-modal");
          assert.equal(siblings.at(-2)?.name, "scrim");
        }
        const files = reactFileProject(
          reopened,
          [board.id],
          runtimeSource("FormaRuntime.tsx"),
          {
            "src/PrototypePlayer.tsx": runtimeSource("PrototypePlayer.tsx"),
            "src/prototype-machine.ts": runtimeSource("prototype-machine.ts"),
          },
          runtimeSource("FileRouter.tsx"),
        );
        const components = componentProjectFiles(reopened, (page) =>
          runtimeNodes(page, undefined, true),
        );
        assert.equal(Object.keys(components).length, new Set(used).size);
        for (const [name, source] of Object.entries(components))
          assert.equal(files[name], source);
        assert.ok(files["src/Page1.tsx"].includes("DesignComponents"));
        assert.equal(
          JSON.parse(files["design.forma.json"]).nodes.length,
          reopened.nodes.length,
        );
        checkGeneratedProject(files);
      },
    );

test("template creation preserves existing design variables when their IDs collide", () => {
  const doc = blank();
  doc.designSystem = antd5AppearanceSystem();
  doc.designSystem.variables["antd5-color-colorPrimary"].values.dark =
    "#ff00ff";
  const placed = createAntd5Template(doc, "antd-admin-dashboard", "Dark", {
    x: 10,
    y: 20,
  });
  const saved = apply(doc, placed.operations);
  const mark = saved.nodes.find((n) => n.name === "brand-mark")!;
  assert.equal(
    resolveNode(saved, mark).style.fill,
    antd5Themes.Dark.colorPrimary,
  );
  assert.equal(
    saved.designSystem?.variables["antd5-color-colorPrimary"].values.dark,
    "#ff00ff",
  );
  assert.notEqual(mark.variableBindings?.fill, "antd5-color-colorPrimary");
  const reopened = parseDocument(JSON.parse(JSON.stringify(saved)));
  const second = createAntd5Template(reopened, "antd-crud-list", "Light", {
    x: 1500,
    y: 20,
  });
  assert.ok(
    second.operations.every(
      (op) => op.type !== "putLibrary" && op.type !== "setDesignSystem",
    ),
  );
  const both = apply(reopened, second.operations);
  assert.equal(Object.keys(both.libraries!).length, 1);
  assert.equal(Object.keys(both.designSystem!.collections).length, 2);
});

test("unknown template IDs fail before producing a transaction", () => {
  assert.throws(
    () => createAntd5Template(blank(), "missing", "Light", { x: 0, y: 0 }),
    /模板不存在/,
  );
});
