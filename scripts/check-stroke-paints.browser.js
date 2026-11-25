async (page) => {
  const { strict: assert } = await import("node:assert");
  const { readFile } = await import("node:fs/promises");
  const { PNG } = (await import("playwright-core/lib/utilsBundle")).default;
  const style = {
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    layout: "free",
    fill: "#336699",
    color: "#000000",
    radius: 0,
    fontSize: 16,
    gap: 0,
    padding: 0,
  };
  const layer = (id, parentId, type, properties) => ({
    id,
    parentId,
    name: id,
    type,
    text: "",
    locked: false,
    hidden: false,
    style: { ...style, ...properties },
  });
  const doc = {
    schemaVersion: 1,
    id: "stroke-paints",
    name: "Stacked stroke",
    revision: 0,
    tokens: {},
    nodes: [
      layer("board", null, "frame", {}),
      layer("border", "board", "rectangle", {
        x: 10,
        y: 10,
        width: 60,
        height: 40,
        fillOpacity: 0,
        strokeWidth: 8,
        strokeAlign: "inside",
        stroke: "#ff00ff",
        strokePaints: [
          {
            id: "blue",
            color: "#0000ff",
            opacity: 0.5,
            visible: true,
            blendMode: "screen",
          },
          {
            id: "red",
            color: "#ff0000",
            opacity: 0.5,
            visible: true,
            blendMode: "multiply",
          },
        ],
      }),
    ],
  };
  const input = page.getByTestId("design-file-input");
  await input.setInputFiles({
    name: "stroke-paints.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const canvas = page.locator('[data-node-id="board"]');
  function check(bytes, expected) {
    const img = PNG.sync.read(bytes);
    const sample = (x, y) => {
      const k =
        4 *
        (Math.floor((y * img.height) / 60) * img.width +
          Math.floor((x * img.width) / 100));
      return Array.from(img.data.subarray(k, k + 3));
    };
    for (const [point, color] of [
      [[13, 31], expected],
      [
        [28, 28],
        [51, 102, 153],
      ],
      [
        [7, 30],
        [51, 102, 153],
      ],
    ]) {
      const actual = sample(...point);
      assert.ok(
        actual.every((v, i) => Math.abs(v - color[i]) <= 2),
        JSON.stringify({ point, actual, color }),
      );
    }
    return sample(13, 31);
  }
  const over = [51, 51, 166];
  await button("选择图层 border").click();
  assert.equal(await button("切换描边可见性").count(), 2);
  await button("切换描边可见性").first().click();
  check(await canvas.screenshot(), [51, 51, 77]);
  await button("切换描边可见性").first().click();
  await button("下移描边").first().click();
  check(await canvas.screenshot(), [51, 51, 102]);
  await button("上移描边").last().click();
  await button("选择图层 board").click();
  const pending = page.waitForEvent("download");
  await page.getByLabel("设计文件", { exact: true }).click();
  const saved = await readFile(await (await pending).path());
  await input.setInputFiles({
    name: "roundtrip.forma.json",
    mimeType: "application/json",
    buffer: saved,
  });
  await button("选择图层 board").click();
  const editor = check(await canvas.screenshot(), over);
  await button("预览").click();
  const preview = check(
    await page.locator('[data-design-id="board"]').screenshot(),
    over,
  );
  await button("关闭预览").click();
  await page.getByLabel("导出格式", { exact: true }).selectOption("png");
  const png = page.waitForEvent("download");
  await button("导出所选图层").click();
  const pngStroke = check(await readFile(await (await png).path()), over);
  const zip = page.waitForEvent("download");
  await button("导出 React 项目").click();
  await (await zip).saveAs("output/playwright/stroke-paints-check.zip");
  return { editor, preview, pngStroke };
};
