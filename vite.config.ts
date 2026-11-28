import { resolveSystemFonts } from "./electron/system-fonts.mjs";
import pkg from "./package.json";
import {
  defineConfig,
  type Connect,
  type ViteDevServer,
  type PreviewServer,
  type Plugin,
} from "vite";
import http from "node:http";
import { readFile } from "node:fs/promises";
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
    (host === "::1" ||
      /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket.remoteAddress ?? "",
    )
  );
}

// Keep the two response slots until the socket drains or closes, including slow readers.
let activeFontResponses = 0;
export const localFontRequest: Connect.NextHandleFunction = async (
  req,
  res,
  next,
) => {
  if (req.url !== "/api/system-fonts/resolve") return next();
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (
    !isLoopbackRequest(req) ||
    (origin && origin !== "http://" + host && origin !== "https://" + host)
  ) {
    res.writeHead(403).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  if (
    req.headers["content-type"]?.split(";")[0].trim() !== "application/json"
  ) {
    res.writeHead(415).end();
    return;
  }
  if (activeFontResponses >= 2) {
    req.resume();
    res
      .writeHead(429, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      .end(
        JSON.stringify({
          ok: false,
          code: "BUSY",
          error: "系统字体解析繁忙，请稍后重试",
        }),
      );
    return;
  }
  activeFontResponses++;
  const release = () => {
    res.off("finish", release);
    res.off("close", release);
    activeFontResponses--;
  };
  res.once("finish", release);
  res.once("close", release);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 128 * 1024) {
        req.resume();
        res
          .writeHead(413, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          })
          .end(
            JSON.stringify({
              ok: false,
              code: "BUDGET_EXCEEDED",
              error: "系统字体请求超过 128 KiB",
            }),
          );
        return;
      }
      chunks.push(chunk);
    }
    const faces = await resolveSystemFonts(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    res
      .writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      .end(JSON.stringify({ faces }));
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    const status =
      code === "BUSY"
        ? 429
        : code === "BUDGET_EXCEEDED"
          ? 413
          : error instanceof SyntaxError || error instanceof TypeError
            ? 400
            : 500;
    res
      .writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      .end(
        JSON.stringify({
          ok: false,
          code: code ?? (status === 400 ? "INVALID_REQUEST" : "RESOLVE_FAILED"),
          error: error instanceof Error ? error.message : "系统字体解析失败",
        }),
      );
  }
};

function serveLocalFonts(server: ViteDevServer | PreviewServer) {
  server.middlewares.use(localFontRequest);
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

// wawoff2 2.0.1 exports its Emscripten Module only in its Node branch.
// Both browser bundlers must give decompress.js that same Module so its
// onRuntimeInitialized callback fires when the embedded WASM is ready.
const decoderBinding = /[/\\]wawoff2[/\\]build[/\\]decompress_binding\.js$/;
function browserBinding(source: string) {
  return source + "\nmodule.exports = Module;\n";
}
function browserWoff2(): Plugin {
  const empty = "\0wawoff2-browser-builtins";
  return {
    name: "wawoff2-browser-binding",
    enforce: "pre",
    transform(source, id) {
      if (decoderBinding.test(id))
        return { code: browserBinding(source), map: null };
    },
    resolveId(id, importer) {
      // fs and path only occur inside the binding's unreachable Node branch.
      if (
        (id === "fs" || id === "path") &&
        importer &&
        decoderBinding.test(importer)
      )
        return empty;
    },
    load(id) {
      if (id === empty) return "export default {}";
    },
  };
}

export default defineConfig({
  worker: { format: "es", plugins: () => [browserWoff2()] },
  optimizeDeps: {
    exclude: ["harfbuzzjs"],
    include: ["wawoff2/decompress.js"],
    esbuildOptions: {
      plugins: [
        {
          name: "wawoff2-browser-binding",
          setup(build) {
            build.onLoad({ filter: decoderBinding }, async ({ path }) => ({
              contents: browserBinding(await readFile(path, "utf8")),
              loader: "js",
            }));
          },
        },
      ],
    },
  },
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
    browserWoff2(),
    {
      name: "forma-local-fonts",
      configureServer: serveLocalFonts,
      configurePreviewServer: serveLocalFonts,
    },
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
