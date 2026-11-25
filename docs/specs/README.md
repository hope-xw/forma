# Forma 产品与交互规格目录（`docs/specs/`）

本目录用于沉淀 Forma 长期生效的产品交互规格、UI 控件规范、功能入口台账、快捷键约定与界面协议，作为设计与开发共同遵循的**单一事实来源（SSOT）**，确保所有已确认规则有据可查、可对照源码核验。

## 规格索引

| 文档 | 状态 | 最近更新 | 覆盖范围 | 核心实现路径 |
| --- | --- | --- | --- | --- |
| [Sketch 与 Figma 设计文件导入](DESIGN-FILE-IMPORT.md) | 已实施并验收（实测范围） | 2026-11-23 | 本地原生文件导入、组件和样式映射、Apple 两份原稿的结构核对及 1× 源端渲染验收 | `src/domain/`、`src/infrastructure/`、`src/editor/`、`electron/` |
| [Forma 与 Figma 功能面板编号及用户验收](EDITOR-PANEL-ACCEPTANCE.md) | 已实施并验收 | 2026-11-22 | 61 个面板编号（新增 03.08–03.11、04.20–04.22、06.04、07.04、08.03–08.04）、Figma 对应入口、既有 50 面板深度对齐、实测截图及能力边界 | `src/editor/`、`src/runtime/`、`src/compiler/`、`electron/` |
| [多模型配置、能力识别与画布对话设计规格](AGENT-PROVIDER-AND-CANVAS-CHAT.md) | 已实施并验收（v2） | 2026-11-24 | 13 家主流供应商「先选供应商再填 Key」显式接入、五层模型能力真相源（上游 `/models` 实时元数据 + 2026 目录 + 用户覆写）、一键刷新与画布 `⌘↵` 对话预览 | `src/agent/`、`server/`、`src/editor/ModelConfigModal.tsx`、`src/editor/CanvasAgentBar.tsx`、`src/editor/AgentPanel.tsx` |
| [Forma Agent 原生工具调用与第三方 Skill 生态规格](AGENT-TOOLS-AND-SKILLS.md) | 已实施并验收（Phase 1） | 2026-11-24 | 三协议原生 Function Calling 闭环、原生工具、蓝图自动布局、影子提案查询与体检回执、组件覆写与非静默诊断、`agentskills.io` `SKILL.md` 开放标准三层渐进式披露、7 工具外部 MCP Server 与 Phase 2 MCP Client 蓝图 | `src/agent/adapters.ts`、`src/agent/forma-tools.ts`、`src/agent/skills.ts`、`server/skill-registry.ts`、`server/mcp.ts`、`src/editor/SkillsModal.tsx` |
| [Forma Agent 生成引擎 V2 规格](AGENT-GENERATION-V2.md) | 已实施并验收（Wave 1） | 2026-11-24 | 369 枚内置 Lucide 矢量图标原语、安全摄影配图本地化管线、现代毛玻璃/超椭圆/高光材质、HTML/CSS-to-Forma 沙盒双引擎编译与多模态视觉自审闭环 | `src/agent/icon-library.ts`、`src/agent/media-assets.ts`、`src/agent/html-to-forma.ts`、`src/editor/html-forma-sandbox.ts`、`src/agent/design-engine.ts` |
| [Forma AI 组件库智能理解、混合装配与三维设计记忆规格](FORMA-AI-LIBRARY-AND-MEMORY.md) | 已实施并验收（Stage 1） | 2026-11-25 | 活体组件库三级分层（Page/Block/Component）、离线硬契约与增量 AI 说明书、HTML 插槽化原装实例混编与 Token 吸附、Blueprint 模块派生、多画板主/异常矩阵、前置收口零打断生成与三维记忆作用域契约 | `src/agent/library-intelligence.ts`、`src/agent/html-to-forma.ts`、`src/agent/blueprint-compiler.ts`、`src/agent/forma-tools.ts`、`src/editor/AgentPanel.tsx`、`src/editor/LibraryManagerModal.tsx` |
| [专业编辑与组件库发布](PROFESSIONAL-EDITING.md) | 已实施并验收 | 2026-11-21 | 文本图层原位编辑、位图裁切与调色、分支矢量、画布组件集、网格轨道与指定单元格、位图蒙版、文件字体、实例属性、跨文件发布、属性更名、容器外观断点和修订审阅 | `src/domain/`、`src/editor/`、`server/library-service.ts` |
| [组件库管理与内置多体系规范](COMPONENT-LIBRARY-MANAGEMENT.md) | 已实施并验收 | 2026-11-25 | 四大内置成熟设计体系（iOS / Material Design 3 / Ant Design 5 / shadcn/ui，共 98 组件 / 686 变体 / 10 模板）、资源面板 UI3 重构、组件库管理中心按文件启停、文档打包建库、`.fig`/`.sketch` 离线提取与安全卸载 | `src/design-system/`、`src/domain/library-packaging.ts`、`src/infrastructure/library-catalog-store.ts`、`src/editor/AssetsPanel.tsx`、`src/editor/LibraryManagerModal.tsx` |
| [设计师操作与 Figma 能力对照](EDITOR-PARITY-PLAN.md) | 草案 | 2026-11-21 | 按选区和任务核对、近期缺口、样例与关闭条件 | `src/editor/`、`src/domain/`、`src/compiler/` |
| [React 工程与改版更新](REACT-PROJECT-UPDATES.md) | 已实施并验收 | 2026-11-20 | 首次交付、独立组件、业务入口、再次导出与冲突 | `src/compiler/`、`src/infrastructure/project-revision.ts` |
| [编辑器功能入口、图标按钮与悬停提示规格](EDITOR-UI-CONTROLS.md) | 已实施并验收 | 2026-11-23 | 文件菜单版本日志、位图裁切、原型触摸与键盘输入、自动布局九点对齐、间距和四边输入的排布，及全产品 7 大区域图标入口台账、Tooltip 交互时序与定位、图标按钮热区与分隔线视觉规范、DOM 属性协议 | `src/editor/TooltipHost.tsx`、`src/editor/design-system.css` 及各编辑面板组件 |
| [产品版本号规范与 Electron 桌面客户端架构规格](VERSIONING-AND-DESKTOP.md) | 已实施并验收 | 2026-11-25 | 逐版项目日志、重要版本的产品摘要与补丁归并、四档版本升级与同步打包判定规则、自动化发版与只读挂载 DMG 验收流水线、`package.json` 单一版本源、Electron 架构与 `forma://app/` 协议、原生菜单防冲突策略 | `package.json`、`vite.config.ts`、`electron/main.mjs`、`electron/preload.cjs`、`scripts/release/` |
| [大型设计文件的资源、保存与恢复](LARGE-DESIGN-STORAGE.md) | 已实施并验收 | 2026-11-23 | SHA 资源、嵌入字体、流式原生文件、IndexedDB v3 分块与恢复 | `src/infrastructure/native-document.ts`、`src/infrastructure/storage*.ts` |

