# Forma MCP Streamable HTTP 与 A2A Design Agent 运行时 PRD

- **状态**：已实施并验收（随 v0.15.0 发布）
- **启动日期**：2026-11-27
- **负责人**：Forma 产品与架构团队
- **关联长期规格**：[AGENT-PROTOCOL.md](../../AGENT-PROTOCOL.md) · [ARCHITECTURE.md](../../ARCHITECTURE.md) · [VERSIONING-AND-DESKTOP.md](../../specs/VERSIONING-AND-DESKTOP.md) · [AGENT-TOOLS-AND-SKILLS.md](../../specs/AGENT-TOOLS-AND-SKILLS.md)

---

## 一、背景与痛点

Forma 已在 `v0.13.0` / `v0.14.0` 完成全屏工作台首页、原生 `.forma` 格式、多文件顶部 Tab 工作台与内置 Design Agent 能力，但当前的外部 Agent 集成仍停留在早期研发原型阶段，存在三处明显产品断层：

1. **桌面安装包不可用**：当前「外部工具集成」弹窗要求用户复制 `FORMA_SESSION` 并在源码目录运行 `npm run mcp`；通过 `.dmg` 安装的桌面端用户根本没有源码目录。
2. **一次性断链**：`ExternalAgentSession` 在收到单次提案后自动关闭配对会话，多轮迭代或切换 Tab 需要反复重新连接与复制密钥。
3. **缺少 Design Agent 级能力与标准 Agent-to-Agent 协作**：外部 Coding Agent（Claude Code / Codex / Cursor / 总控编排 Agent）目前只能读取图层或手工拼接底层节点事务 JSON，无法直接获取画板渲染图、直接拉取 Forma 编译器生成的 React/TS 代码，也无法将高阶设计需求通过标准协议委派给 Forma Design Agent，并在「设计师画布精修 → 确认回传」的人机协同闭环中拿回最终交付物。

---

## 二、已确认的产品决策与核心目标

经用户确认，本期合并推进 **Phase 1（零配置 MCP Streamable HTTP 升级）+ Phase 2（标准 A2A Design Agent 运行时与画布任务收件箱）**：

1. **零配置本机 MCP Streamable HTTP（彻底告别 `npm run mcp`）**
   - 在 `agent-service`（桌面内置服务 & Web 开发/预览服务共用）直接暴露标准 MCP Streamable HTTP 端点（`http://127.0.0.1:<port>/mcp`），一次开启长期有效、跨 Tab 与切页自动跟随当前活跃画稿（不再收到一次提案就断链）。
   - 同时保留既有 `server/mcp.ts` stdio 入口并与 HTTP 共用同一工具注册工厂，保障历史脚本与 `check-mcp` 回归 100% 兼容。
   - 工具集从 7 个基础接口升级为 **11 个完整设计运行时工具**：
     - 既有 7 工具：`read_design`、`list_components`、`search_nodes`、`get_node_details`、`get_design_system`、`lint_design`、`propose_design`；
     - 新增 4 工具：`list_open_tabs`（多 Tab 感知）、`render_artboard_preview`（离线 SVG 画板渲染图）、`export_react_code`（真实 Forma 编译器输出 React + TypeScript + CSS Tokens 代码）、`delegate_design_task`（向 Forma 内置 Design Agent 委派高阶自然语言设计任务）。
2. **标准 A2A（Agent2Agent）Server 与画布人机协同闭环**
   - 暴露标准 `GET /.well-known/agent-card.json`（声明 Forma Design Agent 身份、认证方式与 4 大技能：`generate_ui` / `refine_artboard` / `audit_design_system` / `design_to_react`）与 `POST /api/a2a` JSON-RPC 2.0 端点（支持 `message/send`、`message/stream` SSE、`tasks/get`、`tasks/cancel`、`tasks/list`）。
   - **离线可用 + 人机协同**：`audit_design_system` 与 `design_to_react` 无需配置模型即可离线即时完成并返回结构化 Artifact；`generate_ui` / `refine_artboard` 写入画布时默认进入 **`input-required`**（待设计师审阅确认），通过编辑器顶栏轻量 **「外部任务收件箱（Agent Inbox）」** 让设计师预览、在活画布直接拖改排版或文案后点击 **「确认并回传产物」**，实时基于最新画布编译 SVG 预览图 + React/TS 代码 + `.forma` 元数据回传给上游 Agent。
3. **显式分级权限与默认安全写入审批策略（用户已确认）**
   - 会话支持切换 **只读模式**（仅允许读取、检查、出图、导出 React）或 **允许写入提案**。
   - 允许写入时，**默认进入「画布提案待设计师确认」（A2A 进入 `input-required`）**；同时允许用户在连接中心对受信任会话手动开启 **「自动落画布（仍保留单步 `⌘Z` 撤销）」**，方便自动化联调与高频协作。
4. **设计师友好的零配置连接中心与零打扰离线基线**
   - 升级 `IntegrationsModal`：提供实时运行状态、已连接客户端列表、权限与审批开关、一键复制 Claude Code / Cursor / Codex（MCP HTTP）与 A2A 接入配置，并将命令行 stdio 与手动 JSON 事务收纳至折叠高级区。
   - **硬约束**：未开启外部连接且未配置模型时，冷启动仍严格保持 **`0` 次 `/api/agent/*` 网络请求**，且所有外部服务端口严格绑定本机回环 `127.0.0.1` + Bearer Token + Origin/Host 防护。

---

## 三、明确不做 / 下期范围

- **暂不接入 Zed ACP**（侧栏直连本机 Claude Code / Codex / Gemini CLI 作为对话引擎），留作后续「免 API Key 复用本机订阅」可选扩展。
- **暂不做 MCP Client**（Forma 内置 AI 反向调用外部 Notion / Figma / 云端生图 MCP 工具），作为 Phase 3 独立推进。
- **暂不开放公网/局域网远程监听与多用户 OAuth**：本期所有 MCP/A2A 端点严格限定本机回环 `127.0.0.1` 与会话级 Bearer Token。

---

## 四、验收标准

1. 未配置模型且未开启外部连接启动 Forma，网络监控记录 `0` 次 `/api/agent/*` 请求。
2. 在「外部工具集成」中一键开启本机服务，展示真实 `http://127.0.0.1:<port>/mcp` 与 `/api/a2a` 接入信息，复制配置即可通过标准 Streamable HTTP MCP 客户端完成握手、列出全部 11 个工具，并验证 `list_open_tabs`、`render_artboard_preview`、`export_react_code`、`propose_design` 与切 Tab 持久不断链。
3. 通过标准 A2A 协议请求 `GET /.well-known/agent-card.json`、离线调用 `audit_design_system` / `design_to_react`、派发画布变更任务触发 `input-required` → 设计师在顶栏 Agent Inbox 预览、应用并手工修改图层文字 → 点击「确认并回传产物」→ 上游通过 `tasks/get` 与 SSE 收到包含修改后画布的 React/TS 代码与 SVG 预览 Artifact；并验证开启「自动落画布」后自动应用且支持单步 `⌘Z` 撤销。
4. 只读模式阻断所有写入工具/任务；无效 Token 或恶意浏览器 `Origin` 返回 `401`/`403`；既有 `check-mcp`（stdio）、`multi-tab`、`workspace-home` 与 macOS 只读挂载 DMG 实机验收全绿。
