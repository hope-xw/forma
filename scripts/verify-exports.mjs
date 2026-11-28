import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runInThisContext, constants } from "node:vm";
import { devices } from "playwright";
import { launchQaBrowser } from "./qa-browser.mjs";
import { unzipSync } from "fflate";

const geometries = async (page, ids) =>
  page.evaluate(
    (ids) =>
      ids.map((id) => {
        const el = document.querySelector('[data-design-id="' + id + '"]');
        return [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight];
      }),
    ids,
  );
async function replay(name, page) {
  const file = new URL("./check-" + name + ".browser.js", import.meta.url);
  const source = await readFile(file, "utf8");
  await runInThisContext(source, {
    filename: fileURLToPath(file),
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  })(page, name === "prototype-input" ? { touch: true } : undefined);
}
const checks = {
  async "canvas-phase2"(page, doc) {
    const nodes =
      doc.format === "forma/design-parts"
        ? doc.records
            .filter((record) => record.kind === "page")
            .flatMap((record) => record.nodes)
        : doc.nodes;
    const board = page.locator('[data-design-id="art"]');
    await board.waitFor();
    const children = nodes.filter((node) => node.parentId === "art");
    assert.deepEqual(
      children.map((node) => node.name),
      ["stroke", "letters（轮廓）"],
    );
    assert.equal(children[0].id, "stroke");
    assert.equal(children[1].id, "letters");
    const glyphs = board.locator(
      '[data-design-id="letters"] > svg path[stroke-width="0"]',
    );
    await glyphs.first().waitFor();
    const closedContours = await glyphs.evaluateAll((paths) =>
      paths.reduce(
        (count, path) =>
          count + (path.getAttribute("d").match(/z/gi) ?? []).length,
        0,
      ),
    );
    assert.ok(
      closedContours >= 2,
      "Rendered letters SVG retains both closed glyph contours",
    );
    for (const node of children) {
      assert.equal(node.type, "vector");
      assert.ok(node.vector.paths.length > 0);
      for (const path of node.vector.paths) {
        assert.ok(path.fill && path.strokeWidth === 0);
        assert.match(path.d, /Z\s*$/i);
      }
      const paths = board.locator(`[data-design-id="${node.id}"] > svg path`);
      await paths.first().waitFor();
      assert.deepEqual(
        await paths.evaluateAll((els) =>
          els.map((el) => [
            el.getAttribute("d"),
            el.getAttribute("fill"),
            el.getAttribute("stroke-width"),
          ]),
        ),
        node.vector.paths.map((path) => [path.d, path.fillColor, "0"]),
      );
    }
  },
  async "canvas-pro-feel"(page, doc) {
    const nodes =
      doc.format === "forma/design-parts"
        ? doc.records.filter((r) => r.kind === "page").flatMap((r) => r.nodes)
        : doc.nodes;
    const spacing = nodes.find((n) => n.id === "Spacing");
    assert.ok(spacing, "Spacing node present in exported document");
    const expectedRadii = spacing.style.corners
      ? [
          spacing.style.corners.tl,
          spacing.style.corners.tr,
          spacing.style.corners.br,
          spacing.style.corners.bl,
        ]
      : Array(4).fill(spacing.style.radius);
    const el = page.locator('[data-design-id="Spacing"]');
    await el.waitFor();
    const rendered = await el.evaluate((node) => {
      const s = getComputedStyle(node);
      return {
        radii: [
          s.borderTopLeftRadius,
          s.borderTopRightRadius,
          s.borderBottomRightRadius,
          s.borderBottomLeftRadius,
        ].map(parseFloat),
        gap: parseFloat(s.columnGap),
      };
    });
    assert.deepEqual(rendered, {
      radii: expectedRadii,
      gap: spacing.style.gap,
    });
  },
  async "agent-canvas-chat"(page, doc, files) {
    const nodes =
      doc.format === "forma/design-parts"
        ? doc.records.filter((r) => r.kind === "page").flatMap((r) => r.nodes)
        : doc.nodes;
    for (const id of ["tb-nav-search", "tb-empty-state"]) {
      assert.ok(
        Object.keys(files).some(
          (file) =>
            file.startsWith("src/components/" + id + "-") &&
            file.endsWith(".tsx"),
        ),
        id,
      );
    }
    assert.match(new TextDecoder().decode(files["src/tokens.css"]), /#ff5000/i);
    const artboard = (name) => {
      const matches = nodes.filter(
        (node) => node.parentId === null && node.name === name,
      );
      assert.equal(matches.length, 1, name);
      return matches[0].id;
    };
    const home = page.locator(`[data-design-id="${artboard("淘宝主会场")}"]`);
    for (const copy of ["搜索开门红好物", "满减专场"])
      await home.getByText(copy, { exact: true }).waitFor();
    const emptyId = artboard("淘宝搜索空态");
    await page.goto(
      new URL("#screen=" + encodeURIComponent(emptyId), page.url()).href,
    );
    await page
      .locator(`[data-design-id="${emptyId}"]`)
      .getByText("暂无相关商品", { exact: true })
      .waitFor();
    assert.equal(await home.count(), 0);
  },
  async "color-profile"(page, doc) {
    assert.equal(doc.colorProfile, "display-p3");
    const el = page.locator(
      '[data-design-id="' + doc.nodes.find((n) => !n.parentId).id + '"]',
    );
    const color = await el.evaluate((n) => getComputedStyle(n).backgroundColor);
    assert.match(color, /^color\(display-p3 0\.9176\d* 0\.2 0\.1372\d*\)$/);
  },
  async "color-profile-srgb"(page, doc) {
    assert.equal(doc.colorProfile, "display-p3");
    assert.equal(doc.exportColorProfile, "srgb");
    const el = page.locator(
      '[data-design-id="' + doc.nodes.find((n) => !n.parentId).id + '"]',
    );
    const color = await el.evaluate((n) => getComputedStyle(n).backgroundColor);
    assert.match(color, /^rgb\(255, 0, 0\)$/);
  },
  async "vector-network"(page) {
    const paths = page.locator('[data-design-id="glyph"] > svg path');
    assert.deepEqual(
      await paths.evaluateAll((els) =>
        els.map((e) => e.getAttribute("fill").toLowerCase()),
      ),
      ["#1177cc", "#ffaa22", "none"],
    );
    assert.deepEqual(
      await paths.evaluateAll((els) =>
        els.map((e) => e.getAttribute("d").endsWith("Z")),
      ),
      [true, true, false],
    );
  },
  async "variant-authoring"(page, doc) {
    const root = doc.nodes.find((n) => n.instance);
    const lib = doc.libraries[root.instance.libraryId],
      component = lib.components.find(
        (c) => c.id === root.instance.componentId,
      );
    assert.equal(component.variants.length, 3);
    assert.deepEqual(
      component.variants.find((v) => v.id === root.instance.variantId)
        .properties,
      { State: "Busy", 尺寸: "宽版" },
    );
    const el = page.locator('[data-design-id="' + root.id + '"]');
    assert.equal(await el.innerText(), "待发送");
    assert.equal(await el.evaluate((n) => n.offsetWidth), 232);
    const warning = doc.nodes.find((n) => n.instance && n.id !== root.id);
    assert.ok(warning);
    const other = page.locator('[data-design-id="' + warning.id + '"]');
    assert.equal(await other.innerText(), "注意");
    assert.equal(await other.evaluate((n) => n.offsetWidth), 190);
  },
  async "forwarded-instances"(page) {
    await page.getByText("团队概览", { exact: true }).waitFor();
    await page.getByText("新版标识", { exact: true }).waitFor();
    assert.equal(await page.getByText("普通标识", { exact: true }).count(), 0);
  },
  async "nested-instances"(page) {
    await page.getByText("发布工具", { exact: true }).waitFor();
    await page.getByText("新版标识", { exact: true }).waitFor();
    assert.equal(await page.getByText("普通标识", { exact: true }).count(), 0);
  },
  async "component-properties"(page, doc) {
    const root = doc.nodes.find((n) => n.instance);
    assert.ok(root);
    const el = page.locator('[data-design-id="' + root.id + '"]');
    assert.equal(await el.innerText(), "设计师覆盖");
    assert.equal(
      await el.locator("[data-design-id]").last().isVisible(),
      false,
    );
  },
  "container-rules": (page) => replay("container-rules", page),
  "image-paint": (page) => replay("image-paint", page),
  "text-position": (page) => replay("text-position", page),
  "professional-editor": (page) => replay("professional-editor", page),
  "designer-delivery": (page) => replay("designer-delivery", page),
  async span(page) {
    assert.deepEqual(await geometries(page, ["card", "label", "tail"]), [
      [0, 0, 210, 40],
      [220, 0, 100, 40],
      [0, 50, 100, 40],
    ]);
  },
  async atlas(page) {
    const n = (id) => page.locator('[data-design-id="' + id + '"]');
    await n("atlas-tablet-open").click();
    await n("atlas-note-root").waitFor();
    await n("atlas-note-share").click();
    await page.getByRole("dialog", { name: "路线分享 · 浮层" }).waitFor();
    await n("atlas-sheet-close").click();
    await n("atlas-note-back").click();
    await n("atlas-tablet-root").waitFor();
  },
  async "studio-file"(page, doc) {
    const total = doc.pages.reduce(
      (sum, p) =>
        sum + (p.nodes ?? doc.nodes).filter((n) => !n.parentId).length,
      0,
    );
    assert.equal(total, 16);
    await page.goto(page.url().split("#")[0] + "#screens");
    assert.equal(await page.getByRole("link").count(), total);
    const links = await page
      .getByRole("link")
      .evaluateAll((els) => els.map((el) => el.href));
    for (const href of links) {
      await page.goto(href);
      const target = new URLSearchParams(new URL(href).hash.slice(1)).get(
        "screen",
      );
      await page.locator('[data-design-id="' + target + '"]').waitFor();
    }
  },
  async "renamed-library"(page) {
    assert.equal(
      await page.locator('[data-design-id="legacy-tag"]').innerText(),
      "业务旧名",
    );
  },
  async "route-upgrade"(page) {
    const start = page.locator('[data-design-id="Go"]');
    assert.equal(await start.evaluate((el) => el.offsetWidth), 148);
    await page.getByRole("link", { name: "查看订单 42" }).click();
    await page.getByRole("button", { name: "Share", exact: true }).waitFor();
    await page.reload();
    const share = page.locator('[data-design-id="Share"]');
    await share.press("Enter");
    const inspect = page.locator('[data-design-id="Inspect"]');
    await inspect.press("Enter");
    await page.getByRole("dialog", { name: "Confirm", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    assert.ok(await inspect.evaluate((el) => el === document.activeElement));
    await page.keyboard.press("Escape");
    assert.ok(await share.evaluate((el) => el === document.activeElement));
    assert.equal(new URL(page.url()).hash, "#/orders/42");
    await page.goBack();
    await start.waitFor();
  },
  async file(page) {
    await checks.cross(page);
    await page.goto(page.url().split("#")[0] + "#screens");
    await page.getByRole("heading", { name: "Empty page" }).waitFor();
    await page.getByRole("link", { name: "Detail", exact: true }).click();
    await page.locator("[data-design-id=Detail]").waitFor();
    await page.reload();
    await page.locator("[data-design-id=Detail]").waitFor();
    await page.goBack();
    await page.getByRole("heading", { name: "画板目录" }).waitFor();
  },
  async shapes(page, doc) {
    for (const node of doc.nodes.filter((n) => n.vector)) {
      const svg = page.locator('[data-design-id="' + node.id + '"] > svg');
      assert.equal(await svg.getAttribute("preserveAspectRatio"), "none");
      assert.equal(
        await svg.locator("path").getAttribute("d"),
        node.vector.paths[0].d,
      );
    }
    assert.equal(
      doc.nodes.find((n) => n.vector?.radial?.kind === "star").vector.radial
        .points,
      7,
    );
  },
  async limits(page) {
    assert.deepEqual(
      (await geometries(page, ["A", "B", "C"])).map((v) => v[2]),
      [100, 320, 300],
    );
  },
  async sizing(page) {
    assert.deepEqual(
      (await geometries(page, ["board", "card", "leaf", "tile"])).map((v) =>
        v.slice(2),
      ),
      [
        [536, 70],
        [250, 46],
        [234, 30],
        [250, 12],
      ],
    );
  },
  async wrap(page) {
    const board = page.locator("[data-design-id=board]");
    assert.equal((await geometries(page, ["board"]))[0][3], 108);
    await board.evaluate((el) => (el.style.width = "228px"));
    assert.equal((await geometries(page, ["board"]))[0][3], 158);
  },
  async rich(page) {
    assert.deepEqual(
      await page
        .locator("[data-design-id=label] > span > span")
        .evaluateAll((els) =>
          els.map((el) => [
            el.textContent,
            getComputedStyle(el).fontSize,
            getComputedStyle(el).fontWeight,
            getComputedStyle(el).textDecorationLine,
          ]),
        ),
      [
        ["设计", "30px", "700", "underline"],
        ["工具 Studio", "18px", "400", "none"],
      ],
    );
  },
  async image(page) {
    const img = page.locator("[data-design-id] img").first();
    await img.evaluate((el) => el.decode());
    assert.deepEqual(
      await img.evaluate((el) => [
        el.naturalWidth,
        el.naturalHeight,
        getComputedStyle(el).objectPosition,
        getComputedStyle(el).transform,
      ]),
      [240, 120, "75% 50%", "matrix(1.6, 0, 0, 1.6, 0, 0)"],
    );
  },
  async "stroke-paints"(page) {
    const { PNG } = (await import("playwright-core/lib/utilsBundle")).default;
    const image = PNG.sync.read(
      await page.locator('[data-design-id="board"]').screenshot(),
    );
    const k =
      4 *
      (Math.floor((31 * image.height) / 60) * image.width +
        Math.floor((13 * image.width) / 100));
    const rgb = Array.from(image.data.subarray(k, k + 3));
    assert.ok(
      rgb.every((v, i) => Math.abs(v - [51, 51, 166][i]) <= 2),
      JSON.stringify(rgb),
    );
  },
  async stroke(page) {
    const board = page.locator("[data-design-id=Board]"),
      child = page.locator("[data-design-id=Child]");
    const box = await board.boundingBox(),
      cb = await child.boundingBox();
    assert.equal(Math.round(cb.x - box.x), 270);
    assert.equal(
      await board.evaluate((el) => getComputedStyle(el).outlineWidth),
      "12px",
    );
  },
  async mask(page) {
    const painted = page.locator("[data-design-id=Paint]");
    assert.deepEqual(
      await painted.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return [
          [0.5, 0.5],
          [0.12, 0.12],
        ].map(([x, y]) =>
          document
            .elementsFromPoint(r.x + x * r.width, r.y + y * r.height)
            .includes(el),
        );
      }),
      [true, false],
    );
    assert.equal(await page.locator("[data-design-id=Circle]").count(), 0);
  },
  async vector(page, doc) {
    const n = doc.nodes.find((n) => n.type === "vector"),
      glyph = page.locator('[data-design-id="' + n.id + '"]');
    assert.equal(
      await glyph.locator("path").getAttribute("d"),
      n.vector.paths[0].d,
    );
    const cornerError = await glyph.evaluate((el) => {
      const actual = new DOMMatrix(getComputedStyle(el).transform);
      const expected = new DOMMatrix().rotate(37).scale(-1, 1);
      return Math.max(
        ...[0, el.offsetWidth].flatMap((x) =>
          [0, el.offsetHeight].map((y) => {
            const a = actual.transformPoint({ x, y }),
              b = expected.transformPoint({ x, y });
            return Math.hypot(a.x - b.x, a.y - b.y);
          }),
        ),
      );
    });
    assert.ok(
      cornerError < 0.01,
      "Rotated vector corner displacement: " + cornerError + " CSS px",
    );
  },
  async boolean(page) {
    const layer = page.locator('[data-component="联集"] path');
    assert.ok((await layer.getAttribute("d")).includes("c"));
    assert.equal(await page.locator("[data-design-id=Top]").count(), 0);
  },
};
for (const name of [
  "responsive",
  "responsive-player",
  "prototype",
  "prototype-input",
  "cross",
  "aura",
])
  checks[name] = (page) => replay(name === "cross" ? "cross-page" : name, page);
async function serve(dir) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/feedback") {
      const parts = [];
      for await (const chunk of req) parts.push(chunk);
      const { email } = JSON.parse(Buffer.concat(parts).toString());
      res.writeHead(email === "designer@example.test" ? 201 : 422, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ email }));
      return;
    }
    const file = path.resolve(
      dir,
      "." +
        decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname),
    );
    if (!file.startsWith(dir + path.sep)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const bytes = await readFile(file);
      res.setHeader(
        "Content-Type",
        { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[
          path.extname(file)
        ] ?? "application/octet-stream",
      );
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
const engine = process.env.BROWSER_ENGINE || "chromium";
const browser = await launchQaBrowser(engine);

try {
  for (const name of process.argv.length > 2
    ? process.argv.slice(2)
    : Object.keys(checks)) {
    if (!Object.hasOwn(checks, name))
      throw Error("Unknown export fixture " + name);
    const dir = await mkdtemp(path.join(tmpdir(), "forma-verify-"));
    try {
      const files = unzipSync(
        await readFile(
          path.join(
            "output/playwright",
            ...(engine === "chromium" ? [] : [engine, "output/playwright"]),
            name + "-check.zip",
          ),
        ),
      );
      for (const [file, bytes] of Object.entries(files)) {
        const target = path.resolve(dir, file);
        if (!target.startsWith(dir + path.sep))
          throw Error("Invalid project path");
        if (file.endsWith("/")) continue;
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      const args = [
        "install",
        "--no-fund",
        "--no-audit",
        "--ignore-scripts",
        ...(process.env.npm_config_offline === "true" ? ["--offline"] : []),
      ];
      execFileSync("npm", args, { cwd: dir, stdio: "pipe" });
      try {
        execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe" });
      } catch (err) {
        throw Error(
          name +
            " project failed to build\n" +
            String(err.stdout ?? "") +
            String(err.stderr ?? ""),
        );
      }
      const host = await serve(path.join(dir, "dist"));
      try {
        const page = await browser.newPage({
            viewport:
              name === "prototype-input"
                ? { width: 390, height: 844 }
                : { width: 1280, height: 900 },
            hasTouch: name === "prototype-input",
          }),
          errors = [];
        page.on("pageerror", (err) => errors.push(err.message));
        await page.goto(host.url);
        await page.locator("[data-design-id]").first().waitFor();
        await checks[name](
          page,
          JSON.parse(
            await readFile(path.join(dir, "design.forma.json"), "utf8"),
          ),
          files,
        );
        if (name === "color-profile" || name === "color-profile-srgb") {
          const img = page.locator("[data-design-id] img").first();
          const bytes = await img.evaluate(async (el) =>
            Array.from(
              new Uint8Array(await (await fetch(el.currentSrc)).arrayBuffer()),
            ),
          );
          const asset = Object.values(
            JSON.parse(new TextDecoder().decode(files["design.forma.json"]))
              .images,
          )[0];
          assert.equal(
            Buffer.from(bytes).toString("base64"),
            asset.data.split(",")[1],
          );
          assert.equal(await img.evaluate((el) => el.naturalWidth), 8);
        }
        if (name === "renamed-library") {
          const module = Object.keys(files).find((p) =>
            p.startsWith("src/components/"),
          );
          assert.ok(module);
          await writeFile(
            path.join(dir, "src/main.tsx"),
            'import {createRoot} from "react-dom/client";import Tag from ' +
              JSON.stringify("./" + module.slice(4, -4)) +
              ';createRoot(document.getElementById("root")!).render(<Tag instanceId="tag" values={{标签:"旧文案",业务标签:"现用文案"}}/>);',
          );
          execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe" });
          await page.reload();
          assert.equal(
            await page.locator('[data-design-id="tag"]').innerText(),
            "现用文案",
          );
        }
        if (name === "variant-authoring") {
          const entry = Object.entries(files).find(
            ([p, bytes]) =>
              p.startsWith("src/components/") &&
              new TextDecoder()
                .decode(bytes)
                .includes('export const componentName = "通知徽标";'),
          );
          assert.ok(entry);
          await writeFile(
            path.join(dir, "src/main.tsx"),
            'import {createRoot} from "react-dom/client";import Badge from ' +
              JSON.stringify("./" + entry[0].slice(4, -4)) +
              ';createRoot(document.getElementById("root")!).render(<Badge instanceId="named-variant" variantProperties={{State:"Busy",尺寸:"宽版"}} values={{文案:"开发接入"}}/>);',
          );
          execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe" });
          await page.reload();
          const element = page.locator('[data-design-id="named-variant"]');
          assert.equal(await element.innerText(), "开发接入");
          assert.equal(await element.evaluate((el) => el.offsetWidth), 232);
        }
        if (name === "component-properties") {
          const module = Object.keys(files).find((p) =>
            p.startsWith("src/components/"),
          );
          assert.ok(module);
          await writeFile(
            path.join(dir, "src/main.tsx"),
            'import {createRoot} from "react-dom/client";import Card from ' +
              JSON.stringify("./" + module.slice(4, -4)) +
              ';createRoot(document.getElementById("root")!).render(<Card instanceId="app-card" values={{标题:"开发者设置",图标:true}}/>);',
          );
          execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe" });
          await page.reload();
          assert.equal(
            await page.locator('[data-design-id="app-card"]').innerText(),
            "开发者设置",
          );
          assert.equal(
            await page
              .locator('[data-design-id="app-card"] [data-design-id]')
              .last()
              .isVisible(),
            true,
          );
        }
        if (name === "nested-instances" || name === "forwarded-instances") {
          const forwarded = name === "forwarded-instances";
          const component = (name) => {
            const entry = Object.entries(files).find(
              ([p, bytes]) =>
                p.startsWith("src/components/") &&
                new TextDecoder()
                  .decode(bytes)
                  .includes(
                    "export const componentName = " +
                      JSON.stringify(name) +
                      ";",
                  ),
            );
            assert.ok(entry, "compiled component " + name);
            return JSON.stringify("./" + entry[0].slice(4, -4));
          };
          await writeFile(
            path.join(dir, "src/main.tsx"),
            'import {createRoot} from "react-dom/client";import Toolbar from ' +
              component(forwarded ? "Header" : "Toolbar") +
              ";import Badge from " +
              component("Secondary") +
              ';createRoot(document.getElementById("root")!).render(<Toolbar instanceId="toolbar" values={{' +
              (forwarded ? "页头标题" : "标题") +
              ':"业务工具",' +
              (forwarded ? "页头标识" : "标识") +
              ':<Badge instanceId="nested-badge"/>}}/>);',
          );
          execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe" });
          await page.reload();
          const toolbar = page.locator('[data-design-id="toolbar"]');
          await toolbar.getByText("业务工具", { exact: true }).waitFor();
          assert.equal(
            await toolbar
              .locator('[data-design-id="nested-badge"]')
              .innerText(),
            "新版标识",
          );
          assert.equal(
            await toolbar.getByText("普通标识", { exact: true }).count(),
            0,
          );
        }
        if (name === "studio-file") {
          const phone = await browser.newContext({
            ...devices["iPhone 13"],
            isMobile: engine !== "firefox",
          });
          try {
            const tab = await phone.newPage();
            await tab.goto(host.url + "/#screen=atlas-phone-root");
            const layer = (id) => tab.locator('[data-design-id="' + id + '"]');
            await layer("atlas-phone-open").tap();
            await layer("atlas-note-root").waitFor();
            await layer("atlas-note-share").tap();
            await tab
              .getByRole("dialog", { name: "路线分享 · 浮层" })
              .waitFor();
            await layer("atlas-sheet-close").tap();
            await layer("atlas-note-back").tap();
            await layer("atlas-phone-root").waitFor();
          } finally {
            await phone.close();
          }
          const modulePath = Object.keys(files).find((p) =>
            /^src\/components\/toggle-.*\.tsx$/.test(p),
          );
          assert.ok(modulePath, "exported switch component");
          await writeFile(
            path.join(dir, "src/main.tsx"),
            [
              'import { createRoot } from "react-dom/client";',
              "import Toggle from " +
                JSON.stringify("./" + modulePath.slice(4, -4)) +
                ";",
              'createRoot(document.getElementById("root")!).render(<><Toggle instanceId="one" variant="Light-On-Default" onAction={(id,v) => document.body.dataset.action = id + "=" + v}/><Toggle instanceId="two" variant="Light-On-Default"/></>);',
            ].join("\n"),
          );
          execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe" });
          await page.goto(host.url);
          const switches = page.getByRole("switch");
          assert.equal(await switches.count(), 2);
          await switches.first().click();
          assert.equal(
            await switches.first().getAttribute("aria-checked"),
            "false",
          );
          assert.equal(
            await switches.nth(1).getAttribute("aria-checked"),
            "true",
          );
          assert.equal(
            await page.locator("body").getAttribute("data-action"),
            "one=false",
          );
        }
        assert.deepEqual(errors, []);
        await page.close();
        console.log(name + " · install, build and browser passed");
      } finally {
        await host.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
}
