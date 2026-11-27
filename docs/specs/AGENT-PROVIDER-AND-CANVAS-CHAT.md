# Forma 多模型配置、能力识别与画布对话设计规格

- **最近更新日期**：2026-11-27
- **状态**：已实施并验收（v2.2：跨文件/重启模型自动水合、彻底移除「创作设置」浮层与引擎模式暴露、独立 MCP 集成弹窗；单测 + HTTP 集成测试 + 生产构建 + 真实浏览器端到端验收）
- **关联源码**：
  - 后端供应商与能力真相源：[provider-registry.ts](../../src/agent/provider-registry.ts)、[model-catalog.ts](../../src/agent/model-catalog.ts)、[capabilities.ts](../../src/agent/capabilities.ts)、[adapters.ts](../../src/agent/adapters.ts)
  - 工具调用与蓝图引擎：[forma-tools.ts](../../src/agent/forma-tools.ts)、[context-builder.ts](../../src/agent/context-builder.ts)、[blueprint-compiler.ts](../../src/agent/blueprint-compiler.ts)、[design-engine.ts](../../src/agent/design-engine.ts)
  - 第三方技能与本地安全存储：[skills.ts](../../src/agent/skills.ts)、[skill-registry.ts](../../server/skill-registry.ts)、[agent-config-store.ts](../../server/agent-config-store.ts)、[agent-http.ts](../../server/agent-http.ts)、[agent-service.ts](../../server/agent-service.ts)
  - 编辑器界面：[ModelConfigModal.tsx](../../src/editor/ModelConfigModal.tsx)（`08.03`）、[SkillsModal.tsx](../../src/editor/SkillsModal.tsx)、[IntegrationsModal.tsx](../../src/editor/IntegrationsModal.tsx)、[CanvasAgentBar.tsx](../../src/editor/CanvasAgentBar.tsx)（`08.04`）、[AgentPanel.tsx](../../src/editor/AgentPanel.tsx)（`08.01`–`08.02`）及子模块 [src/editor/agent/](../../src/editor/agent/agent-copy.ts)、[agent-client.ts](../../src/editor/agent-client.ts)
- **相关规格**：[Forma Agent 原生工具调用与第三方 Skill 生态规格](AGENT-TOOLS-AND-SKILLS.md) · [Agent 事务协议](../AGENT-PROTOCOL.md)
- **验收脚本**：[tests/agent-providers.test.ts](../../tests/agent-providers.test.ts)、[tests/agent-blueprint.test.ts](../../tests/agent-blueprint.test.ts)、[tests/agent-tools.test.ts](../../tests/agent-tools.test.ts)、[tests/agent-skills.test.ts](../../tests/agent-skills.test.ts)、[scripts/check-agent-canvas-chat.browser.js](../../scripts/check-agent-canvas-chat.browser.js)

---

## 一、设计目标与核心修正（v2 变更原因）

v1 在真实 DeepSeek API Key 接入实测中暴露出两类根本性架构问题，v2 对此进行彻底重构：

1. **交互颠倒与不精准 Key 匹配问题（已废除）**：
   - v1 默认进入「自动识别模式」，将 API Key 输入框置于供应商列表之上，并对通用 `sk-` 前缀同时高亮 5–6 家无关供应商；后台甚至在 `"auto"` 模式下将用户密钥并发发往多个无关第三方厂商 `/models` 端点探测。
   - **安全与体验定论**：业界多数主流模型商（OpenAI、DeepSeek、Kimi、通义千问、硅基流动、MiniMax 及常见兼容代理）共享 `sk-` 前缀，无法通过密钥字符串精准反推供应商；向无关厂商广播用户密钥更存在严重凭证泄露风险。
   - **v2 规范**：遵循业界主流工具（Cursor / Cline / Cherry Studio / OpenCode）共识，采用**「Step 1 先选供应商 → Step 2 填写该供应商 API Key（及自定义地址）→ Step 3 连接探测并查看真实模型与能力 → Step 4 选定模型保存启用」**的显式顺序；彻底移除多供应商并发盲扫与通用 `sk-` 卡片高亮。
