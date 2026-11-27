import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer, request, type IncomingMessage } from "node:http";
import { createInterface } from "node:readline";
import { duplexPair } from "node:stream";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { nativeDesignSystem } from "../src/design-system/tokens";
import { transact } from "../src/domain/commands";
import { createNode, type DesignDocument } from "../src/domain/document";
import { createLibraryFromSelection } from "../src/domain/library";
import { createStarter } from "../src/domain/seed";
import { subtreeIds } from "../src/domain/tree";
import {
  getLiveSession,
  recordSessionClient,
  runSessionDelegateDesign,
  sessionRequest,
  submitSessionProposal,
  type SessionRequestOptions,
} from "../server/agent-sessions";
import { createFormaMcpHttpHandler } from "../server/mcp-http";
import {
  exportReactCode,
  listOpenTabsView,
  renderArtboardPreview,
  runDelegatedDesignTask,
  type SessionTabSummary,
} from "../server/runtime-capabilities";

const tabs: SessionTabSummary[] = [
  { id: "home", kind: "home", title: "工作台", active: false },
  {
    id: "file",
    kind: "file",
    title: "工作空间",
    fileKey: "draft",
    active: true,
  },
];
const base = "/api/agent/sessions";
const origin = "http://localhost:5173";
const protocolVersion = "2025-11-25";
const initialize = {
  protocolVersion,
  capabilities: {},
  clientInfo: { name: "runtime-test", version: "1" },
};
const tools = [
  "read_design",
  "list_components",
  "search_nodes",
  "get_node_details",
  "get_design_system",
  "lint_design",
  "list_open_tabs",
  "render_artboard_preview",
  "export_react_code",
  "propose_design",
  "delegate_design_task",
];
const toolList = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      annotations: z.object({ readOnlyHint: z.boolean() }),
    }),
  ),
});
const toolResult = z.object({
  isError: z.boolean().optional(),
  content: z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .length(1),
});
const rpcResult = z.object({ result: z.unknown() });
const rename = (doc: DesignDocument, id = doc.nodes[0].id) => ({
  baseRevision: doc.revision,
  operations: [{ type: "update" as const, id, patch: { name: "交付稿" } }],
});

function fixture(t: TestContext, options: SessionRequestOptions = {}) {
  const isAllowedOrigin = (req: IncomingMessage) =>
    req.headers.origin === origin;
  const mcp = createFormaMcpHttpHandler({
    isAllowedOrigin,
    version: "0.15.0",
    delegateRunner: options.delegateRunner,
  });
  const server = createServer(async (req, res) => {
    if (req.url === "/mcp") return mcp(req, res);
    const body = async (): Promise<unknown> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      return JSON.parse(Buffer.concat(chunks).toString());
    };
    try {
      const value = await sessionRequest(
        req,
        body,
        isAllowedOrigin(req),
        options,
      );
      res.end(JSON.stringify(value));
    } catch (error) {
      res.statusCode =
        error instanceof Error &&
        "status" in error &&
        typeof error.status === "number"
          ? error.status
          : 400;
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });
  async function send(
    method: string,
    path: string,
    input?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        {
          method,
          path,
          headers: {
            host: "127.0.0.1:5174",
            connection: "close",
            "content-type": "application/json",
            ...headers,
          },
          createConnection() {
            const [client, peer] = duplexPair();
            server.emit("connection", peer);
            return client;
          },
        },
        resolve,
      );
      req.on("error", reject);
      req.end(input === undefined ? undefined : JSON.stringify(input));
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk);
    return {
      status: response.statusCode,
      headers: response.headers,
      text: Buffer.concat(chunks).toString(),
    };
  }
  async function pair(
    doc = createStarter(),
    extra: Record<string, unknown> = {},
  ) {
    const response = await send(
      "POST",
      base,
      { document: doc, selection: null, persistent: true, tabs, ...extra },
      { origin },
    );
    assert.equal(response.status, 200, response.text);
    const { key, editor } = z
      .object({ key: z.string(), editor: z.string() })
      .parse(JSON.parse(response.text));
    const auth = { authorization: "Bearer " + key };
    const editorHeaders = { ...auth, "x-forma-editor": editor, origin };
    const control = (method: string, path: string, body?: unknown) =>
      send(method, base + path, body, editorHeaders);
    t.after(async () => {
      await control("DELETE", "");
    });
    let id = 0;
    const rpc = (
      method: string,
      params: unknown,
      headers: Record<string, string> = {},
    ) =>
      send(
        "POST",
        "/mcp",
        { jsonrpc: "2.0", id: ++id, method, params },
        {
          ...auth,
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": protocolVersion,
          "x-forma-client": "Runtime QA",
          ...headers,
        },
      );
    async function call(name: string, args: unknown = {}, error = false) {
      const result = toolResult.parse(
        decodeRpc(await rpc("tools/call", { name, arguments: args })),
      );
      assert.equal(!!result.isError, error, result.content[0].text);
      return result.content[0].text;
    }
    return { key, doc, auth, editorHeaders, control, rpc, call };
  }
  return { send, pair };
}

