async (page) => {
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  const url = new URL(page.url());
  url.search =
    "?example=mobile-studio&edition=atlas&page=atlas&node=atlas-tablet-root";
  await page.goto(url.toString());
  const b = (name) => page.getByRole("button", { name, exact: true });
  const root = page.locator(".selected[data-node-id=atlas-tablet-root]");
  await root.waitFor();
  const chrome = await page.evaluate(() => {
    const h = document.querySelector("header").getBoundingClientRect(),
      logo = document.querySelector("summary.brand").getBoundingClientRect();
    return logo.top >= h.top && logo.bottom <= h.bottom;
  });
  if (!chrome) throw Error("Brand clipped by header");
  await page.screenshot({ path: "output/playwright/field-atlas-editor.png" });
  await b("预览").click();
  const design = (id) => page.locator('[data-design-id="' + id + '"]');
  await design("atlas-tablet-open").click();
  await design("atlas-note-root").waitFor();
  await design("atlas-note-share").click();
  await page.getByRole("dialog", { name: "路线分享 · 浮层" }).waitFor();
  await design("atlas-sheet-close").click();
  await design("atlas-note-back").click();
  await design("atlas-tablet-root").waitFor();
  await page.getByLabel("预览流程").selectOption("atlas-phone-root");
  await design("atlas-phone-root").waitFor();
  await page.screenshot({ path: "output/playwright/field-atlas-phone.png" });
  await b("关闭预览").click();
  const ticket = page.waitForEvent("download");
  await b("导出 React 项目").click();
  await (await ticket).saveAs("output/playwright/atlas-check.zip");
  await page.getByLabel("文件菜单", { exact: true }).click();
  const whole = page.waitForEvent("download");
  await b("导出整个文件为 React 项目…").click();
  await (await whole).saveAs("output/playwright/studio-file-check.zip");
  await page.getByRole("button", { name: /01 iPad/ }).click();
  await b("选择图层 分栏导航 · Light").click();
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("Shift+2");
  await page.locator("[data-node-id=studio-overview-root]").waitFor();
  await page.screenshot({
    path: "output/playwright/studio-manual-current.png",
  });
  return {
    pages: await page.locator(".file-page").count(),
    mapFlow: true,
    phoneFlow: true,
    shareOverlay: true,
    brandInHeader: chrome,
  };
};
