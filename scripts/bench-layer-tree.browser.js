async (page) => {
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const results = [];
  const paint = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const heap = async () =>
    Math.round(
      (await session.send("Performance.getMetrics")).metrics.find(
        (m) => m.name === "JSHeapUsedSize",
      ).value / 1048576,
    );
  const sample = async (work) => {
    const start = performance.now();
    await work();
    await paint();
    return Math.round(performance.now() - start);
  };
  const style = {
    x: 0,
    y: 0,
    width: 8,
    height: 8,
    fill: "#b4cbed",
    color: "#111111",
    radius: 2,
    fontSize: 14,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  for (const count of [100, 1000, 10000]) {
    const nodes = Array.from({ length: count }, (_, i) => ({
      id: "n" + i,
      parentId: i ? "n0" : null,
      type: i ? "rectangle" : "frame",
      name: "Layer " + i,
      text: "",
      hidden: false,
      locked: false,
      style: {
        ...style,
        ...(i
          ? { x: (i % 100) * 10, y: Math.floor(i / 100) * 10 }
          : { width: 1100, height: 1100 }),
      },
    }));
    const doc = {
      schemaVersion: 1,
      id: "stress-" + count,
      name: "Stress " + count,
      revision: 0,
      nodes,
      tokens: {},
    };
    const id = "n1";
    const importMs = await sample(async () => {
      await page.locator('[data-testid="design-file-input"]').setInputFiles({
        name: "stress.forma.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(doc)),
      });
      await page
        .locator('[data-node-id="' + id + '"]')
        .waitFor({ state: "attached" });
    });
    const tree = page.getByRole("tree", { name: "图层" }),
      expand = page.getByRole("button", { name: "展开 Layer 0", exact: true });
    if (await expand.count()) await expand.click();
    await tree.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const row = page.getByRole("button", {
      name: "选择图层 Layer 1",
      exact: true,
    });
    await row.waitFor();
    const target = page.locator('[data-node-id="' + id + '"]');
    const selectMs = await sample(async () => {
      await row.click();
      await page.locator('[data-node-id="' + id + '"].selected').waitFor();
    });
    const mountedRows = await tree.getByRole("treeitem").count(),
      treeScroll = await tree.evaluate((el) => el.scrollTop);
    await page.locator(".editor-canvas").focus();
    await page.keyboard.press("Shift+2");
    const zoomMs = await sample(async () => {
      const zoom = await page
        .locator(".editor-canvas")
        .getAttribute("data-zoom");
      await page.getByTitle("缩小", { exact: true }).click();
      await page.waitForFunction(
        (z) => document.querySelector(".editor-canvas").dataset.zoom !== z,
        zoom,
      );
    });
    const rect = await target.boundingBox(),
      x = rect.x + rect.width / 2,
      y = rect.y + rect.height / 2;
    const previous = await target.evaluate((el) => el.style.left);
    const dragMs = await sample(async () => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 36, y + 16, { steps: 5 });
      await page.mouse.up();
    });
    if (previous === (await target.evaluate((el) => el.style.left)))
      throw Error("Actual layer drag failed, " + count);
    await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "选择图层 Layer 0", exact: true })
      .count();
    const nativeStart = performance.now(),
      native = page.waitForEvent("download");
    await page.getByRole("button", { name: "设计文件", exact: true }).click();
    await (await native).path();
    const nativeDownloadMs = Math.round(performance.now() - nativeStart);
    const exportStart = performance.now(),
      download = page.waitForEvent("download", { timeout: 45000 });
    await page.getByRole("button", { name: "导出 React 项目" }).click();
    await (await download).path();
    results.push({
      count,
      importMs,
      selectMs,
      mountedRows,
      treeScroll,
      zoomMs,
      dragMs,
      nativeDownloadMs,
      reactDownloadMs: Math.round(performance.now() - exportStart),
      heapMiB: await heap(),
    });
  }
  await session.detach();
  return results;
};
