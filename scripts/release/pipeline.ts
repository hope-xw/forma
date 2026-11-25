import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  mkdtempSync,
  openSync,
  closeSync,
  chmodSync,
  readlinkSync,
  symlinkSync,
  cpSync,
  renameSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, isDeepStrictEqual } from "node:util";
import * as prettier from "prettier";
import { z } from "zod";
import {
  assessReleaseImpact,
  compareSemVer,
  parseSemVer,
  releaseBumps,
  significances,
  type ReleaseDecision,
} from "./policy";
import {
  atomicWrite,
  isInside,
  startReleaseChild,
  assertChildExited,
  packagingFingerprint,
  replaceCheckedFile,
  publicationParents,
  publicationPaths,
  reconcilePublication,
  readPlanBytes,
  type PublicationRecord,
  detectWorkspaceChanges,
  diffHashes,
  gitHead,
  listReleaseDmgs,
  manifestPath,
  readReleaseManifest,
  regularFile,
  sourceHashes,
  workspacePath,
  writeReleaseManifest,
  type ReleaseManifest,
} from "./workspace-diff";
import {
  applyChangelogUpdate,
  applyPackageLockVersionUpdate,
  applyPackageVersionUpdate,
  applyReleaseNotesUpdate,
  getShanghaiDate,
  verifyReleaseMetadataSync,
  type ReleaseNotesEntry,
} from "./release-files";
import {
  reconcileActiveMount,
  outputHashes,
  assertPinnedOutputs,
  evidenceTarget,
  sha256File,
  verifyPackagedDmg,
  type DesktopVerificationEvidence,
} from "./verify-dmg";

const planSchema = z.strictObject({
  significance: z.enum(significances).optional(),
  completedInitiative: z.boolean().optional(),
  initiatives: z.array(z.string().min(1)).optional(),
  breakingOrV1: z.boolean().optional(),
  securityOrDataFix: z.boolean().optional(),
  publicPatch: z.boolean().optional(),
  bump: z.enum(releaseBumps).optional(),
  packageDesktop: z.boolean().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  migrationNotes: z.string().optional(),
  highlights: z.array(z.string()).optional(),
  changelog: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  since: z.string().optional(),
});
export type ReleasePlanFile = z.infer<typeof planSchema>;
const state = "output/release-state",
  journal = state + "/tx.json";
const metadataNames = [
  "package.json",
  "docs/CHANGELOG.md",
  "src/editor/release-notes.ts",
  "package-lock.json",
];
const extensions = [".dmg", ".dmg.blockmap", ".zip", ".zip.blockmap"];
const string = { type: "string" } as const,
  flag = { type: "boolean" } as const,
  repeated = { type: "string", multiple: true } as const;
function print(report: object, label: string, json?: boolean) {
  if (!json) console.log(label);
  console.log(JSON.stringify(report, null, 2));
}
const hash = (data: string) => createHash("sha256").update(data).digest("hex");
const occupied = (file: string) => lstatSync(file, { throwIfNoEntry: false });
const jsonText = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const read = (root: string, file: string) =>
  readFileSync(regularFile(root, file), "utf8");
