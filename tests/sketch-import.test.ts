import { symbolPaintForView } from "../src/domain/symbol-background";
import { runtimeNodes } from "../src/compiler/runtime";
import { nodeCss } from "../src/compiler/react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { importSketch } from "../src/infrastructure/design-import/sketch";
import {
  parseDocument,
  createNode,
  type DesignDocument,
} from "../src/domain/document";
import { openPage } from "../src/domain/pages";
import { transact } from "../src/domain/commands";
import {
  planSwitchInstance,
  switchInstance,
  validateInstanceStructure,
} from "../src/domain/library";
import { resolveNode } from "../src/domain/design-system";
import { booleanVector } from "../src/domain/boolean-shapes";
import { materializeSlots } from "../src/domain/component-slots";
import { textLayoutStyleKey } from "../src/domain/text-shape";
import { attachSketchTextLayouts } from "../src/infrastructure/design-import/sketch-text-layout";
import { makeLayer } from "../src/infrastructure/design-import/sketch-appearance";
import { readLayer } from "../src/infrastructure/design-import/sketch-source";
import { readFile } from "node:fs/promises";

const blue = { red: 0, green: 0, blue: 1, alpha: 1 };
const sourceLayer = (
  kind: string,
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
) => ({
  _class: kind,
  do_objectID: id,
  name,
  frame: { x: 0, y: 0, width: 50, height: 24 },
  ...extra,
});
function archive(
  pages: ReturnType<typeof sourceLayer>[],
  doc: Record<string, unknown> = {},
) {
  return zipSync(
    Object.fromEntries([
      [
        "meta.json",
        strToU8(JSON.stringify({ version: 144, appVersion: "91" })),
      ],
      [
        "document.json",
        strToU8(
          JSON.stringify({
            do_objectID: "doc",
            pages: pages.map((p) => ({ _ref: "pages/" + p.do_objectID })),
            ...doc,
          }),
        ),
      ],
      ...pages.map((p) => [
        "pages/" + p.do_objectID + ".json",
        strToU8(JSON.stringify(p)),
      ]),
    ]),
  );
}
const page = (id: string, layers: ReturnType<typeof sourceLayer>[]) =>
  sourceLayer("page", id, id, { layers });
const textLayer = (id: string, value: string) =>
  sourceLayer("text", id, "同名", {
    attributedString: { string: value, attributes: [] },
  });
test("Sketch preserves UTF-16 ranges, page and sibling order, shared fills, masters and explicit instance text through a native edit, reset and reopen", async () => {
  const layer = textLayer("label", "原文");
  const master = sourceLayer("symbolMaster", "master", "按钮", {
    symbolID: "symbol",
    layers: [layer],
  });
  const item = sourceLayer("symbolInstance", "instance", "按钮", {
    symbolID: "symbol",
    overrideValues: [{ overrideName: "label_stringValue", value: "替换𐐷" }],
  });
  const attrs = {
    MSAttributedStringFontAttribute: {
      attributes: { name: "Helvetica", size: 14 },
    },
  };
  const special = sourceLayer("text", "unicode", "同名", {
    attributedString: {
      string: "甲👩‍💻乙",
      attributes: [
        { location: 0, length: 1, attributes: attrs },
        { location: 1, length: 5, attributes: { ...attrs, kerning: 2 } },
        { location: 6, length: 1, attributes: attrs },
      ],
    },
  });
  const fill = { fills: [{ color: blue, fillType: 0 }] };
  const colorLayer = sourceLayer("rectangle", "shape", "同名", {
    sharedStyleID: "paint",
    style: fill,
    frame: { x: -3, y: 2, width: 25, height: 11 },
  });
  const result = await importSketch(
    archive(
      [page("作品", [item, special, colorLayer]), page("组件", [master])],
      {
        layerStyles: {
          objects: [{ do_objectID: "paint", name: "蓝", value: fill }],
        },
      },
    ),
    "我的设计.sketch",
  );
  assert.equal(result.sourceNodes, 5);
  let d = parseDocument(JSON.parse(JSON.stringify(result.document)));
  assert.deepEqual(
    d.pages?.map((p) => p.id),
    ["作品", "组件"],
  );
  assert.deepEqual(
    d.nodes.filter((n) => !n.parentId).map((n) => n.id),
    ["instance", "unicode", "shape"],
  );
  assert.deepEqual(d.nodes.find((n) => n.id === "unicode")?.textRuns, [
    { start: 1, end: 6, style: { letterSpacing: 2 } },
  ]);
  const shape = d.nodes.find((n) => n.id === "shape")!;
  const bound = shape.styleBindings!.paint!;
  d.designSystem!.styles[bound].properties.fill = "#ee0011";
  assert.equal(resolveNode(d, shape).style.fill, "#ee0011");
  validateInstanceStructure(d, d.nodes[0]);
  const root = d.nodes[0],
    old = d.nodes.find((n) => n.parentId === root.id)!;
  assert.equal(old.text, "替换𐐷");
  d = openPage(d, "组件");
  d = transact(d, {
    baseRevision: d.revision,
    operations: [
      { type: "update", id: "label", patch: { text: "新版", name: "新名字" } },
    ],
  });
  d = openPage(d, "作品");
  assert.equal(d.nodes.find((n) => n.id === old.id)?.name, "新名字");
  assert.equal(d.nodes.find((n) => n.id === old.id)?.text, "替换𐐷");
  d = transact(d, {
    baseRevision: d.revision,
    operations: switchInstance(d, root.id, "default", true),
  });
  assert.equal(d.nodes.find((n) => n.parentId === root.id)?.text, "新版");
});

test("Sketch materializes nested Symbol replacements before applying scoped text overrides and preserves external library identity", async () => {
  const icon = (id: string, label: string) =>
    sourceLayer("symbolMaster", "master-" + id, label, {
      symbolID: id,
      layers: [textLayer("text-" + id, label)],
    });
  const master = sourceLayer("symbolMaster", "master-host", "主件", {
    symbolID: "host",
    layers: [sourceLayer("symbolInstance", "slot", "内件", { symbolID: "a" })],
  });
  const instance = sourceLayer("symbolInstance", "item", "实例", {
    symbolID: "host",
    overrideValues: [
      { overrideName: "slot/text-b_stringValue", value: "已替换" },
      { overrideName: "slot_symbolID", value: "b" },
    ],
  });
  const r = await importSketch(
    archive([page("main", [icon("a", "文字甲"), master, instance])], {
      foreignSymbols: [
        {
          libraryID: "foreign-kit",
          sourceLibraryName: "外部库",
          symbolMaster: icon("b", "文字乙"),
        },
      ],
    }),
    "nested.sketch",
  );
  const d = r.document,
    root = d.nodes.find((n) => n.id === "item")!;
  validateInstanceStructure(d, root);
  const slot = d.nodes.find((n) => n.parentId === root.id)!;
  assert.equal(d.nodes.find((n) => n.parentId === slot.id)?.text, "已替换");
  assert.equal(Object.values(root.instance!.slots!)[0].componentId, "b");
  assert.equal(
    Object.values(d.libraries!).find((l) => l.name === "外部库")?.components
      .length,
    1,
  );
});
test("Sketch rejects invalid Unicode bytes, duplicate source IDs and recursive symbols before returning a document", async () => {
  await assert.rejects(
    importSketch(
      zipSync({
        "meta.json": new Uint8Array([0xff]),
        "document.json": strToU8("{}"),
      }),
      "x.sketch",
    ),
  );
  await assert.rejects(
    importSketch(
      archive([page("p", [textLayer("x", "a"), textLayer("x", "b")])]),
      "x.sketch",
    ),
    /ID 重复/,
  );
  await assert.rejects(
    importSketch(
      archive([
        page("p", [
          sourceLayer("symbolMaster", "m", "M", {
            symbolID: "m",
            layers: [
              sourceLayer("symbolInstance", "i", "i", { symbolID: "m" }),
            ],
          }),
        ]),
      ]),
      "cycle.sketch",
    ),
    /循环/,
  );
});

