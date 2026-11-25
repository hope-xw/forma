// Inspect isolated source paints without losing the master variant's design system.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { importFigma } from "../src/infrastructure/design-import/figma.ts";
import { runtimeNodes } from "../src/compiler/runtime.ts";
import { compareApplePixels } from "./apple-kit-pixels.mjs";
import { launchQaBrowser } from "./qa-browser.mjs";

const [file, refs] = process.argv.slice(2);
if (!file || !refs)
  throw Error("Pass the .fig file and native paint reference directory");
const { document: doc } = await importFigma(
  await readFile(file),
  path.basename(file),
);
const variants = Object.values(doc.libraries).flatMap((l) =>
  l.components.flatMap((c) => c.variants),
);
const client = (
  await build({
    write: false,
    bundle: true,
    stdin: {
      resolveDir: process.cwd(),
      contents: `import {createElement} from 'react';import {createRoot} from 'react-dom/client';import {DesignNodeView} from './src/runtime/FormaRuntime.tsx';window.renderNode=n=>createRoot(document.getElementById('root')).render(createElement(DesignNodeView,{node:n}));`,
      loader: "tsx",
    },
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  })
).outputFiles[0].text;
const browser = await launchQaBrowser(process.env.BROWSER_ENGINE || "chromium");
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [tag, id] of [
    ["gradient", "fig-533-16900"],
    ["vector-multifill", "fig-56-56615"],
  ]) {
    const v = variants.find((v) => v.nodes.some((n) => n.id === id));
    assert.ok(v);
    const subtree = new Set([id]);
    for (const n of v.nodes) if (subtree.has(n.parentId)) subtree.add(n.id);
    const nodes = v.nodes
      .filter((n) => subtree.has(n.id))
      .map((n) =>
        n.id === id
          ? { ...n, parentId: null, style: { ...n.style, x: 0, y: 0 } }
          : n,
      );
    const ref = await readFile(path.join(refs, tag + ".png"));
    for (const symbolic of [false, true]) {
      const [n] = runtimeNodes(
        { ...doc, pages: undefined, nodes },
        [id],
        symbolic,
      );
      await page.setContent(
        '<style>body{margin:0;background:white}</style><div id="root"></div>',
      );
      await page.addScriptTag({ content: client });
      await page.evaluate((n) => window.renderNode(n), n);
      const root = page.locator("[data-design-id]").first();
      await root.waitFor();
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      const image = await root.screenshot();
      const pixels = await compareApplePixels(page, ref, image);
      console.log(JSON.stringify({ tag, id, symbolic, pixels }));
      assert.equal(pixels.over16 * 200 <= pixels.total, true, tag);
    }
  }
} finally {
  await browser.close();
}