function readPlan(root: string, name: string) {
  // Preserve the original components, including ancestors followed by "..".
  const file = path.isAbsolute(name) ? name : root + path.sep + name;
  return planSchema.parse(JSON.parse(readPlanBytes(file)));
}
function checkoutLock(root: string) {
  const dir = workspacePath(root, state);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = workspacePath(root, state + "/release.lock"),
    owner = jsonText({ pid: process.pid, id: randomUUID() });
  function acquire(target: string): void {
    try {
      atomicWrite(target, owner, false);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const stale = read(root, target);
    const { pid } = z
      .object({ pid: z.number().int().positive() })
      .parse(JSON.parse(stale));
    try {
      process.kill(pid, 0);
      throw Error("Release lock held by PID " + pid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    // Apply the same stale-owner protocol if a previous reclaimer itself died.
    const reclaim = target + ".reclaim";
    acquire(reclaim);
    try {
      if (read(root, target) !== stale)
        throw Error("Release lock owner changed");
      unlinkSync(target);
      atomicWrite(target, owner, false);
    } finally {
      unlinkSync(reclaim);
    }
  }
  acquire(lock);
  return () => {
    if (read(root, lock) === owner) unlinkSync(lock);
  };
}
interface MetadataFile {
  name: string;
  original: string;
  originalSha256: string;
  written: string;
  writtenSha256: string;
  mode: number;
  atimeMs: number;
  mtimeMs: number;
}
interface Promotion {
  name: string;
  target: string;
  sha256: string;
  previousHash?: string;
  backup?: string;
}
interface Transaction {
  stage:
    | "metadata"
    | "gates"
    | "build"
    | "verify"
    | "promote"
    | "committed"
    | "rolling-back";
  targetVersion: string;
  decision: ReleaseDecision;
  releaseEntry: ReleaseNotesEntry & { migrationNotes?: string };
  changelog: string[];
  metadata: MetadataFile[];
  stagingDir: string;
  previousDmgPath?: string;
  previousDmgSha256?: string;
  evidenceOut: string;
  evidenceParents: ReturnType<typeof publicationParents>;
  priorShippedInitiatives: string[];
  gatesExecuted: string[];
  sourceHashes: Record<string, string>;
  pendingTempFiles?: PublicationRecord[];
  buildOutputHashes?: Record<string, string>;
  childPids?: number[];
  targetHashes: Record<string, string | undefined>;
  gitHead?: string;
  promotions?: Promotion[];
  nextManifest?: ReleaseManifest;
  originalManifest?: string;
}
const persist = (root: string, tx: Transaction) =>
  atomicWrite(workspacePath(root, journal), jsonText(tx), true);
const filenames = (v: string) =>
  extensions.map((ext) => "Forma-" + v + "-arm64" + ext);
const artifactBackup = (tx: Transaction, name: string) =>
  path.join(state, "backups", path.basename(tx.stagingDir), name);
function ensureAvailable(root: string, v: string, allow?: boolean) {
  for (const name of filenames(v)) {
    const file = path.join(workspacePath(root, "release"), name),
      st = occupied(file);
    if (st && (!allow || !st.isFile()))
      throw Error(
        "Occupied release target; --allow-repackage requires a regular file: " +
          file,
      );
  }
}
function loadTransaction(root: string): Transaction {
  const tx: Transaction = JSON.parse(read(root, journal));
  parseSemVer(tx.targetVersion);
  const v = tx.targetVersion;
  if (
    tx.decision.nextVersion !== v ||
    ![
      "metadata",
      "gates",
      "build",
      "verify",
      "promote",
      "committed",
      "rolling-back",
    ].includes(tx.stage) ||
    path.dirname(tx.stagingDir) !== state ||
    !path.basename(tx.stagingDir).startsWith("staging-" + v + "-") ||
    jsonText(tx.metadata.map((f) => f.name)) !==
      jsonText(
        metadataNames.filter(
          (n) =>
            n !== "package-lock.json" || tx.metadata.some((f) => f.name === n),
        ),
      )
  )
    throw Error("Invalid release transaction");
  workspacePath(root, tx.stagingDir);
  for (const f of tx.metadata)
    if (
      hash(f.original) !== f.originalSha256 ||
      hash(f.written) !== f.writtenSha256
    )
      throw Error("Invalid journal metadata digest: " + f.name);
  for (const p of tx.promotions ?? []) {
    if (
      p.backup !== undefined &&
      (!p.previousHash || p.backup !== artifactBackup(tx, p.name))
    )
      throw Error("Invalid journal rollback backup");
    if (p.name === "receipt.json") {
      if (p.target !== tx.evidenceOut) throw Error("Invalid journal receipt");
      evidenceTarget(root, p.target, true);
    } else if (
      !filenames(v).includes(p.name) ||
      p.target !== "release/" + p.name
    )
      throw Error("Invalid journal artifact");
  }
  return tx;
}
function metadataConflict(root: string, f: MetadataFile) {
  const backup = workspacePath(
    root,
    state + "/conflicts/" + path.basename(f.name) + ".original",
  );
  mkdirSync(path.dirname(backup), { recursive: true });
  if (!occupied(backup)) atomicWrite(backup, f.original, false);
  else if (read(root, backup) !== f.original)
    throw Error("Conflicting original backup: " + backup + "; see " + journal);
  return (
    "Concurrent metadata edit preserved: " +
    path.join(root, f.name) +
    "; original: " +
    backup
  );
}
function metadataState(root: string, f: MetadataFile) {
  try {
    return hash(read(root, f.name));
  } catch {
    return undefined;
  }
}
function recordPublication(root: string, tx: Transaction) {
  return (record: PublicationRecord) => {
    (tx.pendingTempFiles ??= []).push(record);
    persist(root, tx);
  };
}
function reconcilePublications(root: string, tx: Transaction) {
  for (const entry of tx.pendingTempFiles ?? []) {
    if (
      ![
        ...metadataNames,
        manifestPath,
        ...(tx.promotions ?? []).map((p) => p.target),
      ].includes(entry.target)
    )
      throw Error("Unexpected journal publication target: " + entry.target);
    reconcilePublication(root, entry);
  }
}
async function checkDisplaced(
  root: string,
  tx: Transaction,
  recovering = false,
) {
  for (const entry of tx.pendingTempFiles ?? []) {
    const { snapshot } = publicationPaths(root, entry);
    if (!entry.expected || !occupied(snapshot)) continue;
    if ((await sha256File(regularFile(root, snapshot))) === entry.expected)
      continue;
    const saved = workspacePath(
      root,
      state + "/conflicts/" + path.basename(snapshot) + "." + entry.token,
    );
    mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 });
    if (!occupied(saved)) linkSync(snapshot, saved);
    if (!linked(snapshot, saved))
      throw Error("Conflict path already occupied: " + saved);
    if (!recovering) throw Error("Concurrent edit preserved: " + saved);
  }
}
function restoreMetadata(root: string, tx: Transaction) {
  const conflicts: string[] = [];
  for (const f of tx.metadata) {
    const digest = metadataState(root, f);
    if (digest !== f.originalSha256 && digest !== f.writtenSha256) {
      conflicts.push(metadataConflict(root, f));
      continue;
    }
    if (digest !== f.originalSha256)
      replaceCheckedFile(root, f.name, f.original, f.writtenSha256, {
        record: recordPublication(root, tx),
        mode: f.mode,
        times: [f.atimeMs / 1000, f.mtimeMs / 1000],
      });
  }
  if (conflicts.length) throw Error(conflicts.join("\n"));
}
function clean(root: string, tx: Transaction) {
  tx.childPids?.forEach(assertChildExited);
  reconcilePublications(root, tx);
  rmSync(workspacePath(root, tx.stagingDir), { recursive: true, force: true });
  unlinkSync(regularFile(root, journal));
  const backups = workspacePath(root, state + "/backups");
  rmSync(path.join(backups, path.basename(tx.stagingDir)), {
    recursive: true,
    force: true,
  });
  try {
    rmdirSync(backups);
  } catch (err) {
    if (
      !["ENOENT", "ENOTEMPTY"].includes(
        (err as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw err;
  }
}
function linked(a: string, b: string) {
  const x = occupied(a),
    y = occupied(b);
  return !!(x?.isFile() && y?.isFile() && x.dev === y.dev && x.ino === y.ino);
}
async function rollback(root: string, tx: Transaction) {
  tx.childPids?.forEach(assertChildExited);
  tx.stage = "rolling-back";
  persist(root, tx);
  for (const p of [...(tx.promotions ?? [])].reverse()) {
    const file = workspacePath(root, p.target),
      src = workspacePath(root, path.join(tx.stagingDir, p.name));
    if (!linked(file, src)) {
      const existing = occupied(file);
      if (!existing && !p.previousHash) continue;
      if (existing?.isFile() && p.previousHash === (await sha256File(file)))
        continue;
      throw Error(
        "Concurrent artifact edit preserved: " +
          file +
          "; recovery files: " +
          workspacePath(root, tx.stagingDir),
      );
    }
    if ((await sha256File(file)) !== p.sha256)
      throw Error("Concurrent artifact edit preserved: " + file);
    if (p.previousHash) {
      const archived = workspacePath(
        root,
        p.backup ?? artifactBackup(tx, p.name),
      );
      const publication = tx.pendingTempFiles?.find(
        (entry) =>
          entry.target === p.target &&
          entry.expected === p.previousHash &&
          occupied(publicationPaths(root, entry).snapshot),
      );
      const backup = regularFile(
        root,
        p.backup || occupied(archived)
          ? archived
          : publication
            ? publicationPaths(root, publication).snapshot
            : path.join(tx.stagingDir, "original-" + p.name),
      );
      if ((await sha256File(backup)) !== p.previousHash)
        throw Error("Artifact backup changed: " + backup);
      const fd = openSync(backup, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        replaceCheckedFile(
          root,
          file,
          { fd, sha256: p.previousHash },
          p.sha256,
          { record: recordPublication(root, tx) },
        );
      } finally {
        closeSync(fd);
      }
    } else
      replaceCheckedFile(root, file, null, p.sha256, {
        record: recordPublication(root, tx),
      });
  }
  restoreMetadata(root, tx);
  await checkDisplaced(root, tx, true);
  clean(root, tx);
}
const gates = (root: string, major: boolean) => [
  [
    path.join(root, "node_modules/.bin/tsx"),
    "--test",
    "tests/release-notes.test.ts",
  ],
  ["npm", "run", "format:check"],
  ["npm", "test"],
  ["npm", "run", "build"],
  ["npm", "run", "desktop:service"],
  ["npm", "run", "desktop:agent"],
  ...(major
    ? [
        ["npm", "run", "test:browser"],
        ["npm", "run", "test:exports"],
      ]
    : []),
];
const builderArgs = (root: string, dir: string) => [
  "--publish",
  "never",
  "-c.mac.notarize=false",
  "-c.mac.identity=null",
  "-c.directories.output=" + dir,
  "-c.extends=" + path.join(dir, "builder.json"),
  "-c.afterPack=" + path.join(root, "electron/after-sign.mjs"),
];
function builderEnvironment(checkout: string) {
  const env = {
    ...process.env,
    INIT_CWD: checkout,
    npm_package_json: path.join(checkout, "package.json"),
    PATH:
      path.join(checkout, "node_modules/.bin") +
      path.delimiter +
      process.env.PATH,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    FORMA_FORCE_ADHOC_SIGN: "1",
  } as NodeJS.ProcessEnv;
  for (const k of Object.keys(env))
    if (
      /^(CSC_|APPLE_|WIN_CSC_|GH_TOKEN$|EP_GH_TOKEN$|GITHUB_TOKEN$|CIRCLE_TAG$|TRAVIS_TAG$|CI_COMMIT_TAG$|GITHUB_REF$|GITHUB_ACTIONS$|CI$)/.test(
        k,
      ) &&
      k !== "CSC_IDENTITY_AUTO_DISCOVERY"
    )
      delete env[k];
  return env;
}
function assertBuilderEnvironment(root: string) {
  if (occupied(path.join(root, "electron-builder.env")))
    throw Error("Remove electron-builder.env before a governed desktop build");
}
function electronDistribution(root: string, flags: Approvals, hooks: Hooks) {
  assertBuilderEnvironment(root);
  if (hooks.skipElectronCachePreflight ?? !!hooks.verify) return;
  const version = JSON.parse(
    readFileSync(path.join(root, "node_modules/electron/package.json"), "utf8"),
  ).version;
  parseSemVer(version);
  const lock = occupied(path.join(root, "package-lock.json"))
    ? JSON.parse(read(root, "package-lock.json"))
    : undefined;
  const locked = lock?.packages?.["node_modules/electron"]?.version;
  if (locked && locked !== version)
    throw Error(
      "Installed Electron differs from package-lock.json; run npm ci",
    );
  const name = "electron-v" + version + "-darwin-arm64.zip";
  const cache = path.resolve(
    process.env.ELECTRON_CACHE ??
      path.join(homedir(), "Library/Caches/electron"),
  );
  const folders = occupied(cache)?.isDirectory()
    ? readdirSync(cache, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^[a-f0-9]{64}$/i.test(e.name))
        .map((e) => e.name)
    : [];
  for (const folder of ["", ...folders]) {
    const file = path.join(cache, folder, name);
    if (occupied(file)?.isFile()) {
      const expected = JSON.parse(
        readFileSync(
          path.join(root, "node_modules/electron/checksums.json"),
          "utf8",
        ),
      )[name];
      if (!/^[a-f0-9]{64}$/.test(expected))
        throw Error("Missing Electron checksum for " + name);
      return { file, expected };
    }
  }
  if (!flags.allowElectronDownload)
    throw Error(
      "Missing cached Electron distribution " +
        name +
        " in " +
        cache +
        ". Seed ELECTRON_CACHE or pass --allow-electron-download.",
    );
}
async function checkDmgbuildCache(
  root: string,
  flags: Approvals,
  hooks: Hooks,
) {
  if (
    flags.allowElectronDownload ||
    (hooks.skipElectronCachePreflight ?? !!hooks.verify)
  )
    return;
  const custom = process.env.CUSTOM_DMGBUILD_PATH?.trim();
  if (custom) {
    const file = path.resolve(root, custom);
    if (!statSync(file, { throwIfNoEntry: false })?.isFile())
      throw Error("Invalid CUSTOM_DMGBUILD_PATH: " + file);
    return;
  }
  const arm = process.arch === "arm64";
  await checkCachedToolset(
    "dmg-builder@1.2.5",
    "dmgbuild-bundle-" + (arm ? "arm64" : "x86_64") + "-75c8a6c",
    "dmgbuild",
    arm
      ? "793404d0c96687e27d5ee40a668d498c92e36a64d6c2906df511031adb33cbeb"
      : "1664972f9cc2d6e8fce3b63e42cd30078aff602669c5856939c4519921200433",
  );
}
async function check7zipCache(root: string, flags: Approvals, hooks: Hooks) {
  if (hooks.skipElectronCachePreflight ?? !!hooks.verify) return;
  const { resolveEnvShellValue } = await import("builder-util/out/envUtil.js");
  const custom = resolveEnvShellValue("ELECTRON_BUILDER_7ZIP_PATH");
  if (custom) {
    const resolved = path.resolve(root, custom);
    let executable = false;
    if (
      path.isAbsolute(custom) &&
      statSync(resolved, { throwIfNoEntry: false })?.isFile()
    ) {
      try {
        accessSync(resolved, constants.X_OK);
        executable = true;
      } catch {
        executable = false;
      }
    }
    if (!executable)
      throw Error(
        "ELECTRON_BUILDER_7ZIP_PATH must point to an absolute executable file: " +
          custom,
      );
    return;
  }
  if (flags.allowElectronDownload) return;
  await checkCachedToolset(
    "7zip@1.0.0",
    "7zip-darwin-" + (process.arch === "arm64" ? "arm64" : "x86_64"),
    "bin/7za",
    "496a341abe210aae1a25bc202ee97f6de6c76a3dc80f91d96616be05502d72c1",
  );
}
// electron-builder 26.18.0 downloadBuilderToolset checks the extracted state first.
async function checkCachedToolset(
  release: string,
  bundle: string,
  executable: string,
  expected: string,
) {
  const { getCacheDirectory, getBinariesMirrorUrl } =
    await import("app-builder-lib/out/util/electronGet.js");
  const { readCacheStateFile, validateCacheDirectory } =
    await import("app-builder-lib/out/util/cacheState.js");
  const filename = bundle + ".tar.gz";
  const dir = path.join(
    getCacheDirectory({ allowEnvVarOverride: true }),
    release,
  );
  const url =
    getBinariesMirrorUrl("electron-userland/electron-builder-binaries") +
    release +
    "/" +
    filename;
  // The extracted directory uses builder's five-character hashUrlSafe(fullUrl, 5).
  let hash = 5381;
  for (let i = 0; i < url.length; i++)
    hash = ((hash << 5) + hash) ^ url.charCodeAt(i);
  const suffix = (hash >>> 0).toString(36).slice(0, 5).padStart(5, "0");
  const extracted = path.join(dir, bundle + "-" + suffix);
  const state = await readCacheStateFile(extracted);
  if (
    state?.state === "complete" &&
    (await validateCacheDirectory(extracted, state.fileCount))
  ) {
    if (
      !statSync(path.join(extracted, executable), {
        throwIfNoEntry: false,
      })?.isFile()
    )
      throw Error("Missing cached " + executable + " in " + extracted);
    return;
  }
  const archive = path.join(dir, filename);
  if (!occupied(archive)?.isFile() || (await sha256File(archive)) !== expected)
    throw Error(
      "Missing or invalid cached " +
        release +
        " archive: " +
        archive +
        ". Seed ELECTRON_BUILDER_CACHE or pass --allow-electron-download.",
    );
}
function buildCheckout(root: string, tx: Transaction) {
  return workspacePath(root, path.join(tx.stagingDir, "checkout"));
}
function copyFrozenCheckout(root: string, tx: Transaction, resume = false) {
  const checkout = buildCheckout(root, tx);
  if (resume) {
    if (!occupied(path.join(checkout, "node_modules"))?.isDirectory())
      throw Error(
        "Missing or invalid isolated checkout/node_modules. Use --rollback and re-assess.",
      );
    for (const entry of readdirSync(checkout)) {
      if (entry !== "node_modules")
        rmSync(path.join(checkout, entry), { recursive: true, force: true });
    }
  } else {
    rmSync(checkout, { recursive: true, force: true });
    mkdirSync(checkout, { recursive: true, mode: 0o700 });
  }
  for (const [file, digest] of Object.entries(tx.sourceHashes)) {
    const dest = workspacePath(checkout, file);
    mkdirSync(path.dirname(dest), { recursive: true });
    const metadata = tx.metadata.find((f) => f.name === file);
    if (metadata)
      writeFileSync(dest, metadata.original, {
        mode: metadata.mode,
        flag: "wx",
      });
    else copyFileSync(regularFile(root, file), dest, constants.COPYFILE_EXCL);
    if (
      createHash("sha256").update(readFileSync(dest)).digest("hex") !== digest
    )
      throw Error("Source changed since assessment: " + file);
  }
  if (!resume) copyBuildDependencies(root, checkout);
  return checkout;
}
function copyBuildDependencies(root: string, checkout: string) {
  const modules = realpathSync(path.join(root, "node_modules"));
  const dest = path.join(checkout, "node_modules");
  if (process.platform === "darwin") {
    try {
      execFileSync("/bin/cp", ["-cR", modules, dest], { stdio: "pipe" });
    } catch {
      // A failed clonefile copy can leave a partial tree on a non-APFS volume.
      rmSync(dest, { recursive: true, force: true });
    }
  }
  if (!occupied(dest))
    cpSync(modules, dest, { recursive: true, verbatimSymlinks: true });

  // Keep normal relative npm links. An absolute or escaping link still points
  // outside the copied tree and must resolve to a private copy as well.
  for (const entry of readdirSync(dest, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isSymbolicLink()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const link = readlinkSync(file);
    if (isInside(dest, path.resolve(entry.parentPath, link))) continue;
    const target = realpathSync(
      path.resolve(modules, path.relative(dest, entry.parentPath), link),
    );
    unlinkSync(file);
    if (isInside(modules, target)) {
      const copiedTarget = path.join(dest, path.relative(modules, target));
      symlinkSync(path.relative(entry.parentPath, copiedTarget), file);
    } else {
      cpSync(target, file, {
        recursive: true,
        dereference: true,
        mode: constants.COPYFILE_FICLONE,
      });
    }
  }
}
function expectedShippedHashes(tx: Transaction) {
  return {
    ...tx.sourceHashes,
    ...Object.fromEntries(tx.metadata.map((f) => [f.name, f.writtenSha256])),
  };
}
function assertSnapshot(
  root: string,
  tx: Transaction,
  partialMetadata = false,
) {
  if (!tx.sourceHashes)
    throw Error("Missing frozen source inventory; use --rollback");
  const current = sourceHashes(root);
  const expected = expectedShippedHashes(tx);
  for (const f of tx.metadata) {
    if (partialMetadata && current[f.name] === f.originalSha256)
      expected[f.name] = f.originalSha256;
  }
  const changes = diffHashes(expected, current);
  if (changes.length)
    throw Error(
      "Source changed since assessment: " +
        changes.join(", ") +
        ". Use --rollback and assess again.",
    );
}
type Hooks = {
  verify?: typeof verifyPackagedDmg;
  skipElectronCachePreflight?: boolean;
};
type Approvals = {
  confirmMajor?: boolean;
  allowRepackage?: boolean;
  allowElectronDownload?: boolean;
  overwriteEvidence?: boolean;
  json?: boolean;
};
async function preparePromotion(
  root: string,
  tx: Transaction,
  evidence: DesktopVerificationEvidence,
  flags: Approvals,
) {
  const dir = workspacePath(root, tx.stagingDir);
  atomicWrite(path.join(dir, "receipt.json"), jsonText(evidence), false, 0o700);
  const promotions: Promotion[] = [];
  for (const name of [...filenames(tx.targetVersion), "receipt.json"]) {
    const receipt = name === "receipt.json",
      target = receipt ? tx.evidenceOut : "release/" + name;
    const file = receipt
      ? evidenceTarget(root, target, flags.overwriteEvidence)
      : workspacePath(root, target);
    const src = regularFile(root, path.join(dir, name)),
      sha256 = await sha256File(src);
    if (
      !receipt &&
      evidence.distribution.find((d) => d.filename === name)?.sha256 !== sha256
    )
      throw Error("Staged artifact changed: " + src);
    let previousHash: string | undefined;
    if (occupied(file)) {
      if (!(receipt ? flags.overwriteEvidence : flags.allowRepackage))
        throw Error("Target already exists: " + file);
      previousHash = await sha256File(regularFile(root, file));
    }
    if (previousHash !== tx.targetHashes[target])
      throw Error("Concurrent release target edit preserved: " + file);
    promotions.push({
      name,
      target,
      sha256,
      previousHash,
      backup: previousHash ? artifactBackup(tx, name) : undefined,
    });
  }
  tx.promotions = promotions;
}
async function promote(root: string, tx: Transaction, flags: Approvals) {
  assertSnapshot(root, tx);
  if (
    tx.previousDmgPath &&
    (await sha256File(regularFile(root, tx.previousDmgPath))) !==
      tx.previousDmgSha256
  )
    throw Error("Previous DMG changed since build");
  for (const p of tx.promotions ?? []) {
    const src = regularFile(root, path.join(tx.stagingDir, p.name)),
      file = workspacePath(root, p.target);
    if ((await sha256File(src)) !== p.sha256)
      throw Error("Verified artifact changed: " + src);
    if (linked(file, src)) continue; // Interruption after link/rename.
    if (
      p.previousHash &&
      !(p.name === "receipt.json"
        ? flags.overwriteEvidence
        : flags.allowRepackage)
    )
      throw Error("Replacement requires explicit overwrite approval: " + file);
    if (p.previousHash) {
      // The displaced hard link follows late writes. Rollback needs independent bytes.
      const archive = workspacePath(
        root,
        p.backup ?? artifactBackup(tx, p.name),
      );
      mkdirSync(path.dirname(archive), { recursive: true, mode: 0o700 });
      if (!occupied(archive)) {
        const temp = archive + "." + randomUUID();
        try {
          copyFileSync(regularFile(root, file), temp, constants.COPYFILE_EXCL);
          if ((await sha256File(temp)) !== p.previousHash)
            throw Error("Concurrent release target edit preserved: " + file);
          chmodSync(temp, 0o400);
          renameSync(temp, archive);
        } finally {
          rmSync(temp, { force: true });
        }
      } else if (
        (await sha256File(regularFile(root, archive))) !== p.previousHash
      )
        throw Error("Artifact backup changed: " + archive);
    }
    replaceCheckedFile(
      root,
      file,
      { source: src, sha256: p.sha256 },
      p.previousHash,
      {
        record: recordPublication(root, tx),
        ...(p.name === "receipt.json"
          ? { parents: tx.evidenceParents, keepBackup: !!p.previousHash }
          : {}),
      },
    );
  }
  assertSnapshot(root, tx);
  for (const p of tx.promotions ?? []) {
    const target = regularFile(root, p.target);
    if (
      !linked(target, regularFile(root, path.join(tx.stagingDir, p.name))) ||
      (await sha256File(target)) !== p.sha256
    )
      throw Error("Promoted artifact changed: " + target);
  }
  if (
    tx.previousDmgPath &&
    (await sha256File(regularFile(root, tx.previousDmgPath))) !==
      tx.previousDmgSha256
  )
    throw Error("Previous DMG changed during promotion");
  if (!tx.nextManifest) throw Error("Missing release manifest");
  const existing = occupied(workspacePath(root, manifestPath))
    ? read(root, manifestPath)
    : undefined;
  if (existing !== tx.originalManifest)
    throw Error("Release manifest changed concurrently");
  await checkDisplaced(root, tx);
  writeReleaseManifest(root, tx.nextManifest, {
    record: recordPublication(root, tx),
    original: tx.originalManifest,
  });
  tx.stage = "committed";
  persist(root, tx);
}
function tracked(
  root: string,
  tx: Transaction,
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  quiet: boolean,
) {
  return startReleaseChild(
    program,
    args,
    buildCheckout(root, tx),
    env,
    quiet,
    (pid) => {
      (tx.childPids ??= []).push(pid);
      persist(root, tx);
    },
  );
}
function forgetChild(root: string, tx: Transaction, pid: number) {
  assertChildExited(pid);
  tx.childPids = tx.childPids?.filter((p) => p !== pid);
  persist(root, tx);
}
async function runTracked(
  root: string,
  tx: Transaction,
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  quiet: boolean,
) {
  const child = tracked(root, tx, program, args, env, quiet);
  try {
    await child.done;
  } finally {
    forgetChild(root, tx, child.pid);
  }
}
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  if (!address || typeof address === "string") throw Error("No QA port");
  return address.port;
}
async function checkBrowserBuild(
  root: string,
  tx: Transaction,
  env: NodeJS.ProcessEnv,
  quiet: boolean,
) {
  const dir = workspacePath(root, tx.stagingDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(path.join(dir, "browser-qa-"));
  const port = await freePort();
  let agentPort = await freePort();
  while (agentPort === port) agentPort = await freePort();
  const qa: NodeJS.ProcessEnv & { FORMA_URL: string } = {
    ...env,
    FORMA_CONFIG_DIR: path.join(work, "config"),
    FORMA_AGENT_CONFIG_DIR: path.join(work, "config"),
    FORMA_LIBRARY_DIRECTORY: path.join(work, "libraries"),
    AGENT_PORT: String(agentPort),
    FORMA_URL: "http://127.0.0.1:" + port + "/",
  };
  for (const key of Object.keys(qa))
    if (key.startsWith("MODEL_")) delete qa[key];
  const preview = tracked(
    root,
    tx,
    path.join(buildCheckout(root, tx), "node_modules/.bin/vite"),
    [
      "preview",
      "--config",
      path.join(buildCheckout(root, tx), "vite.config.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    qa,
    quiet,
  );
  try {
    const until = Date.now() + 30000;
    for (;;) {
      try {
        const status = await fetch(qa.FORMA_URL + "api/agent/status", {
          signal: AbortSignal.timeout(1500),
        });
        if (status.status !== 200) throw Error("Agent status " + status.status);
        z.object({ configured: z.literal(false) }).parse(await status.json());
        break;
      } catch (err) {
        if (Date.now() >= until)
          throw Error("Isolated Forma preview readiness failed", {
            cause: err,
          });
        await Promise.race([
          new Promise((r) => setTimeout(r, 150)),
          preview.done.then(() => {
            throw Error("Preview stopped");
          }),
        ]);
      }
    }
    for (const gate of ["test:browser", "test:exports"])
      await runTracked(root, tx, "npm", ["run", gate], qa, quiet);
  } finally {
    try {
      process.kill(-preview.pid, "SIGTERM");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    await preview.done.catch(() => {});
    forgetChild(root, tx, preview.pid);
    rmSync(work, { recursive: true, force: true });
  }
}
async function execute(
  root: string,
  tx: Transaction,
  flags: Approvals,
  hooks: Hooks,
  checkoutPrepared = false,
) {
  const dir = workspacePath(root, tx.stagingDir);
  // Node suppresses nested test runs when its parent runner marker leaks into a release.
  const gateEnv = { ...process.env };
  delete gateEnv.NODE_TEST_CONTEXT;
  const checkout = buildCheckout(root, tx);
  gateEnv.PATH =
    path.join(checkout, "node_modules/.bin") + path.delimiter + gateEnv.PATH;
  gateEnv.INIT_CWD = checkout;
  gateEnv.npm_package_json = path.join(checkout, "package.json");
  const quiet = !!flags.json;
  if (tx.stage !== "promote" && tx.stage !== "committed") {
    if (tx.decision.packageDesktop)
      ensureAvailable(root, tx.targetVersion, flags.allowRepackage);
    if (tx.decision.packageDesktop) assertBuilderEnvironment(root);
    // Leave the journal available for an explicit rollback if the private dependencies are gone.
    if (!checkoutPrepared) copyFrozenCheckout(root, tx, true);
    try {
      if (tx.decision.packageDesktop) {
        electronDistribution(checkout, flags, hooks);
        await checkDmgbuildCache(checkout, flags, hooks);
        await check7zipCache(checkout, flags, hooks);
      }
      for (const f of tx.metadata) {
        writeFileSync(regularFile(checkout, f.name), f.written);
        const digest = metadataState(root, f);
        if (digest === f.writtenSha256) continue;
        if (tx.stage !== "metadata" || digest !== f.originalSha256)
          throw Error(metadataConflict(root, f));
        replaceCheckedFile(root, f.name, f.written, f.originalSha256, {
          record: recordPublication(root, tx),
          mode: f.mode,
        });
      }
      assertSnapshot(root, tx);
      tx.stage = "gates";
      tx.gatesExecuted = [];
      persist(root, tx);
      tx.buildOutputHashes = {};
      for (const [prog, ...args] of gates(
        checkout,
        tx.decision.bump === "major",
      )) {
        if (args.join(" ") === "run build") {
          assertSnapshot(root, tx);
          tx.stage = "build";
          persist(root, tx);
        }
        if (args[1] === "test:browser")
          await checkBrowserBuild(root, tx, gateEnv, quiet);
        else if (args[1] !== "test:exports")
          await runTracked(root, tx, prog, args, gateEnv, quiet);
        if (tx.decision.packageDesktop) {
          const group =
            args[1] === "build"
              ? "dist"
              : args[1] === "desktop:service"
                ? "out-electron/library-service.mjs"
                : args[1] === "desktop:agent"
                  ? "out-electron/agent-service.mjs"
                  : undefined;
          if (group)
            Object.assign(
              tx.buildOutputHashes,
              await outputHashes(checkout, [group]),
            );
        }
        tx.gatesExecuted.push([path.basename(prog), ...args].join(" "));
        persist(root, tx);
      }
    } catch (err) {
      await rollback(root, tx);
      throw Error("发版预检失败，已恢复版本元数据：" + String(err));
    }
    assertSnapshot(root, tx);
    assertSnapshot(checkout, tx);
    const packagingHash = packagingFingerprint(
      read(checkout, "package.json"),
      occupied(path.join(checkout, "package-lock.json"))
        ? read(checkout, "package-lock.json")
        : undefined,
    );
    const next = readReleaseManifest(root);
    next.lastRelease = {
      version: tx.targetVersion,
      date: tx.releaseEntry.date,
      gitHead: tx.gitHead,
      shippedInitiatives: tx.decision.shippedInitiatives,
      ...(tx.priorShippedInitiatives.length
        ? { priorShippedInitiatives: tx.priorShippedInitiatives }
        : {}),
      sourceHashes: expectedShippedHashes(tx),
      packagePackagingSha256: packagingHash,
    };
    if (tx.decision.packageDesktop) {
      const distribution = electronDistribution(checkout, flags, hooks);
      assertBuilderEnvironment(checkout);
      const pins = tx.buildOutputHashes!;
      for (const [file, digest] of Object.entries(expectedShippedHashes(tx))) {
        if (file === "package.json" || file.startsWith("electron/"))
          pins[file] = digest;
      }
      await assertPinnedOutputs(checkout, pins);
      persist(root, tx);
      for (const entry of readdirSync(dir)) {
        if (entry !== "checkout")
          rmSync(workspacePath(root, path.join(dir, entry)), {
            recursive: true,
            force: true,
          });
      }
      let cachedZip: string | undefined;
      if (distribution) {
        cachedZip = path.join(dir, path.basename(distribution.file));
        copyFileSync(distribution.file, cachedZip, constants.COPYFILE_EXCL);
        if ((await sha256File(cachedZip)) !== distribution.expected)
          throw Error(
            "Electron distribution checksum mismatch: " + distribution.file,
          );
      }
      // Builder 26 treats -c.afterSign=null as a hook module called "null".
      // Load a typed config while keeping the actual project and its file sets.
      atomicWrite(
        path.join(dir, "builder.json"),
        jsonText({
          ...JSON.parse(read(checkout, "package.json")).build,
          ...(cachedZip ? { electronDist: cachedZip } : {}),
          afterSign: null,
        }),
        false,
      );
      assertBuilderEnvironment(root);
      assertBuilderEnvironment(checkout);
      await checkDmgbuildCache(checkout, flags, hooks);
      await check7zipCache(checkout, flags, hooks);
      await runTracked(
        root,
        tx,
        path.join(checkout, "node_modules/.bin/electron-builder"),
        builderArgs(checkout, dir),
        builderEnvironment(checkout),
        quiet,
      );
      assertSnapshot(root, tx);
      await assertPinnedOutputs(checkout, pins);
      tx.gatesExecuted.push("electron-builder");
      tx.stage = "verify";
      persist(root, tx);
      const stagedDmg = regularFile(
        root,
        path.join(dir, filenames(tx.targetVersion)[0]),
      );
      const evidence = await (hooks.verify ?? verifyPackagedDmg)({
        repoRoot: root,
        referenceRoot: checkout,
        pinnedOutputHashes: pins,
        requireAdhocSignature: true,
        version: tx.targetVersion,
        dmgPath: stagedDmg,
        expectedDmgSha256: await sha256File(stagedDmg),
        previousDmgPath: tx.previousDmgPath,
        previousDmgSha256: tx.previousDmgSha256,
        evidenceOut: tx.evidenceOut,
        allowOverwriteEvidence: flags.overwriteEvidence,
        deferEvidence: true,
      });
      await assertPinnedOutputs(checkout, pins);
      tx.gatesExecuted.push("verify-dmg");
      ensureAvailable(root, tx.targetVersion, flags.allowRepackage);
      await preparePromotion(root, tx, evidence, flags);
      const [dmg, zip] = evidence.distribution;
      next.lastDesktopRelease = {
        version: tx.targetVersion,
        date: tx.releaseEntry.date,
        // The verifier has checked builder's runtime projection against the source manifest.
        buildOutputHashes: {
          ...pins,
          "package.json": evidence.matchingWebAndApp["package.json"],
        },
        dmgFilename: dmg.filename,
        dmgSha256: dmg.sha256,
        zipFilename: zip.filename,
        zipSha256: zip.sha256,
        sourceHashes: expectedShippedHashes(tx),
        packagePackagingSha256: packagingHash,
      };
    }
    tx.nextManifest = next;
    tx.stage = "promote";
    persist(root, tx);
  }
  const recoveringCommitted = tx.stage === "committed";
  if (tx.stage === "promote") await promote(root, tx, flags);
  await checkDisplaced(root, tx, recoveringCommitted);
  clean(root, tx);
  return {
    decision: tx.decision,
    releaseEntry: tx.releaseEntry,
    filesUpdated: tx.metadata.map((f) => f.name),
    artifacts: tx.promotions?.map((p) => p.target) ?? [],
    gatesExecuted: tx.gatesExecuted,
    ...(tx.decision.bump === "major"
      ? {
          crossWorkflowVerification:
            "Cross-workflow verification passed: browser workflows, exported projects and mounted desktop QA.",
        }
      : {}),
  };
}

export async function main(
  args = process.argv.slice(2),
  repoRoot = process.cwd(),
  hooks: Hooks = {},
): Promise<void> {
  const root = realpathSync(repoRoot),
    [command, ...rest] = args;
  if (command === "check") {
    const { values } = parseArgs({ args: rest, options: { json: flag } });
    const report = verifyReleaseMetadataSync(root);
    print(
      report,
      report.ok ? "版本元数据一致。" : "版本元数据检查失败。",
      values.json,
    );
    if (!report.ok) throw Error(report.errors.join("\n"));
    return;
  }
  if (command === "verify-dmg") {
    const { values } = parseArgs({
      args: rest,
      options: {
        version: string,
        dmg: string,
        "previous-dmg": string,
        "previous-sha256": string,
        "evidence-out": string,
        "trust-external-dmg": flag,
        "allow-overwrite-evidence": flag,
        json: flag,
      },
    });
    const unlock = checkoutLock(root);
    try {
      reconcileActiveMount(root);
      const evidence = await (hooks.verify ?? verifyPackagedDmg)({
        repoRoot: root,
        version:
          values.version ?? JSON.parse(read(root, "package.json")).version,
        dmgPath: values.dmg,
        previousDmgPath: values["previous-dmg"],
        previousDmgSha256: values["previous-sha256"],
        evidenceOut: values["evidence-out"],
        trustExternalDmg: values["trust-external-dmg"],
        allowOverwriteEvidence: values["allow-overwrite-evidence"],
      });
      print(evidence, "只读 DMG 验收通过。", values.json);
    } finally {
      unlock();
    }
    return;
  }
  if (command !== "run" && command !== "assess")
    throw Error("Expected assess | check | verify-dmg | run");
  // Preserve the historical boolean --initiative; an optional ID selects one
  // completed directory explicitly in a scoped assessment.
  const normalizedArgs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--initiative="))
      normalizedArgs.push(
        "--initiative-id=" + rest[i].slice("--initiative=".length),
      );
    else if (
      rest[i] === "--initiative" &&
      rest[i + 1] &&
      !rest[i + 1].startsWith("-")
    )
      normalizedArgs.push("--initiative-id=" + rest[++i]);
    else normalizedArgs.push(rest[i]);
  }
  const { values } = parseArgs({
    args: normalizedArgs,
    allowNegative: true,
    options: {
      significance: string,
      initiative: flag,
      "initiative-id": repeated,
      "breaking-or-v1": flag,
      "security-fix": flag,
      "public-patch": flag,
      bump: string,
      "package-desktop": string,
      files: string,
      since: string,
      json: flag,
      plan: string,
      title: string,
      summary: string,
      highlight: repeated,
      changelog: repeated,
      "migration-notes": string,
      "confirm-major": flag,
      "allow-repackage": flag,
      "allow-electron-download": flag,
      "allow-overwrite-evidence": flag,
      "dry-run": flag,
      resume: flag,
      rollback: flag,
    },
  });
  const actual = command === "run" && !values["dry-run"];
  if (
    (values.resume || values.rollback) &&
    (!actual || (values.resume && values.rollback))
  )
    throw Error("Choose run --resume or run --rollback");
  const flags = {
    confirmMajor: values["confirm-major"],
    allowRepackage: values["allow-repackage"],
    allowElectronDownload: values["allow-electron-download"],
    overwriteEvidence: values["allow-overwrite-evidence"],
    json: values.json,
  };
  const unlock = actual ? checkoutLock(root) : undefined;
  try {
    if (actual) reconcileActiveMount(root);
    if (actual && occupied(workspacePath(root, journal))) {
      if (!values.resume && !values.rollback)
        throw Error(
          "Unfinished release. Run release:run --resume or release:run --rollback",
        );
      const tx = loadTransaction(root);
      tx.childPids?.forEach(assertChildExited);
      reconcilePublications(root, tx);
      // Manifest rename is the commit point, including a crash just before the stage update.
      if (
        tx.stage === "promote" &&
        tx.nextManifest &&
        occupied(workspacePath(root, manifestPath)) &&
        isDeepStrictEqual(
          JSON.parse(read(root, manifestPath)),
          JSON.parse(jsonText(tx.nextManifest)),
        )
      )
        tx.stage = "committed";
      if (values.rollback) {
        if (tx.stage === "committed")
          throw Error(
            "Release already committed. Run --resume to finish cleanup.",
          );
        await rollback(root, tx);
        print(
          { rolledBack: tx.targetVersion },
          "已恢复版本元数据。",
          values.json,
        );
        return;
      }
      if (tx.stage === "rolling-back")
        throw Error("Interrupted rollback: complete --rollback");
      if (
        tx.stage !== "committed" &&
        (!tx.targetHashes || !tx.evidenceParents || !tx.priorShippedInitiatives)
      )
        throw Error(
          "The journal predates frozen release inputs; use --rollback and assess again",
        );
      if (
        tx.stage === "promote" &&
        tx.decision.packageDesktop &&
        !tx.buildOutputHashes?.["package.json"]
      )
        throw Error(
          "Missing pinned build outputs; use --rollback and assess again",
        );
      if (tx.stage !== "committed")
        assertSnapshot(root, tx, tx.stage === "metadata");
      if (
        tx.stage !== "committed" &&
        (tx.targetVersion === "1.0.0" ||
          parseSemVer(tx.targetVersion).major >
            parseSemVer(tx.decision.currentVersion).major) &&
        (tx.decision.bump !== "major" || !tx.decision.packageDesktop)
      )
        throw Error("Stale major governance decision; use --rollback");
      if (
        tx.decision.bump === "major" &&
        (!flags.confirmMajor || !tx.releaseEntry.migrationNotes?.trim())
      )
        throw Error("Major release requires --confirm-major");
      print(await execute(root, tx, flags, hooks), "发布完成。", values.json);
      return;
    }
    if (values.resume || values.rollback) throw Error("No unfinished release");
    const cli = {
      significance: values.significance,
      completedInitiative: values.initiative,
      initiatives: values["initiative-id"],
      breakingOrV1: values["breaking-or-v1"],
      securityOrDataFix: values["security-fix"],
      publicPatch: values["public-patch"],
      bump: values.bump,
      packageDesktop:
        values["package-desktop"] === undefined
          ? undefined
          : z
              .stringbool({ truthy: ["true"], falsy: ["false"] })
              .parse(values["package-desktop"]),
      title: values.title,
      summary: values.summary,
      migrationNotes: values["migration-notes"],
      highlights: values.highlight,
      changelog: values.changelog,
      files: values.files?.split(",").map((f) => f.trim()),
      since: values.since,
    };
    const plan = planSchema.parse({
      ...(values.plan ? readPlan(root, values.plan) : {}),
      ...Object.fromEntries(
        Object.entries(cli).filter(([, v]) => v !== undefined),
      ),
    });
    if (actual && plan.files)
      throw Error("--files is only permitted in assess or run --dry-run");
    const frozen = actual ? sourceHashes(root) : undefined;
    const originalManifest = occupied(workspacePath(root, manifestPath))
      ? read(root, manifestPath)
      : undefined;
    const frozenHead = actual ? gitHead(root) : undefined;
    const currentVersion = JSON.parse(read(root, "package.json")).version;
    const diff = detectWorkspaceChanges(root, {
      currentVersion,
      explicitFiles: plan.files,
      sinceIso: plan.since,
      frozenHashes: frozen,
    });
    if (
      actual &&
      plan.since &&
      diff.source !== "git" &&
      (originalManifest || diff.baselineDmg || diff.source === "mtime")
    ) {
      const full = detectWorkspaceChanges(root, {
        currentVersion,
        frozenHashes: frozen,
      });
      if (originalManifest || full.baselineMs) {
        diff.changedFiles = [
          ...new Set([...full.changedFiles, ...diff.changedFiles]),
        ].sort();
        diff.packagePackagingChanged ||= full.packagePackagingChanged;
        diff.unshippedCompletedInitiatives = full.unshippedCompletedInitiatives;
        diff.previouslyCompletedInitiatives =
          full.previouslyCompletedInitiatives;
        diff.incompleteAssessment ||= full.incompleteAssessment;
        diff.warnings.push(
          ...full.warnings.filter((w) => !diff.warnings.includes(w)),
        );
      }
    }
    const chosen = (plan.initiatives ?? []).map((id) => {
      const match = diff.unshippedCompletedInitiatives.find(
        (dir) => dir === id || path.basename(dir) === id,
      );
      if (!match)
        throw Error("Unknown or already shipped completed initiative: " + id);
      return match;
    });
    const changedInitiatives = diff.unshippedCompletedInitiatives.filter(
      (dir) =>
        diff.changedFiles.some((f) => f === dir || f.startsWith(dir + "/")),
    );
    const shippedInitiatives =
      plan.initiatives !== undefined
        ? [...new Set(chosen)]
        : changedInitiatives;
    const assessment = {
      ...plan,
      currentVersion,
      completedInitiative: !!(
        shippedInitiatives.length || plan.completedInitiative
      ),
      shippedInitiatives,
      changedFiles: diff.changedFiles,
      packagePackagingChanged: diff.packagePackagingChanged,
      overrideBump: plan.bump,
      overridePackageDesktop: plan.packageDesktop,
    };
    const title = plan.title?.trim();
    const decision = assessReleaseImpact({
      ...assessment,
      titledPatch: !!title,
    });
    if (
      actual &&
      releaseBumps.indexOf(decision.bump) <
        releaseBumps.indexOf(decision.recommendedBump)
    )
      throw Error(
        "Finalization requires at least " +
          decision.recommendedBump +
          "; downgrade only in assess or run --dry-run",
      );
    if (actual && plan.packageDesktop === false)
      throw Error(
        "--package-desktop false is only permitted in assess or run --dry-run",
      );
    if (actual && decision.bump === "none" && diff.incompleteAssessment)
      throw Error("Incomplete assessment: " + diff.warnings.join(", "));
    if (command === "assess" || decision.bump === "none") {
      print(
        {
          ...decision,
          workspace: diff,
          ...(actual ? { gatesExecuted: [] } : {}),
        },
        currentVersion + " → " + decision.nextVersion,
        values.json,
      );
      return;
    }
    if (decision.bump === "major" && !flags.confirmMajor)
      throw Error("主版本发布需要 --confirm-major 显式确认");
    const migrationNotes = plan.migrationNotes?.trim();
    if (actual && decision.bump === "major" && !migrationNotes)
      throw Error("Major release requires --migration-notes");
    const summary = plan.summary?.trim() ?? "";
    if (
      !summary &&
      !(
        !decision.publishInReleaseNotes &&
        !title &&
        plan.changelog?.some((b) => b.trim())
      )
    )
      throw Error("发布需要非空的 --summary");
    if (decision.publishInReleaseNotes && !title)
      throw Error("公开版本需要非空的 --title");
    if (title && !decision.publishInReleaseNotes)
      throw Error("公开补丁与 publicPatch: false 冲突");
    const version = decision.nextVersion,
      date = getShanghaiDate();
    const migration =
      decision.bump === "major" && migrationNotes
        ? ["迁移说明：" + migrationNotes]
        : [];
    const entry = {
      version,
      date,
      title,
      summary,
      highlights: migration.length
        ? [...(plan.highlights ?? []), ...migration]
        : plan.highlights,
    };
    const bullets = [
      ...(plan.changelog ?? [summary, ...(plan.highlights ?? [])]),
      ...migration,
    ];
    if (decision.packageDesktop)
      ensureAvailable(root, version, flags.allowRepackage);
    if (actual && diff.incompleteAssessment)
      throw Error("Incomplete assessment: " + diff.warnings.join(", "));
    const before = verifyReleaseMetadataSync(root);
    if (!before.ok) throw Error(before.errors.join("\n"));
    const previousDmgPath = listReleaseDmgs(root).find(
      (d) => compareSemVer(d.version, version) < 0,
    )?.path;
    const previousDmgSha256 = previousDmgPath
      ? await sha256File(previousDmgPath)
      : undefined;
    const files: MetadataFile[] = [];
    for (const name of metadataNames) {
      if (name === "package-lock.json" && !occupied(workspacePath(root, name)))
        continue;
      const file = regularFile(root, name),
        st = statSync(file),
        original = read(root, name);
      if (
        name === "package.json" &&
        JSON.parse(original).version !== currentVersion
      )
        throw Error("package.json changed during assessment");
      let written =
        name === "package.json"
          ? applyPackageVersionUpdate(original, version)
          : name === "package-lock.json"
            ? applyPackageLockVersionUpdate(original, version)
            : name.endsWith(".md")
              ? applyChangelogUpdate(original, { version, date, bullets })
              : applyReleaseNotesUpdate(original, entry);
      // Format in memory. The journal contains the exact bytes before the first rename.
      if (!actual && !name.endsWith(".md"))
        written = await prettier.format(written, {
          ...(await prettier.resolveConfig(file)),
          filepath: file,
        });
      files.push({
        name,
        original,
        originalSha256: hash(original),
        written,
        writtenSha256: hash(written),
        mode: st.mode & 0o777,
        atimeMs: st.atimeMs,
        mtimeMs: st.mtimeMs,
      });
    }
    const evidenceOut = path.join(
      "docs/evidence",
      date,
      "desktop-" + version + ".json",
    );
    const baseline = readReleaseManifest(root);
    const tx: Transaction = {
      stage: "metadata",
      decision,
      targetVersion: version,
      releaseEntry: {
        ...entry,
        ...(migration.length ? { migrationNotes } : {}),
      },
      changelog: bullets,
      metadata: files,
      previousDmgPath,
      previousDmgSha256,
      evidenceOut,
      evidenceParents: publicationParents(root, evidenceOut),
      stagingDir: path.join(state, "staging-" + version + "-" + randomUUID()),
      priorShippedInitiatives: [
        ...new Set([
          ...(baseline.lastRelease?.priorShippedInitiatives ?? []),
          ...(baseline.lastRelease?.shippedInitiatives ?? []),
          ...diff.previouslyCompletedInitiatives,
        ]),
      ].sort(),
      gatesExecuted: [],
      originalManifest,
      sourceHashes: frozen ?? {},
      gitHead: frozenHead,
      targetHashes: {},
    };
    if (!actual) {
      print(
        {
          decision,
          releaseEntry: tx.releaseEntry,
          changelog: bullets,
          filesToUpdate: files.map((f) => f.name),
          commands: [
            ...gates(root, decision.bump === "major"),
            ...(decision.packageDesktop
              ? [
                  [
                    "electron-builder",
                    ...builderArgs(root, path.join(root, tx.stagingDir)),
                  ],
                  ["verify-dmg"],
                ]
              : []),
          ],
          targetArtifacts: decision.packageDesktop
            ? [...filenames(version).map((n) => "release/" + n), evidenceOut]
            : [],
          previousDmgPath,
          previousDmgSha256,
        },
        "发版演练。",
        values.json,
      );
      return;
    }
    if (decision.packageDesktop) {
      if (
        (process.platform !== "darwin" || process.arch !== "arm64") &&
        !hooks.verify
      )
        throw Error("桌面 DMG 打包与验收需要 macOS");
      evidenceTarget(root, evidenceOut, flags.overwriteEvidence);
      for (const target of [
        ...filenames(version).map((n) => "release/" + n),
        evidenceOut,
      ]) {
        if (occupied(workspacePath(root, target)))
          tx.targetHashes[target] = await sha256File(regularFile(root, target));
      }
    }
    if (
      diffHashes(tx.sourceHashes, sourceHashes(root)).length ||
      files.some((f) => tx.sourceHashes[f.name] !== f.originalSha256)
    )
      throw Error("Source changed during assessment; assess again");
    if (decision.packageDesktop) {
      const dist = electronDistribution(root, flags, hooks);
      if (dist && (await sha256File(dist.file)) !== dist.expected)
        throw Error("Electron distribution checksum mismatch: " + dist.file);
      await checkDmgbuildCache(root, flags, hooks);
      await check7zipCache(root, flags, hooks);
    }
    try {
      const checkout = copyFrozenCheckout(root, tx);
      for (const f of tx.metadata) {
        if (f.name.endsWith(".md")) continue;
        const file = regularFile(checkout, f.name);
        const config = await prettier.resolveConfigFile(file);
        f.written = await prettier.format(f.written, {
          ...(config && config.startsWith(checkout + path.sep)
            ? await prettier.resolveConfig(file, { config, useCache: false })
            : {}),
          filepath: file,
        });
        f.writtenSha256 = hash(f.written);
      }
      persist(root, tx);
    } catch (err) {
      rmSync(workspacePath(root, tx.stagingDir), {
        recursive: true,
        force: true,
      });
      throw err;
    }
    print(
      await execute(root, tx, flags, hooks, true),
      "发布完成。",
      values.json,
    );
  } finally {
    unlock?.();
  }
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
