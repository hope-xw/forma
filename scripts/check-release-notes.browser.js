async (page) => {
  const menu = page.getByLabel("文件菜单", { exact: true });
  const entry = page.getByRole("button", { name: /Forma v.*版本日志/ });
  const dialog = page.getByRole("dialog", { name: "版本日志", exact: true });
  const list = dialog.getByRole("list", { name: "历次更新" });
  const focused = (locator) =>
    locator.evaluate((el) => el === document.activeElement);
  const fits = (locator) =>
    locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.top >= 0 &&
        r.left >= 0 &&
        r.bottom <= innerHeight &&
        r.right <= innerWidth
      );
    });
  const url = new URL(page.url());
  url.search = "?example=aura-showcase&page=workspace&node=ws-modal-h";
  await page.goto(url.href);
  const selected = page.locator(
    '.design-node.selected[data-node-id="ws-modal-h"]',
  );
  await selected.waitFor();
  await page.setViewportSize({ width: 900, height: 480 });
  let versions;
  for (const theme of ["dark", "light"]) {
    await menu.click();
    if ((await page.locator(".app").getAttribute("data-theme")) !== theme) {
      await page
        .getByRole("button", { name: /切换至.*界面主题/ })
        .first()
        .click();
      await menu.click();
    }
    await menu.press("End");
    if (!(await focused(entry)) || !(await fits(entry)))
      throw Error("版本号未获得焦点或超出窗口");
    const version = (await entry.innerText()).match(
      /v\d+\.\d+\.\d+[^ ·\n]*/,
    )[0];
    if (theme === "dark") await entry.click();
    else await entry.press("Enter");
    await dialog.waitFor();
    if (!(await fits(dialog)) || (await entry.isVisible()))
      throw Error("弹窗越界或文件菜单仍打开");
    await dialog.getByText("当前版本 " + version, { exact: true }).waitFor();
    const rows = list.getByRole("listitem");
    versions = await rows.count();
    for (const row of await rows.all()) {
      const date = row.locator("time");
      const text = await date.textContent();
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
        text !== (await date.getAttribute("datetime"))
      ) {
        throw Error("公开条目缺少有效的可读日期");
      }
    }
    const importRelease = rows.filter({
      has: page.getByText("v0.8.0", { exact: true }),
    });
    if (
      !(await importRelease.innerText()).includes("点击右栏 AI 按钮") ||
      (await list.getByText("v0.7.1", { exact: true }).count())
    )
      throw Error("v0.7.1 的右栏改进应并入 v0.8.0");
    if (
      version === "v0.8.2" &&
      !(await rows.first().innerText()).includes("v0.8.1")
    )
      throw Error("维护版应保留上次公开更新");
    const close = dialog.getByRole("button", { name: "关闭版本日志" });
    if (!(await focused(close))) throw Error("打开后焦点未进入面板");
    await close.press("Tab");
    if (!(await focused(list))) throw Error("键盘无法进入日志列表");
    await list.press("End");
    await page.waitForFunction(() => {
      const el = document.querySelector(".release-notes-list");
      return (
        el &&
        el.scrollTop > 0 &&
        el.scrollTop + el.clientHeight >= el.scrollHeight - 2
      );
    });
    if (!(await fits(list.getByText("v0.2.0", { exact: true }))))
      throw Error("无法读到最早版本");
    await list.press("Tab");
    if (!(await focused(close))) throw Error("Tab 离开了面板");
    if (theme === "dark") await close.press("Escape");
    else await close.click();
    await dialog.waitFor({ state: "hidden" });
    if (!(await focused(menu))) throw Error("关闭后焦点未回到文件菜单");
    await selected.waitFor();
  }
  await menu.click();
  await entry.click();
  await page.mouse.click(3, 3);
  await dialog.waitFor({ state: "hidden" });
  return { versions, themes: ["dark", "light"], selection: "ws-modal-h" };
};
