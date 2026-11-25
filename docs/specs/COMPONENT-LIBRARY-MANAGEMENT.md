# Forma 组件库管理与内置多体系规范

- **最近更新**：2026-11-25
- **状态**：已实施并验收
- **关联源码**：`src/design-system/catalog.ts`、`src/design-system/mobile.ts`、`src/design-system/material3.ts`、`src/design-system/antd5.ts`、`src/design-system/shadcn.ts`、`src/domain/library-packaging.ts`、`src/domain/commands.ts`、`src/infrastructure/library-catalog-store.ts`、`src/infrastructure/design-import/library-extract-worker.ts`、`src/editor/AssetsPanel.tsx`、`src/editor/LibraryManagerModal.tsx`、`src/editor/assets-panel.css`
- **验收方式**：单元测试（425/425，含 51 项新增单测）+ 浏览器端到端验收（9/9，含 `assets-libraries`）+ 导出多体系 React ZIP 工程独立安装构建运行（[实拍证据](../evidence/2026-11-25/assets-and-libraries/)）

---

## 一、目标与定位

Forma 组件库管理体系旨在为设计师提供对标 Figma Libraries 的专业资产治理能力，同时内置覆盖 iOS、Android、Web 中后台与现代 SaaS 四大主流生态的可编辑离线组件库（合计 **98 类组件、686 个明暗变体、10 套整页模板**），并确保手动编辑、变量换肤、AI Agent 检索与 React/TS 工程交付共用同一套可信组件快照（`forma/library` v1）。

---

## 二、内置官方标准组件库矩阵

所有内置库均为 Forma 自研、可分发的原生图层与矢量实现，自带明暗双主题 `DesignSystem` 语义变量集合与文字/圆角规范，100% 离线可用，不打包受版权或商标限制的第三方专有资源。

| 组件库 | 稳定 ID | 平台定位 | 默认启用 | 实测规模与参考体系 |
| --- | --- | --- | --- | --- |
| **Forma Mobile (iOS)** | `forma-mobile-v1` | iOS / iPadOS | 是 | **44 类组件、290 变体**、10 语义色（Light/Dark）、7 级字阶、4 套整页模板（参考 Apple HIG 组织方式） |
| **Material Design 3** | `forma-material3-v1` | Android / M3 | 按需启用 | **18 类核心组件、136 变体**（按钮、FAB、分段按钮、输入框、搜索栏、开关、复选框、芯片、滑块、顶栏、底栏、标签页、卡片、列表项、对话框、轻提示、进度指示等）、M3 语义色系（Light/Dark）、8 级 M3 字阶、2 套 Android 整页模板 |
| **Ant Design 5** | `forma-antd5-v1` | Web 中后台 | 按需启用 | **20 类企业中后台组件、156 变体**（按钮、标签、徽标、头像、输入、选择、开关、多选、单选组、表单项、侧栏菜单、面包屑、标签页、分页器、步骤条、卡片、统计卡、数据表格、警告提示、弹窗）、AntD v5 Seed/Map 语义色（Light/Dark）、7 级字阶、2 套 1440×900 中后台模板 |
| **shadcn/ui** | `forma-shadcn-v1` | 现代 Web / SaaS | 按需启用 | **16 类现代 Web 组件、104 变体**（Button、Badge、Input、Select、Switch、Checkbox、Tabs、Card、Alert、Dialog、Command Palette、Avatar Item、Data Table Card、Dropdown、Toast、App Sidebar）、Zinc 明暗语义色、8 级字阶、2 套 1440×900 SaaS 模板 |

---

## 三、左侧「资源」面板交互与视觉规范

