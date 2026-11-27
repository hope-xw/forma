import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { act, createElement, StrictMode, useState } from "react";
import { inferModelCapabilities } from "../src/agent/capabilities";
import { createLibraryFromSelection } from "../src/domain/library";
import { createStarter } from "../src/domain/seed";
import {
  AGENT_CONFIGURED_HINT_KEY,
  deleteProviderProfile,
  fetchAgentStatus,
  hasConfiguredAgentHint,
  saveProviderProfile,
  updateProviderProfile,
  type AgentStatusResponse,
  type MaskedProviderProfile,
} from "../src/editor/agent-client";
import {
  compactModelLabel,
  FIXED_PROGRESS_LABELS,
  formatOperationType,
  formatTierSummary,
  formatToolName,
  HTML_COMPILE_PROGRESS,
  VISUAL_CRITIQUE_PROGRESS,
} from "../src/editor/agent/agent-copy";

test("agent copy helpers translate technical terms into designer language", () => {
  assert.equal(formatOperationType("create"), "新增");
  assert.equal(formatOperationType("update"), "调整");
  assert.equal(formatOperationType("insertComponent"), "插入组件");
  assert.equal(formatOperationType("putToken"), "更新样式变量");
  assert.equal(formatOperationType("unknown_future_op"), "变更");

  assert.equal(formatToolName("get_canvas_overview"), "查看画布概览");
  assert.equal(formatToolName("propose_html_design"), "生成精细画板方案");
  assert.equal(formatToolName("search_project_episodes"), "检索项目历史设计");
  assert.equal(formatToolName("custom_tool"), "custom_tool");

  assert.equal(
    formatTierSummary({ page: 1, block: 1, component: 2 }),
    "规范已就绪 · 1 个页面模板 · 1 个模块 · 2 个组件",
  );
  assert.equal(
    formatTierSummary({ page: 0, block: 0, component: 5 }),
    "规范已就绪 · 5 个组件",
  );
  assert.equal(
    formatTierSummary({ page: 0, block: 0, component: 0 }),
    "组件库规范已就绪",
  );

  assert.equal(
    compactModelLabel("anthropic/claude-sonnet-4-5"),
    "claude-sonnet-4-5",
  );
  assert.equal(
    compactModelLabel("deepseek-flash", "DeepSeek-V4.1-Flash"),
    "DeepSeek-V4.1-Flash",
  );
  assert.ok(
    compactModelLabel("a-very-long-model-identifier-v99-preview").endsWith("…"),
  );

  // Progress labels avoid raw engineering jargon like "事务" or "沙盒"
  for (const label of [
    ...Object.values(FIXED_PROGRESS_LABELS),
    HTML_COMPILE_PROGRESS,
    VISUAL_CRITIQUE_PROGRESS,
  ]) {
    assert.doesNotMatch(label, /事务|沙盒|多模态/);
  }
});

