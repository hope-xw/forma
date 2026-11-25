import test from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import {
  importFigma,
  importFigmaSnapshot,
} from "../src/infrastructure/design-import/figma";
import { parseDocument } from "../src/domain/document";
import { validateInstanceStructure } from "../src/domain/library";
import { synchronizeMasters } from "../src/domain/component-masters";

// Independent Kiwi encoder fixture. Two pages (one internal), a text style,
// a local symbol with multilingual text and an instance serialized after it.
const canvas = Buffer.from(
  "ZmlnLWtpd2llAAAAzAAAAEWP4U7DMAyEz2Fs7cpbUYH6g4HoXiC0Xhcpc6o4k1qeHiVQ8cs+nfXduXq9uxFklFVdkK7FAeTDYH1ZzYeNLAlkpnwH0BzUJRcEDUzvvhlkFtSgFTXMmZfU2mRhaLjaaIfEUdGA+vX2FfyfpUV0bcadwsgwzUZP68yZLPaW58Nc4jsZeYHBTnPgDo9py9ljr//oCgcniaNY/y5+BaHStHo+/1LrIrrxJcRcFE84XoKk8kWNps/uJ19AtNV5Y1U7MQxJGPn5amVixZHoB+gAAABFjkFOwlAARGf+/1DFS9CbUEsXJlIWrUa3GtbewGCaikaNkQU7rdUYcUETFq5MOQEHqFtDG7rrEfRj0O28ybyhQVK0u/Zex3F9yPbJMUAKYVvuvuVBLpPZMonL+L28f4IiTY3lH87PwzIYa3CKDYJUwjvsbHd3IYvry3KYQFEcoRYCrQDog6wJ3znwIYvRoIgvoKjMFUcAtOpcpI/5S9qsoru3KrpNv/o3VTT8aPTmZ83PMJtmk2ycvQINGls/g/pNXey4nm+5trOW5snDYnal1da/2iCVrhtr/+S5GA2gKE1srqLfQXwD",
  "base64",
);

test("Figma ZIP and raw snapshot preserve Unicode, paint order, local styles and instance ancestry", async () => {
  for (const bytes of [canvas, zipSync({ "canvas.fig": canvas })]) {
    const result = await importFigma(bytes, "排版.fig");
    const doc = parseDocument(result.document);
    assert.deepEqual(
      doc.pages?.map((p) => p.name),
      ["设计页面"],
    );
    assert.deepEqual(
      doc.nodes.filter((n) => !n.parentId).map((n) => n.name),
      ["按钮实例", "按钮"],
    );
    assert.equal(result.sourceNodes, 7);
    const texts = doc.nodes.filter((n) => n.type === "text");
    assert.equal(texts.length, 2);
    for (const text of texts) {
      assert.equal(text.text, "你好 👩🏽‍💻\ne\u0301 مرحبا");
      assert.equal(
        doc.designSystem!.styles[text.styleBindings!.text!].name,
        "正文",
      );
    }
    const instance = doc.nodes.find((n) => n.instance)!;
    validateInstanceStructure(doc, instance);
    const master = doc.nodes.find((n) => n.name === "按钮" && !n.parentId)!;
    doc.nodes.find((n) => n.parentId === master.id)!.text = "编辑主件";
    assert.equal(synchronizeMasters(doc), true);
    assert.equal(
      doc.nodes.find((n) => n.parentId === instance.id)?.text,
      "编辑主件",
    );
    const saved = JSON.parse(JSON.stringify(doc));
    assert.deepEqual(parseDocument(saved), saved);
  }
});
test("Figma rejects a truncated canvas before constructing an editable document", async () => {
  await assert.rejects(
    importFigma(canvas.subarray(0, canvas.length - 1), "broken.fig"),
    /截断/,
  );
});

test("Figma stacked fills preserve bottom-to-top alpha without a duplicate base", async () => {
  const { makeLayer } =
    await import("../src/infrastructure/design-import/figma-layer");
  const ctx = {
    blobs: [],
    images: new Map<string, string>(),
    assetKeys: new Map<string, string>(),
    report: () => {},
  };
  const node = makeLayer(
    {
      type: "RECTANGLE",
      size: { x: 100, y: 100 },
      fillPaints: [
        { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 0.5 },
        { type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 }, opacity: 0.5 },
      ],
    },
    "test",
    null,
    ctx,
  );
  assert.deepEqual(
    node.style.paints?.map((p) => [p.color, p.opacity]),
    [
      ["#0000ff", 0.5],
      ["#ff0000", 0.5],
    ],
  );
  assert.equal(node.style.fillOpacity, 0);
});

