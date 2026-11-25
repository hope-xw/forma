# ENGINEERING · 版本分级判定规则与自动化发版打包流水线

- **课题编号**：`2026-11-25-release-governance-pipeline`
- **状态**：已定稿
- **最近更新**：2026-11-25
- **关联文档**：[PRD.md](PRD.md) · [TASKS.md](TASKS.md) · [版本规范与桌面客户端规格](../../specs/VERSIONING-AND-DESKTOP.md)

---

## 一、模块架构与职责边界

```text
scripts/release/
├── policy.ts          # 纯函数：SemVer 解析递增、文件路径→子系统归类、四档判定引擎 assessReleaseImpact
├── workspace-diff.ts  # 变更探测：优先 Git（存在 .git 时），无 .git 时以当前版本最新 DMG/证据 mtime 为基线扫描源码与课题目录
├── release-files.ts   # 元数据原子读写：Asia/Shanghai 日期、package.json / CHANGELOG.md / release-notes.ts 更新、回滚与一致性校验
├── verify-dmg.ts      # 只读挂载 DMG 实机验收：hdiutil 只读挂载、codesign、Info.plist、app.asar 逐字节比对、离屏 Electron 路由/版本日志/.fig 打开、历史 DMG 完好核验、evidence JSON 输出
└── pipeline.ts        # CLI 主入口：assess | check | verify-dmg | run（支持 --dry-run / --plan / --confirm-major / 失败自动回滚）

tests/
└── release-pipeline.test.ts  # 全量单元测试覆盖策略引擎、文件编辑与回滚、无 Git 变更探测与同步校验
```

所有 `scripts/**/*.ts` 均纳入 `tsconfig.json` 严格类型检查与 Prettier 格式化范围，运行入口统一经 `tsx` 执行（`package.json` 新增 `release:assess` / `release:check` / `release:verify-dmg` / `release:run`）。

---

## 二、核心接口契约

### 1. `scripts/release/policy.ts`

```ts
export type ReleaseBump = "none" | "patch" | "minor" | "major";

export type ChangeSignificance =
  | "docs-or-tests"
  | "internal-refactor"
  | "bugfix"
  | "ux-polish"
  | "workflow-enhancement"
  | "major-feature"
  | "breaking-generation";

export type ReleaseSubsystem =
  | "domain"
  | "editor"
  | "design-system"
  | "agent"
  | "server"
  | "compiler"
  | "runtime"
  | "infrastructure"
  | "electron"
  | "public"
  | "docs"
  | "tests"
  | "scripts"
  | "other";

export interface ReleaseAssessmentInput {
  currentVersion: string;
  changedFiles: readonly string[];
  significance?: ChangeSignificance;
  completedInitiative?: boolean;
  breakingOrV1?: boolean;
  securityOrDataFix?: boolean;
  publicPatch?: boolean;
  overrideBump?: ReleaseBump;
  overridePackageDesktop?: boolean;
}

export interface ReleaseDecision {
  currentVersion: string;
  nextVersion: string;
  bump: ReleaseBump;
  packageDesktop: boolean;
  publishInReleaseNotes: boolean;
  subsystems: ReleaseSubsystem[];
  coreSubsystems: ReleaseSubsystem[];
  runtimeFileCount: number;
  score: number;
  reasons: string[];
  warnings: string[];
}
```

**核心判定规则（与 `VERSIONING-AND-DESKTOP.md` §一.5 完全一致）**：
1. **核心产品子系统集合**：`domain`、`editor`、`design-system`、`agent`、`server`、`compiler`、`runtime`、`infrastructure`、`electron`、`public`。
2. **`major` 判定**：`breakingOrV1 === true` 或 `significance === "breaking-generation"` → `bump = "major"`、`packageDesktop = true`、`publishInReleaseNotes = true`，并在 `warnings` 中提示需用户显式确认（`--confirm-major`）。
3. **`minor` 判定**：满足任一即归入 `minor`：
   - `significance === "major-feature"`；
   - `completedInitiative === true`（完成已立项中大型课题的可交付阶段）；
   - `significance === "workflow-enhancement"` 且触及 `>= 2` 个核心产品子系统；
   - 未显式提供 `significance` 但变更触及 `>= 3` 个核心产品子系统且运行时文件改动 `>= 10` 个（防止大功能变更被遗漏）。
   - `minor` 默认强制 `packageDesktop = true`、`publishInReleaseNotes = true`。
4. **`patch` 判定**：存在核心产品运行时文件改动，或 `significance` 为 `bugfix` / `ux-polish` / `workflow-enhancement`：
   - `bump = "patch"`；
   - `publishInReleaseNotes = Boolean(publicPatch || significance === "workflow-enhancement")`；
   - `packageDesktop = true` 当且仅当满足任一：
     - 触及 `electron` 或 `server` 子系统；
     - `securityOrDataFix === true`；
     - `publishInReleaseNotes === true`（公开重要补丁）；
     - 触及 `>= 2` 个核心产品子系统或运行时文件变更 `>= 5` 个。
   - 否则 `packageDesktop = false`（细小局部 Web 样式/文案补丁，可暂缓打包并记录说明）。
