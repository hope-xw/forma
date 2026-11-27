# Forma 多文件顶部 Tab 工作台任务清单

- **课题状态**：已实施并验收（随 v0.14.0 发布）
- **最后更新**：2026-11-27

## 阶段一：立项与并行分工
- [x] 与用户确认 Figma 风格单窗口多 Tab 工作台方案（含全部 4 处触点与桌面 `open-file` 入主窗新 Tab）
- [x] 创建课题文档 `PRD.md`、`ENGINEERING.md`、`TASKS.md` 并登记索引

## 阶段二：三路并行 Codex CLI 施工（零文件冲突）
- [x] **Track 1（Tab 状态机 + 36px 顶部 Tab 栏 UI）**
  - [x] 实现纯应用层 `src/application/workspace-tabs.ts`（状态机、去重、重排、关闭栈、URL 与持久化编解码）
  - [x] 实现 `src/editor/WorkspaceTabBar.tsx` 与 `@layer panels` 样式 `src/editor/workspace-tabs.css`（0 `!important`）
  - [x] 新增 `tests/workspace-tabs.test.ts`（20/20 通过）覆盖全状态转换与边界
- [x] **Track 2（Electron 融合标题栏与 `open-file-in-tab` 路由）**
  - [x] 更新 `electron/main.mjs`、`electron/preload.cjs`、`src/vite-env.d.ts` 支持 macOS `hiddenInset`、队列化 `open-file-in-tab`、`newTab`/`closeTab`/`reopenTab` 菜单动作与 `openInNewWindow`/`closeCurrentWindow`
- [x] **Track 3（最近打开子菜单与首页/文件浏览器适配）**
  - [x] 新增 `src/editor/RecentFilesSubmenu.tsx`（左上角 `Forma ▾` 最近打开子菜单）
  - [x] 更新 `src/editor/WorkspaceHome.tsx`、`src/editor/WorkspaceHomeShell.tsx`、`src/editor/FileBrowser.tsx` 接入可选多 Tab 回调与「已打开」徽标并保持独立模式兼容

## 阶段三：主干集成、全量验证、视觉实拍与发版
- [x] 实现 `src/editor/WorkspaceShell.tsx` 并完成 `src/main.tsx`、`src/editor/App.tsx`、`src/editor/useDocument.ts`、`src/editor/useEditor.ts`、`src/editor/DesignImportDialog.tsx`、`src/editor/IntegrationsModal.tsx`、`src/editor/ExternalAgentSession.tsx`、`src/editor/TooltipHost.tsx`、`src/editor/layers.css` 集成
- [x] 新增 `scripts/check-multi-tab.browser.js` 并运行全量门禁（`format:check`、`lint:arch` 0 违规、`build`、`npm test` 971/972 通过、15 组 Chromium E2E、导出验证与 6 张 2× Retina 深浅视觉实拍）
- [x] 更新规格、架构、交接/验收文档并按规则评估执行 `v0.14.0` 发版与只读挂载 DMG 实机验收
