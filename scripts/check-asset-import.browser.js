async (page) => {
  const upload = page.locator('input[accept^=".svg"]');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="4 4 24 24"><title>Compass</title><g transform="translate(4,4)" fill="#1166ff"><rect x="1" y="1" width="20" height="20" rx="4"/><path d="M4 14 L12 4 L10 14 Z" fill="#ffaa11" fill-opacity="0.65" stroke="#112233" stroke-width="1.5" stroke-linejoin="bevel"/></g></svg>';
  const put = async (source) =>
    upload.setInputFiles({
      name: "compass.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from(source),
    });
  await put(svg);
  const node = page.locator(".selected[data-node-type=vector]");
  await node.waitFor();
  const id = await node.getAttribute("data-node-id");
  const parts = await node.locator("svg path").evaluateAll((paths) =>
    paths.map((p) => ({
      d: p.getAttribute("d"),
      fill: p.getAttribute("fill"),
      opacity: p.getAttribute("fill-opacity"),
      width: p.getAttribute("stroke-width"),
      join: p.getAttribute("stroke-linejoin"),
    })),
  );
  if (
    parts.length !== 2 ||
    parts[0].fill !== "#1166ff" ||
    parts[1].opacity !== "0.65" ||
    parts[1].width !== "6" ||
    parts[1].join !== "bevel" ||
    !parts[1].d.startsWith("M16 56")
  )
    throw Error(JSON.stringify(parts));
  await page.getByRole("button", { name: "编辑锚点" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  const rendered = await page
    .locator('[data-design-id="' + id + '"] svg path')
    .last()
    .getAttribute("d");
  if (rendered !== parts[1].d) throw Error("Preview path differs");
  await page.getByRole("button", { name: "关闭预览" }).click();
  const count = await page.locator("[data-node-id]").count();
  await put(svg.replace("<g transform", '<filter id="blur"/><g transform'));
  await page.getByRole("alert").filter({ hasText: "filter" }).waitFor();
  if ((await page.locator("[data-node-id]").count()) !== count)
    throw Error("Partial import");
  const paste = async (source) =>
    page.locator(".editor-canvas").evaluate((el, s) => {
      el.focus();
      const data = new DataTransfer();
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      event.clipboardData.setData("text/plain", s);
      el.dispatchEvent(event);
    }, source);
  await paste(svg);
  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-node-id]").length === n + 1,
    count,
  );
  const rect = await page.locator(".editor-canvas").boundingBox();
  await page.evaluate(
    async ({ x, y }) => {
      const c = document.createElement("canvas");
      c.width = 28;
      c.height = 19;
      const blob = await new Promise((resolve) => c.toBlob(resolve));
      const data = new DataTransfer();
      data.items.add(new File([blob], "mosaic.png", { type: "image/png" }));
      document.querySelector(".editor-canvas").dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          clientX: x,
          clientY: y,
        }),
      );
    },
    { x: rect.x + 32, y: rect.y + 33 },
  );
  const raster = page.locator(".selected[data-node-type=rectangle]");
  await raster.waitFor();
  if (!(await raster.locator("img").count()))
    throw Error("Dropped bitmap missing");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-node-id]").length === n + 1,
    count,
  );
  return {
    paths: parts,
    unsupportedRejected: true,
    clipboard: true,
    rasterDropUndo: true,
  };
};
