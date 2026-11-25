import test from "node:test";
import assert from "node:assert/strict";
import { makeLayer } from "../src/infrastructure/design-import/figma-layer";
import {
  buildStyles,
  bindStyles,
} from "../src/infrastructure/design-import/figma-styles";
import { parseDocument } from "../src/domain/document";
import { resolveNode } from "../src/domain/design-system";
import { runtimeNodes } from "../src/compiler/runtime";
import { exportNodeToSvg } from "../src/infrastructure/static-export";
import {
  detachReusableStyle,
  planApplyReusableStyle,
} from "../src/domain/design-system-actions";
import { strokeArtwork } from "../src/domain/stroke";
import { transact } from "../src/domain/commands";

test("Figma stacked strokes share width and propagate only unoverridden paints through save, runtime and SVG", () => {
  const ctx = {
    blobs: [],
    images: new Map<string, string>(),
    assetKeys: new Map<string, string>(),
    report: (id: string, detail: string) => assert.fail(id + " " + detail),
  };
  const base = {
    type: "SOLID",
    color: { r: 1, g: 0, b: 0, a: 1 },
    opacity: 0.5,
    blendMode: "MULTIPLY",
  };
  const top = {
    type: "SOLID",
    color: { r: 0, g: 1, b: 0, a: 1 },
    opacity: 0.4,
    blendMode: "SCREEN",
  };
  const styleId = { sessionID: 1, localID: 19 };
  const styleRecord = {
    type: "RECTANGLE",
    name: "Two border paints",
    guid: styleId,
    styleType: "FILL",
    fillPaints: [base, top],
  };
  const sys = buildStyles([styleRecord], ctx),
    style = sys.styles["fig-1-19"];
  const raw = {
    type: "FRAME",
    size: { x: 100, y: 70 },
    strokePaints: [base, { ...top, color: { r: 0, g: 0, b: 1, a: 1 } }],
    strokeAlign: "INSIDE",
    strokeWeight: 3,
    styleIdForStrokeFill: { guid: styleId },
  };
  const layer = makeLayer(raw, "rect", null, ctx);
  const cached = makeLayer(raw, "cached", null, ctx);
  bindStyles(raw, cached, sys, ctx);
  assert.ok(!cached.styleOverrides?.length);
  bindStyles(raw, layer, sys, ctx, { stroke: true });
  const doc = parseDocument(
    JSON.parse(
      JSON.stringify({
        schemaVersion: 1,
        id: "stroke-test",
        name: "Stack",
        revision: 0,
        nodes: [layer],
        tokens: {},
        designSystem: sys,
      }),
    ),
  );
  assert.equal(layer.styleBindings?.stroke, style.id);
  assert.deepEqual(layer.styleOverrides, ["strokePaints.fig-paint-0.color"]);
  doc.designSystem!.styles[style.id].properties.paints![1].color = "#abcdef";
  doc.designSystem!.styles[style.id].properties.paints![0].opacity = 0.7;
  const resolved = resolveNode(doc, doc.nodes[0]).style;
  assert.equal(resolved.strokeWidth, 3);
  assert.deepEqual(
    resolved.strokePaints!.map((p) => [p.color, p.opacity, p.blendMode]),
    [
      ["#0000ff", 0.7, "screen"],
      ["#abcdef", 0.5, "multiply"],
    ],
  );
  const runtime = runtimeNodes(doc)[0];
  assert.deepEqual(
    runtime.strokePaints?.map((p) => [p.background, p.mixBlendMode]),
    [
      ["#abcdef", "multiply"],
      ["#0000ff", "screen"],
    ],
  );
  assert.equal(
    runtime.strokePaints?.[0].maskImage,
    runtime.strokePaints?.[1].maskImage,
  );
  const svg = exportNodeToSvg(doc, "rect");
  assert.ok(svg.includes('stroke-width="3"'));
  assert.ok(
    svg.indexOf('fill="#abcdef"') >= 0 &&
      svg.indexOf('fill="#abcdef"') < svg.indexOf('fill="#0000ff"'),
  );
  const rebound = transact(doc, {
    baseRevision: doc.revision,
    operations: [planApplyReusableStyle(doc.nodes[0], style, "stroke")],
  });
  assert.deepEqual(rebound.nodes[0].styleOverrides, []);
  assert.equal(
    resolveNode(rebound, rebound.nodes[0]).style.strokePaints![0].color,
    "#00ff00",
  );
  const detached = transact(doc, {
    baseRevision: doc.revision,
    operations: [detachReusableStyle(doc, doc.nodes[0], "stroke")],
  });
  assert.equal(detached.nodes[0].styleBindings?.stroke, undefined);
  assert.equal(detached.nodes[0].style.strokePaints![0].color, "#0000ff");
});

