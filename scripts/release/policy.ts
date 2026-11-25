import { posix } from "node:path";

export const releaseBumps = ["none", "patch", "minor", "major"] as const;
export type ReleaseBump = (typeof releaseBumps)[number];
export const significances = [
  "docs-or-tests",
  "internal-refactor",
  "bugfix",
  "ux-polish",
  "workflow-enhancement",
  "major-feature",
  "breaking-generation",
] as const;
export type ChangeSignificance = (typeof significances)[number];
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

export const CORE_SUBSYSTEMS: readonly ReleaseSubsystem[] = [
  "domain",
  "editor",
  "design-system",
  "agent",
  "server",
  "compiler",
  "runtime",
  "infrastructure",
  "electron",
  "public",
];

export interface ReleaseAssessmentInput {
  currentVersion: string;
  changedFiles: readonly string[];
  significance?: ChangeSignificance;
  completedInitiative?: boolean;
  breakingOrV1?: boolean;
  securityOrDataFix?: boolean;
  publicPatch?: boolean;
  titledPatch?: boolean;
  packagePackagingChanged?: boolean;
  shippedInitiatives?: string[];
  overrideBump?: ReleaseBump;
  overridePackageDesktop?: boolean;
}
export interface ReleaseDecision {
  currentVersion: string;
  nextVersion: string;
  bump: ReleaseBump;
  recommendedBump: ReleaseBump;
  shippedInitiatives: string[];
  packageDesktop: boolean;
  publishInReleaseNotes: boolean;
  subsystems: ReleaseSubsystem[];
  coreSubsystems: ReleaseSubsystem[];
  runtimeFileCount: number;
  score: number;
  reasons: string[];
  warnings: string[];
}

export interface ParsedSemVer {
  major: number | bigint;
  minor: number | bigint;
  patch: number | bigint;
  prerelease: string[];
  build: string[];
}

function integer(digits: string) {
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : BigInt(digits);
}

export function parseSemVer(version: string): ParsedSemVer {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*))?(?:\+([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*))?$/.exec(
      version,
    );
  const prerelease = match?.[4]?.split(".") ?? [];
  if (
    !match ||
    match[0] !== version ||
    prerelease.some((id) => /^0\d+$/.test(id))
  ) {
    throw Error("无效的 SemVer 版本号 " + JSON.stringify(version));
  }
  return {
    major: integer(match[1]),
    minor: integer(match[2]),
    patch: integer(match[3]),
    prerelease,
    build: match[5]?.split(".") ?? [],
  };
}

export function compareSemVer(a: string, b: string): number {
  const x = parseSemVer(a),
    y = parseSemVer(b);
  for (const part of ["major", "minor", "patch"] as const) {
    if (x[part] !== y[part]) return x[part] < y[part] ? -1 : 1;
  }
  const left = x.prerelease,
    right = y.prerelease;
  if (!left.length || !right.length)
    return Number(!left.length) - Number(!right.length);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const l = left[i],
      r = right[i];
    if (l === r) continue;
    const ln = /^\d+$/.test(l),
      rn = /^\d+$/.test(r);
    if (ln && rn) return BigInt(l) < BigInt(r) ? -1 : 1;
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return Math.sign(left.length - right.length);
}

export function bumpSemVer(version: string, bump: ReleaseBump): string {
  const { major, minor, patch, prerelease } = parseSemVer(version);
  const candidate = prerelease.length > 0;
  switch (bump) {
    case "none":
      return version;
    case "patch":
      return [major, minor, candidate ? patch : BigInt(patch) + 1n].join(".");
    case "minor":
      return [
        major,
        candidate && patch === 0 ? minor : BigInt(minor) + 1n,
        0,
      ].join(".");
    case "major":
      return [
        candidate && minor === 0 && patch === 0 ? major : BigInt(major) + 1n,
        0,
        0,
      ].join(".");
  }
}

export function normalizeChangedFiles(paths: readonly string[]): string[] {
  return [
    ...new Set(
      paths
        .filter(Boolean)
        .map((p) => posix.normalize(p.replaceAll("\\", "/"))),
    ),
  ].sort();
}

export function classifyPathSubsystem(filePath: string): ReleaseSubsystem {
  const file = posix.normalize(filePath.replaceAll("\\", "/"));
  const [root, subdir] = file.split("/");
  if (root === "src") {
    switch (subdir) {
      case "agent":
      case "compiler":
      case "design-system":
      case "domain":
      case "infrastructure":
      case "runtime":
        return subdir;
      default:
        return "editor";
    }
  }
  switch (root) {
    case "build":
      return "electron";
    case "electron":
    case "server":
    case "public":
    case "tests":
    case "scripts":
    case "docs":
      return root;
  }
  if (file === "README.md" || file === "AGENTS.md") return "docs";
  if (file === "vite.config.ts" || file === "index.html") return "editor";
  // package.json alone cannot tell us whether product runtime behavior changed.
  return "other";
}

