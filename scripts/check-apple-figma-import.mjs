// Run from the repository with node --import tsx. All licensed inputs and screenshots stay under output/.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { preview } from "vite";
import { assertPixelLimit, compareApplePixels } from "./apple-kit-pixels.mjs";
import { launchQaBrowser } from "./qa-browser.mjs";
import { openDesignArchive } from "../src/infrastructure/design-import/archive.ts";
import { readFigmaCanvas } from "../src/infrastructure/design-import/figma-kiwi.ts";
import { readNativeDocument } from "../src/infrastructure/native-document.ts";
import { readSourceProject } from "../src/infrastructure/project-revision.ts";

const output = path.resolve(
  process.env.FORMA_APPLE_FIGMA_OUTPUT || "output/playwright/apple-figma-0.8.3",
);
const file = path.resolve(
  process.argv[2] || path.join(output, "iOS and iPadOS 27 (Community).fig"),
);
const base = process.env.FORMA_URL || "http://127.0.0.1:4183";
const expected =
  "d6a0a6370b17f5c109d5ef227915ef6d59bf0da23076292e09fb87fd5e63a11a";
const ids = {
  cover: "2401:4",
  button: "5:108579",
  "toggle-on": "5433:19060",
  "toggle-off": "5433:20192",
  "alert-button": "5446:6654",
  alert: "65:57149",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = (g) => g && "fig-" + g.sessionID + "-" + g.localID;
const oracle = await (async () => {
  const bytes = await readFile(file);
  assert.equal(hash(bytes), expected, "Apple Figma source SHA-256");
  const a = openDesignArchive(bytes),
    { message, version } = readFigmaCanvas(a.read("canvas.fig")),
    records = message.nodeChanges;
  const index = new Map(records.map((n) => [id(n.guid), n]));
  const pages = records
    .filter((n) => n.type === "CANVAS" && !n.internalOnly)
    .sort((a, b) => (a.parentIndex.position < b.parentIndex.position ? -1 : 1))
    .map((p) => ({ id: id(p.guid), name: p.name.trim() }));
  const samples = Object.fromEntries(
    Object.entries(ids).map(([tag, key]) => {
      const n = index.get("fig-" + key.replace(":", "-"));
      assert.ok(n, key);
      let scene = n,
        p = n;
      while (p.type !== "CANVAS") {
        if (p.type !== "SECTION") scene = p;
        p = index.get(id(p.parentIndex.guid));
      }
      return [
        tag,
        {
          id: id(n.guid),
          name: n.name,
          page: p.name.trim(),
          pageId: id(p.guid),
          scene: id(scene.guid),
          sceneName: scene.name,
          size: [n.size.x, n.size.y],
        },
      ];
    }),
  );
  const styles = records
    .filter((n) => n.styleType)
    .map((n) => [
      id(n.guid),
      n.name,
      { TEXT: "text", FILL: "paint", EFFECT: "effect" }[n.styleType],
    ]);
  const strokeStacks = records
    .filter((n) => n.strokePaints?.length > 1)
    .map((n) => ({
      id: id(n.guid),
      width: n.strokeWeight ?? 1,
      shared: id(n.styleIdForStrokeFill?.guid),
      paints: n.strokePaints
        .slice()
        .reverse()
        .map((p) => ({
          color:
            "#" +
            ["r", "g", "b"]
              .map((k) =>
                Math.round(255 * p.color[k])
                  .toString(16)
                  .padStart(2, "0"),
              )
              .join(""),
          opacity: (p.color.a ?? 1) * (p.opacity ?? 1),
          visible: p.visible !== false,
          blendMode:
            p.blendMode && p.blendMode !== "NORMAL"
              ? p.blendMode.toLowerCase().replaceAll("_", "-")
              : undefined,
          colorVariableId: id(p.colorVar?.value?.alias?.guid),
        })),
    }));
  assert.equal(strokeStacks.length, 286);
  const masters = records.filter((n) => n.type === "SYMBOL" && !n.styleType);
  const groups = new Set(
    masters.map((n) =>
      index.get(id(n.parentIndex.guid))?.isStateGroup
        ? id(n.parentIndex.guid)
        : id(n.guid),
    ),
  );
  assert.deepEqual(
    [
      version,
      pages.length,
      records.length,
      masters.length,
      groups.size,
      styles.length,
    ],
    [106, 46, 37738, 4749, 2551, 233],
  );
  return {
    bytes: bytes.length,
    version,
    records: records.length,
    pages,
    styles,
    strokeStacks,
    masters: masters.length,
    groups: groups.size,
    samples,
    images: a.names.filter((n) => n.startsWith("images/") && !n.endsWith("/"))
      .length,
  };
})();
const report = {
  sha256: expected,
  sourceBytes: oracle.bytes,
  sourceVersion: oracle.version,
  phases: [],
  samples: {},
  errors: [],
};
await mkdir(output, { recursive: true });
const reportPath = path.join(output, "figma-acceptance.json"),
  checkpoint = () =>
    writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
const stage = async (name) => {
  report.phases.push(name);
  console.log(name);
  await checkpoint();
};
const nativePath = path.join(output, "apple-figma.forma.json"),
  zipPath = path.join(output, "apple-figma-react.zip");
async function structure() {
  const doc = await readNativeDocument(await openAsBlob(nativePath));
  assert.equal(doc.importReport.sha256, expected);
  assert.equal(doc.importReport.format, "Figma");
  assert.equal(doc.importReport.sourceNodes, oracle.records);
  assert.deepEqual(
    doc.pages.map(({ id, name }) => ({ id, name })),
    oracle.pages,
  );
  const libs = Object.values(doc.libraries ?? {}),
    components = libs.flatMap((l) => l.components),
    authored = components.filter((c) => c.category !== "Figma 插槽内容"),
    auxiliary = components.filter((c) => c.category === "Figma 插槽内容"),
    variants = new Set();
  for (const lib of libs)
    for (const c of lib.components)
      for (const v of c.variants)
        variants.add(JSON.stringify([lib.id, c.id, v.id]));
  const authoredVariants = authored.reduce(
    (sum, c) => sum + c.variants.length,
    0,
  );
  assert.equal(authored.length, oracle.groups);
  assert.equal(authoredVariants, oracle.masters);
  const styles = doc.designSystem.styles,
    available = new Map(),
    styleCounts = {};
  for (const [key, name, kind] of oracle.styles) {
    const s = styles[key];
    assert.equal(s?.kind, kind, key);
    assert.ok(s.name === name || s.name === name + " (" + key + ")", key);
    styleCounts[kind] = (styleCounts[kind] ?? 0) + 1;
  }
  let instances = 0,
    textNodes = 0,
    sourceGlyphLayers = 0,
    bindings = 0;
  const byId = new Map();
  for (const p of doc.pages) {
    const nodes = p.nodes ?? doc.nodes,
      local = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
      assert.ok(!byId.has(n.id), n.id);
      byId.set(n.id, n);
      available.set(n.id, p.id);
      assert.ok(!n.parentId || local.has(n.parentId), n.id);
      assert.ok(!n.name.includes("\uFFFD") && !n.text.includes("\uFFFD"), n.id);
      if (n.type === "text") textNodes++;
      if (n.sourceTextShape) sourceGlyphLayers++;
      if (n.instance) {
        const r = n.instance;
        assert.ok(
          variants.has(
            JSON.stringify([r.libraryId, r.componentId, r.variantId]),
          ),
          n.id,
        );
        instances++;
      }
      for (const ref of Object.values(n.styleBindings ?? {})) {
        assert.ok(styles[ref], ref);
        bindings++;
      }
    }
  }
  const nativeTree = JSON.parse(
    await readFile(
      path.join(path.dirname(file), "material-controls", "native-tree.json"),
      "utf8",
    ),
  );
  assert.deepEqual(nativeTree.errors, []);
  const blankSections = nativeTree.pages.flatMap((p) =>
    p.rows
      .filter((row) => row[4] === "SECTION" && row[3] === "")
      .map((row) => "fig-" + row[0].replace(":", "-")),
  );
  assert.equal(blankSections.length, 11);
  for (const id of blankSections)
    assert.equal(
      byId.get(id)?.name,
      "",
      id + " preserves the native empty section name",
    );
  const painted = new Map();
  for (const n of [
    ...byId.values(),
    ...components.flatMap((c) => c.variants.flatMap((v) => v.nodes)),
  ])
    if (n.style.strokePaints) painted.set(n.id, n);
  let sharedStrokeStacks = 0,
    sharedDouble = 0;
  for (const expected of oracle.strokeStacks) {
    const n = painted.get(expected.id);
    assert.ok(n, expected.id);
    assert.equal(n.style.strokeWidth, expected.width, expected.id);
    assert.deepEqual(
      n.style.strokePaints.map((p) => ({
        color: p.color,
        opacity: p.opacity,
        visible: p.visible,
        blendMode: p.blendMode,
        colorVariableId: p.colorVariableId,
      })),
      expected.paints,
      expected.id,
    );
    if (expected.shared) {
      assert.equal(n.styleBindings.stroke, expected.shared, expected.id);
      sharedStrokeStacks++;
      assert.ok(
        !n.styleOverrides?.some((k) => k.startsWith("strokePaints")),
        expected.id,
      );
      if (styles[expected.shared].properties.paints?.length === 2)
        sharedDouble++;
    }
  }
  assert.deepEqual([sharedStrokeStacks, sharedDouble], [134, 75]);
  for (const sample of Object.values(oracle.samples)) {
    const n = byId.get(sample.id);
    assert.equal(available.get(sample.id), sample.pageId);
    assert.equal(n.name, sample.name);
    assert.deepEqual([n.style.width, n.style.height], sample.size);
  }
  assert.ok(bindings > 0);
  assert.ok(instances > 0);
  assert.ok(textNodes > 0);
  assert.ok(sourceGlyphLayers >= 10000, "Source glyphs in page nodes");
  assert.equal(Object.keys(doc.images).length, oracle.images);
  return {
    pages: doc.pages.length,
    components: authored.length,
    variants: authoredVariants,
    auxiliaryComponents: auxiliary.length,
    totalVariants: variants.size,
    styles: styleCounts,
    bindings,
    nativeEmptySections: blankSections.length,
    variables: Object.keys(doc.designSystem.variables).length,
    nodes: byId.size,
    instances,
    strokeStacks: oracle.strokeStacks.length,
    sharedStrokeStacks,
    sharedDoublePaints: sharedDouble,
    textNodes,
    sourceGlyphLayers,
    images: Object.keys(doc.images).length,
    issues: doc.importReport.issues.length,
  };
}
const settings = {
  viewport: { width: 2200, height: 1500 },
  deviceScaleFactor: 1,
};
const browser = await launchQaBrowser("chromium");
report.browser = browser.version();
let context, page;
async function fresh() {
  if (context) await context.close();
  context = await browser.newContext(settings);
  page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on("pageerror", (e) => report.errors.push(e.message));
}
const editor = () =>
  page.locator(".editor-canvas").waitFor({ timeout: 360000 });
