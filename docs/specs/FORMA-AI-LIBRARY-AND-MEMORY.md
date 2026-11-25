# Forma AI 组件库智能理解、混合装配与三维设计记忆规格

- **最近更新日期**：2026-11-25
- **状态**：已实施并验收（Stage 1；Stage 2 历史需求档案与 Stage 3 `用户×组件库`交叉偏好为规划项）
- **关联源码**：
  - 资产分层与校验：[library-schema.ts](../../src/domain/library-schema.ts)、[library-packaging.ts](../../src/domain/library-packaging.ts)
  - 离线组件库智能引擎：[library-intelligence.ts](../../src/agent/library-intelligence.ts)
  - 插槽化混合编译与模块派生：[html-to-forma.ts](../../src/agent/html-to-forma.ts)、[html-forma-sandbox.ts](../../src/editor/html-forma-sandbox.ts)、[blueprint-compiler.ts](../../src/agent/blueprint-compiler.ts)
  - 工具链、前置收口与 HTTP 路由：[forma-tools.ts](../../src/agent/forma-tools.ts)、[context-builder.ts](../../src/agent/context-builder.ts)、[design-engine.ts](../../src/agent/design-engine.ts)、[agent-http.ts](../../server/agent-http.ts)
  - 编辑器界面：[AgentPanel.tsx](../../src/editor/AgentPanel.tsx)、[CanvasAgentBar.tsx](../../src/editor/CanvasAgentBar.tsx)、[LibraryManagerModal.tsx](../../src/editor/LibraryManagerModal.tsx)、[AssetsPanel.tsx](../../src/editor/AssetsPanel.tsx)
- **关联课题**：[2026-11-25-forma-ai-library-intelligence](../initiatives/2026-11-25-forma-ai-library-intelligence/PRD.md)
- **验收方式**：单测 `tests/agent-library-intelligence.test.ts`、`tests/agent-hybrid-compiler.test.ts`、`tests/agent-block-adapt.test.ts`、`tests/agent-tools.test.ts`、`tests/agent-http-integration.test.ts` + 浏览器 E2E `npm run test:browser -- agent-canvas-chat assets-libraries editor-panels mcp`

---

## 一、活体组件库三级资产与双层说明书

### 1.1 三级资产分层（`assetTier`）
所有组件库（内置 4 大体系、`.fig`/`.sketch` 离线提取库、Forma 原生自建/打包库）的每个组件条目均可携带可选 `assetTier`：
- `page`（页面样板）：整屏骨架（典型宽 ≥ 320px 且高 ≥ 520px，或命名/分类命中页面/模板/会场/屏幕等特征）。
- `block`（业务模块/楼层）：通栏或复合区块（典型宽 ≥ 260px 且含复合子层，或命中楼层/模块/导航栏/商品流/列表/卡片组/浮层/表单区等特征）。
- `component`（原子组件）：按钮、标签、开关、输入框、角标、图标按钮、空状态控件等基础单元。

未显式指定 `assetTier` 时，运行时通过 `classifyComponentTier()` 按确定性规则自动推断，确保历史组件库零迁移成本。

### 1.2 双层说明书（Manifest + Playbook）
- **硬契约（Manifest）**：纯本地离线扫描每个组件的根尺寸、伸缩模式、变体矩阵、文本槽位（`templateKey` + 默认文案 + 推荐字数上限）、图像槽位（宽高比）、可替换子组件插槽（`swap`）及设计系统 Token 摘要。
- **业务说明书（Playbook）**：随库保存在可选 `library.aiGuide`（`playbookMarkdown`、`visualPrinciples`、`compositionRules`、`exceptionPatterns`），采用兼容 `SKILL.md` 的结构化 Markdown，支持在「组件库管理」中离线一键生成、增量刷新与手动编辑；手动备注区（`<!-- forma:custom-notes -->`）在增量刷新时严格保留。

---

## 二、插槽化混合装配与模块派生

1. **HTML-First 原装组件插槽**：
   - `propose_html_design` 支持在 HTML 中以 `<div data-forma-component="<componentId>" data-library="<libraryId>" data-variant="<variantId>" data-variant-props='{...}' data-overrides='{...}'></div>` 声明原装库组件。
   - 浏览器无脚本沙盒在测量前水合真实组件变体尺寸；编译时通过 `instantiateComponent` 原地实例化受保护原生 `Instance` 并应用合法 `overrides`（文案、外观、公开插槽），不退化为普通图层。
   - 非组件实例的新造自定义图层在启用目标库时自动吸附库内语义颜色与圆角变量（`variableBindings`）。
2. **Blueprint 模块外框派生（`adapt`）**：
   - 当需求需基于现有 `block` 二次加工时，Blueprint `type: "component"` 支持 `adapt: { detachOuter: true }`：实例化基础模块后仅显式解组最外层容器以支持修改布局、增删子层，同时完整保留内部嵌套原子组件实例的受保护身份。
3. **多画板主流程与异常态矩阵排布**：
   - `propose_html_design` 与 `propose_design_changes` 均支持多画板 `role`（`primary` / `overlay` / `exception` / `detail`）与 `parentRef`；
   - `primary` 画板横向排列（间距 `80px`），关联 `overlay`/`exception`/`detail` 画板纵向对齐排在对应主画板下方（间距 `80px`），合入同一原子事务，支持一次 `⌘Z` 单步撤销。

---

## 三、前置边界收口与一镜到底生成（Scope-First Gate）

- **清晰/单页/局部编辑需求**：不触发澄清，直接执行生成或修改提案。
- **复杂模糊多页需求（未确认范围）**：Forma AI 在动笔前调用 `propose_scope_plan` 返回 1 轮结构化《生成范围确认卡（`ScopeProposal`）》（含拟出画板列表及角色、拟复用库资产、拟新造模块、带默认值的关键决策）。
- **确认后零打断执行**：设计师点击「确认并直接生成」或在对话补充确认后，请求携带 `confirmedScope`，后端锁定执行态并禁用澄清工具，后台一气呵成完成多画板装配与视觉自审。

---

## 四、规划边界（Stage 2 & Stage 3，当前未实施）

- **已预埋契约**：`DesignMemoryScope = { projectId?, libraryId?, userId? }` 已接入请求与上下文类型定义。
- **Stage 2（规划项）**：项目空间级《历史需求档案（Episode）》持久化与语义召回、衍生模块回流组件库。
- **Stage 3（规划项）**：采纳快照与设计师手改终稿 Diff 提炼 `(用户 × 组件库)` 交叉偏好及记忆可视化管理面板。
