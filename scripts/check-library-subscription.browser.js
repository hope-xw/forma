async (page) => {
  const { createServer } = await import("node:http");
  const s = {
    x: 0,
    y: 0,
    width: 100,
    height: 32,
    layout: "free",
    fill: "#ffffff",
    color: "#222222",
    padding: 0,
    radius: 0,
    gap: 0,
    fontSize: 16,
  };
  const make = (id, width) => ({
    id,
    name: id,
    category: "订阅",
    description: "",
    variants: [
      {
        id: "default",
        name: "默认",
        properties: {},
        nodes: [
          {
            id,
            templateKey: "root",
            name: id,
            type: "text",
            parentId: null,
            text: id,
            hidden: false,
            locked: false,
            variableBindings: { fontSize: "size" },
            style: { ...s, width },
          },
        ],
      },
    ],
  });
  const system = {
    collections: {
      type: {
        id: "type",
        name: "Typography",
        defaultModeId: "day",
        modes: [{ id: "day", name: "Day" }],
      },
    },
    variables: {
      size: {
        id: "size",
        name: "Body size",
        type: "number",
        collectionId: "type",
        values: { day: 16 },
      },
    },
    styles: {},
    activeModes: { type: "day" },
  };
  const library = {
    id: "studio-kit",
    name: "Studio Kit",
    description: "",
    format: "forma/library",
    version: 1,
    revision: 1,
    source: { name: "Studio", license: "test" },
    designSystem: system,
    components: [make("Caption", 100), make("Title", 120)],
  };
  let online = true,
    hits = 0;
  const server = createServer((req, res) => {
    hits++;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.writeHead(online ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(library));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url =
      "http://127.0.0.1:" + server.address().port + "/studio-library.json";
    const b = (name) => page.getByRole("button", { name, exact: true });
    const f = (name) => page.getByLabel(name, { exact: true });
    const waitSave = () =>
      page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
    const source = async () => {
      const pending = page.waitForEvent("download");
      await b("设计文件").click();
      const file = await pending;
      const { readFile } = await import("node:fs/promises");
      const raw = new Uint8Array(await readFile(await file.path()));
      if (raw[0] === 0x50 && raw[1] === 0x4b) {
        const path = await import("node:path");
        const { createRequire } = await import("node:module");
        const { pathToFileURL } = await import("node:url");
        const { strFromU8, unzipSync } = createRequire(
          pathToFileURL(
            path.resolve(
              process.env.FORMA_REPO_ROOT ?? process.cwd(),
              "scripts/run-browser-checks.mjs",
            ),
          ),
        )("fflate");
        return JSON.parse(strFromU8(unzipSync(raw)["document.json"]));
      }
      return JSON.parse(Buffer.from(raw).toString("utf8"));
    };
    await page.locator('[data-testid="design-file-input"]').setInputFiles({
      name: "subscriber.forma.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          id: "subscriber-test",
          name: "Subscriber",
          tokens: {},
          nodes: [],
          revision: 0,
        }),
      ),
    });
    await b("资源").click();
    await b("在线组件库").click();
    await f("组件库地址").fill(url);
    await b("订阅").click();
    await page.getByText("已是最新版本 · 本地 r1").waitFor();
    await b("完成").click();
    for (const id of ["Caption", "Title"]) {
      await f("搜索组件").fill(id);
      await b("查看 " + id).click();
      await b("插入组件").click();
    }
    await b("变量与样式").click();
    const size = f("Body size Day");
    await size.fill("22");
    await size.press("Enter");
    await page.keyboard.press("Escape");
    library.revision = 2;
    library.components = [make("Caption", 160), make("Title", 200)];
    system.variables.size.values.day = 18;
    await b("在线组件库").click();
    await b("检查更新").click();
    await b("查看更新").click();
    await page.getByLabel("比较组件 Title", { exact: true }).click();
    await page.locator(".review-pair figure").first().waitFor();
    if ((await page.locator(".review-pair figure").count()) !== 2)
      throw Error("revision previews unavailable");
    const difference = page.getByRole("table", { name: "比较定义" });
    await difference.getByRole("cell", { name: "22", exact: true }).waitFor();
    await page
      .locator('[aria-label="查看组件库更新"]')
      .screenshot({ path: "output/playwright/library-review.png" });
    await f("更新 Title").uncheck();
    await f("处理冲突 Body size").selectOption("local");
    await b("应用组件库更新").click();
    const check = async (expected) => {
      const d = await source();
      const widths = ["Caption", "Title"].map(
        (id) => d.nodes.find((n) => n.instance?.componentId === id).style.width,
      );
      if (
        JSON.stringify(widths) !== JSON.stringify(expected) ||
        d.designSystem.variables.size.values.day !== 22
      )
        throw Error(
          JSON.stringify({
            widths,
            expected,
            local: d.designSystem.variables.size.values.day,
          }),
        );
    };
    await check([160, 120]);
    await b("撤销").click();
    await check([100, 120]);
    await b("重做").click();
    await waitSave();
    await page.reload();
    await b("资源").click();
    await b("在线组件库").click();
    await b("查看更新").click();
    await b("应用组件库更新").click();
    await check([160, 200]);
    online = false;
    await b("在线组件库").click();
    await b("检查更新").click();
    await page.getByText(/检查失败.*503/).waitFor();
    await b("取消订阅").click();
    await b("完成").click();
    await check([160, 200]);
    return {
      networkRequests: hits,
      selectiveUpdate: true,
      conflict: "kept local size 22",
      offline: true,
      unsubscribed: true,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};
