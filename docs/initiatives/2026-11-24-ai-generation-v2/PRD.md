# PRD · Forma AI 生成引擎 V2：跨越代差的现代 UI 生成架构

- **课题编号**：`2026-11-24-ai-generation-v2`
- **状态**：实施中（Wave 1：核心视觉资产 + HTML/CSS-to-Forma 编译 + 视觉自审闭环）
- **立项日期**：2026-11-24
- **关联文档**：[工程设计文档 ENGINEERING.md](ENGINEERING.md) · [任务清单 TASKS.md](TASKS.md) · [V1 真实 DeepSeek 五组评测基线](../../evidence/2026-11-24/ai-benchmark/REPORT.md)

---

## 一、背景与真实痛点（来自 V1 实拍复盘）

在 2026-11-24 使用真实云端 `DeepSeek-V4.1-Flash` 完成的 A/B/C/D/E 五组实拍对比（[V1 对比图](../../evidence/2026-11-24/ai-benchmark/comparison.png)）中，Forma 已跑通多模态识图、10 大原生工具、9 款开源社区 Skill 与单步撤销，但生成成品与 **Figma Make / First Draft、Claude Design、OpenDesign、Google Stitch** 等 2026 业界标杆相比仍存在明显「代差」，呈现 2020 年代线框稿质感：

1. **缺失真实摄影与产品图**：`BlueprintNode` 不支持 `image` 资产，Hero 横幅与商品卡被迫用单色渐变块加字母 `Y` / `H` / `ROAST 01` 占位，视觉廉价感最强；
2. **缺失语义矢量图标库**：模型无法按名调用图标，只能画白色圆角方块/圆点或直接省略底栏图标；
3. **专有 JSON 盲画的天花板**：大模型预训练中见过数十亿行顶级 HTML/CSS/SVG，从未见过 Forma 专有 JSON；迫使模型手算 844px 高度和嵌套 `widthMode` 消耗了大部分推理预算，且无真实浏览器字体度量，易贴边与局促；
4. **Forma 引擎已有高级现代材质未暴露给 AI**：`backdropBlur`（液态毛玻璃）、`cornerSmoothing`（超椭圆圆角）、`inset` 顶部 1px 高光边、多层弥散阴影、径向氛围光斑与内联 SVG 图表均未接入 AI 表达层；
5. **缺少「睁眼看图」视觉自审闭环**：模型只看到服务端文本 Lint 数字，从未亲眼看到自己渲染出来的成品截图；
6. **单轮盲出单稿**：缺少先定美术指导（Art Direction / `DESIGN.md`）与无限画布多方向方案并排探索机制。

---

## 二、产品目标与分期范围

### Wave 1（本期实施并实拍验收）

| 目标维度 | 具体交付能力 | 设计师可感知的质变 |
| --- | --- | --- |
| **1. 语义矢量图标系统** | 内置 240+ 高频 Lucide 矢量图标（覆盖导航、电商、餐饮咖啡、社交、控制、数据、媒体、设备等），支持中英文关键词检索（`search_icons`）与蓝图/HTML 直接按名渲染为可编辑 Forma `vector` 图层 | 彻底消灭白方块/圆点假图标，搜索、定位、购物袋、底栏 Tab 统一 1.75px 精致线框矢量 |
| **2. 真实摄影配图管线** | 蓝图与 HTML 双通道全面支持 `image` 资产与 `putImage` 本地化（含 `cover` 裁切、圆角、暗部渐变 Scrim 遮罩），提供安全 HTTPS 精选摄影检索与离线高质感兜底 | Hero 大图、单品咖啡豆摄影、人物头像均呈现真实商业级影像，且离线重开与 React 导出自带图片资源 |
| **3. 现代材质与内联 SVG 表达** | 解锁 Forma 原生 `backdropBlur`、`cornerSmoothing`、多层阴影（含 `inset` 玻璃高光）、多重填充、径向辉光与内联 `<svg>` 微图表/图形直转 `vector` | 界面具备现代毛玻璃浮层、精细 1px 光泽边框、柔和层次与矢量风味雷达/指标图 |
| **4. HTML/CSS → Forma 原生图层编译引擎** | 新增 **现代精排模式（HTML-First）**：AI 输出标准 HTML + CSS + Lucide 图标 + 摄影图，在零脚本安全沙盒 DOM 真实排版后，1:1 编译为**完全可手改、保留 AutoLayout、可单步撤销、可导出 React** 的 Forma 原生图层 | 释放大模型最强的 HTML/CSS 审美与排版能力，真实中英字体度量彻底消除盲画挤压；同时保留现有 Blueprint 引擎专攻局部编辑与组件实例覆写 |
| **5. 多模态「睁眼看图」视觉自审闭环** | 编辑器与评测管线支持将初稿画板渲染为 PNG 截图回喂给多模态模型，由模型按「视觉焦点 / 留白韵律 / 贴边与对比度 / 图标与图文层次」执行 1 轮定向视觉精修 | 肉眼可见的拥挤、贴边、对比度与比例瑕疵自动收敛 |

