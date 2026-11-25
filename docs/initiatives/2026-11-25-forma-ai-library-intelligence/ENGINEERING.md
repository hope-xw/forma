# 工程设计文档 · Forma AI 组件库智能理解、混合装配与三维设计记忆体系

- **课题编号**：`2026-11-25-forma-ai-library-intelligence`
- **状态**：Stage 1 已定稿，按隔离轨道并行施工
- **关联需求**：[PRD.md](PRD.md) · [TASKS.md](TASKS.md)

---

## 一、系统总体架构

```text
┌────────────────────────────────────────────────────────────────────────────────┐
│                      Forma 编辑器（Forma AI 面板 & 组件库管理中心）                │
│  • Target Library 选择器（选定如「淘宝移动端库」/ 官方 4 大体系 / 不限库）         │
│  • LibraryManagerModal：「AI 说明书」查看 / 编辑 / 离线重算（Page/Block/Comp）    │
│  • 复杂需求前置「生成范围确认卡（ScopeProposalCard）」→ 一键「确认并直接生成」      │
└───────────────────────────────┬────────────────────────────────▲───────────────┘
                                │ SSE /api/agent/chat            │ scopeProposal /
                                │ (+ targetLibraryId,            │ htmlDraft(multi) /
                                │    confirmedScope,             │ transaction /
                                │    memoryScope)                │ toolTrace
                                ▼                                │
┌────────────────────────────────────────────────────────────────────────────────┐
│                      Forma AI Engine (src/agent/ + server/)                     │
│                                                                                │
│  ┌──────────────────────────────┐    ┌──────────────────────────────────────┐  │
│  │ 1. 活体组件库智能引擎         │    │ 2. 自适应范围门控（Scope Gate）       │  │
│  │ library-intelligence.ts      │    │ • 清晰需求 / confirmedScope → 零打断  │  │
│  │ • 三级分层 page/block/comp   │───▶│   直接生成全套画板                    │  │
│  │ • 硬契约 Manifest 提取        │    │ • 复杂模糊多页需求 → 1 轮             │  │
│  │ • 增量 Playbook (SKILL.md)   │    │   propose_scope_plan 带默认方案拍板   │  │
│  └──────────────────────────────┘    └──────────────────┬───────────────────┘  │
│                                                         │                      │
│  ┌──────────────────────────────────────────────────────▼───────────────────┐  │
│  │ 3. 工具循环（16 工具 = 原 13 + 3 新高杠杆工具）                            │  │
│  │ • get_library_playbook       读取目标库说明书、Token 规范、异常态映射      │  │
│  │ • inspect_component_structure 只读探查模块/页面内部层级与可覆盖槽位        │  │
│  │ • search_components (增强)   支持 tier=page|block|component + 槽位契约    │  │
│  │ • propose_scope_plan         前置 1 轮边界确认（仅复杂模糊未确认需求）     │  │
│  │ • propose_html_design (升级) 支持多画板 artboards[] + data-forma-component│  │
│  │ • propose_design_changes(升) 支持模块外框派生 adapt + 多画板主/异常矩阵    │  │
│  └─────────────────────────────────┬────────────────────────────────────────┘  │
└────────────────────────────────────┼───────────────────────────────────────────┘
                                     │
         ┌───────────────────────────┴───────────────────────────┐
         ▼ 通道 A：插槽化混合编译（HTML-First + 原装实例 + Token）  ▼ 通道 B：蓝图精准编辑 / 模块派生
┌───────────────────────────────────────────────────┐   ┌─────────────────────────────────┐
│ html-forma-sandbox.ts + html-to-forma.ts          │   │ blueprint-compiler.ts           │
│ 1. 按真实组件变体尺寸水合 [data-forma-component]   │   │ • adapt: 解外框保留内部实例     │
│ 2. 无脚本沙盒精确测量 Flex/Grid 布局              │   │ • 主流程横向 + 异常/浮层纵向矩阵 │
│ 3. 遇到插槽 → instantiateComponent 原地生成真实    │   │ • 完整 overrides / slots / Token│
│    受保护 Instance + 应用合法 overrides           │   └────────────────┬────────────────┘
│ 4. 新造自定义模块 → 自动吸附库颜色/圆角变量绑定    │                    │
│ 5. 多画板主流程横向 + 异常/浮层纵向对齐合入单事务  │                    │
└─────────────────────────┬─────────────────────────┘                    │
                          └──────────────────────┬───────────────────────┘
                                                 ▼
                         ┌──────────────────────────────────────────────┐
                         │ 统一原子 Transaction（parseDocument + transact）│
                         │ 预览 HUD → 采纳 → 变体切换/手改 → ⌘Z 单步撤销 │
                         └──────────────────────────────────────────────┘
```

---

## 二、核心数据结构与接口契约

