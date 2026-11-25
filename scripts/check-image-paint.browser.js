async (page) => {
  const { strict: assert } = await import("node:assert");
  const { readFile } = await import("node:fs/promises");
  const { PNG } = (await import("playwright-core/lib/utilsBundle")).default;
  const editing = await page.locator(".editor-canvas").count();
  const button = (name) => page.getByRole("button", { name, exact: true });
  const field = (name) => page.getByLabel(name, { exact: true });
  const set = async (name, value) => {
    await field(name).fill(String(value));
    await field(name).press("Enter");
  };
  const sample = (png) => {
    const coords = [
      [10, 20],
      [20, 20],
      [26, 20],
      [36, 20],
      [150, 12],
      [162, 12],
      [150, 68],
      [162, 68],
      [18, 113],
      [24, 113],
    ];
    return coords.map(([x, y]) =>
      Array.from(
        png.data.slice(
          (Math.floor((y * png.height) / 120) * png.width +
            Math.floor((x * png.width) / 220)) *
            4,
          (Math.floor((y * png.height) / 120) * png.width +
            Math.floor((x * png.width) / 220)) *
            4 +
            3,
        ),
      ),
    );
  };
  const verify = (colors) => {
    const neutral = (c, n, t = 3) => c.every((v) => Math.abs(v - n) <= t);
    assert.ok(
      neutral(colors[0], 44) &&
        neutral(colors[1], 255) &&
        neutral(colors[2], 44) &&
        neutral(colors[3], 255),
      JSON.stringify(colors),
    );
    assert.ok(
      neutral(colors[4], 0) &&
        neutral(colors[5], 255) &&
        neutral(colors[6], 210, 5) &&
        neutral(colors[7], 255) &&
        neutral(colors[8], 44) &&
        neutral(colors[9], 255),
      JSON.stringify(colors),
    );
  };
  const frame = (attr) => page.locator("[" + attr + '="board"]');
  const pixels = async (attr) =>
    sample(PNG.sync.read(await frame(attr).screenshot()));
  if (!editing) {
    const colors = await pixels("data-design-id");
    verify(colors);
    return colors;
  }
  const doc = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 16;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#c04020";
    ctx.fillRect(0, 0, 16, 16);
    const data = c.toDataURL(),
      bytes = await (await fetch(data)).arrayBuffer();
    const id =
      "img-" +
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
    const make = (id, parentId, type, x, y, width, height, extra = {}) => ({
      id,
      parentId,
      type,
      name: id,
      hidden: false,
      locked: false,
      text: "",
      style: {
        x,
        y,
        width,
        height,
        layout: "free",
        fill: "#ffffff",
        color: "#000000",
        radius: 0,
        fontSize: 16,
        padding: 0,
        gap: 0,
      },
      ...extra,
    });
    const fill = { assetId: id, fit: "cover", zoom: 1, x: 50, y: 50 };
    const nodes = [
      make("board", null, "frame", 0, 0, 220, 120),
      make("bitmap", "board", "rectangle", 8, 8, 128, 96, { image: fill }),
    ];
    const bordered = make("bordered", "board", "rectangle", 8, 106, 128, 14, {
      image: {
        ...fill,
        fit: "tile",
        tileScale: 0.5,
        brightness: 0.5,
        saturation: 0,
        x: 0,
        y: 0,
      },
    });
    bordered.style.strokeWidth = 4;
    bordered.style.stroke = "#444444";
    nodes.push(bordered);
    for (const [i, type] of ["alpha", "luminance"].entries()) {
      const key = "mask-" + type;
      nodes.push(
        make(key, "board", "group", 148, 8 + i * 56, 64, 40, {
          maskSourceId: key + "-source",
          maskType: type,
        }),
        make(key + "-source", key, "rectangle", 0, 0, 64, 40, {
          image: {
            ...fill,
            fit: "tile",
            tileScale: 0.5,
            brightness: 0.5,
            saturation: 0,
            x: 0,
            y: 0,
          },
        }),
      );
      const ink = make(key + "-ink", key, "rectangle", 0, 0, 64, 40);
      ink.style.fill = "#000000";
      nodes.push(ink);
    }
    return {
      id: "image-paint-sample",
      name: "Image paint",
      revision: 0,
      schemaVersion: 1,
      tokens: {},
      nodes,
      images: {
        [id]: { name: "warm-stripe.png", width: 32, height: 16, data },
      },
    };
  });
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "image-paint.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const choose = async (id) => button("选择图层 " + id).click();
  await choose("bitmap");
  await button("在画布裁切").click();
  const overlay = page.getByRole("group", { name: "画布裁切" }),
    rect = await overlay.boundingBox();
  const cx = rect.x + rect.width / 2,
    cy = rect.y + rect.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + rect.width / 8, cy, { steps: 4 });
  assert.ok(Number(await field("水平焦点").inputValue()) < 50);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(await field("水平焦点").inputValue(), "50");
  await page.locator('[data-node-id="bitmap"]').dblclick();
  await overlay.waitFor();
  const knob = await button("缩放裁切图像").boundingBox();
  const kx = knob.x + knob.width / 2,
    ky = knob.y + knob.height / 2;
  await page.mouse.move(kx, ky);
  await page.mouse.down();
  await page.mouse.move(kx + rect.width / 2, ky + rect.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  assert.equal(await field("裁切倍率").inputValue(), "1.5");
  await overlay.press("Enter");
  await button("撤销").click();
  assert.equal(await field("裁切倍率").inputValue(), "1");
  await button("重做").click();
  await field("图像适配").selectOption("tile");
  await set("图块倍率", 0.5);
  await set("水平焦点", 0);
  await set("垂直焦点", 0);
  await page.locator(".image-adjustments summary").click();
  await set("亮度", 50);
  await set("饱和度", 0);
  await set("对比度", 125);
  await button("重置图像调色").click();
  assert.equal(await field("饱和度").inputValue(), "100");
  await button("撤销").click();
  assert.equal(await field("对比度").inputValue(), "125");
  await set("对比度", 100);
  await page
    .locator(".image-inspector")
    .screenshot({ path: "output/playwright/image-paint-panel.png" });
  await choose("board");
  await page
    .getByTitle("已保存到此浏览器", { exact: true })
    .waitFor({ state: "attached" });
  await page.reload();
  const canvas = await pixels("data-node-id");
  verify(canvas);
  await choose("board");
  await button("预览").click();
  const preview = await pixels("data-design-id");
  verify(preview);
  await button("关闭预览").click();
  for (const format of ["svg", "png"]) {
    await field("导出格式").selectOption(format);
    const download = page.waitForEvent("download");
    await button("导出所选图层").click();
    const file = await download,
      bytes = await readFile(await file.path());
    await file.saveAs("output/playwright/image-paint." + format);
    const output =
      format === "png"
        ? PNG.sync.read(bytes)
        : PNG.sync.read(
            Buffer.from(
              await page.evaluate(async (src) => {
                const img = new Image();
                img.src = "data:image/svg+xml;base64," + src;
                await img.decode();
                const c = document.createElement("canvas");
                c.width = img.naturalWidth;
                c.height = img.naturalHeight;
                c.getContext("2d").drawImage(img, 0, 0);
                return c.toDataURL().split(",")[1];
              }, bytes.toString("base64")),
              "base64",
            ),
          );
    verify(sample(output));
  }
  const ticket = page.waitForEvent("download");
  await button("导出 React 项目").click();
  await (await ticket).saveAs("output/playwright/image-paint-check.zip");
  return {
    canvas,
    preview,
    formats: ["svg", "png"],
    tile: [16, 8],
    restoredZoom: 1.5,
  };
};