### Wave 2（下期规划，本期明确不提前铺开）

- **美术指导确认卡（`DESIGN.md` Interactive Brief）**：生成前先产出可微调的风格/色板/字体/摄影方向卡；
- **无限画布 2–3 方向并行探索**：单次输入在画布并排生成 2–3 套差异化审美方案供挑选；
- **云端图生图（Imagen / Flux / GPT-Image）配置接入**：允许用户在模型配置页绑定独立生图供应商；
- **生成后一键吸附文档 Design System Token** 交互开关与跨模型（Claude / Gemini / GPT / DeepSeek）横向评测。

---

## 三、产品边界与安全红线

1. **零模型配置时手动编辑器完全可用**：未配置任何模型 Key 或断网时，所有手动编辑、组件库、原型与导出功能保持 0 外部网络请求。
2. **原生可编辑性不可妥协**：HTML-to-Forma 生成的绝不是一张死图片或黑盒 iframe，必须编译为标准 Forma `DesignDocument` 图层树，通过 `parseDocument` 与 `transact` 校验，支持点选改字、拖拽 AutoLayout、调整属性、`⌘Z` 单步撤销与 React 工程导出。
3. **沙盒与网络安全红线**：
   - 浏览器内 HTML 排版沙盒严格使用 `<iframe sandbox="allow-same-origin">`（**严禁 `allow-scripts`**，杜绝任意 JS 执行与 XSS）；
   - 服务端摄影图下载严格校验 HTTPS 协议 + 域名白名单（防 SSRF 访问内网/本机元数据地址）、单图 ≤ 1.5 MiB、超时 ≤ 10s、魔数校验真实图片格式（PNG/JPEG/WebP），绝不信任任意外链。
4. **向后兼容**：既有 327 项单元测试、蓝图编辑模式、10 大工具、9 款开源社区 Skill 与 7 工具外部 MCP Server 保持 100% 向后兼容。

---

## 四、Wave 1 验收口径（Definition of Done）

1. **工程质量**：全仓 `npm test` 全部通过（新增视觉原语、媒体安全下载、HTML-to-Forma 编译与自审集成测试）、`npm run format:check`、`npm run build`、`npm run desktop:agent` 通过，浏览器端到端回归通过。
2. **真实模型同题代际对比（核心验收）**：
   - 使用**同一台机器、同一个 `DeepSeek-V4.1-Flash` 模型、同一道「微光烘焙 · Lumina Roasters」390×844 移动 H5 需求**，跑通 **V2（HTML/CSS-to-Forma + 真实摄影 + Lucide 图标 + 视觉自审）** 并与 **V1 最佳 D 组** 同屏并排实拍对比；
   - 必须肉眼可验证：真实咖啡摄影图（本地化入库 `doc.images`）、真实矢量图标（底栏/搜索/按钮无白方块）、清晰现代层级与毛玻璃/阴影质感、零裁剪溢出；
   - 必须在真实 Chromium 编辑器打开 V2 生成的 `.forma.json`，验证点击文本图层修改文案 + `⌘Z` 单步撤销 + 导出或校验结构完整通过。
