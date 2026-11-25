// Exercise the native-file chooser, review, persistence and independently built React delivery.
// FORMA_IMPORT_FIXTURES may point to an offline directory with these hash-pinned files.
import assert from "node:assert/strict";
import bundle from "playwright-core/lib/utilsBundle";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preview } from "vite";
import { unzipSync } from "fflate";
import { launchQaBrowser } from "./qa-browser.mjs";

const sources = {
  sketch: {
    name: "with-color-variables.sketch",
    repo: "sketch-hq/sketch-document",
    revision: "4493900abbfa49ae82fbcb8ad85cccf2cc2256b0",
    path: "packages/file/src/__tests__/with-color-variables.sketch",
    sha: "25f08782f870235a33b8589dc812d54c915d7a5928ba3a8efd9a8c5e964b7204",
  },
  fig: {
    name: "components.fig",
    repo: "gridaco/grida",
    revision: "ec37e72de9cee80f4f19f381e916f386b986e1d8",
    path: "fixtures/test-fig/L0/components.fig",
    sha: "1fbdc089f3ab1ad5f7866d7ee37c096de34cb3c07ec26222991f4954dc022437",
  },
};
sources.sds = {
  name: "figma-simple-design-system.fig",
  repo: "gridaco/grida",
  revision: sources.fig.revision,
  path: "fixtures/test-fig/community/1380235722331273046-figma-simple-design-system.fig",
  sha: "baf0a1b1154a8e4ad98b2143482fddbcbeee13415f7fd672af71d973a67e1c2b",
};
sources.paint = {
  name: "shared-paint.fig",
  local: "docs/evidence/2026-11-22/design-import/shared-paint.fig",
  sha: "5ef901a1829f3013cfb218ec7a376ae4e6dc463314bd4b2586622089b3df8eab",
};
const hash = (b) => createHash("sha256").update(b).digest("hex");
const engine = process.env.BROWSER_ENGINE || "chromium";
const base = process.env.FORMA_URL || "http://127.0.0.1:4173/";
const output = path.resolve("output/playwright/design-import", engine);
await mkdir(output, { recursive: true });
const work = await mkdtemp(path.join(tmpdir(), "forma-design-import-check-"));
const browser = await launchQaBrowser(engine);
const results = [];
const failed = [];

async function fixture(source) {
  if (source.local) {
    const bytes = await readFile(source.local);
    assert.equal(hash(bytes), source.sha);
    return bytes;
  }
  if (process.env.FORMA_IMPORT_FIXTURES) {
    const bytes = await readFile(
      path.join(process.env.FORMA_IMPORT_FIXTURES, source.name),
    );
    assert.equal(hash(bytes), source.sha);
    return bytes;
  }
  const problems = [];
  for (const url of [
    `https://raw.githubusercontent.com/${source.repo}/${source.revision}/${source.path}`,
    `https://media.githubusercontent.com/media/${source.repo}/${source.revision}/${source.path}`,
    `https://cdn.jsdelivr.net/gh/${source.repo}@${source.revision}/${source.path}`,
  ]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(hash(bytes), source.sha);
      return bytes;
    } catch (e) {
      problems.push(e.message);
    }
  }
  throw Error(
    "Fixture unavailable or digest mismatch: " +
      source.name +
      " " +
      problems.join(", "),
  );
}

async function download(page, button) {
  const ready = page.waitForEvent("download");
  await button.click();
  return readFile(await (await ready).path());
}

async function documentFile(page) {
  return JSON.parse(
    await download(page, page.getByLabel("设计文件", { exact: true })),
  );
}

