# 编辑器功能入口、图标按钮与悬停提示规格

- **最近更新**：2026-11-27
- **状态**：已实施并验收
- **核心实现**：[TooltipHost.tsx](../../src/editor/TooltipHost.tsx)、[ui3-theme.css](../../src/editor/ui3-theme.css)、[canvas-feel.css](../../src/editor/canvas-feel.css)、[Inspector.tsx](../../src/editor/Inspector.tsx)、[Canvas.tsx](../../src/editor/Canvas.tsx)及各编辑器区域组件
- **关联验收**：[编辑器验收记录](../EDITOR-ACCEPTANCE.md)

---

## 0.16.0 画布一线手感直操与百屏小地图入口

- **宽域缩放与视图菜单**：缩放范围扩展为 `2%–6400%`（`MIN_ZOOM = 0.02`，`MAX_ZOOM = 64`）；[ViewOptionsMenu.tsx](../../src/editor/ViewOptionsMenu.tsx) 顶部首项新增「画布小地图（`⇧M`）」复选项，支持方向键/Home/End/Esc 导航。
- **画布顶栏小地图开关与右下角浮窗**：[Canvas.tsx](../../src/editor/Canvas.tsx) 画布顶栏末尾新增「画布小地图」图标按钮（`aria-label="画布小地图"`、`aria-pressed`、`data-tip="画布小地图"`、`data-tip-kbd="⇧M"`、`data-tip-desc="在右下角显示百屏缩略导航图，支持点击与拖拽快速定位"`、`data-tip-side="bottom"`）。常规 1–5 屏与短视口（画布可视尺寸 `< 1080×540`）默认折叠；单页根画板 `>= 6` 且画布可视尺寸 `>= 1080×540` 时自动展开，用户手动切换后尊重偏好。展开后的 [CanvasMinimap.tsx](../../src/editor/CanvasMinimap.tsx) 位于画布右下角（短窗口自动上移避让底部工具栏），支持点击瞬移、拖蓝色视口框零跳变平移、双击或按 `0`/`Enter` 适应全部、方向键（`Shift` 加速）键盘平移及 `Esc` 失焦。
- **画布圆角与自动布局粉色直操手柄**：
  - [CornerRadiusHandles.tsx](../../src/editor/CornerRadiusHandles.tsx)：单选可编辑 `rectangle`/`frame`/`button`（未锁定、非组件实例、非外部提案预览、屏幕尺寸 `>= 56×56 px`）时在四角内侧展示圆角圆点，可访问名称使用 `画布左上圆角手柄` / `画布右上圆角手柄` / `画布右下圆角手柄` / `画布左下圆角手柄`（避免与右栏属性输入框 `左上圆角` 重名冲突），直接拖拽同步调整四角，`Option/Alt` 单角独立调整，`Shift` 对齐 4px 步进，方向键微调，`Esc` 取消，松手单步原子提交并显示实时圆角胶囊；
  - [AutoLayoutHandles.tsx](../../src/editor/AutoLayoutHandles.tsx)：单选可编辑 `row`/`column` 自动布局容器（未锁定、非组件实例、非外部提案预览）时在四边内边距与相邻子项间隙显示粉色斜纹带与手柄（`#FF4D8D`），可访问名称为 `画布上内边距手柄` / `画布右内边距手柄` / `画布下内边距手柄` / `画布左内边距手柄` 与 `画布子项间距手柄 N`，支持向内拖调单边内边距、`Option/Alt` 对称调节、`Option+Shift` 四边同步、`Shift` 4px 步进、方向键微调与 `Esc` 取消；`justifyContent === "space-between"` 自动隐藏间距手柄；所有手柄样式位于 `@layer panels`（[canvas-feel.css](../../src/editor/canvas-feel.css)，0 `!important`，双主题可读对比度 ≥ 4.5:1）。

## 0.8.3 多层描边