2. **上游模型元数据被丢弃 + 硬编码能力表过时问题（已重构）**：
   - v1 的 `parseOpenAIModelsBody()` 仅抽取了 `item.id`，丢弃了上游 `/models` 响应自带的 `context_window`、`max_output_tokens`、`input_modalities`、`architecture`、`supported_parameters` 等真实元数据；随后回落到 2024 年旧硬编码（如所有 `deepseek*` 写死 64K 且未纳入视觉白名单），导致真实 DeepSeek `deepseek-flash`（实际 1M 上下文、384K 输出、原生支持图像输入）被误标为「仅文本 · 上下文 64K」并禁用参考图上传。
   - **v2 规范**：建立**五层优先级模型能力真相源**（用户覆写 > 上游接口实时元数据 > 内置 2026 模型目录 > 保守家族推断 > 运行时自愈降级），在界面明确标注能力来源，并支持已保存连接一键刷新与手动能力覆写。

---

## 二、内置 13 家主流供应商与显式接入协议

### 2.1 供应商预设清单

| ID | 供应商 | 区域线路回退（仅限于用户已选定的同一厂商内） | 底层协议 | 专属高置信度密钥前缀 |
| --- | --- | --- | --- | --- |
| `openai` | OpenAI | `https://api.openai.com/v1` | `openai-chat` | `sk-proj-` / `sk-svcacct-` |
| `anthropic` | Claude / Anthropic | `https://api.anthropic.com/v1` | `anthropic-messages` | `sk-ant-` |
| `gemini` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | `gemini-native` | `AIza...` |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `openai-chat` | `sk-or-v1-` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` | `openai-chat` | 无专属（通用 `sk-`） |
| `kimi` | Kimi / 月之暗面 | `.cn/v1` → `.ai/v1` | `openai-chat` | 无专属（通用 `sk-`） |
| `qwen` | 通义千问 / DashScope | 国内兼容端点 → 国际端点 | `openai-chat` | 无专属（通用 `sk-`） |
| `zhipu` | 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `openai-chat` | `32位hex.secret` |
| `minimax` | MiniMax | `api.minimaxi.com/v1` → `api.minimax.io/v1` | `openai-chat` | 无专属 |
| `doubao` | 豆包 / 火山方舟 Ark | `https://ark.cn-beijing.volces.com/api/v3` | `openai-chat` | 无专属（常配合接入点 ID） |
| `siliconflow` | 硅基流动 SiliconFlow | `.cn/v1` → `.com/v1` | `openai-chat` | 无专属（通用 `sk-`） |
| `ollama` | Ollama 本地模型 | `http://127.0.0.1:11434/v1`（回退 `/api/tags` + `/api/show`） | `openai-chat` | 免 Key |
| `custom` | 自定义兼容网关 | 用户填写 Base URL，探测 OpenAI / Anthropic / Gemini 协议 | `auto` | 可选 |

### 2.2 密钥识别安全与交互规则（硬性约束）

1. **先选供应商，后填凭证**：`ModelConfigModal` 顶部主区为「第一步：选择模型供应商」，选中某一供应商卡片后才在其下方展示「第二步：填写 `<供应商>` 连接信息」。默认选中首个或当前未配置时的引导态，**不存在 `"auto"` 盲猜模式**。
2. **禁止多厂商并发盲扫**：`probeProvider()` 必须要求明确的 `providerId`（或显式 `baseUrl`）。当调用方传入无效的 `"auto"` 且未提供 `baseUrl` 时：
   - 仅当 `detectProviderFromKey(apiKey)` 返回 `confidence === "high"`（5 种唯一前缀之一）时，允许向**唯一对应厂商**探测；
   - 对通用 `sk-` 或其他无法唯一确定的密钥，**严禁向多个无关第三方发送请求**，直接返回明确错误提示请先选择模型供应商。
