async (page) => {
  const style = {
    x: 0,
    y: 0,
    width: 190,
    height: 150,
    fill: "#fff1e6",
    color: "#181818",
    radius: 0,
    fontSize: 16,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const layer = (id, parentId, type, x, interaction) => ({
    id,
    name: id,
    parentId,
    type,
    style: {
      ...style,
      x,
      ...(parentId ? { width: 85, height: 40, x: 20, y: 25 } : {}),
    },
    text: parentId ? id : "",
    interaction,
    hidden: false,
    locked: false,
  });
  const nodes = [
    layer("Home", null, "frame", 0, { flow: "Start" }),
    layer("Detail", null, "frame", 230),
    layer("Sheet", null, "frame", 460),
    layer("Continue", "Home", "button", 0),
    layer("Return", "Detail", "button", 0, { actions: [{ kind: "back" }] }),
    layer("Close", "Sheet", "button", 0, { actions: [{ kind: "close" }] }),
  ];
  const doc = {
    schemaVersion: 1,
    name: "Prototype wires",
    id: "wires",
    revision: 0,
    tokens: {},
    nodes,
  };
  const b = (name) => page.getByRole("button", { name, exact: true });
  const n = (id) => page.locator('[data-node-id="' + id + '"]');
  const screen = (id) => page.locator('[data-design-id="' + id + '"]');
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "wires.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await n("Home").waitFor();
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("Shift+1");
  await b("选择图层 Continue").click();
  await b("原型").click();
  async function wire(handle, target) {
    const h = await handle.boundingBox(),
      t = await n(target).boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(t.x + t.width * 0.7, t.y + t.height * 0.7, {
      steps: 6,
    });
    await page.mouse.up();
  }
  await wire(b("新建原型连接"), "Detail");
  const target = page.getByLabel("动作目标", { exact: true });
  if ((await target.inputValue()) !== "Detail")
    throw Error("Draw link did not update inspector");
  await b("预览").click();
  await screen("Continue").click();
  await screen("Return").click();
  await screen("Home").waitFor();
  await b("关闭预览").click();
  await page.getByLabel("动作类型", { exact: true }).selectOption("overlay");
  await page.getByLabel("浮层位置").selectOption("bottom");
  await wire(b("调整连接至 Detail"), "Sheet");
  if (
    (await target.inputValue()) !== "Sheet" ||
    (await page.getByLabel("浮层位置").inputValue()) !== "bottom"
  )
    throw Error("Retarget lost action configuration");
  await page.screenshot({ path: "output/playwright/prototype-wires.png" });
  await b("预览").click();
  await screen("Continue").click();
  await page.getByRole("dialog", { name: "Sheet", exact: true }).waitFor();
  await screen("Close").click();
  await b("关闭预览").click();
  await b("新建原型连接").focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("连接目标画板").selectOption("Detail");
  if ((await target.count()) !== 2) throw Error("Keyboard connection lost");
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("ControlOrMeta+z");
  if ((await target.count()) !== 1) throw Error("Connection undo failed");
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  await b("选择图层 Continue").click();
  await b("原型").click();
  await b("调整连接至 Sheet").click();
  const picker = page.getByLabel("连接目标画板");
  if ((await picker.inputValue()) !== "Sheet")
    throw Error("Clicking endpoint changed its target");
  await picker.press("Escape");
  const hit = page.locator(".wire-hit-selected").first();
  const point = await hit.evaluate((path) => {
    const p = path.getPointAtLength(path.getTotalLength() * 0.55);
    return new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()).toJSON();
  });
  await page.mouse.click(point.x, point.y);
  await picker.selectOption({ label: "断开连接" });
  if ((await target.count()) !== 0) throw Error("Wire is still connected");
  await b("撤销").click();
  await b("调整连接至 Sheet").waitFor();
  return {
    drawn: "Home → Detail",
    retargetedOverlay: "Sheet",
    anchor: "bottom",
    keyboard: true,
    undo: true,
    reopened: true,
    clickedLineAndDisconnected: true,
  };
};