test("Sketch preserves matching explicit overrides and updates an inherited text color when its shared style changes", async () => {
  const textStyle = {
    textStyle: {
      encodedAttributes: {
        MSAttributedStringColorAttribute: blue,
        MSAttributedStringFontAttribute: {
          attributes: { name: "Helvetica", size: 16 },
        },
      },
    },
  };
  const label = {
    ...textLayer("label", "历史"),
    sharedStyleID: "type",
    style: textStyle,
  };
  const master = sourceLayer("symbolMaster", "master", "主件", {
    symbolID: "s",
    layers: [label],
  });
  const instance = sourceLayer("symbolInstance", "usage", "实例", {
    symbolID: "s",
    overrideValues: [{ overrideName: "label_stringValue", value: "历史" }],
  });
  const r = await importSketch(
    archive([page("main", [master, instance])], {
      layerTextStyles: {
        objects: [{ do_objectID: "type", name: "正文", value: textStyle }],
      },
    }),
    "text.sketch",
  );
  const d = transact(r.document, {
    baseRevision: 0,
    operations: [{ type: "update", id: "label", patch: { text: "已更新" } }],
  });
  const child = d.nodes.find((n) => n.parentId === "usage")!;
  assert.equal(child.text, "历史");
  assert.ok(child.instanceOverrides?.includes("text"));
  d.designSystem!.styles[child.styleBindings!.text!].properties.color =
    "#998877";
  assert.equal(resolveNode(d, child).style.color, "#998877");
});

test("Sketch keeps a filled rectangular clipping source visible, normalizes huge capsule radii, and preserves uppercase text as editable original content", async () => {
  const mask = sourceLayer("rectangle", "mask", "裁切范围", {
    hasClippingMask: true,
    fixedRadius: 5000,
    style: { fills: [{ color: blue, fillType: 0 }] },
  });
  const text = sourceLayer("text", "label", "标签", {
    attributedString: {
      string: "Label",
      attributes: [
        {
          location: 0,
          length: 5,
          attributes: { MSAttributedStringTextTransformAttribute: 1 },
        },
      ],
    },
  });
  const group = sourceLayer("group", "group", "裁切组", {
    layers: [mask, text],
  });
  const { document: d } = await importSketch(
    archive([page("p", [group])]),
    "mask.sketch",
  );
  const [parent, bg, label] = d.nodes;
  assert.equal(parent.type, "frame");
  assert.equal(parent.style.clipContent, true);
  assert.equal(parent.style.radius, 12);
  assert.equal(bg.style.fill, "#0000ff");
  assert.equal(bg.hidden, false);
  assert.equal(label.text, "Label");
  assert.equal(label.style.textTransform, "uppercase");
});

test("Sketch binds the shared stroke separately and preserves a locally overridden stroke width", async () => {
  const border = {
    color: { ...blue, swatchID: "old" },
    thickness: 2,
    position: 1,
  };
  const style = { fills: [{ fillType: 0, color: blue }], borders: [border] };
  const rectangle = (id: string, thickness: number) =>
    sourceLayer("rectangle", id, id, {
      sharedStyleID: "button",
      style: { ...style, borders: [{ ...border, thickness }] },
    });
  const { document: d } = await importSketch(
    archive(
      [page("p", [rectangle("inherited", 2), rectangle("override", 6)])],
      {
        sharedSwatches: {
          objects: [{ do_objectID: "old", name: "旧色", value: blue }],
        },
        layerStyles: {
          objects: [{ do_objectID: "button", name: "按钮", value: style }],
        },
      },
    ),
    "borders.sketch",
  );
  const [inherited, override] = d.nodes;
  const stroke = d.designSystem!.styles[inherited.styleBindings!.stroke!];
  assert.equal(stroke.kind, "stroke");
  assert.equal(stroke.bindings.stroke, "old");
  assert.equal(inherited.variableBindings?.stroke, undefined);
  delete stroke.bindings.stroke;
  Object.assign(stroke.properties, { stroke: "#ee3311", strokeWidth: 5 });
  assert.equal(resolveNode(d, inherited).style.strokeWidth, 5);
  assert.equal(resolveNode(d, override).style.strokeWidth, 6);
  for (const n of d.nodes) {
    assert.equal(resolveNode(d, n).style.stroke, "#ee3311");
    assert.equal(resolveNode(d, n).style.fill, "#0000ff");
  }
  d.designSystem!.styles[inherited.styleBindings!.paint!].properties.fill =
    "#123456";
  assert.equal(resolveNode(d, inherited).style.stroke, "#ee3311");
  assert.equal(resolveNode(d, inherited).style.fill, "#123456");
});

test("Sketch resolves three chained replacement slots introduced by prior swaps", async () => {
  const master = (id: string, layers: ReturnType<typeof sourceLayer>[]) =>
    sourceLayer("symbolMaster", "m-" + id, id, { symbolID: id, layers });
  const slot = (id: string, symbolID: string) =>
    sourceLayer("symbolInstance", id, id, { symbolID });
  const roots = [
    master("default", [textLayer("default-child", "原文")]),
    master("third", [textLayer("third-child", "末级")]),
    master("second", [slot("detail", "default")]),
    master("first", [slot("trailing", "default")]),
    master("host", [slot("state", "default")]),
  ];
  const item = sourceLayer("symbolInstance", "usage", "source list item", {
    symbolID: "host",
    overrideValues: [
      {
        overrideName: "state/trailing/detail/third-child_stringValue",
        value: "末级已更新",
      },
      { overrideName: "state/trailing/detail_symbolID", value: "third" },
      { overrideName: "state/trailing_symbolID", value: "second" },
      { overrideName: "state_symbolID", value: "first" },
    ],
  });
  const { document: d, issues } = await importSketch(
    archive([page("p", [...roots, item])]),
    "三层换件.sketch",
  );
  const root = d.nodes.find((n) => n.id === "usage")!;
  validateInstanceStructure(d, root);
  assert.equal(Object.keys(root.instance!.slots!).length, 3);
  assert.deepEqual(
    issues.filter((q) => /覆盖|替换/.test(q.detail)),
    [],
  );
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const leaf = d.nodes.find((n) => n.text === "末级已更新")!;
  let n = leaf;
  while (n.parentId) n = byId.get(n.parentId)!;
  assert.equal(n.id, root.id);
});

