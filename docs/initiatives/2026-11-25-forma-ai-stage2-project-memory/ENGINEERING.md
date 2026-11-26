# 工程设计文档 · Forma AI Stage 2：轻量项目空间、历史需求记忆与衍生模块回流

- **课题编号**：`2026-11-25-forma-ai-stage2-project-memory`
- **状态**：已定稿，按隔离轨道并行施工
- **关联需求**：[PRD.md](PRD.md) · [TASKS.md](TASKS.md)

---

## 一、系统总体架构

```text
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                      Forma 编辑器 UI（Web / Electron 一体化离线可用）                   │
│  • 顶栏面包屑：显示当前项目空间名（点击打开升级版 FileBrowser）                           │
│  • FileBrowser（本机文件与项目空间）：左栏项目空间 CRUD / 默认库绑定，右栏文件归属迁移      │
│  • AgentPanel / CanvasAgentBar：                                                     │
│      - 项目记忆条 + 离线「历史需求档案」抽屉（查看/搜索/手动归档/置顶/删除/@引用）          │
│      - 采纳提案自动沉淀 DesignEpisode；新请求前本地 rankProjectEpisodes 召回 Top-K       │
│  • PromoteModuleModal（右键 / 资源面板 / AI 应用后栏）：                                 │
│      - 一键沉淀选中楼层到项目衍生库或自定义库 + 自动增量刷新 AI Playbook + 同步工作区库     │
└──────────────┬───────────────────────────────────────┬───────────────────────────────┘
               │ IndexedDB (本地离线持久层)              │ POST /api/agent/chat (SSE)
               ▼                                       │ (+ memoryScope, recalledEpisodes,
┌─────────────────────────────────────────┐            │    mentions[kind="episode"])
│ forma-project-memory-v1                 │            ▼
│  • projects      (ProjectSpace)         │  ┌─────────────────────────────────────────┐
│  • assignments   (fileKey → projectId)  │  │ Forma AI Engine (src/agent/ + server/)  │
│  • episodes      (DesignEpisode)        │  │  • context-builder.ts：                 │
│                                         │  │    注入「项目历史需求记忆（L2）」          │
│ forma-workspace-libraries-v1 (已有)     │  │    解析 @episode 引用                    │
│  • libraries     (跨文件共享衍生组件库)  │  │  • forma-tools.ts（新增 2 个只读工具）： │
└─────────────────────────────────────────┘  │    - search_project_episodes            │
                                             │    - get_episode_details                │
                                             │  • server/agent-http.ts：               │
                                             │    严格 Zod 校验 recalledEpisodes & @ep  │
                                             └─────────────────────────────────────────┘
```

**关键架构选择**：项目空间与历史需求档案持久化在独立 IndexedDB 数据库 `forma-project-memory-v1`（不改动既有 `forma-studio` v3 schema，避免多标签升级阻塞），召回摘要随现有 `POST /api/agent/chat` 请求下发。因此无需新增后端 HTTP 代理路由，Web 开发态、生产预览与 Electron `forma://app/` 桌面打包端天然一致。

---

## 二、核心数据结构与接口契约

### 2.1 项目空间与作用域解析（`src/agent/project-memory.ts`）

```ts
export interface ProjectSpace {
  id: string;                 // "proj-<uuid>"
  name: string;               // 1–120 字符
  description?: string;       // 0–400 字符
  defaultLibraryId?: string;  // 绑定的默认组件库 ID（内置/工作区/项目衍生库）
  createdAt: string;          // ISO-8601
  updatedAt: string;          // ISO-8601
}

export interface FileProjectAssignment {
  fileKey: string;            // 对应 storage.ts FileSummary.key
  projectId: string;          // ProjectSpace.id
  updatedAt: string;
}

export interface ResolvedMemoryScope {
  scopeProjectId: string;     // "proj:<projectId>" | "file:<fileKey>"
  projectSpaceId?: string;    // 归属项目空间时的原始 ProjectSpace.id
  scopeLabel: string;         // 项目名称 或 "未归类草稿（单稿记忆）"
  isProjectSpace: boolean;
  fileKey: string;
  libraryId?: string;
  userId: string;             // 默认 "local-default"
}
```