function decodeRpc(response: {
  status?: number;
  headers: IncomingMessage["headers"];
  text: string;
}): unknown {
  assert.equal(response.status, 200, response.text);
  const event = response.headers["content-type"]?.includes("text/event-stream");
  const data = event
    ? response.text
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:") && line.slice(5).trim())
        ?.slice(5)
    : response.text;
  assert.ok(data, response.text);
  return rpcResult.parse(JSON.parse(data)).result;
}

test("offline SVG uses layout bounds, scaled markup, root fallback and the paired scope", () => {
  const doc = createStarter();
  const [board, label] = doc.nodes;
  const allowed = subtreeIds(doc, [board.id]);
  const preview = renderArtboardPreview(doc, board.id, allowed, { scale: 2 });
  assert.equal(preview.nodeId, board.id);
  assert.equal(preview.width, 760);
  assert.equal(preview.height, 540);
  assert.equal(preview.mimeType, "image/svg+xml");
  assert.match(preview.svg, /^<svg\b[^>]*width="1520" height="1080"/);
  assert.equal(decodeURIComponent(preview.dataUrl.split(",")[1]), preview.svg);
  assert.equal(
    renderArtboardPreview(doc, board.id, allowed, { nodeId: label.id })
      .nodeName,
    label.name,
  );
  const slice = createNode("slice");
  doc.nodes.unshift(slice);
  assert.equal(renderArtboardPreview(doc, null, null, {}).nodeId, board.id);
  assert.doesNotMatch(
    renderArtboardPreview(doc, slice.id, new Set([slice.id]), {}).svg,
    /让好设计/,
  );
  assert.throws(
    () => renderArtboardPreview(doc, board.id, allowed, { nodeId: slice.id }),
    /会话范围/,
  );
  for (const scale of [0.24, 4.1])
    assert.throws(() => renderArtboardPreview(doc, null, null, { scale }));
  assert.throws(
    () => renderArtboardPreview({ ...doc, nodes: [] }, null, null, {}),
    /当前画布没有/,
  );
});