test("Sketch 196 preserves painter order, Stack direction, inner shadows, Liquid Glass, modern radii and SF symbol selectors", async () => {
  const style = {
    corners: { radii: [3.402823466385289e38], style: 1, smoothing: 0.6 },
    blurs: [
      {
        isEnabled: true,
        type: 4,
        radius: 9,
        saturation: 1.7,
        brightness: 1.1,
        depth: 0.75,
        distortion: 0.25,
        chromaticAberrationMultiplier: 0.15,
        skipLightingEffects: false,
      },
    ],
    shadows: [
      {
        isEnabled: true,
        isInnerShadow: true,
        offsetY: -1,
        blurRadius: 1,
        color: blue,
      },
    ],
  };
  const first = sourceLayer("text", "right", "􀝥", {
    attributedString: {
      string: "􀝥",
      attributes: [
        {
          location: 0,
          length: 2,
          attributes: {
            MSAttributedStringFontAttribute: {
              attributes: {
                name: "SFPro-Regular",
                size: 16,
                featureSettings: [
                  {
                    CTFeatureSelectorIdentifier: 32,
                    CTFeatureTypeIdentifier: 35,
                  },
                ],
              },
            },
          },
        },
      ],
    },
  });
  const stack = sourceLayer("group", "stack", "Stack", {
    groupBehavior: 1,
    clippingBehavior: 2,
    style,
    horizontalSizing: 0,
    verticalSizing: 0,
    leftPadding: 8,
    rightPadding: 6,
    groupLayout: {
      _class: "MSImmutableFlexGroupLayout",
      flexDirection: 0,
      stackingOrder: 0,
      justifyContent: 3,
      alignItems: 1,
      allGuttersGap: 12,
    },
    layers: [first, sourceLayer("rectangle", "left", "前项")],
  });
  const { document: d, issues } = await importSketch(
    archive([page("p", [stack])]),
    "Sketch 196.sketch",
  );
  const [frame, label] = d.nodes;
  assert.deepEqual(
    d.nodes.map((n) => n.id),
    ["stack", "right", "left"],
  );
  assert.equal(frame.type, "frame");
  assert.equal(frame.style.clipContent, false);
  assert.equal(frame.style.layout, "row");
  assert.equal(frame.style.layoutReverse, true);
  assert.equal(frame.style.justifyContent, "space-between");
  assert.equal(frame.style.alignY, "center");
  assert.equal(frame.style.insets?.left, 8);
  assert.equal(frame.style.radius, 12);
  assert.equal(frame.style.cornerSmoothing, 0.6);
  assert.equal(frame.style.shadows?.[0].inset, true);
  assert.equal(frame.style.backdropBlur, 9);
  assert.equal(frame.style.backdropSaturation, 1.7);
  assert.equal(frame.style.sketchGlass?.chromaticAberrationMultiplier, 0.15);
  assert.ok(issues.some((q) => q.detail.includes("Liquid Glass")));
  assert.equal(label.text, "􀝥");
  assert.equal(label.style.fontFeatureSettings, '"ss16" 1');
});

test("Sketch keeps an unavailable replacement slot hidden and resolves an explicit self-addressed instance paint", async () => {
  const original = sourceLayer("symbolMaster", "icon-master", "Icon", {
    symbolID: "icon",
    layers: [textLayer("glyph", "I")],
  });
  const container = sourceLayer("symbolMaster", "host-master", "Host", {
    symbolID: "host",
    layers: [
      sourceLayer("symbolInstance", "slot", "slot", { symbolID: "icon" }),
    ],
  });
  const item = sourceLayer("symbolInstance", "item", "实例", {
    symbolID: "host",
    overrideValues: [
      { overrideName: "slot_symbolID", value: "removed-master" },
      { overrideName: "item_color:fill-0", value: blue },
    ],
  });
  const { document: d, issues } = await importSketch(
    archive([page("p", [original, container, item])]),
    "原厂缺失覆盖.sketch",
  );
  const root = d.nodes.find((n) => n.id === "item")!;
  assert.equal(root.style.fill, "#0000ff");
  assert.equal(d.nodes.find((n) => n.parentId === "item")!.hidden, true);
  assert.ok(issues.some((q) => q.detail.includes("removed-master")));
  validateInstanceStructure(d, root);
});

test("Sketch preserves source background order, Symbol-root blend overrides and stored single-line height", async () => {
  const white = { ...blue, red: 1, green: 1 },
    black = { ...blue, blue: 0 };
  const caps = sourceLayer("text", "cap", "Caption", {
    frame: { x: 0, y: 0, width: 320, height: 160 },
    horizontalSizing: 0,
    verticalSizing: 1,
    attributedString: {
      string: "iOS",
      attributes: [
        {
          location: 0,
          length: 3,
          attributes: {
            MSAttributedStringFontAttribute: {
              attributes: { name: "SFPro-Regular", size: 134 },
            },
          },
        },
      ],
    },
  });
  const key = sourceLayer("symbolMaster", "key-source", "键帽", {
    symbolID: "keyboard-key",
    layers: [caps],
    style: {
      contextSettings: { blendMode: 17, opacity: 0.8 },
      fills: [
        { fillType: 0, color: black, layeringType: 0 },
        { fillType: 0, color: white, layeringType: 2 },
      ],
    },
    includeBackgroundColorInInstance: true,
    includeBackgroundColorInExport: true,
  });
  const use = sourceLayer("symbolInstance", "cap-use", "键帽", {
    symbolID: "keyboard-key",
    style: { contextSettings: { blendMode: 0, opacity: 1 } },
  });
  const { document: d } = await importSketch(
    archive([page("p", [key, use])]),
    "背景.sketch",
  );
  const m = d.nodes[0],
    n = d.nodes.find((n) => n.id === "cap-use")!;
  assert.equal(m.style.fill, "#ffffff");
  assert.equal(m.style.paints?.[0]?.color, "#000000");
  assert.equal(m.style.paints?.[0]?.id, "p0");
  assert.equal(m.style.blendMode, "plus-lighter");
  assert.equal(n.style.blendMode, "normal");
  assert.equal(n.style.opacity, 1);
  assert.equal(d.nodes.find((n) => n.id === "cap")!.style.lineHeight, 160);
});

