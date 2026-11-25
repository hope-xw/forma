import { lstatSync, readFileSync } from "node:fs";
import ts from "typescript";
import { z } from "zod";
import {
  classifyPathSubsystem,
  compareSemVer,
  CORE_SUBSYSTEMS,
  parseSemVer,
} from "./policy";
import {
  diffHashes,
  packagingFingerprint,
  packagingFingerprintMatches,
  isPackagingManifest,
  sourceHashes,
  readReleaseManifest,
  regularFile,
  workspacePath,
  listReleaseDmgs,
  listFilesNewerThan,
} from "./workspace-diff";

export interface ChangelogEntry {
  version: string;
  date: string;
  bullets: string[];
}
export interface ReleaseNotesEntry {
  version: string;
  date: string;
  title?: string;
  summary: string;
  highlights?: string[];
}
export interface ReleaseMetadataSyncReport {
  ok: boolean;
  packageVersion?: string;
  changelogVersion?: string;
  releaseNotesVersion?: string;
  latestPublicVersion?: string;
  desktopPackageExists: boolean;
  staleDesktopPackage: boolean;
  staleRuntimeFileCount: number;
  errors: string[];
  warnings: string[];
}

export function getShanghaiDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function validateDate(date: string) {
  const time = Date.parse(date);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== date
  )
    throw Error("发布日期无效：" + date);
}

export function applyPackageVersionUpdate(
  rawJson: string,
  nextVersion: string,
  options: { allowSameVersion?: boolean } = {},
): string {
  const previous = JSON.parse(rawJson).version;
  const order = compareSemVer(nextVersion, previous);
  if (order <= 0 && !(options.allowSameVersion && nextVersion === previous))
    throw Error("新版本必须高于 package.json 中的 " + previous);
  const source = ts.parseJsonText("package.json", rawJson);
  const first = source.statements[0];
  if (
    !first ||
    !ts.isExpressionStatement(first) ||
    !ts.isObjectLiteralExpression(first.expression)
  )
    throw Error("package.json 顶层必须是对象");
  const versions = first.expression.properties.filter(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) &&
      ts.isStringLiteral(p.name) &&
      p.name.text === "version",
  );
  if (versions.length !== 1) throw Error("package.json 顶层须有唯一 version");
  const value = versions[0].initializer;
  return (
    rawJson.slice(0, value.getStart(source)) +
    JSON.stringify(nextVersion) +
    rawJson.slice(value.end)
  );
}

export function applyPackageLockVersionUpdate(
  raw: string,
  nextVersion: string,
) {
  parseSemVer(nextVersion);
  const lock = JSON.parse(raw);
  if (
    typeof lock.version !== "string" ||
    typeof lock.packages?.[""]?.version !== "string"
  )
    throw Error("package-lock.json lacks root version mirrors");
  lock.version = nextVersion;
  lock.packages[""].version = nextVersion;
  return JSON.stringify(lock, null, 2) + "\n";
}

function changelogHistory(md: string) {
  return Array.from(md.matchAll(/^## (.*)$/gm), ([, heading]) => {
    const match = /^(\S+) · (\d{4}-\d{2}-\d{2})$/.exec(heading.trimEnd());
    if (!match) throw Error("无效的版本日志标题：" + heading);
    return { version: match[1], date: match[2] };
  }).reverse();
}

function validateHistory(entries: { version: string; date: string }[]) {
  const seen = new Set<string>();
  let previousDate = "";
  for (const { version, date } of entries) {
    parseSemVer(version);
    validateDate(date);
    if (seen.has(version)) throw Error("版本重复：" + version);
    if (date < previousDate)
      throw Error("发布日期倒退：" + version + " · " + date);
    seen.add(version);
    previousDate = date;
  }
}

