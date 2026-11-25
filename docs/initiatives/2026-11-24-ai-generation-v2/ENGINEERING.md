# 工程设计文档 · Forma AI 生成引擎 V2

- **课题编号**：`2026-11-24-ai-generation-v2`
- **状态**：已定稿，按模块并行施工
- **关联需求**：[PRD.md](PRD.md) · [TASKS.md](TASKS.md)

---

## 一、系统总体架构（双引擎 + 视觉资产 + 视觉自审闭环）

```text
                      ┌──────────────────────────────────────────────┐
                      │  Forma 编辑器（AgentPanel / CanvasAgentBar）  │
                      │  模式：现代视觉精排(HTML-First) / 蓝图精准编辑  │
                      │  可选开关：视觉自审精修（Visual Self-Critique）│
                      └───────────────┬──────────────────────▲───────┘
                                      │ SSE /api/agent/chat  │ Transaction + htmlDraft +
                                      ▼                      │ toolTrace + visualCritique
┌────────────────────────────────────────────────────────────────────────────┐
│                     Forma Agent Service (server/ + src/agent/)              │
│                                                                            │
│  ┌─────────────────────┐   ┌───────────────────────┐   ┌────────────────┐ │
│  │ Tool Loop (12 工具)  │   │ 视觉资产层 (P0)        │   │ 视觉自审器 (P2)│ │
│  │ • 既有 10 大工具     │──▶│ • icon-library.ts     │   │ POST /critique │ │
│  │ • search_icons      │   │   240+ Lucide 矢量图标 │   │ 接收 1x/2x PNG │ │
│  │ • search_stock_     │   │ • media-assets.ts     │   │ 回传定向精修   │ │
│  │   images            │   │   安全图库/本地化入库  │   │ HTML 或 Patch  │ │
│  │ • propose_html_     │   │   (SSRF 白名单/SHA256) │   └────────────────┘ │
│  │   design            │   └───────────────────────┘                       │
│  └──────────┬──────────┘                                                   │
└─────────────┼──────────────────────────────────────────────────────────────┘
              │
     ┌────────┴───────────────────────────────┐
     ▼ 通道 A：局部编辑 / 组件实例覆写         ▼ 通道 B：整屏新建 / 现代精排（HTML-First）
┌───────────────────────────┐    ┌───────────────────────────────────────────┐
│ blueprint-compiler.ts     │    │ 1. 服务端预本地化图片 + 注入 Lucide SVG   │
│ • 支持 type:"icon"        │    │ 2. 零脚本沙盒 DOM 真实排版：              │
│ • 支持 type:"image" +     │    │    - 浏览器端：<iframe sandbox=           │
│   putImage + scrim 遮罩   │    │      "allow-same-origin"> (<50ms)        │
│ • 支持 svg 简写 +         │    │    - 评测/CLI：Playwright Chromium       │
│   backdropBlur /          │    │ 3. html-to-forma.ts 确定性编译：          │
│   cornerSmoothing         │    │    computed flex/grid/text/img/svg/glass  │
└─────────────┬─────────────┘    │    → 原生 DesignNode[] + putImage Ops     │
              │                  └────────────────────┬──────────────────────┘
              └───────────────────┬───────────────────┘
                                  ▼
              ┌──────────────────────────────────────────────┐
              │ 统一原子 Transaction（parseDocument + transact）│
              │ 预览 HUD → 设计师手改任意图层 → ⌘Z 单步撤销     │
              │ → exportNodeAsRaster() 截屏自审 / 导出 React   │
              └──────────────────────────────────────────────┘
```

---

## 二、模块划分与并行施工文件所有权（严格零冲突）

### 轨道 A · 矢量图标库与增强蓝图材质（Worker A 独占）