function domTestHost(t: TestContext) {
  const hooks = registerHooks({
    load(url, context, next) {
      return url.endsWith(".css")
        ? { format: "module", source: "", shortCircuit: true }
        : next(url, context);
    },
  });
  t.after(() => hooks.deregister());

  const doc = new DOMParser().parseFromString("<html/>", "text/html");
  const makeElement = doc.createElement.bind(doc);
  const makeElementNS = doc.createElementNS.bind(doc);
  const noop = () => {};
  const forReact = (element: Element) =>
    Object.assign(element, {
      style: { setProperty: noop },
      querySelectorAll: () => [],
      addEventListener: noop,
      removeEventListener: noop,
      focus: noop,
      scrollIntoView: noop,
    });
  t.mock.method(doc, "createElement", (name: string) => {
    const el = forReact(makeElement(name));
    if (name === "select")
      Object.defineProperty(el, "options", {
        get: () => el.getElementsByTagName("option"),
      });
    if (name === "option")
      Object.defineProperty(el, "value", {
        get: () => el.getAttribute("value"),
      });
    return el;
  });
  t.mock.method(doc, "createElementNS", (ns: string, name: string) =>
    forReact(makeElementNS(ns, name)),
  );
  doc.addEventListener = noop;
  doc.removeEventListener = noop;
  const host = doc.createElement("div");
  const events = new EventTarget();
  host.addEventListener = events.addEventListener.bind(events);
  const stored = new Map<string, string>();
  const globals = {
    document: doc,
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
    window: Object.assign(new EventTarget(), {
      document: doc,
      HTMLIFrameElement: class {},
    }),
    requestAnimationFrame: (fn: FrameRequestCallback) => fn(0),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const before = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, globals);
  t.after(() => {
    for (const key of Object.keys(globals)) {
      if (before[key]) Object.defineProperty(globalThis, key, before[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    host,
    click(element: Element) {
      const event = new Event("click", { bubbles: true });
      Object.defineProperty(event, "target", { value: element });
      events.dispatchEvent(event);
    },
  };
}

test("unconnected AgentPanel and CanvasAgentBar avoid duplicate nags and raw technical clutter", async (t) => {
  const { host } = domTestHost(t);
  const { AgentPanel } = await import("../src/editor/AgentPanel");
  const { CanvasAgentBar } = await import("../src/editor/CanvasAgentBar");
  const { Fragment } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const doc = createStarter();
  const library = createLibraryFromSelection(
    doc,
    doc.nodes[0].id,
    "产品组件库",
  );
  doc.libraries = { [library.id]: library };
  const project = {
    id: "test-project",
    name: "测试项目",
    defaultLibraryId: library.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const noop = () => {};
  const status = null;
  const requests = t.mock.method(globalThis, "fetch", async () => {
    throw Error("Unexpected request");
  });
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(
          Fragment,
          null,
          createElement(AgentPanel, {
            document: doc,
            activeProject: project,
            projectEpisodes: [],
            selection: null,
            selectionCount: 0,
            status,
          }),
          createElement(CanvasAgentBar, {
            open: true,
            onClose: noop,
            document: doc,
            selection: null,
            selectionCount: 0,
            viewportCenter: { x: 420, y: 310 },
            status,
            pendingProposal: null,
            busy: false,
            progressText: "",
            error: "",
            onOpenConfig: noop,
            onSendPrompt: noop,
            onCancel: noop,
            onApplyProposal: noop,
            onDiscardProposal: noop,
            onOpenFullChat: noop,
          }),
        ),
      ),
    );
    const text = host.textContent ?? "";
    // Sidebar hides draft storage jargon ("单稿记忆 0 条档案") and keeps only one "未连接模型"
    assert.doesNotMatch(text, /单稿记忆|0 条档案|外部 Agent \/ 事务导入/);
    assert.equal(text.match(/未连接模型/g)?.length, 1);
    assert.equal(requests.mock.callCount(), 0);
    assert.doesNotMatch(
      host.toString(),
      /创作设置|生成方式|生成引擎模式|开发者接入|生成后自动视觉优化|视觉自审精修/,
    );
    const skills = byLabel(host, "button", "管理设计技能（Skills）");
    assert.equal(skills.hasAttribute("disabled"), false);
    assert.equal(
      (skills.parentNode as Element).getAttribute("class"),
      "agent-header-actions",
    );
    const composer = Array.from(host.getElementsByTagName("div")).find((el) =>
      el.getAttribute("class")?.split(" ").includes("agent-composer-actions"),
    );
    assert.ok(composer);
    const selector = byLabel(composer, "select", "目标组件库");
    assert.equal(selector.options[1].selected, true);
    assert.equal(selector.options[1].textContent, library.name);
    assert.equal(selector.options[0].textContent, "自动匹配");
    // Canvas bar removes raw pixel coordinates and duplicate "未配置模型 · 点击连接" pill
    assert.doesNotMatch(text, /\(420,\s*310\)|未配置模型 · 点击连接/);
  } finally {
    await act(async () => root.unmount());
  }
});

function byLabel<K extends keyof HTMLElementTagNameMap>(
  root: Element,
  tag: K,
  label: string,
) {
  const element = Array.from(root.getElementsByTagName(tag)).find(
    (el) => el.getAttribute("aria-label") === label,
  );
  assert.ok(element, label);
  return element;
}

const profile: MaskedProviderProfile = {
  id: "local",
  providerId: "openai",
  providerName: "OpenAI",
  label: "工作模型",
  selectedModel: "gpt-4.1",
  models: [],
  protocol: "openai-chat",
  capabilities: inferModelCapabilities("openai", "openai-chat", "gpt-4.1"),
  baseUrl: "",
  maskedKey: "****",
  source: "saved",
  updatedAt: "2026-11-26",
};
const configuredStatus: AgentStatusResponse = {
  activeProfile: profile,
  activeProfileId: profile.id,
  profiles: [profile],
  configured: true,
};
const emptyStatus: AgentStatusResponse = {
  activeProfile: null,
  activeProfileId: null,
  profiles: [],
  configured: false,
};

for (const hint of ["localStorage", "desktop startup", "desktop preflight"]) {
  test(
    hint + " restores the model and enabled skills on mount and across files",
    async (t) => {
      const { host } = domTestHost(t);
      const { AgentPanel } = await import("../src/editor/AgentPanel");
      const { createRoot } = await import("react-dom/client");
      if (hint === "localStorage")
        localStorage.setItem(AGENT_CONFIGURED_HINT_KEY, "1");
      else
        Object.assign(window, {
          formaDesktop:
            hint === "desktop startup"
              ? { agentConfigured: true }
              : { hasConfiguredAgent: async () => true },
        });
      const requests: string[] = [];
      t.mock.method(globalThis, "fetch", async (url: string) => {
        requests.push(url);
        if (url === "/api/agent/status") return Response.json(configuredStatus);
        assert.equal(url, "/api/agent/skills");
        return Response.json({
          skills: [
            { id: "brand", enabled: true, name: "品牌排版" },
            { id: "draft", enabled: false, name: "草稿技能" },
          ],
        });
      });
      function File({ doc }: { doc: ReturnType<typeof createStarter> }) {
        const [status, onStatusChange] = useState<AgentStatusResponse | null>(
          null,
        );
        return createElement(AgentPanel, {
          document: doc,
          fileKey: doc.id,
          activeProject: null,
          projectEpisodes: [],
          selection: null,
          selectionCount: 0,
          status,
          onStatusChange,
        });
      }
      const root = createRoot(host);
      try {
        for (let index = 1; index <= 2; index++) {
          const doc = createStarter();
          await act(async () =>
            root.render(
              createElement(
                StrictMode,
                null,
                createElement(File, { key: doc.id, doc }),
              ),
            ),
          );
          assert.equal(
            byLabel(host, "select", "切换当前模型").options[0].textContent,
            profile.selectedModel,
          );
          assert.match(host.textContent ?? "", /品牌排版/);
          assert.doesNotMatch(host.textContent ?? "", /未连接模型|草稿技能/);
          assert.deepEqual(requests.slice((index - 1) * 2), [
            "/api/agent/status",
            "/api/agent/skills",
          ]);
        }
      } finally {
        await act(async () => root.unmount());
      }
    },
  );
}

test("a mounted file rehydrates when its controlled status resets, and ignores a superseded read", async (t) => {
  const { host } = domTestHost(t);
  const { AgentPanel } = await import("../src/editor/AgentPanel");
  const { createRoot } = await import("react-dom/client");
  localStorage.setItem(AGENT_CONFIGURED_HINT_KEY, "1");
  const doc = createStarter();
  const onStatusChange = t.mock.fn();
  let finishRead!: (response: Response) => void;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests.push(url);
    if (url === "/api/agent/skills") return Response.json({ skills: [] });
    assert.equal(url, "/api/agent/status");
    return new Promise<Response>((resolve) => {
      finishRead = resolve;
    });
  });
  const root = createRoot(host);
  const render = (status: AgentStatusResponse | null) =>
    act(async () =>
      root.render(
        createElement(AgentPanel, {
          document: doc,
          selection: null,
          selectionCount: 0,
          activeProject: null,
          projectEpisodes: [],
          status,
          onStatusChange,
        }),
      ),
    );
  try {
    await render(configuredStatus);
    await render(null);
    assert.deepEqual(requests, ["/api/agent/skills", "/api/agent/status"]);
    assert.doesNotMatch(host.textContent ?? "", /未连接模型/);
    await render(configuredStatus);
    await act(async () => finishRead(Response.json(emptyStatus)));
    assert.equal(onStatusChange.mock.callCount(), 0);
    assert.equal(hasConfiguredAgentHint(), true);
    assert.equal(
      byLabel(host, "select", "切换当前模型").options[0].textContent,
      profile.selectedModel,
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test("fresh desktop, rejected preflight and cleared stale hint stay offline", async (t) => {
  const { host } = domTestHost(t);
  const { AgentPanel } = await import("../src/editor/AgentPanel");
  const { createRoot } = await import("react-dom/client");
  const requests = t.mock.method(globalThis, "fetch", async () =>
    Response.json(emptyStatus),
  );
  const root = createRoot(host);
  async function openFile() {
    const doc = createStarter();
    await act(async () =>
      root.render(
        createElement(AgentPanel, {
          key: doc.id,
          document: doc,
          fileKey: doc.id,
          activeProject: null,
          projectEpisodes: [],
          selection: null,
          selectionCount: 0,
        }),
      ),
    );
    assert.equal(host.textContent?.match(/未连接模型/g)?.length, 1);
  }
  try {
    for (const hasConfiguredAgent of [
      async () => false,
      async () => {
        throw Error("IPC closed");
      },
    ]) {
      Object.assign(window, { formaDesktop: { hasConfiguredAgent } });
      await openFile();
      assert.equal(requests.mock.callCount(), 0);
    }
    localStorage.setItem(AGENT_CONFIGURED_HINT_KEY, "1");
    await openFile();
    assert.equal(requests.mock.callCount(), 1);
    assert.equal(hasConfiguredAgentHint(), false);
    await openFile();
    assert.equal(requests.mock.callCount(), 1);
  } finally {
    await act(async () => root.unmount());
  }
});

test("profile mutation and status responses maintain the non-sensitive configured hint", async (t) => {
  domTestHost(t);
  let status = configuredStatus;
  t.mock.method(globalThis, "fetch", async (url: string) =>
    Response.json(
      url.endsWith("/status") ? status : { status, profile, deleted: true },
    ),
  );
  await saveProviderProfile({
    providerId: "openai",
    selectedModel: profile.selectedModel,
  });
  assert.equal(localStorage.getItem(AGENT_CONFIGURED_HINT_KEY), "1");
  localStorage.removeItem(AGENT_CONFIGURED_HINT_KEY);
  await updateProviderProfile(profile.id, {
    selectedModel: profile.selectedModel,
  });
  assert.equal(hasConfiguredAgentHint(), true);
  status = emptyStatus;
  await deleteProviderProfile(profile.id);
  assert.equal(localStorage.getItem(AGENT_CONFIGURED_HINT_KEY), null);
  status = configuredStatus;
  await fetchAgentStatus();
  assert.equal(hasConfiguredAgentHint(), true);
  status = { ...emptyStatus, configured: true };
  await fetchAgentStatus();
  assert.equal(hasConfiguredAgentHint(), false);
});

test("MCP pairing survives closing the integrations dialog and delivers a scoped preview to the canvas", async (t) => {
  const { host, click } = domTestHost(t);
  const { IntegrationsModal } = await import("../src/editor/IntegrationsModal");
  const { createRoot } = await import("react-dom/client");
  const doc = createStarter();
  const transaction = {
    baseRevision: doc.revision,
    operations: [
      { type: "update", id: doc.nodes[0].id, patch: { name: "已配对画板" } },
    ],
  };
  let deliver!: (response: Response) => void;
  const poll = new Promise<Response>((resolve) => {
    deliver = resolve;
  });
  const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    methods.push(init.method ?? "GET");
    if (url.endsWith("/sync") || url.endsWith("/proposal")) return poll;
    assert.equal(url, "/api/agent/sessions");
    return Response.json({ key: "test-pair", editor: "editor" });
  });
  const receive = t.mock.fn();
  const root = createRoot(host);
  const render = (open: boolean) =>
    act(async () =>
      root.render(
        createElement(IntegrationsModal, {
          open,
          onClose() {},
          document: doc,
          selection: null,
          scopeProjectId: "file:design",
          onPendingProposalChange: receive,
        }),
      ),
    );
  try {
    await render(false);
    const backdrop = host.firstChild as Element;
    const dialog = byLabel(host, "div", "外部工具集成");
    const pair = Array.from(dialog.getElementsByTagName("button")).find(
      (el) => el.textContent === "连接外部 Agent",
    );
    assert.ok(pair);
    assert.ok(backdrop.hasAttribute("hidden"));
    assert.deepEqual(methods, []);
    await render(true);
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.equal(
      dialog.getElementsByTagName("details")[0].hasAttribute("open"),
      false,
    );
    await act(async () => click(pair));
    const sessionKey = byLabel(dialog, "input", "MCP 会话密钥");
    await render(false);
    assert.ok(backdrop.hasAttribute("hidden"));
    assert.equal(dialog.hasAttribute("aria-modal"), false);
    assert.equal(byLabel(dialog, "input", "MCP 会话密钥"), sessionKey);
    assert.deepEqual(methods, ["POST", "PUT"]);
    await act(async () =>
      deliver(
        Response.json({
          ok: true,
          approvalMode: "review",
          writeEnabled: true,
          proposal: { id: "prop-1", source: "mcp", transaction },
          connectedClients: [],
          tasks: [],
        }),
      ),
    );
    // Persistent sessions stay alive after delivering a proposal instead of auto-closing.
    assert.deepEqual(methods, ["POST", "PUT"]);
    assert.equal(byLabel(dialog, "input", "MCP 会话密钥").value, "test-pair");
    assert.equal(receive.mock.callCount(), 1);
    const [proposal] = receive.mock.calls[0].arguments;
    assert.equal(proposal.scopeProjectId, "file:design");
    assert.equal(proposal.source, "external");
    assert.deepEqual(proposal.transaction.operations, transaction.operations);
    assert.notEqual(doc.nodes[0].name, "已配对画板");
  } finally {
    await act(async () => root.unmount());
  }
});
