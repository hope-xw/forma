async (page) => {
  const b = (n) => page.getByRole("button", { name: n, exact: true }),
    f = (n) => page.getByLabel(n, { exact: true });
  const select = (n) => b("选择图层 " + n).click();
  const save = async (name) => {
    await select(name);
    await b("资源").click();
    await b("保存选区").click();
    await b("图层").click();
  };
  const insert = async (parent, name) => {
    await select(parent);
    await b("资源").click();
    await f("搜索组件").fill(name);
    await b("查看 " + name).click();
    await b("插入组件").click();
    await b("图层").click();
  };
  const style = {
    x: 0,
    y: 0,
    width: 90,
    height: 32,
    layout: "free",
    gap: 0,
    padding: 0,
    fill: "#ffffff",
    color: "#16222a",
    radius: 0,
    fontSize: 14,
  };
  const n = (id, type, parentId, patch = {}, text = "") => ({
    id,
    name: id,
    type,
    parentId,
    text,
    hidden: false,
    locked: false,
    style: { ...style, ...patch },
  });
  const doc = {
    schemaVersion: 1,
    tokens: {},
    id: "slots-workspace",
    name: "Nested",
    revision: 0,
    nodes: [
      n("Screen", "frame", null, { width: 450, height: 240 }),
      n("Report", "frame", null, { width: 420, height: 240, x: 1260 }),
      n("Header", "frame", null, { width: 260, height: 110, x: 1800 }),
      n("Toolbar", "frame", null, { width: 200, height: 75, x: 510 }),
      n("Heading", "text", "Toolbar", {}, "操作"),
      n("Primary", "frame", null, { x: 850 }),
      n("DefaultMark", "text", "Primary", {}, "普通标识"),
      n("Secondary", "frame", null, { x: 1000 }),
      n("AlternateMark", "text", "Secondary", {}, "备用标识"),
      n("Dot", "ellipse", "Secondary", { x: 72, width: 8, height: 8 }),
    ],
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "nested.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await save("Primary");
  await save("Secondary");
  await insert("Toolbar", "Primary");
  await save("Toolbar");
  const props = page
    .locator("details")
    .filter({ has: page.getByText(/^公开组件属性 ·/) });
  if (!(await props.evaluate((el) => el.open)))
    await props.locator("summary").click();
  for (const [kind, target, label] of [
    ["text", "Heading", "标题"],
    ["swap", "Primary", "标识"],
  ]) {
    await f("组件属性类型").selectOption(kind);
    await f("属性目标图层").selectOption({ label: target });
    await f("组件属性名称").fill(label);
    await b("公开属性").click();
  }
  await insert("Screen", "Toolbar");
  const selected = page.locator(".design-node.selected");
  const root = await selected.getAttribute("data-node-id");
  const instance = page.locator('[data-node-id="' + root + '"]');
  const title = f("实例属性 标题");
  await title.fill("发布工具");
  await title.press("Enter");
  const slot = f("实例属性 标识");
  const option = await slot
    .locator("option")
    .filter({ hasText: /^Secondary ·/ })
    .getAttribute("value");
  await slot.selectOption(option);
  await slot.scrollIntoViewIfNeeded();
  await page
    .locator("#right-panel")
    .screenshot({ path: "output/playwright/nested-instance-panel.png" });
  const assert = async (text) => {
    if (
      !(await instance.innerText()).includes(text) ||
      !(await instance.innerText()).includes("发布工具")
    )
      throw Error("nested selection " + (await instance.innerText()));
  };
  await assert("备用标识");
  await b("撤销").click();
  await assert("普通标识");
  await b("重做").click();
  await assert("备用标识");
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  await instance.waitFor();
  await assert("备用标识");
  await f("搜索图层").fill("AlternateMark");
  await page
    .locator('[data-layer-id="AlternateMark"]')
    .getByRole("button", { name: "选择图层 AlternateMark", exact: true })
    .click();
  await page.getByText("文本内容", { exact: true }).click();
  const input = page.locator(".advanced-properties textarea");
  await input.fill("新版标识");
  await input.blur();
  await assert("新版标识");
  await f("搜索图层").fill("");
  await select("Screen");
  const ticket = page.waitForEvent("download");
  await b("导出 React 项目").click();
  await (await ticket).saveAs("output/playwright/nested-instances-check.zip");
  await b("预览").click();
  await page
    .locator('[data-design-id="' + root + '"]')
    .getByText("新版标识", { exact: true })
    .waitFor();
  await b("关闭预览").click();
  await insert("Header", "Toolbar");
  await save("Header");
  if (!(await props.evaluate((el) => el.open)))
    await props.locator("summary").click();
  await f("组件属性类型").selectOption("inherited");
  for (const [field, alias] of [
    ["标题", "页头标题"],
    ["标识", "页头标识"],
  ]) {
    await f("属性目标图层").selectOption({ label: "Toolbar / " + field });
    await f("组件属性名称").fill(alias);
    await b("公开属性").click();
  }
  await insert("Report", "Header");
  const headerId = await page
    .locator(".design-node.selected")
    .getAttribute("data-node-id");
  const header = page.locator('[data-node-id="' + headerId + '"]');
  await f("实例属性 页头标题").fill("团队概览");
  await f("实例属性 页头标题").press("Enter");
  await f("实例属性 页头标识").selectOption(option);
  await header.getByText("团队概览", { exact: true }).waitFor();
  await header.getByText("新版标识", { exact: true }).waitFor();
  await b("撤销").click();
  await header.getByText("普通标识", { exact: true }).waitFor();
  await b("重做").click();
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  await header.getByText("新版标识", { exact: true }).waitFor();
  await select("Report");
  const report = page.waitForEvent("download");
  await b("导出 React 项目").click();
  await (
    await report
  ).saveAs("output/playwright/forwarded-instances-check.zip");
  await b("预览").click();
  const finished = page.locator('[data-design-id="' + headerId + '"]');
  await finished.getByText("团队概览", { exact: true }).waitFor();
  await finished.getByText("新版标识", { exact: true }).waitFor();
  return {
    exposedNestedSwap: true,
    forwardedLevels: 3,
    retainedTitle: true,
    updatedFromNestedMaster: true,
    undoRedo: true,
    reopened: true,
  };
};
