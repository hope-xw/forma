async (page) => {
  const editing = await page.locator(".editor-canvas").count();
  const button = (name) => page.getByRole("button", { name, exact: true });
  const field = (name) => page.getByLabel(name, { exact: true });
  const assert = (v, msg) => {
    if (!v) throw Error(msg);
  };
  const edit = async (name, value) => {
    await field(name).fill(String(value));
    await field(name).press("Enter");
  };
  const geometry = async (attr, width) => {
    const data = await page.evaluate(
      ({ attr }) => {
        const el = (id) =>
          document.querySelector("[" + attr + '="' + id + '"]');
        const rect = (id) => {
          const n = el(id);
          return [n.offsetLeft, n.offsetTop, n.offsetWidth, n.offsetHeight];
        };
        const root = el("Board"),
          css = getComputedStyle(root),
          tile = getComputedStyle(el("Tools"));
        return {
          width: root.offsetWidth,
          cols: css.gridTemplateColumns.split(" ").length,
          pad: parseFloat(css.paddingLeft),
          radius: parseFloat(css.borderTopLeftRadius),
          opacity: Number(css.opacity),
          fill: css.backgroundColor,
          innerOpacity: Number(tile.opacity),
          row: parseFloat(css.rowGap),
          gap: parseFloat(css.columnGap),
          next: rect("Card"),
          inner: rect("Icon2"),
          tileWidth: el("Tools").offsetWidth,
          tileGap: parseFloat(tile.columnGap),
        };
      },
      { attr },
    );
    const columns = width <= 480 ? 1 : width <= 768 ? 2 : 4;
    const pad = width <= 480 ? 8 : width <= 768 ? 16 : 24;
    const gap = width <= 480 ? 8 : width <= 768 ? 12 : 16;
    const row = width <= 480 ? 6 : 12;
    const w = (width - 2 * pad - (columns - 1) * gap) / columns;
    const left = columns === 1 ? pad : pad + w + gap;
    assert(
      data.width === width &&
        data.cols === columns &&
        data.pad === pad &&
        data.radius === (width <= 480 ? 4 : width <= 768 ? 12 : 0) &&
        data.opacity === (width <= 768 ? 0.8 : 1) &&
        data.fill ===
          (width <= 480
            ? "rgb(51, 68, 85)"
            : width <= 768
              ? "rgb(102, 119, 136)"
              : "rgb(255, 255, 255)") &&
        data.innerOpacity === (w <= 300 ? 0.6 : 1) &&
        data.gap === gap &&
        data.row === row &&
        Math.abs(data.next[0] - left) <= 1 &&
        data.next[1] === (columns === 1 ? pad + 60 + row : pad) &&
        data.inner[0] === (w <= 300 ? 15 : 26),
      JSON.stringify({ width, data }),
    );
    return data;
  };
  if (editing) {
    const defaults = {
      x: 0,
      y: 0,
      width: 10,
      height: 24,
      layout: "free",
      gap: 0,
      padding: 0,
      fill: "#ffffff",
      color: "#181819",
      fontSize: 16,
      radius: 0,
    };
    const node = (id, parentId, type, style) => ({
      id,
      name: id,
      parentId,
      type,
      text: "",
      hidden: false,
      locked: false,
      style: { ...defaults, ...style },
    });
    const doc = {
      schemaVersion: 1,
      id: "range-layouts",
      name: "控制台",
      revision: 0,
      tokens: {},
      activePage: "overview",
      pages: [
        { id: "overview", name: "总览" },
        {
          id: "details",
          name: "详情",
          nodes: [
            node("Details", null, "frame", {
              width: 1024,
              height: 300,
              viewportWidth: true,
              layout: "free",
              fill: "#112233",
              layoutBreakpoints: [
                { maxWidth: 768, fill: "#332211", radius: 10, padding: 99 },
              ],
            }),
            {
              ...node("Return", "Details", "button", {
                width: 100,
                height: 40,
              }),
              text: "返回",
              interaction: { actions: [{ kind: "back" }] },
            },
          ],
        },
      ],
      nodes: [
        node("Board", null, "frame", {
          width: 1024,
          height: 260,
          layout: "grid",
          columns: 4,
          gap: 16,
          rowGap: 12,
          padding: 24,
          viewportWidth: true,
        }),
        node("Tools", "Board", "frame", {
          layout: "row",
          widthMode: "fill",
          height: 60,
          padding: 7,
          gap: 9,
        }),
        node("Icon1", "Tools", "rectangle", {}),
        node("Icon2", "Tools", "rectangle", {}),
        {
          ...node("Card", "Board", "rectangle", {
            widthMode: "fill",
            height: 60,
          }),
          interaction: { actions: [{ kind: "navigate", target: "Details" }] },
        },
      ],
    };
    await page.locator('[data-testid="design-file-input"]').setInputFiles({
      name: "layout.forma.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
    await button("选择图层 Board").click();
    await page.getByText("容器断点", { exact: true }).click();
    await button("添加断点").click();
    for (const [k, v] of [
      ["列数", 2],
      ["间距", 12],
      ["内边距", 16],
      ["圆角", 12],
      ["不透明度", 80],
      ["填充 HEX", "#667788"],
    ])
      await edit("断点 1 " + k, v);
    await button("添加断点").click();
    for (const [k, v] of [
      ["列数", 1],
      ["间距", 8],
      ["内边距", 8],
      ["行间距", 6],
      ["圆角", 4],
      ["填充 HEX", "#334455"],
    ])
      await edit("断点 2 " + k, v);
    const restoreFill = button("断点 2 恢复继承填充");
    await restoreFill.click();
    const waitHex = async (value) => {
      const input = field("断点 2 填充 HEX");
      const handle = await input.elementHandle();
      await page
        .waitForFunction(
          ({ el, value }) => el.value.toLowerCase() === value,
          { el: handle, value },
          { timeout: 3000 },
        )
        .catch(async () => {
          throw Error(
            "Expected " +
              value +
              " but saw " +
              (await input.inputValue()) +
              " and " +
              (await field("断点 1 填充 HEX").inputValue()),
          );
        });
    };
    await waitHex("667788");
    await button("撤销").click();
    await waitHex("334455");
    await page
      .locator(".breakpoint-editor")
      .screenshot({ path: "output/playwright/responsive-appearance.png" });
    await button("选择图层 Tools").click();
    const section = page.locator(".breakpoint-editor");
    if (!(await section.evaluate((el) => el.open)))
      await section.locator("summary").click();
    await button("添加断点").click();
    for (const [k, v] of [
      ["最大宽度", 300],
      ["间距", 2],
      ["不透明度", 60],
      ["内边距", 3],
    ])
      await edit("断点 1 " + k, v);
    await geometry("data-node-id", 1024);
    await button("撤销").click();
    assert(
      Number(await field("断点 1 内边距").inputValue()) === 0,
      "undo padding override",
    );
    await button("重做").click();
    await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
    await page.reload();
    await button("选择图层 Board").click();
    const source = page.waitForEvent("download");
    await button("设计文件").click();
    await (
      await source
    ).saveAs("output/playwright/responsive-console.forma.json");
    const ticket = page.waitForEvent("download");
    await button("导出 React 项目").click();
    await (await ticket).saveAs("output/playwright/container-rules-check.zip");
    await button("预览").click();
  }
  const widths = [];
  for (const width of [375, 390, 768, 1024, 1440, 390]) {
    if (editing) await field("预览视口宽度").selectOption(String(width));
    else await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction((w) => {
      const n = document.querySelector('[data-design-id="Board"]');
      return (
        n?.offsetWidth === w &&
        getComputedStyle(n).gridTemplateColumns.split(" ").length ===
          (w <= 480 ? 1 : w <= 768 ? 2 : 4)
      );
    }, width);
    await page
      .waitForFunction(() => {
        const t = document.querySelector('[data-design-id="Tools"]');
        if (!t) return false;
        return (
          parseFloat(getComputedStyle(t).columnGap) ===
          (t.offsetWidth <= 300 ? 2 : 9)
        );
      })
      .catch(async (err) => {
        throw Error(
          "Nested container " +
            width +
            " " +
            JSON.stringify(
              await page
                .locator('[data-design-id="Tools"]')
                .evaluate((t) => [
                  t.offsetWidth,
                  t.style.cssText,
                  getComputedStyle(t).columnGap,
                ]),
            ) +
            " " +
            err.message,
        );
      });
    widths.push(await geometry("data-design-id", width));
  }
  await page.locator('[data-design-id="Card"]').click();
  const details = page.locator('[data-design-id="Details"]');
  await details.waitFor();
  if (
    (await details.evaluate((el) => getComputedStyle(el).paddingLeft)) !== "0px"
  )
    throw Error("Dormant autolayout padding applied to free frame");
  const detailFill = await details.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  if (detailFill !== "rgb(51, 34, 17)")
    throw Error("Second page appearance " + detailFill);
  await page.locator('[data-design-id="Return"]').click();
  await page.locator('[data-design-id="Board"]').waitFor();
  return { widths, secondPage: detailFill };
};
