async (page) => {
  const style = {
    x: 0,
    y: 0,
    width: 130,
    height: 70,
    fill: "#f5f5f5",
    color: "#111111",
    radius: 0,
    fontSize: 16,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const base = {
    id: "master",
    type: "frame",
    parentId: null,
    name: "Signal chip",
    text: "",
    hidden: false,
    locked: false,
    style,
  };
  const chip = {
    ...base,
    id: "chip",
    parentId: "master",
    type: "rectangle",
    name: "Ink",
    style: { ...style, x: 14, y: 16, width: 64, height: 32 },
    styleBindings: { paint: "badge" },
  };
  const collection = {
    id: "theme",
    name: "Theme",
    defaultModeId: "light",
    modes: [
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" },
    ],
  };
  const variable = {
    id: "accent",
    name: "Accent",
    type: "color",
    collectionId: "theme",
    values: { light: "#0066ff", dark: "#ff7733" },
  };
  const designSystem = {
    collections: { theme: collection },
    variables: { accent: variable },
    activeModes: { theme: "light" },
    styles: {
      badge: {
        id: "badge",
        kind: "paint",
        name: "Badge",
        properties: { fill: "#0066ff" },
        bindings: { fill: "accent" },
      },
    },
  };
  const doc = {
    id: "bound-library",
    name: "Bound library",
    schemaVersion: 1,
    revision: 0,
    tokens: {},
    nodes: [base, chip],
    designSystem,
  };
  const b = (name) => page.getByRole("button", { name, exact: true });
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "bound.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await b("选择图层 Signal chip").click();
  await b("资源").click();
  await b("保存选区").click();
  await b("查看 Signal chip").click();
  const ticket = page.waitForEvent("download");
  await b("导出此组件库").click();
  const file = await ticket,
    filepath = await file.path();
  await page.keyboard.press("Escape");
  await b("图层").click();
  await b("选择图层 Ink").click();
  const widthField = page.getByRole("textbox", { name: "宽度", exact: true });
  await widthField.fill("88");
  await widthField.press("Enter");
  await b("资源").click();
  await b("查看 Signal chip").click();
  const nextTicket = page.waitForEvent("download");
  await b("导出此组件库").click();
  const nextPath = await (await nextTicket).path();
  await page.keyboard.press("Escape");
  await page.getByTitle("新建空白文件").click();
  await page.waitForURL(/file=forma\.file\./);
  await b("资源").click();
  await page
    .locator('.left-panel input[type=file][accept=".json"]')
    .setInputFiles(filepath);
  await page.getByLabel("搜索组件").fill("Signal chip");
  await b("查看 Signal chip").click();
  await b("插入组件").click();
  const inner = page.locator(".editor-canvas [data-node-type=rectangle]");
  const sample = () =>
    inner.evaluate((el) => getComputedStyle(el).backgroundColor);
  if ((await sample()) !== "rgb(0, 102, 255)")
    throw Error("Default component theme missing");
  await page.getByLabel("模式 Theme", { exact: true }).selectOption("dark");
  if ((await sample()) !== "rgb(255, 119, 51)")
    throw Error("Imported style is no longer live");
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  if ((await sample()) !== "rgb(255, 119, 51)")
    throw Error("Imported tokens did not persist");
  await page.getByLabel("搜索图层").fill("Ink");
  await b("选择图层 Ink").click();
  const name = page.getByRole("textbox", { name: "名称", exact: true });
  await name.fill("本地外观");
  await name.press("Enter");
  await b("资源").click();
  await page
    .locator('.left-panel input[type=file][accept=".json"]')
    .setInputFiles(nextPath);
  await page.getByRole("dialog", { name: "查看组件库更新" }).waitFor();
  await b("应用组件库更新").click();
  if ((await inner.evaluate((el) => el.offsetWidth)) !== 88)
    throw Error("linked library did not update");
  await b("撤销").click();
  if ((await inner.evaluate((el) => el.offsetWidth)) !== 64)
    throw Error("library upgrade undo");
  await b("重做").click();
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  await page.getByLabel("搜索图层").fill("本地外观");
  await b("选择图层 本地外观").click();
  if (
    (await inner.evaluate((el) => el.offsetWidth)) !== 88 ||
    (await sample()) !== "rgb(255, 119, 51)"
  )
    throw Error("local override, geometry or theme lost after reopening");
  return {
    linkedRevision: {
      originalWidth: 64,
      updatedWidth: 88,
      keptName: true,
      undo: true,
    },
    exportedAndReimported: true,
    light: "#0066ff",
    dark: "#ff7733",
    saved: true,
  };
};
