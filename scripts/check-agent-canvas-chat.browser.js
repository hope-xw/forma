async (page) => {
  const { strict: assert } = await import("node:assert");
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  // Node's VM default loader resolves relative to the working directory.
  // The runner supplies the repository root even when QA output goes elsewhere.
  const runnerUrl = pathToFileURL(
    path.resolve(
      process.env.FORMA_REPO_ROOT ?? process.cwd(),
      "scripts/run-browser-checks.mjs",
    ),
  );
  const { strFromU8, unzipSync } = createRequire(runnerUrl)("fflate");
  const {
    createMockProvider,
    shoppingLibrary,
    contrastWhenVisible,
    modelId,
    craftId,
    instructions,
    htmlPrompt,
    firstTitle,
    refinedTitle,
    critiqueNote,
    projectName,
    projectPrompt,
    isolationPrompt,
    libraryId,
    libraryName,
    campaignPrompt,
    customNote,
    brand,
    screens,
    scopePlan,
    campaignReviewNote,
    photo,
  } = await import(new URL("./browser-checks/agent/fixtures.mjs", runnerUrl));

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

  const testSkill = "forma-qa-" + crypto.randomUUID();
  const fileA =
    new URL(page.url()).searchParams.get("file") ?? "forma.document.v1";
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

  async function checkGuideContrast() {
    // A second catalog connection publishes r2 while this document still uses r1.
    await page.evaluate(
      (id) =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open("forma-workspace-libraries-v1");
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

  // Spin up a local mock OpenAI-compatible provider server for E2E verification
  const {
    mockServer,
    mockBaseUrl,
    controls,
    receivedRounds,
    projectRounds,
    campaignRounds,
    campaignScreenshots,
    upstreamScreenshots,
  } = await createMockProvider();
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
    assert.equal(
      await page.getByRole("button", { name: "创作设置" }).count(),
      0,
      "Legacy 创作设置 popover button must not exist",
    );
    await page.getByLabel("目标组件库").selectOption(libraryId);
    assert.equal(await page.getByLabel("目标组件库").inputValue(), libraryId);
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
    const reads = controls.modelReads;
    await act("POST", profilePath + "/refresh", () =>
      profile.getByRole("button", { name: "刷新模型" }).click(),
    );
    assert.ok(controls.modelReads > reads);
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
    const turnSkills = page.locator(".agent-turn-skills");
    await turnSkills.locator("summary").click();
    await turnSkills
      .getByRole("checkbox", { name: testSkill, exact: true })
      .check();
    await page
      .getByLabel("本轮已选技能")
      .getByRole("button", { name: "移除本轮技能 " + testSkill })
      .waitFor();

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
      await reply.getByText(/生成过程 · 3 步操作/).click();
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
    const themeSwitch = page.getByRole("button", {
      name: /^切换[浅深]色主题$/,
    });
    for (let appearance = 0; appearance < 2; appearance++) {
      assert.ok(
        await page
          .locator(".agent-composer")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
        "Composer must fit at 1280 × 650",
      );
      assert.ok(
        await page
          .locator(".agent-composer-footer")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
        "Composer footer must fit at 1280 × 650",
      );
      await themeSwitch.click();
    }
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
    assert.equal(htmlChat.generationMode, "auto");
    assert.equal(htmlChat.selection, null);
    await canvas.getByText(firstTitle, { exact: true }).waitFor();
    await bar
      .getByText("正在检查画面效果并做细节优化…", { exact: true })
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

    const revised = await act("POST", "critique", () =>
      controls.critiqueGate.resolve(),
    );
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
    await revisedReply.getByText(/生成过程 · 2 步操作/).click();
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
    controls.critiqueGate = Promise.withResolvers();
    await page.getByLabel("设计需求", { exact: true }).fill(htmlPrompt);
    await Promise.all([critiqueRequest(), button("生成设计").click()]);
    await page
      .locator("#left-panel")
      .getByRole("button", { name: "停止生成", exact: true })
      .click();
    await button("生成设计").waitFor();
    await canvas.getByText(firstTitle, { exact: true }).waitFor();
    await hud.getByRole("button", { name: "丢弃" }).click();
    controls.critiqueGate.resolve();
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
    await page.getByLabel("目标组件库").selectOption(libraryId);
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
        await page
          .locator(".agent-composer")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
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
        projectId: "file:" + fileA,
        fileKey: fileA,
        userId: "local-default",
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
      assert.ok(
        file.suggestedFilename().endsWith(".forma"),
        `Expected .forma native package, got ${file.suggestedFilename()}`,
      );
      const bytes = await readFile(await file.path());
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
        const archive = unzipSync(new Uint8Array(bytes));
        assert.ok(
          archive["manifest.json"],
          ".forma must include manifest.json",
        );
        assert.ok(
          archive["document.json"],
          ".forma must include document.json",
        );
        return JSON.parse(strFromU8(archive["document.json"]));
      }
      return JSON.parse(bytes.toString("utf8"));
    }
    const beforeApply = await downloadDocument();
    await proposal.getByRole("button", { name: "应用到画布" }).click();
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
    await page.getByLabel("文件菜单", { exact: true }).click();
    await page.getByRole("button", { name: /外部工具集成（MCP）/ }).click();
    const integrations = page.getByRole("dialog", { name: "外部工具集成" });
    await integrations.waitFor();
    const manual = integrations.locator(".agent-external-details");
    await manual.locator("summary").first().click();
    await manual.getByLabel("Agent 事务 JSON").fill(
      JSON.stringify({
        baseRevision: applied.revision,
        operations: [{ type: "remove", id: label.id }],
      }),
    );
    await manual.getByRole("button", { name: "校验并预览" }).click();
    await integrations
      .getByRole("alert")
      .filter({ hasText: "组件结构受保护" })
      .waitFor();
    await page.keyboard.press("Escape");
    await integrations.waitFor({ state: "hidden" });
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
    await page.getByLabel("目标组件库").selectOption("");
    await scopeCard
      .getByText("优先组件库已切换为「自动匹配」，原范围规划已失效")
      .waitFor();
    const confirm = scopeCard.getByRole("button", { name: "确认并直接生成" });
    assert.ok(await confirm.isDisabled());
    await page.getByLabel("目标组件库").selectOption(libraryId);
    assert.ok(await confirm.isDisabled());
    await askForScope();
    await scopeCard.getByRole("button", { name: "满减" }).click();
    const supplement = "把楼层标题改为开门红";
    await composer.fill(supplement);
    controls.delayedConfirmation = {
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
        controls.delayedConfirmation.received.promise,
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
    controls.delayedConfirmation.resume.resolve();
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
    // Stage 2. All edits, uploads, project assignments and accepts use editor
    // controls. Read the durable records independently to compare identities.
    async function readMemory(store) {
      return page.evaluate(async (store) => {
        const db = await new Promise((resolve, reject) => {
          const open = indexedDB.open("forma-project-memory-v1");
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        try {
          return await new Promise((resolve, reject) => {
            const read = db.transaction(store).objectStore(store).getAll();
            read.onsuccess = () => resolve(read.result);
            read.onerror = () => reject(read.error);
          });
        } finally {
          db.close();
        }
      }, store);
    }
    const browser = page.getByRole("dialog", { name: "本机文件" });
    const breadcrumb = button("打开本机工作空间文件列表");
    const drawerToggle = button("历史需求档案");
    const drawer = page.getByRole("region", { name: "项目历史需求档案" });
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    const redo = async () => {
      await canvas.focus();
      await page.keyboard.press(mod + "+Shift+z");
    };
    const draftEpisodes = (await readMemory("episodes")).filter(
      (ep) => ep.scopeProjectId === "file:" + fileA,
    );
    const campaign = draftEpisodes.find(
      (ep) =>
        ep.prompt.includes(campaignPrompt) &&
        ep.decisions.some((d) => d.choice === "满减"),
    );
    assert.ok(
      campaign,
      "Stage 1 campaign was archived in the draft's private scope",
    );
    assert.deepEqual(
      campaign.screens.map((s) => s.rootId),
      [home.id, empty.id],
    );
    await page.setViewportSize({ width: 1460, height: 960 });
    await button("AI 设计助手").click();
    await page.getByLabel("切换当前模型").waitFor();
    controls.isolationRoot = home.id;
    await composer.fill(isolationPrompt);
    await button("生成设计").click();
    await proposal.waitFor();

    const offlineRequests = [];
    const trackOffline = (req) => {
      const pathname = new URL(req.url()).pathname;
      if (
        pathname.startsWith("/api/agent/") &&
        !(
          req.method() === "GET" &&
          (pathname === "/api/agent/status" || pathname === "/api/agent/skills")
        )
      )
        offlineRequests.push(req.method() + " " + pathname);
    };
    page.on("request", trackOffline);
    await breadcrumb.click();
    await browser.getByRole("button", { name: "新建项目空间" }).click();
    await browser.getByLabel("项目名称").fill(projectName);
    await browser.getByRole("button", { name: "创建", exact: true }).click();
    const banner = browser.locator(".project-banner");
    await banner.getByText(projectName, { exact: true }).waitFor();
    await browser
      .getByRole("button", { name: "全部文件", exact: true })
      .click();
    const assignment = browser.locator(`[data-file-key="${fileA}"] select`);
    const firstMigrationNotice = await assignment.evaluateHandle(
      (select, name) => {
        const dialog = select.closest('[role="dialog"]');
        const state = {};
        const observer = new MutationObserver(() => {
          if (
            !dialog
              .querySelector(".file-browser-notice")
              ?.textContent.includes("同步迁移")
          )
            return;
          state.projectId = select.value;
          state.count = dialog.querySelector(
            `.project-nav-item[aria-label="${CSS.escape(name)}"] .project-memory-count`,
          )?.textContent;
          observer.disconnect();
        });
        observer.observe(dialog, {
          subtree: true,
          childList: true,
          characterData: true,
        });
        return state;
      },
      projectName,
    );
    const [projectId] = await assignment.selectOption({ label: projectName });
    assert.ok(projectId);
    await browser.getByText(/同步迁移.*条历史需求档案/).waitFor();
    assert.deepEqual(await firstMigrationNotice.jsonValue(), {
      projectId,
      count: `${draftEpisodes.length} 条记忆`,
    });
    await firstMigrationNotice.dispose();
    assert.equal(await assignment.inputValue(), projectId);
    const projectScope = "proj:" + projectId;
    await button("关闭本机文件").click();
    await breadcrumb.filter({ hasText: projectName }).waitFor();
    await proposal.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".agent-msg-user").count(), 0);
    assert.deepEqual((await downloadDocument()).nodes, reopened.nodes);
    await drawerToggle.click();
    const campaignCard = drawer.getByRole("article", {
      name: campaign.title,
      exact: true,
    });
    await campaignCard.getByText("当前稿", { exact: true }).waitFor();
    const details = campaignCard.locator("details");
    await details.locator("summary").focus();
    await page.keyboard.press("Enter");
    assert.ok(await details.evaluate((d) => d.open));
    for (const text of [
      campaign.summary,
      campaign.prompt,
      "主推促销类型 → 满减",
    ])
      assert.ok((await details.textContent()).includes(text), text);
    const memorySearch = drawer.getByLabel("搜索历史需求档案");
    await memorySearch.fill("主推促销类型");
    await campaignCard.waitFor();
    await memorySearch.fill("不存在的决策文字");
    assert.equal(await drawer.getByRole("article").count(), 0);
    await memorySearch.fill("");
    await campaignCard
      .getByRole("button", { name: "置顶", exact: true })
      .click();
    await campaignCard
      .getByRole("button", { name: "取消置顶", pressed: true })
      .waitFor();
    const migrated = (await readMemory("episodes")).filter(
      (ep) => ep.scopeProjectId === projectScope,
    );
    assert.deepEqual(
      migrated.map((ep) => ep.id).sort(),
      draftEpisodes.map((ep) => ep.id).sort(),
    );
    assert.equal(
      (await readMemory("episodes")).filter(
        (ep) => ep.scopeProjectId === "file:" + fileA,
      ).length,
      0,
    );

    await button("图层").click();
    const layer = (id) => page.locator(`[data-layer-id="${id}"] .layer-main`);
    assert.ok(
      reopened.nodes.some(
        (n) =>
          !n.parentId &&
          n.type === "frame" &&
          ![home.id, empty.id].includes(n.id),
      ),
      "A third artboard makes over-sharing observable",
    );
    await layer(home.id).click();
    await layer(empty.id).click({ modifiers: [mod] });
    await button("AI 设计助手").click();
    await drawer.getByRole("button", { name: "归档当前画板" }).click();
    await drawer.getByText(/已归档/).waitFor();
    const manualArchive = (await readMemory("episodes")).filter(
      (ep) =>
        ep.scopeProjectId === projectScope &&
        !draftEpisodes.some((d) => d.id === ep.id),
    );
    assert.equal(manualArchive.length, 1);
    assert.deepEqual(
      manualArchive[0].screens.map((s) => s.rootId).sort(),
      [home.id, empty.id].sort(),
    );

    await button("图层").click();
    // Expand exactly the ancestors of the Stage 1 custom module.
    const ancestors = [];
    for (let n = promo; n.parentId;) {
      n = reopened.nodes.find((node) => node.id === n.parentId);
      ancestors.unshift(n);
    }
    for (const n of ancestors) {
      const expand = page
        .locator(`[data-layer-id="${n.id}"]`)
        .getByRole("button", { name: "展开 " + n.name, exact: true });
      if (await expand.count()) await expand.click();
    }
    await layer(promo.id).click();
    await button("资源").click();
    await button("沉淀选区到组件库").click();
    const promote = page.getByRole("dialog", { name: "沉淀为组件库模块" });
    await promote
      .getByLabel("目标组件库")
      .selectOption("__new_project_library__");
    await promote.getByLabel("组件名称", { exact: true }).fill("尖货促销楼层");
    await promote.getByLabel("资产层级").selectOption("block");
    await promote.getByLabel(/自动增量刷新/).check();
    await promote.getByLabel(/同时将画布选区替换/).check();
    await promote.getByLabel("设为当前项目默认组件库").check();
    // Fail only the next workspace write, leaving the real IDB and document intact.
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        if (
          this.name === "forma-workspace-libraries-v1" &&
          args[1] === "readwrite"
        ) {
          IDBDatabase.prototype.transaction = original;
          throw new DOMException("存储空间不足", "QuotaExceededError");
        }
        return original.apply(this, args);
      };
    });
    await promote.getByRole("button", { name: "沉淀到组件库" }).click();
    await promote
      .getByRole("alert")
      .filter({ hasText: "存储空间不足" })
      .waitFor();
    assert.equal(
      (await readMemory("projects")).find((p) => p.id === projectId)
        .defaultLibraryId,
      undefined,
    );
    await promote.getByRole("button", { name: "沉淀到组件库" }).click();
    await promote.waitFor({ state: "hidden" });
    await page
      .locator(".project-status-toast")
      .filter({ hasText: "AI 说明书已更新" })
      .waitFor();
    const promoted = await downloadDocument();
    assert.equal(promoted.revision, reopened.revision + 1);
    const defaultId = (await readMemory("projects")).find(
      (p) => p.id === projectId,
    ).defaultLibraryId;
    const library = promoted.libraries[defaultId];
    assert.match(defaultId, /^proj-lib-/);
    assert.ok(library.aiGuide.playbookMarkdown.includes("尖货促销楼层"));
    assert.equal(library.components.length, 1);
    const component = library.components[0];
    assert.deepEqual(promoted.nodes.find((n) => n.id === promo.id).instance, {
      libraryId: defaultId,
      componentId: component.id,
      variantId: component.variants[0].id,
    });
    await undo();
    const unpromoted = await downloadDocument();
    assert.deepEqual(unpromoted.nodes, reopened.nodes);
    assert.deepEqual(unpromoted.libraries, reopened.libraries);
    await redo();
    assert.deepEqual((await downloadDocument()).nodes, promoted.nodes);
    await saved();

    await breadcrumb.click();
    await browser
      .getByRole("button", { name: projectName, exact: true })
      .click();
    await Promise.all([
      page.waitForURL(
        (url) =>
          !!url.searchParams.get("file") &&
          url.searchParams.get("file") !== fileA,
      ),
      banner.getByRole("button", { name: "在此项目中新建" }).click(),
    ]);
    await canvas.waitFor();
    const fileB = new URL(page.url()).searchParams.get("file");
    await breadcrumb.filter({ hasText: projectName }).waitFor();
    await button("AI 设计助手").click();
    await page
      .getByText("项目记忆 · " + projectName, { exact: true })
      .waitFor();
    await drawerToggle.click();
    await campaignCard
      .getByText("跨稿 · " + campaign.sourceFileName, { exact: true })
      .waitFor();
    await drawerToggle.click();
    assert.ok(!(await downloadDocument()).libraries?.[defaultId]);
    await button("载入项目默认库").click();
    await page
      .locator(".project-status-toast")
      .filter({ hasText: library.name })
      .waitFor();
    const installed = (await downloadDocument()).libraries[defaultId];
    assert.equal(installed.components[0].id, component.id);
    assert.equal(
      installed.aiGuide.playbookMarkdown,
      library.aiGuide.playbookMarkdown,
    );
    assert.equal(await page.getByLabel("目标组件库").inputValue(), defaultId);
    await button("引用组件、变量、样式、画板或历史需求").click();
    const picker = page.getByRole("dialog", { name: "引用设计元素" });
    await picker.getByRole("tab", { name: "历史需求" }).click();
    const combo = picker.getByRole("combobox");
    await combo.fill(campaign.title);
    const option = picker.getByRole("option", { selected: true });
    await option.filter({ hasText: campaign.title }).waitFor();
    assert.equal(
      await combo.getAttribute("aria-controls"),
      await picker.getByRole("listbox").getAttribute("id"),
    );
    assert.equal(
      await combo.getAttribute("aria-activedescendant"),
      await option.getAttribute("id"),
    );
    await combo.press("Enter");
    await page
      .locator(".agent-composer")
      .getByRole("button", { name: "移除引用 " + campaign.title, exact: true })
      .waitFor();
    page.off("request", trackOffline);
    assert.deepEqual(offlineRequests, []);
    controls.projectFixture = {
      episodeId: campaign.id,
      libraryId: defaultId,
      componentId: component.id,
      variantId: component.variants[0].id,
    };
    await page.getByLabel("切换当前模型").waitFor();
    const projectChatRequests = [];
    const onProjectChat = (r) => {
      if (new URL(r.url()).pathname === "/api/agent/chat")
        projectChatRequests.push(r.postDataJSON());
    };
    page.on("request", onProjectChat);
    const projectArchives = async () =>
      (await readMemory("episodes")).filter(
        (ep) => ep.scopeProjectId === projectScope,
      );
    const initialCount = (await projectArchives()).length;
    const rootIds = [];
    async function acceptInstance(prompt, fromCanvas) {
      const before = await downloadDocument();
      if (fromCanvas) {
        await canvas.focus();
        await page.keyboard.press("Escape");
        await page.keyboard.press(mod + "+Enter");
        await sendCanvasPrompt(prompt);
      } else {
        await composer.fill(prompt);
        await button("生成设计").click();
      }
      await proposal.waitFor();
      const preview = canvas
        .locator(".is-ai-preview[data-node-type=frame]")
        .first();
      await preview.waitFor();
      const previewId = await preview.getAttribute("data-node-id");
      if (fromCanvas)
        await hud.getByRole("button", { name: "采纳到画布" }).click();
      else await proposal.getByRole("button", { name: "应用到画布" }).click();
      await proposal.waitFor({ state: "hidden" });
      await page
        .locator(".agent-undo-bar")
        .getByText("已应用并存入设计记忆", { exact: true })
        .waitFor();
      await replies.last().getByText("已应用", { exact: true }).waitFor();
      const after = await downloadDocument();
      const root = after.nodes.find(
        (n) => !n.parentId && !before.nodes.some((old) => old.id === n.id),
      );
      assert.ok(root);
      assert.notEqual(
        root.id,
        previewId,
        "insertComponent generated a fresh ID at commit",
      );
      assert.deepEqual(root.instance, {
        libraryId: defaultId,
        componentId: component.id,
        variantId: component.variants[0].id,
      });
      const archive = (await projectArchives()).find(
        (ep) => ep.sourceFileKey === fileB && ep.prompt === prompt,
      );
      assert.deepEqual(
        archive.screens.map((s) => s.rootId),
        [root.id],
      );
      assert.deepEqual(archive.screens[0].componentIds, [component.id]);
      assert.deepEqual(
        archive.componentsUsed.map(
          ({ libraryId, componentId, variantId, count }) => ({
            libraryId,
            componentId,
            variantId,
            count,
          }),
        ),
        [{ ...root.instance, count: 1 }],
      );
      rootIds.push(root.id);
    }
    await acceptInstance(projectPrompt + " · 面板", false);
    const expectedScope = {
      projectId: projectScope,
      projectName,
      fileKey: fileB,
      libraryId: defaultId,
      userId: "local-default",
    };
    assert.deepEqual(projectChatRequests[0].memoryScope, expectedScope);
    assert.deepEqual(
      projectChatRequests[0].mentions.map((m) => m.id),
      [campaign.id],
    );
    assert.ok(
      projectChatRequests[0].recalledEpisodes.some(
        (ep) =>
          ep.id === campaign.id && ep.explicitlyMentioned && !ep.isCurrentFile,
      ),
    );
    assert.equal(projectRounds.length, 4);
    for (const round of projectRounds) {
      assert.deepEqual(round.ctx.memoryScope, expectedScope);
      assert.ok(
        round.ctx.recalledEpisodes.some(
          (ep) => ep.id === campaign.id && ep.explicitlyMentioned,
        ),
      );
      for (const value of [
        campaign.id,
        campaignPrompt,
        campaign.decisions[0].question,
      ])
        assert.ok(
          !round.system.includes(value),
          "Archive data appeared in system message: " + value,
        );
    }
    assert.ok(
      projectRounds[0].tools.includes("search_project_episodes") &&
        projectRounds[0].tools.includes("get_episode_details"),
    );
    assert.ok(
      projectRounds[1].result.episodes.some((ep) => ep.id === campaign.id),
    );
    assert.deepEqual(projectRounds[2].result.decisions, campaign.decisions);
    assert.equal(projectRounds[2].result.prompt, campaign.prompt);
    await undo();
    assert.ok(
      !(await downloadDocument()).nodes.some((n) => n.id === rootIds[0]),
    );
    assert.equal((await projectArchives()).length, initialCount + 1);
    await redo();
    await acceptInstance(projectPrompt + " · 画布", true);
    await sendCanvasPrompt(projectPrompt + " · 丢弃");
    await hud.getByRole("button", { name: "丢弃" }).click();
    await hud.waitFor({ state: "hidden" });
    assert.equal((await projectArchives()).length, initialCount + 2);
    assert.equal(projectChatRequests.length, 3);
    const fileBSnapshot = await downloadDocument();
    await saved();
    await page.reload();
    await canvas.waitFor();
    await breadcrumb.filter({ hasText: projectName }).waitFor();
    const durable = await downloadDocument();
    assert.deepEqual(durable.nodes, fileBSnapshot.nodes);
    assert.equal(
      durable.libraries[defaultId].aiGuide.playbookMarkdown,
      library.aiGuide.playbookMarkdown,
    );
    const persisted = await projectArchives();
    assert.deepEqual(
      persisted
        .filter((ep) => ep.sourceFileKey === fileB)
        .flatMap((ep) => ep.screens.map((s) => s.rootId))
        .sort(),
      [...rootIds].sort(),
    );
    assert.ok(persisted.some((ep) => ep.id === campaign.id && ep.pinned));

    // A Canvas prompt sent on a named page is consumed once, even after switching back.
    await button("图层").click();
    await button("新建页面").click();
    const pages = page.locator(".file-page .page-name");
    const originalPage = pages.first();
    await button("AI 设计助手").click();
    await page.getByLabel("切换当前模型").waitFor();
    await canvas.focus();
    await page.keyboard.press(mod + "+Enter");
    await sendCanvasPrompt(projectPrompt + " · 页面切换");
    await button("图层").click();
    await originalPage.click();
    await hud.waitFor({ state: "hidden" });
    await saved();
    assert.equal(projectChatRequests.length, 4);
    assert.equal((await projectArchives()).length, initialCount + 2);
    page.off("request", onProjectChat);
    // A document-only library must be installable from a project-bound native import.
    await layer(rootIds[0]).click();
    await button("资源").click();
    await button("保存选区").click();
    const withLocalLibrary = await downloadDocument();
    const localLibrary = Object.values(withLocalLibrary.libraries).find(
      (lib) => !durable.libraries[lib.id],
    );
    assert.ok(localLibrary);
    await saved();
    await breadcrumb.click();
    const fileRow = browser.locator(`[data-file-key="${fileB}"]`);
    await fileRow.getByRole("button", { name: /^重命名 / }).click();
    await browser.getByLabel("重命名文件", { exact: true }).press("Escape");
    await page.waitForFunction(
      (key) =>
        document.activeElement?.matches(
          `[data-file-key="${CSS.escape(key)}"] a[href]`,
        ),
      fileB,
    );
    await browser
      .getByRole("button", { name: "重命名项目 " + projectName, exact: true })
      .click();
    await browser.getByLabel("项目名称").press("Escape");
    await page.waitForFunction(
      (label) => document.activeElement?.getAttribute("aria-label") === label,
      "重命名项目 " + projectName,
    );
    await browser.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("Tab");
    assert.ok(
      await button("关闭本机文件").evaluate(
        (b) => b === document.activeElement,
      ),
    );
    const importProject = "淘宝外部原稿";
    await browser.getByRole("button", { name: "新建项目空间" }).click();
    await browser.getByLabel("项目名称").fill(importProject);
    await browser
      .getByLabel("默认组件库", { exact: true })
      .selectOption(localLibrary.id);
    await browser.getByRole("button", { name: "创建", exact: true }).click();
    await banner.getByText(importProject, { exact: true }).waitFor();
    assert.equal(
      await banner.getByLabel("项目默认组件库").inputValue(),
      localLibrary.id,
    );
    await browser
      .getByTestId("browser-design-file-input")
      .setInputFiles(
        path.resolve(
          process.env.FORMA_REPO_ROOT || process.cwd(),
          "docs/evidence/2026-11-22/design-import/shared-paint.fig",
        ),
      );
    const importDialog = page.getByRole("dialog", { name: "设计文件导入报告" });
    await Promise.all([
      page.waitForURL(
        (url) =>
          !!url.searchParams.get("file") &&
          url.searchParams.get("file") !== fileB,
      ),
      importDialog.getByRole("button", { name: "导入为新文件" }).click(),
    ]);
    await breadcrumb.filter({ hasText: importProject }).waitFor();
    await button("AI 设计助手").click();
    await button("载入项目默认库").click();
    await page
      .locator(".project-status-toast")
      .filter({ hasText: localLibrary.name })
      .waitFor();
    const importedDocument = await downloadDocument();
    assert.equal(importedDocument.importReport.format, "Figma");
    assert.equal(
      importedDocument.libraries[localLibrary.id].components[0].id,
      localLibrary.components[0].id,
    );
    assert.deepEqual(errors, []);
    return {
      projectMemory: {
        migratedEpisodes: migrated.length,
        selectedBoardsArchived: 2,
        durableCommittedRoots: rootIds.length,
        promotionRetriedAfterQuotaError: true,
        crossFileTools: ["search_project_episodes", "get_episode_details"],
      },
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
    controls.critiqueGate.resolve();
    controls.delayedConfirmation?.resume.resolve();
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
            else localStorage.removeItem("forma.agent.configured-hint");
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