test("shared stroke paints retain mode-dependent color and alpha and avoid cached variable overrides", () => {
  const g = (localID: number) => ({ sessionID: 1, localID });
  const base = {
    type: "SOLID",
    color: { r: 1, g: 0, b: 0, a: 1 },
    opacity: 0.2,
    colorVar: { value: { alias: { guid: g(4) } } },
  };
  const top = {
    type: "SOLID",
    color: { r: 0, g: 1, b: 0, a: 1 },
    opacity: 0.5,
  };
  const raw = {
    type: "RECTANGLE",
    guid: g(10),
    strokeWeight: 2,
    strokePaints: [base, top],
    styleIdForStrokeFill: { guid: g(9) },
  };
  const ctx = {
    blobs: [],
    images: new Map<string, string>(),
    assetKeys: new Map<string, string>(),
    report: (id: string, detail: string) => assert.fail(id + " " + detail),
  };
  const sys = buildStyles(
    [
      {
        type: "VARIABLE_SET",
        guid: g(1),
        name: "Colors",
        variableSetModes: [
          { id: g(2), name: "Light" },
          { id: g(3), name: "Dark" },
        ],
      },
      {
        type: "VARIABLE",
        guid: g(4),
        name: "Accent",
        variableSetID: { guid: g(1) },
        variableResolvedType: "COLOR",
        variableDataValues: {
          entries: [
            {
              modeID: g(2),
              variableData: {
                value: { colorValue: { r: 1, g: 0, b: 0, a: 0.2 } },
              },
            },
            {
              modeID: g(3),
              variableData: {
                value: { colorValue: { r: 0, g: 0, b: 1, a: 0.8 } },
              },
            },
          ],
        },
      },
      {
        guid: g(9),
        name: "Border style",
        styleType: "FILL",
        type: "RECTANGLE",
        fillPaints: [base, top],
      },
      raw,
    ],
    ctx,
  );
  const layer = makeLayer(raw, "rect", null, ctx);
  bindStyles(raw, layer, sys, ctx);
  assert.ok(!layer.styleOverrides?.length);
  const doc = parseDocument({
    schemaVersion: 1,
    id: "paints",
    name: "Colors",
    revision: 0,
    tokens: {},
    nodes: [layer],
    designSystem: sys,
  });
  const light = resolveNode(doc, doc.nodes[0]).style.strokePaints![1];
  assert.deepEqual([light.color, light.opacity], ["#ff0000", 0.2]);
  const darkDoc = parseDocument({
    ...doc,
    designSystem: { ...sys, activeModes: { "fig-1-1": "fig-1-3" } },
  });
  const dark = resolveNode(darkDoc, darkDoc.nodes[0]).style.strokePaints!;
  assert.deepEqual([dark[1].color, dark[1].opacity], ["#0000ff", 0.8]);
  const edit = transact(darkDoc, {
    baseRevision: darkDoc.revision,
    operations: [
      {
        type: "update",
        id: layer.id,
        patch: {},
        style: {
          strokePaints: dark.map((p, i) => (i ? p : { ...p, opacity: 0.65 })),
        },
      },
    ],
  });
  assert.deepEqual(edit.nodes[0].styleOverrides, [
    "strokePaints.fig-paint-0.opacity",
  ]);
  assert.equal(resolveNode(edit, edit.nodes[0]).style.strokeWidth, 2);
});

test("unequal rectangular sides span the full corner of a zero-width neighbour", () => {
  const ctx = {
    blobs: [],
    images: new Map<string, string>(),
    assetKeys: new Map<string, string>(),
    report: () => {},
  };
  const node = makeLayer(
    {
      type: "FRAME",
      size: { x: 393, y: 60 },
      strokePaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 1, a: 1 } }],
      strokeWeight: 0.333,
      strokeAlign: "INSIDE",
      borderStrokeWeightsIndependent: true,
      borderTopWeight: 0,
      borderLeftWeight: 0,
      borderRightWeight: 0,
      borderBottomWeight: 10,
    },
    "row",
    null,
    ctx,
  );
  const artwork = strokeArtwork(node.style, 393, 60, "red");
  assert.equal(
    artwork.body,
    '<path d="M0 0H393V60H0ZM0 0H393V50H0Z" fill-rule="evenodd" fill="red"/>',
  );
  assert.deepEqual(artwork.outset, [0, 0, 0, 0]);
  node.style.strokeAlign = "center";
  assert.deepEqual(
    strokeArtwork(node.style, 393, 60, "red").outset,
    [0, 0, 5, 0],
  );
});
