async (page) => {
  const b = (name) => page.getByRole("button", { name, exact: true }),
    f = (name) => page.getByLabel(name, { exact: true });
  const common = {
    width: 110,
    height: 110,
    y: 0,
    fill: "#ffffff",
    color: "#333333",
    padding: 0,
    radius: 0,
    gap: 0,
    fontSize: 16,
    layout: "free",
  };
  const n = (id, x, color, alpha, stops) => ({
    id,
    type: "rectangle",
    parentId: null,
    name: id,
    text: "",
    hidden: false,
    locked: false,
    style: {
      ...common,
      x,
      stroke: "#ff1100",
      strokeWidth: id === "A" ? 3 : 0,
      gradient: {
        type: "linear",
        angle: x,
        stops: Array.from({ length: stops }, (_, i) => ({
          offset: i / (stops - 1),
          color,
          opacity: alpha,
        })),
      },
      shadows: [
        { x, y: 0, blur: 8, spread: 0, opacity: alpha, inset: false, color },
      ],
    },
  });
  const doc = {
    schemaVersion: 1,
    id: "mixed-materials",
    name: "mixed",
    revision: 0,
    tokens: {},
    nodes: [n("A", 0, "#123456", 0.25, 2), n("B", 150, "#abcdef", 0.75, 3)],
  };
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "mixed.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await b("选择图层 A").click();
  await b("选择图层 B").click({ modifiers: ["Shift"] });
  const style = () =>
    page.locator(".design-node.selected").evaluateAll((els) =>
      els.map((el) => {
        const css = getComputedStyle(el);
        return [css.backgroundImage, css.borderTopWidth, css.boxShadow];
      }),
    );
  const before = await style();
  await page.getByText("选区纯色", { exact: true }).click();
  const aggregate = f("选区颜色 #123456 HEX");
  await aggregate.fill("885522");
  await aggregate.press("Enter");
  const replaced = await style();
  if (
    !replaced[0][0].includes("136, 85, 34, 0.25") ||
    !replaced[0][2].includes("136, 85, 34, 0.25") ||
    JSON.stringify(replaced[1]) !== JSON.stringify(before[1])
  )
    throw Error(
      "Batch replacement failed to preserve neighboring gradient, shadow or alpha: " +
        JSON.stringify(replaced),
    );
  await b("撤销").click();
  if (JSON.stringify(await style()) !== JSON.stringify(before))
    throw Error("Batch replacement did not undo as a single edit");
  const hex = f("色标 1 HEX");
  if (
    (await hex.inputValue()) !== "" ||
    (await hex.getAttribute("placeholder")) !== "Mixed"
  )
    throw Error("Gradient not mixed");
  await hex.fill("112233");
  await hex.press("Enter");
  await b("添加描边").click();
  await b("添加投影").click();
  let actual = await style();
  if (
    !actual[0][0].includes("17, 34, 51, 0.25") ||
    !actual[1][0].includes("17, 34, 51, 0.75") ||
    actual[0][1] !== "3px" ||
    actual[1][1] !== "1px" ||
    !actual.every((v, i) => v[2].includes(before[i][2]))
  )
    throw Error(JSON.stringify(actual));
  await page.locator(".effect-detail summary").first().click();
  const shadow = f("阴影 1 x");
  if ((await shadow.getAttribute("placeholder")) !== "Mixed")
    throw Error("Shadow offset not mixed");
  await shadow.fill("12");
  await shadow.press("Enter");
  actual = await style();
  if (!actual.every((v) => v[2].includes("12px 0px 8px")))
    throw Error(JSON.stringify(actual));
  const originalOrder = await style();
  if (
    !(await b("上移阴影 1").isDisabled()) ||
    !(await b("下移阴影 2").isDisabled())
  )
    throw Error("Shadow stack bounds");
  await b("下移阴影 1").click();
  const reordered = await style();
  for (const [i, css] of reordered.entries()) {
    const split = (value) => value.split(/, (?![^()]*\))/);
    if (
      JSON.stringify(split(css[2])) !==
      JSON.stringify(split(originalOrder[i][2]).reverse())
    )
      throw Error("Visible shadow stack did not reverse independently");
  }
  await b("撤销").click();
  if (JSON.stringify(await style()) !== JSON.stringify(originalOrder))
    throw Error("One undo must restore both stacks");
  for (let i = 0; i < 4; i++) await b("撤销").click();
  if (JSON.stringify(await style()) !== JSON.stringify(before))
    throw Error("mixed operation undo lost data");
  return {
    gradientAlpha: [0.25, 0.75],
    stroke: [3, 1],
    independentShadows: true,
    gradientAndShadowBatchRecolor: true,
    reorderedBothStacks: true,
    undo: 5,
  };
};
