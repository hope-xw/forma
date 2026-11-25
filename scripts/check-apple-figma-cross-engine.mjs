// Reopen the native document and independently build the verified full-project ZIP.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preview } from "vite";
import { launchQaBrowser } from "./qa-browser.mjs";
import { compareApplePixels, assertPixelLimit } from "./apple-kit-pixels.mjs";
import { readSourceProject } from "../src/infrastructure/project-revision.ts";

const output = path.resolve(
  process.env.FORMA_APPLE_FIGMA_OUTPUT || "output/playwright/apple-figma-0.8.3",
);
const baseline = JSON.parse(
  await readFile(path.join(output, "figma-acceptance.json"), "utf8"),
);
const engineNames =
  process.argv.length > 2 ? process.argv.slice(2) : ["firefox", "webkit"];
const base = process.env.FORMA_URL || "http://127.0.0.1:4217";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const sampleEntries = Object.entries(baseline.samples);
assert.equal(sampleEntries.length, 6);
const zip = await readFile(path.join(output, "apple-figma-react.zip"));
assert.equal(hash(zip), baseline.project.sha256);
const { files, manifest } = readSourceProject(zip);
assert.equal(manifest.scope, "file");
const work = await mkdtemp(path.join(tmpdir(), "forma-figma-engines-"));
const report = {
  sourceSha256: baseline.sha256,
  projectSha256: baseline.project.sha256,
  servedEntrySha256: baseline.servedEntrySha256,
  engines: {},
};
const reportPath = path.join(output, "figma-cross-engine.json");
async function measure(page, el, folder, tag, sample) {
  await el.waitFor({ timeout: 120000 });
  await el.evaluate(async (e) => {
    await document.fonts.ready;
    await Promise.all([...e.querySelectorAll("img")].map((i) => i.decode()));
    await new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done)),
    );
  });
  const box = await el.boundingBox();
  const png = await el.screenshot({
    path: path.join(folder, tag + ".png"),
    scale: "css",
    animations: "disabled",
    timeout: 120000,
  });
  const source = await readFile(path.join(output, "source", tag + ".png"));
  assert.equal(hash(source), sample.referenceSha256);
  const pixels = await compareApplePixels(page, source, png);
  return { box, sha256: hash(png), pixels };
}
async function engine(name, url) {
  const result = (report.engines[name] = { editor: {}, react: {}, errors: [] }),
    b = await launchQaBrowser(name);
  try {
    result.browser = b.version();
    for (const mode of ["react", "editor"]) {
      const folder = path.join(output, name, mode);
      await mkdir(folder, { recursive: true });
      const context = await b.newContext({
        viewport: { width: 2200, height: 1500 },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(90000);
      page.on("pageerror", (e) => result.errors.push(e.message));
      try {
        if (mode === "editor") {
          await page.goto(base);
          const entry = await page
            .locator('script[type="module"][src]')
            .last()
            .getAttribute("src");
          assert.equal(
            hash(
              Buffer.from(
                await (await fetch(new URL(entry, base))).arrayBuffer(),
              ),
            ),
            baseline.servedEntrySha256,
          );
          await page.getByLabel("打开本机工作空间文件列表").click();
          await page
            .getByTestId("browser-design-file-input")
            .setInputFiles(path.join(output, "apple-figma.forma.json"));
          await page.waitForURL((u) => u.searchParams.has("file"), {
            timeout: 600000,
          });
          await page.locator(".editor-canvas").waitFor({ timeout: 360000 });
          assert.equal(
            await page
              .getByRole("region", { name: "页面列表" })
              .locator("button.page-name")
              .count(),
            46,
          );
        }
        for (const [tag, s] of sampleEntries) {
          if (mode === "editor") {
            await page
              .getByRole("region", { name: "页面列表" })
              .getByRole("button", { name: s.page, exact: true })
              .click();
            await page
              .getByLabel("搜索图层", { exact: true })
              .fill(s.sceneName);
            await page
              .locator('[data-layer-id="' + s.scene + '"] .layer-main')
              .click();
            await page.locator(".editor-canvas").focus();
            await page.keyboard.press("Shift+2");
            await page
              .getByRole("button", { name: "预览", exact: true })
              .click();
            await page.getByLabel("缩放模式").selectOption("100");
          } else
            await page.goto(url + "#screen=" + encodeURIComponent(s.scene));
          const root =
            mode === "editor" ? page.locator(".preview-dialog") : page;
          const el = root.locator('[data-design-id="' + s.id + '"]').first();
          result[mode][tag] = await measure(page, el, folder, tag, s);
          if (mode === "editor")
            await page
              .getByRole("button", { name: "关闭预览", exact: true })
              .click();
          console.log(name, mode, tag, result[mode][tag].pixels);
        }
      } catch (e) {
        result.errors.push(mode + " " + e.message);
      } finally {
        await context.close();
      }
    }
  } finally {
    await b.close();
  }
}
try {
  for (const [name, b] of Object.entries(files)) {
    const dest = path.join(work, name);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, b);
  }
  const opts = { cwd: work, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 };
  execFileSync(
    "npm",
    ["install", "--prefer-offline", "--no-audit", "--no-fund"],
    opts,
  );
  execFileSync("npm", ["run", "build"], opts);
  const server = await preview({
    root: work,
    configFile: false,
    preview: { host: "127.0.0.1", port: 0 },
    logLevel: "silent",
  });
  try {
    for (const name of engineNames) {
      await engine(
        name,
        "http://127.0.0.1:" + server.httpServer.address().port + "/",
      );
      await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    }
  } finally {
    await new Promise((done) => server.httpServer.close(done));
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
for (const e of Object.values(report.engines)) {
  assert.deepEqual(e.errors, []);
  for (const mode of ["editor", "react"])
    assertPixelLimit(
      Object.entries(e[mode]).map(([tag, record]) => ({
        tag,
        sourceSize: baseline.samples[tag].size,
        pixels: record.pixels,
      })),
      sampleEntries.map(([tag]) => tag),
    );
}