function checkStructure(kind, doc) {
  const pages = doc.pages.map((p) => ({
    name: p.name,
    nodes: p.nodes ?? doc.nodes,
  }));
  const nodes = pages.flatMap((p) => p.nodes);
  const ids = new Set(nodes.map((n) => n.id));
  assert.equal(ids.size, nodes.length);
  for (const p of pages) {
    const local = new Set(p.nodes.map((n) => n.id));
    for (const n of p.nodes)
      if (n.parentId !== null)
        assert.ok(local.has(n.parentId), n.name + " orphan");
  }
  const libraries = Object.values(doc.libraries ?? {});
  const definitions = libraries.flatMap((l) => l.components);
  const instances = nodes.filter((n) => n.instance);
  for (const n of instances) {
    const component = doc.libraries[n.instance.libraryId].components.find(
      (c) => c.id === n.instance.componentId,
    );
    assert.ok(component.variants.some((v) => v.id === n.instance.variantId));
  }
  const styles = Object.values(doc.designSystem?.styles ?? {});
  const variables = Object.values(doc.designSystem?.variables ?? {});
  for (const n of nodes) {
    for (const id of Object.values(n.styleBindings ?? {}))
      assert.ok(styles.some((s) => s.id === id));
  }
  let selected;
  if (kind === "fig") {
    assert.deepEqual(
      pages.map((p) => p.name),
      ["components", "components-set", "instances", "instances-with-overrides"],
    );
    assert.equal(instances.length, 8);
    for (const p of pages.slice(2)) {
      const expected = p.name === "instances";
      assert.deepEqual(
        p.nodes.filter((n) => n.instance).map((n) => n.name),
        ["red", "blue", "components-set", "components-set"],
      );
      for (const [index, n] of p.nodes.filter((n) => n.instance).entries()) {
        assert.equal(n.style.width, 100);
        assert.equal(n.style.height, 100);
        assert.equal(n.style.x, (index % 2) * 150);
        assert.equal(n.style.y, Math.floor(index / 2) * 150);
        assert.equal(
          n.style.fill.toLowerCase(),
          index % 2 ? "#0000ff" : "#ff0000",
        );
        assert.equal(
          (n.style.paints?.length
            ? n.style.paints.at(-1).opacity
            : n.style.fillOpacity) ?? 1,
          expected ? 1 : 0.5,
        );
      }
    }
    selected = pages[3].nodes.find((n) => n.instance && n.name === "blue");
  } else if (kind === "paint") {
    selected = nodes.find((n) => n.name === "蓝底白卡");
    const child = nodes.find((n) => n.name === "边线");
    assert.ok(selected.styleBindings.paint);
    assert.equal(child.styleBindings.stroke, selected.styleBindings.paint);
  } else if (kind === "sds") {
    assert.equal(pages.length, 30);
    selected = pages[0].nodes.find(
      (n) => n.name === "Cover" && n.parentId === null,
    );
    assert.ok(selected);
    assert.deepEqual(
      [selected.style.width, selected.style.height],
      [1920, 1080],
    );
    assert.equal(
      variables.filter((v) => !v.id.startsWith("alpha-")).length,
      407,
    );
    assert.equal(styles.length, 313);
    assert.equal(definitions.flatMap((d) => d.variants).length, 2720);
    assert.equal(Object.keys(doc.images).length, 26);
  } else {
    assert.equal(pages[0].name, "Page 1");
    assert.ok(pages.some((p) => p.name === "Symbols"));
    selected = pages[0].nodes.find(
      (n) => n.name === "Overview" && n.parentId === null,
    );
    assert.ok(selected, "Overview artboard missing");
    assert.deepEqual(
      [
        selected.style.x,
        selected.style.y,
        selected.style.width,
        selected.style.height,
      ],
      [1007, -424, 375, 1725],
    );
    assert.ok(instances.length >= 68, "source contains 68 instance nodes");
    assert.ok(
      definitions.flatMap((d) => d.variants).length >= 46,
      "source contains 46 local masters",
    );
    for (const expected of [
      "Body 17pt / Black / Left",
      "label-small-black",
      "label-small-white",
    ])
      assert.ok(
        styles.some((s) => s.name === expected),
        expected,
      );
    for (const expected of ["Orange", "Important Blue", "Light Grey"])
      assert.ok(
        variables.some((v) => v.name === expected),
        expected,
      );
    assert.ok(
      nodes.filter((n) => n.styleBindings?.text).length >= 5,
      "source contains five shared style references",
    );
    assert.ok(
      nodes.some((n) => n.text === "× 250G"),
      "Unicode text",
    );
  }
  return {
    selected,
    counts: {
      pages: pages.map((p) => p.name),
      nodes: nodes.length,
      instances: instances.length,
      components: definitions.length,
      variants: definitions.flatMap((d) => d.variants).length,
      styles: styles.length,
      variables: variables.length,
    },
  };
}

