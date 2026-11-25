async (page) => {
  const s = {
    x: 0,
    y: 0,
    width: 300,
    height: 220,
    fill: "#eeeeee",
    color: "#112233",
    radius: 14,
    fontSize: 16,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const n = (id, parentId, style) => ({
    id,
    parentId,
    name: id,
    type: parentId ? "rectangle" : "frame",
    text: "",
    hidden: false,
    locked: false,
    style: { ...s, ...style },
  });
  const doc = {
    schemaVersion: 1,
    id: "strokes",
    name: "Stroke placement",
    revision: 0,
    tokens: {},
    nodes: [
      n("Board", null, { strokeWidth: 12, stroke: "#cc2211" }),
      n("Child", "Board", {
        width: 50,
        height: 30,
        x: 230,
        y: 18,
        constraintX: "end",
      }),
    ],
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "strokes.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const b = (name) => page.getByRole("button", { name, exact: true });
  await b("选择图层 Board").click();
  const read = (attr) =>
    page.evaluate((attr) => {
      const get = (id) => document.querySelector("[" + attr + '="' + id + '"]');
      const board = get("Board"),
        child = get("Child"),
        r = board.getBoundingClientRect(),
        c = child.getBoundingClientRect(),
        scale = r.width / board.offsetWidth,
        css = getComputedStyle(board);
      return {
        x: Math.round((c.x - r.x) / scale),
        y: Math.round((c.y - r.y) / scale),
        border: parseFloat(css.borderLeftWidth),
        outline: css.outlineStyle === "none" ? 0 : parseFloat(css.outlineWidth),
        offset: parseFloat(css.outlineOffset),
      };
    }, attr);
  const measurements = [];
  for (const [i, mode] of ["内描边", "居中描边", "外描边"].entries()) {
    await b(mode).click();
    const m = await read("data-node-id");
    measurements.push(m);
    if (
      m.x !== 230 ||
      m.y !== 18 ||
      m.border !== [12, 6, 0][i] ||
      m.outline !== [0, 12, 12][i]
    )
      throw Error(JSON.stringify(m));
  }
  const width = page.getByLabel("宽度", { exact: true });
  await width.fill("340");
  await width.press("Enter");
  if ((await read("data-node-id")).x !== 270)
    throw Error("Outer-frame constraint failed");
  await b("预览").click();
  if ((await read("data-design-id")).x !== 270) throw Error("Preview mismatch");
  await b("关闭预览").click();
  const ticket = page.waitForEvent("download");
  await b("导出 React 项目").click();
  await (await ticket).saveAs("output/playwright/stroke-check.zip");
  return measurements;
};
