# Sketch 原档导入调研

最近更新日期　2026-11-23  
状态　草案（已核对源格式和样本，供实施与验收使用）  
关联源码路径　`src/domain/document.ts`、`src/domain/node.ts`、`src/domain/component-masters.ts`、`src/domain/library.ts`、`src/domain/design-system.ts`、`src/domain/rich-text.ts`、`src/infrastructure/`、`src/runtime/`、`src/compiler/`  
验收方法　只读盘点原档、原厂渲染器生成参照、逐 ID 核对可编辑语义，并复验保存、重开、预览与工程导出。

## 用户样本识别

指定的 `apple-ios-27-ui-kit_assets_2026-10-27_v32/` 共有 **150 张 PNG、1 个 SVG、7,105,722 字节**。逐文件检查 ZIP 结构，结果为 0 个归档。151 个相对路径只有 30 个不同 basename，按 SHA-256 有 118 种内容。137 个路径含私用区补充平面码点 U+100EC3。实施时按完整相对路径解析引用，按字节摘要合并资源存储，用原名展示。预期字体缺失可使符号显示成方框，码点和命名必须原样保留。这个目录可验收资源查找、重名与 Unicode；页面、实例覆盖和样式定义需要原始文档。

Apple 资源页的 Sketch 按钮指向公开的「Apple iOS 27 UI Kit」库。2026-11-22 在网页看到「Download Assets (ZIP 7MB)」及独立的「⋯ → Document → Download」，后者进入 Apple 设计资源许可确认。公开 Pages 菜单可见 Buttons（`DFCF7064-B052-4DCA-B903-9052EE7AB4BD`）、Color Pickers、Keyboards 等，名称本身含补充区符号。11 月 22 日的调查覆盖公开页面和资源目录。11 月 23 日用户另行提供原档，当前测量见下文。Apple 样本作为本地对照，遵循项目既有自研与分发边界。[Apple Design Resources](https://developer.apple.com/design/resources/) · [Apple 在 Sketch 发布的原库](https://www.sketch.com/s/04c24d8b-38fb-4afb-8836-36617e022f02)

## 可借鉴的工具与入口

| 做法 | 工程采用方式 | 核对来源 |
| --- | --- | --- |
| Sketch 43 引入 ZIP + JSON，`document.json` 链接页面，包内有原尺寸图片、缩略图、文件元数据 | 按魔数和必需条目识别容器。根据文档的 `pages` 引用顺序加载；目录扫描只用于定位资源及核对完整性。保留 `meta.appVersion`、`version`、`compatibilityVersion` 三个独立值 | [结构](https://developer.sketch.com/file-format/) · [版本含义](https://developer.sketch.com/file-format/versioning/) |
| Sketch 官方发布 JSON Schema、生成的 TypeScript 类型及读取库 | 当前核到 `@sketch-hq/sketch-file-format` / `-ts` 为 6.5.0、`@sketch-hq/sketch-file` 为 1.1.5；官方 monorepo 是 MIT，2025-04-10 归档。用固定版本检查已知结构，并保留未知字段的诊断。新格式必须补覆盖后再列支持。项目已有 fflate，可在浏览器 Worker 读取包，避免直接引入 Node 文件系统依赖 | [官方规格](https://developer.sketch.com/file-format/spec) · [官方 monorepo](https://github.com/sketch-hq/sketch-document) · [官方参考样本](https://github.com/sketch-hq/sketch-reference-files) |
| Figma 自身将 Sketch 页与 Symbol 转为本地页与组件，另行处理发布、跨库重连和本机字体 | Forma 先恢复文档内定义和库快照，保留库身份以供后续重连；发布走现有显式流程。字体名、字段解析和字体可用性分别测 | [Figma 的 Sketch 导入说明](https://help.figma.com/hc/en-us/articles/360040514273-Import-Sketch-files) |
| Sketch 自带 `sketchtool` 提供检查和渲染；Sketch JS API 描述具体覆盖类型 | macOS 验收机固定原厂工具版本与字体，按画板 ID 导出参考图片。Web 端不需要安装 Sketch。开发阶段用模型 API 的语义对照 JSON 的实际字段 | [命令行](https://developer.sketch.com/cli/) · [Sketch API](https://developer.sketch.com/reference/api/) |

## 原生文件探针

在 macOS 上用标准库 `zipfile`、严格 UTF-8 和 JSON 解析归档，按页引用遍历 `layers`。本地主件和实例计入页内层数；文档级 `foreignSymbols` 中的定义另计，实例的虚拟展开层不重复计数。以下为源输入事实。

| 样本 | 版本与规模 | 引用与覆盖 |
| --- | --- | --- |
| Sketch 官方仓库 `with-color-variables.sketch`，提交 `4493900abbfa49ae82fbcb8ad85cccf2cc2256b0`；SHA-256 `25f08782f870235a33b8589dc812d54c915d7a5928ba3a8efd9a8c5e964b7204` | 9,127,304 字节，20 个条目，未压缩合计 10,401,481 字节；Sketch 91，文档版本 144，兼容版本 99；2 页、517 层、3 个普通画板、82 个文本层、14 项图像资源 | 46 个页内主件、68 个实例、2 个外部主件记录、3 个共享文本样式、3 个本地色变量、5 层带 `sharedStyleID`。75 项覆盖分别是 58 项 `stringValue`、11 项 `image`、6 项 `symbolID`。[原档](https://github.com/sketch-hq/sketch-document/blob/4493900abbfa49ae82fbcb8ad85cccf2cc2256b0/packages/file/src/__tests__/with-color-variables.sketch) |
| 本机 Sketch 安装库 `Artboard Template Inspiration-1F9A2024-2A9F-4A2B-8A38-30E23A1892D3.sketch`，SHA-256 `25f6438de5fb7a537f70faf744c1cbb4bc62adeb1961d18974ebb7c822ee3f2e` | 20,611,591 字节；Sketch 98，文档版本 146，兼容版本 99；8 页、353 层、11 个画板、47 项图像资源 | 1 个页内主件、22 个实例、1 项外部主件、14 项外部色变量；25 项图片覆盖、21 项文本覆盖。可检验外部资源与页内组件分计的必要性 |

用本机 `sketchtool Version 101 (181930)` 成功列出官方样本画板，并从 ID `7D250CCD-9628-4732-88AB-0736ED5E690B` 渲染 Overview 为 **375 × 1725 PNG**。画板位于画布 (1007, −424)。该 PNG 作为 Overview 的原厂参照。转换后的结果见本文「实施复验」。从上表固定提交取得文件后可用以下命令复现原厂参照。

```sh
shasum -a 256 with-color-variables.sketch
unzip -p with-color-variables.sketch meta.json
/Applications/Sketch.app/Contents/MacOS/sketchtool list artboards with-color-variables.sketch
/Applications/Sketch.app/Contents/MacOS/sketchtool export artboards with-color-variables.sketch \
  --item=7D250CCD-9628-4732-88AB-0736ED5E690B --formats=png --scales=1 --output=reference
```

## 适配与拒绝条件

1. **文件世代与读取预算。** 对 ZIP+JSON 用元数据版本和具体特征联合分派；遇早期二进制容器或旧文本归档，提供能识别该格式的 Sketch 版本另存副本的路径。只支持已测版本组合。未知的渲染字段至少报告页、层、字段路径与处置结果。解码前检查 ZIP 项数、路径、声明大小，实际解压字节设独立上限；位图解码与实例展开另计预算。缺页、实例循环、重复 ID 导致指向歧义时中止当前导入。
2. **树与几何。** 用 `do_objectID` 和父子边记录层级，保存原始兄弟序；同名层按 ID 区分。UI 图层面板和绘制的前后方向通过两个部分重叠且可命中的图层测试。Sketch `frame` 相对父级，`points` 为相对图形边界的归一坐标。组合旋转和水平/垂直翻转时算局部矩阵，保留离原点很远的页面及负坐标。在分组、解除分组与预览中回测命中位置。画板、普通组、裁切框、布尔子形状和蒙版作用域分别建模。[原厂坐标说明](https://developer.sketch.com/file-format/coordinate-systems)
3. **两遍连接。** 第一遍登记本地主件的 `symbolID`、对象 ID、样式/色变量定义与文档内外部定义快照；第二遍解析实例与覆盖。保留嵌套覆盖的完整路径、目标属性和原值，先处理嵌套换件再定位其子层覆盖。覆盖类型优先覆盖样本中的文本、图像、内部换件，并对样式、颜色、可见性、实例缩放另测。库缺少快照时列出缺失源身份；同名主件不能自动接替。最终要实测原生主件传播、受保护结构、实例局部覆盖和重置。
4. **样式与富文本。** 同时读样式定义、绑定、图层当前外观；用对象间关系区分共享默认值与局部覆盖，同色不自动合并成同一变量。映射主题、色域、透明度、复合填充、渐变顺序、边框位置、阴影和模糊。严格验证富文本 run 的边界及有效编码，保留 UTF-16 范围、整串原文、原始字体与字重。用中文、组合重音、ZWJ、双向文本、私用区字形测选区、换行、编辑后重开；合法的原文 U+FFFD 要与解码器新造的替换符分开。字体缺失提供字体名与受影响层，避免覆盖原文。
5. **高难特征与限额。** 新版 Stack、Smart Layout、复杂形状布尔、材质、蒙版链与颜色混合空间均需专项样本。一份样本的源图层数不会反映实例展开后的本地节点数；先算每页展开开销，再对照 Forma `documentSchema` 当前每页 10,000 节点、100 页的限制，以及 `nodeSchema` 对尺寸、渐变色标等约束。遇到超限不能截尾、改图层尺寸或把整页栅格化后计为成功。使用诊断给出可定位的缺口，保留源文件。
6. **验收闭环。** 固定源文件摘要、Sketch/字体/显示色域、画板和图层 ID，生成源树、定义表和原厂 PNG。逐页核对节点身份映射，检查兄弟序、文本码点、主件与实例、显式覆盖属性、样式绑定和资源引用。结构、外观与编辑行为分别判定。对 Overview 验证原点重置后的画板边界与子层坐标，在真实编辑器执行改文本、更新主件和样式、撤销、保存重开、原型预览、React 工程独立构建。待用户的原生 Apple 样本可用时，选键盘与按钮的浅深色和实例替换，增加当前世代回归，再公布其支持等级。

## 实施复验

本次通过 `src/infrastructure/design-import/sketch.ts` 导入两份原档，按源页顺序逐页打开，对所有实例执行 `validateInstanceStructure`，再经本机文档 JSON 序列化与 `parseDocument` 重开。Sketch 91 样本有 1,401 个可编辑节点（833、568），68 个实例根、14 项图片、3 项共享文字样式。Sketch 98 样本有 407 个可编辑节点（32、46、32、78、93、36、87、3），22 个实例根、47 项图片。嵌套实例展开后，本机节点总数包含实例子层。

`tests/sketch-import.test.ts` 覆盖 6 组回归，包含跨页主件改名与文字传播、显式等值覆盖和重置、外部库内件替换与路径覆盖、同名兄弟层、UTF-16 范围、共享文字颜色联动、独立共享描边与局部线宽覆盖、带颜色的矩形蒙版、非法编码、重复 ID 及循环引用。可运行 `node --import tsx --test tests/sketch-import.test.ts` 复验。真实文件还检出了需要在结果页复核的特性，例如布尔运算和 Smart Layout 后续编辑行为。

Overview 采用上述原厂 PNG 与导出 React 工程相同画板逐像素比较。原厂价格和按钮尺寸通过 `sketchtool detach` 产生的实例副本取证；更正了文字覆盖后智能布局的尺寸分配、画板底色、矩形裁切层的可见填色、带叠加颜色的图片和大写文字。抽样对照涉及原厂 SF Pro Text Regular、SF Compact Display Semibold 与 Georgia Bold。文字边缘、商品照片采样和小尺寸矢量轮廓仍有差异。[导入验收方案](DESIGN-IMPORT-FIDELITY.md)给出差分方法和容差。最终构建的画板差分和编辑器全流程结果见[编辑器验收记录](../EDITOR-ACCEPTANCE.md)及[实测证据](../evidence/2026-11-22/design-import/)。

### 2026-11-23 · Apple iOS 27 原始套件

`Apple iOS 27 UI Kit.sketch` 为 Sketch 2026.3.1（234013）生成的格式 196，SHA-256 为 `839ecf260025264db9000a4ce23ef2804c33c8d62642a6373ed310858ca64171`。容器 207,834,444 字节、201 个条目，展开为 251,753,018 字节。36 个页面包含 13,914 个源图层、1,919 个 Symbol 主件与 4,798 个实例。4 个同名空分隔页按其源 ID 保留。源定义含 42 个 Layer Style、105 个本地文字样式、13 个外部文字样式、107 个本地及 4 个外部色变量。

完整导入得到 44,969 个可编辑节点、1,919 个组件、194 条按 Forma 属性分组的共享样式以及 111 个变量。156 个图像资源中有一张单页 PDF，适配器将它作为透明 PNG 供画布和导出使用。5 个内嵌字体按 PostScript 名连接；源稿的 SF Symbols 私用区正文保留，并映射 CoreText 的 `ss14`、`ss15`、`ss16` 等字形选择。使用已有 `validateInstanceStructure` 逐一验证 4,798 个实例的主件、子层类型、父子关系、同级顺序与 675 个换件引用。独立的源图层审核及视觉对照脚本为 `scripts/check-apple-kit-source.py` 和 `scripts/check-apple-kit-import.mjs`。

2,945 个源 Stack 含 1,807 个能从两个以上不同主轴坐标判断流向的栈，全部按源数组降序排列。以 Colors 页的 Grays（`F7704C25-706E-425A-8DB7-011ED10DBCF4`）为例，横坐标依次为 950、760、570、380、190、0。适配器分别保留同级绘制序和反向 CSS 流。负内边距的栈保留源位置并在导入报告标记。格式 196 的圆角数组、背景模糊列表与内阴影各自读取。Liquid Glass 保留模糊、饱和度、亮度、深度、折射、色散、光照开关；Web 外观使用可表达的滤镜、绘制与阴影，折射和光照存在差异。[Sketch Frames](https://www.sketch.com/docs/designing/frames/) · [Sketch Stack Layout](https://www.sketch.com/docs/designing/stack-layout/)

原厂核验使用 Sketch 2026.3.1 导出同一实例，并在临时副本仅更改一条覆盖。对 Tab 4（`7A0F14D0-7664-4612-B3C0-3A720AAAB954`），删除源图层不存在的覆盖后，两张 276×62 的 RGBA 输出完全相同。对 Toolbar Top（`B5CFBA1F-6895-4D2F-959E-4FE8683204CC`），将未提供主件的换件值改为空值，两张 662×70 的 RGBA 输出完全相同；移除覆盖会恢复默认槽并产生 662×85 的图像。Forma 对未提供主件但可定位的槽按此原厂行为处理；源路径不存在的覆盖在报告列明。三层连续换件还经过专属回归，以保证先前交换引入的槽仍可被后一级覆盖寻址。

同一版本的 `sketchtool` 还用于验证格式 196 的绘制角色。Progress Indicators 内 35×35 Spinner 的整体着色在完整、0.6 和零强度时最高 Alpha 分别为 255、153、0。原厂保留子树的透明轮廓，以 tint 的 RGB 替换内容色，再乘其透明度。Status Bar 的主件底色需同时打开 `includeBackgroundColorInExport` 和 `includeBackgroundColorInInstance` 才进入原厂导出；只保留 `layeringType=2` 的编辑背景时导出完全透明。Forma 在主件画布保留可编辑源漆，实例、预览、SVG 与 React 工程按源标志和漆角色绘制。原档按钮 Play 使用内嵌 SF Pro 的正常 Apple `trak` 曲线；17 pt 的量为 −52/2048 em（−0.43164 设计单位）。按字号插值后，按钮外框恢复为 72×50，视觉差异集中在文字栅格化。[Apple TrueType tracking table](https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6trak.html)
