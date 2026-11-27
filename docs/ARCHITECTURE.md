# 设计平台架构与实现约定

**2026-11-27 增量（零配置本机 MCP Streamable HTTP 与标准 A2A Design Agent 运行时）**　在 `server/` 新增纯 Node 零 DOM 的共享运行时能力层 [runtime-capabilities.ts](../server/runtime-capabilities.ts)（多 Tab 列表、SVG 画板出图、真实 React/TSX/Tokens 导出、高阶 AI 设计委派）、共用 11 工具注册工厂 [mcp-tools.ts](../server/mcp-tools.ts)、基于 `@modelcontextprotocol/server` v2.4.0 的 Streamable HTTP 适配器 [mcp-http.ts](../server/mcp-http.ts)（`/mcp`）以及标准 Linux Foundation A2A Server [a2a-protocol.ts](../server/a2a-protocol.ts) / [a2a-server.ts](../server/a2a-server.ts)（`/.well-known/agent-card.json` 与 `/api/a2a` JSON-RPC 2.0 + SSE）；升级 [agent-sessions.ts](../server/agent-sessions.ts) 为跨 Tab 持久化工作区同步桥（`PUT /sync`、`proposal/ack`、只读与审阅/信任自动落画布策略、实时连接客户端遥测与编辑器任务确认/拒绝回调），统一接入 [agent-http.ts](../server/agent-http.ts)、[vite.config.ts](../vite.config.ts) 与 [electron/main.mjs](../electron/main.mjs)（桌面端自动注入 `endpointBase` 消除 `npm run mcp` 源码依赖）。前端新增零 React 应用层 [external-bridge.ts](../src/application/external-bridge.ts) 与顶栏轻量收件箱 [AgentInboxPopover.tsx](../src/editor/AgentInboxPopover.tsx)（`@layer panels`，0 `!important`），支持「外部 A2A 任务进入 `input-required` → 设计师画布应用并自由修改 → 确认回传最新编译产物」人机协同闭环以及受信任自动落画布 + 单步 `⌘Z` 撤销。[课题文档](initiatives/2026-11-27-mcp-a2a-design-agent-runtime/PRD.md) · [协议契约](AGENT-PROTOCOL.md)

**2026-11-27 增量（Figma 风格单窗口多文件顶部 Tab 工作台与 macOS 融合标题栏）**　在 `src/application/` 新增零 React/DOM 依赖的多文件 Tab 状态机 [workspace-tabs.ts](../src/application/workspace-tabs.ts)（支持固定首位工作台首页 Tab `⌂`、按 `id`/`fileKey`/`nativePath` 严格去重、最多 24 个 Tab 淘汰策略、10 项已关闭 Tab 恢复栈、拖拽重排、URL 编解码与 Zod 校验的 `localStorage["forma.workspace-tabs.v1"]` 会话持久化）；顶层入口 [main.tsx](../src/main.tsx) 统一挂载 [WorkspaceShell.tsx](../src/editor/WorkspaceShell.tsx) 与 36px [WorkspaceTabBar.tsx](../src/editor/WorkspaceTabBar.tsx)（`@layer panels`，0 `!important`），将**工作台首页、左上角 `Forma ▾ → 最近打开 ▸` 子菜单（[RecentFilesSubmenu.tsx](../src/editor/RecentFilesSubmenu.tsx)）、本地打开/双击/拖放、编辑器内 `+ 新建` / `FileBrowser` / 内置样例 / 外部导入**全部收口至统一 Tab 调度器并双向同步 History API。多 Tab 生命周期采用「单活 + 视图快照（当前页、选区、`views` 相机映射）+ 卸载前强制 `flushSave()` + AI 流式/MCP 配对后台 `hidden` 保活池」策略，既防多份万层文档常驻 DOM 造成内存暴涨，又保证切稿不丢编辑、不中断长任务且非活跃保活 Tab 自动屏蔽全局快捷键与剪贴板事件；Electron 桌面端（[electron/main.mjs](../electron/main.mjs)、[electron/preload.cjs](../electron/preload.cjs)）在 macOS 启用 `titleBarStyle: "hiddenInset"`（`trafficLightPosition: { x: 14, y: 11 }`）与 36px Tab 栏左侧拖拽区自然融合，并将系统 `open-file` / `⌘O` 以 FIFO 队列与 `forma:open-file-in-tab` IPC 路由至当前活跃窗口新 Tab，支持原生菜单 `⌘T`/`⌘N`/`⌘W`/`⇧⌘T` 与 `openInNewWindow`/`closeCurrentWindow` 受控 IPC。[课题文档](initiatives/2026-11-27-multi-tab-workspace/PRD.md)

