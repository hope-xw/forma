# 任务清单与进度台账 · 资源面板一致性重构与成熟组件库管理体系

- **课题编号**：`2026-11-25-assets-and-library-manager`
- **负责人**：主控架构师（统筹规格、验收与集成）+ 多路 Codex CLI 并行施工
- **状态图例**：`[ ]` 待开始 · `[/]` 进行中 · `[x]` 已完成

---

## Phase 0 · 规范建制与课题立项

- [x] **T0.1** 调研现有 `AssetsPanel`、`styles.css`、`ui3-theme.css`、组件库事务、`design-import` Worker 与浏览器 E2E 契约。
- [x] **T0.2** 完成课题 `PRD.md`、`ENGINEERING.md`、`TASKS.md` 并登记到 `docs/initiatives/README.md`。
- [x] **T0.3** 创建长期规格 `docs/specs/COMPONENT-LIBRARY-MANAGEMENT.md` 并登记到 `docs/specs/README.md`。

---

## Phase 1 · 三轨并行施工（Codex CLI，严格文件隔离，零冲突）

### 轨道 A（Codex Worker A）：共享 Kit 构建原语 + Material Design 3（Android）+ shadcn/ui（现代 Web）
- **独占文件**：
  - `src/design-system/kit-builder.ts`
  - `src/design-system/material3.ts`
  - `src/design-system/shadcn.ts`
  - `tests/design-system-kits-a.test.ts`
- [x] **T1.A1** 实现 `kit-builder.ts`（零 React 依赖构建器、Lucide 矢量路径复用、Light/Dark DesignSystem 变量集合生成与自动绑定）。
- [x] **T1.A2** 实现 `material3.ts`（`forma-material3-v1`，18 类 Android Material 3 核心组件、136 个明暗变体、M3 字阶与圆角规范、2 套 Android 整页模板）。
- [x] **T1.A3** 实现 `shadcn.ts`（`forma-shadcn-v1`，16 类 shadcn/ui 现代 SaaS 核心组件、104 个明暗变体、Zinc 明暗双主题变量、Tailwind 字阶与圆角规范、2 套 Web 整页模板）。
- [x] **T1.A4** 编写并通过 `tests/design-system-kits-a.test.ts`（19/19 通过 + 8/8 导出工程内存构建通过）。

### 轨道 B（Codex Worker B）：Ant Design 5（Web 中后台）内置组件库
- **独占文件**：
  - `src/design-system/antd5.ts`
  - `tests/design-system-antd5.test.ts`
- [x] **T1.B1** 实现 `antd5.ts`（`forma-antd5-v1`，20 类 Ant Design 5 核心中后台组件、156 个明暗变体、AntD v5 明暗双主题 DesignSystem 变量、字阶与圆角规范、2 套 1440×900 中后台整页模板）。
- [x] **T1.B2** 编写并通过 `tests/design-system-antd5.test.ts`（13/13 通过 + 4/4 导出工程内存构建通过）。

### 轨道 C（Codex Worker C）：组件库管理领域事务 + 打包提取内核 + 本地仓库 + `.fig/.sketch` 提取 Worker
- **独占文件**：
  - `src/domain/commands.ts`（新增 `removeLibrary` 原子事务与跨页实例保护）
  - `src/domain/library-packaging.ts`（实例计数、文档主组件打包建库、已导入文档组件提取）
  - `src/infrastructure/library-catalog-store.ts`（按文档启停状态持久化 + 工作区跨文件自定义库 IndexedDB 仓库）
  - `src/infrastructure/design-import/library-extract-worker.ts`（离线 `.fig`/`.sketch` 提取组件库 Worker）
  - `tests/library-management.test.ts`
- [x] **T1.C1** 实现 `removeLibrary` 事务与跨页（含嵌套槽位）实例保护校验。
- [x] **T1.C2** 实现 `library-packaging.ts`、`library-catalog-store.ts` 与 `library-extract-worker.ts`（3 种原生 `.fig`/`.sketch` 样本实测通过）。
- [x] **T1.C3** 编写并通过 `tests/library-management.test.ts`（12/12 通过）。

---

## Phase 2 · 统一目录聚合 + 双轨并行施工（UI 重构 & 画布/Agent/E2E 联动）

- [x] **T2.0** 主控汇总 `src/design-system/catalog.ts`（接入 iOS / Material 3 / AntD 5 / shadcn 四大内置库、98 类组件、686 个变体与 10 套模板）并运行阶段性类型检查。

### 轨道 D（Codex Worker D）：图 1 资源面板彻底重构 + 组件库管理中心弹窗
- **独占文件**：
  - `src/editor/assets-panel.css`
  - `src/editor/LibraryManagerModal.tsx`
  - `src/editor/AssetsPanel.tsx`
  - `src/editor/App.tsx`（仅 `.assets-sidebar` 类与快捷键/弹窗集成）
  - `src/editor/ui3-theme.css`（仅清理 `.assets-panel` 旧高度与补充 `.assets-sidebar` flex 布局）
