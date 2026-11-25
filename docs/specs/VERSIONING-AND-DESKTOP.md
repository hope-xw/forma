# 产品版本号规范与 Electron 桌面客户端架构规格

- **最近更新**：2026-11-25
- **状态**：已实施并验收
- **核心实现**：[package.json](../../package.json)、[vite.config.ts](../../vite.config.ts)、[electron/main.mjs](../../electron/main.mjs)、[electron/preload.cjs](../../electron/preload.cjs)、[src/editor/App.tsx](../../src/editor/App.tsx)、[scripts/release/pipeline.ts](../../scripts/release/pipeline.ts)
- **关联文档**：[架构约定](../ARCHITECTURE.md) · [规格目录](README.md) · [编辑器验收记录](../EDITOR-ACCEPTANCE.md)

---

## 一、产品版本号规范

### 1. 版本格式（SemVer 2.0）

Forma 采用语义化版本号 `MAJOR.MINOR.PATCH[-prerelease]`：

| 版本段 | 递增条件 | 示例 |
| --- | --- | --- |
| `MAJOR`（主版本） | 达成首个正式生产版（`1.0.0`）或发生不兼容的产品代际演进 | `1.0.0` |
| `MINOR`（次版本） | 0.x 阶段引入里程碑级核心能力（如桌面端打包、渲染引擎升级、重大工作流补齐） | `0.2.0` |
| `PATCH`（修订号） | 缺陷修复、性能微调、文案与交互细节打磨，无架构/格式破坏 | `0.2.1` |
| 预发布后缀 | 内部测试或灰度候选用 `-alpha.N` / `-beta.N` / `-rc.N` | `0.3.0-beta.1` |

### 2. 当前版本与里程碑基线