1. **高度与滚动结构**：`.sidebar-content.assets-sidebar` 采用 `flex-direction: column; overflow: hidden;`，`.assets-panel` 为 `flex: 1; min-height: 0;`，底部 `.milestone` 固定贴底。`.assets-sticky-top` 固定在顶部并保留 `1px solid var(--border-subtle)` 底边分隔；滚动体 `.assets-list` 采用 `display: flex; flex-direction: column; gap: 12px; padding: 10px;`（禁止 `display: grid` 拉伸空白）。
2. **三页签与顶部控件**：
   - 顶行固定 `组件 | 页面 | 规范` 三段式切换（`28px` 高）与 `组件库管理` 图标按钮（带当前已启用库计数徽标，`aria-label="组件库管理"`，`data-tip-kbd="⌥3"`）。
   - `组件` 页签：搜索框（`aria-label="搜索组件"`）+ 库/分类筛选与外观切换 + `.library-actions` 紧凑图标条（`24×24px` `.icon-btn.icon-btn-sm`，保留 `在线组件库`、`导入组件库`、`保存选区`、`供 Agent 使用`、`更新内置组件库`、视图模式切换）。
   - `页面` 页签：体系筛选（全部 / 四大体系）+ 浅色/深色外观切换；卡片统一使用 `var(--bg-panel-alt)` 与 `var(--border-subtle)`，深浅双主题一致。
   - `规范` 页签：顶部展示当前规范体系选择器 + 浅色/深色切换；正文按「语义颜色 → 文字层级 → 圆角与间距 → 文件颜色」四段排布，全部左右齐平：
     - **语义颜色**：小节头右侧提供紧凑「添加颜色到文件」动作按钮；每条 `.token-row` 固定 `height: 28px`、`gap: 2px`、色块 `16×16px` 带内描边、等宽 HEX 值；点击色块在有选区时直接应用填充/文字色，空选区时复制 HEX 并给出即时反馈。
     - **文字层级**：每条 `.type-spec` 紧凑对齐（左预览字号限制 `11–16px`、右等宽 `字号/行高 · 字重`），点击可在选中文本层时应用排版或在画布插入样例文本。
     - **圆角与间距**：以紧凑等宽胶囊展示体系标准圆角与间距值。
     - **文件颜色**：独立小节展示文档自有颜色 Token，复用同款 `28px` `.token-row`。
3. **基础元素折叠区**：`<details className="basic-assets">` 与正文严格同边距对齐（零二次内边距），以双列 `30px` 高紧凑按钮配 Lucide 图标提供「画板 / 矩形 / 椭圆 / 文本 / 按钮」快捷创建，不再与文件颜色混排。

---

## 四、组件库管理中心（`LibraryManagerModal`）规格

弹窗宽 `min(860px, 92vw)`、高 `max-height: 82vh`，采用固定顶栏、独立滚动主体与固定底栏，分三页签：

| 页签 | 核心能力 | 安全与撤销规则 |
| --- | --- | --- |
| **官方体系** | 浏览 4 大内置体系卡片（平台徽标、色板条、组件/变体/模板数、实景微缩预览）；按当前文件切换「启用 / 停用」开关；一键跳转查看规范或导出 `.forma-library.json` | 启用写入当前文档 `doc.libraries`（`putLibrary`）并同步注册给 AI Agent，可 `⌘Z` 撤销；停用时若画布实例数 = 0 则经 `removeLibrary` 清理，若 > 0 则保留实例并仅隐藏快速浏览提示引用数 |
| **本文件与自定义** | ① 列出当前文档已安装的自定义/导入库（显示修订号与跨页实例引用数，支持导出、发布、安全卸载）；② 导入本地 `.forma-library.json`；③ 从本地 `.fig` / `.sketch` 原稿离线提取组件库；④ 一键将当前文档全部本地主组件打包为可分享库；⑤ 工作区自定义库仓（IndexedDB 持久化）跨文件一键启用或删除 | 卸载走 `removeLibrary` 原子事务，若画布（含跨页与嵌套槽位）仍有实例引用则阻断并提示准确数量；`.fig`/`.sketch` 提取在独立离线 Worker 运行，受文件体积与 `parseLibrary` 校验约束 |
| **在线订阅** | 订阅团队 HTTP(S) 组件库地址、检查远端修订、进入 `LibraryReview` 逐组件/冲突审阅升级、取消订阅 | 沿用 `subscribed-libraries.ts` 与 `LibraryReview` 既有安全与 ETag/修订校验协议 |

---

## 五、与 Figma 对齐边界

- **已实现**：按文件启停标准库、搜索/分组/拖放插入、变体与明暗变量联动、本地主组件打包导出与跨文件发布/订阅/差异审阅、从 `.fig`/`.sketch` 离线提取组件库、引用计数防误删。
- **当前边界**：不支持云端团队组织权限审批与多用户实时推送同步；不支持直接连接 Figma REST API 在线拉取远程文件（仅支持本地 `.fig`/`.sketch` 文件离线提取）。
