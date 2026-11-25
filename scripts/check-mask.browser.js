async (page) => {
  const style = {
    x: 0,
    y: 0,
    width: 260,
    height: 200,
    fill: "#ffffff",
    color: "#141414",
    radius: 0,
    fontSize: 16,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const n = (id, type, parentId, patch) => ({
    id,
    type,
    parentId,
    name: id,
    text: "",
    hidden: false,
    locked: false,
    style: { ...style, ...patch },
  });
  const doc = {
    id: "mask-check",
    name: "Mask",
    revision: 0,
    schemaVersion: 1,
    tokens: {},
    nodes: [
      n("Board", "frame", null, {}),
      n("Circle", "ellipse", "Board", {
        x: 40,
        y: 40,
        width: 100,
        height: 100,
        fill: "#ff5500",
      }),
      n("Paint", "rectangle", "Board", {
        x: 20,
        y: 20,
        width: 160,
        height: 160,
        fill: "#3456ff",
      }),
    ],
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "mask.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const layer = (id) =>
    page.getByRole("button", { name: "选择图层 " + id, exact: true });
  const b = (name) => page.getByRole("button", { name, exact: true });
  await layer("Circle").click();
  await layer("Paint").click({ modifiers: ["Shift"] });
  await b("用作矢量蒙版").click();
  const group = page.locator(".design-node.selected");
  const gid = await group.getAttribute("data-node-id");
  const curve = await group.evaluate((el) => getComputedStyle(el).clipPath);
  if (
    !curve.startsWith("path(") ||
    (await page.locator("[data-node-id=Circle]").count())
  )
    throw Error("Missing mask");
  const hit = await page.locator("[data-node-id=Paint]").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [
      [0.5, 0.5],
      [0.12, 0.12],
    ].map(([x, y]) =>
      document
        .elementsFromPoint(r.x + r.width * x, r.y + r.height * y)
        .includes(el),
    );
  });
  if (!hit[0] || hit[1])
    throw Error("Clip does not match actual painted hit area");
  await layer("Circle").click();
  const width = page.getByLabel("宽度", { exact: true });
  await width.fill("75");
  await width.press("Enter");
  await layer("蒙版组").click();
  const edited = await group.evaluate((el) => getComputedStyle(el).clipPath);
  if (edited === curve) throw Error("Mask did not update");
  await b("预览").click();
  if (
    (await page
      .locator('[data-design-id="' + gid + '"]')
      .evaluate((el) => getComputedStyle(el).clipPath)) !== edited
  )
    throw Error("Mask preview differs");
  await b("关闭预览").click();
  const ticket = page.waitForEvent("download");
  await b("导出 React 项目").click();
  await (await ticket).saveAs("output/playwright/mask-check.zip");
  await b("解除蒙版").click();
  await page.locator("[data-node-id=Circle]").waitFor();
  const rect = await page.locator("[data-node-id=Circle]").boundingBox();
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, {
    button: "right",
  });
  await page.getByRole("menuitem", { name: "选择重叠图层" }).click();
  await page
    .getByRole("menuitem", { name: "选取 Circle", exact: true })
    .click();
  if (
    !(await page.locator(".design-node.selected[data-node-id=Circle]").count())
  )
    throw Error("Could not choose lower shape");
  return { hit, curve: edited, released: true, selectedCoveredLayer: true };
};
