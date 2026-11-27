# Forma 用户路径重构、原生 `.forma` 格式与 AI 工作流净化工程设计

- **状态**：已实施并验收（随 `v0.13.0` 发布）
- **更新日期**：2026-11-27
- **关联 PRD**：[PRD.md](PRD.md)

---

## 一、并行施工分工（零文件冲突矩阵）

| 施工轨道 | 覆盖模块 | 独占文件所有权 |
| --- | --- | --- |
| **Track 1 · `.forma` 容器格式与桌面原生保存** | 原生 ZIP 容器编解码、外部导入防误判、Electron 绑定路径保存与本地模型配置探测 | `src/infrastructure/forma-package.ts`（新）、`src/infrastructure/native-document.ts`、`src/infrastructure/design-import/types.ts`、`electron/main.mjs`、`electron/preload.cjs`、`src/vite-env.d.ts`、`tests/forma-package.test.ts`（新） |
| **Track 2 · 全屏工作台首页（Workspace Home）** | 首页视图、强主按钮 `+ 新建设计`、项目与文件画廊、快速起步预设、导航路由辅助 | `src/editor/WorkspaceHome.tsx`（新）、`src/editor/workspace-home.css`（新）、`src/editor/file-actions.ts`、`src/editor/FileBrowser.tsx`、`tests/workspace-home.test.ts`（新） |
| **Track 3 · 模型状态自动水合 & AI 极简输入区 & MCP 独立弹窗** | 修复跨文件/重启误报未连接、移除「创作设置」浮层、内联组件库药丸、独立 `IntegrationsModal` | `src/editor/agent-client.ts`、`src/editor/ModelConfigModal.tsx`、`src/editor/agent/useAgentSession.ts`、`src/editor/AgentPanel.tsx`、`src/editor/agent/ComposerSettingsPopover.tsx`、`src/editor/IntegrationsModal.tsx`（新）、`src/editor/agent-ui.css`、`tests/agent-panel-ux.test.ts` |
| **Lead 集成与验收轨道** | 启动路由（Home ↔ Editor）、编辑器返回首页与桌面 `⌘S` 绑定、测试夹具升级、视觉验收与 `v0.13.0` 发版 | `src/main.tsx`、`src/editor/App.tsx`、`src/editor/ErrorBoundary.tsx`、`src/editor/layers.css`、`scripts/*` 浏览器/桌面测试脚本、`docs/*` |

---

## 二、核心技术契约

### 2.1 原生 `.forma` 文件格式（`forma/package` v1）
- 使用 `fflate`（`zipSync` / `unzipSync`）封装单文件 ZIP 归档，扩展名为 `.forma`（MIME `application/vnd.forma.design+zip`）：
  - `manifest.json`：`{ format: "forma/package", packageVersion: 1, schemaVersion: 1, appVersion, docId, name, pages, nodeCount, updatedAt, documentPath: "document.json" | "document.parts.ndjson", previewPath?: "preview.svg", assets: Record<string, { path: string; mime: string; bytes: number; sha256: string }> }`；
  - `document.json`（常规文档）或 `document.parts.ndjson`（大文档，复用 `nativeTextParts`）：文档内 `images` / `fonts` 在序列化时剥离 Base64 数据体，仅保留轻量元数据与引用键，原始字节落入 `assets/images/<sha256>.<ext>`、`assets/fonts/<sha256>.<ext>`；
  - `preview.svg`：首张可见根画板的轻量 SVG 缩略图（受体积上限保护，生成失败时优雅跳过）。
- 读取安全与兼容：
  - `readNativeDocument(file: Blob)` 自动检测 `PK\x03\x04` 魔数：命中则严格校验条目路径（禁止 `..`、绝对路径、重复键）、总解压体积预算（≤ 512 MiB，资产总量 ≤ 256 MiB）、每项资产 SHA-256 与魔数宽高校验（`verifyEncodedAsset` + `checkImageMetadata`），还原 `DesignDocument` 后交由 `parseDocument`；未命中则无缝回退既有 `.forma.json` / `forma/design-parts` 解析器；
  - `isExternalDesign(file: File)` 对 `.forma`/`.forma.json` 直接返回 `false`，对未知扩展名 ZIP 检查是否包含 `manifest.json` 含 `"forma/package"`，防止将改名后的 `.forma` 误判为 `.sketch`/`.fig`。

### 2.2 Electron 桌面端原生 `.forma` 保存与模型配置预检
- `window.formaDesktop` 新增：
  - `agentConfigured?: boolean`（启动时由主进程直接同步读取 `userData/agent-config/agent-config.json` 或环境变量判断，零 HTTP 请求）；
  - `hasConfiguredAgent(): Promise<boolean>`（主进程本地磁盘读取，供新建窗口或配置变更后复核）；
  - `saveNativeFile(options: { bytes: Uint8Array; suggestedName: string; fileKey?: string; saveAs?: boolean }): Promise<{ saved: boolean; canceled?: boolean; filePath?: string; fileName?: string }>`：若 `!saveAs` 且窗口/文档已绑定本地 `.forma` 路径则原子写回（临时文件 + rename）；否则弹出原生 `dialog.showSaveDialog`（`.forma` 过滤器）原子写入并绑定该路径；
  - `getBoundFile(fileKey?: string): Promise<{ filePath: string; fileName: string } | null>`；
  - `bindPendingFile(fileKey: string): Promise<{ filePath: string; fileName: string } | null>`（打开本地 `.forma` 文件后把原磁盘路径绑定到对应的工作区 `fileKey`）。

### 2.3 模型状态自动水合（零静默外网契约）
- `src/editor/agent-client.ts` 提供 `hasConfiguredAgentHint()` / `syncConfiguredAgentHint(configured: boolean)`：
  - 写入非敏感标记 `localStorage["forma.agent.configured-hint"] = "1"`（删除全部配置或服务端返回 `configured: false` 时清除）；
  - 桌面端同时结合 `window.formaDesktop?.agentConfigured`；
  - `hasConfiguredAgentHint()` 为 `true` 时，页面启动/新建文件/切文件后自动拉取 `fetchAgentStatus()` 恢复连接态；为 `false` 时绝不发起任何 `/api/agent/*` 请求，确保 `optional-gateway` 仍保持 `0` 请求。

### 2.4 启动路由契约（Home ↔ Editor）
- `src/main.tsx` 解析 `location.search`：
  - 存在 `file`、`example`、`editor=1` 或桌面端待打开文件（`pending`）→ 进入 `<App />` 画布编辑器；
  - 其余默认入口（`/`、`?view=home`）→ 渲染全屏 `<WorkspaceHome />`；
  - 新建设计文件时支持可选预设参数（如 `?file=<key>&preset=mobile` / `&preset=desktop` / `&ai=1`），首次进入画布自动落地目标画板或打开内联 AI 对话。
