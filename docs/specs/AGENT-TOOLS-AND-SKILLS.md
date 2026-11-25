# Forma Agent 原生工具调用与第三方 Skill 生态规格

- **最近更新日期**：2026-11-24
- **状态**：已实施并验收（Phase 1：原生 Tool-Calling 闭环 + 增强编译器 + `SKILL.md` 开放标准引擎 + 7 工具外部 MCP Server；Phase 2 第三方 MCP Client 为规划蓝图，非本期已完成项）
- **关联源码**：
  - 协议适配器与原生工具调用：[adapters.ts](../../src/agent/adapters.ts)、[forma-tools.ts](../../src/agent/forma-tools.ts)、[design-engine.ts](../../src/agent/design-engine.ts)
  - 上下文与增强蓝图编译：[context-builder.ts](../../src/agent/context-builder.ts)、[blueprint-compiler.ts](../../src/agent/blueprint-compiler.ts)
  - 第三方 Skill 开放标准引擎：[skills.ts](../../src/agent/skills.ts)、[skill-registry.ts](../../server/skill-registry.ts)
  - 外部 MCP Server 与会话桥接：[mcp.ts](../../server/mcp.ts)、[agent-sessions.ts](../../server/agent-sessions.ts)、[agent-http.ts](../../server/agent-http.ts)
  - 编辑器界面：[AgentPanel.tsx](../../src/editor/AgentPanel.tsx)、[CanvasAgentBar.tsx](../../src/editor/CanvasAgentBar.tsx)、[SkillsModal.tsx](../../src/editor/SkillsModal.tsx)
- **相关规格**：[多模型配置、能力识别与画布对话设计规格](AGENT-PROVIDER-AND-CANVAS-CHAT.md) · [Agent 事务协议](../AGENT-PROTOCOL.md) · [系统架构](../ARCHITECTURE.md)
- **验收方式**：单测 `tests/agent-tools.test.ts`、`tests/agent-skills.test.ts`、`tests/agent-blueprint.test.ts`、`tests/agent-http-integration.test.ts` + 浏览器实测 `npm run test:browser -- agent-canvas-chat mcp`

---

## 一、背景与业界架构对照

当 Forma 接入真实大模型（OpenAI / Claude / Gemini / DeepSeek / Kimi / Qwen 等）后，单靠「把截断的 JSON 上下文塞给模型，让模型一次性吐出整份设计 JSON」无法在真实复杂设计稿中稳定工作：

1. **截断盲区**：单页超 300 图层、120 变量、80 样式或 290 组件变体（如 Forma Mobile 库）时，模型根本看不到被截断的图层、组件和 Token。
2. **静默丢弃黑盒**：旧编译器对查无此 ID 的组件/样式/变量直接 `continue` 静默跳过，模型误以为调用成功，设计师看到的是空框或未绑定样式。
3. **无法复用外部专业设计知识**：设计师团队的规范手册、无障碍标准、品牌系统指南、社区设计 Skill 无法以标准化方式被模型按需加载。

### 业界标杆参考对照

| 参考方案 | 核心范式 | Forma 采纳与结合方式 |
| --- | --- | --- |
| **Pencil.dev MCP** | 读写分离 + 批量工具循环（`get_editor_state` / `batch_get` / `get_style_guide` / `batch_design`） | Forma 内置多轮原生 Tool-Calling 循环：按需探索画布/组件/样式 → 批量编译提交原子事务 → 诊断回传自修复 |
| **Figma Official MCP** | Design System First + 分级大纲读取 + 结构化读写工具 | 先读轻量概览再按需钻取节点详情；优先复用 `designSystem` 变量/样式与已安装组件库，杜绝硬编码漂移 |
| **Penpot MCP** | 精简高杠杆工具面 + 校验反馈 | 控制内置工具在 10 个高内聚工具内，避免几十个细碎工具稀释模型选择准确率 |
| **Agent Skills 开放标准（`agentskills.io` / `SKILL.md`）** | 目录化 `SKILL.md`（YAML frontmatter + Markdown）+ 三层渐进式披露（L1 目录 / L2 正文 / L3 参考资源） | 原生支持本地与社区标准 `SKILL.md`（兼容发现 `~/.forma/skills/`、项目 `.forma/skills/` 及可选 `~/.agents/skills/`、`~/.claude/skills/`、`~/.codex/skills/`、`~/.cursor/skills/`） |
| **MCP 双向协议** | MCP Server 供外部 Agent 操控；MCP Client 接入外部三方工具 | **本期已实施**：内置模型原生工具循环 + 升级外部 MCP Server（7 工具）+ 本地/三方 `SKILL.md` 引擎；**下期演进**：Forma 作为 MCP Client 挂载外部三方 MCP 工具服务（见第六节蓝图） |

