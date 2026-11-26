# Forma AI 组件库智能理解、混合装配与三维设计记忆规格

- **最近更新日期**：2026-11-26
- **状态**：已实施并验收（Stage 1 & Stage 2；Stage 3 `用户×组件库`交叉偏好为规划项）
- **关联源码**：
  - 资产分层与校验：[library-schema.ts](../../src/domain/library-schema.ts)、[library-packaging.ts](../../src/domain/library-packaging.ts)、[library-promotion.ts](../../src/domain/library-promotion.ts)
  - 离线组件库智能与项目记忆引擎：[library-intelligence.ts](../../src/agent/library-intelligence.ts)、[project-memory.ts](../../src/agent/project-memory.ts)
  - 持久化仓库与原子围栏：[project-memory-store.ts](../../src/infrastructure/project-memory-store.ts)、[library-catalog-store.ts](../../src/infrastructure/library-catalog-store.ts)、[storage.ts](../../src/infrastructure/storage.ts)、[storage-parts.ts](../../src/infrastructure/storage-parts.ts)
  - 插槽化混合编译与模块派生：[html-to-forma.ts](../../src/agent/html-to-forma.ts)、[html-forma-sandbox.ts](../../src/editor/html-forma-sandbox.ts)、[blueprint-compiler.ts](../../src/agent/blueprint-compiler.ts)
  - 工具链、前置收口与 HTTP 路由：[forma-tools.ts](../../src/agent/forma-tools.ts)、[context-builder.ts](../../src/agent/context-builder.ts)、[design-engine.ts](../../src/agent/design-engine.ts)、[agent-http.ts](../../server/agent-http.ts)
  - 编辑器界面：[AgentPanel.tsx](../../src/editor/AgentPanel.tsx)、[CanvasAgentBar.tsx](../../src/editor/CanvasAgentBar.tsx)、[FileBrowser.tsx](../../src/editor/FileBrowser.tsx)、[PromoteModuleModal.tsx](../../src/editor/PromoteModuleModal.tsx)、[LibraryManagerModal.tsx](../../src/editor/LibraryManagerModal.tsx)、[AssetsPanel.tsx](../../src/editor/AssetsPanel.tsx)、[ContextMenu.tsx](../../src/editor/ContextMenu.tsx)、[PagesPanel.tsx](../../src/editor/PagesPanel.tsx)
- **关联课题**：[2026-11-25-forma-ai-library-intelligence](../initiatives/2026-11-25-forma-ai-library-intelligence/PRD.md) · [2026-11-25-forma-ai-stage2-project-memory](../initiatives/2026-11-25-forma-ai-stage2-project-memory/PRD.md)
- **验收方式**：单测 `tests/project-memory.test.ts`、`tests/library-promotion.test.ts`、`tests/agent-library-intelligence.test.ts`、`tests/agent-hybrid-compiler.test.ts`、`tests/agent-block-adapt.test.ts`、`tests/agent-tools.test.ts`、`tests/agent-http-integration.test.ts` + 浏览器 E2E `npm run test:browser -- agent-canvas-chat assets-libraries editor-panels optional-gateway library-tokens panel-parity mcp files storage` + 导出验证 `npm run test:exports -- agent-canvas-chat`

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

## 四、轻量项目空间、历史需求记忆与衍生模块回流（Stage 2，已实施并验收）

### 4.1 轻量项目空间（Project Space）与零门槛草稿隔离
- **层级模型**：`Project Space（proj:<projectId>） → Design File → Page`。升级既有「本机文件」弹窗（[FileBrowser.tsx](../../src/editor/FileBrowser.tsx)）为两栏布局：左侧管理「全部文件 / 未归类草稿 / 自定义项目空间」，支持新建、重命名、删除项目（删除项目仅释放文件回「未归类草稿」并清理该项目级共享档案，不删除设计文件本身）与绑定项目默认组件库。
- **零门槛草稿与自动随迁**：未归类草稿默认隔离在单文件记忆作用域 `file:<fileKey>`；一旦将草稿归入项目空间，原单稿历史档案自动随迁至 `proj:<projectId>`（并按捕获指纹与用户自定义标题/摘要智能去重或保留）。在某项目视图内新建、复制或导入的设计稿自动归属该项目；编辑器顶栏实时展示当前所属项目空间徽章。
- **独立持久化与并发隔离**：项目空间、文件归属、历史需求档案与墓碑状态独立存储于 IndexedDB `forma-project-memory-v1`（不升 `forma-studio` 版本，浏览器禁用存储时自动降级内存会话并明确区分持久态）；通过 `forma-studio` 原子 2PC 提交协调（`lifetimeToken` + `replacementEpoch` + 清理/替换意图围栏）保护跨标签整稿替换、页面面板重开样例、恢复上一版与并发删除不串写。

