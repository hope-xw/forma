# PRD · 资源面板一致性重构与成熟组件库管理体系

- **课题编号**：`2026-11-25-assets-and-library-manager`
- **状态**：已实施并验收
- **立项日期**：2026-11-25
- **关联文档**：[工程设计文档 ENGINEERING.md](ENGINEERING.md) · [任务清单 TASKS.md](TASKS.md) · [组件库管理长期规格](../../specs/COMPONENT-LIBRARY-MANAGEMENT.md)

---

## 一、背景与真实痛点

### 1. 图 1「资源 → 规范」面板布局失衡与样式割裂
在 macOS 桌面端与 Web 端浅色/深色主题下，左侧「资源」面板（`AssetsPanel.tsx`）存在明显视觉与布局缺陷：
1. **容器高度与 Grid 拉伸错位**：`.assets-panel` 使用硬编码 `height: calc(100% - 64px)`，且 `.assets-list` 继承旧版 `styles.css` 的 `display: grid` 未被 `ui3-theme.css` 覆写，导致「文字层级」与下方 `<details class="basic-assets">` 之间出现大块异常空白；滚动时顶栏 `浅色` 下拉区直接截断色块，缺少清晰分隔。
2. **颜色行与字号行节奏悬殊**：`.token-row` 零垂直间距导致色块上下黏连成一整条；`.type-spec` 字号过大（最高 20px）且写死浅色分隔线 `#edf0f5`，深色模式下刺眼割裂；「添加颜色到文件」使用旧版 `.wide` 粗框按钮，未接入 UI3 紧凑控件规范。
3. **「基础元素与已有颜色」双层缩进与内容混排**：`.basic-assets` 叠套 `padding: 12px` 导致标题与上方区块明显错位；内部 5 个基础元素按钮写死浅色大白块（`padding: 18px 10px`、`#faf9fc`、无图标），与紧贴其下的文档色卡 `品牌 / 主色` 混排在同一折叠块内。
4. **「页面」页签未接入 UI3 主题**：`.template-card` 仍使用 `#fff`、`#e5e9f1`、`#635bff` 等早期硬编码浅色值，深色模式下整体白块突兀。

### 2. 缺少成熟组件库管理与多平台主流体系覆盖
Forma 目前仅内置 1 套常驻移动库 `Forma Mobile`（iOS 风格，44 类 / 290 变体），在实际 Web 中后台、Android 移动端、现代 SaaS 创作中存在明显短板：
1. **缺少统一组件库管理中心**：无法按当前文件自由「启用 / 停用」组件库，无法直观查看各库组件数、变体数与画布实例引用数，无法安全卸载未使用的库。
2. **缺少主流大厂/开源设计体系**：缺少 **Android（Material Design 3）**、**Ant Design 5（Web 中后台）**、**shadcn/ui（现代 Web SaaS）** 等高频成熟组件库，设计师新建 Web 或 Android 项目时仍需从零手绘。
3. **导入与建库闭环不顺畅**：虽然已具备离线 `.fig` / `.sketch` 导入与单选保存主组件能力，但缺少「直接从 `.fig` / `.sketch` 原稿提取可复用组件库」以及「将当前文档所有本地主组件一键打包为共享库并跨文件复用」的管理工作流。

---

## 二、产品目标与确认范围

用户已确认以下核心目标与范围：

