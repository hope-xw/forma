// Readback of imported linear gradients and editable vector masks at two aspect ratios.
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import bundle from "playwright-core/lib/utilsBundle";
import { makeLayer } from "../src/infrastructure/design-import/figma-layer.ts";
import { parseDocument } from "../src/domain/document.ts";
import { runtimeNodes } from "../src/compiler/runtime.ts";
import { exportNodeToSvg } from "../src/infrastructure/static-export.ts";
import { DesignNodeView } from "../src/runtime/FormaRuntime.tsx";
import { launchQaBrowser } from "./qa-browser.mjs";
function rectangularContours(w, h) {
  const bytes = [];
  for (const [x, y, ww, hh] of [
    [0, 0, w, h],
    [2, 2, 7, 7],
  ]) {
    for (const [i, point] of [
      [x, y],
      [x + ww, y],
      [x + ww, y + hh],
      [x, y + hh],
    ].entries()) {
      bytes.push(i === 0 ? 1 : 2);
      for (const coordinate of point) {
        const f = Buffer.alloc(4);
        f.writeFloatLE(coordinate);
        bytes.push(...f);
      }
    }
    bytes.push(0);
  }
  return Uint8Array.from(bytes);
}
const browser = await launchQaBrowser(process.env.BROWSER_ENGINE || "chromium");
try {
  const page = await browser.newPage();
  for (const [x, y, offset] of [
    [0, 1, 0],
    [0, -1, 1],
    [0.75, -0.4, 0.25],
    [-1.5, 0.5, 0.8],
  ]) {
    const gradient = {
      type: "GRADIENT_LINEAR",
      opacity: 1,
      transform: { m00: x, m01: y, m02: offset },
      stops: [
        { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
      ],
    };
    const ctx = {
      assetKeys: new Map(),
      images: new Map(),
      blobs: [],
      report: (n, detail) => assert.fail(n + " " + detail),
    };
    for (const [w, h] of [
      [96, 32],
      [48, 80],
    ]) {
      ctx.blobs = [{ bytes: rectangularContours(w, h) }];
      const node = makeLayer(
        {
          type: "VECTOR",
          fillGeometry: [{ commandsBlob: 0, windingRule: "ODD" }],
          guid: { sessionID: 1, localID: 1 },
          size: { x: w, y: h },
          fillPaints: [gradient],
        },
        "rect",
        null,
        ctx,
      );
      assert.equal(node.vector?.fillFromStyle, true);
      const doc = parseDocument({
        schemaVersion: 1,
        id: "gradient",
        name: "Gradient",
        revision: 0,
        nodes: [node],
        tokens: {},
      });
      for (const [surface, markup] of [
        [
          "preview",
          renderToStaticMarkup(
            createElement(DesignNodeView, { node: runtimeNodes(doc)[0] }),
          ),
        ],
        [
          "project",
          renderToStaticMarkup(
            createElement(DesignNodeView, {
              node: runtimeNodes(doc, undefined, true)[0],
            }),
          ),
        ],
        ["svg", exportNodeToSvg(doc, node.id)],
      ]) {
        await page.setContent(
          "<style>body{margin:0;background:#0f0}</style>" + markup,
        );
        const shot = bundle.PNG.sync.read(
          await page.screenshot({ clip: { x: 0, y: 0, width: w, height: h } }),
        );
        const px = (i, j) => [
          ...shot.data.subarray((w * j + i) * 4, (w * j + i) * 4 + 3),
        ];
        assert.deepEqual(px(5, 5), [0, 255, 0], "Vector hole " + surface);
        for (const [i, j] of [
          [w - 3, 3],
          [5, h - 4],
          [31, 17],
          [w - 4, h - 3],
        ]) {
          const expected =
            255 *
            Math.min(
              1,
              Math.max(0, (x * (i + 0.5)) / w + (y * (j + 0.5)) / h + offset),
            );
          assert.ok(
            px(i, j).every((c) => Math.abs(c - Math.round(expected)) <= 3),
            JSON.stringify({
              surface,
              w,
              h,
              i,
              j,
              x,
              y,
              offset,
              expected,
              actual: px(i, j),
            }),
          );
        }
      }
    }
  }
  console.log(
    "4 affine gradients × 2 aspect ratios × 3 outputs, with vector holes and sampled colors, passed.",
  );
} finally {
  await browser.close();
}
