async (page) => {
  const { strict: assert } = await import("node:assert");
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const runnerUrl = pathToFileURL(
    path.resolve(
      process.env.FORMA_REPO_ROOT ?? process.cwd(),
      "scripts/run-browser-checks.mjs",
    ),
  );
  const { strFromU8, unzipSync } = createRequire(runnerUrl)("fflate");

  const startupAgentRequests = [];
  const trackStartup = (req) => {
    try {
      if (new URL(req.url()).pathname.startsWith("/api/agent/"))
        startupAgentRequests.push(req.url());
    } catch {
      /* ignore */
    }
  };
  page.on("request", trackStartup);

  // 1. Default `/` boots directly into Fullscreen Workspace Home (not untitled canvas!)
  await page.locator(".workspace-home").waitFor();
  assert.equal(await page.locator(".editor-canvas").count(), 0);
  await page.getByRole("button", { name: "新建设计", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "导入设计文件", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /新建移动端设计/ }).waitFor();
  assert.deepEqual(
    startupAgentRequests,
    [],
    "Clean WorkspaceHome launch must make 0 /api/agent/* requests",
  );
  page.off("request", trackStartup);

  // 2. Create a Project Space and create a new design directly inside it via strong primary CTA
  const projectName = "旗舰改版项目";
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill(projectName);
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await page.getByRole("heading", { name: projectName, exact: true }).waitFor();

  await Promise.all([
    page.waitForURL(/file=forma\.file\./),
    page.getByRole("button", { name: /新建移动端设计/ }).click(),
  ]);
  await page.locator(".editor-canvas").waitFor();
  // Mobile preset should automatically create iPhone 16 frame and dismiss welcome overlay
  await page.locator('.design-node[data-node-type="frame"]').first().waitFor();
  await page
    .getByRole("button", { name: "打开本机工作空间文件列表", exact: true })
    .filter({ hasText: projectName })
    .waitFor();
  const titleInput = page.getByLabel("文件名", { exact: true });
  await titleInput.fill("首页视觉稿");
  await titleInput.press("Enter");
  await page.getByTitle(/^已保存到(此浏览器|本机)$/).waitFor();

  // 3. Save native .forma ZIP container and verify internal structure
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "设计文件", exact: true }).click(),
  ]);
  assert.ok(
    download.suggestedFilename().endsWith(".forma"),
    `Expected .forma filename, got: ${download.suggestedFilename()}`,
  );
  const pkgBytes = new Uint8Array(await readFile(await download.path()));
  assert.equal(pkgBytes[0], 0x50);
  assert.equal(pkgBytes[1], 0x4b);
  const unzipped = unzipSync(pkgBytes);
  const manifest = JSON.parse(strFromU8(unzipped["manifest.json"]));
  assert.equal(manifest.format, "forma/package");
  assert.equal(manifest.packageVersion, 1);
  assert.equal(manifest.name, "首页视觉稿");
  assert.ok(unzipped["document.json"], "document.json missing in .forma");
  assert.ok(unzipped["preview.svg"], "preview.svg missing in .forma");

  // 4. Return to Workspace Home via permanent Home tab and verify thumbnail & project listing
  await Promise.all([
    page.waitForURL((u) => !u.searchParams.has("file")),
    page.getByRole("tab", { name: "返回工作台", exact: true }).click(),
  ]);
  await page.locator(".workspace-home").waitFor();
  await page.getByText("首页视觉稿", { exact: true }).first().waitFor();

  // 5. Verify Bug #4 fix: configured model hint auto-hydrates on a brand-new file!
  const mockStatus = {
    configured: true,
    activeProfileId: "prof-demo",
    activeProfile: {
      id: "prof-demo",
      providerId: "deepseek",
      providerName: "DeepSeek",
      label: "DeepSeek",
      maskedKey: "sk-****demo",
      baseUrl: "https://api.deepseek.com/v1",
      protocol: "openai-chat",
      selectedModel: "deepseek-chat",
      models: [
        {
          id: "deepseek-chat",
          label: "DeepSeek Chat",
          capabilities: {
            protocol: "openai-chat",
            structuredOutput: "json_object",
            supportsTools: true,
            supportsVision: true,
            supportsStreaming: true,
            isReasoning: false,
            maxContextTokens: 128000,
            maxOutputTokens: 8192,
            temperatureMode: "normal",
            tokenLimitParam: "max_tokens",
          },
        },
      ],
      capabilities: {
        protocol: "openai-chat",
        structuredOutput: "json_object",
        supportsTools: true,
        supportsVision: true,
        supportsStreaming: true,
        isReasoning: false,
        maxContextTokens: 128000,
        maxOutputTokens: 8192,
        temperatureMode: "normal",
        tokenLimitParam: "max_tokens",
      },
      source: "saved",
      updatedAt: new Date().toISOString(),
    },
    profiles: [],
  };
  await page.route("**/api/agent/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockStatus),
    }),
  );
  await page.route("**/api/agent/skills", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ skills: [] }),
    }),
  );
  await page.evaluate(() => {
    localStorage.setItem("forma.agent.configured-hint", "1");
  });

  // Create ANOTHER brand-new file from Home -> must auto-hydrate connected model immediately!
  await Promise.all([
    page.waitForURL(/file=forma\.file\./),
    page.getByRole("button", { name: "新建设计", exact: true }).click(),
  ]);
  await page.locator(".editor-canvas").waitFor();
  await page.getByRole("button", { name: "AI 设计助手", exact: true }).click();
  // Model selector must appear automatically (NO "未连接模型"!)
  await page.getByLabel("切换当前模型", { exact: true }).waitFor();
  assert.equal(await page.getByText("未连接模型", { exact: true }).count(), 0);
  // Bloated "创作设置" & "生成引擎模式" must be completely gone; inline library pill directly visible
  assert.equal(
    await page.getByRole("button", { name: "创作设置", exact: true }).count(),
    0,
  );
  assert.equal(await page.getByLabel("生成引擎模式").count(), 0);
  await page.getByLabel("目标组件库", { exact: true }).waitFor();

  // 6. Verify dedicated MCP Integrations modal accessible from File Menu
  await page.getByLabel("文件菜单", { exact: true }).click();
  await page
    .getByRole("button", { name: "外部工具集成（MCP）…", exact: true })
    .click();
  const integrations = page.getByRole("dialog", {
    name: "外部工具集成",
    exact: true,
  });
  await integrations.waitFor();
  await integrations.getByRole("button", { name: "连接外部 Agent" }).waitFor();
  await page.keyboard.press("Escape");
  await integrations.waitFor({ state: "hidden" });

  return {
    homeBoot: true,
    startupAgentRequests: 0,
    formaPackageBytes: pkgBytes.byteLength,
    formaFormat: manifest.format,
    hasPreviewSvg: true,
    autoHydratedAcrossNewFile: true,
    composerSettingsRemoved: true,
    integrationsModalReady: true,
  };
};