test("Figma retains the independently specified corner radii and smoothing", async () => {
  const { makeLayer } =
    await import("../src/infrastructure/design-import/figma-layer");
  const node = makeLayer(
    {
      type: "RECTANGLE",
      size: { x: 80, y: 44 },
      cornerSmoothing: 0.6,
      rectangleCornerRadiiIndependent: true,
      rectangleTopLeftCornerRadius: 6,
      rectangleTopRightCornerRadius: 22,
      rectangleBottomRightCornerRadius: 10,
      rectangleBottomLeftCornerRadius: 3,
    },
    "rect",
    null,
    { blobs: [], images: new Map(), assetKeys: new Map(), report: () => {} },
  );
  assert.equal(node.style.cornerSmoothing, 0.6);
  assert.deepEqual(node.style.corners, { tl: 6, tr: 22, br: 10, bl: 3 });
});
test("RGBA color variables preserve aliases, mode alpha and independent paint opacity", async () => {
  const { buildStyles, bindStyles } =
    await import("../src/infrastructure/design-import/figma-styles");
  const { makeLayer } =
    await import("../src/infrastructure/design-import/figma-layer");
  const { resolveNode } = await import("../src/domain/design-system");
  const g = (localID: number) => ({ sessionID: 1, localID });
  const c = {
    type: "VARIABLE_SET",
    guid: g(1),
    name: "Theme",
    variableSetModes: [
      { id: g(2), name: "Light" },
      { id: g(3), name: "Dark" },
    ],
  };
  const variable = (id: number, entries: Record<string, unknown>[]) => ({
    type: "VARIABLE",
    guid: g(id),
    name: "Color" + id,
    variableSetID: { guid: g(1) },
    variableResolvedType: "COLOR",
    variableDataValues: {
      entries: entries.map((value, i) => ({
        modeID: g(2 + i),
        variableData: { value },
      })),
    },
  });
  const a = variable(4, [
    { colorValue: { r: 1, g: 0, b: 0, a: 0.2 } },
    { colorValue: { r: 0, g: 0, b: 1, a: 0.8 } },
  ]);
  const b = variable(5, [{ alias: { guid: g(4) } }, { alias: { guid: g(4) } }]);
  const ctx = {
    assetKeys: new Map<string, string>(),
    images: new Map<string, string>(),
    blobs: [],
    report: (id: string, detail: string) => assert.fail(id + " " + detail),
  };
  const system = buildStyles([c, a, b], ctx);
  for (const [index, effective, expectedDark] of [
    [0, 0.2, 0.8],
    [1, 0.1, 0.4],
  ]) {
    const raw = {
      type: "RECTANGLE",
      guid: g(6 + index),
      fillPaints: [
        {
          type: "SOLID",
          color: { r: 1, g: 0, b: 0, a: 1 },
          opacity: effective,
          colorVar: { value: { alias: { guid: g(5) } } },
        },
      ],
    };
    const n = makeLayer(raw, "node", null, ctx);
    bindStyles(raw, n, system, ctx);
    const saved = parseDocument({
      schemaVersion: 1,
      id: "test",
      name: "Modes",
      revision: 0,
      nodes: [n],
      tokens: {},
      designSystem: system,
    });
    const light = resolveNode(saved, saved.nodes[0]).style;
    assert.equal(light.fillOpacity, effective);
    assert.equal(light.fill, "#ff0000");
    const dark = resolveNode(saved, {
      ...saved.nodes[0],
      variableModes: { "fig-1-1": "fig-1-3" },
    }).style;
    assert.equal(dark.fillOpacity, expectedDark);
    assert.equal(dark.fill, "#0000ff");
    const binding = system.variables[n.variableBindings!.fillOpacity!];
    assert.equal(binding.type, "number");
    assert.equal(typeof binding.values["fig-1-2"], "object");

    const detached = { guid: { sessionID: 0xffffffff, localID: 0xffffffff } };
    const stacked = {
      ...raw,
      styleIdForFill: detached,
      styleIdForStrokeFill: detached,
      variableModeBySetMap: { entries: [{ variableSetID: { guid: g(1) } }] },
      fillPaints: [
        ...raw.fillPaints,
        { type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 0.25 },
      ],
    };
    const stack = makeLayer(stacked, "stack", null, ctx);
    bindStyles(stacked, stack, system, ctx);
    const reopened = parseDocument({ ...saved, nodes: [stack] });
    assert.equal(reopened.nodes[0].styleBindings, undefined);
    const changed = resolveNode(reopened, {
      ...reopened.nodes[0],
      variableModes: { "fig-1-1": "fig-1-3" },
    });
    assert.deepEqual(
      changed.style.paints?.map((p) => [p.color, p.opacity]),
      [
        ["#ffffff", 0.25],
        ["#0000ff", expectedDark],
      ],
    );
    const { libraryDesignSystem } =
      await import("../src/domain/library-design-system");
    const subset = libraryDesignSystem(system, [stack]);
    assert.ok(subset?.variables[stack.style.paints![1].opacityVariableId!]);
    const { symbolicNodeCss } = await import("../src/compiler/design-tokens");
    assert.match(
      String(symbolicNodeCss(reopened, changed, {}).background),
      /color-mix\(in srgb, var\(--/,
    );
  }
});

test("Figma centerline strokes keep editable width, connected handles and open ends without a box border", async () => {
  const { makeLayer } =
    await import("../src/infrastructure/design-import/figma-layer");
  const buffer = new ArrayBuffer(12 + 3 * 12 + 2 * 28),
    v = new DataView(buffer);
  v.setUint32(0, 3, true);
  v.setUint32(4, 2, true);
  [
    [0, 0],
    [8, 8],
    [16, 0],
  ].forEach(([x, y], i) => {
    v.setFloat32(16 + 12 * i, x, true);
    v.setFloat32(20 + 12 * i, y, true);
  });
  [0, 1].forEach((a, i) => {
    v.setUint32(48 + 28 * i + 4, a, true);
    v.setUint32(48 + 28 * i + 16, a + 1, true);
  });
  v.setFloat32(48 + 28 + 8, 2, true);
  const raw = {
    type: "VECTOR",
    size: { x: 8, y: 4 },
    vectorData: { vectorNetworkBlob: 0, normalizedSize: { x: 16, y: 8 } },
    strokePaints: [
      { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 0.5 },
    ],
    strokeAlign: "CENTER",
    strokeCap: "ROUND",
    strokeWeight: 1.5,
  };
  const layer = makeLayer(raw, "test", null, {
    images: new Map(),
    assetKeys: new Map(),
    blobs: [{ bytes: new Uint8Array(buffer) }],
    report: (id, detail) => assert.fail(id + " " + detail),
  });
  assert.equal(layer.vector?.paths[0]?.d, "M0 0 L4 4 C5 4 8 0 8 0");
  assert.equal(layer.vector?.paths[0]?.strokeWidth, 1.5);
  assert.equal(layer.vector?.paths[0]?.lineCap, "round");
  assert.equal(layer.style.strokeWidth, undefined);
  assert.equal(layer.vector?.overflowVisible, true);
  assert.equal(layer.style.color, "#ff0000");
  assert.equal(layer.style.colorOpacity, 0.5);
});

test("a single Figma paint style drives both a fill and a stroke while each shape keeps its line width", async () => {
  const { buildStyles, bindStyles } =
    await import("../src/infrastructure/design-import/figma-styles");
  const { makeLayer } =
    await import("../src/infrastructure/design-import/figma-layer");
  const { resolveNode } = await import("../src/domain/design-system");
  const id = { sessionID: 1, localID: 9 },
    c = { r: 1, g: 0, b: 0, a: 1 },
    solid = { type: "SOLID", color: c, opacity: 0.5 };
  const source = {
    type: "RECTANGLE",
    styleType: "FILL",
    guid: id,
    name: "Brand",
    fillPaints: [solid],
  };
  const ctx = {
    images: new Map<string, string>(),
    assetKeys: new Map<string, string>(),
    blobs: [],
    report: (id: string, detail: string) => assert.fail(id + " " + detail),
  };
  const system = buildStyles([source], ctx);
  const nodes = [
    { type: "RECTANGLE", styleIdForFill: { guid: id }, fillPaints: [solid] },
    {
      type: "FRAME",
      styleIdForStrokeFill: { guid: id },
      strokePaints: [solid],
      strokeWeight: 7,
      strokeAlign: "INSIDE",
    },
  ].map((r, i) => {
    const n = makeLayer(r, "layer-" + i, null, ctx);
    bindStyles(r, n, system, ctx);
    return n;
  });
  assert.equal(nodes[0].styleBindings?.paint, nodes[1].styleBindings?.stroke);
  system.styles["fig-1-9"].properties.fill = "#00ff00";
  system.styles["fig-1-9"].properties.fillOpacity = 0.8;
  const doc = parseDocument({
    schemaVersion: 1,
    id: "test",
    name: "Stroke",
    revision: 0,
    nodes,
    tokens: {},
    designSystem: system,
  });
  assert.equal(resolveNode(doc, doc.nodes[0]).style.fill, "#00ff00");
  const s = resolveNode(doc, doc.nodes[1]).style;
  assert.equal(s.stroke, "#00ff00");
  assert.equal(s.strokeOpacity, 0.8);
  assert.equal(s.strokeWidth, 7);
});

test("Figma glyph commands retain the source baseline for a single-color font and reject incomplete coverage", async () => {
  const { readGlyphShape, prepareGlyphShapes } =
    await import("../src/infrastructure/design-import/figma-glyphs");
  const { makeLayer } =
    await import("../src/infrastructure/design-import/figma-layer");
  const bytes = new Uint8Array(28),
    view = new DataView(bytes.buffer);
  for (const [i, [op, x, y]] of [
    [1, 0, 0],
    [2, 0.5, 0.5],
    [2, 1, 0],
  ].entries()) {
    bytes[i * 9] = op;
    view.setFloat32(i * 9 + 1, x, true);
    view.setFloat32(i * 9 + 5, y, true);
  }
  const glyph = {
    commandsBlob: 0,
    firstCharacter: 0,
    position: { x: 3, y: 20 },
    fontSize: 10,
  };
  const raw = {
    type: "TEXT",
    fontSize: 10,
    fontName: { family: "Missing Typeface", style: "Regular" },
    size: { x: 32, y: 24 },
    textData: { characters: "字" },
    fillPaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
    derivedTextData: {
      layoutSize: { x: 32, y: 24 },
      truncationStartIndex: -1,
      fontMetaData: [{ key: { family: "Missing Typeface" } }],
      glyphs: [glyph],
    },
  };
  const ctx = {
    blobs: [{ bytes }],
    images: new Map<string, string>(),
    assetKeys: new Map<string, string>(),
    report: (id: string, detail: string) => assert.fail(id + " " + detail),
  };
  const n = makeLayer(raw, "test", null, ctx);
  assert.deepEqual(readGlyphShape(raw, n, ctx.blobs), {
    d: "M3 20 L8 15 L13 20 Z",
    width: 32,
    height: 24,
  });
  const centered = {
    ...raw,
    derivedTextData: {
      ...raw.derivedTextData,
      baselines: [{ position: { x: 0, y: 20 }, lineY: 3.5 }],
    },
  };
  assert.deepEqual(readGlyphShape(centered, n, ctx.blobs), {
    d: "M3 20 L8 15 L13 20 Z",
    coverageOffsets: [{ start: 0, shiftY: 0.5 }],
    width: 32,
    height: 24,
  });
  const doc = (await importFigma(canvas, "test.fig")).document;
  const source = {
    ...raw,
    fontName: { ...raw.fontName, family: "system-ui" },
    derivedTextData: {
      ...raw.derivedTextData,
      fontMetaData: [{ key: { family: "system-ui" } }],
    },
  };
  const available = makeLayer(source, "system-font", null, ctx);
  const collector = prepareGlyphShapes(ctx);
  collector.apply(doc, [{ source, layer: available }]);
  assert.equal(
    available.sourceTextShape?.d,
    "M3 20 L8 15 L13 20 Z",
    "Original font revision wins over a same-name local font",
  );
  collector.finish();
  assert.ok("reason" in readGlyphShape(raw, n, []));
  assert.ok("reason" in readGlyphShape(raw, { ...n, text: "改" }, ctx.blobs));
  assert.ok("reason" in readGlyphShape(raw, n, [{ bytes: Uint8Array.of(0) }]));
  assert.ok(
    "reason" in
      readGlyphShape({ ...raw, strokePaints: raw.fillPaints }, n, ctx.blobs),
  );
});

test("Figma auto-layout defaults to a painted border without consuming padding and honors explicit bordersTakeSpace", async () => {
  const { makeLayer } =
    await import("../src/infrastructure/design-import/figma-layer");
  const { flowInsets } = await import("../src/domain/sizing");
  const raw = {
    type: "FRAME",
    stackMode: "HORIZONTAL",
    stackHorizontalPadding: 100,
    strokeWeight: 10,
    strokeAlign: "INSIDE",
    strokePaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 } }],
  };
  const ctx = {
    blobs: [],
    images: new Map<string, string>(),
    assetKeys: new Map<string, string>(),
    report: (id: string, detail: string) => assert.fail(id + " " + detail),
  };
  for (const include of [undefined, false, true]) {
    const layer = makeLayer(
      { ...raw, bordersTakeSpace: include },
      "frame",
      null,
      ctx,
    );
    assert.equal(layer.style.strokeWidth, 10);
    assert.equal(flowInsets(layer).left, include ? 110 : 100);
  }
});

