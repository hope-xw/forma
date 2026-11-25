// Compare the native Figma plugin's 1x renders against both product delivery paths.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchQaBrowser } from "./qa-browser.mjs";
import { assertPixelLimit, compareApplePixels } from "./apple-kit-pixels.mjs";

const root = path.resolve(
  process.argv[2] || "output/playwright/apple-figma-0.8.3",
);
const original = await readFile(path.join(root, "forma-figma-originals.json"));
const data = JSON.parse(original);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const selected = {
  cover: "2401:4",
  button: "5:108579",
  "toggle-on": "5433:19060",
  "toggle-off": "5433:20192",
  "alert-button": "5446:6654",
  alert: "65:57149",
};
assert.deepEqual(data.errors, []);
assert.deepEqual(
  data.samples.map((s) => s.tag).sort(),
  Object.keys(selected).sort(),
);
const report = {
  file: data.file,
  nativeExportSha256: hash(original),
  pages: data.pages.length,
  preview: [],
  react: [],
};
const browser = await launchQaBrowser("chromium");
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const sample of data.samples) {
    const reference = Buffer.from(sample.png, "base64");
    assert.equal(selected[sample.tag], sample.id);
    for (const surface of ["preview", "react"]) {
      const native = await readFile(
        path.join(root, surface, sample.tag + ".png"),
      );
      const pixels = await compareApplePixels(page, reference, native);
      report[surface].push({
        tag: sample.tag,
        id: sample.id,
        sourceSize: sample.size,
        sourcePngSha256: hash(reference),
        pixels,
      });
    }
  }
  await writeFile(
    path.join(root, "figma-visuals.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  for (const surface of ["preview", "react"])
    assertPixelLimit(report[surface], Object.keys(selected));
} finally {
  await browser.close();
}
