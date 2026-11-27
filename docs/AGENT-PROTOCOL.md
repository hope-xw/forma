# Agent 事务协议、零配置 MCP HTTP 与 A2A 运行时

**2026-11-27 增量（零配置本机 MCP Streamable HTTP、11 工具设计运行时与标准 A2A 人机协同 Server）**　外部工具集成升级为持久化跨 Tab 工作区连接桥（[server/agent-sessions.ts](../server/agent-sessions.ts) `PUT /api/agent/sessions/sync`、`POST /proposal/ack`、2 小时滑动保活，应用或丢弃单次提案不断链）：
- **零配置 MCP Streamable HTTP（`/mcp`）与共用 11 工具注册表**：[server/mcp-http.ts](../server/mcp-http.ts)、[server/mcp-tools.ts](../server/mcp-tools.ts) 与 [server/mcp.ts](../server/mcp.ts) 基于 `@modelcontextprotocol/server` v2.4.0 共用同一工具工厂，桌面安装包无需源码目录即可直接提供 `http://127.0.0.1:<port>/mcp`（强制回环 Host、Origin 校验与 `Authorization: Bearer <token>`）。工具集由 7 项扩展至 **11 项**：既有 7 项（`read_design`、`list_components`、`search_nodes`、`get_node_details`、`get_design_system`、`lint_design`、`propose_design`）+ 新增 4 项运行时能力（[server/runtime-capabilities.ts](../server/runtime-capabilities.ts)）：`list_open_tabs`、`render_artboard_preview`（纯 Node 离线 SVG 出图）、`export_react_code`（真实 Forma 编译器输出 React/TSX/CSS Tokens）、`delegate_design_task`（委派内置 Design Agent）。
- **标准 A2A（Agent2Agent）Server 与画布人机协同**：[server/a2a-protocol.ts](../server/a2a-protocol.ts) 与 [server/a2a-server.ts](../server/a2a-server.ts) 暴露 `GET /.well-known/agent-card.json` 与 `POST /api/a2a` JSON-RPC 2.0 / SSE（`message/send`、`message/stream`、`tasks/get`、`tasks/cancel`、`tasks/list`、`tasks/resubscribe`），声明 `generate_ui`、`refine_artboard`、`audit_design_system`、`design_to_react` 4 大技能；`audit_design_system` 与 `design_to_react` 零模型完全离线可用，写画布任务默认进入 `input-required` 并推送至顶栏轻量 **外部 Agent 任务收件箱**（[AgentInboxPopover.tsx](../src/editor/AgentInboxPopover.tsx)），支持设计师在活画布应用、自由修改图层后再点击「确认并回传产物」，实时编译最新画布的 SVG 预览图与 React/TS 代码回传上游。
- **权限与审批策略**：在产品化连接中心（[IntegrationsModal.tsx](../src/editor/IntegrationsModal.tsx)、[ExternalAgentSession.tsx](../src/editor/ExternalAgentSession.tsx)、[external-bridge.ts](../src/application/external-bridge.ts)）提供一键复制 Claude Code / Cursor / Codex / A2A 接入配置、实时客户端状态、**只读 / 允许写入**开关及 **默认提案审阅（推荐） / 受信任会话自动落画布（支持 `⌘Z` 单步撤销）** 策略切换。未开启外部连接时冷启动严格保持 `0` 次 `/api/agent/*` 请求。复验入口：`npm run test:browser -- mcp-agent-runtime mcp`。[课题文档](initiatives/2026-11-27-mcp-a2a-design-agent-runtime/PRD.md)

最近更新 2026-11-27。除既有的 [HTTP 配对服务](../server/index.ts)与升级版 11 工具 [MCP stdio 入口](../server/mcp.ts) 外，内置多模型接入已升级为「先选供应商再填 Key」显式流程、五层模型能力解析管道（实时 `/models` 元数据 + 内置目录 + 用户覆写），以及基于三协议原生 Function Calling 的多轮设计工具循环与 `SKILL.md` 开放标准第三方 Skill 引擎。详见[多模型配置、能力识别与画布对话设计规格](specs/AGENT-PROVIDER-AND-CANVAS-CHAT.md)与[Forma Agent 原生工具调用与第三方 Skill 生态规格](specs/AGENT-TOOLS-AND-SKILLS.md)。

画布工具调用在事务通过选区校验后保留同一份影子文档。模型可用成功回执的 `createdRootIds` 继续查询图层，并按 `lintSummary` 决定是否复查。设计师采纳后才写入画布。[影子提案及回执字段](specs/AGENT-TOOLS-AND-SKILLS.md)

Web 开发/预览服务（[vite.config.ts](../vite.config.ts)）与 Electron 桌面端（[electron/main.mjs](../electron/main.mjs)）均内置回环 `/api/agent/*` 路由（存在兼容的独立 `npm run dev:agent` 监听时优先转发），密钥仅保存于本机 `0600` 配置文件且响应全脱敏。未配置任何模型时，手动设计与外部 MCP 配对仍保持零外部模型请求。

0.5.1 安装版与网页版均可使用本机可选 Agent 服务（`npm run dev:agent`）。桌面编辑器将状态、生成、会话与提案请求发往环回地址，默认端口 5174；服务识别 `forma://app` 来源。显式设置 `DEV_ORIGINS` 时须包含实际使用的编辑器来源。网关留空仍可进行外部配对、审阅、应用及撤销。

复验时启动 Web 编辑器及 `npm run dev:agent`，执行 `npm run test:browser -- mcp`。此项检查真实 stdio 握手、限定范围、提案、应用和撤销。

从 Agent 面板导出上下文取得 document 和 selection。请求提供最新 document.revision，以 operations 数组执行原子事务。失败时整个文档保持原状。

```json
{
  "baseRevision": 0,
  "operations": [
    {"type":"update","id":"读取到的节点 ID","patch":{"text":"新标题"},"style":{"fontSize":28}}
  ]
}
```

支持 create(node)、update(id, patch, style)、move(id, parentId)、remove(id)。完整输入模型在 src/domain/commands.ts。create 必须传完整合法节点，不能依赖未定义默认值。

Agent 提案已强制限定选区及后代，拒绝范围外增改删及移动；尚未校验生产身份、幂等请求或记录作者；因此不能直接开放成网络写入 API。后续服务层必须补齐 documentId、transactionId、actor、允许范围、权限与幂等校验，再开放生产级远程写入服务。

锁定节点不允许修改，可显式解除锁定。当前普通节点 locked 不代表安全权限；它只是编辑约束。删除容器包含锁定子层时整体拒绝。

## 组件库调用

在资源面板点击“供 Agent 使用”后，可提交以下操作。ID 从 componentCatalog 读取，position 是文档世界坐标。实例化在事务内展开为原生节点，同一事务只增加一次 revision；选区内任务仍禁止在选区外创建实例。

```json
{"type":"insertComponent","libraryId":"forma-mobile-v1","componentId":"toggle","variantId":"Light-On-Default","parentId":"当前选区 Frame ID","position":{"x":80,"y":120}}
```

发送给兼容模型的上下文使用 componentCatalog 代替完整库模板，以降低上下文大小。服务端保留原库做解析和校验。putLibrary 为文档级操作，选区任务不得修改全局库。模型端点未配置时不声称已实测自然语言生成。
