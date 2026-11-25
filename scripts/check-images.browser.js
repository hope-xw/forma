async (page) => {
  const src = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 240;
    c.height = 120;
    const g = c.getContext("2d");
    g.fillStyle = "#ffd000";
    g.fillRect(0, 0, 120, 120);
    g.fillStyle = "#104dea";
    g.fillRect(120, 0, 120, 120);
    return c.toDataURL();
  });
  const first = page.locator('[data-node-type="frame"]').first();
  const frame = await first.getAttribute("data-node-id");
  const selectFrame = () =>
    page.locator('[data-layer-id="' + frame + '"] .layer-main').click();
  await selectFrame();
  await page.locator('input[type=file][accept^="image/png"]').setInputFiles({
    name: "crop.png",
    mimeType: "image/png",
    buffer: Buffer.from(src.split(",")[1], "base64"),
  });
  await page.getByLabel("图像适配").selectOption("cover");
  for (const [label, value] of [
    ["水平焦点", "75"],
    ["裁切倍率", "1.6"],
  ]) {
    const input = page.getByRole("spinbutton", { name: label });
    await input.fill(value);
    await input.press("Enter");
  }
  const check = async (attr) => {
    const img = page
      .locator("[" + attr + '="' + frame + '"] > span > img')
      .first();
    await img.waitFor();
    const result = await img.evaluate((el) => ({
      width: el.naturalWidth,
      position: getComputedStyle(el).objectPosition,
      scale: getComputedStyle(el).transform,
    }));
    if (
      result.width !== 240 ||
      result.position !== "75% 50%" ||
      !result.scale.startsWith("matrix(1.6")
    )
      throw Error(JSON.stringify(result));
    return result;
  };
  await check("data-node-id");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await check("data-design-id");
  await page.getByRole("button", { name: "关闭预览" }).click();
  await page.locator('[title="已保存到此浏览器"]').waitFor();
  await page.reload();
  await check("data-node-id");
  await selectFrame();
  const ticket = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 React 项目" }).click();
  await (await ticket).saveAs("output/playwright/image-check.zip");
  return { id: frame, asset: "240x120", zoom: 1.6, x: 75 };
};
