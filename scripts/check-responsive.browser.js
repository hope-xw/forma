async (page) => {
  const base = {
    x: 0,
    y: 0,
    width: 100,
    height: 24,
    radius: 0,
    fill: "#7788dd",
    color: "#111111",
    fontSize: 16,
    padding: 0,
    gap: 10,
    layout: "free",
  };
  const node = (id, parentId, type, style) => ({
    id,
    name: id,
    parentId,
    type,
    text: "",
    hidden: false,
    locked: false,
    style: { ...base, ...style },
  });
  const doc = {
    schemaVersion: 1,
    id: "responsive",
    revision: 0,
    name: "Responsive",
    tokens: {},
    nodes: [
      node("board", null, "frame", {
        width: 768,
        height: 400,
        viewportWidth: true,
      }),
      node("grid", "board", "frame", {
        x: 20,
        y: 30,
        width: 728,
        heightMode: "hug",
        layout: "grid",
        padding: 10,
        minColumnWidth: 160,
        constraintX: "stretch",
      }),
      ...Array.from({ length: 6 }, (_, i) =>
        node("cell" + i, "grid", "rectangle", {
          widthMode: "fill",
          height: 40 + i * 2,
        }),
      ),
      node("badge", "board", "rectangle", {
        x: 688,
        y: 8,
        width: 60,
        height: 12,
        constraintX: "end",
      }),
    ],
  };
  const editing =
    (await page.locator('[data-testid="design-file-input"]').count()) > 0;
  if (editing)
    await page.locator('[data-testid="design-file-input"]').setInputFiles({
      name: "responsive.forma.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
  const select = (id) =>
    page.getByRole("button", { name: "选择图层 " + id, exact: true }).click();
  const results = [];
  for (const width of [375, 390, 768, 1024, 1440]) {
    if (editing) {
      await select("board");
      const input = page.getByRole("textbox", { name: "宽度", exact: true });
      await input.fill(String(width));
      await input.press("Enter");
    } else await page.setViewportSize({ width, height: 800 });
    const metrics = await page.evaluate((isEditor) => {
      const get = (id) =>
        document.querySelector(
          "[" + (isEditor ? "data-node-id" : "data-design-id") + "=" + id + "]",
        );
      const board = get("board").getBoundingClientRect(),
        scale = board.width / parseFloat(getComputedStyle(get("board")).width);
      return Object.fromEntries(
        ["board", "badge", "grid", "cell0", "cell1", "cell5"].map((id) => {
          const r = get(id).getBoundingClientRect();
          return [
            id,
            [r.x - board.x, r.y - board.y, r.width, r.height].map((x) =>
              Math.round(x / scale),
            ),
          ];
        }),
      );
    }, editing);
    if (
      metrics.board[2] !== width ||
      metrics.badge[0] !== width - 80 ||
      metrics.grid[2] !== width - 40
    )
      throw Error(JSON.stringify(metrics));
    if (editing) {
      for (const id of ["cell0", "grid"]) {
        await select(id);
        const field = page.getByRole("textbox", { name: "宽度", exact: true });
        if (Math.abs(Number(await field.inputValue()) - metrics[id][2]) > 1)
          throw Error("Inspector mismatch " + id);
      }
    }
    results.push(metrics);
  }
  if (results[0].cell5[1] <= results[4].cell5[1])
    throw Error("Grid did not reflow");
  if (editing) {
    await select("board");
    const ticket = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 React 项目" }).click();
    await (await ticket).saveAs("output/playwright/responsive-check.zip");
  }
  return results;
};