test("React export compiles starter, scoped subtrees, component variants and token files", () => {
  const doc = createStarter();
  const [board, label] = doc.nodes;
  const full = exportReactCode(doc, null, null, {});
  assert.match(
    full.files["src/DesignPage.tsx"],
    /export default function DesignPage/,
  );
  assert.match(full.files["src/DesignPage.tsx"], /--token-brand/);
  assert.match(full.files["src/tokens.css"], /--token-brand: #635bff/);
  assert.match(full.files["src/tokens.ts"], /"cssName": "--token-brand"/);
  assert.equal(
    JSON.parse(full.files["design-system.json"]).system.variables.brand.values
      .base,
    doc.tokens.brand.value,
  );
  assert.equal(doc.designSystem, undefined);
  assert.equal(full.fileCount, full.filePaths.length);
  assert.deepEqual(full.filePaths, Object.keys(full.files).sort());
  doc.designSystem = nativeDesignSystem();
  const allowed = subtreeIds(doc, [label.id]);
  const fragment = exportReactCode(doc, label.id, allowed, {});
  assert.equal(fragment.targetName, label.name);
  assert.ok(fragment.files["src/DesignPage.tsx"].includes(label.text));
  assert.ok(!fragment.files["src/DesignPage.tsx"].includes(board.id));
  assert.match(fragment.files["src/tokens.css"], /:root/);
  assert.ok(
    fragment.files["src/tokens.ts"] && fragment.files["design-system.json"],
  );
  assert.deepEqual(
    exportReactCode(doc, null, allowed, {}).files,
    fragment.files,
  );
  assert.throws(
    () => exportReactCode(doc, label.id, allowed, { nodeId: board.id }),
    /会话范围/,
  );
  const lib = createLibraryFromSelection(doc, label.id, "Typography");
  const component = lib.components[0];
  const withInstance = transact(doc, {
    baseRevision: doc.revision,
    operations: [
      { type: "putLibrary", library: lib },
      {
        type: "insertComponent",
        libraryId: lib.id,
        componentId: component.id,
        variantId: component.variants[0].id,
        parentId: null,
        position: { x: 0, y: 0 },
      },
    ],
  });
  assert.ok(
    exportReactCode(withInstance, null, null, {}).filePaths.some((path) =>
      path.startsWith("src/components/"),
    ),
  );
  assert.deepEqual(
    exportReactCode(withInstance, null, null, {
      includeTokens: false,
      includeComponents: false,
    }).filePaths,
    ["src/DesignPage.tsx"],
  );
});

test("persistent editor sync follows the current tab, validates snapshots and acknowledges only the matching proposal", async (t) => {
  const api = fixture(t);
  const { key, doc, auth, control } = await api.pair();
  assert.deepEqual(runTabs(), listOpenTabsView(tabs, doc, null));
  function runTabs() {
    const s = getLiveSession(key)!;
    return listOpenTabsView(
      [...s.tabs],
      s.context.document,
      s.context.selection,
    );
  }
  const next = createStarter();
  next.revision = 3;
  const synced = await control("PUT", "/sync", {
    document: next,
    selection: next.nodes[0].id,
    tabs: [
      ...tabs,
      { id: "example", kind: "example", title: "新稿", active: false },
    ],
    activeTabId: "example",
    approvalMode: "auto-apply",
    writeEnabled: false,
  });
  assert.deepEqual(JSON.parse(synced.text), {
    ok: true,
    revision: 3,
    approvalMode: "auto-apply",
    writeEnabled: false,
    proposal: null,
    connectedClients: [],
    tasks: [],
  });
  const view = JSON.parse(
    (await api.send("GET", base + "/tabs", undefined, auth)).text,
  );
  assert.equal(view.activeTabId, "example");
  assert.equal(view.document.id, next.id);
  assert.equal(view.selection, next.nodes[0].id);
  assert.equal(
    view.tabs.filter((tab: SessionTabSummary) => tab.active).length,
    1,
  );
  for (const [method, path] of [
    ["PUT", "/sync"],
    ["POST", "/proposal/ack"],
    ["POST", "/tasks/id/complete"],
    ["POST", "/tasks/id/reject"],
  ]) {
    assert.match(
      (await api.send(method, base + path, {}, auth)).text,
      /需要编辑器会话/,
    );
  }
  assert.equal(
    (await control("PUT", "/sync", { document: {}, writeEnabled: true }))
      .status,
    400,
  );
  assert.equal(getLiveSession(key)?.writeEnabled, false);
  await control("PUT", "/sync", { document: doc, writeEnabled: true });
  assert.equal(getLiveSession(key)?.context.selection, null);
  const queued = JSON.parse(
    (await api.send("POST", base + "/proposal", rename(doc), auth)).text,
  );
  assert.equal(getLiveSession(key)?.proposal?.autoApply, true);
  assert.deepEqual(
    JSON.parse(
      (
        await control("POST", "/proposal/ack", {
          proposalId: "older",
          status: "discarded",
        })
      ).text,
    ),
    { ok: true, cleared: false },
  );
  assert.equal(getLiveSession(key)?.proposal?.id, queued.id);
  assert.deepEqual(
    JSON.parse(
      (
        await control("POST", "/proposal/ack", {
          proposalId: queued.id,
          status: "applied",
        })
      ).text,
    ),
    { ok: true, cleared: true },
  );
  assert.equal(getLiveSession(key)?.proposal, null);
  assert.equal(getLiveSession(key)?.persistent, true);
  assert.equal(
    (await api.send("GET", base + "/context", undefined, auth)).status,
    200,
  );
});

test("MCP authenticates loopback clients, limits POST bodies and negotiates legacy SSE and modern JSON", async (t) => {
  const api = fixture(t);
  const { key, rpc, auth } = await api.pair();
  for (const authorization of ["", "Bearer unknown", key]) {
    const response = await api.send("POST", "/mcp", {}, { authorization });
    assert.equal(response.status, 401);
    assert.equal(
      response.headers["www-authenticate"],
      'Bearer realm="forma-mcp"',
    );
    assert.deepEqual(JSON.parse(response.text), {
      error: "需要有效的 Forma MCP Bearer 会话令牌",
    });
  }
  for (const host of [
    "private.example",
    "localhost.evil.example",
    "127.0.0.2",
  ]) {
    assert.equal(
      (await api.send("OPTIONS", "/mcp", undefined, { host })).status,
      403,
    );
  }
  assert.equal(
    (
      await api.send(
        "POST",
        "/mcp",
        {},
        { ...auth, origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const preflight = await api.send("OPTIONS", "/mcp", undefined, {
    origin,
    host: "[::1]:5174",
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], origin);
  const jsonOnly = await rpc("initialize", initialize, {
    accept: "application/json",
  });
  assert.equal(jsonOnly.status, 406);
  assert.match(jsonOnly.text, /text\/event-stream/);
  const hello = await rpc("initialize", initialize, { host: "localhost:8080" });
  assert.match(hello.headers["content-type"] ?? "", /text\/event-stream/);
  assert.deepEqual(
    z.object({ serverInfo: z.unknown() }).parse(decodeRpc(hello)).serverInfo,
    { name: "forma-design", version: "0.15.0" },
  );
  assert.equal(
    (
      await api.send(
        "POST",
        "/mcp",
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { ...auth, accept: "application/json, text/event-stream" },
      )
    ).status,
    202,
  );
  const listed = toolList.parse(decodeRpc(await rpc("tools/list", {}))).tools;
  assert.deepEqual(listed.map((tool) => tool.name).sort(), [...tools].sort());
  for (const tool of listed)
    assert.equal(
      tool.annotations.readOnlyHint,
      !["propose_design", "delegate_design_task"].includes(tool.name),
    );
  const modern = await rpc(
    "tools/list",
    {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
    { "mcp-method": "tools/list", "mcp-protocol-version": "2026-07-28" },
  );
  assert.match(modern.headers["content-type"] ?? "", /application\/json/);
  assert.equal(toolList.parse(decodeRpc(modern)).tools.length, 11);
  assert.equal((await api.send("GET", "/mcp", undefined, auth)).status, 405);
  assert.equal((await api.send("DELETE", "/mcp", undefined, auth)).status, 405);
  assert.equal(
    (await api.send("POST", "/mcp", "x".repeat(4 * 1024 * 1024), auth)).status,
    413,
  );
  const clients = getLiveSession(key)!.connectedClients;
  assert.equal(
    clients.filter((client) => client.name === "Runtime QA").length,
    1,
  );
  assert.equal(clients[0].protocol, "mcp-http");
});

test("all MCP tools use the live scope, honor approval and read-only settings, and forward delegated inputs", async (t) => {
  const doc = createStarter();
  const [board, label] = doc.nodes;
  let calls = 0;
  const api = fixture(t, {
    delegateRunner: async (input) => {
      calls++;
      assert.equal(input.document.id, doc.id);
      assert.equal(input.selection, label.id);
      assert.equal(input.generationMode, "blueprint");
      assert.equal(input.targetLibraryId, "typography");
      return {
        reply: "完成",
        transaction: rename(doc, label.id),
        diagnostics: ["checked"],
        toolTrace: ["edit"],
      };
    },
  });
  const { key, call, control } = await api.pair(doc, { selection: board.id });
  assert.equal(JSON.parse(await call("read_design")).id, doc.id);
  assert.deepEqual(JSON.parse(await call("list_components")), []);
  assert.ok(
    JSON.parse(await call("search_nodes", { query: label.name })).nodes.length,
  );
  assert.equal(
    JSON.parse(await call("get_node_details", { ids: [label.id] })).nodes[0].id,
    label.id,
  );
  assert.ok(
    Array.isArray(JSON.parse(await call("get_design_system")).variables),
  );
  assert.ok(Array.isArray(JSON.parse(await call("lint_design")).issues));
  assert.equal(JSON.parse(await call("list_open_tabs")).activeTabId, "file");
  assert.equal(
    JSON.parse(await call("render_artboard_preview")).nodeId,
    board.id,
  );
  assert.equal(JSON.parse(await call("export_react_code")).targetId, board.id);
  await call("propose_design", rename(doc));
  assert.equal(getLiveSession(key)?.proposal?.autoApply, false);
  assert.equal(getLiveSession(key)?.proposal?.source, "mcp");
  assert.match(await call("propose_design", rename(doc), true), /待处理提案/);
  await control("POST", "/proposal/ack", { status: "discarded" });
  await control("PUT", "/sync", { approvalMode: "auto-apply" });
  await call("propose_design", rename(doc));
  assert.equal(getLiveSession(key)?.proposal?.autoApply, true);
  await control("POST", "/proposal/ack", { status: "applied" });
  const args = {
    prompt: "更新标题",
    selectionId: label.id,
    mode: "blueprint",
    targetLibraryId: "typography",
  };
  const result = JSON.parse(await call("delegate_design_task", args));
  const proposal = getLiveSession(key)?.proposal;
  assert.ok(proposal?.id);
  assert.deepEqual(result, {
    proposalId: proposal.id,
    reply: "完成",
    operations: 1,
    approvalMode: "auto-apply",
    autoApply: true,
    diagnostics: ["checked"],
    toolTrace: ["edit"],
  });
  assert.equal(proposal.summary, args.prompt);
  assert.ok(proposal.createdAt);
  assert.equal(proposal.autoApply, true);
  await control("POST", "/proposal/ack", { status: "discarded" });
  await control("PUT", "/sync", { writeEnabled: false });
  for (const [name, input] of [
    ["propose_design", rename(doc)],
    ["delegate_design_task", args],
  ] as const) {
    assert.match(await call(name, input, true), /只读模式/);
  }
  assert.equal(
    JSON.parse(await call("render_artboard_preview")).nodeId,
    board.id,
  );
  assert.ok(
    JSON.parse(await call("export_react_code")).files["src/DesignPage.tsx"],
  );
  assert.equal(calls, 1);
  assert.equal(getLiveSession(key)?.proposal, null);
});

test("offline delegation reports service unavailable through the session API and an MCP tool error", async (t) => {
  const api = fixture(t);
  const { call, auth } = await api.pair();
  const input = { prompt: "更新标题" };
  const result = JSON.parse(await call("delegate_design_task", input, true));
  assert.equal(result.status, 503);
  assert.match(result.error, /尚未配置 AI 模型/);
  await assert.rejects(
    runDelegatedDesignTask(createStarter(), null, null, input),
    { status: 503, message: result.error },
  );
  const response = await api.send(
    "POST",
    base + "/delegate-design",
    input,
    auth,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.text), { error: result.error });
  assert.ok(
    JSON.parse(await call("export_react_code")).files["src/DesignPage.tsx"],
  );
});

test("stdio backend session routes return the compiler output and can delegate a reply without a proposal", async (t) => {
  const api = fixture(t, { delegateRunner: async () => ({ reply: "已检查" }) });
  const { doc, key, auth, call, control } = await api.pair();
  for (const [path, tool] of [
    ["render-preview", "render_artboard_preview"],
    ["export-react", "export_react_code"],
  ]) {
    const input = { nodeId: doc.nodes[0].id };
    const direct = await api.send("POST", base + "/" + path, input, auth);
    assert.equal(direct.status, 200);
    assert.deepEqual(
      JSON.parse(direct.text),
      JSON.parse(await call(tool, input)),
    );
  }
  const reply = await api.send(
    "POST",
    base + "/delegate-design",
    { prompt: "检查" },
    auth,
  );
  assert.deepEqual(JSON.parse(reply.text), {
    proposalId: null,
    reply: "已检查",
    operations: 0,
    approvalMode: "review",
    autoApply: false,
    diagnostics: [],
    toolTrace: [],
  });
  await control("PUT", "/sync", { writeEnabled: false });
  for (const [path, input] of [
    ["proposal", rename(doc)],
    ["delegate-design", { prompt: "修改" }],
  ] as const) {
    assert.match(
      (await api.send("POST", base + "/" + path, input, auth)).text,
      /只读模式/,
    );
  }
  assert.equal(getLiveSession(key)?.proposal, null);
});

test("a delayed runner cannot queue outside the current document, approval queue or write permission", async (t) => {
  const api = fixture(t);
  const { key, doc, control } = await api.pair();
  for (const change of ["revoke", "switch", "queue"] as const) {
    await control("PUT", "/sync", { document: doc, writeEnabled: true });
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const running = runSessionDelegateDesign(
      key,
      { prompt: "更新标题" },
      async () => {
        await wait;
        return { transaction: rename(doc), reply: "完成" };
      },
    );
    if (change === "queue")
      submitSessionProposal(key, rename(doc), { summary: "first" });
    else
      await control(
        "PUT",
        "/sync",
        change === "switch"
          ? { document: createStarter() }
          : { writeEnabled: false },
      );
    finish();
    await assert.rejects(
      running,
      change === "revoke"
        ? /只读/
        : change === "switch"
          ? /画布或选区/
          : /待处理提案/,
    );
    assert.equal(
      getLiveSession(key)?.proposal?.summary,
      change === "queue" ? "first" : undefined,
    );
  }
  const [board] = doc.nodes;
  const other = doc.nodes.find((n) => !n.parentId && n.id !== board.id)!;
  const invalid = async () => ({
    reply: "无效修改",
    transaction: rename(doc, other.id),
  });
  await assert.rejects(
    runDelegatedDesignTask(
      doc,
      board.id,
      subtreeIds(doc, [board.id]),
      { prompt: "修改", selectionId: other.id },
      invalid,
    ),
    /当前会话范围/,
  );
  await assert.rejects(
    runDelegatedDesignTask(
      doc,
      board.id,
      subtreeIds(doc, [board.id]),
      { prompt: "修改" },
      invalid,
    ),
    /超出当前选区/,
  );
});

test("task callbacks compile against the editor snapshot and clear only their matching proposal on success", async (t) => {
  const doc = createStarter();
  const api = fixture(t, {
    listSessionTasks: () => [
      {
        id: "task",
        contextId: "ctx",
        skill: "generate_ui",
        prompt: "设计",
        state: "input-required",
        approvalMode: "review",
        createdAt: "today",
        updatedAt: "today",
      },
    ],
    onCompleteTask: async (key, id, { document, note }) => {
      assert.equal(document?.revision, 2);
      assert.equal(getLiveSession(key)?.context.document.revision, 2);
      return { id, note, state: "completed" };
    },
    onRejectTask: async (_key, id, { reason }) => {
      if (reason === "retry") throw new Error("retry");
      return { id, reason, state: "rejected" };
    },
  });
  const { key, control } = await api.pair(doc);
  const queue = () =>
    submitSessionProposal(key, rename(getLiveSession(key)!.context.document), {
      taskId: "task",
      source: "a2a",
    });
  queue();
  assert.equal(
    JSON.parse((await control("PUT", "/sync", {})).text).tasks[0].state,
    "input-required",
  );
  await control("POST", "/tasks/other/reject", { reason: "其他任务" });
  assert.equal(getLiveSession(key)?.proposal?.taskId, "task");
  assert.equal(
    (await control("POST", "/tasks/task/reject", { reason: "retry" })).status,
    400,
  );
  assert.equal(
    (await control("POST", "/tasks/task/complete", { document: {} })).status,
    400,
  );
  assert.equal(getLiveSession(key)?.proposal?.source, "a2a");
  const done = await control("POST", "/tasks/task/complete", {
    document: { ...doc, revision: 2 },
    note: "已校对",
  });
  assert.deepEqual(JSON.parse(done.text), {
    id: "task",
    note: "已校对",
    state: "completed",
  });
  assert.equal(getLiveSession(key)?.proposal, null);
  queue();
  assert.deepEqual(
    JSON.parse(
      (await control("POST", "/tasks/task/reject", { reason: "取消" })).text,
    ),
    { id: "task", reason: "取消", state: "rejected" },
  );
  assert.equal(getLiveSession(key)?.proposal, null);
});

test("persistent and legacy sessions expire after two hours and thirty minutes of inactivity respectively", async (t) => {
  const api = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const persistent = await api.pair();
  const legacy = await api.pair(createStarter(), { persistent: false });
  now += 31 * 60 * 1000;
  assert.equal(getLiveSession(legacy.key), null);
  assert.ok(getLiveSession(persistent.key));
  now += 119 * 60 * 1000;
  recordSessionClient(persistent.key, {
    id: "ide",
    name: "IDE",
    protocol: "a2a",
  });
  now += 119 * 60 * 1000;
  assert.ok(getLiveSession(persistent.key));
  now += 121 * 60 * 1000;
  assert.equal(getLiveSession(persistent.key), null);
  assert.equal((await persistent.rpc("tools/list", {})).status, 401);
});

test(
  "stdio lists the same eleven tools and forwards each to its authenticated session endpoint",
  { timeout: 20_000 },
  async (t) => {
    const echo =
      'globalThis.fetch = async (url,init) => Response.json({path:new URL(url).pathname, method:init.method, auth:new Headers(init.headers).get("authorization"), body:init.body && JSON.parse(init.body)})';
    const child = fork(new URL("../server/mcp.ts", import.meta.url), {
      env: { ...process.env, FORMA_SESSION: "51234.test-key" },
      execArgv: [
        "--import",
        "tsx",
        "--import",
        "data:text/javascript," + encodeURIComponent(echo),
      ],
      silent: true,
    });
    const lines = createInterface({ input: child.stdout! });
    t.after(() => {
      lines.close();
      child.stdin!.end();
      child.kill();
    });
    const replies = lines[Symbol.asyncIterator]();
    let id = 0;
    async function rpc(method: string, params: unknown) {
      child.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n",
      );
      const line = await replies.next();
      assert.ok(!line.done);
      return rpcResult.parse(JSON.parse(line.value)).result;
    }
    await rpc("initialize", initialize);
    child.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    assert.deepEqual(
      toolList
        .parse(await rpc("tools/list", {}))
        .tools.map((tool) => tool.name)
        .sort(),
      [...tools].sort(),
    );
    for (const [name, path, args] of [
      ["read_design", "context"],
      ["list_components", "components"],
      ["list_open_tabs", "tabs"],
      ["search_nodes", "search-nodes", { query: "标题" }],
      ["get_node_details", "node-details", { ids: ["a"] }],
      ["get_design_system", "design-system", { kind: "variables" }],
      ["lint_design", "lint", {}],
      ["render_artboard_preview", "render-preview", { scale: 1 }],
      [
        "export_react_code",
        "export-react",
        { includeTokens: true, includeComponents: true },
      ],
      ["propose_design", "proposal", rename(createStarter())],
      ["delegate_design_task", "delegate-design", { prompt: "设计" }],
    ] as const) {
      const result = toolResult.parse(
        await rpc("tools/call", { name, arguments: args ?? {} }),
      );
      assert.equal(result.isError ?? false, false, result.content[0].text);
      assert.deepEqual(JSON.parse(result.content[0].text), {
        path: base + "/" + path,
        method: args ? "POST" : "GET",
        auth: "Bearer test-key",
        ...(args ? { body: args } : {}),
      });
    }
  },
);
