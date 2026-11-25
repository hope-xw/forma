import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  shell,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
);
const APP_VERSION = pkg.version;
const DEV_URL = process.env.FORMA_DEV_URL || "";
const offscreenQA = process.argv.includes("--forma-offscreen-qa");
if (offscreenQA && process.platform === "darwin")
  app.setActivationPolicy("prohibited");
const DIST_DIR = path.join(app.getAppPath(), "dist");
const MAX_EXTERNAL_BYTES = 256 * 1024 * 1024;
const MAX_NATIVE_BYTES = 512 * 1024 * 1024;
const FILE_CHUNK_BYTES = 4 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: "forma",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const initialPaths = [];
const pendingFiles = new WeakMap();

async function readDesignFile(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const limit = /\.(sketch|fig)$/i.test(filePath)
      ? MAX_EXTERNAL_BYTES
      : MAX_NATIVE_BYTES;
    if (!stat.isFile() || stat.size > limit)
      throw Error("请选择不超过 " + limit / 1024 / 1024 + " MiB 的设计文件");
    return {
      name: path.basename(filePath),
      size: stat.size,
      handle,
      offset: 0,
      reading: false,
      started: false,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function deliverDesignFile(filePath) {
  try {
    const payload = await readDesignFile(filePath);
    createWindow("", payload);
  } catch (error) {
    dialog.showErrorBox(
      "打开设计文件失败",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function targetUrl(search = "") {
  const suffix = search ? (search.startsWith("?") ? search : `?${search}`) : "";
  if (DEV_URL) {
    const base = DEV_URL.endsWith("/") ? DEV_URL : `${DEV_URL}/`;
    return `${base}${suffix}`;
  }
  return `forma://app/${suffix}`;
}

function createWindow(search = "", file = null) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 620,
    title: `Forma · 设计工作台`,
    backgroundColor: "#f4f4f6",
    show: false,
    webPreferences: {
      offscreen: offscreenQA,
      backgroundThrottling: !offscreenQA,
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--forma-version=${APP_VERSION}`],
    },
  });

  win.once("ready-to-show", () => {
    if (!offscreenQA) win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      const isInternal =
        parsed.protocol === "forma:" ||
        (DEV_URL && url.startsWith(new URL(DEV_URL).origin));
      if (isInternal) {
        createWindow(parsed.search);
        return { action: "deny" };
      }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        void shell.openExternal(url);
      }
    } catch {
      // Ignore malformed URLs.
    }
    return { action: "deny" };
  });

  if (file) {
    const owner = win.webContents;
    pendingFiles.set(owner, file);
    let initialNavigation = true;
    function release() {
      if (pendingFiles.delete(owner)) void file.handle.close().catch(() => {});
    }
    owner.once("destroyed", release);
    owner.on("did-start-navigation", ({ isMainFrame, isSameDocument }) => {
      if (!isMainFrame || isSameDocument) return;
      if (!initialNavigation) release();
      initialNavigation = false;
    });
  }
  void win.loadURL(targetUrl(search));
  return win;
}

function sendMenuAction(action) {
  const win =
    BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send("forma:menu-action", action);
  }
}

async function openDesignFileDialog() {
  const win = BrowserWindow.getFocusedWindow() || undefined;
  const result = await dialog.showOpenDialog(win, {
    title: "打开设计文件",
    properties: ["openFile"],
    filters: [
      {
        name: "设计文件（Forma、Sketch、Figma）",
        extensions: ["json", "forma", "sketch", "fig"],
      },
    ],
  });
  if (!result.canceled && result.filePaths[0]) {
    deliverDesignFile(result.filePaths[0]);
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [
          {
            label: "Forma",
            submenu: [
              { role: "about", label: `关于 Forma (v${APP_VERSION})` },
              { type: "separator" },
              { role: "services", label: "服务" },
              { type: "separator" },
              { role: "hide", label: "隐藏 Forma" },
              { role: "hideOthers", label: "隐藏其他" },
              { role: "unhide", label: "显示全部" },
              { type: "separator" },
              { role: "quit", label: "退出 Forma" },
            ],
          },
        ]
      : []),
    {
      label: "文件",
      submenu: [
        {
          label: "新建窗口",
          accelerator: "CmdOrCtrl+N",
          click: () => createWindow(),
        },
        {
          label: "打开设计文件…",
          accelerator: "CmdOrCtrl+O",
          click: () => void openDesignFileDialog(),
        },
        { type: "separator" },
        {
          label: "打开移动设计研究室",
          click: () =>
            createWindow(
              "?example=mobile-studio&edition=atlas&page=atlas&node=atlas-tablet-root",
            ),
        },
        {
          label: "打开 SaaS 产品与营销样例",
          click: () => createWindow("?example=aura-showcase"),
        },
        { type: "separator" },
        isMac
          ? { role: "close", label: "关闭窗口" }
          : { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        {
          label: "撤销",
          accelerator: "CmdOrCtrl+Z",
          click: () => sendMenuAction("undo"),
        },
        {
          label: "重做",
          accelerator: "Shift+CmdOrCtrl+Z",
          click: () => sendMenuAction("redo"),
        },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        {
          label: "全选",
          accelerator: "CmdOrCtrl+A",
          click: () => sendMenuAction("selectAll"),
        },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "缩放至 100%", click: () => sendMenuAction("zoom100") },
        { label: "适应全部内容", click: () => sendMenuAction("fit") },
        { label: "适应选区", click: () => sendMenuAction("fitSelection") },
        { label: "显示或隐藏标尺", click: () => sendMenuAction("rulers") },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" },
        {
          label: "开发者工具",
          accelerator: isMac ? "Alt+Command+I" : "Ctrl+Shift+I",
          click: (_item, win) => win?.webContents.toggleDevTools(),
        },
        {
          label: "强制重新加载",
          accelerator: "Shift+CmdOrCtrl+R",
          click: (_item, win) => win?.webContents.reloadIgnoringCache(),
        },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(isMac
          ? [{ type: "separator" }, { role: "front", label: "前置全部窗口" }]
          : [{ role: "close", label: "关闭" }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let localAgent;
let openingAgent;
async function localAgentAddress() {
  if (localAgent) return "http://127.0.0.1:" + localAgent.address().port;
  if (openingAgent) return openingAgent;
  openingAgent = (async () => {
    const { agentServer } = await import("../out-electron/agent-service.mjs");
    const configDir = path.join(app.getPath("userData"), "agent-config");
    const listener = agentServer({
      configDir,
      origins: [
        "forma://app",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:4173",
        ...(DEV_URL ? [new URL(DEV_URL).origin] : []),
      ],
    });
    try {
      await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", resolve);
      });
      localAgent = listener;
      return "http://127.0.0.1:" + listener.address().port;
    } catch (err) {
      listener.close();
      throw err;
    }
  })();
  try {
    return await openingAgent;
  } finally {
    openingAgent = undefined;
  }
}

async function supportsExternalAgent(base, sessionRoute) {
  const probe = (route) =>
    fetch(base + "/api/agent/" + route, {
      redirect: "error",
      signal: AbortSignal.timeout(500),
    });
  try {
    if (!sessionRoute) {
      const res = await probe("providers");
      if (res.status !== 200) return false;
      if (res.headers.get("x-forma-agent")?.trim()) return true;
      const body = await res.json();
      if (!Array.isArray(body?.providers)) return false;
      if (body.agent === "forma" || body.agent === "forma-agent") return true;
    }
    // The existing Forma service has no marker on /providers. Its session
    // protocol has a distinct response to a context read without credentials.
    const res = await probe("sessions/context");
    return (
      res.status === 400 && (await res.json()).error === "外部 Agent 会话已结束"
    );
  } catch {
    return false;
  }
}

async function forwardAgentRequest(request, pathname, search = "") {
  // Electron custom privileged schemes (`forma://app/`) omit Origin, Referer,
  // and Sec-Fetch-Site on legitimate same-origin fetches, while cross-origin
  // or sandboxed opaque frames still attach explicit headers.
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const referer = request.headers.get("referer");
  if (
    (origin !== null && origin !== "forma://app") ||
    (fetchSite !== null &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none") ||
    (referer !== null &&
      referer !== "forma://app" &&
      !referer.startsWith("forma://app/"))
  )
    return Response.json({ error: "请求来源不允许" }, { status: 403 });
  const headers = new Headers({ origin: "forma://app" });
  for (const name of [
    "accept",
    "content-type",
    "authorization",
    "x-forma-editor",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const sessionRoute =
      pathname === "/api/agent/sessions" ||
      pathname.startsWith("/api/agent/sessions/");
    const configured = process.env.AGENT_PORT?.trim();
    const port =
      configured && /^\d+$/.test(configured) ? Number(configured) : 0;
    const external =
      port > 0 && port <= 65535 ? "http://127.0.0.1:" + port : undefined;
    const base =
      external && (await supportsExternalAgent(external, sessionRoute))
        ? external
        : await localAgentAddress();
    const response = await fetch(new URL(pathname + search, base), {
      method: request.method,
      headers,
      redirect: "error",
      ...(request.body ? { body: request.body, duplex: "half" } : {}),
    });
    if (
      pathname === "/api/agent/sessions" &&
      request.method === "POST" &&
      response.ok
    ) {
      const targetPort = Number(new URL(base).port);
      if (targetPort > 0 && targetPort <= 65535 && targetPort !== 5174) {
        const data = await response
          .clone()
          .json()
          .catch(() => null);
        if (typeof data?.key === "string" && !/^\d+\./.test(data.key))
          return Response.json(
            { ...data, key: `${targetPort}.${data.key}` },
            { status: response.status },
          );
      }
    }
    return response;
  } catch {
    return Response.json({ error: "本机 Agent 服务未连接" }, { status: 503 });
  }
}
function registerAppProtocol() {
  protocol.handle("forma", (request) => {
    const url = new URL(request.url);
    if (
      url.protocol !== "forma:" ||
      url.hostname !== "app" ||
      url.port ||
      url.username ||
      url.password
    ) {
      return new Response("Not Found", { status: 404 });
    }
    if (
      /^\/api\/agent\/(providers|status|detect|profiles(?:\/[^/]+(?:\/refresh)?)?|skills(?:\/[^/]+)?|chat|critique|library-playbook|generate|sessions(?:\/(?:proposal|context|components|search-nodes|node-details|design-system|lint))?)$/.test(
        url.pathname,
      )
    )
      return forwardAgentRequest(request, url.pathname, url.search);
    const rawPath = decodeURIComponent(url.pathname || "/");
    const relPath = rawPath.replace(/^\/+/, "");
    let filePath = path.resolve(DIST_DIR, relPath || "index.html");
    if (!filePath.startsWith(DIST_DIR)) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST_DIR, "index.html");
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    return new Response(fs.readFileSync(filePath), {
      headers: { "Content-Type": contentType },
    });
  });
}

app.setName("Forma");
app.setAboutPanelOptions({
  applicationName: "Forma",
  applicationVersion: APP_VERSION,
  version: `v${APP_VERSION}`,
  copyright: "Forma Design Tool",
  credits: "Web & 移动 H5 设计与 React/TS 工程交付工作台",
});

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) deliverDesignFile(filePath);
  else initialPaths.push(filePath);
});

let localLibrary;
let openingLibrary;
async function localLibraryAddress() {
  if (localLibrary) return "http://127.0.0.1:" + localLibrary.address().port;
  if (openingLibrary) return openingLibrary;
  openingLibrary = (async () => {
    const { libraryServer } =
      await import("../out-electron/library-service.mjs");
    const directory = path.join(app.getPath("userData"), "published-libraries");
    const portFile = path.join(directory, "port.json");
    const port = fs.existsSync(portFile)
      ? JSON.parse(fs.readFileSync(portFile, "utf8"))
      : 0;
    const listener = libraryServer({
      directory,
      origins: [
        "forma://app",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:4173",
        ...(DEV_URL ? [new URL(DEV_URL).origin] : []),
      ],
    });
    try {
      await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(port, "127.0.0.1", resolve);
      });
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(portFile, JSON.stringify(listener.address().port), {
        mode: 0o600,
      });
      localLibrary = listener;
      return "http://127.0.0.1:" + listener.address().port;
    } catch (err) {
      listener.close();
      throw err;
    }
  })();
  try {
    return await openingLibrary;
  } finally {
    openingLibrary = undefined;
  }
}
ipcMain.handle("forma:local-library-address", (event) => {
  const here = new URL(event.senderFrame.url);
  const editor = new URL(targetUrl());
  if (
    event.senderFrame !== event.sender.mainFrame ||
    here.protocol !== editor.protocol ||
    here.host !== editor.host
  )
    throw Error("请从 Forma 编辑器发布组件库");
  return localLibraryAddress();
});
app.on("before-quit", () => {
  localLibrary?.close();
  localAgent?.close();
});
ipcMain.handle("forma:consume-pending-file", (event) => {
  const file = pendingFiles.get(event.sender);
  if (!file || file.started) return null;
  file.started = true;
  if (!file.size) {
    pendingFiles.delete(event.sender);
    void file.handle.close();
  }
  return { name: file.name, size: file.size };
});
ipcMain.handle("forma:read-pending-chunk", async (event) => {
  const file = pendingFiles.get(event.sender);
  if (!file?.started || file.reading) throw Error("没有可读取的文件");
  file.reading = true;
  try {
    const buffer = Buffer.alloc(
      Math.min(FILE_CHUNK_BYTES, file.size - file.offset),
    );
    const { bytesRead } = await file.handle.read(
      buffer,
      0,
      buffer.length,
      file.offset,
    );
    if (!bytesRead) throw Error("读取期间文件大小发生变化");
    file.offset += bytesRead;
    if (file.offset === file.size && pendingFiles.delete(event.sender)) {
      await file.handle.close();
    }
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (pendingFiles.delete(event.sender)) await file.handle.close();
    throw error;
  } finally {
    file.reading = false;
  }
});

app.whenReady().then(async () => {
  if (!DEV_URL) registerAppProtocol();
  buildMenu();
  if (
    fs.existsSync(
      path.join(app.getPath("userData"), "published-libraries", "port.json"),
    )
  )
    void localLibraryAddress().catch((error) =>
      console.error("本机组件库启动失败", error.message),
    );
  await Promise.all(initialPaths.splice(0).map(deliverDesignFile));
  if (!BrowserWindow.getAllWindows().length) createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
