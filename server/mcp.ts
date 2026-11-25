import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { transactionSchema } from "../src/domain/commands";
import { sessionToolSchemas } from "./agent-sessions";

export function resolveMcpSession(env: NodeJS.ProcessEnv) {
  const key = env.FORMA_SESSION;
  if (!key)
    throw new Error("请从 Forma 的 Agent 面板开启会话，并设置 FORMA_SESSION");
  const prefix = /^(\d{1,5})\.(.+)$/.exec(key);
  const embedded = Number(prefix?.[1]);
  const embeddedPort = embedded >= 1 && embedded <= 65535 ? embedded : 0;
  const raw = env.AGENT_PORT?.trim();
  const explicit = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
  const validExplicit = explicit >= 1 && explicit <= 65535 ? explicit : 0;
  const port = validExplicit || embeddedPort || 5174;
  return {
    port,
    token: embeddedPort && prefix ? prefix[2] : key,
  };
}

function serveMcp() {
  const { port, token } = resolveMcpSession(process.env);
  const base = `http://127.0.0.1:${port}/api/agent/sessions`;
  async function request(path: string, payload?: unknown) {
    const response = await fetch(base + path, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "编辑器会话不可用");
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
  return serveStdio(() => {
    const server = new McpServer({ name: "forma-design", version: "1.0.0" });
    server.registerTool(
      "read_design",
      {
        description:
          "Read the paired editor scope, native layers, variables and base revision.",
        inputSchema: z.object({}),
      },
      () => request("/context"),
    );
    server.registerTool(
      "list_components",
      {
        description: "Find installed component and variant IDs.",
        inputSchema: z.object({}),
      },
      () => request("/components"),
    );
    server.registerTool(
      "propose_design",
      {
        description:
          "Send an atomic design transaction to the designer for inspection, application and undo.",
        inputSchema: transactionSchema,
      },
      (args) => request("/proposal", args),
    );
    const queries = [
      [
        "search_nodes",
        "search-nodes",
        "Find matching layers in the paired selection or active page. Returns up to 40 matches by default.",
      ],
      [
        "get_node_details",
        "node-details",
        "Read native layer properties by ID. Set includeChildren to include all descendants within the paired scope.",
      ],
      [
        "get_design_system",
        "design-system",
        "Read variables with resolved values, styles and collection modes. A paired selection exposes its design-system dependencies.",
      ],
      [
        "lint_design",
        "lint",
        "Audit a layer subtree, the paired selection or the active page for contrast, unbound colors, overflow and empty text.",
      ],
    ] as const;
    for (const [name, endpoint, description] of queries) {
      server.registerTool(
        name,
        {
          description,
          inputSchema: sessionToolSchemas[endpoint],
          annotations: { readOnlyHint: true },
        },
        (args: unknown) => request("/" + endpoint, args),
      );
    }
    return server;
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  serveMcp();
