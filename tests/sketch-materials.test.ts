import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { unzlibSync } from "fflate";
import {
  configurePdfReader,
  rasterizeSketchPdf,
} from "../src/infrastructure/design-import/sketch-image";
import { createStarter } from "../src/domain/seed";
import { createNode, parseDocument } from "../src/domain/document";
import { layoutBounds } from "../src/domain/geometry";
import { nodeCss } from "../src/compiler/react";
import { applyModernLayout } from "../src/infrastructure/design-import/sketch-layout";

test("reversed fill tracks share an outer basis even when their insets differ", () => {
  const doc = createStarter(),
    frame = createNode("frame"),
    left = createNode("frame", frame.id),
    right = createNode("frame", frame.id);
  Object.assign(frame.style, {
    layout: "row",
    layoutReverse: true,
    width: 101,
    gap: 0,
    padding: 0,
  });
  Object.assign(left.style, { widthMode: "fill", padding: 4 });
  Object.assign(right.style, { widthMode: "fill", padding: 2 });
  doc.nodes = [frame, left, right];
  const shared = Object.entries(nodeCss(frame, doc)).find(([key]) =>
    key.startsWith("--forma-fill-"),
  );
  assert.ok(shared);
  assert.equal(shared[1], "8px");
  for (const child of [left, right]) {
    assert.equal(nodeCss(child, doc).flexBasis, "var(" + shared[0] + ", 0px)");
    assert.equal(layoutBounds(doc).get(child.id)?.width, 50.5);
  }
});

test("a freeform Sketch frame paints a centered stroke without growing its layout box", () => {
  const doc = createStarter(),
    frame = createNode("frame");
  Object.assign(frame.style, {
    stroke: "#4477aa",
    strokeWidth: 3,
    strokeAlign: "center",
    strokeVisible: true,
  });
  applyModernLayout(
    frame,
    {
      _class: "group",
      do_objectID: "freeform-frame",
      name: "Swatch",
      frame: { x: 0, y: 0, width: 30, height: 30 },
      layers: [],
      groupLayout: { _class: "MSImmutableFreeformGroupLayout" },
    },
    assert.fail,
  );
  doc.nodes = [frame];
  assert.equal(frame.style.strokeInLayout, false);
  const css = nodeCss(frame, doc);
  assert.equal(
    css["--forma-center-stroke"],
    "inset 0 0 0 calc(3px / 2) #4477aa, 0 0 0 calc(3px / 2) #4477aa",
  );
  assert.match(String(css.boxShadow), /--forma-center-stroke/);
});

test("reverse stacks preserve paint order, fill sizing and physical alignment after reopen", () => {
  const doc = createStarter(),
    board = createNode("frame"),
    first = createNode("rectangle", board.id),
    last = createNode("rectangle", board.id);
  Object.assign(board.style, {
    x: 0,
    y: 0,
    width: 100,
    height: 24,
    padding: 0,
    gap: 4,
    layout: "row",
    layoutReverse: true,
    alignX: "start",
  });
  Object.assign(first.style, { width: 30, height: 24 });
  Object.assign(last.style, { width: 10, height: 24, widthMode: "fill" });
  doc.nodes = [board, first, last];
  const reopened = parseDocument(doc),
    boxes = layoutBounds(reopened),
    css = nodeCss(reopened.nodes[0], reopened);
  assert.deepEqual(
    reopened.nodes.map((n) => n.id),
    [board.id, first.id, last.id],
  );
  assert.equal(boxes.get(first.id)?.x, 70);
  assert.equal(boxes.get(last.id)?.x, 0);
  assert.equal(boxes.get(last.id)?.width, 66);
  assert.equal(css.display, "flex");
  assert.equal(css.flexDirection, "row-reverse");
  assert.equal(css.justifyContent, "start");
});

