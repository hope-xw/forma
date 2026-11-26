# Forma AI 对话面板重构与模块化工程设计

- **状态**：已实施并验收
- **更新日期**：2026-11-26
- **关联 PRD**：[PRD.md](PRD.md)

---

## 一、模块拆分与文件所有权

将原 `src/editor/AgentPanel.tsx`（3,422 行）拆分为职责单一的展示层与领域适配子模块，同时在 `src/editor/AgentPanel.tsx` 保留全部既有导出（`AgentPanel`、`archiveAppliedProposal`、`capturePickerMention`、`useEpisodeArchive`、`readFileProjectEpisodes`、`scopeProblem`、`chatGeneration`、`composeConfirmedScope`、`staleProposalMessage`、`projectMemoryUnavailableNotice`、`projectMemoryReadErrorMessage` 及类型定义），保证调用方与单测零破坏：

```text
src/editor/
├── AgentPanel.tsx                     # 主容器：会话状态机、流式编排、顶栏 + 满高对话画布 + 吸底输入卡
├── CanvasAgentBar.tsx                 # 画布快捷对话条：去重未配置提示、去原始坐标、精简视觉层级
├── agent-ui.css                       # 对话画布、吸底输入卡、偏好浮层与画布条双主题样式
└── agent/
    ├── agent-copy.ts                  # 设计师语言字典：阶段进度、操作类型/工具名中文化、上下文快捷建议
    ├── EpisodeDrawer.tsx              # 设计记忆抽屉 UI + useEpisodeArchive + 持久层读写与归档辅助
    ├── ChatMessageItem.tsx            # 对话消息项、ScopeProposalCard、ProposalPreviewCard、CallDetails、StatsPills
    └── ComposerSettingsPopover.tsx    # 吸底「偏好设置」浮层（组件库、生成方式、视觉优化、本轮技能、开发者 MCP/JSON）
```

同时微调 `src/editor/App.tsx` 与 `src/editor/ui3-theme.css`：
- 为左侧栏 AI 标签容器增加 `.sidebar-content.agent-sidebar` 与 `.agent-sidebar-host`，复用 `.assets-sidebar` 已验证的满高弹性布局模式，使 `AgentPanel` 精确占满侧栏可视高度，底部图层状态栏（`.milestone`）静置底边不遮挡输入框；
- 保持 `hidden={tab !== "agent"}` 挂起策略，切换标签时完整保留草稿、多轮记录与外部 MCP 会话。

---

## 二、关键交互与可访问性契约

1. **离线零请求红线**：
   - 未配置模型时打开编辑器、切换至 AI 面板或展开偏好/记忆抽屉，严禁发起任何 `/api/agent/*` 请求；
   - 仅当用户主动点击「配置模型」「检测本地服务」「管理设计技能」或外部 MCP「连接外部工具」时按需请求本地网关。
2. **输入与快捷键一致性**：
   - 侧栏与画布条统一支持 `Enter` 发送、`Shift+Enter` 换行，同时兼容 `⌘↵` / `Ctrl+Enter` 发送；
   - 严格检查 `ev.nativeEvent.isComposing || ev.keyCode === 229`，保护中文 IME 选词回车不误发；
   - 所有弹窗/抽屉/浮层设置 `data-escape-local="true"` 与本地 `Escape` 焦点回收，不穿透触发画布快捷键。
3. **无 DOM 几何依赖的浮层渲染**：
   - `ComposerSettingsPopover` 采用相对吸底输入框向上锚定的纯 CSS 定位与 React 条件渲染，不依赖 `getBoundingClientRect()` / `ResizeObserver`，在 Node 轻量 DOM 单测与真实浏览器中行为一致；
   - 在 `1024×480` 窄高窗口下限定 `max-height` 与内部滚动，严禁超出侧栏宽度或截断核心按钮。
4. **语义化标签与提示规范**：
   - 遵循 [EDITOR-UI-CONTROLS.md](../../specs/EDITOR-UI-CONTROLS.md)，所有图标按钮提供明确 `aria-label` 与 `data-tip` / `data-tip-desc` 接入全局 `TooltipHost`。

---

## 三、验证矩阵

| 层级 | 验证命令 / 用例 | 覆盖重点 |
| --- | --- | --- |
| 单元测试 | `npm test` | 全部 895+ 既有单测 + 新增 `agent-copy` 设计师语言映射单测 |
| 格式与编译 | `npm run format:check && npm run build` | 严格 TypeScript 与 Prettier 规范 |
| 浏览器 E2E | `npm run test:browser -- optional-gateway agent-canvas-chat mcp panel-parity editor-panels` | 离线 0 请求、Stage 1/2 全链路、偏好浮层、外部 MCP、窄屏双主题无溢出 |
| 视觉实拍 | Playwright 双主题（浅/深）× 多视口截图人工复核 | 对比改造前后侧栏与画布悬浮条信息密度与视觉克制度 |
