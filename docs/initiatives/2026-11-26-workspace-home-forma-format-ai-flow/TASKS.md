# Forma 用户路径重构、原生 `.forma` 格式与 AI 工作流净化任务清单

- **课题状态**：已实施并验收（随 `v0.13.0` 发布）
- **最后更新**：2026-11-27

## 阶段一：立项与方案对齐
- [x] 与用户确认三大核心产品决策（启动默认进入全屏工作台首页、原生 `.forma` ZIP 格式 + 桌面直接保存、移除「创作设置」弹窗并修复跨文件模型状态）
- [x] 创建课题文档 `PRD.md`、`ENGINEERING.md`、`TASKS.md` 并登记索引

## 阶段二：三路并行 Codex CLI 施工（零文件冲突）
- [x] **Track 1（原生 `.forma` 容器格式与桌面原生保存）**
  - [x] 实现 `src/infrastructure/forma-package.ts`（ZIP 编解码、二进制图片/字体去 Base64、封面 `preview.svg`、SHA-256 与安全校验；PNG+字体样本体积实测缩减 `-61.5%`，万层分块往返通过）
  - [x] 升级 `src/infrastructure/native-document.ts`（默认导出 `.forma` + 兼容读取 `.forma.json`）与 `src/infrastructure/design-import/types.ts`（防 `.forma` ZIP 误判）
  - [x] 升级 `electron/main.mjs`、`electron/preload.cjs`、`src/vite-env.d.ts`（原生 `.forma` 绑定路径直接保存 / 另存为 + 本地模型配置零网络磁盘探测 `agent-profiles.json` / `agent-config.json`）
  - [x] 新增 `tests/forma-package.test.ts` 覆盖编解码、兼容、去膨胀与对抗性安全边界
- [x] **Track 2（全屏工作台首页与强新建入口）**
  - [x] 实现 `src/editor/WorkspaceHome.tsx` 与 `@layer panels` 样式 `src/editor/workspace-home.css`（0 `!important`）
  - [x] 升级 `src/editor/file-actions.ts`（`newDesignFile` 预设/项目创建、`downloadFormaFile`、`saveFormaDocument`、Home/Editor URL 辅助）与 `src/editor/FileBrowser.tsx`（强新建按钮与 `.forma` 导出）
  - [x] 新增 `tests/workspace-home.test.ts`（21 项单测）
- [x] **Track 3（模型连接自动保持 & 极简 AI 输入区 & 独立 MCP 弹窗）**
  - [x] 在 `agent-client.ts`、`ModelConfigModal.tsx`、`useAgentSession.ts` 落地非敏感配置标记与自动水合（干净环境仍 `0` `/api/agent/*` 请求；已配置跨文件/刷新/重启自动恢复）
  - [x] 彻底移除「创作设置」弹窗、「生成方式」引擎切换与禁用态「视觉优化」开关；输入框底栏改为内联组件库药丸（窄栏自适应双行对齐，发送键固定右下角），技能管理独立清晰入口
  - [x] 新增独立 `src/editor/IntegrationsModal.tsx` 承载 MCP 配对与 JSON 导入导出，并更新 `tests/agent-panel-ux.test.ts`

## 阶段三：主干集成、全量验证、视觉验收与 `v0.13.0` 发版
- [x] 完成 `src/main.tsx`、`src/editor/WorkspaceHomeShell.tsx`、`src/editor/App.tsx`、`src/editor/ErrorBoundary.tsx`、`src/editor/layers.css` 主干集成（默认首页路由、编辑器 `← 工作台` 与 `+ 新建`、桌面 `⌘S`/`⇧⌘S` 绑定、全局模型水合、`IntegrationsModal` 保活挂载）
- [x] 更新浏览器/桌面测试夹具与新增 `scripts/check-workspace-home.browser.js` 完整覆盖新用户路径（`verify-dmg.ts` 同步校验挂载 `Forma.app` 默认直达 `.workspace-home`）
- [x] 运行全量门禁：`npm run format:check`、`npm run lint:arch`、`npm run build`（`WorkspaceHomeShell` 19.97 kB / `index` 376.01 kB）、`npm test`（951/952 通过，0 失败）、**17 / 17** 真实 Chromium E2E、`npm run test:exports -- agent-canvas-chat` 与 6 张 2× Retina 视觉实拍人工核验（[docs/evidence/2026-11-26/workspace-home-v13/](../../evidence/2026-11-26/workspace-home-v13/)）
- [x] 同步更新规格文档、交接/验收总账与课题结项，并执行 `npm run release:run` 发布 `v0.13.0` + 只读挂载 DMG 实机验收