## 目录边界

- **`docs/specs/`**：长期生效的交互、UI、快捷键、控件与功能入口规格。
- **`docs/*.md`（根目录）**：架构约束（`ARCHITECTURE.md`）、子系统说明（`DESIGN-SYSTEM.md`、`MOBILE-LIBRARY.md`、`CANVAS-COVERAGE.md`、`AGENT-PROTOCOL.md`）、交接与实测验收（`HANDOFF.md`、`EDITOR-ACCEPTANCE.md`）。
- **`docs/requirements/`**：外部调研与原始研究目录（参考输入，不自动等同于已确认规格）。

## 编写与维护规则

1. **命名规范**：规格文件采用大写短横线英文名（`UPPER-KEBAB-CASE.md`），新建文件须同步登记到上表。
2. **必备元信息**：文档顶部注明**最近更新日期**、**状态**（`草案` / `已实施并验收` / `已废弃`）、**关联源码路径**与**验收方式**。
3. **代码同源**：规格中的属性名、像素尺寸、时序数值、色值、快捷键和禁用态说明须与代码一致；变更交互或控件行为时，在同一次任务中同步更新对应规格文档。
4. **实事求是**：涉及与 Figma 对齐的条目，明确区分「已实现」与「当前边界」，不得将计划中的能力写成已验收状态。
