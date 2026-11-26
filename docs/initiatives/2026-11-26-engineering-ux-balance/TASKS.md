# Forma 全栈工程质量与用户体验平衡升级（P0 / P1 / P2）任务清单

- **课题状态**：已实施并验收
- **最后更新**：2026-11-26

## 阶段一：立项与分工
- [x] 建立课题目录 `PRD.md`、`ENGINEERING.md`、`TASKS.md` 并登记索引

## 阶段二：四路并行 Codex CLI 施工（零文件重叠）
- [x] **Track A（架构边界与自动门禁）**
  - [x] 迁移纯领域 `src/domain/library-intelligence.ts` 与 `OFFICIAL_BUILTIN_LIBRARY_IDS` 消除 `domain -> agent/design-system` 越层
  - [x] 迁移纯 `src/domain/document-parts.ts` 与纯 SVG `src/compiler/svg-export.ts`（保留纯回调 `configureSvgTextWidth` 以维持浏览器画布测宽零漂移）消除 `compiler -> infrastructure` 越层
  - [x] 新增 `scripts/check-architecture.mjs`、`npm run lint:arch` 与 `tests/architecture-boundaries.test.ts`（实测 `Architecture PASS (0 violations)`）
- [x] **Track B（AI 应用层下沉、图标懒加载与 E2E 模块化）**
  - [x] 抽离纯逻辑 `src/application/agent-session.ts`（281 行，零 React/DOM 依赖）与 React Hook `src/editor/agent/useAgentSession.ts`
  - [x] `icon-library.ts`、`html-forma-sandbox.ts` 与 `design-system/catalog.ts` 改为动态 `import()` 按需加载，`AgentPanel.tsx` 从 2,595 行瘦身至 674 行并保留全部 14 项公开导出
  - [x] 抽离 `scripts/browser-checks/agent/fixtures.mjs` 精简单体 AI E2E 脚本，补齐 `tests/agent-session-application.test.ts`（12 项单测）
- [x] **Track C（ErrorBoundary、产品文案表与空画布引导）**
  - [x] 新增分层 `src/editor/ErrorBoundary.tsx`（`workspace` / `panel` / `modal`，支持 `resetKey` 自动恢复与一键导出 `.forma.json` 防丢稿备份）
  - [x] 新增 `src/editor/ux-copy.ts`（桌面端 `已保存到本机` / Web 端 `已保存到此浏览器`、去除 `IndexedDB` 研发术语、全中文统一画板预设词表）并打磨 `FileBrowser.tsx`
  - [x] 新增非阻塞空画布快速开始卡 `src/editor/CanvasWelcomeOverlay.tsx` 与 `tests/error-boundary-and-ux.test.ts`（12 项单测）
- [x] **Track D（CSS `@layer` 架构与 `!important` 治理）**
  - [x] 新增 `src/editor/layers.css` 建立 5 级级联层（`@layer legacy, design-system, ui3, panels, overrides;`）并纳入全部 7 份编辑器样式表
  - [x] 清理全仓 `!important` 从 **223 处降至 3 处（-98.7%）**，并补齐 ErrorBoundary、空画布引导卡与左侧导航分组分隔线（`.panel-tabs-sep`）双主题样式

## 阶段三：主干集成、全量验证与发版打包
- [x] Review 四路代码 diff 并完成 `App.tsx`、`main.tsx`、`Canvas.tsx`、`file-actions.ts`、`vite.config.ts`、`package.json` 集成（分层 ErrorBoundary、12 个重型弹窗/面板懒加载、左侧导航分组、`manualChunks` vendor 分包、桌面保存文案与空画布引导接入）
- [x] 门禁验证：`npm run lint:arch`（0 违例、`as any: 1/1`、`CSS !important: 3/25`）、`npm run format:check`、`npm run build`（主入口 `index-*.js` 从 **2,200.50 kB / gzip 727.28 kB** 降至 **1,028.49 kB / gzip 339.70 kB（-53.3%）**，确认 `catalog` / `icon-library` / `export-project` 均不进入首屏 preload）、全量 `npm test`
- [x] 真实 Chromium 浏览器回归（18 项核心 E2E + 4 份 React ZIP 导出工程验证，含 `text-position` 零像素偏移复验）+ 6 张深浅 2× Retina 视觉实拍人工核验（归档至 `docs/evidence/2026-11-26/engineering-ux-balance/`）
- [x] 更新 `docs/ARCHITECTURE.md`、`docs/HANDOFF.md`、`docs/EDITOR-ACCEPTANCE.md` 及本课题结项记录
- [x] 执行 `npm run release:assess` 与 `npm run release:run` 完成 `0.11.0 → 0.12.0` 发版、桌面端打包与只读挂载 DMG 实机验收
