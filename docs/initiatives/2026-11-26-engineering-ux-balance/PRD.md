# Forma 全栈工程质量与用户体验平衡升级（P0 / P1 / P2）PRD

- **状态**：已实施并验收
- **启动日期**：2026-11-26
- **负责人**：Forma 架构与产品团队
- **关联长期规格**：[ARCHITECTURE.md](../../ARCHITECTURE.md) · [EDITOR-UI-CONTROLS.md](../../specs/EDITOR-UI-CONTROLS.md) · [AGENT-PROVIDER-AND-CANVAS-CHAT.md](../../specs/AGENT-PROVIDER-AND-CANVAS-CHAT.md) · [VERSIONING-AND-DESKTOP.md](../../specs/VERSIONING-AND-DESKTOP.md)

---

## 一、背景与目标

Forma 已具备严肃设计工具的底层领域内核与验证体系，但全仓 Review 暴露出「工程纵深领先于前端架构收敛与产品体验打磨」的结构性失衡。本课题一次性闭环 P0 / P1 / P2 三个梯队的工程与用户体验升级，使 Forma 在**架构健壮性、首屏性能、样式可维护性、桌面端原生心智与空画布新手体验**上全面对齐成熟商业产品标准。

---

## 二、范围与验收标准

### P0 · 产品级容错与基础体验收口
1. **分层 React `ErrorBoundary` 与防丢稿应急导出**：
   - 顶层、左侧面板、中央画布、右侧属性栏、浮层弹窗独立隔离错误边界；
   - 局部面板异常时可一键「重试加载此面板」而不牵连画布；画布或整页异常时提供「立即导出当前设计文件（`.forma.json`）」与恢复入口，确保设计师零丢稿。
2. **桌面端 vs Web 端心智对齐与统一产品词汇**：
   - `window.formaDesktop` 桌面客户端显示「已保存到本机」，Web 端保留「已保存到此浏览器」并去除 `IndexedDB` 等研发术语；
   - 统一画板预设分组文案（去除中英混杂的 `Phone / 平板横屏`），统一文件管理与空态说明口吻。
3. **左侧导航栏「视图切换」与「快捷动作」视觉分层**：
   - 顶部为左侧主视图 Tab（`图层` / `资源` / `助手`），通过清晰分隔线与底部一次性工具入口（`导入` / `操作` / `变量`）区隔，在宽屏纵栏与窄屏横栏下均清晰一致。

### P1 · 工程架构止血、包体瘦身与自动门禁
1. **应用层会话控制下沉 + 巨石组件瘦身**：
   - 将纯逻辑的 AI 会话范围校验、提案组装与记忆归档元数据抽取至 `src/application/agent-session.ts`（零 React/DOM 依赖）；
   - 将流式编排与视觉优化状态机抽取至 `src/editor/agent/useAgentSession.ts`，并将 3,337 行的 `icon-library.ts` 改为编译时动态懒加载，使 `AgentPanel.tsx` 收束为清晰的视图装配组件。
2. **首屏包体瘦身（懒加载 + 分包）**：
   - 按需懒加载非首屏重型弹窗与面板（`ModelConfigModal`、`FileBrowser`、`DevModePanel`、`DesignLintPanel`、`BatchExportModal`、`PreviewDialog`、`CodePreviewModal`、`DesignImportDialog`、`PromoteModuleModal`、`ReleaseNotesDialog`、`ColorProfileDialog` 等）；
   - 在 `vite.config.ts` 配置合理 `manualChunks` 拆分第三方大依赖（`paper`、`zod`、`lucide-react` 等），显著压低主入口 `index-*.js` 体积。
3. **修复架构越层引用 + 自动化架构边界门禁（`npm run lint:arch`）**：
   - 修复 `src/domain/library-promotion.ts -> src/agent/ & src/design-system/` 与 `src/compiler/ -> src/infrastructure/` 两类分层越界；
   - 新增 `scripts/check-architecture.mjs` 与 `tests/architecture-boundaries.test.ts`，把依赖方向、`: any` / `@ts-ignore` 零回归、CSS `!important` 上限固化进 `npm test`。
4. **模块化拆分单体 AI E2E 用例**：
   - 将 2,586 行 `scripts/check-agent-canvas-chat.browser.js` 中的 Mock 模型服务端与组件库夹具拆分为独立可维护模块 `scripts/browser-checks/agent/fixtures.mjs`，保持 100% 既有断言覆盖。

### P2 · CSS 级联层体系化治理与空画布引导体验
1. **CSS `@layer` 架构升级与 `!important` 大幅清零**：
   - 建立 `src/editor/layers.css` 声明 `@layer legacy, design-system, ui3, panels, overrides;`；
   - 将 7 份编辑器样式表纳入明确级联层，将 `!important` 从 **223 处大幅压降至 ≤ 20 处**，且保持 `.canvas-world` / `.runtime-stage` 完全隔离与双主题 0 视觉回归。
2. **空画布温和引导卡片（`CanvasWelcomeOverlay`）**：
   - 空白文件且处于选择工具（`doc.nodes.length === 0 && tool === "select"`）时，在画布中央呈现克制的快速开始卡：一键新建移动端/桌面端画板、唤起 Forma AI（`⌘↵`）、导入 `.fig`/`.sketch`/`.forma` 或打开内置高质量示例；
   - 切换任何绘图工具（如按 `F` / `R` / `T`）、创建任意图层或手动关闭后立即退场，绝不阻挡键盘创作与画布拖绘。

---

## 三、明确不做（非目标）

- 不改写文档 `schemaVersion` 格式，不破坏历史 `.forma.json` / `.fig` / `.sketch` 兼容。
- 不改变既有外部快捷键与无障碍访问名称，不破坏既有 E2E 公开行为契约。
- 不引入需要外网下载的新运行时依赖。