3. **禁止模糊猜测高亮**：`detectProviderFromKey()` 对通用 `sk-`、JWT、UUID 均返回 `{ providerId: null, confidence: "none", candidates: [] }`。界面不得对任何未选中的供应商卡片渲染绿色“推荐/猜测”边框。
4. **高置信度冲突善意提示（非强制跳转）**：若用户已选定供应商 A（非 `custom`），粘贴了 100% 属于供应商 B 的高置信度专属前缀（例如在 DeepSeek 下粘贴 `sk-ant-...`），在输入框下方显示一条非阻塞提示（“该密钥前缀通常属于 Claude / Anthropic”）并附「切换为 Claude」按钮，由用户主动点击决定，绝不静默篡改用户选择。
5. **自定义模型 ID 支持**：在高级选项及探测结果卡片中允许输入自定义模型 ID（解决火山方舟 `ep-xxxx` 接入点、刚上线新模型或关闭 `/models` 接口的企业网关场景）。

---

## 三、五层模型能力解析管道（Capability Resolution Pipeline）

### 3.1 `ModelCapabilities` 契约

```ts
export type CapabilitySource =
  | "user-override"
  | "provider-api"
  | "builtin-catalog"
  | "heuristic";

export interface ModelCapabilityOverrides {
  supportsVision?: boolean;
  supportsTools?: boolean;
  isReasoning?: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  structuredOutput?: StructuredOutputMode;
}

export interface ModelCapabilities {
  protocol: ProviderProtocol;
  structuredOutput: StructuredOutputMode;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  isReasoning: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  temperatureMode: "normal" | "fixed_one" | "omit";
  tokenLimitParam: "max_tokens" | "max_completion_tokens";
  capabilitySource?: CapabilitySource;
  visionKnown?: boolean;
  contextKnown?: boolean;
}
```

### 3.2 五层优先级合并规则

1. **Layer 1 · 用户手动覆写（`user-override`）**：用户在「已保存连接」或探测结果面板手动调整的视觉/工具调用/上下文窗口/输出上限开关，优先级最高，刷新模型列表时保留不被覆盖，支持一键清除恢复自动检测。
2. **Layer 2 · 上游接口实时元数据（`provider-api`）**：连接探测时完整解析上游响应字段，绝不丢弃：
   - **DeepSeek / OpenAI 扩展 `/models`**：`name` / `display_name`、`context_window` / `context_length` / `max_context_length` / `max_input_tokens`、`max_output_tokens` / `max_completion_tokens`、`input_modalities`（含 `"image"` → `supportsVision = true`）、`modalities`、`capabilities.vision` / `capabilities.tools` / `capabilities.reasoning`。
   - **OpenRouter `/api/v1/models`**：`name`、`context_length`、`top_provider.max_completion_tokens`、`architecture.input_modalities`、`architecture.modality`（含 `image` → 视觉）、`supported_parameters`（含 `tools` / `reasoning` / `structured_outputs`）。
   - **Google Gemini `/v1beta/models`**：`displayName`、`inputTokenLimit`、`outputTokenLimit`、`supportedGenerationMethods`。
   - **Anthropic `/v1/models`**：`display_name` 及可选 token/capability 字段。
   - **Ollama `/api/tags` + `/api/show`**：对本地模型补充读取 `model_info.*.context_length` 与 `capabilities`（`vision`、`tools`、`thinking`）。