**2026-11-27 增量（全屏工作台首页、原生 `.forma` ZIP 容器格式、桌面直接保存与 AI 工作流净化）**　将默认启动路由（`/`）从直接新建空白画布升级为独立懒加载的全屏工作台首页（[WorkspaceHomeShell.tsx](../src/editor/WorkspaceHomeShell.tsx)、[WorkspaceHome.tsx](../src/editor/WorkspaceHome.tsx)，生产块 `19.97 kB` gzip `7.41 kB`，主入口 `index-*.js` 进一步瘦身至 `376.01 kB` gzip `133.06 kB`），支持最近打开/全部文件/未归类草稿/项目空间管理、强视觉「+ 新建设计」主按钮与四类快速起稿卡片；带 `?file=` / `?example=` / `?editor=1` 深链及 macOS `open-file` 仍直达编辑器，编辑器顶栏提供「工作台」返回入口与显式「+ 新建」按钮。新增原生单后缀 `.forma` ZIP 容器编解码器 [forma-package.ts](../src/infrastructure/forma-package.ts)（`forma/package` v1，包含 `manifest.json`、`document.json` 或超大稿 `document.parts.ndjson`、`preview.svg` 与原始二进制 `assets/images/*`、`assets/fonts/*` 去 Base64 膨胀；兼容读取历史 `.forma.json`）；桌面端（[electron/main.mjs](../electron/main.mjs)、[electron/preload.cjs](../electron/preload.cjs)）支持绑定 `.forma` 路径实现 `⌘S` 原子覆写与 `⇧⌘S` 原生另存为，并提供 `hasConfiguredAgent()` 本地配置零网络磁盘探测；结合非敏感 `localStorage["forma.agent.configured-hint"]` 标记修复跨文件/刷新/重启模型连接丢失缺陷（干净环境仍保持 `0` 次 `/api/agent/*` 请求）；同时彻底移除 AI 输入区「创作设置」浮层、底层生成引擎切换与视觉优化手动开关，将外部 MCP 配对与高级 JSON 事务抽离至独立保活弹窗 [IntegrationsModal.tsx](../src/editor/IntegrationsModal.tsx)。[课题文档](initiatives/2026-11-26-workspace-home-forma-format-ai-flow/PRD.md)

**2026-11-26 增量（全栈架构边界自动门禁、CSS `@layer` 治理、首屏分包与设计师体验升级）**　完成 `domain` / `application` / `compiler` / `runtime` 四层反向依赖清零：纯领域规则迁回 [library-intelligence.ts](../src/domain/library-intelligence.ts)、`OFFICIAL_BUILTIN_LIBRARY_IDS`（[library-schema.ts](../src/domain/library-schema.ts)）与 [document-parts.ts](../src/domain/document-parts.ts)；纯 SVG 序列化下沉至 [svg-export.ts](../src/compiler/svg-export.ts)（通过纯回调 `configureSvgTextWidth` 由 [static-export.ts](../src/infrastructure/static-export.ts) 注入浏览器画布测宽，零 DOM 依赖）；AI 会话范围校验、提案组装与记忆归档元数据下沉至零 React 依赖的 [agent-session.ts](../src/application/agent-session.ts) 与 [useAgentSession.ts](../src/editor/agent/useAgentSession.ts)，将 [AgentPanel.tsx](../src/editor/AgentPanel.tsx) 拆解瘦身至 674 行。新增静态边界与代码洁净度门禁 `npm run lint:arch`（[check-architecture.mjs](../scripts/check-architecture.mjs) 与 [architecture-boundaries.test.ts](../tests/architecture-boundaries.test.ts)），强制校验分层单向依赖、`as any` 与 CSS `!important` 预算。编辑器样式全面纳入 5 级 CSS Cascade Layers（[layers.css](../src/editor/layers.css)：`@layer legacy, design-system, ui3, panels, overrides;`），全仓 `!important` 从 223 处降至 3 处；工作台接入分层 [ErrorBoundary.tsx](../src/editor/ErrorBoundary.tsx)（支持画布/顶层一键导出 `.forma.json` 防丢稿备份）、空画布引导卡 [CanvasWelcomeOverlay.tsx](../src/editor/CanvasWelcomeOverlay.tsx)、桌面/Web 区分保存文案与全中文画板预设 [ux-copy.ts](../src/editor/ux-copy.ts)；并通过 12 个重型弹窗/面板 `React.lazy`、`catalog` / `icon-library` / `export-project` 动态 `import()` 与 [vite.config.ts](../vite.config.ts) vendor `manualChunks` 将主入口 `index-*.js` 从 2,200.5 kB 降至 1,028.5 kB（`-53.3%`）。[课题文档](initiatives/2026-11-26-engineering-ux-balance/PRD.md) · [AI 面板重构课题](initiatives/2026-11-26-ai-panel-ux-redesign/PRD.md)

