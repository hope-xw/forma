async (page) => {
  const button = (name) => page.getByRole("button", { name, exact: true });
  const label = (name) => page.getByLabel(name, { exact: true });
  const select = (name) => button("选择图层 " + name).click();
  const source = {
    type: "rectangle",
    text: "",
    locked: false,
    hidden: false,
    parentId: null,
  };
  const style = {
    x: 40,
    y: 60,
    width: 80,
    height: 40,
    layout: "free",
    fill: "#4477aa",
    color: "#333333",
    padding: 0,
    gap: 0,
    fontSize: 16,
    radius: 4,
  };
  const nodes = ["Idle", "Busy", "Error"].map((name, i) => ({
    ...source,
    id: name,
    name,
    style: { ...style, x: 40 + i * 150 },
  }));
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "states.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        id: "sets",
        name: "States",
        revision: 0,
        tokens: {},
        nodes,
      }),
    ),
  });
  await select("Error");
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("Meta+Alt+KeyK");
  const saved = () =>
    page
      .getByTitle("已保存到此浏览器", { exact: true })
      .waitFor({ state: "attached" });
  const importLibrary = (file) =>
    page
      .locator('.left-panel input[type=file][accept=".json"]')
      .setInputFiles(file);
  const downloadOriginal = async () => {
    await button("资源").click();
    await label("搜索组件").fill("Error");
    await button("查看 Error").click();
    const received = page.waitForEvent("download");
    await button("导出此组件库").click();
    const file = await (await received).path();
    await button("关闭组件详情").click();
    return file;
  };
  const sourceUrl = page.url(),
    published = await downloadOriginal();
  await saved();
  await page.getByTitle("新建空白文件").click();
  await page.waitForURL(/file=forma\.file\./);
  const consumerUrl = page.url();
  await button("资源").click();
  await importLibrary(published);
  await label("搜索组件").fill("Error");
  await button("查看 Error").click();
  await button("插入组件").click();
  const oldInstanceId = await page
    .locator(".design-node.selected")
    .getAttribute("data-node-id");
  const consumer = page.locator('[data-node-id="' + oldInstanceId + '"]');
  if ((await consumer.evaluate((el) => el.offsetWidth)) !== 80)
    throw Error("Original consumer width");
  await saved();
  await page.goto(sourceUrl);
  await select("Idle");
  await button("选择图层 Busy").click({ modifiers: ["Shift"] });
  await page.getByText("组合为变体集", { exact: true }).click();
  await label("组件集名称").fill("Status");
  await label("组件集属性").fill("State");
  await button("创建变体集").click();
  const group = page.locator('[data-component-set="Status · 组件集"]');
  const members = group.locator(":scope > .design-node");
  await group.waitFor();
  if (
    (await group.evaluate((el) => getComputedStyle(el, "::before").content)) !==
    "none"
  )
    throw Error("Root component set has overlapping labels");
  if ((await members.count()) !== 2) throw Error("Canvas set missing members");
  await button("撤销").click();
  if ((await group.count()) !== 0) throw Error("Undo did not dissolve the set");
  await button("重做").click();
  await group.waitFor();
  await page.locator('[data-layer-id="Idle"] .layer-main').click();
  const panel = page.locator(".master-variants");
  if (!((await panel.getAttribute("open")) !== null))
    await panel.locator("summary").click();
  await label("选择变体属性").selectOption("");
  await label("变体属性名").fill("Size");
  await label("变体当前值").fill("Small");
  await label("新增变体值").fill("Large");
  await button("添加变体").click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll("[data-component-set] > .design-node")
        .length === 3,
  );
  const geometry = () =>
    members.evaluateAll((els) =>
      els.map((el) => ({
        id: el.dataset.nodeId,
        x: el.offsetLeft,
        y: el.offsetTop,
      })),
    );
  const positions = await geometry();
  const idle = positions.find((n) => n.id === "Idle"),
    busy = positions.find((n) => n.id === "Busy"),
    large = positions.find((n) => n.id !== "Busy" && n.id !== "Idle");
  if (
    idle.y !== busy.y ||
    busy.x <= idle.x ||
    large.x !== idle.x ||
    large.y <= idle.y
  )
    throw Error("Expected two axes " + JSON.stringify(positions));
  await select("Error");
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("Shift+1");
  const chip = page.locator('[data-node-id="Error"]');
  const from = await chip.boundingBox(),
    to = await group.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 8, to.y + 9, { steps: 10 });
  await page.mouse.up();
  if ((await members.count()) !== 4)
    throw Error(
      "Dragged master did not join the set: " +
        (await page.getByRole("alert").allTextContents()),
    );
  if (
    !(await chip.isVisible()) ||
    (await group.locator('[data-node-id="Error"]').count())
  )
    throw Error("Standalone master lost its identity");
  await button("撤销").click();
  if ((await members.count()) !== 3) throw Error("Undo did not restore source");
  await button("重做").click();
  await page
    .getByTitle("已保存到此浏览器", { exact: true })
    .waitFor({ state: "attached" });
  await page.reload();
  await group.waitFor();
  if ((await members.count()) !== 4) throw Error("Reopened membership");
  await page.screenshot({ path: "output/playwright/canvas-component-set.png" });
  await button("资源").click();
  await label("搜索组件").fill("Status");
  await button("查看 Status").click();
  await button("插入组件").click();
  await label("实例 State").selectOption("Error");
  if ((await label("实例 State").inputValue()) !== "Error")
    throw Error("New member not available to instances");
  await button("图层").click();
  await page.locator('[data-layer-id="Error"] .layer-main').click();
  const width = label("宽度");
  await width.fill("96");
  await width.press("Enter");
  const updated = await downloadOriginal();
  await saved();
  await page.goto(consumerUrl);
  await button("资源").click();
  await importLibrary(updated);
  await button("应用组件库更新").click();
  if ((await consumer.evaluate((el) => el.offsetWidth)) !== 96)
    throw Error("Earlier published instance lost its master");
  return {
    members: 4,
    axes: ["State", "Size"],
    draggedMaster: true,
    originalPreserved: true,
    priorConsumerWidth: [80, 96],
    undoRedo: true,
    reopened: true,
    instance: "Error",
  };
};
