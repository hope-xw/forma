async (page) => {
  const s = {
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    fill: "#575bd2",
    color: "#222222",
    radius: 0,
    fontSize: 16,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const n = (id, parentId, style) => ({
    id,
    name: id,
    parentId,
    type: parentId ? "rectangle" : "frame",
    text: "",
    hidden: false,
    locked: false,
    style: { ...s, ...style },
  });
  const doc = {
    schemaVersion: 1,
    revision: 0,
    id: "size-limits",
    name: "Limits",
    tokens: {},
    nodes: [
      n("board", null, { layout: "row", width: 600, height: 160, gap: 0 }),
      n("A", "board", { widthMode: "fill" }),
      n("B", "board", { widthMode: "fill" }),
      n("C", "board", { widthMode: "fill" }),
    ],
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "limits.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const b = (name) => page.getByRole("button", { name, exact: true });
  const select = (id) => b("选择图层 " + id).click();
  const bound = async (id, name, value) => {
    await select(id);
    const details = page.locator("details.size-limits");
    if (!(await details.evaluate((el) => el.open)))
      await details.locator("summary").click();
    const input = page.getByRole("spinbutton", { name, exact: true });
    await input.fill(value);
    await input.press("Enter");
  };
  const measure = (attr) =>
    page.evaluate(
      (attr) =>
        ["A", "B", "C"].map(
          (id) =>
            document.querySelector("[" + attr + '="' + id + '"]').offsetWidth,
        ),
      attr,
    );
  await bound("A", "最大宽度", "100");
  await bound("B", "最小宽度", "320");
  const sizes = await measure("data-node-id");
  if (sizes.join(",") !== "100,320,180") throw Error(JSON.stringify(sizes));
  for (const [i, id] of ["A", "B", "C"].entries()) {
    await select(id);
    if (
      Number(await page.getByLabel("宽度", { exact: true }).inputValue()) !==
      sizes[i]
    )
      throw Error("Geometry differs for " + id);
  }
  await select("board");
  const width = page.getByLabel("宽度", { exact: true });
  await width.fill("720");
  await width.press("Enter");
  const wide = await measure("data-node-id");
  if (wide.join(",") !== "100,320,300") throw Error(JSON.stringify(wide));
  await b("预览").click();
  if ((await measure("data-design-id")).join(",") !== wide.join(","))
    throw Error("Preview differs");
  await b("关闭预览").click();
  const ticket = page.waitForEvent("download");
  await b("导出 React 项目").click();
  await (await ticket).saveAs("output/playwright/limits-check.zip");
  await bound("B", "最小宽度", "");
  const cleared = await measure("data-node-id");
  if (cleared.join(",") !== "100,310,310")
    throw Error("Clear failed " + JSON.stringify(cleared));
  return { at600: sizes, at720: wide, afterClear: cleared };
};
