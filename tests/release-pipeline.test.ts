import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  openSync,
  writeSync,
  ftruncateSync,
  closeSync,
  cpSync,
  linkSync,
  lstatSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { blake2b } from "@noble/hashes/blake2.js";
import { zipSync, unzipSync } from "fflate";
import {
  verifyPackagedDmg,
  checkRuntimeManifest,
  verifyBlockmap,
  validateAsarHeader,
  outputHashes,
  validateZipInventory,
  reconcileActiveMount,
  type VerifyDmgOptions,
  type DesktopVerificationEvidence,
} from "../scripts/release/verify-dmg";
import { main } from "../scripts/release/pipeline";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assessReleaseImpact,
  bumpSemVer,
  classifyPathSubsystem,
  compareSemVer,
  parseSemVer,
  type ReleaseAssessmentInput,
  type ReleaseBump,
} from "../scripts/release/policy";
import {
  detectWorkspaceChanges,
  findBaselineDmg,
  listReleaseDmgs,
  sourceHashes,
  writeReleaseManifest,
  readReleaseManifest,
  packagePackagingHash,
  replaceCheckedFile,
} from "../scripts/release/workspace-diff";
import {
  applyChangelogUpdate,
  applyPackageVersionUpdate,
  applyReleaseNotesUpdate,
  getShanghaiDate,
  verifyReleaseMetadataSync,
  type ReleaseNotesEntry,
} from "../scripts/release/release-files";

const currentVersion = "0.9.0";
const entry = {
  version: "0.10.0",
  date: "2026-11-25",
  title: '公开 "版本"',
  summary: "可见改进",
  highlights: ["引号、反斜杠 \\ 与\n换行", "使用 $& 和 ];"],
};
const md = "# Forma\n\n历史版本\n\n## 0.9.0 · 2026-11-24\n\n- 已上线\n";
const notes =
  'export const releaseUpdates = [\n  {version: "0.9.0", date: "2026-11-24", title: "发布", summary: "可用"} // 保留行尾注释\n];\nexport const anotherArray = [];\n';
const manifest =
  '{\n\t"nested": {"version": "1.2.3"},\n\t"version" : "0.9.0"\n}\n';
const metadata = [
  "package.json",
  "docs/CHANGELOG.md",
  "src/editor/release-notes.ts",
];
const pipeline = fileURLToPath(
  new URL("../scripts/release/pipeline.ts", import.meta.url),
);

function temporary(t: TestContext) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "forma-release-test-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(root: string, relative: string, data: string, time?: number) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  if (time !== undefined) utimesSync(file, time, time);
  return file;
}
function fixture(t: TestContext) {
  const root = temporary(t);
  for (const [i, raw] of [manifest, md, notes].entries())
    put(root, metadata[i], raw, 1);
  return root;
}
function snapshot(root: string) {
  return metadata.map((file) => readFileSync(path.join(root, file), "utf8"));
}
function cli(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), pipeline, ...args],
    {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (result.error) throw result.error;
  return result;
}

test("SemVer parses release, prerelease, and optional build identifiers", () => {
  assert.deepEqual(parseSemVer("1.20.3-rc.0+mac.01"), {
    major: 1,
    minor: 20,
    patch: 3,
    prerelease: ["rc", "0"],
    build: ["mac", "01"],
  });
  for (const invalid of [
    "",
    "1",
    "1.2",
    "1.2.3.4",
    "v1.0.0",
    "-1.2.3",
    "1.-2.3",
    "1.2.-3",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-rc.01",
    "1.2.3-",
    "1.2.3+",
    "1.2.3-a..b",
    "1.2.3+x..y",
    " 1.2.3",
    "1.2.3\n",
    "1.2.3-a_b",
  ])
    assert.throws(
      () => parseSemVer(invalid),
      /SemVer/,
      JSON.stringify(invalid),
    );
});
test("SemVer compares numeric components, ASCII prerelease identifiers, and ignores build metadata", () => {
  const ordered = [
    "0.9.0",
    "0.10.0-alpha",
    "0.10.0-alpha.1",
    "0.10.0-alpha.beta",
    "0.10.0-beta",
    "0.10.0-beta.2",
    "0.10.0-beta.11",
    "0.10.0-rc.1",
    "0.10.0",
  ];
  for (const [i, a] of ordered.entries())
    for (const [j, b] of ordered.entries())
      assert.equal(Math.sign(compareSemVer(a, b)), Math.sign(i - j));
  assert.equal(compareSemVer("1.0.0+5", "1.0.0+6"), 0);
  assert.ok(
    compareSemVer("1.0.0-9007199254740993", "1.0.0-9007199254740992") > 0,
  );
  assert.ok(compareSemVer("9007199254740993.0.0", "9007199254740992.0.0") > 0);
  assert.throws(() => compareSemVer("1.0", "1.0.1"));
});
test("SemVer bumps each tier from a prerelease", () => {
  const original = "1.2.4-rc.2+mac";
  for (const [bump, expected] of Object.entries({
    none: original,
    patch: "1.2.4",
    minor: "1.3.0",
    major: "2.0.0",
  }))
    assert.equal(bumpSemVer(original, bump as ReleaseBump), expected);
  assert.equal(bumpSemVer("0.9.0", "minor"), "0.10.0");
  assert.equal(bumpSemVer("0.9.0", "patch"), "0.9.1");
  assert.equal(bumpSemVer("0.9.0", "major"), "1.0.0");
  assert.equal(bumpSemVer("0.10.0-rc.1", "minor"), "0.10.0");
  assert.equal(bumpSemVer("0.10.0-rc.1", "patch"), "0.10.0");
  assert.equal(bumpSemVer("1.0.0-rc.1", "major"), "1.0.0");
});
test("paths cover all core subsystems, config, docs, and Windows separators", () => {
  for (const subsystem of [
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
  ]) {
    const root = ["electron", "server", "public"].includes(subsystem)
      ? subsystem
      : "src/" + subsystem;
    assert.deepEqual(
      assessReleaseImpact({ currentVersion, changedFiles: [root + "/file.ts"] })
        .coreSubsystems,
      [subsystem],
    );
    assert.equal(
      classifyPathSubsystem((".\\" + root + "/file.ts").replaceAll("/", "\\")),
      subsystem,
    );
  }
  for (const [file, expected] of Object.entries({
    "build/icon.icns": "electron",
    "./docs/page": "docs",
    "README.md": "docs",
    "AGENTS.md": "docs",
    "tests/x": "tests",
    "scripts/x": "scripts",
    "src/application/x": "editor",
    "src/main.ts": "editor",
    "vite.config.ts": "editor",
    "index.html": "editor",
    "package.json": "other",
    "assets/x": "other",
  }))
    assert.equal(classifyPathSubsystem(file), expected);
});

function decision(input: Partial<ReleaseAssessmentInput>) {
  return assessReleaseImpact({ currentVersion, changedFiles: [], ...input });
}
const files = (count: number) =>
  Array.from({ length: count }, (_, i) => "src/editor/file-" + i + ".css");
const large = [...files(8), "server/a.ts", "public/a.svg"];
const cases: [
  string,
  Partial<ReleaseAssessmentInput>,
  ReleaseBump,
  boolean,
  boolean,
][] = [
  [
    "docs/tests/scripts only",
    { changedFiles: ["README.md", "tests/a", "scripts/b"] },
    "none",
    false,
    false,
  ],
  [
    "contradictory docs-only",
    { significance: "docs-or-tests", changedFiles: large },
    "minor",
    true,
    true,
  ],
  [
    "internal refactor",
    { significance: "internal-refactor", changedFiles: large },
    "none",
    false,
    false,
  ],
  [
    "local Web CSS",
    { significance: "bugfix", changedFiles: files(1) },
    "patch",
    false,
    false,
  ],
  ["UX polish", { significance: "ux-polish" }, "patch", false, false],
  ["Electron", { changedFiles: ["electron/main.mjs"] }, "patch", true, false],
  [
    "server",
    { significance: "bugfix", changedFiles: ["server/a"] },
    "patch",
    true,
    false,
  ],
  ["security/data fix", { securityOrDataFix: true }, "patch", true, false],
  ["public patch", { publicPatch: true }, "patch", true, true],
  [
    "two core subsystems",
    { changedFiles: ["src/domain/a", "src/compiler/b"] },
    "patch",
    true,
    false,
  ],
  ["four runtime files", { changedFiles: files(4) }, "patch", false, false],
  ["five runtime files", { changedFiles: files(5) }, "patch", true, false],
  [
    "local workflow",
    { significance: "workflow-enhancement", changedFiles: files(1) },
    "patch",
    true,
    true,
  ],
  [
    "cross-subsystem workflow",
    {
      significance: "workflow-enhancement",
      changedFiles: ["src/editor/a", "src/domain/a"],
    },
    "minor",
    true,
    true,
  ],
  ["core feature", { significance: "major-feature" }, "minor", true, true],
  ["completed initiative", { completedInitiative: true }, "minor", true, true],
  [
    "implicit three subsystems and ten files",
    { changedFiles: large },
    "minor",
    true,
    true,
  ],
  [
    "three subsystems and nine files",
    { changedFiles: large.slice(1) },
    "patch",
    true,
    false,
  ],
  [
    "explicit bugfix wins over size",
    { changedFiles: large, significance: "bugfix" },
    "patch",
    true,
    false,
  ],
  [
    "first production version",
    { breakingOrV1: true, completedInitiative: true },
    "major",
    true,
    true,
  ],
  [
    "breaking generation",
    { significance: "breaking-generation" },
    "major",
    true,
    true,
  ],
];
for (const [name, input, bump, desktop, publish] of cases)
  test("policy · " + name, () => {
    const actual = decision(input);
    assert.deepEqual(
      [
        actual.bump,
        actual.packageDesktop,
        actual.publishInReleaseNotes,
        actual.nextVersion,
      ],
      [
        bump,
        desktop,
        publish,
        { none: "0.9.0", patch: "0.9.1", minor: "0.10.0", major: "1.0.0" }[
          bump
        ],
      ],
    );
    assert.ok(actual.reasons.length && Number.isFinite(actual.score));
    if (bump === "major")
      assert.match(actual.warnings.join("\n"), /--confirm-major/);
  });
test("policy normalizes and deduplicates before computing thresholds", () => {
  const d = decision({
    changedFiles: [
      ".\\src\\editor\\a",
      "src/editor/a",
      "src/agent/../editor/a",
      "docs/intro",
    ],
  });
  assert.deepEqual(d.coreSubsystems, ["editor"]);
  assert.deepEqual(d.subsystems, ["docs", "editor"]);
  assert.equal(d.runtimeFileCount, 1);
  assert.equal(d.packageDesktop, false);
});
test("manual overrides preserve public milestones, warn on downgrade and skipped packaging", () => {
  const d = decision({ significance: "major-feature", overrideBump: "none" });
  assert.deepEqual(
    [d.nextVersion, d.packageDesktop, d.publishInReleaseNotes],
    [currentVersion, false, false],
  );
  assert.match(d.warnings.join(" "), /降级/);
  assert.match(d.warnings.join(" "), /打包/);
  for (const level of ["minor", "major"] as const) {
    const raised = decision({ significance: "bugfix", overrideBump: level });
    assert.deepEqual(
      [raised.publishInReleaseNotes, raised.packageDesktop, raised.nextVersion],
      [true, true, level === "minor" ? "0.10.0" : "1.0.0"],
    );
    assert.match(
      decision({
        overrideBump: level,
        overridePackageDesktop: false,
      }).warnings.join(" "),
      /跳过/,
    );
  }
  const skip = decision({
    securityOrDataFix: true,
    overridePackageDesktop: false,
  });
  assert.equal(skip.packageDesktop, false);
  assert.match(skip.warnings.join(" "), /跳过/);
  const force = decision({
    overrideBump: "none",
    overridePackageDesktop: true,
  });
  assert.ok(!force.packageDesktop && force.warnings.length);
  assert.match(
    decision({
      significance: "docs-or-tests",
      changedFiles: ["electron/main.mjs"],
    }).warnings.join(" "),
    /冲突/,
  );
});
test("Shanghai date crosses midnight independently of host timezone", () => {
  assert.equal(getShanghaiDate(new Date("2026-11-24T15:59:59Z")), "2026-11-24");
  assert.equal(getShanghaiDate(new Date("2026-11-24T17:30:00Z")), "2026-11-25");
});
test("manifest edit changes just the top-level value and requires an increase", () => {
  assert.equal(
    applyPackageVersionUpdate(manifest, entry.version),
    manifest.replace(currentVersion, entry.version),
  );
  for (const invalid of [currentVersion, "0.8.9", "0.09.1"])
    assert.throws(() => applyPackageVersionUpdate(manifest, invalid));
  assert.equal(
    applyPackageVersionUpdate(manifest, currentVersion, {
      allowSameVersion: true,
    }),
    manifest,
  );
  assert.throws(() =>
    applyPackageVersionUpdate(
      '{"version":"0.9.9","version":"0.9.0"}',
      "0.10.0",
    ),
  );
});
test("changelog inserts at first heading and rejects duplicate, empty, and invalid dates", () => {
  const change = { ...entry, bullets: [" - 第一项 ", "第二项\n换行"] };
  const next = applyChangelogUpdate(md, change);
  assert.ok(
    next.includes(
      "历史版本\n\n## 0.10.0 · 2026-11-25\n\n- 第一项\n- 第二项 换行\n\n## 0.9.0",
    ),
  );
  assert.throws(() => applyChangelogUpdate(next, change), /重复/);
  for (const date of ["2026-2-01", "2026-02-30", "2026-11-23"])
    assert.throws(() => applyChangelogUpdate(md, { ...change, date }));
  for (const bullets of [[], [" "], ["ok", "- "]])
    assert.throws(() => applyChangelogUpdate(md, { ...change, bullets }));
});
test("releaseUpdates appends escaped literals to the correct array, including a final comment", () => {
  const raw = applyReleaseNotesUpdate(notes, entry);
  assert.ok(raw.endsWith("];\nexport const anotherArray = [];\n"));
  assert.ok(raw.includes("}, // 保留行尾注释"));
  // Runtime import uses the literal output, independent of the static production reader.
  const literal = raw.slice(
    raw.indexOf("["),
    raw.lastIndexOf("];\nexport const anotherArray") + 1,
  );
  return import(
    "data:text/javascript," + encodeURIComponent("export default " + literal)
  ).then((module) => {
    assert.deepEqual(module.default.at(-1), entry);
  });
});
test("releaseUpdates enforces milestone titles, non-empty highlights, chronology and unique versions", () => {
  for (const invalid of [
    { version: currentVersion },
    { date: "2026-11-23" },
    { date: "2026-02-30" },
    { title: undefined },
    { title: "  " },
    { summary: " " },
    { highlights: ["ok", " "] },
  ])
    assert.throws(() =>
      applyReleaseNotesUpdate(notes, { ...entry, ...invalid }),
    );
  const patch: ReleaseNotesEntry = {
    ...entry,
    version: "0.9.1",
    title: undefined,
    highlights: undefined,
  };
  const raw = applyReleaseNotesUpdate(notes, patch);
  assert.ok(raw.includes('version: "0.9.1"') && !raw.includes("undefined"));
  assert.throws(() => applyReleaseNotesUpdate(raw, patch), /重复/);
});

