async (page) => {
  const style = {
    x: 0,
    y: 0,
    width: 360,
    height: 240,
    fill: "#ffffff",
    color: "#141414",
    radius: 0,
    fontSize: 18,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const board = {
    id: "board",
    name: "Type board",
    parentId: null,
    type: "frame",
    text: "",
    hidden: false,
    locked: false,
    style,
  };
  const label = {
    ...board,
    id: "label",
    parentId: "board",
    type: "text",
    name: "Headline",
    text: "设计工具 Studio",
    style: { ...style, x: 16, y: 24, widthMode: "hug", heightMode: "hug" },
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "rich.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        id: "rich-check",
        name: "Rich",
        revision: 0,
        tokens: {},
        nodes: [board, label],
      }),
    ),
  });
  await page
    .getByRole("button", { name: "选择图层 Headline", exact: true })
    .click();
  await page.locator('[data-node-id="label"]').dblclick();
  const edit = page.getByRole("textbox", { name: "画布文本编辑", exact: true });
  // Editing begins with all text selected. Left collapses it to the start on macOS and other platforms.
  await edit.press("ArrowLeft");
  await edit.press("Shift+ArrowRight");
  await edit.press("Shift+ArrowRight");
  await page.getByRole("button", { name: "局部加粗" }).click();
  await page.getByRole("button", { name: "局部下划线" }).click();
  const font = page.getByLabel("选区字号");
  await font.fill("30");
  await font.press("Enter");
  await page.getByRole("button", { name: "提交文字" }).click();
  const measure = (attr) =>
    page.locator("[" + attr + '="label"]').evaluate((el) => ({
      text: el.innerText,
      width: el.offsetWidth,
      height: el.offsetHeight,
      parts: [...el.querySelectorAll(":scope > span > span")].map((n) => [
        n.textContent,
        getComputedStyle(n).fontWeight,
        getComputedStyle(n).fontSize,
        getComputedStyle(n).textDecorationLine,
      ]),
    }));
  const result = await measure("data-node-id");
  if (
    result.parts[0]?.join(",") !== "设计,700,30px,underline" ||
    result.parts[1]?.[0] !== "工具 Studio"
  )
    throw Error(JSON.stringify(result));
  const inspected = Number(
    await page.getByRole("textbox", { name: "宽度", exact: true }).inputValue(),
  );
  if (Math.abs(inspected - result.width) > 1)
    throw Error(
      "Hug width differs from rendered text: " +
        inspected +
        " / " +
        result.width,
    );
  await page.getByRole("button", { name: "预览", exact: true }).click();
  const preview = await measure("data-design-id");
  if (JSON.stringify(preview) !== JSON.stringify(result))
    throw Error(JSON.stringify({ preview, result }));
  await page.getByRole("button", { name: "关闭预览" }).click();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  if ((await measure("data-node-id")).parts.length !== 0)
    throw Error("Formatting undo failed");
  await page.getByRole("button", { name: "重做", exact: true }).click();
  const ticket = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 React 项目" }).click();
  await (await ticket).saveAs("output/playwright/rich-check.zip");
  await page.locator('[data-node-id="label"]').dblclick();
  await edit.press("ArrowLeft");
  await edit.press("Shift+ArrowRight");
  await page.getByRole("button", { name: "选区字体设置" }).click();
  const family = page.getByLabel("选区字体族");
  await family.fill("serif");
  await family.press("Enter");
  await page.getByLabel("选区字重").selectOption("600");
  await page.getByRole("button", { name: "提交文字" }).click();
  const parts = await page
    .locator("[data-node-id=label] > span > span")
    .evaluateAll((els) =>
      els.map((el) => [
        el.textContent,
        getComputedStyle(el).fontFamily,
        getComputedStyle(el).fontWeight,
      ]),
    );
  if (
    parts[0][0] !== "设" ||
    parts[0][1] !== "serif" ||
    parts[0][2] !== "600" ||
    parts[1][2] !== "700"
  )
    throw Error("Selection font override failed: " + JSON.stringify(parts));
  return { ...result, localFont: parts[0] };
};