- **作用域确定性规则**：
  - 文件已归属某项目空间 `P` → `scopeProjectId = "proj:" + P.id`；
  - 文件未归属任何项目空间 → `scopeProjectId = "file:" + fileKey`；
  - 将未归类草稿移入项目 `P` 且 `migrateEpisodes !== false` → 自动将该文件在 `file:<fileKey>` 下的所有档案迁移至 `proj:<P.id>`（保留 `sourceFileKey` 与 `sourceFileName`）；
  - 将文件移出项目或切到另一项目 → 保留原项目共享历史不被误删；
  - 删除项目空间 → 仅解除该项目的全部文件归属（文件保留为未归类草稿，**绝不删文件**），清理该项目自身元数据与 `proj:<id>` 档案；
  - 删除本地设计文件 → 同步清理其 `fileAssignments` 与私有 `file:<fileKey>` 档案（若文件曾属于某项目，保留已沉淀至该项目的共享档案）。

### 2.2 《历史需求档案（`DesignEpisode`）》与线上传输载荷

```ts
export interface EpisodeScreenSummary {
  rootId: string;
  name: string;
  role: "primary" | "overlay" | "exception" | "detail";
  width: number;
  height: number;
  nodeCount: number;
  componentIds: string[];
  sampleTexts: string[];
}

export interface EpisodeComponentRef {
  libraryId: string;
  componentId: string;
  componentName: string;
  assetTier?: AssetTier;
  variantId?: string;
  count: number;
}

export interface EpisodeDecisionRecord {
  question: string;
  choice: string;
}

export interface DesignEpisode {
  id: string;
  scopeProjectId: string;
  sourceFileKey: string;
  sourceFileName: string;
  sourceDocId: string;
  libraryId?: string;
  libraryName?: string;
  userId: string;
  title: string;
  prompt: string;
  summary: string;
  mode: "generate" | "edit";
  screens: EpisodeScreenSummary[];
  componentsUsed: EpisodeComponentRef[];
  customModules: string[];
  decisions: EpisodeDecisionRecord[];
  tags: string[];
  thumbnailSvg?: string;      // 仅本地展示，≤ 48 KB，绝不随 chat 请求发送
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
}
```

发送到 `/api/agent/chat` 的精简载荷 `RecalledEpisodePayload`（上限 8 条，剥离 `thumbnailSvg`）：

```ts
export interface RecalledEpisodePayload {
  id: string;
  title: string;
  sourceFileKey: string;
  sourceFileName: string;
  isCurrentFile: boolean;
  libraryId?: string;
  libraryName?: string;
  prompt: string;
  summary: string;
  mode: "generate" | "edit";
  screens: EpisodeScreenSummary[];
  componentsUsed: EpisodeComponentRef[];
  customModules: string[];
  decisions: EpisodeDecisionRecord[];
  tags: string[];
  createdAt: string;
  pinned?: boolean;
  explicitlyMentioned?: boolean;
  matchScore?: number;
  matchReasons?: string[];
}
```

### 2.3 离线中英混合召回排序算法（`rankProjectEpisodes`）

纯本地确定性排序，零外网调用：
1. **中英混合分词**：拉丁字母/数字按词元切分并转小写，中文连续序列抽取 2-gram 与 3-gram 及常见设计业务词（页面、模块、商品、搜索、异常、订单、登录、弹窗等）；
2. **显式 `@历史需求` 置顶**：所有显式 `@episode` 引用的档案强制入选首位（`explicitlyMentioned: true`，`matchReasons` 含 `"显式引用"`），不受常规关键词门槛淘汰；
3. **三维匹配加权**：
   - `Project × Library`：同 `libraryId` 加分 `+30`（`同组件库`）；指定了目标库但档案属于其他库时降权 `-10`（避免跨库风格串味）；
   - 同项目内稿件亲和度：同 `sourceFileKey` 加 `+12`（`当前设计稿`），同项目其他稿件标记 `同项目跨稿` 正常参与召回；
   - 文本/组件/模块/标签重合分：对 `title`（×3）、`tags`/`customModules`/`componentsUsed`（×2.2）、`screens.name`/`summary`（×1.8）、`prompt`/`sampleTexts`（×1）计算加权词元命中分；
   - `pinned` 加 `+8`，近 30 天内按平滑时间衰减加 `0..6`；
