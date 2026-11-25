async (page) => {
  const { strict: assert } = await import("node:assert");
  const { readFile } = await import("node:fs/promises");
  const { PNG } = (await import("playwright-core/lib/utilsBundle")).default;
  const layer = (id, parentId, type, x, y, width, height, style = {}) => ({
    id,
    parentId,
    type,
    name: id,
    text: "",
    locked: false,
    hidden: false,
    style: {
      x,
      y,
      width,
      height,
      layout: "free",
      fill: "#ffffff",
      color: "#111111",
      radius: 0,
      fontSize: 16,
      gap: 0,
      padding: 0,
      ...style,
    },
  });
  const doc = {
    schemaVersion: 1,
    id: "tint-test",
    name: "组着色与混合",
    revision: 0,
    tokens: {},
    nodes: [
      layer("board", null, "frame", 0, 0, 120, 90),
      layer("char-backdrop", "board", "rectangle", 0, 60, 120, 30, {
        fill: "#808080",
      }),
      {
        ...layer("char-ink", "board", "text", 0, 60, 120, 30, {
          fontFamily: "monospace",
          color: "#999999",
          fontWeight: 900,
          fontSize: 22,
          lineHeight: 30,
          blendMode: "plus-darker",
        }),
        text: "HHH",
      },
      layer("tinted", "board", "frame", 0, 0, 100, 28, {
        fillOpacity: 0,
        tint: { color: "#00ffff", opacity: 0.6 },
      }),
      layer("left", "tinted", "rectangle", 0, 0, 46, 28, {
        fill: "#ff0000",
        opacity: 0.5,
      }),
      layer("right", "tinted", "rectangle", 30, 0, 46, 28, {
        fill: "#0000ff",
        opacity: 0.5,
      }),
      layer("material", "board", "rectangle", 100, 0, 20, 25, {
        fill: "#000000",
        fillOpacity: 0.25,
        paints: [
          {
            id: "p3",
            color: "#262626",
            opacity: 0.9,
            visible: true,
            blendMode: "luminosity",
          },
          {
            id: "p2",
            color: "#0d0d0d",
            opacity: 1,
            visible: true,
            blendMode: "plus-lighter",
          },
          {
            id: "p1",
            color: "#cccccc",
            opacity: 1,
            visible: true,
            blendMode: "plus-darker",
          },
        ],
      }),
      layer("backdrop", "board", "rectangle", 96, 32, 24, 28, {
        fill: "#808080",
      }),
      layer("shadow", "board", "rectangle", 100, 35, 10, 20, {
        fill: "#a0a0a0",
        shadows: [
          {
            x: 4,
            y: 0,
            blur: 0,
            spread: 0,
            color: "#999999",
            opacity: 0.5,
            inset: false,
            blendMode: "plus-darker",
          },
        ],
      }),
      layer("magenta", "board", "rectangle", 0, 35, 80, 25, {
        fill: "#ff00ff",
      }),
      layer("multiply", "board", "rectangle", 30, 35, 66, 25, {
        fill: "#00ffff",
        blendMode: "multiply",
      }),
    ],
  };
  const choose = (id) =>
    page.getByRole("button", { name: "选择图层 " + id, exact: true }).click();
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "tint.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await choose("tinted");
  const alpha = page.getByLabel("整体着色不透明度", { exact: true });
  assert.equal(await alpha.inputValue(), "60");
  await alpha.fill("40");
  await alpha.press("Enter");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+z");
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="整体着色不透明度"]')?.value === "60",
  );
  await choose("board");
  await page
    .getByTitle("已保存到此浏览器", { exact: true })
    .waitFor({ state: "attached" });
  await page.reload();
  const expected = [
    [179, 255, 255],
    [140, 255, 255],
    [179, 255, 255],
    [255, 255, 255],
    [255, 0, 255],
    [0, 0, 255],
    [0, 255, 255],
    [51, 51, 51],
    [77, 77, 77],
  ];
  const points = [
    [10, 15],
    [36, 15],
    [60, 15],
    [95, 15],
    [10, 45],
    [50, 45],
    [90, 45],
    [110, 12],
    [112, 45],
  ];
  const verify = (png) => {
    const colors = points.map(([x, y]) => {
      const i =
        4 *
        (Math.floor((y * png.height) / 90) * png.width +
          Math.floor((x * png.width) / 120));
      return [...png.data.slice(i, i + 3)];
    });
    for (const [i, c] of colors.entries())
      assert.ok(
        c.every((v, j) => Math.abs(v - expected[i][j]) <= 2),
        JSON.stringify({ i, actual: c, expected: expected[i] }),
      );
    let darkest = 255;
    for (
      let y = Math.ceil((62 * png.height) / 90);
      y < Math.floor((87 * png.height) / 90);
      y++
    )
      for (let x = 0; x < Math.floor((46 * png.width) / 120); x++)
        darkest = Math.min(darkest, png.data[4 * (y * png.width + x)]);
    assert.ok(
      Math.abs(darkest - 26) <= 2,
      "Plus Darker glyph interior " + darkest,
    );
    return [...colors, [darkest, darkest, darkest]];
  };
  const inspect = async (attr) =>
    verify(
      PNG.sync.read(await page.locator("[" + attr + '="board"]').screenshot()),
    );
  const canvas = await inspect("data-node-id");
  await choose("board");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  const preview = await inspect("data-design-id");
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await page.getByLabel("导出格式", { exact: true }).selectOption("png");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出所选图层", exact: true }).click();
  const exported = verify(
    PNG.sync.read(await readFile(await (await download).path())),
  );
  return { canvas, preview, exported };
};