test("non-Git scan uses exact DMG or latest eligible SemVer, PRD state, overrides and exclusions", (t) => {
  const root = fixture(t);
  const dmg = (v: string) => "release/Forma-" + v + "-arm64.dmg";
  for (const v of ["0.8.0", "0.9.0", "0.10.0", "01.0.0"])
    put(root, dmg(v), "dummy", 50);
  assert.deepEqual(
    listReleaseDmgs(root).map((d) => d.version),
    ["0.10.0", "0.9.0", "0.8.0"],
  );
  assert.equal(findBaselineDmg(root, "0.9.1")?.version, "0.9.0");
  assert.equal(findBaselineDmg(root, "0.1.0"), undefined);
  for (const file of [
    "src/editor/new.ts",
    "scripts/release/policy.ts",
    "docs/initiatives/done/PRD.md",
    "docs/initiatives/wip/PRD.md",
    "src/node_modules/ignored",
    "output/new",
    "dist/new",
    "src/.DS_Store",
  ])
    put(
      root,
      file,
      file.includes("done")
        ? "# 课题 A\n- **状态**：已实施并验收（阶段一）"
        : "# 课题 B\n- **状态**：实施中",
      52,
    );
  put(root, "docs/initiatives/old/PRD.md", "# 旧课题", 50);
  const diff = detectWorkspaceChanges(root);
  assert.equal(diff.source, "mtime");
  assert.equal(diff.baselineDmg?.version, currentVersion);
  assert.deepEqual(diff.changedFiles, [
    "docs/initiatives/done/PRD.md",
    "docs/initiatives/wip/PRD.md",
    "scripts/release/policy.ts",
    "src/editor/new.ts",
  ]);
  assert.deepEqual(
    diff.recentInitiatives.map((i) => [i.title, i.completed]),
    [
      ["课题 A", true],
      ["课题 B", false],
    ],
  );
  assert.deepEqual(
    detectWorkspaceChanges(root, { sinceIso: new Date(53_000).toISOString() })
      .changedFiles,
    [],
  );
  assert.throws(() => detectWorkspaceChanges(root, { sinceIso: "no date" }));
  const explicit = detectWorkspaceChanges(root, {
    explicitFiles: [".\\src\\x", "src/x"],
  });
  assert.equal(explicit.source, "explicit");
  assert.deepEqual(explicit.changedFiles, ["src/x"]);
  assert.deepEqual(
    detectWorkspaceChanges(root, { explicitFiles: [] }).changedFiles,
    [],
  );
});
test("Git status covers staged renames and nested untracked paths; corrupt Git falls back to mtime", (t) => {
  const root = fixture(t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "--quiet");
  put(root, "src/domain/old name.ts", "one");
  git("add", ".");
  git(
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  git("mv", "src/domain/old name.ts", "src/editor/new name.ts");
  put(root, "tests/嵌套/新文件.ts", "test");
  const diff = detectWorkspaceChanges(root);
  assert.equal(diff.source, "git");
  assert.deepEqual(diff.changedFiles, [
    "src/domain/old name.ts",
    "src/editor/new name.ts",
    "tests/嵌套/新文件.ts",
  ]);
  rmSync(path.join(root, ".git"), { recursive: true });
  put(root, ".git", "gitdir: /nonexistent-forma-fixture");
  const fallback = detectWorkspaceChanges(root);
  assert.equal(fallback.source, "mtime");
  assert.match(fallback.warnings.join(" "), /Git/);
});
test("metadata sync rereads history, flags missing/stale DMG, and detects version/date divergence", (t) => {
  const root = fixture(t);
  const check = () => verifyReleaseMetadataSync(root);
  assert.ok(check().ok && !check().desktopPackageExists);
  put(root, "release/Forma-0.9.0-arm64.dmg", "dummy", 10);
  assert.ok(
    check().ok && check().desktopPackageExists && !check().staleDesktopPackage,
  );
  put(root, "src/editor/style.css", "new", 11);
  put(root, "tests/check.ts", "new", 12);
  assert.equal(check().staleRuntimeFileCount, 1);
  assert.ok(check().staleDesktopPackage && check().ok);
  put(root, metadata[0], applyPackageVersionUpdate(manifest, entry.version));
  assert.equal(check().ok, false);
  put(
    root,
    metadata[1],
    applyChangelogUpdate(md, { ...entry, bullets: ["changed"] }),
  );
  const updated = applyReleaseNotesUpdate(notes, entry);
  put(root, metadata[2], updated);
  assert.ok(check().ok);
  assert.equal(check().latestPublicVersion, "0.10.0");
  for (const bad of [
    updated.replace("2026-11-25", "2026-11-26"),
    updated.replace("2026-11-25", "2026-11-23"),
    updated.replace("0.10.0", "0.9.0"),
    updated.replace('title: "发布"', 'title: ""'),
    updated.replace(', title: "发布"', ' title: "发布"'),
  ]) {
    put(root, metadata[2], bad);
    assert.equal(check().ok, false);
  }
});

test("CLI dry-run merges flags over a plan and preserves every metadata file and artifact", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  put(
    root,
    "plan.json",
    JSON.stringify({
      significance: "major-feature",
      title: "新功能",
      summary: "原摘要",
      highlights: ["原要点"],
      files: ["src/editor/panel.ts"],
      packageDesktop: false,
    }),
  );
  put(root, "release/Forma-0.9.0-arm64.dmg", "previous");
  const result = cli(root, [
    "run",
    "--plan",
    "plan.json",
    "--summary",
    "新摘要",
    "--highlight",
    "新要点",
    "--package-desktop",
    "true",
    "--dry-run",
    "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.decision.nextVersion, "0.10.0");
  assert.equal(plan.decision.packageDesktop, true);
  assert.deepEqual(plan.changelog, ["新摘要", "新要点"]);
  assert.deepEqual(plan.filesToUpdate, metadata);
  assert.match(plan.previousDmgSha256, /^[\da-f]{64}$/);
  assert.ok(plan.targetArtifacts.includes("release/Forma-0.10.0-arm64.zip"));
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(readdirSync(path.join(root, "release")), [
    "Forma-0.9.0-arm64.dmg",
  ]);
});
test("CLI guards no-release, major confirmation, required text, and target collision before mutation", (t) => {
  const root = fixture(t),
    before = snapshot(root);
  const none = cli(root, ["run", "--files", "docs/page", "--json"]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /--files.*dry-run/);
  put(root, "release/Forma-0.10.0-arm64.dmg", "existing");
  for (const [args, error] of [
    [["--bump", "major"], "--confirm-major"],
    [["--bump", "patch"], "--summary"],
    [["--bump", "minor", "--summary", "变更"], "--title"],
    [
      ["--bump", "minor", "--summary", "变更", "--title", "更新"],
      "--allow-repackage",
    ],
  ] as const) {
    const result = cli(root, ["run", ...args]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(error), result.stderr);
    assert.deepEqual(snapshot(root), before);
  }
  assert.equal(
    readFileSync(path.join(root, "release/Forma-0.10.0-arm64.dmg"), "utf8"),
    "existing",
  );
});
test("CLI restores all three originals on gate failure, then retries and completes a local patch", (t) => {
  const root = fixture(t),
    before = snapshot(root);
  const bin = path.join(root, "node_modules/.bin");
  for (const name of ["prettier", "tsx", "npm"]) {
    const mock = put(
      root,
      "node_modules/.bin/" + name,
      "#!" +
        process.execPath +
        '\nconsole.log("child progress"); const fs=require("node:fs"); const args=process.argv.slice(2).join(" "); fs.appendFileSync(' +
        JSON.stringify(path.join(root, "calls")) +
        ',args+"\\n"); if (process.env.FAIL_GATE === args) process.exit(9);\n',
    );
    chmodSync(mock, 0o755);
  }
  put(root, "src/editor/f.css", "edit");
  const args = ["run", "--summary", "修复样式", "--json"];
  const env = { PATH: bin + path.delimiter + process.env.PATH };
  const fail = cli(root, args, { ...env, FAIL_GATE: "run desktop:agent" });
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /已恢复/);
  assert.deepEqual(snapshot(root), before);
  for (const file of metadata)
    assert.equal(statSync(path.join(root, file)).mtimeMs, 1000);
  assert.match(
    readFileSync(path.join(root, "calls"), "utf8"),
    /--test tests\/release-notes.test.ts\nrun format:check\ntest\nrun build\nrun desktop:service\nrun desktop:agent\n/,
  );
  const retry = cli(root, args, env);
  assert.equal(retry.status, 0, retry.stderr);
  assert.ok(JSON.parse(retry.stdout).gatesExecuted.includes("npm test"));
  assert.match(retry.stderr, /child progress/);
  assert.ok(verifyReleaseMetadataSync(root).ok);
  assert.equal(verifyReleaseMetadataSync(root).packageVersion, "0.9.1");
  assert.equal(existsSync(path.join(root, "release")), false);
});

const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const pin = "5ef901a1829f3013cfb218ec7a376ae4e6dc463314bd4b2586622089b3df8eab";
const nativeResult = {
  version: "0.9.0",
  protocol: "forma:",
  filename: "shared-paint.fig",
  format: "Figma",
  sha256: pin,
  pages: 1,
  sourceNodes: 6,
  pageNodes: 2,
};
function writeBlockmap(artifact: string) {
  const bytes = readFileSync(artifact);
  writeFileSync(
    artifact + ".blockmap",
    gzipSync(
      JSON.stringify({
        version: "2",
        files: [
          {
            name: path.basename(artifact),
            offset: 0,
            size: bytes.length,
            checksums: [
              Buffer.from(blake2b(bytes, { dkLen: 18 })).toString("base64"),
            ],
            sizes: [bytes.length],
          },
        ],
      }),
    ),
  );
}
async function imageFixture(t: TestContext, build?: VerifyDmgOptions) {
  const version = build?.version ?? currentVersion;
  const root = build?.repoRoot ?? fixture(t),
    mount = path.join(root, "Mounted App"),
    bundle = path.join(mount, "Forma.app"),
    workDirs = new Set<string>();
  const imageBytes = build ? ".dmg" : "image";
  const dmg = put(
    root,
    build?.dmgPath
      ? path.relative(root, build.dmgPath)
      : "release/Forma-0.9.0-arm64.dmg",
    imageBytes,
  );
  const previous = path.join(root, "release/Forma-0.8.0-arm64.dmg");
  if (!build) {
    put(root, path.relative(root, previous), "old image");
    put(root, "release/Forma-1.0.0-arm64.dmg", "future image");
  }
  const archive = path.join(bundle, "Contents/Resources/app.asar");
  const binary = put(bundle, "Contents/MacOS/Forma", "launcher");
  const xml = (exts: string[]) =>
    '<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>' +
    version +
    "</string><key>CFBundleDocumentTypes</key><array>" +
    exts
      .map((ext) => {
        const own = ext.startsWith("forma");
        return (
          "<dict><key>CFBundleTypeExtensions</key><array><string>" +
          ext +
          "</string></array><key>CFBundleTypeRole</key><string>" +
          (own ? "Editor" : "Viewer") +
          "</string><key>LSHandlerRank</key><string>" +
          (own ? "Default" : "Alternate") +
          "</string></dict>"
        );
      })
      .join("") +
    "</array></dict></plist>";
  const notices = ["LICENSE.electron.txt", "LICENSES.chromium.html"].map(
    (name) => put(bundle, "Contents/Resources/" + name, "notice"),
  );
  const plist = put(
    bundle,
    "Contents/Info.plist",
    xml(["forma", "forma.json", "sketch", "fig"]),
  );
  const payload = path.join(root, "payload");
  const files = build?.pinnedOutputHashes
    ? Object.keys(build.pinnedOutputHashes)
    : [
        "electron/main.mjs",
        "electron/preload.cjs",
        "electron/after-sign.mjs",
        "dist/index.html",
        "dist/assets/ui.js",
        "out-electron/agent-service.mjs",
        "out-electron/library-service.mjs",
        "package.json",
      ];
  for (const f of files) {
    if (!build && f !== "package.json") put(root, f, "payload " + f);
    // Simulate builder stripping development-only fields from the verified manifest.
    const bytes =
      build && f === "package.json"
        ? JSON.stringify({ version })
        : readFileSync(path.join(build?.referenceRoot ?? root, f), "utf8");
    put(payload, f, bytes);
  }
  const asar = fileURLToPath(
    new URL("../node_modules/@electron/asar/bin/asar.js", import.meta.url),
  );
  mkdirSync(path.dirname(archive), { recursive: true });
  execFileSync(process.execPath, [asar, "pack", payload, archive]);
  const zip = dmg.replace(/\.dmg$/, ".zip");
  function packZip(
    different = false,
    extra: Record<string, Uint8Array> = {},
    executableMode?: number,
  ) {
    writeFileSync(
      zip,
      zipSync({
        ...extra,
        ...Object.fromEntries(
          [plist, archive, binary, ...notices].map((f) => [
            path.relative(mount, f),
            f === binary && executableMode !== undefined
              ? [
                  readFileSync(f),
                  { os: 3, attrs: (0o100000 | executableMode) * 65536 },
                ]
              : different && f === binary
                ? Buffer.from("different")
                : readFileSync(f),
          ]),
        ),
      }),
    );
    for (const artifact of [zip, dmg]) writeBlockmap(artifact);
  }
  packZip();
  const calls: { program: string; args: string[]; timeout: number }[] = [];
  let result: object = { ...nativeResult, version };
  let afterImport = () => {};
  let attached = false;
  let failPlutil = false,
    failDetach = false;
  const execFile: NonNullable<VerifyDmgOptions["execFile"]> = (
    program,
    args,
    opts,
  ) => {
    assert.ok(opts.timeout && opts.timeout > 0);
    calls.push({ program, args, timeout: opts.timeout });
    const cwd = String(opts.cwd);
    if (cwd !== root) workDirs.add(cwd);
    if (program === "/bin/ps") return "";
    if (program === "/usr/bin/hdiutil" && args[0] === "info")
      return "owned-images";
    if (program === "/usr/bin/hdiutil") {
      if (args[0] === "attach") {
        attached = true;
        assert.equal(opts.timeout, 60_000);
        const owned = args.at(-1)!;
        assert.equal(path.basename(owned), "verified.dmg");
        assert.notEqual(owned, dmg);
        assert.equal(statSync(owned).mode & 0o777, 0o400);
        assert.equal(readFileSync(owned, "utf8"), imageBytes);
        assert.equal(
          JSON.parse(
            readFileSync(
              path.join(root, "output/release-state/active-mount.json"),
              "utf8",
            ),
          ).ownedDmg,
          owned,
        );
        return "<key>dev-entry</key><string>/dev/disk99</string>";
      }
      assert.equal(opts.timeout, 30_000);
      if (failDetach && args.at(-1) === mount) throw Error("busy mount");
      if (args[0] === "detach") attached = false;
      return "";
    }
    if (program === "/usr/bin/plutil") {
      if (opts.input === "owned-images" && !attached)
        return JSON.stringify({ images: [] });
      if (opts.input === "owned-images")
        return JSON.stringify({
          images: [
            {
              "image-path": [...calls]
                .reverse()
                .find((c) => c.args[0] === "attach")!
                .args.at(-1),
              "system-entities": [
                { "dev-entry": "/dev/disk99", "mount-point": mount },
              ],
            },
          ],
        });
      if (failPlutil) throw Error("invalid attach receipt");
      if (args.at(-1) === "-")
        return JSON.stringify({
          "system-entities": [
            { "dev-entry": "/dev/disk99", "mount-point": mount },
          ],
        });
      if (process.platform === "darwin")
        return execFileSync(program, args, opts);
      return JSON.stringify({
        CFBundleShortVersionString: version,
        CFBundleDocumentTypes: Array.from(
          readFileSync(plist, "utf8").matchAll(
            /<array><string>([^<]+)<\/string><\/array><key>CFBundleTypeRole<\/key><string>([^<]+)<\/string><key>LSHandlerRank<\/key><string>([^<]+)<\/string>/g,
          ),
          (m) => ({
            CFBundleTypeExtensions: [m[1]],
            CFBundleTypeRole: m[2],
            LSHandlerRank: m[3],
          }),
        ),
      });
    }
    if (program === "/usr/bin/zipinfo")
      return execFileSync(program, args, opts);
    if (program === "/usr/bin/codesign") {
      if (args[0] === "-dvv")
        return "Identifier=com.forma.design\nSignature=adhoc\n";
      assert.deepEqual(args, ["--verify", "--deep", "--strict", bundle]);
      assert.equal(opts.timeout, 60_000);
      return "";
    }
    if (program === "/usr/bin/ditto") {
      assert.equal(opts.timeout, 120_000);
      if (process.platform === "darwin")
        return execFileSync(program, args, opts);
      for (const [name, bytes] of Object.entries(
        unzipSync(readFileSync(args[1])),
      )) {
        const dest = path.join(args[2], name);
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, bytes);
      }
      return "";
    }
    assert.equal(program, process.execPath);
    if (args[1] === "extract") {
      assert.equal(opts.timeout, 60_000);
      return execFileSync(program, [asar, ...args.slice(1)], opts);
    }
    assert.ok(args[0].endsWith("check-design-import-desktop.mjs"));
    assert.equal(opts.env?.FORMA_DESKTOP_EXECUTABLE, binary);
    assert.equal(opts.env?.MODEL_API_KEY, undefined);
    assert.equal(
      opts.env?.FORMA_DESKTOP_RESULT_FILE,
      path.join(cwd, "open-file-result.json"),
    );
    writeFileSync(opts.env!.FORMA_DESKTOP_RESULT_FILE!, JSON.stringify(result));
    afterImport();
    return '{"unexpected":"stdout diagnostic"}';
  };
  const runLiveChecks: NonNullable<VerifyDmgOptions["runLiveChecks"]> = async (
    _r,
    v,
    exe,
    work,
    env,
  ) => {
    assert.equal(v, version);
    assert.equal(exe, binary);
    assert.notEqual(work, root);
    assert.equal(env.HOME, path.join(work, "home"));
    assert.ok(statSync(env.HOME).isDirectory());
    assert.deepEqual(
      Object.keys(env).filter(
        (k) =>
          ![
            "HOME",
            "PATH",
            "TMPDIR",
            "USER",
            "LOGNAME",
            "LANG",
            "LC_ALL",
          ].includes(k),
      ),
      [],
    );
    return {
      electron: "fixture",
      agentServiceChecks: {
        protocol: "forma:",
        providersStatus: 200,
        providerCount: 13,
        statusCode: 200,
        configuredInCleanProfile: false,
        skillsStatus: 200,
        builtinSkillsCount: 2,
        totalSkillsCount: 2,
        critiqueRouteStatus: 400,
        critiqueRouteHasErrorField: true,
        libraryPlaybookRouteStatus: 400,
        libraryPlaybookRouteHasErrorField: true,
      },
      releaseNotesResult: { currentVersion: v, latestPublicVersion: v },
    };
  };
  const evidenceOut = "docs/evidence/trial/desktop-" + version + ".json";
  const verify = (extra: Partial<VerifyDmgOptions> = {}) =>
    verifyPackagedDmg({
      repoRoot: root,
      version,
      evidenceOut,
      expectedDmgSha256: build ? undefined : sha(imageBytes),
      execFile,
      runLiveChecks,
      ...extra,
    });
  t.after(() => {
    for (const dir of workDirs)
      assert.ok(!existsSync(dir), "Verifier left " + dir);
  });
  return {
    root,
    mount,
    dmg,
    zip,
    plist,
    xml,
    binary,
    previous,
    verify,
    evidenceOut,
    packZip,
    execFile,
    calls,
    setResult: (r: object) => {
      result = r;
    },
    onImport: (fn: () => void) => {
      afterImport = fn;
    },
    failPlist: () => {
      failPlutil = true;
    },
    failDetach: () => {
      failDetach = true;
    },
  };
}
test("positive DMG verification checks real ASAR and ZIP, isolated QA and a pinned result channel, then publishes evidence exclusively", async (t) => {
  const img = await imageFixture(t);
  const old = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY = "fixture-only";
  try {
    const evidence = await img.verify();
    assert.equal(evidence.zipMatchesDmgBundle, true);
    assert.deepEqual(evidence.signatureDetails, {
      verified: true,
      identifier: "com.forma.design",
      adhoc: true,
    });
    assert.equal(evidence.previousDmgIntact, null);
    assert.equal(evidence.previousDmg?.baseline, "verification-start");
    assert.deepEqual(evidence.desktopOpenFileResult, nativeResult);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(img.root, img.evidenceOut), "utf8")),
      evidence,
    );
    const calls = img.calls.length;
    await assert.rejects(img.verify(), /allow-overwrite-evidence/);
    assert.equal(img.calls.length, calls);
    const supplied = await img.verify({
      allowOverwriteEvidence: true,
      previousDmgPath: img.previous,
      previousDmgSha256: sha("old image"),
    });
    assert.equal(supplied.previousDmgIntact, true);
    assert.equal(supplied.previousDmg?.baseline, "pre-build");
  } finally {
    if (old === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = old;
  }
});
test("evidence and image containment reject linked ancestors, reserved metadata, external images, and hardlinked predecessors", async (t) => {
  const img = await imageFixture(t);
  mkdirSync(path.join(img.root, "docs/evidence"), { recursive: true });
  symlinkSync(
    path.join(img.root, "release"),
    path.join(img.root, "docs/evidence/link"),
  );
  for (const evidenceOut of [
    "package.json",
    "release/other.json",
    "docs/evidence/link/receipt.json",
    "docs/evidence/oops.dmg",
    "docs/evidence/release-manifest.json",
  ])
    await assert.rejects(
      img.verify({ evidenceOut, allowOverwriteEvidence: true }),
    );
  const external = put(img.root, "other/Forma-0.9.0-arm64.dmg", "fixture");
  cpSync(img.zip, external.replace(".dmg", ".zip"));
  await assert.rejects(img.verify({ dmgPath: external }), /trust-external/);
  await assert.rejects(
    img.verify({ previousDmgSha256: "0".repeat(64) }),
    /SHA-256/,
  );
  unlinkSync(img.previous);
  linkSync(img.dmg, img.previous);
  await assert.rejects(img.verify(), /previous DMG/);
  assert.equal(img.calls.length, 0);
});
test("bundle verification rejects mount escapes, missing associations, different ZIP bytes and ASAR input drift", async (t) => {
  const img = await imageFixture(t);
  unlinkSync(img.binary);
  symlinkSync(img.dmg, img.binary);
  await assert.rejects(img.verify(), /bundle path/);
  unlinkSync(img.binary);
  writeFileSync(img.binary, "launcher");
  const info = readFileSync(img.plist);
  writeFileSync(img.plist, img.xml(["forma", "sketch", "fig"]));
  await assert.rejects(img.verify(), /forma.json/);
  writeFileSync(img.plist, info);
  img.packZip(true);
  await assert.rejects(img.verify(), /ZIP differs/);
  img.packZip();
  const js = path.join(img.root, "dist/assets/ui.js");
  unlinkSync(js);
  await assert.rejects(img.verify(), /文件清单/);
  put(img.root, "dist/assets/ui.js", "payload dist/assets/ui.js");
  put(img.root, "dist/extra", "extra");
  await assert.rejects(img.verify(), /文件清单/);
  unlinkSync(path.join(img.root, "dist/extra"));
  for (const f of [
    "dist/index.html",
    "electron/main.mjs",
    "electron/preload.cjs",
    "electron/after-sign.mjs",
    "package.json",
    "out-electron/agent-service.mjs",
    "out-electron/library-service.mjs",
  ]) {
    const file = path.join(img.root, f),
      orig = readFileSync(file);
    writeFileSync(file, "changed");
    await assert.rejects(img.verify(), (e) => String(e).includes(f));
    writeFileSync(file, orig);
  }
  assert.equal(existsSync(path.join(img.root, img.evidenceOut)), false);
});
test("QA rejects unpinned import data and late mutations to each artifact before writing a receipt", async (t) => {
  const img = await imageFixture(t);
  for (const [key, value] of Object.entries({ ...nativeResult })) {
    img.setResult({
      ...nativeResult,
      [key]: typeof value === "number" ? value + 1 : value + "!",
    });
    await assert.rejects(img.verify());
  }
  img.setResult(nativeResult);
  for (const file of [
    img.dmg,
    img.zip,
    img.previous,
    img.dmg + ".blockmap",
    img.zip + ".blockmap",
  ]) {
    const orig = readFileSync(file);
    img.onImport(() => writeFileSync(file, "replacement"));
    await assert.rejects(img.verify(), /changed|改变/);
    writeFileSync(file, orig);
    assert.equal(existsSync(path.join(img.root, img.evidenceOut)), false);
  }
});
test("detach retries mount, forced mount and raw device and cleans up after plist failure", async (t) => {
  const img = await imageFixture(t);
  img.failDetach();
  await img.verify();
  assert.deepEqual(
    img.calls
      .filter((c) => c.args[0] === "detach")
      .slice(-3)
      .map((c) => c.args),
    [
      ["detach", img.mount],
      ["detach", "-force", img.mount],
      ["detach", "-force", "/dev/disk99"],
    ],
  );
  img.failPlist();
  await assert.rejects(
    img.verify({ allowOverwriteEvidence: true }),
    /invalid attach receipt/,
  );
  assert.deepEqual(
    img.calls.filter((c) => c.args[0] === "detach").at(-1)?.args,
    ["detach", "-force", "/dev/disk99"],
  );
});
test("literal multiline template notes and highlights are accepted while interpolated fields are rejected", () => {
  const tpl = notes.replace(
    '"可用"',
    "`two\nlines`, highlights: [`multi\nline`]",
  );
  assert.ok(applyReleaseNotesUpdate(tpl, entry).includes("multi\nline"));
  assert.throws(() =>
    applyReleaseNotesUpdate(tpl.replace("multi", "multi${1}"), entry),
  );
});
test("bounded regular plans cannot grant approvals; required release gates and major migration notes are enforced", async (t) => {
  const root = fixture(t);
  const assess = () => main(["assess", "--plan", "plan.json"], root);
  for (const key of [
    "confirmMajor",
    "allowRepackage",
    "trustExternalDmg",
    "allowOverwriteEvidence",
    "skipTests",
  ]) {
    put(root, "plan.json", JSON.stringify({ [key]: true }));
    await assert.rejects(assess(), /Unrecognized/);
  }
  put(root, "plan.json", " ".repeat(1024 * 1024 + 1));
  await assert.rejects(assess(), /1 MiB/);
  rmSync(path.join(root, "plan.json"));
  symlinkSync("package.json", path.join(root, "plan.json"));
  await assert.rejects(assess(), /regular/);
  rmSync(path.join(root, "plan.json"));
  execFileSync("mkfifo", [path.join(root, "plan.json")]);
  await assert.rejects(assess(), /regular/);
  await assert.rejects(main(["run", "--skip-tests"], root), /skip-tests/);
  await assert.rejects(
    main(["run", "--bump", "minor", "--package-desktop", "false"], root),
    /dry-run/,
  );
  await assert.rejects(
    main(
      [
        "run",
        "--bump",
        "major",
        "--confirm-major",
        "--title",
        "release",
        "--summary",
        "feature",
      ],
      root,
    ),
    /migration-notes/,
  );
  const res = cli(root, [
    "run",
    "--dry-run",
    "--bump",
    "major",
    "--confirm-major",
    "--title",
    "release",
    "--summary",
    "feature",
    "--migration-notes",
    "Convert legacy files",
    "--json",
  ]);
  assert.equal(res.status, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.equal(plan.releaseEntry.migrationNotes, "Convert legacy files");
  assert.ok(
    plan.changelog.some((x: string) => x.includes("Convert legacy files")),
  );
  assert.ok(
    plan.releaseEntry.highlights.includes("迁移说明：Convert legacy files"),
  );
});
test("since requires an existing ISO calendar day, timezone and Shanghai start of day", (t) => {
  const root = fixture(t);
  const time = (s: string) =>
    detectWorkspaceChanges(root, { sinceIso: s }).baselineMs;
  for (const s of [
    "11/25/2026",
    "2026-02-29",
    "2026-04-31T12:00Z",
    "2026-02-01T12:00",
    "2026-02-01T24:00Z",
    "2026-02-01T10:01:02.1234Z",
  ])
    assert.throws(() => time(s), /since/);
  assert.equal(time("2024-02-29"), Date.parse("2024-02-28T16:00:00Z"));
  assert.equal(
    time("2026-11-25T12:34:56.01-05:00"),
    Date.parse("2026-11-25T17:34:56.010Z"),
  );
});
test("explicit path validation, builder icons, and symlink scan warnings", (t) => {
  const root = fixture(t);
  for (const p of [
    "../../escape",
    "/etc/hosts",
    "C:\\windows",
    "a/../../outside",
    "x\0y",
  ])
    assert.throws(
      () => detectWorkspaceChanges(root, { explicitFiles: [p] }),
      /relative/,
    );
  const icon = put(root, "build/icon.icns", "icon");
  put(root, "src/one", "ok");
  const external = temporary(t);
  put(external, "draft/PRD.md", "# Outside\n- **状态**：已实施并验收");
  for (const [dir, target] of [
    ["docs/initiatives", external],
    ["src/link", icon],
    ["release", external],
  ])
    symlinkSync(target, path.join(root, dir));
  const diff = detectWorkspaceChanges(root);
  assert.ok(diff.changedFiles.includes("build/icon.icns"));
  assert.equal(diff.incompleteAssessment, true);
  assert.equal(diff.unshippedCompletedInitiatives.length, 0);
  for (const link of ["docs/initiatives", "src/link", "release"])
    assert.ok(diff.warnings.some((w) => w.includes(link)));
});
test("manifest identifies adds, edits and deletions with preserved mtimes; desktop delta survives a Web-only release", (t) => {
  const root = fixture(t);
  put(root, "src/a.ts", "a", 1);
  put(root, "src/b.ts", "b", 1);
  const before = sourceHashes(root),
    old = { version: "0.8.0", date: "2026-11-24", sourceHashes: before };
  writeReleaseManifest(root, {
    schemaVersion: 1,
    lastRelease: { ...old, shippedInitiatives: [] },
    lastDesktopRelease: {
      ...old,
      dmgFilename: "a.dmg",
      dmgSha256: sha("a"),
      zipFilename: "a.zip",
      zipSha256: sha("b"),
    },
  });
  put(root, "src/a.ts", "edit", 1);
  rmSync(path.join(root, "src/b.ts"));
  put(root, "src/c.ts", "new", 1);
  const diff = detectWorkspaceChanges(root);
  assert.equal(diff.source, "manifest");
  assert.deepEqual(diff.changedFiles, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  const m = readReleaseManifest(root);
  m.lastRelease!.sourceHashes = sourceHashes(root);
  writeReleaseManifest(root, m);
  assert.deepEqual(detectWorkspaceChanges(root).changedFiles, []);
  assert.equal(verifyReleaseMetadataSync(root).staleRuntimeFileCount, 3);
});
test("desktop evidence supplies a fallback timestamp and new completed initiatives enter assessment only once", (t) => {
  const root = fixture(t);
  put(root, "docs/evidence/day/desktop-0.9.0.json", "{}", 10);
  put(
    root,
    "docs/initiatives/shipped/PRD.md",
    "# Already shipped\n- **状态**：已实施并验收",
    9,
  );
  const dir = "docs/initiatives/done";
  put(
    root,
    dir + "/PRD.md",
    "# Initiative\n- **状态**：已实施并验收（阶段）",
    11,
  );
  assert.equal(detectWorkspaceChanges(root).baselineMs, 10000);
  assert.deepEqual(detectWorkspaceChanges(root).unshippedCompletedInitiatives, [
    dir,
  ]);
  for (const file of [dir + "/PRD.md", "src/editor/ui.ts"]) {
    const res = cli(root, ["assess", "--files", file, "--json"]);
    assert.equal(
      JSON.parse(res.stdout).bump,
      file.startsWith(dir) ? "minor" : "patch",
      res.stderr,
    );
    assert.deepEqual(
      JSON.parse(res.stdout).shippedInitiatives,
      file.startsWith(dir) ? [dir] : [],
    );
  }
  writeReleaseManifest(root, {
    schemaVersion: 1,
    lastRelease: {
      version: currentVersion,
      date: entry.date,
      shippedInitiatives: [dir, "docs/initiatives/shipped"],
      sourceHashes: sourceHashes(root),
    },
  });
  put(root, dir + "/PRD.md", "# Typo fix\n- **状态**：已实施并验收", 12);
  assert.deepEqual(
    detectWorkspaceChanges(root).unshippedCompletedInitiatives,
    [],
  );
});
test("Git includes clean post-release commits, both names of a committed rename, --since and untracked work", (t) => {
  const root = fixture(t);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  git("config", "commit.gpgsign", "false");
  put(root, "src/editor/a.ts", "content");
  git("add", ".");
  git("commit", "-qm", "baseline");
  writeReleaseManifest(root, {
    schemaVersion: 1,
    lastRelease: {
      version: currentVersion,
      date: entry.date,
      gitHead: git("rev-parse", "HEAD").trim(),
      sourceHashes: sourceHashes(root),
      shippedInitiatives: [],
    },
  });
  mkdirSync(path.join(root, "server"));
  git("mv", "src/editor/a.ts", "server/moved.ts");
  git("add", ".");
  git("commit", "-qm", "moved");
  assert.equal(git("status", "--porcelain").trim(), "");
  put(root, "tests/untracked", "new");
  for (const options of [{}, { sinceIso: "2001-01-01" }]) {
    const changes = detectWorkspaceChanges(root, options).changedFiles;
    for (const name of [
      "src/editor/a.ts",
      "server/moved.ts",
      "tests/untracked",
    ])
      assert.ok(changes.includes(name), changes.join("|"));
  }
});
const credentialNames = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_KEYCHAIN",
  "APPLE_KEYCHAIN_PROFILE",
  "GH_TOKEN",
  "EP_GH_TOKEN",
  "GITHUB_TOKEN",
  "CIRCLE_TAG",
  "TRAVIS_TAG",
  "CI_COMMIT_TAG",
  "GITHUB_REF",
  "GITHUB_ACTIONS",
  "CI",
];
function releaseFixture(t: TestContext) {
  const root = fixture(t),
    bin = path.join(root, "node_modules/.bin");
  const lock =
    JSON.stringify(
      {
        version: currentVersion,
        packages: {
          "": { version: currentVersion },
          "node_modules/example": { version: "1.2.3" },
        },
      },
      null,
      2,
    ) + "\n";
  put(root, "package-lock.json", lock, 1);
  put(root, "build/icon.icns", "icon");
  function script(name: string, body: string) {
    chmodSync(
      put(
        root,
        "node_modules/.bin/" + name,
        "#!" + process.execPath + "\n" + body,
      ),
      0o755,
    );
  }
  script(
    "npm",
    `const fs=require("node:fs"), gate=process.argv[3];console.log("npm gate " + process.argv.slice(2).join(" "));
  if(gate==="build"){fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/index.html",fs.existsSync("src/editor/input.ts")?fs.readFileSync("src/editor/input.ts"):"web");}
  if(gate==="desktop:service" || gate==="desktop:agent"){fs.mkdirSync("out-electron",{recursive:true});fs.writeFileSync("out-electron/"+(gate==="desktop:agent"?"agent":"library")+"-service.mjs",gate);}
  `,
  );
  put(root, "electron/main.mjs", "main", 1);
  put(
    root,
    "node_modules/electron/package.json",
    JSON.stringify({ version: "45.4.1" }),
  );
  const cache = temporary(t);
  const zipName = "electron-v45.4.1-darwin-arm64.zip";
  put(cache, zipName, "cached Electron");
  put(
    root,
    "node_modules/electron/checksums.json",
    JSON.stringify({ [zipName]: sha("cached Electron") }),
  );
  script("tsx", 'console.log("release notes gate");');
  script(
    "electron-builder",
    `
    const fs=require("node:fs"),path=require("node:path");
    const args=process.argv.slice(2),dir=args.find(a=>a.startsWith("-c.directories.output=")).split("=")[1],root=${JSON.stringify(root)};
    const names=${JSON.stringify([...credentialNames, "CSC_IDENTITY_AUTO_DISCOVERY", "FORMA_FORCE_ADHOC_SIGN"])};
    fs.writeFileSync(path.join(root,"builder-call.json"),JSON.stringify({args,cwd:process.cwd(),env:Object.fromEntries(names.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))}));
    console.log("builder progress");
    if(fs.existsSync(path.join(root,"fail-builder")))process.exit(7);
    const v=JSON.parse(fs.readFileSync("package.json")).version;
    for(const ext of [".dmg",".zip",".dmg.blockmap",".zip.blockmap"])fs.writeFileSync(path.join(dir,"Forma-"+v+"-arm64"+ext),ext);
  `,
  );
  const env = {
    ELECTRON_CACHE: cache,
    PATH: bin + path.delimiter + process.env.PATH,
    ...Object.fromEntries(credentialNames.map((k) => [k, "fixture-token"])),
  };
  const args = [
    "run",
    "--bump",
    "minor",
    "--title",
    "Milestone",
    "--summary",
    "Feature",
    "--json",
  ];
  const verify: typeof verifyPackagedDmg = async (opts) => {
    assert.ok(opts.deferEvidence);
    assert.ok(
      opts.dmgPath?.includes(
        "output/release-state/staging-" + opts.version + "-",
      ),
    );
    assert.equal(
      existsSync(
        path.join(root, "release/Forma-" + opts.version + "-arm64.dmg"),
      ),
      false,
    );
    const matchingWebAndApp: Record<string, string> = {
      "package.json": opts.pinnedOutputHashes!["package.json"],
    };
    return {
      version: opts.version,
      matchingWebAndApp,
      distribution: [".dmg", ".zip", ".dmg.blockmap", ".zip.blockmap"].map(
        (ext) => ({
          filename: "Forma-" + opts.version + "-arm64" + ext,
          sha256: sha(ext),
          bytes: ext.length,
        }),
      ),
    } as DesktopVerificationEvidence;
  };
  async function run(
    argv: string[],
    hook = verify,
    skipElectronCachePreflight?: boolean,
  ) {
    const oldCache = process.env.ELECTRON_CACHE;
    process.env.ELECTRON_CACHE = env.ELECTRON_CACHE;
    const orig = process.env.PATH;
    process.env.PATH = env.PATH;
    // Keep TAP output readable. Child stdio still follows the real --json path.
    const log = t.mock.method(console, "log", () => {});
    try {
      await main(argv, root, { verify: hook, skipElectronCachePreflight });
      return JSON.parse(String(log.mock.calls.at(-1)?.arguments[0]));
    } finally {
      process.env.PATH = orig;
      if (oldCache === undefined) delete process.env.ELECTRON_CACHE;
      else process.env.ELECTRON_CACHE = oldCache;
      log.mock.restore();
    }
  }
  return { root, lock, args, env, run, verify };
}
test("all four versioned targets, including dangling symlinks, block releases before mutation", async (t) => {
  const f = releaseFixture(t),
    before = snapshot(f.root);
  for (const ext of [".dmg", ".dmg.blockmap", ".zip", ".zip.blockmap"]) {
    const name = put(f.root, "release/Forma-0.10.0-arm64" + ext, "untouched");
    await assert.rejects(f.run(f.args), /allow-repackage/);
    unlinkSync(name);
    symlinkSync("missing", name);
    await assert.rejects(f.run(f.args), /allow-repackage/);
    unlinkSync(name);
  }
  assert.deepEqual(snapshot(f.root), before);
  assert.deepEqual(readdirSync(path.join(f.root, "output/release-state")), []);
});
test("builder failure journals the formatted bytes, strips CI credentials, and resumes and promotes the same version", async (t) => {
  const f = releaseFixture(t),
    dir = path.join(f.root, "output/release-state");
  const fail = put(f.root, "fail-builder", "1");
  const releaseArgs = f.args;
  const old = Object.fromEntries(
    credentialNames.map((k) => [k, process.env[k]]),
  );
  try {
    for (const k of credentialNames) process.env[k] = "fixture-token";
    await assert.rejects(f.run(releaseArgs), /electron-builder/);
  } finally {
    for (const k of credentialNames)
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
  }
  const tx = JSON.parse(readFileSync(path.join(dir, "tx.json"), "utf8"));
  const call = JSON.parse(
    readFileSync(path.join(f.root, "builder-call.json"), "utf8"),
  );
  assert.deepEqual(call.args, [
    "--publish",
    "never",
    "-c.mac.notarize=false",
    "-c.mac.identity=null",
    "-c.directories.output=" + path.join(f.root, tx.stagingDir),
    "-c.extends=" + path.join(f.root, tx.stagingDir, "builder.json"),
    "-c.afterPack=" +
      path.join(f.root, tx.stagingDir, "checkout/electron/after-sign.mjs"),
  ]);
  assert.equal(call.cwd, path.join(f.root, tx.stagingDir, "checkout"));
  assert.deepEqual(call.env, {
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    FORMA_FORCE_ADHOC_SIGN: "1",
  });
  for (const m of tx.metadata) {
    assert.equal(sha(m.original), m.originalSha256);
    assert.equal(sha(readFileSync(path.join(f.root, m.name))), m.writtenSha256);
  }
  assert.equal(readReleaseManifest(f.root).lastRelease, undefined);
  await assert.rejects(f.run(releaseArgs), /--resume.*--rollback/);
  unlinkSync(fail);
  put(
    f.root,
    "output/release-state/release.lock",
    JSON.stringify({ pid: 2147483647 }),
  );
  const report = await f.run(["run", "--resume", "--json"]);
  assert.equal(report.decision.nextVersion, "0.10.0");
  assert.ok(report.gatesExecuted.includes("npm test"));
  assert.ok(report.gatesExecuted.includes("verify-dmg"));
  for (const ext of [".dmg", ".zip", ".dmg.blockmap", ".zip.blockmap"])
    assert.equal(
      readFileSync(
        path.join(f.root, "release", "Forma-0.10.0-arm64" + ext),
        "utf8",
      ),
      ext,
    );
  assert.equal(
    readReleaseManifest(f.root).lastDesktopRelease?.dmgSha256,
    sha(".dmg"),
  );
  assert.equal(readReleaseManifest(f.root).lastRelease?.version, "0.10.0");
  assert.deepEqual(readdirSync(dir), ["displaced"]);
});
test("explicit rollback after builder failure restores all metadata and clears the staged transaction", async (t) => {
  const f = releaseFixture(t),
    before = snapshot(f.root);
  put(f.root, "fail-builder", "1");
  await assert.rejects(f.run(f.args));
  const advanced = JSON.parse(
    readFileSync(path.join(f.root, "package-lock.json"), "utf8"),
  );
  assert.equal(advanced.version, "0.10.0");
  assert.equal(advanced.packages[""].version, "0.10.0");
  await f.run(["run", "--rollback", "--json"]);
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(
    readFileSync(path.join(f.root, "package-lock.json"), "utf8"),
    f.lock,
  );
  assert.deepEqual(readdirSync(path.join(f.root, "output/release-state")), [
    "displaced",
  ]);
});
test("rollback saves the original and preserves a concurrent lockfile edit", async (t) => {
  const f = releaseFixture(t);
  put(f.root, "fail-builder", "1");
  await assert.rejects(f.run(f.args));
  put(f.root, "package-lock.json", "external edit");
  await assert.rejects(
    f.run(["run", "--rollback"]),
    /package-lock\.json.*original/,
  );
  assert.equal(
    readFileSync(path.join(f.root, "package-lock.json"), "utf8"),
    "external edit",
  );
  assert.equal(
    readFileSync(
      path.join(
        f.root,
        "output/release-state/conflicts/package-lock.json.original",
      ),
      "utf8",
    ),
    f.lock,
  );
  assert.ok(existsSync(path.join(f.root, "output/release-state/tx.json")));
});
test("metadata symlinks, lock mirror divergence and runtime edits during verification fail closed", async (t) => {
  const f = releaseFixture(t);
  const lock = path.join(f.root, "package-lock.json");
  put(f.root, "package-lock.json", f.lock.replace('"0.9.0"', '"0.0.1"'));
  assert.equal(verifyReleaseMetadataSync(f.root).ok, false);
  unlinkSync(lock);
  symlinkSync(put(f.root, "elsewhere", f.lock), lock);
  await assert.rejects(f.run(f.args), /Unsafe workspace|symlink/);
  assert.equal(readFileSync(path.join(f.root, "elsewhere"), "utf8"), f.lock);
  unlinkSync(lock);
  writeFileSync(lock, f.lock);
  await assert.rejects(
    f.run(f.args, async (opts) => {
      const result = await f.verify(opts);
      put(f.root, "src/editor/late.ts", "late");
      return result;
    }),
    /Source changed/,
  );
  assert.ok(!existsSync(path.join(f.root, "release/Forma-0.10.0-arm64.dmg")));
  assert.equal(readReleaseManifest(f.root).lastRelease, undefined);
});
test("successful gated CLI run has pure JSON stdout and supports an empty maintenance summary with changelog bullets", (t) => {
  const f = releaseFixture(t);
  rmSync(path.join(f.root, "build/icon.icns"));
  rmSync(path.join(f.root, "electron"), { recursive: true });
  put(f.root, "release/Forma-0.9.0-arm64.dmg", "baseline", 2);
  put(f.root, "src/editor/a.ts", "edit");
  const res = cli(
    f.root,
    ["run", "--summary", "", "--changelog", "local maintenance", "--json"],
    f.env,
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /npm gate test/);
  assert.deepEqual(JSON.parse(res.stdout).gatesExecuted, [
    "tsx --test tests/release-notes.test.ts",
    "npm run format:check",
    "npm test",
    "npm run build",
    "npm run desktop:service",
    "npm run desktop:agent",
  ]);
  assert.equal(readReleaseManifest(f.root).lastRelease?.version, "0.9.1");
  assert.deepEqual(detectWorkspaceChanges(f.root).changedFiles, []);
});

test("recovery recognizes manifest promotion as the commit point across JSON key orders", async (t) => {
  const f = releaseFixture(t),
    journal = path.join(f.root, "output/release-state/tx.json");
  let interrupted: Record<string, unknown> = {};
  await f.run(f.args, async (opts) => {
    interrupted = JSON.parse(readFileSync(journal, "utf8"));
    return f.verify(opts);
  });
  const next = readReleaseManifest(f.root);
  const m = next.lastRelease!;
  const preCommit = {
    ...next,
    lastRelease: {
      shippedInitiatives: m.shippedInitiatives,
      version: m.version,
      sourceHashes: m.sourceHashes,
      packagePackagingSha256: m.packagePackagingSha256,
      date: m.date,
    },
  };
  writeFileSync(
    journal,
    JSON.stringify({
      ...interrupted,
      stage: "promote",
      nextManifest: preCommit,
    }),
  );
  await assert.rejects(f.run(["run", "--rollback"]), /already committed/);
  await f.run(["run", "--resume", "--json"]);
  assert.equal(verifyReleaseMetadataSync(f.root).packageVersion, "0.10.0");
  assert.deepEqual(readdirSync(path.dirname(journal)), ["displaced"]);
});
test("repackaging and evidence replacement each require their own CLI approval", async (t) => {
  const f = releaseFixture(t);
  const target = put(f.root, "release/Forma-0.10.0-arm64.zip", "previous ZIP");
  const receipt = put(
    f.root,
    "docs/evidence/" + getShanghaiDate() + "/desktop-0.10.0.json",
    "previous receipt",
  );
  await assert.rejects(
    f.run([...f.args, "--allow-repackage"]),
    /allow-overwrite-evidence/,
  );
  assert.equal(readFileSync(target, "utf8"), "previous ZIP");
  assert.equal(readFileSync(receipt, "utf8"), "previous receipt");
  await f.run([...f.args, "--allow-repackage", "--allow-overwrite-evidence"]);
  assert.equal(readFileSync(target, "utf8"), ".zip");
  assert.equal(JSON.parse(readFileSync(receipt, "utf8")).version, "0.10.0");
});
test("a Git release does not count its own working-tree or newly committed metadata again", async (t) => {
  const f = releaseFixture(t);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: f.root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("config", "commit.gpgsign", "false");
  put(f.root, ".gitignore", "node_modules/\noutput/\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
  await f.run([
    "run",
    "--since",
    "2099-01-01",
    "--significance",
    "bugfix",
    "--summary",
    "a patch",
    "--json",
  ]);
  for (const commit of [false, true]) {
    if (commit) {
      git("add", ".");
      git("commit", "-qm", "release metadata");
    }
    assert.deepEqual(detectWorkspaceChanges(f.root).changedFiles, []);
  }
});
test(
  "unreadable regular source inputs yield an incomplete assessment",
  { skip: process.getuid?.() === 0 },
  (t) => {
    const root = fixture(t),
      blocked = put(root, "src/locked.ts", "locked");
    chmodSync(blocked, 0);
    try {
      const diff = detectWorkspaceChanges(root);
      assert.equal(diff.incompleteAssessment, true);
      assert.ok(diff.warnings.some((w) => w.includes("locked.ts")));
    } finally {
      chmodSync(blocked, 0o600);
    }
  },
);
test("real npm gates which emit TAP and progress leave gated run --json stdout parseable", (t) => {
  const root = fixture(t);
  const scripts = {
    "release:run":
      'node --import "' +
      import.meta.resolve("tsx") +
      '" "' +
      pipeline +
      '" run',
    test: "node --test tests/release-notes.test.ts",
    build: "node --check app.mjs",
    "desktop:service": "node --check service.mjs",
    "desktop:agent": "node --check agent.mjs",
    "format:check": "node check-format.mjs",
  };
  put(
    root,
    "package.json",
    JSON.stringify({ name: "fixture", version: currentVersion, scripts }),
  );
  put(
    root,
    "tests/release-notes.test.ts",
    'const assert=require("node:assert/strict");const fs=require("node:fs"); require("node:test")("release metadata",()=>{const v=JSON.parse(fs.readFileSync("package.json")).version;assert.ok(fs.readFileSync("docs/CHANGELOG.md","utf8").includes("## "+v+" ·"));});',
  );
  put(
    root,
    "check-format.mjs",
    'import assert from "node:assert/strict";import fs from "node:fs";const raw=fs.readFileSync("package.json","utf8");assert.equal(raw,JSON.stringify(JSON.parse(raw),null,2)+"\\n");console.log("format checked");',
  );
  for (const file of ["app.mjs", "service.mjs", "agent.mjs"])
    put(root, file, 'export const version="fixture";');
  const bin = path.join(root, "node_modules/.bin");
  mkdirSync(bin, { recursive: true });
  // This fixture's test is valid native Node TypeScript; exercise real TAP without a tsx IPC service.
  symlinkSync(process.execPath, path.join(bin, "tsx"));
  writeReleaseManifest(root, {
    schemaVersion: 1,
    lastRelease: {
      version: currentVersion,
      date: entry.date,
      shippedInitiatives: [],
      sourceHashes: sourceHashes(root),
      packagePackagingSha256: packagePackagingHash(
        readFileSync(path.join(root, "package.json"), "utf8"),
      ),
    },
  });
  put(root, "src/editor/a.ts", "edit");
  const result = spawnSync(
    "npm",
    [
      "run",
      "--silent",
      "release:run",
      "--",
      "--summary",
      "fixture patch",
      "--json",
    ],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /format checked/);
  assert.match(result.stderr, /release metadata/);
  assert.ok(JSON.parse(result.stdout).gatesExecuted.includes("npm test"));
});
test("standalone verification authenticates an unrecorded image before launch and accepts its archived digest", async (t) => {
  const img = await imageFixture(t);
  await assert.rejects(
    img.verify({ expectedDmgSha256: undefined }),
    /trust-external-dmg/,
  );
  assert.equal(img.calls.length, 0);
  const receipt = put(
    img.root,
    "docs/evidence/2026-11-19/desktop-0.9.0.json",
    JSON.stringify({
      version: "0.9.0",
      distribution: [
        { filename: path.basename(img.dmg), sha256: sha("wrong") },
      ],
    }),
  );
  await assert.rejects(
    img.verify({ expectedDmgSha256: undefined }),
    /trusted build digest/,
  );
  writeFileSync(
    receipt,
    JSON.stringify({
      version: "0.9.0",
      distribution: [
        { filename: path.basename(img.dmg), sha256: sha("image") },
      ],
    }),
  );
  assert.equal(
    (await img.verify({ expectedDmgSha256: undefined })).zipMatchesDmgBundle,
    true,
  );
});
test("rollback retains an overwritten artifact's original backup if its destination was replaced by another writer", async (t) => {
  const f = releaseFixture(t);
  put(f.root, "fail-builder", "1");
  await assert.rejects(f.run(f.args));
  const journal = path.join(f.root, "output/release-state/tx.json"),
    tx = JSON.parse(readFileSync(journal, "utf8"));
  const name = "Forma-0.10.0-arm64.zip",
    target = "release/" + name;
  const backup = put(
    f.root,
    path.join(
      "output/release-state/backups",
      path.basename(tx.stagingDir),
      name,
    ),
    "prior ZIP",
  );
  put(f.root, path.join(tx.stagingDir, name), "verified ZIP");
  put(f.root, target, "user ZIP");
  tx.stage = "promote";
  tx.promotions = [
    {
      name,
      target,
      previousHash: sha("prior ZIP"),
      sha256: sha("verified ZIP"),
    },
  ];
  writeFileSync(journal, JSON.stringify(tx));
  await assert.rejects(
    f.run(["run", "--rollback"]),
    /Concurrent artifact edit/,
  );
  assert.equal(readFileSync(backup, "utf8"), "prior ZIP");
  assert.equal(readFileSync(path.join(f.root, target), "utf8"), "user ZIP");
  assert.ok(existsSync(journal));
});

test("first stable promotion has major governance on all RC bump paths", async (t) => {
  for (const bump of ["patch", "minor", "major"] as const) {
    const result = decision({
      currentVersion: "1.0.0-rc.1",
      significance: "bugfix",
      overrideBump: bump,
    });
    assert.equal(result.nextVersion, "1.0.0");
    assert.equal(result.bump, "major");
    assert.ok(result.packageDesktop && result.publishInReleaseNotes);
  }
  const root = fixture(t);
  put(root, "package.json", JSON.stringify({ version: "1.0.0-rc.1" }));
  const args = [
    "run",
    "--bump",
    "patch",
    "--title",
    "Stable",
    "--summary",
    "Release",
  ];
  await assert.rejects(main(args, root), /confirm-major/);
  await assert.rejects(
    main([...args, "--confirm-major"], root),
    /migration-notes/,
  );
});

test("finalization rejects scoped plans and a tier below the frozen recommendation", async (t) => {
  const root = fixture(t);
  put(
    root,
    "docs/initiatives/shipping/PRD.md",
    "# Ship\n- **状态**：已实施并验收",
  );
  await assert.rejects(
    main(["run", "--bump", "patch", "--summary", "patch"], root),
    /at least minor/,
  );
  put(
    root,
    "scoped.json",
    JSON.stringify({ files: ["docs/doc.md"], bump: "none" }),
  );
  await assert.rejects(main(["run", "--plan", "scoped.json"], root), /--files/);
  await assert.rejects(
    main(["run", "--breaking-or-v1", "--bump", "patch"], root),
    /at least major/,
  );
  const preview = cli(root, [
    "assess",
    "--files",
    "docs/doc.md",
    "--initiative",
    "shipping",
    "--json",
  ]);
  assert.deepEqual(JSON.parse(preview.stdout).shippedInitiatives, [
    "docs/initiatives/shipping",
  ]);
  assert.ok(!existsSync(path.join(root, "output/release-state/tx.json")));
});

test("package build.fileAssociations changes require a packaged patch; nested generated names are source", (t) => {
  const root = fixture(t),
    pkg = {
      version: currentVersion,
      build: { fileAssociations: [{ ext: "forma", role: "Editor" }] },
    };
  const baseline = JSON.stringify(pkg);
  put(root, "package.json", baseline);
  writeReleaseManifest(root, {
    schemaVersion: 1,
    lastRelease: {
      version: currentVersion,
      date: entry.date,
      shippedInitiatives: [],
      sourceHashes: sourceHashes(root),
      packagePackagingSha256: packagePackagingHash(baseline),
    },
  });
  put(
    root,
    "package.json",
    JSON.stringify({ ...pkg, scripts: { lint: "example" } }),
  );
  assert.equal(detectWorkspaceChanges(root).packagePackagingChanged, false);
  pkg.build.fileAssociations[0].role = "Viewer";
  put(root, "package.json", JSON.stringify(pkg));
  const assessment = JSON.parse(cli(root, ["assess", "--json"]).stdout);
  assert.deepEqual(
    [assessment.bump, assessment.packageDesktop, assessment.coreSubsystems],
    ["patch", true, ["electron"]],
  );
  for (const f of [
    "src/dist/a",
    "src/output/b",
    "src/out-electron/c",
    "src/release/d",
    "scripts/release/dist/e",
  ])
    put(root, f, "source");
  assert.equal(detectWorkspaceChanges(root).changedFiles.length, 6);
});

test("Git hash union detects an uncommitted shipped edit reverted to a clean HEAD", (t) => {
  const root = fixture(t),
    git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  put(root, ".gitignore", "docs/evidence/\n");
  put(root, "src/editor/ui.ts", "committed");
  git("add", ".");
  git(
    "-c",
    "user.name=Tests",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "base",
  );
  assert.match(detectWorkspaceChanges(root).warnings.join(" "), /--since/);
  put(root, "src/editor/ui.ts", "shipped working copy");
  writeReleaseManifest(root, {
    schemaVersion: 1,
    lastRelease: {
      version: currentVersion,
      date: entry.date,
      sourceHashes: sourceHashes(root),
      gitHead: git("rev-parse", "HEAD").trim(),
      shippedInitiatives: [],
    },
  });
  assert.deepEqual(detectWorkspaceChanges(root).changedFiles, []);
  git("restore", "src/editor/ui.ts");
  assert.equal(git("status", "--porcelain"), "");
  assert.deepEqual(detectWorkspaceChanges(root).changedFiles, [
    "src/editor/ui.ts",
  ]);
});

test("a gate edit aborts before build, and a pre-build resume rejects source drift", async (t) => {
  const f = releaseFixture(t),
    npm = path.join(f.root, "node_modules/.bin/npm");
  const original = readFileSync(npm, "utf8");
  writeFileSync(
    npm,
    "#!" +
      process.execPath +
      '\nconst fs=require("node:fs");fs.appendFileSync(' +
      JSON.stringify(path.join(f.root, "gates.log")) +
      ',process.argv.slice(2).join(" ")+"\\n");if(process.argv.includes("format:check"))fs.writeFileSync(' +
      JSON.stringify(path.join(f.root, "src/editor/concurrent.ts")) +
      ',"edit");',
  );
  await assert.rejects(f.run(f.args), /Source changed/);
  assert.doesNotMatch(
    readFileSync(path.join(f.root, "gates.log"), "utf8"),
    /run build/,
  );
  assert.equal(
    verifyReleaseMetadataSync(f.root).packageVersion,
    currentVersion,
  );
  writeFileSync(npm, original);
  put(f.root, "fail-builder", "1");
  await assert.rejects(f.run(f.args), /electron-builder/);
  put(f.root, "src/editor/concurrent.ts", "another edit");
  await assert.rejects(f.run(["run", "--resume"]), /Source changed.*rollback/);
  await f.run(["run", "--rollback", "--json"]);
  assert.equal(
    readFileSync(path.join(f.root, "src/editor/concurrent.ts"), "utf8"),
    "another edit",
  );
});

test("interrupted rollback preserves the immutable artifact backup across retries", async (t) => {
  const f = releaseFixture(t);
  put(f.root, "fail-builder", "1");
  await assert.rejects(f.run(f.args));
  const journal = path.join(f.root, "output/release-state/tx.json"),
    tx = JSON.parse(readFileSync(journal, "utf8"));
  const name = "Forma-0.10.0-arm64.zip",
    target = "release/" + name;
  const backup = put(
    f.root,
    path.join(
      "output/release-state/backups",
      path.basename(tx.stagingDir),
      name,
    ),
    "old",
  );
  mkdirSync(path.join(f.root, "release"), { recursive: true });
  linkSync(
    put(f.root, path.join(tx.stagingDir, name), "new"),
    path.join(f.root, target),
  );
  tx.promotions = [
    { target, name, sha256: sha("new"), previousHash: sha("old") },
  ];
  tx.stage = "promote";
  writeFileSync(journal, JSON.stringify(tx));
  put(f.root, "package-lock.json", "concurrent edit");
  await assert.rejects(f.run(["run", "--rollback"]), /Concurrent metadata/);
  assert.equal(JSON.parse(readFileSync(journal, "utf8")).stage, "rolling-back");
  assert.equal(readFileSync(backup, "utf8"), "old");
  assert.equal(readFileSync(path.join(f.root, target), "utf8"), "old");
  await assert.rejects(f.run(["run", "--resume"]), /complete --rollback/);
  put(f.root, "package-lock.json", f.lock);
  await f.run(["run", "--rollback", "--json"]);
  assert.ok(!existsSync(journal));
  assert.equal(readFileSync(path.join(f.root, target), "utf8"), "old");
});

test("mount recovery finds a pre-attach journal by image path and waits for a recorded live child", (t) => {
  const root = fixture(t),
    ownedDmg = put(
      root,
      "output/release-state/verifier-example/verified.dmg",
      "owned",
    );
  const name = "output/release-state/active-mount.json",
    rec = { owner: 2147483647, ownedDmg };
  put(root, name, JSON.stringify({ ...rec, childPid: process.pid }));
  assert.throws(
    () =>
      reconcileActiveMount(root, () => {
        throw Error("unexpected command");
      }),
    /still alive/,
  );
  put(root, name, JSON.stringify(rec));
  const detached: string[] = [];
  reconcileActiveMount(root, (prog, args) => {
    if (prog === "/usr/bin/plutil" && detached.length)
      return JSON.stringify({ images: [] });
    if (prog === "/usr/bin/plutil")
      return JSON.stringify({
        images: [
          {
            "image-path": "/unrelated.dmg",
            "system-entities": [{ "dev-entry": "/dev/disk1" }],
          },
          {
            "image-path": ownedDmg,
            "system-entities": [
              { "dev-entry": "/dev/disk77", "mount-point": "/Volumes/fixture" },
            ],
          },
        ],
      });
    if (args[0] === "detach") detached.push(args.at(-1)!);
    return "";
  });
  assert.deepEqual(detached, ["/dev/disk77"]);
  assert.ok(!existsSync(path.join(root, name)) && !existsSync(ownedDmg));
});

test("ZIP inventory bounds, exact associations, licenses and both blockmaps are checked", async (t) => {
  const img = await imageFixture(t),
    xml = readFileSync(img.plist, "utf8");
  for (const [from, to] of [
    ["Editor", "Viewer"],
    ["Alternate", "Default"],
  ]) {
    writeFileSync(img.plist, xml.replace(from, to));
    await assert.rejects(img.verify(), /document association/);
  }
  writeFileSync(img.plist, xml);
  img.packZip(false, { "extra.txt": Buffer.from("unrelated") });
  await assert.rejects(img.verify(), /Unexpected ZIP entry/);
  img.packZip();
  const listing = execFileSync("/usr/bin/zipinfo", ["-l", "-T", img.zip], {
    encoding: "utf8",
  });
  assert.throws(
    () =>
      validateZipInventory(
        listing.replace(/number of entries: \d+/, "number of entries: 50001"),
      ),
    /entry count/,
  );
  assert.throws(
    () => validateZipInventory(listing.replace(/fat\s+\d+/, "fat 2147483649")),
    /2 GiB/,
  );
  for (const file of [img.dmg, img.zip]) {
    const good = readFileSync(file + ".blockmap");
    const map = {
      name: path.basename(file),
      offset: 0,
      size: statSync(file).size,
      checksums: ["wrong"],
      sizes: [statSync(file).size],
    };
    for (const diff of [
      { name: "other" },
      { size: 1 },
      { sizes: [1] },
      { checksums: [] },
      { checksums: [""] },
      {},
    ]) {
      const data = gzipSync(
        JSON.stringify({ version: "2", files: [{ ...map, ...diff }] }),
      );
      assert.throws(() => verifyBlockmap(path.basename(file), file, data));
    }
    writeFileSync(file + ".blockmap", "bad gzip");
    await assert.rejects(img.verify());
    writeFileSync(file + ".blockmap", good);
  }
  const resources = path.join(img.mount, "Forma.app/Contents/Resources");
  writeFileSync(path.join(resources, "default_app.asar"), "extra");
  await assert.rejects(img.verify(), /default_app.asar/);
  unlinkSync(path.join(resources, "default_app.asar"));
  writeFileSync(path.join(resources, "LICENSE.electron.txt"), "");
  await assert.rejects(img.verify(), /notice/);
});
test("evidence publication keeps a concurrent receipt and checked replacement preserves a conflict", async (t) => {
  const img = await imageFixture(t);
  const receipt = put(img.root, img.evidenceOut, "initial");
  img.onImport(() => writeFileSync(receipt, "concurrent"));
  await assert.rejects(
    img.verify({ allowOverwriteEvidence: true }),
    /Concurrent edit/,
  );
  assert.equal(readFileSync(receipt, "utf8"), "concurrent");
  assert.throws(
    () => replaceCheckedFile(img.root, receipt, "replacement", undefined),
    /File exists/,
  );
  assert.equal(readFileSync(receipt, "utf8"), "concurrent");
});
test("absolute plans work and a symlinked plan ancestor is rejected", async (t) => {
  const root = fixture(t),
    file = put(root, "plans/input.json", "{}");
  assert.equal(cli(root, ["assess", "--plan", file, "--json"]).status, 0);
  symlinkSync("plans", path.join(root, "alias"));
  await assert.rejects(
    main(["assess", "--plan", path.join(root, "alias/input.json")], root),
    /regular/,
  );
});

test("standard 575-byte desktop:build manifest and full manifest share the same runtime contract", () => {
  const raw = `{
  "name": "design-platform",
  "version": "0.9.0",
  "description": "Forma — Web & 移动 H5 设计与 React/TypeScript 工程交付工作台",
  "author": "Forma Team",
  "private": true,
  "type": "module",
  "main": "electron/main.mjs",
  "dependencies": {
    "@embedpdf/pdfium": "2.15.1",
    "@modelcontextprotocol/server": "^2.4.0",
    "fflate": "^0.8.3",
    "fzstd": "0.1.1",
    "harfbuzzjs": "1.6.4",
    "lucide-react": "^0.468.0",
    "paper": "^0.17.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "svgpath": "^2.6.0",
    "zod": "^4.0.0"
  }
}`;
  assert.equal(Buffer.byteLength(raw), 575);
  const runtime = JSON.parse(raw);
  const full = JSON.stringify({
    ...runtime,
    scripts: { start: "electron ." },
    devDependencies: { electron: "45.4.1" },
    build: { appId: "com.forma.design" },
  });
  checkRuntimeManifest(full, raw);
  checkRuntimeManifest(full, full);
  const { dependencies, ...withoutDependencies } = runtime;
  assert.ok(dependencies);
  assert.throws(
    () => checkRuntimeManifest(full, JSON.stringify(withoutDependencies)),
    /dependencies/,
  );
  for (const key of [
    "main",
    "version",
    "type",
    "scripts",
    "build",
    "dependencies",
    "devDependencies",
    "extraHook",
  ])
    assert.throws(
      () =>
        checkRuntimeManifest(
          full,
          JSON.stringify({ ...runtime, [key]: "changed" }),
        ),
      /package.json/,
    );
});

test("an editor save during checked replacement retains the saved inode and contents", async (t) => {
  const root = fixture(t),
    target = path.join(root, "document");
  const original = "prior version";
  writeFileSync(target, original);
  const fifo = path.join(root, "approved-content");
  execFileSync("mkfifo", [fifo]);
  // The publisher cannot finish preparing its replacement until this writer
  // supplies the bytes. This orders the editor save between snapshot and swap.
  const child = spawn(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `
    const fs=require("node:fs"),fd=fs.openSync("approved-content","w");
    const until=Date.now()+10000;
    const poll=setInterval(()=>{
      if(Date.now()>until) process.exit(2);
      const dir="output/release-state/displaced";
      if(!fs.existsSync(dir) || !fs.readdirSync(dir).some(n=>fs.existsSync(dir+"/"+n+"/.prepared"))) return;
      clearInterval(poll);
      fs.writeFileSync("editor-save","saved by editor");
      fs.renameSync("editor-save","document");
      fs.writeSync(fd,"release bytes");
      fs.closeSync(fd);
    },5);
  `,
    ],
    { cwd: root, stdio: "ignore" },
  );
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const fd = openSync(fifo, "r");
  try {
    assert.throws(
      () =>
        replaceCheckedFile(
          root,
          target,
          { fd, sha256: sha("release bytes") },
          sha(original),
        ),
      /Concurrent edit/,
    );
    assert.equal(await done, 0);
    assert.equal(readFileSync(target, "utf8"), "saved by editor");
  } finally {
    closeSync(fd);
    child.kill();
  }
});

test("receipt publication detects a replaced evidence parent even when the old digest matches", async (t) => {
  const img = await imageFixture(t);
  const file = put(img.root, img.evidenceOut, "previous"),
    parent = path.dirname(file);
  img.onImport(() => {
    renameSync(parent, parent + "-moved");
    put(img.root, img.evidenceOut, "previous");
  });
  await assert.rejects(
    img.verify({ allowOverwriteEvidence: true }),
    /parent directory replacement/,
  );
  assert.equal(readFileSync(file, "utf8"), "previous");
  assert.equal(
    readFileSync(path.join(parent + "-moved", path.basename(file)), "utf8"),
    "previous",
  );
});

test("the mounted copy stays authenticated across a delivery rename; a changed delivery gets no receipt", async (t) => {
  const img = await imageFixture(t);
  await assert.rejects(
    img.verify({
      execFile: (program, args, opts) => {
        if (program === "/usr/bin/hdiutil" && args[0] === "attach") {
          renameSync(put(img.root, "incoming", "other bytes"), img.dmg);
          assert.equal(readFileSync(args.at(-1)!, "utf8"), "image");
        }
        return img.execFile(program, args, opts);
      },
    }),
    /Artifact changed/,
  );
  assert.ok(!existsSync(path.join(img.root, img.evidenceOut)));
});

test("every staged blockmap must still have the digest in the verifier receipt", async (t) => {
  const f = releaseFixture(t);
  for (const ext of [".dmg.blockmap", ".zip.blockmap"]) {
    await assert.rejects(
      f.run(f.args, async (options) => {
        const report = await f.verify(options);
        writeFileSync(options.dmgPath!.replace(/\.dmg$/, ext), "later build");
        return report;
      }),
      /Staged artifact changed/,
    );
    await f.run(["run", "--rollback", "--json"]);
    assert.ok(!existsSync(path.join(f.root, "release/Forma-0.10.0-arm64.dmg")));
  }
});

test("an open changelog descriptor can finish an in-place save after metadata exchange", async (t) => {
  const f = releaseFixture(t);
  const file = path.join(f.root, "docs/CHANGELOG.md");
  const originalInode = statSync(file).ino,
    fd = openSync(file, "r+");
  const edit = "completed editor save";
  try {
    await assert.rejects(
      f.run(f.args, async (opts) => {
        assert.notEqual(statSync(file).ino, originalInode);
        ftruncateSync(fd, 0);
        writeSync(fd, edit, 0, "utf8");
        return f.verify(opts);
      }),
      /Concurrent edit preserved/,
    );
  } finally {
    closeSync(fd);
  }
  const conflicts = path.join(f.root, "output/release-state/conflicts");
  const saved = readdirSync(conflicts)
    .map((n) => path.join(conflicts, n))
    .find((p) => statSync(p).ino === originalInode);
  assert.ok(saved);
  assert.equal(readFileSync(saved, "utf8"), edit);
  await f.run(["run", "--rollback", "--json"]);
  assert.equal(readFileSync(saved, "utf8"), edit);
  assert.equal(readFileSync(file, "utf8"), md);
});

test("only the explicitly selected completed initiative ships during finalization", async (t) => {
  const f = releaseFixture(t);
  for (const id of ["first", "second", "draft"])
    put(
      f.root,
      "docs/initiatives/" + id + "/PRD.md",
      "# Initiative\n- **状态**：" + (id === "draft" ? "草案" : "已实施并验收"),
    );
  const ids = ["first", "second"].map((id) => "docs/initiatives/" + id);
  const plan = put(
    f.root,
    "plan.json",
    JSON.stringify({ initiatives: ["second"] }),
  );
  for (const id of ["draft", "missing"])
    await assert.rejects(
      f.run([...f.args, "--initiative-id", id]),
      /Unknown or already shipped/,
    );
  const result = await f.run([
    ...f.args,
    "--plan",
    plan,
    "--initiative-id",
    "first",
  ]);
  assert.deepEqual(result.decision.shippedInitiatives, [ids[0]]);
  assert.deepEqual(
    readReleaseManifest(f.root).lastRelease?.shippedInitiatives,
    [ids[0]],
  );
  assert.deepEqual(
    detectWorkspaceChanges(f.root).unshippedCompletedInitiatives,
    [ids[1]],
  );
  assert.deepEqual(
    JSON.parse(cli(f.root, ["assess", "--plan", plan, "--json"]).stdout)
      .shippedInitiatives,
    [ids[1]],
  );
  assert.deepEqual(
    JSON.parse(cli(f.root, ["assess", "--json"]).stdout).shippedInitiatives,
    [],
  );
});

test("Git bootstrap uses the supplied date in a clean final checkout with a historical DMG", async (t) => {
  const f = releaseFixture(t);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: f.root, encoding: "utf8" });
  git("init", "-q");
  put(f.root, ".gitignore", "/node_modules/\n/output/\n/release/\n");
  put(f.root, "release/Forma-0.9.0-arm64.dmg", "historical", 1);
  git("add", ".");
  git(
    "-c",
    "user.name=Tests",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "base",
  );
  const dirty = put(f.root, "docs/unrelated.md", "dirty");
  const diff = detectWorkspaceChanges(f.root);
  assert.ok(diff.incompleteAssessment);
  assert.match(diff.warnings.join(" "), /--since/);
  unlinkSync(dirty);
  assert.equal(git("status", "--porcelain"), "");
  const since = [
    "--since",
    "2099-01-01",
    "--significance",
    "bugfix",
    "--summary",
    "fix",
    "--json",
  ];
  const assessed = JSON.parse(cli(f.root, ["assess", ...since]).stdout);
  assert.deepEqual(assessed.workspace.changedFiles, []);
  assert.equal(assessed.workspace.incompleteAssessment, false);
  assert.equal(
    (await f.run(["run", ...since])).decision.recommendedBump,
    "patch",
  );
});

