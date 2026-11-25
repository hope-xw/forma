async (page) => {
  const button = (name) => page.getByRole("button", { name, exact: true });
  const dialog = (name) => page.getByRole("dialog", { name, exact: true });
  await page.getByTitle("新建空白文件").click();
  await page.waitForURL(/file=forma\.file\./);
  await button("快捷键 ?").click();
  await dialog("快捷键").getByText("切换工具栏、图层、画布和属性栏").waitFor();
  await page.keyboard.press("Escape");
  await dialog("快捷键").waitFor({ state: "hidden" });
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("f");
  await page.getByRole("button", { name: /iPhone 16.*393/ }).click();
  const frame = page.locator('.design-node[data-node-type="frame"]');
  if ((await frame.count()) !== 1)
    throw Error("iPhone preset did not add one frame");
  const dimensions = await frame.evaluate((el) => [
    el.offsetWidth,
    el.offsetHeight,
  ]);
  if (dimensions.join("x") !== "393x852")
    throw Error("Incorrect iPhone 16 canvas size " + dimensions);
  await button("代码").click();
  const code = dialog("React 代码");
  if (!(await code.locator("pre").innerText()).includes("export"))
    throw Error("No source for the selected frame");
  const download = page.waitForEvent("download");
  await code.getByText("下载源码文件").click();
  await download;
  await page.keyboard.press("Escape");
  await code.waitFor({ state: "hidden" });
  if (!(await button("代码").evaluate((el) => el === document.activeElement)))
    throw Error("Code dialog failed to return focus");
  await page.locator(".editor-canvas").click({ position: { x: 4, y: 4 } });
  await button("管理变量与样式").click();
  await button("新建集合").click();
  const collectionName = "验收品牌集合";
  const collection = page.getByLabel("集合名称", { exact: true });
  await collection.fill(collectionName);
  await collection.press("Enter");
  await button("添加模式").click();
  await button("创建变量").click();
  const variableName = page.getByLabel(/^变量名称 /).first();
  await variableName.fill("品牌主色");
  await variableName.press("Enter");
  await page.getByLabel("变量名称 品牌主色").click();
  const description = page.getByLabel("变量描述");
  await description.fill("主按钮使用");
  await description.press("Enter");
  await page.getByLabel("关闭变量详情").click();
  await page.getByLabel("变量名称 品牌主色").click();
  if ((await description.inputValue()) !== "主按钮使用")
    throw Error("Variable detail was lost");
  const downloadedSystem = page.waitForEvent("download");
  await button("导出设计系统").click();
  const systemFile = await (await downloadedSystem).path();
  await page.keyboard.press("Escape");
  await dialog("变量与样式").waitFor({ state: "hidden" });
  await button("选择图层 iPhone 16").click();
  await page.getByText("选区纯色", { exact: true }).click();
  const color = page.getByLabel(/^选区颜色 .* HEX$/).first();
  await color.fill("2174AB");
  await color.press("Enter");
  await page.getByLabel("选区颜色 #2174ab HEX").waitFor();
  if (
    (await frame.evaluate((el) => getComputedStyle(el).backgroundColor)) !==
    "rgb(33, 116, 171)"
  )
    throw Error("Selection color did not paint the frame");
  await page.getByText("模糊", { exact: true }).click();
  const blur = page.getByRole("textbox", { name: "图层模糊", exact: true });
  await blur.fill("6");
  await blur.press("Enter");
  if (
    !(await frame.evaluate((el) => getComputedStyle(el).filter)).includes(
      "blur(6px)",
    )
  )
    throw Error("Layer blur was not drawn");
  await button("撤销").click();
  await page.getByText("更多属性", { exact: true }).click();
  await button("删除所选图层").click();
  if (await frame.count()) throw Error("Frame still visible");
  await button("撤销").click();
  await frame.waitFor();
  await page.getByTitle("新建空白文件").click();
  await button("管理变量与样式").click();
  const popup = dialog("变量与样式");
  await popup.locator("input[type=file]").setInputFiles(systemFile);
  // Imported collections can coexist with the new file's default collection.
  await popup
    .getByRole("button", { name: new RegExp("^" + collectionName) })
    .click();
  await popup.getByLabel("变量名称 品牌主色").click();
  if ((await popup.getByLabel("变量描述").inputValue()) !== "主按钮使用")
    throw Error("Cross-file variable detail was lost");
  await button("关闭变量与样式").click();
  return {
    shortcutHelp: true,
    preset: "iPhone 16 393×852",
    codeDownload: true,
    designSystemRoundTrip: true,
    layerBlur: 6,
    escapeReturnedFocus: true,
    variableDetails: "主按钮使用",
    selectionColor: "#2174ab",
    deleteUndo: true,
  };
};
