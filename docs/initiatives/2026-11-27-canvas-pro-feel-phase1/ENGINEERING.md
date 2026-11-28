# Forma 画布一线手感升级（Phase 1 · v0.16.0）工程设计

- **最近更新日期**：2026-11-27
- **状态**：已实施并验收（Phase 1 · 随 `v0.16.0` 发布）
- **架构纪律**：严格遵守 `scripts/check-architecture.mjs` 分层单向依赖（`domain` 零 React/DOM/application；`application` 零 React/DOM；全仓 `as any <= 1`；新增编辑器 CSS 全部写入 `@layer panels` 且 0 `!important`）。

---

## 一、系统架构图

```text
[Wheel / Trackpad Pinch / Space-Pan / Minimap Drag]
                      │
                      ▼
       src/application/canvas-camera.ts
     (CameraChannel: 零 React 120Hz 相机频道)
       ├── 高频即时回调 (rAF 60-120Hz) ──► .canvas-world transform ref 直操
       │                                 ──► CanvasOverlayHud (<canvas> 2D 像素网/红线/标尺辅助)
       │                                 ──► CanvasMinimap (<canvas> 视口蓝框实时同步)
       └── 停稳防抖回调 (settle ~72ms) ──► React setViewport() (更新裁剪、顶栏缩放读数与表单)

[Document Geometry + Transforms]
       ├── src/domain/geometry.ts       (MIN_ZOOM=0.02, MAX_ZOOM=64, 增强 SnapGuide 线段元数据)
       └── src/domain/spatial-index.ts  (SpatialIndex: 统一网格桶空间索引 + WeakMap 缓存)
                 ├── queryPoint(p)  ──► O(1) 容器/分区命中 (替代 Canvas.tsx 全表 O(N) 扫描)
                 └── queryRect(r)   ──► O(k) 视口裁剪 & 框选加速

[Direct Manipulation Handles]
       └── src/application/canvas-handles.ts (纯几何计算 + 原子 Operation[] 构造)
                 ├── CornerRadiusHandles.tsx  (四角圆点: 均匀 / Option单角 / Shift 4px步进)
                 └── AutoLayoutHandles.tsx    (粉色 Padding 边 + Gap 间隙: 单边/对称/四边)
```

---

## 二、核心模块与精确接口契约

### 2.1 `src/domain/geometry.ts`（扩展）
- 缩放常量升级：
  ```ts
  export const MIN_ZOOM = 0.02;
  export const MAX_ZOOM = 64;
  ```
- 吸附引导线向后兼容扩展：
  ```ts
  export interface SnapGuide {
    axis: "x" | "y";
    value: number;
    /** 精确起止坐标（世界坐标），用于 Canvas2D 绘制起止端点截线而非全屏穿透线 */
    start?: number;
    end?: number;
    /** 吸附来源类型：对象边缘、中心或页面标尺辅助线 */
    kind?: "edge" | "center" | "ruler";
  }
  ```
  - `createSnapIndex` 可记录每个吸附值的参考跨度（`spanMin`/`spanMax`），`snapMoveIndexed` 返回带 `start`/`end`/`kind` 的 `SnapGuide[]`，同时保持原有 `dx`, `dy`, `guides: { axis, value }[]` 语义 100% 向后兼容。

### 2.2 `src/domain/spatial-index.ts`（新建 · 纯领域零 DOM/React）
- 数据结构：基于自适应单元大小（默认 `cellSize = 256` world px）的二维空间哈希网格（带超大物体溢出列表 `largeItems`，防止超大 Section/背景画板占据过多桶），按 `WeakMap<DesignDocument, SpatialIndex>` 自动缓存：
  ```ts
  export interface SpatialEntry {
    id: string;
    rect: Rect; // world visualBounds
    type: DesignNode["type"];
    parentId: string | null;
    area: number;
    order: number; // 文档绘制顺序
  }
  export interface SpatialIndex {
    queryRect(rect: Rect): SpatialEntry[];
    queryPoint(point: Point): SpatialEntry[];
    findSmallestContainerAt(
      point: Point,
      predicate: (entry: SpatialEntry) => boolean,
    ): string | null;
  }
  export function buildSpatialIndex(
    doc: DesignDocument,
    bounds: Map<string, Rect>,
    transforms: Map<string, Matrix>,
  ): SpatialIndex;
  ```
- 正确性约束：对任意查询点与矩形，必须与线性遍历全量节点返回完全一致的候选集（无漏检）。

