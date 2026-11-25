# 任务清单与进度台账 · Forma AI 生成引擎 V2

- **课题编号**：`2026-11-24-ai-generation-v2`
- **负责人**：主控架构师（统筹规格、验收与集成）+ 多路 Codex CLI 并行施工
- **状态图例**：`[ ]` 待开始 · `[/]` 进行中 · `[x]` 已完成

---

## Phase 0 · 规范建制与课题立项

- [x] **T0.1** 在 `AGENTS.md` 新增 `docs/initiatives/` 课题目录永久规范，创建 `docs/initiatives/README.md` 台账索引。
- [x] **T0.2** 完成本课题 `PRD.md`（需求、痛点、目标与非目标、产品边界）与 `ENGINEERING.md`（双引擎架构、模块契约、安全红线）。
- [x] **T0.3** 创建长期规格文档 `docs/specs/AGENT-GENERATION-V2.md` 并登记到 `docs/specs/README.md`。

## Phase 1 · 三轨并行施工（严格文件隔离，零冲突）

### 轨道 A（Codex Worker A）：Lucide 矢量图标库 + 蓝图图片/现代材质增强
- [x] **T1.A1** 实现 `src/agent/icon-library.ts`：从本机 `lucide-react` 抽取 **369 枚**高频 UI 矢量图标（零 React 依赖，含中英文别名索引、`searchIcons`、`iconToFormaVector`、`iconToInlineSvg`）。
- [x] **T1.A2** 增强 `src/agent/blueprint-compiler.ts`：支持 `type: "icon"` / `icon` / `svg` 简写、`type: "image"` 与容器 `image` 填充（自动发射去重 `putImage` 并保留 `gradient` Scrim 遮罩）、`cornerSmoothing`、`backdropBlur`/`backdropSaturation`/`backdropBrightness`、`blur`、`blendMode`、`tint`、`maxLines`。
- [x] **T1.A3** 新增 `tests/agent-visual-primitives.test.ts` 并全部通过（25/25 含原蓝图单测，Prettier 与 `tsc --noEmit` 通过）。

### 轨道 B（Codex Worker B）：安全摄影与视觉媒体资产管线
- [x] **T1.B1** 实现 `src/agent/media-assets.ts`：内置 **44 张**经核验的高品质商业摄影目录（含 8 张咖啡/手冲专题摄影）+ Unsplash/Pexels/Openverse/Wikimedia 扩展 + 严格 SSRF 白名单 `localizeImageUrl`（HTTPS、全跳共享 10s 超时、≤1.5 MiB、PNG/JPEG/WebP/GIF 宽高解析、SHA-256 `img-<64hex>` ID）+ 纯离线 PIL 验证大气渐变纹理 PNG 兜底。
- [x] **T1.B2** 实现 `resolveMediaAssetsForHtml()`：安全识别 HTML/CSS 中的 `data-stock-query`、`srcset` 或白名单图片 URL，自动本地化为 `ImageAsset` 并重写为可靠 `data:` URI 及 CSP `img-src data:` 兜底。
- [x] **T1.B3** 新增 `tests/agent-media-assets.test.ts` 并全部通过（17/17，Prettier 与严格 TS 检查通过）。

### 轨道 C（Codex Worker C）：HTML/CSS → Forma 原生图层编译引擎
- [x] **T1.C1** 实现 `src/agent/html-to-forma.ts`：纯标准 DOM API 确定性编译器（Flex/Grid AutoLayout、`position: absolute`、文本真实 Range 尺寸与字体样式、多色标线性/径向渐变、多层投影 + `inset` 玻璃高光、`backdrop-filter` 毛玻璃、四角圆角与单边 `strokeSides`、`<svg>` 转可编辑 `vector`、`<img>`/`background-image` 转 `ImageFill + putImage`、空壳折叠与语义命名）。
- [x] **T1.C2** 实现 `src/editor/html-forma-sandbox.ts`：浏览器端无脚本 `<iframe sandbox="allow-same-origin">` 排版编译执行器 + `captureFormaArtboardPng()`（复用 `exportNodeAsRaster`）。
- [x] **T1.C3** 新增 `tests/agent-html-to-forma.test.ts`（零外部依赖 DOM 桩，11/11 通过，全仓单测 364 项零回归）。

## Phase 2 · 集成联调：工具链、视觉自审闭环与编辑器接入（Codex Worker D1 + D2）