### 2.1 组件库三级分层与 AI 说明书扩展（向后 100% 兼容）
在 `src/domain/library-schema.ts` 新增全可选字段（既有 `forma/library` v1 快照零破坏）：

```ts
export const assetTierSchema = z.enum(["page", "block", "component"]);
export type AssetTier = z.infer<typeof assetTierSchema>;

export const componentAiHintsSchema = z.object({
  whenToUse: z.string().max(500).optional(),
  avoidWhen: z.string().max(500).optional(),
  tags: z.array(z.string().max(40)).max(16).optional(),
  maxTextChars: z.number().int().positive().max(2000).optional(),
  slotsNote: z.string().max(500).optional(),
});

export const libraryAiGuideSchema = z.object({
  summary: z.string().max(1000).optional(),
  platform: z.string().max(80).optional(),
  visualPrinciples: z.array(z.string().max(240)).max(20).optional(),
  compositionRules: z.array(z.string().max(240)).max(20).optional(),
  exceptionPatterns: z.array(z.string().max(240)).max(20).optional(),
  playbookMarkdown: z.string().max(64_000).optional(),
  generatedAt: z.string().max(64).optional(),
  revision: z.number().int().nonnegative().optional(),
});
```

- `LibraryComponent` 新增可选 `assetTier?: AssetTier`、`aiHints?: ComponentAiHints`；
- `ComponentLibrary` 新增可选 `aiGuide?: LibraryAiGuide`。

### 2.2 HTML-to-Forma 原装组件插槽协议
模型在 `propose_html_design` 的 HTML 中可通过标准属性声明原装库组件（安全、兼容 HTML5 解析器、完整参与 Flex/Grid 排版）：

```html
<div
  data-forma-component="goods-double-card"
  data-library="taobao-mobile-v1"
  data-variant="promo-light"
  data-variant-props='{"外观":"浅色","状态":"大促"}'
  data-overrides='{"textByTemplateKey":{"title":"有机鲜奶 250ml×12","price":"39.9"},"fill":"#FFFFFF"}'
  style="flex: 1;"
></div>
```

- **沙盒排版期**：`hydrateComponentPlaceholdersInDom` 根据目标变体根节点的真实 `width`/`height` 为占位节点注入内在尺寸约束（不覆盖 CSS 显式 `width`/`flex: 1` 伸缩），保证真实度量不挤压。
- **编译落盘期**：`compileRenderedDomToForma` 遇到 `[data-forma-component]` 时调用 `instantiateComponent` 在父容器内生成**真实受保护 `Instance`**，同步发射必要的 `putLibrary` / `setDesignSystem` / `putImage`，并按合法覆盖规则生成子层文案/外观/插槽 `update` 与 `setInstanceSlot` 操作；最后确保所有内部结构通过 `validateInstanceStructure` 校验。
- **新造模块 Token 吸附**：对非组件实例节点，当提供 `activeLibraryId`（或文档存在 `designSystem`）时，自动匹配颜色变量（精确命中或 RGB 欧氏距离 ≤ 12 且同色系作用域允许）与精确圆角数值变量，写入 `variableBindings`，统计入 `stats.tokensBound`。

### 2.3 多画板矩阵排布协议
`propose_html_design` 与 `propose_design_changes` 统一支持画板角色与父子关系：
- `refId?: string`：画板逻辑引用名；
- `role?: "primary" | "overlay" | "exception" | "detail"`（默认 `"primary"`）；
- `parentRef?: string`：指向关联的主流程画板 `refId`。
- **排布规则**：
  - 所有 `primary` 画板从安全起点 `(startX, startY)` 自左向右横向排列，间隔 `ARTBOARD_GAP = 80px`；
  - 所有带 `parentRef` 的 `overlay` / `exception` / `detail` 画板，与对应主画板左对齐，排在其**正下方**，垂直依次堆叠间隔 `80px`；无 `parentRef` 的非主画板排在最后一列主画板右侧或下方且严格做矩形防碰撞。

### 2.4 前置边界收口协议（ScopeProposal）
```ts
export interface ScopeScreenPlan {
  refId: string;
  name: string;
  role: "primary" | "overlay" | "exception" | "detail";
  parentRef?: string;
  width: number;
  height: number;
  summary: string;
  reusedComponents?: string[];
  customModules?: string[];
}

export interface ScopeDecisionOption {
  question: string;
  defaultChoice: string;
  alternatives?: string[];
}

export interface ScopeProposal {
  summary: string;
  targetLibraryId?: string;
  targetLibraryName?: string;
  screens: ScopeScreenPlan[];
  reusedAssets: string[];
  customModules: string[];
  decisions?: ScopeDecisionOption[];
}
```

- 仅当请求**未传 `confirmedScope`** 且需求属于复杂模糊多画板任务时，AI 可在首轮调用 `propose_scope_plan` 返回 `mode: "clarify"` + `scopeProposal`；
- 用户点击「确认并直接生成」或补充文字后，请求携带 `confirmedScope`，后端强制禁用 `propose_scope_plan` 工具并注入「已确认范围，立即一镜到底生成」指令，确保生成阶段**全程零人工中断**。

