# Forma 手动设计与交付验收

## 2026-11-28 0.18.0 右侧属性面板全面治理、系统字体转轮廓与 macOS 桌面安装包验收

2026-11-28，Forma **`0.18.0`**，macOS Apple Silicon（`arm64`）、Node 25.8.0、Electron 45.4.1、`electron-builder` 26.18.0、Playwright Chromium（生产 `vite preview`，2× Retina 实拍）。以课题 [2026-11-28-inspector-ux-fonts-toast-polish](initiatives/2026-11-28-inspector-ux-fonts-toast-polish/PRD.md) 完成多路并行 Codex CLI 施工、主干集成与 **18 轮独立只读 Codex CLI 复审（全部 P0/P1 清零正式签核 PASS — 0 P0 / 0 P1）**，并通过自动化发版流水线完成 `0.17.0 → 0.18.0` 发布与只读挂载 DMG 实机验收。[0.18.0 安装包校验记录](evidence/2026-11-28/desktop-0.18.0.json) · [v0.18.0 2× Retina 实拍与基准数据](evidence/2026-11-28/inspector-ux-v18/) · [架构增量](ARCHITECTURE.md#0180-右侧属性面板治理系统字体转轮廓与-ui3-轻提示增量) · [控件规格](specs/EDITOR-UI-CONTROLS.md#0180-系统字体转轮廓视口自适应弹层与标准-ui3-轻提示规范)

- **系统字体与 5 类字体格式文字转轮廓（回应 `v0.17.0` 反馈 #1）**：
  - 新增零依赖系统字体扫描与单面提取模块 [electron/system-fonts.mjs](../electron/system-fonts.mjs)（受控 OS 字体目录、48 MiB 预算、最大双并发信号量、`ctimeMs`/`ino`/`mtimeMs`/`size` 新鲜度校验、CSS 注释/转义解析与同时兼容 `harfbuzzjs` / `opentype.js` 2.0.0 的单面 TTC 规范化提取，已实测 `Helvetica.ttc` 2,067 / `PingFang.ttc` 35,854 / `Hiragino Sans GB` 29,318 码点），桌面端经 [electron/main.mjs](../electron/main.mjs) + [electron/preload.cjs](../electron/preload.cjs) IPC 提供，开发/预览经 [vite.config.ts](../vite.config.ts) 回环仅限本机（含 `[::1]`）的 `POST /api/system-fonts/resolve` 提供，纯浏览器回退 `queryLocalFonts()`；
  - [font-import.ts](../src/infrastructure/font-import.ts) 与 [text-outline.ts](../src/infrastructure/text-outline.ts) 全面支持 `TTF / OTF / TTC / OTC / WOFF1` 及按需懒加载 `WOFF2`（`wawoff2@2.0.1` 独立 `decompress-*.js` 分包不增大主入口），升级按 CSS 字体栈顺序的中英混排逐字回退、UAX #14 换行、连字溯源拆分与规范绕向归一化；实测选中默认文档「让好设计，发生。」（`system-ui, sans-serif`）点击「文字转轮廓（`⇧⌘O`）」无需导入字体即原地转为含 21 条 `PingFang SC` 路径的 `vector` 图层（0 报错、`⌘Z` 单步撤销完整还原），2× Retina 实拍见 [01-system-font-outline-pingfang-light.png](evidence/2026-11-28/inspector-ux-v18/01-system-font-outline-pingfang-light.png)；新增 [system-fonts-and-outline.test.ts](../tests/system-fonts-and-outline.test.ts)。
- **标准 Forma UI3 顶部轻提示体系（回应 `v0.17.0` 反馈 #2）**：
  - 新增独立组件 [ToastHost.tsx](../src/editor/ToastHost.tsx) 替换旧版右下角红框 `.toast`，锚定活跃画布顶部居中（`top: 12px`），动态避让已展开弹层、底部浮动工具栏、左右面板与小地图，区分 `info / success / warning / error` 语义图标与柔和色条，支持最多 4 条队列与 `info/success` 4.5s 自动收起（悬停/键盘聚焦暂停），并将 11 处懒加载占位迁至 `.panel-loading-pill`；
  - 实测 `1440×900` 浅色模式（[03-ui3-toast-top-center-non-overlapping-light.png](evidence/2026-11-28/inspector-ux-v18/03-ui3-toast-top-center-non-overlapping-light.png)）Toast 位于 `y: 120..158`、`overlapsPopover: false`、`overlapsToolbar: false`、`overlapsRightPanel: false`；`1024×480` 深色短窗（[04-short-viewport-1024x480-popovers-dark.png](evidence/2026-11-28/inspector-ux-v18/04-short-viewport-1024x480-popovers-dark.png)）自动左移避让打开的取色器（`x: 252.1..494` vs 取色器 `x: 498..762`，`overlapsPopover: false`）。
- **统一视口自适应弹层引擎覆盖右栏全部 5 类弹层（回应 `v0.17.0` 反馈 #3）**：
  - 新增 [useAnchoredPopover.ts](../src/editor/useAnchoredPopover.ts)（真实 DOM 尺寸测量 + `ResizeObserver` + 窗口缩放/面板滚动重算 + 严格 `≥ 12px` 安全边距 + 动态 `maxHeight` 独立滚动 + 有界拖拽零死区 + `PopoverSurfaceContext` 活跃页签守卫 + `PopoverDocumentSessionContext` 同 ID 替换失活收口 + 计算可见性安全焦点恢复），全面接入 [ColorField.tsx](../src/editor/ColorField.tsx)、[TokenBinding.tsx](../src/editor/TokenBinding.tsx)（变量/样式双弹层）、[ComponentProperties.tsx](../src/editor/ComponentProperties.tsx)（`SlotSwapPicker`）与 [Inspector.tsx](../src/editor/Inspector.tsx)（`type-details-popover`）；
  - 实测 `1440×900` 低位点击填充色块（[02-color-picker-clamped-low-swatch-light.png](evidence/2026-11-28/inspector-ux-v18/02-color-picker-clamped-low-swatch-light.png)）弹层落点 `top: 440, bottom: 888`（距底边精确 `12px`），底部「文件颜色」色板完整无裁切；新增 [inspector-popovers-toast.test.ts](../tests/inspector-popovers-toast.test.ts)。
- **右侧属性面板 20 组件全量缺陷清零与底层图形/存储加固**：
  - 全面关闭右栏 15 个子面板（`PrototypeInspector`、`DevModePanel`、`ExportPanel` + `batch-export.ts`、`SelectionColors`、`ImageInspector`、`GradientEditor`、`VectorInspector`、`ScalePanel`、`GridTracks`、`LayoutGuidesInspector`、`LayoutBreakpoints`、`SizeLimits`、`PaintStack`、`PanelDivider`、`property-icons.tsx`）与主 `Inspector`、`App`、`WorkspaceShell`、`Canvas`、`SmartHandles`、`useDocument`、`useEditor` 全部审查项：保护外部 AI 提案不被右栏或画布手柄误清、多选表单控件改可访问名称逐节点保留 `control`、统一独立边描边上限 `100px`（`node.ts` / `scale-tool.ts`）、P3 对比度校正、256px 窄栏与多 Tab 唯一面板 ID 隔离、`.editor-canvas { overflow: clip; }` 修复 Chromium 矢量编辑 4px 滚动偏移（`canvas-pro-feel` `committedPathErrorPx` 降至 `0.0000066px`）；新增 [inspector-subpanels-audit.test.ts](../tests/inspector-subpanels-audit.test.ts) 与 [inspector-integrity.test.ts](../tests/inspector-integrity.test.ts)；
  - 同步强化 [vector-outline.ts](../src/domain/vector-outline.ts)（Paper.js 精确拓扑并集 + 106-bit 双双精度/精确十进制游标弧线求解 + OBB 分离轴分量分组，600 条分散折线 `26.05s → ~10–15ms`）与 [storage.ts](../src/infrastructure/storage.ts) / [storage-parts.ts](../src/infrastructure/storage-parts.ts)（加载失败替换基线、事务外 `(id, data)` 加密资产核验、活跃代次零孤儿清理与可读分区单调代次分配）。
- **全量门禁、24 组真实 Chromium E2E、导出工程、2× Retina 实拍与只读挂载 DMG 验收**：
  - `npm run format:check`、`npm run lint:arch`（`Architecture PASS (0 violations)`、`as any: 1/1`、`CSS !important: 3/25`）、`npm run build`（主入口 `index-*.js` `383.61 kB` gzip `135.96 kB`，懒加载 WOFF2 `decompress-*.js` 独立分包）、`desktop:service`（`821,284` 字节）、`desktop:agent`（`3,839,375` 字节）与全仓单测 **1,571 项：1,570 通过、0 失败、1 跳过**（跳过项需浏览器原生 IndexedDB；较 `v0.17.0` 净增 **+246 项**）；
  - 真实 Chromium 静态预览 E2E **24 / 24 通过**（`inspector-ux` [`popupCases: 40, toastCases: 2, outlinedAndUndone: true, mixedControlsPreserved: true`]、`storage` [`reopened: true, recovered: true, staleTab: "preserved winning revision"`]、`canvas-pro-feel`、`canvas-phase2`、`professional-editor`、`vector`、`vector-network`、`figma-new-panels`、`editor-panels`、`inspector-layout`、`text-position`、`editing-workflow`、`guides`、`smart-selection`、`panel-gestures`、`panel-parity`、`multi-tab`、`workspace-home`、`mcp-agent-runtime`、`optional-gateway`、`keyboard-authoring`、`nested-instances`、`variant-authoring`、`designer-delivery`；`agent-canvas-chat` 需实时 `dev:agent` 后端未纳入静态预览批次）；
  - 界面导出 React 工程 ZIP 通过 `npm run test:exports -- canvas-phase2` 隔离安装、构建与 Chromium 运行验证；4 张深浅 2× Retina 实拍逐张人工复核通过；
  - 自动化发版产出 [Forma-0.18.0-arm64.dmg](../release/Forma-0.18.0-arm64.dmg)（`126,033,640` 字节，SHA-256 `8028bf339578a6a57b0d7f89bb0c1fb950a0ce26cae1d44bb712cf48a708e472`）、[Forma-0.18.0-arm64.zip](../release/Forma-0.18.0-arm64.zip)（`121,574,257` 字节，SHA-256 `92e44db7378a32ed78f1dcddb65b4e92b37e1bbe03f2f22e85aedb22c8d8000a`）及两份 `.blockmap`（前序 `Forma-0.17.0-arm64.dmg` 完好未改动）；只读挂载通过 `codesign --verify --deep --strict`（`adhoc: true`、`com.forma.design`）、`Info.plist` `0.18.0`、`app.asar` **57 文件（含 `electron/system-fonts.mjs`）+ 双内置服务**逐字节一致校验、离屏直达工作台首页、全部 5 条 `forma://app/api/agent/*` 路由实测、双主题 **23 条公开版本**日志验收（首条 `v0.18.0`）与 `shared-paint.fig` 原生 `open-file` 实机验收；发版后 `npm run release:check` 返回 `ok: true`、`staleDesktopPackage: false`。
- **当前明确边界**：桌面端与本地 Vite 预览/开发均可零配置直接读取本机操作系统已安装字体转轮廓；无本机服务的纯静态浏览器部署依赖 Chromium `queryLocalFonts()` 权限，无权限或非 Chromium 浏览器仍会清晰提示导入任意 `TTF/OTF/TTC/OTC/WOFF/WOFF2` 字体文件；不支持彩色位图表情（如 `A😀B` 等无矢量轮廓的位图字形）与混合 RTL/Bidi 强行轮廓化；浏览器 E2E 与导出验证在 macOS `arm64` Chromium 执行，Firefox / WebKit 跨引擎复测待按需补跑；桌面安装包采用本机 ad-hoc 签名，仅覆盖 macOS `arm64`，跨机公开分发需 Developer ID 签名与公证；AI 生成与设计 Agent 能力升级按计划在用户确认本版后推进。

## 2026-11-27 0.17.0 画布一线手感升级（Phase 2）与 macOS 桌面安装包验收

2026-11-27，Forma **`0.17.0`**，macOS Apple Silicon（`arm64`）、Node 25.8.0、Electron 45.4.1、`electron-builder` 26.18.0、Playwright Chromium（生产 `vite preview`，2× Retina 实拍）。以课题 [2026-11-27-canvas-pro-feel-phase2](initiatives/2026-11-27-canvas-pro-feel-phase2/PRD.md) 完成多路并行 Codex CLI 施工、主干集成与 6 轮独立只读 Codex CLI 复审（全部 P0/P1 清零正式签核 **PASS — 0 P0 / 0 P1**），并通过自动化发版流水线完成 `0.16.0 → 0.17.0` 发布与只读挂载 DMG 实机验收。[0.17.0 安装包校验记录](evidence/2026-11-27/desktop-0.17.0.json) · [v0.17.0 2× Retina 实拍与基准数据](evidence/2026-11-27/canvas-pro-feel-v17/) · [架构增量](ARCHITECTURE.md#0170-画布一线手感-phase-2-增量) · [控件规格](specs/EDITOR-UI-CONTROLS.md#0170-画板标题对齐图标与高级矢量轮廓化入口)

- **画板/分区/组件标题全功能交互加固（回应 `v0.16.0` 反馈 #1）**：
  - 新增统一屏幕空间标题组件 [ArtboardLabel.tsx](../src/editor/ArtboardLabel.tsx)，并与 [Canvas.tsx](../src/editor/Canvas.tsx) 抽离共享 `beginNodeDrag` 状态机（移除 [CanvasNode.tsx](../src/editor/CanvasNode.tsx) 中不可点击的旧世界空间 `.section-title-pill`），全面覆盖根画板、分区（`.section-title-pill`）、组件集、主组件、组件实例及分区内直接子画板；
  - 支持点击选中、`Shift` 增减多选、按住直拖整板（含多选联动、智能吸附、`Shift` 轴锁、`Option/Alt` 复制含 [clipboard.ts](../src/domain/clipboard.ts) 独立克隆嵌套组件集变体、按最终几何归属分区与单步 `⌘Z` 撤销）、悬停高亮轮廓、右键自动选中唤出菜单及双击画布原位 IME 安全重命名（未完成组合态切换页签自动丢弃半截拼音草稿，不污染历史；5 类节点无障碍名称精准区分 `画板`/`分区`/`组件集`/`主组件`/`组件实例`）；
  - [useEditor.ts](../src/editor/useEditor.ts) 暴露同步 `previewRef`，[Canvas.tsx](../src/editor/Canvas.tsx)、[CornerRadiusHandles.tsx](../src/editor/CornerRadiusHandles.tsx)、[GridHandles.tsx](../src/editor/GridHandles.tsx) 与 [VectorEditor.tsx](../src/editor/VectorEditor.tsx) 在发布与提交前校验同步预览归属，实测外部 AI 提案在 React 重渲染前也不会被改名、拖拽或圆角/内边距/网格手柄释放误清；新增 [artboard-label.test.ts](../tests/artboard-label.test.ts)（42 项）并扩充 [canvas-handles.test.ts](../tests/canvas-handles.test.ts)（28 项）。
- **属性面板对齐与分布图标语义/行为 100% 校正（回应 `v0.16.0` 反馈 #2）**：
  - 校正 [Inspector.tsx](../src/editor/Inspector.tsx) 全部 6 枚对齐图标与 2 枚分布图标映射（`left`=`AlignStartVertical`、`center`=`AlignCenterVertical`、`right`=`AlignEndVertical`、`top`=`AlignStartHorizontal`、`middle`=`AlignCenterHorizontal`、`bottom`=`AlignEndHorizontal`、`horizontal`=`AlignHorizontalSpaceAround`、`vertical`=`AlignVerticalSpaceAround`，统一 `data-align-id` 与真实禁用原因提示），经 2× Retina 高清特写（[01-alignment-toolbar-closeup-light.png](evidence/2026-11-27/canvas-pro-feel-v17/01-alignment-toolbar-closeup-light.png)）逐枚人工复核 `顶对齐` 悬停图标与语义完全一致；
  - [editing.ts](../src/domain/editing.ts) 与 [actions.ts](../src/editor/actions.ts) 统一属性栏、右键菜单与命令面板可用性校验，打通自动布局内 `absolutePosition` 绝对定位子图层对齐与自由拖拽，修复不等宽重叠分布端点位移与 `firstChildOnTop` 反序堆叠置顶顺序（480 组对照全通）；[commands.ts](../src/domain/commands.ts) 组重算纳入旋转/翻转及 `minWidth`/`maxWidth`/`hug` 子图层实测尺寸，自由/绝对旋转组保留未动兄弟世界坐标、流式组选框紧密包裹子层视觉并集（误差 `< 1e-4`）。
- **50–150 屏远景智能缩略缓存动静切换（Board LOD）**：
  - [board-lod.ts](../src/application/board-lod.ts)（零 React/DOM）、[board-tile-cache.ts](../src/editor/board-tile-cache.ts) 与 [BoardLodTile.tsx](../src/editor/BoardLodTile.tsx) 实现 `< 38%` 进入 / `>= 42%` 退出滞回、单页 `>= 12` 根画板或 `>= 600` 节点触发、`48 MiB / 180` 项 LRU 与 `4 ms/帧` 分帧 Canvas2D 结构化绘制；支持 Display P3 独立画布重建、模式切换原地刷新与点击/悬停/编辑/放大瞬切活 DOM；布尔、蒙版、阴影、混合模式、半透明多图层叠加（含附带 `vector` 字段的非矢量节点）及未裁剪溢出/超大路径（12 张未裁剪 144,000 点画板同步判定仅耗时 `0.433 ms`）自动保守保持活 DOM；[geometry-preview.ts](../src/application/geometry-preview.ts) 为套组内自动布局绝对定位子图层拖拽放行 `positionDelta` 快路径（未改动缓存板 0 次后代遍历）；新增 [canvas-phase2-lod-align.test.ts](../tests/canvas-phase2-lod-align.test.ts)。
- **高级矢量编辑（多锚点框选 + Bend 弯曲 + `⇧⌘O` 描边/文字转轮廓）**：
  - [vector-path.ts](../src/domain/vector-path.ts) 与 [VectorEditor.tsx](../src/editor/VectorEditor.tsx) 支持屏幕空间蓝框多选锚点、`Shift` 增减、`⌘A`（含 Electron 原生菜单）全选、批量拖拽与方向键微调（保留自动布局 Fill 模式与矢量渲染元数据）、批量删点（保护独立单锚闭合环）与批量平滑，新增 Bend 弯曲工具（工具栏切换 + `Option/Alt` 临时无横向漂移弯曲曲线段 + 单击锚点切换平滑/尖角）；新增 [vector-editor-phase2.test.ts](../tests/vector-editor-phase2.test.ts)；
  - [vector-outline.ts](../src/domain/vector-outline.ts)、[text-outline.ts](../src/infrastructure/text-outline.ts) 与 [VectorInspector.tsx](../src/editor/VectorInspector.tsx) 实现原地 `convertToVector` 事务保留节点 ID、层序与入站原型引用：描边轮廓化支持矢量/矩形/椭圆、内外中描边、圆角、SVG 百分比虚线与严格 CSS 空白/数字文法，并通过 `charCodeAt` 扫描与视口无关缓存将 10,000 段离屏弧线预检压至 `1.80–3.41 ms` 冷启动 / `0.03–0.04 ms` 缩放重检 / `0.002 ms` 热命中；文字转轮廓支持 `sourceTextShape` 与 `doc.fonts`（`harfbuzzjs` `glyphToPath`）及全 Unicode RTL/Bidi 保护，纯系统字体给出清晰导入引导；新增 [vector-advanced-phase2.test.ts](../tests/vector-advanced-phase2.test.ts)。
- **全量门禁、18 组真实 Chromium E2E、大文档性能实测、导出工程、2× Retina 实拍与只读挂载 DMG 验收**：
  - `npm run format:check`、`npm run lint:arch`（`Architecture PASS (0 violations)`、`as any: 1/1`、`CSS !important: 3/25`）、`npm run build`（主入口 `index-*.js` `373.27 kB` gzip `132.03 kB`）、`desktop:service`（`821,254` 字节）、`desktop:agent`（`3,839,323` 字节）与全仓单测 **1,325 项：1,324 通过、0 失败、1 跳过**（跳过项需浏览器原生 IndexedDB；较 `v0.16.0` 净增 **+260 项**）；
  - 真实 Chromium E2E **18 / 18 通过**（`canvas-phase2`、`complex`、`canvas-pro-feel`、`vector`、`vector-network`、`figma-new-panels`、`editor-panels`、`text-position`、`editing-workflow`、`guides`、`smart-selection`、`layer-tree`、`panel-gestures`、`panel-parity`、`multi-tab`、`workspace-home`、`mcp-agent-runtime`、`optional-gateway`）：
    - `canvas-phase2`：`alignmentControls: 8`、`boards: 128`、`nodes: 2176`、`cachedBoards: 128`、`liveDOM: 2176 → cachedDOM: 128`（-94.1%）、`movedAnchors: 2`、`bentSegments: 1`、`reopenedOutlines: 2`、`previewedOutlines: 2`，原地模式切换刷新同一 `<canvas>` 像素与稳定 `letters` ID 全通；
    - 8,288 层 / 128 画板 / 4,160 矢量 / 192 实例 `complex` 生产预览基准（对比 `v0.16.0`）：`initialDomNodes` `8,288 → 128`（**-98.5%**）、`importMs` `1,281 → 1,054 ms`（**-17.7%**）、`heapMiB` `88 → 64 MiB`（**-27.3%**）、`dragP50: 240 ms`、`dragP95: 259 ms`、`rafP50/P95/Max: 17 ms`、`rafOver25ms: 0`（85 帧零掉帧）；
    - 10,000 层平铺 `layer-tree` 生产预览基准：`importMs: 440`、`selectMs: 92`、`mountedRows: 38`、`zoomMs: 87`、`dragMs: 261`、`nativeDownloadMs: 107`、`reactDownloadMs: 228`、`heapMiB: 103`；
  - 界面导出 React 工程 ZIP 通过 `npm run test:exports -- canvas-phase2` 隔离安装、构建与 Chromium 运行验证（含稳定 `data-design-id="letters"` 闭合字形 SVG 渲染，`0 pageerror`）；4 张 2× Retina 实拍（对齐工具栏高清特写、画板/分区标题原位改名与悬停高亮、128 屏远景 128/128 LOD、矢量多锚点/轮廓化）逐张人工复核通过；
  - 自动化发版产出 [Forma-0.17.0-arm64.dmg](../release/Forma-0.17.0-arm64.dmg)（`125,718,050` 字节，SHA-256 `4965a45501e7f8bd06f3aecf666619b4d785b17f3ab0c089ebfa2228a3ef8638`）、[Forma-0.17.0-arm64.zip](../release/Forma-0.17.0-arm64.zip)（`121,283,857` 字节，SHA-256 `5171709b570bda668fa53511f1f5819954eedd79b53ea848bdcbf59397da0f1c`）及两份 `.blockmap`（前序 `Forma-0.16.0-arm64.dmg` 完好未改动）；只读挂载通过 `codesign --verify --deep --strict`（`adhoc: true`、`com.forma.design`）、`Info.plist` `0.17.0`、`app.asar` **54 文件 + 双内置服务**逐字节一致校验、离屏直达工作台首页、全部 5 条 `forma://app/api/agent/*` 路由实测、双主题 **22 条公开版本**日志验收（首条 `v0.17.0`）与 `shared-paint.fig` 原生 `open-file` 实机验收；发版后 `npm run release:check` 返回 `ok: true`、`staleDesktopPackage: false`。
- **当前明确边界**：文字转轮廓支持保留 `sourceTextShape` 的文本与已在文档 `doc.fonts` 中嵌入字体字节的文本，纯系统字体文本会清晰提示先导入字体文件而不伪造轮廓，混合 RTL/Bidi 双向排版与 Sketch 画布专属材质层（`sketchCanvasPaints` 等）在轮廓化前明确拦截不破损源层；浏览器 E2E 与导出验证在 macOS `arm64` Chromium 执行，Firefox / WebKit 跨引擎复测待按需补跑；桌面安装包采用本机 ad-hoc 签名，仅覆盖 macOS `arm64`，跨机公开分发需 Developer ID 签名与公证；AI 生成与设计 Agent 能力升级按计划留待下阶段推进。

## 2026-11-27 0.16.0 画布一线手感升级（Phase 1）与 macOS 桌面安装包验收

2026-11-27，Forma **`0.16.0`**，macOS Apple Silicon（`arm64`）、Node 25.8.0、Electron 45.4.1、`electron-builder` 26.18.0、Playwright Chromium（生产 `vite preview`，2× Retina 实拍）。以课题 [2026-11-27-canvas-pro-feel-phase1](initiatives/2026-11-27-canvas-pro-feel-phase1/PRD.md) 完成三路并行 Codex CLI 施工、主干集成与 5 轮独立只读 Codex CLI 复审（全部 P0/P1 闭环签收 **PASS — 0 P0 / 0 P1**），并通过自动化发版流水线完成 `0.15.0 → 0.16.0` 发布与只读挂载 DMG 实机验收。[0.16.0 安装包校验记录](evidence/2026-11-27/desktop-0.16.0.json) · [v0.16.0 深浅双主题 2× Retina 实拍与基准数据](evidence/2026-11-27/canvas-pro-feel-v16/) · [架构增量](ARCHITECTURE.md) · [控件规格](specs/EDITOR-UI-CONTROLS.md#0160-画布一线手感直操与百屏小地图入口)

- **零 React 高频相机频道、宽域缩放与统一网格桶空间索引**：
  - [geometry.ts](../src/domain/geometry.ts) 将画布缩放域由 `5%–800%` 扩展至 **`2%–6400%`**（`MIN_ZOOM = 0.02`、`MAX_ZOOM = 64`），并扩充 `SnapGuide` 线段起止截线与类型元数据；
  - [spatial-index.ts](../src/domain/spatial-index.ts) 提供零 React/DOM 的统一网格桶空间索引（大物体溢出表 + 根节点独立索引 + `WeakMap` 场景缓存），10,000 节点微基准实测：点命中 `184.0 → 4.50 µs`（**40.9×**）、矩形查询 `132.75 → 9.37 µs`（**14.2×**）、视口可见根查询 `69.63 → 1.37 µs`（**50.8×**）、最小容器命中 `229.17 → 4.87 µs`（**47.1×**），1024/1024 次查询与线性扫描 100% 精确等价；
  - [canvas-camera.ts](../src/application/canvas-camera.ts) 实现 `CameraChannel` 60–120Hz `rAF` 直播驱动 `.canvas-world` / `CanvasOverlayHud` / `CanvasMinimap` 与 72ms 停稳防抖回写 React，新增 [canvas-engine-phase1.test.ts](../tests/canvas-engine-phase1.test.ts)（**15/15** 通过）。
- **画布圆角直拖与自动布局粉色 Padding / Gap 直操**：
  - [canvas-handles.ts](../src/application/canvas-handles.ts)、[CornerRadiusHandles.tsx](../src/editor/CornerRadiusHandles.tsx) 与 [AutoLayoutHandles.tsx](../src/editor/AutoLayoutHandles.tsx) 支持矩形/画板/按钮四角圆点直拖（统一 / `Option` 单角 / `Shift` 4px 步进）与 `row`/`column` 自动布局粉色四边内边距（单边 / `Option` 对称 / `Option+Shift` 四边同步 / `Shift` 4px 步进）与子项 Gap 直拖；严格守卫组件实例、锁定、外部 AI 预览、`space-between`、窄容器断点与双插序（`[uniform, fine]` / `[fine, uniform]`）变量绑定（5 轮复审中经 64 项编辑 × 128 次模式对照全部通过），并支持方向键微调、`Esc` 取消、小尺寸防重叠避让与松手单步原子提交（`⌘Z` 一次撤销）；
  - [geometry-preview.ts](../src/application/geometry-preview.ts) 为圆角与内边距/间距预览新增支持变量绑定的微秒级快路径，8,320 层复杂文档直操预览延迟由 `51.8–87.6 ms` 降至 **`0.030 ms` P95**；新增 [canvas-handles.test.ts](../tests/canvas-handles.test.ts)（**25/25** 通过）。
- **单层高 DPI Canvas2D HUD、百屏小地图与双主题视觉体系**：
  - [CanvasOverlayHud.tsx](../src/editor/CanvasOverlayHud.tsx) 在单层高 DPI `<canvas>` 上订阅 `CameraChannel` 零重渲染绘制高倍像素网格、带起止端点截线的增强吸附红线及旋转包围盒 `Alt`/DevMode 测距；
  - [CanvasMinimap.tsx](../src/editor/CanvasMinimap.tsx) 与 [minimap-layout.ts](../src/application/minimap-layout.ts) 提供右下角玻璃态画布小地图（顶栏图标按钮、视图选项菜单首项与快捷键 **`⇧M`**；常规小稿与短视口默认折叠，单页根画板 `>= 6` 且画布可视尺寸 `>= 1080×540` 自动温和展开；支持点击瞬移、蓝框零跳变拖拽、双击/按 `0` 适应全部、方向键平移与短窗口上移避让），新增 [canvas-minimap-hud.test.ts](../tests/canvas-minimap-hud.test.ts)（**12/12** 通过）；
  - [canvas-feel.css](../src/editor/canvas-feel.css) 全部归入 `@layer panels`（0 `!important`），深浅双主题对比度达 **6.41:1–6.67:1**（≥ 4.5:1）；同步修复 [VectorEditor.tsx](../src/editor/VectorEditor.tsx) 在直播缩放矩阵下的矢量锚点坐标换算（锚点误差 `0.000045 px`、提交路径误差 `0.000007 px`）。
- **全量门禁、17 组真实浏览器 E2E、大文档基准、导出工程、2× Retina 实拍与只读挂载 DMG 验收**：
  - `npm run format:check`、`npm run lint:arch`（`Architecture PASS (0 violations)`、`as any: 1/1`、`CSS !important: 3/25`）、`npm run build`（主入口 `index-*.js` `372.98 kB` gzip `131.90 kB`）、`desktop:service`（`821,254` 字节）、`desktop:agent`（`3,837,515` 字节）与全仓单测 **1,065 项：1,064 通过、0 失败、1 跳过**（跳过项需浏览器原生 IndexedDB；较 `v0.15.0` 净增 **+52 项**）；
  - 真实 Chromium E2E **17 / 17 通过**（`canvas-pro-feel`、`editor-panels`、`complex`、`layer-tree`、`vector`、`vector-network`、`editing-workflow`、`guides`、`smart-selection`、`figma-new-panels`、`panel-gestures`、`panel-parity`、`text-position`、`multi-tab`、`workspace-home`、`mcp-agent-runtime`、`optional-gateway`）：
    - `canvas-pro-feel`（在最终修复后于生产预览复跑通过）：实测 `zoomRange: [0.02, 64]`、`paintedHudPixels: 694`、30 帧连续滚轮缩放平移 **`0` 次 Canvas React 重渲染**且覆层最大漂移 **`0.000519 px`**、4 组直操拖拽+`⌘Z` 撤销与原生 `.forma` 保存重开/原型预览一致（`radii: [24,24,24,24]`, `gap: 26`）、小地图按下零跳变（`minimapPressJumpPx: 0`）、128 屏连续拖动增量挂载新增可视子图层（`minimapTravelPx: 6219.76`）、`4px` 窄选区在实时 `4×` 缩放下真实命中无遮挡与 `1024×480` 短窗完整适配；
    - 8,288 层 / 128 画板 / 4,160 矢量 / 192 实例 `complex` 生产预览基准：`importMs: 1281`、`dragP50: 240 ms`、`dragP95: 242 ms`、`rafP50/P95/Max: 17 ms`、`rafOver25ms: 0`、`heapMiB: 88`；
    - 10,000 层平铺 `layer-tree` 生产预览基准：`importMs: 442`、`selectMs: 87`、`mountedRows: 38`、`zoomMs: 72`、`dragMs: 241`、`nativeDownloadMs: 106`、`reactDownloadMs: 233`、`heapMiB: 76`；
  - 界面导出 React 工程 ZIP 通过 `npm run test:exports -- canvas-pro-feel` 隔离安装、构建与 Chromium 运行验证（直拖修改后的 `radii [24,24,24,24]` 与 `gap 26` 100% 保留，`0 pageerror`）；4 张 2× Retina 深浅双主题实拍逐张人工复核通过；
  - 自动化发版产出 [Forma-0.16.0-arm64.dmg](../release/Forma-0.16.0-arm64.dmg)（`125,686,563` 字节，SHA-256 `cfb4ea1cdcd5b21286f4b591cd640f081309d71cafbea040dd0ee625a8c505b9`）、[Forma-0.16.0-arm64.zip](../release/Forma-0.16.0-arm64.zip)（`121,243,927` 字节，SHA-256 `2ed5bf0da41576412fd8093bfcec300538b9f38753cb96f6f285b79f51299d85`）及两份 `.blockmap`（前序 `Forma-0.15.0-arm64.dmg` 完好未改动）；只读挂载通过 `codesign --verify --deep --strict`（`adhoc: true`、`com.forma.design`）、`Info.plist` `0.16.0`、`app.asar` **52 文件 + 双内置服务**逐字节一致校验、离屏直达工作台首页、全部 5 条 `forma://app/api/agent/*` 路由实测、双主题 **21 条公开版本**日志验收（首条 `v0.16.0`）与 `shared-paint.fig` 原生 `open-file` 实机验收；发版后 `npm run release:check` 返回 `ok: true`、`staleDesktopPackage: false`。
- **当前明确边界**：Phase 2（计划 `v0.17.0`：50–150 屏远景 `< 40%` 离屏位图瓦片缓存动静切换 + 高级矢量多锚点框选/Bend/文字与描边轮廓化）与 AI 生成升级按既定里程碑留待下阶段推进；浏览器 E2E 与导出验证在 macOS `arm64` Chromium 执行，Firefox / WebKit 跨引擎复测待按需补跑；桌面安装包采用本机 ad-hoc 签名，仅覆盖 macOS `arm64`，跨机公开分发需 Developer ID 签名与公证。

## 2026-11-27 0.15.0 桌面零配置本机 MCP Streamable HTTP、标准 A2A 运行时与 macOS 桌面安装包验收

公开截图 `integrations-connected-dark.png` 和 `integrations-a2a-light.png` 已遮盖配置示例与输入框中的本机会话令牌。

2026-11-27，Forma **`0.15.0`**，macOS Apple Silicon（`arm64`）、Node 25.8.0、Electron 45.4.1、`electron-builder` 26.18.0、Playwright Chromium（Chrome 158，2× Retina 实拍）。以课题 [2026-11-27-mcp-a2a-design-agent-runtime](initiatives/2026-11-27-mcp-a2a-design-agent-runtime/PRD.md) 完成三路并行 Codex CLI 施工与主干集成，并通过自动化发版流水线完成 `0.14.0 → 0.15.0` 发布与只读挂载 DMG 实机验收。[0.15.0 安装包校验记录](evidence/2026-11-27/desktop-0.15.0.json) · [v0.15.0 深浅双主题 2× Retina 实拍目录](evidence/2026-11-27/mcp-a2a-v15/) · [协议文档](AGENT-PROTOCOL.md)

- **零配置本机 MCP Streamable HTTP（`/mcp`）与 11 工具设计运行时**：
  - [runtime-capabilities.ts](../server/runtime-capabilities.ts)、[mcp-tools.ts](../server/mcp-tools.ts)、[mcp-http.ts](../server/mcp-http.ts) 与 [mcp.ts](../server/mcp.ts) 基于 `@modelcontextprotocol/server` v2.4.0 落地共用 11 工具工厂与 Streamable HTTP / stdio 双传输：在原有 7 工具基础上新增 `list_open_tabs`、`render_artboard_preview`（纯 Node 离线 SVG 出图）、`export_react_code`（真实 Forma 编译器输出 `src/DesignPage.tsx`、`src/tokens.css` 与组件模块）及 `delegate_design_task`；新增 [mcp-http-runtime.test.ts](../tests/mcp-http-runtime.test.ts)（11/11 通过），覆盖 401 Bearer 鉴权、403 恶意 Origin 拦截、只读权限阻断与双传输一致性；
  - [agent-sessions.ts](../server/agent-sessions.ts) 升级为持久化跨 Tab 同步桥（`PUT /api/agent/sessions/sync`、`POST /proposal/ack`、2 小时滑动保活、`approvalMode` / `writeEnabled` / `connectedClients`），并在 [electron/main.mjs](../electron/main.mjs) 自动回传真实回环 `endpointBase` 与全量会话/MCP/A2A 协议路由，桌面安装包无需源码目录即可一键连接。
- **标准 A2A（Agent2Agent）Server 与画布人机协同收件箱**：
  - [a2a-protocol.ts](../server/a2a-protocol.ts) 与 [a2a-server.ts](../server/a2a-server.ts) 实现标准 `GET /.well-known/agent-card.json`（声明 `generate_ui`、`refine_artboard`、`audit_design_system`、`design_to_react` 4 技能）与 `POST /api/a2a` JSON-RPC 2.0 / SSE（`message/send`、`message/stream`、`tasks/get`、`tasks/cancel`、`tasks/list`、`tasks/resubscribe`），新增 [a2a-server.test.ts](../tests/a2a-server.test.ts)（21/21 通过，覆盖跨会话隔离、幂等重试、取消竞态、离线审校/React 导出与 SSE 实时推送）；
  - [external-bridge.ts](../src/application/external-bridge.ts)（零 React，[external-bridge.test.ts](../tests/external-bridge.test.ts) 9/9 通过）、[ExternalAgentSession.tsx](../src/editor/ExternalAgentSession.tsx)、[IntegrationsModal.tsx](../src/editor/IntegrationsModal.tsx)、[AgentInboxPopover.tsx](../src/editor/AgentInboxPopover.tsx) 与 [external-bridge.css](../src/editor/external-bridge.css)（`@layer panels`，0 `!important`）提供一键复制 Claude Code / Cursor / Codex / A2A 配置、只读/写入与「画布提案待确认（推荐）/ 信任自动落画布（支持 `⌘Z` 撤销）」策略切换及顶栏轻量任务收件箱。
- **全量门禁、真实浏览器 E2E、Electron 实机、2× Retina 实拍与只读挂载 DMG 验收**：
  - `npm run format:check`、`npm run lint:arch`（`Architecture PASS (0 violations)`、`as any: 1/1`、`CSS !important: 3/25`）、`npm run build`（主入口 `index-*.js` `372.51 kB` gzip `131.69 kB`，`AgentInboxPopover` 懒加载块 `3.94 kB` gzip `1.79 kB`）、`desktop:service`（`821,254` 字节）、`desktop:agent`（`3,837,515` 字节）与全仓单测 **1,013 项：1,012 通过、0 失败、1 跳过**（跳过项需浏览器原生 IndexedDB；较 `v0.14.0` 净增 **+41 项**）；
  - 真实 Chromium E2E **11 / 11 通过**（`mcp-agent-runtime`、`mcp`、`multi-tab`、`workspace-home`、`optional-gateway`、`agent-canvas-chat`、`editor-panels`、`release-notes`、`panel-parity`、`files`、`storage`），其中 `mcp-agent-runtime` 实测 `startupAgentRequests: 0`、`mcpHttpToolCount: 11`、`mcpPreviewSvg: true`、`mcpExportReact: true`、`readOnlyBlockedWrite: true`、`a2aOfflineAuditAndExport: true`、`a2aHitlEditedDelivery: true`（验证设计师手改图层后回传的 React 产物包含最新修改）、`a2aTrustedAutoApplyAndUndo: true` 与 `1024×480` 短窗完整适配；4 张 2× Retina 深浅双主题实拍（连接中心 MCP HTTP / A2A、顶栏 Agent Inbox 浮层）逐张人工复核通过；
  - 界面导出 React 工程 ZIP（`output/playwright/agent-canvas-chat-check.zip`，`83,772` 字节）通过 `npm run test:exports -- agent-canvas-chat` 隔离安装、构建与 Chromium 运行验证；
  - Electron 45.4.1（`v0.15.0` 内置 `out-electron/agent-service.mjs`）实机验证：点击连接自动暴露真实回环 `endpointBase`，外部 HTTP 客户端直连 `/mcp` 获取全部 **11 工具**、直连 `/.well-known/agent-card.json` 获取 `0.15.0` 4 技能名片、直连 `/api/a2a` 完成离线 `design_to_react` 并于桌面端 UI 实时显示已连接客户端徽章；
  - 自动化发版产出 [Forma-0.15.0-arm64.dmg](../release/Forma-0.15.0-arm64.dmg)（`125,685,552` 字节，SHA-256 `693c84a9be5317c7248c1f48837c295a809225d21f0974b50fa14208dab65ba0`）、[Forma-0.15.0-arm64.zip](../release/Forma-0.15.0-arm64.zip)（`121,227,387` 字节，SHA-256 `b75f2cfa124b24116a18cba148acbe9e4f0c13e51a6aa56e17152269b357c14f`）及两份 `.blockmap`（前序 `Forma-0.14.0-arm64.dmg` 完好未改动）；只读挂载通过 `codesign --verify --deep --strict`（`adhoc: true`、`com.forma.design`）、`Info.plist` `0.15.0`、`app.asar` **52 文件 + 双内置服务**逐字节一致校验、离屏直达工作台首页、全部 5 条 `forma://app/api/agent/*` 路由实测、双主题 **20 条公开版本**日志验收（首条 `v0.15.0`）与 `shared-paint.fig` 原生 `open-file` 实机验收；发版后 `npm run release:check` 返回 `ok: true`、`staleDesktopPackage: false`。
- **当前明确边界**：MCP Client（Forma 内置 AI 反向调用外部 MCP 工具）与 Zed ACP（侧栏复用本机 CLI Coding Agent）按已确认范围留作下阶段规划；所有 MCP/A2A 端点严格限定本机回环 `127.0.0.1` + Bearer 鉴权，不含公网远程暴露；浏览器 E2E 与导出验证在 macOS `arm64` Chrome 158 执行，Firefox / WebKit 跨引擎复测与 Developer ID 公证待按需补跑。

## 2026-11-27 0.14.0 Figma 风格单窗口多文件顶部 Tab 工作台与 macOS 桌面安装包验收

2026-11-27，Forma **`0.14.0`**，macOS Apple Silicon（`arm64`）、Node 25.8.0、Electron 45.4.1、`electron-builder` 26.18.0、Playwright Chromium（Chrome 158，2× Retina 实拍）。以课题 [2026-11-27-multi-tab-workspace](initiatives/2026-11-27-multi-tab-workspace/PRD.md) 完成三路并行 Codex CLI 施工与主干集成，并通过自动化发版流水线完成 `0.13.0 → 0.14.0` 发布与只读挂载 DMG 实机验收。[0.14.0 安装包校验记录](evidence/2026-11-27/desktop-0.14.0.json) · [v0.14.0 深浅双主题 2× Retina 实拍目录](evidence/2026-11-27/multi-tab-v14/)

- **常驻 36px 顶部多文件 Tab 栏与纯应用层状态机**：
  - [workspace-tabs.ts](../src/application/workspace-tabs.ts)（409 行，零 React/DOM 依赖）与 [workspace-tabs.test.ts](../tests/workspace-tabs.test.ts)（20/20 通过）实现固定首位不可关闭「工作台」Tab（`HOME_TAB_ID`）、按 `id`/`fileKey`/`nativePath` 严格去重、24 Tab 上限淘汰（保护激活与忙碌 Tab）、10 项已关闭 Tab 恢复栈、拖拽重排、URL 编解码及 Zod 校验的 `localStorage["forma.workspace-tabs.v1"]` 会话持久化；
  - [WorkspaceTabBar.tsx](../src/editor/WorkspaceTabBar.tsx) 与 [workspace-tabs.css](../src/editor/workspace-tabs.css)（`@layer panels`，0 `!important`）提供 Figma 风格 36px 顶部 Tab 栏，支持中键关闭、拖拽重排、拖放文件打开、`+` 新建按钮、屏内钳制右键菜单（「关闭标签页」「关闭其他」「关闭右侧」「重新打开已关闭」「在新窗口中打开」）与 macOS 融合标题栏拖拽留空。
- **四大入口统一收口、视图快照还原与 AI/MCP 后台保活**：
  - [WorkspaceShell.tsx](../src/editor/WorkspaceShell.tsx)（生产块 `32.21 kB` gzip `11.64 kB`，主入口 `index-*.js` 保持 `372.51 kB` gzip `131.69 kB`）、[RecentFilesSubmenu.tsx](../src/editor/RecentFilesSubmenu.tsx)、[WorkspaceHome.tsx](../src/editor/WorkspaceHome.tsx)、[FileBrowser.tsx](../src/editor/FileBrowser.tsx)、[DesignImportDialog.tsx](../src/editor/DesignImportDialog.tsx) 与 [App.tsx](../src/editor/App.tsx) 打通工作台首页（已打开的文件与样例卡片均展示「已打开」徽标）、左上角 `Forma ▾ → 最近打开 ▸` 悬浮子菜单、本地打开/拖放、编辑器内 `+ 新建` / 文件管理 / 内置样例 / 外部导入全路径无刷新开 Tab 与 History API 同步；
  - [useDocument.ts](../src/editor/useDocument.ts) 新增卸载前强制 `flushSave()`，[useEditor.ts](../src/editor/useEditor.ts) 按 `tabActive` 隔离非活跃保活 Tab 的全局键盘快捷键与剪贴板事件，[ExternalAgentSession.tsx](../src/editor/ExternalAgentSession.tsx) / [IntegrationsModal.tsx](../src/editor/IntegrationsModal.tsx) 回传 `onSessionActiveChange` 令活跃 MCP 配对或 AI 流式生成 Tab 自动锁入后台 `hidden` 保活池不断链，[TooltipHost.tsx](../src/editor/TooltipHost.tsx) 补充单例所有权防嵌套重复浮层。
- **macOS Electron `hiddenInset` 融合标题栏与 `open-file-in-tab` 路由**：
  - [electron/main.mjs](../electron/main.mjs)、[electron/preload.cjs](../electron/preload.cjs) 与 [vite-env.d.ts](../src/vite-env.d.ts) 在 macOS 启用 `titleBarStyle: "hiddenInset"`（`trafficLightPosition: { x: 14, y: 11 }`），将 `open-file` / `⌘O` 通过每窗口 FIFO 句柄队列与 `forma:open-file-in-tab` IPC 路由至当前活跃窗口新 Tab（保持 `--forma-offscreen-qa` 逐窗契约兼容，并支持 `--forma-offscreen-qa=tabs` 模式），补齐原生菜单 `⌘T`/`⌘N`/`⌘W`/`⇧⌘T` 与 `openInNewWindow`/`closeCurrentWindow` 受控 IPC；
  - 在 Electron 45.4.1（`--forma-offscreen-qa=tabs`）实机验证连续派发 2 份 `.forma.json` `open-file` 全部在单个窗口（`windowCount: 1`）内按序打开为独立 Tab（`tabsOpened: 3`），`.workspace-tabbar.is-mac-desktop` 生效，且原生菜单 `closeTab` / `reopenTab` 关闭并恢复标签页不误关窗口。
- **全量门禁、真实浏览器 E2E、导出工程、2× Retina 实拍与只读挂载 DMG 实机验收**：
  - `npm run format:check`、`npm run lint:arch`（`Architecture PASS (0 violations)`、`as any: 1/1`、`CSS !important: 3/25`）、`npm run build`、`desktop:service`（`821,254` 字节）、`desktop:agent`（`2,864,077` 字节）与全仓单测 **972 项：971 通过、0 失败、1 跳过**（跳过项需浏览器原生 IndexedDB；较 `v0.13.0` 净增 **+20 项**）；
  - 真实 Chromium E2E **15 / 15 通过**（`multi-tab`、`workspace-home`、`optional-gateway`、`mcp`、`agent-canvas-chat`、`files`、`storage`、`panel-parity`、`editor-panels`、`release-notes`、`keyboard-authoring`、`aura`、`figma-new-panels`、`variant-authoring`、`assets-libraries`），其中 `multi-tab` 实测 `tabCountAfterReload: 4`、`recentSubmenuDeduped: true`、`shortcutsVerified: true`、`reopenClosedTabVerified: true`、`mcpKeepaliveAcrossTabs: true`、`startupAgentRequests: 0`，6 张 2× Retina 深浅主题视觉实拍（编辑器多 Tab、左上角「最近打开」子菜单、带顶部 Tab 栏的工作台首页）逐张人工复核通过；
  - 界面导出 React 工程 ZIP（`output/playwright/agent-canvas-chat-check.zip`，`83,781` 字节）通过 `npm run test:exports -- agent-canvas-chat` 隔离安装、构建与 Chromium 运行验证；
  - 自动化发版产出 [Forma-0.14.0-arm64.dmg](../release/Forma-0.14.0-arm64.dmg)（`125,450,578` 字节，SHA-256 `4048ab601551a4dfb670607c45ecc22339350f0273f3b3f32b5b1c368a5c3b12`）、[Forma-0.14.0-arm64.zip](../release/Forma-0.14.0-arm64.zip)（`121,023,875` 字节，SHA-256 `aba9b43da38665dd4dca6654976e60d0f2090a67550eb3bb5bfefbdf95a4e948`）及两份 `.blockmap`（前序 `Forma-0.13.0-arm64.dmg` 完好未改动）；只读挂载通过 `codesign --verify --deep --strict`（`adhoc: true`、`com.forma.design`）、`Info.plist` `0.14.0`、`app.asar` **50 文件 + 双内置服务**逐字节一致校验、离屏默认直达工作台首页、全部 5 条 `forma://app/api/agent/*` 路由实测、双主题 **19 条公开版本**日志验收（首条 `v0.14.0`）与 `shared-paint.fig` 原生 `open-file` 实机验收；发版后 `npm run release:check` 返回 `ok: true`、`staleDesktopPackage: false`。
- **当前明确边界**：本期不含跨两个独立窗口拖拽合并 Tab 与同窗左右分屏双画布（已提供右键「在新窗口中打开」与 `⇧⌘N` 新建窗口）；浏览器 E2E 与导出验证在 macOS `arm64` Chrome 158 执行，Firefox / WebKit 跨引擎复测待按需补跑；桌面安装包采用本机 ad-hoc 签名，仅覆盖 macOS `arm64`，跨机公开分发需 Developer ID 签名与公证。

## 2026-11-27 0.13.0 全屏工作台首页、原生 `.forma` 容器格式、跨文件模型连接与 macOS 桌面安装包验收

2026-11-27，Forma **`0.13.0`**，macOS Apple Silicon（`arm64`）、Node 25.8.0、Electron 45.4.1、`electron-builder` 26.18.0、Playwright Chromium（Chrome 158，2× Retina 实拍）。针对 `v0.12.0` 桌面端实机走查发现的 5 项产品路径与体验问题，以课题 [2026-11-26-workspace-home-forma-format-ai-flow](initiatives/2026-11-26-workspace-home-forma-format-ai-flow/PRD.md) 完成三路并行 Codex CLI 施工与主干集成，并通过自动化发版流水线完成 `0.12.0 → 0.13.0` 发布与只读挂载 DMG 实机验收。[0.13.0 安装包校验记录](evidence/2026-11-27/desktop-0.13.0.json) · [v0.13.0 深浅双主题 2× Retina 实拍目录](evidence/2026-11-26/workspace-home-v13/)

- **默认全屏工作台首页与强「+ 新建设计」入口**：
  - [WorkspaceHome.tsx](../src/editor/WorkspaceHome.tsx)、[WorkspaceHomeShell.tsx](../src/editor/WorkspaceHomeShell.tsx)、[workspace-home.css](../src/editor/workspace-home.css)（`@layer panels`，0 `!important`）与 [main.tsx](../src/main.tsx) 将常规启动（`/`）升级为全屏工作台首页（生产块 `19.97 kB` gzip `7.41 kB`，与 `App` 懒加载分离，主入口 `index-*.js` 进一步降至 `376.01 kB` gzip `133.06 kB`）；左侧提供「最近打开 / 全部文件 / 未归类草稿」视图与项目空间管理，右侧顶部提供高对比度蓝色「+ 新建设计」主按钮、「导入设计文件」按钮及 4 张带线框插画的快速起稿卡片（移动端 iPhone 16、桌面端 Web、Forma AI 起稿、空白画布）；
  - 深链（`?file=`、`?example=`、`?editor=1`）及 macOS 双击打开文件直达编辑器；[App.tsx](../src/editor/App.tsx) 顶栏提供「工作台」返回链接（及文件菜单「返回工作台首页」）与带文字标签的「+ 新建」按钮，支持消费 `?preset=mobile` / `?preset=desktop` / `?ai=1` 一次性初始化预设；新增 21 项单测（[workspace-home.test.ts](../tests/workspace-home.test.ts)）。
- **原生单后缀 `.forma` ZIP 容器格式与桌面端 `⌘S` 直接保存**：
  - [forma-package.ts](../src/infrastructure/forma-package.ts) 与 [native-document.ts](../src/infrastructure/native-document.ts) 落地 `forma/package` v1 二进制 ZIP 容器（内含 `manifest.json`、`document.json` 或超大稿 `document.parts.ndjson`、`preview.svg` 封面与原始二进制 `assets/images/*`、`assets/fonts/*` 去 Base64 膨胀），2 页含 PNG 与嵌入字体的实测样本由 `136,213` 字节缩减至 `52,470` 字节（**-61.5%**），万层分块往返与旧版 `.forma.json` 向后兼容读取全部通过，且在 [design-import/types.ts](../src/infrastructure/design-import/types.ts) 防误判 `.forma` ZIP 为 `.fig`/`.sketch`；
  - [electron/main.mjs](../electron/main.mjs)、[electron/preload.cjs](../electron/preload.cjs) 与 [file-actions.ts](../src/editor/file-actions.ts) 实现绑定本地 `.forma` 路径后的 `⌘S` 原子原地覆写与 `⇧⌘S` 原生另存为，并在 [ErrorBoundary.tsx](../src/editor/ErrorBoundary.tsx) 应急防丢稿导出同步切换为 `.forma`（ZIP 失败时降级 `.forma.json`）；实测 Electron 45.4.1 直接保存、另存重绑与取消取消行为通过，新增 [forma-package.test.ts](../tests/forma-package.test.ts)。
- **修复跨文件/重启模型连接丢失 & 彻底净化 AI 创作流与独立 MCP 弹窗**：
  - [agent-client.ts](../src/editor/agent-client.ts)、[ModelConfigModal.tsx](../src/editor/ModelConfigModal.tsx)、[useAgentSession.ts](../src/editor/agent/useAgentSession.ts) 与 `window.formaDesktop.hasConfiguredAgent()`（同步探测磁盘 `agent-profiles.json` / `agent-config.json` 与环境变量）联合实现已配置模型跨新文件、切文件、切页、刷新与重启桌面端自动水合，同时严格保障未配置环境保持 **`0` 次 `/api/agent/*` 请求**；
  - [AgentPanel.tsx](../src/editor/AgentPanel.tsx) 彻底移除「创作设置」浮层、底层「生成方式」下拉与禁用态「生成后自动视觉优化」开关（视觉模型默认自动自审，纯文本模型静默跳过），将目标组件库改为输入栏内联药丸（并在 2× Retina 视觉核验后修正窄栏 `@container` 双行网格使发送按钮稳定锚定右下角、模型胶囊完整可读），将「管理设计技能（Skills）」独立上提至 AI 顶栏并支持离线打开；
  - [IntegrationsModal.tsx](../src/editor/IntegrationsModal.tsx) 从主菜单「外部工具集成（MCP）…」唤起，集中承载外部 Agent 实时配对（MCP）与高级手动 JSON 事务导入，关闭弹窗或切换侧栏保持 MCP 会话不断开。
- **全量门禁、真实浏览器 E2E、导出工程、2× Retina 实拍与只读挂载 DMG 实机验收**：
  - `npm run format:check`、`npm run lint:arch`（`Architecture PASS (0 violations)`、`as any: 1/1`、`CSS !important: 3/25`）、`npm run build`、`desktop:service`（`821,254` 字节）、`desktop:agent`（`2,864,077` 字节）与全仓单测 **952 项：951 通过、0 失败、1 跳过**（跳过项需浏览器原生 IndexedDB；较 `v0.12.0` 净增 **+24 项**）；
  - 真实 Chromium E2E **17 / 17 通过**（`workspace-home`、`optional-gateway`、`mcp`、`agent-canvas-chat`、`panel-parity`、`editor-panels`、`files`、`storage`、`assets-libraries`、`library-subscription`、`stroke-paints`、`figma-new-panels`、`keyboard-authoring`、`release-notes`、`variant-authoring`、`aura`、`designer-delivery`），实测干净启动 `0` 次 `/api/agent/*` 请求、`.forma` 原生打包解包校验、跨新文件自动恢复模型连接、独立 `IntegrationsModal` 保活及 6 张 2× Retina 深浅主题视觉实拍逐张人工复核通过；
  - 界面导出 React 工程 ZIP（`output/playwright/agent-canvas-chat-check.zip`，`83,781` 字节）通过 `npm run test:exports -- agent-canvas-chat` 隔离安装、构建与 Chromium 运行验证；
  - 自动化发版产出 [Forma-0.13.0-arm64.dmg](../release/Forma-0.13.0-arm64.dmg)（`125,457,881` 字节，SHA-256 `9614085d996f3f844d4e9405812c3f50a663be7f13a63c46dffb8afe37e793f6`）、[Forma-0.13.0-arm64.zip](../release/Forma-0.13.0-arm64.zip)（`121,010,552` 字节，SHA-256 `b9bb7f54ea150c51186487d6776717cb14f26cb78b64b6cc3bb3ee8d242f6a21`）及两份 `.blockmap`（前序 `Forma-0.12.0-arm64.dmg` 完好未改动）；只读挂载通过 `codesign --verify --deep --strict`（`adhoc: true`、`com.forma.design`）、`Info.plist` `0.13.0`、`app.asar` **48 文件 + 双内置服务**逐字节一致校验、离屏默认直达全屏工作台首页（`.workspace-home` 与「+ 新建设计」按钮）、全部 5 条 `forma://app/api/agent/*` 路由实测、双主题 **18 条公开版本**日志验收（首条 `v0.13.0`）与 `shared-paint.fig` 原生 `open-file` 实机验收；发版后 `npm run release:check` 返回 `ok: true`、`staleDesktopPackage: false`。
- **当前明确边界**：`.forma` 内的可编辑 SVG 矢量图层完整往返，但若旧文档在位图槽 `doc.images` 中保存裸 SVG Data URL，重新打开时会沿用现有领域图像校验规则拒绝（属既有安全策略）；浏览器 E2E 与导出验证在 macOS `arm64` Chrome 158 执行，Firefox / WebKit 跨引擎复测待按需补跑；桌面安装包采用本机 ad-hoc 签名，仅覆盖 macOS `arm64`，跨机公开分发需 Developer ID 签名与公证。

## 2026-11-26 0.12.0 Forma AI 设计师对话工作区重构、全栈架构守卫与 macOS 桌面安装包验收

2026-11-26，Forma **`0.12.0`**，macOS Apple Silicon（`arm64`）、Node 25.8.0、Electron 45.4.1、`electron-builder` 26.18.0、Playwright Chromium（Chrome 158，2× Retina 实拍）。以课题 [2026-11-26-ai-panel-ux-redesign](initiatives/2026-11-26-ai-panel-ux-redesign/PRD.md) 与 [2026-11-26-engineering-ux-balance](initiatives/2026-11-26-engineering-ux-balance/PRD.md) 完成 Forma AI 体验重构及四路并行 Codex CLI（Track A–D）+ 主干集成的 P0/P1/P2 全面升级，通过自动化发版流水线完成 `0.11.0 → 0.12.0` 发布与只读挂载 DMG 实机验收。[0.12.0 安装包校验记录](evidence/2026-11-26/desktop-0.12.0.json) · [AI 面板实拍目录](evidence/2026-11-26/ai-panel-ux/) · [工程与体验平衡实拍目录](evidence/2026-11-26/engineering-ux-balance/)

- **Forma AI 设计师对话工作区重构与模块拆解**：
  - [AgentPanel.tsx](../src/editor/AgentPanel.tsx)（2,595 行 → 674 行）与 [agent-copy.ts](../src/editor/agent/agent-copy.ts)、[EpisodeDrawer.tsx](../src/editor/agent/EpisodeDrawer.tsx)、[ChatMessageItem.tsx](../src/editor/agent/ChatMessageItem.tsx)、[ComposerSettingsPopover.tsx](../src/editor/agent/ComposerSettingsPopover.tsx)、[useAgentSession.ts](../src/editor/agent/useAgentSession.ts) 构成满高三段式对话工作区（38 px 精简顶栏 + `flex: 1` 欢迎/消息画布 + 底部固定输入卡），将目标组件库、生成模式、视觉自审、技能管理与外部 MCP 接入渐进式收纳至底部「创作设置」浮层（以 `hidden` 保活 MCP 配对会话），修复 `1024×480` 短窗口浮层顶栏遮挡；[CanvasAgentBar.tsx](../src/editor/CanvasAgentBar.tsx) 去除重复未配置催促提示与裸 `(x, y)` 坐标；
  - 零 React/DOM 依赖的会话范围校验、提案组装与记忆归档元数据下沉至 [agent-session.ts](../src/application/agent-session.ts)（281 行，新增 12 项单测）；同步拆出 E2E 夹具 [fixtures.mjs](../scripts/browser-checks/agent/fixtures.mjs)（659 行）。
- **P0 / P2 设计师级容错、原生心智与空画布新手体验**：
  - [ErrorBoundary.tsx](../src/editor/ErrorBoundary.tsx) 与 [main.tsx](../src/main.tsx) / [App.tsx](../src/editor/App.tsx) 建立顶层、左侧面板、中央画布、右侧属性栏与弹窗五层隔离错误边界（支持 `resetKey` 自动恢复，画布/顶层异常支持一键导出 `.forma.json` 应急备份，新增 12 项单测）；
  - [ux-copy.ts](../src/editor/ux-copy.ts) 与 [FileBrowser.tsx](../src/editor/FileBrowser.tsx) 区分桌面端「已保存到本机」与 Web 端「已保存到此浏览器」，全面移除 `IndexedDB` 研发术语，将右侧画板预设统一为全中文 7 大分组；左侧导航栏以 `.panel-tabs-sep` 分隔线清晰区隔主视图（`图层` / `资源` / `助手`）与快捷工具入口（`导入` / `操作` / `变量`）；
  - [CanvasWelcomeOverlay.tsx](../src/editor/CanvasWelcomeOverlay.tsx) 在空白文件居中提供毛玻璃非阻塞「开始你的新设计」快速开始卡（移动端/桌面端一键建画板、Forma AI 起稿、导入设计文件与内置示例入口，外层 `pointer-events: none` 不干扰纯键盘创作与画布交互）。
- **P1 / P2 架构边界门禁、CSS `@layer` 治理与首屏分包瘦身**：
  - 纯领域规则迁回 [library-intelligence.ts](../src/domain/library-intelligence.ts)、`OFFICIAL_BUILTIN_LIBRARY_IDS`（[library-schema.ts](../src/domain/library-schema.ts)）与 [document-parts.ts](../src/domain/document-parts.ts)；纯 SVG 序列化下沉至 [svg-export.ts](../src/compiler/svg-export.ts)（经 `configureSvgTextWidth` 纯回调保持浏览器画布测宽零漂移），新增 [check-architecture.mjs](../scripts/check-architecture.mjs)（`npm run lint:arch`）与 [architecture-boundaries.test.ts](../tests/architecture-boundaries.test.ts)，实测 `Architecture PASS (0 violations)`、`as any: 1/1`；
  - 新增 [layers.css](../src/editor/layers.css) 声明 `@layer legacy, design-system, ui3, panels, overrides;`（确认位于生产 CSS 首字节）并将全部 7 份编辑器样式表归层，全仓 CSS `!important` 从 **223 处降至 3 处（-98.7%）**；修复 `@layer legacy` `!important` 覆盖测试样式的级联反转问题，复测 `text-position` 在 50% / 100% / 200% 全缩放与富文本下 **0 偏移像素**；
  - 12 个重型弹窗/面板接入 `React.lazy`、`catalog` / `icon-library` / `export-project` 改为按需动态 `import()` 并配置 [vite.config.ts](../vite.config.ts) 5 个独立 vendor 缓存块，主入口 `dist/assets/index-*.js` 从 **2,200.50 kB（gzip 727.28 kB）降至 1,028.49 kB（gzip 339.70 kB，-53.3%）**，实测 `dist/index.html` 不再预加载组件库、图标库与导出编译器。
- **全量门禁、浏览器 E2E、导出验证与只读挂载 DMG 实机验收**：
  - `npm run format:check`、`npm run lint:arch`、`npm run build`、`desktop:service`（`821,254` 字节）、`desktop:agent`（`2,864,077` 字节）与全仓单测 **928 项：927 通过、0 失败、1 跳过**（跳过项需浏览器原生 IndexedDB；较 `v0.11.0` 净增 **+32 项**）；
  - 真实 Chromium E2E **18 / 18 通过**（`optional-gateway`、`agent-canvas-chat`、`mcp`、`panel-parity`、`editor-panels`、`inspector-layout`、`assets-libraries`、`figma-new-panels`、`keyboard-authoring`、`files`、`storage`、`studio`、`aura`、`rich-text`、`text-position`、`source-layout`、`professional-editor`、`variant-authoring`），确认未配置模型启动 `0` 次外部模型请求；
  - **4 / 4** 界面导出 React 工程 ZIP（`agent-canvas-chat`、`professional-editor`、`variant-authoring`、`text-position`）通过 `npm run test:exports` 独立安装、构建与 Chromium 运行验证；
  - 自动化发版产出 [Forma-0.12.0-arm64.dmg](../release/Forma-0.12.0-arm64.dmg)（`125,420,820` 字节，SHA-256 `618d97218b98899c6644b1410a29402dc7726875334982a8c882906726b2f41a`）、[Forma-0.12.0-arm64.zip](../release/Forma-0.12.0-arm64.zip)（`120,987,815` 字节，SHA-256 `e24c1ba4d0a413a9a2e0e0ac7a6f963001d2579390792c123662480e4dba5665`）及两份 `.blockmap`（前序 `Forma-0.11.0-arm64.dmg` 完好未改动）；只读挂载通过 `codesign --verify --deep --strict`（`adhoc: true`、`com.forma.design`）、`Info.plist` `0.12.0`、`app.asar` **39 文件 + 双内置服务**逐字节一致校验、离屏 `Forma.app` 全部 5 条 `forma://app/api/agent/*` 路由实测、双主题 **17 条公开版本**日志验收（首条 `v0.12.0`）与 `shared-paint.fig` 原生 `open-file` 实机验收；发版后 `npm run release:check` 返回 `ok: true`、`staleDesktopPackage: false`。
- **当前明确边界**：浏览器 E2E 与导出验证在 macOS arm64 Chrome 158 执行，Firefox / WebKit 跨引擎复测待按需补跑；桌面安装包采用本机 ad-hoc 签名，仅覆盖 macOS `arm64`，跨机公开分发需 Developer ID 签名与公证；`App.tsx` 与 `Canvas.tsx` 的进一步细粒度状态拆解与大文档生产基准复测可按需在后续推进。

## 2026-11-26 0.11.0 Forma AI Stage 2（项目空间记忆、历史需求召回、衍生模块回流）与 macOS 桌面安装包验收

2026-11-26，Forma **`0.11.0`**，macOS Apple Silicon（`arm64`）、Node 25.8.0、Electron 45.4.1、`electron-builder` 26.18.0、Playwright Chromium。以课题 [2026-11-25-forma-ai-stage2-project-memory](initiatives/2026-11-25-forma-ai-stage2-project-memory/PRD.md) 完成三轨核心引擎、双轨编辑器 UI 施工及 18 轮独立只读 Codex CLI 审查加固，通过自动化发版流水线完成 `0.10.0 → 0.11.0` 发布与只读挂载 DMG 实机验收。[长期规格](specs/FORMA-AI-LIBRARY-AND-MEMORY.md) · [Stage 2 验收数据](evidence/2026-11-26/forma-ai-stage2/acceptance.json) · [0.11.0 安装包校验记录](evidence/2026-11-26/desktop-0.11.0.json)

- **轻量项目空间与零门槛草稿记忆隔离**：
  - [FileBrowser.tsx](../src/editor/FileBrowser.tsx)、[App.tsx](../src/editor/App.tsx) 与 [project-memory-store.ts](../src/infrastructure/project-memory-store.ts) 将「本机文件」管理页升级为两栏项目空间（`全部文件` / `未归类草稿` / 自定义项目），支持项目新建、重命名、安全删除（释放文件回未归类，不删文件）、默认组件库绑定、单文件归属迁移与草稿单稿记忆自动随迁；顶栏面包屑实时展示所属项目徽章；
  - 独立持久化于 IndexedDB `forma-project-memory-v1`（不升 `forma-studio` 版本，存储禁用时自动降级内存会话），结合 [storage.ts](../src/infrastructure/storage.ts) 的每文件 `lifetimeToken`、`replacementEpoch`（覆盖整稿导入、页面样例重载、失败恢复与跨替换边界 Undo/Redo）及 2PC 提交授权协调器保障跨标签一致性；[storage-parts.ts](../src/infrastructure/storage-parts.ts) 前置校验损坏分片头保障历史版本可恢复。
- **项目级《历史需求档案》离线沉淀与 `Project × Library` 混合召回**：
  - [project-memory.ts](../src/agent/project-memory.ts)、[AgentPanel.tsx](../src/editor/AgentPanel.tsx) 与 [CanvasAgentBar.tsx](../src/editor/CanvasAgentBar.tsx) 支持采纳提案自动沉淀及无模型网关时离线手动归档选中画板、搜索、置顶保护（单作用域 100 条上限）、删除与 `@历史需求` 点名引用；
  - [context-builder.ts](../src/agent/context-builder.ts)、[forma-tools.ts](../src/agent/forma-tools.ts)、[design-engine.ts](../src/agent/design-engine.ts) 与 [agent-http.ts](../server/agent-http.ts) 实现纯本地 CJK+Latin 混合确定性召回与按需挂载 `search_project_episodes` / `get_episode_details` 只读记忆工具。
- **衍生模块一键回流沉淀至组件库**：
  - [library-promotion.ts](../src/domain/library-promotion.ts)、[PromoteModuleModal.tsx](../src/editor/PromoteModuleModal.tsx)、[ContextMenu.tsx](../src/editor/ContextMenu.tsx)、[AssetsPanel.tsx](../src/editor/AssetsPanel.tsx) 与 [library-catalog-store.ts](../src/infrastructure/library-catalog-store.ts)（v2 独立 `fences` 仓与紧凑提交回执）提供多入口一键沉淀至项目衍生库（`proj-lib-<id>`）或自定义组件库（严格保护四大官方内置只读体系），自动归并变量/样式/字体/图片依赖、增量刷新 `aiGuide` 说明书（保留 `<!-- forma:custom-notes -->` 手写备注）、支持可选原地替换为受保护实例与 `⌘Z` 单步撤销。
- **全量门禁、真实浏览器 E2E、导出验证与只读挂载 DMG 实机验收**：
  - `npm run format:check`、`npm run build`、`desktop:service`（`821,254` 字节）、`desktop:agent`（`2,864,161` 字节）与全仓单测 **896 项：895 通过、0 失败、1 跳过**（跳过项需浏览器原生 IndexedDB；较 `v0.10.0` 基线 595 项净增 **+300 项**）；
  - 真实 Chromium 浏览器 E2E **9 / 9 通过**（`agent-canvas-chat`、`assets-libraries`、`editor-panels`、`optional-gateway`、`library-tokens`、`panel-parity`、`mcp`、`files`、`storage`）：实测 `migratedEpisodes: 3`、`selectedBoardsArchived: 2`、`durableCommittedRoots: 2`、`promotionRetriedAfterQuotaError: true`、`crossFileTools: ["search_project_episodes", "get_episode_details"]`、`startupAgentRequests: 0`、深浅主题对比度 **6.41–7.36∶1**；
  - 界面导出 React 工程 ZIP（`output/playwright/agent-canvas-chat-check.zip`，`83,803` 字节）通过 `npm run test:exports -- agent-canvas-chat` 隔离安装、构建与 Chromium 运行验证；
  - 自动化发版产出 [Forma-0.11.0-arm64.dmg](../release/Forma-0.11.0-arm64.dmg)（`125,427,393` 字节，SHA-256 `3dbb0b5823b2fb4bab20da3d0f5c3ae00ce3690af74f389709c2f4dab30ea5e5`）、[Forma-0.11.0-arm64.zip](../release/Forma-0.11.0-arm64.zip)（`120,977,746` 字节，SHA-256 `56879a1a3c86b8f6b5760125108a4fd25bb989b6791c9f53baa17da7a0796947`）及两份 `.blockmap`（前序 `Forma-0.10.0-arm64.dmg` 完好未改动）；只读挂载通过 `codesign --verify --deep --strict`（`adhoc: true`、`com.forma.design`）、`Info.plist` `0.11.0`、`app.asar` **19 文件 + 双内置服务**逐字节一致校验、离屏启动 `Forma.app` 全部 5 条 `forma://app/api/agent/*` 路由实测、双主题 **16 条公开版本**日志验收（首条 `v0.11.0`）及 `shared-paint.fig` 原生 `open-file` 打开校验。
- **当前明确边界**：Stage 3（`用户 × 组件库` 交叉偏好手改 Diff 自学习与记忆面板）为下阶段范围；极端 97–98 置顶满仓多标签离线并发迁移竞态及极少数不影响档案留存的字体名/等值重绑排序边界已记入规格文档；桌面包采用本机 ad-hoc 签名，仅覆盖 macOS `arm64`，跨引擎浏览器复测待按需补跑。

## 2026-11-25 0.10.0 自动化发版流水线落地与 macOS 桌面安装包只读挂载实机验收

2026-11-25，Forma **`0.10.0`**，macOS Apple Silicon（`arm64`）、Node 25.8.0、Electron 45.4.1、`electron-builder` 26.18.0。以课题 [2026-11-25-release-governance-pipeline](initiatives/2026-11-25-release-governance-pipeline/PRD.md) 在 `AGENTS.md` 与 [版本与桌面客户端规格](specs/VERSIONING-AND-DESKTOP.md#5-版本升级判定与同步打包规则) 确立四档版本升级判定矩阵（`none`/`patch`/`minor`/`major`）与同步桌面打包硬规则，落地 `scripts/release/` 全自动发版与只读挂载 DMG 实机验收流水线（经 6 轮独立只读 Codex CLI 复审将 0 P0 全部安全与事务边界收敛闭环，新增 **102 项**发布专项单测），并直接通过 `npm run --silent release:run` 端到端完成 `0.9.0 → 0.10.0` 发布（汇总四大内置设计体系与资源面板重构 + Forma AI Stage 1 两大里程碑）。[0.10.0 安装包校验记录](evidence/2026-11-25/desktop-0.10.0.json) · [发版基线清单](evidence/release-manifest.json)

- **自动化流水线能力与安全边界**：
  - [policy.ts](../scripts/release/policy.ts)、[workspace-diff.ts](../scripts/release/workspace-diff.ts)、[release-files.ts](../scripts/release/release-files.ts)、[verify-dmg.ts](../scripts/release/verify-dmg.ts) 与 [pipeline.ts](../scripts/release/pipeline.ts) 提供 `release:assess`、`release:check`、`release:verify-dmg`、`release:run` 四条标准命令；支持无 Git（SHA-256 清单与前序 DMG 基线）及 Git 双模式变更探测、`package.json` / `package-lock.json` 含传递依赖的 `v2:` 打包指纹、离线缓存预检（Electron ZIP / `dmgbuild` / `7zip@1.0.0`）、APFS 冻结检出与私有 `node_modules` 隔离、冲突保留的事务性回滚与 `--resume` / `--rollback` 恢复、禁止隐式发布/公证（`--publish never` + 强制 `/usr/bin/codesign` 本机 ad-hoc 签名）。
- **实机 DMG 验收拦截并修复的真实桌面缺陷**：
  - 首次运行实机挂载验签时，流水线捕获了打包桌面端访问 `forma://app/api/agent/providers` 返回 `403` 的真实缺陷（Electron 45.4.1 自定义 `forma://app/` 协议对同源 `GET`/`POST` 请求省略 `Origin`/`Referer`/`Sec-Fetch-Site` 头，原 F5 加固误拦截了合法同源请求）；已在 [electron/main.mjs](../electron/main.mjs) 修复为放行无头同源自定义协议请求同时严格拦截非 `forma://app` 的 `Origin`（含沙盒 `"null"`）、跨站 `Sec-Fetch-Site` 与外部 `Referer`，并在 [agent-http-integration.test.ts](../tests/agent-http-integration.test.ts) 补齐双向回归测试；同步修复 [verify-dmg.ts](../scripts/release/verify-dmg.ts) 与 [check-design-import-desktop.mjs](../scripts/check-design-import-desktop.mjs) 退出清理前提前缓存 `app.process()` 句柄。
- **全量门禁与 macOS 安装包产物**：
  - 单命令 `npm run --silent release:run` 依次跑通 `tests/release-notes.test.ts`（2 / 2）、`npm run format:check`、全仓单元测试 `npm test`（**595 / 595 通过**）、`npm run build`、`desktop:service`（`820,994` 字节）、`desktop:agent`（`2,841,275` 字节）、`electron-builder` 离线暂存打包与 `verify-dmg` 全项实机验收；
  - 原子晋升产出 [Forma-0.10.0-arm64.dmg](../release/Forma-0.10.0-arm64.dmg)（`125,135,844` 字节，SHA-256 `4d9ed2d524dcbc6717261d5be463a51e5f82755ca18426be095f707cbc11cc4d`）、[Forma-0.10.0-arm64.zip](../release/Forma-0.10.0-arm64.zip)（`120,725,132` 字节，SHA-256 `23c7c72b86c9f209b78521cf275cebe10d2b11896fe4b74665abdd0db136ce2b`）及两份 `.blockmap`（全部块校验与产物逐字节一致）；前序 `Forma-0.9.0-arm64.dmg`（SHA-256 `26e51be6520559cbbfed734608b18acb81d98b67c4e9f9b682ac127a414551d6`）完好未改动。
- **只读挂载 DMG 实机验签与运行结果**：
  - 通过不可变受保护副本执行只读挂载：`/usr/bin/codesign --verify --deep --strict` 通过（`adhoc: true`、`identifier: com.forma.design`），`Info.plist` 版本 `0.10.0` 与 4 项文件关联（`.forma`/`.forma.json` `Editor/Default`、`.sketch`/`.fig` `Viewer/Alternate`）精确匹配，`LICENSE` / `LICENSES.chromium.html` 完整且无 `default_app.asar`；
  - `app.asar` 提取并通过 **18 个** 前端/Electron/运行态清单文件 + **2 份** 内置服务逐字节一致校验；companion ZIP 通过 `0o7777` 全权限与整棵 `Forma.app` 树一致校验；
  - 隔离环境离屏启动挂载盘内 `Forma.app`：`window.formaDesktop.version === "0.10.0"`、`location.protocol === "forma:"`；全部 5 条 `forma://app/api/agent/*` 路由实测通过（`providers` `200`/13 家、`status` `200`/`configured: false`、`skills` `200`/2 项内置、`critique` `400`、`library-playbook` `400`）；`check-release-notes.browser.js` 双主题短窗口 **15 条公开版本**（首条 `v0.10.0`）全部通过；`check-design-import-desktop.mjs` 完成 `shared-paint.fig` 原生 `open-file` 打开与重开校验（`pages: 1`、`sourceNodes: 6`、`pageNodes: 2`、SHA-256 一致）。
- **发版后状态核验与当前边界**：发版后立即运行 `npm run release:check` 返回 `ok: true`、`staleDesktopPackage: false`、`staleRuntimeFileCount: 0`；运行 `npm run release:assess` 返回 `bump: "none"`、`packageDesktop: false`。本包采用本机 ad-hoc 签名，仅覆盖 macOS Apple Silicon（`arm64`），跨机公开发布仍需 Developer ID 签名与公证。

## 2026-11-25 Forma AI 组件库智能理解、混合装配与前置收口（Stage 1）验收

2026-11-25，Forma **0.9.0** 工作区，macOS Apple Silicon（`arm64`）、Node 25.8.0、Playwright Chromium。以课题 [2026-11-25-forma-ai-library-intelligence](initiatives/2026-11-25-forma-ai-library-intelligence/PRD.md) 完成 Phase 1 三轨并行与 Phase 2 双轨 Codex CLI 实施，并经独立只读 Codex CLI Code Review（首轮定位 3 项 P0、16 项 P1、3 项 P2，经 F1–F5 五轮修复与三轮复审全部 **22 / 22 闭环签收 PASS**）。[长期规格](specs/FORMA-AI-LIBRARY-AND-MEMORY.md) · [验收数据记录](evidence/2026-11-25/forma-ai-stage1/acceptance.json)

- **活体三级资产与离线 AI 说明书（双源统一，零网关可用）**：
  - [library-schema.ts](../src/domain/library-schema.ts)、[library-packaging.ts](../src/domain/library-packaging.ts) 与 [library-intelligence.ts](../src/agent/library-intelligence.ts) 实现 `page` / `block` / `component` 三级自动分层、硬契约 Manifest（尺寸、变体轴、文本推荐字数、图像比例、swap 槽、Token 摘要）及增量可编辑 Playbook Markdown（保留 `<!-- forma:custom-notes -->` 自定义备注）；
  - [commands.ts](../src/domain/commands.ts) 的 `putLibrary` 在先完成依赖归并后严格比对已用组件结构，允许对已有画布实例的库更新非结构性 AI 标注（`aiGuide`/`assetTier`/`aiHints`）同时阻断变量重映射或结构篡改；[library-catalog-store.ts](../src/infrastructure/library-catalog-store.ts) 提供单笔 IndexedDB `readwrite` 事务原子更新工作区说明书；
  - [LibraryManagerModal.tsx](../src/editor/LibraryManagerModal.tsx) 与 [AssetsPanel.tsx](../src/editor/AssetsPanel.tsx) 新增离线「AI 说明书」查看/增量刷新/保存、组件 AI 标注编辑、官方库停用/导出保留用户修改与键盘焦点准确返回，深浅主题文字对比度实测 **6.41–7.36∶1**（≥ 4.5∶1）。
- **插槽化混合装配、模块外框派生与多画板主/异常矩阵**：
  - [html-to-forma.ts](../src/agent/html-to-forma.ts) 与 [html-forma-sandbox.ts](../src/editor/html-forma-sandbox.ts) 支持在无脚本沙盒 HTML 中以 `<div data-forma-component>` 按真实变体尺寸水合并原地实例化受保护原生 `Instance`（支持 `overrides`、严格限定名锁库与变体属性完整匹配、无原型安全插槽字典及 UUID 跨页防重），非实例新造图层自动吸附目标库/文档颜色与精确圆角 Token；
  - [blueprint-compiler.ts](../src/agent/blueprint-compiler.ts) 支持业务楼层外框显式 `detachInstance` 派生加工（`adapt`，保留内部嵌套组件与离线嵌套快照保护）以及全类型多画板避碰矩阵排布（主流程横排 + 关联浮层/异常态纵排对齐，间隔 80 px，合入单笔原子事务一次 `⌘Z` 撤销）。
- **前置边界收口一镜到底生成与安全加固**：
  - [forma-tools.ts](../src/agent/forma-tools.ts)、[context-builder.ts](../src/agent/context-builder.ts)、[design-engine.ts](../src/agent/design-engine.ts)、[agent-http.ts](../server/agent-http.ts) 与 [AgentPanel.tsx](../src/editor/AgentPanel.tsx) 统一面板品牌为 **Forma AI**，新增 `get_library_playbook`、`inspect_component_structure`、`propose_scope_plan` 与离线 `POST /api/agent/library-playbook`；支持目标组件库选择、复杂多页需求 1 轮《生成范围确认卡》拍板（面板与画布输入栏统一携带 `confirmedScope`，单/多选图层与切库即时失效防误提，生成中途零打断且逐板全图多模态视觉自审）；
  - 安全加固：HTTP 同源策略收紧为严格同 `host:port` 回环或显式白名单；[electron/main.mjs](../electron/main.mjs) 默认连接自身托管 Agent 服务并将随机端口编码至桌面 `FORMA_SESSION`，[mcp.ts](../server/mcp.ts) 与 [agent-sessions.ts](../server/agent-sessions.ts) 校验有效端口范围后无缝完成桌面 MCP 配对。
- **全量回归与真实界面交付验收**：
  - `npm run format:check`、`npm run build`、`npm run desktop:agent` 与全仓单测 **493 / 493 通过**（较 425 基线新增 **68 项**单测，含真实回环 TCP 桌面 MCP 配对与组件库并发发布）；
  - 真实 Chromium 浏览器 E2E **7 / 7 通过**：`agent-canvas-chat`（含模拟淘宝三级电商库完整流程：`startupAgentRequests: 0`、`libraryPlaybookEdited: true`、`officialGuideAndAnnotationsPreserved: true`、`scopeConfirmOneShot: true`、`reviewedArtboards: 2`、`hybridMultiArtboardVerified: true`、`hybridTokenBindings: 2`、`editedInstanceTextAndVariant: true`、`reopenedExportedDesign: true`、`singleStepUndo: true`）、`assets-libraries`、`editor-panels`、`optional-gateway`、`panel-parity`、`library-tokens`、`mcp`；
  - 对 `agent-canvas-chat` 从界面实际导出的 React 工程 ZIP（`output/playwright/agent-canvas-chat-check.zip`，`83,786` 字节，含 `tb-nav-search-*.tsx`、`tb-empty-state-*.tsx` 独立组件与 `tokens.css`）运行官方 `scripts/verify-exports.mjs agent-canvas-chat` 在隔离目录离线安装、构建并启动真实 Chromium 验证：主会场手改文案「搜索开门红好物」、新造模块「满减专场」与异常态画板「暂无相关商品」均正常渲染，**0 `pageerror`**。
- **当前明确边界**：本轮交付 Stage 1 并预埋 `memoryScope: { projectId?, libraryId?, userId? }` 契约；Stage 2（项目空间级历史需求档案沉淀/召回与衍生模块回流）与 Stage 3（`用户 × 组件库` 交叉偏好手改 Diff 自学习与记忆面板）按计划留待下阶段推进；浏览器与导出验收在 Chromium 完成（Firefox / WebKit 跨引擎复测待按需补跑）；尚未为此次改动重打 macOS DMG。

## 2026-11-25 资源面板 UI3 一致性重构与四大成熟组件库管理体系验收

2026-11-25，Forma **0.9.0** 工作区，macOS Apple Silicon（`arm64`）、Node 25.8.0、Playwright Chromium（生产构建 `vite preview` 1280×650 短窗口及 1460×960）。以课题 [2026-11-25-assets-and-library-manager](initiatives/2026-11-25-assets-and-library-manager/PRD.md) 完成 5 路 Codex CLI 并行施工与主控联调回归。[长期规格](specs/COMPONENT-LIBRARY-MANAGEMENT.md) · [前后对照与管理弹窗实拍目录](evidence/2026-11-25/assets-and-libraries/)

- **图 1「资源 → 规范 / 组件 / 页面」布局与深浅主题彻底重构**：
  - 根治 `.assets-panel` 硬编码 `height: calc(100% - 64px)`、`.assets-list` 残留 `display: grid` 拉伸空白、全局 `section { padding: 18px 16px }` 导致的 16px 左偏错位、色块行 0px 黏连、硬编码浅色 `.template-card`/`.asset-grid` 与 `.basic-assets` 双层内边距混排问题，建立独立全语义变量样式 [assets-panel.css](../src/editor/assets-panel.css)。
  - 在 1280×650 浅色/深色双主题实测：`display === "flex"`，顶栏分隔线清晰且滚动固定，底栏 `.milestone` 无遮挡；`语义颜色`、`文字层级`、`基础元素` 三处左对齐误差 **`0 px`**；语义色块行高统一 **`28 px`**、相邻色块垂直间距 **`14 px`**；「基础元素」与「文件颜色」视觉分离，5 个基础元素按钮带 Lucide 图标且高度紧凑；实测点击 `#246BFD` 语义色卡可直接重绘选中矩形。
- **四大官方内置设计体系（98 类组件 · 686 个明暗变体 · 10 套整页模板，100% 离线原生可编辑）**：
  - 统一注册至 [catalog.ts](../src/design-system/catalog.ts)：保留 **Forma Mobile（iOS，44 组件 / 290 变体 / 4 模板，默认启用）**，新增 **Material Design 3（Android，18 组件 / 136 变体 / 2 模板）**、**Ant Design 5（Web 中后台，20 组件 / 156 变体 / 2 模板）**、**shadcn/ui（现代 Web SaaS，16 组件 / 104 变体 / 2 模板）**，每套均自带独立明暗 `DesignSystem` 语义变量集合与字阶/圆角规范，支持画布多库拖放与 AI Agent 多库检索（`search_components` / `get_design_system` / `componentCatalog`）。
- **组件库管理中心（`⌥3` / `LibraryManagerModal`）与领域治理内核**：
  - 领域层 [commands.ts](../src/domain/commands.ts) 新增 `removeLibrary` 原子事务（强校验跨页与嵌套槽位引用，画布存在引用实例时阻断卸载并提示准确数量，卸载与启用均支持 `⌘Z` 单步撤销）；[library-packaging.ts](../src/domain/library-packaging.ts) 实现文档主组件打包与已导入文档组件提取；[library-catalog-store.ts](../src/infrastructure/library-catalog-store.ts) 提供按文档启停持久化与跨文件 IndexedDB 工作区自定义库仓；[library-extract-worker.ts](../src/infrastructure/design-import/library-extract-worker.ts) 在独立离线 Worker 中从 `.fig` / `.sketch` 原稿直接提取可复用组件库（实测原始 `.fig`、ZIP 封装 `.fig`、`.sketch` 样本及非法文件提示均通过）。
- **全仓单测、浏览器回归与导出 React 工程独立构建验收**：
  - `npm run format:check`、`npm run build` 与全仓单测 **425 / 425 通过**（新增 51 项：`design-system-kits-a` 19、`design-system-antd5` 13、`library-management` 12、`agent-library-catalog` 7）。
  - 真实 Chromium 浏览器端到端回归 **9 / 9 通过**：`assets-libraries`（新增）、`editor-panels`、`library-tokens`、`library-subscription`、`library-publish`、`panel-gestures`、`component-properties`、`variant-authoring`、`nested-instances`。
  - 对 `assets-libraries` 从界面实际导出的多体系整文件 ZIP（含 Material 3 Extended FAB `新建路线`、Ant Design 5 `数据表格 Table`、shadcn/ui `Command 命令面板` 及独立组件模块）在隔离临时目录执行 `npm install && npm run build` 并在真实 Chromium 逐屏渲染，**3/3 屏幕正常显示、0 控制台/运行时错误**。[导出运行实拍](evidence/2026-11-25/assets-and-libraries/exported-react-runtime.png)
- **当前明确边界**：本轮浏览器 E2E 仅在 Chromium 执行（Firefox / WebKit 跨引擎复测待按需补跑）；尚未为此次改动重新打包新的 macOS Electron DMG（`release/Forma-0.9.0-arm64.dmg` 仍为 2026-11-24 快照）；`.fig` / `.sketch` 提取 Worker 已通过打包工作线程及 React DOM 真实样本测试，真机文件选择器上传大型商业 `.fig` 套件的体感耗时待按需补充。

## 2026-11-24 0.9.0 macOS 桌面安装包构建与只读挂载验收

2026-11-24，Forma **0.9.0**，macOS Apple Silicon（`arm64`）、Node 25.8.0、npm 11.11.0、Electron 45.4.1。按[版本号规范与 Electron 客户端规格](specs/VERSIONING-AND-DESKTOP.md)将 AI 生成引擎 V2（Wave 1）、显式多模型五层能力识别与开源 `SKILL.md` 生态合并升级至次版本 **`0.9.0`**，同步更新 [package.json](../package.json)、[CHANGELOG.md](CHANGELOG.md) 与 [release-notes.ts](../src/editor/release-notes.ts)，完成全量构建测试与只读挂载 DMG 实机验收。[0.9.0 安装包校验记录](evidence/2026-11-24/desktop-0.9.0.json)

- **全量预检与构建**：`npm run format:check`、版本日志单测 `tests/release-notes.test.ts`（2 / 2）、全仓单元测试 `npm test`（**374 / 374 通过**）、生产前端构建 `npm run build`、桌面发布服务 `npm run desktop:service`（`818,668` 字节）与桌面 Agent 服务 `npm run desktop:agent`（`2,560,801` 字节）全部通过。
- **macOS 安装包产出与历史包保护**：
  - 构建 [Forma-0.9.0-arm64.dmg](../release/Forma-0.9.0-arm64.dmg)（`124,877,534` 字节，SHA-256 `26e51be6520559cbbfed734608b18acb81d98b67c4e9f9b682ac127a414551d6`）与 [Forma-0.9.0-arm64.zip](../release/Forma-0.9.0-arm64.zip)（`120,473,083` 字节，SHA-256 `98fa10a482b62329d014c81c789e6997ee1f18ecd3d14f81df1abaeeed21d5f0`）；
  - 核对既有 `Forma-0.8.4-arm64.dmg`（SHA-256 `f5abb1505d1a13d00627de6cc1c2c448eb6989d2d3314eff41f1f9eeb8081e74`）与 `Forma-0.8.4-arm64.zip` 完好未改动。
- **只读挂载 DMG 深度校验与运行实测**：
  - 通过 `hdiutil attach -readonly -nobrowse` 只读挂载 `Forma-0.9.0-arm64.dmg`：`codesign --verify --deep --strict Forma.app` 通过（本机 ad-hoc 深度签名），`Info.plist` `CFBundleShortVersionString` 与运行态 `window.formaDesktop.version` 均为 `0.9.0`；
  - 提取 `app.asar` 逐字节校验：全部 **12 个** `dist/` 前端产物与 Web 生产构建逐字节一致，`out-electron/agent-service.mjs` 与 `out-electron/library-service.mjs` 与工作区编译产物逐字节一致；
  - 在隔离临时 `--user-data-dir` 下离屏启动只读挂载盘内的 `Forma.app`（并设 `AGENT_PORT=59991` 强制走内置 Agent 服务）：
    - 协议 `forma://app/` 正常转发内置 `agent-service.mjs`：`GET /api/agent/providers` 返回 `200`（13 家供应商）、`GET /api/agent/status` 返回 `200`（干净配置 `configured: false`，未接触本机用户配置）、`GET /api/agent/skills` 返回 `200`（2 项内置技能完整加载）、`POST /api/agent/critique` 命中入参校验返回 `400` 结构化 JSON（验证主进程协议路由已贯通）；
    - 运行 [check-release-notes.browser.js](../scripts/check-release-notes.browser.js)：深浅双主题、`900×480` 短窗口键盘导航、选区 `ws-modal-h` 保持、14 条公开版本全部通过，且核实文件菜单展示 `Forma v0.9.0`，版本日志首条为 `v0.9.0 · 2026-11-24 · AI 现代精排生成引擎、视觉自审精修与开源设计技能生态`；
    - 指向挂载盘内 `Forma.app` 运行 [check-design-import-desktop.mjs](../scripts/check-design-import-desktop.mjs)（样本 `shared-paint.fig`），完成 macOS `open-file` 原生导入与刷新重开校验（`version: 0.9.0`，`protocol: forma:`，1 页、6 源层、2 页面层，SHA-256 一致）。
- **当前明确边界**：本包采用本机 ad-hoc 签名且仅覆盖 macOS Apple Silicon（`arm64`），跨机器公开分发仍需 Developer ID 签名与公证；AI 生成引擎 Wave 2（交互式 `DESIGN.md` 美术指导卡、多方案并排探索、可选云端生图配置）及 Phase 2 外部 MCP Client 仍按计划留待下阶段推进。

## 2026-11-24 AI 生成引擎 V2（Wave 1）：视觉资产、HTML-to-Forma 双引擎与多模态视觉自审验收

Forma **0.8.4** 工作区，macOS arm64、Node 25.8.0、Playwright Chromium（2× Retina 实拍，隔离临时配置目录）。建立并落地 `docs/initiatives/` 课题目录永久规范（写入 `AGENTS.md`），并以课题 [2026-11-24-ai-generation-v2](initiatives/2026-11-24-ai-generation-v2/PRD.md) 完成 4 路 Codex CLI 并行施工与真网同模型代际验收。[V1 → V2 代际对比报告](evidence/2026-11-24/ai-benchmark-v2/REPORT.md) · [五栏实拍大图](evidence/2026-11-24/ai-benchmark-v2/v1-vs-v2.png) · [4 屏可编辑原稿](evidence/2026-11-24/ai-benchmark-v2/ALL-V1-V2-comparison.forma.json) · [V2 长期规格](specs/AGENT-GENERATION-V2.md)

- **视觉资产与双引擎架构落地**：
  - [icon-library.ts](../src/agent/icon-library.ts)：从 `lucide-react` 静态抽取 **369 枚**零 React 依赖矢量图标（中英文同义词检索、`iconToFormaVector` / `iconToInlineSvg`），同步接入 `blueprint-compiler.ts` 支持 `type: "icon"`、`svg` 简写、`type: "image"` + 去重 `putImage` 与毛玻璃/超椭圆材质；
  - [media-assets.ts](../src/agent/media-assets.ts)：内置 **44 张**经核验真实摄影目录（含 8 张精品咖啡专题）+ Openverse / Wikimedia / Unsplash / Pexels 扩展 + 严格 HTTPS 域名白名单与重定向 SSRF 校验（10s 共享超时、≤ 1.5 MiB、PNG/JPEG/WebP/GIF 魔数与宽高解析、SHA-256 `img-<64hex>` ID）+ 纯离线 PIL 核验渐变纹理 PNG 兜底；
  - [html-to-forma.ts](../src/agent/html-to-forma.ts) 与 [html-forma-sandbox.ts](../src/editor/html-forma-sandbox.ts)：零外部依赖 DOM-to-Forma 确定性编译器与无脚本 `<iframe sandbox="allow-same-origin">` 沙盒（全局禁动画复位、多层 CSS 渐变按 `stackPaints` 排序入 `gradient + paints`、单格居中网格映射 AutoLayout、`<svg>` 转 `vector`、`<img>` 转 `ImageFill + putImage`）；
  - [forma-tools.ts](../src/agent/forma-tools.ts)、[design-engine.ts](../src/agent/design-engine.ts)、[adapters.ts](../src/agent/adapters.ts)、[agent-http.ts](../server/agent-http.ts)、[AgentPanel.tsx](../src/editor/AgentPanel.tsx)：新增 `search_icons`、`search_stock_images`、`propose_html_design`、`POST /api/agent/critique` 多模态截屏视觉自审闭环、DeepSeek 偶发 `<｜DSML｜invoke>` 泄漏自动恢复、默认工具轮数提至 10，编辑器新增「智能模式 / 现代精排 / 蓝图编辑」切换与「视觉自审精修」开关。
- **同模型（`DeepSeek-V4.1-Flash`）同题（微光烘焙 390×844 H5）V1 → V2 实拍代际对比（均为 Forma 原生图层 2× 实拍）**：
  - **V2-A（纯文本新版）**：130 原生层、78% AutoLayout、**3 张本地化咖啡实景摄影**、**19 枚精准居中 Lucide 矢量图标**、**6 层毛玻璃**、**24 层阴影**，双列 Bento 咖啡豆卡片，1 轮截屏自审耗时 66.0s 修正 Hero 压字对比与 8pt 间距。[V2-A.forma.json](evidence/2026-11-24/ai-benchmark-v2/V2-A-text-html-first.forma.json)
  - **V2-B（参考图 + 社区 Skill + HTML-First + 视觉自审）**：初稿因模型写入 `@keyframes` 动画导致静态抓帧主视觉隐身；1 轮截屏视觉自审（47.2s）看图直接诊断根因并修复，终稿产出 **127 原生层、80% AutoLayout、3 张实景摄影、14 枚 Lucide 图标（含咖啡豆底栏矢量）、4 层毛玻璃、16 层阴影、0 对比度问题**；沙盒同步加 `animation:none!important` 从源头杜绝。[V2-B.forma.json](evidence/2026-11-24/ai-benchmark-v2/V2-B-image-skills-html-first.forma.json)
  - **交互编辑与单步撤销实测**：在 Chromium 编辑器打开 `V2-B-image-skills-html-first.forma.json`，`⌘+点击` 选中深层嵌套文本图层「粉红波旁」（`html-0-74`），修改为「粉红波旁 · V2 手改实测」确认画布实时更新，再按 `⌘Z` 单步完整恢复原文。
- **全仓回归结果**：`npm test` **374 / 374 通过**（较 V1 基线 327 项新增 **47 项**测试）、`npm run format:check`、`npm run build`、`npm run desktop:agent` 全部通过；真实 Chromium E2E **4 / 4 通过**（`agent-canvas-chat` 实测 `htmlFirstCompiled: true`、`visualCritiqueVerified: true`、`critiqueCancellationKeptDraft: true` + `optional-gateway` + `mcp` + `editor-panels`）。
- **当前明确边界**：本轮覆盖 Wave 1 及 `DeepSeek-V4.1-Flash` 单模型样本；Wave 2（交互式 `DESIGN.md` 美术指导卡、无限画布 2–3 方向并排探索、可选云端生图模型配置、生成后一键吸附文档变量与跨模型横向对比）及 `0.8.5` macOS DMG 重打留待下阶段按需推进。

## 2026-11-24 真实云端 DeepSeek 五组对比评测与 9 款开源社区设计 Skill 兼容性验收

Forma **0.8.4** 工作区，macOS arm64、Node 25.8.0、Playwright Chromium（2× Retina 实拍，隔离临时配置目录，零修改本机真实密钥配置）。针对设计师提出的「验证真实大模型 AI 生成效果对比（纯文本 vs 参考图+文本 vs 叠加社区 Skill）」与「主流开源社区设计 Skill 兼容性与效果」，使用用户已接入的真实云端 DeepSeek API（`deepseek-flash` / `DeepSeek-V4.1-Flash`，实时 `/v1/models` 声明 `1M` 上下文、`384K` 输出、`["text","image"]` 视觉 + 工具调用 + 推理）完成端到端实测、真机问题闭环修复与全量回归。[完整图文评测报告](evidence/2026-11-24/ai-benchmark/REPORT.md) · [六栏实拍对比图](evidence/2026-11-24/ai-benchmark/comparison.png) · [编译器修复前后对照](evidence/2026-11-24/ai-benchmark/before-after.png) · [原始评测 JSON](evidence/2026-11-24/ai-benchmark/results.json)

- **9 款主流开源社区设计 Skill 真实导入与兼容重构（0/52 → 52/52 本地资源索引）**：
  - 从 GitHub 实际下载测试 4 个主流仓库共 9 款设计 Skill：`anthropics/skills`（`frontend-design`、`brand-guidelines`、`theme-factory`）、`nextlevelbuilder/ui-ux-pro-max-skill`（`ui-ux-pro-max`）、`jakubkrehel/skills`（`better-colors`、`better-typography`、`better-interface`、`build-design`）与 `vercel-labs/agent-skills`（`web-design-guidelines`）。
  - 扩展 [skill-registry.ts](../server/skill-registry.ts) 支持社区常见目录（`themes/`、`data/`、`rules/`、`templates/`、`docs/`、`examples/`、`guides/`）与根目录伴随文档（`.md`/`.csv`/`.tsv`/`.json`/`.txt`/`.svg`/`.yaml`/`.css`，单 Skill 最多 80 份、单文件 ≤ 256 KiB、严格 `realpathSync` + `O_NOFOLLOW` 防逃逸，自动安全跳过超限/PDF 资产），配套资源可索引率从 **0 / 52 提升至 52 / 52**。
  - 新增第 10 个内置工具 `search_skill_resources`（纯 TS 离线只读 CSV 表头映射行检索与 Markdown 段落检索），实测零脚本执行命中 `ui-ux-pro-max` 的 `data/colors.csv:64` 与 `data/products.csv:39/64`；新增三级兼容自动诊断（`7 完全兼容` / `1 本地检索适配 ui-ux-pro-max` / `1 外部依赖受限 web-design-guidelines`）并在 [SkillsModal.tsx](../src/editor/SkillsModal.tsx) 展示分级徽章与中文引导；新增 Forma Skill-to-Canvas 画布映射引导防止 HTML/CSS 代码泄漏。
- **真网实测驱动的编译器与工具层闭环修复**：
  - 基于首次真网生成的真实渲染缺陷，先后完成子容器默认透明（`fillOpacity: 0`、`radius/padding/gap: 0`）、父布局感知 `hug/fill` 尺寸推导、提案内联 `lintSummary` 与影子提案查询、超时放宽至 `240s`；进一步针对 C/D/E 实测暴露的问题修复了 `fill: "none"` 与纯描边装饰层透明底、`strokeSides` 数组/布尔归一化并自动清零其余边、CSS 数组/方向边距圆角简写，以及 `FormaToolExecutor` 超长 JSON 尾随文本容错与额外元数据键容忍。
- **五组控制变量真实 DeepSeek-V4.1-Flash 生成对照（同一 390×844 精品咖啡订阅 H5 首页）**：
  - **A · 纯文本基线**（165.0s · 112 层 · 86% AutoLayout · 0 组件复用 · 2 对比度提示）：暖米色通用电商风格，验证无图无 Skill 基线能力。[A.forma.json](evidence/2026-11-24/ai-benchmark/A-text-only.forma.json)
  - **B · 参考图 + 文本**（122.7s · 129 层 · 95% AutoLayout · 1 原生状态栏组件 · 0 对比度问题）：附带 Aura Mobile 暗夜参考图，多模态识图成功迁移深空炭黑与暗色悬浮卡视觉语言。[B.forma.json](evidence/2026-11-24/ai-benchmark/B-image-plus-text.forma.json)
  - **C · 纯文本 + 3 款开源社区 Skill**（235.1s · 145 层 · 98% AutoLayout · 1 组件 · 0 对比度问题）：模型主动调用 **4 次** `search_skill_resources` 离线检索 `ui-ux-pro-max` 数据表，结合 `frontend-design` + `better-colors` 产出深烘底 × 羊皮纸编辑感 Hero + 四维风味柱图 + 烘焙度刻度点（仍存在 Hero 内边距偏紧与底部促销条微露两处小瑕）。[C.forma.json](evidence/2026-11-24/ai-benchmark/C-text-plus-oss-skills.forma.json)
  - **D · 参考图 + 文本 + 社区 Skill + Forma 设计系统技能**（180.1s · 101 层 · 96% AutoLayout · **2 枚原生移动组件** · 0 对比度问题）：**综合最佳**，融合暗夜质感、衬线展示排版、鼠尾草/陶土双渐变咖啡豆卡与顶部单边细分隔线，Chromium 实拍零裁剪零重叠；实测在 Chromium 编辑器打开该 `.forma.json`，选中文本节点改为「微光烘焙 · 已手动编辑」并按 `⌘Z` 单步完整还原。[D.forma.json](evidence/2026-11-24/ai-benchmark/D-image-plus-oss-and-forma-skills.forma.json)
  - **E · 社区 `theme-factory` 定向换肤（Golden Hour）**（**82.3s** · 76 层 · **100% AutoLayout** · 0 工具错误）：按 `activate_skill → read_skill_resource("themes/golden-hour.md") → propose_design_changes` 一次性通过，精准还原官方 4 色（`#f4a900`、`#c1666b`、`#d4b896`、`#4a403a`）。[E.forma.json](evidence/2026-11-24/ai-benchmark/E-theme-factory-golden-hour.forma.json)
- **全量工程回归结果**：
  - 全仓单元测试 `npm test`：**327 / 327 通过**（较上一节点 313 项新增 14 项社区 Skill 兼容、编译器排版与真实模型容错测试）；
  - 全仓格式校验 `npm run format:check`、TypeScript 与 Vite 生产构建 `npm run build`、`npm run desktop:agent` 全部通过；
  - 真实浏览器端到端验收 **4 / 4 通过**（`agent-canvas-chat`、`optional-gateway`、`mcp`、`editor-panels`）。
- **当前明确边界**：本轮评测样本为单套咖啡业务需求与 DeepSeek-V4.1-Flash 单模型；咖啡定制品牌色与预置浅蓝/冷灰设计系统变量存在色值差异，5 组实验 `tokensBound` 均为 0（如需强绑定既有变量需在指令中显式约束）；尚未重新构建 `0.8.5` macOS DMG；`web-design-guidelines` 类依赖远端 `WebFetch` 的社区 Skill 受安全离线边界限制标记为「外部依赖受限」；Phase 2 第三方 MCP Client 维持规划状态。

## 2026-11-24 DeepSeek 横幅、搜索栏与影子提案

Forma 0.8.4 工作区，macOS arm64、Node 25.8.0。从真实生成的 A 稿抽取「晨曦花魁」渐变横幅与三层文案，从 B 稿抽取 350 × 48 px 搜索栏、图标、占位文案与筛选胶囊。原稿已保存为编译后的文档。局部复测按反馈重建省略字段的蓝图，保留原文案、渐变、字体与显式尺寸。复测覆盖这两个区域。[原 A 稿实拍](evidence/2026-11-24/ai-benchmark/A-text-only.png) · [原 B 稿实拍](evidence/2026-11-24/ai-benchmark/B-image-plus-text.png) · [可在 Forma 打开的局部复测稿](evidence/2026-11-24/ai-benchmark/worker-8-sections.forma.json)

- 事务通过选区校验并应用，经原生文件序列化和读取重开。画布 CSS 中横幅文案层为 `rgba(255, 255, 255, 0)`，父层保留线性渐变。布局引擎测得占位文案宽 259 px、筛选胶囊宽 21 px，两者间隔 10 px。局部稿重新作为提案提交，`lintSummary.issueCount` 为 0。
- 线性渐变对比度以文字图层中心为采样点，计入色标透明度。另用横跨深、浅背景的两组白字验证，工具仅对浅色区域给出低对比度诊断。取样属于轻量体检。
- 指定蓝图、工具和 HTTP 集成测试共 **48/48 通过**。覆盖显式填充与绑定、行列尺寸、选区内新增、修改布局后新增、跨多个根的分页前完整计数、提案替换与失败回退、三种查询、停止信号及两条路由的时限。`npx tsc --noEmit`、`npm run format:check`、生产构建通过。
- 全仓 **325/325 通过**，使用 Node 直接加载 tsx。当前沙盒禁止 tsx CLI 监听 IPC，也禁止监听本地 TCP。组件库并发发布的既有测试用 Node HTTP 与成对内存流传输，保留原测试断言。上述指定的三个测试文件使用原命令运行。
- 本轮未重新请求云端 DeepSeek。Playwright 启动 Chromium、Firefox 和 WebKit 时进程均以 SIGABRT 退出，当前桌面会话也未授予 Chrome 控制权限。以上尺寸与填充来自重开文件的布局和画布 CSS 检查，修复后的浏览器实拍待补。

## 2026-11-24 多模型配置重构、五层能力真相源、原生工具调用与第三方 Skill 生态

2026-11-24，Forma **0.8.4**（工作区增量演进，未另行打包 DMG），macOS Apple Silicon、Node 25.8.0、npm 11.11.0、Playwright Chromium（Vite 生产预览 `http://127.0.0.1:4183` + 独立 Agent 服务 `5184` + 临时隔离配置目录）。针对设计师实测反馈的两类核心问题——① API Key 误匹配高亮多厂商与交互颠倒、② DeepSeek `deepseek-flash` 被误标为「仅文本 · 上下文 64K」——以及模型对 Forma 原生工具/组件/样式/图层的准确调用与第三方 Skill 生态，完成系统架构重构（主控分析、规格沉淀与验收 + 5 路 Codex CLI 并行施工）：

- **供应商显式接入与安全收敛**：重构 [ModelConfigModal.tsx](../src/editor/ModelConfigModal.tsx) 为「第一步选供应商 → 第二步填凭证 → 第三步连接确认模型与能力」，彻底移除 `"auto"` 自动识别横幅与多厂商绿色猜测边框；`detectProviderFromKey()` 仅识别 5 类 100% 专属前缀（高置信度冲突仅温和提示切换，绝不静默改选）；`probeProvider()` 废除对通用 `sk-` 密钥向多个第三方厂商并发盲扫（0 次无关外发请求）。
- **五层模型能力真相源（解决 DeepSeek `deepseek-flash` 误标）**：新增 [model-catalog.ts](../src/agent/model-catalog.ts) 并重构 [capabilities.ts](../src/agent/capabilities.ts) 上游 `/models` 元数据解析（完整保留 DeepSeek `context_window` / `max_output_tokens` / `input_modalities`、OpenRouter `context_length` / `architecture` / `supported_parameters`、Gemini `inputTokenLimit` / `outputTokenLimit` 与 Ollama `/api/show`）。按 `user-override > provider-api > builtin-catalog > heuristic` 五层合并能力，明确呈现来源标签（`接口实时声明` / `模型目录` / `手动覆写` / `启发式估算`）；`deepseek-flash` 实测展示 `视觉识图`、`工具调用`、`深度推理`、`上下文 1M`、`接口实时声明`；旧版 64K/仅文本持久化快照在 [agent-config-store.ts](../server/agent-config-store.ts) 读取时自动热升级；「已保存连接」支持一键「刷新模型」、按模型覆写能力及一键「恢复自动检测」。
- **三协议原生 Tool-Calling 与增强编译器**：[adapters.ts](../src/agent/adapters.ts)（OpenAI / Anthropic / Gemini）完整支持原生 Function Calling 与流式 `tool_calls` 聚合（HTTP 400 自动降级单轮 Blueprint）；新增 [forma-tools.ts](../src/agent/forma-tools.ts) 提供 9 大内置工具（`get_canvas_overview`、`search_nodes`、`get_node_details`、`search_components`、`get_design_system`、`lint_design`、`propose_design_changes`、`activate_skill`、`read_skill_resource`），突破 300 节点 / 80 组件截断盲区并实现非静默编译诊断回传自修复；[blueprint-compiler.ts](../src/agent/blueprint-compiler.ts) 支持按组件名与 `variantProperties` 模糊解析、插入组件即时 `overrides`、`applyStyle(slot)`、`setInstanceSlot`、`detachInstance`、`setVariableMode` 与专业排版/多重填充/网格属性，并在 4 页 1,575 层移动设计稿（[mobile-studio.forma.json](../public/examples/mobile-studio.forma.json)）完成跨页只读查询与组件按名覆写事务回放。
- **第三方 `SKILL.md` 开放标准与 7 工具外部 MCP Server**：新增 [skills.ts](../src/agent/skills.ts)、[skill-registry.ts](../server/skill-registry.ts) 与 [SkillsModal.tsx](../src/editor/SkillsModal.tsx)，支持内置示范技能、用户导入（粘贴/上传/本机目录至 `~/.forma/skills/`）、工作区技能与默认关闭的外部开放目录（`~/.agents` / `~/.claude` / `~/.codex` / `~/.cursor`）扫描，严格防御路径穿越、符号链接逃逸与 128 KiB 超限且禁止自动执行脚本；[mcp.ts](../server/mcp.ts) 与 [agent-sessions.ts](../server/agent-sessions.ts) 同步扩展至 7 工具（保持既有 3 工具向后兼容），[electron/main.mjs](../electron/main.mjs) 同步放行新增协议路由。
- **实测验证结果**：
  - 全仓单元测试 `npm test`：**313 / 313 通过**（较 0.8.4 前基线 252 项新增 **61 项**单测与 HTTP 集成测试，覆盖 `agent-providers`、`agent-blueprint`、`agent-tools`、`agent-skills`、`agent-http-integration`）；
  - 全仓格式校验 `npm run format:check`、严格类型检查与生产构建 `npm run build`、桌面 Agent 打包 `npm run desktop:agent` 全部通过；
  - 真实浏览器端到端验收 **4 / 4 通过**（生产预览 + 独立 Agent 服务）：
    - `agent-canvas-chat`：验证 0 次启动网络请求、先选供应商与零绿框、专属前缀冲突提示、`deepseek-flash` 实时 `1M + 视觉识图 + 工具调用 + 接口实时声明`、刷新保留覆写与恢复自动检测、第三方 `SKILL.md` 导入、多轮 Tool-Calling（每轮 3 次工具调用 + Skill 激活）预览/采纳/单步撤销与对话气泡调用详情；
    - `optional-gateway`：未配置模型时 `0` 次外部模型请求，手动编辑器完整可用；
    - `mcp`：真实 stdio 握手枚举全部 7 个工具（`read_design`、`list_components`、`propose_design`、`search_nodes`、`get_node_details`、`get_design_system`、`lint_design`），完成选区隔离、提案应用与撤销；
    - `editor-panels`：图层树滚动、短窗口菜单、右栏属性编辑全部通过；
  - 视觉截图复核：在 1440×900 与 1280×650 短窗口核对新版「连接供应商」「确认模型与能力」「已保存连接」「管理设计技能」弹窗布局、滚动与对比度，无错位与截断。
- **当前边界与未验证范围**：上游厂商 `/models` 与多轮 Tool-Calling 自动化验收均使用本地高保真协议模拟服务完成，尚未消耗用户真实云端 API Key 进行真网额度与审美质量评测；尚未重新构建 `0.8.5` Electron 安装包；Phase 2（Forma 作为 MCP Client 挂载外部三方 MCP Server）为已落盘规格蓝图，非本期已实施能力。详见[多模型配置与能力规格](specs/AGENT-PROVIDER-AND-CANVAS-CHAT.md)与[原生工具调用与第三方 Skill 规格](specs/AGENT-TOOLS-AND-SKILLS.md)。

## 2026-11-24 Sketch 与 Figma 兼容复核加固

2026-11-24，Forma **0.8.4**，macOS Apple Silicon、Node 25.8.0、npm 11.11.0、Chrome 158.0.8127.37、Electron 45.4.1。针对 0.8.0–0.8.3 完成的 Sketch / Figma 兼容链路开展对抗性代码审计、边界输入复现、真实 Apple 双原稿界面走查与并行修复（前端编辑器交互由 Antigravity 负责，导入管线/存储/Electron 桌面端及单测由 Codex CLI 并行负责），并打包发布 `0.8.4` 桌面安装包。

- **对抗性边界复现（0/18 → 18/18）**：修复前 12 类 Sketch 与 6 类 Figma 极端/畸形输入全部异常崩溃；修复后全部 18 类输入均安全解析或给出明确中文报错，涵盖超限模糊/字号/线宽/色标/阴影/填充/透明度/旋转角、空矢量路径、过长与空白名称、失配 `symbolID`、Figma `phase === "REMOVED"`、非分区内嵌套 `SECTION`、超大组件集/插槽内容与 FigJam/Figma Slides 文件拒收。
- **本机大文件存储与恢复**：分块存储阈值收紧至「超过 2,000 条诊断 / 10,000 图层 / 16 MiB 综合估算体积」；`read()` 重开分块文档时立即填充已校验资源缓存避免首次编辑重哈希；`backup()` 独立容错读取 `current` 与 `previous` 两代快照；补齐 `QuotaExceededError` 中文提示、删除中止与截断分块 JSON 防护。
- **真实 Apple 双原稿实机界面核对（Chrome 158.0.8127.37，0 `pageerror`）**：
  - 160 MB Apple Figma 原件（`iOS and iPadOS 27 (Community).fig`）：实测 FigJam 文件拒收并支持点遮罩关闭；导入预检/查看报告默认按类别归类为 25 组（消除裸 UUID 与长串 GUID），深浅双主题及 1024×480 短窗口布局与滚动正常；点击跨页定位芯片正确跳转至 `Materials` 页并选中目标图层；空选区右栏区分 88 项活跃样式与折叠的 145 项「已归档源样式」；`Alerts` 页选中实例时通过 `SlotSwapPicker` 延迟搜索弹层切换组件，单次最多挂载 60 项，右栏原生 `<option>` 峰值由 2,677 降至 87。
  - 368 MB Apple Sketch 原生副本（`.forma.json`）：重载恢复 36 页，导入报告完整映射变量与样式可读名称（如 `色变量 · Fills/Light/3 Tertiary`，零裸 UUID）；边界 Sketch 原稿实测「Sketch 智能布局（Smart Layout）」中文提示、属性面板「移除整体着色」及 `⌘Z` 单步撤销还原。
- **0.8.4 macOS 桌面安装包验收**：
  - 构建 [Forma-0.8.4-arm64.dmg](../release/Forma-0.8.4-arm64.dmg)（`124,720,282` 字节，SHA-256 `f5abb1505d1a13d00627de6cc1c2c448eb6989d2d3314eff41f1f9eeb8081e74`）与 [Forma-0.8.4-arm64.zip](../release/Forma-0.8.4-arm64.zip)（`120,319,980` 字节，SHA-256 `60dc55d2b8334bdecdbacc6b3e58df7fb9459b80ab8b67e7c56217ab9f57bd13`），既有 `0.8.3` DMG 文件指纹保持不变；
  - 只读挂载 `Forma-0.8.4-arm64.dmg` 通过 `codesign --verify --deep --strict` 校验，`Info.plist` 与 `window.formaDesktop.version` 均为 `0.8.4`，`app.asar` 内 12 个前端资源与 Web 生产 `dist/` 逐字节一致；
  - 离屏启动只读挂载盘内的 `Forma.app`，核验文件菜单「版本日志」展示 `当前版本 v0.8.4` 及首条 `v0.8.4 · 2026-11-24` 更新，并通过 `scripts/check-design-import-desktop.mjs` 完成系统 `open-file` 原生导入与刷新重开校验。[0.8.4 安装包校验记录](evidence/2026-11-24/desktop-0.8.4.json)
- **自动化回归与独立工程交付**：
  - 全仓 `npm run format:check` 与 `npm run build`（`tsc --noEmit && vite build`）通过；
  - 单元测试 `npm test` **252 / 252 通过**（较 0.8.3 基线 223 项新增 29 项回归测试）；
  - 官方浏览器回归 `scripts/run-browser-checks.mjs` 定向 **11 / 11 通过**（`stroke-paints`、`figma-capsule`、`group-tint`、`source-layout`、`editor-panels`、`files`、`storage`、`component-properties`、`nested-instances`、`booleans`、`text-position`）；
  - 独立 React 工程交付验证 **7 / 7 通过**：`scripts/check-design-import.mjs paint`（`shared-paint.fig` 全流程导入、编辑、重开、便携副本校验、导出 ZIP 并独立构建与像素探针验收）及 `scripts/verify-exports.mjs` 6 个由本次浏览器回归新导出的独立工程（`stroke-paints`、`boolean`、`component-properties`、`nested-instances`、`forwarded-instances`、`text-position`）；
  - 0.8.3 既有 12 个 Apple 样本渲染输出在纯逻辑对照中 11/12 逐字段一致，Sketch 键盘新增 `pin` 表达式保持原始尺寸几何误差 `< 0.00004 px`。
- **尚未重跑范围**：本轮加固后尚未在 Firefox / WebKit 重新执行跨引擎像素复测，也尚未重跑其余 45 组非导入类浏览器场景与其余 29 个历史导出工程。

## Apple 原稿双格式复验

2026-11-23，Forma 0.8.3，macOS 27.2.1 arm64。Sketch 使用用户指定的 207,834,444 字节原档，Sketch 2026.3.1（234013）按图层 ID 输出对照图。Figma 使用已登录的本机 Figma Desktop 从用户给出的 Community 文件保存的 160,736,706 字节本地副本，Kiwi 格式版本 106。Figma 原厂六张 1× PNG 由同一文件中的只读插件按原始节点 ID 生成，启用 `useAbsoluteBounds`。生产验收从浏览器文件菜单打开完整原件，另存为 Forma 文件，清除原存储，在新浏览器环境重开，并从文件菜单导出整档 React 工程。两份工程均在新目录安装、编译并在浏览器运行。[原始行业调研与分工](specs/DESIGN-FILE-IMPORT.md#样本确认与行业取舍) · [双格式结构及编辑结果](evidence/2026-11-23/apple-import-0.8.3/structure.json)

| 格式 | 原始对象 | 1× 宽 × 高 | Forma 预览超差像素 | 独立 React 超差像素 |
| --- | --- | ---: | ---: | ---: |
| Sketch | 套件封面 | 640 × 640 | 1,302（0.318%） | 1,302（0.318%） |
| Sketch | 浅色警告框画板 | 402 × 874 | 1,656（0.471%） | 1,633（0.465%） |
| Sketch | 深色 Bordered 按钮 | 72 × 50 | 0（0.000%） | 0（0.000%） |
| Sketch | Color Grid 色板 | 360 × 300 | 16（0.015%） | 16（0.015%） |
| Sketch | iPad 深色键盘 | 1,210 × 428 | 710（0.137%） | 710（0.137%） |
| Sketch | 深色开关 | 64 × 28 | 0（0.000%） | 0（0.000%） |
| Figma | 封面图层 | 1,920 × 1,080 | 0（0.000%） | 0（0.000%） |
| Figma | 播放按钮 | 73 × 50 | 4（0.110%） | 4（0.110%） |
| Figma | 浅色开关 · 开 | 64 × 28 | 2（0.112%） | 2（0.112%） |
| Figma | 浅色开关 · 关 | 64 × 28 | 0（0.000%） | 0（0.000%） |
| Figma | 警告框操作按钮 | 86 × 48 | 3（0.073%） | 3（0.073%） |
| Figma | 警告框完整实例 | 300 × 307 | 233（0.253%） | 233（0.253%） |

每个像素在 sRGB 白底上比较，任一 RGB 通道绝对误差大于 16 即计入。固定门槛为每对象 0.5%，预览和 React 单独判定。Chromium 158.0.8127.36 在 1× 下对两个格式各六个原始对象做了 24 次比较，每次尺寸均与源图一致。0.8.1 未过线的 Sketch 封面、警告框、深色按钮、键盘均已通过。Figma 封面本身就是源稿中的图像层。其余示例有独立节点、原文与颜料。另用额外原厂图实测渐变与绑定归档样式的矢量箭头。[本机逐图原大对照与差异位置](../output/playwright/apple-import-0.8.3/index.html) · [逐项数值与最大色差](evidence/2026-11-23/apple-import-0.8.3/visuals.json)

**图层、组件和文字。** Sketch 36 页的 13,914 层逐项核对源 ID、名称、Unicode 正文、父子及同级顺序，1,919 个源主件与 4,798 个实例逐项核对，展开后 44,969 层。160 个源样式定义按用途存成 194 个可复用样式，111 个颜色变量、155 份源 PNG 和 5 份字体均通过清点，单页 PDF 转为 48 × 48 透明图。编辑封面文字改变 33,494 个像素，撤销后回到原图。Figma Desktop 另行遍历 46 页，直接与从产品另存的文件逐层对照。10,657 个源图层的名称、父节点、同级次序及 1,807 段原文完全匹配，11 个无标题分区的名字为空串。[独立原厂图层清单对账](evidence/2026-11-23/apple-import-0.8.3/native-tree.json) 12,565 个原始实例的主件引用覆盖普通页、组件模板和插槽，丢失引用为零。2,551 个组件定义含 4,749 个主件／变体，25 个辅助组件保存 297 种插槽内容。原生副本中有 420 份图像、88 个活跃样式和 145 个保留引用的已归档样式；473 个源变量和 57 个用于跨主题透明度的派生变量共 530 项。132 个源图层上的 298 个渐变色标按位置逐个通过重开核对，286 个双描边对象保留源漆次序。警告框标题以中文、组合字符和 emoji 原位编辑后撤销，颜色模式切换后恢复。[Figma 原档逐层重开](evidence/2026-11-23/apple-figma/native-roundtrip.json)

**交付与复测。** 在只读挂载的 Apple Silicon DMG 中通过 `codesign --verify --deep --strict`；签名类型为本机 ad hoc。包内 12 个 Web 文件与网页生产构建逐字节相同。分别通过 Electron 的 macOS 系统打开入口载入两个原件，再从各自的桌面文件菜单另存并重开，两端的页面、实例、字体及资源计数相符。导出的 Sketch 工程目录列出 1,976 个画板入口，Figma 工程目录列出 735 个。逐图视觉验收覆盖上表中各格式的 6 个指定对象。单测 223 项、浏览器 56 组、既有独立工程 35 个通过，格式和生产构建通过。性能基准记录同机生产预览的 `layer-tree` 与 `complex` 负载、滚动与拖动结果。[安装包、可编辑文件及工程校验值](evidence/2026-11-23/apple-import-0.8.3/release.json) · [回归和性能实测](evidence/2026-11-23/apple-import-0.8.3/regression.json)

**已知兼容边界。** 两个源文件都含有指向旧图层或未随文件提供的外部资产的引用。导入报告保留涉及的源节点与属性，其中 Sketch 有 5,582 条逐层诊断，Figma 浏览器环境有 2,343 条。诊断还包括改尺寸后的约束、部分可编辑字体回退、液态玻璃的折射/色散近似。结构核验覆盖整个文件，逐像素结论限于实际列出的图层、主题、缩放和渲染环境。[映射和边界](specs/DESIGN-FILE-IMPORT.md) · [Sketch 本机完整导入报告](../output/playwright/apple-kit-0.8.3/import-report.json) · [Figma 本机完整导入报告](../output/playwright/apple-figma-0.8.3/figma-import-report.json)

**其他浏览器。** 同一 Figma 工程和原生副本在 Firefox、WebKit 各复测六个源对象的编辑器预览与 React 路由。Firefox 的 12 次对照中 12 次通过，最高 0.164%（播放按钮）。WebKit 的 12 次对照中 12 次通过，最高 0.331%（封面图层）。 Sketch 则在两种引擎各用新存储打开同一原件、保存重开并核对全稿结构及 Unicode 主件改名和撤销。[逐浏览器结果与验证范围](evidence/2026-11-23/apple-import-0.8.3/cross-engine.json)

**交付记录复核（2026-11-23）。** 从留存的原厂 PNG、预览和独立工程截图重新计算上述 48 组对照。Chromium 的 24 组、Firefox 的 12 组、WebKit 的 12 组均与归档的逐图超差像素数一致，各引擎单组最高占比分别为 0.4713%、0.1644%、0.3314%。本次重算使用发布时的截图。另从磁盘读取 0.8.3 DMG，文件大小及 SHA-256 与[发布清单](evidence/2026-11-23/apple-import-0.8.3/release.json)一致。

## 2026-11-23 Apple iOS 27 的 Sketch 原档

以下记录对应 0.8.1，保留作修复前对照。0.8.3 的两个格式分别与各自的源端导图比较，见[双格式复验](#apple-原稿双格式复验)。

**本机交付物。** 网页另存的 `Apple iOS 27 UI Kit.forma.json` 为 359,586,987 字节，文件指纹记录于发布清单。只读挂载的 0.8.1 Apple Silicon 安装包通过深度签名校验，包内 10 个前端文件与 Web 构建逐字节相同。桌面版从系统打开同一 Sketch 原件，写入本机存储，再从文件菜单保存副本，通过 macOS 重新打开后核对 36 页、44,969 个编辑节点、1,919 个主件、4,798 个实例、156 个图像和 5 个字体。[安装包与原生副本校验值](evidence/2026-11-23/apple-sketch/desktop-release.json)

**独立 React 工程。** 文件菜单下载的 ZIP 为 357,131,418 字节。使用 `node --import tsx scripts/check-apple-kit-project.mjs` 核对 1,080 个生成文件的 SHA-256，再在全新目录安装依赖并通过标准 TypeScript、Vite 构建。浏览器打开默认封面、1,976 项画板目录和六个样本的直链，宽高与原稿逐项相同，没有前端异常。该入口和文件校验脚本可复跑。[独立工程实测](evidence/2026-11-23/apple-sketch/react-project.json) 同一生产版通过 198 项单元测试、53 组编辑器浏览器用例、34 个既有独立工程的安装构建与浏览器验证，以及格式检查。

使用用户提供的 `Apple iOS 27 UI Kit.sketch`（207,834,444 字节，SHA-256 以 `839ecf26` 开头）。0.8.0 的实际文件选择器在 128 MiB 上限处拒绝此档。采用相同原件独立读取压缩目录及 UTF-8 JSON，并用原件记录的 Sketch 2026.3.1（234013）按图层 ID 导出 1× PNG。源包含 36 页、13,914 个原始图层、1,919 个主件、4,798 个实例、5,588 条实例覆盖，以及 155 张 PNG、1 份 PDF 和 5 个字体文件。图层名中有 1,025 处使用补充私用区字符。[源档清单及旧版阻断](evidence/2026-11-23/apple-sketch/source-inventory.json) · [独立清点脚本](../scripts/check-apple-kit-source.py) · [相同构建号的 Sketch 发布记录](https://www.sketch.com/changelog/2026-3-1/)

首次生产候选已能打开整档。原厂图像对照仍发现封面照片被灰色漆覆盖、色板行列倒序、开关方向反转、按钮宽 2 px 等缺陷。每个取样从实际页面列表选页，按图层 ID 选中后进入预览，以 100% CSS 尺寸及 DPR 1 截图。比较前两图均在 sRGB 白底合成；任一 RGB 通道差值大于 16 就计为差异像素。宽高不同时单列尺寸错误。[修复前六项数据](evidence/2026-11-23/apple-sketch/first-production-comparisons.json) · [浏览器复测脚本](../scripts/check-apple-kit-import.mjs)

**正式版的结构与资源。** 36 页的 ID、名称及顺序与原档一致。逐条比对 13,914 层的原 ID、所在页、父节点、同级顺序、名称和文本，差异为 0。1,919 个主件及 4,798 个原始实例逐个匹配源定义。44,969 个展开节点无重复 ID、断层或失效实例引用。160 个源样式定义（105 个本地文字样式、13 个外部文字样式、42 个图层样式）均能找到对应命名与分类，Forma 将填色、描边及效果分为 194 个可复用样式。111 个本地和外部色变量的 ID、名称及 RGB 值全部匹配。155 份 PNG 和 5 个嵌入字体逐份核对 SHA-256；余下的单页 PDF 在本机转成 48 × 48 透明 PNG。Chrome、Firefox、WebKit 均使用新存储空间打开下载的 Forma 文件，逐条检查结构，并实测用汉字、组合音标、私用区字符和 Emoji 重命名主件及撤销。[Chrome](evidence/2026-11-23/apple-sketch/chromium.json) · [Firefox](evidence/2026-11-23/apple-sketch/firefox.json) · [WebKit](evidence/2026-11-23/apple-sketch/webkit.json)

Chrome 158 对正式 0.8.1 工作区的采样记录为预审 11.45 秒、保存并打开 8.50 秒、强制刷新 5.88 秒，在空白存储重新打开 359,586,987 字节的 `.forma.json` 用时 13.28 秒。回到原始封面 Library Preview 后，通过文件菜单导出的整档 React ZIP 为 357,131,418 字节，用时 21.88 秒；独立读取 ZIP 路由表确认首屏 ID 和原件一致。这些数值是该机器的单次测量。[分引擎汇总、产物哈希与门槛](evidence/2026-11-23/apple-sketch/browser-results.json)

**正式版与同版本 Sketch 的 1× 图像对照。** 六个根节点均已恢复原始宽高。低于初拟 0.5% 门槛的两项是选色器和开关。每项分母是该张基准图的实际像素数，结果仅覆盖下表六个图层。

| 原厂导出对象 | 宽 × 高 | 通道差超过 16 的像素 | 占比 |
| --- | ---: | ---: | ---: |
| 封面 Library Preview | 640 × 640 | 25,051 / 409,600 | 6.116% |
| 浅色警告框 | 402 × 874 | 5,276 / 351,348 | 1.502% |
| 深色大按钮 | 72 × 50 | 181 / 3,600 | 5.028% |
| 色板 | 360 × 300 | 514 / 108,000 | 0.476% |
| iPad 深色键盘 | 1,210 × 428 | 15,407 / 517,880 | 2.975% |
| 关闭状态的深色开关 | 64 × 28 | 0 / 1,792 | 0.000% |

封面的剩余差异集中在数字的玻璃材质字形、阴影衰减及页脚文字。按钮的 181 个差异像素全部落在标签文字范围。警告框、键盘仍有局部阴影、文字与材质合成差异。原文件报告共 5,589 项，包含 2,813 个尺寸异于主件的实例、384 条 Liquid Glass 近似、387 条引用源档已不存在图层的覆盖、95 条缺少替换主件的覆盖及 44 条缺失共享样式引用。用户可在保存前查看或下载完整报告。原始 Apple 文件与图像保存在本机，仓库保留统计证据。

复跑时将 `APPLE_SKETCH` 指向本机原始设计文件，`SKETCHTOOL` 指向构建号 234013 的可执行程序，`FORMA_URL` 指向本轮的生产预览。完整验收通过真实文件选择器写入新的浏览器存储空间，并在另一个空白空间打开下载的原生文件。命令中的全部图像、字体和衍生设计文件只写入本机忽略提交的 `output/playwright/apple-kit/`。

```sh
python3 scripts/check-apple-kit-source.py "$APPLE_SKETCH" --sketchtool "$SKETCHTOOL"
FORMA_APPLE_DOWNLOAD_PROJECT=1 node --max-old-space-size=6144 --import tsx scripts/check-apple-kit-import.mjs "$APPLE_SKETCH"
```

## 文件菜单版本日志

**v0.8.2 · 2026-11-23。** 工作区有 17 个连续登记的版本。菜单与面板标题显示当前 v0.8.2，正文列出 11 次重要更新。最近一条是 2026-11-23 的 v0.8.1。v0.7.1 的选区 AI 和右栏调整出现在 v0.8.0 正文中。v0.8.2 的维护摘要等待下次公开更新。[项目逐版明细](CHANGELOG.md) · [新面板实拍](evidence/2026-11-23/release-notes/panel-0.8.2.png)

在 macOS 使用 Chrome 158、Firefox、Playwright WebKit 和只读挂载的 Apple Silicon DMG，在 Aura 工作台选中部署窗标题，分别以深浅主题、900 × 480 窗口从文件菜单打开。已逐行核对可见日期与 HTML 日期属性、验证补丁归并、键盘滚至最早版本、三种关闭方式及关闭后选区。Firefox 回归中批量读取日期时测试进程曾崩溃，改用逐条读取后同一产品构建通过。0.8.2 打包时的全仓格式检查及生产构建通过，200 项单测通过。Chrome 另通过既有编辑器面板回归。安装包通过本机 ad-hoc 深度签名检查。[界面回归](../scripts/check-release-notes.browser.js) · [发布规则回归](../tests/release-notes.test.ts) · [0.8.2 安装包](../release/Forma-0.8.2-arm64.dmg)

**v0.8.1 旧版面板。**

2026-11-23，在 macOS 的 Chrome 158、Firefox、Playwright WebKit 和本机 Electron 源码启动的离屏窗口，从 Aura 工作台选中部署弹窗标题，打开文件菜单底部的版本号。深浅主题均在 900 × 480 窗口验证。点击和键盘 End → Enter 均打开日志，首条匹配运行版本 v0.8.1，共 16 条，正文可以用键盘滚到 v0.2.0。Tab 焦点在弹窗内循环，Esc、关闭按钮和点击遮罩均可退出。关闭后仍选中原图层，键盘关闭会将焦点送回文件菜单。Chrome 另外通过既有编辑器面板回归。该次桌面验证使用工作区生产资源。[面板实拍](evidence/2026-11-23/release-notes/panel.png) · [复测脚本](../scripts/check-release-notes.browser.js)

## 0.8.0 · Sketch 和 Figma 原生文件导入

2026-11-22，在 Apple Silicon、macOS 27.2.1、Node 25.8.0 上使用生产网页和只读挂载的 macOS 安装包。浏览器从文件菜单或文件管理器选择原件，查看报告后点「导入为新文件」。原工作区的设计保持可重开；新文件的报告记有源 SHA-256。各浏览器分别刷新、下载设计文件、在全新浏览器存储中从这个副本重开，再从编辑器导出整文件 React ZIP，在独立目录安装依赖、构建并运行指定画板。[复测脚本](../scripts/check-design-import.mjs) · [按引擎及输入的原始结果](evidence/2026-11-22/design-import/browser-results.json)

| 实际输入 | 对照与结果 |
| --- | --- |
| Sketch 91 官方 `with-color-variables.sketch`，文档版本 144 | 517 个源层、2 页，展开后可选 1,401 层。保留 46 个本地主件、2 个外部主件快照、68 个实例、3 个共享文本样式、3 个颜色变量、14 张图片。Chrome 导入报告记录 40 项兼容性说明。打开 Overview，修改 `label-small-white` 字重后绑定的可见文字变为 300，撤销恢复。用损坏文件打开时可见原因，提交按钮禁用，取消后旧稿的完整下载内容相同。[导入报告](evidence/2026-11-22/design-import/sketch-review.png) |
| Grida `components.fig`，Kiwi 头版本 101 | 19 条源记录、4 个普通页，按位置键恢复顺序。13 个可选节点含 8 个实例，4 个主件组成 3 个可复用组件。把 blue 主件改绿，另一页继承的实例随之变绿，显式覆盖的蓝色 50% 实例保持蓝。重置该实例恢复原始 100%，撤销恢复 50%。单层改名含中文、组合重音、ZWJ 表情及 U+100EC3 私用字符，可保存和撤销。[导入报告](evidence/2026-11-22/design-import/fig-review.png) |
| `Simple Design System.fig`，Kiwi 头版本 101，7,911,644 字节 | 9,586 条源记录，恢复 30 个普通页、18,360 个可选节点、2,332 个组件、2,720 个变体、313 个共享样式、407 个源变量和 26 张图片。另生成 29 个透明度变量以表达独立 Alpha。表内 1,078 个可选实例按展开后的页面计；源清单 1,685 条 INSTANCE 也包含定义内记录。整文件 React 工程独立运行封面，`Simple`、`Design`、`System` 三个文本层使用源字形轮廓。本次 Chrome 导入报告记录 402 项兼容性说明，含源字体可用性；逐项数据断言与封面视觉抽查分别计量。[真实编辑器](evidence/2026-11-22/design-import/sds-canvas.png) |
| 自制独立编码 `shared-paint.fig`，一个普通页 | 用同一蓝色共享样式绑定底板填充和白卡的 6 px 居中描边。在 Forma 样式面板改为 `#00CC44`，预览和独立工程均可打开。工程实际像素核对卡片内部白色、边线绿色、底板填充绿色；下载重开后两个绑定仍指向同一项定义。[输入](evidence/2026-11-22/design-import/shared-paint.fig) · [原始场景及独立编码器调用](evidence/2026-11-22/design-import/make-style-fixture.cjs) |

Chrome 158、Firefox 159、Playwright WebKit 27.2 每个引擎均跑上述 4 份输入的可编辑副本、重开、预览及各自下载的工程，共 12 个独立安装和构建。SDS 的后备字体可用性取决于运行机器；真实 Figma 字库、Sketch Smart Layout 和复杂蒙版等仍按源特性逐项列为差异。桌面端从挂载的 DMG 通过系统打开事件实际导入两份 Sketch 和三份 Figma，分别核对页数、重启/重开后的源摘要，并复跑已有两份 Forma 文件的打开流程。macOS 系统打开的证据与浏览器导出测试分开记录。[安装包及原档检查结果](evidence/2026-11-22/design-import/desktop.json)

同版通用回归通过 185 项单测、51 组已有浏览器场景、34 个独立工程及两项大文档压力场景。[构建、引擎与原始读数](evidence/2026-11-22/design-import/regression.json)

### 与原设计工具的视觉对照

| 位置、口径 | 已见差异与边界 |
| --- | --- |
| Sketch Overview，375 × 1,725，原厂 Sketch 101 输出 PNG 对独立工程原尺寸截图。白底 sRGB、逐像素 RGB 最大通道差大于 16 | 首次检测出顶部浅灰底、内容卡叠色缺失、英文大写变更、价格换行以及文本过粗；修正后超阈值像素从 165,902 降到 **16,277 / 646,875（2.516%）**。剩余主要见字形笔画、局部位置与图像采样。拟定的整幅 ≤0.5% 保真门槛仍未通过。[左原厂、右工程](evidence/2026-11-22/design-import/sketch-comparison.png) |
| Figma SDS 的 Cover，原包 `meta.json` 的取景为 1,920 × 1,080，附带 400 × 225 PNG 缩略图。用相同画板视口，工程截图缩至相同尺寸后比 RGB 通道 | 发现并修复设计系统封面不换行、Logo 曲线圆角以及 Whyte 字体缺失造成的替代字形。处理缺字体源字形后同画板从 7,495 降到 3,833 个差异像素；按 Figma 原始描边占位规则修正自动布局后，Chrome 正式版实测 **3,058 / 90,000（3.398%）**。WebKit 为 3,157，Firefox 为 2,123。源缩图的抗锯齿、图像采样与源端文字排版影响结果；仅代表此画板、该缩放。[左归档缩图、右工程](evidence/2026-11-22/design-import/sds-comparison.png) |

两份原件的来源与版本、真实样本统计及必测边界见[Sketch 调研](requirements/SKETCH-IMPORT-RESEARCH.md)、[Figma 调研](requirements/FIGMA-IMPORT-RESEARCH.md)和[计量方法](requirements/DESIGN-IMPORT-FIDELITY.md)。Apple iOS/iPadOS 27 的 151 个资源文件已单独核查；在当次 0.8.0 测试时仍缺少这套 Apple 原档和源端渲染；后续实测见[双格式复验](#apple-原稿双格式复验)。

从项目根目录构建并启动生产预览，执行 `FORMA_URL=http://127.0.0.1:4173 node scripts/check-design-import.mjs`。可按参数筛选 `sketch`、`fig`、`sds`、`paint`，设置 `BROWSER_ENGINE=webkit` 或 `firefox` 重测。脚本从固定提交下载并验 SHA-256；已有文件可通过 `FORMA_IMPORT_FIXTURES` 指向离线目录，文件名见脚本。为了复核原厂 Sketch 的数值，按[原厂渲染命令](requirements/SKETCH-IMPORT-RESEARCH.md)导出 Overview 并将 `FORMA_SKETCH_REFERENCE_PNG` 指向 PNG；超过门槛时脚本以非零返回，并保存原始统计供定位。图像、每一份文件的操作、像素和工程结果默认写入 `output/playwright/design-import/<engine>/`。

## 2026-11-22 外部设计文件导入前的样本核查

本条记录导入工程的输入基线。macOS、Node 25.8.0；通过独立只读解析清点 2 份 Sketch、3 份 Figma 原始文件，并以 Sketch 原厂工具 101 渲染 1 幅固定画板。再次核对公开 Sketch 样本的 517 层与 75 条覆盖，Figma Simple Design System 的 1,685 条实例引用均指向 SYMBOL，278 组兄弟层的序列化顺序偏离位置键顺序，6 条矢量源高度为零。[Sketch 样本](requirements/SKETCH-IMPORT-RESEARCH.md) · [Figma 样本](requirements/FIGMA-IMPORT-RESEARCH.md)

给定 Apple 目录含 151 个资源条目，137 个路径含私用区字符。用实际 Forma 文档解析器验证含该字符的文本与 UTF-16 样式范围可往返、未声明的来源字段会被移除、缺父层及单页 10,001 层会被拒绝。在项目根目录执行 `node --import tsx docs/evidence/2026-11-22/design-import/inspect-baseline.mjs "/Users/bighope/Downloads/apple-ios-27-ui-kit_assets_2026-10-27_v32"` 可复核目录摘要与四项断言。[只读探针](evidence/2026-11-22/design-import/inspect-baseline.mjs) · [实际输出](evidence/2026-11-22/design-import/baseline.json)

此前取得 Apple 的资产与公开页面信息。上方 0.8.0 实测已覆盖其他公开原档；Apple 指定套件的原档专项仍待验收。[正式放行条件](specs/DESIGN-FILE-IMPORT.md)

## 2026-11-22 · 界面精简去噪、右栏 Figma UI3 单屏密度与任意图层 AI 入口

2026-11-22，针对网页版实操验收反馈对照 Figma UI3 空白 iPhone 16 画板实拍完成两项收口：

- **整体界面去噪与右栏单屏对齐**：移除画布顶部条与右栏底部两处重复的「设计规范校验」入口；收紧画布顶部条至 `28 px` 并将「智能吸附」由高亮复选框改为轻量图标开关；弱化顶栏面板展开态与左栏导航高亮；闲置图层树折叠 5 枚类型筛选胶囊至搜索框筛选图标内；右栏重排并压缩「布局 / 外观 / 填充 / 描边 / 效果 / 布局参考网格 / 导出」，空白 iPhone 16 画板在 1440×900 单屏内完整呈现全部属性分区而无需滚动。[实拍对比截图（含 iPhone 16 单屏、右栏 AI 对话、Aura 深浅双主题）](evidence/2026-11-22/v0.7.1/)
- **任意图层选中时的右栏 AI 快捷入口**：在 [Inspector.tsx](../src/editor/Inspector.tsx) 对象标题行（覆盖画板、分区、切片、文本、形状、矢量、组件、实例与多选）与空选区右栏顶栏提供 `✦ AI` 入口按钮，点击即唤起并聚焦 [CanvasAgentBar.tsx](../src/editor/CanvasAgentBar.tsx) 且自动绑定当前选区与场景化快捷提示词。`scripts/check-agent-canvas-chat.browser.js` 已新增右栏 AI 按钮端到端断言（`rightSidebarAiEntry: true`）。

| 验证项 | 实测结果 |
| --- | --- |
| `npm run format:check`、`npm run build` | 通过，0 个 TypeScript 错误 |
| `npm test` | **165/165 通过**（0 失败，0 跳过） |
| `npm run test:browser`（Chrome 生产预览） | **51/51 场景全部通过**（含新增右栏 AI 入口校验） |
| `node scripts/check-render-parity.mjs` | 20 个画板、1,828 层全部通过，最大几何偏差 **0 CSS px**，RGB 差 >16 像素占比 **0.000%–0.004%** |

## 2026-11-22 · 61 面板补齐、多模型自动适配与画布对话生成

2026-11-22，macOS arm64、Node 25.8.0、Playwright Chromium、生产构建（`npx vite preview --port 4179`）。

- **面板补齐与对齐（50 → 61 编号）**：新增 `03.08` 分区（Section）、`03.09` 比例缩放（`K`）与铅笔（`⇧P`）、`03.10` 切片（`S`）与批量导出（`⇧⌘E`）、`03.11` 视图偏好菜单（轮廓线框 `⌘Y`/`⇧O`、像素网格 `⌘'`、布局参考网格 `⌃G`）、`04.20` 布局参考网格、`04.21` 多行导出设置与缩略图预览、`04.22` 设计规范校验（Check Designs）、`06.04` 画布评论（`C`）、`07.04` 原位开发检查模式（Dev Mode `⇧D`）、`08.03` 多模型配置与 `08.04` 画布内联对话条（`⌘↵`）。同步补齐角度/菱形渐变、取色器 WCAG 对比度、图像 90° 旋转/高级调色/四边裁切手柄、多平台 Code Syntax、多触发交互 + Smart Animate、设备机身框与折叠式画板预设。
- **多模型自动适配与画布对话**：覆盖 13 家主流供应商，单测验证密钥前缀识别、Kimi/Qwen/MiniMax/SiliconFlow 区域回退、OpenAI/Anthropic/Gemini 三协议与推理参数适配、`json_schema → json_object → prompt_json` 自动降级、蓝图编译与自愈修复；浏览器端到端验证零预请求离线安全、自动探测与能力画像、脱敏存储、`⌘↵` 画布对话、实时画布预览 HUD、原子采纳与 `⌘Z` 单步撤销。[规格说明](specs/AGENT-PROVIDER-AND-CANVAS-CHAT.md) · [61 面板台账](specs/EDITOR-PANEL-ACCEPTANCE.md) · [实拍截图目录](evidence/2026-11-22/v0.7.0/)

| 验证项 | 实测结果 |
| --- | --- |
| `npm run format:check`、`npm run build` | 通过，0 个 TypeScript 错误 |
| `npm run desktop:agent`、`npm run desktop:service` | 通过，内嵌服务打包完成 |
| `npm test` | **165/165 通过**（0 失败，0 跳过；含新增 `figma-panels.test.ts`、`agent-providers.test.ts`、`agent-blueprint.test.ts`） |
| `npm run test:browser`（Chrome 生产预览） | **51/51 场景全部通过**（含新增 `figma-new-panels`、`agent-canvas-chat` 及既有 49 组全量回归） |
| `node scripts/check-render-parity.mjs` | Aura 与移动样例 20 个画板、1,828 层全部通过，最大几何偏差 **0 CSS px**，RGB 差 >16 像素占比 **0.000%–0.004%** |

**本次未验证范围**：Firefox、WebKit 跨引擎复跑、macOS DMG 重新打包与安装版实操、独立导出的全量 React 工程批量回归（`npm run test:exports`）、大文档 `layer-tree`/`complex` 重测，以及真实第三方云端厂商付费 API 的实际出图审美评测。

## 0.6.5 文本图层原位编辑

2026-11-21，在 Aura 工作台的「新建 React 生产部署任务」标题上复现。0.6.4 双击后会隐藏原文字，另建带 1 px 边框的编辑框，并重新计算字号、位置和宽高。这个框还漏用了原图层的垂直对齐、文字大小写等样式。0.6.5 在原图层的文字位置编辑，焦点轮廓绘制在布局之外。[打开 Aura 原图层](http://127.0.0.1:5173/?example=aura-showcase&page=workspace&node=ws-modal-h)

| 双击前后同一字符的屏幕矩形 | 0.6.4 最大偏差 | 0.6.5 最大偏差 |
| --- | ---: | ---: |
| Aura 弹窗标题，自动适配到 198% | 1.98 CSS px | 0 CSS px |
| 普通中英混排单行，100% | 1 CSS px | 0 CSS px |
| 带描边且垂直居中的多行文字，100% | 9 CSS px | 0 CSS px |

同一份稿，三档缩放 50%、100%、200%，分别复验固定单行、居中折行、底部对齐与最大行数、自动布局内旋转的 Hug 富文本、按钮文字及尾随换行。加上 Aura 标题，每个平台共 19 组。进入编辑、原样提交两次测量的逐字偏差都为 0。18 组对照稿在相同视口截图中，排除光标、选中效果和编辑轮廓后，正文变化像素数均为 0。旧版基线取自同机 Chrome 加载的 0.6.4 安装包资源。PNG 示图为 100% 下的居中多行文字。[展示](evidence/2026-11-21/v0.6.5/display.png) · [旧版编辑](evidence/2026-11-21/v0.6.5/0.6.4-editing.png) · [修复后编辑](evidence/2026-11-21/v0.6.5/0.6.5-editing.png) · [复测设计文件](evidence/2026-11-21/v0.6.5/text-position.forma.json)

另从空文本框输入中文，按 Enter 后继续输入英文，检查提交前后字形位置，撤销再重做。Hug 高度的文字设定行高 21 px，保留尾随换行时测得 42 px，清空后为 21 px；属性栏与画布实测一致。末尾空行也在预览与独立 React 工程中保留。[浏览器回归用例](../scripts/check-text-position.browser.js) · [各环境读数](evidence/2026-11-21/v0.6.5/results.json)

Mac M1 Max、macOS 27.2.1。复测使用 Chrome 158、Firefox 159、Playwright WebKit 27.2 和只读挂载的 Electron 45.4.1 安装包。Chrome 在 1× 与 2× 像素密度分别重放，均得到上述结果。另用 Chromium 的组合输入接口把 `nihao` 选成「你好」，确认一次提交、撤销恢复原文和重做；本次没有操作系统输入法选词面板。[Mac 安装包](../release/Forma-0.6.5-arm64.dmg)

本版通过 139 项单元测试、格式检查和生产构建。Chrome 默认 49 组界面场景全部通过，34 个 React 工程分别在干净目录安装、构建、启动并验证。Firefox 与 WebKit 分别通过 5 个相关场景和 3 个独立工程，Mac 安装包通过 5 个场景和 2 个独立工程。[逐项记录与安装包摘要](evidence/2026-11-21/v0.6.5/results.json)

## 0.6.4 位图编辑与原型输入

2026-11-21。复验设计师从属性栏编辑图像、在画布上直接裁切、保存重开，以及交付静态图与可交互 H5 的完整操作。选中位图后双击，或使用「图像填充」的裁切按钮。在文件菜单打开下方任一设计稿可重放对应案例。

| 工作流 | 实际操作与结果 |
| --- | --- |
| 图像属性和画布 | 拖动中的裁切可用 Esc 取消。拖右下角将倍率从 1 调至 1.5，一次撤销还原，再重做。切换平铺，以 50% 大小重复 32×16 px 的源图。调节亮度、对比度、饱和度，一键重置再撤销，重开文档后复查。 |
| 蒙版与导出 | 同一 220×120 px 画板包含普通位图、4 px 内描边位图、透明度蒙版和亮度蒙版。在画布、预览、SVG、PNG 和独立 React 工程检查 10 个取样点。透明区域显示白底，调色后的色块约为灰阶 44，黑色经亮度蒙版后约为灰阶 210。此次修正了两处能在交付物看到的偏差：透明像素在静态蒙版中被底色填实，带内描边的图块在静态输出中偏移了 4 px。 |
| H5 原型 | 在有悬停交互的卡片里轻触跳转及返回，移动鼠标则打开悬停浮层。用 Tab、Shift+Tab、Enter、空格与 Esc 操作两层浮层，内层关闭后焦点回到「More」，外层关闭后回到最初按下的步进器「件数 增加」。独立工程在 390×844 px 执行同一流程。三引擎使用触摸仿真，Mac 客户端复验鼠标和键盘。 |

[位图原稿](evidence/2026-11-21/v0.6.4/image-paint.forma.json) · [图片属性面板实拍](evidence/2026-11-21/v0.6.4/image-paint-panel.png) · [实导 SVG](evidence/2026-11-21/v0.6.4/image-paint.svg) · [实导 PNG](evidence/2026-11-21/v0.6.4/image-paint.png) · [位图 React 工程](evidence/2026-11-21/v0.6.4/image-paint-check.zip) · [嵌套浮层原稿](evidence/2026-11-21/v0.6.4/prototype-input.forma.json) · [H5 React 工程](evidence/2026-11-21/v0.6.4/prototype-input-check.zip)

**混合位图与大文件。** 在同一台 M1 Max、同版本 Chrome 和 1460×960 px 视口，按 0.6.3 → 0.6.4 → 0.6.4 → 0.6.3 顺序，每次新开浏览器。每轮使用相同 8 张生成的 JPEG、PNG、WebP 横竖图，最长边 4096 px，完成 96 次裁切编辑、12 组撤销重做、3 次预览与刷新。12 次回合结束时采样的 JS 堆峰值，两次旧版为 1033、1106 MiB，新版为 564、580 MiB。此数值只反映此稿短会话的 JS 堆。两小时记录来自较早的 8 张同尺寸 JPEG 压测。[逐次读数与输入尺寸](evidence/2026-11-21/v0.6.4/results.json)

同机另测 10,000 层平铺稿，导入 462 ms，挂载 38 个树行，拖动 224 ms。8,288 层、128 个画板的复杂稿导入 1165 ms，6 次拖动耗时中位数/P95 为 241/246 ms。共 84 个帧间隔，P95 为 17 ms，其中 0 个超过 25 ms。[大文档复测脚本](../scripts/bench-complex.browser.js)

**正式版本。** macOS 27.2.1 arm64。139 项单元测试、格式检查和生产构建通过。Chrome 158 全部 48 组编辑器流程通过，33 份导出工程逐个安装、构建并启动验证。Firefox 159 和 Playwright WebKit 27.2 各复测 9 组流程及 8 个工程。Electron 45.4.1 在只读挂载的 DMG 中通过签名验证，从离屏副本执行 8 组流程并构建运行一份导出工程。安装包 SHA-256 为 `de5854ccdae974452fa1ec26ccbe5a1951da73422b3632210e58814f16d35bc9`。[安装包](../release/Forma-0.6.4-arm64.dmg) · [分平台用例和文件摘要](evidence/2026-11-21/v0.6.4/results.json)

复测位图使用生产预览与 `FORMA_BITMAP_SET=mixed FORMA_URL=http://127.0.0.1:4173 npm run test:browser -- bitmap-session`。对照稿和生产构建在同一 Chrome 中分别运行。图片的独立旋转、裁切框边缘手柄及其他高级调色仍有差距，iOS 与 Android 的硬件触控仍需实机验证。[已对照的 Figma 操作](specs/PROFESSIONAL-EDITING.md#位图填充与裁切)

## 0.6.3 属性栏布局

2026-11-21，在 Aura「产品工作台 → 新建部署任务 · 浮层」复现用户截图。该画板为 440×410、纵向布局、间距 16、四边内边距各 24。此前九点矩阵相对整列设置垂直居中，分布和独立内边距按钮各占一行。以 292 px 属性栏、2 倍截图比较，自动布局控件组高从 246 px 降至 121 px，整个「布局」区从 510 px 降至 397 px。图层间距和分布按钮同行，四边输入按两列排开。[修复前](evidence/2026-11-21/v0.6.3/before.png) · [浅色](evidence/2026-11-21/v0.6.3/after-light.png) · [深色](evidence/2026-11-21/v0.6.3/after-dark.png) · [256 px 属性栏同时展开尺寸范围和网格轨道](evidence/2026-11-21/v0.6.3/grid-256.png)

| 环境或入口 | 实测 |
| --- | --- |
| Chrome、Firefox、WebKit 及 macOS arm64 安装包 | 均通过 `inspector-layout`、`size-limits`、`wrap`、`sizing`。在 256、292 和 400 px 属性栏，九点矩阵、间距与两行内边距保持排列。721×480 窗口从顶栏打开属性面板，切换主题后可滚动到最后一项并用 Tab 进入开关，无横向溢出。 |
| 编辑与保存 | 将左内边距改为 36，画布读得 36 px，一次撤销还原。四边均为 24 时合并后画布仍为 24。混选两个画板后改左边距，右边保留差异。锁定后布局、对齐、间距分布与四边控件禁用。保存并刷新后下内边距仍为 28。绑定 12 的变量时，关闭四边 24 的覆盖后恢复绑定值 12。 |
| 正式构建 | macOS 27.2.1，138 项单元测试、格式和构建通过。Chrome 另测 `editor-panels`、`panel-data-safety`、`professional-editor`。DMG 只读挂载，签名和映像校验通过，使用包内程序的临时离屏副本复验。安装包 SHA-256 为 `750404be0e4a67cfcb26c068c3e785853e4e9e3d6413bb2ac2a3b3261c46cff1`。[安装包](../release/Forma-0.6.3-arm64.dmg) · [回归用例](../scripts/check-inspector-layout.browser.js) |

## 0.6.2 面板复核

2026-11-21。在同一台 Apple Silicon Mac 上，以 Gemini 的 50 行原始清单为索引，核对空白稿的 Figma 参考实拍、Forma 源码与设计师实际操作。每个编号都有一栏记录本版行为和剩余差距。[逐项核对及 Figma 对照](specs/EDITOR-PANEL-ACCEPTANCE.md#062-独立复核) · [分平台操作、读数及安装包校验值](evidence/2026-11-21/v0.6.2/results.json)

| 正式构建验收 | 结果 |
| --- | --- |
| 类型、格式与单元测试 | `npm run build`、`npm run format:check` 通过。138 项单元测试全部通过，0 跳过。 |
| Chrome 158.0.8127.36 / Firefox 159.0 / WebKit 27.2 | 各运行默认 45 组界面流程，全部通过；各自下载的 31 个不同 React 工程分别在独立临时目录安装依赖、构建、启动并用相应引擎验证。WebKit 使用 Playwright 构建。 |
| macOS 27.2.1 arm64、Electron 45.4.1 | 只读挂载 DMG，临时用户目录离屏运行。完成上述 45 组流程以及系统打开文件、发布后退出重开、外部 MCP，合计 48 组。对其中 5 份安装版导出工程另外独立构建运行。DMG 校验及 ad-hoc 签名验证通过，包内 8 个网页发布文件与 dist 逐字节相同。 |
| 空模型网关 | 手动工作流可用。开发入口 5173 与安装版分别验证了真实 MCP stdio 的读取、提案、应用及撤销。配对期间来回切换助手和图层，密钥保留。预览端口 4173 不在默认配对来源表中。 |
| 画布、预览与独立工程 | Chrome，2000×2500 视口。Aura 与移动设计样例的 20 个画板、1,828 层，无缺层、多层或可测换行差异，两段对照最大几何偏差均为 0 CSS px。预览与工程的像素 RGB 通道差超过 16 的占比最高为 0.004%。 |
| 大文档 | 生产预览 1460×960。10,000 层平铺导入 443 ms，挂载 38 个树行，拖动 219 ms。8,288 层、128 个画板、4,160 个矢量、192 个实例，导入 1,145 ms，6 次 12 步拖动的中位数/P95 为 241/243 ms，84 个帧间隔 P95 为 17 ms，超过 25 ms 的为 0 个，单次采样 JS 堆 123 MiB。 |

**新增的入口复验**

- 在文件列表取消一次改名，再正式改名，关窗后撤销、重做、编辑和刷新。复制原稿，真正打开副本，核对图层数，改名并删除当前副本，自动返回原稿，原名及图层数都保留。网页三引擎与安装版均完成这组追加验证。[文件预览实拍](evidence/2026-11-21/v0.6.2/files.png)
- 按同一页行的上半部和下半部重排，不切换当前页。从同一库连续拖入两种组件，得到不同实例。键盘浏览命令时输入框仍有焦点，当前项留在滚动窗口内。[资源面板](evidence/2026-11-21/v0.6.2/assets.png) · [命令搜索](evidence/2026-11-21/v0.6.2/commands.png)
- 对两个不同值的文本图层聚焦再离开 Mixed 文字和最小宽度输入，甲/乙与 40/60 原样保留。四角实测按左上、右上、左下、右下得到 4/8/12/16 px。钢笔新路径撤至空后再撤，保留此前的文档修改。
- 8 位 HEX 和 CSS rgba 同步写颜色与透明度，各自一次撤销复原。取色板拖动验证预览与松手提交。选区替换渐变色标及阴影保留各层透明度。修改本地样式的渐变及叠加填充，应用、重开后都保留；锁定后圆角、绑定和视口控件禁用。[变量与样式](evidence/2026-11-21/v0.6.2/variables.png)
- 选择原型曲线、更换目标、断开、撤销、重开。Fit width 按舞台宽度放大，100% 回到设计宽度。SVG 3 倍文件的实际宽度为 2,280，viewBox 宽度为 760。[播放窗口](evidence/2026-11-21/v0.6.2/preview.png)

**验证方法的修正。** Firefox 复用了内嵌 ICC 的固定 P3 PNG，验证输入、CSS、保存与导出；其 2D 读取缓冲报告 sRGB。没有做物理显示器比色。复杂稿将同一设计重复 32 次，图层树顺序修正后，以稳定 ID 在搜索结果中选定原采样实例，再开始计时。正式结果均来自完整通过的运行。

**与 Figma 仍有差距的项目。** 同状态截图可见，Forma 顶部仍保留文件栏与画布视图栏，右栏以 292 px 容纳 Web 布局和交付属性。当前图片与渐变有独立编辑入口，原型采用单触发规则；Smart Animate、完整团队协作及云端版本时间线未实施。真实模型生成质量和同稿 Figma 性能没有在本轮测量。[空白稿对照](specs/EDITOR-PANEL-ACCEPTANCE.md#同状态的视觉对照)

## 2026-11-21 · 50 面板复核与 Figma UI3 深度对齐

复核 2026-11-20 的 50 个编号（01.01–08.02）后确认：表内操作可复现，但布局、视觉和部分交互未达到 Figma UI3 水平，另复现 18 个 P0 缺陷。本次分三阶段处理：P0 修复 → UI3 深浅双主题与基础控件 → 50 个面板逐项对齐。分工：Gemini 负责编辑器界面、交互与验收；Codex CLI 负责 `src/domain`、`src/compiler`、`src/runtime`、`src/infrastructure` 与对应单元测试，两边改动的文件不重叠。逐项内容见[面板验收表的 2026-11-21 节](specs/EDITOR-PANEL-ACCEPTANCE.md#2026-11-21-复核与-figma-ui3-对齐)。

| 新增或修复（举例） | 关联源码 |
| --- | --- |
| 8 位 HEX 透明度、0 组件库更新、静态 SVG 逐路径颜色与透明度相乘、填充堆栈叠在图像填充之上、轻量 `setGuides` | `src/domain/color-profile.ts`、`library-review.ts`、`commands.ts`、`src/compiler/react.ts`、`tests/phase1-fixes.test.ts` |
| 页面背景、`pass-through`、描边可见/单边/虚线、`space-between`、绝对定位、逐效果可见、文字样式与最大行数 | `src/domain/{document,pages,node,stroke,sizing}.ts`、`src/runtime/FormaRuntime.tsx`、`tests/phase2-domain.test.ts` |
| 原型触发/过渡/打开链接；静态 PNG/JPEG/WebP/SVG 导出；多冲突工程更新逐文件选择 | `src/runtime/prototype-machine.ts`、`src/infrastructure/static-export.ts`、`project-revision.ts`、`src/editor/CodeAndUpdateModals.tsx` |
| UI3 主题（仅编辑器外壳）及 50 个面板的界面与交互 | `src/editor/ui3-theme.css` 与 `src/editor/` 下各面板 |

**实际操作与结果**（macOS arm64，Node 25.8.0，Playwright Chromium，`npx vite preview` 生产包）

| 命令 | 结果 |
| --- | --- |
| `npm run format:check`、`npm run build` | 通过，0 个 TypeScript 错误 |
| `npm test` | 138 项通过，0 失败，0 跳过 |
| `npm run test:browser`（全部） | 42/42 场景通过；最终 CSS 修改后再跑 `editor-panels panel-dialogs studio designer-delivery` 4/4 通过 |
| `npm run test:exports` | 从界面下载的 31 个 React 工程均独立安装、构建并在浏览器通过 |
| `node scripts/check-render-parity.mjs` | 20 个画板无缺层多层，最大几何偏差 0 CSS px，RGB 差 >16 的像素 0.000%–0.006% |

过程中发现并修复：主题全局控件规则与字体平滑泄漏进画板，导致像素对照 0.2%–31.7% 偏差；改为只作用于编辑器外壳并对 `.canvas-world`、`.runtime-stage` 复位后通过。另按 12 张 Retina 截图修正 11 处视觉问题（深色模式下标题不可读、选择框文字裁切、样式名截断为 2 字等）。[截图目录](evidence/2026-11-21/ui3/)

**0.6.1 记录时的未验证范围**　Firefox、WebKit、macOS DMG 打包与安装版流程未在 UI3 改造后复跑，面板表「Mac」列仍为 2026-11-20 结论；大文档 `layer-tree`/`complex` 性能未重测；物理 P3 显示器比色未做。

## 文件色域与位图交付

2026-11-20 · Forma 0.6.1 · 面板 **01.06**。在 Chrome 网页编辑器和从 Apple Silicon DMG 启动的离屏桌面客户端，分别从文件菜单打开「颜色配置」，完成相同操作。两份临时测试文件各自保存。网页入口显示 0.6.1，9 个生产资源与桌面包内资源逐字节一致。颜色读数来自渲染缓冲，未使用物理显示器比色。[双端读数与安装包校验值](evidence/2026-11-20/v0.6.1/results.json) · [面板截图](evidence/2026-11-20/v0.6.1/color-profile-dialog.png)

| 实际操作 | 两端结果 |
| --- | --- |
| 将 sRGB 红色 FF0000 指定为 Display P3 | 属性栏保留 FF0000。用同一 P3 像素缓冲读取渲染色，RGB 从 234、51、35 变为 255、0、0。 |
| 撤销，改选「转换 · 尽量保持外观」 | 撤销恢复 sRGB。转换后属性栏显示 EA3323，在 P3 缓冲中得到原来的 234、51、35。保存、刷新及预览后仍一致。 |
| 从文件分别导出「跟随文件」和「sRGB」的 React 工程 | 两端各下载两份 ZIP，分别独立安装、构建、运行。P3 工程显示转换后的 P3 红，sRGB 工程显示 RGB 255、0、0。两者所附原生稿均保留 P3。 |
| 将带色域标记的 8×8 红色 PNG 置入画板子层，随设计导出 | 重开、预览可解码。两个导出工程实际加载的 PNG 文件与原生稿内图像逐字节一致，宽度均为 8 px。 |
| 默认色域设为 Display P3，再点击「新建空白文件」 | 新文件的颜色配置显示 Display P3。未指定色域的旧文件按 sRGB 解释。 |

[跟随文件的 React 工程](evidence/2026-11-20/v0.6.1/color-profile-check.zip) · [指定 sRGB 的 React 工程](evidence/2026-11-20/v0.6.1/color-profile-srgb-check.zip)

Forma 的导出目标为 React Web/H5。PNG、JPEG 等导入资源保留原始编码和内嵌配置；导出色域用于工程中绘制的颜色。自定义 ICC 配置、CMYK 印刷和将画板栅格化为指定配置的图像文件仍在上述验收范围之外。[Figma 文件色域](https://help.figma.com/hc/en-us/articles/360039825114-Manage-color-profiles-in-design-files) · [Figma 静态资源导出](https://help.figma.com/hc/en-us/articles/13402894554519-Export-formats-and-settings-for-static-designs)

## 2026-11-20 · 0.6.0 分支矢量与画布组件集

49 个编号在网页与 macOS 安装版按表内任务通过。Chrome、Firefox 和 WebKit 分别完成 41 组界面操作，Chrome 另测外部 Agent。各浏览器从自己的界面下载 29 个 React 工程，分别独立安装、构建、打开验证。桌面包完成 44 组操作，另验证其下载的 3 个工程。桌面运行使用只读挂载安装包的临时副本，macOS 将该副本标记为仅后台运行，Electron 逐窗口检查未显示且使用离屏渲染。安装包签名已校验，9 个网页发布文件与包内资源逐字节一致。[面板对照](specs/EDITOR-PANEL-ACCEPTANCE.md) · [分平台实测与安装包校验值](evidence/2026-11-20/v0.6.0/results.json)

- **03.04、04.15**　在同一矢量内连接两个不相邻的点，将封闭区一分为二并分别上色。移动公共锚点、撤销、重做，重开后再次移动，两边都随动。从该点再延伸一条开放分支，独立工程显示两个闭合色区、一条无填充的开放路径。[预览截图](evidence/2026-11-20/v0.6.0/vector-network.png) · [界面导出的 React 工程](evidence/2026-11-20/v0.6.0/vector-network-check.zip)
- **04.17**　把 Idle、Busy 组合，一次撤销恢复两层，重做恢复组件集。新增 Size 的 Large 值后，State 不同的成员同排，Size 不同的成员同列。在画布拖入此前已被另一文件使用的 Error 主件，组件集增加一个成员，撤销、重做、重开均保留预期状态。新实例可选 Error。修改原主件宽度后，向先前文件应用库更新，原来的实例从 80 px 变为 96 px。[画布截图](evidence/2026-11-20/v0.6.0/canvas-component-set.png)

### 位图与颜色复验

在 Chrome 后台窗口从空文件点击底部「置入图像或 SVG」，分别选择 PNG、JPEG、WebP、GIF。四张测试图均在画布中以 36×24 原始尺寸解码。另验证拖入位图、裁切至 1.6 倍、改变焦点并打开预览。单张文件上限 8 MiB。颜色复验覆盖只改 HEX 时保留各层透明度、批量替换选区纯色、切换主题后实例从 #0066FF 变为 #FF7733。Forma 提供设计用色、变量与样式管理；0.6.0 当时未提供文件工作色域设置。0.6.1 的结果见上方「文件色域与位图交付」。

## 2026-11-20 · 0.5.1 功能面板逐项验收

[打开按面板编号的验收表](specs/EDITOR-PANEL-ACCEPTANCE.md)。8 个区域共 49 个编号。表中网页与 Mac 分别记录相同操作，从入口、编辑、保存和撤销，一直检查到实际画布、预览或下载文件。Figma 现场对照用独立编辑草稿，并留存左侧导航和画板预设截图。其他 Figma 操作按相应官方用户文档核对。

| 编号 | 在界面复现的问题 | 修复后复验 |
| --- | --- | --- |
| 04.01 | Figma 的 iPhone 16 为 393×852，Forma 同名预设实际创建 390×844。 | 选择 iPhone 16 后两端画板均为 393×852。390×844 保留为 iPhone 13/14；原 1024×768 预设明确标为平板横屏。 |
| 04.12 | 对象有多个投影时无法调换顺序。 | 多选两层分别拥有不同投影的图层，调序后两层均交换自身投影，一次撤销恢复；首行上移和末行下移禁用。 |
| 07.01 | 代码窗口提示 Esc，实际按键后仍开着。WebKit 鼠标打开窗口后关闭又丢失焦点。 | 三个浏览器引擎均可下载、Esc 关闭并返回「代码」按钮。Mac 安装版亦从同一入口复验。 |
| 03.05、04.13 | 桌面版将「设计工具 Studio」前两个字设为粗体 30 px 后，Hug 宽度显示 147.8 px，画布实际为 152.3 px。 | 字体测量继承文档语言，安装版宽度与实际绘制误差不超过 1 px，预览保持相同富文本与尺寸。 |
| 08.02 | 网页可连接的外部会话在安装版没有对应 API 路由。 | 网页和安装版各自从所选画板打开会话，外部客户端提交改名提案，由用户在面板应用并撤销。真实模型网关留空。 |

Chrome、WebKit 和 Firefox 各完成 39 组界面流程，另在 Chrome 验证外部 Agent。安装包只读挂载后通过 42 组，包含系统文件、多窗口冲突、发布后退出重开、库使用方接受修订和外部提案。核对安装包内编辑器 9 个资源与网页发布目录逐字节一致。从当次网页操作下载的 28 份 React 工程均在独立目录安装、构建并打开。单元测试 122 项通过。[面板操作结果](evidence/2026-11-20/panels/results.json) · [版本与校验值](evidence/2026-11-20/panels/build.json)

## 2026-11-20 · 0.5.0 桌面设计、组件升级与工程交付

[Apple Silicon 安装包](../release/Forma-0.5.0-arm64.dmg) · [可编辑的 Aura 双页稿](evidence/2026-11-20/v0.5.0/aura-responsive.forma.json) · [Aura React 工程](evidence/2026-11-20/v0.5.0/aura-react.zip) · [自定义订单路由工程](evidence/2026-11-20/v0.5.0/order-routes-react.zip) · [沿用旧属性名的业务工程](evidence/2026-11-20/v0.5.0/renamed-library-react.zip) · [完整实测结果及 SHA-256](evidence/2026-11-20/v0.5.0/results.json)

| 设计师从哪里操作 | 实际结果 |
| --- | --- |
| 主组件右栏更名，在两份订阅稿中检查修订 | 从源文件发布「标签」，两份新建文件分别改成「库存 12」和「已送达」。源文件将属性改成「业务标签」并重新发布，两份文件都能接收修订、撤销、重做并重开，原有文案各自保留。在改名前导出的工程上接入使用旧名的手写入口，二次更新后通过 TypeScript、生产构建并显示「业务旧名」。[主件面板](evidence/2026-11-20/v0.5.0/public-property-rename.png) |
| 在画板右栏设置断点外观 | 在 Aura 营销页的自由布局根画板从颜色输入设置 768 px 区间。768 px 显示 #F0F4FD，1440 px 恢复 Cloud Light 的 #F7F8FC；再进入工作台、打开部署弹窗并返回。在两页控制台中检查 ≤480、≤768 的网格外观，内层工具栏按自身 300 px 切换透明度。依次验证 375、390、768、1024、1440 并返回 390 px；在详情页确认自由画板只应用外观，保存的自动布局内边距不生效。清除窄区间填充继承上一档，再撤销恢复。预览和独立工程都实际渲染。[断点面板](evidence/2026-11-20/v0.5.0/responsive-appearance.png) |
| 导出工程，接入业务路由，再从文件菜单更新 | 订单入口自行处理 `#/orders/42`。从设计稿把入口按钮宽度从 120 改为 148 px，二次导出保留业务入口字节。独立安装、构建后，在详情地址刷新，打开两层弹窗，Tab 保持在内层，以 Esc 或按钮逐层关闭；焦点回到各自的打开按钮，浏览器后退可回订单列表。 |
| 在安装版输入中文 | 在空文件用键盘创建画板和文字，macOS 简体拼音逐键输入 nihao，空格选中「你好」。收到系统组合更新和 compositionend，再提交、撤销、重做并重开。测试仅向临时 Forma 进程发按键，保留系统当前输入源。 |

在同一台 Mac，122 项单元测试通过，0 项跳过。Chrome、Playwright WebKit 和 Firefox 各通过 38 组桌面操作。每个引擎分别对其界面下载的 28 个 React 工程独立安装、构建并操作。两套原生样例共 20 个画板、1,828 个图层，三引擎分别核对画布、预览和工程，未发现缺层、多层、超过 1 CSS px 的几何差异或文字行数差异。Firefox 使用运行器独立的应用数据和缓存目录，程序实际进入页面。透明度与亮度蒙版使用四块纯色内部像素采样；单色块仅有一个源像素时放大插值随引擎不同，采样结果不能作为纯色参考值。

公开下载的 Aura 稿另从安装版系统文件入口重新打开，在预览选 768 px 后实测为 #F0F4FD。[打开后的桌面截图](evidence/2026-11-20/v0.5.0/aura-desktop.png)

正式 DMG 只读挂载后直接启动，通过九个桌面流程。包括系统文件打开、发布后退出并重新订阅、组件变体、键盘创作及系统拼音。安装版下载的专业编辑和组件变体工程也分别构建运行。DMG、压缩包及应用签名均已校验。签名方式为本机 ad-hoc。

复测使用 `npm run test:browser`、`npm run test:exports` 和 `node scripts/check-render-parity.mjs`，分别设置 `BROWSER_ENGINE=chromium|webkit|firefox`。macOS 使用已选中的简体拼音输入源时，可运行 `node scripts/check-desktop-workflows.mjs system-pinyin`。本版压测使用正式渲染资源，平铺图层、复杂画板以及短位图回归的读数在原始记录中。0.4.0 的两小时候选测试保留在对应版本段落。

### 网页编辑器与安装版核对

0.5.0 Web 生产目录的 9 个文件逐一与 Apple Silicon 应用包内对应资源比较，内容一致。另在本机网页入口重跑 Aura 的断点编辑、跨页预览、工程导出，以及从源文件发布组件、更名并在两份订阅稿接收更新。前文的 38 组界面流程和 28 个独立导出工程均按浏览器引擎分别执行。

网页和安装版分别保存本机稿件。可用「设计文件」下载原稿，再从另一端导入。系统菜单、Finder 文件关联和内置本机组件库服务由 Electron 提供。本机 Web 开发与预览服务也提供组件库发布接口；部署到网站时需另配可访问的组件库服务。系统剪贴板读取与屏幕取色取决于浏览器能力和权限。以上记录适用于本机网页版和 0.5.0 生产构建。

## 2026-11-20 · 0.4.0 桌面设计与交付

模型网关留空，从设计者的操作入口验证。交接文档中的 Aura、移动资源库和编辑器操作路径按当前工作区运行核对；此工作区无 Git 元数据，按产出核对，无法按提交确定作者。[Figma 对照](specs/EDITOR-PARITY-PLAN.md) · [复现入口](specs/PROFESSIONAL-EDITING.md)

| 设计任务 | 用户操作和断言 |
| --- | --- |
| 为响应式工作区安排导航与内容 | 在属性栏设置 240 px 导航列，拖动画布列把手增加 40 px，撤销恢复，再用 Shift 加方向键增加 10 px。第 1 行设为 80 px，把卡片指定到第 3 行第 2 列，再拖导航到第 2 行并撤销。375/390 宽时卡片 x=0，768/1024/1440 宽时 x=252，各宽度 y=164。检查了实际导出工程。 |
| 带桌面、平板和手机断点的控制台 | 画板基础 4 列，768 px 以内 2 列，480 px 以内 1 列，内边距依次为 24/16/8 px；内层工具栏按自身 300 px 断点调整。五档分别核对列数、内边距、两向间距及实际子层坐标。由窄变宽时发现 React 清理 CSS 长属性导致原有间距丢失，修复后按同一序列复测。 |
| 外层实例替换内层组件 | 将标识主件插入工具栏主件，公开替换属性。在使用方保留自定义标题，从外层切换标识，撤销、重做、保存重开。修改替换件主件后，已有外层实例跟随新版。独立工程直接传入另一个生成的 React 组件；另验证跨文件升级、锁定保护和复制。再把工具栏嵌入页头，让最外层公开其标题和标识，从页头实例修改并撤销重做。独立 React 使用页头的两个公开参数直接渲染三层结构。 |
| 将同一素材切换两种蒙版 | 选取位图与内容、应用蒙版、切换亮度、撤销并重做。四个采样点的灰度值在 alpha 模式为 0/0/127/255，在亮度模式为 0/255/191/255。画布、预览、刷新和独立工程均逐点检查。 |
| 交付可变字体和局部排版 | 从文件选择器导入 Roboto Flex，拖宽字形、关闭标准连字，对开头两个汉字设 3 px 局部字距与 wdth=72，其余使用 wdth=151。重新打开核对 Hug 尺寸，工程构建后确认实际加载嵌入字体并保留选区 CSS。 |
| 批量修改不同材质的图层 | 对两层渐变、不同描边和各自阴影执行批量操作。改变色相后两层透明度仍分别为 0.25 和 0.75，添加描边后宽度分别为 3 与 1，各自阴影保留。撤销核对原值。 |
| 复用组件、发布修订 | 在主件上公开文本与布尔属性。使用方改文案、隐藏图标、替换组件并撤销。源文件发布新修订，另一文件检查更新、逐件采用、处理变量冲突、撤销和离线打开。React 项目中直接传入公开属性检查独立组件。 |
| 从已有设计创建变体库 | 在通知徽标主件创建 Normal/Busy，再从 Busy 创建宽版，重命名第二条属性为「尺寸」。使用方的「待发送」覆盖保留，定位该变体主件将宽度从 220 改为 232 px，实例和预览同步。合并两个现有设计时，原主件和使用它的实例仍可编辑。导出的库在另一份空白文件直接插入宽版；独立工程以中文公开属性和 `variantProperties` 选择该变体并实际渲染。 |
| 多选实例批改 | 选择外观与开关值均不同的两个已安装实例，批量设为 Disabled，Light/On 与 Dark/Off 各自保留。一次撤销、重做、刷新后逐个读回。另对来自两个主件的实例合改同名公开文字和可见性，半选与 Mixed 正确，焦点路过空输入框保留两份文案。 |
| 从设计改版到可以继续开发的表单 | 实际导出含开发手写业务文件的工程、改版并二次导出。检查同一生成文件双方修改时可定位冲突。独立工程安装、编译、打开后提交非法邮箱不发请求；测试接口返回 422，修正邮箱再提交返回 201，界面显示成功。 |
| 使用键盘完成一次编辑 | 从 Tab 导航到新建文件，F6 进画布，按 F、Enter 建画板，再按 T、Enter 建文本，输入后提交、切到属性栏、返回、撤销、重做并重开。整个用例无鼠标操作。 |
| 在安装版使用组件库 | 从打包的 macOS 应用直接发布本机库，退出并重新启动后同一订阅地址仍返回相同修订。在另一空白文件中订阅并插入。另从原生打开文件事件分别打开 Aura 和移动工作室。 |

### 交付物与验收环境

[下载 Apple Silicon 安装包](../release/Forma-0.4.0-arm64.dmg) · [反馈表单改版源码](evidence/2026-11-20/v0.4.0/feedback-react.zip) · [三层组件源码](evidence/2026-11-20/v0.4.0/nested-components-react.zip) · [可编辑的通知徽标设计稿](evidence/2026-11-20/v0.4.0/notification-badges.forma.json) · [自制变体集源码](evidence/2026-11-20/v0.4.0/variant-library-react.zip) · [原始结果与 SHA-256](evidence/2026-11-20/v0.4.0/results.json)

在 macOS 27.2.1 arm64 上，生产构建和格式检查通过，121 项单元测试通过，0 项跳过。Chrome 158.0.8127.36 和 Playwright WebKit 27.2 各完成 38 组实际桌面界面流程。各引擎分别从自己下载的 26 个 React 源码 ZIP 安装依赖、运行 TypeScript 和生产构建、启动并操作成品。桌面安装版另在六个原生流程中复测，实际下载的专业编辑和自建变体两个工程也在独立目录构建、打开和操作，使用临时用户目录。上方链接中的三个源码 ZIP 也以其归档字节重新构建并操作；从安装版重新打开归档的通知徽标稿、定位宽版主件，将其改成 248 px，使用方同步更新并保留「待发送」文案。

从只读挂载的 DMG 启动已打包应用，在独立窗口打开 Aura 与移动工作室。应用通过 `codesign --verify --deep --strict`，磁盘映像校验和 ZIP 完整性通过。当前为本机 ad-hoc 签名。Firefox 在本机启动阶段失败，未计入通过引擎。

**画面核对。** 两套原生样例共 20 个画板、1,828 个图层，在每个引擎分别比较编辑画布、预览和独立工程的图层 ID、边框和可测文字换行。无缺层、多层、超过 1 CSS px 的几何差异或换行数差异。比较预览与工程的截图，RGB 通道差超过 16 的像素比例单幅最高为 Chrome 0.004%，WebKit 0%。在两个引擎中均逐一切换 44 类组件的全部 290 个变体，随后按类别插入并重开。

[完整桌面画布](evidence/2026-11-20/v0.4.0/desktop-editor.png) · [网格轨道](evidence/2026-11-20/v0.4.0/grid-tracks.png) · [字体属性](evidence/2026-11-20/v0.4.0/typography.png) · [实例属性](evidence/2026-11-20/v0.4.0/component-properties.png) · [自建变体](evidence/2026-11-20/v0.4.0/variant-authoring.png) · [库修订并排审阅](evidence/2026-11-20/v0.4.0/library-review.png)

### 大文件持续编辑

导入 8 张各 2048×2048 的 PNG。每轮逐张改裁切，对第一张撤销再重做；每四轮打开预览、逐张解码、刷新并检查保存的裁切值。两次计时用各自固定的生产包，0.4.0 候选包开始于 12:55，正式安装包对应的生产资源另行复跑短回归。完整文件摘要随原始结果保存。JS 堆按轮采样，两个长会话时间重叠，读数用于验证持续操作和恢复。

| 构建 | 实际持续时间 | 裁切次数 | 撤销/重做对数 | 预览并刷新次数 | 采样 JS 堆峰值 |
| --- | --- | ---: | ---: | ---: | ---: |
| 0.3.0 固定基线 | 2 小时 0 分 1 秒 | 5,504 | 688 | 172 | 102.9 MiB |
| 0.4.0 固定候选 | 2 小时 0 分 1 秒 | 5,504 | 688 | 172 | 102.9 MiB |
| 0.4.0 最终交付构建 | 0 小时 0 分 6 秒 | 96 | 12 | 3 | 96.5 MiB |

长会话完成后，在同机 Chrome 的 1460×960 生产窗口单独复跑平铺树与复杂画板。万层平铺导入 427 ms，挂载 35 行，拖动 216 ms。8,288 层、128 个画板和 4,160 个矢量的 6 次十二步拖动总时长中位数/P95 为 240/245 ms；帧间隔 P95 为 17 ms，最长 17 ms。该组数据的对照对象是 Forma 自身的固定输入。详细分位数、内存和采样口径在[原始记录](evidence/2026-11-20/v0.4.0/results.json)。

复测生产包可运行 `npm run test:browser`、`npm run test:exports`；切换浏览器时均设置 `BROWSER_ENGINE=webkit`。两小时位图会话使用 `FORMA_BITMAP_MINUTES=120 npm run test:browser -- bitmap-session`。真实打包应用使用 `node scripts/check-desktop-workflows.mjs`。

## 2026-11-20 · 0.3.0 历史验收

工作区没有 Git 元数据。接手时可复现的 Gemini 产出、无法按提交归属的更改，以及 0.2.1 修过的反馈，见下节「核对交接中的完成项」。本版继续用实际设计、改版及交付任务验收。全程模型网关留空。

| 设计师或开发的任务 | 实际操作和结果 |
| --- | --- |
| 找到深层图层并调整界面 | 在 Aura 搜索 Logo，选中、改名、撤销、检查渐变色标、进入预览并返回。1440×900、1024×480 的侧栏可拖动，键盘也可调整；721×600 收起图层栏后属性和导出仍可达。收栏、刷新后验证选区和宽度。[宽屏](evidence/2026-11-20/v0.3.0/editor-1440.png) · [短窗口](evidence/2026-11-20/v0.3.0/editor-1024.png) · [窄窗口](evidence/2026-11-20/v0.3.0/editor-721.png) |
| 同一张反馈表单适配手机和桌面 | 在属性栏设置固定行高、断点、窄间距、子层跨行与跨列，创建网格样式，绑定渐变色标，来回切父画板的明暗模式，撤销、重做并刷新。375/390 px 时卡片高 104 px，后一项 y=112；768/1024/1440 px 时为 108 和 120 px。预览和独立构建均验证。 |
| 把主件修订带给另一份文件 | 从源文件导出新版本，打开使用方，导入时审阅关联实例，应用后子层宽度由 64 变为 88，使用方改过的名称仍在。撤销、重做、关闭重开以及源文件隔离均核对。另从真实 0.2.1 安装包取原生移动稿，资源面板提示 79 个关联实例；从第 1 版升至第 2 版并刷新成功。修复了库升级时内部原型目标被误判为本地覆盖的问题，回归验证继承的目标跟随新版、主动改过的动作保留。 |
| 改设计后继续开发 | 文件菜单整稿导出，开发接入业务回调并新增文件。把设计卡片改为跨三列，选择含手改生成页的源码 ZIP，会提示该路径。再选仅有业务改动的 ZIP，下载新工程，独立安装构建，输入邮箱、点击提交均触发原有回调。导出后的渐变仍响应 CSS Token。另把移动库开关独立 import 到新业务页，两实例状态与回调分别工作。[实际反馈表单源码](evidence/2026-11-20/v0.3.0/feedback-react.zip) · [完整移动工作室工程](evidence/2026-11-20/v0.3.0/mobile-studio-react.zip) |
| 操作跨页原型 | 右栏可以定位另一页的目标画板，并返回连线来源。原生 macOS Safari 的独立私密窗口中，从 Aura 官网打开移动版、进入工作台、打开部署浮层、取消，焦点回到「新建部署按钮」，关闭预览后回到原稿。 |
| 图像与中英文编辑 | 在一个文件中解码 8 张各 2048×2048 的 JPEG，逐层做 96 次裁切修改、12 次撤销/重做、3 次预览和刷新，8 张每次均可解码。Chrome 组合输入接口经历 she → 设计 → 设计工具，提交后撤销恢复原文。该用例覆盖浏览器组合事件，系统输入法候选窗口仍需实机核验。 |
| 桌面使用 | 由当前源码重建 arm64 应用与 DMG，校验签名、映像及 ZIP。运行打包应用核对菜单版本，暖启动连续打开两份设计稿、冷启动由 macOS 同时打开两份，两窗口分别显示对应文件。 |

**画布、预览和成品的逐层对照。** 在同一浏览器、字体、DPR=1、画板原始宽高条件下，对两套样例的全部 20 个画板比较 1,828 层的 ID、位置、尺寸和可测文字行数。Chrome 与 WebKit 均无缺层、多层、超过 1 CSS px 的几何差异或行数差异。过程中修复了搜索框在预览中丢失原稿占位文本图层，以及圆角外露背景与独立工程不同的问题。逐画板截图比较中，RGB 任一通道相差超过 16 的像素，Chrome 单幅最多占 0.004%，WebKit 为 0%。该比例以每张画板面积为分母。独立工程还在 iPhone 13 触屏模拟环境中点按野径图志手机页、手记、分享浮层和返回。

**移动资源面板。** 从资源卡片进入每类组件的详情，用外观、尺寸、状态等选择器实际切换 290 个变体，核对预览的根宽高及可见子层数。每类选一个变体插入，刷新并下载文档，再按库、组件、变体 ID 检查 44 个实例。Chrome 与 WebKit 均通过。复测命令为 `node --import tsx scripts/check-mobile-variants.mjs`。这里核对的是自研库的操作和输出，Apple 套件外观的逐项设计评审另列。

**当前生产构建性能。** 1460×960、Chrome 158，万层平铺稿导入 410 ms，拖动 224 ms，树挂载 35 行。当前含主题绑定的 8,288 层野径图志稿导入 1,059 ms，6 次十二步拖动中位数 239 ms、P95 242 ms；84 个帧间隔的 P95 和最长均为 17 ms，采样 JS 堆 59 MiB。再取 0.2.1 安装包中的原稿，在当前构建同机重放，导入 1,058 ms，拖动中位数/P95 为 239/240 ms；0.2.1 当时同稿为 999 ms 和 240/245 ms。样本数量、堆口径与短时限制保持一致。

**与 Figma 的差距**及每项后续关闭条件见[按选区与任务的对照矩阵](specs/EDITOR-PARITY-PLAN.md)。高阶字体、位图 alpha/亮度蒙版、任意网格轨道与在线库订阅仍有差距。真实手机触控、两小时大图会话、真实模型生成质量以及同机同内容的 Figma 性能比较仍开放。Firefox 的本机运行器在导航前未能初始化 profile。原生 Safari 的证据限于上表的真实操作。

复测使用生产预览地址作为 `FORMA_URL`。依次运行 `npm test`、`npm run format:check`、`npm run build`、`npm run test:browser` 及 `npm run test:exports`；另运行 `node scripts/check-render-parity.mjs`、`npm run test:browser -- bitmap-session`。WebKit 设置 `BROWSER_ENGINE=webkit`。大场景性能单独在 Chrome 上测。[本版原始读数与环境](evidence/2026-11-20/v0.3.0/results.json)

## 2026-11-20 · 0.2.1 验收

**结论：手动设计、两套样例原型和独立工程的下列路径通过。** 首个产品里程碑仍部分通过。未关闭项按下一次能交付的设计师任务列入[能力对照与补齐计划](specs/EDITOR-PARITY-PLAN.md)。工作区无 Git 元数据，以下按接手时已有产物与复核后修复区分，无法逐提交认定作者。

### 核对交接中的完成项

| 接手时记录 | 复核与处置 |
| --- | --- |
| Tooltip、标准化图标和浮动工具栏 | 控件、冷/热时序和公共 TooltipHost 存在。窄窗口的右栏和顶栏导出处于屏外，另有图标依赖会临时移除的 title 作为可访问名称。修后短窗可操作，图层/资源、属性开关有稳定名称及展开态，画布外的 Tab 能移至下一控件。 |
| Aura 营销与 SaaS 样例、明暗主题 | 从原生 JSON 核对两页、4 个画板、253 层、13 个矢量、10 个变量、145 个直接绑定变量的图层、0 个实例。旧样例将演示性数字写成性能指标，且「下载 React 工程」无实际动作。随包样例改为实际计数及可点击的移动原型入口。已有用户保存的稿保留原内容。修复首次保存与重开后，主题可从本机文件恢复。 |
| 移动库复用与 Token | 文件有 16 个画板、1,575 层、495 个矢量和 85 个实例。按文件页面顺序，直接含节点变量绑定的图层数为 139 / 0 / 0 / 0。该口径不含库模板、样式和间接引用；后续主题验收需逐个检查常用组件。 |
| 增量渲染和万层优化 | 0.2.1 再跑平铺与复杂两组生产基准，读数见下表。历史资料的 17 ms 帧间隔 P95 只能描述其采样分位数。本轮增加最长帧间隔与超过 25 ms 的计数。 |
| Electron 与版本号 | 接手时已有 0.2.0 arm64 签名与安装包。系统连续打开文件存在窗口就绪及文件错配风险。0.2.1 按窗口接收，实际打包应用热启动时可分开两稿并保留原窗口，冷启动通过 macOS LaunchServices 同时打开两个文件也显示各自的名字。ad-hoc 深度签名、磁盘映像 CRC 和 ZIP 完整性通过。 |
| 可选 Agent 和工程导出 | 修复普通 UI 重绘会销毁配对会话的问题。无模型配置，选中画板后完成 stdio 读取、列组件、提案、人工应用和撤销。修正过期浏览器选择器，以及非 Chromium 引擎误读 Chromium ZIP 的验证路径。 |

### 从设计师入口复测

1. **找到图层并修改。** 在 721 px 宽的 Aura 文件，打开图层、选中标题、切到属性，修改后进入预览。修前同一窗口裁掉大部分属性栏及交付按钮；修后两侧互斥并保留选区。复杂树折叠保留选中节点的祖先路径。对照 [Aura 打开](evidence/2026-11-20/aura-open.png)、[修前选中文字](evidence/2026-11-20/aura-text-before.png)、[修后同一窗口](evidence/2026-11-20/aura-text-after.png)、[Figma 参考文件侧栏](evidence/2026-11-20/figma-sidebar.png)。截图记录界面修复时的样例，后续另校正了样例指标文案。
2. **同时选中两种颜色。** 文字与矩形分别带 40% 和 80% 透明度。点入 Mixed 的 HEX 后离开，颜色不变；只写 HEX 时两个透明度保留；只写透明度时不同色相保留，一次撤销恢复。命令搜索无匹配有反馈，禁用结果回车保持面板。见 [editing-workflow](../scripts/check-editing-workflow.browser.js)。
3. **将卡片横跨两列。** 在 320 px 三列网格里输入跨度 2，核对卡片宽 210 px、相邻元素 x=220、第三项 y=50。通过撤销、重做、自动保存、刷新、预览及独立构建再测一次。[独立工程断言](../scripts/verify-exports.mjs)
4. **交付真实样例。** Aura 切至 Cloud Light，经「本机文件」重开；从落地页去手机原型、跳到工作台，打开和关闭部署浮层再返回。下载完整项目并在独立工程中回放。移动研究室整文件导出的 16 个入口另逐个打开。[Aura 用户流程](../scripts/check-aura.browser.js)
5. **接收外部协助。** 从图层树选择画板，进入 AI 设计助手并配对，中途显隐侧栏，接收提案、点「应用到设计」、撤销，原图层名称恢复。全程仅使用本机提案服务。[MCP 用户流程](../scripts/check-mcp.browser.js)

### 本轮结果和环境

macOS 27.2.1、Apple Silicon、Node 25.8.0、npm 11.11.0。正式 Web 构建在本机预览，模型网关留空。111 项单测全部通过，Prettier、严格 TypeScript、Vite 和桌面打包通过。Vite 主 JS 约 1,060 kB（gzip 356 kB），仍有分块大小告警。Chrome 158 和 Playwright WebKit 27.2 各通过 27 个默认浏览器场景；两个引擎各自下载的 19 类工程分开解压、依赖安装、生产构建、启动后检查实际 DOM 或交互。依赖安装使用本机 npm 缓存。[场景名、原始性能值和桌面结果](evidence/2026-11-20/results.json)

| 生产构建 / 1460×960 | 导入 | 拖动 | 帧间隔 P95 / 最长 / >25 ms | 采样 JS 堆 |
| --- | ---: | ---: | ---: | ---: |
| 10,000 平铺图层，35 行树节点挂载 | 414 ms | 单次五步 223 ms | 此场景未采帧间隔 | 67 MiB |
| 259 层 / 4 画板，6 次十二步拖动 | 135 ms | 中位 240 / P95 241 ms | 17 / 17 ms / 0 次（84 个间隔） | 27 MiB |
| 8,288 层 / 128 画板，6 次十二步拖动 | 999 ms | 中位 240 / P95 245 ms | 17 / 17 ms / 0 次（85 个间隔） | 63 MiB |

另在 375、390、620、721、949、950、1024 px 的 Chrome 窗口打开 Aura，顶栏可见按钮均处于右边界内，页面没有横向溢出。重新安装 Playwright Firefox 159 后默认启动仍提示 `Could not find profile folder`，在导航前退出。原生 Safari WebDriver 因系统关闭「允许远程自动化」未能创建会话。两者均未计入通过数。

手势总耗时包含自动化移动与松手等待，并非单帧延迟。复杂场景堆值在该档手势后采集，平铺场景在导出后采集。长会话、高分辨率位图、真实手机触控、系统中文 IME、真实模型生成质量和同内容 Figma 性能对照仍开放。

## 0.2.0 及以前的历史验收


2026-11-19。手动编辑、原型与导出验收时，模型网关关闭。进入 Agent 页签、输入需求、切回画布的测试记录到 0 次模型服务请求。

| 验收范围 | 结果 |
| --- | --- |
| 领域、事务、组件、编译等自动化测试 | 110 项通过，TypeScript 与生产构建、Prettier 检查通过 |
| Chrome 158、Playwright WebKit 27.2 | 两个引擎各执行全部 25 组编辑器浏览器用例 |
| 工程交付 | 17 个从实际界面下载的项目分别在干净目录安装依赖、执行严格 TypeScript / Vite 构建，每个项目均在 Chrome 与 WebKit 中打开核对 |
| Firefox | 此机的 Playwright Firefox 159 在加载网页前退出，报告找不到 profile。已分别尝试系统临时目录、项目专用目录与显式持久化 profile，未取得操作结果 |

## 设计师工作流

| 从编辑器执行的操作 | 已核对的结果 | 复测脚本 |
| --- | --- | --- |
| 用钢笔绘制曲线、插入中点、移动锚点与控制柄、翻转、拖动旋转把手 | 支持开放/封闭路径和 15° 吸附。画布、预览和下载项目中的 SVG 路径与变换一致。撤销保留锚点 | `check-vector` |
| 同时选六个错位图层，智能整理并拖间距和中心把手 | 左栏层叠顺序保持，右侧可输入两轴间距。六项能形成两行三列，拖换位置、删除补位与撤销均经实际操作验证。旋转图层按变换后的边界对齐 | `check-smart-selection`、`tests/transforms.test.ts` |
| 从形状工具绘制七角星、六边形和直线 | 星形尖角数与内半径可调，多边形可改边数，Shift 拖直线吸附 45°。自由改锚点后撤销可以恢复参数，重新打开和独立工程保留路径 | `check-shapes` |
| 选择两个形状，切换四种布尔运算；编辑原始椭圆，拼合后撤销 | 四种运算生成四条不同的轮廓；编辑源图层可改变结果。独立 React 工程的最终轮廓与画布一致 | `check-booleans` |
| 下层形状用作矢量蒙版，修改源宽度，解除后从右键选中遮挡层 | 椭圆内外的命中结果分别为真与假。编辑源会更新预览的裁切轮廓；解除保留两层 | `check-mask` |
| 选中文字“设计”后加粗、下划线、改为 30px | 其余文字保持 18px、400 字重。Chrome 的画布和预览均为 152×42，WebKit 均为 151×42。选区字体族和字重也可单独修改。独立工程保留样式，可撤销回原稿 | `check-rich-text` |
| 从标尺拖出辅助线，按方向键调整、拖回标尺删除 | 按页存储，随视口平移/缩放，支持吸附、撤销和刷新恢复。预览不显示编辑辅助线 | `check-guides` |
| 置入或粘贴双色 SVG，将 PNG 拖入画布 | 路径保留填充与描边、填充规则、透明度、端点、拐角、坐标变换，并能编辑锚点。遇到未支持的 SVG 元素会整次拒绝 | `check-asset-import`、`check-images` |
| 改画板宽度，编辑 Fixed、Hug、Fill、最小/最大尺寸、换行和网格 | 水平 Wrap、独立行距、Grid 固定列/自动列、双轴约束和文字 Hug 接通几何、预览与导出。宽度 600 的三个填充项实际为 100/320/180；改成 720 后为 100/320/300 | `check-sizing`、`check-size-limits`、`check-wrap`、`check-responsive` |
| 从选区创建组件，导出组件库，在新文件导入并切换主题 | 图层树区分主件、实例与普通组。实例保护内部结构；可修改允许的内容和样式、重置或分离。库携带所引用的变量、别名与复用样式；导入实例的主题切换及刷新恢复通过 | `check-library-tokens`、`tests/component-masters.test.ts`、`tests/library-tokens.test.ts` |
| 右键、键盘进出子菜单、滚动长树和右侧属性面板 | 1280×650 和 1024×480 窗口的右键菜单边缘可见。图层树滚动 850px 时页签、搜索、画布坐标不变。右侧独立滚动，填充排序、混合、圆角和描边经刷新保留 | `check-editor-panels` |
| 全站图标入口、标准化热区与全局 Tooltip（2026-11-20） | 顶栏、侧栏、页面/图层、画布控制条、底部创作栏、资源库、右侧属性与弹窗全部图标入口统一接入 `TooltipHost`（见[编辑器功能入口与提示规格](specs/EDITOR-UI-CONTROLS.md)）。实测冷悬停 260ms、相邻热切换 62ms（无动画瞬切）、禁用态按钮（撤销）悬停可见、离开即时还原原生 `title`、`Esc` 立即收起，不遮挡邻近图标；`editor-panels`/`library-tokens`/`files`/`storage`/`studio`/`atlas`/`complex` 7 项回归全通过，8288 层拖拽维持 239 ms / 17 ms 帧间隔 P95 | Playwright 专项脚本、`npm run test:browser -- editor-panels library-tokens files storage studio atlas complex` |
| 产品版本号 `v0.2.0` 与 Electron 桌面客户端打包（2026-11-20） | 定义单一版本源 `v0.2.0` 并完成 macOS Apple Silicon 客户端打包（见[版本与桌面客户端规格](specs/VERSIONING-AND-DESKTOP.md)）。接入 `electron/after-sign.mjs` 钩子自动执行 ad-hoc 深度签名，修复无证书跳过签名导致的 `code has no resources` 损坏报错。产物 `release/Forma-0.2.0-arm64.dmg`（经 `hdiutil verify` 校验有效）、`release/Forma-0.2.0-arm64.zip` 及 `release/mac-arm64/Forma.app`（`app.asar` 2.5 MB、`CFBundleShortVersionString=0.2.0`、通过 `codesign --verify --deep --strict`、已注册 `.forma`/`.forma.json` 文件关联）。通过 Playwright Electron 启动实际打包产物 `Forma.app` 核验：`forma://app/` 安全上下文正常加载、`window.formaDesktop.version === "0.2.0"`、文件菜单展示 `Forma v0.2.0 · 桌面客户端`、IndexedDB 自动保存与内置样例读取成功、全局 Tooltip 正常显示、控制台 0 报错 | `npm run desktop:build`、`codesign --verify --deep --strict`、`hdiutil verify`、Playwright `_electron.launch` |
| 切换内、居中、外描边并调整父画板宽度 | 12 px 描边分别占用 12、6、0 px 内部空间。自由布局中的子层坐标保持一致；右侧约束随画板宽度变化正确移动 | `check-strokes` |
| 新建独立文件、搜索并来回切换；跨标签尝试写入旧版本 | 原稿和新稿分别保存。当前版本完成 IndexedDB 事务后才显示已保存。上一版本可恢复，陈旧标签不能覆盖已保存的新版本 | `check-files`、`check-storage` |
| 制作多个流程、点开浮层、切换条件、返回和重置 | 原型属性可直接编辑；画板导航、浮层、滚动、条件、多动作和变量在共享播放器中运行；已从独立 React 项目回放 | `check-prototype` |
| 在原型画布拖出连线、改变浮层目的地，键盘新增再撤销 | 跳转改成浮层保留目标，将浮层拖到另一张画板保留底部定位。编辑和播放同步，刷新后连线仍可继续编辑 | `check-wires` |
| 用五种视口宽度播放同一个响应式流程 | 宽度随视口的画板与右侧约束在 375、390、768、1024、1440 px 下生效。跳到固定 300 px 的画板再返回，会恢复原宽度 | `check-responsive-player` |
| 从不同页面连接画板，导出选区或整个文件 | 属性面板按页列出目标。Web 跳到移动页，再打开第三页浮层，能关闭、返回。整份研究室导出的项目按页加载，已从目录逐一打开 16 个独立画板入口 | `check-cross-page`、`check-atlas`、`test:exports` |

## 原生移动样例

本机服务的入口为 `/?example=mobile-studio&edition=atlas&page=atlas&node=atlas-tablet-root`。样例有独立存储空间。以下计数只包含实际插入的图层。

| 页面 | 画板 | 图层 | 矢量图层 | 组件实例 |
| --- | ---: | ---: | ---: | ---: |
| iPad 工作空间与分享流程 | 6 | 452 | 125 | 1 |
| iPhone 发现与设置 | 4 | 242 | 52 | 38 |
| Soundspace 音乐工作台 | 2 | 622 | 188 | 40 |
| Field Atlas 野径图志 | 4 | 259 | 130 | 6 |
| 合计 | 16 | 1575 | 495 | 85 |

野径图志包含可编辑地形等高线与海拔剖面、三种变体的站点实例、平板与手机流程、手记详情及分享浮层。入口可以直接定位画板。

分栏导航、分享浮层和长按菜单参照用户指定套件中的可见画板，自研几何、文案、图标与材质。其余画板用于验证变体、复用和复杂组合。官方套件逐变体比对与平台专有材质仍有差距。

## 大文件实测

使用同机 Chrome、1460×960 视口的生产构建。每档导入一个合成文件，滚动到底并选择最末图层，缩放、拖动、下载原生文件和 React 工程。每个数字为一次端到端采样，包含自动化开销。拖动包含五步移动、松手提交与两帧等待。JS 堆在该档导出后采集；浏览器渲染和 GPU 内存另计。

| 图层数 | 导入 ms | 选择 ms | 挂载树行数 | 缩放 ms | 拖动 ms | 原生下载 ms | React 下载 ms | JS 堆 MiB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 57 | 106 | 100 | 54 | 128 | 32 | 52 | 16 |
| 1000 | 70 | 61 | 30 | 57 | 127 | 32 | 53 | 19 |
| 10000 | 374 | 84 | 30 | 64 | 243 | 64 | 228 | 68 |

相同五步拖动在开发构建中修复前为 5755ms，修复后为 578ms。这组样例主要是单层级矩形。早期与 Figma 的局部采样使用不同文件，不能据此认定整体性能相当。历史条件见[移动研究室采样](STUDIO-AUDIT.md)。

### 复杂页面上的连续拖动

在同一台 Apple Silicon Mac（macOS 27.2.1、Chrome 158、1460×960）上，将野径图志的原生图层复制到同页，保留曲线、文字、主件引用、变体与交互。通过图层树选真实组件实例，每档往返执行 6 次十二步拖动，取整个手势耗时和手势期间的 requestAnimationFrame 间隔。两档在同一浏览器上下文顺序运行。

| 图层 / 画板 / 矢量 / 实例 | 导入 ms | 拖动中位数 / P95 ms | 帧间隔中位数 / P95 ms | 采集帧间隔数 | JS 堆 MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 259 / 4 / 130 / 6 | 117 | 241 / 247 | 17 / 17 | 84 | 25 |
| 8288 / 128 / 4160 / 192 | 983 | 241 / 249 | 17 / 17 | 85 | 61 |

同一 8288 层场景的连续拖动优化前后对比（同机 Apple Silicon Mac、Chrome 158、1460×960 生产构建）：
- 早期基线：拖动中位数 600 ms，帧间隔 P95 250 ms。
- 接手前基线（同机重测）：拖动中位数 415 ms / P95 449 ms，帧间隔 P95 33 ms，JS 堆 135 MiB（历史记录 398 ms / 206 MiB）。
- 本次引擎优化后（增量 `SceneIndex` 与 `OverlayRectMap` 几何缓存、增量 `sceneTransforms`、缓存拖拽上下文与二分查找吸附索引、离屏根画板视口裁剪、移除 `:has()` 悬停选择器、`LayersPanel`/`PagesPanel` 记忆化及大图防抖保存）：拖动中位数降至 **241 ms**（与 259 层单页基线持平）、P95 降至 **249 ms**，手势期间帧间隔中位数/P95 均锁定 **17 / 17 ms**，JS 堆降至 **61 MiB**。
- 622 层 Soundspace 坐标连续提交延迟（`check-studio`）：由 61–77 ms 降至 26–54 ms（稳态 26–28 ms）。
- 万层平铺矩形（`bench-layer-tree`）：导入 387 ms，拖动 208 ms（基线 241 ms），JS 堆 63 MiB。连续数小时长会话、大量高分辨率位图及同文件 Figma 对照仍待补测。

## SaaS 产品与营销界面综合样例（Aura Studio）

新增自研双页多主题设计文件 `public/examples/aura-showcase.forma.json`（生成器 `scripts/build-aura-showcase.ts`，入口 `/?example=aura-showcase`），用于验证工具构建真实营销官网与复杂 SaaS 数据工作台的能力：

| 页面 | 画板 | 图层 | 矢量图层 | 变量绑定图层 |
| --- | ---: | ---: | ---: | ---: |
| 01 营销官网 · Marketing Landing | 2（1440 Desktop + 390 H5） | 125 | 2 | 77 |
| 02 产品工作台 · SaaS Analytics | 2（1440 Dashboard + 440 弹窗浮层） | 128 | 11 | 68 |
| 合计 | 4 | 253 | 13 | 145 |

覆盖双模式语义变量（Obsidian Dark / Cloud Light）、玻璃拟态导航、多序列矢量面积/折线图、Bento 网格、3 档 SaaS 定价卡、交互控件（输入框与开关）及跨页导航与浮层原型。

## 复测

安装依赖，启动开发服务。浏览器脚本默认使用本机 Chrome，各用例在独立浏览器上下文中运行。可用 `FORMA_URL` 指向生产构建，用 `BROWSER_ENGINE=webkit` 或 `firefox` 选择已安装的 Playwright 引擎；Chromium 可用 `BROWSER_CHANNEL` 指定渠道。

```sh
npm ci
npm run dev
# 在另一终端
npm test
npm run build
npm run format:check
npm run test:browser
npm run test:browser -- layer-tree complex
npm run test:exports
```

## 0.2.0 记录当时的未决事项

当前状态见文首 0.3.0 记录。

- 手动编辑仍缺高级矢量网络、位图透明度/亮度蒙版、OpenType 特性与字体文件管理。
- 布局仍缺断点专属变体、任意网格跨列/跨行和复杂混排规则。系统级中文 IME、真机触屏、Safari App 和 Firefox 的实际操作尚待核验。
- 本机组件与样式可复用。跨文件共享库发布订阅、版本冲突处理、完整团队权限与实时协作尚待实现。
- 跨页原型可在右侧面板按页选择目标。同页支持画布拖拽连线。跨页同时浏览与拖线、设计改版后自动合并业务代码尚待实现。