async function compareReference(page, reference, rendered, thumbnail = false) {
  return page.evaluate(
    async ([left, right, thumbnail]) => {
      const decode = async (base64, target) => {
        const image = new Image();
        image.src = "data:image/png;base64," + base64;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = target?.w ?? image.width;
        canvas.height = target?.h ?? image.height;
        const ctx = canvas.getContext("2d", { colorSpace: "srgb" });
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        return {
          w: canvas.width,
          h: canvas.height,
          data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        };
      };
      const a = await decode(left),
        b = await decode(right, thumbnail ? a : undefined);
      if (a.w !== b.w || a.h !== b.h)
        throw Error("Visual comparison size mismatch " + [a.w, a.h, b.w, b.h]);
      let over16 = 0,
        maximum = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const delta = Math.max(
          ...[0, 1, 2].map((k) => Math.abs(a.data[i + k] - b.data[i + k])),
        );
        if (delta > 16) over16++;
        maximum = Math.max(maximum, delta);
      }
      return {
        width: a.w,
        height: a.h,
        over16,
        total: a.w * a.h,
        percent: (100 * over16) / (a.w * a.h),
        maximum,
      };
    },
    [reference.toString("base64"), rendered.toString("base64"), thumbnail],
  );
}

async function verifySharedCenterStroke(target) {
  const paint = await target.evaluate((n) => {
    const style = getComputedStyle(n);
    return { fill: style.backgroundColor, shadow: style.boxShadow };
  });
  assert.equal(paint.fill, "rgb(255, 255, 255)");
  const halfStroke = "rgb(0, 204, 68) 0px 0px 0px 3px";
  assert.equal(paint.shadow.split(halfStroke).length - 1, 2, paint.shadow);
  assert.match(paint.shadow, /inset/);
}

