async (page) => {
  const base = {
    x: 0,
    y: 0,
    width: 600,
    height: 220,
    fill: "#eae7fa",
    color: "#17151f",
    radius: 0,
    fontSize: 16,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const nodes = [
    {
      id: "Home",
      parentId: null,
      type: "frame",
      style: { ...base, viewportWidth: true },
      interaction: { flow: "Entry" },
    },
    {
      id: "Next",
      parentId: "Home",
      type: "button",
      style: {
        ...base,
        x: 480,
        y: 18,
        width: 100,
        height: 36,
        constraintX: "end",
      },
      interaction: { actions: [{ kind: "navigate", target: "Detail" }] },
    },
    {
      id: "Detail",
      parentId: null,
      type: "frame",
      style: { ...base, x: 690, width: 300 },
    },
    {
      id: "Back",
      parentId: "Detail",
      type: "button",
      style: { ...base, width: 80, height: 30 },
      interaction: { actions: [{ kind: "back" }] },
    },
  ].map((n) => ({
    ...n,
    name: n.id,
    text: n.type === "button" ? n.id : "",
    hidden: false,
    locked: false,
  }));
  const editor = !!(await page.locator(".editor-canvas").count());
  const b = (name) => page.getByRole("button", { name, exact: true });
  const n = (id) => page.locator('[data-design-id="' + id + '"]');
  if (editor) {
    await page.locator('[data-testid="design-file-input"]').setInputFiles({
      name: "responsive-flow.forma.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          id: "fluid-flow",
          name: "Fluid flow",
          nodes,
          tokens: {},
          revision: 0,
        }),
      ),
    });
    await b("选择图层 Home").click();
    await b("预览").click();
  }
  for (const width of [375, 390, 768, 1024, 1440]) {
    if (editor)
      await page.getByLabel("预览视口宽度").selectOption(String(width));
    else await page.setViewportSize({ width, height: 800 });
    if ((await n("Home").evaluate((el) => el.offsetWidth)) !== width)
      throw Error("Screen did not resize at " + width);
    if ((await n("Next").evaluate((el) => el.offsetLeft)) !== width - 120)
      throw Error("Right anchor moved at " + width);
    await n("Next").click();
    if ((await n("Detail").evaluate((el) => el.offsetWidth)) !== 300)
      throw Error("Fixed screen changed width");
    await n("Back").click();
    await n("Home").waitFor();
  }
  if (editor) {
    await b("关闭预览").click();
    const dl = page.waitForEvent("download");
    await b("导出 React 项目").click();
    await (await dl).saveAs("output/playwright/responsive-player-check.zip");
  }
  return {
    fluidWidths: [375, 390, 768, 1024, 1440],
    anchored: true,
    fixedTarget: 300,
  };
};
