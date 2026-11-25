async (page) => {
  const { strict: assert } = await import("node:assert");
  const { readFile } = await import("node:fs/promises");
  const { strFromU8, unzipSync } = await import("fflate");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const label = (name) => page.getByLabel(name, { exact: true });
  const panel = page.locator(".assets-panel");
  const list = panel.locator(".assets-list");
  const basic = list.locator("details.basic-assets");
  const canvas = page.locator(".editor-canvas");
  const selected = canvas.locator(".design-node.selected");
  const node = (id) => canvas.locator('[data-node-id="' + id + '"]');
  const manager = page.getByRole("dialog", { name: "组件库管理", exact: true });
  const openManager = async (tab = "官方体系") => {
    await button("组件库管理").click();
    await manager.getByRole("tab", { name: tab, exact: true }).click();
  };
  const closeManager = async () => {
    await manager.getByLabel("关闭组件库管理", { exact: true }).click();
    await manager.waitFor({ state: "hidden" });
  };
  const enabledSwitch = (name) =>
    manager.getByRole("switch", { name: "启用 " + name, exact: true });
  const remove = (name) =>
    manager.getByRole("button", { name: "移除组件库 " + name, exact: true });
  const workspacePackage = manager
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: /工作区已保存组件库/ }),
    })
    .locator(".library-record")
    .filter({ has: page.getByText("企业演示库", { exact: true }) });
  const downloadFrom = async (control) => {
    const [file] = await Promise.all([
      page.waitForEvent("download"),
      control.click(),
    ]);
    return file;
  };
  const save = () =>
    page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  const official = [
    "Forma Mobile",
    "Material Design 3",
    "Ant Design 5",
    "shadcn/ui",
  ];

  const blank = async () => {
    const oldUrl = page.url();
    await page.getByTitle("新建空白文件", { exact: true }).click();
    await page.waitForURL(
      (url) => url.href !== oldUrl && !!url.searchParams.get("file"),
    );
    await canvas.waitFor();
    assert.equal(await canvas.locator("[data-node-id]").count(), 0);
    await button("资源").click();
  };
  const expandBasic = async () => {
    if (!(await basic.evaluate((el) => el.open)))
      await basic.locator("summary").click();
  };
  const selectLayer = async (id) => {
    await button("图层").click();
    await page
      .locator('[data-layer-id="' + id + '"]')
      .getByRole("button", { name: /^选择图层 / })
      .click();
    assert.equal(await selected.getAttribute("data-node-id"), id);
  };

  await page.setViewportSize({ width: 1280, height: 650 });
  await blank();
  await button("规范").click();
  const semantic = list.locator("section").filter({
    has: page.getByRole("heading", { name: "语义颜色", exact: true }),
  });
  const rows = semantic.locator(".foundation-token-row");
  const layout = {};
  for (const theme of ["dark", "light"]) {
    if ((await page.locator(".app").getAttribute("data-theme")) !== theme) {
      await button(theme === "dark" ? "切换深色主题" : "切换浅色主题").click();
    }
    await page.locator('.app[data-theme="' + theme + '"]').waitFor();
    await list.evaluate((el) => el.scrollTo(0, 0));
    const bounds = await list.boundingBox();
    const sticky = panel.locator(".assets-sticky-top");
    const header = await sticky.boundingBox();
    const footer = await page.locator(".left-panel .milestone").boundingBox();
    assert.equal(
      await list.evaluate((el) => getComputedStyle(el).display),
      "flex",
      theme,
    );
    const border = await sticky.evaluate((el) => {
      const css = getComputedStyle(el);
      return [
        css.borderBottomStyle,
        css.borderBottomWidth,
        css.borderBottomColor,
      ];
    });
    assert.equal(border[0], "solid", theme + " header border");
    assert.equal(border[1], "1px");
    assert.ok(!["transparent", "rgba(0, 0, 0, 0)"].includes(border[2]));
    assert.ok(header.y + header.height <= bounds.y + 1 && bounds.height > 0);
    assert.ok(
      footer.height > 0 &&
        bounds.y + bounds.height <= footer.y + 1 &&
        footer.y + footer.height <= 650,
      theme + " milestone overlaps or is clipped",
    );
    const edges = [];
    for (const locator of [
      semantic.getByRole("heading"),
      list.getByRole("heading", { name: "文字层级" }),
      basic.locator("summary"),
    ]) {
      edges.push((await locator.boundingBox()).x);
    }
    const indent = Math.max(...edges) - Math.min(...edges);
    assert.ok(indent <= 4, theme + " headings/summary left edges: " + edges);
    const metrics = await rows.evaluateAll((items) =>
      items.map((row) => {
        const swatch = row
          .querySelector(".token-swatch")
          .getBoundingClientRect();
        return {
          height: row.getBoundingClientRect().height,
          top: swatch.top,
          bottom: swatch.bottom,
          width: swatch.width,
        };
      }),
    );
    assert.ok(metrics.length >= 2, "Expected multiple semantic colors");
    const heights = metrics.map((row) => row.height);
    assert.ok(
      Math.min(...heights) >= 24 &&
        Math.max(...heights) <= 34 &&
        Math.max(...heights) - Math.min(...heights) <= 0.5,
      theme + " row heights: " + heights,
    );
    assert.ok(
      metrics.every((m) => m.width > 0 && m.bottom > m.top),
      "Missing swatch",
    );
    const gap = Math.min(
      ...metrics.slice(1).map((m, i) => m.top - metrics[i].bottom),
    );
    assert.ok(gap >= 2, theme + " minimum swatch gap: " + gap);
    await expandBasic();
    assert.equal(await basic.locator(".token-row").count(), 0);
    assert.equal(await basic.getByRole("button").count(), 5);
    for (const name of ["画板", "矩形", "椭圆", "文本", "按钮"]) {
      const item = basic.getByRole("button", { name, exact: true });
      assert.ok(
        await item.locator("svg").isVisible(),
        theme + " missing icon for " + name,
      );
      const { height } = await item.boundingBox();
      assert.ok(
        height > 0 && height <= 38,
        theme + " " + name + " height: " + height,
      );
    }
    await basic.getByRole("button", { name: "矩形" }).scrollIntoViewIfNeeded();
    assert.ok(
      await list.evaluate((el) => el.scrollTop > 0),
      "Expected the short panel to scroll",
    );
    assert.deepEqual(
      await sticky.boundingBox(),
      header,
      "Header moved with the list",
    );
    assert.deepEqual(
      await page.locator(".left-panel .milestone").boundingBox(),
      footer,
      "Footer moved with the list",
    );
    await list.evaluate((el) => el.scrollTo(0, 0));
    await page.mouse.move(660, 35);
    await page.screenshot({
      path: "output/playwright/assets-foundations-" + theme + ".png",
    });
    layout[theme] = {
      rowCount: metrics.length,
      rowHeight: heights[0],
      minSwatchGap: gap,
      indent,
    };
  }
  await basic.getByRole("button", { name: "矩形", exact: true }).click();
  const rectangle = await selected.getAttribute("data-node-id");
  const accent = rows.filter({ hasText: /#246bfd/i });
  const fill = (el) => getComputedStyle(el).backgroundColor;
  const originalFill = await node(rectangle).evaluate(fill);
  const accentColor = await accent.locator(".token-swatch").evaluate(fill);
  assert.notEqual(originalFill, accentColor);
  await accent.click();
  assert.equal(
    await node(rectangle).evaluate(fill),
    accentColor,
    "Semantic token did not recolor the selected rectangle",
  );

  await openManager();
  for (const [i, name] of official.entries()) {
    await manager.getByRole("heading", { name, exact: true }).waitFor();
    assert.equal(
      await enabledSwitch(name).isChecked(),
      i === 0,
      name + " default",
    );
  }
  await page.screenshot({
    path: "output/playwright/library-manager-official.png",
  });
  for (const name of official.slice(1)) {
    await enabledSwitch(name).check();
  }
  await closeManager();
  await label("规范体系").selectOption("forma-antd5-v1");
  await semantic
    .getByText(/^#1677ff$/i)
    .first()
    .waitFor();
  await button("组件").click();
  const search = label("搜索组件");
  const insert = async (query, name) => {
    await search.fill(query);
    await button("查看 " + name).click();
    const detail = page.getByRole("dialog", { name: "组件详情", exact: true });
    await detail.getByRole("button", { name: "插入组件", exact: true }).click();
    await detail.waitFor({ state: "hidden" });
    const id = await selected.getAttribute("data-node-id");
    await node(id).waitFor();
    return id;
  };
  const table = await insert("数据表格", "数据表格 Table");
  const fab = await insert("悬浮按钮", "悬浮按钮 FAB");
  const size = label("实例 Size");
  assert.notEqual(await size.inputValue(), "Extended");
  const width = await node(fab).evaluate((el) => el.offsetWidth);
  await size.selectOption("Extended");
  await node(fab).getByText("新建路线", { exact: true }).waitFor();
  assert.ok(
    (await node(fab).evaluate((el) => el.offsetWidth)) > width,
    "FAB variant did not expand",
  );
  const commandName = "Command 命令面板";
  const command = await insert("Command", commandName);
  assert.equal(new Set([rectangle, table, fab, command]).size, 4);
  await save();
  await page.reload();
  for (const id of [rectangle, table, fab, command])
    await node(id).waitFor({ state: "attached" });
  await selectLayer(fab);
  assert.equal(
    await size.inputValue(),
    "Extended",
    "FAB variant lost on reload",
  );
  await button("资源").click();
  await openManager();
  for (const name of official)
    assert.ok(
      await enabledSwitch(name).isChecked(),
      name + " not enabled after reload",
    );
  await manager
    .getByRole("tab", { name: "本文件与自定义", exact: true })
    .click();
  await remove("Ant Design 5").click();
  const rejection = manager.getByRole("alert");
  await rejection.waitFor();
  assert.match(await rejection.innerText(), /画布.*实例/);
  assert.match(await rejection.innerText(), /1\s*个/);
  await remove("Ant Design 5").waitFor();
  await closeManager();
  await selectLayer(command);
  await canvas.focus();
  await page.keyboard.press("Delete");
  await node(command).waitFor({ state: "detached" });
  await button("资源").click();
  await openManager("本文件与自定义");
  await remove("shadcn/ui").click();
  await remove("shadcn/ui").waitFor({ state: "detached" });
  await closeManager();
  await button("撤销").click();
  await openManager("本文件与自定义");
  await remove("shadcn/ui").waitFor();
  await closeManager();
  await button("撤销").click();
  await node(command).waitFor({ state: "attached" });

  await button("规范").click();
  await expandBasic();
  await basic.getByRole("button", { name: "矩形", exact: true }).click();
  const master = await selected.getAttribute("data-node-id");
  assert.notEqual(master, rectangle);
  await button("组件").click();
  await button("保存选区").click();
  await openManager("本文件与自定义");
  await manager
    .getByLabel("打包组件库名称", { exact: true })
    .fill("企业演示库");
  await manager
    .getByRole("button", { name: "打包并保存", exact: true })
    .click();
  await workspacePackage.waitFor();
  await closeManager();

  await label("文件菜单").click();
  const download = await downloadFrom(button("导出整个文件为 React 项目…"));
  const zipPath = "output/playwright/assets-libraries-check.zip";
  await download.saveAs(zipPath);
  const files = unzipSync(await readFile(zipPath));
  const design = JSON.parse(strFromU8(files["design.forma.json"]));
  const nodes =
    design.format === "forma/design-parts"
      ? design.records
          .filter((r) => r.kind === "page" && r.page === null)
          .flatMap((r) => r.nodes)
      : design.nodes;
  const pageSource = strFromU8(files["src/Page1.tsx"]);
  for (const [id, libraryId, componentId] of [
    [table, "forma-antd5-v1", "antd-table"],
    [fab, "forma-material3-v1", "m3-fab"],
    [command, "forma-shadcn-v1", "shadcn-command"],
  ]) {
    const instance = nodes.find((n) => n.id === id)?.instance;
    assert.equal(instance?.libraryId, libraryId, id + " library lost in ZIP");
    assert.equal(instance.componentId, componentId);
    if (id === fab) assert.match(instance.variantId, /Extended/);
    const module = Object.keys(files).find(
      (p) =>
        p.startsWith("src/components/" + componentId + "-") &&
        p.endsWith(".tsx"),
    );
    assert.ok(module, componentId + " React module missing");
    assert.ok(
      pageSource.includes("./" + module.slice(4, -4)),
      componentId + " module not used in exported page",
    );
  }
  assert.ok(nodes.some((n) => n.id === master));
  assert.ok(JSON.parse(strFromU8(files["package.json"])).scripts.build);
  await blank();
  await openManager("本文件与自定义");
  await workspacePackage.waitFor();
  const packageFile = await downloadFrom(
    workspacePackage.getByRole("button", { name: "导出 JSON", exact: true }),
  );
  const library = JSON.parse(await readFile(await packageFile.path(), "utf8"));
  assert.equal(library.format, "forma/library");
  assert.equal(library.name, "企业演示库");
  assert.equal(library.components.length, 1);
  const [packaged] = library.components;
  assert.equal(packaged.master, undefined);
  assert.equal(
    packaged.variants[0].nodes.find((n) => n.parentId === null)?.type,
    "rectangle",
  );
  // A same-revision file can contain just one previously used component. Drag
  // a different component from the real catalog into that file.
  await manager.getByRole("tab", { name: "官方体系", exact: true }).click();
  const materialCard = manager.locator("section").filter({
    has: page.getByRole("heading", { name: "Material Design 3", exact: true }),
  });
  const materialDownload = await downloadFrom(
    materialCard.getByRole("button", { name: "导出 JSON", exact: true }),
  );
  const partial = JSON.parse(
    await readFile(await materialDownload.path(), "utf8"),
  );
  partial.components = partial.components.filter((c) => c.id === "m3-button");
  assert.equal(partial.components.length, 1);
  await closeManager();
  await panel.locator('input[type=file][accept=".json"]').setInputFiles({
    name: "partial-material.forma-library.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(partial)),
  });
  await search.fill("悬浮按钮");
  await button("查看 悬浮按钮 FAB").dragTo(canvas, {
    targetPosition: { x: 100, y: 120 },
  });
  await selected.waitFor();
  assert.equal(
    await size.inputValue(),
    "Small",
    "Dragging a missing catalog component should insert the default FAB",
  );
  return {
    layout,
    official,
    instances: { table, fab, command },
    variant: "Extended",
    protectedLibrary: "Ant Design 5",
    restoredLibrary: "shadcn/ui",
    draggedFromPartialLibrary: "m3-fab",
    workspaceLibrary: "企业演示库",
    zipPath,
  };
};
