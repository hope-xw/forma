async (page) => {
  const { strict: assert } = await import("node:assert");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const input = (label) =>
    page.getByRole("textbox", { name: label, exact: true });
  const edges = ["左边距", "上边距", "右边距", "下边距"];
  const matrix = page.getByRole("group", { name: "容器内对齐" });
  const between = button("两端对齐间距 (Space between)");
  const toggle = button("独立内边距");
  const panel = page.locator("#right-panel");
  const separator = page.getByRole("separator", { name: "属性栏宽度" });
  const values = () =>
    Promise.all(edges.map((edge) => input(edge).inputValue()));
  const set = async (name, value) => {
    await input(name).fill(value);
    await input(name).press("Enter");
  };
  const sample = new URL(
    "?example=aura-showcase&page=workspace&node=ws-deploy-modal",
    page.url(),
  );
  await page.setViewportSize({ width: 1460, height: 960 });
  await page.goto(sample.href);
  await matrix.waitFor();
  assert.equal(await input("宽度").inputValue(), "440");
  assert.equal(await input("高度").inputValue(), "410");
  assert.equal(await input("间距").inputValue(), "16");
  assert.deepEqual(await values(), ["24", "24", "24", "24"]);
  const dimensions = [];
  async function measure() {
    await matrix.scrollIntoViewIfNeeded();
    const box = async (loc) => {
      const b = await loc.boundingBox();
      assert.ok(b);
      return b;
    };
    const [anchor, flow, gap, mode, split, ...sides] = await Promise.all(
      [
        matrix,
        panel.locator(".flow-settings"),
        input("间距").locator(".."),
        between,
        toggle,
        ...edges.map((s) => input(s).locator("..")),
      ].map(box),
    );
    const near = (a, b) =>
      assert.ok(Math.abs(a - b) < 1.1, JSON.stringify({ a, b }));
    near(anchor.y, flow.y);
    near(gap.y + gap.height / 2, mode.y + mode.height / 2);
    assert.ok(gap.x >= anchor.x + anchor.width && mode.x >= gap.x + gap.width);
    near(sides[0].y, sides[1].y);
    near(sides[2].y, sides[3].y);
    near(sides[0].x, sides[2].x);
    near(sides[1].x, sides[3].x);
    near(sides[0].x, anchor.x);
    near(split.y + split.height / 2, sides[0].y + sides[0].height / 2);
    assert.ok(
      sides[0].y >= anchor.y + anchor.height &&
        sides[2].y >= sides[0].y + sides[0].height,
    );
    assert.ok(
      sides[1].x >= sides[0].x + sides[0].width &&
        split.x >= sides[1].x + sides[1].width,
    );
    assert.ok(
      split.x + split.width <= flow.x + flow.width + 1 && flow.height <= 132,
    );
    assert.ok(
      await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    );
    dimensions.push({
      width: Math.round((await box(panel)).width),
      height: Math.round(flow.height),
      theme: await page.locator(".app").getAttribute("data-theme"),
    });
  }
  await measure();
  await separator.press("Home");
  await measure();
  await separator.press("End");
  await measure();
  const theme = await page.locator(".app").getAttribute("data-theme");
  await button(theme === "light" ? "切换深色主题" : "切换浅色主题").click();
  await separator.press("Home");
  await page.setViewportSize({ width: 721, height: 480 });
  await page
    .locator('button[aria-controls="right-panel"][aria-expanded="false"]')
    .click();
  await measure();
  await toggle.scrollIntoViewIfNeeded();
  await input("下边距").focus();
  await page.keyboard.press("Tab");
  assert.ok(await toggle.evaluate((el) => el === document.activeElement));
  await page.setViewportSize({ width: 1460, height: 960 });
  await set("左边距", "36");
  assert.deepEqual(await values(), ["36", "24", "24", "24"]);
  const frame = page.locator('[data-node-id="ws-deploy-modal"]');
  const live = (property) =>
    frame.evaluate((el, k) => getComputedStyle(el)[k], property);
  assert.equal(await live("paddingLeft"), "36px");
  await button("撤销").click();
  assert.deepEqual(await values(), ["24", "24", "24", "24"]);
  await toggle.click();
  assert.equal(await input("内边距").inputValue(), "24");
  assert.equal(await live("paddingLeft"), "24px");
  await toggle.click();
  await matrix.getByRole("button", { name: "下右对齐" }).click();
  assert.equal(await button("下右对齐").getAttribute("aria-pressed"), "true");
  assert.equal(await live("alignItems"), "end");
  await between.click();
  assert.equal(await live("justifyContent"), "space-between");
  await between.click();
  await button("水平排列").click();
  await button("自动换行").click();
  await set("行间距", "18");
  assert.equal(await live("rowGap"), "18px");
  await button("网格布局").click();
  await panel.locator(".track-editor summary").click();
  await button("添加列轨道").click();
  assert.equal(await panel.locator(".track-editor .track-row").count(), 3);
  assert.ok(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
  await button("垂直排列").click();
  const other = button("选择图层 Aura Analytics · 产品工作台 (1440×900)");
  await other.click({ modifiers: ["Meta"] });
  assert.equal(await toggle.getAttribute("aria-pressed"), "mixed");
  assert.equal(await input("左边距").getAttribute("placeholder"), "Mixed");
  await set("左边距", "32");
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  assert.equal(await input("左边距").inputValue(), "32");
  assert.equal(await input("右边距").inputValue(), "");
  await button("撤销").click();
  assert.equal(await toggle.getAttribute("aria-pressed"), "mixed");
  const select = button("选择图层 新建部署任务 · 浮层");
  await select.click();
  const layer = select.locator("xpath=ancestor::*[@role='treeitem'][1]");
  await layer.getByRole("button", { name: "锁定图层" }).click();
  for (const ctl of [
    button("水平排列"),
    between,
    toggle,
    input("左边距"),
    button("下右对齐"),
  ])
    assert.ok(await ctl.isDisabled());
  await layer.getByRole("button", { name: "解锁图层" }).click();
  await set("下边距", "28");
  await page
    .getByTitle("已保存到此浏览器", { exact: true })
    .waitFor({ state: "attached" });
  await page.reload();
  assert.deepEqual(await values(), ["24", "24", "24", "28"]);
  assert.equal(await live("paddingBottom"), "28px");
  const reloadedInsets = await values();
  await toggle.click();
  assert.equal(await input("内边距").inputValue(), "24");
  await button("撤销").click();
  assert.deepEqual(await values(), reloadedInsets);
  // A common override can differ from the spacing variable underneath it.
  const fixture = {
    id: "bound-inset-test",
    name: "Bound spacing",
    schemaVersion: 1,
    revision: 0,
    tokens: {},
    nodes: [
      {
        id: "board",
        name: "Bound board",
        type: "frame",
        parentId: null,
        text: "",
        hidden: false,
        locked: false,
        variableBindings: { padding: "space", gap: "space" },
        style: {
          x: 0,
          y: 0,
          width: 440,
          height: 410,
          layout: "column",
          fill: "#ffffff",
          color: "#111111",
          radius: 0,
          fontSize: 16,
          padding: 0,
          gap: 16,
          insets: { left: 24, top: 24, right: 24, bottom: 24 },
        },
      },
    ],
    designSystem: {
      collections: {
        spacing: {
          id: "spacing",
          name: "Spacing",
          defaultModeId: "base",
          modes: [{ id: "base", name: "Base" }],
        },
      },
      variables: {
        space: {
          id: "space",
          collectionId: "spacing",
          name: "Spacing/container",
          type: "number",
          values: { base: 12 },
        },
      },
      styles: {},
      activeModes: { spacing: "base" },
    },
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "bound-spacing.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(fixture)),
  });
  await button("选择图层 Bound board").click();
  await toggle.click();
  assert.equal(await input("内边距").inputValue(), "12");
  assert.ok(await button("解除变量 padding").isEnabled());
  assert.ok(await button("解除变量 gap").isEnabled());
  await toggle.click();
  assert.deepEqual(await values(), ["12", "12", "12", "12"]);
  return { dimensions, reloadedInsets, restoredBoundPadding: 12 };
};