test("a transient edit in the live workspace never enters compilation or the promoted artifact", async (t) => {
  const f = releaseFixture(t);
  const live = put(f.root, "src/editor/input.ts", "assessed bytes");
  const npm = path.join(f.root, "node_modules/.bin/npm");
  const gate = readFileSync(npm, "utf8").replace(
    'if(gate==="build"){',
    'if(gate==="build"){fs.writeFileSync(' +
      JSON.stringify(live) +
      ',"transient bytes");',
  );
  writeFileSync(
    npm,
    gate +
      '\nif(gate==="build")fs.writeFileSync(' +
      JSON.stringify(live) +
      ',"assessed bytes");',
  );
  const builder = path.join(f.root, "node_modules/.bin/electron-builder");
  writeFileSync(
    builder,
    readFileSync(builder, "utf8") +
      '\nfs.copyFileSync("dist/index.html",path.join(dir,"Forma-"+v+"-arm64.dmg"));',
  );
  await f.run(f.args, async (opts) => {
    assert.equal(opts.requireAdhocSignature, true);
    assert.equal(
      opts.referenceRoot,
      path.join(path.dirname(opts.dmgPath!), "checkout"),
    );
    const tx = JSON.parse(
      readFileSync(path.join(f.root, "output/release-state/tx.json"), "utf8"),
    );
    assert.deepEqual(opts.pinnedOutputHashes, tx.buildOutputHashes);
    assert.equal(
      opts.pinnedOutputHashes?.["dist/index.html"],
      sha("assessed bytes"),
    );
    assert.equal(readFileSync(opts.dmgPath!, "utf8"), "assessed bytes");
    const evidence = await f.verify(opts);
    evidence.distribution[0].sha256 = sha("assessed bytes");
    evidence.distribution[0].bytes = 14;
    return evidence;
  });
  assert.equal(
    readFileSync(path.join(f.root, "release/Forma-0.10.0-arm64.dmg"), "utf8"),
    "assessed bytes",
  );
  assert.equal(readFileSync(live, "utf8"), "assessed bytes");
});