| 文件 | 操作 | 职责与核心导出 |
| --- | --- | --- |
| `src/agent/icon-library.ts` | 新建 | 内置 240+ 精选 Lucide 24×24 矢量图标数据（直接抽取自 `node_modules/lucide-react`，零运行时 React 依赖，支持 Node / 浏览器 / `esbuild` 打包）。导出：`ICON_COUNT`、`resolveIconName(name)`（支持中英文同义词映射）、`searchIcons(query, limit)`、`iconToFormaVector(name, { color, strokeWidth, fill })`、`iconToInlineSvg(name, opts)`。 |
| `src/agent/blueprint-compiler.ts` | 增强 | ① 支持 `type: "icon"` 及 `vector` 节点的 `icon?: string` / `svg?: string` 简写，编译为标准 `DesignNode["vector"]`；② 支持 `type: "image"` 及 `frame`/`rectangle`/`ellipse` 上的 `image` / `imageAssetId` / `imageFit` / `imageOpacity` / `imageAdjustments`，并从 `CompileContext.images` 自动去重发射 `putImage` 事务操作（保留 `gradient`/`paints` 作为 `separateImageOverlay` 暗部遮罩）；③ `normalizeStylePatch` 补齐 `cornerSmoothing`（>0 自动设 `cornerSmoothingModel: "figma"`）、`backdropBlur`、`backdropBlurVisible`、`backdropSaturation`、`backdropBrightness`、`blur`、`blurVisible`、`blendMode`、`tint`、`leadingTrim`、`fontSmoothing`、`maxLines`、`textEffectClip`。 |
| `tests/agent-visual-primitives.test.ts` | 新建 | 覆盖图标检索、中英文别名、SVG 简写、图片资产 + `putImage` 去重 + 暗部渐变遮罩保留、毛玻璃/超椭圆圆角样式编译与 `parseDocument` 回放。 |

### 轨道 B · 安全摄影与视觉媒体管线（Worker B 独占）

| 文件 | 操作 | 职责与核心导出 |
| --- | --- | --- |
| `src/agent/media-assets.ts` | 新建 | 三级安全视觉资产解析器，导出：`CURATED_STOCK_CATALOG`、`searchStockImages(query, options)`、`localizeImageUrl(url, options)`、`createProceduralBackdropAsset(prompt, options)`、`resolveMediaAssetsForHtml(html, options)`、`MediaAssetRegistry`。 |
| `tests/agent-media-assets.test.ts` | 新建 | 覆盖：SSRF 主机白名单校验（拒绝 `127.0.0.1`/`169.254.169.254`/`file://`/`http://`/私有 IP）、PNG/JPEG/WebP 魔数与宽高解析、1.5 MiB 超限拒收、SHA-256 确定性 `img-<64hex>` ID、缓存命中与纯离线高质感 PNG 兜底生成。 |

**摄影资产策略细节**：
- 内置精选高质感 **无版权商业摄影目录（Unsplash 官方直链 + 领域标签覆盖咖啡/餐饮、科技/SaaS、电商产品、人物头像、建筑/室内、自然/旅行、音乐/时尚等 40+ 高品质摄影图）**，同时支持配置 `UNSPLASH_ACCESS_KEY` / `PEXELS_API_KEY` 实时扩展检索；
- 所有选中图片均由 `localizeImageUrl()` 经安全白名单拉取并编码为 `data:image/jpeg;base64,...` / `data:image/png;base64,...` 写入 `ImageAsset`（单图 ≤ 1.5 MiB，自动带 `?auto=format&fit=crop&w=900&q=82` 控体积），**存入 `.forma.json` 后彻底离线可重开、可导出独立 React 工程**；
- 纯离线或网络不可达时，自动降级为纯 JS 生成的**高质感多色渐变 + 微妙暗角与细腻胶片颗粒 PNG**（零外部依赖，绝不报错中断流程）。

### 轨道 C · HTML/CSS → Forma 原生图层编译引擎（Worker C 独占）

| 文件 | 操作 | 职责与核心导出 |
| --- | --- | --- |
| `src/agent/html-to-forma.ts` | 新建 | 纯浏览器标准 DOM API（`HTMLElement`、`getComputedStyle`、`getBoundingClientRect`、`Range`）实现的确定性编译器，零第三方依赖，可在 Web / Electron / Playwright 中复用同一份代码。导出：`compileRenderedDomToForma(rootEl, options)`、`extractHtmlDocumentMeta(html)`、`hydrateLucideIconsInDom(rootEl)`、`HtmlToFormaOptions`、`HtmlToFormaResult`。 |
| `src/editor/html-forma-sandbox.ts` | 新建 | 浏览器端安全沙盒执行器与画板截屏器：创建隐藏 `<iframe sandbox="allow-same-origin">`（**无 `allow-scripts`**，CSP 禁脚本、禁外链脚本），注入安全基础样式表与模型 CSS、等待 `document.fonts.ready` 与本地化 `<img>` 解码、调用 `hydrateLucideIconsInDom` + `compileRenderedDomToForma` 输出标准 `Transaction`；提供 `captureFormaArtboardPng(doc, rootId, scale)`（复用现有 `exportNodeAsRaster`），供视觉自审回传 PNG。 |
| `tests/agent-html-to-forma.test.ts` | 新建 | 覆盖：Flex 行/列 AutoLayout 与 `gap`/`insets`/`justifyContent: space-between`、CSS Grid 列轨道、`position: absolute` 精准坐标、线性/径向多色标渐变、多层外阴影 + `inset` 顶部高光、`backdrop-filter: blur()`、`border-radius` 四角与单边描边 `strokeSides`、`<svg>` 矢量转换、`<img>` 转 `ImageFill + putImage`、文本样式提取、无意义空包裹层裁剪，以及最终 `parseDocument` + `transact` 校验通过。 |