test("Sketch keeps a master background editable while preview, instance and export respect its original visibility flags", async () => {
  const style = { fills: [{ color: blue, fillType: 0, layeringType: 0 }] };
  const master = sourceLayer("symbolMaster", "bg", "主件", {
    groupBehavior: 1,
    symbolID: "bg-symbol",
    includeBackgroundColorInExport: true,
    includeBackgroundColorInInstance: false,
    style,
  });
  const instance = sourceLayer("symbolInstance", "use", "引用", {
    symbolID: "bg-symbol",
  });
  const { document: d } = await importSketch(
    archive([page("p", [master, instance])]),
    "背景标志.sketch",
  );
  const [m, n] = d.nodes;
  assert.equal(m.style.fill, "#0000ff");
  assert.equal(n.style.fill, "#0000ff");
  assert.equal(symbolPaintForView(m, "canvas").style.fillOpacity, 1);
  assert.equal(symbolPaintForView(m, "export").style.fillOpacity, 0);
  assert.equal(symbolPaintForView(n, "canvas").style.fillOpacity, 0);
  assert.equal(symbolPaintForView(n, "export").style.fillOpacity, 0);
  assert.deepEqual(
    runtimeNodes(d).map((v) => v.style.background),
    [nodeCss(n, d, "export").background, nodeCss(n, d, "export").background],
  );
  assert.notEqual(
    nodeCss(m, d, "canvas").background,
    nodeCss(m, d, "export").background,
  );
});

test("Sketch editable compound contours retain winding, nested holes and child edits", async () => {
  const { booleanVector } = await import("../src/domain/boolean-shapes");
  const outer = sourceLayer("rectangle", "outer", "外框", {
    booleanOperation: -1,
    frame: { x: 0, y: 0, width: 40, height: 40 },
  });
  const hole = sourceLayer("rectangle", "hole", "孔", {
    booleanOperation: -1,
    frame: { x: 5, y: 5, width: 15, height: 15 },
  });
  const group = sourceLayer("shapeGroup", "compound", "带孔形状", {
    frame: { x: 0, y: 0, width: 40, height: 40 },
    style: { windingRule: 1, fills: [{ fillType: 0, color: blue }] },
    layers: [outer, hole],
  });
  const result = await importSketch(
    archive([page("p", [group])]),
    "winding.sketch",
  );
  const doc = parseDocument(JSON.parse(JSON.stringify(result.document)));
  const shape = doc.nodes.find((n) => n.id === "compound")!;
  assert.equal(shape.booleanOperation, "compound");
  assert.deepEqual(
    doc.nodes.filter((n) => n.parentId === shape.id).map((n) => n.id),
    ["outer", "hole"],
  );
  const path = booleanVector(doc, shape)?.paths[0];
  assert.equal(path?.fillRule, "evenodd");
  const { exportReact } = await import("../src/compiler/react");
  const snippet = exportReact(doc);
  assert.match(snippet, /fillRule=\{"evenodd"\}/);
  assert.doesNotMatch(snippet, /data-design-id=\{"hole"\}/);
  assert.equal(path?.d.match(/m/gi)?.length, 2);
  const edited = transact(doc, {
    baseRevision: doc.revision,
    operations: [
      { type: "update", id: "hole", patch: {}, style: { width: 20 } },
    ],
  });
  assert.notEqual(booleanVector(edited, shape)?.paths[0].d, path.d);
});

test("Sketch evaluates each mixed Boolean operand in source order after a child edit", async () => {
  const { booleanVector } = await import("../src/domain/boolean-shapes");
  const { default: paper } = await import("paper");
  const parts = [
    ["outer", -1, 0, 40],
    ["hole", -1, 5, 30],
    ["island", 0, 10, 20],
    ["cut", 1, 14, 8],
  ] as const;
  const group = sourceLayer("shapeGroup", "compound", "带孔标记", {
    frame: { x: 0, y: 0, width: 40, height: 40 },
    style: { windingRule: 1, fills: [{ fillType: 0, color: blue }] },
    layers: parts.map(([id, booleanOperation, x, width]) =>
      sourceLayer("rectangle", id, id, {
        frame: { x, y: x, width, height: width },
        booleanOperation,
      }),
    ),
  });
  const { document } = await importSketch(
    archive([page("p", [group])]),
    "operands.sketch",
  );
  const saved = parseDocument(JSON.parse(JSON.stringify(document)));
  const scope = new paper.PaperScope();
  scope.setup(new scope.Size(40, 40));
  const covers = (doc: typeof saved) => {
    const shape = doc.nodes.find((n) => n.id === "compound")!;
    const path = booleanVector(doc, shape)!.paths[0];
    const contour = new scope.CompoundPath({
      pathData: path.d,
      fillRule: path.fillRule,
      insert: false,
    });
    return [2, 7, 12, 16].map((x) => contour.contains(new scope.Point(x, x)));
  };
  assert.deepEqual(
    saved.nodes
      .filter((n) => n.parentId === "compound")
      .map((n) => n.operandOperation),
    [undefined, undefined, "union", "subtract"],
  );
  assert.deepEqual(covers(saved), [true, false, true, false]);
  const edited = transact(saved, {
    baseRevision: saved.revision,
    operations: [
      { type: "update", id: "cut", patch: { operandOperation: "union" } },
    ],
  });
  assert.deepEqual(covers(edited), [true, false, true, true]);
});

const frame = (width: number, height = 24) => ({ x: 0, y: 0, width, height });
const shape = (id: string, extra: Record<string, unknown> = {}) =>
  sourceLayer("rectangle", id, id, extra);
const master = (
  id: string,
  layers: (ReturnType<typeof sourceLayer> & Record<string, unknown>)[],
  extra: Record<string, unknown> = {},
) =>
  sourceLayer("symbolMaster", "master-" + id, id, {
    symbolID: id,
    layers,
    ...extra,
  });
const instance = (
  id: string,
  symbolID: string,
  extra: Record<string, unknown> = {},
) => sourceLayer("symbolInstance", id, id, { symbolID, ...extra });
const pathLayer = (id: string, extra: Record<string, unknown> = {}) =>
  sourceLayer("shapePath", id, id, {
    isClosed: true,
    points: [{ point: "{0,0}" }, { point: "{1,0}" }, { point: "{1,1}" }],
    ...extra,
  });
