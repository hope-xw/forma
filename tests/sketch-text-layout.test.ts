import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createNode, parseDocument } from "../src/domain/document";
import { createStarter } from "../src/domain/seed";
import { currentTextLayout } from "../src/domain/text-shape";
import { nodeCss } from "../src/compiler/react";
import { runtimeNodes } from "../src/compiler/runtime";
import { attachSketchTextLayouts } from "../src/infrastructure/design-import/sketch-text-layout";
import { sketchFontInstances } from "../src/infrastructure/design-import/sketch-font-instances";
import { fontAttributes } from "../src/infrastructure/design-import/sketch-appearance";
import { importFontBytes } from "../src/infrastructure/font-import";

test("embedded Sketch font determines editable glyph positions, line breaks and intrinsic bounds", async () => {
  // This original test face has a 1000-unit em, 600-unit letters and a 400-unit space.
  const bytes = await readFile(
    new URL("./fixtures/forma-geometry-test.ttf", import.meta.url),
  );
  const { id, asset } = await importFontBytes(bytes, "Forma test.ttf");
  const doc = createStarter(),
    root = createNode("frame"),
    label = createNode("text", root.id),
    wrapped = createNode("text", root.id);
  label.text = "AB";
  Object.assign(label.style, {
    width: 12,
    height: 10,
    widthMode: "hug",
    heightMode: "hug",
    fontSize: 10,
    lineHeight: 10,
    fontFamily: id,
    x: 6,
    y: 2,
  });
  wrapped.text = "AB AB";
  Object.assign(wrapped.style, {
    width: 13,
    height: 20,
    fontSize: 10,
    lineHeight: 10,
    fontFamily: id,
  });
  doc.nodes = [root, label, wrapped];
  doc.fonts = { [id]: asset };
  await attachSketchTextLayouts(doc, new Map([[id, bytes]]), (_n, detail) =>
    assert.fail(detail),
  );
  assert.deepEqual(currentTextLayout(label)?.lines, [
    { text: "AB", x: [0, 6], y: 8 },
  ]);
  assert.deepEqual(
    currentTextLayout(wrapped)?.lines.map((l) => [l.text, l.y]),
    [
      ["AB ", 8],
      ["AB", 18],
    ],
  );
  assert.equal(nodeCss(label, doc).width, 12);
  assert.equal(runtimeNodes(doc)[0].children[0].sourceTextLayout?.text, "AB");
  assert.ok(
    !("styleKey" in runtimeNodes(doc)[0].children[0].sourceTextLayout!),
  );
  const reopened = parseDocument(JSON.parse(JSON.stringify(doc))).nodes[1];
  assert.equal(currentTextLayout(reopened)?.width, 12);
  const large = createNode("text");
  large.text = "AB";
  Object.assign(large.style, {
    fontFamily: id,
    fontSize: 38,
    lineHeight: 46,
    width: 50,
    height: 46,
  });
  doc.nodes.push(large);
  await attachSketchTextLayouts(doc, new Map([[id, bytes]]), () => {});
  assert.deepEqual(currentTextLayout(large)?.lines[0].x, [0, 22]);
  large.style.paints = [
    { id: "highlight", color: "#ffffff", opacity: 0.5, visible: true },
  ];
  assert.equal(currentTextLayout(large), undefined);
  await attachSketchTextLayouts(doc, new Map([[id, bytes]]), () => {});
  assert.ok(Math.abs(currentTextLayout(large)!.lines[0].x[1] - 22.8) < 0.0001);

  reopened.style.color = "#223344";
  assert.ok(currentTextLayout(reopened));
  reopened.style.fontSize = 11;
  assert.equal(currentTextLayout(reopened), undefined);
  label.text = "BA";
  assert.equal(currentTextLayout(label), undefined);
  assert.equal(nodeCss(label, doc).width, "max-content");
});

test("unsupported font coverage keeps the source's editable Unicode text", async () => {
  const bytes = await readFile(
    new URL("./fixtures/forma-geometry-test.ttf", import.meta.url),
  );
  const { id, asset } = await importFontBytes(bytes, "test.ttf"),
    doc = createStarter(),
    n = createNode("text");
  n.text = "AB 设计 🌷";
  n.style.fontFamily = id;
  doc.nodes = [n];
  doc.fonts = { [id]: asset };
  await attachSketchTextLayouts(doc, new Map([[id, bytes]]), () => {});
  assert.equal(n.sourceTextLayout, undefined);
  assert.equal(runtimeNodes(doc)[0].text, n.text);
});

test("Sketch named faces read their own design weight, and tracking adds to user kerning", async () => {
  const bytes = await readFile(
    new URL("./fixtures/forma-geometry-test.ttf", import.meta.url),
  );
  const instances = sketchFontInstances(bytes);
  assert.deepEqual(instances.get("FormaGeometry-Medium"), { wght: 535 });
  const attrs = fontAttributes(
    {
      MSAttributedStringFontAttribute: {
        attributes: { name: "FormaGeometry-Medium", size: 20 },
      },
      kerning: 2,
    },
    {
      families: new Map([["FormaGeometry-Medium", "embedded"]]),
      instances,
      tracking: new Map([["embedded", () => 0.5]]),
    },
  );
  assert.equal(attrs.fontWeight, 535);
  assert.equal(attrs.letterSpacing, 2.5);
});

test("source geometry preserves supplementary Unicode and leaves combining clusters intact", async () => {
  const bytes = await readFile(
    new URL("./fixtures/forma-geometry-test.ttf", import.meta.url),
  );
  const { id, asset } = await importFontBytes(bytes, "test.ttf"),
    doc = createStarter(),
    symbol = createNode("text"),
    combining = createNode("text");
  symbol.text = "🙂B";
  combining.text = "B\u0301";
  doc.fonts = { [id]: asset };
  doc.nodes = [symbol, combining];
  for (const n of doc.nodes)
    Object.assign(n.style, { fontFamily: id, fontSize: 10, lineHeight: 10 });
  await attachSketchTextLayouts(doc, new Map([[id, bytes]]), () => {});
  assert.deepEqual(currentTextLayout(symbol)?.lines[0], {
    text: "🙂B",
    x: [0, 6],
    y: 8,
  });
  assert.equal(combining.sourceTextLayout, undefined);
  assert.equal(runtimeNodes(doc)[1].text, "B\u0301");
  const changed = structuredClone(doc);
  changed.nodes[0].sourceTextLayout!.lines[0].x.pop();
  assert.throws(() => parseDocument(changed));
});