**2026-11-26 增量（Forma AI Stage 2 · 轻量项目空间、历史需求记忆与衍生模块回流）**　新增独立项目记忆持久层 `forma-project-memory-v1`（[project-memory-store.ts](../src/infrastructure/project-memory-store.ts)），承载 `projects`、`assignments`、`episodes` 与 `tombstones` 四表（未变更 `forma-studio` 库结构），默认以 `file:<fileKey>` 隔离未归类草稿并在归入项目后自动随迁至 `proj:<projectId>`；工作区组件库仓 `forma-workspace-libraries-v1` 升至 v2 拆分独立 `fences` 对象仓以保留任意前缀的自定义库并记录紧凑提交回执（`__applied_cat__:<commitId>`）。[storage.ts](../src/infrastructure/storage.ts) 新增每文件 `lifetimeToken`、单调 `replacementEpoch`（整稿导入、页面样例重载、失败恢复与跨替换边界 Undo/Redo 均递增）及与文档写入/删除串行化的 2PC 提交授权协调器（`authorizeFileCommit` / `isFileCommitAuthorized` / `acknowledgeFileCommit`），确保多标签并发与离线重连下档案归档、受保护删改与组件库沉淀的原子性与一致性。[project-memory.ts](../src/agent/project-memory.ts) 提供确定性 CJK+Latin 混合召回（`rankProjectEpisodes`）、全资源覆盖的 `v2:` 指纹与 `captureId` 实例标识，[library-promotion.ts](../src/domain/library-promotion.ts) 实现衍生模块回流、官方只读库保护、依赖归并与 `aiGuide` 增量刷新；[forma-tools.ts](../src/agent/forma-tools.ts) 新增只读工具 `search_project_episodes` / `get_episode_details`。[长期规格](specs/FORMA-AI-LIBRARY-AND-MEMORY.md)

**2026-11-25 增量（Forma AI Stage 1 · 组件库智能理解与混合装配）**　`forma/library` v1 组件项新增可选 `assetTier`（`page` / `block` / `component`）与 `aiHints`，库顶层新增可选 `aiGuide`（离线 Manifest 与增量 Playbook Markdown）；`putLibrary` 先归并依赖再比对已用组件结构，允许更新非结构性 AI 标注且继续保护组件模板与变量绑定不漂移。`instance.slots` 与 `slotProperties` 在事务与校验层使用无原型字典以安全往返特殊模板键。HTML-to-Forma 沙盒支持 `[data-forma-component]` 按真实变体尺寸水合并原地实例化受保护 `Instance` 与新造图层库 Token 吸附，节点使用 UUID 防止跨页碰撞；Blueprint 支持 `adapt` 外框显式 `detachInstance` 派生与多画板主/异常矩阵排布。`DesignChatContext` 预埋可选 `targetLibraryId`、`confirmedScope`、`selectionCount` 与三维 `memoryScope`（`{ projectId?, libraryId?, userId? }`）。Electron 桌面协议默认仅连自身托管 `localAgent` 并将非 5174 随机端口前缀编码入桌面 `FORMA_SESSION` 供 `server/mcp.ts` 零配置配对。[长期规格](specs/FORMA-AI-LIBRARY-AND-MEMORY.md)