4. **容量策略**：默认返回 Top `5`（含显式引用最多 `8` 条）；无关键词重叠且非显式引用时，仍可保留最多 `2` 条同库/置顶或最近项目档案作为项目基线参考。

### 2.4 衍生模块回流沉淀引擎（`src/domain/library-promotion.ts`）

```ts
export interface PromoteSelectionOptions {
  targetLibraryId?: string;          // 已有自定义/项目库 ID；留空或 "__new_project_library__" 时自动创建/复用项目衍生库
  existingWorkspaceLibrary?: ComponentLibrary; // 若目标库尚仅存在工作区仓库而未装入当前文档
  projectId?: string;                // 用于生成稳定项目衍生库 ID `proj-lib-${projectId}`
  projectName?: string;              // 用于生成默认库名 `${projectName} · 业务模块库`
  componentName?: string;
  category?: string;
  assetTier?: AssetTier;
  description?: string;
  whenToUse?: string;
  tags?: string[];
  refreshPlaybook?: boolean;         // 默认 true：增量刷新 aiGuide，保留 <!-- forma:custom-notes -->
  replaceSelectionWithInstance?: boolean; // 默认 false：可选原子替换为受保护实例
}

export interface PromoteSelectionResult {
  library: ComponentLibrary;
  componentId: string;
  variantId: string;
  createdNewLibrary: boolean;
  operations: Operation[];           // 原子事务操作列表，单步 ⌘Z 可完整撤回
  replacedNodeId?: string;
}
```

**不变量与安全红线**：
1. 禁止直接覆写 4 大官方只读内置库（`BUILTIN_LIBRARY_IDS`），调用方传内置库 ID 时明确抛错；
2. 向已有自定义库追加新组件时，**严禁改动该库已有任何组件的节点或绑定**——仅对新抽离组件的节点执行变量/样式冲突重映射，确保 `src/domain/commands.ts` 中 `putLibrary` 的已有实例结构完整性守卫 100% 通过；
3. 自动执行 `generateLibraryPlaybook(nextLibrary, targetLibrary?.aiGuide)` 增量刷新说明书，严格保留设计师手写 `<!-- forma:custom-notes -->` 区块；
4. 若启用 `replaceSelectionWithInstance: true`，在同一笔事务中顺序发射 `putLibrary` → `instantiateComponent`（保持原 `parentId`、坐标与同级顺序）→ `remove(nodeId)`，确保一次 `⌘Z` 完整回滚。

### 2.5 新增只读 Forma AI 工具（`src/agent/forma-tools.ts`）

当 `ctx.recalledEpisodes?.length > 0` 时自动挂载 2 个只读工具：
- `search_project_episodes({ query?, libraryId?, onlyCurrentFile?, limit? })`：按关键词、组件库或当前稿过滤项目历史需求档案，返回精简列表与命中原因；
- `get_episode_details({ episodeId })`：返回指定档案的完整画板规格、复用组件清单（含精确 `libraryId` / `componentId` / `variantId`）、自建模块与已拍板决策。

---

## 三、模块划分与并行施工文件所有权（零冲突隔离）

### Phase 1 · 三轨并行施工（Codex CLI）

