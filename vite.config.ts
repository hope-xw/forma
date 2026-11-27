import pkg from "./package.json";
import {
  defineConfig,
  type Connect,
  type ViteDevServer,
  type PreviewServer,
} from "vite";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import {
  libraryRequest,
  localLibraryDirectory,
} from "./server/library-service";
import { createAgentRequestHandler } from "./server/agent-http";
import react from "@vitejs/plugin-react";

function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  return (
    /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket.remoteAddress ?? "",
    )
  );
}

function isLoopbackPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(150);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

function proxyToStandaloneAgent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  port: number,
  fallback: () => void,
) {
  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ECONNREFUSED" && !res.headersSent) {
      fallback();
      return;
    }
    if (!res.headersSent) {
      res.writeHead(502, {
        "Content-Type": "application/json; charset=utf-8",
      });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ error: "本地 Agent 服务连接中断" }));
    }
  });
  res.on("close", () => {
    if (!res.writableEnded) proxyReq.destroy();
  });
  req.pipe(proxyReq);
}

function serveLocalLibraries(server: ViteDevServer | PreviewServer) {
  // The editor's development/preview listener doubles as a local publisher. Team
  // deployments use their own service, credentials and allowed editor origins.
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith("/libraries/")) return next();
    if (!isLoopbackRequest(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const host = req.headers.host ?? "";
    const origins = ["http://" + host, "https://" + host, "forma://app"];
    const port = server.httpServer?.address();
    const directory = path.join(
      process.env.FORMA_LIBRARY_DIRECTORY ?? localLibraryDirectory(),
      "web-" + (typeof port === "object" && port ? port.port : "local"),
    );
    void libraryRequest({ directory, origins })(req, res);
  };
  server.middlewares.use(middleware);
}

function isModernExternalAgent(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/agent/providers",
        method: "GET",
        timeout: 200,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function serveLocalAgent(server: ViteDevServer | PreviewServer) {
  const agentPort = Number(process.env.AGENT_PORT ?? 5174);
  const inProcessHandler = createAgentRequestHandler({
    allowSameHostLoopback: true,
  });

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? "";
    const isAgentApi = url.startsWith("/api/agent/");
    const isMcp = url === "/mcp" || url.startsWith("/mcp?");
    const isA2a =
      url === "/.well-known/agent-card.json" ||
      url === "/api/a2a" ||
      url.startsWith("/api/a2a?");
    if (!isAgentApi && !isMcp && !isA2a) return next();
    if (!isLoopbackRequest(req)) {
      res.writeHead(403, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ error: "仅允许本机回环访问 Agent 接口" }));
      return;
    }

    const isSessionRoute =
      url.startsWith("/api/agent/sessions") || isMcp || isA2a;
    const checkExternal = isSessionRoute
      ? isLoopbackPortListening(agentPort)
      : isModernExternalAgent(agentPort);

    // Proxy to standalone `dev:agent` when running (for MCP session sharing or
    // explicit modern external agent); otherwise handle in-process seamlessly.
    void checkExternal.then((hasExternal) => {
      if (hasExternal) {
        proxyToStandaloneAgent(req, res, agentPort, () => {
          void inProcessHandler(req, res);
        });
      } else {
        void inProcessHandler(req, res);
      }
    });
  };
  server.middlewares.use(middleware);
}

export default defineConfig({
  worker: { format: "es" },
  optimizeDeps: { exclude: ["harfbuzzjs"] },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/")) {
            if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) {
              return "vendor-react";
            }
            if (id.includes("/node_modules/lucide-react/")) {
              return "vendor-lucide";
            }
            if (id.includes("/node_modules/zod/")) {
              return "vendor-zod";
            }
            if (id.includes("/node_modules/paper/")) {
              return "vendor-paper";
            }
            if (id.includes("/node_modules/fflate/")) {
              return "vendor-fflate";
            }
          }
        },
      },
    },
  },
  plugins: [
    react(),
    {
      name: "forma-local-libraries",
      configureServer: serveLocalLibraries,
      configurePreviewServer: serveLocalLibraries,
    },
    {
      name: "forma-local-agent",
      configureServer: serveLocalAgent,
      configurePreviewServer: serveLocalAgent,
    },
  ],
  define: {
    __FORMA_VERSION__: JSON.stringify(pkg.version),
  },
});