test("changing a pinned web or service output during packaging stops verification and promotion", async (t) => {
  for (const file of ["dist/index.html", "out-electron/agent-service.mjs"]) {
    const f = releaseFixture(t);
    const builder = path.join(f.root, "node_modules/.bin/electron-builder");
    writeFileSync(
      builder,
      readFileSync(builder, "utf8") +
        "\nfs.writeFileSync(" +
        JSON.stringify(file) +
        ',"drift");',
    );
    await assert.rejects(
      f.run(f.args, async () => {
        throw Error("unexpected verifier call");
      }),
      /pinned compilation/,
    );
    assert.ok(!existsSync(path.join(f.root, "release/Forma-0.10.0-arm64.dmg")));
    await f.run(["run", "--rollback", "--json"]);
  }
});

test("an Electron upgrade, desktop compiler change or runtime lock resolution invalidates the desktop package", (t) => {
  const root = fixture(t);
  const pkg = {
    version: currentVersion,
    dependencies: { example: "^1" },
    devDependencies: { electron: "45.4.1" },
    scripts: { "desktop:agent": "compile" },
  };
  const lock = {
    version: currentVersion,
    packages: {
      "": { version: currentVersion },
      "node_modules/electron": {
        version: "45.4.1",
        integrity: "old",
        dev: true,
      },
      "node_modules/scheduler": { version: "0.27.0", resolved: "old" },
      "node_modules/electron/node_modules/example": { version: "1", dev: true },
      "node_modules/prettier": { version: "1", dev: true },
      "node_modules/example": { version: "1.0.0", resolved: "old" },
    },
  };
  const baseline = () => {
    put(root, "package.json", JSON.stringify(pkg));
    put(root, "package-lock.json", JSON.stringify(lock));
  };
  baseline();
  const shipped = {
    version: currentVersion,
    date: entry.date,
    sourceHashes: sourceHashes(root),
    packagePackagingSha256: packagePackagingHash(
      JSON.stringify(pkg),
      JSON.stringify(lock),
    ),
  };
  assert.match(shipped.packagePackagingSha256, /^v2:[a-f0-9]{64}$/);
  const storeFingerprint = (packagePackagingSha256: string) =>
    writeReleaseManifest(root, {
      schemaVersion: 1,
      lastRelease: {
        ...shipped,
        packagePackagingSha256,
        shippedInitiatives: [],
      },
      lastDesktopRelease: {
        ...shipped,
        packagePackagingSha256,
        dmgFilename: "a",
        zipFilename: "b",
        dmgSha256: sha("a"),
        zipSha256: sha("b"),
      },
    });
  storeFingerprint(shipped.packagePackagingSha256);
  for (const change of [
    "electron",
    "script",
    "resolution",
    "integrity",
    "transitive",
    "electron-subpackage",
    "dev-only",
  ]) {
    baseline();
    if (change === "electron") {
      put(
        root,
        "package.json",
        JSON.stringify({ ...pkg, devDependencies: { electron: "45.4.2" } }),
      );
      put(
        root,
        "package-lock.json",
        JSON.stringify({
          ...lock,
          packages: {
            ...lock.packages,
            "node_modules/electron": { version: "45.4.2", integrity: "new" },
          },
        }),
      );
    } else if (change === "script") {
      put(
        root,
        "package.json",
        JSON.stringify({ ...pkg, scripts: { "desktop:agent": "compile new" } }),
      );
    } else {
      const next = structuredClone(lock);
      if (change === "resolution")
        next.packages["node_modules/example"].resolved = "new";
      else if (change === "transitive")
        next.packages["node_modules/scheduler"].resolved = "new";
      else if (change === "electron-subpackage")
        next.packages["node_modules/electron/node_modules/example"].version =
          "2";
      else if (change === "dev-only")
        next.packages["node_modules/prettier"].version = "2";
      else next.packages["node_modules/electron"].integrity = "new";
      put(root, "package-lock.json", JSON.stringify(next));
    }
    const assessment = JSON.parse(cli(root, ["assess", "--json"]).stdout);
    if (change === "dev-only") {
      assert.equal(assessment.bump, "none");
      assert.equal(verifyReleaseMetadataSync(root).staleDesktopPackage, false);
      continue;
    }
    assert.deepEqual(
      [assessment.bump, assessment.packageDesktop, assessment.coreSubsystems],
      ["patch", true, ["electron"]],
    );
    const sync = verifyReleaseMetadataSync(root);
    assert.ok(sync.ok && sync.staleDesktopPackage);
    assert.equal(sync.staleRuntimeFileCount, change === "electron" ? 2 : 1);
  }
  // Digest emitted by the original direct-dependency implementation for this fixture.
  storeFingerprint(
    "02986218cf71bbee94a7128ae332c4ee43f61d9bae29648db39a2f5eed2e8081",
  );
  const legacyLock = structuredClone(lock);
  legacyLock.packages["node_modules/prettier"].version = "2";
  put(root, "package-lock.json", JSON.stringify(legacyLock));
  const assess = JSON.parse(cli(root, ["assess", "--json"]).stdout);
  const sync = verifyReleaseMetadataSync(root);
  assert.ok(sync.ok, sync.errors.join("\n"));
  assert.deepEqual(
    [assess.bump, assess.packageDesktop, sync.staleDesktopPackage],
    ["none", false, false],
  );
});