- [x] **T2.1** 更新 `src/agent/forma-tools.ts`：接入 `search_icons`、`search_stock_images`、`propose_html_design`（含 HTML 安全消毒、Lucide `data-icon` 预水合与图片本地化）及 `propose_design_changes` 图片资产透传。
- [x] **T2.2** 更新 `src/agent/context-builder.ts` 与 `src/agent/design-engine.ts`：上线 HTML-First 新建引导、现代视觉工艺准则，以及 `runVisualCritique()` 多模态截屏视觉自审精修环（95/95 专项单测 + 桌面打包冒烟通过）。
- [x] **T2.3** 更新 `server/agent-http.ts`、`electron/main.mjs`、`src/editor/agent-client.ts`、`src/editor/AgentPanel.tsx`、`src/editor/CanvasAgentBar.tsx`、`src/editor/agent-ui.css`：打通 `/api/agent/critique` 路由、前端自动沙盒编译 `htmlDraft` → 预览 HUD → 采纳 → 单步撤销，以及「视觉自审精修」与模式切换开关。
- [x] **T2.4** 补齐工具、HTTP 与浏览器端到端测试（`tests/agent-tools.test.ts`、`tests/agent-http-integration.test.ts`、`scripts/check-agent-canvas-chat.browser.js`）。

## Phase 3 · 全量回归与真网代际实拍对比验收

- [x] **T3.1** 全仓 `npm test`（**374 / 374**）、`npm run format:check`、`npm run build`、`npm run desktop:agent` 及 **4 / 4** 真实浏览器 E2E 回归全部通过（含 Chromium 实测 `htmlFirstCompiled: true`、`visualCritiqueVerified: true`、`critiqueCancellationKeptDraft: true`）。
- [x] **T3.2** 使用同一本机 `DeepSeek-V4.1-Flash` 与同一道「微光烘焙 · Lumina Roasters」咖啡 H5 需求，运行 V2 引擎（HTML-First + 真实摄影 + Lucide 图标 + 1 轮视觉自审），完成 V2-A（130 层 · 19 图标 · 3 摄影 · 6 毛玻璃）与 V2-B（127 层 · 14 图标 · 3 摄影 · 4 毛玻璃 · 0 对比度问题）2× 原生画布实拍对照。
- [x] **T3.3** 在真实 Chromium 编辑器打开 V2-B 生成的 `.forma.json`，`⌘+点击` 选中「粉红波旁」文本图层改为「粉红波旁 · V2 手改实测」并按 `⌘Z` 单步完整撤销还原。
- [x] **T3.4** 更新对比总览页（`127.0.0.1:4188/benchmark/` + 4 画板并排 `ALL-V1-V2-comparison.forma.json`）、`docs/specs/AGENT-GENERATION-V2.md` 状态、`docs/EDITOR-ACCEPTANCE.md` 与 `docs/HANDOFF.md`。

---

## 关键工程决策日志（ADR）

| 日期 | 决策 | 原因与权衡 |
| --- | --- | --- |
| 2026-11-24 | **采用「HTML/CSS-to-Forma + Blueprint 双引擎」而非废除 Blueprint** | 新建整屏借助 HTML/CSS 释放大模型最强审美分布与真实浏览器字体排版；局部精准修改、组件库实例覆写与 Token 绑定继续走 Blueprint 原子事务，两者优势互补且零破坏既有功能。 |
| 2026-11-24 | **前端排版采用零脚本 `<iframe sandbox="allow-same-origin">` 而非打包 Playwright 进 Electron** | 避免 Electron 安装包膨胀 300MB+；Web 与桌面端共用同一套 DOM 编译代码，排版耗时 < 50ms，且禁用脚本保证安全。 |
| 2026-11-24 | **所有外部摄影图必须本地化为 SHA-256 `ImageAsset` 写入 `.forma.json`** | 避免外链失效/跨域/离线裂图，同时保证导出独立 React 工程自带完整图片资源。 |
| 2026-11-24 | **Lucide 图标编译为静态内置 369 枚精选矢量表** | 兼顾打包体积、零运行时 React 依赖、浏览器/Node/Electron `esbuild` 通用，以及 100% 离线零幻觉。 |
| 2026-11-24 | **真网像素复核后补齐 4 项编译器与适配器加固** | ① `html-to-forma` 支持 CSS 多层叠加渐变按 `stackPaints` 顺序入 `gradient + paints`；② 单格 `display:grid; place-items:center` 映射居中 AutoLayout + `:where(button)` 零内边距复位；③ 沙盒全局 `animation:none!important` 杜绝 `@keyframes opacity:0` 入场动画隐藏文字；④ `adapters.ts` 自动恢复 DeepSeek 偶发正文泄漏 `<｜DSML｜invoke>` XML，工具默认轮数上限由 6 提至 10。 |
