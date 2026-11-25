// Compare the live CSS-variable material in exported React against the resolved preview per mode.
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import bundle from "playwright-core/lib/utilsBundle";
import { createNode, parseDocument } from "../src/domain/document.ts";
import { runtimeNodes } from "../src/compiler/runtime.ts";
import { exportTokenFiles } from "../src/compiler/design-tokens.ts";
import { DesignNodeView } from "../src/runtime/FormaRuntime.tsx";
import { launchQaBrowser } from "./qa-browser.mjs";

const browser = await launchQaBrowser(process.env.BROWSER_ENGINE || "chromium");
try {
  const page = await browser.newPage();
  for (const mode of ["plus-darker", "plus-lighter", "multiply"]) {
    const node = createNode("rectangle");
    Object.assign(node.style, {
      x: 0,
      y: 0,
      width: 32,
      height: 32,
      radius: 0,
      fill: "#cc2167",
      fillOpacity: 0.6,
      paints: [
        {
          id: "coat",
          visible: true,
          color: "#1d9af7",
          opacity: 0.45,
          blendMode: mode,
          colorVariableId: "tint",
          opacityVariableId: "alpha",
        },
      ],
    });
    const variable = (id, type, values) => ({
      id,
      name: id,
      type,
      collectionId: "theme",
      values,
      codeSyntax: "--" + id,
    });
    const doc = parseDocument({
      schemaVersion: 1,
      id: "materials",
      name: "Materials",
      revision: 0,
      nodes: [node],
      tokens: {},
      designSystem: {
        variables: {
          tint: variable("tint", "color", {
            light: "#1d9af7",
            dark: "#e7b234",
          }),
          alpha: variable("alpha", "number", { light: 0.45, dark: 0.8 }),
        },
        collections: {
          theme: {
            id: "theme",
            name: "Theme",
            defaultModeId: "light",
            modes: ["light", "dark"].map((id) => ({ id, name: id })),
          },
        },
        styles: {},
        activeModes: { theme: "light" },
      },
    });
    const symbolic = runtimeNodes(doc, undefined, true)[0];
    assert.equal(symbolic.blendedPaints.length, 2);
    const render = (n) =>
      renderToStaticMarkup(createElement(DesignNodeView, { node: n }));
    await page.setContent(
      "<style>body{margin:0;background:white}" +
        exportTokenFiles(doc)["src/tokens.css"] +
        "</style>" +
        render(symbolic),
    );
    for (const theme of ["light", "dark"]) {
      doc.designSystem.activeModes.theme = theme;
      await page.evaluate(
        (theme) =>
          document.body.setAttribute("data-collection-74-68-65-6d-65", theme),
        theme,
      );
      const actual = bundle.PNG.sync.read(
        await page.locator("[data-design-id]").screenshot(),
      ).data;
      const peer = await browser.newPage();
      let expected;
      try {
        await peer.setContent(
          "<style>body{margin:0;background:white}</style>" +
            render(runtimeNodes(doc)[0]),
        );
        expected = bundle.PNG.sync.read(
          await peer.locator("[data-design-id]").screenshot(),
        ).data;
      } finally {
        await peer.close();
      }
      const readCenter = (data) => [
        ...data.subarray((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 3),
      ];
      const a = readCenter(actual),
        b = readCenter(expected);
      assert.ok(
        a.every((v, i) => Math.abs(v - b[i]) <= 4),
        JSON.stringify({ mode, theme, actual: a, expected: b }),
      );
      console.log(mode, theme, a, b);
    }
  }
} finally {
  await browser.close();
}
