async (page) => {
  const { strict: assert } = await import("node:assert");
  const { PNG } = (await import("playwright-core/lib/utilsBundle")).default;
  const layer = (id, parentId, type, style) => ({
    id,
    parentId,
    type,
    name: id,
    text: "",
    hidden: false,
    locked: false,
    style: {
      x: 0,
      y: 0,
      width: 160,
      height: 100,
      layout: "free",
      fill: "#ffffff",
      color: "#111111",
      radius: 0,
      fontSize: 16,
      padding: 0,
      gap: 0,
      ...style,
    },
  });
  const doc = {
    schemaVersion: 1,
    id: "rounded-paints",
    name: "Vector coverage",
    revision: 0,
    tokens: {},
    nodes: [
      layer("board", null, "frame", {}),
      layer("clipped", "board", "frame", {
        x: 12,
        y: 12,
        width: 58,
        height: 40,
        clipContent: true,
        fillOpacity: 0,
      }),
      layer("ink", "clipped", "rectangle", {
        width: 74,
        height: 34,
        fill: "#4080ff",
        radius: 100,
        cornerSmoothingModel: "figma",
        cornerSmoothing: 0.6,
      }),
      layer("plain", "board", "rectangle", {
        x: 14,
        y: 60,
        width: 74,
        height: 34,
        fill: "#4080ff",
        radius: 100,
      }),
    ],
  };
  await page.getByTestId("design-file-input").setInputFiles({
    name: "coverage.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("选择图层 board").click();
  await button("预览").click();
  await page.getByLabel("缩放模式").selectOption("100");
  const root = page.locator('.preview-dialog [data-design-id="board"]'),
    ink = page
      .locator(
        '.preview-dialog [data-design-id="ink"] > span[aria-hidden=true]',
      )
      .first();
  const mask = () =>
    ink.evaluate((e) => e.style.maskImage.startsWith('url("data:image/png'));
  await page.waitForFunction(() =>
    document
      .querySelector(
        '.preview-dialog [data-design-id="ink"] > span[aria-hidden=true]',
      )
      ?.style.maskImage.startsWith('url("data:image/png'),
  );
  const initial = await mask();
  assert.ok(initial);
  assert.equal(
    await page
      .locator(
        '.preview-dialog [data-design-id="plain"] > span[aria-hidden=true]',
      )
      .count(),
    0,
  );
  const img = PNG.sync.read(await root.screenshot());
  function pixel(x, y) {
    const k = 4 * (y * img.width + x);
    return Array.from(img.data.subarray(k, k + 3));
  }
  assert.deepEqual(pixel(18, 28), [64, 128, 255]);
  assert.deepEqual(pixel(65, 25), [64, 128, 255]);
  assert.deepEqual(pixel(73, 25), [255, 255, 255]);
  await page.getByLabel("缩放模式").selectOption("fill");
  await page.waitForFunction(() => {
    const e = document.querySelector(
      '.preview-dialog [data-design-id="ink"] > span[aria-hidden=true]',
    );
    return (
      e &&
      e.getBoundingClientRect().width > 75 &&
      !e.style.maskImage.includes("data:image/png")
    );
  });
  const enlarged = await mask();
  assert.ok(!enlarged);
  await page.getByLabel("缩放模式").selectOption("100");
  await page.waitForFunction(() =>
    document
      .querySelector(
        '.preview-dialog [data-design-id="ink"] > span[aria-hidden=true]',
      )
      ?.style.maskImage.includes("data:image/png"),
  );
  const recovered = await mask();
  await button("关闭预览").click();
  for (let i = 0; i < 9; i++) await button("缩小").click();
  const tiny = page
    .locator('[data-node-id="ink"] > span[aria-hidden=true]')
    .first();
  const zoomedOut = await tiny.evaluate((e) => ({
    width: e.getBoundingClientRect().width,
    raster: e.style.maskImage.includes("data:image/png"),
  }));
  assert.ok(
    zoomedOut.width < 55 && !zoomedOut.raster,
    JSON.stringify(zoomedOut),
  );
  return {
    native: initial,
    zoomed: enlarged,
    recovered,
    zoomedOut,
    clipped: pixel(73, 25),
  };
};