test("single neutral Plus Darker subtracts backdrop channels without blending its children", () => {
  const doc = createStarter(),
    node = createNode("frame");
  Object.assign(node.style, {
    fill: "#cccccc",
    fillBlendMode: "plus-darker",
    backdropBlur: 112.5,
    backdropBrightness: 0.8,
    backdropSaturation: 1.3,
    sketchGlass: { depth: 12, distortion: 0.2 },
  });
  doc.nodes = [node];
  const saved = parseDocument(doc),
    css = nodeCss(saved.nodes[0], saved);
  assert.equal(saved.nodes[0].style.sketchGlass?.depth, 12);
  assert.equal(css.background, "transparent");
  assert.equal(css.mixBlendMode, undefined);
  assert.match(
    String(css.backdropFilter),
    /^blur\(112.5px\) saturate\(1.3\) brightness\(0.8\) brightness\(0.714/,
  );
  node.style.fillBlendMode = "plus-lighter";
  assert.equal(nodeCss(node, doc).mixBlendMode, "plus-lighter");
});

function twoPixelPdf() {
  const drawing = "1 0 0 rg 0 0 1 1 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2 1] /Resources << >> /Contents 4 0 R >>",
    "<< /Length " + drawing.length + " >>\nstream\n" + drawing + "\nendstream",
  ];
  let source = "%PDF-1.4\n";
  const offsets = objects.map((obj, index) => {
    const offset = source.length;
    source += index + 1 + " 0 obj\n" + obj + "\nendobj\n";
    return offset;
  });
  const xref = source.length;
  source +=
    "xref\n0 5\n0000000000 65535 f \n" +
    offsets
      .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
      .join("") +
    "trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n" +
    xref +
    "\n%%EOF\n";
  return new TextEncoder().encode(source);
}
test("local PDF image decoder preserves transparent pixels, dimensions and red/blue channel order", async () => {
  configurePdfReader(
    async () =>
      new Uint8Array(
        await readFile(
          new URL(
            "../node_modules/@embedpdf/pdfium/dist/pdfium.wasm",
            import.meta.url,
          ),
        ),
      ).buffer,
  );
  const png = await rasterizeSketchPdf(twoPixelPdf());
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  assert.equal(view.getUint32(16), 2);
  assert.equal(view.getUint32(20), 1);
  const size = view.getUint32(33);
  const pixels = unzlibSync(png.subarray(41, 41 + size));
  assert.deepEqual([...pixels], [0, 255, 0, 0, 255, 0, 0, 0, 0]);
});

test("serialized glyph shadow literals follow the standalone React runtime contract", async () => {
  const { runtimeNodes } = await import("../src/compiler/runtime");
  const doc = createStarter(),
    node = createNode("text");
  node.style.textEffectClip = "glyphs";
  node.style.shadows = [
    {
      x: 0,
      y: 2,
      blur: 4,
      spread: 0,
      inset: false,
      color: "#cccccc",
      opacity: 0.5,
      visible: true,
      blendMode: "plus-darker",
    },
  ];
  doc.nodes = [node];
  assert.deepEqual(runtimeNodes(doc)[0].inkShadows, [
    {
      x: 0,
      y: 2,
      blur: 4,
      spread: 0,
      inset: false,
      color: "#cccccc",
      opacity: 0.5,
      blendMode: "plus-darker",
    },
  ]);
});

test("a blended glyph fill samples the filtered backdrop before adding its ink", async () => {
  const { runtimeNodes } = await import("../src/compiler/runtime");
  const doc = createStarter();
  const text = createNode("text");
  Object.assign(text.style, {
    fill: "#999999",
    fillBlendMode: "plus-lighter",
    backdropSaturation: 1.5,
    textEffectClip: "glyphs",
  });
  doc.nodes = [text];
  const rendered = runtimeNodes(doc)[0];
  assert.equal(rendered.style.mixBlendMode, undefined);
  assert.equal(rendered.style["--forma-text-backdrop"], "saturate(1.5)");
  assert.deepEqual(rendered.inkPaints, [
    { background: "rgba(153, 153, 153, 1)", blend: "plus-lighter" },
  ]);
  text.style.backdropBlurVisible = false;
  const hidden = runtimeNodes(doc)[0];
  assert.equal(hidden.inkPaints, undefined);
  assert.equal(hidden.style.mixBlendMode, "plus-lighter");
});