const gradient = (positions: number[]) => ({
  fillType: 1,
  gradient: {
    from: "{0,0}",
    to: "{1,0}",
    stops: positions.map((position) => ({ position, color: blue })),
  },
});
test("Sketch keeps editable bounds for out-of-range styles, gradients, vectors, effects, rotations and typography", async () => {
  const big = "a".repeat(16383) + "😀";
  const layers = [
    shape("shape", {
      name: big,
      rotation: 450,
      frame: frame(200000, 300000),
      style: {
        fills: Array.from({ length: 18 }, (_, i) => ({
          color: { ...blue, red: i / 17, alpha: 2 },
        })),
        contextSettings: { opacity: -2 },
        borders: [{ color: { ...blue, alpha: -3 }, thickness: 150 }],
        shadows: Array(35).fill({
          offsetX: -1200,
          offsetY: 2000,
          spread: 3000,
          blurRadius: 1500,
          color: blue,
        }),
        corners: { style: 1, smoothing: 3, radii: [20000, -5, 100, 200] },
        blurs: [
          { type: 0, isEnabled: true, radius: 120 },
          {
            type: 3,
            isEnabled: true,
            radius: 600,
            saturation: 8,
            brightness: -2,
          },
        ],
      },
    }),
    shape("gradient", {
      style: {
        fills: [
          { ...gradient([0]), isEnabled: false },
          gradient([0]),
          gradient(Array.from({ length: 70 }, (_, i) => i - 1)),
        ],
      },
    }),
    sourceLayer("shapePath", "empty", "empty", { points: [] }),
    pathLayer("huge", { frame: frame(200000, 20000) }),
    sourceLayer("text", "text", "text", {
      attributedString: {
        string: "a".repeat(49999) + "😀",
        attributes: [
          {
            location: 0,
            length: 50001,
            attributes: {
              MSAttributedStringFontAttribute: {
                attributes: { name: "Family".repeat(80), size: 600 },
              },
              kerning: 450,
              paragraphStyle: { maximumLineHeight: 2000 },
            },
          },
        ],
      },
    }),
    master("rot", []),
    instance("item", "rot", {
      rotation: -540,
      frame: frame(200000),
      style: { contextSettings: { opacity: 2 } },
    }),
    shape("small", { points: [{ cornerRadius: -1 }] }),
  ];
  const { document: d, issues } = await importSketch(
    archive([page("p", layers)]),
    "bounds.sketch",
  );
  const get = (id: string) => d.nodes.find((n) => n.id === id)!;
  const n = get("shape"),
    s = n.style;
  assert.equal(n.name, "a".repeat(16383));
  assert.equal(s.width, 100000);
  assert.equal(s.height, 100000);
  assert.equal(s.rotation, -90);
  assert.equal(s.strokeWidth, 100);
  assert.equal(s.strokeOpacity, 0);
  assert.equal(s.opacity, 0);
  assert.equal(s.paints!.length, 16);
  assert.equal(s.paints![0].id, "p17");
  assert.equal(s.paints![0].opacity, 1);
  assert.deepEqual(s.corners, { tl: 10000, tr: 0, br: 100, bl: 200 });
  assert.equal(s.cornerSmoothing, 1);
  assert.equal(s.shadows!.length, 32);
  const { x, y, spread, blur } = s.shadows![0];
  assert.deepEqual([x, y, spread, blur], [-1000, 1000, 1000, 1000]);
  assert.deepEqual(
    [s.blur, s.backdropBlur, s.backdropSaturation, s.backdropBrightness],
    [100, 512, 4, 0],
  );
  const g = get("gradient").style.gradient!;
  assert.equal(g.stops.length, 64);
  assert.equal(g.stops[0].offset, 0);
  assert.equal(g.stops.at(-1)!.offset, 1);
  assert.equal(get("empty").type, "rectangle");
  assert.ok(
    issues.some(
      (i) => i.node === "empty" && i.detail === "空矢量路径已保留边界",
    ),
  );
  const vector = get("huge").vector!;
  assert.deepEqual([vector.width, vector.height], [10000, 10000]);
  assert.match(vector.paths[0].d, /L10000 10000/);
  const text = get("text");
  assert.equal(text.text, "a".repeat(49999));
  assert.deepEqual(
    [
      text.style.fontSize,
      text.style.fontFamily!.length,
      text.style.letterSpacing,
      text.style.lineHeight,
    ],
    [500, 200, 200, 1000],
  );
  assert.deepEqual(
    [
      get("item").style.rotation,
      get("item").style.width,
      get("item").style.opacity,
    ],
    [180, 100000, 1],
  );
  for (const term of [
    "填充",
    "色标",
    "阴影",
    "圆角",
    "字号",
    "图层名",
    "50000",
    "矢量坐标",
    "旋转",
    "模糊",
    "描边宽度",
  ])
    assert.ok(
      issues.some((i) => i.detail.includes(term)),
      term,
    );
});

test("Sketch clips and orders UTF-16 runs, preserves inline variable axes, and paints a text tint once", () => {
  const attrs = (name: string) => ({
    MSAttributedStringFontAttribute: { attributes: { name, size: 16 } },
  });
  const l = readLayer({
    ...textLayer("t", "abcdef"),
    style: { fills: [{ layeringType: 1, color: blue }] },
    attributedString: {
      string: "abcdef",
      attributes: [
        { location: 4, length: 3, attributes: attrs("B") },
        { location: 0, length: 2, attributes: attrs("A") },
        { location: 1, length: 3, attributes: attrs("B") },
        { location: 3, length: 0.5, attributes: attrs("A") },
      ],
    },
  });
  const issues: string[] = [];
  const n = makeLayer(l, (_, m) => issues.push(m), {
    families: new Map([
      ["A", "Shared"],
      ["B", "Shared"],
    ]),
    instances: new Map([
      ["A", { wdth: 100 }],
      ["B", { wdth: 80 }],
    ]),
  });
  assert.deepEqual(
    n.textRuns?.map((r) => [r.start, r.end, r.style.fontVariationSettings]),
    [
      [2, 4, '"wdth" 80'],
      [4, 6, '"wdth" 80'],
    ],
  );
  assert.equal(n.style.tint?.color, "#0000ff");
  assert.notEqual(n.style.color, "#0000ff");
  assert.ok(issues.some((m) => m.includes("排序")));
  assert.ok(issues.some((m) => m.includes("无效")));
  assert.ok(issues.some((m) => m.includes("裁剪")));
});

