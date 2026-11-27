# Forma MCP Streamable HTTP 与 A2A Design Agent 运行时任务清单

- **课题状态**：已实施并验收（随 v0.15.0 发布）
- **最后更新**：2026-11-27

## 阶段一：方案决策与立项
- [x] 与用户确认合并推进 Phase 1（零配置 MCP Streamable HTTP）+ Phase 2（标准 A2A Server 与画布任务收件箱）、暂不接入 Zed ACP、默认审批策略为画布提案确认（`input-required`）+ 可选信任自动落画布（支持单步 `⌘Z` 撤销）
- [x] 创建课题文档 `PRD.md`、`ENGINEERING.md`、`TASKS.md` 并登记索引

## 阶段二：三路并行 Codex CLI 施工（零文件冲突）
- [x] **Track 1（持久化会话桥 + 4 项运行时能力 + 11 工具 MCP Streamable HTTP & Stdio）**
  - [x] 新增 `server/runtime-capabilities.ts`（`listOpenTabsView`、`renderArtboardPreview`、`exportReactCode`、`runDelegatedDesignTask`）
  - [x] 升级 `server/agent-sessions.ts`（持续同步 `PUT /sync`、`proposal/ack`、`approvalMode`/`writeEnabled`、`connectedClients` 与 A2A 任务宿主状态）
  - [x] 新增 `server/mcp-tools.ts`、`server/mcp-http.ts` 并升级 `server/mcp.ts` 共用 11 工具注册工厂
  - [x] 新增 `tests/mcp-http-runtime.test.ts`（11/11 通过）覆盖全部 11 工具、Streamable HTTP 握手、安全鉴权与策略控制
- [x] **Track 2（标准 A2A Server + Agent Card + Human-in-the-Loop 状态机）**
  - [x] 新增 `server/a2a-protocol.ts` 与 `server/a2a-server.ts`（`/.well-known/agent-card.json`、JSON-RPC `message/send`/`message/stream`/`tasks/get`/`tasks/cancel`/`tasks/list`/`tasks/resubscribe`、4 大技能与 `input-required` → 设计师确认回传闭环）
  - [x] 新增 `tests/a2a-server.test.ts`（21/21 通过）覆盖离线审校/导出、人机协同审批、自动落画布、SSE 推送与取消流程
- [x] **Track 3（纯应用层配置模型 + 零配置连接中心 + 顶栏 Agent Inbox UI）**
  - [x] 新增 `src/application/external-bridge.ts` 与 `tests/external-bridge.test.ts`（9/9 通过，零 React 依赖）
  - [x] 升级 `src/editor/ExternalAgentSession.tsx` 与 `src/editor/IntegrationsModal.tsx`（一键复制 MCP HTTP / A2A 配置、实时客户端状态、只读/审阅/信任自动应用开关）
  - [x] 新增 `src/editor/AgentInboxPopover.tsx` 与 `src/editor/external-bridge.css`（`@layer panels`，0 `!important`）

## 阶段三：主干集成、全量验证、视觉实拍与 `v0.15.0` 发版
- [x] 主干集成 `server/agent-http.ts`、`vite.config.ts`、`electron/main.mjs`、`WorkspaceShell.tsx`、`App.tsx`、`layers.css`
- [x] 新增 `scripts/check-mcp-agent-runtime.browser.js` 并运行全量门禁（`format:check`、`lint:arch` 0 违规、`build`、`desktop:agent`、`npm test` 1,012/1,013 通过、11 组 Chromium E2E、导出验证与 4 张 2× Retina 深浅实拍）
- [x] 更新 `AGENT-PROTOCOL.md`、`ARCHITECTURE.md`、`VERSIONING-AND-DESKTOP.md`、`HANDOFF.md`、`EDITOR-ACCEPTANCE.md` 并执行 `v0.15.0` 自动化发版与只读挂载 DMG 实机验收
