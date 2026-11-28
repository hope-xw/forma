# Forma 画布一线手感升级（Phase 2 · v0.17.0）工程设计

- **最近更新日期**：2026-11-27
- **状态**：已实施并验收（随 `v0.17.0` 发布）
- **架构纪律**：严守 [check-architecture.mjs](../../../scripts/check-architecture.mjs) 单向分层依赖（`domain` 零 React/DOM/application/infrastructure；`application` 零 React/DOM；全仓 `as any <= 1`；新增编辑器 CSS 全部归入 `@layer panels` 且 0 `!important`）。

---

## 一、系统模块设计

```text
[Pillar 1: 画板交互与对齐修正]
  ├── src/domain/editing.ts           (alignOperations 放行 absolutePosition 子图层，保持自由/多选/旋转对齐精确)
  ├── src/editor/Inspector.tsx        (修正 6 枚对齐图标 SVG 映射：Left/Center/Right 用 Vertical 线，Top/Middle/Bottom 用 Horizontal 线)
  └── src/editor/ArtboardLabel.tsx    (统一画板/分区/组件集标题：拖拽移动、多选联动、悬停高亮、双击原位 IME 重命名、右键与工具让位)

[Pillar 2: 50-150 屏远景智能缩略缓存动静切换]
  ├── src/application/board-lod.ts    (零 React/DOM：LOD 判定 + 0.38/0.42 滞回 + 活 DOM 白名单 + 子树签名 + LRU 字节预算缓存)
  ├── src/editor/board-tile-cache.ts  (Fast Structural Canvas2D 离屏缩略绘制器 + 分帧时间片调度 <= 4ms/帧 + 资源回收)
  └── src/editor/BoardLodTile.tsx     (单 DOM 缓存节点，保留 data-node-id 与 data-lod="cached"，点击/放大瞬切活 DOM)

[Pillar 3: 高级矢量编辑]
  ├── src/domain/vector-path.ts       (多锚点批量操作、anchorsInRect 框选、nearestSegmentPoint 与 bendSegment 三次贝塞尔反解)
  ├── src/domain/vector-outline.ts    (纯领域：outlineStrokeOperations + outlineTextFromShapeOperations + buildTextOutlineVector)
  ├── src/infrastructure/text-outline.ts (异步加载 harfbuzzjs，从 doc.fonts 解析字形轮廓交给 domain 构造成原生矢量事务)
  ├── src/editor/VectorEditor.tsx     (多锚点蓝框选、Shift/⌘A、批量拖拽/微调/删点/平滑、Bend 工具与 Option 临时拖弯)
  └── src/editor/VectorInspector.tsx + ContextMenu.tsx + actions.ts + useEditor.ts (统一 ⇧⌘O 与右键/命令/右栏轮廓化入口)
```

---

## 二、关键接口与精确契约

### 1. 对齐图标与行为映射（单一真相源）

| `Alignment` ID | 中文语义 | Lucide 图标 | 视觉特征 | 像素行为 |
| --- | --- | --- | --- | --- |
| `left` | 左对齐 | `AlignStartVertical` | 左侧竖基准线 `M2 2v20` + 水平条左齐 | `dx = box.x - r.x` |
| `center` | 水平居中 | `AlignCenterVertical` | 中央竖基准线 `M12 2v20` + 水平条居中 | `dx = box.x + (box.width - r.width)/2 - r.x` |
| `right` | 右对齐 | `AlignEndVertical` | 右侧竖基准线 `M22 22V2` + 水平条右齐 | `dx = box.x + box.width - r.width - r.x` |
| `top` | 顶对齐 | `AlignStartHorizontal` | 顶部横基准线 `M22 2H2` + 垂直条顶齐 | `dy = box.y - r.y` |
| `middle` | 垂直居中 | `AlignCenterHorizontal` | 中央横基准线 `M2 12h20` + 垂直条居中 | `dy = box.y + (box.height - r.height)/2 - r.y` |
| `bottom` | 底对齐 | `AlignEndHorizontal` | 底部横基准线 `M22 22H2` + 垂直条底齐 | `dy = box.y + box.height - r.height - r.y` |
| `horizontal` | 水平等距分布 | `AlignHorizontalSpaceAround` | 左右竖线 + 中央块 | 水平均分间隙 |
| `vertical` | 垂直等距分布 | `AlignVerticalSpaceAround` | 上下横线 + 中央块 | 垂直均分间隙 |

