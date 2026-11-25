# Forma Agent 生成引擎 V2 规格（现代视觉资产、HTML-to-Forma 编译与视觉自审）

- **最近更新日期**：2026-11-24
- **状态**：已实施并验收（Wave 1：视觉资产 + HTML/CSS-to-Forma 双引擎 + 多模态视觉自审闭环；Wave 2 多方向探索与云端生图配置为规划项，见课题 [2026-11-24-ai-generation-v2](../initiatives/2026-11-24-ai-generation-v2/PRD.md)）
- **关联源码**：
  - 矢量图标库：[icon-library.ts](../../src/agent/icon-library.ts)（369 枚零 React 依赖 Lucide 矢量图标）
  - 摄影媒体资产管线：[media-assets.ts](../../src/agent/media-assets.ts)（44 张经核验精选摄影目录 + Openverse/Wikimedia/Unsplash/Pexels 扩展 + SSRF 安全本地化与离线 PNG 兜底）
  - HTML/CSS → Forma 编译器与沙盒：[html-to-forma.ts](../../src/agent/html-to-forma.ts)、[html-forma-sandbox.ts](../../src/editor/html-forma-sandbox.ts)
  - 蓝图/工具/视觉自审/适配器：[blueprint-compiler.ts](../../src/agent/blueprint-compiler.ts)、[forma-tools.ts](../../src/agent/forma-tools.ts)、[design-engine.ts](../../src/agent/design-engine.ts)、[adapters.ts](../../src/agent/adapters.ts)、[agent-http.ts](../../server/agent-http.ts)
  - 编辑器界面：[AgentPanel.tsx](../../src/editor/AgentPanel.tsx)、[CanvasAgentBar.tsx](../../src/editor/CanvasAgentBar.tsx)、[agent-client.ts](../../src/editor/agent-client.ts)
- **验收方式**：`tests/agent-visual-primitives.test.ts`、`tests/agent-media-assets.test.ts`、`tests/agent-html-to-forma.test.ts`、`tests/agent-tools.test.ts`、`tests/agent-http-integration.test.ts`、`npm run test:browser -- agent-canvas-chat` 及同题真网实拍对照 [V1 vs V2 报告](../evidence/2026-11-24/ai-benchmark-v2/REPORT.md)。

---

## 一、双引擎职责边界

| 场景 | 推荐引擎 | 核心输出 |
| --- | --- | --- |
| **整屏新建 / 灵感探索 / 复杂现代视觉重设计** | **HTML/CSS-to-Forma（`propose_html_design`）** | 安全 HTML/CSS + 本地化摄影图 + Lucide 矢量图标 → 零脚本沙盒 DOM 真实排版 → 1:1 编译为可编辑原生 Forma `Transaction` |
| **选中画板局部精修 / 组件实例覆写 / 变量绑定** | **Forma Blueprint（`propose_design_changes`）** | 原子 `edits`/`artboards` 事务，支持 `type: "icon"`、`type: "image"`、组件按名/变体覆写与选区隔离 |

## 二、视觉资产与材质契约

1. **内置语义矢量图标（`search_icons` / `type: "icon"` / `data-icon="..."`）**：
   - 内置 240+ Lucide 24×24 矢量图标，支持中英文同义词映射；编译为原生可编辑 `vector` 图层（统一 `strokeLinecap: "round"`、`strokeLinejoin: "round"`）。
2. **安全摄影配图（`search_stock_images` / `type: "image"` / `data-stock-query`）**：
   - 仅允许 `https:` 且命中受控白名单域名（如 `images.unsplash.com`、`images.pexels.com`、`upload.wikimedia.org`），单图 ≤ 1.5 MiB、超时 ≤ 10s、魔数与宽高解析后以 SHA-256 生成 `img-<64hex>` 资产 ID，经 `putImage` 本地化写入文档；离线自动降级为高质感程序化纹理位图。
3. **现代材质原语**：
   - 蓝图与 HTML-to-Forma 均完整支持 `backdropBlur` / `backdropSaturation` / `backdropBrightness`（毛玻璃）、`cornerSmoothing`（超椭圆圆角）、多层阴影（含 `inset` 顶部 1px 高光边）、多色标线性/径向渐变、`strokeSides` 单边描边与内联 `<svg>` 矢量图表。

## 三、多模态视觉自审闭环（`POST /api/agent/critique`）

- 当模型声明 `capabilities.supportsVision === true` 且用户启用「视觉自审精修」时：
  1. 初稿编译为原生画板后，浏览器端调用 `exportNodeAsRaster()`（或评测端 Chromium 截图）生成真实渲染 PNG；
  2. 将渲染图回传 `POST /api/agent/critique`，由模型对照设计总监清单（视觉层级、留白韵律、贴边与溢出、图文对比度、图标与配图协调性）输出 1 轮定向精修提案；
  3. 不支持视觉的模型或关闭开关时自动跳过，零报错。

## 四、安全红线

- HTML 消毒强制剥离 `<script>`、`<iframe>`、`<object>`、`<embed>`、`on*=`、`javascript:`、`@import url(...)`；
- 浏览器排版沙盒固定为 `<iframe sandbox="allow-same-origin">`，永不授予 `allow-scripts`；
- 摄影下载器严禁访问 `localhost`、环回地址、内网 IP 与非白名单域名；
- 最终输出必须通过 `parseDocument` 与 `transact` 校验，并进入既有的「画布预览 HUD → 人工采纳 → 单步撤销」闭环。