test("resume and rollback reconcile an interrupted sibling exchange by inode before source validation", async (t) => {
  for (const recovery of ["--resume", "--rollback"]) {
    const f = releaseFixture(t);
    const fail = put(f.root, "fail-builder", "1");
    await assert.rejects(f.run(f.args), /electron-builder/);
    const journal = JSON.parse(
      readFileSync(path.join(f.root, "output/release-state/tx.json"), "utf8"),
    );
    const record = journal.pendingTempFiles.find(
      (r: { target: string }) => r.target === "src/editor/release-notes.ts",
    );
    const sibling = path.join(f.root, record.tempPath);
    const displaced = path.join(
      f.root,
      "output/release-state/displaced",
      record.token,
      "release-notes.ts",
    );
    linkSync(displaced, sibling); // Crash after exchange, before unlinking the displaced sibling.
    assert.ok(Object.hasOwn(sourceHashes(f.root), record.tempPath));
    unlinkSync(fail);
    await f.run(["run", recovery, "--json"]);
    assert.ok(!existsSync(sibling));
    assert.equal(
      verifyReleaseMetadataSync(f.root).packageVersion,
      recovery === "--resume" ? "0.10.0" : currentVersion,
    );
  }
});

test("the repository gitignore keeps release implementation and excludes generated release paths", (t) => {
  const root = temporary(t);
  execFileSync("git", ["init", "-q"], { cwd: root });
  cpSync(
    new URL("../.gitignore", import.meta.url),
    path.join(root, ".gitignore"),
  );
  for (const [name, status] of [
    ["scripts/release/pipeline.ts", 1],
    ["release/Forma-0.10.0-arm64.dmg", 0],
    ["dist/index.html", 0],
    ["output/release-state/tx.json", 0],
    ["src/editor/.release-tmp", 0],
  ] as const) {
    assert.equal(
      spawnSync("git", ["check-ignore", "--no-index", "-q", "--", name], {
        cwd: root,
      }).status,
      status,
      name,
    );
  }
});