### 2. 画板标题组件契约（`ArtboardLabel.tsx`）
- 渲染目标：
  1. 页面根级 `frame`、`section`、`componentSet`；
  2. 直接位于 `section` 内的子 `frame` / `componentSet`（与 Figma 保持一致，分区内画板也可直接拖标题移出/调整位置）。
- 位置坐标：
  - 位于 `.canvas-live-overlays` 中跟随相机实时同步；`left = viewport.x + visualRect.x * viewport.zoom`，`top = viewport.y + visualRect.y * viewport.zoom - 8`（`transform: translateY(-100%)`），给顶部缩放边留出 `>= 4 px` 无误触间隙；
  - `section` 标题沿用 `.section-title-pill` 类名（确保兼容既有 E2E 选择器）并附带 `devStatus` 徽标（`Ready for dev` / `Completed`），移除 `CanvasNode.tsx` 中原有的不可交互 `pointer-events: none` 重复副本。
- 事件路由：
  - `onPointerDown`（左键）：若非锁定且处于 `select`/`scale` 工具且未按空格，调用 `Canvas.tsx` 暴露的统一 `beginNodeDrag(event, node.id)`，与画布内点击共用同一套选区、`Shift` 多选、`Alt` 复制、吸附、重挂 `section`、单步撤销状态机；
  - `onDoubleClick`：打开画布原位 `<input className="frame-label-editor">`（不强依赖左栏是否展开），中文输入法 `compositionstart/end` 安全，`Enter`/失焦通过 `e.apply([{ type: "update", id, patch: { name } }])` 单步提交，`Esc` 取消还原；
  - `onContextMenu`：附带 `data-frame-label-id={node.id}`，右键自动选中并弹出画板上下文菜单；
  - `onPointerEnter` / `onPointerLeave`：同步 `hoveredLabelId` 为对应画板绘制轻量悬停高亮框。

### 3. 远景画板智能 LOD 缓存契约（`board-lod.ts` + `board-tile-cache.ts`）
- **滞回阈值**：
  - `LOD_ENTER_ZOOM = 0.38`，`LOD_EXIT_ZOOM = 0.42`；
  - 文档规模阈值：`rootBoardCount >= 12 || totalNodeCount >= 600`；
  - 单板复杂度阈值：`descendantCount > 8`（极简画板直接保持活 DOM）；
- **强制活 DOM 白名单**：
  - `selectedRootIds.has(id)`（含任一后代被选中）、`editingRootId === id`、`hoveredRootId === id`、`draggingIds.has(id)`、`aiPreviewRootIds.has(id)`、`outlineMode === true`、`showLayoutGuides === true && hasLayoutGuides`。
- **缓存一致性与内存安全**：
  - `boardBranchSignature(doc, rootId)` 纳入该分支所有可见节点几何/样式/文本/图片 ID/矢量路径摘要及当前生效的 `designSystem.activeModes` 与 `colorProfile`，任何改动立即触发重绘；
  - `LruTileCache` 默认上限 `48 MiB` / `180` 项，淘汰与组件卸载时释放离屏 canvas（置宽/高为 0）防 Safari/Chromium Canvas 内存滞留；
  - `BoardLodTile` 绘制分辨率按 `Math.min(0.5, Math.max(0.25, zoom * dpr * 1.5))`（上限 `512px` 边长）自适应，兼顾清晰度与极低显存。

### 4. 高级矢量编辑契约（`vector-path.ts` + `vector-outline.ts` + `text-outline.ts`）
- **多锚点选择**：`selectedAnchors: AnchorIndex[]`（去重、支持 `Shift` 切换、框选 `anchorsInRect(paths, rect)`、`⌘A` 全选）；拖动其中任一已选锚点时批量应用同一偏移 `dx, dy`（同时处理相连 `junction` 去重防双重偏移）。
- **Bend 弯曲算法（`bendSegment`）**：
  - 给定锚点 $A, B$ 及曲线参数 $t \in [0.15, 0.85]$，设原曲线点 $P_0 = B(t)$，拖拽位移 $\Delta = P_{\text{target}} - P_0$；
  - 当线段为直线（`!A.outgoing && !B.incoming`）时，先初始化三次控制柄 $C_1 = \text{mix}(A, B, 1/3)$、$C_2 = \text{mix}(A, B, 2/3)$；
  - 按三次 Bernstein 基函数权重 $w_1 = 3(1-t)^2 t$、$w_2 = 3(1-t) t^2$ 分配位移：
    $$\Delta C_1 = \frac{w_1}{w_1^2 + w_2^2} \Delta,\quad \Delta C_2 = \frac{w_2}{w_1^2 + w_2^2} \Delta$$
    保证拖拽后曲线严格通过光标目标点 $B'(t) = P_{\text{target}}$，且两控制柄自然平滑对称！
  - 在 Bend 模式下单击锚点：`toggleAnchorSmooth(paths, at)` 在平滑手柄与尖角（移除手柄）间切换。
