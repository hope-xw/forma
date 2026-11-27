# Forma MCP Streamable HTTP 与 A2A Design Agent 运行时工程设计

- **状态**：已实施并验收（随 v0.15.0 发布）
- **更新日期**：2026-11-27
- **关联 PRD**：[PRD.md](PRD.md)

---

## 一、三路并行施工分工（零文件冲突矩阵）

| 施工轨道 | 覆盖模块 | 独占文件所有权 |
| --- | --- | --- |
| **Track 1 · 持久化会话桥 + 运行时核心能力 + MCP Streamable HTTP & Stdio** | 纯 Node 画板 SVG 出图 / React 工程代码导出 / 多 Tab 列表 / AI 委派能力；升级 `agent-sessions` 持久同步、审批模式与只读权限；单工厂 11 工具 MCP 注册表 + `@modelcontextprotocol/server` `createMcpHandler` Streamable HTTP 适配器 + stdio 升级 + 单测 | `server/runtime-capabilities.ts`（新）、`server/agent-sessions.ts`、`server/mcp-tools.ts`（新）、`server/mcp-http.ts`（新）、`server/mcp.ts`、`tests/mcp-http-runtime.test.ts`（新） |
| **Track 2 · 标准 A2A Server + Agent Card + Human-in-the-Loop 任务状态机** | A2A 协议 Zod Schema 与类型（`AgentCard`、`Task`、`Artifact`、JSON-RPC 2.0）；`GET /.well-known/agent-card.json` 与 `POST /api/a2a`（`message/send`、`message/stream` SSE、`tasks/get`、`tasks/cancel`、`tasks/list`）；`audit_design_system` / `design_to_react` 离线直出 + `generate_ui` / `refine_artboard` `input-required` 与 `auto-apply` 闭环 + 单测 | `server/a2a-protocol.ts`（新）、`server/a2a-server.ts`（新）、`tests/a2a-server.test.ts`（新） |
| **Track 3 · 纯应用层连接模型 + 零配置连接中心 + 顶栏 Agent Inbox UI** | 零 React 纯应用层外部连接配置生成器（Claude Code / Cursor / Codex / A2A）与收件箱状态归约；升级 `ExternalAgentSession`（持续同步 + `approvalMode` + `writeEnabled` + `auto-apply` + 任务同步）；产品化 `IntegrationsModal` + 新增 `AgentInboxPopover` + `@layer panels` 样式（0 `!important`）+ 单测 | `src/application/external-bridge.ts`（新）、`src/editor/ExternalAgentSession.tsx`、`src/editor/IntegrationsModal.tsx`、`src/editor/AgentInboxPopover.tsx`（新）、`src/editor/external-bridge.css`（新）、`tests/external-bridge.test.ts`（新） |
| **Lead 主干集成与验收轨道** | `server/agent-http.ts`、`vite.config.ts`、`electron/main.mjs` 路由接入与端口回传；`WorkspaceShell.tsx` / `App.tsx` / `layers.css` 串联跨 Tab 持久桥、Auto-Apply 单步撤销与顶栏 Agent Inbox；`scripts/check-mcp-a2a.browser.js` E2E、2× Retina 双主题实拍、文档更新与 `v0.15.0` DMG 自动化发版 | `server/agent-http.ts`、`vite.config.ts`、`electron/main.mjs`、`src/editor/WorkspaceShell.tsx`、`src/editor/App.tsx`、`src/editor/layers.css`、`scripts/*`、`docs/*` |

---

## 二、核心接口契约（严格跨轨对齐）

### 1. 持久化工作区会话契约（`server/agent-sessions.ts`）

向后兼容原有全部 `/api/agent/sessions*` 接口，并扩展以下字段与端点：

```ts
export type SessionApprovalMode = "review" | "auto-apply";

export interface SessionTabSummary {
  id: string;
  kind: "home" | "file" | "example";
  title: string;
  fileKey?: string;
  active: boolean;
}

export interface ConnectedExternalClient {
  id: string;
  name: string;
  protocol: "mcp-http" | "mcp-stdio" | "a2a";
  lastSeenAt: string;
}

export interface SessionProposalEnvelope {
  id: string;
  transaction: Transaction;
  source: "mcp" | "a2a";
  taskId?: string;
  summary?: string;
  autoApply: boolean;
  createdAt: string;
}
```