// Independent control points from Sketch 234013. A capsule exhausts its
// vertical budget while its horizontal transition still has room to curve.
test("continuous corners retain asymmetric edge budgets and keep outside ink", async () => {
  const { roundedContour } = await import("../src/domain/stroke");
  const doc = createStarter(),
    node = createNode("rectangle");
  Object.assign(node.style, {
    width: 72,
    height: 50,
    radius: 25,
    cornerSmoothing: 0.6,
  });
  doc.nodes = [node];
  const capsule = roundedContour(72, 50, node.style);
  assert.ok(capsule.includes("C46.2421 0 51.3632 0 55.4684 1.478"));
  assert.ok(capsule.includes("C65.3872 5.0489 72 14.4581 72 25"));
  assert.ok(nodeCss(node, doc).clipPath);
  node.style.shadows = [
    {
      x: 0,
      y: 2,
      blur: 4,
      spread: 0,
      inset: false,
      color: "#000000",
      opacity: 0.3,
    },
  ];
  assert.equal(nodeCss(node, doc).clipPath, undefined);
  assert.ok(nodeCss(node, doc).borderShape);
  Object.assign(node.style, { corners: { tl: 50, tr: 10, br: 20, bl: 30 } });
  const uneven = roundedContour(100, 70, node.style);
  assert.ok(uneven.includes("C0 24.9584 8.4383 11.1885 21.8404 4.3597"));
  node.style.cornerSmoothing = 0;
  assert.equal(nodeCss(node, doc).borderShape, undefined);
});

test("stacked additive solid paints and independent shadows survive native and React serialization", async () => {
  const { solidBlendPaint, independentShadows } =
    await import("../src/compiler/material-composite");
  const { runtimeNodes } = await import("../src/compiler/runtime");
  const { exportNodeToSvg } =
    await import("../src/infrastructure/static-export");
  const doc = createStarter(),
    node = createNode("rectangle");
  Object.assign(node.style, {
    fill: "#cc0000",
    fillOpacity: 0.5,
    fillBlendMode: "plus-darker",
    paints: [
      {
        id: "blue",
        color: "#0000ff",
        opacity: 0.5,
        visible: true,
        blendMode: "plus-lighter",
      },
    ],
    shadows: [
      {
        x: 0,
        y: 2,
        blur: 2,
        spread: 0,
        color: "#eeeeee",
        opacity: 0.8,
        inset: true,
        blendMode: "plus-lighter",
      },
      {
        x: 3,
        y: 0,
        blur: 0,
        spread: 0,
        color: "#999999",
        opacity: 0.5,
        inset: false,
        blendMode: "plus-darker",
      },
    ],
  });
  doc.nodes = [node];
  const saved = parseDocument(JSON.parse(JSON.stringify(doc))).nodes[0];
  assert.deepEqual(solidBlendPaint(saved), { color: "#8800aa", opacity: 0.75 });
  assert.equal(nodeCss(saved, doc).mixBlendMode, undefined);
  assert.equal(nodeCss(saved, doc).boxShadow, undefined);
  const layers = independentShadows(saved);
  assert.equal(layers?.length, 2);
  assert.match(String(layers?.[0].maskImage), /^url\("data:image\/svg\+xml,/);
  assert.equal(layers?.[1].mixBlendMode, "plus-lighter");
  assert.deepEqual(runtimeNodes(doc)[0].boxShadows, layers);
  assert.match(
    exportNodeToSvg(doc, node.id),
    /fill="#8800aa" fill-opacity="0.75"/,
  );
});