test("Sketch names remain unique and valid after clipping, with fallbacks and portable theme subsets", async () => {
  const long = "x".repeat(199) + "😀",
    oversized = "y".repeat(119) + "😀";
  const swatch = (id: string) => ({ do_objectID: id, name: long, value: blue });
  const { document: d } = await importSketch(
    archive(
      [
        {
          ...page("p", [
            master(
              "one",
              [
                shape("bound", {
                  style: { fills: [{ color: { ...blue, swatchID: "a" } }] },
                }),
              ],
              { name: long },
            ),
          ]),
          name: "   ",
        },
        { ...page("two", []), name: oversized },
      ],
      {
        sharedSwatches: { objects: ["a", "b", "c"].map(swatch) },
        layerStyles: {
          objects: ["d", "e"].map((id) => ({
            do_objectID: id,
            name: long,
            value: { fills: [{ color: blue }] },
          })),
        },
        foreignSwatches: [
          {
            libraryID: "f",
            sourceLibraryName: "z".repeat(130),
            localSwatch: swatch("f"),
          },
        ],
        foreignSymbols: [
          {
            libraryID: "f",
            sourceLibraryName: "",
            symbolMaster: master("outside", []),
          },
        ],
      },
    ),
    long + ".sketch",
  );
  assert.equal(d.name, "x".repeat(199));
  assert.deepEqual(
    d.pages!.map((p) => p.name),
    ["页面", "y".repeat(119)],
  );
  const libraries = Object.values(d.libraries!),
    local = libraries.find((l) => l.name === d.name)!;
  assert.equal(local.components[0].name, d.name);
  assert.deepEqual(Object.keys(local.designSystem!.variables), ["a"]);
  assert.equal(
    libraries.find((l) => l.name === "Sketch 外部库")?.designSystem,
    undefined,
  );
  assert.equal(
    Object.values(d.designSystem!.collections).find((c) =>
      c.name.startsWith("z"),
    )!.name.length,
    100,
  );
  for (const table of [d.designSystem!.variables, d.designSystem!.styles]) {
    const defs = Object.values(table)
      .filter((s) => s.id !== "f")
      .map((s) => s.name);
    assert.equal(new Set(defs).size, defs.length);
    assert.ok(
      defs.every((n) => n.length <= 200 && !/[\uD800-\uDBFF]$/.test(n)),
    );
  }
});

test("Sketch reports the malformed source file or layer in Chinese", async () => {
  const valid = {
    "meta.json": { version: 144 },
    "document.json": { do_objectID: "doc", pages: [{ _ref: "pages/p" }] },
    "pages/p.json": page("p", []),
  };
  for (const [key, value, message] of [
    ["meta.json", { version: "abc" }, /Sketch meta\.json 格式无效/],
    ["document.json", {}, /Sketch document\.json 格式无效/],
    ["pages/p.json", { layers: false }, /Sketch pages\/p\.json 格式无效/],
    [
      "pages/p.json",
      page("p", [
        { ...shape("bad"), frame: undefined } as unknown as ReturnType<
          typeof shape
        >,
      ]),
      /Sketch 图层 bad 格式无效/,
    ],
  ] as const) {
    const bytes = zipSync(
      Object.fromEntries(
        Object.entries({ ...valid, [key]: value }).map(([path, row]) => [
          path,
          strToU8(JSON.stringify(row)),
        ]),
      ),
    );
    await assert.rejects(importSketch(bytes, "bad.sketch"), message);
  }
});

test("Sketch fill overrides and color variables follow editable vector and Boolean paints; stale swap targets produce diagnostics", async () => {
  const swatch = (id: string) => ({ name: id, do_objectID: id, value: blue });
  const style = { fills: [{ color: { ...blue, swatchID: "before" } }] };
  const layers = [
    pathLayer("vec", { style }),
    sourceLayer("shapeGroup", "compound", "bool", {
      style,
      layers: [shape("operand")],
    }),
  ];
  const { document: d, issues } = await importSketch(
    archive(
      [
        page("p", [
          master("m", layers),
          instance("i", "m", {
            overrideValues: [
              {
                overrideName: "vec_fillColor",
                value: { ...blue, red: 1, swatchID: "after", alpha: 0.4 },
              },
              { overrideName: "compound_color:fill-0", value: "#ff000080" },
              { overrideName: "vec_symbolID", value: "m" },
              { overrideName: "bad", value: 1 },
            ],
          }),
        ]),
      ],
      { sharedSwatches: { objects: ["before", "after"].map(swatch) } },
    ),
    "fill.sketch",
  );
  for (const id of ["vec", "compound"])
    assert.deepEqual(d.nodes.find((n) => n.id === id)?.variableBindings, {
      fill: "before",
      color: "before",
    });
  const vec = d.nodes.find((n) => n.parentId === "i" && n.type === "vector")!,
    compound = d.nodes.find((n) => n.parentId === "i" && n.booleanOperation)!;
  assert.deepEqual(vec.variableBindings, { fill: "after", color: "after" });
  for (const n of [vec, compound]) {
    assert.equal(n.style.color, n.style.fill);
    assert.equal(n.style.colorOpacity, n.style.fillOpacity);
    for (const key of ["fill", "fillOpacity", "color", "colorOpacity"])
      assert.ok(n.instanceOverrides?.includes("style." + key));
  }
  assert.ok(
    !compound.variableBindings?.color && !compound.variableBindings?.fill,
  );
  assert.ok(issues.some((i) => i.detail.includes("插槽")));
  assert.ok(issues.some((i) => i.detail.includes("分隔符")));
});

test("Sketch shared style swaps discard superseded variable bindings, strokes and effects while retaining other style groups", async () => {
  const style = {
    fills: [{ color: { ...blue, swatchID: "sw" } }],
    borders: [{ color: blue, thickness: 4 }],
    shadows: [{ color: blue, blurRadius: 2 }],
  };
  const text = (size: number) => ({
    textStyle: {
      encodedAttributes: {
        MSAttributedStringFontAttribute: {
          attributes: { name: "Helvetica", size },
        },
        MSAttributedStringColorAttribute: blue,
      },
    },
  });
  const r = await importSketch(
    archive(
      [
        page("p", [
          master("m", [
            shape("rect", { style, sharedStyleID: "old" }),
            {
              ...textLayer("label", "Hi"),
              style: {
                ...text(11),
                textStyle: {
                  encodedAttributes: {
                    ...text(11).textStyle.encodedAttributes,
                    MSAttributedStringColorAttribute: {
                      ...blue,
                      swatchID: "sw",
                    },
                  },
                },
              },
              sharedStyleID: "oldtext",
            },
          ]),
          instance("i", "m", {
            overrideValues: [
              { overrideName: "rect_layerStyle", value: "new" },
              { overrideName: "label_textStyle", value: "newtext" },
            ],
          }),
        ]),
      ],
      {
        sharedSwatches: {
          objects: [{ do_objectID: "sw", name: "sw", value: blue }],
        },
        layerStyles: {
          objects: [
            { do_objectID: "old", name: "old", value: style },
            {
              do_objectID: "new",
              name: "new",
              value: { fills: [{ color: { red: 1 } }] },
            },
          ],
        },
        layerTextStyles: {
          objects: [
            { do_objectID: "oldtext", name: "old", value: text(11) },
            { do_objectID: "newtext", name: "new", value: text(20) },
          ],
        },
      },
    ),
    "styles.sketch",
  );
  const d = r.document,
    rect = d.nodes.find((n) => n.parentId === "i" && n.type === "rectangle")!,
    label = d.nodes.find((n) => n.parentId === "i" && n.type === "text")!;
  assert.deepEqual(Object.keys(rect.styleBindings!), ["paint"]);
  assert.equal(rect.variableBindings?.fill, undefined);
  const resolved = resolveNode(d, rect);
  assert.equal(resolved.style.fill, "#ff0000");
  assert.equal(resolved.style.stroke, undefined);
  assert.equal(resolved.style.shadows, undefined);
  assert.equal(label.variableBindings?.color, undefined);
  assert.equal(resolveNode(d, label).style.fontSize, 20);
});

