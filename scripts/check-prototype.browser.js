async (page) => {
  const style = {
    x: 0,
    y: 0,
    width: 140,
    height: 38,
    fill: "#554beb",
    color: "#ffffff",
    radius: 6,
    fontSize: 16,
    padding: 0,
    gap: 8,
    layout: "free",
  };
  const layer = (id, parentId, type, extra = {}) => ({
    id,
    name: id,
    parentId,
    type,
    text: type === "button" ? id : "",
    hidden: false,
    locked: false,
    style,
    ...extra,
  });
  const frame = (id, x, flow) =>
    layer(id, null, "frame", {
      style: { ...style, x, width: 320, height: 240, fill: "#f1f2f6" },
      interaction: flow ? { flow } : {},
    });
  const button = (id, parent, y, actions) =>
    layer(id, parent, "button", {
      style: { ...style, y },
      interaction: actions ? { actions } : {},
    });
  const doc = {
    schemaVersion: 1,
    id: "flow-check",
    revision: 0,
    name: "Flow check",
    tokens: {},
    designSystem: {
      collections: {
        ui: {
          id: "ui",
          name: "State",
          defaultModeId: "default",
          modes: [{ id: "default", name: "Default" }],
        },
      },
      variables: {
        ready: {
          id: "ready",
          name: "Ready",
          collectionId: "ui",
          type: "boolean",
          values: { default: false },
        },
      },
      styles: {},
      activeModes: {},
    },
    nodes: [
      frame("Home", 0, "Browse"),
      frame("Detail", 390, "Inspect"),
      frame("Sheet", 780),
      button("Continue", "Home", 12),
      button("Enable", "Home", 60, [
        { kind: "set", variable: "ready", value: true },
      ]),
      button("Return", "Detail", 12, [{ kind: "back" }]),
      button("Dismiss", "Sheet", 12, [{ kind: "close" }]),
    ],
  };
  const editor =
    (await page.locator('[data-testid="design-file-input"]').count()) > 0;
  const action = (name) => page.locator('[data-design-id="' + name + '"]');
  if (editor) {
    await page.locator('[data-testid="design-file-input"]').setInputFiles({
      name: "flow.forma.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
    await page
      .getByRole("button", { name: "选择图层 Continue", exact: true })
      .click();
    await page.getByRole("button", { name: "原型", exact: true }).click();
    await page.getByLabel("条件变量").selectOption("ready");
    await page.getByLabel("值", { exact: true }).selectOption("true");
    await page.getByRole("button", { name: "添加动作", exact: true }).click();
    await page.getByLabel("动作目标").selectOption("Detail");
    await page
      .getByRole("button", { name: "添加否则动作", exact: true })
      .click();
    await page.getByLabel("动作类型").nth(1).selectOption("overlay");
    await page.getByLabel("动作目标").nth(1).selectOption("Sheet");
    await page.getByRole("button", { name: "预览", exact: true }).click();
  }
  await action("Continue").focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Sheet", exact: true }).waitFor();
  await action("Dismiss").click();
  if (await action("Sheet").count()) throw Error("Overlay remained open");
  await action("Continue").click();
  await page.keyboard.press("Escape");
  await action("Enable").click();
  await action("Continue").click();
  await action("Detail").waitFor({ state: "visible" });
  await action("Return").click();
  await action("Home").waitFor();
  if (editor) {
    await page.getByLabel("预览流程").selectOption("Detail");
    await action("Detail").waitFor();
    await page.getByLabel("预览流程").selectOption("Home");
    await action("Continue").click();
    await action("Sheet").waitFor();
    await action("Dismiss").click();
    await page.getByRole("button", { name: "关闭预览" }).click();
    const ticket = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 React 项目" }).click();
    await (await ticket).saveAs("output/playwright/prototype-check.zip");
  }
  return {
    conditional: ["Sheet", "Detail"],
    keyboard: "Enter/Escape",
    back: "Home",
    flowSwitch: editor,
  };
};
