# Forma 画布一线手感升级（Phase 1 · v0.16.0）任务清单

- **课题状态**：已实施并验收（Phase 1 · 随 `v0.16.0` 发布）
- **最后更新**：2026-11-27

---

## 阶段一：需求对齐与立项
- [x] 与用户通过 `/grill-me` 完成全部 5 项产品体验决策（单人极致顺滑 + 高频直操范围、50–150 屏标准线、智能动静切换策略、三大直操清单、两阶段交付节奏、macOS 桌面端 + Chrome 验收标尺）
- [x] 勘察 `Canvas.tsx`、`geometry.ts`、`CanvasRulers.tsx`、`ViewOptionsMenu.tsx`、`App.tsx` 与 `check-architecture.mjs` 架构门禁
- [x] 落盘 `PRD.md`、`ENGINEERING.md`、`TASKS.md` 并登记 `docs/initiatives/README.md`

---

## 阶段二：三路并行 Codex CLI 施工（严格零文件冲突）

### Track 1：核心相机、宽域缩放、增强吸附与空间索引引擎
- **独占文件**：
  - `src/domain/geometry.ts`
  - `src/domain/spatial-index.ts`（新建）
  - `src/application/canvas-camera.ts`（新建）
  - `tests/canvas-engine-phase1.test.ts`（新建）
- **任务项**：
  - [x] 扩展 `MIN_ZOOM = 0.02`、`MAX_ZOOM = 64`，扩展 `SnapGuide` 线段起止元数据并保持旧接口 100% 兼容
  - [x] 实现纯领域 `SpatialIndex`（网格桶 + 大物体表 + `WeakMap` 缓存），支撑 O(1)/O(k) 容器点命中与视口查询（万层最小容器命中 229µs → 4.87µs）
  - [x] 实现纯应用层 `canvas-camera.ts`（`CameraChannel` 高频/防抖双轨分发、平滑滚轮/触控板 pinch 曲线、缩放档位步进、小地图坐标互算）
  - [x] 编写并通过 `tests/canvas-engine-phase1.test.ts`（本文件 **15/15** 通过；连同既有 `editing`、`pages` 回归合计 **37/37**）

### Track 2：高频画布直操（圆角圆点手柄 + 自动布局粉色 Padding/Gap 直拖）
- **独占文件**：
  - `src/application/canvas-handles.ts`（新建）
  - `src/editor/CornerRadiusHandles.tsx`（新建）
  - `src/editor/AutoLayoutHandles.tsx`（新建）
  - `tests/canvas-handles.test.ts`（新建）
- **任务项**：
  - [x] 实现零 React 纯应用层 `canvas-handles.ts`（圆角均匀/单角/`Shift` 步进/钳制/实例保护；自动布局 Padding 单边/对称/四边与 Gap 拖拽/禁 `space-between`）
  - [x] 实现 `CornerRadiusHandles.tsx`（四角圆点 + 拖动实时数值胶囊 + `Esc` 取消 + 小尺寸避让 + 单步提交）
  - [x] 实现 `AutoLayoutHandles.tsx`（粉色斜纹内边距带 + 子项间隙粉色手柄 + 实时粉色读数胶囊 + `Option` 对称 + `Shift` 步进 + 单步提交）
  - [x] 编写并通过 `tests/canvas-handles.test.ts`（**25/25** 通过，涵盖均匀/单角圆角、单边/对称/四边内边距、Gap、`space-between`、容器断点、双插序变量绑定、微秒级快路径与防重叠）

### Track 3：Canvas2D 高频 HUD 覆盖层、画布小地图与双主题样式表
- **独占文件**：
  - `src/application/minimap-layout.ts`（新建）
  - `src/editor/CanvasOverlayHud.tsx`（新建）
  - `src/editor/CanvasMinimap.tsx`（新建）
  - `src/editor/canvas-feel.css`（新建）
  - `tests/canvas-minimap-hud.test.ts`（新建）