3. **Layer 3 · 内置 2026 模型规格目录（`builtin-catalog`，`src/agent/model-catalog.ts`）**：
   - 当上游 `/models` 仅返回 `id`（如 OpenAI 标准 `/v1/models`）或缺少部分字段时，按规范化模型 ID 精确/前缀查表补全。
   - 示例权威基线（2026）：
     - `deepseek-flash`（DeepSeek-V4.1-Flash）：`maxContextTokens: 1_000_000`, `maxOutputTokens: 65_536`（API 上限 384K，单次设计输出安全上限按需可调）, `supportsVision: true`, `supportsTools: true`, `isReasoning: true`, `temperatureMode: "omit"`
     - `deepseek-v4-pro`：`maxContextTokens: 1_000_000`, `maxOutputTokens: 65_536`, `supportsVision: false`, `supportsTools: true`, `isReasoning: true`, `temperatureMode: "omit"`
     - `deepseek-chat`：`maxContextTokens: 128_000`, `maxOutputTokens: 8_192`, `supportsVision: false`, `supportsTools: true`, `isReasoning: false`
     - `deepseek-reasoner`：`maxContextTokens: 128_000`, `maxOutputTokens: 32_768`, `supportsVision: false`, `supportsTools: true`, `isReasoning: true`, `temperatureMode: "omit"`
     - OpenAI `gpt-5*` / `gpt-4.1*` / `gpt-4o*` / `o3*` / `o4*`、Anthropic `claude-*`（含 4.x/5.x）、Gemini `gemini-2.5/3/4*`、Kimi `kimi-k2.5/k2*`、Qwen `qwen3*/qwen-vl*`、GLM `glm-4.5*/glm-5*`、MiniMax `MiniMax-M1/M2*`、Doubao `doubao-seed*` 全部更新至最新准确规格。
   - 预留 `importModelsDevSnapshot()` 解析器，支持后续离线导入或按需同步 `models.dev` JSON 目录（默认零外联请求）。
4. **Layer 4 · 保守家族启发式推断（`heuristic`）**：仅对目录和接口均未覆盖的未知模型生效，显式标记 `capabilitySource: "heuristic"`、`visionKnown: false`、`contextKnown: false`。界面展示「估算上下文 / 未声明视觉（可手动开启）」而非武断标成「仅文本 · 64K」。
5. **Layer 5 · 运行时自适应降级**：请求期间遇到 HTTP 400 不支持 `tools`、`json_schema`、`json_object` 或特定 `temperature` 参数时，自动按降级链重试一次并保持可用。

### 3.3 旧本地配置自动热升级

- `AgentConfigStore` 读取已有 `~/.forma/agent-profiles.json` 时，对缺少 `capabilitySource` 或仍为旧版启发式快照的已保存模型，若在 `builtin-catalog` 中存在精确条目（如用户已保存的 `deepseek-flash`），在内存中自动合并最新目录能力（保留用户已设覆写），确保用户升级后无需删库重配即可立即恢复 1M 上下文与视觉能力，同时可在 UI 点击「刷新模型」重新从厂商 `/models` 拉取最新实时元数据。

---

## 四、本地安全 REST API 契约（`/api/agent/*`）

