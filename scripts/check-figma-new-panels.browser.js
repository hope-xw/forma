async (page) => {
  const { strict: assert } = await import("node:assert");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const canvas = page.locator(".editor-canvas");
  const saved = () =>
    page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();

  await saved();

  // 1. 04.01 Collapsible Frame Presets (手机 open, 智能手表/打印纸张/社交媒体 present)
  await canvas.focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("f");
  await page.getByText("画板预设", { exact: true }).waitFor();
  const presetSummaries = await page
    .locator(".preset-category > summary")
    .allInnerTexts();
  assert.ok(presetSummaries.some((s) => s.includes("手机")));
  assert.ok(presetSummaries.some((s) => s.includes("智能手表")));
  assert.ok(presetSummaries.some((s) => s.includes("打印纸张")));
  assert.ok(presetSummaries.some((s) => s.includes("社交媒体")));
  await page.keyboard.press("v");

  // 2. 03.08 Canvas Section (Shift+S -> Enter) + Ready for dev badge
  await canvas.focus();
  await page.keyboard.press("Shift+S");
  await page.keyboard.press("Enter");
  const sectionNode = page
    .locator('.design-node[data-node-type="section"]')
    .first();
  await sectionNode.waitFor();
  const sectionId = await sectionNode.getAttribute("data-node-id");
  await page
    .locator(`.section-title-pill[data-section-label-id="${sectionId}"]`)
    .waitFor();

  // 3. 03.10 Slice (S -> Enter) + 04.21 Batch Export (Shift+Meta/Ctrl+E)
  await canvas.focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("s");
  await page.keyboard.press("Enter");
  const sliceNode = page
    .locator('.design-node[data-node-type="slice"]')
    .first();
  await sliceNode.waitFor();
  await sliceNode.locator(".slice-badge-pill").waitFor();
  await page.keyboard.press(
    process.platform === "darwin" ? "Shift+Meta+e" : "Shift+Control+e",
  );
  const batchDialog = page.getByRole("dialog", { name: /批量导出/ });
  await batchDialog.waitFor();
  assert.ok((await batchDialog.innerText()).includes("切片"));
  await page.keyboard.press("Escape");
  await batchDialog.waitFor({ state: "hidden" });

  // 4. Select first frame -> 04.20 Layout Guides + 03.09 Scale Tool K + 04.09 Contrast Checker
  const frame = page.locator('.design-node[data-node-type="frame"]').first();
  const frameId = await frame.getAttribute("data-node-id");
  await page.locator(`[data-layer-id="${frameId}"] .layer-main`).click();
  const boxBefore = await frame.boundingBox();
  assert.ok(boxBefore && boxBefore.width > 10);

  // Add Layout Guide
  await page.getByRole("button", { name: "添加布局参考网格" }).click();
  await frame.locator(".layout-guides-overlay").waitFor();

  // 04.09 Color Picker WCAG contrast checker
  await button("编辑填充颜色").click();
  await page
    .getByText(/AA|AAA|未通过/)
    .first()
    .waitFor();
  await button("关闭颜色选择器").click();

  // 03.09 Scale Tool K (2x proportional scale -> undo restores)
  await canvas.focus();
  await page.keyboard.press("k");
  await page.getByRole("button", { name: "2×", exact: true }).click();
  await page.getByRole("button", { name: /应用等比缩放/ }).click();
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  const boxAfterScale = await frame.boundingBox();
  assert.ok(
    boxAfterScale && Math.abs(boxAfterScale.width / boxBefore.width - 2) < 0.15,
    `Expected ~2x width, got ${boxBefore.width} -> ${boxAfterScale?.width}`,
  );
  await button("撤销").click();
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  const boxAfterUndo = await frame.boundingBox();
  assert.ok(
    boxAfterUndo && Math.abs(boxAfterUndo.width - boxBefore.width) < 2,
    "Scale undo failed",
  );
  await page.keyboard.press("v");

  // 5. 03.11 View Options Menu (Outline Mode + Pixel Grid)
  await button("缩放与视图选项").click();
  await page.getByRole("menuitemcheckbox", { name: /轮廓线框视图/ }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".editor-canvas")
      ?.classList.contains("is-outline-mode"),
  );
  await page.getByRole("menuitemcheckbox", { name: /轮廓线框视图/ }).click();
  await page.keyboard.press("Escape");

  // 6. 04.22 Design Lint (Check designs)
  await page
    .locator("header")
    .getByRole("button", { name: "设计规范校验", exact: true })
    .click();
  const lintDialog = page.getByRole("dialog", { name: /设计规范校验/ });
  await lintDialog.waitFor();
  await page.keyboard.press("Escape");
  await lintDialog.waitFor({ state: "hidden" });

  // 7. 06.04 Canvas Comments (C tool -> click canvas -> pin appears)
  await canvas.focus();
  await page.keyboard.press("c");
  const stageBox = await canvas.boundingBox();
  assert.ok(stageBox);
  await page.mouse.click(stageBox.x + 220, stageBox.y + 180);
  await page.locator(".fp-comment-pin").first().waitFor();
  await page.keyboard.press("v");

  // 8. 07.04 Dev Mode (Shift+D -> Box Model + CSS/Tailwind/React + Annotations)
  await page.locator(`[data-layer-id="${frameId}"] .layer-main`).click();
  await canvas.focus();
  await page.keyboard.press("Shift+D");
  await page.getByText("开发检查 (Dev Mode)", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Tailwind" }).click();
  await page.getByRole("tab", { name: "React TSX" }).click();
  await page.getByRole("button", { name: "rem", exact: true }).click();
  await button("退出开发模式").click();

  await saved();
  return {
    presetGroups: presetSummaries.length,
    section: true,
    sliceAndBatchExport: true,
    layoutGuides: true,
    wcagContrast: true,
    scaleTool2xUndo: true,
    outlineMode: true,
    designLint: true,
    comments: true,
    devMode: true,
  };
};
