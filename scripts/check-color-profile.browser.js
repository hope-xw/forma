async (page) => {
  const button = (name) => page.getByRole("button", { name, exact: true });
  const open = async () => {
    await page.getByLabel("文件菜单", { exact: true }).click();
    await page.getByRole("button", { name: /^颜色配置 · / }).click();
  };
  const frame = page.locator('[data-node-type="frame"]').first();
  const id = await frame.getAttribute("data-node-id");
  const select = () =>
    page.locator('[data-layer-id="' + id + '"] .layer-main').click();
  const nested = frame.locator('[data-node-type="frame"]').first();
  const nestedId = await nested.getAttribute("data-node-id");
  await page.locator('[data-layer-id="' + nestedId + '"] .layer-main').click();
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const png = await readFile(
    path.join(
      process.env.INIT_CWD ?? process.cwd(),
      "scripts/fixtures/p3-red.png",
    ),
  );
  const bitmap = "data:image/png;base64," + png.toString("base64");
  if (!png.includes(Buffer.from("iCCP")) && !png.includes(Buffer.from("cICP")))
    throw Error("测试输入缺少色域标记");
  await page
    .locator('input[type=file][accept^="image/png"]')
    .setInputFiles({ name: "p3-red.png", mimeType: "image/png", buffer: png });
  await nested.locator("img").waitFor();
  await select();
  const hex = page.getByLabel("填充 HEX", { exact: true });
  await hex.fill("FF0000");
  await hex.press("Enter");
  const paint = async (el) =>
    el.evaluate((n) => {
      const css = getComputedStyle(n).backgroundColor;
      const ctx = document
        .createElement("canvas")
        .getContext("2d", { colorSpace: "display-p3" });
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      return {
        css,
        bufferSpace: ctx.getContextAttributes?.().colorSpace ?? "unknown",
        bytes: Array.from(
          ctx.getImageData(0, 0, 1, 1, { colorSpace: "display-p3" }).data,
        ),
      };
    });
  const original = await paint(frame);
  const same = (a, b, tolerance = 0) =>
    a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
  const expect = (value, message) => {
    if (!value) throw Error(message);
  };
  await open();
  await page
    .getByRole("combobox", { name: "文件色域", exact: true })
    .selectOption("display-p3");
  await button("应用").click();
  const assigned = await paint(frame);
  expect(
    (await hex.inputValue()) === "FF0000" &&
      assigned.css.includes("display-p3") &&
      (original.bufferSpace === "srgb" ||
        !same(original.bytes, assigned.bytes, 3)),
    "指定未保留数值或没有改变渲染",
  );
  await button("撤销").click();
  expect((await paint(frame)).css === original.css, "撤销没有恢复 sRGB");
  await open();
  await page
    .getByRole("combobox", { name: "文件色域", exact: true })
    .selectOption("display-p3");
  await page.getByLabel("转换 · 尽量保持外观").check();
  await page
    .getByRole("combobox", { name: "新建文件默认色域", exact: true })
    .selectOption("display-p3");
  await page
    .getByRole("dialog", { name: "颜色配置" })
    .screenshot({ path: "output/playwright/color-profile-dialog.png" });
  await button("应用").click();
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="填充 HEX"]')?.value ===
      "EA3323",
    undefined,
    { timeout: 5000 },
  );
  const converted = await paint(frame);
  expect(
    (await hex.inputValue()) === "EA3323" &&
      same(original.bytes, converted.bytes, 1),
    "转换未保留外观 " +
      JSON.stringify({ original, converted, hex: await hex.inputValue() }),
  );
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  await select();
  expect(
    (await paint(frame)).css === converted.css &&
      (await hex.inputValue()) === "EA3323",
    "重开丢失色域",
  );
  await button("预览").click();
  const preview = await paint(
    page.locator('[data-design-id="' + id + '"]').first(),
  );
  const image = page.locator('[data-design-id="' + nestedId + '"] img');
  if ((await image.getAttribute("src")) !== bitmap)
    throw Error("重开或预览改写了原图");
  expect(preview.css === converted.css, "预览色域不同");
  await button("关闭预览").click();
  const download = async (name) => {
    const pending = page.waitForEvent("download");
    await button("导出 React 项目").click();
    await (await pending).saveAs("output/playwright/" + name + "-check.zip");
  };
  await download("color-profile");
  await open();
  await page
    .getByRole("combobox", { name: "React 导出色域", exact: true })
    .selectOption("srgb");
  await button("应用").click();
  await download("color-profile-srgb");
  expect((await paint(frame)).css === converted.css, "覆盖导出色域改写画布");
  await button("新建空白文件").click();
  await page.waitForURL(/file=forma\.file\./);
  await open();
  expect(
    (await page
      .getByRole("combobox", { name: "文件色域", exact: true })
      .inputValue()) === "display-p3",
    "新文件未采用偏好",
  );
  await button("取消").click();
  return {
    original,
    assigned,
    converted,
    preview,
    bitmap: "8×8 P3 PNG",
    convertedHex: "EA3323",
    exports: ["file", "srgb"],
    newFile: "display-p3",
  };
};