**0.8.3 · 外部设计数据**　Sketch 的可选 `sourceTextLayout` 记录嵌入字体排版后的 Unicode、各行字符位置与基线。Figma 可选 `sourceTextShape` 保留原始字形轮廓和度量键。原文始终在文本节点上，编辑正文或度量、宽高会使原排版失效。叠加纯色填充与描边（`paints`、`strokePaints`）可分别以 `colorVariableId`、`opacityVariableId` 引用颜色及数值变量。文档解析、模式切换、组件库子集和工程编译使用相同的源 ID。Figma 组件插槽用独立辅助定义表示。当前变体的替换写入 `instance.slots`，未暴露槽的变体通过可选 `slotProperties` 保留源属性和组件引用。连续圆角通过 `cornerSmoothingModel` 指明源边界规则。后续兄弟蒙版保有原父子层级。源端绘图只供核对，运行时从文档计算外观。[格式及复验](specs/DESIGN-FILE-IMPORT.md) 对已归档的 Figma 样式保留可选 `sourceArchived`，旧节点仍按样式 ID 取色。渐变每层可保存 2–64 个独立色标；非线性源渐变的 `paintTransform` 记录从对象归一化坐标到颜料空间的仿射矩阵。

Figma 玻璃层在 `style.figmaGlass` 保存原始光学参数。源码场景仍有 Section 或组件集时逐层求出直达面和折射采样面，取出控件单独显示时使用 `glassEnvironment`，透明背景另有可选的 `glassSampleEnvironment`。普通不透明底色的两路相同。源归档中的形状、颜色和阴影保持独立，浏览器根据实时尺寸、设备像素比和源高斯宽度生成圆角纯色背板的覆盖遮罩。未提供字段的历史文档沿用单一环境。[折射范围与验收](specs/DESIGN-FILE-IMPORT.md)


