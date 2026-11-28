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
import { resolveSystemFonts } from "./system-fonts.mjs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
);
const APP_VERSION = pkg.version;
const DEV_URL = process.env.FORMA_DEV_URL || "";
// The packaged import verifier waits for a fresh hidden window per open-file.
const offscreenImportWindows = process.argv.includes("--forma-offscreen-qa");
const offscreenQA =
  offscreenImportWindows || process.argv.includes("--forma-offscreen-qa=tabs");
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
const pendingFileQueues = new WeakMap();
const pendingPaths = new WeakMap();
const boundFiles = new Map();
const pendingSaves = new Map();
const readyTabWindows = new Set();
let fileDelivery = Promise.resolve();

const agentConfigDir = () => path.join(app.getPath("userData"), "agent-config");
function hasConfiguredAgentOnDisk() {
  const env = process.env;
  if (
    env.OPENAI_API_KEY ||
    env.ANTHROPIC_API_KEY ||
    env.GEMINI_API_KEY ||
    env.DEEPSEEK_API_KEY ||
    env.FORMA_AGENT_API_KEY ||
    (env.MODEL_API_KEY?.trim() &&
      env.MODEL_BASE_URL?.trim() &&
      env.MODEL_ID?.trim())
  )
    return true;
  return ["agent-profiles.json", "agent-config.json"].some((name) => {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(agentConfigDir(), name), "utf8"),
      );
      return Array.isArray(parsed?.profiles) && parsed.profiles.length > 0;
    } catch {
      return false;
    }
  });
}

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
      nativePath: /\.forma$/i.test(filePath) ? path.resolve(filePath) : null,
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

function tabDeliveryWindow() {
  if (!readyTabWindows.size) return;
  const isReady = (win) =>
    readyTabWindows.has(win) &&
    !win.isDestroyed() &&
    !win.webContents.isDestroyed() &&
    isAppUrl(win.webContents.getURL());
  const focused = BrowserWindow.getFocusedWindow();
  return isReady(focused)
    ? focused
    : BrowserWindow.getAllWindows().find(isReady);
}

