async (page) => {
  const editor = await page.locator(".editor-canvas").count();
  const button = (name) => page.getByRole("button", { name, exact: true });
  if (editor) {
    await page.goto(new URL("?example=aura-showcase", page.url()).href);
    const theme = page.getByLabel("模式 Theme", { exact: true });
    await theme.selectOption("light");
    const bg = await page
      .locator("[data-node-id=mkt-desktop]")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    if (bg !== "rgb(247, 248, 252)") throw Error("Aura light canvas " + bg);
    await button("选择图层 Aura Studio · 营销官网 (Desktop)").click();
    const bp = page.locator(".breakpoint-editor");
    await bp.locator("summary").click();
    await button("添加断点").click();
    if (await page.getByLabel("断点 1 列数", { exact: true }).count())
      throw Error("Free frame offers inactive grid controls");
    const hex = page.getByLabel("断点 1 填充 HEX", { exact: true });
    await hex.fill("F0F4FD");
    await hex.press("Enter");
    const native = page.waitForEvent("download");
    await button("设计文件").click();
    await (await native).saveAs("output/playwright/aura-responsive.forma.json");
    await button("预览").click();
  }
  const layer = (id) => page.locator('[data-design-id="' + id + '"]');
  const bg = await layer("mkt-desktop").evaluate((el) => {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.fillStyle = getComputedStyle(el).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data].join(",");
  });
  if (bg !== "247,248,252,255") throw Error("Aura light runtime " + bg);
  for (const [width, color] of [
    [768, "240,244,253,255"],
    [1440, "247,248,252,255"],
  ]) {
    if (editor)
      await page.getByLabel("预览视口宽度").selectOption(String(width));
    else await page.setViewportSize({ width, height: 900 });
    await page
      .waitForFunction(
        ({ width, color }) => {
          const el = document.querySelector('[data-design-id="mkt-desktop"]');
          if (el?.offsetWidth !== width) return false;
          const ctx = document.createElement("canvas").getContext("2d");
          ctx.fillStyle = getComputedStyle(el).backgroundColor;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data].join(",") === color;
        },
        { width, color },
        { timeout: 5000 },
      )
      .catch(async () => {
        throw Error(
          "Aura range " +
            width +
            " actual " +
            JSON.stringify(
              await layer("mkt-desktop").evaluate((el) => [
                el.offsetWidth,
                getComputedStyle(el).backgroundColor,
                el.style.background,
                el.style.width,
              ]),
            ),
        );
      });
  }
  await layer("mkt-cta-secondary").click();
  await layer("mkt-mob-cta").click();
  await layer("ws-brand-row").click();
  await layer("mkt-cta-primary").click();
  await layer("ws-new-deploy").click();
  await layer("ws-modal-cancel").click();
  await layer("ws-deploy-modal").waitFor({ state: "hidden" });
  await layer("ws-brand-row").click();
  await layer("mkt-desktop").waitFor();
  if (editor) {
    await button("关闭预览").click();
    await page.getByLabel("文件菜单", { exact: true }).click();
    await button("浏览本机文件…").click();
    await page.getByRole("link", { name: /Aura Studio/ }).click();
    await page.getByLabel("模式 Theme", { exact: true }).waitFor();
    if (
      (await page.getByLabel("模式 Theme", { exact: true }).inputValue()) !==
      "light"
    )
      throw Error("recent file lost mode");
    await button("选择图层 Aura Studio · 营销官网 (Desktop)").click();
    const ticket = page.waitForEvent("download");
    await button("导出 React 项目").click();
    await (await ticket).saveAs("output/playwright/aura-check.zip");
  }
  return {
    theme: "Cloud Light",
    mobileFlow: true,
    navigation: "marketing → workspace → overlay → workspace → marketing",
  };
};
