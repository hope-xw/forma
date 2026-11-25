import assert from "node:assert/strict";
import {
  execFileSync,
  spawnSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  openSync,
  fstatSync,
  closeSync,
  readSync,
  rmSync,
  unlinkSync,
  chmodSync,
  copyFileSync,
  constants,
  lstatSync,
  statSync,
  realpathSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { blake2b } from "@noble/hashes/blake2.js";
import path from "node:path";
import { runInThisContext } from "node:vm";
import { _electron, type Page } from "playwright";
import { z } from "zod";
import { compareSemVer, parseSemVer } from "./policy";
import { getShanghaiDate, verifyReleaseMetadataSync } from "./release-files";
import {
  atomicWrite,
  replaceCheckedFile,
  publicationParents,
  assertChildExited,
  startReleaseChild,
  isInside,
  listReleaseDmgs,
  manifestPath,
  regularFile,
  readReleaseManifest,
  workspacePath,
} from "./workspace-diff";

export interface VerifyDmgOptions {
  repoRoot: string;
  referenceRoot?: string;
  pinnedOutputHashes?: Record<string, string>;
  requireAdhocSignature?: boolean;
  version: string;
  dmgPath?: string;
  expectedDmgSha256?: string;
  previousDmgPath?: string;
  previousDmgSha256?: string;
  evidenceOut?: string;
  trustExternalDmg?: boolean;
  allowOverwriteEvidence?: boolean;
  deferEvidence?: boolean;
  execFile?: (
    program: string,
    args: string[],
    options: ExecFileSyncOptionsWithStringEncoding,
  ) => string;
  runLiveChecks?: typeof checkMountedApp;
}
interface Fingerprint {
  bytes: number;
  sha256: string;
}
export interface DesktopVerificationEvidence {
  version: string;
  date: string;
  electron: string;
  plistVersion: string;
  signature: string;
  signatureDetails: { verified: true; adhoc: boolean; identifier: string };
  readOnlyDmg: true;
  zipMatchesDmgBundle: true;
  previousDmgIntact: boolean | null;
  previousDmg?: {
    filename: string;
    sha256: string;
    baseline: "pre-build" | "verification-start";
  };
  distribution: (Fingerprint & { filename: string })[];
  matchingWebAndApp: Record<string, string>;
  bundledServices: Record<string, Fingerprint>;
  releaseNotesChecked: true;
  releaseNotesResult: Record<string, unknown>;
  agentServiceChecks: Awaited<ReturnType<typeof checkAgent>>;
  desktopOpenFileResult: Record<string, unknown>;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function fingerprint(file: string): Promise<Fingerprint> {
  return { bytes: (await stat(file)).size, sha256: await sha256File(file) };
}

async function distFiles(root: string, relative = "dist"): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await distFiles(root, name)));
    else if (entry.isFile()) files.push(name);
    else throw Error("dist 含非普通文件：" + name);
  }
  return files.sort();
}

const packagedInputs = [
  "dist",
  "electron",
  "out-electron/agent-service.mjs",
  "out-electron/library-service.mjs",
  "package.json",
];
export async function outputHashes(root: string, groups = packagedInputs) {
  const hashes: Record<string, string> = {};
  for (const group of groups) {
    const dir = workspacePath(root, group);
    const files = lstatSync(dir).isDirectory()
      ? await distFiles(root, group)
      : [group];
    if (!files.length) throw Error("Empty build output: " + group);
    for (const file of files)
      hashes[file] = await sha256File(regularFile(root, file));
  }
  return hashes;
}
export async function assertPinnedOutputs(
  root: string,
  pins: Record<string, string>,
) {
  assert.deepEqual(
    await outputHashes(root),
    pins,
    "Build outputs differ from pinned compilation",
  );
}
export function validateAsarHeader(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const prefix = Buffer.alloc(16);
    assert.equal(readSync(fd, prefix), 16, "Short ASAR header");
    const outer = prefix.readUInt32LE(4),
      length = prefix.readUInt32LE(12);
    assert.ok(
      prefix.readUInt32LE() === 4 &&
        length > 0 &&
        outer <= 16 * 1024 ** 2 &&
        outer === 8 + Math.ceil(length / 4) * 4 &&
        prefix.readUInt32LE(8) === outer - 4,
      "Invalid ASAR header length",
    );
    const bodySize = fstatSync(fd).size - outer - 8;
    assert.ok(bodySize >= 0, "Truncated ASAR");
    const bytes = Buffer.alloc(length);
    assert.equal(readSync(fd, bytes), length, "Truncated ASAR header");
    const header = JSON.parse(bytes.toString("utf8"));
    let count = 0,
      total = 0;
    function visit(files: unknown, depth: number) {
      assert.ok(
        depth <= 128 &&
          files &&
          typeof files === "object" &&
          !Array.isArray(files),
        "Invalid ASAR directory",
      );
      const names = new Set<string>();
      for (const [name, node] of Object.entries(files)) {
        const key = name.normalize("NFD").toLowerCase();
        assert.ok(
          name &&
            !/[\/\\:\x00-\x1f]/.test(name) &&
            name !== "." &&
            name !== ".." &&
            !names.has(key),
          "Unsafe ASAR path",
        );
        names.add(key);
        assert.ok(++count <= 20_000, "ASAR entry count exceeds limit");
        assert.ok(
          node &&
            typeof node === "object" &&
            !node.unpacked &&
            !Object.hasOwn(node, "link"),
          "Unexpected ASAR entry type",
        );
        if (Object.hasOwn(node, "files")) {
          assert.ok(!Object.hasOwn(node, "size"), "Ambiguous ASAR entry");
          visit(node.files, depth + 1);
        } else {
          const { size, offset } = node;
          assert.ok(
            Number.isSafeInteger(size) && size >= 0,
            "Invalid ASAR size",
          );
          total += size;
          assert.ok(
            total <= 512 * 1024 ** 2,
            "ASAR declared size exceeds limit",
          );
          assert.ok(
            typeof offset === "string" &&
              /^\d+$/.test(offset) &&
              Number(offset) + size <= bodySize,
            "Invalid ASAR offset",
          );
        }
      }
    }
    visit(header.files, 0);
  } finally {
    closeSync(fd);
  }
}