---

## 二、Forma 原生多轮 Tool-Calling 引擎

### 2.1 三协议统一 Tool Use 抽象（`src/agent/adapters.ts`）

- 扩展 `UnifiedModelAdapter` 请求与响应模型：
  - `AdapterToolDefinition`: `{ name: string; description: string; parameters: Record<string, unknown> }`
  - `AdapterToolCall`: `{ id: string; name: string; arguments: string }`
  - `AdapterMessage`: 支持 `role: "system" | "user" | "assistant" | "tool"`，其中 `assistant` 可携带 `toolCalls`，`tool` 携带 `toolCallId`、`toolName` 与 JSON 文本结果。
- 协议映射：
  - **OpenAI Chat (`openai-chat`)**：请求 `tools: [{ type: "function", function }]` + `tool_choice`，流式按 `delta.tool_calls[index]` 增量聚合 `id`/`name`/`arguments`，回传 `role: "tool"` + `tool_call_id`。
  - **Anthropic Messages (`anthropic-messages`)**：请求 `tools: [{ name, description, input_schema }]`，解析 `tool_use` block（流式聚合 `content_block_start` + `input_json_delta`），回传 `role: "user"` 含 `tool_result` block。
  - **Google Gemini Native (`gemini-native`)**：请求 `tools: [{ functionDeclarations }]`，解析 `candidates[0].content.parts[].functionCall`，回传 `role: "user"` 含 `functionResponse`。
- **自动降级**：若当前模型 `capabilities.supportsTools === false`，或首轮请求因上游网关不支持 `tools` 返回 HTTP 400，引擎自动无缝降级为增强型单轮 Blueprint JSON 模式（含 1 次报错自修复），保证任意小模型或中转代理都能正常工作。

### 2.2 Forma 内置 10 大工具契约（`src/agent/forma-tools.ts`）

工具分为**只读探索类（6）**、**受控提案类（1）**、**Skill 渐进式披露类（3）**，全部执行在进程内内存快照上，绝不直接改写用户画布——只有最终通过严格校验的原子 `Transaction` 会送回编辑器进入「预览 HUD → 设计师采纳 → 单步撤销」流程。

