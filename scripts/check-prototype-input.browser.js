async (page, { touch = false } = {}) => {
  const { strict: assert } = await import("node:assert");
  const editing = !!(await page.locator(".editor-canvas").count());
  const button = (name) => page.getByRole("button", { name, exact: true });
  const layer = (id) => page.locator('[data-design-id="' + id + '"]');
  if (editing) {
    const base = {
      x: 0,
      y: 0,
      width: 320,
      height: 200,
      fill: "#f1f2f6",
      color: "#111111",
      radius: 0,
      fontSize: 16,
      padding: 0,
      gap: 0,
      layout: "free",
    };
    const n = (id, parentId, style = {}, extra = {}) => ({
      id,
      parentId,
      name: id,
      type: "frame",
      text: "",
      hidden: false,
      locked: false,
      style: { ...base, ...style },
      ...extra,
    });
    const rule = (kind, target) => ({
      actions: [
        { kind, target, ...(kind === "overlay" ? { position: "center" } : {}) },
      ],
    });
    const fixture = {
      id: "input-matrix",
      name: "Touch and keyboard",
      schemaVersion: 1,
      revision: 0,
      tokens: {},
      nodes: [
        n("Home", null, {}, { interaction: { flow: "Main" } }),
        n(
          "HoverCard",
          "Home",
          { width: 240, height: 80 },
          {
            interaction: { trigger: "hover", ...rule("overlay", "HoverSheet") },
          },
        ),
        n(
          "Details",
          "HoverCard",
          { x: 16, y: 12, width: 140, height: 44 },
          {
            type: "button",
            text: "Details",
            interaction: rule("navigate", "Detail"),
          },
        ),
        n(
          "Counter",
          "Home",
          { x: 16, y: 100, width: 160, height: 44 },
          {
            control: {
              kind: "stepper",
              label: "件数",
              value: 0,
              min: 0,
              max: 3,
              step: 1,
            },
            interaction: rule("overlay", "Sheet"),
          },
        ),
        n("Detail", null, { x: 360 }),
        n(
          "GoBack",
          "Detail",
          { x: 12, y: 16, width: 100, height: 44 },
          {
            type: "button",
            text: "Back",
            interaction: { actions: [{ kind: "back" }] },
          },
        ),
        n("Sheet", null, { x: 730, width: 240, height: 120 }),
        n(
          "More",
          "Sheet",
          { x: 12, y: 12, width: 100, height: 44 },
          {
            type: "button",
            text: "More",
            interaction: rule("overlay", "Inner"),
          },
        ),
        n("Inner", null, { x: 1010, width: 200, height: 80 }),
        n(
          "Done",
          "Inner",
          { x: 12, y: 12, width: 100, height: 44 },
          {
            type: "button",
            text: "Done",
            interaction: { actions: [{ kind: "close" }] },
          },
        ),
        n("HoverSheet", null, { x: 1250, width: 200, height: 100 }),
        n(
          "Hide",
          "HoverSheet",
          { width: 120, height: 44 },
          {
            type: "button",
            text: "Hide",
            interaction: { actions: [{ kind: "close" }] },
          },
        ),
      ],
    };
    await page.locator('[data-testid="design-file-input"]').setInputFiles({
      name: "input.forma.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
    await button("选择图层 Home").click();
    await button("预览").click();
  }
  if (touch) {
    await layer("Details").tap();
    await layer("GoBack").waitFor({ timeout: 3500 });
    await layer("GoBack").tap();
    await layer("Home").waitFor();
  }
  const outside = await page.evaluate(() => ({
    x: innerWidth - 1,
    y: innerHeight - 1,
  }));
  await page.mouse.move(outside.x, outside.y);
  await layer("HoverCard").hover({ position: { x: 3, y: 3 } });
  await layer("HoverSheet").waitFor();
  await page.keyboard.press("Escape");
  await layer("HoverSheet").waitFor({ state: "detached" });
  const increase = button("件数 增加");
  await increase.focus();
  await increase.press("Space");
  const sheet = page.getByRole("dialog", { name: "Sheet", exact: true });
  await sheet.waitFor();
  await page.keyboard.press("Tab");
  assert.ok(
    await layer("More").evaluate((el) => el === document.activeElement),
  );
  await page.keyboard.press("Enter");
  await layer("Inner").waitFor();
  await page.keyboard.press("Shift+Tab");
  assert.ok(
    await layer("Done").evaluate((el) => el === document.activeElement),
  );
  await page.keyboard.press("Enter");
  await layer("Inner").waitFor({ state: "detached" });
  assert.ok(
    await layer("More").evaluate((el) => el === document.activeElement),
  );
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "件数 增加",
  );
  if (touch) {
    await increase.tap();
    await layer("More").tap();
    await layer("Done").tap();
    await sheet.waitFor();
    await page.keyboard.press("Escape");
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
      "件数 增加",
    );
  }
  if (editing) {
    await button("关闭预览").click();
    const ticket = page.waitForEvent("download");
    await button("导出 React 项目").click();
    await (await ticket).saveAs("output/playwright/prototype-input-check.zip");
  }
  return {
    touch,
    mouseHover: true,
    nestedKeyboard: true,
    restored: "件数 增加",
  };
};
