# 大型设计文件的资源、保存与恢复

最近更新日期 2026-11-24  
状态 已实施并验收  
关联源码路径 `src/domain/asset-bytes.ts`、`src/infrastructure/document-parts.ts`、`src/infrastructure/native-document.ts`、`src/infrastructure/storage.ts`、`src/infrastructure/storage-parts.ts`、`src/infrastructure/verified-asset.ts`、`src/infrastructure/font-import.ts`、`src/editor/SourceName.tsx`  
验收方式 运行 `node --import tsx --test tests/document-parts.test.ts`。下列浏览器验收使用 macOS 本机 Chrome、用户提供的原始 Sketch 包与全新的本地数据库。

## 数据与限制

- 文件和库使用 `img-<sha256>`、`font-<sha256>` 引用原始媒体。同一媒体可在文件和多个自包含组件库内使用，各自保留名称、字体轴或像素尺寸等元数据。编辑时复制元数据和节点，共享不可变资源字符串。
- Sketch/Figma 设计文件中的单张位图、单份字体上限均为 32 MiB。跨活动页、其他页、全部库去重后，文档图片及字体合计上限 256 MiB。图片每边最多 32,768 px，单张最多 64,000,000 像素。PNG、JPEG、GIF、WebP 从文件头读取原始尺寸；这是容器及尺寸核验。PDF 转换沿用 Sketch 适配器的离线转换结果。
- 嵌入 TTF/OTF 校验 sfnt 目录、表界限和可用标签，保留原始字节。字体的 PostScript 名决定具体字面，只有唯一对应的 family 别名才绑定。CSS @font-face 保留权重或可变 wght 区间及 italic 标志。字体文件只存于用户文档与用户导出的工程，仓库不提供原始 Apple 资源。
- 页面和图层名字按原 Unicode 字符串存储。显示其中的私有区字符时，按常规正体优先尝试文档嵌入字体并继续回退。缺少相应字形的系统或文件可能显示替代字形。

## 原生文件

逻辑文档保持 `schemaVersion: 1`。当文档满足以下任一条件时保存为同扩展名的分块 JSON：导入诊断超过 2,000 条；所有页面与组件模板合计超过 10,000 个图层；或全部资源编码字符、节点矢量/排版/文本数据及诊断文本的合计估算体积超过 16 MiB。低于三项阈值的文件沿用原单对象表达。

首行是 `{"format":"forma/design-parts","version":1,"records":[`。每条记录占一行，末行 `{"kind":"end"}]}`。整份文件可以用标准 JSON 工具读取，规范化输出可按 UTF-8 流逐条打开。读取器也接受经普通 JSON 格式化工具重新排版的文件，此时会读取整个文本。

| 记录 | 内容 |
| --- | --- |
| `header` | 页面和库目录、文档元数据、Token/样式，资源元数据的数据槽改为 `@<id>`。 |
| `page` | `page:null` 代表活动页，字符串表示其他页面。每条最多 128 个节点，矢量或文本长数据额外按约 512 Ki 字符分组；单节点不拆分。 |
| `issues` | 每条最多 128 个导入诊断，保留次序、来源及出现次数。 |
| `component`、`variant` | 每个组件一次元数据记录，其后按变体拆分节点，保留模板键、实例关系、原始数组顺序。 |
| `asset` | 每个唯一资源只写一次。每条最多 512 Ki 个编码字符，含 `id`、`offset`、`size` 与 `data`。 |
| `end` | 标记完整写入结尾。 |

流式读入会检查分块次序、声明长度、最终标记、资源 SHA-256、媒体格式和图片尺寸，再检验重组后的文档。缺失、错位、损坏的资源会给出失败原因。文件菜单下载、文件管理器导入、桌面打开、独立工程中的 `design.forma.json` 共用此协议。使用旧版本 Forma 打开分块文件需要先升级到支持此协议的版本。

## 本机数据库

IndexedDB `forma-studio` 从 v2 升至 v3，旧 `documents`、`files` 和原有上一版保留。大文档的 `current`、`previous` 指向 `{format:"parts-v1",generation,chunks,assets}`。图层及模板分块以 `[fileKey,generation,chunkIndex]` 为键存入 `document-parts`；单份媒体按 `[fileKey,assetId]` 存入 `document-assets`。文件之间独立持有原件，删除或复制互不影响。

