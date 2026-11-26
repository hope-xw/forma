import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import { createStarter } from "../src/domain/seed";
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
      options: [],
      addEventListener: noop,
      removeEventListener: noop,
      focus: noop,
      scrollIntoView: noop,
    });
  t.mock.method(doc, "createElement", (name: string) =>
    forReact(makeElement(name)),
  );
  t.mock.method(doc, "createElementNS", (ns: string, name: string) =>
    forReact(makeElementNS(ns, name)),
  );
  doc.addEventListener = noop;
  const host = doc.createElement("div");
  const events = new EventTarget();
  host.addEventListener = events.addEventListener.bind(events);
  const globals = {
    document: doc,
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
  return { host };
}

test("unconnected AgentPanel and CanvasAgentBar avoid duplicate nags and raw technical clutter", async (t) => {
  const { host } = domTestHost(t);
  const { AgentPanel } = await import("../src/editor/AgentPanel");
  const { CanvasAgentBar } = await import("../src/editor/CanvasAgentBar");
  const { createElement, act, Fragment } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const doc = createStarter();
  const noop = () => {};
  const status = {
    configured: false,
    activeProfile: null,
    activeProfileId: null,
    profiles: [],
  };
  const root = createRoot(host);
  try {
    await act(() =>
      root.render(
        createElement(
          Fragment,
          null,
          createElement(AgentPanel, {
            document: doc,
            activeProject: null,
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
    // Canvas bar removes raw pixel coordinates and duplicate "未配置模型 · 点击连接" pill
    assert.doesNotMatch(text, /\(420,\s*310\)|未配置模型 · 点击连接/);
  } finally {
    await act(() => root.unmount());
  }
});
