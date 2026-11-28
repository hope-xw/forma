async (page) => {
  const { strict: assert } = await import("node:assert");
  const { tsImport } = await import("tsx/esm/api");
  const { pathToFileURL } = await import("node:url");
  const path = await import("node:path");
  const owner = pathToFileURL(
    path.join(
      process.env.FORMA_REPO_ROOT,
      "scripts/check-inspector-ux.browser.js",
    ),
  ).href;
  const [
    { createStarter },
    { createNode, parseDocument },
    { instantiateComponent },
    { transact },
  ] = await Promise.all(
    ["seed", "document", "library", "commands"].map((name) =>
      tsImport("../src/domain/" + name + ".ts", owner),
    ),
  );
  const button = (name) => page.getByRole("button", { name, exact: true });
  const panel = page.locator(".app:visible .right-panel");
  const stage = page.locator(".app:visible .canvas-stage");
  const file = page.locator('.app:visible [data-testid="design-file-input"]');
  const load = (doc) =>
    file.setInputFiles({
      name: "inspector.forma.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
  const row = (id) =>
    page.locator(`.app:visible [data-layer-id="${id}"] .layer-main`);
  const drawing = (id) => stage.locator(`[data-node-id="${id}"]`);
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  let doc = createStarter();
  const title = doc.nodes.find((n) => n.text === "让好设计，发生。");
  const board = doc.nodes.find((n) => n.id === title.parentId);
  await load(doc);
  async function select(id) {
    if (!(await row(id).count())) {
      const parent = doc.nodes.find(
        (n) => n.id === doc.nodes.find((child) => child.id === id)?.parentId,
      );
      if (parent) {
        const expand = button("展开 " + parent.name);
        if (await expand.count()) await expand.first().click();
      }
    }
    await row(id).click();
  }
  await drawing(title.id).waitFor({ state: "attached" });
  await button("隐藏页面背景").click();
  const pageColor = panel.getByLabel("页面背景色 HEX", { exact: true });
  await pageColor.fill("BBCCDD");
  await pageColor.press("Enter");
  assert.equal(await pageColor.inputValue(), "BBCCDD");
  assert.ok(
    await button("显示页面背景").isVisible(),
    "editing page color preserves hidden visibility",
  );
  await select(title.id);
  await button("文字转轮廓").click();
  const outlined = stage.locator(
    `[data-node-id="${title.id}"][data-node-type="vector"]`,
  );
  await outlined.waitFor({ timeout: 30000 });
  const paths = await outlined
    .locator("svg path[d]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("d")));
  assert.ok(
    paths.some(
      (d) =>
        (d.match(/[Mm]/g) ?? []).length >= title.text.length &&
        /[CcLlQq]/.test(d),
    ),
    "starter title glyph contours",
  );
  await button("撤销").click();
  assert.equal(await drawing(title.id).getAttribute("data-node-type"), "text");
  assert.equal((await drawing(title.id).textContent()).trim(), title.text);

  // A real exposed slot with 42 choices takes the searchable picker path.
  const input = createNode("rectangle", board.id),
    toggle = createNode("rectangle", board.id);
  input.name = "Email";
  input.control = { kind: "textfield", label: "Email", value: "hello" };
  toggle.name = "Notifications";
  toggle.control = {
    kind: "switch",
    label: "Notifications",
    value: true,
    disabled: true,
  };
  doc.nodes.push(input, toggle);
  const template = createNode("frame"),
    slot = createNode("frame", template.id);
  template.name = "Slot owner";
  template.templateKey = "root";
  slot.templateKey = "slot";
  slot.nestedSlot = true;
  const component = (id, variants) => ({
    id,
    name: id,
    description: "",
    category: "Components",
    variants,
  });
  const variant = (id, nodes) => ({ id, name: id, properties: {}, nodes });
  const library = {
    format: "forma/library",
    version: 1,
    id: "ux-lib",
    name: "UI",
    description: "Inspector fixture",
    revision: 1,
    source: { name: "Forma", license: "MIT" },
    components: [
      {
        ...component("owner", [variant("default", [template, slot])]),
        exposed: [{ id: "swap", name: "图标", kind: "swap", target: "slot" }],
      },
      component(
        "icons",
        Array.from({ length: 42 }, (_, i) =>
          variant("Icon-" + i, [
            { ...createNode("frame"), templateKey: "root" },
          ]),
        ),
      ),
    ],
  };
  const instance = instantiateComponent(
    doc,
    library,
    "owner",
    "default",
    null,
    { x: 940, y: 100 },
  );
  doc = parseDocument(
    transact(doc, {
      baseRevision: doc.revision,
      operations: instance.operations,
    }),
  );
  await load(doc);
  await row(instance.id).waitFor();
  const viewports = [
    [1440, 900],
    [1280, 720],
    [1024, 600],
    [1024, 480],
  ];
  const checks = [
    ["fill", title.id, "编辑填充颜色", ".color-popover"],
    ["token", title.id, "绑定变量 width", ".binding-popover"],
    ["style", title.id, "应用或新建文字样式", ".binding-popover"],
    ["type", title.id, "更多文字样式设置", ".type-details-popover"],
    ["slot", instance.id, "实例属性 图标", ".slot-swap-popover"],
  ];
  const box = async (el) => {
    const r = await el.boundingBox();
    assert.ok(
      r && r.width > 0 && r.height > 0,
      "expected a visible bounding box",
    );
    return r;
  };
  const inside = (r, outer) =>
    r.x >= outer.x &&
    r.y >= outer.y &&
    r.x + r.width <= outer.x + outer.width &&
    r.y + r.height <= outer.y + outer.height;
  async function bounded(popup, label) {
    await settle();
    const { width, height } = page.viewportSize();
    const r = await box(popup);
    const inset = 12 - 1; // Configured viewport margin minus subpixel tolerance.
    assert.ok(
      inside(r, {
        x: inset,
        y: inset,
        width: width - 2 * inset,
        height: height - 2 * inset,
      }),
      label + " " + JSON.stringify(r),
    );
  }
  async function lastReachable(popup) {
    const controls = popup.locator(
      'button:visible:enabled,input:visible:enabled,select:visible:enabled,textarea:visible:enabled,[tabindex="0"]:visible',
    );
    const n = await controls.count();
    assert.ok(n > 0);
    if (n > 1) {
      await controls.nth(n - 2).focus();
      await page.keyboard.press("Tab");
    } else await controls.last().focus();
    const last = controls.last();
    assert.ok(
      await last.evaluate((el) => el === document.activeElement),
      "Tab reaches the final control",
    );
    await last.scrollIntoViewIfNeeded();
    assert.ok(
      await last.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return el.contains(
          document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2),
        );
      }),
      "final control is visible and hit-testable",
    );
  }
  async function dragEdges(popup) {
    const header = popup.locator(".panel-heading");
    const h = await box(header);
    const { width, height } = page.viewportSize();
    let x = h.x + 15,
      y = h.y + h.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const [axis, direction] of [
      ["x", -1],
      ["x", 1],
      ["y", -1],
      ["y", 1],
    ]) {
      const initial = await box(popup);
      if (
        (axis === "x" ? width - initial.width : height - initial.height) <= 25
      )
        continue;
      if (axis === "x") x = direction * (width * 3);
      else y = direction * (height * 3);
      await page.mouse.move(x, y);
      await bounded(popup, "drag limit");
      const atEdge = await box(popup);
      if (axis === "x") x -= direction * 2;
      else y -= direction * 2;
      await page.mouse.move(x, y);
      await settle();
      const back = await box(popup);
      assert.ok(
        Math.abs(back[axis] - atEdge[axis] + direction * 2) < 0.6,
        "2px reversal must immediately move the picker at " + axis + direction,
      );
    }
    await page.mouse.up();
  }
  async function toastWhileOpen(popup) {
    await panel.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await settle();
    assert.ok(
      await panel.evaluate(
        (el) =>
          el.scrollTop > 0 &&
          el.scrollHeight - el.clientHeight - el.scrollTop < 2,
      ),
    );
    await file.setInputFiles({
      name: "invalid.forma.json",
      mimeType: "application/json",
      buffer: Buffer.from("{"),
    });
    const host = page.locator(".app:visible .forma-toast-host");
    const card = host.getByRole("alert");
    await card.waitFor();
    await settle();
    const canvas = await box(stage),
      anchor = await box(host),
      message = await box(card);
    assert.ok(
      Math.abs(anchor.x + anchor.width / 2 - canvas.x - canvas.width / 2) < 1,
    );
    assert.ok(Math.abs(anchor.y - canvas.y - 12) < 1);
    assert.ok(inside(message, canvas), "toast card inside active canvas");
    for (const obstacle of [
      panel,
      popup,
      page.locator(".app:visible .toolbar:visible").first(),
    ]) {
      const r = await box(obstacle);
      const overlap =
        Math.max(
          0,
          Math.min(r.x + r.width, message.x + message.width) -
            Math.max(r.x, message.x),
        ) *
        Math.max(
          0,
          Math.min(r.y + r.height, message.y + message.height) -
            Math.max(r.y, message.y),
        );
      assert.equal(
        overlap,
        0,
        "toast overlaps " + (await obstacle.getAttribute("class")),
      );
    }
    // Dismissing with the keyboard avoids an outside pointerdown on the picker.
    await card.getByRole("button").press("Enter");
  }
  let cases = 0,
    toasts = 0;
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height });
    for (const inspectorWidth of [256, 280]) {
      const divider = page.getByRole("separator", { name: "属性栏宽度" });
      await divider.press("Home");
      for (let w = 256; w < inspectorWidth; w += 8)
        await divider.press("ArrowLeft");
      await settle();
      assert.equal((await box(panel)).width, inspectorWidth);
      for (const [kind, id, label, selector] of checks) {
        await select(id);
        const trigger = panel.getByRole("button", { name: label, exact: true });
        await trigger.evaluate((el) => el.scrollIntoView({ block: "end" }));
        await trigger.click();
        const popup = page.locator(selector + ":visible");
        await bounded(popup, `${kind} ${width}x${height}/${inspectorWidth}`);
        if (kind === "fill")
          assert.ok(
            (await popup.getByRole("button", { name: /^使用颜色 / }).count()) >
              1,
          );
        const delta = await panel.evaluate((el) => {
          const before = el.scrollTop;
          el.scrollTop = before > 40 ? before - 37 : before + 37;
          return el.scrollTop - before;
        });
        assert.notEqual(delta, 0, "Inspector scrolls with picker open");
        await bounded(popup, "after Inspector scroll");
        await page.setViewportSize({ width: width - 16, height: height + 12 });
        await bounded(popup, "after resize");
        await page.setViewportSize({ width, height });
        await bounded(popup, "after restoring viewport");
        await lastReachable(popup);
        if (kind === "fill") {
          if (height === 480) {
            await toastWhileOpen(popup);
            toasts++;
          }
          await dragEdges(popup);
        }
        await popup.locator("button:visible:enabled").first().focus();
        await page.keyboard.press("Escape");
        await popup.waitFor({ state: "detached" });
        if (kind === "type")
          assert.ok(
            await trigger.evaluate((el) => el === document.activeElement),
          );
        cases++;
      }
    }
  }
  await select(input.id);
  await row(toggle.id).click({ modifiers: ["Shift"] });
  const more = panel
    .locator("details")
    .filter({ has: page.getByText("更多属性", { exact: true }) });
  if (!(await more.evaluate((el) => el.open)))
    await more.locator("summary").click();
  const name = panel.getByLabel("可访问名称", { exact: true });
  assert.equal(await name.getAttribute("placeholder"), "Mixed");
  await name.fill("共享标签");
  await name.press("Enter");
  await select(board.id);
  await button("预览").click();
  const checked = page.getByRole("switch", { name: "共享标签" });
  assert.equal(await checked.getAttribute("aria-checked"), "true");
  assert.ok(await checked.isDisabled());
  assert.equal(
    await page.getByRole("textbox", { name: "共享标签" }).inputValue(),
    "hello",
  );
  assert.deepEqual(errors, []);
  return {
    popupCases: cases,
    toastCases: toasts,
    outlinedAndUndone: true,
    mixedControlsPreserved: true,
  };
};
