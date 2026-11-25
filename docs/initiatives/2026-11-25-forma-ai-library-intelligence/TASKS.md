# 任务清单与进度台账 · Forma AI 组件库智能理解、混合装配与三维设计记忆体系

- **课题编号**：`2026-11-25-forma-ai-library-intelligence`
- **分工治理**：主控架构师（方案设计、任务拆解、质量门禁、项目验收与文档沉淀）+ **Codex CLI**（多轨代码实施与独立 Code Review）
- **状态图例**：`[ ]` 待开始 · `[/]` 进行中 · `[x]` 已完成

---

## Phase 0 · 规范建制与课题立项

- [x] **T0.1** 与用户对齐三大核心决策（双源活体库、`项目×组件库×用户`三维层叠记忆、前置收口零打断一镜到底生成）并确认分步推进策略。
- [x] **T0.2** 创建课题目录 `docs/initiatives/2026-11-25-forma-ai-library-intelligence/`，落盘 `PRD.md`、`ENGINEERING.md`、`TASKS.md` 并登记至 `docs/initiatives/README.md`。
- [x] **T0.3** 创建长期规格文档 `docs/specs/FORMA-AI-LIBRARY-AND-MEMORY.md` 并登记至 `docs/specs/README.md`。

## Phase 1 · Stage 1 核心底座三轨并行施工（Codex CLI，零文件冲突）

### Track A（Codex Worker A）：活体组件库三级资产 Schema + AI 说明书引擎
- [x] **T1.A1** 扩展 `src/domain/library-schema.ts`（可选 `assetTier`、`aiHints`、`aiGuide`）与 `src/domain/library-packaging.ts`（打包/提取兼容保留与自动分层衔接）。
- [x] **T1.A2** 新建 `src/agent/library-intelligence.ts`（三级自动分层 `classifyComponentTier`、硬契约 `extractComponentManifest`、`buildLibraryManifest`、增量 `generateLibraryPlaybook`、分级检索 `searchLibraryAssets`）。
- [x] **T1.A3** 新建 `tests/agent-library-intelligence.test.ts` 并通过全部单测及 `tsc --noEmit`。

### Track B（Codex Worker B）：插槽化混合装配编译引擎 + 多画板矩阵
- [x] **T1.B1** 升级 `src/agent/html-to-forma.ts`：`[data-forma-component]` 白名单与原装受保护 `Instance` 实例化 + 合法 `overrides`、新造图层库 Token 自动吸附、多画板 `artboards[]` 主/异常矩阵排布与单笔原子事务合并。
- [x] **T1.B2** 升级 `src/editor/html-forma-sandbox.ts`：排版前按真实变体尺寸水合组件占位符，支持多画板沙盒编译合并。
- [x] **T1.B3** 新建 `tests/agent-hybrid-compiler.test.ts` 并通过全部单测及 `tsc --noEmit`。

### Track C（Codex Worker C）：Blueprint 模块外框派生加工 + 多画板矩阵
- [x] **T1.C1** 升级 `src/agent/blueprint-compiler.ts`：支持 `type: "component"` 的 `adapt` 派生加工（仅解组外层容器、保留内部子组件实例、支持增删改外层结构）与多画板 `role`/`parentRef` 主/异常矩阵排布。
- [x] **T1.C2** 新建 `tests/agent-block-adapt.test.ts` 并通过全部单测及 `tsc --noEmit`。

## Phase 2 · 工具链、前置收口引擎与编辑器 UI 集成（Codex CLI）

### Track D1（Codex Worker D1）：Forma AI 工具链、提示词、范围门控与 HTTP 路由
- [x] **T2.D1** 升级 `src/agent/forma-tools.ts`（新增 `get_library_playbook`、`inspect_component_structure`、`propose_scope_plan`；增强 `search_components`、`propose_html_design` 多画板与组件插槽预校验）。
- [x] **T2.D2** 升级 `src/agent/context-builder.ts`、`src/agent/design-engine.ts`、`server/agent-http.ts`（支持 `targetLibraryId`、`confirmedScope`、`memoryScope`、前置收口流转、`POST /api/agent/library-playbook`）。
- [x] **T2.D3** 扩展 `tests/agent-tools.test.ts` 与 `tests/agent-http-integration.test.ts` 并全部通过。

