# Forma 全栈工程质量与用户体验平衡升级工程设计

- **状态**：已实施并验收
- **更新日期**：2026-11-26
- **关联 PRD**：[PRD.md](PRD.md)

---

## 一、四路并行 Codex CLI 施工分工（零文件冲突矩阵）

本课题采用「架构师统稿与最终集成 + 4 路并行 Codex CLI 专职施工」模式，各路文件所有权严格互斥：

| 施工轨道 | 目标覆盖 | 独占文件所有权 |
| --- | --- | --- |
| **Track A · 架构边界与自动门禁** | P1.3 | `src/domain/library-intelligence.ts`（新）、`src/agent/library-intelligence.ts`、`src/domain/library-schema.ts`、`src/domain/library-promotion.ts`、`src/design-system/catalog.ts`、`src/domain/document-parts.ts`（新）、`src/infrastructure/document-parts.ts`、`src/infrastructure/native-document.ts`、`src/compiler/svg-export.ts`（新）、`src/infrastructure/static-export.ts`、`src/compiler/runtime.ts`、`src/compiler/react.ts`、`scripts/check-architecture.mjs`（新）、`tests/architecture-boundaries.test.ts`（新） |
| **Track B · AI 应用层下沉、懒加载图标与 E2E 模块化** | P1.1 / P1.2(局部) / P1.4 | `src/application/agent-session.ts`（新）、`src/editor/agent/useAgentSession.ts`（新）、`src/editor/AgentPanel.tsx`、`scripts/browser-checks/agent/fixtures.mjs`（新）、`scripts/check-agent-canvas-chat.browser.js`、`tests/agent-session-application.test.ts`（新） |
| **Track C · 分层 ErrorBoundary、产品文案表与空画布引导** | P0.1 / P0.2 / P2.2 | `src/editor/ErrorBoundary.tsx`（新）、`src/editor/CanvasWelcomeOverlay.tsx`（新）、`src/editor/ux-copy.ts`（新）、`src/editor/FileBrowser.tsx`、`tests/error-boundary-and-ux.test.ts`（新） |
| **Track D · CSS `@layer` 架构与 `!important` 治理** | P2.1 / P0.3(样式) | `src/editor/layers.css`（新）、`src/editor/styles.css`、`src/editor/design-system.css`、`src/editor/ui3-theme.css`、`src/editor/figma-panels.css`、`src/editor/agent-ui.css`、`src/editor/design-import.css`、`src/editor/assets-panel.css` |
| **Lead 集成轨道（收口阶段执行）** | P0.3 / P1.2 / 统调 | `src/main.tsx`、`src/editor/App.tsx`、`vite.config.ts`、`package.json`、架构/交接/验收文档与全量回归发版 |

---

## 二、核心模块契约

### 2.1 分层边界规则（`scripts/check-architecture.mjs`）
- `src/domain/**`：禁止引入 `react`、`react-dom` 及 `../(application|infrastructure|editor|agent|compiler|runtime|design-system|server|electron)`；
- `src/application/**`：禁止引入 `react`、`react-dom` 及 `../(editor|infrastructure|server|electron)`；
- `src/compiler/**`：禁止引入 `../(editor|infrastructure|server|electron)`；
- `src/runtime/**`：禁止引入 `../(editor|infrastructure|server|electron)`；
- 代码洁净度：`as any` ≤ 1、`: any` = 0、`@ts-ignore` / `@ts-expect-error` = 0；
- CSS `!important` 总数严格受控（≤ 25，显著低于历史基线 223）。

### 2.2 `ErrorBoundary` 契约（`src/editor/ErrorBoundary.tsx`）
```ts
export interface ErrorBoundaryProps {
  scope: "workspace" | "panel" | "modal";
  title?: string;
  resetKey?: string | number;
  getRecoveryDocument?: () => DesignDocument | null;
  onReset?: () => void;
  children: ReactNode;
}
```
- `scope="workspace"` 提供「重新加载工作区」与「导出当前设计文件（`.forma.json`）」（通过 `nativeDocumentBlob` + `download` 实现）；
- `scope="panel"` / `"modal"` 局部隔离展示紧凑恢复卡片，支持一键重置局部子树且不清空画布内容。

### 2.3 `CanvasWelcomeOverlay` 契约（`src/editor/CanvasWelcomeOverlay.tsx`）
```ts
export interface CanvasWelcomeOverlayProps {
  visible: boolean;
  onCreateFrame(label: string, width: number, height: number): void;
  onOpenAi(): void;
  onImportFile(): void;
  onDismiss(): void;
}
```
- 仅在 `doc.nodes.length === 0 && editor.tool === "select" && !pendingProposal && !dismissed` 时渲染；
- 外层 `pointer-events: none`，仅卡片内部 `pointer-events: auto`；点击任一快捷入口或切换任意绘图工具（`F/R/T/O/L/P`）自动隐藏，保障键盘创作与拖拽绘制零阻塞。

### 2.4 CSS Cascade `@layer` 顺序（`src/editor/layers.css`）
```css
@layer legacy, design-system, ui3, panels, overrides;
```
- `src/main.tsx` 首个样式导入为 `./editor/layers.css`；
- `.primary`、`[hidden]` 等跨层状态放于 `@layer overrides`，彻底消除各面板文件用 `!important` 对抗 `ui3-theme.css` / `styles.css` 的恶性循环。

---

## 三、安全与降级边界

- 所有新模块离线零外网请求；`icon-library.ts` 仅在真正编译 HTML 草案时经动态 `import()` 按需加载。
- Web 与 Desktop 双端兼容：`window.formaDesktop` 仅决定本机保存文案与提示，不影响 Web 端既有测试契约（`已保存到此浏览器`）。
- 桌面端打包与只读挂载 DMG 实机验收通过 `npm run release:run` 执行并保留历史包完整。