5. **`none` 判定**：仅 `docs` / `tests` / `scripts` / `other` 变更，或 `significance` 为 `docs-or-tests` / `internal-refactor` 且无用户可感知产品行为变化 → `bump = "none"`、`packageDesktop = false`、`publishInReleaseNotes = false`。
6. **人工覆写约束**：允许通过 `overrideBump` / `overridePackageDesktop` 显式覆盖，但：
   - 若 `bump === "minor" || bump === "major"`，仍强制 `publishInReleaseNotes = true`（确保符合 `tests/release-notes.test.ts` 对 `.0` 版本必填 `title` 的硬校验）；
   - 若降级跳过发版或跳过打包而规则判定为必需，在 `warnings` 中输出显式告警。

### 2. `scripts/release/release-files.ts`

- `getShanghaiDate(now?: Date): string`：使用 `Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })` 输出严格 `YYYY-MM-DD`。
- `applyPackageVersionUpdate(rawJson: string, nextVersion: string): string`：校验 SemVer 并替换顶层 `version` 字段，保持 JSON 2 空格缩进与末尾换行。
- `applyChangelogUpdate(rawMd: string, entry: { version: string; date: string; bullets: string[] }): string`：
  - 校验 `version` 未存在于既有 `## <version> ·` 标题中、校验日期格式、至少 1 条非空条目；
  - 将 `## <version> · <date>\n\n- ...\n\n` 插入首个 `## ` 节之前。
- `applyReleaseNotesUpdate(rawTs: string, entry: { version: string; date: string; title?: string; summary: string; highlights?: string[] }): string`：
  - 校验 `version` 未重复、日期单调不倒退；
  - 对 `/^\d+\.\d+\.0$/` 强制校验 `title` 与 `summary` 均非空；对有 `title` 的条目同样要求 `summary` 非空；
  - 在 `releaseUpdates` 数组末尾 `];` 之前安全插入格式化条目（使用 `JSON.stringify` 转义字符串，杜绝引号/换行注入）。
- `verifyReleaseMetadataSync(repoRoot: string)`:
  - 校验 `package.json.version`、`docs/CHANGELOG.md` 最新节标题、`src/editor/release-notes.ts` 末尾项严格一致；
  - 校验 `release/Forma-<version>-arm64.dmg` 是否存在以及是否存在比该 DMG 更新的产品运行时文件（若存在，输出清晰 `staleDesktopPackage` 提示，提醒评估是否需要升版或重打）。

### 3. `scripts/release/verify-dmg.ts`

- **全部外部命令使用 `execFileSync`（数组参数，禁止拼接 shell 字符串，零命令注入风险）**。
- **挂载与临时目录清理硬保障**：
  - 通过 `hdiutil attach -readonly -nobrowse -plist <dmgPath>` 解析真实挂载点（`plutil -convert json -o -` 解析 XML plist，绝不硬编码 `/Volumes/Forma ...`）；
  - 外层 `try { ... } finally { ... }` 保证无论哪一步失败均调用 `hdiutil detach <mountPoint> -force` 并删除临时解包与用户数据目录。
- **验证清单**：
  1. `release/Forma-<version>-arm64.dmg` 与 `.zip` 存在性、`bytes`、`sha256`；
  2. 前一版本 DMG（显式 `--previous-dmg` 或自动取 `release/` 中最新旧版 DMG）SHA-256 比对（`previousDmgIntact`）；
  3. `codesign --verify --deep --strict <mount>/Forma.app`；
  4. `Info.plist` `CFBundleShortVersionString === version`；
  5. `asar.extractAll` 提取 `app.asar`，对工作区 `dist/` 全量文件及 `out-electron/agent-service.mjs`、`out-electron/library-service.mjs` 逐文件 SHA-256 一致性校验；
  6. 以 Playwright `_electron.launch` 离屏启动只读挂载卷内的 `Forma.app`（`--forma-offscreen-qa` + 独立临时 `--user-data-dir`，不污染本机配置，不设外部 `AGENT_PORT` 确保默认走应用内置回环 Agent 服务）：
     - 校验 `window.formaDesktop.version === version` 与 `location.protocol === "forma:"`；
     - 校验 `forma://app/api/agent/providers`（`200`, `providerCount >= 13`）、`/api/agent/status`（`200`, `configured === false`）、`/api/agent/skills`（`200`, `builtinSkillsCount >= 2`）、`POST /api/agent/critique`（空体 `400` + `error` 字段）、`POST /api/agent/library-playbook`（空体 `400` + `error` 字段）；
     - 在同一挂载桌面应用内执行 `scripts/check-release-notes.browser.js` 并校验首条公开版本与文件菜单版本；
  7. 指向只读挂载卷内 `Forma.app` 执行 `scripts/check-design-import-desktop.mjs docs/evidence/2026-11-22/design-import/shared-paint.fig`；
  8. 落盘 `docs/evidence/<YYYY-MM-DD>/desktop-<version>.json`（完整记录上述全部实测数据）。