test("Sketch instance pinning, navigation, capped stack spacing and Smart Layout use constrained child sizes", async () => {
  const smart = { _class: "MSImmutableInferredGroupLayout", axis: 0 };
  const stack = {
    _class: "MSImmutableFlexGroupLayout",
    allGuttersGap: 2000,
    wrappingEnabled: true,
    crossAxisGutterGap: 3000,
  };
  const title = textLayer("txt", "old");
  const m = master(
    "m",
    [shape("stretch", { horizontalPins: 5, horizontalSizing: 2 }), title],
    { groupLayout: smart },
  );
  const { document: d, issues } = await importSketch(
    archive([
      page("p", [
        sourceLayer("artboard", "target", "Target"),
        m,
        instance("i", "m", {
          frame: frame(200),
          verticalPins: 4,
          flow: { destinationArtboardID: "target" },
          overrideValues: [{ overrideName: "txt_stringValue", value: "new" }],
        }),
        instance("back", "m", {
          verticalSizing: 0,
          flow: { destinationArtboardID: "back" },
        }),
        sourceLayer("group", "layout", "layout", {
          topPadding: 2000,
          groupLayout: stack,
        }),
        sourceLayer("group", "negative", "negative", {
          groupLayout: { ...stack, crossAxisGutterGap: -1 },
        }),
        master(
          "huge",
          [
            sourceLayer("text", "growing", "text", {
              textBehaviour: 0,
              frame: frame(99999),
              attributedString: { string: "A", attributes: [] },
            }),
          ],
          { frame: frame(99999), groupLayout: smart },
        ),
        instance("max", "huge", {
          frame: frame(99999),
          overrideValues: [
            { overrideName: "growing_stringValue", value: "A".repeat(100) },
          ],
        }),
      ]),
    ]),
    "layout.sketch",
  );
  const get = (id: string) => d.nodes.find((n) => n.id === id)!;
  assert.equal(get("i").style.width, 200);
  assert.equal(
    d.nodes.find((n) => n.parentId === "i" && n.templateKey === "stretch")!
      .style.width,
    200,
  );
  assert.equal(get("i").style.constraintY, "end");
  assert.deepEqual(get("i").interaction?.actions, [
    { kind: "navigate", target: "target" },
  ]);
  assert.equal(get("back").style.constraintY, "center");
  assert.deepEqual(get("back").interaction?.actions, [{ kind: "back" }]);
  assert.deepEqual(
    [
      get("layout").style.insets?.top,
      get("layout").style.gap,
      get("layout").style.rowGap,
    ],
    [1000, 1000, 1000],
  );
  assert.equal(get("negative").style.layout, "free");
  assert.ok(
    issues.some((i) => i.node === "negative" && i.detail.includes("负间距")),
  );
  assert.ok(
    issues.some(
      (i) =>
        i.detail ===
        "Sketch 智能布局（Smart Layout）已保留当前尺寸，动态布局需复核",
    ),
  );
  assert.equal(get("max").style.width, 100000);
  assert.equal(d.nodes.find((n) => n.parentId === "max")!.style.width, 100000);
});

test("Sketch full-bleed masks retain smoothing, stroke bindings move to the sole operand, and Boolean vectors retain evenodd", async () => {
  const stroke = { borders: [{ thickness: 4, color: blue }] };
  const { document: d } = await importSketch(
    archive(
      [
        page("p", [
          sourceLayer("group", "clip", "clip", {
            layers: [
              shape("mask", {
                hasClippingMask: true,
                style: { corners: { style: 1, radii: [6], smoothing: 0.65 } },
              }),
              shape("body"),
            ],
          }),
          sourceLayer("shapeGroup", "stroked", "stroked", {
            sharedStyleID: "s",
            style: stroke,
            layers: [pathLayer("child")],
          }),
          sourceLayer("shapeGroup", "union", "union", {
            layers: [pathLayer("ring", { style: { windingRule: 1 } })],
          }),
        ]),
      ],
      {
        layerStyles: {
          objects: [{ do_objectID: "s", name: "s", value: stroke }],
        },
      },
    ),
    "mask.sketch",
  );
  const get = (id: string) => d.nodes.find((n) => n.id === id)!;
  assert.equal(get("clip").style.cornerSmoothing, 0.65);
  assert.equal(get("stroked").styleBindings?.stroke, undefined);
  assert.ok(get("child").styleBindings?.stroke);
  assert.equal(resolveNode(d, get("child")).style.strokeWidth, 4);
  assert.equal(booleanVector(d, get("union"))?.paths[0].fillRule, "evenodd");
});

test("Sketch limits swaps to 100 live slots and prevents oversized materialization", async () => {
  const leaves = [master("a", []), master("b", [])];
  const slots = Array.from({ length: 101 }, (_, i) =>
    instance("slot-" + i, "a"),
  );
  const { document: d, issues } = await importSketch(
    archive([
      page("p", [
        ...leaves,
        master("host", slots),
        instance("i", "host", {
          overrideValues: slots.map((l) => ({
            overrideName: l.do_objectID + "_symbolID",
            value: "b",
          })),
        }),
      ]),
    ]),
    "slots.sketch",
  );
  assert.equal(
    Object.keys(d.nodes.find((n) => n.id === "i")!.instance!.slots!).length,
    100,
  );
  assert.ok(issues.some((i) => i.detail.includes("100 个插槽")));
  const lib = Object.values(d.libraries!)[0];
  const host = lib.components.find((c) => c.id === "host")!.variants[0],
    child = lib.components.find((c) => c.id === "b")!.variants[0];
  const base = {
    ...host,
    nodes: [
      host.nodes[0],
      host.nodes[1],
      ...Array.from({ length: 49998 }, (_, i) => ({
        ...host.nodes[0],
        parentId: host.nodes[0].id,
        id: "other-" + i,
        templateKey: "other-" + i,
      })),
    ],
  };
  child.nodes.push({
    ...child.nodes[0],
    parentId: child.nodes[0].id,
    id: "added",
    templateKey: "added",
  });
  assert.throws(
    () =>
      materializeSlots(d, base, {
        [host.nodes[1].templateKey!]: {
          libraryId: lib.id,
          componentId: "b",
          variantId: child.id,
        },
      }),
    /单页图层限制/,
  );
});