export function assessReleaseImpact(
  input: ReleaseAssessmentInput,
): ReleaseDecision {
  const types = normalizeChangedFiles(input.changedFiles).map((file) =>
    (file === "package.json" || file === "package-lock.json") &&
    input.packagePackagingChanged
      ? "electron"
      : classifyPathSubsystem(file),
  );
  const subsystems = [...new Set(types)].sort();
  const coreSubsystems = CORE_SUBSYSTEMS.filter((s) => subsystems.includes(s));
  const runtimeFileCount = types.filter((s) =>
    CORE_SUBSYSTEMS.includes(s),
  ).length;
  const count = coreSubsystems.length;
  const score = runtimeFileCount + 2 * count;
  const reasons = [
    "影响分 " +
      score +
      "（" +
      runtimeFileCount +
      " 个运行时文件 + 2 × " +
      count +
      " 个核心子系统）",
  ];
  const warnings: string[] = [];
  const { currentVersion } = input;
  let significance = input.significance;
  if (significance === "docs-or-tests" && runtimeFileCount > 0) {
    warnings.push("docs-or-tests 与实际运行时文件冲突，已按运行时改动判定。");
    significance = undefined;
  }
  if (significance === "internal-refactor")
    reasons.push("显式声明 internal-refactor：内部重构无用户可感知变化。");
  let recommended: ReleaseBump = "none";
  if (input.breakingOrV1 || significance === "breaking-generation") {
    recommended = "major";
    reasons.push("首个正式版或不兼容的代际变更。");
  } else if (
    significance === "major-feature" ||
    input.completedInitiative ||
    (significance === "workflow-enhancement" && count >= 2) ||
    (!significance && count >= 3 && runtimeFileCount >= 10)
  ) {
    recommended = "minor";
    if (input.completedInitiative)
      reasons.push("已完成立项课题的可交付里程碑。");
    else if (significance === "major-feature")
      reasons.push("新增面向设计师的核心能力。");
    else if (significance) reasons.push("工作流增强涉及至少两个核心子系统。");
    else
      reasons.push(
        "未指定级别，变更达到三个核心子系统、十个运行时文件的门槛。",
      );
  } else if (
    significance === "bugfix" ||
    significance === "ux-polish" ||
    significance === "workflow-enhancement" ||
    input.securityOrDataFix ||
    input.publicPatch ||
    (significance !== "internal-refactor" &&
      significance !== "docs-or-tests" &&
      runtimeFileCount > 0)
  ) {
    recommended = "patch";
    reasons.push("产品修复、体验改进或局部运行时变更，符合修订版条件。");
  } else {
    reasons.push("仅涉及文档、测试、脚本或内部整理，保持当前版本。");
  }
  const governedTier = (tier: ReleaseBump) => {
    const target = bumpSemVer(currentVersion, tier);
    if (
      tier !== "none" &&
      (target === "1.0.0" ||
        parseSemVer(target).major > parseSemVer(currentVersion).major)
    )
      return "major";
    return tier;
  };
  recommended = governedTier(recommended);
  const bump = governedTier(input.overrideBump ?? recommended);
  if (bump !== recommended) {
    const downgraded =
      releaseBumps.indexOf(bump) < releaseBumps.indexOf(recommended);
    (downgraded ? warnings : reasons).push(
      "手动" +
        (downgraded ? "降级" : "升级") +
        "：" +
        recommended +
        " → " +
        bump,
    );
  }
  if (bump === "major" || recommended === "major")
    warnings.push("执行主版本升级需要 --confirm-major 显式确认。");
  const patchPublic = Boolean(
    input.publicPatch ||
    (input.publicPatch === undefined &&
      input.titledPatch &&
      bump === "patch") ||
    significance === "workflow-enhancement",
  );
  const publishInReleaseNotes =
    bump === "major" || bump === "minor" || (bump === "patch" && patchPublic);
  const packageReasons = [];
  if (coreSubsystems.includes("electron") || coreSubsystems.includes("server"))
    packageReasons.push("桌面或服务端改动");
  if (input.securityOrDataFix) packageReasons.push("安全或数据修复");
  if (patchPublic) packageReasons.push("公开重要补丁");
  if (count >= 2) packageReasons.push("跨核心子系统");
  if (runtimeFileCount >= 5) packageReasons.push("运行时文件至少五个");
  const needsDesktop = (level: ReleaseBump) =>
    level === "major" ||
    level === "minor" ||
    (level === "patch" && packageReasons.length > 0);
  const packageDesktop =
    bump !== "none" && (input.overridePackageDesktop ?? needsDesktop(bump));
  if (needsDesktop(bump))
    reasons.push(
      bump === "patch"
        ? "需要打包：" + packageReasons.join("、")
        : "主版本与次版本均须同步打包。",
    );
  if (!packageDesktop && (needsDesktop(recommended) || needsDesktop(bump)))
    warnings.push("人工覆盖跳过了规则要求的桌面打包。");
  if (input.overridePackageDesktop && bump === "none")
    warnings.push("已指定打包，但本次不发版，run 将直接结束。");
  return {
    currentVersion,
    nextVersion: bumpSemVer(currentVersion, input.overrideBump ?? recommended),
    recommendedBump: recommended,
    shippedInitiatives: input.shippedInitiatives ?? [],
    bump,
    packageDesktop,
    publishInReleaseNotes,
    subsystems,
    coreSubsystems,
    runtimeFileCount,
    score,
    reasons,
    warnings,
  };
}