| # | 工具名 | 类别 | 核心参数 | 返回内容与作用 |
| --- | --- | --- | --- | --- |
| 1 | `get_canvas_overview` | 只读 | 无 | 文档元信息、全部页面列表、当前页顶层画板列表、当前选区与锁定/实例保护状态、组件库与设计系统数量摘要、安全落点坐标 |
| 2 | `search_nodes` | 只读 | `rootId?`, `ids?`, `query?`, `types?`, `pageId?`, `withinSelection?`, `onlyInstances?`, `limit?` | 按名称/文案/类型/实例来源检索图层，默认返回最多 40 条匹配摘要（含路径与样式关键值），突破 300 节点截断限制 |
| 3 | `get_node_details` | 只读 | `ids: string[]`, `includeChildren?`, `depth?` | 批量读取指定节点完整属性（含多重填充、描边、字体、变量/样式绑定、实例暴露属性与内部 `templateKey` 列表、交互连线） |
| 4 | `search_components` | 只读 | `query?`, `libraryId?`, `category?`, `limit?` | 搜索已安装组件库，返回精确 `libraryId`、`componentId`、完整 `variants`（含 `variantId`、`properties`、尺寸）与 `exposed` 暴露属性列表，彻底解决 290 变体盲区 |
| 5 | `get_design_system` | 只读 | `kind?: "all" \| "variables" \| "styles" \| "collections"`, `query?`, `scope?` | 按关键词或属性作用域（如 `fill`/`radius`/`text`）检索变量与可复用样式，返回精确 ID、当前模式解析值、集合模式与允许作用域 |
| 6 | `lint_design` | 只读 | `rootId?` | 对指定画板或选区运行确定性设计体检（硬编码非 Token 色值、文字对比度不足、子层越界/重叠、未命名/空文案等），返回可定位的问题清单 |
| 7 | `propose_design_changes` | 提案 | `mode`, `reply`, `summary?`, `artboards?`, `edits?`, `operations?` | 对 Blueprint 或原始操作执行原子事务与选区校验。成功时返回 `createdRootIds`、`summary`、`stats`、`diagnostics`、`lintSummary` 和 `guidance`。拒绝时返回错误与修复指引。 |
| 8 | `activate_skill` | Skill L2 | `name: string` | 按需激活一个已启用的第三方/内置 Skill，返回完整 `SKILL.md` 指令正文、可用资源路径清单、兼容级别与 Forma 画布映射提示（引导将代码/样式规范映射为原生图层而非输出 HTML/CSS） |
| 9 | `read_skill_resource` | Skill L3 | `name: string`, `path: string`, `offset?`, `limit?` | 按需读取已激活 Skill 的本地参考文档、主题文件或数据表（支持 `references/`、`assets/`、`themes/`、`data/`、`rules/`、`templates/`、`docs/`、`examples/`、`guides/` 及根目录同级伴随文档；单文件 ≤ 256 KiB、单次返回 ≤ 32 KiB，严禁路径穿越与符号链接逃逸） |
| 10 | `search_skill_resources` | Skill L3 检索 | `name: string`, `query: string`, `pathPrefix?`, `limit?` | 纯 TypeScript 离线只读检索已激活 Skill 的本地 `.csv`/`.tsv`/`.md`/`.json`/`.txt` 数据与规范（支持 CSV 表头映射行检索与 Markdown 段落命中），安全替代社区 Skill（如 `ui-ux-pro-max`）中的 Python/Bash 查询脚本，零脚本执行风险 |

最近一次成功的提案保留一份只读影子文档。每次完整重提均从原始文档编译。校验失败时，仍可查看上一份成功提案。

- `lintSummary` 优先检查本次所有新增根画板，其次是选区。两者都没有时检查当前页。`issueCount` 包含范围内的全部问题，`topIssues` 按检查顺序返回前 6 条。分类计数为 `contrastIssues`、`overflowIssues`、`overlapIssues`、`emptyTextIssues`、`unboundColorIssues`。线性渐变按文字层中心的色标位置和透明度估算对比度。前四项均为 0 时，模型直接用简洁中文总结，可省去重复体检与画布概览。
- 用提案新增节点 ID 调用 `get_node_details`、`lint_design` 或 `search_nodes` 会返回 `source: "proposed-shadow"`。搜索支持 `rootId` 限定子树、`ids` 限定节点。成功提案后的无 ID 搜索也包括提案节点。显式指定原有根时读取原稿。空画布上的无根体检自动读取影子文档。`get_canvas_overview` 始终读取原稿。

### 2.3 多轮执行护栏与可观测性

- 默认最多执行 6 轮工具调用。引擎和 `/api/agent/chat` 总时限均为 240 秒，兼容接口 `/api/agent/generate` 为 180 秒。外部更短时限、连接取消和设计师点击「停止」均优先生效。
- 每调用一个工具均通过 SSE `progress` 事件实时推送给编辑器（例如「正在检索组件库…」「正在激活技能 mobile-h5-accessibility-audit…」「正在校验设计事务…」）。
- 响应体返回结构化 `toolTrace: AgentToolTraceItem[]`（记录工具名、摘要、耗时、状态）与 `activatedSkills: string[]`，在左侧 `AgentPanel` 对话气泡中以紧凑折叠徽章呈现，完全透明可追溯。

---

## 三、组件、样式、图层精准调用增强（`blueprint-compiler.ts`）

为解决模型“能找到但容易调用偏/静默丢弃”的问题，对蓝图编译器做出以下确定性增强：

1. **组件与变体智能匹配**：
   - `resolveLibraryComponent()` 优先精确匹配 `(libraryId, componentId, variantId)`；若未命中，依次回退按组件 `name`（不区分大小写）匹配、按 `variantProperties`（如 `{ 主题: "深色", 状态: "开启" }`）精确/最高重合度匹配变体，并返回诊断信息。