async function checkAgent(page: Page) {
  const route = (name: string, post = false) =>
    page.evaluate(
      async ({ name, post }) => {
        const res = await fetch("/api/agent/" + name, {
          method: post ? "POST" : "GET",
          headers: post ? { "Content-Type": "application/json" } : undefined,
          body: post ? "{}" : undefined,
          signal: AbortSignal.timeout(15_000),
        });
        return { status: res.status, body: (await res.json()) as unknown };
      },
      { name, post },
    );
  const providers = await route("providers");
  assert.equal(providers.status, 200, "GET providers");
  const { providers: catalog } = z
    .object({ providers: z.array(z.unknown()).min(13) })
    .parse(providers.body);
  const status = await route("status");
  assert.equal(status.status, 200, "GET status");
  const { configured } = z
    .object({ configured: z.literal(false) })
    .parse(status.body);
  const skills = await route("skills");
  assert.equal(skills.status, 200, "GET skills");
  const list = z
    .object({ skills: z.array(z.object({ source: z.string() })) })
    .parse(skills.body).skills;
  const builtinSkillsCount = list.filter((s) => s.source === "builtin").length;
  assert.ok(builtinSkillsCount >= 2, "至少两个内置技能");
  const invalidPost = async (name: string) => {
    const result = await route(name, true);
    assert.equal(result.status, 400, "POST " + name);
    z.object({ error: z.string().trim().min(1) }).parse(result.body);
    return result.status;
  };
  return {
    protocol: "forma:",
    providersStatus: providers.status,
    providerCount: catalog.length,
    statusCode: status.status,
    configuredInCleanProfile: configured,
    skillsStatus: skills.status,
    builtinSkillsCount,
    totalSkillsCount: list.length,
    critiqueRouteStatus: await invalidPost("critique"),
    critiqueRouteHasErrorField: true,
    libraryPlaybookRouteStatus: await invalidPost("library-playbook"),
    libraryPlaybookRouteHasErrorField: true,
  };
}

async function checkMountedApp(
  repoRoot: string,
  version: string,
  executablePath: string,
  work: string,
  env: Record<string, string>,
  recordChild: (pid: number) => void,
) {
  const expires = Date.now() + 180_000;
  const remaining = () => Math.max(1, expires - Date.now());
  const metadata = verifyReleaseMetadataSync(repoRoot);
  assert.ok(
    metadata.ok && metadata.latestPublicVersion,
    metadata.errors.join("\n") || "缺少公开版本日志",
  );
  const app = await _electron.launch({
    executablePath,
    args: [
      "--forma-offscreen-qa",
      "--user-data-dir=" + path.join(work, "profile"),
    ],
    cwd: work,
    env,
    timeout: Math.min(30_000, remaining()),
  });
  const child = app.process();
  if (child.pid) recordChild(child.pid);
  async function workflow() {
    const page = await app.firstWindow({ timeout: 30_000 });
    page.setDefaultTimeout(30_000);
    await page.locator(".editor-canvas").waitFor();
    const info = await page.evaluate(() => ({
      version: window.formaDesktop?.version,
      protocol: location.protocol,
      host: location.host,
    }));
    assert.deepEqual(info, { version, protocol: "forma:", host: "app" });
    const electron = await app.evaluate(() => process.versions.electron);
    const agentServiceChecks = await checkAgent(page);
    const filename = path.join(
      repoRoot,
      "scripts/check-release-notes.browser.js",
    );
    const run = runInThisContext(await readFile(filename, "utf8"), {
      filename,
    });
    const releaseNotesResult = z
      .record(z.string(), z.unknown())
      .parse(await run(page));
    await page.getByLabel("文件菜单", { exact: true }).click();
    const menuEntry = page.getByRole("button", { name: /Forma v.*版本日志/ });
    assert.ok(
      (await menuEntry.innerText()).includes("Forma v" + version + " ·"),
    );
    await menuEntry.click();
    const dialog = page.getByRole("dialog", { name: "版本日志", exact: true });
    await dialog.getByText("当前版本 v" + version, { exact: true }).waitFor();
    const latest = dialog
      .getByRole("listitem")
      .first()
      .locator(".release-number span");
    assert.equal(await latest.innerText(), "v" + metadata.latestPublicVersion);
    return {
      electron,
      agentServiceChecks,
      releaseNotesResult: {
        ...releaseNotesResult,
        currentVersion: version,
        latestPublicVersion: metadata.latestPublicVersion,
      },
    };
  }
  try {
    // Launch has its own 30s timeout. Reserve 10s for teardown inside the 180s budget.
    return await deadline(workflow(), Math.max(1, remaining() - 10_000));
  } finally {
    try {
      await deadline(
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
        ),
        Math.min(5_000, remaining()),
      );
    } finally {
      try {
        await deadline(app.close(), Math.min(5_000, remaining()));
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    }
  }
}
async function deadline<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Mounted QA deadline exceeded")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function evidenceTarget(root: string, name: string, overwrite = false) {
  const target = workspacePath(root, name);
  const base = workspacePath(root, "docs/evidence");
  if (
    !isInside(base, target) ||
    path.extname(target) !== ".json" ||
    target.toLowerCase() ===
      path.join(realpathSync(root), manifestPath).toLowerCase()
  )
    throw Error("Expected a JSON receipt inside docs/evidence: " + target);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing && (!overwrite || !existing.isFile()))
    throw Error(
      "Evidence exists; overwriting requires --allow-overwrite-evidence: " +
        target,
    );
  return target;
}
export function writeEvidence(
  root: string,
  name: string,
  evidence: DesktopVerificationEvidence,
  overwrite = false,
  baseline?: {
    sha256?: string;
    parents: ReturnType<typeof publicationParents>;
  },
) {
  const file = evidenceTarget(root, name, overwrite);
  const expected = !overwrite
    ? undefined
    : baseline
      ? baseline.sha256
      : lstatSync(file, { throwIfNoEntry: false })
        ? createHash("sha256")
            .update(readFileSync(regularFile(root, file)))
            .digest("hex")
        : undefined;
  replaceCheckedFile(
    root,
    file,
    JSON.stringify(evidence, null, 2) + "\n",
    expected,
    { mode: 0o700, keepBackup: overwrite, parents: baseline?.parents },
  );
}