test("editable Figma glass samples the live rounded plate and follows its geometry, theme and optical limits", async () => {
  const { createNode } = await import("../src/domain/document");
  const { createStarter } = await import("../src/domain/seed");
  const { sampleGlass, exposeSurface } =
    await import("../src/compiler/figma-glass");
  const { exportNodeToSvg } =
    await import("../src/infrastructure/static-export");
  const { makeLayer } =
    await import("../src/infrastructure/design-import/figma-layer");
  const plate = createNode("frame"),
    knob = createNode("frame"),
    lens = createNode("frame");
  plate.id = "background-plate";
  knob.parentId = plate.id;
  lens.parentId = knob.id;
  Object.assign(plate.style, {
    fill: "#29ad50",
    cornerSmoothingModel: "figma",
    layout: "free",
    width: 76,
    height: 34,
    radius: 21,
    fillOpacity: 1,
  });
  Object.assign(knob.style, { x: 9, y: -4, fillOpacity: 0 });
  Object.assign(lens.style, {
    x: -2,
    y: -1,
    width: 60,
    height: 40,
    radius: 30,
    figmaGlass: {
      visible: true,
      radius: 0,
      refractionRadius: 7,
      refractionIntensity: 0.8,
      density: 1.65,
      bevelSize: 1,
      chromaticAberration: 0,
    },
  });
  const doc = { ...createStarter(), nodes: [plate, knob, lens] };
  const style = { background: "rgba(255,255,255,.09)" };
  const g = sampleGlass(lens, doc, style)!;
  assert.equal(g.ancestor, plate.id);
  assert.deepEqual(
    [
      g.source.left,
      g.source.top,
      g.source.width,
      g.source.height,
      g.source.borderRadius,
    ],
    [-7, 5, 76, 34, 21],
  );
  assert.match(String(g.source.background), /#29ad50/);
  assert.equal(style.background, "transparent");
  assert.equal(g.face.background, "rgba(255,255,255,.09)");
  assert.ok(exportNodeToSvg(doc, plate.id).includes('stdDeviation="0.8"'));
  Object.assign(plate.style, {
    width: 104,
    height: 48,
    radius: 17,
    fill: "#152466",
  });
  Object.assign(knob.style, { x: 18, y: 3 });
  plate.style.glassEnvironment = "#ffffff";
  assert.equal(sampleGlass(lens, doc, {})?.capturedEnvironment, true);
  const next = sampleGlass(lens, doc, {})!;
  assert.deepEqual(
    [
      next.source.left,
      next.source.top,
      next.source.width,
      next.source.height,
      next.source.borderRadius,
    ],
    [-16, -2, 104, 48, 17],
  );
  assert.match(String(next.source.background), /#152466/);
  const themed = { background: "var(--surface-state)" };
  exposeSurface(plate, themed);
  assert.equal(
    Object.values(themed).filter((x) => x === "var(--surface-state)").length,
    2,
  );
  const section = createNode("section");
  section.style.fill = "#000000";
  section.style.fillOpacity = 0.1;
  plate.parentId = section.id;
  doc.nodes.push(section);
  const translucent = sampleGlass(lens, doc, {})!;
  assert.equal(translucent.environment, "#e6e6e6");
  assert.equal(translucent.layer.background, "#cfcfcf");
  section.style.fill = "#ff0000";
  section.style.fillOpacity = 0.5;
  const changed = sampleGlass(lens, doc, {})!;
  assert.equal(changed.environment, "#ff8080");
  assert.equal(changed.layer.background, "#ff4040");
  section.style.fillOpacity = 1;
  assert.equal(sampleGlass(lens, doc, {})!.layer.background, "#ff0000");
  lens.style.figmaGlass!.chromaticAberration = 0.4;
  assert.equal(sampleGlass(lens, doc, {})?.floorOnly, true);
  const layer = makeLayer(
    {
      type: "FRAME",
      size: { x: 70, y: 44 },
      effects: [{ type: "FOREGROUND_BLUR", radius: 6, visible: true }],
    },
    "blur",
    null,
    { blobs: [], images: new Map(), assetKeys: new Map(), report: () => {} },
  );
  assert.equal(layer.style.blur, 3);
});

test("a linked archived Figma paint stays editable and supersedes stale local paints until an instance overrides it", async () => {
  const { buildStyles, bindStyles } =
    await import("../src/infrastructure/design-import/figma-styles");
  const { makeLayer } =
    await import("../src/infrastructure/design-import/figma-layer");
  const { resolveNode } = await import("../src/domain/design-system");
  const ctx = {
    images: new Map<string, string>(),
    assetKeys: new Map<string, string>(),
    blobs: [],
    report: (_id: string, text: string) => assert.fail(text),
  };
  const id = { sessionID: 3, localID: 2 };
  const paint = (r: number, g: number, b: number, opacity: number) => ({
    type: "SOLID",
    color: { r, g, b, a: 1 },
    opacity,
  });
  const system = buildStyles(
    [
      {
        name: "Historic paint",
        type: "RECTANGLE",
        styleType: "FILL",
        guid: id,
        isSoftDeleted: true,
        fillPaints: [paint(1, 0, 0, 0.97)],
      },
    ],
    ctx,
  );
  const raw = {
    type: "RECTANGLE",
    styleIdForFill: { guid: id },
    fillPaints: [paint(0, 0, 0, 1), paint(1, 1, 1, 0.5)],
  };
  const linked = makeLayer(raw, "linked", null, ctx);
  const overridden = makeLayer(raw, "overridden", null, ctx);
  bindStyles(raw, linked, system, ctx);
  bindStyles(raw, overridden, system, ctx, { fill: true });
  const doc = parseDocument({
    schemaVersion: 1,
    id: "archived",
    name: "Archived paints",
    revision: 0,
    nodes: [linked, overridden],
    tokens: {},
    designSystem: system,
  });
  assert.equal(doc.designSystem!.styles["fig-3-2"].sourceArchived, true);
  assert.equal(resolveNode(doc, doc.nodes[0]).style.fill, "#ff0000");
  assert.equal(resolveNode(doc, doc.nodes[0]).style.fillOpacity, 0.97);
  assert.equal(resolveNode(doc, doc.nodes[0]).style.paints, undefined);
  assert.equal(resolveNode(doc, doc.nodes[1]).style.paints?.length, 2);
});

test("Figma keeps nine-stop angular paint and the radial paint above it through a native round trip", async () => {
  const { makeLayer } =
    await import("../src/infrastructure/design-import/figma-layer");
  const { gradientCss } = await import("../src/compiler/paints");
  const stop = (position: number) => ({
    position,
    color: { r: position, g: 0, b: 1 - position, a: 1 },
  });
  const angular = {
    type: "GRADIENT_ANGULAR",
    transform: { m00: 0, m01: -1, m02: 1, m10: 1, m11: 0, m12: 0 },
    stops: Array.from({ length: 9 }, (_, i) => stop(i / 8)),
  };
  const radial = {
    type: "GRADIENT_RADIAL",
    transform: { m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 },
    stops: [stop(0), stop(1)],
  };
  const raw = {
    type: "RECTANGLE",
    size: { x: 36, y: 36 },
    fillPaints: [angular, radial],
  };
  const node = makeLayer(raw, "gradient", null, {
    images: new Map(),
    assetKeys: new Map(),
    blobs: [],
    report: (_id, detail) => assert.fail(detail),
  });
  const saved = parseDocument(
    JSON.parse(
      JSON.stringify({
        schemaVersion: 1,
        id: "polar",
        name: "Polar",
        revision: 0,
        nodes: [node],
        tokens: {},
      }),
    ),
  );
  const [top, bottom] = saved.nodes[0].style.paints!;
  assert.deepEqual(
    bottom.gradient!.stops.map((s) => s.offset),
    angular.stops.map((s) => s.position),
  );
  assert.ok(
    gradientCss(bottom.gradient!, 1).startsWith(
      "conic-gradient(from 0deg at 50% 50%",
    ),
  );
  assert.ok(
    gradientCss(top.gradient!, 1).startsWith(
      "radial-gradient(ellipse 50% 50% at 50% 50%",
    ),
  );
});

test("removing nested editor sections preserves inherited Figma variable modes on each exported scene", async () => {
  const { createNode } = await import("../src/domain/document");
  const { createStarter } = await import("../src/domain/seed");
  const { unwrapSectionsAndSlices } = await import("../src/compiler/runtime");
  const outer = createNode("section"),
    inner = createNode("section", outer.id),
    frame = createNode("frame", inner.id),
    sibling = createNode("frame", outer.id);
  outer.variableModes = { accent: "pink", appearance: "dark" };
  inner.variableModes = { accent: "purple", size: "large" };
  frame.variableModes = { size: "medium" };
  const doc = { ...createStarter(), nodes: [outer, inner, frame, sibling] };
  const result = unwrapSectionsAndSlices(doc);
  assert.deepEqual(result.nodes.find((n) => n.id === frame.id)?.variableModes, {
    accent: "purple",
    appearance: "dark",
    size: "medium",
  });
  assert.deepEqual(
    result.nodes.find((n) => n.id === sibling.id)?.variableModes,
    { accent: "pink", appearance: "dark" },
  );
  assert.deepEqual(frame.variableModes, { size: "medium" });
});

test("fractional linear-burn strokes use independent channel coverage without a backdrop URL", async () => {
  const { createNode } = await import("../src/domain/document");
  const { createStarter } = await import("../src/domain/seed");
  const { blendedStrokePaint } = await import("../src/compiler/layer-blend");
  const shape = createNode("rectangle");
  Object.assign(shape.style, {
    width: 80,
    height: 31,
    radius: 16,
    strokeWidth: 0.5,
    stroke: "#80ccff",
    strokeBlendMode: "plus-darker",
    strokeOpacity: 0.5,
    strokeAlign: "inside",
  });
  const doc = { ...createStarter(), nodes: [shape] };
  const paints = blendedStrokePaint(shape, doc)!;
  assert.deepEqual(
    paints.map((p) => p.mixBlendMode),
    ["color-burn", "color-burn", "multiply"],
  );
  assert.deepEqual(
    paints.map((p) => p.backgroundColor),
    ["rgb(128 255 255)", "rgb(255 204 255)", "#80ccff"],
  );
  assert.equal(paints[2].opacity, 0.5);
  for (const [index, c] of [128, 204].entries()) {
    const svg = decodeURIComponent(String(paints[index].maskImage));
    const levels = svg
      .match(/tableValues="([^"]+)"/)![1]
      .split(" ")
      .map(Number);
    const alpha = 0.5 * 0.5;
    assert.ok(
      Math.abs(levels[16] - (alpha * c) / (255 * (1 - alpha) + alpha * c)) <
        1e-6,
    );
    assert.equal(paints[index].backdropFilter, undefined);
  }
});

test("an explicitly unnamed Figma layer stays unnamed after saving", async () => {
  const { makeLayer } =
    await import("../src/infrastructure/design-import/figma-layer");
  const ctx = {
    images: new Map<string, string>(),
    assetKeys: new Map<string, string>(),
    blobs: [],
    report: (_id: string, message: string) => assert.fail(message),
  };
  const nodes = [
    makeLayer({ type: "SECTION", name: "" }, "section", null, ctx),
    makeLayer({ type: "FRAME" }, "frame", null, ctx),
  ];
  const saved = parseDocument(
    JSON.parse(
      JSON.stringify({
        schemaVersion: 1,
        id: "names",
        name: "Imported",
        revision: 0,
        nodes,
        tokens: {},
      }),
    ),
  );
  assert.deepEqual(
    saved.nodes.map((n) => n.name),
    ["", "FRAME"],
  );
});

const figId = (localID: number) => ({ sessionID: 1, localID });
const figNode = (
  id: number,
  type: string,
  parent?: number,
  extra: Record<string, unknown> = {},
) => ({
  guid: figId(id),
  type,
  name: type,
  ...(parent === undefined
    ? {}
    : {
        parentIndex: {
          guid: figId(parent),
          position: String(id).padStart(8, "0"),
        },
      }),
  ...extra,
});
function decodedFigma(nodes: unknown[], name = "project.fig") {
  return importFigmaSnapshot(
    { version: 101, extra: false, message: { nodeChanges: nodes } },
    name,
    "a".repeat(64),
  );
}
test("Figma import bounds UTF-16 metadata, variant properties and text; frame-nested sections stay editable through reopen", async () => {
  const boundary = (n: number) => "a".repeat(n - 1) + "😀";
  const property = "State=" + boundary(200);
  const { document, issues } = await decodedFigma(
    [
      figNode(0, "DOCUMENT"),
      figNode(1, "CANVAS", 0, { name: boundary(120) }),
      figNode(2, "SECTION", 1),
      figNode(3, "SECTION", 2),
      figNode(4, "FRAME", 1, { isStateGroup: true, name: boundary(200) }),
      figNode(5, "SYMBOL", 4, { name: property }),
      figNode(6, "SECTION", 5),
      figNode(7, "SECTION", 6),
      figNode(8, "TEXT", 7, { textData: { characters: boundary(50000) } }),
      figNode(9, "CANVAS", 0, { name: "   " }),
    ],
    boundary(200) + ".fig",
  );
  const d = parseDocument(document);
  const lib = Object.values(d.libraries!)[0],
    c = lib.components[0],
    v = c.variants[0];
  assert.equal(d.name, "a".repeat(199));
  assert.equal(lib.source.name, d.name);
  assert.deepEqual(
    d.pages!.map((p) => p.name),
    ["a".repeat(119), "页面"],
  );
  assert.equal(c.name, "a".repeat(199));
  assert.equal(v.name, property.slice(0, 200));
  assert.equal(v.properties.State, "a".repeat(199));
  assert.deepEqual(
    d.nodes.filter((n) => n.name === "SECTION").map((n) => n.type),
    ["section", "section", "frame", "frame"],
  );
  assert.ok(
    v.nodes
      .filter((n) => n.name === "SECTION")
      .every((n) => n.type === "frame"),
  );
  assert.equal(d.nodes.find((n) => n.type === "text")!.text, "a".repeat(49999));
  assert.ok(issues.some((i) => i.detail.includes("50000")));
  assert.ok(issues.some((i) => i.detail.includes("分区")));
});

test("Figma removes tombstones and all descendants before indexing, while rejecting unknown phases and a removed document root", async () => {
  const base = [figNode(0, "DOCUMENT"), figNode(1, "CANVAS", 0)];
  const rows = [
    ...base,
    figNode(9, "TEXT", 8),
    figNode(8, "GROUP", 7),
    figNode(7, "FRAME", 1),
    { guid: figId(7), phase: "REMOVED" },
    figNode(10, "RECTANGLE", 1),
  ];
  const result = await decodedFigma(rows);
  assert.deepEqual(
    parseDocument(result.document).nodes.map((n) => n.id),
    ["fig-1-10"],
  );
  await assert.rejects(
    decodedFigma([...base, figNode(2, "FRAME", 1, { phase: "CHANGED" })]),
    /增量/,
  );
  await assert.rejects(
    decodedFigma([...base, { guid: figId(0), phase: "REMOVED" }]),
    /文档根/,
  );
});

test("Figma instances own their mutable paints and unresolved override samples are bounded", async () => {
  const stale = Array.from({ length: 12 }, (_, i) => ({
    guidPath: { guids: [figId(100 + i)] },
    visible: false,
  }));
  const symbolData = { symbolID: figId(2), symbolOverrides: stale };
  const { document: d, issues } = await decodedFigma([
    figNode(0, "DOCUMENT"),
    figNode(1, "CANVAS", 0),
    figNode(2, "SYMBOL", 1),
    figNode(3, "RECTANGLE", 2, {
      fillPaints: [
        { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } },
        { type: "SOLID", color: { r: 0, g: 1, b: 0, a: 1 } },
      ],
    }),
    figNode(4, "INSTANCE", 1, { symbolData }),
    figNode(5, "INSTANCE", 1, { symbolData }),
  ]);
  const copies = d.nodes.filter((n) => n.templateKey && n.type === "rectangle");
  const original = Object.values(d.libraries!)[0].components[0].variants[0]
    .nodes[1];
  assert.equal(copies.length, 2);
  const other = structuredClone(copies[1].style),
    template = structuredClone(original.style);
  copies[0].style.paints![0].opacity = 0.123;
  assert.deepEqual(copies[1].style, other);
  assert.deepEqual(original.style, template);
  const details = issues.filter((i) => i.detail.includes("12 处"));
  assert.equal(details.length, 2);
  assert.ok(
    details.every(
      (i) =>
        i.detail.includes("fig-1-102") &&
        !i.detail.includes("fig-1-103") &&
        i.detail.length < 300,
    ),
  );
});

