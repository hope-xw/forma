import type { IncomingMessage, ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  getLiveSession,
  listSessionComponents,
  readSessionContext,
  recordSessionClient,
  resolveBearerSessionKey,
  runSessionDelegateDesign,
  runSessionDesignSystem,
  runSessionExportReact,
  runSessionLint,
  runSessionListTabs,
  runSessionNodeDetails,
  runSessionRenderPreview,
  runSessionSearchNodes,
  submitSessionProposal,
} from "./agent-sessions";
import { createFormaMcpServer } from "./mcp-tools";
import type { DelegateDesignRunner } from "./runtime-capabilities";

const maxBody = 4 * 1024 * 1024;
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i;
function errorResponse(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error }));
}

async function readPostBody(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBody) {
      req.resume();
      return null;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

export function createFormaMcpHttpHandler(options: {
  isAllowedOrigin: (req: IncomingMessage) => boolean;
  delegateRunner?: DelegateDesignRunner;
  version?: string;
}) {
  const handler = createMcpHandler(
    (ctx) => {
      const key = ctx.authInfo?.token;
      if (!key) throw new Error("需要有效的 Forma MCP Bearer 会话令牌");
      return createFormaMcpServer(
        {
          readDesign: async () => readSessionContext(key),
          listComponents: async () => listSessionComponents(key),
          searchNodes: async (args) => runSessionSearchNodes(key, args),
          getNodeDetails: async (args) => runSessionNodeDetails(key, args),
          getDesignSystem: async (args) => runSessionDesignSystem(key, args),
          lintDesign: async (args) => runSessionLint(key, args),
          listOpenTabs: async () => runSessionListTabs(key),
          renderArtboardPreview: async (args) =>
            runSessionRenderPreview(key, args),
          exportReactCode: async (args) => runSessionExportReact(key, args),
          proposeDesign: async (args) => submitSessionProposal(key, args),
          delegateDesignTask: (args) =>
            runSessionDelegateDesign(key, args, options.delegateRunner),
        },
        { version: options.version },
      );
    },
    { legacy: "stateless", maxRequestBodySize: maxBody },
  );

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = loopbackHost.exec(req.headers.host ?? "");
    if (!host || Number(host[1]) > 65535)
      return errorResponse(res, 403, "仅允许本机回环地址");
    if (req.headers.origin !== undefined) {
      if (!options.isAllowedOrigin(req))
        return errorResponse(res, 403, "请求来源不允许");
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Expose-Headers",
        "WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version",
      );
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID, MCP-Method, MCP-Name, X-Forma-Client, X-MCP-Client",
      });
      res.end();
      return;
    }
    const key = resolveBearerSessionKey(req.headers.authorization);
    const session = key ? getLiveSession(key) : null;
    if (!key || !session) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="forma-mcp"');
      return errorResponse(res, 401, "需要有效的 Forma MCP Bearer 会话令牌");
    }
    const client = req.headers["x-forma-client"] ?? req.headers["x-mcp-client"];
    const clientName =
      (typeof client === "string" && client.trim()) ||
      req.headers["user-agent"] ||
      "MCP Client";
    recordSessionClient(key, { name: clientName, protocol: "mcp-http" });

    const controller = new AbortController();
    const close = () => controller.abort();
    res.once("close", close);
    try {
      const body = req.method === "POST" ? await readPostBody(req) : undefined;
      if (body === null)
        return errorResponse(res, 413, "MCP 请求正文超过 4 MiB");
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value))
          for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      // Preserve Accept. The SDK's 2025 transport returns 406 unless the client accepts both JSON and SSE.
      const webReq = new Request("http://" + req.headers.host + "/mcp", {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
      });
      const response = await handler.fetch(webReq, {
        authInfo: {
          token: key,
          clientId: clientName,
          scopes: session.writeEnabled ? ["read", "write"] : ["read"],
        },
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        res.flushHeaders();
        await response.body.pipeTo(Writable.toWeb(res));
      } else res.end();
    } catch (err) {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else
        errorResponse(
          res,
          500,
          err instanceof Error ? err.message : "MCP 请求失败",
        );
    } finally {
      res.off("close", close);
    }
  };
}
