# 任务清单与进度台账 · Forma AI Stage 2：轻量项目空间、历史需求记忆与衍生模块回流

- **课题编号**：`2026-11-25-forma-ai-stage2-project-memory`
- **分工治理**：主控架构师（方案拍板、任务拆解、质量门禁、真机验收、版本发版与文档沉淀）+ **Codex CLI**（多轨代码实施与独立只读 Code Review）
- **状态图例**：`[ ]` 待开始 · `[/]` 进行中 · `[x]` 已完成

---

## Phase 0 · 产品模型确认与课题建档

- [x] **T0.1** 与用户对齐 Stage 2 项目单元模型，拍板采用 **方案 B：轻量项目空间（1 项目含多份设计稿）+ 未归类草稿默认按单稿隔离**，直接升级现有「本机文件」管理页。
- [x] **T0.2** 建立课题目录 `docs/initiatives/2026-11-25-forma-ai-stage2-project-memory/`，落盘 `PRD.md`、`ENGINEERING.md`、`TASKS.md` 并登记至 `docs/initiatives/README.md`。

---

## Phase 1 · 核心引擎三轨并行施工（Codex CLI，零文件冲突）

### Track A（Codex Worker A）：轻量项目空间 + 《历史需求档案》持久层与混合召回引擎
- [x] **T1.A1** 新建 `src/agent/project-memory.ts`（Zod Schema、作用域解析、`rankProjectEpisodes` 中英混合确定性召回、`buildEpisodeFromAppliedProposal`、`buildManualEpisodeFromSelection`、`formatEpisodePromptSection`）。
- [x] **T1.A2** 新建 `src/infrastructure/project-memory-store.ts`（`ProjectMemoryRepository`、IndexedDB `forma-project-memory-v1` + 内存降级仓、草稿移入项目记忆自动迁移、单作用域 100 条置顶保护淘汰、事件订阅总线）。
- [x] **T1.A3** 新建 `tests/project-memory.test.ts` 并通过全部单测与 `tsc --noEmit`（24/24 项通过）。

### Track B（Codex Worker B）：衍生模块一键回流沉淀引擎
- [x] **T1.B1** 新建 `src/domain/library-promotion.ts`（`suggestPromotionDefaults`、`promoteSelectionToLibrary`：官方只读库保护、项目衍生库创建/追加、已有实例无冲突变量/字体/图片合并、AI 说明书增量刷新保留手写备注、可选原子替换为受保护实例）。
- [x] **T1.B2** 新建 `tests/library-promotion.test.ts` 并通过全部单测与 `tsc --noEmit`（19/19 项通过，含跨库交互变量重映射回归）。

### Track C（Codex Worker C）：Forma AI 上下文 L2 记忆注入、只读记忆工具与服务端校验
- [x] **T1.C1** 升级 `src/agent/context-builder.ts`（`AgentMention` 增加 `"episode"`、`DesignMemoryScope` 扩展、`RecalledEpisodePayload`、L2 记忆 Prompt 注入与 `@episode` 解析）。
- [x] **T1.C2** 升级 `src/agent/forma-tools.ts` 与 `src/agent/design-engine.ts`（新增 `search_project_episodes`、`get_episode_details` 只读工具及动态按需挂载）。
- [x] **T1.C3** 升级 `server/agent-http.ts`（严格 Zod 校验 `recalledEpisodes`、`memoryScope` 与 `mentions[kind="episode"]`）并补充 `tests/agent-tools.test.ts` 与 `tests/agent-http-integration.test.ts`（74/74 项通过）。

---

## Phase 2 · 编辑器 UI 与全链路联调（Codex CLI，Phase 1 通过后并行启动）

### Track D1（Codex Worker D1）：项目空间文件管理、顶栏面包屑与模块沉淀弹窗
- [x] **T2.D1** 升级 `src/infrastructure/storage.ts` 与 `src/editor/FileBrowser.tsx`（两栏项目空间管理、项目 CRUD 与默认库绑定、单文件归属/迁移及草稿记忆随迁、项目内建稿/导入/复制）。
- [x] **T2.D2** 新建 `src/editor/PromoteModuleModal.tsx` 并接入 `src/editor/ContextMenu.tsx`、`src/editor/AssetsPanel.tsx`、`src/editor/App.tsx`；顶栏动态显示当前项目名；Canvas HUD 采纳提案同步沉淀档案。
- [x] **T2.D3** 完善 `src/editor/styles.css` 与 `src/editor/ui3-theme.css` 双主题（深/浅）及短窗口适配。

