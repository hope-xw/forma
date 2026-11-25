async (page) => {
  const checks = [],
    errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  const assert = (condition, name) => {
    if (!condition) throw Error(name);
    checks.push(name);
  };
  const button = (name) => page.getByRole("button", { name, exact: true }),
    selectBoard = async (name) => button("选择图层 " + name).click();
  await page.setViewportSize({ width: 1280, height: 650 });
  await page.reload();
  await button("打开移动设计样例").click();
  await page.getByRole("button", { name: /03 Soundspace/ }).click();
  await page
    .getByRole("button", { name: /^展开 .*声场/ })
    .first()
    .click();
  const tree = page.getByRole("tree"),
    measure = () =>
      page.evaluate(() => ({
        left: document.querySelector(".left-panel").scrollTop,
        tree: document.querySelector(".layer-list").scrollTop,
        pages: document.querySelector(".file-pages").getBoundingClientRect()
          .top,
        search: document
          .querySelector(".left-panel .search")
          .getBoundingClientRect().top,
        canvas: document.querySelector(".design-node").getBoundingClientRect()
          .top,
      }));
  const before = await measure();
  await tree.hover();
  await page.mouse.wheel(0, 850);
  await page.waitForTimeout(220);
  const after = await measure();
  assert(
    after.tree > before.tree &&
      after.left === before.left &&
      after.pages === before.pages &&
      after.search === before.search &&
      after.canvas === before.canvas,
    "滚轮只滚动图层树，页面、搜索和画布固定",
  );
  await page.getByRole("button", { name: /01 iPad/ }).click();
  await selectBoard("分栏导航 · Light");
  const canvas = page.locator(".editor-canvas");
  const bounds = await canvas.boundingBox();
  await page.mouse.click(bounds.x + 3, bounds.y + bounds.height - 3, {
    button: "right",
  });
  const menu = page.getByRole("menu");
  const fit = async () =>
    menu.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return (
        box.left >= 0 &&
        box.top >= 0 &&
        box.right <= innerWidth &&
        box.bottom <= innerHeight &&
        el.scrollHeight <= el.clientHeight + 1
      );
    });
  assert(
    (await fit()) && (await menu.getByRole("menuitem").count()) === 6,
    "画布底边右键菜单全部在屏内，空白处仅显示页面命令",
  );
  await page.keyboard.press("Escape");
  await button("选择图层 分栏导航 · Light").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "排列", exact: true }).click();
  assert(
    (await fit()) &&
      (await menu.getByRole("menuitem", { name: /置于顶层/ }).count()) === 1,
    "图层菜单按组选取排列命令",
  );
  await page.keyboard.press("ArrowLeft");
  await menu.getByRole("menuitem", { name: "组织", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  assert(
    (await menu.getByRole("menuitem", { name: /包裹为画板/ }).count()) === 1,
    "键盘进入子菜单",
  );
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: "output/playwright/context-menu-verified.png",
  });
  await page.keyboard.press("Escape");
  const board = page.locator(".design-node.selected").first(),
    right = page.locator(".right-panel");
  await button("独立圆角").click();
  const corner = page.getByLabel("左上圆角", { exact: true });
  await corner.fill("47");
  await corner.press("Enter");
  await page.getByLabel("混合模式", { exact: true }).selectOption("multiply");
  await button("添加填充层").click();
  await button("添加填充层").click();
  const layers = page.locator(".paint-layer");
  const hex = layers.first().getByRole("textbox").first();
  await hex.fill("FF0000");
  await hex.press("Enter");
  await layers.first().getByTitle("下移填充").click();
  assert(
    (
      await layers.nth(1).getByRole("textbox").first().inputValue()
    ).toUpperCase() === "FF0000",
    "右侧填充顺序可交换",
  );
  await layers.nth(1).getByTitle("切换填充可见性").click();
  await layers.first().locator("summary").click();
  await layers.first().getByLabel("填充类型").selectOption("radial");
  await button("添加描边").click();
  await page.getByLabel("描边线型").selectOption("dashed");
  const css = await board.evaluate((el) => {
    const css = getComputedStyle(el);
    return [
      css.borderTopLeftRadius,
      css.mixBlendMode,
      css.borderTopStyle,
      css.backgroundImage,
    ];
  });
  assert(
    css[0] === "47px" &&
      css[1] === "multiply" &&
      css[2] === "dashed" &&
      css[3].includes("radial-gradient") &&
      !css[3].includes("255, 0, 0"),
    "选中画板实际呈现独立圆角、混合模式、描边和可见渐变",
  );
  const tabs = await right.locator(".inspector-tabs").boundingBox();
  assert(
    (await right.evaluate((el) => el.scrollTop)) > 0 &&
      Math.abs(tabs.y - (await right.boundingBox()).y) < 2,
    "长属性面板单独滚动且标题保持可见",
  );
  await page.waitForTimeout(450);
  await page.reload();
  await selectBoard("分栏导航 · Light");
  assert(
    (await layers.count()) === 2 &&
      (await page.getByLabel("左上圆角", { exact: true }).inputValue()) ===
        "47",
    "刷新保留属性",
  );
  await page.setViewportSize({ width: 1024, height: 480 });
  await canvas.click({ position: { x: 4, y: 8 }, button: "right" });
  assert(await fit(), "480px 高度菜单仍完整可见");
  await page.keyboard.press("Escape");
  assert(!errors.length, "没有浏览器运行异常");
  return { checks, before, after, css };
};