### 2.3 `src/application/canvas-camera.ts`（新建 · 零 React/DOM）
- 导出类型与核心函数：
  ```ts
  export interface WheelDeltaInput {
    deltaX: number;
    deltaY: number;
    deltaMode: number; // 0=px, 1=line, 2=page
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    anchor: Point; // canvas 局部坐标
  }
  export function applyWheelToViewport(
    current: Viewport,
    input: WheelDeltaInput,
  ): { viewport: Viewport; kind: "zoom" | "pan" };

  export function stepZoomLevel(currentZoom: number, direction: 1 | -1): number;

  export interface CameraState {
    viewport: Viewport;
    interacting: boolean;
  }
  export interface CameraChannel {
    get(): Viewport;
    isInteracting(): boolean;
    /** 高频更新：同步派发即时监听者，延迟 settleMs 触发 settled 监听者 */
    setLive(next: Viewport): void;
    /** 立即提交（切页/fit/按钮缩放/测试脚本）：同步更新并立刻派发两类监听者 */
    setImmediate(next: Viewport): void;
    /** 标记高频交互结束并立刻结算 */
    flush(): void;
    subscribeLive(listener: (state: CameraState) => void): () => void;
    subscribeSettled(listener: (viewport: Viewport) => void): () => void;
    dispose(): void;
  }
  export function createCameraChannel(
    initial: Viewport,
    options?: { settleMs?: number; scheduleTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout },
  ): CameraChannel;

  export interface MinimapLayout {
    worldBounds: Rect;
    scale: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  }
  export function computeMinimapLayout(
    rects: readonly Rect[],
    viewport: Viewport,
    surfaceSize: { width: number; height: number },
    mapSize: { width: number; height: number },
    padding?: number,
  ): MinimapLayout;
  export function minimapPointToViewport(
    point: Point,
    layout: MinimapLayout,
    viewport: Viewport,
    surfaceSize: { width: number; height: number },
  ): Viewport;
  export function worldRectToMinimap(rect: Rect, layout: MinimapLayout): Rect;
  ```
- 缩放曲线：对 `ctrlKey || metaKey` 的小步进触控板 pinch（`|deltaY| <= 40`）使用平滑指数 `Math.exp(-dy * 0.01)`，对鼠标大滚轮步进进行阻尼限幅防止单格跳变过大；`MIN_ZOOM = 0.02`, `MAX_ZOOM = 64`。

### 2.4 `src/application/canvas-handles.ts`（新建 · 零 React/DOM）
- **圆角直操契约**：
  ```ts
  export type CornerKey = "tl" | "tr" | "br" | "bl";
  export interface CornerHandleSpec {
    corner: CornerKey;
    radius: number;
    maxRadius: number;
    /** 在节点局部坐标系中的圆点位置 */
    localPoint: Point;
  }
  export function canEditCornerRadius(doc: DesignDocument, node: DesignNode): boolean;
  export function getCornerHandleSpecs(
    node: DesignNode,
    box: Rect,
    zoom: number,
  ): CornerHandleSpec[];
  export function computeCornerRadiusDrag(params: {
    node: DesignNode;
    box: Rect;
    corner: CornerKey;
    /** 指针在节点局部坐标系中的当前位置 */
    localPoint: Point;
    singleCorner: boolean; // Alt/Option
    snapStep?: number; // Shift -> 4
  }): {
    value: number;
    corners: { tl: number; tr: number; br: number; bl: number };
    singleCorner: boolean;
    operations: Operation[];
  };
  ```