test("local bundle mismatch and invalid archive declarations fail before extraction", async (t) => {
  const img = await imageFixture(t);
  const bundle = path.join(img.mount, "Forma.app");
  cpSync(bundle, path.join(img.root, "release/mac-arm64/Forma.app"), {
    recursive: true,
  });
  const archive = path.join(bundle, "Contents/Resources/app.asar");
  writeFileSync(archive, "untrusted");
  await assert.rejects(
    img.verify({ expectedDmgSha256: undefined }),
    /differs from local build/,
  );
  assert.ok(!img.calls.some((c) => c.args[1] === "extract"));
  function header(files: object) {
    const json = Buffer.from(JSON.stringify({ files }));
    const len = 8 + Math.ceil(json.length / 4) * 4;
    const bytes = Buffer.alloc(8 + len);
    [4, len, len - 4, json.length].forEach((n, i) =>
      bytes.writeUInt32LE(n, i * 4),
    );
    json.copy(bytes, 16);
    writeFileSync(archive, bytes);
  }
  for (const files of [
    { "..": { files: {} } },
    { nested: { files: { "../outside": { size: 0, offset: "0" } } } },
    { bad: { size: -1, offset: "0" } },
    { bad: { size: "NaN", offset: "0" } },
    { bad: { size: 512 * 1024 ** 2 + 1, offset: "0" } },
    Object.fromEntries(
      Array.from({ length: 20001 }, (_, i) => [
        String(i),
        { size: 0, offset: "0" },
      ]),
    ),
  ]) {
    header(files);
    assert.throws(() => validateAsarHeader(archive), /ASAR/);
  }
  await assert.rejects(img.verify(), /ASAR/);
  assert.ok(!img.calls.some((c) => c.args[1] === "extract"));
});

