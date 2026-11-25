async (page, { newWindow = () => page.context().newPage() } = {}) => {
  const { tsImport } = await import("tsx/esm/api"),
    { pathToFileURL } = await import("node:url");
  const { mkdtemp, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    path = (await import("node:path")).default;
  const embedded = process.env.FORMA_TEST_LOCAL_PUBLISH === "1";
  const root = process.env.INIT_CWD ?? process.cwd();
  const { libraryServer } = await tsImport(
    pathToFileURL(path.join(root, "server/library-service.ts")).href,
    pathToFileURL(path.join(root, "package.json")).href,
  );
  const directory = await mkdtemp(path.join(tmpdir(), "forma-publish-"));
  const server = libraryServer({
    directory,
    origins: [
      page.url().startsWith("forma://app/")
        ? "forma://app"
        : new URL(page.url()).origin,
    ],
    writeToken: "test-publisher",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = "http://127.0.0.1:" + server.address().port;
  const button = (p, name) => p.getByRole("button", { name, exact: true }),
    field = (p, name) => p.getByLabel(name, { exact: true });
  try {
    const style = {
      width: 100,
      height: 48,
      x: 0,
      y: 0,
      layout: "free",
      fill: "#ffffff",
      color: "#222222",
      padding: 0,
      radius: 0,
      gap: 0,
      fontSize: 16,
    };
    const doc = {
      schemaVersion: 1,
      id: "publishing-source",
      name: "Kit source",
      revision: 0,
      tokens: {},
      nodes: [
        {
          id: "badge",
          name: "News tag",
          parentId: null,
          type: "text",
          text: "Latest",
          hidden: false,
          locked: false,
          style,
        },
      ],
    };
    await page.locator('[data-testid="design-file-input"]').setInputFiles({
      name: "source.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(doc)),
    });
    await button(page, "选择图层 News tag").click();
    await button(page, "资源").click();
    await button(page, "保存选区").click();
    await button(page, "图层").click();
    await page.getByText(/^公开组件属性 ·/).click();
    await field(page, "组件属性名称").fill("标签");
    await button(page, "公开属性").click();
    await button(page, "资源").click();
    await button(page, "查看 News tag").click();
    await page.getByText("发布组件库", { exact: true }).click();
    if (!embedded) {
      await field(page, "组件库发布服务").fill(address);
      await field(page, "组件库发布凭证").fill("wrong");
      await page.getByRole("button", { name: /发布修订 r/ }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "发布凭证无效" })
        .waitFor();
      await field(page, "组件库发布凭证").fill("test-publisher");
    }
    await page.getByRole("button", { name: /发布修订 r/ }).click();
    await field(page, "可分享的订阅地址").waitFor();
    const url = await field(page, "可分享的订阅地址").inputValue();
    const consumers = [];
    for (const caption of ["库存 12", "已送达"]) {
      const tab = await newWindow();
      await tab.goto(page.url());
      await tab.getByTitle("新建空白文件").click();
      await tab.waitForURL(/file=forma\.file\./);
      await button(tab, "资源").click();
      await button(tab, "在线组件库").click();
      await field(tab, "组件库地址").fill(url);
      await button(tab, "订阅").click();
      await tab.getByText(/已是最新版本 · 本地/).waitFor();
      await button(tab, "完成").click();
      await field(tab, "搜索组件").fill("News tag");
      await button(tab, "查看 News tag").click();
      await button(tab, "插入组件").click();
      const target = tab.locator(".design-node.selected");
      if ((await target.innerText()) !== "Latest")
        throw Error("Subscriber insert");
      const prop = field(tab, "实例属性 标签");
      await prop.fill(caption);
      await prop.press("Enter");
      consumers.push({
        tab,
        caption,
        id: await target.getAttribute("data-node-id"),
      });
    }
    const { readFile } = await import("node:fs/promises");
    const { unzipSync, zipSync, strToU8, strFromU8 } = await import("fflate");
    const developer = consumers[0].tab;
    await field(developer, "文件菜单").click();
    const download = developer.waitForEvent("download");
    await button(developer, "导出整个文件为 React 项目…").click();
    const files = unzipSync(await readFile(await (await download).path()));
    const module = Object.keys(files).find((p) =>
      p.startsWith("src/components/"),
    );
    if (!module) throw Error("Subscriber component missing from project");
    const entry =
      'import {createRoot} from "react-dom/client";import Tag from "./' +
      module.slice(4, -4) +
      '";createRoot(document.getElementById("root")!).render(<Tag instanceId="legacy-tag" values={{标签:"业务旧名"}}/>);';
    files["src/main.tsx"] = strToU8(entry);
    await page.keyboard.press("Escape");
    await button(page, "图层").click();
    await button(page, "选择图层 News tag").click();
    const properties = page
      .locator("details")
      .filter({ has: page.getByText(/^公开组件属性 ·/) });
    if (!(await properties.evaluate((el) => el.open)))
      await properties.locator("summary").click();
    const rename = field(page, "重命名属性 标签");
    await rename.fill("业务标签");
    await rename.press("Enter");
    await field(page, "重命名属性 业务标签").waitFor();
    await properties.screenshot({
      path: "output/playwright/public-property-rename.png",
    });
    await page.getByText("文本内容", { exact: true }).click();
    const text = page.locator(".advanced-properties textarea");
    await text.fill("Updated");
    await text.blur();
    await button(page, "资源").click();
    await button(page, "查看 News tag").click();
    await page.getByText("发布组件库", { exact: true }).click();
    if (!embedded) {
      await field(page, "组件库发布服务").fill(address);
      await field(page, "组件库发布凭证").fill("test-publisher");
    }
    await page.getByRole("button", { name: /发布修订 r/ }).click();
    await field(page, "可分享的订阅地址").waitFor();
    for (const { tab, caption, id } of consumers) {
      const select = async () => {
        await button(tab, "图层").click();
        await tab
          .locator('[data-layer-id="' + id + '"]')
          .getByRole("button", { name: /^选择图层 / })
          .click();
      };
      await button(tab, "在线组件库").click();
      await button(tab, "检查更新").click();
      await button(tab, "查看更新").click();
      await button(tab, "应用组件库更新").click();
      await select();
      if ((await field(tab, "实例属性 业务标签").inputValue()) !== caption)
        throw Error("Lost local override on rename");
      await button(tab, "撤销").click();
      if ((await field(tab, "实例属性 标签").inputValue()) !== caption)
        throw Error("Undo renamed property");
      await button(tab, "重做").click();
      await tab.getByTitle("已保存到此浏览器", { exact: true }).waitFor();
      await tab.reload();
      await select();
      if ((await field(tab, "实例属性 业务标签").inputValue()) !== caption)
        throw Error("Lost override on reopen");
    }
    await field(developer, "文件菜单").click();
    const pick = developer.waitForEvent("filechooser");
    await button(developer, "更新已有 React 工程…").click();
    const update = developer.waitForEvent("download");
    await (
      await pick
    ).setFiles({
      name: "tag-source.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(zipSync(files)),
    });
    const result = await update;
    const merged = unzipSync(await readFile(await result.path()));
    if (strFromU8(merged["src/main.tsx"]) !== entry)
      throw Error("Developer entry overwritten");
    await result.saveAs("output/playwright/renamed-library-check.zip");
    for (const { tab } of consumers) await tab.close();
    return {
      publish: true,
      service: embedded ? "embedded" : "team",
      deniedInvalidToken: !embedded,
      consumers: consumers.map((c) => c.caption),
      oldPublicName: "标签",
      newPublicName: "业务标签",
      discovery: true,
      updatedInstance: true,
      undo: true,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
};
