async (page) => {
  const { strict: assert } = await import("node:assert");
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

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

  // 1. Default `/` boots into WorkspaceShell with Top Tab Bar (Home active) + 0 agent requests
  await page.locator(".workspace-tabbar").waitFor();
  await page.locator(".workspace-home").waitFor();
  const homeTab = page.getByRole("tab", { name: "返回工作台", exact: true });
  assert.equal(await homeTab.getAttribute("aria-selected"), "true");
  assert.deepEqual(
    startupAgentRequests,
    [],
    "Multi-tab shell startup must make 0 /api/agent/* requests",
  );
  page.off("request", trackStartup);

  const tabCount = () => page.locator('.workspace-tabbar [role="tab"]').count();
  const saved = () =>
    page
      .getByTitle(/^已保存到(此浏览器|本机)$/)
      .first()
      .waitFor();

  // 2. Touchpoint 1 (Workspace Home): Create File A from Home quick-start without page reload
  await page.getByRole("button", { name: /新建移动端设计/ }).click();
  await page.waitForURL(/file=forma\.file\./);
  await page.locator(".editor-canvas").waitFor();
  await page.locator('.design-node[data-node-type="frame"]').first().waitFor();
  const titleInput = page.getByLabel("文件名", { exact: true });
  await titleInput.fill("设计稿 A");
  await titleInput.press("Enter");
  await saved();
  assert.equal(await tabCount(), 2);
  await page
    .locator('.workspace-tabbar [role="tab"]')
    .filter({ hasText: "设计稿 A" })
    .waitFor();

  // 3. Touchpoint 2 (Top Tab Bar `+` button): Create File B into a second open tab
  const fileAUrl = page.url();
  await page
    .getByRole("button", { name: "新建设计标签页", exact: true })
    .click();
  await page.waitForURL(
    (u) => u.href !== fileAUrl && u.searchParams.has("file"),
  );
  await page
    .locator('.workspace-tabbar [role="tab"][aria-selected="true"]')
    .filter({ hasText: "无标题设计" })
    .waitFor();
  await page.locator(".editor-canvas").waitFor();
  await page.getByLabel("文件名", { exact: true }).fill("设计稿 B");
  await page.getByLabel("文件名", { exact: true }).press("Enter");
  await saved();
  assert.equal(await tabCount(), 3);
  const tabA = page
    .locator('.workspace-tabbar [role="tab"]')
    .filter({ hasText: "设计稿 A" });
  const tabB = page
    .locator('.workspace-tabbar [role="tab"]')
    .filter({ hasText: "设计稿 B" });
  assert.equal(await tabB.getAttribute("aria-selected"), "true");

  // Switch back to Tab A without reload and confirm its frame is still there
  await tabA.click();
  assert.equal(await tabA.getAttribute("aria-selected"), "true");
  await page.locator('.design-node[data-node-type="frame"]').first().waitFor();

  // 4. Touchpoint 3 (Top-left Forma menu -> 最近打开 submenu): dedupes & focuses existing Tab B
  await page.getByLabel("文件菜单", { exact: true }).click();
  await page.getByRole("button", { name: "最近打开", exact: true }).click();
  const recentMenu = page.getByRole("menu", { name: "最近打开", exact: true });
  await recentMenu.waitFor();
  await recentMenu.getByRole("menuitem", { name: /设计稿 B/ }).click();
  assert.equal(await tabB.getAttribute("aria-selected"), "true");
  assert.equal(
    await tabCount(),
    3,
    "Opening an already-open file from 最近打开 must focus existing tab, not duplicate",
  );

  // 5. Touchpoint 4 (Built-in sample from File Menu): opens 3rd file/example tab
  await page.getByLabel("文件菜单", { exact: true }).click();
  await page.getByRole("link", { name: /打开 SaaS 产品与营销样例/ }).click();
  await page.waitForURL(/example=aura-showcase/);
  assert.equal(await tabCount(), 4);
  const sampleTab = page
    .locator('.workspace-tabbar [role="tab"]')
    .filter({ hasText: /SaaS|Aura/ });
  assert.equal(await sampleTab.getAttribute("aria-selected"), "true");
  await page.locator(".editor-canvas").waitFor();

  // 6. Keyboard shortcuts: Cmd/Ctrl+1 -> Home (verify "已打开" indicator), Cmd/Ctrl+2 -> Tab A, Ctrl+Tab -> Tab B
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press(`${mod}+Digit1`);
  await page.locator(".workspace-home").waitFor();
  assert.equal(await homeTab.getAttribute("aria-selected"), "true");
  await page.getByText("已打开", { exact: true }).first().waitFor();

  await page.keyboard.press(`${mod}+Digit2`);
  assert.equal(await tabA.getAttribute("aria-selected"), "true");
  await page.keyboard.press("Control+Tab");
  assert.equal(await tabB.getAttribute("aria-selected"), "true");

  // 7. Close tab & Cmd/Ctrl+Shift+T reopen closed tab
  await sampleTab.click();
  await page
    .locator('.workspace-tabbar .wtb-item[data-active="true"] .wtb-close')
    .click();
  assert.equal(await tabCount(), 3);
  await page.locator(".editor-canvas").focus();
  await page.keyboard.press(`${mod}+Shift+KeyT`);
  assert.equal(await tabCount(), 4);

  // 8. Background MCP session keepalive while switching across tabs!
  await tabA.click();
  await page.locator(".editor-canvas").waitFor();
  await page.getByLabel("文件菜单", { exact: true }).click();
  await page
    .getByRole("button", { name: "外部工具集成（MCP）…", exact: true })
    .click();
  const integrations = page.getByRole("dialog", { name: "外部工具集成" });
  await integrations.waitFor();
  await integrations.getByRole("button", { name: "连接外部 Agent" }).click();
  const sessionKey = await integrations.getByLabel("MCP 会话密钥").inputValue();
  assert.ok(sessionKey.length > 8, "Expected valid MCP session key");
  await page.keyboard.press("Escape");
  await integrations.waitFor({ state: "hidden" });
  // Busy pulse dot should appear on Tab A
  await page.locator('.wtb-item:has-text("设计稿 A") .wtb-busy-dot').waitFor();

  // Switch to Tab B and back to Tab A -> MCP session must remain alive with identical key!
  await tabB.click();
  await page.locator(".editor-canvas:visible").waitFor();
  await tabA.click();
  await page.getByLabel("文件菜单", { exact: true }).click();
  await page
    .getByRole("button", { name: "外部工具集成（MCP）…", exact: true })
    .click();
  await integrations.waitFor();
  assert.equal(
    await integrations.getByLabel("MCP 会话密钥").inputValue(),
    sessionKey,
    "MCP pairing session must remain alive across tab switches",
  );
  await integrations.getByRole("button", { name: "关闭会话" }).click();
  await page.keyboard.press("Escape");

  // 9. Reload persistence: all 4 tabs restored cleanly!
  await page.reload();
  await page.locator(".workspace-tabbar").waitFor();
  await page.locator(".editor-canvas").waitFor();
  assert.equal(await tabCount(), 4);
  assert.equal(await tabA.getAttribute("aria-selected"), "true");

  assert.deepEqual(pageErrors, [], "Expected zero runtime page errors");
  return {
    tabCountAfterReload: await tabCount(),
    recentSubmenuDeduped: true,
    shortcutsVerified: true,
    reopenClosedTabVerified: true,
    mcpKeepaliveAcrossTabs: true,
    startupAgentRequests: 0,
  };
};
