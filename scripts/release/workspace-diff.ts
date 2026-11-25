import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  openSync,
  closeSync,
  linkSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { compareSemVer, normalizeChangedFiles, parseSemVer } from "./policy";

const hashes = z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/));
const release = {
  version: z.string().refine((v) => {
    parseSemVer(v);
    return true;
  }),
  date: z.string(),
  sourceHashes: hashes,
  packagePackagingSha256: z
    .string()
    .regex(/^(?:v2:)?[a-f0-9]{64}$/)
    .optional(),
};
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  lastRelease: z
    .strictObject({
      ...release,
      gitHead: z
        .string()
        .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
        .optional(),
      shippedInitiatives: z.array(z.string()),
      priorShippedInitiatives: z.array(z.string()).optional(),
    })
    .optional(),
  lastDesktopRelease: z
    .strictObject({
      ...release,
      buildOutputHashes: hashes.optional(),
      dmgFilename: z.string(),
      dmgSha256: z.string().regex(/^[a-f0-9]{64}$/),
      zipFilename: z.string(),
      zipSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});
export interface ReleaseManifest extends z.infer<typeof manifestSchema> {}
export const manifestPath = "docs/evidence/release-manifest.json";
// The child waits on a pipe before exec. If the journal owner dies before
// recording its process group, EOF makes the child exit without starting work.
export function startReleaseChild(
  program: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  quiet: boolean,
  record: (pid: number) => void,
  capture = false,
) {
  const child = spawn(
    "/usr/bin/python3",
    [
      "-I",
      "-c",
      'import os, sys\nif os.read(0, 1) != b"G": sys.exit(1)\nos.dup2(os.open(os.devnull, os.O_RDONLY), 0)\nos.execvpe(sys.argv[1], sys.argv[1:], os.environ)',
      program,
      ...args,
    ],
    {
      cwd,
      env,
      detached: true,
      stdio: [
        "pipe",
        capture ? "pipe" : quiet ? 2 : "inherit",
        quiet ? 2 : "inherit",
      ],
    },
  );
  let stdout = "";
  if (capture)
    child.stdout!.setEncoding("utf8").on("data", (s: string) => {
      stdout += s;
      if (stdout.length > 1024 * 1024) child.kill("SIGKILL");
    });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0
        ? resolve()
        : reject(Error(program + " exited with " + (signal ?? code))),
    );
  });
  void done.catch(() => {}); // A preview may exit before its readiness probe finishes.
  if (!child.pid) throw Error("Unable to launch " + program);
  try {
    record(child.pid);
    child.stdin!.on("error", () => {});
    child.stdin!.end("G");
  } catch (err) {
    child.stdin!.destroy();
    throw err;
  }
  return { pid: child.pid, done, output: () => stdout };
}
export function assertChildExited(pid: number | undefined) {
  if (!pid) return;
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw Error("Invalid release child PID");
  for (const id of [pid, -pid]) {
    try {
      process.kill(id, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw err;
    }
    throw Error(
      "Release child PID or process group " +
        pid +
        " is still alive; retry recovery after it exits",
    );
  }
}

export function isInside(parent: string, file: string) {
  const relative = path.relative(parent, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

// Inspect existing components individually, including dangling links. Missing
// descendants are rooted in the canonical nearest existing directory.
export function workspacePath(root: string, relative: string) {
  const base = realpathSync(root);
  let target = path.resolve(base, relative);
  // macOS spells temporary checkouts both /var/... and /private/var/....
  // Only rebase an alias of the checkout itself; then inspect every child.
  if (path.isAbsolute(relative) && !isInside(base, target)) {
    for (
      let ancestor = path.dirname(target);
      ancestor !== path.dirname(ancestor);
      ancestor = path.dirname(ancestor)
    ) {
      if (
        lstatSync(ancestor, { throwIfNoEntry: false }) &&
        realpathSync(ancestor) === base
      ) {
        target = path.join(base, path.relative(ancestor, target));
        break;
      }
    }
  }
  if (!isInside(base, target)) throw Error("Path outside workspace: " + target);
  let current = base;
  for (const segment of path.relative(base, target).split(path.sep)) {
    current = path.join(current, segment);
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (!st) break;
    if (
      st.isSymbolicLink() ||
      !isInside(base, realpathSync(current)) ||
      (current !== target && !st.isDirectory())
    )
      throw Error("Unsafe workspace path: " + current);
  }
  return target;
}
export function regularFile(root: string, relative: string) {
  const file = workspacePath(root, relative);
  if (!lstatSync(file).isFile()) throw Error("Expected regular file: " + file);
  return file;
}
export function atomicWrite(
  file: string,
  data: string,
  replace: boolean,
  mode = 0o600,
) {
  const temp = path.join(path.dirname(file), ".release-" + randomUUID());
  const fd = openSync(temp, "wx", mode);
  try {
    try {
      writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
    if (replace) renameSync(temp, file);
    else linkSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
// Node does not expose openat/linkat or atomic exchange. Keep directory FDs
// open throughout publication. An ordinary rename can destroy a third inode
// saved by an editor after our last stat, even with a hard-link snapshot.
const directoryWalk = String.raw`
import ctypes, fcntl, hashlib, json, os, shutil, stat, sys, uuid
req = json.loads(sys.argv[1])

directory = os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW
def identity(s):
    return [str(s.st_dev), str(s.st_ino)]
def open_dir(absolute, create=False):
    fd = os.open("/", directory)
    current = "/"
    for part in absolute.split("/"):
        if not part: continue
        current = os.path.join(current, part)
        pinned = req["parents"].get(current)
        if create and not pinned:
            try: os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError: pass
        child = os.open(part, directory, dir_fd=fd)
        if pinned and identity(os.fstat(child)) != pinned:
            raise RuntimeError("Concurrent parent directory replacement: " + current)
        os.close(fd)
        fd = child
    return fd
`;
export function readPlanBytes(file: string) {
  try {
    return execFileSync(
      "/usr/bin/python3",
      [
        "-I",
        "-c",
        directoryWalk +
          String.raw`
parent = open_dir(os.path.dirname(req["file"]))
fd = os.open(os.path.basename(req["file"]), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
with os.fdopen(fd, "rb") as stream:
    st = os.fstat(fd)
    limit = 1024 * 1024
    if not stat.S_ISREG(st.st_mode) or st.st_size > limit: raise ValueError("invalid plan")
    data = stream.read(limit + 1)
    if len(data) != st.st_size: raise ValueError("plan changed")
    sys.stdout.buffer.write(data)
`,
        JSON.stringify({ file, parents: {} }),
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 + 1,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (cause) {
    throw Error(
      "--plan must be a regular file of at most 1 MiB with no symlink ancestors",
      { cause },
    );
  }
}
const publishAt =
  directoryWalk +
  String.raw`
target = req["target"]
parent = os.path.dirname(target)
parentfd = open_dir(parent, True)
name = os.path.basename(target)
def check_parent():
    fd = open_dir(parent)
    try:
        if not os.path.samestat(os.fstat(fd), os.fstat(parentfd)):
            raise RuntimeError("Concurrent parent directory replacement: " + parent)
    finally: os.close(fd)
def info(fd, name):
    return os.stat(name, dir_fd=fd, follow_symlinks=False)
def digest(fd, name):
    fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=fd)
    with os.fdopen(fd, "rb") as f:
        if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError("Expected regular file")
        h = hashlib.sha256()
        for chunk in iter(lambda: f.read(1024 * 1024), b""): h.update(chunk)
        return h.hexdigest()
def link(srcfd, src, destfd, dest):
    os.link(src, dest, src_dir_fd=srcfd, dst_dir_fd=destfd, follow_symlinks=False)
private = open_dir(req["private"], True)
fcntl.flock(private, fcntl.LOCK_EX)
if os.path.exists(os.path.join(req["private"], ".reconciled")): raise RuntimeError("Publication already reconciled")
snap = name
proposed = ".prepared"
expected = req.get("expected")
def preserve(fd, file, label):
    dest = open_dir(req["conflicts"], True)
    try: link(fd, file, dest, name + "." + req["token"] + "." + label)
    finally: os.close(dest)
def conflict(fd=None, file=None):
    if expected is not None: preserve(private, snap, "snapshot")
    if fd is not None: preserve(fd, file, "displaced")
    raise RuntimeError("Concurrent edit preserved for " + target + "; recovery: " + req["conflicts"])
if expected is not None:
    link(parentfd, name, private, snap)
    original = info(private, snap)
    if not stat.S_ISREG(original.st_mode) or identity(original) != req["fileId"] or digest(private, snap) != expected:
        conflict()
# Standalone publication exchanges directly from private storage. Transactional
# sibling links always have a pre-journaled private inode on either side of swap.
tempfd = parentfd if req["sibling"] else private
temp = ".release-" + req["token"]
if req.get("remove"):
    os.rename(name, temp, src_dir_fd=parentfd, dst_dir_fd=tempfd)
else:
    if "source" in req:
        src = req["source"]
        sourcefd = open_dir(os.path.dirname(src))
        link(sourcefd, os.path.basename(src), private, proposed)
        os.close(sourcefd)
    else:
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW
        with os.fdopen(os.open(proposed, flags, req["mode"], dir_fd=private), "wb") as f:
            shutil.copyfileobj(sys.stdin.buffer, f)
            f.flush()
            os.fsync(f.fileno())
            if "times" in req: os.utime(f.fileno(), tuple(req["times"]))
    if req.get("newHash") and digest(private, proposed) != req["newHash"]: raise RuntimeError("Promotion source changed")
    check_parent()
    if expected is None:
        link(private, proposed, parentfd, name)
        check_parent()
        os.unlink(proposed, dir_fd=private)
        sys.exit(0)
    if not os.path.samestat(original, info(parentfd, name)) or digest(private, snap) != expected:
        conflict()
    link(private, proposed, tempfd, temp)
    libc = ctypes.CDLL(None, use_errno=True)
    swap = libc.renameatx_np if sys.platform == "darwin" else libc.renameat2
    if swap(tempfd, os.fsencode(temp), parentfd, os.fsencode(name), 2) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))
if not os.path.samestat(original, info(tempfd, temp)) or digest(tempfd, temp) != expected or digest(private, snap) != expected:
    if req.get("remove"):
        try: link(tempfd, temp, parentfd, name)
        except FileExistsError: pass
    conflict(tempfd, temp)
check_parent()
if req.get("keepBackup"): preserve(private, snap, "original")
os.unlink(temp, dir_fd=tempfd)
if not req.get("remove"): os.unlink(proposed, dir_fd=private)
# Keep snap linked even after the transaction, for a writer still holding its fd.
`;

// Capture existing ancestors at assessment/verification time, including when
// the date-specific evidence directory has yet to be created.
export function publicationParents(root: string, name: string) {
  const base = realpathSync(root),
    target = workspacePath(root, name);
  const parents: Record<string, string[]> = {};
  let current = base;
  for (const part of [
    "",
    ...path
      .relative(base, path.dirname(target))
      .split(path.sep)
      .filter(Boolean),
  ]) {
    current = path.join(current, part);
    const st = lstatSync(current, { bigint: true, throwIfNoEntry: false });
    if (!st) break;
    if (!st.isDirectory() || realpathSync(current) !== current)
      throw Error("Unsafe publication directory: " + current);
    parents[current] = [String(st.dev), String(st.ino)];
  }
  return parents;
}
type CheckedContent =
  | string
  | Buffer
  | { source: string; sha256: string }
  | { fd: number; sha256: string }
  | null;
export interface PublicationRecord {
  target: string;
  tempPath: string;
  token: string;
  expected?: string;
  parents?: ReturnType<typeof publicationParents>;
}
export function publicationPaths(root: string, record: PublicationRecord) {
  if (!/^[a-f0-9-]{36}$/.test(record.token))
    throw Error("Invalid publication token");
  const target = workspacePath(root, record.target);
  if (
    record.tempPath !==
    path.join(path.dirname(record.target), ".release-" + record.token)
  )
    throw Error("Invalid journal publication temp path");
  const directory = workspacePath(
    root,
    "output/release-state/displaced/" + record.token,
  );
  return {
    directory,
    snapshot: path.join(directory, path.basename(target)),
    proposed: path.join(directory, ".prepared"),
    temp: workspacePath(
      root,
      path.join(path.dirname(target), ".release-" + record.token),
    ),
  };
}
export function reconcilePublication(root: string, record: PublicationRecord) {
  const { temp, directory } = publicationPaths(root, record);
  const target = workspacePath(root, record.target);
  const request = {
    temp,
    directory,
    target,
    parents: record.parents ?? {},
    conflicts: workspacePath(root, "output/release-state/conflicts"),
  };
  execFileSync(
    "/usr/bin/python3",
    [
      "-I",
      "-c",
      directoryWalk +
        String.raw`
private = open_dir(req["directory"],True)
fcntl.flock(private, fcntl.LOCK_EX)
os.close(os.open(".reconciled",os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=private))
try: parent = open_dir(os.path.dirname(req["target"]))
except FileNotFoundError: sys.exit(0)
name = os.path.basename(req["temp"])
captured = ".recovered"
def info(fd,name):
    try: return os.stat(name,dir_fd=fd,follow_symlinks=False)
    except FileNotFoundError: return None
# If recovery itself stopped after moving the entry, inspect that same inode.
if not info(private,captured):
    try: os.rename(name,captured,src_dir_fd=parent,dst_dir_fd=private)
    except FileNotFoundError: pass
st = info(private,captured)
if st:
    owned = [info(private,k) for k in [".prepared",os.path.basename(req["target"])]]
    if not any(pin and os.path.samestat(pin,st) for pin in owned):
        conflicts = open_dir(req["conflicts"],True)
        key = name + "." + uuid.uuid4().hex + ".unowned"
        os.link(captured,key,src_dir_fd=private,dst_dir_fd=conflicts,follow_symlinks=False)
        try: os.link(captured,name,src_dir_fd=private,dst_dir_fd=parent,follow_symlinks=False)
        except FileExistsError: pass
        os.unlink(captured,dir_fd=private)
        raise RuntimeError("Concurrent publication temp preserved: " + req["temp"])
    os.unlink(captured, dir_fd=private)
try: os.unlink(".prepared",dir_fd=private)
except FileNotFoundError: pass
`,
      JSON.stringify(request),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}
export function replaceCheckedFile(
  root: string,
  targetPath: string,
  newBytes: CheckedContent,
  expectedCurrentSha256: string | undefined,
  options: {
    mode?: number;
    keepBackup?: boolean;
    record?: (record: PublicationRecord) => void;
    times?: number[];
    parents?: ReturnType<typeof publicationParents>;
  } = {},
) {
  const target = workspacePath(root, targetPath);
  const prior =
    expectedCurrentSha256 === undefined
      ? undefined
      : lstatSync(regularFile(root, target), { bigint: true });
  if (newBytes === null && !prior)
    throw Error("Removal requires a checked target");
  const source =
    newBytes && typeof newBytes === "object" && "source" in newBytes
      ? newBytes
      : undefined;
  const stream =
    newBytes && typeof newBytes === "object" && "fd" in newBytes
      ? newBytes
      : undefined;
  const token = randomUUID(),
    relative = path.relative(realpathSync(root), target);
  const record = {
    target: relative,
    tempPath: path.join(path.dirname(relative), ".release-" + token),
    token,
    parents: options.parents ?? publicationParents(root, target),
    expected: expectedCurrentSha256,
  };
  const { directory } = publicationPaths(root, record);
  options.record?.(record);
  const request = {
    target,
    token: record.token,
    private: directory,
    sibling: !!options.record,
    conflicts: workspacePath(root, "output/release-state/conflicts"),
    parents: record.parents,
    fileId: prior && [String(prior.dev), String(prior.ino)],
    mode: options.mode ?? (prior ? Number(prior.mode & 0o777n) : 0o600),
    times: options.times,
    keepBackup: options.keepBackup,
    expected: expectedCurrentSha256,
    remove: newBytes === null,
    source: source && regularFile(root, source.source),
    newHash: source?.sha256 ?? stream?.sha256,
  };
  try {
    execFileSync(
      "/usr/bin/python3",
      ["-I", "-c", publishAt, JSON.stringify(request)],
      {
        input:
          typeof newBytes === "string" || Buffer.isBuffer(newBytes)
            ? newBytes
            : undefined,
        stdio: [stream?.fd ?? "pipe", "pipe", "pipe"],
      },
    );
  } catch (err) {
    const failure = err as { stderr?: Buffer };
    throw Error(
      "Checked publication failed for " +
        target +
        ": " +
        (failure.stderr?.toString().trim().split("\n").at(-1) ?? String(err)),
      { cause: err },
    );
  }
}
export function readReleaseManifest(root: string): ReleaseManifest {
  const file = workspacePath(root, manifestPath);
  if (!lstatSync(file, { throwIfNoEntry: false })) return { schemaVersion: 1 };
  return manifestSchema.parse(
    JSON.parse(readFileSync(regularFile(root, manifestPath), "utf8")),
  );
}
export function writeReleaseManifest(
  root: string,
  manifest: ReleaseManifest,
  baseline?: { original?: string; record?: (entry: PublicationRecord) => void },
) {
  const file = workspacePath(root, manifestPath);
  const original = baseline
    ? baseline.original
    : lstatSync(file, { throwIfNoEntry: false })
      ? readFileSync(regularFile(root, file), "utf8")
      : undefined;
  replaceCheckedFile(
    root,
    file,
    JSON.stringify(manifestSchema.parse(manifest), null, 2) + "\n",
    original === undefined
      ? undefined
      : createHash("sha256").update(original).digest("hex"),
    { record: baseline?.record },
  );
}

export interface ExistingDmgArtifact {
  path: string;
  version: string;
  mtimeMs: number;
}
export interface WorkspaceDiffResult {
  source: "explicit" | "git" | "mtime" | "manifest";
  changedFiles: string[];
  baselineMs: number;
  baselineDmg?: ExistingDmgArtifact;
  recentInitiatives: {
    directory: string;
    title: string;
    status: string;
    completed: boolean;
  }[];
  unshippedCompletedInitiatives: string[];
  previouslyCompletedInitiatives: string[];
  warnings: string[];
  incompleteAssessment: boolean;
  packagePackagingChanged: boolean;
}
function attempt<T>(
  warnings: string[],
  file: string,
  fn: () => T,
): T | undefined {
  try {
    return fn();
  } catch (err) {
    if (
      !["EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes(
        (err as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw err;
    warnings.push("Unable to inspect " + file + ": " + String(err));
  }
}
function inspect(root: string, relative: string, warnings: string[]) {
  const file = path.join(root, relative);
  const st = attempt(warnings, file, () =>
    lstatSync(file, { throwIfNoEntry: false }),
  );
  if (st?.isSymbolicLink()) {
    warnings.push("Skipped symlink: " + relative);
    return;
  }
  return st;
}
function children(root: string, rel: string, warnings: string[]) {
  return attempt(warnings, rel, () => readdirSync(path.join(root, rel))) ?? [];
}
export function listReleaseDmgs(
  root: string,
  warnings: string[] = [],
): ExistingDmgArtifact[] {
  if (!inspect(root, "release", warnings)?.isDirectory()) return [];
  const artifacts: ExistingDmgArtifact[] = [];
  for (const name of children(root, "release", warnings)) {
    const st = inspect(root, path.join("release", name), warnings);
    const version = /^Forma-(.+)-arm64\.dmg$/.exec(name)?.[1];
    if (!st?.isFile() || !version) continue;
    if (
      !attempt(warnings, name, () => {
        accessSync(path.join(root, "release", name), constants.R_OK);
        return true;
      })
    )
      continue;
    try {
      parseSemVer(version);
    } catch {
      continue;
    }
    artifacts.push({
      path: path.resolve(root, "release", name),
      version,
      mtimeMs: st.mtimeMs,
    });
  }
  return artifacts.sort(
    (a, b) => compareSemVer(b.version, a.version) || b.mtimeMs - a.mtimeMs,
  );
}
export function findBaselineDmg(root: string, version: string) {
  parseSemVer(version);
  return listReleaseDmgs(root).find(
    (d) => compareSemVer(d.version, version) <= 0,
  );
}
const roots = [
  "src",
  "server",
  "electron",
  "build",
  "public",
  "tests",
  "examples",
  ".gitignore",
  ".prettierignore",
  ".prettierrc",
  "scripts",
  "docs",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "index.html",
  "AGENTS.md",
  "README.md",
];
const excludedNames = new Set(["node_modules", ".git", ".DS_Store"]);
const generatedRoots = new Set(["dist", "out-electron", "release", "output"]);
function excluded(file: string) {
  const parts = file.split("/");
  return (
    generatedRoots.has(parts[0]) ||
    parts.some((p) => excludedNames.has(p)) ||
    file === manifestPath
  );
}
function isInventoriedPath(file: string) {
  const top = file.split("/")[0];
  return (
    roots.includes(top) ||
    (!file.includes("/") &&
      (/\.(?:[cm]?[jt]s|html)$/.test(file) || file.startsWith(".prettierrc.")))
  );
}
export const isPackagingManifest = (file: string) =>
  file === "package.json" || file === "package-lock.json";
function hashPackagingInputs(inputs: unknown[]) {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, value]) => [k, sort(value)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(sort(inputs)))
    .digest("hex");
}
function packagingInputs(pkgRaw: string, lockRaw?: string) {
  const pkg = JSON.parse(pkgRaw);
  const packages = lockRaw ? JSON.parse(lockRaw).packages : undefined;
  const fields = ["build", "main", "dependencies", "type", "exports", "bin"];
  const inputs = [
    ...fields.map((k) => pkg[k]),
    pkg.devDependencies?.electron,
    ...[
      "build",
      "desktop:service",
      "desktop:agent",
      "desktop:build",
      "desktop:pack",
    ].map((k) => pkg.scripts?.[k]),
  ];
  return { pkg, packages, inputs };
}
function legacyPackagingFingerprintV1(pkgRaw: string, lockRaw?: string) {
  const { pkg, packages, inputs } = packagingInputs(pkgRaw, lockRaw);
  return hashPackagingInputs([
    ...inputs,
    ...["electron", ...Object.keys(pkg.dependencies ?? {}).sort()].map(
      (name) => {
        const resolved = packages?.["node_modules/" + name];
        return (
          resolved && [resolved.version, resolved.resolved, resolved.integrity]
        );
      },
    ),
  ]);
}
export function packagingFingerprint(pkgRaw: string, lockRaw?: string) {
  const { packages, inputs } = packagingInputs(pkgRaw, lockRaw);
  return (
    "v2:" +
    hashPackagingInputs([
      ...inputs,
      Object.fromEntries(
        Object.entries(packages ?? {}).flatMap(([key, value]) => {
          const entry = value as Record<string, unknown>;
          const electron =
            /(?:^|\/)node_modules\/(?:electron(?:\/|$)|@electron(?:-internal)?\/)/.test(
              key,
            );
          if (!key || (entry.dev === true && !electron)) return [];
          const { version, resolved, integrity, optional, os, cpu } = entry;
          return [[key, { version, resolved, integrity, optional, os, cpu }]];
        }),
      ),
    ])
  );
}
export { packagingFingerprint as packagePackagingHash };
export function packagingFingerprintMatches(
  stored: string | undefined,
  pkgRaw: string,
  lockRaw?: string,
) {
  if (!stored) return false;
  return (
    stored ===
    (stored.startsWith("v2:")
      ? packagingFingerprint(pkgRaw, lockRaw)
      : legacyPackagingFingerprintV1(pkgRaw, lockRaw))
  );
}
function scan(root: string, warnings: string[]) {
  const files = new Map<string, Stats>();
  function visit(relative: string) {
    const st = inspect(root, relative, warnings);
    if (st?.isFile()) {
      if (
        attempt(warnings, relative, () => {
          accessSync(path.join(root, relative), constants.R_OK);
          return true;
        })
      )
        files.set(relative, st);
    } else if (st?.isDirectory())
      for (const name of children(root, relative, warnings)) {
        const child = path.posix.join(relative, name);
        if (!excluded(child)) visit(child);
      }
  }
  const inputs = new Set(roots);
  for (const name of children(root, "", warnings)) {
    if (/\.(?:[cm]?[jt]s|html)$/.test(name) || name.startsWith(".prettierrc."))
      inputs.add(name);
  }
  inputs.forEach(visit);
  return files;
}
function newer(files: Map<string, Stats>, time: number) {
  return [...files.keys()].filter((f) => files.get(f)!.mtimeMs > time).sort();
}
export function listFilesNewerThan(
  root: string,
  time: number,
  warnings: string[] = [],
) {
  return newer(scan(root, warnings), time);
}
function hashFiles(
  root: string,
  files: Map<string, Stats>,
  warnings: string[],
) {
  const result: Record<string, string> = Object.create(null);
  for (const name of files.keys()) {
    // Generated receipts must not change their own release baseline.
    if (/^docs\/evidence\/[^/]+\/desktop-[^/]+\.json$/.test(name)) continue;
    const digest = attempt(warnings, name, () =>
      createHash("sha256")
        .update(readFileSync(regularFile(root, name)))
        .digest("hex"),
    );
    if (digest) result[name] = digest;
  }
  return result;
}
export function sourceHashes(root: string) {
  const warnings: string[] = [];
  const result = hashFiles(root, scan(root, warnings), warnings);
  if (warnings.length)
    throw Error("Incomplete source snapshot: " + warnings.join(", "));
  return result;
}
export function diffHashes(
  before: Record<string, string>,
  after: Record<string, string>,
) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => before[k] !== after[k])
    .sort();
}
function git(root: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
}
export function gitHead(root: string) {
  return lstatSync(path.join(root, ".git"), { throwIfNoEntry: false })
    ? git(root, "rev-parse", "HEAD").trim()
    : undefined;
}
function gitChanges(
  root: string,
  head: string | undefined,
  since: string | undefined,
  warnings: string[],
) {
  const files: string[] = [];
  if (since)
    files.push(
      ...git(
        root,
        "log",
        "--since=" + since,
        "--no-renames",
        "--name-only",
        "--pretty=format:",
        "-z",
      ).split("\0"),
    );
  if (head) {
    try {
      git(root, "cat-file", "-e", head + "^{commit}");
      files.push(
        ...git(
          root,
          "diff",
          "--no-renames",
          "--name-only",
          "-z",
          head + "..HEAD",
        ).split("\0"),
      );
    } catch {
      warnings.push("Unavailable release Git baseline: " + head);
    }
  }
  const records = git(
    root,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  )
    .split("\0")
    .filter(Boolean);
  for (let i = 0; i < records.length; i++) {
    const status = records[i].slice(0, 2);
    files.push(records[i].slice(3));
    if (/[RC]/.test(status)) {
      const original = records[++i];
      if (status.includes("R")) files.push(original);
    }
  }
  return normalizeChangedFiles(files);
}
function sinceMs(s: string) {
  const valid =
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      s,
    );
  const day = s.slice(0, 10),
    utc = Date.parse(day + "T00:00:00Z");
  const time = Date.parse(s.length === 10 ? s + "T00:00:00+08:00" : s);
  if (
    !valid ||
    !Number.isFinite(time) ||
    !Number.isFinite(utc) ||
    new Date(utc).toISOString().slice(0, 10) !== day ||
    (s.length > 10 && Number(s.slice(11, 13)) > 23)
  )
    throw Error("--since 日期无效：" + s);
  return time;
}
function explicitPaths(paths: string[]) {
  for (const p of paths) {
    const norm = path.posix.normalize(p.replaceAll("\\", "/"));
    if (
      !p ||
      p.includes("\0") ||
      path.win32.isAbsolute(p) ||
      /^[A-Za-z]:/.test(p) ||
      norm === ".." ||
      norm === "." ||
      norm.startsWith("../")
    )
      throw Error("Invalid relative workspace path: " + JSON.stringify(p));
  }
  return normalizeChangedFiles(paths);
}
export function detectWorkspaceChanges(
  root: string,
  options: {
    sinceIso?: string;
    currentVersion?: string;
    explicitFiles?: string[];
    frozenHashes?: Record<string, string>;
  } = {},
): WorkspaceDiffResult {
  const warnings: string[] = [];
  const files = scan(root, warnings);
  let manifest: ReleaseManifest = { schemaVersion: 1 };
  if (
    inspect(root, "docs", warnings)?.isDirectory() &&
    inspect(root, "docs/evidence", warnings)?.isDirectory() &&
    inspect(root, manifestPath, warnings)?.isFile()
  )
    manifest =
      attempt(warnings, manifestPath, () => readReleaseManifest(root)) ??
      manifest;
  const version =
    options.currentVersion ??
    (files.has("package.json")
      ? JSON.parse(
          attempt(warnings, "package.json", () =>
            readFileSync(path.join(root, "package.json"), "utf8"),
          ) ?? "{}",
        ).version
      : undefined);
  const baselineDmg = listReleaseDmgs(root, warnings).find(
    (d) => !version || compareSemVer(d.version, version) <= 0,
  );
  const evidenceTimes = [...files]
    .filter(([f]) => {
      const v = /^docs\/evidence\/[^/]+\/desktop-(.+)\.json$/.exec(f)?.[1];
      if (!v) return false;
      try {
        return !version || compareSemVer(v, version) <= 0;
      } catch {
        return false;
      }
    })
    .map(([, st]) => st.mtimeMs);
  const baselineMs =
    options.sinceIso !== undefined
      ? sinceMs(options.sinceIso)
      : (baselineDmg?.mtimeMs ?? Math.max(0, ...evidenceTimes));
  const hasGit = !!inspect(root, ".git", warnings);
  const recentInitiatives: WorkspaceDiffResult["recentInitiatives"] = [];
  const previouslyCompletedInitiatives: string[] = [];
  for (const [file, st] of files) {
    if (!/^docs\/initiatives\/[^/]+\/PRD\.md$/.test(file)) continue;
    const md = attempt(warnings, file, () =>
      readFileSync(path.join(root, file), "utf8"),
    );
    if (md === undefined) continue;
    const directory = path.posix.dirname(file);
    const status =
      /^-[ \t]+\*\*状态\*\*[ \t]*[：:][ \t]*(.*)$/m.exec(md)?.[1].trim() ?? "";
    if (!manifest.lastRelease && !hasGit && st.mtimeMs <= baselineMs) {
      if (status.startsWith("已实施并验收"))
        previouslyCompletedInitiatives.push(directory);
      continue;
    }
    recentInitiatives.push({
      directory,
      title: /^# (.+)$/m.exec(md)?.[1].trim() ?? path.basename(directory),
      status,
      completed: status.startsWith("已实施并验收"),
    });
  }
  recentInitiatives.sort((a, b) => a.directory.localeCompare(b.directory));
  const unshippedCompletedInitiatives = recentInitiatives
    .filter(
      (i) =>
        i.completed &&
        !manifest.lastRelease?.shippedInitiatives.includes(i.directory) &&
        !manifest.lastRelease?.priorShippedInitiatives?.includes(i.directory),
    )
    .map((i) => i.directory);
  let source: WorkspaceDiffResult["source"] = "mtime";
  let changedFiles: string[] | undefined;
  if (options.explicitFiles !== undefined) {
    source = "explicit";
    changedFiles = explicitPaths(options.explicitFiles);
  } else if (hasGit)
    try {
      changedFiles = gitChanges(
        root,
        manifest.lastRelease?.gitHead,
        options.sinceIso === undefined
          ? undefined
          : new Date(baselineMs).toISOString(),
        warnings,
      );
      changedFiles = changedFiles.filter((f) => !excluded(f));
      if (manifest.lastRelease) {
        const shipped = manifest.lastRelease.sourceHashes;
        const current =
          options.frozenHashes ?? hashFiles(root, files, warnings);
        changedFiles = normalizeChangedFiles([
          ...changedFiles.filter((f) => {
            if (Object.hasOwn(shipped, f) || Object.hasOwn(current, f))
              return (shipped[f] ?? null) !== (current[f] ?? null);
            if (!isInventoriedPath(f)) return true;
            return !!lstatSync(path.join(root, f), { throwIfNoEntry: false });
          }),
          ...diffHashes(shipped, current),
        ]);
      }
      source = "git";
    } catch {
      warnings.push("Git 状态读取失败，改用文件基线。");
    }
  if (!changedFiles && manifest.lastRelease && options.sinceIso === undefined) {
    source = "manifest";
    changedFiles = diffHashes(
      manifest.lastRelease.sourceHashes,
      options.frozenHashes ?? hashFiles(root, files, warnings),
    );
  }
  if (hasGit && !manifest.lastRelease?.gitHead && !options.sinceIso)
    warnings.push("Unknown Git release baseline; specify --since.");
  const incompleteAssessment = warnings.length > 0;
  if (!changedFiles && !baselineMs)
    warnings.push("未找到基线 DMG 或桌面证据，可用 --since 指定起点。");
  changedFiles ??= newer(files, baselineMs);
  let packagePackagingChanged = false;
  if (changedFiles.some(isPackagingManifest)) {
    const pkg = files.has("package.json")
      ? readFileSync(regularFile(root, "package.json"), "utf8")
      : "{}";
    const lock = files.has("package-lock.json")
      ? readFileSync(regularFile(root, "package-lock.json"), "utf8")
      : undefined;
    let previous = manifest.lastRelease?.packagePackagingSha256;
    if (!previous && hasGit) {
      try {
        const rev =
          manifest.lastRelease?.gitHead ??
          (options.sinceIso
            ? git(
                root,
                "rev-list",
                "-1",
                "--before=" + new Date(baselineMs).toISOString(),
                "HEAD",
              ).trim()
            : "HEAD");
        if (rev) {
          let priorLock: string | undefined;
          if (
            git(
              root,
              "ls-tree",
              "--name-only",
              rev,
              "--",
              "package-lock.json",
            ).trim()
          )
            priorLock = git(root, "show", rev + ":package-lock.json");
          previous = packagingFingerprint(
            git(root, "show", rev + ":package.json"),
            priorLock,
          );
        }
      } catch {
        /* Without a comparable baseline, include all packaging inputs. */
      }
    }
    if (previous && !previous.startsWith("v2:"))
      warnings.push(
        "检测到旧版未标记格式的桌面依赖指纹，无法校验传递依赖差异；完成下一次发版后将自动升级至 v2 指纹。",
      );
    packagePackagingChanged = !packagingFingerprintMatches(
      previous ?? packagingFingerprint("{}"),
      pkg,
      lock,
    );
  }
  return {
    source,
    changedFiles,
    packagePackagingChanged,
    baselineDmg,
    baselineMs,
    recentInitiatives,
    unshippedCompletedInitiatives,
    previouslyCompletedInitiatives,
    warnings,
    incompleteAssessment,
  };
}
