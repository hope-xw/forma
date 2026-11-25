async (page) => {
  const { strict: assert } = await import("node:assert");
  const { readFile } = await import("node:fs/promises");
  const { PNG } = (await import("playwright-core/lib/utilsBundle")).default;
  function layer(id, parentId, type, x, y, w, h, fill, style = {}) {
    return {
      id,
      name: id,
      parentId,
      type,
      text: "",
      hidden: false,
      locked: false,
      style: {
        x,
        y,
        width: w,
        height: h,
        fill,
        color: "#000000",
        radius: 0,
        fontSize: 16,
        padding: 0,
        gap: 0,
        layout: "free",
        ...style,
      },
    };
  }
  const board = layer("range", null, "frame", 0, 0, 120, 60, "#00ff00");
  const nodes = [
    board,
    layer("before", "range", "rectangle", 0, 0, 20, 20, "#ff0000"),
    {
      ...layer("alpha", "range", "rectangle", 20, 0, 30, 20, "#000000", {
        fillOpacity: 0.5,
      }),
      siblingMask: "alpha",
    },
    layer("in-alpha", "range", "rectangle", 0, 0, 120, 20, "#0000ff"),
    {
      ...layer("luma", "range", "rectangle", 70, 0, 30, 20, "#ffffff"),
      siblingMask: "luminance",
    },
    layer("in-luma", "range", "rectangle", 0, 0, 120, 20, "#ff00ff"),
  ];
  // Resets a mask's range by placing the flex list in its own parent.
  const flex = layer("overlap", null, "frame", 0, 85, 120, 25, "#ffffff", {
    layout: "row",
    gap: -10,
    firstChildOnTop: true,
  });
  nodes.push(
    flex,
    layer("first", "overlap", "rectangle", 0, 0, 30, 20, "#ff0000"),
    layer("second", "overlap", "rectangle", 20, 0, 30, 20, "#0000ff"),
  );
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "source-layout.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        id: "mask-ranges",
        name: "Imported mask ranges",
        revision: 0,
        tokens: {},
        nodes,
      }),
    ),
  });
  const choose = (id) =>
    page.getByRole("button", { name: "选择图层 " + id, exact: true }).click();
  const capture = async (attr, id) =>
    PNG.sync.read(
      await page.locator("[" + attr + '="' + id + '"]').screenshot(),
    );
  function check(image, size, positions) {
    for (const [x, y, expected] of positions) {
      const i =
        4 *
        (Math.floor((y * image.height) / size[1]) * image.width +
          Math.floor((x * image.width) / size[0]));
      const c = [...image.data.slice(i, i + 3)];
      assert.ok(
        c.every((v, j) => Math.abs(v - expected[j]) <= 2),
        JSON.stringify({ x, y, expected, actual: c, size }),
      );
    }
  }
  const cases = [
    [
      "range",
      [120, 60],
      [
        [10, 10, [255, 0, 0]],
        [30, 10, [0, 127, 128]],
        [60, 10, [0, 255, 0]],
        [80, 10, [255, 0, 255]],
        [110, 10, [0, 255, 0]],
      ],
    ],
    [
      "overlap",
      [120, 25],
      [
        [10, 10, [255, 0, 0]],
        [25, 10, [255, 0, 0]],
        [40, 10, [0, 0, 255]],
        [55, 10, [255, 255, 255]],
      ],
    ],
  ];
  await choose("before");
  await page.keyboard.press("Escape");
  for (const [id, size, points] of cases) {
    check(await capture("data-node-id", id), size, points);
    await choose(id);
    await page.getByRole("button", { name: "预览", exact: true }).click();
    check(await capture("data-design-id", id), size, points);
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    await page.getByLabel("导出格式", { exact: true }).selectOption("png");
    const pending = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "导出所选图层", exact: true })
      .click();
    check(
      PNG.sync.read(await readFile(await (await pending).path())),
      size,
      points,
    );
  }
  return {
    renderers: ["canvas", "preview", "selected PNG"],
    cases: cases.map((c) => c[0]),
  };
};
