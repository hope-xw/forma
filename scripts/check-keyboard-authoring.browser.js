async (page) => {
  const press = (key) => page.keyboard.press(key);
  const focusIn = (selector) =>
    page.evaluate(
      (selector) => !!document.activeElement?.closest(selector),
      selector,
    );
  const untilFocused = async (selector, key, limit) => {
    for (let i = 0; i < limit && !(await focusIn(selector)); i++)
      await press(key);
    if (!(await focusIn(selector)))
      throw Error("Keyboard could not reach " + selector);
  };
  await untilFocused('[aria-label="新建空白文件"]', "Tab", 50);
  await press("Enter");
  await page.waitForURL(/file=forma\.file\./);
  const layers = page.locator(".editor-canvas [data-node-id]");
  await page.locator(".editor-canvas").waitFor();
  if (await layers.count()) throw Error("expected blank file");
  await untilFocused(".editor-canvas", "F6", 5);
  for (const key of ["f", "Enter", "t", "Enter", "Enter"]) await press(key);
  const editor = page.getByRole("textbox", {
    name: "画布文本编辑",
    exact: true,
  });
  await editor.waitFor();
  await page.keyboard.insertText("会员中心 Studio");
  await press("Control+Enter");
  if (
    (await layers.count()) !== 2 ||
    !(await layers.last().innerText()).includes("会员中心 Studio")
  )
    throw Error("Frame or text missing");
  await untilFocused("#right-panel", "F6", 5);
  await untilFocused(".editor-canvas", "Shift+F6", 5);
  await press("Control+z");
  if ((await layers.last().innerText()).includes("会员中心 Studio"))
    throw Error("undo did not restore initial text");
  await press("Control+Shift+z");
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("会员中心 Studio", { exact: true }).first().waitFor();
  return {
    input: "keyboard only",
    layers: await layers.count(),
    undoRedo: true,
    reopened: true,
  };
};
