async (page) => {
  const start = Date.now();
  const minimumMs = Number(process.env.FORMA_BITMAP_MINUTES ?? 0) * 60000;
  if (!Number.isFinite(minimumMs) || minimumMs < 0)
    throw Error("Invalid duration");
  let peakJsHeapBytes = 0;
  let rounds = 0,
    longestRoundMs = 0;

  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const layers = 8;
  const mixed = process.env.FORMA_BITMAP_SET === "mixed";
  const formats = mixed
    ? [
        [2048, 2048, "jpeg"],
        [3072, 1536, "png"],
        [1536, 3072, "webp"],
        [2560, 1440, "jpeg"],
        [1280, 2560, "png"],
        [4096, 1024, "webp"],
        [1024, 4096, "jpeg"],
        [1920, 1080, "png"],
      ]
    : Array.from({ length: layers }, () => [2048, 2048, "jpeg"]);
  const doc = await page.evaluate(async (formats) => {
    const images = {},
      nodes = [];
    const style = {
      x: 0,
      y: 0,
      width: 1024,
      height: 512,
      layout: "free",
      padding: 0,
      gap: 0,
      radius: 0,
      fontSize: 16,
      fill: "#ffffff",
      color: "#111111",
    };
    nodes.push({
      id: "board",
      type: "frame",
      name: "图片目录",
      text: "",
      hidden: false,
      locked: false,
      parentId: null,
      style,
    });
    const canvas = document.createElement("canvas");

    const ctx = canvas.getContext("2d");
    for (const [k, [w, h, format]] of formats.entries()) {
      canvas.width = w;
      canvas.height = h;
      const gradient = ctx.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, "hsl(" + k * 35 + " 80% 50%)");
      gradient.addColorStop(1, "#141621");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
      const data = canvas.toDataURL("image/" + format, 0.9),
        bytes = await (await fetch(data)).arrayBuffer();
      if (!data.startsWith("data:image/" + format + ";"))
        throw Error("Encoder unavailable: " + format);
      const id =
        "img-" +
        [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      const name = "照片 " + (k + 1);
      images[id] = { width: w, height: h, name: name + "." + format, data };
      nodes.push({
        id: "photo-" + k,
        type: "rectangle",
        name,
        text: "",
        hidden: false,
        locked: false,
        parentId: "board",
        style: {
          ...style,
          x: (k % 4) * 256,
          y: Math.floor(k / 4) * 256,
          width: 250,
          height: 250,
        },
        image: { assetId: id, fit: "cover", x: 50, y: 50, zoom: 1 },
      });
    }
    return {
      schemaVersion: 1,
      id: "bitmap-session",
      name: "图片目录验收",
      revision: 0,
      nodes,
      images,
      tokens: {},
    };
  }, formats);
  await page.locator('[data-testid="design-file-input"]').setInputFiles({
    name: "bitmaps.forma.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  let changes = 0;
  const button = (name) => page.getByRole("button", { name, exact: true });
  const assert = (ok, message) => {
    if (!ok) throw Error(message);
  };
  const checkImages = async (attr) => {
    const images = page.locator("[" + attr + "] > span > img");
    await images.nth(layers - 1).waitFor({ state: "attached" });
    assert((await images.count()) === layers, "bitmap layer count");
    await images.evaluateAll(async (els, sizes) => {
      await Promise.all(els.map((el) => el.decode()));
      if (
        els.some((el) => {
          const id = el.closest("[data-node-id],[data-design-id]");
          const index = Number(
            (id.dataset.nodeId ?? id.dataset.designId).split("-").at(-1),
          );
          return (
            el.naturalWidth !== sizes[index][0] ||
            el.naturalHeight !== sizes[index][1]
          );
        })
      )
        throw Error("bitmap decoded dimensions");
    }, formats);
  };
  await checkImages("data-node-id");
  for (
    let round = 0;
    round < 12 || Date.now() - start < minimumMs || round % 4;
    round++
  ) {
    const roundStart = Date.now();

    for (let i = 0; i < layers; i++) {
      await button("选择图层 照片 " + (i + 1)).click();
      const zoom = page.getByRole("spinbutton", { name: "裁切倍率" });
      const target = round % 2 === 0 ? "1.5" : "1";
      await zoom.fill(target);
      await zoom.press("Enter");
      changes++;
      if (i === 0) {
        await button("撤销").click();
        assert(Number(await zoom.inputValue()) !== Number(target), "undo crop");
        await button("重做").click();
      }
    }
    rounds++;
    peakJsHeapBytes = Math.max(
      peakJsHeapBytes,
      await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0),
    );
    longestRoundMs = Math.max(longestRoundMs, Date.now() - roundStart);
    if (round % 4 === 3) {
      await button("选择图层 图片目录").click();
      await button("预览").click();
      await checkImages("data-design-id");
      await button("关闭预览").click();
      await page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
      await page.reload();
      await checkImages("data-node-id");
      await button("选择图层 照片 1").click();
      assert(
        Number(
          await page.getByRole("spinbutton", { name: "裁切倍率" }).inputValue(),
        ) === 1,
        "reopened crop mismatch",
      );
    }
    if (minimumMs && Date.now() - start < minimumMs)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(10000, minimumMs - Date.now() + start)),
      );
  }
  assert(!errors.length, errors.join(","));
  return {
    images: layers,
    formats,
    changes,
    undoRedoPairs: rounds,
    previewReloads: Math.floor(rounds / 4),
    peakJsHeapBytes,
    longestRoundMs,
    elapsedSeconds: Math.round((Date.now() - start) / 1000),
  };
};
