# Forma 多文件顶部 Tab 工作台工程设计

- **状态**：已实施并验收（随 v0.14.0 发布）
- **更新日期**：2026-11-27
- **关联 PRD**：[PRD.md](PRD.md)

---

## 一、并行施工分工（零文件冲突矩阵）

| 施工轨道 | 覆盖模块 | 独占文件所有权 |
| --- | --- | --- |
| **Track 1 · 纯应用层 Tab 状态机与顶部 Tab 栏 UI** | 多 Tab 不可变状态机、URL/持久化序列化、Figma 风格 36px `WorkspaceTabBar`（含拖拽排序、右键菜单、macOS 融合留空）、单测 | `src/application/workspace-tabs.ts`（新）、`src/editor/WorkspaceTabBar.tsx`（新）、`src/editor/workspace-tabs.css`（新）、`tests/workspace-tabs.test.ts`（新） |
| **Track 2 · Electron 融合标题栏与 `open-file-in-tab` 路由** | macOS `titleBarStyle: "hiddenInset"`、向活跃窗口转发 `open-file` / `⌘O` 至新 Tab、原生菜单 `⌘T`/`⌘W`/`⇧⌘T` 与 `openInNewWindow` / `closeWindow` IPC | `electron/main.mjs`、`electron/preload.cjs`、`src/vite-env.d.ts` |
| **Track 3 · 最近打开子菜单与首页/文件浏览器 Tab 回调适配** | 左上角 `Forma ▾` 内「最近打开 ▸」子菜单组件；`WorkspaceHome`、`WorkspaceHomeShell`、`FileBrowser` 接入可选 Tab 打开回调并保持独立渲染降级兼容 | `src/editor/RecentFilesSubmenu.tsx`（新）、`src/editor/WorkspaceHome.tsx`、`src/editor/WorkspaceHomeShell.tsx`、`src/editor/FileBrowser.tsx` |
| **Lead 集成与验收轨道** | 顶层 `WorkspaceShell`（单活 + 快照 + AI/MCP 保活池 + History API 同步 + 全局快捷键）、`Canvas` 视口快照、`App.tsx` / `main.tsx` / `layers.css` 集成、浏览器 E2E 与 `v0.14.0` 发版 | `src/editor/WorkspaceShell.tsx`（新）、`src/main.tsx`、`src/editor/App.tsx`、`src/editor/Canvas.tsx`、`src/editor/layers.css`、`scripts/*`、`docs/*` |

---

## 二、核心契约设计

### 1. 纯应用层状态契约（`src/application/workspace-tabs.ts`，零 React/DOM 依赖）

```ts
export type WorkspaceTabKind = "home" | "file" | "example";

export interface WorkspaceTab {
  id: string; // "home" | `file:${fileKey}` | `example:${exampleKey}`
  kind: WorkspaceTabKind;
  title: string;
  fileKey?: string;
  example?: string;
  edition?: string;
  page?: string;
  node?: string;
  preset?: "blank" | "mobile" | "desktop" | "ai";
  dirty?: boolean;
  busyReason?: "ai" | "mcp" | null;
  nativePath?: string | null;
}

export interface TabViewSnapshot {
  activePage?: string;
  selectionIds?: string[];
  camera?: { x: number; y: number; scale: number };
}

export interface WorkspaceTabsState {
  tabs: WorkspaceTab[];
  activeTabId: string;
  closedStack: WorkspaceTab[];
}
```

- 不变量：`tabs[0]` 永远为 `{ id: "home", kind: "home", title: "工作台" }`，不可关闭、不可移出首位；`tabs` 最多保留 24 个；同 `id`、`fileKey` 或非空 `nativePath` 打开时严格去重并聚焦。
- 持久化键：`localStorage["forma.workspace-tabs.v1"]` 仅保存非敏感稳定元数据（剥离 `dirty`、`busyReason`、`preset`）。

### 2. Tab 生命周期与内存策略（`WorkspaceShell.tsx`）

- 活跃 Tab 正常挂载；非活跃 Tab 仅当 `busyReason === "ai" || busyReason === "mcp"` 时以 `hidden` 保留在保活池，其余切换前触发 `flushSave()` 并保存 `TabViewSnapshot` 后卸载画布 DOM，防止多份万层文档同时常驻内存。
- URL 同步：通过 `history.pushState` / `popstate` 与 `tabToUrl(activeTab)` 双向同步，确保既有深链（`?file=`、`?example=`、`?editor=1`）与所有既有 E2E 回归零破坏兼容。

### 3. Electron 桌面端融合契约（`electron/main.mjs` / `preload.cjs`）

- `BrowserWindow` 在 macOS 使用 `titleBarStyle: "hiddenInset"` 与 `trafficLightPosition: { x: 14, y: 11 }`；`window.formaDesktop.platform` 暴露 `process.platform`。
- 收到 `open-file` 或 `⌘O` 时，若已有存活主窗口则挂载该窗口的待读文件队列并发送 `forma:open-file-in-tab` IPC，渲染端读取并调用 `openTab`；若无主窗口则回退 `createWindow("", payload)`。
- 新增受控 IPC：`onOpenFileInTab(listener)`、`openInNewWindow(query)`、`closeCurrentWindow()`，并在 `onMenuAction` 文件动作集合增加 `"newTab" | "closeTab" | "reopenTab"`。