**DOM-to-Forma 映射规范（核心保真规则）**：
1. **元素映射**：
   - 含文本直系子节点（无子元素或仅行内强调 span）→ `text`（用 `Range.getClientRects()` 测量真实绘制宽高，避免宽框裁切）或 `button`（`<button>` / `role="button"` 且单文本）；
   - `<svg>`（含由 `data-icon="..."` 水合的 Lucide 图标或数据图表）→ `vector`（解析 `<path>`/`<circle>`/`<ellipse>`/`<rect>`/`<line>`/`<polyline>`/`<polygon>`，保留 `viewBox`、`stroke`、`strokeWidth`、`fill`、`strokeLinecap`/`strokeLinejoin`）；
   - `<img>` → `rectangle`（或带子层的父 `frame` 背景）+ `node.image: { assetId, fit: objectFit === "contain" ? "contain" : "cover", x: 50, y: 50, zoom: 1 }` + `putImage`；
   - 容器（`div`/`section`/`header`/`nav`/`main`/`footer`/`article`/`a`）→ `frame`，根据 `computed.display` 映射 `layout: "row" | "column" | "grid" | "free"`，保留 `padding`→`insets`、`gap`、`justifyContent`、`alignItems`、`flexWrap`、`overflow: hidden`→`clipContent: true`；
   - **背景图 + 渐变压暗层叠加**：若父容器同时拥有绝对定位背景 `<img>` 与暗部遮罩层，自动保留层级顺序或合并为 `node.image + gradient` overlay，确保文字清晰可读且用户可单独调图或调遮罩！
2. **定位保真**：
   - `position: absolute | fixed` 子节点设置 `absolutePosition: true`，并按 `(childRect.left - parentContentLeft, childRect.top - parentContentTop)` 精确落位；
   - AutoLayout 内节点按 `flex-grow > 0` / `width === parentInnerWidth` 推导 `widthMode: "fill"`，行内紧凑元素推导 `widthMode: "hug"`，显式固定尺寸推导 `"fixed"`；
3. **空壳折叠与语义命名**：
   - 优先读取 `data-forma-name` / `aria-label` / 语义类名作为图层中文或清晰英文名称；
   - 严格过滤 `display: none` / `visibility: hidden` / `opacity: 0` / `0×0` 不可见节点，保证图层树干净整洁（典型移动首屏控制在 45–110 层，绝不产生垃圾套娃）。

### 轨道 D · 工具环、视觉自审引擎与编辑器接入（Phase 2 串行集成）

在轨道 A、B、C 全部编译与单测通过后，统一接入以下文件：

