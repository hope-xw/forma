async (page) => {
  const sample = await page.evaluate(
    async () =>
      await (await fetch("/examples/mobile-studio.forma.json")).json(),
  );
  const atlas =
    sample.pages.find((p) => p.id === "atlas").nodes ?? sample.nodes;
  const set = page.locator('[data-testid="design-file-input"]'),
    cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const results = [];
  const afterPaint = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const percentile = (ns, p) =>
    ns.slice().sort((a, b) => a - b)[Math.ceil(ns.length * p) - 1];
  for (const copies of [1, 32]) {
    const nodes = [];
    for (let i = 0; i < copies; i++) {
      const prefix = "copy" + i + "-";
      for (const source of atlas) {
        const n = structuredClone(source);
        n.id = prefix + n.id;
        if (n.parentId) n.parentId = prefix + n.parentId;
        else {
          n.style.x += (i % 4) * 4400;
          n.style.y += Math.floor(i / 4) * 1900;
        }
        if (n.maskSourceId) n.maskSourceId = prefix + n.maskSourceId;
        for (const a of [
          ...(n.interaction?.actions ?? []),
          ...(n.interaction?.otherwise ?? []),
        ])
          if ("target" in a) a.target = prefix + a.target;
        nodes.push(n);
      }
    }
    const { pages: _pages, activePage: _active, ...doc } = sample;
    let start = performance.now();
    await set.setInputFiles({
      name: "atlas-load.forma.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          ...doc,
          id: "atlas-load-" + copies,
          name: "Atlas load " + copies,
          revision: 0,
          nodes,
        }),
      ),
    });
    const lastId = nodes.at(-1).id;
    const lastRoot = nodes.findLast((n) => !n.parentId).id;
    await page
      .locator(
        `[data-node-id="${lastId}"], [data-node-id="${lastRoot}"][data-lod="cached"]`,
      )
      .first()
      .waitFor({ state: "attached", timeout: 90000 });
    await afterPaint();
    const importMs = Math.round(performance.now() - start);
    const initialDomNodes = await page
      .locator(".canvas-world .design-node")
      .count();
    // Select an instance through the tree and keep screen coordinates stable between trials.
    const target = nodes.find((n) => n.instance);
    const id = target.id,
      selector = '[data-node-id="' + id + '"]';
    const tree = page.getByRole("tree", { name: "图层" });
    const search = page.getByRole("textbox", { name: "搜索图层", exact: true });
    await search.fill(target.name);
    // All 32 copies have the same layer names. Z order can change the first match.
    const row = tree.locator('[data-layer-id="' + id + '"] .layer-main');
    if (!(await row.count())) {
      await tree.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await afterPaint();
    }
    await row.click();
    await page.locator(".editor-canvas").focus();
    await page.keyboard.press("Shift+2");
    await page.locator(selector + ".selected").waitFor();
    const moveTimes = [],
      rafTimes = [];
    for (let j = 0; j < 6; j++) {
      const targetLayer = page.locator(selector),
        rr = await targetLayer.boundingBox();
      const x = rr.x + rr.width / 2,
        y = rr.y + rr.height / 2,
        sign = j % 2 ? -1 : 1;
      const old = await targetLayer.evaluate((el) => el.style.left);
      await page.evaluate(() => {
        const a = [];
        let prev = performance.now();
        const f = (t) => {
          a.push(t - prev);
          prev = t;
          window.__formaFrame = requestAnimationFrame(f);
        };
        window.__formaSamples = a;
        window.__formaFrame = requestAnimationFrame(f);
      });
      start = performance.now();
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + sign * 28, y + sign * 12, { steps: 12 });
      await page.mouse.up();
      await afterPaint();
      moveTimes.push(Math.round(performance.now() - start));
      if ((await targetLayer.evaluate((el) => el.style.left)) === old)
        throw Error("Instance did not move " + j);
      rafTimes.push(
        ...(await page.evaluate(() => {
          cancelAnimationFrame(window.__formaFrame);
          return window.__formaSamples.slice(1);
        })),
      );
    }
    await page
      .getByTitle("已保存到此浏览器", { exact: true })
      .waitFor({ timeout: 30000 });
    const heap = (await cdp.send("Performance.getMetrics")).metrics.find(
      (m) => m.name === "JSHeapUsedSize",
    ).value;
    results.push({
      layers: nodes.length,
      boards: nodes.filter((n) => !n.parentId).length,
      vectors: nodes.filter((n) => n.vector).length,
      instances: nodes.filter((n) => n.instance).length,
      importMs,
      initialDomNodes,
      dragSamplesMs: moveTimes,
      dragP50: percentile(moveTimes, 0.5),
      dragP95: percentile(moveTimes, 0.95),
      rafSamples: rafTimes.length,
      rafMax: Math.round(Math.max(...rafTimes)),
      rafOver25ms: rafTimes.filter((t) => t > 25).length,
      rafP50: Math.round(percentile(rafTimes, 0.5)),
      rafP95: Math.round(percentile(rafTimes, 0.95)),
      heapMiB: Math.round(heap / 1048576),
    });
  }
  await cdp.detach();
  return results;
};
