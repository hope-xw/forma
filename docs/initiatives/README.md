# Forma 课题目录规范与台账（`docs/initiatives/`）

本目录承载 Forma 每个中大型需求、架构升级或专项攻关的**全生命周期课题文档**。即使施工由多路 AI 协同完成，任何跨模块变更都必须先立项落盘需求、工程边界与任务清单，再动代码，确保每一阶段可追溯、可交接、可审计。

## 一、目录结构与必备文档

每个新课题按日期与英文短横线命名建立独立目录：`docs/initiatives/<YYYY-MM-DD>-<slug>/`，必须包含以下三份核心文档：

```text
docs/initiatives/<YYYY-MM-DD>-<slug>/
├── PRD.md           # 需求文档：背景与痛点证据、目标与非目标、业界对标、验收标准与产品边界
├── ENGINEERING.md   # 工程设计：系统架构图、模块划分、精确类型/接口契约、安全与降级边界、测试矩阵
└── TASKS.md         # 任务清单：分期 WBS、并行施工文件所有权、逐项 DoD、进度勾选与关键决策日志（ADR）
```

### 与仓库其他文档的分工边界

| 目录 | 定位 | 维护规则 |
| --- | --- | --- |
| `docs/initiatives/<date>-<slug>/` | **课题级项目管理与过程真相源**（为什么做、怎么拆、做到哪一步、哪些明确不做） | 开工前建档，施工中实时勾选 `TASKS.md`，结项标记状态并链接证据 |
| `docs/specs/` | **长期生效的产品与交互规格（SSOT）** | 课题确认并落地后，将长期生效的协议、UI 规范沉淀至 `docs/specs/` 并登记索引 |
| `docs/evidence/<date>/` | **客观实测产物与基准数据**（`.forma.json`、对比截图、性能 JSON、评测报告） | 每次实拍与回归验收独立归档，不覆写历史基线 |
| `docs/EDITOR-ACCEPTANCE.md`、`docs/HANDOFF.md` | **跨课题验收总账与交接入口** | 课题里程碑验收通过后同步摘要与边界 |

## 二、课题推进硬约束

1. **先立档再施工**：不得跳过 `PRD.md`、`ENGINEERING.md`、`TASKS.md` 直接大面积改代码。
2. **明确写清「非目标」与「边界」**：每份 `PRD.md` 必须单列「明确不做 / 下期范围」，每份 `ENGINEERING.md` 必须写清安全红线（如 SSRF、无脚本沙盒、零静默联网、密钥保护）与降级策略。
3. **并行施工零文件冲突**：多路 Agent/Codex 并行开发前，必须在 `TASKS.md` 写明各路独占文件所有权，集成阶段统一联调与回归。
4. **交付必须用客观实测说话**：涉及渲染、审美或交互质量升级的课题，必须保留改造前后同题对比证据。

---

## 三、课题台账索引

| 课题目录 | 状态 | 启动日期 | 核心目标 | 关联长期规格 |
| --- | --- | --- | --- | --- |
| [2026-11-24-ai-generation-v2](2026-11-24-ai-generation-v2/PRD.md) | 已实施并验收（Wave 1） | 2026-11-24 | 跨越 AI UI 生成代差：真实摄影配图（44 张核验精选 + 安全本地化）+ 369 枚本地 Lucide 矢量图标 + 现代材质解锁 + HTML/CSS-to-Forma 双引擎编译 + 多模态视觉自审闭环 | [AGENT-GENERATION-V2.md](../specs/AGENT-GENERATION-V2.md) · [AGENT-TOOLS-AND-SKILLS.md](../specs/AGENT-TOOLS-AND-SKILLS.md) |
| [2026-11-25-assets-and-library-manager](2026-11-25-assets-and-library-manager/PRD.md) | 已实施并验收 | 2026-11-25 | 资源面板 UI3 一致性重构 + 组件库管理中心（官方 4 大体系 98 组件 / 686 变体 / 10 模板按文件启停、文档主组件打包、`.fig`/`.sketch` 离线提取建库、安全卸载与 AI 联动） | [COMPONENT-LIBRARY-MANAGEMENT.md](../specs/COMPONENT-LIBRARY-MANAGEMENT.md) · [EDITOR-UI-CONTROLS.md](../specs/EDITOR-UI-CONTROLS.md) |
| [2026-11-25-forma-ai-library-intelligence](2026-11-25-forma-ai-library-intelligence/PRD.md) | 已实施并验收（Stage 1） | 2026-11-25 | Forma AI 组件库智能理解与混合装配：活体三级资产（Page/Block/Component）+ 离线/增量 AI 说明书、HTML 插槽化原装实例混编与 Token 吸附、Blueprint 模块派生、多画板主/异常矩阵与前置收口一镜到底生成（预留三维记忆契约） | [FORMA-AI-LIBRARY-AND-MEMORY.md](../specs/FORMA-AI-LIBRARY-AND-MEMORY.md) · [AGENT-TOOLS-AND-SKILLS.md](../specs/AGENT-TOOLS-AND-SKILLS.md) |
| [2026-11-25-release-governance-pipeline](2026-11-25-release-governance-pipeline/PRD.md) | 已实施并验收 | 2026-11-25 | 版本分级判定规则（`none`/`patch`/`minor`/`major` + 同步桌面打包门禁）与自动化发版/只读挂载 DMG 验收流水线，并落地 `v0.10.0` 实测发版 | [VERSIONING-AND-DESKTOP.md](../specs/VERSIONING-AND-DESKTOP.md) |
| [2026-11-25-forma-ai-stage2-project-memory](2026-11-25-forma-ai-stage2-project-memory/PRD.md) | 已实施并验收（Stage 2） | 2026-11-25 | Forma AI Stage 2：轻量项目空间（多稿共享 + 草稿单稿兜底）、项目级《历史需求档案（Episode）》离线沉淀与中英混合召回、`@历史需求` 引用与衍生模块一键回流组件库（自动刷新 AI 说明书） | [FORMA-AI-LIBRARY-AND-MEMORY.md](../specs/FORMA-AI-LIBRARY-AND-MEMORY.md) · [AGENT-TOOLS-AND-SKILLS.md](../specs/AGENT-TOOLS-AND-SKILLS.md) |
| [2026-11-26-ai-panel-ux-redesign](2026-11-26-ai-panel-ux-redesign/PRD.md) | 已实施并验收 | 2026-11-26 | Forma AI 对话面板用户体验重构与模块化拆解：从工程参数面板转为满高设计师对话工作区、渐进式披露高级偏好与 MCP 接入、去除重复提示与内部术语、拆分 `AgentPanel` 单体并打磨 `CanvasAgentBar` | [AGENT-PROVIDER-AND-CANVAS-CHAT.md](../specs/AGENT-PROVIDER-AND-CANVAS-CHAT.md) · [FORMA-AI-LIBRARY-AND-MEMORY.md](../specs/FORMA-AI-LIBRARY-AND-MEMORY.md) |
| [2026-11-26-engineering-ux-balance](2026-11-26-engineering-ux-balance/PRD.md) | 已实施并验收 | 2026-11-26 | P0/P1/P2 全栈工程与体验平衡升级：分层 ErrorBoundary 与防丢稿导出、桌面/Web 文案与左栏导航分组、架构边界归位与 `lint:arch` 门禁、AI 应用层下沉与首屏分包瘦身、CSS `@layer` 治理与空画布引导体验 | [ARCHITECTURE.md](../ARCHITECTURE.md) · [EDITOR-UI-CONTROLS.md](../specs/EDITOR-UI-CONTROLS.md) |