test("Sketch splits large libraries by expanded size and retains links to components in later chunks", async () => {
  const leaf = master(
    "leaf",
    Array.from({ length: 899 }, (_, i) => shape("leaf-" + i)),
  );
  const others = Array.from({ length: 51 }, (_, i) =>
    master("outer-" + i, [instance("child-" + i, "leaf")]),
  );
  const { document: d } = await importSketch(
    archive([page("p", [instance("use-last", "outer-50")])], {
      foreignSymbols: [leaf, ...others].map((symbolMaster) => ({
        symbolMaster,
        libraryID: "kit",
        sourceLibraryName: "Kit",
      })),
    }),
    "pack.sketch",
  );
  const libs = Object.values(d.libraries!);
  assert.deepEqual(
    libs.map((l) => l.name),
    ["Kit", "Kit 2"],
  );
  for (const l of libs)
    assert.ok(
      l.components.reduce((n, c) => n + c.variants[0].nodes.length, 0) <= 45000,
    );
  const root = d.nodes[0];
  assert.equal(root.instance!.libraryId, libs[1].id);
  validateInstanceStructure(d, root);
  assert.equal(
    d.nodes.find((n) => n.parentId === root.id)!.nestedSource!.libraryId,
    libs[0].id,
  );
});

test("instance rebuild keeps a matching overridden layout and clears stale master glyph metrics", async () => {
  const { document: d } = await importSketch(
    archive([
      page("p", [
        master("m", [textLayer("t", "Master")]),
        instance("i", "m", {
          overrideValues: [{ overrideName: "t_stringValue", value: "Custom" }],
        }),
      ]),
    ]),
    "layout-cache.sketch",
  );
  const variant = Object.values(d.libraries!)[0].components[0].variants[0],
    template = variant.nodes[1],
    old = d.nodes.find((n) => n.parentId === "i")!;
  const layout = (n: typeof old) => ({
    text: n.text,
    styleKey: textLayoutStyleKey(n.style),
    width: n.style.width,
    height: n.style.height,
    lines: [{ text: n.text, x: Array(n.text.length).fill(0), y: 8 }],
  });
  template.sourceTextLayout = layout(template);
  old.sourceTextLayout = layout(old);
  function rebuild() {
    const op = planSwitchInstance(d, "i", variant.id).find(
      (op) => op.type === "create" && op.node.text === "Custom",
    );
    assert.ok(op?.type === "create");
    return op.node.sourceTextLayout;
  }
  assert.deepEqual(rebuild(), old.sourceTextLayout);
  old.sourceTextLayout.styleKey = "stale";
  assert.equal(rebuild(), undefined);
  template.text = "Custom";
  template.sourceTextLayout = layout(template);
  old.style.fontSize += 4;
  assert.equal(rebuild(), undefined);
});

test("HarfBuzz reuses a buffer and variation font; broken fonts, cyclic parents and a shaping error leave other variants editable", async (t) => {
  const hb = await import("harfbuzzjs");
  const bytes = await readFile(
    new URL("./fixtures/forma-geometry-test.ttf", import.meta.url),
  );
  const valid = new hb.Face(new hb.Blob(bytes), 0);
  const glyph = String.fromCodePoint(
    valid.collectUnicodes().find((cp) => cp > 32)!,
  );
  const text = (id: string, value: string, x = 0) => {
    const n = createNode("text");
    n.id = id;
    n.parentId = "root";
    n.text = value;
    n.style.fontFamily = "face";
    n.style.x = x;
    n.style.width = 300;
    return n;
  };
  const root = createNode("frame");
  root.id = "root";
  const one = text("one", glyph),
    bad = text("bad", glyph);
  bad.style.fontFamily = "bad";
  const loop = text("loop", glyph);
  loop.parentId = loop.id;
  const d: DesignDocument = {
    schemaVersion: 1,
    id: "doc",
    name: "doc",
    nodes: [root, one, bad, loop],
    revision: 0,
    tokens: {},
  };
  const source = await importSketch(
    archive([page("p", [master("m", [])])]),
    "lib.sketch",
  );
  d.libraries = source.document.libraries;
  const c = Object.values(d.libraries!)[0].components[0];
  const groups = [0.25, 0.75].map((x, i) => ({
    ...c.variants[0],
    id: String(i),
    nodes: [{ ...root }, text("duplicate", glyph, x)],
  }));
  // Duplicate parent/child IDs are valid across separate variants.
  c.variants = groups;
  const broken = text("shaping-error", glyph + glyph),
    after = text("after", glyph + glyph + glyph);
  d.nodes.push(broken, after);
  const original = hb.Font.prototype.hExtents;
  let calls = 0;
  t.mock.method(
    hb.Font.prototype,
    "hExtents",
    function (this: InstanceType<typeof hb.Font>) {
      if (++calls === 2) throw Error("shape failure");
      return original.call(this);
    },
  );
  const variations = t.mock.method(hb.Font.prototype, "setVariations");
  const buffers = t.mock.method(hb.Buffer.prototype, "clearContents");
  const warnings: string[] = [];
  await attachSketchTextLayouts(
    d,
    new Map([
      ["face", bytes],
      ["bad", new Uint8Array([0])],
    ]),
    (_, msg) => warnings.push(msg),
  );
  assert.ok(one.sourceTextLayout);
  assert.ok(after.sourceTextLayout);
  assert.equal(bad.sourceTextLayout, undefined);
  assert.ok(warnings.some((m) => m.includes("解码")));
  assert.ok(warnings.some((m) => m.includes("循环")));
  assert.ok(warnings.some((m) => m.includes("排版失败")));
  assert.equal(variations.mock.callCount(), 1);
  assert.equal(new Set(buffers.mock.calls.map((c) => c.this)).size, 1);
  assert.ok(groups.every((v) => v.nodes[1].sourceTextLayout));
  assert.notDeepEqual(
    groups[0].nodes[1].sourceTextLayout!.lines,
    groups[1].nodes[1].sourceTextLayout!.lines,
  );
});

test("Sketch limits bitmap tile scale and imports a macOS sidecar archive", async () => {
  const { unzipSync } = await import("fflate");
  const layers = [0.01, 10].map((patternTileScale, i) =>
    shape(String(i), {
      style: {
        fills: [
          {
            fillType: 4,
            patternFillType: 0,
            patternTileScale,
            image: { _ref: "images/pixel" },
          },
        ],
      },
    }),
  );
  const bytes = zipSync({
    ...unzipSync(archive([page("p", layers)])),
    "__MACOSX/._document.json": strToU8("sidecar"),
    "images/pixel": Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+C9asAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  const { document: d, issues } = await importSketch(bytes, "tile.sketch");
  assert.deepEqual(
    d.nodes.map((n) => n.image!.tileScale),
    [0.1, 8],
  );
  assert.ok(issues.some((i) => i.detail.includes("平铺比例")));
});