### Track D2（Codex Worker D2）：Forma AI 记忆条、离线档案抽屉与 `@历史需求` 交互
- [x] **T2.E1** 升级 `src/editor/agent-client.ts` 与 `src/editor/CanvasAgentBar.tsx`（`episode` mention 类型、`@历史需求` 弹窗标签页、`recalledEpisodes` 传输与 `episodeDraftMeta` 贯通）。
- [x] **T2.E2** 升级 `src/editor/AgentPanel.tsx` 与 `src/editor/agent-ui.css`（项目记忆条、默认库一键载入、离线「历史需求档案」抽屉、手动归档当前画板、采纳自动沉淀、`@引用`/置顶/删除、应用后沉淀模块快捷入口、调用详情展示召回档案）。
- [x] **T2.E3** 扩展 `scripts/check-agent-canvas-chat.browser.js` 覆盖跨文件项目记忆、离线归档、衍生模块沉淀回流与模拟 AI 召回端到端流程。

---

## Phase 3 · 独立 Codex CLI Code Review、全量验收与版本同步打包

- [x] **T3.1** 调用独立只读 **Codex CLI Reviewer** 完成多轮深度审查（Round 1–18），全量闭环全部 P0 及设计师正常路径下的跨标签隔离、原子 2PC 授权、离线重连与指纹去重缺陷（剩余 2 项 97–98 置顶满仓多标签瞬时竞态与 2 项仅影响画板列表不丢数据的极端字体/等值重绑边界已登记为已知边界）。
- [x] **T3.2** 全量工程门禁：`npm test`（**896 项：895 通过、0 失败、1 跳过**，跳过项为 Node 环境无原生 IndexedDB，较 `v0.10.0` 基线 595 项净增 **+300 项**）、`npm run format:check`、`npm run build`、`npm run desktop:agent` 100% 通过。
- [x] **T3.3** 真实 Chromium 浏览器 E2E 回归 **9 / 9 通过**（`agent-canvas-chat`、`assets-libraries`、`editor-panels`、`optional-gateway`、`library-tokens`、`panel-parity`、`mcp`、`files`、`storage`）+ 导出工程独立验证（`npm run test:exports -- agent-canvas-chat`：`83,803` 字节 ZIP 离线安装、构建、运行通过）+ 深/浅双主题对比度 6.41–7.36∶1 与 0 启动外网请求核验。
- [x] **T3.4** 更新 `docs/specs/FORMA-AI-LIBRARY-AND-MEMORY.md`、`docs/EDITOR-ACCEPTANCE.md`、`docs/HANDOFF.md`、`docs/ARCHITECTURE.md`、`docs/evidence/2026-11-26/forma-ai-stage2/acceptance.json` 及本课题台账状态。
- [x] **T3.5** 运行 `npm run release:assess` 判定升版策略，通过 `npm run release:run` 同步发布 **`v0.11.0`**、构建 macOS 桌面端 `.dmg`/`.zip` 并完成只读挂载实机验收归档。

---

## 关键工程决策日志（ADR）

| 日期 | 决策 | 原因与权衡 |
| --- | --- | --- |
| 2026-11-25 | **项目单元采用「轻量项目空间（多稿共享）+ 未归类草稿按 `file:<key>` 兜底」** | 既解决同一业务多份设计稿跨稿共享历史需求与衍生模块的刚需，又避免新建草稿时的建项阻力；直接升级现有 `FileBrowser` 控制改造面，数据结构可无缝演进至独立工作台。 |
| 2026-11-25 | **项目记忆独立存放于 IndexedDB `forma-project-memory-v1`，不升 `forma-studio` v3 版本号** | 零多标签库升级阻塞风险，不影响既有大文档分区存储与备份恢复；同时与 `forma-workspace-libraries-v1` 保持一致的隔离存储范式。 |
| 2026-11-25 | **召回档案随 `POST /api/agent/chat` 精简传输（不含 SVG 缩略图），不新增 Electron/HTTP 路由** | 严格控制请求体积，天然兼容 Web 开发、生产预览与 Electron `forma://app/` 协议，零额外鉴权/代理面。 |
| 2026-11-25 | **衍生模块沉淀禁止原地改写 4 大官方只读内置库，追加到自定义/项目衍生库时不改动既有组件绑定** | 防止污染官方版本化套件，并保证 `commands.ts` 的 `putLibrary` 实例结构一致性守卫在已有画布实例时 100% 原子通过。 |
