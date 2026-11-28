# Forma 右侧属性面板治理、系统字体转轮廓与 UI3 轻提示工程设计（v0.18.0）

- **最近更新日期**：2026-11-28
- **状态**：已实施并验收（随 `v0.18.0` 发布）
- **架构约束**：严守 `scripts/check-architecture.mjs`（`domain` 零 React/DOM/application/infrastructure、`application` 零 React/DOM、`as any <= 1`、新增 CSS 全归 `@layer panels` 且 0 `!important`）。

---

## 一、系统模块架构

```text
[Track 1: 系统字体解析 & 全格式字体解码 & 多字体回退文字转轮廓]
  ├── electron/system-fonts.mjs        (纯 Node 零依赖：跨平台系统字体扫描与懒缓存索引 + SFNT/TTC name/OS2/cmap 解析 + CSS 通用族映射 + 按字形覆盖回退链)
  ├── electron/main.mjs + preload.cjs  (IPC forma:resolve-system-fonts，打包随 electron/**/* 进 app.asar，零外网)
  ├── vite.config.ts                   (回环仅限 127.0.0.1 的 POST /api/system-fonts/resolve，覆盖 dev 与 preview)
  ├── src/infrastructure/font-import.ts(支持 TTF/OTF + TTC/OTC 单面提取规范化 SFNT + WOFF1 fflate 解压 + 严格边界校验)
  ├── src/infrastructure/text-outline.ts(多字体回退分段排版 + TTC faceIndex + Electron IPC → 回环服务 → queryLocalFonts() 三级解析)
  └── src/editor/FontAssets.tsx        (放宽 accept、清晰展示解析字体与导入入口、数值轴校验收口)

[Track 2: 视口自适应弹层引擎 & Forma UI3 ToastHost & 右栏 5 弹层]
  ├── src/editor/useAnchoredPopover.ts (真实 DOM 测量 + ResizeObserver + resize/scroll 重算 + 智能翻转/钳制 + 动态 maxHeight + 有界拖拽零死区 + 显式焦点回返)
  ├── src/editor/ToastHost.tsx         (标准 UI3 顶部居中轻提示主机：锚定活跃画布内顶部 12px，队列去重、语义色标、4.5s 自动收起含悬停暂停、兼容 .toast/.project-status-toast)
  ├── src/editor/ColorField.tsx        (接入 useAnchoredPopover + 有界拖拽 + 透明草稿回滚 + P3→sRGB 对比度校正 + ARIA/Tooltip + AI 预览保护)
  ├── src/editor/TokenBinding.tsx      (变量/样式双弹层接入 useAnchoredPopover + Mixed 样式显示 + 256px 窄栏省略 + 关闭态延迟计算)
  ├── src/editor/ComponentProperties.tsx(SlotSwapPicker 接入 useAnchoredPopover + 标准化 data-tip)
  ├── src/editor/TooltipHost.tsx       (为活跃提示绑定 aria-describedby)
  └── src/editor/canvas-feel.css       (@layer panels 零 !important：UI3 ToastHost、.panel-loading-pill、弹层固定头与独立滚动体、窄栏变量行)

[Track 3: 右栏全量 15 个子面板正确性与体验加固]
  ├── PrototypeInspector.tsx           (次级规则复用完整 URL/过渡/条件/类型过滤变量编辑器 + IME/Escape 安全流名称)
  ├── DevModePanel.tsx                 (按 (docId, nodeId) 隔离备注草稿 + 锁定/预览拦截 + 成功后清空 + tablist 方向键导航)
  ├── ExportPanel.tsx + batch-export.ts(每节点稳定默认行 key 防首字失焦 + 子集导出保留精确目标路径)
  ├── SelectionColors.tsx              (纳入 tint 与 fillFromStyle 矢量底色 + 稳定编辑会话 key 防取色器卸载 + 折叠态延迟扫描)
  ├── ImageInspector.tsx               (单调请求代数防异步换图竞态 + 调色滑块松手单步撤销 + pointercancel 取消)
  ├── GradientEditor / VectorInspector / ScalePanel / GridTracks / LayoutGuidesInspector / LayoutBreakpoints / SizeLimits
  │                                    (统一字符串草稿校验、Escape 同步取消标志、IME 保护与越界回滚)
  ├── PaintStack.tsx + property-icons.tsx (补全 4 种渐变名称 + 字距专用图标)
  └── PanelDivider.tsx                 (使用当前活跃编辑器容器 ref，修复多 Tab 全局 getElementById 跳宽)

[Track 4: 主 Inspector、提案同步守卫与 App 集成（Wave 2）]
  ├── src/domain/node.ts               (对齐独立边描边上限 100 与统一描边上限 100)
  ├── src/editor/useDocument.ts + useEditor.ts (区分外部 AI 提案与本地预览所有权，统一 flipSelection 动作)
  ├── src/editor/Inspector.tsx         (type-details-popover 接入 useAnchoredPopover；全部写操作接入外部预览保护；多选可访问名称逐节点保留 control；Field IME/Escape；滑块单步撤销；Mixed 父容器/平滑/翻转一致；type-details 走统一尺寸保护；阴影上限 32；约束图无障碍)
  ├── src/editor/App.tsx + WorkspaceShell.tsx + WorkspaceHomeShell.tsx (挂入 ToastHost、迁出 11 处 .toast 懒加载占位、保留隐藏页背景编辑可见性、页级批量导出图标修正)
  └── scripts/check-inspector-ux.browser.js + run-browser-checks.mjs (全视口与全流程真实 Chromium E2E)
```

