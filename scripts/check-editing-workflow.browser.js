async (page) => {
  const button = (name) => page.getByRole("button", { name, exact: true });
  const select = (name) => button("选择图层 " + name);
  const check = (value, message) => {
    if (!value) throw Error(message);
  };
  const style = {
    x: 0,
    y: 0,
    width: 90,
    height: 40,
    fill: "#ffffff",
    color: "#111111",
    radius: 0,
    fontSize: 16,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const node = (id, parentId, type, patch) => ({
    id,
    name: id,
    parentId,
    type,
    style: { ...style, ...patch },
    hidden: false,
    locked: false,
    text: type === "text" ? "文字" : "",
  });
  const doc = {
    schemaVersion: 1,
    id: "span-example",
    revision: 0,
    name: "网格编辑",
    tokens: {},
    nodes: [
      node("board", null, "frame", {
        layout: "grid",
        width: 320,
        height: 200,
        columns: 3,
        gap: 10,
      }),
      node("card", "board", "rectangle", {
        widthMode: "fill",
        fill: "#123456",
        fillOpacity: 0.4,
      }),
      node("label", "board", "text", {
        widthMode: "fill",
        color: "#156789",
        colorOpacity: 0.8,
      }),
      node("tail", "board", "rectangle", { widthMode: "fill" }),
    ],
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "grid.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await page.setViewportSize({ width: 721, height: 650 });
  const left = button("图层与资源面板"),
    right = button("属性面板");
  await right.hover();
  await page.getByRole("tooltip").filter({ hasText: "打开属性面板" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("tooltip").waitFor({ state: "hidden" });
  await left.focus();
  await page.keyboard.press("Tab");
  check(
    await right.evaluate((el) => el === document.activeElement),
    "Tab trapped in canvas navigation",
  );
  await left.click();
  await select("card").click();
  await select("label").click({ modifiers: ["Shift"] });
  await button("折叠图层").click();
  check(await select("label").isVisible(), "selected branch hidden");
  await right.click();
  const hex = page.getByLabel("填充 HEX", { exact: true });
  check(
    (await hex.getAttribute("placeholder")) === "Mixed" &&
      (await hex.inputValue()) === "",
    "mixed color not indicated",
  );
  const paint = async (id) =>
    page
      .locator('[data-node-id="' + id + '"]')
      .evaluate((el) => [
        getComputedStyle(el).backgroundColor,
        getComputedStyle(el).color,
      ]);
  const colors = async () => [
    (await paint("card"))[0],
    (await paint("label"))[1],
  ];
  const original = await colors();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  await hex.focus();
  await hex.press("Tab");
  check(same(await colors(), original), "focus changed colors");
  await button("编辑填充颜色").click();
  await page.getByLabel("颜色不透明度百分比").fill("60");
  await button("关闭颜色选择器").click();
  check(
    same(await colors(), ["rgba(18, 52, 86, 0.6)", "rgba(21, 103, 137, 0.6)"]),
    "alpha overwrote mixed hues",
  );
  await button("撤销").click();
  await hex.fill("88AACC");
  await hex.press("Enter");
  check(
    same(await colors(), [
      "rgba(136, 170, 204, 0.4)",
      "rgba(136, 170, 204, 0.8)",
    ]),
    "HEX overwrote individual alpha or wrong layer channel",
  );
  await button("撤销").click();
  check(same(await colors(), original), "Undo did not restore both");
  await left.click();
  await select("card").click();
  await right.click();
  const span = page.getByRole("textbox", { name: "跨列数", exact: true });
  await span.fill("2");
  await span.press("Enter");
  check(
    (await page
      .getByRole("textbox", { name: "宽度", exact: true })
      .inputValue()) === "210",
    "inspector span width",
  );
  await button("撤销").click();
  check((await span.inputValue()) === "1", "span undo");
  await button("重做").click();
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  await left.click();
  await select("card").click();
  await right.click();
  check((await span.inputValue()) === "2", "span persistence");
  check(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth === innerWidth &&
        document.querySelector(".right-panel").getBoundingClientRect().right <=
          innerWidth,
    ),
    "right panel clipped",
  );
  const exportButton = button("导出 React 项目");
  const box = await exportButton.boundingBox();
  check(box && box.x + box.width <= 721, "export clipped");
  await button("预览").click();
  const metrics = await page
    .locator("[data-design-id=card]")
    .evaluate((el) => [
      el.offsetWidth,
      el.nextElementSibling.offsetLeft,
      el.nextElementSibling.nextElementSibling.offsetTop,
    ]);
  check(
    same(metrics, [210, 220, 50]),
    "preview span " + JSON.stringify(metrics),
  );
  await button("关闭预览").click();
  await left.click();
  await select("board").click();
  const ticket = page.waitForEvent("download");
  await exportButton.click();
  await (await ticket).saveAs("output/playwright/span-check.zip");
  await page.locator(".editor-canvas").click({ position: { x: 4, y: 4 } });
  await button("操作").click();
  const search = page.getByRole("combobox", { name: "搜索命令" });
  await search.fill("没有这个操作");
  await page.getByText("无匹配操作").waitFor();
  await search.fill("复制样式");
  await search.press("Enter");
  check(await search.isVisible(), "disabled command ran");
  await search.press("Escape");
  return {
    mixedChannels: original,
    span: metrics,
    compactWidth: 721,
    disabledCommand: true,
  };
};