2. **组件实例化即刻覆写（`overrides`）**：
   - Blueprint 中 `type: "component"` 节点和 `edits` 里的 `insertComponent` 操作支持可选 `overrides` 字段：
     ```json
     {
       "type": "component",
       "libraryId": "forma-mobile-v1",
       "componentId": "button",
       "variantProperties": { "Style": "Primary" },
       "overrides": {
         "text": "立即购买",
         "textByTemplateKey": { "subtitle": "限时优惠" },
         "fill": "#0D99FF",
         "color": "#FFFFFF",
         "slots": { "leadingIcon": { "libraryId": "...", "componentId": "...", "variantId": "..." } }
       }
     }
     ```
   - 编译器在展开或提交时，通过影子演练定位新插入实例根节点及内部受保护可覆盖文本/外观子层，自动生成合法的后续 `update` / `setInstanceSlot` 操作（严守实例结构保护，只改允许的文案、外观与公开插槽），纳入同一原子事务！
3. **样式、变量与专业图层属性补齐**：
   - `applyStyle` 支持显式 `slot`（`"paint" | "stroke" | "text" | "grid" | "effect"`）；
   - `edits` 新增支持 `setInstanceSlot`、`detachInstance`、`setVariableMode`（在节点 `variableModes` 上绑定集合模式，如切换局部深色画板）；
   - `normalizeStylePatch` 补齐专业排版与外观属性：`fontFamily`、`fontStyle`、`textDecoration`、`textTransform`、`verticalAlign`、`strokeAlign`、`strokeStyle`、`strokeDash`、`strokeSides`、`paints`、`strokePaints`、`gridTracks`、`gridRowTracks`、`layoutBreakpoints`。
4. **非静默诊断（`diagnostics`）**：
   - `CompileBlueprintResult` 新增 `diagnostics: CompileDiagnostic[]`（`severity: "warning" | "error"`, `code`, `message`, `suggestion?`）。
   - 当模型引用了不存在的节点 ID、组件 ID、变量 ID、样式 ID 或作用域不匹配时，不再静默忽略，而是记录诊断并附带候选建议；在 Tool-Calling 模式下直接回传给模型自纠。

---

### 新建蓝图的自动布局默认值与真实模型输出容错

根画板默认 390 × 844 px、白色、列布局、圆角 0、内边距 24 px、间距 12 px。子 frame 的圆角、内边距与间距默认均为 0。省略填充、渐变、非空 paints、填充 Token、填充变量和画笔样式时，编译器设置 `fillOpacity: 0`。显式透明度、颜色绑定、四边 insets 和四角 corners 优先。

当某一轴同时省略尺寸与模式时，行内的 frame 和文本默认 Hug 宽，列内默认 Fill 宽。有子层的行列 frame 默认 Hug 高，回退高 40 px。行内 frame 的回退宽为 80 px。自动布局内的文本默认 Hug 高。行内原生按钮默认 Hug 宽，回退宽 96 px，高 36 px。列内按钮默认高 44 px。服务端使用回退尺寸计算布局，浏览器按实际字体测量 Hug 文本与按钮。固定尺寸与显式模式可逐轴覆盖这些默认值。

针对真实云端大模型（DeepSeek 等）在长输出中常见的高频样式写法，编译器与工具层内置安全归一化：
- `fill: "none"` 归一化为透明填充（`fillOpacity: 0`）；仅声明描边（`stroke`/`strokeWidth`/`strokePaints`）而未声明填充的 `ellipse`/`rectangle` 装饰形状默认 `fillOpacity: 0`，避免暗色背景出现意外纯白实心圆/方块；
- `strokeSides` 兼容数组简写（如 `["top"]`）与布尔映射（如 `{ top: true }`），自动转换为 `{ top: strokeWidth, right: 0, bottom: 0, left: 0 }`（宽度钳位至 `0..64`），并在复杂样式字段（`strokeDash`/`paints`/`gridTracks` 等）格式非法时安全跳过而不炸毁整份画板提案；
- 盒模型与圆角兼容 CSS 风格数组/方向简写：`padding: [v, h]` / `[t, r, b, l]`、`insets: [...]`、`paddingX`/`paddingY`/`paddingTop|Right|Bottom|Left`、`corners: [tl, tr, br, bl]`；
- `FormaToolExecutor` 在解析超长工具参数字符串时若遇尾随非 JSON 字符（如代码围栏或说明文字），自动调用 `extractJsonPayload` 剥离并提取合法 JSON 对象；`propose_design_changes` 容忍模型附带的额外元数据键（如 `designPlan`）。

