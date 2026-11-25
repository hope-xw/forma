# TASKS · 版本分级判定规则与自动化发版打包流水线

- **课题编号**：`2026-11-25-release-governance-pipeline`
- **状态**：已实施并验收
- **最后更新**：2026-11-25

---

## Phase 0 · 规则与规格沉淀（主控）

- [x] 创建课题目录 `docs/initiatives/2026-11-25-release-governance-pipeline/`（`PRD.md`、`ENGINEERING.md`、`TASKS.md`）并登记至 `docs/initiatives/README.md`
- [x] 更新 `AGENTS.md`：新增「版本升级与同步打包规则」硬约束（交付前必跑影响评估、按体量与重要程度自动判定升版与同步打包）
- [x] 更新 `docs/specs/VERSIONING-AND-DESKTOP.md` 与 `docs/specs/README.md`：补全四档判定矩阵、同步桌面打包触发条件及自动化发版流水线规格

## Phase 1 · 自动化流水线代码实施（Codex CLI）

- [x] 实现 `scripts/release/policy.ts`（SemVer 工具 + 四档判定引擎 + `packageDesktop` 触发逻辑）
- [x] 实现 `scripts/release/workspace-diff.ts`（兼容 Git 与无 Git 工作区的基线文件/课题变更探测）
- [x] 实现 `scripts/release/release-files.ts`（`package.json` / `CHANGELOG.md` / `release-notes.ts` 原子更新、回滚与一致性校验）
- [x] 实现 `scripts/release/verify-dmg.ts`（只读挂载 DMG、签名、Plist、`app.asar` 逐字节校验、离屏 Electron 路由/版本日志/`.fig` 打开、历史包完好性与证据落盘）
- [x] 实现 `scripts/release/pipeline.ts` 与 `package.json` 脚本入口（`release:assess`、`release:check`、`release:verify-dmg`、`release:run`）
- [x] 新增 `tests/release-pipeline.test.ts` 全量单元测试

## Phase 2 · 独立 Code Review 与修复闭环（Codex CLI）

- [x] 独立只读 Codex CLI Code Review（安全边界、无 shell 注入、挂载清理、原子回滚、规格一致性）
- [x] 修复全部 P0/P1/P2 问题并完成 6 轮独立复审（0 P0，全部核心安全与事务边界闭环）

## Phase 3 · 实测验证与 `v0.10.0` 自动化发版打包

- [x] 通过 `npm run format:check`、`npm test`（595/595）、`npm run build`、`npm run release:assess`、`npm run release:check`
- [x] 使用新建 `npm run --silent release:run` 执行 `0.9.0 → 0.10.0` 完整发版与 macOS `arm64` 桌面打包（纳入 2026-11-25 四大组件库体系与 Forma AI Stage 1 两大里程碑及发版流水线），并在实机验签中拦截修复 Electron 45 `forma://app/` 同源校验缺陷
- [x] 验证 `release/Forma-0.10.0-arm64.dmg` / `.zip` 只读挂载实机验收通过、`docs/evidence/2026-11-25/desktop-0.10.0.json` 与 `docs/evidence/release-manifest.json` 落盘且 `Forma-0.9.0-arm64.dmg` 完好未改动
- [x] 同步更新 `docs/specs/VERSIONING-AND-DESKTOP.md`（当前基线 `0.10.0`）、`docs/HANDOFF.md`、`docs/EDITOR-ACCEPTANCE.md` 并结项

---

## 决策日志（ADR）

| 日期 | 决策 | 依据 |
| --- | --- | --- |
| 2026-11-25 | 无 `.git` 仓库时以当前版本已打包 DMG / 证据时间戳为基线自动探测变更文件与子系统 | Forma 工作区无 `.git` 目录，确保 `release:assess` 在本机直接零配置工作，同时保留 Git 仓库兼容 |
| 2026-11-25 | 2026-11-25 两大里程碑（组件库管理中心与四大体系 + Forma AI 活体组件库混合编排 Stage 1）合并发布为 `0.10.0` 并同步打包 macOS DMG | 按 SemVer 2.0 `0.9.0` 下一稳定次版本为 `0.10.0`；两项均属跨模块核心能力里程碑，符合 `minor + packageDesktop: true` 规则 |