function mountedPath(
  mount: string,
  relative: string,
  directory = false,
  mountDev = statSync(mount).dev,
) {
  const file = realpathSync(path.join(mount, relative));
  const st = statSync(file);
  assert.ok(
    isInside(mount, file) &&
      st.dev === mountDev &&
      (directory ? st.isDirectory() : st.isFile()),
    "Invalid mounted bundle path: " + file,
  );
  return file;
}
// Compare the complete deliverable, including framework symlinks and helper
// executables. Never walk through a link or across the bundle's device.
async function compareBundles(
  mounted: string,
  zipped: string,
  message = "ZIP differs from DMG",
  archiveModes?: Map<string, number>,
) {
  const leftDevice = statSync(mounted).dev,
    rightDevice = statSync(zipped).dev;
  async function compare(relative: string) {
    const left = path.join(mounted, relative),
      right = path.join(zipped, relative);
    const a = lstatSync(left),
      b = lstatSync(right),
      label = message + ": " + relative;
    assert.ok(a.dev === leftDevice && b.dev === rightDevice, label);
    const mode = archiveModes?.get(
      path.join("Forma.app", relative).normalize("NFD").toLowerCase(),
    );
    if (mode !== undefined) assert.equal(a.mode & 0o7777, mode, label);
    if (a.isSymbolicLink()) {
      assert.ok(
        b.isSymbolicLink() &&
          isInside(mounted, realpathSync(left)) &&
          isInside(zipped, realpathSync(right)),
        label,
      );
      assert.equal(readlinkSync(left), readlinkSync(right), label);
    } else if (a.isDirectory()) {
      assert.ok(
        b.isDirectory() && (a.mode & 0o7777) === (b.mode & 0o7777),
        label,
      );
      const names = (await readdir(left)).sort();
      assert.deepEqual((await readdir(right)).sort(), names, label);
      for (const name of names) await compare(path.join(relative, name));
    } else {
      assert.ok(
        a.isFile() &&
          b.isFile() &&
          a.size === b.size &&
          (a.mode & 0o7777) === (b.mode & 0o7777),
        label,
      );
      assert.equal(await sha256File(left), await sha256File(right), label);
    }
  }
  await compare("");
}
function receiptDmgDigest(root: string, version: string, filename: string) {
  const base = workspacePath(root, "docs/evidence");
  if (!lstatSync(base, { throwIfNoEntry: false })?.isDirectory()) return;
  const digests = new Set<string>();
  for (const day of readdirSync(base, { withFileTypes: true })) {
    if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
    const file = workspacePath(
      root,
      path.join(base, day.name, "desktop-" + version + ".json"),
    );
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    const receipt = z
      .object({
        version: z.string(),
        distribution: z.array(
          z.object({
            filename: z.string(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          }),
        ),
      })
      .safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (receipt.success && receipt.data.version === version) {
      const artifact = receipt.data.distribution.find(
        (f) => f.filename === filename,
      );
      if (artifact) digests.add(artifact.sha256);
    }
  }
  if (digests.size > 1)
    throw Error("Conflicting archived DMG fingerprints for " + version);
  return [...digests][0];
}
export function checkRuntimeManifest(
  workspaceRaw: string,
  packagedRaw: string,
) {
  const manifest = z.record(z.string(), z.unknown());
  const workspace = manifest.parse(JSON.parse(workspaceRaw)),
    packaged = manifest.parse(JSON.parse(packagedRaw));
  for (const key of new Set([
    "name",
    "version",
    "description",
    "author",
    "main",
    "type",
    "private",
    "exports",
    "dependencies",
    "imports",
    "bin",
    ...Object.keys(packaged),
  ]))
    assert.deepEqual(
      packaged[key],
      workspace[key],
      "app.asar package.json: " + key,
    );
}

const blockmapSchema = z.object({
  version: z.literal("2"),
  files: z.tuple([
    z.object({
      name: z.string(),
      offset: z.literal(0),
      size: z.number().int().positive().optional(),
      checksums: z.array(z.string().trim().min(1)).nonempty(),
      sizes: z.array(z.number().int().positive()).nonempty(),
    }),
  ]),
});
export function verifyBlockmap(
  filename: string,
  artifact: string,
  compressed: Buffer,
) {
  const limit = 16 * 1024 * 1024;
  assert.ok(compressed.length <= limit, "Compressed blockmap exceeds limit");
  const {
    files: [file],
  } = blockmapSchema.parse(
    JSON.parse(
      gunzipSync(compressed, { maxOutputLength: limit }).toString("utf8"),
    ),
  );
  const total = file.sizes.reduce((n, size) => n + size, 0);
  // Builder v2 uses the logical name "file" and implicit size. Bind that
  // representation to the named artifact by checking its actual block bytes.
  if (file.name === "file" && file.size === undefined) {
    file.name = filename;
    file.size = total;
  }
  assert.equal(file.name, filename, "Blockmap artifact filename");
  assert.equal(file.size, statSync(artifact).size, "Blockmap artifact size");
  assert.equal(total, file.size, "Blockmap expanded size");
  assert.equal(
    file.checksums.length,
    file.sizes.length,
    "Blockmap checksum count",
  );
  const fd = openSync(artifact, "r");
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (const [i, size] of file.sizes.entries()) {
      const digest = blake2b.create({ dkLen: 18 });
      let remaining = size;
      while (remaining) {
        const n = readSync(fd, buf, 0, Math.min(remaining, buf.length), null);
        assert.ok(n > 0, "Short blockmap artifact");
        digest.update(buf.subarray(0, n));
        remaining -= n;
      }
      assert.equal(
        Buffer.from(digest.digest()).toString("base64"),
        file.checksums[i],
        "Blockmap checksum for " + filename,
      );
    }
  } finally {
    closeSync(fd);
  }
}
function parseUnixMode(permissions: string) {
  assert.match(
    permissions,
    /^[r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-]$/,
    "Invalid UNIX ZIP permissions",
  );
  let mode = 0;
  for (let i = 0; i < 9; i++) {
    if ("rwxst".includes(permissions[i])) mode |= 1 << (8 - i);
  }
  if (/[sS]/.test(permissions[2])) mode |= 0o4000;
  if (/[sS]/.test(permissions[5])) mode |= 0o2000;
  if (/[tT]/.test(permissions[8])) mode |= 0o1000;
  return mode;
}
export function validateZipInventory(listing: string) {
  const lines = listing.trimEnd().split(/\r?\n/);
  assert.match(lines[0], /^Archive: /);
  const count = Number(
    /^Zip file size: \d+ bytes, number of entries: (\d+)$/.exec(lines[1])?.[1],
  );
  assert.ok(
    count > 0 && count <= 50_000 && lines.length === count + 3,
    "Invalid ZIP entry count",
  );
  let bytes = 0;
  const paths = new Map<string, string>();
  const modes = new Map<string, number>();
  for (const line of lines.slice(2, -1)) {
    const match =
      /^([-dl])(\S*)\s+\S+\s+(\S+)\s+(\d+)\s+\S+\s+\d+\s+\S+\s+\d{8}\.\d{6} (.+)$/.exec(
        line,
      );
    assert.ok(match, "Invalid ZIP inventory entry: " + line);
    const [, type, permissions, host, size, raw] = match,
      name = raw.replace(/\/$/, "").normalize("NFD").toLowerCase();
    assert.ok(
      raw.startsWith("Forma.app/") &&
        !raw.includes("\\") &&
        !/[\x00-\x1f\x7f]/.test(raw) &&
        !name.split("/").some((p) => !p || p === "." || p === "..") &&
        !paths.has(name),
      "Unexpected ZIP entry: " + raw,
    );
    paths.set(name, type);
    if (type !== "l" && (host === "unx" || permissions.length === 9))
      modes.set(name, parseUnixMode(permissions));
    bytes += Number(size);
    assert.ok(bytes <= 2 * 1024 ** 3, "ZIP expanded size exceeds 2 GiB");
  }
  for (const name of paths.keys()) {
    for (
      let parent = path.dirname(name);
      parent !== ".";
      parent = path.dirname(parent)
    )
      assert.ok(
        !paths.has(parent) || paths.get(parent) === "d",
        "Non-directory ZIP ancestor: " + parent,
      );
  }
  const summary = /^(\d+) files?, (\d+) bytes uncompressed,/.exec(
    lines.at(-1)!,
  );
  assert.ok(
    summary && Number(summary[1]) === count && Number(summary[2]) === bytes,
    "Invalid ZIP totals",
  );
  return modes;
}
const associations = new Map([
  ["forma", ["Editor", "Default"]],
  ["forma.json", ["Editor", "Default"]],
  ["sketch", ["Viewer", "Alternate"]],
  ["fig", ["Viewer", "Alternate"]],
]);
const mountJournal = "output/release-state/active-mount.json";
const mountState = z.object({
  ownedDmg: z.string(),
  owner: z.number().int().positive(),
  devEntry: z
    .string()
    .regex(/^\/dev\/disk\d+(?:s\d+)*$/)
    .optional(),
  mountPoint: z.string().optional(),
  childPid: z.number().int().positive().optional(), // older journals
  helperPids: z.array(z.number().int().gt(1)).default([]),
  electronPids: z.array(z.number().int().gt(1)).default([]),
});
const entitiesSchema = z.array(
  z.object({
    "dev-entry": z.string().optional(),
    "mount-point": z.string().optional(),
  }),
);
type CommandRunner = NonNullable<VerifyDmgOptions["execFile"]>;
function importElectronPid(work: string) {
  const file = path.join(work, "import-electron.pid");
  if (!lstatSync(file, { throwIfNoEntry: false })) return;
  const raw = readFileSync(regularFile(work, file), "utf8");
  if (!raw) return;
  return z.coerce.number().int().gt(1).parse(raw);
}
export function reconcileActiveMount(
  root: string,
  run: CommandRunner = execFileSync,
) {
  const file = workspacePath(root, mountJournal);
  if (!lstatSync(file, { throwIfNoEntry: false })) return;
  const record = mountState.parse(
    JSON.parse(readFileSync(regularFile(root, file), "utf8")),
  );
  if (record.owner !== process.pid) assertChildExited(record.owner);
  assertChildExited(record.childPid);
  const work = path.dirname(record.ownedDmg);
  assert.ok(
    path.dirname(work) === workspacePath(root, "output/release-state") &&
      /^verifier-[\w-]+$/.test(path.basename(work)) &&
      path.basename(record.ownedDmg) === "verified.dmg" &&
      workspacePath(root, record.ownedDmg) === record.ownedDmg,
    "Invalid owned mount path",
  );
  const opts = { encoding: "utf8" as const, timeout: 30_000, cwd: root };
  function ownedImages() {
    const xml = run("/usr/bin/hdiutil", ["info", "-plist"], opts);
    const info = z
      .object({
        images: z.array(
          z.object({
            "image-path": z.string(),
            "system-entities": entitiesSchema,
          }),
        ),
      })
      .parse(
        JSON.parse(
          run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
            ...opts,
            input: xml,
          }),
        ),
      );
    return info.images.filter(
      (image) => image["image-path"] === record.ownedDmg,
    );
  }
  const images = ownedImages();
  const mounts = images.flatMap((image) =>
    image["system-entities"].flatMap((e) => e["mount-point"] ?? []),
  );
  const inner = importElectronPid(work);
  if (inner && !record.electronPids.includes(inner)) {
    record.electronPids.push(inner);
    atomicWrite(file, JSON.stringify(record), true);
  }
  const recorded = new Set([...record.helperPids, ...record.electronPids]);
  function ownedProcesses() {
    const output = run("/bin/ps", ["-axww", "-o", "pid=,stat=,command="], opts);
    return output.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match || match[2].startsWith("Z")) return [];
      const pid = Number(match[1]),
        cmd = match[3];
      const mounted = mounts.some((m) =>
        cmd.startsWith(path.join(m, "Forma.app") + path.sep),
      );
      // Validate the process command against the private work directory / image
      // before signaling a journaled PID which the OS may already have reused.
      if (mounted || (recorded.has(pid) && cmd.includes(work + path.sep))) {
        assert.ok(pid > 1 && pid !== process.pid, "Invalid owned process");
        return [pid];
      }
      return [];
    });
  }
  for (const signal of ["-TERM", "-KILL"]) {
    const alive = ownedProcesses();
    if (!alive.length) break;
    for (const pid of alive) {
      try {
        run("/bin/kill", [signal, String(pid)], opts);
      } catch (err) {
        if (ownedProcesses().includes(pid)) throw err;
      }
    }
    const until = Date.now() + 1500;
    while (ownedProcesses().length && Date.now() < until)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.deepEqual(ownedProcesses(), [], "Mounted QA child is still alive");
  for (const image of ownedImages()) {
    const entries = image["system-entities"];
    const dev =
      entries
        .map((e) => e["dev-entry"])
        .find((d) => d && /^\/dev\/disk\d+$/.test(d)) ??
      entries.find((e) => e["dev-entry"])?.["dev-entry"];
    assert.ok(
      dev && /^\/dev\/disk\d+(?:s\d+)*$/.test(dev),
      "No owned DMG device",
    );
    const mount = entries.find((e) => e["mount-point"])?.["mount-point"];
    if (mount && record.mountPoint === mount) {
      try {
        run("/usr/bin/hdiutil", ["detach", mount], opts);
        continue;
      } catch {
        /* retry the owned mount */
      }
      try {
        run("/usr/bin/hdiutil", ["detach", "-force", mount], opts);
        continue;
      } catch {
        /* retry by device */
      }
    }
    run("/usr/bin/hdiutil", ["detach", "-force", dev], opts);
  }
  assert.equal(ownedImages().length, 0, "Owned DMG remains attached");
  unlinkSync(file);
  rmSync(work, { recursive: true, force: true });
}