- **任务项**：
  - [x] 实现高 DPI 单层 `<canvas>` `CanvasOverlayHud.tsx`（订阅 `CameraChannel`，120 次高频更新 0 React 提交）
  - [x] 实现 `CanvasMinimap.tsx`（右下角玻璃态百屏缩略导航、点击瞬移、拖拽蓝色视口框、折叠/展开、短窗避让）
  - [x] 实现 `@layer panels` 样式表 `canvas-feel.css`（0 `!important`、深浅双主题对比度 ≥ 4.5:1）
  - [x] 编写并通过 `tests/canvas-minimap-hud.test.ts`（**12/12** 通过，含蓝框零跳变与方向键导航）

---

## 阶段三：主干集成与只读 Codex CLI Code Review
- **独占集成文件（由集成 Codex CLI 执行）**：
  - `src/editor/Canvas.tsx`
  - `src/editor/CanvasRulers.tsx`
  - `src/editor/ViewOptionsMenu.tsx`
  - `src/editor/App.tsx`
  - `src/editor/useEditor.ts`（注册 `⇧M` 小地图快捷键与动作路由，如有需要）
- **任务项**：
  - [x] 将 `CameraChannel`、`SpatialIndex`、`CornerRadiusHandles`、`AutoLayoutHandles`、`CanvasOverlayHud`、`CanvasMinimap` 与 `canvas-feel.css` 无缝接入主画布与顶栏/菜单
  - [x] 开展 5 轮独立只读 Codex CLI Code Review，全部 P0/P1 问题清零签收（**PASS — 0 P0 / 0 P1**；64 项双插序变量编辑 × 128 次模式对照全部通过）
  - [x] 通过 `npm run format:check`、`npm run lint:arch`、`npm test`、`npm run build`

---

## 阶段四：全量 E2E、性能实测对比、2× Retina 实拍与 v0.16.0 桌面发版
- [x] 新增浏览器 E2E 测试 `scripts/check-canvas-pro-feel.browser.js`（并注册至 `scripts/run-browser-checks.mjs` 与 `scripts/verify-exports.mjs`）
- [x] 跑通新增 E2E + 16 组既有核心回归 E2E（**17 / 17** 通过）+ `npm run test:exports -- canvas-pro-feel` 独立导出构建验收
- [x] 在生产预览模式下同机采集 `layer-tree`（万层）、`complex`（8,288 层 / 128 画板）及 30 帧高频滚轮缩放（0 React 重渲染、最大偏差 0.000519 px）/ 8,320 层直操预览（0.030 ms P95）性能实测数据，归档至 `docs/evidence/2026-11-27/canvas-pro-feel-v16/`
- [x] 采集深浅双主题 2× Retina 实拍（圆角与自动布局粉色手柄、浅色高对比度、高倍像素网格与视图菜单、128 画板百屏小地图）并逐张核验通过
- [x] 更新 `docs/ARCHITECTURE.md`、`docs/specs/EDITOR-UI-CONTROLS.md`、`docs/HANDOFF.md`、`docs/EDITOR-ACCEPTANCE.md` 与 `docs/initiatives/README.md`
- [x] 运行 `npm run release:assess` → `npm run release:run` 同步发布 **`v0.16.0`**（含只读挂载 `Forma-0.16.0-arm64.dmg` 实机验收）

---

## 关键决策日志（ADR）

- **ADR-001（混合分层而非重写 C++/WASM 引擎）**：保住 Forma 的 0 CSS px Web 语义与 React 增量编译壁垒，通过「零 React 相机 + Canvas2D 高频 HUD + 空间索引（Phase 1）」与「远景画板缩略缓存动静切换（Phase 2）」分两步达成 50–150 屏一线手感。
- **ADR-002（小地图默认收纳策略）**：常规 1–5 屏小稿与短窗口（画布可视区域 `< 1080×540`）下小地图默认折叠，单页根画板 `>= 6` 且画布可视区域 `>= 1080×540` 时自动温和展开，并随时支持 `⇧M` 与视图菜单切换，兼顾干净界面与百屏定位效率。
- **ADR-003（圆角与自动布局直操单步原子事务）**：所有拖拽过程仅通过 `previewGeometry` 更新暂态，松手通过 `e.apply(ops, baseRevision)` 一次性提交并严格遵循锁定与组件实例保护规则，确保一次 `⌘Z` 完整撤销。
