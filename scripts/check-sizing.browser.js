async (page) => {
  const base = {
    x: 0,
    y: 0,
    width: 100,
    height: 30,
    fill: "#daddff",
    color: "#000000",
    radius: 4,
    fontSize: 16,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const layer = (id, parentId, type, style = {}) => ({
    id,
    name: id,
    parentId,
    type,
    text: "",
    locked: false,
    hidden: false,
    style: { ...base, ...style },
  });
  const fixture = {
    id: "sizing-check",
    name: "Sizing check",
    revision: 0,
    schemaVersion: 1,
    tokens: {},
    nodes: [
      layer("board", null, "frame", {
        layout: "row",
        padding: 10,
        gap: 12,
        width: 436,
        height: 180,
        strokeWidth: 2,
        stroke: "#333333",
      }),
      layer("card", "board", "frame", { layout: "column", padding: 8 }),
      layer("leaf", "card", "rectangle"),
      layer("tile", "board", "rectangle", { height: 12 }),
    ],
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "sizing.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  const choose = (id) =>
    page.getByRole("button", { name: "选择图层 " + id, exact: true }).click();
  await choose("board");
  await page.getByLabel("高度模式", { exact: true }).selectOption("hug");
  await choose("card");
  await page.getByLabel("高度模式", { exact: true }).selectOption("hug");
  await page.getByLabel("宽度模式", { exact: true }).selectOption("fill");
  await choose("leaf");
  await page.getByLabel("宽度模式", { exact: true }).selectOption("fill");
  await choose("tile");
  await page.getByLabel("宽度模式", { exact: true }).selectOption("fill");
  const measure = (attr) =>
    page.evaluate(
      (attribute) =>
        Object.fromEntries(
          ["board", "card", "leaf", "tile"].map((id) => {
            const css = getComputedStyle(
              document.querySelector("[" + attribute + "=" + id + "]"),
            );
            return [id, [parseFloat(css.width), parseFloat(css.height)]];
          }),
        ),
      attr,
    );
  const expect = (a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw Error(JSON.stringify({ actual: a, expected: b }));
  };
  const first = await measure("data-node-id");
  expect(first, {
    board: [436, 70],
    card: [200, 46],
    leaf: [184, 30],
    tile: [200, 12],
  });
  await choose("board");
  const width = page.getByRole("textbox", { name: "宽度", exact: true });
  await width.fill("536");
  await width.press("Enter");
  const next = await measure("data-node-id");
  expect(next, {
    board: [536, 70],
    card: [250, 46],
    leaf: [234, 30],
    tile: [250, 12],
  });
  await page.getByRole("button", { name: "预览", exact: true }).click();
  expect(await measure("data-design-id"), next);
  await page.getByRole("button", { name: "关闭预览" }).click();
  const ticket = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 React 项目" }).click();
  await (await ticket).saveAs("output/playwright/sizing-check.zip");
  await choose("card");
  await page.getByLabel("宽度模式").selectOption("fixed");
  expect(await page.getByLabel("宽度", { exact: true }).inputValue(), "250");
  return { before: first, after: next, preview: "matched", fixed: 250 };
};
