async (page) => {
  const b = (name) => page.getByRole("button", { name, exact: true }),
    f = (name) => page.getByLabel(name, { exact: true });
  const layer = (name) => b("选择图层 " + name);
  const style = {
    width: 128,
    height: 48,
    x: 0,
    y: 0,
    fill: "#ffffff",
    color: "#222222",
    padding: 0,
    radius: 0,
    gap: 0,
    fontSize: 16,
    layout: "free",
  };
  const node = (id, name, type, parentId, patch = {}) => ({
    id,
    name,
    type,
    parentId,
    text: "",
    hidden: false,
    locked: false,
    style: { ...style, ...patch },
  });
  const nodes = [
    node("screen", "Screen", "frame", null, { width: 400, height: 300 }),
  ];
  for (const [name, x] of [
    ["Card", 500],
    ["Alternate", 680],
  ]) {
    nodes.push(
      node(name, name, "frame", null, { x }),
      {
        ...node(name + "-title", "Title", "text", name, {
          width: 90,
          height: 24,
        }),
        text: name,
      },
      node(name + "-icon", "Icon", "ellipse", name, {
        x: 96,
        width: 20,
        height: 20,
        fill: "#ad4422",
      }),
    );
  }
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "components.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        id: "component-properties",
        name: "Components",
        nodes,
        tokens: {},
        revision: 0,
      }),
    ),
  });
  for (const name of ["Alternate", "Card"]) {
    await layer(name).click();
    await b("资源").click();
    await b("保存选区").click();
    await b("图层").click();
    const details = page
      .locator("details")
      .filter({ has: page.getByText(/^公开组件属性 ·/) });
    if (!(await details.evaluate((el) => el.open)))
      await details.locator("summary").click();
    await f("组件属性类型").selectOption("text");
    await f("属性目标图层").selectOption({ label: "Title" });
    await f("组件属性名称").fill("标题");
    await b("公开属性").click();
    await f("组件属性类型").selectOption("visible");
    await f("属性目标图层").selectOption({ label: "Icon" });
    await f("组件属性名称").fill("图标");
    await b("公开属性").click();
  }
  await layer("Screen").click();
  await b("资源").click();
  await f("搜索组件").fill("Card");
  await b("查看 Card").click();
  await b("插入组件").click();
  await f("实例属性 标题").fill("设计师覆盖");
  await f("实例属性 标题").press("Enter");
  await f("实例属性 图标").uncheck();
  const root = await page
    .locator(".design-node.selected")
    .getAttribute("data-node-id");
  const isCorrect = async () => {
    const el = page.locator('[data-node-id="' + root + '"]');
    return (
      (await el.innerText()) === "设计师覆盖" &&
      !(await el.locator('[data-node-type="ellipse"]').count())
    );
  };
  if (!(await isCorrect())) throw Error("Instance property not applied");
  const swap = f("替换实例组件"),
    target = await swap
      .locator("option", { hasText: "Alternate" })
      .getAttribute("value");
  await swap.selectOption(target);
  if (!(await isCorrect())) throw Error("Swap lost text or boolean");
  await b("撤销").click();
  if ((await swap.inputValue()) === target) throw Error("Swap undo");
  await b("重做").click();
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  if (!(await isCorrect())) throw Error("Instance override lost on reload");
  await layer("Screen").click();
  await b("资源").click();
  await f("搜索组件").fill("Card");
  await b("查看 Card").click();
  await b("插入组件").click();
  const second = await page
    .locator(".design-node.selected")
    .getAttribute("data-node-id");
  await b("图层").click();
  const row = (id) =>
    page
      .locator('[data-layer-id="' + id + '"]')
      .getByRole("button", { name: /^选择图层 / });
  await row(second).click();
  await row(root).click({ modifiers: ["Meta"] });
  const sharedTitle = f("实例属性 标题"),
    sharedIcon = f("实例属性 图标");
  if (
    (await sharedTitle.getAttribute("placeholder")) !== "Mixed" ||
    !(await sharedIcon.evaluate((el) => el.indeterminate)) ||
    (await f("替换实例组件").inputValue()) !== "mixed"
  )
    throw Error(
      "Mixed values: " +
        JSON.stringify([
          await sharedTitle.getAttribute("placeholder"),
          await sharedIcon.evaluate((el) => el.indeterminate),
          await f("替换实例组件").inputValue(),
          await page.locator(".layer-row.active").allTextContents(),
        ]),
    );
  await sharedTitle.focus();
  await sharedTitle.press("Tab");
  if (!(await isCorrect()))
    throw Error("Focusing mixed text removed the original override");
  await sharedTitle.fill("共享标题");
  await sharedTitle.press("Enter");
  const texts = () =>
    Promise.all(
      [root, second].map((id) =>
        page.locator('[data-node-id="' + id + '"]').innerText(),
      ),
    );
  if (!(await texts()).every((t) => t === "共享标题"))
    throw Error("Multi-selection did not apply title");
  await sharedIcon.click();
  if (
    !(await sharedIcon.isChecked()) ||
    (await sharedIcon.evaluate((el) => el.indeterminate))
  )
    throw Error("Multi-selection did not show both icons");
  await b("撤销").click();
  await b("撤销").click();
  if (
    !(await isCorrect()) ||
    (await texts())[1] !== "Card" ||
    !(await sharedIcon.evaluate((el) => el.indeterminate))
  )
    throw Error("Undo lost independent overrides");
  await layer("Screen").click();
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    b("导出 React 项目").click(),
  ]);
  await file.saveAs("output/playwright/component-properties-check.zip");
  await b("预览").click();
  const view = page.locator('[data-design-id="' + root + '"]');
  if (
    (await view.innerText()) !== "设计师覆盖" ||
    (await view.locator("[data-design-id]").last().isVisible())
  )
    throw Error("Preview override mismatch");
  return {
    text: "设计师覆盖",
    iconHidden: true,
    swapped: true,
    mixedInstances: 2,
    undo: true,
  };
};
