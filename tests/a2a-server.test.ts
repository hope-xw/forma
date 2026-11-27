import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request, type IncomingMessage } from "node:http";
import { duplexPair } from "node:stream";
import test from "node:test";
import { z } from "zod";
import {
  a2aAgentCardSchema,
  a2aArtifactUpdateEventSchema,
  a2aStatusUpdateEventSchema,
  a2aTaskSchema,
  buildFormaAgentCard,
  inferFormaSkill,
  jsonRpcIdSchema,
  type A2AMessage,
  type A2ATask,
} from "../server/a2a-protocol";
import {
  createA2AServer,
  type A2ARuntimeAdapter,
  type A2ASessionAuth,
} from "../server/a2a-server";

const baseUrl = "http://127.0.0.1:4173";
const host = "127.0.0.1:4173";
const eventSchema = z.discriminatedUnion("kind", [
  a2aStatusUpdateEventSchema,
  a2aArtifactUpdateEventSchema,
]);

function user(text: string, extra: Partial<A2AMessage> = {}): A2AMessage {
  return {
    messageId: randomUUID(),
    role: "user",
    parts: [{ kind: "text", text }],
    ...extra,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function readText(response: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function frames(response: IncomingMessage, requestId: string | number) {
  assert.equal(response.statusCode, 200);
  assert.equal(
    response.headers["content-type"],
    "text/event-stream; charset=utf-8",
  );
  assert.equal(response.headers["cache-control"], "no-cache, no-store");
  assert.equal(response.headers.connection, "keep-alive");
  const body = await readText(response);
  assert.ok(body.endsWith("\n\n"));
  return body
    .trimEnd()
    .split("\n\n")
    .map((frame) => {
      assert.ok(frame.startsWith("data: "));
      const wire = z
        .object({
          id: jsonRpcIdSchema,
          jsonrpc: z.literal("2.0"),
          result: eventSchema,
        })
        .parse(JSON.parse(frame.slice(6)));
      assert.equal(wire.id, requestId);
      return wire.result;
    });
}

function fixture(waitTimeoutMs = 5_000) {
  const auth: A2ASessionAuth = {
    sessionKey: "alpha",
    approvalMode: "review",
    writeEnabled: true,
    documentId: "doc1",
    documentName: "Storefront",
    revision: 1,
    selection: "checkout",
  };
  const other = { ...auth, sessionKey: "beta", documentId: "doc2" };
  const sessions = new Map([
    ["alpha", auth],
    ["beta", other],
  ]);
  const clients: string[][] = [];
  const cleared: string[][] = [];
  const proposals = new Map<string, string>();
  const inputs: Parameters<A2ARuntimeAdapter["generateProposal"]>[1][] = [];
  const canvas = { title: "Original heading" };
  const exports: Parameters<A2ARuntimeAdapter["exportReact"]>[1][] = [];
  const audits: Parameters<A2ARuntimeAdapter["auditDesign"]>[1][] = [];
  const adapter: A2ARuntimeAdapter = {
    authenticate(header) {
      const token = /^Bearer (\S+)$/.exec(header ?? "")?.[1] ?? "";
      const snapshot = sessions.get(token);
      return snapshot ? { ...snapshot } : null;
    },
    recordClient: (key, name) => {
      clients.push([key, name]);
    },
    getSessionSnapshot: (key) => sessions.get(key) ?? null,
    async auditDesign(_key, input) {
      audits.push(input);
      return {
        issues: [{ rule: "text-contrast", nodeId: "label" }],
        designSystem: { name: "Store kit" },
      };
    },
    async exportReact(key, input) {
      exports.push(input);
      const session = sessions.get(key);
      assert.ok(session);
      return {
        targetId: input.nodeId ?? session.selection ?? "page",
        targetName: "Checkout",
        revision: session.revision,
        files: {
          "src/App.tsx": `export default function App() { return <h1>${canvas.title}</h1>; }`,
        },
        filePaths: ["src/App.tsx"],
        fileCount: 1,
      };
    },
    async renderPreview(key, { nodeId }) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>${canvas.title}</text></svg>`;
      return {
        nodeId: nodeId ?? sessions.get(key)?.selection ?? "page",
        nodeName: "Checkout",
        width: 390,
        height: 844,
        mimeType: "image/svg+xml",
        svg,
        dataUrl:
          "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"),
      };
    },
    async generateProposal(key, input) {
      inputs.push(input);
      const proposalId = randomUUID();
      proposals.set(input.taskId, proposalId);
      return {
        proposalId,
        operations: 1,
        reply: input.prompt,
        autoApply: sessions.get(key)?.approvalMode === "auto-apply",
      };
    },
    clearTaskProposal(key, taskId) {
      cleared.push([key, taskId]);
      proposals.delete(taskId);
    },
  };
  const runtime = createA2AServer({
    adapter,
    isAllowedOrigin: (req) => req.headers.origin === baseUrl,
    waitTimeoutMs,
  });
  const server = createServer((req, res) => {
    if (req.url === "/.well-known/agent-card.json")
      runtime.handleAgentCard(req, res, baseUrl);
    else if (req.url === "/api/a2a") void runtime.handleRpc(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });

  function http(
    method: string,
    path: string,
    body?: string,
    headers?: Record<string, string>,
  ) {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        {
          path,
          method,
          headers: {
            host,
            connection: "close",
            authorization: "Bearer alpha",
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
      req.end(body);
    });
  }
  function invoke(
    method: string,
    params?: unknown,
    key = "alpha",
    id: string | number = "request",
  ) {
    return http(
      "POST",
      "/api/a2a",
      JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      {
        authorization: "Bearer " + key,
        "x-a2a-client": "Design CLI",
      },
    );
  }
  async function rpc(method: string, params?: unknown, key = "alpha") {
    const response = await invoke(method, params, key);
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] ?? "", /^application\/json/);
    const raw: unknown = JSON.parse(await readText(response));
    return z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.literal("request"),
        result: z.unknown().optional(),
        error: z.object({ code: z.number(), message: z.string() }).optional(),
      })
      .parse(raw);
  }
  async function send(text: string, options = {}) {
    return a2aTaskSchema.parse(
      (await rpc("message/send", { message: user(text), ...options })).result,
    );
  }
  return {
    runtime,
    adapter,
    http,
    invoke,
    rpc,
    send,
    auth,
    canvas,
    clients,
    inputs,
    cleared,
    exports,
    audits,
    proposals,
  };
}

function data(task: A2ATask, name: string) {
  const part = task.artifacts.find((artifact) => artifact.name === name)
    ?.parts[0];
  assert.ok(part?.kind === "data", name);
  return part.data;
}
function svg(task: A2ATask) {
  const part = task.artifacts.find(
    (artifact) => artifact.name === "artboard-preview",
  )?.parts[0];
  assert.ok(part?.kind === "file" && typeof part.file.bytes === "string");
  assert.equal(part.file.mimeType, "image/svg+xml");
  return Buffer.from(part.file.bytes, "base64").toString();
}

test("loopback discovery advertises the four skills, auth scheme, version and actual endpoint", async () => {
  const { http } = fixture();
  const path = "/.well-known/agent-card.json";
  const response = await http("GET", path, undefined, {
    authorization: "",
    host: "[::1]:4173",
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /application\/json/);
  const card = a2aAgentCardSchema.parse(JSON.parse(await readText(response)));
  assert.equal(card.url, baseUrl + "/api/a2a");
  assert.equal(card.name, "Forma Design Agent");
  assert.equal(card.version, "0.15.0");
  assert.equal(card.protocolVersion, "0.3.0");
  assert.deepEqual(card.capabilities, {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  });
  assert.deepEqual(card.securitySchemes, {
    bearer: { type: "http", scheme: "bearer" },
  });
  assert.deepEqual(card.security, [{ bearer: [] }]);
  assert.deepEqual(
    card.skills.map((skill) => skill.id),
    [
      "generate_ui",
      "refine_artboard",
      "audit_design_system",
      "design_to_react",
    ],
  );
  for (const skill of card.skills) {
    assert.ok(
      skill.description &&
        skill.examples.length &&
        skill.tags.length &&
        skill.inputModes.length &&
        skill.outputModes.length,
    );
  }
  assert.equal(
    buildFormaAgentCard({ baseUrl, version: "0.15.1" }).version,
    "0.15.1",
  );
  assert.equal((await http("POST", path)).statusCode, 405);
  assert.equal(
    (await http("GET", path, undefined, { host: "notlocalhost" })).statusCode,
    403,
  );
  assert.ok([200, 204].includes((await http("OPTIONS", path)).statusCode ?? 0));
});

test("Host, Origin, verb and Bearer checks run before task dispatch", async () => {
  const { http, clients, runtime } = fixture();
  const path = "/api/a2a";
  for (const header of ["", "Bearer unknown"]) {
    const response = await http("POST", path, undefined, {
      authorization: header,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(
      response.headers["www-authenticate"],
      'Bearer realm="forma-a2a"',
    );
    assert.equal(JSON.parse(await readText(response)).error.code, -32003);
  }
  for (const host of [
    "localhost.example",
    "127.0.0.2",
    "localhost@evil.example",
    "[::1].example",
  ]) {
    assert.equal(
      (await http("POST", path, undefined, { host })).statusCode,
      403,
    );
  }
  for (const origin of [
    "null",
    "http://127.0.0.1:1111",
    "https://evil.example",
  ]) {
    assert.equal(
      (await http("POST", path, undefined, { origin })).statusCode,
      403,
    );
  }
  assert.equal((await http("GET", path)).statusCode, 405);
  assert.deepEqual(clients, []);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tasks/list" });
  await readText(
    await http("POST", path, body, {
      host: "localhost",
      origin: baseUrl,
      "user-agent": "My IDE",
    }),
  );
  await readText(await http("POST", path, body));
  assert.deepEqual(clients, [
    ["alpha", "My IDE"],
    ["alpha", "A2A Client"],
  ]);
  assert.deepEqual(runtime.listInboxTasks("alpha"), []);
});

test("malformed JSON, envelope, methods, params and oversized fixed or chunked bodies return RPC errors", async () => {
  const { http, rpc, runtime } = fixture();
  const raw = async (
    body: string,
    status: number,
    code: number,
    headers?: Record<string, string>,
  ) => {
    const response = await http("POST", "/api/a2a", body, headers);
    assert.equal(response.statusCode, status);
    const error = JSON.parse(await readText(response));
    assert.equal(error.id, null);
    assert.equal(error.error.code, code);
  };
  await raw("{", 400, -32700);
  await raw('{"jsonrpc":"1.0","method":"tasks/list"}', 400, -32600);
  const oversized = "a".repeat(4 * 1024 * 1024 + 1);
  await raw(oversized, 413, -32600);
  await raw(oversized, 413, -32600, { "transfer-encoding": "chunked" });
  assert.equal((await rpc("missing")).error?.code, -32601);
  for (const params of [null, { limit: 0 }, { limit: 101 }, { limit: 1.2 }]) {
    assert.equal((await rpc("tasks/list", params)).error?.code, -32602);
  }
  for (const params of [
    { message: { role: "user", parts: [] } },
    { message: user("hi"), configuration: { historyLength: -1 } },
    { message: user("hi"), metadata: { selectionId: 42 } },
    {
      message: user("hi", {
        parts: [{ kind: "file", file: { mimeType: "text/plain" } }],
      }),
    },
  ]) {
    assert.equal((await rpc("message/send", params)).error?.code, -32602);
  }
  assert.deepEqual(runtime.listInboxTasks("alpha"), []);
});

test("skill routing honors valid explicit IDs and deterministic bilingual text precedence", () => {
  assert.equal(inferFormaSkill(user("规范、调整和导出")), "design_to_react");
  assert.equal(
    inferFormaSkill(user("polish and check CONTRAST")),
    "audit_design_system",
  );
  assert.equal(inferFormaSkill(user("请精修按钮")), "refine_artboard");
  assert.equal(inferFormaSkill(user("Create a login screen")), "generate_ui");
  const message = user("", {
    parts: [
      { kind: "text", text: "export" },
      { kind: "data", data: { skill: "refine_artboard" } },
    ],
  });
  assert.equal(
    inferFormaSkill(message, { skill: "audit_design_system" }),
    "audit_design_system",
  );
  assert.equal(
    inferFormaSkill(message, { skill: "unknown" }),
    "refine_artboard",
  );
});

test("offline audit and React export produce structured report, source files, SVG and document summary", async () => {
  const { send, audits, exports, inputs, clients, adapter } = fixture();
  const audit = await send("检查规范", { metadata: { rootId: "root" } });
  assert.equal(audit.status.state, "completed");
  assert.deepEqual(data(audit, "design-audit-report"), {
    issues: [{ rule: "text-contrast", nodeId: "label" }],
    designSystem: { name: "Store kit" },
  });
  assert.deepEqual(audits, [{ rootId: "root" }]);
  const task = await send("export", {
    metadata: { nodeId: "root", includeComponents: false, includeTokens: true },
  });
  assert.equal(task.status.state, "completed");
  assert.deepEqual(exports, [
    { nodeId: "root", includeComponents: false, includeTokens: true },
  ]);
  assert.equal(data(task, "react-project-files").targetId, "root");
  assert.deepEqual(data(task, "react-project-files").filePaths, [
    "src/App.tsx",
  ]);
  assert.match(svg(task), /Original heading/);
  assert.equal(data(task, "forma-design-summary").documentId, "doc1");
  assert.deepEqual(inputs, []);
  assert.deepEqual(clients, [
    ["alpha", "Design CLI"],
    ["alpha", "Design CLI"],
  ]);
  adapter.renderPreview = async () => {
    throw new Error("unavailable");
  };
  const partial = await send("导出");
  assert.equal(partial.status.state, "completed");
  assert.deepEqual(
    partial.artifacts.map((a) => a.name),
    ["react-project-files", "forma-design-summary"],
  );
});

test("review forwards proposal inputs, exposes it in the inbox and returns the latest edited canvas", async () => {
  const {
    send,
    auth,
    canvas,
    rpc,
    inputs,
    runtime,
    exports,
    proposals,
    cleared,
  } = fixture();
  const transaction = { operations: [{ type: "insert" }] };
  const task = await send("", {
    message: user("", {
      parts: [
        { kind: "text", text: "Build" },
        { kind: "text", text: "checkout" },
        { kind: "data", data: { selectionId: "instance", transaction } },
      ],
    }),
    metadata: { targetLibraryId: "store-kit" },
  });
  assert.equal(task.status.state, "input-required");
  assert.deepEqual(task.status.message?.parts, [
    { kind: "text", text: "已在 Forma 画布生成待审方案，等待设计师确认并回传" },
  ]);
  assert.deepEqual(inputs, [
    {
      taskId: task.id,
      skill: "generate_ui",
      prompt: "Build\ncheckout",
      selectionId: "instance",
      targetLibraryId: "store-kit",
      transaction,
    },
  ]);
  assert.deepEqual(exports, []);
  const [inbox] = runtime.listInboxTasks("alpha");
  assert.equal(inbox.proposalId, proposals.get(task.id));
  assert.equal(inbox.state, "input-required");
  assert.equal(inbox.sourceClient, "Design CLI");
  assert.equal(inbox.approvalMode, "review");
  assert.deepEqual(runtime.listInboxTasks("beta"), []);
  canvas.title = "Designer edited heading";
  auth.revision++;
  const completed = await runtime.completeTaskFromEditor("alpha", task.id, {
    nodeId: "edited-board",
    note: "Looks good",
  });
  const retrieved = a2aTaskSchema.parse(
    (await rpc("tasks/get", { id: task.id })).result,
  );
  assert.deepEqual(retrieved, completed);
  assert.equal(retrieved.status.state, "completed");
  const files = z
    .record(z.string(), z.string())
    .parse(data(retrieved, "react-project-files").files);
  assert.match(files["src/App.tsx"], /Designer edited heading/);
  assert.match(svg(retrieved), /Designer edited heading/);
  assert.equal(data(retrieved, "forma-design-summary").revision, 2);
  assert.equal(data(retrieved, "react-project-files").targetId, "edited-board");
  assert.deepEqual(retrieved.history.at(-1)?.parts, [
    { kind: "text", text: "Looks good" },
  ]);
  assert.deepEqual(cleared, [["alpha", task.id]]);
  assert.equal(runtime.listInboxTasks("alpha")[0].proposalId, undefined);
  const recent = a2aTaskSchema.parse(
    (await rpc("tasks/get", { id: task.id, historyLength: 1 })).result,
  );
  assert.deepEqual(recent.history, retrieved.history.slice(-1));
  assert.deepEqual(
    a2aTaskSchema.parse(
      (await rpc("tasks/get", { id: task.id, historyLength: 0 })).result,
    ).history,
    [],
  );
});

test("cross-session access is denied for lookups, follow-ups, subscriptions and editor callbacks", async () => {
  const { send, rpc, runtime, proposals } = fixture();
  const task = await send("Create", {
    message: user("Create", { contextId: "shared" }),
  });
  for (const method of ["tasks/get", "tasks/resubscribe", "tasks/cancel"]) {
    assert.equal(
      (await rpc(method, { id: task.id }, "beta")).error?.code,
      -32001,
    );
  }
  assert.equal(
    (
      await rpc(
        "message/send",
        { message: user("refine", { taskId: task.id }) },
        "beta",
      )
    ).error?.code,
    -32001,
  );
  assert.deepEqual(
    (await rpc("tasks/list", { contextId: "shared" }, "beta")).result,
    { tasks: [] },
  );
  assert.equal(runtime.getTask("beta", task.id), null);
  assert.throws(() => runtime.rejectTaskFromEditor("beta", task.id), {
    code: -32001,
  });
  await assert.rejects(runtime.completeTaskFromEditor("beta", task.id), {
    code: -32001,
  });
  assert.ok(proposals.has(task.id));
});

test("designer rejection and client cancellation clear proposals and preserve terminal states", async () => {
  const { send, rpc, runtime, proposals } = fixture();
  const first = await send("Create");
  const rejected = runtime.rejectTaskFromEditor(
    "alpha",
    first.id,
    "Use the mobile grid",
  );
  assert.equal(rejected.status.state, "rejected");
  assert.deepEqual(rejected.status.message?.parts, [
    { kind: "text", text: "Use the mobile grid" },
  ]);
  assert.equal(proposals.has(first.id), false);
  const second = await send("精修");
  const canceled = a2aTaskSchema.parse(
    (await rpc("tasks/cancel", { id: second.id, reason: "Stopped by caller" }))
      .result,
  );
  assert.equal(canceled.status.state, "canceled");
  assert.deepEqual(canceled.status.message?.parts, [
    { kind: "text", text: "Stopped by caller" },
  ]);
  assert.equal(proposals.has(second.id), false);
  assert.equal(
    (await rpc("tasks/cancel", { id: second.id })).error?.code,
    -32002,
  );
  await assert.rejects(runtime.completeTaskFromEditor("alpha", second.id), {
    code: -32602,
  });
  assert.throws(() => runtime.rejectTaskFromEditor("alpha", first.id), {
    code: -32002,
  });
});

test("read-only sessions can audit and export while all canvas proposals are refused", async () => {
  const { auth, rpc, send, inputs } = fixture();
  auth.writeEnabled = false;
  for (const method of ["message/send", "message/stream"]) {
    for (const skill of ["generate_ui", "refine_artboard"]) {
      const failure = await rpc(method, {
        message: user("export"),
        metadata: { skill },
      });
      assert.deepEqual(failure.error, {
        code: -32003,
        message: "当前外部连接处于只读模式，不允许写入画布",
      });
    }
  }
  assert.equal((await send("audit")).status.state, "completed");
  assert.equal((await send("react")).status.state, "completed");
  assert.deepEqual(inputs, []);
});

test("SSE separates the review turn from live resubscription and emits all final artifacts", async () => {
  const { invoke, runtime, canvas, auth } = fixture();
  const start = await frames(
    await invoke("message/stream", { message: user("调整") }, "alpha", 0),
    0,
  );
  assert.deepEqual(
    start.map((e) => e.kind === "status-update" && [e.status.state, e.final]),
    [
      ["submitted", false],
      ["working", false],
      ["input-required", true],
    ],
  );
  const { taskId, contextId } = start[0];
  const subscribed = await invoke(
    "tasks/resubscribe",
    { id: taskId },
    "alpha",
    2,
  );
  const receiving = frames(subscribed, 2);
  canvas.title = "Final mobile checkout";
  auth.revision = 3;
  const task = await runtime.completeTaskFromEditor("alpha", taskId);
  const events = await receiving;
  assert.deepEqual(
    events.map((e) =>
      e.kind === "status-update" ? [e.status.state, e.final] : e.artifact.name,
    ),
    [
      ["input-required", false],
      "react-project-files",
      "artboard-preview",
      "forma-design-summary",
      ["completed", true],
    ],
  );
  assert.ok(
    events.every((e) => e.taskId === taskId && e.contextId === contextId),
  );
  assert.deepEqual(
    events.filter((e) => e.kind === "artifact-update").map((e) => e.artifact),
    task.artifacts,
  );
  assert.match(svg(task), /Final mobile checkout/);
});

test("audit streaming delivers submitted and working, the report, then a single final event", async () => {
  const { invoke } = fixture();
  const events = await frames(
    await invoke("message/stream", { message: user("lint") }),
    "request",
  );
  assert.deepEqual(
    events.map((e) =>
      e.kind === "status-update" ? [e.status.state, e.final] : e.artifact.name,
    ),
    [
      ["submitted", false],
      ["working", false],
      "design-audit-report",
      ["completed", true],
    ],
  );
});

test("auto-apply can return a working task, block a send, or stream until editor acknowledgement", async () => {
  const { auth, send, invoke, adapter, runtime } = fixture();
  auth.approvalMode = "auto-apply";
  const working = await send("Create", { configuration: { historyLength: 0 } });
  assert.deepEqual(working.history, []);
  assert.equal(working.status.state, "working");
  assert.equal(working.metadata?.awaitingAutoApply, true);
  assert.ok(working.metadata?.proposalId);
  const complete = await runtime.completeTaskFromEditor("alpha", working.id);
  assert.equal(complete.metadata?.awaitingAutoApply, undefined);
  for (const method of ["message/send", "message/stream"]) {
    const ready = deferred<string>();
    const generate = adapter.generateProposal;
    adapter.generateProposal = async (key, input) => {
      const proposal = await generate(key, input);
      ready.resolve(input.taskId);
      return proposal;
    };
    const response = invoke(method, {
      message: user("refine"),
      configuration: { blocking: true },
    });
    const id = await ready.promise;
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(
      runtime.getTask("alpha", id)?.metadata?.awaitingAutoApply,
      true,
    );
    await runtime.completeTaskFromEditor("alpha", id);
    if (method === "message/send") {
      const task = a2aTaskSchema.parse(
        JSON.parse(await readText(await response)).result,
      );
      assert.equal(task.status.state, "completed");
    } else {
      const events = await frames(await response, "request");
      assert.deepEqual(
        events.map((e) =>
          e.kind === "status-update" ? e.status.state : e.artifact.name,
        ),
        [
          "submitted",
          "working",
          "working",
          "react-project-files",
          "artboard-preview",
          "forma-design-summary",
          "completed",
        ],
      );
    }
    adapter.generateProposal = generate;
  }
});

test("model and adapter failures produce failed task events without leaking adapter error details", async () => {
  const { adapter, rpc, invoke, runtime } = fixture();
  adapter.generateProposal = async () => {
    throw Object.assign(new Error("private provider information"), {
      status: 503,
    });
  };
  assert.deepEqual(
    (await rpc("message/send", { message: user("Create") })).error,
    { code: -32004, message: "Model not configured" },
  );
  assert.equal(runtime.listInboxTasks("alpha")[0].state, "failed");
  adapter.auditDesign = async () => {
    throw new Error("private provider information");
  };
  const events = await frames(
    await invoke("message/stream", { message: user("audit") }),
    "request",
  );
  const failed = events.at(-1);
  assert.ok(failed?.kind === "status-update" && failed.final);
  assert.equal(failed.status.state, "failed");
  assert.ok(!JSON.stringify(events).includes("private provider information"));
});

test("late generation cannot re-enqueue a canceled proposal and cancellation wins over concurrent exports", async () => {
  const { adapter, invoke, rpc, runtime, send, proposals } = fixture();
  const started = deferred<string>();
  const resume = deferred<void>();
  const generate = adapter.generateProposal;
  adapter.generateProposal = async (key, input) => {
    started.resolve(input.taskId);
    await resume.promise;
    return generate(key, input);
  };
  const pending = invoke("message/send", { message: user("Create") });
  const id = await started.promise;
  await rpc("tasks/cancel", { id });
  resume.resolve();
  assert.equal(
    JSON.parse(await readText(await pending)).result.status.state,
    "canceled",
  );
  assert.equal(proposals.has(id), false);
  adapter.generateProposal = generate;
  const next = await send("refine");
  const release = deferred<void>();
  const exportReact = adapter.exportReact;
  let count = 0;
  adapter.exportReact = async (key, input) => {
    count++;
    await release.promise;
    return exportReact(key, input);
  };
  const confirmations = [
    runtime.completeTaskFromEditor("alpha", next.id),
    runtime.completeTaskFromEditor("alpha", next.id),
  ];
  runtime.rejectTaskFromEditor("alpha", next.id);
  release.resolve();
  for (const result of await Promise.all(confirmations)) {
    assert.equal(result.status.state, "rejected");
    assert.deepEqual(result.artifacts, []);
  }
  assert.equal(count, 1);
});

test("timeout ends idle resubscription and blocking wait while preserving an actionable task", async () => {
  const { auth, invoke, runtime } = fixture(40);
  auth.approvalMode = "auto-apply";
  const response = await invoke("message/send", {
    message: user("Create"),
    configuration: { blocking: true },
  });
  const task = a2aTaskSchema.parse(JSON.parse(await readText(response)).result);
  assert.equal(task.status.state, "working");
  const events = await frames(
    await invoke("tasks/resubscribe", { id: task.id }),
    "request",
  );
  assert.equal(events.length, 1);
  assert.ok(events[0].kind === "status-update" && !events[0].final);
  assert.equal(
    (await runtime.completeTaskFromEditor("alpha", task.id)).status.state,
    "completed",
  );
});

test("valid follow-up replaces the review proposal under its original task and context", async () => {
  const { send, rpc, runtime } = fixture();
  const first = await send("Create");
  assert.equal(
    (
      await rpc("message/send", {
        message: user("edit", { taskId: first.id, contextId: "wrong" }),
      })
    ).error?.code,
    -32602,
  );
  const next = await send("", {
    message: user("edit the header", {
      taskId: first.id,
      contextId: first.contextId,
    }),
  });
  assert.equal(next.id, first.id);
  assert.equal(next.contextId, first.contextId);
  assert.equal(next.status.state, "input-required");
  assert.notEqual(next.metadata?.proposalId, first.metadata?.proposalId);
  assert.equal(runtime.listInboxTasks("alpha").length, 1);
  assert.equal(
    next.history.filter((message) => message.role === "user").length,
    2,
  );
});

test("lists are filtered and newest-first, inbox is capped and pruning retains pending reviews", async () => {
  const { send, rpc, runtime } = fixture();
  const review = await send("Create");
  const audits: A2ATask[] = [];
  for (let index = 0; index < 65; index++) {
    audits.push(
      await send("", {
        message: user("audit", { contextId: index % 2 ? "odd" : "even" }),
      }),
    );
  }
  const list = async (params?: unknown) =>
    z
      .object({ tasks: z.array(a2aTaskSchema) })
      .parse((await rpc("tasks/list", params)).result).tasks;
  const latest = audits.at(-1);
  assert.ok(latest);
  assert.equal((await list()).length, 20);
  assert.equal((await list({ limit: 100 })).length, 64);
  assert.deepEqual(
    (await list({ contextId: "even", limit: 2 })).map((t) => t.id),
    [latest.id, audits[62].id],
  );
  assert.equal(runtime.listInboxTasks("alpha").length, 30);
  assert.equal(runtime.listInboxTasks("alpha")[0].id, latest.id);
  assert.equal(runtime.getTask("alpha", audits[0].id), null);
  assert.equal(
    runtime.getTask("alpha", review.id)?.status.state,
    "input-required",
  );
});

test("retrying the same message over HTTP or SSE reuses its task and proposal", async () => {
  const { rpc, invoke, inputs, runtime } = fixture();
  const params = {
    message: user("Create"),
    metadata: { targetLibraryId: "store" },
  };
  const [first, repeated] = await Promise.all([
    rpc("message/send", params),
    rpc("message/send", params),
  ]);
  const task = a2aTaskSchema.parse(first.result);
  assert.equal(a2aTaskSchema.parse(repeated.result).id, task.id);
  const events = await frames(
    await invoke("message/stream", params),
    "request",
  );
  assert.deepEqual(
    events.map(
      (e) => e.kind === "status-update" && [e.taskId, e.status.state, e.final],
    ),
    [[task.id, "input-required", true]],
  );
  assert.equal(
    (
      await rpc("message/send", {
        ...params,
        metadata: { targetLibraryId: "different" },
      })
    ).error?.code,
    -32602,
  );
  assert.equal(runtime.listInboxTasks("alpha").length, 1);
  assert.equal(inputs.length, 1);
});

test("a failed editor export or a tab switch preserves the review for a successful retry", async () => {
  const { send, adapter, auth, runtime, proposals } = fixture();
  const task = await send("Create");
  auth.documentId = "other-tab";
  await assert.rejects(runtime.completeTaskFromEditor("alpha", task.id), {
    code: -32602,
  });
  auth.documentId = "doc1";
  const compile = adapter.exportReact;
  adapter.exportReact = async () => {
    throw new Error("compile failed");
  };
  await assert.rejects(
    runtime.completeTaskFromEditor("alpha", task.id),
    /compile failed/,
  );
  assert.equal(
    runtime.getTask("alpha", task.id)?.status.state,
    "input-required",
  );
  assert.ok(proposals.has(task.id));
  adapter.exportReact = compile;
  adapter.renderPreview = () => {
    throw new Error("preview failed");
  };
  const completed = await runtime.completeTaskFromEditor("alpha", task.id);
  assert.equal(completed.status.state, "completed");
  assert.deepEqual(
    completed.artifacts.map((a) => a.name),
    ["react-project-files", "forma-design-summary"],
  );
});

test("switching to review or read-only during generation applies the live permission at handoff", async () => {
  const { auth, adapter, rpc, runtime, proposals } = fixture();
  const generate = adapter.generateProposal;
  auth.approvalMode = "auto-apply";
  adapter.generateProposal = async (key, input) => {
    auth.approvalMode = "review";
    return generate(key, input);
  };
  const reviewed = a2aTaskSchema.parse(
    (await rpc("message/send", { message: user("Create") })).result,
  );
  assert.equal(reviewed.status.state, "input-required");
  assert.equal(reviewed.metadata?.approvalMode, "review");
  runtime.rejectTaskFromEditor("alpha", reviewed.id);
  adapter.generateProposal = async (key, input) => {
    auth.writeEnabled = false;
    return generate(key, input);
  };
  assert.equal(
    (await rpc("message/send", { message: user("Create") })).error?.code,
    -32003,
  );
  assert.equal(proposals.size, 0);
  assert.equal(runtime.listInboxTasks("alpha")[0].state, "failed");
});

test("live subscribers receive cancellation and rejection as final events", async () => {
  const { send, invoke, rpc, runtime } = fixture();
  for (const state of ["canceled", "rejected"]) {
    const task = await send("Create");
    const response = await invoke("tasks/resubscribe", { id: task.id });
    if (state === "canceled") await rpc("tasks/cancel", { id: task.id });
    else runtime.rejectTaskFromEditor("alpha", task.id);
    const events = await frames(response, "request");
    assert.deepEqual(
      events.map(
        (e) => e.kind === "status-update" && [e.status.state, e.final],
      ),
      [
        ["input-required", false],
        [state, true],
      ],
    );
  }
});
