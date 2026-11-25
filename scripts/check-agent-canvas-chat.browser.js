async (page) => {
  const { strict: assert } = await import("node:assert");
  const { readFile } = await import("node:fs/promises");
  const { strFromU8, unzipSync } = await import("fflate");
  const { createServer } = await import("node:http");

  const button = (name) => page.getByRole("button", { name, exact: true });
  const canvas = page.locator(".editor-canvas");
  const saved = () =>
    page.getByTitle("已保存到此浏览器", { exact: true }).waitFor();

  // Track any premature /api/agent/* traffic before explicit user action
  const initialAgentRequests = [];
  const onReq = (r) => {
    try {
      if (new URL(r.url()).pathname.startsWith("/api/agent/"))
        initialAgentRequests.push(r.method() + " " + new URL(r.url()).pathname);
    } catch {
      /* ignore */
    }
  };
  page.on("request", onReq);

  await page.reload();
  await canvas.waitFor();
  await saved();
  assert.equal(
    initialAgentRequests.length,
    0,
    "Zero /api/agent/* requests expected before user triggers Agent UI",
  );

  // Spin up a local mock OpenAI-compatible provider server for E2E verification
  const modelId = "deepseek-flash";
  const craftId = "forma-design-system-craft";
  const testSkill = "forma-qa-" + crypto.randomUUID();
  const instructions = "使用当前画板的间距变量，检查登录表单的标签。";
  const receivedRounds = [];
  const htmlPrompt = "新建一屏手冲咖啡订阅卡";
  const firstTitle = "早安手冲";
  const refinedTitle = "本周手冲精选";
  const critiqueNote = "卡片间距调整为 16 px。";
  const libraryId = "tb-mobile";
  const libraryName = "淘宝移动端电商库（模拟）";
  const campaignPrompt =
    "为淘宝移动端设计大促完整购物流程，包含主会场和关联异常态，请规划页面范围。";
  const customNote = "\n  行话：开门红先上尖货池。  \n\n";
  const brand = "#ff5000";
  const screens = [
    {
      refId: "tb-home",
      name: "淘宝主会场",
      role: "primary",
      width: 390,
      height: 600,
      summary: "搜索商品并浏览促销楼层",
    },
    {
      refId: "tb-empty",
      name: "淘宝搜索空态",
      role: "exception",
      parentRef: "tb-home",
      width: 390,
      height: 320,
      summary: "没有搜索结果时展示缺省反馈",
    },
  ];
  const scopePlan = {
    reply: "请选择本次大促的页面范围。",
    summary: "生成主会场及关联搜索空态",
    screens,
    reusedAssets: ["顶部搜索导航栏", "搜索空状态"],
    customModules: ["尖货促销楼层"],
    decisions: [
      {
        question: "主推促销类型",
        defaultChoice: "秒杀",
        alternatives: ["满减"],
      },
    ],
  };
  const htmlBoards = screens.map(({ summary, ...board }, i) => ({
    ...board,
    html:
      i === 0
        ? `<main><div data-forma-component="tb-nav-search" data-overrides='{"textByTemplateKey":{"旧槽位":"促销"}}'></div><section data-forma-name="尖货促销楼层"><h2>满减专场</h2></section></main>`
        : '<main><div data-forma-component="tb-empty-state"></div></main>',
    css:
      "main{display:flex;flex-direction:column;width:100%;gap:16px}section{background:" +
      brand +
      ";height:96px;padding:16px;border-radius:12px}",
  }));
  const campaignRounds = [];
  const campaignScreenshots = [];
  const campaignReviewNote = "促销楼层内边距已调整，空态补充无结果提示。";
  const revisedBoards = htmlBoards.map((board, index) => ({
    ...board,
    css: board.css + "section{padding:24px}",
    html: index
      ? board.html.replace("</main>", "<p>换个关键词试试</p></main>")
      : board.html.replace(/ data-overrides='[^']*'/, ""),
  }));
  function toolCall(name, args) {
    return {
      id: "qa-" + name,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    };
  }
  let delayedConfirmation;
  async function campaignModel(body, res, tools, results) {
    if (!tools.includes("get_canvas_overview")) {
      const parts = body.messages.find((m) => m.role === "user")?.content;
      campaignScreenshots.push(
        (Array.isArray(parts) ? parts : [])
          .filter((p) => p.type === "image_url")
          .map((p) => p.image_url.url),
      );
      respondToModel(
        res,
        body.stream,
        [
          toolCall("propose_html_design", {
            reply: campaignReviewNote,
            artboards: revisedBoards,
          }),
        ],
        campaignReviewNote,
      );
      return;
    }
    const message = body.messages.findLast(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes("Context (JSON)\n"),
    );
    if (!message) {
      res.writeHead(422).end("Missing shopping context");
      return;
    }
    const ctx = JSON.parse(message.content.split("Context (JSON)\n").at(-1));
    const toolResult = results.length
      ? JSON.parse(results.at(-1).content)
      : null;
    campaignRounds.push({ tools, ctx, toolResult });
    if (ctx.confirmedScope && delayedConfirmation) {
      delayedConfirmation.received.resolve();
      await delayedConfirmation.resume.promise;
      if (res.destroyed) return;
    }
    const calls = ctx.confirmedScope
      ? results.length
        ? []
        : [
            toolCall("propose_html_design", {
              reply: "两张画板已就绪。",
              artboards: htmlBoards,
            }),
          ]
      : results.length
        ? [toolCall("propose_scope_plan", scopePlan)]
        : [toolCall("get_library_playbook", { libraryId })];
    respondToModel(res, body.stream, calls, "两张购物画板已就绪。");
  }

  function shoppingLibrary() {
    const style = {
      x: 0,
      y: 0,
      width: 350,
      height: 48,
      fill: "#ffffff",
      color: "#202020",
      radius: 0,
      fontSize: 14,
      padding: 0,
      gap: 0,
      layout: "free",
    };
    const components = [
      ["tb-campaign-page", "频道首页样板", "page", "频道首页", 390, 600],
      ["tb-nav-search", "顶部搜索导航栏", "block", "搜索宝贝", 350, 48],
      ["tb-promo-btn", "主促按钮", "component", "立即抢购", 120, 40],
      ["tb-empty-state", "搜索空状态", "component", "暂无相关商品", 320, 120],
    ].map(([id, name, assetTier, text, width, height]) => {
      const root = {
        id: "root",
        templateKey: "root",
        type: "frame",
        parentId: null,
        name,
        text: "",
        hidden: false,
        locked: false,
        style: { ...style, width, height },
      };
      if (id === "tb-promo-btn") {
        root.style.fill = brand;
        root.variableBindings = { fill: "tb-brand" };
      }
      const label = {
        id: "label",
        templateKey: "label",
        type: "text",
        parentId: "root",
        name: "文案",
        text,
        hidden: false,
        locked: false,
        style: { ...style, x: 8, y: 8, width: width - 16, height: 24 },
      };
      const children = [label];
      if (id === "tb-nav-search") {
        children.push({
          ...label,
          id: "location",
          templateKey: "location",
          name: "当前定位",
          text: "杭州",
          style: { ...label.style, width: 48 },
        });
        label.style = { ...label.style, x: 64, width: width - 72 };
      }
      if (assetTier === "page") {
        children.push(
          {
            ...label,
            id: "search",
            templateKey: "search",
            name: "频道搜索",
            text: "搜索活动商品",
            style: { ...label.style, y: 48, height: 40, fill: "#f5f5f5" },
          },
          {
            ...label,
            id: "campaign",
            templateKey: "campaign",
            name: "主促楼层",
            text: "开门红满减专场",
            style: {
              ...label.style,
              y: 104,
              height: 96,
              fontSize: 24,
              fill: brand,
              radius: 12,
            },
            variableBindings: { fill: "tb-brand", radius: "tb-radius" },
          },
        );
      }
      const options =
        id === "tb-nav-search"
          ? ["日常态", "大促态"]
          : id === "tb-promo-btn"
            ? ["主按钮", "次按钮"]
            : ["默认"];
      return {
        id,
        name,
        category: "购物",
        assetTier,
        description: name,
        exposed: [{ id: "label", name: "文案", kind: "text", target: "label" }],
        variants: options.map((name, index) => ({
          id: index ? "alternate" : "default",
          name,
          properties: options.length > 1 ? { State: name } : {},
          nodes: [
            index
              ? {
                  ...root,
                  style: { ...root.style, fill: "#fff1e6" },
                  variableBindings: undefined,
                }
              : root,
            ...children,
          ],
        })),
      };
    });
    return {
      format: "forma/library",
      version: 1,
      id: libraryId,
      name: libraryName,
      description: "移动购物与促销",
      revision: 1,
      source: { name: "Forma 测试", license: "测试夹具" },
      components,
      designSystem: {
        collections: {
          tb: {
            id: "tb",
            name: "淘宝品牌语义色",
            defaultModeId: "light",
            modes: [{ id: "light", name: "浅色" }],
          },
        },
        variables: {
          "tb-radius": {
            id: "tb-radius",
            name: "楼层圆角",
            collectionId: "tb",
            type: "number",
            scopes: ["radius"],
            values: { light: 12 },
          },
          "tb-brand": {
            id: "tb-brand",
            name: "品牌主色",
            collectionId: "tb",
            type: "color",
            scopes: ["fill"],
            values: { light: brand },
          },
        },
        styles: {},
        activeModes: { tb: "light" },
      },
    };
  }

  async function editOfflinePlaybook() {
    await button("资源").click();
    await button("组件库管理").click();
    const manager = page.getByRole("dialog", { name: "组件库管理" });
    await manager.getByRole("tab", { name: "本文件与自定义" }).click();
    await manager.locator('input[type=file][accept=".json"]').setInputFiles({
      name: "tb.forma-library.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(shoppingLibrary())),
    });
    await manager
      .getByText(`已导入并保存「${libraryName}」 · 4 组件`)
      .waitFor();
    const open = manager.getByRole("button", {
      name: "AI 说明书 · " + libraryName,
      exact: true,
    });
    await open.click();
    await manager
      .getByText("Page 1 · Block 1 · Component 2 · 异常态 1", { exact: true })
      .waitFor();
    const field = manager.getByLabel("组件库 AI 说明书 Markdown");
    const start = "<!-- forma:custom-notes:start -->",
      end = "<!-- forma:custom-notes:end -->";
    const source = await field.inputValue();
    assert.ok(source.includes(start) && source.includes(end));
    const authored =
      source.slice(0, source.indexOf(start) + start.length) +
      customNote +
      source.slice(source.indexOf(end));
    // The playbook textarea is the last tabbable control in the guide.
    await field.focus();
    await page.keyboard.press("Tab");
    assert.ok(
      await manager
        .getByRole("button", { name: "关闭组件库管理" })
        .evaluate((el) => el === document.activeElement),
    );
    await page.keyboard.press("Shift+Tab");
    assert.ok(await field.evaluate((el) => el === document.activeElement));
    await field.fill(authored.replace("## 三级资产选型指南", "待刷新资产清单"));
    await manager.getByRole("button", { name: "增量刷新" }).click();
    assert.equal(await field.inputValue(), authored);
    await manager.getByRole("button", { name: "保存说明书" }).click();
    await manager
      .getByText(`已应用「${libraryName}」AI 说明书到当前文档（工作区已同步）`)
      .waitFor();
    await manager.getByRole("button", { name: "返回组件库列表" }).click();
    assert.ok(await open.evaluate((el) => el === document.activeElement));
    const record = manager
      .locator(".library-record-line")
      .filter({ hasText: libraryName })
      .filter({ has: page.getByRole("button", { name: "启用到当前文件" }) });
    const [exported] = await Promise.all([
      page.waitForEvent("download"),
      record.getByRole("button", { name: "导出 JSON" }).click(),
    ]);
    assert.equal(
      JSON.parse(await readFile(await exported.path(), "utf8")).aiGuide
        .playbookMarkdown,
      authored,
    );
    await open.click();
    assert.equal(await field.inputValue(), authored);
    await page.keyboard.press("Escape");
    assert.ok(await open.evaluate((el) => el === document.activeElement));
    await page.keyboard.press("Tab");
    assert.ok(
      await manager.evaluate((el) => el.contains(document.activeElement)),
    );
    await page.keyboard.press("Escape");
    await manager.waitFor({ state: "hidden" });
    await button("查看 主促按钮").click();
    const detail = page.getByRole("dialog", { name: "组件详情" });
    const tier = detail.getByLabel("AI 资产层级");
    const hint = detail.getByLabel("AI 适用场景提示");
    assert.equal(await tier.inputValue(), "component");
    await tier.selectOption("block");
    await hint.fill("尖货池活动");
    await detail.getByRole("button", { name: "保存 AI 标注" }).click();
    await detail
      .getByText("Block 业务模块 · 已标注", { exact: true })
      .waitFor();
    await detail.getByRole("button", { name: "关闭组件详情" }).click();
    await canvas.focus();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+z" : "Control+z",
    );
    await button("查看 主促按钮").click();
    assert.equal(await tier.inputValue(), "component");
    assert.equal(await hint.inputValue(), "");
    await detail.getByRole("button", { name: "关闭组件详情" }).click();
  }

  async function checkOfficialGuide() {
    const manager = page.getByRole("dialog", { name: "组件库管理" });
    const card = manager.locator(".kit-card").filter({
      has: page.getByRole("heading", {
        name: "Material Design 3",
        exact: true,
      }),
    });
    const trigger = card.locator("[data-guide-trigger]");
    const field = manager.getByLabel("组件库 AI 说明书 Markdown");
    await button("组件库管理").click();
    await trigger.click();
    const markdown =
      (await field.inputValue()) + "\n品牌备注：紧凑的移动列表。";
    await field.fill(markdown);
    await button("保存说明书").click();
    await manager
      .getByRole("status")
      .filter({ hasText: /AI 说明书到当前文档/ })
      .waitFor();
    await page.keyboard.press("Escape");
    assert.ok(await trigger.evaluate((el) => el === document.activeElement));
    await page.keyboard.press("Escape");
    await page.getByLabel("搜索组件").fill("悬浮按钮 FAB");
    await button("查看 悬浮按钮 FAB").click();
    const detail = page.getByRole("dialog", { name: "组件详情" });
    await detail.getByLabel("AI 资产层级").selectOption("block");
    await detail.getByLabel("AI 适用场景提示").fill("大促活动入口");
    await detail.getByRole("button", { name: "保存 AI 标注" }).click();
    await detail.getByText("Block 业务模块 · 已标注").waitFor();
    await detail.getByRole("button", { name: "关闭组件详情" }).click();
    await page.getByLabel("搜索组件").fill("");
    await button("组件库管理").click();
    const toggle = card.getByRole("switch");
    await toggle.uncheck();
    await manager
      .getByText("已保留你编辑的 AI 说明书与标注，重新启用后自动恢复")
      .waitFor();
    // The retained snapshot must be exported even while its quick browser is hidden.
    async function exportCard() {
      const [file] = await Promise.all([
        page.waitForEvent("download"),
        card.getByRole("button", { name: "导出 JSON" }).click(),
      ]);
      return JSON.parse(await readFile(await file.path(), "utf8"));
    }
    const hidden = await exportCard();
    const fab = hidden.components.find((c) => c.name === "悬浮按钮 FAB");
    assert.equal(hidden.aiGuide.playbookMarkdown, markdown);
    assert.equal(fab.assetTier, "block");
    assert.equal(fab.aiHints.whenToUse, "大促活动入口");
    await page.keyboard.press("Escape");
    const search = page.getByLabel("搜索组件");
    await search.fill("悬浮按钮 FAB");
    assert.equal(await button("查看 悬浮按钮 FAB").count(), 0);
    await button("组件库管理").click();
    await toggle.check();
    assert.deepEqual(await exportCard(), hidden);
    await trigger.click();
    assert.equal(await field.inputValue(), markdown);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await manager.waitFor({ state: "hidden" });
    await search.fill("");
  }

  async function contrastWhenVisible(container, selector) {
    return container.evaluate(async (root, selector) => {
      // Observe the actual extraction status: a tiny invalid input can finish within a frame.
      const element =
        root.querySelector(selector) ??
        (await new Promise((resolve, reject) => {
          const observer = new MutationObserver(() => {
            const found = root.querySelector(selector);
            if (found) {
              clearTimeout(timer);
              observer.disconnect();
              resolve(found);
            }
          });
          const timer = setTimeout(() => {
            observer.disconnect();
            reject(Error("Missing contrast sample " + selector));
          }, 8000);
          observer.observe(root, { childList: true, subtree: true });
        }));
      const rgb = (css) => css.match(/[.\d]+/g).map(Number);
      let bg;
      for (let node = element; node; node = node.parentElement) {
        const color = rgb(getComputedStyle(node).backgroundColor);
        if (color[3] === 0) continue;
        if ((color[3] ?? 1) !== 1)
          throw Error("Expected opaque status background");
        bg = color;
        break;
      }
      const luminance = (color) =>
        color.slice(0, 3).reduce((sum, channel, i) => {
          const c = channel / 255;
          return (
            sum +
            [0.2126, 0.7152, 0.0722][i] *
              (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
          );
        }, 0);
      const fg = luminance(rgb(getComputedStyle(element).color)),
        back = luminance(bg);
      return (Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05);
    }, selector);
  }

  async function checkGuideContrast() {
    // A second catalog connection publishes r2 while this document still uses r1.
    await page.evaluate(
      (id) =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open("forma-workspace-libraries-v1", 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("libraries", "readwrite"),
              store = tx.objectStore("libraries");
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = () => {
              db.close();
              reject(tx.error);
            };
            const record = store.get(id);
            record.onsuccess = () => {
              const value = record.result;
              store.put({
                ...value,
                revision: 2,
                library: {
                  ...value.library,
                  revision: 2,
                  description: "另一窗口发布的版本",
                },
              });
            };
          };
        }),
      libraryId,
    );
    const ratios = {};
    let workspaceMarkdown;
    for (const theme of ["light", "dark"]) {
      if ((await page.locator(".app").getAttribute("data-theme")) !== theme)
        await page.getByRole("button", { name: /^切换[浅深]色主题$/ }).click();
      await page.locator(`.app[data-theme="${theme}"]`).waitFor();
      await button("组件库管理").click();
      const manager = page.getByRole("dialog", { name: "组件库管理" });
      await manager.getByRole("tab", { name: "本文件与自定义" }).click();
      const [status] = await Promise.all([
        contrastWhenVisible(manager, ".library-quick-card small"),
        manager.locator('input[accept=".fig,.sketch"]').setInputFiles({
          name: "invalid.fig",
          mimeType: "application/octet-stream",
          buffer: Buffer.from("invalid fixture"),
        }),
      ]);
      await manager.getByRole("alert").waitFor();
      await manager
        .getByRole("button", {
          name: "AI 说明书 · " + libraryName,
          exact: true,
        })
        .click();
      const guide = manager.getByLabel("组件库 AI 说明书 Markdown");
      workspaceMarkdown ??= await guide.inputValue();
      const documentMarkdown =
        workspaceMarkdown + "\n本文档专用备注 · " + theme;
      await guide.fill(documentMarkdown);
      await button("保存说明书").click();
      await manager
        .getByRole("alert")
        .filter({ hasText: "工作区中已有更新版本 r2，未覆盖工作区副本" })
        .waitFor();
      const error = await contrastWhenVisible(manager, ".library-guide-error");
      ratios[theme] = { status, error };
      assert.ok(
        status >= 4.5 && error >= 4.5,
        theme + " " + JSON.stringify(ratios[theme]),
      );
      await page.keyboard.press("Escape");
      const trigger = manager.getByRole("button", {
        name: "AI 说明书 · " + libraryName,
        exact: true,
      });
      await trigger.click();
      assert.equal(await guide.inputValue(), documentMarkdown);
      await page.keyboard.press("Escape");
      const workspaceCard = manager.locator(".library-record-line").filter({
        hasText: libraryName,
        has: page.getByRole("button", { name: "启用到当前文件" }),
      });
      const [savedFile] = await Promise.all([
        page.waitForEvent("download"),
        workspaceCard.getByRole("button", { name: "导出 JSON" }).click(),
      ]);
      const savedLibrary = JSON.parse(
        await readFile(await savedFile.path(), "utf8"),
      );
      assert.equal(savedLibrary.revision, 2);
      assert.equal(savedLibrary.description, "另一窗口发布的版本");
      assert.equal(savedLibrary.aiGuide.playbookMarkdown, workspaceMarkdown);
      await page.keyboard.press("Escape");
      await manager.waitFor({ state: "hidden" });
    }
    return ratios;
  }

  const photo =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGNoD7EAIgYIBQAfXgRNqpqd+wAAAABJRU5ErkJggg==";
  const upstreamScreenshots = [];
  let critiqueGate = Promise.withResolvers();
  function coffeeDesign(refined) {
    return {
      name: "手冲订阅",
      width: 320,
      height: 240,
      summary: refined ? "手冲订阅精修稿" : "手冲订阅初稿",
      reply: refined ? critiqueNote : "请预览手冲订阅卡。",
      html: `<article data-forma-name="咖啡卡片"><span data-icon="coffee"></span><img src="${photo}" alt="咖啡配图"><h2>${refined ? refinedTitle : firstTitle}</h2></article>`,
      css: `article{display:flex;flex-direction:column;width:320px;height:240px;padding:16px;gap:${refined ? 16 : 8}px;background:#f2dfc8;color:#392720}img{width:80px;height:48px;object-fit:cover}h2{font-size:20px}`,
    };
  }
  function respondToModel(res, stream, tool_calls, content) {
    const message = tool_calls.length ? { tool_calls } : { content };
    const finish_reason = tool_calls.length ? "tool_calls" : "stop";
    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const delta = tool_calls.length
        ? {
            tool_calls: tool_calls.map((item, index) => ({ ...item, index })),
          }
        : message;
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message, finish_reason }] }));
    }
  }
  let modelReads = 0;
  const mockServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.url === "/v1/models" && req.method === "GET") {
      modelReads++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            {
              id: modelId,
              name: "DeepSeek-V4.1-Flash",
              context_window: 1000000,
              max_output_tokens: 393216,
              input_modalities: ["text", "image"],
            },
          ],
        }),
      );
      return;
    }
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      const blueprint = {
        mode: "generate",
        reply: "已根据您的需求生成深色主题 H5 登录页，采用自动布局与圆角卡片。",
        summary: "新增 H5 登录页（含标题、表单卡片与登录按钮）",
        artboards: [
          {
            refId: "ai-h5-login",
            type: "frame",
            name: "AI 生成 · H5 登录页",
            style: {
              width: 390,
              height: 844,
              layout: "column",
              padding: 24,
              gap: 20,
              fill: "#0F172A",
              radius: 24,
            },
            children: [
              {
                type: "text",
                name: "登录标题",
                text: "欢迎回到 Forma",
                style: {
                  fontSize: 28,
                  fontWeight: 700,
                  color: "#F8FAFC",
                  widthMode: "fill",
                  heightMode: "hug",
                },
              },
              {
                type: "frame",
                name: "表单卡片",
                style: {
                  layout: "column",
                  padding: 20,
                  gap: 14,
                  fill: "#1E293B",
                  radius: 16,
                  widthMode: "fill",
                  heightMode: "hug",
                },
                children: [
                  {
                    type: "text",
                    name: "邮箱标签",
                    text: "工作邮箱",
                    style: {
                      fontSize: 13,
                      color: "#94A3B8",
                      widthMode: "fill",
                      heightMode: "hug",
                    },
                  },
                  {
                    type: "button",
                    name: "主登录按钮",
                    text: "立即登录",
                    style: {
                      widthMode: "fill",
                      height: 46,
                      fill: "#0D99FF",
                      color: "#FFFFFF",
                      radius: 12,
                      fontSize: 15,
                      fontWeight: 600,
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const tools = body.tools?.map((tool) => tool.function.name) ?? [];
      const results = body.messages.filter((m) => m.role === "tool");
      if (JSON.stringify(body.messages).includes(campaignPrompt)) {
        await campaignModel(body, res, tools, results);
        return;
      }
      if (JSON.stringify(body.messages).includes(htmlPrompt)) {
        if (body.model !== modelId || !tools.includes("propose_html_design")) {
          res.writeHead(422).end("HTML proposal tool missing");
          return;
        }
        const critique = !tools.includes("get_canvas_overview");
        if (critique) {
          const parts = body.messages.find((m) => m.role === "user")?.content;
          const screenshot =
            Array.isArray(parts) &&
            parts.find((p) => p.type === "image_url")?.image_url?.url;
          upstreamScreenshots.push(screenshot);
          await critiqueGate.promise;
        }
        const calls = results.length
          ? []
          : [
              {
                id: critique ? "qa-html-refine" : "qa-html-draft",
                type: "function",
                function: {
                  name: "propose_html_design",
                  arguments: JSON.stringify(coffeeDesign(critique)),
                },
              },
            ];
        respondToModel(res, body.stream, calls, "手冲订阅初稿已就绪。");
        return;
      }
      const advertised = [
        "get_canvas_overview",
        "activate_skill",
        "propose_design_changes",
      ];
      if (
        body.model !== modelId ||
        !advertised.every((name) => tools.includes(name)) ||
        (receivedRounds.length < 3 &&
          !JSON.stringify(body.messages).includes(instructions))
      ) {
        res.writeHead(422);
        res.end(
          "Expected Forma tools and the explicitly selected Skill instructions",
        );
        return;
      }
      const call = (id, name, args) => ({
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
      const ids = results.map((m) => m.tool_call_id);
      const expected = ["qa-overview", "qa-craft", "qa-propose"];
      if (
        ![0, 2, 3].includes(ids.length) ||
        !ids.every((id, i) => id === expected[i]) ||
        results.some((m) => !JSON.parse(m.content).ok)
      ) {
        res.writeHead(422);
        res.end("Unexpected tool results");
        return;
      }
      receivedRounds.push(ids);
      const tool_calls =
        results.length === 0
          ? [
              call(expected[0], advertised[0], {}),
              call(expected[1], advertised[1], { name: craftId }),
            ]
          : results.length === 2
            ? [call(expected[2], advertised[2], blueprint)]
            : [];
      respondToModel(res, body.stream, tool_calls, "登录页已准备好供预览。");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(0, "127.0.0.1", resolve);
  });
  const port = mockServer.address().port;
  const mockBaseUrl = `http://127.0.0.1:${port}/v1`;
  let savedProfileId = null;

  let importedSkillId = null;
  let originalActiveId = null;
  const probes = [];
  const recordProbe = (request) => {
    if (new URL(request.url()).pathname === "/api/agent/detect")
      probes.push(request.postDataJSON().providerId);
  };
  page.on("request", recordProbe);
  const responseFor = (method, path) =>
    page.waitForResponse(
      (r) =>
        r.request().method() === method &&
        new URL(r.url()).pathname === "/api/agent/" + path,
    );
  async function act(method, path, action) {
    const [response] = await Promise.all([responseFor(method, path), action()]);
    assert.ok(
      response.ok(),
      method + " " + path + " returned " + response.status(),
    );
    return response.json();
  }
  try {
    await button("AI 设计助手").click();
    await page.getByText("未连接模型", { exact: true }).waitFor();
    await editOfflinePlaybook();
    await checkOfficialGuide();
    const guideContrast = await checkGuideContrast();
    await button("AI 设计助手").click();
    await page.getByLabel("目标组件库").selectOption(libraryId);
    await page.getByText("AI 说明书就绪 · P1/B1/C2", { exact: true }).waitFor();
    assert.deepEqual(
      initialAgentRequests,
      [],
      "Panel, playbook and asset annotations must stay offline",
    );
    page.off("request", onReq);
    // Keep the existing unscoped scenarios independent of the shopping library.
    await page.getByLabel("目标组件库").selectOption("");
    const original = await act("GET", "status", () =>
      button("配置模型供应商").click(),
    );
    originalActiveId = original.activeProfileId;
    const modal = page.getByRole("dialog", { name: "配置 AI 模型服务" });
    const keyInput = modal.getByLabel("API Key", { exact: true });
    await modal.getByText("第一步 · 选择模型供应商").waitFor();
    assert.equal(await modal.getByText("自动识别模式").count(), 0);
    if (!original.activeProfile) assert.equal(await keyInput.count(), 0);
    const deepseek = modal.getByRole("button", {
      name: "DeepSeek",
      exact: true,
    });
    await deepseek.click();
    await keyInput.fill("sk-31234567890abcdef");
    assert.ok(
      await modal
        .locator(".agent-provider-grid")
        .evaluate((grid) =>
          Boolean(
            grid.compareDocumentPosition(
              document.querySelector("#agent-api-key"),
            ) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        ),
    );
    assert.equal(
      await modal
        .locator(".agent-provider-card.is-suggested, .agent-key-conflict")
        .count(),
      0,
    );
    assert.equal(
      await modal.locator(".agent-provider-card.is-selected").count(),
      1,
    );
    await keyInput.fill("sk-ant-api03-demo123456");
    await modal.getByRole("button", { name: "切换到 Claude" }).waitFor();
    assert.equal(await deepseek.getAttribute("aria-pressed"), "true");
    await modal
      .getByRole("button", { name: "自定义兼容网关", exact: true })
      .click();
    await modal.getByLabel("自定义 Base URL").fill(mockBaseUrl);
    await keyInput.fill("sk-test-e2e-9999");
    const detected = await act("POST", "detect", () =>
      modal.getByRole("button", { name: "连接并获取模型" }).click(),
    );
    assert.deepEqual(probes, ["custom"]);
    assert.equal(detected.providerId, "custom");
    const card = modal.locator(".agent-detect-card");
    assert.equal(await card.getByLabel("选用模型").inputValue(), modelId);
    const verifyCaps = async (root) => {
      for (const label of ["视觉识图", "工具调用", "上下文 1M", "接口实时声明"])
        await root.getByText(label, { exact: true }).waitFor();
    };
    await verifyCaps(card);
    await card.getByLabel("手动输入模型 ID").check();
    await card
      .getByRole("textbox", { name: "模型 ID", exact: true })
      .fill("qa-unknown-model");
    await card.getByText("视觉未声明", { exact: true }).waitFor();
    await card.getByLabel("手动输入模型 ID").uncheck();
    await verifyCaps(card);

    const savedProfile = await act("POST", "profiles", () =>
      modal.getByRole("button", { name: "保存并启用" }).click(),
    );
    savedProfileId = savedProfile.profile.id;
    assert.equal(savedProfile.status.activeProfileId, savedProfileId);
    assert.ok(!JSON.stringify(savedProfile).includes("sk-test-e2e-9999"));
    await modal.waitFor({ state: "hidden" });
    await button("配置模型供应商").click();
    await modal.getByRole("tab", { name: "已保存连接" }).click();
    const profile = modal
      .locator(".agent-profile-card")
      .filter({ hasText: mockBaseUrl });
    const profilePath = "profiles/" + savedProfileId;
    await verifyCaps(profile);
    await profile.getByText("调整能力", { exact: true }).click();
    await act("PATCH", profilePath, () =>
      profile.getByLabel("支持视觉识图").uncheck(),
    );
    await profile.getByText("手动覆写", { exact: true }).waitFor();
    const reads = modelReads;
    await act("POST", profilePath + "/refresh", () =>
      profile.getByRole("button", { name: "刷新模型" }).click(),
    );
    assert.ok(modelReads > reads);
    await profile.getByText("仅文本", { exact: true }).waitFor();
    const reset = await act("PATCH", profilePath, () =>
      profile.getByRole("button", { name: "恢复自动检测" }).click(),
    );
    assert.equal(reset.profile.capabilities.supportsVision, true);
    await verifyCaps(profile);
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "hidden" });

    const skillList = await act("GET", "skills", () =>
      button("管理设计技能（Skills）").click(),
    );
    const manager = page.getByRole("dialog", { name: "管理设计技能" });
    for (const name of [craftId, "mobile-h5-accessibility-audit"]) {
      assert.ok(
        skillList.skills.some(
          (skill) => skill.id === name && skill.source === "builtin",
        ),
      );
      await manager.getByRole("article", { name, exact: true }).waitFor();
    }
    await manager.getByRole("tab", { name: "导入第三方 Skill" }).click();
    await manager
      .getByLabel("SKILL.md 内容")
      .fill(
        `---\nname: ${testSkill}\ndescription: 登录页设计检查\n---\n\n${instructions}`,
      );
    await manager.getByLabel(/添加参考文档/).setInputFiles({
      name: "spacing.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("Use an 8px gap."),
    });
    const imported = await act("POST", "skills/import", () =>
      manager.getByRole("button", { name: "导入技能", exact: true }).click(),
    );
    importedSkillId = imported.skill.id;
    const skillCard = manager.getByRole("article", {
      name: testSkill,
      exact: true,
    });
    await skillCard.getByText("完全兼容", { exact: true }).waitFor();
    await skillCard.getByText("1 份文档", { exact: true }).waitFor();
    await skillCard.getByRole("button", { name: "查看完整指令" }).click();
    await skillCard.locator("pre").filter({ hasText: instructions }).waitFor();
    await page.keyboard.press("Escape");
    await manager.waitFor({ state: "hidden" });
    await button("选择本轮技能").click();
    await page.getByRole("checkbox", { name: testSkill, exact: true }).check();
    await page
      .getByLabel("本轮已选技能")
      .getByRole("button", { name: "移除本轮技能 " + testSkill })
      .waitFor();

    await page.getByLabel("生成引擎模式").selectOption("html");
    // 1.5 Verify right-sidebar contextual AI entry on ANY selected layer
    await page.getByRole("button", { name: "图层", exact: true }).click();
    const firstFrame = page
      .locator('.design-node[data-node-type="frame"]')
      .first();
    const firstFrameId = await firstFrame.getAttribute("data-node-id");
    assert.ok(firstFrameId, "Expected at least one frame on canvas");
    await page.locator(`[data-layer-id="${firstFrameId}"] .layer-main`).click();
    const rightAiBtn = page
      .locator("#right-panel")
      .getByRole("button", { name: "用 AI 生成或编辑选中图层", exact: true });
    await button("AI 设计助手").click();
    await page.getByText("当前选区将使用蓝图编辑", { exact: true }).waitFor();
    await rightAiBtn.waitFor();
    await rightAiBtn.click();
    const bar = page.locator(".canvas-agent-bar");
    await bar.waitFor();
    const scopeText = await bar.locator(".canvas-agent-scope-pill").innerText();
    assert.ok(
      scopeText.includes("当前选区："),
      `Expected scope pill to reference selected layer, got: ${scopeText}`,
    );
    // The bar moves focus on the next animation frame after opening.
    await page.waitForFunction(
      () =>
        document.activeElement ===
        document.querySelector(".canvas-agent-bar textarea"),
    );
    const hud = page.locator(".canvas-agent-hud");
    async function sendCanvasPrompt(prompt) {
      await bar.getByLabel("画布 AI 指令").fill(prompt);
      const [request] = await Promise.all([
        page.waitForRequest(
          (r) => new URL(r.url()).pathname === "/api/agent/chat",
        ),
        bar.getByRole("button", { name: "发送 AI 指令" }).click(),
      ]);
      await hud.waitFor({ timeout: 10000 });
      return request.postDataJSON();
    }
    const scoped = await sendCanvasPrompt("在所选画板内生成深色 H5 登录页");
    assert.equal(scoped.selection, firstFrameId);
    assert.equal(scoped.generationMode, "blueprint");
    assert.deepEqual(scoped.activeSkills, [testSkill]);
    await canvas.locator(".design-node.is-ai-preview").first().waitFor();
    await hud.getByRole("button", { name: "丢弃" }).click();
    await hud.waitFor({ state: "hidden" });
    await bar.getByLabel("画布 AI 指令").focus();
    // Close via Escape, then reopen via Cmd/Ctrl+Enter with empty selection
    await page.keyboard.press("Escape");
    await bar.waitFor({ state: "hidden" });

    await page.getByLabel("生成引擎模式").selectOption("auto");
    // 2. Open Canvas Inline Agent Bar via Cmd/Ctrl+Enter
    await canvas.focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Enter" : "Control+Enter",
    );
    await bar.waitFor();
    const initialLayerCount = await page.locator(".milestone").innerText();

    const unscoped = await sendCanvasPrompt(
      "生成一个深色主题 H5 登录页，带标题、表单卡片和登录按钮",
    );
    assert.equal(unscoped.selection, null);
    assert.deepEqual(unscoped.activeSkills ?? [], []);

    // Verify the uncommitted design before applying it to the canvas.
    const artboard = canvas
      .locator('.design-node.is-ai-preview[data-node-type="frame"]')
      .filter({ hasText: "欢迎回到 Forma" });
    await artboard.waitFor();
    await artboard.getByText("工作邮箱", { exact: true }).waitFor();
    await artboard.getByText("立即登录", { exact: true }).waitFor();
    const preview = await artboard.evaluate((root) => {
      const style = getComputedStyle(root);
      return {
        ids: [root, ...root.querySelectorAll(".design-node")].map(
          (n) => n.dataset.nodeId,
        ),
        width: root.offsetWidth,
        height: root.offsetHeight,
        layout: style.flexDirection,
      };
    });
    assert.equal(preview.width, 390);
    assert.equal(preview.height, 844);
    assert.equal(preview.layout, "column");
    assert.equal(preview.ids.length, 5);

    // The editor culls offscreen layers when the camera fits the new artboard.
    // Compare the generated IDs across preview, commit and undo.
    await hud.getByRole("button", { name: /采纳到画布/ }).click();
    await hud.waitFor({ state: "hidden" });
    await page.waitForFunction(
      (ids) =>
        ids.every((id) => {
          const el = document.querySelector(
            '.editor-canvas [data-node-id="' + CSS.escape(id) + '"]',
          );
          return el && !el.classList.contains("is-ai-preview");
        }),
      preview.ids,
    );

    // 5. Single-step Undo removes the entire generated artboard cleanly
    await canvas.focus();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+z" : "Control+z",
    );
    await page.waitForFunction(
      (ids) =>
        ids.every(
          (id) =>
            !document.querySelector(
              '.editor-canvas [data-node-id="' + CSS.escape(id) + '"]',
            ),
        ),
      preview.ids,
    );
    assert.equal(
      await page.locator(".milestone").innerText(),
      initialLayerCount,
    );

    await button("AI 设计助手").click();
    const replies = page.locator(".agent-msg-assistant");
    assert.equal(await replies.count(), 2);
    for (let i = 0; i < 2; i++) {
      const reply = replies.nth(i);
      await reply.getByText(/调用详情 · 3 次工具调用/).click();
      for (const name of [
        "get_canvas_overview",
        "activate_skill",
        "propose_design_changes",
      ])
        await reply.getByText(name, { exact: true }).waitFor();
      const badges = reply.getByLabel("已激活技能");
      await badges.getByText(craftId, { exact: true }).waitFor();
      assert.equal(
        await badges.getByText(testSkill, { exact: true }).count(),
        i === 0 ? 1 : 0,
      );
      assert.equal(await reply.locator('[data-status="ok"]').count(), 3);
    }
    const expectedRounds = [
      [],
      ["qa-overview", "qa-craft"],
      ["qa-overview", "qa-craft", "qa-propose"],
    ];
    assert.deepEqual(receivedRounds, [...expectedRounds, ...expectedRounds]);

    // V2: hold the upstream critique until the designer can see the native first draft.
    await page.setViewportSize({ width: 1280, height: 650 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    const sandboxes = await page.evaluateHandle(() => {
      const permissions = [];
      const observer = new MutationObserver((records) => {
        for (const record of records)
          for (const frame of record.addedNodes)
            if (
              frame instanceof HTMLIFrameElement &&
              frame.hasAttribute("sandbox")
            )
              permissions.push(frame.getAttribute("sandbox"));
      });
      observer.observe(document.body, { childList: true });
      return { observer, permissions };
    });
    const mode = page.getByLabel("生成引擎模式");
    const selfReview = button("视觉自审精修");
    assert.equal(await mode.inputValue(), "auto");
    assert.equal(await selfReview.getAttribute("aria-pressed"), "true");
    const themeSwitch = page.getByRole("button", {
      name: /^切换[浅深]色主题$/,
    });
    for (let appearance = 0; appearance < 2; appearance++) {
      assert.ok(
        await mode.evaluate((select) => {
          const toolbar = select.closest(".agent-composer-toolbar");
          return toolbar.scrollWidth <= toolbar.clientWidth;
        }),
        "Composer controls must fit at 1280 × 650",
      );
      await themeSwitch.click();
    }
    await selfReview.click();
    assert.equal(await selfReview.getAttribute("aria-pressed"), "false");
    await selfReview.click();
    await mode.selectOption("html");
    const critiqueRequest = () =>
      page.waitForRequest(
        (r) =>
          r.method() === "POST" &&
          new URL(r.url()).pathname === "/api/agent/critique",
      );
    const [htmlChat, reviewRequest] = await Promise.all([
      sendCanvasPrompt(htmlPrompt),
      critiqueRequest(),
    ]);
    assert.equal(htmlChat.generationMode, "html");
    assert.equal(htmlChat.selection, null);
    await canvas.getByText(firstTitle, { exact: true }).waitFor();
    await bar
      .getByText("正在截屏执行多模态视觉自审精修…", { exact: true })
      .waitFor();
    const review = reviewRequest.postDataJSON();
    assert.equal(review.profileId, savedProfileId);
    assert.equal(review.model, modelId);
    assert.equal(review.prompt, htmlPrompt);
    assert.deepEqual(review.document, htmlChat.document);
    assert.equal(review.htmlDraft.imagesLocalized, 1);
    assert.match(
      review.renderedImageDataUrl,
      /^data:image\/png;base64,iVBORw0KGgo/,
    );
    const raster = await page.evaluate(async (url) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const surface = document.createElement("canvas");
      surface.width = img.naturalWidth;
      surface.height = img.naturalHeight;
      const ctx = surface.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return {
        width: surface.width,
        height: surface.height,
        background: [...ctx.getImageData(4, 4, 1, 1).data],
      };
    }, review.renderedImageDataUrl);
    assert.deepEqual(raster, {
      width: 320,
      height: 240,
      background: [242, 223, 200, 255],
    });

    const revised = await act("POST", "critique", () => critiqueGate.resolve());
    assert.deepEqual(upstreamScreenshots, [review.renderedImageDataUrl]);
    assert.equal(revised.improved, true);
    const coffeeCard = canvas
      .locator('.design-node.is-ai-preview[data-node-type="frame"]')
      .filter({ hasText: refinedTitle })
      .last();
    await coffeeCard.waitFor();
    assert.equal(
      await coffeeCard.evaluate((el) => getComputedStyle(el).flexDirection),
      "column",
    );
    assert.equal(
      await coffeeCard.evaluate((el) => getComputedStyle(el).gap),
      "16px",
    );
    const vectorIcon = coffeeCard
      .locator('[data-node-type="vector"] svg')
      .first();
    await vectorIcon.waitFor();
    assert.ok((await vectorIcon.locator("path").count()) >= 1);
    const bitmap = coffeeCard.locator('[data-node-type="rectangle"] img');
    await bitmap.waitFor();
    assert.equal(await bitmap.getAttribute("src"), photo);
    await coffeeCard
      .locator('[data-node-type="text"]')
      .getByText(refinedTitle, { exact: true })
      .waitFor();
    assert.equal(
      await canvas.getByText(firstTitle, { exact: true }).count(),
      0,
    );
    const htmlIds = await canvas
      .locator(".design-node.is-ai-preview")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.nodeId));
    assert.equal(htmlIds.length, 5);
    assert.deepEqual(
      await sandboxes.evaluate(({ permissions, observer }) => {
        observer.disconnect();
        return permissions;
      }),
      ["allow-same-origin", "allow-same-origin"],
    );
    await sandboxes.dispose();
    const revisedReply = replies.last();
    await revisedReply.getByText(/调用详情 · 2 次工具调用/).click();
    await revisedReply
      .locator(".agent-critique-notes")
      .getByRole("listitem")
      .filter({ hasText: critiqueNote })
      .waitFor();
    assert.equal(
      await revisedReply
        .getByText("propose_html_design", { exact: true })
        .count(),
      2,
    );
    await hud.getByRole("button", { name: "采纳到画布" }).click();
    await hud.waitFor({ state: "hidden" });
    for (const id of htmlIds)
      await canvas
        .locator(`[data-node-id="${id}"]:not(.is-ai-preview)`)
        .waitFor();
    await canvas.focus();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+z" : "Control+z",
    );
    for (const id of htmlIds)
      await canvas
        .locator(`[data-node-id="${id}"]`)
        .waitFor({ state: "detached" });
    assert.equal(
      await page.locator(".milestone").innerText(),
      initialLayerCount,
    );

    // Direct panel sends share the same pipeline. Stopping a review leaves its draft actionable.
    critiqueGate = Promise.withResolvers();
    await page.getByLabel("设计需求", { exact: true }).fill(htmlPrompt);
    await Promise.all([critiqueRequest(), button("生成设计").click()]);
    await button("正在生成 · 取消").click();
    await button("生成设计").waitFor();
    await canvas.getByText(firstTitle, { exact: true }).waitFor();
    await hud.getByRole("button", { name: "丢弃" }).click();
    critiqueGate.resolve();
    await hud.waitFor({ state: "hidden" });
    await canvas
      .locator(".is-ai-preview")
      .first()
      .waitFor({ state: "detached" });
    assert.equal(await canvas.locator(".is-ai-preview").count(), 0);
    assert.equal(
      await page.locator(".milestone").innerText(),
      initialLayerCount,
    );
    // Stage 1: exercise the real HTTP tool loop, sandbox compiler and editor history.
    await page.setViewportSize({ width: 1024, height: 480 });
    await button("清空对话历史").click();
    assert.equal(await selfReview.getAttribute("aria-pressed"), "true");
    const target = page.getByLabel("目标组件库");
    await target.selectOption(libraryId);
    const chatRequests = [];
    const onChat = (r) => {
      if (new URL(r.url()).pathname === "/api/agent/chat")
        chatRequests.push(r.postDataJSON());
    };
    page.on("request", onChat);
    const sandboxLog = await page.evaluateHandle(() => {
      const permissions = [];
      const observer = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes)
            if (node instanceof HTMLIFrameElement)
              permissions.push(node.getAttribute("sandbox"));
      });
      observer.observe(document.body, { childList: true });
      return { permissions, observer };
    });
    await page.getByLabel("设计需求", { exact: true }).fill(campaignPrompt);
    await button("生成设计").click();
    const scopeCard = page.locator(".agent-scope-card");
    await scopeCard.getByText(scopePlan.summary, { exact: true }).waitFor();
    await scopeCard.getByText(libraryName, { exact: true }).waitFor();
    for (const screen of screens) {
      const row = scopeCard
        .getByRole("listitem")
        .filter({ hasText: screen.name });
      await row
        .getByText(screen.width + " × " + screen.height, { exact: true })
        .waitFor();
      await row
        .getByText(screen.role === "primary" ? "主流程" : "异常态", {
          exact: true,
        })
        .waitFor();
    }
    assert.equal(
      await scopeCard
        .getByRole("button", { name: "秒杀" })
        .getAttribute("aria-pressed"),
      "true",
    );
    await scopeCard.getByRole("button", { name: "满减" }).click();
    for (let appearance = 0; appearance < 2; appearance++) {
      assert.ok(
        await scopeCard.evaluate((el) => el.scrollWidth <= el.clientWidth),
      );
      assert.ok(
        await target.evaluate(
          (el) =>
            el.closest(".agent-target-library").scrollWidth <=
            el.closest(".agent-target-library").clientWidth,
        ),
      );
      await themeSwitch.click();
    }
    const [campaignCritique, response] = await Promise.all([
      critiqueRequest(),
      responseFor("POST", "critique"),
      scopeCard.getByRole("button", { name: "确认并直接生成" }).click(),
    ]);
    const reviewBody = campaignCritique.postDataJSON();
    assert.deepEqual(
      reviewBody.renderedImages.map(({ refId, name }) => ({ refId, name })),
      screens.map(({ refId, name }) => ({ refId, name })),
    );
    const images = reviewBody.renderedImages.map((image) => image.dataUrl);
    assert.equal(reviewBody.renderedImageDataUrl, images[0]);
    assert.deepEqual(campaignScreenshots, [images]);
    for (const [index, url] of images.entries()) {
      assert.match(url, /^data:image\/png;base64,iVBORw0KGgo/);
      const png = Buffer.from(url.split(",")[1], "base64");
      assert.equal(png.readUInt32BE(16), screens[index].width);
      assert.equal(png.readUInt32BE(20), screens[index].height);
    }
    assert.ok(response.ok());
    const revision = await response.json();
    assert.equal(revision.improved, true);
    const identity = ({ refId, name, role, parentRef, width, height }) => ({
      refId,
      name,
      role,
      parentRef,
      width,
      height,
    });
    assert.deepEqual(
      revision.htmlDraft.artboards.map(identity),
      screens.map(identity),
    );
    await replies
      .last()
      .getByText(campaignReviewNote, { exact: true })
      .first()
      .waitFor();
    await button("生成设计").waitFor();
    await replies.last().locator(".agent-call-details summary").click();
    await replies
      .last()
      .locator(".agent-diagnostic")
      .filter({ hasText: "无效的文本覆写：旧槽位" })
      .waitFor();
    const proposal = page.locator(".agent-panel-root .proposal");
    await proposal.getByText("2 组件", { exact: true }).waitFor();
    const tokenPill = proposal
      .locator(".agent-cap-pill")
      .filter({ hasText: /^[1-9]\d* 变量$/ });
    const bindings = parseInt(await tokenPill.innerText(), 10);
    assert.equal(await scopeCard.count(), 1);
    assert.ok(
      await scopeCard.getByRole("button", { name: "范围已确认" }).isDisabled(),
    );
    page.off("request", onChat);
    assert.equal(chatRequests.length, 2);
    const [initial, confirmed] = chatRequests;
    assert.equal(initial.confirmedScope, undefined);
    assert.equal(initial.selection, null);
    assert.ok(confirmed.prompt.includes(campaignPrompt));
    assert.deepEqual(confirmed.confirmedScope.screens, screens);
    assert.equal(confirmed.confirmedScope.decisions[0].defaultChoice, "满减");
    for (const request of chatRequests) {
      assert.equal(request.targetLibraryId, libraryId);
      assert.deepEqual(request.memoryScope, {
        projectId: request.document.id,
        libraryId,
      });
    }
    assert.equal(campaignRounds.length, 4);
    for (const [i, round] of campaignRounds.entries()) {
      assert.equal(round.tools.includes("propose_scope_plan"), i < 2);
      assert.deepEqual(
        round.ctx.confirmedScope,
        i < 2 ? null : confirmed.confirmedScope,
      );
    }
    const playbook = campaignRounds[1].toolResult;
    assert.equal(playbook.libraryId, libraryId);
    assert.ok(playbook.playbookMarkdown.includes(customNote));
    assert.equal(campaignRounds[3].toolResult.artboardCount, 2);
    assert.deepEqual(
      await sandboxLog.evaluate(({ observer, permissions }) => {
        observer.disconnect();
        return permissions;
      }),
      Array(4).fill("allow-same-origin"),
    );
    await sandboxLog.dispose();

    async function downloadDocument() {
      const [file] = await Promise.all([
        page.waitForEvent("download"),
        button("设计文件").click(),
      ]);
      return JSON.parse(await readFile(await file.path(), "utf8"));
    }
    const beforeApply = await downloadDocument();
    await proposal.getByRole("button", { name: "应用到设计" }).click();
    await proposal.waitFor({ state: "hidden" });
    const applied = await downloadDocument();
    const priorIds = new Set(beforeApply.nodes.map((n) => n.id));
    const created = applied.nodes.filter((n) => !priorIds.has(n.id));
    const roots = created.filter((n) => n.parentId === null);
    assert.deepEqual(
      roots.map((n) => n.name),
      screens.map((s) => s.name),
    );
    const [home, empty] = roots;
    assert.equal(empty.style.x, home.style.x);
    assert.equal(empty.style.y, home.style.y + home.style.height + 80);
    assert.ok(
      created.some((n) => n.text === "换个关键词试试"),
      "Refined empty state was applied",
    );
    assert.deepEqual(
      roots.map((n) => [n.style.width, n.style.height]),
      screens.map((s) => [s.width, s.height]),
    );
    const instances = created.filter((n) => n.instance);
    assert.deepEqual(
      instances.map((n) => n.instance),
      ["tb-nav-search", "tb-empty-state"].map((componentId) => ({
        componentId,
        libraryId,
        variantId: "default",
      })),
    );
    for (const instance of instances) {
      assert.ok(
        created.some(
          (n) => n.parentId === instance.id && n.templateKey === "label",
        ),
      );
      assert.ok(
        applied.libraries[libraryId].components.some(
          (c) => c.id === instance.instance.componentId,
        ),
      );
    }
    const promo = created.find((n) => n.name === "尖货促销楼层");
    assert.equal(promo?.variableBindings?.fill, "tb-brand");
    assert.equal(promo.variableBindings.radius, "tb-radius");
    assert.equal(
      bindings,
      created.reduce(
        (count, n) => count + Object.keys(n.variableBindings ?? {}).length,
        0,
      ),
    );
    // The exported instance source is live: the same editor validator must reject removing its text slot.
    const label = created.find(
      (n) => n.parentId === instances[0].id && n.templateKey === "label",
    );
    const manual = page.locator(".agent-external-details");
    await manual.locator("summary").first().click();
    await manual.getByLabel("Agent 事务 JSON").fill(
      JSON.stringify({
        baseRevision: applied.revision,
        operations: [{ type: "remove", id: label.id }],
      }),
    );
    await manual.getByRole("button", { name: "校验并预览" }).click();
    await page
      .locator(".agent-panel-root")
      .getByRole("alert")
      .filter({ hasText: "组件结构受保护" })
      .waitFor();
    assert.equal(await proposal.count(), 0);
    await canvas.focus();
    await page.keyboard.press("Shift+1");
    for (const root of roots)
      await canvas
        .locator(`[data-node-id="${root.id}"]:not(.is-ai-preview)`)
        .waitFor();
    const node = (id) => canvas.locator(`[data-node-id="${id}"]`);
    await button("图层").click();
    await page.locator(`[data-layer-id="${home.id}"] .layer-main`).click();
    await canvas.focus();
    await page.keyboard.press("Shift+2");
    const authoredText = "搜索开门红好物";
    await node(label.id).dblclick();
    const editor = page.getByRole("textbox", { name: "画布文本编辑" });
    await editor.fill(authoredText);
    await editor.press("Escape");
    await node(label.id).getByText(authoredText, { exact: true }).waitFor();
    const edited = await downloadDocument();
    assert.equal(
      edited.nodes.find((n) => n.id === label.id).text,
      authoredText,
    );

    // Reveal the parent of the selected text in the layer tree and change its real inspector axis.
    const navId = instances[0].id;
    await page.locator(`[data-layer-id="${navId}"] .layer-main`).click();
    const axis = page
      .locator("#right-panel")
      .getByLabel("实例 State", { exact: true });
    assert.equal(await axis.inputValue(), "日常态");
    await axis.selectOption("大促态");
    const switched = await downloadDocument();
    assert.equal(
      switched.nodes.find((n) => n.id === navId).instance.variantId,
      "alternate",
    );
    assert.equal(
      switched.nodes.find((n) => n.id === label.id).text,
      authoredText,
    );

    await page.getByLabel("文件菜单", { exact: true }).click();
    const [zip] = await Promise.all([
      page.waitForEvent("download"),
      button("导出整个文件为 React 项目…").click(),
    ]);
    const zipPath = "output/playwright/agent-canvas-chat-check.zip";
    await zip.saveAs(zipPath);
    const bytes = await readFile(zipPath);
    const files = unzipSync(bytes);
    for (const id of ["tb-nav-search", "tb-empty-state"]) {
      assert.ok(
        Object.keys(files).some(
          (file) =>
            file.startsWith("src/components/" + id + "-") &&
            file.endsWith(".tsx"),
        ),
        id,
      );
    }
    assert.match(strFromU8(files["src/tokens.css"]), /#ff5000/i);
    assert.ok(strFromU8(files["src/tokens.ts"]).includes("tb-radius"));
    const native = JSON.parse(strFromU8(files["design.forma.json"]));
    const exportedNodes =
      native.format === "forma/design-parts"
        ? native.records
            .filter((r) => r.kind === "page")
            .flatMap((r) => r.nodes)
        : native.nodes;
    assert.equal(
      exportedNodes.find((n) => n.id === navId).instance.variantId,
      "alternate",
    );
    assert.equal(
      exportedNodes.find((n) => n.id === label.id).text,
      authoredText,
    );

    async function undo() {
      await canvas.focus();
      await page.keyboard.press(
        process.platform === "darwin" ? "Meta+z" : "Control+z",
      );
    }
    await undo();
    assert.deepEqual((await downloadDocument()).nodes, edited.nodes);
    await undo();
    assert.deepEqual((await downloadDocument()).nodes, applied.nodes);
    await undo();
    const undone = await downloadDocument();
    assert.deepEqual(undone.nodes, beforeApply.nodes);
    assert.deepEqual(undone.libraries, beforeApply.libraries);
    assert.deepEqual(undone.designSystem, beforeApply.designSystem);
    await button("AI 设计助手").click();
    await canvas.focus();
    await page.keyboard.press("Escape");
    const composer = page.getByLabel("设计需求", { exact: true });
    async function askForScope() {
      await button("清空对话历史").click();
      await composer.fill(campaignPrompt);
      await button("生成设计").click();
      await scopeCard.getByText(scopePlan.summary, { exact: true }).waitFor();
    }
    await askForScope();
    await target.selectOption("");
    await scopeCard
      .getByText("目标组件库已切换为「自动 / 不限库」，原范围规划已失效")
      .waitFor();
    const confirm = scopeCard.getByRole("button", { name: "确认并直接生成" });
    assert.ok(await confirm.isDisabled());
    await target.selectOption(libraryId);
    assert.ok(await confirm.isDisabled());
    await askForScope();
    await scopeCard.getByRole("button", { name: "满减" }).click();
    const supplement = "把楼层标题改为开门红";
    await composer.fill(supplement);
    delayedConfirmation = {
      received: Promise.withResolvers(),
      resume: Promise.withResolvers(),
    };
    const [supplementRequest] = await Promise.all([
      page.waitForRequest(
        (r) => new URL(r.url()).pathname === "/api/agent/chat",
      ),
      composer.press(
        process.platform === "darwin" ? "Meta+Enter" : "Control+Enter",
      ),
    ]);
    const supplemented = supplementRequest.postDataJSON();
    assert.ok(supplemented.prompt.includes(supplement));
    assert.equal(
      supplemented.confirmedScope.decisions[0].defaultChoice,
      "满减",
    );
    assert.deepEqual(supplemented.confirmedScope.screens, screens);
    let receiveTimeout;
    try {
      await Promise.race([
        delayedConfirmation.received.promise,
        new Promise((_, reject) => {
          receiveTimeout = setTimeout(
            () => reject(Error("确认后的请求未到达模型")),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(receiveTimeout);
    }
    const reviewedBeforeEdit = campaignScreenshots.length;
    await undo();
    await page
      .getByRole("alert")
      .filter({
        hasText: "生成期间文档已修改，已丢弃过期提案，可重新确认或发送",
      })
      .first()
      .waitFor();
    delayedConfirmation.resume.resolve();
    assert.ok(await confirm.isEnabled());
    assert.equal(await canvas.locator(".is-ai-preview").count(), 0);
    assert.equal(campaignScreenshots.length, reviewedBeforeEdit);
    await canvas.focus();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z",
    );
    await page.getByTestId("design-file-input").setInputFiles({
      name: "淘宝移动端交付.forma.json",
      mimeType: "application/json",
      buffer: Buffer.from(files["design.forma.json"]),
    });
    await node(label.id).getByText(authoredText, { exact: true }).waitFor();
    await saved();
    await page.reload();
    await canvas.waitFor();
    await saved();
    const reopened = await downloadDocument();
    assert.deepEqual(reopened.nodes, switched.nodes);
    assert.deepEqual(reopened.libraries, switched.libraries);
    assert.deepEqual(reopened.designSystem, switched.designSystem);
    assert.deepEqual(errors, []);
    return {
      guideContrast,
      officialGuideAndAnnotationsPreserved: true,
      reviewedArtboards: images.length,
      exportedProject: { path: zipPath, bytes: bytes.length },
      editedInstanceTextAndVariant: true,
      reopenedExportedDesign: true,
      libraryPlaybookEdited: true,
      assetAnnotationsUndoable: true,
      scopeConfirmOneShot: true,
      hybridMultiArtboardVerified: true,
      hybridTokenBindings: bindings,
      startupAgentRequests: 0,
      explicitProvider: true,
      prefixConflict: true,
      metadataSource: "provider-api",
      refreshPreservedOverrides: true,
      importedSkill: true,
      toolCallsPerPrompt: 3,
      activatedSkillsPerPrompt: [2, 1],
      appliedNodes: preview.ids.length,
      singleStepUndo: true,
      htmlFirstCompiled: true,
      htmlFirstLayers: htmlIds.length,
      visualCritiqueVerified: true,
      critiqueCancellationKeptDraft: true,
    };
  } finally {
    critiqueGate.resolve();
    delayedConfirmation?.resume.resolve();
    page.off("request", recordProbe);
    try {
      const cleanupErrors = await page.evaluate(
        async ({ skill, profile, original }) => {
          const errors = [];
          async function clean(path, method, body) {
            try {
              const response = await fetch("/api/agent/" + path, {
                method,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              });
              if (!response.ok)
                errors.push(method + " " + path + " " + response.status);
            } catch (err) {
              errors.push(String(err));
            }
          }
          if (skill)
            await clean("skills/" + encodeURIComponent(skill), "DELETE");
          if (profile) {
            await clean("profiles/" + encodeURIComponent(profile), "DELETE");
            if (original)
              await clean("profiles/" + encodeURIComponent(original), "PATCH", {
                activate: true,
              });
          }
          return errors;
        },
        {
          skill: importedSkillId,
          profile: savedProfileId,
          original: originalActiveId,
        },
      );
      assert.deepEqual(cleanupErrors, [], "Test data cleanup failed");
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  }
};