### 2.5 Stage 2 / Stage 3 三维记忆作用域预埋契约
```ts
export interface DesignMemoryScope {
  projectId?: string;
  libraryId?: string;
  userId?: string;
}
```
本阶段在 `DesignChatContext`、`AgentChatRequest` 与 `server/agent-http.ts` 校验器中预埋可选 `memoryScope?: DesignMemoryScope`，Stage 2 接入 `EpisodeStore`（项目历史需求与衍生模块回流）和 Stage 3 接入 `PreferenceStore`（`User × Library` 交叉偏好 Diff 提炼）时无需修改前后端通信协议。

---

## 三、模块划分与并行施工文件所有权（零冲突隔离）

### Phase 1 · 三轨并行施工

| 轨道 | 独占文件 | 核心职责 |
| --- | --- | --- |
| **Track A（Codex Worker A）** | `src/domain/library-schema.ts`<br>`src/domain/library-packaging.ts`<br>`src/agent/library-intelligence.ts`（新）<br>`tests/agent-library-intelligence.test.ts`（新） | 三级资产可选字段扩展；打包/提取兼容保真；离线三级自动分层、槽位硬契约 Manifest 提取、增量可编辑 Playbook Markdown 生成与检索。 |
| **Track B（Codex Worker B）** | `src/agent/html-to-forma.ts`<br>`src/editor/html-forma-sandbox.ts`<br>`tests/agent-hybrid-compiler.test.ts`（新） | HTML `[data-forma-component]` 占位尺寸水合与原装受保护 `Instance` 实例化 + 合法覆写；新造模块库 Token 自动吸附；多画板主流程横向/异常态纵向矩阵排布与单笔原子事务合并。 |
| **Track C（Codex Worker C）** | `src/agent/blueprint-compiler.ts`<br>`tests/agent-block-adapt.test.ts`（新） | Blueprint `type: "component"` 模块派生加工 `adapt`（仅解组外层容器、保留内部子组件实例、允许增删改外层结构）；Blueprint 多画板 `role`/`parentRef` 主/异常矩阵排布。 |

### Phase 2 · 集成联调（Phase 1 全通过后启动）

| 轨道 | 独占文件 | 核心职责 |
| --- | --- | --- |
| **Track D1（Codex Worker D1）** | `src/agent/forma-tools.ts`<br>`src/agent/context-builder.ts`<br>`src/agent/design-engine.ts`<br>`server/agent-http.ts`<br>`tests/agent-tools.test.ts`<br>`tests/agent-http-integration.test.ts` | 新增 `get_library_playbook`、`inspect_component_structure`、`propose_scope_plan`；升级 `search_components`（`tier` 与槽位契约）与 `propose_html_design`（多画板与组件插槽预校验）；升级 System Prompt 与 `ScopeGate` 确认流转；新增 `POST /api/agent/library-playbook`（离线可用 + 有模型可选润色）。 |
| **Track D2（Codex Worker D2）** | `src/editor/agent-client.ts`<br>`src/editor/AgentPanel.tsx`<br>`src/editor/CanvasAgentBar.tsx`<br>`src/editor/LibraryManagerModal.tsx`<br>`src/editor/AssetsPanel.tsx`<br>`src/editor/agent-ui.css`<br>`src/editor/assets-panel.css`<br>`scripts/check-agent-canvas-chat.browser.js` | 品牌统一 **Forma AI**；面板目标组件库选择器与 AI 说明书徽标；多画板 `htmlDraft` 编译及 `ScopeProposalCard` 一键确认直出；组件库管理中心「AI 说明书」查看/编辑/刷新界面；保存选区组件时标注资产层级与使用说明；扩展浏览器 E2E 用例。 |

---

## 四、安全、兼容性与降级红线

1. **组件实例完整性不变量**：通过 `[data-forma-component]` 实例化的所有组件必须经过标准 `instantiateComponent` 与 `validateInstanceStructure` 校验，不得绕过实例结构保护；`adapt` 派生加工必须通过显式外层 `detachInstance` 操作记录在事务中。
2. **HTML 沙盒安全红线不降级**：仅新增白名单 `data-*` 属性，`sanitizeDesignHtml` 继续剥离一切 `<script>`、`<iframe>`、`on*=`、`javascript:`；浏览器沙盒永久保持 `sandbox="allow-same-origin"`（严禁 `allow-scripts`）。
3. **零模型配置 100% 离线可用**：组件库分层、硬契约扫描、AI 说明书生成/编辑/导出全部纯本地执行，零外网调用。
4. **旧文档与旧工具 100% 向后兼容**：所有新增 schema 字段、请求参数、画板 `artboards[]` 均为可选，既有 425 项单测与 7 工具 MCP Server 零破坏。
