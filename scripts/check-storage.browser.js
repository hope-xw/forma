async (page, { newWindow = () => page.context().newPage() } = {}) => {
  const name = () => page.getByRole("textbox", { name: "文件名" });
  const saved = () => page.locator('[title="已保存到此浏览器"]').waitFor();
  const rename = async (value) => {
    await name().fill(value);
    await name().press("Enter");
    await saved();
  };
  await saved();
  await rename("First durable edit");
  await rename("Second durable edit");
  await page.reload();
  await saved();
  if ((await name().inputValue()) !== "Second durable edit")
    throw Error("Failed to reopen current revision");
  await page.getByLabel("文件菜单").click();
  await page.getByRole("button", { name: "恢复上次保存版本" }).click();
  await saved();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="文件名"]').value ===
      "First durable edit",
  );
  if ((await name().inputValue()) !== "First durable edit")
    throw Error("Recovery failed");
  const other = await newWindow();
  await other.goto(page.url());
  await other.locator('[title="已保存到此浏览器"]').waitFor();
  await rename("Winning revision");
  const field = other.getByRole("textbox", { name: "文件名" });
  await field.fill("Stale revision");
  await field.press("Enter");
  await other.getByRole("alert").filter({ hasText: "另一个标签页" }).waitFor();
  await other.close();
  await page.reload();
  await saved();
  if ((await name().inputValue()) !== "Winning revision")
    throw Error("Stored data was overwritten");
  return {
    reopened: true,
    recovered: true,
    staleTab: "preserved winning revision",
  };
};