### 4.2 项目级《历史需求档案（DesignEpisode）》与 L2 召回
- **全离线沉淀与管理（零网关可用）**：
  - 采纳 Forma AI 提案（侧栏或画布 HUD）时自动离线构建并落盘结构化档案（`screens`、复用组件计数、`customModules`、已确认决策、中英混合分词 `tags`、`v2:` 完整资源指纹、独立 `captureId` 与安全清洗后的 SVG 缩略图）；
  - 离线「历史需求档案」抽屉支持手动「归档当前选中画板」、关键词检索、置顶/取消置顶（单作用域上限 `100` 条，优先保护置顶条目）、删除与 `@` 显式引用。
- **`Project × Library` 混合召回与只读记忆工具**：
  - `rankProjectEpisodes()` 纯本地确定性召回（支持 CJK 连续二字词 + 英文/数字词混合分词，同稿优先、同库加权、显式 `@历史需求` 置顶，最多携带 `8` 条显式引用且不含 SVG 缩略图）；
  - `POST /api/agent/chat` 经严格 Zod 校验接收 `memoryScope`、`recalledEpisodes` 与 `mentions[kind="episode"]`，动态按需挂载只读工具 `search_project_episodes` 与 `get_episode_details`；
  - 侧栏与画布 `@` 弹窗均提供「历史需求」标签页，并在调用详情中展示实际召回的历史档案列表。

### 4.3 衍生模块一键回流沉淀至组件库
- **多入口触达**：画布右键菜单、左侧资源面板工具条与 Forma AI 应用后操作栏统一提供「沉淀为组件库模块…」弹窗（[PromoteModuleModal.tsx](../../src/editor/PromoteModuleModal.tsx)），纯本地离线可用。
- **只读官方库保护与原子同步**：严禁改写四大官方内置组件库；支持一键沉淀至当前项目的专属衍生库（`proj-lib-<projectId>`，自动创建或追加）或已有自定义组件库；自动推断 `assetTier`、归并所引用的变量/样式/字体/图片依赖、递增修订号、**增量刷新目标库 `aiGuide` 说明书（严格保留 `<!-- forma:custom-notes -->` 手写备注）**，并通过带紧凑提交回执的 CAS 事务同步至 `forma-workspace-libraries-v1`（v2 独立 `fences` 仓）以跨文件复用；可选原地替换为受保护原生组件实例且支持单步 `⌘Z` 撤销。

---

## 五、规划边界与当前已知边界

- **Stage 3（规划项，当前未实施）**：采纳快照与设计师手改终稿 Diff 提炼 `(用户 × 组件库)` 交叉偏好、跨项目偏好迁移与独立记忆可视化管理面板。
- **Stage 2 当前已知边界**：
  1. 极端多标签离线满仓竞态（单作用域已存在 97–98 条置顶档案、同时触发离线草稿迁移与外部并发写入抢占最后容量位）按常规容量淘汰顺序处理；
  2. 仅影响自动归档画板候选排序、不丢失任何持久化档案的极边界：含无点 `ı` / NFC-NFD 组合音标的非 ASCII 字体族名差异，以及单次提案把 24 张以上画板同时改绑到同色值新 Token 时的受影响画板排序；
  3. 浏览器 E2E 与导出工程验证在 Chromium 完成，Firefox / WebKit 跨引擎复测待按需补跑。