| 轨道 | 独占文件 | 核心职责 |
| --- | --- | --- |
| **Track A（Codex Worker A）** | `src/agent/project-memory.ts`（新）<br>`src/infrastructure/project-memory-store.ts`（新）<br>`tests/project-memory.test.ts`（新） | 项目空间与历史需求档案 Zod Schema、作用域解析、中英混合确定性召回排序、提案自动沉淀与离线手动归档、IndexedDB + 内存降级持久层、草稿入项记忆迁移、完整单测。 |
| **Track B（Codex Worker B）** | `src/domain/library-promotion.ts`（新）<br>`tests/library-promotion.test.ts`（新） | `suggestPromotionDefaults` 与 `promoteSelectionToLibrary`：官方只读库保护、新建/追加项目衍生库、安全增量合并变量/字体/图片不破坏已有实例、增量刷新 AI 说明书（保留自定义备注）、可选原子替换为受保护实例与单步撤销单测。 |
| **Track C（Codex Worker C）** | `src/agent/context-builder.ts`<br>`src/agent/forma-tools.ts`<br>`src/agent/design-engine.ts`<br>`server/agent-http.ts`<br>`tests/agent-tools.test.ts`<br>`tests/agent-http-integration.test.ts` | 扩展 `AgentMention`（`episode`）、`DesignMemoryScope`、`RecalledEpisodePayload`；L2 项目记忆 System Prompt 注入；新增 `search_project_episodes` 与 `get_episode_details` 只读工具；服务端严格 Zod 校验与向后兼容回归测试。 |

### Phase 2 · 编辑器 UI 与全链路集成（Phase 1 验收后双轨并行）

| 轨道 | 独占文件 | 核心职责 |
| --- | --- | --- |
| **Track D1（Codex Worker D1）** | `src/infrastructure/storage.ts`<br>`src/editor/FileBrowser.tsx`<br>`src/editor/PromoteModuleModal.tsx`（新）<br>`src/editor/ContextMenu.tsx`<br>`src/editor/AssetsPanel.tsx`<br>`src/editor/App.tsx`<br>`src/editor/styles.css`<br>`src/editor/ui3-theme.css` | 升级「本机文件」为两栏「本机文件与项目空间」（项目 CRUD、默认库绑定、文件归属迁移与记忆随迁、项目内建稿）；顶栏动态项目面包屑；实现 `PromoteModuleModal` 并接入右键菜单、资源面板与 App 主控；删文件同步清理项目映射与单稿私有记忆；Canvas HUD 应用提案同步沉淀 Episode。 |
| **Track D2（Codex Worker D2）** | `src/editor/agent-client.ts`<br>`src/editor/CanvasAgentBar.tsx`<br>`src/editor/AgentPanel.tsx`<br>`src/editor/agent-ui.css`<br>`scripts/check-agent-canvas-chat.browser.js` | `AgentMention` 支持 `episode` 与 `@历史需求` 弹窗标签页；`AgentPanel` 项目记忆条、项目默认库联动载入、离线「历史需求档案」抽屉（搜索/手动归档/置顶/删除/`@引用`）、采纳提案自动沉淀 Episode、调用详情展示召回档案、应用后快捷沉淀模块按钮；扩展真实跨文件浏览器 E2E 用例。 |

---

## 四、安全、兼容性与降级红线

1. **零外网零网关可用性**：项目空间、历史需求档案读写/检索/归档、模块回流沉淀与 AI 说明书刷新全部纯本地运行，禁止任何静默外网请求。
2. **存储配额与损坏容错**：单条档案 `thumbnailSvg` 严格限制 ≤ 48 KB（移除超大内嵌位图/脚本/事件处理器后方可用于 `img src` Blob URL，禁止 `dangerouslySetInnerHTML` 注入原始 SVG）；单作用域最多保留 100 条档案（按时间淘汰非置顶条目，置顶条目受保护）；损坏记录跳过读取不影响其余项目或文件。
3. **旧文档与旧请求 100% 兼容**：不改 `.forma` 文档必填字段，不改 `forma-studio` IndexedDB 版本号，不要求 `/api/agent/chat` 必传 `recalledEpisodes` 或 `memoryScope`。
4. **实例结构与撤销完整性**：模块回流与可选替换实例走标准 `transact` 事务并遵循 `validateInstanceStructure`，单次 `⌘Z` 即可完整还原。