test("ZIP files and directories must match all nine DMG permission bits", async (t) => {
  const img = await imageFixture(t);
  for (const relative of [
    "Forma.app/Contents/MacOS/Forma",
    "Forma.app/Contents/MacOS",
  ]) {
    chmodSync(path.join(img.mount, relative), 0o755);
    await assert.rejects(
      img.verify({
        execFile(prog, args, opts) {
          const out = img.execFile(prog, args, opts);
          if (prog === "/usr/bin/ditto")
            chmodSync(path.join(args[2], relative), 0o777);
          return out;
        },
      }),
      /ZIP differs/,
    );
    chmodSync(
      path.join(img.mount, relative),
      relative.endsWith("Forma") ? 0o644 : 0o755,
    );
  }
});

test("governed verification rejects a valid Developer ID signature", async (t) => {
  const img = await imageFixture(t);
  await assert.rejects(
    img.verify({
      requireAdhocSignature: true,
      execFile(prog, args, opts) {
        if (prog === "/usr/bin/codesign" && args[0] === "-dvv")
          return "Identifier=com.forma.design\nAuthority=Developer ID Application: Fixture\n";
        return img.execFile(prog, args, opts);
      },
    }),
    /ad-hoc/,
  );
  assert.ok(!img.calls.some((c) => c.args[1] === "extract"));
});

test("mount recovery terminates the journaled inner Electron after its helper exits", (t) => {
  const root = temporary(t);
  const ownedDmg = put(
    root,
    "output/release-state/verifier-orphan/verified.dmg",
    "image",
  );
  const work = path.dirname(ownedDmg),
    marker = "output/release-state/active-mount.json";
  put(
    root,
    marker,
    JSON.stringify({
      ownedDmg,
      owner: process.pid,
      helperPids: [91001, 91004],
      electronPids: [91002],
    }),
  );
  put(work, "import-electron.pid", "91003");
  const alive = new Set([91002, 91003, 91004]);
  let attached = true;
  reconcileActiveMount(root, (prog, args) => {
    if (prog === "/usr/bin/plutil")
      return JSON.stringify({
        images: attached
          ? [
              {
                "image-path": ownedDmg,
                "system-entities": [
                  {
                    "dev-entry": "/dev/disk77",
                    "mount-point": "/Volumes/fixture",
                  },
                ],
              },
            ]
          : [],
      });
    if (prog === "/bin/ps")
      return [...alive]
        .map((pid) =>
          pid === 91004
            ? pid +
              " S node scripts/check-design-import-desktop.mjs --verifier-pid-file=" +
              path.join(work, "import-electron.pid")
            : pid +
              " S /Volumes/fixture/Forma.app/Contents/MacOS/Forma --user-data-dir=" +
              work +
              "/profile",
        )
        .join("\n");
    if (prog === "/bin/kill") {
      assert.deepEqual(
        JSON.parse(readFileSync(path.join(root, marker), "utf8")).electronPids,
        [91002, 91003],
      );
      alive.delete(Number(args[1]));
    }
    if (args[0] === "detach") {
      assert.equal(alive.size, 0);
      attached = false;
    }
    return "";
  });
  assert.ok(!attached && !existsSync(path.join(root, marker)));
});

test("the assessed significance also governs finalization across a large change", async (t) => {
  const f = releaseFixture(t);
  for (const file of large) put(f.root, file, "source");
  for (const [significance, tier] of [
    ["internal-refactor", "none"],
    ["bugfix", "patch"],
  ]) {
    const flags = [
      "--significance",
      significance,
      "--summary",
      "classified change",
      "--json",
    ];
    const assessment = JSON.parse(cli(f.root, ["assess", ...flags]).stdout);
    assert.equal(assessment.recommendedBump, tier);
    const run = await f.run(["run", ...flags]);
    assert.equal((run.decision ?? run).recommendedBump, tier);
  }
  await assert.rejects(
    f.run(["run", "--significance", "major-feature", "--bump", "patch"]),
    /at least minor/,
  );
});

test("governed builds preflight dotenv, Electron, dmgbuild and 7zip before metadata mutation", async (t) => {
  const f = releaseFixture(t),
    before = snapshot(f.root);
  const cache = temporary(t);
  const previousCache = process.env.ELECTRON_BUILDER_CACHE;
  const mirrorKey = "NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR";
  const previousMirror = process.env[mirrorKey];
  process.env[mirrorKey] =
    "https://github.com/electron-userland/electron-builder-binaries/releases/download/";
  const custom = process.env.CUSTOM_DMGBUILD_PATH;
  const previous7zip = process.env.ELECTRON_BUILDER_7ZIP_PATH;
  process.env.ELECTRON_BUILDER_CACHE = cache;
  delete process.env.CUSTOM_DMGBUILD_PATH;
  delete process.env.ELECTRON_BUILDER_7ZIP_PATH;
  t.after(() => {
    if (previous7zip === undefined)
      delete process.env.ELECTRON_BUILDER_7ZIP_PATH;
    else process.env.ELECTRON_BUILDER_7ZIP_PATH = previous7zip;
    if (previousCache === undefined) delete process.env.ELECTRON_BUILDER_CACHE;
    else process.env.ELECTRON_BUILDER_CACHE = previousCache;
    if (custom !== undefined) process.env.CUSTOM_DMGBUILD_PATH = custom;
    if (previousMirror === undefined) delete process.env[mirrorKey];
    else process.env[mirrorKey] = previousMirror;
  });
  const forbidden = put(f.root, "electron-builder.env", "FOO=bar");
  await assert.rejects(f.run(f.args, f.verify, false), /electron-builder.env/);
  assert.deepEqual(snapshot(f.root), before);
  unlinkSync(forbidden);
  const name = "electron-v45.4.1-darwin-arm64.zip";
  unlinkSync(path.join(f.env.ELECTRON_CACHE, name));
  await assert.rejects(
    f.run(f.args, f.verify, false),
    /Missing cached Electron distribution.*electron-v45.4.1-darwin-arm64.zip/,
  );
  assert.deepEqual(snapshot(f.root), before);
  assert.ok(!existsSync(path.join(f.root, "output/release-state/tx.json")));
  put(f.env.ELECTRON_CACHE, path.join("a".repeat(64), name), "cached Electron");
  const arm = process.arch === "arm64";
  const bundle = "dmgbuild-bundle-" + (arm ? "arm64" : "x86_64") + "-75c8a6c";
  const release = "dmg-builder@1.2.5";
  const archive = path.join(cache, release, bundle + ".tar.gz");
  await assert.rejects(f.run(f.args, f.verify, false), (err: Error) =>
    err.message.includes(archive),
  );
  assert.deepEqual(snapshot(f.root), before);
  assert.equal(
    readFileSync(path.join(f.root, "package-lock.json"), "utf8"),
    f.lock,
  );
  assert.deepEqual(readdirSync(path.join(f.root, "output/release-state")), []);
  const extracted = path.join(
    release,
    bundle + "-" + (arm ? "9epj3" : "c07gq"),
  );
  chmodSync(put(cache, path.join(extracted, "dmgbuild"), "cached tool"), 0o755);
  put(
    cache,
    extracted + ".state",
    JSON.stringify({ version: 1, state: "complete", fileCount: 1 }),
  );
  const sevenZip = "7zip@1.0.0/7zip-darwin-" + (arm ? "arm64" : "x86_64");
  const sevenExtracted = sevenZip + "-" + (arm ? "fti70" : "1r6y4");
  const metadataIdentity = () =>
    [...metadata, "package-lock.json"].map((name) => {
      const st = statSync(path.join(f.root, name), { bigint: true });
      return [st.ino, st.ctimeNs];
    });
  const unchanged = metadataIdentity();
  const rejectColdCache = async () => {
    await assert.rejects(
      f.run(f.args, f.verify, false),
      (err: Error) =>
        err.message.includes(path.join(cache, sevenZip + ".tar.gz")) &&
        err.message.includes("--allow-electron-download"),
    );
    assert.deepEqual(metadataIdentity(), unchanged);
    assert.deepEqual(
      readdirSync(path.join(f.root, "output/release-state")),
      [],
    );
  };
  await rejectColdCache();
  put(cache, sevenZip + ".tar.gz", "invalid archive");
  put(cache, path.join(sevenExtracted, "bin/7za"), "cached 7za");
  put(
    cache,
    sevenExtracted + ".state",
    JSON.stringify({ version: 1, state: "complete", fileCount: 2 }),
  );
  await rejectColdCache();
  process.env.ELECTRON_BUILDER_7ZIP_PATH = cache;
  await assert.rejects(
    f.run([...f.args, "--allow-electron-download"], f.verify, false),
    /ELECTRON_BUILDER_7ZIP_PATH/,
  );
  assert.deepEqual(metadataIdentity(), unchanged);
  const custom7za = put(cache, "custom/7za", "custom executable");
  process.env.ELECTRON_BUILDER_7ZIP_PATH = custom7za;
  await assert.rejects(
    f.run(f.args, f.verify, false),
    /ELECTRON_BUILDER_7ZIP_PATH/,
  );
  assert.deepEqual(metadataIdentity(), unchanged);
  chmodSync(custom7za, 0o755);
  const stopBuilder = put(f.root, "fail-builder", "1");
  await assert.rejects(
    f.run(f.args, f.verify, false),
    /electron-builder exited/,
  );
  delete process.env.ELECTRON_BUILDER_7ZIP_PATH;
  unlinkSync(stopBuilder);
  await assert.rejects(
    f.run(["run", "--resume", "--json"], f.verify, false),
    /7zip@1\.0\.0.*--allow-electron-download/,
  );
  assert.deepEqual(snapshot(f.root), before);
  put(
    cache,
    sevenExtracted + ".state",
    JSON.stringify({ version: 1, state: "complete", fileCount: 1 }),
  );
  await f.run(f.args, f.verify, false);
  assert.equal(readReleaseManifest(f.root).lastRelease?.version, "0.10.0");
});

