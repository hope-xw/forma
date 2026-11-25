async (page) => {
  const base = {
    x: 0,
    y: 0,
    width: 480,
    height: 360,
    fill: "#ffffff",
    color: "#112233",
    radius: 0,
    fontSize: 16,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const doc = {
    schemaVersion: 1,
    id: "vector-check",
    name: "Vector workbench",
    tokens: {},
    revision: 0,
    nodes: [
      {
        id: "board",
        parentId: null,
        type: "frame",
        name: "Icon board",
        style: base,
        text: "",
        hidden: false,
        locked: false,
      },
    ],
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "vector.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const board = page.locator('[data-node-id="board"]');
  await board.waitFor();
  const b = await board.boundingBox();
  const point = (x, y) => ({
    x: b.x + (x * b.width) / 480,
    y: b.y + (y * b.height) / 360,
  });
  const click = async (x, y) => {
    const p = point(x, y);
    await page.mouse.click(p.x, p.y);
  };
  await page.getByRole("button", { name: "钢笔 P" }).click();
  await click(65, 110);
  const peak = point(125, 58),
    tangent = point(145, 58);
  await page.mouse.move(peak.x, peak.y);
  await page.mouse.down();
  await page.mouse.move(tangent.x, tangent.y, { steps: 4 });
  await page.mouse.up();
  await click(178, 112);
  await click(140, 155);
  await click(65, 110);
  const glyph = page.locator('[data-node-type="vector"]');
  await glyph.waitFor();
  const path = glyph.locator("svg path");
  const initial = await path.getAttribute("d");
  if (!initial.includes("C") || !initial.endsWith("Z"))
    throw Error("Missing curve or close " + initial);
  await page.getByRole("button", { name: "编辑锚点" }).click();
  const handle = page.locator(
    '[aria-label="矢量编辑"] [data-anchor="1"]:not([data-handle])',
  );
  const h = await handle.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 15, h.y + h.height / 2 + 9, {
    steps: 4,
  });
  await page.mouse.up();
  await page.getByRole("button", { name: "插入中点" }).click();
  const anchors = await page
    .locator('[aria-label="矢量编辑"] [data-anchor]:not([data-handle])')
    .count();
  if (anchors !== 5) throw Error("Unexpected anchor count " + anchors);
  await page.getByRole("button", { name: "完成路径" }).click();
  const edited = await path.getAttribute("d");
  if (initial === edited) throw Error("Anchor edit was lost");
  await page.getByRole("button", { name: "水平翻转" }).click();
  const angle = page.getByRole("textbox", { name: "旋转角度", exact: true });
  await angle.fill("37");
  await angle.press("Enter");
  const css = await glyph.evaluate((el) => getComputedStyle(el).transform);
  const delta = await page.evaluate(() => {
    const a = document
        .querySelector('[data-node-type="vector"]')
        .getBoundingClientRect(),
      b = document
        .querySelector('[data-testid="selection-box"]')
        .getBoundingClientRect();
    return Math.max(
      ...["x", "y", "width", "height"].map((k) => Math.abs(a[k] - b[k])),
    );
  });
  if (delta > 1.1 || css === "none")
    throw Error(JSON.stringify({ delta, css }));
  const rotate = page.getByRole("button", { name: "旋转选区" }),
    r = await rotate.boundingBox(),
    box = await glyph.boundingBox();
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2,
    rx = r.x + r.width / 2,
    ry = r.y + r.height / 2;
  await page.mouse.move(rx, ry);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(cx - (ry - cy), cy + (rx - cx), { steps: 9 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const rotated = Number(await angle.inputValue());
  if (rotated === 37 || rotated % 15 !== 0)
    throw Error("Rotation gesture failed: " + rotated);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  if (Number(await angle.inputValue()) !== 37) throw Error("Rotate undo");
  const id = await glyph.getAttribute("data-node-id");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  const preview = page.locator('[data-design-id="' + id + '"]');
  if (
    (await preview.locator("svg path").getAttribute("d")) !== edited ||
    (await preview.evaluate((el) => getComputedStyle(el).transform)) !== css
  )
    throw Error("Preview differs");
  await page.getByRole("button", { name: "关闭预览" }).click();
  const ticket = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 React 项目" }).click();
  await (await ticket).saveAs("output/playwright/vector-check.zip");
  return { anchors, rotated, selectionError: delta, matrix: css, path: edited };
};
