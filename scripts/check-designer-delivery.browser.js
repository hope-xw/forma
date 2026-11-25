async (page) => {
  const assert = (test, message) => {
    if (!test) throw Error(message);
  };
  const button = (name) => page.getByRole("button", { name, exact: true });
  const byId = (id) => page.locator('[data-design-id="' + id + '"]');
  const editing = !!(await page.locator(".editor-canvas").count());
  const editNumber = async (name, value) => {
    const field = page.getByRole("textbox", { name, exact: true });
    await field.fill(String(value));
    await field.press("Enter");
  };
  if (editing) {
    const system = await page.evaluate(
      async () =>
        (await (await fetch("/examples/aura-showcase.forma.json")).json())
          .designSystem,
    );
    const style = {
      x: 0,
      y: 0,
      width: 90,
      height: 40,
      layout: "free",
      radius: 0,
      padding: 0,
      gap: 0,
      fontSize: 16,
      color: "#ffffff",
      fill: "#21252c",
    };
    const node = (id, parentId, type, patch) => ({
      id,
      parentId,
      type,
      name: id,
      text: "",
      locked: false,
      hidden: false,
      style: { ...style, ...patch },
    });
    const board = node("Feedback", null, "frame", {
      width: 768,
      height: 400,
      layout: "grid",
      columns: 3,
      gap: 12,
      viewportWidth: true,
    });
    const card = node("Card", "Feedback", "rectangle", {
      widthMode: "fill",
      heightMode: "fill",
      columnSpan: 2,
    });
    const name = node("Name", "Feedback", "rectangle", { widthMode: "fill" });
    name.control = { kind: "textfield", value: "", label: "联系邮箱" };
    const submit = node("Submit", "Feedback", "button", { widthMode: "fill" });
    submit.text = "发送";
    submit.control = { kind: "button", label: "提交表单", value: false };
    const doc = {
      schemaVersion: 1,
      id: "feedback-delivery",
      name: "反馈表单",
      revision: 0,
      nodes: [board, card, name, submit],
      tokens: {},
      designSystem: system,
    };
    await page.locator('[data-testid="design-file-input"]').setInputFiles({
      name: "feedback.forma.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await button("选择图层 Feedback").click();
    const divider = page.getByRole("separator", { name: "属性栏宽度" }),
      panel = page.locator("#right-panel");
    const box = await divider.boundingBox(),
      start = (await panel.boundingBox()).width;
    await page.mouse.move(box.x + 3, box.y + 120);
    await page.mouse.down();
    await page.mouse.move(box.x - 37, box.y + 120);
    await page.mouse.up();
    assert(
      (await panel.boundingBox()).width === start + 40,
      "panel pointer resize",
    );
    await divider.focus();
    await divider.press("ArrowLeft");
    assert(
      (await panel.boundingBox()).width === start + 48,
      "panel keyboard resize",
    );
    await divider.press("Control+Shift+Backslash");
    await panel.waitFor({ state: "hidden" });
    assert(
      await page
        .locator(".editor-canvas")
        .evaluate((el) => el === document.activeElement),
      "canvas focus after hiding panels",
    );
    await page.keyboard.press("Control+Shift+Backslash");
    await panel.waitFor();
    await page.getByLabel("网格行高模式").selectOption("fixed");
    await editNumber("每行高度", 48);
    await page.getByText("容器断点", { exact: true }).click();
    await button("添加断点").click();
    for (const [label, value] of [
      ["最大宽度", 600],
      ["间距", 8],
    ]) {
      const rule = page.getByLabel("断点 1 " + label, { exact: true });
      await rule.fill(String(value));
      await rule.press("Enter");
    }
    await button("创建grid样式").click();
    await page.getByLabel("新样式名称").fill("Layout/Feedback");
    await button("创建").click();
    assert(
      (await page
        .getByLabel("grid样式", { exact: true })
        .locator("option:checked")
        .innerText()) === "Layout/Feedback",
      "grid style not applied",
    );
    await button("选择图层 Card").click();
    await editNumber("跨行数", 2);
    await button("撤销").click();
    assert(
      (await page.getByLabel("跨行数", { exact: true }).inputValue()) === "1",
      "row span undo",
    );
    await button("重做").click();
    await page.getByLabel("填充类型", { exact: true }).selectOption("linear");
    await page.getByLabel("色标 1 颜色变量").selectOption("bgSurface");
    await button("选择图层 Feedback").click();
    const theme = page.getByLabel("模式 Theme", { exact: true });
    const cardPaint = () =>
      page
        .locator('[data-node-id="Card"]')
        .evaluate((el) => getComputedStyle(el).backgroundImage);
    await theme.selectOption("dark");
    const dark = await cardPaint();
    await theme.selectOption("light");
    assert(dark !== (await cardPaint()), "gradient ignored parent theme");
    await theme.selectOption("dark");
    assert(dark === (await cardPaint()), "gradient mode did not round trip");
    await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
    await page.reload();
    await button("选择图层 Feedback").click();
    assert(
      (await panel.boundingBox()).width === start + 48,
      "panel width reset after reload",
    );
    const download = async (action) => {
      const pending = page.waitForEvent("download");
      await action();
      return await pending;
    };
    await page.getByLabel("文件菜单", { exact: true }).click();
    const original = await download(() =>
      button("导出整个文件为 React 项目…").click(),
    );
    const { readFile } = await import("node:fs/promises");
    const { unzipSync, zipSync, strToU8, strFromU8 } = await import("fflate");
    const project = unzipSync(await readFile(await original.path()));
    const root = process.env.INIT_CWD ?? process.cwd();
    const hook = await readFile(
      root + "/scripts/fixtures/feedback/business.ts.txt",
      "utf8",
    );
    const client = await readFile(
      root + "/scripts/fixtures/feedback/feedback-client.ts.txt",
      "utf8",
    );
    project["src/business.ts"] = strToU8(hook);
    project["src/feedback-client.ts"] = strToU8(client);
    project["src/handwritten.txt"] = strToU8("developer file");
    await button("选择图层 Card").click();
    await editNumber("跨列数", 3);
    const update = async (files) => {
      await page.getByLabel("文件菜单", { exact: true }).click();
      const pick = page.waitForEvent("filechooser");
      await button("更新已有 React 工程…").click();
      await (
        await pick
      ).setFiles({
        name: "feedback-source.zip",
        mimeType: "application/zip",
        buffer: Buffer.from(zipSync(files)),
      });
    };
    await update({ ...project, ["src/Page1.tsx"]: strToU8("local changes") });
    await page
      .getByRole("alert")
      .filter({ hasText: "src/Page1.tsx" })
      .waitFor();
    await button("关闭错误").click();
    const changed = await download(() => update(project));
    const merged = unzipSync(await readFile(await changed.path()));
    assert(
      strFromU8(merged["src/business.ts"]) === hook &&
        strFromU8(merged["src/feedback-client.ts"]) === client &&
        strFromU8(merged["src/handwritten.txt"]) === "developer file",
      "business code lost",
    );
    await changed.saveAs("output/playwright/designer-delivery-check.zip");
    await button("预览").click();
  }
  const samples = [];
  for (const width of [375, 390, 768, 1024, 1440]) {
    if (editing)
      await page.getByLabel("预览视口宽度").selectOption(String(width));
    else await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(
      ({ w, narrow }) => {
        const board = document.querySelector('[data-design-id="Feedback"]'),
          card = document.querySelector('[data-design-id="Card"]');
        if (!board || !card) return false;
        const style = getComputedStyle(board);
        return (
          board.offsetWidth === w &&
          style.gridTemplateColumns.split(" ").length === (narrow ? 1 : 3) &&
          card.offsetHeight === (narrow ? 104 : 108)
        );
      },
      { w: width, narrow: width <= 600 },
      { timeout: 4000 },
    );
    const metrics = await byId("Card").evaluate((el) => [
      el.offsetWidth,
      el.offsetHeight,
      el.nextElementSibling.offsetTop,
      getComputedStyle(el).backgroundImage,
    ]);
    assert(
      metrics[0] === width && metrics[2] === (width <= 600 ? 112 : 120),
      "grid spacing " + JSON.stringify(metrics),
    );
    assert(metrics[3].includes("gradient"), "missing gradient after merge");
    samples.push(metrics.slice(0, 3));
  }
  if (!editing) {
    const reactsToToken = await byId("Card").evaluate((el) => {
      const before = getComputedStyle(el).backgroundImage;
      el.style.setProperty("--aura-bg-surface", "#02f38b");
      const changed = getComputedStyle(el).backgroundImage !== before;
      el.style.removeProperty("--aura-bg-surface");
      return changed;
    });
    assert(reactsToToken, "exported gradient lost its CSS variable");
    const email = page.getByRole("textbox", { name: "联系邮箱" });
    const status = page.getByRole("status");
    const received = [];
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === "/api/feedback")
        received.push(req.postDataJSON().email);
    });
    await email.fill("incomplete");
    await button("提交表单").click();
    await status.getByText("请输入完整邮箱", { exact: true }).waitFor();
    assert(!received.length, "invalid address reached API");
    await email.fill("unavailable@example.test");
    await button("提交表单").click();
    await status.getByText("提交失败，请重试", { exact: true }).waitFor();
    await page
      .getByRole("textbox", { name: "联系邮箱" })
      .fill("designer@example.test");
    assert(
      (await page.locator("body").getAttribute("data-last-form-event")) ===
        "Name=designer@example.test",
      "form input handler lost",
    );
    await button("提交表单").click();
    assert(
      (await page.locator("body").getAttribute("data-last-form-event")) ===
        "Submit=true",
      "submit handler lost",
    );
    await status.getByText("已收到反馈", { exact: true }).waitFor();
    assert(
      received.join() === "unavailable@example.test,designer@example.test",
      "unexpected requests " + received,
    );
  }
  return {
    samples,
    verified: editing
      ? "designer edit, undo, reopen, update, conflict and preview"
      : "rebuilt project, responsive layout and handwritten callbacks",
  };
};
