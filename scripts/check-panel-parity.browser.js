async (page) => {
  const { strict: assert } = await import("node:assert");
  const { readFile } = await import("node:fs/promises");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const field = (name) => page.getByLabel(name, { exact: true });
  const canvas = page.locator(".editor-canvas");
  const saved = () =>
    page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  const keys = (combo) => page.keyboard.press(combo);
  const checkInput = async (input, value) => {
    await input.fill(value);
    await input.press("Enter");
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  };
  const back = async () => {
    await button("撤销").click();
    await page.waitForFunction(
      () => !document.querySelector('button[aria-label="重做"]')?.disabled,
    );
    await saved();
  };
  await saved();
  const filename = await field("文件名").inputValue();
  await button("打开本机工作空间文件列表").click();
  const thumb = page.locator(".file-card-thumb img").first();
  await thumb.waitFor();
  assert.ok(
    await thumb.evaluate(async (el) => {
      await el.decode();
      return el.naturalWidth > 0;
    }),
  );
  await button("列表视图").click();
  await button("重命名 " + filename).click();
  await field("重命名文件").fill("取消改名");
  await field("重命名文件").press("Escape");
  await button("重命名 " + filename).click();
  await checkInput(field("重命名文件"), "复核原稿");
  await button("复制 复核原稿").click();
  await button("删除 复核原稿 副本").click();
  await button("关闭本机文件").click();
  assert.equal(await field("文件名").inputValue(), "复核原稿");
  await back();
  assert.equal(await field("文件名").inputValue(), filename);
  await button("重做").click();
  await saved();
  assert.equal(await field("文件名").inputValue(), "复核原稿");
  await checkInput(field("文件名"), "可继续编辑");
  await saved();
  await page.reload();
  await saved();
  assert.equal(await field("文件名").inputValue(), "可继续编辑");

  const sourceLayerCount = await page.locator("[data-node-id]").count();
  await button("打开本机工作空间文件列表").click();
  await button("复制 可继续编辑").click();
  await page.getByRole("link", { name: /可继续编辑 副本/ }).click();
  await page.waitForURL(/file=forma\.file\./);
  await saved();
  assert.equal(await field("文件名").inputValue(), "可继续编辑 副本");
  assert.equal(await page.locator("[data-node-id]").count(), sourceLayerCount);
  await checkInput(field("文件名"), "独立副本");
  await saved();
  await button("打开本机工作空间文件列表").click();
  await button("删除 独立副本").click();
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="文件名"]')?.value ===
      "可继续编辑",
  );
  await saved();
  assert.equal(await page.locator("[data-node-id]").count(), sourceLayerCount);
  await button("AI 设计助手").click();
  await field("设计需求").fill("保留这一版草稿");
  await button("图层").click();
  await button("AI 设计助手").click();
  assert.equal(await field("设计需求").inputValue(), "保留这一版草稿");
  await button("图层").click();
  await button("操作").click();
  const search = field("搜索命令");
  for (let i = 0; i < 14; i++) await search.press("ArrowDown");
  assert.ok(
    await search.evaluate((el) => {
      const box = document
        .getElementById(el.getAttribute("aria-activedescendant"))
        .getBoundingClientRect();
      const list = document
        .getElementById(el.getAttribute("aria-controls"))
        .getBoundingClientRect();
      return (
        el === document.activeElement &&
        box.top >= list.top - 1 &&
        box.bottom <= list.bottom + 1
      );
    }),
  );
  await search.press("Escape");
  await button("变量与样式").click();
  assert.equal(
    await page.locator(".ds-dialog").getAttribute("aria-modal"),
    "false",
  );
  await canvas.focus();
  await keys("f");
  await page.getByText("画板预设", { exact: true }).waitFor();
  await page.locator(".ds-dialog").focus();
  await keys("Escape");
  await canvas.focus();
  await keys("v");
  const board = page.locator('.design-node[data-node-type="frame"]').first();
  const id = await board.getAttribute("data-node-id");
  await page.locator('[data-layer-id="' + id + '"] .layer-main').click();
  const hex = field("填充 HEX"),
    alpha = field("填充不透明度");
  const original = [await hex.inputValue(), await alpha.inputValue()];
  await checkInput(hex, "1258A080");
  assert.deepEqual(
    [await hex.inputValue(), await alpha.inputValue()],
    ["1258A0", "50"],
  );
  await back();
  assert.deepEqual(
    [await hex.inputValue(), await alpha.inputValue()],
    original,
  );
  await hex.fill("AA1111");
  await hex.press("Escape");
  assert.equal(await hex.inputValue(), original[0]);
  await button("编辑填充颜色").click();
  await field("颜色模型").selectOption("CSS");
  await checkInput(field("颜色值"), "rgba(34, 85, 153, 0.4)");
  await button("关闭颜色选择器").click();
  assert.deepEqual(
    [await hex.inputValue(), await alpha.inputValue()],
    ["225599", "40"],
  );
  await back();
  assert.deepEqual(
    [await hex.inputValue(), await alpha.inputValue()],
    original,
  );
  await button("编辑填充颜色").click();
  const sv = await field("饱和度与亮度").boundingBox();
  await page.mouse.move(sv.x + 8, sv.y + 8);
  await page.mouse.down();
  await page.mouse.move(sv.x + sv.width / 2, sv.y + sv.height / 2, {
    steps: 8,
  });
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  const live = await hex.inputValue();
  await page.mouse.up();
  await button("关闭颜色选择器").click();
  assert.notEqual(live, original[0]);
  assert.equal(await hex.inputValue(), live);
  await back();
  assert.equal(await hex.inputValue(), original[0]);
  await field("导出格式").selectOption("svg");
  await field("导出倍率").selectOption("3");
  const dl = page.waitForEvent("download");
  await button("导出所选图层").click();
  const svg = await readFile(await (await dl).path(), "utf8");
  const size = await page.evaluate((svg) => {
    const root = new DOMParser().parseFromString(
      svg,
      "image/svg+xml",
    ).documentElement;
    return [
      Number(root.getAttribute("width")),
      Number(root.getAttribute("viewBox").split(" ")[2]),
    ];
  }, svg);
  assert.ok(size[1] > 0);
  assert.equal(size[0], size[1] * 3);
  await button("代码").click();
  const tabs = page.getByRole("tablist", { name: "代码文件" });
  await tabs.getByRole("tab", { selected: true }).press("ArrowRight");
  await page.getByRole("tabpanel", { name: "tokens.css" }).waitFor();
  await keys("Escape");
  await saved();
  return {
    fileThumbnail: true,
    activeRenameUndoable: true,
    duplicateDeleted: true,
    copiedFileReopenedAndDeletedIndependently: true,
    agentDraft: true,
    commandScroll: true,
    modelessCanvasShortcut: true,
    colorUndo: ["eightDigitHex", "cssRgba", "drag"],
    svgWidth: size,
    keyboardCodeTabs: true,
  };
};
