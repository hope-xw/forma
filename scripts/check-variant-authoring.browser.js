async (page) => {
  const b = (name) => page.getByRole("button", { name, exact: true }),
    f = (name) => page.getByLabel(name, { exact: true });
  const style = {
    x: 0,
    y: 0,
    width: 140,
    height: 44,
    layout: "free",
    gap: 0,
    padding: 0,
    fill: "#ffffff",
    color: "#202536",
    radius: 5,
    fontSize: 16,
  };
  const n = (id, name, type, parentId, overrides = {}, text = "") => ({
    id,
    name,
    type,
    parentId,
    style: { ...style, ...overrides },
    text,
    locked: false,
    hidden: false,
  });
  const doc = {
    schemaVersion: 1,
    id: "authored-variant-demo",
    name: "通知状态",
    revision: 0,
    tokens: {},
    nodes: [
      n("dashboard", "通知面板", "frame", null, { width: 400, height: 200 }),
      n("master", "通知徽标", "frame", null, { x: 520 }),
      n(
        "label",
        "徽标文字",
        "text",
        "master",
        { width: 120, height: 32 },
        "就绪",
      ),
      n("other-build", "警示徽标", "frame", null, { x: 1100, width: 190 }),
      n("other-label", "徽标文字", "text", "other-build", {}, "注意"),
    ],
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "demo.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const select = (id) =>
    page
      .locator('[data-layer-id="' + id + '"]')
      .getByRole("button", { name: /^选择图层 / })
      .click();
  const selected = () =>
    page.locator(".design-node.selected").getAttribute("data-node-id");
  const details = async (text) => {
    const el = page
      .locator("details")
      .filter({ has: page.locator("summary").filter({ hasText: text }) })
      .last();
    if (!(await el.evaluate((el) => el.open)))
      await el.locator("summary").click();
  };
  await select("master");
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("Meta+Alt+KeyK");
  await details(/^公开组件属性/);
  await f("组件属性类型").selectOption("text");
  await f("属性目标图层").selectOption({ label: "徽标文字" });
  await f("组件属性名称").fill("文案");
  await b("公开属性").click();
  await details(/^组件变体/);
  await f("变体属性名").fill("State");
  await f("变体当前值").fill("Normal");
  await f("新增变体值").fill("Busy");
  await b("添加变体").click();
  const busy = await selected();
  if (busy === "master") throw Error("Variant did not get its own drawing");
  await details(/^组件变体/);
  await f("选择变体属性").selectOption("");
  await f("变体属性名").fill("Size");
  await f("变体当前值").fill("Regular");
  await f("新增变体值").fill("Large");
  await b("添加变体").click();
  const large = await selected();
  await details(/^组件变体/);
  await f("选择变体属性").selectOption("Size");
  await b("重命名变体属性").click();
  await f("变体属性名").fill("尺寸");
  await f("变体当前值").fill("宽版");
  await b("应用变体属性").click();
  const width = page.getByRole("textbox", { name: "宽度", exact: true });
  await width.fill("220");
  await width.press("Enter");
  await select("dashboard");
  await b("资源").click();
  await f("搜索组件").fill("通知徽标");
  await b("查看 通知徽标").click();
  await b("插入组件").click();
  const instance = await selected();
  await f("实例属性 文案").fill("待发送");
  await f("实例属性 文案").press("Enter");
  await f("实例 State").selectOption("Busy");
  await f("实例 尺寸").selectOption("宽版");
  const inst = page.locator('[data-node-id="' + instance + '"]');
  const dimension = () => inst.evaluate((el) => el.offsetWidth);
  if ((await inst.innerText()) !== "待发送" || (await dimension()) !== 220)
    throw Error("Authored variant geometry or overridden text changed");
  if (
    !(await f("实例 State")
      .locator("option", { hasText: "Normal" })
      .isDisabled())
  )
    throw Error("Unavailable combination was allowed");
  await b("撤销").click();
  if ((await dimension()) !== 140)
    throw Error("Variant undo did not restore the source geometry");
  await b("重做").click();
  await b("定位主组件").click();
  if ((await selected()) !== large) throw Error("Wrong variant master");
  await width.fill("232");
  await width.press("Enter");
  if ((await dimension()) !== 232)
    throw Error("Live variant did not propagate edited width");
  await details(/^组件变体/);
  await f("选择变体属性").selectOption("尺寸");
  await page
    .locator("#right-panel")
    .screenshot({ path: "output/playwright/author-variants-panel.png" });
  await b("移出变体集").click();
  await page.getByText(/仍有实例使用此变体/).waitFor();
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  await inst.getByText("待发送", { exact: true }).waitFor();
  if ((await dimension()) !== 232)
    throw Error("Reopened instance lost authored variant");
  await b("图层").click();
  await select("dashboard");
  let file = page.waitForEvent("download");
  await b("导出 React 项目").click();
  await (await file).saveAs("output/playwright/variant-authoring-check.zip");
  await b("预览").click();
  const output = page.locator('[data-design-id="' + instance + '"]');
  if (
    (await output.innerText()) !== "待发送" ||
    (await output.evaluate((el) => el.offsetWidth)) !== 232
  )
    throw Error("Preview differs");
  await b("关闭预览").click();
  await select("master");
  await page
    .locator('[data-layer-id="other-build"]')
    .getByRole("button", { name: "选择图层 警示徽标" })
    .click({ modifiers: ["Meta"] });
  await details(/^组合为变体集/);
  await f("组件集名称").fill("队列标签组");
  await f("组件集属性").fill("Tone");
  await f("变体值 通知徽标").fill("Idle");
  await f("变体值 警示徽标").fill("Warning");
  await b("保留原主件，创建变体集").click();
  if ((await selected()) === "master")
    throw Error("Existing source was repurposed when combining");
  await select("dashboard");
  await b("资源").click();
  await f("搜索组件").fill("队列标签组");
  await b("查看 队列标签组").click();
  await b("插入组件").click();
  const combined = await selected();
  await f("实例 Tone").selectOption("Warning");
  if ((await f("实例属性 文案").inputValue()) !== "注意")
    throw Error("Published text property was lost in the combined set");
  const warning = page.locator('[data-node-id="' + combined + '"]');
  if (
    (await warning.innerText()) !== "注意" ||
    (await warning.evaluate((el) => el.offsetWidth)) !== 190 ||
    (await dimension()) !== 232
  )
    throw Error("Combined set or original instances were lost");
  await b("图层").click();
  await select("dashboard");
  file = page.waitForEvent("download");
  await b("导出 React 项目").click();
  await (await file).saveAs("output/playwright/variant-authoring-check.zip");
  const native = page.waitForEvent("download");
  await b("设计文件").click();
  await (await native).saveAs("output/playwright/variant-authoring.forma.json");
  await b("资源").click();
  await f("搜索组件").fill("通知徽标");
  await b("查看 通知徽标").click();
  file = page.waitForEvent("download");
  await b("导出此组件库").click();
  const library = await (await file).path();
  await page.keyboard.press("Escape");
  await b("新建空白文件").click();
  await page.waitForURL(/file=forma.file/);
  await b("资源").click();
  await page
    .locator('.left-panel input[type=file][accept=".json"]')
    .setInputFiles(library);
  await f("搜索组件").fill("通知徽标");
  await b("查看 通知徽标").click();
  await f("预览 State").selectOption("Busy");
  await f("预览 尺寸").selectOption("宽版");
  await b("插入组件").click();
  if (
    (await page
      .locator(".design-node.selected")
      .evaluate((el) => el.offsetWidth)) !== 232
  )
    throw Error("Cross-file variant lost its authored geometry");
  return {
    variants: 3,
    axes: ["State", "尺寸"],
    override: "待发送",
    width: 232,
    uniqueCombinations: true,
    reopened: true,
    crossFile: true,
    combinedExistingDrawings: true,
  };
};