export function applyChangelogUpdate(
  rawMd: string,
  entry: ChangelogEntry,
): string {
  validateHistory([...changelogHistory(rawMd), entry]);
  const bullets = entry.bullets.map((text) =>
    text
      .trim()
      .replace(/^[-*](?:\s+|$)/, "")
      .replace(/\s*[\r\n]+\s*/g, " ")
      .trim(),
  );
  if (!bullets.length || bullets.some((text) => !text))
    throw Error("CHANGELOG.md 需要非空条目");
  const pos = rawMd.search(/^## /m);
  const before = pos < 0 ? rawMd : rawMd.slice(0, pos);
  const rest = pos < 0 ? "" : rawMd.slice(pos);
  const section =
    "## " +
    entry.version +
    " · " +
    entry.date +
    "\n\n" +
    bullets.map((text) => "- " + text).join("\n");
  const newline = rawMd.includes("\r\n") ? "\r\n" : "\n";
  return (
    (before.trimEnd() ? before.trimEnd() + newline + newline : "") +
    section.replaceAll("\n", newline) +
    newline +
    (rest ? newline + rest : "")
  );
}

const entrySchema = z.strictObject({
  version: z.string(),
  date: z.string(),
  title: z.string().trim().min(1).optional(),
  summary: z.string(),
  highlights: z.array(z.string().trim().min(1)).optional(),
});

function validateEntry(value: unknown): ReleaseNotesEntry {
  const entry = entrySchema.parse(value);
  if (/^\d+\.\d+\.0$/.test(entry.version) && !entry.title)
    throw Error(entry.version + " 需要公开标题 title");
  if (entry.title && !entry.summary.trim())
    throw Error(entry.version + " 需要非空摘要 summary");
  return entry;
}

function parseReleaseUpdates(raw: string) {
  // Read the declaration from this checkout, without executing or importing it.
  const source = ts.createSourceFile(
    "release-notes.ts",
    raw,
    ts.ScriptTarget.Latest,
    true,
  );
  const [syntaxError] = ts
    .createProgram([], { noLib: true })
    .getSyntacticDiagnostics(source);
  if (syntaxError)
    throw Error(
      "release-notes.ts 语法错误：" +
        ts.flattenDiagnosticMessageText(syntaxError.messageText, "\n"),
    );
  const declarations = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((s) => [...s.declarationList.declarations])
    .filter((d) => ts.isIdentifier(d.name) && d.name.text === "releaseUpdates");
  const array = declarations[0]?.initializer;
  if (
    declarations.length !== 1 ||
    !array ||
    !ts.isArrayLiteralExpression(array) ||
    raw[array.end - 1] !== "]"
  )
    throw Error("找不到唯一的 releaseUpdates 数组字面量");
  const entries = array.elements.map((node) => {
    if (!ts.isObjectLiteralExpression(node))
      throw Error("releaseUpdates 条目必须是对象字面量");
    const record: Record<string, unknown> = Object.create(null);
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      )
        throw Error("releaseUpdates 含非静态属性");
      const key = property.name.text;
      if (Object.hasOwn(record, key)) throw Error("重复的版本记录属性：" + key);
      const item = property.initializer;
      if (ts.isStringLiteral(item) || ts.isNoSubstitutionTemplateLiteral(item))
        record[key] = item.text;
      else if (ts.isArrayLiteralExpression(item)) {
        record[key] = item.elements.map((el) => {
          if (
            !ts.isStringLiteral(el) &&
            !ts.isNoSubstitutionTemplateLiteral(el)
          )
            throw Error("highlights 必须是字符串数组");
          return el.text;
        });
      } else throw Error("releaseUpdates 属性必须是字面量：" + key);
    }
    return validateEntry(record);
  });
  validateHistory(entries);
  return { array, entries };
}

export function applyReleaseNotesUpdate(
  rawTs: string,
  entry: ReleaseNotesEntry,
): string {
  const { array, entries } = parseReleaseUpdates(rawTs);
  const next = validateEntry(entry);
  validateHistory([...entries, next]);
  const fields = Object.entries(next)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => "    " + name + ": " + JSON.stringify(value) + ",");
  const end = array.end - 1;
  let prefix = rawTs.slice(0, end);
  const last = array.elements.at(-1);
  if (last && !array.elements.hasTrailingComma)
    prefix = prefix.slice(0, last.end) + "," + prefix.slice(last.end);
  const newline = rawTs.includes("\r\n") ? "\r\n" : "\n";
  return (
    prefix.trimEnd() +
    ["", "  {", ...fields, "  },", ""].join(newline) +
    rawTs.slice(end)
  );
}

