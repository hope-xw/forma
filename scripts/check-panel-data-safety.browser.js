async (page) => {
  const { strict: assert } = await import("node:assert");
  const b = (name) => page.getByRole("button", { name, exact: true });
  const f = (name) => page.getByLabel(name, { exact: true });
  const rect = {
    x: 0,
    y: 0,
    width: 500,
    height: 260,
    fill: "#283248",
    color: "#ffffff",
    padding: 0,
    gap: 0,
    radius: 0,
    fontSize: 18,
    layout: "free",
  };
  const board = {
    id: "board",
    parentId: null,
    name: "测试画板",
    type: "frame",
    hidden: false,
    locked: false,
    text: "",
    style: rect,
  };
  const nodes = [
    board,
    ...["甲", "乙"].map((text, i) => ({
      ...board,
      id: "txt" + i,
      name: text,
      text,
      parentId: "board",
      type: "text",
      style: {
        ...rect,
        x: 20 + i * 180,
        y: 35,
        width: 140,
        height: 42,
        minWidth: 40 + i * 20,
      },
    })),
  ];
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "safety.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        id: "safety",
        name: "编辑保护",
        revision: 0,
        tokens: {},
        nodes,
      }),
    ),
  });
  const select = (name, opts) => b("选择图层 " + name).click(opts);
  const layer = (i) => page.locator('[data-node-id="txt' + i + '"]');
  const measured = () =>
    page
      .locator('[data-node-id^="txt"]')
      .evaluateAll((els) =>
        els.map((el) => [el.textContent, el.style.left, el.style.minWidth]),
      );
  const initial = await measured();
  assert.deepEqual(
    initial.map((row) => row[0]),
    ["甲", "乙"],
  );
  const rows = await page
    .locator('[data-layer-id^="txt"]')
    .evaluateAll((els) => els.map((el) => el.dataset.layerId));
  assert.deepEqual(rows, ["txt1", "txt0"]);
  await select("乙");
  await b("选择图层 乙").press("ArrowDown");
  await layer(0)
    .locator("xpath=self::*[contains(@class,'selected')]")
    .waitFor();
  assert.deepEqual(await measured(), initial);
  await select("乙", { modifiers: ["Shift"] });
  assert.ok(await f("名称").isDisabled());
  await f("X").press("ArrowUp");
  await page.locator("summary").filter({ hasText: "尺寸范围" }).click();
  await f("最小宽度").focus();
  await f("最小宽度").press("Tab");
  await page.locator("summary").filter({ hasText: "文本内容" }).click();
  const content = page.getByRole("textbox", { name: "文本内容", exact: true });
  await content.focus();
  await content.press("Tab");
  assert.deepEqual(await measured(), initial);
  await select("甲");
  assert.equal(await f("最小宽度").inputValue(), "40");
  await select("乙");
  assert.equal(await f("最小宽度").inputValue(), "60");
  await layer(1).dblclick();
  const edit = f("画布文本编辑");
  await edit.fill("保留新内容");
  await edit.press("Escape");
  assert.equal(await layer(1).textContent(), "保留新内容");
  await b("撤销").click();
  assert.deepEqual(await measured(), initial);
  await select("测试画板");
  await b("独立圆角").click();
  const corners = ["左上圆角", "右上圆角", "左下圆角", "右下圆角"];
  for (const [idx, name] of corners.entries()) {
    await f(name).fill(String(4 + idx * 4));
    await f(name).press("Enter");
  }
  const actual = await page.locator('[data-node-id="board"]').evaluate((el) => {
    const s = getComputedStyle(el);
    return [
      s.borderTopLeftRadius,
      s.borderTopRightRadius,
      s.borderBottomLeftRadius,
      s.borderBottomRightRadius,
    ];
  });
  assert.deepEqual(actual, ["4px", "8px", "12px", "16px"]);
  const cv = page.locator(".editor-canvas");
  await cv.focus();
  await page.keyboard.press("p");
  const pen = f("钢笔绘制");
  const box = await pen.boundingBox();
  await page.mouse.click(box.x + 60, box.y + 65);
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.locator(".pen-guide").waitFor();
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("Escape");
  assert.deepEqual(await measured(), initial);
  await select("测试画板");
  assert.equal(await f("右下圆角").inputValue(), "16");
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  return {
    topFirst: rows,
    treeKeyboard: true,
    untouchedMixedLimits: [40, 60],
    untouchedMixedText: ["甲", "乙"],
    inlineEscapeUndo: true,
    cornerOrder: actual,
    penDraftUndoIsolated: true,
  };
};