同一读写事务比较 generation、写入新内容、更新目录和恢复指针、回收两代快照都已放弃的分片与资源。提交成功后才更新调用方的 generation。打开分块文档后立即缓存已校验资源指纹与尺寸，首次局部编辑与改名无需对 256 MiB 以内原资源重复哈希。其他标签页已经保存时拒绝过时提交；配额不足（`QuotaExceededError`）给出中文引导并保留已提交快照；`backup()` 独立读取 `current` 与 `previous` 快照，单代损坏时仍可恢复另一代；文件列表的缩图只读取活动页和该页实际引用的资源。

## 真实样本验收

原始 Apple iOS 27 UI Kit 的 images 目录含 156 份独立资源。155 个 PNG 合计 121,129,365 字节，最大的两个为 20,316,971 和 18,935,673 字节，均为 2640 × 5740。另有一份 5,813 字节的 PDF，由 Sketch 适配器单独覆盖。五份嵌入字体共 81,472,628 字节。文档另声明了仅有名称的字体引用。

| 场景 | 观测 |
| --- | --- |
| 真实素材压力测试 | 将全部 155 PNG 和 5 字体同时用于一个文件及其自包含库。每份字节单独去重。资源编码合计 270,139,731 字符。生成原生文件 270,302,940 字节。 |
| 保存及重新打开 | 同机单次观测，素材提取 4.046 秒，初次 IDB 保存 1.006 秒，原生文件生成 0.377 秒，流式核验与打开 3.097 秒，数据库重载 2.331 秒。该行测量的是上述素材压力场景，整套编辑器的首次导入耗时另行验收。 |
| 更新与删除 | 连续保存两次后资源表为 160 条，可恢复前一版。删除文件后对应资源 0 条。 |
| 旧库与并发写入 | 真实 Chrome 预置 v2 数据库的第 7 代记录及前版。v3 成功取回两代。两个 Repository 同时读取后，第一份提交成功，第二份过时提交被拒。重新加载后保存成功，第 9 代的当前和上一份版本均正确。 |
| 私有区名字 | 源页面和图层名使用 73 种私有区码点。将这些字置于真实页面树，Chrome DevTools Protocol 对每个字符查询实际字体，73/73 使用文件内字体，其中 71 种使用 SF Pro，2 种回退至 SF Pro Rounded Bold。另一个真实图层行也确认使用嵌入字体。 |
| 真实文件编辑 | 在 Materials 页修改独立的 Separator 文本和 _Header 实例内的 Human Interface Guidelines 文本，写入中文、日文与符号；一次撤销恢复两段，重做并保存后从 353,752,698 字节的原生文件重开，文字、实例指向、36 页、156 图像和 5 份字体完整。该文件取自适配器输出。 |
| Electron 实际保存 | 开发 Electron 加载固定的生产 dist，从系统 open-file 事件导入原件，经离线 PDFium 转图后保存、刷新，再用文件菜单保存本地副本。包含导入报告的 358,579,259 字节文件由系统 open-file 重新打开为独立文件。复核 44,969 个页面节点、1,919 主件、4,798 实例及所有图片字体。可用 `node scripts/check-design-import-desktop.mjs "<原件路径>"` 对安装版重跑。 |
| 最终只读 DMG | Forma 0.8.1 arm64，SHA-256 `14212a53871cd792bdd7fa1f1f9936419a256c446ca85e5b5b3bb2f01eb21813`，124,469,330 字节。镜像内 `codesign --verify --deep --strict` 通过 ad hoc 签名校验，app.asar 中 10 个 dist 文件均与最终构建逐字节一致。从挂载盘打开 Apple 原件，将最终导入报告与文档一同保存成 359,578,887 字节的独立副本，再经系统 open-file 打开。页面、图层、图库及模板计数和原导入完全相符。同一程序打开真实 components.fig 为 4 页、13 个页面图层、3 主件和 8 实例。 |
| 损坏输入 | 单测覆盖错序、资源缺失、校验不符、尺寸错报与截断；合法旧文件、规范分块和重新格式化后的 JSON 均可重开。 |