无描边时，右栏「添加描边」将线宽设为 1 px；混选时只对缺少描边的图层生效。单选已有描边时，同一位置显示「添加描边层」。面板按顶层在前的顺序列出颜色和透明度，可用行内图标调整次序、显隐或删除。展开该漆可选择混合模式、颜色变量与透明度变量。达到 16 层后禁用添加；多选都有描边时同样禁用。复验用例为 `mixed-materials`、`strokes` 和 `stroke-paints`。[描边数据与绘制](DESIGN-FILE-IMPORT.md#figma-多重描边)

## 文件菜单版本日志

文件菜单底部的版本号整行可点击，右侧显示「版本日志」。展开菜单后按 End 可定位，按 Enter 或空格打开。标题旁显示当前运行版本。列表按公开版本倒排，每项列出版本号、YYYY-MM-DD 日期和更新内容。普通补丁的用户可见变化并入下一次重要更新。弹窗标题和关闭按钮固定，Tab 可进入正文，用方向键或 End 浏览历史。点击关闭、点遮罩或按 Esc 均回到文件菜单按钮，保留之前的页面和图层选区。短窗口中的文件菜单和日志正文各自滚动。[面板实现](../../src/editor/ReleaseNotesDialog.tsx) · [日志维护约定](VERSIONING-AND-DESKTOP.md#4-文件菜单里的版本日志)

## 0.8.0 原生设计稿

文件菜单「打开设计文件…」、顶栏「导入设计文件」、本机文件管理器和画布单文件拖放可打开 Sketch 与 Figma 原稿。预检时可按 Esc 取消；保存时关闭和重复提交禁用。已导入的文件在文件菜单显示「查看导入报告…」。[交互与技术边界](DESIGN-FILE-IMPORT.md)

## 0.7.1 界面去噪、右栏 Figma UI3 单屏密度与任意图层 AI 快捷入口

为对齐 Figma UI3 的低噪视觉密度并补齐右侧上下文 AI 入口，对顶栏、画布条、左栏与右栏完成以下收口：

| 区域 | 控件与交互规格 |
| --- | --- |
| 顶栏与画布条 | 顶栏面板开关（`图层与资源面板`/`属性面板`）展开态改用中性低噪图标（不再常驻高亮蓝底）；画布顶部条收紧至 `28 px`，移除与顶栏重复的「设计规范校验」按钮，将「智能吸附对齐」改用轻量磁铁图标按钮（`aria-label="智能吸附对齐"`、`aria-pressed`）。 |
| 左侧图层面板 | 常驻搜索框内嵌类型筛选图标按钮（`aria-label="筛选图层类型"`）；闲置画布隐藏「全部 / 画板 / 文本 / 组件 / 矢量」五枚胶囊，仅在点击筛选图标、激活筛选或输入关键词时展开。 |
| 右侧任意图层 AI 入口 | 选中**任意图层或多选**时，右栏对象标题行（`.object-heading`）固定展示紫色轻胶囊按钮 `✦ AI`（`aria-label="用 AI 生成或编辑选中图层"`、`data-tip-kbd="⌘↵"`）；空选区时在 `.inspector-tabs` 右侧展示 `✦ AI`（`aria-label="用 AI 对话生成新画板"`）。点击立即唤起并聚焦画布悬浮对话条 [CanvasAgentBar.tsx](../../src/editor/CanvasAgentBar.tsx)，自动锁定当前选区并按图层类型（空白画板 / 已有内容画板 / 文本 / 按钮与形状 / 多选 / 画布）切换推荐提示词。 |
| 右侧属性面板单屏降噪 | ①「布局」将自动布局流向置顶于 W/H 之上，纯自由根画板隐藏无意义的 `Fixed/Hug/Fill` 下拉行，「裁剪内容」与「跟随视口宽度」并排同行，「尺寸范围」与「容器断点」合并为单行静音折叠条；②「外观」将「混合模式」收进标题行幽灵下拉（`.header-ghost-select`）；③「填充」将「填充类型」、样式库四点图标 `⊞`（[TokenBinding.tsx](../../src/editor/TokenBinding.tsx) `placement="header"`）与「选择图像」触发图标收进标题行，无图时隐藏独立「图像填充」区块；④「描边」「布局参考网格」空态收拢为单行 `Title +` 并按 Figma 顺序将「布局参考网格」置于「效果」之下；⑤ 移除右栏底部与顶栏重复的「设计规范校验」按钮，将「导出」的预览与批量导出收为标题行图标。 |

## 0.6.4 位图与原型输入

右栏「图像填充」的选图、裁切、移除与调色重置按钮均提供 `aria-label` 和悬停提示。裁切模式使用三等分网格和一个缩放把手；两种倍率、焦点、键盘及锁定行为见[位图填充与裁切](PROFESSIONAL-EDITING.md#位图填充与裁切)。

在播放器中，鼠标进入悬停图层触发 `hover`；手指轻点其中的按钮只触发该按钮声明的点击操作。浮层内 Tab 和 Shift+Tab 循环，Esc 关闭当前层。返回上一层时尽可能聚焦实际打开它的子控件，例如步进器的「增加」；原控件已禁用时回到同层可用控件或画板。已在 390 px 独立 H5 工程检查触摸与键盘入口。[播放器](../../src/runtime/PrototypePlayer.tsx) · [验收](../EDITOR-ACCEPTANCE.md#064-位图编辑与原型输入)

## 0.6.3 属性栏的布局控件

| 控件 | 排列和交互 |
| --- | --- |
| 容器对齐与间距 | 在横排、纵排或网格容器中，九点对齐位于左侧，间距位于右侧。矩阵与内边距区域垂直分开。横排及纵排的 24 px 两端分布按钮与 26 px 间距输入垂直居中，图标方向随主轴变化。网格与换行分别给出列距和行距。 |
| 内边距 | 单值输入或四边输入与独立内边距按钮共享一行起点。展开后左、上为第一行，右、下为第二行。输入可用全名访问；从下边距按 Tab 到开关。多选值不同时显示 Mixed，编辑一边仅更新所选容器的这一边。锁定图层和受保护实例的布局按钮禁用。 |
| 恢复统一值 | 合并相同的四边时保留该值。四边不等时恢复该图层保存的统一值。已绑定的统一内边距恢复变量。一次切换可整体撤销。 |
| 尺寸范围 | 尺寸范围与容器断点共用折叠指示。四项最小、最大尺寸沿用主题输入框，可在窄面板继续输入和绑定变量。 |

同一 Aura 根画板分别在 256、292、400 px 的属性栏和 721×480 短窗口运行 `inspector-layout`，检查九点与间距位置、边距两行、横向滚动、锁定和重开。关联实现为 [Inspector.tsx](../../src/editor/Inspector.tsx)、[SizeLimits.tsx](../../src/editor/SizeLimits.tsx) 和 [design-system.css](../../src/editor/design-system.css)。[实测记录与界面](../EDITOR-ACCEPTANCE.md#063-属性栏布局)

## 0.6.2 工作区与控件

| 场景 | 操作、状态与验收方法 |
| --- | --- |
| 常驻导航 | 950 px 起在左栏使用 48 px 纵向导航，1151 px 起左栏默认总宽 296 px，可拖动调宽。949 px 及以下使用横向页签，收起时 ⌥1 / ⌥2 同时展开和切换。点助手、输入草稿、切图层再返回，文本应保留。 |
| 文件与命令 | 文件菜单支持 ↑/↓、Home/End 与 Esc。列表和网格的改名输入均可用 Enter 提交、Esc 取消。命令搜索为 combobox/listbox，输入保持焦点，用 `aria-activedescendant` 标记当前可用项。按类别显示结果，空查询单列最近 5 种操作。 |
| 预设与页面 | 空选区时展示页面背景、变量及样式，按 F 显示画板预设。拖页面到目标上半部插在其前，下半部插在其后；横线与结果一致。画布上从资源卡直接拖入，两张不同卡应分别生成实例。 |
| 属性值 | Mixed 数字为空时 ↑/↓ 保留各层数值；尺寸范围和混合文本未编辑就失焦应保持原文档。锁定对象禁止修改绑定、圆角、视口和文字。六位 HEX 保留既有透明度，八位 HEX 识别末尾透明度，显式 rgba 同时提交两通道。拖动色板或滑块，松开才提交历史。 |
| 变量与样式 | 变量窗口使用 `aria-modal="false"`，宽高上限为 900×560，按可用视口分别留 24 和 36 px。拖动标题栏不会令窗口越界。窗口有焦点时 Esc 关闭，画布有焦点时保留画布工具键。颜色样式可编辑基础渐变与最多 16 层叠加填充；效果样式最多 8 个阴影。 |
| 原型与交付 | 点击原型端点打开目标选择，移动距离达到 3 CSS px 才按拖接处理。选中曲线的点击热区宽 12 px，可选目标或断开；从背景曲线点击先选源图层。播放器支持 Fit、100%、适应宽度。SVG 导出倍率同时改变实际宽高并保留 viewBox。代码窗口的标签用 ←/→、Home/End 切换，下载与复制跟随当前文件。 |

复验入口为 `panel-parity`、`panel-gestures`、`panel-data-safety`、`mixed-materials`、`wires`。共享样式、编辑器区域及交付差异逐项见[50 个编号](EDITOR-PANEL-ACCEPTANCE.md)。

**0.4.0 入口补充**　网格轨道与画布把手、位图蒙版类型、文件字体和选区字体、实例属性、主件添加变体、多选组合为变体集、发布与在线库订阅、⌥⌘K 创建组件与 F6 焦点顺序见[专业编辑与组件库发布](PROFESSIONAL-EDITING.md)。

## 一、目标与边界

为解决图标型入口缺乏即时说明、浏览器原生 `title` 延迟长且风格割裂的问题，Forma 统一建立覆盖全产品的图标按钮视觉体系与全局悬停提示（Tooltip）系统，交互参照 Figma 桌面端专业创作工具习惯：

- **已实现**：全局单实例 Portal 悬停提示、三层信息结构（标题 + 快捷键键帽 + 简明说明）、冷/热分组时序、四向自动翻转与边缘防裁切、禁用态按钮悬停解释、键盘 `:focus-visible` 触发、原生 `title` 自动升格与暂存还原、画布手势期间零查询旁路、全产品 7 大区域图标入口标准化。
- **当前边界**：不覆盖移动端触摸长按提示（桌面创作优先，`pointerType === "touch"` 直接跳过）；快捷键键帽当前以 macOS 符号（`⌘` / `⇧` / `⌥`）展示，Windows/Linux 平台按按键名自适应映射尚未独立切换。

---

0.5.0 在右栏「容器断点」中复用填充颜色选择器，色值右侧为恢复继承，断点标题右侧为移除该区间；主组件右栏的公开属性名称支持直接编辑。[控件取值与提交规则](PROFESSIONAL-EDITING.md)

## 二、全局悬停提示（Tooltip）行为规格

全局仅在根布局 [App.tsx](../../src/editor/App.tsx) 挂载一个 `<TooltipHost />`，通过文档级事件捕获代理所有控件，避免每个按钮重复维护浮层状态。

### 1. 信息层级

提示浮层（`role="tooltip"`，`.forma-tooltip`）由至多三部分组成：

1. **标题（`.forma-tooltip-label`）**：必填，2–10 字明确动词短语（如「钢笔矢量工具」「载入移动设计样例」）。
2. **快捷键键帽（`.forma-tooltip-kbd`）**：选填，右对齐等宽胶囊标签（如 `⌘K`、`⇧⌘Z`、`Esc`）。
3. **补充说明（`.forma-tooltip-desc`）**：选填，一句话说明作用、触发方式或**禁用态前置条件**（如「请同时选中至少 3 个图层」「请先拖选一段文字」）。

### 2. 触发、热切换与收起时序

| 参数 / 事件 | 规格值 | 说明 |
| --- | --- | --- |
| 冷启动延迟（`COLD_DELAY_MS`） | `260 ms` | 鼠标首次移入图标按钮后等待 260 ms 展示，防止划过时闪烁 |
| 热切换窗口（`WARM_WINDOW_MS`） | `500 ms` | 上一个提示关闭后 500 ms 内移入相邻图标时，**`0 ms` 瞬时展示**并附带 `.warm` 跳过入场动画 |
| 键盘聚焦（`focusin` + `:focus-visible`） | `0 ms`（瞬时） | 仅键盘导航聚焦时立即展示，避免鼠标点击获焦残留 |
| 立即收起条件 | `pointerdown` / `scroll` / `wheel` / `Escape` / `focusout` / `window.blur` | 点击操作、滚轮缩放、页面滚动或按 `Esc` 立刻隐藏 |
| 忽略条件 | `ev.buttons !== 0` 或 `ev.pointerType === "touch"` | 拖拽按压中或触屏交互不弹出 |

### 3. 定位、自动翻转与边缘防裁切

| 参数 | 规格值 | 行为 |
| --- | --- | --- |
| 锚点间距（`GAP`） | `9 px` | 浮层与触发控件边缘之间的距离 |
| 视口安全边距（`VIEWPORT_PAD`） | `8 px` | 浮层四周距视口边界至少留白 `8 px` |
| 箭头对齐约束 | `[10px, boxSize - 10px]` | `7×7px` 旋转 45° 指针箭头通过 `--tip-arrow-x` / `--tip-arrow-y` 精确指向锚点中心 |
| 默认方向推导（`inferSide`） | 显式 `data-tip-side` 优先；否则 `header` / `.canvas-top` / `.panel-tabs` / `.ds-header` / `.vector-tools` 默认 `bottom`；`.toolbar` / `.right-panel` 及其他默认 `top` | 顶部区向下、底部区向上；相邻横向按钮优先选择垂直方向（`bottom` / `top`）避免遮挡邻居图标 |
| 自动翻转 | 目标方向剩余空间 `< boxSize + GAP` 且对侧空间更大时自动翻转 | `top ↔ bottom`、`left ↔ right` |

### 4. 禁用态、性能隔离与 `title` 兼容契约

- **禁用态按钮支持**：Chromium 不会对 `<button disabled>` 派发 `pointerover`，`TooltipHost` 在非 `.editor-canvas` 区域内通过 `pointermove` 命中测试 `button:disabled[data-tip], button:disabled[title]`，使禁用按钮同样可提示原因与快捷键。
- **画布零开销旁路**：当画布处于交互态（`.editor-canvas.is-interacting`）时直接跳过目标查询；`pointermove` 命中扫描亦完全跳过 `.editor-canvas` 子树，实际帧间隔按版本在编辑器验收记录中采样。
- **原生 `title` 暂存与还原契约**：
  - 控件仍保留原生 `title`（及 `aria-label`）以兼容屏幕阅读器与既有 Playwright `getByTitle` / `[title=...]` 用例；
  - 鼠标悬停激活时，将 `title` 暂存至 `data-stashed-title` 并移除 `title`，阻止浏览器弹出延迟原生气泡；
  - 鼠标移出、按下、失焦或组件卸载时立即还原 `title`；
  - 未显式声明 `data-tip` 但带有 `title` 的普通控件自动降级读取 `title` 并以统一 `.forma-tooltip` 渲染。

---

## 三、DOM 数据属性协议

新增或改造任何图标入口时，按以下属性约定编写：

| 属性 | 必填 | 用途与约定 |
| --- | --- | --- |
| `aria-label` | 必填 | 无障碍可访问名称，简洁唯一，不随临时装饰变化 |
| `title` | 推荐保留 | 与历史测试/辅助技术兼容；静态短标签（不放冗长段落） |
| `data-tip` | 图标按钮必填 | Tooltip 主标题；支持随状态动态切换（如「隐藏图层」/「显示图层」） |
| `data-tip-kbd` | 有快捷键时必填 | 快捷键键帽文本（如 `⌘Z`、`⇧⌘Z`、`⇧R`、`V`、`Esc`） |
| `data-tip-desc` | 高频/非直觉入口推荐 | 一句话功能说明或禁用态前提说明（建议 ≤ 36 个汉字） |
| `data-tip-side` | 推荐显式指定 | `top` / `bottom` / `left` / `right`，避免依赖兜底推导造成遮挡相邻图标 |

示例：

```tsx
<button
  className="icon-btn"
  title="命令面板 ⌘K"
  aria-label="操作"
  data-tip="命令面板"
  data-tip-kbd="⌘K"
  data-tip-desc="搜索并快速执行编组、对齐、图层和视图命令"
  data-tip-side="bottom"
>
  <Command size={15} />
</button>
```

---

## 四、图标按钮、分隔线与 Tooltip 视觉规范

所有样式集中定义在 [design-system.css](../../src/editor/design-system.css)：

### 1. 图标按钮与工具栏控件

| 类名 | 尺寸 | 圆角 | 默认色 | 悬停态（`:hover:not(:disabled)`） | 激活态（`.active` / `[aria-pressed="true"]` / `.selected-tool`） | 适用区域 |
| --- | --- | --- | --- | --- | --- | --- |
| `.icon-btn` | `28 × 28 px` | `6 px` | `#464855` | 背景 `#f0eff6`，文字 `#1f2029` | 背景 `#ede9ff`，文字 `#6750df` | 顶栏、画布顶部控制条 |
| `.icon-btn.icon-btn-sm` | `24 × 24 px` | `5 px` | `#464855` | 背景 `#f0eff6`，文字 `#1f2029` | 背景 `#ede9ff`，文字 `#6750df` | 侧栏标题、页面栏、图层行、检视器小节头、弹窗标题栏 |
| `.toolbar .tool-btn` | `34 × 34 px` | `8 px` | `#3a3c49` | 背景 `#f1f0f7`，文字 `#1d1e27` | 背景 `#ede9ff`，文字 `#6951e2` | 底部悬浮主创作工具栏 |
| `.toolbar .shape-disclosure` | `16 × 34 px` | `6 px` | `#6b6d7c` | 背景 `#f1f0f7`，文字 `#1d1e27` | — | 底部形状组合按钮下拉触发器 |
| `.zoom-readout` | `min-width 42 px × 26 px` | `5 px` | `#464855` | 等宽数字 `tabular-nums`，`11 px` | — | 画布顶部缩放百分比读数 |
| `.header-export-btn` | `height 30 px`，`padding 0 11px` | `7 px` | 主按钮紫 | — | — | 顶栏主交付操作「导出」 |
| `.toolbar-sep` | `1 × 16 px`（底部栏 `1 × 20 px`） | — | `#e6e6ee` | 不可交互（`aria-hidden="true"`） | — | 同条工具栏内按功能分组隔离 |

过渡动画统一：`background-color 110ms ease, color 110ms ease`。

### 2. Tooltip 浮层样式（`.forma-tooltip`）

- **层级与宽度**：`position: fixed; z-index: 9999; pointer-events: none; max-width: 248px; padding: 6px 9px; border-radius: 7px;`
- **表面与阴影**：背景 `#1b1d26`、文字 `#f6f7fb`、描边 `1px solid #ffffff1c`、阴影 `0 10px 28px #0a0c1448, 0 2px 6px #0a0c1428`。
- **排版**：
  - 标题 `.forma-tooltip-label`：`11.5px`、`font-weight: 500`、`#ffffff`、单行不换行；
  - 键帽 `.forma-tooltip-kbd`：`10px`、等宽字体、`padding: 1px 5px`、`border-radius: 4px`、背景 `#ffffff1f`、文字 `#e2e6f3`、描边 `1px solid #ffffff18`；
  - 说明 `.forma-tooltip-desc`：`margin-top: 3px`、`10.5px`、`line-height: 1.45`、`#a6aec4`、自动换行。
- **动效**：冷启动 `forma-tip-in 100ms cubic-bezier(0.2, 0.8, 0.2, 1)`（由 `opacity: 0; translateY(2px) scale(0.98)` 过渡至静止）；热切换（`.warm`）无动画。

---

## 五、全产品功能入口完整台账

以下 7 大区域清单与源码属性一一对应，作为全站入口基线。

### 1. 顶部全局栏 — [App.tsx](../../src/editor/App.tsx)

顶栏文件名区域新增「图层与资源面板」「属性面板」，带 `aria-expanded` 和 `aria-controls`。顶栏右侧按钮采用 `.toolbar-sep` 分为三组：`[新建 | 命令面板 | 变量与样式]` · `[下载源文件 | 查看代码 | 原型预览]` · `[快捷键指南 | 导出]`。

| 控件 | 样式类 | 弹出方向 | `data-tip` | `data-tip-kbd` | `data-tip-desc` |
| --- | --- | --- | --- | --- | --- |
| Forma 品牌菜单 | 品牌按钮 | `bottom` | 文件与项目菜单 | — | 打开本地文件、切换内置样例、整文件导出与版本恢复 |
| 保存状态指示器 | 状态徽标 | `bottom` | 已保存到此浏览器 / 正在保存… | — | 变更自动持久化到本地 IndexedDB，换设备前可下载源文件 |
| 变量与样式 | `.icon-btn` | `bottom` | 变量与样式 | — | 管理颜色/数值/文本变量集合、多模式主题与复用样式 |
| 快捷键指南 | `.icon-btn` | `bottom` | 快捷键指南 | `?` | 查看画布导航、选择、编辑与绘图快捷键 |
| 新建空白文件 | `.icon-btn` | `bottom` | 新建空白文件 | — | 在独立存储空间创建一份新的空白设计文件 |
| 命令面板 | `.icon-btn` | `bottom` | 命令面板 | `⌘K` | 搜索并快速执行编组、对齐、图层和视图命令 |
| 下载设计源文件 | `.icon-btn` | `bottom` | 下载设计源文件 | — | 保存可继续编辑的 design.forma.json 本地文件 |
| 查看 React 代码 | `.icon-btn` | `bottom` | 查看 React 代码 | — | 预览当前画板的 React + TypeScript 源码 |
| 原型交互预览 | `.icon-btn` | `bottom` | 原型交互预览 | — | 在播放器中测试跨页跳转、浮层与响应式视口 |
| 导出独立工程 | `.header-export-btn` | `bottom` | 导出独立 React 工程 | — | 打包选中画板与原型依赖为可直接构建的 Vite + TS ZIP |

### 2. 左侧边栏、页面与图层树 — [App.tsx](../../src/editor/App.tsx)、[PagesPanel.tsx](../../src/editor/PagesPanel.tsx)、[LayersPanel.tsx](../../src/editor/LayersPanel.tsx)

| 控件 | 源码 | 弹出方向 | `data-tip` | `data-tip-kbd` | `data-tip-desc` |
| --- | --- | --- | --- | --- | --- |
| 图层页签 | `App.tsx` | `bottom` | 图层与页面 | — | 管理当前文件的多页目录与图层层级 |
| 资源页签 | `App.tsx` | `bottom` | 组件与资源库 | — | 浏览并插入原生组件、页面模板与设计规范 |
| AI 设计助手 | `App.tsx` | `bottom` | AI 设计助手 | — | 使用自然语言基于设计系统生成或局部修改可编辑图层 |
| 导入设计文件 | `App.tsx` | `bottom` | 导入设计文件 | — | 选择本地 Forma、Sketch 或 Figma 文件；第三方原稿预检后导入为独立文件 |
| 载入移动设计样例 | `PagesPanel.tsx` | `bottom` | 载入移动设计样例 | — | 打开包含 iPad、iPhone 与野径图志的 4 页综合样例（可撤销） |
| 新建页面 | `PagesPanel.tsx` | `bottom` | 新建页面 | — | 在当前文档中新增一个空白页面 |
| 复制当前页面 | `PagesPanel.tsx` | `top` | 复制当前页面 | — | 独立复制本页全部图层、辅助线与内部原型连线 |
| 重命名页面 | `PagesPanel.tsx` | `top` | 重命名页面 | — | 编辑页名（也可直接双击页面名称） |
| 删除当前页面 | `PagesPanel.tsx` | `top` | 删除当前页面 | — | 移除此页面，支持撤销恢复 |
| 折叠图层 | `LayersPanel.tsx` | `right` | 折叠图层 | — | 收起其他分支，保持选区路径，搜索时禁用 |
| 添加新画板 | `LayersPanel.tsx` | `right` | 添加新画板 | — | 在画布插入一个默认尺寸画板容器 |
| 图层可见性 | `LayersPanel.tsx` | `right` | 隐藏图层 / 显示图层 | `⇧⌘H` | — |
| 图层锁定 | `LayersPanel.tsx` | `right` | 锁定图层 / 解锁图层 | `⇧⌘L` | — |

### 3. 画布顶部控制条 — [Canvas.tsx](../../src/editor/Canvas.tsx)

以 `.toolbar-sep` 分为三组：`[撤销 | 重做]` · `[标尺与辅助线 | 智能吸附对齐]` · `[缩小 | 缩放读数 | 放大 | 适应全部内容]`。

| 控件 | 弹出方向 | `data-tip` | `data-tip-kbd` | `data-tip-desc` |
| --- | --- | --- | --- | --- |
| 撤销（支持禁用态悬停） | `bottom` | 撤销 | `⌘Z` | 撤销上一步文档修改并恢复选区 |
| 重做（支持禁用态悬停） | `bottom` | 重做 | `⇧⌘Z` | 重做已撤销的操作 |
| 标尺与辅助线 | `bottom` | 标尺与辅助线 | `⇧R` | 显示像素标尺，可从标尺边缘拖出吸附辅助线 |
| 智能吸附对齐 | `bottom` | 智能吸附对齐 | — | 拖拽时自动对齐相邻边界、中心线与辅助线（按住 ⌘ 临时关闭） |
| 缩小画布 | `bottom` | 缩小画布 | `-` | — |
| 缩放百分比读数 | `bottom` | 重置缩放至 100% | `⌘0` | 点击恢复 1:1 实际像素视图 |
| 放大画布 | `bottom` | 放大画布 | `+` | — |
| 适应全部内容 | `bottom` | 适应全部内容 | `⇧1` | 居中展示当前页面全部画板（适应选区：⇧2） |
| 画布小地图 | `bottom` | 画布小地图 | `⇧M` | 在右下角显示百屏缩略导航图，支持点击与拖拽快速定位 |

### 4. 底部悬浮创作工具栏 — [Canvas.tsx](../../src/editor/Canvas.tsx)、[ShapeTools.tsx](../../src/editor/ShapeTools.tsx)

以 `.toolbar-sep` 分为三组：`[选择 | 抓手]` · `[画板 | 形状组 | 钢笔 | 文本]` · `[置入图像或 SVG]`，全部采用 `data-tip-side="top"`。

| 控件 | `data-tip` | `data-tip-kbd` | `data-tip-desc` |
| --- | --- | --- | --- |
| 选择工具 | 选择与移动 | `V` | 选取、框选、移动与缩放图层（⌘ 点击穿透子层，⌥ 拖动复制） |
| 抓手工具 | 抓手平移画布 | `H` | 拖动画布视口平移（也可随时按住空格键拖动） |
| 画板工具 | 画板工具 | `F` | 拖拽绘制画板容器，或在右侧直接选择常用设备预设 |
| 形状主按钮（动态） | 绘制矩形 / 绘制椭圆 / 绘制直线 / 绘制多边形 / 绘制星形 | `R` / `O` / `L` / 无 / 无 | 随当前形状动态提示（如「拖拽绘制矩形，按住 Shift 绘制正方形」「按住 Shift 吸附 45° 角度」等） |
| 形状下拉箭头 | 切换更多形状 | — | 选择矩形、椭圆、直线、多边形或星形绘图工具 |
| 钢笔工具 | 钢笔矢量工具 | `P` | 点击或拖拽绘制贝塞尔矢量路径，Enter 完成编辑 |
| 文本工具 | 文本工具 | `T` | 点击画布直接输入自适应文本，或拖拽创建固定宽文本框 |
| 置入图像或 SVG | 置入图像或 SVG | — | 导入 PNG / JPG / WebP / GIF 位图或可编辑 SVG 矢量图形 |

### 5. 资源与组件库面板 — [AssetsPanel.tsx](../../src/editor/AssetsPanel.tsx)、[LibraryManagerModal.tsx](../../src/editor/LibraryManagerModal.tsx)

| 控件 | 弹出方向 | `data-tip` | `data-tip-kbd` | `data-tip-desc` |
| --- | --- | --- | --- | --- |
| 组件库管理 | `bottom` | 组件库管理 | `⌥3` | 按文件启停 iOS / Material 3 / AntD 5 / shadcn，导入/提取或打包自定义组件库 |
| 在线组件库 | `bottom` | 在线组件库 | — | 订阅团队 HTTP 地址、检查修订并审阅差异更新 |
| 供 AI Agent 使用 | `bottom` | 供 AI Agent 使用 | — | 注册当前已启用的官方组件库，允许 AI 助手检索并插入组件 |
| 导入外部组件库 | `bottom` | 导入外部组件库 | — | 从本地 .forma-library.json 文件导入共享组件与变量 |
| 保存为主组件（支持禁用态） | `bottom` | 将选区创建为主组件 | `⌥⌘K` | 单选时：「将当前选中的图层提取为可复用主组件并加入自定义库」；否则提示前置条件 |
| 添加颜色到文件（规范页签） | `left` | 添加颜色到文件 | — | 将当前所选体系的语义颜色批量写入本文件颜色变量 |
| 关闭组件详情 / 关闭组件库管理 | `bottom` | 关闭详情 / 关闭组件库管理 | `Esc` | — |

### 6. 右侧属性检视器 — [Inspector.tsx](../../src/editor/Inspector.tsx)、[PaintStack.tsx](../../src/editor/PaintStack.tsx)、[VectorInspector.tsx](../../src/editor/VectorInspector.tsx)、[TokenBinding.tsx](../../src/editor/TokenBinding.tsx)、[ColorField.tsx](../../src/editor/ColorField.tsx)、[App.tsx](../../src/editor/App.tsx)

| 分组 | 控件 | 弹出方向 | `data-tip` / 提示策略 | `data-tip-kbd` | 说明与动态/禁用行为 |
| --- | --- | --- | --- | --- | --- |
| 空选区 | 管理本地变量 / 新建或管理本地样式 | `left` | 管理本地变量 / 新建或管理本地样式 | — | 快速打开设计系统对话框 |
| 对象头 | 可见性 / 锁定 | `top` | 显示或隐藏图层 / 解锁或锁定图层 | `⇧⌘H` / `⇧⌘L` | 随选区状态动态切换 |
| 对齐与整理 | 左/水平中/右/顶/垂直中/底对齐 | `top` | 对应对齐名称 | — | 可用：「按选区边界或父容器对齐图层」；禁用：「请选中至少 2 个图层或容器内子图层」 |
| 对齐与整理 | 水平等距分布 / 垂直等距分布 | `top` | 水平等距分布 / 垂直等距分布 | — | ≥3 层可用；不足 3 层禁用并提示「请同时选中至少 3 个图层」 |
| 对齐与整理 | 智能整理 | `top` | 智能整理排列 | — | 自动对齐所选多个图层并统一行列间距 |
| 位置与矢量 | 用作/解除矢量蒙版 | `top` | 用作矢量蒙版 / 解除矢量蒙版 | — | 说明裁剪与恢复行为 |
| 位置与矢量 | 子路径运算 | — | 子路径运算 | — | 单选导入复合组的直接子路径时显示；支持保留轮廓与四种布尔运算，锁定或未分离实例禁用。 |
| 位置与矢量 | 布尔运算 4 项 / 拼合为矢量 / 水平与垂直翻转 | `top` | 继承 `title` 自动升格 | — | 保留全部 `aria-label` 与操作语义 |
| 位置与矢量 | 数值拖拽图标（`Field`） | `top` | 字段名称 | — | 数值型字段说明：「左右拖动图标可调值，↑/↓ 键微调」 |
| 位置与矢量 | 编辑矢量锚点（`VectorInspector`） | `left` | 编辑矢量锚点 | `Enter` | 进入路径节点与贝塞尔手柄编辑模式 |
| 布局与外观 | 锁定宽高比 | `left` | 锁定宽高比 / 已锁定宽高比 | — | 修改宽或高时按原比例等比缩放 |
| 布局与外观 | 自动布局 4 模式 | `top` | 自由定位 / 水平自动布局 / 垂直自动布局 / 网格布局 | 垂直：`⇧A` | 分别说明对应排布逻辑 |
| 布局与外观 | 自动换行 / 9 宫格对齐 / 独立内边距 / 独立圆角 | `top` / `left` | 自动换行 / 各方位对齐 / 分别设置四边内边距 / 分别设置四角圆角 | — | 开关态文案随当前状态切换 |
| 填充/描边/效果 | 添加填充层 / 上移 / 下移 / 切换可见性 / 删除填充层 | `left` / `top` | 添加填充层（及 4 项继承 `title` 升格） | — | 保留 `title` 兼容既有测试 |
| 填充/描边/效果 | 添加描边 / 移除描边 / 内中外描边位置 / 添加投影 / 删除效果 | `left` / `top` | 添加描边 / 移除描边 / 添加投影效果 等 | — | 标明上限（填充 16 层、投影 8 层） |
| 变量与取色 | 绑定/解绑变量、关闭变量列表、关闭颜色选择器 | `top` / 自动 | 变量状态 / 关闭 / 关闭颜色选择器 | `Esc` | 解绑提示「解除变量绑定，保留当前值」 |

### 7. 浮动编辑栏与弹窗工具条 — [InlineText.tsx](../../src/editor/InlineText.tsx)、[VectorEditor.tsx](../../src/editor/VectorEditor.tsx)、[FileBrowser.tsx](../../src/editor/FileBrowser.tsx)、[DesignSystemDialog.tsx](../../src/editor/DesignSystemDialog.tsx)、[PreviewDialog.tsx](../../src/editor/PreviewDialog.tsx)、[App.tsx](../../src/editor/App.tsx)

| 区域 | 控件 | 弹出方向 | `data-tip` | `data-tip-kbd` | 说明 / 禁用行为 |
| --- | --- | --- | --- | --- | --- |
| 行内富文本栏 | 加粗 / 斜体 / 下划线 / 删除线 / 选区字体设置 | `bottom` | 局部加粗 / 局部斜体 / 局部下划线 / 局部删除线 / 选区字体设置 | `⌘B` / `⌘I` / `⌘U` / — | 未选中文字范围时禁用并提示「请先拖选一段文字」 |
| 矢量路径编辑栏 | 完成路径编辑 | `bottom` | 完成路径编辑 | `Enter` | 退出锚点编辑模式 |
| 本机文件弹窗 | 导入为独立文件 / 新建设计文件 / 关闭本机文件 | `bottom` | 导入为独立文件 / 新建设计文件 / 关闭本机文件 | `—` / `—` / `Esc` | 均采用 `.icon-btn.icon-btn-sm` |
| 变量与样式弹窗 | 撤销 / 重做 / 导入 / 导出 / 关闭 / 新建集合 / 关闭变量详情 | `bottom` / `left` | 撤销 / 重做 / 导入变量与样式 / 导出变量与样式 / 关闭变量与样式 / 新建变量集合 / 关闭详情 | `⌘Z` / `⇧⌘Z` / `—` / `—` / `Esc` | 撤销/重做支持禁用态悬停 |
| 原型预览弹窗 | 重置原型状态 / 关闭预览 | `bottom` | 重置原型状态 / 关闭预览 | `—` / `Esc` | 恢复初始页面、变量与交互控件状态 |
| 代码预览与错误提示 | 关闭代码预览 / 关闭提示 | `bottom` / `top` | 关闭代码预览 / 关闭提示 | `Esc` / `—` | 统一 `.icon-btn.icon-btn-sm` |

---

## 六、接入清单与验收标准

后续新增任何图标入口、工具条或弹窗按钮时，须逐项确认：

1. **样式一致**：按所在区域选用 `.icon-btn`（28px）、`.icon-btn.icon-btn-sm`（24px）或 `.tool-btn`（34px），同栏跨组使用 `.toolbar-sep`。
2. **属性完备**：提供 `aria-label`、`data-tip`，有快捷键必配 `data-tip-kbd`，非自解释图标或有前置条件的禁用按钮必配 `data-tip-desc`，显式声明 `data-tip-side` 防止遮挡相邻控件。
3. **无零散原生气泡**：不单独引入第三方 tooltip 组件，统一走全局 `<TooltipHost />`。
4. **回归验证**：
   - 运行 `npm run format:check`、`npm test`、`npm run build`；
   - 在真实浏览器检查冷悬停（260ms）、相邻图标热切换（0ms）、禁用态悬停、`Esc` 收起、原生 `title` 离开即还原以及窄/短视口不裁切；
   - 运行 `npm run test:browser -- editor-panels library-tokens files storage complex` 确认不破坏既有菜单/文件定位与 8,288 层拖拽帧率基线。

## 0.2.1 的侧栏、命令和属性协议

- 宽度 ≥950 px 时两侧面板独立显隐；≤949 px 初次进入时均收起，一次打开一侧；≤620 px 面板覆盖画布。显隐保留选区，不写历史。「折叠图层」收起其他分支，保留选中项的祖先，搜索时禁用。
- 命令面板的箭头键在可用项间移动，输入框回车只执行首个可用结果。输入法组合期间不提交，零结果显示「无匹配操作」；只有禁用结果时回车保持打开。Esc 返回触发入口，顶栏 Tab 可继续移焦。
- 多选时 HEX 与不透明度分别显示 Mixed。提交一个通道只更新该通道；未改动直接离开不生成写入。数值空输入或非法草稿失焦恢复实际值，指针拖动取消不提交。多选文字和形状时颜色分别写入其文字色与填充。
- 固定列网格子层在右栏显示「跨列数」，默认 1。320 px 三列、间距 10 px 时，跨度 2 的 Fill 卡片宽 210 px，下一项 x=220，再下一行 y=50（行高 40 px）。面板、预览及下载工程共用验收夹具。
- 复测 `npm run test:browser -- editing-workflow editor-panels aura`，独立工程从完整浏览器回归产物运行 `npm run test:exports`。0.3.0 的宽度交互见下节。

## 0.3.0 的侧栏、网格、变量与原型

- 窗口宽度至少 950 px 时，可拖左栏分隔线至 200–360 px、右栏至 256–400 px。焦点在分隔线上时，方向键移动 8 px，Shift 加方向键移动 32 px，Home/End 到两端。松手记忆本浏览器宽度。⌘/Ctrl + Shift + 反斜杠收起或恢复此前可见的面板，收起包含焦点的侧栏后焦点返回画布。
- 网格子层的跨行、跨列输入为 1–64。容器可选内容行高或输入 1–10000 px 固定行高。窄容器断点使用容器边框盒宽度，等于阈值即生效。默认阈值 600 px、窄屏 1 列，未指定窄间距时继承原间距。网格区可从当前画板创建并复用布局样式。
- 线性、径向渐变的每个色标可以绑定作用域允许填充的颜色变量。更换模式时解析该模式的值。修改色标透明度可保留绑定，手输替代颜色时解除该色标引用。
- 原型动作已设置跳转或浮层目标时，可从右栏定位其画板，包括其他页；通过「返回连线来源」恢复来源页和选区。
- 复测使用 `designer-delivery`、`library-tokens`、`cross-page`。在 721×600、1024×480 与 1440×900 窗口检验侧栏、深层选择和交付入口位置。

## 0.5.1 已验收的面板交互

[完整编号与双端操作](EDITOR-PANEL-ACCEPTANCE.md)。04.01 画板预设提供 393×852 的 iPhone 16、390×844 的 iPhone 13/14 和 1024×768 的横屏平板。04.12 投影行的上移和下移按钮在共同可见的效果列表内逐项交换，边界按钮禁用，多选时一次撤销恢复各层。07.01 代码预览支持 Tab 在弹窗内循环、Esc 关闭，焦点回到打开按钮。

## 0.6.0 工具入口

03.04 钢笔编辑工具栏的「从锚点连接分支」在选中锚点后可用，激活状态由按钮的 `aria-pressed` 表示。04.17 本地主件的「组件变体」内可选择「在画布排列组件集」。已验证的落点、间隔、撤销与选区结果见[专业编辑规格](PROFESSIONAL-EDITING.md)。

## 0.17.0 画板标题、对齐图标与高级矢量轮廓化入口

- **画板/分区/组件标题（[ArtboardLabel.tsx](../../src/editor/ArtboardLabel.tsx)）**：页面根画板、分区（`.section-title-pill`）、组件集、主组件、组件实例及分区内直接子画板均支持点击选中、拖拽整体移动、`Shift` 轴锁与多选联动、`Option/Alt` 拖出复制副本、双击画布原位 IME 安全重命名（未完成组合态切换页签不写入半截草稿）、悬停高亮轮廓及右键自动选中；无障碍名称按节点类型精确区分 `画板` / `分区` / `组件集` / `主组件` / `组件实例`，在空格平移、抓手、绘图、框选与 DevMode 下自动透传让位。
- **对齐与分布工具条（[Inspector.tsx](../../src/editor/Inspector.tsx)）**：全部 8 枚控件按语义与 Lucide 基准线方向一一对应并标注 `data-align-id`：`left`（`AlignStartVertical` 左对齐）、`center`（`AlignCenterVertical` 水平居中）、`right`（`AlignEndVertical` 右对齐）、`top`（`AlignStartHorizontal` 顶对齐）、`middle`（`AlignCenterHorizontal` 垂直居中）、`bottom`（`AlignEndHorizontal` 底对齐）、`horizontal`（`AlignHorizontalSpaceAround` 水平等距分布）、`vertical`（`AlignVerticalSpaceAround` 垂直等距分布）；与右键菜单、命令面板和领域 `alignOperations` 共享 `isEditActionEnabled`（支持自动布局内 `absolutePosition` 绝对定位子图层，按真实禁用原因展示提示）。
- **高级矢量编辑与轮廓化（[VectorEditor.tsx](../../src/editor/VectorEditor.tsx)、[VectorInspector.tsx](../../src/editor/VectorInspector.tsx)）**：矢量编辑浮栏支持多锚点框选计数徽标与「弯曲工具（Bend）」切换（默认态按住 `Option/Alt` 临时弯曲曲线段、单击锚点切换平滑/尖角）；描边轮廓化与文字转轮廓统一绑定快捷键 `⇧⌘O`，同步接入右键菜单、命令面板（`⌘K`）与右侧属性栏按钮并共用 `isEditActionEnabled`。

## 0.18.0 系统字体转轮廓、视口自适应弹层与标准 UI3 轻提示规范

- **系统与全格式字体转轮廓（[FontAssets.tsx](../../src/editor/FontAssets.tsx)、[text-outline.ts](../../src/infrastructure/text-outline.ts)）**：文字节点使用系统字体栈（如 `system-ui, sans-serif`）执行 `⇧⌘O` 或右栏「文字转轮廓」时，按「文档嵌入字体 → 桌面端 Electron IPC / 本机回环系统字体 → 浏览器 `queryLocalFonts()`」顺序自动按字形解析真实轮廓（含中英混排多字体自动回退），不再要求先手动导入 TTF/OTF；字体导入控件放宽至 `.ttf,.otf,.ttc,.otc,.woff,.woff2` 六种后缀并支持 TTC/OTC 多字面选择与单面规范提取，未解析到对应本机字形时才给出清晰提示。
- **视口自适应弹层引擎（[useAnchoredPopover.ts](../../src/editor/useAnchoredPopover.ts)）**：右侧属性面板全部 5 类弹层（颜色选择器 `ColorField`、变量绑定 `VariablePicker`、样式绑定 `StylePicker`、组件插槽替换 `SlotSwapPicker`、高级字体设置 `type-details-popover`）统一接入真实 DOM 尺寸测量 + `ResizeObserver` + 窗口 `resize` / 面板滚动重算，严格保持至少 `12px` 视口边距、底部空间不足自动上移/翻转、按落点 `top` 动态设置 `maxHeight` 内部滚动、有界拖拽零死区，以及切换 Tab/文档会话失活收口与计算可见性安全的键盘焦点恢复。
- **标准 Forma UI3 顶部轻提示（[ToastHost.tsx](../../src/editor/ToastHost.tsx)）**：废弃旧版右下角全框红边 `.toast`，统一为锚定于当前活跃画布容器顶部居中（`top: 12px`）的 UI3 胶囊浮层，动态避让已展开弹层、底部浮动工具栏、左右面板与小地图；使用 `--bg-elevated` / `--border-subtle` / `--shadow-popover` 与语义图标/柔和色条区分 `info` / `success` / `warning` / `error`，支持最多 4 条队列与 `info`/`success` 4.5s 自动收起（悬停或键盘聚焦暂停计时），11 处懒加载占位独立使用 `.panel-loading-pill` 不再混用轻提示样式。
- **右栏全量控件交互与无障碍规范**：所有右栏写操作在存在外部 AI 提案预览时统一保护不误清提案；多选不同表单控件编辑可访问名称时逐节点保留原有 `control` 类型；输入草稿统一支持 IME 组合态保护、`Escape` 取消不误提交与越界回滚；`TooltipHost` 自动关联 `aria-describedby`；多 Tab 编辑器为左右栏分配每页签唯一 DOM ID，确保 `PanelDivider` 拖宽与键盘调宽严格作用于当前活跃标签页。
