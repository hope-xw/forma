# Figma 设计文件迁移调研

最近更新日期：2026-11-23。状态：草案。适用目标：Forma Web 与 Electron 的 Figma Design 单次迁移。关联源码：`src/domain/`、`src/application/`、`src/infrastructure/`、`src/editor/`、`src/runtime/`、`src/compiler/`。本记录提供选型、样本和复验方法；原始盘点使用独立读取器，文末记录 Forma 原生适配结果。产品验收见[兼容规格](../specs/DESIGN-FILE-IMPORT.md)。

## 建议如何取得源数据

| 设计师手里的输入 | 可取得的数据与工程决策 |
| --- | --- |
| 通过 Figma「File → Save local copy」得到的 `.fig` | 首要入口。在本地读归档、树、组件、样式与资源。直接兼容须按实测容器、schema 与能力声明。Figma 将该格式列为可能变化的专有格式；本地副本不含历史和评论。提供固定版本解析器、持续回归样本和未知能力诊断。是否可导出由源文件复制权限决定。[Figma 官方本地副本说明](https://help.figma.com/hc/en-us/articles/8403626871063-Save-a-local-copy-of-files) |
| Figma Design 分享链接，含或不含 `node-id` | 可选在线辅助路径。校验域名、文件类型、fileKey / branchKey；把 `221-56229` 规范成 `221:56229`。显示导入整文件或该子树的选择。以已授权只读身份获得固定的文件版本；先取页面清单，按选择取树，按所需依赖补取主件。选中节点消失、版本变化、拒绝访问和限流应得到不同结果。公开地址自身不携带本地副本字节。[文件端点及依赖范围](https://developers.figma.com/docs/rest-api/file-endpoints/) · [鉴权](https://developers.figma.com/docs/rest-api/authentication/) |
| 在可打开的设计文件内运行导出插件 | 作为专有格式变更后的恢复路径与生成对照真值的方法。插件可以调用节点的 `exportAsync({format: "JSON_REST_V1"})`，再采集二进制图像、样式定义、变量模式、组件与实例依赖，按版本化 manifest 写到本地包。复杂节点另导出参考 PNG；需要可编辑矢量时采集路径/网络。记录选区或页范围与依赖完整度。此为推荐协议，Forma 目前没有发布该插件。[插件导出格式](https://developers.figma.com/docs/plugins/api/ExportSettings/) · [图像字节](https://developers.figma.com/docs/plugins/api/Image/) · [变量 API](https://developers.figma.com/docs/plugins/api/figma-variables/) |
| SVG、PNG、PDF 等渲染制品 | 可核对外观或置入素材；制品通常缺少主件、覆盖和变量定义。完整文件迁移需要结构化输入。Sketch/Figma 渲染同一套件的图片也只能用于外观抽查。 |

Figma 官方 REST 的 `GET /v1/files/:key`、`GET /v1/files/:key/nodes` 需要 `file_content:read`。按节点读时，`geometry=paths` 用于取得路径，`components`、`componentSets`、`styles` 提供元数据；映射器还要找实际定义及节点有效值。节点响应可能为 null；记录漏取范围。通过 `GET /v1/files/:key/images` 取图像填充原件并下载、校验、固化为文件资产，该端点链接最多 14 天过期；`GET /v1/images/:key` 得到节点渲染图，两者用途不同。可带 `version` 的请求共用同一版本号；无法按版本读取的关联资源要校验并记录差异。429 遵循 `Retry-After`；按节点批取、允许取消；认证数据留在专用服务，避免进入设计文件、项目导出或日志。[文件与图片端点](https://developers.figma.com/docs/rest-api/file-endpoints/) · [限流规则](https://developers.figma.com/docs/rest-api/rate-limits/)

变量端点 `GET /v1/files/:key/variables/local` 需要 `file_variables:read`，官方限制为 Enterprise 的 full members。普通文件 JSON 的 `boundVariables` 可证明存在绑定；仅有绑定 ID 无法推导整套模式值。插件或原生文件能补齐时按源键连回；其余场景记录绑定、可见值与缺失的定义。外部库订阅 ID 会变，应以可得的库/资产稳定 key 和版本标识快照。[变量端点和身份限制](https://developers.figma.com/docs/rest-api/variables-endpoints/)

## 可以复用什么

| 实现 | 核查结果 | 对 Forma 的取舍 |
| --- | --- | --- |
| OpenFig `openfig-core@0.4.1` | npm 发布对应 `f9f10d0`，声明 MIT；实装依赖为 `fflate@0.8.3`、`fzstd@0.1.1`、`kiwi-schema@0.5.0`，三者包元数据均为 MIT。读取 ZIP、原始 `canvas.fig`、schema、节点与 blobs。 | 作为受控样本的研究基准。源码 `parseFig` 同步展开完整归档；`compileSchema` 通过 `new Function` 编译由文件提供的 schema。产品侧需要有字节/深度预算的解码器。优先采用解释执行数据描述的 Kiwi 读取器，或在构建期为已审查 schema 生成静态 decoder，按解压后 schema 哈希注册；新 schema 走显式兼容处理。保留 Worker 取消机制；避免要求页面放宽 CSP。[发布对应解析源码](https://github.com/OpenFig-org/openfig-core/blob/f9f10d0fc7e6ad3dd7ce94fe3e3da3ffb5eec5d6/src/parser.ts) · [Kiwi 实现](https://github.com/evanw/kiwi/tree/1b96d916f9b7bf9ce54d3db3491735a73cce7dec) |
| Grida `@grida/io-figma` | `ec37e72` 的包同时提供 Kiwi、REST 转换思路；仓库根许可 Apache-2.0，此包标记为 private，引用多项 workspace 包。 | 用其格式案例、位置排序和跨输入对照方法。Forma 保留自己的领域映射与验收；选取源代码或资源时逐项核对许可和归属。[固定版本转换器](https://github.com/gridaco/grida/tree/ec37e72de9cee80f4f19f381e916f386b986e1d8/packages/grida-canvas-io-figma) · [仓库许可](https://github.com/gridaco/grida/blob/ec37e72de9cee80f4f19f381e916f386b986e1d8/LICENSE) |
| Penpot Exporter for Figma | 官方插件为 MPL-2.0，作者列出组件集、实例、变体、自动布局及库迁移能力；也列出大文件遍历、原型迁移等限制。 | 用作插件打包路线的行业参照。把页面树、资源及定义一并迁移，另外验证目标编辑器里的布局、绑定与实例行为。此处没有采用插件代码。[Penpot 开源实现](https://github.com/penpot/penpot-exporter-figma-plugin) · [Penpot 官方迁移指南](https://help.penpot.app/user-guide/first-steps/migration-guide/) |
| OpenPencil | 维护者公开说明复杂文件回存可能产生组件、颜色或文字差异，图层数相同也可能存在视觉损失。 | 为每个关键样本同时建立源端渲染和语义清单，分别检查。[维护者的格式与兼容说明](https://openpencil.dev/reference/file-format) |

## 对用户样本的核实

11 月 22 日，公开页面和官方 oEmbed 返回文件标题，连接器未取得该文件的编辑访问权。11 月 23 日，项目组从本机 Figma 保存了同一文件的原生副本。完整文件为 160,736,706 字节，SHA-256 为 `d6a0a6370b17f5c109d5ef227915ef6d59bf0da23076292e09fb87fd5e63a11a`，内层 Kiwi 版本为 106。链接所指 `221:56229` 是名为 Cover 的页面，含一个 1920 × 1080 顶级画板 `2401:4`。原件仅作本地核对。[源文件节点](https://www.figma.com/design/XTOyd84JxBQbg3hEZKLGWs/iOS-and-iPadOS-27--Community-?node-id=221-56229)

原始快照含 37,738 条记录、5,615 个二进制 blob、46 个普通页面、1 个内部页面、420 份位图、10 个变量集合及 473 个源变量。233 个共享样式分为 111 个文字、120 个填充和 2 个效果。4,749 个原始主件按源组件集组织为 2,551 个可复用组件。

普通页 10,657 个源图层逐一通过改存和重开的 ID、原名、父级和同级顺序对照。1,807 条普通页源文本按完整 Unicode 字符串比较。组件展开后的文字和图层单独计数。12,565 个源实例中 4,101 个位于普通页，8,464 个位于内部页。按源 master GUID 分别检查普通页实例与内部模板。可以运行 `node --import tsx --max-old-space-size=8192 scripts/check-original-figma.mjs "本地副本.fig"` 重做结构与序列化审计。

本稿用 `varValue.value.slotContentIdValue.guid` 持有 297 个独立内容树，295 个在实例自身属性中，2 个在实例覆盖中。实际来源是内部页标记 `isSlotContent=true` 的 FRAME。对应可选区域由 `componentPropRefs[].componentPropNodeField === "SLOT_CONTENT_ID"` 识别，共 96 个原始宿主。Forma 建立单列的「Figma 插槽内容」辅助变体，把实例选择和可编辑后代写入原生文档，重置仍可回到原始主件。被应用的内部实例及文字与普通页面分别计数。源套件的自由增删和 Figma 的推荐项约束仍受 Forma 实例编辑规则约束。[Figma Slots API](https://developers.figma.com/docs/plugins/api/SlotNode/) · [Figma 组件属性](https://developers.figma.com/docs/plugins/working-with-component-properties/)

源中 105 个蒙版覆盖本层之后到下一个蒙版之前的兄弟。画板本身及较早兄弟保留。501 个行或列保留负间距；重叠顺序由 `stackReverseZIndex` 决定。198 条 Glass 效果中 196 条启用。适配器保存来源霜化、折射、反光和色散参数，浏览器按可表述的背景模糊绘制。物理折射、色散、未随文件提供的共享样式、缺失的覆盖 GUID 及复杂描边在报告中逐源定位。[Figma GlassEffect](https://developers.figma.com/docs/plugins/api/Effect/#glasseffect)

## 已做的本地解码实验

macOS，Node 25.8.0，临时目录中单独安装上述解析器，按提交下载三个上游测试文件，仅作本地只读测量。LFS 下载使用实体文件并与 LFS 指针 SHA-256 比对。研究用 openfig-core、第三方设计稿、字体及图片均保存在临时目录。产品解压依赖见文末。

| 样件 | 字节 / SHA-256 | 文件头版本 | 原始记录及可检查内容 |
| --- | --- | ---: | --- |
| [OpenFigs.fig](https://github.com/OpenFig-org/openfig-core/blob/0d67354fcd6d14c37b89c42f55330faf0a79e1ce/test-fixtures/OpenFigs.fig) | 48,052 / `eecd50d4d4135ab4b146bbbb7079b7b0743ee0325f2b8e6f2b37454b59c79c4b` | 106 | 5 条；1 普通页、1 内部页、1 VECTOR、1 FRAME、1 DOCUMENT；21 个 blob。 |
| [components.fig](https://github.com/gridaco/grida/blob/ec37e72de9cee80f4f19f381e916f386b986e1d8/fixtures/test-fig/L0/components.fig) | 29,545 / `1fbdc089f3ab1ad5f7866d7ee37c096de34cb3c07ec26222991f4954dc022437` | 101 | 19 条；4 个普通页、1 个内部页、4 个 SYMBOL、8 个 INSTANCE；8 个主件 GUID 全部命中。 |
| [Figma Simple Design System](https://github.com/gridaco/grida/blob/ec37e72de9cee80f4f19f381e916f386b986e1d8/fixtures/test-fig/community/1380235722331273046-figma-simple-design-system.fig) | 7,911,644 / `baf0a1b1154a8e4ad98b2143482fddbcbeee13415f7fd672af71d973a67e1c2b` | 101 | 9,586 条；30 普通页、1 内部页、2,720 SYMBOL、1,685 INSTANCE、1,086 TEXT、2,088 VECTOR、13 VARIABLE_SET、407 VARIABLE、26 图像、5,429 blob。 |

三个样本的父引用缺失、重复 GUID 均为 0；三者的文本内容与层名未检出 U+FFFD。该检测不能发现所有编码错误。三个样本的 schema chunk 都是原始 DEFLATE，message chunk 都有 Zstandard magic。两个版本号同为 101 的文件，其解压 schema 的 SHA-256 分别以 `4ed49ada7171`、`3b430d14c850` 开头，不能只按头部版本号挑选解码器。原始头、旧式 DEFLATE 消息、中文、RTL、emoji 与复杂材质仍需要独立金标。

在 Simple Design System 中，1,685 个实例的 `symbolData.symbolID` 均能定位记录。313 条记录带 `styleType`。文字、效果、填充、描边填充四类引用分别有 758、234、42、2 处，其中 751、233、30、0 处可由本文件 GUID 直接解析，其余 7、1、12、2 处持有 `assetRef`；这 22 处需要继续按外部 key/版本解析或记录未决依赖。个数含内部页和定义；语义清单需区分画布实例、组件定义以及内部样式宿主。

共有 1,198 个父记录带两个以上子记录。按 `parentIndex.position` 的原始字符序排序，有 278 组与序列化记录次序不同；改用本机默认 `localeCompare` 则有 283 组与原始字符序不同。应按同一父级内位置键稳定排序，层面板按 Forma 显示惯例呈现，在叠放测试中核对实际绘制顺序。原作者介绍的 fractional index 使用可打印 ASCII 表示；Grida 明确要求按 code point 比较。[原作者的顺序索引说明](https://madebyevan.com/figma/realtime-editing-of-ordered-sequences/) · [Grida 位置键实现笔记](https://github.com/gridaco/grida/blob/ec37e72de9cee80f4f19f381e916f386b986e1d8/docs/wg/feat-fig/glossary/fig.kiwi.md)

### 怎样复验

在临时目录保存上表三个固定版本的原件，使用 `shasum -a 256 *.fig` 对照。安装 `npm install --ignore-scripts --save-exact openfig-core@0.4.1`，确认 `npm ls --depth=2` 与上述版本相同，然后运行以下只读检查。研究用解码器仅用于表内已固定的样本。

```js
// node inventory.mjs <file.fig>
import { readFileSync } from "node:fs";
import { parseFig, nodeId } from "openfig-core";

const doc = parseFig(readFileSync(process.argv[2]));
const types = new Map();
let matchedMasters = 0;
let orphanParents = 0;
for (const node of doc.nodes) {
  types.set(node.type, (types.get(node.type) ?? 0) + 1);
  const master = node.symbolData?.symbolID;
  if (master && doc.nodeMap.has(nodeId({ guid: master }))) matchedMasters++;
  if (node.parentIndex && !doc.nodeMap.has(nodeId(node.parentIndex))) orphanParents++;
}
console.log(doc.header, doc.nodes.length, Object.fromEntries(types), {
  imageCount: doc.images.size,
  blobCount: doc.message.blobs.length,
  matchedMasters,
  orphanParents,
  duplicateIds: doc.nodes.length - doc.nodeMap.size
});
```

## 将已读到的数据变成可编辑文件

1. **识别与解码。** 根据字节识别归档和原始流，再校验唯一的目标条目、`fig-kiwi`、chunk 长度、schema 摘要和消息类别。旧裸文件、尾部缩略图、未知 chunk 必须作为各自的版本案例。并列建立外层归档、解压输出、单张图片像素、嵌套深度和实例展开预算。预检到未知特性时显示受影响源 ID、页及恢复办法；未通过校验前只保存在暂存文档。
2. **重建图。** 用 `(sessionID,localID)` 和源文档命名空间生成稳定 ID。用 `parentIndex.guid` 与 `position` 建树，重复键、环和孤儿要有可重现的位置。区分内部页的共享定义、孤儿定义和设计师页面。将绝对/局部变换、裁切和可见性分别归一化。运行时支持的仿射子集用矩阵重算验证；含镜像、剪切、深层旋转的案例不能从绝对外接框反推。
3. **组件、覆盖和设计系统。** 第一遍登记 SYMBOL、组件集/变体关系、属性、样式和变量，第二遍解析 `symbolID`、`symbolOverrides` 及指向嵌套实例的稳定键路径。对实际库 key/版本缓存本次快照，外部缺失时保留源引用与可得渲染。用独立实例多次修改文字、切换变体、重置覆盖、编辑主件传播，再保存重开检验。变量分别保留集合、模式、类型、别名和绑定；同名资产不会自动合并。
4. **文字、资源与材质。** 按源字符串与其范围索引单位保留 `textData.characters`、字段级样式、段落换行、混合字体和排版属性；用 CJK、阿拉伯文、组合附加符、代理对、ZWJ emoji 验证。缺字体时保留原始描述、fallback 和受影响文本 ID。将 `images/*` 或插件图像字节去重并保留裁切矩阵。将矢量网络、路径 blob 和布尔运算分别映射，记录转成普通路径后丢失的编辑能力。毛玻璃、蒙版、位图滤镜、透明叠层用同背景单独做渲染差分。可视参考图/隐藏底稿不能计入原生编辑成功数。[Figma 文字属性](https://developers.figma.com/docs/plugins/api/TextNode/) · [开源矢量解析](https://github.com/OpenFig-org/openfig-core/blob/0d67354fcd6d14c37b89c42f55330faf0a79e1ce/docs/vector.md)
5. **对照与回归。** 从同一自制 Figma 源稿保留本地 `.fig`、公开 API 或插件导出的语义清单、指定 frame 的源端 PNG，并固定字号、色域、视口、背景和缩放。依次核对普通页、父键/绘制顺序、字符串与富文本范围、实例与样式引用、可见资源、几何与视觉；最后走实际导入、修改、撤销、保存重开、播放和独立 React 工程。任何严重差异应标记具体图层，保留原始文件和上次可用文档。用用户给定 iOS/iPadOS 27 样本作专项目标，持续用可分发的自制样本跑 CI。

## 原生适配结果（2026-11-22）

产品入口使用 `src/infrastructure/design-import/figma.ts`。原生 Kiwi 类型解释器位于 `figma-kiwi.ts`，生产依赖采用 fflate 与 fzstd 0.1.1，类型表只作为数据读取。外层 ZIP 与原始流均可导入。单个 schema 解压上限 2 MiB，消息解压上限 128 MiB，原始记录上限 100,000。实现检验 UTF-8、GUID 唯一性、父子环、页面与展开预算。产品字段映射位于同目录的 `figma-layer.ts`、`figma-vector.ts`、`figma-styles.ts`、`figma-alpha.ts`，仓库测试位于 `tests/figma-import.test.ts`。原生测试与样本逐项结果如下。

| 对照内容 | 核验结果 |
| --- | --- |
| 原生文件与字符 | 三份固定哈希的真实文件均通过导入及 `parseDocument`。自制 Kiwi 二进制同时以裸流与 ZIP 读取，逐字比对中文、阿拉伯文、代理对、组合音符和 ZWJ emoji。在构建文档前检出截断文件。 |
| 组件与页面 | OpenFigs 取得 1 普通页、2 个可编辑图层。components 取得 4 个普通页、13 个图层，8/8 实例的同文件主件匹配。通过跨页修改主件、保留显式同值/半透明覆盖、重置继承、切换红蓝变体、保存重开。 |
| 大型设计库 | Simple Design System 取得 30 个普通页、18,360 个展开图层。73 个本地组件库包含 2,332 个组件、2,720 个变体、745 个外露属性；普通页实例包含 58 个已实际替换的嵌套插槽。源文件的 1,685 个实例中，普通页 1,078 个全部获得实例链接并通过结构验证；607 个位于内部专用页。SDS 两条引用描边样式的源记录均能按 asset key 找到本地已有的 paint 定义。普通页 Simple 使用 Cyan 描边，保留 10 px；内部专用页的 Checkbox Icon 引用 Component Set: Stroke。染色样式在填充与描边之间复用同一 ID。保留 313 个共享样式、407 个源变量、26 个图片资产。其中 373 个变量带有源文件的平台代码语法。修改封面文字后完成事务、序列化、重新解析。 |
| 模式与透明度 | 同一集合中的颜色变量拆分为 RGB 和所需的 Alpha 数值变量，SDS 共派生 29 个。保留别名的模式引用。以源绘制状态区分已经烘入 paint.opacity 的 Alpha 及附加透明度倍率。在同一测试中，亮/暗模式由红色 0.2 切换至蓝色 0.8，额外 50% 油墨倍率产生 0.1 / 0.4。对照处理覆盖填充、文字及描边。 |
| 位图堆叠与裁切 | SDS 的 48 处纯色与位图组合按实际层序处理，11 处可表示的 STRETCH 裁切矩阵转换为缩放及焦点。独立 Chrome 像素检查，白底上 50% 红色与 20% 蓝图两种排列在运行时和静态 SVG 的中心 RGB 分别为 (204,102,153)/(204,102,153) 与 (229,102,127)/(229,102,128)。 |
| 矢量 | SDS 1,739 个纯描边 VECTOR 中，1,729 个符合中心线转换条件，按网络起终点、曲线切线、原始 cap/join 和 normalizedSize 转换为可调线宽的开放/闭合路径；其余采用源轮廓。中心线与轮廓都能继承主题颜色。对 1,723 组不同的源网络引用、尺寸与宽度组合，将源文件 strokeGeometry 与结果在 Chrome 分别栅格化为 96×96 Alpha 图，并按任一侧有墨水的像素汇总，平均绝对 Alpha 误差 1.55/255。 |
| 封面真实渲染 | 导入 Figma 封面 1920×1080、自动布局换行、图标圆弧。独立浏览器验收将导出图缩为 400×225，对照源归档自带相同取景缩略图，90,000 像素中 7,495 个像素至少一通道差值大于 16（8.328%）。此为采用系统后备字体的基线，Whyte 字形缓存的单独复验见下。 |

在 Node 无本机字体 API 的环境中，SDS 适配器报告包含 387 项按源节点与细项去重的诊断。230 项是原型交互。91 项是部分覆盖路径，其中 77 项包含源文件里已经不存在的目标 GUID，14 项的目标路径不在当前主件树。另有 18 项变量字段、7 项额外填充颜色绑定、6 项超出属性范围的变量、4 项独立矢量描边颜色绑定、2 项共享样式引用等保留了导入当时的值。14 项实际图层或派生覆盖采用描边轮廓。7 项尺寸限制、6 项负间距、2 项超长名字会影响与源数值的逐项对照。报告附源 ID，缺失引用无法据此恢复。文件内的几何及样式能力与可用字体仍需按具体稿件验证。Apple 文件于次日取得本地副本，专项核验见上文。

### 原稿字形与可编辑文字

`figma-glyphs.ts` 读取 `derivedTextData.glyphs` 中的轮廓、字号与位置。坐标按 em 缩放，以 `position` 为原点翻转 Y 轴，并在行框定位时保留字体小数上升量。源位置包含基线、字间距和对齐。完整单色轮廓随原生文字节点保存，能区分同一家族的不同字体修订。原稿字号、颜色、透明度和 Unicode 字符串均可编辑。修改内容、字体、宽高或排版特性时重新排字，撤销可恢复原始轮廓。混合文字样式、文本截断、缺失字形数据及无法验证的覆盖使用普通可编辑文字。

每层最多 512 个字形、2,048 个 UTF-16 单元与 100,000 个 SVG 路径字符。整份文件含普通页及可复用组件的轮廓预算为 96 MiB。Apple 完整 Figma 稿展开的 11,441 个文字节点中，10,066 个保留了源字形。1× 的小尺寸单色文字从这些可缩放轮廓采样覆盖率。大尺寸、带外伸笔画和其他缩放倍率的文字使用矢量。全链路入口和原厂图采样条件见 [Apple Figma 验收脚本](../../scripts/check-apple-figma-import.mjs)。

0.8.0 的第一版仅在缺少本机字体时保留轮廓，总预算为 8 MiB。固定 Simple Design System 样本中，Whyte 封面三个文字层 `125:27`、`125:29`、`125:31` 均保留 6 个字形，共 8,294 个路径字符。模拟全部字体缺失时，第一版保留 1,257 个文字位置及 8,387,251 个路径字符。以下缩略图测量对应这次历史验证。

独立 Chrome 以源位置绘制这三行局部路径，在 400×225 原缩略图上取对应词及其下降部区域，以每像素 RGB 的最大通道差求平均，Simple、Design、System 分别为 5.10、3.52、3.83（0–255）。对比使用源归档 `thumbnail.png`。另用产品 `exportNodeToSvg` 导出整张 1920×1080 封面，经 Chrome 直接栅格为 400×225，90,000 个像素中 2,489 个像素最大通道差大于 16（2.766%），最大通道差均值为 3.42。React 工程的真实交付截图另见编辑器验收。

### 自动布局中的描边

三个真实文件内嵌的 Kiwi NodeChange 类型表均声明布尔字段 `bordersTakeSpace`。SDS 有 921 个设置自动布局且包含可见描边的原始记录，全部省略该字段。按原始文件的几何和 Figma REST 的缺省语义，适配器将省略或 false 映射为 `strokeInLayout=false`；显式 true 保持描边参与内距及尺寸计算。描边专项测试逐一覆盖省略、false、true 三种输入。不同 Figma 版本新建文件时的 UI 初始选项与既有原稿的几何应分别确认。[Figma 描边与布局计算](https://developers.figma.com/docs/plugins/api/properties/nodes-strokesincludedinlayout/) · [Figma 文件节点属性](https://developers.figma.com/docs/rest-api/file-node-types/)

在尺寸 1920×1080 的封面上，Simple 外框始终为 (533, 228) 至 (1307, 530)，内描边 10 px、左内距 100 px。修复前文字边框为 (643, 308) 至 (1217, 440)，修复后与源图层的 (633, 308) 至 (1207, 440) 一致。Design 和 System 的文字边框分别为 (285, 630) 至 (868, 762)、(1026, 630) 至 (1654, 762)。用同一 React 运行时及 1920×1080 桌面视口截取前后两张 PNG，采用验收脚本的 sRGB Canvas 高质量缩放至 400×225，与同一归档缩略图的通道差大于 16 的像素数分别为 3,833 和 3,058，占比从 4.25889% 降至 3.39778%；每像素最大通道差的均值从 3.8584 降至 1.5783。


## Apple Figma 整档与光学上下文复核

本机从原稿取得的 Kiwi 106 快照有 37,738 条记录。对 46 个用户页面逐层检查 GUID、父节点、兄弟顺序和文本，重开可携副本后仍通过。4,101 个普通页实例和 8,464 个库内实例共 12,565 个，均保有同一源主件。297 个自由插槽内容组中，293 个参与被选变体的已保存赋值，另 4 个保存在当前变体未显示的 Buttons 属性上。原件带 233 条可解析样式记录，其中 88 条在用、145 条已归档。在可编辑的页面和组件模板中，另有 132 个可定位的源渐变图层，共 298 个色标，已逐层对照保存重开的结果。复核以源文件、源记录和独立读取后的结果逐一比对。[原始统计与原生重开](../evidence/2026-11-23/apple-figma/native-roundtrip.json)

原厂 exportAsync 按 useAbsoluteBounds=true 导出了主验收的 6 个对象，并从实际组件树另取 5 个开关状态及其组成层。隔离图显示 Figma 的玻璃可以采样选区背后的组或 Section 颜色；白背景、黑背景和带透明度的背景需要分别比对。在完整原生文件重开与独立 React 工程中，6 个真实开关场景在 Chromium、Firefox、WebKit 的 18 项检查均符合单图 0.5% 阈值。10% 黑底按下关态三端分别有 3、2、5 个超差像素，按下开态为 5、7、5 个。初步隔离测量和最终整稿测量分别记录，实测表保存源图和候选的 SHA-256。字体、组件、路径、调色参数均保存在可编辑节点或样式上。[补充控件测量](../evidence/2026-11-23/apple-figma/optical-context.json)