**源材质与复合路径**　`src/compiler/material-composite.ts` 共享纯色材质的逐层合成和独立图形阴影。布尔组可用 `booleanOperation: "compound"`，以可选 `compoundWindingRule` 保留填充规则；其子层上可选的 `operandOperation` 指定此层相对下方轮廓的布尔运算。节点 ID 和子树保持可编辑。画布、原型、静态图和 React 通过 `booleanVector` 对当前子层的尺寸与可见性求值。[材质与复合路径验收](specs/DESIGN-FILE-IMPORT.md#键盘与警告框的材质阴影和复合路径)

**0.8.1 · 大型组件库**　导入 Worker 保有完整源文档，向主线程返回计数和可定位说明。确认后在同一 Worker 中写入 IndexedDB，写入成功才转到新文件。桌面使用限定到发起窗口的文件句柄按块交付。同一媒体在文档、组件库和前一版快照间复用。大页面的 React 工程把节点树写入按页面装载的 JSON，ZIP 分块输出。[读写协议](specs/LARGE-DESIGN-STORAGE.md) · [导入规格](specs/DESIGN-FILE-IMPORT.md)

**0.8.0 · 离线设计稿迁移**　`src/infrastructure/design-import/` 在可终止的 Web Worker 中识别文件、读取 Sketch JSON 或解释 Figma 内嵌 Kiwi schema、验证资源并生成原生文档。两个适配器输出同一 `ExternalDesignImport` 契约。编辑器在 `parseDocument` 校验和用户确认后通过 `createLocalFile` 写入独立文件；桌面把系统打开的原文件字节交给相同流程。schemaVersion 1 可选保存 `importReport`（文件名、格式、SHA-256、源记录数和定位信息）、显式实例覆盖、单色文字原始字形和度量键、独立的共享描边槽、可选 `strokeInLayout: false`（用于 Figma 不参与布局的画板描边）、图片填充透明度、四边内距/描边与四角变量绑定。既有文件可省略这些字段。画布、预览及 React 工程共用显示值；导出的 CSS 保留可表达的变量引用。主件更新沿变更节点和受影响实例传播，保留等于默认值的显式覆盖。[兼容清单和样本](specs/DESIGN-FILE-IMPORT.md)

**2026-11-22 增量（61 面板与多模型画布 Agent）**　schemaVersion 1 新增可选节点类型 `section`（仅允许位于页面根级或嵌套于 `section`，导出与运行时透明解包）与 `slice`（仅作静态与批量切片导出，不进入原型与 React 输出）；节点新增可选 `devStatus`、`exportSettings`、`annotations`、`interactions`；样式新增可选 `layoutGuides`、`cornerSmoothing` 及 `angular`/`diamond` 渐变；文档与页面新增可选 `comments` 与轻量 `setComments` 事务；图像填充新增 `rotation` 及 `exposure`/`temperature`/`tint`/`highlights`/`shadows`；变量新增 `platformCodeSyntax`；原型新增 `smart-animate`。旧文件完全兼容。模型接入扩展为 13 家供应商自动识别与三协议适配，凭证由本机 `0600` 配置文件（`server/agent-config-store.ts`）管理，不进入设计文件与浏览器存储。[规格文档](specs/AGENT-PROVIDER-AND-CANVAS-CHAT.md)

**0.6.4**　`image.fit` 支持 `tile`，可选 `tileScale` 为 0.1–8 倍，`brightness`、`contrast`、`saturation` 为 0–2。缺省倍率和调色均为 1。裁切和平铺保留各自的倍率，共用焦点。所有调整存于图层，对同一素材的其他引用独立；素材 ID 和原图字节保持稳定。文档事务及历史复制资源元数据，复用不可变的编码字符串。运行时和静态 SVG 共用图像绘制参数；位图蒙版沿用源图的透明度和调色结果。[编辑及交付规格](specs/PROFESSIONAL-EDITING.md#位图填充与裁切)

**0.6.1**　schemaVersion 1 新增可选文件字段 `colorProfile` 和 `exportColorProfile`，取值为 `srgb` 或 `display-p3`。省略前者时按 sRGB 解释原有六位 HEX；省略后者时 React 工程使用文件色域。指定与转换均作为一次文档修改，可撤销。转换图层时保留变量和样式定义的通道数值。选择其他导出色域时单独换算交付工程的颜色，ZIP 中附带可重开的原生稿。导入的图像保留原始编码。[双端验收](specs/EDITOR-PANEL-ACCEPTANCE.md)

**0.6.0**　可编辑矢量每个路径的可选 `junctions` 用 `{contour, anchor, id}` 记录共用锚点，索引从 0 计。区域形状和填色仍由各路径的 SVG 与绘制属性表达。组件集使用带 `componentSet: {libraryId, componentId}` 的画布组。库的主件、变体与实例沿用原 ID。旧文件的字段均可省略，`schemaVersion` 为 1。[专业编辑规格](specs/PROFESSIONAL-EDITING.md)

**0.5.0**　设计文档版本仍为 1。可选的 `layoutBreakpoints[].fill/radius/opacity` 由画布与播放器共享解析；存储不透明度为 0–1。公开属性使用稳定 ID 和目标模板键，`previousNames` 保存改名前的工程参数，现名优先。整文件工程可由业务路由传入稳定画板 ID。[工程更新](specs/REACT-PROJECT-UPDATES.md)

**0.4.0**　schemaVersion 1 增加可选网格轨道、子层起始单元格、蒙版模式、字体资源和公开组件属性。缺省字段沿用原有几何、矢量蒙版与系统字体。`layoutBreakpoints` 按容器自身宽度从宽到窄继承。嵌套实例的替换引用写入 `instance.slots`，自定义组件集沿用首个主件引用，追加变体通过 `masterNodeId` 标记各自可编辑的源图层。模板通过可选 `nestedPath` 记录各级稳定键，分别匹配外层和内层覆盖。旧的两层制品仍可使用 `nestedKey`。已公开属性按外层稳定目标映射，导出的 React 工程自带字体资源。发布服务使用同一组件库校验器，通过修订和 ETag 防止覆盖较新的发布。 [规格与操作入口](specs/PROFESSIONAL-EDITING.md)


2026-11-20。状态：已确认产品方向；架构逐项通过实现验证。当前进度见[编辑器验收](EDITOR-ACCEPTANCE.md)。

## 已确认的产品合同

- 面向设计师，支持 Agent 原生生成、全手动创作、设计系统复用、设计到代码交付。
- 交付 React + TypeScript，保留布局、组件、Token、资源及明确声明的交互。业务接口由开发接入。
- 首个可验收产品同时覆盖 Web、移动 Web/H5；不要求原生移动代码。
- 复杂原型包括多流程、浮层、滚动、交互组件、变量、条件分支、多动作；不要求真实业务 API 和时间轴动画。
- 现阶段不要求企业内网运行，允许使用开源技术。后续私有化要能替换模型、存储、身份与基础设施。
- PDF 是研究输入，其中的套餐、产品限制、推荐排期及“不能部署完整开源套件”不自动成为本项目要求。

## 架构依赖方向

编辑器与 Agent 适配器 → 应用服务 → 领域模型 / 命令 / 校验。
持久化适配器实现 Repository 接口。代码编译器读取有效文档，不能改变文档。 大型原生文件按记录流式读写，IndexedDB 以事务保留两代图层分片和它们共同引用的媒体。详见[大型设计文件的资源、保存与恢复](specs/LARGE-DESIGN-STORAGE.md)。
UI 选择、缩放、拖动预览等会话状态不进入设计文件；组件、变量、交互关系必须进入设计文件。

| 层 | 当前路径 | 职责和限制 |
| --- | --- | --- |
| 领域 | src/domain | 原生节点、层级不变量、版本、事务；不引用 React、DOM、HTTP 或存储 |
| 应用 | src/application | 文档修改与历史，未来承载协作、任务与权限 |
| 基础设施 | src/infrastructure | 浏览器存储、文件下载；未来增加服务端 Repository |
| 编辑器 | src/editor | 画布、图层、属性面板、资源、Agent 反馈；调用命令 |
| 编译 | src/compiler | 文档到 React/TypeScript、布局、变量、资源与声明式交互；全量生产验收进行中 |

采用 TypeScript 严格类型。运行时输入通过 Zod 校验，不能用类型断言替代外部输入校验。依赖版本以 package-lock.json 为准。当前采用 React 编辑器与 DOM 布局渲染；矢量使用 SVG，布尔曲线由 Paper.js 计算。是否引入 Canvas/WebGL 必须依据文件规模基准，不能以技术名称代替性能证据。

## 文档演进

当前 schemaVersion=1，保留稳定 ID、父子引用和绘制顺序。可选字段承载多页、组件库、变体覆盖、资源、主题别名、富文本、原型和布局规则。

0.2.1 在子层新增可选整数 `style.columnSpan`（1–64）。缺省跨度为 1；固定列按父网格列数截断有效跨度，剩余列不足时整项换行。自动列模式忽略此字段但保留原值。几何、Hug、预览与导出按同一规则计算。旧文件沿用原布局；旧客户端重新保存新稿可能丢失它不认识的字段。

组件实例必须保存主件 ID、发布版本和覆盖路径；渲染可展开，存储不得默默展开。Token 保存引用，导出为 CSS variables；别名需要类型与循环检测。父级布局模式与孩子尺寸规则需联合校验。

## 修改和恢复

手动入口与 Agent 入口共享事务。事务包含 baseRevision 和 operations；基准过期则拒绝。原生基础设计系统及 React 同步组件实现由用户确认。当前单文档事务全成或全败，历史最多保留 100 次本地操作。撤销产生新 revision，防止旧 Agent 请求重新变成有效。

当前版本按整文档 revision 拒绝冲突，未提供多人合并；未来协作必须增加服务端串行提交、幂等 transactionId、操作日志、细粒度 precondition 与冲突 UI，再评估 CRDT。取消 Agent 应丢弃未提交批次，已提交批次可定位撤销。现已提供服务端生成和取消：取消中止请求，结果先预览、再应用；跨用户任务与持久化任务队列尚未实现。

## 渲染与代码语义

布局解析应成为画布和导出共同消费的确定性中间表示。编辑器装饰、选框、辅助线和视口变换不能输出到业务页面。

生产导出分阶段：文档校验 → 组件/变量解析 → 布局与交互 IR → React AST → 格式化 → 工程包 → 独立安装、类型检查、浏览器对照。生成区域与开发业务扩展分开，后续设计变更不能覆盖手写逻辑。

画布几何、共享 nodeCss 与独立工程覆盖约束、网格及响应式画板。预览和工程共享原型运行时，可播放导航、浮层、条件与多动作。0.3.0 在网格容器的实际宽度达到阈值时应用窄屏列数与间距。节点可以指定跨行，容器可指定行高。色标引用、网格样式与跨文件库修订由文档事务校验。工程更新使用逐文件摘要核对生成区，业务入口和扩展文件由开发维护。[工程更新协议](specs/REACT-PROJECT-UPDATES.md)。

## Agent 接入

内置自然语言：ProviderAdapter 负责模型请求，应用服务负责上下文裁剪、组件检索、预算、取消、校验与提交。模型只能返回声明式操作，不执行模型产生的任意 JS。

外部 Agent 经本机配对会话使用 MCP 工具 read_design、list_components、propose_design。应用和撤销由设计者在编辑器操作；文件、选区或版本改变时需重新核验。[实际事务协议](AGENT-PROTOCOL.md)

凭证由服务端环境或 secret store 管理，不进入设计文件、不放浏览器持久化。已确认使用可配置 OpenAI 兼容 API；具体模型端点、模型 ID 和密钥待本地配置；不能用固定模板伪装真实 AI 生成。

## 私有化替换点

| 接口 | 本地开发 | 后续替换 |
| --- | --- | --- |
| DocumentRepository | 浏览器存储 | HTTP + PostgreSQL 文档/操作日志 |
| AssetStore | 待实现 | S3 兼容对象存储 / 企业文件服务 |
| ModelProvider | 待配置 | 云模型 / 企业模型网关 / 本地推理 |
| IdentityProvider | 当前单用户本地 | OIDC / 企业 SSO |
| JobQueue | 待实现 | 单进程 worker / Redis 队列 |
| TelemetrySink | 待实现 | 企业日志与审计系统 |

不依赖特定托管平台作为领域运行前提。私有化替换需契约测试和备份恢复演练，不能只改 URL 即宣称完成。

## UI 规范

布局：全局文件栏、左侧工作域导航、图层/资源/Agent 面板、中央画布、上下文属性面板。使用统一选区，模式切换保留文件与位置。多选必须显示 Mixed，不得隐式抹平差异。拖动与属性输入使用同一命令；布局流内重排与自由定位分开处理。

编辑工具采用紧凑中性色面板，紫色表达选区/组件/主要操作；错误消息不只依赖颜色。控件提供可访问名称、键盘焦点和禁用态。中文 IME、文本编辑退出、浮层焦点恢复、画布快捷键与输入框冲突分别验收。

当前编辑器针对桌面创作环境；“移动端支持”指设计并交付移动 H5，不默认承诺手机浏览器完成全套设计创作。

## 当前验证来源

用户确认的决定见交接文档，PDF 目录用于研究对照。技术文档复核：
- https://react.dev/learn/typescript
- https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Grid_layout
- https://github.com/modelcontextprotocol/modelcontextprotocol （SDK 版本由 package-lock.json 锁定）

第三方产品的最新价格和能力未逐项重新实测，不能将 PDF 的文档确认状态转换成我方完成状态。

## 手动编辑内核增量

当前新增 Group 与 Ellipse 原生节点；Group 边界随子层更新，与固定 Frame 分离。视口状态独立于文档；拖拽/缩放仅产生预览，释放时一次事务提交；取消不写入存储。文档事务、历史和 UI 选区分别管理，撤销/重做恢复选区。剪贴板使用独立版本化协议，复制完整子树和稳定引用，粘贴创建新 ID 并处理跨文档 Token 冲突。详见 CANVAS-COVERAGE.md。

## 组件库与交付增量

文档新增可选 libraries 快照，保持旧 schemaVersion 1 文件兼容。实例引用 library/component/variant，展开为可编辑原生图层；templateKey 用于跨变体匹配和保留覆盖。已使用的组件定义不允许原地变更。预览与导出使用同一份 FormaRuntime，导出工程没有对编辑器内部模块的依赖。完整说明见 MOBILE-LIBRARY.md。