const pageList = () => page.getByRole("region", { name: "页面列表" });
async function select(sample, scene = false) {
  await pageList()
    .getByRole("button", { name: sample.page, exact: true })
    .click();
  const key = scene ? sample.scene : sample.id,
    name = scene ? sample.sceneName : sample.name;
  await page.getByLabel("搜索图层", { exact: true }).fill(name);
  const row = page.locator('[data-layer-id="' + key + '"] .layer-main');
  await row.click();
  return row;
}
async function snap(target, folder, tag, sample) {
  await target.waitFor({ timeout: 120000 });
  await target.evaluate(async (el) => {
    await document.fonts.ready;
    await Promise.all([...el.querySelectorAll("img")].map((im) => im.decode()));
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  });
  const box = await target.boundingBox();
  assert.ok(box?.width > 0 && box.height > 0, sample.id);
  await mkdir(path.join(output, folder), { recursive: true });
  const bytes = await target.screenshot({
    path: path.join(output, folder, tag + ".png"),
    scale: "css",
    animations: "disabled",
    timeout: 120000,
  });
  return {
    box,
    pngSize: [bytes.readUInt32BE(16), bytes.readUInt32BE(20)],
    sha256: hash(bytes),
  };
}
async function editorFlow() {
  await fresh();
  await page.goto(base);
  const entry = await page
    .locator('script[type="module"][src]')
    .last()
    .getAttribute("src");
  const bundle = Buffer.from(
    await (await fetch(new URL(entry, base))).arrayBuffer(),
  );
  report.servedEntry = entry;
  report.servedEntrySha256 = hash(bundle);
  if (process.env.FORMA_EXPECT_ENTRY_SHA256)
    assert.equal(
      report.servedEntrySha256,
      process.env.FORMA_EXPECT_ENTRY_SHA256,
      "Production editor build SHA-256",
    );
  const worker = bundle
    .toString("utf8")
    .match(/["'](\/assets\/worker-[\w-]+\.js)["']/)?.[1];
  if (worker) {
    report.servedWorker = worker;
    report.servedWorkerSha256 = hash(
      Buffer.from(await (await fetch(new URL(worker, base))).arrayBuffer()),
    );
  }
  if (process.env.FORMA_EXPECT_WORKER_SHA256)
    assert.equal(
      report.servedWorkerSha256,
      process.env.FORMA_EXPECT_WORKER_SHA256,
      "Production import worker SHA-256",
    );
  const chooser = page.waitForEvent("filechooser");
  await page.getByLabel("导入设计文件", { exact: true }).click();
  await (await chooser).setFiles(file);
  const dialog = page.getByRole("dialog", { name: "设计文件导入报告" });
  await dialog
    .locator("button.primary:enabled,[role=alert]")
    .first()
    .waitFor({ timeout: 600000 });
  if (await dialog.getByRole("alert").count())
    throw Error(await dialog.getByRole("alert").innerText());
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载导入报告" }).click();
  await (await download).saveAs(path.join(output, "figma-import-report.json"));
  await dialog
    .getByRole("button", { name: "导入为新文件", exact: true })
    .click();
  await page.waitForURL((u) => u.searchParams.has("file"), { timeout: 600000 });
  await editor();
  await stage("source-imported");
  await page.reload();
  await editor();
  const fileDownload = page.waitForEvent("download", { timeout: 600000 });
  await page.getByLabel("设计文件", { exact: true }).click();
  await (await fileDownload).saveAs(nativePath);
  const nativeHash = createHash("sha256");
  for await (const chunk of createReadStream(nativePath))
    nativeHash.update(chunk);
  report.nativeFile = {
    bytes: (await stat(nativePath)).size,
    sha256: nativeHash.digest("hex"),
  };
  report.structure = await structure();
  await stage("portable-structure-verified");
  await fresh();
  await page.goto(base);
  await page.getByLabel("打开本机工作空间文件列表").click();
  await page.getByTestId("browser-design-file-input").setInputFiles(nativePath);
  await page.waitForURL((u) => u.searchParams.has("file"), { timeout: 600000 });
  await editor();
  assert.equal(await pageList().locator("button.page-name").count(), 46);
  await stage("portable-reopened-clean-profile");
  for (const [tag, s] of Object.entries(oracle.samples)) {
    await select(s, true);
    await page.locator(".editor-canvas").focus();
    await page.keyboard.press("Shift+2");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await page.getByLabel("缩放模式").selectOption("100");
    const target = page
      .locator('.preview-dialog [data-design-id="' + s.id + '"]')
      .first();
    report.samples[tag] = {
      ...s,
      preview: await snap(target, "preview", tag, s),
    };
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    await checkpoint();
  }
  const sample = oracle.samples.alert,
    titleId = "fig-65-57151",
    original = "A Short Title Is Best";
  await select({ ...sample, name: original, id: titleId });
  const canvas = page.locator(".editor-canvas");
  await canvas.focus();
  await page.keyboard.press("Shift+2");
  await page.keyboard.press("Enter");
  const inline = page.getByRole("textbox", { name: "画布文本编辑" }),
    edited = "新标题 · e\u0301 · 👩🏽‍💻";
  await inline.fill(edited);
  await canvas.focus();
  await inline.waitFor({ state: "detached" });
  const showTitle = async () => {
    await select(sample, true);
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await page.getByLabel("缩放模式").selectOption("100");
    return page.locator('.preview-dialog [data-design-id="' + titleId + '"]');
  };
  let title = await showTitle();
  assert.equal(
    await title.textContent(),
    edited,
    "Changed native text stays editable",
  );
  assert.equal(
    await title.locator("[data-source-glyphs]").count(),
    0,
    "Edited text reflows",
  );
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  title = await showTitle();
  assert.equal(await title.locator("span").first().textContent(), original);
  await title.locator("[data-source-glyphs]").waitFor();
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await stage("unicode-text-edit-glyph-invalidation-and-undo");
  await select({ ...sample, id: titleId, name: original });
  const mode = page.getByLabel("模式 Color Scheme", { exact: true });
  await mode.selectOption({ label: "Dark" });
  title = await showTitle();
  await title.waitFor();
  assert.equal(
    await title.evaluate((el) => getComputedStyle(el).color),
    "rgb(255, 255, 255)",
    "Dark label variable resolves in the prototype",
  );
  await title.locator("[data-source-glyphs]").waitFor();
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  title = await showTitle();
  assert.equal(
    await title.evaluate((el) => getComputedStyle(el).color),
    "rgb(0, 0, 0)",
    "Undo restores the source light mode",
  );
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await stage("variable-mode-alias-and-undo");
  const cover = oracle.samples.cover,
    row = await select(cover);
  await row.dblclick();
  const name = "设计封面 · e\u0301 · 👩🏽‍💻 · 🪷",
    field = page.getByLabel("重命名图层", { exact: true });
  await field.fill(name);
  await field.press("Enter");
  await page.getByLabel("搜索图层", { exact: true }).fill(name);
  await page
    .getByRole("button", { name: "选择图层 " + name, exact: true })
    .waitFor();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await select(cover);
  await stage("unicode-edit-and-undo");
  await page.getByLabel("文件菜单", { exact: true }).click();
  const zip = page.waitForEvent("download", { timeout: 600000 });
  await page
    .getByRole("button", { name: "导出整个文件为 React 项目…", exact: true })
    .click({ timeout: 600000 });
  await (await zip).saveAs(zipPath);
  await stage("project-downloaded");
}
async function projectFlow() {
  const input = await readFile(zipPath),
    { files, manifest } = readSourceProject(input);
  assert.equal(manifest.scope, "file");
  for (const [k, digest] of Object.entries(manifest.generated))
    assert.equal(hash(files[k]), digest, k);
  assert.equal(
    Object.keys(files).filter((n) => n.startsWith("src/assets/")).length,
    oracle.images,
  );
  const work = await mkdtemp(path.join(tmpdir(), "forma-apple-figma-project-"));
  try {
    for (const [k, bytes] of Object.entries(files)) {
      const dest = path.join(work, k);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
    }
    const opts = { cwd: work, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 };
    const install = execFileSync(
      "npm",
      ["install", "--prefer-offline", "--no-audit", "--no-fund"],
      opts,
    );
    const build = execFileSync("npm", ["run", "build"], opts);
    await writeFile(
      path.join(output, "react-build.log"),
      install + "\n" + build,
    );
    const server = await preview({
      root: work,
      configFile: false,
      preview: { host: "127.0.0.1", port: 0 },
      logLevel: "silent",
    });
    try {
      await fresh();
      const url = "http://127.0.0.1:" + server.httpServer.address().port + "/";
      await page.goto(url + "#screens");
      const directory = page.locator('a[href*="screen="]');
      await directory.first().waitFor();
      const screenCount = await directory.count();
      assert.ok(screenCount >= 6);
      report.project = {
        sha256: hash(input),
        bytes: input.byteLength,
        entries: Object.keys(files).length,
        generatedDigests: Object.keys(manifest.generated).length,
        directoryScreens: screenCount,
      };
      await checkpoint();
      for (const [tag, s] of Object.entries(oracle.samples)) {
        await page.goto(url + "#screen=" + encodeURIComponent(s.scene));
        const target = page.locator('[data-design-id="' + s.id + '"]').first();
        report.samples[tag].react = await snap(target, "react", tag, s);
        await checkpoint();
      }
      for (const [tag, sample] of Object.entries(report.samples)) {
        const pixels = await compareApplePixels(
          page,
          await readFile(path.join(output, "preview", tag + ".png")),
          await readFile(path.join(output, "react", tag + ".png")),
        );
        assert.ok(
          !pixels.dimensionMismatch && pixels.pct <= 0.5,
          "Preview/React parity " + tag + " " + JSON.stringify(pixels),
        );
        sample.previewVsReact = pixels;
      }
      const official =
        process.env.FORMA_FIGMA_REFERENCES || path.join(output, "source");
      if (
        process.env.FORMA_FIGMA_REFERENCES ||
        (await stat(official).then(
          (x) => x.isDirectory(),
          () => false,
        ))
      ) {
        const samplesByPath = [];
        for (const folder of ["preview", "react"]) {
          const compared = [];
          for (const [tag, sample] of Object.entries(report.samples)) {
            const input = await readFile(path.join(official, tag + ".png"));
            if (sample.referenceSha256)
              assert.equal(hash(input), sample.referenceSha256);
            sample.referenceSha256 = hash(input);
            const pixels = await compareApplePixels(
              page,
              input,
              await readFile(path.join(output, folder, tag + ".png")),
            );
            sample[folder + "VsOriginal"] = pixels;
            compared.push({ tag, sourceSize: sample.size, pixels });
          }
          await checkpoint();
          samplesByPath.push(compared);
        }
        for (const compared of samplesByPath)
          assertPixelLimit(compared, Object.keys(ids));
        await stage("six-original-visual-comparisons");
      }
      const on = report.samples["toggle-on"],
        off = report.samples["toggle-off"];
      assert.notEqual(
        on.preview.sha256,
        off.preview.sha256,
        "On and off must be distinct in the editor preview",
      );
      assert.notEqual(
        on.react.sha256,
        off.react.sha256,
        "On and off must be distinct in the React project",
      );
      for (const sample of Object.values(report.samples)) {
        assert.deepEqual(
          sample.preview.pngSize,
          sample.size,
          "Preview size " + sample.id,
        );
        assert.deepEqual(
          sample.react.pngSize,
          sample.size,
          "React size " + sample.id,
        );
      }
    } finally {
      await new Promise((r) => server.httpServer.close(r));
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  assert.deepEqual(report.errors, []);
  await stage("independent-react-built-and-rendered");
}
try {
  await editorFlow();
  await projectFlow();
  await rm(path.join(output, "failed.png"), { force: true });
} catch (e) {
  report.error = String(e);
  console.error(e);
  if (page)
    await page
      .screenshot({ path: path.join(output, "failed.png"), timeout: 5000 })
      .catch(() => {});
  throw e;
} finally {
  await checkpoint();
  await browser.close();
}