async function openDesignFile(filePath, separateWindow) {
  let payload;
  try {
    payload = await readDesignFile(filePath);
    const win = separateWindow ? null : tabDeliveryWindow();
    if (!win) {
      createWindow("", payload);
      return;
    }
    const queue = pendingFileQueues.get(win.webContents);
    queue.push(payload);
    try {
      if (!offscreenQA) {
        win.show();
        win.focus();
      }
      win.webContents.send("forma:open-file-in-tab", {
        name: payload.name,
        nativePath: payload.nativePath,
      });
    } catch (error) {
      queue.pop();
      throw error;
    }
  } catch (error) {
    if (payload) await payload.handle.close().catch(() => {});
    dialog.showErrorBox(
      "打开设计文件失败",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function deliverDesignFile(filePath, separateWindow = false) {
  // File opens and stats can finish out of order after a multi-selection in Finder.
  fileDelivery = fileDelivery.then(() =>
    openDesignFile(filePath, separateWindow),
  );
  return fileDelivery;
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
    ...(process.platform === "darwin" && {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 14, y: 11 },
    }),
    backgroundColor: "#f4f4f6",
    show: false,
    webPreferences: {
      offscreen: offscreenQA,
      backgroundThrottling: !offscreenQA,
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--forma-version=${APP_VERSION}`,
        `--forma-agent-configured=${hasConfiguredAgentOnDisk() ? 1 : 0}`,
      ],
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

  const owner = win.webContents;
  const queue = [];
  pendingFileQueues.set(owner, queue);
  if (file) {
    pendingFiles.set(owner, file);
    if (file.nativePath) pendingPaths.set(owner, file.nativePath);
  }
  function release() {
    readyTabWindows.delete(win);
    pendingPaths.delete(owner);
    const active = pendingFiles.get(owner);
    pendingFiles.delete(owner);
    if (active) void active.handle.close().catch(() => {});
    for (const queued of queue.splice(0))
      void queued.handle.close().catch(() => {});
  }
  owner.once("destroyed", release);
  win.once("closed", release);
  owner.on("render-process-gone", release);
  let initialNavigation = true;
  owner.on("did-start-navigation", ({ isMainFrame, isSameDocument }) => {
    if (!isMainFrame || isSameDocument) return;
    if (!initialNavigation) release();
    initialNavigation = false;
  });
  owner.on("did-finish-load", () => {
    if (isAppUrl(owner.getURL())) readyTabWindows.add(win);
  });
  void win.loadURL(targetUrl(search)).catch((error) => {
    // A superseding navigation performs its own cleanup in did-start-navigation.
    if (error.code !== "ERR_ABORTED") {
      release();
      console.error("设计窗口加载失败", error.message);
    }
  });
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
        extensions: ["forma", "json", "sketch", "fig"],
      },
    ],
  });
  if (!result.canceled && result.filePaths[0]) {
    deliverDesignFile(result.filePaths[0]);
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const newDesignTab = () => {
    if (BrowserWindow.getFocusedWindow()) sendMenuAction("newTab");
    else createWindow(`?file=forma.file.${randomUUID()}&preset=blank`);
  };
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
          label: "新建设计标签页",
          accelerator: "CmdOrCtrl+T",
          click: newDesignTab,
        },
        {
          label: "新建设计",
          accelerator: "CmdOrCtrl+N",
          click: newDesignTab,
        },
        {
          label: "新建窗口",
          accelerator: "Shift+CmdOrCtrl+N",
          click: () => createWindow(),
        },
        {
          label: "打开设计文件…",
          accelerator: "CmdOrCtrl+O",
          click: () => void openDesignFileDialog(),
        },
        {
          label: "保存",
          accelerator: "CmdOrCtrl+S",
          click: () => sendMenuAction("save"),
        },
        {
          label: "另存为 .forma…",
          accelerator: "Shift+CmdOrCtrl+S",
          click: () => sendMenuAction("saveAs"),
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
        {
          label: "重新打开已关闭标签页",
          accelerator: "Shift+CmdOrCtrl+T",
          click: () => sendMenuAction("reopenTab"),
        },
        {
          label: "关闭标签页",
          accelerator: "CmdOrCtrl+W",
          click: () => {
            if (BrowserWindow.getFocusedWindow()) sendMenuAction("closeTab");
          },
        },
        { role: "close", label: "关闭窗口", accelerator: "Shift+CmdOrCtrl+W" },
        ...(!isMac ? [{ role: "quit", label: "退出" }] : []),
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
          : []),
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
    const configDir = agentConfigDir();
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
    "x-forma-client",
    "x-mcp-client",
    "x-a2a-client",
    "mcp-protocol-version",
    "mcp-session-id",
    "last-event-id",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const sessionRoute =
      pathname === "/api/agent/sessions" ||
      pathname.startsWith("/api/agent/sessions/") ||
      pathname === "/mcp" ||
      pathname === "/api/a2a" ||
      pathname === "/.well-known/agent-card.json";
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
      const data = await response
        .clone()
        .json()
        .catch(() => null);
      if (data && typeof data === "object") {
        const nextKey =
          typeof data.key === "string" &&
          targetPort > 0 &&
          targetPort <= 65535 &&
          targetPort !== 5174 &&
          !/^\d+\./.test(data.key)
            ? `${targetPort}.${data.key}`
            : data.key;
        return Response.json(
          { ...data, key: nextKey, endpointBase: base },
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
      url.pathname === "/mcp" ||
      url.pathname === "/api/a2a" ||
      url.pathname === "/.well-known/agent-card.json" ||
      /^\/api\/agent\/(providers|status|detect|profiles(?:\/[^/]+(?:\/refresh)?)?|skills(?:\/[^/]+)?|chat|critique|library-playbook|generate|sessions(?:\/(?:proposal(?:\/ack)?|sync|tabs|render-preview|export-react|delegate-design|context|components|search-nodes|node-details|design-system|lint|tasks\/[^/]+\/(?:complete|reject)))?)$/.test(
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
  if (app.isReady()) deliverDesignFile(filePath, offscreenImportWindows);
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
function isAppUrl(url) {
  const here = URL.parse(url);
  const editor = new URL(targetUrl());
  return here?.protocol === editor.protocol && here.host === editor.host;
}
function requireAppFrame(event) {
  if (
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    !isAppUrl(event.senderFrame.url)
  )
    throw Error("请从 Forma 编辑器执行此操作");
}
ipcMain.handle("forma:open-file-in-tab-ready", (event) => {
  requireAppFrame(event);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && pendingFileQueues.has(event.sender)) readyTabWindows.add(win);
});
ipcMain.handle("forma:open-in-new-window", (event, query) => {
  requireAppFrame(event);
  // Only a search component may be appended to the fixed app URL.
  if (
    typeof query !== "string" ||
    (query !== "" && !query.startsWith("?")) ||
    /[/\\#\x00-\x1f\x7f]/.test(query)
  )
    throw Error("设计窗口参数无效");
  createWindow(query);
});
ipcMain.handle("forma:close-current-window", (event) => {
  requireAppFrame(event);
  BrowserWindow.fromWebContents(event.sender)?.close();
});
ipcMain.handle("forma:local-library-address", (event) => {
  requireAppFrame(event);
  return localLibraryAddress();
});
ipcMain.handle("forma:resolve-system-fonts", async (event, req) => {
  requireAppFrame(event);
  try {
    return await resolveSystemFonts(req);
  } catch (error) {
    return {
      ok: false,
      code:
        error.code ??
        (error instanceof TypeError ? "INVALID_REQUEST" : "RESOLVE_FAILED"),
      error: error.message,
    };
  }
});
ipcMain.handle("forma:has-configured-agent", (event) => {
  requireAppFrame(event);
  return hasConfiguredAgentOnDisk();
});
function boundFileInfo(filePath) {
  return filePath ? { filePath, fileName: path.basename(filePath) } : null;
}
function validateFileKey(key) {
  if (typeof key !== "string" || !key.trim() || key.length > 512)
    throw Error("设计文件标识无效");
}
ipcMain.handle("forma:bind-pending-file", (event, fileKey) => {
  requireAppFrame(event);
  validateFileKey(fileKey);
  const filePath = pendingPaths.get(event.sender);
  if (!filePath) return null;
  pendingPaths.delete(event.sender);
  boundFiles.set(fileKey, filePath);
  return boundFileInfo(filePath);
});
ipcMain.handle("forma:get-bound-file", (event, fileKey) => {
  requireAppFrame(event);
  if (fileKey === undefined) return null;
  validateFileKey(fileKey);
  return boundFileInfo(boundFiles.get(fileKey));
});
async function saveNativeFile(win, { bytes, suggestedName, fileKey, saveAs }) {
  let target = !saveAs && fileKey ? boundFiles.get(fileKey) : null;
  let appendedExtension = false;
  if (!target) {
    const base =
      path
        .basename(suggestedName.replaceAll("\\", "/"))
        .trim()
        .replace(/(?:\.(?:forma|json))+$/i, "")
        .replace(/[<>:"|?*\x00-\x1f]/g, "-")
        .replace(/^[. ]+|[. ]+$/g, "") || "design";
    const result = await dialog.showSaveDialog(win, {
      title: "保存 Forma 设计文件",
      defaultPath: base + ".forma",
      filters: [{ name: "Forma 设计文件", extensions: ["forma"] }],
    });
    if (result.canceled || !result.filePath)
      return { saved: false, canceled: true };
    if (!path.isAbsolute(result.filePath)) throw Error("请选择绝对文件路径");
    appendedExtension = !/\.forma$/i.test(result.filePath);
    target =
      path.normalize(result.filePath) + (appendedExtension ? ".forma" : "");
  }
  const existing = await fs.promises.stat(target).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (appendedExtension && existing)
    throw Error("目标 .forma 文件已存在，请在另存为窗口中选择该文件以确认覆盖");
  const tmp = target + ".forma-tmp-" + randomUUID();
  const handle = await fs.promises.open(
    tmp,
    "wx",
    existing ? existing.mode & 0o777 : 0o644,
  );
  try {
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    await fs.promises.rename(tmp, target);
  } catch (error) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw error;
  }
  if (fileKey) boundFiles.set(fileKey, target);
  return { saved: true, ...boundFileInfo(target) };
}
ipcMain.handle("forma:save-native-file", async (event, options) => {
  requireAppFrame(event);
  if (
    !(options?.bytes instanceof Uint8Array) ||
    options.bytes.byteLength > MAX_NATIVE_BYTES ||
    typeof options.suggestedName !== "string" ||
    (options.saveAs !== undefined && typeof options.saveAs !== "boolean")
  )
    throw Error("保存参数无效，设计文件最大为 512 MiB");
  if (options.fileKey !== undefined) validateFileKey(options.fileKey);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) throw Error("设计窗口已关闭");
  // Serialize Save and Save As so the next save uses the last successful binding.
  const key = options.fileKey ?? event.sender;
  const previous = pendingSaves.get(key) ?? Promise.resolve();
  const save = previous
    .catch(() => {})
    .then(() => saveNativeFile(win, options));
  pendingSaves.set(key, save);
  try {
    return await save;
  } finally {
    if (pendingSaves.get(key) === save) pendingSaves.delete(key);
  }
});
app.on("before-quit", () => {
  localLibrary?.close();
  localAgent?.close();
});
ipcMain.handle("forma:consume-pending-file", (event) => {
  const owner = event.sender;
  const active = pendingFiles.get(owner);
  const queue = pendingFileQueues.get(owner);
  const file = active ?? queue?.[0];
  if (!file || file.started) return null;
  // Claiming a queued import or exposing a disk path requires the trusted frame.
  if (!active || file.nativePath) requireAppFrame(event);
  if (!active) {
    queue.shift();
    pendingFiles.set(owner, file);
    if (file.nativePath) pendingPaths.set(owner, file.nativePath);
    else pendingPaths.delete(owner);
  }
  file.started = true;
  if (!file.size) {
    pendingFiles.delete(event.sender);
    void file.handle.close();
  }
  return {
    name: file.name,
    size: file.size,
    ...((!active || file.nativePath) && { nativePath: file.nativePath }),
  };
});
ipcMain.handle("forma:read-pending-chunk", async (event) => {
  requireAppFrame(event);
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
    if (file.offset === file.size && pendingFiles.get(event.sender) === file) {
      pendingFiles.delete(event.sender);
      await file.handle.close();
    }
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (pendingFiles.get(event.sender) === file) {
      pendingPaths.delete(event.sender);
      pendingFiles.delete(event.sender);
      await file.handle.close();
    }
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
  await Promise.all(
    initialPaths.splice(0).map((file) => deliverDesignFile(file, true)),
  );
  if (!BrowserWindow.getAllWindows().length) createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