| 文件 | 变更内容 |
| --- | --- |
| `src/agent/forma-tools.ts` | ① 新增工具 `search_icons({ query, limit })` 与 `search_stock_images({ query, orientation, limit })`；② 新增提案工具 `propose_html_design({ reply, summary, width, height, name, html, css?, imageRefs? })`（校验安全 HTML、剥离 `<script>`/`on*=` 事件属性、预本地化所有引用摄影图与 Lucide `data-icon`、生成结构化 `HtmlDesignDraft`）；③ 在 `propose_design_changes` 中把本次会话检索到的图片资产自动透传给 `compileBlueprintToTransaction` 以生成 `putImage`。 |
| `src/agent/context-builder.ts` | 升级 Tool Mode 与 HTML-First 系统提示词：明确区分「新建整屏/视觉重设计优先 `propose_html_design`（配真实摄影 + Lucide `data-icon` + 现代玻璃/阴影/字阶/8pt 留白）」与「选中画板局部精修/组件实例覆写使用 `propose_design_changes`」；注入现代视觉工艺清单（禁止字母方块占位、禁止裸圆点假图标、明确摄影 Scrim 对比度与 8pt 间距规范）。 |
| `src/agent/design-engine.ts` | ① `AgentChatResult` 新增可选 `htmlDraft?: HtmlDesignDraft`（包含已安全消毒且图片已本地化为 `ImageAsset` 表的 `html`/`css`/`width`/`height`/`name`/`images`）；② 新增 `runVisualCritique(ctx, options)` 函数：接收初稿的 `htmlDraft`（或 `blueprint` 上下文）与 `renderedImageDataUrl`（1×/2× 真实画布 PNG 截图），在模型支持视觉（`supportsVision`）时发起 1 轮严格的「设计总监视觉审稿与精修」，输出修订后的 `htmlDraft` 或 `transaction` 与审稿摘要 `critiqueNotes`！ |
| `server/agent-http.ts` & `electron/main.mjs` | 新增 `POST /api/agent/critique` 路由（受既有 Origin 校验与 240s 超时保护），支持前端在零脚本沙盒编译并截屏后发起 1 轮视觉自审精修；同步在 Electron 放行路由。 |
| `src/editor/agent-client.ts`、`src/editor/AgentPanel.tsx`、`src/editor/CanvasAgentBar.tsx` | ① 当 `/api/agent/chat` 返回 `htmlDraft` 时，在浏览器端自动通过 `html-forma-sandbox.ts` 编译为原生 `Transaction` 并进入现有「画布实时预览 HUD → 采纳 → 单步撤销」闭环；② 若开启「视觉自审精修（支持识图模型默认可用）」开关，前端自动用 `exportNodeAsRaster()` 截取初稿画板 PNG 发往 `/api/agent/critique`，拿到精修 `htmlDraft` 后二次编译更新预览，全程在 SSE/进度条展示「正在排版编译原生图层… → 正在进行多模态视觉自审精修…」；③ 新增轻量模式切换（自动 / HTML 现代精排 / 蓝图组件编辑）。 |

---

## 三、安全与容错边界清单

| 风险点 | 防护措施 |
| --- | --- |
| 模型生成恶意 `<script>` / `onload=` / `javascript:` 链接 | ① 服务端 `sanitizeDesignHtml()` 强制剥离 `<script>`、`<iframe>`、`<object>`、`<embed>`、`on*=`、`javascript:`、`@import url(...)`；② 前端排版 `<iframe sandbox="allow-same-origin">` 永久禁用脚本执行。 |
| SSRF 通过图片 URL 探测内网/云元数据 | `localizeImageUrl()` 严格限制 `https:` + 域名白名单 + 禁止直连 IP / localhost / 私有网段，重定向二次校验，10s 超时，单图 ≤ 1.5 MiB，魔数校验真实位图字节。 |
| 离线环境或外部图库限流 | 自动降级为高质量内置/程序化大气渐变纹理位图，绝不导致提案崩溃或白图裂图。 |
| 不支持视觉的模型开启自审 | 服务端检查 `capabilities.supportsVision`：若为 `false`，直接优雅跳过视觉自审并返回初稿，不报错。 |
| 既有能力回归风险 | 所有新增字段均为可选扩展；`propose_design_changes` 蓝图链路与 327 项既有单测保持 100% 兼容。 |

---

## 四、验证策略

1. **单元测试**：
   - `tests/agent-visual-primitives.test.ts`（图标库、SVG、图片与 `putImage`、现代材质）
   - `tests/agent-media-assets.test.ts`（SSRF 防护、魔数解析、离线兜底、缓存）
   - `tests/agent-html-to-forma.test.ts`（DOM-to-Forma 布局/样式/矢量/图片/文字编译与文档回放）
   - 扩展 `tests/agent-tools.test.ts` 与 `tests/agent-http-integration.test.ts`（`search_icons`、`search_stock_images`、`propose_html_design`、`/api/agent/critique`）
   - 全仓 `npm test` 全部通过、`npm run format:check`、`npm run build`、`npm run desktop:agent` 通过。
2. **浏览器端到端回归**：运行 `agent-canvas-chat`（扩展覆盖 HTML-to-Forma 沙盒编译 + 预览采纳 + 单步撤销）、`optional-gateway`、`mcp`、`editor-panels`。
3. **真网同题代际对比实拍**：用同一 `DeepSeek-V4.1-Flash` + 同一「微光烘焙」咖啡 H5 需求运行 V2（HTML-First + 真实摄影 + Lucide 图标 + 1 轮视觉自审），在 Chromium 2× 实拍并与 V1 D 组同屏对比，验证所有图层可手改、可单步撤销、图片与矢量图标全部原生入库 `.forma.json`。
