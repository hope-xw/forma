async (page) => {
  const baseUrl = new URL(page.url()).origin;
  const startupAgentRequests = [];
  const onRequest = (req) => {
    if (req.url().includes("/api/agent/")) startupAgentRequests.push(req.url());
  };
  page.on("request", onRequest);

  // Confirm clean editor boot with zero /api/agent/* network requests
  const board = page.locator(".design-node[data-node-type=frame]").first();
  await board.waitFor();
  const boardId = await board.getAttribute("data-node-id");
  await page.waitForTimeout(300);
  page.off("request", onRequest);
  if (startupAgentRequests.length > 0) {
    throw Error(
      "Unexpected startup /api/agent/* requests: " +
        JSON.stringify(startupAgentRequests),
    );
  }

  const openIntegrations = async () => {
    await page.getByLabel("文件菜单", { exact: true }).click();
    await page
      .getByRole("button", { name: "外部工具集成（MCP）…", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "外部工具集成",
      exact: true,
    });
    await dialog.waitFor();
    return dialog;
  };

  // 1. Activate zero-config persistent local MCP + A2A service
  const dialog = await openIntegrations();
  await dialog.getByRole("button", { name: "连接外部 Agent" }).click();
  const token = await dialog.getByLabel("MCP 会话密钥").inputValue();
  if (!token) throw Error("Missing MCP/A2A session token");

  // Verify zero-config client tabs & real endpoint URLs (no npm run mcp required)
  const claudeCode = await dialog.locator(".bridge-code").innerText();
  if (!claudeCode.includes(`${baseUrl}/mcp`) || !claudeCode.includes(token)) {
    throw Error(
      "Claude Code config snippet missing live MCP HTTP URL or token",
    );
  }
  await dialog.getByRole("tab", { name: "Cursor", exact: true }).click();
  await dialog.getByRole("tab", { name: "Codex", exact: true }).click();
  await dialog.getByRole("tab", { name: "A2A", exact: true }).click();
  const a2aSnippet = await dialog.locator(".bridge-code").innerText();
  if (!a2aSnippet.includes("/.well-known/agent-card.json")) {
    throw Error("A2A config snippet missing agent-card URL");
  }

  // Wait for first PUT /sync to settle so server has live tabs + state
  await page.waitForTimeout(400);

  // Helper to parse JSON or SSE response from Streamable HTTP MCP
  const mcpRpc = async (method, params = {}, expectErrorStatus = null) => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Forma-Client": "Playwright MCP QA",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1e6),
        method,
        params,
      }),
    });
    if (expectErrorStatus !== null) {
      if (res.status !== expectErrorStatus) {
        throw Error(`Expected status ${expectErrorStatus}, got ${res.status}`);
      }
      return null;
    }
    if (!res.ok) {
      throw Error(
        `MCP HTTP ${method} failed (${res.status}): ${await res.text()}`,
      );
    }
    const ct = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    let msg;
    if (ct.includes("text/event-stream")) {
      const dataLine = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter(Boolean)
        .at(-1);
      msg = JSON.parse(dataLine);
    } else {
      msg = JSON.parse(raw);
    }
    if (msg.error)
      throw Error("MCP JSON-RPC error: " + JSON.stringify(msg.error));
    return msg.result;
  };

  // 2. Verify unauthorized MCP request is rejected with 401
  const unauthRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  if (unauthRes.status !== 401) {
    throw Error(`Expected 401 without Bearer token, got ${unauthRes.status}`);
  }

  // 3. Real MCP Streamable HTTP handshake & all 11 tools
  await mcpRpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "forma-e2e-mcp", version: "1.0.0" },
  });
  const listed = await mcpRpc("tools/list", {});
  const toolNames = listed.tools.map((t) => t.name).sort();
  if (toolNames.length !== 11) {
    throw Error(
      `Expected 11 MCP tools, got ${toolNames.length}: ${toolNames.join(",")}`,
    );
  }

  const callTool = async (name, args = {}) => {
    const result = await mcpRpc("tools/call", { name, arguments: args });
    if (result.isError) {
      return { isError: true, text: result.content?.[0]?.text ?? "" };
    }
    return { isError: false, data: JSON.parse(result.content[0].text) };
  };

  const tabsRes = await callTool("list_open_tabs");
  if (tabsRes.isError || !Array.isArray(tabsRes.data.tabs)) {
    throw Error("list_open_tabs failed: " + JSON.stringify(tabsRes));
  }
  const previewRes = await callTool("render_artboard_preview", {
    nodeId: boardId,
    scale: 1,
  });
  if (
    previewRes.isError ||
    !previewRes.data.svg?.includes("<svg") ||
    previewRes.data.nodeId !== boardId
  ) {
    throw Error("render_artboard_preview failed");
  }
  const reactRes = await callTool("export_react_code", {
    nodeId: boardId,
    includeTokens: true,
    includeComponents: true,
  });
  if (
    reactRes.isError ||
    !reactRes.data.files?.["src/DesignPage.tsx"] ||
    !reactRes.data.files?.["src/tokens.css"]
  ) {
    throw Error("export_react_code failed");
  }

  // Verify live connected client badge renders inside IntegrationsModal
  await dialog.getByText(/Playwright MCP QA/).waitFor();

  // 4. Verify Read-Only permission blocks writes cleanly
  const writeToggle = dialog.getByLabel("允许写入画布");
  await writeToggle.uncheck();
  await page.waitForTimeout(500);
  const scopeRead = await callTool("read_design");
  const blockedWrite = await callTool("propose_design", {
    baseRevision: scopeRead.data.revision,
    operations: [{ type: "update", id: boardId, patch: { name: "Blocked" } }],
  });
  if (!blockedWrite.isError || !blockedWrite.text.includes("只读")) {
    throw Error("Read-only mode did not block propose_design");
  }
  await writeToggle.check();
  await page.waitForTimeout(500);

  // Close Integrations modal
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  // 5. Standard A2A Discovery & Offline Skills
  const cardRes = await fetch(`${baseUrl}/.well-known/agent-card.json`);
  if (!cardRes.ok) throw Error("Agent card discovery failed");
  const card = await cardRes.json();
  const skillIds = card.skills.map((s) => s.id).sort();
  if (
    JSON.stringify(skillIds) !==
    JSON.stringify([
      "audit_design_system",
      "design_to_react",
      "generate_ui",
      "refine_artboard",
    ])
  ) {
    throw Error(
      "Unexpected A2A Agent Card skills: " + JSON.stringify(skillIds),
    );
  }

  const a2aRpc = async (method, params) => {
    const res = await fetch(`${baseUrl}/api/a2a`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-A2A-Client": "Playwright A2A Orchestrator",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1e6),
        method,
        params,
      }),
    });
    if (!res.ok)
      throw Error(`A2A HTTP error ${res.status}: ${await res.text()}`);
    const payload = await res.json();
    if (payload.error)
      throw Error("A2A RPC error: " + JSON.stringify(payload.error));
    return payload.result;
  };

  // Offline audit_design_system
  const auditTask = await a2aRpc("message/send", {
    message: {
      messageId: "msg-audit-1",
      role: "user",
      parts: [{ kind: "text", text: "请审校当前画布规范与对比度" }],
    },
    metadata: { skill: "audit_design_system" },
  });
  if (
    auditTask.status.state !== "completed" ||
    auditTask.artifacts.length < 1
  ) {
    throw Error("Offline A2A audit_design_system did not complete");
  }

  // Offline design_to_react
  const exportTask = await a2aRpc("message/send", {
    message: {
      messageId: "msg-export-1",
      role: "user",
      parts: [
        { kind: "text", text: "导出选中画板 React 代码" },
        { kind: "data", data: { nodeId: boardId } },
      ],
    },
    metadata: { skill: "design_to_react" },
  });
  if (
    exportTask.status.state !== "completed" ||
    !exportTask.artifacts.some((a) => a.name === "react-project-files")
  ) {
    throw Error(
      "Offline A2A design_to_react missing react-project-files artifact",
    );
  }

  // 6. Human-in-the-Loop A2A task (review -> canvas apply -> designer manual tweak -> confirm & deliver)
  const latestScope = await callTool("read_design");
  const hitlTask = await a2aRpc("message/send", {
    message: {
      messageId: "msg-hitl-1",
      role: "user",
      parts: [
        { kind: "text", text: "精修主画板标题并交给设计师审核" },
        {
          kind: "data",
          data: {
            skill: "refine_artboard",
            transaction: {
              baseRevision: latestScope.data.revision,
              operations: [
                {
                  type: "update",
                  id: boardId,
                  patch: { name: "A2A 协作初稿" },
                },
              ],
            },
          },
        },
      ],
    },
  });
  if (hitlTask.status.state !== "input-required") {
    throw Error(`Expected HITL input-required, got ${hitlTask.status.state}`);
  }

  // Header Agent Inbox button appears with pending count badge
  const inboxBtn = page.getByRole("button", {
    name: "外部 Agent 任务",
    exact: true,
  });
  await inboxBtn.waitFor();
  await inboxBtn.locator(".header-inbox-badge").waitFor();

  // Apply canvas proposal first (floating HUD pill uses "采纳到画布", sidebar uses "应用到画布")
  const applyBtn = page
    .getByRole("button", { name: /采纳到画布|应用到画布/ })
    .first();
  await applyBtn.waitFor();
  await applyBtn.click();
  await applyBtn.waitFor({ state: "hidden" });

  // Designer manually edits layer name in layers panel before delivering back!
  const layerRow = page.locator(`[data-layer-id="${boardId}"] .layer-main`);
  await layerRow.waitFor();
  await layerRow.dblclick();
  const renameInput = page.locator(`[data-layer-id="${boardId}"] input`);
  await renameInput.waitFor();
  await renameInput.fill("设计师精修定稿");
  await renameInput.press("Enter");
  await page
    .locator(`[data-layer-id="${boardId}"]`)
    .getByText("设计师精修定稿")
    .waitFor();

  // Open Agent Inbox & click "确认并回传产物"
  await inboxBtn.click();
  const inboxDialog = page.getByRole("dialog", {
    name: "外部 Agent 任务收件箱",
    exact: true,
  });
  await inboxDialog.waitFor();
  await inboxDialog.getByRole("button", { name: "确认并回传产物" }).click();
  await inboxDialog.getByText("已回传交付").first().waitFor();
  await page.keyboard.press("Escape");
  await inboxDialog.waitFor({ state: "hidden" });

  // Verify upstream A2A client receives completed task with designer's final edited canvas!
  const completedTask = await a2aRpc("tasks/get", { id: hitlTask.id });
  if (completedTask.status.state !== "completed") {
    throw Error(`Expected completed task, got ${completedTask.status.state}`);
  }
  const summaryArtifact = completedTask.artifacts.find(
    (a) => a.name === "forma-design-summary",
  );
  const reactArtifact = completedTask.artifacts.find(
    (a) => a.name === "react-project-files",
  );
  if (
    !summaryArtifact ||
    !reactArtifact ||
    !JSON.stringify(reactArtifact).includes("设计师精修定稿")
  ) {
    throw Error(
      "Completed A2A artifacts did not reflect designer manual edits",
    );
  }

  // 7. Opt-in Trusted Auto-Apply + Single-Step Undo (Cmd/Ctrl+Z)
  const dialog2 = await openIntegrations();
  await dialog2.getByLabel(/信任自动落画布/).check();
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await dialog2.waitFor({ state: "hidden" });

  const preAutoScope = await callTool("read_design");
  const autoTask = await a2aRpc("message/send", {
    message: {
      messageId: "msg-auto-1",
      role: "user",
      parts: [
        { kind: "text", text: "受信任自动落画布测试" },
        {
          kind: "data",
          data: {
            skill: "refine_artboard",
            transaction: {
              baseRevision: preAutoScope.data.revision,
              operations: [
                {
                  type: "update",
                  id: boardId,
                  patch: { name: "自动落画布稿" },
                },
              ],
            },
          },
        },
      ],
    },
  });
  await page
    .locator(`[data-layer-id="${boardId}"]`)
    .getByText("自动落画布稿")
    .waitFor();

  // Wait for auto-apply completion receipt on A2A
  let autoDone = null;
  for (let i = 0; i < 20; i++) {
    const polled = await a2aRpc("tasks/get", { id: autoTask.id });
    if (polled.status.state === "completed") {
      autoDone = polled;
      break;
    }
    await page.waitForTimeout(200);
  }
  if (!autoDone)
    throw Error("Auto-apply A2A task did not reach completed state");

  // Single-step Cmd/Ctrl+Z undo reverts auto-applied edit!
  await page.locator(".editor-canvas").click({ position: { x: 12, y: 12 } });
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await page
    .locator(`[data-layer-id="${boardId}"]`)
    .getByText("设计师精修定稿")
    .waitFor();

  // 8. Verify 1024x480 short window fit for both modal & inbox popover
  await page.setViewportSize({ width: 1024, height: 480 });
  const shortDialog = await openIntegrations();
  const shortFit = await shortDialog.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return (
      r.top >= 0 &&
      r.bottom <= innerHeight + 1 &&
      r.left >= 0 &&
      r.right <= innerWidth + 1
    );
  });
  if (!shortFit) throw Error("IntegrationsModal overflows 1024x480 viewport");
  await page.keyboard.press("Escape");
  await shortDialog.waitFor({ state: "hidden" });

  return {
    startupAgentRequests: startupAgentRequests.length,
    mcpHttpToolCount: toolNames.length,
    mcpPreviewSvg: true,
    mcpExportReact: true,
    readOnlyBlockedWrite: true,
    a2aAgentCardSkills: skillIds,
    a2aOfflineAuditAndExport: true,
    a2aHitlEditedDelivery: true,
    a2aTrustedAutoApplyAndUndo: true,
    shortWindowFit: true,
  };
};
