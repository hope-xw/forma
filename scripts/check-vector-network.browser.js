async (page) => {
  const button = (name) => page.getByRole("button", { name, exact: true });
  const style = {
    width: 400,
    height: 300,
    x: 0,
    y: 0,
    layout: "free",
    fill: "#ffffff",
    color: "#334455",
    radius: 0,
    padding: 0,
    gap: 0,
    fontSize: 16,
  };
  const board = {
    id: "board",
    type: "frame",
    name: "Board",
    parentId: null,
    style,
    text: "",
    locked: false,
    hidden: false,
  };
  const glyph = {
    ...board,
    id: "glyph",
    parentId: "board",
    name: "Split badge",
    type: "vector",
    style: { ...style, x: 66, y: 50, width: 140, height: 100 },
    vector: {
      width: 140,
      height: 100,
      paths: [{ d: "M0 0L140 0L140 100L0 100Z", fill: true, strokeWidth: 0 }],
    },
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "badge.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        id: "network",
        name: "Badge",
        schemaVersion: 1,
        revision: 0,
        tokens: {},
        nodes: [board, glyph],
      }),
    ),
  });
  await button("选择图层 Split badge").click();
  const paths = page.locator('[data-node-id="glyph"] > svg path');
  const anchors = (p, a) =>
    page.locator(
      '.vector-surface circle[data-path="' +
        p +
        '"][data-anchor="' +
        a +
        '"]:not([data-handle])',
    );
  const result = () =>
    paths.evaluateAll((els) =>
      els.map((el) => [el.getAttribute("d"), el.getAttribute("fill")]),
    );
  await button("编辑锚点").click();
  await anchors(0, 0).click();
  await button("从锚点连接分支").click();
  await anchors(0, 2).click();
  await button("完成路径").click();
  if ((await paths.count()) !== 2)
    throw Error("Connected chord did not divide the region");
  for (const [index, hex] of [
    [0, "1177CC"],
    [1, "FFAA22"],
  ]) {
    await page.getByLabel("路径", { exact: true }).selectOption(String(index));
    const f = page.getByLabel("路径填充 HEX", { exact: true });
    await f.fill(hex);
    await f.press("Enter");
  }
  const before = await result();
  await button("编辑锚点").click();
  await anchors(1, 0).click();
  await page.keyboard.press("Shift+ArrowRight");
  const joined = await result();
  if (joined.some(([d], i) => d === before[i][0]))
    throw Error("A shared vertex failed to move on both sides");
  await button("完成路径").click();
  await button("撤销").click();
  if (JSON.stringify(await result()) !== JSON.stringify(before))
    throw Error("Undo did not restore both regions");
  await button("重做").click();
  await page
    .getByTitle(/^已保存到(此浏览器|本机)$/)
    .waitFor({ state: "attached" });
  await page.reload();
  await paths.first().waitFor();
  if (JSON.stringify(await result()) !== JSON.stringify(joined))
    throw Error("Reopened regions differ");
  await button("选择图层 Split badge").click();
  await button("编辑锚点").click();
  await anchors(1, 0).click();
  await page.keyboard.press("ArrowLeft");
  if ((await result()).some(([d], i) => d === joined[i][0]))
    throw Error("Reopened joint is disconnected");
  await button("从锚点连接分支").click();
  const bounds = await page.locator('[data-node-id="glyph"]').boundingBox();
  await page.mouse.click(
    bounds.x + bounds.width + 18,
    bounds.y + bounds.height / 2,
  );
  await button("完成路径").click();
  if ((await paths.count()) !== 3) throw Error("Open branch missing");
  await button("选择图层 Board").click();
  await button("预览").click();
  const preview = page.locator('[data-design-id="glyph"] > svg path');
  const fills = await preview.evaluateAll((els) =>
    els.map((e) => e.getAttribute("fill").toLowerCase()),
  );
  if (fills.join() !== "#1177cc,#ffaa22,none")
    throw Error(JSON.stringify(fills));
  await page.screenshot({ path: "output/playwright/vector-network.png" });
  await button("关闭预览").click();
  const download = page.waitForEvent("download");
  await button("导出 React 项目").click();
  await (await download).saveAs("output/playwright/vector-network-check.zip");
  return {
    regions: 2,
    fills,
    sharedVertex: true,
    reopened: true,
    undo: true,
    openBranches: 1,
  };
};