## 四、第三方 Skill 生态协议（`SKILL.md` 开放标准）

### 4.1 遵循标准与目录规范

Forma 原生兼容业界 `agentskills.io` 开放标准（与 Claude Code、Codex、Cursor、Antigravity 通用），每个 Skill 为一个包含 `SKILL.md` 的文件夹：

```text
my-design-skill/
├── SKILL.md            # 必填：YAML frontmatter (name, description, ...) + Markdown 指导
├── references/         # 可选：按需读取的规范文档（.md / .txt / .json）
├── assets/             # 可选：按需读取的模板/Token表/矢量片段（.json / .md / .svg / .txt）
└── scripts/            # 可选：仅记录元数据，Forma 内置引擎默认禁止自动执行
```

`SKILL.md` Frontmatter 约定：

```yaml
---
name: ios-hig-layout-guide
description: Apple iOS/iPadOS 移动端界面排版、安全区、导航栏与触控热区设计规范。当设计移动端 H5/iOS 页面或评审移动界面时使用。
license: MIT
metadata:
  author: community
  version: "1.0.0"
  tags: [mobile, ios, layout]
---
```

### 4.2 多来源发现与安全边界

| 来源标识（`source`） | 路径 | 默认状态 | 权限说明 |
| --- | --- | --- | --- |
| `builtin` | Forma 内置只读示范技能（如 `forma-design-system-craft`、`mobile-h5-accessibility-audit`） | 默认启用 | 随产品分发，不可删除，可禁用 |
| `user` | `~/.forma/skills/`（或 `$FORMA_AGENT_CONFIG_DIR/skills/`） | 默认扫描并启用 | 用户通过 UI 导入或手动放入的第三方 Skill，支持增删启停 |
| `workspace` | `<工作区>/.forma/skills/` | 默认扫描并启用 | 随项目共享的团队设计规范 Skill |
| `external-standard` | `~/.agents/skills/`、`~/.claude/skills/`、`~/.codex/skills/`、`~/.cursor/skills/` | **默认关闭**（需用户在 Skills 管理弹窗显式开启勾选） | 复用意图：一键复用设计师本机已安装的其他 AI 工具三方 Skill；只读扫描，绝不修改外部目录 |

**强制安全约束与开源社区兼容性策略**：
1. **社区真实目录形态兼容（覆盖 9 类主流开源设计 Skill 实测形态）**：
   - 允许安全只读索引以下相对路径：`references/**`、`assets/**`、`themes/**`、`data/**`、`rules/**`、`templates/**`、`docs/**`、`examples/**`、`guides/**`，以及技能根目录的同级伴随文档（如 `jakubkrehel/skills` 的 `color-usage.md`、`contrast.md`、`figma.md`，自动排除 `SKILL.md`、`LICENSE*`、`README*`、`CHANGELOG*`）；
   - 允许只读扩展名：`.md`、`.txt`、`.json`、`.csv`、`.tsv`、`.svg`、`.yaml`、`.yml`、`.css`；单 Skill 最多索引 80 份文件，单文件上限 256 KiB，单次 `read_skill_resource` 返回上限 32 KiB；
   - **严禁路径穿越与符号链接逃逸**：所有路径经 `path.resolve` + `realpathSync` + `O_NOFOLLOW` 核验，严禁进入 `scripts/` 或逃出 Skill 根目录。