### 4. `scripts/release/pipeline.ts`

- 命令接口：
  - `npm run release:assess -- [--significance <kind>] [--initiative] [--security-fix] [--public-patch] [--bump <level>] [--package-desktop true|false] [--files a,b] [--since <iso>] [--json]`
  - `npm run release:check -- [--json]`
  - `npm run release:verify-dmg -- [--version <ver>] [--dmg <path>] [--trust-external-dmg] [--previous-dmg <path>] [--previous-sha256 <hex>] [--evidence-out <path>] [--allow-overwrite-evidence]`
  - `npm run release:run -- --plan <plan.json> | (--significance <kind> --summary <text> [--title <text>] [--highlight <text> ...] [--changelog <text> ...] [--migration-notes <text>] [--initiative] [--security-fix] [--public-patch] [--bump <level>] [--package-desktop true|false] [--confirm-major] [--allow-repackage] [--dry-run] [--resume] [--rollback] [--json])`
- **安全与事务保障**：
  - 审批标志（`--confirm-major`、`--allow-repackage`、`--trust-external-dmg`、`--allow-overwrite-evidence`）仅接受当前命令行显式传入，禁止在 `--plan` JSON 中自我审批；`--plan` 支持工作区相对路径或绝对路径，必须为无符号链接逃逸的常规 JSON 文件且体积 ≤ 1 MiB；机读纯 JSON 输出请使用 `npm run --silent release:run -- ... --json`（或直调 `node --import tsx scripts/release/pipeline.ts run ... --json`）。
  - 正式执行 `run` 禁止绕过全量单测、禁止降级绕过规则判定的最低级别、禁止跳过 `minor`/`major` 的桌面同步打包（降级或跳过打包仅允许用于 `assess` 与 `--dry-run` 预演）；主版本或首版稳定晋升（如 `1.0.0-rc.1 → 1.0.0`）须同时提供 `--confirm-major` 与迁移说明（`--migration-notes` / `migrationNotes`）并跑通浏览器与导出工程跨流程门禁。
  - 事务同步更新 `package.json`、`package-lock.json`（若存在，双处根 `version` 字段）、`docs/CHANGELOG.md`、`src/editor/release-notes.ts`，采用工作区作用域锁与持久化事务日志（`output/release-state/`，已纳入 `.gitignore`）；所有文件替换均在保留原对象与校验摘要后完成，回滚先写入 `rolling-back` 阶段并保留不可变备份直至提交，防止覆盖并发手工修改，支持中断后 `--resume` 同版本恢复或 `--rollback` 显式回滚。
  - 桌面打包在独立临时暂存目录执行 `electron-builder --publish never -c.mac.notarize=false -c.mac.identity=null -c.directories.output=<staging>`（剥离外部签名/发布凭据环境变量，沿用标准 Electron 打包与 `electron/after-sign.mjs` `/usr/bin/codesign` 深度签名，保留 `LICENSE`/`LICENSES.chromium.html` 并清除 `default_app.asar`），将待检 DMG 复制至私有受保护只读副本认证后再挂载验证（含完整 ZIP 列表/体积/树比对、blockmap 校验、`CFBundleDocumentTypes` 角色/级别精确校验及 `package.json` 确定性投影校验），再以不覆写语义原子晋升到 `release/` 并同步写入 `docs/evidence/release-manifest.json`。

---

## 三、测试与验收矩阵

| 测试层 | 文件/命令 | 覆盖要点 |
| --- | --- | --- |
| 单元测试 | `tests/release-pipeline.test.ts` | SemVer 递增与非法值拦截、四档判定矩阵（`none`/`patch`/`minor`/`major`）、`packageDesktop` 各触发条件与覆盖警告、`Asia/Shanghai` 日期、Changelog/ReleaseNotes 原子更新与重复/倒退/缺失标题拦截、无 Git 工作区按基线时间扫描、元数据同步校验 |
| 既有版本单测 | `tests/release-notes.test.ts` | 校验升级 `0.10.0` 后 `package.json`、`CHANGELOG.md`、`release-notes.ts` 三方完全一致 |
| 端到端实测 | `npm run release:run -- --plan ...` | 实跑 `0.9.0 → 0.10.0` 完整流水线（含 `Forma-0.10.0-arm64.dmg` 打包与只读挂载全项实机验收） |
