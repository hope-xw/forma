async (page) => {
  const { strict: assert } = await import("node:assert");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const canvas = page.locator(".editor-canvas");
  await button("新建页面").click();
  await button("新建页面").click();
  const pages = page.locator(".file-page");
  const names = () => pages.locator(".page-name").allTextContents();
  const original = await names();
  const dropPage = async (origin, target, bottom) => {
    const source = pages.filter({ has: button(origin) });
    const dest = pages.filter({ has: button(target) });
    const rect = await dest.boundingBox();
    await source.dragTo(dest, {
      sourcePosition: { x: 10, y: 8 },
      targetPosition: { x: 20, y: bottom ? rect.height - 3 : 3 },
    });
  };
  await dropPage(original[0], original[1], true);
  assert.deepEqual(await names(), [original[1], original[0], original[2]]);
  await dropPage(original[0], original[1], false);
  assert.deepEqual(await names(), original);
  const clicked = pages.locator('[aria-current="page"]');
  assert.equal(await clicked.textContent(), original[2]);
  await button("资源").click();
  const cards = page.locator(".component-card");
  await cards.first().waitFor();
  const assetNames = await cards.evaluateAll((els) =>
    els.slice(0, 2).map((el) => el.getAttribute("aria-label")),
  );
  const inserted = [];
  for (const [i, name] of assetNames.entries()) {
    await button(name).dragTo(canvas, {
      targetPosition: { x: 85 + i * 225, y: 110 + i * 145 },
    });
    await page.waitForFunction(
      (last) => {
        const id = document
          .querySelector(".design-node.selected")
          ?.getAttribute("data-node-id");
        return id && id !== last;
      },
      inserted.at(-1) || "",
    );
    inserted.push(
      await page.locator(".design-node.selected").getAttribute("data-node-id"),
    );
  }
  assert.equal(new Set(inserted).size, 2);
  await button("图层").click();
  await button(original[0]).click();
  await button("预览").click();
  const mode = page.getByLabel("缩放模式", { exact: true });
  const stage = page.locator(".runtime-stage");
  const art = () => page.locator(".runtime-stage [data-design-id]").first();
  await art().waitFor();
  const active = await art().getAttribute("data-design-id");
  const width = async () => (await art().boundingBox()).width;
  await mode.selectOption("100");
  const intrinsic = await width();
  await mode.selectOption("fill");
  const area = await stage.evaluate(
    (el) =>
      el.clientWidth -
      parseFloat(getComputedStyle(el).paddingLeft) -
      parseFloat(getComputedStyle(el).paddingRight),
  );
  const filled = await width();
  assert.ok(
    Math.abs(filled - area) < 2,
    JSON.stringify({ filled, area, intrinsic }),
  );
  await mode.selectOption("fit");
  assert.ok((await width()) <= intrinsic + 1);
  await button("关闭预览").click();
  await page.locator('[data-layer-id="' + active + '"] .layer-main').click();
  await button("变量与样式").click();
  const ds = page.locator(".ds-dialog");
  const db = (name) => ds.getByRole("button", { name, exact: true });
  const df = (name) => ds.getByLabel(name, { exact: true });
  await db("样式").click();
  await db("新建样式").click();
  await df("填充类型").selectOption("linear");
  await df("色标 1 HEX").fill("112244");
  await df("色标 1 HEX").press("Enter");
  await db("添加填充层").click();
  await df("填充层 1 HEX").fill("BB448080");
  await df("填充层 1 HEX").press("Enter");
  await db("应用样式").click();
  const painted = page.locator('[data-node-id="' + active + '"]');
  const bg = await painted.evaluate(
    (el) => getComputedStyle(el).backgroundImage,
  );
  assert.ok(bg.includes("17, 34, 68") && bg.includes("187, 68, 128"), bg);
  await df("新建样式类型").selectOption("effect");
  await db("新建样式").click();
  await db("添加样式阴影").click();
  const shadows = ds.locator(".style-shadow");
  const count = await shadows.count();
  await db("删除样式阴影 " + count).click();
  assert.equal(await shadows.count(), count - 1);
  await ds.focus();
  await page.keyboard.press("Escape");
  await button("切换图层锁定").click();
  assert.ok(await page.getByLabel("paint样式", { exact: true }).isDisabled());
  assert.ok(await button("解除paint样式").isDisabled());
  assert.ok(await button("独立圆角").isDisabled());
  assert.ok(
    await page.getByLabel("跟随视口宽度", { exact: true }).isDisabled(),
  );
  await button("切换图层锁定").click();
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  await page.locator('[data-node-id="' + active + '"]').waitFor();
  assert.equal(
    await painted.evaluate((el) => getComputedStyle(el).backgroundImage),
    bg,
  );
  return {
    styleGradientAndStack: true,
    lockedBindings: true,
    styleShadowAddRemove: true,
    reopenedAppearance: true,
    pageDropSides: true,
    activePage: original[2],
    insertedAssets: assetNames,
    preview: { active, intrinsic, filled, area },
  };
};
