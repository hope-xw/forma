async (page) => {
  await page.goto(
    new URL("?example=mobile-studio&page=iphone", page.url()).href,
  );
  const b = (name) => page.getByRole("button", { name, exact: true });
  await page.getByRole("button", { name: /02 iPhone/ }).click();
  await page.getByLabel("搜索图层").fill("开关");
  const rows = page
    .locator('[data-instance-state="protected-instance"]')
    .getByRole("button", { name: "选择图层 开关", exact: true });
  if ((await rows.count()) !== 2)
    throw Error("Expected two editable switch instances");
  const axis = (key) => page.getByLabel("实例 " + key, { exact: true });
  await rows.nth(1).click();
  await axis("Value").selectOption("Off");
  await axis("Appearance").selectOption("Dark");
  await rows.first().click({ modifiers: ["Meta"] });
  if (
    (await axis("Value").locator("option:checked").innerText()) !== "Mixed" ||
    (await axis("Appearance").locator("option:checked").innerText()) !== "Mixed"
  )
    throw Error("Different component axes were collapsed");
  await axis("State").selectOption("Disabled");
  const values = async () =>
    Promise.all(
      ["Appearance", "Value", "State"].map((key) => axis(key).inputValue()),
    );
  const inspect = async () => {
    const out = [];
    for (let i = 0; i < 2; i++) {
      await rows.nth(i).click();
      out.push(await values());
    }
    return out;
  };
  const expected = [
    ["Light", "On", "Disabled"],
    ["Dark", "Off", "Disabled"],
  ];
  if (JSON.stringify(await inspect()) !== JSON.stringify(expected))
    throw Error("Editing the shared axis changed an unrelated axis");
  await b("撤销").click();
  if (!(await inspect()).every((v) => v[2] === "Default"))
    throw Error("Multi-instance variants were not a single transaction");
  await b("重做").click();
  await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
  await page.reload();
  await page.getByLabel("搜索图层").fill("开关");
  if (JSON.stringify(await inspect()) !== JSON.stringify(expected))
    throw Error("Reopening lost a variant axis");
  return {
    instances: 2,
    independentAxes: expected,
    undoRedo: true,
    reopened: true,
  };
};