test("recovery preserves a foreign sibling inode and accepts a later rollback", async (t) => {
  const f = releaseFixture(t);
  put(f.root, "fail-builder", "1");
  await assert.rejects(f.run(f.args), /electron-builder/);
  const tx = JSON.parse(
    readFileSync(path.join(f.root, "output/release-state/tx.json"), "utf8"),
  );
  const entry = tx.pendingTempFiles.find(
    (r: { target: string }) => r.target === "docs/CHANGELOG.md",
  );
  const sibling = put(f.root, entry.tempPath, "editor-owned temporary file");
  const inode = statSync(sibling).ino;
  await assert.rejects(
    f.run(["run", "--rollback"]),
    /Concurrent publication temp preserved/,
  );
  assert.equal(statSync(sibling).ino, inode);
  const conflicts = path.join(f.root, "output/release-state/conflicts");
  assert.ok(
    readdirSync(conflicts).some(
      (name) => statSync(path.join(conflicts, name)).ino === inode,
    ),
  );
  renameSync(sibling, path.join(f.root, "saved-editor-temp"));
  await f.run(["run", "--rollback", "--json"]);
  assert.equal(
    verifyReleaseMetadataSync(f.root).packageVersion,
    currentVersion,
  );
});

test("a receipt compares packaged bytes directly to persisted compiler pins", async (t) => {
  const img = await imageFixture(t);
  const pins = await outputHashes(img.root);
  const file = "dist/assets/ui.js";
  const archive = path.join(img.mount, "Forma.app/Contents/Resources/app.asar");
  put(img.root, path.join("payload", file), "changed only in package");
  const asar = fileURLToPath(
    new URL("../node_modules/@electron/asar/bin/asar.js", import.meta.url),
  );
  execFileSync(process.execPath, [
    asar,
    "pack",
    path.join(img.root, "payload"),
    archive,
  ]);
  await assert.rejects(
    img.verify({ referenceRoot: img.root, pinnedOutputHashes: pins }),
    /dist\/assets\/ui.js/,
  );
  assert.ok(!existsSync(path.join(img.root, img.evidenceOut)));
});

test("bare --initiative ships a minor without consuming unchanged completed initiatives", async (t) => {
  const f = releaseFixture(t);
  const dir = "docs/initiatives/next-milestone";
  put(f.root, dir + "/PRD.md", "# Next\n- **状态**：已实施并验收");
  writeReleaseManifest(f.root, {
    schemaVersion: 1,
    lastRelease: {
      version: currentVersion,
      date: entry.date,
      sourceHashes: sourceHashes(f.root),
      shippedInitiatives: [],
    },
  });
  const args = [
    "--initiative",
    "--title",
    "Unnamed milestone",
    "--summary",
    "Completed",
    "--json",
  ];
  const assess = await f.run(["assess", ...args]);
  assert.deepEqual(assess.workspace.changedFiles, []);
  assert.deepEqual([assess.bump, assess.shippedInitiatives], ["minor", []]);
  const result = await f.run(["run", ...args]);
  assert.deepEqual(
    [result.decision.bump, result.decision.shippedInitiatives],
    ["minor", []],
  );
  assert.deepEqual(
    readReleaseManifest(f.root).lastRelease?.shippedInitiatives,
    [],
  );
  const next = await f.run(["assess", "--initiative", dir, "--json"]);
  assert.deepEqual(next.shippedInitiatives, [dir]);
});

test("Git keeps an unscanned edit alongside an already-shipped tracked deletion", async (t) => {
  const f = releaseFixture(t);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: f.root, encoding: "utf8" });
  git("init", "-q");
  put(f.root, ".gitignore", "node_modules/\noutput/\nrelease/\n");
  const name = "src/editor/removed.ts";
  const removed = put(f.root, name, "before deletion");
  put(f.root, ".env.example", "SETTING=initial\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "baseline",
  );
  unlinkSync(removed);
  const args = ["--since", "2099-01-01"];
  assert.deepEqual(
    (await f.run(["assess", ...args, "--json"])).workspace.changedFiles,
    [name],
  );
  await f.run(["run", ...args, "--summary", "Remove old layer", "--json"]);
  assert.equal(
    Object.hasOwn(readReleaseManifest(f.root).lastRelease!.sourceHashes, name),
    false,
  );
  assert.match(
    git("status", "--porcelain", "--", name),
    / D src\/editor\/removed.ts/,
  );
  const next = await f.run(["assess", "--json"]);
  assert.equal(next.workspace.source, "git");
  assert.deepEqual(next.workspace.changedFiles, []);
  assert.equal(next.bump, "none");
  put(f.root, ".env.example", "SETTING=updated\n");
  assert.match(
    git("status", "--porcelain", "--", ".env.example"),
    / M \.env\.example/,
  );
  assert.deepEqual((await f.run(["assess", "--json"])).workspace.changedFiles, [
    ".env.example",
  ]);
});

test("pre-promotion resume rebuilds clean outputs using the original private compiler", async (t) => {
  const f = releaseFixture(t);
  const dependency = "node_modules/compiler/input";
  put(f.root, dependency, "original compiler");
  const npm = path.join(f.root, "node_modules/.bin/npm");
  writeFileSync(
    npm,
    readFileSync(npm, "utf8") +
      '\nif (gate === "build") fs.copyFileSync("node_modules/compiler/input", "dist/index.html");',
  );
  const fail = put(f.root, "fail-builder", "1");
  await assert.rejects(f.run(f.args), /electron-builder/);
  const checkout = JSON.parse(
    readFileSync(path.join(f.root, "builder-call.json"), "utf8"),
  ).cwd;
  const inode = statSync(path.join(checkout, dependency)).ino;
  put(f.root, dependency, "changed before resume");
  put(checkout, "dist/stale", "old output");
  put(checkout, "out-electron/stale", "old service");
  put(checkout, "electron/main.mjs", "stale source");
  unlinkSync(fail);
  await f.run(["run", "--resume", "--json"], async (opts) => {
    assert.equal(opts.referenceRoot, checkout);
    assert.equal(statSync(path.join(checkout, dependency)).ino, inode);
    assert.equal(
      readFileSync(path.join(checkout, "dist/index.html"), "utf8"),
      "original compiler",
    );
    assert.equal(
      readFileSync(path.join(checkout, "electron/main.mjs"), "utf8"),
      "main",
    );
    for (const dir of ["dist", "out-electron"])
      assert.ok(!existsSync(path.join(checkout, dir, "stale")));
    return f.verify(opts);
  });
});

test("pre-promotion resume requires the original dependency directory and permits rollback", async (t) => {
  const f = releaseFixture(t);
  const before = snapshot(f.root);
  put(f.root, "fail-builder", "1");
  await assert.rejects(f.run(f.args), /electron-builder/);
  const checkout = JSON.parse(
    readFileSync(path.join(f.root, "builder-call.json"), "utf8"),
  ).cwd;
  const modules = path.join(checkout, "node_modules");
  rmSync(modules, { recursive: true });
  const resume = () =>
    assert.rejects(
      f.run(["run", "--resume"]),
      /checkout\/node_modules.*--rollback.*assess/i,
    );
  await resume();
  symlinkSync(path.join(f.root, "node_modules"), modules);
  await resume();
  await f.run(["run", "--rollback", "--json"]);
  assert.deepEqual(snapshot(f.root), before);
});

test("private build uses an independent node_modules tree while the live dependency is being rewritten", async (t) => {
  const f = releaseFixture(t);
  const dep = "node_modules/compiler/build-input";
  const original = put(f.root, dep, "original compiler");
  symlinkSync(original, path.join(f.root, dep + "-absolute"));
  const npm = path.join(f.root, "node_modules/.bin/npm");
  writeFileSync(
    npm,
    readFileSync(npm, "utf8") +
      '\nif(gate==="build"){fs.writeFileSync(' +
      JSON.stringify(original) +
      ',"live replacement");fs.copyFileSync(' +
      JSON.stringify(dep) +
      ',"dist/index.html");}',
  );
  let checkout: string;
  await f.run(f.args, async (opts) => {
    checkout = opts.referenceRoot!;
    const modules = lstatSync(path.join(checkout, "node_modules"));
    assert.ok(modules.isDirectory() && !modules.isSymbolicLink());
    assert.notEqual(
      statSync(original).ino,
      statSync(path.join(checkout, dep)).ino,
    );
    assert.equal(readFileSync(original, "utf8"), "live replacement");
    assert.equal(
      realpathSync(path.join(checkout, dep + "-absolute")),
      path.join(checkout, dep),
    );
    assert.equal(
      readFileSync(path.join(checkout, "dist/index.html"), "utf8"),
      "original compiler",
    );
    return f.verify(opts);
  });
  assert.equal(existsSync(checkout!), false);
});

test("rollback restores an approved replacement from independent bytes and preserves a late write through its displaced inode", async (t) => {
  const f = releaseFixture(t);
  const zip = "Forma-0.10.0-arm64.zip";
  const target = put(f.root, "release/" + zip, "pre-release ZIP");
  const originalInode = statSync(target).ino;
  const fd = openSync(target, "r+");
  try {
    await assert.rejects(
      f.run([...f.args, "--allow-repackage"], async (opts) => {
        const evidence = await f.verify(opts);
        // Stop after publishing the artifacts but before committing the manifest.
        put(
          f.root,
          "docs/evidence/release-manifest.json",
          '{"schemaVersion":1}',
        );
        return evidence;
      }),
      /manifest changed concurrently/,
    );
    const state = path.join(f.root, "output/release-state");
    const tx = JSON.parse(readFileSync(path.join(state, "tx.json"), "utf8"));
    const backup = path.join(
      state,
      "backups",
      path.basename(tx.stagingDir),
      zip,
    );
    const record = tx.pendingTempFiles.find(
      (p: { target: string }) => p.target === "release/" + zip,
    );
    assert.equal(
      statSync(path.join(state, "displaced", record.token, zip)).ino,
      originalInode,
    );
    assert.notEqual(statSync(backup).ino, originalInode);
    const promotion = tx.promotions.find(
      (p: { name: string }) => p.name === zip,
    );
    assert.equal(path.join(f.root, promotion.backup), backup);
    assert.equal(promotion.previousHash, sha("pre-release ZIP"));
    assert.equal(readFileSync(target, "utf8"), ".zip");
    ftruncateSync(fd, 0);
    writeSync(fd, "late saved ZIP", 0, "utf8");
    assert.equal(readFileSync(backup, "utf8"), "pre-release ZIP");
    await f.run(["run", "--rollback", "--json"]);
    assert.equal(readFileSync(target, "utf8"), "pre-release ZIP");
    const conflicts = path.join(state, "conflicts");
    const saved = readdirSync(conflicts)
      .map((name) => path.join(conflicts, name))
      .find((file) => statSync(file).ino === originalInode);
    assert.ok(saved);
    assert.equal(readFileSync(saved, "utf8"), "late saved ZIP");
    assert.equal(existsSync(path.join(f.root, tx.stagingDir)), false);
    assert.equal(existsSync(path.join(state, "tx.json")), false);
  } finally {
    closeSync(fd);
  }
});

test("ZIP declarations and extracted files and directories preserve all special mode bits", async (t) => {
  const img = await imageFixture(t);
  const name = "Forma.app/Contents/MacOS/Forma";
  for (const [permissions, mode] of [
    ["-rwxr-xr-x", 0o755],
    ["-rwsr-xr-x", 0o4755],
    ["-rwSr-xr-x", 0o4655],
    ["-rwxr-sr-x", 0o2755],
    ["-rwxr-Sr-x", 0o2745],
    ["-rwxr-xr-t", 0o1755],
    ["-rwxr-xr-T", 0o1754],
  ] as const) {
    img.packZip(false, {}, mode);
    const listing = execFileSync("/usr/bin/zipinfo", ["-l", "-T", img.zip], {
      encoding: "utf8",
    });
    assert.ok(
      listing
        .split("\n")
        .some(
          (line) => line.startsWith(permissions) && line.endsWith(" " + name),
        ),
    );
    assert.equal(validateZipInventory(listing).get(name.toLowerCase()), mode);
  }
  img.packZip(false, {}, 0o4755);
  assert.deepEqual(
    Buffer.from(unzipSync(readFileSync(img.zip))[name]),
    readFileSync(img.binary),
  );
  chmodSync(img.binary, 0o755);
  await assert.rejects(
    img.verify({
      execFile(program, args, opts) {
        const out = img.execFile(program, args, opts);
        // Some extractors clear setuid. The original archive declaration still matters.
        if (program === "/usr/bin/ditto")
          chmodSync(path.join(args[2], name), 0o755);
        return out;
      },
    }),
    /ZIP differs from DMG/,
  );
  img.packZip(false, {}, 0o755);
  for (const file of [name, path.dirname(name)]) {
    await assert.rejects(
      img.verify({
        execFile(program, args, opts) {
          const out = img.execFile(program, args, opts);
          if (program === "/usr/bin/ditto") {
            chmodSync(path.join(args[2], name), 0o755);
            chmodSync(path.join(args[2], file), 0o1755);
          }
          return out;
        },
      }),
      /ZIP differs from DMG/,
    );
  }
});

test("standalone verification uses the promoted image's archived output hashes after checkout cleanup", async (t) => {
  const f = releaseFixture(t);
  let img!: Awaited<ReturnType<typeof imageFixture>>;
  let checkout!: string;
  await f.run(f.args, async (opts) => {
    checkout = opts.referenceRoot!;
    img = await imageFixture(t, opts);
    return img.verify(opts);
  });
  assert.equal(existsSync(checkout), false);
  const desktop = readReleaseManifest(f.root).lastDesktopRelease!;
  const pins = desktop.buildOutputHashes!;
  const runtimeManifest = JSON.stringify({ version: desktop.version });
  assert.deepEqual(pins, {
    "dist/index.html": sha("web"),
    "electron/main.mjs": sha("main"),
    "out-electron/agent-service.mjs": sha("desktop:agent"),
    "out-electron/library-service.mjs": sha("desktop:service"),
    "package.json": sha(runtimeManifest),
  });
  put(f.root, "dist/index.html", "obsolete live build");
  const standalone = () =>
    f.run(
      [
        "verify-dmg",
        "--evidence-out",
        "docs/evidence/trial/standalone.json",
        "--allow-overwrite-evidence",
        "--json",
      ],
      img.verify,
    );
  assert.equal(
    (await standalone()).matchingWebAndApp["package.json"],
    pins["package.json"],
  );
  rmSync(path.join(f.root, "dist"), { recursive: true });
  assert.equal(existsSync(path.join(f.root, "out-electron")), false);
  assert.equal((await standalone()).version, desktop.version);
  const promotedDmg = path.join(f.root, "release", desktop.dmgFilename);
  const promotedBytes = readFileSync(promotedDmg);
  writeFileSync(promotedDmg, "different image");
  await assert.rejects(standalone(), /DMG differs from trusted build digest/);
  writeFileSync(promotedDmg, promotedBytes);
  const asar = fileURLToPath(
    new URL("../node_modules/@electron/asar/bin/asar.js", import.meta.url),
  );
  for (const file of ["dist/index.html", "package.json"]) {
    put(f.root, "payload/" + file, "altered packaged bytes");
    execFileSync(process.execPath, [
      asar,
      "pack",
      path.join(f.root, "payload"),
      path.join(img.mount, "Forma.app/Contents/Resources/app.asar"),
    ]);
    await assert.rejects(standalone(), (err: Error) =>
      err.message.includes(file),
    );
    put(
      f.root,
      "payload/" + file,
      file === "package.json" ? runtimeManifest : "web",
    );
  }
});
