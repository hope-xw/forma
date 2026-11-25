async (page) => {
  const style = {
    x: 0,
    y: 0,
    width: 80,
    height: 70,
    fill: "#4757de",
    color: "#191919",
    radius: 0,
    fontSize: 16,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const layer = (id, parentId, type, patch) => ({
    id,
    name: id,
    parentId,
    type,
    text: "",
    hidden: false,
    locked: false,
    style: { ...style, ...patch },
  });
  const doc = {
    schemaVersion: 1,
    id: "shape-qa",
    revision: 0,
    name: "Shape QA",
    tokens: {},
    nodes: [
      layer("board", null, "frame", { width: 400, height: 300 }),
      layer("Base", "board", "rectangle", { x: 30, y: 40 }),
      layer("Top", "board", "ellipse", { x: 72, y: 50 }),
    ],
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "shapes.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const row = (name) =>
    page.getByRole("button", { name: "选择图层 " + name, exact: true });
  await row("Base").click();
  await row("Top").click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Top", exact: true }).count();
  await page.getByRole("button", { name: "联集", exact: true }).click();
  const mode = page.getByLabel("布尔运算类型", { exact: true });
  const id = await page
    .locator(".design-node.selected")
    .getAttribute("data-node-id");
  const path = page.locator('[data-node-id="' + id + '"] > svg > path');
  const results = {};
  for (const kind of ["union", "subtract", "intersect", "exclude"]) {
    await mode.selectOption(kind);
    const d = await path.getAttribute("d");
    if (!d) throw Error("No contour " + kind);
    results[kind] = d;
  }
  if (new Set(Object.values(results)).size !== 4)
    throw Error("Identical Boolean results");
  await row("Top").click();
  const field = page.getByRole("textbox", { name: "宽度", exact: true });
  await field.fill("96");
  await field.press("Enter");
  await row("联集").click();
  const edited = await path.getAttribute("d");
  if (edited === results.exclude)
    throw Error("Boolean result did not track source edit");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  if (
    (await page
      .locator('[data-design-id="' + id + '"] svg path')
      .getAttribute("d")) !== edited
  )
    throw Error("Preview differs");
  await page.getByRole("button", { name: "关闭预览" }).click();
  await page.getByRole("button", { name: "拼合为矢量" }).click();
  if (
    (await page
      .locator('[data-node-id="' + id + '"]')
      .getAttribute("data-node-type")) !== "vector"
  )
    throw Error("Flatten failed");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await row("Top").waitFor();
  const ticket = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 React 项目" }).click();
  await (await ticket).saveAs("output/playwright/boolean-check.zip");
  return {
    modes: Object.keys(results),
    editableOperand: true,
    flattenUndo: true,
    path: edited,
  };
};