- **当前工作区版本** `0.10.0`。文件菜单显示实际运行版本及按日期排列的重点更新。0.10.0 汇集四大离线内置组件库体系与组件库管理中心（98 组件 / 686 变体 / 10 模板、资源面板 UI3 重构、`.fig`/`.sketch` 离线提取建库）、Forma AI Stage 1（活体三级资产、离线/增量 AI 说明书、HTML 插槽化原装实例混编与 Token 吸附、范围确认卡多画板矩阵生成）以及版本分级判定规则与自动化发版/只读挂载 DMG 验收流水线。0.9.0 推出 AI 现代精排生成引擎（369 枚本地 Lucide 矢量图标 + 安全摄影本地化 + HTML/CSS-to-Forma 零脚本沙盒双引擎 + 多模态截屏视觉自审闭环）、显式多模型五层能力识别及开源 `SKILL.md` 设计技能生态。0.8.4 进一步加固 Sketch 与 Figma 边界容错、大文件分块存储恢复、导入报告分类定位与大组件库搜索面板。0.8.1 通过分块传送本地文件，可打开 256 MiB 内的 Sketch 或 Figma 原稿。自 0.8.0 起，macOS 可以作为 `.sketch` 和 `.fig` 的备用查看应用。系统“打开方式”、窗口文件菜单和 Web 共用本地转换器，将用户选择的文件导入独立副本。[设计文件导入](DESIGN-FILE-IMPORT.md)
- **历史版本** `0.6.5`，修复了双击编辑导致的文字位移。[文字编辑复测](../EDITOR-ACCEPTANCE.md#065-文本图层原位编辑)。0.6.4 新增位图平铺、调色、画布裁切，修正手指与鼠标的原型触发及嵌套弹窗焦点恢复。[本版验收](../EDITOR-ACCEPTANCE.md#064-位图编辑与原型输入)。0.6.3 调整了属性栏中的自动布局、间距与四边内边距。[布局面板复测](../EDITOR-ACCEPTANCE.md#063-属性栏布局)。[功能面板编号与验收](EDITOR-PANEL-ACCEPTANCE.md)。系统打开文件时，主进程在就绪前收集路径，每个文件交给对应窗口；渲染端先校验再导入独立本地副本。原稿与其他窗口分别保存。
- **`0.2.0` 里程碑包含内容**：
  - 8,288 层复杂画板交互引擎优化（增量场景索引、视口裁剪、拖拽二分吸附）；
  - 全站 7 大区域图标入口与全局 `TooltipHost` 提示系统标准化；
  - `Aura Studio` 双页多主题 SaaS/营销验证样例与 `IndexedDB` 共享连接缓存；
  - 首个 Electron 桌面客户端安装包（macOS Apple Silicon `.dmg` / `.zip`）。
- **与文档格式解耦**：设计文件的 `schemaVersion`（当前为 `1`）独立于产品版本号演进，避免每次发布新客户端造成历史 `.forma.json` 文件不兼容。

本机发布组件库时，桌面主进程启动随应用打包的回环 HTTP 服务，在用户数据目录保存修订和端口；已发布的订阅地址在重启后继续可访问。团队服务可另行配置。[发布规格](PROFESSIONAL-EDITING.md)

### 3. 单一版本源（Single Source of Truth）

[package.json](../../package.json) 中的 `version` 字段是全项目唯一版本声明，禁止在其他位置硬编码版本号：

| 消费位置 | 注入机制 | 表现形式 |
| --- | --- | --- |
| Web 前端 / 编辑器文件菜单 | [vite.config.ts](../../vite.config.ts) `define.__FORMA_VERSION__` | 文件菜单底部展示 `Forma v0.4.0 · Web` |
| Electron 渲染进程 | 主进程通过 `additionalArguments` 传入 `--forma-version=<version>`，经 [preload.cjs](../../electron/preload.cjs) 暴露为 `window.formaDesktop.version` | 文件菜单底部展示 `Forma v0.4.0 · 桌面客户端` |
| Electron 主进程 & macOS 原生「关于」面板 | [main.mjs](../../electron/main.mjs) 直接读取 `package.json` | 菜单栏「关于 Forma (v0.4.0)」与原生 About 面板 |
| 桌面安装包与系统元信息 | `electron-builder` 读取 `package.json` | `Info.plist` `CFBundleShortVersionString` 与产物名 `Forma-0.4.0-arm64.dmg` |

### 4. 文件菜单里的版本日志

**项目记录。** 每次变更产品版本号，同次在[项目版本日志](../CHANGELOG.md)顶部新增一节。标题为 `## 版本号 · YYYY-MM-DD`，日期取该版实际更新日期（Asia/Shanghai）。正文分项记录功能、修复及涉及的兼容性、数据或交付变化，附相关验收或实现依据。纯维护版也要登记，已归入产品摘要的修复在内部保留其原始版本。

**产品记录。** 每个正式主版本和次版本（包括 0.x 的次版本）都公开。新增重要工作流、解决影响使用的阻断或涉及兼容变化的补丁也单列。每条显示该次公开版本号、更新日期、简短标题和设计师能感知的变化，按发布顺序倒排。同日发布的版本各自保留。

**发版操作。** 在[产品更新数据](../../src/editor/release-notes.ts)末尾追加同一版本号和日期。公开版填写 `title` 与 `summary`，内容较丰富时可用 `highlights` 补充 1–2 条要点（面向设计师使用清晰自然的中文，避免内部实现术语）。小修补只填一句 `summary`，与用户操作无关的内部维护可留空字符串。程序把上次公开条目之后积累的摘要并入下一条有标题的更新，每项只出现一次。版本号、更新日期仍指公开版，详细归属可查项目日志。

**当前版本。** 菜单与面板标题旁显示运行版本，即使它仍在等候归并。首条记录始终是最近一次公开更新。例如 v0.8.2 打开日志时，标题显示 v0.8.2，首条是 v0.8.1。全部内容随应用打包。[覆盖与归并单测](../../tests/release-notes.test.ts) · [界面验收](../../scripts/check-release-notes.browser.js)

### 5. 版本升级判定与同步打包规则

为避免重大功能更新后版本号与桌面安装包脱节，也避免为纯文档/测试微调频繁重打百兆级安装包，每次完成任务准备交付前，必须依据变更体量与重要程度运行 `npm run release:assess` 进行客观分级判定（核心规则由 [scripts/release/policy.ts](../../scripts/release/policy.ts) 固化并经单元测试保障）：

| 变更级别 (`bump`) | 判定条件（满足任一即归入更高档） | 版本动作与日志要求 | 同步桌面打包 (`packageDesktop`) |
| --- | --- | --- | --- |
| **`none`（不发版）** | 仅变更 `docs/`、`tests/`、`scripts/`（非产品运行时）或无用户可感知行为变化的纯内部整理；或中大型课题尚处于未达交付标准的中间步骤 | 版本号保持不变，不写新版本节 | **`false`（不打包）** |
| **`patch`（修订版 `x.y.Z+1`）** | 缺陷修复（渲染、交互、导入、导出、保存、崩溃、安全）、单点 UX/文案/性能打磨，或局部工作流增强 | `PATCH + 1`，同步写入 `CHANGELOG.md` 与 `release-notes.ts`；常规小修留空 `title` 自动归并，重要工作流增强或阻断修复填 `title` 单独公开 | **条件必打（`true` 条件，满足任一即触发）**：<br>1. 修改触及 `electron/` 或 `server/`（影响内置 `agent-service` / `library-service`）；<br>2. 涉及安全加固、数据完整性或崩溃修复（`securityOrDataFix`）；<br>3. 属于带 `title` 单独公开的重要补丁（`publicPatch` 或 `workflow-enhancement`）；<br>4. 变更跨 ≥ 2 个核心产品子系统，或运行时文件改动 ≥ 5 个。<br>仅不满足以上条件的细微局部 Web 补丁可设 `packageDesktop: false` 暂缓打包，并在验收文档写明「暂缓打包」 |
| **`minor`（次版本 `0.Y+1.0`）** | 满足任一即触发：<br>1. 新增面向设计师的完整核心能力或子系统（`major-feature`）；<br>2. 完成已立项课题（`docs/initiatives/`）的可交付主里程碑（`completedInitiative`）；<br>3. 工作流增强跨 ≥ 2 个核心产品子系统；<br>4. 未显式定级但变更同时触及 ≥ 3 个核心子系统且运行时改动 ≥ 10 个文件 | `MINOR + 1, PATCH = 0`，同步写入 `CHANGELOG.md` 与**公开版** `release-notes.ts`（必须含 `title` 与面向设计师的中文 `summary`/`highlights`） | **强制同步打包（`true`）**：必须经自动化流水线产出新版本 `.dmg` + `.zip` 并完成只读挂载实机验收 |
| **`major`（主版本 `X+1.0.0`）** | 达成首个正式生产版（`1.0.0`）或引入不兼容的产品代际/格式升级（必须经用户显式确认并传入 `--confirm-major`） | `MAJOR + 1, 0, 0`，同步写入 `CHANGELOG.md`、公开版 `release-notes.ts` 与迁移说明 | **强制同步打包（`true`）**与全链路跨场景验收 |

**核心产品子系统范围**：`src/domain/`、`src/editor/`、`src/design-system/`、`src/agent/`、`server/`、`src/compiler/`、`src/runtime/`、`src/infrastructure/`、`electron/`、`public/`。

### 6. 自动化发版与桌面打包验证流水线

项目内置零外网依赖、兼容无 `.git` 工作区的自动化发版流水线（位于 `scripts/release/`），对外提供四条标准命令：

| 命令 | 职责 | 关键行为与保障 |
| --- | --- | --- |
| `npm run release:assess` | 变更影响评估与分级决策 | 自动探测自当前版本 DMG（或 Git 基准）以来变更的源码与课题，按 §5 规则输出 `bump`、`nextVersion`、`packageDesktop`、`publishInReleaseNotes`、影响子系统与中文判定理由（支持 `--json`） |
| `npm run release:check` | 版本元数据与安装包一致性巡检 | 核验 `package.json`、`docs/CHANGELOG.md`、`src/editor/release-notes.ts` 三方版本与日期完全一致；同时检查当前版本桌面安装包是否存在以及工作区是否有比安装包更新的运行时改动 |
| `npm run release:verify-dmg` | 只读挂载 DMG 实机验收与证据归档 | 通过 `hdiutil attach -readonly -nobrowse -plist` 挂载目标 `.dmg`（异常退出在 `finally` 保证卸载），自动校验 `codesign --verify --deep --strict`、`Info.plist` 版本、`app.asar` 与 `dist/`/`out-electron/` 全文件 SHA-256 逐字节一致、离屏启动 `Forma.app` 验证 `window.formaDesktop.version` / `forma://app/api/agent/*`（含 `/api/agent/providers`、`/status`、`/skills`、`/critique`、`/library-playbook`）/ 版本日志界面回归 / `shared-paint.fig` 原生 `open-file` 打开、既有前序 DMG SHA-256 完好，并写入 `docs/evidence/<YYYY-MM-DD>/desktop-<version>.json` |
| `npm run release:run` | 一键自动化发版流水线 | 按序执行：① 影响评估与 `major` 安全确认门禁 → ② 预检前序 DMG 指纹与目标包防误覆盖校验 → ③ 原子更新 `package.json` / `CHANGELOG.md` / `release-notes.ts`（支持 `--dry-run`，预检失败自动回滚）→ ④ 执行 Prettier、`tests/release-notes.test.ts`、全量 `npm test`、`npm run build`、`desktop:service`、`desktop:agent` → ⑤ 若 `packageDesktop === true`，调用 `electron-builder` 同步产出 `.dmg` / `.zip` → ⑥ 调用 `verify-dmg` 完成只读挂载全量实机验收并归档证据 JSON |

---

### 6. GitHub 发布与本地安装包保留

完成桌面验收后，将该版本的 DMG、ZIP 及各自的 `.blockmap` 上传为 GitHub Release 附件，版本标签指向对应源码提交。将当前正式版标记为 Latest，下载入口使用[最新桌面版](https://github.com/hope-xw/forma/releases/latest)。

历史安装包保存在 [GitHub Releases](https://github.com/hope-xw/forma/releases)。清理本地副本前，逐个比对 GitHub 附件的文件名、字节数和 SHA-256，并检查公开下载链接。全部通过后，本地 `release/` 只保留最新正式版的安装文件；旧版解包目录与已归档 ZIP 内容一致时一并清理。上传或校验失败的版本继续保留在本地。

源码历史始于 0.10.0。早期安装包使用 `archive-v<版本>` 标签，对应的归档说明和 `SHA256SUMS` 可用于核对下载文件。

## 二、桌面客户端技术选型与架构

### 1. 选型结论

- **现阶段采用 Electron**（`electron-builder` 打包）：Forma 当前采用 DOM + CSS + SVG 渲染画布并交付 Web/H5 React 工程，Electron 提供三端统一的 Chromium 内核，减少桌面壳之间的文本度量差异，Web 导出仍按目标浏览器分别验证，同时原生内置 Node.js，便于后续直接内嵌 `server/index.ts` 与 `server/mcp.ts`。
- **后续演进观察**：待画布底层评估或迁移至 Skia / WebGPU WASM 自研渲染后，再重新评估 Tauri 2 等轻量壳方案。

### 2. 安全与协议隔离

- **渲染隔离**：主窗口强制启用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，仅通过 [electron/preload.cjs](../../electron/preload.cjs) 暴露最小受控桥接对象 `window.formaDesktop`。
- **特权自定义协议 `forma://app/`**：
  - 使用 `protocol.registerSchemesAsPrivileged` 注册 `standard: true, secure: true, supportFetchAPI: true, corsEnabled: true` 的 `forma` 协议，在生产包中直接从 `app.asar/dist` 提供静态资源并回退至 `index.html`。
  - 相比 `file://`，`forma://app/` 提供完整的 Chromium 安全上下文（Secure Context），确保 `IndexedDB` 多文件存储、`fetch` 样例加载、`?file=` / `?example=` 查询参数路由及相对路径资源可复用 Web 端的存储和路由实现。
  - 内部 `target="_blank"` 链接（如打开移动设计研究室、Aura Studio 样例）通过 `setWindowOpenHandler` 拦截并在新的原生 Forma 窗口中打开；外部 `http(s)://` 链接交由系统默认浏览器打开。

### 3. 原生菜单与快捷键防冲突规则

桌面端菜单（[electron/main.mjs](../../electron/main.mjs)）遵循「不劫持画布高频快捷键」原则：

- **保留给画布原生处理**：`⌘R`（重命名图层，因此强制刷新改为 `⇧⌘R`）、`⌘0` / `⌘+` / `⌘-`（画布缩放，不触发浏览器整页缩放）、`⌘K`（命令面板）、`⌘G` / `⌘D` / `⇧⌘H` / `⇧⌘L`。
- **输入框与画布双态路由**：`撤销 (⌘Z)`、`重做 (⇧⌘Z)`、`全选 (⌘A)` 由原生菜单经 IPC `forma:menu-action` 转发给渲染进程；当前焦点位于可编辑文本控件时执行原生 `document.execCommand`，否则执行 `editor.perform(...)`。
- **原生剪贴板直通**：`剪切 (⌘X)`、`复制 (⌘C)`、`粘贴 (⌘V)` 使用 Electron 原生菜单角色，触发标准 DOM `cut` / `copy` / `paste` 事件，同时兼容输入框文本与画布图层子树剪贴板协议。
- **文件打开关联**：安装包在 macOS 注册 `.forma` 与 `.forma.json` 文件关联，支持从访达双击或 `文件 → 打开设计文件… (⌘O)` 打开本地文件（执行 128 MB 上限与 Zod `parseDocument` 校验）。

### 4. 构建命令与产物约定

| 命令 | 用途 | 产物路径 |
| --- | --- | --- |
| `npm run electron:start` | 构建前端并以 Electron 直接启动预览 | — |
| `npm run desktop:pack` | 仅打包解压缩后的 `.app` 目录（快速冒烟验证） | `release/mac-arm64/Forma.app` |
| `npm run desktop:build` | 构建完整安装包与归档 | `release/Forma-<version>-arm64.dmg`、`release/Forma-<version>-arm64.zip` |

应用图标源文件位于 [build/icon.svg](../../build/icon.svg)，衍生 1024×1024 [build/icon.png](../../build/icon.png) 与 10 档 Retina 分辨率 [build/icon.icns](../../build/icon.icns)。`electron-builder` 打包 `dist/**/*`、`electron/**/*` 和本机发布服务 `out-electron/library-service.mjs` 并排除 `node_modules/**/*`，保持 `app.asar` 精简。

### 5. 当前边界与后续演进

- **已实现**：macOS Apple Silicon（`arm64`）完整 `.app` / `.dmg` / `.zip` 打包、构建钩子 [electron/after-sign.mjs](../../electron/after-sign.mjs) 自动补齐有效 ad-hoc 深度签名（通过 `codesign --verify --deep --strict`）、自定义 `forma://app/` 协议、多窗口打开样例、原生菜单与快捷键无冲突路由、`.forma` / `.forma.json` 文件关联与打开导入、统一版本号注入。
- **当前边界**：
  - 当前安装包使用本机 ad-hoc 签名。其他 Mac 上通过 Gatekeeper 的公开分发还需要 Developer ID 签名、公证和独立设备验证。
  - 已在 `package.json` 预置 Windows（NSIS）与 Linux（AppImage）构建目标，但本次仅在 macOS `arm64` 环境完成实机打包与运行验收；
  - 尚未接入本机文件系统原地 `⌘S` 覆写、系统字体全量枚举、自动更新（`electron-updater`）与内置 `server/mcp.ts` 子进程托管，将作为后续桌面能力演进。

默认桌面操作验收从临时后台副本启动，在离屏窗口执行并验证窗口不可见。显式系统拼音用例需要系统输入法焦点，独立于这组后台验收。
