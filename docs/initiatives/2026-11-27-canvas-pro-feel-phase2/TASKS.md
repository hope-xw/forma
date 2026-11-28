# Forma 画布一线手感升级（Phase 2 · v0.17.0）任务清单

- **课题状态**：已实施并验收（Phase 2 · 随 `v0.17.0` 发布）
- **最后更新**：2026-11-27

---

## 阶段一：问题勘察与课题立项
- [x] 复现并定位用户实机反馈 #1（`.frame-label` 仅选中不启拖拽、`section-title-pill` `pointer-events: none`、双击标题无画布原位编辑、右键标题丢失节点定位）
- [x] 核查 Lucide SVG 源码确认用户实机反馈 #2（`Inspector.tsx` 6 枚对齐图标水平/垂直完全反转）与 `editing.ts` `absolutePosition` 校验不一致
- [x] 落盘 `PRD.md`、`ENGINEERING.md`、`TASKS.md` 并登记 `docs/initiatives/README.md`

---

## 阶段二：三路并行 Codex CLI 施工（严格零文件重叠）

### Track 1：对齐图标与语义修复 + 远景画板 LOD 缓存引擎与渲染组件
- **独占文件**：
  - `src/domain/editing.ts`
  - `src/editor/Inspector.tsx`
  - `src/application/board-lod.ts`（新建）
  - `src/editor/board-tile-cache.ts`（新建）
  - `src/editor/BoardLodTile.tsx`（新建）
  - `tests/canvas-phase2-lod-align.test.ts`（新建）
- **任务项**：
  - [x] 修正 `Inspector.tsx` 全部 6 枚对齐图标映射与禁用提示，添加 `data-align-id` 属性；在文本属性区增加「转为矢量轮廓」按钮
  - [x] 修复 `src/domain/editing.ts` 对自动布局容器内 `absolutePosition: true` 子图层的对齐支持与 `firstChildOnTop` 反序图层堆叠
  - [x] 实现零 React/DOM 的 `src/application/board-lod.ts`（滞回策略、白名单、完整分支签名、不可安全栅格化图形保守保活与 LRU 字节预算缓存）
  - [x] 实现 `src/editor/board-tile-cache.ts` 与 `src/editor/BoardLodTile.tsx`（Fast Structural Canvas2D 离屏缩略绘制、分帧调度、Display P3 独立画布切换与瞬切活 DOM）
  - [x] 编写并通过 `tests/canvas-phase2-lod-align.test.ts`

### Track 2：高级矢量领域与基础设施引擎（多锚点 + Bend + 描边/文字轮廓化）
- **独占文件**：
  - `src/domain/vector-path.ts`
  - `src/domain/vector-outline.ts`（新建）
  - `src/infrastructure/text-outline.ts`（新建）
  - `tests/vector-advanced-phase2.test.ts`（新建）
- **任务项**：
  - [x] 扩充 `src/domain/vector-path.ts`（多锚点批量移动/删除/平滑转换、框选 `anchorsInRect`、线段最近点采样与 `bendSegment` 三次贝塞尔反解）
  - [x] 实现 `src/domain/vector-outline.ts`（O(1) 缓存预检 `canOutlineStroke`、原地 `convertToVector` `outlineStrokeOperations` 支持矢量/矩形/椭圆与描边对齐/端点/拐角/虚线百分比；`canOutlineText`、全 Unicode RTL/Bidi 保护、`outlineTextFromShapeOperations`、`buildTextOutlineVector`）
  - [x] 实现 `src/infrastructure/text-outline.ts`（异步加载 `harfbuzzjs` 解析 `doc.fonts` 生成原生矢量事务，系统字体清晰报错不损坏文本）
  - [x] 编写并通过 `tests/vector-advanced-phase2.test.ts`

### Track 3：矢量编辑器 UI（多锚点框选/Bend）+ 画板标题组件与样式表
- **独占文件**：
  - `src/editor/VectorEditor.tsx`
  - `src/editor/VectorInspector.tsx`
  - `src/editor/ArtboardLabel.tsx`（新建）
  - `src/editor/canvas-feel.css`
- **任务项**：
  - [x] 升级 `VectorEditor.tsx` 支持多锚点屏幕空间蓝框选、`Shift` 增减、`⌘A` 全选、批量拖拽/方向键微调（含 Fill 模式保护）/删除/平滑、Bend 工具切换与 `Option` 临时拖弯曲线段及单击锚点切换平滑/尖角
  - [x] 在 `VectorInspector.tsx` 新增「轮廓化描边（⇧⌘O）」按钮并接入统一可用性校验
  - [x] 实现 `src/editor/ArtboardLabel.tsx`（画板/分区/组件集/主组件/组件实例统一标题：左键拖移回调、悬停高亮、双击画布原位 IME 安全重命名、右键定位、键盘无障碍、锁定保护与工具态让位）
  - [x] 在 `src/editor/canvas-feel.css`（`@layer panels`，0 `!important`）补齐画板标题原位编辑、悬停外框、远景 LOD 瓦片与矢量框选/Bend 高亮样式