async function checkEditable(page, doc, selected, kind, row) {
  if (kind === "paint") {
    await page
      .getByRole("button", { name: "变量与样式", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", {
      name: "变量与样式",
      exact: true,
    });
    await dialog.getByRole("button", { name: "样式", exact: true }).click();
    await dialog.getByRole("button", { name: "品牌蓝", exact: true }).click();
    const hex = dialog.getByLabel("样式填充 HEX", { exact: true });
    await hex.fill("00CC44");
    await hex.press("Enter");
    await dialog
      .getByRole("button", { name: "关闭变量与样式", exact: true })
      .click();
    const child = doc.nodes.find((n) => n.name === "边线");
    await verifySharedCenterStroke(
      page.locator(`[data-node-id="${child.id}"]`),
    );
    row.phases.push("shared-fill-and-stroke");
  }
  if (kind === "sketch") {
    const style = Object.values(doc.designSystem.styles).find(
      (s) => s.name === "label-small-white",
    );
    const target = doc.nodes.find(
      (n) =>
        n.styleBindings?.text === style.id &&
        !n.styleOverrides?.includes("fontWeight"),
    );
    assert.ok(target, "shared style needs a bound, inheriting layer");
    const search = page.getByLabel("搜索图层", { exact: true });
    await search.fill(target.name);
    await page.locator(`[data-layer-id="${target.id}"] .layer-main`).click();
    await page.locator(".editor-canvas").focus();
    await page.keyboard.press("Shift+2");
    const bound = page.locator(`[data-node-id="${target.id}"]`);
    await bound.waitFor();
    const original = await bound.evaluate(
      (el) => getComputedStyle(el).fontWeight,
    );
    await page
      .getByRole("button", { name: "变量与样式", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", {
      name: "变量与样式",
      exact: true,
    });
    await dialog.getByRole("button", { name: "样式", exact: true }).click();
    await dialog.getByRole("button", { name: style.name, exact: true }).click();
    const field = dialog.getByLabel("样式属性 fontWeight", { exact: true });
    await field.fill("300");
    await field.press("Enter");
    await page.waitForFunction(
      (id) =>
        getComputedStyle(document.querySelector('[data-node-id="' + id + '"]'))
          .fontWeight === "300",
      target.id,
    );
    await dialog
      .getByRole("button", { name: "撤销设计系统修改", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "关闭变量与样式", exact: true })
      .click();
    assert.equal(
      await bound.evaluate((el) => getComputedStyle(el).fontWeight),
      original,
    );
    row.phases.push("shared-text-style-propagation");
  }
  if (kind === "fig") {
    const pageWithMaster = doc.pages.find((p) => p.name === "components");
    if (pageWithMaster.id !== doc.activePage)
      await page
        .getByRole("button", { name: pageWithMaster.name, exact: true })
        .click();
    const master = (pageWithMaster.nodes ?? doc.nodes).find(
      (n) => n.name === "blue",
    );
    await page.locator(`[data-layer-id="${master.id}"] .layer-main`).click();
    const color = page.getByLabel("填充 HEX", { exact: true });
    await color.fill("00CC44");
    await color.press("Enter");
    const modified = await documentFile(page);
    function members(d, name) {
      const p = d.pages.find((p) => p.name === name);
      return p.nodes ?? d.nodes;
    }
    const updated = members(modified, "instances").find(
      (n) => n.name === "blue" && n.instance,
    );
    assert.equal(
      updated.style.fill.toLowerCase(),
      "#00cc44",
      "master fill must propagate to linked instance on another page",
    );
    const override = members(modified, "instances-with-overrides").find(
      (n) => n.name === "blue" && n.instance,
    );
    assert.equal(
      override.style.fill.toLowerCase(),
      "#0000ff",
      "explicit blue alpha override must survive master edit",
    );
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    row.phases.push("master-propagation-and-local-override");
  }
  const owner = doc.pages.find((p) =>
    (p.nodes ?? doc.nodes).some((n) => n.id === selected.id),
  );
  if (owner.id !== doc.activePage)
    await page.getByRole("button", { name: owner.name, exact: true }).click();
  const search = page.getByLabel("搜索图层", { exact: true });
  await search.fill(selected.name);
  const target = page.locator(`[data-layer-id="${selected.id}"] .layer-main`);
  if (kind === "fig") {
    await target.click();
    await page.getByRole("button", { name: "重置覆盖", exact: true }).click();
    const recovered = await documentFile(page);
    const value = recovered.nodes.find((n) => n.id === selected.id);
    assert.equal(value.style.fillOpacity ?? 1, 1);
    assert.equal(value.instanceOverrides?.length ?? 0, 0);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    const reverted = await documentFile(page);
    assert.equal(
      reverted.nodes.find((n) => n.id === selected.id).style.fillOpacity,
      0.5,
    );
    row.phases.push("reset-override-and-undo");
  }
  await target.dblclick();
  const newName = "界面 · e\u0301 · \u{100EC3} · 👩🏽‍💻";
  await page.getByLabel("重命名图层", { exact: true }).fill(newName);
  await page.getByLabel("重命名图层", { exact: true }).press("Enter");
  await search.fill(newName);
  await page
    .getByRole("button", { name: "选择图层 " + newName, exact: true })
    .waitFor();
  const renamed = await documentFile(page);
  assert.equal(renamed.nodes.find((n) => n.id === selected.id).name, newName);
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await search.fill(selected.name);
  await target.click();
  const after = await documentFile(page);
  assert.equal(
    after.nodes.find((n) => n.id === selected.id).name,
    selected.name,
  );
  row.phases.push("rename-unicode-and-undo");
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("Shift+2");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  const preview = page.locator(`[data-design-id="${selected.id}"]`).first();
  await preview.waitFor();
  const size = await preview.evaluate((n) => [n.offsetWidth, n.offsetHeight]);
  assert.deepEqual(size, [selected.style.width, selected.style.height]);
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  row.phases.push("preview");
  return documentFile(page);
}