Web 开发/预览服务（[vite.config.ts](../../vite.config.ts)）与 Electron 桌面端（[electron/main.mjs](../../electron/main.mjs)）继续共用同一回环 `/api/agent/*` 路由，未配置模型时编辑与导出保持 0 外部请求；密钥仅存于本机 `0600` 配置文件且响应全脱敏。

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/api/agent/providers` | `GET` | 返回内置 13 家供应商元数据 |
| `/api/agent/status` | `GET` | 返回 `{ configured, activeProfileId, activeProfile, profiles }`（密钥脱敏，含能力来源与覆写信息） |
| `/api/agent/detect` | `POST` | 针对显式 `providerId`（或自定义 `baseUrl`）连接探测，返回含真实元数据的模型列表与能力画像 |
| `/api/agent/profiles` | `POST` | 保存连接配置到本地 `0600` 文件并设为当前启用（支持 `capabilityOverrides`） |
| `/api/agent/profiles/:id` | `PATCH` / `DELETE` | 切换模型/激活连接、保存 `capabilityOverrides`、更新凭证或删除连接 |
| `/api/agent/profiles/:id/refresh` | `POST` | 重新向该连接对应供应商拉取最新 `/models` 列表与实时元数据，保留用户手动覆写 |
| `/api/agent/skills` | `GET` | 列出已发现的全部本地与第三方 `SKILL.md` 技能、启用状态与扫描源配置 |
| `/api/agent/skills/rescan` | `POST` | 重新扫描本地及已开启的外部标准技能目录 |
| `/api/agent/skills/import` | `POST` | 导入第三方 `SKILL.md`（支持粘贴内容或安全导入本地目录至 `~/.forma/skills/`） |
| `/api/agent/skills/:id` | `PATCH` / `DELETE` | 启停技能、切换扫描外部开放目录或删除已导入技能 |
| `/api/agent/chat` | `POST` | 多轮画布对话与原生 Tool-Calling 设计引擎（支持 SSE 推送工具/技能调用进度与结果 `toolTrace`、`activatedSkills`） |
| `/api/agent/generate` | `POST` | 兼容原有单轮事务生成接口 |
| `/api/agent/sessions*` | `POST` / `GET` / `DELETE` | 外部 MCP 配对会话接口（扩展查询端点，向后兼容旧 3 端点） |

---

## 五、画布原生对话与侧栏设计师工作区闭环

- **三处统一入口**：右栏 `✦ AI`、左栏「助手」面板、快捷键 `⌘↵` / `Ctrl+Enter` 均可唤起画布悬浮对话条 [CanvasAgentBar.tsx](../../src/editor/CanvasAgentBar.tsx)。
- **设计师视角满高对话工作区与跨文件连接保持（v2.2）**：
  - **跨文件/重启零丢失自动水合**：保存或激活模型配置后仅写入非敏感本地标记（`localStorage["forma.agent.configured-hint"]`），桌面端结合 `window.formaDesktop.hasConfiguredAgent()` 零网络磁盘探测本机配置文件；工作台首页、编辑器顶栏与 AI 面板在新建文件、切换文件、切页或重启桌面端后自动恢复已连接模型，未配置模型的新环境严格保持 `0` 次 `/api/agent/*` 请求。
  - 左侧栏 `AgentPanel` 采用「极简顶栏（含设计记忆、设计技能管理与模型设置直达入口）+ `flex: 1` 独立滚动欢迎/对话画布 + 吸底一体化输入卡」三段式布局，统一支持 `Enter` 发送 / `Shift+Enter` 换行（并兼容 `⌘↵`）。
  - **零内部工程参数暴露**：彻底移除「创作设置」浮层、「生成方式」底层引擎切换下拉（固定按选区自动智能路由）以及「生成后自动视觉优化」手动开关（支持视觉识别的模型默认自动自审，纯文本模型静默跳过）；目标组件库以内联紧凑药丸（默认继承项目默认库）直接置于输入卡工具栏；外部 Agent MCP 实时配对与高级 JSON 事务导入抽离至独立的 [IntegrationsModal.tsx](../../src/editor/IntegrationsModal.tsx)（从主菜单「外部工具集成（MCP）…」打开，以 `hidden` 保活会话）。
  - 未连接模型时每处界面仅展示一次温和引导，移除双重提示与原始像素坐标；已连接后在输入卡底栏提供紧凑模型切换胶囊（窄栏自动双行排列并将发送按钮固定在右下角），未归入项目且无历史记录的草稿不常驻展示工程条。
  - 视觉参考图上传按钮按 `capabilities.supportsVision` 控制；对于未知模型，用户可在「已保存连接 → 调整能力」手动开启视觉识图。
- 所有画布写入均先通过 `useDocument.setPreview` 高保真预览（`.is-ai-preview` + 浮动 HUD「采纳到画布 / 继续微调 / 丢弃」），确认后写入单步可撤销原子事务，详见[Forma Agent 原生工具调用与第三方 Skill 生态规格](AGENT-TOOLS-AND-SKILLS.md)。