test("Figma hashes only the selected byte view without allocating a copy", async (t) => {
  const padded = new Uint8Array(canvas.length + 63);
  padded.set(canvas, 12);
  const view = padded.subarray(12, 12 + canvas.length),
    digest = t.mock.method(crypto.subtle, "digest");
  const a = await importFigma(view, "p.fig");
  const input = digest.mock.calls[0].arguments[1] as Uint8Array;
  assert.equal(input.buffer, padded.buffer);
  assert.equal(input.byteOffset, 12);
  assert.equal(input.byteLength, canvas.length);
  const b = await importFigma(canvas, "p.fig");
  assert.deepEqual(
    Object.keys(a.document.libraries!),
    Object.keys(b.document.libraries!),
  );
});

test("Figma packs more than 200 private slot contents and puts expanded component sets into libraries below the node budget", async () => {
  const nodes: Record<string, unknown>[] = [
    figNode(0, "DOCUMENT"),
    figNode(1, "CANVAS", 0),
    figNode(2, "CANVAS", 0, { internalOnly: true }),
  ];
  const defs = figId(50);
  const assignments = [];
  for (let i = 0; i < 201; i++) {
    const id = 100 + i;
    nodes.push(figNode(id, "FRAME", 2, { isSlotContent: true }));
    assignments.push({
      defID: defs,
      varValue: { value: { slotContentIdValue: { guid: figId(id) } } },
    });
  }
  nodes.push(figNode(4, "FRAME", 2, { componentPropAssignments: assignments }));
  // Count actual expansion: each of 51 variants contains an instance of a 990-layer symbol.
  nodes.push(figNode(500, "SYMBOL", 2));
  for (let i = 0; i < 989; i++) nodes.push(figNode(1000 + i, "RECTANGLE", 500));
  nodes.push(figNode(2100, "FRAME", 2, { isStateGroup: true }));
  for (let i = 0; i < 51; i++) {
    nodes.push(
      figNode(2200 + i, "SYMBOL", 2100),
      figNode(2300 + i, "INSTANCE", 2200 + i, {
        symbolData: { symbolID: figId(500) },
      }),
    );
  }
  nodes.push(
    figNode(6, "INSTANCE", 1, { symbolData: { symbolID: figId(2250) } }),
  );
  const { document } = await decodedFigma(nodes);
  const d = parseDocument(document),
    libs = Object.values(d.libraries!);
  const slots = libs
    .flatMap((l) => l.components)
    .filter((c) => c.category === "Figma 插槽内容");
  assert.deepEqual(
    slots.map((c) => c.variants.length),
    [200, 1],
  );
  assert.equal(new Set(slots.map((c) => c.id)).size, 2);
  assert.ok(libs.length >= 2);
  for (const l of libs)
    assert.ok(
      l.components
        .flatMap((c) => c.variants)
        .reduce((count, v) => count + v.nodes.length, 0) <= 45000,
    );
  const instance = d.nodes.find((n) => n.instance)!;
  validateInstanceStructure(d, instance);
  const nested = d.nodes.find((n) => n.nestedSource)!;
  assert.ok(
    d.libraries![nested.nestedSource!.libraryId].components.some(
      (c) => c.id === nested.nestedSource!.componentId,
    ),
  );
});
