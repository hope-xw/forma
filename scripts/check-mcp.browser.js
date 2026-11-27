async (page) => {
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const board = page.locator(".design-node[data-node-type=frame]").first();
  const id = await board.getAttribute("data-node-id");
  const row = page.locator('[data-layer-id="' + id + '"] .layer-main');
  const title = await row.innerText();
  await row.click();
  const openIntegrations = async () => {
    await page.getByLabel("文件菜单", { exact: true }).click();
    await page
      .getByRole("button", { name: "外部工具集成（MCP）…", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "外部工具集成", exact: true })
      .waitFor();
  };
  await openIntegrations();
  await page.getByRole("button", { name: "连接外部 Agent" }).click();
  const key = await page.getByLabel("MCP 会话密钥").inputValue();
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "外部工具集成", exact: true })
    .waitFor({ state: "hidden" });
  const sidebar = page.getByRole("button", {
    name: "图层与资源面板",
    exact: true,
  });
  await sidebar.click();
  await sidebar.click();
  await page.getByRole("button", { name: "图层", exact: true }).click();
  await page.getByRole("button", { name: "AI 设计助手", exact: true }).click();
  await openIntegrations();
  if ((await page.getByLabel("MCP 会话密钥").inputValue()) !== key)
    throw Error(
      "Closing integrations modal or sidebar navigation closed the external session",
    );
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "外部工具集成", exact: true })
    .waitFor({ state: "hidden" });
  const child = spawn(process.execPath, ["--import", "tsx", "server/mcp.ts"], {
    cwd: process.env.INIT_CWD ?? process.cwd(),
    env: { ...process.env, FORMA_SESSION: key },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  let seq = 0;
  const send = (msg) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  async function rpc(method, params) {
    const id = ++seq;
    send({ id, method, params });
    for (;;) {
      const line = await messages.next();
      if (line.done) throw Error("MCP closed");
      const msg = JSON.parse(line.value);
      if (msg.id === id) {
        if (msg.error || msg.result?.isError)
          throw Error(JSON.stringify(msg.error ?? msg.result));
        return msg.result;
      }
    }
  }
  try {
    await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "forma-qa", version: "1" },
    });
    send({ method: "notifications/initialized" });
    const tools = await rpc("tools/list", {});
    const call = async (name, args = {}) =>
      JSON.parse(
        (await rpc("tools/call", { name, arguments: args })).content[0].text,
      );
    const scope = await call("read_design");
    if (
      scope.selection !== id ||
      scope.nodes.some((n) => n.parentId === null && n.id !== id)
    )
      throw Error("Scope mismatch");
    await call("propose_design", {
      baseRevision: scope.revision,
      operations: [{ type: "update", id, patch: { name: "MCP revised" } }],
    });
    const applyButton = page.getByRole("button", { name: "应用到画布" });
    await applyButton.click();
    await applyButton.waitFor({ state: "hidden" });
    await page.getByText("MCP revised", { exact: false }).first().waitFor();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+z" : "Control+z",
    );
    await page.getByRole("button", { name: "图层", exact: true }).click();
    await page
      .getByRole("button", { name: "选择图层 " + title, exact: true })
      .waitFor();
    return {
      tools: tools.tools.map((t) => t.name),
      scope: "one board",
      applied: true,
      undo: true,
    };
  } finally {
    child.stdin.end();
    child.kill();
  }
};
