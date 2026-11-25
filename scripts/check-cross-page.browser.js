async (page) => {
  const editor = !!(await page.locator(".editor-canvas").count());
  const button = (n) => page.getByRole("button", { name: n, exact: true });
  const n = (id) => page.locator('[data-design-id="' + id + '"]');
  const style = {
    x: 0,
    y: 0,
    width: 260,
    height: 210,
    fill: "#ffffee",
    color: "#131722",
    radius: 0,
    fontSize: 16,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const layer = (id, parentId, type, interaction) => ({
    id,
    name: id,
    type,
    parentId,
    interaction,
    style: parentId
      ? { ...style, width: 120, height: 45, x: 15, y: 15, fill: "#96ce99" }
      : style,
    text: parentId ? id : "",
    hidden: false,
    locked: false,
  });
  if (editor) {
    const doc = {
      schemaVersion: 1,
      id: "cross-pages",
      name: "Cross-page journey",
      revision: 0,
      tokens: {},
      activePage: "web",
      nodes: [
        layer("Start", null, "frame", { flow: "Begin" }),
        layer("Go", "Start", "button"),
      ],
      pages: [
        { id: "web", name: "Web" },
        {
          id: "mobile",
          name: "Mobile",
          nodes: [
            layer("Detail", null, "frame"),
            layer("Share", "Detail", "button", {
              actions: [
                { kind: "overlay", target: "Sheet", position: "center" },
              ],
            }),
            {
              ...layer("Back", "Detail", "button", {
                actions: [{ kind: "back" }],
              }),
              style: { ...style, x: 15, y: 90, width: 120, height: 45 },
            },
          ],
        },
        {
          id: "sheets",
          name: "Overlays",
          nodes: [
            layer("Sheet", null, "frame"),
            {
              ...layer("Inspect", "Sheet", "button", {
                actions: [
                  { kind: "overlay", target: "Confirm", position: "center" },
                ],
              }),
              style: { ...style, x: 15, y: 95, width: 120, height: 45 },
            },
            layer("Confirm", null, "frame"),
            layer("Accept", "Confirm", "button", {
              actions: [{ kind: "close" }],
            }),
            layer("Dismiss", "Sheet", "button", {
              actions: [{ kind: "close" }],
            }),
          ],
        },
        { id: "blank", name: "Empty page", nodes: [] },
      ],
    };
    await page.locator('[data-testid="design-file-input"]').setInputFiles({
      name: "links.forma.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
    await button("选择图层 Go").click();
    await button("原型").click();
    await button("添加动作").click();
    await page.getByLabel("动作目标").selectOption("Detail");
    await button("定位目标画板").click();
    await page
      .locator(".editor-canvas [data-node-id=Detail].selected")
      .waitFor();
    await button("返回连线来源").click();
    await page.locator(".editor-canvas [data-node-id=Go].selected").waitFor();
    await button("预览").click();
  }
  await n("Go").click();
  await n("Share").click();
  await page.getByRole("dialog", { name: "Sheet", exact: true }).waitFor();
  for (let cycle = 0; cycle < 2; cycle++) {
    await n("Inspect").press("Enter");
    const dialog = page.getByRole("dialog", { name: "Confirm", exact: true });
    await dialog.waitFor();
    if (!(await dialog.evaluate((el) => el === document.activeElement)))
      throw Error("Nested dialog entry focus");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    if (!(await n("Accept").evaluate((el) => el === document.activeElement)))
      throw Error("Nested Tab escaped");
    await page.keyboard.press(cycle ? "Enter" : "Escape");
    if (!(await n("Inspect").evaluate((el) => el === document.activeElement)))
      throw Error("Nested dialog failed to restore opener");
  }
  await n("Dismiss").click();
  if (!(await n("Share").evaluate((el) => el === document.activeElement)))
    throw Error("Sheet failed to restore opener");
  await n("Back").click();
  await n("Go").waitFor();
  if (editor) {
    await button("关闭预览").click();
    const download = page.waitForEvent("download");
    await button("导出 React 项目").click();
    await (await download).saveAs("output/playwright/cross-check.zip");
    await page.getByLabel("文件菜单", { exact: true }).click();
    const file = page.waitForEvent("download");
    await button("导出整个文件为 React 项目…").click();
    const original = await file;
    await original.saveAs("output/playwright/file-check.zip");
    const { readFile } = await import("node:fs/promises");
    const { unzipSync, zipSync, strToU8, strFromU8 } = await import("fflate");
    const files = unzipSync(await readFile(await original.path()));
    const entry = await readFile(
      (process.env.INIT_CWD ?? process.cwd()) +
        "/scripts/fixtures/order-review/main.tsx.txt",
      "utf8",
    );
    files["src/main.tsx"] = strToU8(entry);
    await button("设计").click();
    await button("选择图层 Go").click();
    const width = page.getByLabel("宽度", { exact: true });
    await width.fill("148");
    await width.press("Enter");
    await page.getByLabel("文件菜单", { exact: true }).click();
    const pick = page.waitForEvent("filechooser");
    await button("更新已有 React 工程…").click();
    const revision = page.waitForEvent("download");
    await (
      await pick
    ).setFiles({
      name: "orders.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(zipSync(files)),
    });
    const result = await revision;
    const merged = unzipSync(await readFile(await result.path()));
    if (strFromU8(merged["src/main.tsx"]) !== entry)
      throw Error("Business route overwritten during design update");
    await result.saveAs("output/playwright/route-upgrade-check.zip");
  }
  return {
    navigate: "Web → Mobile",
    overlay: "Mobile → Overlays",
    back: "Web",
  };
};