const plistFile = "Forma.app/Contents/Info.plist",
  asarFile = "Forma.app/Contents/Resources/app.asar",
  executableFile = "Forma.app/Contents/MacOS/Forma";
export async function verifyPackagedDmg(
  options: VerifyDmgOptions,
): Promise<DesktopVerificationEvidence> {
  if (process.platform !== "darwin" && !options.execFile)
    throw Error("只读 DMG 验收需要 macOS");
  const { version } = options;
  parseSemVer(version);
  const repoRoot = realpathSync(options.repoRoot);
  const reference = options.referenceRoot
    ? realpathSync(options.referenceRoot)
    : repoRoot;
  if (options.pinnedOutputHashes)
    await assertPinnedOutputs(reference, options.pinnedOutputHashes);
  const baseName = "Forma-" + version + "-arm64";
  const dmgPath = path.resolve(
    repoRoot,
    options.dmgPath ?? path.join("release", baseName + ".dmg"),
  );
  const zipPath = path.join(path.dirname(dmgPath), baseName + ".zip");
  function artifact(file: string) {
    if (!lstatSync(file).isFile())
      throw Error("Expected regular artifact: " + file);
    if (!options.trustExternalDmg) {
      regularFile(repoRoot, file);
      if (
        !["release", "output/release-state"].some((base) =>
          isInside(path.join(repoRoot, base), realpathSync(file)),
        )
      )
        throw Error("External DMG requires --trust-external-dmg: " + file);
    }
    return file;
  }
  artifact(dmgPath);
  artifact(zipPath);
  const predecessor = listReleaseDmgs(repoRoot).find(
    (d) => compareSemVer(d.version, version) < 0,
  )?.path;
  const previous = options.previousDmgPath
    ? path.resolve(repoRoot, options.previousDmgPath)
    : predecessor;
  if (options.previousDmgSha256 !== undefined && !previous)
    throw Error("--previous-sha256 requires a previous DMG");
  function checkPrevious() {
    if (!previous) return;
    const oldVersion = /^Forma-(.+)-arm64\.dmg$/.exec(
      path.basename(previous),
    )?.[1];
    const old = lstatSync(previous),
      current = lstatSync(dmgPath);
    assert.ok(
      oldVersion &&
        compareSemVer(oldVersion, version) < 0 &&
        old.isFile() &&
        (!predecessor ||
          realpathSync(previous) === realpathSync(predecessor)) &&
        realpathSync(previous) !== realpathSync(dmgPath) &&
        (old.dev !== current.dev || old.ino !== current.ino),
      "Invalid previous DMG: " + previous,
    );
  }
  checkPrevious();
  const previousSha256 = previous ? await sha256File(previous) : undefined;
  if (options.previousDmgSha256 !== undefined)
    assert.equal(
      previousSha256,
      options.previousDmgSha256,
      "前序 DMG 的 SHA-256 已改变",
    );
  const date = getShanghaiDate();
  const evidenceOut = evidenceTarget(
    repoRoot,
    options.evidenceOut ??
      path.join("docs/evidence", date, "desktop-" + version + ".json"),
    options.allowOverwriteEvidence,
  );
  const parents = publicationParents(repoRoot, evidenceOut);
  const evidenceBaseline = lstatSync(evidenceOut, { throwIfNoEntry: false })
    ? await sha256File(regularFile(repoRoot, evidenceOut))
    : undefined;
  const deliveryFiles = [
    dmgPath,
    zipPath,
    dmgPath + ".blockmap",
    zipPath + ".blockmap",
  ];
  const desktop = readReleaseManifest(repoRoot).lastDesktopRelease;
  const archived =
    desktop?.version === version && desktop.dmgFilename === baseName + ".dmg"
      ? desktop
      : undefined;
  const expected =
    options.expectedDmgSha256 ??
    (options.trustExternalDmg
      ? undefined
      : (archived?.dmgSha256 ??
        receiptDmgDigest(repoRoot, version, baseName + ".dmg")));
  let referenceBundle: string | undefined;
  if (expected === undefined && !options.trustExternalDmg) {
    // Standalone verification can also authenticate a fresh local desktop:build
    // against the unpacked app it produced, before launching either executable.
    referenceBundle = workspacePath(repoRoot, "release/mac-arm64/Forma.app");
    if (!lstatSync(referenceBundle, { throwIfNoEntry: false })?.isDirectory())
      throw Error(
        "No trusted build digest, archived receipt or local unpacked Forma.app; explicit trust requires --trust-external-dmg",
      );
  }
  const marker = workspacePath(repoRoot, mountJournal);
  mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
  const work = realpathSync(
    await mkdtemp(path.join(path.dirname(marker), "verifier-")),
  );
  const ownedDmg = path.join(work, "verified.dmg"),
    ownedZip = path.join(work, "verified.zip");
  const record: z.infer<typeof mountState> = {
    ownedDmg,
    owner: process.pid,
    helperPids: [],
    electronPids: [],
  };
  const saveMount = (replace = true) =>
    atomicWrite(marker, JSON.stringify(record), replace);
  const recordChild = (pid: number) => {
    record.helperPids.push(pid);
    saveMount();
  };
  const cleanEnv: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:" + path.dirname(process.execPath),
    HOME: path.join(work, "home"),
    TMPDIR: "/tmp",
  };
  for (const key of ["USER", "LOGNAME", "LANG", "LC_ALL"])
    if (process.env[key] !== undefined) cleanEnv[key] = process.env[key]!;
  const run = options.execFile ?? execFileSync;
  const command = (
    program: string,
    args: string[],
    timeout: number,
    extra: Partial<ExecFileSyncOptionsWithStringEncoding> = {},
  ) =>
    run(program, args, {
      encoding: "utf8",
      cwd: work,
      env: cleanEnv,
      timeout,
      killSignal: "SIGKILL",
      ...extra,
    });
  const plist = (args: string[], input?: string): unknown =>
    JSON.parse(
      command(
        "/usr/bin/plutil",
        ["-convert", "json", "-o", "-", ...args],
        30_000,
        { input },
      ),
    );
  let mountPoint: string | undefined, devEntry: string | undefined;
  let evidence: DesktopVerificationEvidence;
  let attachedAttempt = false;
  try {
    await mkdir(cleanEnv.HOME);
    for (const [i, owned] of [ownedDmg, ownedZip].entries()) {
      copyFileSync(artifact(deliveryFiles[i]), owned, constants.COPYFILE_EXCL);
      chmodSync(owned, 0o400);
    }
    const distribution = await Promise.all(
      [ownedDmg, ownedZip].map(async (f, i) => ({
        filename: path.basename(deliveryFiles[i]),
        ...(await fingerprint(f)),
      })),
    );
    if (expected !== undefined)
      assert.equal(
        distribution[0].sha256,
        expected,
        "DMG differs from trusted build digest",
      );
    for (const [i, owned] of [ownedDmg, ownedZip].entries()) {
      const file = artifact(deliveryFiles[i + 2]);
      assert.ok(statSync(file).size <= 16 * 1024 * 1024, "Oversize blockmap");
      const bytes = readFileSync(file);
      verifyBlockmap(distribution[i].filename, owned, bytes);
      distribution.push({
        filename: path.basename(file),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    saveMount(false);
    attachedAttempt = true;
    const attachArgs = ["attach", "-readonly", "-nobrowse", "-plist", ownedDmg];
    let xml: string;
    if (options.execFile) xml = command("/usr/bin/hdiutil", attachArgs, 60_000);
    else {
      const attach = startReleaseChild(
        "/usr/bin/hdiutil",
        attachArgs,
        work,
        cleanEnv,
        true,
        recordChild,
        true,
      );
      try {
        await deadline(attach.done, 60_000);
      } catch (err) {
        try {
          process.kill(-attach.pid, "SIGKILL");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        }
        await attach.done.catch(() => {});
        throw err;
      }
      xml = attach.output();
    }
    devEntry =
      /<key>dev-entry<\/key>\s*<string>(\/dev\/disk\d+(?:s\d+)*)<\/string>/.exec(
        xml,
      )?.[1];
    if (devEntry) {
      record.devEntry = devEntry;
      saveMount();
    }
    const entities = z
      .object({
        "system-entities": z.array(
          z.object({
            "mount-point": z.string().optional(),
            "dev-entry": z.string().optional(),
          }),
        ),
      })
      .parse(plist(["--", "-"], xml))["system-entities"];
    devEntry ??= entities.find((e) => e["dev-entry"])?.["dev-entry"];
    const mounts = entities.flatMap((e) =>
      e["mount-point"] ? [e["mount-point"]] : [],
    );
    assert.equal(mounts.length, 1, "DMG 必须含一个挂载卷");
    mountPoint = mounts[0];
    Object.assign(record, { mountPoint, devEntry });
    saveMount();
    const mount = realpathSync(mountPoint);
    const mountDev = statSync(mount).dev;
    const member = (name: string, directory = false) =>
      mountedPath(mount, name, directory, mountDev);
    const bundle = member("Forma.app", true);
    const info = member(plistFile),
      asar = member(asarFile),
      executable = member(executableFile);
    command(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", bundle],
      60_000,
    );
    let details: string;
    if (options.execFile)
      details = command("/usr/bin/codesign", ["-dvv", bundle], 30_000);
    else {
      const res = spawnSync("/usr/bin/codesign", ["-dvv", bundle], {
        cwd: work,
        env: cleanEnv,
        encoding: "utf8",
        timeout: 30_000,
      });
      if (res.status !== 0)
        throw Error("codesign -dvv failed: " + (res.error ?? res.stderr));
      details = res.stderr;
    }
    const identifier = /^Identifier=(.+)$/m.exec(details)?.[1];
    assert.equal(
      identifier,
      "com.forma.design",
      "Unexpected signing identifier",
    );
    const adhoc = /^Signature=adhoc$/m.test(details);
    if (options.requireAdhocSignature)
      assert.ok(adhoc, "Governed release requires an ad-hoc signature");
    assert.ok(
      adhoc || /^Authority=Developer ID Application: .+$/m.test(details),
      "Unexpected signing identity",
    );
    for (const license of ["LICENSE.electron.txt", "LICENSES.chromium.html"]) {
      const file = "Forma.app/Contents/Resources/" + license;
      assert.ok(
        lstatSync(path.join(mount, file)).isFile() &&
          statSync(member(file)).size > 0,
        "Missing bundle notice: " + license,
      );
    }
    assert.ok(
      !lstatSync(path.join(bundle, "Contents/Resources/default_app.asar"), {
        throwIfNoEntry: false,
      }),
      "Unexpected default_app.asar",
    );
    const { CFBundleShortVersionString: plistVersion, CFBundleDocumentTypes } =
      z
        .object({
          CFBundleShortVersionString: z.string(),
          CFBundleDocumentTypes: z.array(
            z.object({
              CFBundleTypeExtensions: z.tuple([z.string()]),
              CFBundleTypeRole: z.string(),
              LSHandlerRank: z.string(),
            }),
          ),
        })
        .parse(plist([info]));
    assert.equal(plistVersion, version, "Info.plist version");
    const actual = new Map(
      CFBundleDocumentTypes.map((t) => [
        t.CFBundleTypeExtensions[0],
        [t.CFBundleTypeRole, t.LSHandlerRank],
      ]),
    );
    for (const [ext, pair] of associations)
      assert.deepEqual(
        actual.get(ext),
        pair,
        "Wrong document association: " + ext,
      );
    assert.equal(
      CFBundleDocumentTypes.length,
      associations.size,
      "Unexpected document associations",
    );
    if (referenceBundle)
      await compareBundles(
        referenceBundle,
        bundle,
        "Mounted bundle differs from local build",
      );
    validateAsarHeader(asar);
    const extracted = path.join(work, "asar");
    command(
      process.execPath,
      [
        path.join(reference, "node_modules/@electron/asar/bin/asar.js"),
        "extract",
        asar,
        extracted,
      ],
      60_000,
    );
    workspacePath(extracted, "dist");
    const archivedPins =
      !options.pinnedOutputHashes &&
      archived?.dmgSha256 === distribution[0].sha256
        ? archived.buildOutputHashes
        : undefined;
    const pins =
      options.pinnedOutputHashes ??
      archivedPins ??
      (await outputHashes(reference));
    if (options.pinnedOutputHashes || archivedPins)
      assert.deepEqual(
        await distFiles(extracted, "."),
        Object.keys(pins).sort(),
        "Packaged output inventory differs from pinned compilation",
      );
    const files = Object.keys(pins)
      .filter((f) => f.startsWith("dist/"))
      .sort();
    assert.deepEqual(
      await distFiles(extracted),
      files,
      "app.asar 的 dist 文件清单不一致",
    );
    const matchingWebAndApp: Record<string, string> = {},
      bundledServices: Record<string, Fingerprint> = {};
    assert.deepEqual(
      await distFiles(extracted, "electron"),
      Object.keys(pins)
        .filter((f) => f.startsWith("electron/"))
        .sort(),
      "Packaged Electron inventory",
    );
    for (const [file, digest] of Object.entries(pins)) {
      if (file === "package.json") continue;
      const shipped = await fingerprint(regularFile(extracted, file));
      assert.equal(shipped.sha256, digest, file);
      if (file.startsWith("out-electron/")) bundledServices[file] = shipped;
      else matchingWebAndApp[file] = shipped.sha256;
    }
    const packagedManifest = regularFile(extracted, "package.json");
    const manifestDigest = await sha256File(packagedManifest);
    if (archivedPins) {
      assert.equal(
        manifestDigest,
        archivedPins["package.json"],
        "app.asar package.json differs from verified runtime manifest",
      );
    } else {
      try {
        const raw = readFileSync(
          regularFile(reference, "package.json"),
          "utf8",
        );
        assert.equal(
          createHash("sha256").update(raw).digest("hex"),
          pins["package.json"],
        );
        checkRuntimeManifest(raw, readFileSync(packagedManifest, "utf8"));
      } catch (err) {
        throw Error("app.asar package.json: " + err);
      }
    }
    matchingWebAndApp["package.json"] = manifestDigest;
    const archiveModes = validateZipInventory(
      command("/usr/bin/zipinfo", ["-l", "-T", ownedZip], 30_000, {
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
    const unpacked = path.join(work, "zip");
    await mkdir(unpacked);
    command("/usr/bin/ditto", ["-xk", ownedZip, unpacked], 120_000);
    await compareBundles(
      bundle,
      mountedPath(realpathSync(unpacked), "Forma.app", true),
      "ZIP differs from DMG",
      archiveModes,
    );
    const checks = await (options.runLiveChecks ?? checkMountedApp)(
      reference,
      version,
      executable,
      work,
      cleanEnv,
      (pid) => {
        record.electronPids.push(pid);
        saveMount();
      },
    );
    const resultFile = path.join(work, "open-file-result.json");
    const importArgs = [
      path.join(reference, "scripts/check-design-import-desktop.mjs"),
      "--verifier-pid-file=" + path.join(work, "import-electron.pid"),
      path.join(
        reference,
        "docs/evidence/2026-11-22/design-import/shared-paint.fig",
      ),
    ];
    const importEnv = {
      ...cleanEnv,
      FORMA_DESKTOP_EXECUTABLE: executable,
      FORMA_DESKTOP_RESULT_FILE: resultFile,
      FORMA_DESKTOP_PID_FILE: path.join(work, "import-electron.pid"),
    };
    if (options.execFile)
      command(process.execPath, importArgs, 180_000, { env: importEnv });
    else {
      const child = startReleaseChild(
        process.execPath,
        importArgs,
        work,
        importEnv,
        true,
        recordChild,
      );
      try {
        let timer: NodeJS.Timeout | undefined;
        try {
          const observed = new Promise<never>((_, reject) => {
            timer = setInterval(() => {
              try {
                const pid = importElectronPid(work);
                if (pid) {
                  record.electronPids.push(pid);
                  saveMount();
                  clearInterval(timer);
                }
              } catch (err) {
                reject(err);
              }
            }, 50);
          });
          await deadline(Promise.race([child.done, observed]), 180_000);
        } finally {
          clearInterval(timer);
        }
      } catch (err) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        }
        await child.done.catch(() => {});
        throw err;
      }
    }
    const desktopOpenFileResult = z
      .strictObject({
        version: z.literal(version),
        protocol: z.literal("forma:"),
        filename: z.literal("shared-paint.fig"),
        sha256: z.literal(
          "5ef901a1829f3013cfb218ec7a376ae4e6dc463314bd4b2586622089b3df8eab",
        ),
        format: z.literal("Figma"),
        pages: z.literal(1),
        sourceNodes: z.literal(6),
        pageNodes: z.literal(2),
        components: z.number().optional(),
        instances: z.number().optional(),
        pdfRasters: z.number().optional(),
        images: z.number().optional(),
        fonts: z.number().optional(),
        storageFormat: z.string().optional(),
      })
      .parse(JSON.parse(await readFile(regularFile(work, resultFile), "utf8")));
    evidence = {
      version,
      date,
      plistVersion,
      signature: "codesign --verify --deep --strict",
      signatureDetails: { verified: true, adhoc, identifier },
      readOnlyDmg: true,
      zipMatchesDmgBundle: true,
      previousDmgIntact: options.previousDmgSha256 !== undefined ? true : null,
      previousDmg:
        previous && previousSha256
          ? {
              filename: path.basename(previous),
              sha256: previousSha256,
              baseline:
                options.previousDmgSha256 !== undefined
                  ? "pre-build"
                  : "verification-start",
            }
          : undefined,
      distribution,
      matchingWebAndApp,
      bundledServices,
      releaseNotesChecked: true,
      ...checks,
      desktopOpenFileResult,
    };
  } finally {
    if (attachedAttempt) reconcileActiveMount(repoRoot, run);
    else await rm(work, { recursive: true, force: true });
  }
  checkPrevious();
  if (previous)
    assert.equal(
      await sha256File(previous),
      previousSha256,
      "验收期间前序 DMG 指纹改变",
    );
  for (const [i, file] of deliveryFiles.entries())
    assert.equal(
      await sha256File(artifact(file)),
      evidence.distribution[i].sha256,
      "Artifact changed during verification: " + file,
    );
  if (!options.deferEvidence)
    writeEvidence(
      repoRoot,
      evidenceOut,
      evidence,
      options.allowOverwriteEvidence,
      { sha256: evidenceBaseline, parents },
    );
  return evidence;
}