async function deliveredProject(page, doc, selected, kind, row, sourceBytes) {
  await page.getByLabel("文件菜单", { exact: true }).click();
  const bytes = await download(
    page,
    page.getByRole("button", {
      name: "导出整个文件为 React 项目…",
      exact: true,
    }),
  );
  const dir = path.join(work, kind);
  await mkdir(dir);
  const files = unzipSync(bytes);
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    const target = path.resolve(dir, name);
    assert.ok(target.startsWith(dir + path.sep));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  assert.deepEqual(
    JSON.parse(await readFile(path.join(dir, "design.forma.json"), "utf8")),
    doc,
  );
  for (const args of [
    [
      "install",
      "--ignore-scripts",
      "--no-fund",
      "--no-audit",
      "--prefer-offline",
      "--include=dev",
    ],
    ["run", "build"],
  ]) {
    try {
      execFileSync("npm", args, { cwd: dir, stdio: "pipe", timeout: 120000 });
    } catch (e) {
      throw Error(
        "React project " +
          args[0] +
          " failed: " +
          String(e.stdout) +
          String(e.stderr),
      );
    }
  }
  const host = await preview({
    root: dir,
    configFile: false,
    logLevel: "silent",
    preview: { host: "127.0.0.1", port: 0 },
  });
  try {
    const app = await browser.newPage({
      viewport: { width: selected.style.width, height: selected.style.height },
      deviceScaleFactor: 1,
    });
    const problems = [];
    app.on("pageerror", (e) => problems.push(e.message));
    await app.goto(
      "http://127.0.0.1:" +
        host.httpServer.address().port +
        "/#screen=" +
        encodeURIComponent(selected.id),
    );
    const el = app.locator(`[data-design-id="${selected.id}"]`).first();
    await el.waitFor({ state: "visible" });
    const pixels = await el.evaluate((n) => ({
      width: n.offsetWidth,
      height: n.offsetHeight,
      fill: getComputedStyle(n).backgroundColor,
      background: getComputedStyle(n).backgroundImage,
      text: n.innerText.length,
    }));
    if (kind === "fig") {
      assert.deepEqual([pixels.width, pixels.height], [100, 100]);
      assert.match(
        [pixels.fill, pixels.background].join(" "),
        /rgba?\(0, 0, 255/,
      );
    } else if (kind === "paint") {
      assert.equal(pixels.fill, "rgb(0, 204, 68)");
      const child = doc.nodes.find((n) => n.name === "边线");
      const border = app.locator(`[data-design-id="${child.id}"]`);
      await verifySharedCenterStroke(border);
      const shot = bundle.PNG.sync.read(await border.screenshot());
      for (const x of [0, 1, 2, 3, 4]) {
        const pos = 4 * (Math.floor(shot.height / 2) * shot.width + x);
        assert.deepEqual(
          [...shot.data.subarray(pos, pos + 3)],
          x < 3 ? [0, 204, 68] : [255, 255, 255],
          "3 px of the centered 6 px stroke inside the rectangle",
        );
      }
    } else {
      assert.deepEqual(
        [pixels.width, pixels.height],
        [selected.style.width, selected.style.height],
      );
      assert.ok(pixels.text > 0);
    }
    const rendered = await el.screenshot({
      path: path.join(output, kind + "-project.png"),
      animations: "disabled",
    });
    if (kind === "sketch" && process.env.FORMA_SKETCH_REFERENCE_PNG) {
      const reference = await readFile(process.env.FORMA_SKETCH_REFERENCE_PNG);
      row.sourceVisual = await compareReference(app, reference, rendered);
      row.sourceVisual.referenceSha256 = hash(reference);
      row.sourceVisual.withinProposedThreshold =
        row.sourceVisual.percent <= 0.5;
    }
    if (kind === "sds") {
      const archive = unzipSync(sourceBytes, {
        filter: (e) => ["thumbnail.png", "meta.json"].includes(e.name),
      });
      const meta = JSON.parse(
        new TextDecoder().decode(archive["meta.json"]),
      ).client_meta;
      assert.deepEqual(
        [meta.render_coordinates.width, meta.render_coordinates.height],
        [selected.style.width, selected.style.height],
      );
      row.thumbnailVisual = await compareReference(
        app,
        Buffer.from(archive["thumbnail.png"]),
        rendered,
        true,
      );
      row.thumbnailVisual.sourceBounds = meta.render_coordinates;
      row.projectGlyphLayers = await el.locator("[data-source-glyphs]").count();
    }
    if (kind === "paint") {
      const actual = await app.evaluate(async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const c = canvas.getContext("2d");
        c.drawImage(img, 0, 0);
        return [
          [10, 10],
          [94, 48],
          [135, 135],
        ].map(([x, y]) => Array.from(c.getImageData(x, y, 1, 1).data));
      }, rendered.toString("base64"));
      assert.deepEqual(actual, [
        [255, 255, 255, 255],
        [0, 204, 68, 255],
        [0, 204, 68, 255],
      ]);
      row.projectPixelProbes = actual;
    }
    assert.deepEqual(problems, []);
    row.project = {
      bytes: bytes.length,
      files: Object.keys(files).length,
      ...pixels,
    };
    await app.close();
  } finally {
    await host.close();
  }
}