---

## 二、关键技术契约

### 1. 系统字体解析与多字体回退（`electron/system-fonts.mjs` + `text-outline.ts`）
- **安全边界**：仅扫描受控操作系统字体目录（绝不接受客户端传入任意文件路径），单文件上限 `64 MiB`，单次最多返回 `6` 个候选字面；Vite 中间件严格校验 `isLoopbackRequest` 且仅接受 `POST /api/system-fonts/resolve`（冷启动 `0` 请求，仅在用户主动触发文字转轮廓时按需调用）。
- **多字形回退**：对每行按 codepoint 查候选字体链 `[embeddedFont?, ...systemFonts]`，连续命中同一字体的字符合并为 run 交由 `harfbuzzjs` 统一塑形（保留连字与字距微调），无缝支持 `PingFang.ttc` 中文及中英混排。
- **格式兼容**：
  - `TTC/OTC` 导入 `doc.fonts` 时提取选定面重构为规范独立 SFNT（重算表偏移与校验和），无缝兼容浏览器 `FontFace`、`.forma` 归档与 React 导出；系统字体转轮廓直接将 `faceIndex` 传给 `new hb.Face(blob, faceIndex)` 避免整包拷贝开销。
  - `WOFF1` 用既有 `fflate.unzlibSync` 还原无损 SFNT。

### 2. `useAnchoredPopover` 布局契约
- 参数：`{ open, triggerRef, popoverRef, preferredSide?: "left" | "bottom", align?: "start" | "center", gap?: number, padding?: number, draggable?: boolean }`
- 每次打开、元素尺寸变化（`ResizeObserver`）、窗口 `resize` 或任意祖先滚动（`scroll` capture）实时计算：
  - `left` 钳制在 `[padding, vw - width - padding]`；
  - `top` 优先对齐锚点并在空间不足时向上顶升，钳制在 `[padding, Math.max(padding, vh - height - padding)]`；
  - `maxHeight = Math.max(160, vh - top - padding)`，确保最底部控件在 `1024×480` 也可滚达且顶部标题永不离屏；
  - 拖拽时将偏移实时钳制在合法视口区间内，消除拖出边界后的回拉死区。

### 3. Forma UI3 `<ToastHost />` 契约
- 渲染位置：挂在活跃编辑器画布容器（`.editor-canvas` / `.canvas-stage`）内部顶部居中（`top: 12px`），宽度 `min(400px, calc(100% - 24px))`，`z-index: 125`（高于画布工具栏与小地图，低于打开的模态弹窗与 `TooltipHost`，且绝不与右侧属性栏或底部浮动工具栏重叠）。
- 视觉规范：遵循 `--bg-elevated` / `--border-subtle` / `--shadow-popover` / `--text-primary`，左侧语义图标（`Info` / `CheckCircle2` / `AlertTriangle` / `AlertCircle`）配柔和语义色，彻底移除全框粗红边。