export function verifyReleaseMetadataSync(
  repoRoot: string,
): ReleaseMetadataSyncReport {
  const report: ReleaseMetadataSyncReport = {
    ok: false,
    desktopPackageExists: false,
    staleDesktopPackage: false,
    staleRuntimeFileCount: 0,
    errors: [],
    warnings: [],
  };
  const read = (file: string) =>
    readFileSync(regularFile(repoRoot, file), "utf8");
  try {
    const packageRaw = read("package.json");
    const version: string = JSON.parse(packageRaw).version;
    parseSemVer(version);
    report.packageVersion = version;
    const lockRaw = lstatSync(workspacePath(repoRoot, "package-lock.json"), {
      throwIfNoEntry: false,
    })
      ? read("package-lock.json")
      : undefined;
    if (lockRaw !== undefined) {
      const lock = JSON.parse(lockRaw);
      if (lock.version !== version || lock.packages?.[""]?.version !== version)
        report.errors.push(
          "package-lock.json root version mirrors differ from package.json",
        );
    }
    const changelog = changelogHistory(read("docs/CHANGELOG.md"));
    validateHistory(changelog);
    report.changelogVersion = changelog.at(-1)?.version;
    const { entries } = parseReleaseUpdates(
      read("src/editor/release-notes.ts"),
    );
    report.releaseNotesVersion = entries.at(-1)?.version;
    report.latestPublicVersion = entries
      .filter((entry) => entry.title)
      .at(-1)?.version;
    if (
      version !== report.changelogVersion ||
      version !== report.releaseNotesVersion
    )
      report.errors.push(
        "package.json、CHANGELOG.md 与 releaseUpdates 的最新版本不一致",
      );
    if (
      changelog.length !== entries.length ||
      entries.some(
        (e, i) =>
          e.version !== changelog[i]?.version || e.date !== changelog[i]?.date,
      )
    )
      report.errors.push(
        "CHANGELOG.md 与 releaseUpdates 的版本或日期序列不一致",
      );
    const dmgs = listReleaseDmgs(repoRoot, report.warnings);
    const current = dmgs.find((d) => d.version === version);
    report.desktopPackageExists = !!current;
    const desktop = readReleaseManifest(repoRoot).lastDesktopRelease;
    const baseline =
      current ?? dmgs.find((d) => compareSemVer(d.version, version) < 0);
    const changes = desktop
      ? diffHashes(desktop.sourceHashes, sourceHashes(repoRoot))
      : baseline
        ? listFilesNewerThan(repoRoot, baseline.mtimeMs, report.warnings)
        : [];
    if (
      changes.some(isPackagingManifest) &&
      desktop?.packagePackagingSha256 &&
      !desktop.packagePackagingSha256.startsWith("v2:")
    )
      report.warnings.push(
        "检测到旧版未标记格式的桌面依赖指纹，无法校验传递依赖差异；完成下一次发版后将自动升级至 v2 指纹。",
      );
    const packagingChanged =
      changes.some(isPackagingManifest) &&
      !packagingFingerprintMatches(
        desktop?.packagePackagingSha256 ?? packagingFingerprint("{}"),
        packageRaw,
        lockRaw,
      );
    report.staleRuntimeFileCount = changes.filter(
      (f) =>
        CORE_SUBSYSTEMS.includes(classifyPathSubsystem(f)) ||
        (isPackagingManifest(f) && packagingChanged),
    ).length;
    report.staleDesktopPackage = report.staleRuntimeFileCount > 0;
    if (report.staleDesktopPackage)
      report.warnings.push(
        report.staleRuntimeFileCount +
          " 个运行时文件与桌面包基线不同，请评估升版与打包。",
      );
    if (!current) report.warnings.push("当前版本尚无桌面 DMG。");
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
  }
  report.ok = report.errors.length === 0;
  return report;
}
