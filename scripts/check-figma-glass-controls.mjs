// Usage: node scripts/check-figma-glass-controls.mjs <standalone React URL> <reference root> <output directory>
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchQaBrowser } from "./qa-browser.mjs";
import { compareApplePixels, assertPixelLimit } from "./apple-kit-pixels.mjs";

const [base, root, output] = process.argv.slice(2);
if (!base || !root || !output)
  throw new Error(
    "Pass the standalone React URL, the directory containing source/ and material-controls/, and a new output directory",
  );
const examples = [
  ["toggle-on", "fig-5433-19060", "fig-5433-19060"],
  ["dark-pressed-on", "fig-5433-20196", "fig-5433-20196"],
  ["dark-idle-off", "fig-5433-20197", "fig-5433-20197"],
  ["pressed-off", "fig-29-56814", "fig-10456-1236"],
  ["idle-on", "fig-29-56814", "fig-27-68905"],
  ["pressed-on", "fig-29-56814", "fig-10456-1240"],
];
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const results = [];
await mkdir(output, { recursive: true });
for (const engine of ["chromium", "firefox", "webkit"]) {
  const browser = await launchQaBrowser(engine);
  try {
    const page = await browser.newPage({
      viewport: { width: 2200, height: 1500 },
      deviceScaleFactor: 1,
    });
    for (const [tag, route, id] of examples) {
      const url = new URL(base);
      url.hash = "screen=" + route;
      await page.goto(url.href);
      const target = page.locator('[data-design-id="' + id + '"]');
      await target.waitFor({ timeout: 60000 });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
      });
      const expected = await readFile(
        path.join(
          root,
          tag === "toggle-on" ? "source" : "material-controls",
          tag + ".png",
        ),
      );
      const actual = await target.screenshot({
        path: path.join(output, engine + "-" + tag + ".png"),
      });
      const pixels = await compareApplePixels(page, expected, actual);
      results.push({
        engine,
        version: browser.version(),
        tag,
        route,
        id,
        pixels,
        sourceSize: [64, 28],
        referenceSHA256: sha(expected),
        candidateSHA256: sha(actual),
      });
      console.log(engine, tag, pixels.over16 + "/" + pixels.total);
    }
  } finally {
    await browser.close();
  }
}
await writeFile(
  path.join(output, "controls.json"),
  JSON.stringify(results, null, 2) + "\n",
);
assertPixelLimit(results);