- **描边轮廓化（`outlineStrokeOperations`）**：
  - 支持 `vector`（开放/闭合路径，每条有 `strokeWidth > 0` 的子路径生成闭合填充轮廓）、`rectangle`、`ellipse`（支持 `strokeAlign: inside | center | outside` 与圆角）；
  - 开放/闭合路径通过自适应曲线细分为折线 + 左右法向偏移 + 精确 `butt`/`round`/`square` 端点帽 + `miter`/`round`/`bevel` 拐角连接 + Paper.js `unite` 消除自交折痕，输出干净的 `fill: true, strokeWidth: 0` 闭合路径；
  - 保持原节点位置、旋转、缩放、父级与图层序，单步原子事务提交支持 `⌘Z` 撤销；锁定节点与组件实例内部节点拒绝执行。
- **文字转轮廓（`outlineTextFromShapeOperations` / `outlineTextNode`）**：
  - 优先路径 1：`currentTextShape(resolved)` 已有源字形 SVG 路径 → 零依赖同步转为原生 `vector` 节点；
  - 优先路径 2：从 `doc.fonts` 匹配目标字体（支持 Base64 data URL 解码为 `Uint8Array`）→ 通过 `harfbuzzjs` 排版并用 `font.glyphToPath(gid)` 逐字形提取真实三次/二次贝塞尔轮廓，按 `fontSize / upem`、行高、字距、水平/垂直对齐定位组装为原生可编辑 `vector` 节点；
  - 降级边界：若文本使用纯系统字体且无 `sourceTextShape` 与 `doc.fonts` 嵌入字节，返回明确中文提示（「当前文字使用系统字体且未嵌入字体文件，请先在右栏字体资源中导入该字体文件后再转为轮廓」），不静默损坏文本图层。

---

## 三、测试与验收矩阵

| 层级 | 范围 | 验证方式 |
| --- | --- | --- |
| 纯单元/领域测试 | 对齐（含 `absolutePosition`）、LOD 滞回/白名单/签名/LRU、多锚点批量操控、Bend 反解精度、描边轮廓化（开放/闭合/圆角/椭圆/端点/连接）、文字转轮廓（`sourceTextShape` + `forma-geometry-test.ttf` HarfBuzz） | `npm test`（新增 `canvas-phase2-lod-align.test.ts`、`vector-advanced-phase2.test.ts`） |
| 架构与样式门禁 | 零反向依赖、`as any <= 1`、`CSS !important <= 3`（0 新增）、Prettier、生产分包 | `npm run format:check && npm run lint:arch && npm run build` |
| 真实浏览器 E2E | `canvas-phase2`（画板标题全交互、对齐图标 SVG+行为验证、128 屏远景 LOD DOM 骤降与瞬切回活、矢量多锚点/Bend/轮廓化、`.forma` 重开与导出）+ 全量既有核心套件 | `npm run test:browser` |
| 导出独立工程 | `canvas-phase2` 导出 React ZIP 隔离安装、构建与 Chromium 渲染验证 | `npm run test:exports -- canvas-phase2` |
| 大文档性能对比 | 生产预览下同机实测 `complex`（8,288 层 / 128 屏）与 `layer-tree`（10,000 层）+ 128 屏远景 LOD DOM 数与帧率对比 | 归档至 `docs/evidence/2026-11-27/canvas-pro-feel-v17/metrics.json` |
| 视觉与桌面实机 | 2× Retina 深浅双主题实拍人工复核（含对齐工具栏特写）+ `npm run release:run` 产出 `Forma-0.17.0-arm64.dmg` 并通过只读挂载实机验收 | `docs/evidence/2026-11-27/desktop-0.17.0.json` |
