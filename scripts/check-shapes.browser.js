async (page) => {
  const style = {
    x: 0,
    y: 0,
    width: 480,
    height: 360,
    fill: "#ffffff",
    color: "#121212",
    radius: 0,
    fontSize: 16,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const doc = {
    schemaVersion: 1,
    id: "shape-file",
    name: "Native shapes",
    revision: 0,
    tokens: {},
    nodes: [
      {
        id: "board",
        name: "Shape board",
        type: "frame",
        style,
        hidden: false,
        locked: false,
        text: "",
        parentId: null,
      },
    ],
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "shapes.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const board = page.locator("[data-node-id=board]");
  await board.waitFor();
  const rect = await board.boundingBox();
  const pt = (x, y) => [
    rect.x + (x * rect.width) / 480,
    rect.y + (y * rect.height) / 360,
  ];
  const b = (name) => page.getByRole("button", { name, exact: true });
  const pick = async (name) => {
    await b("形状工具").click();
    await page.getByRole("menuitemradio", { name: new RegExp(name) }).click();
  };
  const drag = async (x, y, x2, y2, shift = false) => {
    await page.mouse.move(...pt(x, y));
    await page.mouse.down();
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.move(...pt(x2, y2), { steps: 4 });
    await page.locator(".shape-preview").waitFor();
    await page.mouse.up();
    if (shift) await page.keyboard.up("Shift");
  };
  const spin = async (name, val) => {
    const f = page.getByRole("spinbutton", { name, exact: true });
    await f.fill(String(val));
    await f.press("Enter");
  };
  await pick("星形");
  await drag(20, 20, 150, 95);
  await spin("尖角数", 7);
  await spin("内半径 %", 30);
  const glyph = page.locator('[data-node-type="vector"].selected');
  const star = await glyph.getAttribute("data-node-id"),
    d = await glyph.locator("svg path").getAttribute("d");
  if ((d.match(/L/g) || []).length !== 13) throw Error("7-point star lost");
  await pick("多边形");
  await drag(180, 20, 300, 110);
  await spin("边数", 6);
  if (
    ((await glyph.locator("svg path").getAttribute("d")).match(/L/g) || [])
      .length !== 5
  )
    throw Error("Hexagon lost");
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("l");
  await drag(225, 195, 85, 192, true);
  const line = await glyph.boundingBox();
  if (line.height > (rect.width / 480) * 4)
    throw Error("Shift did not snap horizontal line");
  const starLayer = page.locator('[data-node-id="' + star + '"]');
  await b("选择图层 星形").click();
  await b("编辑锚点").click();
  const a = page.locator(
    '[aria-label="矢量编辑"] [data-anchor="0"]:not([data-handle])',
  );
  const h = await a.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 14, h.y + 8, { steps: 4 });
  await page.mouse.up();
  await b("完成路径").click();
  if (await page.getByRole("spinbutton", { name: "尖角数" }).count())
    throw Error("Changed free path retained radial controls");
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await page.getByRole("spinbutton", { name: "尖角数" }).waitFor();
  if ((await starLayer.locator("svg path").getAttribute("d")) !== d)
    throw Error("Undo did not restore radial geometry");
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  await b("选择图层 星形").click();
  if (
    (await page.getByRole("spinbutton", { name: "尖角数" }).inputValue()) !==
    "7"
  )
    throw Error("Radial parameters lost on reopen");
  const download = page.waitForEvent("download");
  await b("导出 React 项目").click();
  await (await download).saveAs("output/playwright/shapes-check.zip");
  return {
    starPoints: 7,
    innerRadius: 0.3,
    polygonSides: 6,
    snappedLine: true,
    undoRestoredParameters: true,
  };
};
