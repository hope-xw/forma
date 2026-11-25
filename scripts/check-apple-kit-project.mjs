import { compareApplePixels, assertAppleVisuals } from "./apple-kit-pixels.mjs";
// Verify the project downloaded by check-apple-kit-import.mjs in a clean install.
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { preview } from "vite";
import { readSourceProject } from "../src/infrastructure/project-revision.ts";
import { launchQaBrowser } from "./qa-browser.mjs";

const root = path.resolve(process.argv[2] ?? "output/playwright/apple-kit");
const oracle = JSON.parse(
  await readFile(path.join(root, "source-manifest.json")),
);
const archive = path.join(root, "apple-kit-react-file.zip");
const bytes = await readFile(archive);
const sha = (data) => createHash("sha256").update(data).digest("hex");
const report = {
  zipBytes: bytes.length,
  sha256: sha(bytes),
  screens: [],
  pageErrors: [],
};
const directory = await mkdtemp(path.join(tmpdir(), "forma-apple-project-"));
try {
  const { files, manifest } = readSourceProject(bytes);
  assert.equal(manifest.scope, "file");
  for (const [name, digest] of Object.entries(manifest.generated))
    assert.equal(sha(files[name]), digest, name);
  report.entries = Object.keys(files).length;
  report.verifiedDigests = Object.keys(manifest.generated).length;
  report.assetFiles = Object.keys(files).filter((name) =>
    name.startsWith("src/assets/"),
  ).length;
  assert.equal(report.assetFiles, 161);
  report.nativeFileBytes = files["design.forma.json"].length;
  for (const [name, data] of Object.entries(files)) {
    const destination = path.join(directory, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data);
  }
  const options = {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 12 * 1024 * 1024,
  };
  const install = execFileSync(
    "npm",
    ["install", "--prefer-offline", "--no-fund", "--no-audit"],
    options,
  );
  const build = execFileSync("npm", ["run", "build"], options);
  await writeFile(path.join(root, "react-build.log"), install + "\n" + build);
  const server = await preview({
    root: directory,
    configFile: false,
    logLevel: "silent",
    preview: { host: "127.0.0.1", port: 0 },
  });
  try {
    const browser = await launchQaBrowser("chromium");
    try {
      const page = await browser.newPage({
        viewport: { width: 1460, height: 1100 },
        deviceScaleFactor: 1,
      });
      page.on("pageerror", (e) => report.pageErrors.push(e.message));
      const url = "http://127.0.0.1:" + server.httpServer.address().port + "/";
      await page.goto(url);
      await page
        .locator('[data-design-id="' + oracle.samples.cover.id + '"]')
        .first()
        .waitFor({ timeout: 120000 });
      report.defaultScreen = "Library Preview";
      for (const [tag, sample] of Object.entries(oracle.samples)) {
        await page.goto(url + "#screen=" + encodeURIComponent(sample.id));
        const design = page
          .locator('[data-design-id="' + sample.id + '"]')
          .first();
        await design.waitFor({ timeout: 120000 });
        const geometry = await design.evaluate(async (el) => {
          await document.fonts.ready;
          await Promise.all(
            [...el.querySelectorAll("img")].map((i) => i.decode()),
          );
          return {
            width: el.offsetWidth,
            height: el.offsetHeight,
            layers: 1 + el.querySelectorAll("[data-design-id]").length,
            photos: [...el.querySelectorAll("img")].map((i) => [
              i.naturalWidth,
              i.naturalHeight,
            ]),
          };
        });
        assert.deepEqual([geometry.width, geometry.height], sample.size, tag);
        if (tag === "cover") assert.deepEqual(geometry.photos, [[1024, 1024]]);
        const target = path.join(root, "react-screens");
        await mkdir(target, { recursive: true });
        const native = await design.screenshot({
          path: path.join(target, tag + ".png"),
          scale: "css",
          animations: "disabled",
        });
        const source = await readFile(
          path.join(root, "source", sample.id + ".png"),
        );
        const pixels = await compareApplePixels(page, source, native);
        report.screens.push({
          tag,
          ...geometry,
          sourceSize: sample.size,
          pixels,
        });
      }
      await page.goto(url + "#screens");
      const directoryLinks = page.locator('a[href*="screen="]');
      await directoryLinks.first().waitFor();
      report.directoryScreens = await directoryLinks.count();
      assert.ok(report.directoryScreens >= 1919);
      assert.deepEqual(report.pageErrors, []);
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
  await writeFile(
    path.join(root, "react-result.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  assertAppleVisuals(report.screens);
} finally {
  await rm(directory, { recursive: true, force: true });
}
