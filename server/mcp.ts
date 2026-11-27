import { pathToFileURL } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { createFormaMcpServer, type FormaMcpBackend } from "./mcp-tools";

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
        "X-Forma-Client-Protocol": "mcp-stdio",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const details = z.object({ error: z.string() }).safeParse(result);
      throw Object.assign(
        new Error(details.success ? details.data.error : "编辑器会话不可用"),
        { status: response.status },
      );
    }
    return result;
  }
  const backend: FormaMcpBackend = {
    readDesign: () => request("/context"),
    listComponents: () => request("/components"),
    searchNodes: (args) => request("/search-nodes", args),
    getNodeDetails: (args) => request("/node-details", args),
    getDesignSystem: (args) => request("/design-system", args),
    lintDesign: (args) => request("/lint", args),
    listOpenTabs: () => request("/tabs"),
    renderArtboardPreview: (args) => request("/render-preview", args),
    exportReactCode: (args) => request("/export-react", args),
    proposeDesign: (args) => request("/proposal", args),
    delegateDesignTask: (args) => request("/delegate-design", args),
  };
  return serveStdio(() => createFormaMcpServer(backend));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  serveMcp();
