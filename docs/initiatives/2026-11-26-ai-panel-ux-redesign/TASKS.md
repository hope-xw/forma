# Forma AI 对话面板体验重构与模块化拆解任务清单

- **课题状态**：已实施并验收
- **最后更新**：2026-11-26

## 任务清单（WBS）

- [x] **T1 · 全仓工程与用户体验审查**
  - 完成架构分层、代码规模、包体、CSS、容错边界、测试结构及设计师体验全维度审计。
- [x] **T2 · 立项文档落盘**
  - 建立 `PRD.md`、`ENGINEERING.md`、`TASKS.md` 并登记到 `docs/initiatives/README.md`。
- [x] **T3 · 拆分 `src/editor/agent/` 子模块**
  - [x] `src/editor/agent/agent-copy.ts`（198 行）：进度文案、操作类型/工具调用人性化映射、场景化引导建议
  - [x] `src/editor/agent/EpisodeDrawer.tsx`（569 行）：设计记忆抽屉 UI 与 `useEpisodeArchive` 持久层辅助
  - [x] `src/editor/agent/ChatMessageItem.tsx`（433 行）：消息气泡、方案范围确认卡、设计预览改动卡、精简生成过程详情
  - [x] `src/editor/agent/ComposerSettingsPopover.tsx`（307 行）：渐进式披露偏好浮层（组件库、生成方式、视觉优化、本轮技能、外部 MCP / 手动导入）
- [x] **T4 · 重构 `AgentPanel.tsx`、`CanvasAgentBar.tsx` 与 `App.tsx` 满高布局**
  - [x] 左侧栏改为满高三段式对话工作区（极简顶栏 + `flex: 1` 对话/欢迎画布 + 吸底输入卡）
  - [x] 合并重复的未连接模型提示，隐藏空状态下的「单稿记忆 0 条档案」工程条
  - [x] 优化画布悬浮条：去除三重未配置提示与原始像素坐标，收束视觉边框层级
  - [x] 同步打磨 `src/editor/agent-ui.css` 与 `src/editor/ui3-theme.css`（双主题、短窗口 `1024×480` 浮层限高防顶栏遮挡、零新增 `!important`）
- [x] **T5 · 同步测试与规格文档**
  - [x] 新增 `tests/agent-panel-ux.test.ts` 覆盖人性化文案与去重红线
  - [x] 同步更新 `scripts/check-agent-canvas-chat.browser.js`、`scripts/check-mcp.browser.js`、`tests/project-memory.test.ts`
  - [x] 同步更新 `docs/specs/AGENT-PROVIDER-AND-CANVAS-CHAT.md`
- [x] **T6 · 全量回归、视觉实拍与发版评估**
  - [x] `npm run format:check`、`npm run build`、全仓单测（`897 / 898` 通过，0 失败，1 跳过需浏览器原生 IndexedDB）全部通过
  - [x] 真实 Chromium E2E（`optional-gateway`、`agent-canvas-chat`、`mcp`、`panel-parity`、`editor-panels`）5/5 通过
  - [x] 归档浅/深双主题 2× Retina 实拍截图至 `docs/evidence/2026-11-26/ai-panel-ux/` 并完成人工核验与 4 项排版微调
  - [x] 运行 `npm run release:assess`（判定 `0.11.0 → 0.11.1` `patch` 且需同步桌面打包）

## 实测结论

- `src/editor/AgentPanel.tsx` 从 `3,422` 行降至 `2,595` 行，展示与记忆抽屉、消息卡片、偏好浮层及文案字典清晰拆分为 4 个独立模块。
- 实测捕获并修复 `1024×480` 短窗口下 `.agent-settings-popover` 与 `.agent-mention-popover` 向上溢出顶栏 `<header>` 的问题（收敛至 `min(360px, calc(100dvh - 230px))`）。
- 视觉实拍核验捕获并收敛 4 处微调：组件库默认选项截断、记忆搜索框占位符裁切、中文孤字折行与欢迎区光学重心。

## 关键决策日志（ADR）

- **ADR-01（偏好设置渐进式披露）**：组件库选择、生成引擎模式、视觉自审开关、本轮技能与外部 MCP/JSON 接入从主界面收口至吸底输入卡「创作设置」浮层；用户主动指定非默认组件库/模式/技能时，在输入卡顶部以可移除胶囊明示。
- **ADR-02（保留兼容导出面）**：`src/editor/AgentPanel.tsx` 保持原有对外导出契约；`ComposerSettingsPopover` 采用 `hidden` 挂载以保证外部 MCP 会话在关闭偏好浮层或切换侧栏标签后不断连。