async function test(kind) {
  const source = sources[kind];
  const bytes = await fixture(source);
  const row = {
    format: kind,
    sourceSha256: source.sha,
    engine,
    browser: browser.version(),
    phases: [],
  };
  results.push(row);
  const context = await browser.newContext({
    viewport: { width: 1460, height: 960 },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(25000);
    const problems = [];
    page.on("pageerror", (e) => problems.push(e.message));
    await page.goto(base);
    const prior = await documentFile(page);
    const priorUrl = page.url();
    let chooser;
    if (kind === "fig") {
      await page.getByLabel("文件菜单", { exact: true }).click();
      await page
        .getByRole("button", { name: "浏览本机文件…", exact: true })
        .click();
      chooser = page.getByTestId("browser-design-file-input");
    } else chooser = page.getByTestId("design-file-input");
    if (kind === "sketch") {
      await chooser.setInputFiles({
        name: "broken.sketch",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("incomplete"),
      });
      const rejection = page.getByRole("dialog", { name: "设计文件导入报告" });
      await rejection.getByRole("alert").waitFor();
      assert.equal(
        await rejection
          .getByRole("button", { name: "导入为新文件" })
          .isDisabled(),
        true,
      );
      await rejection
        .getByRole("button", { name: "取消", exact: true })
        .click();
      assert.equal(page.url(), priorUrl);
      assert.deepEqual(await documentFile(page), prior);
      row.phases.push("invalid-input-preserves-original");
    }
    await chooser.setInputFiles({
      name: source.name,
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
    const accept = page.getByRole("button", {
      name: "导入为新文件",
      exact: true,
    });
    const dialog = page.getByRole("dialog", { name: "设计文件导入报告" });
    await dialog
      .locator("button.primary:enabled, [role=alert]")
      .first()
      .waitFor({ timeout: 90000 });
    const err = dialog.getByRole("alert");
    if (await err.count())
      throw Error("Import rejected: " + (await err.innerText()));
    row.phases.push("review");
    row.report = (
      await accept.locator("xpath=ancestor::*[@role='dialog'][1]").innerText()
    ).slice(0, 1400);
    await page.screenshot({ path: path.join(output, kind + "-review.png") });
    await accept.click();
    await page.waitForURL((url) => url.searchParams.has("file"), {
      timeout: 90000,
    });
    const url = page.url();
    const doc = await documentFile(page);
    assert.equal(doc.importReport.sha256, source.sha);
    row.issueCount = doc.importReport.issues.length;
    const { selected, counts } = checkStructure(kind, doc);
    row.counts = counts;
    console.log(kind, counts.nodes, "editable layers");
    row.phases.push("native-structure");
    await page.reload();
    assert.deepEqual(await documentFile(page), doc);
    row.phases.push("reload");
    const portable = await download(
      page,
      page.getByLabel("设计文件", { exact: true }),
    );
    const foreignContext = await browser.newContext();
    try {
      const foreign = await foreignContext.newPage();
      await foreign.goto(base);
      await foreign.getByLabel("文件菜单", { exact: true }).click();
      await foreign
        .getByRole("button", { name: "浏览本机文件…", exact: true })
        .click();
      const nativePath = path.join(work, kind + "-portable.forma.json");
      await writeFile(nativePath, portable);
      await foreign
        .getByTestId("browser-design-file-input")
        .setInputFiles(nativePath);
      await foreign.waitForURL((u) => u.searchParams.has("file"), {
        timeout: 90000,
      });
      assert.deepEqual(await documentFile(foreign), doc);
      row.portableBytes = portable.length;
      row.phases.push("portable-file-in-clean-storage");
    } finally {
      await foreignContext.close();
    }

    await page.goto(priorUrl);
    assert.deepEqual(await documentFile(page), prior);
    await page.goto(url);
    row.phases.push("original-preserved");
    const edited =
      kind === "sds"
        ? doc
        : await checkEditable(page, doc, selected, kind, row);
    if (kind === "sds") {
      await page
        .getByRole("button", { name: "选择图层 Cover", exact: true })
        .click();
      await page.locator(".editor-canvas").focus();
      await page.keyboard.press("Shift+2");
      await page.screenshot({ path: path.join(output, "sds-canvas.png") });
      await page.getByRole("button", { name: "预览", exact: true }).click();
      await page.locator(`[data-design-id="${selected.id}"]`).first().waitFor();
      await page.screenshot({ path: path.join(output, "sds-preview.png") });
      await page.getByRole("button", { name: "关闭预览", exact: true }).click();
      row.phases.push("preview");
    }
    await deliveredProject(page, edited, selected, kind, row, bytes);
    row.phases.push("independent-react");
    assert.deepEqual(problems, []);
    row.workflowPassed = true;
  } catch (e) {
    row.error = e.message.slice(0, 2400);
    throw e;
  } finally {
    await context.close();
  }
}
try {
  const kinds =
    process.argv.length > 2 ? process.argv.slice(2) : Object.keys(sources);
  for (const k of kinds) {
    assert.ok(Object.hasOwn(sources, k), k);
    try {
      await test(k);
      console.log(k + " import, reopen and delivered project passed");
      if (results.at(-1)?.sourceVisual?.withinProposedThreshold === false) {
        throw Error(
          "Source-render visual comparison exceeds the proposed 0.5% gate.",
        );
      }
    } catch (e) {
      failed.push(k);
      console.error(k, e.stack);
    } finally {
      if (results.at(-1)?.format === k)
        await writeFile(
          path.join(output, k + "-result.json"),
          JSON.stringify(results.at(-1), null, 2) + "\n",
        );
    }
  }
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  assert.deepEqual(failed, []);
} finally {
  await browser.close();
  await rm(work, { recursive: true, force: true });
}