- **自动布局粉色直操契约**：
  ```ts
  export type PaddingSide = "top" | "right" | "bottom" | "left";
  export interface PaddingHandleSpec {
    side: PaddingSide;
    value: number;
    /** 容器局部坐标内的粉色高亮带矩形 */
    bandRect: Rect;
    /** 手柄短杠中心点（容器局部坐标） */
    handlePoint: Point;
    orientation: "horizontal" | "vertical";
  }
  export interface GapHandleSpec {
    index: number;
    axis: "x" | "y";
    value: number;
    /** 两个相邻可见流内子项之间的间隙矩形（容器局部坐标） */
    bandRect: Rect;
    handlePoint: Point;
  }
  export function canEditAutoLayoutHandles(doc: DesignDocument, node: DesignNode): boolean;
  export function getAutoLayoutHandleSpecs(
    doc: DesignDocument,
    node: DesignNode,
    bounds: Map<string, Rect>,
  ): {
    paddings: PaddingHandleSpec[];
    gaps: GapHandleSpec[];
  };
  export function computePaddingDrag(params: {
    node: DesignNode;
    side: PaddingSide;
    initialInsets: { top: number; right: number; bottom: number; left: number };
    /** 沿内缩方向（向容器中心）移动的局部世界像素增量 */
    inwardDelta: number;
    symmetric: boolean; // Alt/Option
    allSides: boolean; // Shift + Alt
    snapStep?: number; // Shift -> 4
  }): {
    value: number;
    insets: { top: number; right: number; bottom: number; left: number };
    affectedSides: PaddingSide[];
    operations: Operation[];
  };
  export function computeGapDrag(params: {
    node: DesignNode;
    initialGap: number;
    delta: number; // 主轴方向局部增量
    snapStep?: number; // Shift -> 4
  }): {
    value: number;
    operations: Operation[];
  };
  ```
- 受保护约束：锁定节点、实例内部后代（`instanceAncestor`）、已绑定对应圆角/内边距/间距变量的字段须显式处理或按现有文档事务校验保持一致性；所有修改通过 `previewGeometry` / `transact` 预览，松手一次性 `e.apply(ops, baseRevision)` 提交以保证单步 `⌘Z` 撤销。

### 2.5 UI 与 HUD 组件契约
- `src/editor/CornerRadiusHandles.tsx`：渲染在 `.selection-overlay` 内（继承选区旋转矩阵，零额外矩阵漂移），小图层（屏幕宽高 `< 44px`）自动隐去不遮挡 resize 手柄；提供 `data-testid="corner-handle-tl|tr|br|bl"` 与实时圆角读数胶囊 `data-testid="corner-radius-badge"`。
- `src/editor/AutoLayoutHandles.tsx`：渲染在 `.selection-overlay` 内（单选 `row`/`column` 自动布局容器且非编辑/原型/开发模式时激活），提供 `data-testid="autolayout-padding-top|right|bottom|left"` 与 `data-testid="autolayout-gap-0"` 及粉色数值胶囊 `data-testid="autolayout-spacing-badge"`。
- `src/editor/CanvasOverlayHud.tsx`：全铺单层 `<canvas className="canvas-overlay-hud">`（`pointer-events: none`），暴露 `CanvasOverlayHudProps` 并订阅 `CameraChannel`，以 `window.devicePixelRatio` 绘制像素网格、增强吸附红线（起止端点短截线 + 距离标牌）与 `Alt`/DevMode 红线辅助；同时保留轻量 `.snap-guide` / `.measure-line` 兼容数据或由 Canvas 统一渲染并保证既有 E2E 断言不失效。
- `src/editor/CanvasMinimap.tsx`：右下角悬浮组件（`data-testid="canvas-minimap"`），提供 `<canvas>` 缩略视图、点击跳转、拖拽视口框与一键折叠按钮；订阅 `CameraChannel` 实时刷新视口框。
- `src/editor/canvas-feel.css`：全部规则位于 `@layer panels`，**0 `!important`**，适配深浅双主题（对比度 ≥ 4.5:1）。

---

## 三、兼容与安全红线

1. **零静默联网**：全部能力纯本地运行，启动仍保持 `0` 次 `/api/agent/*` 请求。
2. **既有 E2E 兼容**：
   - 保留 `.editor-canvas[data-zoom]`（在 `setImmediate` 与 `setLive` 同步 DOM 属性 `surface.current.dataset.zoom = String(next.zoom)`，使外部脚本与测试在高频交互下也能即时读到准确缩放值）；
   - 保留 `.selection-overlay`、`data-testid="selection-box"`、`.resize-handle`、`.rotation-handle`、`.frame-label`、`.measure-line`、`.snap-guide` 等既有交互语义；
   - `CanvasMinimap` 位于右下角（`right: 12px; bottom: 64px` 避开底部居中绘图工具栏），仅当单页根画板数 `>= 6` 且画布可视区域 `>= 1080×540` 时默认自动展开，常规小稿与短窗口（`< 1080×540`）自动默认折叠，不遮挡现有面板或按钮。
3. **导出一致性零回退**：画布圆角与内边距/间距拖拽全部写入标准 `NodeStyle`（`radius`/`corners`/`padding`/`insets`/`gap`），与画布渲染、原型预览和 React/TS 编译器完全同源。