---

## 阶段三：主干集成与独立只读 Codex CLI 复审
- **独占集成文件（由集成 Codex CLI 执行）**：
  - `src/editor/Canvas.tsx`
  - `src/editor/CanvasNode.tsx`
  - `src/editor/actions.ts`
  - `src/editor/useEditor.ts`
  - `src/editor/ContextMenu.tsx`
- **任务项**：
  - [x] 在 `Canvas.tsx` 接入 `ArtboardLabel`（覆盖根画板、组件集、分区及分区内直接子画板）并抽离共享 `beginNodeDrag` 统一支持拖拽、吸附、Shift 轴锁、Alt 复制（含嵌套组件集克隆）、多选移动与单步撤销；移除 `CanvasNode.tsx` 中重复的不可交互 `.section-title-pill`
  - [x] 在 `Canvas.tsx` 接入 `BoardLodTile` 远景智能动静切换与 `board-tile-cache` 缓存回收；同步在 `useEditor.ts`、`Canvas.tsx`、`CornerRadiusHandles.tsx`、`GridHandles.tsx` 加固同步 `previewRef` AI 提案保护
  - [x] 在 `actions.ts`、`useEditor.ts`、`ContextMenu.tsx` 接入 `outlineStroke` / `outlineText` 与 `⇧⌘O` 快捷键
  - [x] 开展 6 轮独立只读 Codex CLI Code Review，逐项清零全部 P0/P1 并正式签核 **PASS（0 P0 / 0 P1）**
  - [x] 通过 `npm run format:check`、`npm run lint:arch`（`0 violations`，`as any: 1/1`，`CSS !important: 3/25`）、`npm test`（**1,324 / 1,325 通过，0 失败，1 跳过**）、`npm run build`

---

## 阶段四：画板交互专项 E2E、性能实测、2× Retina 实拍与 v0.17.0 桌面发版
- [x] 新增专项 E2E `scripts/check-canvas-phase2.browser.js`（并注册至 `scripts/run-browser-checks.mjs` 与 `scripts/verify-exports.mjs`）
- [x] 跑通 `canvas-phase2` + 全部 17 项核心回归 E2E（18/18 全过）+ `npm run test:exports -- canvas-phase2` 独立导出构建运行通过
- [x] 同机生产预览采集 `complex`（8,288 层 / 128 屏：`initialDomNodes` `8,288 → 128` -98.5%、`importMs` `1,281 → 1,054 ms`、`heapMiB` `88 → 64 MiB`、`rafP50/P95/Max = 17 ms` 0 掉帧）与 `layer-tree`（10,000 层）基准并归档至 `docs/evidence/2026-11-27/canvas-pro-feel-v17/metrics.json`
- [x] 采集深浅双主题 4 张 2× Retina 实拍（对齐工具栏特写、画板/分区标题原位改名与悬停高亮、128 屏远景 LOD 128/128 命中、矢量多锚点/Bend/描边与文字轮廓化）并人工逐张核验
- [x] 更新 `docs/ARCHITECTURE.md`、`docs/specs/EDITOR-UI-CONTROLS.md`、`docs/initiatives/README.md`、`docs/HANDOFF.md`、`docs/EDITOR-ACCEPTANCE.md`
- [x] 通过 `npm run release:assess` → `npm run release:run` 同步发布 **`v0.17.0`** 并完成只读挂载 `Forma-0.17.0-arm64.dmg` 实机验收

---

## 关键决策日志（ADR）

- **ADR-001（Fast Structural Canvas2D Painter 作为远景画板瓦片渲染器）**：避免对 128 张画板逐张序列化完整 SVG 并异步 `Image` 解码造成主线程卡顿或闪白，采用直接消费已计算 `layoutBounds` 与 `resolveNode` 的分帧 Canvas2D 结构化快速绘制（单板 `< 0.4 ms`，4ms/帧预算），同时在选中/悬停/编辑/放大 `>= 42%` 时瞬切回清晰活 DOM。
- **ADR-002（画板标题与画布点击共用同一拖拽状态机）**：在 `Canvas.tsx` 抽离 `beginNodeDrag`，确保拖标题与拖画板空白区享有完全一致的智能吸附、Shift 轴锁、Alt 复制、多选拖移、分区重挂与单步撤销，避免双份逻辑分叉。
- **ADR-003（文字转轮廓双源诚实降级）**：优先支持 `sourceTextShape` 与 `doc.fonts` 嵌入字体（经 `harfbuzzjs` `glyphToPath` 输出真实字形矢量），对无嵌入字节的纯系统字体明确提示先导入字体文件，绝不输出伪造几何框。