### Track D2（Codex Worker D2）：Forma AI 面板、确认卡与组件库 AI 说明书 UI
- [x] **T2.E1** 升级 `src/editor/agent-client.ts`、`src/editor/AgentPanel.tsx`、`src/editor/CanvasAgentBar.tsx`、`src/editor/agent-ui.css`（统一 **Forma AI** 品牌、目标组件库选择器、多画板插槽沙盒编译、`ScopeProposalCard` 一键确认直出）。
- [x] **T2.E2** 升级 `src/editor/LibraryManagerModal.tsx`、`src/editor/AssetsPanel.tsx`、`src/editor/assets-panel.css`、`src/domain/commands.ts`、`electron/main.mjs`（组件库「AI 说明书」查看/编辑/离线刷新界面；保存组件标注资产层级与使用提示；`putLibrary` 非结构 AI 元数据更新许可；Electron `library-playbook` 路由转发）。
- [x] **T2.E3** 扩展 `tests/library-management.test.ts` 与 `scripts/check-agent-canvas-chat.browser.js` 覆盖目标库选定、AI 说明书编辑、前置收口确认卡、多画板主/异常矩阵混合组件生成与手改/单步撤销。

## Phase 3 · 独立 Codex CLI Code Review、全量回归与真机端到端验收

- [x] **T3.1** 调用独立只读 Codex CLI Reviewer 完成全量 20 文件深度审查，定位 3 项 P0、16 项 P1、3 项 P2，经 F1–F5 五轮精准修复与三轮独立复审，最终签收 **PASS**（22/22 全部闭环、0 遗留）。
- [x] **T3.2** 全量质量门禁：`npm test`（**493 / 493**，含真实回环 TCP 配对与并发发布）、`npm run format:check`、`npm run build`、`npm run desktop:agent` 100% 通过。
- [x] **T3.3** 真实 Chromium 浏览器 E2E 验收 **7 / 7 通过**（`agent-canvas-chat`、`assets-libraries`、`editor-panels`、`optional-gateway`、`panel-parity`、`library-tokens`、`mcp`）+ 仿真淘宝移动端三级组件库全链路（离线说明书编辑与焦点返回、双主题 6.41–7.36:1 对比度、范围拍板一键直出、双画板截图视觉自审、原装受保护实例画布改字/切变体/单步撤销、官方 `verify-exports.mjs agent-canvas-chat` 独立安装构建并双屏渲染导出 ZIP 零报错）全部通过。
- [x] **T3.4** 同步更新 `docs/specs/FORMA-AI-LIBRARY-AND-MEMORY.md`、`docs/EDITOR-ACCEPTANCE.md`、`docs/HANDOFF.md`、`docs/ARCHITECTURE.md`、归档 `docs/evidence/2026-11-25/forma-ai-stage1/acceptance.json` 与本台账结项状态。

---

## Stage 2 / Stage 3 后续里程碑（本轮明确不提前铺开）

- [ ] **Stage 2** · 项目空间级《历史需求档案（Episode）》自动沉淀、语义召回、`@历史需求` 引用与衍生模块回流资产库。
- [ ] **Stage 3** · `用户 × 组件库` 交叉偏好 Diff 自动提炼与记忆可视化管理面板。

---

## 关键工程决策日志（ADR）

| 日期 | 决策 | 原因与权衡 |
| --- | --- | --- |
| 2026-11-25 | **HTML-to-Forma 通过标准 `data-forma-component` 属性嵌入原装组件插槽** | 相比自定义非标准 XML 标签，标准 `<div>` + `data-*` 属性 100% 兼容 HTML5 解析与 CSS Flex/Grid，且不会破坏现有 `sanitizeDesignHtml` 安全白名单；排版前按变体根尺寸水合内在宽高，编译期原地替换为受保护原生 `Instance`。 |
| 2026-11-25 | **AI 说明书采用「离线确定性 Manifest + 增量可编辑 Playbook Markdown」双层设计** | 严格恪守「零模型网关时全功能可用」红线；导入 `.fig`/`.sketch` 或在 Forma 原生增删组件时毫秒级自动重算硬契约，并保留设计师手写业务备注块不被覆盖。 |
| 2026-11-25 | **复杂多页需求采用「前置 1 轮 `propose_scope_plan` + 确认后禁用澄清工具」机制** | 既防止模糊大需求盲画多页跑偏，又在机制上杜绝生成中途反复弹窗打断，确保确认后一镜到底交付全套主流程 + 异常态画板。 |
| 2026-11-25 | **Stage 1 即预埋 `memoryScope: { projectId?, libraryId?, userId? }` 通信契约** | 为 Stage 2（项目历史需求档案）与 Stage 3（`用户 × 组件库` 交叉偏好）提供稳定的三维作用域锚点，避免后续协议破坏性重构。 |
