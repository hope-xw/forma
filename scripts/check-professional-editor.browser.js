async (page) => {
  const editing = await page.locator(".editor-canvas").count();
  const { PNG } = (await import("playwright-core/lib/utilsBundle")).default;
  const assert = (ok, msg) => {
    if (!ok) throw Error(msg);
  };
  const button = (name) => page.getByRole("button", { name, exact: true });
  const field = (name) => page.getByLabel(name, { exact: true });
  const layer = (id) => button("选择图层 " + id);
  const edit = async (name, value) => {
    await field(name).fill(String(value));
    await field(name).press("Enter");
  };
  const node = (prefix, id) => page.locator("[" + prefix + '="' + id + '"]');
  const geom = (prefix, id) =>
    node(prefix, id).evaluate((el) => [
      el.offsetLeft,
      el.offsetTop,
      el.offsetWidth,
      el.offsetHeight,
    ]);
  const samples = async (prefix) => {
    const shot = await node(prefix, "Ink").screenshot();
    const img = PNG.sync.read(shot);
    return [0.125, 0.375, 0.625, 0.875].map(
      (x) =>
        img.data[
          4 *
            (Math.floor(img.height / 2) * img.width + Math.floor(x * img.width))
        ],
    );
  };
  const verifyPixels = (actual, expected) =>
    assert(
      actual.every((a, i) => Math.abs(a - expected[i]) <= 4),
      "Mask pixel values " + actual + " expected " + expected,
    );
  if (editing) {
    const style = {
      x: 0,
      y: 0,
      width: 120,
      height: 44,
      layout: "free",
      fill: "#ffffff",
      color: "#161617",
      padding: 0,
      radius: 0,
      gap: 0,
      fontSize: 22,
    };
    const n = (id, parentId, type, patch) => ({
      id,
      parentId,
      type,
      name: id,
      text: "",
      hidden: false,
      locked: false,
      style: { ...style, ...patch },
    });
    const board = n("Workspace", null, "frame", {
      width: 768,
      height: 320,
      layout: "grid",
      columns: 2,
      gap: 12,
      gridRowHeight: 60,
      gridBreakpoint: 600,
      narrowColumns: 1,
      viewportWidth: true,
    });
    const nav = n("Nav", "Workspace", "rectangle", {
      widthMode: "fill",
      fill: "#3d5075",
    });
    const detail = n("Detail", "Workspace", "frame", {
      widthMode: "fill",
      height: 56,
    });
    const text = n("Type", "Detail", "text", {
      widthMode: "hug",
      heightMode: "hug",
      x: 0,
      y: 30,
    });
    text.text = "设计 Forma Studio Width";
    const mask = n("Tone", "Detail", "rectangle", { width: 120, height: 24 });
    const ink = n("Ink", "Detail", "rectangle", {
      width: 120,
      height: 24,
      fill: "#000000",
    });
    const doc = {
      schemaVersion: 1,
      id: "professional-workspace",
      name: "专业编辑验收",
      revision: 0,
      tokens: {},
      nodes: [board, nav, detail, text, mask, ink],
    };
    await page.locator('[data-testid="design-file-input"]').setInputFiles({
      name: "workspace.forma.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
    await layer("Workspace").click();
    const breakpoints = page.locator(".breakpoint-editor");
    await breakpoints.locator("summary").click();
    assert(
      Number(await field("断点 1 最大宽度").inputValue()) === 600,
      "legacy grid breakpoint missing",
    );
    await edit("断点 1 最大宽度", 650);
    await button("撤销").click();
    assert(
      Number(await field("断点 1 最大宽度").inputValue()) === 600,
      "legacy migration undo",
    );
    await breakpoints.locator("summary").click();
    await page.getByText("网格轨道", { exact: true }).click();
    await field("第 1 列模式").selectOption("px");
    await edit("第 1 列尺寸", 240);
    const handle = button("拖动调整第 1 列宽");
    const grip = await handle.boundingBox();
    const zoom = Number(
      await page.locator(".editor-canvas").getAttribute("data-zoom"),
    );
    const start = [grip.x + grip.width / 2, grip.y + grip.height / 2];
    await page.mouse.move(...start);
    await page.mouse.down();
    await page.mouse.move(start[0] + 40 * zoom, start[1], { steps: 8 });
    await page.mouse.up();
    assert(
      Math.abs(Number(await field("第 1 列尺寸").inputValue()) - 280) <= 1,
      "canvas track drag did not resize column",
    );
    await button("撤销").click();
    assert(
      Number(await field("第 1 列尺寸").inputValue()) === 240,
      "track drag was not one undo entry",
    );
    await handle.press("Shift+ArrowRight");
    assert(
      Number(await field("第 1 列尺寸").inputValue()) === 250,
      "keyboard track resize failed",
    );
    await button("撤销").click();
    await page
      .locator("#right-panel")
      .screenshot({ path: "output/playwright/grid-tracks-panel.png" });
    await field("轨道方向").selectOption("row");
    await field("第 1 行模式").selectOption("px");
    await edit("第 1 行尺寸", 80);
    await layer("Detail").click();
    await field("单元格位置").selectOption("explicit");
    await edit("起始行", 3);
    await edit("起始列", 2);
    assert(
      (await geom("data-node-id", "Detail")).join() === "252,164,516,56",
      "explicit position " + (await geom("data-node-id", "Detail")),
    );
    await button("撤销").click();
    assert((await geom("data-node-id", "Detail"))[0] === 0, "grid undo");
    await button("重做").click();
    await layer("Nav").click();
    const canvasBoard = await node("data-node-id", "Workspace").boundingBox(),
      navBox = await node("data-node-id", "Nav").boundingBox();
    const scale = canvasBoard.width / 768;
    await page.mouse.move(
      navBox.x + navBox.width / 2,
      navBox.y + navBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      canvasBoard.x + 320 * scale,
      canvasBoard.y + 120 * scale,
      { steps: 8 },
    );
    await page.locator(".grid-drop-preview").waitFor();
    await page.mouse.up();
    assert(
      (await geom("data-node-id", "Nav")).slice(0, 2).join() === "252,92",
      "drag did not move to destination cell",
    );
    await button("撤销").click();
    assert((await geom("data-node-id", "Nav"))[0] === 0, "undo canvas drop");
    await layer("Tone").click();
    // Sample inside uniform swatches. A one-texel swatch has no flat interior
    // after magnification, so its center depends on the engine's filter phase.
    const png = new PNG({ width: 120, height: 24 });
    [
      [255, 255],
      [0, 255],
      [128, 128],
      [0, 0],
    ].forEach(([v, a], i) => {
      for (let y = 0; y < png.height; y++) {
        for (let x = i * 30; x < (i + 1) * 30; x++)
          png.data.set([v, v, v, a], (y * png.width + x) * 4);
      }
    });
    await page.locator('input[type=file][accept^="image/png"]').setInputFiles({
      name: "tone.png",
      mimeType: "image/png",
      buffer: PNG.sync.write(png),
    });
    await field("图像适配").selectOption("fill");
    await layer("Ink").click({ modifiers: ["Shift"] });
    await button("用作位图蒙版").click();
    verifyPixels(await samples("data-node-id"), [0, 0, 127, 255]);
    await field("蒙版类型").selectOption("luminance");
    verifyPixels(await samples("data-node-id"), [0, 255, 191, 255]);
    await button("撤销").click();
    verifyPixels(await samples("data-node-id"), [0, 0, 127, 255]);
    await button("重做").click();
    await layer("Type").click();
    const { readFile } = await import("node:fs/promises");
    const fixture =
      (process.env.INIT_CWD ?? process.cwd()) +
      "/scripts/fixtures/roboto-flex/RobotoFlex.ttf";
    await page.locator('input[accept=".ttf,.otf"]').setInputFiles({
      name: "Roboto Flex.ttf",
      mimeType: "font/ttf",
      buffer: await readFile(fixture),
    });
    await page.getByText(/^字体轴 ·/).click();
    await edit("wdth 轴值", 25);
    const narrow = (await geom("data-node-id", "Type"))[2];
    await edit("wdth 轴值", 151);
    const wide = (await geom("data-node-id", "Type"))[2];
    assert(wide > narrow + 5, "variable width ignored " + [narrow, wide]);
    await page.getByText(/^OpenType 字形 ·/).click();
    await field("字体特性 liga").selectOption("0");
    await field("wdth 轴值").scrollIntoViewIfNeeded();
    await page
      .locator("#right-panel")
      .screenshot({ path: "output/playwright/font-axis-panel.png" });
    await page.getByText("高级字体设置", { exact: true }).click();
    assert(
      (await field("OpenType 特性").inputValue()).includes('"liga" 0'),
      "feature toggle did not update the active text",
    );
    await node("data-node-id", "Type").dblclick();
    const inline = field("画布文本编辑");
    await inline.press("ArrowLeft");
    await inline.press("Shift+ArrowRight");
    await inline.press("Shift+ArrowRight");
    await button("选区字体设置").click();
    await edit("选区字距", 3);
    await edit("选区可变字体轴", '"wdth" 72');
    await button("提交文字").click();
    const richWidth = (await geom("data-node-id", "Type"))[2];
    await page.getByTitle(/^已保存到(此浏览器|本机)$/).waitFor();
    await page.reload();
    await layer("Workspace").click();
    assert(
      (await geom("data-node-id", "Type"))[2] === richWidth,
      "font width changed after reload",
    );
    verifyPixels(await samples("data-node-id"), [0, 255, 191, 255]);
    const [download] = await Promise.all([
      Promise.race([
        page.waitForEvent("download"),
        page
          .getByRole("alert")
          .waitFor()
          .then(async () => {
            throw Error(await page.getByRole("alert").innerText());
          }),
      ]),
      button("导出 React 项目").click(),
    ]);
    await download.saveAs("output/playwright/professional-editor-check.zip");
    await button("预览").click();
  }
  const sizes = [];
  for (const w of [375, 390, 768, 1024, 1440]) {
    if (editing) await field("预览视口宽度").selectOption(String(w));
    else await page.setViewportSize({ width: w, height: 900 });
    await page.waitForFunction(
      (w) =>
        document.querySelector('[data-design-id="Detail"]')?.offsetWidth ===
        (w <= 600 ? w : w - 252),
      w,
    );
    const bounds = await geom("data-design-id", "Detail");
    assert(
      bounds.join() ===
        [w <= 600 ? 0 : 252, 164, w <= 600 ? w : w - 252, 56].join(),
      "Responsive grid " + bounds,
    );
    const rendered = await node("data-design-id", "Type").evaluate(
      async (el) => {
        await document.fonts.ready;
        const css = getComputedStyle(el);
        return {
          loaded: [...document.fonts].some(
            (f) => f.status === "loaded" && css.fontFamily.includes(f.family),
          ),
          axis: css.fontVariationSettings,
          features: css.fontFeatureSettings,
          run: [...el.querySelectorAll("span")].find(
            (s) =>
              s.textContent === "设计" &&
              getComputedStyle(s).letterSpacing === "3px",
          )?.style.fontVariationSettings,
        };
      },
    );
    assert(
      rendered.loaded &&
        rendered.axis.includes("151") &&
        rendered.features.includes("liga") &&
        rendered.run?.includes("72"),
      "Font did not load " + JSON.stringify(rendered),
    );
    verifyPixels(await samples("data-design-id"), [0, 255, 191, 255]);
    sizes.push([w, ...bounds]);
  }
  return { sizes, mask: ["alpha", "luminance"], variableFont: true };
};
