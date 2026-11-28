async (page) => {
  const { strict: assert } = await import("node:assert");
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { resolve } = await import("node:path");
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  const stage = page.locator(".editor-canvas");
  const world = stage.locator(".canvas-world");
  const button = (name) => page.getByRole("button", { name, exact: true });
  const layer = (id) => world.locator(`[data-node-id="${id}"]`);
  const title = (id) => stage.locator(`[data-frame-label-id="${id}"]`);
  const sectionTitle = stage.locator('[data-section-label-id="sec-1"]');
  const frame = () => page.evaluate(() => new Promise(requestAnimationFrame));
  const closeTo = (a, b, message, tolerance = 0.6) =>
    assert.ok(Math.abs(a - b) <= tolerance, message + ": " + a + " vs " + b);
  const selectedIds = () =>
    world
      .locator(".design-node.selected")
      .evaluateAll((els) => els.map((el) => el.dataset.nodeId).sort());
  const undo = async () => {
    await stage.focus();
    await page.keyboard.press(mod + "+z");
    await frame();
  };
  function node(id, type, parentId, x, y, width, height, style = {}) {
    return {
      id,
      name: id,
      type,
      parentId,
      hidden: false,
      locked: false,
      text: "",
      style: {
        x,
        y,
        width,
        height,
        layout: "free",
        gap: 0,
        padding: 0,
        radius: 0,
        fill: "#f5f6fa",
        color: "#143047",
        fontSize: 16,
        ...style,
      },
    };
  }
  async function load(id, nodes, extra = {}) {
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
          ...extra,
        }),
      ),
    });
    await layer(nodes[0].id).waitFor({ state: "attached" });
    await button("适应全部内容").click();
    await frame();
  }
  async function actualSize() {
    await stage.focus();
    await page.keyboard.press("Shift+Digit0");
    await frame();
    assert.equal(Number(await stage.getAttribute("data-zoom")), 1);
  }
  async function center(locator) {
    const r = await locator.boundingBox();
    assert.ok(r, "Visible target for pointer gesture");
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }
  async function drag(from, dx, dy, modifier, during) {
    if (modifier) await page.keyboard.down(modifier);
    try {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      try {
        await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
        if (during) await during();
      } finally {
        await page.mouse.up();
      }
    } finally {
      if (modifier) await page.keyboard.up(modifier);
    }
    await frame();
  }
  const position = (id) =>
    layer(id).evaluate((el) => [el.offsetLeft, el.offsetTop]);
  async function titles() {
    await load("phase2-titles", [
      node("board-a", "frame", null, 0, 0, 160, 110),
      node("bleed", "rectangle", "board-a", 0, 0, 160, 110),
      node("board-b", "frame", null, 280, 0, 160, 110),
      node("sec-1", "section", null, 20, 235, 425, 180),
      node("board-in-sec", "frame", "sec-1", 65, 1, 140, 90),
    ]);
    await actualSize();
    const snap = button("智能吸附对齐");
    if ((await snap.getAttribute("aria-pressed")) === "true")
      await snap.click();
    const a = title("board-a"),
      b = title("board-b");
    await a.hover();
    await stage.locator(".artboard-hover-outline").waitFor();
    await a.click();
    assert.deepEqual(await selectedIds(), ["board-a"]);
    await drag(await center(a), 90, 40);
    assert.deepEqual(await position("board-a"), [90, 40]);
    await undo();
    assert.deepEqual(await position("board-a"), [0, 0]);

    // Anchor a pinch on the title, then press before the camera publishes its settled view.
    const anchor = await center(a);
    await page.mouse.move(anchor.x, anchor.y);
    const livePress = await a.evaluateHandle((el, point) => {
      const stage = el.closest(".editor-canvas");
      const start = performance.now();
      const sample = {};
      document.addEventListener(
        "pointerdown",
        (event) => {
          sample.elapsed = performance.now() - start;
          sample.live = stage.classList.contains("is-camera-moving");
          sample.label = event.target.closest(
            "[data-frame-label-id]",
          )?.dataset.frameLabelId;
        },
        { once: true, capture: true },
      );
      el.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -100 * Math.log(1.2),
          clientX: point.x,
          clientY: point.y,
        }),
      );
      return new Promise((resolve) =>
        requestAnimationFrame(() => resolve(sample)),
      );
    }, anchor);
    await page.mouse.down();
    try {
      const observed = await livePress.jsonValue();
      assert.ok(
        observed.live && observed.elapsed < 72,
        JSON.stringify(observed),
      );
      assert.equal(observed.label, "board-a");
      await page.mouse.move(anchor.x + 36, anchor.y + 12);
    } finally {
      await page.mouse.up();
      await livePress.dispose();
    }
    assert.deepEqual(await position("board-a"), [30, 10]);
    await undo();
    await actualSize();

    await b.click({ modifiers: ["Shift"] });
    assert.deepEqual(await selectedIds(), ["board-a", "board-b"]);
    await drag(await center(a), 42, 28);
    assert.deepEqual(await position("board-a"), [42, 28]);
    assert.deepEqual(await position("board-b"), [322, 28]);
    await undo();
    assert.deepEqual(await position("board-a"), [0, 0]);
    assert.deepEqual(await position("board-b"), [280, 0]);
    await drag(await center(a), 42, 28, "Shift");
    assert.deepEqual(await position("board-a"), [42, 0]);
    assert.deepEqual(await position("board-b"), [322, 0]);
    await undo();
    assert.deepEqual(await position("board-a"), [0, 0]);
    assert.deepEqual(await position("board-b"), [280, 0]);
    // Only B's center is inside the section after this shared translation.
    await drag(await center(b), -120, 235);
    assert.equal(
      await layer("sec-1").locator('[data-node-id="board-b"]').count(),
      1,
    );
    assert.equal(
      await layer("board-a").evaluate((el) =>
        el.parentElement.classList.contains("canvas-world"),
      ),
      true,
    );
    await undo();
    await b.click({ modifiers: ["Shift"] });
    assert.deepEqual(await selectedIds(), ["board-a"]);

    await drag(await center(a), 73, 44, "Alt");
    const [copy] = await selectedIds();
    assert.ok(copy && copy !== "board-a");
    assert.deepEqual(await position(copy), [73, 44]);
    assert.equal(await layer(copy).locator(".design-node").count(), 1);
    assert.deepEqual(await position("board-a"), [0, 0]);
    await undo();
    assert.equal(await layer(copy).count(), 0);
    assert.deepEqual(await selectedIds(), ["board-a"]);
    assert.equal(await world.locator('[data-node-type="frame"]').count(), 3);

    await snap.click();
    await drag(await center(a), 117, 26); // right edge 277 snaps to the neighbor's left edge 280
    assert.equal((await position("board-a"))[0], 120);
    await undo();
    await snap.click();

    const boardBox = await layer("board-a").boundingBox();
    const otherBox = await layer("board-b").boundingBox();
    await drag(
      { x: boardBox.x - 18, y: boardBox.y - 35 },
      otherBox.x + otherBox.width - boardBox.x + 35,
      boardBox.height + 56,
      undefined,
      async () => {
        assert.equal(
          await a.evaluate((el) => getComputedStyle(el).pointerEvents),
          "none",
        );
      },
    );
    assert.deepEqual(await selectedIds(), ["board-a", "board-b"]);
    await layer("bleed").click({ modifiers: [mod] });
    assert.deepEqual(await selectedIds(), ["bleed"]);
    await a.click();
    await layer("bleed").dblclick();
    assert.deepEqual(await selectedIds(), ["bleed"]);
    const nested = title("board-in-sec");
    await drag(await center(nested), 30, 0);
    assert.equal(
      await layer("sec-1").locator('[data-node-id="board-in-sec"]').count(),
      1,
    );
    assert.deepEqual(await position("board-in-sec"), [95, 1]);
    assert.deepEqual(await position("sec-1"), [20, 235]);
    await undo();
    await drag(await center(nested), -224, 0);
    assert.equal(
      await layer("board-in-sec").evaluate((el) =>
        el.parentElement.classList.contains("canvas-world"),
      ),
      true,
    );
    await drag(await center(nested), 224, 0);
    assert.equal(
      await layer("sec-1").locator('[data-node-id="board-in-sec"]').count(),
      1,
    );
    await undo();
    assert.equal(
      await layer("board-in-sec").evaluate((el) =>
        el.parentElement.classList.contains("canvas-world"),
      ),
      true,
    );
    await undo();
    assert.equal(
      await layer("sec-1").locator('[data-node-id="board-in-sec"]').count(),
      1,
    );
    const childBefore = await layer("board-in-sec").boundingBox();
    await drag(await center(sectionTitle), 57, -21);
    assert.deepEqual(await position("sec-1"), [77, 214]);
    const childAfter = await layer("board-in-sec").boundingBox();
    closeTo(
      childAfter.x - childBefore.x,
      57,
      "Section carries child horizontally",
    );
    closeTo(
      childAfter.y - childBefore.y,
      -21,
      "Section carries child vertically",
    );
    await undo();

    const toggle = button("图层与资源面板");
    if ((await toggle.getAttribute("aria-expanded")) === "true")
      await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    const editor = stage.locator(".frame-label-editor");
    await a.dblclick();
    await editor.fill("首页主屏");
    await editor.dispatchEvent("compositionstart");
    await editor.press("Enter");
    assert.equal(await editor.count(), 1);
    await editor.dispatchEvent("compositionend");
    await editor.press("Enter");
    assert.match(await a.innerText(), /^首页主屏/);
    await undo();
    assert.match(await a.innerText(), /^board-a/);
    await a.dblclick();
    await editor.fill("取消测试");
    await editor.press("Escape");
    assert.match(await a.innerText(), /^board-a/);
    const pill = await sectionTitle.boundingBox();
    assert.equal(await sectionTitle.count(), 1);
    await sectionTitle.dblclick();
    assert.equal(await stage.locator(".section-title-pill").count(), 0);
    const inputRect = await editor.boundingBox();
    closeTo(inputRect.x, pill.x, "Section editor left edge");
    closeTo(inputRect.y, pill.y, "Section editor top edge");
    closeTo(inputRect.height, pill.height, "Section editor height");
    await editor.fill("新分区");
    await editor.press("Enter");
    assert.equal(await sectionTitle.innerText(), "新分区");
    await undo();
    assert.equal(await sectionTitle.innerText(), "sec-1");

    for (const [target, id] of [
      [sectionTitle, "sec-1"],
      [nested, "board-in-sec"],
      [b, "board-b"],
    ]) {
      await target.click({ button: "right" });
      await page.getByRole("menu").first().waitFor();
      assert.deepEqual(await selectedIds(), [id]);
      await page.keyboard.press("Escape");
      await page.getByRole("menu").first().waitFor({ state: "hidden" });
    }
    const pointer = (locator) =>
      locator.evaluate((el) => getComputedStyle(el).pointerEvents);
    await stage.focus();
    await page.keyboard.down("Space");
    assert.equal(await pointer(a), "none");
    assert.equal(await pointer(sectionTitle), "none");
    await page.keyboard.up("Space");
    for (const key of ["h", "r", "Shift+d"]) {
      await page.keyboard.press(key);
      assert.equal(await pointer(a), "none", key);
      assert.equal(await pointer(sectionTitle), "none", key);
      await page.keyboard.press(key === "Shift+d" ? key : "v");
      assert.equal(await pointer(a), "auto");
    }
    const pillHeight = (await sectionTitle.boundingBox()).height;
    for (const zoom of [0.02, 64]) {
      await pinchTo(zoom);
      closeTo(
        (await sectionTitle.boundingBox()).height,
        pillHeight,
        "Section hit height at " + zoom,
      );
    }
    await actualSize();
    await toggle.click();
    await snap.click();
  }
  async function alignment() {
    const ids = ["first", "second", "third"];
    await load("phase2-alignment", [
      node("free", "frame", null, 0, 0, 500, 280),
      node(ids[0], "rectangle", "free", 20, 15, 38, 28),
      node(ids[1], "rectangle", "free", 105, 79, 54, 42),
      node(ids[2], "ellipse", "free", 389, 197, 70, 56),
      node("flow", "frame", null, 0, 330, 400, 120, { layout: "row" }),
      node("absolute", "rectangle", "flow", 17, 10, 58, 32, {
        absolutePosition: true,
      }),
      node("sibling", "rectangle", "flow", 0, 0, 10, 10),
    ]);
    await actualSize();
    for (const [i, id] of ids.entries())
      await button("选择图层 " + id).click({ modifiers: i ? [mod] : [] });
    assert.deepEqual(await selectedIds(), ids);
    const boxes = () => Promise.all(ids.map((id) => layer(id).boundingBox()));
    const before = await boxes();
    const paths = {
      left: ["M2 2v20"],
      top: ["M22 2H2"],
      right: ["M22 22V2"],
      bottom: ["M22 22H2"],
      center: ["M12 2v20"],
      middle: ["M2 12h20"],
      horizontal: ["M4 22V2", "M20 22V2"],
      vertical: ["M22 20H2", "M22 4H2"],
    };
    for (const [id, geometry] of Object.entries(paths)) {
      const control = page.locator(`[data-align-id="${id}"]`);
      assert.ok(await control.isEnabled(), id);
      const ds = await control
        .locator("svg path")
        .evaluateAll((els) => els.map((el) => el.getAttribute("d")));
      for (const d of geometry) assert.ok(ds.includes(d), id + " " + d);
      await control.click();
      const after = await boxes();
      const horizontal = ["left", "right", "center", "horizontal"].includes(id);
      const axis = horizontal ? "x" : "y",
        size = horizontal ? "width" : "height";
      const other = horizontal ? "y" : "x";
      const start = Math.min(...before.map((r) => r[axis]));
      const end = Math.max(...before.map((r) => r[axis] + r[size]));
      const gap =
        (end - start - before.reduce((sum, r) => sum + r[size], 0)) / 2;
      let cursor = start;
      for (const [i, r] of after.entries()) {
        const expected = ["horizontal", "vertical"].includes(id)
          ? cursor
          : ["center", "middle"].includes(id)
            ? (start + end - r[size]) / 2
            : ["right", "bottom"].includes(id)
              ? end - r[size]
              : start;
        closeTo(r[axis], expected, id + " " + ids[i]);
        closeTo(
          r[other],
          before[i][other],
          id + " preserves perpendicular position",
        );
        closeTo(r.width, before[i].width, id + " preserves width");
        closeTo(r.height, before[i].height, id + " preserves height");
        cursor += r[size] + gap;
      }
      await undo();
      assert.deepEqual(await boxes(), before, id + " undo");
    }
    await button("选择图层 absolute").click();
    for (const id of ["left", "top", "center", "middle", "right", "bottom"])
      assert.ok(await page.locator(`[data-align-id="${id}"]`).isEnabled(), id);
    const order = () =>
      layer("flow")
        .locator(":scope > .design-node")
        .evaluateAll((els) => els.map((el) => el.dataset.nodeId));
    const originalOrder = await order();
    const origin = await position("absolute");
    await drag(await center(layer("absolute")), 29, 17, mod, async () => {
      assert.deepEqual(await position("absolute"), [
        origin[0] + 29,
        origin[1] + 17,
      ]);
    });
    assert.deepEqual(await order(), originalOrder);
    assert.deepEqual(await position("absolute"), [
      origin[0] + 29,
      origin[1] + 17,
    ]);
    await undo();
    assert.deepEqual(await position("absolute"), origin);
    const parent = await layer("flow").boundingBox();
    await page.locator('[data-align-id="right"]').click();
    const child = await layer("absolute").boundingBox();
    closeTo(
      child.x + child.width,
      parent.x + parent.width,
      "Absolute child's right edge",
    );
  }
  async function pinchTo(zoom) {
    // Feed the same cancellable ctrl-wheel events as a trackpad pinch, anchored at stage center.
    await stage.evaluate((el, target) => {
      const bounds = el.getBoundingClientRect();
      const ratio = target / Number(el.dataset.zoom);
      const steps = Math.max(1, Math.ceil(Math.abs(Math.log(ratio)) / 0.28));
      for (let i = 0; i < steps; i++)
        el.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            clientX: bounds.x + bounds.width / 2,
            clientY: bounds.y + bounds.height / 2,
            deltaY: (-100 * Math.log(ratio)) / steps,
          }),
        );
    }, zoom);
    await page.waitForFunction((target) => {
      const el = document.querySelector(".editor-canvas");
      return (
        Math.abs(Number(el.dataset.zoom) - target) < 1e-6 &&
        !el.classList.contains("is-camera-moving")
      );
    }, zoom);
  }
  async function lod() {
    const id = "lod-55";
    const nodes = Array.from({ length: 128 }, (_, i) => {
      const id = "lod-" + i;
      return [
        node(
          id,
          "frame",
          null,
          (i % 16) * 285,
          Math.floor(i / 16) * 220,
          240,
          160,
        ),
        ...Array.from({ length: 16 }, (_, j) =>
          node(
            id + "-c" + j,
            "rectangle",
            id,
            12 + (j % 4) * 55,
            10 + Math.floor(j / 4) * 38,
            36,
            22,
            { fill: "#e13649" },
          ),
        ),
      ];
    }).flat();
    nodes.find((n) => n.id === id + "-c5").variableBindings = {
      fill: "tile-ink",
    };
    await load("phase2-lod", nodes, {
      designSystem: {
        collections: {
          theme: {
            id: "theme",
            name: "Tile theme",
            defaultModeId: "light",
            modes: [
              { id: "light", name: "Light" },
              { id: "dark", name: "Dark" },
            ],
          },
        },
        variables: {
          "tile-ink": {
            id: "tile-ink",
            name: "Tile ink",
            collectionId: "theme",
            type: "color",
            values: { light: "#e13649", dark: "#264ed1" },
          },
        },
        activeModes: { theme: "light" },
        styles: {},
      },
    });
    await pinchTo(0.15);
    const cached = world.locator('[data-lod="cached"]');
    await cached.first().waitFor();
    const cachedBoards = await cached.count();
    const dom = world.locator(".design-node");
    const cachedDOM = await dom.count();
    assert.ok(
      cachedBoards >= 10 && cachedDOM < 400,
      JSON.stringify({ cachedBoards, cachedDOM }),
    );
    await stage.focus();
    await page.keyboard.press("Shift+o");
    await cached.first().waitFor({ state: "detached" });
    const liveDOM = await dom.count();
    assert.ok(
      liveDOM > 1500 && liveDOM > 4 * cachedDOM,
      "Live DOM at the same camera: " + liveDOM,
    );
    // A fixed interior board prevents a single unobstructed edge board from masking dense-label regressions.
    const paints = await page.evaluateHandle((id) => {
      const proto = CanvasRenderingContext2D.prototype;
      const drawImage = proto.drawImage;
      const sources = [];
      proto.drawImage = function (...args) {
        if (this.canvas.parentElement?.dataset.nodeId === id)
          sources.push(args[0]);
        return drawImage.apply(this, args);
      };
      return {
        sources,
        restore: () => {
          proto.drawImage = drawImage;
        },
      };
    }, id);
    const tileCanvas = layer(id).locator("canvas");
    const painted = () =>
      page.waitForFunction((id) => {
        const c = document.querySelector(
          `[data-node-id="${id}"][data-lod="cached"] canvas`,
        );
        return c?.width > 0;
      }, id);
    const bitmap = () => tileCanvas.evaluate((c) => c.toDataURL());
    const pan = (dx) =>
      stage.evaluate(
        (el, deltaX) =>
          el.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              deltaX,
            }),
          ),
        dx,
      );
    try {
      await page.mouse.move(0, 0);
      await page.keyboard.press("Shift+o");
      await painted();
      assert.equal(await title(id).count(), 0);
      const covered = await cached.evaluateAll((boards) =>
        boards.flatMap((board) => {
          const rect = board.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          return hit?.closest("[data-frame-label-id]")
            ? [board.dataset.nodeId]
            : [];
        }),
      );
      assert.deepEqual(
        covered,
        [],
        "No cached board center is covered by a neighboring title",
      );
      const original = await bitmap();
      // c5 starts at (67,48). The point is inside it now and outside it after a 10px nudge.
      const samplePixel = () =>
        tileCanvas.evaluate((c) => [
          ...c
            .getContext("2d")
            .getImageData(
              Math.floor((72 / 240) * c.width),
              Math.floor((59 / 160) * c.height),
              1,
              1,
            ).data,
        ]);
      assert.deepEqual(await samplePixel(), [225, 54, 73, 255]);
      await pan(4000);
      await tileCanvas.waitFor({ state: "detached" });
      await pan(-4000);
      await painted();
      assert.equal(await bitmap(), original);
      assert.ok(
        await paints.evaluate(
          ({ sources }) => sources.length >= 2 && sources.at(-1) === sources[0],
        ),
        "Pan restores the very same resident tile bitmap",
      );

      const canvasBefore = await tileCanvas.evaluateHandle((c) => c);
      try {
        const mode = page.getByRole("combobox", {
          name: "模式 Tile theme",
          exact: true,
        });
        const pixelBefore = await samplePixel();
        for (const [theme, pixel] of [
          ["dark", [38, 78, 209, 255]],
          ["light", pixelBefore],
        ]) {
          assert.deepEqual(await selectedIds(), []);
          const paintCount = await paints.evaluate(
            ({ sources }) => sources.length,
          );
          await mode.selectOption(theme);
          await page.waitForFunction(
            ({ paints, paintCount }) => paints.sources.length > paintCount,
            { paints, paintCount },
          );
          assert.equal(
            await tileCanvas.evaluate(
              (c, before) => c === before,
              canvasBefore,
            ),
            true,
          );
          assert.deepEqual(await selectedIds(), []);
          const pixelAfter = await samplePixel();
          assert.deepEqual(pixelAfter, pixel);
          if (theme === "dark") assert.notDeepEqual(pixelAfter, pixelBefore);
        }
      } finally {
        await canvasBefore.dispose();
      }

      const point = await center(layer(id));
      const coldPress = await page.evaluateHandle(({ x, y }) => {
        const hit = document
          .elementFromPoint(x, y)
          ?.closest("[data-node-id]")?.dataset;
        const sample = { hit: [hit?.nodeId, hit?.lod], press: null };
        document.addEventListener(
          "pointerdown",
          (event) => {
            const target = event.target.closest("[data-node-id]");
            sample.press = [target?.dataset.nodeId, target?.dataset.lod];
          },
          { once: true, capture: true },
        );
        return sample;
      }, point);
      const cdp = await page.context().newCDPSession(page);
      try {
        assert.deepEqual(await coldPress.evaluate(({ hit }) => hit), [
          id,
          "cached",
        ]);
        // Playwright mouse.click moves first, warming the board. CDP can press at this point directly.
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...point,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
        assert.deepEqual(await coldPress.evaluate(({ press }) => press), [
          id,
          "cached",
        ]);
        assert.deepEqual(await selectedIds(), [id]);
        assert.equal(await layer(id).getAttribute("data-lod"), null);
        assert.equal(await layer(id).locator(".design-node").count(), 16);
        await title(id).waitFor();
      } finally {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...point,
          button: "left",
          buttons: 0,
          clickCount: 1,
        });
        await cdp.detach();
        await coldPress.dispose();
      }

      await pinchTo(0.6);
      const childId = id + "-c5";
      await layer(childId).click({ modifiers: [mod] });
      assert.deepEqual(await selectedIds(), [childId]);
      const before = await position(childId);
      await stage.focus();
      await page.keyboard.press("Shift+ArrowRight");
      const after = await position(childId);
      assert.deepEqual(after, [before[0] + 10, before[1]]);
      await button("缩放与视图选项").hover();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await pinchTo(0.15);
      await painted();
      assert.notEqual(await bitmap(), original);
      assert.deepEqual(
        await samplePixel(),
        [245, 246, 250, 255],
        "Child edit repaints the vacated pixels",
      );
    } finally {
      await paints.evaluate(({ restore }) => restore());
      await paints.dispose();
    }
    await pinchTo(0.4);
    assert.ok(
      (await cached.count()) > 0,
      "Hysteresis retains cached boards at 40%",
    );
    await pinchTo(0.6);
    assert.equal(await cached.count(), 0, "All cached boards promote at 60%");
    return {
      boards: 128,
      nodes: nodes.length,
      cachedBoards,
      liveDOM,
      cachedDOM,
    };
  }
  async function vectors() {
    const bytes = await readFile(
      resolve(
        process.env.FORMA_REPO_ROOT,
        "tests/fixtures/forma-geometry-test.ttf",
      ),
    );
    const font = "font-" + createHash("sha256").update(bytes).digest("hex");
    const art = node("art", "frame", null, 0, 0, 520, 360);
    const stroke = node("stroke", "vector", "art", 48, 60, 160, 120);
    stroke.vector = {
      width: 160,
      height: 120,
      paths: [
        {
          d: "M12 12L148 12L148 108L12 108Z",
          strokeWidth: 8,
          strokeColor: "#1658ad",
          fill: false,
        },
      ],
    };
    const text = node("letters", "text", "art", 270, 80, 125, 72, {
      fontFamily: font,
      fontSize: 36,
    });
    text.text = "AB";
    await load("phase2-art", [art, stroke, text], {
      fonts: {
        [font]: {
          name: "Forma Geometry",
          axes: [],
          data: "data:font/ttf;base64," + bytes.toString("base64"),
        },
      },
    });
    await actualSize();
    const path = layer("stroke").locator(":scope > svg path");
    const anchors = stage.locator(
      ".vector-surface [data-anchor]:not([data-handle])",
    );
    const points = () =>
      anchors.evaluateAll((els) =>
        els.map((el) => {
          const p = new DOMPoint(
            el.cx.baseVal.value,
            el.cy.baseVal.value,
          ).matrixTransform(el.getScreenCTM());
          return { x: p.x, y: p.y };
        }),
      );
    await button("选择图层 stroke").click();
    await button("编辑锚点").click();
    await anchors.first().waitFor();
    const original = await points();
    assert.equal(original.length, 4);
    const startD = await path.getAttribute("d");
    const from = { x: original[0].x - 14, y: original[0].y - 14 };
    await drag(from, original[1].x - from.x + 12, 28, undefined, () => {
      return stage.getByTestId("vector-marquee").waitFor();
    });
    assert.deepEqual(
      await stage
        .locator(
          '.vector-surface [data-anchor][data-selected="true"]:not([data-handle])',
        )
        .evaluateAll((els) => els.map((el) => el.dataset.anchor)),
      ["0", "1"],
    );
    await drag(original[0], 16, 21);
    const shifted = await points();
    for (let i = 0; i < 4; i++) {
      closeTo(
        shifted[i].x - original[i].x,
        i < 2 ? 16 : 0,
        "Anchor " + i + " x",
        1.2,
      );
      closeTo(
        shifted[i].y - original[i].y,
        i < 2 ? 21 : 0,
        "Anchor " + i + " y",
        1.2,
      );
    }
    const shiftedD = await path.getAttribute("d");
    assert.notEqual(shiftedD, startD);
    assert.doesNotMatch(shiftedD, /C/i);
    await button("弯曲工具").click();
    const midpoint = {
      x: (shifted[0].x + shifted[1].x) / 2,
      y: (shifted[0].y + shifted[1].y) / 2,
    };
    await drag(midpoint, 0, -30, undefined, () =>
      stage.getByTestId("vector-bend-preview").waitFor(),
    );
    await button("完成路径").click();
    const bent = await path.getAttribute("d");
    assert.match(bent, /C/);

    const selectionVector = world.locator('.selected[data-node-type="vector"]');
    async function readSelectedOutline() {
      await selectionVector
        .locator(':scope > svg path[stroke-width="0"]')
        .first()
        .waitFor();
      const id = await selectionVector.getAttribute("data-node-id");
      const paths = await selectionVector
        .locator(":scope > svg path")
        .evaluateAll((els) =>
          els.map((p) => ({
            d: p.getAttribute("d"),
            fill: p.getAttribute("fill"),
            width: p.getAttribute("stroke-width"),
          })),
        );
      assert.ok(paths.length > 0);
      for (const p of paths) {
        assert.match(p.d, /Z\s*$/i);
        assert.ok(p.fill && p.fill !== "none");
        assert.equal(p.width, "0");
      }
      return { id, paths };
    }
    await button("轮廓化描边").click();
    assert.equal((await readSelectedOutline()).id, "stroke");
    await undo();
    assert.equal(await path.getAttribute("d"), bent);
    await page.keyboard.press(mod + "+Shift+o");
    const outlinedStroke = await readSelectedOutline();
    assert.equal(outlinedStroke.id, "stroke");

    await button("选择图层 letters").click();
    await layer("letters").click({ button: "right" });
    await page.locator('[data-category="组织"]').hover();
    assert.ok(
      await page.getByRole("menuitem", { name: /文字转轮廓/ }).isEnabled(),
    );
    assert.equal(
      await page.getByRole("menuitem", { name: /轮廓化描边/ }).count(),
      0,
    );
    await page.keyboard.press("Escape");
    if (await page.getByRole("menu").count())
      await page.keyboard.press("Escape");
    await stage.focus();
    await page.keyboard.press(mod + "+k");
    await page.getByRole("combobox", { name: "搜索命令" }).fill("文字转轮廓");
    assert.ok(
      await page.getByRole("option", { name: /文字转轮廓/ }).isEnabled(),
    );
    await page.keyboard.press("Escape");
    await button("文字转轮廓").click();
    await world
      .locator('[data-node-id="letters"][data-node-type="vector"]')
      .waitFor();
    const outlinedText = await readSelectedOutline();
    assert.equal(outlinedText.id, "letters");
    assert.ok(
      outlinedText.paths.reduce(
        (sum, path) => sum + (path.d.match(/z/gi) ?? []).length,
        0,
      ) >= 2,
      "Two embedded glyph contours",
    );
    const outlined = [outlinedStroke, outlinedText];
    const [native] = await Promise.all([
      page.waitForEvent("download"),
      button("设计文件").click(),
    ]);
    assert.match(native.suggestedFilename(), /\.forma$/);
    const saved = await readFile(await native.path());

    // Import the downloaded bytes into empty browser storage. An already-open tab cannot satisfy the assertions.
    const fresh = await page
      .context()
      .browser()
      .newContext({ viewport: page.viewportSize() });
    try {
      const reopened = await fresh.newPage();
      reopened.on("pageerror", (err) => errors.push(err.message));
      await reopened.goto(page.url());
      await reopened.getByTestId("design-file-input").setInputFiles({
        name: native.suggestedFilename(),
        mimeType: "application/vnd.forma.design+zip",
        buffer: saved,
      });
      const reopenedButton = (name) =>
        reopened.getByRole("button", { name, exact: true });
      async function verifyPaths(selector) {
        for (const { id, paths } of outlined) {
          const painted = reopened.locator(selector(id) + " > svg path");
          await painted.first().waitFor();
          const result = await painted.evaluateAll((els) =>
            els.map((p) => ({
              d: p.getAttribute("d"),
              fill: p.getAttribute("fill"),
              width: p.getAttribute("stroke-width"),
            })),
          );
          assert.deepEqual(
            result,
            paths,
            id + " retains outline geometry and paint",
          );
        }
      }
      await verifyPaths(
        (id) => `.canvas-world [data-node-type="vector"][data-node-id="${id}"]`,
      );
      await reopenedButton("选择图层 art").click();
      await reopenedButton("预览").click();
      await verifyPaths((id) => `[data-design-id="${id}"]`);
      await reopenedButton("关闭预览").click();
      const [zip] = await Promise.all([
        reopened.waitForEvent("download"),
        reopenedButton("导出 React 项目").click(),
      ]);
      await zip.saveAs("output/playwright/canvas-phase2-check.zip");
      return {
        movedAnchors: 2,
        bentSegments: 1,
        reopenedOutlines: outlined.length,
        previewedOutlines: outlined.length,
      };
    } finally {
      await fresh.close();
    }
  }
  await page.setViewportSize({ width: 1760, height: 1000 });
  await titles();
  await alignment();
  const farZoom = await lod();
  const outlined = await vectors();
  assert.deepEqual(errors, []);
  return { alignmentControls: 8, ...farZoom, ...outlined };
};
