async (page) => {
  const field = page.getByRole("textbox", { name: "文件名" });
  const saved = () => page.locator('[title="已保存到此浏览器"]').waitFor();
  const rename = async (name) => {
    await field.fill(name);
    await field.press("Enter");
    await saved();
  };
  const browse = async () => {
    await page.getByLabel("文件菜单").click();
    await page.getByRole("button", { name: "浏览本机文件…" }).click();
  };
  await rename("原稿");
  const originalCount = await page.locator("[data-node-id]").count();
  await page.getByTitle("新建空白文件").click();
  await page.waitForURL(/file=forma\.file\./);
  await saved();
  if (
    (await field.inputValue()) !== "无标题设计" ||
    (await page.locator("[data-node-id]").count())
  )
    throw Error("New design was not blank");
  await rename("另一个设计");
  await browse();
  await page.getByLabel("搜索文件").fill("原稿");
  if ((await page.locator(".recent-files a").count()) !== 1)
    throw Error("Search returned wrong file count");
  await page.getByRole("link", { name: /原稿/ }).click();
  await saved();
  if (
    (await field.inputValue()) !== "原稿" ||
    (await page.locator("[data-node-id]").count()) !== originalCount
  )
    throw Error("Original design changed");
  await browse();
  await page.getByRole("link", { name: /另一个设计/ }).click();
  await saved();
  if (
    (await field.inputValue()) !== "另一个设计" ||
    (await page.locator("[data-node-id]").count())
  )
    throw Error("New file did not persist");
  return { originalCount, switchedTwice: true, separateContents: true };
};