| 维度 | 本期交付目标 | 设计师可感知的收益 |
| --- | --- | --- |
| **1. 资源面板 UI3 重构** | 彻底修复 `.assets-panel` 高度、滚动、间距、对齐、深浅双主题与交互体验；重构 `组件 / 页面 / 规范` 三页签及 `基础元素` 区块，支持点击规范色卡直接应用到选区/复制 HEX、点击文字层级应用字号或插入样式文本 | 消灭黏连色块、大段空白、双层缩进与硬编码白块；深浅两套主题及短窗口下布局紧凑一致、专业顺手 |
| **2. 四大内置成熟设计体系** | 保留 **iOS（Forma Mobile，44 类 / 290 变体）**；新增 **Android（Material Design 3）**、**Ant Design 5（Web 中后台）**、**shadcn/ui（现代 Web SaaS）**，每套配备独立明暗 `DesignSystem` 语义变量集合、文字/圆角规范、核心交互组件变体与整页模板 | 覆盖 iOS、Android、Web 中后台、现代 SaaS 全场景；100% 离线原生可编辑、支持变体切换、明暗变量换肤与 React 独立工程导出 |
| **3. 组件库管理中心（Library Manager）** | 对标 Figma Libraries 弹窗，集中管理：① 官方标准库按文件启停；② 本文件与自定义库（查看实例数、安全卸载、打包当前文档主组件为库、工作区跨文件持久化）；③ 本地 `.forma-library.json` 导入导出 & 从 `.fig` / `.sketch` 直接提取组件库；④ 团队在线订阅与差异审阅 | 所有组件库治理能力收口到一处清晰入口，默认不污染空白文件，按需开启、安全卸载、支持撤销 |
| **4. 画布与 AI Agent 全链路联动** | 画布拖放支持所有已启用内置/自定义库；启用任意库写入 `doc.libraries` 后，AI Agent 的 `list_components` / `search_components` / `insertComponent` 自动感知并优先复用已启用体系组件 | 设计师开启 AntD 5 或 Material 3 后，手拖与 AI 生成共享同一套组件资产 |

---

## 三、明确不做 / 下期范围（Non-Goals）

1. **不打包受版权或商标限制的第三方专有资产**：不抓取或分发 Apple SF Symbols / 专有字体、Google 闭源图标包或未授权商业原稿；所有内置库采用 Forma 自研可分发原生图层、自绘/ISC 协议 Lucide 矢量路径与标准系统字体栈，并清晰标注参考体系与许可说明。
2. **不做云端公共社区组件市场或账号权限体系**：本期所有内置库与 `.fig`/`.sketch` 提取均 100% 离线本地运行，在线订阅沿用现有 `server/library-service.ts` HTTP 修订协议，团队 RBAC 审批留待协作里程碑。
3. **不改动文档 `schemaVersion`（维持 `schemaVersion: 1`）**：所有既有 `.forma.json`、组件库快照、实例覆盖与外部导入文件保持 100% 向后兼容。
4. **不破坏既有浏览器自动化入口契约**：保留 `保存选区`、`在线组件库`、`搜索组件`、`查看 <组件名>`、`插入组件`、`导出此组件库` 及 `.left-panel input[type=file][accept=".json"]` 等既有无障碍名称与测试挂钩。

---

## 四、验收标准（Definition of Done）

1. **图 1 复现与前后对照**：在 Chromium 浅色 & 深色双主题及 1280×650 短窗口下，打开「资源 → 规范 / 组件 / 页面」，实测 0 色块黏连（色块行距 ≥ 2px）、0 异常空白拉伸、所有区块左对齐误差 ≤ 1px、滚动时粘性顶栏带清晰底边分隔、基础元素带清晰图标且与文件颜色视觉分离，留存对比截图证据。
2. **四大内置库全量校验**：iOS / Material Design 3 / Ant Design 5 / shadcn/ui 全部通过 `parseLibrary` 与 `validateLibrary` 严格校验，支持在画布插入、切变体、切明暗、撤销重做、保存重开，并导出独立 React 工程完成 `npm ci && npm run build`。
3. **组件库管理闭环实测**：
   - 在组件库管理中心启用 Material 3 / AntD 5 / shadcn/ui，左侧面板与 `规范` 页签实时联动，AI Agent 工具 `list_components` 可检索到新增组件；
   - 未使用库可安全卸载并支持 `⌘Z` 撤销；画布存在引用实例的库阻止直接卸载并提示准确实例数；
   - 将当前文档本地主组件打包为自定义库并导出/保存到工作区；支持离线从 `.fig` / `.sketch` 提取组件库。
4. **全量回归通过**：`npm test`、`npm run format:check`、`npm run build` 全部通过；既有组件库与面板浏览器回归（`editor-panels`、`library-tokens`、`library-subscription`、`library-publish`、`panel-gestures`）及新增 `assets-libraries` 浏览器 E2E 全部通过。
