async (page) => {
  const { strict: assert } = await import("node:assert");
  const { readFile } = await import("node:fs/promises");
  const stage = page.locator(".editor-canvas");
  const world = stage.locator(".canvas-world");
  const map = page.getByTestId("canvas-minimap");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const wide = { width: 1920, height: 960 };
  const short = { width: 1024, height: 480 };
  const frame = () => page.evaluate(() => new Promise(requestAnimationFrame));
  const settle = async () => {
    await frame();
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".editor-canvas")
          .classList.contains("is-camera-moving") &&
        document.querySelector(".canvas-live-overlays").style.transform === "",
    );
  };
  const zoom = async () => Number(await stage.getAttribute("data-zoom"));
  const camera = () =>
    world.evaluate((el) => {
      const m = new DOMMatrixReadOnly(el.style.transform);
      return { x: m.e, y: m.f, zoom: m.a };
    });
  function node(id, type, parentId, overrides) {
    return {
      id,
      name: id,
      type,
      parentId,
      hidden: false,
      locked: false,
      text: "",
      style: {
        x: 0,
        y: 0,
        width: 80,
        height: 64,
        layout: "free",
        gap: 0,
        padding: 0,
        radius: 0,
        fill: "#637196",
        color: "#17191f",
        fontSize: 16,
        ...overrides,
      },
    };
  }
  async function load(id, nodes) {
    await page.getByTestId("design-file-input").setInputFiles({
      name: id + ".forma.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          id,
          name: id,
          revision: 0,
          tokens: {},
          nodes,
        }),
      ),
    });
    await world
      .locator('[data-node-id="' + nodes[0].id + '"]')
      .waitFor({ state: "attached" });
    await page
      .getByTitle(/^已保存到(此浏览器|本机)$/)
      .first()
      .waitFor();
    await frame();
  }
  async function preset(percent) {
    await button("缩放与视图选项").click();
    await page
      .getByRole("menuitem", { name: "缩放至 " + percent + "%", exact: true })
      .click();
    assert.equal(await zoom(), percent / 100);
  }
  const boardId = "Spacing";
  const smallDoc = [
    node(boardId, "frame", null, {
      width: 360,
      height: 180,
      layout: "row",
      padding: 20,
      gap: 16,
      radius: 6,
    }),
    node("First", "rectangle", boardId, {}),
    node("Second", "rectangle", boardId, {}),
    node("Thin", "rectangle", null, { x: 361, y: 60, width: 4, height: 48 }),
  ];
  await page.setViewportSize(wide);
  await load("one-board", smallDoc);
  assert.equal(await map.count(), 0, "A small document starts collapsed");
  await stage.locator(".frame-label").click();
  await preset(100);

  const rulers = button("标尺与辅助线");
  if ((await rulers.getAttribute("aria-pressed")) !== "true")
    await rulers.click();
  await stage.locator(".strip-x text").first().waitFor({ state: "attached" });
  // Sample on distinct paint frames while the 72 ms settle timer is repeatedly reset.
  const burst = await stage.evaluate(async (el) => {
    const world = el.querySelector(".canvas-world");
    const overlay = el.querySelector(".canvas-live-overlays");
    const selection = el.querySelector(".selection-overlay");
    const board = world.querySelector('[data-node-id="Spacing"]');
    const rect = el.getBoundingClientRect();
    const anchor = {
      x: Math.round(rect.width / 2),
      y: Math.round(rect.height / 2),
    };
    const start = new DOMMatrixReadOnly(world.style.transform);
    let x = start.e,
      y = start.f,
      z = start.a;
    const baseline = Number(el.dataset.renderCount);
    let maxError = 0,
      maxDrift = 0,
      liveFrames = 0;
    for (let i = 0; i < 30; i++) {
      const pinch = i % 3 === 1;
      const dy = pinch ? -4 : 3;
      el.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: rect.x + anchor.x,
          clientY: rect.y + anchor.y,
          ctrlKey: pinch,
          deltaX: 2,
          deltaY: dy,
        }),
      );
      if (pinch) {
        const ratio = Math.exp(-dy * 0.01);
        x = anchor.x + (x - anchor.x) * ratio;
        y = anchor.y + (y - anchor.y) * ratio;
        z *= ratio;
      } else {
        x -= 2;
        y -= dy;
      }
      await new Promise(requestAnimationFrame);
      const live = new DOMMatrixReadOnly(world.style.transform);
      maxError = Math.max(
        maxError,
        Math.abs(live.e - x),
        Math.abs(live.f - y),
        Math.abs(live.a - z),
        Math.abs(Number(el.dataset.zoom) - z),
        Math.abs(
          Number(overlay.style.getPropertyValue("--live-overlay-inv-scale")) *
            (z / start.a) -
            1,
        ),
      );
      const ruler = el
        .querySelector(".ruler-strip .ruler-selection")
        .getBoundingClientRect();
      const origin = el.querySelector(".strip-x").getBoundingClientRect();
      maxDrift = Math.max(maxDrift, Math.abs(ruler.x - origin.x - live.e));
      const selected = selection.getBoundingClientRect(),
        actual = board.getBoundingClientRect();
      maxDrift = Math.max(
        maxDrift,
        Math.abs(actual.left - selected.left),
        Math.abs(actual.top - selected.top),
      );
      if (el.classList.contains("is-camera-moving") && overlay.style.transform)
        liveFrames++;
    }
    return {
      events: 30,
      liveFrames,
      renders: Number(el.dataset.renderCount) - baseline,
      maxError,
      maxDrift,
      x,
      y,
      z,
    };
  });
  assert.equal(burst.liveFrames, burst.events);
  assert.equal(
    burst.renders,
    0,
    "Canvas rendered during the continuous wheel gesture",
  );
  assert.ok(
    burst.maxError < 0.01 && burst.maxDrift < 0.5,
    JSON.stringify(burst),
  );
  await settle();
  const stopped = await camera();
  assert.ok(
    Math.abs(burst.x - stopped.x) < 0.01 &&
      Math.abs(burst.y - stopped.y) < 0.01,
  );
  assert.ok(Math.abs((await zoom()) - burst.z) < 1e-9);
  assert.equal(
    await page.locator(".zoom-readout").innerText(),
    Math.round(burst.z * 100) + "%",
  );

  // Editing can start before the scheduled wheel paint or the settle timer fires.
  const flushed = await stage.evaluate((el) => {
    const zoom = Number(el.dataset.zoom);
    el.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -2,
      }),
    );
    el.querySelector(".frame-label").dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    return (
      !el.classList.contains("is-camera-moving") &&
      Math.abs(Number(el.dataset.zoom) - zoom * Math.exp(0.02)) < 1e-9 &&
      el.querySelector(".canvas-live-overlays").style.transform === ""
    );
  });
  assert.ok(
    flushed,
    "Pointer-down on a frame label flushes the pending camera",
  );
  await preset(100);
  await button("选择图层 Thin").click();
  const hitTest = await stage.evaluateHandle(async (el) => {
    const selection = el.querySelector(".selection-overlay");
    const thin = el.querySelector('.design-node.selected[data-node-id="Thin"]');
    const start = thin.getBoundingClientRect();
    const pinch = (deltaY) =>
      el.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          clientX: start.left,
          clientY: start.top,
          deltaY,
        }),
      );
    // Four equal pinches produce 4× before the first camera paint.
    for (let i = 0; i < 4; i++) pinch(-Math.log(4) * 25);
    await new Promise(requestAnimationFrame);
    const rect = thin.getBoundingClientRect();
    const x = Math.round(rect.left - 6);
    const ys = [
      rect.top + 4,
      (rect.top + rect.bottom) / 2,
      rect.bottom - 4,
    ].map(Math.round);
    const hits = ys.map((y) => {
      const stack = document.elementsFromPoint(x, y);
      return {
        top: stack[0]?.closest("[data-node-id]")?.dataset.nodeId,
        grips: stack.filter((e) =>
          e.closest(".resize-handle, .corner-radius-handle"),
        ).length,
      };
    });
    const edgeWidths = [".handle-n", ".handle-s"].map(
      (selector) =>
        selection.querySelector(selector).getBoundingClientRect().width,
    );
    const live = () => el.classList.contains("is-camera-moving");
    const press = {};
    const capture = { once: true, capture: true };
    window.addEventListener(
      "pointerdown",
      (event) => {
        press.live = live();
        press.target = event.target.closest("[data-node-id]")?.dataset.nodeId;
      },
      capture,
    );
    // React flushes in root capture, before capture reaches the canvas.
    el.addEventListener(
      "pointerdown",
      () => {
        press.settled =
          !live() &&
          el.querySelector(".canvas-live-overlays").style.transform === "";
      },
      capture,
    );
    // Keep the wheel gesture open across the Playwright round trip until the press flushes it.
    const hold = () => {
      if (!live()) return;
      pinch(0);
      requestAnimationFrame(hold);
    };
    requestAnimationFrame(hold);
    return {
      x,
      y: ys[0],
      live: live(),
      hits,
      width: rect.width,
      edgeWidths,
      press,
    };
  });
  const probe = await hitTest.jsonValue();
  assert.ok(probe.live);
  assert.ok(Math.abs(probe.width - 16) < 0.01, JSON.stringify(probe));
  assert.ok(
    probe.edgeWidths.every((w) => w <= probe.width),
    JSON.stringify(probe),
  );
  assert.deepEqual(probe.hits, Array(3).fill({ top: boardId, grips: 0 }));
  await page.mouse.click(probe.x, probe.y);
  const press = await hitTest.evaluate((probe) => probe.press);
  await hitTest.dispose();
  assert.deepEqual(press, { live: true, target: boardId, settled: true });
  assert.ok(Math.abs((await zoom()) - 4) < 1e-9);
  assert.equal(
    await world.locator(".design-node.selected").getAttribute("data-node-id"),
    boardId,
  );
  const priorPan = await camera();
  await stage.focus();
  const stageRect = await stage.boundingBox();
  const panStart = { x: stageRect.x + 80, y: stageRect.y + 80 };
  await page.keyboard.down("Space");
  await page.mouse.move(panStart.x, panStart.y);
  await page.mouse.down();
  await page.mouse.move(panStart.x + 40, panStart.y + 20, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await settle();
  const afterPan = await camera();
  assert.ok(
    Math.abs(afterPan.x - priorPan.x - 40) < 0.01 &&
      Math.abs(afterPan.y - priorPan.y - 20) < 0.01,
    "Space-pan preserves pointer displacement",
  );

  // Real wheel input at both clamps, and painted HUD pixels at the upper limit.
  async function zoomToLimit(direction, limit) {
    const r = await stage.boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.keyboard.down("Control");
    try {
      for (let i = 0; i < 32 && (await zoom()) !== limit; i++) {
        await page.mouse.wheel(0, direction * 100);
        await frame();
      }
    } finally {
      await page.keyboard.up("Control");
    }
    await page.waitForFunction(
      (limit) =>
        Number(document.querySelector(".editor-canvas").dataset.zoom) === limit,
      limit,
    );
    await settle();
  }
  await preset(25);
  await zoomToLimit(1, 0.02);
  await button("放大").click();
  assert.equal(await zoom(), 0.05);
  await button("缩小").click();
  assert.equal(await zoom(), 0.02);
  await preset(200);
  await zoomToLimit(-1, 64);
  const painted = await stage
    .locator(".canvas-overlay-hud")
    .evaluate((canvas) => {
      const dpr = devicePixelRatio;
      const width = Math.min(canvas.width, Math.ceil(140 * dpr));
      const ctx = canvas.getContext("2d");
      const pixels = ctx.getImageData(0, 0, width, width).data;
      let ink = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) ink++;
      return {
        ink,
        total: pixels.length / 4,
        retinaSize: canvas.width === Math.round(canvas.clientWidth * dpr),
      };
    });
  assert.ok(
    painted.retinaSize && painted.ink > 0 && painted.ink < painted.total / 4,
    JSON.stringify(painted),
  );
  await button("适应全部内容").click();
  await preset(100);
  const board = world.locator('[data-node-id="Spacing"]');
  const geometry = () =>
    board.evaluate((el) => {
      const s = getComputedStyle(el);
      const first = el
        .querySelector('[data-node-id="First"]')
        .getBoundingClientRect();
      const second = el
        .querySelector('[data-node-id="Second"]')
        .getBoundingClientRect();
      return {
        radii: [
          s.borderTopLeftRadius,
          s.borderTopRightRadius,
          s.borderBottomRightRadius,
          s.borderBottomLeftRadius,
        ].map(parseFloat),
        left: parseFloat(s.paddingLeft),
        gap: parseFloat(s.columnGap),
        firstInset: first.x - el.getBoundingClientRect().x,
        childGap: second.x - first.right,
      };
    });
  const baseline = await geometry();
  assert.deepEqual(baseline.radii, [6, 6, 6, 6]);
  assert.equal(baseline.gap, 16);
  assert.equal(baseline.left, 20);
  async function dragHandle(
    id,
    dx,
    dy,
    badgeId,
    expected,
    { alt = false, undo = true } = {},
  ) {
    const before = await geometry();
    const handle = page.getByTestId(id);
    if (alt) await page.keyboard.down("Alt");
    try {
      const box = await handle.boundingBox();
      assert.ok(box, id);
      const x = box.x + box.width / 2,
        y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      if (!undo) {
        const locked = await camera();
        await page.keyboard.down("Control");
        try {
          await page.mouse.wheel(0, -18);
        } finally {
          await page.keyboard.up("Control");
        }
        await frame();
        assert.deepEqual(await camera(), locked, id + " locks wheel zoom");
      }
      await page.mouse.move(x + dx, y + dy, { steps: 5 });
      const badge = page.getByTestId(badgeId);
      await badge
        .filter({ hasText: new RegExp(expected.badge + "$") })
        .waitFor();
      assert.match(await badge.innerText(), new RegExp(expected.badge + "$"));
      assert.deepEqual(
        await geometry(),
        { ...before, ...expected.geometry },
        id + " preview",
      );
      await page.mouse.up();
      await badge.waitFor({ state: "detached" });
      assert.deepEqual(
        await geometry(),
        { ...before, ...expected.geometry },
        id + " commit",
      );
    } finally {
      if (alt) await page.keyboard.up("Alt");
    }
    if (!undo) return;
    await stage.focus();
    await page.keyboard.press("ControlOrMeta+z");
    await frame();
    assert.deepEqual(await geometry(), before, id + " single undo");
  }
  await dragHandle("corner-handle-tl", 18, 18, "corner-radius-badge", {
    badge: 24,
    geometry: { radii: [24, 24, 24, 24] },
  });
  await dragHandle(
    "corner-handle-tr",
    -14,
    14,
    "corner-radius-badge",
    { badge: 20, geometry: { radii: [6, 20, 6, 6] } },
    { alt: true },
  );
  await dragHandle(
    "autolayout-padding-left",
    12,
    0,
    "autolayout-spacing-badge",
    { badge: 32, geometry: { left: 32, firstInset: baseline.firstInset + 12 } },
  );
  await dragHandle("autolayout-gap-0", 10, 0, "autolayout-spacing-badge", {
    badge: 26,
    geometry: { gap: 26, childGap: baseline.childGap + 10 },
  });

  await dragHandle(
    "corner-handle-tl",
    18,
    18,
    "corner-radius-badge",
    { badge: 24, geometry: { radii: [24, 24, 24, 24] } },
    { undo: false },
  );
  await dragHandle(
    "autolayout-gap-0",
    10,
    0,
    "autolayout-spacing-badge",
    { badge: 26, geometry: { gap: 26, childGap: baseline.childGap + 10 } },
    { undo: false },
  );
  const retained = await geometry();
  const [native] = await Promise.all([
    page.waitForEvent("download"),
    button("设计文件").click(),
  ]);
  assert.match(native.suggestedFilename(), /\.forma$/);
  const bytes = await readFile(await native.path());

  // Use a different open document so re-import cannot pass by reading the old canvas.
  const host = node("Rotated board", "frame", null, {
    x: 1260,
    y: -580,
    width: 540,
    height: 300,
    rotation: 12,
  });
  const glyph = node("Glyph", "vector", host.id, {
    x: 50,
    y: 76,
    width: 200,
    height: 90,
    rotation: 31,
  });
  glyph.vector = {
    width: 100,
    height: 60,
    stretch: true,
    paths: [
      { d: "M0 0 L100 0 L70 34 L100 60 L0 60 Z", fill: true, strokeWidth: 0 },
    ],
  };
  const neighbor = node("Neighbor", "rectangle", host.id, {
    x: 360,
    y: 82,
    rotation: -27,
  });
  await load("off-origin-vector", [host, glyph, neighbor]);
  await preset(100);
  const layer = world.locator('[data-node-id="Glyph"]');
  const path = layer.locator(":scope > svg > path");
  // Project the vertices of the actual saved SVG, independently of the editor's anchor overlay.
  const vertices = () =>
    path.evaluate((el) => {
      const numbers = el
        .getAttribute("d")
        .match(/-?\d+(?:\.\d+)?/g)
        .map(Number);
      const m = el.getScreenCTM();
      return numbers
        .filter((_, i) => i % 2 === 0)
        .map((x, i) => {
          const p = new DOMPoint(x, numbers[2 * i + 1]).matrixTransform(m);
          return { x: p.x, y: p.y };
        });
    });
  const original = await vertices();
  await layer.dblclick();
  const anchors = stage.locator(".vector-surface circle[data-anchor]");
  await anchors.first().waitFor();
  const positions = await anchors.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }),
  );
  const error = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  assert.equal(positions.length, 5);
  const anchorError = Math.max(
    ...positions.map((p, i) => error(p, original[i])),
  );
  assert.ok(anchorError <= 2, "Initial anchor error: " + anchorError);
  const target = 2,
    dx = 14,
    dy = -9;
  await page.mouse.move(positions[target].x, positions[target].y);
  await page.mouse.down();
  await page.mouse.move(positions[target].x + dx, positions[target].y + dy, {
    steps: 6,
  });
  await page.mouse.up();
  const savedPath = await path.getAttribute("d");
  const movedAnchor = await anchors.nth(target).boundingBox();
  const x = movedAnchor.x + movedAnchor.width / 2,
    y = movedAnchor.y + movedAnchor.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 9, y + 4, { steps: 3 });
  // A layer can disappear after pointer capture. The pending edit must not become a transaction.
  const svg = layer.locator(":scope > svg");
  await svg.evaluate((el) => {
    el.getScreenCTM = () => null;
  });
  try {
    await page.mouse.up();
    assert.equal(
      await path.getAttribute("d"),
      savedPath,
      "Missing CTM at release preserves the saved path",
    );
  } finally {
    await svg.evaluate((el) => {
      delete el.getScreenCTM;
    });
  }
  await button("完成路径").click();
  const edited = await vertices();
  assert.equal(edited.length, original.length);
  const pathError = Math.max(
    ...edited.map((p, i) =>
      error(
        p,
        i === target
          ? { x: original[i].x + dx, y: original[i].y + dy }
          : original[i],
      ),
    ),
  );
  assert.ok(pathError <= 2, "Committed vertex error: " + pathError);

  await page.keyboard.down("Alt");
  try {
    const other = world.locator('[data-node-id="Neighbor"]');
    await other.hover();
    const selectedBox = await layer.boundingBox(),
      otherBox = await other.boundingBox();
    const expectedGap = otherBox.x - selectedBox.x - selectedBox.width;
    assert.ok(expectedGap > 0);
    const line = stage.locator(".measure-line-x");
    await line.waitFor();
    const measured = await line.boundingBox();
    assert.ok(
      Math.abs(measured.x - selectedBox.x - selectedBox.width) <= 2 &&
        Math.abs(measured.width - expectedGap) <= 2,
      "Alt measurement must span both transformed screen edges",
    );
  } finally {
    await page.keyboard.up("Alt");
  }

  await page.getByTestId("design-file-input").setInputFiles({
    name: native.suggestedFilename(),
    mimeType: "application/vnd.forma.design+zip",
    buffer: bytes,
  });
  await board.waitFor();
  await preset(100);
  assert.deepEqual(
    await geometry(),
    retained,
    "Native file retains both handle edits",
  );
  await button("预览").click();
  const rendered = await page
    .locator('[data-design-id="Spacing"]')
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        radii: [
          s.borderTopLeftRadius,
          s.borderTopRightRadius,
          s.borderBottomRightRadius,
          s.borderBottomLeftRadius,
        ].map(parseFloat),
        gap: parseFloat(s.columnGap),
      };
    });
  assert.deepEqual(rendered, { radii: retained.radii, gap: retained.gap });
  await button("关闭预览").click();
  await button("选择图层 Spacing").click();
  const [zip] = await Promise.all([
    page.waitForEvent("download"),
    button("导出 React 项目").click(),
  ]);
  await zip.saveAs("output/playwright/canvas-pro-feel-check.zip");

  // Exercise automatic expansion before setting a persistent user preference.
  const boards = Array.from({ length: 128 }, (_, i) =>
    node("Board" + i, "frame", null, {
      x: (i % 16) * 440,
      y: Math.floor(i / 16) * 320,
      width: 360,
      height: 240,
    }),
  );
  const many = boards.flatMap((b) => [
    b,
    ...Array.from({ length: 4 }, (_, i) =>
      node(b.id + "-child" + i, "rectangle", b.id, {
        x: 24 + i * 60,
        y: 24,
        width: 44,
      }),
    ),
  ]);
  await load("128-boards", many);
  await map.waitFor();
  assert.equal(
    await map.locator(".canvas-minimap-count").innerText(),
    "128 画板",
  );
  await preset(100);
  const mapSurface = map.locator("canvas");
  await mapSurface.click({ position: { x: 22, y: 36 } });
  await settle();
  const first = await camera();
  await mapSurface.click({ position: { x: 150, y: 85 } });
  await settle();
  const second = await camera();
  assert.equal(first.zoom, second.zoom);
  const distance = Math.hypot(first.x - second.x, first.y - second.y);
  assert.ok(distance > 300, "Minimap clicks should center different boards");
  await button("适应全部内容").click();
  await preset(100);
  await settle();
  const bufferedRenders = await stage.evaluate(async (el) => {
    const before = Number(el.dataset.renderCount);
    for (let i = 0; i < 30; i++) {
      el.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: i % 2 ? -2 : 2,
          deltaY: 0,
        }),
      );
      await new Promise(requestAnimationFrame);
    }
    return Number(el.dataset.renderCount) - before;
  });
  assert.equal(
    bufferedRenders,
    0,
    "Small pans inside the large document prefetch area",
  );
  await settle();
  const surfaceRect = await mapSurface.boundingBox();
  // Fit-all centers this symmetric grid. Grab off-center to expose a lost grab offset.
  const grab = {
    x: surfaceRect.x + surfaceRect.width / 2 + 3,
    y: surfaceRect.y + surfaceRect.height / 2 + 2,
  };
  const startDrag = await camera();
  const priorChildren = await world
    .locator('[data-node-id$="-child0"]')
    .evaluateAll((els) => els.map((el) => el.dataset.nodeId));
  assert.ok(priorChildren.length > 0 && priorChildren.length < boards.length);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await frame();
  const pressed = await camera();
  const pressJump = Math.hypot(
    pressed.x - startDrag.x,
    pressed.y - startDrag.y,
  );
  assert.ok(pressJump < 1, "Minimap moved on press by " + pressJump + "px");
  await page.mouse.move(grab.x + surfaceRect.width * 0.32, grab.y, {
    steps: 18,
  });
  // Sample on the next paint while the pointer is still captured, before releasing or settling.
  const newlyVisible = await stage.evaluate(async (el, before) => {
    await new Promise(requestAnimationFrame);
    if (!el.classList.contains("is-camera-moving")) return [];
    const view = el.getBoundingClientRect();
    const labels = [...el.querySelectorAll(".frame-label")].map((label) =>
      label.firstChild.textContent.trim(),
    );
    return [...el.querySelectorAll('.canvas-world [data-node-id$="-child0"]')]
      .filter((child) => {
        const r = child.getBoundingClientRect();
        return (
          !before.includes(child.dataset.nodeId) &&
          labels.includes(child.parentElement.dataset.nodeId) &&
          r.left >= view.left &&
          r.right <= view.right &&
          r.top >= view.top &&
          r.bottom <= view.bottom
        );
      })
      .map((child) => child.dataset.nodeId);
  }, priorChildren);
  await page.mouse.up();
  assert.ok(
    newlyVisible.length,
    "New board contents and labels must mount during minimap drag",
  );
  await settle();
  const endDrag = await camera();
  assert.ok(
    Math.hypot(endDrag.x - startDrag.x, endDrag.y - startDrag.y) > 100,
    "Minimap pointer capture pans across boards",
  );
  await mapSurface.dblclick();
  await settle();
  assert.ok((await zoom()) < first.zoom, "Double-click fits the whole page");

  await mapSurface.focus();
  const beforeKey = await camera();
  await page.keyboard.press("Shift+ArrowDown");
  await settle();
  const keyPan = await camera();
  const surfaceHeight = await stage.evaluate((el) => el.clientHeight);
  assert.ok(Math.abs(beforeKey.y - keyPan.y - surfaceHeight / 2) < 1);
  await page.keyboard.press("0");
  await settle();
  await page.keyboard.press("Escape");
  assert.equal(
    await mapSurface.evaluate((el) => el === document.activeElement),
    false,
  );
  await mapSurface.click({ button: "right" });
  assert.equal(
    await page.getByRole("menu").count(),
    0,
    "Minimap consumes the context menu",
  );

  await page.setViewportSize(short);
  await map.waitFor({ state: "detached" });
  await page.setViewportSize(wide);
  await map.waitFor();
  await load("one-board-again", smallDoc);
  await map.waitFor({ state: "detached" });
  await stage.focus();
  await page.keyboard.press("Shift+KeyM");
  await map.waitFor();
  assert.equal(await button("画布小地图").getAttribute("aria-pressed"), "true");
  await page.setViewportSize(short);
  await frame();
  const mapBox = await map.boundingBox(),
    stageBox = await stage.boundingBox();
  const dock = await page
    .getByRole("toolbar", { name: "画布绘图工具栏" })
    .boundingBox();
  assert.ok(mapBox && stageBox && dock);
  assert.ok(
    mapBox.x >= stageBox.x &&
      mapBox.y >= stageBox.y &&
      mapBox.x + mapBox.width <= stageBox.x + stageBox.width + 1 &&
      mapBox.y + mapBox.height <= dock.y,
    "Short-window minimap must fit above the dock",
  );
  assert.ok(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    ),
    "Short-window editor overflow",
  );
  await button("缩放与视图选项").click();
  const toggle = page.getByRole("menuitemcheckbox", { name: /画布小地图/ });
  await toggle.focus();
  await page.keyboard.press("Shift+KeyM");
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await toggle.click();
  await map.waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  await page.setViewportSize(wide);
  await load("128-boards-again", many);
  assert.equal(
    await button("画布小地图").getAttribute("aria-pressed"),
    "false",
    "Respect explicit collapse on a large document",
  );
  await button("画布小地图").click();
  await map.waitFor();
  assert.deepEqual(errors, []);
  return {
    zoomRange: [0.02, 64],
    paintedHudPixels: painted.ink,
    burst,
    verifiedDragUndos: 4,
    nativeAndPreview: rendered,
    vectorAnchorErrorPx: anchorError,
    committedPathErrorPx: pathError,
    minimapPressJumpPx: pressJump,
    bufferedLargeDocRenders: bufferedRenders,
    newlyVisibleDuringDrag: newlyVisible,
    boards: boards.length,
    minimapTravelPx: distance,
    shortWindow: short,
  };
};
