async (page) => {
  const style = {
    x: 0,
    y: 0,
    width: 45,
    height: 32,
    fill: "#7560ce",
    color: "#111111",
    radius: 5,
    fontSize: 16,
    padding: 0,
    gap: 0,
    layout: "free",
  };
  const points = [
    [18, 21],
    [99, 16],
    [178, 24],
    [21, 96],
    [101, 103],
    [178, 95],
  ];
  const nodes = [
    {
      id: "board",
      name: "Cards",
      type: "frame",
      parentId: null,
      style: { ...style, width: 340, height: 240, fill: "#ffffff" },
    },
    ...points.map(([x, y], i) => ({
      id: String.fromCharCode(65 + i),
      name: "Card " + String.fromCharCode(65 + i),
      type: "rectangle",
      parentId: "board",
      style: { ...style, x, y },
    })),
  ].map((n) => ({ ...n, hidden: false, locked: false, text: "" }));
  const doc = {
    schemaVersion: 1,
    id: "tidy",
    name: "Arrange cards",
    revision: 0,
    tokens: {},
    nodes,
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "smart.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const b = (name) => page.getByRole("button", { name, exact: true });
  const pos = async () =>
    page
      .locator("[data-node-type=rectangle]")
      .evaluateAll((els) =>
        Object.fromEntries(
          els.map((el) => [
            el.dataset.nodeId,
            [parseFloat(el.style.left), parseFloat(el.style.top)],
          ]),
        ),
      );
  const original = await pos();
  await b("选择图层 Card A").click();
  for (const id of ["B", "C", "D", "E", "F"])
    await b("选择图层 Card " + id).click({ modifiers: ["ControlOrMeta"] });
  await b("智能整理").click();
  await page.screenshot({ path: "output/playwright/smart-selection.png" });
  const arranged = await pos();
  if (arranged.A[1] !== arranged.C[1] || arranged.B[0] !== arranged.E[0])
    throw Error("Uneven regular grid");
  const input = page.getByRole("textbox", {
    name: "选区水平间距",
    exact: true,
  });
  await input.fill("30");
  await input.press("Enter");
  const fixed = await pos();
  if (fixed.B[0] - fixed.A[0] !== 75) throw Error("Horizontal gap not applied");
  const gap = b("拖动垂直间距"),
    g = await gap.boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + 12, {
    steps: 4,
  });
  await page.mouse.up();
  const moved = await pos();
  if (moved.D[1] <= fixed.D[1])
    throw Error("Vertical handle did not change gap");
  const aa = await b("重排 Card A").boundingBox(),
    bb = await b("重排 Card B").boundingBox();
  await page.mouse.move(aa.x + aa.width / 2, aa.y + aa.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  const reordered = await pos();
  if (
    JSON.stringify(reordered.A) !== JSON.stringify(moved.B) ||
    Object.keys(reordered).join("") !== "ABCDEF"
  )
    throw Error("Smart reorder changed hierarchy or failed");
  await b("重排 Card B").focus();
  await page.keyboard.press("Delete");
  const packed = await pos();
  if (packed.B || packed.A[0] !== moved.A[0] || packed.D[1] !== moved.A[1])
    throw Error("Remove did not repack grid");
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press("ControlOrMeta+z");
  const restored = await pos();
  if (JSON.stringify(restored) !== JSON.stringify(reordered))
    throw Error("Undo did not restore removed node and positions");
  return {
    initial: original,
    grid: arranged,
    horizontalGap: 30,
    verticalGapAfterDrag: moved.D[1] - moved.A[1] - 32,
    reordered: true,
    deleteAndUndo: true,
  };
};
