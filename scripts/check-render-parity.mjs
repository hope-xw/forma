// Compare the same saved artboards in the editor, preview and independently built React project.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFile,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchQaBrowser } from "./qa-browser.mjs";
import { preview } from "vite";
import { unzipSync } from "fflate";
const engine = process.env.BROWSER_ENGINE ?? "chromium";
const browser = await launchQaBrowser(engine);
async function measure(page, attr, id) {
  const layer = page.locator("[" + attr + '="' + id + '"]');
  await layer.waitFor({ state: "attached" });
  return layer.evaluate(async (root, attr) => {
    await document.fonts.ready;
    const out = {};
    const box = root.getBoundingClientRect(),
      scale = box.width / root.offsetWidth;
    for (const el of [root, ...root.querySelectorAll("[" + attr + "]")]) {
      const bounds = el.getBoundingClientRect();
      const text = el.querySelector(":scope > span");
      let lines;
      if (text?.innerText) {
        const range = document.createRange();
        range.selectNodeContents(text);
        lines = new Set(
          [...range.getClientRects()]
            .filter((r) => r.height && r.width)
            .map((r) => Math.round((r.top - bounds.top) / scale)),
        ).size;
      }
      out[el.getAttribute(attr)] = {
        rect: [
          (bounds.x - box.x) / scale,
          (bounds.y - box.y) / scale,
          bounds.width / scale,
          bounds.height / scale,
        ],
        lines,
      };
    }
    return out;
  }, attr);
}
async function comparePaint(page, left, right) {
  return page.evaluate(
    async ([a, b]) => {
      async function pixels(data) {
        const img = new Image();
        img.src = "data:image/png;base64," + data;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return {
          width: c.width,
          height: c.height,
          data: ctx.getImageData(0, 0, c.width, c.height).data,
        };
      }
      const p = await pixels(a),
        q = await pixels(b);
      if (p.width !== q.width || p.height !== q.height)
        throw Error("截图尺寸不一致 " + [p.width, p.height, q.width, q.height]);
      let exact = 0,
        over16 = 0,
        max = 0;
      for (let i = 0; i < p.data.length; i += 4) {
        const delta = Math.max(
          ...[0, 1, 2].map((k) => Math.abs(p.data[i + k] - q.data[i + k])),
        );
        if (delta) exact++;
        if (delta > 16) over16++;
        max = Math.max(max, delta);
      }
      return {
        width: p.width,
        height: p.height,
        differentPixels: exact,
        over16,
        over16Pct: Math.round((over16 / (p.width * p.height)) * 100000) / 1000,
        maxChannelDelta: max,
      };
    },
    [left.toString("base64"), right.toString("base64")],
  );
}
function compare(lhs, rhs) {
  const ids = Object.keys(lhs),
    missing = [],
    boxes = [],
    lines = [];
  let maximum = 0;
  for (const id of ids) {
    if (!rhs[id]) {
      missing.push(id);
      continue;
    }
    const error = Math.max(
      ...lhs[id].rect.map((value, i) => Math.abs(value - rhs[id].rect[i])),
    );
    maximum = Math.max(maximum, error);
    if (error > 1) boxes.push(id);
    if (lhs[id].lines !== rhs[id].lines) lines.push(id);
  }
  const extra = Object.keys(rhs).filter((id) => !Object.hasOwn(lhs, id));
  return {
    layers: ids.length,
    extra,
    maximumCssPx: Number(maximum.toFixed(3)),
    missing,
    boxes,
    lines,
  };
}
try {
  const failures = [];
  for (const example of ["aura-showcase", "mobile-studio"]) {
    const dir = await mkdtemp(path.join(tmpdir(), "forma-parity-"));
    const context = await browser.newContext({
      viewport: { width: 2000, height: 2500 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage(),
      app = await context.newPage();
    let host;
    try {
      const doc = JSON.parse(
        await readFile("public/examples/" + example + ".forma.json", "utf8"),
      );
      const base = process.env.FORMA_URL ?? "http://127.0.0.1:5173/";
      await page.goto(new URL("?example=" + example, base).href);
      await page.getByLabel("文件菜单", { exact: true }).click();
      const ticket = page.waitForEvent("download");
      await page
        .getByRole("button", {
          name: "导出整个文件为 React 项目…",
          exact: true,
        })
        .click();
      const zip = unzipSync(await readFile(await (await ticket).path()));
      for (const [name, bytes] of Object.entries(zip)) {
        const dest = path.resolve(dir, name);
        assert.ok(dest.startsWith(dir + path.sep));
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, bytes);
      }
      // Dependency installation in a clean directory is covered separately by test:exports.
      await symlink(
        path.resolve("node_modules"),
        path.join(dir, "node_modules"),
      );
      execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe" });
      host = await preview({
        root: dir,
        configFile: false,
        logLevel: "silent",
        preview: { host: "127.0.0.1", port: 0 },
      });
      const url = "http://127.0.0.1:" + host.httpServer.address().port;
      for (const owner of doc.pages)
        for (const node of (owner.nodes ?? doc.nodes).filter(
          (n) => !n.parentId,
        )) {
          const id = node.id;
          if (
            owner.id !== doc.activePage ||
            (await page
              .getByRole("button", {
                name: "选择图层 " + node.name,
                exact: true,
              })
              .count()) === 0
          )
            await page
              .getByRole("button", { name: owner.name, exact: true })
              .click();
          await page.getByLabel("搜索图层", { exact: true }).fill(node.name);
          await page
            .locator('[data-layer-id="' + id + '"]')
            .getByRole("button", { name: "选择图层 " + node.name, exact: true })
            .click();
          await page.locator(".editor-canvas").focus();
          await page.keyboard.press("Shift+2");
          await page.getByTitle("缩放至 100%", { exact: true }).click();
          const canvas = await measure(page, "data-node-id", id);
          await page.getByRole("button", { name: "预览", exact: true }).click();
          const player = await measure(page, "data-design-id", id);
          await app.setViewportSize({
            width: node.style.width,
            height: node.style.height,
          });
          await app.goto(url + "/#screen=" + encodeURIComponent(id));
          const delivered = await measure(app, "data-design-id", id);
          const picture = async (tab) =>
            tab
              .locator('[data-design-id="' + id + '"]')
              .screenshot({ scale: "css", animations: "disabled" });
          const left = await picture(page),
            right = await picture(app);
          const paint = await comparePaint(app, left, right);
          if (process.env.FORMA_VISUAL_DIR && paint.over16) {
            await mkdir(process.env.FORMA_VISUAL_DIR, { recursive: true });
            await writeFile(
              path.join(process.env.FORMA_VISUAL_DIR, id + "-preview.png"),
              left,
            );
            await writeFile(
              path.join(process.env.FORMA_VISUAL_DIR, id + "-export.png"),
              right,
            );
          }
          const result = {
            engine,
            id,
            previewProjectPixels: paint,
            canvasToPreview: compare(canvas, player),
            previewToProject: compare(player, delivered),
          };
          console.log(JSON.stringify(result));
          if (paint.over16 / (paint.width * paint.height) > 0.0001)
            failures.push(id + " 预览与工程像素差");
          for (const stats of [
            result.canvasToPreview,
            result.previewToProject,
          ]) {
            if (
              stats.extra.length ||
              stats.missing.length ||
              stats.boxes.length ||
              stats.lines.length
            )
              failures.push(id);
          }
          await page
            .getByRole("button", { name: "关闭预览", exact: true })
            .click();
        }
    } finally {
      await host?.close();
      await context.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(failures, []);
} finally {
  await browser.close();
}
