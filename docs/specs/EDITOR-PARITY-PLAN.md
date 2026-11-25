# 设计师操作与 Figma 能力对照

最近更新日期 2026-11-21 · 状态 **草案**（含 0.6.0 双端工作流实测，后续列记录更大范围的关闭条件）

关联源码 [编辑器](../../src/editor/App.tsx)、[属性面板](../../src/editor/Inspector.tsx)、[颜色输入](../../src/editor/ColorField.tsx)、[尺寸规则](../../src/domain/sizing.ts)、[变量与样式](../../src/domain/design-system.ts)、[播放器](../../src/runtime/PrototypePlayer.tsx)、[工程编译](../../src/compiler/file-project.ts)。

0.6.4 增补了图像适配、平铺、调色与画布裁切，逐项验证位图蒙版在网页和静态输出的效果。H5 嵌套浮层的键盘和触摸输入见[专项验收](../EDITOR-ACCEPTANCE.md#064-位图编辑与原型输入)。真实触控设备、其他高级图像调整及多语文字排版仍按实际稿验收。

## 对照方式

在项目指定的公开 Figma 文件中展开左栏，核对页面、图层、导航和浮动工具栏。此文件提供只读视图，涉及编写、混合值和实例属性的操作依据 Figma 官方说明。Forma 的结论来自本地设计稿、实际点击、下载后的工程和专项脚本。两侧截图使用不同文件与视口，仅用于核对控件和任务路径。[参考文件](https://www.figma.com/design/UbGYtSKWofpviVpAiZ7Tjk/?node-id=12740-37613) · [现场截图](../evidence/2026-11-20/figma-sidebar.png) · [Forma 实测](../EDITOR-ACCEPTANCE.md)

### 从桌面界面找到操作

| 设计任务 | Figma 的入口 | Forma 的入口与实测 |
| --- | --- | --- |
| 找到需要改的深层文字 | 左栏的页面、图层和搜索；右栏随当前选区切换 | 在 Aura 搜索 Logo、定位、改名、撤销，再切到资源。复杂稿滚动图层树不移动页签。宽度 721 px 的窗口收起左栏后仍能操作右栏和导出。[导航与左栏](https://help.figma.com/hc/en-us/articles/360039831974-Explore-the-navigation-bar-and-left-sidebar) |
| 画一个对象，切换到原型，再回到原稿 | 底部工具栏选择创作工具，右栏切换 Design / Prototype | F 或 T 切工具，画布拖画或按 Enter 创建。右栏「设计 / 原型」切换。按图层设置动作后，从预览打开浮层、关闭、返回原稿。菜单在 480 px 高窗口从键盘打开与退出。[上下文右栏](https://help.figma.com/hc/en-us/articles/360039832014-Design-prototype-and-explore-layer-properties-in-the-right-sidebar) |
| 只改多选图层的颜色或透明度 | Fill 的色块打开颜色与透明度，属性显示选区共有值或不同值 | 右栏「填充」打开色块，切 HEX/RGB/HSL、改渐变色标。取两层实际绘制值验证改色保留各自的透明度，撤销恢复两层。[颜色选择器](https://help.figma.com/hc/en-us/articles/360041003774-Update-fills-using-the-color-picker) |
| 重排网格，明确卡片占哪几格 | Grid 自动布局和画布列行编辑，选区对应轨道、单元格和跨度 | 右栏设 px/fr/适应内容、指定起始格和跨度；画布直接拖把手和子层。五档尺寸比较预览与独立工程。Forma 的局部容器断点为 Web 交付能力。[Figma Grid](https://help.figma.com/hc/en-us/articles/31289469907863-Use-the-grid-auto-layout-flow) |
| 让自己的徽标有多个状态，再提供给另一份文件 | 从主组件添加变体，或将多项合入组件集，再在实例上选择属性组合 | 在主件右栏创建 State、尺寸两条变体轴，或多选源图层「组合为变体集」。使用方保留文案，缺少的属性组合禁用，可定位到所选变体的主件。Forma 在画布显示组件集，已有主件以副本加入并保留既有使用方。[创建和使用变体](https://help.figma.com/hc/en-us/articles/360056440594-Create-and-use-variants) |
| 在使用方调整实例、接受源库修订 | 实例右栏编辑公开属性，在库更新中审阅来源和改动 | 选外层实例改文字、显示和内层替换；多选共享字段出现 Mixed。资源面板并排预览当前/新版组件，逐组件接受，可保留本地变量。安装版退出重开后可在第二份文件订阅。[组件属性](https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties) · [组件库](https://help.figma.com/hc/en-us/articles/360041051154-Guide-to-libraries-in-Figma) |
| 阅读复杂字体与蒙版的结果 | 文本属性展示字体支持的特性，蒙版有矢量、透明度与亮度模式 | 字体右栏读取实际字体特性，选区字体设置能单独调字宽与字距；图层树选择素材和内容后创建蒙版、切类型。分别验证实际字形宽度和蒙版像素。[文字属性](https://help.figma.com/hc/en-us/articles/360039956634-Explore-text-properties) · [蒙版](https://help.figma.com/hc/en-us/articles/360040450253-Masks) |

### 按选区检查右侧面板

| 设计者的选区与意图 | Forma 已有入口与验证 | 当前差距与验收样例 |
| --- | --- | --- |
| 空选区与键盘创作 | 从顶栏用 Tab 到新建空白文件，F6 进画布，F、Enter 插画板，T、Enter 插入文字，Enter 编辑，保存、撤销、重做并重新打开 | 所有弹窗的屏幕阅读器播报还需分别验收 |
| 文本选区与字体 | 导入 Roboto Flex，按字体记录调节字宽轴，从 25 到 151 时 Hug 宽度随之变化。关闭 liga，在中英混排文字中的前两个字应用局部字距和另一轴值，刷新、预览和独立工程均保存 | 安装版使用 macOS 简体拼音输入 nihao、选词「你好」、提交、撤销重做并重开。竖排及双向排版另行验收 |
| 位图与矢量蒙版 | 在图层树选择图像与内容，创建位图蒙版并切换 alpha/亮度；从画布到预览和独立工程抽取相同位置的像素。既有矢量布尔和蒙版回归同时运行 | 0.6.0 已验共用锚点、分区填色和开放分支 |
| 网格画板与子层 | 逐条设置 px、fr、内容适配，设置起始行列和跨度。可直接拖动轨道、通过键盘微调，或拖子层落入目标格。用 240 px 侧栏和第三行卡片在 375 至 1440 px 五档验收 | 已测 480/768 两个断点和内层 300 px 独立断点，可覆盖列数、子层间距和容器内边距。0.5.0 按容器宽度覆盖填充、透明度和圆角，支持继承与恢复；其他外观属性按具体需求扩展 |
| 混合多选 | 多选渐变一种属性改动后，另一色标属性仍按层独立。添加描边保留已有描边，添加投影保留原各层阴影。撤销比较原始值 | 0.5.1 已从效果列表逐项调整两层阴影的前后顺序并一次撤销。其他类型效果的混合仍按实稿扩展。见[编号 04.12](EDITOR-PANEL-ACCEPTANCE.md) |
| 主件与跨文件库 | 资源面板发布快照，另一设计文件订阅、插入并接收新修订。可按组件选择、解决共享定义冲突、撤销，断网继续使用已安装版本 | 服务写凭证和来源控制已实现；组织权限、审核和多人同时编辑属于团队阶段 |
| 实例与代码 | 主件公开文本和显示属性；改实例属性、整体替换兼容组件、撤销、刷新并导出，独立 React 组件可传入类型化属性 | 三层页头可从外层改标题、换最内层标识并作为 React 公共属性交付。多选共享变体轴可一次撤销恢复各自值。0.5.0 已验证两个文件各保留文案，旧业务代码随库改名继续编译和运行 |
| 图像与锁定 | PNG 拖入、位图解码、裁切、锁定、撤销和刷新恢复按文件验收。大图会话的数据与时长见验收记录 | 不同设备上的内存/图形驱动开销需同稿、同环境分别测量 |

参考 [Figma 上下文属性栏](https://help.figma.com/hc/en-us/articles/360039832014-Design-prototype-and-explore-layer-properties-in-the-right-sidebar)、[颜色选择器](https://help.figma.com/hc/en-us/articles/360041003774-Update-fills-using-the-color-picker)、[网格流与跨度](https://help.figma.com/hc/en-us/articles/31289469907863-Use-the-grid-auto-layout-flow)、[蒙版](https://help.figma.com/hc/en-us/articles/360040450253-Masks)、[组件属性](https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties)。

### 按完整任务制定补齐顺序

| 优先级与任务 | Figma 参考和 Forma 当前行为 | 下次交付的关闭条件 |
| --- | --- | --- |
| 本期已验 · 多层组件组合 | 已从顶层实例替换内层组件，保留匹配的编辑，确认主件修订跟随；独立 React 组件可接收另一个生成组件。 | 已验证三层属性转交、多选 Mixed、特定节点的独立值以及独立 React 参数。在源文件把「标签」改名为「业务标签」，两份订阅文件采用新版、撤销、重做、重开，保留各自文案。含旧名调用的源码 ZIP 经二次更新后独立构建并渲染。显式删除字段属于接口删除。[Figma 组件属性](https://help.figma.com/hc/en-us/articles/5579474826519-Explore-component-properties) |
| 本期已验 · 响应式生产稿 | 240 px 固定列搭配 fr 与指定格已验证。双断点仪表盘和嵌套工具栏逐项核对间距、内边距、列数和子层位置，误差限 1 CSS px。 | 在两页控制台分别检查外层／内层断点的填充、圆角及透明度；从 375 到 1440 再返回 390 px，进入详情页并返回。[Figma 网格](https://help.figma.com/hc/en-us/articles/31289469907863-Use-the-grid-auto-layout-flow) |
| 本期已验 · 业务工程持续开发 | 直接导入生成的库组件，自定义实例值；反馈表单改版保留异步校验和手写接口文件；非法邮箱拦截、服务端 422、修正重试 201 通过 | 在订单业务路由中更新画板、保留业务入口；刷新订单详情直达、两层弹窗打开、焦点回到各层按钮、历史返回都已验证。[工程交付规格](REACT-PROJECT-UPDATES.md) |
| 本期已验 · 画布组件集 | 支持从主件新增、组合已有设计、按属性轴排列以及在画布拖入已有主件。 | 在双轴组件集中拖入已发布主件，原实例后续仍从 80 px 更新到 96 px，重开、撤销、实例选择通过。[编号验收](EDITOR-PANEL-ACCEPTANCE.md) |
| P2 · 原型与专业绘图 | 跨页目标可在面板选取并跳转；位图蒙版及可变字体通过真实渲染 | 系统简体拼音已在安装版实测，分支矢量网络已通过独立工程验证，多语排版仍按样稿验收。跨页拖线是 Forma 工作流扩展；Figma 的原型流程按页组织。[Figma 原型](https://help.figma.com/hc/en-us/articles/360040314193-Guide-to-prototyping-in-Figma) |
| 后续阶段 · 移动与团队 | 桌面设计、H5 播放及独立工程为本轮范围 | 分别记录系统无障碍字号、实际触控环境、团队角色的协作操作。模型质量和同机同稿 Figma 性能为独立验收项 |

每项关闭时将版本、样例、实际操作、引擎与数值写入[验收记录](../EDITOR-ACCEPTANCE.md)。工作区没有 Git 元数据，Gemini 的既有产出按交接时可观察到的行为核对。