新增编辑器同步与任务控制端点（须携带 `Authorization: Bearer <key>` + `X-Forma-Editor: <editor>`）：
- `PUT /api/agent/sessions/sync`：编辑器推送 `{ document, selection, tabs?, activeTabId?, approvalMode?, writeEnabled? }`，返回 `{ ok: true, approvalMode, writeEnabled, proposal, connectedClients, tasks }`。
- `POST /api/agent/sessions/proposal/ack`：接受 `{ proposalId, status: "applied" | "discarded" }`，清空当前待处理提案而**保持持久会话不中断**。
- `POST /api/agent/sessions/tasks/:taskId/complete`：接受 `{ document?, note? }`，以最新画布重新编译 SVG 预览与 React/TS 代码 Artifact，将对应 A2A 任务推进至 `completed` 并推送 SSE 通知。
- `POST /api/agent/sessions/tasks/:taskId/reject`：接受 `{ reason? }`，将对应 A2A 任务推进至 `rejected` 并推送 SSE 通知。

### 2. 运行时核心能力契约（`server/runtime-capabilities.ts`）

纯 Node、零 DOM 依赖，供 MCP 工具与 A2A 技能共同消费：
- `listOpenTabs(tabs, doc, selection)` → `{ activeTabId, tabs, document: { id, name, revision, activePage, nodeCount }, selection }`
- `renderArtboardPreview(doc, selection, allowed, { nodeId?, scale? })` → 调用 `exportNodeToSvg(doc, targetId, scale)` 返回 `{ nodeId, nodeName, width, height, mimeType: "image/svg+xml", svg, dataUrl }`（严格校验 `allowed` 范围与尺寸上限）。
- `exportReactCode(doc, selection, allowed, { nodeId?, includeTokens?, includeComponents? })` → 调用 `unwrapSectionsAndSlices`、`exportInteractiveReact`、`exportTokenFiles`、`componentProjectFiles` 返回 `{ targetId, targetName, files: Record<string, string>, fileCount, tokenCount, componentCount }`。
- `delegateDesignTask(deps, sessionContext, input)` → 通过注入的 `runDesignGeneration` 调用 `runDesignChat` 生成并校验原子 `Transaction`；未配置模型时返回清晰 `503` 错误，绝不伪造模板结果。

### 3. MCP Streamable HTTP（`server/mcp-http.ts` + `server/mcp-tools.ts`）

- 挂载路径：`/mcp`（支持 `POST`、`GET`、`DELETE`、`OPTIONS`）。
- 基于已安装 `@modelcontextprotocol/server` v2.4.0 的 `McpServer` + `createMcpHandler(factory, { legacy: "stateless" })`，同时兼容 2026 现代协议与 2025 Streamable HTTP 客户端（Claude Code / Cursor / Codex / Antigravity）。
- 11 工具清单：`read_design`、`list_components`、`search_nodes`、`get_node_details`、`get_design_system`、`lint_design`、`list_open_tabs`、`render_artboard_preview`、`export_react_code`、`propose_design`、`delegate_design_task`。
- 安全门禁：仅允许回环 `Host`（`127.0.0.1` / `localhost` / `[::1]`），拒绝非允许来源的 `Origin`（防止 DNS Rebinding / CSRF；允许无 `Origin` 的原生 CLI/IDE 客户端），强制校验 `Authorization: Bearer <token>`（缺失或失效返 `401`），`writeEnabled === false` 时拒绝写入类工具。

### 4. A2A Server（`server/a2a-protocol.ts` + `server/a2a-server.ts`）

- 解耦适配器接口 `A2ARuntimeAdapter`，使 Track 2 与 Track 1 零文件耦合：
  - `authenticate(bearerToken)` → 返回会话视图（`sessionKey`, `document`, `selection`, `tabs`, `approvalMode`, `writeEnabled`）
  - `auditDesign(sessionKey, input)` / `exportReact(sessionKey, input)` / `renderPreview(sessionKey, input)` / `delegateGeneration(sessionKey, input)` / `enqueueProposal(sessionKey, proposal)`
  - `getTask` / `listTasks` / `saveTask` / `subscribeTask(taskId, listener)`
- 路由：
  - `GET /.well-known/agent-card.json` → 返回标准 `AgentCard`（动态填入当前 `http://127.0.0.1:<port>/api/a2a`，不含任何密钥）
  - `POST /api/a2a` → JSON-RPC 2.0 分发 `message/send`、`message/stream`（SSE `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`）、`tasks/get`、`tasks/cancel`、`tasks/list`。
- 4 大标准技能：`generate_ui`、`refine_artboard`、`audit_design_system`、`design_to_react`。

### 5. 架构边界与桌面打包约束

- `src/application/external-bridge.ts` 严格零 React/DOM/server 依赖（通过 `npm run lint:arch` 0 违规校验）。
- `src/editor/external-bridge.css` 全量归入 `@layer panels`，**0 处 `!important`**。
- `npm run desktop:agent`（`esbuild server/agent-service.ts`）须零报错打包全部 MCP HTTP 与 A2A 模块至 `out-electron/agent-service.mjs`。
- 干净启动（未配置模型、未开启外部连接）仍保持 **`0` 次 `/api/agent/*` 请求**。
