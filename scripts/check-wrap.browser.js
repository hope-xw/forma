async (page) => {
  const base = {
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    radius: 0,
    fontSize: 16,
    gap: 8,
    padding: 0,
    fill: "#ffffff",
    color: "#161616",
    layout: "free",
  };
  const node = (id, parentId, type, style, text = "") => ({
    id,
    parentId,
    type,
    name: id,
    style: { ...base, ...style },
    text,
    hidden: false,
    locked: false,
  });
  const doc = {
    id: "wrap-check",
    name: "Wrap check",
    revision: 0,
    schemaVersion: 1,
    tokens: {},
    nodes: [
      node("board", null, "frame", {
        width: 320,
        padding: 10,
        layout: "row",
        heightMode: "hug",
        rowGap: 14,
      }),
      node(
        "body",
        "board",
        "text",
        { width: 140, heightMode: "hug", lineHeight: 22 },
        "一段中文说明，接着是 emoji 🐈 和 English words。\n第二行",
      ),
      node(
        "chip",
        "board",
        "text",
        { widthMode: "hug", heightMode: "hug", lineHeight: 20 },
        "Library",
      ),
      node("tile", "board", "rectangle", { width: 96, height: 36 }),
    ],
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "wrap.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const choose = (id) =>
    page.getByRole("button", { name: "选择图层 " + id, exact: true }).click();
  await choose("board");
  await page.getByRole("button", { name: "自动换行", exact: true }).click();
  const measure = (attr) =>
    page.evaluate((a) => {
      const find = (id) => document.querySelector("[" + a + "=" + id + "]");
      const board = find("board"),
        origin = board.getBoundingClientRect(),
        scale = origin.width / parseFloat(getComputedStyle(board).width);
      return ["board", "body", "chip", "tile"].map((id) => {
        const r = find(id).getBoundingClientRect();
        return [
          (r.x - origin.x) / scale,
          (r.y - origin.y) / scale,
          r.width / scale,
          r.height / scale,
        ].map(Math.round);
      });
    }, attr);
  const sizes = [];
  for (const width of [320, 228, 380]) {
    await choose("board");
    const field = page.getByRole("textbox", { name: "宽度", exact: true });
    await field.fill(String(width));
    await field.press("Enter");
    const canvas = await measure("data-node-id");
    for (const [i, id] of ["board", "body", "chip", "tile"].entries()) {
      await choose(id);
      for (const [j, label] of ["宽度", "高度"].entries()) {
        const actual = Number(
          await page
            .getByRole("textbox", { name: label, exact: true })
            .inputValue(),
        );
        if (Math.abs(actual - canvas[i][j + 2]) > 1)
          throw Error(
            id + " " + label + " " + JSON.stringify({ actual, canvas }),
          );
      }
    }
    await page.getByRole("button", { name: "预览", exact: true }).click();
    const preview = await measure("data-design-id");
    if (JSON.stringify(preview) !== JSON.stringify(canvas))
      throw Error(JSON.stringify({ preview, canvas }));
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    sizes.push(canvas);
  }
  if (sizes[1][3][1] <= sizes[2][3][1] || sizes[0][1][3] < 44)
    throw Error("No reflow: " + JSON.stringify(sizes));
  await choose("board");
  const ticket = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 React 项目" }).click();
  await (await ticket).saveAs("output/playwright/wrap-check.zip");
  return sizes;
};
