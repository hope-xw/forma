import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClientConfigSnippet,
  countPendingInboxTasks,
  formatSkillLabel,
  formatTaskStateLabel,
  resolveBridgeEndpoints,
  sortInboxTasks,
  type BridgeInboxTask,
} from "../src/application/external-bridge";

const token = "54321.pairedToken-42";
const endpoints = resolveBridgeEndpoints({ key: token });

test("explicit bridge endpoints take priority and normalize trailing slashes", () => {
  const base = "http://127.0.0.1:32671";
  assert.deepEqual(
    resolveBridgeEndpoints({
      endpointBase: base + "///",
      key: token,
      currentOrigin: "http://localhost:5173",
    }),
    {
      endpointBase: base,
      mcpUrl: base + "/mcp",
      a2aUrl: base + "/api/a2a",
      agentCardUrl: base + "/.well-known/agent-card.json",
    },
  );
});

test("the port embedded in the session key precedes the browser origin", () => {
  assert.equal(
    resolveBridgeEndpoints({
      key: token,
      currentOrigin: "http://localhost:5173",
    }).endpointBase,
    "http://127.0.0.1:54321",
  );
});

test("legacy keys use the loopback HTTP origin or the local service fallback", () => {
  for (const origin of ["http://127.0.0.1:5173", "http://localhost:5175"]) {
    assert.equal(
      resolveBridgeEndpoints({ key: "legacy", currentOrigin: origin })
        .endpointBase,
      origin,
    );
  }
  for (const currentOrigin of [
    undefined,
    "forma://app",
    "https://design.example",
    "http://localhost.example:5173",
    "http://localhost:5173@remote.example",
  ]) {
    assert.equal(
      resolveBridgeEndpoints({ key: "legacy", currentOrigin }).endpointBase,
      "http://127.0.0.1:5174",
    );
  }
});

for (const target of ["claude-code", "cursor"] as const) {
  test(`${target} configuration is valid MCP HTTP JSON with the exact credential`, () => {
    const snippet = buildClientConfigSnippet(target, endpoints, token);
    assert.equal(snippet.language, "json");
    assert.deepEqual(JSON.parse(snippet.code), {
      mcpServers: {
        forma: {
          ...(target === "claude-code" ? { type: "http" } : {}),
          url: endpoints.mcpUrl,
          headers: { Authorization: "Bearer " + token },
        },
      },
    });
    assert.ok(
      snippet.description.includes(
        target === "claude-code" ? "claude mcp add" : ".cursor/mcp.json",
      ),
    );
  });
}

test("Codex configuration declares the HTTP URL and authorization in the Forma TOML section", () => {
  const snippet = buildClientConfigSnippet("codex", endpoints, token);
  assert.equal(snippet.language, "toml");
  assert.deepEqual(snippet.code.split("\n"), [
    "[mcp_servers.forma]",
    `url = "${endpoints.mcpUrl}"`,
    `http_headers = { Authorization = "Bearer ${token}" }`,
  ]);
});

test("A2A snippet discovers the card and dispatches a JSON-RPC design audit with the session token", () => {
  const { language, code } = buildClientConfigSnippet("a2a", endpoints, token);
  assert.equal(language, "bash");
  for (const value of [
    endpoints.agentCardUrl,
    endpoints.a2aUrl,
    "Authorization: Bearer " + token,
  ])
    assert.ok(code.includes(value));
  const data = /--data '(.+)'$/.exec(code);
  assert.ok(data);
  const request = JSON.parse(data[1]);
  assert.equal(request.jsonrpc, "2.0");
  assert.equal(request.method, "message/send");
  assert.equal(request.params.message.role, "user");
  assert.equal(request.params.message.parts[0].kind, "text");
  assert.equal(request.params.message.metadata.skill, "audit_design_system");
});

function task(
  id: string,
  state: BridgeInboxTask["state"],
  day: number,
): BridgeInboxTask {
  const stamp = new Date(Date.UTC(2026, 10, day)).toISOString();
  return {
    id,
    state,
    skill: "refine_artboard",
    prompt: "调整标题",
    contextId: "ctx",
    approvalMode: "review",
    createdAt: stamp,
    updatedAt: stamp,
  };
}

test("inbox count and immutable priority sort cover every state and sort each group by last update", () => {
  const tasks = [
    task("rejected", "rejected", 25),
    task("working", "working", 10),
    task("review", "input-required", 9),
    task("completed", "completed", 24),
    task("submitted", "submitted", 11),
    task("failed", "failed", 17),
    task("new-review", "input-required", 12),
    task("canceled", "canceled", 18),
  ];
  const original = [...tasks];
  assert.equal(countPendingInboxTasks([]), 0);
  assert.equal(countPendingInboxTasks(tasks), 4);
  assert.deepEqual(
    sortInboxTasks(tasks).map((item) => item.id),
    [
      "new-review",
      "review",
      "submitted",
      "working",
      "rejected",
      "completed",
      "canceled",
      "failed",
    ],
  );
  assert.deepEqual(tasks, original);
});

test("every skill and task state has a designer-facing label", () => {
  const skills: Record<BridgeInboxTask["skill"], string> = {
    generate_ui: "生成界面",
    refine_artboard: "精修画板",
    audit_design_system: "规范与无障碍审校",
    design_to_react: "导出 React 代码",
  };
  const states: Record<BridgeInboxTask["state"], string> = {
    submitted: "已提交",
    working: "处理中",
    "input-required": "待确认回传",
    completed: "已回传交付",
    rejected: "已拒绝",
    canceled: "已取消",
    failed: "执行失败",
  };
  for (const skill of Object.keys(skills) as (keyof typeof skills)[])
    assert.equal(formatSkillLabel(skill), skills[skill]);
  for (const state of Object.keys(states) as (keyof typeof states)[])
    assert.equal(formatTaskStateLabel(state), states[state]);
});
