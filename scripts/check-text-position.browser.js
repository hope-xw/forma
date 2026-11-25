async (page) => {
  const assert = (await import("node:assert/strict")).default;
  const { PNG } = (await import("playwright-core/lib/utilsBundle")).default;
  const button = (name) => page.getByRole("button", { name, exact: true });
  const textbox = page.getByRole("textbox", { name: "画布文本编辑" });
  const layer = (id) => page.locator(`.editor-canvas [data-node-id="${id}"]`);
  const rects = (el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const result = [];
    while (walker.nextNode()) {
      const text = walker.currentNode;
      for (let i = 0; i < text.length; i++) {
        const range = document.createRange();
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        const r = range.getBoundingClientRect();
        result.push([r.x, r.y, r.width, r.height]);
      }
    }
    return result;
  };
  const difference = (a, b) => {
    assert.equal(a.length, b.length);
    return Math.max(
      ...a.flatMap((r, i) => r.map((v, j) => Math.abs(v - b[i][j]))),
    );
  };
  // A bottom-aligned label with a final newline contains two 21px lines.
  async function checkFinalLine(attr) {
    const styled = page.locator(`[${attr}="trailing"]`);
    assert.equal(await styled.textContent(), "最后一行\n");
    const layerBox = await styled.boundingBox();
    const first = (await styled.locator(":scope > span").evaluate(rects))[0];
    const top = (first[1] - layerBox.y) / (layerBox.width / 150);
    assert.ok(Math.abs(top) < 6, "first line offset in design pixels: " + top);
    return top;
  }
  if (!(await page.locator(".editor-canvas").count()))
    return checkFinalLine("data-design-id");
  const results = [];
  async function compare(id, pixels = false) {
    const node = layer(id);
    const position = await node.boundingBox();
    const before = await node.locator(":scope > span").last().evaluate(rects);
    const capture = async (phase) =>
      PNG.sync.read(
        await page.screenshot({
          clip: position,
          caret: "hide",
          path:
            id === "wrapped" &&
            (await page.locator(".zoom-readout").innerText()) === "100%"
              ? `output/playwright/text-position-${phase}.png`
              : undefined,
        }),
      );
    const shot = pixels ? await capture("display") : null;
    await node.dblclick();
    await textbox.waitFor();
    await textbox.evaluate(() => window.getSelection().collapseToStart());
    const editing = await textbox.evaluate(rects);
    let changedInkPixels = 0;
    if (shot) {
      const current = await capture("editing");
      assert.equal(current.data.length, shot.data.length);
      // The fixtures use dark neutral ink on white. Exclude the editor's colored outlines and handles.
      const ink = (rgb, i) =>
        rgb[i] === rgb[i + 1] && rgb[i] === rgb[i + 2] && rgb[i] < 200;
      for (let i = 0; i < shot.data.length; i += 4) {
        if (
          (ink(shot.data, i) || ink(current.data, i)) &&
          Math.abs(shot.data[i] - current.data[i]) > 1
        )
          changedInkPixels++;
      }
    }
    await textbox.press("Escape");
    await textbox.waitFor({ state: "detached" });
    const after = await node.locator(":scope > span").last().evaluate(rects);
    results.push({
      id,
      zoom: await page.locator(".zoom-readout").innerText(),
      editDelta: difference(before, editing),
      commitDelta: difference(before, after),
      changedInkPixels: pixels ? changedInkPixels : null,
    });
  }

  await page.goto(
    new URL("?example=aura-showcase&page=workspace&node=ws-modal-h", page.url())
      .href,
  );
  await layer("ws-modal-h").waitFor();
  await compare("ws-modal-h");
  const style = {
    layout: "free",
    x: 0,
    y: 0,
    width: 420,
    height: 310,
    padding: 0,
    gap: 0,
    fontSize: 17,
    fill: "#ffffff",
    color: "#202020",
    radius: 0,
  };
  const make = (id, parentId, type, text, props = {}) => ({
    id,
    name: id,
    parentId,
    type,
    text,
    hidden: false,
    locked: false,
    style: { ...style, ...props },
  });
  const nodes = [
    make("paper", null, "frame", ""),
    make("fixed", "paper", "text", "正文 Text AV 123", {
      x: 48.25,
      y: 24.5,
      width: 185.5,
      height: 36,
      lineHeight: 24,
    }),
    make("wrapped", "paper", "text", "换行 Type example 123\n中文 AV text", {
      x: 102.5,
      y: 77.25,
      width: 122.75,
      height: 95,
      verticalAlign: "middle",
      textAlign: "center",
      lineHeight: 25,
      strokeWidth: 2,
      stroke: "#dddddd",
      textTransform: "uppercase",
    }),
    make(
      "clamped",
      "paper",
      "text",
      "最多显示两行文字，底部对齐\n第三行继续编辑。",
      {
        x: 256,
        y: 65.5,
        width: 122,
        height: 90,
        lineHeight: 21,
        textAlign: "right",
        verticalAlign: "bottom",
        maxLines: 2,
      },
    ),
    make("empty", "paper", "text", "", {
      x: 55,
      y: 150,
      width: 120,
      height: 35,
    }),
    make("trailing", "paper", "text", "最后一行\n", {
      x: 250,
      y: 148,
      width: 150,
      height: 42,
      verticalAlign: "bottom",
      lineHeight: 21,
    }),
    make("hug-end", "paper", "text", "Hug\n", {
      x: 256,
      y: 10,
      width: 110,
      heightMode: "hug",
      lineHeight: 21,
    }),
    make("tilted", "paper", "frame", "", {
      x: 44,
      y: 189,
      width: 270,
      height: 100,
      rotation: 7,
      layout: "column",
      padding: 12.5,
      gap: 6.5,
      alignX: "end",
    }),
    {
      ...make("rich", "tilted", "text", "混排 Title 23", {
        widthMode: "hug",
        heightMode: "hug",
        fontStyle: "italic",
      }),
      textRuns: [
        {
          start: 0,
          end: 2,
          style: { fontSize: 23, fontWeight: 700, letterSpacing: 1 },
        },
      ],
    },
    make("action", "tilted", "button", "确认 Okay", {
      width: 153,
      height: 34,
      fill: "#ffffff",
      fontWeight: 600,
    }),
  ];
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "text-position.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        id: "text-position",
        name: "Text position",
        schemaVersion: 1,
        revision: 0,
        tokens: {},
        nodes,
      }),
    ),
  });
  await layer("paper").waitFor();
  // Remove pointer/selection adornments from the ink comparison, without changing text layout.
  await page.addStyleTag({
    content:
      ".selection-overlay,.frame-label{visibility:hidden!important}.editor-canvas .design-node[data-editing-text]{outline:none!important}",
  });
  for (const zoom of [50, 100, 200]) {
    await button("缩放与视图选项").click();
    await page
      .getByRole("menuitem", { name: new RegExp("缩放至 " + zoom + "%") })
      .click();
    for (const id of [
      "fixed",
      "wrapped",
      "clamped",
      "rich",
      "action",
      "trailing",
    ])
      await compare(id, true);
  }
  for (const r of results)
    assert.ok(
      r.editDelta < 0.02 && r.commitDelta < 0.02 && !r.changedInkPixels,
      JSON.stringify(results),
    );
  // A blank text box and clicks in unused space must continue to accept input.
  await layer("empty").dblclick();
  await layer("empty").click({ position: { x: 3, y: 4 } });
  assert.ok(await textbox.evaluate((el) => el === document.activeElement));
  await page.keyboard.insertText("第一行");
  await textbox.press("Enter");
  await page.keyboard.insertText("Second line");
  const draft = await textbox.evaluate(rects);
  await textbox.press("Control+Enter");
  const saved = layer("empty").locator(":scope > span");
  assert.equal(await saved.textContent(), "第一行\nSecond line");
  assert.ok(difference(draft, await saved.evaluate(rects)) < 0.02);
  await button("撤销").click();
  assert.equal(await layer("empty").textContent(), "");
  await button("重做").click();
  assert.equal(await saved.textContent(), "第一行\nSecond line");
  const hug = layer("hug-end");
  await button("选择图层 hug-end").click();
  const heightInput = page.getByRole("textbox", { name: "高度", exact: true });
  assert.equal(Number(await heightInput.inputValue()), 42);
  assert.equal(await hug.evaluate((el) => el.offsetHeight), 42);
  await hug.dblclick();
  await textbox.press("Backspace");
  assert.equal(await hug.evaluate((el) => el.offsetHeight), 21);
  await textbox.press("Control+Enter");
  assert.equal(await hug.evaluate((el) => el.offsetHeight), 21);
  assert.equal(Number(await heightInput.inputValue()), 21);
  await button("撤销").click();
  assert.equal(await hug.textContent(), "Hug\n");
  const canvasTop = await checkFinalLine("data-node-id");
  await button("选择图层 paper").click();
  await button("预览").click();
  const previewTop = await checkFinalLine("data-design-id");
  assert.ok(Math.abs(canvasTop - previewTop) < 0.05);
  await button("关闭预览").click();
  const downloaded = page.waitForEvent("download");
  await button("导出 React 项目").click();
  await (await downloaded).saveAs("output/playwright/text-position-check.zip");
  return {
    samples: results,
    trailingLine: { canvasTop, previewTop },
    multilineUndoRedo: true,
  };
};