- [x] **T2.D1** 彻底修复图 1 中高度错位、Grid 空白拉伸、色块黏连、字阶失衡、双层缩进、硬编码浅色卡片与全局 `section` 内边距泄漏等全部布局与视觉一致性问题，完整适配深浅双主题与短窗口（实测 `indent: 0px`、`rowHeight: 28px`、`minSwatchGap: 14px`）。
- [x] **T2.D2** 落地交互升级：点击规范色块应用到选区/复制 HEX、点击字号规格应用或插入样例文本、按体系筛选页面模板、紧凑图标化基础元素区。
- [x] **T2.D3** 实现 `LibraryManagerModal.tsx`（官方 4 大体系按文件启停、本文件与工作区自定义库治理、本地 JSON 导入导出、`.fig`/`.sketch` 离线提取建库、打包当前文档主组件、在线订阅整合）。

### 轨道 E（Codex Worker E）：画布多库拖放 + AI Agent 多体系联动 + 浏览器 E2E 用例
- **独占文件**：
  - `src/editor/Canvas.tsx`（拖放解析接入 `findBuiltinLibrary`）
  - `src/agent/forma-tools.ts`（`list_components` / `search_components` 多库元数据与引导优化）
  - `src/agent/context-builder.ts`（多体系组件库摘要透出）
  - `scripts/check-assets-and-libraries.browser.js`（新增端到端验收脚本）
  - `scripts/run-browser-checks.mjs`（登记 `assets-libraries` 场景）
  - `tests/agent-library-catalog.test.ts`（Agent 多库检索与提示单测）
- [x] **T2.E1** 接通 `Canvas.tsx` 多内置库拖放与 AI Agent 多组件库检索上下文。
- [x] **T2.E2** 完成 `scripts/check-assets-and-libraries.browser.js` 端到端测试与单测（35/35 通过）。

---

## Phase 3 · 全量回归、前后实拍对比、导出工程验收与文档收口

- [x] **T3.1** 全仓 `npm test`（**425 / 425**）、`npm run format:check`、`npm run build` 全部通过。
- [x] **T3.2** 真实 Chromium 浏览器回归：**9 / 9 通过**（`assets-libraries`、`editor-panels`、`library-tokens`、`library-subscription`、`library-publish`、`panel-gestures`、`component-properties`、`variant-authoring`、`nested-instances`），并归档 9 张对比实拍截图至 `docs/evidence/2026-11-25/assets-and-libraries/`。
- [x] **T3.3** 实际从界面插入 Material 3（Extended FAB）、Ant Design 5（Data Table）与 shadcn/ui（Command Palette）组件、切换变体、保存重开并导出独立 React ZIP 工程，在独立临时目录完成 `npm install && npm run build` 并在真实 Chromium 逐屏运行验证 0 报错。
- [x] **T3.4** 同步更新 `docs/specs/COMPONENT-LIBRARY-MANAGEMENT.md`、`docs/specs/EDITOR-UI-CONTROLS.md`、`docs/EDITOR-ACCEPTANCE.md`、`docs/HANDOFF.md` 与 `TASKS.md` 结项状态。

---

## 关键工程决策日志（ADR）

| 日期 | 决策 | 原因与权衡 |
| --- | --- | --- |
| 2026-11-25 | **内置 4 大体系均采用自研原生 Forma 图层 + 明暗 DesignSystem 变量，默认仅启用 iOS（Forma Mobile）** | 遵守项目版权边界与离线可用要求；默认仅启用 iOS 保证空白文件零膨胀且 100% 兼容既有 374 单测和全部 Playwright E2E 脚本，其余 3 套在组件库管理中心一键按需启用。 |
| 2026-11-25 | **新增独立 `library-extract-worker.ts` 负责从 `.fig`/`.sketch` 提取组件库，而非改写现有 `worker.ts`** | 零回归风险保护既有原生设计稿整文件导入流程，同时复用同一套 `importFigma` / `importSketch` 离线解析内核。 |
| 2026-11-25 | **新增 `removeLibrary` 原子事务并强校验跨页实例引用** | 防止用户停用或删除组件库时静默破坏画布上已放置的实例，且支持 `⌘Z` 单步撤销恢复。 |
| 2026-11-25 | **为资源面板与组件库管理中心建立独立 `assets-panel.css` 并全部使用 UI3 语义 CSS 变量，同时显式归零全局 `section` 内边距** | 彻底剥离旧版 `styles.css` 中 `#faf9fc` / `#ebe9f1` / `#edf0f5` / `display: grid` / 全局 `section { padding: 18px 16px }` 历史包袱；实测消除 16px 左边缘错位，实现 `indent: 0px`。 |
