import { z } from "zod";

export const bridgeApprovalModeSchema = z.enum(["review", "auto-apply"]);
export type BridgeApprovalMode = z.infer<typeof bridgeApprovalModeSchema>;

export interface BridgeTabSummary {
  id: string;
  kind: "home" | "file" | "example";
  title: string;
  fileKey?: string;
  active: boolean;
}

export const bridgeConnectedClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: z.enum(["mcp-http", "mcp-stdio", "a2a"]),
  lastSeenAt: z.string(),
});
export type BridgeConnectedClient = z.infer<typeof bridgeConnectedClientSchema>;

export const bridgeInboxTaskSchema = z.object({
  id: z.string(),
  contextId: z.string(),
  skill: z.enum([
    "generate_ui",
    "refine_artboard",
    "audit_design_system",
    "design_to_react",
  ]),
  prompt: z.string(),
  state: z.enum([
    "submitted",
    "working",
    "input-required",
    "completed",
    "failed",
    "canceled",
    "rejected",
  ]),
  summary: z.string().optional(),
  sourceClient: z.string().optional(),
  approvalMode: bridgeApprovalModeSchema,
  proposalId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().optional(),
});
export type BridgeInboxTask = z.infer<typeof bridgeInboxTaskSchema>;

export interface BridgeEndpoints {
  endpointBase: string;
  mcpUrl: string;
  a2aUrl: string;
  agentCardUrl: string;
}

export type BridgeClientTarget = "claude-code" | "cursor" | "codex" | "a2a";

export function resolveBridgeEndpoints(input: {
  endpointBase?: string;
  key: string;
  currentOrigin?: string;
}): BridgeEndpoints {
  let endpointBase = input.endpointBase?.replace(/\/+$/, "");
  if (!endpointBase) {
    const port = /^(\d{1,5})\./.exec(input.key)?.[1];
    const origin = input.currentOrigin?.replace(/\/+$/, "");
    if (port) endpointBase = `http://127.0.0.1:${port}`;
    else if (
      origin &&
      /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(origin)
    )
      endpointBase = origin;
    else endpointBase = "http://127.0.0.1:5174";
  }
  return {
    endpointBase,
    mcpUrl: `${endpointBase}/mcp`,
    a2aUrl: `${endpointBase}/api/a2a`,
    agentCardUrl: `${endpointBase}/.well-known/agent-card.json`,
  };
}

function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function buildClientConfigSnippet(
  target: BridgeClientTarget,
  endpoints: BridgeEndpoints,
  token: string,
): {
  title: string;
  language: "json" | "toml" | "bash";
  description: string;
  code: string;
} {
  const authorization = `Bearer ${token}`;
  if (target === "codex") {
    return {
      title: "Codex",
      language: "toml",
      description: "添加到 ~/.codex/config.toml",
      code: [
        "[mcp_servers.forma]",
        `url = ${JSON.stringify(endpoints.mcpUrl)}`,
        `http_headers = { Authorization = ${JSON.stringify(authorization)} }`,
      ].join("\n"),
    };
  }
  if (target === "a2a") {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          role: "user",
          messageId: "forma-audit-example",
          metadata: { skill: "audit_design_system" },
          parts: [{ kind: "text", text: "检查当前画布的设计规范与无障碍问题" }],
        },
      },
    };
    return {
      title: "A2A",
      language: "bash",
      description: "读取 Agent Card，再向当前画布派发一次规范审校。",
      code: [
        `curl -sS ${shellQuote(endpoints.agentCardUrl)}`,
        "",
        [
          `curl -sS -X POST ${shellQuote(endpoints.a2aUrl)}`,
          `  -H ${shellQuote("Authorization: " + authorization)}`,
          "  -H 'Content-Type: application/json'",
          `  --data ${shellQuote(JSON.stringify(request))}`,
        ].join(" \\\n"),
      ].join("\n"),
    };
  }
  const claude = target === "claude-code";
  return {
    title: claude ? "Claude Code" : "Cursor",
    language: "json",
    description: claude
      ? `添加到 .mcp.json，或运行 claude mcp add --transport http forma ${shellQuote(endpoints.mcpUrl)} --header 'Authorization: Bearer <会话密钥>'`
      : "添加到项目的 .cursor/mcp.json",
    code: JSON.stringify(
      {
        mcpServers: {
          forma: {
            ...(claude ? { type: "http" } : {}),
            url: endpoints.mcpUrl,
            headers: { Authorization: authorization },
          },
        },
      },
      null,
      2,
    ),
  };
}

const stateOrder: Record<BridgeInboxTask["state"], number> = {
  "input-required": 0,
  submitted: 1,
  working: 1,
  completed: 2,
  failed: 2,
  canceled: 2,
  rejected: 2,
};

export function countPendingInboxTasks(tasks: BridgeInboxTask[]): number {
  return tasks.filter((task) => stateOrder[task.state] < 2).length;
}

export function sortInboxTasks(tasks: BridgeInboxTask[]): BridgeInboxTask[] {
  return [...tasks].sort(
    (a, b) =>
      stateOrder[a.state] - stateOrder[b.state] ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}

export function formatSkillLabel(skill: BridgeInboxTask["skill"]): string {
  return {
    generate_ui: "生成界面",
    refine_artboard: "精修画板",
    audit_design_system: "规范与无障碍审校",
    design_to_react: "导出 React 代码",
  }[skill];
}

export function formatTaskStateLabel(state: BridgeInboxTask["state"]): string {
  return {
    "input-required": "待确认回传",
    working: "处理中",
    submitted: "已提交",
    completed: "已回传交付",
    rejected: "已拒绝",
    canceled: "已取消",
    failed: "执行失败",
  }[state];
}