2. **兼容分级自动诊断（`SkillCompatibilityReport`）**：
   - `native`（**完全兼容**）：纯指令或附带本地 `.md`/`.json`/`.csv`/主题文件的 Skill（如 `frontend-design`、`brand-guidelines`、`theme-factory`、`better-colors`、`better-typography`、`better-interface`、`build-design`）；
   - `adapted`（**本地检索适配**）：含 `scripts/` 或引导运行 Python/Bash 脚本的 Skill（如 `ui-ux-pro-max`），Forma 禁止执行脚本，改由内置 `search_skill_resources` 工具直接检索本地 `data/*.csv` 与 `references/`；
   - `limited`（**外部依赖受限**）：正文中声明依赖 `WebFetch`/远端 URL 且未附带本地规则文件的 Skill（如 `web-design-guidelines`），在 UI 明确展示提示并建议附带本地规则文档后离线使用。
3. **Forma 画布语义桥接（Skill-to-Canvas Translation）**：
   - 激活或预加载任何第三方 Skill 时，运行时自动附带画布映射引导：将配色、排版、层级、间距、反模板化规范直接映射为 Forma 原生节点与设计系统变量/组件（禁止直接输出 HTML/CSS/Tailwind 代码作为答复）；当设计师已给出明确需求时直接生成可预览画板，不因社区 Skill 中的“等待用户确认”句式而卡住流程。
4. **严禁无沙箱代码执行与静默联网**：`scripts/` 永不自动执行，默认纯本地读取与用户主动导入；配置持久化于 `~/.forma/agent-skills.json`（权限 `0600`）。

### 4.3 三层渐进式披露流程

1. **L1 发现（Discovery）**：每次发起 `/api/agent/chat` 时，仅将**已启用 Skill** 的 `name` + `description`（单条截断 ≤ 220 字符，总预算 ≤ 4,000 字符）写入 System Prompt「Available Skills」节。
2. **L2 激活（Activation）**：
   - 自动触发：模型判断当前设计任务匹配某 Skill 时，调用 `activate_skill({ name })` 获取完整 `SKILL.md` 正文与资源路径清单；
   - 显式触发：设计师可在对话输入框或 Skills 弹窗显式指定本轮必须生效的 Skill（`activeSkills: string[]`），服务端直接预加载其正文注入上下文（对不支持工具调用的模型同样有效！）。
3. **L3 深度参考（On-Demand Resources）**：模型需要具体规范表或资产模板时，调用 `read_skill_resource({ name, path })` 精确读取单个文件。

---

## 五、外部 MCP Server 能力同步升级（`server/mcp.ts`）

除保留 100% 向后兼容的既有 3 工具（`read_design`、`list_components`、`propose_design`）外，外部 MCP Server 同步扩展 4 个高价值只读工具，使 Claude Code / Codex / Cursor 等外部 Agent 同样能精准操控 Forma：

- `search_nodes`（转发 `POST /api/agent/sessions/search-nodes`）
- `get_node_details`（转发 `POST /api/agent/sessions/node-details`）
- `get_design_system`（转发 `POST /api/agent/sessions/design-system`）
- `lint_design`（转发 `POST /api/agent/sessions/lint`）

所有外部查询均严格服从当前配对会话的 `selection` 选区隔离与认证令牌校验。

---

## 六、演进边界：Phase 2 第三方 MCP Client 架构蓝图（规划中，本期未实施）

为保证架构可延续，特明确第三方工具生态的下一阶段演进契约（**当前状态：规划蓝图，非本期已完成项**）：

1. **分工定位**：
   - **Phase 1（本期已实施）**：第三方 `SKILL.md`（方法论、设计规范、组件映射规则、品牌指南、审查清单）+ Forma 内置 10 大原生工具 + 升级版 Forma 外部 MCP Server。
   - **Phase 2（下期规划）**：Forma 自身作为 **MCP Client**，连接用户配置的外部第三方 MCP Server（如 Iconify 图标库、Unsplash/图库检索、企业 Design Token 仓库、Figma/Jira 需求同步），将外部工具以命名空间 `mcp__<serverId>__<toolName>` 动态注入 `forma-tools.ts` 工具表。
2. **Phase 2 配置文件与安全模型**：
   - 本地配置文件 `~/.forma/mcp-servers.json`（权限 `0600`），支持 `stdio`（Electron 桌面端）与 `streamable-http`（Web/桌面通用），默认空配置零外联；
   - 工具权限三级分类：`read-only`（如查图标/查规范，按服务器授权自动执行）、`canvas-import`（如导入 SVG/图片资产，经 Forma 预览事务确认）、`external-write`（须每次人工弹窗确认）。
