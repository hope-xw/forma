import { compareApplePixels, assertAppleVisuals } from "./apple-kit-pixels.mjs";
// Keep Apple artwork and document contents in output/, outside distributable evidence.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { openAsBlob } from "node:fs";
import { stableHash } from "../src/domain/stable-hash.ts";
import { readNativeDocument } from "../src/infrastructure/native-document.ts";
import { performance } from "node:perf_hooks";
import { launchQaBrowser } from "./qa-browser.mjs";

const filename = process.argv[2];
if (!filename) throw Error("Pass the original Apple iOS 27 UI Kit.sketch path");
const root = path.resolve(
  process.env.FORMA_APPLE_KIT_OUTPUT || "output/playwright/apple-kit",
);
const sourceRoot = path.resolve(
  process.env.FORMA_APPLE_SOURCE_EVIDENCE || root,
);
const manifest = JSON.parse(
  await readFile(path.join(sourceRoot, "source-manifest.json")),
);
const sourceRows = JSON.parse(
  await readFile(path.join(sourceRoot, "source-nodes.json")),
);
const sourceStyles = JSON.parse(
  await readFile(path.join(sourceRoot, "source-styles.json")),
);
const nativePath = path.join(
  root,
  path.basename(filename, path.extname(filename)) + ".forma.json",
);
const base = process.env.FORMA_URL || "http://127.0.0.1:4183";
const report = {
  format: "sketch",
  sourceSha256: manifest.sha256,
  sourceBytes: manifest.bytes,
  renderer: manifest.renderer,
  samples: [],
  phases: [],
};
const engine = process.env.BROWSER_ENGINE || "chromium";
report.engine = engine;
const browser = await launchQaBrowser(engine);
const settings = {
  viewport: { width: 1600, height: 1200 },
  deviceScaleFactor: 1,
};
let context = await browser.newContext(settings);
let page = await context.newPage();
page.setDefaultTimeout(90000);
report.browser = browser.version();
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.error("browser error", e.message);
});
page.on("console", (m) => {
  if (m.type() === "error")
    console.error("browser console", m.text().slice(0, 400));
});
async function step(name) {
  console.log(name);
  await checkpoint();
}
const checkpoint = () =>
  writeFile(
    path.join(root, "result.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
const elapsed = (start) => Math.round(performance.now() - start);
async function documentState() {
  const download = page.waitForEvent("download");
  await page.getByLabel("设计文件", { exact: true }).click();
  await (await download).saveAs(nativePath);
  report.portableBytes = (await stat(nativePath)).size;
  const doc = await readNativeDocument(await openAsBlob(nativePath));
  const rows = sourceRows,
    lookup = new Map(),
    pages = new Map(),
    types = {},
    siblingLists = new Map(),
    expectedSiblings = new Map();
  let instances = 0,
    parentMissing = 0,
    duplicates = 0,
    invalidInstanceRef = 0,
    expanded = 0;
  const variants = new Set(),
    masters = new Map();
  for (const lib of Object.values(doc.libraries ?? {}))
    for (const c of lib.components) {
      if (c.master) masters.set(c.id, c.master.nodeId);
      for (const v of c.variants)
        variants.add(JSON.stringify([lib.id, c.id, v.id]));
    }
  const available = new Set(rows.map(([pg, id]) => id));
  function add(map, k, v) {
    const bucket = map.get(k) ?? [];
    bucket.push(v);
    map.set(k, bucket);
  }
  for (const p of doc.pages) {
    const nodes = p.nodes ?? doc.nodes,
      ids = new Set(nodes.map((n) => n.id));
    pages.set(p.id, p.name);
    expanded += nodes.length;
    for (const n of nodes) {
      if (lookup.has(n.id)) duplicates++;
      if (n.parentId !== null && !ids.has(n.parentId)) parentMissing++;
      lookup.set(n.id, [p.id, n]);
      types[n.type] = (types[n.type] ?? 0) + 1;
      if (available.has(n.id)) add(siblingLists, p.id + "/" + n.parentId, n.id);
      if (n.instance) {
        instances++;
        const r = n.instance;
        if (
          !variants.has(
            JSON.stringify([r.libraryId, r.componentId, r.variantId]),
          )
        )
          invalidInstanceRef++;
      }
    }
  }
  const mismatches = {
      missing: 0,
      parent: 0,
      name: 0,
      text: 0,
      master: 0,
      instanceTarget: 0,
      siblingOrders: 0,
    },
    reasons = {};
  const mark = (issue, id) => {
    mismatches[issue]++;
    const ids = (reasons[issue] ??= []);
    if (ids.length < 12) ids.push(id);
  };
  for (const [pg, id, parent, type, name, symbol, text] of rows) {
    add(expectedSiblings, pg + "/" + parent, id);
    const item = lookup.get(id);
    if (!item) {
      mark("missing", id);
      continue;
    }
    const [actualPage, n] = item;
    if (pg !== actualPage || n.parentId !== parent) mark("parent", id);
    if (n.name !== name) mark("name", id);
    if (text !== null && text !== n.text) mark("text", id);
    if (type === "symbolMaster" && masters.get(symbol) !== id)
      mark("master", id);
    if (type === "symbolInstance" && n.instance?.componentId !== symbol)
      mark("instanceTarget", id);
  }
  for (const [p, siblings] of expectedSiblings)
    if (JSON.stringify(siblings) !== JSON.stringify(siblingLists.get(p)))
      mark("siblingOrders", p);
  const styleMismatches = sourceStyles.styles.filter(([id, name, kind]) => {
    const s = doc.designSystem?.styles?.[kind + "-" + stableHash(id)];
    return !s || s.kind !== kind || ![name, name + " · " + id].includes(s.name);
  });
  const colorMismatches = sourceStyles.colors.filter(([id, name, hex]) => {
    const v = doc.designSystem?.variables?.[id];
    return (
      !v ||
      ![name, name + " · " + id].includes(v.name) ||
      v.values.default !== hex
    );
  });
  const missingSourceFonts = sourceStyles.fonts.filter(
    (hash) => !doc.fonts?.["font-" + hash],
  );
  return {
    unsupportedStyleDefinitions: styleMismatches.length,
    mismatchedVariableDefinitions: colorMismatches.length,
    missingSourceFonts: missingSourceFonts.length,
    missingSourcePngHashes: sourceStyles.pngs.filter(
      (id) => !doc.images?.["img-" + id],
    ).length,
    pages: [...pages],
    expanded,
    types,
    linkedInstances: instances,
    duplicateIds: duplicates,
    missingParents: parentMissing,
    invalidInstanceRef,
    masterDefinitions: masters.size,
    sharedStyles: Object.keys(doc.designSystem?.styles ?? {}).length,
    variables: Object.keys(doc.designSystem?.variables ?? {}).length,
    images: Object.keys(doc.images ?? {}).length,
    fonts: Object.keys(doc.fonts ?? {}).length,
    issues: doc.importReport.issues.length,
    sourceNodes: doc.importReport.sourceNodes,
    sha256: doc.importReport.sha256,
    mismatches,
    exampleMismatchIds: reasons,
  };
}
async function capture(tag, sample) {
  await page
    .getByRole("region", { name: "页面列表" })
    .getByRole("button", { name: sample.page, exact: true })
    .click();
  const search = page.getByLabel("搜索图层", { exact: true });
  await search.fill(sample.name);
  const row = page.locator(`[data-layer-id="${sample.id}"] .layer-main`);
  await row.click();
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("Shift+2");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByLabel("缩放模式").selectOption("100");
  const el = page.locator(`[data-design-id="${sample.id}"]`).first();
  await el.waitFor();
  await el.evaluate(async (n) => {
    await document.fonts.ready;
    await Promise.all(
      [...n.querySelectorAll("img")].map((i) => i.decode().catch(() => {})),
    );
  });
  const rect = await el.boundingBox();
  const geometry = await el.evaluate((root) => {
    function describe(n) {
      const s = getComputedStyle(n),
        r = n.getBoundingClientRect(),
        origin = root.getBoundingClientRect();
      return {
        id: n.dataset.designId,
        xy: [r.x - origin.x, r.y - origin.y],
        size: [r.width, r.height],
        display: s.display,
        direction: s.flexDirection,
        color: s.color,
        blend: s.mixBlendMode,
      };
    }
    return [
      root,
      ...Array.from(root.querySelectorAll("[data-design-id]")).slice(0, 4),
    ].map(describe);
  });
  const fragments = await el.evaluate((root) => {
    const b = root.getBoundingClientRect();
    return [
      [0.45, 0.25],
      [0.04, 0.87],
      [0.63, 0.54],
      [0.5, 0.5],
      [0.46, 0.02],
    ].map(([x, y]) =>
      document
        .elementsFromPoint(b.x + b.width * x, b.y + b.height * y)
        .slice(0, 7)
        .map((e) => {
          const s = getComputedStyle(e);
          return {
            id: e.getAttribute("data-design-id") ?? e.tagName,
            class: e.className?.toString(),
            color: s.backgroundColor,
            background: s.backgroundImage,
            blend: s.mixBlendMode,
            opacity: s.opacity,
          };
        }),
    );
  });
  const native = await el.screenshot({
    path: path.join(root, "forma", tag + ".png"),
    animations: "disabled",
    scale: "css",
  });
  const reference = await readFile(
    path.join(sourceRoot, "source", sample.id + ".png"),
  );
  const pixels = await compareApplePixels(page, reference, native);
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  return {
    tag,
    id: sample.id,
    sourceSize: sample.size,
    renderedSize: [rect.width, rect.height],
    geometry,
    fragments,
    pixels,
  };
}
async function verifyCoverTextEdit() {
  const sample = manifest.samples.cover;
  const title = sourceRows.find(
    ([, , parent, kind, , , text]) =>
      parent === sample.id && kind === "text" && text === "iOS",
  );
  assert.ok(title, "Reference title in the original cover");
  const [, id, , , name, , original] = title;
  await page
    .getByRole("region", { name: "页面列表" })
    .getByRole("button", { name: sample.page, exact: true })
    .click();
  const search = page.getByLabel("搜索图层", { exact: true });
  await search.fill(name);
  await page.locator('[data-layer-id="' + id + '"] .layer-main').click();
  const canvas = page.locator(".editor-canvas");
  await canvas.focus();
  await page.keyboard.press("Shift+2");
  await page.keyboard.press("Enter");
  const field = page.getByRole("textbox", { name: "画布文本编辑" });
  const changed = "你好 · e\u0301 👩🏽‍💻";
  await field.fill(changed);
  await canvas.focus();
  await field.waitFor({ state: "detached" });
  const render = async () => {
    await search.fill(sample.name);
    await page
      .locator('[data-layer-id="' + sample.id + '"] .layer-main')
      .click();
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await page.getByLabel("缩放模式").selectOption("100");
    const board = page.locator('[data-design-id="' + sample.id + '"]').first(),
      title = board.locator('[data-design-id="' + id + '"]');
    await board.evaluate(async (el) => {
      await document.fonts.ready;
      await Promise.all([...el.querySelectorAll("img")].map((i) => i.decode()));
    });
    const text = await title.textContent();
    const png = await board.screenshot({
      scale: "css",
      animations: "disabled",
    });
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    return { text, png };
  };
  const edited = await render();
  assert.ok(
    edited.text.includes(changed),
    "Changed source text is present in the prototype",
  );
  const before = await readFile(path.join(root, "forma", "cover.png"));
  const delta = await compareApplePixels(page, before, edited.png);
  assert.ok(
    delta.over16 > 100,
    "Visible glyphs changed after editing the source layer",
  );
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  const undone = await render();
  assert.ok(undone.text.includes(original), "Undo restored original content");
  const restored = await compareApplePixels(page, before, undone.png);
  assert.equal(
    restored.over16,
    0,
    "Undo restored the original visible lettering",
  );
  return {
    id,
    changedPixels: delta.over16,
    undoChangedPixels: restored.over16,
  };
}
try {
  await mkdir(path.join(root, "forma"), { recursive: true });
  await page.goto(base);
  const entry = await page
    .locator("script[type=module][src]")
    .last()
    .getAttribute("src");
  const bundle = await (await fetch(new URL(entry, base))).arrayBuffer();
  report.servedEntry = entry;
  report.servedEntrySha256 = createHash("sha256")
    .update(new Uint8Array(bundle))
    .digest("hex");
  const worker = new TextDecoder()
    .decode(bundle)
    .match(/["'](\/assets\/worker-[\w-]+\.js)["']/)?.[1];
  if (worker) {
    const bytes = await (await fetch(new URL(worker, base))).arrayBuffer();
    report.servedWorker = worker;
    report.servedWorkerSha256 = createHash("sha256")
      .update(new Uint8Array(bytes))
      .digest("hex");
  }
  await page.getByTestId("design-file-input").waitFor({ state: "attached" });
  await step("Choosing source");
  let start = performance.now();
  await page
    .getByTestId("design-file-input")
    .setInputFiles(path.resolve(filename));
  const dialog = page.getByRole("dialog", { name: "设计文件导入报告" });
  await dialog.waitFor({ timeout: 10000 });
  await step("Review opened");
  const inspectInterval = setInterval(
    () =>
      page
        .locator(".design-import-body, .toast-error")
        .allTextContents()
        .then((v) => console.log("stage", v.join(" ").slice(0, 180)))
        .catch(() => {}),
    12000,
  );
  inspectInterval.unref();
  await dialog
    .locator("button.primary:enabled, [role=alert]")
    .first()
    .waitFor({ timeout: 600000 });
  const err = dialog.getByRole("alert");
  if (await err.count()) throw Error("Preflight: " + (await err.innerText()));
  clearInterval(inspectInterval);
  report.analysisMs = elapsed(start);
  report.phases.push("review");
  await step("Conversion completed");
  await page.screenshot({ path: path.join(root, "import-review.png") });
  const ready = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载导入报告" }).click();
  const reportDownload = await ready;
  await reportDownload.saveAs(path.join(root, "import-report.json"));
  start = performance.now();
  await dialog
    .getByRole("button", { name: "导入为新文件", exact: true })
    .click();
  await page.waitForURL((u) => u.searchParams.has("file"), { timeout: 600000 });
  await page.locator(".editor-canvas").waitFor({ timeout: 300000 });
  report.saveAndOpenMs = elapsed(start);
  report.phases.push("new-file");
  await checkpoint();
  start = performance.now();
  await step("Saved import; reloading");
  await page.reload();
  await page.locator(".editor-canvas").waitFor({ timeout: 300000 });
  report.reloadMs = elapsed(start);
  report.phases.push("reload");
  await step("Reloaded; exporting portable Forma document");
  report.structure = await documentState();
  assert.deepEqual(
    report.structure.pages,
    manifest.pages.map((p) => [p.id, p.name]),
  );
  assert.equal(report.structure.sha256, manifest.sha256);
  assert.equal(report.structure.sourceNodes, manifest.nodes);
  await checkpoint();
  await context.close();
  context = await browser.newContext(settings);
  page = await context.newPage();
  page.setDefaultTimeout(90000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByLabel("打开本机工作空间文件列表").click();
  start = performance.now();
  await page.getByTestId("browser-design-file-input").setInputFiles(nativePath);
  await page.waitForURL((u) => u.searchParams.has("file"), { timeout: 300000 });
  await page.locator(".editor-canvas").waitFor({ timeout: 300000 });
  report.cleanProfileNativeOpenMs = elapsed(start);
  assert.equal(
    await page
      .getByRole("region", { name: "页面列表" })
      .locator("button.page-name")
      .count(),
    manifest.pages.length,
  );
  report.phases.push("portable-open-in-clean-profile");
  await step("Portable file opened in a fresh browser profile");
  const visual = process.env.FORMA_APPLE_VISUAL !== "0";
  for (const [tag, sample] of visual ? Object.entries(manifest.samples) : []) {
    const result = await capture(tag, sample);
    report.samples.push(result);
    await checkpoint();
    console.log(tag, JSON.stringify(result.pixels));
  }
  if (visual) report.phases.push("six-source-comparisons");
  assert.equal(
    report.structure.missingSourcePngHashes +
      report.structure.unsupportedStyleDefinitions +
      report.structure.mismatchedVariableDefinitions +
      report.structure.missingSourceFonts +
      report.structure.duplicateIds +
      report.structure.missingParents +
      report.structure.invalidInstanceRef,
    0,
  );
  assert.deepEqual(report.structure.mismatches, {
    missing: 0,
    parent: 0,
    name: 0,
    text: 0,
    master: 0,
    instanceTarget: 0,
    siblingOrders: 0,
  });
  assert.deepEqual(errors, []);
  const tag = manifest.samples.toggle;
  if (!visual) {
    await page
      .getByRole("region", { name: "页面列表" })
      .getByRole("button", { name: tag.page, exact: true })
      .click();
    await page.getByLabel("搜索图层", { exact: true }).fill(tag.name);
  }
  const target = page.locator('[data-layer-id="' + tag.id + '"] .layer-main');
  await target.dblclick();
  const field = page.getByLabel("重命名图层", { exact: true });
  const name = "开关 · e\u0301 · \u{100EC3} · 👩🏽‍💻";
  await field.fill(name);
  await field.press("Enter");
  const search = page.getByLabel("搜索图层", { exact: true });
  await search.fill(name);
  await page
    .getByRole("button", { name: "选择图层 " + name, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await search.fill(tag.name);
  await page
    .getByRole("button", { name: "选择图层 " + tag.name, exact: true })
    .waitFor();
  report.phases.push("unicode-master-rename-and-undo");
  if (visual) {
    report.textEdit = await verifyCoverTextEdit();
    report.phases.push("cover-edit-visible-text-and-undo");
  }
  if (process.env.FORMA_APPLE_DOWNLOAD_PROJECT === "1") {
    const cover = manifest.samples.cover;
    await page
      .getByRole("region", { name: "页面列表" })
      .getByRole("button", { name: cover.page, exact: true })
      .click();
    await page.getByLabel("搜索图层", { exact: true }).fill(cover.name);
    await page
      .locator('[data-layer-id="' + cover.id + '"] .layer-main')
      .click();
    await step("Downloading full React project");
    const start = performance.now();
    await page.getByLabel("文件菜单", { exact: true }).click();
    const ready = page.waitForEvent("download", { timeout: 600000 });
    await page
      .getByRole("button", { name: "导出整个文件为 React 项目…", exact: true })
      .click({ timeout: 600000 });
    const archive = path.join(root, "apple-kit-react-file.zip");
    await (await ready).saveAs(archive);
    const routes = execFileSync("unzip", ["-p", archive, "src/pages.ts"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    assert.ok(
      routes.includes("export const start = " + JSON.stringify(cover.id)),
      "Exported project should start on the source cover",
    );
    report.project = {
      exportMs: elapsed(start),
      zipBytes: (await stat(archive)).size,
      entryScreen: cover.id,
    };
    report.phases.push("full-project-downloaded");
  }
  if (visual) assertAppleVisuals(report.samples);
} catch (e) {
  report.error = e.message.slice(0, 2200);
  console.error(
    "Last UI",
    (
      await page
        .locator("body")
        .innerText()
        .catch(() => "")
    ).slice(-1200),
  );
  await page
    .screenshot({ path: path.join(root, "failure.png"), timeout: 5000 })
    .catch(() => {});
  throw e;
} finally {
  report.browserErrors = errors;
  await checkpoint();
  await browser.close();
}
