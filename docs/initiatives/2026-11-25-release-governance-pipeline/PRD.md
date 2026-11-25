# PRD · 版本分级判定规则与自动化发版打包流水线

- **课题编号**：`2026-11-25-release-governance-pipeline`
- **状态**：已实施并验收（已随 `v0.10.0` 完成首次全自动发版与只读挂载 DMG 实机验收）
- **立项日期**：2026-11-25
- **关联文档**：[工程设计文档 ENGINEERING.md](ENGINEERING.md) · [任务清单 TASKS.md](TASKS.md) · [版本规范与桌面客户端规格](../../specs/VERSIONING-AND-DESKTOP.md) · [项目开发约定](../../../AGENTS.md)

---

## 一、背景与真实痛点

1. **缺少「变更大小/重要程度 → 是否升版与同步打包」硬规则**：既有规范仅定义了 SemVer 格式与日志写法，但未规定什么体量/重要程度的更新必须升版、何时必须同步构建桌面安装包。导致 2026-11-25 连续完成两大里程碑（四大组件库体系与资源面板重构 + Forma AI 活体组件库与混合编排 Stage 1）后，版本号仍停留在 `0.9.0` 且 `release/Forma-0.9.0-arm64.dmg` 仍为 2026-11-24 旧产物。
2. **发版与 DMG 验收依赖纯手工串联**：每次发版需要人工同步修改 `package.json`、`docs/CHANGELOG.md`、`src/editor/release-notes.ts`，执行格式、单测、生产构建、`desktop:service`、`desktop:agent`、`electron-builder`，再手工挂载只读 DMG 核对 `codesign`、`Info.plist`、`app.asar` 逐字节指纹、离屏 Electron 路由与版本日志 UI、`.fig` 原生打开以及历史 DMG 完好性，容易漏项或耗时高。
3. **本工作区无 `.git` 元数据**：流水线不能强依赖 `git diff`，必须兼容无 Git 仓库的本机工作区（以最新已打包 DMG/证据时间戳为基线自动识别受影响文件与子系统）。

---

## 二、产品与工程目标

| 维度 | 本期交付目标 | 可核验结果 |
| --- | --- | --- |
| **1. 版本判定与同步打包规则落盘** | 在 `AGENTS.md` 与 `docs/specs/VERSIONING-AND-DESKTOP.md` 确立四档判定矩阵（`none` / `patch` / `minor` / `major`）与 `packageDesktop` 同步打包门禁 | 交付前必须执行发版影响评估；`minor` / `major` 及涉及桌面/服务端/数据安全/公开补丁的 `patch` 必须同步打包桌面端并归档实机证据 |
| **2. 确定性发版决策引擎** | 编写纯函数策略模块 `scripts/release/policy.ts`，综合影响级别、是否完成立项课题、变更子系统数、桌面/服务端触达与安全/数据修复自动输出 `bump`、`nextVersion`、`packageDesktop`、`publishInReleaseNotes` 与中文判定依据 | 通过全覆盖单元测试，支持 `--json` 机器读取与人工审阅 |
| **3. 自动化发版与只读 DMG 验证流水线** | 提供 `npm run release:assess`、`release:check`、`release:verify-dmg`、`release:run` 四条命令，一键完成评估、元数据原子同步（失败自动回滚）、预检门禁、Electron 打包、只读挂载 DMG 实机验收与 `docs/evidence/<date>/desktop-<version>.json` 归档 | 单命令全自动跑通，异常退出确保卸载挂载卷并回滚未验证的元数据修改 |
| **4. 立即以新流水线完成 `v0.10.0` 实测发版** | 将 2026-11-25 两大已完成里程碑（四大设计体系组件库管理中心 + Forma AI 活体组件库混合编排 Stage 1）连同本次流水线通过 `release:run` 正式升级至 **`0.10.0`** 并产出经过只读挂载验收的 `Forma-0.10.0-arm64.dmg` / `.zip` | `release/Forma-0.10.0-arm64.dmg` 存在并通过全套签名、逐字节、离屏运行、版本日志与 `.fig` 打开验收，同时证明 `Forma-0.9.0-arm64.dmg` 完好未改动 |

---

## 三、明确不做 / 当前边界（Non-Goals）

1. **不做云端自动发布或 Apple 公证上传**：继续采用本机 ad-hoc 深度签名（`electron/after-sign.mjs`），不涉及 Developer ID 凭据、Notarization、GitHub Releases 上传或 `electron-updater` 自动更新服务。
2. **不自动触发 `major`（`1.0.0`）升级**：策略引擎可识别 `major` 信号，但强制要求显式传入 `--confirm-major`（经用户确认）才会放行执行。
3. **仅在当前主机平台（macOS `arm64`）实机打包与只读挂载校验**：Windows NSIS 与 Linux AppImage 目标仍保持配置预留，非 macOS 环境执行 DMG 验证将清晰提示平台限制。

---

## 四、验收标准（Definition of Done）

1. `AGENTS.md`、`docs/specs/VERSIONING-AND-DESKTOP.md`、`docs/specs/README.md` 已同步落盘四档判定矩阵、同步打包条件与自动化命令约定。
2. `scripts/release/` 模块通过独立只读 Codex CLI Code Review（0 P0 / 0 P1 / 0 P2）与新增 `tests/release-pipeline.test.ts` 全量单测。
3. 使用 `npm run release:run` 端到端完成 `0.9.0 → 0.10.0` 自动化发版、打包与只读挂载 DMG 实机验收，产出 `release/Forma-0.10.0-arm64.dmg`、`release/Forma-0.10.0-arm64.zip` 与 `docs/evidence/2026-11-25/desktop-0.10.0.json`。
4. 全仓 `npm run format:check`、`npm test`、`npm run build`、`npm run release:check` 全部通过，`release/Forma-0.9.0-arm64.dmg` SHA-256 保持完好。
